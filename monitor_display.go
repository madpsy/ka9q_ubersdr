package main

// monitor_display.go — cycles key server metrics through a Pimoroni Galactic
// Unicorn (or compatible) LED matrix display using the gudriver sub-package.
//
// When config.MonitorDisplay.Enabled is true, a background goroutine starts
// that rotates through a set of "slides" every SlideDuration seconds.
//
// Layout
// ──────
// Most slides use a two-line layout at size=1 (6 px per line):
//
//	Line 0 (top, static)    — short category label left + "N/MAX" user count right
//	Line 1 (bottom, scroll) — metric value; scrolls once if wider than 53 px
//
// The clock slide is a special case: a single centred line showing HH:MM:SS
// at size=1, updated every second.  No label — the format is self-evident.
//
// The band-conditions slide uses the segments feature to colour each band name
// individually (lime = good/excellent, amber = fair).
//
// Colour coding follows the same green/amber/red convention used in the admin
// monitor tab:
//
//	lime   — ok / normal
//	amber  — warning
//	red    — critical / error
//
// The module is intentionally self-contained: it only depends on the exported
// interfaces of SessionManager, NoiseFloorMonitor, and the gudriver package.

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cwsl/ka9q_ubersdr/gudriver"
)

// monitorClockUpdateInterval is how often the clock slide re-sends its time.
const monitorClockUpdateInterval = time.Second

// ─── Tunables ─────────────────────────────────────────────────────────────────

const (
	// monitorSlideDuration is how long each slide is shown before advancing.
	monitorSlideDuration = 12 * time.Second

	// monitorBandSlideDuration is the duration for each band-conditions page.
	monitorBandSlideDuration = 6 * time.Second

	// monitorRetryDelay is the back-off between failed display attempts.
	monitorRetryDelay = 30 * time.Second

	// monitorScrollSpeed is pixels/second for the scrolling bottom line.
	monitorScrollSpeed = 38

	// monitorScrollPause is the pause (seconds) before the scroll starts.
	monitorScrollPause = 0.8

	// monitorPriority is the display queue priority for monitor slides.
	// Lower than notification alerts (which use 7–10) so they don't interrupt.
	monitorPriority = 3

	// monitorMessageID is the stable ID used for all monitor slides so each
	// new slide replaces the previous one in-place without queuing.
	monitorMessageID = "monitor-display"

	// monitorTopLineWidth is the character budget for the top status line.
	// At size=1 the bitmap6 font averages ~5 px/char; 10 chars ≈ 50 px which
	// fits comfortably in the 53 px display without scrolling.
	monitorTopLineWidth = 10

	// monitorBandsPerLine is the number of band labels that fit on one line
	// without scrolling.  "80 40 30" = 8 chars × 6 px = 48 px ≤ 53 px.
	monitorBandsPerLine = 3
)

// ─── Colour helpers ───────────────────────────────────────────────────────────

// statusColor maps a status string ("ok", "warning", "critical", "unknown")
// to a named display colour.
func statusColor(status string) string {
	switch strings.ToLower(status) {
	case "ok":
		return "lime"
	case "warning":
		return "amber"
	case "critical":
		return "red"
	default:
		return "white"
	}
}

// ─── Top-line helpers ─────────────────────────────────────────────────────────

// formatTopLine builds the 8-character top status line:
// label is left-aligned, right is right-aligned, padded with spaces between.
// Both are truncated if they would overflow the budget.
func formatTopLine(label, right string) string {
	total := monitorTopLineWidth
	// Ensure label + right fit with at least one space between them.
	maxLabel := total - len(right) - 1
	if maxLabel < 0 {
		maxLabel = 0
	}
	if len(label) > maxLabel {
		label = label[:maxLabel]
	}
	pad := total - len(label) - len(right)
	if pad < 0 {
		pad = 0
	}
	return label + strings.Repeat(" ", pad) + right
}

// userCountStr returns a compact "N/MAX" user count string.
func userCountStr(sessions *SessionManager, maxSessions int) string {
	regular := sessions.GetNonBypassedUserCount()
	return fmt.Sprintf("%d/%d", regular, maxSessions)
}

// ─── Slide builders ───────────────────────────────────────────────────────────

