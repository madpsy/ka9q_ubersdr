package main

import (
	"math"
)

// Resampler provides high-quality audio resampling using sinc interpolation
type Resampler struct {
	inputRate  int
	outputRate int
	ratio      float64
	channels   int

	// Sinc filter parameters
	sincWidth int // Number of zero crossings on each side
	sincTable []float64
	tableSize int

	// State for continuous resampling
	inputBuffer  []float64 // Buffered input samples
	outputBuffer []float64 // Pre-computed output samples
	position     float64   // Current fractional position in input
}

// NewResampler creates a new resampler instance
func NewResampler(inputRate, outputRate, channels int) *Resampler {
	ratio := float64(outputRate) / float64(inputRate)

	// Use a sinc filter with 32 zero crossings on each side for high quality
	// This matches the quality of libsamplerate's "sinc_best" converter
	sincWidth := 32
	tableSize := 4096 // Lookup table size for sinc interpolation

	r := &Resampler{
		inputRate:    inputRate,
		outputRate:   outputRate,
		ratio:        ratio,
		channels:     channels,
		sincWidth:    sincWidth,
		tableSize:    tableSize,
		inputBuffer:  make([]float64, 0, sincWidth*2*channels),
		outputBuffer: make([]float64, 0),
		position:     0.0,
	}

	// Pre-compute sinc lookup table
	r.buildSincTable()

	return r
}

// buildSincTable pre-computes a windowed sinc function lookup table
func (r *Resampler) buildSincTable() {
	r.sincTable = make([]float64, r.tableSize*r.sincWidth*2)

	for i := 0; i < r.tableSize; i++ {
		// Fractional position within one sample period
		frac := float64(i) / float64(r.tableSize)

		for j := -r.sincWidth; j < r.sincWidth; j++ {
			x := float64(j) + frac

			var sincVal float64
			if math.Abs(x) < 1e-10 {
				sincVal = 1.0
			} else {
				// Sinc function: sin(π*x) / (π*x)
				sincVal = math.Sin(math.Pi*x) / (math.Pi * x)
			}

			// Apply Kaiser window for better frequency response
			// Kaiser window with β=8.5 provides good balance
			beta := 8.5
			windowVal := r.kaiserWindow(x, r.sincWidth, beta)

			idx := i*(r.sincWidth*2) + (j + r.sincWidth)
			r.sincTable[idx] = sincVal * windowVal
		}
	}
}

// kaiserWindow computes the Kaiser window function
func (r *Resampler) kaiserWindow(x float64, width int, beta float64) float64 {
	if math.Abs(x) >= float64(width) {
		return 0.0
	}

	// Normalized position: -1 to 1
	pos := x / float64(width)

	// Kaiser window formula
	arg := beta * math.Sqrt(1.0-pos*pos)
	return r.besselI0(arg) / r.besselI0(beta)
}

// besselI0 computes the modified Bessel function of the first kind, order 0
func (r *Resampler) besselI0(x float64) float64 {
	// Series expansion for I0(x)
	sum := 1.0
	term := 1.0

	for i := 1; i < 50; i++ {
		term *= (x / (2.0 * float64(i))) * (x / (2.0 * float64(i)))
		sum += term

		if term < 1e-12*sum {
			break
		}
	}

	return sum
}

// Process resamples a chunk of audio data
// Input: int16 PCM samples (interleaved for stereo)
// Output: int16 PCM samples at the new sample rate
func (r *Resampler) Process(input []int16) []int16 {
	if len(input) == 0 {
		return []int16{}
	}

	// Convert int16 to float64 for processing
	inputFloat := make([]float64, len(input))
	for i, sample := range input {
		inputFloat[i] = float64(sample) / 32768.0
	}

	// Add new samples to input buffer
	r.inputBuffer = append(r.inputBuffer, inputFloat...)

	// Calculate how many output samples we can produce
	samplesPerChannel := len(r.inputBuffer) / r.channels

	// We need sincWidth samples on each side, so we can only process up to
	// samplesPerChannel - sincWidth (leaving sincWidth at the end)
	if samplesPerChannel < r.sincWidth*2 {
		// Not enough input samples yet
		return []int16{}
	}

	// Calculate output size based on input samples we can actually process
	inputSamplesAvailable := samplesPerChannel - r.sincWidth
	maxOutputSamples := int((float64(inputSamplesAvailable) - r.position) * r.ratio)

	if maxOutputSamples <= 0 {
		return []int16{}
	}

	// Allocate output buffer
	output := make([]float64, 0, maxOutputSamples*r.channels)

	// Process each output sample
	outputCount := 0
	for outputCount < maxOutputSamples {
		// Current position in input buffer (in samples per channel)
		currentPos := r.position + float64(outputCount)/r.ratio

		// Check if we have enough samples for interpolation
		// Need sincWidth samples on each side
		if int(currentPos)+r.sincWidth >= samplesPerChannel {
			break
		}

		// For each channel
		for ch := 0; ch < r.channels; ch++ {
			sample := r.interpolateSampleAt(currentPos, ch)
			output = append(output, sample)
		}

		outputCount++
	}

	// Update position and remove consumed samples
	if outputCount > 0 {
		// How far we advanced in the input
		inputAdvance := float64(outputCount) / r.ratio
		r.position += inputAdvance

		// Remove consumed samples, but keep sincWidth samples for next chunk
		consumedSamplesPerChannel := int(r.position)
		if consumedSamplesPerChannel > 0 {
			consumedSamples := consumedSamplesPerChannel * r.channels

			if consumedSamples < len(r.inputBuffer) {
				// Shift buffer
				copy(r.inputBuffer, r.inputBuffer[consumedSamples:])
				r.inputBuffer = r.inputBuffer[:len(r.inputBuffer)-consumedSamples]

				// Keep fractional part of position
				r.position -= float64(consumedSamplesPerChannel)
			}
		}
	}

	// Convert float64 back to int16
	outputInt16 := make([]int16, len(output))
	for i, sample := range output {
		// Clamp to int16 range
		if sample > 1.0 {
			sample = 1.0
		} else if sample < -1.0 {
			sample = -1.0
		}
		outputInt16[i] = int16(sample * 32767.0)
	}

	return outputInt16
}

