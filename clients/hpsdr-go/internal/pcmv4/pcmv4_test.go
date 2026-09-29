package pcmv4

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"testing"
)

// Conformance tests for the version 4 decoder, against packets the SERVER's
// encoder produced.
//
// The predictor is backward adaptive: the two ends derive their filter taps
// independently and never exchange a coefficient, so an arithmetic difference
// between this decoder and the server's produces plausible noise rather than an
// error. An HPSDR client would report that only as a receiver that had gone
// deaf. Comparing the samples is the only thing that notices.
//
// The fixtures and their hashes are the ones clients/hpsdr/test/run.sh checks
// the C decoder against, so both bridges are held to the same samples.
const (
	// A recorded stream: mono audio, silent packets, an escape to verbatim
	// samples, a sample-rate change, and the interleaved I/Q this bridge uses.
	streamSHA = "4875d2185f1ff5a2031386c569cac0c2259e6a827b9e61f813399a19c3b9c903"

	// The reduced-depth IQ mode --min-margin asks for: profile 2, a shift byte
	// ahead of the body, and the profile switching to plain IQ and back.
	scaledSHA = "7315366ceed3e70552c28d31cde690a14dc66f5244b5a8dc34a5e696f5698ccc"

	// A Rice codeword whose unary run is exactly 63 bits, counted out of a full
	// 64-bit accumulator so the decoder shifts by 64. Go defines that as zero
	// and C does not; it is here so a rewrite of the bit reader cannot quietly
	// regress it. Roughly one packet in a quarter of a million on live IQ.
	riceEdgeSHA = "3413109ff6d06d44fb8fa44c84595b776f5570f05663b762830853ddc0183527"
)

