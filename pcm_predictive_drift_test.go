package main

import (
	"testing"
)

// Long-run stability of the adaptive filters.
//
// Every capture in testdata/pcm_predictive is about half a second long, which
// is what let the divergence documented at predLeakShift ship: measured on a
// 909 kHz iq384 stream the coding cost was still improving at five seconds and
// only began to climb after that, reaching worse-than-uncompressed at ninety.
// Nothing that runs half a second of signal can see it.
//
// These tests therefore replay a capture until enough SAMPLES have gone
// through the filters to matter, which is the axis the drift actually lives
// on -- a 384 kHz IQ stream reaches it in ninety seconds and a 12 kHz audio
// channel takes three quarters of an hour, but the taps do the same thing.

// TestPredictiveTapsDoNotDrift replays a capture whose band is a handful of
// strong carriers over a quiet floor, which is the shape that leaves most of
// the filter's directions unexcited and so free to walk.
//
// It asserts on both ends of the mechanism. The taps are the cause and are
// checked first, because they diverge visibly long before the bitrate does and
// a failure there says plainly what went wrong. The coding cost is the effect
// and is what a client actually feels.
func TestPredictiveTapsDoNotDrift(t *testing.T) {
	cases := []struct {
		file    string
		profile byte
		// samples is how many must pass through the filters. It is stated in
		// samples rather than seconds because that is the axis the drift lives
		// on: 23 million is thirty seconds of 384 kHz IQ, by which point the
		// unleaked codec had gone from 10.65 bits per sample to 14.26 on the
		// medium-wave capture, and forty minutes of a 12 kHz channel, which is
		// what the far slower audio cascade needs to show the same thing.
		samples int
		// maxTap is the largest |tap| tolerated, as a real-valued magnitude.
		// The leaked filters settle under 2 on all three captures, where the
		// unleaked ones reach 256 on the IQ captures and 5.33 on the audio one.
		maxTap float64
	}{
		{"iq384-mw-carriers.bin", PredProfileIQ, 23_000_000, 4},
		{"iq384-ft8-14074.bin", PredProfileIQ, 23_000_000, 4},
		{"usb-ft8-14074.bin", PredProfileAudio, 29_000_000, 4},
	}

	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			if testing.Short() {
				t.Skip("replays tens of millions of samples")
			}
			packets := loadTestCapture(t, c.file)
			samples := make([][]int16, len(packets))
			var perPass int
			for i, pkt := range packets {
				samples[i] = captureSamples(t, pkt)
				perPass += len(samples[i])
			}

			enc, err := NewPredictiveCodec(c.profile)
			if err != nil {
				t.Fatal(err)
			}
			dec, err := NewPredictiveCodec(c.profile)
			if err != nil {
				t.Fatal(err)
			}

			// One pass over the capture is the reference: the cost a client
			// sees in its first moments, before anything has had time to
			// drift. Every later pass is the same signal, so the codec has no
			// excuse to do worse.
			var firstRaw, firstCoded int64
			var lastRaw, lastCoded int64

			var total int
			for pass := 0; total < c.samples; pass++ {
				var raw, coded int64
				for n, s := range samples {
					raw += int64(len(s) * 2)
					payload, err := enc.Encode(s)
					if err != nil {
						t.Fatalf("pass %d packet %d: encode: %v", pass, n, err)
					}
					coded += int64(len(payload))
					// Decoding alongside is not incidental: the decoder mirrors
					// the leak, and a port that leaks on one side only would
					// stay in step for a few packets and then diverge.
					got, err := dec.Decode(payload, len(s))
					if err != nil {
						t.Fatalf("pass %d packet %d: decode: %v", pass, n, err)
					}
					for i := range s {
						if got[i] != s[i] {
							t.Fatalf("pass %d packet %d sample %d: got %d, want %d — not lossless",
								pass, n, i, got[i], s[i])
						}
					}
				}
				if pass == 0 {
					firstRaw, firstCoded = raw, coded
				}
				lastRaw, lastCoded = raw, coded
				total += perPass
			}

			maxTap := predMaxTap(enc)
			t.Logf("%d samples: max |tap| %.3f, %.3fx -> %.3fx payload ratio",
				total, maxTap,
				float64(firstRaw)/float64(firstCoded),
				float64(lastRaw)/float64(lastCoded))

			if maxTap > c.maxTap {
				t.Errorf("taps drifted to %.3f after %d samples, limit is %.3f — "+
					"the filter is walking rather than tracking; see predLeakShiftComplex",
					maxTap, total, c.maxTap)
			}

			// A 2% band, not equality: the capture is looped, so each pass
			// starts on a discontinuity the first pass did not have, and the
			// filters are legitimately in a different place each time round.
			first := float64(firstRaw) / float64(firstCoded)
			last := float64(lastRaw) / float64(lastCoded)
			if last < first*0.98 {
				t.Errorf("compression decayed from %.3fx to %.3fx over %d samples "+
					"of the same signal", first, last, total)
			}
		})
	}
}

// predMaxTap is the largest |tap| in a codec, as a real-valued magnitude.
func predMaxTap(c *PredictiveCodec) float64 {
	var maxAbs int64
	note := func(ws ...[]int64) {
		for _, w := range ws {
			for _, v := range w {
				if v < 0 {
					v = -v
				}
				if v > maxAbs {
					maxAbs = v
				}
			}
		}
	}
	for _, s := range c.cx {
		note(s.wr, s.wi)
	}
	for _, s := range c.rl {
		note(s.w)
	}
	return float64(maxAbs) / (1 << predTapShift)
}

// TestPredictiveLeakIsSignSymmetric pins the property the ports have to
// reproduce. A C or C++ decoder writing `w >> shift` gets an
// arithmetic shift, which rounds towards negative infinity: for a small
// negative tap that leaks -1 rather than 0, so the taps drift positive and the
// two ends part company within a packet. JavaScript has neither int64 nor an
// arithmetic shift past 32 bits and has to truncate explicitly.
func TestPredictiveLeakIsSignSymmetric(t *testing.T) {
	for _, shift := range []uint{predLeakShiftComplex, predLeakShiftReal} {
		for _, w := range []int64{0, 1, 1 << 13, (1 << shift) - 1, 1 << shift, 3 << shift, 1 << 24} {
			if got, want := predLeak(-w, shift), -predLeak(w, shift); got != want {
				t.Errorf("predLeak(%d, %d) = %d, want %d — leak is not sign-symmetric",
					-w, shift, got, want)
			}
		}
		// Truncation towards zero: nothing under 2^shift leaks at all.
		for _, w := range []int64{0, 1, (1 << shift) - 1} {
			if got := predLeak(w, shift); got != 0 {
				t.Errorf("predLeak(%d, %d) = %d, want 0 — small taps must not be dragged to zero",
					w, shift, got)
			}
		}
		if got, want := predLeak(3<<shift, shift), int64(3); got != want {
			t.Errorf("predLeak(3<<%d, %d) = %d, want %d", shift, shift, got, want)
		}
	}
}
