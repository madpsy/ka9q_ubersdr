package main

import (
	"encoding/binary"
	"math"
	"testing"
)

// End-to-end tests of the assembled version 4 packet: header plus coded body,
// through the same encoder and decoder a connection would use.
//
// The pieces are tested separately elsewhere. What these check is the seam --
// that the header's sample count actually drives the codec, that a profile
// switch reaches both halves, and that a packet is self-contained.

// capturePackets turns a capture file into the arguments streamAudio passes,
// namely the raw big-endian payload plus its metadata.
type capturePacket struct {
	pcmData    []byte
	gpsTimeNs  int64
	sampleRate int
	channels   int
	power      float32
	noise      float32
}

func captureAsPackets(t *testing.T, name string) []capturePacket {
	t.Helper()
	var out []capturePacket
	for _, pkt := range loadTestCapture(t, name) {
		if binary.LittleEndian.Uint16(pkt) != PCMBinaryMagicFull {
			continue
		}
		out = append(out, capturePacket{
			pcmData:    pkt[PCMFullHeaderSizeV2:],
			gpsTimeNs:  int64(binary.LittleEndian.Uint64(pkt[4:12])),
			sampleRate: int(binary.LittleEndian.Uint32(pkt[20:24])),
			channels:   int(pkt[24]),
			power:      math.Float32frombits(binary.LittleEndian.Uint32(pkt[25:29])),
			noise:      math.Float32frombits(binary.LittleEndian.Uint32(pkt[29:33])),
		})
	}
	if len(out) == 0 {
		t.Fatalf("%s yielded no full-header packets", name)
	}
	return out
}

// The samples that come out must be the samples that went in, and the wire
// packet must be smaller than what version 3 sends.
func TestPCMv4StreamRoundTrip(t *testing.T) {
	cases := []struct {
		file    string
		v3Bytes int // header + payload, what version 3 puts on the wire
	}{
		{"iq384-ft8-14074.bin", 0},
		{"iq12k-ft8-14074.bin", 0},
		{"iq384-mw-carriers.bin", 0},
		{"usb-ft8-14074.bin", 0},
		{"cw-14025.bin", 0},
		{"am-14074.bin", 0},
		{"nfm-14074.bin", 0},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			packets := captureAsPackets(t, c.file)
			enc := NewPCMv4StreamEncoder()
			dec := NewPCMv4StreamDecoder()

			var v3Total, v4Total int
			for n, p := range packets {
				wire, err := enc.EncodePacket(p.pcmData, p.gpsTimeNs, p.sampleRate,
					p.channels, p.power, p.noise)
				if err != nil {
					t.Fatalf("packet %d: encode: %v", n, err)
				}
				// The encoder reuses its buffer, so copy before decoding.
				pkt := append([]byte(nil), wire...)
				v4Total += len(pkt)
				v3Total += PCMFullHeaderSizeV2 + len(p.pcmData)

				h, samples, err := dec.DecodePacket(pkt)
				if err != nil {
					t.Fatalf("packet %d: decode: %v", n, err)
				}
				if h.SampleRate != p.sampleRate || h.Channels != p.channels {
					t.Fatalf("packet %d: metadata %d/%d, want %d/%d",
						n, h.SampleRate, h.Channels, p.sampleRate, p.channels)
				}
				if h.TimestampNanos != uint64(p.gpsTimeNs) {
					t.Fatalf("packet %d: timestamp not preserved", n)
				}
				want := len(p.pcmData) / 2
				if p.channels == 2 && want%2 != 0 {
					want-- // a truncated final frame is dropped by the encoder
				}
				if len(samples) != want {
					t.Fatalf("packet %d: %d samples, want %d", n, len(samples), want)
				}
				for i := 0; i < want; i++ {
					got := int16(binary.BigEndian.Uint16(p.pcmData[2*i:]))
					if samples[i] != got {
						t.Fatalf("packet %d sample %d: got %d, want %d — not lossless",
							n, i, samples[i], got)
					}
				}
				// Signal quality must survive to within the quantisation step.
				if float64(p.power) > -998 {
					if e := math.Abs(float64(h.BasebandPower - p.power)); e > 0.005 {
						t.Fatalf("packet %d: power off by %.4f dB", n, e)
					}
				} else if float64(h.BasebandPower) > -998 {
					t.Fatalf("packet %d: sentinel lost", n)
				}
			}
			saved := 100 * (1 - float64(v4Total)/float64(v3Total))
			t.Logf("%d packets: v3 %d bytes -> v4 %d bytes (%.1f%% saved, %.3fx)",
				len(packets), v3Total, v4Total, saved, float64(v3Total)/float64(v4Total))
			if v4Total >= v3Total {
				t.Errorf("v4 is not smaller than v3: %d vs %d", v4Total, v3Total)
			}
		})
	}
}

