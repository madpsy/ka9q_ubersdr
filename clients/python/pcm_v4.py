"""
pcm_v4.py - audio protocol version 4: packet header and predictive codec.

The decoding half of the server's pcm_v4_header.go and pcm_predictive.go, and a
port of the same decoder in clients/rtl_sdr (Go), clients/soapy_driver (C++) and
static/v2/src/radio/pcm-v4.js.

Versions 1-3 wrapped every lossless packet in zstd behind a fixed 29- or 37-byte
header. zstd made this data LARGER -- it is an LZ77 matcher over bytes, and a
band-limited RF signal has no repeated byte strings, only sample-to-sample
correlation a predictor extracts and a byte matcher cannot. Version 4 replaces
it with an adaptive predictor plus Rice coding, and sends a header carrying only
what changed.

BIT-EXACTNESS
-------------
The predictor is BACKWARD adaptive: its taps are derived from samples already
decoded, so nothing is transmitted about them and both ends must recompute them
identically. Every arithmetic detail below therefore has to match the server
EXACTLY -- the rounding of the prediction sum, the sign convention, the tap
clamp, the order in which stages are inverted, and the point at which the fast
path skips the clamp. A difference in any of them does not fail loudly; it
returns plausible-sounding noise.

The server's values are int64 with wraparound. Python integers do not wrap, but
none of these ever reach the point where that would differ: taps are clamped to
+/-2**24, and the prediction sum of at most 16 taps against 16-bit samples stays
far below 2**63. The one place a value is deliberately narrowed is the final
sample, which the server writes as int16 -- done explicitly by _to_int16 rather
than left to Python's unbounded int.

STREAM LIFETIME
---------------
A PCMv4Decoder IS the stream. Its taps carry the adaptation of every sample
decoded so far and its header state carries whatever the encoder chose not to
repeat, so create one per connection and drop it when the socket closes. A
packet that never reaches the decoder desynchronises it from the server, which
is why every frame must be decoded even when the result is then discarded.
"""

from __future__ import annotations

import struct
from typing import List, NamedTuple, Optional, Tuple

# --------------------------------------------------------------------------
# Protocol constants
# --------------------------------------------------------------------------

#: The audio protocol this module implements, sent as ``?version=`` at connect.
PCM_PROTOCOL_VERSION = 4

#: Identifies a version 4 header. Little-endian on the wire it reads "PCM4".
PCMV4_MAGIC = 0x344D4350

#: The zstd frame magic, 0xFD2FB528 little-endian on the wire. A server older
#: than 0.1.63 clamps a version it cannot serve to 1-3 and answers with version
#: 1 rather than refusing, so its frames arrive as zstd. Recognising that is
#: what turns it into a message rather than a stream of bad-magic warnings.
ZSTD_MAGIC = 0xFD2FB528

# Flag bits in the header's flags byte.
_FLAG_ESCAPE = 1 << 7
_FLAG_QUALITY = 1 << 6
_FLAG_METADATA = 1 << 5
_FLAG_SILENT = 1 << 4
_FLAG_COUNT = 1 << 3

# Three bits in the header, so eight payload codec profiles.
_HDR_PROFILE_MASK = 0x07

# Flag bits in an Opus header's flags byte. Only two, and deliberately low: an
# Opus header carries no magic, and the receiver tells frames apart by
# elimination -- a version 4 PCM magic, else Opus. That is safe rather than
# lucky, because PCMv4Magic's first byte is 0x50 (bit 4 set) while these use only
# bits 0 and 1 and so never exceed 0x03. The two cannot collide at all.
_OPUS_FLAG_QUALITY = 1 << 0
_OPUS_FLAG_METADATA = 1 << 1

#: The codepoint for "radiod reported nothing". It stands in for the -999
#: sentinel, which cannot be represented in centidecibels: -99900 overflows an
#: int16.
QUALITY_NO_READING = -32768


class PCMv4Error(Exception):
    """A packet could not be decoded."""


def is_v4_packet(pkt: bytes) -> bool:
    """True when pkt carries a version 4 header."""
    return len(pkt) >= 4 and struct.unpack_from('<I', pkt, 0)[0] == PCMV4_MAGIC


