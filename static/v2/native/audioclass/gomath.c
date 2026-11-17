/*
 * gomath.c - exp, log, sin, cos and Round as Go's WebAssembly build computes
 * them.
 *
 * Go has assembly versions of some of these for some processors, but not for
 * WebAssembly, where its math package runs the portable Go code: these are
 * that code (Go's src/math/exp.go, log.go, sin.go, frexp.go, ldexp.go,
 * floor.go), transcribed operation for operation, so this module computes the
 * same doubles the Go original's WebAssembly module did. Floor and Sqrt are WebAssembly instructions
 * in both. The huge-argument path of sin and cos (Payne-Hanek reduction, for
 * |x| >= 2^29) is not carried over: nothing here takes the sine of anything
 * bigger than a few hundred.
 *
 * The Go source is under the BSD licence:
 *   Copyright (c) 2009 The Go Authors. All rights reserved.
 * and its algorithms come from FreeBSD's msun and the Cephes library
 * (Stephen L. Moshier), as its comments say.
 */
#include "audioclass.h"

/* Type punning through a union is defined in C, and compiles to a register
 * reinterpret (memcpy would be a real call here: build.sh disables the
 * builtin). */
typedef union {
    double d;
    uint64_t u;
} f64bits;

static uint64_t bits(double x) {
    f64bits v;
    v.d = x;
    return v.u;
}

static double from_bits(uint64_t b) {
    f64bits v;
    v.u = b;
    return v.d;
}

#define MASK 0x7FF
#define SHIFT (64 - 11 - 1)
#define BIAS 1023
#define SIGN_MASK (1ull << 63)
#define FRAC_MASK ((1ull << SHIFT) - 1)

static int is_nan(double x) { return x != x; }
static int is_inf(double x) { return x > 1.7976931348623157e308 || x < -1.7976931348623157e308; }
static double inf(int sign) { return from_bits(sign >= 0 ? 0x7FF0000000000000ull : 0xFFF0000000000000ull); }
static double nan_(void) { return from_bits(0x7FF8000000000001ull); }
static double fabs_(double x) { return from_bits(bits(x) & ~SIGN_MASK); }
static double copysign_(double f, double sign) {
    return from_bits((bits(f) & ~SIGN_MASK) | (bits(sign) & SIGN_MASK));
}

static double normalize(double x, int *e) {
    const double SmallestNormal = 2.2250738585072014e-308;
    if (fabs_(x) < SmallestNormal) {
        *e = -52;
        return x * (double)(1ull << 52);
    }
    *e = 0;
    return x;
}

static double frexp_(double f, int *exp) {
    if (f == 0 || is_inf(f) || is_nan(f)) {
        *exp = 0;
        return f;
    }
    int e;
    f = normalize(f, &e);
    uint64_t x = bits(f);
    e += (int)((x >> SHIFT) & MASK) - BIAS + 1;
    x &= ~((uint64_t)MASK << SHIFT);
    x |= (uint64_t)(-1 + BIAS) << SHIFT;
    *exp = e;
    return from_bits(x);
}

static double ldexp_(double frac, int exp) {
    if (frac == 0 || is_inf(frac) || is_nan(frac)) return frac;
    int e;
    frac = normalize(frac, &e);
    exp += e;
    uint64_t x = bits(frac);
    exp += (int)((x >> SHIFT) & MASK) - BIAS;
    if (exp < -1075) return copysign_(0, frac);
    if (exp > 1023) return frac < 0 ? inf(-1) : inf(1);
    double m = 1;
    if (exp < -1022) {
        exp += 53;
        m = 1.0 / (double)(1ull << 53);
    }
    x &= ~((uint64_t)MASK << SHIFT);
    x |= (uint64_t)(exp + BIAS) << SHIFT;
    return m * from_bits(x);
}

static double expmulti(double hi, double lo, int k) {
    const double P1 = 1.66666666666666657415e-01;
    const double P2 = -2.77777777770155933842e-03;
    const double P3 = 6.61375632143793436117e-05;
    const double P4 = -1.65339022054652515390e-06;
    const double P5 = 4.13813679705723846039e-08;
    const double r = hi - lo;
    const double t = r * r;
    const double c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    const double y = 1 - ((lo - (r * c) / (2 - c)) - hi);
    return ldexp_(y, k);
}

double go_exp(double x) {
    const double Ln2Hi = 6.93147180369123816490e-01;
    const double Ln2Lo = 1.90821492927058770002e-10;
    const double Log2e = 1.44269504088896338700e+00;
    const double Overflow = 7.09782712893383973096e+02;
    const double Underflow = -7.45133219101941108420e+02;
    const double NearZero = 1.0 / (1 << 28);
    if (is_nan(x)) return x;
    if (x > Overflow) return inf(1);
    if (x < Underflow) return 0;
    if (-NearZero < x && x < NearZero) return 1 + x;
    int k = 0;
    if (x < 0)
        k = (int)(Log2e * x - 0.5);
    else if (x > 0)
        k = (int)(Log2e * x + 0.5);
    const double hi = x - (double)k * Ln2Hi;
    const double lo = (double)k * Ln2Lo;
    return expmulti(hi, lo, k);
}

