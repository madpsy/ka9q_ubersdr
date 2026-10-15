/*
 * iq.c - the complex stage: profiles 0 and 2, every IQ mode.
 *
 * Two paths, and the split between them is what keeps this exact.
 *
 * The per-frame path (cx_inverse_frame, cx_forward_frame) is pcm-v4.js's
 * Stage.stepComplex and Stage.advanceComplex transcribed into C doubles, same
 * operations in the same order. It is exact against the JavaScript on any
 * input, including a corrupt stream that drives the history far past int16 --
 * see pcmv4.h. It is also the slow path: every multiply is a double multiply,
 * and the adaptation's floor()s and comparisons are per tap.
 *
 * The block kernel (cx16_*) is the fast path, for the single order-16 stage
 * every IQ profile uses. It holds the sixteen taps and the sixteen-sample
 * window in int32 lanes for a whole packet, forms the products in int64 lanes
 * and does the sign-sign update and the leak in int32 -- the same arithmetic
 * as clients/python/pcm_v4_native.c's NEON kernel, which it is a port of.
 * Integer arithmetic equals the JavaScript's doubles only inside PV4_INT_SAFE,
 * so the kernel is entered only when the whole window is inside it, and it
 * stops BEFORE taking in a sample that is not: that frame and the rest of the
 * packet then go through the per-frame path, which starts from the canonical
 * state the kernel wrote back as if the kernel had never run. On anything the
 * server can send, the kernel decodes every frame.
 *
 * Built with -msimd128 the kernel is WebAssembly SIMD; without it, the same
 * kernel in scalar integer C, which on the scalar module is still about twice
 * the speed of the double-precision per-frame path.
 *
 * The kernel's lane order is the native ports' -- lane 0 is the OLDEST sample
 * in the window -- while the canonical taps are the JavaScript's, tap 0 for
 * the newest. cx16_load and cx16_store reverse them; nothing else needs to
 * know.
 */
#include "pcmv4.h"

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

/* ------------------------------------------------------------------------- */
/* Per-frame path: the JavaScript, exactly                                   */
/* ------------------------------------------------------------------------- */

static inline void cx_predict(const pv4_stage *s, double *outr, double *outi) {
    const int order = s->order, base = s->idx - 1;
    const double *hr = s->h_r, *hi = s->h_i, *wr = s->w_r, *wi = s->w_i;
    double pr = 0, pi = 0;
    for (int j = 0; j < order; ++j) {
        const double br = hr[base - j], bi = hi[base - j];
        pr += wr[j] * br - wi[j] * bi;
        pi += wr[j] * bi + wi[j] * br;
    }
    *outr = pr;
    *outi = pi;
}

/* The update, skipped entirely on a zero error -- leak included, exactly as
 * the server's adapt returns early. A NaN error is not zero, so it adapts with
 * mu * sgn(NaN) = 0 and still leaks, which is what the JavaScript does. */
static inline void cx_adapt(pv4_stage *s, double er, double ei) {
    if (!(er != 0 || ei != 0)) return;
    const int order = s->order, base = s->idx - 1;
    const double mr = s->mu * pv4_sgn(er), mi = s->mu * pv4_sgn(ei);
    double *wr = s->w_r, *wi = s->w_i;
    for (int j = 0; j < order; ++j) {
        const double hrs = s->s_r[base - j];
        const double his = -s->s_i[base - j]; /* conjugate */
        const double u = wr[j], v = wi[j];
        const double a = u + mr * hrs - mi * his - pv4_leak(u, PV4_LEAK_COMPLEX);
        const double b = v + mr * his + mi * hrs - pv4_leak(v, PV4_LEAK_COMPLEX);
        wr[j] = pv4_clamp(a);
        wi[j] = pv4_clamp(b);
    }
}

static inline void cx_push(pv4_stage *s, double xr, double xi) {
    s->h_r[s->idx] = xr;
    s->h_i[s->idx] = xi;
    s->s_r[s->idx] = pv4_sgn(xr);
    s->s_i[s->idx] = pv4_sgn(xi);
    if (++s->idx == PV4_HLEN) pv4_slide(s, 1);
}

/* Reconstruct one frame through the whole cascade. Stages are undone in
 * reverse: the last to have predicted is the first to be reversed. */
