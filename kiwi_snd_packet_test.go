package main

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"
)

// The payload offset is the whole point: audio_recv in kiwi/audio.js reads the
// payload from byte 20 when the stereo flag is set and byte 10 when it is not.
// Get it wrong and the client decodes the timestamp as audio rather than
// reporting an error.
func TestBuildKiwiSndPacketPayloadOffset(t *testing.T) {
	payload := []byte{0xde, 0xad, 0xbe, 0xef}

	tests := []struct {
		name       string
		flags      byte
		wantOffset int
	}{
		{name: "mono uncompressed", flags: 0x00, wantOffset: 10},
		{name: "mono adpcm", flags: kiwiSndFlagCompressed, wantOffset: 10},
		{name: "stereo iq", flags: kiwiSndFlagStereo, wantOffset: 20},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pkt := buildKiwiSndPacket(tc.flags, 1, 770, 0, payload)

			if want := tc.wantOffset + len(payload); len(pkt) != want {
				t.Fatalf("packet length %d, want %d", len(pkt), want)
			}
			if got := pkt[tc.wantOffset:]; !bytes.Equal(got, payload) {
				t.Errorf("payload at offset %d = % x, want % x", tc.wantOffset, got, payload)
			}
			if got := string(pkt[:3]); got != "SND" {
				t.Errorf("tag = %q, want \"SND\"", got)
			}
			if pkt[3] != tc.flags {
				t.Errorf("flags = 0x%02x, want 0x%02x", pkt[3], tc.flags)
			}
		})
	}
}

// Sequence is little-endian and the S-meter big-endian, in the same packet:
// audio_recv assembles seq from h8[7]<<24|h8[6]<<16|h8[5]<<8|h8[4] but the
// S-meter from (sm8[0]<<8)|sm8[1].
func TestBuildKiwiSndPacketEndianness(t *testing.T) {
	pkt := buildKiwiSndPacket(0x00, 0x01020304, 0xABCD, 0, nil)

	if got := binary.LittleEndian.Uint32(pkt[4:8]); got != 0x01020304 {
		t.Errorf("sequence = 0x%08x, want 0x01020304 (little-endian)", got)
	}
	if got := binary.BigEndian.Uint16(pkt[8:10]); got != 0xABCD {
		t.Errorf("smeter = 0x%04x, want 0xABCD (big-endian)", got)
	}
}

// Layout confirmed against a live KiwiSDR v1.902 in iq mode, which sent
// "ff 00 03 5b 02 00 <nsec:4 LE>" -- last_gps_solution 255 (no fix), a pad
// byte, then time-of-week seconds and nanoseconds, both little-endian.
func TestKiwiStereoTimestampLayout(t *testing.T) {
	const gpsEpochUnix = 315964800
	// 2026-08-25T09:17:37Z plus 250 ms.
	when := time.Date(2026, 8, 25, 9, 17, 37, 250_000_000, time.UTC)
	unixNanos := when.UnixNano()

	buf := make([]byte, kiwiStereoTimestampLen)
	kiwiStereoTimestamp(buf, unixNanos)

	if buf[0] != 255 {
		t.Errorf("last_gps_solution = %d, want 255 (no GPS solution)", buf[0])
	}
	if buf[1] != 0 {
		t.Errorf("pad byte = %d, want 0", buf[1])
	}

	wantTOW := uint32((when.Unix() - gpsEpochUnix) % 604800)
	if got := binary.LittleEndian.Uint32(buf[2:6]); got != wantTOW {
		t.Errorf("gpssec = %d, want %d (GPS time of week)", got, wantTOW)
	}
	if got := binary.LittleEndian.Uint32(buf[6:10]); got != 250_000_000 {
		t.Errorf("gpsnsec = %d, want 250000000", got)
	}
	if got := binary.LittleEndian.Uint32(buf[2:6]); got >= 604800 {
		t.Errorf("gpssec = %d, must be a valid time of week (< 604800)", got)
	}
}

// The nanosecond field must advance by exactly one packet duration between
// consecutive IQ packets, which is how the real receiver behaves and what a
// TDoA consumer relies on.
func TestKiwiStereoTimestampAdvancesByPacketDuration(t *testing.T) {
	// 512 samples at 12 kHz, the real KiwiSDR's IQ packet.
	const packetDuration = time.Duration(512) * time.Second / 12000

	base := time.Date(2026, 8, 25, 9, 17, 37, 0, time.UTC)
	first := make([]byte, kiwiStereoTimestampLen)
	second := make([]byte, kiwiStereoTimestampLen)
	kiwiStereoTimestamp(first, base.UnixNano())
	kiwiStereoTimestamp(second, base.Add(packetDuration).UnixNano())

	delta := int64(binary.LittleEndian.Uint32(second[6:10])) -
		int64(binary.LittleEndian.Uint32(first[6:10]))
	if want := packetDuration.Nanoseconds(); delta != want {
		t.Errorf("nsec advanced by %d, want %d", delta, want)
	}
}

