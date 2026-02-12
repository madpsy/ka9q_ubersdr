package sstv

import (
	"fmt"
	"sync"
)

/*
 * Circular PCM Buffer
 * Matches KiwiSDR's PCM buffer management (sstv_pcm.cpp)
 *
 * Copyright (c) 2026, UberSDR project
 */

// CircularPCMBuffer implements a circular buffer for PCM audio samples
// This matches KiwiSDR's approach with a fixed-size buffer and sliding window
type CircularPCMBuffer struct {
	buffer   []int16
	size     int
	writePtr int // Where new samples are written
	readPtr  int // Where samples are read from (WindowPtr in KiwiSDR)
	filled   int // How many samples have been written
	mu       sync.Mutex
}

// NewCircularPCMBuffer creates a new circular PCM buffer
// size should be 4096 to match KiwiSDR's PCM_BUFLEN
func NewCircularPCMBuffer(size int) *CircularPCMBuffer {
	return &CircularPCMBuffer{
		buffer:   make([]int16, size),
		size:     size,
		writePtr: 0,
		readPtr:  0,
		filled:   0,
	}
}

// Write adds samples to the buffer
// This is called continuously as audio arrives
func (b *CircularPCMBuffer) Write(samples []int16) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, sample := range samples {
		b.buffer[b.writePtr] = sample
		b.writePtr = (b.writePtr + 1) % b.size

		if b.filled < b.size {
			b.filled++
		} else {
			// Buffer is full, advance read pointer to maintain window
			b.readPtr = (b.readPtr + 1) % b.size
		}
	}
}

// Read reads and consumes numSamples from the buffer
// This advances the read pointer (like KiwiSDR's sstv_pcm_read)
func (b *CircularPCMBuffer) Read(numSamples int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.filled < numSamples {
		return nil, fmt.Errorf("not enough samples: have %d, need %d", b.filled, numSamples)
	}

	result := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		result[i] = b.buffer[b.readPtr]
		b.readPtr = (b.readPtr + 1) % b.size
		b.filled--
	}

	return result, nil
}

// GetWindow returns a window of samples without consuming them
// offset: samples back from current read position (negative = look back)
// length: number of samples to return
//
// This matches KiwiSDR's approach:
//
//	e->pcm.Buffer[e->pcm.WindowPtr + i - samps_10ms]
//
// where WindowPtr is the current position and we look back samps_10ms
func (b *CircularPCMBuffer) GetWindow(offset, length int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Calculate absolute position in buffer
	// For backward looking: offset is negative, so we subtract from readPtr
	startPos := b.readPtr + offset
	if startPos < 0 {
		startPos += b.size
	}
	startPos = startPos % b.size

	// Check if we have enough data
	requiredSamples := length
	if offset < 0 {
		requiredSamples = length - offset // Need more if looking back
	}
	if b.filled < requiredSamples {
		return nil, fmt.Errorf("not enough samples for window: have %d, need %d", b.filled, requiredSamples)
	}

	result := make([]int16, length)
	pos := startPos
	for i := 0; i < length; i++ {
		result[i] = b.buffer[pos]
		pos = (pos + 1) % b.size
	}

	return result, nil
}

// GetWindowAbsolute returns samples at an absolute position relative to readPtr
// This is used for the FFT window in VIS detection
// KiwiSDR: e->fft.in2k[i] = e->pcm.Buffer[e->pcm.WindowPtr + i - samps_10ms]
func (b *CircularPCMBuffer) GetWindowAbsolute(startOffset, length int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// For negative offsets, we need to ensure we have enough historical data
	// For positive offsets, we need to ensure we have enough future data
	var requiredSamples int
	if startOffset < 0 {
		// Looking back: need abs(startOffset) + length samples
		requiredSamples = -startOffset + length
	} else {
		// Looking forward: need startOffset + length samples
		requiredSamples = startOffset + length
	}

	if b.filled < requiredSamples {
		return nil, fmt.Errorf("not enough samples for window: have %d, need %d (offset=%d, length=%d)",
			b.filled, requiredSamples, startOffset, length)
	}

	// Calculate starting position with proper negative offset handling
	// readPtr points to the oldest sample in the buffer
	// For negative offset, we go back from readPtr
	// For positive offset, we go forward from readPtr
	pos := b.readPtr + startOffset

	// Handle negative positions properly
	if pos < 0 {
		// Go back from the end of the buffer
		pos = ((pos % b.size) + b.size) % b.size
	} else {
		pos = pos % b.size
	}

	result := make([]int16, length)
	for i := 0; i < length; i++ {
		result[i] = b.buffer[pos]
		pos = (pos + 1) % b.size
	}

	return result, nil
}

// Advance moves the read pointer forward by numSamples
// This is used after reading samples to advance the window
func (b *CircularPCMBuffer) Advance(numSamples int) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.filled < numSamples {
		return fmt.Errorf("cannot advance: not enough samples")
	}

	b.readPtr = (b.readPtr + numSamples) % b.size
	b.filled -= numSamples

	return nil
}

// Available returns the number of samples available in the buffer
func (b *CircularPCMBuffer) Available() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.filled
}

// Reset clears the buffer
func (b *CircularPCMBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.writePtr = 0
	b.readPtr = 0
	b.filled = 0
}

// StreamingPCMReader implements the PCMReader interface using a circular buffer
// This provides the streaming interface that VIS detection expects
type StreamingPCMReader struct {
	buffer      *CircularPCMBuffer
	windowPtr   int // Current position in buffer (like KiwiSDR's WindowPtr)
	samps10ms   int
	initialized bool
}

// NewStreamingPCMReader creates a new streaming PCM reader
func NewStreamingPCMReader(buffer *CircularPCMBuffer, sampleRate float64) *StreamingPCMReader {
	return &StreamingPCMReader{
		buffer:      buffer,
		windowPtr:   0,
		samps10ms:   int(sampleRate * 10e-3),
		initialized: false,
	}
}

// Read implements PCMReader.Read
// This matches KiwiSDR's sstv_pcm_read behavior:
// - On first call, fill buffer and set WindowPtr to middle
// - On subsequent calls, shift buffer and advance WindowPtr
func (r *StreamingPCMReader) Read(numSamples int) ([]int16, error) {
	if !r.initialized {
		// Wait for buffer to fill (like KiwiSDR's initial fill)
		for r.buffer.Available() < r.buffer.size {
			// In real implementation, this would block or return error
			return nil, fmt.Errorf("buffer not yet filled")
		}
		// Set WindowPtr to middle of buffer (like KiwiSDR: PCM_BUFLEN/2)
		r.windowPtr = r.buffer.size / 2
		r.initialized = true
	}

	// Read samples (this advances the buffer)
	samples, err := r.buffer.Read(numSamples)
	if err != nil {
		return nil, err
	}

	// WindowPtr effectively moves back relative to new data
	// (In KiwiSDR, buffer shifts left and WindowPtr stays relative)
	r.windowPtr -= numSamples
	if r.windowPtr < 0 {
		r.windowPtr = 0
	}

	return samples, nil
}

// GetWindowForFFT returns the samples for FFT analysis
// This matches KiwiSDR: e->pcm.Buffer[e->pcm.WindowPtr + i - samps_10ms]
func (r *StreamingPCMReader) GetWindowForFFT(samps20ms int) ([]int16, error) {
	// Get window starting at (WindowPtr - samps10ms) for length samps20ms
	startOffset := r.windowPtr - r.samps10ms
	return r.buffer.GetWindowAbsolute(startOffset, samps20ms)
}
