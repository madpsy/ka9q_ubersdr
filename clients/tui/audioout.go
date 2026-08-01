package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
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

	// Jitter buffer. Audio arrives at exactly real time, so without a cushion
	// the buffer sits near empty and ordinary network and scheduling jitter
	// empties it between callbacks, inserting silence — heard as a stutter.
	// While priming, silence is played and nothing is consumed, letting the
	// buffer fill to targetSamples first.
	targetSamples int
	priming       bool

	dropped   int
	underruns int // reads that ran out of buffered audio and padded with silence
}

// targetLatency is how much audio to hold before playing. It has to cover the
// worst inter-packet gap comfortably: packets are nominally 20 ms apart, with a
// measured 99th percentile near 24 ms and occasional 50 ms outliers.
const targetLatency = 120 * time.Millisecond

func newMixer() *mixer {
	return &mixer{
		volume:        1.0,
		maxSamples:    opusOutputRate, // one second
		targetSamples: int(float64(opusOutputRate) * targetLatency.Seconds()),
		priming:       true,
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

	// Hold everything back until the cushion has built up. Starting early only
	// means underrunning again a few milliseconds later.
	if m.priming {
		if len(m.buf) < m.targetSamples {
			for i := 0; i < frames; i++ {
				out[i*2], out[i*2+1] = 0, 0
			}
			return frames * 2
		}
		m.priming = false
	}

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
	if avail < frames {
		// Ran dry. Rebuild the cushion rather than limping along underrunning
		// on every callback, which is what turns one gap into a stutter.
		m.underruns++
		m.priming = true
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
	// replaying whatever accumulated while silent, and rebuild the cushion.
	if muted {
		m.buf = m.buf[:0]
		m.priming = true
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

func (m *mixer) stats() (buffered, dropped, underruns int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.buf), m.dropped, m.underruns
}

// Stdout is the second output, always available on any platform: the decoded
// audio as raw PCM, for piping into anything that reads a stream.
//
//	ubersdr-tui -server … -stdout | aplay -f S16_LE -r 48000 -c 1
//
// It carries the demodulated audio as it arrives — 48 kHz mono, signed 16-bit
// little-endian — and deliberately not what the speakers get: volume, mute and
// channel routing belong to the sound device, and applying them here would
// quietly ruin a recording or halve a pipe when the routing is set to one side.
//
// Nothing about the display is at risk from this. tcell drives /dev/tty rather
// than stdout, so the two never meet; the only real hazard is a stdout that is
// still a terminal, which stdoutIsRedirected rules out before anything opens.
const (
	stdoutSampleRate = opusOutputRate
	stdoutChannels   = 1
	stdoutFormat     = "S16_LE"
)

// StdoutMode is what the second output carries: nothing, headerless PCM, or the
// same samples behind a WAV header.
//
// Raw is what a pipe wants — the reader is told the format on its own command
// line. WAV is what a *file* wants: `> radio.wav` is otherwise a file nothing
// will open, because no player infers 48 kHz mono S16_LE from an extension.
type StdoutMode int

const (
	StdoutOff StdoutMode = iota
	StdoutRaw
	StdoutWAV
)

func (m StdoutMode) String() string {
	switch m {
	case StdoutRaw:
		return "raw"
	case StdoutWAV:
		return "wav"
	default:
		return "off"
	}
}

// Label describes the stream in full, for the panel.
func (m StdoutMode) Label() string {
	switch m {
	case StdoutRaw:
		return fmt.Sprintf("on   raw %s %d kHz mono", stdoutFormat, stdoutSampleRate/1000)
	case StdoutWAV:
		return fmt.Sprintf("on   WAV, %s %d kHz mono", stdoutFormat, stdoutSampleRate/1000)
	default:
		return "off"
	}
}

// wavHeaderLen is the canonical PCM header: RIFF, fmt and data chunks.
const wavHeaderLen = 44

// streamingSize is the size written into a header for a stream whose length is
// not knowable yet. Players read to end of file rather than trusting it, which
// is what makes a live WAV pipe work at all; sox says "premature EOF" and
// converts the lot, ffmpeg and VLC say nothing. When stdout turns out to be a
// regular file the real sizes are patched in on close, so a captured file ends
// up exactly right.
const streamingSize = 0xFFFFFFFF

// writeWAVHeader emits a 44-byte PCM header for the format this client sends.
func writeWAVHeader(w io.Writer, dataBytes uint32) error {
	var h [wavHeaderLen]byte
	le := binary.LittleEndian

	copy(h[0:], "RIFF")
	if dataBytes == streamingSize {
		le.PutUint32(h[4:], streamingSize)
	} else {
		le.PutUint32(h[4:], 36+dataBytes)
	}
	copy(h[8:], "WAVE")

	copy(h[12:], "fmt ")
	le.PutUint32(h[16:], 16) // PCM fmt chunk length
	le.PutUint16(h[20:], 1)  // PCM, uncompressed
	le.PutUint16(h[22:], stdoutChannels)
	le.PutUint32(h[24:], stdoutSampleRate)
	le.PutUint32(h[28:], stdoutSampleRate*stdoutChannels*2) // bytes per second
	le.PutUint16(h[32:], stdoutChannels*2)                  // block align
	le.PutUint16(h[34:], 16)                                // bits per sample

	copy(h[36:], "data")
	le.PutUint32(h[40:], dataBytes)

	_, err := w.Write(h[:])
	return err
}

// stdoutIsTerminal reports whether stdout is still the user's terminal, which
// is the one place this audio must never go: it would fill the screen with
// binary noise.
//
// This asks the terminal itself rather than inspecting the file mode. The
// character-device shortcut that usually stands in for it is wrong in both
// directions here — it refuses `> /dev/null`, which is a perfectly good place
// to throw audio, and it would accept any other device file.
func stdoutIsTerminal() bool {
	return term.IsTerminal(int(os.Stdout.Fd()))
}

// pcmWriter streams mono samples to an io.Writer from its own goroutine.
//
// The write must never happen on the caller's goroutine: a pipe whose reader
// has stalled blocks, and the caller is the event loop. Samples are queued
// instead, and the queue drops the oldest when it fills — the same bargain the
// mixer makes, for the same reason.
type pcmWriter struct {
	queue chan []int16
	done  chan struct{}
	mode  StdoutMode

	mu      sync.Mutex
	dropped int
	written int
	err     error
}

func newPCMWriter(w io.Writer, mode StdoutMode) *pcmWriter {
	p := &pcmWriter{
		// A second of audio at 20 ms a packet, so a brief stall in whatever is
		// reading costs nothing.
		queue: make(chan []int16, 50),
		done:  make(chan struct{}),
		mode:  mode,
	}
	go p.run(w)
	return p
}

func (p *pcmWriter) run(w io.Writer) {
	defer close(p.done)
	// Buffered: one packet is 960 samples, and an unbuffered write syscall per
	// packet is pure overhead on a pipe.
	out := bufio.NewWriterSize(w, 8192)
	buf := make([]byte, 0, 4096)

	// Where the header goes, so its sizes can be patched on the way out. A pipe
	// cannot seek, and says so.
	var start int64 = -1
	if p.mode == StdoutWAV {
		if f, ok := w.(io.Seeker); ok {
			if at, err := f.Seek(0, io.SeekCurrent); err == nil {
				start = at
			}
		}
		if err := writeWAVHeader(out, streamingSize); err != nil {
			p.note(err)
			return
		}
		if err := out.Flush(); err != nil {
			p.note(err)
			return
		}
	}
	defer func() {
		out.Flush()
		p.finish(w, start)
	}()

	for chunk := range p.queue {
		if cap(buf) < len(chunk)*2 {
			buf = make([]byte, len(chunk)*2)
		}
		buf = buf[:len(chunk)*2]
		for i, s := range chunk {
			binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
		}
		if _, err := out.Write(buf); err != nil {
			p.note(err)
			return
		}
		// Flushed per packet: a listener on the other end wants the audio now,
		// not when 8 kB have accumulated.
		if err := out.Flush(); err != nil {
			p.note(err)
			return
		}
		p.mu.Lock()
		p.written += len(chunk)
		p.mu.Unlock()
	}
}

// finish patches the real sizes into a WAV header, which is possible exactly
// when stdout turned out to be a regular file. A stream down a pipe keeps the
// open-ended sizes it was written with, which is what players expect there.
func (p *pcmWriter) finish(w io.Writer, start int64) {
	if p.mode != StdoutWAV || start < 0 {
		return
	}
	seeker, ok := w.(io.WriteSeeker)
	if !ok {
		return
	}

	p.mu.Lock()
	dataBytes := uint32(p.written * 2)
	p.mu.Unlock()

	if _, err := seeker.Seek(start, io.SeekStart); err != nil {
		return
	}
	writeWAVHeader(seeker, dataBytes)
	seeker.Seek(0, io.SeekEnd)
}

func (p *pcmWriter) note(err error) {
	p.mu.Lock()
	p.err = err
	p.mu.Unlock()
}

func (p *pcmWriter) push(mono []int16) {
	// The caller reuses its buffer between packets, so this has to be a copy.
	chunk := append([]int16(nil), mono...)
	select {
	case p.queue <- chunk:
	default:
		p.mu.Lock()
		p.dropped += len(chunk)
		p.mu.Unlock()
	}
}

func (p *pcmWriter) stats() (written, dropped int, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.written, p.dropped, p.err
}

func (p *pcmWriter) Close() error {
	close(p.queue)
	<-p.done
	return nil
}

// listDevicesForTest is the enumeration used by everything that resolves or
// prints a device. It is a var purely so tests can stand in a fixed list rather
// than depending on whatever sound server the machine happens to run.
var listDevicesForTest = listDevices

// deviceListSpecs are the -device values that ask what there is rather than
// naming one.
var deviceListSpecs = map[string]bool{"list": true, "?": true, "help": true}

// resolveDevice turns a -device value into a sink ID: an index into the list,
// or enough of a name to pick one out.
//
// Both forms exist because they fail differently. An index is quick to type
// from the listing, but the order can change when a device is plugged in or a
// sound server restarts — so a service that has to come back to the same
// speakers should name them instead.
func resolveDevice(spec string) (string, error) {
	devices, err := listDevicesForTest()
	if err != nil {
		return "", fmt.Errorf("cannot list output devices: %w", err)
	}

	if idx, err := strconv.Atoi(strings.TrimSpace(spec)); err == nil {
		if idx < 0 || idx >= len(devices) {
			return "", fmt.Errorf("device %d is out of range: there are %d, numbered 0 to %d",
				idx, len(devices), len(devices)-1)
		}
		return devices[idx].ID, nil
	}

	var matches []AudioDevice
	for _, d := range devices {
		if strings.EqualFold(d.Name, spec) {
			return d.ID, nil // an exact name beats anything merely containing it
		}
		if strings.Contains(strings.ToLower(d.Name), strings.ToLower(spec)) ||
			strings.EqualFold(d.ID, spec) {
			matches = append(matches, d)
		}
	}
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no output device matches %q", spec)
	case 1:
		return matches[0].ID, nil
	default:
		names := make([]string, 0, len(matches))
		for _, d := range matches {
			names = append(names, strconv.Quote(d.Name))
		}
		return "", fmt.Errorf("%q matches %d devices: %s", spec, len(matches), strings.Join(names, ", "))
	}
}

// describeDevices renders the numbered output list, which is what -device list
// prints and what an unusable -device value is answered with.
func describeDevices() string {
	devices, err := listDevicesForTest()
	if err != nil {
		return fmt.Sprintf("cannot list output devices: %v", err)
	}

	var b strings.Builder
	b.WriteString("output devices:\n")
	for i, d := range devices {
		mark := " "
		if d.Default {
			mark = "*" // where the sound server is currently sending audio
		}
		fmt.Fprintf(&b, " %s %d  %s\n", mark, i, d.Name)
	}
	b.WriteString("   (* is the sound server's current default, which is what index 0 follows;\n" +
		"    -device takes an index or part of a name)")
	return b.String()
}

// AudioOutput fans the decoded audio out to as many sinks as are switched on:
// the sound device, stdout, both or neither. They are independent — a receiver
// piped to another machine needs no local playback, and a missing or busy sound
// device must not take the pipe down with it.
type AudioOutput struct {
	mix *mixer

	mu       sync.Mutex
	backend  audioBackend
	deviceID string
	lastErr  error
	pipe     *pcmWriter
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

// StopDevice closes the sound device, leaving any other sink running.
func (o *AudioOutput) StopDevice() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.backend != nil {
		o.backend.Close()
		o.backend = nil
	}
	o.lastErr = nil
}

// SetStdout switches the second output between off, raw PCM and WAV. It refuses
// to write to a terminal, since that is not a pipe but a mess.
func (o *AudioOutput) SetStdout(mode StdoutMode) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	if mode == StdoutOff {
		if o.pipe != nil {
			o.pipe.Close()
			o.pipe = nil
		}
		return nil
	}
	if o.pipe != nil && o.pipe.mode == mode {
		return nil
	}
	if stdoutIsTerminal() {
		// Short on purpose: this is shown in the panel's value column, and the
		// note under the rows carries the command that fixes it.
		return errors.New("stdout is a terminal")
	}
	// Changing format mid-stream closes the old one first, which is what puts
	// the sizes into a WAV header that has just been superseded.
	if o.pipe != nil {
		o.pipe.Close()
	}
	o.pipe = newPCMWriter(os.Stdout, mode)
	return nil
}

// StdoutMode reports what the second output is carrying.
func (o *AudioOutput) StdoutMode() StdoutMode {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.pipe == nil {
		return StdoutOff
	}
	return o.pipe.mode
}

// StdoutOn reports whether the second output is running at all.
func (o *AudioOutput) StdoutOn() bool { return o.StdoutMode() != StdoutOff }

// StdoutStats reports what the raw stream has done: samples written, samples
// dropped because whatever is reading fell behind, and any write error.
func (o *AudioOutput) StdoutStats() (written, dropped int, err error) {
	o.mu.Lock()
	pipe := o.pipe
	o.mu.Unlock()
	if pipe == nil {
		return 0, 0, nil
	}
	return pipe.stats()
}

func (o *AudioOutput) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.backend != nil {
		o.backend.Close()
		o.backend = nil
	}
	if o.pipe != nil {
		o.pipe.Close()
		o.pipe = nil
	}
}

// Push hands one packet of decoded audio to every sink that is switched on.
func (o *AudioOutput) Push(mono []int16) {
	o.mix.push(mono)

	o.mu.Lock()
	pipe := o.pipe
	o.mu.Unlock()
	if pipe != nil {
		pipe.push(mono)
	}
}

func (o *AudioOutput) SetChannel(c Channel)                      { o.mix.setChannel(c) }
func (o *AudioOutput) SetMuted(m bool)                           { o.mix.setMuted(m) }
func (o *AudioOutput) SetVolume(v float64)                       { o.mix.setVolume(v) }
func (o *AudioOutput) Stats() (buffered, dropped, underruns int) { return o.mix.stats() }
func (o *AudioOutput) Devices() ([]AudioDevice, error)           { return listDevices() }

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
