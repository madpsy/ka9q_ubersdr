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
// endian, exactly as this recorder writes them into the WAV body.
//
// It earns its 90 kB. The version 4 predictor is backward adaptive: the two
// ends derive their filter taps independently from the samples already coded
// and never exchange a coefficient, so any arithmetic difference between this
// decoder and the Go one on the server produces plausible noise rather than an
// error. Nothing short of comparing the samples would catch it, and an
// unattended recording would only report it as a WAV full of hiss.
//
// The stream covers what the format can do: ordinary mono audio, silent packets
// carrying no body, an escape to verbatim samples on incompressible noise, a
// sample-rate change, and the interleaved I/Q this recorder actually captures --
// including the varying packet length that makes the header's sample count
// necessary, across the five-second periodic resynchronisation.
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
	if len(raw) < 9 || string(raw[:4]) != "UV4F" {
		t.Fatal("fixture: bad header")
	}
	count := int(binary.LittleEndian.Uint32(raw[5:9]))
	packets := make([][]byte, 0, count)
	off := 9
	for i := 0; i < count; i++ {
		if off+4 > len(raw) {
			t.Fatalf("fixture: truncated at packet %d", i)
		}
		n := int(binary.LittleEndian.Uint32(raw[off:]))
		off += 4
		if off+n > len(raw) {
			t.Fatalf("fixture: truncated body at packet %d", i)
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
	// while mislabelling the stream, and the sample rate is what goes into the
	// WAV header -- where getting it wrong is a file that plays back at the
	// wrong speed rather than a file that fails to open.
	wantParams := [][2]int{{12000, 1}, {24000, 1}, {384000, 2}}
	var gotParams [][2]int

	for i, pkt := range packets {
		if !PCMv4IsHeader(pkt) {
			t.Fatalf("packet %d not recognised as version 4", i)
		}
		pcmLE, rate, channels, _, err := dec.DecodePacketLE(pkt)
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

// The timestamp is what multi-instance recordings are aligned on, so it has to
// survive the move from the version 1 fixed header to the version 4 delta.
// Version 4 sends an absolute timestamp at each resynchronisation point and a
// signed varint delta in between; a decoder that dropped the carry-forward
// would still return samples, and the alignment would silently trim the wrong
// number of them off the front of every file.
func TestPCMv4TimestampsAdvanceMonotonically(t *testing.T) {
	packets := readV4Fixture(t)
	dec := NewPCMv4StreamDecoder()

	var last uint64
	seen := 0
	for i, pkt := range packets {
		_, rate, channels, ts, err := dec.DecodePacketLE(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if ts == 0 {
			t.Fatalf("packet %d carried no timestamp", i)
		}
		if last != 0 && ts < last {
			t.Fatalf("packet %d went backwards in time: %d after %d", i, ts, last)
		}
		// A recorder that read the rate but not the channel count would size
		// its frames wrong; both are needed to turn a timestamp into a sample
		// offset during alignment.
		if rate <= 0 || channels <= 0 {
			t.Fatalf("packet %d: implausible stream parameters (%d Hz, %d channels)", i, rate, channels)
		}
		last = ts
		seen++
	}
	if seen == 0 {
		t.Fatal("the fixture carried no packets")
	}
}

// A server too old for version 4 answers with the zstd-wrapped version 1 shape.
// Recognising it is what lets the recorder say why rather than logging a bad
// magic for every packet and leaving an empty WAV behind.
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
