/*
 * rice.c - the Rice bitstream: per value a run of 1 bits, a 0 stop bit, then
 * k raw low bits, zigzagged. The first body byte is k.
 *
 * Two decoders, for the reason pcmv4.h gives at length: this module answers to
 * the JavaScript decoder, whose residuals are doubles.
 *
 * pv4_rice_decode is the fast one. It produces int32 residuals, which is all a
 * stream from the server ever holds -- the encoder codes int32 residuals and
 * caps k at 30 -- and it is the path every real packet takes. A corrupt body
 * can describe a value past int32: a long run of 1 bits is a large quotient,
 * and at k = 30 a quotient of 4 is already 2^32. JavaScript computes that as
 * q * 2^k + rem in a double, exactly up to 2^53 and rounded past it, and goes
 * on to decode with it. Rather than widen the hot path for that, the fast
 * decoder gives up the moment a value would not fit int32 and says so
 * (PV4_WIDE), and the caller decodes the whole body again with
 * pv4_rice_decode_wide, which is the JavaScript's riceDecode transcribed into
 * double arithmetic. Only a corrupt packet ever pays for the second pass.
 *
 * Both accept and refuse exactly the bodies the JavaScript does: k above 30 is
 * refused, a body that runs out in a unary run or a remainder is refused, and
 * bytes left over after the last value are ignored.
 */
#include "pcmv4.h"

size_t pv4_rice_min_len(unsigned k, size_t count) {
    return (size_t)(((uint64_t)count * (k + 1) + 7) / 8) + 1;
}

int pv4_rice_decode(const uint8_t *src, size_t len, int32_t *out, size_t count) {
    if (len < 1) return PV4_ERR_EMPTY;
    const unsigned k = src[0];
    if (k > 30) return PV4_ERR_RICE_K;
    ++src;
    --len;

    uint64_t acc = 0;
    unsigned nbits = 0;
    size_t i = 0;

#define REFILL()                              \
    while (nbits <= 56 && i < len) {          \
        acc |= (uint64_t)src[i] << nbits;     \
        ++i;                                  \
        nbits += 8;                           \
    }

    REFILL()
    const uint64_t mask = ((uint64_t)1 << k) - 1;
    /* A quotient at or past this makes the value 2^32 or more: not int32. */
    const uint64_t qmax = (uint64_t)1 << (32 - k);

    for (size_t j = 0; j < count; ++j) {
        if (nbits < 48) { REFILL() }

        uint64_t q = 0;
        for (;;) {
            /* Bits past nbits read as 0, so the run stops there at the latest. */
            const unsigned c = (unsigned)__builtin_ctzll(~acc);
            if (c < nbits) {
                q += c;
                /* c + 1 can be 64, and a shift by 64 is undefined in C. */
                const unsigned sh = c + 1;
                acc = sh >= 64 ? 0 : acc >> sh;
                nbits -= sh;
                break;
            }
            if (i >= len) return PV4_ERR_RICE_TRUNCATED;
            q += nbits;
            acc = 0;
            nbits = 0;
            REFILL()
        }
        if (q >= qmax) return PV4_WIDE;

        if (nbits < k) { REFILL() }
        if (nbits < k) return PV4_ERR_RICE_TRUNCATED;
        const uint32_t u = ((uint32_t)q << k) | (uint32_t)(acc & mask);
        acc >>= k;
        nbits -= k;
        out[j] = (int32_t)((u >> 1) ^ ((uint32_t)0 - (u & 1)));
    }
#undef REFILL
    return PV4_OK;
}

/* pcm-v4.js riceDecode, line for line, in its own arithmetic. q and the
 * remainder are exact integers in either language; the value is formed as a
 * double, q * 2^k + rem, with the one rounding the JavaScript does. */
int pv4_rice_decode_wide(const uint8_t *body, size_t len, double *out, size_t count) {
    if (len < 1) return PV4_ERR_EMPTY;
    const unsigned k = body[0];
    if (k > 30) return PV4_ERR_RICE_K;
    size_t pos = 1;
    unsigned acc = 0, nbits = 0;
    const double kmul = (double)((uint64_t)1 << k);

    for (size_t i = 0; i < count; ++i) {
        uint64_t q = 0;
        for (;;) {
            if (nbits == 0) {
                if (pos >= len) return PV4_ERR_RICE_TRUNCATED;
                acc = body[pos++];
                nbits = 8;
            }
            const unsigned inv = ~acc & 0xffu;
            unsigned t = inv == 0 ? nbits : (unsigned)__builtin_ctz(inv);
            if (t > nbits) t = nbits;
            q += t;
            if (t < nbits) {
                acc >>= t + 1;
                nbits -= t + 1;
                break;
            }
            acc = 0;
            nbits = 0;
        }
        uint64_t rem = 0;
        unsigned need = k, shift = 0;
        while (need > 0) {
            if (nbits == 0) {
                if (pos >= len) return PV4_ERR_RICE_TRUNCATED;
                acc = body[pos++];
                nbits = 8;
            }
            const unsigned take = need < nbits ? need : nbits;
            rem += (uint64_t)(acc & ((1u << take) - 1)) << shift;
            acc >>= take;
            nbits -= take;
            shift += take;
            need -= take;
        }
        const double u = (double)q * kmul + (double)rem;
        /* u % 2 === 1: every double from 2^53 up is even. */
        const int odd = u < 9007199254740992.0 && ((uint64_t)u & 1);
        out[i] = odd ? -(u + 1) / 2 : u / 2;
    }
    return PV4_OK;
}
