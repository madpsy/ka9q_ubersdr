package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveTuningRange checks the range a real receiver publishes against the
// spectrum it actually sends, which is the one thing the offline tests cannot
// do: they assert what this client does with a range, not that the range is
// true.
//
// Receiver-agnostic on purpose — it asserts the two agree, not that either is
// 30 or 60 MHz — so it is worth pointing at any receiver. Skipped unless
// UBERSDR_TEST_SERVER is set, e.g.
//
//	UBERSDR_TEST_SERVER=http://44.31.241.7:8080 go test -run TestLiveTuningRange -v
func TestLiveTuningRange(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live tuning range test")
	}

	host, secure := parseServer(target, false)
	c, err := NewClient(host, secure, os.Getenv("UBERSDR_TEST_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}

	desc, err := c.FetchDescription()
	if err != nil {
		t.Fatalf("/api/description: %v", err)
	}

	oldMin, oldMax, oldSpan := minFreq, maxFreq, maxSpan
	defer func() { minFreq, maxFreq, maxSpan = oldMin, oldMax, oldSpan }()
	applyTuningRange(desc.TuningRange)
	t.Logf("published range: %.3f-%.3f MHz, span %.3f MHz (raw %+v)",
		minFreq/1e6, maxFreq/1e6, maxSpan/1e6, desc.TuningRange)

	// A receiver that publishes nothing is the compatibility case rather than a
	// failure, and the numbers below are then this client's own defaults. Worth
	// saying out loud, because everything after this asserts against a fallback
	// rather than against the receiver.
	if (desc.TuningRange == TuningRange{}) {
		t.Logf("this receiver publishes no tuning_range; testing the 10 kHz-30 MHz fallback")
	}

	// The edges are edges: reachable, and nothing beyond them is.
	if got := clampFreq(maxFreq); got != maxFreq {
		t.Errorf("clampFreq at the top edge = %.0f, want %.0f", got, maxFreq)
	}
	if got := clampFreq(maxFreq + 1e6); got != maxFreq {
		t.Errorf("clampFreq above the top = %.0f, want it pulled to %.0f", got, maxFreq)
	}
	if got := clampFreq(minFreq - 1); got != minFreq {
		t.Errorf("clampFreq below the bottom = %.0f, want it pushed to %.0f", got, minFreq)
	}

	if err := c.CheckConnection(); err != nil {
		t.Fatalf("/connection precheck failed: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	go c.Run(ctx, 0, 0)

	var cfg SpectrumConfig
	select {
	case cfg = <-c.Configs:
	case <-ctx.Done():
		t.Fatal("timed out waiting for the config message")
	}
	t.Logf("socket opened at centre=%.3f MHz span=%.3f MHz bins=%d binBW=%.3f Hz",
		cfg.CenterFreq/1e6, cfg.TotalBandwidth/1e6, cfg.BinCount, cfg.BinBandwidth)

	// The first socket opens at full span, so what the receiver describes and
	// what it sends have to be the same number. They come from the same
	// ReceiverConfig server-side; a mismatch means one of them is stale.
	if cfg.TotalBandwidth != maxSpan {
		t.Errorf("the socket's full span is %.0f Hz but the description says %.0f Hz",
			cfg.TotalBandwidth, maxSpan)
	}

	// The regression this whole change exists for. maxSpan is the zoom-out
	// ceiling, and when it was the hardcoded 30 MHz a wider receiver could not
	// be zoomed all the way out: the top rung of the ladder asks for the full
	// span and was clamped to half of it.
	if maxSpan < cfg.TotalBandwidth {
		t.Errorf("zoom-out ceiling %.0f Hz is below the receiver's own full span %.0f Hz",
			maxSpan, cfg.TotalBandwidth)
	}

	// And the other half: the top of the band has to be reachable at a normal
	// listening span, not just visible in the wide view.
	near := maxFreq - 100_000
	if got := clampCenter(near, 200_000); got != near {
		t.Errorf("clampCenter near the top = %.0f, want %.0f reachable", got, near)
	}
}
