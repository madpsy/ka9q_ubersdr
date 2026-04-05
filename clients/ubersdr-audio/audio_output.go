package main

// audio_output.go — shared ring-reader used by both the Windows WASAPI
// backend (audio_output_windows.go) and the oto fallback (audio_output_other.go).

import (
	"sync"
	"time"
)

// chunkDuration is the nominal duration of one Opus frame (20 ms).
const chunkDuration = 20 * time.Millisecond

// hardwareBufferDuration is the fixed delay added on top of the ring-buffer
// depth to account for the audio hardware/driver buffer.  oto's actual
// internal buffer on Linux (PulseAudio/ALSA) is typically 150–200 ms
// regardless of the BufferSize hint, so we use 200 ms here.
const hardwareBufferDuration = 200 * time.Millisecond

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

// ChunkMeta carries the signal-quality metadata that was embedded in the
// audio packet alongside the PCM data.
type ChunkMeta struct {
	BasebandPower float32
	NoiseDensity  float32
	DBFS          float32 // RMS level of the PCM chunk in dBFS
}

// pcmRingReader is an io.Reader backed by a channel of byte slices.
// oto (or the WASAPI render loop) calls Read() from its own goroutine;
// we feed it from the WebSocket goroutine via Push().
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

// Queued returns the number of chunks currently waiting in the ring buffer.
func (r *pcmRingReader) Queued() int {
	return len(r.ch)
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

// FireAfterDelay fires fn in a goroutine after the given delay.
// Used by both backends to delay bar callbacks to match playback time.
func FireAfterDelay(delay time.Duration, fn func()) {
	go func() {
		if delay > 0 {
			time.Sleep(delay)
		}
		fn()
	}()
}
