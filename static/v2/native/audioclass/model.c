/*
 * model.c - EfficientAT mn05: its preprocessing and network, from
 * the Go original's efficientat.go, operation for operation.
 *
 * What it reproduces, from EfficientAT's models/preprocess.py and
 * the models/mn Python files at inference (model.eval()):
 *
 *   - preprocessing: 32 kHz mono; pre-emphasis y[n] = x[n+1] - 0.97 x[n];
 *     |STFT|^2 with n_fft 1024, a symmetric 800-sample Hann window centred in
 *     it, hop 320, centre padding by reflection; 128 Kaldi mel bands over
 *     0-15 kHz; log(mel + 1e-5); then (x + 4.5) / 5.
 *   - network: a 3x3 stride-2 conv; 15 inverted-residual blocks (1x1
 *     expansion, depthwise kxk, channel squeeze-excitation with a sigmoid gate
 *     where the table says so, 1x1 projection, residual when shapes allow); a
 *     1x1 conv to 6x the last width; global average pooling; Linear,
 *     hardswish (the 640-number embedding), Linear to 527 AudioSet logits;
 *     sigmoid.
 *
 * EfficientAT (github.com/fschmid56/EfficientAT) is MIT, Copyright (c) 2022
 * Florian Schmid. The weights are its official mn05_as_mAP_443.pt, read
 * directly (pt.c); BatchNorm is folded into the convolutions at load time.
 */
#include "audioclass.h"

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

#define PI 3.14159265358979323846 /* Go's math.Pi as a float64: 0x400921fb54442d18 */
#define BN_EPS 0.001

static int make_divisible(double v, int divisor) {
    int nv = (int)(v + (double)divisor / 2) / divisor * divisor;
    if (nv < divisor) nv = divisor;
    if ((double)nv < 0.9 * v) nv += divisor;
    return nv;
}

/* The MobileNetV3-Large table EfficientAT uses (models/mn/model.py):
 * input channels, kernel, expanded, output, squeeze-excitation, hardswish, stride. */
static const int TABLE[15][7] = {
    {16, 3, 16, 16, 0, 0, 1},    {16, 3, 64, 24, 0, 0, 2},    {24, 3, 72, 24, 0, 0, 1},
    {24, 5, 72, 40, 1, 0, 2},    {40, 5, 120, 40, 1, 0, 1},   {40, 5, 120, 40, 1, 0, 1},
    {40, 3, 240, 80, 0, 1, 2},   {80, 3, 200, 80, 0, 1, 1},   {80, 3, 184, 80, 0, 1, 1},
    {80, 3, 184, 80, 0, 1, 1},   {80, 3, 480, 112, 1, 1, 1},  {112, 3, 672, 112, 1, 1, 1},
    {112, 5, 672, 160, 1, 1, 2}, {160, 5, 960, 160, 1, 1, 1}, {160, 5, 960, 160, 1, 1, 1},
};

#define WIDTH 0.5 /* mn05 */

static int adj(int c) { return make_divisible((double)c * WIDTH, 8); }

/* ── loading ─────────────────────────────────────────────────────────────── */

typedef struct {
    const pt_dict *sd;
    const char *err;
    char msg[160];
} loader;

static void set_err(loader *L, const char *what, const char *key) {
    int n = 0;
    for (const char *p = "efficientat: "; *p && n < 150; p++) L->msg[n++] = *p;
    for (const char *p = key; *p && n < 150; p++) L->msg[n++] = *p;
    for (const char *p = what; *p && n < 158; p++) L->msg[n++] = *p;
    L->msg[n] = 0;
    L->err = L->msg;
}

/* The tensor `key`, which must have exactly this shape, copied to an aligned array. */
static float *get(loader *L, const char *key, int ndim, int d0, int d1, int d2, int d3) {
    if (L->err) return 0;
    const pt_tensor *t = pt_find(L->sd, key);
    if (!t) {
        set_err(L, " missing", key);
        return 0;
    }
    const int want[4] = {d0, d1, d2, d3};
    int ok = t->ndim == ndim;
    for (int i = 0; ok && i < ndim; i++) ok = t->shape[i] == want[i];
    if (!ok) {
        set_err(L, " has the wrong shape", key);
        return 0;
    }
    float *f = ac_alloc(sizeof(float) * (size_t)(t->numel ? t->numel : 1));
    if (!f) {
        L->err = "efficientat: out of memory";
        return 0;
    }
    memcpy(f, t->data, sizeof(float) * (size_t)t->numel); /* little-endian, as WebAssembly is */
    return f;
}

