package morse

import (
	"math"
)

// EnvelopeDetector detects the envelope of a signal using a bandpass filter and envelope follower
type EnvelopeDetector struct {
	sampleRate      int
	centerFrequency float64
	bandwidth       float64

	// Bandpass filter for tone detection
	bandpass *BandpassFilter

	// Low-pass filter for envelope smoothing
	lowpass *LowpassFilter

	// Envelope follower (exponential smoothing)
	envelope float64
}

// NewEnvelopeDetector creates a new envelope detector
func NewEnvelopeDetector(sampleRate int, centerFrequency, bandwidth float64) *EnvelopeDetector {
	ed := &EnvelopeDetector{
		sampleRate:      sampleRate,
		centerFrequency: centerFrequency,
		bandwidth:       bandwidth,
		envelope:        0.0,
	}

	// Create bandpass filter for the center frequency
	ed.bandpass = NewBandpassFilter(sampleRate, centerFrequency, bandwidth)

	// Create low-pass filter for envelope smoothing (cutoff at 50 Hz)
	// This removes ripple from the rectified signal
	ed.lowpass = NewLowpassFilter(sampleRate, 50.0)

	return ed
}

// Process processes a single audio sample and returns the envelope
func (ed *EnvelopeDetector) Process(sample float64) float64 {
	// Apply bandpass filter
	filtered := ed.bandpass.Process(sample)

	// Rectify (get magnitude)
	magnitude := math.Abs(filtered)

	// Low-pass filter the rectified signal to get smooth envelope
	ed.envelope = ed.lowpass.Process(magnitude)

	return ed.envelope
}

// BandpassFilter implements a biquad IIR bandpass filter
type BandpassFilter struct {
	// Biquad coefficients
	b0, b1, b2 float64
	a1, a2     float64

	// State variables (delayed samples)
	x1, x2 float64 // Input history
	y1, y2 float64 // Output history
}

// NewBandpassFilter creates a new bandpass filter
func NewBandpassFilter(sampleRate int, centerFreq, bandwidth float64) *BandpassFilter {
	// Design a biquad bandpass filter
	// Q factor determines bandwidth: Q = centerFreq / bandwidth
	Q := centerFreq / bandwidth
	if Q < 0.5 {
		Q = 0.5 // Minimum Q to avoid instability
	}

	// Normalized frequency
	omega := 2.0 * math.Pi * centerFreq / float64(sampleRate)
	alpha := math.Sin(omega) / (2.0 * Q)

	// Biquad coefficients for bandpass filter
	b0 := alpha
	b1 := 0.0
	b2 := -alpha
	a0 := 1.0 + alpha
	a1 := -2.0 * math.Cos(omega)
	a2 := 1.0 - alpha

	// Normalize by a0
	return &BandpassFilter{
		b0: b0 / a0,
		b1: b1 / a0,
		b2: b2 / a0,
		a1: a1 / a0,
		a2: a2 / a0,
		x1: 0,
		x2: 0,
		y1: 0,
		y2: 0,
	}
}

// Process processes a single sample through the bandpass filter
func (bf *BandpassFilter) Process(sample float64) float64 {
	// Biquad difference equation:
	// y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
	output := bf.b0*sample + bf.b1*bf.x1 + bf.b2*bf.x2 - bf.a1*bf.y1 - bf.a2*bf.y2

	// Update state
	bf.x2 = bf.x1
	bf.x1 = sample
	bf.y2 = bf.y1
	bf.y1 = output

	return output
}

// LowpassFilter implements a simple first-order low-pass filter
type LowpassFilter struct {
	alpha float64
	y     float64
}

// NewLowpassFilter creates a new low-pass filter
func NewLowpassFilter(sampleRate int, cutoffFreq float64) *LowpassFilter {
	// Calculate alpha for first-order low-pass filter
	// alpha = dt / (RC + dt) where RC = 1 / (2 * pi * fc)
	dt := 1.0 / float64(sampleRate)
	rc := 1.0 / (2.0 * math.Pi * cutoffFreq)
	alpha := dt / (rc + dt)

	return &LowpassFilter{
		alpha: alpha,
		y:     0.0,
	}
}

// Process processes a sample through the low-pass filter
func (lp *LowpassFilter) Process(sample float64) float64 {
	lp.y = lp.alpha*sample + (1-lp.alpha)*lp.y
	return lp.y
}

// SNREstimator estimates signal-to-noise ratio
type SNREstimator struct {
	windowSize int
	samples    []float64
	index      int
	filled     bool
}

// NewSNREstimator creates a new SNR estimator
func NewSNREstimator(windowSize int) *SNREstimator {
	return &SNREstimator{
		windowSize: windowSize,
		samples:    make([]float64, windowSize),
		index:      0,
		filled:     false,
	}
}

// Process processes a sample and returns estimated SNR in dB
func (se *SNREstimator) Process(sample float64) float64 {
	// Store sample
	se.samples[se.index] = sample
	se.index++

	if se.index >= se.windowSize {
		se.index = 0
		se.filled = true
	}

	if !se.filled {
		return 0.0
	}

	// Calculate noise floor (5th percentile - below the signal)
	// For CW, signal is only present ~50% of time, so 20th percentile includes signal
	noise := percentile(se.samples, 5)

	// Avoid division by zero
	if noise < 1e-10 {
		noise = 1e-10
	}

	// Calculate SNR
	snr := sample / noise

	// Convert to dB
	snrDB := 10.0 * math.Log10(snr)

	return snrDB
}

// percentile calculates the nth percentile of a slice
func percentile(data []float64, p float64) float64 {
	if len(data) == 0 {
		return 0.0
	}

	// Create a copy and sort it
	sorted := make([]float64, len(data))
	copy(sorted, data)

	// Simple insertion sort (good enough for small arrays)
	for i := 1; i < len(sorted); i++ {
		key := sorted[i]
		j := i - 1
		for j >= 0 && sorted[j] > key {
			sorted[j+1] = sorted[j]
			j--
		}
		sorted[j+1] = key
	}

	// Calculate percentile index
	index := int(float64(len(sorted)-1) * p / 100.0)
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}

	return sorted[index]
}
