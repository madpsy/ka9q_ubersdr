// pcmv4_block_test.cpp -- the order-16 IQ filter, block path and all, against
// the decoder as it was before it had one (pcm_v4_ref.hpp), sample for sample.
//
// Both stages are driven from the same start through the same packets: the
// current one the way Codec drives it -- inverseBlock for the packet, frame by
// frame for whatever it hands back -- and the reference frame by frame. The
// residuals are small, zero, a lone huge one, and runs near +-2^31 that take a
// sample past int32, where the block stops and the stage goes on in int64; the
// escape path's forward() is mixed in. Any differing sample fails.
//
// Built and run by run.sh: once as the build would produce it (AVX2 chosen at
// run time on x86-64, NEON on arm64) and once with UBERSDR_PCMV4_NO_SIMD.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <random>
#include <vector>

#include "../pcm_v4.hpp"
#include "pcm_v4_ref.hpp"

int main() {
    std::mt19937_64 rng(31);
    auto pick = [&](int n) { return (int)(rng() % (uint64_t)n); };
    long frames_total = 0, blocks = 0;

    for (int trial = 0; trial < 300; ++trial) {
        ubersdr::ComplexStage got(16, 16);
        ubersdr_ref::ComplexStage want(16, 16);
        const double amp = 2000 + pick(28000), step = 0.01 + 0.6 * (pick(1000) / 1000.0);
        long phase = 0;
        for (int p = 0; p < 60; ++p) {
            const int frames = 1 + pick(400);
            // Mostly what a server sends; the inputs that take a sample past
            // int32 -- after which the stage stays in int64 and the block no
            // longer applies -- rarely, so most packets exercise the block.
            //
            // Half the packets carry a tone that runs on from one packet to the
            // next. Noise leaves the taps small; a tone drives them up to the
            // size real signals do, past 2^14 where the leak starts to bite,
            // and the leak is the part of the update noise never reaches.
            const int r = pick(100);
            const int kind = r < 50 ? 6 : (r < 92 ? pick(4) : (r < 98 ? 4 : 5));
            std::vector<int32_t> res(2 * (size_t)frames);
            for (auto &v : res) {
                switch (kind) {
                case 0: v = 0; break;                                    // silence
                case 1: v = pick(3) - 1; break;                          // near silence
                case 2: v = (int32_t)(pick(2001) - 1000); break;         // signal
                case 3: v = (int32_t)(pick(60001) - 30000); break;       // loud
                case 4:                                                   // a rare huge one
                    v = pick(200) == 0 ? (int32_t)(pick(2) ? INT32_MAX - pick(1000) : INT32_MIN + pick(1000))
                                       : (int32_t)(pick(201) - 100);
                    break;
                case 5: v = (int32_t)(rng() >> 32); break;               // anything at all
                default: break;                                           // the tone, below
                }
            }
            if (kind == 6) {
                // The residual that turns into this tone is whatever this side's
                // prediction misses, so drive the reference to find it: x is the
                // tone, the residual x - prediction, and the stage under test then
                // decodes those residuals and must land on the same samples.
                ubersdr_ref::ComplexStage probe = want;
                probe.beginPacket(frames);
                for (int f = 0; f < frames; ++f, ++phase) {
                    int64_t xr = (int64_t)(amp * cos(step * phase)), xi = (int64_t)(amp * sin(step * phase));
                    int64_t er, ei;
                    probe.forward(xr, xi, er, ei);
                    res[2 * f] = (int32_t)er;
                    res[2 * f + 1] = (int32_t)ei;
                }
            }
            got.beginPacket(frames);
            want.beginPacket(frames);

            if (pick(8) == 0) {
                // The escape path: both advance over known samples.
                for (int f = 0; f < frames; ++f) {
                    int64_t xr = (int16_t)res[2 * f], xi = (int16_t)res[2 * f + 1], a, b, c, d;
                    got.forward(xr, xi, a, b);
                    want.forward(xr, xi, c, d);
                    if (a != c || b != d) {
                        fprintf(stderr, "trial %d packet %d frame %d: forward residual differs\n", trial, p, f);
                        return 1;
                    }
                }
                continue;
            }

            std::vector<int16_t> a(res.size()), b(res.size());
            if (got.inverseBlock(res.data(), b.data(), frames)) {
                ++blocks;
            } else {
                for (int f = 0; f < frames; ++f) {
                    int64_t xr, xi;
                    got.inverse(res[2 * f], res[2 * f + 1], xr, xi);
                    b[2 * f] = (int16_t)xr;
                    b[2 * f + 1] = (int16_t)xi;
                }
            }
            for (int f = 0; f < frames; ++f) {
                int64_t xr, xi;
                want.inverse(res[2 * f], res[2 * f + 1], xr, xi);
                a[2 * f] = (int16_t)xr;
                a[2 * f + 1] = (int16_t)xi;
            }
            for (size_t i = 0; i < a.size(); ++i) {
                if (a[i] != b[i]) {
                    fprintf(stderr, "trial %d packet %d sample %zu: %d, reference %d\n", trial, p, i, b[i], a[i]);
                    return 1;
                }
            }
            frames_total += frames;
        }
    }
    printf("block test: %ld frames identical to the reference, %ld packets through the block path\n",
           frames_total, blocks);
    return 0;
}
