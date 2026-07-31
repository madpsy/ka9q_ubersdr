package main

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/gdamore/tcell/v2"
)

// Eighth-height blocks, indexed by how many of the cell's 8 sub-rows are lit.
var blockChars = []rune{' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'}

// Braille dot bits indexed [subRow][subCol]; a braille cell is 2 wide by 4 tall.
var brailleDots = [4][2]rune{
	{0x01, 0x08},
	{0x02, 0x10},
	{0x04, 0x20},
	{0x40, 0x80},
}

const brailleBase = 0x2800

type ViewMode int

const (
	ViewSpectrum ViewMode = iota
	ViewWaterfall
	ViewSplit
)

func (v ViewMode) String() string {
	switch v {
	case ViewWaterfall:
		return "waterfall"
	case ViewSplit:
		return "split"
	default:
		return "spectrum"
	}
}

// Layout holds the derived geometry for the current terminal size and view
// mode. It is recomputed on every draw, so a resize needs nothing beyond a
// redraw.
type Layout struct {
	W, H         int
	PlotX, PlotW int
	SpecY, SpecH int // spectrum pane; SpecH is 0 when hidden
	WfY, WfH     int // waterfall pane; WfH is 0 when hidden
	AxisY        int
	StatusY      int
}

const gutterW = 9 // room for right-aligned "-120 dB" / "-12.5s" labels

func computeLayout(w, h int, mode ViewMode, splitRatio float64) Layout {
	l := Layout{W: w, H: h}
	l.PlotX = gutterW
	l.PlotW = w - gutterW
	if l.PlotW < 1 {
		l.PlotW = 1
	}
	l.AxisY = h - 2
	l.StatusY = h - 1

	// Rows between the header and the axis. On a terminal too short to hold
	// header + body + axis + status this goes non-positive; leave both panes
	// zero-height rather than letting them overrun the axis, since callers
	// (including mouse hit-testing) use these bounds unconditionally.
	body := l.AxisY - 1
	if body < 1 {
		return l
	}

	switch mode {
	case ViewSpectrum:
		l.SpecY, l.SpecH = 1, body
	case ViewWaterfall:
		l.WfY, l.WfH = 1, body
	case ViewSplit:
		specH := int(float64(body) * splitRatio)
		// Both panes must stay visible, otherwise "split" silently becomes a
		// single-pane view on short terminals.
		if specH < 1 {
			specH = 1
		}
		if specH > body-1 {
			specH = body - 1
		}
		if specH < 1 {
			specH = body
		}
		l.SpecY, l.SpecH = 1, specH
		l.WfY, l.WfH = 1+specH, body-specH
	}
	return l
}

// FreqAt converts a screen column to the frequency it represents.
func (u *UI) FreqAt(l Layout, col int) float64 {
	start, span := u.viewRange()
	if span == 0 {
		return 0
	}
	frac := (float64(col-l.PlotX) + 0.5) / float64(l.PlotW)
	return start + frac*span
}

// ColAt converts a frequency to a screen column, or -1 when off-screen.
func (u *UI) ColAt(l Layout, freq float64) int {
	start, span := u.viewRange()
	if span == 0 {
		return -1
	}
	frac := (freq - start) / span
	if frac < 0 || frac >= 1 {
		return -1
	}
	return l.PlotX + int(frac*float64(l.PlotW))
}

func (u *UI) viewRange() (start, span float64) {
	span = u.cfg.TotalBandwidth
	if span <= 0 {
		return 0, 0
	}
	return u.cfg.CenterFreq - span/2, span
}

// UI owns all display state. The event loop mutates it and calls Draw.
type UI struct {
	cfg   SpectrumConfig
	bins  []float32
	peaks []float32
	wf    *Waterfall

	mode       ViewMode
	splitRatio float64
	vfo        float64 // marker / tuned frequency
	showPeaks  bool
	braille    bool
	showHelp   bool
	status     string
	serverName string
	connected  bool
	fps        float64

	// Wheel either zooms or steps the VFO, mirroring the Python client's
	// scroll_mode. stepIdx selects the tuning step from tuningSteps.
	wheelTunes bool
	stepIdx    int

	// Cursor tracking for the crosshair and readout; -1 means off-plot.
	cursorX, cursorY int

	// Input prompt state, active while the user types a frequency.
	prompting bool
	promptBuf string

	// dB window. In auto mode it is recomputed from percentiles each frame and
	// eased so the scale doesn't jitter; in manual mode the user owns it.
	autoScale    bool
	minDB, maxDB float64
	haveRange    bool

	// Column values for the current frame, cached during Draw so the cursor
	// readout doesn't have to recompute the decimation.
	lastCols []float64
}

