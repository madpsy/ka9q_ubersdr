package main

import (
	"bytes"
	"fmt"
	"log"
	"strings"
	"sync"
	"text/template"
	"time"
)

// NotificationChannel is the interface that every output channel must implement.
// Adding a new channel type (email, Matrix, ntfy, …) only requires implementing
// this interface and registering it in NotificationManager.buildChannels().
type NotificationChannel interface {
	// Send delivers a pre-rendered message to the channel.
	// The implementation is responsible for its own retries / error handling.
	Send(message string) error
	// Name returns the human-readable channel name for logging.
	Name() string
	// Type returns the channel type string (e.g. "telegram").
	Type() string
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

// rateLimitKey uniquely identifies a (rule, subject) pair for rate limiting.
type rateLimitKey struct {
	ruleName string
	subject  string // callsign+band, component name, IP, etc.
}

type rateLimitEntry struct {
	lastSent time.Time
}

// notifRateLimiter tracks per-(rule,subject) send times.
type notifRateLimiter struct {
	mu      sync.Mutex
	entries map[rateLimitKey]rateLimitEntry
}

func newNotifRateLimiter() *notifRateLimiter {
	return &notifRateLimiter{entries: make(map[rateLimitKey]rateLimitEntry)}
}

// allow returns true if the (rule, subject) pair may fire now, and records the
// send time. limitMinutes == 0 means unlimited (always allow).
func (rl *notifRateLimiter) allow(key rateLimitKey, limitMinutes int) bool {
	if limitMinutes <= 0 {
		return true
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	entry := rl.entries[key]
	if time.Since(entry.lastSent) < time.Duration(limitMinutes)*time.Minute {
		return false
	}
	rl.entries[key] = rateLimitEntry{lastSent: time.Now()}
	return true
}

// cleanup removes entries older than maxAge to prevent unbounded growth.
func (rl *notifRateLimiter) cleanup(maxAge time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	for k, v := range rl.entries {
		if v.lastSent.Before(cutoff) {
			delete(rl.entries, k)
		}
	}
}

// ─── Stats ────────────────────────────────────────────────────────────────────

// NotificationStats holds runtime counters for the admin API.
type NotificationStats struct {
	TotalPublished   int64            `json:"total_published"`
	TotalMatched     int64            `json:"total_matched"`
	TotalSent        int64            `json:"total_sent"`
	TotalErrors      int64            `json:"total_errors"`
	TotalRateLimited int64            `json:"total_rate_limited"`
	ByRule           map[string]int64 `json:"by_rule"`
	ByChannel        map[string]int64 `json:"by_channel"`
	LastSentAt       *time.Time       `json:"last_sent_at,omitempty"`
	LastError        string           `json:"last_error,omitempty"`
	LastErrorAt      *time.Time       `json:"last_error_at,omitempty"`
}

// ─── Manager ──────────────────────────────────────────────────────────────────

// NotificationManager is the central hub. Sources call Publish() with a typed
// event; the manager evaluates all rules, renders templates, applies rate
// limiting, and dispatches to the configured channels.
type NotificationManager struct {
	cfg      *NotificationsConfig
	channels map[string]NotificationChannel // keyed by channel name
	tmpls    map[string]*template.Template  // keyed by rule name
	rl       *notifRateLimiter
	funcMap  template.FuncMap

	mu    sync.RWMutex
	stats NotificationStats
}

// NewNotificationManager creates and initialises a NotificationManager.
// If cfg.Enabled is false the manager is a no-op but safe to call.
func NewNotificationManager(cfg *NotificationsConfig) (*NotificationManager, error) {
	m := &NotificationManager{
		cfg:      cfg,
		channels: make(map[string]NotificationChannel),
		tmpls:    make(map[string]*template.Template),
		rl:       newNotifRateLimiter(),
		stats: NotificationStats{
			ByRule:    make(map[string]int64),
			ByChannel: make(map[string]int64),
		},
	}

	m.funcMap = m.buildFuncMap()

	if !cfg.Enabled {
		return m, nil
	}

	// Build channel implementations
	if err := m.buildChannels(); err != nil {
		return nil, err
	}

	// Pre-compile rule templates
	if err := m.compileTemplates(); err != nil {
		return nil, err
	}

	// Start periodic rate-limiter cleanup (every 30 minutes)
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			m.rl.cleanup(2 * time.Hour)
		}
	}()

	return m, nil
}