static void fmt_key(char *out, const char *a, int n1, const char *b, int n2, const char *c) {
    /* a + n1 + b [+ n2] + c, where n1 / n2 < 0 means "absent" */
    int k = 0;
    for (const char *p = a; *p; p++) out[k++] = *p;
    if (n1 >= 0) {
        if (n1 >= 10) out[k++] = (char)('0' + n1 / 10);
        out[k++] = (char)('0' + n1 % 10);
    }
    for (const char *p = b; *p; p++) out[k++] = *p;
    if (n2 >= 0) {
        if (n2 >= 10) out[k++] = (char)('0' + n2 / 10);
        out[k++] = (char)('0' + n2 % 10);
    }
    for (const char *p = c; *p; p++) out[k++] = *p;
    out[k] = 0;
}

/* <p>.0.weight and the BatchNorm <p>.1.*, folded: w*s, beta - mean*s with
 * s = gamma / sqrt(var + eps), in float64 as the Go original did. */
static void conv_bn(loader *L, eat_conv *c, const char *p, int cout, int cin, int k, int stride, int depthwise,
                    int act) {
    c->cout = cout;
    c->cin = cin;
    c->k = k;
    c->stride = stride;
    c->depthwise = depthwise;
    c->act = act;
    const int wcin = depthwise ? 1 : cin;
    char key[96];
    fmt_key(key, p, -1, ".0.weight", -1, "");
    float *w = get(L, key, 4, cout, wcin, k, k);
    fmt_key(key, p, -1, ".1.weight", -1, "");
    const float *g = get(L, key, 1, cout, 0, 0, 0);
    fmt_key(key, p, -1, ".1.bias", -1, "");
    const float *beta = get(L, key, 1, cout, 0, 0, 0);
    fmt_key(key, p, -1, ".1.running_mean", -1, "");
    const float *mean = get(L, key, 1, cout, 0, 0, 0);
    fmt_key(key, p, -1, ".1.running_var", -1, "");
    const float *vr = get(L, key, 1, cout, 0, 0, 0);
    if (L->err) return;
    const int per = wcin * k * k;
    float *b = ac_alloc(sizeof(float) * (size_t)cout);
    if (!b) {
        L->err = "efficientat: out of memory";
        return;
    }
    for (int o = 0; o < cout; o++) {
        const double s = (double)g[o] / go_sqrt((double)vr[o] + BN_EPS);
        for (int i = 0; i < per; i++) w[o * per + i] = (float)((double)w[o * per + i] * s);
        b[o] = (float)((double)beta[o] - (double)mean[o] * s);
    }
    c->w = w;
    c->b = b;
}

static int conv_out(int n, int k, int stride) { return (n + 2 * ((k - 1) / 2) - k) / stride + 1; }

