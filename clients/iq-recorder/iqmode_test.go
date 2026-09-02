package main

import "testing"

// The rates must match GetSampleRateForMode in the server's config.go. They are
// what the WAV header claims, so a wrong one here is a recording that plays
// back at the wrong speed rather than one that fails.
//
// "iq" is the case worth pinning: it is 12 kHz and its name carries no number,
// so any attempt to parse the rate out of the mode string gets it wrong.
func TestIQSampleRatesMatchServer(t *testing.T) {
	want := map[string]int{
		"iq":    12000,
		"iq48":  48000,
		"iq96":  96000,
		"iq192": 192000,
		"iq384": 384000,
	}
	for mode, rate := range want {
		got, ok := sampleRateForIQMode(mode)
		if !ok {
			t.Errorf("%s is not a known IQ mode", mode)
			continue
		}
		if got != rate {
			t.Errorf("%s: got %d Hz, want %d Hz", mode, got, rate)
		}
	}
	if len(iqSampleRates) != len(want) {
		t.Errorf("mode table has %d entries, want %d", len(iqSampleRates), len(want))
	}
	for _, bad := range []string{"", "usb", "iq0", "IQ48", "iq48 ", "iq768"} {
		if _, ok := sampleRateForIQMode(bad); ok {
			t.Errorf("%q was accepted as an IQ mode", bad)
		}
		if err := validateIQMode(bad); err == nil {
			t.Errorf("%q passed validation", bad)
		}
	}
}

// iqModeList orders by rate so the help text reads as a ladder rather than in
// whatever order the map happened to range in.
func TestIQModeListIsOrderedByRate(t *testing.T) {
	modes := iqModeList()
	if len(modes) != len(iqSampleRates) {
		t.Fatalf("got %d modes, want %d", len(modes), len(iqSampleRates))
	}
	for i := 1; i < len(modes); i++ {
		if iqSampleRates[modes[i-1]] >= iqSampleRates[modes[i]] {
			t.Fatalf("not ascending by rate: %v", modes)
		}
	}
	if modes[len(modes)-1] != "iq384" {
		t.Errorf("widest mode is %q, want iq384", modes[len(modes)-1])
	}
}

// Each edge of the tuning range falls back independently, and a receiver that
// publishes nothing usable leaves both defaults in force.
func TestTuningRangeFrom(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		min, max int64
	}{
		{"both published", `{"tuning_range":{"min_frequency":5000,"max_frequency":2000000000}}`, 5000, 2_000_000_000},
		{"only min", `{"tuning_range":{"min_frequency":1000}}`, 1000, MaxFrequencyHz},
		{"only max", `{"tuning_range":{"max_frequency":54000000}}`, MinFrequencyHz, 54_000_000},
		{"zeroes are not limits", `{"tuning_range":{"min_frequency":0,"max_frequency":0}}`, MinFrequencyHz, MaxFrequencyHz},
		{"negative is not a limit", `{"tuning_range":{"min_frequency":-1,"max_frequency":-2}}`, MinFrequencyHz, MaxFrequencyHz},
		{"null object", `{"tuning_range":null}`, MinFrequencyHz, MaxFrequencyHz},
		{"absent object", `{"receiver":{"callsign":"M0TST"}}`, MinFrequencyHz, MaxFrequencyHz},
		{"inverted is refused whole", `{"tuning_range":{"min_frequency":30000000,"max_frequency":10000}}`, MinFrequencyHz, MaxFrequencyHz},
		{"equal edges are refused", `{"tuning_range":{"min_frequency":1000000,"max_frequency":1000000}}`, MinFrequencyHz, MaxFrequencyHz},
		{"unparseable body", `not json at all`, MinFrequencyHz, MaxFrequencyHz},
		{"empty body", ``, MinFrequencyHz, MaxFrequencyHz},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			min, max := tuningRangeFrom([]byte(tc.body))
			if min != tc.min || max != tc.max {
				t.Errorf("got %d-%d, want %d-%d", min, max, tc.min, tc.max)
			}
		})
	}
}

// A VHF receiver publishing a range well above the old 30 MHz ceiling must be
// adopted whole: the point of reading the range is that the assumed one is no
// longer right for every instance.
func TestTuningRangeAcceptsWidebandReceiver(t *testing.T) {
	min, max := tuningRangeFrom([]byte(`{"tuning_range":{"min_frequency":10000,"max_frequency":1800000000}}`))
	if min != 10_000 || max != 1_800_000_000 {
		t.Fatalf("got %d-%d, want 10000-1800000000", min, max)
	}
	if 144_000_000 < min || 144_000_000 > max {
		t.Error("2 m would have been reported as out of range")
	}
}
