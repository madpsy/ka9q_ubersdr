package main

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/gdamore/tcell/v2"
)

// Band is one entry from the receiver's band plan (/api/bands): a labelled
// frequency range such as "40m" or "49m".
type Band struct {
	Label string  `json:"label"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

func (b Band) width() float64 { return b.End - b.Start }

// Bookmark is one entry from /api/bookmarks: the receiver's own bookmarks and,
// on servers carrying the schedule, the EiBi broadcasts currently on air. Those
// arrive in the "EiBi" group, which is how they are told apart from the
// operator's own entries.
type Bookmark struct {
	Name          string  `json:"name"`
	Frequency     float64 `json:"frequency"`
	Mode          string  `json:"mode"`
	Group         string  `json:"group"`
	BandwidthLow  *int    `json:"bandwidth_low"`
	BandwidthHigh *int    `json:"bandwidth_high"`
}

func (b Bookmark) isEiBi() bool { return b.Group == "EiBi" }

// Markers is everything the strip above the panes draws. Both halves arrive
// together because they come from the same refresh.
type Markers struct {
	Bands     []Band
	Bookmarks []Bookmark
}

// markerRefresh is how often the strip is refetched. The band plan is static,
// but the EiBi bookmarks are the broadcasts on air *now*, so they go stale as
// schedules turn over.
const markerRefresh = 5 * time.Minute

// RunMarkers keeps the marker strip fed until ctx is cancelled.
//
// Neither endpoint is required: a receiver serving only one, or neither, gets a
// shorter strip rather than an error. Failures are reported once so a receiver
// without them does not repeat the same complaint every refresh.
func (c *Client) RunMarkers(ctx context.Context) {
	quiet := false
	for {
		var m Markers
		if err := c.getJSON("/api/bands", &m.Bands); err != nil && !quiet {
			c.report("band plan unavailable: " + err.Error())
		}
		if err := c.getJSON("/api/bookmarks", &m.Bookmarks); err != nil && !quiet {
			c.report("bookmarks unavailable: " + err.Error())
		}
		quiet = true

		if len(m.Bands) > 0 || len(m.Bookmarks) > 0 {
			select {
			case c.Markers <- m:
			case <-ctx.Done():
				return
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(markerRefresh):
		}
	}
}

// markerRows is how many rows the strip needs: one for the bookmarks and one
// for the band plan, and neither is drawn before its data has arrived.
func (u *UI) markerRows() int {
	n := 0
	if len(u.bookmarks) > 0 {
		n++
	}
	if len(u.bands) > 0 {
		n++
	}
	return n
}

// bandPalette is the web UI's band colouring: light pastels cycled by position
// in the band list, so the same band is the same colour in either client. They
// are light because the labels are drawn on them in black.
var bandPalette = []rgb{
	{255, 204, 204},
	{255, 217, 204},
	{255, 230, 204},
	{255, 255, 204},
	{230, 255, 204},
	{204, 255, 204},
	{204, 255, 230},
	{204, 230, 255},
	{204, 204, 255},
	{217, 204, 255},
}

// bookmarkHit records where a label was drawn, so a click can find it again.
type bookmarkHit struct {
	x0, x1 int // half-open column range
	bm     Bookmark
}

// drawMarkers paints the strip between the header and the panes: bookmarks on
// top, the band plan directly above the spectrum where it reads as a ruler
// over it.
func (u *UI) drawMarkers(s tcell.Screen, l Layout) {
	u.bookmarkHits = u.bookmarkHits[:0]
	if l.MarkH <= 0 {
		return
	}
	y := l.MarkY
	if len(u.bookmarks) > 0 {
		u.drawBookmarks(s, l, y)
		y++
	}
	if len(u.bands) > 0 {
		u.drawBandStrip(s, l, y)
	}
}

// drawBandStrip paints one row of coloured band segments across the view.
func (u *UI) drawBandStrip(s tcell.Screen, l Layout, y int) {
	start, span := u.viewRange()
	if span <= 0 {
		return
	}
	colOf := func(f float64) int {
		return clampInt(l.PlotX+int((f-start)/span*float64(l.PlotW)),
			l.PlotX, l.PlotX+l.PlotW-1)
	}

	// The gaps between bands are painted too, so the strip reads as a
	// continuous ruler and an unallocated stretch of spectrum is obvious.
	gap := tcell.StyleDefault.Background(tcell.NewRGBColor(55, 55, 65))
	for x := l.PlotX; x < l.PlotX+l.PlotW; x++ {
		s.SetContent(x, y, ' ', nil, gap)
	}

	// Widest first, so a narrow band nested inside a wider one is drawn over it
	// rather than under it and stays visible.
	order := make([]int, len(u.bands))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return u.bands[order[a]].width() > u.bands[order[b]].width()
	})

	for _, i := range order {
		b := u.bands[i]
		if b.End < start || b.Start > start+span || b.width() <= 0 {
			continue
		}
		// Colour follows the band's position in the list as the server sent it,
		// not the drawing order, so the palette matches the other clients.
		c := bandPalette[i%len(bandPalette)]
		style := tcell.StyleDefault.
			Foreground(tcell.ColorBlack).
			Background(tcell.NewRGBColor(c.r, c.g, c.b))

		lo, hi := colOf(b.Start), colOf(b.End)
		for x := lo; x <= hi; x++ {
			s.SetContent(x, y, ' ', nil, style)
		}

		// One space of padding either side keeps the label off its own edges,
		// where it would run into whatever neighbours the band.
		if w := hi - lo + 1; w >= 3 {
			if label := truncate(b.Label, w-2); label != "" {
				drawText(s, lo+(w-runeLen(label))/2, y, style, label)
			}
		}
	}
}

// maxBookmarkName bounds one label so a long broadcaster name cannot take the
// whole row.
const maxBookmarkName = 14

// drawBookmarks paints bookmark labels, each anchored to its own frequency.
func (u *UI) drawBookmarks(s tcell.Screen, l Layout, y int) {
	if _, span := u.viewRange(); span <= 0 {
		return
	}

	type candidate struct {
		col int
		bm  Bookmark
	}
	cands := make([]candidate, 0, 64)
	for _, b := range u.bookmarks {
		if col := u.ColAt(l, b.Frequency); col >= 0 {
			cands = append(cands, candidate{col, b})
		}
	}
	if len(cands) == 0 {
		return
	}

	// There is never room for every bookmark, so the ones worth keeping are
	// placed first and the rest fall away: the operator's own entries before the
	// EiBi schedule, and within each, those nearest the VFO — the part of the
	// spectrum actually being listened to.
	ref := u.vfo
	if ref <= 0 {
		ref = u.cfg.CenterFreq
	}
	sort.SliceStable(cands, func(a, b int) bool {
		ea, eb := cands[a].bm.isEiBi(), cands[b].bm.isEiBi()
		if ea != eb {
			return !ea
		}
		return math.Abs(cands[a].bm.Frequency-ref) < math.Abs(cands[b].bm.Frequency-ref)
	})

	occupied := make([]bool, l.W)
	for _, c := range cands {
		label := truncate(c.bm.Name, maxBookmarkName)
		if label == "" {
			continue
		}
		// The arrow sits on the exact column and the name runs whichever way
		// there is room for it, so a label near the right edge is shifted
		// without the marker ever misreporting the frequency.
		text := "▾" + label
		x := c.col
		if x+runeLen(text) > l.PlotX+l.PlotW {
			text = label + "▾"
			x = c.col - runeLen(text) + 1
		}
		if x < l.PlotX {
			continue
		}
		// Reserve a column either side so adjacent labels stay legible.
		if overlaps(occupied, x-1, runeLen(text)+2) {
			continue
		}
		mark(occupied, x-1, runeLen(text)+2)

		drawText(s, x, y, bookmarkStyle(c.bm), text)
		u.bookmarkHits = append(u.bookmarkHits,
			bookmarkHit{x0: x, x1: x + runeLen(text), bm: c.bm})
	}
}

// bookmarkStyle colours a label by where it came from. The operator's own
// bookmarks are gold, as in the web UI; EiBi schedule entries are dimmer, so a
// hand-curated frequency stands out from the broadcasts that merely happen to
// be on air.
func bookmarkStyle(b Bookmark) tcell.Style {
	if b.isEiBi() {
		return tcell.StyleDefault.
			Foreground(tcell.ColorBlack).
			Background(tcell.NewRGBColor(185, 160, 115))
	}
	return tcell.StyleDefault.
		Foreground(tcell.ColorBlack).
		Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)
}

// BookmarkAt reports the bookmark whose label covers a screen position, which
// is what makes the strip clickable.
func (u *UI) BookmarkAt(l Layout, x, y int) (Bookmark, bool) {
	if l.MarkH <= 0 || y != l.MarkY {
		return Bookmark{}, false
	}
	for _, h := range u.bookmarkHits {
		if x >= h.x0 && x < h.x1 {
			return h.bm, true
		}
	}
	return Bookmark{}, false
}
