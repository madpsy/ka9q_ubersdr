package main

import (
	"encoding/binary"
	"math"
	"testing"
)

// A header the encoder will treat as an ordinary continuation.
func baseHeader(ts uint64) PCMv4Header {
	return PCMv4Header{
		TimestampNanos: ts,
		SampleRate:     384000,
		Channels:       2,
		SampleCount:    720,
		BasebandPower:  -77.61,
		Noise:          -93.63,
		Profile:        PredProfileIQ,
	}
}

func encodeDecode(t *testing.T, e *PCMv4HeaderEncoder, d *PCMv4HeaderDecoder, h PCMv4Header) (PCMv4Header, int) {
	t.Helper()
	pkt := e.AppendHeader(nil, h)
	got, off, err := d.Decode(pkt)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if off != len(pkt) {
		t.Fatalf("body offset %d, header was %d bytes", off, len(pkt))
	}
	return got, len(pkt)
}

// Everything the header carries must survive a round trip, including the
// fields the encoder chooses not to repeat.
func TestPCMv4HeaderRoundTrip(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	d := NewPCMv4HeaderDecoder()

	ts := uint64(1_700_000_000_000_000_000)
	for i := 0; i < 200; i++ {
		h := baseHeader(ts)
		// vary the readings so both the changed and unchanged paths are used
		if i%7 == 0 {
			h.BasebandPower = float32(-77.61 - float64(i)*0.01)
			h.Noise = float32(-93.63 + float64(i)*0.02)
		}
		got, _ := encodeDecode(t, e, d, h)

		if got.TimestampNanos != h.TimestampNanos {
			t.Fatalf("packet %d: timestamp %d, want %d", i, got.TimestampNanos, h.TimestampNanos)
		}
		if got.SampleRate != h.SampleRate || got.Channels != h.Channels {
			t.Fatalf("packet %d: metadata %d/%d, want %d/%d",
				i, got.SampleRate, got.Channels, h.SampleRate, h.Channels)
		}
		if got.Profile != h.Profile {
			t.Fatalf("packet %d: profile %d, want %d", i, got.Profile, h.Profile)
		}
		if e := math.Abs(float64(got.BasebandPower - h.BasebandPower)); e > 0.005 {
			t.Fatalf("packet %d: power off by %.4f dB", i, e)
		}
		if e := math.Abs(float64(got.Noise - h.Noise)); e > 0.005 {
			t.Fatalf("packet %d: noise off by %.4f dB", i, e)
		}
		ts += 909_050 // a typical iq384 gap
	}
}

// A mode change alters rate and channels mid-stream and must resynchronise.
func TestPCMv4HeaderMetadataChange(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	d := NewPCMv4HeaderDecoder()
	ts := uint64(1_700_000_000_000_000_000)

	h := baseHeader(ts)
	encodeDecode(t, e, d, h)

	ts += 909_050
	h2 := PCMv4Header{
		TimestampNanos: ts, SampleRate: 12000, Channels: 1, SampleCount: 240,
		BasebandPower: -85.0, Noise: -112.4, Profile: PredProfileAudio,
	}
	got, _ := encodeDecode(t, e, d, h2)
	if got.SampleRate != 12000 || got.Channels != 1 {
		t.Fatalf("metadata change not carried: %d/%d", got.SampleRate, got.Channels)
	}
	if got.Profile != PredProfileAudio {
		t.Fatalf("profile %d, want %d", got.Profile, PredProfileAudio)
	}

	// and it keeps carrying forward afterwards
	ts += 20_000_000
	h3 := h2
	h3.TimestampNanos = ts
	got, _ = encodeDecode(t, e, d, h3)
	if got.SampleRate != 12000 || got.Channels != 1 {
		t.Fatalf("metadata not carried forward: %d/%d", got.SampleRate, got.Channels)
	}
}

// Metadata must reappear on its own every resync interval, so a reader can
// enter a recording part-way through.
func TestPCMv4HeaderPeriodicResync(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	e.resyncNanos = 1_000_000_000 // 1s, to keep the test short
	d := NewPCMv4HeaderDecoder()

	ts := uint64(1_700_000_000_000_000_000)
	const step = 20_000_000 // 20 ms, i.e. 50 packets a second
	resyncs := 0
	var packets [][]byte
	for i := 0; i < 150; i++ { // three seconds
		h := baseHeader(ts)
		h.SampleRate, h.Channels = 12000, 1
		pkt := e.AppendHeader(nil, h)
		packets = append(packets, pkt)
		if pkt[4]&pcmv4FlagMetadata != 0 {
			resyncs++
		}
		if _, _, err := d.Decode(pkt); err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		ts += step
	}
	// first packet plus one per second
	if resyncs < 3 || resyncs > 5 {
		t.Errorf("got %d resync points over 3 seconds, expected 3-4", resyncs)
	}

	// A reader that joins at an arbitrary offset must recover at the next one.
	fresh := NewPCMv4HeaderDecoder()
	recovered := -1
	for i := 40; i < len(packets); i++ {
		if _, _, err := fresh.Decode(packets[i]); err == nil {
			recovered = i
			break
		}
	}
	if recovered < 0 {
		t.Fatal("a decoder joining mid-stream never recovered")
	}
	t.Logf("joined at packet 40, recovered at packet %d (%.2f s later)",
		recovered, float64(recovered-40)*float64(step)/1e9)
	if float64(recovered-40)*float64(step)/1e9 > 1.05 {
		t.Errorf("recovery took longer than the resync interval")
	}
}

