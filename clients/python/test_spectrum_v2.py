"""
Tests for the version 2 spectrum decoder in spectrum_display.py.

Run with:  python3 -m unittest test_spectrum_v2 -v
"""

import struct
import unittest

import numpy as np

from spectrum_display import (
    SpectrumDisplay, SPECTRUM_HEADER_SIZE, SPECTRUM_PROTOCOL_VERSION,
    SPECTRUM_FLAG_FULL, SPECTRUM_FLAG_DELTA,
)


def frame(flags, body, seq=0, ts=1234, freq=7_100_000, version=SPECTRUM_PROTOCOL_VERSION):
    head = bytearray(b'SPEC')
    head.append(version)
    head.append(flags)
    head += struct.pack('<H', seq)
    head += struct.pack('<Q', ts)
    head += struct.pack('<Q', freq)
    assert len(head) == SPECTRUM_HEADER_SIZE, len(head)
    return bytes(head) + bytes(body)


def full_body(ref_centi_db, step_centi_db, codes):
    return struct.pack('<hB', ref_centi_db, step_centi_db) + bytes(codes)


def delta_body(n, changes):
    """Mask-and-values body, LSB-first per byte exactly as the server writes it."""
    mask_len = (n + 7) // 8
    mask = bytearray(mask_len)
    for i in changes:
        mask[i >> 3] |= 1 << (i & 7)
    values = bytes(changes[i] for i in sorted(changes))
    return bytes(mask) + values


class _Decoder(SpectrumDisplay):
    """SpectrumDisplay does GUI work in __init__; the parser needs only state."""

    def __init__(self):
        self.binary_spectrum_codes = None
        self.spectrum_scale = None
        self.spectrum_last_sequence = None
        self.spectrum_sequence_gaps = 0
        self.binary8_logged = True   # keep the banner out of test output


class TestSpectrumV2(unittest.TestCase):
    def test_full_frame_applies_the_carried_scale(self):
        """dB = ref/100 + code * step/100.

        Version 1 hardcoded value-256; carrying the scale is what stops it
        clipping on a receiver whose gain puts the bins elsewhere.
        """
        d = _Decoder()
        # -120 dB reference, 0.5 dB steps
        out = d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, full_body(-12000, 50, [0, 2, 200])))
        self.assertIsNotNone(out)
        self.assertEqual(out['frequency'], 7_100_000)
        np.testing.assert_allclose(out['data'], [-120.0, -119.0, -20.0], atol=1e-4)

    def test_delta_patches_only_the_masked_bins(self):
        d = _Decoder()
        d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, full_body(0, 100, [10] * 20)))
        changes = {0: 1, 7: 2, 8: 3, 19: 4}
        out = d._parse_binary_spectrum(frame(SPECTRUM_FLAG_DELTA, delta_body(20, changes), seq=1))
        self.assertIsNotNone(out)
        for i in range(20):
            want = changes.get(i, 10)
            self.assertEqual(d.binary_spectrum_codes[i], want, f"bin {i}")

    def test_mask_is_lsb_first(self):
        """The bit order is the part most easily got wrong: numpy's default
        unpackbits walks MSB-first, which would scatter values across the wrong
        bins while still producing a plausible-looking frame."""
        d = _Decoder()
        d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, full_body(0, 100, [0] * 8)))
        # Bit 0 set only -> bin 0 changes, nothing else.
        out = d._parse_binary_spectrum(frame(SPECTRUM_FLAG_DELTA, bytes([0x01]) + bytes([9]), seq=1))
        self.assertIsNotNone(out)
        self.assertEqual(d.binary_spectrum_codes[0], 9)
        self.assertTrue(all(v == 0 for v in d.binary_spectrum_codes[1:]))

    def test_delta_keeps_the_scale(self):
        d = _Decoder()
        d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, full_body(-9000, 25, [4, 4])))
        before = d.spectrum_scale
        d._parse_binary_spectrum(frame(SPECTRUM_FLAG_DELTA, delta_body(2, {1: 8}), seq=1))
        self.assertEqual(d.spectrum_scale, before)

    def test_delta_before_full_is_ignored(self):
        """Normal for a client joining mid-stream; the keyframe is at most five
        seconds away."""
        d = _Decoder()
        self.assertIsNone(d._parse_binary_spectrum(frame(SPECTRUM_FLAG_DELTA, delta_body(8, {0: 9}))))

    def test_malformed_delta_is_refused_whole(self):
        d = _Decoder()
        d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, full_body(0, 50, [1, 2, 3, 4])))
        codes_before = d.binary_spectrum_codes.copy()
        # Mask claims two changes, body carries one value.
        bad = delta_body(4, {0: 7, 1: 8})[:1] + bytes([7])
        self.assertIsNone(d._parse_binary_spectrum(frame(SPECTRUM_FLAG_DELTA, bad, seq=1)))
        np.testing.assert_array_equal(d.binary_spectrum_codes, codes_before)
        # And a body with no mask at all.
        self.assertIsNone(d._parse_binary_spectrum(frame(SPECTRUM_FLAG_DELTA, b'', seq=2)))

    def test_sequence_gap_is_counted(self):
        d = _Decoder()
        body = full_body(0, 50, [1, 2])
        for seq in (1, 2, 5):
            d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, body, seq=seq))
        self.assertEqual(d.spectrum_sequence_gaps, 1)

    def test_version_one_is_refused(self):
        """This client asks for 2 explicitly, so a version 1 frame means the
        stream is not what it claims to be."""
        d = _Decoder()
        self.assertIsNone(d._parse_binary_spectrum(
            frame(SPECTRUM_FLAG_FULL, full_body(0, 50, [1, 2]), version=1)))

    def test_bad_header_is_refused(self):
        d = _Decoder()
        self.assertIsNone(d._parse_binary_spectrum(b'SPEC'))
        self.assertIsNone(d._parse_binary_spectrum(frame(0x09, b'\x01\x02')))
        # A zero step would make every bin read as the reference.
        self.assertIsNone(d._parse_binary_spectrum(frame(SPECTRUM_FLAG_FULL, full_body(0, 0, [1, 2]))))
        bad_magic = bytearray(frame(SPECTRUM_FLAG_FULL, full_body(0, 50, [1])))
        bad_magic[0:4] = b'XXXX'
        self.assertIsNone(d._parse_binary_spectrum(bytes(bad_magic)))


if __name__ == '__main__':
    unittest.main()
