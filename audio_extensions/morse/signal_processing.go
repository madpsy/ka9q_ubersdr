package morse

import (
	"math"
)

// EnvelopeDetector detects the envelope of a signal using a bandpass filter and envelope follower
type EnvelopeDetector struct {
	sampleRate      int
	centerFrequency float64
	bandwidth       float64

	// Goertzel filter for tone detection
	goertzel *GoertzelFilter

	// Envelope follower (low-pass filter)
	envelopeAttack float64
	envelopeDecay  float64
	envelope       float64
}

// NewEnvelopeDetector creates a new envelope detector
func NewEnvelopeDetector(sampleRate int, centerFrequency, bandwidth float64) *EnvelopeDetector {
	// Use very slow envelope following to smooth out Goertzel block updates
	// Attack: 10ms time constant
	// Decay: 20ms time constant
	// This creates a proper CW envelope that follows the actual keying
	attackTimeMs := 10.0
	decayTimeMs := 20.0

	// Convert to alpha values for exponential moving average
	// alpha = 1 - exp(-dt / time_constant)
	// For per-sample updates: dt = 1/sample_rate
	// Simplified for small values: alpha ≈ 1 / (time_constant_seconds * sample_rate)
	attackAlpha := 1000.0 / (attackTimeMs * float64(sampleRate))
	decayAlpha := 1000.0 / (decayTimeMs * float64(sampleRate))

	ed := &EnvelopeDetector{
		sampleRate:      sampleRate,
		centerFrequency: centerFrequency,
		bandwidth:       bandwidth,
		envelopeAttack:  attackAlpha,
		envelopeDecay:   decayAlpha,
		envelope:        0.0,
	}

	// Create Goertzel filter for the center frequency
	ed.goertzel = NewGoertzelFilter(sampleRate, centerFrequency)

	return ed
}

// Process processes a single audio sample and returns the envelope
func (ed *EnvelopeDetector) Process(sample float64) float64 {
	// Apply Goertzel filter to detect tone
	magnitude := ed.goertzel.Process(sample)

	// Only update envelope when Goertzel returns a new value (non-zero)
	if magnitude > 0.0 {
		// Envelope follower with attack/decay
		if magnitude > ed.envelope {
			// Attack (signal increasing)
			ed.envelope = ed.envelopeAttack*magnitude + (1-ed.envelopeAttack)*ed.envelope
		} else {
			// Decay (signal decreasing)
			ed.envelope = ed.envelopeDecay*magnitude + (1-ed.envelopeDecay)*ed.envelope
		}
	}
	// Otherwise hold the current envelope value

	return ed.envelope
}

// GoertzelFilter implements the Goertzel algorithm for single-frequency detection
type GoertzelFilter struct {
	sampleRate int
	frequency  float64
	coeff      float64

	// State variables
	s1, s2 float64

	// Block processing
	blockSize int
	count     int
}

// NewGoertzelFilter creates a new Goertzel filter
func NewGoertzelFilter(sampleRate int, frequency float64) *GoertzelFilter {
	gf := &GoertzelFilter{
		sampleRate: sampleRate,
		frequency:  frequency,
		blockSize:  sampleRate / 100, // 10ms blocks
		count:      0,
	}

	// Calculate coefficient
	k := 0.5 + float64(gf.blockSize)*frequency/float64(sampleRate)
	omega := 2.0 * math.Pi * k / float64(gf.blockSize)
	gf.coeff = 2.0 * math.Cos(omega)

	return gf
}

// Process processes a single sample and returns magnitude
func (gf *GoertzelFilter) Process(sample float64) float64 {
	// Goertzel algorithm
	s0 := sample + gf.coeff*gf.s1 - gf.s2
	gf.s2 = gf.s1
	gf.s1 = s0

	gf.count++

	// Only calculate magnitude at end of block for stability
	// Between blocks, return the last calculated magnitude
	if gf.count >= gf.blockSize {
		// Calculate magnitude
		real := gf.s1 - gf.s2*math.Cos(2.0*math.Pi*gf.frequency/float64(gf.sampleRate))
		imag := gf.s2 * math.Sin(2.0*math.Pi*gf.frequency/float64(gf.sampleRate))
		magnitude := math.Sqrt(real*real+imag*imag) / float64(gf.blockSize)

		// Reset for next block
		gf.s1 = 0
		gf.s2 = 0
		gf.count = 0

		return magnitude
	}

	// Return 0 between blocks - envelope detector will hold the value
	return 0.0
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

	// Calculate noise floor (20th percentile)
	noise := percentile(se.samples, 20)

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
