package main

import (
	"fmt"
	"strings"

	"github.com/gdamore/tcell/v2"
)

type PickerTab int

const (
	TabPublic PickerTab = iota
	TabLocal
	TabManual
)

var pickerTabNames = []string{"Public", "Local", "Manual"}

// Picker is the modal receiver chooser. It covers the whole screen and owns
// its own key handling while visible.
type Picker struct {
	tab    PickerTab
	cursor int

	public     []Instance
	publicErr  error
	publicBusy bool

	local *LocalDiscovery

	// The filter is always live on the list tabs: printable keys type into it
	// directly rather than needing a mode to be entered first.
	filter string

	manualBuf string

	// Set when the picker was opened with no connection behind it, in which
	// case cancelling should quit rather than return to an empty display.
	mustChoose bool
}

func NewPicker(local *LocalDiscovery) *Picker {
	return &Picker{local: local, manualBuf: ""}
}

// entries returns the instances for the current tab after filtering.
func (p *Picker) entries() []Instance {
	var src []Instance
	switch p.tab {
	case TabPublic:
		src = p.public
	case TabLocal:
		if p.local != nil {
			src = p.local.Instances()
		}
	default:
		return nil
	}

	out := make([]Instance, 0, len(src))
	for _, inst := range src {
		if inst.matches(p.filter) {
			out = append(out, inst)
		}
	}
	return out
}

func (p *Picker) clampCursor() {
	n := len(p.entries())
	if n == 0 {
		p.cursor = 0
		return
	}
	p.cursor = clampInt(p.cursor, 0, n-1)
}

// HandleKey processes a key press. It returns the chosen instance (nil if none
// yet) and whether the picker should close.
func (p *Picker) HandleKey(ev *tcell.EventKey) (*Instance, bool) {
	if p.tab == TabManual {
		switch ev.Key() {
		case tcell.KeyEnter:
			if inst, ok := parseManualTarget(p.manualBuf); ok {
				return &inst, true
			}
			return nil, false
		case tcell.KeyBackspace, tcell.KeyBackspace2:
			if n := len(p.manualBuf); n > 0 {
				p.manualBuf = p.manualBuf[:n-1]
			}
			return nil, false
		case tcell.KeyRune:
			p.manualBuf += string(ev.Rune())
			return nil, false
		}
		// Anything else falls through to navigation so Tab and Esc still work.
	}

	switch ev.Key() {
	case tcell.KeyEscape:
		// Escape backs out of the filter first, so a typed search never traps
		// the user into closing the picker to clear it.
		if p.filter != "" {
			p.filter = ""
			p.cursor = 0
			return nil, false
		}
		return nil, !p.mustChoose

	case tcell.KeyBackspace, tcell.KeyBackspace2:
		if n := len(p.filter); n > 0 {
			// Trim a whole rune, not a byte, so accented names delete cleanly.
			runes := []rune(p.filter)
			p.filter = string(runes[:len(runes)-1])
			p.cursor = 0
		}

	case tcell.KeyTab, tcell.KeyRight:
		p.tab = (p.tab + 1) % 3
		p.cursor = 0
	case tcell.KeyBacktab, tcell.KeyLeft:
		p.tab = (p.tab + 2) % 3
		p.cursor = 0

	case tcell.KeyUp:
		p.cursor--
		p.clampCursor()
	case tcell.KeyDown:
		p.cursor++
		p.clampCursor()
	case tcell.KeyHome:
		p.cursor = 0
	case tcell.KeyEnd:
		p.cursor = len(p.entries())
		p.clampCursor()
	case tcell.KeyPgUp:
		p.cursor -= 10
		p.clampCursor()
	case tcell.KeyPgDn:
		p.cursor += 10
		p.clampCursor()

	case tcell.KeyEnter:
		list := p.entries()
		if p.cursor >= 0 && p.cursor < len(list) {
			inst := list[p.cursor]
			return &inst, true
		}

	case tcell.KeyCtrlC:
		return nil, true

	case tcell.KeyCtrlU:
		p.filter = ""
		p.cursor = 0

	case tcell.KeyRune:
		// Every printable key types into the filter. Navigation is on the
		// arrows and paging keys so that letters stay available for searching
		// — a receiver called "Quiet" would otherwise be unsearchable if 'q'
		// meant quit.
		p.filter += string(ev.Rune())
		p.cursor = 0
	}

	p.clampCursor()
	return nil, false
}

// parseManualTarget turns typed text into an instance. It accepts host,
// host:port or a full URL.
func parseManualTarget(text string) (Instance, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Instance{}, false
	}
	host, useTLS := parseServer(text, false)
	if host == "" {
		return Instance{}, false
	}
	// A bare host with no port and no scheme almost always means a local
	// receiver on the default port.
	if !strings.Contains(host, ":") && !useTLS {
		host += ":8080"
	}
	return Instance{Name: host, Host: host, TLS: useTLS, Available: -1}, true
}

