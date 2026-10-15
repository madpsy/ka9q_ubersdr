/*
 * api.c - the exported surface of the WebAssembly PCM v4 decoder.
 *
 * The header stays in JavaScript (pcm-v4-wasm.js). It is a few varints and
 * flags, a fraction of a microsecond per packet, and it carries the stream
 * state the JavaScript decoder's callers read back -- rate, channels, signal
 * quality, capture time -- so moving it here would only add a second copy of
 * that state and a marshalling step to return it. What crosses into this
 * module is the part that costs: the body.
 *
 * One call per packet, and no allocation in the steady state:
 *
 *   ptr = pv4_input(len)         the JavaScript copies the body to ptr
 *   n   = pv4_decode(h, len, count, mode, shift)
 *   pv4_plane(0), pv4_plane(1)   n floats each, already scaled
 *
 * The buffers behind pv4_input and pv4_plane are shared by every codec in the
 * instance (decoding is synchronous and single-threaded, so only one packet is
 * ever in flight) and grow geometrically to the largest packet seen, then stay.
 * Growing memory detaches every view the JavaScript holds on it, so the
 * wrapper rebuilds its views whenever memory.buffer has changed.
 *
 * The planes come out deinterleaved and already multiplied by the JavaScript
 * decoder's gain, 1/32768 * 2^shift, so all the wrapper does is copy them into
 * the Float32Arrays it returns. Plane 1 is written only for a complex profile.
 *
 * Every rejection returns a negative code and leaves the predictor exactly as
 * it was, because that is what the JavaScript does: it validates the whole
 * body (Rice-decodes it in full) before stepping a single stage.
 */
#include "pcmv4.h"

pv4_counters_t pv4_counters;
int pv4_kernel_enabled = 1;

/* Shared scratch. Capacities are in elements. */
static uint8_t *g_in;
static size_t g_in_cap;
static int32_t *g_res;
static size_t g_res_cap;
static double *g_resw;
static size_t g_resw_cap;
static float *g_pa, *g_pb;
static size_t g_pa_cap, g_pb_cap;

/* Grow a buffer of elements of size esz to hold at least need (plus slack
 * elements), doubling so a stream of slowly growing packets reallocates only
 * a handful of times. The contents are not kept. */
static int grow(void **buf, size_t *cap, size_t need, size_t esz, size_t slack) {
    if (need <= *cap) return 1;
    size_t ncap = *cap ? *cap * 2 : 1024;
    while (ncap < need) ncap *= 2;
    void *p = pv4_alloc((ncap + slack) * esz);
    if (!p) return 0;
    if (*buf) pv4_free(*buf, (*cap + slack) * esz);
    *buf = p;
    *cap = ncap;
    return 1;
}

static void stage_init(pv4_stage *s, int order, double mu) {
    memset(s, 0, sizeof(*s));
    s->order = order;
    s->mu = mu;
    s->idx = order;
}

static pv4_codec *codec_of(int h) {
    pv4_codec *c = (pv4_codec *)(uintptr_t)h;
    if (!c || c->magic != PV4_CODEC_MAGIC) return 0;
    return c;
}

PV4_EXPORT("pv4_abi") int pv4_abi(void) { return PV4_ABI_VERSION; }

/* Whether this build has the SIMD kernel, so the wrapper can report which
 * module it actually instantiated rather than which it meant to. */
PV4_EXPORT("pv4_simd") int pv4_simd(void) {
#if defined(__wasm_simd128__)
    return 1;
#else
    return 0;
#endif
}

/* The path counters (pcmv4.h), by index in declaration order; -1 for none. */
PV4_EXPORT("pv4_counter") int pv4_counter(int which) {
    switch (which) {
    case 0: return (int)pv4_counters.kernel_frames;
    case 1: return (int)pv4_counters.frame_frames;
    case 2: return (int)pv4_counters.kernel_exits;
    case 3: return (int)pv4_counters.wide_packets;
    default: return -1;
    }
}

PV4_EXPORT("pv4_counters_reset") void pv4_counters_reset(void) {
    memset(&pv4_counters, 0, sizeof(pv4_counters));
}

/* For tests: 0 sends every IQ frame through the per-frame path. */
PV4_EXPORT("pv4_set_kernel") void pv4_set_kernel(int on) { pv4_kernel_enabled = on != 0; }

/* A codec with no profile yet; the first packet names one. 0 when memory
 * cannot grow. */
PV4_EXPORT("pv4_codec_new") int pv4_codec_new(void) {
    pv4_codec *c = pv4_alloc(sizeof(pv4_codec));
    if (!c) return 0;
    c->magic = PV4_CODEC_MAGIC;
    c->profile = -1;
    return (int)(uintptr_t)c;
}

PV4_EXPORT("pv4_codec_free") void pv4_codec_free(int h) {
    pv4_codec *c = codec_of(h);
    if (!c) return;
    c->magic = 0;
    pv4_free(c, sizeof(pv4_codec));
}

/* Back to "no profile", as PCMv4StreamDecoder.reset() leaves it. */
PV4_EXPORT("pv4_codec_reset") int pv4_codec_reset(int h) {
    pv4_codec *c = codec_of(h);
    if (!c) return PV4_ERR_HANDLE;
    c->profile = -1;
    c->nstages = 0;
    return PV4_OK;
}

/* PCMv4StreamDecoder._useProfile: the same profile keeps its adaptation, any
 * other -- including 0 <-> 2, which share a predictor -- starts cold, because
 * that is what the server's encoder does on a profile change. An unknown
 * profile is refused and changes nothing. */
