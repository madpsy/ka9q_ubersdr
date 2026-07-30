package signalling

import "math"

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
	output := make([]int16, 0, int(math.Ceil(float64(len(samples)-1)/step)))
	for r.position < float64(len(samples)-1) {
		index := int(r.position)
		fraction := r.position - float64(index)
		value := float64(samples[index]) + (float64(samples[index+1])-float64(samples[index]))*fraction
		output = append(output, int16(math.Round(value)))
		r.position += step
	}
	r.position -= float64(len(samples) - 1)
	r.previous = samples[len(samples)-1]
	r.havePrev = true
	return output
}
