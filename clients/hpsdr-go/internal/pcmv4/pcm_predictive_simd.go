//go:build amd64 && !purego

package pcmv4

// pcmv4SIMDState is the order-16 complex stage as the SIMD kernels hold it:
// taps and the newest 16 history samples, oldest first, in int32.
// pcm_predictive_amd64.s reads it at fixed offsets.
//
// int32 is exact: a tap never leaves +-predTapLimit (2^24) -- the kernels
// always clamp, which where the Go code skips the clamp is an identity -- and
// the products are formed in int64 lanes. A history sample outside int32 can
// only come from a corrupt stream; the kernels are not used while one is in
// the window, and the decoder kernel stops before taking one in.
type pcmv4SIMDState struct {
	wr, wi [16]int32
	hr, hi [16]int32
}

func (st *pcmv4SIMDState) load(f *complexStage) bool {
	lo := f.idx - 16
	for j := 0; j < 16; j++ {
		r, i := f.hr[lo+j], f.hi[lo+j]
		if r != int64(int32(r)) || i != int64(int32(i)) {
			return false
		}
		st.wr[j], st.wi[j] = int32(f.wr[j]), int32(f.wi[j])
		st.hr[j], st.hi[j] = int32(r), int32(i)
	}
	return true
}

// store writes st back to f, the window at the front of the history.
func (st *pcmv4SIMDState) store(f *complexStage) {
	for j := 0; j < 16; j++ {
		f.wr[j], f.wi[j] = int64(st.wr[j]), int64(st.wi[j])
		r, i := int64(st.hr[j]), int64(st.hi[j])
		f.hr[j], f.hi[j] = r, i
		f.sr[j], f.si[j] = predSign(r), predSign(i)
	}
	f.idx = 16
}

func (f *complexStage) forwardSIMD(samples []int16, res []int32) bool {
	var st pcmv4SIMDState
	if !pcmv4UseSIMD || len(samples) < 2 || !st.load(f) {
		return false
	}
	pcmv4SIMDForward(&st, &samples[0], &res[0], len(samples)/2, f.mu)
	st.store(f)
	return true
}

// inverseSIMD returns how many samples the kernel reconstructed; the caller
// does the rest frame by frame.
func (f *complexStage) inverseSIMD(res []int32, out []int16) int {
	var st pcmv4SIMDState
	if !pcmv4UseSIMD || len(res) < 2 || !st.load(f) {
		return 0
	}
	frames := pcmv4SIMDInverse(&st, &res[0], &out[0], len(res)/2, f.mu)
	st.store(f)
	return 2 * frames
}