def is_zstd_frame(pkt: bytes) -> bool:
    """True when pkt came from a pre-version-4 server."""
    return len(pkt) >= 4 and struct.unpack_from('<I', pkt, 0)[0] == ZSTD_MAGIC


def quality_to_float(q: int) -> float:
    """Signed centidecibels back to dB, or the -999 sentinel."""
    if q == QUALITY_NO_READING:
        return -999.0
    return q / 100.0


# --------------------------------------------------------------------------
# Header
# --------------------------------------------------------------------------

class PCMv4Header(NamedTuple):
    """One packet's metadata, in the terms callers use.

    Which fields were actually transmitted is the decoder's business; every
    field here is filled in on every packet, carried forward from the last
    resynchronisation point when the packet did not repeat it.
    """

    #: GPS-synchronised time of the first sample, nanoseconds since the epoch.
    timestamp_nanos: int
    sample_rate: int
    #: 1 for demodulated audio, 2 for IQ.
    channels: int
    #: int16 samples in the body, counting both channels of an interleaved IQ
    #: frame. A coded body cannot be measured, so this is what tells the codec
    #: when to stop.
    sample_count: int
    #: dBFS, or -999 when radiod reported nothing.
    baseband_power: float
    noise: float
    profile: int
    #: The body holds verbatim samples.
    escape: bool
    #: Every sample is zero and no body was transmitted. Mutually exclusive
    #: with escape.
    silent: bool


def _read_uvarint(buf: bytes, off: int) -> Tuple[int, int]:
    """Protobuf-style unsigned varint, as Go's binary.Uvarint reads it."""
    result = 0
    shift = 0
    while True:
        if off >= len(buf):
            raise PCMv4Error('pcm v4 header: truncated varint')
        b = buf[off]
        off += 1
        if b < 0x80:
            if shift >= 64 or (shift == 63 and b > 1):
                raise PCMv4Error('pcm v4 header: varint overflows 64 bits')
            return result | (b << shift), off
        result |= (b & 0x7F) << shift
        shift += 7
        if shift >= 64:
            raise PCMv4Error('pcm v4 header: varint overflows 64 bits')


def _read_varint(buf: bytes, off: int) -> Tuple[int, int]:
    """Zigzag-decoded signed varint, as Go's binary.Varint reads it."""
    u, off = _read_uvarint(buf, off)
    return (u >> 1) ^ -(u & 1), off


class _HeaderDecoder:
    """Reads headers for one stream, carrying forward what is not repeated.

    Stateful and per connection. The lossless and Opus paths need SEPARATE
    instances, because the server tracks them separately -- it holds one header
    encoder for each -- and a shared decoder would apply one stream's deltas to
    the other's baseline.
    """

    __slots__ = ('_have_metadata', '_last_ts', '_rate', '_channels',
                 '_count', '_power', '_noise')

    def __init__(self) -> None:
        self._have_metadata = False
        self._last_ts = 0
        self._rate = 0
        self._channels = 0
        self._count = 0
        self._power = QUALITY_NO_READING
        self._noise = QUALITY_NO_READING

    def decode(self, pkt: bytes) -> Tuple[PCMv4Header, int]:
        """Parse the header at the front of pkt.

        Returns the header and the offset at which the body begins. A packet
        arriving before any metadata has been seen is rejected rather than
        guessed at; the server's five-second resynchronisation ends that state
        on its own.
        """
        if len(pkt) < 5:
            raise PCMv4Error('pcm v4 header: packet too short (%d bytes)' % len(pkt))
        magic = struct.unpack_from('<I', pkt, 0)[0]
        if magic != PCMV4_MAGIC:
            raise PCMv4Error('pcm v4 header: bad magic 0x%08x' % magic)

        flags = pkt[4]
        off = 5

        profile = flags & _HDR_PROFILE_MASK
        escape = bool(flags & _FLAG_ESCAPE)
        silent = bool(flags & _FLAG_SILENT)
        if escape and silent:
            raise PCMv4Error('pcm v4 header: escape and silent are mutually exclusive')

        # A resynchronisation point carries a full timestamp; every other packet
        # carries a delta. The metadata bit marks the former, so it needs no
        # separate flag of its own.
        absolute = bool(flags & _FLAG_METADATA)
        if absolute:
            if len(pkt) < off + 8:
                raise PCMv4Error('pcm v4 header: truncated timestamp')
            self._last_ts = struct.unpack_from('<Q', pkt, off)[0]
            off += 8
        else:
            if not self._have_metadata:
                raise PCMv4Error('pcm v4 header: delta packet before any resynchronisation point')
            delta, off = _read_varint(pkt, off)
            self._last_ts += delta

        if flags & _FLAG_COUNT:
            self._count, off = _read_uvarint(pkt, off)

        if flags & _FLAG_METADATA:
            self._rate, off = _read_uvarint(pkt, off)
            if len(pkt) < off + 1:
                raise PCMv4Error('pcm v4 header: truncated channel count')
            self._channels = pkt[off]
            off += 1
            self._have_metadata = True
        elif not self._have_metadata:
            raise PCMv4Error('pcm v4 header: payload before any metadata')

        if flags & _FLAG_QUALITY:
            if len(pkt) < off + 4:
                raise PCMv4Error('pcm v4 header: truncated signal quality')
            self._power, self._noise = struct.unpack_from('<hh', pkt, off)
            off += 4

        if self._rate <= 0 or self._channels <= 0:
            raise PCMv4Error('pcm v4 header: implausible metadata (rate %d, channels %d)'
                             % (self._rate, self._channels))
        if self._count <= 0:
            raise PCMv4Error('pcm v4 header: implausible sample count %d' % self._count)

        return PCMv4Header(
            timestamp_nanos=self._last_ts,
            sample_rate=self._rate,
            channels=self._channels,
            sample_count=self._count,
            baseband_power=quality_to_float(self._power),
            noise=quality_to_float(self._noise),
            profile=profile,
            escape=escape,
            silent=silent,
        ), off


