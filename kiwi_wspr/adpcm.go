package main

// IMA ADPCM decoder for KiwiSDR audio compression
// Based on the Python implementation in kiwi/client.py

var stepSizeTable = []int{
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34,
	37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
	157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
	544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
	1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
	4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
	11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
	27086, 29794, 32767,
}

var indexAdjustTable = []int{
	-1, -1, -1, -1, // +0 - +3, decrease the step size
	2, 4, 6, 8, // +4 - +7, increase the step size
	-1, -1, -1, -1, // -0 - -3, decrease the step size
	2, 4, 6, 8, // -4 - -7, increase the step size
}

// IMAAdpcmDecoder decodes IMA ADPCM compressed audio
type IMAAdpcmDecoder struct {
	index int
	prev  int
}

// NewIMAAdpcmDecoder creates a new IMA ADPCM decoder
func NewIMAAdpcmDecoder() *IMAAdpcmDecoder {
	return &IMAAdpcmDecoder{
		index: 0,
		prev:  0,
	}
}

// Preset sets the decoder state
func (d *IMAAdpcmDecoder) Preset(index, prev int) {
	d.index = index
	d.prev = prev
}

// clamp restricts a value to a range
func clamp(x, min, max int) int {
	if x < min {
		return min
	}
	if x > max {
		return max
	}
	return x
}

// decodeSample decodes a single 4-bit ADPCM sample
func (d *IMAAdpcmDecoder) decodeSample(code int) int16 {
	step := stepSizeTable[d.index]
	d.index = clamp(d.index+indexAdjustTable[code], 0, len(stepSizeTable)-1)

	difference := step >> 3
	if (code & 1) != 0 {
		difference += step >> 2
	}
	if (code & 2) != 0 {
		difference += step >> 1
	}
	if (code & 4) != 0 {
		difference += step
	}
	if (code & 8) != 0 {
		difference = -difference
	}

	sample := clamp(d.prev+difference, -32768, 32767)
	d.prev = sample
	return int16(sample)
}

// Decode decodes a buffer of ADPCM data
func (d *IMAAdpcmDecoder) Decode(data []byte) []int16 {
	samples := make([]int16, 0, len(data)*2)

	for _, b := range data {
		// Each byte contains two 4-bit samples
		sample0 := d.decodeSample(int(b & 0x0F))
		sample1 := d.decodeSample(int(b >> 4))
		samples = append(samples, sample0, sample1)
	}

	return samples
}
