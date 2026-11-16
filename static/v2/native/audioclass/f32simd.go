// f32simd.go — the float32 loops that carry nearly all of the classifier's
// arithmetic:
//
//   - axpy:  dst += a*src           (depthwise convolution along time)
//   - axpy4: dst += Σ w[k]*src[k]   (pointwise convolution, four input
//     channels per pass so each output row is loaded and stored a quarter
//     as often)
//   - dot:   Σ a[i]*b[i]            (fully connected layers, resampler)
//
// The airsplice original has AVX2/NEON assembly behind these. This copy is
// built for the browser, and Go's WebAssembly target has no SIMD, so the
// plain loops are all there is. The names are kept so efficientat.go is the
// same file in both places.
package main

// f32Axpy computes dst[i] += a*src[i] over len(dst); src must be at least as long.
func f32Axpy(dst, src []float32, a float32) {
	n := len(dst)
	if n == 0 {
		return
	}
	_ = src[n-1]
	for i := 0; i < n; i++ {
		dst[i] += a * src[i]
	}
}

// f32Axpy4 computes dst[i] += w[0]*s0[i] + w[1]*s1[i] + w[2]*s2[i] + w[3]*s3[i].
func f32Axpy4(dst, s0, s1, s2, s3 []float32, w *[4]float32) {
	n := len(dst)
	if n == 0 {
		return
	}
	_, _, _, _ = s0[n-1], s1[n-1], s2[n-1], s3[n-1]
	w0, w1, w2, w3 := w[0], w[1], w[2], w[3]
	for i := 0; i < n; i++ {
		dst[i] += w0*s0[i] + w1*s1[i] + w2*s2[i] + w3*s3[i]
	}
}

// f32Dot returns Σ a[i]*b[i] over len(a); b must be at least as long.
func f32Dot(a, b []float32) float32 {
	n := len(a)
	if n == 0 {
		return 0
	}
	_ = b[n-1]
	var s float32
	for i := 0; i < n; i++ {
		s += a[i] * b[i]
	}
	return s
}