class _OpusHeaderDecoder:
    """Reads version 4 headers off Opus frames for one stream.

    Opus carries the same timestamp, metadata and signal quality as the lossless
    path, encoded identically, and none of what is specific to the predictive
    codec: no sample count, since an Opus body's length is implicit, and no
    escape, silent or profile bits, since there is no predictor.

    A SEPARATE instance from the PCM header decoder even on the same connection:
    the server keeps one header encoder for each, so a shared decoder would apply
    one stream's deltas to the other's baseline.
    """

    __slots__ = ('_have_metadata', '_last_ts', '_rate', '_channels', '_power', '_noise')

    def __init__(self) -> None:
        self._have_metadata = False
        self._last_ts = 0
        self._rate = 0
        self._channels = 0
        self._power = QUALITY_NO_READING
        self._noise = QUALITY_NO_READING

    def decode(self, pkt: bytes) -> Tuple[PCMv4Header, int]:
        """Parse the header, returning it and where the Opus body begins."""
        if len(pkt) < 1:
            raise PCMv4Error('opus v4 header: empty packet')
        flags = pkt[0]
        if flags & ~(_OPUS_FLAG_QUALITY | _OPUS_FLAG_METADATA):
            raise PCMv4Error('opus v4 header: unknown flag bits 0x%02x' % flags)
        off = 1

        absolute = bool(flags & _OPUS_FLAG_METADATA)
        if absolute:
            if len(pkt) < off + 8:
                raise PCMv4Error('opus v4 header: truncated timestamp')
            self._last_ts = struct.unpack_from('<Q', pkt, off)[0]
            off += 8
        else:
            if not self._have_metadata:
                raise PCMv4Error('opus v4 header: delta packet before any resynchronisation point')
            delta, off = _read_varint(pkt, off)
            self._last_ts += delta

        if absolute:
            self._rate, off = _read_uvarint(pkt, off)
            if len(pkt) < off + 1:
                raise PCMv4Error('opus v4 header: truncated channel count')
            self._channels = pkt[off]
            off += 1
            self._have_metadata = True
        elif not self._have_metadata:
            raise PCMv4Error('opus v4 header: payload before any metadata')

        if flags & _OPUS_FLAG_QUALITY:
            if len(pkt) < off + 4:
                raise PCMv4Error('opus v4 header: truncated signal quality')
            self._power, self._noise = struct.unpack_from('<hh', pkt, off)
            off += 4

        if self._rate <= 0 or self._channels <= 0:
            raise PCMv4Error('opus v4 header: implausible metadata (rate %d, channels %d)'
                             % (self._rate, self._channels))

        return PCMv4Header(
            timestamp_nanos=self._last_ts,
            sample_rate=self._rate,
            channels=self._channels,
            # An Opus body states its own length once decoded, so the header
            # does not carry a count and this stays 0 rather than inventing one.
            sample_count=0,
            baseband_power=quality_to_float(self._power),
            noise=quality_to_float(self._noise),
            profile=0,
            escape=False,
            silent=False,
        ), off


