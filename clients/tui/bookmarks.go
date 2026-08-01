package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/gdamore/tcell/v2"
)

// BookmarkPanel is the modal bookmark browser: everything the receiver serves,
// in frequency order, filtered live as the user types. It is drawn over the
// display rather than replacing it, so the spectrum keeps running behind.
//
// The list is read from the UI on every keypress and draw rather than snapshot
// on open: the markers arrive asynchronously and refresh on a timer, so a
// snapshot could show an empty list on a receiver whose bookmarks were still in
// flight when the panel opened.
type BookmarkPanel struct {
	cursor int

	// The filter is always live: printable keys type into it directly, so
	// navigation lives on the arrow and paging keys — exactly as in the
	// receiver picker, and for the same reason.
	filter string
}

func NewBookmarkPanel() *BookmarkPanel { return &BookmarkPanel{} }

// matches reports whether a bookmark satisfies a search string.
//
// Terms are matched independently and all must hit, so "cw 20" finds "CW 20m"
// however the fields are ordered. The frequency is searchable in both the
// units it gets quoted in — 7074 as kHz and 7.0740 as MHz — because that is how
// people actually look one up.
func (b Bookmark) matches(filter string) bool {
	if filter == "" {
		return true
	}
	hay := strings.ToLower(fmt.Sprintf("%s %s %s %.0f %.4f",
		b.Name, b.Group, b.Mode, b.Frequency/1000, b.Frequency/1e6))
	for _, term := range strings.Fields(strings.ToLower(filter)) {
		if !strings.Contains(hay, term) {
			return false
		}
	}
	return true
}

// entries returns the bookmarks to show, in frequency order. The server's own
// order is arbitrary; frequency order makes the list read like a band plan and
// keeps a station's entries together.
func (p *BookmarkPanel) entries(u *UI) []Bookmark {
	out := make([]Bookmark, 0, len(u.bookmarks))
	for _, b := range u.bookmarks {
		if b.matches(p.filter) {
			out = append(out, b)
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		return out[a].Frequency < out[b].Frequency
	})
	return out
}

func (p *BookmarkPanel) clampCursor(u *UI) {
	n := len(p.entries(u))
	if n == 0 {
		p.cursor = 0
		return
	}
	p.cursor = clampInt(p.cursor, 0, n-1)
}

// HandleKey processes a key press, returning the chosen bookmark (nil if none
// yet) and whether the panel should close.
func (p *BookmarkPanel) HandleKey(ev *tcell.EventKey, u *UI) (*Bookmark, bool) {
	switch ev.Key() {
	case tcell.KeyEscape:
		// Escape clears the search first, so a typed filter never traps the
		// user into closing the panel to get the full list back.
		if p.filter != "" {
			p.filter = ""
			p.cursor = 0
			return nil, false
		}
		return nil, true

	case tcell.KeyCtrlC:
		return nil, true

	case tcell.KeyCtrlU:
		p.filter = ""
		p.cursor = 0

	case tcell.KeyBackspace, tcell.KeyBackspace2:
		if n := len(p.filter); n > 0 {
			// Trim a whole rune, not a byte, so accented names delete cleanly.
			runes := []rune(p.filter)
			p.filter = string(runes[:len(runes)-1])
			p.cursor = 0
		}

	case tcell.KeyUp:
		p.cursor--
	case tcell.KeyDown:
		p.cursor++
	case tcell.KeyPgUp:
		p.cursor -= 10
	case tcell.KeyPgDn:
		p.cursor += 10
	case tcell.KeyHome:
		p.cursor = 0
	case tcell.KeyEnd:
		p.cursor = len(p.entries(u))

	case tcell.KeyEnter:
		list := p.entries(u)
		if p.cursor >= 0 && p.cursor < len(list) {
			bm := list[p.cursor]
			return &bm, true
		}

	case tcell.KeyRune:
		p.filter += string(ev.Rune())
		p.cursor = 0
	}

	p.clampCursor(u)
	return nil, false
}

// bookmarkPanelWidth is wide enough for a frequency, a mode, a full-length name
// and the group it came from.
const bookmarkPanelWidth = 74

func (p *BookmarkPanel) Draw(s tcell.Screen, u *UI) {
	w, h := s.Size()
	if w < 40 || h < 12 {
		return
	}

	width := minInt(bookmarkPanelWidth, w-4)
	// Take nearly the whole height: a receiver carrying the EiBi schedule
	// serves well over a thousand entries, and rows are worth more here than a
	// glimpse of the spectrum behind the panel.
	height := h - 4
	x0, y0 := (w-width)/2, (h-height)/2

	bg := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(220, 220, 235)).
		Background(tcell.NewRGBColor(28, 28, 38))
	title := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(255, 205, 90)).
		Background(tcell.NewRGBColor(28, 28, 38)).Bold(true)
	dim := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(140, 140, 155)).
		Background(tcell.NewRGBColor(28, 28, 38))
	sel := tcell.StyleDefault.
		Foreground(tcell.ColorBlack).
		Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)
	selDim := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(90, 80, 40)).
		Background(tcell.NewRGBColor(255, 205, 90))

	for y := y0; y < y0+height; y++ {
		drawText(s, x0, y, bg, strings.Repeat(" ", width))
	}
	drawText(s, x0, y0, title, padTo(" Bookmarks", width))

	list := p.entries(u)
	if p.filter == "" {
		drawText(s, x0+1, y0+1, dim, " search: ▏(type to filter by name, frequency, mode or group)")
	} else {
		drawText(s, x0+1, y0+1, title, truncate(" search: "+p.filter+"▏", width-2))
	}
	if len(list) > 0 {
		count := fmt.Sprintf("%d of %d ", p.cursor+1, len(list))
		drawText(s, x0+width-runeLen(count)-1, y0+1, dim, count)
	}

	hint := " ↑↓ move · enter tune · esc close "
	if p.filter != "" {
		hint = " ↑↓ move · enter tune · esc clear search · ^U clear "
	}
	drawText(s, x0, y0+height-1, tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(200, 200, 210)).
		Background(tcell.NewRGBColor(45, 45, 55)), padTo(hint, width))

	top, rows := y0+3, height-4
	if rows < 1 {
		return
	}
	if len(list) == 0 {
		msg := "This receiver serves no bookmarks."
		if len(u.bookmarks) > 0 {
			msg = "Nothing matches " + p.filter
		}
		drawText(s, x0+2, top, dim, truncate(msg, width-3))
		return
	}

	// Scroll so the cursor stays in view, keeping it a page at a time rather
	// than pinning it to the bottom row.
	first := 0
	if p.cursor >= rows {
		first = p.cursor - rows + 1
	}

	for i := 0; i < rows && first+i < len(list); i++ {
		bm := list[first+i]
		y := top + i

		style, groupStyle, marker := bg, dim, "  "
		if first+i == p.cursor {
			style, groupStyle, marker = sel, selDim, "▶ "
			drawText(s, x0, y, sel, strings.Repeat(" ", width))
		}

		// The group is right-aligned so the names stay in one column, and it is
		// what tells an operator's own bookmark from an EiBi broadcast.
		group := ""
		if bm.Group != "" {
			group = truncate(bm.Group, 16) + " "
		}
		line := fmt.Sprintf("%s%9.4f  %-4s %s",
			marker, bm.Frequency/1e6, strings.ToUpper(bm.Mode), bm.Name)
		drawText(s, x0+1, y, style, truncate(line, width-2-runeLen(group)))
		if group != "" {
			drawText(s, x0+width-runeLen(group), y, groupStyle, group)
		}
	}
}
