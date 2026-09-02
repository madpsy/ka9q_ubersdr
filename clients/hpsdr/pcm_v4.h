/*
 * pcm_v4.h — decoder for UberSDR audio protocol version 4.
 *
 * WHY THIS EXISTS
 *
 * Versions 1 to 3 wrapped every lossless packet in a zstd frame behind a fixed
 * 29- or 37-byte header. zstd does not compress this data: measured against a
 * live receiver every IQ mode came back at 0.99x, the compressed stream
 * consistently LARGER than the samples it carried, because zstd is an LZ77
 * matcher over bytes and a band-limited RF signal has no repeated byte strings.
 *
 * It does have redundancy, just not that kind — consecutive samples correlate
 * at |r(1)| of 0.78-0.90 on IQ — and a predictor plus an entropy coder suited
 * to residuals extracts it. Version 4 replaces the wrapper with exactly that,
 * and the fixed header with one carrying only what changed. Measured live at
 * version 4: iq48 141 kB/s, iq96 281, iq192 563, against 191/381/760 raw.
 *
 * HOW IT WORKS
 *
 * Each sample is predicted from those before it by an adaptive filter and only
 * the prediction error is sent, Rice coded. The filter is BACKWARD adaptive:
 * its taps are derived from samples already decoded, so this side recomputes
 * them independently and no coefficients are ever transmitted.
 *
 * That is what makes every arithmetic detail load-bearing. All state is integer
 * with shifts, never floating point, so the Go server and this decoder agree
 * bit for bit — but only if the rounding of the prediction sum, the sign
 * convention, the tap clamp, the order in which stages are inverted and the
 * point at which the fast path skips the clamp all match exactly. A difference
 * in any of them does not fail loudly; it returns plausible-looking noise.
 *
 * The reference is pcm_predictive.go and pcm_v4_header.go in the server tree,
 * and test/ decodes a packet stream that the server's own encoder produced.
 *
 * A decoder IS a stream: it holds the adaptation of every sample decoded so far
 * and the record of what the server has stopped repeating, so there is one per
 * WebSocket and it must be reset when a socket reconnects. Every packet must
 * reach it, including one whose samples are then dropped — a packet that skips
 * the decoder leaves this side's filters where the server's no longer are.
 */

#ifndef UBERSDR_PCM_V4_H
#define UBERSDR_PCM_V4_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The protocol version a client asks for in the WebSocket query string. */
#define PCMV4_PROTOCOL_VERSION 4

/*
 * "PCM4" little-endian, the first four bytes of a version 4 packet. Four bytes
 * and not two because a session that negotiated Opus still receives these for
 * IQ, so the width of the magic is a false-positive rate against an Opus
 * frame's leading timestamp bytes.
 */
#define PCMV4_MAGIC 0x344D4350u

/*
 * A version 1-3 lossless frame, which means a server older than 0.1.63: those
 * clamp the requested version to 1-3 and answer with version 1 rather than
 * refusing it. Recognising it turns a dead stream into a reason.
 */
#define PCMV4_ZSTD_MAGIC 0xFD2FB528u

/* Profile ids. Part of the wire format; never reassigned. */
#define PCMV4_PROFILE_IQ    0  /* one complex filter, order 16 */
#define PCMV4_PROFILE_AUDIO 1  /* four real stages, orders 8/8/4/2 */

#define PCMV4_MAX_STAGES 4

/* One packet's metadata, in the terms callers use. Every field is filled in on
 * every packet, carried forward from the last resynchronisation point when the
 * packet itself did not repeat it. */
struct pcmv4_header {
    uint64_t timestamp_nanos; /* GPS-synchronised time of the first sample */
    int      sample_rate;
    int      channels;        /* 1 for demodulated audio, 2 for interleaved I/Q */
    int      sample_count;    /* int16 samples in the body, counting both channels */
    float    baseband_power;  /* dBFS, or -999 when radiod reported nothing */
    float    noise;           /* dBFS over the demodulator passband, or -999 */
    uint8_t  profile;
    bool     escape;          /* the body holds verbatim samples */
    bool     silent;          /* every sample is zero; no body was transmitted */
};

/* One adaptive complex filter, for interleaved I/Q. A carrier in complex
 * baseband is a single complex pole that one complex tap cancels exactly, which
 * treating I and Q as two real streams throws away. */
struct pcmv4_cstage {
    int      order;
    int64_t  mu;
    bool     fast;   /* this packet cannot drive a tap past the clamp */
    int      idx;    /* newest history entry is at idx-1 */
    int      hlen;
    /* Taps in Q16, oldest-first: wr[j] weighs the history sample at
     * hr[idx-order+j]. Sample signs are kept beside the samples so the update
     * loop does not recompute a sign per tap per sample. */
    int64_t *wr, *wi, *hr, *hi, *sr, *si;
};

/* pcmv4_cstage with the imaginary terms removed, for mono audio. */
struct pcmv4_rstage {
    int      order;
    int64_t  mu;
    bool     fast;
    int      idx;
    int      hlen;
    int64_t *w, *h, *s;
};

/* Decodes one stream's payloads. */
struct pcmv4_codec {
    uint8_t  profile;      /* 0xff until configured */
    bool     is_complex;
    struct pcmv4_cstage cx[PCMV4_MAX_STAGES];
    int      ncx;
    struct pcmv4_rstage rl[PCMV4_MAX_STAGES];
    int      nrl;
    int32_t *res;
    size_t   res_cap;
};

/* Reads headers for one stream, carrying forward what the server stopped
 * repeating. */
struct pcmv4_hdr_decoder {
    bool     have_metadata;
    uint64_t last_ts;
    int      rate, channels, count;
    int16_t  power, noise;
};

/* The two halves together: one per WebSocket. */
struct pcmv4_stream {
    struct pcmv4_hdr_decoder hdr;
    struct pcmv4_codec       codec;
    int16_t *samples;
    size_t   samples_cap;
};

/* Zeroes a stream ready for use. Safe on a zeroed struct. */
void pcmv4_stream_init(struct pcmv4_stream *s);

/* Drops every buffer and the adaptation with them: call when a socket
 * reconnects, because the server builds a fresh encoder for a fresh socket. */
void pcmv4_stream_reset(struct pcmv4_stream *s);

/* Releases everything. The stream may be reused after another init. */
void pcmv4_stream_free(struct pcmv4_stream *s);

/* Is this frame a version 4 packet? */
bool pcmv4_is_frame(const uint8_t *pkt, size_t len);

/* Is this frame the version 1-3 shape, meaning a server older than 0.1.63? */
bool pcmv4_is_zstd_frame(const uint8_t *pkt, size_t len);

/*
 * Decode one packet. On success *out_samples points at h->sample_count int16
 * values — interleaved I/Q when h->channels is 2 — valid until the next call.
 *
 * On failure returns false and writes a reason into err when err is non-NULL.
 */
bool pcmv4_decode(struct pcmv4_stream *s, const uint8_t *pkt, size_t len,
                  struct pcmv4_header *h, const int16_t **out_samples,
                  char *err, size_t errlen);

#endif /* UBERSDR_PCM_V4_H */