// interpolateSampleAt interpolates a single sample at a specific position for the given channel
func (r *Resampler) interpolateSampleAt(position float64, channel int) float64 {
	// Integer and fractional parts of position
	intPos := int(position)
	fracPos := position - float64(intPos)

	// Lookup table index
	tableIdx := int(fracPos * float64(r.tableSize))
	if tableIdx >= r.tableSize {
		tableIdx = r.tableSize - 1
	}

	// Sinc interpolation
	var sum float64
	for i := -r.sincWidth; i < r.sincWidth; i++ {
		inputIdx := (intPos+i)*r.channels + channel

		if inputIdx >= 0 && inputIdx < len(r.inputBuffer) {
			sincIdx := tableIdx*(r.sincWidth*2) + (i + r.sincWidth)
			sum += r.inputBuffer[inputIdx] * r.sincTable[sincIdx]
		}
	}

	return sum
}

// Reset clears the resampler state
func (r *Resampler) Reset() {
	r.inputBuffer = r.inputBuffer[:0]
	r.outputBuffer = r.outputBuffer[:0]
	r.position = 0.0
}

// GetLatency returns the latency introduced by the resampler in samples (at output rate)
func (r *Resampler) GetLatency() int {
	return int(float64(r.sincWidth) * r.ratio)
}

// SimpleResampler provides a simpler, lower-quality but faster resampling option
// Uses linear interpolation instead of sinc
type SimpleResampler struct {
	inputRate  int
	outputRate int
	ratio      float64
	channels   int

	lastSamples []float64 // Last sample from previous chunk for interpolation
	position    float64   // Current fractional position
}

// NewSimpleResampler creates a simple linear interpolation resampler
func NewSimpleResampler(inputRate, outputRate, channels int) *SimpleResampler {
	return &SimpleResampler{
		inputRate:   inputRate,
		outputRate:  outputRate,
		ratio:       float64(outputRate) / float64(inputRate),
		channels:    channels,
		lastSamples: make([]float64, channels),
		position:    0.0,
	}
}

// Process resamples using linear interpolation (faster but lower quality)
func (r *SimpleResampler) Process(input []int16) []int16 {
	if len(input) == 0 {
		return []int16{}
	}

	// Convert to float
	inputFloat := make([]float64, len(input))
	for i, sample := range input {
		inputFloat[i] = float64(sample) / 32768.0
	}

	// Calculate output size
	inputSamplesPerChannel := len(input) / r.channels
	outputSamplesPerChannel := int(float64(inputSamplesPerChannel) * r.ratio)
	output := make([]int16, outputSamplesPerChannel*r.channels)

	outIdx := 0
	for outIdx < len(output) {
		// Integer and fractional position
		intPos := int(r.position)
		frac := r.position - float64(intPos)

		// For each channel
		for ch := 0; ch < r.channels; ch++ {
			var sample float64

			idx1 := intPos*r.channels + ch
			idx2 := (intPos+1)*r.channels + ch

			if idx1 < 0 {
				// Use last sample from previous chunk
				sample = r.lastSamples[ch]
			} else if idx2 >= len(inputFloat) {
				// Use last available sample
				sample = inputFloat[idx1]
			} else {
				// Linear interpolation
				sample = inputFloat[idx1]*(1.0-frac) + inputFloat[idx2]*frac
			}

			// Clamp and convert to int16
			if sample > 1.0 {
				sample = 1.0
			} else if sample < -1.0 {
				sample = -1.0
			}

			output[outIdx] = int16(sample * 32767.0)
			outIdx++
		}

		// Advance position
		r.position += 1.0 / r.ratio
	}

	// Save last samples for next chunk
	for ch := 0; ch < r.channels; ch++ {
		lastIdx := len(inputFloat) - r.channels + ch
		if lastIdx >= 0 {
			r.lastSamples[ch] = inputFloat[lastIdx]
		}
	}

	// Adjust position for next chunk
	r.position -= float64(inputSamplesPerChannel)

	return output
}

// Reset clears the resampler state
func (r *SimpleResampler) Reset() {
	for i := range r.lastSamples {
		r.lastSamples[i] = 0.0
	}
	r.position = 0.0
}

// GetLatency returns the latency (always 1 sample for linear interpolation)
func (r *SimpleResampler) GetLatency() int {
	return 1
}
