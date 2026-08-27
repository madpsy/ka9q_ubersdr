package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The range this bridge assumes, and where it comes from.
//
// It is deliberately not what the connecting SDR client is told — the rtl_tcp protocol
// has no frequency-range field, and the dongle header this bridge sends reports an R820T,
// which makes clients believe 24-1766 MHz is tunable. So the range exists only to warn
// with, and the thing worth testing is that the warning names the receiver in front of it
// rather than a 30 MHz ceiling that stopped being true.

// withRange runs fn against a given range and restores the default afterwards, so one
// test cannot leak a 60 MHz receiver into the next.
func withRange(t *testing.T, tr *TuningRange, fn func()) {
	t.Helper()
	defer func() {
		rangeMu.Lock()
		liveMinFreqHz, liveMaxFreqHz = MinFrequencyHz, MaxFrequencyHz
		rangeMu.Unlock()
	}()
	applyTuningRange(tr)
	fn()
}

func TestTuningRangeDefaultsToTodaysRange(t *testing.T) {
	lo, hi := tuningLimits()
	if lo != MinFrequencyHz || hi != MaxFrequencyHz {
		t.Errorf("before anything is said: got %d-%d, want %d-%d",
			lo, hi, MinFrequencyHz, MaxFrequencyHz)
	}
}

// A receiver that publishes nothing usable must leave this bridge behaving exactly as it
// did before the span became configurable. Each of these is a way of saying nothing.
func TestTuningRangeFallback(t *testing.T) {
	for _, tt := range []struct {
		name string
		tr   *TuningRange
	}{
		{"no object at all", nil},
		{"empty object", &TuningRange{}},
		{"zeroes", &TuningRange{MinFrequency: 0, MaxFrequency: 0}},
		{"negatives", &TuningRange{MinFrequency: -1, MaxFrequency: -30e6}},
		// Not a range but a misconfiguration: adopting it would leave the warning
		// firing on every frequency the receiver can actually reach.
		{"inverted", &TuningRange{MinFrequency: 60e6, MaxFrequency: 10000}},
		{"degenerate", &TuningRange{MinFrequency: 30e6, MaxFrequency: 30e6}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			withRange(t, tt.tr, func() {
				lo, hi := tuningLimits()
				if lo != MinFrequencyHz || hi != MaxFrequencyHz {
					t.Errorf("got %d-%d, want %d-%d", lo, hi, MinFrequencyHz, MaxFrequencyHz)
				}
			})
		})
	}
}

func TestTuningRangeAdoptsAWiderReceiver(t *testing.T) {
	withRange(t, &TuningRange{MinFrequency: 10000, MaxFrequency: 60e6}, func() {
		lo, hi := tuningLimits()
		if lo != 10000 || hi != 60e6 {
			t.Fatalf("got %d-%d, want 10000-60000000", lo, hi)
		}
		// The point of the whole change: 6 m no longer draws a warning.
		const sixMetreFT8 = 50_313_000
		if sixMetreFT8 < lo || sixMetreFT8 > hi {
			t.Errorf("50.313 MHz should be in range on a 60 MHz receiver")
		}
	})
}

// The two edges are independent facts. A receiver that states one must not reset the
// other back to the default.
func TestTuningRangePartial(t *testing.T) {
	withRange(t, &TuningRange{MaxFrequency: 60e6}, func() {
		lo, hi := tuningLimits()
		if lo != MinFrequencyHz || hi != 60e6 {
			t.Errorf("max only: got %d-%d, want %d-60000000", lo, hi, MinFrequencyHz)
		}
	})
	withRange(t, &TuningRange{MinFrequency: 50000}, func() {
		lo, hi := tuningLimits()
		if lo != 50000 || hi != MaxFrequencyHz {
			t.Errorf("min only: got %d-%d, want 50000-%d", lo, hi, MaxFrequencyHz)
		}
	})
}

func TestApplyTuningRangeReportsWhetherItMoved(t *testing.T) {
	withRange(t, nil, func() {
		if applyTuningRange(&TuningRange{MinFrequency: 10000, MaxFrequency: 30e6}) {
			t.Error("the range it already had should not report a change")
		}
		if !applyTuningRange(&TuningRange{MinFrequency: 10000, MaxFrequency: 60e6}) {
			t.Error("a wider receiver should report a change")
		}
	})
}

