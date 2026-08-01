package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveDSP exercises discovery and each insert the receiver offers.
func TestLiveDSP(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live DSP test")
	}
	host, secure := parseServer(target, false)

	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	info, err := sp.FetchDSPInfo()
	if err != nil {
		t.Fatalf("DSP discovery failed: %v", err)
	}
	t.Logf("receiver offers DSP: enabled=%v filters=%v max_users=%d",
		info.Enabled, info.Filters, info.MaxUsers)
	if !info.Enabled || len(info.Filters) == 0 {
		t.Skip("this receiver offers no DSP")
	}

	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}
	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetTuning(7_100_000, "lsb", -2700, -50)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go ac.Run(ctx)

	// Wait for the socket.
	waitConnected := time.After(10 * time.Second)
	for !ac.Connected() {
		select {
		case <-waitConnected:
			t.Fatal("audio never connected")
		case <-time.After(100 * time.Millisecond):
		}
	}

	// Each filter in turn, then off, confirming the server's own report.
	for _, f := range append(append([]string{}, info.Filters...), "") {
		ac.SetDSP(f)

		var got DSPState
		deadline := time.After(6 * time.Second)
		frames := 0
	wait:
		for {
			select {
			case st := <-ac.DSP:
				got = st
				break wait
			case <-ac.PCM:
				frames++
			case <-ac.Status:
			case <-deadline:
				t.Errorf("no dsp_status after requesting %q", f)
				break wait
			case <-ctx.Done():
				break wait
			}
		}

		want := f != ""
		if got.Enabled != want || (want && got.Filter != f) {
			t.Errorf("requested %q, server reports enabled=%v filter=%q", f, got.Enabled, got.Filter)
		} else {
			t.Logf("  %-6s -> server confirms enabled=%v filter=%q", orOff(f), got.Enabled, got.Filter)
		}

		// Audio must keep flowing across the change.
		flow := 0
		tick := time.After(1500 * time.Millisecond)
	drain:
		for {
			select {
			case <-ac.PCM:
				flow++
			case <-tick:
				break drain
			case <-ctx.Done():
				break drain
			}
		}
		if flow == 0 {
			t.Errorf("audio stopped after setting DSP to %q", f)
		}
	}
}

func orOff(s string) string {
	if s == "" {
		return "off"
	}
	return s
}
