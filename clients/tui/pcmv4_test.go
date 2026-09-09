package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"testing"
)

// Conformance test for the lossless receive path.
//
// testdata/pcmv4_stream.bin is a real packet stream produced by the SERVER's
// encoder (PCMv4StreamEncoder in the repository root), and pcmv4ExpectedSHA is
// the SHA-256 of the samples that went into it, little-endian. Decoding the one
// and getting the other is the whole lossless claim, checked against the
// implementation that has to agree rather than against this one's own idea of
// the format.
//
// It is a golden fixture rather than a round trip because this client has no
// encoder: it decodes only, so a round trip here would prove nothing but that
// the file is consistent with itself. That is also what makes the test worth
// its 180 kB — a drift between the two implementations is invisible until audio
// turns to noise, and this is what would catch it. The same fixture and the
// same hash are used by the other Go clients, so a change to pcm_predictive.go
// that breaks one breaks all of them at once.
//
// The stream covers what the format can do: ordinary mono audio, silent packets
// carrying no body, the return to signal afterwards (where a predictor left out
// of step would show), an escape to verbatim samples on incompressible noise, a
// sample-rate change, a switch to interleaved I/Q that rebuilds the codec onto
// the complex profile, and a varying packet length across the five-second
// periodic resynchronisation.
const pcmv4ExpectedSHA = "4875d2185f1ff5a2031386c569cac0c2259e6a827b9e61f813399a19c3b9c903"

// pcmv4ScaledSHA is the same for testdata/pcmv4_scaled.bin, the reduced-depth
// IQ stream that -min-margin asks for: profile 2, where a shift byte leads the
// body and the samples come back shifted left by it.
//
// It covers the paths that exist only there — a shift that changes as the
// margin does, a silent packet that carries no shift at all, an escape that
// carries one, and the profile switching to plain IQ and back when the margin
// goes to lossless. Getting the shift wrong does not fail; it delivers a signal
// several bits too quiet, which is exactly the kind of thing only a hash
// notices.
const pcmv4ScaledSHA = "7315366ceed3e70552c28d31cde690a14dc66f5244b5a8dc34a5e696f5698ccc"

// readV4Fixture returns the packets in testdata/pcmv4_stream.bin.
//
// Layout: "UV4F", a format byte, a uint32 packet count, then each packet as a
// uint32 length and that many bytes.
func readV4Fixture(t *testing.T) [][]byte {
	return readV4FixtureFile(t, "testdata/pcmv4_stream.bin")
}

