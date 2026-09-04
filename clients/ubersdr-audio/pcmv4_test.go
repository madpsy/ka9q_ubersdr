package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"os"
	"strings"
	"testing"
)

// Conformance test for the version 4 receive path.
//
// testdata/pcmv4_stream.bin is a real packet stream produced by the SERVER's
// encoder (PCMv4StreamEncoder in the repository root), and pcmv4ExpectedSHA is
// the SHA-256 of the samples that went into it, little-endian, exactly as this
// client renders them. Decoding the one and getting the other is the whole
// lossless claim, checked against the implementation that has to agree rather
// than against this one's own idea of the format.
//
// It is a golden fixture rather than a round trip because the client has no
// encoder: it decodes only, so a round trip here would only prove this file
// consistent with itself. That is also what makes the test worth its 90 kB --
// a drift between the two implementations is invisible until audio turns to
// noise, and this is what would catch it.
//
// The stream covers what the format can do: ordinary mono audio, silent packets
// carrying no body, the return to signal afterwards (where a predictor left out
// of step would show), an escape to verbatim samples on incompressible noise, a
// sample-rate change, a switch to interleaved I/Q that rebuilds the codec onto
// the complex profile, and a varying packet length across the five-second
// periodic resynchronisation.
const pcmv4ExpectedSHA = "4875d2185f1ff5a2031386c569cac0c2259e6a827b9e61f813399a19c3b9c903"

// readV4Fixture returns the packets in testdata/pcmv4_stream.bin.
//
// Layout: "UV4F", a format byte, a uint32 packet count, then each packet as a
// uint32 length and that many bytes.
func readV4Fixture(t *testing.T) [][]byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/pcmv4_stream.bin")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if len(raw) < 9 || string(raw[:4]) != "UV4F" || raw[4] != 0 {
		t.Fatalf("fixture: bad header")
	}
	count := int(binary.LittleEndian.Uint32(raw[5:]))
	off := 9

	packets := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		if off+4 > len(raw) {
			t.Fatalf("fixture: truncated length at packet %d", i)
		}
		n := int(binary.LittleEndian.Uint32(raw[off:]))
		off += 4
		if off+n > len(raw) {
			t.Fatalf("fixture: truncated packet %d", i)
		}
		packets = append(packets, raw[off:off+n])
		off += n
	}
	if off != len(raw) {
		t.Fatalf("fixture: %d trailing bytes", len(raw)-off)
	}
	return packets
}

