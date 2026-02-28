package whisper

import "math"

/*
 * Simple linear interpolation resampler
 * Converts audio from any sample rate to 16 kHz for WhisperLive
 */

const targetSampleRate = 16000

// Resampler handles sample rate conversion
type Resampler struct {
	inputRate  int
	outputRate int
	ratio      float64
	position   float64 // Current position in input stream
	lastSample int16   // Last sample for interpolation
}

// NewResampler creates a new resampler
func NewResampler(inputRate int) *Resampler {
	return &Resampler{
		inputRate:  inputRate,
		outputRate: targetSampleRate,
		ratio:      float64(inputRate) / float64(targetSampleRate),
		position:   0.0,
		lastSample: 0,
	}
}

// Resample converts input samples to target sample rate (16 kHz)
// Uses linear interpolation for quality/performance balance
func (r *Resampler) Resample(input []int16) []int16 {
	if r.inputRate == r.outputRate {
		// No resampling needed
		return input
	}

	// Calculate output size
	outputSize := int(float64(len(input)) / r.ratio)
	output := make([]int16, 0, outputSize)

	for i := 0; i < outputSize; i++ {
		// Calculate position in input array
		inputPos := r.position

		// Get integer and fractional parts
		intPos := int(inputPos)
		frac := inputPos - float64(intPos)

		// Bounds check
		if intPos >= len(input)-1 {
			break
		}

		// Linear interpolation between samples
		sample1 := float64(input[intPos])
		sample2 := float64(input[intPos+1])
		interpolated := sample1 + (sample2-sample1)*frac

		// Clamp to int16 range
		if interpolated > 32767 {
			interpolated = 32767
		} else if interpolated < -32768 {
			interpolated = -32768
		}

		output = append(output, int16(math.Round(interpolated)))

		// Advance position
		r.position += r.ratio
	}

	// Adjust position for next call (handle remainder)
	r.position -= float64(len(input))
	if r.position < 0 {
		r.position = 0
	}

	// Store last sample for next iteration
	if len(input) > 0 {
		r.lastSample = input[len(input)-1]
	}

	return output
}

// Reset resets the resampler state
func (r *Resampler) Reset() {
	r.position = 0.0
	r.lastSample = 0
}

// UpdateInputRate updates the input sample rate and recalculates ratio
func (r *Resampler) UpdateInputRate(newRate int) {
	if newRate != r.inputRate {
		r.inputRate = newRate
		r.ratio = float64(newRate) / float64(r.outputRate)
		r.Reset()
	}
}
