package hpsdr

import (
	"encoding/binary"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"
)

// The protocol 1 wire logic, without the bridge. What this pins is the part that
// fails silently: a wrong rate code or a mis-shifted register address does not
// crash, it hands the client a correctly framed picture of the wrong thing. The
// first cases are clients/hpsdr/test/p1_framing.c, one for one.

// stubHost records what the layer under test asked the bridge to do.
type stubHost struct {
	mu       sync.Mutex
	rateHz   int
	freqHz   int64
	enabled  int
	stopAll  int
	p2Busy   bool
	logLines []string
}

func newStub() *stubHost { return &stubHost{rateHz: -1, freqHz: -1, enabled: -1} }

func (s *stubHost) p1SetRate(rx, hz int)       { s.rateHz = hz }
func (s *stubHost) p1SetFreq(rx int, hz int64) { s.freqHz = hz }
func (s *stubHost) p1Enable(rx int, on bool) {
	if on {
		s.enabled = 1
	} else {
		s.enabled = 0
	}
}
func (s *stubHost) p1StopAll()      { s.stopAll++ }
func (s *stubHost) p1P2Busy() bool  { return s.p2Busy }
func (s *stubHost) mac() [6]byte    { return [6]byte{0x02, 0x11, 0x22, 0x33, 0x44, 0x55} }
func (s *stubHost) boardType() byte { return DeviceHermesLite }
func (s *stubHost) logf(format string, args ...any) {
	s.mu.Lock()
	s.logLines = append(s.logLines, fmt.Sprintf(format, args...))
	s.mu.Unlock()
}

// sink captures what protocol 1 writes.
type sink struct {
	pkts [][]byte
	to   []net.Addr
}

func (k *sink) WriteTo(b []byte, a net.Addr) (int, error) {
	k.pkts = append(k.pkts, append([]byte(nil), b...))
	k.to = append(k.to, a)
	return len(b), nil
}

var testFrom = &net.UDPAddr{IP: net.IPv4(192, 168, 1, 50), Port: 50000}

// ep2 is one EP2 packet carrying bank in both frames.
func ep2(bank [5]byte) []byte {
	pkt := make([]byte, 1032)
	pkt[0], pkt[1], pkt[2], pkt[3] = 0xEF, 0xFE, 0x01, 0x02
	for f := 0; f < 2; f++ {
		frame := pkt[8+f*512:]
		frame[0], frame[1], frame[2] = 0x7F, 0x7F, 0x7F
		copy(frame[3:], bank[:])
	}
	return pkt
}

func TestP1RateCodes(t *testing.T) {
	h := newStub()
	p := newP1(h)
	for code, want := range []int{48000, 96000, 192000, 384000} {
		h.rateHz = -1
		p.HandleDatagram(nil, ep2([5]byte{0x00, byte(code)}), testFrom)
		if h.rateHz != want {
			t.Errorf("rate code %d: got %d Hz, want %d", code, h.rateHz, want)
		}
	}
}

// RX1 frequency is register 0x02, carried shifted left one as 0x04, because C0
// bit 0 is MOX.
func TestP1FrequencyRegister(t *testing.T) {
	h := newStub()
	p := newP1(h)
	p.HandleDatagram(nil, ep2([5]byte{0x04, 0x00, 0x8F, 0x0D, 0x18}), testFrom)
	if h.freqHz != 0x008F0D18 {
		t.Fatalf("frequency %d, want %d", h.freqHz, 0x008F0D18)
	}
	// The unshifted address is not the frequency.
	h.freqHz = -1
	p.HandleDatagram(nil, ep2([5]byte{0x02, 0x00, 0x8F, 0x0D, 0x18}), testFrom)
	if h.freqHz != -1 {
		t.Fatalf("a bank at C0 0x02 was read as the RX1 frequency")
	}
	// Zero is not a tune.
	p.HandleDatagram(nil, ep2([5]byte{0x04, 0, 0, 0, 0}), testFrom)
	if h.freqHz != -1 {
		t.Fatalf("a zero frequency was passed down")
	}
}

// A keyed config bank is still a config bank, and a repeat does not call down:
// EP2 arrives continuously, and acting on every one would reconnect hundreds of
// times a second.
func TestP1MOXAndDedupe(t *testing.T) {
	h := newStub()
	p := newP1(h)
	p.HandleDatagram(nil, ep2([5]byte{0x00, 0x03}), testFrom)
	h.rateHz = -1
	p.HandleDatagram(nil, ep2([5]byte{0x01, 0x01}), testFrom)
	if h.rateHz != 96000 {
		t.Fatalf("MOX hid the config register: rate %d", h.rateHz)
	}
	h.rateHz = -1
	p.HandleDatagram(nil, ep2([5]byte{0x00, 0x01}), testFrom)
	if h.rateHz != -1 {
		t.Fatalf("an unchanged rate called down again")
	}
	found := false
	for _, l := range h.logLines {
		if l == "P1: client keyed (MOX); this bridge is receive-only, ignoring" {
			found = true
		}
	}
	if !found {
		t.Fatalf("keying was not reported: %v", h.logLines)
	}
}