// buildChannels instantiates a NotificationChannel for every entry in cfg.Channels.
func (m *NotificationManager) buildChannels() error {
	for name, chCfg := range m.cfg.Channels {
		var ch NotificationChannel
		switch chCfg.Type {
		case "telegram":
			ch = NewTelegramChannel(name, chCfg)
		default:
			return fmt.Errorf("notification channel %q: unknown type %q", name, chCfg.Type)
		}
		m.channels[name] = ch
		log.Printf("[Notifications] Channel %q (%s) registered", name, chCfg.Type)
	}
	return nil
}

// compileTemplates pre-compiles the Go text/template for every rule that
// specifies a custom template string.
func (m *NotificationManager) compileTemplates() error {
	for i, rule := range m.cfg.Rules {
		if rule.Template == "" {
			continue
		}
		key := ruleKey(i, rule)
		t, err := template.New(key).Funcs(m.funcMap).Parse(rule.Template)
		if err != nil {
			return fmt.Errorf("notification rule %q: invalid template: %w", key, err)
		}
		m.tmpls[key] = t
	}
	return nil
}

// ruleKey returns a stable string key for a rule (used for template map and stats).
func ruleKey(idx int, r NotificationRule) string {
	if r.Name != "" {
		return r.Name
	}
	return fmt.Sprintf("rule[%d]", idx)
}

// ─── Publish ──────────────────────────────────────────────────────────────────

// Publish evaluates all rules against the event and dispatches matching ones.
// It is safe to call from multiple goroutines concurrently.
// If the manager is disabled it returns immediately.
func (m *NotificationManager) Publish(evt NotificationEvent) {
	if !m.cfg.Enabled {
		return
	}

	m.mu.Lock()
	m.stats.TotalPublished++
	m.mu.Unlock()

	for i, rule := range m.cfg.Rules {
		if !rule.IsEnabled() {
			continue
		}
		if rule.Event != evt.EventType() {
			continue
		}
		if !m.matchFilter(evt, rule.Filter) {
			continue
		}

		m.mu.Lock()
		m.stats.TotalMatched++
		m.mu.Unlock()

		key := ruleKey(i, rule)
		subject := m.rateSubject(evt)

		// Render message
		msg, err := m.render(key, rule.Template, evt)
		if err != nil {
			log.Printf("[Notifications] Rule %q: template error: %v", key, err)
			m.mu.Lock()
			m.stats.TotalErrors++
			m.stats.LastError = err.Error()
			now := time.Now()
			m.stats.LastErrorAt = &now
			m.mu.Unlock()
			continue
		}

		// Dispatch to each channel
		for _, chName := range rule.Channels {
			ch, ok := m.channels[chName]
			if !ok {
				log.Printf("[Notifications] Rule %q: unknown channel %q", key, chName)
				continue
			}

			// Per-channel rate limit
			chCfg := m.cfg.Channels[chName]
			rlKey := rateLimitKey{ruleName: key, subject: chName + ":" + subject}
			if !m.rl.allow(rlKey, chCfg.RateLimitMinutes) {
				m.mu.Lock()
				m.stats.TotalRateLimited++
				m.mu.Unlock()
				if DebugMode {
					log.Printf("[Notifications] Rule %q → channel %q: rate limited (subject: %s)", key, chName, subject)
				}
				continue
			}

			if err := ch.Send(msg); err != nil {
				log.Printf("[Notifications] Rule %q → channel %q: send error: %v", key, chName, err)
				m.mu.Lock()
				m.stats.TotalErrors++
				m.stats.LastError = fmt.Sprintf("channel %s: %v", chName, err)
				now := time.Now()
				m.stats.LastErrorAt = &now
				m.mu.Unlock()
			} else {
				m.mu.Lock()
				m.stats.TotalSent++
				m.stats.ByRule[key]++
				m.stats.ByChannel[chName]++
				now := time.Now()
				m.stats.LastSentAt = &now
				m.mu.Unlock()
				if DebugMode {
					log.Printf("[Notifications] Rule %q → channel %q: sent (subject: %s)", key, chName, subject)
				}
			}
		}
	}
}

