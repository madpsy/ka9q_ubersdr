/*
 * pcm_v4_native.c - the predictive codec half of pcm_v4.py, in C.
 *
 * pcm_v4.py decodes version 4 payloads at interpreter speed, which its own
 * cost note puts at ~70-85 k IQ frames/s: short of iq96 and far short of
 * iq384. Worse than falling behind, the decode thread then holds the GIL
 * almost continuously, so a GUI in the same process -- the IQ recorder's Tk
 * spectrum and its audio preview -- starves with it. This library does the
 * same work in C, and ctypes releases the GIL for the length of every call.
 *
 * Only the payload codec lives here. Headers stay in Python: they cost a few
 * microseconds per packet and carry state the Python side already owns.
 *
 * The arithmetic is clients/soapy_driver/pcm_v4.hpp's, transcribed; see that
 * file and pcm_v4.py for why each detail is the way it is. It must stay bit
 * exact with the server's pcm_predictive.go, and test_pcm_v4.py checks it
 * against the same server-produced fixture as the other ports.
 *
 * Build (build.sh in python_iq_recorder does this):
 *   gcc -O2 -shared -fPIC -o pcm_v4_native.so pcm_v4_native.c
 *   x86_64-w64-mingw32-gcc -O2 -shared -static-libgcc -o pcm_v4_native.dll pcm_v4_native.c
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* The order-16 IQ block (cx_inverse_block16) runs in SIMD registers: AVX2 on
 * x86-64, chosen at run time so the .so and .dll built for any x86-64 use it
 * where the CPU has it; NEON on arm64, which every core has. Elsewhere, or
 * with PCMV4_NO_SIMD defined, every frame takes the per-frame loop, with the
 * same output. */
#if !defined(PCMV4_NO_SIMD)
#if defined(__x86_64__) || defined(_M_X64)
#define NATIVE_AVX2 1
#include <immintrin.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
#define NATIVE_TARGET_AVX2
#else
#define NATIVE_TARGET_AVX2 __attribute__((target("avx2")))
#endif
#elif defined(__aarch64__) && defined(__ARM_NEON)
#define NATIVE_NEON 1
#include <arm_neon.h>
#endif
#endif

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

/* Bumped whenever the exported signatures change, so a stale library next to
 * a newer pcm_v4.py is refused rather than called with the wrong arguments. */
#define PCMV4_NATIVE_ABI 2

#define TAP_SHIFT 16
#define TAP_LIMIT ((int64_t)1 << 24)
#define LEAK_SHIFT_COMPLEX 14
#define LEAK_SHIFT_REAL 16

#define PROFILE_IQ 0
#define PROFILE_AUDIO 1
/* The same predictor as PROFILE_IQ; the reduced-depth shift is applied outside it. */
#define PROFILE_IQ_SCALED 2

#define MAX_STAGES 4

/* Error codes; pcm_v4.py maps them to messages. */
#define ERR_OK 0
#define ERR_BAD_COUNT -1
#define ERR_ESCAPE_TRUNCATED -2
#define ERR_EMPTY -3
#define ERR_RICE_K -4
#define ERR_RICE_TRUNCATED -5
#define ERR_RICE_REMAINDER -6
#define ERR_NOMEM -7

static inline int64_t sign64(int64_t v) { return (int64_t)(v > 0) - (int64_t)(v < 0); }

static inline int64_t round_shift(int64_t v) {
    const uint64_t half = (uint64_t)1 << (TAP_SHIFT - 1);
    if (v < 0) {
        const uint64_t mag = (uint64_t)0 - (uint64_t)v;
        return -(int64_t)((mag + half) >> TAP_SHIFT);
    }
    return (int64_t)(((uint64_t)v + half) >> TAP_SHIFT);
}

static inline int64_t leak(int64_t w, unsigned shift) {
    if (w < 0) {
        const uint64_t mag = (uint64_t)0 - (uint64_t)w;
        return -(int64_t)(mag >> shift);
    }
    return (int64_t)((uint64_t)w >> shift);
}

static inline int64_t clamp_tap(int64_t w) {
    if (w > TAP_LIMIT) return TAP_LIMIT;
    if (w < -TAP_LIMIT) return -TAP_LIMIT;
    return w;
}

