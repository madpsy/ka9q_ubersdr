package main

import (
	"encoding/binary"
	"math"
	"testing"
)

// pcmTone renders n samples of a sine at freqHz for the given rate as
// big-endian int16, the format radiod delivers and the Kiwi protocol carries.
func pcmTone(n, rate int, freqHz float64, amplitude float64) []byte {
	buf := make([]byte, 0, n*2)
	for i := 0; i < n; i++ {
		v := amplitude * math.Sin(2*math.Pi*freqHz*float64(i)/float64(rate))
		buf = binary.BigEndian.AppendUint16(buf, uint16(int16(v)))
	}
	return buf
}

// toneLevel measures the amplitude of freqHz in big-endian int16 PCM by
// correlating against a complex exponential (one-bin DFT).
func toneLevel(pcm []byte, rate int, freqHz float64) float64 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var re, im float64
	for i := 0; i < n; i++ {
		v := float64(int16(binary.BigEndian.Uint16(pcm[i*2:])))
		ang := 2 * math.Pi * freqHz * float64(i) / float64(rate)
		re += v * math.Cos(ang)
		im += v * math.Sin(ang)
	}
	return 2 * math.Hypot(re, im) / float64(n)
}

func TestNewKiwiDecimatorRefusesUnusableRatios(t *testing.T) {
	cases := []struct {
		name           string
		in, out        int
		wantNil        bool
		wantFactorWhen int
	}{
		{name: "equal rates need no conversion", in: 12000, out: 12000, wantNil: true},
		{name: "ssb pass-through", in: 12000, out: 12000, wantNil: true},
		{name: "non-integer ratio refused", in: 10000, out: 12000, wantNil: true},
		{name: "upsample refused", in: 12000, out: 24000, wantNil: true},
		{name: "zero rate refused", in: 0, out: 12000, wantNil: true},
		{name: "am/fm 24k to 12k", in: 24000, out: 12000, wantFactorWhen: 2},
		{name: "iq192 to 12k", in: 192000, out: 12000, wantFactorWhen: 16},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newKiwiDecimator(tc.in, tc.out)
			if tc.wantNil {
				if d != nil {
					t.Fatalf("newKiwiDecimator(%d, %d) = %+v, want nil", tc.in, tc.out, d)
				}
				// A nil decimator must be a safe identity, so callers need no branch.
				pcm := pcmTone(64, tc.in, 1000, 8000)
				if got := d.Process(pcm); len(got) != len(pcm) {
					t.Errorf("nil Process len = %d, want %d (identity)", len(got), len(pcm))
				}
				if got := d.Factor(); got != 1 {
					t.Errorf("nil Factor() = %d, want 1", got)
				}
				return
			}
			if d == nil {
				t.Fatalf("newKiwiDecimator(%d, %d) = nil, want a decimator", tc.in, tc.out)
			}
			if got := d.Factor(); got != tc.wantFactorWhen {
				t.Errorf("Factor() = %d, want %d", got, tc.wantFactorWhen)
			}
		})
	}
}

// A 20 ms radiod block at 24 kHz is 480 samples; the Kiwi client must see a
// steady 240 out of every one of them, with no drift across packets.
func TestKiwiDecimatorOutputCadence(t *testing.T) {
	d := newKiwiDecimator(24000, 12000)
	pcm := pcmTone(480, 24000, 1000, 8000)
	for i := 0; i < 50; i++ {
		got := d.Process(pcm)
		if len(got) != 480 {
			t.Fatalf("packet %d: got %d bytes (%d samples), want 480 bytes (240 samples)",
				i, len(got), len(got)/2)
		}
	}
}

// Packet sizes that are not a multiple of the factor must not lose or gain
// samples over time: the decimation phase has to carry across the boundary.
func TestKiwiDecimatorPhaseCarriesAcrossPackets(t *testing.T) {
	d := newKiwiDecimator(24000, 12000)
	const packets = 100
	const oddSamples = 481
	pcm := pcmTone(oddSamples, 24000, 1000, 8000)

	total := 0
	for i := 0; i < packets; i++ {
		total += len(d.Process(pcm)) / 2
	}

	want := packets * oddSamples / 2
	if diff := total - want; diff < -1 || diff > 1 {
		t.Errorf("produced %d samples over %d packets, want %d (+/-1); phase is drifting",
			total, packets, want)
	}
}

// Unity DC gain: decimation must not change the level of the audio.
func TestKiwiDecimatorPreservesLevel(t *testing.T) {
	d := newKiwiDecimator(24000, 12000)
	const amplitude = 8000.0
	pcm := pcmTone(4800, 24000, 1000, amplitude)

	// Discard the first packet: the filter history starts empty, so its
	// leading samples ramp up from silence.
	d.Process(pcm)
	out := d.Process(pcm)

	got := toneLevel(out, 12000, 1000)
	if math.Abs(got-amplitude)/amplitude > 0.05 {
		t.Errorf("1 kHz tone came out at %.0f, want %.0f (+/-5%%)", got, amplitude)
	}
}

