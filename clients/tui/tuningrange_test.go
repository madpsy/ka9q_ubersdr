package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// How far a receiver tunes, how this client learns it, and the fallback that has
// to hold until it does.
//
// The range comes from one place: /api/description's `tuning_range`, built by
// ReceiverConfig.TuningRange in receiver_span.go. It is not always 0-30 MHz —
// the span follows the front end sample rate, so a 129.6 Msps RX888 reaches
// 60 MHz and has 6 m in it. This client assumed 30 MHz in package constants for
// its first year, which meant a wider receiver refused to tune above 30 MHz and
// refused to zoom out past it, with nothing on screen to say why.
//
// Two properties matter and both are tested here: the fallback has to be exactly
// what this client did before the span became configurable, and the range has to
// have been adopted before anything clamps a frequency against it.

// withRange runs fn with the package-level limits set from tr and restores them
// afterwards. The limits are shared mutable state, so a test that applied a
// range would otherwise leave it applied for every test after it.
func withRange(t *testing.T, tr TuningRange, fn func()) {
	t.Helper()
	oldMin, oldMax, oldSpan := minFreq, maxFreq, maxSpan
	defer func() { minFreq, maxFreq, maxSpan = oldMin, oldMax, oldSpan }()
	applyTuningRange(tr)
	fn()
}

// --- the fallback contract --------------------------------------------------

func TestTuningRangeFallback(t *testing.T) {
	for _, tc := range []struct {
		name string
		tr   TuningRange
	}{
		// The window between this program starting and the description
		// answering, and the permanent state for a receiver too old to publish
		// the object at all.
		{"nothing said", TuningRange{}},
		// `> 0` rather than "was it present": a zero that survived would make
		// every frequency out of range and every span degenerate.
		{"zeroes", TuningRange{MinFrequency: 0, MaxFrequency: 0, SpectrumSpanHz: 0}},
		{"negatives", TuningRange{MinFrequency: -1, MaxFrequency: -30e6, SpectrumSpanHz: -1}},
		// Not a receiver, a misconfiguration. Taking it would leave every clamp
		// in the client inverted, which fails far away from here and looks like
		// anything but this.
		{"inverted", TuningRange{MinFrequency: 60e6, MaxFrequency: 10000}},
		{"degenerate", TuningRange{MinFrequency: 30e6, MaxFrequency: 30e6}},
	} {
		min, max, span := tc.tr.Limits()
		if min != 10000 || max != 30e6 || span != 30e6 {
			t.Errorf("%s: got %.0f-%.0f Hz span %.0f, want the 10 kHz-30 MHz fallback",
				tc.name, min, max, span)
		}
	}
}

// The three are independent facts, so a receiver that states one must not reset
// the others.
func TestTuningRangePartial(t *testing.T) {
	min, max, span := TuningRange{MaxFrequency: 60e6}.Limits()
	if min != 10000 {
		t.Errorf("missing min = %.0f, want the 10 kHz fallback", min)
	}
	if max != 60e6 {
		t.Errorf("stated max = %.0f, want 60 MHz", max)
	}
	if span != 30e6 {
		t.Errorf("missing span = %.0f, want the 30 MHz fallback", span)
	}
}

// --- a wider receiver -------------------------------------------------------

func TestWiderReceiverIsAdopted(t *testing.T) {
	sixM := 50_313_000.0
	wide := TuningRange{MinFrequency: 10000, MaxFrequency: 60e6, SpectrumSpanHz: 60e6}

	if clampFreq(sixM) == sixM {
		t.Fatalf("6 m should be out of range before the receiver says otherwise")
	}
	withRange(t, wide, func() {
		if got := clampFreq(sixM); got != sixM {
			t.Errorf("clampFreq(6 m) = %.0f, want it left alone on a 60 MHz receiver", got)
		}
		// The other half of the same symptom: the wide view drew the whole span
		// because that comes over the websocket, but centring was clamped by
		// maxFreq and snapped back.
		if got := clampCenter(sixM, 200000); got != sixM {
			t.Errorf("clampCenter(6 m) = %.0f, want 6 m reachable", got)
		}
		// Zooming out has to reach the receiver's own full span, not the 30 MHz
		// this client used to stop at.
		if maxSpan != 60e6 {
			t.Errorf("maxSpan = %.0f, want the receiver's 60 MHz span", maxSpan)
		}
	})
	// And back to 30 MHz for whatever runs next: the picker can move to a
	// narrower receiver, and a stale wider range would offer frequencies it
	// cannot reach.
	if clampFreq(sixM) == sixM {
		t.Errorf("6 m still reachable after the range was restored")
	}
}