static inline unsigned trailing_zeros64(uint64_t x) {
    if (x == 0) return 64;
#if defined(__GNUC__) || defined(__clang__)
    return (unsigned)__builtin_ctzll(x);
#else
    unsigned n = 0;
    while ((x & 1) == 0) { x >>= 1; ++n; }
    return n;
#endif
}

static inline int history_len(int order) {
    int n = order * 8;
    return n < 64 ? 64 : n;
}

/* One adaptive filter. A complex stage uses all six arrays, a real one only
 * wr (taps), hr (history) and sr (history signs). */
typedef struct {
    int order;
    int64_t mu;
    int fast;
    int idx;
    int hlen;
    int64_t *wr, *wi, *hr, *hi, *sr, *si;
} stage_t;

typedef struct {
    int profile;
    int complex;
    int nstages;
    stage_t st[MAX_STAGES];
    int32_t *res;
    size_t res_cap;
} codec_t;

static int stage_init(stage_t *s, int order, int64_t mu) {
    s->order = order;
    s->mu = mu;
    s->fast = 0;
    s->idx = order;
    s->hlen = history_len(order);
    s->wr = calloc((size_t)order, sizeof(int64_t));
    s->wi = calloc((size_t)order, sizeof(int64_t));
    s->hr = calloc((size_t)s->hlen, sizeof(int64_t));
    s->hi = calloc((size_t)s->hlen, sizeof(int64_t));
    s->sr = calloc((size_t)s->hlen, sizeof(int64_t));
    s->si = calloc((size_t)s->hlen, sizeof(int64_t));
    return s->wr && s->wi && s->hr && s->hi && s->sr && s->si;
}

static void stage_free(stage_t *s) {
    free(s->wr); free(s->wi); free(s->hr); free(s->hi); free(s->sr); free(s->si);
}

/* ---- complex stage ---- */

static void cx_begin(stage_t *s, int steps) {
    int64_t max_abs = 0;
    for (int j = 0; j < s->order; ++j) {
        int64_t a = s->wr[j] < 0 ? -s->wr[j] : s->wr[j];
        if (a > max_abs) max_abs = a;
        a = s->wi[j] < 0 ? -s->wi[j] : s->wi[j];
        if (a > max_abs) max_abs = a;
    }
    s->fast = max_abs + 2 * s->mu * (int64_t)steps <= TAP_LIMIT;
}

static inline void cx_predict(const stage_t *s, int64_t *outr, int64_t *outi) {
    const int order = s->order, lo = s->idx - order;
    const int64_t *hr = s->hr + lo, *hi = s->hi + lo;
    /* Summed through uint64_t: a corrupt stream can push these past int64,
     * where signed overflow is undefined in C. Unsigned wraps, which is what
     * the server's Go arithmetic does and what the compiler produced anyway. */
    uint64_t pr = 0, pi = 0;
    for (int j = 0; j < order; ++j) {
        const int64_t br = hr[j], bi = hi[j], w = s->wr[j], v = s->wi[j];
        pr += (uint64_t)w * (uint64_t)br - (uint64_t)v * (uint64_t)bi;
        pi += (uint64_t)w * (uint64_t)bi + (uint64_t)v * (uint64_t)br;
    }
    *outr = round_shift((int64_t)pr);
    *outi = round_shift((int64_t)pi);
}

static inline void cx_adapt(stage_t *s, int64_t er, int64_t ei) {
    if (er == 0 && ei == 0) return;
    const int64_t mr = s->mu * sign64(er), mi = s->mu * sign64(ei);
    const int order = s->order, lo = s->idx - order;
    const int64_t *sr = s->sr + lo, *si = s->si + lo;
    int64_t *wr = s->wr, *wi = s->wi;
    if (s->fast) {
        for (int j = 0; j < order; ++j) {
            const int64_t hrs = sr[j], his = -si[j];
            wr[j] += mr * hrs - mi * his - leak(wr[j], LEAK_SHIFT_COMPLEX);
            wi[j] += mr * his + mi * hrs - leak(wi[j], LEAK_SHIFT_COMPLEX);
        }
        return;
    }
    for (int j = 0; j < order; ++j) {
        const int64_t hrs = sr[j], his = -si[j];
        wr[j] = clamp_tap(wr[j] + mr * hrs - mi * his - leak(wr[j], LEAK_SHIFT_COMPLEX));
        wi[j] = clamp_tap(wi[j] + mr * his + mi * hrs - leak(wi[j], LEAK_SHIFT_COMPLEX));
    }
}

