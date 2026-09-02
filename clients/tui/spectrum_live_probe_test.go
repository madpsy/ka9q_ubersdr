package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// Live check of the version 2 spectrum path against a real receiver.
//
// Skipped unless UBERSDR_TEST_SERVER is set, matching the other *_live_test.go
// files here, so ordinary runs stay offline:
//
//	UBERSDR_TEST_SERVER=https://m9psy.tunnel.ubersdr.org go test -run TestSpectrumV2Live -v
//
// It asserts more than "frames arrived". A decoder that misread the scale each
// full frame carries would still produce frames of plausible length, full of
// nonsense -- version 1's scale was hardcoded, so this is the field most easily
// got wrong. The dB range is the cheapest thing that catches it.
func TestSpectrumV2Live(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run")
	}
	host, secure := parseServer(target, false)
	c, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatalf("client: %v", err)
	}

	// main.go registers the session before opening the spectrum socket, and the
	// server closes an unregistered one immediately.
	if err := c.CheckConnection(); err != nil {
		t.Fatalf("check connection: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	go c.Run(ctx, 14_074_000, 0)

	go func() {
		for {
			select {
			case msg := <-c.Status:
				t.Logf("status: %s", msg)
			case <-ctx.Done():
				return
			}
		}
	}()

	deadline := time.After(20 * time.Second)
	frames := 0
	minDB, maxDB := float32(1e9), float32(-1e9)
	for frames < 12 {
		select {
		case f := <-c.Frames:
			frames++
			if len(f.Bins) == 0 {
				t.Fatal("empty frame")
			}
			for _, v := range f.Bins {
				if v < minDB {
					minDB = v
				}
				if v > maxDB {
					maxDB = v
				}
			}
			if frames == 1 {
				t.Logf("first frame: %d bins, centre %.0f Hz, span %.0f Hz",
					len(f.Bins), f.Center, f.Span)
			}
		case <-deadline:
			t.Fatalf("only %d frames in 20s", frames)
		}
	}

	c.mu.Lock()
	gaps, step, ref := c.spectrumGaps, c.scale.stepCentiDB, c.scale.refCentiDB
	c.mu.Unlock()
	t.Logf("%d frames, dB %.1f..%.1f, scale ref %d cdB step %d cdB, sequence gaps %d",
		frames, minDB, maxDB, ref, step, gaps)

	if step == 0 {
		t.Error("no full frame carried a scale")
	}
	// Spectrum bins sit well below 0 dBFS and above any receiver's noise. A
	// misread scale lands far outside this.
	if minDB < -250 || maxDB > 20 {
		t.Errorf("implausible dB range %.1f..%.1f — the carried scale is probably misread",
			minDB, maxDB)
	}
}
