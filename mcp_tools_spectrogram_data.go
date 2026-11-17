package main

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// get_spectrogram_data: the numbers behind get_spectrogram, for a client that
// wants to measure rather than look. Four views over the same recordings the
// spectrogram page reads, each sized to stay in the low thousands of numbers
// however long or wide the window:
//
//   - timeslice: level and SNR over time at chosen frequencies (the page's
//     Time Slice tab)
//   - spectrum:  the spectrum at one moment, optionally averaged or
//     peak-held over several minutes, plus its strongest peaks (clicking a
//     row on the page)
//   - grid:      a coarse time x frequency matrix, the image as numbers
//   - events:    what a person would point at on the image: gaps, broadband
//     bursts, steady carriers and intermittent signals
//
// Any view can read the rolling last 24 hours or one archived UTC day.

const (
	sgdMaxFreqs        = 8
	sgdMaxSeriesPoints = 2880 // timeslice: steps x frequencies
	sgdMaxGridCells    = 2400
	sgdMaxSpectrumPts  = 1024
	sgdMaxKHz          = 1_000_000 // far above any receiver; only a sanity bound
	sgdBurstHalfWindow = 15        // rows either side of a minute for its baseline
)

// sgdNiceSteps are the step sizes picked automatically, so boundaries fall on
// round minutes and hours.
var sgdNiceSteps = []int{1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440}

var sgdStats = []string{"mean", "median", "p95", "max", "min"}

func (m *MCPServer) registerSpectrogramDataTool() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_spectrogram_data",
			mcpReadOnlyTool,
			mcp.WithDescription("Get the numbers behind the receiver's recorded spectrogram (one spectrum per minute, kept for several days), for measuring rather than looking; get_spectrogram returns the picture. "+
				"Views: 'timeslice' = signal level and SNR over time at up to 8 frequencies (when did a band or a station come and go); "+
				"'spectrum' = the spectrum at one moment, optionally averaged or peak-held over several minutes, with its strongest peaks; "+
				"'grid' = a coarse time x frequency matrix of levels (the waterfall as numbers, e.g. hours x 48 frequency strips); "+
				"'events' = gaps in the recording, broadband bursts (interference or switching noise across the band), steady carriers and intermittent signals. "+
				"Window: the rolling last 24 hours (default; narrow it with hours or from_utc/to_utc) or one archived UTC day with date. "+
				"All levels are dBFS; SNR is dB above that minute's noise floor (its 5th percentile). Times are UTC. Responses are capped at a few thousand numbers."),
			mcp.WithString("view",
				mcp.Required(),
				mcp.Description("'timeslice', 'spectrum', 'grid' or 'events'"),
				mcp.Enum("timeslice", "spectrum", "grid", "events"),
			),
			mcp.WithString("band",
				mcp.MaxLength(32),
				mcp.Description("Which recording: 'wideband' (the whole receiver), 'wideband-hf' (1.8 MHz up), a monitored band such as '20m' (finer frequency resolution), or 'auto' = the narrowest recording that covers the requested frequencies. Default: 'auto' for timeslice, otherwise 'wideband'."),
			),
			mcp.WithString("date",
				mcp.MaxLength(10),
				mcp.Description("A whole archived UTC day, YYYY-MM-DD, instead of the rolling last 24 hours"),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(24),
				mcp.Description("Rolling window only: the most recent N hours, 1-24 (default 24)"),
			),
			mcp.WithString("from_utc",
				mcp.MaxLength(40),
				mcp.Description("Start of the window: 'HH:MM' (on date, or the most recent such time) or an RFC 3339 timestamp"),
			),
			mcp.WithString("to_utc",
				mcp.MaxLength(40),
				mcp.Description("End of the window, same forms as from_utc"),
			),
			mcp.WithNumber("freq_min_khz",
				mcp.Min(0),
				mcp.Max(sgdMaxKHz),
				mcp.Description("spectrum, grid, events: lowest frequency to include, kHz"),
			),
			mcp.WithNumber("freq_max_khz",
				mcp.Min(0),
				mcp.Max(sgdMaxKHz),
				mcp.Description("spectrum, grid, events: highest frequency to include, kHz"),
			),
			mcp.WithArray("freqs_khz",
				mcp.Description("timeslice: centre frequencies in kHz, at most 8, e.g. [7074, 14074] (a comma-separated string also works)"),
				mcp.Items(map[string]interface{}{"type": "number", "minimum": 0, "maximum": sgdMaxKHz}),
				mcp.MaxItems(sgdMaxFreqs),
			),
			mcp.WithNumber("bandwidth_khz",
				mcp.Min(0.001),
				mcp.Max(10000),
				mcp.Description("timeslice: width averaged around each frequency, kHz (default 3; at least one recorded bin is always used)"),
			),
			mcp.WithNumber("step_minutes",
				mcp.Min(1),
				mcp.Max(1440),
				mcp.Description("timeslice, grid: minutes per time step, 1-1440 (default: chosen to fit the window, e.g. 10 for a timeslice of 24 hours, 60 for a grid)"),
			),
			mcp.WithNumber("freq_bins",
				mcp.Min(1),
				mcp.Max(512),
				mcp.Description("grid: number of frequency strips, 1-512 (default 48)"),
			),
			mcp.WithString("stat",
				mcp.Description("How minutes (and, for grid, bins) combine into one value: 'mean', 'median', 'p95', 'max' or 'min'. Defaults: timeslice and spectrum 'mean', grid 'p95'. In spectrum view 'max' over several minutes is a peak hold."),
				mcp.Enum(sgdStats...),
			),
			mcp.WithString("at",
				mcp.MaxLength(40),
				mcp.Description("spectrum: the moment, 'HH:MM' or RFC 3339 (default: the latest recorded minute in the window)"),
			),
			mcp.WithNumber("minutes",
				mcp.Min(1),
				mcp.Max(60),
				mcp.Description("spectrum: how many minutes up to 'at' to combine, 1-60 (default 1)"),
			),
			mcp.WithNumber("points",
				mcp.Min(8),
				mcp.Max(sgdMaxSpectrumPts),
				mcp.Description("spectrum: number of points across the frequency range, 8-1024 (default 256). Each point holds the strongest bin it covers, so narrow signals are not averaged away."),
			),
			mcp.WithNumber("min_snr_db",
				mcp.Min(0),
				mcp.Max(100),
				mcp.Description("SNR threshold in dB. timeslice: counts minutes above it (default 6). spectrum: peaks must reach it (default 10). events: carriers and signals must reach it (default 10)."),
			),
			mcp.WithNumber("burst_threshold_db",
				mcp.Min(1),
				mcp.Max(60),
				mcp.Description("events: how far, in dB, a minute's median level must rise above the surrounding half hour to count as a broadband burst, 1-60 (default 6)"),
			),
			mcp.WithNumber("max_items",
				mcp.Min(0),
				mcp.Max(50),
				mcp.Description("spectrum peaks and each events list: most entries to return, 0-50 (default 15 peaks, 20 events)"),
			),
		),
		m.handleGetSpectrogramData,
	)
}

