package main

import (
	"encoding/binary"
	"testing"
)

// Tests for the silent body mode.
//
// A closed squelch substitutes all-zero PCM rather than dropping the packet,
// so a session left squelched sends nothing but zeros indefinitely. The mode
// says so in a flag instead of coding one stop bit per sample.
//
// The risk it introduces is state divergence: no body crosses the wire, so
// both ends must advance their predictors over the zeros independently and
// arrive at identical filters. Most of what follows is checking that.

func bigEndianPCM(samples []int16) []byte {
	b := make([]byte, len(samples)*2)
	for i, v := range samples {
		binary.BigEndian.PutUint16(b[2*i:], uint16(v))
	}
	return b
}

// A silent packet must carry no body and cost only its header.
func TestV4SilentPacketHasNoBody(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	ts := int64(1_700_000_000_000_000_000)

	silence := make([]byte, 240*2)
	var total int
	for i := 0; i < 100; i++ {
		wire, err := enc.EncodePacket(silence, ts, 12000, 1, -999, -999)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		total += len(pkt)

		h, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if !h.Silent {
			t.Fatalf("packet %d: silent flag not set", i)
		}
		if h.Escape {
			t.Fatalf("packet %d: escape and silent both set", i)
		}
		if len(samples) != 240 {
			t.Fatalf("packet %d: %d samples, want 240", i, len(samples))
		}
		for j, v := range samples {
			if v != 0 {
				t.Fatalf("packet %d sample %d: got %d, want 0", i, j, v)
			}
		}
		ts += 20_000_000
	}
	mean := float64(total) / 100
	t.Logf("silent packet averages %.1f bytes (coded silence was ~45, version 3 sends %d)",
		mean, PCMFullHeaderSizeV2+240*2)
	if mean > 15 {
		t.Errorf("silent packets average %.1f bytes; expected header-only, under 15", mean)
	}
}

// The whole point of the mode is that it stays lossless across the boundary in
// both directions. If the predictors diverged over the silence, the first real
// packet afterwards would decode wrongly.
func TestV4SilenceTransitionsStayLossless(t *testing.T) {
	packets := captureAsPackets(t, "usb-ft8-14074.bin")
	if len(packets) < 300 {
		t.Skip("capture too short")
	}
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	ts := int64(1_700_000_000_000_000_000)

	check := func(label string, pcm []byte, rate, ch int) {
		t.Helper()
		wire, err := enc.EncodePacket(pcm, ts, rate, ch, -85, -112)
		if err != nil {
			t.Fatalf("%s: encode: %v", label, err)
		}
		pkt := append([]byte(nil), wire...)
		_, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("%s: decode: %v", label, err)
		}
		for i := range samples {
			want := int16(binary.BigEndian.Uint16(pcm[2*i:]))
			if samples[i] != want {
				t.Fatalf("%s: sample %d got %d want %d — predictors diverged", label, i, samples[i], want)
			}
		}
		ts += 20_000_000
	}

	silence := make([]byte, 240*2)
	// Several cycles, so a divergence that only shows after repeated
	// transitions is caught too.
	for cycle := 0; cycle < 5; cycle++ {
		for _, p := range packets[cycle*40 : cycle*40+40] {
			check("audio", p.pcmData, p.sampleRate, p.channels)
		}
		for i := 0; i < 30; i++ {
			check("silence", silence, 12000, 1)
		}
	}
}

// A packet that is nearly silent must take the coded path. Detecting silence
// by scanning means a single non-zero sample anywhere has to disqualify it,
// including in the very last position.
func TestV4NearlySilentIsNotSilent(t *testing.T) {
	positions := []int{0, 1, 119, 238, 239}
	for _, pos := range positions {
		enc := NewPCMv4StreamEncoder()
		dec := NewPCMv4StreamDecoder()
		samples := make([]int16, 240)
		samples[pos] = 1 // the smallest possible non-zero sample
		pcm := bigEndianPCM(samples)

		wire, err := enc.EncodePacket(pcm, 1_700_000_000_000_000_000, 12000, 1, -85, -112)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		h, got, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("non-zero at %d: %v", pos, err)
		}
		if h.Silent {
			t.Fatalf("non-zero at %d was sent as silent — the sample would be lost", pos)
		}
		for i := range samples {
			if got[i] != samples[i] {
				t.Fatalf("non-zero at %d: sample %d got %d want %d", pos, i, got[i], samples[i])
			}
		}
	}
}

