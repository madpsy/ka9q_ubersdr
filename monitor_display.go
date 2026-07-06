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
	// At size=1 (6 px/char) this gives 48 px — fits in the 53 px display
	// without scrolling.
	monitorTopLineWidth = 8
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

	// Users slide: top line shows "USR" label; user count is already in the value.
	topLine := formatTopLine("USR", fmt.Sprintf("%d/%d", regular, maxSessions))

	return monitorSlide{
		topLine:    topLine,
		topColor:   valueColor,
		value:      value,
		valueColor: valueColor,
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
		{Text: fmt.Sprintf("%.1fC", tempC), Color: color},
	}
	if threshold > 0 {
		segs = append(segs, gudriver.Segment{Text: fmt.Sprintf(" /%.0fC", threshold), Color: "white"})
	}

	return &monitorSlide{
		topLine:       formatTopLine("TEMP", userCountStr(sessions, maxSessions)),
		topColor:      color,
		valueSegments: segs,
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

	var parts []string
	if hasReport {
		parts = append(parts, fmt.Sprintf("#%d spots (%d/day)", allReport.Rank, allReport.Day))
	}
	if hasCountry {
		parts = append(parts, fmt.Sprintf("#%d countries (%d/day)", allCountry.Rank, allCountry.Day))
	}

	// Colour by report rank: top 10 = lime, top 50 = amber, otherwise white.
	color := "white"
	if hasReport {
		switch {
		case allReport.Rank <= 10:
			color = "lime"
		case allReport.Rank <= 50:
			color = "amber"
		}
	}

	age := ""
	if !data.FetchedAt.IsZero() {
		mins := int(time.Since(data.FetchedAt).Minutes())
		if mins > 0 {
			age = fmt.Sprintf(" (%dm ago)", mins)
		}
	}

	return &monitorSlide{
		topLine:    formatTopLine("PSK", userCountStr(sessions, maxSessions)),
		topColor:   color,
		value:      strings.Join(parts, "  ") + age,
		valueColor: color,
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

	// 6. Band conditions — single slide with per-band colour segments.
	if s := buildBandConditionsSlideImpl(nfm, sessions, maxSessions); s != nil {
		slides = append(slides, *s)
	}

	return slides
}

// buildBandConditionsSlideImpl is the real implementation (the function above
// has a dead-code path that the compiler would reject; this one is clean).
func buildBandConditionsSlideImpl(nfm *NoiseFloorMonitor, sessions *SessionManager, maxSessions int) *monitorSlide {
	if nfm == nil {
		return nil
	}
	measurements := nfm.GetLatestMeasurements()
	if len(measurements) == 0 {
		return nil
	}

	bands := make([]string, 0, len(measurements))
	for b := range measurements {
		bands = append(bands, b)
	}
	sort.Strings(bands)

	var goodSegs []gudriver.Segment
	var fairSegs []gudriver.Segment

	for _, band := range bands {
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
		label := strings.ToUpper(band) + " "
		switch quality {
		case "EXCELLENT", "GOOD":
			goodSegs = append(goodSegs, gudriver.Segment{Text: label, Color: "lime"})
		case "FAIR":
			fairSegs = append(fairSegs, gudriver.Segment{Text: label, Color: "amber"})
		}
	}

	if len(goodSegs) == 0 && len(fairSegs) == 0 {
		return nil
	}

	uCount := userCountStr(sessions, maxSessions)

	if len(goodSegs) == 0 {
		return &monitorSlide{
			topLine:       formatTopLine("BANDS", uCount),
			topColor:      "amber",
			valueSegments: fairSegs,
		}
	}
	if len(fairSegs) == 0 {
		return &monitorSlide{
			topLine:       formatTopLine("BANDS", uCount),
			topColor:      "lime",
			valueSegments: goodSegs,
		}
	}

	// Both tiers: top line = good bands (lime), bottom line = fair bands (amber).
	// Use a dedicated dualSegments slide type via the topSegments field.
	return &monitorSlide{
		topSegments:   goodSegs,
		valueSegments: fairSegs,
	}
}

// ─── Display sender ───────────────────────────────────────────────────────────

// sendSlide pushes a single slide to the display.
func sendSlide(client *gudriver.Client, slide monitorSlide) error {
	durationSecs := gudriver.DurationSeconds(float64(monitorSlideDuration) / float64(time.Second))

	// ── Clock / single-line layout ────────────────────────────────────────────
	if slide.singleLine {
		cmd := gudriver.DisplayCommand{
			ID:         monitorMessageID,
			Priority:   monitorPriority,
			Duration:   durationSecs,
			Transition: gudriver.TransitionFade,
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
			Duration:   durationSecs,
			Transition: gudriver.TransitionFade,
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
					ScrollLoop:  false,
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
		ScrollLoop:  false,
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
		Duration:   durationSecs,
		Transition: gudriver.TransitionFade,
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

	select {
	case <-ctx.Done():
	case <-time.After(monitorSlideDuration):
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