// sgdWindow is the rows of one recording within the requested time window.
type sgdWindow struct {
	rec      *SpectrogramRecorder
	band     string
	rows     [][]float32
	meta     []SpectrogramRowMeta
	startHz  float64
	binHz    float64
	minHz    float64 // lowest frequency the band name allows (wideband-hf: 1.8 MHz)
	rowFloor []float32
}

func (w *sgdWindow) binCentreKHz(b int) float64 {
	return (w.startHz + (float64(b)+0.5)*w.binHz) / 1e3
}

// floor is the row's noise floor: its 5th percentile across the whole
// recording. The recorder logs exactly that for each minute; it is computed
// only for rows logged without one.
func (w *sgdWindow) floor(i int) float32 {
	if w.rowFloor == nil {
		w.rowFloor = make([]float32, len(w.rows))
		for j := range w.rowFloor {
			w.rowFloor[j] = float32(math.NaN())
		}
	}
	if math.IsNaN(float64(w.rowFloor[i])) {
		f := float32(math.Inf(-1))
		if nf := w.meta[i].NoiseFloor; nf != 0 && sgdValid(nf) {
			f = nf
		} else if rowHasData(w.rows[i]) {
			f = sgdP5(w.rows[i], nil)
		}
		w.rowFloor[i] = f
	}
	return w.rowFloor[i]
}

// sgdRequest is the validated arguments shared by every view.
type sgdRequest struct {
	view     string
	band     string
	date     *time.Time
	from, to time.Time
	loKHz    float64
	hiKHz    float64
	hasLo    bool
	hasHi    bool
}

func (m *MCPServer) handleGetSpectrogramData(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.Spectrogram == nil && len(m.BandSpectrograms) == 0 {
		return mcp.NewToolResultError("Spectrogram recording is not enabled on this receiver"), nil
	}
	a := newMCPArgs(request)
	a.only("view", "band", "date", "hours", "from_utc", "to_utc", "freq_min_khz", "freq_max_khz",
		"freqs_khz", "bandwidth_khz", "step_minutes", "freq_bins", "stat", "at", "minutes", "points",
		"min_snr_db", "burst_threshold_db", "max_items")
	if a.Err() != nil {
		return mcp.NewToolResultError(a.Err().Error()), nil
	}

	req := sgdRequest{view: a.enum("view", "", "timeslice", "spectrum", "grid", "events")}
	if req.view == "" && a.Err() == nil {
		a.fail("view is required: 'timeslice', 'spectrum', 'grid' or 'events'")
	}
	defBand := "wideband"
	if req.view == "timeslice" {
		defBand = "auto"
	}
	req.band = strings.ToLower(a.str("band", defBand, 32))
	now := time.Now().UTC()
	req.date, req.from, req.to = sgdTimeRange(a, now)
	req.loKHz, req.hasLo = a.optNumber("freq_min_khz", 0, sgdMaxKHz)
	req.hiKHz, req.hasHi = a.optNumber("freq_max_khz", 0, sgdMaxKHz)
	if req.hasLo && req.hasHi && req.hiKHz <= req.loKHz {
		a.fail("freq_max_khz must be above freq_min_khz")
	}
	if req.view == "timeslice" && (req.hasLo || req.hasHi) {
		a.fail("timeslice takes freqs_khz and bandwidth_khz, not freq_min_khz/freq_max_khz")
	}
	if a.Err() != nil {
		return mcp.NewToolResultError(a.Err().Error()), nil
	}

	// Each view validates its own arguments before any data is read, then
	// the rate limit is charged.
	var run func() (interface{}, error)
	switch req.view {
	case "timeslice":
		run = m.sgdTimeslice(a, req)
	case "spectrum":
		run = m.sgdSpectrum(a, req, now)
	case "grid":
		run = m.sgdGrid(a, req)
	case "events":
		run = m.sgdEvents(a, req)
	}
	if a.Err() != nil {
		return mcp.NewToolResultError(a.Err().Error()), nil
	}
	if !m.allowToolCall(ctx, "get_spectrogram_data") {
		return mcpRateLimited("get_spectrogram_data"), nil
	}
	out, err := run()
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcpJSON(out)
}

// sgdTimeRange resolves date / hours / from_utc / to_utc into a window.
func sgdTimeRange(a *mcpArgs, now time.Time) (*time.Time, time.Time, time.Time) {
	var datePtr *time.Time
	from, to := now.Add(-24*time.Hour), now
	if d, ok := a.date("date"); ok {
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		if d.After(today) {
			a.fail("date %s is in the future", d.Format("2006-01-02"))
		}
		if a.has("hours") {
			a.fail("hours applies to the rolling window; with date, use from_utc/to_utc")
		}
		datePtr = &d
		from, to = d, d.Add(24*time.Hour-time.Second)
	}
	if a.has("hours") && datePtr == nil {
		if a.has("from_utc") {
			a.fail("give hours or from_utc, not both")
		}
		h := a.integer("hours", 24, 1, 24)
		from = now.Add(-time.Duration(h) * time.Hour)
	}
	lo, hi := from, to
	if t, ok := sgdParseTime(a, "from_utc", datePtr, now); ok {
		from = t
	}
	if t, ok := sgdParseTime(a, "to_utc", datePtr, now); ok {
		to = t
	}
	if a.Err() == nil {
		if from.Before(lo) || to.After(hi.Add(time.Minute)) {
			if datePtr != nil {
				a.fail("from_utc/to_utc must fall on %s", datePtr.Format("2006-01-02"))
			} else {
				a.fail("from_utc/to_utc must fall within the last 24 hours; use date for earlier days")
			}
		} else if !to.After(from) {
			a.fail("to_utc must be after from_utc")
		}
	}
	return datePtr, from, to
}

