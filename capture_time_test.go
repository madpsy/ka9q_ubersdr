package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCaptureRefCaptureTime(t *testing.T) {
	ref := captureRef{TsRef: 1000, TimeNs: 1_790_000_000_000_000_000, Rate: 12000}

	cases := []struct {
		name string
		ts   uint32
		want int64
	}{
		{"reference frame", 1000, ref.TimeNs},
		{"one second later", 1000 + 12000, ref.TimeNs + int64(time.Second)},
		{"one block (240 frames) later", 1240, ref.TimeNs + 20*int64(time.Millisecond)},
		{"before the reference", 1000 - 12000 + (1 << 32), ref.TimeNs - int64(time.Second)},
	}
	for _, c := range cases {
		if got := ref.captureTime(c.ts); got != c.want {
			t.Errorf("%s: captureTime(%d) = %d, want %d", c.name, c.ts, got, c.want)
		}
	}
}

// The 32-bit RTP timestamp wraps; a frame just past the wrap is still just
// after the reference.
func TestCaptureRefCaptureTimeAcrossWrap(t *testing.T) {
	ref := captureRef{TsRef: 0xFFFFFF00, TimeNs: 5_000_000_000, Rate: 48000}
	ts := uint32(0x00000100) // 512 frames later, across the wrap
	want := ref.TimeNs + 512*int64(time.Second)/48000
	if got := ref.captureTime(ts); got != want {
		t.Fatalf("captureTime across wrap = %d, want %d", got, want)
	}
}

func TestRTPRateFor(t *testing.T) {
	if got := rtpRateFor(12000, 2); got != 12000 { // S16BE
		t.Errorf("PCM: got %d, want 12000", got)
	}
	if got := rtpRateFor(12000, radiodEncodingOpus); got != 48000 {
		t.Errorf("Opus: got %d, want 48000", got)
	}
	if got := rtpRateFor(24000, radiodEncodingOpusVoIP); got != 48000 {
		t.Errorf("Opus VoIP: got %d, want 48000", got)
	}
}

func TestCaptureStamp(t *testing.T) {
	ref := captureRef{TsRef: 0, TimeNs: 1_000_000_000_000, Rate: 12000}
	latency := 35 * int64(time.Millisecond)

	var s captureStamp
	check := func(name string, got, want int64) {
		t.Helper()
		if got != want {
			t.Fatalf("%s: got %d, want %d", name, got, want)
		}
	}

	// No reference yet: no timestamp, not a guess.
	check("no reference", s.stamp(captureRef{}, false, 240, 777), 0)
	if _, ok := s.LastLatencyNs(); ok {
		t.Fatal("a latency was reported before any packet had a reference")
	}

	// With a reference: the capture time, whatever the arrival jitter.
	ts := uint32(2400) // 200 ms after the reference
	capture := ref.captureTime(ts)
	check("with reference", s.stamp(ref, true, ts, capture+latency), capture)
	last := latency + 3*int64(time.Millisecond)
	check("with reference and jitter", s.stamp(ref, true, ts, capture+last), capture)
	if got, ok := s.LastLatencyNs(); !ok || got != last {
		t.Fatalf("LastLatencyNs = %d, %v; want %d", got, ok, last)
	}

	// The reference goes (e.g. withheld after a rate change): no timestamp
	// again, however recently one was known.
	rx := capture + 5*int64(time.Second)
	check("reference withheld", s.stamp(captureRef{}, false, 99, rx), 0)

	// A reference that puts the capture hours from the arrival is disbelieved.
	stale := captureRef{TsRef: 0, TimeNs: ref.TimeNs - int64(3*time.Hour), Rate: 12000}
	check("implausible reference", s.stamp(stale, true, ts, rx), 0)
}

// statusPacket builds a radiod status packet body (without the leading type
// byte) for one channel, optionally carrying a capture reference.
func statusPacket(ssrc uint32, samprate int, withCapture bool, tsRef uint32, timeNs int64, gen uint32) []byte {
	buf := make([]byte, 0, 64)
	buf = encodeInt32(&buf, tagOutputSSRC, ssrc)
	buf = encodeInt32(&buf, tagOutputSamprate, uint32(samprate))
	buf = encodeInt32(&buf, tagOutputEncoding, 2) // S16BE
	if withCapture {
		buf = encodeInt32(&buf, tagCaptureTsRef, tsRef)
		var t [8]byte
		binary.BigEndian.PutUint64(t[:], uint64(timeNs))
		buf = append(buf, tagCaptureTimeRef, 8)
		buf = append(buf, t[:]...)
		buf = encodeInt32(&buf, tagCaptureGeneration, gen)
	}
	return append(buf, tagEOL)
}

