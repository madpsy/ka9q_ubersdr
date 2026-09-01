package main

// Wire-identity guard for the version 4 predictive codec.
//
// The codec in pcm_predictive.go is optimised for CPU; this drives it and the
// frozen pre-optimisation copy in pcm_predictive_ref_test.go in lockstep over
// every real capture and a set of adversarial synthetic streams, requiring
// byte-identical payloads on every packet. If an optimisation ever changes a
// single wire byte, this fails and names the packet.

import (
	"bytes"
	"math/rand"
	"testing"
)

// lockstep encodes the same packet sequence through both codecs and fails on
// the first byte of disagreement.
func lockstep(t *testing.T, label string, profileID byte, packets [][]int16) {
	t.Helper()
	opt, err := NewPredictiveCodec(profileID)
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	ref, err := refNewPredictiveCodec(profileID)
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	for i, pkt := range packets {
		if len(pkt) == 0 {
			continue
		}
		a, err := ref.Encode(pkt)
		if err != nil {
			t.Fatalf("%s packet %d: reference: %v", label, i, err)
		}
		b, err := opt.Encode(pkt)
		if err != nil {
			t.Fatalf("%s packet %d: optimised: %v", label, i, err)
		}
		if !bytes.Equal(a, b) {
			t.Fatalf("%s packet %d: payload differs (ref %d bytes, opt %d bytes)", label, i, len(a), len(b))
		}
	}
}

// TestPredictiveWireIdenticalOnCaptures is the strongest evidence available:
// every packet a live receiver actually sent must code to the same bytes.
func TestPredictiveWireIdenticalOnCaptures(t *testing.T) {
	for _, c := range predictiveCaptures {
		pkts := loadTestCapture(t, c.file)
		var samples [][]int16
		for _, p := range pkts {
			samples = append(samples, captureSamples(t, p))
		}
		lockstep(t, c.file, c.profile, samples)
	}
}

// TestPredictiveWireIdenticalOnSynthetic covers shapes the captures do not:
// silence runs (the zero-sign adapt skip), full-scale clipping, incompressible
// noise (the escape path), and hard transitions between all of them.
func TestPredictiveWireIdenticalOnSynthetic(t *testing.T) {
	rng := rand.New(rand.NewSource(9))

	iq := synthIQ(rng, 200, 720)
	audio := synthAudio(rng, 200, 240)

	// Interleave silence, signal, noise and clipping in blocks.
	adversarial := func(n int, step int) [][]int16 {
		var out [][]int16
		for b := 0; b < 40; b++ {
			pkt := make([]int16, n)
			switch b % 5 {
			case 0: // silence
			case 1: // full-scale square wave, clamps the input range
				for i := range pkt {
					if (i/7)%2 == 0 {
						pkt[i] = 32767
					} else {
						pkt[i] = -32768
					}
				}
			case 2: // white noise, should escape
				for i := range pkt {
					pkt[i] = int16(rng.Intn(65536) - 32768)
				}
			case 3: // pure tone
				for i := range pkt {
					pkt[i] = int16(20000 * ((i % 12) - 6) / 6)
				}
			case 4: // near-silence, exercises tiny residuals
				for i := range pkt {
					pkt[i] = int16(rng.Intn(3) - 1)
				}
			}
			out = append(out, pkt)
		}
		return out
	}

	lockstep(t, "synthetic IQ", PredProfileIQ, iq)
	lockstep(t, "synthetic audio", PredProfileAudio, audio)
	lockstep(t, "adversarial IQ", PredProfileIQ, adversarial(720, 2))
	lockstep(t, "adversarial audio", PredProfileAudio, adversarial(240, 1))
}

