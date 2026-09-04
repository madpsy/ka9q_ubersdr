/*
 * pcm_v4.c — decoder for UberSDR audio protocol version 4. See pcm_v4.h for
 * what it is and why the arithmetic below is load-bearing.
 */

#include "pcm_v4.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------------- */
/* Wire constants                                                            */
/* ------------------------------------------------------------------------- */

/* Flag bits in the header's flags byte. */
#define FLAG_ESCAPE   0x80
#define FLAG_QUALITY  0x40
#define FLAG_METADATA 0x20
#define FLAG_SILENT   0x10
#define FLAG_COUNT    0x08
#define PROFILE_MASK  0x07

/* The codepoint for "radiod reported nothing". It stands in for the -999
 * sentinel, which cannot be represented in centidecibels: -99900 overflows an
 * int16. */
#define QUALITY_NO_READING ((int16_t)-32768)

/* Fixed-point scale of the filter taps: integers in Q16, so 65536 is 1.0. */
#define TAP_SHIFT 16

/* |tap| is bounded to 2^24, a real magnitude of 256, which caps the prediction
 * sum far below int64 overflow whatever the input does. Adaptation settles
 * around 2^16, so this is insurance that never fires in practice — but it must
 * be applied identically on both sides, because if it ever does fire the two
 * must agree. */
#define TAP_LIMIT ((int64_t)1 << 24)

/* The escape and profile bits as the payload carries them. The version 4 header
 * carries both itself, so the body is handed the flags separately. */
#define PAYLOAD_ESCAPE_FLAG 0x80
#define PAYLOAD_PROFILE_MASK 0x0f

static void seterr(char *err, size_t errlen, const char *msg)
{
    if (err && errlen) snprintf(err, errlen, "%s", msg);
}

/* ------------------------------------------------------------------------- */
/* Integer helpers                                                           */
/*                                                                           */
/* Written to be exactly the Go server's arithmetic on every compiler rather  */
/* than merely usually: negation goes through unsigned so INT64_MIN cannot    */
/* overflow, and no result depends on how C shifts a negative value right,    */
/* which the standard leaves implementation-defined.                          */
/* ------------------------------------------------------------------------- */

static inline int64_t pred_sign(int64_t v)
{
    return (int64_t)(v > 0) - (int64_t)(v < 0);
}

/*
 * Divide by 2^shift, rounding to nearest and away from zero on ties.
 *
 * A plain arithmetic shift would round negative values towards negative
 * infinity, biasing the predictor — and, more to the point, the server rounds
 * this way, so this is the single definition both sides must use.
 */
static inline int64_t pred_round_shift(int64_t v, unsigned shift)
{
    const uint64_t half = (uint64_t)1 << (shift - 1);
    if (v < 0) {
        const uint64_t mag = (uint64_t)0 - (uint64_t)v; /* |v|, no signed overflow */
        return -(int64_t)((mag + half) >> shift);
    }
    return (int64_t)(((uint64_t)v + half) >> shift);
}

static inline int64_t pred_clamp_tap(int64_t w)
{
    if (w > TAP_LIMIT) return TAP_LIMIT;
    if (w < -TAP_LIMIT) return -TAP_LIMIT;
    return w;
}

/* Go's bits.TrailingZeros64, including its answer of 64 for zero — which the
 * Rice decoder relies on and __builtin_ctzll leaves undefined. */
static inline unsigned pred_ctz64(uint64_t x)
{
    if (x == 0) return 64;
#if defined(__GNUC__) || defined(__clang__)
    return (unsigned)__builtin_ctzll(x);
#else
    unsigned n = 0;
    while ((x & 1) == 0) { x >>= 1; ++n; }
    return n;
#endif
}

/*
 * History window for a given filter order.
 *
 * Kept linear rather than circular so the tap loops walk contiguous memory with
 * no index wrapping, which matters at the 1098 packets a second a 384 kHz
 * stream delivers. The cost is periodically sliding the newest `order` entries
 * back to the front; making the window several times the order amortises that
 * to nothing.
 */
static int pred_history_len(int order)
{
    int n = order * 8;
    return n < 64 ? 64 : n;
}

