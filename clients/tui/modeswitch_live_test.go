package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveModeSwitchSpeed is the regression guard for AM playing at half speed
// after switching from a sideband mode. Audio must arrive at real time in every
// mode, whether the client connected in that mode or switched into it.
func TestLiveModeSwitchSpeed(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("needs UBERSDR_TEST_SERVER")
	}
	host, secure := parseServer(target, false)

	sp, _ := NewClient(host, secure, "")
	if err := sp.CheckConnection(); err != nil {
		t.Fatal(err)
	}
	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetTuning(7_100_000, "lsb", -2700, -50)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	go ac.Run(ctx)
	for !ac.Connected() {
		time.Sleep(100 * time.Millisecond)
	}

	check := func(mode string, low, high int) {
		ac.Tune(7_100_000, mode, low, high)

		// Drain while the change takes effect. Sleeping instead would let
		// packets queue and then be read faster than real time, inflating the
		// measurement.
		settle := time.Now()
		for time.Since(settle) < 1500*time.Millisecond {
			select {
			case <-ac.PCM:
			case <-ac.Level:
			case <-ac.Silence:
			case <-ac.Status:
			case <-time.After(50 * time.Millisecond):
			}
		}

		start := time.Now()
		samples := 0
		var sig Signal
		deadline := time.After(3 * time.Second)
	loop:
		for {
			select {
			case pcm := <-ac.PCM:
				samples += len(pcm)
			case s := <-ac.Level:
				sig = s
			case <-ac.Silence:
			case <-ac.Status:
			case <-deadline:
				break loop
			case <-ctx.Done():
				break loop
			}
		}
		rate := float64(samples) / time.Since(start).Seconds()
		speed := rate / opusOutputRate
		t.Logf("%-4s src %5d Hz | %.0f samples/s | %.2fx real time", mode, sig.SourceRate, rate, speed)
		if speed < 0.9 || speed > 1.1 {
			t.Errorf("%s plays at %.2fx real time", mode, speed)
		}
	}

	check("lsb", -2700, -50)  // 12 kHz baseline
	check("am", -5000, 5000)  // 12 -> 24 kHz, needs a reconnect
	check("usb", 50, 2700)    // 24 -> 12 kHz, needs a reconnect
	check("nfm", -5000, 5000) // 12 -> 24 kHz, needs a reconnect
	check("fm", -8000, 8000)  // 24 -> 24 kHz, retunes in place
	check("cwu", -200, 200)   // 24 -> 12 kHz, needs a reconnect

	// SAM is deliberately excluded. It only produces audio once locked to a
	// real carrier, so on a test frequency with no AM signal it under-delivers
	// by design and would fail this test for reasons it is not about.
}
