package main

import (
	"encoding/binary"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// TestGenerateScaledFixture writes static/v2/test/pcmv4scaled.sample.bin, the
// vector the browser decoder is checked against.
//
// Skipped unless GEN_FIXTURE is set. The fixture is committed, because the point
// of it is that two independent implementations agree: regenerating it from the
// Go side on every run would only ever prove the Go side agrees with itself.
//
// Layout matches pcmv4.sample.bin, which the lossless test already reads:
//
//	[packet length u32][sample count u32][packet][expected samples int16 LE]
//
// The expected samples are what the GO decoder returns -- quantised and shifted
// back -- not the input. The mode is lossy against the input by design; what
// must match across the language boundary is the reconstruction.
func TestGenerateScaledFixture(t *testing.T) {
	if os.Getenv("GEN_FIXTURE") == "" {
		t.Skip("set GEN_FIXTURE=1 to regenerate the browser fixture")
	}
	const (
		rate    = 192000
		frames  = 360
		packets = 1200
	)
	enc := NewPCMv4StreamEncoderWithMargin(26)
	dec := NewPCMv4StreamDecoder()
	rng := rand.New(rand.NewSource(99))

	var out []byte
	ts := int64(0)
	phase := 0.0
	for p := 0; p < packets; p++ {
		// A carrier over a noise floor. A flat noise band would leave the
		// selector at a shift of zero for every packet and the fixture would
		// exercise nothing the lossless one does not.
		samples := make([]int16, frames*2)
		amp := 9000.0
		if p > packets/2 {
			amp = 2000.0 // a level change partway, so the depth has to move
		}
		for i := 0; i < frames; i++ {
			phase += 0.31
			samples[2*i] = clampInt16(amp*math.Cos(phase) + rng.NormFloat64()*250)
			samples[2*i+1] = clampInt16(amp*math.Sin(phase) + rng.NormFloat64()*250)
		}
		raw := make([]byte, len(samples)*2)
		for i, v := range samples {
			binary.BigEndian.PutUint16(raw[2*i:], uint16(v))
		}
		ts += int64(frames) * 1e9 / rate

		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: encode: %v", p, err)
		}
		pkt = append([]byte(nil), pkt...)

		_, got, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: decode: %v", p, err)
		}

		var hdr [8]byte
		binary.LittleEndian.PutUint32(hdr[0:], uint32(len(pkt)))
		binary.LittleEndian.PutUint32(hdr[4:], uint32(len(got)))
		out = append(out, hdr[:]...)
		out = append(out, pkt...)
		for _, v := range got {
			out = append(out, byte(uint16(v)), byte(uint16(v)>>8))
		}
	}

	path := filepath.Join("static", "v2", "test", "pcmv4scaled.sample.bin")
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s (%d packets, %d bytes)", path, packets, len(out))
}

func clampInt16(v float64) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}