eat_model *eat_load(const pt_dict *sd, const char **err) {
    loader L = {0};
    L.sd = sd;
    eat_model *m = ac_alloc(sizeof(eat_model));
    if (!m) {
        *err = "efficientat: out of memory";
        return 0;
    }
    conv_bn(&L, &m->first, "features.0", adj(16), 1, 3, 2, 0, ACT_HARDSWISH);
    for (int i = 0; i < 15 && !L.err; i++) {
        const int *row = TABLE[i];
        const int in = adj(row[0]), k = row[1], exp = adj(row[2]), out = adj(row[3]);
        const int act = row[5] ? ACT_HARDSWISH : ACT_RELU;
        eat_block *b = &m->blocks[i];
        char p[64];
        int j = 0;
        if (exp != in) {
            fmt_key(p, "features.", i + 1, ".block.", j, "");
            conv_bn(&L, &b->expand, p, exp, in, 1, 1, 0, act);
            b->has_expand = 1;
            j++;
        }
        fmt_key(p, "features.", i + 1, ".block.", j, "");
        conv_bn(&L, &b->dw, p, exp, exp, k, row[6], 1, act);
        j++;
        if (row[4]) {
            const int sq = make_divisible((double)(exp / 4), 8);
            eat_se *se = &b->se;
            se->c = exp;
            se->sq = sq;
            char key[96];
            fmt_key(key, "features.", i + 1, ".block.", j, ".conc_se_layers.0.fc1.weight");
            se->w1 = get(&L, key, 2, sq, exp, 0, 0);
            fmt_key(key, "features.", i + 1, ".block.", j, ".conc_se_layers.0.fc1.bias");
            se->b1 = get(&L, key, 1, sq, 0, 0, 0);
            fmt_key(key, "features.", i + 1, ".block.", j, ".conc_se_layers.0.fc2.weight");
            se->w2 = get(&L, key, 2, exp, sq, 0, 0);
            fmt_key(key, "features.", i + 1, ".block.", j, ".conc_se_layers.0.fc2.bias");
            se->b2 = get(&L, key, 1, exp, 0, 0, 0);
            b->has_se = 1;
            j++;
        }
        fmt_key(p, "features.", i + 1, ".block.", j, "");
        conv_bn(&L, &b->project, p, out, exp, 1, 1, 0, ACT_NONE);
        b->residual = row[6] == 1 && in == out;
    }
    m->nblocks = 15;
    const int last_in = adj(TABLE[14][3]);
    m->last_c = 6 * last_in;
    conv_bn(&L, &m->last, "features.16", m->last_c, last_in, 1, 1, 0, ACT_HARDSWISH);
    m->hidden = adj(1280);
    m->fc1w = get(&L, "classifier.2.weight", 2, m->hidden, m->last_c, 0, 0);
    m->fc1b = get(&L, "classifier.2.bias", 1, m->hidden, 0, 0, 0);
    m->fc2w = get(&L, "classifier.5.weight", 2, EAT_CLASSES, m->hidden, 0, 0);
    m->fc2b = get(&L, "classifier.5.bias", 1, EAT_CLASSES, 0, 0, 0);
    if (L.err) {
        *err = L.err == L.msg ? L.msg : L.err;
        /* the message lives in L, on this stack frame: copy it somewhere lasting */
        static char kept[160];
        int n = 0;
        while ((*err)[n] && n < 159) {
            kept[n] = (*err)[n];
            n++;
        }
        kept[n] = 0;
        *err = kept;
        return 0;
    }
    return m;
}

/* The largest feature map any layer writes for a window of at most
 * EAT_MAX_SECONDS: the three working buffers are each this big. */
size_t eat_max_fmap(const eat_model *m) {
    int h = EAT_MELS, w = eat_mel_frames(EAT_MAX_SECONDS * EAT_RATE);
    size_t best = 0;
#define SEE(c, hh, ww)                                     \
    do {                                                   \
        const size_t s_ = (size_t)(c) * (size_t)(hh) * (size_t)(ww); \
        if (s_ > best) best = s_;                          \
    } while (0)
    h = conv_out(h, 3, 2);
    w = conv_out(w, 3, 2);
    SEE(m->first.cout, h, w);
    for (int i = 0; i < m->nblocks; i++) {
        const eat_block *b = &m->blocks[i];
        if (b->has_expand) SEE(b->expand.cout, h, w);
        h = conv_out(h, b->dw.k, b->dw.stride);
        w = conv_out(w, b->dw.k, b->dw.stride);
        SEE(b->dw.cout, h, w);
        SEE(b->project.cout, h, w);
    }
    SEE(m->last.cout, h, w);
#undef SEE
    return best;
}

/* ── preprocessing ───────────────────────────────────────────────────────── */

static int g_mel_ready;
static int g_mel_start[EAT_MELS], g_mel_len[EAT_MELS], g_mel_off[EAT_MELS];
static float g_mel_w[EAT_MELS * 64]; /* each band's weights, from its first bin */
static double g_window[EAT_NFFT];    /* the 800-sample window centred in 1024 */

static double mel_scale(double f) { return 1127 * go_log(1 + f / 700); }

/* torchaudio.compliance.kaldi.get_mel_banks(128, 1024, 32000, 0, 15000, vtln
 * 100/-500, warp 1.0): triangles on the 1127*ln(1+f/700) scale, over the 512
 * FFT bins below Nyquist (EfficientAT pads bin 512 with zero). */
