package main

import (
	"encoding/binary"
	"math"
	"testing"
)

// The version 4 Opus header.
//
// Opus and the lossless path share a socket -- the server picks the format per
// packet -- so most of what matters here is that the two remain
// distinguishable while carrying their common fields identically.

func opusHeader(ts uint64) PCMv4Header {
	return PCMv4Header{
		TimestampNanos: ts,
		SampleRate:     12000,
		Channels:       1,
		BasebandPower:  -84.82,
		Noise:          -113.09,
	}
}

func TestOpusV4HeaderRoundTrip(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	d := NewPCMv4HeaderDecoder()
	ts := uint64(1_700_000_000_000_000_000)
	for i := 0; i < 200; i++ {
		h := opusHeader(ts)
		if i%7 == 0 {
			h.BasebandPower = float32(-84.82 - float64(i)*0.01)
			h.Noise = float32(-113.09 + float64(i)*0.02)
		}
		pkt := e.AppendOpusHeader(nil, h)
		got, off, err := d.DecodeOpus(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if off != len(pkt) {
			t.Fatalf("packet %d: body offset %d, header was %d bytes", i, off, len(pkt))
		}
		if got.TimestampNanos != h.TimestampNanos {
			t.Fatalf("packet %d: timestamp not preserved", i)
		}
		if got.SampleRate != h.SampleRate || got.Channels != h.Channels {
			t.Fatalf("packet %d: metadata %d/%d, want %d/%d",
				i, got.SampleRate, got.Channels, h.SampleRate, h.Channels)
		}
		if e := math.Abs(float64(got.BasebandPower - h.BasebandPower)); e > 0.005 {
			t.Fatalf("packet %d: power off by %.4f dB", i, e)
		}
		if e := math.Abs(float64(got.Noise - h.Noise)); e > 0.005 {
			t.Fatalf("packet %d: noise off by %.4f dB", i, e)
		}
		ts += 20_000_000
	}
}

// The reason the Opus header needs no magic of its own. A receiver sorts frames
// by elimination, so the hazard is an Opus header being read as a lossless one.
// The flags byte uses only bits 0 and 1, so it cannot reach 0x50 -- the first
// byte of PCMv4Magic, which has bit 4 set.
func TestOpusV4HeaderCannotCollideWithPCM(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	ts := uint64(1_700_000_000_000_000_000)
	// Every combination the encoder can produce: with and without a
	// resynchronisation, with and without a quality change.
	for i := 0; i < 500; i++ {
		h := opusHeader(ts)
		if i%3 == 0 {
			h.BasebandPower = float32(-84.0 - float64(i)*0.01)
		}
		if i%50 == 0 {
			h.SampleRate = 12000 + (i%2)*12000 // force a metadata resync
		}
		pkt := e.AppendOpusHeader(nil, h)
		if PCMv4IsHeader(pkt) {
			t.Fatalf("packet %d was identified as a lossless v4 frame (flags 0x%02x)", i, pkt[0])
		}
		if pkt[0] > 0x03 {
			t.Fatalf("packet %d: flags byte 0x%02x uses bits outside 0-1, which is what makes the collision impossible", i, pkt[0])
		}
		ts += 20_000_000
	}

	// And the converse: a lossless frame must never parse as an Opus header
	// without being noticed. Its first byte is 0x50, which sets reserved bits.
	pcm := NewPCMv4HeaderEncoder()
	pcmPkt := pcm.AppendHeader(nil, PCMv4Header{
		TimestampNanos: ts, SampleRate: 12000, Channels: 1, SampleCount: 240,
		BasebandPower: -80, Noise: -110, Profile: PredProfileAudio,
	})
	d := NewPCMv4HeaderDecoder()
	if _, _, err := d.DecodeOpus(pcmPkt); err == nil {
		t.Error("a lossless packet was accepted as an Opus header")
	}
}

// Signal quality must be encoded exactly as the lossless path encodes it: the
// readings come from the same source, and a second encoding would be a second
// place to get the -999 sentinel wrong.
func TestOpusV4QualityMatchesLosslessPath(t *testing.T) {
	values := []float32{-84.82, -113.09, 0, -133.66, 55.84, -999,
		float32(math.NaN()), float32(math.Inf(-1))}
	for _, v := range values {
		oe := NewPCMv4HeaderEncoder()
		od := NewPCMv4HeaderDecoder()
		pe := NewPCMv4HeaderEncoder()
		pd := NewPCMv4HeaderDecoder()
		ts := uint64(1_700_000_000_000_000_000)

		oh := opusHeader(ts)
		oh.BasebandPower, oh.Noise = v, v
		og, _, err := od.DecodeOpus(oe.AppendOpusHeader(nil, oh))
		if err != nil {
			t.Fatalf("opus %v: %v", v, err)
		}

		ph := PCMv4Header{TimestampNanos: ts, SampleRate: 12000, Channels: 1,
			SampleCount: 240, BasebandPower: v, Noise: v, Profile: PredProfileAudio}
		pg, _, err := pd.Decode(pe.AppendHeader(nil, ph))
		if err != nil {
			t.Fatalf("pcm %v: %v", v, err)
		}

		if og.BasebandPower != pg.BasebandPower || og.Noise != pg.Noise {
			t.Errorf("input %v: opus decoded %v/%v, lossless decoded %v/%v — the two encodings differ",
				v, og.BasebandPower, og.Noise, pg.BasebandPower, pg.Noise)
		}
	}
}

// Quality must not be retransmitted while it is unchanged, which is where most
// of the saving comes from.
func TestOpusV4QualityCarriedForward(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	d := NewPCMv4HeaderDecoder()
	ts := uint64(1_700_000_000_000_000_000)
	first := opusHeader(ts)
	e.AppendOpusHeader(nil, first)
	d.DecodeOpus(e.AppendOpusHeader(nil, first))

	e2 := NewPCMv4HeaderEncoder()
	d2 := NewPCMv4HeaderDecoder()
	d2.DecodeOpus(e2.AppendOpusHeader(nil, opusHeader(ts)))
	sent := 0
	for i := 0; i < 50; i++ {
		ts += 20_000_000
		pkt := e2.AppendOpusHeader(nil, opusHeader(ts))
		if pkt[0]&opusv4FlagQuality != 0 {
			sent++
		}
		got, _, err := d2.DecodeOpus(pkt)
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(float64(got.BasebandPower-first.BasebandPower)) > 0.005 {
			t.Fatalf("packet %d: power not carried forward (%v)", i, got.BasebandPower)
		}
	}
	if sent != 0 {
		t.Errorf("quality retransmitted %d times despite not changing", sent)
	}
}

// A reader joining part-way through must recover at the next resynchronisation
// rather than guess at a sample rate.
func TestOpusV4PeriodicResync(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	e.resyncNanos = 1_000_000_000
	d := NewPCMv4HeaderDecoder()
	ts := uint64(1_700_000_000_000_000_000)
	var packets [][]byte
	for i := 0; i < 150; i++ {
		pkt := e.AppendOpusHeader(nil, opusHeader(ts))
		packets = append(packets, pkt)
		if _, _, err := d.DecodeOpus(pkt); err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		ts += 20_000_000
	}
	fresh := NewPCMv4HeaderDecoder()
	recovered := -1
	for i := 40; i < len(packets); i++ {
		if _, _, err := fresh.DecodeOpus(packets[i]); err == nil {
			recovered = i
			break
		}
	}
	if recovered < 0 {
		t.Fatal("a decoder joining mid-stream never recovered")
	}
	if float64(recovered-40)*0.02 > 1.05 {
		t.Errorf("recovery took %.2f s, longer than the resync interval", float64(recovered-40)*0.02)
	}
}

// Malformed headers arrive from the network on the client side.
func TestOpusV4RejectsMalformed(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	valid := e.AppendOpusHeader(nil, opusHeader(1_700_000_000_000_000_000))
	cases := []struct {
		name string
		pkt  []byte
	}{
		{"empty", nil},
		{"flags only", valid[:1]},
		{"truncated timestamp", valid[:4]},
		{"truncated metadata", valid[:10]},
		{"reserved bits set", append([]byte{0xf0}, valid[1:]...)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := NewPCMv4HeaderDecoder()
			if _, _, err := d.DecodeOpus(tc.pkt); err == nil {
				t.Errorf("expected an error for %s", tc.name)
			}
		})
	}
}

// The saving, on the packet cadence a real stream uses.
func TestOpusV4HeaderSize(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	ts := uint64(1_700_000_000_000_000_000)
	total := 0
	const n = 1000 // twenty seconds at 50 packets a second
	for i := 0; i < n; i++ {
		h := opusHeader(ts)
		// radiod updates its readings at about 10 Hz, so a reading holds for
		// roughly five packets: this is what the live streams look like.
		if i%5 == 0 {
			h.BasebandPower = float32(-84.0 - float64(i%37)*0.05)
			h.Noise = float32(-113.0 + float64(i%23)*0.03)
		}
		total += len(e.AppendOpusHeader(nil, h))
		ts += 20_000_000
	}
	mean := float64(total) / n
	t.Logf("mean Opus header %.2f bytes (version 3 sends 21), saving %.2f kB/s at 50 packets a second",
		mean, (21-mean)*50/1000)
	if mean > 8 {
		t.Errorf("Opus header averaged %.2f bytes, expected well under the 21 it replaces", mean)
	}
}

var _ = binary.LittleEndian