func TestParseStatusPacketCaptureRef(t *testing.T) {
	fst := &FrontendStatusTracker{
		frontendStatus: make(map[uint32]*FrontendStatus),
		channelStatus:  make(map[uint32]*ChannelStatus),
		captureRefs:    make(map[uint32]captureRef),
		captureRefAt:   make(map[uint32]time.Time),
		debugLogged:    make(map[uint32]bool),
	}
	const ssrc = 41287
	const timeNs = int64(1_790_000_000_123_456_789)

	// An unpatched radiod: no reference.
	fst.parseStatusPacket(statusPacket(ssrc, 12000, false, 0, 0, 0))
	if _, ok := fst.CaptureRef(ssrc); ok {
		t.Fatal("reference reported for a packet without one")
	}

	fst.parseStatusPacket(statusPacket(ssrc, 12000, true, 0xDEADBEEF, timeNs, 3))
	ref, ok := fst.CaptureRef(ssrc)
	if !ok {
		t.Fatal("no reference after a packet carrying one")
	}
	want := captureRef{TsRef: 0xDEADBEEF, TimeNs: timeNs, Generation: 3, Rate: 12000}
	if ref != want {
		t.Fatalf("reference = %+v, want %+v", ref, want)
	}
	if cs := fst.GetChannelStatus(ssrc); cs == nil || !cs.HasCapture || cs.CaptureTimeNs != timeNs {
		t.Fatalf("channel status does not carry the reference: %+v", cs)
	}

	// A later packet without one means radiod no longer has a valid pair (the
	// anchor is being rebuilt, the demod restarted...): it is dropped, so
	// packets go untimestamped rather than wrongly timestamped.
	fst.parseStatusPacket(statusPacket(ssrc, 12000, false, 0, 0, 0))
	if ref, ok := fst.CaptureRef(ssrc); ok {
		t.Fatalf("reference kept after a packet without one: %+v", ref)
	}
	if _, _, _, _, ok := fst.CaptureRefInfo(ssrc); ok {
		t.Fatal("CaptureRefInfo still shows a dropped reference")
	}

	// A pair whose rate does not match the channel's current rate is not
	// handed out, even if it is the one stored (belt and braces: radiod
	// withholds such pairs itself).
	fst.parseStatusPacket(statusPacket(ssrc, 12000, true, 0xDEADBEEF, timeNs, 3))
	fst.mu.Lock()
	fst.channelStatus[ssrc].OutputSamprate = 24000
	fst.mu.Unlock()
	if ref, ok := fst.CaptureRef(ssrc); ok {
		t.Fatalf("reference at 12 kHz offered for a 24 kHz stream: %+v", ref)
	}
	if ref, at, usable, cur, ok := fst.CaptureRefInfo(ssrc); !ok || usable || cur != 24000 || ref.Rate != 12000 || at.IsZero() {
		t.Fatalf("CaptureRefInfo with a rate mismatch = %+v, %v, %v, %d, %v", ref, at, usable, cur, ok)
	}

	// Until radiod sends one for the new rate.
	fst.parseStatusPacket(statusPacket(ssrc, 24000, true, 480, timeNs+int64(time.Second), 3))
	if ref, ok := fst.CaptureRef(ssrc); !ok || ref.Rate != 24000 || ref.TsRef != 480 {
		t.Fatalf("reference for the new rate = %+v, %v", ref, ok)
	}
}

// The clock id must be derived exactly as ubersdr-ntp derives it -- the first
// eight bytes of the SHA-256 of the trimmed boot_id, in hex -- or a receiver on
// the same host will never be recognised as one.
func TestHostClockID(t *testing.T) {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		t.Skip("no boot_id on this system")
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(string(b))))
	if got, want := hostClockID(), hex.EncodeToString(sum[:8]); got != want || len(got) != 16 {
		t.Fatalf("hostClockID() = %q, want %q", got, want)
	}
}
