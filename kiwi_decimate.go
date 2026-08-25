package main

import (
	"encoding/binary"
	"math"
)

// kiwiDecimator downsamples radiod's PCM to the single rate the KiwiSDR
// protocol is able to announce.
//
// Why this exists: a Kiwi client learns the audio rate exactly once, from the
// "audio_init ... audio_rate=" message at connect (verified against a real
// KiwiSDR v1.902, which reports 12 kHz and never revises it, for every mode
// including nbfm and iq).  radiod, by contrast, runs am/sam/fm/nfm channels at
// 24 kHz per share/presets.conf.  Forwarding those untouched made every AM and
// FM signal play at half speed, an octave low, with the client's buffer filling
// twice as fast as it drained.  Since the protocol cannot carry a rate change,
// the fix is to make the announced rate true.
//
// The filter is not optional.  For am/sam the demodulated output is bounded by
// radiod's predetection filter, so dropping samples would very nearly work, but
// FM is different: fm.c emits the discriminator output across the full output
// Nyquist and the nfm preset sets deemph-tc = 0, so FM's characteristic rising
// hiss occupies 6-12 kHz.  Decimating that without an anti-alias filter folds
// the loudest part of the noise straight into the audio band.
type kiwiDecimator struct {
	factor  int       // input samples consumed per output sample
	taps    []float32 // symmetric FIR, length is odd
	history []float32 // last len(taps)-1 input samples, oldest first
	phase   int       // input samples still to skip before the next output
	work    []float32 // scratch: history followed by the current packet
}

// newKiwiDecimator builds a decimator for inputRate -> outputRate.
// It returns nil when no conversion is needed or possible: equal rates, a
// non-integer ratio, or a rate that is not a positive multiple.  A nil
// *kiwiDecimator is a valid receiver whose Process is the identity, so callers
// do not need a branch for the pass-through case.
func newKiwiDecimator(inputRate, outputRate int) *kiwiDecimator {
	if inputRate <= 0 || outputRate <= 0 || inputRate == outputRate {
		return nil
	}
	if inputRate%outputRate != 0 {
		// Non-integer ratio (nothing in presets.conf produces one for the
		// modes the Kiwi emulation maps).  Refuse rather than guess.
		return nil
	}
	factor := inputRate / outputRate

	// Windowed-sinc low pass.  The cutoff sits at 0.45 of the output rate
	// rather than the full 0.5 so the transition band lands below the new
	// Nyquist instead of straddling it; for 24k -> 12k that is 5.4 kHz, which
	// keeps the whole of a 5 kHz AM passband and all of communications-quality
	// FM audio.  63 taps puts the stopband far enough down (> 60 dB with a
	// Blackman window) that folded FM hiss stays below the noise floor, and
	// costs ~1 MFLOP/s per session at 12 kHz out.
	const numTaps = 63
	cutoff := 0.45 / float64(factor) // cycles per input sample
	taps := make([]float32, numTaps)
	mid := (numTaps - 1) / 2
	var sum float64
	for i := 0; i < numTaps; i++ {
		n := float64(i - mid)
		var h float64
		if n == 0 {
			h = 2 * cutoff
		} else {
			x := 2 * math.Pi * cutoff * n
			h = math.Sin(x) / (math.Pi * n)
		}
		// Blackman window
		w := 0.42 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(numTaps-1)) +
			0.08*math.Cos(4*math.Pi*float64(i)/float64(numTaps-1))
		h *= w
		taps[i] = float32(h)
		sum += h
	}
	// Normalise to unity DC gain so the decimation does not change level.
	for i := range taps {
		taps[i] = float32(float64(taps[i]) / sum)
	}

	return &kiwiDecimator{
		factor:  factor,
		taps:    taps,
		history: make([]float32, numTaps-1),
	}
}

// Factor reports how many input samples are consumed per output sample.
func (d *kiwiDecimator) Factor() int {
	if d == nil {
		return 1
	}
	return d.factor
}

// Process filters and downsamples one packet of big-endian int16 PCM,
// returning big-endian int16 PCM at the output rate.
//
// Filter history and decimation phase carry across calls, so packet boundaries
// introduce no discontinuity and the output cadence stays even when a packet
// holds an odd number of samples.  A nil receiver returns the input unchanged.
func (d *kiwiDecimator) Process(pcm []byte) []byte {
	if d == nil || len(pcm) < 2 {
		return pcm
	}

	inSamples := len(pcm) / 2
	histLen := len(d.history)

	// work = [ history | this packet ], so a single linear pass covers the
	// packet boundary without shuffling the history per sample.
	if cap(d.work) < histLen+inSamples {
		d.work = make([]float32, histLen+inSamples)
	}
	d.work = d.work[:histLen+inSamples]
	copy(d.work, d.history)
	for i := 0; i < inSamples; i++ {
		d.work[histLen+i] = float32(int16(binary.BigEndian.Uint16(pcm[i*2:])))
	}

	out := make([]byte, 0, (inSamples/d.factor+1)*2)
	taps := d.taps
	for j := 0; j < inSamples; j++ {
		if d.phase > 0 {
			d.phase--
			continue
		}
		// The newest sample of this output is work[histLen+j], so the filter
		// window is work[j : j+len(taps)].
		window := d.work[j : j+len(taps) : j+len(taps)]
		var acc float32
		for k, t := range taps {
			acc += window[k] * t
		}
		out = binary.BigEndian.AppendUint16(out, uint16(clampToInt16(acc)))
		d.phase = d.factor - 1
	}

	// Retain the trailing taps-1 inputs for the next packet.
	copy(d.history, d.work[len(d.work)-histLen:])

	return out
}

// clampToInt16 saturates rather than wrapping.  The filter has unity DC gain
// but its passband ripple can push a full-scale input a fraction past the
// limit, and a wrap there would be an audible click instead of a hint of
// clipping.
func clampToInt16(v float32) int16 {
	switch {
	case v > math.MaxInt16:
		return math.MaxInt16
	case v < math.MinInt16:
		return math.MinInt16
	default:
		return int16(v)
	}
}
