/*
 * pcmv4.h - shared definitions for the WebAssembly PCM v4 decoder.
 *
 * This is a port of static/v2/src/radio/pcm-v4.js, NOT of the server's Go or
 * of the other native clients, and that distinction is the whole design.
 *
 * Every other native port (clients/python/pcm_v4_native.c, the Soapy driver,
 * the Go clients) is held to the server: it decodes int16 samples, and a
 * corrupt stream is allowed to produce whatever its integer arithmetic
 * produces. This module replaces the browser's JavaScript decoder in place, so
 * it is held to THAT, bit for bit, Float32 plane against Float32 plane -- and
 * the JavaScript does its arithmetic in float64. On every stream the server can
 * actually send the two are the same thing: taps are clamped to 2^24, samples
 * are 16-bit, so every product and every partial sum stays far below 2^53 and
 * a double holds it exactly. On a corrupt stream they are not. A bad residual
 * can be as large as 2^49 (k = 30 and a long unary run), the history then
 * holds values past 2^24, products pass 2^53 and the JavaScript starts
 * rounding; a few frames later it can reach Infinity and then NaN. The
 * JavaScript also never clamps a reconstructed sample to int16 before scaling
 * it to float, so a corrupt packet comes out as audio past full scale rather
 * than as a clipped one.
 *
 * A decoder that wanted "the same as JavaScript on good streams" could ignore
 * all of that. This one does not, because the moment it is wired in the two
 * decoders will be compared, and a comparison that is only valid on clean
 * input cannot tell a port bug from a corrupt packet. So:
 *
 *   - The CANONICAL state is the JavaScript's: taps, history and history signs
 *     as doubles, in the JavaScript's order (tap 0 multiplies the NEWEST
 *     sample, not the oldest as in the native ports). pv4_stage below.
 *
 *   - The per-frame paths (iq.c, audio.c) are a literal transcription of the
 *     JavaScript in double arithmetic, same operations in the same order, so
 *     they are exact on any input, corrupt or not. -ffp-contract=off keeps the
 *     compiler from fusing a multiply and an add into something JavaScript
 *     would round differently.
 *
 *   - A fast path may use integer arithmetic ONLY while it is provably equal
 *     to those doubles. The rule is in PV4_INT_SAFE below. iq.c's block kernel
 *     enters only when the whole window is inside it and leaves on the first
 *     frame that would put a sample outside it, handing the rest of the packet
 *     to the per-frame path, which picks up from the canonical state as if the
 *     kernel had never run.
 *
 * Where it still cannot match: a NaN. Once a corrupt stream has driven a
 * sample to Infinity - Infinity both decoders produce NaN at the same places,
 * but the BIT PATTERN of a NaN is not specified by WebAssembly or by
 * JavaScript, so the sign and payload may differ. test.js compares NaN as
 * equal to NaN for that reason and only that reason.
 *
 * The source is split by who will work on it: iq.c (the complex stage and its
 * SIMD kernel), audio.c (the real cascade), rice.c (the bitstream) and api.c
 * (the exported surface and buffers). Each depends only on this header, so the
 * four can be optimised in parallel without touching each other's files. shim.c
 * is the freestanding runtime: no libc is linked.
 */
#ifndef PCMV4_H
#define PCMV4_H

#include <stddef.h>
#include <stdint.h>

#define PV4_EXPORT(name) __attribute__((export_name(name), visibility("default")))

/* The exported ABI. Bumped whenever an export's signature, the meaning of an
 * argument or return value, or the layout the JavaScript reads changes, so a
 * wrapper built against one version refuses a module of another rather than
 * calling it with the wrong arguments. pcm-v4-wasm.js checks it. */
#define PV4_ABI_VERSION 1

/* Constants of the codec; see pcm-v4.js and pcm_predictive.go for why. */
#define PV4_TAP_SHIFT 65536.0     /* Q16 */
#define PV4_TAP_HALF 32768.0
#define PV4_TAP_LIMIT 16777216.0  /* 2^24 */
#define PV4_TAP_LIMIT_I 16777216
#define PV4_LEAK_COMPLEX 16384.0  /* 2^14 */
#define PV4_LEAK_REAL 65536.0     /* 2^16 */
#define PV4_LEAK_SHIFT_COMPLEX 14
#define PV4_LEAK_SHIFT_REAL 16

/* The integer-exactness bound. With |tap| <= 2^24 and every history value in
 * the prediction window below 2^24 in magnitude, a product is below 2^48, a
 * complex term (two products) below 2^49 and a sum of sixteen terms below
 * 2^53: the JavaScript's doubles are exact integers all the way, so integer
 * arithmetic gives the same answer. A residual must also fit an int32, which
 * the Rice decoder guarantees on its narrow path (pv4_rice_decode returns
 * PV4_WIDE otherwise). The reconstructed x = e + round(p / 2^16) is then below
 * 2^31 + 2^37: exact in a double, and in an int64. */
