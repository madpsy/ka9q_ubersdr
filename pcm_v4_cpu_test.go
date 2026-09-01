package main

import (
	"encoding/binary"
	"fmt"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// What the two protocol versions cost the SERVER, on real captured traffic.
//
// Version 4 saves bandwidth by predicting each sample from the ones before it,
// which is arithmetic version 3 does not do: version 3 hands the whole packet
// to zstd, which decides the samples are incompressible and copies them. So
// the saving is not free, and this measures the price in the only terms that
// matter for a receiver serving many sessions at once -- the fraction of a core
// one session costs, at the packet rate its mode actually delivers.
//
// The comparison is like for like. Version 3 is timed with the compression
// level the server really uses: SpeedFastest for IQ and SpeedDefault for
// demodulated audio, which is what SetFastMode selects per packet in
// websocket.go. Timing version 3 at the wrong level would flatter one side.

// pcmCPUCase is one stream, with the packet rate measured from a live receiver.
type pcmCPUCase struct {
	file    string
	label   string
	rate    float64 // packets per second
	isIQ    bool
	profile byte
}

var pcmCPUCases = []pcmCPUCase{
	{"usb-ft8-14074.bin", "audio 12k (USB)", 49.95, false, PredProfileAudio},
	{"am-14074.bin", "audio 24k (AM)", 50.0, false, PredProfileAudio},
	{"cw-14025.bin", "audio 12k (CW)", 49.95, false, PredProfileAudio},
	{"iq12k-ft8-14074.bin", "iq 12k", 49.9, true, PredProfileIQ},
	{"iq384-ft8-14074.bin", "iq 384k", 1098.9, true, PredProfileIQ},
}

// TestPCMEncodeCPUComparison reports encode cost per packet and per session for
// both versions, and fails if version 4 has drifted into territory that would
// change the shape of the trade.
func TestPCMEncodeCPUComparison(t *testing.T) {
	fmt.Printf("\n%-18s %11s %11s %8s | %11s %11s | %9s\n",
		"stream", "v3 us/pkt", "v4 us/pkt", "ratio", "v3 %core", "v4 %core", "wire saved")
	fmt.Printf("%s\n", "------------------------------------------------------------------------------------------")

	var worstCore float64
	var worstLabel string
	for _, c := range pcmCPUCases {
		packets := loadTestCapture(t, c.file)
		type packet struct {
			pcm        []byte
			ts         int64
			sampleRate int
			channels   int
			power      float32
			noise      float32
		}
		var in []packet
		for _, p := range packets {
			if binary.LittleEndian.Uint16(p) != PCMBinaryMagicFull {
				continue
			}
			in = append(in, packet{
				pcm:        p[PCMFullHeaderSizeV2:],
				ts:         int64(binary.LittleEndian.Uint64(p[4:12])),
				sampleRate: int(binary.LittleEndian.Uint32(p[20:24])),
				channels:   int(p[24]),
				power:      float32frombits(binary.LittleEndian.Uint32(p[25:29])),
				noise:      float32frombits(binary.LittleEndian.Uint32(p[29:33])),
			})
		}
		if len(in) == 0 {
			t.Fatalf("%s: no full-header packets", c.file)
		}

		const reps = 5

		// --- version 3: the whole packet through zstd, at the level the
		// server selects for this kind of stream.
		v3enc := NewPCMBinaryEncoderWithVersionAndLevel(c.isIQ, PCMBinaryVersion3)
		defer v3enc.Close()
		var v3Bytes int64
		for _, p := range in {
			pkt, err := v3enc.EncodePCMPacketWithSignalQuality(
				p.pcm, p.ts, p.sampleRate, p.channels, p.power, p.noise,
				fullPCMHeaderAlways(c.isIQ, 3))
			if err != nil {
				t.Fatal(err)
			}
			v3Bytes += int64(len(pkt))
		}
		t0 := time.Now()
		for r := 0; r < reps; r++ {
			e := NewPCMBinaryEncoderWithVersionAndLevel(c.isIQ, PCMBinaryVersion3)
			for _, p := range in {
				e.EncodePCMPacketWithSignalQuality(
					p.pcm, p.ts, p.sampleRate, p.channels, p.power, p.noise,
					fullPCMHeaderAlways(c.isIQ, 3))
			}
			e.Close()
		}
		v3Us := float64(time.Since(t0).Nanoseconds()) / float64(reps*len(in)) / 1000

		// --- version 4
		v4enc := NewPCMv4StreamEncoder()
		var v4Bytes int64
		for _, p := range in {
			pkt, err := v4enc.EncodePacket(p.pcm, p.ts, p.sampleRate, p.channels, p.power, p.noise)
			if err != nil {
				t.Fatal(err)
			}
			v4Bytes += int64(len(pkt))
		}
		t1 := time.Now()
		for r := 0; r < reps; r++ {
			e := NewPCMv4StreamEncoder()
			for _, p := range in {
				e.EncodePacket(p.pcm, p.ts, p.sampleRate, p.channels, p.power, p.noise)
			}
		}
		v4Us := float64(time.Since(t1).Nanoseconds()) / float64(reps*len(in)) / 1000

		v3Core := v3Us * c.rate / 10000
		v4Core := v4Us * c.rate / 10000
		saved := 100 * (1 - float64(v4Bytes)/float64(v3Bytes))
		if v4Core > worstCore {
			worstCore, worstLabel = v4Core, c.label
		}
		fmt.Printf("%-18s %10.1f %10.1f %7.1fx | %10.2f%% %10.2f%% | %8.1f%%\n",
			c.label, v3Us, v4Us, v4Us/v3Us, v3Core, v4Core, saved)

		if saved <= 0 {
			t.Errorf("%s: version 4 is not smaller on the wire (%.1f%%)", c.label, saved)
		}
	}

	fmt.Printf("\nworst case: %s at %.2f%% of a core per session\n", worstLabel, worstCore)
	fmt.Printf("a receiver serving 20 such sessions would spend %.1f%% of one core encoding\n\n", worstCore*20)

	// The trade is bandwidth for CPU, and it only holds while the CPU stays
	// small enough that a receiver can serve many sessions. Ten percent of a
	// core for the widest IQ stream leaves room for ten of them on one core,
	// which is well beyond what any single receiver delivers at 384 kHz.
	if worstCore > 10 {
		t.Errorf("worst case %.1f%% of a core (%s) is beyond what this trade was measured to be worth",
			worstCore, worstLabel)
	}
}

// TestPCMDecodeCPUComparison measures the other side. The server never decodes,
// but every Go client does -- iq-recorder, rtl_sdr, ubersdr-audio and the
// SoapySDR driver all run this path -- and on a small machine feeding a decoder
// chain that cost matters as much as the encoder's.
func TestPCMDecodeCPUComparison(t *testing.T) {
	zdec, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer zdec.Close()

	fmt.Printf("\n%-18s %11s %11s %8s | %11s %11s\n",
		"stream", "v3 us/pkt", "v4 us/pkt", "ratio", "v3 %core", "v4 %core")
	fmt.Printf("%s\n", "--------------------------------------------------------------------------")

	for _, c := range pcmCPUCases {
		packets := loadTestCapture(t, c.file)
		var v3wire, v4wire [][]byte

		v3enc := NewPCMBinaryEncoderWithVersionAndLevel(c.isIQ, PCMBinaryVersion3)
		v4enc := NewPCMv4StreamEncoder()
		var counts []int
		for _, p := range packets {
			if binary.LittleEndian.Uint16(p) != PCMBinaryMagicFull {
				continue
			}
			pcm := p[PCMFullHeaderSizeV2:]
			ts := int64(binary.LittleEndian.Uint64(p[4:12]))
			rate := int(binary.LittleEndian.Uint32(p[20:24]))
			ch := int(p[24])
			pw := float32frombits(binary.LittleEndian.Uint32(p[25:29]))
			ns := float32frombits(binary.LittleEndian.Uint32(p[29:33]))

			a, err := v3enc.EncodePCMPacketWithSignalQuality(pcm, ts, rate, ch, pw, ns,
				fullPCMHeaderAlways(c.isIQ, 3))
			if err != nil {
				t.Fatal(err)
			}
			v3wire = append(v3wire, append([]byte(nil), a...))

			b, err := v4enc.EncodePacket(pcm, ts, rate, ch, pw, ns)
			if err != nil {
				t.Fatal(err)
			}
			v4wire = append(v4wire, append([]byte(nil), b...))
			n := len(pcm) / 2
			if ch == 2 && n%2 != 0 {
				n--
			}
			counts = append(counts, n)
		}
		v3enc.Close()

		const reps = 5
		t0 := time.Now()
		for r := 0; r < reps; r++ {
			for _, pkt := range v3wire {
				plain, err := zdec.DecodeAll(pkt, nil)
				if err != nil {
					t.Fatal(err)
				}
				// what a client does with it: pull the samples out
				body := plain[PCMFullHeaderSizeV2:]
				for i := 0; i+1 < len(body); i += 2 {
					_ = int16(binary.BigEndian.Uint16(body[i:]))
				}
			}
		}
		v3Us := float64(time.Since(t0).Nanoseconds()) / float64(reps*len(v3wire)) / 1000

		t1 := time.Now()
		for r := 0; r < reps; r++ {
			d := NewPCMv4StreamDecoder()
			for i, pkt := range v4wire {
				if _, _, err := d.DecodePacket(pkt); err != nil {
					t.Fatalf("%s packet %d: %v", c.label, i, err)
				}
			}
		}
		v4Us := float64(time.Since(t1).Nanoseconds()) / float64(reps*len(v4wire)) / 1000
		_ = counts

		fmt.Printf("%-18s %10.1f %10.1f %7.1fx | %10.2f%% %10.2f%%\n",
			c.label, v3Us, v4Us, v4Us/v3Us,
			v3Us*c.rate/10000, v4Us*c.rate/10000)
	}
	fmt.Println()
}

func float32frombits(b uint32) float32 { return mathFloat32frombits(b) }