// sgdParseTime reads 'HH:MM' (on date, or the most recent such time before
// now) or an RFC 3339 timestamp.
func sgdParseTime(a *mcpArgs, key string, date *time.Time, now time.Time) (time.Time, bool) {
	s := a.str(key, "", 40)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	hm, err := time.Parse("15:04", s)
	if err != nil {
		a.fail("%s must be 'HH:MM' or an RFC 3339 time, got %q", key, mcpSafeEcho(s))
		return time.Time{}, false
	}
	offset := time.Duration(hm.Hour())*time.Hour + time.Duration(hm.Minute())*time.Minute
	if date != nil {
		return date.Add(offset), true
	}
	t := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(offset)
	if t.After(now) {
		t = t.Add(-24 * time.Hour)
	}
	return t, true
}

// sgdRecorder resolves a band name. For 'auto' it picks the narrowest
// recording that covers [loHz, hiHz], falling back to wideband.
func (m *MCPServer) sgdRecorder(band string, loHz, hiHz float64) (*SpectrogramRecorder, string, float64, error) {
	switch band {
	case "wideband":
		if m.Spectrogram != nil {
			return m.Spectrogram, "wideband", 0, nil
		}
	case "wideband-hf":
		if m.Spectrogram != nil {
			return m.Spectrogram, "wideband-hf", 1_800_000, nil
		}
	case "auto":
		var best *SpectrogramRecorder
		bestName := ""
		for name, rec := range m.BandSpectrogramsOrEmpty() {
			if float64(rec.startFreqHz) <= loHz && float64(rec.endFreqHz) >= hiHz &&
				(best == nil || rec.endFreqHz-rec.startFreqHz < best.endFreqHz-best.startFreqHz) {
				best, bestName = rec, name
			}
		}
		if best != nil {
			return best, bestName, 0, nil
		}
		if m.Spectrogram != nil {
			return m.Spectrogram, "wideband", 0, nil
		}
	default:
		if rec := m.BandSpectrogramsOrEmpty()[band]; rec != nil {
			return rec, band, 0, nil
		}
	}
	names := []string{"auto"}
	if m.Spectrogram != nil {
		names = append(names, "wideband", "wideband-hf")
	}
	bands := make([]string, 0, len(m.BandSpectrograms))
	for n := range m.BandSpectrograms {
		bands = append(bands, n)
	}
	sort.Strings(bands)
	return nil, "", 0, fmt.Errorf("no spectrogram is recorded for band %q; available: %s",
		mcpSafeEcho(band), strings.Join(append(names, bands...), ", "))
}

// sgdLoad reads a recording's rows in the window. Rolling rows are shared
// with other requests, so they are sliced, never modified.
func sgdLoad(rec *SpectrogramRecorder, band string, minHz float64, req sgdRequest) (*sgdWindow, error) {
	var rows [][]float32
	var meta []SpectrogramRowMeta
	if req.date != nil {
		var err error
		rows, meta, err = rec.dayRows(req.date.Format("2006-01-02"))
		if err != nil {
			return nil, fmt.Errorf("no spectrogram is archived for %s", req.date.Format("2006-01-02"))
		}
	} else {
		rr := rec.getRolling24hRows()
		if rr == nil {
			return nil, fmt.Errorf("no spectrogram data has been recorded yet")
		}
		rows, meta = rr.rows, rr.metaRows
		if len(meta) < len(rows) {
			rows = rows[:len(meta)]
		}
	}
	w := &sgdWindow{rec: rec, band: band, minHz: minHz, startHz: float64(rec.startFreqHz)}
	w.binHz = (float64(rec.endFreqHz) - w.startHz) / float64(rec.binCount)
	fromU, toU := req.from.Unix(), req.to.Unix()
	for i := range rows {
		if meta[i].Unix >= fromU && meta[i].Unix <= toU && len(rows[i]) == rec.binCount {
			w.rows = append(w.rows, rows[i])
			w.meta = append(w.meta, meta[i])
		}
	}
	if !anyRowHasData(w.rows) {
		return nil, fmt.Errorf("no spectrogram data between %s and %s",
			req.from.Format(time.RFC3339), req.to.Format(time.RFC3339))
	}
	return w, nil
}

// bins turns the request's frequency crop into a bin range, refusing a crop
// that misses the recording instead of silently showing all of it.
func (w *sgdWindow) bins(req sgdRequest) (int, int, error) {
	startHz, endHz := w.startHz, float64(w.rec.endFreqHz)
	loHz, hiHz := math.Max(req.loKHz*1e3, w.minHz), endHz
	if req.hasHi {
		hiHz = req.hiKHz * 1e3
	}
	if loHz >= endHz || hiHz <= math.Max(startHz, w.minHz) {
		return 0, 0, fmt.Errorf("frequencies %s-%s kHz are outside the %s recording (%s-%s kHz)",
			fmtNum(roundTo(loHz/1e3, 3)), fmtNum(roundTo(hiHz/1e3, 3)), w.band,
			fmtNum(roundTo(math.Max(startHz, w.minHz)/1e3, 3)), fmtNum(roundTo(endHz/1e3, 3)))
	}
	sb := int(math.Floor((math.Max(loHz, startHz) - startHz) / w.binHz))
	eb := int(math.Ceil((math.Min(hiHz, endHz) - startHz) / w.binHz))
	sb = sgdMax(0, min(sb, w.rec.binCount-1))
	eb = sgdMax(sb+1, min(eb, w.rec.binCount))
	return sb, eb, nil
}

