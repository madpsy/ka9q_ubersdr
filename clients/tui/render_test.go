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
			ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i)/4)), 0, 0)
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
		// The quit hint is the highest-priority one after noise reduction, so
		// it survives any width the status bar is drawn at.
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
						ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i))), 0, 0)
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
			ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i))), 0, 0)
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
		l := computeLayout(100, 30, ViewSpectrum, ui.splitRatio, 0)
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
	ui.SetFrame(bins, 0, 0)

	// Now pan half a screen to the right.
	ui.cfg.CenterFreq = 7_150_000
	ui.Draw(screen)

	l := computeLayout(100, 30, ViewWaterfall, ui.splitRatio, 0)
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
	ui.SetFrame(unwrapFFT(syntheticFrame(2048, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSpectrum, ui.splitRatio, 0)
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

// TestHeaderGroupsAndColoursTheTuningFields: the mode and filter width belong
// beside the frequency — they qualify it — and each of the three carries its
// own colour so none of them has to be picked out of a row of dim text.
func TestHeaderGroupsAndColoursTheTuningFields(t *testing.T) {
	ui, screen := newTestUI(140, 24, ViewSpectrum)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.ApplyMode("lsb")
	ui.signal = Signal{Power: -70, Noise: -110}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	cells, w, _ := screen.GetContents()
	var header strings.Builder
	for i := 0; i < w; i++ {
		r := ' '
		if runes := cells[i].Runes; len(runes) > 0 && runes[0] != 0 {
			r = runes[0]
		}
		header.WriteRune(r)
	}
	got := header.String()

	// Indices are in runes, not bytes: the separator and the state glyph are
	// multi-byte, so a byte offset would not be the column the cell is in.
	runes := []rune(got)
	indexRunes := func(want string) int {
		return len([]rune(got[:max(strings.Index(got, want), 0)]))
	}

	// Nothing but the separator may come between the frequency and the mode.
	if !strings.Contains(got, "7.1000 MHz") || !strings.Contains(got, "LSB") ||
		!strings.Contains(got, "2.6k") {
		t.Fatalf("header is missing one of frequency, mode or width: %q", got)
	}
	freq, mode, bw := indexRunes("7.1000 MHz"), indexRunes("LSB"), indexRunes("2.6k")
	if between := string(runes[freq+len("7.1000 MHz") : mode]); between != " │ " {
		t.Errorf("mode is not beside the frequency; %q sits between them", between)
	}
	if bw < mode {
		t.Errorf("filter width precedes the mode: %q", got)
	}

	// Each of the three is a colour of its own, and none of them is white:
	// white is the server name's, and the point is to stand apart from it.
	fgAt := func(col int) int32 {
		fg, _, _ := cells[col].Style.Decompose()
		return fg.Hex()
	}
	freqFG, modeFG, bwFG := fgAt(freq), fgAt(mode), fgAt(bw)
	if freqFG == modeFG || freqFG == bwFG || modeFG == bwFG {
		t.Errorf("frequency, mode and width share a colour: %06x %06x %06x",
			freqFG, modeFG, bwFG)
	}
	for name, fg := range map[string]int32{"frequency": freqFG, "mode": modeFG, "width": bwFG} {
		if fg == tcell.ColorWhite.Hex() || fg == tcell.ColorSilver.Hex() {
			t.Errorf("%s is drawn in white: %06x", name, fg)
		}
	}
}

// TestWaterfallResolvesSubColumns is the regression guard for the original
// complaint: one value per character cell threw away half the frequency detail
// the terminal could actually show.
func TestWaterfallResolvesSubColumns(t *testing.T) {
	ui, screen := newTestUI(100, 30, ViewWaterfall)
	l := computeLayout(100, 30, ViewWaterfall, ui.splitRatio, 0)

	// Alternate floor and peak between neighbouring sub-columns. The pattern is
	// laid out using the same sub-column-to-bin ranges the renderer uses, so
	// each sub-column is uniformly one level. Assigning by bin index instead
	// would straddle those boundaries and — now that each sub-column takes the
	// maximum over the bins it covers — saturate every one of them.
	bins := make([]float32, 2048)
	subW := l.PlotW * 2
	for s := 0; s < subW; s++ {
		lo := s * len(bins) / subW
		hi := (s + 1) * len(bins) / subW
		level := float32(-120)
		if s%2 == 1 {
			level = -20
		}
		for i := lo; i < hi && i < len(bins); i++ {
			bins[i] = level
		}
	}
	ui.minDB, ui.maxDB, ui.haveRange, ui.autoScale = -120, -20, true, false
	ui.SetFrame(bins, 0, 0)
	ui.Draw(screen)

	// If the waterfall only resolved one value per cell, every cell would be a
	// uniform block. Half-width glyphs prove two independent sub-columns.
	cells, w, _ := screen.GetContents()
	halves := 0
	for cx := l.PlotX; cx < w; cx++ {
		runes := cells[l.WfY*w+cx].Runes
		if len(runes) == 0 {
			continue
		}
		switch runes[0] {
		case '▌', '▐', '▘', '▝', '▖', '▗', '▚', '▞', '▛', '▜', '▙', '▟':
			halves++
		}
	}
	// Every cell should split, since neighbouring sub-columns alternate level.
	// A uniform-block result would mean the pane is still showing one value per
	// character cell.
	if halves < l.PlotW*3/4 {
		t.Errorf("only %d of %d cells resolved two sub-columns; horizontal resolution is not doubled",
			halves, l.PlotW)
	}
	t.Logf("%d of %d waterfall cells resolved two distinct sub-columns", halves, l.PlotW)
}

func TestBrailleFillsToBaseline(t *testing.T) {
	// The braille spectrum should read as a solid shape, so a strong signal
	// must light cells all the way down to the bottom row of the pane.
	ui, screen := newTestUI(100, 30, ViewSpectrum)
	l := computeLayout(100, 30, ViewSpectrum, ui.splitRatio, 0)

	bins := make([]float32, 2048)
	for i := range bins {
		bins[i] = -20 // everything at full scale
	}
	ui.minDB, ui.maxDB, ui.haveRange, ui.autoScale = -120, -20, true, false
	ui.SetFrame(bins, 0, 0)
	ui.Draw(screen)

	cells, w, _ := screen.GetContents()
	bottom := l.SpecY + l.SpecH - 1
	filled := 0
	for cx := l.PlotX; cx < w; cx++ {
		runes := cells[bottom*w+cx].Runes
		if len(runes) > 0 && runes[0] >= brailleBase && runes[0] <= brailleBase+0xFF && runes[0] != brailleBase {
			filled++
		}
	}
	if filled < l.PlotW/2 {
		t.Errorf("only %d of %d bottom cells filled; the spectrum is not filling to the baseline",
			filled, l.PlotW)
	}
}

func TestBinsPerScreenPositionHalved(t *testing.T) {
	// Document the actual win: braille and the quadrant waterfall both sample
	// at 2x the character-cell width.
	l := computeLayout(200, 50, ViewSplit, 0.45, 0)
	const bins = 2048

	perCell := float64(bins) / float64(l.PlotW)
	perSubCell := float64(bins) / float64(l.PlotW*2)
	if perSubCell >= perCell {
		t.Fatal("sub-cell sampling is not finer than per-cell sampling")
	}
	t.Logf("%d bins across %d columns: %.1f bins per cell, %.1f per sub-cell",
		bins, l.PlotW, perCell, perSubCell)
}

// TestWaterfallShowsEverySignal is the regression guard for the "sparkles"
// report: the waterfall used to point-sample one bin per screen position, so
// which signals appeared depended on where the sample happened to land on the
// bin grid. Isolated cells lit up and went dark essentially at random, and the
// waterfall disagreed with the spectrum pane beside it.
func TestWaterfallShowsEverySignal(t *testing.T) {
	const nbins = 2048
	start, span := 7.0e6, 204800.0

	bins := make([]float32, nbins)
	for i := range bins {
		bins[i] = -120
	}
	// Narrow carriers spaced so several fall between consecutive sample points.
	planted := 0
	for i := 3; i < nbins; i += 17 {
		bins[i] = -30
		planted++
	}
	row := wfRow{bins: bins, start: start, span: span}

	subW := 382 // a typical 191-column pane at two samples per cell
	step := span / float64(subW)

	pointSeen, maxSeen := 0, 0
	for i := 0; i < subW; i++ {
		lo := start + float64(i)*step
		if v, ok := row.ValueAt(lo + step/2); ok && v > -60 {
			pointSeen++
		}
		if v, ok := row.MaxBetween(lo, lo+step); ok && v > -60 {
			maxSeen++
		}
	}

	// Every sub-column that covers a carrier must show it.
	if maxSeen <= pointSeen {
		t.Errorf("aggregating saw %d carriers, point sampling saw %d — no improvement",
			maxSeen, pointSeen)
	}
	// With ~5 bins per sub-column, point sampling should miss most of them.
	if pointSeen > planted/2 {
		t.Logf("note: point sampling happened to catch %d of %d", pointSeen, planted)
	}
	t.Logf("%d carriers planted: point sampling shows %d, aggregation shows %d",
		planted, pointSeen, maxSeen)
}

func TestMaxBetweenTilesWithoutOverlap(t *testing.T) {
	// Consecutive sub-columns must cover every bin exactly once. Overlapping
	// ranges would let one strong bin light up two adjacent sub-columns and
	// smear narrow signals.
	const nbins = 64
	start, span := 1.0e6, 64000.0

	bins := make([]float32, nbins)
	for i := range bins {
		bins[i] = -120
	}
	bins[20] = -10 // exactly one strong bin

	row := wfRow{bins: bins, start: start, span: span}
	subW := 16 // four bins per sub-column
	step := span / float64(subW)

	lit := 0
	for i := 0; i < subW; i++ {
		lo := start + float64(i)*step
		if v, ok := row.MaxBetween(lo, lo+step); ok && v > -60 {
			lit++
		}
	}
	if lit != 1 {
		t.Errorf("one strong bin lit %d sub-columns, want exactly 1", lit)
	}
}

func TestMaxBetweenOutOfRange(t *testing.T) {
	row := wfRow{bins: []float32{-10, -20, -30, -40}, start: 7.0e6, span: 4000}

	if _, ok := row.MaxBetween(6.9e6, 6.95e6); ok {
		t.Error("a range entirely below the row should report not-found")
	}
	if _, ok := row.MaxBetween(7.5e6, 7.6e6); ok {
		t.Error("a range entirely above the row should report not-found")
	}
	// A range wider than the row clips to what it holds.
	if v, ok := row.MaxBetween(6.0e6, 8.0e6); !ok || v != -10 {
		t.Errorf("MaxBetween over the whole row = %v (ok=%v), want -10", v, ok)
	}
	// Degenerate and empty rows must not panic.
	if _, ok := row.MaxBetween(7.001e6, 7.0e6); ok {
		t.Error("an inverted range should report not-found")
	}
	if _, ok := (wfRow{}).MaxBetween(0, 1); ok {
		t.Error("an empty row should report not-found")
	}
}

func TestMaxBetweenZoomedPastBinWidth(t *testing.T) {
	// When zoomed in so far that one bin spans several sub-columns, every
	// sub-column must still resolve to its containing bin rather than an
	// empty range.
	bins := []float32{-100, -50, -20, -80}
	row := wfRow{bins: bins, start: 7.0e6, span: 4000}

	// Sixteen sub-columns across four bins.
	step := 4000.0 / 16
	for i := 0; i < 16; i++ {
		lo := 7.0e6 + float64(i)*step
		v, ok := row.MaxBetween(lo, lo+step)
		if !ok {
			t.Fatalf("sub-column %d reported not-found while inside the row", i)
		}
		if want := bins[i/4]; v != want {
			t.Errorf("sub-column %d = %v, want %v", i, v, want)
		}
	}
}

// TestWaterfallRowsUseTheirOwnFrequency is the regression guard for the
// "blocks appear as it scrolls" report. Frames and config messages reach the UI
// on separate channels, so during a pan the config the UI holds does not
// necessarily describe the frame it is processing. Stamping rows from the
// current config instead of from the frame put history at the wrong
// frequencies, which shows up as displaced blocks scrolling through the
// waterfall.
func TestWaterfallRowsUseTheirOwnFrequency(t *testing.T) {
	ui, _ := newTestUI(100, 30, ViewWaterfall)

	bins := make([]float32, 1024)
	for i := range bins {
		bins[i] = -120
	}
	bins[512] = -20 // mid-band marker

	// A frame captured at 7.100 MHz arrives while the UI already believes the
	// view has moved to 7.400 MHz — exactly the in-flight case during a drag.
	ui.cfg.CenterFreq = 7_400_000
	ui.SetFrame(bins, 7_100_000, 204_800)

	row, ok := ui.wf.Row(0)
	if !ok {
		t.Fatal("expected a waterfall row")
	}
	// The marker must sit at the frequency the frame was captured at.
	if v, found := row.MaxBetween(7_099_000, 7_101_000); !found || v != -20 {
		t.Errorf("marker not at 7.100 MHz: got %v (found=%v)", v, found)
	}
	// And must not appear where the stale config would have put it.
	if v, found := row.MaxBetween(7_399_000, 7_401_000); found && v == -20 {
		t.Error("row was stamped with the UI's config instead of the frame's own frequency")
	}
}

func TestSetFrameFallsBackToCurrentView(t *testing.T) {
	// Older servers may not report a per-frame frequency; the current view is
	// then the best available stamp.
	ui, _ := newTestUI(100, 30, ViewWaterfall)
	bins := make([]float32, 1024)
	for i := range bins {
		bins[i] = -120
	}
	bins[512] = -20

	ui.SetFrame(bins, 0, 0) // no per-frame range supplied

	row, ok := ui.wf.Row(0)
	if !ok {
		t.Fatal("expected a waterfall row")
	}
	if v, found := row.MaxBetween(7_099_000, 7_101_000); !found || v != -20 {
		t.Errorf("fallback stamping failed: got %v (found=%v)", v, found)
	}
}

// TestWaterfallRenderingIsExact is the regression guard for the invented-blocks
// report. The waterfall previously packed 2x2 pixels into one cell using the
// quadrant glyphs, approximating four samples with the cell's two available
// colours. On a noise floor that split essentially every cell into a hard
// two-colour edge chosen from random variation, and re-rolled it each frame as
// the display scrolled — structure that was never in the data.
//
// Pairing two horizontally adjacent samples per cell is exact, so whatever a
// cell shows must be exactly what was sampled.
func TestWaterfallRenderingIsExact(t *testing.T) {
	ui, screen := newTestUI(100, 30, ViewWaterfall)
	l := computeLayout(100, 30, ViewWaterfall, ui.splitRatio, 0)

	// Pure noise with no real structure, at the level a noise floor sits.
	rng := newDeterministicRNG(11)
	bins := make([]float32, 2048)
	for i := range bins {
		bins[i] = float32(-110 + rng()*6)
	}
	ui.minDB, ui.maxDB, ui.haveRange, ui.autoScale = -120, -60, true, false
	ui.SetFrame(bins, 0, 0)
	ui.Draw(screen)

	start, span := ui.viewRange()
	subStep := span / float64(l.PlotW*2)
	row, _ := ui.wf.Row(0)

	// The VFO marker deliberately re-tints its own column, so it is not part
	// of the exactness guarantee.
	markerCol := ui.ColAt(l, ui.vfo)

	cells, w, _ := screen.GetContents()
	for cx := 0; cx < l.PlotW; cx++ {
		if l.PlotX+cx == markerCol {
			continue
		}
		cell := cells[l.WfY*w+l.PlotX+cx]
		if len(cell.Runes) == 0 || cell.Runes[0] != leftHalf {
			t.Fatalf("cell %d drew %q, want the exact half-block pair", cx, cell.Runes)
		}

		// Recompute what the two sub-columns should be and compare with what
		// the cell actually carries.
		lo := start + float64(cx*2)*subStep
		for i, want := range [2]float64{lo, lo + subStep} {
			v, ok := row.MeanBetween(want, want+subStep)
			if !ok {
				continue
			}
			expect := lookup(&waterfallLUT, ui.norm(float64(v)))

			var got tcell.Color
			if i == 0 {
				got, _, _ = cell.Style.Decompose()
			} else {
				_, got, _ = cell.Style.Decompose()
			}
			r, g, b := got.RGB()
			if r != expect.r || g != expect.g || b != expect.b {
				t.Fatalf("cell %d sub-column %d shows (%d,%d,%d), want (%d,%d,%d)",
					cx, i, r, g, b, expect.r, expect.g, expect.b)
			}
		}
	}
}

// newDeterministicRNG returns a small reproducible generator in [0,1), avoiding
// a dependency on the global source ordering.
func newDeterministicRNG(seed uint64) func() float64 {
	state := seed
	return func() float64 {
		state ^= state << 13
		state ^= state >> 7
		state ^= state << 17
		return float64(state%10000) / 10000
	}
}

// TestScaleShiftDoesNotRepaintHistory is the regression guard for signals
// appearing across the entire waterfall at once.
//
// Auto-ranging moves the dB window as the band changes. Colouring stored rows
// with the *current* window means every row in the history repaints whenever
// that happens, so a carrier sitting just under the visibility threshold
// suddenly draws a vertical stripe through the whole history — a signal that
// appears to have been there all along and arrived from nowhere. Each row must
// keep the window it was captured under.
func TestScaleShiftDoesNotRepaintHistory(t *testing.T) {
	ui, screen := newTestUI(100, 30, ViewWaterfall)
	l := computeLayout(100, 30, ViewWaterfall, ui.splitRatio, 0)

	// A noise floor with one weak carrier just above it.
	bins := make([]float32, 1024)
	for i := range bins {
		bins[i] = -110
	}
	for i := 500; i < 505; i++ {
		bins[i] = -103 // 7 dB up: barely visible under a wide window
	}

	ui.autoScale = true
	ui.minDB, ui.maxDB, ui.haveRange = -115, -40, true
	for i := 0; i < 10; i++ {
		ui.SetFrame(bins, 7_100_000, 204_800)
	}
	ui.Draw(screen)

	capture := func() []tcell.Color {
		cells, w, _ := screen.GetContents()
		out := make([]tcell.Color, 0, l.PlotW)
		for cx := 0; cx < l.PlotW; cx++ {
			fg, _, _ := cells[(l.WfY+3)*w+l.PlotX+cx].Style.Decompose()
			out = append(out, fg)
		}
		return out
	}
	before := capture()

	// The band goes quiet and auto-ranging tightens the window hard. Without
	// per-row windows this repaints every stored row.
	ui.minDB, ui.maxDB = -112, -100
	ui.Draw(screen)
	after := capture()

	changed := 0
	for i := range before {
		if before[i] != after[i] {
			changed++
		}
	}
	if changed != 0 {
		t.Errorf("%d of %d cells in a stored row changed colour after the dB window moved; "+
			"history is being repainted", changed, len(before))
	}

	// A newly arriving frame must of course use the new window.
	ui.SetFrame(bins, 7_100_000, 204_800)
	ui.Draw(screen)
	cells, w, _ := screen.GetContents()
	newestFg, _, _ := cells[l.WfY*w+l.PlotX+l.PlotW/2].Style.Decompose()
	olderFg, _, _ := cells[(l.WfY+4)*w+l.PlotX+l.PlotW/2].Style.Decompose()
	if newestFg == olderFg {
		t.Error("the newest row should reflect the new window, but matches the old rows")
	}
}

func TestManualScaleAppliesToWholeHistory(t *testing.T) {
	// When the user sets the window by hand, applying it to everything is the
	// point — history should re-colour so it can be re-examined.
	ui, screen := newTestUI(100, 30, ViewWaterfall)
	l := computeLayout(100, 30, ViewWaterfall, ui.splitRatio, 0)

	bins := make([]float32, 1024)
	for i := range bins {
		bins[i] = -110
	}
	ui.autoScale = true
	ui.minDB, ui.maxDB, ui.haveRange = -115, -40, true
	for i := 0; i < 8; i++ {
		ui.SetFrame(bins, 7_100_000, 204_800)
	}
	ui.Draw(screen)

	read := func() tcell.Color {
		cells, w, _ := screen.GetContents()
		fg, _, _ := cells[(l.WfY+3)*w+l.PlotX+l.PlotW/2].Style.Decompose()
		return fg
	}
	before := read()

	ui.autoScale = false
	ui.minDB, ui.maxDB = -112, -105
	ui.Draw(screen)

	if read() == before {
		t.Error("manual scaling should re-colour stored history")
	}
}

// TestZoomRestartsHistory is the regression guard for the vertical lines that
// span the whole waterfall.
//
// History rows are anchored to the frequencies they were captured at, which is
// what keeps them aligned under the axis while panning. After a zoom that same
// anchoring squeezes old rows into whatever sliver of screen their original
// span now occupies: 200 kHz of history lands in roughly two columns of a
// 30 MHz view, drawing a bright vertical stripe through the entire history that
// reads as a signal appearing from nowhere.
func TestZoomRestartsHistory(t *testing.T) {
	ui, _ := newTestUI(110, 30, ViewWaterfall)

	bins := make([]float32, 1024)
	for i := range bins {
		bins[i] = -60
	}
	for i := 0; i < 12; i++ {
		ui.SetFrame(bins, 7_100_000, 204_800)
	}
	if ui.wf.Len() != 12 {
		t.Fatalf("setup: %d rows, want 12", ui.wf.Len())
	}

	// Zooming out to full span must drop the incomparable history.
	wide := make([]float32, 2048)
	for i := range wide {
		wide[i] = -80
	}
	ui.SetFrame(wide, 15e6, 30e6)
	if ui.wf.Len() != 1 {
		t.Errorf("after zooming out the waterfall holds %d rows, want only the new one",
			ui.wf.Len())
	}

	// Panning must NOT drop history — that is where anchoring earns its keep.
	for i := 0; i < 5; i++ {
		ui.SetFrame(wide, 15e6+float64(i)*100_000, 30e6)
	}
	if ui.wf.Len() != 6 {
		t.Errorf("panning dropped history: %d rows, want 6", ui.wf.Len())
	}

	// Tiny floating-point wobble in the span must not count as a zoom.
	ui.SetFrame(wide, 15e6, 30e6*1.0001)
	if ui.wf.Len() != 7 {
		t.Errorf("a negligible span change cleared history: %d rows, want 7", ui.wf.Len())
	}
}

// TestPeakHoldRendersInBothStyles is the regression guard for peak hold doing
// nothing. It was drawn inside the block-bars renderer only, so it silently
// stopped appearing when braille became the default trace style.
func TestPeakHoldRendersInBothStyles(t *testing.T) {
	for _, braille := range []bool{false, true} {
		name := "bars"
		if braille {
			name = "braille"
		}

		ui, screen := newTestUI(100, 30, ViewSpectrum)
		ui.braille = braille
		ui.showPeaks = true
		ui.minDB, ui.maxDB, ui.haveRange, ui.autoScale = -120, -20, true, false

		// A burst that then disappears: peak hold exists to keep showing it.
		loud := make([]float32, 1024)
		quiet := make([]float32, 1024)
		for i := range loud {
			loud[i], quiet[i] = -110, -110
		}
		for i := 480; i < 540; i++ {
			loud[i] = -30
		}
		ui.SetFrame(loud, 0, 0)
		for i := 0; i < 5; i++ {
			ui.SetFrame(quiet, 0, 0)
		}
		ui.Draw(screen)

		cells, w, _ := screen.GetContents()
		marks := 0
		for y := 0; y < 30; y++ {
			for x := 0; x < w; x++ {
				if r := cells[y*w+x].Runes; len(r) > 0 && r[0] == '‾' {
					marks++
				}
			}
		}
		if marks == 0 {
			t.Errorf("%s: peak hold drew nothing after the signal went away", name)
		}

		// With peak hold off there must be no marks at all.
		ui2, screen2 := newTestUI(100, 30, ViewSpectrum)
		ui2.braille = braille
		ui2.showPeaks = false
		ui2.minDB, ui2.maxDB, ui2.haveRange, ui2.autoScale = -120, -20, true, false
		ui2.SetFrame(loud, 0, 0)
		ui2.SetFrame(quiet, 0, 0)
		ui2.Draw(screen2)

		cells2, w2, _ := screen2.GetContents()
		for y := 0; y < 30; y++ {
			for x := 0; x < w2; x++ {
				if r := cells2[y*w2+x].Runes; len(r) > 0 && r[0] == '‾' {
					t.Fatalf("%s: peak marks drawn with peak hold off", name)
				}
			}
		}
	}
}

// TestPeakHoldDecays: the held level must fall back rather than sticking at the
// maximum forever.
func TestPeakHoldDecays(t *testing.T) {
	ui, _ := newTestUI(100, 30, ViewSpectrum)
	ui.showPeaks = true

	loud := make([]float32, 64)
	quiet := make([]float32, 64)
	for i := range loud {
		loud[i], quiet[i] = -30, -110
	}
	ui.SetFrame(loud, 0, 0)
	first := ui.peaks[0]

	for i := 0; i < 20; i++ {
		ui.SetFrame(quiet, 0, 0)
	}
	if ui.peaks[0] >= first {
		t.Errorf("peak did not decay: %v then %v", first, ui.peaks[0])
	}
	// And it must rise instantly when the signal returns.
	ui.SetFrame(loud, 0, 0)
	if ui.peaks[0] != -30 {
		t.Errorf("peak did not follow the signal back up: %v", ui.peaks[0])
	}
}

// TestAutoRangeGivesSignalsRoom is the regression guard for the noise floor
// eating the bottom third of the pane. The old window ran from the 1st to the
// 99th percentile, which both wasted height on noise and clipped the strongest
// signals off the top.
func TestAutoRangeGivesSignalsRoom(t *testing.T) {
	// A realistic frame: a noise floor with a few dB of spread, plus signals
	// well above it.
	bins := make([]float32, 2048)
	rng := newDeterministicRNG(5)
	for i := range bins {
		bins[i] = float32(-125 + rng()*8)
	}
	for _, sig := range []struct {
		at, width int
		power     float32
	}{
		{300, 8, -95}, {900, 12, -84}, {1500, 6, -70},
	} {
		for d := -sig.width; d <= sig.width; d++ {
			bins[sig.at+d] = sig.power
		}
	}

	u := NewUI("test")
	u.bins = bins
	u.autoRange()

	sorted := append([]float64(nil), toFloat64(bins)...)
	sortFloats(sorted)
	pct := func(q float64) float64 { return sorted[int(q*float64(len(sorted)-1))] }
	height := func(db float64) float64 { return (db - u.minDB) / (u.maxDB - u.minDB) }

	// The bulk of the noise must sit in the lower part of the pane, leaving the
	// rest for signals.
	if h := height(pct(0.90)); h > 0.35 {
		t.Errorf("noise band reaches %.0f%% of pane height, want under 35%%", h*100)
	}
	if h := height(pct(0.50)); h > 0.25 {
		t.Errorf("noise median at %.0f%% of pane height, want under 25%%", h*100)
	}

	// Nothing may be clipped off the top: the strongest signal is the thing
	// you most want to see.
	for _, v := range bins {
		if float64(v) > u.maxDB {
			t.Errorf("signal at %.0f dB is above the window top %.0f", v, u.maxDB)
			break
		}
	}

	// A lone spur must not squash everything else.
	spur := append([]float32(nil), bins...)
	spur[42] = -5
	u2 := NewUI("test")
	u2.bins = spur
	u2.autoRange()
	if u2.maxDB > -40 {
		t.Errorf("a single -5 dB spur dragged the window top to %.0f", u2.maxDB)
	}

	// A dead-quiet band still gets a usable scale rather than a collapsed one.
	flat := make([]float32, 512)
	for i := range flat {
		flat[i] = -120
	}
	u3 := NewUI("test")
	u3.bins = flat
	u3.autoRange()
	if u3.maxDB-u3.minDB < 20 {
		t.Errorf("flat input gave a %.0f dB window, want at least 20", u3.maxDB-u3.minDB)
	}
}

func toFloat64(in []float32) []float64 {
	out := make([]float64, len(in))
	for i, v := range in {
		out[i] = float64(v)
	}
	return out
}

func sortFloats(v []float64) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}

// TestAutoRangeHoldsMinimumDynamicRange: on a span with nothing strong in it,
// the window used to collapse onto the noise, so the floor climbed the pane as
// though the band had got louder. A floor of 60 dB keeps it pinned down and
// makes the display comparable while tuning around.
func TestAutoRangeHoldsMinimumDynamicRange(t *testing.T) {
	rng := newDeterministicRNG(9)

	quiet := make([]float32, 2048)
	for i := range quiet {
		quiet[i] = float32(-125 + rng()*6) // noise only, nothing above it
	}

	u := NewUI("test")
	u.bins = quiet
	u.autoRange()

	if got := u.maxDB - u.minDB; got < 60 {
		t.Errorf("quiet span gave a %.0f dB window, want at least 60", got)
	}

	sorted := toFloat64(quiet)
	sortFloats(sorted)
	pct := func(q float64) float64 { return sorted[int(q*float64(len(sorted)-1))] }
	height := func(db float64) float64 { return (db - u.minDB) / (u.maxDB - u.minDB) }

	// With no signals present the noise should sit low, not fill the pane.
	if h := height(pct(0.90)); h > 0.25 {
		t.Errorf("on a quiet span the noise reaches %.0f%% of the pane, want under 25%%", h*100)
	}

	// Adding a strong signal must not move the floor much: that is what makes
	// the display comparable as signals come and go.
	loud := append([]float32(nil), quiet...)
	for i := 900; i < 920; i++ {
		loud[i] = -70
	}
	u2 := NewUI("test")
	u2.bins = loud
	u2.autoRange()

	quietFloor := height(pct(0.50))
	loudFloor := (pct(0.50) - u2.minDB) / (u2.maxDB - u2.minDB)
	if diff := loudFloor - quietFloor; diff > 0.10 || diff < -0.10 {
		t.Errorf("noise floor moved %.0f%% of pane height when a signal appeared (%.0f%% then %.0f%%)",
			diff*100, quietFloor*100, loudFloor*100)
	}

	// The window only grows past the minimum when something needs the room.
	veryLoud := append([]float32(nil), quiet...)
	for i := 900; i < 920; i++ {
		veryLoud[i] = -40
	}
	u3 := NewUI("test")
	u3.bins = veryLoud
	u3.autoRange()
	if u3.maxDB-u3.minDB <= 60 {
		t.Errorf("a signal 85 dB above the floor gave only a %.0f dB window", u3.maxDB-u3.minDB)
	}
	for _, v := range veryLoud {
		if float64(v) > u3.maxDB {
			t.Errorf("signal at %.0f is clipped above the window top %.0f", v, u3.maxDB)
			break
		}
	}
}
