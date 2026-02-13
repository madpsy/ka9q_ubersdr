package sstv

import (
	"fmt"
	"sync"
	"time"
)

/*
 * PCM Buffer Management
 * Based on slowrx's sliding window approach (pcm.c)
 *
 * slowrx uses a sliding window buffer where:
 * - Buffer is fixed size (BUFLEN = 4096)
 * - WindowPtr starts at BUFLEN/2 (middle of buffer)
 * - When samples are read, buffer shifts left and WindowPtr moves back
 * - This keeps WindowPtr relatively stable in the middle
 *
 * This is critical for VIS detection which needs a stable reference point
 * for the FFT window: Buffer[WindowPtr + i - samps10ms]
 */

// SlidingPCMBuffer implements slowrx's sliding window buffer approach
type SlidingPCMBuffer struct {
	buffer    []int16
	size      int
	windowPtr int // Stable position in middle of buffer (like slowrx)
	fillPos   int // Current fill position during initial fill
	mu        sync.Mutex
}

// NewSlidingPCMBuffer creates a new sliding window PCM buffer
func NewSlidingPCMBuffer(size int) *SlidingPCMBuffer {
	buf := &SlidingPCMBuffer{
		buffer:    make([]int16, size),
		size:      size,
		windowPtr: 0, // Will be set to size/2 on first fill
	}
	return buf
}

// Write adds samples to the buffer (shifts buffer left, adds at end)
// This matches slowrx's readPcm() behavior
func (b *SlidingPCMBuffer) Write(samples []int16) {
	b.mu.Lock()
	defer b.mu.Unlock()

	numSamples := len(samples)

	if b.windowPtr == 0 {
		// First fill - accumulate samples until buffer is full
		// This matches slowrx behavior: fill entire buffer, then set WindowPtr to middle
		for i := 0; i < numSamples && b.fillPos < b.size; i++ {
			b.buffer[b.fillPos] = samples[i]
			b.fillPos++
		}

		// Set windowPtr to middle once buffer is full (like slowrx)
		if b.fillPos >= b.size {
			b.windowPtr = b.size / 2
		}
	} else {
		// Shift buffer left by numSamples
		copy(b.buffer, b.buffer[numSamples:])

		// Add new samples at end
		startIdx := b.size - numSamples
		for i := 0; i < numSamples && startIdx+i < b.size; i++ {
			b.buffer[startIdx+i] = samples[i]
		}

		// Move WindowPtr back (like slowrx line 61)
		b.windowPtr -= numSamples
		// Keep windowPtr at a safe minimum to allow backwards reads
		// VIS detection needs to read back ~240 samples from windowPtr
		if b.windowPtr < 512 {
			b.windowPtr = 512
		}
	}
}

// GetWindow returns samples centered at WindowPtr
// offset: relative to WindowPtr (e.g., -441 to start 441 samples before WindowPtr)
// length: number of samples to return
// This matches slowrx: Buffer[WindowPtr + i + offset]
func (b *SlidingPCMBuffer) GetWindow(offset, length int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	startPos := b.windowPtr + offset
	if startPos < 0 || startPos+length > b.size {
		return nil, fmt.Errorf("window out of bounds: windowPtr=%d, offset=%d, length=%d, size=%d",
			b.windowPtr, offset, length, b.size)
	}

	result := make([]int16, length)
	copy(result, b.buffer[startPos:startPos+length])

	return result, nil
}

// AdvanceWindow moves the WindowPtr forward (after consuming samples)
// This is called after reading samples to advance the window
func (b *SlidingPCMBuffer) AdvanceWindow(numSamples int) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.windowPtr += numSamples
}

// GetWindowPtr returns the current window pointer position
func (b *SlidingPCMBuffer) GetWindowPtr() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.windowPtr
}

// Available returns how many samples are available after WindowPtr (non-blocking)
func (b *SlidingPCMBuffer) Available() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.size - b.windowPtr
}

// EnsureAvailable blocks until at least minSamples are available or timeout occurs
// This matches KiwiSDR's pcm_copy() blocking behavior (sstv_pcm.cpp:51-54)
// Returns true if samples available, false if timeout
func (b *SlidingPCMBuffer) EnsureAvailable(minSamples int) bool {
	waitCount := 0
	maxWait := 500 // 5 seconds timeout (500 * 10ms)

	for b.Available() < minSamples {
		time.Sleep(10 * time.Millisecond)
		waitCount++

		if waitCount >= maxWait {
			return false // Timeout - audio stream likely ended
		}
	}

	return true
}

// Reset clears the buffer
func (b *SlidingPCMBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()

	for i := range b.buffer {
		b.buffer[i] = 0
	}
	b.windowPtr = 0
	b.fillPos = 0
}

// CircularPCMBuffer is kept for backward compatibility but deprecated
type CircularPCMBuffer = SlidingPCMBuffer

// NewCircularPCMBuffer creates a new buffer (now uses sliding window approach)
func NewCircularPCMBuffer(size int) *CircularPCMBuffer {
	return NewSlidingPCMBuffer(size)
}

// Read reads and consumes numSamples, advancing the window
func (b *SlidingPCMBuffer) Read(numSamples int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.windowPtr+numSamples > b.size {
		return nil, fmt.Errorf("not enough samples: windowPtr=%d, need=%d, size=%d",
			b.windowPtr, numSamples, b.size)
	}

	result := make([]int16, numSamples)
	copy(result, b.buffer[b.windowPtr:b.windowPtr+numSamples])

	b.windowPtr += numSamples

	return result, nil
}

// GetWindowAbsolute is deprecated - use GetWindow instead
func (b *SlidingPCMBuffer) GetWindowAbsolute(offset, length int) ([]int16, error) {
	// Convert absolute offset to relative offset from windowPtr
	// This is a compatibility shim
	b.mu.Lock()
	relativeOffset := offset - b.windowPtr
	b.mu.Unlock()

	return b.GetWindow(relativeOffset, length)
}
