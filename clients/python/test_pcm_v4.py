"""
Conformance tests for the protocol version 4 decoder.

Run with:  python3 -m unittest test_pcm_v4 -v
"""

import struct
import hashlib
import unittest

import pcm_v4
from pcm_v4 import (
    PCMv4Decoder, PCMv4Error, PredictiveCodec,
    is_v4_packet, is_zstd_frame, quality_to_float,
    QUALITY_NO_READING, PCM_PROTOCOL_VERSION,
)

# testdata/pcmv4_stream.bin is a packet stream the SERVER's encoder produced,
# and this is the SHA-256 of the samples that went into it, little endian.
#
# It earns its 90 kB. The version 4 predictor is backward adaptive: the two ends
# derive their filter taps independently from the samples already coded and
# never exchange a coefficient, so any arithmetic difference between this
# decoder and the Go one on the server produces plausible noise rather than an
# error. Nothing short of comparing the samples would catch it.
#
# The same constant appears in the Go and C++ ports of this decoder, which is
# what makes it a conformance test rather than a regression test: all four
# implementations are checked against one stream the server actually emitted.
EXPECTED_SHA = "4875d2185f1ff5a2031386c569cac0c2259e6a827b9e61f813399a19c3b9c903"

FIXTURE = "testdata/pcmv4_stream.bin"


def read_fixture():
    """Packets from the fixture.

    Layout: "UV4F", a format byte, a uint32 packet count, then each packet as a
    uint32 length and that many bytes.
    """
    with open(FIXTURE, 'rb') as fh:
        raw = fh.read()
    if len(raw) < 9 or raw[:4] != b'UV4F':
        raise AssertionError('fixture: bad header')
    count = struct.unpack_from('<I', raw, 5)[0]
    packets = []
    off = 9
    for i in range(count):
        n = struct.unpack_from('<I', raw, off)[0]
        off += 4
        packets.append(raw[off:off + n])
        off += n
    if off != len(raw):
        raise AssertionError('fixture: %d trailing bytes' % (len(raw) - off))
    return packets


class TestServerStream(unittest.TestCase):
    def test_decodes_server_stream_bit_exactly(self):
        """The samples must match what the server encoded, byte for byte.

        The stream covers what the format can do: ordinary mono audio, silent
        packets carrying no body, an escape to verbatim samples on
        incompressible noise, a sample-rate change, and interleaved I/Q --
        including the varying packet length that makes the header's sample count
        necessary, across the five-second periodic resynchronisation.
        """
        packets = read_fixture()
        dec = PCMv4Decoder()
        digest = hashlib.sha256()

        # Every distinct (rate, channels) the fixture passes through, in order.
        # A decoder that lost the carried-forward metadata could still hash
        # correctly while mislabelling the stream.
        want_params = [(12000, 1), (24000, 1), (384000, 2)]
        got_params = []

        for i, pkt in enumerate(packets):
            self.assertTrue(is_v4_packet(pkt), 'packet %d not recognised as version 4' % i)
            pcm_le, header = dec.decode_packet_le(pkt)
            self.assertEqual(len(pcm_le) % (2 * header.channels), 0,
                             'packet %d is not whole frames' % i)
            param = (header.sample_rate, header.channels)
            if not got_params or got_params[-1] != param:
                got_params.append(param)
            digest.update(pcm_le)

        self.assertEqual(digest.hexdigest(), EXPECTED_SHA,
                         'decoded samples differ from what the server encoded')
        self.assertEqual(got_params, want_params)

    def test_timestamps_advance_monotonically(self):
        """Version 4 sends an absolute timestamp at each resynchronisation point
        and a signed varint delta in between. A decoder that dropped the
        carry-forward would still return samples, and a recorder aligning
        several receivers on those timestamps would silently trim the wrong
        number of samples off the front of every file.
        """
        dec = PCMv4Decoder()
        last = 0
        seen = 0
        for i, pkt in enumerate(read_fixture()):
            header, _ = dec.decode_packet(pkt)
            self.assertGreater(header.timestamp_nanos, 0, 'packet %d carried no timestamp' % i)
            if last:
                self.assertGreaterEqual(header.timestamp_nanos, last,
                                        'packet %d went backwards in time' % i)
            last = header.timestamp_nanos
            seen += 1
        self.assertGreater(seen, 0)

    def test_both_profiles_are_exercised(self):
        """The fixture must cover the complex IQ predictor and the real audio
        cascade; a pass that only ever ran one of them proves half the codec.
        """
        dec = PCMv4Decoder()
        profiles = set()
        for pkt in read_fixture():
            header, _ = dec.decode_packet(pkt)
            profiles.add(header.profile)
        self.assertEqual(profiles, {pcm_v4.PROFILE_IQ, pcm_v4.PROFILE_AUDIO})

    def test_silent_and_escape_packets_are_present(self):
        """Both special bodies have to be in the stream for the run above to
        mean anything: a silent packet carries no body at all, and an escape
        carries verbatim samples. Each still advances the predictor.
        """
        dec = PCMv4Decoder()
        silent = escape = 0
        for pkt in read_fixture():
            header, samples = dec.decode_packet(pkt)
            if header.silent:
                silent += 1
                self.assertEqual(set(samples), {0})
            if header.escape:
                escape += 1
        self.assertGreater(silent, 0, 'the fixture carried no silent packets')
        self.assertGreater(escape, 0, 'the fixture carried no escape packets')