// monitorSlide is a single display frame.
type monitorSlide struct {
	// Two-line layout fields (used when singleLine is false):
	topLine       string             // top line text (label + user count), static
	topColor      string             // colour for the top line
	topSegments   []gudriver.Segment // when non-nil, top line uses multi-colour segments
	value         string             // bottom line — metric value, may scroll
	valueColor    string             // colour for the value
	valueSegments []gudriver.Segment // when non-nil, used instead of value+valueColor

	// Single-line layout (clock):
	singleLine bool // when true, render only value centred on the full display
	isClock    bool // when true, re-sent every second with the current time

	// transition is the display transition for this slide.
	// Defaults to TransitionCut (instantaneous) when empty.
	// Set to TransitionFade for slide-to-slide transitions.
	transition string

	// displayDuration overrides the global monitorSlideDuration for this slide.
	// Zero means use the global default.
	displayDuration time.Duration
}

// buildUsersSlide returns a slide showing current / max user counts.
func buildUsersSlide(sessions *SessionManager, maxSessions int) monitorSlide {
	regular := sessions.GetNonBypassedUserCount()
	bypassed := sessions.GetBypassedUserCount()
	free := maxSessions - regular
	if free < 0 {
		free = 0
	}

	var valueColor string
	switch {
	case regular >= maxSessions:
		valueColor = "red"
	case regular >= maxSessions*3/4:
		valueColor = "amber"
	default:
		valueColor = "lime"
	}

	var value string
	if bypassed > 0 {
		value = fmt.Sprintf("%d/%d users (%d free, %d admin)", regular, maxSessions, free, bypassed)
	} else {
		value = fmt.Sprintf("%d/%d users (%d free)", regular, maxSessions, free)
	}

	// Users slide: top line shows "USER" label; user count is already in the value.
	topLine := formatTopLine("USER", fmt.Sprintf("%d/%d", regular, maxSessions))

	return monitorSlide{
		topLine:    topLine,
		topColor:   valueColor,
		value:      value,
		valueColor: valueColor,
		transition: gudriver.TransitionFade,
	}
}

// buildTimeSlide returns a clock slide: single centred line showing HH:MM:SS.
// No label — the format is self-evident.  Marked isClock=true so the
// sequencer refreshes it every second.
func buildTimeSlide() monitorSlide {
	now := time.Now().UTC()
	return monitorSlide{
		value:      now.Format("15:04:05"),
		valueColor: "cyan",
		singleLine: true,
		isClock:    true,
	}
}

// loadColor returns a colour for a load value relative to core count.
// ≥ cores = red, ≥ 75% cores = amber, otherwise lime.
func loadColor(load float64, cores int) string {
	if cores <= 0 {
		return "white"
	}
	switch {
	case load >= float64(cores):
		return "red"
	case load >= float64(cores)*0.75:
		return "amber"
	default:
		return "lime"
	}
}

// buildLoadSlide returns a slide showing load averages, colour-coded per value.
// Bottom line uses segments: 5m value in status colour, 1m value in its own
// colour, core count in white — all compact with no redundant labels.
func buildLoadSlide(sessions *SessionManager, maxSessions int) monitorSlide {
	data := getSystemLoad()

	load5, _ := strconv.ParseFloat(fmt.Sprintf("%v", data["load_5min"]), 64)
	load1, _ := strconv.ParseFloat(fmt.Sprintf("%v", data["load_1min"]), 64)
	cores, _ := data["cpu_cores"].(int)
	status, _ := data["status"].(string)
	topColor := statusColor(status)

	// Build colour-coded segments: "0.42 " (5m colour) + "0.38" (1m colour) + " /4c" (white)
	segs := []gudriver.Segment{
		{Text: fmt.Sprintf("%.2f ", load5), Color: loadColor(load5, cores)},
		{Text: fmt.Sprintf("%.2f", load1), Color: loadColor(load1, cores)},
	}
	if cores > 0 {
		segs = append(segs, gudriver.Segment{Text: fmt.Sprintf(" /%dc", cores), Color: "white"})
	}

	return monitorSlide{
		topLine:       formatTopLine("LOAD", userCountStr(sessions, maxSessions)),
		topColor:      topColor,
		valueSegments: segs,
		transition:    gudriver.TransitionFade,
	}
}