static inline void cx_push(stage_t *s, int64_t xr, int64_t xi) {
    s->hr[s->idx] = xr;
    s->hi[s->idx] = xi;
    s->sr[s->idx] = sign64(xr);
    s->si[s->idx] = sign64(xi);
    if (++s->idx == s->hlen) {
        const int n = s->order, from = s->idx - n;
        memmove(s->hr, s->hr + from, (size_t)n * sizeof(int64_t));
        memmove(s->hi, s->hi + from, (size_t)n * sizeof(int64_t));
        memmove(s->sr, s->sr + from, (size_t)n * sizeof(int64_t));
        memmove(s->si, s->si + from, (size_t)n * sizeof(int64_t));
        s->idx = n;
    }
}

/* ---- real stage ---- */

static void rl_begin(stage_t *s, int steps) {
    int64_t max_abs = 0;
    for (int j = 0; j < s->order; ++j) {
        int64_t a = s->wr[j] < 0 ? -s->wr[j] : s->wr[j];
        if (a > max_abs) max_abs = a;
    }
    s->fast = max_abs + s->mu * (int64_t)steps <= TAP_LIMIT;
}

static inline int64_t rl_predict(const stage_t *s) {
    const int order = s->order, lo = s->idx - order;
    uint64_t p = 0; /* wraps rather than overflows; see cx_predict */
    for (int j = 0; j < order; ++j) p += (uint64_t)s->wr[j] * (uint64_t)s->hr[lo + j];
    return round_shift((int64_t)p);
}

static inline void rl_adapt(stage_t *s, int64_t e) {
    if (e == 0) return;
    const int64_t m = s->mu * sign64(e);
    const int order = s->order, lo = s->idx - order;
    if (s->fast) {
        for (int j = 0; j < order; ++j)
            s->wr[j] += m * s->sr[lo + j] - leak(s->wr[j], LEAK_SHIFT_REAL);
        return;
    }
    for (int j = 0; j < order; ++j)
        s->wr[j] = clamp_tap(s->wr[j] + m * s->sr[lo + j] - leak(s->wr[j], LEAK_SHIFT_REAL));
}

static inline void rl_push(stage_t *s, int64_t x) {
    s->hr[s->idx] = x;
    s->sr[s->idx] = sign64(x);
    if (++s->idx == s->hlen) {
        const int n = s->order, from = s->idx - n;
        memmove(s->hr, s->hr + from, (size_t)n * sizeof(int64_t));
        memmove(s->sr, s->sr + from, (size_t)n * sizeof(int64_t));
        s->idx = n;
    }
}

/* ---- cascade ---- */

static void codec_begin(codec_t *c, int steps) {
    for (int s = 0; s < c->nstages; ++s) {
        if (c->complex) cx_begin(&c->st[s], steps);
        else rl_begin(&c->st[s], steps);
    }
}

/* The encoder direction over one sample position, for escaped and silent
 * packets whose samples are already known. */
static inline void codec_forward(codec_t *c, int64_t a, int64_t b) {
    if (c->complex) {
        for (int s = 0; s < c->nstages; ++s) {
            stage_t *st = &c->st[s];
            int64_t pr, pi;
            cx_predict(st, &pr, &pi);
            const int64_t er = a - pr, ei = b - pi;
            cx_adapt(st, er, ei);
            cx_push(st, a, b);
            a = er;
            b = ei;
        }
        return;
    }
    for (int s = 0; s < c->nstages; ++s) {
        stage_t *st = &c->st[s];
        const int64_t e = a - rl_predict(st);
        rl_adapt(st, e);
        rl_push(st, a);
        a = e;
    }
}