#define PV4_INT_SAFE 16777216 /* |history| must be < this */

/* Stage geometry. History is linear with a periodic slide, as in the
 * JavaScript, so the tap loops walk contiguous memory with no index wrapping.
 * The slide happens every PV4_HLEN - order pushes; the JavaScript slides every
 * order pushes, which is a cost choice and changes no value. */
#define PV4_MAX_ORDER 16
#define PV4_MAX_STAGES 4
#define PV4_HLEN 128

/* Profiles, as the packet's flags byte names them. */
#define PV4_PROFILE_IQ 0
#define PV4_PROFILE_AUDIO 1
#define PV4_PROFILE_IQ_SCALED 2

/* Return codes. Negative is a rejected packet; the wrapper maps every one of
 * them to the null the JavaScript decoder returns, since that decoder never
 * says why. They are distinct so a test or a debugger can. */
#define PV4_OK 0
#define PV4_WIDE 1 /* rice.c only: a residual does not fit int32; use the wide decoder */
#define PV4_ERR_BAD_COUNT -1
#define PV4_ERR_ESCAPE_TRUNCATED -2
#define PV4_ERR_EMPTY -3
#define PV4_ERR_RICE_K -4
#define PV4_ERR_RICE_TRUNCATED -5
#define PV4_ERR_NOMEM -6
#define PV4_ERR_PROFILE -7
#define PV4_ERR_NO_PROFILE -8
#define PV4_ERR_SHIFT -9
#define PV4_ERR_HANDLE -10

/* Body modes for pv4_decode. */
#define PV4_BODY_RICE 0
#define PV4_BODY_ESCAPE 1

/* One adaptive filter, in the JavaScript's representation. A real stage uses
 * only the _r arrays. Doubles throughout, because the JavaScript's values are
 * doubles: on a clean stream every one is an exact integer, and on a corrupt
 * one they are whatever the JavaScript's rounding made of them.
 *
 * w[j] multiplies h[idx - 1 - j]: tap 0 is the newest sample. s holds sgn(h)
 * at the same index, as the JavaScript keeps it. */
typedef struct {
    int order;
    int idx; /* next history slot; the window is h[idx - order .. idx - 1] */
    double mu;
    double w_r[PV4_MAX_ORDER], w_i[PV4_MAX_ORDER];
    double h_r[PV4_HLEN], h_i[PV4_HLEN];
    double s_r[PV4_HLEN], s_i[PV4_HLEN];
} pv4_stage;

/* One stream's predictor. profile is -1 until the first packet names one. */
typedef struct {
    int magic; /* PV4_CODEC_MAGIC while live, so a stale handle is refused */
    int profile;
    int complex;
    int nstages;
    pv4_stage st[PV4_MAX_STAGES];
} pv4_codec;

#define PV4_CODEC_MAGIC 0x34766370 /* "pcv4" */

/* ---- the JavaScript's helpers, in double arithmetic ---- */

/* Round-to-nearest shift by 16, ties away from zero: pcm-v4.js rshift16.
 * The division by 2^16 is exact, and a compiler turning it into a multiply
 * by 2^-16 changes nothing. NaN takes the second branch, as in JavaScript,
 * and stays NaN. */
static inline double pv4_rshift16(double v) {
    return v >= 0 ? __builtin_floor((v + PV4_TAP_HALF) / PV4_TAP_SHIFT)
                  : -__builtin_floor((-v + PV4_TAP_HALF) / PV4_TAP_SHIFT);
}

/* sgn, with NaN -> 0 as in JavaScript (both comparisons false). */
static inline double pv4_sgn(double v) {
    return v > 0 ? 1.0 : v < 0 ? -1.0 : 0.0;
}

/* The amount the leakage removes from a tap: the magnitude truncated, the
 * sign put back. pcm-v4.js leak. */
static inline double pv4_leak(double w, double div) {
    return w >= 0 ? __builtin_floor(w / div) : -__builtin_floor(-w / div);
}

/* The tap clamp, in the JavaScript's comparison order. */
static inline double pv4_clamp(double a) {
    return a > PV4_TAP_LIMIT ? PV4_TAP_LIMIT : a < -PV4_TAP_LIMIT ? -PV4_TAP_LIMIT : a;
}

/* The integer form of pv4_rshift16, for a fast path inside PV4_INT_SAFE. */
static inline int64_t pv4_round_shift_i64(int64_t v) {
    if (v < 0) return -(int64_t)((((uint64_t)0 - (uint64_t)v) + 32768u) >> 16);
    return (int64_t)(((uint64_t)v + 32768u) >> 16);
}