// buildCPUTempSlide returns a slide showing CPU temperature, colour-coded.
// Returns nil if temperature is not available.
// Bottom line uses segments: temperature value in status colour, threshold in white.
func buildCPUTempSlide(sessions *SessionManager, maxSessions int) *monitorSlide {
	data := getSystemLoad()

	avail, _ := data["cpu_temp_available"].(bool)
	if !avail {
		return nil
	}

	tempC, _ := data["cpu_temp_c"].(float64)
	threshold, _ := data["cpu_temp_threshold_c"].(float64)
	tempStatus, _ := data["cpu_temp_status"].(string)
	color := statusColor(tempStatus)

	// Colour-coded segments: temperature in status colour, limit in white.
	segs := []gudriver.Segment{
		{Text: fmt.Sprintf("%.0fC", tempC), Color: color},
	}
	if threshold > 0 {
		segs = append(segs, gudriver.Segment{Text: fmt.Sprintf(" /%.0fC", threshold), Color: "white"})
	}

	return &monitorSlide{
		topLine:       formatTopLine("TEMP", userCountStr(sessions, maxSessions)),
		topColor:      color,
		valueSegments: segs,
		transition:    gudriver.TransitionFade,
	}
}

// buildPSKSlide returns a slide showing PSKReporter rank for the given callsign.
// Returns nil when no data is available or the callsign is not ranked.
func buildPSKSlide(psk *PSKRankFetcher, callsign string, sessions *SessionManager, maxSessions int) *monitorSlide {
	if psk == nil || callsign == "" {
		return nil
	}
	data := psk.Cached()
	if data == nil || data.Error != "" {
		return nil
	}

	reportRanks := computeCallsignRank(data.ReportResult, callsign)
	countryRanks := computeCallsignRank(data.CountryResult, callsign)

	allReport, hasReport := reportRanks["All"]
	allCountry, hasCountry := countryRanks["All"]

	if !hasReport && !hasCountry {
		return nil
	}

	// Colour by report rank: top 10 = lime, top 50 = amber, otherwise white.
	topColor := "white"
	if hasReport {
		switch {
		case allReport.Rank <= 10:
			topColor = "lime"
		case allReport.Rank <= 50:
			topColor = "amber"
		}
	}

	// Build segments: rank label in white, daily count in blue.
	// e.g. ["#3 spots", " (120/day)  ", "#7 countries", " (45/day)", " (5m ago)"]
	var segs []gudriver.Segment
	if hasReport {
		segs = append(segs,
			gudriver.Segment{Text: fmt.Sprintf("#%d spots", allReport.Rank), Color: "white"},
			gudriver.Segment{Text: fmt.Sprintf(" (%d/day)", allReport.Day), Color: "blue"},
		)
	}
	if hasCountry {
		if hasReport {
			segs = append(segs, gudriver.Segment{Text: "  ", Color: "blue"})
		}
		segs = append(segs,
			gudriver.Segment{Text: fmt.Sprintf("#%d countries", allCountry.Rank), Color: "white"},
			gudriver.Segment{Text: fmt.Sprintf(" (%d/day)", allCountry.Day), Color: "blue"},
		)
	}
	if !data.FetchedAt.IsZero() {
		mins := int(time.Since(data.FetchedAt).Minutes())
		if mins > 0 {
			segs = append(segs, gudriver.Segment{Text: fmt.Sprintf(" (%dm ago)", mins), Color: "blue"})
		}
	}

	return &monitorSlide{
		topLine:       formatTopLine("PSK", userCountStr(sessions, maxSessions)),
		topColor:      topColor,
		valueSegments: segs,
		transition:    gudriver.TransitionFade,
	}
}

// ─── Slide sequencer ──────────────────────────────────────────────────────────

// collectSlides assembles the full ordered list of slides for one rotation.
func collectSlides(sessions *SessionManager, nfm *NoiseFloorMonitor, psk *PSKRankFetcher, callsign string, maxSessions int) []monitorSlide {
	var slides []monitorSlide

	// 1. UTC clock (single centred line, no label)
	slides = append(slides, buildTimeSlide())

	// 2. Users
	slides = append(slides, buildUsersSlide(sessions, maxSessions))

	// 3. Load average
	slides = append(slides, buildLoadSlide(sessions, maxSessions))

	// 4. CPU temperature (optional — omitted if not available)
	if s := buildCPUTempSlide(sessions, maxSessions); s != nil {
		slides = append(slides, *s)
	}

	// 5. PSK Reporter rank (optional — omitted if fetcher not wired or callsign not ranked)
	if s := buildPSKSlide(psk, callsign, sessions, maxSessions); s != nil {
		slides = append(slides, *s)
	}

	// 6. Band conditions — one or two pages, 3 bands per line, each coloured.
	slides = append(slides, buildBandConditionsSlides(nfm)...)

	return slides
}