// Silence arrives at every sample rate and on both profiles.
func TestV4SilenceAcrossProfiles(t *testing.T) {
	cases := []struct {
		name     string
		rate     int
		channels int
		samples  int
	}{
		{"audio 12k", 12000, 1, 240},
		{"audio 24k", 24000, 1, 480},
		{"iq 12k", 12000, 2, 480},
		{"iq 384k", 384000, 2, 720},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			enc := NewPCMv4StreamEncoder()
			dec := NewPCMv4StreamDecoder()
			pcm := make([]byte, c.samples*2)
			ts := int64(1_700_000_000_000_000_000)
			for i := 0; i < 20; i++ {
				wire, err := enc.EncodePacket(pcm, ts, c.rate, c.channels, -999, -999)
				if err != nil {
					t.Fatal(err)
				}
				pkt := append([]byte(nil), wire...)
				h, samples, err := dec.DecodePacket(pkt)
				if err != nil {
					t.Fatal(err)
				}
				if !h.Silent {
					t.Fatalf("packet %d not marked silent", i)
				}
				if len(samples) != c.samples {
					t.Fatalf("packet %d: %d samples, want %d", i, len(samples), c.samples)
				}
				if h.Profile != ProfileForChannels(c.channels) {
					t.Fatalf("packet %d: wrong profile", i)
				}
				ts += 20_000_000
			}
		})
	}
}

// A packet claiming to be silent while carrying a body is malformed and must
// be rejected rather than half-interpreted.
func TestV4SilentWithBodyRejected(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	silence := make([]byte, 240*2)
	wire, err := enc.EncodePacket(silence, 1_700_000_000_000_000_000, 12000, 1, -85, -112)
	if err != nil {
		t.Fatal(err)
	}
	corrupt := append(append([]byte(nil), wire...), 0x42) // a body that should not be there

	dec := NewPCMv4StreamDecoder()
	if _, _, err := dec.DecodePacket(corrupt); err == nil {
		t.Fatal("a silent packet carrying a body was accepted")
	}
}

// Escape and silent describe the body in incompatible ways; a packet asserting
// both is malformed.
func TestV4EscapeAndSilentMutuallyExclusive(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	h := PCMv4Header{
		TimestampNanos: 1_700_000_000_000_000_000,
		SampleRate:     12000, Channels: 1, SampleCount: 240,
		BasebandPower: -85, Noise: -112,
		Profile: PredProfileAudio,
		Escape:  true, Silent: true,
	}
	pkt := e.AppendHeader(nil, h)
	d := NewPCMv4HeaderDecoder()
	if _, _, err := d.Decode(pkt); err == nil {
		t.Fatal("a header asserting both escape and silent was accepted")
	}
}

// The mode has to survive a resynchronisation, which re-sends metadata and a
// full timestamp while the stream is still silent.
func TestV4SilenceAcrossResync(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	enc.header.resyncNanos = 1_000_000_000
	dec := NewPCMv4StreamDecoder()

	silence := make([]byte, 240*2)
	ts := int64(1_700_000_000_000_000_000)
	resyncs := 0
	for i := 0; i < 150; i++ { // three seconds at 50 packets a second
		wire, err := enc.EncodePacket(silence, ts, 12000, 1, -999, -999)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		if pkt[4]&pcmv4FlagMetadata != 0 {
			resyncs++
		}
		h, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if !h.Silent || len(samples) != 240 {
			t.Fatalf("packet %d: silent packet malformed", i)
		}
		ts += 20_000_000
	}
	if resyncs < 3 {
		t.Errorf("expected periodic resynchronisation during silence, saw %d", resyncs)
	}
}

