package main

import (
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

// panelBookmarks is a small list spanning several bands, groups and modes.
func panelBookmarks() []Bookmark {
	return []Bookmark{
		{Name: "CW 20m", Frequency: 14_050_000, Mode: "cwu", Group: "CW"},
		{Name: "FT8 40m", Frequency: 7_074_000, Mode: "usb", Group: "Digital Modes"},
		{Name: "Radio Habana", Frequency: 6_000_000, Mode: "am", Group: "EiBi"},
		{Name: "SSB 80m", Frequency: 3_700_000, Mode: "lsb", Group: "Voice"},
	}
}

func newPanelUI() *UI {
	u := NewUI("sim.example.org:8080")
	u.bookmarks = panelBookmarks()
	u.cfg = SpectrumConfig{
		CenterFreq:     7_100_000,
		BinCount:       1024,
		BinBandwidth:   200,
		TotalBandwidth: 204_800,
	}
	u.vfo = 7_100_000
	return u
}

func typeInto(p *BookmarkPanel, u *UI, text string) {
	for _, r := range text {
		p.HandleKey(tcell.NewEventKey(tcell.KeyRune, r, tcell.ModNone), u)
	}
}

func TestBookmarkPanelListsInFrequencyOrder(t *testing.T) {
	u := newPanelUI()
	list := NewBookmarkPanel().entries(u)

	if len(list) != len(u.bookmarks) {
		t.Fatalf("listed %d of %d bookmarks", len(list), len(u.bookmarks))
	}
	for i := 1; i < len(list); i++ {
		if list[i-1].Frequency > list[i].Frequency {
			t.Errorf("out of order at %d: %.0f then %.0f",
				i, list[i-1].Frequency, list[i].Frequency)
		}
	}
}

func TestBookmarkPanelFiltersLive(t *testing.T) {
	for _, tc := range []struct {
		typed string
		want  string
	}{
		{"habana", "Radio Habana"}, // name, case-insensitive
		{"7074", "FT8 40m"},        // frequency in kHz, as it is usually quoted
		{"7.074", "FT8 40m"},       // …and in MHz
		{"lsb", "SSB 80m"},         // mode
		{"digital", "FT8 40m"},     // group
		{"cw 20", "CW 20m"},        // two terms, both must hit
	} {
		u := newPanelUI()
		p := NewBookmarkPanel()
		typeInto(p, u, tc.typed)

		list := p.entries(u)
		if len(list) != 1 || list[0].Name != tc.want {
			names := make([]string, len(list))
			for i, b := range list {
				names[i] = b.Name
			}
			t.Errorf("%q matched %v, want just %q", tc.typed, names, tc.want)
		}
	}
}

func TestBookmarkPanelEnterChoosesTheHighlightedEntry(t *testing.T) {
	u := newPanelUI()
	p := NewBookmarkPanel()

	// Filter to one entry, then take it.
	typeInto(p, u, "habana")
	bm, done := p.HandleKey(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone), u)
	if bm == nil || !done {
		t.Fatalf("enter returned %+v done=%v", bm, done)
	}
	if bm.Name != "Radio Habana" {
		t.Errorf("chose %q", bm.Name)
	}

	// With nothing matching there is nothing to choose, and the panel stays
	// open rather than closing on an empty list.
	p = NewBookmarkPanel()
	typeInto(p, u, "nothing here")
	if bm, done := p.HandleKey(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone), u); bm != nil || done {
		t.Errorf("enter on an empty list returned %+v done=%v", bm, done)
	}
}

// Escape backs out of the search before it closes the panel, so a typed filter
// can never trap the user.
func TestBookmarkPanelEscapeClearsSearchFirst(t *testing.T) {
	u := newPanelUI()
	p := NewBookmarkPanel()
	typeInto(p, u, "cw")

	if _, done := p.HandleKey(tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone), u); done {
		t.Fatal("the first escape closed the panel instead of clearing the search")
	}
	if p.filter != "" {
		t.Errorf("search is still %q", p.filter)
	}
	if _, done := p.HandleKey(tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone), u); !done {
		t.Error("the second escape did not close the panel")
	}
}