// tuningSteps are the selectable VFO increments in Hz, covering CW-fine
// through the 9 kHz and 10 kHz broadcast channel spacings.
var tuningSteps = []float64{10, 100, 500, 1000, 5000, 9000, 10000}

func NewUI(server string) *UI {
	return &UI{
		serverName: server,
		wf:         NewWaterfall(),
		mode:       ViewSplit,
		splitRatio: 0.45,
		autoScale:  true,
		minDB:      -120,
		maxDB:      -20,
		status:     "connecting…",
		cursorX:    -1,
		cursorY:    -1,
		stepIdx:    3, // 1 kHz
		// Braille resolves twice as many bins per screen width as block bars,
		// which matters far more than the bars' extra vertical steps when a
		// receiver sends 2048 bins into ~200 columns.
		braille: true,
	}
}

func (u *UI) StepHz() float64 { return tuningSteps[u.stepIdx] }

// Reset clears per-connection state so a newly selected receiver doesn't
// inherit the previous one's spectrum, history or scale.
func (u *UI) Reset() {
	u.cfg = SpectrumConfig{}
	u.bins = nil
	u.peaks = nil
	u.lastCols = nil
	u.wf.Clear()
	u.vfo = 0
	u.fps = 0
	u.haveRange = false
	u.connected = false
}

// SetFrame stores the newest bins, updates peak hold, and appends a waterfall
// line tagged with the frequency range it was captured over.
//
// center and span come from the frame itself, not from the UI's current config.
// Using the config here would mis-stamp every frame still in flight while the
// view is panning or zooming, and those rows then render at the wrong
// frequencies — appearing as displaced blocks that scroll up with the history.
// Pass 0 for either to fall back to the current view.
func (u *UI) SetFrame(bins []float32, center, span float64) {
	u.bins = bins

	// Re-range here rather than in Draw: the window must advance once per
	// frame. Doing it per draw made the easing rate depend on how often the UI
	// happened to repaint — mouse movement alone would drive the scale.
	u.autoRange()

	if center <= 0 || span <= 0 {
		center, span = u.cfg.CenterFreq, u.cfg.TotalBandwidth
	}
	if span > 0 {
		// A change of span makes the stored history incomparable. Rows are
		// anchored to the frequencies they were captured at, so after zooming
		// out they are squeezed into the sliver of screen their old span now
		// occupies — 200 kHz of history lands in about two columns of a 30 MHz
		// view, drawing a bright vertical line through the whole history that
		// looks like a signal which was never there. Panning keeps history,
		// where the anchoring is exactly what makes old rows line up; zooming
		// restarts it.
		if last, ok := u.wf.Row(0); ok && math.Abs(last.span-span) > span*0.01 {
			u.wf.Clear()
		}
		// The row keeps the window it was captured under, so it never gets
		// repainted by later changes to the scale.
		u.wf.Push(bins, center-span/2, span, u.minDB, u.maxDB)
	}

	if !u.showPeaks {
		u.peaks = nil
		return
	}
	if len(u.peaks) != len(bins) {
		u.peaks = append([]float32(nil), bins...)
		return
	}
	for i, v := range bins {
		if v > u.peaks[i] {
			u.peaks[i] = v
		} else {
			u.peaks[i] -= 0.15 // slow decay in dB per frame
		}
	}
}

