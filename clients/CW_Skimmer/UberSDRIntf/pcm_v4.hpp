// pcm_v4.hpp — decoder for UberSDR audio protocol version 4.
//
// Self-contained and header-only: it needs only <string> and <vector>, so it
// drops into a build without adding a library to find. That is what lets this
// DLL delete its zstd dependency outright rather than swapping one for another.
//
// Shared verbatim with clients/soapy_driver, and a port of the same decoder in
// clients/rtl_sdr (Go), clients/python (pcm_v4.py) and static/v2 (pcm-v4.js).
// Keep them in step: they are all checked against the same server-produced
// fixture, and a change here that is not made there is a divergence nothing
// will report until audio turns to noise.
//
// WHY THIS EXISTS
// ---------------
// Versions 1 to 3 wrapped every lossless packet in a zstd frame and put a fixed
// 29- or 37-byte header on it. zstd does not compress this data: measured
// against a live receiver every IQ mode came back at 0.99x, the compressed
// stream consistently LARGER than the samples it carried, because zstd is an
// LZ77 matcher over bytes and a band-limited RF signal has no repeated byte
// strings.
//
// It does have redundancy, just not that kind — consecutive samples correlate
// at |r(1)| = 0.78-0.90 on IQ — and a predictor plus an entropy coder suited to
// residuals extracts it. Version 4 replaces the wrapper with exactly that, and
// the fixed header with one carrying only what changed. On the rates this
// driver uses: 384 kHz IQ falls from 1590 kB/s to 1116, and 48 kHz from 199.6
// to 140.4.
//
// HOW IT WORKS
// ------------
// Each sample is predicted from those before it by an adaptive filter and only
// the prediction error is sent, Rice coded. The filter is BACKWARD adaptive:
// its taps are derived from samples already decoded, so this side recomputes
// them independently and no coefficients are ever transmitted.
//
// That is what makes every arithmetic detail below load-bearing. All state is
// integer with shifts, never floating point, so the Go server and this decoder
// agree bit for bit — but only if the rounding of the prediction sum, the sign
// convention, the tap clamp, the order in which stages are inverted and the
// point at which the fast path skips the clamp all match exactly. A difference
// in any of them does not fail loudly; it returns plausible-looking noise.
//
// The reference is pcm_predictive.go and pcm_v4_header.go in the server tree,
// and the conformance test in test/ decodes a packet stream that the server's
// own encoder produced.
//
// PROFILES: THE SERVER DECIDES
// ----------------------------
// Each packet declares the profile it was coded with. This driver reads the
// declaration and obeys it; it never infers the predictor from the mode or the
// channel count. Both profiles are implemented even though a driver that only
// tunes IQ modes should only ever meet the complex one — the server's choice is
// policy it may retune per band, and the cost of being ready for that is one
// small class.
//
// An unknown profile id is a hard error rather than a fallback, for the reason
// above: decoding with the wrong predictor would return noise and call it
// signal.

