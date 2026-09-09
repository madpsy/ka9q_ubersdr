package main

import (
	"math"
	"testing"
)

// The rates the audio modes actually produce, and the factors they imply.
// 12 kHz is the sideband and CW channel, 24 kHz the AM and FM one.
func TestUpsamplerRatesAndLengths(t *testing.T) {
	for _, tc := range []struct {
		rate int
		l, m int
	}{
		// The audio channels, interpolated.
		{12000, 4, 1}, {24000, 2, 1}, {48000, 1, 1},
		// The IQ channels. iq is 12 kHz like the sideband modes; the wide ones
		// run above the output rate and are decimated.
		{96000, 1, 2}, {192000, 1, 4}, {384000, 1, 8},
	} {
		u := newUpsampler(tc.rate, opusOutputRate)
		if u.l != tc.l || u.m != tc.m {
			t.Errorf("%d Hz: ratio %d/%d, want %d/%d", tc.rate, u.l, u.m, tc.l, tc.m)
		}
		// A 20 ms packet, the interval the server sends at.
		in := make([]int16, tc.rate/50)
		if got, want := len(u.process(in)), opusOutputRate/50; got != want {
			t.Errorf("%d Hz: %d output samples for a 20 ms packet, want %d", tc.rate, got, want)
		}
	}
}

// Unity gain at DC, on every phase. Each output phase is normalised to sum to
// one for exactly this: a phase whose taps summed to anything else would put a
// buzz at the interpolation frequency onto a constant input, which is the one
// artefact of this arrangement that would be plainly audible.
func TestUpsamplerPreservesConstant(t *testing.T) {
	const level = 8000
	u := newUpsampler(12000, opusOutputRate)
	in := make([]int16, 1200)
	for i := range in {
		in[i] = level
	}
	out := u.process(in)

	// Skip the filter's settling, which starts from a zeroed history.
	for i := 400; i < len(out); i++ {
		if d := int(out[i]) - level; d > 1 || d < -1 {
			t.Fatalf("constant %d came back as %d at sample %d", level, out[i], i)
		}
	}
}

// A tone in the passband must come through at its own amplitude, and the
// images the interpolation creates around the source rate must not.
func TestUpsamplerPassesToneAndRejectsImages(t *testing.T) {
	const (
		srcRate = 12000
		toneHz  = 1000
		amp     = 10000
	)
	u := newUpsampler(srcRate, opusOutputRate)
	in := make([]int16, srcRate) // one second
	for i := range in {
		in[i] = int16(amp * math.Sin(2*math.Pi*toneHz*float64(i)/srcRate))
	}
	// Drop the settling transient before measuring.
	out := u.process(in)[480:]

	fundamental := goertzel(out, toneHz, opusOutputRate)
	if fundamental < 0.95*amp || fundamental > 1.05*amp {
		t.Fatalf("tone came back at amplitude %.0f, want about %d", fundamental, amp)
	}

	// Zero-stuffing puts a copy of the signal around every multiple of the
	// source rate. These are the nearest two, and the low-pass exists to remove
	// them: leaving them in is what makes cheap upsampling sound harsh.
	for _, image := range []float64{srcRate - toneHz, srcRate + toneHz} {
		if m := goertzel(out, image, opusOutputRate); m > 0.01*fundamental {
			t.Errorf("image at %.0f Hz is %.1f dB below the tone, want at least 40",
				image, 20*math.Log10(fundamental/m))
		}
	}
}

