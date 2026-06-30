package main

import (
	"bytes"
	"fmt"
	"log"
	"strconv"
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

// dedupEntry records when a dedup subject last fired and its configured window.
type dedupEntry struct {
	lastSent      time.Time
	windowMinutes int
}

// notifDedupTracker implements per-rule "notify once per new X" gating. Unlike
// notifRateLimiter it treats a window of 0 as "once until restart" and keeps
// such entries for the life of the process; positive-window entries re-arm and
// are pruned by cleanup once expired.
type notifDedupTracker struct {
	mu      sync.Mutex
	entries map[rateLimitKey]dedupEntry
}

func newNotifDedupTracker() *notifDedupTracker {
	return &notifDedupTracker{entries: make(map[rateLimitKey]dedupEntry)}
}

// allow reports whether a dedup subject may fire now and records the time when
// it does. windowMinutes <= 0 means the subject fires once and never again
// while the process runs; a positive window re-arms it after that many minutes.
func (d *notifDedupTracker) allow(key rateLimitKey, windowMinutes int) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if entry, seen := d.entries[key]; seen {
		if windowMinutes <= 0 || time.Since(entry.lastSent) < time.Duration(windowMinutes)*time.Minute {
			return false
		}
	}
	d.entries[key] = dedupEntry{lastSent: time.Now(), windowMinutes: windowMinutes}
	return true
}

// cleanup removes expired positive-window entries. "Once until restart" entries
// (windowMinutes <= 0) are kept for the life of the process.
func (d *notifDedupTracker) cleanup() {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	for k, e := range d.entries {
		if e.windowMinutes > 0 && now.Sub(e.lastSent) >= time.Duration(e.windowMinutes)*time.Minute {
			delete(d.entries, k)
		}
	}
}

// ─── Stats ────────────────────────────────────────────────────────────────────

// NotificationStats holds runtime counters for the admin API.
type NotificationStats struct {
	TotalPublished       int64            `json:"total_published"`
	TotalMatched         int64            `json:"total_matched"`
	TotalSent            int64            `json:"total_sent"`
	TotalErrors          int64            `json:"total_errors"`
	TotalRateLimited     int64            `json:"total_rate_limited"`
	ByRule               map[string]int64 `json:"by_rule"`
	ByRuleErrors         map[string]int64 `json:"by_rule_errors"`
	ByRuleRateLimited    map[string]int64 `json:"by_rule_rate_limited"`
	ByChannel            map[string]int64 `json:"by_channel"`
	ByChannelErrors      map[string]int64 `json:"by_channel_errors"`
	ByChannelRateLimited map[string]int64 `json:"by_channel_rate_limited"`
	LastSentAt           *time.Time       `json:"last_sent_at,omitempty"`
	LastError            string           `json:"last_error,omitempty"`
	LastErrorAt          *time.Time       `json:"last_error_at,omitempty"`
}

// ─── Manager ──────────────────────────────────────────────────────────────────

// NotificationManager is the central hub. Sources call Publish() with a typed
// event; the manager evaluates all rules, renders templates, applies rate
// limiting, and dispatches to the configured channels.
type NotificationManager struct {
	cfg      *NotificationsConfig
	channels map[string]NotificationChannel // keyed by channel name
	tmpls    map[string]*template.Template  // keyed by rule name
	blocked  map[string]bool                // rule keys disabled at runtime by the high-volume guardrail
	rl       *notifRateLimiter
	dedup    *notifDedupTracker
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
		blocked:  make(map[string]bool),
		rl:       newNotifRateLimiter(),
		dedup:    newNotifDedupTracker(),
		stats: NotificationStats{
			ByRule:               make(map[string]int64),
			ByRuleErrors:         make(map[string]int64),
			ByRuleRateLimited:    make(map[string]int64),
			ByChannel:            make(map[string]int64),
			ByChannelErrors:      make(map[string]int64),
			ByChannelRateLimited: make(map[string]int64),
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

	// Determine which high-volume rules must be disabled at runtime.
	m.blocked = computeBlockedRules(cfg)

	// Start periodic rate-limiter cleanup (every 30 minutes)
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			m.rl.cleanup(2 * time.Hour)
			m.dedup.cleanup()
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
		case "email":
			ch = NewEmailChannel(name, chCfg)
		default:
			return fmt.Errorf("notification channel %q: unknown type %q", name, chCfg.Type)
		}
		m.channels[name] = ch
		log.Printf("[Notifications] Channel %q (%s) registered", name, chCfg.Type)
	}
	return nil
}

