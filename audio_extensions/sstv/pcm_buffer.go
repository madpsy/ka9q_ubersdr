package sstv

import (
	"fmt"
	"sync"
	"time"
)

/*
 * PCM Buffer Management
 * True circular buffer implementation matching slowrx's approach
 *
 * Key differences from previous sliding buffer:
 * - Fixed-size circular buffer (no shifting)
 * - WindowPtr wraps around at buffer end
 * - WritePos tracks where new samples are written
 * - Maintains stable position tracking for video demodulation
 *
 * Buffer size calculation at 12kHz:
 * - Longest mode: PD-290 = 937.28ms × 616 lines = 577.36 seconds
 * - At 12kHz: 577.36 × 12000 = 6,928,320 samples (~6.9M)
 * - Use 8M samples (16MB) to be safe with margin for all modes
 */

// SlidingPCMBuffer implements a true circular buffer for SSTV decoding
// Despite the name "Sliding", this is now a circular buffer for compatibility
type SlidingPCMBuffer struct {
	buffer    []int16
	size      int
	windowPtr int // Current read position (wraps at size)
	writePos  int // Current write position (wraps at size)
	fillPos   int // Used during initial fill only
	mu        sync.Mutex
}

// NewSlidingPCMBuffer creates a new circular PCM buffer
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
		windowPtr: 0, // Will be set to size/2 on first fill
		writePos:  0,
	}
	return buf
}

// Write adds samples to the buffer at writePos (circular)
// This matches slowrx's readPcm() behavior but with circular wrapping
func (b *SlidingPCMBuffer) Write(samples []int16) {
	b.mu.Lock()
	defer b.mu.Unlock()

	numSamples := len(samples)

	if b.windowPtr == 0 {
		// First fill - accumulate samples until buffer has enough data
		// This matches slowrx behavior: fill buffer, then set WindowPtr to middle
		for i := 0; i < numSamples && b.fillPos < b.size/2+1024; i++ {
			b.buffer[b.fillPos] = samples[i]
			b.fillPos++
		}

		// Set windowPtr to middle once we have enough data (like slowrx)
		if b.fillPos >= b.size/2 {
			b.windowPtr = b.size / 2
			b.writePos = b.fillPos
		}
	} else {
		// Normal operation: write samples circularly
		for _, sample := range samples {
			b.buffer[b.writePos] = sample
			b.writePos = (b.writePos + 1) % b.size // Wrap at end
		}
	}
}

// GetWindow returns samples centered at WindowPtr
// offset: relative to WindowPtr (e.g., -441 to start 441 samples before WindowPtr)
// length: number of samples to return
// This matches slowrx: Buffer[WindowPtr + i + offset] with circular wrapping
func (b *SlidingPCMBuffer) GetWindow(offset, length int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	result := make([]int16, length)
	for i := 0; i < length; i++ {
		// Calculate position with circular wrapping
		pos := b.windowPtr + offset + i
		// Handle negative offsets
		for pos < 0 {
			pos += b.size
		}
		// Wrap at buffer end
		pos = pos % b.size
		result[i] = b.buffer[pos]
	}

	return result, nil
}

// AdvanceWindow moves the WindowPtr forward (after consuming samples)
// This is called after reading samples to advance the window
// WindowPtr wraps circularly at buffer end
func (b *SlidingPCMBuffer) AdvanceWindow(numSamples int) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.windowPtr = (b.windowPtr + numSamples) % b.size
}

// GetWindowPtr returns the current window pointer position
func (b *SlidingPCMBuffer) GetWindowPtr() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.windowPtr
}

// Available returns how many samples are available after WindowPtr (non-blocking)
// In a circular buffer, this is the distance from windowPtr to writePos
func (b *SlidingPCMBuffer) Available() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.writePos >= b.windowPtr {
		return b.writePos - b.windowPtr
	}
	// Wrapped case
	return (b.size - b.windowPtr) + b.writePos
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
// The lock is held during the wait to prevent buffer shifts
func (b *SlidingPCMBuffer) EnsureWindowAvailable(minSamples int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	waitCount := 0
	maxWait := 500 // 5 seconds timeout

	for {
		// Calculate available samples (inline to avoid recursive lock)
		available := 0
		if b.writePos >= b.windowPtr {
			available = b.writePos - b.windowPtr
		} else {
			available = (b.size - b.windowPtr) + b.writePos
		}

		if available >= minSamples {
			break
		}

		// Release lock during sleep to allow main loop to feed
		b.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
		waitCount++
		b.mu.Lock()

		if waitCount >= maxWait {
			return false
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
	b.writePos = 0
	b.fillPos = 0
}

// CircularPCMBuffer is kept for backward compatibility but deprecated
type CircularPCMBuffer = SlidingPCMBuffer

// NewCircularPCMBuffer creates a new buffer (now uses circular buffer approach)
func NewCircularPCMBuffer(size int) *CircularPCMBuffer {
	return NewSlidingPCMBuffer(size)
}

// Read reads and consumes numSamples, advancing the window
func (b *SlidingPCMBuffer) Read(numSamples int) ([]int16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Calculate available samples (inline to avoid recursive lock)
	available := 0
	if b.writePos >= b.windowPtr {
		available = b.writePos - b.windowPtr
	} else {
		available = (b.size - b.windowPtr) + b.writePos
	}

	if available < numSamples {
		return nil, fmt.Errorf("not enough samples: available=%d, need=%d",
			available, numSamples)
	}

	result := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		result[i] = b.buffer[b.windowPtr]
		b.windowPtr = (b.windowPtr + 1) % b.size
	}

	return result, nil
}

// GetWindowAbsolute is deprecated - use GetWindow instead
func (b *SlidingPCMBuffer) GetWindowAbsolute(offset, length int) ([]int16, error) {
	// Convert absolute offset to relative offset from windowPtr
	// This is a compatibility shim
	return b.GetWindow(offset-b.windowPtr, length)
}