// A short buffer must not panic: the field is written into a slice of the
// packet, so a future layout change that shrinks it should fail a test rather
// than take the audio path down.
func TestKiwiStereoTimestampShortBuffer(t *testing.T) {
	buf := make([]byte, kiwiStereoTimestampLen-1)
	kiwiStereoTimestamp(buf, time.Now().UnixNano())
	for i, b := range buf {
		if b != 0 {
			t.Errorf("short buffer written at %d (= %d), want untouched", i, b)
		}
	}
}

// newTestKiwiConn builds the minimum kiwiConn encodeSndPayload needs: no
// websocket, no session, no radiod.
func newTestKiwiConn(compression bool) *kiwiConn {
	return &kiwiConn{
		compression:  compression,
		adpcmEncoder: NewIMAAdpcmEncoder(),
	}
}

func TestEncodeSndPayloadStereoSuppressesCompression(t *testing.T) {
	pcm := pcmTone(240, 12000, 1000, 8000)

	tests := []struct {
		name        string
		compression bool
		stereo      bool
		wantFlags   byte
		wantRaw     bool // payload passed through untouched
	}{
		{name: "mono uncompressed", compression: false, stereo: false, wantFlags: 0x00, wantRaw: true},
		{name: "mono compressed", compression: true, stereo: false, wantFlags: kiwiSndFlagCompressed},
		{name: "stereo never compresses", compression: true, stereo: true, wantFlags: kiwiSndFlagStereo, wantRaw: true},
		{name: "stereo uncompressed", compression: false, stereo: true, wantFlags: kiwiSndFlagStereo, wantRaw: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			kc := newTestKiwiConn(tc.compression)
			data, flags := kc.encodeSndPayload(pcm, tc.stereo)

			if flags != tc.wantFlags {
				t.Errorf("flags = 0x%02x, want 0x%02x", flags, tc.wantFlags)
			}
			if tc.wantRaw {
				if !bytes.Equal(data, pcm) {
					t.Errorf("payload was transformed, want it passed through untouched")
				}
				return
			}
			// ADPCM packs one sample per nibble.
			if want := len(pcm) / 4; len(data) != want {
				t.Errorf("compressed length = %d, want %d", len(data), want)
			}
		})
	}
}

// The client zeroes its ADPCM decoder whenever the compression flag changes, so
// after a stereo (uncompressed) stretch the encoder must restart from the same
// zeroed state. Otherwise encoder and decoder track different predictors.
func TestEncodeSndPayloadResetsAdpcmAfterStereo(t *testing.T) {
	first := pcmTone(240, 12000, 700, 9000)
	second := pcmTone(240, 12000, 1900, 9000)

	kc := newTestKiwiConn(true)

	// Compressed mono for a while, so the encoder accumulates state.
	kc.encodeSndPayload(first, false)
	kc.encodeSndPayload(second, false)

	// An IQ stretch: uncompressed, and the client resets its decoder.
	if _, flags := kc.encodeSndPayload(first, true); flags&kiwiSndFlagCompressed != 0 {
		t.Fatalf("stereo packet was compressed, flags = 0x%02x", flags)
	}

	// Back to compressed mono: the output must match a brand-new encoder,
	// which is the state the client is now in.
	got, flags := kc.encodeSndPayload(second, false)
	if flags != kiwiSndFlagCompressed {
		t.Fatalf("flags = 0x%02x, want compressed", flags)
	}
	want := NewIMAAdpcmEncoder().Encode(second)
	if !bytes.Equal(got, want) {
		t.Error("encoder was not reset after the stereo stretch: output differs from a fresh " +
			"encoder, so the client's zeroed decoder would track a different predictor")
	}
}

// Continuous compressed mono must NOT reset: ADPCM is a running differential
// encoding, and restarting it every packet would throw away the predictor.
func TestEncodeSndPayloadKeepsAdpcmStateWhileCompressed(t *testing.T) {
	pcm := pcmTone(240, 12000, 700, 9000)
	kc := newTestKiwiConn(true)

	kc.encodeSndPayload(pcm, false)
	got, _ := kc.encodeSndPayload(pcm, false)

	fresh := NewIMAAdpcmEncoder().Encode(pcm)
	if bytes.Equal(got, fresh) {
		t.Error("second packet encoded identically to a fresh encoder, so the running " +
			"ADPCM state was discarded between packets")
	}
}