static float quality_to_float(int16_t q)
{
    if (q == QUALITY_NO_READING) return -999.0f;
    return (float)((double)q / 100.0);
}

/* ------------------------------------------------------------------------- */
/* Adaptive filter stages                                                    */
/*                                                                           */
/* Sign-sign LMS rather than true NLMS: the update needs only the signs of the */
/* error and of the history, so it costs two multiplies per tap with no       */
/* division and no normalisation, and is exactly reproducible in integers.    */
/* ------------------------------------------------------------------------- */

static bool cstage_init(struct pcmv4_cstage *f, int order, int64_t mu)
{
    const int n = pred_history_len(order);
    memset(f, 0, sizeof(*f));
    f->order = order;
    f->mu = mu;
    f->hlen = n;
    f->idx = order;
    f->wr = calloc((size_t)order, sizeof(int64_t));
    f->wi = calloc((size_t)order, sizeof(int64_t));
    f->hr = calloc((size_t)n, sizeof(int64_t));
    f->hi = calloc((size_t)n, sizeof(int64_t));
    f->sr = calloc((size_t)n, sizeof(int64_t));
    f->si = calloc((size_t)n, sizeof(int64_t));
    return f->wr && f->wi && f->hr && f->hi && f->sr && f->si;
}

static void cstage_free(struct pcmv4_cstage *f)
{
    free(f->wr); free(f->wi); free(f->hr); free(f->hi); free(f->sr); free(f->si);
    memset(f, 0, sizeof(*f));
}

/*
 * Decide once per packet whether adapt may skip the tap clamp.
 *
 * One complex update moves a tap by at most 2*mu — each of the two sign terms
 * contributes at most mu — so if every tap starts further than 2*mu*steps from
 * the limit, no update in this packet can reach it and the clamp is an
 * identity. The server makes the same decision from the same taps, so the two
 * take the same path; the clamped loop produces identical values anyway when it
 * does run.
 */
static void cstage_begin_packet(struct pcmv4_cstage *f, int steps)
{
    int64_t max_abs = 0;
    for (int j = 0; j < f->order; j++) {
        int64_t w = f->wr[j] < 0 ? -f->wr[j] : f->wr[j];
        if (w > max_abs) max_abs = w;
        w = f->wi[j] < 0 ? -f->wi[j] : f->wi[j];
        if (w > max_abs) max_abs = w;
    }
    f->fast = max_abs + 2 * f->mu * (int64_t)steps <= TAP_LIMIT;
}

static void cstage_predict(const struct pcmv4_cstage *f, int64_t *pr, int64_t *pi)
{
    const int order = f->order;
    const int lo = f->idx - order;
    int64_t ar = 0, ai = 0;
    for (int j = 0; j < order; j++) {
        const int64_t br = f->hr[lo + j], bi = f->hi[lo + j];
        const int64_t w = f->wr[j], wv = f->wi[j];
        ar += w * br - wv * bi;
        ai += w * bi + wv * br;
    }
    *pr = pred_round_shift(ar, TAP_SHIFT);
    *pi = pred_round_shift(ai, TAP_SHIFT);
}

/*
 * Nudge each tap by mu in the direction that would have reduced this error. The
 * conjugate of the history is used, as the complex LMS gradient requires; here
 * that is the negated sign of the imaginary part.
 *
 * A zero error is a genuine no-op — both steps are zero and every tap is
 * already inside the clamp — which turns the adapt pass over silence into a
 * return.
 */
static void cstage_adapt(struct pcmv4_cstage *f, int64_t er, int64_t ei)
{
    if (er == 0 && ei == 0) return;
    const int64_t mr = f->mu * pred_sign(er);
    const int64_t mi = f->mu * pred_sign(ei);
    const int order = f->order;
    const int lo = f->idx - order;
    if (f->fast) {
        for (int j = 0; j < order; j++) {
            const int64_t hrs = f->sr[lo + j];
            const int64_t his = -f->si[lo + j];
            f->wr[j] += mr * hrs - mi * his;
            f->wi[j] += mr * his + mi * hrs;
        }
        return;
    }
    for (int j = 0; j < order; j++) {
        const int64_t hrs = f->sr[lo + j];
        const int64_t his = -f->si[lo + j];
        f->wr[j] = pred_clamp_tap(f->wr[j] + mr * hrs - mi * his);
        f->wi[j] = pred_clamp_tap(f->wi[j] + mr * his + mi * hrs);
    }
}

