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

// mixer buffers audio at the output rate and serves it to whichever backend is
// playing, applying routing, mute and volume at read time so those controls
// take effect immediately rather than after the buffer drains.
//
// The buffer holds interleaved stereo FRAMES. Two channels rather than one
// because the IQ modes have two things to say — I and Q — and folding them
// together would destroy exactly the information that makes them IQ. A
// demodulated mode is pushed as one channel and duplicated into both sides on
// the way in, which is what it has always played as.
type mixer struct {
	mu      sync.Mutex
	buf     []int16 // interleaved stereo: len(buf) is twice the frame count
	channel Channel
	muted   bool
	volume  float64

	// Bounded so a stalled or absent output device cannot grow the buffer
	// without limit; the oldest audio is dropped, which keeps latency low.
	maxFrames int

	// Jitter buffer. Audio arrives at exactly real time, so without a cushion
	// the buffer sits near empty and ordinary network and scheduling jitter
	// empties it between callbacks, inserting silence — heard as a stutter.
	// While priming, silence is played and nothing is consumed, letting the
	// buffer fill to targetFrames first.
	targetFrames int
	priming      bool

	dropped   int
	underruns int // reads that ran out of buffered audio and padded with silence
}

// targetLatency is how much audio to hold before playing. It has to cover the
// worst inter-packet gap comfortably: packets are nominally 20 ms apart, with a
// measured 99th percentile near 24 ms and occasional 50 ms outliers.
const targetLatency = 120 * time.Millisecond

func newMixer() *mixer {
	return &mixer{
		volume:       1.0,
		maxFrames:    opusOutputRate, // one second
		targetFrames: int(float64(opusOutputRate) * targetLatency.Seconds()),
		priming:      true,
	}
}

// push queues one channel of audio, played on both sides.
func (m *mixer) push(mono []int16) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range mono {
		m.buf = append(m.buf, s, s)
	}
	m.trim()
}

// pushStereo queues interleaved stereo frames, which is what an IQ stream
// becomes: I on the left, Q on the right.
func (m *mixer) pushStereo(frames []int16) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.buf = append(m.buf, frames[:len(frames)/2*2]...)
	m.trim()
}

// trim drops the oldest audio once the buffer is past its bound. Called with
// the lock held.
func (m *mixer) trim() {
	if excess := len(m.buf)/2 - m.maxFrames; excess > 0 {
		m.buf = m.buf[excess*2:]
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
		if len(m.buf)/2 < m.targetFrames {
			for i := 0; i < frames; i++ {
				out[i*2], out[i*2+1] = 0, 0
			}
			return frames * 2
		}
		m.priming = false
	}

	avail := len(m.buf) / 2
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
		out[i*2] = clampSample(float64(m.buf[i*2]) * gainL)
		out[i*2+1] = clampSample(float64(m.buf[i*2+1]) * gainR)
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

	m.buf = m.buf[avail*2:]
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

// stats reports the buffer in FRAMES, which is what its latency is measured in
// and what it held before it carried two channels.
func (m *mixer) stats() (buffered, dropped, underruns int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.buf) / 2, m.dropped, m.underruns
}

// Stdout is the second output, always available on any platform: the decoded
// audio as raw PCM, for piping into anything that reads a stream.
//
//	ubersdr-tui -server … -stdout | aplay -f S16_LE -r 48000 -c 1
//
// It carries the stream as the RECEIVER sent it — signed 16-bit little-endian,
// at the radio channel's own sample rate and channel count — and deliberately
// not what the speakers get: volume, mute and channel routing belong to the
// sound device, and applying them here would quietly ruin a recording or halve
// a pipe when the routing is set to one side.
//
// An Opus session is 48 kHz mono, which is what the command above assumes,
// because Opus reconstructs at 48 kHz whatever it was fed. A lossless session
// is the channel's own rate — 12 kHz for the sideband and CW modes, 24 for AM
// and FM — and an IQ session is 12 to 384 kHz in two interleaved channels.
// Passing those through unconverted is the whole point: a capture of a lossless
// stream that had been interpolated to 48 kHz would not be the samples the
// receiver sent, and 384 kHz IQ does not fit down a 48 kHz mono pipe at all.
// The WAV form writes whatever it turns out to be into its header, and the
// audio panel's Stdout row says what is going out.
//
// Nothing about the display is at risk from this. tcell drives /dev/tty rather
// than stdout, so the two never meet; the only real hazard is a stdout that is
// still a terminal, which stdoutIsRedirected rules out before anything opens.
// The nominal format, which is what a default session — Opus, a demodulated
// mode — actually produces, and what the pipe command in the help and the panel
// suggests. Anything else says so for itself: see pcmWriter.format.
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

// Label describes the stream in full, for the panel, before any packet has said
// what it really is. It names what a default session produces.
func (m StdoutMode) Label() string {
	return m.LabelFor(stdoutSampleRate, stdoutChannels)
}

