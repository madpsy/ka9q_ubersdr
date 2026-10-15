package main

import (
	"encoding/binary"
	"testing"
)

// TestOpusListenerEncoderUsesCELT pins the listener encoder to Opus's audio
// application: every packet must be CELT-coded, which the configuration
// number in the top five bits of its first (TOC) byte shows -- 0-11 SILK,
// 12-15 hybrid, 16-31 CELT. VoIP mode coded the same audio with SILK at more
// than twice the CPU; see NewOpusEncoderForClient.
func TestOpusListenerEncoderUsesCELT(t *testing.T) {
	for _, c := range []struct {
		file    string
		rate    int
		bitrate int
	}{
		{"usb-ft8-14074.bin", 12000, 48000},
		{"usb-ft8-14074.bin", 12000, 24000},
		{"lsb-voice-7150.bin", 12000, 48000},
		{"lsb-voice-7150.bin", 12000, 24000},
		{"cw-14025.bin", 12000, 24000},
	} {
		var pcm []byte
		for _, pkt := range rawOpusTestPCM(t, c.file) {
			pcm = append(pcm, pkt...)
		}
		enc, err := NewOpusEncoderForClient(c.rate, c.bitrate, 5)
		if err != nil {
			t.Fatal(err)
		}
		frame := c.rate / 50 * 2 // 20 ms of big-endian int16
		n := 0
		for off := 0; off+frame <= len(pcm) && n < 200; off += frame {
			out, err := enc.EncodeBinary(pcm[off : off+frame])
			if err != nil {
				t.Fatalf("%s: %v", c.file, err)
			}
			if cfg := out[0] >> 3; cfg < 16 {
				t.Fatalf("%s at %d bps: frame %d coded with configuration %d, not CELT", c.file, c.bitrate, n, cfg)
			}
			n++
		}
		if n < 50 {
			t.Fatalf("%s: only %d frames", c.file, n)
		}
	}
}

// rawOpusTestPCM returns a capture's packets as the big-endian int16 PCM the
// audio path hands EncodeBinary.
func rawOpusTestPCM(t *testing.T, name string) [][]byte {
	var out [][]byte
	for _, pkt := range loadTestCapture(t, name) {
		h := PCMMinimalHeaderSize
		if binary.LittleEndian.Uint16(pkt) == PCMBinaryMagicFull {
			h = PCMFullHeaderSizeV2
		}
		out = append(out, pkt[h:])
	}
	return out
}