static void cstage_push(struct pcmv4_cstage *f, int64_t xr, int64_t xi)
{
    f->hr[f->idx] = xr;
    f->hi[f->idx] = xi;
    f->sr[f->idx] = pred_sign(xr);
    f->si[f->idx] = pred_sign(xi);
    f->idx++;
    if (f->idx == f->hlen) {
        const int n = f->order;
        for (int j = 0; j < n; j++) {
            f->hr[j] = f->hr[f->idx - n + j];
            f->hi[j] = f->hi[f->idx - n + j];
            f->sr[j] = f->sr[f->idx - n + j];
            f->si[j] = f->si[f->idx - n + j];
        }
        f->idx = n;
    }
}

/* Encoder direction: the residual for a known sample. The decoder needs it to
 * advance the filters across an escaped or silent packet exactly as the encoder
 * did. */
static void cstage_forward(struct pcmv4_cstage *f, int64_t xr, int64_t xi,
                           int64_t *er, int64_t *ei)
{
    int64_t pr, pi;
    cstage_predict(f, &pr, &pi);
    *er = xr - pr;
    *ei = xi - pi;
    cstage_adapt(f, *er, *ei);
    cstage_push(f, xr, xi);
}

/* Decoder direction: reconstruct a sample from its residual, performing the
 * same prediction, adaptation and history update as forward. */
static void cstage_inverse(struct pcmv4_cstage *f, int64_t er, int64_t ei,
                           int64_t *xr, int64_t *xi)
{
    int64_t pr, pi;
    cstage_predict(f, &pr, &pi);
    *xr = er + pr;
    *xi = ei + pi;
    cstage_adapt(f, er, ei);
    cstage_push(f, *xr, *xi);
}

/* The real form: pcmv4_cstage with the imaginary terms removed, for mono
 * audio. Same fast flag and tap ordering. */
static bool rstage_init(struct pcmv4_rstage *f, int order, int64_t mu)
{
    const int n = pred_history_len(order);
    memset(f, 0, sizeof(*f));
    f->order = order;
    f->mu = mu;
    f->hlen = n;
    f->idx = order;
    f->w = calloc((size_t)order, sizeof(int64_t));
    f->h = calloc((size_t)n, sizeof(int64_t));
    f->s = calloc((size_t)n, sizeof(int64_t));
    return f->w && f->h && f->s;
}

static void rstage_free(struct pcmv4_rstage *f)
{
    free(f->w); free(f->h); free(f->s);
    memset(f, 0, sizeof(*f));
}

/* One real update moves a tap by at most mu, so the bound is mu*steps. */
static void rstage_begin_packet(struct pcmv4_rstage *f, int steps)
{
    int64_t max_abs = 0;
    for (int j = 0; j < f->order; j++) {
        const int64_t w = f->w[j] < 0 ? -f->w[j] : f->w[j];
        if (w > max_abs) max_abs = w;
    }
    f->fast = max_abs + f->mu * (int64_t)steps <= TAP_LIMIT;
}

static int64_t rstage_predict(const struct pcmv4_rstage *f)
{
    const int order = f->order;
    const int lo = f->idx - order;
    int64_t p = 0;
    for (int j = 0; j < order; j++) p += f->w[j] * f->h[lo + j];
    return pred_round_shift(p, TAP_SHIFT);
}

static void rstage_adapt(struct pcmv4_rstage *f, int64_t e)
{
    if (e == 0) return;
    const int64_t m = f->mu * pred_sign(e);
    const int order = f->order;
    const int lo = f->idx - order;
    if (f->fast) {
        for (int j = 0; j < order; j++) f->w[j] += m * f->s[lo + j];
        return;
    }
    for (int j = 0; j < order; j++) f->w[j] = pred_clamp_tap(f->w[j] + m * f->s[lo + j]);
}

