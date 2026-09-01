package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Tests against real captured traffic.
//
// The round-trip tests in pcm_predictive_test.go use synthetic signals, which
// are enough to exercise the logic but not enough to trust it: every bug found
// while developing this codec came from a property of real RF that a generator
// does not reproduce. These run the codec over packets a live receiver
// actually sent. See testdata/pcm_predictive/README.md.

// loadTestCapture reads a length-prefixed capture file.
func loadTestCapture(t *testing.T, name string) [][]byte {
	t.Helper()
	path := filepath.Join("testdata", "pcm_predictive", name)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading capture %s: %v", path, err)
	}
	var out [][]byte
	for i := 0; i+4 <= len(b); {
		n := int(binary.LittleEndian.Uint32(b[i:]))
		i += 4
		if n <= 0 || i+n > len(b) {
			t.Fatalf("capture %s is malformed at offset %d", name, i)
		}
		out = append(out, b[i:i+n])
		i += n
	}
	if len(out) == 0 {
		t.Fatalf("capture %s contains no packets", name)
	}
	return out
}

// captureSamples extracts the PCM payload of a version 1-3 binary packet.
// Samples are big-endian on the wire, as radiod produces them.
func captureSamples(t *testing.T, pkt []byte) []int16 {
	t.Helper()
	if len(pkt) < 13 {
		t.Fatalf("packet too short: %d bytes", len(pkt))
	}
	header := PCMMinimalHeaderSize
	if binary.LittleEndian.Uint16(pkt) == PCMBinaryMagicFull {
		header = PCMFullHeaderSizeV2
	}
	if len(pkt) <= header {
		t.Fatalf("packet has no payload: %d bytes with a %d-byte header", len(pkt), header)
	}
	data := pkt[header:]
	s := make([]int16, len(data)/2)
	for i := range s {
		s[i] = int16(binary.BigEndian.Uint16(data[2*i:]))
	}
	return s
}

// capture describes one file and what the codec is expected to achieve on it.
//
// minRatio is a floor rather than an exact value, so retuning a profile is
// free to improve things but a regression that loses a meaningful fraction of
// the gain fails the build. Each floor sits about 5% under the ratio measured
// when the file was added, recorded alongside it.
//
// These are PAYLOAD ratios: samples in against coded body out, with no header
// counted either side. The end-to-end saving on the wire is lower, since a
// packet also carries its metadata header -- see the figures in
// pcm_predictive.go, which include it.
var predictiveCaptures = []struct {
	file     string
	profile  byte
	minRatio float64
	measured float64
}{
	{"iq384-ft8-14074.bin", PredProfileIQ, 1.41, 1.488},
	{"iq12k-ft8-14074.bin", PredProfileIQ, 1.33, 1.408},
	{"iq384-mw-carriers.bin", PredProfileIQ, 1.79, 1.890},
	{"iq384-quiet-band.bin", PredProfileIQ, 1.47, 1.550},
	{"usb-ft8-14074.bin", PredProfileAudio, 1.81, 1.905},
	{"lsb-voice-7150.bin", PredProfileAudio, 2.16, 2.278},
	{"cw-14025.bin", PredProfileAudio, 4.19, 4.411},
	{"am-14074.bin", PredProfileAudio, 1.62, 1.706},
	{"nfm-14074.bin", PredProfileAudio, 1.34, 1.413},
}

// TestPredictiveCapturesAreLossless is the one that matters: every packet a
// real receiver sent must come back bit for bit.
//
// Encoder and decoder are separate instances, as they are on opposite ends of
// a connection, so this also checks that their independent adaptation stays in
// step across the whole stream.
func TestPredictiveCapturesAreLossless(t *testing.T) {
	for _, c := range predictiveCaptures {
		t.Run(c.file, func(t *testing.T) {
			packets := loadTestCapture(t, c.file)
			enc, err := NewPredictiveCodec(c.profile)
			if err != nil {
				t.Fatal(err)
			}
			dec, err := NewPredictiveCodec(c.profile)
			if err != nil {
				t.Fatal(err)
			}
			var raw, coded int64
			for n, pkt := range packets {
				samples := captureSamples(t, pkt)
				raw += int64(len(samples) * 2)

				payload, err := enc.Encode(samples)
				if err != nil {
					t.Fatalf("packet %d: encode: %v", n, err)
				}
				coded += int64(len(payload))

				got, err := dec.Decode(payload, len(samples))
				if err != nil {
					t.Fatalf("packet %d: decode: %v", n, err)
				}
				for i := range samples {
					if got[i] != samples[i] {
						t.Fatalf("packet %d sample %d: got %d, want %d — not lossless",
							n, i, got[i], samples[i])
					}
				}
			}
			ratio := float64(raw) / float64(coded)
			t.Logf("%d packets, %d -> %d bytes, %.3fx payload ratio (%.3fx when added)",
				len(packets), raw, coded, ratio, c.measured)
			if ratio < c.minRatio {
				t.Errorf("compression regressed: %.3fx, floor is %.3fx", ratio, c.minRatio)
			}
		})
	}
}