// Decimation is the direction the IQ modes need, and the one where getting the
// filter wrong is silent rather than obvious: a tone above the output Nyquist
// does not disappear when samples are thrown away, it FOLDS to a different
// frequency and appears as a signal that was never on the band.
func TestUpsamplerRejectsWhatItCannotCarry(t *testing.T) {
	const (
		srcRate = 384000 // iq384, the widest the server offers
		amp     = 10000
	)
	// 100 kHz is well above the 24 kHz the output can represent. Decimating by
	// eight without a filter would fold it to 100000 - 2*48000 = 4 kHz.
	const toneHz = 100000

	u := newUpsampler(srcRate, opusOutputRate)
	in := make([]int16, srcRate/10)
	for i := range in {
		in[i] = int16(amp * math.Sin(2*math.Pi*toneHz*float64(i)/srcRate))
	}
	out := u.process(in)[960:]

	if m := goertzel(out, 4000, opusOutputRate); m > 0.01*amp {
		t.Errorf("a %d kHz tone folded back to 4 kHz at amplitude %.0f, %.1f dB down; want at least 40",
			toneHz/1000, m, 20*math.Log10(amp/m))
	}

	// And what the output CAN carry must survive the same conversion, or the
	// filter is simply removing everything.
	for i := range in {
		in[i] = int16(amp * math.Sin(2*math.Pi*5000*float64(i)/srcRate))
	}
	u = newUpsampler(srcRate, opusOutputRate)
	out = u.process(in)[960:]
	if m := goertzel(out, 5000, opusOutputRate); m < 0.95*amp || m > 1.05*amp {
		t.Errorf("a 5 kHz tone came through decimation at amplitude %.0f, want about %d", m, amp)
	}
}

// The converter carries its filter history across packets, so splitting a
// stream into packets must not change a single output sample. Without that
// carry, every packet boundary is a discontinuity — 50 clicks a second.
func TestUpsamplerIsContinuousAcrossPackets(t *testing.T) {
	const srcRate = 12000
	in := make([]int16, 2400)
	for i := range in {
		in[i] = int16(9000 * math.Sin(2*math.Pi*700*float64(i)/srcRate))
	}

	whole := newUpsampler(srcRate, opusOutputRate).process(in)

	blocked := make([]int16, 0, len(whole))
	u := newUpsampler(srcRate, opusOutputRate)
	for off := 0; off < len(in); off += 240 {
		blocked = append(blocked, u.process(in[off:off+240])...)
	}

	if len(blocked) != len(whole) {
		t.Fatalf("packetised run produced %d samples, one call produced %d", len(blocked), len(whole))
	}
	for i := range whole {
		if blocked[i] != whole[i] {
			t.Fatalf("sample %d differs: packetised %d, whole %d", i, blocked[i], whole[i])
		}
	}
}

// matches is what decides whether a mode change rebuilds the converter. A rate
// that has not moved must keep the one it has, or its history is thrown away
// fifty times a second and the carry above is worthless.
func TestUpsamplerMatches(t *testing.T) {
	var none *upsampler
	if none.matches(12000) {
		t.Error("a nil converter matched a rate")
	}
	u := newUpsampler(12000, opusOutputRate)
	if !u.matches(12000) {
		t.Error("converter did not match the rate it was built for")
	}
	if u.matches(24000) {
		t.Error("converter matched a rate it was not built for")
	}
}

// The fallback for a ratio that is not an integer. No mode this client offers
// produces one, so this only has to play at the right speed.
func TestUpsamplerFractionalRateKeepsSpeed(t *testing.T) {
	const srcRate = 11025
	u := newUpsampler(srcRate, opusOutputRate)
	if u.l != 0 {
		t.Fatalf("ratio %d/%d for a rate the bank cannot express, want the fractional path", u.l, u.m)
	}

	// A second of audio, packetised, must come out as a second of audio — give
	// or take the filter's own start-up, which is a handful of samples.
	total := 0
	for i := 0; i < 5; i++ {
		total += len(u.process(make([]int16, srcRate/5)))
	}
	if total < opusOutputRate-20 || total > opusOutputRate+20 {
		t.Errorf("a second of %d Hz audio came out as %d samples, want about %d",
			srcRate, total, opusOutputRate)
	}
}

// goertzel returns the amplitude of one frequency in a real signal.
func goertzel(x []int16, freq, rate float64) float64 {
	w := 2 * math.Pi * freq / rate
	coeff := 2 * math.Cos(w)
	var s1, s2 float64
	for _, v := range x {
		s := float64(v) + coeff*s1 - s2
		s2, s1 = s1, s
	}
	re := s1 - s2*math.Cos(w)
	im := s2 * math.Sin(w)
	return 2 * math.Hypot(re, im) / float64(len(x))
}
