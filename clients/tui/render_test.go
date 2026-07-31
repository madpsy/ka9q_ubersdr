package main

import (
	"math"
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

// syntheticFrame builds a plausible spectrum: a noise floor with a few
// carriers, in raw FFT bin order so the caller can exercise unwrapping.
func syntheticFrame(bins int, seed float64) []float32 {
	out := make([]float32, bins)
	for i := range out {
		// Gentle noise floor with a slow tilt, plus deterministic ripple.
		out[i] = float32(-110 + 3*math.Sin(float64(i)/37+seed) - 4*float64(i)/float64(bins))
	}
	// A handful of signals of differing strength.
	for _, sig := range []struct {
		at    int
		power float32
		width int
	}{
		{bins / 8, 55, 3},
		{bins / 3, 40, 6},
		{bins / 2, 70, 2},
		{3 * bins / 4, 30, 10},
	} {
		for d := -sig.width; d <= sig.width; d++ {
			idx := sig.at + d
			if idx < 0 || idx >= bins {
				continue
			}
			falloff := 1 - math.Abs(float64(d))/float64(sig.width+1)
			out[idx] += sig.power * float32(falloff)
		}
	}
	return out
}

func newTestUI(w, h int, mode ViewMode) (*UI, tcell.SimulationScreen) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		panic(err)
	}
	screen.SetSize(w, h)

	ui := NewUI("sim.example.org:8080")
	ui.mode = mode
	ui.connected = true
	ui.fps = 13.3
	ui.cfg = SpectrumConfig{
		CenterFreq:     7_100_000,
		BinCount:       1024,
		BinBandwidth:   200,
		TotalBandwidth: 204_800,
	}
	ui.vfo = 7_100_000
	return ui, screen
}

// dump renders the simulation screen as text so failures are readable and the
// layout can be eyeballed with `go test -v`.
func dump(screen tcell.SimulationScreen) string {
	cells, w, h := screen.GetContents()
	var b strings.Builder
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			runes := cells[y*w+x].Runes
			if len(runes) == 0 || runes[0] == 0 {
				b.WriteRune(' ')
				continue
			}
			b.WriteRune(runes[0])
		}
		b.WriteString("\n")
	}
	return b.String()
}

func TestRenderAllModes(t *testing.T) {
	for _, mode := range []ViewMode{ViewSpectrum, ViewWaterfall, ViewSplit} {
		ui, screen := newTestUI(100, 30, mode)

		// Feed enough frames to fill some waterfall history.
		for i := 0; i < 20; i++ {
			ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i)/4)))
		}
		ui.Draw(screen)

		out := dump(screen)
		if strings.Contains(out, "terminal too small") {
			t.Fatalf("%v: refused to render at 100x30", mode)
		}
		// The header and status bar must always be present.
		if !strings.Contains(out, "sim.example.org") {
			t.Errorf("%v: header missing the server name", mode)
		}
		if !strings.Contains(out, "q quit") {
			t.Errorf("%v: status bar missing", mode)
		}
		t.Logf("\n=== %v ===\n%s", mode, out)
	}
}

// TestRenderSurvivesAnySize is the resize guarantee: whatever geometry the
// terminal reports, drawing must not panic or index out of range.
func TestRenderSurvivesAnySize(t *testing.T) {
	sizes := [][2]int{
		{1, 1}, {2, 3}, {10, 4}, {23, 7}, {24, 8}, {40, 10},
		{80, 24}, {200, 60}, {400, 100}, {1, 50}, {300, 3},
	}
	modes := []ViewMode{ViewSpectrum, ViewWaterfall, ViewSplit}

	for _, size := range sizes {
		for _, mode := range modes {
			for _, braille := range []bool{false, true} {
				func() {
					defer func() {
						if r := recover(); r != nil {
							t.Fatalf("panic at %dx%d mode=%v braille=%v: %v",
								size[0], size[1], mode, braille, r)
						}
					}()

					ui, screen := newTestUI(size[0], size[1], mode)
					ui.braille = braille
					ui.showPeaks = true
					for i := 0; i < 6; i++ {
						ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i))))
					}
					// Exercise the overlays too, since they do their own
					// clipping arithmetic.
					ui.cursorX, ui.cursorY = size[0]/2, size[1]/2
					ui.Draw(screen)
					ui.showHelp = true
					ui.Draw(screen)
					ui.prompting = true
					ui.promptBuf = "14074"
					ui.Draw(screen)
				}()
			}
		}
	}
}

// TestRenderHandlesNoData covers the window between connecting and the first
// frame, when there is a layout but nothing to plot.
func TestRenderHandlesNoData(t *testing.T) {
	ui, screen := newTestUI(80, 24, ViewSplit)
	ui.cfg = SpectrumConfig{} // no config yet either
	ui.connected = false

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with no data: %v", r)
		}
	}()
	ui.Draw(screen)

	if out := dump(screen); !strings.Contains(out, "offline") {
		t.Error("expected the header to show the offline state")
	}
}

