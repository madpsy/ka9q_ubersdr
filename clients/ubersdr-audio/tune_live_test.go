package main

import (
	"os"
	"sync"
	"testing"
	"time"
)

// TestLiveTuneEveryMode retunes a live session in each kind of mode the way
// the app does -- the edges it sends are what bwToLoHi gives, and 0,0 in a
// wide IQ mode -- and checks the server confirms the new frequency. A tune
// the server refuses leaves the session running on the old frequency, so
// only the confirmation shows it.
//
// Skipped unless UBERSDR_TEST_SERVER is set; needs a receiver that allows
// the wide IQ modes, e.g. https://m9psy-1.instance.ubersdr.org.
func TestLiveTuneEveryMode(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live tune test")
	}
	for _, tc := range []struct {
		mode   string
		lo, hi int
	}{
		{"usb", 50, 2700},
		{"iq", -6000, 6000},
		{"iq48", 0, 0},
		{"iq384", 0, 0},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			c := NewRadioClient()
			c.BaseURL = target
			c.Password = os.Getenv("UBERSDR_TEST_PASSWORD")
			c.Frequency = 7074000
			c.Mode = tc.mode
			c.BandwidthLow, c.BandwidthHigh = tc.lo, tc.hi
			c.Format = FormatPCMZstd
			c.DeviceID = "alsa:null"
			c.SetVolume(0)
			var mu sync.Mutex
			var refused []string
			c.OnServerError = func(msg string) {
				mu.Lock()
				refused = append(refused, msg)
				mu.Unlock()
			}
			c.Connect()
			defer c.Disconnect()
			waitFor(t, 20*time.Second, "connect", func() bool {
				return c.State() == StateConnected && c.SampleRate() > 0
			})

			for _, f := range []int{7076000, 14074000} {
				if err := c.Tune(f, tc.mode, tc.lo, tc.hi); err != nil {
					t.Fatalf("tune: %v", err)
				}
				deadline := time.Now().Add(5 * time.Second)
				for c.ServerFrequency() != f {
					if time.Now().After(deadline) {
						mu.Lock()
						defer mu.Unlock()
						t.Fatalf("%s: tuned to %d, server still on %d; refused: %q", tc.mode, f, c.ServerFrequency(), refused)
					}
					time.Sleep(20 * time.Millisecond)
				}
			}
		})
	}
}

// waitFor polls cond until it holds or d runs out.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