// The point of the filter. Without it, content above the new Nyquist folds
// into the audio band -- for FM that is the loudest part of the hiss, since
// fm.c emits the discriminator output to the full 12 kHz and the nfm preset
// disables de-emphasis.
func TestKiwiDecimatorRejectsAliases(t *testing.T) {
	const amplitude = 8000.0
	tests := []struct {
		name       string
		inputHz    float64 // tone in the 24 kHz stream
		aliasHz    float64 // where it lands in the 12 kHz output
		wantPassed bool
	}{
		{name: "1 kHz audio passes", inputHz: 1000, aliasHz: 1000, wantPassed: true},
		{name: "4 kHz audio passes", inputHz: 4000, aliasHz: 4000, wantPassed: true},
		{name: "9 kHz hiss would fold to 3 kHz", inputHz: 9000, aliasHz: 3000},
		{name: "11 kHz hiss would fold to 1 kHz", inputHz: 11000, aliasHz: 1000},
		{name: "7 kHz hiss would fold to 5 kHz", inputHz: 7000, aliasHz: 5000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := newKiwiDecimator(24000, 12000)
			pcm := pcmTone(4800, 24000, tc.inputHz, amplitude)
			d.Process(pcm) // settle the filter history
			out := d.Process(pcm)

			got := toneLevel(out, 12000, tc.aliasHz)
			dB := 20 * math.Log10(math.Max(got, 1e-9)/amplitude)

			if tc.wantPassed {
				if dB < -3 {
					t.Errorf("%.0f Hz attenuated by %.1f dB, want it to pass (> -3 dB)", tc.inputHz, -dB)
				}
				return
			}
			if dB > -50 {
				t.Errorf("%.0f Hz folded to %.0f Hz at only %.1f dB down, want > 50 dB of rejection",
					tc.inputHz, tc.aliasHz, -dB)
			}
		})
	}
}

// Full-scale input must saturate rather than wrap: a wrap is an audible click.
func TestKiwiDecimatorClipsRatherThanWraps(t *testing.T) {
	d := newKiwiDecimator(24000, 12000)
	pcm := pcmTone(2400, 24000, 500, 32767)
	d.Process(pcm)
	out := d.Process(pcm)

	// A wrap turns a positive peak into a large negative sample, so adjacent
	// output samples would swing by more than full scale.
	prev := int16(binary.BigEndian.Uint16(out[0:]))
	for i := 1; i < len(out)/2; i++ {
		cur := int16(binary.BigEndian.Uint16(out[i*2:]))
		if diff := math.Abs(float64(cur) - float64(prev)); diff > 40000 {
			t.Fatalf("sample %d jumped by %.0f (%d -> %d): looks like a wrap, not clipping",
				i, diff, prev, cur)
		}
		prev = cur
	}
}

// Every mode the Kiwi emulation offers must be deliverable at the one rate the
// protocol can announce. A preset change upstream (or a new mode mapping) that
// breaks this would otherwise show up only as audio at the wrong speed, which
// is exactly how the 24 kHz am/sam/fm/nfm presets went unnoticed.
func TestKiwiMappedModesReachTheAnnouncedRate(t *testing.T) {
	audio := &AudioConfig{DefaultSampleRate: 12000}
	announced := audio.DefaultSampleRate

	for kiwiMode, preset := range kiwiModeToRadiod {
		t.Run(kiwiMode, func(t *testing.T) {
			rate := audio.GetSampleRateForMode(preset)
			if rate == announced {
				return // no conversion needed
			}
			if d := newKiwiDecimator(rate, announced); d == nil {
				t.Errorf("kiwi mode %q -> preset %q runs at %d Hz, which cannot be converted "+
					"to the announced %d Hz; the client would play it at the wrong speed",
					kiwiMode, preset, rate, announced)
			}
		})
	}
}

// The rates the emulation actually has to handle, pinned against
// ../ubersdr-radiod/config/presets.conf. ubersdr never sends OUTPUT_SAMPRATE,
// so the preset is the real rate and GetSampleRateForMode only labels it --
// when the two disagree, audio plays at the wrong speed with no error anywhere.
func TestGetSampleRateForModeMatchesPresets(t *testing.T) {
	audio := &AudioConfig{}
	presets := map[string]int{
		// samprate = 24k
		"am": 24000, "sam": 24000, "fm": 24000, "nfm": 24000,
		// samprate = 12k
		"usb": 12000, "lsb": 12000, "cwu": 12000, "cwl": 12000, "iq": 12000,
		// wide IQ presets
		"iq48": 48000, "iq96": 96000, "iq192": 192000, "iq384": 384000,
	}
	for mode, want := range presets {
		if got := audio.GetSampleRateForMode(mode); got != want {
			t.Errorf("GetSampleRateForMode(%q) = %d, want %d (presets.conf)", mode, got, want)
		}
	}
}