// autoRange picks the dB window from percentiles, matching the GUI clients: the
// 1st percentile tracks the true noise floor and the 99th keeps a single strong
// carrier from flattening everything else.
func (u *UI) autoRange() {
	if !u.autoScale || len(u.bins) == 0 {
		return
	}
	valid := make([]float64, 0, len(u.bins))
	for _, v := range u.bins {
		f := float64(v)
		if !math.IsNaN(f) && !math.IsInf(f, 0) {
			valid = append(valid, f)
		}
	}
	if len(valid) == 0 {
		return
	}
	sort.Float64s(valid)

	p := func(q float64) float64 {
		return valid[int(q*float64(len(valid)-1))]
	}
	targetMin := p(0.01) - 2
	targetMax := p(0.99) + 5
	if targetMax-targetMin < 10 {
		targetMax = targetMin + 10
	}

	if !u.haveRange {
		u.minDB, u.maxDB = targetMin, targetMax
		u.haveRange = true
		return
	}
	const ease = 0.2
	u.minDB += (targetMin - u.minDB) * ease
	u.maxDB += (targetMax - u.maxDB) * ease
}

// AdjustScale nudges the dB window, switching to manual mode since an explicit
// adjustment would otherwise be immediately overwritten by auto-ranging.
func (u *UI) AdjustScale(dMin, dMax float64) {
	u.autoScale = false
	u.minDB += dMin
	u.maxDB += dMax
	if u.maxDB-u.minDB < 10 {
		u.maxDB = u.minDB + 10
	}
	u.status = fmt.Sprintf("manual scale %.0f … %.0f dB", u.minDB, u.maxDB)
}

func (u *UI) Draw(s tcell.Screen) {
	w, h := s.Size()
	if w < 24 || h < 8 {
		s.Clear()
		drawText(s, 0, 0, tcell.StyleDefault, "terminal too small")
		s.Show()
		return
	}
	l := computeLayout(w, h, u.mode, u.splitRatio)

	s.Clear()
	u.lastCols = columnPeaks(u.bins, l.PlotW)

	u.drawHeader(s, l)
	if l.SpecH > 0 {
		u.drawDBScale(s, l)
		if u.braille {
			u.drawBraille(s, l)
		} else {
			u.drawBars(s, l)
		}
	}
	if l.WfH > 0 {
		u.drawWaterfall(s, l)
		u.drawTimeScale(s, l)
	}
	// Order matters on the axis row: the scale is the base layer, the VFO
	// marker sits on top of it, and the cursor readout wins over both.
	u.drawFreqScale(s, l)
	u.drawMarker(s, l)
	u.drawCursor(s, l)
	u.drawStatus(s, l)
	if u.showHelp {
		u.drawHelp(s, l)
	}
	s.Show()
}

func (u *UI) drawHeader(s tcell.Screen, l Layout) {
	x := 0
	name := tcell.StyleDefault.Foreground(tcell.ColorWhite).Bold(true)
	dim := tcell.StyleDefault.Foreground(tcell.ColorSilver)
	sep := tcell.StyleDefault.Foreground(tcell.NewRGBColor(80, 80, 90))

	left := " " + u.serverName + " "
	drawText(s, x, 0, name, left)
	x += len(left)

	if u.connected {
		state := "● live "
		drawText(s, x, 0, tcell.StyleDefault.Foreground(tcell.NewRGBColor(0, 220, 90)), state)
		x += len(state)
	} else {
		state := "○ offline "
		drawText(s, x, 0, tcell.StyleDefault.Foreground(tcell.NewRGBColor(230, 70, 70)), state)
		x += len(state)
	}

	span := u.cfg.TotalBandwidth
	scaleMode := "AUTO"
	if !u.autoScale {
		scaleMode = "MAN"
	}
	wheel := "wheel zoom"
	if u.wheelTunes {
		wheel = "wheel tune " + formatStep(u.StepHz())
	}
	// The marker has no meaningful position until the first config arrives.
	vfo := "VFO —"
	if u.vfo > 0 {
		vfo = fmt.Sprintf("VFO %s MHz", formatFreq(u.vfo, span))
	}
	fields := []string{
		fmt.Sprintf("span %s", formatSpan(span)),
		vfo,
		fmt.Sprintf("%s %.0f/%.0f dB", scaleMode, u.minDB, u.maxDB),
		wheel,
		u.mode.String(),
		fmt.Sprintf("%.0f fps", u.fps),
	}
	right := strings.Join(fields, " │ ") + " "

	rx := l.W - len(right)
	if rx > x+1 {
		// Draw separators in a dimmer colour than the values themselves.
		cx := rx
		for _, part := range strings.Split(right, "│") {
			drawText(s, cx, 0, dim, part)
			cx += len(part)
			if cx < l.W {
				drawText(s, cx, 0, sep, "│")
				cx++
			}
		}
	}
}

