package main

import (
	"math"
	"math/rand"
	"testing"
)

// roundTrip encodes then decodes a sequence of packets through a fresh
// encoder/decoder pair and fails if any sample differs.
//
// Encoder and decoder are separate instances on purpose: they must stay in
// step through their own independent adaptation, which is the whole contract.
func roundTrip(t *testing.T, profileID byte, packets [][]int16) (encoded, raw int) {
	t.Helper()
	enc, err := NewPredictiveCodec(profileID)
	if err != nil {
		t.Fatalf("new encoder: %v", err)
	}
	dec, err := NewPredictiveCodec(profileID)
	if err != nil {
		t.Fatalf("new decoder: %v", err)
	}
	for n, pkt := range packets {
		payload, err := enc.Encode(pkt)
		if err != nil {
			t.Fatalf("packet %d: encode: %v", n, err)
		}
		encoded += len(payload)
		raw += len(pkt) * 2
		got, err := dec.Decode(payload, len(pkt))
		if err != nil {
			t.Fatalf("packet %d: decode: %v", n, err)
		}
		if len(got) != len(pkt) {
			t.Fatalf("packet %d: got %d samples, want %d", n, len(got), len(pkt))
		}
		for i := range pkt {
			if got[i] != pkt[i] {
				t.Fatalf("packet %d sample %d: got %d, want %d (not lossless)", n, i, got[i], pkt[i])
			}
		}
	}
	return encoded, raw
}

// synthIQ builds interleaved I/Q resembling a real stream: a couple of carriers
// on a noise floor, at a level well below full scale as a receiver delivers.
func synthIQ(rng *rand.Rand, packets, samplesPerPacket int) [][]int16 {
	out := make([][]int16, packets)
	phase1, phase2 := 0.0, 0.0
	for p := range out {
		s := make([]int16, samplesPerPacket)
		for i := 0; i < samplesPerPacket; i += 2 {
			phase1 += 0.31
			phase2 += 1.17
			re := 3000*math.Cos(phase1) + 900*math.Cos(phase2) + rng.NormFloat64()*400
			im := 3000*math.Sin(phase1) + 900*math.Sin(phase2) + rng.NormFloat64()*400
			s[i] = clampSample(re)
			s[i+1] = clampSample(im)
		}
		out[p] = s
	}
	return out
}

// synthAudio builds mono audio: a tone plus noise, oversampled the way a
// demodulated channel is.
func synthAudio(rng *rand.Rand, packets, samplesPerPacket int) [][]int16 {
	out := make([][]int16, packets)
	phase := 0.0
	for p := range out {
		s := make([]int16, samplesPerPacket)
		for i := range s {
			phase += 0.19
			s[i] = clampSample(5000*math.Sin(phase) + rng.NormFloat64()*250)
		}
		out[p] = s
	}
	return out
}

func clampSample(v float64) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(math.Round(v))
}

func TestPredictiveRoundTripIQ(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	pkts := synthIQ(rng, 200, 720)
	enc, raw := roundTrip(t, PredProfileIQ, pkts)
	ratio := float64(raw) / float64(enc)
	t.Logf("IQ: %d -> %d bytes (%.3fx)", raw, enc, ratio)
	if ratio <= 1.0 {
		t.Errorf("IQ profile did not compress correlated input: %.3fx", ratio)
	}
}

func TestPredictiveRoundTripAudio(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	pkts := synthAudio(rng, 200, 480)
	enc, raw := roundTrip(t, PredProfileAudio, pkts)
	ratio := float64(raw) / float64(enc)
	t.Logf("audio: %d -> %d bytes (%.3fx)", raw, enc, ratio)
	if ratio <= 1.0 {
		t.Errorf("audio profile did not compress correlated input: %.3fx", ratio)
	}
}