// TestPredictiveWireIdenticalNearTapLimit forces the clamp to actually fire.
// Normal adaptation never gets taps anywhere near predTapLimit, so the fast
// unclamped adapt path is what runs in practice; this preloads taps at and
// beyond the safety threshold to prove the clamped fallback still matches the
// reference exactly.
func TestPredictiveWireIdenticalNearTapLimit(t *testing.T) {
	rng := rand.New(rand.NewSource(17))

	opt, _ := NewPredictiveCodec(PredProfileAudio)
	ref, _ := refNewPredictiveCodec(PredProfileAudio)

	// Push taps of the first stage to the limit on both sides. The optimised
	// stage stores its taps oldest-first, so preload symmetrically (all taps
	// equal), which is representation-independent.
	for j := range opt.rl[0].w {
		opt.rl[0].w[j] = predTapLimit
		ref.rl[0].w[j] = refPredTapLimit
	}
	for j := range opt.rl[1].w {
		opt.rl[1].w[j] = -predTapLimit + 3
		ref.rl[1].w[j] = -refPredTapLimit + 3
	}

	pkts := synthAudio(rng, 50, 240)
	for i, pkt := range pkts {
		a, err := ref.Encode(pkt)
		if err != nil {
			t.Fatalf("packet %d: reference: %v", i, err)
		}
		b, err := opt.Encode(pkt)
		if err != nil {
			t.Fatalf("packet %d: optimised: %v", i, err)
		}
		if !bytes.Equal(a, b) {
			t.Fatalf("packet %d: payload differs with taps at the limit", i)
		}
	}

	// Same for the complex profile.
	optC, _ := NewPredictiveCodec(PredProfileIQ)
	refC, _ := refNewPredictiveCodec(PredProfileIQ)
	for j := range optC.cx[0].wr {
		optC.cx[0].wr[j] = predTapLimit - 1
		optC.cx[0].wi[j] = -predTapLimit
		refC.cx[0].wr[j] = refPredTapLimit - 1
		refC.cx[0].wi[j] = -refPredTapLimit
	}
	iq := synthIQ(rng, 50, 720)
	for i, pkt := range iq {
		a, err := refC.Encode(pkt)
		if err != nil {
			t.Fatalf("iq packet %d: reference: %v", i, err)
		}
		b, err := optC.Encode(pkt)
		if err != nil {
			t.Fatalf("iq packet %d: optimised: %v", i, err)
		}
		if !bytes.Equal(a, b) {
			t.Fatalf("iq packet %d: payload differs with taps at the limit", i)
		}
	}
}

// TestPredictiveAdvanceSilenceMatchesEncode proves the advance-only silent
// path leaves the filters in exactly the state a discarded Encode over zeros
// would have: after the silence, both codecs must produce identical bytes for
// the same signal.
func TestPredictiveAdvanceSilenceMatchesEncode(t *testing.T) {
	for _, profile := range []byte{PredProfileIQ, PredProfileAudio} {
		rng := rand.New(rand.NewSource(23))
		n := 240
		if profile == PredProfileIQ {
			n = 720
		}
		gen := synthAudio
		if profile == PredProfileIQ {
			gen = synthIQ
		}

		viaEncode, _ := NewPredictiveCodec(profile)
		viaAdvance, _ := NewPredictiveCodec(profile)
		zeros := make([]int16, n)

		pkts := gen(rng, 30, n)
		for i, pkt := range pkts {
			// Signal, then silence, alternating -- transitions are where the
			// two paths could drift.
			if _, err := viaEncode.Encode(pkt); err != nil {
				t.Fatalf("profile %d packet %d: %v", profile, i, err)
			}
			if _, err := viaAdvance.Encode(pkt); err != nil {
				t.Fatalf("profile %d packet %d: %v", profile, i, err)
			}
			if _, err := viaEncode.Encode(zeros); err != nil {
				t.Fatalf("profile %d packet %d zeros: %v", profile, i, err)
			}
			if err := viaAdvance.AdvanceSilence(n); err != nil {
				t.Fatalf("profile %d packet %d advance: %v", profile, i, err)
			}
			a, err := viaEncode.Encode(pkt)
			if err != nil {
				t.Fatalf("profile %d packet %d check: %v", profile, i, err)
			}
			aCopy := append([]byte(nil), a...)
			b, err := viaAdvance.Encode(pkt)
			if err != nil {
				t.Fatalf("profile %d packet %d check: %v", profile, i, err)
			}
			if !bytes.Equal(aCopy, b) {
				t.Fatalf("profile %d packet %d: state diverged after silence", profile, i)
			}
		}
	}
}

// ── benchmarks: optimised against the frozen reference ───────────────────────

func benchLockstepPackets(profile byte, n int) [][]int16 {
	rng := rand.New(rand.NewSource(42))
	if profile == PredProfileIQ {
		return synthIQ(rng, 64, n)
	}
	return synthAudio(rng, 64, n)
}

func BenchmarkPredictiveRefEncodeIQ(b *testing.B) {
	pkts := benchLockstepPackets(PredProfileIQ, 720)
	c, _ := refNewPredictiveCodec(PredProfileIQ)
	b.SetBytes(720 * 2)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := c.Encode(pkts[i%64]); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPredictiveRefEncodeAudio(b *testing.B) {
	pkts := benchLockstepPackets(PredProfileAudio, 960)
	c, _ := refNewPredictiveCodec(PredProfileAudio)
	b.SetBytes(960 * 2)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := c.Encode(pkts[i%64]); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkPredictiveSilent* measure the squelched-session path: the reference
// pays a full Encode over zeros whose output is discarded, the optimised path
// advances the filters without coding.
func BenchmarkPredictiveSilentRef(b *testing.B) {
	zeros := make([]int16, 240)
	c, _ := refNewPredictiveCodec(refPredProfileAudio)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := c.Encode(zeros); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPredictiveSilentAdvance(b *testing.B) {
	c, _ := NewPredictiveCodec(PredProfileAudio)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := c.AdvanceSilence(240); err != nil {
			b.Fatal(err)
		}
	}
}