static void rstage_push(struct pcmv4_rstage *f, int64_t x)
{
    f->h[f->idx] = x;
    f->s[f->idx] = pred_sign(x);
    f->idx++;
    if (f->idx == f->hlen) {
        const int n = f->order;
        for (int j = 0; j < n; j++) {
            f->h[j] = f->h[f->idx - n + j];
            f->s[j] = f->s[f->idx - n + j];
        }
        f->idx = n;
    }
}

static int64_t rstage_forward(struct pcmv4_rstage *f, int64_t x)
{
    const int64_t p = rstage_predict(f);
    const int64_t e = x - p;
    rstage_adapt(f, e);
    rstage_push(f, x);
    return e;
}

static int64_t rstage_inverse(struct pcmv4_rstage *f, int64_t e)
{
    const int64_t p = rstage_predict(f);
    const int64_t x = e + p;
    rstage_adapt(f, e);
    rstage_push(f, x);
    return x;
}

/* ------------------------------------------------------------------------- */
/* Rice coding of residuals                                                  */
/*                                                                           */
/* A residual is coded as its zigzagged magnitude split at bit k: the high    */
/* part in unary, then a stop bit, then the low k bits raw. k is chosen per   */
/* packet by the encoder and sent as the first byte of the body.             */
/* ------------------------------------------------------------------------- */

#define RICE_REFILL()                                    \
    while (nbits <= 56 && i < len) {                     \
        acc |= (uint64_t)src[i] << nbits;                \
        ++i;                                             \
        nbits += 8;                                      \
    }

static bool rice_decode(const uint8_t *src, size_t len, int32_t *out, size_t count,
                        char *err, size_t errlen)
{
    if (len < 1) { seterr(err, errlen, "rice: empty bitstream"); return false; }
    const unsigned k = src[0];
    if (k > 30) { seterr(err, errlen, "rice: invalid k"); return false; }
    ++src;
    --len;

    uint64_t acc = 0;
    unsigned nbits = 0;
    size_t i = 0;

    RICE_REFILL()
    const uint64_t mask = ((uint64_t)1 << k) - 1;

    for (size_t j = 0; j < count; j++) {
        if (nbits < 48) { RICE_REFILL() }

        unsigned q = 0;
        for (;;) {
            /* Bits past nbits read as zero, so a unary run that reaches the end
             * of the accumulator simply continues after a refill. */
            const unsigned c = pred_ctz64(~acc);
            if (c < nbits) {
                q += c;
                /* The shift is by c+1, which reaches 64 when a 63-bit unary run
                 * is counted out of a full accumulator -- nbits tops out at
                 * exactly 64 because the refill runs while nbits <= 56. Go's
                 * shift yields zero there; a C shift of a uint64_t by 64 is
                 * undefined, and on x86 the count is taken modulo 64, so the
                 * accumulator keeps every bit it had and the next refill ORs
                 * fresh bytes into stale ones. The rest of the packet then
                 * decodes as garbage, which the backward-adaptive predictor
                 * feeds into its taps -- so the stream stays wrong for the life
                 * of the connection, silently, unless the damage happens to
                 * make the bitstream unparseable. */
                const unsigned sh = c + 1;
                acc = (sh >= 64) ? 0 : (acc >> sh);
                nbits -= sh;
                break;
            }
            if (i >= len) { seterr(err, errlen, "rice: truncated bitstream"); return false; }
            q += nbits;
            acc = 0;
            nbits = 0;
            RICE_REFILL()
        }

        if (nbits < k) { RICE_REFILL() }
        if (nbits < k) { seterr(err, errlen, "rice: truncated remainder"); return false; }
        const uint32_t u = ((uint32_t)q << k) | (uint32_t)(acc & mask);
        acc >>= k;
        nbits -= k;
        /* Undo the zigzag. */
        out[j] = (int32_t)((u >> 1) ^ ((uint32_t)0 - (u & 1)));
    }
    return true;
}

/* ------------------------------------------------------------------------- */
/* Varints, as encoding/binary writes them                                   */
/* ------------------------------------------------------------------------- */

