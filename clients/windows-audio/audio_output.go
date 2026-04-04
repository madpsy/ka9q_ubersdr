package main

// audio_output.go — shared ring-reader used by both the Windows WASAPI
// backend (audio_output_windows.go) and the oto fallback (audio_output_other.go).

import (
	"sync"
)

// ChannelMode controls which output channels receive audio.
const (
	ChannelModeBoth  = 0 // default — all device channels
	ChannelModeLeft  = 1 // only channel index 0
	ChannelModeRight = 2 // only channel index 1
)

// AudioDevice describes a system audio output device.
type AudioDevice struct {
	ID   string // platform-specific identifier
	Name string // human-readable name
}

// pcmRingReader is an io.Reader backed by a channel of int16 sample slices.
// oto (or the WASAPI render loop) calls Read() from its own goroutine;
// we feed it from the WebSocket goroutine.
type pcmRingReader struct {
	ch      chan []byte
	current []byte
	pos     int
	closed  bool
	mu      sync.Mutex
}

func newPCMRingReader(bufChunks int) *pcmRingReader {
	return &pcmRingReader{ch: make(chan []byte, bufChunks)}
}

// Push queues a chunk of little-endian int16 PCM bytes for playback.
func (r *pcmRingReader) Push(data []byte) {
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return
	}
	// Non-blocking: drop if buffer is full (prevents unbounded latency)
	select {
	case r.ch <- data:
	default:
	}
}

// Read implements io.Reader.
func (r *pcmRingReader) Read(buf []byte) (int, error) {
	written := 0
	for written < len(buf) {
		if r.current == nil || r.pos >= len(r.current) {
			select {
			case chunk, ok := <-r.ch:
				if !ok {
					for i := written; i < len(buf); i++ {
						buf[i] = 0
					}
					return len(buf), nil
				}
				r.current = chunk
				r.pos = 0
			default:
				// No data — output silence
				for i := written; i < len(buf); i++ {
					buf[i] = 0
				}
				return len(buf), nil
			}
		}
		n := copy(buf[written:], r.current[r.pos:])
		written += n
		r.pos += n
	}
	return written, nil
}

func (r *pcmRingReader) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.closed = true
		close(r.ch)
	}
}