# --------------------------------------------------------------------------
# Predictive codec
# --------------------------------------------------------------------------
#
# Each sample is predicted from those before it by an adaptive filter; only the
# prediction error is transmitted, Rice coded. The filter is backward adaptive,
# so no coefficients are ever sent. All state is integer with shifts, never
# floating point, so server and client agree bit for bit on every platform --
# which is what makes the lossless claim meaningful across a Go server, this
# Python client and the browser.

#: Fixed-point scale of the filter taps: integers in Q16, so 65536 is 1.0.
_TAP_SHIFT = 16
_TAP_ROUND = 1 << (_TAP_SHIFT - 1)

#: Bounds |tap| to 2**24, a real magnitude of 256. Normal adaptation settles
#: around 2**16, so the clamp is insurance that never fires in practice -- but
#: it must be applied identically on both sides, since if it ever does fire the
#: two must agree.
_TAP_LIMIT = 1 << 24

#: Marks a body carrying verbatim samples, in the byte Decode is handed.
_PAYLOAD_ESCAPE = 1 << 7
#: Extracts the profile id from that byte. Four bits here, three in the header:
#: the payload byte has one spare that the header spends on other flags.
_PAYLOAD_PROFILE_MASK = 0x0F

#: A single complex filter of order 16, for interleaved I/Q.
PROFILE_IQ = 0
#: A four-stage real cascade, orders 8/8/4/2, for demodulated audio. Depth
#: matters far more than filter length there.
PROFILE_AUDIO = 1

#: The registry the wire format refers to; it must match the server's table
#: entry for entry. (complex, orders, mus)
_PROFILES = {
    PROFILE_IQ: (True, (16,), (16,)),
    PROFILE_AUDIO: (False, (8, 8, 4, 2), (16, 16, 32, 32)),
}

_PROFILE_NAMES = {PROFILE_IQ: 'iq-complex-o16', PROFILE_AUDIO: 'audio-real-8/8/4/2'}


def _round_shift(v: int) -> int:
    """Divide by 2**_TAP_SHIFT, rounding to nearest and away from zero on ties.

    A plain arithmetic shift rounds negative values towards negative infinity,
    which biases the predictor; more importantly the server rounds this way, so
    this is the single definition both directions use.
    """
    if v < 0:
        return -((-v + _TAP_ROUND) >> _TAP_SHIFT)
    return (v + _TAP_ROUND) >> _TAP_SHIFT


def _sign(v: int) -> int:
    return (v > 0) - (v < 0)


def _to_int16(v: int) -> int:
    """Narrow to int16 the way the server's int16(x) conversion does."""
    return ((v + 0x8000) & 0xFFFF) - 0x8000


def _history_len(order: int) -> int:
    """Size the sliding history window for a given filter order.

    History is kept linear rather than circular so the tap loops walk a
    contiguous list with no index wrapping. The cost is periodically sliding the
    newest `order` entries back to the front; making the window several times
    the order amortises that to negligible.
    """
    return max(order * 8, 64)


