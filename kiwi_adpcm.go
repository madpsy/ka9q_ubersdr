package main

import (
	"encoding/binary"
)

// IMA ADPCM encoder for KiwiSDR protocol
// Ported from Python implementation in clients/kiwi_bridge/ubersdr_kiwi_bridge.py

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

// IMAAdpcmEncoder encodes PCM to IMA ADPCM
type IMAAdpcmEncoder struct {
	index int
	prev  int
}

// NewIMAAdpcmEncoder creates a new IMA ADPCM encoder
func NewIMAAdpcmEncoder() *IMAAdpcmEncoder {
	return &IMAAdpcmEncoder{
		index: 0,
		prev:  0,
	}
}

// clamp restricts a value to a range
func clamp(x, xmin, xmax int) int {
	if x < xmin {
		return xmin
	}
	if x > xmax {
		return xmax
	}
	return x
}

// encodeSample encodes a single 16-bit PCM sample to 4-bit ADPCM
func (enc *IMAAdpcmEncoder) encodeSample(sample int) byte {
	step := stepSizeTable[enc.index]
	diff := sample - enc.prev

	code := byte(0)
	if diff < 0 {
		code = 8
		diff = -diff
	}

	if diff >= step {
		code |= 4
		diff -= step
	}
	if diff >= step/2 {
		code |= 2
		diff -= step / 2
	}
	if diff >= step/4 {
		code |= 1
	}

	// Update state using the same logic as decoder
	difference := step >> 3
	if code&1 != 0 {
		difference += step >> 2
	}
	if code&2 != 0 {
		difference += step >> 1
	}
	if code&4 != 0 {
		difference += step
	}
	if code&8 != 0 {
		difference = -difference
	}

	enc.prev = clamp(enc.prev+difference, -32768, 32767)
	enc.index = clamp(enc.index+indexAdjustTable[code], 0, len(stepSizeTable)-1)

	return code
}

// Encode encodes big-endian int16 PCM samples to IMA ADPCM
func (enc *IMAAdpcmEncoder) Encode(pcmData []byte) []byte {
	// Convert big-endian int16 bytes to samples
	numSamples := len(pcmData) / 2
	output := make([]byte, 0, numSamples/2)

	for i := 0; i < numSamples; i += 2 {
		// Read big-endian int16
		sample0 := int(int16(binary.BigEndian.Uint16(pcmData[i*2 : i*2+2])))

		var sample1 int
		if i+1 < numSamples {
			sample1 = int(int16(binary.BigEndian.Uint16(pcmData[(i+1)*2 : (i+1)*2+2])))
		} else {
			sample1 = sample0
		}

		// Encode both samples
		code0 := enc.encodeSample(sample0)
		code1 := enc.encodeSample(sample1)

		// Pack two 4-bit codes into one byte
		output = append(output, (code1<<4)|code0)
	}

	return output
}
