/*
 * api.c - the module's exports: what ../../src/lib/audioClass/workerHost.js
 * calls, and what test.js calls besides.
 *
 * The page streams the receiver's audio in at its own rate and now and then
 * asks for a verdict on the last few seconds (as the Go original's classifier.go):
 *
 *   ac_model_buffer(bytes) -> ptr   room for the .pt file; the caller copies it there
 *   ac_load() -> 0 | 1               build the model from it (1: ac_error() says why not)
 *   ac_reset(rate)                   a new stream rate, or a retune: drops the audio held
 *   ac_input() -> ptr                room for AC_CHUNK float32 samples ...
 *   ac_push(n)                       ... of which the first n are new audio
 *   ac_classify(seconds) -> 0 | 1    1: ac_result() holds a verdict on the last
 *                                    `seconds`; 0: too little audio held, or no model
 *
 * and to read results: ac_result() (an ac_result, see audioclass.h),
 * ac_label(i) / ac_label_len(i) (AudioSet names), ac_probs() (527 floats) and
 * ac_embedding() (ac_embedding_size() floats) for the window just classified.
 *
 * Memory, in the order it is created (shim.c): the model region (from
 * ac_model_buffer), then the stream region (from ac_reset); a call needs
 * nothing more. Pointers into a region are valid until it is recreated: the
 * caller asks for ac_input() again after a reset.
 */
#include "audioclass.h"

/* The most audio taken per ac_push: the page posts 100 ms at a time, 4800
 * samples at the highest rate it uses. */
#define AC_CHUNK 16384

#define MAX_WINDOW_SEC 10 /* the longest window a caller may ask for */
#define MIN_WINDOW_SEC 1
/* A window quieter than this (about -80 dBFS) is not classified at all: the
 * digital silence of a closed squelch or a muted stream. */
#define SILENT_RMS 1e-4

static eat_model *g_model;
static size_t g_model_mark;  /* the bottom of the model region */
static size_t g_stream_mark; /* the bottom of the stream region */
static uint8_t *g_pt;
static size_t g_pt_len;
static const pt_dict *g_probe; /* ac_pt_open's result, for tests */
static const char *g_err = "";

static int g_rate;
static resampler g_rs;
static float *g_in;     /* AC_CHUNK samples at the stream rate */
static float *g_buf;    /* the newest audio at 32 kHz, oldest first */
static int64_t g_len, g_cap;
static float *g_mel;

static ac_result g_res;
static float g_probs[EAT_CLASSES];
static float g_hidden[1280];

AC_EXPORT("ac_abi") int ac_abi(void) { return AC_ABI_VERSION; }

AC_EXPORT("ac_error") const char *ac_error(void) { return g_err; }

AC_EXPORT("ac_error_len") int ac_error_len(void) {
    int n = 0;
    while (g_err[n]) n++;
    return n;
}

/* The regions start at the bottom of the arena, whichever export runs first. */
static void marks(void) {
    if (!g_model_mark) g_model_mark = g_stream_mark = ac_mark();
}

static void drop_stream(void) {
    g_rate = 0;
    g_in = 0;
    g_buf = 0;
    g_len = g_cap = 0;
    memset(&g_rs, 0, sizeof(g_rs));
}

AC_EXPORT("ac_model_buffer") uint8_t *ac_model_buffer(size_t n) {
    marks();
    ac_release(g_model_mark);
    g_model = 0;
    g_probe = 0;
    drop_stream();
    g_pt = ac_alloc(n);
    g_pt_len = g_pt ? n : 0;
    g_stream_mark = ac_mark();
    return g_pt;
}

/* Every pointer the model holds, moved down by delta. */
static void relocate(eat_model *m, uintptr_t delta) {
#define MV(p) (p) = (void *)((uintptr_t)(p) - delta)
    MV(m->first.w);
    MV(m->first.b);
    for (int i = 0; i < m->nblocks; i++) {
        eat_block *b = &m->blocks[i];
        if (b->has_expand) {
            MV(b->expand.w);
            MV(b->expand.b);
        }
        MV(b->dw.w);
        MV(b->dw.b);
        if (b->has_se) {
            MV(b->se.w1);
            MV(b->se.b1);
            MV(b->se.w2);
            MV(b->se.b2);
        }
        MV(b->project.w);
        MV(b->project.b);
    }
    MV(m->last.w);
    MV(m->last.b);
    MV(m->fc1w);
    MV(m->fc1b);
    MV(m->fc2w);
    MV(m->fc2b);
#undef MV
}

