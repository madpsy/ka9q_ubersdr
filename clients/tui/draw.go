package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

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
	MarkY, MarkH int // band/bookmark strip; MarkH is 0 when there is nothing to show
	BodyY        int // first row below the header and the marker strip
	SpecY, SpecH int // spectrum pane; SpecH is 0 when hidden
	WfY, WfH     int // waterfall pane; WfH is 0 when hidden
	AxisY        int
	StatusY      int
}

const gutterW = 9 // room for right-aligned "-120 dB" / "-12.5s" labels

// computeLayout derives the geometry for one draw. markerRows is how many rows
// the band/bookmark strip wants; it gets them only when the panes can spare
// them, since a receiver's markers are never worth losing the spectrum over.
func computeLayout(w, h int, mode ViewMode, splitRatio float64, markerRows int) Layout {
	l := Layout{W: w, H: h}
	l.PlotX = gutterW
	l.PlotW = w - gutterW
	if l.PlotW < 1 {
		l.PlotW = 1
	}
	l.AxisY = h - 2
	l.StatusY = h - 1
	l.BodyY = 1

	// Rows between the header and the axis. On a terminal too short to hold
	// header + body + axis + status this goes non-positive; leave both panes
	// zero-height rather than letting them overrun the axis, since callers
	// (including mouse hit-testing) use these bounds unconditionally.
	body := l.AxisY - 1
	if body < 1 {
		return l
	}

	// Keep at least two rows of body: one row of spectrum is not a display, and
	// in split view both panes still have to exist.
	if markerRows > 0 && body-markerRows >= 2 {
		l.MarkY, l.MarkH = 1, markerRows
		l.BodyY += markerRows
		body -= markerRows
	}

	switch mode {
	case ViewSpectrum:
		l.SpecY, l.SpecH = l.BodyY, body
	case ViewWaterfall:
		l.WfY, l.WfH = l.BodyY, body
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
		l.SpecY, l.SpecH = l.BodyY, specH
		l.WfY, l.WfH = l.BodyY+specH, body-specH
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

	// modePinned holds off the sideband convention for a mode that was asked
	// for — on the command line, or by the receiver naming its own default —
	// until the user tunes somewhere themselves.
	modePinned bool

	// Audio state. The VFO doubles as the tuned frequency, so the filter edges
	// are relative to it.
	audioOn      bool
	muted        bool
	audioMode    string // demodulation mode: usb, lsb, am…
	bwLow        int
	bwHigh       int
	autoSideband bool
	channel      Channel
	volume       float64
	signal       Signal // latest level report from the audio stream
	meterSNR     bool   // meter shows SNR rather than absolute dBFS
	audioStatus  string

	// Server-side DSP insert. dspFilters is what this receiver offers;
	// dspFilter is the one in use, empty for off, which is the default.
	dspFilters []string
	dspFilter  string

	// Squelch threshold in dB of SNR, 0 for off. squelchedAt is when audio was
	// last heard, used to show whether the gate is currently closed.
	squelch     int
	lastAudioAt time.Time

	// The receiver's band plan and bookmarks, drawn as a strip above the panes.
	// bookmarkHits records where each label landed so a click can find it.
	bands        []Band
	bookmarks    []Bookmark
	bookmarkHits []bookmarkHit

	// When this session runs out, from the receiver's own limit. sessionLimited
	// is false on a receiver that does not limit sessions, which is a different
	// thing from one whose limit has not arrived yet.
	sessionEnd     time.Time
	sessionLimited bool

	// Chat, when the receiver runs it. chatUnread counts messages that have
	// arrived since the panel was last open, and chatMention marks any of them
	// naming us — the one thing worth interrupting for.
	chat        ChatState
	chatUnread  int
	chatMention bool

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
	u := &UI{
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
		stepIdx:    2, // 500 Hz — fine enough to land on an SSB signal,
		//                coarse enough to cross a band without spinning
		// Braille resolves twice as many bins per screen width as block bars,
		// which matters far more than the bars' extra vertical steps when a
		// receiver sends 2048 bins into ~200 columns.
		braille:      true,
		autoSideband: true,
		channel:      ChannelBoth,
		volume:       1.0,
		signal:       Signal{Power: float32(math.Inf(-1)), Noise: float32(math.Inf(-1))},
	}
	// Take the starting mode and its filter from the mode table rather than
	// repeating the numbers here, where they would silently go stale when the
	// table is corrected.
	u.ApplyMode("usb")
	return u
}

// ApplyMode switches demodulation mode, adopting that mode's default filter.
func (u *UI) ApplyMode(name string) {
	m, ok := lookupMode(name)
	if !ok {
		return
	}
	u.audioMode = m.Name
	u.bwLow, u.bwHigh = clampBandwidth(m.Name, m.Low, m.High)
}

// SyncSideband applies the 10 MHz convention when the VFO moves, but only for
// sideband modes: choosing AM or CW is deliberate and crossing the cutoff must
// not silently undo it. The user's filter width is carried across rather than
// reset to the default.
func (u *UI) SyncSideband() {
	if u.modePinned || !u.autoSideband || u.vfo <= 0 || !isSideband(u.audioMode) {
		return
	}
	want := autoMode(u.vfo)
	if want == u.audioMode {
		return
	}
	u.audioMode = want
	low, high := mirrorSideband(u.bwLow, u.bwHigh)
	u.bwLow, u.bwHigh = clampBandwidth(u.audioMode, low, high)
}

// AdjustBandwidth widens or narrows the filter by moving its outer edge, which
// is the edge that carries the audio bandwidth in every mode.
func (u *UI) AdjustBandwidth(delta int) {
	low, high := u.bwLow, u.bwHigh
	switch {
	case low >= 0: // upper sideband style: outer edge is the high one
		high += delta
	case high <= 0: // lower sideband: outer edge is the low one
		low -= delta
	default: // symmetric, as for AM and FM
		low -= delta
		high += delta
	}
	u.bwLow, u.bwHigh = clampBandwidth(u.audioMode, low, high)
}

func (u *UI) StepHz() float64 { return tuningSteps[u.stepIdx] }

// snapToStep rounds a frequency onto the current tuning grid. Typed
// frequencies deliberately skip this — 14.074 MHz for FT8 is exact and should
// not be nudged — but pointing at the display is only ever as precise as a
// character cell, which can span many kHz at a wide span.
func (u *UI) snapToStep(freq float64) float64 {
	step := u.StepHz()
	if step <= 0 {
		return freq
	}
	return math.Round(freq/step) * step
}

// Reset clears per-connection state so a newly selected receiver doesn't
// inherit the previous one's spectrum, history or scale.
func (u *UI) Reset() {
	u.cfg = SpectrumConfig{}
	u.bins = nil
	u.peaks = nil
	u.lastCols = nil
	u.wf.Clear()
	// The next receiver has its own band plan, bookmarks and chat.
	u.bands = nil
	u.bookmarks = nil
	u.bookmarkHits = nil
	u.chat = ChatState{}
	u.chatUnread, u.chatMention = 0, false
	u.modePinned = false
	u.sessionEnd, u.sessionLimited = time.Time{}, false
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

// autoRange picks the dB window from the current frame.
//
// It anchors on two things: a representative noise floor and the strongest
// signal. Earlier this used the 1st and 99th percentiles, which had two
// problems on real data — the noise band filled the bottom third of the pane,
// wasting most of the height, and the 99th percentile sat *below* the actual
// peaks, so the strongest signals were clipped flat against the top (measured:
// 9 to 14 bins clipped on a live receiver).
//
// The 10th percentile represents the floor without chasing its lowest outlier,
// and tracking the peak gives signals the rest of the pane. The top is capped
// relative to the 99th percentile so one strong spur cannot squash everything
// else into the bottom of the display.
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
	noise := p(0.10)
	peak := valid[len(valid)-1]

	const (
		floorMargin = 4 // headroom below the noise so it is not flush with the edge
		peakMargin  = 4 // headroom above the strongest signal
		// How far above the 99.9th percentile the top may be dragged. The
		// reference has to be this high: with 2048 bins the 99th percentile is
		// the 20th from the top, so any signal narrower than that does not move
		// it and a real carrier gets clipped as though it were a spur. At
		// 99.9 only a literal one- or two-bin outlier is excluded.
		spurLimit = 15

		// Minimum dynamic range. Without this the window collapses onto
		// whatever happens to be in the span: point the receiver somewhere with
		// no strong signals and the top follows the noise down, so the noise
		// floor climbs the pane even though nothing has actually got louder.
		// Holding 60 dB open keeps the floor pinned near the bottom and makes
		// the display comparable as you tune across bands.
		minWindow = 60
	)

	targetMin := noise - floorMargin
	targetMax := math.Min(peak+peakMargin, p(0.999)+spurLimit)
	// Extend upward rather than downward: adding headroom below the noise
	// would push it *up* the pane, which is the opposite of what is wanted.
	if targetMax-targetMin < minWindow {
		targetMax = targetMin + minWindow
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

// Draw renders the display and presents it.
//
// Callers that stack an overlay on top must use render() and present once
// themselves: presenting here and again after the overlay shows a frame of the
// bare display in between, which reads as the overlay flickering and the
// waterfall drawing over it.
func (u *UI) Draw(s tcell.Screen) {
	u.render(s)
	s.Show()
}

// render draws the display into the screen buffer without presenting it.
func (u *UI) render(s tcell.Screen) {
	w, h := s.Size()
	if w < 24 || h < 8 {
		s.Clear()
		drawText(s, 0, 0, tcell.StyleDefault, "terminal too small")
		return
	}
	l := computeLayout(w, h, u.mode, u.splitRatio, u.markerRows())

	s.Clear()
	u.lastCols = columnPeaks(u.bins, l.PlotW)

	u.drawHeader(s, l)
	u.drawMarkers(s, l)
	if l.SpecH > 0 {
		u.drawDBScale(s, l)
		if u.braille {
			u.drawBraille(s, l)
		} else {
			u.drawBars(s, l)
		}
		// After the trace, and for either style: peak hold used to be drawn
		// inside the bars renderer only, so it silently did nothing once
		// braille became the default.
		u.drawPeaks(s, l)
	}
	if l.WfH > 0 {
		u.drawWaterfall(s, l)
		u.drawTimeScale(s, l)
	}
	// Order matters on the axis row: the scale is the base layer, the VFO
	// marker sits on top of it, and the cursor readout wins over both.
	u.drawFreqScale(s, l)
	u.drawFilter(s, l)
	u.drawMarker(s, l)
	u.drawCursor(s, l)
	u.drawStatus(s, l)
	if u.showHelp {
		u.drawHelp(s, l)
	}
}

func (u *UI) drawHeader(s tcell.Screen, l Layout) {
	x := 0
	name := tcell.StyleDefault.Foreground(tcell.ColorWhite).Bold(true)
	dim := tcell.StyleDefault.Foreground(tcell.ColorSilver)
	sep := tcell.StyleDefault.Foreground(tcell.NewRGBColor(80, 80, 90))

	// Every advance is in runes: the state glyphs are multi-byte, and counting
	// bytes left a two-column hole after them and mismeasured how much room the
	// right-hand block had.
	left := " " + u.serverName + " "
	drawText(s, x, 0, name, left)
	x += runeLen(left)

	if u.connected {
		state := "● live "
		drawText(s, x, 0, tcell.StyleDefault.Foreground(tcell.NewRGBColor(0, 220, 90)), state)
		x += runeLen(state)
	} else {
		state := "○ offline "
		drawText(s, x, 0, tcell.StyleDefault.Foreground(tcell.NewRGBColor(230, 70, 70)), state)
		x += runeLen(state)
	}

	// Chat sits beside the connection state rather than in the right-hand
	// block: it is state, not a setting, and the right-hand fields are shed on
	// a narrow terminal — which is exactly when an unread message would be
	// dropped. Whatever it takes here narrows that block, since its width is
	// measured from x.
	if u.chat.Available {
		users, unread := u.chatLabels()
		drawText(s, x, 0, dim, users)
		x += runeLen(users)
		if unread != "" {
			// The alert colour is the notification: an unread count that looks
			// like the rest of the header is one nobody sees.
			drawText(s, x, 0, tcell.StyleDefault.
				Foreground(tcell.NewRGBColor(255, 205, 90)).Bold(true), unread)
			x += runeLen(unread)
		}
	}

	// The session clock takes the last columns of the row, and everything else
	// is fitted to the left of it. It is the one field that is never shed: a
	// session that ends without warning is worse than a header missing its
	// frame rate.
	clock := u.sessionField()
	if clock != "" {
		drawText(s, l.W-runeLen(clock), 0, u.sessionStyle(), clock)
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
	// The three things the operator reads at a glance — where the radio is
	// pointed, what is being demodulated, and how wide the filter is — each get
	// their own colour, so none of them has to be picked out of a row of
	// identically dim text.
	freqStyle := tcell.StyleDefault.Foreground(tcell.NewRGBColor(255, 200, 80)).Bold(true)
	modeStyle := tcell.StyleDefault.Foreground(tcell.NewRGBColor(90, 200, 255)).Bold(true)
	bwStyle := tcell.StyleDefault.Foreground(tcell.NewRGBColor(190, 150, 255))

	// A field is drawn as a sequence of runs so one field can carry more than
	// one colour, and is measured as the sum of them.
	type run struct {
		text  string
		style tcell.Style
	}
	// Fields carry a priority so a narrow terminal sheds the least useful ones
	// instead of dropping the entire right-hand side — which is what an 80
	// column window used to do, hiding the frequency and audio state outright.
	type field struct {
		runs []run
		prio int // lower is kept longer
	}
	plain := func(text string) []run { return []run{{text, dim}} }

	// The marker has no meaningful position until the first config arrives.
	vfo := "VFO —"
	if u.vfo > 0 {
		vfo = fmt.Sprintf("VFO %s MHz", formatFreq(u.vfo, span))
		// On a header too narrow for the label, the number alone still says
		// where the radio is pointed, which is the one thing that must survive.
		if runeLen(vfo) > l.W-x-2-runeLen(clock) {
			vfo = formatFreq(u.vfo, span)
		}
	}
	// Only the number is coloured; the label stays dim so the colour marks the
	// value rather than the whole field.
	vfoRuns := []run{{vfo, freqStyle}}
	if rest, ok := strings.CutPrefix(vfo, "VFO "); ok {
		vfoRuns = []run{{"VFO ", dim}, {rest, freqStyle}}
	}

	// Order here is display order: the mode and filter width follow the
	// frequency directly, since they qualify it — the rest of the row is
	// settings, which do not.
	candidates := []field{{vfoRuns, 0}}
	if u.audioOn {
		// The full audio field is wide. Where it will not fit beside the VFO,
		// a compact form carries the part that matters — what is being
		// demodulated — rather than the field being shed altogether.
		mode, bw, rest := u.audioParts()
		audio := []run{{mode, modeStyle}, {" ", dim}, {bw, bwStyle}, {" ", dim}, {rest, dim}}
		if runeLen(vfo)+3+runeLen(u.audioField()) > l.W-x-2-runeLen(clock) {
			mode, bw, state := u.audioPartsCompact()
			audio = []run{{mode, modeStyle}, {" ", dim}, {bw, bwStyle}, {state, dim}}
		}
		candidates = append(candidates, field{audio, 1})
	}
	candidates = append(candidates,
		field{plain(fmt.Sprintf("span %s", formatSpan(span))), 2},
		field{plain(fmt.Sprintf("%s %.0f/%.0f dB", scaleMode, u.minDB, u.maxDB)), 4},
		field{plain(wheel), 6},
		field{plain(u.mode.String()), 5},
		field{plain(fmt.Sprintf("%3.0f fps", u.fps)), 7},
	)

	// Keep the display order stable while choosing what fits by priority.
	order := make([]int, len(candidates))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return candidates[order[a]].prio < candidates[order[b]].prio
	})

	// Width is measured in runes throughout: the separators and unit glyphs are
	// multi-byte, so byte length would overestimate and push the right-hand
	// block left over the server name.
	const sepWidth = 3 // " │ "
	width := func(f field) int {
		n := 0
		for _, r := range f.runs {
			n += runeLen(r.text)
		}
		return n
	}
	avail := l.W - x - 2 - runeLen(clock)
	keep := make([]bool, len(candidates))
	used := 0
	for _, idx := range order {
		cost := width(candidates[idx])
		if used > 0 {
			cost += sepWidth
		}
		if used+cost > avail {
			continue // try the next, shorter field rather than stopping
		}
		keep[idx] = true
		used += cost
	}
	if used == 0 {
		return
	}

	// Every advance is counted in runes, matching where the block was placed.
	// Counting bytes here pushed each part further right than the one before it
	// as soon as any of them held a multi-byte glyph — the em dash in the audio
	// field alone was enough — and shoved the tail of the header off the screen.
	// The trailing column keeps the block off the right edge.
	cx := l.W - used - 1 - runeLen(clock)
	first := true
	for i, c := range candidates {
		if !keep[i] {
			continue
		}
		// Separators are dimmer than the values they divide, and are drawn
		// between fields only: one after the last used to sit against whatever
		// came next on the row.
		if !first {
			drawText(s, cx, 0, sep, " │ ")
			cx += sepWidth
		}
		first = false
		for _, r := range c.runs {
			drawText(s, cx, 0, r.style, r.text)
			cx += runeLen(r.text)
		}
	}
}

// Squelch threshold limits, in dB of SNR. Stepping below the floor turns the
// gate off rather than leaving a threshold that could never fire.
//
// The range moved with audio protocol version 3, which reports noise over the
// signal's own passband instead of as a density: the figure being thresholded
// is now a real SNR, some 34 dB below the S/N0 in dB·Hz that 20-80 was
// calibrated against. 1 dB is the lowest threshold that still means anything —
// at 0 the signal is level with the noise, and the gate would never close.
const (
	squelchMin = 1
	squelchMax = 46
)

// chatLabels returns the two halves of the header's chat indicator: how many
// people are in the chat, and what has arrived unread since the panel was last
// open. They are separate because only the second is drawn in an alert colour.
//
// The unread half is empty unless we are actually in the chat — nobody can
// address a listener who has not joined — and empty when there is nothing
// unread, so the common case costs the header four characters. A message naming
// us adds @, the one thing worth breaking off tuning for.
func (u *UI) chatLabels() (users, unread string) {
	users = fmt.Sprintf("chat %d ", len(u.chat.Users))
	if !u.chat.Connected {
		users = "chat … "
	}
	if !u.chat.Joined || u.chatUnread <= 0 {
		return users, ""
	}
	unread = fmt.Sprintf("+%d", u.chatUnread)
	if u.chatMention {
		unread += "@"
	}
	return users, unread + " "
}

// sessionField is the session clock for the top right: how long is left before
// the receiver ends this session, or that it does not end them.
//
// Receivers publish the limit in the /connection reply, and the countdown runs
// from the moment that reply arrived — the same clock the receiver is using.
func (u *UI) sessionField() string {
	if !u.connected {
		return ""
	}
	if !u.sessionLimited {
		return " unlimited "
	}
	return " " + formatCountdown(time.Until(u.sessionEnd)) + " "
}

// sessionStyle warns as the end approaches, on the same five-minute threshold
// the Python client uses.
func (u *UI) sessionStyle() tcell.Style {
	if u.sessionLimited && time.Until(u.sessionEnd) <= 5*time.Minute {
		return tcell.StyleDefault.
			Foreground(tcell.ColorBlack).
			Background(tcell.NewRGBColor(230, 70, 70)).Bold(true)
	}
	return tcell.StyleDefault.Foreground(tcell.NewRGBColor(140, 200, 255))
}

// formatCountdown renders a remaining time as 1h24m12s, dropping the units that
// have run out: 4m09s, then 9s. Seconds are always shown, because the last
// minute is exactly when the number matters.
func formatCountdown(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	total := int(d.Round(time.Second).Seconds())
	h, m, sec := total/3600, (total/60)%60, total%60

	switch {
	case h > 0:
		return fmt.Sprintf("%dh%02dm%02ds", h, m, sec)
	case m > 0:
		return fmt.Sprintf("%dm%02ds", m, sec)
	default:
		return fmt.Sprintf("%ds", sec)
	}
}

// chatHint is the status-bar entry for the chat key, empty on a receiver that
// does not run one so the hint disappears rather than promising a dead key.
func (u *UI) chatHint() string {
	if !u.chat.Available {
		return ""
	}
	return "C chat"
}

// squelchLabel renders the threshold: "off" when disabled, otherwise the dB
// figure.
func (u *UI) squelchLabel() string {
	if u.squelch <= 0 {
		return "off"
	}
	return fmt.Sprintf("%d", u.squelch)
}

// Squelched reports whether the gate is currently closed. The server sends
// silence rather than dropping packets while gated, so a short run of silent
// frames is the signal. The grace period stops the indicator flickering during
// natural pauses in speech.
func (u *UI) Squelched() bool {
	if !u.audioOn || u.squelch <= 0 {
		return false
	}
	return !u.lastAudioAt.IsZero() && time.Since(u.lastAudioAt) > 400*time.Millisecond
}

// NoteAudio records whether the newest frame carried sound.
func (u *UI) NoteAudio(silent bool) {
	if !silent {
		u.lastAudioAt = time.Now()
	}
}

// squelchField is the status-bar text: the threshold in a fixed-width slot,
// followed by a marker while the gate is actually closed so it is obvious why
// the audio has stopped. The marker's space is reserved either way so the
// hints after it do not shift when it appears.
func (u *UI) squelchField() string {
	marker := "  "
	if u.Squelched() {
		marker = " ▼"
	}
	return padRunes(u.squelchLabel(), 3) + marker
}

// dspName renders a filter name for display. The server's names are lowercase
// and must stay that way on the wire, so this is presentation only.
func dspName(filter string) string { return strings.ToUpper(filter) }

// dspNames renders a list of filter names for display.
func dspNames(filters []string) []string {
	out := make([]string, len(filters))
	for i, f := range filters {
		out[i] = dspName(f)
	}
	return out
}

// dspLabel names the current noise-reduction state for display: the active
// filter, "off" when the receiver offers DSP but none is selected, or "n/a"
// when it offers none at all. Those are three different things and conflating
// them would misreport a receiver without DSP as simply switched off.
//
// Only the filter name is uppercased; "off" and "n/a" describe a state rather
// than naming a filter, and keeping them lowercase makes the difference
// visible at a glance.
func (u *UI) dspLabel() string {
	switch {
	case len(u.dspFilters) == 0:
		return "n/a"
	case u.dspFilter != "":
		return dspName(u.dspFilter)
	default:
		return "off"
	}
}

// audioField summarises the audio channel for the header: mode, filter edges in
// kHz, mute state and signal level.
//
// Every part is padded to a fixed width. The header is right-aligned, so a
// value that changes length — the signal level swinging between -90 and -120,
// or the state going from "both" to "muted" — would otherwise shift the whole
// row sideways on almost every frame.
func (u *UI) audioField() string {
	mode, bw, rest := u.audioParts()
	return mode + " " + bw + " " + rest
}

// audioParts is audioField split at the seams the header colours: the mode and
// the filter width are drawn in their own colours beside the frequency, and
// everything after them — noise reduction, routing, level — stays dim.
func (u *UI) audioParts() (mode, bw, rest string) {
	name := strings.ToUpper(u.audioMode)
	if u.autoSideband && isSideband(u.audioMode) {
		name += "*" // following the 10 MHz convention automatically
	}

	// Filter width only. The exact edges are asymmetric for sideband modes, but
	// the shading already shows which side they fall on and the audio panel has
	// the numbers; spelling both out here cost 15 columns and pushed the whole
	// field off an 80-column terminal.
	width := fmt.Sprintf("%.1fk", float64(u.bwHigh-u.bwLow)/1000)

	// Plain words rather than a speaker emoji: emoji are double-width in most
	// terminals but count as one rune, so they break the width arithmetic the
	// header layout depends on.
	state := "on"
	if u.muted {
		state = "muted"
	} else if u.channel != ChannelBoth {
		state = u.channel.String()
	}

	// Reserve the level's space even before the first packet, so the row does
	// not jump the moment audio starts.
	level := fmt.Sprintf("%5s", "—")
	if u.signal.Valid() {
		level = fmt.Sprintf("%5.0f", u.signal.Power)
	}

	return padRunes(name, 4), // USB*, SAM, NFM
		padRunes(width, 5), // 24.0k
		fmt.Sprintf("%s %s %s dB",
			padRunes(u.dspLabel(), 4), // NR4, DFNR, off, n/a
			padRunes(state, 5),        // muted, right
			level)
}

// audioFieldCompact is the audio state for a narrow header: the mode and the
// filter width, and nothing else.
//
// Noise reduction, routing and the level all have somewhere else to be seen —
// the d panel and the meter — but nothing else on screen says what is being
// demodulated, so that is what survives.
func (u *UI) audioFieldCompact() string {
	mode, bw, state := u.audioPartsCompact()
	return mode + " " + bw + state
}

// audioPartsCompact splits the narrow form the same way audioParts splits the
// wide one. Exactly one of bw and state is set: a muted channel says so in
// place of the width, since the filter is not what matters at that moment.
func (u *UI) audioPartsCompact() (mode, bw, state string) {
	name := strings.ToUpper(u.audioMode)
	if u.autoSideband && isSideband(u.audioMode) {
		name += "*"
	}
	if u.muted {
		return padRunes(name, 4), "", "muted"
	}
	return padRunes(name, 4), fmt.Sprintf("%.1fk", float64(u.bwHigh-u.bwLow)/1000), ""
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
	}
}

// drawPeaks overlays the peak-hold trace on the spectrum pane.
//
// It marks the highest level each screen position has reached, decaying slowly,
// which is what makes a brief signal visible after it has gone. Drawn over
// whichever trace style is active.
func (u *UI) drawPeaks(s tcell.Screen, l Layout) {
	if !u.showPeaks || len(u.peaks) == 0 || l.SpecH < 2 {
		return
	}

	cols := columnPeaks(u.peaks, l.PlotW)
	style := tcell.StyleDefault.Foreground(tcell.NewRGBColor(235, 235, 250))

	for i, db := range cols {
		if math.IsInf(db, -1) {
			continue
		}
		y := l.SpecY + l.SpecH - 1 - int(u.norm(db)*float64(l.SpecH-1))
		if y < l.SpecY || y >= l.SpecY+l.SpecH {
			continue
		}
		// Overwrite whatever the trace drew: the peak line is the point.
		s.SetContent(l.PlotX+i, y, '‾', nil, style)
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

// drawFilter shades the passband across both panes, so it is obvious which part
// of the spectrum is actually being demodulated. The band is asymmetric about
// the VFO for sideband modes, which is exactly what makes it worth drawing.
func (u *UI) drawFilter(s tcell.Screen, l Layout) {
	if !u.audioOn || u.vfo <= 0 {
		return
	}
	start, span := u.viewRange()
	if span <= 0 {
		return
	}

	lo, hi := filterRange(u.vfo, u.bwLow, u.bwHigh)
	if hi < start || lo > start+span {
		return // filter entirely off-screen
	}

	colOf := func(f float64) int {
		return l.PlotX + int((f-start)/span*float64(l.PlotW))
	}
	loCol := clampInt(colOf(lo), l.PlotX, l.PlotX+l.PlotW-1)
	hiCol := clampInt(colOf(hi), l.PlotX, l.PlotX+l.PlotW-1)

	// A muted channel is shaded more faintly, so mute is visible at a glance
	// rather than only readable in the header.
	tint := tcell.NewRGBColor(40, 60, 40)
	edge := tcell.NewRGBColor(90, 190, 90)
	if u.muted {
		tint = tcell.NewRGBColor(55, 55, 55)
		edge = tcell.NewRGBColor(130, 130, 130)
	}

	for y := l.BodyY; y < l.AxisY; y++ {
		for x := loCol; x <= hiCol; x++ {
			r, combi, style, _ := s.GetContent(x, y)
			if r == 0 {
				r = ' '
			}
			s.SetContent(x, y, r, combi, style.Background(tint))
		}
	}

	// Edge ticks on the axis row mark the exact filter limits.
	if lo >= start {
		s.SetContent(loCol, l.AxisY, '▏', nil, tcell.StyleDefault.Foreground(edge))
	}
	if hi <= start+span {
		s.SetContent(hiCol, l.AxisY, '▕', nil, tcell.StyleDefault.Foreground(edge))
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

	for y := l.BodyY; y < l.AxisY; y++ {
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
	for y := l.BodyY; y < l.AxisY; y++ {
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

	// Leave room for the meter on the right rather than letting the hints run
	// under it.
	reserved := 0
	if _, _, ok := u.meterRegion(l); ok {
		reserved = meterCells() + 1
	}

	// Noise reduction carries its state next to its key, since it is the one
	// audio setting with no other always-visible indication of what it is
	// doing, and it is the first hint kept when space runs short. Padding it
	// stops the hints after it shifting as it changes.
	hints := []prioritisedField{
		{"f tune", 5},
		{"b bookmarks", 6},
		{u.chatHint(), 7},
		{"m mute", 4},
		{"M mode", 10},
		{"n NR:" + padRunes(u.dspLabel(), 4), 0},
		{"t SQ:" + u.squelchField(), 1},
		{"d audio", 8},
		{"g meter", 9},
		{"v view", 11},
		{"i receiver", 12},
		{"? help", 3},
		{"q quit", 2},
	}

	avail := l.W - reserved - 2 // leading and trailing space
	text := " " + strings.Join(fitFields(hints, avail, " · "), " · ") + " "

	// The transient status message gets whatever is left over.
	if u.status != "" {
		if spare := avail - runeLen(text) - 2; spare > 8 {
			text += "│ " + truncate(u.status, spare)
		}
	}
	drawText(s, 0, l.StatusY, style, padTo(truncate(text, l.W-reserved), l.W))

	if reserved > 0 {
		u.drawMeter(s, l)
	}
}

var helpLines = []string{
	"Tuning  (the VFO is what the radio is tuned to)",
	"  click            set the VFO",
	"  click a bookmark tune to it, with its mode and filter",
	"  b                browse and search the receiver's bookmarks",
	"  f                type a frequency",
	"  c                centre the view on the VFO",
	"  ↑ ↓              tune up / down one step",
	"  PgUp PgDn        tune ten steps",
	"  s / S            cycle the tuning step",
	"  wheel            tune, when the wheel is in tune mode (w)",
	"",
	"View  (moves the display, not the radio)",
	"  drag             pan",
	"  ← →              pan       shift+← → for a fine step",
	"",
	"Zoom and wheel",
	"  wheel            zoom, in at the cursor and out from the centre",
	"  w                switch the wheel between zoom and tune",
	"  + -              zoom about the centre",
	"  0                reset to full span",
	"",
	"Display",
	"  v                spectrum / waterfall / split",
	"  < >              resize the split",
	"  B                filled bars or braille trace",
	"  p                peak hold",
	"",
	"Audio",
	"  m                mute / unmute",
	"  M                cycle demodulation mode",
	"  A                auto sideband either side of 10 MHz",
	"  , .              narrow / widen the audio filter",
	"  x                output channel: both / left / right",
	"  g                signal meter: dBFS or SNR",
	"  n                cycle server-side noise reduction",
	"  t / T            raise / lower the squelch threshold (SNR)",
	"  d                audio settings: outputs, volume, filter",
	"",
	"Scaling  (the dB window, not the audio filter)",
	"  a                auto / manual",
	"  [ ]              lower / raise the floor",
	"  { }              lower / raise the ceiling",
	"",
	"Chat  (only on receivers that run one)",
	"  C                open the chat",
	"  @name            in the chat, mention someone; tab completes it",
	"  /leave           in the chat, leave it but keep the display",
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

// prioritisedField is a piece of status text with a shedding priority: lower
// values are kept longer when there is not enough width for everything.
type prioritisedField struct {
	text string
	prio int
}

// fitFields returns, in display order, those fields that fit within avail
// columns when joined by sep, dropping the lowest-priority ones first.
//
// Widths are counted in runes because the separators and unit glyphs are
// multi-byte, and a byte count would push the block off the edge.
func fitFields(fields []prioritisedField, avail int, sep string) []string {
	order := make([]int, len(fields))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return fields[order[a]].prio < fields[order[b]].prio
	})

	sepW := runeLen(sep)
	keep := make([]bool, len(fields))
	used := 0
	for _, idx := range order {
		// A field with no text is one the display does not offer at all — chat
		// on a receiver that does not run it — and must not cost a separator.
		if fields[idx].text == "" {
			continue
		}
		cost := runeLen(fields[idx].text)
		if used > 0 {
			cost += sepW
		}
		if used+cost > avail {
			continue // try the next, shorter field rather than stopping
		}
		keep[idx] = true
		used += cost
	}

	out := make([]string, 0, len(fields))
	for i, f := range fields {
		if keep[i] {
			out = append(out, f.text)
		}
	}
	return out
}

// runeLen is the column width of a string on screen. drawText advances one
// column per rune, so byte length would be wrong for the multi-byte glyphs the
// header uses.
func runeLen(s string) int { return len([]rune(s)) }

// padRunes pads to a fixed display width. Byte-based padding would be wrong for
// the multi-byte glyphs used in the header.
func padRunes(s string, w int) string {
	if n := runeLen(s); n < w {
		return s + strings.Repeat(" ", w-n)
	}
	return s
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

// padTo pads or truncates to a column width.
//
// Measured in runes: byte length would over-count every multi-byte glyph, and
// byte-slicing a string full of separators cuts it short and can split a
// character in half.
func padTo(s string, w int) string {
	if w <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) >= w {
		return string(r[:w])
	}
	return s + strings.Repeat(" ", w-len(r))
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
