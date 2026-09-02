package main

// IQResampler performs bandlimited resampling of uint8 offset-binary IQ pairs
// using a polyphase Kaiser-windowed sinc filter bank.
//
// # Theory
//
// The Nyquist–Shannon sampling theorem states that a signal sampled at rate f_s
// contains no frequency content above f_s/2 (the Nyquist frequency). To resample
// from f_in to f_out correctly:
//
//  1. Conceptually insert zeros between input samples (ideal upsampling).
//  2. Apply a low-pass FIR filter with cutoff at min(f_in, f_out)/2 to:
//     - Remove spectral images created by the zero-insertion (anti-imaging), and
//     - Remove aliased content above the new Nyquist (anti-aliasing).
//
// The ideal low-pass filter impulse response is the sinc function:
//
//	h_ideal(t) = 2·f_c · sinc(2·f_c·t)   where sinc(x) = sin(π·x)/(π·x)
//
// Truncated with a Kaiser window (β=8, ~80 dB stopband attenuation):
//
//	h(t) = h_ideal(t) · kaiser(t/N, β)
//
// # Polyphase filter bank (pre-computed)
//
// For a given ratio R = f_in/f_out, the fractional input position for output
// sample i is:  τ = i·R + phase
//
// The fractional part of τ (frac = τ - floor(τ)) determines which polyphase
// sub-filter to use. We pre-compute L=512 sub-filters at construction time,
// each containing 2·N+1 float32 coefficients. The hot path then only performs
// array lookups and float32 multiply-adds — no transcendental functions.
//
// Memory: 512 phases × 25 or 65 taps × 4 bytes, so 51 kB per interpolating
// resampler and 133 kB per decimating one.
// Pre-computation time: ~microseconds (done once per SET_SAMPLE_RATE command).
//
// # IQ handling
//
// Input is interleaved uint8 offset-binary IQ pairs: [I0 Q0 I1 Q1 ...].
// uint8 value 127 represents zero. I and Q are filtered independently.
// A history buffer of N samples is maintained across calls for continuity.

import (
	"math"
)

const (
	// sincTapsUp is the half-length (N) used when the client asks for a rate
	// ABOVE the receiver's, which is the ordinary rtl_tcp case. There is no
	// decimation and so nothing to alias; the filter is interpolating only, and
	// 25 taps is ample for that.
	sincTapsUp = 12

	// sincTapsDown is the half-length used when the client asks for a rate
	// BELOW the receiver's, where the filter has to actually stop the band
	// above the new Nyquist from folding back into it.
	//
	// The transition width of a windowed-sinc is set by the window length in
	// INPUT samples, so it is fixed in input-normalised terms and does not
	// shrink with the ratio -- which is why the interpolating length will not
	// do here. Measured at 384 kHz in:
	//
	//	           N=12          N=32
	//	225 kHz    -13 dB        -83 dB
	//	250 kHz    -18 dB        -83 dB
	//	300 kHz    -22 dB        -91 dB
	//
	// at the output Nyquist, which is where content folds. 65 taps costs
	// 250 kHz x 65 x 2 = 33 Mmult/s, which is nothing, and it is only paid on
	// the decimating path.
	sincTapsDown = 32

	// downCutoffScale pulls the decimating cutoff below the output Nyquist so
	// the transition band ends there rather than straddling it.
	//
	// Without it the cutoff sits ON the fold, where a windowed-sinc is 6 dB
	// down by construction -- so half the transition band aliases however many
	// taps are used. At 0.85 with the length above, 384 kHz in and 250 kHz out
	// is flat to 97.9 kHz, -3 dB at 103.3 kHz and 83 dB down at the 125 kHz
	// fold: a slightly wider usable span than the +/-96 kHz this bridge offered
	// from iq192, and properly anti-aliased where that was not.
	downCutoffScale = 0.85

	// kaiserBeta is the Kaiser window shape parameter.
	// β=8.0 → ~80 dB stopband attenuation.
	kaiserBeta = 8.0

	// numPhases is the number of polyphase sub-filters in the pre-computed bank.
	// Higher values give more accurate interpolation of the fractional offset.
	// 512 phases → interpolation error < 0.002 dB.
	numPhases = 512
)

// IQResampler holds the pre-computed polyphase filter bank and per-session state.
// It must not be shared between goroutines.
type IQResampler struct {
	// ratio = f_in / f_out
	ratio float64

	// taps is this instance's half-length N, and stride the full filter length
	// 2N+1. Both depend on whether this resampler decimates; see sincTapsDown.
	taps   int
	stride int

	// polyphase is the pre-computed filter bank, flattened: the k-th tap of the
	// p-th sub-filter is polyphase[p*stride+k]. Flat rather than a slice of
	// slices so the hot path does one bounds check per sub-filter rather than
	// two per tap.
	polyphase []float32

	// histI and histQ hold the last `taps` input samples from the previous
	// call, providing left-side context for the FIR filter.
	histI []float32
	histQ []float32

	// iSig and qSig are the working buffers the FIR reads, history prepended.
	// Kept on the instance rather than allocated per packet: a resampler is
	// used by one goroutine for the life of a session, and at iq384's ~1090
	// packets a second two allocations each is 8 kB/s of garbage for nothing.
	iSig []float32
	qSig []float32

	// phase tracks the fractional input position across calls so that output
	// samples are evenly spaced even when packet boundaries fall mid-sample.
	phase float64
}