// rateSubject returns a string that identifies the "subject" of an event for
// rate-limiting purposes (e.g. callsign+band, component name, IP address).
func (m *NotificationManager) rateSubject(evt NotificationEvent) string {
	switch e := evt.(type) {
	case CWSpotEvent:
		return e.DXCall + ":" + e.Band
	case DXSpotEvent:
		return e.DXCall + ":" + e.Band
	case DigitalDecodeEvent:
		return e.Callsign + ":" + e.Band + ":" + e.Mode
	case SpaceWeatherEvent:
		return fmt.Sprintf("k%d:sfi%.0f", e.KIndex, e.SFI)
	case AntennaSwitchEvent:
		return fmt.Sprintf("ant%d:%s", e.Antenna, e.Action)
	case RotatorEvent:
		if e.Moving {
			return "moving"
		}
		return "stopped"
	case SystemMonitorEvent:
		return e.Component
	case UserSessionEvent:
		return string(e.Action) + ":" + e.ClientIP
	case VoiceActivityEvent:
		return fmt.Sprintf("voice:%s:%d", e.Band, e.EstimatedDialFreq/500*500)
	case ServerStartupEvent:
		return "startup"
	default:
		return "unknown"
	}
}

// ─── Filter engine ────────────────────────────────────────────────────────────

// matchFilter returns true if the event satisfies all criteria in f.
func (m *NotificationManager) matchFilter(evt NotificationEvent, f NotificationFilter) bool {
	switch e := evt.(type) {
	case CWSpotEvent:
		return m.matchCWSpot(e, f)
	case DXSpotEvent:
		return m.matchDXSpot(e, f)
	case DigitalDecodeEvent:
		return m.matchDigitalDecode(e, f)
	case SpaceWeatherEvent:
		return m.matchSpaceWeather(e, f)
	case AntennaSwitchEvent:
		return m.matchAntennaSwitch(e, f)
	case RotatorEvent:
		return m.matchRotator(e, f)
	case SystemMonitorEvent:
		return m.matchSystemMonitor(e, f)
	case UserSessionEvent:
		return m.matchUserSession(e, f)
	case VoiceActivityEvent:
		return m.matchVoiceActivity(e, f)
	case ServerStartupEvent:
		return true // no filter fields for startup
	}
	return true
}

func (m *NotificationManager) matchCWSpot(e CWSpotEvent, f NotificationFilter) bool {
	if !matchCallsign(e.DXCall, f.Callsigns, f.CallsignPrefixes) {
		return false
	}
	if !matchStringSlice(e.Country, f.Countries) {
		return false
	}
	if !matchStringSlice(e.CountryCode, f.CountryCodes) {
		return false
	}
	if !matchStringSlice(e.Continent, f.Continents) {
		return false
	}
	if !matchIntSlice(e.CQZone, f.CQZones) {
		return false
	}
	if !matchIntSlice(e.ITUZone, f.ITUZones) {
		return false
	}
	if !matchStringSlice(e.Band, f.Bands) {
		return false
	}
	if !matchStringSlice(e.Mode, f.Modes) {
		return false
	}
	if f.MinSNR != nil && e.SNR < *f.MinSNR {
		return false
	}
	if f.MaxSNR != nil && e.SNR > *f.MaxSNR {
		return false
	}
	if f.MinWPM != nil && e.WPM < *f.MinWPM {
		return false
	}
	if f.MinDistanceKm != nil {
		if e.DistanceKm == nil || *e.DistanceKm < *f.MinDistanceKm {
			return false
		}
	}
	if f.MaxDistanceKm != nil {
		if e.DistanceKm == nil || *e.DistanceKm > *f.MaxDistanceKm {
			return false
		}
	}
	return true
}

func (m *NotificationManager) matchDXSpot(e DXSpotEvent, f NotificationFilter) bool {
	if !matchCallsign(e.DXCall, f.Callsigns, f.CallsignPrefixes) {
		return false
	}
	if !matchStringSlice(e.Country, f.Countries) {
		return false
	}
	if !matchStringSlice(e.CountryCode, f.CountryCodes) {
		return false
	}
	if !matchStringSlice(e.Continent, f.Continents) {
		return false
	}
	if !matchStringSlice(e.Band, f.Bands) {
		return false
	}
	if len(f.Spotters) > 0 && !matchStringSlice(e.Spotter, f.Spotters) {
		return false
	}
	if len(f.CommentContains) > 0 && !containsAny(e.Comment, f.CommentContains) {
		return false
	}
	return true
}

