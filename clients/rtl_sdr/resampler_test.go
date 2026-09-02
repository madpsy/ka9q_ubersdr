package main

import (
	"math"
	"testing"
)

// The resampler is what decides whether iq384 is usable. From iq192 nearly every
// rtl_tcp request was upsampling, where there is nothing to alias; from iq384 the
// common requests -- 225, 250, 300 kHz -- are decimation, and a filter that does
// not stop the band above the new Nyquist folds it back into the middle of what
// the operator is looking at.
//
// These measure the filter rather than trusting it: a complex tone is fed in at a
// known input frequency and the amplitude that survives is compared with DC. The
// FIR is the whole signal path, so this is the response as heard.

// resamplerResponse returns the gain in dB at freqHz, measured by pushing a
// complex exponential through a resampler built for the given rates.
func resamplerResponse(t *testing.T, inRate, outRate uint32, freqHz float64) float64 {
	t.Helper()
	r := NewIQResampler(inRate, outRate)

	// Long enough for the filter history to fill and the measurement to settle.
	const inSamples = 32768
	in := make([]byte, inSamples*2)
	for k := 0; k < inSamples; k++ {
		ph := 2 * math.Pi * freqHz * float64(k) / float64(inRate)
		// 100 counts of amplitude: well inside the uint8 range either side of
		// 127, so nothing clips and the quantisation floor stays ~-48 dB.
		in[k*2] = byte(127 + int(math.Round(100*math.Cos(ph))))
		in[k*2+1] = byte(127 + int(math.Round(100*math.Sin(ph))))
	}

	out := r.Resample(in)
	n := len(out) / 2
	if n < 1024 {
		t.Fatalf("%d Hz -> %d Hz produced only %d output samples", inRate, outRate, n)
	}

	// Discard the first samples: the history buffer starts empty, so the leading
	// output is a filter transient rather than the steady-state response.
	skip := 512
	var sumsq float64
	for k := skip; k < n; k++ {
		i := float64(out[k*2]) - 127
		q := float64(out[k*2+1]) - 127
		sumsq += i*i + q*q
	}
	rms := math.Sqrt(sumsq / float64(n-skip))
	// 100 counts peak on each of I and Q is an RMS magnitude of 100 for a
	// complex exponential, so that is 0 dB.
	return 20 * math.Log10(rms/100)
}

// Anything above the output Nyquist must be gone, not folded down into the
// passband. This is the case iq384 newly created and the reason sincTapsDown
// exists.
func TestResamplerRejectsAboveOutputNyquist(t *testing.T) {
	const in = IQModeRate // 384000
	for _, out := range []uint32{225000, 250000, 300000} {
		nyq := float64(out) / 2
		for _, mult := range []float64{1.0, 1.2, 1.5} {
			f := nyq * mult
			if f >= float64(in)/2 {
				continue // beyond what the input can carry at all
			}
			got := resamplerResponse(t, in, out, f)
			// -40 dB is a decade below the passband in amplitude and far below
			// anything an operator would mistake for a signal. The design
			// measures 83 dB or better at the fold; the margin here is for the
			// uint8 quantisation floor the test itself introduces.
			if got > -40 {
				t.Errorf("%d -> %d Hz: %.0f kHz (%.1f x Nyquist) survives at %.1f dB, want <= -40 dB",
					in, out, f/1000, mult, got)
			}
		}
	}
}

// The passband has to stay flat, or the fix for aliasing has cost the operator
// the bandwidth it was meant to preserve. From iq192 this bridge delivered
// ±96 kHz; from iq384 at 250 kHz out it must do at least as well.
func TestResamplerPassbandIsFlat(t *testing.T) {
	const in = IQModeRate
	for _, tc := range []struct {
		out  uint32
		upTo float64 // Hz that must stay within 1 dB
	}{
		{225000, 80000},
		{250000, 96000}, // at least what iq192 used to give
		{300000, 115000},
	} {
		for _, f := range []float64{0, tc.upTo / 2, tc.upTo} {
			got := resamplerResponse(t, in, tc.out, f)
			if got < -1.0 || got > 0.5 {
				t.Errorf("%d -> %d Hz: %.0f kHz is %.2f dB, want flat within 1 dB",
					in, tc.out, f/1000, got)
			}
		}
	}
}

// Upsampling is untouched by the change and must stay so: it has nothing to
// alias, and paying for the long kernel at 2.4 Msps would be real CPU for
// nothing.
func TestResamplerUpsamplingKeepsTheShortKernel(t *testing.T) {
	up := NewIQResampler(IQModeRate, 2400000)
	if up.taps != sincTapsUp {
		t.Errorf("upsampling uses %d taps, want %d", up.taps, sincTapsUp)
	}
	down := NewIQResampler(IQModeRate, 250000)
	if down.taps != sincTapsDown {
		t.Errorf("decimating uses %d taps, want %d", down.taps, sincTapsDown)
	}
	if got := resamplerResponse(t, IQModeRate, 2400000, 100000); got < -1.0 || got > 0.5 {
		t.Errorf("upsampled 100 kHz is %.2f dB, want flat", got)
	}
}