static bool read_uvarint(const uint8_t *p, size_t len, size_t *off, uint64_t *out)
{
    uint64_t x = 0;
    unsigned shift = 0;
    for (int n = 0; n < 10; n++) {
        if (*off >= len) return false;
        const uint8_t b = p[(*off)++];
        if (b < 0x80) {
            if (n == 9 && b > 1) return false; /* would overflow 64 bits */
            *out = x | ((uint64_t)b << shift);
            return true;
        }
        x |= (uint64_t)(b & 0x7f) << shift;
        shift += 7;
    }
    return false;
}

/* Signed varints are zigzagged before the unsigned encoding, so small negative
 * deltas stay one byte. */
static bool read_varint(const uint8_t *p, size_t len, size_t *off, int64_t *out)
{
    uint64_t ux;
    if (!read_uvarint(p, len, off, &ux)) return false;
    *out = (int64_t)((ux >> 1) ^ ((uint64_t)0 - (ux & 1)));
    return true;
}

/* ------------------------------------------------------------------------- */
/* Codec                                                                     */
/* ------------------------------------------------------------------------- */

static void codec_free(struct pcmv4_codec *c)
{
    for (int i = 0; i < c->ncx; i++) cstage_free(&c->cx[i]);
    for (int i = 0; i < c->nrl; i++) rstage_free(&c->rl[i]);
    free(c->res);
    memset(c, 0, sizeof(*c));
    c->profile = 0xff;
}

/*
 * Build for a profile id, refusing one this build does not implement.
 *
 * The error is deliberate. Falling back to a default profile would decode a
 * stream with the wrong predictor and return plausible-looking noise rather
 * than failing, which is the worst possible behaviour for a codec whose entire
 * promise is bit-exactness.
 */
static bool codec_configure(struct pcmv4_codec *c, uint8_t profile,
                            char *err, size_t errlen)
{
    if (c->profile == profile) return true;

    int32_t *keep_res = c->res;
    size_t keep_cap = c->res_cap;
    c->res = NULL;
    c->res_cap = 0;
    codec_free(c);
    c->res = keep_res;
    c->res_cap = keep_cap;

    bool ok = true;
    switch (profile) {
    case PCMV4_PROFILE_IQ:
    case PCMV4_PROFILE_IQ_SCALED:
        /* A single complex filter of order 16. Deeper cascades were measured
         * and rejected for IQ: 8/8/4/2 gave 1.391x against this profile's
         * 1.396x at roughly double the CPU.
         *
         * The scaled profile shares this predictor exactly: the requantisation
         * it names happens before the encoder's filters and after this
         * decoder's, so nothing inside them differs. Only the extra shift byte
         * in front of the body and the shift back on the way out do. */
        c->is_complex = true;
        ok = cstage_init(&c->cx[0], 16, 16);
        c->ncx = 1;
        break;
    case PCMV4_PROFILE_AUDIO:
        /* Depth matters far more than filter length on demodulated audio,
         * which carries a ~2.65 kHz passband in a 12 kHz channel: 1.370x for
         * one order-16 filter against 1.889x for this cascade. */
        c->is_complex = false;
        ok  = rstage_init(&c->rl[0], 8, 16);
        ok &= rstage_init(&c->rl[1], 8, 16);
        ok &= rstage_init(&c->rl[2], 4, 32);
        ok &= rstage_init(&c->rl[3], 2, 32);
        c->nrl = 4;
        break;
    default:
        seterr(err, errlen, "predictive codec: unknown profile id");
        c->profile = 0xff;
        return false;
    }
    if (!ok) {
        seterr(err, errlen, "predictive codec: out of memory");
        codec_free(c);
        return false;
    }
    c->profile = profile;
    return true;
}

static int codec_step(const struct pcmv4_codec *c)
{
    return c->is_complex ? 2 : 1;
}

/* Let every stage decide once, from where its taps stand, whether this packet's
 * adapt calls may skip the clamp. steps is how many times each stage will
 * adapt: sample count for a real cascade, frame count for a complex one. */