func (w *sgdWindow) header(view string, sb, eb int) map[string]interface{} {
	withData := 0
	for _, r := range w.rows {
		if rowHasData(r) {
			withData++
		}
	}
	h := map[string]interface{}{
		"view": view,
		"band": w.band,
		"window": map[string]interface{}{
			"from_utc":          time.Unix(w.meta[0].Unix, 0).UTC().Format(time.RFC3339),
			"to_utc":            time.Unix(w.meta[len(w.meta)-1].Unix, 0).UTC().Format(time.RFC3339),
			"minutes_with_data": withData,
		},
		"units": "dBFS; snr_db is dB above that minute's noise floor (5th percentile of the whole recording)",
	}
	if eb > sb {
		h["frequency"] = map[string]interface{}{
			"min_khz":    roundTo((w.startHz+float64(sb)*w.binHz)/1e3, 3),
			"max_khz":    roundTo((w.startHz+float64(eb)*w.binHz)/1e3, 3),
			"bin_hz":     roundTo(w.binHz, 1),
			"bins_total": eb - sb,
		}
	}
	return h
}

// ── statistics ───────────────────────────────────────────────────────────────

func sgdValid(v float32) bool { return !math.IsInf(float64(v), 0) && !math.IsNaN(float64(v)) }

// sgdStat combines values (all valid, at least one) and may reorder them.
func sgdStat(vals []float32, stat string) float32 {
	switch stat {
	case "max":
		m := vals[0]
		for _, v := range vals[1:] {
			m = sgdMax(m, v)
		}
		return m
	case "min":
		m := vals[0]
		for _, v := range vals[1:] {
			if v < m {
				m = v
			}
		}
		return m
	case "median":
		return sgdSelect(vals, len(vals)/2)
	case "p95":
		return sgdSelect(vals, min(len(vals)*95/100, len(vals)-1))
	default:
		var s float64
		for _, v := range vals {
			s += float64(v)
		}
		return float32(s / float64(len(vals)))
	}
}

// sgdSelect returns the k-th smallest of vals (0-based), reordering them. A
// quickselect with a three-way partition: linear on average, and quiet noise,
// full of repeated values, does not slow it down the way a two-way
// partition would.
func sgdSelect(vals []float32, k int) float32 {
	lo, hi := 0, len(vals)-1
	for lo < hi {
		a, b, c := vals[lo], vals[lo+(hi-lo)/2], vals[hi]
		p := b // median of three
		if (a <= b) == (b <= c) {
			p = b
		} else if (b <= a) == (a <= c) {
			p = a
		} else {
			p = c
		}
		lt, i, gt := lo, lo, hi
		for i <= gt {
			switch {
			case vals[i] < p:
				vals[lt], vals[i] = vals[i], vals[lt]
				lt++
				i++
			case vals[i] > p:
				vals[i], vals[gt] = vals[gt], vals[i]
				gt--
			default:
				i++
			}
		}
		switch {
		case k < lt:
			hi = lt - 1
		case k > gt:
			lo = gt + 1
		default:
			return p
		}
	}
	return vals[k]
}

// sgdP5 is the 5th percentile of a row's valid values, using *scratch (if
// given) as working space so the row itself is left alone.
func sgdP5(row []float32, scratch *[]float32) float32 {
	var buf []float32
	if scratch != nil {
		buf = (*scratch)[:0]
	}
	for _, v := range row {
		if sgdValid(v) {
			buf = append(buf, v)
		}
	}
	if scratch != nil {
		*scratch = buf
	}
	if len(buf) == 0 {
		return float32(math.Inf(-1))
	}
	return sgdSelect(buf, len(buf)*5/100)
}

// sgdNum is a JSON number rounded to 0.1 dB, or null for no data.
func sgdNum(v float32) *float64 {
	if !sgdValid(v) {
		return nil
	}
	r := roundTo(float64(v), 1)
	return &r
}

func sgdUTC(unix int64) string { return time.Unix(unix, 0).UTC().Format(time.RFC3339) }

// sgdAutoStep is the smallest nice step that keeps the window within maxSteps.
func sgdAutoStep(spanMin, maxSteps int) int {
	for _, s := range sgdNiceSteps {
		if (spanMin+s-1)/s <= maxSteps {
			return s
		}
	}
	return 1440
}

// sgdSteps buckets rows into step-minute intervals aligned to UTC multiples of
// the step. It returns the first step's start and each row's step index.
func sgdSteps(from, to time.Time, step int) (base int64, n int) {
	sec := int64(step) * 60
	base = from.Unix() - from.Unix()%sec
	n = int((to.Unix()-base)/sec) + 1
	return base, n
}

// ── timeslice ────────────────────────────────────────────────────────────────