static void mel_init(void) {
    if (g_mel_ready) return;
    const double lo = mel_scale(0), hi = mel_scale(EAT_FMAX);
    const double delta = (hi - lo) / (EAT_MELS + 1);
    const double bin_w = (double)EAT_RATE / EAT_NFFT;
    int off = 0;
    for (int m = 0; m < EAT_MELS; m++) {
        const double left = lo + (double)m * delta, centre = lo + (double)(m + 1) * delta,
                     right = lo + (double)(m + 2) * delta;
        static float full[EAT_NFFT / 2];
        int start = -1, end = -1;
        for (int i = 0; i < EAT_NFFT / 2; i++) {
            full[i] = 0;
            const double f = mel_scale(bin_w * (double)i);
            const double up = (f - left) / (centre - left);
            const double down = (right - f) / (right - centre);
            double v = up < down ? up : down;
            if (v < 0) v = 0;
            if (v > 0) {
                full[i] = (float)v;
                if (start < 0) start = i;
                end = i;
            }
        }
        if (start < 0) start = end = 0;
        const int len = end - start + 1;
        g_mel_start[m] = start;
        g_mel_len[m] = len;
        g_mel_off[m] = off;
        for (int i = 0; i < len && off + i < EAT_MELS * 64; i++) g_mel_w[off + i] = full[start + i];
        off += len;
    }
    const int woff = (EAT_NFFT - EAT_WIN) / 2;
    for (int n = 0; n < EAT_WIN; n++) /* torch.hann_window(800, periodic=False) */
        g_window[woff + n] = 0.5 - 0.5 * go_cos(2 * PI * (double)n / (double)(EAT_WIN - 1));
    g_mel_ready = 1;
}

/* In-place radix-2 decimation-in-time FFT of n = 1024 complex values, as
 * the Go original's fft.go: the same bit reversal, the same twiddle recurrence
 * (w *= wlen). */
/*
 * The twiddles are the ones the Go original computed -- w = 1, then w *= wlen after each
 * butterfly, a complex multiply per step -- but that sequence is the same in
 * every block of a stage, so it is worked out once, by the same recurrence,
 * and read from a table: the same doubles, without the multiply in the inner
 * loop. Stage `half` keeps its twiddles at [half - 1, 2*half - 1).
 */
static double g_tw_re[EAT_NFFT - 1], g_tw_im[EAT_NFFT - 1];
static uint16_t g_bitrev[EAT_NFFT];
static int g_fft_ready;

static void fft_init(void) {
    if (g_fft_ready) return;
    for (int i = 1, j = 0; i < EAT_NFFT; i++) {
        int bit = EAT_NFFT >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        g_bitrev[i] = (uint16_t)j;
    }
    for (int len = 2; len <= EAT_NFFT; len <<= 1) {
        const double angle = -2 * PI / (double)len;
        const double wr_len = go_cos(angle), wi_len = go_sin(angle);
        const int half = len / 2;
        double wr = 1, wi = 0;
        for (int k = 0; k < half; k++) {
            g_tw_re[half - 1 + k] = wr;
            g_tw_im[half - 1 + k] = wi;
            const double nwr = wr * wr_len - wi * wi_len, nwi = wr * wi_len + wi * wr_len;
            wr = nwr;
            wi = nwi;
        }
    }
    g_fft_ready = 1;
}