double go_log(double x) {
    const double Ln2Hi = 6.93147180369123816490e-01;
    const double Ln2Lo = 1.90821492927058770002e-10;
    const double L1 = 6.666666666666735130e-01;
    const double L2 = 3.999999999940941908e-01;
    const double L3 = 2.857142874366239149e-01;
    const double L4 = 2.222219843214978396e-01;
    const double L5 = 1.818357216161805012e-01;
    const double L6 = 1.531383769920937332e-01;
    const double L7 = 1.479819860511658591e-01;
    const double Sqrt2Half = 0.7071067811865476; /* Go's Sqrt2/2: 0x3fe6a09e667f3bcd */
    if (is_nan(x) || (is_inf(x) && x > 0)) return x;
    if (x < 0) return nan_();
    if (x == 0) return inf(-1);
    int ki;
    double f1 = frexp_(x, &ki);
    if (f1 < Sqrt2Half) {
        f1 *= 2;
        ki--;
    }
    const double f = f1 - 1;
    const double k = (double)ki;
    const double s = f / (2 + f);
    const double s2 = s * s;
    const double s4 = s2 * s2;
    const double t1 = s2 * (L1 + s4 * (L3 + s4 * (L5 + s4 * L7)));
    const double t2 = s4 * (L2 + s4 * (L4 + s4 * L6));
    const double R = t1 + t2;
    const double hfsq = 0.5 * f * f;
    return k * Ln2Hi - ((hfsq - (s * (hfsq + R) + k * Ln2Lo)) - f);
}

static const double sin_c[6] = {
    1.58962301576546568060e-10, -2.50507477628578072866e-8, 2.75573136213857245213e-6,
    -1.98412698295895385996e-4, 8.33333333332211858878e-3,  -1.66666666666666307295e-1,
};
static const double cos_c[6] = {
    -1.13585365213876817300e-11, 2.08757008419747316778e-9, -2.75573141792967388112e-7,
    2.48015872888517045348e-5,   -1.38888888888730564116e-3, 4.16666666666665929218e-2,
};

#define PI4A 7.85398125648498535156e-1
#define PI4B 3.77489470793079817668e-8
#define PI4C 2.69515142907905952645e-15
#define FOUR_OVER_PI 1.2732395447351628 /* Go's 4/Pi: 0x3ff45f306dc9c883 */

static double poly_sin(double z, double zz) {
    return z + z * zz * ((((((sin_c[0] * zz) + sin_c[1]) * zz + sin_c[2]) * zz + sin_c[3]) * zz + sin_c[4]) * zz +
                         sin_c[5]);
}

static double poly_cos(double zz) {
    return 1.0 - 0.5 * zz +
           zz * zz * ((((((cos_c[0] * zz) + cos_c[1]) * zz + cos_c[2]) * zz + cos_c[3]) * zz + cos_c[4]) * zz +
                      cos_c[5]);
}

/* x >= 0 and below 2^29: the octant j and the reduced argument z. */
static double reduce(double x, uint64_t *j_out) {
    uint64_t j = (uint64_t)(x * FOUR_OVER_PI);
    double y = (double)j;
    if (j & 1) {
        j++;
        y++;
    }
    j &= 7;
    *j_out = j;
    return ((x - y * PI4A) - y * PI4B) - y * PI4C;
}

double go_sin(double x) {
    if (x == 0 || is_nan(x)) return x;
    if (is_inf(x)) return nan_();
    int sign = 0;
    if (x < 0) {
        x = -x;
        sign = 1;
    }
    uint64_t j;
    const double z = reduce(x, &j);
    if (j > 3) {
        sign = !sign;
        j -= 4;
    }
    const double zz = z * z;
    double y = (j == 1 || j == 2) ? poly_cos(zz) : poly_sin(z, zz);
    return sign ? -y : y;
}

double go_cos(double x) {
    if (is_nan(x) || is_inf(x)) return nan_();
    int sign = 0;
    x = fabs_(x);
    uint64_t j;
    const double z = reduce(x, &j);
    if (j > 3) {
        j -= 4;
        sign = !sign;
    }
    if (j > 1) sign = !sign;
    const double zz = z * z;
    double y = (j == 1 || j == 2) ? poly_sin(z, zz) : poly_cos(zz);
    return sign ? -y : y;
}

double go_round(double x) {
    uint64_t b = bits(x);
    unsigned e = (unsigned)(b >> SHIFT) & MASK;
    if (e < BIAS) {
        b &= SIGN_MASK;
        if (e == BIAS - 1) b |= 0x3FF0000000000000ull; /* +-1 */
    } else if (e < BIAS + SHIFT) {
        const uint64_t half = 1ull << (SHIFT - 1);
        e -= BIAS;
        b += half >> e;
        b &= ~(FRAC_MASK >> e);
    }
    return from_bits(b);
}