func (m *MCPServer) sgdTimeslice(a *mcpArgs, req sgdRequest) func() (interface{}, error) {
	freqs := a.numberList("freqs_khz", sgdMaxFreqs, 0, sgdMaxKHz)
	if freqs == nil && a.Err() == nil {
		a.fail("timeslice needs freqs_khz, e.g. '14074' or '7074, 14074'")
	}
	bwKHz := a.number("bandwidth_khz", 3, 0.001, 10_000)
	stat := a.enum("stat", "mean", sgdStats...)
	minSNR := a.number("min_snr_db", 6, 0, 100)
	spanMin := int(req.to.Sub(req.from).Minutes()) + 1
	step, hasStep := a.optInt("step_minutes", 1, 1440)
	if !hasStep {
		step = sgdAutoStep(spanMin, 144)
	}
	for _, k := range []string{"freq_bins", "at", "minutes", "points", "burst_threshold_db", "max_items"} {
		if a.has(k) {
			a.fail("%s does not apply to the timeslice view", k)
		}
	}
	if a.Err() != nil {
		return nil
	}
	base, nSteps := sgdSteps(req.from, req.to, step)
	if nSteps*len(freqs) > sgdMaxSeriesPoints {
		a.fail("%d steps x %d frequencies is %d points, at most %d: raise step_minutes or shorten the window",
			nSteps, len(freqs), nSteps*len(freqs), sgdMaxSeriesPoints)
		return nil
	}

	return func() (interface{}, error) {
		windows := map[*SpectrogramRecorder]*sgdWindow{}
		series := make([]map[string]interface{}, 0, len(freqs))
		var first *sgdWindow
		for _, fKHz := range freqs {
			loHz, hiHz := (fKHz-bwKHz/2)*1e3, (fKHz+bwKHz/2)*1e3
			rec, name, minHz, err := m.sgdRecorder(req.band, loHz, hiHz)
			if err != nil {
				return nil, err
			}
			w := windows[rec]
			if w == nil {
				if w, err = sgdLoad(rec, name, minHz, req); err != nil {
					return nil, err
				}
				windows[rec] = w
			}
			if first == nil {
				first = w
			}
			if fKHz*1e3 < math.Max(w.startHz, minHz) || fKHz*1e3 > float64(rec.endFreqHz) {
				return nil, fmt.Errorf("%s kHz is outside the %s recording (%s-%s kHz)", fmtNum(fKHz), name,
					fmtNum(roundTo(math.Max(w.startHz, minHz)/1e3, 3)), fmtNum(roundTo(float64(rec.endFreqHz)/1e3, 3)))
			}
			series = append(series, sgdSeries(w, fKHz, bwKHz, stat, minSNR, base, nSteps, step))
		}
		out := first.header("timeslice", 0, 0)
		out["time_axis"] = map[string]interface{}{
			"start_utc":    sgdUTC(base),
			"step_minutes": step,
			"steps":        nSteps,
			"note":         "value i covers start_utc + i*step_minutes; null = no data",
		}
		out["stat"] = stat
		out["min_snr_db"] = minSNR
		out["series"] = series
		return out, nil
	}
}

func sgdSeries(w *sgdWindow, fKHz, bwKHz float64, stat string, minSNR float64, base int64, nSteps, step int) map[string]interface{} {
	binLo := int(math.Floor(((fKHz-bwKHz/2)*1e3 - w.startHz) / w.binHz))
	binHi := int(math.Floor(((fKHz+bwKHz/2)*1e3 - w.startHz) / w.binHz))
	binLo = sgdMax(0, min(binLo, w.rec.binCount-1))
	binHi = sgdMax(binLo, min(binHi, w.rec.binCount-1))

	levels := make([][]float32, nSteps)
	floors := make([][]float32, nSteps)
	var all []float32
	minutesAbove := 0
	var firstAbove, lastAbove, maxAt int64
	maxV := float32(math.Inf(-1))
	sec := int64(step) * 60
	for i, row := range w.rows {
		var sum float64
		n := 0
		for b := binLo; b <= binHi; b++ {
			if sgdValid(row[b]) {
				sum += float64(row[b])
				n++
			}
		}
		if n == 0 {
			continue
		}
		v := float32(sum / float64(n))
		fl := w.floor(i)
		s := int((w.meta[i].Unix - base) / sec)
		if s < 0 || s >= nSteps {
			continue
		}
		levels[s] = append(levels[s], v)
		floors[s] = append(floors[s], fl)
		all = append(all, v)
		if v > maxV {
			maxV, maxAt = v, w.meta[i].Unix
		}
		if float64(v-fl) >= minSNR {
			minutesAbove++
			if firstAbove == 0 {
				firstAbove = w.meta[i].Unix
			}
			lastAbove = w.meta[i].Unix
		}
	}

	db := make([]*float64, nSteps)
	snr := make([]*float64, nSteps)
	for s := range levels {
		if len(levels[s]) == 0 {
			continue
		}
		v := sgdStat(levels[s], stat)
		fl := sgdStat(floors[s], "mean")
		db[s] = sgdNum(v)
		snr[s] = sgdNum(v - fl)
	}
	summary := map[string]interface{}{"minutes_with_data": len(all)}
	if len(all) > 0 {
		summary["max_db"] = sgdNum(maxV)
		summary["max_at_utc"] = sgdUTC(maxAt)
		summary["min_db"] = sgdNum(sgdStat(all, "min"))
		summary["median_db"] = sgdNum(sgdStat(all, "median"))
		summary["minutes_above_min_snr"] = minutesAbove
		if minutesAbove > 0 {
			summary["first_above_utc"] = sgdUTC(firstAbove)
			summary["last_above_utc"] = sgdUTC(lastAbove)
		}
	}
	return map[string]interface{}{
		"freq_khz":      fKHz,
		"bandwidth_khz": bwKHz,
		"source_band":   w.band,
		"bins_averaged": binHi - binLo + 1,
		"bin_hz":        roundTo(w.binHz, 1),
		"summary":       summary,
		"db":            db,
		"snr_db":        snr,
	}
}

// ── spectrum ─────────────────────────────────────────────────────────────────