// A frame without sync is skipped; the other frame is still read.
func TestP1UnsyncedFrameSkipped(t *testing.T) {
	h := newStub()
	p := newP1(h)
	pkt := ep2([5]byte{})
	pkt[8] = 0
	copy(pkt[8+512+3:], []byte{0x04, 0x01, 0x02, 0x03, 0x04})
	p.HandleDatagram(nil, pkt, testFrom)
	if h.freqHz != 0x01020304 {
		t.Fatalf("frequency %x, want 0x01020304", h.freqHz)
	}
	// A short EP2 is ignored rather than read past.
	h.freqHz = -1
	p.HandleDatagram(nil, pkt[:1000], testFrom)
	if h.freqHz != -1 {
		t.Fatal("a truncated EP2 was acted on")
	}
}

func TestP1RunAndStop(t *testing.T) {
	h := newStub()
	p := newP1(h)
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	p.HandleDatagram(nil, run, testFrom)
	if !p.Active() || h.enabled != 1 {
		t.Fatal("run command did not start the stream")
	}
	// Default rate when the client has not said.
	if h.rateHz != 192000 {
		t.Fatalf("start rate %d, want 192000", h.rateHz)
	}
	if p.Client().String() != testFrom.String() {
		t.Fatalf("client %v, want %v", p.Client(), testFrom)
	}
	stop := make([]byte, 64)
	stop[0], stop[1], stop[2] = 0xEF, 0xFE, 0x04
	p.HandleDatagram(nil, stop, testFrom)
	if p.Active() || h.enabled != 0 || h.stopAll != 1 {
		t.Fatal("stop command did not release every receiver")
	}
	// A second stop is not a second release.
	p.HandleDatagram(nil, stop, testFrom)
	if h.stopAll != 1 {
		t.Fatal("a stop while stopped released again")
	}
}

// A rate configured before the run command is the one started at.
func TestP1RateBeforeRun(t *testing.T) {
	h := newStub()
	p := newP1(h)
	p.HandleDatagram(nil, ep2([5]byte{0x00, 0x00}), testFrom) // 48 kHz
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	p.HandleDatagram(nil, run, testFrom)
	if h.rateHz != 48000 {
		t.Fatalf("started at %d, want the configured 48000", h.rateHz)
	}
}

func TestP1RefusedWhileP2Streams(t *testing.T) {
	h := newStub()
	h.p2Busy = true
	p := newP1(h)
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	p.HandleDatagram(nil, run, testFrom)
	if p.Active() || h.enabled != -1 {
		t.Fatal("run was accepted on top of a protocol 2 client")
	}
}

// Protocol 2 datagrams fall through untouched.
func TestP1LeavesP2Alone(t *testing.T) {
	p := newP1(newStub())
	d := make([]byte, 60)
	d[4] = 0x02
	if p.HandleDatagram(nil, d, testFrom) {
		t.Fatal("protocol 2 discovery was claimed by protocol 1")
	}
	for _, short := range [][]byte{nil, {0xEF}, {0xEF, 0xFE}} {
		if p.HandleDatagram(nil, short, testFrom) {
			t.Fatalf("%v claimed", short)
		}
	}
}

// Discovery reply offsets: status [2], MAC [3:9], gateware [9], board [10],
// receivers [19] -- not [20].
func TestP1DiscoveryReply(t *testing.T) {
	h := newStub()
	p := newP1(h)
	k := &sink{}
	req := make([]byte, 63)
	req[0], req[1], req[2] = 0xEF, 0xFE, 0x02
	if !p.HandleDatagram(k, req, testFrom) {
		t.Fatal("discovery not claimed")
	}
	if len(k.pkts) != 1 {
		t.Fatalf("%d replies", len(k.pkts))
	}
	r := k.pkts[0]
	mac := h.mac()
	switch {
	case len(r) != 60:
		t.Fatalf("reply is %d bytes", len(r))
	case r[0] != 0xEF || r[1] != 0xFE || r[2] != 0x02:
		t.Fatalf("header % x", r[:3])
	case string(r[3:9]) != string(mac[:]):
		t.Fatalf("MAC % x", r[3:9])
	case r[9] != 62 || r[10] != DeviceHermesLite || r[19] != 1 || r[20] != 0:
		t.Fatalf("gateware %d board %d rx[19] %d [20] %d", r[9], r[10], r[19], r[20])
	}
	// Short requests are not answered.
	p.HandleDatagram(k, req[:62], testFrom)
	if len(k.pkts) != 1 {
		t.Fatal("a 62-byte discovery was answered")
	}
	// Busy while streaming, so a client that restarts still finds the radio.
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	p.HandleDatagram(k, run, testFrom)
	p.HandleDatagram(k, req, testFrom)
	if got := k.pkts[len(k.pkts)-1][2]; got != 0x03 {
		t.Fatalf("status while streaming %d, want 3", got)
	}
}

