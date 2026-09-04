package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"testing"
)

// Conformance test for the version 4 receive path.
//
// testdata/pcmv4_stream.bin is a packet stream the SERVER's encoder produced,
// and pcmv4ExpectedSHA is the SHA-256 of the samples that went into it, little
// endian, exactly as this bridge renders them before converting to the uint8
// offset-binary pairs rtl_tcp wants.
//
// It earns its 90 kB. The version 4 predictor is backward adaptive: the two
// ends derive their filter taps independently from the samples already coded
// and never exchange a coefficient, so any arithmetic difference between this
// decoder and the Go one on the server produces plausible noise rather than an
// error. Nothing short of comparing the samples would catch it, and an rtl_tcp
// client would only report it as a receiver that suddenly hears nothing.
//
// The stream covers what the format can do: ordinary mono audio, silent packets
// carrying no body, an escape to verbatim samples on incompressible noise, a
// sample-rate change, and the interleaved I/Q this bridge actually uses --
// including the varying packet length that makes the header's sample count
// necessary, across the five-second periodic resynchronisation.
const pcmv4ExpectedSHA = "4875d2185f1ff5a2031386c569cac0c2259e6a827b9e61f813399a19c3b9c903"

// pcmv4ScaledSHA is the same for testdata/pcmv4_scaled.bin, which is the
// reduced-depth mode -min-margin asks for: profile 2, where a shift byte leads
// the body and the samples come back shifted left by it.
//
// It covers the paths that exist only there and nowhere in the stream above -- a
// shift that changes as the margin does, a silent packet that carries no shift
// at all, an escape that carries one, and the profile switching to plain IQ and
// back when the margin goes to lossless -- against the samples the server's own
// encoder and decoder agreed on. Getting the shift wrong does not fail; it
// delivers a signal several bits too quiet, which is exactly the kind of thing
// only a hash notices.
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

func TestPCMv4DecodesServerStream(t *testing.T) {
	packets := readV4Fixture(t)
	dec := NewPCMv4StreamDecoder()
	h := sha256.New()

	// Every distinct (rate, channels) the fixture passes through, in order. A
	// decoder that lost the carried-forward metadata could still hash correctly
	// while mislabelling the stream, and the sample rate is what this bridge
	// reports to its rtl_tcp client.
	wantParams := [][2]int{{12000, 1}, {24000, 1}, {384000, 2}}
	var gotParams [][2]int

	for i, pkt := range packets {
		if !PCMv4IsHeader(pkt) {
			t.Fatalf("packet %d not recognised as version 4", i)
		}
		pcmLE, rate, channels, _, _, err := dec.DecodePacketLE(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if len(pcmLE) == 0 || len(pcmLE)%(2*channels) != 0 {
			t.Fatalf("packet %d: %d bytes is not whole frames of %d channels", i, len(pcmLE), channels)
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

// The reduced-depth stream decodes to exactly what the server decoded, and takes
// the profile through both rebuilds on the way.
func TestPCMv4DecodesScaledStream(t *testing.T) {
	packets := readV4FixtureFile(t, "testdata/pcmv4_scaled.bin")
	dec := NewPCMv4StreamDecoder()
	h := sha256.New()

	profiles := map[byte]int{}
	for i, pkt := range packets {
		if !PCMv4IsHeader(pkt) {
			t.Fatalf("packet %d not recognised as version 4", i)
		}
		hdr, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		profiles[hdr.Profile]++
		if hdr.Channels != 2 {
			t.Fatalf("packet %d: %d channels, want interleaved I/Q", i, hdr.Channels)
		}
		buf := make([]byte, 2*len(samples))
		for j, s := range samples {
			binary.LittleEndian.PutUint16(buf[2*j:], uint16(s))
		}
		h.Write(buf)
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
	dec := NewPCMv4StreamDecoder()

	// The first packet is a resynchronisation point, so it carries the whole
	// header and the shift immediately after it. Cutting the packet to the
	// header alone leaves a scaled packet with nothing behind it.
	hdr, _, err := dec.DecodePacket(packets[0])
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

// The decoded I/Q must survive the conversion this bridge exists to do. A
// stereo v4 packet is interleaved int16 pairs, which convertPCMToUint8IQ folds
// to one offset-binary byte each; getting the pairing wrong would swap I and Q
// or halve the rate, neither of which the hash above would notice.
func TestDecodedIQConvertsToRTLTCPPairs(t *testing.T) {
	packets := readV4Fixture(t)
	dec := NewPCMv4StreamDecoder()

	converted := 0
	for _, pkt := range packets {
		pcmLE, _, channels, _, _, err := dec.DecodePacketLE(pkt)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if channels != 2 {
			continue
		}
		iq := convertPCMToUint8IQ(pcmLE)
		// Two int16 in, two uint8 out: one byte per component, both channels.
		if len(iq) != len(pcmLE)/2 {
			t.Fatalf("%d bytes of PCM became %d bytes of IQ, want %d",
				len(pcmLE), len(iq), len(pcmLE)/2)
		}
		converted++
	}
	if converted == 0 {
		t.Fatal("the fixture carried no I/Q packets")
	}
}

// A server too old for version 4 answers with the zstd-wrapped version 1 shape.
// Recognising it is what lets the bridge say why rather than logging a bad
// magic for every packet.
func TestLegacyServerFramesAreRecognised(t *testing.T) {
	zstd := []byte{0x28, 0xB5, 0x2F, 0xFD, 0x00}
	if !isZstdFrame(zstd) || PCMv4IsHeader(zstd) {
		t.Error("a zstd frame was misclassified")
	}
	for _, pkt := range readV4Fixture(t) {
		if isZstdFrame(pkt) {
			t.Fatal("a version 4 packet read as zstd")
		}
	}
	for _, short := range [][]byte{nil, {}, {0x50}, {0x50, 0x43, 0x4D}} {
		if PCMv4IsHeader(short) || isZstdFrame(short) {
			t.Errorf("short frame %v misclassified", short)
		}
	}
}
