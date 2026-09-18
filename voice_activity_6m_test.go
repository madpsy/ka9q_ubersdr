package main

import "testing"

// 6m has both filters HF gets from its SSB start alone: the CW/beacon section below
// 50.100, and a digital strip (MSK144, JT65, FT8, FT4) that sits above it.
func TestVoiceActivity6mFilters(t *testing.T) {
	at := func(hz uint64) VoiceActivity { return VoiceActivity{EstimatedDialFreq: hz} }
	in := []VoiceActivity{
		at(50090000), // CW / beacons
		at(50150000), // SSB calling
		at(50260000), // MSK144
		at(50313000), // FT8
		at(50318000), // FT4
		at(50400000), // SSB above the digital strip
	}

	out := filterActivitiesByExclusionRange(filterActivitiesBySSBStart(in, "6m"), "6m")

	var got []uint64
	for _, a := range out {
		got = append(got, a.EstimatedDialFreq)
	}
	want := []uint64{50150000, 50400000}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("6m voice activity kept %v, want %v", got, want)
	}
}
