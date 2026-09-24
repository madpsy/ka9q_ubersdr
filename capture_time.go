package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Capture time for audio packets.
//
// radiod with the ubersdr-radiod patch 0003-capture-time-anchor adds a pair to
// every channel status packet: one RTP timestamp of that channel's stream, and
// the time (CLOCK_REALTIME on the radiod host, Unix nanoseconds) at which the
// signal in that frame was captured by the A/D.  radiod works it out from the
// arrival times of the USB transfers, so it excludes the 20 ms block fill and
// all of radiod's processing, which packet arrival here cannot.
//
// The A/D clock is GPSDO-locked, so one pair fixes every other timestamp of the
// stream: the rest follows from counting samples.  Each packet's capture time
// is therefore computed here from the latest pair, however old, and the pair
// only has to be replaced when the count breaks -- a lost USB transfer, a clock
// step, a radiod or demod restart -- which radiod signals by sending a new one.
//
// A packet with no usable reference -- radiod has only just started, the
// channel is new, or its rate has changed and the new reference has not arrived
// -- carries 0: no timestamp, rather than a guess that looks like one.  Those
// windows last a block or a few.  UberSDR assumes radiod carries the patch.

// Status tags added by the radiod patch.  Numbered from the top of the byte so
// that upstream adding tags cannot collide with them.
const (
	tagCaptureTsRef      = 240 // CAPTURE_TS_REF: RTP timestamp of the reference frame
	tagCaptureTimeRef    = 241 // CAPTURE_TIME_REF: Unix ns at which that frame was captured
	tagCaptureGeneration = 242 // CAPTURE_GENERATION: bumped when the reference is re-established
)

// radiod's enum encoding values (rtp.h) for the two Opus variants, whose RTP
// timestamps always count at 48 kHz whatever the audio rate.
const (
	radiodEncodingOpus     = 3
	radiodEncodingOpusVoIP = 7
	opusRTPRate            = 48000
)

// maxCaptureLatency bounds how far a computed capture time may sit from the
// packet's arrival before it is disbelieved and the packet given no timestamp.
// Real figures are tens of milliseconds; anything near this means the pair no
// longer matches the stream, e.g. radiod restarted the demodulator and re-based
// its timestamps, and the pair describing the new ones has not arrived yet.
const maxCaptureLatency = 2 * time.Second

// captureRef ties one RTP timestamp of a channel's stream to its capture time.
type captureRef struct {
	TsRef      uint32 // RTP timestamp of the reference frame
	TimeNs     int64  // Unix ns at which that frame was captured
	Generation uint32 // radiod's anchor generation
	Rate       int    // RTP clock rate of the stream the pair was taken from, Hz
}

// captureTime returns the capture time, Unix ns, of the frame carrying RTP
// timestamp ts.  The signed 32-bit difference handles timestamp wraparound and
// reaches about 12 hours either side of the reference at 48 kHz.
func (r captureRef) captureTime(ts uint32) int64 {
	frames := int64(int32(ts - r.TsRef))
	return r.TimeNs + frames*int64(time.Second)/int64(r.Rate)
}

// rtpRateFor is the rate a stream's RTP timestamps count at, given what radiod
// reported for it.
func rtpRateFor(samprate, encoding int) int {
	if encoding == radiodEncodingOpus || encoding == radiodEncodingOpusVoIP {
		return opusRTPRate
	}
	return samprate
}

// captureSource supplies the latest capture reference for a channel.
// *RadiodController satisfies it.
type captureSource interface {
	CaptureRef(ssrc uint32) (captureRef, bool)
}

// captureStamp is one channel's timestamping state.  It lives on the Session
// and is written only by the audio receive goroutine; the admin channel status
// reads it, hence the atomic.
type captureStamp struct {
	// lastLatency is arrival minus capture time for the channel's last packet
	// that had a usable reference; 0 until one has.
	lastLatency atomic.Int64
}

// LastLatencyNs is capture-to-arrival time for the channel's last packet that
// had a usable reference, and false if none has.  Safe from any goroutine.
func (s *captureStamp) LastLatencyNs() (int64, bool) {
	ns := s.lastLatency.Load()
	return ns, ns != 0
}

// stamp returns the capture time, Unix ns, of the packet with RTP timestamp ts
// that arrived at rxNs, or 0 when there is no usable reference: none yet, one
// the tracker withholds because the channel's rate has changed since, or one
// that puts the capture too far from the arrival to be believed.
//
// The reference's own rate is used, not the session's: that is the rate radiod
// reports for the stream, while Session.SampleRate is only UberSDR's label for
// it and has disagreed with radiod before.
func (s *captureStamp) stamp(ref captureRef, haveRef bool, ts uint32, rxNs int64) int64 {
	if !haveRef || ref.Rate <= 0 {
		return 0
	}
	c := ref.captureTime(ts)
	latency := rxNs - c
	if latency <= -int64(maxCaptureLatency) || latency >= int64(maxCaptureLatency) {
		return 0
	}
	s.lastLatency.Store(latency)
	return c
}

// hostClockID names the clock the capture times are on: a hash of the kernel's
// boot_id, which every process and container on one host shares and no other
// host has.  A client that computes the same value is reading the same
// CLOCK_REALTIME, so it may take the difference between a packet's capture time
// and its own clock -- a short interval, not an absolute time on a clock it has
// no reason to trust.  ubersdr-ntp does exactly that for a receiver on its own
// host.  Hashed so the boot_id itself is not handed to every listener.  Empty
// when the kernel does not expose it, which a client must read as "not mine".
var hostClockID = sync.OnceValue(func() string {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	id := strings.TrimSpace(string(b))
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:8])
})