/* ------------------------------------------------------------------------- */
/* The order-16 IQ block                                                     */
/* ------------------------------------------------------------------------- */

/*
 * A whole packet at once for the order-16 complex stage every IQ profile uses,
 * with the taps and the 16-sample history window in SIMD registers from the
 * first frame to the last -- the server's encoder and the other clients'
 * decoders do the same. Exactly the per-frame loop's arithmetic (cx_predict,
 * cx_adapt, cx_push): the products in int64 lanes, the sign-sign update and
 * leak in int32 lanes, and the clamp always applied, which where the scalar
 * code skips it is an identity.
 *
 * int32 holds every value: a tap never leaves +-TAP_LIMIT (2^24), and the
 * history of a single stage is the int16 samples themselves. Only a corrupt
 * stream gets a sample past int32; the block is not used while one is in the
 * window, and stops before taking one in, leaving the rest to the per-frame
 * loop.
 */
#if defined(NATIVE_AVX2) || defined(NATIVE_NEON)

struct cx16_state {
    int32_t wr[16], wi[16];
    int32_t hr[16], hi[16];
};

static int cx16_load(const stage_t *f, struct cx16_state *st)
{
    const int lo = f->idx - 16;
    for (int j = 0; j < 16; j++) {
        const int64_t r = f->hr[lo + j], i = f->hi[lo + j];
        if (r != (int32_t)r || i != (int32_t)i) return 0;
        st->wr[j] = (int32_t)f->wr[j];
        st->wi[j] = (int32_t)f->wi[j];
        st->hr[j] = (int32_t)r;
        st->hi[j] = (int32_t)i;
    }
    return 1;
}

/* The window goes back at the front of the history. */
static void cx16_store(stage_t *f, const struct cx16_state *st)
{
    for (int j = 0; j < 16; j++) {
        f->wr[j] = st->wr[j];
        f->wi[j] = st->wi[j];
        f->hr[j] = st->hr[j];
        f->hi[j] = st->hi[j];
        f->sr[j] = sign64(st->hr[j]);
        f->si[j] = sign64(st->hi[j]);
    }
    f->idx = 16;
}

#endif

#if defined(NATIVE_AVX2)

/* Whether this CPU runs AVX2, asked once. The kernel below is compiled for
 * AVX2 whatever flags the build used, so it must not run on one without.
 * Read straight from CPUID and XCR0 -- leaf 7 present, AVX and OSXSAVE (leaf
 * 1 ECX bits 28 and 27), the OS saving YMM state (XCR0 bits 1 and 2), AVX2
 * (leaf 7 EBX bit 5) -- which needs no runtime library on any compiler. */
static void cx16_cpuid(unsigned leaf, unsigned sub, unsigned r[4])
{
#if defined(_MSC_VER) && !defined(__clang__)
    int v[4];
    __cpuidex(v, (int)leaf, (int)sub);
    for (int i = 0; i < 4; ++i) r[i] = (unsigned)v[i];
#else
    __asm__ volatile("cpuid" : "=a"(r[0]), "=b"(r[1]), "=c"(r[2]), "=d"(r[3]) : "a"(leaf), "c"(sub));
#endif
}

static int cx16_have_avx2(void)
{
    static int have = -1;
    if (have < 0) {
        unsigned r[4];
        have = 0;
        cx16_cpuid(0, 0, r);
        if (r[0] >= 7) {
            cx16_cpuid(1, 0, r);
            const unsigned osxsave_avx = (1u << 27) | (1u << 28);
            if ((r[2] & osxsave_avx) == osxsave_avx) {
#if defined(_MSC_VER) && !defined(__clang__)
                const uint64_t xcr0 = _xgetbv(0);
#else
                unsigned lo, hi;
                __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
                const uint64_t xcr0 = ((uint64_t)hi << 32) | lo;
#endif
                if ((xcr0 & 6) == 6) {
                    cx16_cpuid(7, 0, r);
                    have = (r[1] & (1u << 5)) != 0;
                }
            }
        }
    }
    return have;
}

