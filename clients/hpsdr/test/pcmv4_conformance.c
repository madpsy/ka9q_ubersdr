/*
 * pcmv4_conformance.c — decode a packet stream the SERVER's encoder produced
 * and write the samples out, so a shell can compare their hash with the samples
 * that went in.
 *
 * The version 4 predictor is backward adaptive: this decoder and the server's
 * encoder derive their filter taps independently and never exchange a
 * coefficient. An arithmetic difference between the two — a rounding rule, a
 * sign convention, the point at which the tap clamp is skipped — therefore
 * produces plausible-sounding noise rather than an error, and an HPSDR client
 * would report it only as a receiver that suddenly hears nothing. Nothing short
 * of comparing the actual samples catches that.
 *
 * The hash is computed by the caller so this needs no crypto: it writes
 * little-endian int16 to stdout and run.sh pipes it through sha256sum.
 *
 * Fixture layout: "UV4F", a format byte, a uint32 packet count, then each
 * packet as a uint32 length followed by that many bytes.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../pcm_v4.h"

static uint32_t le32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int main(int argc, char **argv)
{
    const char *path = (argc > 1) ? argv[1] : "testdata/pcmv4_stream.bin";

    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); return 2; }
    unsigned char *raw = NULL;
    size_t raw_len = 0, n;
    unsigned char buf[65536];
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        unsigned char *tmp = realloc(raw, raw_len + n);
        if (!tmp) { fclose(f); free(raw); return 2; }
        raw = tmp;
        memcpy(raw + raw_len, buf, n);
        raw_len += n;
    }
    fclose(f);

    if (raw_len < 9 || memcmp(raw, "UV4F", 4) != 0 || raw[4] != 0) {
        fprintf(stderr, "%s: not a version 4 fixture\n", path);
        free(raw);
        return 2;
    }
    const uint32_t count = le32(raw + 5);
    size_t off = 9;

    struct pcmv4_stream s;
    pcmv4_stream_init(&s);
    int last_rate = -1, last_ch = -1, last_profile = -1;
    int min_shift = 256, max_shift = -1;
    int rc = 0;

    for (uint32_t i = 0; i < count; i++) {
        if (off + 4 > raw_len) { fprintf(stderr, "packet %u: truncated length\n", i); rc = 1; break; }
        const uint32_t len = le32(raw + off);
        off += 4;
        if (off + len > raw_len) { fprintf(stderr, "packet %u: truncated packet\n", i); rc = 1; break; }

        struct pcmv4_header h;
        const int16_t *samples;
        char err[128];
        if (!pcmv4_decode(&s, raw + off, len, &h, &samples, err, sizeof(err))) {
            fprintf(stderr, "packet %u: %s\n", i, err);
            rc = 1;
            break;
        }
        off += len;

        /* Reported so a decoder that hashed correctly while losing the
         * carried-forward metadata would still be visible. */
        if (h.sample_rate != last_rate || h.channels != last_ch) {
            fprintf(stderr, "  packet %-4u %6d Hz  %d ch\n", i, h.sample_rate, h.channels);
            last_rate = h.sample_rate;
            last_ch = h.channels;
        }

        /* The profile and the reduced-depth shift, reported for the same reason
         * the rate is: a decoder that hashed correctly while never taking the
         * scaled path at all would otherwise look exactly like one that did. */
        if ((int)h.profile != last_profile) {
            fprintf(stderr, "  packet %-4u profile %d\n", i, h.profile);
            last_profile = (int)h.profile;
        }
        if (h.profile == PCMV4_PROFILE_IQ_SCALED && !h.silent) {
            if ((int)h.shift < min_shift) min_shift = h.shift;
            if ((int)h.shift > max_shift) max_shift = h.shift;
        }

        for (int j = 0; j < h.sample_count; j++) {
            const unsigned char o[2] = {
                (unsigned char)((uint16_t)samples[j] & 0xff),
                (unsigned char)(((uint16_t)samples[j] >> 8) & 0xff),
            };
            fwrite(o, 1, 2, stdout);
        }
    }

    if (rc == 0 && off != raw_len) {
        fprintf(stderr, "fixture: %zu trailing bytes\n", raw_len - off);
        rc = 1;
    }
    if (rc == 0) {
        if (max_shift >= 0)
            fprintf(stderr, "  shifts %d-%d\n", min_shift, max_shift);
        fprintf(stderr, "  %u packets decoded\n", count);
    }

    pcmv4_stream_free(&s);
    free(raw);
    return rc;
}