// buildBandConditionsSlides returns one or two slides showing all non-POOR bands
// with per-band colour coding.  Bands are sorted descending by wavelength
// (80m before 40m before 20m) so lower bands appear first.
//
// Layout: 3 bands per line (fits in 53 px without scrolling), 2 lines per slide.
// If more than 6 bands qualify, a second slide is produced.
// Each band label is the numeric part only (e.g. "80 " not "80M ").
func buildBandConditionsSlides(nfm *NoiseFloorMonitor) []monitorSlide {
	if nfm == nil {
		return nil
	}
	measurements := nfm.GetLatestMeasurements()
	if len(measurements) == 0 {
		return nil
	}

	// Collect qualifying bands sorted by name (lexicographic gives 10m < 160m < 20m
	// which is wrong for display; we sort by numeric wavelength descending instead).
	type bandEntry struct {
		label string // e.g. "80 "
		color string // lime / amber
	}

	// Parse numeric value from band name for sorting (e.g. "80m" → 80).
	bandNum := func(b string) int {
		n := 0
		for _, c := range b {
			if c >= '0' && c <= '9' {
				n = n*10 + int(c-'0')
			} else {
				break
			}
		}
		return n
	}

	// Sort band names descending by wavelength (highest number = lowest freq first).
	allBands := make([]string, 0, len(measurements))
	for b := range measurements {
		allBands = append(allBands, b)
	}
	sort.Slice(allBands, func(i, j int) bool {
		return bandNum(allBands[i]) > bandNum(allBands[j])
	})

	var entries []bandEntry
	for _, band := range allBands {
		m := measurements[band]
		if m == nil {
			continue
		}
		if time.Since(m.Timestamp) > 10*time.Minute {
			continue
		}
		if m.FT8SNR <= 0 {
			continue
		}
		quality := BandSNRQuality(m.FT8SNR)
		if quality == "POOR" {
			continue
		}
		// Strip "m" suffix for compact label: "80m" → "80 "
		label := strings.TrimSuffix(strings.ToUpper(band), "M") + " "
		color := BandSNRColor(quality)
		entries = append(entries, bandEntry{label: label, color: color})
	}

	if len(entries) == 0 {
		return nil
	}

	// Pack entries into pages: monitorBandsPerLine per line, 2 lines per page.
	bandsPerPage := monitorBandsPerLine * 2
	var slides []monitorSlide
	for pageStart := 0; pageStart < len(entries); pageStart += bandsPerPage {
		pageEnd := pageStart + bandsPerPage
		if pageEnd > len(entries) {
			pageEnd = len(entries)
		}
		page := entries[pageStart:pageEnd]

		// Split page into top and bottom lines.
		splitAt := monitorBandsPerLine
		if splitAt > len(page) {
			splitAt = len(page)
		}
		topSegs := make([]gudriver.Segment, splitAt)
		for i, e := range page[:splitAt] {
			topSegs[i] = gudriver.Segment{Text: e.label, Color: e.color}
		}
		var botSegs []gudriver.Segment
		if len(page) > splitAt {
			botSegs = make([]gudriver.Segment, len(page)-splitAt)
			for i, e := range page[splitAt:] {
				botSegs[i] = gudriver.Segment{Text: e.label, Color: e.color}
			}
		}

		slides = append(slides, monitorSlide{
			topSegments:     topSegs,
			valueSegments:   botSegs,
			transition:      gudriver.TransitionFade,
			displayDuration: monitorBandSlideDuration,
		})
	}
	return slides
}

// ─── Display sender ───────────────────────────────────────────────────────────