// compileTemplates pre-compiles the Go text/template for every rule that
// specifies a custom template string (default and per-channel overrides).
func (m *NotificationManager) compileTemplates() error {
	tmpls, err := compileRuleTemplates(m.cfg.Rules, m.funcMap)
	if err != nil {
		return err
	}
	m.tmpls = tmpls
	return nil
}

// compileRuleTemplates pre-compiles the default template for each rule (keyed by
// ruleKey) and any per-channel overrides (keyed by ruleChannelKey). It is shared
// by initial load and Reload so both paths behave identically.
func compileRuleTemplates(rules []NotificationRule, funcMap template.FuncMap) (map[string]*template.Template, error) {
	tmpls := make(map[string]*template.Template)
	for i, rule := range rules {
		key := ruleKey(i, rule)
		if rule.Template != "" {
			t, err := template.New(key).Funcs(funcMap).Parse(rule.Template)
			if err != nil {
				return nil, fmt.Errorf("notification rule %q: invalid template: %w", key, err)
			}
			tmpls[key] = t
		}
		for chName, tmplStr := range rule.Templates {
			if tmplStr == "" {
				continue
			}
			ckey := ruleChannelKey(key, chName)
			t, err := template.New(ckey).Funcs(funcMap).Parse(tmplStr)
			if err != nil {
				return nil, fmt.Errorf("notification rule %q channel %q: invalid template: %w", key, chName, err)
			}
			tmpls[ckey] = t
		}
	}
	return tmpls, nil
}

// ruleKey returns a stable string key for a rule (used for template map and stats).
func ruleKey(idx int, r NotificationRule) string {
	if r.Name != "" {
		return r.Name
	}
	return fmt.Sprintf("rule[%d]", idx)
}

// ruleChannelKey returns the template-map key for a rule's per-channel override.
// The NUL separator cannot occur in a rule name or channel name, so keys never
// collide with the plain ruleKey.
func ruleChannelKey(rKey, chName string) string {
	return rKey + "\x00" + chName
}

// ruleBlockedAtRuntime reports whether a rule must be disabled at runtime
// because it would fire on every spot. This mirrors the high-volume guardrail
// enforced by NotificationsConfig.Validate at save time, so a config that was
// hand-edited to bypass the admin UI still cannot flood the channels.
func ruleBlockedAtRuntime(r NotificationRule) bool {
	return highVolumeSpotEvents[r.Event] &&
		len(r.DedupBy) == 0 &&
		!filterNarrowsHighVolume(r.Filter)
}

// computeBlockedRules returns the set of rule keys that the high-volume
// guardrail disables, logging a one-time warning for each.
func computeBlockedRules(cfg *NotificationsConfig) map[string]bool {
	blocked := make(map[string]bool)
	for i, rule := range cfg.Rules {
		if ruleBlockedAtRuntime(rule) {
			key := ruleKey(i, rule)
			blocked[key] = true
			log.Printf("[Notifications] Rule %q DISABLED at runtime: a %q rule with no selective "+
				"filter and no dedup_by would fire on every spot (hundreds per minute). Add a "+
				"selective filter or dedup_by to enable it.", key, rule.Event)
		}
	}
	return blocked
}

// Reload replaces the manager's configuration with newCfg and rebuilds all
// channels and templates. In-flight Publish calls complete against the old
// config; subsequent calls use the new one. Rate-limiter state is preserved.
func (m *NotificationManager) Reload(newCfg *NotificationsConfig) error {
	newChannels := make(map[string]NotificationChannel)
	newTmpls := make(map[string]*template.Template)

	if newCfg.Enabled {
		// Build channels
		for name, chCfg := range newCfg.Channels {
			var ch NotificationChannel
			switch chCfg.Type {
			case "telegram":
				ch = NewTelegramChannel(name, chCfg)
			case "email":
				ch = NewEmailChannel(name, chCfg)
			default:
				return fmt.Errorf("notification channel %q: unknown type %q", name, chCfg.Type)
			}
			newChannels[name] = ch
			log.Printf("[Notifications] Reload: channel %q (%s) registered", name, chCfg.Type)
		}

		// Compile templates (default + per-channel overrides)
		var err error
		newTmpls, err = compileRuleTemplates(newCfg.Rules, m.funcMap)
		if err != nil {
			return err
		}
	}

	// Recompute the runtime guardrail block-list for the new rule set.
	newBlocked := computeBlockedRules(newCfg)

	m.mu.Lock()
	m.cfg = newCfg
	m.channels = newChannels
	m.tmpls = newTmpls
	m.blocked = newBlocked
	m.mu.Unlock()

	log.Printf("[Notifications] Reloaded: enabled=%v channels=%d rules=%d",
		newCfg.Enabled, len(newChannels), len(newCfg.Rules))
	return nil
}

