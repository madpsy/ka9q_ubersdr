package main

import (
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

// A UI with audio running, so the header carries both clickable fields, drawn
// on a screen wide enough that neither is shed.
func headerTestLoop(t *testing.T, w int) (*eventLoop, tcell.SimulationScreen) {
	t.Helper()
	ui, screen := newTestUI(w, 24, ViewSplit)
	ui.vfo = 7_120_000
	ui.audioOn = true
	ui.audioMode = "lsb"
	ui.bwLow, ui.bwHigh = -2850, -50
	ui.Draw(screen)
	return &eventLoop{ui: ui, screen: screen}, screen
}

// The column a piece of header text was drawn at, so a test clicks where the
// user would rather than where the layout is assumed to have put it.
func headerColumnOf(t *testing.T, screen tcell.SimulationScreen, text string) int {
	t.Helper()
	row := strings.SplitN(dump(screen), "\n", 2)[0]
	i := strings.Index(row, text)
	if i < 0 {
		t.Fatalf("%q is not in the header: %q", text, row)
	}
	return len([]rune(row[:i]))
}

func TestHeaderClickOnFrequencyOpensThePrompt(t *testing.T) {
	e, screen := headerTestLoop(t, 150)
	x := headerColumnOf(t, screen, "VFO")

	e.handleMouse(tcell.NewEventMouse(x, 0, tcell.ButtonPrimary, tcell.ModNone))
	if !e.ui.prompting {
		t.Error("clicking the frequency did not open the prompt")
	}
	if e.ui.promptBuf != "" {
		t.Errorf("prompt opened with %q already in it", e.ui.promptBuf)
	}
}

// The digits are part of the same field as the label: somebody aiming at the
// frequency is aiming at what they can see, which is the number.
func TestHeaderClickOnTheDigitsCountsToo(t *testing.T) {
	e, screen := headerTestLoop(t, 150)
	x := headerColumnOf(t, screen, "7.1200")

	e.handleMouse(tcell.NewEventMouse(x, 0, tcell.ButtonPrimary, tcell.ModNone))
	if !e.ui.prompting {
		t.Error("clicking the frequency digits did not open the prompt")
	}
}

func TestHeaderClickOnModeCycles(t *testing.T) {
	e, screen := headerTestLoop(t, 150)
	x := headerColumnOf(t, screen, "LSB")

	before := e.ui.audioMode
	e.handleMouse(tcell.NewEventMouse(x, 0, tcell.ButtonPrimary, tcell.ModNone))
	if e.ui.audioMode == before {
		t.Errorf("clicking the mode left it at %q", e.ui.audioMode)
	}
	if !strings.Contains(e.ui.status, "mode ") {
		t.Errorf("no feedback for the mode change: %q", e.ui.status)
	}
	// The same step the M key takes, not some other order.
	want := modes[(modeIndex(before)+1)%len(modes)].Name
	if e.ui.audioMode != want {
		t.Errorf("clicking gave %q, the M key gives %q", e.ui.audioMode, want)
	}
	if !e.ui.prompting {
		return // nothing else to check
	}
	t.Error("clicking the mode also opened the frequency prompt")
}

// The filter width sits in the same field as the mode and must not cycle it:
// only the mode itself is a button.
func TestHeaderClickOnFilterWidthDoesNothing(t *testing.T) {
	e, screen := headerTestLoop(t, 150)
	x := headerColumnOf(t, screen, "2.8k")

	before := e.ui.audioMode
	e.handleMouse(tcell.NewEventMouse(x, 0, tcell.ButtonPrimary, tcell.ModNone))
	if e.ui.audioMode != before {
		t.Errorf("clicking the filter width changed the mode to %q", e.ui.audioMode)
	}
	if e.ui.prompting {
		t.Error("clicking the filter width opened the frequency prompt")
	}
}

// A click on the header where nothing is drawn must not fall through to the
// plot and retune the radio.
func TestHeaderClickOnEmptySpaceIsInert(t *testing.T) {
	e, _ := headerTestLoop(t, 150)
	before := e.ui.vfo

	e.handleMouse(tcell.NewEventMouse(1, 0, tcell.ButtonPrimary, tcell.ModNone))
	if e.ui.prompting {
		t.Error("clicking the server name opened the frequency prompt")
	}
	if e.ui.vfo != before {
		t.Errorf("the VFO moved to %.0f", e.ui.vfo)
	}
}

// Hit-testing follows what was drawn. With audio off there is no mode field,
// and a click where it would have been must not reach one.
func TestHeaderHitsFollowWhatIsDrawn(t *testing.T) {
	e, screen := headerTestLoop(t, 150)
	modeX := headerColumnOf(t, screen, "LSB")

	e.ui.audioOn = false
	e.ui.Draw(screen)
	if what, ok := e.ui.HeaderAt(modeX, 0); ok && what == headerMode {
		t.Error("the mode is still clickable with the audio off")
	}

	// And nothing on row 0 is clickable from another row.
	e.ui.audioOn = true
	e.ui.Draw(screen)
	if _, ok := e.ui.HeaderAt(modeX, 1); ok {
		t.Error("a header field answers to a click on the row below it")
	}
}

// The key and the click share one path, so they cannot drift apart.
func TestModeCycleIsSharedWithTheKey(t *testing.T) {
	src := helpSource(t, "main.go")
	i := strings.Index(src, "case 'M':")
	if i < 0 {
		t.Fatal("the M key is no longer bound")
	}
	if !strings.Contains(src[i:i+80], "cycleAudioMode") {
		t.Error("the M key no longer goes through cycleAudioMode")
	}
}