// columnPeaks reduces the bin array to one value per screen column, taking the
// maximum so narrow signals survive decimation.
func columnPeaks(bins []float32, cols int) []float64 {
	out := make([]float64, cols)
	if len(bins) == 0 || cols == 0 {
		for i := range out {
			out[i] = math.Inf(-1)
		}
		return out
	}
	for i := range out {
		lo := i * len(bins) / cols
		hi := (i + 1) * len(bins) / cols
		if hi <= lo {
			hi = lo + 1
		}
		if hi > len(bins) {
			hi = len(bins)
		}
		best := math.Inf(-1)
		for _, v := range bins[lo:hi] {
			f := float64(v)
			if f > best && !math.IsNaN(f) {
				best = f
			}
		}
		out[i] = best
	}
	return out
}

func (u *UI) norm(db float64) float64 {
	rng := u.maxDB - u.minDB
	if rng <= 0 {
		return 0
	}
	return math.Max(0, math.Min(1, (db-u.minDB)/rng))
}

// drawBars renders a filled spectrum using eighth-block characters, colouring
// each row by its own height so the bar carries a vertical gradient.
func (u *UI) drawBars(s tcell.Screen, l Layout) {
	subRows := l.SpecH * 8

	var peakCols []float64
	if u.showPeaks && len(u.peaks) > 0 {
		peakCols = columnPeaks(u.peaks, l.PlotW)
	}

	for i, db := range u.lastCols {
		x := l.PlotX + i
		if math.IsInf(db, -1) {
			continue
		}
		filled := int(u.norm(db) * float64(subRows))

		for r := 0; r < l.SpecH; r++ {
			remaining := filled - r*8
			if remaining <= 0 {
				break
			}
			level := remaining
			if level > 8 {
				level = 8
			}
			y := l.SpecY + l.SpecH - 1 - r // r counts up from the bottom row
			frac := (float64(r) + 0.5) / float64(l.SpecH)
			s.SetContent(x, y, blockChars[level], nil,
				tcell.StyleDefault.Foreground(rampColor(frac)))
		}

		if peakCols != nil && !math.IsInf(peakCols[i], -1) {
			py := l.SpecY + l.SpecH - 1 - int(u.norm(peakCols[i])*float64(l.SpecH-1))
			if py >= l.SpecY && py < l.SpecY+l.SpecH {
				s.SetContent(x, py, '‾', nil,
					tcell.StyleDefault.Foreground(tcell.NewRGBColor(210, 210, 230)).Dim(true))
			}
		}
	}
}

// drawBraille renders the spectrum at 2x horizontal and 4x vertical sub-cell
// resolution, filled from the trace down to the baseline. The horizontal
// doubling is the point: it halves how many bins are collapsed into each screen
// position compared with one bar per character cell.
//
// It needs a font with braille glyphs, which is near-universal in monospace
// fonts; `b` switches to block bars if a terminal lacks them.
func (u *UI) drawBraille(s tcell.Screen, l Layout) {
	pxW := l.PlotW * 2
	pxH := l.SpecH * 4
	cols := columnPeaks(u.bins, pxW)
	cells := make([]rune, l.PlotW*l.SpecH)

	for px, db := range cols {
		if math.IsInf(db, -1) {
			continue
		}
		top := pxH - 1 - int(u.norm(db)*float64(pxH-1))
		top = clampInt(top, 0, pxH-1)

		cx := px / 2
		if cx >= l.PlotW {
			continue
		}
		// Fill from the trace down to the baseline so the spectrum reads as a
		// solid shape rather than a thin line.
		for y := top; y < pxH; y++ {
			cy := y / 4
			if cy >= l.SpecH {
				break
			}
			cells[cy*l.PlotW+cx] |= brailleDots[y%4][px%2]
		}
	}

	for cy := 0; cy < l.SpecH; cy++ {
		for cx := 0; cx < l.PlotW; cx++ {
			bits := cells[cy*l.PlotW+cx]
			if bits == 0 {
				continue
			}
			frac := 1 - (float64(cy)+0.5)/float64(l.SpecH)
			s.SetContent(l.PlotX+cx, l.SpecY+cy, brailleBase|bits, nil,
				tcell.StyleDefault.Foreground(rampColor(frac)))
		}
	}
}

