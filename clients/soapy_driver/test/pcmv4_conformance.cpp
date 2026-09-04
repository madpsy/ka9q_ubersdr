// pcmv4_conformance.cpp — decode a packet stream the SERVER's encoder produced
// and write the samples out, so a shell can compare their hash against the
// samples that went in.
//
// The version 4 predictor is backward adaptive: this decoder and the server's
// encoder derive their filter taps independently from the samples already seen,
// and never exchange a coefficient. An arithmetic difference between the two —
// a rounding rule, a sign convention, the point at which the tap clamp is
// skipped — therefore produces plausible-sounding noise rather than an error.
// Nothing short of comparing the actual samples catches that, which is what
// this does.
//
// The hash is computed by the caller rather than here so this program needs no
// crypto: it writes little-endian int16 to stdout and test/run.sh pipes it
// through sha256sum.
//
// Fixture layout: "UV4F", a format byte, a uint32 packet count, then each
// packet as a uint32 length followed by that many bytes.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../pcm_v4.hpp"

static uint32_t le32(const unsigned char *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

int main(int argc, char **argv) {
    const char *path = (argc > 1) ? argv[1] : "testdata/pcmv4_stream.bin";

    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "cannot open %s\n", path);
        return 2;
    }
    std::vector<unsigned char> raw;
    unsigned char buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) raw.insert(raw.end(), buf, buf + n);
    fclose(f);

    if (raw.size() < 9 || memcmp(&raw[0], "UV4F", 4) != 0 || raw[4] != 0) {
        fprintf(stderr, "%s: not a version 4 fixture\n", path);
        return 2;
    }
    const uint32_t count = le32(&raw[5]);
    size_t off = 9;

    ubersdr::PCMv4StreamDecoder dec;
    // Every distinct (rate, channels) the stream passes through, in order. A
    // decoder that lost the carried-forward metadata could still hash correctly
    // while mislabelling the stream, so the labels are reported too.
    int lastRate = -1, lastCh = -1, lastProfile = -1;
    int minShift = 256, maxShift = -1;

    for (uint32_t i = 0; i < count; ++i) {
        if (off + 4 > raw.size()) {
            fprintf(stderr, "packet %u: truncated length\n", i);
            return 1;
        }
        const uint32_t len = le32(&raw[off]);
        off += 4;
        if (off + len > raw.size()) {
            fprintf(stderr, "packet %u: truncated packet\n", i);
            return 1;
        }

        ubersdr::PCMv4Header h;
        std::string err;
        if (!dec.decode(&raw[off], len, h, err)) {
            fprintf(stderr, "packet %u: %s\n", i, err.c_str());
            return 1;
        }
        off += len;

        if (h.sampleRate != lastRate || h.channels != lastCh) {
            fprintf(stderr, "  packet %-4u %6d Hz  %d ch\n", i, h.sampleRate, h.channels);
            lastRate = h.sampleRate;
            lastCh = h.channels;
        }

        // The profile and the reduced-depth shift, reported for the same reason
        // the rate is: a decoder that hashed correctly while never taking the
        // scaled path at all would otherwise look exactly like one that did.
        if ((int)h.profile != lastProfile) {
            fprintf(stderr, "  packet %-4u profile %d\n", i, h.profile);
            lastProfile = (int)h.profile;
        }
        if (h.profile == ubersdr::kProfileIQScaled && !h.silent) {
            if ((int)h.shift < minShift) minShift = h.shift;
            if ((int)h.shift > maxShift) maxShift = h.shift;
        }

        // Little-endian int16, which is what the fixture's hash was taken over.
        const int16_t *s = dec.samples();
        for (int j = 0; j < h.sampleCount; ++j) {
            const unsigned char out[2] = {(unsigned char)((uint16_t)s[j] & 0xff),
                                          (unsigned char)(((uint16_t)s[j] >> 8) & 0xff)};
            fwrite(out, 1, 2, stdout);
        }
    }

    if (off != raw.size()) {
        fprintf(stderr, "fixture: %zu trailing bytes\n", raw.size() - off);
        return 1;
    }
    if (maxShift >= 0) fprintf(stderr, "  shifts %d-%d\n", minShift, maxShift);
    fprintf(stderr, "  %u packets decoded\n", count);
    return 0;
}
