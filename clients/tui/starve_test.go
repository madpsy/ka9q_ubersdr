package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestBufferThroughModeSwitch watches the mixer's buffer and underrun count
// while audio plays through a USB -> AM switch, which is closer to what the
// listener hears than counting packets on the wire.
func TestBufferThroughModeSwitch(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("needs UBERSDR_TEST_SERVER")
	}
	host, secure := parseServer(target, false)
	sp, _ := NewClient(host, secure, "")
	if err := sp.CheckConnection(); err != nil {
		t.Fatal(err)
	}

	out := NewAudioOutput()
	if err := out.Start(""); err != nil {
		t.Fatalf("no audio output: %v", err)
	}
	defer out.Close()

	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetTuning(7_100_000, "usb", 50, 2700)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	go ac.Run(ctx)

	// Pump audio in the background, as the event loop does.
	go func() {
		for {
			select {
			case pcm := <-ac.PCM:
				out.Push(pcm)
			case <-ac.Level:
			case <-ac.Silence:
			case <-ac.Status:
			case <-ctx.Done():
				return
			}
		}
	}()

	report := func(label string, d time.Duration) {
		_, _, u0 := out.Stats()
		minB, maxB := 1<<30, 0
		start := time.Now()
		for time.Since(start) < d {
			b, _, _ := out.Stats()
			if b < minB {
				minB = b
			}
			if b > maxB {
				maxB = b
			}
			time.Sleep(5 * time.Millisecond)
		}
		b, drop, u1 := out.Stats()
		t.Logf("%-22s buffer %5d..%5d samples (%.0f..%.0f ms), now %5d | underruns +%d | dropped %d",
			label, minB, maxB, float64(minB)/48.0, float64(maxB)/48.0, b, u1-u0, drop)
	}

	time.Sleep(2 * time.Second)
	report("USB steady", 3*time.Second)

	t.Log("switching to AM")
	ac.Tune(7_100_000, "am", -5000, 5000)
	report("AM just after switch", 3*time.Second)
	report("AM settled", 3*time.Second)

	t.Log("switching back to USB")
	ac.Tune(7_100_000, "usb", 50, 2700)
	report("USB after switch back", 3*time.Second)
}
