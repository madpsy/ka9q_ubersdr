package digitalvoice

import "math"

// linearResampler is a small stateful mono PCM resampler. UberSDR's NFM
// sessions normally provide 24 kHz audio, while DSD-FME's discriminator input
// operates at 48 kHz. Keeping phase and the last sample across packet
// boundaries avoids discontinuities in the symbol stream.
type linearResampler struct {
	inputRate  int
	outputRate int
	position   float64
	previous   int16
	havePrev   bool
}

func newLinearResampler(inputRate, outputRate int) *linearResampler {
	return &linearResampler{inputRate: inputRate, outputRate: outputRate}
}

func (r *linearResampler) process(input []int16) []int16 {
	if len(input) == 0 {
		return nil
	}
	if r.inputRate == r.outputRate {
		return append([]int16(nil), input...)
	}

	samples := input
	if r.havePrev {
		samples = make([]int16, 0, len(input)+1)
		samples = append(samples, r.previous)
		samples = append(samples, input...)
	}
	if len(samples) < 2 {
		r.previous = samples[len(samples)-1]
		r.havePrev = true
		return nil
	}

	step := float64(r.inputRate) / float64(r.outputRate)
	estimated := int(math.Ceil(float64(len(samples)-1) / step))
	output := make([]int16, 0, estimated)
	for r.position < float64(len(samples)-1) {
		index := int(r.position)
		fraction := r.position - float64(index)
		left := float64(samples[index])
		right := float64(samples[index+1])
		value := left + (right-left)*fraction
		if value > math.MaxInt16 {
			value = math.MaxInt16
		} else if value < math.MinInt16 {
			value = math.MinInt16
		}
		output = append(output, int16(math.Round(value)))
		r.position += step
	}

	r.position -= float64(len(samples) - 1)
	r.previous = samples[len(samples)-1]
	r.havePrev = true
	return output
}