func (m *MCPServer) sgdSpectrum(a *mcpArgs, req sgdRequest, now time.Time) func() (interface{}, error) {
	minutes := a.integer("minutes", 1, 1, 60)
	points := a.integer("points", 256, 8, sgdMaxSpectrumPts)
	stat := a.enum("stat", "mean", sgdStats...)
	minSNR := a.number("min_snr_db", 10, 0, 100)
	maxItems := a.integer("max_items", 15, 0, 50)
	at, hasAt := sgdParseTime(a, "at", req.date, now)
	for _, k := range []string{"freqs_khz", "bandwidth_khz", "step_minutes", "freq_bins", "burst_threshold_db"} {
		if a.has(k) {
			a.fail("%s does not apply to the spectrum view", k)
		}
	}
	if hasAt && (at.Before(req.from) || at.After(req.to.Add(time.Minute))) {
		a.fail("at must fall within the window (%s to %s)", req.from.Format(time.RFC3339), req.to.Format(time.RFC3339))
	}
	if a.Err() != nil {
		return nil
	}

	return func() (interface{}, error) {
		w, sb, eb, err := m.sgdOpen(req)
		if err != nil {
			return nil, err
		}
		// The minutes ending at 'at', or at the latest minute with data.
		end := -1
		for i := len(w.rows) - 1; i >= 0; i-- {
			if (!hasAt || w.meta[i].Unix <= at.Unix()) && rowHasData(w.rows[i]) {
				end = i
				break
			}
		}
		if end < 0 {
			return nil, fmt.Errorf("no spectrum recorded at or before %s", at.Format(time.RFC3339))
		}
		if hasAt && at.Unix()-w.meta[end].Unix > 120 {
			return nil, fmt.Errorf("no spectrum recorded at %s (nearest earlier minute is %s)",
				at.Format(time.RFC3339), sgdUTC(w.meta[end].Unix))
		}
		var used []int
		for i := end; i >= 0 && w.meta[end].Unix-w.meta[i].Unix < int64(minutes)*60; i-- {
			if rowHasData(w.rows[i]) {
				used = append(used, i)
			}
		}

		spec := make([]float32, eb-sb)
		buf := make([]float32, 0, len(used))
		for b := sb; b < eb; b++ {
			buf = buf[:0]
			for _, i := range used {
				if v := w.rows[i][b]; sgdValid(v) {
					buf = append(buf, v)
				}
			}
			spec[b-sb] = float32(math.Inf(-1))
			if len(buf) > 0 {
				spec[b-sb] = sgdStat(buf, stat)
			}
		}
		valid := make([]float32, 0, len(spec))
		for _, v := range spec {
			if sgdValid(v) {
				valid = append(valid, v)
			}
		}
		if len(valid) == 0 {
			return nil, fmt.Errorf("no spectrum data in that frequency range")
		}
		floor := sgdSelect(valid, len(valid)*5/100)

		n := min(points, eb-sb)
		pts := make([]*float64, n)
		for p := 0; p < n; p++ {
			lo, hi := p*(eb-sb)/n, (p+1)*(eb-sb)/n
			best := float32(math.Inf(-1))
			for _, v := range spec[lo:sgdMax(hi, lo+1)] {
				if sgdValid(v) {
					best = sgdMax(best, v)
				}
			}
			pts[p] = sgdNum(best)
		}
		stepKHz := float64(eb-sb) * w.binHz / float64(n) / 1e3

		out := w.header("spectrum", sb, eb)
		out["at_utc"] = sgdUTC(w.meta[end].Unix)
		out["minutes_combined"] = len(used)
		out["stat"] = stat
		out["noise_floor_db"] = sgdNum(floor)
		out["points"] = map[string]interface{}{
			"first_centre_khz": roundTo((w.startHz+float64(sb)*w.binHz)/1e3+stepKHz/2, 3),
			"step_khz":         roundTo(stepKHz, 3),
			"count":            n,
			"note":             "each point is the strongest bin in its step; null = no data",
		}
		out["db"] = pts
		out["peaks"] = sgdPeaks(w, spec, sb, floor, minSNR, maxItems)
		return out, nil
	}
}

// sgdPeaks finds the strongest local maxima at full resolution, at least
// minSNR above the floor and three bins apart.
func sgdPeaks(w *sgdWindow, spec []float32, sb int, floor float32, minSNR float64, maxItems int) []map[string]interface{} {
	type peak struct {
		bin int
		v   float32
	}
	var cands []peak
	for i, v := range spec {
		if !sgdValid(v) || float64(v-floor) < minSNR {
			continue
		}
		isMax := true
		for j := sgdMax(0, i-2); j <= min(len(spec)-1, i+2); j++ {
			if j != i && sgdValid(spec[j]) && (spec[j] > v || (spec[j] == v && j < i)) {
				isMax = false
				break
			}
		}
		if isMax {
			cands = append(cands, peak{i, v})
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].v > cands[j].v })
	out := []map[string]interface{}{}
	var taken []int
	for _, c := range cands {
		if len(out) >= maxItems {
			break
		}
		near := false
		for _, t := range taken {
			if c.bin-t <= 3 && t-c.bin <= 3 {
				near = true
				break
			}
		}
		if near {
			continue
		}
		taken = append(taken, c.bin)
		out = append(out, map[string]interface{}{
			"freq_khz": roundTo(w.binCentreKHz(sb+c.bin), 3),
			"db":       sgdNum(c.v),
			"snr_db":   sgdNum(c.v - floor),
		})
	}
	return out
}

// sgdOpen loads the window for a frequency-cropped view.
func (m *MCPServer) sgdOpen(req sgdRequest) (*sgdWindow, int, int, error) {
	loHz, hiHz := req.loKHz*1e3, req.hiKHz*1e3
	if !req.hasHi {
		hiHz = loHz
	}
	rec, name, minHz, err := m.sgdRecorder(req.band, loHz, hiHz)
	if err != nil {
		return nil, 0, 0, err
	}
	w, err := sgdLoad(rec, name, minHz, req)
	if err != nil {
		return nil, 0, 0, err
	}
	sb, eb, err := w.bins(req)
	if err != nil {
		return nil, 0, 0, err
	}
	return w, sb, eb, nil
}

// ── grid ─────────────────────────────────────────────────────────────────────