class _ComplexStage:
    """One adaptive complex filter, for interleaved I/Q.

    Sign-sign LMS rather than true NLMS: the update needs only the signs of the
    error and of the history, so it costs two multiplies per tap with no
    division and no normalisation, and is exactly reproducible in integers.
    """

    __slots__ = ('order', 'mu', 'wr', 'wi', 'hr', 'hi', 'sr', 'si', 'idx', 'fast')

    def __init__(self, order: int, mu: int) -> None:
        n = _history_len(order)
        self.order = order
        self.mu = mu
        # Taps in Q16, stored oldest-first, so predict and adapt walk taps and
        # history forward together.
        self.wr = [0] * order
        self.wi = [0] * order
        self.hr = [0] * n
        self.hi = [0] * n
        # Signs of the history kept alongside it, so the update loop does not
        # recompute a sign per tap per sample.
        self.sr = [0] * n
        self.si = [0] * n
        self.idx = order
        self.fast = False

    def begin_packet(self, steps: int) -> None:
        """Decide once per packet whether adapt may skip the tap clamp.

        One complex update moves a tap by at most 2*mu, so if every tap starts
        further than 2*mu*steps from the limit no update in this packet can
        reach it and the clamp is an identity. The server makes the same
        decision from the same taps, so the two take the same path -- and the
        clamped loop produces identical values anyway when it does run.
        """
        max_abs = 0
        for w in self.wr:
            a = -w if w < 0 else w
            if a > max_abs:
                max_abs = a
        for w in self.wi:
            a = -w if w < 0 else w
            if a > max_abs:
                max_abs = a
        self.fast = max_abs + 2 * self.mu * steps <= _TAP_LIMIT

    def inverse(self, er: int, ei: int) -> Tuple[int, int]:
        """Reconstruct a sample from its residual.

        Performs the same prediction, adaptation and history update as the
        encoder's forward direction, which is what keeps the two sides
        identical.
        """
        idx = self.idx
        order = self.order
        lo = idx - order
        wr = self.wr
        wi = self.wi
        hr = self.hr
        hi = self.hi

        pr = 0
        pi = 0
        for j in range(order):
            k = lo + j
            br = hr[k]
            bi = hi[k]
            w = wr[j]
            v = wi[j]
            pr += w * br - v * bi
            pi += w * bi + v * br

        xr = er + _round_shift(pr)
        xi = ei + _round_shift(pi)

        # A zero error is a genuine no-op: both steps are zero and every tap is
        # already inside the clamp, which turns adapt over silence into a
        # return.
        if er or ei:
            mr = self.mu * ((er > 0) - (er < 0))
            mi = self.mu * ((ei > 0) - (ei < 0))
            sr = self.sr
            si = self.si
            if self.fast:
                for j in range(order):
                    k = lo + j
                    hrs = sr[k]
                    # The conjugate of the history, as the complex LMS gradient
                    # requires; here that is the negated sign of the imaginary
                    # part.
                    his = -si[k]
                    wr[j] += mr * hrs - mi * his
                    wi[j] += mr * his + mi * hrs
            else:
                for j in range(order):
                    k = lo + j
                    hrs = sr[k]
                    his = -si[k]
                    a = wr[j] + mr * hrs - mi * his
                    b = wi[j] + mr * his + mi * hrs
                    wr[j] = _TAP_LIMIT if a > _TAP_LIMIT else (-_TAP_LIMIT if a < -_TAP_LIMIT else a)
                    wi[j] = _TAP_LIMIT if b > _TAP_LIMIT else (-_TAP_LIMIT if b < -_TAP_LIMIT else b)

        hr[idx] = xr
        hi[idx] = xi
        self.sr[idx] = (xr > 0) - (xr < 0)
        self.si[idx] = (xi > 0) - (xi < 0)
        idx += 1
        if idx == len(hr):
            n = order
            hr[:n] = hr[idx - n:idx]
            hi[:n] = hi[idx - n:idx]
            self.sr[:n] = self.sr[idx - n:idx]
            self.si[:n] = self.si[idx - n:idx]
            idx = n
        self.idx = idx
        return xr, xi

    def forward(self, xr: int, xi: int) -> Tuple[int, int]:
        """The encoder direction: return the residual for a known sample.

        The decoder needs it to advance the filters across a packet whose
        samples are already known -- an escape, or the implied zeros of a silent
        packet.
        """
        idx = self.idx
        order = self.order
        lo = idx - order
        hr = self.hr
        hi = self.hi
        wr = self.wr
        wi = self.wi

        pr = 0
        pi = 0
        for j in range(order):
            k = lo + j
            br = hr[k]
            bi = hi[k]
            w = wr[j]
            v = wi[j]
            pr += w * br - v * bi
            pi += w * bi + v * br

        er = xr - _round_shift(pr)
        ei = xi - _round_shift(pi)

        if er or ei:
            mr = self.mu * ((er > 0) - (er < 0))
            mi = self.mu * ((ei > 0) - (ei < 0))
            sr = self.sr
            si = self.si
            if self.fast:
                for j in range(order):
                    k = lo + j
                    hrs = sr[k]
                    his = -si[k]
                    wr[j] += mr * hrs - mi * his
                    wi[j] += mr * his + mi * hrs
            else:
                for j in range(order):
                    k = lo + j
                    hrs = sr[k]
                    his = -si[k]
                    a = wr[j] + mr * hrs - mi * his
                    b = wi[j] + mr * his + mi * hrs
                    wr[j] = _TAP_LIMIT if a > _TAP_LIMIT else (-_TAP_LIMIT if a < -_TAP_LIMIT else a)
                    wi[j] = _TAP_LIMIT if b > _TAP_LIMIT else (-_TAP_LIMIT if b < -_TAP_LIMIT else b)

        hr[idx] = xr
        hi[idx] = xi
        self.sr[idx] = (xr > 0) - (xr < 0)
        self.si[idx] = (xi > 0) - (xi < 0)
        idx += 1
        if idx == len(hr):
            n = order
            hr[:n] = hr[idx - n:idx]
            hi[:n] = hi[idx - n:idx]
            self.sr[:n] = self.sr[idx - n:idx]
            self.si[:n] = self.si[idx - n:idx]
            idx = n
        self.idx = idx
        return er, ei


