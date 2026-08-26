package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// How far the connected receiver tunes, how this client learns it, and the
// fallback that has to hold until it does.
//
// The range comes from one place: /api/description's `tuning_range`, built by
// ReceiverConfig.TuningRange in receiver_span.go. It is not always 0-30 MHz —
// the span follows the front end sample rate, so a 129.6 Msps RX888 reaches
// 60 MHz and has 6 m in it. This client hardcoded 30 MHz in clampFreq for its
// first year, which meant a wider receiver silently tuned to 30 MHz whenever
// anything above it was asked for.
//
// Two properties matter and both are tested here: the fallback has to be exactly
// what this client did before the span became configurable, and the range has to
// go back to it when a connection ends or a receiver will not describe itself.

// restoreRange puts the limits back after a test. They are package-level state,
// so a test that applied a range would otherwise leave it applied for every test
// after it.
func restoreRange(t *testing.T) {
	t.Helper()
	min, max := freqLimits()
	t.Cleanup(func() {
		tuneMinHz.Store(int64(min))
		tuneMaxHz.Store(int64(max))
	})
}

// --- the fallback contract --------------------------------------------------

func TestTuningRangeFallback(t *testing.T) {
	for _, tc := range []struct {
		name string
		tr   TuningRange
	}{
		// The window between this client starting and a description answering,
		// and the permanent state for a receiver too old to publish the object.
		{"nothing said", TuningRange{}},
		// `> 0` rather than "was it present": a zero that survived would clamp
		// every frequency to nothing.
		{"zeroes", TuningRange{MinFrequency: 0, MaxFrequency: 0}},
		{"negatives", TuningRange{MinFrequency: -1, MaxFrequency: -30_000_000}},
		// Not a receiver, a misconfiguration. Adopting it would make clampFreq
		// return a frequency outside its own range.
		{"inverted", TuningRange{MinFrequency: 60_000_000, MaxFrequency: 10_000}},
		{"degenerate", TuningRange{MinFrequency: 30_000_000, MaxFrequency: 30_000_000}},
	} {
		min, max := tc.tr.Limits()
		if min != defaultFreqMinHz || max != defaultFreqMaxHz {
			t.Errorf("%s: got %d-%d Hz, want the 10 kHz-30 MHz fallback", tc.name, min, max)
		}
	}
}

// The edges are independent facts, so a receiver that states one must not reset
// the other.
func TestTuningRangePartial(t *testing.T) {
	min, max := TuningRange{MaxFrequency: 60_000_000}.Limits()
	if min != defaultFreqMinHz {
		t.Errorf("missing min = %d, want the 10 kHz fallback", min)
	}
	if max != 60_000_000 {
		t.Errorf("stated max = %d, want 60 MHz", max)
	}
}

// --- a wider receiver -------------------------------------------------------

func TestClampFreqFollowsTheReceiver(t *testing.T) {
	restoreRange(t)
	const sixM = 50_313_000

	applyTuningRange(nil)
	if got := clampFreq(sixM); got != defaultFreqMaxHz {
		t.Errorf("clampFreq(6 m) = %d, want it clamped to 30 MHz by default", got)
	}

	applyTuningRange(&TuningRange{MinFrequency: 10_000, MaxFrequency: 60_000_000})
	if got := clampFreq(sixM); got != sixM {
		t.Errorf("clampFreq(6 m) = %d, want it left alone on a 60 MHz receiver", got)
	}
	// Still a clamp, just a wider one.
	if got := clampFreq(70_000_000); got != 60_000_000 {
		t.Errorf("clampFreq(70 MHz) = %d, want the 60 MHz edge", got)
	}
	if got := clampFreq(1_000); got != 10_000 {
		t.Errorf("clampFreq(1 kHz) = %d, want the 10 kHz edge", got)
	}
}

// This client outlives a connection: the range has to go back when one ends, or
// a 60 MHz receiver's reach would be offered on the 30 MHz one that replaced it.
func TestReconnectingResetsTheRange(t *testing.T) {
	restoreRange(t)

	applyTuningRange(&TuningRange{MinFrequency: 10_000, MaxFrequency: 60_000_000})
	applyTuningRange(nil)
	if min, max := freqLimits(); min != defaultFreqMinHz || max != defaultFreqMaxHz {
		t.Errorf("after a reset: %d-%d Hz, want the 10 kHz-30 MHz fallback", min, max)
	}
}

// The range arrives as JSON, so the field names have to match what the server
// actually publishes.
func TestTuningRangeDecodesTheServersFieldNames(t *testing.T) {
	var desc InstanceDescription
	body := `{"tuning_range":{"min_frequency":10000,"max_frequency":60000000,` +
		`"spectrum_span_hz":60000000,"spectrum_center_hz":30000000,` +
		`"input_samprate":129600000,"samprate_source":"radiod-conf"}}`
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&desc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	min, max := desc.TuningRange.Limits()
	if min != 10_000 || max != 60_000_000 {
		t.Errorf("decoded %d-%d Hz, want 10 kHz-60 MHz", min, max)
	}
	if desc.TuningRange.SpectrumSpanHz != 60_000_000 {
		t.Errorf("span = %d, want 60 MHz", desc.TuningRange.SpectrumSpanHz)
	}
}

// A receiver that describes itself as 0-30 MHz is the overwhelmingly common
// case, and it must land on exactly the numbers the fallback uses rather than
// near them.
func TestThirtyMHzReceiverMatchesTheFallback(t *testing.T) {
	min, max := TuningRange{
		MinFrequency:   10_000,
		MaxFrequency:   30_000_000,
		SpectrumSpanHz: 30_000_000,
	}.Limits()
	if min != defaultFreqMinHz || max != defaultFreqMaxHz {
		t.Errorf("got %d-%d Hz, want the same numbers the fallback uses", min, max)
	}
}