// What a squelched session actually costs, which is the reason for the mode.
func TestV4SquelchedSessionBandwidth(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	silence := make([]byte, 240*2)
	ts := int64(1_700_000_000_000_000_000)
	total := 0
	const packets = 500 // ten seconds at 50 packets a second
	for i := 0; i < packets; i++ {
		wire, err := enc.EncodePacket(silence, ts, 12000, 1, -999, -999)
		if err != nil {
			t.Fatal(err)
		}
		total += len(wire)
		ts += 20_000_000
	}
	kbPerSec := float64(total) / 10 / 1000
	v3 := float64(packets*(PCMFullHeaderSizeV2+240*2)) / 10 / 1000
	t.Logf("squelched session: %.2f kB/s (version 3 uncompressed %.2f, with zstd ~2.9)", kbPerSec, v3)
	if kbPerSec > 0.8 {
		t.Errorf("squelched session costs %.2f kB/s, expected under 0.8", kbPerSec)
	}
}

// Signal quality must keep flowing while the audio is silent.
//
// This is the reason version 3 forces a full header on every packet: the gate
// zeroes the samples but leaves basebandPower and noiseFigure untouched (see
// the audioGateAllows branches in websocket.go), so a closed squelch still
// reports what the band is doing and the client's meters keep moving.
//
// The silent mode must not break that. It removes the BODY, not the header --
// but a future change that tried to make silence cheaper by suppressing the
// header too would freeze every meter, so this pins the behaviour down.
func TestV4SilenceStillCarriesSignalQuality(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()

	silence := make([]byte, 240*2)
	ts := int64(1_700_000_000_000_000_000)

	// radiod updates its status at about 10 Hz, so at 50 packets a second a
	// reading holds for roughly five packets and then moves.
	readings := []struct{ power, noise float32 }{
		{-104.99, -116.36}, {-105.42, -115.88}, {-106.11, -116.02},
		{-104.73, -115.51}, {-107.20, -117.04}, {-105.88, -116.77},
	}

	seen := 0
	total := 0
	for i := 0; i < 300; i++ {
		r := readings[(i/5)%len(readings)]
		wire, err := enc.EncodePacket(silence, ts, 12000, 1, r.power, r.noise)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		total += len(pkt)

		h, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if !h.Silent {
			t.Fatalf("packet %d: expected a silent packet", i)
		}
		for _, v := range samples {
			if v != 0 {
				t.Fatalf("packet %d: audio is not silent", i)
			}
		}
		// The reading must arrive on every packet, whether or not it was
		// retransmitted: an unchanged one is carried forward by the decoder.
		if e := float64(h.BasebandPower) - float64(r.power); e > 0.005 || e < -0.005 {
			t.Fatalf("packet %d: power %.4f dBFS, want %.4f — meters would freeze",
				i, h.BasebandPower, r.power)
		}
		if e := float64(h.Noise) - float64(r.noise); e > 0.005 || e < -0.005 {
			t.Fatalf("packet %d: noise %.4f dBFS, want %.4f", i, h.Noise, r.noise)
		}
		if float64(h.BasebandPower) > -998 {
			seen++
		}
		ts += 20_000_000
	}
	if seen != 300 {
		t.Errorf("only %d of 300 silent packets carried a usable reading", seen)
	}
	kbPerSec := float64(total) / 6 / 1000
	t.Logf("squelched with live signal readings: %.2f kB/s across %d packets", kbPerSec, 300)
	if kbPerSec > 1.0 {
		t.Errorf("squelched session with readings costs %.2f kB/s, expected under 1.0", kbPerSec)
	}
}

// The 10 Hz signal-quality ticker fires when audio stalls entirely, and builds
// its own silence buffer. Those packets take the silent path too, and must
// still deliver the reading that is their entire purpose.
func TestV4TickerSilenceDeliversQuality(t *testing.T) {
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	// The ticker builds SampleRate/50 samples, matching a 20 ms Opus frame.
	silence := make([]byte, (12000/50)*2)
	ts := int64(1_700_000_000_000_000_000)

	for i := 0; i < 50; i++ {
		power := float32(-90.0 - float64(i)*0.25)
		wire, err := enc.EncodePacket(silence, ts, 12000, 1, power, -118.0)
		if err != nil {
			t.Fatal(err)
		}
		pkt := append([]byte(nil), wire...)
		h, _, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("ticker packet %d: %v", i, err)
		}
		if e := float64(h.BasebandPower) - float64(power); e > 0.005 || e < -0.005 {
			t.Fatalf("ticker packet %d: power %.4f, want %.4f", i, h.BasebandPower, power)
		}
		ts += 100_000_000 // 10 Hz
	}
}