// TestPredictiveCaptureProfilesAreDeclared checks the self-description
// contract on real traffic: a receiver told nothing about the mode must be
// able to decode purely from what each payload declares.
func TestPredictiveCaptureProfilesAreDeclared(t *testing.T) {
	for _, c := range predictiveCaptures {
		t.Run(c.file, func(t *testing.T) {
			packets := loadTestCapture(t, c.file)
			enc, err := NewPredictiveCodec(c.profile)
			if err != nil {
				t.Fatal(err)
			}
			// The receiver builds its codec from the declaration alone.
			var dec *PredictiveCodec
			for n, pkt := range packets {
				samples := captureSamples(t, pkt)
				payload, err := enc.Encode(samples)
				if err != nil {
					t.Fatal(err)
				}
				id, ok := PredictiveProfileID(payload)
				if !ok {
					t.Fatalf("packet %d: no profile id", n)
				}
				if id != c.profile {
					t.Fatalf("packet %d: declared profile %d, encoder is %d", n, id, c.profile)
				}
				if dec == nil {
					dec, err = NewPredictiveCodec(id)
					if err != nil {
						t.Fatal(err)
					}
				}
				if _, err := dec.Decode(payload, len(samples)); err != nil {
					t.Fatalf("packet %d: decode: %v", n, err)
				}
			}
		})
	}
}

// TestPredictiveCaptureSwitchingProfiles walks a stream that changes between
// IQ and audio mid-flight, as a session does when the operator changes mode,
// using real packets on both sides of each switch.
func TestPredictiveCaptureSwitchingProfiles(t *testing.T) {
	segments := []struct {
		file    string
		profile byte
	}{
		{"iq384-ft8-14074.bin", PredProfileIQ},
		{"usb-ft8-14074.bin", PredProfileAudio},
		{"iq12k-ft8-14074.bin", PredProfileIQ},
		{"cw-14025.bin", PredProfileAudio},
		{"am-14074.bin", PredProfileAudio},
	}

	var enc, dec *PredictiveCodec
	var encProfile, decProfile byte
	var err error

	for si, seg := range segments {
		if enc == nil || seg.profile != encProfile {
			enc, err = NewPredictiveCodec(seg.profile)
			if err != nil {
				t.Fatal(err)
			}
			encProfile = seg.profile
		}
		for n, pkt := range loadTestCapture(t, seg.file) {
			samples := captureSamples(t, pkt)
			payload, err := enc.Encode(samples)
			if err != nil {
				t.Fatalf("segment %d packet %d: %v", si, n, err)
			}
			id, _ := PredictiveProfileID(payload)
			if dec == nil || id != decProfile {
				dec, err = NewPredictiveCodec(id)
				if err != nil {
					t.Fatal(err)
				}
				decProfile = id
			}
			got, err := dec.Decode(payload, len(samples))
			if err != nil {
				t.Fatalf("segment %d packet %d: decode: %v", si, n, err)
			}
			for i := range samples {
				if got[i] != samples[i] {
					t.Fatalf("segment %d packet %d sample %d: not lossless", si, n, i)
				}
			}
		}
	}
}

// TestPredictiveCaptureDropTolerance drops packets before they reach the
// encoder, which is what audio.go does when a slow client backs the channel
// up. Both ends see the same sequence, so the stream must stay exact.
func TestPredictiveCaptureDropTolerance(t *testing.T) {
	packets := loadTestCapture(t, "iq384-mw-carriers.bin")
	enc, err := NewPredictiveCodec(PredProfileIQ)
	if err != nil {
		t.Fatal(err)
	}
	dec, err := NewPredictiveCodec(PredProfileIQ)
	if err != nil {
		t.Fatal(err)
	}
	for n, pkt := range packets {
		if n%13 == 0 {
			continue // never reached the encoder
		}
		samples := captureSamples(t, pkt)
		payload, err := enc.Encode(samples)
		if err != nil {
			t.Fatal(err)
		}
		got, err := dec.Decode(payload, len(samples))
		if err != nil {
			t.Fatal(err)
		}
		for i := range samples {
			if got[i] != samples[i] {
				t.Fatalf("packet %d sample %d: desynced after drops", n, i)
			}
		}
	}
}

func BenchmarkPredictiveCaptureIQ384(b *testing.B) {
	benchmarkCapture(b, "iq384-ft8-14074.bin", PredProfileIQ)
}

func BenchmarkPredictiveCaptureAudio12k(b *testing.B) {
	benchmarkCapture(b, "usb-ft8-14074.bin", PredProfileAudio)
}

func benchmarkCapture(b *testing.B, name string, profile byte) {
	path := filepath.Join("testdata", "pcm_predictive", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		b.Skipf("capture unavailable: %v", err)
	}
	var packets [][]int16
	for i := 0; i+4 <= len(raw); {
		n := int(binary.LittleEndian.Uint32(raw[i:]))
		i += 4
		if n <= 0 || i+n > len(raw) {
			break
		}
		pkt := raw[i : i+n]
		i += n
		header := PCMMinimalHeaderSize
		if binary.LittleEndian.Uint16(pkt) == PCMBinaryMagicFull {
			header = PCMFullHeaderSizeV2
		}
		data := pkt[header:]
		s := make([]int16, len(data)/2)
		for j := range s {
			s[j] = int16(binary.BigEndian.Uint16(data[2*j:]))
		}
		packets = append(packets, s)
	}
	enc, err := NewPredictiveCodec(profile)
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(packets[0]) * 2))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := enc.Encode(packets[i%len(packets)]); err != nil {
			b.Fatal(err)
		}
	}
}

var _ = fmt.Sprintf