// drawWaterfall paints history newest-at-top, one time step per character row,
// with two frequency samples packed into each cell as an exact left/right pair.
func (u *UI) drawWaterfall(s tcell.Screen, l Layout) {
	if u.wf.Len() == 0 {
		return
	}
	start, span := u.viewRange()
	if span <= 0 {
		return
	}

	// Frequency span covered by each sub-column, resolved once and reused for
	// every row. Each sub-column aggregates the bins it covers rather than
	// point sampling one of them, so no signal in the range is dropped.
	subW := l.PlotW * 2
	subStep := span / float64(subW)

	// In auto mode each row is coloured with the window it was captured under,
	// so scrolled-past history never changes appearance. In manual mode the
	// user owns the window and it applies to everything, which is the point of
	// setting it by hand.
	sample := func(row wfRow, ok bool, lo float64) rgb {
		if !ok {
			return rgb{}
		}
		v, found := row.MeanBetween(lo, lo+subStep)
		if !found {
			return rgb{}
		}
		n := row.norm(float64(v))
		if !u.autoScale || row.maxDB <= row.minDB {
			n = u.norm(float64(v))
		}
		return lookup(&waterfallLUT, n)
	}

	for cy := 0; cy < l.WfH; cy++ {
		row, ok := u.wf.Row(cy)
		if !ok {
			break
		}

		y := l.WfY + cy
		for cx := 0; cx < l.PlotW; cx++ {
			loFreq := start + float64(cx*2)*subStep
			left := sample(row, ok, loFreq)
			right := sample(row, ok, loFreq+subStep)

			// Exact: the glyph paints the left sub-column in the foreground
			// and the right one in the background, with no approximation.
			s.SetContent(l.PlotX+cx, y, leftHalf, nil,
				tcell.StyleDefault.
					Foreground(tcell.NewRGBColor(left.r, left.g, left.b)).
					Background(tcell.NewRGBColor(right.r, right.g, right.b)))
		}
	}
}

// drawMarker highlights the VFO column by recolouring its background, keeping
// whatever is drawn underneath visible.
func (u *UI) drawMarker(s tcell.Screen, l Layout) {
	col := u.ColAt(l, u.vfo)
	if col < 0 {
		return
	}
	tint := tcell.NewRGBColor(120, 70, 0)
	accent := tcell.StyleDefault.Foreground(tcell.NewRGBColor(255, 175, 0)).Background(tint)

	for y := 1; y < l.AxisY; y++ {
		r, combi, style, _ := s.GetContent(col, y)
		if r == ' ' || r == 0 {
			s.SetContent(col, y, '│', nil, accent)
			continue
		}
		s.SetContent(col, y, r, combi, style.Background(tint))
	}
	s.SetContent(col, l.AxisY, '▲', nil,
		tcell.StyleDefault.Foreground(tcell.NewRGBColor(255, 175, 0)))
}

// drawCursor draws the mouse crosshair and a frequency/level readout.
func (u *UI) drawCursor(s tcell.Screen, l Layout) {
	if u.cursorX < l.PlotX || u.cursorX >= l.W {
		return
	}
	ghost := tcell.NewRGBColor(70, 70, 80)
	for y := 1; y < l.AxisY; y++ {
		r, combi, style, _ := s.GetContent(u.cursorX, y)
		if r == ' ' || r == 0 {
			s.SetContent(u.cursorX, y, '┆', nil, tcell.StyleDefault.Foreground(ghost))
			continue
		}
		_ = combi
		_ = style
	}

	freq := u.FreqAt(l, u.cursorX)
	label := fmt.Sprintf(" %s MHz ", formatFreq(freq, u.cfg.TotalBandwidth))
	if idx := u.cursorX - l.PlotX; idx >= 0 && idx < len(u.lastCols) {
		if db := u.lastCols[idx]; !math.IsInf(db, -1) {
			label = fmt.Sprintf(" %s MHz  %.0f dB ", formatFreq(freq, u.cfg.TotalBandwidth), db)
		}
	}

	x := u.cursorX - len(label)/2
	x = clampInt(x, 0, maxInt(0, l.W-len(label)))
	drawText(s, x, l.AxisY, tcell.StyleDefault.
		Foreground(tcell.ColorBlack).
		Background(tcell.NewRGBColor(255, 205, 90)).Bold(true), label)
}

