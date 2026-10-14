//go:build (amd64 || (arm64 && cgo)) && !purego

package main

// cx16State is the order-16 complex stage as the SIMD kernels hold it: taps
// and the newest 16 history samples, oldest first, in int32. The AVX2 kernel
// reads it at fixed offsets (pcm_predictive_amd64.s) and the NEON one as a C
// struct of the same layout (pcm_predictive_arm64.go).
type cx16State struct {
	wr, wi [16]int32
	hr, hi [16]int32
}

// forwardBlock16Asm is forwardBlock16 through this machine's SIMD kernel,
// reporting false when there is none.
//
// The kernels work in int32 lanes, which hold every value this stage can
// reach: a tap never leaves +-predTapLimit (2^24) -- the clamp, which the
// kernels always apply, sees to that, and where the Go loop skips it the
// clamp is an identity -- and the history of the single stage every IQ
// profile uses is the int16 input itself. The prediction's products are
// formed in int64 lanes, so the sum is exactly the Go one.
func (f *complexStage) forwardBlock16Asm(samples []int16, res []int32) bool {
	if !cx16SIMD || len(samples) < 2 {
		return false
	}
	var st cx16State
	lo := f.idx - 16
	for j := 0; j < 16; j++ {
		st.wr[j], st.wi[j] = int32(f.wr[j]), int32(f.wi[j])
		st.hr[j], st.hi[j] = int32(f.hr[lo+j]), int32(f.hi[lo+j])
	}
	cx16Forward(&st, &samples[0], &res[0], len(samples)/2, f.mu)
	for j := 0; j < 16; j++ {
		f.wr[j], f.wi[j] = int64(st.wr[j]), int64(st.wi[j])
		r, i := int64(st.hr[j]), int64(st.hi[j])
		f.hr[j], f.hi[j] = r, i
		f.sr[j], f.si[j] = predSign(r), predSign(i)
	}
	f.idx = 16
	return true
}