/* adapt on one half of the taps: wr += mr*sgn(hr) + mi*sgn(hi) - leak(wr),
 * wi += mi*sgn(hr) - mr*sgn(hi) - leak(wi), clamped; leak is |w| >> 14 with
 * w's sign put back, zero for a zero tap. */
#define CX16_ADAPT(wr, wi, hr, hi)                                                         \
    do {                                                                                   \
        const __m256i lr = _mm256_sign_epi32(                                              \
            _mm256_srli_epi32(_mm256_abs_epi32(wr), LEAK_SHIFT_COMPLEX), wr);              \
        const __m256i li = _mm256_sign_epi32(                                              \
            _mm256_srli_epi32(_mm256_abs_epi32(wi), LEAK_SHIFT_COMPLEX), wi);              \
        const __m256i nr = _mm256_sub_epi32(_mm256_add_epi32(wr, _mm256_add_epi32(         \
            _mm256_sign_epi32(mr, hr), _mm256_sign_epi32(mi, hi))), lr);                   \
        const __m256i ni = _mm256_sub_epi32(_mm256_add_epi32(wi, _mm256_sub_epi32(         \
            _mm256_sign_epi32(mi, hr), _mm256_sign_epi32(mr, hi))), li);                   \
        wr = _mm256_max_epi32(_mm256_min_epi32(nr, lim), nlim);                            \
        wi = _mm256_max_epi32(_mm256_min_epi32(ni, lim), nlim);                            \
    } while (0)

NATIVE_TARGET_AVX2
static int cx16_inverse_avx2(struct cx16_state *st, const int32_t *res, int16_t *out, int frames,
                             int64_t mu)
{
    __m256i hr0 = _mm256_loadu_si256((const __m256i *)&st->hr[0]);
    __m256i hr1 = _mm256_loadu_si256((const __m256i *)&st->hr[8]);
    __m256i hi0 = _mm256_loadu_si256((const __m256i *)&st->hi[0]);
    __m256i hi1 = _mm256_loadu_si256((const __m256i *)&st->hi[8]);
    __m256i wr0 = _mm256_loadu_si256((const __m256i *)&st->wr[0]);
    __m256i wr1 = _mm256_loadu_si256((const __m256i *)&st->wr[8]);
    __m256i wi0 = _mm256_loadu_si256((const __m256i *)&st->wi[0]);
    __m256i wi1 = _mm256_loadu_si256((const __m256i *)&st->wi[8]);
    const __m256i rot = _mm256_setr_epi32(1, 2, 3, 4, 5, 6, 7, 0);
    const __m256i lim = _mm256_set1_epi32((int32_t)TAP_LIMIT);
    const __m256i nlim = _mm256_set1_epi32(-(int32_t)TAP_LIMIT);
    int f = 0;
    for (; f < frames; ++f) {
        /* Even lanes multiply directly, odd ones once shifted down:
         * VPMULDQ reads only the low half of each quadword. */
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
        const int64_t er = res[2 * f], ei = res[2 * f + 1];
        const int64_t xr = er + round_shift(_mm_cvtsi128_si64(sum));
        const int64_t xi = ei + round_shift(_mm_extract_epi64(sum, 1));
        if (xr != (int32_t)xr || xi != (int32_t)xi) break;
        out[2 * f] = (int16_t)xr;
        out[2 * f + 1] = (int16_t)xi;

        if (er != 0 || ei != 0) {
            const __m256i mr = _mm256_set1_epi32((int32_t)(mu * sign64(er)));
            const __m256i mi = _mm256_set1_epi32((int32_t)(mu * sign64(ei)));
            CX16_ADAPT(wr0, wi0, hr0, hi0);
            CX16_ADAPT(wr1, wi1, hr1, hi1);
        }

        /* Slide the window a lane: the oldest out, this frame in at the top. */
        const __m256i r0 = _mm256_permutevar8x32_epi32(hr0, rot), r1 = _mm256_permutevar8x32_epi32(hr1, rot);
        const __m256i i0 = _mm256_permutevar8x32_epi32(hi0, rot), i1 = _mm256_permutevar8x32_epi32(hi1, rot);
        hr0 = _mm256_blend_epi32(r0, r1, 0x80);
        hi0 = _mm256_blend_epi32(i0, i1, 0x80);
        hr1 = _mm256_blend_epi32(r1, _mm256_set1_epi32((int32_t)xr), 0x80);
        hi1 = _mm256_blend_epi32(i1, _mm256_set1_epi32((int32_t)xi), 0x80);
    }
    _mm256_storeu_si256((__m256i *)&st->wr[0], wr0);
    _mm256_storeu_si256((__m256i *)&st->wr[8], wr1);
    _mm256_storeu_si256((__m256i *)&st->wi[0], wi0);
    _mm256_storeu_si256((__m256i *)&st->wi[8], wi1);
    _mm256_storeu_si256((__m256i *)&st->hr[0], hr0);
    _mm256_storeu_si256((__m256i *)&st->hr[8], hr1);
    _mm256_storeu_si256((__m256i *)&st->hi[0], hi0);
    _mm256_storeu_si256((__m256i *)&st->hi[8], hi1);
    return f;
}
#undef CX16_ADAPT

