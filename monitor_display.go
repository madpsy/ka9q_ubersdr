package main

// monitor_display.go — cycles key server metrics through a Pimoroni Galactic
// Unicorn (or compatible) LED matrix display using the gudriver sub-package.
//
// When config.MonitorDisplay.Enabled is true, a background goroutine starts
// that rotates through a set of "slides" every SlideDuration seconds.  Each
// slide uses the 2-line layout supported by the bitmap6 font at size=1:
//
//	Line 0 (top, static)    — category label, e.g. "USERS"
//	Line 1 (bottom, scroll) — value string, e.g. "3 of 20 regular (17 free)"
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

// ─── Slide builders ───────────────────────────────────────────────────────────

// monitorSlide is a single display frame: a label line and a value line.
type monitorSlide struct {
	label      string // top line — short category name, static
	value      string // bottom line — metric value, scrolling
	labelColor string // named colour for the label
	valueColor string // named colour for the value
	isClock    bool   // when true, the slide is re-sent every second with the current time
}

// buildUsersSlide returns a slide showing current / max user counts.
func buildUsersSlide(sessions *SessionManager, maxSessions int) monitorSlide {
	regular := sessions.GetNonBypassedUserCount()
	bypassed := sessions.GetBypassedUserCount()
	total := regular + bypassed
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
		value = fmt.Sprintf("%d of %d users (%d free, %d admin)", regular, maxSessions, free, bypassed)
	} else {
		value = fmt.Sprintf("%d of %d users (%d free)", regular, maxSessions, free)
	}
	_ = total

	return monitorSlide{
		label:      "USERS",
		value:      value,
		labelColor: valueColor,
		valueColor: valueColor,
	}
}

// buildTimeSlide returns a slide that shows the current UTC time (HH:MM:SS).
// The slide is marked isClock=true so the sequencer refreshes it every second.
func buildTimeSlide() monitorSlide {
	now := time.Now().UTC()
	return monitorSlide{
		label:      "UTC TIME",
		value:      now.Format("15:04:05  Mon 02 Jan 2006"),
		labelColor: "cyan",
		valueColor: "white",
		isClock:    true,
	}
}

// buildLoadSlide returns a slide showing the 5-minute load average.
func buildLoadSlide() monitorSlide {
	data := getSystemLoad()

	load5, _ := strconv.ParseFloat(fmt.Sprintf("%v", data["load_5min"]), 64)
	load1, _ := strconv.ParseFloat(fmt.Sprintf("%v", data["load_1min"]), 64)
	cores, _ := data["cpu_cores"].(int)
	status, _ := data["status"].(string)

	var coresStr string
	if cores > 0 {
		coresStr = fmt.Sprintf(" / %d cores", cores)
	}

	value := fmt.Sprintf("5m: %.2f  1m: %.2f%s", load5, load1, coresStr)
	color := statusColor(status)

	return monitorSlide{
		label:      "LOAD AVG",
		value:      value,
		labelColor: color,
		valueColor: color,
	}
}

// buildCPUTempSlide returns a slide showing CPU temperature.
// Returns nil if temperature is not available.
func buildCPUTempSlide() *monitorSlide {
	data := getSystemLoad()

	avail, _ := data["cpu_temp_available"].(bool)
	if !avail {
		return nil
	}

	tempC, _ := data["cpu_temp_c"].(float64)
	threshold, _ := data["cpu_temp_threshold_c"].(float64)
	tempStatus, _ := data["cpu_temp_status"].(string)
	driver, _ := data["cpu_temp_driver"].(string)

	var threshStr string
	if threshold > 0 {
		threshStr = fmt.Sprintf(" / %.0f°C limit", threshold)
	}
	var driverStr string
	if driver != "" {
		driverStr = fmt.Sprintf(" [%s]", driver)
	}

	value := fmt.Sprintf("%.1f°C%s%s", tempC, threshStr, driverStr)
	color := statusColor(tempStatus)

	return &monitorSlide{
		label:      "CPU TEMP",
		value:      value,
		labelColor: color,
		valueColor: color,
	}
}

// buildPSKSlide returns a slide showing PSKReporter rank for the given callsign.
// Returns nil when no data is available or the callsign is not ranked.
func buildPSKSlide(psk *PSKRankFetcher, callsign string) *monitorSlide {
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
		label:      "PSK RANK",
		value:      strings.Join(parts, "  ") + age,
		labelColor: color,
		valueColor: color,
	}
}

