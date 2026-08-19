package main

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

func helpSource(t *testing.T, name string) string {
	t.Helper()
	src, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(src)
}

// The help is longer than the terminals people run this in, which is the whole
// reason it scrolls: if it ever fits, these tests are measuring nothing.
func TestHelpIsTallerThanATerminal(t *testing.T) {
	if len(helpLines) <= 22 {
		t.Skipf("help is %d lines and fits an 24-row terminal; scrolling is moot", len(helpLines))
	}
}

// The reported bug: on a terminal shorter than the help, the box was clipped at
// the screen edge and the lines past it could not be reached by any means.
func TestHelpScrollsToTheEnd(t *testing.T) {
	ui, screen := newTestUI(100, 24, ViewSplit)
	ui.showHelp = true

	ui.Draw(screen)
	first := dump(screen)
	if !strings.Contains(first, "Tuning") {
		t.Fatal("the help does not open at the top")
	}
	last := helpLines[len(helpLines)-1]
	if strings.Contains(first, strings.TrimSpace(last)) {
		t.Fatal("the whole help fits, so this test proves nothing")
	}

	// End, the way the key handler asks for it: past the end, for drawHelp to
	// clamp.
	ui.helpScroll = len(helpLines)
	ui.Draw(screen)
	out := dump(screen)
	if !strings.Contains(out, strings.TrimSpace(last)) {
		t.Errorf("the last help line is still unreachable:\n%s", out)
	}
	if ui.helpScroll >= len(helpLines) {
		t.Errorf("helpScroll was left at %d rather than clamped to a real line", ui.helpScroll)
	}
	// Clamped to the last page, not scrolled beyond it: the final line sits on
	// the bottom row of the box, so the rows above it are still help.
	if ui.helpScroll+ui.helpViewport != len(helpLines) {
		t.Errorf("scroll %d + viewport %d = %d, want the %d lines exactly",
			ui.helpScroll, ui.helpViewport, ui.helpScroll+ui.helpViewport, len(helpLines))
	}
}

// A scrollable overlay that does not say so looks complete when it is not,
// which is how the missing half went unnoticed.
func TestHelpShowsItsPosition(t *testing.T) {
	ui, screen := newTestUI(100, 24, ViewSplit)
	ui.showHelp = true
	ui.Draw(screen)

	if out := dump(screen); !strings.Contains(out, "of "+strconv.Itoa(len(helpLines))) {
		t.Errorf("no position indicator in the title:\n%s", out)
	}

	// On a terminal tall enough for all of it there is nothing to scroll, and
	// the indicator would be noise.
	tall, tallScreen := newTestUI(100, len(helpLines)+6, ViewSplit)
	tall.showHelp = true
	tall.Draw(tallScreen)
	if out := dump(tallScreen); strings.Contains(out, "of "+strconv.Itoa(len(helpLines))) {
		t.Errorf("position shown on a terminal that fits the whole help:\n%s", out)
	}
}

func TestHelpScrollKeys(t *testing.T) {
	e := &eventLoop{ui: NewUI("test")}
	e.ui.showHelp = true
	e.ui.helpViewport = 20 // as drawHelp would have left it

	for _, c := range []struct {
		name string
		ev   *tcell.EventKey
		want int
	}{
		{"down", tcell.NewEventKey(tcell.KeyDown, 0, tcell.ModNone), 1},
		{"j", tcell.NewEventKey(tcell.KeyRune, 'j', tcell.ModNone), 2},
		{"up", tcell.NewEventKey(tcell.KeyUp, 0, tcell.ModNone), 1},
		{"k", tcell.NewEventKey(tcell.KeyRune, 'k', tcell.ModNone), 0},
		{"page down", tcell.NewEventKey(tcell.KeyPgDn, 0, tcell.ModNone), 19},
		{"page up", tcell.NewEventKey(tcell.KeyPgUp, 0, tcell.ModNone), 0},
		{"end", tcell.NewEventKey(tcell.KeyEnd, 0, tcell.ModNone), len(helpLines)},
		{"home", tcell.NewEventKey(tcell.KeyHome, 0, tcell.ModNone), 0},
	} {
		if stop := e.handleHelpKey(c.ev); stop {
			t.Fatalf("%s stopped the loop", c.name)
		}
		if !e.ui.showHelp {
			t.Fatalf("%s closed the help", c.name)
		}
		if e.ui.helpScroll != c.want {
			t.Errorf("%s left helpScroll at %d, want %d", c.name, e.ui.helpScroll, c.want)
		}
	}
}

// Scrolling must not turn the overlay into something that has to be escaped
// from: anything that is not a scroll key still closes it.
func TestHelpAnyOtherKeyCloses(t *testing.T) {
	for _, ev := range []*tcell.EventKey{
		tcell.NewEventKey(tcell.KeyRune, ' ', tcell.ModNone),
		tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone),
		tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone),
		tcell.NewEventKey(tcell.KeyRune, '?', tcell.ModNone),
		tcell.NewEventKey(tcell.KeyLeft, 0, tcell.ModNone),
	} {
		e := &eventLoop{ui: NewUI("test")}
		e.ui.showHelp = true
		e.handleHelpKey(ev)
		if e.ui.showHelp {
			t.Errorf("%v left the help open", ev.Key())
		}
	}
}

// Reopening starts at the top rather than wherever the last look ended.
func TestHelpReopensAtTheTop(t *testing.T) {
	src := helpSource(t, "main.go")
	i := strings.Index(src, "case '?', 'h', 'H':")
	if i < 0 {
		t.Fatal("the help key is no longer bound")
	}
	if !strings.Contains(src[i:i+300], "helpScroll = 0") {
		t.Error("opening the help does not reset the scroll")
	}
}

// The wheel belongs to the overlay while it is up, like every other modal —
// otherwise it tunes the radio behind it.
func TestHelpOwnsTheWheel(t *testing.T) {
	src := helpSource(t, "main.go")
	i := strings.Index(src, "case *tcell.EventMouse:")
	if i < 0 {
		t.Fatal("mouse events are no longer handled")
	}
	region := src[i:]
	if end := strings.Index(region, "\nfunc "); end > 0 {
		region = region[:end]
	}
	showHelp := strings.Index(region, "showHelp")
	handleMouse := strings.Index(region, "e.handleMouse(ev)")
	if showHelp < 0 {
		t.Fatal("the mouse handler does not check for the help overlay")
	}
	if handleMouse >= 0 && showHelp > handleMouse {
		t.Error("the wheel reaches the radio before the help overlay sees it")
	}
}
