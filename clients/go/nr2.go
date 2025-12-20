package main

import (
	"fmt"
	"math"
	"os"

	"github.com/mjibson/go-dsp/fft"
)

// NR2Processor implements spectral subtraction noise reduction
type NR2Processor struct {
	sampleRate    int
	fftSize       int
	hopSize       int
	overlapFactor int

	// Windowing
	window []float64

	// Buffers
	inputBuffer   []float32
	outputBuffer  []float32
	overlapBuffer []float32

	// Noise profile (magnitude spectrum)
	noiseProfile      []float32
	noiseProfileCount int
	learningFrames    int
	isLearning        bool

	// Adaptive noise tracking
	adaptiveNoiseTracking bool
	noiseAdaptRate        float32
	signalThreshold       float32

	// Parameters
	alpha   float32 // Over-subtraction factor
	beta    float32 // Spectral floor
	Enabled bool
}

// NewNR2Processor creates a new NR2 processor instance
func NewNR2Processor(sampleRate, fftSize, overlapFactor int) *NR2Processor {
	hopSize := fftSize / overlapFactor

	// Create Hann window (matches JavaScript implementation)
	window := make([]float64, fftSize)
	for i := 0; i < fftSize; i++ {
		window[i] = 0.5 * (1 - math.Cos(2*math.Pi*float64(i)/float64(fftSize-1)))
	}

	processor := &NR2Processor{
		sampleRate:    sampleRate,
		fftSize:       fftSize,
		hopSize:       hopSize,
		overlapFactor: overlapFactor,
		window:        window,

		inputBuffer:   make([]float32, fftSize),
		outputBuffer:  make([]float32, fftSize),
		overlapBuffer: make([]float32, fftSize),

		noiseProfile:      make([]float32, fftSize/2+1),
		noiseProfileCount: 0,
		learningFrames:    30, // ~0.5 seconds at 60fps
		isLearning:        true,

		adaptiveNoiseTracking: true,
		noiseAdaptRate:        0.01, // 1% per frame
		signalThreshold:       2.0,

		alpha:   2.0,  // Default over-subtraction factor
		beta:    0.01, // Default spectral floor
		Enabled: false,
	}

	return processor
}

// SetParameters updates noise reduction parameters
func (p *NR2Processor) SetParameters(strength, floor, adaptRate float64) {
	// Strength 0-100% maps to alpha 1.0-4.0
	p.alpha = float32(1.0 + (strength/100.0)*3.0)

	// Floor 0-10% maps to beta 0.001-0.1
	p.beta = float32(0.001 + (floor/100.0)*0.099)

	// Adapt rate 0.1-5.0% maps to 0.001-0.05
	p.noiseAdaptRate = float32(adaptRate / 100.0)
}

// ResetLearning resets noise learning to re-learn the noise profile
func (p *NR2Processor) ResetLearning() {
	for i := range p.noiseProfile {
		p.noiseProfile[i] = 0
	}
	p.noiseProfileCount = 0
	p.isLearning = true
}

// Process processes a buffer of audio samples with noise reduction
func (p *NR2Processor) Process(inputSamples []float32) []float32 {
	inputLength := len(inputSamples)
	output := make([]float32, inputLength)

	inputPos := 0
	outputPos := 0

	for inputPos < inputLength {
		// Fill input buffer
		samplesToBuffer := p.hopSize
		if inputPos+samplesToBuffer > inputLength {
			samplesToBuffer = inputLength - inputPos
		}

		// Shift existing samples
		copy(p.inputBuffer, p.inputBuffer[samplesToBuffer:])

		// Add new samples
		copy(p.inputBuffer[p.fftSize-samplesToBuffer:], inputSamples[inputPos:inputPos+samplesToBuffer])

		// Process frame
		p.processFrame()

		// Output samples
		samplesToOutput := p.hopSize
		if outputPos+samplesToOutput > len(output) {
			samplesToOutput = len(output) - outputPos
		}
		copy(output[outputPos:outputPos+samplesToOutput], p.outputBuffer[:samplesToOutput])

		// Shift output buffer
		copy(p.outputBuffer, p.outputBuffer[p.hopSize:])
		for i := p.fftSize - p.hopSize; i < p.fftSize; i++ {
			p.outputBuffer[i] = 0
		}

		inputPos += samplesToBuffer
		outputPos += samplesToOutput
	}

	return output
}