// The limits are the event loop's, so connecting has to put them back before the
// new receiver's description arrives — it may never arrive at all.
func TestConnectingResetsTheRange(t *testing.T) {
	oldMin, oldMax, oldSpan := minFreq, maxFreq, maxSpan
	defer func() { minFreq, maxFreq, maxSpan = oldMin, oldMax, oldSpan }()

	applyTuningRange(TuningRange{MinFrequency: 10000, MaxFrequency: 60e6, SpectrumSpanHz: 60e6})
	applyTuningRange(TuningRange{})
	if minFreq != 10000 || maxFreq != 30e6 || maxSpan != 30e6 {
		t.Errorf("after a reset: %.0f-%.0f Hz span %.0f, want the 10 kHz-30 MHz fallback",
			minFreq, maxFreq, maxSpan)
	}
}

// --- the range reaches the clamps before they run ---------------------------

// applyDescription clamps the receiver's own starting frequency, so it has to
// adopt the range first. A 60 MHz receiver that opens on 6 m would otherwise be
// pulled down to 30 MHz on connect, which looks like the receiver asked for it.
func TestApplyDescriptionAdoptsTheRangeFirst(t *testing.T) {
	oldMin, oldMax, oldSpan := minFreq, maxFreq, maxSpan
	defer func() { minFreq, maxFreq, maxSpan = oldMin, oldMax, oldSpan }()

	desc := Description{
		DefaultFrequency: 50_313_000,
		DefaultMode:      "usb",
		TuningRange:      TuningRange{MinFrequency: 10000, MaxFrequency: 60e6, SpectrumSpanHz: 60e6},
	}
	e := &eventLoop{ui: NewUI("test")}
	e.applyDescription(desc)
	if e.ui.vfo != 50_313_000 {
		t.Errorf("vfo = %.0f, want the receiver's own 6 m default", e.ui.vfo)
	}
}

// Defaults reads the description's own range rather than the package-level one,
// because the answer is wanted on the goroutine that fetched the description —
// before the event loop has adopted it, and without racing the event loop for a
// variable it owns.
func TestDefaultsUsesItsOwnRange(t *testing.T) {
	oldMin, oldMax, oldSpan := minFreq, maxFreq, maxSpan
	defer func() { minFreq, maxFreq, maxSpan = oldMin, oldMax, oldSpan }()
	applyTuningRange(TuningRange{}) // the 30 MHz default is in force

	desc := Description{
		DefaultFrequency: 50_313_000,
		DefaultMode:      "usb",
		TuningRange:      TuningRange{MinFrequency: 10000, MaxFrequency: 60e6},
	}
	if freq, _ := desc.Defaults(); freq != 50_313_000 {
		t.Errorf("Defaults freq = %.0f, want the 6 m default kept", freq)
	}

	// The check is still a check: a receiver reporting 2 m is reporting
	// something it cannot tune, whatever its range says.
	desc.DefaultFrequency = 145_500_000
	if freq, _ := desc.Defaults(); freq != defaultStartFrequency {
		t.Errorf("Defaults freq = %.0f, want the built-in fallback", freq)
	}
}

// The receiver's range arrives as JSON, so the field names have to match what
// the server actually publishes.
func TestTuningRangeDecodesTheServersFieldNames(t *testing.T) {
	var desc Description
	body := `{"tuning_range":{"min_frequency":10000,"max_frequency":60000000,` +
		`"spectrum_span_hz":60000000,"spectrum_center_hz":30000000,` +
		`"input_samprate":129600000,"samprate_source":"radiod-conf"}}`
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&desc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	min, max, span := desc.TuningRange.Limits()
	if min != 10000 || max != 60e6 || span != 60e6 {
		t.Errorf("decoded %.0f-%.0f Hz span %.0f, want 10 kHz-60 MHz span 60 MHz",
			min, max, span)
	}
}
