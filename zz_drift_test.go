package main

import (
	"encoding/binary"
	"math"
	"math/rand"
	"testing"
)

// Reproduce the reported ramp: stationary IQ, min_margin 15, watch bytes/s.
func TestZZDrift(t *testing.T) {
	const (
		fs      = 384000
		frames  = 480 // frames per packet
		seconds = 180
	)
	pkts := fs / frames // per second
	rng := rand.New(rand.NewSource(1))
	enc := NewPCMv4StreamEncoderWithMargin(15)

	raw := make([]byte, frames*2*2)
	phase := 0.0
	dphi := 2 * math.Pi * 12345.0 / fs

	flt := &boxFilter{}
	var bytesAcc int64
	var shiftAcc, shiftN int64
	for s := 0; s < seconds; s++ {
		for p := 0; p < pkts; p++ {
			for i := 0; i < frames; i++ {
				// noise floor + one strong carrier (medium-wave-ish)
				nr, ni := flt.next(rng.NormFloat64()*300, rng.NormFloat64()*300)
				cr := 12000 * math.Cos(phase)
				ci := 12000 * math.Sin(phase)
				phase += dphi
				binary.BigEndian.PutUint16(raw[4*i:], uint16(int16(clampf(nr+cr))))
				binary.BigEndian.PutUint16(raw[4*i+2:], uint16(int16(clampf(ni+ci))))
			}
			out, err := enc.EncodePacket(raw, int64(s)*1e9, fs, 2, -30, -60)
			if err != nil {
				t.Fatal(err)
			}
			bytesAcc += int64(len(out))
		}
		if enc.depth != nil {
			shiftAcc += int64(enc.depth.peakinessDB * 100)
			shiftN++
		}
		if (s+1)%5 == 0 {
			kbps := float64(bytesAcc) * 8 / 1000 / 5
			t.Logf("t=%3ds  %8.1f kbps   peakiness=%.1f dB", s+1, kbps, enc.depth.peakinessDB)
			bytesAcc = 0
		}
	}
}

func clampf(v float64) float64 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return v
}

// boxFilter is a crude lowpass: an 8-tap moving average, which leaves the top
// of the band essentially empty -- the same shape radiod's channel filter
// gives an IQ stream.
type boxFilter struct {
	re, im [8]float64
	i      int
}

func (f *boxFilter) next(r, m float64) (float64, float64) {
	f.re[f.i], f.im[f.i] = r, m
	f.i = (f.i + 1) % len(f.re)
	var sr, si float64
	for k := range f.re {
		sr += f.re[k]
		si += f.im[k]
	}
	return sr / 2, si / 2
}
