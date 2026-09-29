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
    int64_t pr = 0, pi = 0;
    for (int j = 0; j < order; ++j) {
        const int64_t br = hr[j], bi = hi[j], w = s->wr[j], v = s->wi[j];
        pr += w * br - v * bi;
        pi += w * bi + v * br;
    }
    *outr = round_shift(pr);
    *outi = round_shift(pi);
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
    int64_t p = 0;
    for (int j = 0; j < order; ++j) p += s->wr[j] * s->hr[lo + j];
    return round_shift(p);
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
        for (int i = 0; i < count; i += 2) {
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