func TestPCMv4DecodesServerStream(t *testing.T) {
	packets := readV4Fixture(t)
	dec := NewPCMv4StreamDecoder()
	h := sha256.New()

	// Every distinct (rate, channels) the fixture goes through, in order. A
	// decoder that lost the carried-forward metadata would still hash correctly
	// if it only mislabelled the stream, so the labels are checked too.
	wantParams := [][2]int{{12000, 1}, {24000, 1}, {384000, 2}}
	var gotParams [][2]int

	for i, pkt := range packets {
		pcmLE, rate, channels, power, noise, err := dec.DecodePacketLE(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if len(pcmLE) == 0 {
			t.Fatalf("packet %d: decoded to nothing", i)
		}
		if len(pcmLE)%(2*channels) != 0 {
			t.Fatalf("packet %d: %d bytes is not whole frames of %d channels", i, len(pcmLE), channels)
		}
		// -999 is the "radiod reported nothing" sentinel; anything else must be
		// a plausible dBFS reading rather than a misread pair of bytes.
		for _, v := range []float32{power, noise} {
			if v != -999 && (v < -200 || v > 20) {
				t.Fatalf("packet %d: implausible signal quality %v", i, v)
			}
		}
		p := [2]int{rate, channels}
		if len(gotParams) == 0 || gotParams[len(gotParams)-1] != p {
			gotParams = append(gotParams, p)
		}
		h.Write(pcmLE)
	}

	if got := hex.EncodeToString(h.Sum(nil)); got != pcmv4ExpectedSHA {
		t.Fatalf("decoded samples differ from what the server encoded\n got %s\nwant %s", got, pcmv4ExpectedSHA)
	}
	if len(gotParams) != len(wantParams) {
		t.Fatalf("stream parameters: got %v, want %v", gotParams, wantParams)
	}
	for i := range wantParams {
		if gotParams[i] != wantParams[i] {
			t.Fatalf("stream parameters: got %v, want %v", gotParams, wantParams)
		}
	}
}

// A packet that arrives before any resynchronisation point cannot be decoded --
// nothing has said what the sample rate is, and the timestamp is a delta from a
// baseline that was never received. Guessing would be worse than failing, so
// this checks it fails, and then that the stream recovers at the next
// self-describing packet the way a reader entering a recording part-way does.
func TestPCMv4RejectsStreamJoinedMidway(t *testing.T) {
	packets := readV4Fixture(t)
	if len(packets) < 3 {
		t.Fatal("fixture too short")
	}

	dec := NewPCMv4StreamDecoder()
	if _, _, _, _, _, err := dec.DecodePacketLE(packets[1]); err == nil {
		t.Fatal("expected a delta packet before any metadata to be rejected")
	}

	// The server re-sends metadata every five seconds, so a recording joined at
	// random becomes readable within that. The fixture's last section steps the
	// timestamp 400 ms per packet for exactly this.
	recovered := false
	for i := len(packets) - 30; i < len(packets); i++ {
		if _, _, _, _, _, err := dec.DecodePacketLE(packets[i]); err == nil {
			recovered = true
			break
		}
	}
	if !recovered {
		t.Fatal("stream never resynchronised")
	}
}

// The two frame shapes share a socket and are told apart by the frame itself.
// PCMv4Magic's first byte is 0x50, which has bit 4 set, while an Opus header's
// first byte uses only bits 0 and 1 -- so the two cannot collide at all, and
// neither can be mistaken for a version 1-3 zstd frame.
func TestFrameDiscrimination(t *testing.T) {
	packets := readV4Fixture(t)
	for i, pkt := range packets {
		if !PCMv4IsHeader(pkt) {
			t.Fatalf("packet %d not recognised as version 4", i)
		}
		if isZstdFrame(pkt) {
			t.Fatalf("packet %d mistaken for a zstd frame", i)
		}
	}

	zstd := []byte{0x28, 0xB5, 0x2F, 0xFD, 0x00}
	if !isZstdFrame(zstd) || PCMv4IsHeader(zstd) {
		t.Fatal("zstd frame misclassified")
	}
	for _, short := range [][]byte{nil, {}, {0x50}, {0x50, 0x43, 0x4D}} {
		if PCMv4IsHeader(short) || isZstdFrame(short) {
			t.Fatalf("short frame %v misclassified", short)
		}
	}
}

// Version 4 Opus headers, against frames the server actually produced.
//
// testdata/opusv4_headers.bin carries each frame together with the field values
// that went into it, so this checks the parse rather than a hash: the header is
// change-tracked, and a field the encoder omitted because it had not changed
// must come back carried forward, not zero. Where the Opus packet begins is
// checked too -- version 4 headers are variable-length, and slicing at the old
// fixed 21 bytes would hand the decoder metadata as though it were audio.
func TestOpusV4HeaderMatchesServer(t *testing.T) {
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
		if off+n > len(raw) {
			t.Fatalf("fixture: truncated at %d", off)
		}
		b := raw[off : off+n]
		off += n
		return b
	}

	// Two decoders, each fed every frame exactly once. They cannot be shared:
	// reading a frame advances the delta baseline, so a second parse of the same
	// frame would apply its delta twice.
	dec := NewPCMv4HeaderDecoder()
	decParse := NewPCMv4HeaderDecoder()
	for i := 0; i < count; i++ {
		wantTS := binary.LittleEndian.Uint64(take(8))
		wantRate := int(binary.LittleEndian.Uint32(take(4)))
		wantCh := int(take(1)[0])
		wantPower := math.Float32frombits(binary.LittleEndian.Uint32(take(4)))
		wantNoise := math.Float32frombits(binary.LittleEndian.Uint32(take(4)))
		payload := take(int(binary.LittleEndian.Uint32(take(4))))
		frame := take(int(binary.LittleEndian.Uint32(take(4))))

		h, bodyOff, err := dec.DecodeOpus(frame)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if h.TimestampNanos != wantTS {
			t.Fatalf("frame %d: timestamp %d, want %d", i, h.TimestampNanos, wantTS)
		}
		if h.SampleRate != wantRate || h.Channels != wantCh {
			t.Fatalf("frame %d: %d Hz / %d ch, want %d / %d", i, h.SampleRate, h.Channels, wantRate, wantCh)
		}
		// Quality survives a round trip through centidecibels, so it is equal
		// to a hundredth of a dB rather than exactly; -999 is the sentinel and
		// must come back untouched.
		if !closeDB(h.BasebandPower, wantPower) || !closeDB(h.Noise, wantNoise) {
			t.Fatalf("frame %d: quality %v/%v, want %v/%v", i, h.BasebandPower, h.Noise, wantPower, wantNoise)
		}
		if got := frame[bodyOff:]; !bytes.Equal(got, payload) {
			t.Fatalf("frame %d: body offset %d yields %d bytes, want %d", i, bodyOff, len(got), len(payload))
		}

		// parseOpusFrame is what the receive path actually calls; it must agree.
		f, err := parseOpusFrame(frame, decParse)
		if err != nil {
			t.Fatalf("frame %d: parseOpusFrame: %v", i, err)
		}
		if f.sampleRate != wantRate || f.channels != wantCh || !bytes.Equal(f.opus, payload) {
			t.Fatalf("frame %d: parseOpusFrame disagrees with DecodeOpus", i)
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

// The version asked for at connect, pinned. This client reads version 4 and
// nothing else, so the request is not a preference to be negotiated down: a
// server that cannot serve it refuses the handshake, and one too old to refuse
// answers with a stream handleBinary recognises and reports.
func TestConnectAsksForVersion4(t *testing.T) {
	c := NewRadioClient()
	c.BaseURL = "http://receiver.example:8080"
	c.Mode = "usb"
	c.Frequency = 14074000

	u, err := c.buildWSURL()
	if err != nil {
		t.Fatalf("buildWSURL: %v", err)
	}
	if !strings.Contains(u, "version=4") {
		t.Fatalf("connect URL is %q, want version=4", u)
	}
}

// A pre-0.1.63 server clamps the requested version to 1-3 and serves version 1
// without saying so. Its lossless frames are zstd, which is what makes that
// recognisable rather than merely silent.
func TestLegacyServerIsReported(t *testing.T) {
	c := NewRadioClient()
	zstd := []byte{0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x11, 0x22}
	err := c.handleBinary(zstd)
	if err == nil {
		t.Fatal("a zstd frame was accepted")
	}
	if !strings.Contains(err.Error(), "protocol version 4") {
		t.Fatalf("unhelpful error %q", err)
	}
}