// sendSlide pushes a single slide to the display.
// The transition defaults to TransitionCut (instantaneous) unless slide.transition
// is set explicitly — use TransitionFade for slide-to-slide transitions.
//
// All slides use duration="forever": the Go server controls timing by sending
// the next slide before the current one would expire, eliminating the blank-screen
// gap that occurs when the firmware auto-expires a timed message.
func sendSlide(client *gudriver.Client, slide monitorSlide) error {
	transition := slide.transition
	if transition == "" {
		transition = gudriver.TransitionCut
	}

	// ── Clock / single-line layout ────────────────────────────────────────────
	if slide.singleLine {
		cmd := gudriver.DisplayCommand{
			ID:         monitorMessageID,
			Priority:   monitorPriority,
			Duration:   gudriver.DurationForever(),
			Transition: transition,
			Lines: []gudriver.DisplayLine{
				{
					Text:   slide.value,
					Color:  slide.valueColor,
					Size:   1,
					Effect: gudriver.EffectStatic,
					Align:  gudriver.AlignCenter,
					Y:      "middle",
				},
			},
		}
		_, err := client.Display(cmd)
		return err
	}

	// ── Dual-segment layout (band conditions with both tiers) ─────────────────
	if len(slide.topSegments) > 0 {
		cmd := gudriver.DisplayCommand{
			ID:         monitorMessageID,
			Priority:   monitorPriority,
			Duration:   gudriver.DurationForever(),
			Transition: transition,
			Lines: []gudriver.DisplayLine{
				{
					Segments:    slide.topSegments,
					Size:        1,
					Effect:      gudriver.EffectAuto,
					Y:           "top",
					ScrollSpeed: monitorScrollSpeed,
					ScrollPause: monitorScrollPause,
					ScrollLoop:  false,
					ScrollStart: gudriver.ScrollStartLeft,
				},
				{
					Segments:    slide.valueSegments,
					Size:        1,
					Effect:      gudriver.EffectAuto,
					Y:           "bottom",
					ScrollSpeed: monitorScrollSpeed,
					ScrollPause: monitorScrollPause,
					ScrollLoop:  true,
					ScrollStart: gudriver.ScrollStartLeft,
				},
			},
		}
		_, err := client.Display(cmd)
		return err
	}

	// ── Standard two-line layout ──────────────────────────────────────────────
	bottomLine := gudriver.DisplayLine{
		Size:        1,
		Effect:      gudriver.EffectAuto,
		Y:           "bottom",
		ScrollSpeed: monitorScrollSpeed,
		ScrollPause: monitorScrollPause,
		ScrollLoop:  true,
		ScrollStart: gudriver.ScrollStartLeft,
	}
	if len(slide.valueSegments) > 0 {
		bottomLine.Segments = slide.valueSegments
	} else {
		bottomLine.Text = slide.value
		bottomLine.Color = slide.valueColor
	}

	cmd := gudriver.DisplayCommand{
		ID:         monitorMessageID,
		Priority:   monitorPriority,
		Duration:   gudriver.DurationForever(),
		Transition: transition,
		Lines: []gudriver.DisplayLine{
			{
				// Top line: static label + user count
				Text:   slide.topLine,
				Color:  slide.topColor,
				Size:   1,
				Effect: gudriver.EffectStatic,
				Align:  gudriver.AlignLeft,
				Y:      "top",
			},
			bottomLine,
		},
	}

	_, err := client.Display(cmd)
	return err
}

// ─── MonitorDisplay ───────────────────────────────────────────────────────────

// MonitorDisplay drives the LED matrix display with cycling metric slides.
type MonitorDisplay struct {
	client      *gudriver.Client
	displayURL  string // stored for log messages
	sessions    *SessionManager
	nfm         *NoiseFloorMonitor
	pskRank     *PSKRankFetcher
	callsign    string // receiver callsign for PSK rank lookup
	maxSessions int
	cancel      context.CancelFunc
}

