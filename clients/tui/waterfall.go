package main

import "math"

// wfRow is one captured spectrum line. Each row remembers both the frequency
// range and the dB window in force when it was captured.
//
// The frequency range keeps history aligned to the axis across pans and zooms.
// The dB window keeps history visually stable: colouring old rows with the
// current window means every stored row is repainted whenever auto-ranging
// nudges that window, so a carrier sitting just below visibility appears as a
// vertical stripe through the whole history the instant the window shifts —
// signals seeming to arrive out of nowhere in the past.
type wfRow struct {
	bins         []float32
	start        float64 // frequency of the first bin
	span         float64 // total width covered by the row
	minDB, maxDB float64 // dB window at capture time
}

// norm maps a dB value onto 0..1 using the window this row was captured with.
func (r wfRow) norm(db float64) float64 {
	rng := r.maxDB - r.minDB
	if rng <= 0 {
		return 0
	}
	return math.Max(0, math.Min(1, (db-r.minDB)/rng))
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

// Push records a new line together with the frequency range and dB window it
// was captured under. The bins are copied because the caller reuses its buffer
// between frames.
func (w *Waterfall) Push(bins []float32, start, span, minDB, maxDB float64) {
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
	row.minDB, row.maxDB = minDB, maxDB

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

// ValueAt samples a row at a single absolute frequency, reporting false when
// that frequency falls outside the range the row was captured over.
//
// Prefer MaxBetween for rendering: point sampling discards every bin but one
// per screen position.
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

// MaxBetween returns the strongest bin covering [lo, hi), reporting false when
// that range lies outside what the row holds.
//
// Rendering must aggregate rather than point sample. Several bins collapse into
// each screen position, so picking just one means whether a given signal is
// visible depends on where the sample happens to land on the bin grid — and
// that mapping shifts whenever the view pans or zooms. The result is isolated
// bright cells winking in and out at random. Taking the maximum shows every
// signal in the covered range and matches how the spectrum pane decimates, so
// the two panes agree.
func (r wfRow) MaxBetween(lo, hi float64) (float32, bool) {
	loIdx, hiIdx, ok := r.binRange(lo, hi)
	if !ok {
		return 0, false
	}

	best := r.bins[loIdx]
	for _, v := range r.bins[loIdx+1 : hiIdx] {
		if v > best {
			best = v
		}
	}
	return best, true
}

// binRange maps a frequency span onto the half-open bin range covering it.
//
// Both edges truncate so consecutive sub-columns tile the bin array exactly:
// every bin belongs to one sub-column and none is counted twice. Rounding the
// upper edge up instead would let a strong bin bleed into its neighbour.
func (r wfRow) binRange(lo, hi float64) (int, int, bool) {
	n := len(r.bins)
	if r.span <= 0 || n == 0 || hi <= lo {
		return 0, 0, false
	}

	loIdx := int((lo - r.start) / r.span * float64(n))
	hiIdx := int((hi - r.start) / r.span * float64(n))
	if hiIdx <= loIdx {
		// Zoomed in far enough that one bin spans several sub-columns.
		hiIdx = loIdx + 1
	}
	if hiIdx <= 0 || loIdx >= n { // entirely outside the row
		return 0, 0, false
	}
	if loIdx < 0 {
		loIdx = 0
	}
	if hiIdx > n {
		hiIdx = n
	}
	return loIdx, hiIdx, true
}

// dbToLinear is ln(10)/10, converting dB to the exponent for linear power.
const dbToLinear = 0.23025850929940457

// MeanBetween returns the average power of the bins covering [lo, hi),
// expressed in dB, reporting false when that range lies outside the row.
//
// The waterfall averages where the spectrum takes a maximum, and the difference
// matters because the two encode magnitude differently. A single bin a few dB
// above the noise — a receiver birdie, or a very narrow carrier — is a barely
// visible bump on a height plot but a solid block of colour in a waterfall, and
// with a maximum it captures its whole screen position for as long as it lasts,
// drawing a vertical stripe through the entire history. Averaging weights such
// a bin by how much of the screen position it actually occupies, so the
// waterfall reads like the spectrum beside it, while signals that genuinely
// span several bins still show at full strength.
//
// The average is taken over linear power rather than over dB values: dB is
// logarithmic, so averaging it directly is a geometric mean that would
// under-represent strong signals.
func (r wfRow) MeanBetween(lo, hi float64) (float32, bool) {
	loIdx, hiIdx, ok := r.binRange(lo, hi)
	if !ok {
		return 0, false
	}
	if hiIdx-loIdx == 1 {
		return r.bins[loIdx], true
	}

	var sum float64
	for _, v := range r.bins[loIdx:hiIdx] {
		sum += math.Exp(float64(v) * dbToLinear)
	}
	mean := sum / float64(hiIdx-loIdx)
	if mean <= 0 {
		return r.bins[loIdx], true
	}
	return float32(math.Log(mean) / dbToLinear), true
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

// rgb is a resolved colour used while packing sub-cells into one glyph.
type rgb struct{ r, g, b int32 }

// Palettes are resolved once into 256 steps. The waterfall samples four
// sub-pixels per character cell, so this avoids walking the stop list on every
// one of them. (Measured: it is not where the render time goes — that is
// tcell's per-cell SetContent — but it keeps the inner loop a plain lookup.)
var (
	waterfallLUT = buildLUT(waterfallPalette)
	spectrumLUT  = buildLUT(spectrumPalette)
)

func buildLUT(stops []colorStop) [256]rgb {
	var lut [256]rgb
	for i := range lut {
		r, g, b := interpolate(stops, float64(i)/255)
		lut[i] = rgb{r, g, b}
	}
	return lut
}

// lookup maps a 0..1 intensity to a palette entry, clamping out-of-range and
// NaN inputs to the ends.
func lookup(lut *[256]rgb, f float64) rgb {
	idx := int(f * 255)
	if idx < 0 || math.IsNaN(f) {
		idx = 0
	} else if idx > 255 {
		idx = 255
	}
	return lut[idx]
}

// leftHalf paints the foreground colour over the left half of a cell and lets
// the background show through the right half, so one cell carries exactly two
// horizontally adjacent pixels.
//
// Two pixels is the most a cell can represent without approximating: a cell has
// only a foreground and a background colour. An earlier version packed 2x2
// pixels using the quadrant glyphs, approximating four samples with two colours
// by splitting them into the two lowest-error groups. That is fine on smooth
// images but wrong for a noise floor: with four noisy samples there is always
// some largest gap, so it rendered a hard two-colour edge in essentially every
// cell (measured: ~100% of cells, at every realistic noise level) and
// re-randomised that pattern each frame as the waterfall scrolled. The result
// was blocky structure invented from noise. Pairing horizontally instead keeps
// the doubled frequency resolution and is exact, at one time step per row
// rather than two.
const leftHalf = '▌'

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