// Navigation keys must not type into the search, and the cursor must stay on
// the list however far it is pushed.
func TestBookmarkPanelCursorStaysInRange(t *testing.T) {
	u := newPanelUI()
	p := NewBookmarkPanel()

	for _, key := range []tcell.Key{tcell.KeyEnd, tcell.KeyPgDn, tcell.KeyDown} {
		p.HandleKey(tcell.NewEventKey(key, 0, tcell.ModNone), u)
		if p.cursor >= len(u.bookmarks) {
			t.Fatalf("cursor ran off the end: %d", p.cursor)
		}
	}
	for _, key := range []tcell.Key{tcell.KeyHome, tcell.KeyPgUp, tcell.KeyUp} {
		p.HandleKey(tcell.NewEventKey(key, 0, tcell.ModNone), u)
		if p.cursor < 0 {
			t.Fatalf("cursor ran off the start: %d", p.cursor)
		}
	}
	if p.filter != "" {
		t.Errorf("navigation typed %q into the search", p.filter)
	}

	// Filtering down to fewer entries than the cursor's position must not leave
	// it pointing past the end.
	p.cursor = 3
	typeInto(p, u, "cw")
	if p.cursor >= len(p.entries(u)) {
		t.Errorf("cursor %d is past the %d filtered entries", p.cursor, len(p.entries(u)))
	}
}

func TestBookmarkPanelDraws(t *testing.T) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 30)

	u := newPanelUI()
	p := NewBookmarkPanel()
	u.Draw(screen)
	p.Draw(screen, u)
	screen.Show()

	out := dump(screen)
	t.Logf("\n%s", out)
	for _, want := range []string{"Bookmarks", "search:", "Radio Habana", "6.0000", "AM", "EiBi", "enter tune"} {
		if !strings.Contains(out, want) {
			t.Errorf("panel is missing %q", want)
		}
	}

	// An empty receiver says so rather than drawing a blank box.
	u.bookmarks = nil
	u.Draw(screen)
	p.Draw(screen, u)
	screen.Show()
	if !strings.Contains(dump(screen), "no bookmarks") {
		t.Error("an empty list did not explain itself")
	}
}

// The panel must survive any terminal it is drawn into, including ones too
// small to hold it.
func TestBookmarkPanelSurvivesAnySize(t *testing.T) {
	for _, size := range [][2]int{{1, 1}, {20, 6}, {40, 12}, {41, 13}, {80, 24}, {300, 90}} {
		screen := tcell.NewSimulationScreen("UTF-8")
		if err := screen.Init(); err != nil {
			t.Fatal(err)
		}
		screen.SetSize(size[0], size[1])

		u := newPanelUI()
		p := NewBookmarkPanel()
		p.cursor = 3
		u.Draw(screen)
		p.Draw(screen, u) // must not panic
	}
}

// b opens the panel and B keeps the trace style it displaced.
func TestBookmarkKeyOpensThePanel(t *testing.T) {
	e := &eventLoop{ui: newPanelUI()}
	was := e.ui.braille

	e.handleKey(tcell.NewEventKey(tcell.KeyRune, 'b', tcell.ModNone))
	if e.bookmarkPanel == nil {
		t.Fatal("b did not open the bookmark panel")
	}
	if e.ui.braille != was {
		t.Error("b changed the trace style as well")
	}

	e.bookmarkPanel = nil
	e.handleKey(tcell.NewEventKey(tcell.KeyRune, 'B', tcell.ModNone))
	if e.bookmarkPanel != nil {
		t.Error("B opened the bookmark panel")
	}
	if e.ui.braille == was {
		t.Error("B did not toggle the trace style")
	}
}

// Choosing an entry tunes the radio and closes the panel.
func TestBookmarkPanelKeysTuneAndClose(t *testing.T) {
	e := &eventLoop{ui: newPanelUI(), bookmarkPanel: NewBookmarkPanel()}
	typeInto(e.bookmarkPanel, e.ui, "ssb")
	e.handleBookmarkKey(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone))

	if e.bookmarkPanel != nil {
		t.Error("the panel stayed open after tuning")
	}
	if e.ui.vfo != 3_700_000 {
		t.Errorf("VFO is %.0f Hz, want the bookmark's own", e.ui.vfo)
	}
	if e.ui.audioMode != "lsb" {
		t.Errorf("mode is %q", e.ui.audioMode)
	}
}