AC_EXPORT("ac_load") int ac_load(void) {
    marks();
    if (!g_pt) {
        g_err = "no model bytes";
        return 1;
    }
    g_model = 0;
    g_probe = 0;
    drop_stream();
    ac_release(g_stream_mark);
    const pt_dict *sd = pt_read(g_pt, g_pt_len, &g_err);
    if (!sd) return 1;
    const size_t model_start = ac_mark();
    eat_model *m = eat_load(sd, &g_err);
    if (!m) {
        ac_release(g_stream_mark);
        return 1;
    }
    /* The weights are copies, so the file (and the parse of it) can go: move
     * the model down over them. */
    const size_t model_end = ac_mark();
    const uintptr_t delta = model_start - g_model_mark;
    memmove((void *)g_model_mark, (void *)model_start, model_end - model_start);
    m = (eat_model *)((uintptr_t)m - delta);
    relocate(m, delta);
    ac_release(g_model_mark + (model_end - model_start));
    g_pt = 0;
    g_pt_len = 0;

    m->buf_floats = eat_max_fmap(m);
    for (int i = 0; i < 3; i++) m->buf[i] = ac_alloc(sizeof(float) * m->buf_floats);
    g_mel = ac_alloc(sizeof(float) * EAT_MELS * (size_t)eat_mel_frames(EAT_MAX_SECONDS * EAT_RATE));
    if (!m->buf[0] || !m->buf[1] || !m->buf[2] || !g_mel) {
        g_err = "out of memory";
        ac_release(g_model_mark);
        return 1;
    }
    verdict_init();
    g_model = m;
    g_stream_mark = ac_mark();
    g_err = "";
    return 0;
}

AC_EXPORT("ac_reset") int ac_reset(int rate) {
    marks();
    ac_release(g_stream_mark);
    drop_stream();
    if (rate <= 0) return 0;
    if (!rs_init(&g_rs, rate, EAT_RATE, AC_CHUNK)) {
        drop_stream();
        return 1;
    }
    const int64_t keep = (int64_t)MAX_WINDOW_SEC * EAT_RATE;
    g_cap = 2 * keep + rs_max_out(&g_rs, AC_CHUNK);
    g_buf = ac_alloc(sizeof(float) * (size_t)g_cap);
    g_in = ac_alloc(sizeof(float) * AC_CHUNK);
    if (!g_buf || !g_in) {
        drop_stream();
        return 1;
    }
    g_rate = rate;
    return 0;
}

AC_EXPORT("ac_input") float *ac_input(void) { return g_in; }
AC_EXPORT("ac_input_capacity") int ac_input_capacity(void) { return AC_CHUNK; }

AC_EXPORT("ac_push") void ac_push(int n) {
    if (!g_rate || n <= 0) return;
    if (n > AC_CHUNK) n = AC_CHUNK;
    g_len += rs_push(&g_rs, g_in, n, g_buf + g_len, 0);
    /* Trimmed in steps rather than on every push, so the copy runs once per
     * ten seconds of audio rather than once per packet. */
    const int64_t keep = (int64_t)MAX_WINDOW_SEC * EAT_RATE;
    if (g_len > 2 * keep) {
        memmove(g_buf, g_buf + (g_len - keep), sizeof(float) * (size_t)keep);
        g_len = keep;
    }
}

AC_EXPORT("ac_buffered") double ac_buffered(void) { return (double)g_len / EAT_RATE; }

/* One verdict on x, which is at 32 kHz (the Go original's classifyWindow). */
static void classify_window(const float *x, int n) {
    memset(&g_res, 0, sizeof(g_res));
    g_res.seconds = (double)n / EAT_RATE;
    double sum = 0;
    for (int i = 0; i < n; i++) sum += (double)x[i] * (double)x[i];
    if (n == 0 || go_sqrt(sum / (double)n) < SILENT_RMS) {
        g_res.label = LABEL_SILENT;
        return;
    }
    const int frames = eat_mel_frames(n);
    eat_mel(x, n, g_mel);
    eat_predict(g_model, g_mel, frames, g_probs, g_hidden);
    verdict_fold(g_probs, &g_res);
}

