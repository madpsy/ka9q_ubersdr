/*
 * kernels.c - the float32 loops that carry nearly all of the arithmetic.
 *
 *   f32_axpy:  dst[i] += a*src[i]                       (depthwise convolution)
 *   f32_axpy4: dst[i] += w0*s0[i] + w1*s1[i] + w2*s2[i] + w3*s3[i]
 *                                                       (pointwise convolution)
 *   f32_dot:   s = ((a0*b0 + a1*b1) + a2*b2) + ...      (everything else)
 *
 * With __wasm_simd128__ (build.sh's SIMD build) the first two run four
 * elements at a time. That changes nothing in the result: each element is the
 * same chain of float32 operations in the same order as the scalar loop, and
 * WebAssembly has no fused multiply-add to round differently. f32_dot is a sum
 * along the vector, so splitting it into lanes would change its rounding; it
 * stays scalar in both builds, as Go's is.
 */
#include "audioclass.h"

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

float f32_dot(const float *a, const float *b, int n) {
    float s = 0;
    for (int i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

void f32_axpy(float *dst, const float *src, float a, int n) {
    int i = 0;
#ifdef __wasm_simd128__
    const v128_t va = wasm_f32x4_splat(a);
    for (; i + 4 <= n; i += 4) {
        const v128_t d = wasm_v128_load(dst + i);
        const v128_t s = wasm_v128_load(src + i);
        wasm_v128_store(dst + i, wasm_f32x4_add(d, wasm_f32x4_mul(va, s)));
    }
#endif
    for (; i < n; i++) dst[i] += a * src[i];
}

void f32_axpy4(float *dst, const float *s0, const float *s1, const float *s2, const float *s3, const float w[4],
               int n) {
    const float w0 = w[0], w1 = w[1], w2 = w[2], w3 = w[3];
    int i = 0;
#ifdef __wasm_simd128__
    const v128_t v0 = wasm_f32x4_splat(w0), v1 = wasm_f32x4_splat(w1);
    const v128_t v2 = wasm_f32x4_splat(w2), v3 = wasm_f32x4_splat(w3);
    for (; i + 4 <= n; i += 4) {
        v128_t t = wasm_f32x4_add(wasm_f32x4_mul(v0, wasm_v128_load(s0 + i)), wasm_f32x4_mul(v1, wasm_v128_load(s1 + i)));
        t = wasm_f32x4_add(t, wasm_f32x4_mul(v2, wasm_v128_load(s2 + i)));
        t = wasm_f32x4_add(t, wasm_f32x4_mul(v3, wasm_v128_load(s3 + i)));
        wasm_v128_store(dst + i, wasm_f32x4_add(wasm_v128_load(dst + i), t));
    }
#endif
    for (; i < n; i++) dst[i] += w0 * s0[i] + w1 * s1[i] + w2 * s2[i] + w3 * s3[i];
}

/* f32_axpy4 for four outputs at once, sharing the loads of s0..s3: d[j] gets
 * exactly what f32_axpy4(d[j], s0..s3, w + 4*j, n) would give it. */
void f32_axpy4x4(float *const d[4], const float *s0, const float *s1, const float *s2, const float *s3,
                 const float w[16], int n) {
    int i = 0;
#ifdef __wasm_simd128__
    v128_t W[16];
    for (int k = 0; k < 16; k++) W[k] = wasm_f32x4_splat(w[k]);
    float *d0 = d[0], *d1 = d[1], *d2 = d[2], *d3 = d[3];
    for (; i + 4 <= n; i += 4) {
        const v128_t a = wasm_v128_load(s0 + i), b = wasm_v128_load(s1 + i);
        const v128_t c = wasm_v128_load(s2 + i), e = wasm_v128_load(s3 + i);
#define ROW(dst, k)                                                                                       \
    do {                                                                                                  \
        v128_t t = wasm_f32x4_add(wasm_f32x4_mul(W[k], a), wasm_f32x4_mul(W[k + 1], b));                  \
        t = wasm_f32x4_add(t, wasm_f32x4_mul(W[k + 2], c));                                               \
        t = wasm_f32x4_add(t, wasm_f32x4_mul(W[k + 3], e));                                               \
        wasm_v128_store((dst) + i, wasm_f32x4_add(wasm_v128_load((dst) + i), t));                        \
    } while (0)
        ROW(d0, 0);
        ROW(d1, 4);
        ROW(d2, 8);
        ROW(d3, 12);
#undef ROW
    }
#endif
    for (int j = 0; j < 4; j++) {
        const float *wj = w + 4 * j;
        float *dj = d[j];
        for (int k = i; k < n; k++) dj[k] += wj[0] * s0[k] + wj[1] * s1[k] + wj[2] * s2[k] + wj[3] * s3[k];
    }
}