func (m *NotificationManager) matchDigitalDecode(e DigitalDecodeEvent, f NotificationFilter) bool {
	if !matchCallsign(e.Callsign, f.Callsigns, f.CallsignPrefixes) {
		return false
	}
	if !matchStringSlice(e.Country, f.Countries) {
		return false
	}
	if !matchStringSlice(e.CountryCode, f.CountryCodes) {
		return false
	}
	if !matchStringSlice(e.Continent, f.Continents) {
		return false
	}
	if !matchIntSlice(e.CQZone, f.CQZones) {
		return false
	}
	if !matchIntSlice(e.ITUZone, f.ITUZones) {
		return false
	}
	if !matchStringSlice(e.Band, f.Bands) {
		return false
	}
	if !matchStringSlice(e.Mode, f.DigitalModes) {
		return false
	}
	if f.MinSNR != nil && e.SNR < *f.MinSNR {
		return false
	}
	if f.MaxSNR != nil && e.SNR > *f.MaxSNR {
		return false
	}
	if f.MinDistanceKm != nil {
		if e.DistanceKm == nil || *e.DistanceKm < *f.MinDistanceKm {
			return false
		}
	}
	if f.MaxDistanceKm != nil {
		if e.DistanceKm == nil || *e.DistanceKm > *f.MaxDistanceKm {
			return false
		}
	}
	if len(f.MessageContains) > 0 && !containsAny(e.Message, f.MessageContains) {
		return false
	}
	return true
}

func (m *NotificationManager) matchSpaceWeather(e SpaceWeatherEvent, f NotificationFilter) bool {
	if f.KMin != nil && e.KIndex < *f.KMin {
		return false
	}
	if f.KMax != nil && e.KIndex > *f.KMax {
		return false
	}
	if f.AMin != nil && e.AIndex < *f.AMin {
		return false
	}
	if f.SFIMin != nil && e.SFI < *f.SFIMin {
		return false
	}
	if f.SFIMax != nil && e.SFI > *f.SFIMax {
		return false
	}
	return true
}

func (m *NotificationManager) matchAntennaSwitch(e AntennaSwitchEvent, f NotificationFilter) bool {
	if !matchStringSlice(e.Action, f.AntActions) {
		return false
	}
	if !matchIntSlice(e.Antenna, f.AntNumbers) {
		return false
	}
	if !matchStringSlice(e.Source, f.AntSources) {
		return false
	}
	return true
}

func (m *NotificationManager) matchRotator(e RotatorEvent, f NotificationFilter) bool {
	if f.RotatorMoving != nil && e.Moving != *f.RotatorMoving {
		return false
	}
	return true
}

func (m *NotificationManager) matchSystemMonitor(e SystemMonitorEvent, f NotificationFilter) bool {
	if !matchStringSlice(e.Component, f.Components) {
		return false
	}
	// OnUnhealthy: fire only when transitioning healthy→unhealthy.
	// e.PreviouslyHealthy==true && e.Healthy==false means we just became unhealthy.
	if f.OnUnhealthy != nil && *f.OnUnhealthy {
		if e.Healthy || !e.PreviouslyHealthy {
			// Either still healthy, or was already unhealthy (no new transition)
			return false
		}
	}
	// OnRecovery: fire only when transitioning unhealthy→healthy.
	// e.PreviouslyHealthy==false && e.Healthy==true means we just recovered.
	if f.OnRecovery != nil && *f.OnRecovery {
		if !e.Healthy || e.PreviouslyHealthy {
			// Either still unhealthy, or was already healthy (no new transition)
			return false
		}
	}
	return true
}

func (m *NotificationManager) matchUserSession(e UserSessionEvent, f NotificationFilter) bool {
	if !matchStringSlice(string(e.Action), f.SessionActions) {
		return false
	}
	if !matchStringSlice(e.CountryCode, f.SessionCountryCodes) {
		return false
	}
	if !matchStringSlice(e.Continent, f.SessionContinents) {
		return false
	}
	if len(f.ClientIPs) > 0 && !matchStringSlice(e.ClientIP, f.ClientIPs) {
		return false
	}
	if len(f.UserAgentContains) > 0 && !containsAny(e.UserAgent, f.UserAgentContains) {
		return false
	}
	return true
}

