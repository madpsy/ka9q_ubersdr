/*
 * resample.c - the windowed-sinc resampler of the Go original's resample.go (from
 * ubersdr_airsplice), streaming: the page hands the classifier audio at the
 * stream's own rate (12 kHz on SSB, 24 kHz on AM and FM) and the model wants
 * 32 kHz.
 *
 * A Blackman-windowed sinc, 16 zero crossings either side at the lower of the
 * two Nyquist frequencies, one polyphase row per output phase. Fed in pieces
 * it keeps the input history the next outputs need; fed everything and
 * flushed, it gives what the one-shot resample() does.
 */
#include "audioclass.h"

#define PI 3.14159265358979323846

static double sinc(double x) {
    if (x == 0) return 1;
    return go_sin(PI * x) / (PI * x);
}

/* The Blackman window over [-width, width], zero outside. */
static double blackman(double t, double width) {
    if (t <= -width || t >= width) return 0;
    const double u = (t + width) / (2 * width);
    return 0.42 - 0.5 * go_cos(2 * PI * u) + 0.08 * go_cos(4 * PI * u);
}

static int gcd(int a, int b) {
    while (b) {
        const int t = a % b;
        a = b;
        b = t;
    }
    return a;
}

int64_t rs_max_out(const resampler *r, int64_t n) {
    if (r->pass) return n;
    return (n + r->half + 2) * r->up / r->down + 2;
}

int rs_init(resampler *r, int from, int to, int64_t max_push) {
    memset(r, 0, sizeof(*r));
    if (from == to) {
        r->pass = 1;
        return 1;
    }
    if (from <= 0 || to <= 0) return 0;
    const int g = gcd(from, to);
    const int up = to / g, down = from / g;
    const double ratio = (double)to / (double)from;
    const double rr = (1 < ratio ? 1 : ratio) * 0.95;
    const int half = (int)go_ceil(16 / rr);
    const int taps = 2 * half + 1;
    if ((int64_t)up * taps > (1 << 22)) return 0; /* a rate with no small ratio to 32 kHz */
    r->up = up;
    r->down = down;
    r->half = half;
    r->taps = taps;
    r->table = ac_alloc(sizeof(float) * (size_t)up * (size_t)taps);
    r->buf_cap = max_push + 2 * (int64_t)taps + 64;
    r->buf = ac_alloc(sizeof(float) * (size_t)r->buf_cap);
    if (!r->table || !r->buf) return 0;
    for (int p = 0; p < up; p++) {
        const double frac = (double)p / (double)up;
        float *h = r->table + (size_t)p * taps;
        double sum = 0;
        for (int k = 0; k < taps; k++) {
            const double t = (double)(k - half) - frac;
            const double v = rr * sinc(rr * t) * blackman(t, (double)half + 1);
            h[k] = (float)v;
            sum += v;
        }
        for (int k = 0; k < taps; k++) h[k] = (float)((double)h[k] / sum);
    }
    return 1;
}

static int64_t emit(resampler *r, float *out, int final) {
    int64_t w = 0;
    const int64_t total = r->in_n * r->up / r->down; /* outputs the whole input yields */
    while (r->out_n < total) {
        const int64_t pos = r->out_n * r->down;
        const int64_t base = pos / r->up;
        if (!final && base + r->half >= r->in_n) break; /* needs input not yet seen */
        const float *h = r->table + (size_t)(pos % r->up) * r->taps;
        const int64_t start = base - r->half;
        int64_t k0 = 0, k1 = r->taps;
        if (start < 0) k0 = -start;
        if (start + r->taps > r->in_n) k1 = r->in_n - start;
        float v = 0;
        if (k1 > k0) {
            const int64_t i0 = start + k0 - r->buf_start;
            v = f32_dot(h + k0, r->buf + i0, (int)(k1 - k0));
        }
        out[w++] = v;
        r->out_n++;
    }
    /* Drop input no future output reaches. */
    const int64_t next = (r->out_n * r->down) / r->up - r->half;
    int64_t drop = next - r->buf_start;
    if (drop > 0) {
        if (drop > r->buf_len) drop = r->buf_len;
        memmove(r->buf, r->buf + drop, sizeof(float) * (size_t)(r->buf_len - drop));
        r->buf_len -= drop;
        r->buf_start += drop;
    }
    return w;
}

int64_t rs_push(resampler *r, const float *x, int64_t n, float *out, int final) {
    if (r->pass) {
        (void)final;
        memcpy(out, x, sizeof(float) * (size_t)n);
        return n;
    }
    int64_t w = 0;
    const int64_t room = r->buf_cap - 2 * r->taps - 64; /* the most input one step may add */
    int64_t i = 0;
    do {
        int64_t step = n - i;
        if (step > room) step = room;
        memcpy(r->buf + r->buf_len, x + i, sizeof(float) * (size_t)step);
        r->buf_len += step;
        r->in_n += step;
        i += step;
        w += emit(r, out + w, final && i == n);
    } while (i < n);
    return w;
}