static void fft1024(double *re, double *im) {
    const int n = EAT_NFFT;
    for (int i = 1; i < n; i++) {
        const int j = g_bitrev[i];
        if (i < j) {
            double t = re[i];
            re[i] = re[j];
            re[j] = t;
            t = im[i];
            im[i] = im[j];
            im[j] = t;
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        const int half = len / 2;
        const double *twr = g_tw_re + half - 1, *twi = g_tw_im + half - 1;
        for (int i = 0; i < n; i += len) {
            double *ar = re + i, *ai = im + i, *br = re + i + half, *bi = im + i + half;
            int k = 0;
#ifdef __wasm_simd128__
            /* Two butterflies at a time; each is the same double arithmetic
             * as the scalar loop below. */
            for (; k + 2 <= half; k += 2) {
                const v128_t wr = wasm_v128_load(twr + k), wi = wasm_v128_load(twi + k);
                const v128_t xr = wasm_v128_load(br + k), xi = wasm_v128_load(bi + k);
                const v128_t vr = wasm_f64x2_sub(wasm_f64x2_mul(xr, wr), wasm_f64x2_mul(xi, wi));
                const v128_t vi = wasm_f64x2_add(wasm_f64x2_mul(xr, wi), wasm_f64x2_mul(xi, wr));
                const v128_t ur = wasm_v128_load(ar + k), ui = wasm_v128_load(ai + k);
                wasm_v128_store(ar + k, wasm_f64x2_add(ur, vr));
                wasm_v128_store(ai + k, wasm_f64x2_add(ui, vi));
                wasm_v128_store(br + k, wasm_f64x2_sub(ur, vr));
                wasm_v128_store(bi + k, wasm_f64x2_sub(ui, vi));
            }
#endif
            for (; k < half; k++) {
                const double wr = twr[k], wi = twi[k];
                const double ur = ar[k], ui = ai[k];
                const double xr = br[k], xi = bi[k];
                const double vr = xr * wr - xi * wi, vi = xr * wi + xi * wr;
                ar[k] = ur + vr;
                ai[k] = ui + vi;
                br[k] = ur - vr;
                bi[k] = ui - vi;
            }
        }
    }
}

int eat_mel_frames(int n) { return n < 2 ? 0 : 1 + (n - 1) / EAT_HOP; }

/* The pre-emphasised sample i (reflected at the ends), computed when needed
 * rather than stored: pre[i] = x[i+1] - 0.97 x[i], in float64. */
static double pre_at(const float *x, int n, int i) {
    while (i < 0 || i >= n) {
        if (i < 0) i = -i;
        if (i >= n) i = 2 * (n - 1) - i;
    }
    return (double)x[i + 1] - 0.97 * (double)x[i];
}

void eat_mel(const float *x, int nx, float *out) {
    mel_init();
    fft_init();
    if (nx < 2) return;
    const int n = nx - 1, pad = EAT_NFFT / 2, frames = eat_mel_frames(nx);
    static double re[EAT_NFFT], im[EAT_NFFT];
    static float pw[EAT_NFFT / 2 + 1];
    const int woff = (EAT_NFFT - EAT_WIN) / 2;
    for (int t = 0; t < frames; t++) {
        const int s = t * EAT_HOP - pad;
        for (int i = 0; i < EAT_NFFT; i++) {
            re[i] = 0;
            im[i] = 0;
        }
        const int lo = s + woff, hi = s + woff + EAT_WIN;
        if (lo >= 0 && hi + 1 <= nx) {
            /* the window lies inside the audio: no reflection to work out */
            for (int i = woff; i < woff + EAT_WIN; i++) {
                const int k = s + i;
                const double w = g_window[i];
                re[i] = w != 0 ? ((double)x[k + 1] - 0.97 * (double)x[k]) * w : 0;
            }
        } else {
            for (int i = woff; i < woff + EAT_WIN; i++) {
                const double w = g_window[i];
                re[i] = w != 0 ? pre_at(x, n, s + i) * w : 0;
            }
        }
        fft1024(re, im);
        for (int k = 0; k <= EAT_NFFT / 2; k++) pw[k] = (float)(re[k] * re[k] + im[k] * im[k]);
        for (int m = 0; m < EAT_MELS; m++) {
            const double e = (double)f32_dot(g_mel_w + g_mel_off[m], pw + g_mel_start[m], g_mel_len[m]);
            out[m * frames + t] = (float)((go_log(e + 1e-5) + 4.5) / 5);
        }
    }
}

/* ── network ─────────────────────────────────────────────────────────────── */

static void activate(float *d, int n, int act) {
    if (act == ACT_RELU) {
        for (int i = 0; i < n; i++)
            if (d[i] < 0) d[i] = 0;
    } else if (act == ACT_HARDSWISH) {
        for (int i = 0; i < n; i++) {
            const float v = d[i];
            if (v <= -3)
                d[i] = 0;
            else if (v < 3)
                d[i] = v * (v + 3) / 6;
        }
    }
}

/* A 1x1 convolution: a [cout x cin] matrix times [cin x p], four input
 * channels per pass. */
static void pointwise(const float *in, int p, const eat_conv *c, float *out) {
    int o = 0;
    /* With SIMD, four output channels at a time while the input channels
     * come in fours (always, for mn05): each output gets exactly the
     * single-output loop's sums, in the same order, but every input row is
     * read once per four outputs instead of once per output. Without SIMD the
     * bookkeeping costs more than the loads it saves. */
#ifdef __wasm_simd128__
    if (c->cin % 4 == 0) {
        for (; o + 4 <= c->cout; o += 4) {
            float *d[4];
            for (int j = 0; j < 4; j++) {
                d[j] = out + (size_t)(o + j) * p;
                const float bv = c->b[o + j];
                for (int i = 0; i < p; i++) d[j][i] = bv;
            }
            for (int i = 0; i < c->cin; i += 4) {
                float w[16];
                for (int j = 0; j < 4; j++)
                    for (int k = 0; k < 4; k++) w[4 * j + k] = c->w[(size_t)(o + j) * c->cin + i + k];
                f32_axpy4x4(d, in + (size_t)i * p, in + (size_t)(i + 1) * p, in + (size_t)(i + 2) * p,
                            in + (size_t)(i + 3) * p, w, p);
            }
            for (int j = 0; j < 4; j++) activate(d[j], p, c->act);
        }
    }
#endif
    for (; o < c->cout; o++) {
        float *dst = out + (size_t)o * p;
        const float bv = c->b[o];
        for (int i = 0; i < p; i++) dst[i] = bv;
        const float *wr = c->w + (size_t)o * c->cin;
        int i = 0;
        for (; i + 4 <= c->cin; i += 4)
            f32_axpy4(dst, in + (size_t)i * p, in + (size_t)(i + 1) * p, in + (size_t)(i + 2) * p,
                      in + (size_t)(i + 3) * p, wr + i, p);
        for (; i < c->cin; i++) f32_axpy(dst, in + (size_t)i * p, wr[i], p);
        activate(dst, p, c->act);
    }
}

/* A per-channel kxk convolution with "same" padding. At stride 1 each kernel
 * tap is an axpy along a row of time; stride 2 runs plain loops. */
static void depthwise(const fmap *in, const eat_conv *c, fmap *out) {
    const int k = c->k, s = c->stride, pad = (c->k - 1) / 2;
    const int oh = conv_out(in->h, k, s), ow = conv_out(in->w, k, s);
    out->c = in->c;
    out->h = oh;
    out->w = ow;
    for (int ch = 0; ch < in->c; ch++) {
        const float *src = in->d + (size_t)ch * in->h * in->w;
        float *dst = out->d + (size_t)ch * oh * ow;
        const float *wk = c->w + (size_t)ch * k * k;
        const float bv = c->b[ch];
        for (int i = 0; i < oh * ow; i++) dst[i] = bv;
        for (int kh = 0; kh < k; kh++) {
            for (int kw = 0; kw < k; kw++) {
                const float wv = wk[kh * k + kw];
                for (int oy = 0; oy < oh; oy++) {
                    const int iy = oy * s + kh - pad;
                    if (iy < 0 || iy >= in->h) continue;
                    const float *row = src + (size_t)iy * in->w;
                    float *drow = dst + (size_t)oy * ow;
                    int ox0 = 0;
                    if (kw < pad) ox0 = (pad - kw + s - 1) / s;
                    const int num = in->w - 1 - kw + pad;
                    if (num < 0) continue;
                    int ox1 = ow;
                    const int lim = num / s;
                    if (lim + 1 < ox1) ox1 = lim + 1;
                    if (ox1 <= ox0) continue;
                    if (s == 1) {
                        f32_axpy(drow + ox0, row + ox0 + kw - pad, wv, ox1 - ox0);
                    } else {
                        for (int ox = ox0; ox < ox1; ox++) drow[ox] += wv * row[ox * s + kw - pad];
                    }
                }
            }
        }
        activate(dst, oh * ow, c->act);
    }
}

/* The 3x3 stride-2 convolution from the single mel channel. */
static void first_conv(const fmap *in, const eat_conv *c, fmap *out) {
    const int oh = conv_out(in->h, 3, 2), ow = conv_out(in->w, 3, 2);
    out->c = c->cout;
    out->h = oh;
    out->w = ow;
    for (int o = 0; o < c->cout; o++) {
        float *dst = out->d + (size_t)o * oh * ow;
        const float *wk = c->w + o * 9;
        for (int oy = 0; oy < oh; oy++) {
            for (int ox = 0; ox < ow; ox++) {
                float acc = c->b[o];
                for (int kh = 0; kh < 3; kh++) {
                    const int iy = oy * 2 + kh - 1;
                    if (iy < 0 || iy >= in->h) continue;
                    for (int kw = 0; kw < 3; kw++) {
                        const int ix = ox * 2 + kw - 1;
                        if (ix < 0 || ix >= in->w) continue;
                        acc += wk[kh * 3 + kw] * in->d[iy * in->w + ix];
                    }
                }
                dst[oy * ow + ox] = acc;
            }
        }
        activate(dst, oh * ow, c->act);
    }
}

static double fsum(const float *d, int n) {
    double s = 0;
    for (int i = 0; i < n; i++) s += (double)d[i];
    return s;
}

static void se_apply(const eat_se *se, fmap *x) {
    const int p = x->h * x->w;
    static float mean[1024], h[1024];
    for (int ch = 0; ch < se->c; ch++) mean[ch] = (float)(fsum(x->d + (size_t)ch * p, p) / (double)p);
    for (int i = 0; i < se->sq; i++) {
        float v = f32_dot(se->w1 + (size_t)i * se->c, mean, se->c) + se->b1[i];
        if (v < 0) v = 0;
        h[i] = v;
    }
    for (int ch = 0; ch < se->c; ch++) {
        const float g = f32_dot(se->w2 + (size_t)ch * se->sq, h, se->sq) + se->b2[ch];
        const float scale = (float)(1 / (1 + go_exp(-(double)g)));
        float *d = x->d + (size_t)ch * p;
        for (int i = 0; i < p; i++) d[i] *= scale;
    }
}

void eat_predict(eat_model *m, const float *mel, int frames, float *probs, float *hidden) {
    fmap spec = {1, EAT_MELS, frames, (float *)mel};
    float *B[3] = {m->buf[0], m->buf[1], m->buf[2]};
    fmap x = {0, 0, 0, B[0]};
    first_conv(&spec, &m->first, &x);
    int cur = 0; /* which buffer holds x */
    for (int bi = 0; bi < m->nblocks; bi++) {
        const eat_block *b = &m->blocks[bi];
        const int f1 = (cur + 1) % 3, f2 = (cur + 2) % 3;
        fmap in = x;
        fmap e = x;
        if (b->has_expand) {
            e.c = b->expand.cout;
            e.d = B[f1];
            pointwise(in.d, in.h * in.w, &b->expand, e.d);
        }
        fmap d = {0, 0, 0, B[f2]};
        depthwise(&e, &b->dw, &d);
        if (b->has_se) se_apply(&b->se, &d);
        /* The projection may overwrite the expansion's buffer (no longer
         * needed) but not the block input, which the residual adds back. */
        fmap pj = {b->project.cout, d.h, d.w, B[f1]};
        pointwise(d.d, d.h * d.w, &b->project, pj.d);
        if (b->residual) {
            const size_t n = (size_t)pj.c * pj.h * pj.w;
            for (size_t i = 0; i < n; i++) pj.d[i] += in.d[i];
        }
        x = pj;
        cur = f1;
    }
    fmap last = {m->last.cout, x.h, x.w, B[(cur + 1) % 3]};
    pointwise(x.d, x.h * x.w, &m->last, last.d);
    const int p = last.h * last.w;
    static float pooled[1024];
    for (int ch = 0; ch < last.c; ch++) pooled[ch] = (float)(fsum(last.d + (size_t)ch * p, p) / (double)p);
    for (int i = 0; i < m->hidden; i++) hidden[i] = f32_dot(m->fc1w + (size_t)i * last.c, pooled, last.c) + m->fc1b[i];
    activate(hidden, m->hidden, ACT_HARDSWISH);
    for (int i = 0; i < EAT_CLASSES; i++) {
        const float z = f32_dot(m->fc2w + (size_t)i * m->hidden, hidden, m->hidden) + m->fc2b[i];
        probs[i] = (float)(1 / (1 + go_exp(-(double)z)));
    }
}
