package main

import "math"

// wfRow is one captured spectrum line. Each row remembers the frequency range
// it was captured at, so history stays correctly aligned to the frequency axis
// after the user pans or zooms instead of smearing sideways.
type wfRow struct {
	bins  []float32
	start float64 // frequency of the first bin
	span  float64 // total width covered by the row
}

// Waterfall is a fixed-capacity ring buffer of spectrum lines, newest first.
type Waterfall struct {
	rows []wfRow
	head int // index of the newest row
	n    int // number of rows currently held
}

// maxWaterfallRows bounds memory regardless of terminal height. At 2048 bins
// this is roughly 4 MB, and no terminal shows more than a few hundred rows.
const maxWaterfallRows = 512

func NewWaterfall() *Waterfall {
	return &Waterfall{rows: make([]wfRow, maxWaterfallRows)}
}

// Push records a new line. The bins are copied because the caller reuses its
// buffer between frames.
func (w *Waterfall) Push(bins []float32, start, span float64) {
	if len(bins) == 0 || span <= 0 {
		return
	}
	w.head = (w.head + 1) % len(w.rows)

	row := &w.rows[w.head]
	if cap(row.bins) >= len(bins) {
		row.bins = row.bins[:len(bins)]
	} else {
		row.bins = make([]float32, len(bins))
	}
	copy(row.bins, bins)
	row.start, row.span = start, span

	if w.n < len(w.rows) {
		w.n++
	}
}

// Row returns the age-th most recent line, where age 0 is newest.
func (w *Waterfall) Row(age int) (wfRow, bool) {
	if age < 0 || age >= w.n {
		return wfRow{}, false
	}
	idx := w.head - age
	if idx < 0 {
		idx += len(w.rows)
	}
	return w.rows[idx], true
}

func (w *Waterfall) Len() int { return w.n }

func (w *Waterfall) Clear() { w.n, w.head = 0, 0 }

// ValueAt samples a row at an absolute frequency, reporting false when that
// frequency falls outside the range the row was captured over.
func (r wfRow) ValueAt(freq float64) (float32, bool) {
	if r.span <= 0 || len(r.bins) == 0 {
		return 0, false
	}
	frac := (freq - r.start) / r.span
	if frac < 0 || frac >= 1 {
		return 0, false
	}
	idx := int(frac * float64(len(r.bins)))
	if idx < 0 || idx >= len(r.bins) {
		return 0, false
	}
	return r.bins[idx], true
}

// waterfallPalette is a classic SDR gradient: black through blue and green to
// yellow, red and finally white for the strongest signals.
var waterfallPalette = []colorStop{
	{0.00, 0, 0, 0},
	{0.12, 0, 0, 70},
	{0.28, 0, 30, 170},
	{0.44, 0, 160, 195},
	{0.58, 0, 200, 90},
	{0.72, 235, 220, 0},
	{0.88, 250, 90, 0},
	{1.00, 255, 255, 255},
}

type colorStop struct {
	at      float64
	r, g, b int32
}

// interpolate maps 0..1 onto a stop list with linear blending between stops.
func interpolate(stops []colorStop, f float64) (int32, int32, int32) {
	if math.IsNaN(f) || f <= 0 {
		s := stops[0]
		return s.r, s.g, s.b
	}
	if f >= 1 {
		s := stops[len(stops)-1]
		return s.r, s.g, s.b
	}
	for i := 1; i < len(stops); i++ {
		if f <= stops[i].at {
			a, b := stops[i-1], stops[i]
			width := b.at - a.at
			if width <= 0 {
				return b.r, b.g, b.b
			}
			t := (f - a.at) / width
			lerp := func(x, y int32) int32 { return x + int32(float64(y-x)*t) }
			return lerp(a.r, b.r), lerp(a.g, b.g), lerp(a.b, b.b)
		}
	}
	s := stops[len(stops)-1]
	return s.r, s.g, s.b
}