func TestP1Geometry(t *testing.T) {
	if P1SamplesPerPacket != 126 || p1RoundsPerFrame != 63 || 504%p1RoundBytes != 0 {
		t.Fatalf("geometry: %d samples, %d rounds", P1SamplesPerPacket, p1RoundsPerFrame)
	}
}

// EP6 layout: header and sequence, sync on both frames, the telemetry rotation,
// imaginary part first, the mic word zero, and zero padding after 63 rounds.
func TestP1EP6Layout(t *testing.T) {
	h := newStub()
	p := newP1(h)
	k := &sink{}
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	p.HandleDatagram(k, run, testFrom)

	iq := make([]float32, 2*P1SamplesPerPacket)
	for i := 0; i < P1SamplesPerPacket; i++ {
		iq[2*i] = float32(1000 + i)    // re
		iq[2*i+1] = float32(-1000 - i) // im
	}
	var addrs []byte
	for n := 0; n < 3; n++ {
		pkt, conn, to := p.BuildEP6(iq)
		if pkt == nil || conn != k || to.String() != testFrom.String() {
			t.Fatal("no packet while streaming")
		}
		if len(pkt) != 1032 || pkt[0] != 0xEF || pkt[1] != 0xFE || pkt[2] != 0x01 || pkt[3] != 0x06 {
			t.Fatalf("header % x", pkt[:4])
		}
		if seq := binary.BigEndian.Uint32(pkt[4:]); seq != uint32(n) {
			t.Fatalf("sequence %d, want %d", seq, n)
		}
		s := 0
		for f := 0; f < 2; f++ {
			frame := pkt[8+f*512 : 8+(f+1)*512]
			if frame[0] != 0x7F || frame[1] != 0x7F || frame[2] != 0x7F {
				t.Fatalf("frame %d sync % x", f, frame[:3])
			}
			addrs = append(addrs, frame[3])
			if frame[3] == 0 && frame[7] != 62 {
				t.Fatalf("address 0 firmware %d", frame[7])
			}
			for r := 0; r < 63; r++ {
				round := frame[8+8*r:]
				if got := get24(round); got != int32(-1000-s) {
					t.Fatalf("sample %d: I slot %d, want the imaginary part %d", s, got, -1000-s)
				}
				if got := get24(round[3:]); got != int32(1000+s) {
					t.Fatalf("sample %d: Q slot %d, want the real part %d", s, got, 1000+s)
				}
				if round[6] != 0 || round[7] != 0 {
					t.Fatal("mic word not zero")
				}
				s++
			}
			for _, v := range frame[8+63*8:] {
				if v != 0 {
					t.Fatal("frame padding not zero")
				}
			}
		}
	}
	want := []byte{0, 8, 16, 24, 32, 0}
	for i, a := range want {
		if addrs[i] != a {
			t.Fatalf("telemetry addresses %v, want %v...", addrs, want)
		}
	}
}

func get24(p []byte) int32 {
	v := int32(p[0])<<16 | int32(p[1])<<8 | int32(p[2])
	return v << 8 >> 8
}

func TestP1Watchdog(t *testing.T) {
	h := newStub()
	p := newP1(h)
	now := time.Unix(1000, 0)
	p.now = func() time.Time { return now }
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	p.HandleDatagram(nil, run, testFrom)
	now = now.Add(P1Watchdog - time.Millisecond)
	p.CheckWatchdog()
	if !p.Active() {
		t.Fatal("stopped before the watchdog expired")
	}
	// Any packet from the client feeds it.
	p.HandleDatagram(nil, ep2([5]byte{}), testFrom)
	now = now.Add(P1Watchdog - time.Millisecond)
	p.CheckWatchdog()
	if !p.Active() {
		t.Fatal("an EP2 packet did not feed the watchdog")
	}
	now = now.Add(P1Watchdog)
	p.CheckWatchdog()
	if p.Active() || h.stopAll != 1 {
		t.Fatal("a silent client was not stopped")
	}
	if pkt, _, _ := p.BuildEP6(make([]float32, 252)); pkt != nil {
		t.Fatal("EP6 built after stopping")
	}
}

// Start re-applies the remembered frequency: the bridge clears its receiver on
// stop, and a client restarting on the same frequency sends an EP2 the dedupe
// calls unchanged.
func TestP1StartReappliesFrequency(t *testing.T) {
	h := newStub()
	p := newP1(h)
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	stop := append([]byte(nil), run...)
	stop[3] = 0
	p.HandleDatagram(nil, ep2([5]byte{0x04, 0x00, 0x8F, 0x0D, 0x18}), testFrom)
	p.HandleDatagram(nil, run, testFrom)
	p.HandleDatagram(nil, stop, testFrom)
	h.freqHz = -1
	p.HandleDatagram(nil, ep2([5]byte{0x04, 0x00, 0x8F, 0x0D, 0x18}), testFrom)
	if h.freqHz != -1 {
		t.Fatal("the dedupe no longer applies; this test needs rethinking")
	}
	p.HandleDatagram(nil, run, testFrom)
	if h.freqHz != 0x008F0D18 {
		t.Fatalf("start did not re-apply the frequency: %d", h.freqHz)
	}
}
