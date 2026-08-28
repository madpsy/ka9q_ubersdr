package main

import (
	"testing"

	"github.com/klauspost/compress/zstd"
)

// The encoder always compresses — its useCompression parameter is ignored, see
// NewPCMBinaryEncoderWithVersionAndLevel — so a test that wants to measure a
// header has to inflate the packet first.
func inflate(t *testing.T, packet []byte) []byte {
	t.Helper()
	r, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatalf("zstd reader: %v", err)
	}
	defer r.Close()
	raw, err := r.DecodeAll(packet, nil)
	if err != nil {
		t.Fatalf("zstd decode: %v", err)
	}
	return raw
}

// The version gate on the full PCM header.  IQ used to be excluded outright,
// which left its clients with one signal reading per session; version 1 is
// still excluded because its full header has no room for the fields — see
// fullPCMHeaderAlways and buildFullHeaderPacket.
func TestFullPCMHeaderAlways(t *testing.T) {
	for _, tc := range []struct {
		name    string
		isIQ    bool
		version int
		want    bool
	}{
		{"demodulated audio, version 1", false, 1, true},
		{"demodulated audio, version 2", false, 2, true},
		{"demodulated audio, version 3", false, 3, true},
		{"IQ on version 1 keeps the minimal header", true, 1, false},
		{"IQ on version 2 carries signal quality", true, 2, true},
		{"IQ on version 3 carries signal quality", true, 3, true},
	} {
		if got := fullPCMHeaderAlways(tc.isIQ, tc.version); got != tc.want {
			t.Errorf("%s: fullPCMHeaderAlways(%v, %d) = %v, want %v",
				tc.name, tc.isIQ, tc.version, got, tc.want)
		}
	}
}

// A version 1 full header has no signal-quality fields at all, which is the
// reason the gate above exists: forcing one on an IQ session that negotiated
// version 1 would add 16 bytes a packet and deliver nothing.
func TestVersion1FullHeaderCarriesNoSignalQuality(t *testing.T) {
	e := NewPCMBinaryEncoderWithVersion(false, PCMBinaryVersion1)
	pcm := make([]byte, 8)
	packet, err := e.EncodePCMPacketWithSignalQuality(pcm, 0, 12000, 2, -80, -110, true)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if got, want := len(inflate(t, packet)), PCMFullHeaderSizeV1+len(pcm); got != want {
		t.Fatalf("version 1 full header packet is %d bytes, want %d", got, want)
	}

	e3 := NewPCMBinaryEncoderWithVersion(false, PCMBinaryVersion3)
	packet3, err := e3.EncodePCMPacketWithSignalQuality(pcm, 0, 12000, 2, -80, -110, true)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if got, want := len(inflate(t, packet3)), PCMFullHeaderSizeV2+len(pcm); got != want {
		t.Fatalf("version 3 full header packet is %d bytes, want %d", got, want)
	}
}

// Every packet after the first is full when forced, and minimal when not —
// the difference the IQ meters turn on.
func TestForceFullHeaderIsPerPacket(t *testing.T) {
	pcm := make([]byte, 8)
	for _, tc := range []struct {
		name  string
		force bool
		want  int
	}{
		{"forced", true, PCMFullHeaderSizeV2},
		{"not forced", false, PCMMinimalHeaderSize},
	} {
		e := NewPCMBinaryEncoderWithVersion(false, PCMBinaryVersion3)
		// First packet is always full: nothing has announced the rate yet.
		if _, err := e.EncodePCMPacketWithSignalQuality(pcm, 0, 12000, 2, -80, -110, tc.force); err != nil {
			t.Fatalf("%s: encode: %v", tc.name, err)
		}
		packet, err := e.EncodePCMPacketWithSignalQuality(pcm, 1, 12000, 2, -80, -110, tc.force)
		if err != nil {
			t.Fatalf("%s: encode: %v", tc.name, err)
		}
		if got := len(inflate(t, packet)) - len(pcm); got != tc.want {
			t.Errorf("%s: second packet header is %d bytes, want %d", tc.name, got, tc.want)
		}
	}
}
