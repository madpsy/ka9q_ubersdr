package main

import (
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

// testMarkers gives a UI a band plan and bookmarks around the test centre
// frequency of 7.1 MHz with a 204.8 kHz span, so everything here is in view.
func testMarkers(u *UI) {
	u.bands = []Band{
		{Label: "40m", Start: 7_000_000, End: 7_200_000},
		{Label: "40m CW", Start: 7_000_000, End: 7_040_000},
	}
	u.bookmarks = []Bookmark{
		{Name: "FT8", Frequency: 7_074_000, Mode: "usb"},
		{Name: "Radio Habana", Frequency: 7_140_000, Mode: "am", Group: "EiBi"},
	}
}

// rowText reads one screen row back as a string.
func rowText(screen tcell.SimulationScreen, y int) string {
	cells, w, _ := screen.GetContents()
	var b strings.Builder
	for x := 0; x < w; x++ {
		runes := cells[y*w+x].Runes
		if len(runes) == 0 || runes[0] == 0 {
			b.WriteRune(' ')
			continue
		}
		b.WriteRune(runes[0])
	}
	return b.String()
}

func TestMarkerStripDrawsBandsAndBookmarks(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSplit)
	testMarkers(ui)
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, ui.markerRows())
	if l.MarkH != 2 || l.BodyY != 3 {
		t.Fatalf("strip did not claim its rows: MarkH=%d BodyY=%d", l.MarkH, l.BodyY)
	}

	bookmarks := rowText(screen, l.MarkY)
	bands := rowText(screen, l.MarkY+1)
	t.Logf("\n%s\n%s", bookmarks, bands)

	for _, want := range []string{"FT8", "Radio Habana"} {
		if !strings.Contains(bookmarks, want) {
			t.Errorf("bookmark row is missing %q: %q", want, bookmarks)
		}
	}
	if !strings.Contains(bands, "40m") {
		t.Errorf("band row is missing the band label: %q", bands)
	}
	// The nested CW segment is drawn over the wider band it sits inside, so
	// both labels survive.
	if !strings.Contains(bands, "40m CW") {
		t.Errorf("nested band was covered by the wider one: %q", bands)
	}
}

// The strip must not eat the spectrum on a short terminal, and drawing at any
// size must still be safe.
func TestMarkerStripYieldsToShortTerminals(t *testing.T) {
	for h := 1; h < 12; h++ {
		l := computeLayout(80, h, ViewSplit, 0.45, 2)
		body := l.AxisY - l.BodyY
		if l.MarkH > 0 && body < 2 {
			t.Errorf("h=%d: strip left only %d body rows", h, body)
		}
		if l.MarkH > 0 && l.MarkY+l.MarkH != l.BodyY {
			t.Errorf("h=%d: strip and body overlap (MarkY=%d MarkH=%d BodyY=%d)",
				h, l.MarkY, l.MarkH, l.BodyY)
		}

		ui, screen := newTestUI(80, h, ViewSplit)
		testMarkers(ui)
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
		ui.Draw(screen) // must not panic
	}
}

// The VFO marker, filter shading and crosshair all run down the panes, and must
// start below the strip rather than painting over it.
func TestOverlaysStopBelowTheMarkerStrip(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSplit)
	testMarkers(ui)
	ui.audioOn = true
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, ui.markerRows())
	ui.cursorX, ui.cursorY = ui.ColAt(l, ui.vfo), l.BodyY
	ui.Draw(screen)

	bands := rowText(screen, l.MarkY+1)
	for _, glyph := range []string{"│", "┆"} {
		if strings.Contains(bands, glyph) {
			t.Errorf("overlay glyph %q drawn into the band row: %q", glyph, bands)
		}
	}
}

func TestBookmarkLabelIsClickable(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSplit)
	testMarkers(ui)
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, ui.markerRows())
	col := ui.ColAt(l, 7_074_000)
	bm, ok := ui.BookmarkAt(l, col, l.MarkY)
	if !ok || bm.Name != "FT8" {
		t.Fatalf("click on the FT8 label found %+v (ok=%v)", bm, ok)
	}
	// Rows below the strip belong to the panes, where a click tunes instead.
	if _, ok := ui.BookmarkAt(l, col, l.BodyY); ok {
		t.Error("the body reported a bookmark hit")
	}
}

// The arrow is the marker: wherever the name ends up, the arrow must sit on the
// bookmark's own column, including at the right-hand edge where the label has
// to run backwards.
func TestBookmarkArrowMarksTheExactColumn(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSplit)
	ui.bookmarks = []Bookmark{
		{Name: "Left", Frequency: 7_010_000, Mode: "usb"},
		{Name: "Right", Frequency: 7_201_000, Mode: "usb"},
	}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, ui.markerRows())
	row := []rune(rowText(screen, l.MarkY))
	for _, bm := range ui.bookmarks {
		col := ui.ColAt(l, bm.Frequency)
		if col < 0 {
			t.Fatalf("%s is off-screen at column %d", bm.Name, col)
		}
		if row[col] != '▾' {
			t.Errorf("%s: column %d holds %q, not the marker", bm.Name, col, string(row[col]))
		}
	}
	if !strings.Contains(string(row), "Right▾") {
		t.Errorf("label at the right edge did not run backwards: %q", string(row))
	}
}

// A wide view holds far more bookmarks than columns, so the ones that survive
// have to be the useful ones: the operator's own before the EiBi schedule.
func TestCrowdedBookmarksKeepTheReceiversOwn(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSplit)
	ui.bookmarks = append(ui.bookmarks, Bookmark{
		Name: "Beacon", Frequency: 7_100_000, Mode: "cwu",
	})
	// Bury it in EiBi entries, several per screen column.
	for f := 7_000_000; f < 7_200_000; f += 500 {
		ui.bookmarks = append(ui.bookmarks, Bookmark{
			Name: "Broadcast", Frequency: float64(f), Mode: "am", Group: "EiBi",
		})
	}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, ui.markerRows())
	if !strings.Contains(rowText(screen, l.MarkY), "Beacon") {
		t.Errorf("the receiver's own bookmark was crowded out: %q", rowText(screen, l.MarkY))
	}
}

func TestTuneToBookmarkTakesModeAndFilter(t *testing.T) {
	low, high := -3000, -300
	e := &eventLoop{ui: NewUI("test")}
	e.ui.cfg = SpectrumConfig{CenterFreq: 7_100_000, TotalBandwidth: 204_800}

	e.tuneToBookmark(Bookmark{
		Name: "Net", Frequency: 7_150_000, Mode: "lsb",
		BandwidthLow: &low, BandwidthHigh: &high,
	})

	if e.ui.vfo != 7_150_000 {
		t.Errorf("VFO is %.0f Hz", e.ui.vfo)
	}
	if e.ui.audioMode != "lsb" {
		t.Errorf("mode is %q, want the bookmark's own", e.ui.audioMode)
	}
	if e.ui.bwLow != low || e.ui.bwHigh != high {
		t.Errorf("filter is %d/%d, want %d/%d", e.ui.bwLow, e.ui.bwHigh, low, high)
	}

	// Above 10 MHz the sideband convention says USB, but a bookmark that names
	// LSB means it: the automatic switch must not overrule it.
	e.tuneToBookmark(Bookmark{Name: "Odd", Frequency: 14_100_000, Mode: "lsb"})
	if e.ui.audioMode != "lsb" {
		t.Errorf("auto sideband overrode the bookmark: mode is %q", e.ui.audioMode)
	}
}