func (m *NotificationManager) matchVoiceActivity(e VoiceActivityEvent, f NotificationFilter) bool {
	if !matchStringSlice(e.Band, f.VoiceBands) {
		return false
	}
	if !matchStringSlice(e.DXCountryCode, f.VoiceCountryCodes) {
		return false
	}
	if !matchStringSlice(e.DXContinent, f.VoiceContinents) {
		return false
	}
	if len(f.VoiceCallsigns) > 0 && !matchStringSlice(e.DXCallsign, f.VoiceCallsigns) {
		return false
	}
	if f.VoiceMinSNR != nil && e.SNR < *f.VoiceMinSNR {
		return false
	}
	if f.VoiceMinConfidence != nil && e.Confidence < *f.VoiceMinConfidence {
		return false
	}
	return true
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

// matchStringSlice returns true if value is in the slice, or the slice is empty.
func matchStringSlice(value string, slice []string) bool {
	if len(slice) == 0 {
		return true
	}
	for _, s := range slice {
		if strings.EqualFold(s, value) {
			return true
		}
	}
	return false
}

// matchIntSlice returns true if value is in the slice, or the slice is empty.
func matchIntSlice(value int, slice []int) bool {
	if len(slice) == 0 {
		return true
	}
	for _, v := range slice {
		if v == value {
			return true
		}
	}
	return false
}

// matchCallsign checks exact callsign list and prefix list.
func matchCallsign(callsign string, exact, prefixes []string) bool {
	if len(exact) == 0 && len(prefixes) == 0 {
		return true
	}
	upper := strings.ToUpper(callsign)
	for _, c := range exact {
		if strings.EqualFold(c, callsign) {
			return true
		}
	}
	for _, p := range prefixes {
		if strings.HasPrefix(upper, strings.ToUpper(p)) {
			return true
		}
	}
	return false
}

// containsAny returns true if s contains any of the substrings (case-insensitive).
func containsAny(s string, subs []string) bool {
	lower := strings.ToLower(s)
	for _, sub := range subs {
		if strings.Contains(lower, strings.ToLower(sub)) {
			return true
		}
	}
	return false
}

// ─── Template engine ──────────────────────────────────────────────────────────

// render renders the template for a rule against the event data.
// If no custom template is set, a built-in default is used.
func (m *NotificationManager) render(key, tmplStr string, evt NotificationEvent) (string, error) {
	// Use pre-compiled template if available
	if t, ok := m.tmpls[key]; ok {
		var buf bytes.Buffer
		if err := t.Execute(&buf, evt); err != nil {
			return "", err
		}
		return buf.String(), nil
	}

	// No custom template — use built-in default
	return m.defaultMessage(evt), nil
}

// defaultMessage returns a sensible default notification text for each event type.
func (m *NotificationManager) defaultMessage(evt NotificationEvent) string {
	switch e := evt.(type) {
	case CWSpotEvent:
		dist := ""
		if e.DistanceKm != nil {
			dist = fmt.Sprintf(", %.0f km", *e.DistanceKm)
		}
		return fmt.Sprintf("📻 CW: %s (%s) on %s @ %.1f kHz, %d WPM, SNR %d dB%s",
			e.DXCall, e.Country, e.Band, e.Frequency/1000, e.WPM, e.SNR, dist)

	case DXSpotEvent:
		return fmt.Sprintf("📡 DX: %s (%s) on %s @ %.1f kHz via %s",
			e.DXCall, e.Country, e.Band, e.Frequency/1000, e.Spotter)

	case DigitalDecodeEvent:
		dist := ""
		if e.DistanceKm != nil {
			dist = fmt.Sprintf(", %.0f km", *e.DistanceKm)
		}
		return fmt.Sprintf("🔢 %s: %s (%s) on %s, SNR %+d dB%s",
			e.Mode, e.Callsign, e.Country, e.Band, e.SNR, dist)

	case SpaceWeatherEvent:
		dir := ""
		if e.KIndex > e.PreviousKIndex {
			dir = "↑"
		} else if e.KIndex < e.PreviousKIndex {
			dir = "↓"
		}
		return fmt.Sprintf("☀️ Space weather: K=%d%s, A=%d, SFI=%.0f (%s)",
			e.KIndex, dir, e.AIndex, e.SFI, e.PropagationQuality)

	case AntennaSwitchEvent:
		if e.Grounded {
			return fmt.Sprintf("🔌 Antenna: all grounded (source: %s)", e.Source)
		}
		return fmt.Sprintf("🔌 Antenna: switched to %s (source: %s)", e.Label, e.Source)

	case RotatorEvent:
		if e.Moving {
			return fmt.Sprintf("🧭 Rotator: moving to %.0f°", e.TargetAzimuth)
		}
		return fmt.Sprintf("🧭 Rotator: stopped at %.0f° el %.0f°", e.Azimuth, e.Elevation)

	case SystemMonitorEvent:
		if e.Healthy {
			return fmt.Sprintf("✅ %s recovered", e.Component)
		}
		issues := strings.Join(e.Issues, "; ")
		if issues == "" {
			issues = "unknown issue"
		}
		return fmt.Sprintf("❌ %s unhealthy: %s", e.Component, issues)

	case UserSessionEvent:
		return fmt.Sprintf("👤 User %s: %s (%s)", e.Action, e.ClientIP, e.Country)

	case VoiceActivityEvent:
		dx := ""
		if e.DXCallsign != "" {
			dx = fmt.Sprintf(" [%s, %s]", e.DXCallsign, e.DXCountry)
		}
		return fmt.Sprintf("🎙️ Voice on %s @ %.3f MHz%s (SNR %.0f dB, conf %.0f%%)",
			e.Band, float64(e.EstimatedDialFreq)/1e6, dx, float64(e.SNR), float64(e.Confidence)*100)

	case ServerStartupEvent:
		return fmt.Sprintf("🚀 UberSDR %s started (%s)", e.Version, e.Callsign)

	default:
		return fmt.Sprintf("📢 Notification: %s", evt.EventType())
	}
}

// ─── Template functions ───────────────────────────────────────────────────────

// buildFuncMap returns the template.FuncMap available in all rule templates.
func (m *NotificationManager) buildFuncMap() template.FuncMap {
	return template.FuncMap{
		// flag converts an ISO 3166-1 alpha-2 country code to a flag emoji.
		// e.g. "JP" → "🇯🇵"
		"flag": func(code string) string {
			if len(code) != 2 {
				return ""
			}
			code = strings.ToUpper(code)
			r1 := rune(0x1F1E6 + (rune(code[0]) - 'A'))
			r2 := rune(0x1F1E6 + (rune(code[1]) - 'A'))
			return string([]rune{r1, r2})
		},

		// bearing converts a bearing in degrees to a compass direction string.
		// e.g. 45.0 → "NE"
		"bearing": func(deg interface{}) string {
			var d float64
			switch v := deg.(type) {
			case float64:
				d = v
			case *float64:
				if v == nil {
					return "?"
				}
				d = *v
			default:
				return "?"
			}
			dirs := []string{"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
				"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"}
			idx := int((d+11.25)/22.5) % 16
			return dirs[idx]
		},

		// deref dereferences a *float64, returning 0 if nil.
		"deref": func(p *float64) float64 {
			if p == nil {
				return 0
			}
			return *p
		},

		// divf divides two float64 values.
		"divf": func(a, b float64) float64 {
			if b == 0 {
				return 0
			}
			return a / b
		},

		// join joins a string slice with a separator.
		"join": func(sep string, items []string) string {
			return strings.Join(items, sep)
		},

		// upper converts a string to upper case.
		"upper": strings.ToUpper,

		// lower converts a string to lower case.
		"lower": strings.ToLower,

		// mhz converts Hz (uint64) to MHz string with 3 decimal places.
		"mhz": func(hz uint64) string {
			return fmt.Sprintf("%.3f", float64(hz)/1e6)
		},

		// khz converts Hz (float64) to kHz string with 1 decimal place.
		"khz": func(hz float64) string {
			return fmt.Sprintf("%.1f", hz/1000)
		},

		// mulf multiplies two float64 values (useful for confidence × 100).
		"mulf": func(a, b float64) float64 {
			return a * b
		},

		// f32 converts a float32 to float64 for use with printf.
		"f32": func(v float32) float64 {
			return float64(v)
		},
	}
}

// ─── Admin / health API ───────────────────────────────────────────────────────

// GetStats returns a snapshot of the current runtime statistics.
func (m *NotificationManager) GetStats() NotificationStats {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// Deep copy maps
	s := m.stats
	s.ByRule = make(map[string]int64, len(m.stats.ByRule))
	for k, v := range m.stats.ByRule {
		s.ByRule[k] = v
	}
	s.ByChannel = make(map[string]int64, len(m.stats.ByChannel))
	for k, v := range m.stats.ByChannel {
		s.ByChannel[k] = v
	}
	return s
}

// GetHealth returns a health summary suitable for the admin API.
func (m *NotificationManager) GetHealth() map[string]interface{} {
	stats := m.GetStats()
	channels := make([]map[string]interface{}, 0, len(m.channels))
	for name, ch := range m.channels {
		channels = append(channels, map[string]interface{}{
			"name": name,
			"type": ch.Type(),
		})
	}

	enabledRules := 0
	for _, r := range m.cfg.Rules {
		if r.IsEnabled() {
			enabledRules++
		}
	}

	return map[string]interface{}{
		"enabled":       m.cfg.Enabled,
		"channels":      channels,
		"total_rules":   len(m.cfg.Rules),
		"enabled_rules": enabledRules,
		"stats":         stats,
	}
}

