package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveIQ streams every IQ mode the receiver offers this session, checking
// each arrives as two channels at its own rate and decodes for long enough to
// prove the predictor is in step. Gated on UBERSDR_TEST_SERVER.
//
// The reduced-depth path is exercised too, because it is a different codec
// profile: a scaled packet carries a shift byte in front of its body, and
// reading that wrong does not fail — it delivers a signal several bits too
// quiet, which only a comparison would catch.
func TestLiveIQ(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live IQ test")
	}
	host, secure := parseServer(target, false)

	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}

	// Plain iq is open to everyone; the wide ones are only what this session
	// was offered, which on a public receiver may be none at all.
	wanted := append([]string{"iq"}, sp.AllowedIQModes()...)
	t.Logf("this session may use %s", strings.Join(wanted, ", "))

	for _, mode := range wanted {
		m, ok := lookupMode(mode)
		if !ok {
			t.Fatalf("%s is not in the mode table", mode)
		}
		for _, margin := range []int{0, marginDefault} {
			ac := NewAudioClient(host, secure, "", sp.sessionID)
			ac.SetTuning(14_074_000, mode, m.Low, m.High)
			ac.SetMinMargin(margin)

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			go ac.Run(ctx)

			var packets, frames int
			var last Signal
			deadline := time.After(8 * time.Second)
		loop:
			for packets < 100 {
				select {
				case pkt := <-ac.PCM:
					if pkt.Channels != 2 {
						cancel()
						t.Fatalf("%s: %d channels, want interleaved I/Q", mode, pkt.Channels)
					}
					if pkt.Rate != m.Rate {
						cancel()
						t.Fatalf("%s: arrived at %d Hz, the mode table says %d", mode, pkt.Rate, m.Rate)
					}
					packets++
					frames += pkt.Frames()
				case last = <-ac.Level:
				case msg := <-ac.Status:
					if strings.Contains(msg, "disconnected") {
						cancel()
						t.Fatalf("%s at %d dB: %s", mode, margin, msg)
					}
				case <-ac.Silence:
				case <-ac.DSP:
				case <-deadline:
					break loop
				}
			}
			cancel()

			if packets == 0 {
				t.Fatalf("%s at %d dB: no audio arrived", mode, margin)
			}
			if !last.Lossless {
				t.Errorf("%s: the stream was not on the lossless path (%+v)", mode, last)
			}
			// Every packet decoding is the real assertion: the predictor is
			// backward adaptive, so one wrong bit turns every later packet into
			// noise rather than failing on the packet that was wrong.
			t.Logf("%-6s margin %2d: %d packets, %d frames at %d Hz",
				mode, margin, packets, frames, m.Rate)
		}
	}
}