static inline void cx_inverse_frame(pv4_codec *c, double a, double b, double *xa, double *xb) {
    for (int i = c->nstages - 1; i >= 0; --i) {
        pv4_stage *s = &c->st[i];
        double pr, pi;
        cx_predict(s, &pr, &pi);
        const double xr = a + pv4_rshift16(pr);
        const double xi = b + pv4_rshift16(pi);
        cx_adapt(s, a, b);
        cx_push(s, xr, xi);
        a = xr;
        b = xi;
    }
    *xa = a;
    *xb = b;
}

/* The encoder direction over one known frame, for escape and silent bodies. */
static inline void cx_forward_frame(pv4_codec *c, double a, double b) {
    for (int i = 0; i < c->nstages; ++i) {
        pv4_stage *s = &c->st[i];
        double pr, pi;
        cx_predict(s, &pr, &pi);
        const double er = a - pv4_rshift16(pr);
        const double ei = b - pv4_rshift16(pi);
        cx_adapt(s, er, ei);
        cx_push(s, a, b);
        a = er;
        b = ei;
    }
}

/* ------------------------------------------------------------------------- */
/* The order-16 block kernel                                                 */
/* ------------------------------------------------------------------------- */

/* The kernel's working state: lane 0 is the oldest sample in the window and
 * the tap that multiplies it. */
typedef struct {
    int32_t wr[16], wi[16];
    int32_t hr[16], hi[16];
} cx16_state;

/* Whether the kernel may run, and if so its state. Taps are always integers
 * within +-2^24; the window must be inside PV4_INT_SAFE, which a NaN or an
 * Infinity fails as well. */
static int cx16_load(const pv4_stage *s, cx16_state *k) {
    if (s->order != 16) return 0;
    const int lo = s->idx - 16;
    for (int j = 0; j < 16; ++j) {
        const double r = s->h_r[lo + j], i = s->h_i[lo + j];
        if (!(r > -PV4_INT_SAFE && r < PV4_INT_SAFE && i > -PV4_INT_SAFE && i < PV4_INT_SAFE)) return 0;
    }
    for (int j = 0; j < 16; ++j) {
        k->hr[j] = (int32_t)s->h_r[lo + j];
        k->hi[j] = (int32_t)s->h_i[lo + j];
        k->wr[j] = (int32_t)s->w_r[15 - j];
        k->wi[j] = (int32_t)s->w_i[15 - j];
    }
    return 1;
}

/* Back into the canonical state, with the window at the front of the history. */
static void cx16_store(pv4_stage *s, const cx16_state *k) {
    for (int j = 0; j < 16; ++j) {
        s->w_r[15 - j] = (double)k->wr[j];
        s->w_i[15 - j] = (double)k->wi[j];
        s->h_r[j] = (double)k->hr[j];
        s->h_i[j] = (double)k->hi[j];
        s->s_r[j] = (double)pv4_sgn_i32(k->hr[j]);
        s->s_i[j] = (double)pv4_sgn_i32(k->hi[j]);
    }
    s->idx = 16;
}

#if defined(__wasm_simd128__)

/* Four int32x4 vectors each of taps and window, a packet at a time. The
 * products are widened into int64x2 lanes with extmul, two accumulators a
 * part so the adds are not one dependent chain. */