func TestCursorReadoutClampsToScreen(t *testing.T) {
	// A cursor at the far right edge must not push its readout label off-screen.
	for _, x := range []int{9, 50, 98, 99} {
		ui, screen := newTestUI(100, 30, ViewSpectrum)
		for i := 0; i < 3; i++ {
			ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i))))
		}
		ui.cursorX, ui.cursorY = x, 10

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic with cursor at x=%d: %v", x, r)
				}
			}()
			ui.Draw(screen)
		}()

		// The readout carries "MHz"; confirm it landed somewhere on the axis row.
		cells, w, _ := screen.GetContents()
		row := make([]rune, 0, w)
		l := computeLayout(100, 30, ViewSpectrum, ui.splitRatio)
		for i := 0; i < w; i++ {
			runes := cells[l.AxisY*w+i].Runes
			if len(runes) > 0 && runes[0] != 0 {
				row = append(row, runes[0])
			} else {
				row = append(row, ' ')
			}
		}
		if !strings.Contains(string(row), "MHz") {
			t.Errorf("cursor at x=%d produced no readout on the axis row: %q", x, string(row))
		}
	}
}

func TestWaterfallAlignsHistoryAfterPan(t *testing.T) {
	// History captured at one centre frequency must still line up under the
	// frequency axis after the view pans, rather than smearing sideways.
	ui, screen := newTestUI(100, 30, ViewWaterfall)

	// Capture a distinctive narrow signal at a known frequency.
	bins := make([]float32, 1024)
	for i := range bins {
		bins[i] = -120
	}
	bins[512] = -20 // centre of the band = 7.100 MHz
	ui.SetFrame(bins)

	// Now pan half a screen to the right.
	ui.cfg.CenterFreq = 7_150_000
	ui.Draw(screen)

	l := computeLayout(100, 30, ViewWaterfall, ui.splitRatio)
	wantCol := ui.ColAt(l, 7_100_000)
	if wantCol < 0 {
		t.Fatal("7.100 MHz should still be on screen after a 50 kHz pan")
	}

	// The strong bin should now render left of centre, tracking its frequency.
	if wantCol >= l.PlotX+l.PlotW/2 {
		t.Errorf("after panning right, 7.100 MHz should sit left of centre, got column %d", wantCol)
	}

	row, ok := ui.wf.Row(0)
	if !ok {
		t.Fatal("expected one waterfall row")
	}
	if v, found := row.ValueAt(7_100_000); !found || v != -20 {
		t.Errorf("history lost its frequency anchor: ValueAt(7.1 MHz) = %v (found=%v)", v, found)
	}
	// The row covered 7.100 MHz ± 102.4 kHz, so anything well outside that must
	// report not-found rather than being wrapped or clamped into range.
	if _, found := row.ValueAt(7_400_000); found {
		t.Error("7.400 MHz was never captured in that row, but the row claims it")
	}
}

func TestZeroHzAxisTickIsFormattedAsANumber(t *testing.T) {
	// A full 0-30 MHz view puts a tick at exactly 0 Hz. It must render as a
	// number, not as the "not set" placeholder.
	if got := formatFreq(0, 30e6); got != "0.00" {
		t.Errorf("formatFreq(0) = %q, want \"0.00\"", got)
	}

	ui, screen := newTestUI(120, 30, ViewSpectrum)
	ui.cfg = SpectrumConfig{
		CenterFreq: 15e6, BinCount: 2048, BinBandwidth: 14648.4, TotalBandwidth: 30e6,
	}
	ui.vfo = 15e6
	ui.SetFrame(unwrapFFT(syntheticFrame(2048, 0)))
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSpectrum, ui.splitRatio)
	cells, w, _ := screen.GetContents()
	var axis strings.Builder
	for i := 0; i < w; i++ {
		runes := cells[l.AxisY*w+i].Runes
		if len(runes) > 0 && runes[0] != 0 {
			axis.WriteRune(runes[0])
		} else {
			axis.WriteRune(' ')
		}
	}
	if strings.Contains(axis.String(), "—") {
		t.Errorf("axis row contains the not-set placeholder: %q", axis.String())
	}
	if !strings.Contains(axis.String(), "0.00") {
		t.Errorf("axis row missing the 0 Hz tick: %q", axis.String())
	}
}

func TestHeaderShowsPlaceholderBeforeFirstConfig(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSpectrum)
	ui.vfo = 0 // nothing received yet
	ui.Draw(screen)

	cells, w, _ := screen.GetContents()
	var header strings.Builder
	for i := 0; i < w; i++ {
		runes := cells[i].Runes
		if len(runes) > 0 && runes[0] != 0 {
			header.WriteRune(runes[0])
		} else {
			header.WriteRune(' ')
		}
	}
	if !strings.Contains(header.String(), "VFO —") {
		t.Errorf("header should show the VFO placeholder, got %q", header.String())
	}
}