class TestFrameClassification(unittest.TestCase):
    def test_legacy_server_frames_are_recognised(self):
        """A server too old for version 4 answers with the zstd-wrapped version
        1 shape. Recognising it is what lets the client say why.
        """
        zstd = b'\x28\xB5\x2F\xFD\x00'
        self.assertTrue(is_zstd_frame(zstd))
        self.assertFalse(is_v4_packet(zstd))
        for pkt in read_fixture():
            self.assertFalse(is_zstd_frame(pkt), 'a version 4 packet read as zstd')
        for short in (b'', b'\x50', b'\x50\x43\x4D'):
            self.assertFalse(is_v4_packet(short))
            self.assertFalse(is_zstd_frame(short))


class TestHeaderErrors(unittest.TestCase):
    def test_rejects_bad_magic_and_short_packets(self):
        dec = PCMv4Decoder()
        for bad in (b'', b'\x00' * 4, b'\x01\x02\x03\x04\x05'):
            with self.assertRaises(PCMv4Error):
                dec.decode_packet(bad)

    def test_rejects_delta_packet_before_resynchronisation(self):
        """A packet arriving before any metadata is rejected rather than guessed
        at; the server's five-second resynchronisation ends that state anyway.
        """
        packets = read_fixture()
        dec = PCMv4Decoder()
        # Find a packet without the metadata bit — a delta packet.
        delta = next(p for p in packets if not (p[4] & (1 << 5)))
        with self.assertRaises(PCMv4Error):
            dec.decode_packet(delta)

    def test_unknown_profile_is_an_error_not_a_fallback(self):
        """Falling back to a default profile would decode with the wrong
        predictor and return plausible-looking noise rather than failing.
        """
        with self.assertRaises(PCMv4Error):
            PredictiveCodec(6)


class TestQuality(unittest.TestCase):
    def test_no_reading_sentinel(self):
        self.assertEqual(quality_to_float(QUALITY_NO_READING), -999.0)
        self.assertAlmostEqual(quality_to_float(-1234), -12.34)
        self.assertAlmostEqual(quality_to_float(0), 0.0)


class TestProtocolVersion(unittest.TestCase):
    def test_client_speaks_version_four_only(self):
        """There is no negotiation left: 4 is the only version implemented."""
        self.assertEqual(PCM_PROTOCOL_VERSION, 4)
        for gone in ('choose_protocol_version', 'DEFAULT_PROTOCOL_VERSION',
                     'FALLBACK_PROTOCOL_VERSION', 'v4_budget_warning'):
            self.assertFalse(hasattr(pcm_v4, gone),
                             f"{gone} survived the removal of versions 1-3")


class TestOpusHeader(unittest.TestCase):
    """The version 4 Opus header, which carries no magic and no sample count."""

    @staticmethod
    def _resync(ts=1_700_000_000_000_000_000, rate=12000, ch=1, power=-1234, noise=-5678):
        import struct as _s
        # flags: metadata | quality
        body = bytes([0b11]) + _s.pack('<Q', ts)
        # sample rate as a uvarint
        r, out = rate, bytearray()
        while r >= 0x80:
            out.append((r & 0x7F) | 0x80); r >>= 7
        out.append(r)
        return body + bytes(out) + bytes([ch]) + _s.pack('<hh', power, noise)

    def test_resync_frame_carries_metadata_and_quality(self):
        dec = PCMv4Decoder()
        pkt = self._resync() + b'OPUSBODY'
        h, off = dec.decode_opus_header(pkt)
        self.assertEqual(h.sample_rate, 12000)
        self.assertEqual(h.channels, 1)
        self.assertAlmostEqual(h.baseband_power, -12.34)
        self.assertAlmostEqual(h.noise, -56.78)
        self.assertEqual(pkt[off:], b'OPUSBODY')
        # An Opus body's length is implicit, so no count is transmitted.
        self.assertEqual(h.sample_count, 0)

    def test_delta_frame_carries_time_forward(self):
        dec = PCMv4Decoder()
        base = 1_700_000_000_000_000_000
        dec.decode_opus_header(self._resync(ts=base) + b'X')
        # flags 0: no metadata, no quality -- just a signed varint delta.
        # zigzag(+20000000) = 40000000
        u, out = 40_000_000, bytearray()
        while u >= 0x80:
            out.append((u & 0x7F) | 0x80); u >>= 7
        out.append(u)
        h, off = dec.decode_opus_header(bytes([0]) + bytes(out) + b'BODY')
        self.assertEqual(h.timestamp_nanos, base + 20_000_000)
        self.assertEqual(h.sample_rate, 12000)   # carried forward
        self.assertEqual(h.channels, 1)

    def test_delta_before_resync_is_refused(self):
        dec = PCMv4Decoder()
        with self.assertRaises(PCMv4Error):
            dec.decode_opus_header(bytes([0]) + b'\x02BODY')

    def test_unknown_flag_bits_are_refused(self):
        dec = PCMv4Decoder()
        with self.assertRaises(PCMv4Error):
            dec.decode_opus_header(bytes([0x80]) + b'\x00' * 12)

    def test_opus_and_pcm_headers_do_not_share_state(self):
        """The server keeps one header encoder per format; so must the client."""
        dec = PCMv4Decoder()
        dec.decode_opus_header(self._resync(rate=24000, ch=2) + b'X')
        # The PCM side has still seen nothing and must refuse a delta packet.
        with self.assertRaises(PCMv4Error):
            dec.decode_packet(struct.pack('<I', pcm_v4.PCMV4_MAGIC) + bytes([0x00, 0x02]))


if __name__ == '__main__':
    unittest.main()
