package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"testing"
)

// Conformance test for the version 4 header.
//
// testdata/opusv4_headers.bin holds frames the SERVER's encoder produced, each
// stored with the field values that went into it, so this checks the parse
// against the implementation that has to agree rather than against this one's
// own idea of the format. The header is change-tracked, so a field the encoder
// omitted because it had not moved must come back carried forward, not zero.
//
// Where the Opus packet begins is checked too: the header is variable-length,
// and the version 3 reader's fixed 21-byte slice would hand the decoder
// metadata as though it were audio.
//
// Record layout: uint64 timestamp, uint32 rate, uint8 channels, float32 power,
// float32 noise, uint32 payload length, payload, uint32 frame length, frame.
func TestAudioHeaderMatchesServer(t *testing.T) {
	raw, err := os.ReadFile("testdata/opusv4_headers.bin")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if len(raw) < 9 || string(raw[:4]) != "UO4F" || raw[4] != 0 {
		t.Fatal("fixture: bad header")
	}
	count := int(binary.LittleEndian.Uint32(raw[5:]))
	off := 9

	take := func(n int) []byte {
		t.Helper()
		if off+n > len(raw) {
			t.Fatalf("fixture: truncated at %d", off)
		}
		b := raw[off : off+n]
		off += n
		return b
	}

	dec := newAudioHeaderDecoder()
	for i := 0; i < count; i++ {
		take(8) // timestamp; carried by the header but not used for playback
		wantRate := int(binary.LittleEndian.Uint32(take(4)))
		wantCh := int(take(1)[0])
		wantPower := math.Float32frombits(binary.LittleEndian.Uint32(take(4)))
		wantNoise := math.Float32frombits(binary.LittleEndian.Uint32(take(4)))
		payload := take(int(binary.LittleEndian.Uint32(take(4))))
		frame := take(int(binary.LittleEndian.Uint32(take(4))))

		h, bodyOff, err := dec.decode(frame)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if h.SourceRate != wantRate || h.Channels != wantCh {
			t.Fatalf("frame %d: %d Hz / %d ch, want %d / %d", i, h.SourceRate, h.Channels, wantRate, wantCh)
		}
		// Quality survives a round trip through centidecibels, so it matches to
		// a hundredth of a dB rather than exactly; -999 is the sentinel and must
		// come back untouched, since isReportedLevel is what reads it.
		if !closeDB(h.Power, wantPower) || !closeDB(h.Noise, wantNoise) {
			t.Fatalf("frame %d: quality %v/%v, want %v/%v", i, h.Power, h.Noise, wantPower, wantNoise)
		}
		if isReportedLevel(h.Power) != (wantPower > -998) {
			t.Fatalf("frame %d: power %v reads as reported=%v", i, h.Power, isReportedLevel(h.Power))
		}
		if got := frame[bodyOff:]; !bytes.Equal(got, payload) {
			t.Fatalf("frame %d: body offset %d yields %d bytes, want %d", i, bodyOff, len(got), len(payload))
		}
	}
	if off != len(raw) {
		t.Fatalf("fixture: %d trailing bytes", len(raw)-off)
	}
}

func closeDB(got, want float32) bool {
	if want == -999 || got == -999 {
		return got == want
	}
	d := got - want
	return d < 0.01 && d > -0.01
}

// A frame that arrives before any resynchronisation point cannot be read:
// nothing has said what the sample rate is, and its timestamp is a delta from a
// baseline that was never received. Guessing would be worse than failing, and
// the server's five-second resync is what ends the state.
func TestAudioHeaderRefusesADeltaWithNoBaseline(t *testing.T) {
	raw, err := os.ReadFile("testdata/opusv4_headers.bin")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	// The second record's frame, which is a delta: skip the first record whole,
	// then walk the second's fields to its frame.
	off := 9
	skipRecord := func() []byte {
		off += 8 + 4 + 1 + 4 + 4
		off += 4 + int(binary.LittleEndian.Uint32(raw[off:]))
		n := int(binary.LittleEndian.Uint32(raw[off:]))
		off += 4
		f := raw[off : off+n]
		off += n
		return f
	}
	skipRecord()
	delta := skipRecord()

	if _, _, err := newAudioHeaderDecoder().decode(delta); err == nil {
		t.Fatal("a delta frame was accepted with no baseline")
	}
}

// Lossless frames must be recognised rather than fed to the Opus decoder. This
// client asks for Opus, but a server built without libopus serves lossless
// regardless, and one older than 0.1.63 serves the zstd form after clamping the
// requested version to 1-3.
func TestLosslessFramesAreRecognised(t *testing.T) {
	pcm4 := []byte{0x50, 0x43, 0x4D, 0x34, 0x20}
	zstd := []byte{0x28, 0xB5, 0x2F, 0xFD, 0x00}

	if m, ok := frameIsLossless(pcm4); !ok || m != losslessMagic {
		t.Error("a version 4 lossless frame was not recognised")
	}
	if m, ok := frameIsLossless(zstd); !ok || m != zstdMagic {
		t.Error("a zstd frame was not recognised")
	}
	// An Opus header's flags byte uses only bits 0 and 1, so it can never begin
	// with either magic -- which is why neither carries one.
	for _, flags := range []byte{0x00, 0x01, 0x02, 0x03} {
		frame := []byte{flags, 0, 0, 0, 0}
		if _, ok := frameIsLossless(frame); ok {
			t.Errorf("an Opus frame with flags 0x%02x read as lossless", flags)
		}
	}
	for _, short := range [][]byte{nil, {}, {0x50}, {0x50, 0x43, 0x4D}} {
		if _, ok := frameIsLossless(short); ok {
			t.Errorf("short frame %v read as lossless", short)
		}
	}
}