class _RealStage:
    """_ComplexStage with the imaginary terms removed, for mono audio."""

    __slots__ = ('order', 'mu', 'w', 'h', 's', 'idx', 'fast')

    def __init__(self, order: int, mu: int) -> None:
        n = _history_len(order)
        self.order = order
        self.mu = mu
        self.w = [0] * order
        self.h = [0] * n
        self.s = [0] * n
        self.idx = order
        self.fast = False

    def begin_packet(self, steps: int) -> None:
        """One update moves a tap by at most mu, so the bound is mu*steps."""
        max_abs = 0
        for w in self.w:
            a = -w if w < 0 else w
            if a > max_abs:
                max_abs = a
        self.fast = max_abs + self.mu * steps <= _TAP_LIMIT

    def _step(self, value: int, is_inverse: bool) -> int:
        idx = self.idx
        order = self.order
        lo = idx - order
        w = self.w
        h = self.h

        p = 0
        for j in range(order):
            p += w[j] * h[lo + j]
        p = _round_shift(p)

        if is_inverse:
            e = value
            x = value + p
        else:
            x = value
            e = value - p

        if e:
            m = self.mu * ((e > 0) - (e < 0))
            s = self.s
            if self.fast:
                for j in range(order):
                    w[j] += m * s[lo + j]
            else:
                for j in range(order):
                    a = w[j] + m * s[lo + j]
                    w[j] = _TAP_LIMIT if a > _TAP_LIMIT else (-_TAP_LIMIT if a < -_TAP_LIMIT else a)

        h[idx] = x
        self.s[idx] = (x > 0) - (x < 0)
        idx += 1
        if idx == len(h):
            n = order
            h[:n] = h[idx - n:idx]
            self.s[:n] = self.s[idx - n:idx]
            idx = n
        self.idx = idx
        return x if is_inverse else e

    def inverse(self, e: int) -> int:
        return self._step(e, True)

    def forward(self, x: int) -> int:
        return self._step(x, False)


def _rice_decode(src: bytes, count: int) -> List[int]:
    """Reverse the server's riceEncodeResiduals.

    A residual is coded as its zigzagged magnitude split at bit k: the high part
    in unary, then a stop bit, then the low k bits raw. k is chosen per packet
    by the encoder and transmitted as the first byte of the body.
    """
    if len(src) < 1:
        raise PCMv4Error('rice: empty bitstream')
    k = src[0]
    if k > 30:
        raise PCMv4Error('rice: invalid k %d' % k)

    # The whole body as one big integer, least-significant byte first, so the
    # bit cursor is a shift rather than a refill loop. Python has no 64-bit
    # accumulator to spill, and this keeps the inner loop to shifts and masks.
    body = src[1:]
    acc = int.from_bytes(body, 'little')
    total_bits = len(body) * 8
    mask = (1 << k) - 1

    out = [0] * count
    pos = 0
    for j in range(count):
        # Count the run of 1 bits up to the stop bit. Bits past the end read as
        # 0, which is what makes a truncated stream terminate rather than spin.
        q = 0
        while True:
            if pos >= total_bits:
                raise PCMv4Error('rice: truncated at value %d' % j)
            if not (acc >> pos) & 1:
                pos += 1
                break
            q += 1
            pos += 1
        if pos + k > total_bits:
            raise PCMv4Error('rice: truncated remainder at value %d' % j)
        u = (q << k) | ((acc >> pos) & mask)
        pos += k
        # Undo the zigzag.
        out[j] = (u >> 1) ^ -(u & 1)
    return out


