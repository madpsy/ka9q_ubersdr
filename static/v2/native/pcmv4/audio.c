/*
 * audio.c - the real cascade: profile 1, every demodulated mode.
 *
 * Four real stages of orders 8, 8, 4 and 2, undone in reverse for each sample.
 * This is pcm-v4.js's Stage.stepReal and Stage.advanceReal transcribed into C
 * doubles, operation for operation, and so exact against the JavaScript on any
 * input -- including the corrupt ones that take the history past 2^24, where
 * integer arithmetic would stop agreeing with it. See pcmv4.h.
 *
 * There is no integer fast path here yet, deliberately. Audio is 12 or 24 kHz,
 * where even this path is a small fraction of a core; the IQ kernel in iq.c is
 * where the rate is. Adding one follows iq.c's pattern: run in integers only
 * while every window in the cascade is inside PV4_INT_SAFE and every value
 * passed between stages is inside int32-plus-headroom, and hand the rest of the
 * packet to these functions from the canonical state the moment it is not.
 * Note that in a cascade the bound applies to every stage's window, and that
 * an intermediate stage's values are prediction errors, not int16 samples:
 * with the taps at their clamp a stage's output can exceed int16 by the gain
 * of the stage before it, so the check cannot be skipped on the grounds that
 * the input is audio.
 */
#include "pcmv4.h"

/* One stage, inverse: reconstruct x from its error e, adapt, record. */
static inline double rl_inverse(pv4_stage *s, double e) {
    const int order = s->order, base = s->idx - 1;
    const double *h = s->h_r;
    double *w = s->w_r;
    double p = 0;
    for (int j = 0; j < order; ++j) p += w[j] * h[base - j];
    const double x = e + pv4_rshift16(p);
    /* A zero error stops the update entirely, leak included. NaN is not zero. */
    if (e != 0) {
        const double m = s->mu * pv4_sgn(e);
        const double *sg = s->s_r;
        for (int j = 0; j < order; ++j) {
            const double u = w[j];
            const double a = u + m * sg[base - j] - pv4_leak(u, PV4_LEAK_REAL);
            w[j] = pv4_clamp(a);
        }
    }
    s->h_r[s->idx] = x;
    s->s_r[s->idx] = pv4_sgn(x);
    if (++s->idx == PV4_HLEN) pv4_slide(s, 0);
    return x;
}

/* One stage, forward: the error the encoder would have sent for a known x. */
static inline double rl_forward(pv4_stage *s, double x) {
    const int order = s->order, base = s->idx - 1;
    const double *h = s->h_r;
    double *w = s->w_r;
    double p = 0;
    for (int j = 0; j < order; ++j) p += w[j] * h[base - j];
    const double e = x - pv4_rshift16(p);
    if (e != 0) {
        const double m = s->mu * pv4_sgn(e);
        const double *sg = s->s_r;
        for (int j = 0; j < order; ++j) {
            const double u = w[j];
            const double a = u + m * sg[base - j] - pv4_leak(u, PV4_LEAK_REAL);
            w[j] = pv4_clamp(a);
        }
    }
    s->h_r[s->idx] = x;
    s->s_r[s->idx] = pv4_sgn(x);
    if (++s->idx == PV4_HLEN) pv4_slide(s, 0);
    return e;
}

static inline double rl_inverse_sample(pv4_codec *c, double v) {
    for (int i = c->nstages - 1; i >= 0; --i) v = rl_inverse(&c->st[i], v);
    return v;
}

static inline void rl_forward_sample(pv4_codec *c, double v) {
    for (int i = 0; i < c->nstages; ++i) v = rl_forward(&c->st[i], v);
}

void pv4_audio_inverse(pv4_codec *c, const int32_t *res, int n, float *pa, double g) {
    for (int i = 0; i < n; ++i) pa[i] = pv4_out(rl_inverse_sample(c, (double)res[i]), g);
}

void pv4_audio_inverse_wide(pv4_codec *c, const double *res, int n, float *pa, double g) {
    for (int i = 0; i < n; ++i) pa[i] = pv4_out(rl_inverse_sample(c, res[i]), g);
}

void pv4_audio_escape(pv4_codec *c, const uint8_t *le16, int n, float *pa, double g) {
    for (int i = 0; i < n; ++i) {
        const int16_t a = (int16_t)((uint16_t)le16[2 * i] | ((uint16_t)le16[2 * i + 1] << 8));
        rl_forward_sample(c, (double)a);
        pa[i] = pv4_out((double)a, g);
    }
}

void pv4_audio_silent(pv4_codec *c, int n) {
    for (int i = 0; i < n; ++i) rl_forward_sample(c, 0.0);
}
