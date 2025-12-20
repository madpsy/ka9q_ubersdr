//go:build cgo
// +build cgo

package main

/*
#cgo pkg-config: samplerate
#include <stdlib.h>
#include <samplerate.h>
*/
import "C"
import (
	"fmt"
	"unsafe"
)

// LibsamplerateResampler provides high-quality resampling using libsamplerate
type LibsamplerateResampler struct {
	state      *C.SRC_STATE
	inputRate  int
	outputRate int
	ratio      float64
	channels   int
}

// NewLibsamplerateResampler creates a new libsamplerate-based resampler
// quality: 0 = SRC_SINC_BEST_QUALITY, 1 = SRC_SINC_MEDIUM_QUALITY, 2 = SRC_SINC_FASTEST, 3 = SRC_ZERO_ORDER_HOLD, 4 = SRC_LINEAR
func NewLibsamplerateResampler(inputRate, outputRate, channels int, quality int) (*LibsamplerateResampler, error) {
	ratio := float64(outputRate) / float64(inputRate)

	var err C.int
	state := C.src_new(C.int(quality), C.int(channels), &err)
	if state == nil {
		return nil, fmt.Errorf("failed to create libsamplerate state: %s", C.GoString(C.src_strerror(err)))
	}

	return &LibsamplerateResampler{
		state:      state,
		inputRate:  inputRate,
		outputRate: outputRate,
		ratio:      ratio,
		channels:   channels,
	}, nil
}

// Process resamples audio data
func (r *LibsamplerateResampler) Process(input []int16) []int16 {
	if len(input) == 0 {
		return []int16{}
	}

	// Convert int16 to float32 for libsamplerate
	inputFloat := make([]float32, len(input))
	for i, sample := range input {
		inputFloat[i] = float32(sample) / 32768.0
	}

	// Calculate output size
	outputSize := int(float64(len(inputFloat)) * r.ratio * 1.1) // Add 10% margin
	outputFloat := make([]float32, outputSize)

	// Allocate C memory for input and output to avoid Go pointer issues
	inputFrames := len(inputFloat) / r.channels
	outputFrames := len(outputFloat) / r.channels

	cInputData := (*C.float)(C.malloc(C.size_t(len(inputFloat)) * C.size_t(unsafe.Sizeof(C.float(0)))))
	if cInputData == nil {
		return []int16{}
	}
	defer C.free(unsafe.Pointer(cInputData))

	cOutputData := (*C.float)(C.malloc(C.size_t(len(outputFloat)) * C.size_t(unsafe.Sizeof(C.float(0)))))
	if cOutputData == nil {
		return []int16{}
	}
	defer C.free(unsafe.Pointer(cOutputData))

	// Copy input data to C memory (element by element due to type mismatch)
	inputSlice := unsafe.Slice(cInputData, len(inputFloat))
	for i, v := range inputFloat {
		inputSlice[i] = C.float(v)
	}

	// Setup SRC_DATA structure
	var srcData C.SRC_DATA
	srcData.data_in = cInputData
	srcData.input_frames = C.long(inputFrames)
	srcData.data_out = cOutputData
	srcData.output_frames = C.long(outputFrames)
	srcData.src_ratio = C.double(r.ratio)
	srcData.end_of_input = 0 // Continuous streaming

	// Process
	err := C.src_process(r.state, &srcData)
	if err != 0 {
		fmt.Printf("libsamplerate error: %s\n", C.GoString(C.src_strerror(err)))
		return []int16{}
	}

	// Copy output data from C memory and convert back to int16
	outputSamples := int(srcData.output_frames_gen) * r.channels
	outputSlice := unsafe.Slice(cOutputData, outputSamples)

	output := make([]int16, outputSamples)
	for i := 0; i < outputSamples; i++ {
		sample := float32(outputSlice[i]) * 32768.0
		if sample > 32767 {
			sample = 32767
		} else if sample < -32768 {
			sample = -32768
		}
		output[i] = int16(sample)
	}

	return output
}

// Reset clears the resampler state
func (r *LibsamplerateResampler) Reset() {
	if r.state != nil {
		C.src_reset(r.state)
	}
}

// Close frees the libsamplerate state
func (r *LibsamplerateResampler) Close() {
	if r.state != nil {
		C.src_delete(r.state)
		r.state = nil
	}
}

// GetLatency returns the latency in samples
func (r *LibsamplerateResampler) GetLatency() int {
	// libsamplerate has minimal latency (a few samples)
	return 10
}
