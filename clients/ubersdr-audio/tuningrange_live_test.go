package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// TestLiveTuningRange checks what a real receiver publishes and what this client
// then does with it, which is the one thing the offline tests cannot do: they
// assert the handling of a range, not that a range arrives at all.
//
// Receiver-agnostic on purpose — it asserts the client agrees with whatever the
// receiver said, not that either is 30 or 60 MHz — so it is worth pointing at
// any receiver. Skipped unless UBERSDR_TEST_SERVER is set, e.g.
//
//	UBERSDR_TEST_SERVER=http://44.31.241.7:8080 go test -run TestLiveTuningRange -v
func TestLiveTuningRange(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live tuning range test")
	}
	restoreRange(t)

	client := NewRadioClient()
	client.BaseURL = target
	client.Password = os.Getenv("UBERSDR_TEST_PASSWORD")

	desc, err := client.FetchDescription()
	if err != nil {
		t.Fatalf("/api/description: %v", err)
	}

	applyTuningRange(&desc.TuningRange)
	min, max := freqLimits()
	t.Logf("published range: %.3f-%.3f MHz (raw %+v)", float64(min)/1e6, float64(max)/1e6, desc.TuningRange)

	// A receiver that publishes nothing is the compatibility case rather than a
	// failure, and the numbers above are then this client's own defaults. Worth
	// saying out loud, because everything after this asserts against a fallback
	// rather than against the receiver.
	if (desc.TuningRange == TuningRange{}) {
		t.Logf("this receiver publishes no tuning_range; testing the 10 kHz-30 MHz fallback")
	}

	// The edges are edges: reachable, and nothing beyond them is.
	if got := clampFreq(max); got != max {
		t.Errorf("clampFreq at the top edge = %d, want %d", got, max)
	}
	if got := clampFreq(max + 1_000_000); got != max {
		t.Errorf("clampFreq above the top = %d, want it pulled to %d", got, max)
	}
	if got := clampFreq(min - 1); got != min {
		t.Errorf("clampFreq below the bottom = %d, want it pushed to %d", got, min)
	}

	// The regression this change exists for: a 6 m frequency on a receiver that
	// reaches it must survive the clamp instead of silently becoming 30 MHz.
	const sixM = 50_313_000
	if max >= sixM {
		if got := clampFreq(sixM); got != sixM {
			t.Errorf("clampFreq(6 m) = %d on a receiver that reaches %d Hz", got, max)
		}
	} else if got := clampFreq(sixM); got != max {
		t.Errorf("clampFreq(6 m) = %d, want the %d Hz top of a narrower receiver", got, max)
	}

	// And the local REST API has to report the same range, since the bundled web
	// UI has no other way to learn it.
	state := NewAppState()
	state.CurrentFreq = clampFreq(desc.DefaultFrequency)
	state.CurrentMode = "usb"
	srv := NewAPIServer(state, client, nil, nil, nil, nil, nil, nil, nil)

	rec := httptest.NewRecorder()
	srv.getTune(rec, httptest.NewRequest(http.MethodGet, "/api/v1/tune", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/tune returned %d", rec.Code)
	}
	var body struct {
		FrequencyHz    int `json:"frequency_hz"`
		FrequencyMinHz int `json:"frequency_min_hz"`
		FrequencyMaxHz int `json:"frequency_max_hz"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode /api/v1/tune: %v", err)
	}
	if body.FrequencyMinHz != min || body.FrequencyMaxHz != max {
		t.Errorf("/api/v1/tune reports %d-%d Hz, want the %d-%d Hz in force",
			body.FrequencyMinHz, body.FrequencyMaxHz, min, max)
	}
	t.Logf("/api/v1/tune: frequency_hz=%d range %d-%d Hz",
		body.FrequencyHz, body.FrequencyMinHz, body.FrequencyMaxHz)
}