// NewMonitorDisplay creates a MonitorDisplay from the given config.
// Returns nil (with no error) when config.MonitorDisplay.Enabled is false.
//
// psk may be nil — PSK rank slides are simply omitted when no fetcher is wired.
// callsign is the receiver callsign used for PSK rank lookups (e.g. config.Decoder.ReceiverCallsign).
func NewMonitorDisplay(cfg *Config, sessions *SessionManager, nfm *NoiseFloorMonitor, psk *PSKRankFetcher, callsign string) *MonitorDisplay {
	if !cfg.MonitorDisplay.Enabled {
		return nil
	}
	if cfg.MonitorDisplay.URL == "" {
		log.Printf("[MonitorDisplay] No URL configured — display disabled")
		return nil
	}

	opts := []gudriver.Option{
		gudriver.WithUserAgent("ubersdr-monitor/1.0"),
	}
	if cfg.MonitorDisplay.TimeoutSeconds > 0 {
		opts = append(opts, gudriver.WithTimeout(time.Duration(cfg.MonitorDisplay.TimeoutSeconds)*time.Second))
	}
	if cfg.MonitorDisplay.InsecureSkipVerify {
		opts = append(opts, gudriver.WithInsecureSkipVerify())
	}

	maxSessions := cfg.Server.MaxSessions
	if maxSessions <= 0 {
		maxSessions = 20 // sensible fallback
	}

	return &MonitorDisplay{
		client:      gudriver.NewClient(cfg.MonitorDisplay.URL, opts...),
		displayURL:  cfg.MonitorDisplay.URL,
		sessions:    sessions,
		nfm:         nfm,
		pskRank:     psk,
		callsign:    callsign,
		maxSessions: maxSessions,
	}
}

// Start launches the background slide-cycling goroutine.
// It is a no-op when md is nil.
func (md *MonitorDisplay) Start(ctx context.Context) {
	if md == nil {
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	md.cancel = cancel

	go md.run(ctx)
	log.Printf("[MonitorDisplay] Started (url: %s, slide interval: %s)",
		md.displayURL, monitorSlideDuration)
}

// Stop cancels the background goroutine and clears the display.
// It is a no-op when md is nil.
func (md *MonitorDisplay) Stop() {
	if md == nil {
		return
	}
	if md.cancel != nil {
		md.cancel()
	}
	// Best-effort clear — ignore errors on shutdown.
	_, _ = md.client.CancelMessage(monitorMessageID)
}

// run is the main loop: collect slides, send each one, advance after the slide
// duration, then repeat.
func (md *MonitorDisplay) run(ctx context.Context) {
	slideIndex := 0

	for {
		if ctx.Err() != nil {
			return
		}
		md.sendNext(ctx, &slideIndex)
	}
}

// sendNext collects the current slide list, picks the next slide, sends it,
// then waits for monitorSlideDuration before returning.
//
// Clock slides are special: they re-send every second with the updated time
// for the full slide duration, so the display always shows the current second.
func (md *MonitorDisplay) sendNext(ctx context.Context, idx *int) {
	slides := collectSlides(md.sessions, md.nfm, md.pskRank, md.callsign, md.maxSessions)
	if len(slides) == 0 {
		select {
		case <-ctx.Done():
		case <-time.After(monitorSlideDuration):
		}
		return
	}

	if *idx >= len(slides) {
		*idx = 0
	}
	slide := slides[*idx]
	*idx = (*idx + 1) % len(slides)

	if slide.isClock {
		md.runClockSlide(ctx)
		return
	}

	if err := sendSlide(md.client, slide); err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Printf("[MonitorDisplay] Failed to send slide %q: %v", slide.topLine, err)
	}

	// Wait for this slide's display duration before advancing to the next.
	// Using slide.displayDuration when set (e.g. band-condition pages = 6s),
	// otherwise the global monitorSlideDuration.
	wait := slide.displayDuration
	if wait <= 0 {
		wait = monitorSlideDuration
	}
	select {
	case <-ctx.Done():
	case <-time.After(wait):
	}
}

// runClockSlide shows the UTC clock for monitorSlideDuration, updating every
// second so the seconds digit ticks in real time.
func (md *MonitorDisplay) runClockSlide(ctx context.Context) {
	deadline := time.Now().Add(monitorSlideDuration)
	ticker := time.NewTicker(monitorClockUpdateInterval)
	defer ticker.Stop()

	sendClock := func() {
		slide := buildTimeSlide()
		if err := sendSlide(md.client, slide); err != nil && ctx.Err() == nil {
			log.Printf("[MonitorDisplay] Clock slide send error: %v", err)
		}
	}
	sendClock()

	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			if t.After(deadline) {
				return
			}
			sendClock()
		}
	}
}