// Inputs a front end can actually produce in fault states, each of which has
// broken a prototype of this codec at some point.
func TestPredictiveEdgeCases(t *testing.T) {
	cases := []struct {
		name    string
		profile byte
		gen     func(i int) int16
	}{
		{"silence", PredProfileAudio, func(i int) int16 { return 0 }},
		{"positive full scale", PredProfileAudio, func(i int) int16 { return 32767 }},
		{"negative full scale", PredProfileAudio, func(i int) int16 { return -32768 }},
		{"alternating extremes", PredProfileAudio, func(i int) int16 {
			if i&1 == 0 {
				return 32767
			}
			return -32768
		}},
		{"sparse impulses", PredProfileAudio, func(i int) int16 {
			if i%97 == 0 {
				return 32767
			}
			return 0
		}},
		{"step transitions", PredProfileAudio, func(i int) int16 {
			if (i/500)%2 == 0 {
				return 0
			}
			return -32768
		}},
		{"iq silence", PredProfileIQ, func(i int) int16 { return 0 }},
		{"iq full scale", PredProfileIQ, func(i int) int16 {
			if i&1 == 0 {
				return 32767
			}
			return -32768
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pkts := make([][]int16, 60)
			for p := range pkts {
				s := make([]int16, 480)
				for i := range s {
					s[i] = tc.gen(p*480 + i)
				}
				pkts[p] = s
			}
			roundTrip(t, tc.profile, pkts)
		})
	}
}

// Full-entropy input is the worst case a live stream can sit in, and without
// the verbatim escape it expands. The escape caps the damage at parity.
func TestPredictiveIncompressibleDoesNotExpand(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	pkts := make([][]int16, 100)
	for p := range pkts {
		s := make([]int16, 720)
		for i := range s {
			s[i] = int16(rng.Intn(65536) - 32768)
		}
		pkts[p] = s
	}
	enc, raw := roundTrip(t, PredProfileIQ, pkts)
	// One flag byte per packet is the only permitted overhead.
	maxAllowed := raw + len(pkts)
	t.Logf("incompressible: %d -> %d bytes (%.4fx)", raw, enc, float64(raw)/float64(enc))
	if enc > maxAllowed {
		t.Errorf("expanded beyond the escape bound: %d bytes, allow at most %d", enc, maxAllowed)
	}
}

// A stream that keeps running after an escaped packet must stay in step: the
// filters have to advance across the escape on both sides.
func TestPredictiveStateSurvivesEscape(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	pkts := synthIQ(rng, 40, 720)
	// splice in packets the predictor cannot help
	for k := 0; k < 5; k++ {
		noise := make([]int16, 720)
		for i := range noise {
			noise[i] = int16(rng.Intn(65536) - 32768)
		}
		pkts = append(pkts, noise)
	}
	pkts = append(pkts, synthIQ(rng, 40, 720)...)
	roundTrip(t, PredProfileIQ, pkts)
}

// Upstream drops (audio.go skips packets when a slow client backs up) never
// reach the encoder, so both sides see the same sequence and must stay exact.
func TestPredictiveSurvivesUpstreamDrops(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	all := synthIQ(rng, 300, 720)
	var kept [][]int16
	for i, p := range all {
		if i%17 == 0 {
			continue // dropped before the encoder ever saw it
		}
		kept = append(kept, p)
	}
	roundTrip(t, PredProfileIQ, kept)
}

// A client is told which predictor to use and never infers it. This walks a
// stream that switches profile mid-flight, as a mode change does.
func TestPredictiveProfileIsSelfDescribing(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	type segment struct {
		channels int
		packets  [][]int16
	}
	segments := []segment{
		{2, synthIQ(rng, 50, 720)},
		{1, synthAudio(rng, 50, 480)},
		{2, synthIQ(rng, 50, 720)},
		{1, synthAudio(rng, 50, 480)},
	}

	// The receiver knows nothing but what each payload declares.
	var dec *PredictiveCodec
	var decProfile byte
	haveDec := false

	var enc *PredictiveCodec
	var encProfile byte
	switches := 0

	for si, seg := range segments {
		want := ProfileForChannels(seg.channels)
		if enc == nil || want != encProfile {
			var err error
			enc, err = NewPredictiveCodec(want)
			if err != nil {
				t.Fatalf("segment %d: %v", si, err)
			}
			encProfile = want
			switches++
		}
		for pi, pkt := range seg.packets {
			payload, err := enc.Encode(pkt)
			if err != nil {
				t.Fatalf("segment %d packet %d: encode: %v", si, pi, err)
			}
			id, ok := PredictiveProfileID(payload)
			if !ok {
				t.Fatalf("segment %d packet %d: no profile id", si, pi)
			}
			if !haveDec || id != decProfile {
				dec, err = NewPredictiveCodec(id)
				if err != nil {
					t.Fatalf("segment %d packet %d: %v", si, pi, err)
				}
				decProfile = id
				haveDec = true
			}
			got, err := dec.Decode(payload, len(pkt))
			if err != nil {
				t.Fatalf("segment %d packet %d: decode: %v", si, pi, err)
			}
			for i := range pkt {
				if got[i] != pkt[i] {
					t.Fatalf("segment %d packet %d sample %d: got %d want %d",
						si, pi, i, got[i], pkt[i])
				}
			}
		}
	}
	if switches != 4 {
		t.Errorf("expected 4 profile switches, got %d", switches)
	}
}