func readV4FixtureFile(t *testing.T, path string) [][]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
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
	dec := newPCMStreamDecoder()
	h := sha256.New()

	// Every distinct (rate, channels) the fixture goes through, in order. A
	// decoder that lost the carried-forward metadata would still hash correctly
	// if it only mislabelled the stream, so the labels are checked too.
	wantParams := [][2]int{{12000, 1}, {24000, 1}, {384000, 2}}
	var gotParams [][2]int

	var buf [2]byte
	for i, pkt := range packets {
		hdr, samples, err := dec.decode(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if len(samples) == 0 {
			t.Fatalf("packet %d: decoded to nothing", i)
		}
		if len(samples)%hdr.Channels != 0 {
			t.Fatalf("packet %d: %d samples is not whole frames of %d channels", i, len(samples), hdr.Channels)
		}
		if len(samples) != hdr.SampleCount {
			t.Fatalf("packet %d: %d samples, header said %d", i, len(samples), hdr.SampleCount)
		}
		// -999 is the "radiod reported nothing" sentinel; anything else must be
		// a plausible dBFS reading rather than a misread pair of bytes.
		for _, v := range []float32{hdr.Power, hdr.Noise} {
			if v != -999 && (v < -200 || v > 20) {
				t.Fatalf("packet %d: implausible signal quality %v", i, v)
			}
		}
		p := [2]int{hdr.SourceRate, hdr.Channels}
		if len(gotParams) == 0 || gotParams[len(gotParams)-1] != p {
			gotParams = append(gotParams, p)
		}
		for _, s := range samples {
			binary.LittleEndian.PutUint16(buf[:], uint16(s))
			h.Write(buf[:])
		}
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

	dec := newPCMStreamDecoder()
	if _, _, err := dec.decode(packets[1]); err == nil {
		t.Fatal("expected a delta packet before any metadata to be rejected")
	}

	// The server re-sends metadata every five seconds, so a recording joined at
	// random becomes readable within that. The fixture's last section steps the
	// timestamp 400 ms per packet for exactly this.
	recovered := false
	for i := len(packets) - 30; i < len(packets); i++ {
		if _, _, err := dec.decode(packets[i]); err == nil {
			recovered = true
			break
		}
	}
	if !recovered {
		t.Fatal("stream never resynchronised")
	}
}

// The two frame shapes share a socket and are told apart by the frame itself,
// so every packet the server produced must read as lossless and none of them as
// Opus.
func TestFixtureFramesReadAsLossless(t *testing.T) {
	for i, pkt := range readV4Fixture(t) {
		magic, ok := frameIsLossless(pkt)
		if !ok {
			t.Fatalf("packet %d not recognised as lossless", i)
		}
		if magic != losslessMagic {
			t.Fatalf("packet %d carries magic 0x%08x, want the version 4 one", i, magic)
		}
	}
}

// An unknown profile id must fail rather than fall back to profile 0. Decoding
// with the wrong predictor returns plausible-sounding noise instead of an
// error, which is the worst possible behaviour for a codec whose whole promise
// is bit-exactness.
func TestPCMv4RejectsUnknownProfile(t *testing.T) {
	// A resynchronisation point: magic, flags (metadata | count | profile 7),
	// a full timestamp, the count, the rate and the channel count.
	pkt := []byte{0x50, 0x43, 0x4D, 0x34, pcmFlagMetadata | pcmFlagCount | 0x07}
	pkt = append(pkt, make([]byte, 8)...)
	pkt = binary.AppendUvarint(pkt, 240)
	pkt = binary.AppendUvarint(pkt, 12000)
	pkt = append(pkt, 1, 0x00, 0x00)

	if _, _, err := newPCMStreamDecoder().decode(pkt); err == nil {
		t.Fatal("a packet declaring an unimplemented profile was accepted")
	}
}

// The reduced-depth IQ stream decodes to exactly what the server decoded, and
// takes the profile through both rebuilds on the way.
func TestPCMv4DecodesScaledStream(t *testing.T) {
	packets := readV4FixtureFile(t, "testdata/pcmv4_scaled.bin")
	dec := newPCMStreamDecoder()
	h := sha256.New()

	profiles := map[byte]int{}
	var buf [2]byte
	for i, pkt := range packets {
		hdr, samples, err := dec.decode(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		profiles[hdr.Profile]++
		if hdr.Channels != 2 {
			t.Fatalf("packet %d: %d channels, want interleaved I/Q", i, hdr.Channels)
		}
		for _, s := range samples {
			binary.LittleEndian.PutUint16(buf[:], uint16(s))
			h.Write(buf[:])
		}
	}

	if got := hex.EncodeToString(h.Sum(nil)); got != pcmv4ScaledSHA {
		t.Fatalf("decoded samples differ from what the server encoded\n got %s\nwant %s", got, pcmv4ScaledSHA)
	}
	// Both profiles must have been exercised, or the fixture stopped covering
	// the switch between them and this test quietly became the lossless one.
	if profiles[PredProfileIQScaled] == 0 || profiles[PredProfileIQ] == 0 {
		t.Fatalf("fixture no longer covers both profiles: %v", profiles)
	}
}

// A scaled packet whose shift byte is missing must be refused rather than read
// as the first byte of the body, which would decode as noise.
func TestPCMv4ScaledRejectsMissingShift(t *testing.T) {
	packets := readV4FixtureFile(t, "testdata/pcmv4_scaled.bin")

	hdr, _, err := newPCMStreamDecoder().decode(packets[0])
	if err != nil {
		t.Fatalf("packet 0: %v", err)
	}
	if hdr.Profile != PredProfileIQScaled {
		t.Skip("fixture no longer opens with a scaled packet")
	}
	_, off, err := newPCMHeaderDecoder().decode(packets[0])
	if err != nil {
		t.Fatalf("header: %v", err)
	}
	if _, _, err := newPCMStreamDecoder().decode(packets[0][:off]); err == nil {
		t.Fatal("a scaled packet with no shift byte was accepted")
	}
}