func (m *MCPServer) sgdGrid(a *mcpArgs, req sgdRequest) func() (interface{}, error) {
	nb := a.integer("freq_bins", 48, 1, 512)
	stat := a.enum("stat", "p95", sgdStats...)
	spanMin := int(req.to.Sub(req.from).Minutes()) + 1
	step, hasStep := a.optInt("step_minutes", 1, 1440)
	if !hasStep {
		step = sgdAutoStep(spanMin, sgdMax(1, min(24, sgdMaxGridCells/nb)))
	}
	for _, k := range []string{"freqs_khz", "bandwidth_khz", "at", "minutes", "points", "min_snr_db", "burst_threshold_db", "max_items"} {
		if a.has(k) {
			a.fail("%s does not apply to the grid view", k)
		}
	}
	if a.Err() != nil {
		return nil
	}
	base, nSteps := sgdSteps(req.from, req.to, step)
	if nSteps*nb > sgdMaxGridCells {
		a.fail("%d steps x %d freq_bins is %d cells, at most %d: raise step_minutes, lower freq_bins or shorten the window",
			nSteps, nb, nSteps*nb, sgdMaxGridCells)
		return nil
	}

	return func() (interface{}, error) {
		w, sb, eb, err := m.sgdOpen(req)
		if err != nil {
			return nil, err
		}
		cols := min(nb, eb-sb)
		sec := int64(step) * 60
		byStep := make([][]int, nSteps)
		for i := range w.rows {
			if s := int((w.meta[i].Unix - base) / sec); s >= 0 && s < nSteps && rowHasData(w.rows[i]) {
				byStep[s] = append(byStep[s], i)
			}
		}
		rowsOut := make([]map[string]interface{}, 0, nSteps)
		var buf, floors []float32
		for s, idx := range byStep {
			cells := make([]*float64, cols)
			floors = floors[:0]
			for _, i := range idx {
				floors = append(floors, sgdP5(w.rows[i][sb:eb], &buf))
			}
			for c := 0; c < cols; c++ {
				lo, hi := sb+c*(eb-sb)/cols, sb+(c+1)*(eb-sb)/cols
				buf = buf[:0]
				for _, i := range idx {
					for _, v := range w.rows[i][lo:sgdMax(hi, lo+1)] {
						if sgdValid(v) {
							buf = append(buf, v)
						}
					}
				}
				if len(buf) > 0 {
					cells[c] = sgdNum(sgdStat(buf, stat))
				}
			}
			r := map[string]interface{}{
				"start_utc":         sgdUTC(base + int64(s)*sec),
				"minutes_with_data": len(idx),
				"db":                cells,
			}
			if len(floors) > 0 {
				r["noise_floor_db"] = sgdNum(sgdStat(floors, "mean"))
			}
			rowsOut = append(rowsOut, r)
		}
		stripKHz := float64(eb-sb) * w.binHz / float64(cols) / 1e3
		out := w.header("grid", sb, eb)
		out["stat"] = stat
		out["step_minutes"] = step
		out["columns"] = map[string]interface{}{
			"count":            cols,
			"first_centre_khz": roundTo((w.startHz+float64(sb)*w.binHz)/1e3+stripKHz/2, 3),
			"width_khz":        roundTo(stripKHz, 3),
			"note":             "db[c] is the stat over every minute and bin in strip c for that step; noise_floor_db is the step's mean of each minute's 5th percentile in the shown range; null = no data",
		}
		out["rows"] = rowsOut
		return out, nil
	}
}

// ── events ───────────────────────────────────────────────────────────────────

func (m *MCPServer) sgdEvents(a *mcpArgs, req sgdRequest) func() (interface{}, error) {
	thr := a.number("burst_threshold_db", 6, 1, 60)
	minSNR := a.number("min_snr_db", 10, 1, 100)
	maxItems := a.integer("max_items", 20, 0, 50)
	for _, k := range []string{"freqs_khz", "bandwidth_khz", "step_minutes", "freq_bins", "stat", "at", "minutes", "points"} {
		if a.has(k) {
			a.fail("%s does not apply to the events view", k)
		}
	}
	if a.Err() != nil {
		return nil
	}

	return func() (interface{}, error) {
		w, sb, eb, err := m.sgdOpen(req)
		if err != nil {
			return nil, err
		}
		out := w.header("events", sb, eb)
		gaps, nGaps := sgdGaps(w, maxItems)
		out["gaps"] = gaps
		out["gap_count"] = nGaps

		// Per-row median and floor over the shown range; per-bin median over time.
		n := len(w.rows)
		med := make([]float32, n)
		floor := make([]float32, n)
		buf := make([]float32, 0, eb-sb)
		var floorsAll []float32
		for i, row := range w.rows {
			med[i], floor[i] = float32(math.NaN()), float32(math.NaN())
			buf = buf[:0]
			for _, v := range row[sb:eb] {
				if sgdValid(v) {
					buf = append(buf, v)
				}
			}
			if len(buf) == 0 {
				continue
			}
			floor[i] = sgdSelect(buf, len(buf)*5/100)
			med[i] = sgdSelect(buf, len(buf)/2)
			floorsAll = append(floorsAll, floor[i])
		}
		colMed := make([]float32, eb-sb)
		col := make([]float32, 0, n)
		for b := sb; b < eb; b++ {
			col = col[:0]
			for _, row := range w.rows {
				if v := row[b]; sgdValid(v) {
					col = append(col, v)
				}
			}
			colMed[b-sb] = float32(math.NaN())
			if len(col) > 0 {
				colMed[b-sb] = sgdStat(col, "median")
			}
		}

		bursts, nBursts := sgdBursts(w, sb, eb, med, colMed, thr, maxItems)
		out["bursts"] = bursts
		out["burst_count"] = nBursts
		out["burst_threshold_db"] = thr

		if len(floorsAll) > 0 {
			typical := sgdStat(floorsAll, "median")
			out["typical_noise_floor_db"] = sgdNum(typical)
			carriers, signals := sgdSignals(w, sb, eb, floor, colMed, typical, minSNR, maxItems)
			out["carriers"] = carriers
			out["signals"] = signals
		}
		out["min_snr_db"] = minSNR
		out["notes"] = "gaps: minutes with no recording. bursts: minutes whose median level across the range rose burst_threshold_db above the surrounding half hour; broadband_pct is the share of bins raised at the peak minute (high = wideband noise or interference). carriers: frequencies at least min_snr_db above the floor for more than half the window. signals: frequencies above it for 5-50% of the window, with when they were first and last seen."
		return out, nil
	}
}

func sgdGaps(w *sgdWindow, maxItems int) ([]map[string]interface{}, int) {
	out := []map[string]interface{}{}
	count := 0
	add := func(from, to int64) {
		count++
		if len(out) < maxItems {
			out = append(out, map[string]interface{}{
				"from_utc": sgdUTC(from),
				"to_utc":   sgdUTC(to),
				"minutes":  (to-from)/60 + 1,
			})
		}
	}
	start := int64(-1)
	for i := range w.rows {
		t := w.meta[i].Unix
		if i > 0 && start < 0 && t-w.meta[i-1].Unix > 90 {
			add(w.meta[i-1].Unix+60, t-60) // minutes missing from the recording entirely
		}
		if !rowHasData(w.rows[i]) {
			if start < 0 {
				start = t
			}
			continue
		}
		if start >= 0 {
			add(start, w.meta[i-1].Unix)
			start = -1
		}
	}
	if start >= 0 {
		add(start, w.meta[len(w.meta)-1].Unix)
	}
	return out, count
}

