package main

// Guards for forwardBlock16, the whole-packet path every IQ profile encodes
// through. Where a SIMD kernel exists (AVX2 on amd64, NEON on arm64) the
// wire-identity tests already run it against the reference, but only through
// the kernel; these hold the pure-Go block (what every other machine runs) to
// the same reference, and fuzz both against the per-frame forward they
// replace, state included.

import (
	"math/rand"
	"testing"
)

// withBlockKernel runs fn with the SIMD kernel on or off, restoring it after.
func withBlockKernel(t *testing.T, simd bool, fn func()) {
	t.Helper()
	saved := cx16SIMD
	cx16SIMD = simd
	defer func() { cx16SIMD = saved }()
	fn()
}

// TestPredictiveWireIdenticalPureGoBlock reruns the capture, synthetic and
// near-limit wire tests with the assembly kernel off.
func TestPredictiveWireIdenticalPureGoBlock(t *testing.T) {
	withBlockKernel(t, false, func() {
		t.Run("captures", TestPredictiveWireIdenticalOnCaptures)
		t.Run("synthetic", TestPredictiveWireIdenticalOnSynthetic)
		t.Run("near-limit", TestPredictiveWireIdenticalNearTapLimit)
		t.Run("silence", TestPredictiveAdvanceSilenceMatchesEncode)
	})
}

// sameStage compares everything forward can observe of a stage: taps, the
// active history window and its signs. Where in the backing array the window
// sits is not compared, since the block paths slide it at different times.
func sameStage(a, b *complexStage) bool {
	for j := 0; j < 16; j++ {
		if a.wr[j] != b.wr[j] || a.wi[j] != b.wi[j] {
			return false
		}
		ia, ib := a.idx-16+j, b.idx-16+j
		if a.hr[ia] != b.hr[ib] || a.hi[ia] != b.hi[ib] ||
			a.sr[ia] != b.sr[ib] || a.si[ia] != b.si[ib] {
			return false
		}
	}
	return true
}

// TestPredictiveBlock16MatchesPerFrame drives the per-frame forward and each
// available block path from the same start over random packets -- lengths
// from a single frame up, amplitudes from silence to full scale, and taps
// preloaded at the clamp limit so the clamped loop and the kernel's clamp both
// fire -- and requires the same residuals and the same stage state after every
// packet.
func TestPredictiveBlock16MatchesPerFrame(t *testing.T) {
	kernels := []bool{false}
	if cx16SIMD {
		kernels = append(kernels, true)
	}
	rng := rand.New(rand.NewSource(31))
	for trial := 0; trial < 60; trial++ {
		ref := newComplexStage(16, 16)
		blk := newComplexStage(16, 16)
		switch trial % 3 {
		case 1: // at the limit, so the clamp fires from the first frame
			for j := 0; j < 16; j++ {
				v := int64(predTapLimit - rng.Intn(64))
				if rng.Intn(2) == 0 {
					v = -v
				}
				ref.wr[j], blk.wr[j] = v, v
				v = -v
				ref.wi[j], blk.wi[j] = v, v
			}
		case 2: // anywhere in range
			for j := 0; j < 16; j++ {
				a := rng.Int63n(2*predTapLimit+1) - predTapLimit
				b := rng.Int63n(2*predTapLimit+1) - predTapLimit
				ref.wr[j], blk.wr[j] = a, a
				ref.wi[j], blk.wi[j] = b, b
			}
		}
		for _, simd := range kernels {
			// Each kernel runs from a fresh copy of the starting state.
			cur := cloneComplexStage(blk)
			want := cloneComplexStage(ref)
			withBlockKernel(t, simd, func() {
				for p := 0; p < 40; p++ {
					frames := 1 + rng.Intn(400)
					amp := []int{0, 1, 3, 300, 32768}[rng.Intn(5)]
					pkt := make([]int16, 2*frames)
					for i := range pkt {
						if amp == 32768 {
							pkt[i] = int16(rng.Intn(65536) - 32768)
						} else if amp > 0 {
							pkt[i] = int16(rng.Intn(2*amp+1) - amp)
						}
					}
					resRef := make([]int32, len(pkt))
					resBlk := make([]int32, len(pkt))
					want.beginPacket(frames)
					for i := 0; i < len(pkt); i += 2 {
						a, b := want.forward(int64(pkt[i]), int64(pkt[i+1]))
						resRef[i], resRef[i+1] = int32(a), int32(b)
					}
					cur.beginPacket(frames)
					cur.forwardBlock16(pkt, resBlk)
					for i := range resRef {
						if resRef[i] != resBlk[i] {
							t.Fatalf("trial %d simd=%v packet %d: residual %d is %d, per-frame %d",
								trial, simd, p, i, resBlk[i], resRef[i])
						}
					}
					if !sameStage(want, cur) {
						t.Fatalf("trial %d simd=%v packet %d: stage state differs", trial, simd, p)
					}
				}
			})
		}
	}
}

func cloneComplexStage(f *complexStage) *complexStage {
	c := *f
	c.wr = append([]int64(nil), f.wr...)
	c.wi = append([]int64(nil), f.wi...)
	c.hr = append([]int64(nil), f.hr...)
	c.hi = append([]int64(nil), f.hi...)
	c.sr = append([]int64(nil), f.sr...)
	c.si = append([]int64(nil), f.si...)
	return &c
}

// BenchmarkPredictiveCaptureIQ384PureGo is BenchmarkPredictiveCaptureIQ384
// through the pure-Go block, what machines without a SIMD kernel run.
func BenchmarkPredictiveCaptureIQ384PureGo(b *testing.B) {
	saved := cx16SIMD
	cx16SIMD = false
	defer func() { cx16SIMD = saved }()
	benchmarkCapture(b, "iq384-ft8-14074.bin", PredProfileIQ)
}