class PredictiveCodec:
    """Decodes one stream.

    Stateful across packets: create one per connection and drop it when the
    connection ends.
    """

    __slots__ = ('profile_id', 'complex', 'stages')

    def __init__(self, profile_id: int) -> None:
        """Build a codec for the given profile id, rejecting one it does not
        implement.

        The error is deliberate. Falling back to a default profile would decode
        a stream with the wrong predictor and return plausible-looking noise
        rather than failing, which is the worst possible behaviour for a codec
        whose entire promise is bit-exactness.
        """
        spec = _PROFILES.get(profile_id)
        if spec is None:
            raise PCMv4Error('predictive codec: unknown profile id %d' % profile_id)
        is_complex, orders, mus = spec
        self.profile_id = profile_id
        self.complex = is_complex
        if is_complex:
            self.stages = [_ComplexStage(o, m) for o, m in zip(orders, mus)]
        else:
            self.stages = [_RealStage(o, m) for o, m in zip(orders, mus)]

    @property
    def profile_name(self) -> str:
        return _PROFILE_NAMES.get(self.profile_id, 'profile-%d' % self.profile_id)

    def _samples_per_step(self) -> int:
        return 2 if self.complex else 1

    def _begin_packet(self, steps: int) -> None:
        for s in self.stages:
            s.begin_packet(steps)

    def _forward(self, a: int, b: int) -> None:
        """Run the cascade in the encoder direction over one sample position.

        This is how the filters are advanced across a packet whose samples are
        already known -- an escape, or the implied zeros of a silent packet.
        """
        if self.complex:
            for s in self.stages:
                a, b = s.forward(a, b)
        else:
            for s in self.stages:
                a = s.forward(a)

    def advance_silence(self, count: int) -> None:
        """Advance the filters over count zero-valued samples.

        A silent packet carries no body at all: Rice coding cannot get all-zero
        residuals below one bit per sample, and a squelched session sends
        nothing but zeros indefinitely, so the header says "all zero" and the
        body is omitted. The predictor still has to move exactly as the
        encoder's did over the same zeros, or every packet after this one
        decodes wrongly.
        """
        step = self._samples_per_step()
        if count <= 0:
            raise PCMv4Error('predictive codec: empty packet')
        if count % step:
            raise PCMv4Error('predictive codec: %d samples is not a whole number of %d-channel frames'
                             % (count, step))
        self._begin_packet(count // step)
        for _ in range(0, count, step):
            self._forward(0, 0)

    def decode_body(self, body: bytes, count: int, escape: bool) -> List[int]:
        """Reconstruct one packet body, with the escape flag from its header.

        Version 4 keeps the profile and the escape bit in the packet header,
        where they are needed anyway to tell a v4 packet from an Opus frame;
        repeating them in the body would waste a byte on every packet.
        """
        step = self._samples_per_step()
        if count <= 0 or count % step:
            raise PCMv4Error('predictive codec: bad sample count %d for %d-channel profile'
                             % (count, step))

        if escape:
            if len(body) < count * 2:
                raise PCMv4Error('predictive codec: escape payload truncated (%d bytes for %d samples)'
                                 % (len(body), count))
            out = list(struct.unpack_from('<%dh' % count, body, 0))
            # Advance the filters over these samples exactly as the encoder did,
            # discarding the residuals it produced.
            self._begin_packet(count // step)
            if step == 2:
                for i in range(0, count, 2):
                    self._forward(out[i], out[i + 1])
            else:
                for i in range(count):
                    self._forward(out[i], 0)
            return out

        res = _rice_decode(body, count)
        out = [0] * count
        self._begin_packet(count // step)

        if self.complex:
            stages = self.stages
            rev = list(reversed(stages))
            for i in range(0, count, 2):
                a = res[i]
                b = res[i + 1]
                # Stages are inverted in reverse order: the last stage to have
                # predicted is the first to be undone.
                for s in rev:
                    a, b = s.inverse(a, b)
                out[i] = _to_int16(a)
                out[i + 1] = _to_int16(b)
            return out

        rev = list(reversed(self.stages))
        for i in range(count):
            a = res[i]
            for s in rev:
                a = s.inverse(a)
            out[i] = _to_int16(a)
        return out


# --------------------------------------------------------------------------
# Stream decoder
# --------------------------------------------------------------------------

class PCMv4Decoder:
    """Reads version 4 packets for one connection.

    Ties the header to the payload codec and presents the receive loop with one
    call, so the binary branch does not grow a copy of the unpacking logic.

    Carries both header decoders because a connection can serve either format --
    a session that negotiated Opus still receives lossless packets when it tunes
    to IQ -- and the server tracks the two separately, so they must not share a
    baseline.
    """

    __slots__ = ('_header', '_opus_header', '_codec')

    def __init__(self) -> None:
        self._header = _HeaderDecoder()
        self._opus_header = _OpusHeaderDecoder()
        self._codec: Optional[PredictiveCodec] = None

    def decode_opus_header(self, pkt: bytes) -> Tuple[PCMv4Header, int]:
        """Header and body offset for a version 4 Opus frame.

        The caller hands the body to its Opus decoder; nothing here decodes
        Opus itself.
        """
        return self._opus_header.decode(pkt)

    def decode_packet(self, pkt: bytes) -> Tuple[PCMv4Header, List[int]]:
        """Return the header and the samples, interleaved I/Q when the header
        reports two channels.

        The packet is self-contained: the header carries the sample count, so
        nothing has to be told out of band how long the body is.
        """
        h, off = self._header.decode(pkt)

        # The packet declares its own profile; nothing here infers it from the
        # mode or the channel count. A profile this build does not implement is
        # an error rather than a fallback -- decoding with the wrong predictor
        # would return plausible noise instead of failing.
        if self._codec is None or self._codec.profile_id != h.profile:
            self._codec = PredictiveCodec(h.profile)

        if h.silent:
            if len(pkt) != off:
                raise PCMv4Error('pcm v4: silent packet carries %d bytes of body' % (len(pkt) - off))
            self._codec.advance_silence(h.sample_count)
            return h, [0] * h.sample_count

        return h, self._codec.decode_body(pkt[off:], h.sample_count, h.escape)

    def decode_packet_le(self, pkt: bytes) -> Tuple[bytes, PCMv4Header]:
        """decode_packet in the shape the rest of the client works in:
        little-endian int16 bytes, plus the header.

        Little-endian is what a WAV body and an audio device both want, and what
        the codec already produces -- unlike the versions 1-3 path, whose samples
        arrived big-endian and had to be reversed on every packet.
        """
        h, samples = self.decode_packet(pkt)
        return struct.pack('<%dh' % len(samples), *samples), h


# --------------------------------------------------------------------------
# Cost
# --------------------------------------------------------------------------
#
# This decoder is pure Python and the predictor is strictly sequential: every
# sample depends on the ones before it and the taps adapt per sample, so it
# cannot be vectorised with numpy and cannot be handed to a C library the way
# zstd was. It runs at interpreter speed.
#
# Measured against this repository's fixture, CPython 3.12 on an x86-64 desktop:
#
#     IQ (profile 0, one complex order-16 filter):   ~70-85 k frames/s
#     audio (profile 1, real cascade 8/8/4/2):      ~125 k samples/s
#
# Demodulated audio and iq48 decode in real time with room to spare. iq96 and
# above do not -- they arrive faster than this can consume them, and the socket
# backs up. Inlining the round-shift and walking the history with zip rather
# than indices measured 1.02x, so no ordinary Python optimisation closes that
# gap; it would take a C extension.
#
# Recorded here because it is a property of the interpreter rather than a bug,
# and because someone seeing a high-rate IQ stream fall behind should find the
# reason next to the code rather than having to measure it again.