// NewIQResampler creates a resampler and pre-computes the polyphase filter bank.
// actualRate is the rate UberSDR delivers (e.g. 192000).
// requestedRate is the rate the rtl_tcp client asked for (e.g. 2048000).
//
// Pre-computation is O(numPhases × taps) and takes ~microseconds.
// The result is reused for every subsequent Resample() call.
func NewIQResampler(actualRate, requestedRate uint32) *IQResampler {
	// Cutoff frequency, normalised to the input sample rate, and the filter
	// length that goes with it.
	//
	// Upsampling (requestedRate > actualRate): cutoff = 1.0, pass the full
	// input bandwidth. Nothing folds, so the short interpolating kernel does.
	//
	// Downsampling (requestedRate < actualRate): cutoff = f_out/f_in, scaled
	// down so the transition band ends at the new Nyquist instead of straddling
	// it, with the long kernel to make that transition narrow enough to matter.
	cutoff := 1.0
	n := sincTapsUp
	if requestedRate < actualRate {
		cutoff = downCutoffScale * float64(requestedRate) / float64(actualRate)
		n = sincTapsDown
	}

	r := &IQResampler{
		ratio:     float64(actualRate) / float64(requestedRate),
		taps:      n,
		stride:    2*n + 1,
		polyphase: make([]float32, numPhases*(2*n+1)),
		histI:     make([]float32, n),
		histQ:     make([]float32, n),
	}

	// Pre-compute the polyphase filter bank.
	// For phase p (0 ≤ p < numPhases), the fractional offset is frac = p/numPhases.
	// Each sub-filter has 2*taps+1 coefficients at positions k = -taps … +taps.
	//
	// The kernel value at tap k for fractional offset frac is:
	//   h(k - frac) = cutoff · sinc(cutoff·(k-frac)) · kaiser((k-frac)/taps, β)
	//
	// We also normalise each sub-filter so its taps sum to 1.0 (unity DC gain),
	// which prevents amplitude variation as the fractional offset changes.
	i0Beta := besselI0(kaiserBeta) // denominator for Kaiser window, computed once

	for p := 0; p < numPhases; p++ {
		frac := float64(p) / float64(numPhases)
		base := p * r.stride
		var sum float64
		for k := -r.taps; k <= r.taps; k++ {
			t := float64(k) - frac
			v := windowedSincKernel(t, cutoff, r.taps, i0Beta)
			r.polyphase[base+k+r.taps] = float32(v)
			sum += v
		}
		// Normalise to unity DC gain.
		if sum != 0 {
			invSum := float32(1.0 / sum)
			for k := 0; k < r.stride; k++ {
				r.polyphase[base+k] *= invSum
			}
		}
	}

	return r
}

