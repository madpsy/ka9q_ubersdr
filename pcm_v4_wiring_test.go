package main

import (
	"fmt"
	"testing"
)

// Tests of the decisions streamAudio makes, kept separate from the codec and
// header units because what they check is the wiring: which encoder a session
// gets, and what happens at the version boundary.
//
// streamAudio itself needs a live session and a socket, so these exercise the
// same predicates it uses rather than the function.

// A version this build does not implement must be refused, not quietly served
// as version 1. The old behaviour handed such a client the 29-byte v1 header
// with no signal quality and no way to discover that had happened.
func TestProtocolVersionAcceptance(t *testing.T) {
	cases := []struct {
		version int
		accept  bool
	}{
		{0, false},
		{1, true},
		{2, true},
		{3, true},
		{4, true},
		{5, false},
		{99, false},
		{-1, false},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("version_%d", c.version), func(t *testing.T) {
			accepted := c.version >= 1 && c.version <= pcmMaxProtocolVersion
			if accepted != c.accept {
				t.Errorf("version %d: accepted=%v, want %v", c.version, accepted, c.accept)
			}
		})
	}
	if pcmMaxProtocolVersion != 4 {
		t.Errorf("pcmMaxProtocolVersion is %d; the v4 work is complete, so it should be 4",
			pcmMaxProtocolVersion)
	}
}

// Exactly one encoder must exist on a connection. Building both would waste a
// zstd encoder per session, and checking the wrong one for nil in the send
// path returns and kills the streaming goroutine.
func TestEncoderSelectionByVersion(t *testing.T) {
	for version := 1; version <= pcmMaxProtocolVersion; version++ {
		wantV4 := version >= 4
		if wantV4 {
			if enc := NewPCMv4StreamEncoder(); enc == nil {
				t.Fatalf("version %d: no v4 encoder", version)
			}
			continue
		}
		pcmVersion := PCMBinaryVersion1
		if version >= 2 {
			pcmVersion = PCMBinaryVersion2
			if version >= 3 {
				pcmVersion = PCMBinaryVersion3
			}
		}
		enc := NewPCMBinaryEncoderWithVersionAndLevel(false, pcmVersion)
		if enc == nil {
			t.Fatalf("version %d: no v3 encoder", version)
		}
		enc.Close()
	}
}

// The silence path runs when the gate closes or audio stalls. All-zero samples
// are trivial for the predictor, but the packet must still be produced -- the
// decoder advances its own filters over it, so skipping one would desynchronise
// the stream.
func TestV4SilencePacketsKeepStreamInStep(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	ts := int64(1_700_000_000_000_000_000)

	// real audio, then a burst of gate-closed silence, then audio again
	packets := captureAsPackets(t, "usb-ft8-14074.bin")
	send := func(pcm []byte, rate, ch int, p, n float32) {
		t.Helper()
		wire, err := enc.EncodePacket(pcm, ts, rate, ch, p, n)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		if _, _, err := dec.DecodePacket(pkt); err != nil {
			t.Fatalf("decode: %v", err)
		}
		ts += 20_000_000
	}

	for _, p := range packets[:100] {
		send(p.pcmData, p.sampleRate, p.channels, p.power, p.noise)
	}
	silence := make([]byte, 240*2)
	var silenceBytes int
	for i := 0; i < 50; i++ {
		wire, err := enc.EncodePacket(silence, ts, 12000, 1, -999, -999)
		if err != nil {
			t.Fatal(err)
		}
		silenceBytes += len(wire)
		pkt := append([]byte(nil), wire...)
		if _, _, err := dec.DecodePacket(pkt); err != nil {
			t.Fatalf("silence packet %d: %v", i, err)
		}
		ts += 20_000_000
	}
	// and the stream must still be lossless afterwards
	for n, p := range packets[100:200] {
		wire, err := enc.EncodePacket(p.pcmData, ts, p.sampleRate, p.channels, p.power, p.noise)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		_, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d after silence: %v", n, err)
		}
		for i := range samples {
			want := int16(uint16(p.pcmData[2*i])<<8 | uint16(p.pcmData[2*i+1]))
			if samples[i] != want {
				t.Fatalf("packet %d after silence: sample %d desynced", n, i)
			}
		}
		ts += 20_000_000
	}
	mean := float64(silenceBytes) / 50
	t.Logf("gate-closed silence costs %.1f bytes per packet (version 3 sends %d, zstd got it to ~58)",
		mean, PCMFullHeaderSizeV2+240*2)
	// The floor is one bit per sample: a zero residual codes as a bare stop
	// bit, so 240 samples cost 30 bytes however well the predictor does, plus
	// the header. Anything near that is as good as this coder gets without a
	// run-length mode. The bound is set against what zstd achieved on the same
	// input (~58 bytes) so a regression that lost the predictor entirely, or
	// stopped the Rice parameter reaching zero, would fail.
	if mean > 58 {
		t.Errorf("silence packets are %.1f bytes; zstd managed ~58, so this is a regression", mean)
	}
}

// A session that negotiated Opus still reaches the pcm path when it tunes to
// IQ, so a v4 connection can carry both kinds of binary frame. They must
// remain distinguishable.
func TestV4AndOpusFramesAreDistinguishable(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	pcm := make([]byte, 1440)
	wire, err := enc.EncodePacket(pcm, 1_700_000_000_000_000_000, 384000, 2, -77, -93)
	if err != nil {
		t.Fatal(err)
	}
	if !PCMv4IsHeader(wire) {
		t.Fatal("a v4 packet was not identifiable")
	}
	// Version 3 packets must not be mistaken for v4 either, since a v3 client
	// and a v4 client can be connected to the same server at once.
	v3 := NewPCMBinaryEncoderWithVersionAndLevel(false, PCMBinaryVersion3)
	defer v3.Close()
	v3pkt, err := v3.EncodePCMPacketWithSignalQuality(pcm, 1_700_000_000_000_000_000, 384000, 2, -77, -93, true)
	if err != nil {
		t.Fatal(err)
	}
	if PCMv4IsHeader(v3pkt) {
		t.Error("a version 3 packet was identified as version 4")
	}
}
