/*
 * audioclass.h - the v2 audio classifier, in C, for WebAssembly.
 *
 * A port of the Go original (ubersdr_airsplice's efficientat.go, as this
 * directory held it until the port matched it; see git history). What the page runs is this:
 * EfficientAT's mn05 AudioSet tagger on the receiver's demodulated audio,
 * folded to voice / music / noise by NightDX's rules, plus the 640-number
 * embedding the network computes on the way (for naming signals).
 *
 * Why C: Go's WebAssembly target cannot emit SIMD, carries its runtime into
 * the module (3.6 MB) and copies every call's data across syscall/js. This is
 * freestanding C -- no libc, no imports -- built twice, with and without
 * WebAssembly SIMD (build.sh), like ../pcmv4.
 *
 * EXACTNESS
 * ---------
 * The arithmetic follows the Go original operation for operation, in the same
 * precision, so the scalar build gives that module's numbers to the last
 * bit, and so does the SIMD one: only loops whose every output element is an
 * independent chain of the same operations are vectorised (the pointwise and
 * depthwise convolutions, four elements at a time, each element computed
 * exactly as the scalar loop would). Every sum that runs along a vector -- the
 * dot products of the mel banks, the resampler and the dense layers -- stays a
 * left-to-right scalar sum, as Go's f32Dot is. exp, log, sin and cos are Go's
 * own (gomath.c), because Go's WebAssembly build used its portable versions of
 * them rather than any platform library. test.js holds the outputs to the Go
 * original's (testdata/wasm_parity.json, recorded from it) and to PyTorch.
 */
#ifndef AUDIOCLASS_H
#define AUDIOCLASS_H

#include <stddef.h>
#include <stdint.h>

/* Bumped whenever the exports or the result layout change, so the JavaScript
 * can refuse a module it does not understand. */
#define AC_ABI_VERSION 1

#define AC_EXPORT(name) __attribute__((export_name(name), visibility("default")))

/* ── shim.c: memory ─────────────────────────────────────────────────────── */

/* One bump arena in three nested regions, each freed by moving the break back
 * to where it started: the model (lives until the next load), the stream
 * (until the next reset or load), and scratch (one call). */
void *ac_alloc(size_t n);     /* zeroed, 16-byte aligned; NULL when out of memory */
size_t ac_mark(void);
void ac_release(size_t mark); /* frees everything allocated after mark */

void *memset(void *d, int c, size_t n);
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
int ac_memeq(const void *a, const void *b, size_t n);

/* ── gomath.c: Go's math, as its WebAssembly build computes it ───────────── */

double go_exp(double x);
double go_log(double x);
double go_sin(double x);
double go_cos(double x);
double go_round(double x); /* half away from zero */
static inline double go_sqrt(double x) { return __builtin_sqrt(x); }   /* f64.sqrt */
static inline double go_floor(double x) { return __builtin_floor(x); } /* f64.floor */
static inline double go_ceil(double x) { return __builtin_ceil(x); }   /* f64.ceil */

/* ── kernels.c: the float32 loops ───────────────────────────────────────── */

float f32_dot(const float *a, const float *b, int n); /* left-to-right, always scalar */
void f32_axpy(float *dst, const float *src, float a, int n);
void f32_axpy4(float *dst, const float *s0, const float *s1, const float *s2, const float *s3,
               const float w[4], int n);
void f32_axpy4x4(float *const d[4], const float *s0, const float *s1, const float *s2, const float *s3,
                 const float w[16], int n);

/* ── pt.c: a PyTorch state dict without PyTorch ─────────────────────────── */

typedef struct {
    const char *name;
    int name_len;
    int ndim;
    int shape[8];
    int numel;
    const uint8_t *data; /* numel little-endian float32, inside the file's bytes */
} pt_tensor;

typedef struct {
    pt_tensor *t;
    int n;
} pt_dict;

/* Reads the float tensors of a torch.save state dict. Allocates in the
 * current arena region; the tensors point into `pt`. Returns NULL with *err
 * set on anything unexpected: every byte of the file comes off the network. */
const pt_dict *pt_read(const uint8_t *pt, size_t len, const char **err);
const pt_tensor *pt_find(const pt_dict *d, const char *name);

/* ── model.c: the network ───────────────────────────────────────────────── */

#define EAT_RATE 32000
#define EAT_NFFT 1024
#define EAT_WIN 800
#define EAT_HOP 320
#define EAT_MELS 128
#define EAT_FMAX 15000
#define EAT_CLASSES 527
#define EAT_MAX_SECONDS 10

enum { ACT_NONE, ACT_RELU, ACT_HARDSWISH };

typedef struct {
    int cout, cin, k, stride, depthwise, act;
    float *w, *b; /* BatchNorm folded in; w: [cout][cin or 1][k][k] */
} eat_conv;

typedef struct {
    int c, sq;
    const float *w1, *b1, *w2, *b2; /* w1: [sq][c], w2: [c][sq] */
} eat_se;

typedef struct {
    int has_expand, has_se, residual;
    eat_conv expand, dw, project;
    eat_se se;
} eat_block;

typedef struct {
    eat_conv first;
    eat_block blocks[15];
    int nblocks;
    eat_conv last;
    const float *fc1w, *fc1b, *fc2w, *fc2b;
    int last_c, hidden;
    float *buf[3]; /* the feature maps, each big enough for the largest layer */
    size_t buf_floats;
} eat_model;

/* Builds mn05 (width 0.5) from a state dict. Allocates in the current region. */
eat_model *eat_load(const pt_dict *sd, const char **err);
/* The largest feature map a window of EAT_MAX_SECONDS produces, in floats. */
size_t eat_max_fmap(const eat_model *m);

typedef struct {
    int c, h, w;
    float *d;
} fmap;

/* The mel spectrogram of x (at 32 kHz) into out (1 x 128 x frames). */
int eat_mel_frames(int n);
void eat_mel(const float *x, int n, float *out);

/* probs[527] and the embedding (hidden[640]) from a mel spectrogram. */
void eat_predict(eat_model *m, const float *mel, int frames, float *probs, float *hidden);

/* ── resample.c ─────────────────────────────────────────────────────────── */

typedef struct {
    int pass;
    int64_t up, down, half, taps;
    float *table;   /* [up][taps] */
    float *buf;     /* input from global index buf_start */
    int64_t buf_len, buf_cap, buf_start;
    int64_t in_n, out_n;
} resampler;

int rs_init(resampler *r, int from, int to, int64_t max_push);
/* Adds input; writes completed outputs to out (room for rs_max_out) and
 * returns how many. final: take input past the end as zero (flush). */
int64_t rs_push(resampler *r, const float *x, int64_t n, float *out, int final);
int64_t rs_max_out(const resampler *r, int64_t n);

/* ── verdict.c: AudioSet tags to voice / music / noise (NightDX) ────────── */

enum { LABEL_VOICE, LABEL_MUSIC, LABEL_NOISE, LABEL_SILENT };

typedef struct {
    int32_t label;      /* LABEL_* */
    int32_t ntags;
    double confidence;  /* rounded to 0.001 */
    double seconds;
    int32_t tag[5];     /* AudioSet class indices, strongest first */
    int32_t pad;
    double score[5];    /* rounded to 0.001 */
} ac_result;

void verdict_init(void);
void verdict_fold(const float *probs, ac_result *res);
const char *label_name(int i, int *len);

#endif