// An unknown profile must fail rather than decode with the wrong predictor and
// return plausible noise.
func TestPredictiveUnknownProfileRejected(t *testing.T) {
	if _, err := NewPredictiveCodec(9); err == nil {
		t.Fatal("expected an error for an unimplemented profile id")
	}
	for _, id := range []byte{PredProfileIQ, PredProfileAudio} {
		if _, err := NewPredictiveCodec(id); err != nil {
			t.Errorf("profile %d should be implemented: %v", id, err)
		}
	}
}

// A payload coded with one profile must not be decoded by a codec built for
// another.
func TestPredictiveProfileMismatchRejected(t *testing.T) {
	enc, err := NewPredictiveCodec(PredProfileAudio)
	if err != nil {
		t.Fatal(err)
	}
	pkt := make([]int16, 480)
	for i := range pkt {
		pkt[i] = int16(i % 1000)
	}
	payload, err := enc.Encode(pkt)
	if err != nil {
		t.Fatal(err)
	}
	dec, err := NewPredictiveCodec(PredProfileIQ)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dec.Decode(payload, len(pkt)); err == nil {
		t.Fatal("expected a profile mismatch error")
	}
}

// Malformed payloads must return an error, never panic: they arrive from the
// network on the client side.
func TestPredictiveRejectsMalformed(t *testing.T) {
	dec, err := NewPredictiveCodec(PredProfileAudio)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		payload []byte
		count   int
	}{
		{"empty", []byte{}, 480},
		{"flags only", []byte{PredProfileAudio}, 480},
		{"truncated bitstream", []byte{PredProfileAudio, 4, 0x01}, 480},
		{"truncated escape", append([]byte{predEscapeFlag | PredProfileAudio}, 1, 2, 3), 480},
		{"zero count", []byte{PredProfileAudio, 0}, 0},
		{"invalid k", []byte{PredProfileAudio, 99, 0, 0}, 8},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := dec.Decode(tc.payload, tc.count); err == nil {
				t.Errorf("expected an error for %s", tc.name)
			}
		})
	}
}

// Encoding a packet whose length is not a whole number of frames is a caller
// bug and must be reported, not silently truncated.
func TestPredictiveRejectsOddIQPacket(t *testing.T) {
	enc, err := NewPredictiveCodec(PredProfileIQ)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enc.Encode(make([]int16, 15)); err == nil {
		t.Fatal("expected an error for an odd sample count on a complex profile")
	}
	if _, err := enc.Encode(nil); err == nil {
		t.Fatal("expected an error for an empty packet")
	}
}

// Taps must stay well inside the clamp on realistic input; if they ever sat at
// the limit the filter would have stopped adapting.
func TestPredictiveTapsStayBounded(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	enc, err := NewPredictiveCodec(PredProfileIQ)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkt := range synthIQ(rng, 500, 720) {
		if _, err := enc.Encode(pkt); err != nil {
			t.Fatal(err)
		}
	}
	var worst int64
	for _, st := range enc.cx {
		for i := range st.wr {
			for _, w := range []int64{st.wr[i], st.wi[i]} {
				if w < 0 {
					w = -w
				}
				if w > worst {
					worst = w
				}
			}
		}
	}
	t.Logf("largest tap magnitude %.2f (clamp at %d)", float64(worst)/(1<<predTapShift), predTapLimit>>predTapShift)
	if worst >= predTapLimit {
		t.Errorf("taps reached the clamp: %d", worst)
	}
}

func BenchmarkPredictiveEncodeIQ(b *testing.B) {
	rng := rand.New(rand.NewSource(8))
	pkts := synthIQ(rng, 64, 720)
	enc, _ := NewPredictiveCodec(PredProfileIQ)
	b.SetBytes(int64(len(pkts[0]) * 2))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := enc.Encode(pkts[i%len(pkts)]); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPredictiveEncodeAudio(b *testing.B) {
	rng := rand.New(rand.NewSource(9))
	pkts := synthAudio(rng, 64, 480)
	enc, _ := NewPredictiveCodec(PredProfileAudio)
	b.SetBytes(int64(len(pkts[0]) * 2))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := enc.Encode(pkts[i%len(pkts)]); err != nil {
			b.Fatal(err)
		}
	}
}
