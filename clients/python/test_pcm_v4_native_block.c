/*
 * test_pcm_v4_native_block.c -- the order-16 IQ block (cx_inverse_block16)
 * against the per-frame loop (cx_predict, cx_adapt, cx_push), sample for
 * sample. test_pcm_v4.py builds and runs it when a C compiler is at hand.
 *
 * pcm_v4_native.c is included rather than linked, to reach its static
 * functions. Two stages start alike and decode the same packets: one the way
 * pcmv4_codec_decode_body does -- the block, then frame by frame for whatever it
 * hands back -- the other frame by frame. The residuals are silence, small and loud noise, a tone that
 * runs on across packets (it drives the taps to real-signal size, where the
 * leak bites, which noise never does), and rarely values near +-2^31 that take
 * a sample past int32, where the block stops and leaves the rest. The escape
 * path's forward step is mixed in. Any differing sample or tap fails.
 */
#include "pcm_v4_native.c"

#include <math.h>
#include <stdio.h>

static uint64_t rng_state = 31;
static uint64_t rnd(void)
{
    rng_state = rng_state * 6364136223846793005ull + 1442695040888963407ull;
    return rng_state >> 11;
}
static int pick(int n) { return (int)(rnd() % (uint64_t)n); }

/* One frame each way, exactly as pcmv4_codec_decode_body and codec_forward
 * step a single complex stage. */
static void cstage_inverse(stage_t *f, int64_t er, int64_t ei, int64_t *xr, int64_t *xi)
{
    int64_t pr, pi;
    cx_predict(f, &pr, &pi);
    *xr = er + pr;
    *xi = ei + pi;
    cx_adapt(f, er, ei);
    cx_push(f, *xr, *xi);
}

static void cstage_forward(stage_t *f, int64_t xr, int64_t xi, int64_t *er, int64_t *ei)
{
    int64_t pr, pi;
    cx_predict(f, &pr, &pi);
    *er = xr - pr;
    *ei = xi - pi;
    cx_adapt(f, *er, *ei);
    cx_push(f, xr, xi);
}

static void clone_stage(stage_t *dst, const stage_t *src)
{
    const size_t o = (size_t)src->order * sizeof(int64_t), h = (size_t)src->hlen * sizeof(int64_t);
    *dst = *src;
    dst->wr = malloc(o); dst->wi = malloc(o);
    dst->hr = malloc(h); dst->hi = malloc(h); dst->sr = malloc(h); dst->si = malloc(h);
    memcpy(dst->wr, src->wr, o); memcpy(dst->wi, src->wi, o);
    memcpy(dst->hr, src->hr, h); memcpy(dst->hi, src->hi, h);
    memcpy(dst->sr, src->sr, h); memcpy(dst->si, src->si, h);
}

int main(void)
{
    long frames_total = 0, blocked = 0;
    for (int trial = 0; trial < 300; ++trial) {
        stage_t got, want;
        if (!stage_init(&got, 16, 16) || !stage_init(&want, 16, 16)) return 2;
        const double amp = 2000 + pick(28000), step = 0.01 + 0.6 * (pick(1000) / 1000.0);
        long phase = 0;
        for (int p = 0; p < 60; ++p) {
            const int frames = 1 + pick(400);
            const int r = pick(100);
            const int kind = r < 50 ? 6 : (r < 92 ? pick(4) : (r < 98 ? 4 : 5));
            int32_t *res = calloc((size_t)frames * 2, sizeof(int32_t));
            int16_t *a = calloc((size_t)frames * 2, sizeof(int16_t));
            int16_t *b = calloc((size_t)frames * 2, sizeof(int16_t));
            for (int i = 0; i < 2 * frames; ++i) {
                switch (kind) {
                case 0: res[i] = 0; break;
                case 1: res[i] = pick(3) - 1; break;
                case 2: res[i] = pick(2001) - 1000; break;
                case 3: res[i] = pick(60001) - 30000; break;
                case 4: res[i] = pick(200) == 0 ? (pick(2) ? INT32_MAX - pick(1000) : INT32_MIN + pick(1000))
                                               : pick(201) - 100;
                        break;
                case 5: res[i] = (int32_t)(uint32_t)rnd(); break;
                default: break;
                }
            }
            if (kind == 6) {
                /* The residuals that decode to a tone: drive a copy of the
                 * reference forward over it. */
                stage_t probe;
                clone_stage(&probe, &want);
                cx_begin(&probe, frames);
                for (int f = 0; f < frames; ++f, ++phase) {
                    int64_t er, ei;
                    cstage_forward(&probe, (int64_t)(amp * cos(step * phase)), (int64_t)(amp * sin(step * phase)),
                                   &er, &ei);
                    res[2 * f] = (int32_t)er;
                    res[2 * f + 1] = (int32_t)ei;
                }
                stage_free(&probe);
            }
            cx_begin(&got, frames);
            cx_begin(&want, frames);

            if (pick(8) == 0) {
                /* The escape path: both advance over known samples. */
                for (int f = 0; f < frames; ++f) {
                    int64_t r1, i1, r2, i2;
                    cstage_forward(&got, (int16_t)res[2 * f], (int16_t)res[2 * f + 1], &r1, &i1);
                    cstage_forward(&want, (int16_t)res[2 * f], (int16_t)res[2 * f + 1], &r2, &i2);
                    if (r1 != r2 || i1 != i2) {
                        fprintf(stderr, "trial %d packet %d frame %d: forward differs\n", trial, p, f);
                        return 1;
                    }
                }
            } else {
                const int done = cx_inverse_block16(&got, res, b, frames);
                if (done > 0) ++blocked;
                for (int f = done; f < frames; ++f) {
                    int64_t xr, xi;
                    cstage_inverse(&got, res[2 * f], res[2 * f + 1], &xr, &xi);
                    b[2 * f] = (int16_t)xr;
                    b[2 * f + 1] = (int16_t)xi;
                }
                for (int f = 0; f < frames; ++f) {
                    int64_t xr, xi;
                    cstage_inverse(&want, res[2 * f], res[2 * f + 1], &xr, &xi);
                    a[2 * f] = (int16_t)xr;
                    a[2 * f + 1] = (int16_t)xi;
                }
                for (int i = 0; i < 2 * frames; ++i) {
                    if (a[i] != b[i]) {
                        fprintf(stderr, "trial %d packet %d sample %d: %d, reference %d\n", trial, p, i, b[i], a[i]);
                        return 1;
                    }
                }
                frames_total += frames;
            }
            for (int j = 0; j < 16; ++j) {
                if (got.wr[j] != want.wr[j] || got.wi[j] != want.wi[j]) {
                    fprintf(stderr, "trial %d packet %d: tap %d differs\n", trial, p, j);
                    return 1;
                }
            }
            free(res); free(a); free(b);
        }
        stage_free(&got);
        stage_free(&want);
    }
    printf("%ld frames identical to the per-frame loop, %ld packets through the block\n", frames_total, blocked);
    return 0;
}
