package main

import (
	"math"
	"strings"
	"testing"
)

// A view 100 kHz wide centred on 7.100 MHz, which is the shape every case here
// starts from. halfSpan is 50 kHz, so a dial at 7.120 sits at 70% across.
func zoomTestUI() *UI {
	u := NewUI("test")
	u.cfg = SpectrumConfig{
		CenterFreq:          7_100_000,
		TotalBandwidth:      100_000,
		BinCount:            1000,
		BinBandwidth:        100,
		DefaultBinBandwidth: 30_000,
	}
	u.vfo = 7_120_000
	return u
}

// The fraction of the way across the view a frequency sits, which is what
// "holds it still" means: the same fraction before and after.
func screenFraction(u *UI, freq, centre, span float64) float64 {
	return (freq - (centre - span/2)) / span
}

// Off by default: + and - keep behaving exactly as they did, about the centre.
func TestZoomHoldsCentreByDefault(t *testing.T) {
	u := zoomTestUI()
	if u.zoomOnVFO {
		t.Fatal("the dial anchor is on by default; it changes what + and - have always done")
	}

	for _, dir := range []int{-1, +1} {
		got := u.zoomCentre(dir, 0, 50_000)
		if got != u.cfg.CenterFreq {
			t.Errorf("direction %d moved the centre to %.0f, want %.0f", dir, got, u.cfg.CenterFreq)
		}
	}
}

// On: the dial stays at the same place on screen, in and out both.
func TestZoomHoldsTheDial(t *testing.T) {
	u := zoomTestUI()
	u.zoomOnVFO = true

	before := screenFraction(u, u.vfo, u.cfg.CenterFreq, u.cfg.TotalBandwidth)
	if math.Abs(before-0.7) > 1e-9 {
		t.Fatalf("the fixture is not what the test assumes: dial at %.3f across", before)
	}

	for _, newSpan := range []float64{50_000, 25_000, 200_000} {
		centre := u.zoomCentre(-1, 0, newSpan)
		if newSpan > u.cfg.TotalBandwidth {
			centre = u.zoomCentre(+1, 0, newSpan)
		}
		after := screenFraction(u, u.vfo, centre, newSpan)
		if math.Abs(after-before) > 1e-9 {
			t.Errorf("span %.0f: dial moved from %.3f to %.3f across the view", newSpan, before, after)
		}
	}
}

// Panning away and then zooming should bring the dial back, not magnify empty
// spectrum: a fraction outside 0..1 would stay outside it forever.
func TestZoomCentresOnADialOffScreen(t *testing.T) {
	u := zoomTestUI()
	u.zoomOnVFO = true
	u.vfo = 7_400_000 // well outside the 7.05-7.15 view

	for _, dir := range []int{-1, +1} {
		if got := u.zoomCentre(dir, 0, 50_000); got != u.vfo {
			t.Errorf("direction %d: centre %.0f, want the dial at %.0f", dir, got, u.vfo)
		}
	}
}

// The mouse is unaffected: it still dives into whatever is under the pointer,
// and still holds the centre on the way out.
func TestZoomCursorAnchorWins(t *testing.T) {
	for _, onVFO := range []bool{false, true} {
		u := zoomTestUI()
		u.zoomOnVFO = onVFO
		cursor := 7_060_000.0

		in := u.zoomCentre(-1, cursor, 50_000)
		want := cursor - (cursor-u.cfg.CenterFreq)*0.5
		if math.Abs(in-want) > 1e-9 {
			t.Errorf("zoomOnVFO=%v: zoom in about the cursor gave %.0f, want %.0f", onVFO, in, want)
		}

		// Zooming out about an off-centre cursor would slide the view sideways
		// rather than reveal more spectrum, so it holds the centre.
		if out := u.zoomCentre(+1, cursor, 200_000); out != u.cfg.CenterFreq {
			t.Errorf("zoomOnVFO=%v: zoom out about the cursor moved the centre to %.0f", onVFO, out)
		}
	}
}

// With no dial yet — before the first tune — the toggle has nothing to hold and
// must not drag the view to 0 Hz.
func TestZoomWithNoDialHoldsCentre(t *testing.T) {
	u := zoomTestUI()
	u.zoomOnVFO = true
	u.vfo = 0

	if got := u.zoomCentre(-1, 0, 50_000); got != u.cfg.CenterFreq {
		t.Errorf("centre %.0f, want %.0f", got, u.cfg.CenterFreq)
	}
}

// Before the first config there is no view to anchor anything in.
func TestZoomWithNoConfig(t *testing.T) {
	u := NewUI("test")
	u.zoomOnVFO = true
	u.vfo = 7_120_000

	if got := u.zoomCentre(-1, 0, 50_000); got != 0 {
		t.Errorf("centre %.0f, want the unset centre 0", got)
	}
}

// The toggle is only useful if it is visible: the header says so while it is
// on, and stays as it was while it is off.
func TestZoomToggleShowsInTheHeader(t *testing.T) {
	ui, screen := newTestUI(140, 24, ViewSplit)
	ui.Draw(screen)
	if out := dump(screen); strings.Contains(out, "zoom dial") {
		t.Error("the header advertises the dial anchor while it is off")
	}

	ui.zoomOnVFO = true
	ui.Draw(screen)
	if out := dump(screen); !strings.Contains(out, "zoom dial") {
		t.Errorf("the header does not show the dial anchor:\n%s", out)
	}
}