static int cx16_run(cx16_state *st, const int32_t *res, int frames, int32_t mu,
                    float *pa, float *pb, double g) {
    v128_t hr[4], hi[4], wr[4], wi[4];
    for (int k = 0; k < 4; ++k) {
        hr[k] = wasm_v128_load(&st->hr[4 * k]);
        hi[k] = wasm_v128_load(&st->hi[4 * k]);
        wr[k] = wasm_v128_load(&st->wr[4 * k]);
        wi[k] = wasm_v128_load(&st->wi[4 * k]);
    }
    const v128_t lim = wasm_i32x4_splat(PV4_TAP_LIMIT_I), nlim = wasm_i32x4_splat(-PV4_TAP_LIMIT_I);
    const v128_t z = wasm_i32x4_splat(0);
    int f = 0;
    for (; f < frames; ++f) {
        v128_t ar0 = wasm_i64x2_sub(wasm_i64x2_extmul_low_i32x4(wr[0], hr[0]), wasm_i64x2_extmul_low_i32x4(wi[0], hi[0]));
        v128_t ar1 = wasm_i64x2_sub(wasm_i64x2_extmul_high_i32x4(wr[0], hr[0]), wasm_i64x2_extmul_high_i32x4(wi[0], hi[0]));
        v128_t ai0 = wasm_i64x2_add(wasm_i64x2_extmul_low_i32x4(wr[0], hi[0]), wasm_i64x2_extmul_low_i32x4(wi[0], hr[0]));
        v128_t ai1 = wasm_i64x2_add(wasm_i64x2_extmul_high_i32x4(wr[0], hi[0]), wasm_i64x2_extmul_high_i32x4(wi[0], hr[0]));
        for (int k = 1; k < 4; ++k) {
            ar0 = wasm_i64x2_add(ar0, wasm_i64x2_sub(wasm_i64x2_extmul_low_i32x4(wr[k], hr[k]), wasm_i64x2_extmul_low_i32x4(wi[k], hi[k])));
            ar1 = wasm_i64x2_add(ar1, wasm_i64x2_sub(wasm_i64x2_extmul_high_i32x4(wr[k], hr[k]), wasm_i64x2_extmul_high_i32x4(wi[k], hi[k])));
            ai0 = wasm_i64x2_add(ai0, wasm_i64x2_add(wasm_i64x2_extmul_low_i32x4(wr[k], hi[k]), wasm_i64x2_extmul_low_i32x4(wi[k], hr[k])));
            ai1 = wasm_i64x2_add(ai1, wasm_i64x2_add(wasm_i64x2_extmul_high_i32x4(wr[k], hi[k]), wasm_i64x2_extmul_high_i32x4(wi[k], hr[k])));
        }
        const v128_t sr_ = wasm_i64x2_add(ar0, ar1), si_ = wasm_i64x2_add(ai0, ai1);
        const int64_t er = res[2 * f], ei = res[2 * f + 1];
        const int64_t xr = er + pv4_round_shift_i64(wasm_i64x2_extract_lane(sr_, 0) + wasm_i64x2_extract_lane(sr_, 1));
        const int64_t xi = ei + pv4_round_shift_i64(wasm_i64x2_extract_lane(si_, 0) + wasm_i64x2_extract_lane(si_, 1));
        /* Leave before this frame changes anything: the per-frame path redoes
         * it from the state as it stands. */
        if (xr <= -PV4_INT_SAFE || xr >= PV4_INT_SAFE || xi <= -PV4_INT_SAFE || xi >= PV4_INT_SAFE) break;
        pa[f] = pv4_out((double)xr, g);
        pb[f] = pv4_out((double)xi, g);
        if (er != 0 || ei != 0) {
            const v128_t mr = wasm_i32x4_splat(er > 0 ? mu : er < 0 ? -mu : 0);
            const v128_t mi = wasm_i32x4_splat(ei > 0 ? mu : ei < 0 ? -mu : 0);
            for (int k = 0; k < 4; ++k) {
                /* Signs as -1/0/+1: the (h < 0) mask less the (h > 0) mask,
                 * each all ones where it holds. */
                const v128_t sr = wasm_i32x4_sub(wasm_i32x4_lt(hr[k], z), wasm_i32x4_gt(hr[k], z));
                const v128_t si = wasm_i32x4_sub(wasm_i32x4_lt(hi[k], z), wasm_i32x4_gt(hi[k], z));
                /* Leak: |w| >> 14 with w's sign put back. */
                const v128_t gr = wasm_i32x4_shr(wr[k], 31), gi = wasm_i32x4_shr(wi[k], 31);
                const v128_t lr = wasm_i32x4_sub(wasm_v128_xor(wasm_u32x4_shr(wasm_i32x4_abs(wr[k]), PV4_LEAK_SHIFT_COMPLEX), gr), gr);
                const v128_t li = wasm_i32x4_sub(wasm_v128_xor(wasm_u32x4_shr(wasm_i32x4_abs(wi[k]), PV4_LEAK_SHIFT_COMPLEX), gi), gi);
                const v128_t nr = wasm_i32x4_sub(wasm_i32x4_add(wr[k], wasm_i32x4_add(wasm_i32x4_mul(sr, mr), wasm_i32x4_mul(si, mi))), lr);
                const v128_t ni = wasm_i32x4_sub(wasm_i32x4_add(wi[k], wasm_i32x4_sub(wasm_i32x4_mul(sr, mi), wasm_i32x4_mul(si, mr))), li);
                wr[k] = wasm_i32x4_max(wasm_i32x4_min(nr, lim), nlim);
                wi[k] = wasm_i32x4_max(wasm_i32x4_min(ni, lim), nlim);
            }
        }
        /* Slide the window a lane: the oldest out, this frame in at the top. */
        const v128_t xrv = wasm_i32x4_splat((int32_t)xr), xiv = wasm_i32x4_splat((int32_t)xi);
        hr[0] = wasm_i32x4_shuffle(hr[0], hr[1], 1, 2, 3, 4);
        hr[1] = wasm_i32x4_shuffle(hr[1], hr[2], 1, 2, 3, 4);
        hr[2] = wasm_i32x4_shuffle(hr[2], hr[3], 1, 2, 3, 4);
        hr[3] = wasm_i32x4_shuffle(hr[3], xrv, 1, 2, 3, 4);
        hi[0] = wasm_i32x4_shuffle(hi[0], hi[1], 1, 2, 3, 4);
        hi[1] = wasm_i32x4_shuffle(hi[1], hi[2], 1, 2, 3, 4);
        hi[2] = wasm_i32x4_shuffle(hi[2], hi[3], 1, 2, 3, 4);
        hi[3] = wasm_i32x4_shuffle(hi[3], xiv, 1, 2, 3, 4);
    }
    for (int k = 0; k < 4; ++k) {
        wasm_v128_store(&st->wr[4 * k], wr[k]);
        wasm_v128_store(&st->wi[4 * k], wi[k]);
        wasm_v128_store(&st->hr[4 * k], hr[k]);
        wasm_v128_store(&st->hi[4 * k], hi[k]);
    }
    return f;
}