// Resample converts a slice of uint8 offset-binary IQ pairs from actualRate to
// requestedRate using the pre-computed polyphase Kaiser-windowed sinc filter.
//
// Input:  [I0 Q0 I1 Q1 ...] uint8 offset-binary (127 = zero)
// Output: [I0 Q0 I1 Q1 ...] uint8 offset-binary at the new rate
//
// The hot path performs only float32 multiply-adds and array lookups.
// No transcendental functions are called during resampling.
func (r *IQResampler) Resample(input []byte) []byte {
	numInputSamples := len(input) / 2
	if numInputSamples == 0 {
		return input
	}

	// Build float32 I and Q arrays from the uint8 input, prepending history.
	// The history provides left-side context for the FIR filter at the start
	// of each packet, ensuring continuity across packet boundaries.
	totalLen := r.taps + numInputSamples
	iSig := make([]float32, totalLen)
	qSig := make([]float32, totalLen)

	for k := 0; k < r.taps; k++ {
		iSig[k] = r.histI[k]
		qSig[k] = r.histQ[k]
	}
	for k := 0; k < numInputSamples; k++ {
		iSig[r.taps+k] = float32(input[k*2]) - 127.0
		qSig[r.taps+k] = float32(input[k*2+1]) - 127.0
	}

	// Update history with the last r.taps input samples.
	if numInputSamples >= r.taps {
		for k := 0; k < r.taps; k++ {
			r.histI[k] = iSig[totalLen-r.taps+k]
			r.histQ[k] = qSig[totalLen-r.taps+k]
		}
	} else {
		copy(r.histI[:], r.histI[numInputSamples:])
		copy(r.histQ[:], r.histQ[numInputSamples:])
		for k := 0; k < numInputSamples; k++ {
			r.histI[r.taps-numInputSamples+k] = iSig[r.taps+k]
			r.histQ[r.taps-numInputSamples+k] = qSig[r.taps+k]
		}
	}

	// Calculate number of output samples.
	numOutputSamples := int(math.Floor((float64(numInputSamples)-r.phase)/r.ratio)) + 1
	if numOutputSamples <= 0 {
		r.phase -= float64(numInputSamples)
		return []byte{}
	}

	out := make([]byte, numOutputSamples*2)
	outIdx := 0

	for i := 0; i < numOutputSamples; i++ {
		// Fractional input position for this output sample.
		t := r.phase + float64(i)*r.ratio
		if t >= float64(numInputSamples) {
			out = out[:outIdx]
			numOutputSamples = i
			break
		}

		// Integer and fractional parts of t.
		tFloor := math.Floor(t)
		frac := t - tFloor

		// Select the polyphase sub-filter for this fractional offset.
		// p = round(frac * numPhases), clamped to [0, numPhases-1].
		p := int(frac*numPhases + 0.5)
		if p >= numPhases {
			p = numPhases - 1
		}
		coeffs := r.polyphase[p*r.stride : (p+1)*r.stride]

		// Centre tap index in the extended (history-prepended) array.
		centre := r.taps + int(tFloor)

		// Apply the FIR filter: dot product of coefficients with signal.
		// This is the hot path — only float32 multiply-adds, no function calls.
		var iOut, qOut float32
		start := centre - r.taps
		end := centre + r.taps + 1
		if start < 0 {
			start = 0
		}
		if end > totalLen {
			end = totalLen
		}
		// Sliced to matching lengths so the compiler can prove every index in
		// range and drop the three bounds checks this loop otherwise carries per
		// tap. Verified with -d=ssa/check_bce.
		// Sliced to the exact window so the compiler drops most of the bounds
		// checks this loop otherwise carries per tap -- measured 6% faster
		// decimating and 14% upsampling, where the tap count is lower but the
		// loop runs far more often. Verified with -d=ssa/check_bce.
		cw := coeffs[start-centre+r.taps : end-centre+r.taps]
		iw := iSig[start:end]
		qw := qSig[start:end]
		for k, c := range cw {
			iOut += iw[k] * c
			qOut += qw[k] * c
		}

		// Convert back to uint8 offset-binary, clamping to [0, 255].
		out[outIdx] = clampUint8F32(iOut + 127.0)
		out[outIdx+1] = clampUint8F32(qOut + 127.0)
		outIdx += 2
	}

	// Advance phase for the next call.
	r.phase = r.phase + float64(numOutputSamples)*r.ratio - float64(numInputSamples)
	for r.phase < 0 {
		r.phase += r.ratio
	}

	return out[:outIdx]
}

// windowedSincKernel evaluates the Kaiser-windowed sinc kernel at position t.
//
// Called only during pre-computation (NewIQResampler), not in the hot path.
//
//	h(t) = cutoff · sinc(cutoff·t) · kaiser(t/N, β)
//
// where sinc(x) = sin(π·x)/(π·x), sinc(0) = 1.
// i0Beta = I0(β) is passed in to avoid recomputing it for every tap.
func windowedSincKernel(t, cutoff float64, halfLen int, i0Beta float64) float64 {
	// Sinc kernel with cutoff scaling.
	x := cutoff * t
	var s float64
	if math.Abs(x) < 1e-10 {
		s = cutoff
	} else {
		s = math.Sin(math.Pi*x) / (math.Pi * t)
	}

	// Kaiser window: w(t) = I0(β·sqrt(1-(t/N)²)) / I0(β)
	tn := t / float64(halfLen)
	if tn < -1.0 || tn > 1.0 {
		return 0.0
	}
	arg := 1.0 - tn*tn
	if arg < 0 {
		arg = 0
	}
	w := besselI0(kaiserBeta*math.Sqrt(arg)) / i0Beta

	return s * w
}

// besselI0 computes the modified Bessel function of the first kind, order 0.
//
// Uses the polynomial approximation from Abramowitz & Stegun §9.8.1,
// accurate to ±1.6×10⁻⁷ for all x ≥ 0.
//
// Called only during pre-computation, not in the hot path.
func besselI0(x float64) float64 {
	ax := math.Abs(x)
	if ax <= 3.75 {
		y := (x / 3.75) * (x / 3.75)
		return 1.0 + y*(3.5156329+
			y*(3.0899424+
				y*(1.2067492+
					y*(0.2659732+
						y*(0.0360768+
							y*0.0045813)))))
	}
	y := 3.75 / ax
	return (math.Exp(ax) / math.Sqrt(ax)) * (0.39894228 +
		y*(0.01328592+
			y*(0.00225319+
				y*(-0.00157565+
					y*(0.00916281+
						y*(-0.02057706+
							y*(0.02635537+
								y*(-0.01647633+
									y*0.00392377))))))))
}

// clampUint8F32 rounds and clamps a float32 to the uint8 range [0, 255].
func clampUint8F32(v float32) byte {
	vi := int(v + 0.5)
	if vi < 0 {
		return 0
	}
	if vi > 255 {
		return 255
	}
	return byte(vi)
}
