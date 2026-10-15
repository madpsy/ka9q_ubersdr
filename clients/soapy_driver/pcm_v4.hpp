// pcm_v4.hpp — decoder for UberSDR audio protocol version 4.
//
// Self-contained and header-only, so the driver stays the single translation
// unit CMakeLists.txt builds and the zip stays a short list of files somebody
// unpacks and compiles.
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

// The order-16 IQ block runs in SIMD registers: AVX2 on x86 (64-bit, and the
// 32-bit CW Skimmer DLL), chosen at run time (see ComplexStage::haveAVX2), so a
// build for any x86 uses it where the CPU has it; NEON on arm64, which every
// core has.
// Elsewhere, or with UBERSDR_PCMV4_NO_SIMD defined, the per-frame path runs
// with the same output.
#if !defined(UBERSDR_PCMV4_NO_SIMD)
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
#define UBERSDR_PCMV4_AVX2 1
#include <immintrin.h>
#if defined(_MSC_VER) && defined(__clang__)
// clang-cl's <immintrin.h> leaves out the SSE4.1 and AVX headers unless the
// whole build targets them, which a build for any x86-64 does not. Included
// directly, as simdjson does: their guard only asks that <immintrin.h> came
// first, and each intrinsic carries its own target, so they are usable from
// the AVX2-targeted kernel and nowhere else.
#include <smmintrin.h>
#include <avxintrin.h>
#include <avx2intrin.h>
#endif
#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
// MSVC compiles AVX2 intrinsics whatever /arch says; GCC and Clang (clang-cl
// included) need the function marked.
#define UBERSDR_PCMV4_TARGET_AVX2
#else
#define UBERSDR_PCMV4_TARGET_AVX2 __attribute__((target("avx2")))
#endif
#elif defined(__aarch64__) && defined(__ARM_NEON)
#define UBERSDR_PCMV4_NEON 1
#include <arm_neon.h>
#endif
#endif

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

// kProfileIQScaled is kProfileIQ with a reduced-depth front end, sent only to a
// device that asked for it with the min_margin argument. The predictor is
// identical, because the requantisation happens outside it: the server shifted
// the samples right before coding them, and the shift it used leads the body so
// this side shifts them back on the way out.
//
// A separate profile id rather than a flag, precisely so that a device which
// did not ask for the mode cannot be handed one by accident — an unknown
// profile is a hard error here, where an unrecognised flag bit might be ignored
// and the samples then delivered several bits too quiet.
static const uint8_t kProfileIQScaled = 2;

// The largest shift the wire format allows. Bounded because it comes off the
// wire like every other length here, and is applied to an int16.
static const unsigned kMaxShift = 15;

// Fixed-point scale of the filter taps: integers in Q16, so 65536 is a tap
// of 1.0.
static const unsigned kTapShift = 16;

// |tap| is bounded to 2^24, a real magnitude of 256. It caps the prediction sum
// far below int64 overflow whatever the input does. With the leak below holding
// the taps near their equilibrium the clamp is insurance that never fires in
// practice — but it must be applied identically on both sides, because if it
// ever does fire the two must agree.
static const int64_t kTapLimit = (int64_t)1 << 24;

// Leakage of the tap update: every adapt subtracts w/2^shift from a tap before
// adding the gradient step.
//
// Without it the taps have no restoring force and walk freely in any direction
// the input does not excite, which on a band whose energy sits in a few
// carriers is most of them. On a 909 kHz iq384 stream the server's taps walked
// until the coded stream was larger than the samples going into it. The two
// values differ because the complex filter and the real cascade are different
// filters on different signals; pcm_predictive.go on the server carries the
// measurements behind both.
//
// The arithmetic has to match the server's exactly or the two ends part company
// within a packet, and the trap here is C++'s >>: on a negative value it rounds
// towards negative infinity, so a tap of -1 would leak -1 rather than 0 and
// every negative tap would be dragged upwards. predLeak truncates the
// MAGNITUDE, which is what the server does.
static const unsigned kLeakShiftComplex = 14;
static const unsigned kLeakShiftReal = 16;

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