#endif

#if defined(NATIVE_NEON)

static int cx16_inverse_neon(struct cx16_state *st, const int32_t *res, int16_t *out, int frames,
                             int64_t mu)
{
    int32x4_t hr[4], hi[4], wr[4], wi[4];
    for (int k = 0; k < 4; ++k) {
        hr[k] = vld1q_s32(&st->hr[4 * k]);
        hi[k] = vld1q_s32(&st->hi[4 * k]);
        wr[k] = vld1q_s32(&st->wr[4 * k]);
        wi[k] = vld1q_s32(&st->wi[4 * k]);
    }
    const int32x4_t lim = vdupq_n_s32((int32_t)TAP_LIMIT);
    const int32x4_t nlim = vdupq_n_s32(-(int32_t)TAP_LIMIT);
    int f = 0;
    for (; f < frames; ++f) {
        /* Two accumulators a part, each a pair of int64 lanes, so the
         * multiply-accumulates are not all one chain. */
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
        const int64_t er = res[2 * f], ei = res[2 * f + 1];
        const int64_t xr = er + round_shift(vaddvq_s64(vaddq_s64(ar0, ar1)));
        const int64_t xi = ei + round_shift(vaddvq_s64(vaddq_s64(ai0, ai1)));
        if (xr != (int32_t)xr || xi != (int32_t)xi) break;
        out[2 * f] = (int16_t)xr;
        out[2 * f + 1] = (int16_t)xi;

        if (er != 0 || ei != 0) {
            const int32_t mr = (int32_t)(mu * sign64(er));
            const int32_t mi = (int32_t)(mu * sign64(ei));
            for (int k = 0; k < 4; ++k) {
                /* Signs as -1/0/+1: the (h < 0) mask less the (h > 0) mask,
                 * each all ones where it holds. */
                const int32x4_t sr = vsubq_s32(vreinterpretq_s32_u32(vcltzq_s32(hr[k])),
                                               vreinterpretq_s32_u32(vcgtzq_s32(hr[k])));
                const int32x4_t si = vsubq_s32(vreinterpretq_s32_u32(vcltzq_s32(hi[k])),
                                               vreinterpretq_s32_u32(vcgtzq_s32(hi[k])));
                /* Leak: |w| >> 14 with w's sign put back. */
                const int32x4_t gr = vshrq_n_s32(wr[k], 31), gi = vshrq_n_s32(wi[k], 31);
                const int32x4_t lr = vsubq_s32(veorq_s32(vshrq_n_s32(vabsq_s32(wr[k]), LEAK_SHIFT_COMPLEX), gr), gr);
                const int32x4_t li = vsubq_s32(veorq_s32(vshrq_n_s32(vabsq_s32(wi[k]), LEAK_SHIFT_COMPLEX), gi), gi);
                const int32x4_t nr = vsubq_s32(vmlaq_n_s32(vmlaq_n_s32(wr[k], sr, mr), si, mi), lr);
                const int32x4_t ni = vsubq_s32(vmlsq_n_s32(vmlaq_n_s32(wi[k], sr, mi), si, mr), li);
                wr[k] = vmaxq_s32(vminq_s32(nr, lim), nlim);
                wi[k] = vmaxq_s32(vminq_s32(ni, lim), nlim);
            }
        }

        /* Slide the window a lane: the oldest out, this frame in at the top. */
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
        vst1q_s32(&st->wr[4 * k], wr[k]);
        vst1q_s32(&st->wi[4 * k], wi[k]);
        vst1q_s32(&st->hr[4 * k], hr[k]);
        vst1q_s32(&st->hi[4 * k], hi[k]);
    }
    return f;
}