static void codec_begin_packet(struct pcmv4_codec *c, int steps)
{
    for (int i = 0; i < c->ncx; i++) cstage_begin_packet(&c->cx[i], steps);
    for (int i = 0; i < c->nrl; i++) rstage_begin_packet(&c->rl[i], steps);
}

/* The cascade in the encoder direction over one sample position, which is how
 * the filters are advanced across a packet whose samples are already known — an
 * escape, or the implied zeros of a silent packet. */
static void codec_forward(struct pcmv4_codec *c, int64_t a, int64_t b)
{
    if (c->is_complex) {
        for (int i = 0; i < c->ncx; i++) {
            int64_t er, ei;
            cstage_forward(&c->cx[i], a, b, &er, &ei);
            a = er;
            b = ei;
        }
        return;
    }
    for (int i = 0; i < c->nrl; i++) a = rstage_forward(&c->rl[i], a);
}

/*
 * Undo the reduced-depth scale, saturating rather than wrapping.
 *
 * The predictor ran on the quantised values, exactly as the encoder's did, so
 * this is the last thing that happens to a packet and no codec state depends
 * on it. Saturation matches the server's lossyRestore: a value the shift
 * carries past full scale must not come back with its sign inverted.
 */
static void lossy_restore(int16_t *samples, int count, unsigned shift)
{
    if (shift == 0) return;
    /* A multiply rather than a shift: C leaves a left shift of a negative value
     * undefined, and half of these samples are negative. Multiplying by the
     * same power of two is exactly the shift, defined for every input, and the
     * product cannot leave int64 for any int16 and a shift of 15. */
    const int64_t scale = (int64_t)1 << shift;
    for (int i = 0; i < count; i++) {
        int64_t r = (int64_t)samples[i] * scale;
        if (r > 32767) r = 32767;
        else if (r < -32768) r = -32768;
        samples[i] = (int16_t)r;
    }
}

/* ------------------------------------------------------------------------- */
/* Public interface                                                          */
/* ------------------------------------------------------------------------- */

void pcmv4_stream_init(struct pcmv4_stream *s)
{
    memset(s, 0, sizeof(*s));
    s->codec.profile = 0xff;
}

void pcmv4_stream_free(struct pcmv4_stream *s)
{
    codec_free(&s->codec);
    free(s->samples);
    memset(s, 0, sizeof(*s));
    s->codec.profile = 0xff;
}

void pcmv4_stream_reset(struct pcmv4_stream *s)
{
    pcmv4_stream_free(s);
    pcmv4_stream_init(s);
}