// The amount the leakage removes from one tap: the magnitude divided by
// 2^shift, truncated towards zero, so a tap smaller than 2^shift leaks nothing
// and small taps are not dragged to zero by rounding.
static inline int64_t predLeak(int64_t w, unsigned shift) {
    if (w < 0) {
        const uint64_t mag = (uint64_t)0 - (uint64_t)w; // |w|, no signed overflow
        return -(int64_t)(mag >> shift);
    }
    return (int64_t)((uint64_t)w >> shift);
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
        : _order(order), _mu(mu), _fast(false), _idx(order), _wide(false) {
        const int n = predHistoryLen(order);
        _wr.assign(order, 0);
        _wi.assign(order, 0);
        _hr.assign(n, 0);
        _hi.assign(n, 0);
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
        if (_wide) {
            _wideStage.beginPacket(steps);
            return;
        }
        int64_t maxAbs = 0;
        for (size_t j = 0; j < _wr.size(); ++j) {
            int64_t w = _wr[j] < 0 ? -(int64_t)_wr[j] : _wr[j];
            if (w > maxAbs) maxAbs = w;
        }
        for (size_t j = 0; j < _wi.size(); ++j) {
            int64_t w = _wi[j] < 0 ? -(int64_t)_wi[j] : _wi[j];
            if (w > maxAbs) maxAbs = w;
        }
        _fast = maxAbs + 2 * _mu * (int64_t)steps <= kTapLimit;
    }

    // Encoder direction: the residual for a known sample. The decoder needs it
    // to advance the filters across an escaped or silent packet exactly as the
    // encoder did.
    void forward(int64_t xr, int64_t xi, int64_t &er, int64_t &ei) {
        if (_wide) {
            _wideStage.forward(xr, xi, er, ei);
            return;
        }
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
        if (_wide) {
            _wideStage.inverse(er, ei, xr, xi);
            return;
        }
        int64_t pr, pi;
        predict(pr, pi);
        xr = er + pr;
        xi = ei + pi;
        adapt(er, ei);
        push(xr, xi);
    }

    // A whole packet of inverse() at once, for the order-16 filter every IQ
    // profile uses: taps and history stay in vector registers (AVX2, or NEON
    // on arm64) from the first frame to the last, the history window sliding
    // a lane a frame. Exactly inverse()'s arithmetic (see predict and adapt):
    // the products in int64 lanes, the update in int32 lanes, and the clamp
    // always applied, which the fast path may skip only because there it
    // changes nothing. False when this cannot run (another order, a stage gone
    // wide, neither instruction set): call inverse() per frame instead.
    bool inverseBlock(const int32_t *res, int16_t *out, int frames) {
        if (_order != 16 || _wide) return false;
#if defined(UBERSDR_PCMV4_AVX2)
        if (!haveAVX2()) return false;
        inverseBlockAVX2(res, out, frames);
        return true;
#elif defined(UBERSDR_PCMV4_NEON)
        inverseBlockNEON(res, out, frames);
        return true;
#else
        (void)res;
        (void)out;
        (void)frames;
        return false;
#endif
    }

#if defined(UBERSDR_PCMV4_AVX2)
    // Whether this CPU runs AVX2, asked once. The kernel below is compiled
    // for AVX2 whatever flags the build used -- a SoapySDR module or an SDR++
    // plugin is built for any x86-64 -- so it must not run on one without.
    //
    // Read straight from CPUID and XCR0 rather than __builtin_cpu_supports,
    // which needs a runtime library symbol clang-cl's Windows builds do not
    // link: leaf 7 present, AVX and OSXSAVE (leaf 1 ECX bits 28 and 27), the
    // OS saving YMM state (XCR0 bits 1 and 2), and AVX2 (leaf 7 EBX bit 5).
    static bool haveAVX2() {
        static const bool have = [] {
            unsigned r[4];
            cpuid(0, 0, r);
            if (r[0] < 7) return false;
            cpuid(1, 0, r);
            const unsigned osxsaveAVX = (1u << 27) | (1u << 28);
            if ((r[2] & osxsaveAVX) != osxsaveAVX) return false;
            if ((xcr0() & 6) != 6) return false;
            cpuid(7, 0, r);
            return (r[1] & (1u << 5)) != 0;
        }();
        return have;
    }

    static void cpuid(unsigned leaf, unsigned sub, unsigned r[4]) {
#if defined(_MSC_VER) && !defined(__clang__)
        int v[4];
        __cpuidex(v, (int)leaf, (int)sub);
        for (int i = 0; i < 4; ++i) r[i] = (unsigned)v[i];
#else
        __asm__ volatile("cpuid" : "=a"(r[0]), "=b"(r[1]), "=c"(r[2]), "=d"(r[3]) : "a"(leaf), "c"(sub));
#endif
    }

    // Only called once OSXSAVE is known set, so xgetbv cannot fault.
    static uint64_t xcr0() {
#if defined(_MSC_VER) && !defined(__clang__)
        return _xgetbv(0);
#else
        unsigned lo, hi;
        __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
        return ((uint64_t)hi << 32) | lo;
#endif
    }

    UBERSDR_PCMV4_TARGET_AVX2 void inverseBlockAVX2(const int32_t *res, int16_t *out, int frames) {
        const size_t lo = (size_t)(_idx - 16);
        __m256i hr0 = _mm256_loadu_si256((const __m256i *)&_hr[lo]);
        __m256i hr1 = _mm256_loadu_si256((const __m256i *)&_hr[lo + 8]);
        __m256i hi0 = _mm256_loadu_si256((const __m256i *)&_hi[lo]);
        __m256i hi1 = _mm256_loadu_si256((const __m256i *)&_hi[lo + 8]);
        __m256i wr0 = _mm256_loadu_si256((const __m256i *)&_wr[0]);
        __m256i wr1 = _mm256_loadu_si256((const __m256i *)&_wr[8]);
        __m256i wi0 = _mm256_loadu_si256((const __m256i *)&_wi[0]);
        __m256i wi1 = _mm256_loadu_si256((const __m256i *)&_wi[8]);
        const __m256i rot = _mm256_setr_epi32(1, 2, 3, 4, 5, 6, 7, 0);
        const __m256i lim = _mm256_set1_epi32((int32_t)kTapLimit);
        const __m256i nlim = _mm256_set1_epi32(-(int32_t)kTapLimit);
        const int64_t half = (int64_t)1 << (kTapShift - 1);
        int f = 0;
        for (; f < frames; ++f) {
            const int64_t er = res[2 * f], ei = res[2 * f + 1];

            // Even lanes multiply directly; the odd ones once shifted down.
            const __m256i wr0o = _mm256_srli_epi64(wr0, 32), wr1o = _mm256_srli_epi64(wr1, 32);
            const __m256i wi0o = _mm256_srli_epi64(wi0, 32), wi1o = _mm256_srli_epi64(wi1, 32);
            const __m256i hr0o = _mm256_srli_epi64(hr0, 32), hr1o = _mm256_srli_epi64(hr1, 32);
            const __m256i hi0o = _mm256_srli_epi64(hi0, 32), hi1o = _mm256_srli_epi64(hi1, 32);
            __m256i accR = _mm256_add_epi64(
                _mm256_add_epi64(_mm256_mul_epi32(wr0, hr0), _mm256_mul_epi32(wr0o, hr0o)),
                _mm256_add_epi64(_mm256_mul_epi32(wr1, hr1), _mm256_mul_epi32(wr1o, hr1o)));
            accR = _mm256_sub_epi64(accR, _mm256_add_epi64(
                _mm256_add_epi64(_mm256_mul_epi32(wi0, hi0), _mm256_mul_epi32(wi0o, hi0o)),
                _mm256_add_epi64(_mm256_mul_epi32(wi1, hi1), _mm256_mul_epi32(wi1o, hi1o))));
            __m256i accI = _mm256_add_epi64(
                _mm256_add_epi64(_mm256_mul_epi32(wr0, hi0), _mm256_mul_epi32(wr0o, hi0o)),
                _mm256_add_epi64(_mm256_mul_epi32(wr1, hi1), _mm256_mul_epi32(wr1o, hi1o)));
            accI = _mm256_add_epi64(accI, _mm256_add_epi64(
                _mm256_add_epi64(_mm256_mul_epi32(wi0, hr0), _mm256_mul_epi32(wi0o, hr0o)),
                _mm256_add_epi64(_mm256_mul_epi32(wi1, hr1), _mm256_mul_epi32(wi1o, hr1o))));
            const __m128i sR = _mm_add_epi64(_mm256_castsi256_si128(accR), _mm256_extracti128_si256(accR, 1));
            const __m128i sI = _mm_add_epi64(_mm256_castsi256_si128(accI), _mm256_extracti128_si256(accI, 1));
            const __m128i sum = _mm_add_epi64(_mm_unpacklo_epi64(sR, sI), _mm_unpackhi_epi64(sR, sI));
            // Through memory rather than _mm_cvtsi128_si64/_mm_extract_epi64,
            // which need 64-bit registers: the same header builds the 32-bit
            // CW Skimmer DLL, and on x86-64 the store costs nothing measurable.
            int64_t sums[2];
            _mm_storeu_si128((__m128i *)sums, sum);
            const int64_t pr = sums[0];
            const int64_t pi = sums[1];
            // predRoundShift without a branch: |v| rounded, its sign put back.
            const int64_t sgr = pr >> 63, sgi = pi >> 63;
            const int64_t qr = (int64_t)((((uint64_t)((pr ^ sgr) - sgr) + (uint64_t)half) >> kTapShift) ^ (uint64_t)sgr) - sgr;
            const int64_t qi = (int64_t)((((uint64_t)((pi ^ sgi) - sgi) + (uint64_t)half) >> kTapShift) ^ (uint64_t)sgi) - sgi;
            const int64_t xr = er + qr, xi = ei + qi;
            if (xr < INT32_MIN || xr > INT32_MAX || xi < INT32_MIN || xi > INT32_MAX) break;

            if (er != 0 || ei != 0) {
                const __m256i mr = _mm256_set1_epi32((int32_t)(_mu * predSign(er)));
                const __m256i mi = _mm256_set1_epi32((int32_t)(_mu * predSign(ei)));
#define UBERSDR_ADAPT(wr, wi, hr, hi)                                                                  \
                {                                                                                      \
                    const __m256i lr = _mm256_sign_epi32(                                              \
                        _mm256_srli_epi32(_mm256_abs_epi32(wr), kLeakShiftComplex), wr);               \
                    const __m256i li = _mm256_sign_epi32(                                              \
                        _mm256_srli_epi32(_mm256_abs_epi32(wi), kLeakShiftComplex), wi);               \
                    const __m256i nr = _mm256_sub_epi32(_mm256_add_epi32(wr, _mm256_add_epi32(         \
                        _mm256_sign_epi32(mr, hr), _mm256_sign_epi32(mi, hi))), lr);                   \
                    const __m256i ni = _mm256_sub_epi32(_mm256_add_epi32(wi, _mm256_sub_epi32(         \
                        _mm256_sign_epi32(mi, hr), _mm256_sign_epi32(mr, hi))), li);                   \
                    wr = _mm256_max_epi32(_mm256_min_epi32(nr, lim), nlim);                            \
                    wi = _mm256_max_epi32(_mm256_min_epi32(ni, lim), nlim);                            \
                }
                UBERSDR_ADAPT(wr0, wi0, hr0, hi0)
                UBERSDR_ADAPT(wr1, wi1, hr1, hi1)
#undef UBERSDR_ADAPT
            }

            out[2 * f] = (int16_t)xr;
            out[2 * f + 1] = (int16_t)xi;
            // Slide the window a lane: the oldest out, this frame in at the top.
            const __m256i r0 = _mm256_permutevar8x32_epi32(hr0, rot), r1 = _mm256_permutevar8x32_epi32(hr1, rot);
            const __m256i i0 = _mm256_permutevar8x32_epi32(hi0, rot), i1 = _mm256_permutevar8x32_epi32(hi1, rot);
            hr0 = _mm256_blend_epi32(r0, r1, 0x80);
            hi0 = _mm256_blend_epi32(i0, i1, 0x80);
            hr1 = _mm256_blend_epi32(r1, _mm256_set1_epi32((int32_t)xr), 0x80);
            hi1 = _mm256_blend_epi32(i1, _mm256_set1_epi32((int32_t)xi), 0x80);
        }
        _mm256_storeu_si256((__m256i *)&_wr[0], wr0);
        _mm256_storeu_si256((__m256i *)&_wr[8], wr1);
        _mm256_storeu_si256((__m256i *)&_wi[0], wi0);
        _mm256_storeu_si256((__m256i *)&_wi[8], wi1);
        _mm256_storeu_si256((__m256i *)&_hr[0], hr0);
        _mm256_storeu_si256((__m256i *)&_hr[8], hr1);
        _mm256_storeu_si256((__m256i *)&_hi[0], hi0);
        _mm256_storeu_si256((__m256i *)&_hi[8], hi1);
        _idx = 16;
        // A sample past int32 (never, from int16 samples): the rest frame by
        // frame, which takes this one again from its prediction and goes wide.
        for (; f < frames; ++f) {
            int64_t xr, xi;
            inverse(res[2 * f], res[2 * f + 1], xr, xi);
            out[2 * f] = (int16_t)xr;
            out[2 * f + 1] = (int16_t)xi;
        }
    }
#endif

#if defined(UBERSDR_PCMV4_NEON)
    void inverseBlockNEON(const int32_t *res, int16_t *out, int frames) {
        const size_t lo = (size_t)(_idx - 16);
        int32x4_t hr[4], hi[4], wr[4], wi[4];
        for (int k = 0; k < 4; ++k) {
            hr[k] = vld1q_s32(&_hr[lo + 4 * (size_t)k]);
            hi[k] = vld1q_s32(&_hi[lo + 4 * (size_t)k]);
            wr[k] = vld1q_s32(&_wr[4 * (size_t)k]);
            wi[k] = vld1q_s32(&_wi[4 * (size_t)k]);
        }
        const int32x4_t lim = vdupq_n_s32((int32_t)kTapLimit);
        const int32x4_t nlim = vdupq_n_s32(-(int32_t)kTapLimit);
        const uint64_t half = (uint64_t)1 << (kTapShift - 1);
        int f = 0;
        for (; f < frames; ++f) {
            const int64_t er = res[2 * f], ei = res[2 * f + 1];

            // Two accumulators a part, each a pair of int64 lanes, so the
            // multiply-accumulates are not all one chain.
            int64x2_t ar0 = vmull_s32(vget_low_s32(wr[0]), vget_low_s32(hr[0]));
            int64x2_t ar1 = vmull_high_s32(wr[0], hr[0]);
            int64x2_t ai0 = vmull_s32(vget_low_s32(wr[0]), vget_low_s32(hi[0]));
            int64x2_t ai1 = vmull_high_s32(wr[0], hi[0]);
            ar0 = vmlsl_s32(ar0, vget_low_s32(wi[0]), vget_low_s32(hi[0]));
            ar1 = vmlsl_high_s32(ar1, wi[0], hi[0]);
            ai0 = vmlal_s32(ai0, vget_low_s32(wi[0]), vget_low_s32(hr[0]));
            ai1 = vmlal_high_s32(ai1, wi[0], hr[0]);
            for (int k = 1; k < 4; ++k) {
                ar0 = vmlal_s32(ar0, vget_low_s32(wr[k]), vget_low_s32(hr[k]));
                ar1 = vmlal_high_s32(ar1, wr[k], hr[k]);
                ai0 = vmlal_s32(ai0, vget_low_s32(wr[k]), vget_low_s32(hi[k]));
                ai1 = vmlal_high_s32(ai1, wr[k], hi[k]);
                ar0 = vmlsl_s32(ar0, vget_low_s32(wi[k]), vget_low_s32(hi[k]));
                ar1 = vmlsl_high_s32(ar1, wi[k], hi[k]);
                ai0 = vmlal_s32(ai0, vget_low_s32(wi[k]), vget_low_s32(hr[k]));
                ai1 = vmlal_high_s32(ai1, wi[k], hr[k]);
            }
            const int64_t pr = vaddvq_s64(vaddq_s64(ar0, ar1));
            const int64_t pi = vaddvq_s64(vaddq_s64(ai0, ai1));
            // predRoundShift without a branch: |v| rounded, its sign put back.
            const uint64_t sgr = (uint64_t)(pr >> 63), sgi = (uint64_t)(pi >> 63);
            const int64_t qr = (int64_t)((((((uint64_t)pr ^ sgr) - sgr) + half) >> kTapShift ^ sgr) - sgr);
            const int64_t qi = (int64_t)((((((uint64_t)pi ^ sgi) - sgi) + half) >> kTapShift ^ sgi) - sgi);
            const int64_t xr = er + qr, xi = ei + qi;
            if (xr < INT32_MIN || xr > INT32_MAX || xi < INT32_MIN || xi > INT32_MAX) break;

            if (er != 0 || ei != 0) {
                const int32_t mr = (int32_t)(_mu * predSign(er));
                const int32_t mi = (int32_t)(_mu * predSign(ei));
                for (int k = 0; k < 4; ++k) {
                    // Signs as -1/0/+1: the (h < 0) mask less the (h > 0) mask.
                    const int32x4_t sr = vsubq_s32(vreinterpretq_s32_u32(vcltzq_s32(hr[k])),
                                                   vreinterpretq_s32_u32(vcgtzq_s32(hr[k])));
                    const int32x4_t si = vsubq_s32(vreinterpretq_s32_u32(vcltzq_s32(hi[k])),
                                                   vreinterpretq_s32_u32(vcgtzq_s32(hi[k])));
                    // predLeak: |w| >> shift with w's sign put back.
                    const int32x4_t gr = vshrq_n_s32(wr[k], 31), gi = vshrq_n_s32(wi[k], 31);
                    const int32x4_t lr = vsubq_s32(veorq_s32(vshrq_n_s32(vabsq_s32(wr[k]), kLeakShiftComplex), gr), gr);
                    const int32x4_t li = vsubq_s32(veorq_s32(vshrq_n_s32(vabsq_s32(wi[k]), kLeakShiftComplex), gi), gi);
                    const int32x4_t nr = vsubq_s32(vmlaq_n_s32(vmlaq_n_s32(wr[k], sr, mr), si, mi), lr);
                    const int32x4_t ni = vsubq_s32(vmlsq_n_s32(vmlaq_n_s32(wi[k], sr, mi), si, mr), li);
                    wr[k] = vmaxq_s32(vminq_s32(nr, lim), nlim);
                    wi[k] = vmaxq_s32(vminq_s32(ni, lim), nlim);
                }
            }

            out[2 * f] = (int16_t)xr;
            out[2 * f + 1] = (int16_t)xi;
            // Slide the window a lane: the oldest out, this frame in at the top.
            hr[0] = vextq_s32(hr[0], hr[1], 1);
            hr[1] = vextq_s32(hr[1], hr[2], 1);
            hr[2] = vextq_s32(hr[2], hr[3], 1);
            hr[3] = vextq_s32(hr[3], vdupq_n_s32((int32_t)xr), 1);
            hi[0] = vextq_s32(hi[0], hi[1], 1);
            hi[1] = vextq_s32(hi[1], hi[2], 1);
            hi[2] = vextq_s32(hi[2], hi[3], 1);
            hi[3] = vextq_s32(hi[3], vdupq_n_s32((int32_t)xi), 1);
        }
        for (int k = 0; k < 4; ++k) {
            vst1q_s32(&_wr[4 * (size_t)k], wr[k]);
            vst1q_s32(&_wi[4 * (size_t)k], wi[k]);
            vst1q_s32(&_hr[4 * (size_t)k], hr[k]);
            vst1q_s32(&_hi[4 * (size_t)k], hi[k]);
        }
        _idx = 16;
        for (; f < frames; ++f) {
            int64_t xr, xi;
            inverse(res[2 * f], res[2 * f + 1], xr, xi);
            out[2 * f] = (int16_t)xr;
            out[2 * f + 1] = (int16_t)xi;
        }
    }
#endif

private:
    // The same filter in int64 throughout, as the server writes it: what this
    // stage becomes for good if a sample ever leaves int32 (see push). A stream
    // the server coded from int16 samples never gets there.
    class Wide {
    public:
        void load(int order, int64_t mu, bool fast, int idx, const std::vector<int32_t> &wr,
                  const std::vector<int32_t> &wi, const std::vector<int32_t> &hr,
                  const std::vector<int32_t> &hi) {
            _order = order;
            _mu = mu;
            _fast = fast;
            _idx = idx;
            _wr.assign(wr.begin(), wr.end());
            _wi.assign(wi.begin(), wi.end());
            _hr.assign(hr.begin(), hr.end());
            _hi.assign(hi.begin(), hi.end());
            _sr.resize(_hr.size());
            _si.resize(_hi.size());
            for (size_t j = 0; j < _hr.size(); ++j) {
                _sr[j] = predSign(_hr[j]);
                _si[j] = predSign(_hi[j]);
            }
        }

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

        void forward(int64_t xr, int64_t xi, int64_t &er, int64_t &ei) {
            int64_t pr, pi;
            predict(pr, pi);
            er = xr - pr;
            ei = xi - pi;
            adapt(er, ei);
            push(xr, xi);
        }

        void inverse(int64_t er, int64_t ei, int64_t &xr, int64_t &xi) {
            int64_t pr, pi;
            predict(pr, pi);
            xr = er + pr;
            xi = ei + pi;
            adapt(er, ei);
            push(xr, xi);
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

    private:
        void predict(int64_t &outR, int64_t &outI) const {
            const int order = _order;
            const int lo = _idx - order;
            // Summed through uint64_t: a corrupt stream can push these past
            // int64, where signed overflow is undefined in C++. Unsigned wraps,
            // which is what the server's Go arithmetic does and what the
            // compiler produced in practice anyway.
            uint64_t pr = 0, pi = 0;
            for (int j = 0; j < order; ++j) {
                const int64_t br = _hr[lo + j], bi = _hi[lo + j];
                const int64_t w = _wr[j], wiv = _wi[j];
                pr += (uint64_t)w * (uint64_t)br - (uint64_t)wiv * (uint64_t)bi;
                pi += (uint64_t)w * (uint64_t)bi + (uint64_t)wiv * (uint64_t)br;
            }
            outR = predRoundShift((int64_t)pr, kTapShift);
            outI = predRoundShift((int64_t)pi, kTapShift);
        }

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
                    _wr[j] += mr * hrs - mi * his - predLeak(_wr[j], kLeakShiftComplex);
                    _wi[j] += mr * his + mi * hrs - predLeak(_wi[j], kLeakShiftComplex);
                }
                return;
            }
            for (int j = 0; j < order; ++j) {
                const int64_t hrs = _sr[lo + j];
                const int64_t his = -_si[lo + j];
                _wr[j] = predClampTap(_wr[j] + mr * hrs - mi * his -
                                      predLeak(_wr[j], kLeakShiftComplex));
                _wi[j] = predClampTap(_wi[j] + mr * his + mi * hrs -
                                      predLeak(_wi[j], kLeakShiftComplex));
            }
        }

        int _order = 0;
        int64_t _mu = 0;
        bool _fast = false;
        int _idx = 0;
        std::vector<int64_t> _wr, _wi, _hr, _hi, _sr, _si;
    };

    // The prediction sum, exact in int64: a tap is within 2^24 and a sample
    // within int32, so each product is under 2^55 and the 2*order of them
    // under 2^60. Integer sums do not depend on their order, which leaves the
    // compiler free to run the taps in vector lanes.
    void predict(int64_t &outR, int64_t &outI) const {
        const int order = _order;
        const int32_t *hr = &_hr[(size_t)(_idx - order)];
        const int32_t *hi = &_hi[(size_t)(_idx - order)];
        const int32_t *wr = &_wr[0];
        const int32_t *wi = &_wi[0];
        int64_t pr = 0, pi = 0;
        for (int j = 0; j < order; ++j) {
            pr += (int64_t)wr[j] * hr[j] - (int64_t)wi[j] * hi[j];
            pi += (int64_t)wr[j] * hi[j] + (int64_t)wi[j] * hr[j];
        }
        outR = predRoundShift(pr, kTapShift);
        outI = predRoundShift(pi, kTapShift);
    }

    // The server's update in int32, every value as its int64 one: a tap never
    // leaves +-kTapLimit (clamped, or the fast path's bound), and a step is at
    // most 2*mu. Leak kLeakShiftComplex off each tap, then nudge it by mu in
    // the direction that would have reduced this error, against the conjugate
    // of the history: with s the history's signs,
    //   wr += mr*sr + mi*si,  wi += mi*sr - mr*si.
    //
    // A zero error is a genuine no-op — both steps are zero and every tap is
    // already inside the clamp — which turns the adapt pass over silence into a
    // return.
    void adapt(int64_t er, int64_t ei) {
        if (er == 0 && ei == 0) return;
        const int32_t mr = (int32_t)(_mu * predSign(er));
        const int32_t mi = (int32_t)(_mu * predSign(ei));
        const int order = _order;
        const int32_t *hr = &_hr[(size_t)(_idx - order)];
        const int32_t *hi = &_hi[(size_t)(_idx - order)];
        int32_t *wr = &_wr[0];
        int32_t *wi = &_wi[0];
        const int32_t lim = (int32_t)kTapLimit;
        if (_fast) {
            for (int j = 0; j < order; ++j) {
                const int32_t sr = (hr[j] > 0) - (hr[j] < 0);
                const int32_t si = (hi[j] > 0) - (hi[j] < 0);
                const int32_t r = wr[j], i = wi[j];
                wr[j] = r + mr * sr + mi * si - leak(r);
                wi[j] = i + mi * sr - mr * si - leak(i);
            }
            return;
        }
        for (int j = 0; j < order; ++j) {
            const int32_t sr = (hr[j] > 0) - (hr[j] < 0);
            const int32_t si = (hi[j] > 0) - (hi[j] < 0);
            const int32_t r = wr[j], i = wi[j];
            const int32_t nr = r + mr * sr + mi * si - leak(r);
            const int32_t ni = i + mi * sr - mr * si - leak(i);
            wr[j] = nr > lim ? lim : (nr < -lim ? -lim : nr);
            wi[j] = ni > lim ? lim : (ni < -lim ? -lim : ni);
        }
    }

    // predLeak in int32 without a branch: the magnitude shifted, its sign put
    // back. |w| <= kTapLimit, so the negation cannot overflow.
    static inline int32_t leak(int32_t w) {
        const int32_t s = w >> 31; // 0 or -1 (arithmetic on every target here)
        return (int32_t)((((w ^ s) - s) >> kLeakShiftComplex) ^ s) - s;
    }

    void push(int64_t xr, int64_t xi) {
        if (xr < INT32_MIN || xr > INT32_MAX || xi < INT32_MIN || xi > INT32_MAX) {
            // Out of int32: carry on in int64 from here, exactly as before.
            _wide = true;
            _wideStage.load(_order, _mu, _fast, _idx, _wr, _wi, _hr, _hi);
            _wideStage.push(xr, xi);
            return;
        }
        _hr[(size_t)_idx] = (int32_t)xr;
        _hi[(size_t)_idx] = (int32_t)xi;
        ++_idx;
        if (_idx == (int)_hr.size()) {
            const int n = _order;
            for (int j = 0; j < n; ++j) {
                _hr[(size_t)j] = _hr[(size_t)(_idx - n + j)];
                _hi[(size_t)j] = _hi[(size_t)(_idx - n + j)];
            }
            _idx = n;
        }
    }

    int _order;
    int64_t _mu;
    bool _fast;
    int _idx;
    bool _wide;
    // Taps in Q16, oldest-first: _wr[j] weighs the history sample at
    // _hr[_idx-order+j], so predict and adapt walk taps and history forward
    // together. int32, which holds every value a stream coded from int16
    // samples produces; _wideStage takes over if one ever does not fit.
    std::vector<int32_t> _wr, _wi, _hr, _hi;
    Wide _wideStage;
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
        // Summed through uint64_t; see the complex form.
        uint64_t p = 0;
        for (int j = 0; j < order; ++j) p += (uint64_t)_w[j] * (uint64_t)_h[lo + j];
        return predRoundShift((int64_t)p, kTapShift);
    }

    void adapt(int64_t e) {
        if (e == 0) return;
        const int64_t m = _mu * predSign(e);
        const int order = _order;
        const int lo = _idx - order;
        if (_fast) {
            for (int j = 0; j < order; ++j)
                _w[j] += m * _s[lo + j] - predLeak(_w[j], kLeakShiftReal);
            return;
        }
        for (int j = 0; j < order; ++j)
            _w[j] = predClampTap(_w[j] + m * _s[lo + j] - predLeak(_w[j], kLeakShiftReal));
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
    uint8_t shift;   // reduced-depth left shift already applied to the samples,
                     // and 0 on every lossless packet
    bool escape; // the body holds verbatim samples
    bool silent; // every sample is zero and no body was transmitted

    PCMv4Header()
        : timestampNanos(0), sampleRate(0), channels(0), sampleCount(0),
          basebandPower(-999.0f), noise(-999.0f), profile(0), shift(0),
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
        case kProfileIQScaled:
            // A single complex filter of order 16. Deeper cascades were
            // measured and rejected for IQ: 8/8/4/2 gave 1.391x against this
            // profile's 1.396x at roughly double the CPU.
            //
            // The scaled profile shares this predictor exactly: the
            // requantisation it names happens before the server's filters and
            // after this decoder's, so nothing inside them differs. Only the
            // shift byte in front of the body, and the shift back on the way
            // out, do.
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
            if (_cx.size() == 1 && _cx[0].inverseBlock(&_res[0], out, count / 2)) return true;
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

        // The shift leads the body on a scaled packet: the header's flags byte
        // is full, and a silent packet has no body at all, so putting it here
        // costs nothing on a squelched or dead channel. Read here rather than in
        // the header decoder because it is part of the payload, exactly as the
        // server writes it.
        unsigned shift = 0;
        if (h.profile == kProfileIQScaled) {
            if (len <= off) {
                err = "pcm v4: scaled packet carries no shift";
                return false;
            }
            shift = pkt[off];
            if (shift > kMaxShift) {
                err = "pcm v4: shift out of range";
                return false;
            }
            h.shift = (uint8_t)shift;
            ++off;
        }

        if (!_codec.decodeBody(pkt + off, len - off, h.sampleCount, h.escape,
                               &_samples[0], err))
            return false;

        // Undone only on the way out. The predictor ran on the quantised
        // values, exactly as the server's did — and an escape carries the
        // quantised samples too — so this is the last thing that happens to a
        // packet and no codec state depends on it.
        lossyRestore(&_samples[0], h.sampleCount, shift);
        return true;
    }

    // Valid until the next decode; h.sampleCount says how many.
    const int16_t *samples() const { return _samples.empty() ? 0 : &_samples[0]; }

private:
    // Undo the reduced-depth scale, saturating rather than wrapping: a value the
    // shift carries past full scale must not come back with its sign inverted.
    // Matches the server's lossyRestore in pcm_lossy.go.
    //
    // A multiply rather than a shift, because C++ leaves a left shift of a
    // negative value undefined and half of these samples are negative.
    // Multiplying by the same power of two is exactly the shift, defined for
    // every input, and the product cannot leave int64 for any int16 and a shift
    // of 15.
    static void lossyRestore(int16_t *samples, int count, unsigned shift) {
        if (shift == 0) return;
        const int64_t scale = (int64_t)1 << shift;
        for (int i = 0; i < count; ++i) {
            int64_t r = (int64_t)samples[i] * scale;
            if (r > 32767) r = 32767;
            else if (r < -32768) r = -32768;
            samples[i] = (int16_t)r;
        }
    }

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