// A backwards or wildly advanced timestamp means the stream is not continuous
// where a delta would assume it is; the encoder must resynchronise instead.
func TestPCMv4HeaderTimestampDiscontinuity(t *testing.T) {
	for _, tc := range []struct {
		name string
		jump func(uint64) uint64
	}{
		{"backwards", func(ts uint64) uint64 { return ts - 5_000_000_000 }},
		{"far forward", func(ts uint64) uint64 { return ts + 60_000_000_000 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := NewPCMv4HeaderEncoder()
			d := NewPCMv4HeaderDecoder()
			ts := uint64(1_700_000_000_000_000_000)
			encodeDecode(t, e, d, baseHeader(ts))

			jumped := baseHeader(tc.jump(ts))
			pkt := e.AppendHeader(nil, jumped)
			if pkt[4]&pcmv4FlagMetadata == 0 {
				t.Error("expected a resynchronisation after a discontinuity")
			}
			got, _, err := d.Decode(pkt)
			if err != nil {
				t.Fatal(err)
			}
			if got.TimestampNanos != jumped.TimestampNanos {
				t.Fatalf("timestamp %d, want %d", got.TimestampNanos, jumped.TimestampNanos)
			}
		})
	}
}

// The -999 sentinel, and non-finite values, must arrive as "no reading".
func TestPCMv4HeaderQualitySentinel(t *testing.T) {
	cases := []struct {
		name  string
		value float32
	}{
		{"server sentinel", -999},
		{"NaN", float32(math.NaN())},
		{"negative infinity", float32(math.Inf(-1))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := NewPCMv4HeaderEncoder()
			d := NewPCMv4HeaderDecoder()
			h := baseHeader(1_700_000_000_000_000_000)
			h.BasebandPower = tc.value
			h.Noise = tc.value
			got, _ := encodeDecode(t, e, d, h)
			if float64(got.BasebandPower) > -998 {
				t.Errorf("power came back as %v, expected a sentinel", got.BasebandPower)
			}
			if float64(got.Noise) > -998 {
				t.Errorf("noise came back as %v, expected a sentinel", got.Noise)
			}
		})
	}
}

// Quality is not repeated when unchanged, but must still be reported.
func TestPCMv4HeaderQualityCarriedForward(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	d := NewPCMv4HeaderDecoder()
	ts := uint64(1_700_000_000_000_000_000)

	first := baseHeader(ts)
	encodeDecode(t, e, d, first)

	sent := 0
	for i := 0; i < 50; i++ {
		ts += 909_050
		h := baseHeader(ts)
		pkt := e.AppendHeader(nil, h)
		if pkt[4]&pcmv4FlagQuality != 0 {
			sent++
		}
		got, _, err := d.Decode(pkt)
		if err != nil {
			t.Fatal(err)
		}
		if e := math.Abs(float64(got.BasebandPower - first.BasebandPower)); e > 0.005 {
			t.Fatalf("packet %d: power not carried forward (%v)", i, got.BasebandPower)
		}
	}
	if sent != 0 {
		t.Errorf("quality retransmitted %d times despite not changing", sent)
	}
}

// A v4 header must be distinguishable from an Opus frame, which shares the
// socket and begins with a timestamp byte rather than a magic.
func TestPCMv4HeaderDistinguishableFromOpus(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	pkt := e.AppendHeader(nil, baseHeader(1_700_000_000_000_000_000))
	if !PCMv4IsHeader(pkt) {
		t.Fatal("a v4 header was not recognised as one")
	}

	// Opus frames: [timestamp u64][sampleRate u32][channels u8][power][noise]
	false_ := 0
	const trials = 5000000
	for i := 0; i < trials; i++ {
		var frame [21]byte
		binary.LittleEndian.PutUint64(frame[0:], uint64(1_700_000_000_000_000_000+int64(i)*909_050))
		binary.LittleEndian.PutUint32(frame[8:], 12000)
		frame[12] = 1
		if PCMv4IsHeader(frame[:]) {
			false_++
		}
	}
	if false_ != 0 {
		t.Errorf("%d of %d Opus frames were mistaken for v4 headers", false_, trials)
	}

	// And a version 3 packet must not be mistaken for one either.
	var v3 [37]byte
	binary.LittleEndian.PutUint16(v3[0:], PCMBinaryMagicFull)
	v3[2], v3[3] = 3, 2
	if PCMv4IsHeader(v3[:]) {
		t.Error("a version 3 packet was accepted as version 4")
	}
}