// A mode change alters channels, which changes the predictor form. Both halves
// must switch, and the stream must stay lossless across the boundary.
func TestPCMv4StreamProfileSwitch(t *testing.T) {
	segments := []string{
		"iq384-ft8-14074.bin",
		"usb-ft8-14074.bin",
		"iq12k-ft8-14074.bin",
		"am-14074.bin",
	}
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()

	for si, file := range segments {
		for n, p := range captureAsPackets(t, file) {
			wire, err := enc.EncodePacket(p.pcmData, p.gpsTimeNs, p.sampleRate,
				p.channels, p.power, p.noise)
			if err != nil {
				t.Fatalf("segment %d packet %d: %v", si, n, err)
			}
			pkt := append([]byte(nil), wire...)
			h, samples, err := dec.DecodePacket(pkt)
			if err != nil {
				t.Fatalf("segment %d packet %d: decode: %v", si, n, err)
			}
			wantProfile := ProfileForChannels(p.channels)
			if h.Profile != wantProfile {
				t.Fatalf("segment %d packet %d: profile %d, want %d",
					si, n, h.Profile, wantProfile)
			}
			for i := range samples {
				want := int16(binary.BigEndian.Uint16(p.pcmData[2*i:]))
				if samples[i] != want {
					t.Fatalf("segment %d packet %d sample %d: not lossless", si, n, i)
				}
			}
		}
	}
}

// Packets dropped before the encoder -- audio.go skips them when a slow client
// backs the channel up -- must not desynchronise the stream.
func TestPCMv4StreamDropTolerance(t *testing.T) {
	packets := captureAsPackets(t, "iq384-mw-carriers.bin")
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	for n, p := range packets {
		if n%11 == 0 {
			continue // never reached the encoder
		}
		wire, err := enc.EncodePacket(p.pcmData, p.gpsTimeNs, p.sampleRate,
			p.channels, p.power, p.noise)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		_, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", n, err)
		}
		for i := range samples {
			if samples[i] != int16(binary.BigEndian.Uint16(p.pcmData[2*i:])) {
				t.Fatalf("packet %d: desynced after drops", n)
			}
		}
	}
}

// Sample counts vary in real traffic; the header must carry the change.
func TestPCMv4StreamVaryingSampleCount(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	ts := int64(1_700_000_000_000_000_000)
	sizes := []int{720, 720, 240, 720, 240, 240, 720}
	for n, size := range sizes {
		pcm := make([]byte, size*2)
		for i := 0; i < size; i++ {
			binary.BigEndian.PutUint16(pcm[2*i:], uint16(int16(i*7-1000)))
		}
		wire, err := enc.EncodePacket(pcm, ts, 384000, 2, -77.6, -93.6)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		h, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d (%d samples): %v", n, size, err)
		}
		if h.SampleCount != size {
			t.Fatalf("packet %d: header says %d samples, sent %d", n, h.SampleCount, size)
		}
		if len(samples) != size {
			t.Fatalf("packet %d: decoded %d samples, sent %d", n, len(samples), size)
		}
		ts += 909_050
	}
}

// A v4 packet must be recognisable among Opus frames on the same socket.
func TestPCMv4StreamIsIdentifiable(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	pcm := make([]byte, 480)
	wire, err := enc.EncodePacket(pcm, 1_700_000_000_000_000_000, 12000, 1, -80, -110)
	if err != nil {
		t.Fatal(err)
	}
	if !PCMv4IsHeader(wire) {
		t.Error("an assembled v4 packet was not recognised as one")
	}
}

func BenchmarkPCMv4StreamEncodeIQ384(b *testing.B) {
	benchmarkStream(b, "iq384-ft8-14074.bin")
}

func BenchmarkPCMv4StreamEncodeAudio(b *testing.B) {
	benchmarkStream(b, "usb-ft8-14074.bin")
}

func benchmarkStream(b *testing.B, name string) {
	packets := captureAsPackets(&testing.T{}, name)
	enc := NewPCMv4StreamEncoder()
	b.SetBytes(int64(len(packets[0].pcmData)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p := packets[i%len(packets)]
		if _, err := enc.EncodePacket(p.pcmData, p.gpsTimeNs, p.sampleRate,
			p.channels, p.power, p.noise); err != nil {
			b.Fatal(err)
		}
	}
}