#ifndef UBERSDR_PCM_V4_HPP
#define UBERSDR_PCM_V4_HPP

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace ubersdr {

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

// pcmProtocolVersion is what a client asks for in the WebSocket query string.
static const int kPCMProtocolVersion = 4;

// "PCM4" little-endian. Four bytes, because a session that negotiated Opus
// still receives these for IQ, and the width of the magic is a false-positive
// rate against an Opus frame's leading timestamp bytes.
static const uint32_t kPCMv4Magic = 0x344D4350u;

// A version 1-3 lossless frame, which means a server older than 0.1.63: those
// clamp the requested version to 1-3 and answer with version 1 rather than
// refusing it.
static const uint32_t kZstdMagic = 0xFD2FB528u;

// Flag bits in the header's flags byte.
static const uint8_t kFlagEscape = 1 << 7;
static const uint8_t kFlagQuality = 1 << 6;
static const uint8_t kFlagMetadata = 1 << 5;
static const uint8_t kFlagSilent = 1 << 4;
static const uint8_t kFlagCount = 1 << 3;
static const uint8_t kProfileFieldMask = 0x07;

// The codepoint for "radiod reported nothing". It stands in for the -999
// sentinel, which cannot be represented in centidecibels: -99900 overflows an
// int16.
static const int16_t kQualityNoReading = -32768;

// Profile ids. Part of the version 4 wire format; never reassigned.
static const uint8_t kProfileIQ = 0;    // one complex filter, order 16
static const uint8_t kProfileAudio = 1; // four real stages, orders 8/8/4/2

// Fixed-point scale of the filter taps: integers in Q16, so 65536 is a tap
// of 1.0.
static const unsigned kTapShift = 16;

// |tap| is bounded to 2^24, a real magnitude of 256. It caps the prediction sum
// far below int64 overflow whatever the input does. Adaptation settles around
// 2^16, so the clamp is insurance that never fires in practice — but it must be
// applied identically on both sides, because if it ever does fire the two must
// agree.
static const int64_t kTapLimit = (int64_t)1 << 24;

// The escape and profile bits as the payload carries them. The version 4 header
// carries both itself, so the body is handed the flags separately.
static const uint8_t kPayloadEscapeFlag = 1 << 7;
static const uint8_t kPayloadProfileMask = 0x0f;

// ---------------------------------------------------------------------------
// Integer helpers
//
// Written to be exactly the Go server's arithmetic on every compiler rather
// than merely usually: negation goes through unsigned so INT64_MIN cannot
// overflow, and no result depends on how a right shift of a negative value
// behaves, which C++11 leaves implementation-defined.
// ---------------------------------------------------------------------------

// -1, 0 or +1.
static inline int64_t predSign(int64_t v) {
    return (int64_t)(v > 0) - (int64_t)(v < 0);
}

// Divide by 2^shift, rounding to nearest and away from zero on ties.
//
// A plain arithmetic shift would round negative values towards negative
// infinity, biasing the predictor — and, more to the point, the server rounds
// this way, so this is the single definition both sides must use.
static inline int64_t predRoundShift(int64_t v, unsigned shift) {
    const uint64_t half = (uint64_t)1 << (shift - 1);
    if (v < 0) {
        const uint64_t mag = (uint64_t)0 - (uint64_t)v; // |v|, no signed overflow
        return -(int64_t)((mag + half) >> shift);
    }
    return (int64_t)(((uint64_t)v + half) >> shift);
}

static inline int64_t predClampTap(int64_t w) {
    if (w > kTapLimit) return kTapLimit;
    if (w < -kTapLimit) return -kTapLimit;
    return w;
}

// Go's bits.TrailingZeros64, including its answer of 64 for zero — which the
// Rice decoder relies on, and which __builtin_ctzll leaves undefined.
static inline unsigned predTrailingZeros64(uint64_t x) {
    if (x == 0) return 64;
#if defined(__GNUC__) || defined(__clang__)
    return (unsigned)__builtin_ctzll(x);
#else
    unsigned n = 0;
    while ((x & 1) == 0) { x >>= 1; ++n; }
    return n;
#endif
}

// History window for a given filter order.
//
// Kept linear rather than circular so the tap loops walk contiguous memory with
// no index wrapping, which matters at the 1098 packets a second a 384 kHz
// stream delivers. The cost is periodically sliding the newest `order` entries
// back to the front; making the window several times the order amortises that
// to nothing.
static inline int predHistoryLen(int order) {
    int n = order * 8;
    return n < 64 ? 64 : n;
}

// Signed centidecibels to dB, returning the -999 sentinel clients test for.
static inline float pcmQualityToFloat(int16_t q) {
    if (q == kQualityNoReading) return -999.0f;
    return (float)((double)q / 100.0);
}

// ---------------------------------------------------------------------------
// Adaptive filter stages
//
// Sign-sign LMS rather than true NLMS: the update needs only the signs of the
// error and of the history, so it costs two multiplies per tap with no division
// and no normalisation, and is exactly reproducible in integers.
// ---------------------------------------------------------------------------

// One adaptive complex filter, for interleaved I/Q. A carrier in complex
// baseband is a single complex pole that one complex tap cancels exactly, which
// treating I and Q as two real streams throws away.
class ComplexStage {
public:
    ComplexStage(int order, int64_t mu)
        : _order(order), _mu(mu), _fast(false), _idx(order) {
        const int n = predHistoryLen(order);
        _wr.assign(order, 0);
        _wi.assign(order, 0);
        _hr.assign(n, 0);
        _hi.assign(n, 0);
        _sr.assign(n, 0);
        _si.assign(n, 0);
    }

    // Decide once per packet whether adapt may skip the tap clamp.
    //
    // One complex update moves a tap by at most 2*mu — each of the two sign
    // terms contributes at most mu — so if every tap starts further than
    // 2*mu*steps from the limit, no update in this packet can reach it and the
    // clamp is an identity. The server makes the same decision from the same
    // taps, so the two take the same path; the clamped loop produces identical
    // values anyway when it does run.
    void beginPacket(int steps) {
        int64_t maxAbs = 0;
        for (size_t j = 0; j < _wr.size(); ++j) {
            int64_t w = _wr[j] < 0 ? -_wr[j] : _wr[j];
            if (w > maxAbs) maxAbs = w;
        }
        for (size_t j = 0; j < _wi.size(); ++j) {
            int64_t w = _wi[j] < 0 ? -_wi[j] : _wi[j];
            if (w > maxAbs) maxAbs = w;
        }
        _fast = maxAbs + 2 * _mu * (int64_t)steps <= kTapLimit;
    }

    // Encoder direction: the residual for a known sample. The decoder needs it
    // to advance the filters across an escaped or silent packet exactly as the
    // encoder did.
    void forward(int64_t xr, int64_t xi, int64_t &er, int64_t &ei) {
        int64_t pr, pi;
        predict(pr, pi);
        er = xr - pr;
        ei = xi - pi;
        adapt(er, ei);
        push(xr, xi);
    }

    // Decoder direction: reconstruct a sample from its residual, performing the
    // same prediction, adaptation and history update as forward.
    void inverse(int64_t er, int64_t ei, int64_t &xr, int64_t &xi) {
        int64_t pr, pi;
        predict(pr, pi);
        xr = er + pr;
        xi = ei + pi;
        adapt(er, ei);
        push(xr, xi);
    }

private:
    void predict(int64_t &outR, int64_t &outI) const {
        const int order = _order;
        const int lo = _idx - order;
        int64_t pr = 0, pi = 0;
        for (int j = 0; j < order; ++j) {
            const int64_t br = _hr[lo + j], bi = _hi[lo + j];
            const int64_t w = _wr[j], wiv = _wi[j];
            pr += w * br - wiv * bi;
            pi += w * bi + wiv * br;
        }
        outR = predRoundShift(pr, kTapShift);
        outI = predRoundShift(pi, kTapShift);
    }

    // Nudge each tap by mu in the direction that would have reduced this error.
    // The conjugate of the history is used, as the complex LMS gradient
    // requires; here that is the negated sign of the imaginary part.
    //
    // A zero error is a genuine no-op — both steps are zero and every tap is
    // already inside the clamp — which turns the adapt pass over silence into a
    // return.
    void adapt(int64_t er, int64_t ei) {
        if (er == 0 && ei == 0) return;
        const int64_t mr = _mu * predSign(er);
        const int64_t mi = _mu * predSign(ei);
        const int order = _order;
        const int lo = _idx - order;
        if (_fast) {
            for (int j = 0; j < order; ++j) {
                const int64_t hrs = _sr[lo + j];
                const int64_t his = -_si[lo + j];
                _wr[j] += mr * hrs - mi * his;
                _wi[j] += mr * his + mi * hrs;
            }
            return;
        }
        for (int j = 0; j < order; ++j) {
            const int64_t hrs = _sr[lo + j];
            const int64_t his = -_si[lo + j];
            _wr[j] = predClampTap(_wr[j] + mr * hrs - mi * his);
            _wi[j] = predClampTap(_wi[j] + mr * his + mi * hrs);
        }
    }

    void push(int64_t xr, int64_t xi) {
        _hr[_idx] = xr;
        _hi[_idx] = xi;
        _sr[_idx] = predSign(xr);
        _si[_idx] = predSign(xi);
        ++_idx;
        if (_idx == (int)_hr.size()) {
            const int n = _order;
            for (int j = 0; j < n; ++j) {
                _hr[j] = _hr[_idx - n + j];
                _hi[j] = _hi[_idx - n + j];
                _sr[j] = _sr[_idx - n + j];
                _si[j] = _si[_idx - n + j];
            }
            _idx = n;
        }
    }

    int _order;
    int64_t _mu;
    bool _fast;
    int _idx;
    // Taps in Q16, oldest-first: _wr[j] weighs the history sample at
    // _hr[_idx-order+j], so predict and adapt walk taps and history forward
    // together. Sample signs are kept beside the samples so the update loop
    // does not recompute a sign per tap per sample.
    std::vector<int64_t> _wr, _wi, _hr, _hi, _sr, _si;
};

// ComplexStage with the imaginary terms removed, for mono audio. Same fast
// flag, same tap ordering; see ComplexStage for both.
class RealStage {
public:
    RealStage(int order, int64_t mu)
        : _order(order), _mu(mu), _fast(false), _idx(order) {
        const int n = predHistoryLen(order);
        _w.assign(order, 0);
        _h.assign(n, 0);
        _s.assign(n, 0);
    }

    // One real update moves a tap by at most mu, so the bound is mu*steps.
    void beginPacket(int steps) {
        int64_t maxAbs = 0;
        for (size_t j = 0; j < _w.size(); ++j) {
            int64_t w = _w[j] < 0 ? -_w[j] : _w[j];
            if (w > maxAbs) maxAbs = w;
        }
        _fast = maxAbs + _mu * (int64_t)steps <= kTapLimit;
    }

    int64_t forward(int64_t x) {
        const int64_t p = predict();
        const int64_t e = x - p;
        adapt(e);
        push(x);
        return e;
    }

    int64_t inverse(int64_t e) {
        const int64_t p = predict();
        const int64_t x = e + p;
        adapt(e);
        push(x);
        return x;
    }

private:
    int64_t predict() const {
        const int order = _order;
        const int lo = _idx - order;
        int64_t p = 0;
        for (int j = 0; j < order; ++j) p += _w[j] * _h[lo + j];
        return predRoundShift(p, kTapShift);
    }

    void adapt(int64_t e) {
        if (e == 0) return;
        const int64_t m = _mu * predSign(e);
        const int order = _order;
        const int lo = _idx - order;
        if (_fast) {
            for (int j = 0; j < order; ++j) _w[j] += m * _s[lo + j];
            return;
        }
        for (int j = 0; j < order; ++j) _w[j] = predClampTap(_w[j] + m * _s[lo + j]);
    }

    void push(int64_t x) {
        _h[_idx] = x;
        _s[_idx] = predSign(x);
        ++_idx;
        if (_idx == (int)_h.size()) {
            const int n = _order;
            for (int j = 0; j < n; ++j) {
                _h[j] = _h[_idx - n + j];
                _s[j] = _s[_idx - n + j];
            }
            _idx = n;
        }
    }

    int _order;
    int64_t _mu;
    bool _fast;
    int _idx;
    std::vector<int64_t> _w, _h, _s;
};

// ---------------------------------------------------------------------------
// Rice coding of residuals
//
// A residual is coded as its zigzagged magnitude split at bit k: the high part
// in unary, then a stop bit, then the low k bits raw. k is chosen per packet by
// the encoder and sent as the first byte of the body.
// ---------------------------------------------------------------------------

// Reverse the server's riceEncodeResiduals into out[0..count).
inline bool riceDecodeResiduals(const uint8_t *src, size_t len,
                                int32_t *out, size_t count, std::string &err) {
    if (len < 1) {
        err = "rice: empty bitstream";
        return false;
    }
    const unsigned k = src[0];
    if (k > 30) {
        err = "rice: invalid k";
        return false;
    }
    ++src;
    --len;

    uint64_t acc = 0;
    unsigned nbits = 0;
    size_t i = 0;

    // Bits past nbits read as zero, which is what lets a unary run that reaches
    // the end of the accumulator simply continue after a refill.
    #define UBERSDR_RICE_REFILL()                                   \
        while (nbits <= 56 && i < len) {                            \
            acc |= (uint64_t)src[i] << nbits;                       \
            ++i;                                                    \
            nbits += 8;                                             \
        }

    UBERSDR_RICE_REFILL()
    const uint64_t mask = ((uint64_t)1 << k) - 1;

    for (size_t j = 0; j < count; ++j) {
        if (nbits < 48) { UBERSDR_RICE_REFILL() }

        unsigned q = 0;
        for (;;) {
            const unsigned c = predTrailingZeros64(~acc);
            if (c < nbits) {
                q += c;
                // The shift is by c+1, which reaches 64 when a 63-bit unary run
                // is counted out of a full accumulator -- nbits tops out at
                // exactly 64 because the refill runs while nbits <= 56. Go's
                // shift yields zero there; a C++ shift of a uint64_t by 64 is
                // undefined, and on x86 the count is taken modulo 64, so the
                // accumulator keeps every bit it had and the next refill ORs
                // fresh bytes into stale ones. The rest of the packet then
                // decodes as garbage, which the backward-adaptive predictor
                // feeds into its taps -- so the stream stays wrong for the life
                // of the connection, silently, unless the damage happens to
                // make the bitstream unparseable.
                const unsigned sh = c + 1;
                acc = (sh >= 64) ? 0 : (acc >> sh);
                nbits -= sh;
                break;
            }
            if (i >= len) {
                err = "rice: truncated bitstream";
                return false;
            }
            q += nbits;
            acc = 0;
            nbits = 0;
            UBERSDR_RICE_REFILL()
        }

        if (nbits < k) { UBERSDR_RICE_REFILL() }
        if (nbits < k) {
            err = "rice: truncated remainder";
            return false;
        }
        const uint32_t u = ((uint32_t)q << k) | (uint32_t)(acc & mask);
        acc >>= k;
        nbits -= k;
        // Undo the zigzag.
        out[j] = (int32_t)((u >> 1) ^ ((uint32_t)0 - (u & 1)));
    }
    #undef UBERSDR_RICE_REFILL
    return true;
}

// ---------------------------------------------------------------------------
// Varints, as encoding/binary writes them
// ---------------------------------------------------------------------------

inline bool readUvarint(const uint8_t *p, size_t len, size_t &off, uint64_t &out) {
    uint64_t x = 0;
    unsigned shift = 0;
    for (size_t n = 0; n < 10; ++n) {
        if (off >= len) return false;
        const uint8_t b = p[off++];
        if (b < 0x80) {
            if (n == 9 && b > 1) return false; // would overflow 64 bits
            out = x | ((uint64_t)b << shift);
            return true;
        }
        x |= (uint64_t)(b & 0x7f) << shift;
        shift += 7;
    }
    return false;
}

// Signed varints are zigzagged before the unsigned encoding, so small negative
// deltas stay one byte.
inline bool readVarint(const uint8_t *p, size_t len, size_t &off, int64_t &out) {
    uint64_t ux;
    if (!readUvarint(p, len, off, ux)) return false;
    out = (int64_t)((ux >> 1) ^ ((uint64_t)0 - (ux & 1)));
    return true;
}

// ---------------------------------------------------------------------------
// Packet header
// ---------------------------------------------------------------------------

// One packet's metadata, in the terms callers use. Every field is filled in on
// every packet, carried forward from the last resynchronisation point when the
// packet itself did not repeat it.
struct PCMv4Header {
    uint64_t timestampNanos; // GPS-synchronised time of the first sample
    int sampleRate;
    int channels;    // 1 for demodulated audio, 2 for interleaved I/Q
    int sampleCount; // int16 samples in the body, counting both channels
    float basebandPower; // dBFS, or -999 when radiod reported nothing
    float noise;         // dBFS over the demodulator passband, or -999
    uint8_t profile;
    bool escape; // the body holds verbatim samples
    bool silent; // every sample is zero and no body was transmitted

    PCMv4Header()
        : timestampNanos(0), sampleRate(0), channels(0), sampleCount(0),
          basebandPower(-999.0f), noise(-999.0f), profile(0),
          escape(false), silent(false) {}
};

// Reads headers for one stream, carrying forward whatever the server chose not
// to repeat.
//
// LAYOUT
//
//   [magic u32 = "PCM4"]                        4   always
//   [flags u8]                                  1   always
//   [timestamp]                             8 or ~2   full at a resync, delta otherwise
//   [sampleCount uvarint]                       2   if the count bit is set
//   [sampleRate uvarint][channels u8]          ~3   if the metadata bit is set
//   [power i16][noise i16]                      4   if the quality bit is set
//
//   flags: bit 7 escape   bit 6 quality   bit 5 metadata
//          bit 4 silent   bit 3 count     bits 2-0 profile id
//
// The metadata bit marks a resynchronisation point, which is also what carries
// a full timestamp; the two never differ, so there is no separate flag for the
// second. The server re-sends metadata whenever the rate or channel count
// changes and every five seconds regardless, so a reader that joins a stream
// late becomes self-describing within that.
class PCMv4HeaderDecoder {
public:
    PCMv4HeaderDecoder() { reset(); }

    void reset() {
        _haveMetadata = false;
        _lastTS = 0;
        _rate = 0;
        _channels = 0;
        _count = 0;
        _power = 0;
        _noise = 0;
    }

    // Parse the header at the front of pkt, returning the offset at which the
    // body begins.
    //
    // A packet that arrives before any metadata has been seen is refused rather
    // than guessed at: nothing has said what the sample rate is, and its
    // timestamp is a delta from a baseline that was never received.
    bool decode(const uint8_t *pkt, size_t len, PCMv4Header &h, size_t &bodyOff,
                std::string &err) {
        if (len < 5) {
            err = "pcm v4 header: packet too short";
            return false;
        }
        const uint32_t magic = (uint32_t)pkt[0] | ((uint32_t)pkt[1] << 8) |
                               ((uint32_t)pkt[2] << 16) | ((uint32_t)pkt[3] << 24);
        if (magic != kPCMv4Magic) {
            err = "pcm v4 header: bad magic";
            return false;
        }
        const uint8_t flags = pkt[4];
        size_t off = 5;

        h.profile = flags & kProfileFieldMask;
        h.escape = (flags & kFlagEscape) != 0;
        h.silent = (flags & kFlagSilent) != 0;
        if (h.escape && h.silent) {
            err = "pcm v4 header: escape and silent are mutually exclusive";
            return false;
        }

        if (flags & kFlagMetadata) {
            if (len < off + 8) {
                err = "pcm v4 header: truncated timestamp";
                return false;
            }
            uint64_t ts = 0;
            for (int b = 7; b >= 0; --b) ts = (ts << 8) | pkt[off + (size_t)b];
            _lastTS = ts;
            off += 8;
        } else {
            if (!_haveMetadata) {
                err = "pcm v4 header: delta packet before any resynchronisation point";
                return false;
            }
            int64_t delta;
            if (!readVarint(pkt, len, off, delta)) {
                err = "pcm v4 header: malformed timestamp delta";
                return false;
            }
            _lastTS = (uint64_t)((int64_t)_lastTS + delta);
        }
        h.timestampNanos = _lastTS;

        if (flags & kFlagCount) {
            uint64_t count;
            if (!readUvarint(pkt, len, off, count)) {
                err = "pcm v4 header: malformed sample count";
                return false;
            }
            _count = (int)count;
        }

        if (flags & kFlagMetadata) {
            uint64_t rate;
            if (!readUvarint(pkt, len, off, rate)) {
                err = "pcm v4 header: malformed sample rate";
                return false;
            }
            if (len < off + 1) {
                err = "pcm v4 header: truncated channel count";
                return false;
            }
            _rate = (int)rate;
            _channels = (int)pkt[off];
            ++off;
            _haveMetadata = true;
        } else if (!_haveMetadata) {
            err = "pcm v4 header: payload before any metadata";
            return false;
        }

        if (flags & kFlagQuality) {
            if (len < off + 4) {
                err = "pcm v4 header: truncated signal quality";
                return false;
            }
            _power = (int16_t)((uint16_t)pkt[off] | ((uint16_t)pkt[off + 1] << 8));
            _noise = (int16_t)((uint16_t)pkt[off + 2] | ((uint16_t)pkt[off + 3] << 8));
            off += 4;
        }

        if (_rate <= 0 || _channels <= 0) {
            err = "pcm v4 header: implausible metadata";
            return false;
        }
        if (_count <= 0) {
            err = "pcm v4 header: implausible sample count";
            return false;
        }

        h.sampleRate = _rate;
        h.channels = _channels;
        h.sampleCount = _count;
        h.basebandPower = pcmQualityToFloat(_power);
        h.noise = pcmQualityToFloat(_noise);
        bodyOff = off;
        return true;
    }

private:
    bool _haveMetadata;
    uint64_t _lastTS;
    int _rate, _channels, _count;
    int16_t _power, _noise;
};

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

// Decodes one stream's payloads. Stateful across packets and not safe for
// concurrent use: its taps carry the adaptation of every sample decoded so far.
class PredictiveCodec {
public:
    PredictiveCodec() : _id(0xff), _complex(false) {}

    // Build for a profile id, refusing one this build does not implement.
    bool configure(uint8_t profileID, std::string &err) {
        if (_id == profileID) return true;
        _cx.clear();
        _rl.clear();
        switch (profileID) {
        case kProfileIQ:
            // A single complex filter of order 16. Deeper cascades were
            // measured and rejected for IQ: 8/8/4/2 gave 1.391x against this
            // profile's 1.396x at roughly double the CPU.
            _complex = true;
            _cx.push_back(ComplexStage(16, 16));
            break;
        case kProfileAudio:
            // Depth matters far more than filter length on demodulated audio,
            // which carries a ~2.65 kHz passband in a 12 kHz channel and so
            // leaves structure at several scales: 1.370x for one order-16
            // filter against 1.889x for this cascade, which is also the
            // cheapest of the deep configurations.
            _complex = false;
            _rl.push_back(RealStage(8, 16));
            _rl.push_back(RealStage(8, 16));
            _rl.push_back(RealStage(4, 32));
            _rl.push_back(RealStage(2, 32));
            break;
        default:
            err = "predictive codec: unknown profile id";
            _id = 0xff;
            return false;
        }
        _id = profileID;
        return true;
    }

    uint8_t profile() const { return _id; }
    int samplesPerStep() const { return _complex ? 2 : 1; }

    // Advance the filters over count zero-valued samples.
    //
    // A silent packet carries no body at all: Rice coding cannot get all-zero
    // residuals below one bit per sample, and a squelched or muted session
    // produces nothing else indefinitely, so the header says "all zero" and the
    // body is omitted. The predictor still has to move exactly as the
    // encoder's did over the same zeros, or every packet after this one decodes
    // wrongly.
    bool advanceSilence(int count, std::string &err) {
        const int step = samplesPerStep();
        if (count <= 0 || count % step != 0) {
            err = "predictive codec: bad sample count for profile";
            return false;
        }
        beginPacket(count / step);
        for (int i = 0; i < count; i += step) {
            int64_t a = 0, b = 0;
            forward(a, b);
        }
        return true;
    }

    // Reconstruct one packet body into out[0..count). escape comes from the
    // header, which carries it so the body need not repeat a byte per packet.
    bool decodeBody(const uint8_t *body, size_t len, int count, bool escape,
                    int16_t *out, std::string &err) {
        const int step = samplesPerStep();
        if (count <= 0 || count % step != 0) {
            err = "predictive codec: bad sample count for profile";
            return false;
        }

        if (escape) {
            // A predictor cannot help a full-entropy signal, and a saturated
            // front end produces exactly that; without the escape such a stream
            // would EXPAND by about 3%. The filters still advance over these
            // samples on both sides, so state stays in step through one.
            if (len < (size_t)count * 2) {
                err = "predictive codec: escape payload truncated";
                return false;
            }
            for (int i = 0; i < count; ++i) {
                out[i] = (int16_t)((uint16_t)body[2 * i] | ((uint16_t)body[2 * i + 1] << 8));
            }
            beginPacket(count / step);
            for (int i = 0; i < count; i += step) {
                int64_t a = (int64_t)out[i];
                int64_t b = (step == 2) ? (int64_t)out[i + 1] : 0;
                forward(a, b);
            }
            return true;
        }

        if (len < 1) {
            err = "predictive codec: empty payload";
            return false;
        }
        if ((size_t)count > _res.size()) _res.resize((size_t)count);
        if (!riceDecodeResiduals(body, len, &_res[0], (size_t)count, err)) return false;

        beginPacket(count / step);
        if (_complex) {
            for (int i = 0; i < count; i += 2) {
                int64_t a = _res[i], b = _res[i + 1];
                // Stages are inverted in reverse order: the last to have
                // predicted is the first to be undone.
                for (int s = (int)_cx.size() - 1; s >= 0; --s) {
                    int64_t xr, xi;
                    _cx[(size_t)s].inverse(a, b, xr, xi);
                    a = xr;
                    b = xi;
                }
                out[i] = (int16_t)a;
                out[i + 1] = (int16_t)b;
            }
            return true;
        }
        for (int i = 0; i < count; ++i) {
            int64_t a = _res[i];
            for (int s = (int)_rl.size() - 1; s >= 0; --s) a = _rl[(size_t)s].inverse(a);
            out[i] = (int16_t)a;
        }
        return true;
    }

private:
    // Let every stage decide once, from where its taps stand, whether this
    // packet's adapt calls may skip the clamp. steps is how many times each
    // stage will adapt: sample count for a real cascade, frame count for a
    // complex one.
    void beginPacket(int steps) {
        for (size_t s = 0; s < _cx.size(); ++s) _cx[s].beginPacket(steps);
        for (size_t s = 0; s < _rl.size(); ++s) _rl[s].beginPacket(steps);
    }

    // The cascade in the encoder direction over one sample position, which is
    // how the filters are advanced across a packet whose samples are already
    // known — an escape, or the implied zeros of a silent packet.
    void forward(int64_t &a, int64_t &b) {
        if (_complex) {
            for (size_t s = 0; s < _cx.size(); ++s) {
                int64_t er, ei;
                _cx[s].forward(a, b, er, ei);
                a = er;
                b = ei;
            }
            return;
        }
        for (size_t s = 0; s < _rl.size(); ++s) a = _rl[s].forward(a);
        b = 0;
    }

    uint8_t _id;
    bool _complex;
    std::vector<ComplexStage> _cx;
    std::vector<RealStage> _rl;
    std::vector<int32_t> _res;
};

// ---------------------------------------------------------------------------
// Packet decoder
// ---------------------------------------------------------------------------

// Ties the header to the payload codec and presents one call per packet.
//
// A stream decoder IS the stream: it holds the adaptation of every sample
// decoded so far and the record of what the server has stopped repeating, so it
// belongs to exactly one connection and must be reset when a new socket opens.
// Every packet MUST be passed to it, even one whose samples are then dropped —
// a packet that never reaches the codec leaves this side's filters where the
// server's no longer are, and everything after it decodes as noise.
class PCMv4StreamDecoder {
public:
    PCMv4StreamDecoder() { reset(); }

    void reset() {
        _header.reset();
        _codec = PredictiveCodec();
        _samples.clear();
    }

    // Is this frame a version 4 lossless packet?
    static bool isV4Frame(const uint8_t *pkt, size_t len) {
        return len >= 4 && readMagic(pkt) == kPCMv4Magic;
    }

    // Is this frame the version 1-3 shape, meaning a server older than 0.1.63?
    static bool isZstdFrame(const uint8_t *pkt, size_t len) {
        return len >= 4 && readMagic(pkt) == kZstdMagic;
    }

    // Decode one packet. The samples are interleaved I/Q when the header
    // reports two channels, and remain valid until the next call.
    bool decode(const uint8_t *pkt, size_t len, PCMv4Header &h, std::string &err) {
        size_t off = 0;
        if (!_header.decode(pkt, len, h, off, err)) return false;

        // The packet declares its own profile; nothing here infers it from the
        // mode or the channel count. That keeps the choice a server-side policy
        // it can retune without breaking a deployed driver.
        if (!_codec.configure(h.profile, err)) return false;

        if ((size_t)h.sampleCount > _samples.size()) _samples.resize((size_t)h.sampleCount);

        if (h.silent) {
            if (off != len) {
                err = "pcm v4: silent packet carries a body";
                return false;
            }
            if (!_codec.advanceSilence(h.sampleCount, err)) return false;
            for (int i = 0; i < h.sampleCount; ++i) _samples[(size_t)i] = 0;
            return true;
        }

        return _codec.decodeBody(pkt + off, len - off, h.sampleCount, h.escape,
                                 &_samples[0], err);
    }

    // Valid until the next decode; h.sampleCount says how many.
    const int16_t *samples() const { return _samples.empty() ? 0 : &_samples[0]; }

private:
    static uint32_t readMagic(const uint8_t *p) {
        return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
               ((uint32_t)p[3] << 24);
    }

    PCMv4HeaderDecoder _header;
    PredictiveCodec _codec;
    std::vector<int16_t> _samples;
};

} // namespace ubersdr

#endif // UBERSDR_PCM_V4_HPP