static inline int32_t pv4_sgn_i32(int32_t v) { return (v > 0) - (v < 0); }

/* The conversion to the output plane: x * (1/32768 * 2^shift) in double, then
 * rounded once to float32, exactly as `planes[c][i] = x * g` does into a
 * Float32Array. g is a power of two, so the product is exact and the only
 * rounding is the final one. */
static inline float pv4_out(double x, double g) { return (float)(x * g); }

/* The per-stage history slide, shared by both stage kinds. */
static inline void pv4_slide(pv4_stage *s, int complex);

/* Path counters, for tests and benchmarks: they show which code actually ran,
 * which output alone cannot -- every path produces the same bits. Incremented
 * per call, never per sample. pv4_counter() exports them. */
typedef struct {
    uint32_t kernel_frames;   /* IQ frames decoded by the order-16 block kernel */
    uint32_t frame_frames;    /* IQ frames decoded by the per-frame path */
    uint32_t kernel_exits;    /* packets the kernel entered and left early */
    uint32_t wide_packets;    /* bodies that needed the wide Rice decoder */
} pv4_counters_t;
extern pv4_counters_t pv4_counters;

/* Whether iq.c may use its block kernel (default 1). Only a test turns it off,
 * to check the per-frame path against real streams. */
extern int pv4_kernel_enabled;

/* ---- iq.c ---- */

/* Inverse (decode) of nframes complex frames from narrow residuals, writing
 * the I plane to pa and Q to pb. The residuals are interleaved I/Q int32. */
void pv4_iq_inverse(pv4_codec *c, const int32_t *res, int nframes, float *pa, float *pb, double g);
/* The same from wide residuals (doubles), on a corrupt stream. */
void pv4_iq_inverse_wide(pv4_codec *c, const double *res, int nframes, float *pa, float *pb, double g);
/* Forward (encoder direction) over verbatim little-endian int16 I/Q frames, for
 * the escape body; writes the scaled samples to pa/pb. */
void pv4_iq_escape(pv4_codec *c, const uint8_t *le16, int nframes, float *pa, float *pb, double g);
/* Forward over nframes zero frames, for the silent body. */
void pv4_iq_silent(pv4_codec *c, int nframes);

/* ---- audio.c ---- */

void pv4_audio_inverse(pv4_codec *c, const int32_t *res, int n, float *pa, double g);
void pv4_audio_inverse_wide(pv4_codec *c, const double *res, int n, float *pa, double g);
void pv4_audio_escape(pv4_codec *c, const uint8_t *le16, int n, float *pa, double g);
void pv4_audio_silent(pv4_codec *c, int n);

/* ---- rice.c ---- */

/* The smallest number of body bytes (k byte included) that could hold count
 * values at this k, used to refuse an impossible count before sizing buffers
 * for it. Each value needs its stop bit and k remainder bits. */
size_t pv4_rice_min_len(unsigned k, size_t count);

/* Decode count residuals into out, which has room for count values plus
 * PV4_RICE_SLACK. src has PV4_INPUT_SLACK readable bytes past len (zeroed):
 * a decoder may load whole words at the tail. Returns PV4_OK, PV4_WIDE (a
 * value did not fit int32: call pv4_rice_decode_wide instead; out is then
 * garbage) or a negative error, which is the JavaScript's `false` case. */
int pv4_rice_decode(const uint8_t *src, size_t len, int32_t *out, size_t count);
/* The JavaScript's riceDecode, in its own double arithmetic: exact on any
 * input, slow, and only ever reached on a corrupt stream. */
int pv4_rice_decode_wide(const uint8_t *src, size_t len, double *out, size_t count);

#define PV4_INPUT_SLACK 16
#define PV4_RICE_SLACK 8

/* ---- shim.c ---- */

void *pv4_alloc(size_t n);  /* 16-byte aligned, zeroed; NULL when memory cannot grow */
void pv4_free(void *p, size_t n);
void *memset(void *d, int c, size_t n);
void *memcpy(void *__restrict d, const void *__restrict s, size_t n);
void *memmove(void *d, const void *s, size_t n);

/* ---- definitions of the inline helpers declared above ---- */

static inline void pv4_slide(pv4_stage *s, int complex) {
    const int n = s->order, from = s->idx - n;
    for (int j = 0; j < n; ++j) {
        s->h_r[j] = s->h_r[from + j];
        s->s_r[j] = s->s_r[from + j];
    }
    if (complex) {
        for (int j = 0; j < n; ++j) {
            s->h_i[j] = s->h_i[from + j];
            s->s_i[j] = s->s_i[from + j];
        }
    }
    s->idx = n;
}

#endif
