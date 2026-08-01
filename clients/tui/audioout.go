package main

import (
	"sync"
)

// AudioDevice is one selectable output.
type AudioDevice struct {
	ID      string
	Name    string
	Default bool
}

// Channel selects which side(s) of the stereo output the mono radio audio is
// routed to. Both is the default; left or right is useful when listening to two
// receivers at once, or on one earpiece.
type Channel int

const (
	ChannelBoth Channel = iota
	ChannelLeft
	ChannelRight
)

func (c Channel) String() string {
	switch c {
	case ChannelLeft:
		return "left"
	case ChannelRight:
		return "right"
	default:
		return "both"
	}
}

// mixer buffers decoded mono audio and serves interleaved stereo to whichever
// backend is playing, applying routing, mute and volume at read time so those
// controls take effect immediately rather than after the buffer drains.
type mixer struct {
	mu      sync.Mutex
	buf     []int16
	channel Channel
	muted   bool
	volume  float64

	// Bounded so a stalled or absent output device cannot grow the buffer
	// without limit; the oldest audio is dropped, which keeps latency low.
	maxSamples int

	dropped int
}

func newMixer() *mixer {
	return &mixer{
		volume:     1.0,
		maxSamples: opusOutputRate, // one second
	}
}

func (m *mixer) push(mono []int16) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.buf = append(m.buf, mono...)
	if excess := len(m.buf) - m.maxSamples; excess > 0 {
		m.buf = m.buf[excess:]
		m.dropped += excess
	}
}

// readStereo fills out with interleaved stereo frames, padding with silence
// when there is not enough audio buffered. Underruns must produce silence
// rather than a short read: backends treat a short read as end-of-stream.
func (m *mixer) readStereo(out []int16) int {
	m.mu.Lock()
	defer m.mu.Unlock()

	frames := len(out) / 2
	avail := len(m.buf)
	if avail > frames {
		avail = frames
	}

	gainL, gainR := 0.0, 0.0
	if !m.muted {
		switch m.channel {
		case ChannelLeft:
			gainL = m.volume
		case ChannelRight:
			gainR = m.volume
		default:
			gainL, gainR = m.volume, m.volume
		}
	}

	for i := 0; i < avail; i++ {
		s := float64(m.buf[i])
		out[i*2] = clampSample(s * gainL)
		out[i*2+1] = clampSample(s * gainR)
	}
	for i := avail; i < frames; i++ {
		out[i*2], out[i*2+1] = 0, 0
	}

	m.buf = m.buf[avail:]
	return frames * 2
}

func clampSample(v float64) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}

func (m *mixer) setChannel(c Channel) {
	m.mu.Lock()
	m.channel = c
	m.mu.Unlock()
}

func (m *mixer) setMuted(muted bool) {
	m.mu.Lock()
	m.muted = muted
	// Drop what is buffered so unmuting resumes at live audio instead of
	// replaying whatever accumulated while silent.
	if muted {
		m.buf = m.buf[:0]
	}
	m.mu.Unlock()
}

func (m *mixer) setVolume(v float64) {
	if v < 0 {
		v = 0
	}
	if v > 4 {
		v = 4
	}
	m.mu.Lock()
	m.volume = v
	m.mu.Unlock()
}

func (m *mixer) stats() (buffered, dropped int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.buf), m.dropped
}

// AudioOutput owns the mixer and the platform backend, and can switch device
// without disturbing the decode path.
type AudioOutput struct {
	mix *mixer

	mu       sync.Mutex
	backend  audioBackend
	deviceID string
	lastErr  error
}

// audioBackend is the platform-specific player. Implementations live in
// audioout_linux.go (PulseAudio) and audioout_other.go (oto); both are pure Go
// so CGO_ENABLED=0 cross-compilation keeps working.
type audioBackend interface {
	Close() error
}

func NewAudioOutput() *AudioOutput {
	return &AudioOutput{mix: newMixer()}
}

// Start opens the given device, or the system default when deviceID is empty.
func (o *AudioOutput) Start(deviceID string) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	if o.backend != nil {
		o.backend.Close()
		o.backend = nil
	}

	b, err := openBackend(deviceID, o.mix)
	if err != nil {
		o.lastErr = err
		return err
	}
	o.backend, o.deviceID, o.lastErr = b, deviceID, nil
	return nil
}

func (o *AudioOutput) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.backend != nil {
		o.backend.Close()
		o.backend = nil
	}
}

func (o *AudioOutput) Push(mono []int16)               { o.mix.push(mono) }
func (o *AudioOutput) SetChannel(c Channel)            { o.mix.setChannel(c) }
func (o *AudioOutput) SetMuted(m bool)                 { o.mix.setMuted(m) }
func (o *AudioOutput) SetVolume(v float64)             { o.mix.setVolume(v) }
func (o *AudioOutput) Stats() (int, int)               { return o.mix.stats() }
func (o *AudioOutput) Devices() ([]AudioDevice, error) { return listDevices() }

func (o *AudioOutput) DeviceID() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.deviceID
}

func (o *AudioOutput) Err() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastErr
}

func (o *AudioOutput) Running() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.backend != nil
}