func (p *Picker) Draw(s tcell.Screen) {
	w, h := s.Size()
	if w < 30 || h < 10 {
		drawText(s, 0, 0, tcell.StyleDefault, "terminal too small")
		return
	}

	bg := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(220, 220, 235)).
		Background(tcell.NewRGBColor(22, 22, 32))
	accent := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(255, 205, 90)).
		Background(tcell.NewRGBColor(22, 22, 32)).Bold(true)
	dim := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(130, 130, 145)).
		Background(tcell.NewRGBColor(22, 22, 32))

	for y := 0; y < h; y++ {
		drawText(s, 0, y, bg, strings.Repeat(" ", w))
	}

	drawText(s, 2, 1, accent, "Select a receiver")

	// Tab bar, with counts so the user can see what each source found.
	x := 2
	for i, name := range pickerTabNames {
		label := " " + name + " "
		switch PickerTab(i) {
		case TabPublic:
			if p.publicBusy {
				label = " Public … "
			} else {
				label = fmt.Sprintf(" Public %d ", len(p.public))
			}
		case TabLocal:
			n := 0
			if p.local != nil {
				n = len(p.local.Instances())
			}
			label = fmt.Sprintf(" Local %d ", n)
		}

		style := dim
		if PickerTab(i) == p.tab {
			style = tcell.StyleDefault.
				Foreground(tcell.ColorBlack).
				Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)
		}
		drawText(s, x, 3, style, label)
		x += len(label) + 1
	}

	if p.tab == TabManual {
		p.drawManual(s, pickerListTop, w, bg, accent, dim)
	} else {
		p.drawList(s, w, h, bg, accent, dim)
	}

	hint := " type to search · ↑↓ or click · enter or click again to connect · tab switch source · esc close "
	if p.mustChoose {
		hint = " type to search · ↑↓ or click · enter or click again to connect · tab switch source · ^C quit "
	}
	if p.filter != "" {
		hint = " ↑↓ move · enter connect · esc clear search · ^U clear · tab switch source "
	}
	if p.tab == TabManual {
		hint = " type host:port or a URL · enter connect · tab switch source "
	}
	drawText(s, 0, h-1, tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(200, 200, 210)).
		Background(tcell.NewRGBColor(45, 45, 55)), padTo(hint, w))
}

func (p *Picker) drawManual(s tcell.Screen, top, w int, bg, accent, dim tcell.Style) {
	drawText(s, 2, top, dim, "Connect to a specific receiver:")

	field := p.manualBuf + "▏"
	drawText(s, 2, top+2, accent, padTo("  "+field, minInt(w-4, 60)))

	for i, line := range []string{
		"Examples:",
		"  192.168.1.50:8080        a receiver on the LAN",
		"  https://example.org      a public receiver over TLS",
		"  localhost                port 8080 is assumed",
	} {
		style := dim
		if i == 0 {
			style = bg
		}
		drawText(s, 2, top+4+i, style, line)
	}
}

// The list geometry, shared by drawing and hit testing so a click can never
// land on a different entry than the one under the pointer.
const (
	pickerListTop = 5 // first row of the list; the search box sits above it
	pickerRows    = 2 // rows per entry: name, then its details
)

// listWindow returns how many entries fit at this terminal height and which one
// is at the top after scrolling to keep the cursor in view.
func (p *Picker) listWindow(h int) (visible, first int) {
	visible = (h - 3 - pickerListTop) / pickerRows
	if visible < 1 {
		visible = 1
	}
	if p.cursor >= visible {
		first = p.cursor - visible + 1
	}
	return visible, first
}

// EntryAt reports which entry covers a screen position, so the list can be
// worked with the mouse as well as the keyboard.
func (p *Picker) EntryAt(h, y int) (int, bool) {
	if p.tab == TabManual || y < pickerListTop {
		return 0, false
	}
	visible, first := p.listWindow(h)
	row := (y - pickerListTop) / pickerRows
	if row >= visible {
		return 0, false
	}
	idx := first + row
	if idx >= len(p.entries()) {
		return 0, false
	}
	return idx, true
}

func (p *Picker) drawList(s tcell.Screen, w, h int, bg, accent, dim tcell.Style) {
	const top = pickerListTop

	// The search box is always visible so it is obvious that typing filters.
	if p.filter == "" {
		drawText(s, 2, top-1, dim, "search: ▏(type to filter by callsign, name or location)")
	} else {
		drawText(s, 2, top-1, accent, "search: "+p.filter+"▏")
	}

	list := p.entries()
	if len(list) == 0 {
		msg := "No receivers found."
		switch {
		case p.tab == TabPublic && p.publicBusy:
			msg = "Loading the public directory…"
		case p.tab == TabPublic && p.publicErr != nil:
			msg = "Could not load the public directory: " + p.publicErr.Error()
		case p.tab == TabLocal:
			msg = "Searching the local network for receivers…"
		case p.filter != "":
			msg = "Nothing matches " + p.filter
		}
		drawText(s, 2, top+1, dim, msg)
		return
	}

	visible, first := p.listWindow(h)

	for i := 0; i < visible && first+i < len(list); i++ {
		inst := list[first+i]
		y := top + i*pickerRows
		selected := first+i == p.cursor

		nameStyle, detailStyle := bg, dim
		if selected {
			nameStyle = tcell.StyleDefault.
				Foreground(tcell.ColorBlack).
				Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)
			detailStyle = tcell.StyleDefault.
				Foreground(tcell.NewRGBColor(90, 80, 40)).
				Background(tcell.NewRGBColor(255, 205, 90))
			drawText(s, 0, y, nameStyle, strings.Repeat(" ", w))
			drawText(s, 0, y+1, detailStyle, strings.Repeat(" ", w))
		}

		marker := "  "
		if selected {
			marker = "▶ "
		}
		drawText(s, 1, y, nameStyle, marker+truncate(inst.Label(), w-4))
		drawText(s, 1, y+1, detailStyle, "    "+truncate(inst.Detail(), w-6))
	}

	if len(list) > visible {
		drawText(s, w-14, top-1, dim,
			fmt.Sprintf("%d of %d", p.cursor+1, len(list)))
	}
}

func truncate(s string, max int) string {
	if max <= 1 {
		return ""
	}
	// Count runes so multi-byte names aren't cut mid-character.
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
