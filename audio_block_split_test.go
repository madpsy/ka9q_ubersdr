package main

import (
	"encoding/binary"
	"testing"
	"time"
)

func TestBlocksInPacket(t *testing.T) {
	for _, tc := range []struct {
		name              string
		samples, channels int
		stamped, payload  int
		havePayload       bool
		want              int
	}{
		{"20 ms at 12 kHz", 240, 1, 12000, 12000, true, 1},
		{"CW FILTER2=2: 40 ms at 12 kHz", 480, 1, 12000, 12000, true, 2},
		{"FILTER2=3: 60 ms at 12 kHz", 720, 1, 12000, 12000, true, 3},
		{"20 ms at 24 kHz", 480, 1, 24000, 24000, true, 1},
		// The stray packet a switch from AM to CW leaves behind: 20 ms at
		// 24 kHz, stamped with CW's 12 kHz. Same length as a real 40 ms CW
		// block; only the payload type tells them apart.
		{"stale 24 kHz packet stamped 12 kHz", 480, 1, 12000, 24000, true, 1},
		{"payload type not yet known", 480, 1, 12000, 0, false, 1},
		{"not a whole number of blocks", 500, 1, 12000, 12000, true, 1},
		{"short packet", 120, 1, 12000, 12000, true, 1},
		{"stereo IQ is never split", 1920, 2, 48000, 48000, true, 1},
	} {
		if got := blocksInPacket(tc.samples, tc.channels, tc.stamped, tc.payload, tc.havePayload); got != tc.want {
			t.Errorf("%s: got %d blocks, want %d", tc.name, got, tc.want)
		}
	}
}

// statusPacketWithPT is statusPacket with an RTP_PT tag.
func statusPacketWithPT(ssrc uint32, samprate int, pt int) []byte {
	buf := statusPacket(ssrc, samprate, false, 0, 0, 0)
	buf = buf[:len(buf)-1] // drop EOL
	buf = encodeInt32(&buf, tagRtpPt, uint32(pt))
	return append(buf, tagEOL)
}

func TestPayloadRateLearnedFromStatus(t *testing.T) {
	fst := &FrontendStatusTracker{
		frontendStatus: make(map[uint32]*FrontendStatus),
		channelStatus:  make(map[uint32]*ChannelStatus),
		captureRefs:    make(map[uint32]captureRef),
		captureRefAt:   make(map[uint32]time.Time),
		debugLogged:    make(map[uint32]bool),
	}
	const ssrc = 5150
	if _, ok := fst.PayloadRate(ssrc, 96); ok {
		t.Fatal("rate reported before any status")
	}
	fst.parseStatusPacket(statusPacketWithPT(ssrc, 24000, 97))
	fst.parseStatusPacket(statusPacketWithPT(ssrc, 12000, 96))

	// The old mode's PT keeps its rate after the switch: that is what
	// identifies a packet left over from it.
	for pt, want := range map[uint8]int{96: 12000, 97: 24000} {
		if got, ok := fst.PayloadRate(ssrc, pt); !ok || got != want {
			t.Errorf("PT %d: got %d (%v), want %d", pt, got, ok, want)
		}
	}
	if _, ok := fst.PayloadRate(ssrc+1, 96); ok {
		t.Error("rate reported for another SSRC")
	}
}

type fakePayloadRates map[uint8]int

func (f fakePayloadRates) PayloadRate(_ uint32, pt uint8) (int, bool) {
	r, ok := f[pt]
	return r, ok
}

func TestRouteAudioSplitsFilter2Blocks(t *testing.T) {
	const ssrc = 777
	sess := &Session{
		SSRC:       ssrc,
		SampleRate: 12000,
		Channels:   1,
		AudioChan:  make(chan AudioPacket, 8),
		Done:       make(chan struct{}),
	}
	sm := &SessionManager{ssrcToSession: map[uint32]*Session{ssrc: sess}}
	ar := &AudioReceiver{sessions: sm, rates: fakePayloadRates{96: 12000, 97: 24000}}

	// 40 ms CW block: samples 0..479, big-endian as radiod sends them.
	pcm := make([]byte, 960)
	for i := 0; i < 480; i++ {
		binary.BigEndian.PutUint16(pcm[2*i:], uint16(i))
	}
	ar.routeAudio(ssrc, 96, pcm, 1000, time.Now().UnixNano())

	if n := len(sess.AudioChan); n != 2 {
		t.Fatalf("40 ms block delivered as %d packets, want 2", n)
	}
	for i := 0; i < 2; i++ {
		p := <-sess.AudioChan
		if len(p.PCMData) != 480 {
			t.Errorf("packet %d: %d bytes, want 480 (20 ms at 12 kHz)", i, len(p.PCMData))
		}
		if want := uint32(1000 + 240*i); p.RTPTimestamp != want {
			t.Errorf("packet %d: RTP timestamp %d, want %d", i, p.RTPTimestamp, want)
		}
		if first := int(binary.BigEndian.Uint16(p.PCMData)); first != 240*i {
			t.Errorf("packet %d starts at sample %d, want %d", i, first, 240*i)
		}
		if p.SampleRate != 12000 {
			t.Errorf("packet %d: rate %d, want 12000", i, p.SampleRate)
		}
	}

	// A 24 kHz packet left over from the previous mode is passed on whole,
	// for the Opus path to drop as before.
	ar.routeAudio(ssrc, 97, make([]byte, 960), 2000, time.Now().UnixNano())
	if n := len(sess.AudioChan); n != 1 {
		t.Fatalf("stale packet delivered as %d packets, want 1", n)
	}
	if p := <-sess.AudioChan; len(p.PCMData) != 960 {
		t.Errorf("stale packet: %d bytes, want 960 untouched", len(p.PCMData))
	}
}