AC_EXPORT("ac_classify") int ac_classify(double sec) {
    if (sec < MIN_WINDOW_SEC) sec = MIN_WINDOW_SEC;
    if (sec > MAX_WINDOW_SEC) sec = MAX_WINDOW_SEC;
    const int n = (int)(sec * EAT_RATE);
    if (!g_model || g_len < n) return 0;
    classify_window(g_buf + (g_len - n), n);
    return 1;
}

AC_EXPORT("ac_result") ac_result *ac_result_ptr(void) { return &g_res; }
AC_EXPORT("ac_probs") float *ac_probs(void) { return g_probs; }
AC_EXPORT("ac_embedding") float *ac_embedding(void) { return g_hidden; }
AC_EXPORT("ac_embedding_size") int ac_embedding_size(void) { return g_model ? g_model->hidden : 0; }

AC_EXPORT("ac_label") const char *ac_label(int i) {
    int n;
    return label_name(i, &n);
}

AC_EXPORT("ac_label_len") int ac_label_len(int i) {
    int n;
    label_name(i, &n);
    return n;
}

/* ── for test.js ─────────────────────────────────────────────────────────── */

/* Room for n floats in the stream region (gone at the next reset or load). */
AC_EXPORT("ac_test_buffer") float *ac_test_buffer(int n) { return n > 0 ? ac_alloc(sizeof(float) * (size_t)n) : 0; }

/* A verdict on n samples at 32 kHz the caller put in memory, bypassing the
 * stream: what the reference tests feed the network. */
AC_EXPORT("ac_window") int ac_window(const float *x, int n) {
    if (!g_model || n < 0 || n > MAX_WINDOW_SEC * EAT_RATE) return 0;
    classify_window(x, n);
    return 1;
}

/* The mel spectrogram of the last window run through the model. */
AC_EXPORT("ac_mel") float *ac_mel(void) { return g_mel; }
AC_EXPORT("ac_mel_frames") int ac_mel_frames(int n) { return eat_mel_frames(n); }

/* One-shot resampling, as the Go original's resample(): push everything, then
 * flush. Returns the number of outputs written. */
AC_EXPORT("ac_test_resample") int ac_test_resample(const float *x, int n, int from, int to, float *out) {
    const size_t mark = ac_mark();
    resampler r;
    if (!rs_init(&r, from, to, n)) return -1;
    const int64_t w = rs_push(&r, x, n, out, 1);
    ac_release(mark);
    return (int)w;
}

/* The .pt reader on its own: parse the bytes at ac_model_buffer without
 * building a model, then look at what it found. */
AC_EXPORT("ac_pt_open") int ac_pt_open(void) {
    marks();
    g_model = 0;
    drop_stream();
    ac_release(g_stream_mark);
    g_probe = g_pt ? pt_read(g_pt, g_pt_len, &g_err) : 0;
    return g_probe ? g_probe->n : -1;
}

static const pt_tensor *probe(int i) { return g_probe && i >= 0 && i < g_probe->n ? &g_probe->t[i] : 0; }
AC_EXPORT("ac_pt_name") const char *ac_pt_name(int i) { return probe(i) ? probe(i)->name : 0; }
AC_EXPORT("ac_pt_name_len") int ac_pt_name_len(int i) { return probe(i) ? probe(i)->name_len : 0; }
AC_EXPORT("ac_pt_ndim") int ac_pt_ndim(int i) { return probe(i) ? probe(i)->ndim : -1; }
AC_EXPORT("ac_pt_dim") int ac_pt_dim(int i, int d) { return probe(i) && d >= 0 && d < 8 ? probe(i)->shape[d] : -1; }
AC_EXPORT("ac_pt_numel") int ac_pt_numel(int i) { return probe(i) ? probe(i)->numel : -1; }
AC_EXPORT("ac_pt_data") const uint8_t *ac_pt_data(int i) { return probe(i) ? probe(i)->data : 0; }

/* Only the mel spectrogram of n samples at 32 kHz: for bench.js. */
AC_EXPORT("ac_bench_mel") void ac_bench_mel(const float *x, int n) {
    if (g_mel && n > 0 && n <= MAX_WINDOW_SEC * EAT_RATE) eat_mel(x, n, g_mel);
}