// buildNoiseFloorSlides returns one slide per band that has a recent
// measurement, sorted by band name.  Bands with no FT8 SNR data are still
// shown using the P5 noise floor estimate.
func buildNoiseFloorSlides(nfm *NoiseFloorMonitor) []monitorSlide {
	if nfm == nil {
		return nil
	}
	measurements := nfm.GetLatestMeasurements()
	if len(measurements) == 0 {
		return nil
	}

	// Sort band names for a consistent slide order.
	bands := make([]string, 0, len(measurements))
	for b := range measurements {
		bands = append(bands, b)
	}
	sort.Strings(bands)

	slides := make([]monitorSlide, 0, len(bands))
	for _, band := range bands {
		m := measurements[band]
		if m == nil {
			continue
		}

		// Skip stale measurements (older than 10 minutes).
		if time.Since(m.Timestamp) > 10*time.Minute {
			continue
		}

		var parts []string

		// Noise floor (5th percentile).
		parts = append(parts, fmt.Sprintf("NF: %.0fdBm", m.P5DB))

		// FT8 SNR if meaningful (> -30 dB is a real measurement).
		if m.FT8SNR > -30 {
			parts = append(parts, fmt.Sprintf("FT8 SNR: %.0fdB", m.FT8SNR))
		}

		// Dynamic range.
		if m.DynamicRange > 0 {
			parts = append(parts, fmt.Sprintf("DR: %.0fdB", m.DynamicRange))
		}

		// Occupancy.
		if m.OccupancyPct >= 0 {
			parts = append(parts, fmt.Sprintf("Occ: %.0f%%", m.OccupancyPct))
		}

		value := strings.Join(parts, "  ")

		// Colour by FT8 SNR quality: good propagation = lime, poor = amber.
		var color string
		switch {
		case m.FT8SNR > 10:
			color = "lime"
		case m.FT8SNR > 0:
			color = "amber"
		default:
			color = "white"
		}

		slides = append(slides, monitorSlide{
			label:      strings.ToUpper(band),
			value:      value,
			labelColor: "cyan",
			valueColor: color,
		})
	}
	return slides
}

// ─── Slide sequencer ──────────────────────────────────────────────────────────

// collectSlides assembles the full ordered list of slides for one rotation.
func collectSlides(sessions *SessionManager, nfm *NoiseFloorMonitor, psk *PSKRankFetcher, callsign string, maxSessions int) []monitorSlide {
	var slides []monitorSlide

	// 1. UTC clock
	slides = append(slides, buildTimeSlide())

	// 2. Users
	slides = append(slides, buildUsersSlide(sessions, maxSessions))

	// 3. Load average
	slides = append(slides, buildLoadSlide())

	// 4. CPU temperature (optional — omitted if not available)
	if s := buildCPUTempSlide(); s != nil {
		slides = append(slides, *s)
	}

	// 5. PSK Reporter rank (optional — omitted if fetcher not wired or callsign not ranked)
	if s := buildPSKSlide(psk, callsign); s != nil {
		slides = append(slides, *s)
	}

	// 6. Noise floor per band (optional — omitted if monitor not running)
	slides = append(slides, buildNoiseFloorSlides(nfm)...)

	return slides
}

// ─── Display sender ───────────────────────────────────────────────────────────

// sendSlide pushes a single slide to the display.
func sendSlide(client *gudriver.Client, slide monitorSlide) error {
	cmd := gudriver.DisplayCommand{
		ID:         monitorMessageID,
		Priority:   monitorPriority,
		Duration:   gudriver.DurationSeconds(float64(monitorSlideDuration) / float64(time.Second)),
		Transition: gudriver.TransitionFade,
		Lines: []gudriver.DisplayLine{
			{
				// Top line: static label
				Text:   slide.label,
				Color:  slide.labelColor,
				Size:   1,
				Effect: gudriver.EffectStatic,
				Align:  gudriver.AlignLeft,
				Y:      "top",
			},
			{
				// Bottom line: scrolling value
				Text:        slide.value,
				Color:       slide.valueColor,
				Size:        1,
				Effect:      gudriver.EffectAuto,
				Y:           "bottom",
				ScrollSpeed: monitorScrollSpeed,
				ScrollPause: monitorScrollPause,
				ScrollLoop:  true,
				ScrollStart: gudriver.ScrollStartRight,
			},
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
	// slideIndex tracks position across rotations so we don't restart from
	// slide 0 every time we rebuild the list.
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
		// Nothing to show — wait a bit and try again.
		select {
		case <-ctx.Done():
		case <-time.After(monitorSlideDuration):
		}
		return
	}

	// Wrap index.
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
		log.Printf("[MonitorDisplay] Failed to send slide %q: %v", slide.label, err)
	}

	// Wait for the slide duration before advancing.
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

	// Send immediately, then on each tick.
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