func (u *UI) drawDBScale(s tcell.Screen, l Layout) {
	style := tcell.StyleDefault.Foreground(tcell.ColorSilver)
	ticks := clampInt(l.SpecH/3, 2, 8)
	for i := 0; i <= ticks; i++ {
		frac := float64(i) / float64(ticks)
		db := u.minDB + frac*(u.maxDB-u.minDB)
		y := l.SpecY + l.SpecH - 1 - int(frac*float64(l.SpecH-1))
		drawText(s, 0, y, style, fmt.Sprintf("%7.0f ", db))
	}
}

// drawTimeScale labels the waterfall gutter with how far back each row is,
// derived from the measured frame rate.
func (u *UI) drawTimeScale(s tcell.Screen, l Layout) {
	if u.fps <= 0 {
		return
	}
	style := tcell.StyleDefault.Foreground(tcell.NewRGBColor(120, 120, 130))
	secPerCell := 2 / u.fps // two history rows per character cell
	step := clampInt(l.WfH/4, 2, l.WfH)

	for cy := 0; cy < l.WfH; cy += step {
		age := float64(cy) * secPerCell
		drawText(s, 0, l.WfY+cy, style, fmt.Sprintf("%6.1fs ", -age))
	}
}

func (u *UI) drawFreqScale(s tcell.Screen, l Layout) {
	start, span := u.viewRange()
	if span <= 0 {
		return
	}
	style := tcell.StyleDefault.Foreground(tcell.ColorSilver)

	// Aim for a tick roughly every 18 columns, snapped to a 1/2/5 decade step.
	step := niceStep(span * 18 / float64(l.PlotW))
	if step <= 0 {
		return
	}

	occupied := make([]bool, l.W)
	for f := math.Ceil(start/step) * step; f < start+span; f += step {
		col := u.ColAt(l, f)
		if col < 0 {
			continue
		}
		label := formatFreq(f, span)
		x := clampInt(col-len(label)/2, l.PlotX, maxInt(l.PlotX, l.W-len(label)))
		if overlaps(occupied, x, len(label)+1) {
			continue
		}
		mark(occupied, x, len(label)+1)
		drawText(s, x, l.AxisY, style, label)
	}
}

func (u *UI) drawStatus(s tcell.Screen, l Layout) {
	if u.prompting {
		style := tcell.StyleDefault.Foreground(tcell.ColorBlack).
			Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)
		drawText(s, 0, l.StatusY, style,
			padTo(" Frequency (kHz; add M/k to override): "+u.promptBuf+"▏", l.W))
		return
	}

	style := tcell.StyleDefault.Foreground(tcell.NewRGBColor(200, 200, 210)).
		Background(tcell.NewRGBColor(45, 45, 55))
	help := " f tune · v view · a auto · w wheel · i receiver · ? help · q quit "
	text := help
	if u.status != "" {
		text = help + "│ " + u.status
	}
	drawText(s, 0, l.StatusY, style, padTo(text, l.W))
}

var helpLines = []string{
	"Tuning",
	"  click            set the VFO marker",
	"  drag             pan the view",
	"  f                type a frequency",
	"  c                centre on the VFO",
	"  ← →              pan   (, . for fine)",
	"",
	"Zoom and wheel",
	"  wheel            zoom, or tune",
	"                   (in at the cursor, out from the centre)",
	"  w                switch the wheel between zoom and tune",
	"  s / S            cycle the tuning step",
	"  + -  /  ↑ ↓      zoom about the centre",
	"  0                reset to full span",
	"",
	"Display",
	"  v                spectrum / waterfall / split",
	"  < >              resize the split",
	"  b                filled bars or braille trace",
	"  p                peak hold",
	"",
	"Scaling",
	"  a                auto / manual",
	"  [ ]              lower / raise the floor",
	"  { }              lower / raise the ceiling",
	"",
	"Receivers",
	"  i                pick another receiver",
	"",
	"  ?                close this help      q  quit",
}

