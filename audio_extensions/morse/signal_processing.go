package morse

import (
	"math"
)

// EnvelopeDetector detects the envelope of a CW signal using Goertzel filter
// Based on KiwiSDR/UHSDR CW decoder approach
type EnvelopeDetector struct {
	sampleRate      int
	centerFrequency float64
	bandwidth       float64

	// Goertzel filter for tone detection
	goertzel *GoertzelFilter

	// Threshold mode
	isAutoThreshold bool // Use auto threshold (nonlinear) vs fixed threshold

	// Envelope tracking (asymmetric decay averaging)
	envelope     float64
	noise        float64
	attackWeight float64
	decayWeight  float64

	// Signal smoothing (low-pass)
	signalTau float64
	oldSignal float64

	// Noise canceling (debouncing)
	noiseCancelEnabled bool
	noiseCancelChange  bool
	currentState       bool
	previousState      bool
}

// NewEnvelopeDetector creates a new envelope detector
func NewEnvelopeDetector(sampleRate int, centerFrequency, bandwidth float64, isAutoThreshold bool) *EnvelopeDetector {
	// Calculate weights for asymmetric decay averaging
	// Based on KiwiSDR: weight_linear / 1000
	// Fast attack: weight / 4
	// Slow decay: weight * 16 (envelope), weight * 48 (noise)
	baseWeight := 32.0 // Approximately one CW bit time

	ed := &EnvelopeDetector{
		sampleRate:         sampleRate,
		centerFrequency:    centerFrequency,
		bandwidth:          bandwidth,
		isAutoThreshold:    isAutoThreshold,
		attackWeight:       baseWeight / 4.0,
		decayWeight:        baseWeight * 16.0,
		signalTau:          0.1, // 10% new signal, 90% old (SIGNAL_TAU from KiwiSDR)
		envelope:           0.0,
		noise:              0.0,
		oldSignal:          0.0,
		noiseCancelEnabled: true,
		noiseCancelChange:  false,
		currentState:       false,
		previousState:      false,
	}

	// Create Goertzel filter for the center frequency
	// Use block size of 32 samples (like KiwiSDR)
	ed.goertzel = NewGoertzelFilter(sampleRate, centerFrequency, 32)

	return ed
}

// ProcessBlock processes a block of samples and returns the signal level
func (ed *EnvelopeDetector) ProcessBlock(samples []float64) float64 {
	// Feed samples to Goertzel filter
	for _, sample := range samples {
		ed.goertzel.ProcessSample(sample)
	}

	// Get magnitude squared from Goertzel
	magnitudeSquared := ed.goertzel.GetMagnitudeSquared()

	var signal float64

	if ed.isAutoThreshold {
		// Auto threshold mode: use nonlinear processing
		// KiwiSDR lines 447-485

		// Track envelope (fast attack, slow decay)
		var envWeight float64
		if magnitudeSquared > ed.envelope {
			envWeight = ed.attackWeight
		} else {
			envWeight = ed.decayWeight
		}
		ed.envelope = decayAvg(ed.envelope, magnitudeSquared, envWeight)

		// Track noise (fast attack when below, slow decay when above)
		var noiseWeight float64
		if magnitudeSquared < ed.noise {
			noiseWeight = ed.attackWeight
		} else {
			noiseWeight = ed.decayWeight * 3.0 // Even slower for noise (weight * 48)
		}
		ed.noise = decayAvg(ed.noise, magnitudeSquared, noiseWeight)

		// Clamp signal between noise and magnitude
		clipped := clamp(ed.envelope, ed.noise, magnitudeSquared)

		// Nonlinear processing (KiwiSDR approach)
		envToNoise := clipped - ed.noise
		v1 := (clipped-ed.noise)*envToNoise - 0.8*(envToNoise*envToNoise)

		// Preserve sign before taking square root (KiwiSDR line 478)
		sign := 1.0
		if v1 < 0 {
			sign = -1.0
		}
		v1 = math.Sqrt(math.Abs(v1)) * sign

		// Low-pass filter with SIGNAL_TAU
		signal = v1*ed.signalTau + ed.oldSignal*(1.0-ed.signalTau)
		ed.oldSignal = v1
	} else {
		// Fixed threshold mode: simple magnitude with low-pass filter
		// KiwiSDR lines 488-494
		signal = magnitudeSquared*ed.signalTau + ed.oldSignal*(1.0-ed.signalTau)
		ed.oldSignal = magnitudeSquared
	}

	return signal
}

// Process processes a single sample (for compatibility)
// Returns the current signal level
func (ed *EnvelopeDetector) Process(sample float64) float64 {
	// For single-sample processing, just feed to Goertzel
	// and return the last calculated signal level
	ed.goertzel.ProcessSample(sample)

	// Check if block is complete
	if ed.goertzel.IsBlockComplete() {
		return ed.ProcessBlock(nil) // Block already processed
	}

	return ed.oldSignal // Return last signal level
}

// decayAvg implements asymmetric decay averaging
func decayAvg(avg, input, weight float64) float64 {
	if weight <= 0 {
		return avg
	}
	return avg + (input-avg)/weight
}

// clamp clamps a value between min and max
func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// GoertzelFilter implements the Goertzel algorithm for single-frequency detection
type GoertzelFilter struct {
	sampleRate int
	frequency  float64
	blockSize  int

	// Goertzel coefficients
	coeff float64
	sin   float64
	cos   float64

	// State variables
	s1, s2 float64

	// Block processing
	count int
}

// NewGoertzelFilter creates a new Goertzel filter
func NewGoertzelFilter(sampleRate int, frequency float64, blockSize int) *GoertzelFilter {
	gf := &GoertzelFilter{
		sampleRate: sampleRate,
		frequency:  frequency,
		blockSize:  blockSize,
		count:      0,
	}

	// Calculate Goertzel coefficient
	k := 0.5 + float64(blockSize)*frequency/float64(sampleRate)
	omega := 2.0 * math.Pi * k / float64(blockSize)
	gf.coeff = 2.0 * math.Cos(omega)
	gf.sin = math.Sin(omega)
	gf.cos = math.Cos(omega)

	return gf
}

// ProcessSample processes a single sample
func (gf *GoertzelFilter) ProcessSample(sample float64) {
	// Goertzel algorithm
	s0 := sample + gf.coeff*gf.s1 - gf.s2
	gf.s2 = gf.s1
	gf.s1 = s0
	gf.count++
}

// IsBlockComplete returns true if a block is complete
func (gf *GoertzelFilter) IsBlockComplete() bool {
	return gf.count >= gf.blockSize
}

// GetMagnitudeSquared calculates and returns magnitude squared, then resets for next block
func (gf *GoertzelFilter) GetMagnitudeSquared() float64 {
	// Always calculate even if block not complete (for partial blocks)
	if gf.count == 0 {
		return 0.0
	}

	// Calculate magnitude squared
	real := gf.s1*gf.cos - gf.s2
	imag := gf.s1 * gf.sin
	magnitudeSquared := real*real + imag*imag

	// Normalize by actual count (not blockSize)
	magnitudeSquared /= float64(gf.count * gf.count)

	// Reset for next block
	gf.s1 = 0
	gf.s2 = 0
	gf.count = 0

	return magnitudeSquared
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