// Malformed headers arrive from the network on the client side and must be
// reported, never panic.
func TestPCMv4HeaderRejectsMalformed(t *testing.T) {
	valid := NewPCMv4HeaderEncoder().AppendHeader(nil, baseHeader(1_700_000_000_000_000_000))

	cases := []struct {
		name string
		pkt  []byte
	}{
		{"empty", nil},
		{"magic only", valid[:4]},
		{"bad magic", append([]byte{0xff, 0xff, 0xff, 0xff}, valid[4:]...)},
		{"truncated timestamp", valid[:6]},
		{"truncated metadata", valid[:12]},
		{"truncated quality", valid[:len(valid)-2]},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := NewPCMv4HeaderDecoder()
			if _, _, err := d.Decode(tc.pkt); err == nil {
				t.Errorf("expected an error for %s", tc.name)
			}
		})
	}
}

// A decoder that has seen no metadata must refuse rather than invent it.
func TestPCMv4HeaderRejectsDeltaBeforeResync(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	ts := uint64(1_700_000_000_000_000_000)
	e.AppendHeader(nil, baseHeader(ts)) // consumed by the encoder, not sent
	ts += 909_050
	delta := e.AppendHeader(nil, baseHeader(ts))
	if delta[4]&pcmv4FlagMetadata != 0 {
		t.Fatal("expected a delta packet for this test")
	}
	d := NewPCMv4HeaderDecoder()
	if _, _, err := d.Decode(delta); err == nil {
		t.Fatal("a decoder with no metadata accepted a delta packet")
	}
}

// The escape flag and profile id must survive alongside everything else.
func TestPCMv4HeaderCarriesProfileAndEscape(t *testing.T) {
	e := NewPCMv4HeaderEncoder()
	d := NewPCMv4HeaderDecoder()
	ts := uint64(1_700_000_000_000_000_000)
	for i, want := range []PCMv4Header{
		{TimestampNanos: ts, SampleRate: 12000, Channels: 1, SampleCount: 240, Profile: PredProfileAudio, Escape: false},
		{TimestampNanos: ts + 1e6, SampleRate: 12000, Channels: 1, SampleCount: 240, Profile: PredProfileAudio, Escape: true},
		{TimestampNanos: ts + 2e6, SampleRate: 384000, Channels: 2, SampleCount: 720, Profile: PredProfileIQ, Escape: true},
		{TimestampNanos: ts + 3e6, SampleRate: 384000, Channels: 2, SampleCount: 720, Profile: PredProfileIQ, Escape: false},
	} {
		want.BasebandPower, want.Noise = -80, -110
		got, _ := encodeDecode(t, e, d, want)
		if got.Profile != want.Profile {
			t.Errorf("packet %d: profile %d, want %d", i, got.Profile, want.Profile)
		}
		if got.Escape != want.Escape {
			t.Errorf("packet %d: escape %v, want %v", i, got.Escape, want.Escape)
		}
	}
}

// The header must actually be as small as the design claims, on real traffic.
func TestPCMv4HeaderSizeOnCaptures(t *testing.T) {
	cases := []struct {
		file    string
		profile byte
		maxMean float64
	}{
		{"iq384-ft8-14074.bin", PredProfileIQ, 8.5},
		{"iq384-mw-carriers.bin", PredProfileIQ, 8.5},
		{"usb-ft8-14074.bin", PredProfileAudio, 11.0},
		{"am-14074.bin", PredProfileAudio, 11.0},
		{"cw-14025.bin", PredProfileAudio, 11.0},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			packets := loadTestCapture(t, c.file)
			e := NewPCMv4HeaderEncoder()
			d := NewPCMv4HeaderDecoder()
			total := 0
			for n, pkt := range packets {
				if binary.LittleEndian.Uint16(pkt) != PCMBinaryMagicFull {
					continue
				}
				h := PCMv4Header{
					TimestampNanos: binary.LittleEndian.Uint64(pkt[4:12]),
					SampleRate:     int(binary.LittleEndian.Uint32(pkt[20:24])),
					Channels:       int(pkt[24]),
					SampleCount:    (len(pkt) - PCMFullHeaderSizeV2) / 2,
					BasebandPower:  math.Float32frombits(binary.LittleEndian.Uint32(pkt[25:29])),
					Noise:          math.Float32frombits(binary.LittleEndian.Uint32(pkt[29:33])),
					Profile:        c.profile,
				}
				enc := e.AppendHeader(nil, h)
				total += len(enc)
				got, _, err := d.Decode(enc)
				if err != nil {
					t.Fatalf("packet %d: %v", n, err)
				}
				if got.TimestampNanos != h.TimestampNanos {
					t.Fatalf("packet %d: timestamp not preserved", n)
				}
				if got.SampleRate != h.SampleRate || got.Channels != h.Channels {
					t.Fatalf("packet %d: metadata not preserved", n)
				}
			}
			mean := float64(total) / float64(len(packets))
			t.Logf("mean header %.2f bytes (version 3 sends 37)", mean)
			if mean > c.maxMean {
				t.Errorf("header averaged %.2f bytes, budget is %.2f", mean, c.maxMean)
			}
		})
	}
}