func (u *UI) drawHelp(s tcell.Screen, l Layout) {
	width := 0
	for _, line := range helpLines {
		if len(line) > width {
			width = len(line)
		}
	}
	width += 4
	height := len(helpLines) + 2
	if width > l.W {
		width = l.W
	}
	if height > l.H {
		height = l.H
	}

	x0 := (l.W - width) / 2
	y0 := (l.H - height) / 2

	box := tcell.StyleDefault.Foreground(tcell.NewRGBColor(220, 220, 235)).
		Background(tcell.NewRGBColor(28, 28, 38))
	title := tcell.StyleDefault.Foreground(tcell.NewRGBColor(255, 205, 90)).
		Background(tcell.NewRGBColor(28, 28, 38)).Bold(true)

	for y := y0; y < y0+height; y++ {
		drawText(s, x0, y, box, strings.Repeat(" ", width))
	}
	drawText(s, x0, y0, title, padTo(" Keys", width))

	for i, line := range helpLines {
		y := y0 + 1 + i
		if y >= y0+height-1 {
			break
		}
		style := box
		// Section headings are the unindented lines.
		if line != "" && !strings.HasPrefix(line, " ") {
			style = title
		}
		drawText(s, x0+1, y, style, padTo(" "+line, width-2))
	}
}

// rampColor maps 0..1 to a blue→cyan→green→yellow→red gradient for the
// spectrum trace.
var spectrumPalette = []colorStop{
	{0.00, 30, 60, 140},
	{0.30, 0, 150, 210},
	{0.55, 0, 205, 95},
	{0.78, 240, 225, 0},
	{1.00, 255, 65, 0},
}

func rampColor(f float64) tcell.Color {
	c := lookup(&spectrumLUT, f)
	return tcell.NewRGBColor(c.r, c.g, c.b)
}

// niceStep rounds a raw interval up to the nearest 1, 2 or 5 times a power of ten.
func niceStep(raw float64) float64 {
	if raw <= 0 {
		return 0
	}
	mag := math.Pow(10, math.Floor(math.Log10(raw)))
	switch n := raw / mag; {
	case n <= 1:
		return mag
	case n <= 2:
		return 2 * mag
	case n <= 5:
		return 5 * mag
	default:
		return 10 * mag
	}
}

// formatFreq picks a precision that resolves the current span rather than
// printing six decimals of noise at wide zoom.
// A zero frequency is a legitimate axis tick on a full-span view, so it is
// formatted like any other; callers that mean "not set yet" handle that
// themselves.
func formatFreq(hz float64, span float64) string {
	switch {
	case span >= 10e6:
		return fmt.Sprintf("%.2f", hz/1e6)
	case span >= 1e6:
		return fmt.Sprintf("%.3f", hz/1e6)
	case span >= 100e3:
		return fmt.Sprintf("%.4f", hz/1e6)
	case span >= 10e3:
		return fmt.Sprintf("%.5f", hz/1e6)
	default:
		return fmt.Sprintf("%.6f", hz/1e6)
	}
}

// formatStep renders a tuning increment compactly for the header.
func formatStep(hz float64) string {
	if hz >= 1000 {
		return fmt.Sprintf("%gk", hz/1000)
	}
	return fmt.Sprintf("%gHz", hz)
}

func formatSpan(hz float64) string {
	switch {
	case hz <= 0:
		return "—"
	case hz >= 1e6:
		return fmt.Sprintf("%.3g MHz", hz/1e6)
	default:
		return fmt.Sprintf("%.3g kHz", hz/1e3)
	}
}

func drawText(s tcell.Screen, x, y int, style tcell.Style, text string) {
	w, _ := s.Size()
	for _, r := range text {
		if x >= w {
			return
		}
		if x >= 0 {
			s.SetContent(x, y, r, nil, style)
		}
		x++
	}
}

func padTo(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if len(s) >= w {
		return s[:w]
	}
	return s + strings.Repeat(" ", w-len(s))
}

func overlaps(occupied []bool, x, n int) bool {
	for i := x; i < x+n && i < len(occupied); i++ {
		if i >= 0 && occupied[i] {
			return true
		}
	}
	return false
}

func mark(occupied []bool, x, n int) {
	for i := x; i < x+n && i < len(occupied); i++ {
		if i >= 0 {
			occupied[i] = true
		}
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
