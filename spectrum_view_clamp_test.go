package main

import "testing"

// The spectrum view has to fit inside the band, and only the server can say so:
// it owns the bin bandwidth and the bin count, and the frequency arrives from a
// different message than the zoom it will be paired with.
//
// The case that started this: a client resumed at 1.19 MHz and sent no bin
// bandwidth, so the frequency was applied on top of the full-span default. The
// centre passed the 10 kHz – 30 MHz check on its own, and the 30 MHz window it
// landed in put the left edge at -13.8 MHz.

// bandFullSpan sets the defaults so full span is exactly 0–30 MHz, which is what
// a real deployment looks like — the shared test manager uses round numbers that
// overhang the top of the band slightly.
func bandFullSpan(sm *SessionManager) {
	sm.config.Spectrum.Default.CenterFrequency = 15_000_000
	sm.config.Spectrum.Default.BinBandwidth = 14648.4375
	sm.config.Spectrum.Default.BinCount = 2048
}

func TestSpectrumView_FrequencyWithoutZoomStaysInBand(t *testing.T) {
	sm := newTestSessionManager(t)
	bandFullSpan(sm)
	sess := createTestSpectrumSession(t, sm, "uuid-clamp-resume")

	// A frequency on its own, as the connect handler sends it: the zoom is
	// whatever the session already had, here the full span.
	if err := sm.UpdateSpectrumSession(sess.ID, 1_190_500, 0, 0); err != nil {
		t.Fatalf("UpdateSpectrumSession: %v", err)
	}

	half := sess.BinBandwidth * float64(sess.BinCount) / 2
	if left := float64(sess.Frequency) - half; left < 0 {
		t.Errorf("left edge %.0f Hz is below 0 (centre %d, span %.0f)",
			left, sess.Frequency, half*2)
	}
	// At full span there is one centre that fits, and it is the default one.
	if sess.Frequency != 15_000_000 {
		t.Errorf("centre: got %d, want 15000000", sess.Frequency)
	}
}

// Zooming out is the other half: the centre was legal for the span it had, and
// the caller sends only the new bin bandwidth. Nothing in the message is wrong;
// the pair is.
func TestSpectrumView_ZoomOutMovesTheCentre(t *testing.T) {
	sm := newTestSessionManager(t)
	bandFullSpan(sm)
	sess := createTestSpectrumSession(t, sm, "uuid-clamp-zoomout")

	// 1 MHz with a 204800 Hz window — comfortably in the band.
	if err := sm.UpdateSpectrumSession(sess.ID, 1_000_000, 100, 2048); err != nil {
		t.Fatalf("UpdateSpectrumSession (zoom in): %v", err)
	}
	if sess.Frequency != 1_000_000 {
		t.Fatalf("centre before zooming out: got %d, want 1000000", sess.Frequency)
	}

	// Out to a 4.096 MHz window, frequency not mentioned.
	if err := sm.UpdateSpectrumSession(sess.ID, 0, 2000, 0); err != nil {
		t.Fatalf("UpdateSpectrumSession (zoom out): %v", err)
	}
	if sess.Frequency != 2_048_000 {
		t.Errorf("centre after zooming out: got %d, want 2048000", sess.Frequency)
	}
}

func TestSpectrumView_ClampKeepsBothEdges(t *testing.T) {
	const maxFreq = 30_000_000

	cases := []struct {
		name     string
		freq     uint64
		binBW    float64
		binCount int
		want     uint64
	}{
		// 204800 Hz wide, so 102400 Hz either side of the centre.
		{"in band, untouched", 14_100_000, 100, 2048, 14_100_000},
		{"low edge", 100_000, 100, 2048, 102_400},
		{"high edge", 29_990_000, 100, 2048, 29_897_600},
		{"exactly on the low edge", 102_400, 100, 2048, 102_400},
		// A zoom wide enough to cover the band has one legal centre.
		{"wider than the band", 4_000_000, 20_000, 2048, 20_480_000},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sm := newTestSessionManager(t)
			bandFullSpan(sm)
			sess := createTestSpectrumSession(t, sm, "uuid-clamp-"+tc.name)

			if err := sm.UpdateSpectrumSession(sess.ID, tc.freq, tc.binBW, tc.binCount); err != nil {
				t.Fatalf("UpdateSpectrumSession: %v", err)
			}
			if sess.Frequency != tc.want {
				t.Errorf("centre: got %d, want %d", sess.Frequency, tc.want)
			}

			// The clamp is only worth anything if the edges land inside the
			// band, so check those rather than trusting the number above.
			half := sess.BinBandwidth * float64(sess.BinCount) / 2
			left := float64(sess.Frequency) - half
			right := float64(sess.Frequency) + half
			if half*2 <= maxFreq && (left < 0 || right > maxFreq) {
				t.Errorf("view %.0f–%.0f Hz is outside 0–%d Hz", left, right, maxFreq)
			}
		})
	}
}