func sgdBursts(w *sgdWindow, sb, eb int, med, colMed []float32, thr float64, maxItems int) ([]map[string]interface{}, int) {
	n := len(med)
	excess := make([]float32, n)
	buf := make([]float32, 0, 2*sgdBurstHalfWindow+1)
	for i := range med {
		excess[i] = float32(math.NaN())
		if math.IsNaN(float64(med[i])) {
			continue
		}
		buf = buf[:0]
		for j := sgdMax(0, i-sgdBurstHalfWindow); j <= min(n-1, i+sgdBurstHalfWindow); j++ {
			if !math.IsNaN(float64(med[j])) {
				buf = append(buf, med[j])
			}
		}
		if len(buf) >= 5 {
			excess[i] = med[i] - sgdStat(buf, "median")
		}
	}
	type burst struct {
		from, to, peak int
	}
	var list []burst
	for i := 0; i < n; i++ {
		if !(float64(excess[i]) >= thr) {
			continue
		}
		b := burst{i, i, i}
		for i+1 < n && float64(excess[i+1]) >= thr {
			i++
			b.to = i
			if excess[i] > excess[b.peak] {
				b.peak = i
			}
		}
		list = append(list, b)
	}
	sort.Slice(list, func(i, j int) bool { return excess[list[i].peak] > excess[list[j].peak] })
	out := []map[string]interface{}{}
	for _, b := range list {
		if len(out) >= maxItems {
			break
		}
		raised, total := 0, 0
		for k, v := range w.rows[b.peak][sb:eb] {
			if sgdValid(v) && !math.IsNaN(float64(colMed[k])) {
				total++
				if float64(v-colMed[k]) >= thr {
					raised++
				}
			}
		}
		pct := 0.0
		if total > 0 {
			pct = roundTo(100*float64(raised)/float64(total), 0)
		}
		out = append(out, map[string]interface{}{
			"from_utc":       sgdUTC(w.meta[b.from].Unix),
			"to_utc":         sgdUTC(w.meta[b.to].Unix),
			"minutes":        b.to - b.from + 1,
			"peak_utc":       sgdUTC(w.meta[b.peak].Unix),
			"peak_excess_db": sgdNum(excess[b.peak]),
			"broadband_pct":  pct,
		})
	}
	return out, len(list)
}

// sgdSignals clusters adjacent bins by how often they stand minSNR above that
// minute's floor: steady carriers (more than half the window) and intermittent
// signals (5-50%).
func sgdSignals(w *sgdWindow, sb, eb int, floor, colMed []float32, typical float32, minSNR float64, maxItems int) ([]map[string]interface{}, []map[string]interface{}) {
	nb := eb - sb
	present := make([]int, nb)
	first := make([]int64, nb)
	last := make([]int64, nb)
	peak := make([]float32, nb)
	minutes := 0
	for i, row := range w.rows {
		if math.IsNaN(float64(floor[i])) {
			continue
		}
		minutes++
		for k, v := range row[sb:eb] {
			if sgdValid(v) && float64(v-floor[i]) >= minSNR {
				if present[k] == 0 {
					first[k] = w.meta[i].Unix
					peak[k] = v
				}
				present[k]++
				last[k] = w.meta[i].Unix
				peak[k] = sgdMax(peak[k], v)
			}
		}
	}
	if minutes == 0 {
		return []map[string]interface{}{}, []map[string]interface{}{}
	}
	frac := func(k int) float64 { return float64(present[k]) / float64(minutes) }

	// cluster groups runs of bins passing keep, allowing a one-bin gap, and
	// reports the bin that ranks highest within each.
	type cl struct{ lo, hi, best int }
	cluster := func(keep func(int) bool, better func(a, b int) bool) []cl {
		var out []cl
		for k := 0; k < nb; k++ {
			if !keep(k) {
				continue
			}
			c := cl{k, k, k}
			for k+1 < nb && (keep(k+1) || (k+2 < nb && keep(k+2))) {
				k++
				if keep(k) {
					c.hi = k
					if better(k, c.best) {
						c.best = k
					}
				}
			}
			out = append(out, c)
		}
		return out
	}

	steady := cluster(func(k int) bool { return frac(k) > 0.5 },
		func(a, b int) bool { return colMed[a] > colMed[b] })
	sort.Slice(steady, func(i, j int) bool { return colMed[steady[i].best] > colMed[steady[j].best] })
	carriers := []map[string]interface{}{}
	for _, c := range steady {
		if len(carriers) >= maxItems {
			break
		}
		carriers = append(carriers, map[string]interface{}{
			"freq_khz":    roundTo(w.binCentreKHz(sb+c.best), 3),
			"width_khz":   roundTo(float64(c.hi-c.lo+1)*w.binHz/1e3, 3),
			"median_db":   sgdNum(colMed[c.best]),
			"snr_db":      sgdNum(colMed[c.best] - typical),
			"present_pct": roundTo(100*frac(c.best), 0),
		})
	}

	inter := cluster(func(k int) bool { f := frac(k); return f >= 0.05 && f <= 0.5 },
		func(a, b int) bool { return present[a] > present[b] })
	sort.Slice(inter, func(i, j int) bool { return present[inter[i].best] > present[inter[j].best] })
	signals := []map[string]interface{}{}
	for _, c := range inter {
		if len(signals) >= maxItems {
			break
		}
		k := c.best
		signals = append(signals, map[string]interface{}{
			"freq_khz":       roundTo(w.binCentreKHz(sb+k), 3),
			"width_khz":      roundTo(float64(c.hi-c.lo+1)*w.binHz/1e3, 3),
			"present_pct":    roundTo(100*frac(k), 0),
			"peak_db":        sgdNum(peak[k]),
			"first_seen_utc": sgdUTC(first[k]),
			"last_seen_utc":  sgdUTC(last[k]),
		})
	}
	return carriers, signals
}

// sgdMax is the built-in max, which this package shadows with a float64-only
// version in rotctl.go.
func sgdMax[T cmp.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}
