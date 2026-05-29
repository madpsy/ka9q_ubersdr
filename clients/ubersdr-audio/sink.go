package main

// sink.go — StreamSink interface and implementations for stdout and UDP output.
//
// A StreamSink receives raw decoded PCM frames directly from the WebSocket
// receive pipeline, before any volume, mute, or channel-routing is applied.
// This means the output is always full-volume, full-stereo (or mono, depending
// on the server's stream), unmodified audio — suitable for piping to ffmpeg,
// aplay, sox, or any UDP consumer.
//
// Wire format: little-endian signed 16-bit PCM (same as the decoded output of
// both the Opus and PCM-zstd paths).  Sample rate and channel count are printed
// to stderr on the first frame so downstream consumers can configure themselves.
//
// Example ffmpeg usage (stdout):
//
//	ubersdr-audio --stdout | ffmpeg -f s16le -ar 48000 -ac 2 -i - output.mp3
//
// Example aplay usage (stdout, Linux):
//
//	ubersdr-audio --stdout | aplay -f S16_LE -r 48000 -c 2
//
// Example UDP receive with ffmpeg:
//
//	ffmpeg -f s16le -ar 48000 -ac 2 -i udp://127.0.0.1:5005 output.mp3

import (
	"fmt"
	"net"
	"os"
	"sync"
)

// StreamSink receives raw decoded PCM frames.
// WritePCM is called from the audio delivery goroutine; implementations must
// be goroutine-safe.  sampleRate and channels describe the PCM data.
// Close releases any resources held by the sink.
type StreamSink interface {
	WritePCM(pcmLE []byte, sampleRate, channels int)
	Close()
}

// ── MultiSink ─────────────────────────────────────────────────────────────────

// MultiSink fans out to multiple StreamSink implementations simultaneously.
// Used when both --stdout and --udp-out are specified.
type MultiSink struct {
	sinks []StreamSink
}

// NewMultiSink creates a MultiSink that writes to all provided sinks.
func NewMultiSink(sinks ...StreamSink) *MultiSink {
	return &MultiSink{sinks: sinks}
}

func (m *MultiSink) WritePCM(pcmLE []byte, sampleRate, channels int) {
	for _, s := range m.sinks {
		s.WritePCM(pcmLE, sampleRate, channels)
	}
}

func (m *MultiSink) Close() {
	for _, s := range m.sinks {
		s.Close()
	}
}

// ── StdoutSink ────────────────────────────────────────────────────────────────

// StdoutSink writes raw little-endian int16 PCM to os.Stdout.
// On the first frame it prints the stream parameters to stderr so that
// downstream consumers (ffmpeg, aplay, sox, etc.) can configure themselves.
type StdoutSink struct {
	mu        sync.Mutex
	announced bool
	lastRate  int
	lastCh    int
}

// NewStdoutSink creates a StdoutSink.
func NewStdoutSink() *StdoutSink {
	return &StdoutSink{}
}

func (s *StdoutSink) WritePCM(pcmLE []byte, sampleRate, channels int) {
	s.mu.Lock()
	if !s.announced || s.lastRate != sampleRate || s.lastCh != channels {
		fmt.Fprintf(os.Stderr,
			"ubersdr-audio: stdout PCM stream: %d Hz, %d channel(s), signed 16-bit little-endian\n"+
				"  ffmpeg:  ffmpeg -f s16le -ar %d -ac %d -i - output.mp3\n"+
				"  aplay:   aplay -f S16_LE -r %d -c %d\n",
			sampleRate, channels,
			sampleRate, channels,
			sampleRate, channels,
		)
		s.announced = true
		s.lastRate = sampleRate
		s.lastCh = channels
	}
	s.mu.Unlock()

	// Write the raw PCM bytes to stdout.  Errors are silently ignored — if
	// the pipe is broken the process will receive SIGPIPE and exit naturally.
	os.Stdout.Write(pcmLE) //nolint:errcheck
}

func (s *StdoutSink) Close() {
	// Nothing to close — os.Stdout is managed by the runtime.
}

// ── UDPSink ───────────────────────────────────────────────────────────────────

// UDPSink sends one UDP datagram per decoded PCM frame to a target address.
// Each datagram contains the raw little-endian int16 PCM bytes for that frame
// (typically ~1920–7680 bytes at 20 ms per frame).
//
// On the first frame (or whenever the stream parameters change) a parameter
// announcement is printed to stderr.
//
// The target address is resolved once at creation time.  If the connection
// fails, WritePCM is a no-op (errors are logged to stderr once).
type UDPSink struct {
	conn      *net.UDPConn
	mu        sync.Mutex
	announced bool
	lastRate  int
	lastCh    int
	errLogged bool
	target    string
}

// NewUDPSink creates a UDPSink that sends datagrams to addr (e.g. "127.0.0.1:5005").
// Returns an error if the address cannot be resolved or the socket cannot be opened.
func NewUDPSink(addr string) (*UDPSink, error) {
	raddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("udp sink: resolve %q: %w", addr, err)
	}
	conn, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		return nil, fmt.Errorf("udp sink: dial %q: %w", addr, err)
	}
	return &UDPSink{conn: conn, target: addr}, nil
}

func (u *UDPSink) WritePCM(pcmLE []byte, sampleRate, channels int) {
	u.mu.Lock()
	if !u.announced || u.lastRate != sampleRate || u.lastCh != channels {
		fmt.Fprintf(os.Stderr,
			"ubersdr-audio: UDP PCM stream → %s: %d Hz, %d channel(s), signed 16-bit little-endian\n"+
				"  frame size: %d bytes (~20 ms)\n",
			u.target, sampleRate, channels, len(pcmLE),
		)
		u.announced = true
		u.lastRate = sampleRate
		u.lastCh = channels
	}
	conn := u.conn
	u.mu.Unlock()

	if conn == nil {
		return
	}
	if _, err := conn.Write(pcmLE); err != nil {
		u.mu.Lock()
		if !u.errLogged {
			fmt.Fprintf(os.Stderr, "ubersdr-audio: UDP write error: %v\n", err)
			u.errLogged = true
		}
		u.mu.Unlock()
	} else {
		// Reset error flag on success so transient errors are re-reported if
		// they recur after a period of successful sends.
		u.mu.Lock()
		u.errLogged = false
		u.mu.Unlock()
	}
}

func (u *UDPSink) Close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.conn != nil {
		u.conn.Close()
		u.conn = nil
	}
}
