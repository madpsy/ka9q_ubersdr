package pcmv4

// The order-16 block paths against the per-frame forward and inverse they
// replace, with the SIMD kernel and without, and the server-encoded fixtures
// decoded again with the kernel off so the pure-Go block is held to them on
// every machine.

import (
	"math"
	"math/rand"
	"testing"
)

// withPCMv4SIMD runs fn with the SIMD kernel on or off, restoring it after.
func withPCMv4SIMD(t testing.TB, on bool, fn func()) {
	t.Helper()
	saved := pcmv4UseSIMD
	pcmv4UseSIMD = on
	defer func() { pcmv4UseSIMD = saved }()
	fn()
}

func TestPCMv4FixturesPureGoBlock(t *testing.T) {
	withPCMv4SIMD(t, false, func() {
		t.Run("TestDecodesServerStream", TestDecodesServerStream)
		t.Run("TestDecodesScaledStream", TestDecodesScaledStream)
		t.Run("TestDecodesRiceEdge", TestDecodesRiceEdge)
	})
}

func clonePCMv4Stage(f *complexStage) *complexStage {
	c := *f
	c.wr = append([]int64(nil), f.wr...)
	c.wi = append([]int64(nil), f.wi...)
	c.hr = append([]int64(nil), f.hr...)
	c.hi = append([]int64(nil), f.hi...)
	c.sr = append([]int64(nil), f.sr...)
	c.si = append([]int64(nil), f.si...)
	return &c
}

// samePCMv4Stage compares what a stage's next frame depends on: taps, the
// active window and its signs, wherever in the backing array the window sits.
func samePCMv4Stage(a, b *complexStage) bool {
	for j := 0; j < 16; j++ {
		if a.wr[j] != b.wr[j] || a.wi[j] != b.wi[j] {
			return false
		}
		ia, ib := a.idx-16+j, b.idx-16+j
		if a.hr[ia] != b.hr[ib] || a.hi[ia] != b.hi[ib] || a.sr[ia] != b.sr[ib] || a.si[ia] != b.si[ib] {
			return false
		}
	}
	return true
}

// TestPCMv4BlockMatchesPerFrame drives the per-frame paths and each block
// path from the same start: taps at rest, at the clamp limit and anywhere in
// range; packets from one frame up; samples from silence to full scale and a
// tone that drives the taps to real-signal size, where the leak bites; and on
// the decode side residuals near +-2^31 that take a sample past int32 and the
// kernel's early stop. Output and stage must agree after every packet.
func TestPCMv4BlockMatchesPerFrame(t *testing.T) {
	kernels := []bool{false}
	if pcmv4UseSIMD {
		kernels = append(kernels, true)
	}
	rng := rand.New(rand.NewSource(31))
	for trial := 0; trial < 60; trial++ {
		start := newComplexStage(16, 16)
		for j := 0; j < 16; j++ {
			switch trial % 3 {
			case 1:
				v := int64(predTapLimit - rng.Intn(64))
				if rng.Intn(2) == 0 {
					v = -v
				}
				start.wr[j], start.wi[j] = v, -v
			case 2:
				start.wr[j] = rng.Int63n(2*predTapLimit+1) - predTapLimit
				start.wi[j] = rng.Int63n(2*predTapLimit+1) - predTapLimit
			}
		}
		amp, step := 2000+rng.Float64()*28000, 0.01+0.6*rng.Float64()
		for _, simd := range kernels {
			want, got := clonePCMv4Stage(start), clonePCMv4Stage(start)
			phase := 0
			withPCMv4SIMD(t, simd, func() {
				for p := 0; p < 40; p++ {
					frames := 1 + rng.Intn(400)
					want.beginPacket(frames)
					got.beginPacket(frames)
					if rng.Intn(2) == 0 {
						in := make([]int16, 2*frames)
						kind := rng.Intn(6)
						for i := 0; i < len(in); i += 2 {
							switch kind {
							case 0: // silence
							case 1, 2: // a tone that runs on across packets
								in[i] = int16(amp * math.Cos(step*float64(phase)))
								in[i+1] = int16(amp * math.Sin(step*float64(phase)))
								phase++
							case 3:
								in[i], in[i+1] = int16(rng.Intn(3)-1), int16(rng.Intn(3)-1)
							default:
								in[i], in[i+1] = int16(rng.Intn(65536)-32768), int16(rng.Intn(65536)-32768)
							}
						}
						a, b := make([]int32, len(in)), make([]int32, len(in))
						for i := 0; i < len(in); i += 2 {
							r, q := want.forward(int64(in[i]), int64(in[i+1]))
							a[i], a[i+1] = int32(r), int32(q)
						}
						got.forwardBlock16(in, b)
						for i := range a {
							if a[i] != b[i] {
								t.Fatalf("trial %d simd=%v packet %d forward: residual %d is %d, want %d", trial, simd, p, i, b[i], a[i])
							}
						}
					} else {
						in := make([]int32, 2*frames)
						huge := rng.Intn(4) == 0
						for i := range in {
							if huge && rng.Intn(50) == 0 {
								in[i] = int32(1<<31 - 1 - rng.Intn(1000))
								if rng.Intn(2) == 0 {
									in[i] = -in[i] - 1
								}
							} else {
								in[i] = int32(rng.Intn(2001) - 1000)
							}
						}
						a, b := make([]int16, len(in)), make([]int16, len(in))
						for i := 0; i < len(in); i += 2 {
							r, q := want.inverse(int64(in[i]), int64(in[i+1]))
							a[i], a[i+1] = int16(r), int16(q)
						}
						got.inverseBlock16(in, b)
						for i := range a {
							if a[i] != b[i] {
								t.Fatalf("trial %d simd=%v packet %d inverse: sample %d is %d, want %d", trial, simd, p, i, b[i], a[i])
							}
						}
					}
					if !samePCMv4Stage(want, got) {
						t.Fatalf("trial %d simd=%v packet %d: stage state differs", trial, simd, p)
					}
				}
			})
		}
	}
}