// End to end over HTTP, against the field names the server actually publishes — the
// decode is where a rename would show up, and nothing else in this bridge would notice.
func TestFetchTuningRangeReadsTheServersFieldNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/description" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"receiver":{"callsign":"M0TST"},"tuning_range":{`+
			`"min_frequency":10000,"max_frequency":60000000,`+
			`"spectrum_span_hz":60000000,"spectrum_center_hz":30000000,`+
			`"input_samprate":129600000,"samprate_source":"radiod-conf"}}`)
	}))
	defer srv.Close()

	defer func() {
		rangeMu.Lock()
		liveMinFreqHz, liveMaxFreqHz = MinFrequencyHz, MaxFrequencyHz
		rangeMu.Unlock()
	}()

	fetchTuningRange(srv.URL)
	lo, hi := tuningLimits()
	if lo != 10000 || hi != 60e6 {
		t.Errorf("got %d-%d, want 10000-60000000", lo, hi)
	}
}

// Every way the fetch can fail must leave the default in force rather than a zero range,
// which would make the bridge warn about every frequency there is.
func TestFetchTuningRangeSurvivesABadServer(t *testing.T) {
	for _, tt := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"404", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) }},
		{"500", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) }},
		{"not JSON", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<html>nope</html>") }},
		{"no tuning_range", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `{"receiver":{"callsign":"M0TST"}}`)
		}},
		{"null tuning_range", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `{"tuning_range":null}`)
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(tt.handler)
			defer srv.Close()
			defer func() {
				rangeMu.Lock()
				liveMinFreqHz, liveMaxFreqHz = MinFrequencyHz, MaxFrequencyHz
				rangeMu.Unlock()
			}()

			fetchTuningRange(srv.URL)
			lo, hi := tuningLimits()
			if lo != MinFrequencyHz || hi != MaxFrequencyHz {
				t.Errorf("got %d-%d, want the default %d-%d",
					lo, hi, MinFrequencyHz, MaxFrequencyHz)
			}
		})
	}
}

func TestFetchTuningRangeSurvivesAnUnreachableServer(t *testing.T) {
	// Nothing is listening here, which is what a bridge started before its receiver
	// sees. It must still come up on the default range.
	fetchTuningRange("ws://127.0.0.1:1/ws")
	lo, hi := tuningLimits()
	if lo != MinFrequencyHz || hi != MaxFrequencyHz {
		t.Errorf("got %d-%d, want the default %d-%d", lo, hi, MinFrequencyHz, MaxFrequencyHz)
	}
}

// The struct must decode the server's real payload, not a shape invented here.
func TestTuningRangeDecodesTheServersObject(t *testing.T) {
	var desc descriptionResponse
	body := `{"tuning_range":{"min_frequency":10000,"max_frequency":60000000,` +
		`"spectrum_span_hz":60000000,"spectrum_center_hz":30000000,` +
		`"input_samprate":129600000,"samprate_source":"radiod-conf"}}`
	if err := json.Unmarshal([]byte(body), &desc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if desc.TuningRange == nil {
		t.Fatal("tuning_range did not decode")
	}
	if desc.TuningRange.MinFrequency != 10000 || desc.TuningRange.MaxFrequency != 60e6 {
		t.Errorf("got %d-%d, want 10000-60000000",
			desc.TuningRange.MinFrequency, desc.TuningRange.MaxFrequency)
	}
}

// bridgeURL is the one thing between the flag and the fetch, and it is exactly where the
// range plumbing first shipped a nil dereference: routingConfig is only ever assigned
// when -config is given, so the no-routing-file case — the default, and the one the
// README's quick start documents — panicked on startup before the bridge could listen.
func TestBridgeURLWithoutARoutingConfig(t *testing.T) {
	// The case that panicked: no -config, so routingConfig is a nil *RoutingConfig.
	if got := bridgeURL(nil, "http://127.0.0.1:8080"); got != "http://127.0.0.1:8080" {
		t.Errorf("no routing config: got %q, want the flag's URL", got)
	}
}

func TestBridgeURLPrefersTheRoutingDefault(t *testing.T) {
	rc := &RoutingConfig{DefaultURL: "http://radio.example:8080"}
	if got := bridgeURL(rc, "http://127.0.0.1:8080"); got != "http://radio.example:8080" {
		t.Errorf("got %q, want the routing table's default", got)
	}
}

func TestBridgeURLFallsBackOnAnEmptyRoutingDefault(t *testing.T) {
	// A routing file that sets up ranges but never names a default_url. Reading the
	// empty string through to the fetch would make it request "/api/description" with
	// no host and log a confusing parse error.
	rc := &RoutingConfig{}
	if got := bridgeURL(rc, "http://127.0.0.1:8080"); got != "http://127.0.0.1:8080" {
		t.Errorf("empty default_url: got %q, want the flag's URL", got)
	}
}