PV4_EXPORT("pv4_codec_profile") int pv4_codec_profile(int h, int id) {
    pv4_codec *c = codec_of(h);
    if (!c) return PV4_ERR_HANDLE;
    if (c->profile == id && c->nstages) return PV4_OK;
    switch (id) {
    case PV4_PROFILE_IQ:
    case PV4_PROFILE_IQ_SCALED:
        c->complex = 1;
        c->nstages = 1;
        stage_init(&c->st[0], 16, 16);
        break;
    case PV4_PROFILE_AUDIO:
        c->complex = 0;
        c->nstages = 4;
        stage_init(&c->st[0], 8, 16);
        stage_init(&c->st[1], 8, 16);
        stage_init(&c->st[2], 4, 32);
        stage_init(&c->st[3], 2, 32);
        break;
    default:
        return PV4_ERR_PROFILE;
    }
    c->profile = id;
    return PV4_OK;
}

/* Room for a body of len bytes, followed by PV4_INPUT_SLACK zero bytes a
 * decoder may read past the end. 0 when memory cannot grow. */
PV4_EXPORT("pv4_input") uint8_t *pv4_input(int len) {
    if (len < 0) return 0;
    if (!grow((void **)&g_in, &g_in_cap, (size_t)len, 1, PV4_INPUT_SLACK)) return 0;
    memset(g_in + len, 0, PV4_INPUT_SLACK);
    return g_in;
}

PV4_EXPORT("pv4_plane") float *pv4_plane(int which) { return which ? g_pb : g_pa; }

/* Both planes, to frames floats each. */
static int planes_for(size_t frames) {
    return grow((void **)&g_pa, &g_pa_cap, frames, sizeof(float), 0) &&
           grow((void **)&g_pb, &g_pb_cap, frames, sizeof(float), 0);
}

/* Decode one body of len bytes, already at pv4_input(), holding count int16
 * samples (interleaved I/Q on a complex profile). mode is PV4_BODY_RICE or
 * PV4_BODY_ESCAPE; shift is the reduced-depth shift, 0 unless the profile is
 * scaled. Returns the number of frames written to each plane, or a negative
 * code for a body the JavaScript decoder would return null for. */
PV4_EXPORT("pv4_decode") int pv4_decode(int h, int len, int count, int mode, int shift) {
    pv4_codec *c = codec_of(h);
    if (!c) return PV4_ERR_HANDLE;
    if (!c->nstages) return PV4_ERR_NO_PROFILE;
    if (shift < 0 || shift > 15) return PV4_ERR_SHIFT;
    const int step = c->complex ? 2 : 1;
    if (count <= 0 || count % step) return PV4_ERR_BAD_COUNT;
    if (len < 0 || (size_t)len > g_in_cap) return PV4_ERR_EMPTY;
    const int frames = count / step;
    const double g = 1.0 / 32768.0 * (double)(1 << shift);

    if (mode == PV4_BODY_ESCAPE) {
        if ((int64_t)count * 2 > len) return PV4_ERR_ESCAPE_TRUNCATED;
        if (!planes_for((size_t)frames)) return PV4_ERR_NOMEM;
        if (c->complex) pv4_iq_escape(c, g_in, frames, g_pa, g_pb, g);
        else pv4_audio_escape(c, g_in, frames, g_pa, g);
        return frames;
    }

    if (len < 1) return PV4_ERR_EMPTY;
    if (g_in[0] > 30) return PV4_ERR_RICE_K;
    /* Every value costs at least its stop bit and k remainder bits, so a count
     * the body cannot hold is refused before any buffer is sized for it. The
     * JavaScript would refuse it too, after reading to the end of the body. */
    if ((size_t)len < pv4_rice_min_len(g_in[0], (size_t)count)) return PV4_ERR_RICE_TRUNCATED;
    if (!grow((void **)&g_res, &g_res_cap, (size_t)count, sizeof(int32_t), PV4_RICE_SLACK)) return PV4_ERR_NOMEM;
    if (!planes_for((size_t)frames)) return PV4_ERR_NOMEM;

    int rc = pv4_rice_decode(g_in, (size_t)len, g_res, (size_t)count);
    if (rc == PV4_WIDE) {
        pv4_counters.wide_packets++;
        if (!grow((void **)&g_resw, &g_resw_cap, (size_t)count, sizeof(double), 0)) return PV4_ERR_NOMEM;
        rc = pv4_rice_decode_wide(g_in, (size_t)len, g_resw, (size_t)count);
        if (rc != PV4_OK) return rc;
        if (c->complex) pv4_iq_inverse_wide(c, g_resw, frames, g_pa, g_pb, g);
        else pv4_audio_inverse_wide(c, g_resw, frames, g_pa, g);
        return frames;
    }
    if (rc != PV4_OK) return rc;
    if (c->complex) pv4_iq_inverse(c, g_res, frames, g_pa, g_pb, g);
    else pv4_audio_inverse(c, g_res, frames, g_pa, g);
    return frames;
}

/* A silent packet: no body, and the predictor advanced over count zero
 * samples exactly as the encoder advanced its own. Nothing is written to the
 * planes; the wrapper's freshly allocated Float32Arrays are already zero. */
PV4_EXPORT("pv4_silent") int pv4_silent(int h, int count) {
    pv4_codec *c = codec_of(h);
    if (!c) return PV4_ERR_HANDLE;
    if (!c->nstages) return PV4_ERR_NO_PROFILE;
    const int step = c->complex ? 2 : 1;
    if (count <= 0 || count % step) return PV4_ERR_BAD_COUNT;
    if (c->complex) pv4_iq_silent(c, count / 2);
    else pv4_audio_silent(c, count);
    return PV4_OK;
}