static uint32_t read_magic(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool pcmv4_is_frame(const uint8_t *pkt, size_t len)
{
    return len >= 4 && read_magic(pkt) == PCMV4_MAGIC;
}

bool pcmv4_is_zstd_frame(const uint8_t *pkt, size_t len)
{
    return len >= 4 && read_magic(pkt) == PCMV4_ZSTD_MAGIC;
}

/*
 * Parse the header at the front of pkt, returning the offset at which the body
 * begins.
 *
 * LAYOUT
 *
 *   [magic u32 = "PCM4"]                        4   always
 *   [flags u8]                                  1   always
 *   [timestamp]                             8 or ~2   full at a resync, delta otherwise
 *   [sampleCount uvarint]                       2   if the count bit is set
 *   [sampleRate uvarint][channels u8]          ~3   if the metadata bit is set
 *   [power i16][noise i16]                      4   if the quality bit is set
 *
 *   flags: bit 7 escape   bit 6 quality   bit 5 metadata
 *          bit 4 silent   bit 3 count     bits 2-0 profile id
 *
 * One byte follows the header and precedes the body on a scaled packet that
 * carries a body — the reduced-depth shift. It is read in pcmv4_decode rather
 * than here, because it is part of the payload and not of the header.
 *
 * The metadata bit marks a resynchronisation point, which is also what carries
 * a full timestamp; the two never differ, so there is no separate flag for the
 * second. A packet that arrives before any metadata has been seen is refused
 * rather than guessed at — the server re-sends metadata every five seconds, so
 * that state does not last.
 */
static bool hdr_decode(struct pcmv4_hdr_decoder *d, const uint8_t *pkt, size_t len,
                       struct pcmv4_header *h, size_t *body_off,
                       char *err, size_t errlen)
{
    if (len < 5) { seterr(err, errlen, "pcm v4 header: packet too short"); return false; }
    if (read_magic(pkt) != PCMV4_MAGIC) {
        seterr(err, errlen, "pcm v4 header: bad magic");
        return false;
    }
    const uint8_t flags = pkt[4];
    size_t off = 5;

    h->profile = flags & PROFILE_MASK;
    h->escape = (flags & FLAG_ESCAPE) != 0;
    h->silent = (flags & FLAG_SILENT) != 0;
    if (h->escape && h->silent) {
        seterr(err, errlen, "pcm v4 header: escape and silent are mutually exclusive");
        return false;
    }

    if (flags & FLAG_METADATA) {
        if (len < off + 8) { seterr(err, errlen, "pcm v4 header: truncated timestamp"); return false; }
        uint64_t ts = 0;
        for (int b = 7; b >= 0; --b) ts = (ts << 8) | pkt[off + (size_t)b];
        d->last_ts = ts;
        off += 8;
    } else {
        if (!d->have_metadata) {
            seterr(err, errlen, "pcm v4 header: delta packet before any resynchronisation point");
            return false;
        }
        int64_t delta;
        if (!read_varint(pkt, len, &off, &delta)) {
            seterr(err, errlen, "pcm v4 header: malformed timestamp delta");
            return false;
        }
        d->last_ts = (uint64_t)((int64_t)d->last_ts + delta);
    }
    h->timestamp_nanos = d->last_ts;

    if (flags & FLAG_COUNT) {
        uint64_t count;
        if (!read_uvarint(pkt, len, &off, &count)) {
            seterr(err, errlen, "pcm v4 header: malformed sample count");
            return false;
        }
        d->count = (int)count;
    }

    if (flags & FLAG_METADATA) {
        uint64_t rate;
        if (!read_uvarint(pkt, len, &off, &rate)) {
            seterr(err, errlen, "pcm v4 header: malformed sample rate");
            return false;
        }
        if (len < off + 1) { seterr(err, errlen, "pcm v4 header: truncated channel count"); return false; }
        d->rate = (int)rate;
        d->channels = (int)pkt[off];
        off++;
        d->have_metadata = true;
    } else if (!d->have_metadata) {
        seterr(err, errlen, "pcm v4 header: payload before any metadata");
        return false;
    }

    if (flags & FLAG_QUALITY) {
        if (len < off + 4) { seterr(err, errlen, "pcm v4 header: truncated signal quality"); return false; }
        d->power = (int16_t)((uint16_t)pkt[off] | ((uint16_t)pkt[off + 1] << 8));
        d->noise = (int16_t)((uint16_t)pkt[off + 2] | ((uint16_t)pkt[off + 3] << 8));
        off += 4;
    }

    if (d->rate <= 0 || d->channels <= 0) {
        seterr(err, errlen, "pcm v4 header: implausible metadata");
        return false;
    }
    if (d->count <= 0) {
        seterr(err, errlen, "pcm v4 header: implausible sample count");
        return false;
    }

    h->sample_rate = d->rate;
    h->channels = d->channels;
    h->sample_count = d->count;
    h->baseband_power = quality_to_float(d->power);
    h->noise = quality_to_float(d->noise);
    *body_off = off;
    return true;
}

bool pcmv4_decode(struct pcmv4_stream *s, const uint8_t *pkt, size_t len,
                  struct pcmv4_header *h, const int16_t **out_samples,
                  char *err, size_t errlen)
{
    size_t off = 0;
    memset(h, 0, sizeof(*h));
    if (!hdr_decode(&s->hdr, pkt, len, h, &off, err, errlen)) return false;

    /* The packet declares its own profile; nothing here infers it from the mode
     * or the channel count. That keeps the choice a server-side policy it can
     * retune without breaking anything deployed. */
    if (!codec_configure(&s->codec, h->profile, err, errlen)) return false;

    const int step = codec_step(&s->codec);
    const int count = h->sample_count;
    if (count <= 0 || count % step != 0) {
        seterr(err, errlen, "predictive codec: bad sample count for profile");
        return false;
    }

    if ((size_t)count > s->samples_cap) {
        int16_t *tmp = realloc(s->samples, (size_t)count * sizeof(int16_t));
        if (!tmp) { seterr(err, errlen, "pcm v4: out of memory"); return false; }
        s->samples = tmp;
        s->samples_cap = (size_t)count;
    }
    int16_t *out = s->samples;
    *out_samples = out;

    if (h->silent) {
        /* A silent packet carries no body at all: Rice coding cannot get
         * all-zero residuals below one bit per sample, and a squelched or muted
         * session produces nothing else indefinitely, so the header says "all
         * zero" and the body is omitted. The predictor still has to move
         * exactly as the encoder's did over the same zeros, or every packet
         * after this one decodes wrongly. */
        if (off != len) {
            seterr(err, errlen, "pcm v4: silent packet carries a body");
            return false;
        }
        codec_begin_packet(&s->codec, count / step);
        for (int i = 0; i < count; i += step) codec_forward(&s->codec, 0, 0);
        memset(out, 0, (size_t)count * sizeof(int16_t));
        return true;
    }

    /* A scaled packet puts the shift the encoder used in front of the body:
     * the header's flags byte is full, and a silent packet has no body at all,
     * so it costs nothing on a squelched or dead channel. */
    unsigned shift = 0;
    if (h->profile == PCMV4_PROFILE_IQ_SCALED) {
        if (len <= off) {
            seterr(err, errlen, "pcm v4: scaled packet carries no shift");
            return false;
        }
        shift = pkt[off];
        if (shift > PCMV4_MAX_SHIFT) {
            seterr(err, errlen, "pcm v4: shift out of range");
            return false;
        }
        h->shift = (uint8_t)shift;
        off++;
    }

    const uint8_t *body = pkt + off;
    const size_t body_len = len - off;

    if (h->escape) {
        /* A predictor cannot help a full-entropy signal, and a saturated front
         * end produces exactly that; without the escape such a stream would
         * EXPAND by about 3%. The filters still advance over these samples on
         * both sides, so state stays in step through one. */
        if (body_len < (size_t)count * 2) {
            seterr(err, errlen, "predictive codec: escape payload truncated");
            return false;
        }
        for (int i = 0; i < count; i++) {
            out[i] = (int16_t)((uint16_t)body[2 * i] | ((uint16_t)body[2 * i + 1] << 8));
        }
        codec_begin_packet(&s->codec, count / step);
        for (int i = 0; i < count; i += step) {
            const int64_t a = out[i];
            const int64_t b = (step == 2) ? out[i + 1] : 0;
            codec_forward(&s->codec, a, b);
        }
        lossy_restore(out, count, shift);
        return true;
    }

    if ((size_t)count > s->codec.res_cap) {
        int32_t *tmp = realloc(s->codec.res, (size_t)count * sizeof(int32_t));
        if (!tmp) { seterr(err, errlen, "pcm v4: out of memory"); return false; }
        s->codec.res = tmp;
        s->codec.res_cap = (size_t)count;
    }
    if (!rice_decode(body, body_len, s->codec.res, (size_t)count, err, errlen)) return false;

    codec_begin_packet(&s->codec, count / step);
    if (s->codec.is_complex) {
        for (int i = 0; i < count; i += 2) {
            int64_t a = s->codec.res[i], b = s->codec.res[i + 1];
            /* Stages are inverted in reverse order: the last to have predicted
             * is the first to be undone. */
            for (int st = s->codec.ncx - 1; st >= 0; --st) {
                int64_t xr, xi;
                cstage_inverse(&s->codec.cx[st], a, b, &xr, &xi);
                a = xr;
                b = xi;
            }
            out[i] = (int16_t)a;
            out[i + 1] = (int16_t)b;
        }
        lossy_restore(out, count, shift);
        return true;
    }
    for (int i = 0; i < count; i++) {
        int64_t a = s->codec.res[i];
        for (int st = s->codec.nrl - 1; st >= 0; --st) a = rstage_inverse(&s->codec.rl[st], a);
        out[i] = (int16_t)a;
    }
    return true;
}