// readFixture returns the packets of a fixture file.
//
// Layout: "UV4F", a format byte, a uint32 packet count, then each packet as a
// uint32 length and that many bytes.
func readFixture(t *testing.T, path string) [][]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if len(raw) < 9 || string(raw[:4]) != "UV4F" || raw[4] != 0 {
		t.Fatal("fixture: bad header")
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

// decodeAll decodes every packet and returns the SHA-256 of the samples as
// little-endian int16, with the profiles seen along the way.
func decodeAll(t *testing.T, packets [][]byte) (string, map[byte]int, [][2]int) {
	t.Helper()
	dec := NewPCMv4StreamDecoder()
	h := sha256.New()
	profiles := map[byte]int{}
	var params [][2]int
	for i, pkt := range packets {
		if !PCMv4IsHeader(pkt) {
			t.Fatalf("packet %d not recognised as version 4", i)
		}
		hdr, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if len(samples) != hdr.SampleCount {
			t.Fatalf("packet %d: %d samples, header says %d", i, len(samples), hdr.SampleCount)
		}
		profiles[hdr.Profile]++
		p := [2]int{hdr.SampleRate, hdr.Channels}
		if len(params) == 0 || params[len(params)-1] != p {
			params = append(params, p)
		}
		buf := make([]byte, 2*len(samples))
		for j, s := range samples {
			binary.LittleEndian.PutUint16(buf[2*j:], uint16(s))
		}
		h.Write(buf)
	}
	return hex.EncodeToString(h.Sum(nil)), profiles, params
}

func TestDecodesServerStream(t *testing.T) {
	got, _, params := decodeAll(t, readFixture(t, "testdata/pcmv4_stream.bin"))
	if got != streamSHA {
		t.Fatalf("decoded samples differ from what the server encoded\n got %s\nwant %s", got, streamSHA)
	}
	// A decoder that lost the carried-forward metadata could still hash
	// correctly while mislabelling the stream, and the rate is what decides the
	// scaling and the reconnect.
	want := [][2]int{{12000, 1}, {24000, 1}, {384000, 2}}
	if len(params) != len(want) {
		t.Fatalf("stream parameters: got %v, want %v", params, want)
	}
	for i := range want {
		if params[i] != want[i] {
			t.Fatalf("stream parameters: got %v, want %v", params, want)
		}
	}
}

func TestDecodesScaledStream(t *testing.T) {
	got, profiles, _ := decodeAll(t, readFixture(t, "testdata/pcmv4_scaled.bin"))
	if got != scaledSHA {
		t.Fatalf("decoded samples differ from what the server encoded\n got %s\nwant %s", got, scaledSHA)
	}
	// Both profiles, or the fixture stopped covering the switch between them and
	// this test quietly became the lossless one.
	if profiles[PredProfileIQScaled] == 0 || profiles[PredProfileIQ] == 0 {
		t.Fatalf("fixture no longer covers both profiles: %v", profiles)
	}
}

func TestDecodesRiceEdge(t *testing.T) {
	got, _, _ := decodeAll(t, readFixture(t, "testdata/pcmv4_rice_edge.bin"))
	if got != riceEdgeSHA {
		t.Fatalf("decoded samples differ from what the server encoded\n got %s\nwant %s", got, riceEdgeSHA)
	}
}

// A truncated packet must be refused rather than read past: every length in the
// header comes off the wire. These are the cuts run.sh makes.
func TestTruncatedPacketsAreRefused(t *testing.T) {
	first := readFixture(t, "testdata/pcmv4_stream.bin")[0]
	for _, cut := range []int{1, 2, 3, 5, 8, 16, 40} {
		n := 9 + cut - 13 // run.sh cuts the FILE: 9 bytes of fixture header, 4 of length
		if n <= 0 || n >= len(first) {
			continue
		}
		if _, _, err := NewPCMv4StreamDecoder().DecodePacket(first[:n]); err == nil {
			t.Errorf("a packet cut to %d of %d bytes was accepted", n, len(first))
		}
	}
	// And every prefix of a resynchronisation packet, not only those.
	for n := 0; n < len(first); n++ {
		if _, _, err := NewPCMv4StreamDecoder().DecodePacket(first[:n]); err == nil {
			t.Fatalf("a packet cut to %d of %d bytes was accepted", n, len(first))
		}
	}
}

// A scaled packet whose shift byte is missing must be refused rather than read
// as the first byte of the body.
func TestScaledRejectsMissingShift(t *testing.T) {
	packets := readFixture(t, "testdata/pcmv4_scaled.bin")
	hdr, _, err := NewPCMv4StreamDecoder().DecodePacket(packets[0])
	if err != nil {
		t.Fatalf("packet 0: %v", err)
	}
	if hdr.Profile != PredProfileIQScaled {
		t.Skip("fixture no longer opens with a scaled packet")
	}
	_, off, err := NewPCMv4HeaderDecoder().Decode(packets[0])
	if err != nil {
		t.Fatalf("header: %v", err)
	}
	if _, _, err := NewPCMv4StreamDecoder().DecodePacket(packets[0][:off]); err == nil {
		t.Fatal("a scaled packet with no shift byte was accepted")
	}
}

// Random garbage must produce errors, never a panic: the bytes come off a
// socket.
func TestGarbageDoesNotPanic(t *testing.T) {
	packets := readFixture(t, "testdata/pcmv4_stream.bin")
	var seed uint32 = 1
	for i := 0; i < 2000; i++ {
		pkt := append([]byte(nil), packets[i%len(packets)]...)
		for j := 5; j < len(pkt); j++ {
			seed = seed*1664525 + 1013904223
			if seed>>28 == 0 {
				pkt[j] = byte(seed >> 8)
			}
		}
		dec := NewPCMv4StreamDecoder()
		_, _, _ = dec.DecodePacket(packets[0])
		_, _, _ = dec.DecodePacket(pkt)
	}
}

// A server too old for version 4 answers with the zstd-wrapped version 1 shape.
func TestLegacyServerFramesAreRecognised(t *testing.T) {
	zstd := []byte{0x28, 0xB5, 0x2F, 0xFD, 0x00}
	if !IsZstdFrame(zstd) || PCMv4IsHeader(zstd) {
		t.Error("a zstd frame was misclassified")
	}
	for _, pkt := range readFixture(t, "testdata/pcmv4_stream.bin") {
		if IsZstdFrame(pkt) {
			t.Fatal("a version 4 packet read as zstd")
		}
	}
	for _, short := range [][]byte{nil, {}, {0x50}, {0x50, 0x43, 0x4D}} {
		if PCMv4IsHeader(short) || IsZstdFrame(short) {
			t.Errorf("short frame %v misclassified", short)
		}
	}
}
