package sstv

import (
	"fmt"
	"sync"
	"time"
)

/*
 * PCM Buffer Management
 * Sliding buffer implementation matching slowrx's approach exactly
 *
 * Key characteristics:
 * - Fixed-size buffer with backward shifting (like slowrx pcm.c)
 * - WindowPtr stays in stable range (never wraps)
 * - When buffer fills, contents shift backward and WindowPtr moves back
 * - Maintains stable position tracking for video demodulation
 *
 * Buffer size calculation at 12kHz:
 * - Longest mode: PD-290 = 937.28ms × 616 lines = 577.36 seconds
 * - At 12kHz: 577.36 × 12000 = 6,928,320 samples (~6.9M)
 * - Use 8M samples (16MB) to be safe with margin for all modes
 */

// SlidingPCMBuffer implements slowrx's sliding buffer for SSTV decoding
// Buffer contents shift backward as new samples arrive, keeping WindowPtr stable
type SlidingPCMBuffer struct {
	buffer    []int16
	size      int
	windowPtr int // Current read position (stays in stable range)
	writePos  int // Always at buffer end (size) after initial fill
	fillPos   int // Used during initial fill only
	mu        sync.Mutex
}

// NewSlidingPCMBuffer creates a new sliding PCM buffer
// Size is automatically set large enough for any SSTV mode at 12kHz
func NewSlidingPCMBuffer(requestedSize int) *SlidingPCMBuffer {
	// Use 8M samples (16MB) to handle longest modes at 12kHz
	// PD-290 at 12kHz needs ~6.9M samples, so 8M provides comfortable margin
	minSize := 8 * 1024 * 1024 // 8M samples = 16MB
	if requestedSize > minSize {
		minSize = requestedSize
	}

	buf := &SlidingPCMBuffer{
		buffer:    make([]int16, minSize),
		size:      minSize,
		windowPtr: 0, // Will be set after minimal initial fill
		writePos:  0,
	}
	return buf
}

// Write adds samples to the buffer using slowrx's sliding buffer approach
// This matches slowrx's readPcm() behavior exactly (pcm.c:19-64)
func (b *SlidingPCMBuffer) Write(samples []int16) {
	b.mu.Lock()
	defer b.mu.Unlock()

	numSamples := len(samples)

	if b.windowPtr == 0 {
		// First fill - fill entire buffer like slowrx (pcm.c:50-54)
		for i := 0; i < numSamples && b.fillPos < b.size; i++ {
			b.buffer[b.fillPos] = samples[i]
			b.fillPos++
		}

		// Set windowPtr to middle once buffer is filled (pcm.c:54)
		if b.fillPos >= b.size {
			b.windowPtr = b.size / 2
			b.writePos = b.size
		}
	} else {
		// Normal operation: shift buffer backward and add new samples at end
		// This matches slowrx pcm.c:57-61 exactly

		// Shift buffer contents backward (pcm.c:58)
		copy(b.buffer[0:b.size-numSamples], b.buffer[numSamples:b.size])

		// Add new samples at end (pcm.c:59)
		copy(b.buffer[b.size-numSamples:b.size], samples[0:numSamples])

		// Move WindowPtr back to compensate for shift (pcm.c:61)
		b.windowPtr -= numSamples

		// Prevent WindowPtr from going negative or too low
		if b.windowPtr < 512 {
			b.windowPtr = 512
		}
	}
}

// GetWindow returns samples centered at WindowPtr
// offset: relative to WindowPtr (e.g., -441 to start 441 samples before WindowPtr)
// length: number of samples to return
// This matches slowrx: Buffer[WindowPtr + i + offset] (no wrapping in sliding buffer)
func (b *SlidingPCMBuffer) GetWindow(offset, length int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	result := make([]int16, length)
	for i := 0; i < length; i++ {
		// Calculate position (no wrapping in sliding buffer)
		pos := b.windowPtr + offset + i

		// Bounds check
		if pos < 0 || pos >= b.size {
			// Return error if out of bounds
			return nil, fmt.Errorf("window read out of bounds: pos=%d, size=%d", pos, b.size)
		}

		result[i] = b.buffer[pos]
	}

	return result, nil
}

// AdvanceWindow moves the WindowPtr forward (after consuming samples)
// This is called after reading samples to advance the window
// In sliding buffer, WindowPtr just advances (no wrapping needed)
func (b *SlidingPCMBuffer) AdvanceWindow(numSamples int) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.windowPtr += numSamples

	// WindowPtr should never exceed buffer size due to Write() shifting
	// But add safety check
	if b.windowPtr > b.size-1024 {
		// This shouldn't happen if Write() is called frequently enough
		// But if it does, clamp to safe position
		b.windowPtr = b.size - 1024
	}
}

// GetWindowPtr returns the current window pointer position
func (b *SlidingPCMBuffer) GetWindowPtr() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.windowPtr
}

// Available returns how many samples are available after WindowPtr (non-blocking)
// In a sliding buffer, this is simply writePos - windowPtr
func (b *SlidingPCMBuffer) Available() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	// In sliding buffer, writePos is always at buffer end (size)
	// Available samples = size - windowPtr
	return b.size - b.windowPtr
}

// EnsureAvailable blocks until at least minSamples are available or timeout occurs
// This matches KiwiSDR's pcm_copy() blocking behavior (sstv_pcm.cpp:51-54)
// Returns true if samples available, false if timeout
// NOTE: This is a helper for EnsureWindowAvailable, not used directly by video decoder
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

// EnsureWindowAvailable blocks until the window has enough samples ahead
// This is used by video decoder to wait for samples without causing timing desync
func (b *SlidingPCMBuffer) EnsureWindowAvailable(minSamples int) bool {
	waitCount := 0
	maxWait := 500 // 5 seconds timeout

	for {
		// Check available samples (size - windowPtr in sliding buffer)
		available := b.Available()

		if available >= minSamples {
			return true
		}

		// Sleep to allow main loop to feed more samples
		time.Sleep(10 * time.Millisecond)
		waitCount++

		if waitCount >= maxWait {
			return false
		}
	}
}

// Reset clears the buffer
func (b *SlidingPCMBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()

	for i := range b.buffer {
		b.buffer[i] = 0
	}
	b.windowPtr = 0
	b.writePos = 0
	b.fillPos = 0
}

// CircularPCMBuffer is kept for backward compatibility but deprecated
type CircularPCMBuffer = SlidingPCMBuffer

// NewCircularPCMBuffer creates a new buffer (now uses sliding buffer approach)
func NewCircularPCMBuffer(size int) *CircularPCMBuffer {
	return NewSlidingPCMBuffer(size)
}

// Read reads and consumes numSamples, advancing the window
func (b *SlidingPCMBuffer) Read(numSamples int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Calculate available samples (size - windowPtr in sliding buffer)
	available := b.size - b.windowPtr

	if available < numSamples {
		return nil, fmt.Errorf("not enough samples: available=%d, need=%d",
			available, numSamples)
	}

	result := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		result[i] = b.buffer[b.windowPtr]
		b.windowPtr++
	}

	return result, nil
}

// GetWindowAbsolute is deprecated - use GetWindow instead
func (b *SlidingPCMBuffer) GetWindowAbsolute(offset, length int) ([]int16, error) {
	// Convert absolute offset to relative offset from windowPtr
	// This is a compatibility shim
	return b.GetWindow(offset-b.windowPtr, length)
}