#endif

/* Decode up to frames frames of an order-16 stage through the SIMD block,
 * returning how many it did: none for another order or with no kernel here,
 * fewer than asked if it met a sample past int32. The caller decodes the rest
 * with the per-frame loop. */
static int cx_inverse_block16(stage_t *f, const int32_t *res, int16_t *out,
                                  int frames)
{
#if defined(NATIVE_AVX2) || defined(NATIVE_NEON)
    if (f->order != 16 || frames <= 0) return 0;
#if defined(NATIVE_AVX2)
    if (!cx16_have_avx2()) return 0;
#endif
    struct cx16_state st;
    if (!cx16_load(f, &st)) return 0;
#if defined(NATIVE_AVX2)
    const int done = cx16_inverse_avx2(&st, res, out, frames, f->mu);
#else
    const int done = cx16_inverse_neon(&st, res, out, frames, f->mu);
#endif
    cx16_store(f, &st);
    return done;
#else
    (void)f;
    (void)res;
    (void)out;
    (void)frames;
    return 0;
#endif
}

static int rice_decode(const uint8_t *src, size_t len, int32_t *out, size_t count) {
    if (len < 1) return ERR_EMPTY;
    const unsigned k = src[0];
    if (k > 30) return ERR_RICE_K;
    ++src;
    --len;

    uint64_t acc = 0;
    unsigned nbits = 0;
    size_t i = 0;

#define REFILL()                              \
    while (nbits <= 56 && i < len) {          \
        acc |= (uint64_t)src[i] << nbits;     \
        ++i;                                  \
        nbits += 8;                           \
    }

    REFILL()
    const uint64_t mask = ((uint64_t)1 << k) - 1;

    for (size_t j = 0; j < count; ++j) {
        if (nbits < 48) { REFILL() }

        unsigned q = 0;
        for (;;) {
            const unsigned c = trailing_zeros64(~acc);
            if (c < nbits) {
                q += c;
                /* c+1 can reach 64; a shift by 64 is undefined in C. See the
                 * note at the same spot in soapy_driver/pcm_v4.hpp. */
                const unsigned sh = c + 1;
                acc = (sh >= 64) ? 0 : (acc >> sh);
                nbits -= sh;
                break;
            }
            if (i >= len) return ERR_RICE_TRUNCATED;
            q += nbits;
            acc = 0;
            nbits = 0;
            REFILL()
        }

        if (nbits < k) { REFILL() }
        if (nbits < k) return ERR_RICE_REMAINDER;
        const uint32_t u = ((uint32_t)q << k) | (uint32_t)(acc & mask);
        acc >>= k;
        nbits -= k;
        out[j] = (int32_t)((u >> 1) ^ ((uint32_t)0 - (u & 1)));
    }
#undef REFILL
    return ERR_OK;
}

/* ---- exported API ---- */

EXPORT int pcmv4_native_abi(void) { return PCMV4_NATIVE_ABI; }

/* NULL for a profile this library does not implement, or out of memory. */
EXPORT void *pcmv4_codec_new(int profile) {
    codec_t *c = calloc(1, sizeof(codec_t));
    if (!c) return NULL;
    c->profile = profile;
    int ok = 1;
    switch (profile) {
    case PROFILE_IQ:
    case PROFILE_IQ_SCALED:
        c->complex = 1;
        c->nstages = 1;
        ok = stage_init(&c->st[0], 16, 16);
        break;
    case PROFILE_AUDIO:
        c->complex = 0;
        c->nstages = 4;
        ok = stage_init(&c->st[0], 8, 16) && stage_init(&c->st[1], 8, 16) &&
             stage_init(&c->st[2], 4, 32) && stage_init(&c->st[3], 2, 32);
        break;
    default:
        free(c);
        return NULL;
    }
    if (!ok) {
        for (int s = 0; s < MAX_STAGES; ++s) stage_free(&c->st[s]);
        free(c);
        return NULL;
    }
    return c;
}