#else

/* The same kernel without SIMD. The window lives in a linear buffer that is
 * slid down once every CX16_RUN frames, so the inner loops index it directly
 * with no rotation; the taps stay in int32 and the products in int64, which
 * WebAssembly has natively. */
#define CX16_RUN 240

static int cx16_run(cx16_state *st, const int32_t *res, int frames, int32_t mu,
                    float *pa, float *pb, double g) {
    int32_t hr[16 + CX16_RUN], hi[16 + CX16_RUN];
    int32_t wr[16], wi[16];
    for (int j = 0; j < 16; ++j) {
        hr[j] = st->hr[j];
        hi[j] = st->hi[j];
        wr[j] = st->wr[j];
        wi[j] = st->wi[j];
    }
    int pos = 0; /* the window is hr[pos .. pos + 15] */
    int f = 0;
    for (; f < frames; ++f) {
        if (pos == CX16_RUN) {
            for (int j = 0; j < 16; ++j) {
                hr[j] = hr[CX16_RUN + j];
                hi[j] = hi[CX16_RUN + j];
            }
            pos = 0;
        }
        const int32_t *br = hr + pos, *bi = hi + pos;
        int64_t pr = 0, pi = 0;
        for (int j = 0; j < 16; ++j) {
            pr += (int64_t)wr[j] * br[j] - (int64_t)wi[j] * bi[j];
            pi += (int64_t)wr[j] * bi[j] + (int64_t)wi[j] * br[j];
        }
        const int64_t er = res[2 * f], ei = res[2 * f + 1];
        const int64_t xr = er + pv4_round_shift_i64(pr);
        const int64_t xi = ei + pv4_round_shift_i64(pi);
        if (xr <= -PV4_INT_SAFE || xr >= PV4_INT_SAFE || xi <= -PV4_INT_SAFE || xi >= PV4_INT_SAFE) break;
        pa[f] = pv4_out((double)xr, g);
        pb[f] = pv4_out((double)xi, g);
        if (er != 0 || ei != 0) {
            const int32_t mr = er > 0 ? mu : er < 0 ? -mu : 0;
            const int32_t mi = ei > 0 ? mu : ei < 0 ? -mu : 0;
            for (int j = 0; j < 16; ++j) {
                const int32_t sr = pv4_sgn_i32(br[j]), si = pv4_sgn_i32(bi[j]);
                const int32_t u = wr[j], v = wi[j];
                const int32_t lr = u < 0 ? -(int32_t)((uint32_t)-u >> PV4_LEAK_SHIFT_COMPLEX) : u >> PV4_LEAK_SHIFT_COMPLEX;
                const int32_t li = v < 0 ? -(int32_t)((uint32_t)-v >> PV4_LEAK_SHIFT_COMPLEX) : v >> PV4_LEAK_SHIFT_COMPLEX;
                int32_t a = u + sr * mr + si * mi - lr;
                int32_t b = v + sr * mi - si * mr - li;
                wr[j] = a > PV4_TAP_LIMIT_I ? PV4_TAP_LIMIT_I : a < -PV4_TAP_LIMIT_I ? -PV4_TAP_LIMIT_I : a;
                wi[j] = b > PV4_TAP_LIMIT_I ? PV4_TAP_LIMIT_I : b < -PV4_TAP_LIMIT_I ? -PV4_TAP_LIMIT_I : b;
            }
        }
        hr[pos + 16] = (int32_t)xr;
        hi[pos + 16] = (int32_t)xi;
        ++pos;
    }
    for (int j = 0; j < 16; ++j) {
        st->hr[j] = hr[pos + j];
        st->hi[j] = hi[pos + j];
        st->wr[j] = wr[j];
        st->wi[j] = wi[j];
    }
    return f;
}