// ─── Publish ──────────────────────────────────────────────────────────────────

// Publish evaluates all rules against the event and dispatches matching ones.
// Config returns the manager's current live configuration under the read lock.
// The returned pointer is valid until the next Reload call.
func (m *NotificationManager) Config() *NotificationsConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg
}

// It is safe to call from multiple goroutines concurrently.
// If the manager is disabled it returns immediately.
func (m *NotificationManager) Publish(evt NotificationEvent) {
	// Snapshot config, channels, and compiled templates under read lock so a
	// concurrent Reload cannot race with our iteration.
	m.mu.RLock()
	cfg := m.cfg
	channels := m.channels
	tmpls := m.tmpls
	blocked := m.blocked
	m.mu.RUnlock()

	if !cfg.Enabled {
		return
	}

	m.mu.Lock()
	m.stats.TotalPublished++
	m.mu.Unlock()

	for i, rule := range cfg.Rules {
		if !rule.IsEnabled() {
			continue
		}
		if rule.Event != evt.EventType() {
			continue
		}

		key := ruleKey(i, rule)

		// Runtime guardrail: skip high-volume rules that lack a selective filter
		// or dedup_by. These are flagged once at load/reload (computeBlockedRules)
		// and would otherwise fire on every spot.
		if blocked[key] {
			continue
		}

		if !m.matchFilter(evt, rule.Filter) {
			continue
		}

		m.mu.Lock()
		m.stats.TotalMatched++
		m.mu.Unlock()

		// Per-rule deduplication: for "notify once per new X" rules, fire only
		// the first time a given combination of dedup_by values is seen within
		// the configured window. This is what makes a high-volume spot rule
		// (e.g. every FT8 decode) usable as a "new country/continent" alert.
		if len(rule.DedupBy) > 0 {
			parts := make([]string, len(rule.DedupBy))
			for j, dk := range rule.DedupBy {
				parts[j] = dedupValue(evt, dk)
			}
			dkey := rateLimitKey{ruleName: "dedup:" + key, subject: strings.Join(parts, "|")}
			if !m.dedup.allow(dkey, rule.DedupWindowMinutes) {
				m.mu.Lock()
				m.stats.TotalRateLimited++
				m.stats.ByRuleRateLimited[key]++
				m.mu.Unlock()
				if DebugMode {
					log.Printf("[Notifications] Rule %q: deduplicated (subject: %s)", key, strings.Join(parts, "|"))
				}
				continue
			}
		}

		subject := m.rateSubject(evt)

		// Dispatch to each channel. The message is rendered per channel so a rule
		// can format its body differently for each transport (e.g. HTML for
		// Telegram, plain wording for email) via per-channel template overrides.
		for _, chName := range rule.Channels {
			ch, ok := channels[chName]
			if !ok {
				log.Printf("[Notifications] Rule %q: unknown channel %q", key, chName)
				continue
			}

			// Per-channel rate limit
			chCfg := cfg.Channels[chName]
			rlKey := rateLimitKey{ruleName: key, subject: chName + ":" + subject}
			if !m.rl.allow(rlKey, chCfg.RateLimitMinutes) {
				m.mu.Lock()
				m.stats.TotalRateLimited++
				m.stats.ByRuleRateLimited[key]++
				m.stats.ByChannelRateLimited[chName]++
				m.mu.Unlock()
				if DebugMode {
					log.Printf("[Notifications] Rule %q → channel %q: rate limited (subject: %s)", key, chName, subject)
				}
				continue
			}

			// Render this channel's body (override → rule default → built-in).
			msg, err := m.renderForChannel(key, chName, evt, tmpls)
			if err != nil {
				log.Printf("[Notifications] Rule %q → channel %q: template error: %v", key, chName, err)
				m.mu.Lock()
				m.stats.TotalErrors++
				m.stats.ByRuleErrors[key]++
				m.stats.ByChannelErrors[chName]++
				m.stats.LastError = err.Error()
				now := time.Now()
				m.stats.LastErrorAt = &now
				m.mu.Unlock()
				continue
			}

			if err := ch.Send(msg); err != nil {
				log.Printf("[Notifications] Rule %q → channel %q: send error: %v", key, chName, err)
				m.mu.Lock()
				m.stats.TotalErrors++
				m.stats.ByRuleErrors[key]++
				m.stats.ByChannelErrors[chName]++
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

// dedupValue extracts the value of a single dedup_by key from a spot event.
// Unknown keys (or keys not applicable to the event type) yield "". Keys must
// match those declared in dedupKeysForEvent.
func dedupValue(evt NotificationEvent, key string) string {
	switch e := evt.(type) {
	case CWSpotEvent:
		switch key {
		case "callsign":
			return e.DXCall
		case "country":
			return e.Country
		case "country_code":
			return e.CountryCode
		case "continent":
			return e.Continent
		case "cq_zone":
			return strconv.Itoa(e.CQZone)
		case "itu_zone":
			return strconv.Itoa(e.ITUZone)
		case "band":
			return e.Band
		case "mode":
			return e.Mode
		}
	case DXSpotEvent:
		switch key {
		case "callsign":
			return e.DXCall
		case "country":
			return e.Country
		case "country_code":
			return e.CountryCode
		case "continent":
			return e.Continent
		case "band":
			return e.Band
		}
	case DigitalDecodeEvent:
		switch key {
		case "callsign":
			return e.Callsign
		case "country":
			return e.Country
		case "country_code":
			return e.CountryCode
		case "continent":
			return e.Continent
		case "cq_zone":
			return strconv.Itoa(e.CQZone)
		case "itu_zone":
			return strconv.Itoa(e.ITUZone)
		case "band":
			return e.Band
		case "mode":
			return e.Mode
		}
	}
	return ""
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
	// Flap-detection alerts (activation / stabilisation) always deliver to any
	// rule watching the component, regardless of on_unhealthy/on_recovery.
	if e.isFlapAlert() {
		return true
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
// renderWithTmpls renders the message for a rule using the provided compiled
// template map (a snapshot taken at the start of Publish). If no custom
// template is set, a built-in default is used.
func (m *NotificationManager) renderWithTmpls(key, tmplStr string, evt NotificationEvent, tmpls map[string]*template.Template) (string, error) {
	// Use pre-compiled template if available
	if t, ok := tmpls[key]; ok {
		var buf bytes.Buffer
		if err := t.Execute(&buf, evt); err != nil {
			return "", err
		}
		return buf.String(), nil
	}

	// No custom template — use built-in default
	return m.defaultMessage(evt), nil
}

// render is kept for callers outside Publish (e.g. the test handler) that do
// not hold a snapshot. It acquires a read lock to safely access m.tmpls.
func (m *NotificationManager) render(key, tmplStr string, evt NotificationEvent) (string, error) {
	m.mu.RLock()
	tmpls := m.tmpls
	m.mu.RUnlock()
	return m.renderWithTmpls(key, tmplStr, evt, tmpls)
}

// renderForChannel renders the body for one (rule, channel) pair, preferring a
// per-channel override, then the rule's default template, then the built-in
// default message. tmpls is the snapshot taken at the start of Publish.
func (m *NotificationManager) renderForChannel(rKey, chName string, evt NotificationEvent, tmpls map[string]*template.Template) (string, error) {
	if t, ok := tmpls[ruleChannelKey(rKey, chName)]; ok {
		var buf bytes.Buffer
		if err := t.Execute(&buf, evt); err != nil {
			return "", err
		}
		return buf.String(), nil
	}
	// Fall back to the rule default (or built-in) via the existing helper.
	return m.renderWithTmpls(rKey, "", evt, tmpls)
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
	s.ByRuleErrors = make(map[string]int64, len(m.stats.ByRuleErrors))
	for k, v := range m.stats.ByRuleErrors {
		s.ByRuleErrors[k] = v
	}
	s.ByRuleRateLimited = make(map[string]int64, len(m.stats.ByRuleRateLimited))
	for k, v := range m.stats.ByRuleRateLimited {
		s.ByRuleRateLimited[k] = v
	}
	s.ByChannel = make(map[string]int64, len(m.stats.ByChannel))
	for k, v := range m.stats.ByChannel {
		s.ByChannel[k] = v
	}
	s.ByChannelErrors = make(map[string]int64, len(m.stats.ByChannelErrors))
	for k, v := range m.stats.ByChannelErrors {
		s.ByChannelErrors[k] = v
	}
	s.ByChannelRateLimited = make(map[string]int64, len(m.stats.ByChannelRateLimited))
	for k, v := range m.stats.ByChannelRateLimited {
		s.ByChannelRateLimited[k] = v
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