EXPORT void pcmv4_codec_free(void *h) {
    codec_t *c = h;
    if (!c) return;
    for (int s = 0; s < MAX_STAGES; ++s) stage_free(&c->st[s]);
    free(c->res);
    free(c);
}

/* Undo the reduced-depth scale of a PROFILE_IQ_SCALED packet in place,
 * saturating rather than wrapping. A multiply rather than a left shift, which
 * C leaves undefined for a negative value. */
EXPORT void pcmv4_lossy_restore(int16_t *samples, int count, int shift) {
    if (shift <= 0) return;
    const int64_t scale = (int64_t)1 << shift;
    for (int i = 0; i < count; ++i) {
        int64_t r = (int64_t)samples[i] * scale;
        if (r > 32767) r = 32767;
        else if (r < -32768) r = -32768;
        samples[i] = (int16_t)r;
    }
}

EXPORT int pcmv4_codec_advance_silence(void *h, int count) {
    codec_t *c = h;
    const int step = c->complex ? 2 : 1;
    if (count <= 0 || count % step) return ERR_BAD_COUNT;
    codec_begin(c, count / step);
    for (int i = 0; i < count; i += step) codec_forward(c, 0, 0);
    return ERR_OK;
}

/* Reconstruct one packet body into out[0..count), little-endian int16 as the
 * host lays it out (every platform this ships on is little-endian). */
EXPORT int pcmv4_codec_decode_body(void *h, const uint8_t *body, size_t len,
                                   int count, int escape, int16_t *out) {
    codec_t *c = h;
    const int step = c->complex ? 2 : 1;
    if (count <= 0 || count % step) return ERR_BAD_COUNT;

    if (escape) {
        if (len < (size_t)count * 2) return ERR_ESCAPE_TRUNCATED;
        for (int i = 0; i < count; ++i)
            out[i] = (int16_t)((uint16_t)body[2 * i] | ((uint16_t)body[2 * i + 1] << 8));
        codec_begin(c, count / step);
        for (int i = 0; i < count; i += step)
            codec_forward(c, out[i], step == 2 ? out[i + 1] : 0);
        return ERR_OK;
    }

    if ((size_t)count > c->res_cap) {
        int32_t *r = realloc(c->res, (size_t)count * sizeof(int32_t));
        if (!r) return ERR_NOMEM;
        c->res = r;
        c->res_cap = (size_t)count;
    }
    int rc = rice_decode(body, len, c->res, (size_t)count);
    if (rc != ERR_OK) return rc;

    codec_begin(c, count / step);
    if (c->complex) {
        /* A single order-16 stage -- every IQ profile -- decodes through the
         * SIMD block; whatever it hands back goes frame by frame. */
        int start = 0;
        if (c->nstages == 1) start = 2 * cx_inverse_block16(&c->st[0], c->res, out, count / 2);
        for (int i = start; i < count; i += 2) {
            int64_t a = c->res[i], b = c->res[i + 1];
            /* Stages are inverted in reverse order. */
            for (int s = c->nstages - 1; s >= 0; --s) {
                stage_t *st = &c->st[s];
                int64_t pr, pi;
                cx_predict(st, &pr, &pi);
                const int64_t xr = a + pr, xi = b + pi;
                cx_adapt(st, a, b);
                cx_push(st, xr, xi);
                a = xr;
                b = xi;
            }
            out[i] = (int16_t)a;
            out[i + 1] = (int16_t)b;
        }
        return ERR_OK;
    }
    for (int i = 0; i < count; ++i) {
        int64_t a = c->res[i];
        for (int s = c->nstages - 1; s >= 0; --s) {
            stage_t *st = &c->st[s];
            const int64_t x = a + rl_predict(st);
            rl_adapt(st, a);
            rl_push(st, x);
            a = x;
        }
        out[i] = (int16_t)a;
    }
    return ERR_OK;
}