#endif

/* Decode as many frames as the kernel can; returns how many it did. */
static int cx16_block(pv4_codec *c, const int32_t *res, int nframes, float *pa, float *pb, double g) {
    if (!pv4_kernel_enabled || c->nstages != 1 || nframes <= 0) return 0;
    pv4_stage *s = &c->st[0];
    cx16_state k;
    if (!cx16_load(s, &k)) return 0;
    const int done = cx16_run(&k, res, nframes, (int32_t)s->mu, pa, pb, g);
    cx16_store(s, &k);
    pv4_counters.kernel_frames += (uint32_t)done;
    if (done < nframes) pv4_counters.kernel_exits++;
    return done;
}

/* ------------------------------------------------------------------------- */
/* Entry points                                                              */
/* ------------------------------------------------------------------------- */

void pv4_iq_inverse(pv4_codec *c, const int32_t *res, int nframes, float *pa, float *pb, double g) {
    int f = cx16_block(c, res, nframes, pa, pb, g);
    pv4_counters.frame_frames += (uint32_t)(nframes - f);
    for (; f < nframes; ++f) {
        double xr, xi;
        cx_inverse_frame(c, (double)res[2 * f], (double)res[2 * f + 1], &xr, &xi);
        pa[f] = pv4_out(xr, g);
        pb[f] = pv4_out(xi, g);
    }
}

void pv4_iq_inverse_wide(pv4_codec *c, const double *res, int nframes, float *pa, float *pb, double g) {
    pv4_counters.frame_frames += (uint32_t)nframes;
    for (int f = 0; f < nframes; ++f) {
        double xr, xi;
        cx_inverse_frame(c, res[2 * f], res[2 * f + 1], &xr, &xi);
        pa[f] = pv4_out(xr, g);
        pb[f] = pv4_out(xi, g);
    }
}

void pv4_iq_escape(pv4_codec *c, const uint8_t *le16, int nframes, float *pa, float *pb, double g) {
    for (int f = 0; f < nframes; ++f) {
        const int16_t a = (int16_t)((uint16_t)le16[4 * f] | ((uint16_t)le16[4 * f + 1] << 8));
        const int16_t b = (int16_t)((uint16_t)le16[4 * f + 2] | ((uint16_t)le16[4 * f + 3] << 8));
        cx_forward_frame(c, (double)a, (double)b);
        pa[f] = pv4_out((double)a, g);
        pb[f] = pv4_out((double)b, g);
    }
}

void pv4_iq_silent(pv4_codec *c, int nframes) {
    for (int f = 0; f < nframes; ++f) cx_forward_frame(c, 0.0, 0.0);
}
