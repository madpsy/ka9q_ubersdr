package pcmv4

import (
	"math"
	"testing"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/pcmv4/v4enc"
)

// testIQ is a tone plus a little deterministic noise: enough structure for the
// predictor to adapt to, enough noise that it never becomes trivial.
func testIQ(n int, phase *float64) []int16 {
	out := make([]int16, 2*n)
	var seed uint32 = uint32(*phase * 1000)
	for i := 0; i < n; i++ {
		*phase += 2 * math.Pi * 0.0123
		seed = seed*1664525 + 1013904223
		noise := float64(int32(seed>>16)&0x3ff) - 512
		out[2*i] = int16(8000*math.Cos(*phase) + noise)
		out[2*i+1] = int16(8000*math.Sin(*phase) - noise)
	}
	return out
}

// The server's own encoder, through this decoder, returns the samples exactly --
// across packet sizes, a silent packet and a rate change.
func TestRoundTripLossless(t *testing.T) {
	enc := v4enc.New()
	dec := NewPCMv4StreamDecoder()
	var phase float64
	sizes := []int{238, 500, 1024, 17, 4096}
	for i := 0; i < 60; i++ {
		rate := 192000
		if i >= 40 {
			rate = 96000
		}
		in := testIQ(sizes[i%len(sizes)], &phase)
		if i == 7 {
			in = make([]int16, len(in))
		}
		pkt, err := enc.Encode(in, rate, 2, 0)
		if err != nil {
			t.Fatal(err)
		}
		h, out, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if h.SampleRate != rate || h.Channels != 2 {
			t.Fatalf("packet %d: %d Hz %d ch", i, h.SampleRate, h.Channels)
		}
		if len(out) != len(in) {
			t.Fatalf("packet %d: %d samples, want %d", i, len(out), len(in))
		}
		for j := range in {
			if out[j] != in[j] {
				t.Fatalf("packet %d sample %d: %d, want %d", i, j, out[j], in[j])
			}
		}
	}
}

// Reduced depth: what comes back is the input quantised and restored, so every
// sample is within half a step of what went in, and a changing shift is
// followed.
func TestRoundTripScaled(t *testing.T) {
	enc := v4enc.New()
	dec := NewPCMv4StreamDecoder()
	var phase float64
	for i, shift := range []uint{3, 3, 5, 0, 2, 2, 7} {
		in := testIQ(700, &phase)
		pkt, err := enc.Encode(in, 384000, 2, shift)
		if err != nil {
			t.Fatal(err)
		}
		h, out, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		wantProfile := byte(PredProfileIQ)
		if shift > 0 {
			wantProfile = PredProfileIQScaled
		}
		if h.Profile != wantProfile {
			t.Fatalf("packet %d: profile %d, want %d", i, h.Profile, wantProfile)
		}
		tol := 0
		if shift > 0 {
			tol = 1 << (shift - 1)
		}
		for j := range in {
			d := int(out[j]) - int(in[j])
			if d < -tol || d > tol {
				t.Fatalf("packet %d sample %d: %d from %d, beyond half a step of shift %d", i, j, out[j], in[j], shift)
			}
		}
	}
}