// processFrame processes one FFT frame with spectral subtraction
func (p *NR2Processor) processFrame() {
	// Apply window to input
	windowed := make([]float64, p.fftSize)
	for i := 0; i < p.fftSize; i++ {
		windowed[i] = float64(p.inputBuffer[i]) * p.window[i]
	}

	// Forward FFT (real FFT)
	spectrum := fft.FFTReal(windowed)

	// Calculate magnitude spectrum
	numBins := p.fftSize/2 + 1
	magnitude := make([]float32, numBins)
	for i := 0; i < numBins; i++ {
		magnitude[i] = float32(cmplx.Abs(spectrum[i]))
	}

	// Learn noise profile
	if p.isLearning && p.noiseProfileCount < p.learningFrames {
		for i := 0; i < numBins; i++ {
			p.noiseProfile[i] += magnitude[i]
		}
		p.noiseProfileCount++

		if p.noiseProfileCount >= p.learningFrames {
			// Average the noise profile
			for i := 0; i < numBins; i++ {
				p.noiseProfile[i] /= float32(p.learningFrames)
			}
			p.isLearning = false
			fmt.Fprintln(os.Stderr, "NR2: Noise profile learned")
		}

		// During learning, pass through with window (matches JS line 142)
		// Apply COLA normalization for proper reconstruction
		for i := 0; i < p.fftSize; i++ {
			p.outputBuffer[i] += float32(windowed[i]) / 1.5
		}
		return
	}

	// Apply spectral subtraction if enabled
	if p.Enabled && !p.isLearning {
		// Adaptive noise tracking: update noise profile when signal is weak
		if p.adaptiveNoiseTracking {
			// Only update noise estimate when current magnitude is close to noise floor
			for i := 0; i < numBins; i++ {
				if magnitude[i] < p.signalThreshold*p.noiseProfile[i] {
					// Exponential moving average: slowly track noise changes
					p.noiseProfile[i] = (1-p.noiseAdaptRate)*p.noiseProfile[i] +
						p.noiseAdaptRate*magnitude[i]
				}
			}
		}

		// Spectral subtraction with over-subtraction
		cleanMagnitude := make([]float32, numBins)
		for i := 0; i < numBins; i++ {
			cleanMagnitude[i] = magnitude[i] - p.alpha*p.noiseProfile[i]

			// Apply spectral floor to prevent musical noise
			floor := p.beta * magnitude[i]
			if cleanMagnitude[i] < floor {
				cleanMagnitude[i] = floor
			}
		}

		// Update spectrum with cleaned magnitude (preserve phase)
		for i := 0; i < numBins; i++ {
			if magnitude[i] > 0 {
				scale := cleanMagnitude[i] / magnitude[i]
				spectrum[i] = complex(real(spectrum[i])*float64(scale), imag(spectrum[i])*float64(scale))
			}
		}
	}

	// Inverse FFT
	outputFrame := fft.IFFT(spectrum)

	// Overlap-add with window (matches JS line 191)
	// CRITICAL: With 4x overlap and Hann window applied twice (before FFT and here),
	// we need to normalize by the COLA sum to avoid amplitude modulation artifacts
	// For Hann window with 4x overlap, the COLA sum is 1.5 when window is applied twice
	// So we divide by 1.5 to get unity gain
	for i := 0; i < p.fftSize; i++ {
		p.outputBuffer[i] += float32(real(outputFrame[i])*p.window[i]) / 1.5
	}
}

// cmplx provides complex number utilities
var cmplx = struct {
	Abs func(complex128) float64
}{
	Abs: func(c complex128) float64 {
		return math.Sqrt(real(c)*real(c) + imag(c)*imag(c))
	},
}