// LabelFor describes the stream as it is actually going out.
func (m StdoutMode) LabelFor(rate, channels int) string {
	switch m {
	case StdoutRaw:
		return "on   raw " + describeStreamFormat(rate, channels)
	case StdoutWAV:
		return "on   WAV, " + describeStreamFormat(rate, channels)
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

// writeWAVHeader emits a 44-byte PCM header for the format actually being
// written, which is whatever the receiver turned out to be sending.
func writeWAVHeader(w io.Writer, dataBytes uint32, rate, channels int) error {
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
	le.PutUint16(h[22:], uint16(channels))
	le.PutUint32(h[24:], uint32(rate))
	le.PutUint32(h[28:], uint32(rate*channels*2)) // bytes per second
	le.PutUint16(h[32:], uint16(channels*2))      // block align
	le.PutUint16(h[34:], 16)                      // bits per sample

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
	queue chan AudioPacket
	done  chan struct{}
	mode  StdoutMode

	mu      sync.Mutex
	dropped int
	written int
	err     error
	// rate and channels are the format taken from the first packet, and what
	// the WAV header was written with. Zero until that packet arrives.
	rate     int
	channels int
}

func newPCMWriter(w io.Writer, mode StdoutMode) *pcmWriter {
	p := &pcmWriter{
		// A second of audio at 20 ms a packet, so a brief stall in whatever is
		// reading costs nothing.
		queue: make(chan AudioPacket, 50),
		done:  make(chan struct{}),
		mode:  mode,
	}
	go p.run(w)
	return p
}

// format reports what is being written, and whether anything has been yet.
func (p *pcmWriter) format() (rate, channels int, started bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rate, p.channels, p.rate > 0
}

func (p *pcmWriter) run(w io.Writer) {
	defer close(p.done)
	// Buffered: one packet is 960 samples, and an unbuffered write syscall per
	// packet is pure overhead on a pipe.
	out := bufio.NewWriterSize(w, 8192)
	buf := make([]byte, 0, 4096)

	// Where the header goes, so its sizes can be patched on the way out. A pipe
	// cannot seek, and says so. The header itself waits for the first packet:
	// it has to name the rate and the channel count, and only the stream knows
	// those.
	var start int64 = -1
	if p.mode == StdoutWAV {
		if f, ok := w.(io.Seeker); ok {
			if at, err := f.Seek(0, io.SeekCurrent); err == nil {
				start = at
			}
		}
	}
	defer func() {
		out.Flush()
		p.finish(w, start)
	}()

	var rate, channels int
	for pkt := range p.queue {
		if rate == 0 {
			rate, channels = pkt.Rate, pkt.Channels
			p.mu.Lock()
			p.rate, p.channels = rate, channels
			p.mu.Unlock()
			if p.mode == StdoutWAV {
				if err := writeWAVHeader(out, streamingSize, rate, channels); err != nil {
					p.note(err)
					return
				}
			}
		} else if pkt.Rate != rate || pkt.Channels != channels {
			// The stream changed shape under us, which is what a mode change
			// looks like from here. Raw is survivable — the reader was told the
			// format on its own command line and now needs telling again — but
			// a WAV header is already written and cannot be changed, so
			// continuing would produce a file that lies about its own contents.
			err := fmt.Errorf("stream changed to %s; %s",
				describeStreamFormat(pkt.Rate, pkt.Channels),
				map[StdoutMode]string{
					StdoutWAV: "a WAV header cannot follow it, so the capture ends here",
					StdoutRaw: "the reader must be told again",
				}[p.mode])
			p.note(err)
			if p.mode == StdoutWAV {
				return
			}
			rate, channels = pkt.Rate, pkt.Channels
			p.mu.Lock()
			p.rate, p.channels = rate, channels
			p.mu.Unlock()
		}

		chunk := pkt.Samples
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
	rate, channels := p.rate, p.channels
	p.mu.Unlock()
	if rate == 0 {
		return // no packet ever arrived, so no header was written to patch
	}

	if _, err := seeker.Seek(start, io.SeekStart); err != nil {
		return
	}
	writeWAVHeader(seeker, dataBytes, rate, channels)
	seeker.Seek(0, io.SeekEnd)
}

func (p *pcmWriter) note(err error) {
	p.mu.Lock()
	p.err = err
	p.mu.Unlock()
}

func (p *pcmWriter) push(pkt AudioPacket) {
	// The caller may reuse its buffer between packets, so this has to be a
	// copy.
	pkt.Samples = append([]int16(nil), pkt.Samples...)
	select {
	case p.queue <- pkt:
	default:
		p.mu.Lock()
		p.dropped += len(pkt.Samples)
		p.mu.Unlock()
	}
}

// describeStreamFormat names a stream the way the panel and the messages do.
func describeStreamFormat(rate, channels int) string {
	ch := "mono"
	switch {
	case channels == 2:
		ch = "stereo"
	case channels > 2:
		ch = fmt.Sprintf("%d ch", channels)
	}
	return fmt.Sprintf("%s %.4g kHz %s", stdoutFormat, float64(rate)/1000, ch)
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
	// dev converts the incoming stream for the sound device; see Push. It lives
	// here rather than in the mixer because it is stateful per stream, and the
	// mixer outlives the streams that feed it.
	dev *deviceConverter
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

// StdoutFormat is what the second output is actually carrying: the rate and
// channel count taken from the first packet, and whether one has arrived.
//
// It cannot be known in advance. The format follows the receiver — Opus is
// always 48 kHz mono, lossless is the channel's own rate, and an IQ mode is two
// channels at up to 384 kHz — so this is what the panel reports rather than the
// nominal constants.
func (o *AudioOutput) StdoutFormat() (rate, channels int, started bool) {
	o.mu.Lock()
	pipe := o.pipe
	o.mu.Unlock()
	if pipe == nil {
		return 0, 0, false
	}
	return pipe.format()
}

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
//
// The two sinks want different things, which is why the packet arrives here
// unconverted. The sound device runs at one fixed rate and two channels, so
// everything is brought to that. Stdout carries the stream as the receiver sent
// it — rate, channel count and all — because a capture or a decoder wants the
// samples that were transmitted, not an interpolated copy of them, and 384 kHz
// IQ has nowhere to go in a 48 kHz mono pipe.
func (o *AudioOutput) Push(pkt AudioPacket) {
	if len(pkt.Samples) == 0 {
		return
	}

	o.mu.Lock()
	if !o.dev.matches(pkt) {
		o.dev = newDeviceConverter(pkt)
	}
	stereo := o.dev.convert(pkt)
	pipe := o.pipe
	o.mu.Unlock()

	o.mix.pushStereo(stereo)
	if pipe != nil {
		pipe.push(pkt)
	}
}

// deviceConverter brings one stream to the interleaved stereo at the output
// rate that the mixer takes.
//
// It holds one rate converter per source channel, so the two halves of an IQ
// pair are filtered independently and stay in step. It is rebuilt when the
// stream's rate or channel count changes, which is what a mode change looks
// like from here.
type deviceConverter struct {
	rate     int
	channels int
	up       []*upsampler
	scratch  []int16
}

func newDeviceConverter(pkt AudioPacket) *deviceConverter {
	channels := pkt.Channels
	if channels < 1 {
		channels = 1
	}
	// Only two channels reach the speakers. Nothing the server sends has more,
	// and taking the first two is the only mapping that means anything if one
	// ever does.
	if channels > 2 {
		channels = 2
	}
	c := &deviceConverter{rate: pkt.Rate, channels: channels}
	for i := 0; i < channels; i++ {
		c.up = append(c.up, newUpsampler(pkt.Rate, opusOutputRate))
	}
	return c
}

func (c *deviceConverter) matches(pkt AudioPacket) bool {
	if c == nil {
		return false
	}
	channels := pkt.Channels
	if channels < 1 {
		channels = 1
	}
	if channels > 2 {
		channels = 2
	}
	return c.rate == pkt.Rate && c.channels == channels
}

// convert returns interleaved stereo at the output rate.
//
// A single channel is duplicated onto both sides, as demodulated audio always
// has been. A stereo one is carried across as it stands, which for an IQ stream
// puts I on the left and Q on the right — the only mapping that keeps both
// halves and the one every other IQ monitor uses.
func (c *deviceConverter) convert(pkt AudioPacket) []int16 {
	if c.channels == 1 {
		mono := pkt.Samples
		if pkt.Channels > 1 {
			mono = c.deinterleave(pkt, 0)
		}
		return duplicateToStereo(c.up[0].process(mono))
	}

	left := c.up[0].process(c.deinterleave(pkt, 0))
	right := c.up[1].process(c.deinterleave(pkt, 1))
	n := len(left)
	if len(right) < n {
		n = len(right)
	}
	out := make([]int16, n*2)
	for i := 0; i < n; i++ {
		out[i*2], out[i*2+1] = left[i], right[i]
	}
	return out
}

// deinterleave pulls one channel out of an interleaved packet, into a buffer it
// reuses — the converter above consumes it before the next call.
func (c *deviceConverter) deinterleave(pkt AudioPacket, ch int) []int16 {
	frames := pkt.Frames()
	if cap(c.scratch) < frames {
		c.scratch = make([]int16, frames)
	}
	c.scratch = c.scratch[:frames]
	for i := 0; i < frames; i++ {
		c.scratch[i] = pkt.Samples[i*pkt.Channels+ch]
	}
	return c.scratch
}

func duplicateToStereo(mono []int16) []int16 {
	out := make([]int16, len(mono)*2)
	for i, s := range mono {
		out[i*2], out[i*2+1] = s, s
	}
	return out
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
