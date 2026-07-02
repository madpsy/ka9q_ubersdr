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

// ChannelResponse holds the server's response to a notification send attempt.
// For HTTP-based channels (Telegram, webhook) it captures the HTTP status code
// and up to 512 bytes of the response body. For SMTP it captures the server
// greeting / error string. On success, StatusCode is the HTTP 2xx code (or 0
// for SMTP which has no numeric status exposed at this level).
type ChannelResponse struct {
	StatusCode int    `json:"status_code,omitempty"` // HTTP status (0 for SMTP)
	Body       string `json:"body,omitempty"`        // response body snippet (≤512 bytes)
}

// NotificationChannel is the interface that every output channel must implement.
// Adding a new channel type (email, Matrix, ntfy, …) only requires implementing
// this interface and registering it in NotificationManager.buildChannels().
type NotificationChannel interface {
	// Send delivers a pre-rendered message to the channel.
	// The implementation is responsible for its own retries / error handling.
	// It returns a ChannelResponse with the server's HTTP status and body snippet,
	// and a non-nil error if delivery failed.
	Send(message string) (ChannelResponse, error)
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

// ChannelLogEntry records a single send attempt for a channel's response ring buffer.
type ChannelLogEntry struct {
	At        time.Time       `json:"at"`
	Rule      string          `json:"rule"`
	EventType string          `json:"event_type"`
	Status    string          `json:"status"` // "sent", "error", "template_error"
	ErrorMsg  string          `json:"error,omitempty"`
	Response  ChannelResponse `json:"response"`
}

const maxChannelLogEntries = 10

// NotificationManager is the central hub. Sources call Publish() with a typed
// event; the manager evaluates all rules, renders templates, applies rate
// limiting, and dispatches to the configured channels.
type NotificationManager struct {
	cfg       *NotificationsConfig
	channels  map[string]NotificationChannel // keyed by channel name
	tmpls     map[string]*template.Template  // keyed by rule name
	blocked   map[string]bool                // rule keys disabled at runtime by the high-volume guardrail
	rl        *notifRateLimiter
	dedup     *notifDedupTracker
	funcMap   template.FuncMap
	listeners *TelegramListenerRegistry
	mqtt      *MQTTPublisher // may be nil; publishes dispatch events and health stats to MQTT

	mu       sync.RWMutex
	stats    NotificationStats
	chanLogs map[string][]ChannelLogEntry // per-channel ring buffer of last 10 responses
}

// SetSessionManager wires the SessionManager into the listener registry so
// that bot commands (e.g. /stats) can query active sessions.
// Must be called before the first Reload or immediately after
// NewNotificationManager if the config is already enabled.
func (m *NotificationManager) SetSessionManager(sm *SessionManager) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.listeners = NewTelegramListenerRegistry(sm)
	// Sync immediately with the current config so listeners start right away.
	m.listeners.Sync(m.cfg)
}

// SetRotctlHandler wires the rotator handler into the listener registry so
// that the /rotator bot command can report the current azimuth.
func (m *NotificationManager) SetRotctlHandler(h *RotctlAPIHandler) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetRotctlHandler(h)
	}
}

// SetAntSwitchHandler wires the antenna switch handler into the listener
// registry so that the /switch bot command can report the active port.
func (m *NotificationManager) SetAntSwitchHandler(h *AntSwitchHandler) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetAntSwitchHandler(h)
	}
}

// SetNoiseFloorMonitor wires the noise floor monitor into the listener
// registry so that the /bands bot command can report per-band FT8 SNR.
func (m *NotificationManager) SetNoiseFloorMonitor(h *NoiseFloorMonitor) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetNoiseFloorMonitor(h)
	}
}

// SetPSKRankFetcher wires the PSK rank fetcher into the listener registry
// so that the /psk bot command can report PSKReporter rank data.
func (m *NotificationManager) SetPSKRankFetcher(h *PSKRankFetcher) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetPSKRankFetcher(h)
	}
}

// SetWSPRRankFetcher wires the WSPR rank fetcher into the listener registry
// so that the /wspr bot command can report WSPR Live rank data.
func (m *NotificationManager) SetWSPRRankFetcher(h *WSPRRankFetcher) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetWSPRRankFetcher(h)
	}
}

// SetRBNStore wires the RBN data store into the listener registry
// so that the /rbn bot command can report RBN skimmer data.
func (m *NotificationManager) SetRBNStore(h *RBNDataStore) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetRBNStore(h)
	}
}

// SetDXClusterWSHandler wires the DX cluster WebSocket handler into the
// listener registry so that the /cw bot command can read the live CW spot buffer.
func (m *NotificationManager) SetDXClusterWSHandler(h *DXClusterWebSocketHandler) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetDXClusterWSHandler(h)
	}
}

// SetSpaceWeatherMonitor wires the space weather monitor into the listener
// registry so that the /space bot command can report current space weather.
func (m *NotificationManager) SetSpaceWeatherMonitor(h *SpaceWeatherMonitor) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetSpaceWeatherMonitor(h)
	}
}

// SetChatManager wires the chat manager into the listener registry
// so that the /chat bot command can report recent chat messages.
func (m *NotificationManager) SetChatManager(h *ChatManager) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetChatManager(h)
	}
}

// SetAdminHandler wires the admin handler into the listener registry
// so that the /monitor bot command can report subsystem health.
func (m *NotificationManager) SetAdminHandler(h *AdminHandler) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetAdminHandler(h)
	}
}

// SetNotifManagerOnListeners wires this NotificationManager into the listener
// registry so that the /monitor bot command can report notifications health.
func (m *NotificationManager) SetNotifManagerOnListeners() {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetNotifManager(m)
	}
}

// SetMQTTPublisher wires an MQTTPublisher into the notification manager so that
// every dispatch attempt and periodic health stats are published to MQTT.
func (m *NotificationManager) SetMQTTPublisher(mp *MQTTPublisher) {
	m.mu.Lock()
	m.mqtt = mp
	m.mu.Unlock()
	// SetNotifManager is called outside the lock to avoid any potential
	// lock ordering issues (the health publisher goroutine calls GetHealth/GetStats
	// which acquire m.mu.RLock).
	if mp != nil {
		mp.SetNotifManager(m)
	}
}

// SetGPSDOMonitor wires the GPSDO monitor into the listener registry
// so that the /gpsdo bot command can report GPSDO status.
func (m *NotificationManager) SetGPSDOMonitor(h *GPSDOMonitor) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetGPSDOMonitor(h)
	}
}

// SetReceiverCallsign sets the receiver callsign used for PSK/WSPR lookups.
func (m *NotificationManager) SetReceiverCallsign(cs string) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetReceiverCallsign(cs)
	}
}

// SetCWSkimmerCallsign sets the CW skimmer callsign used for RBN lookups.
func (m *NotificationManager) SetCWSkimmerCallsign(cs string) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetCWSkimmerCallsign(cs)
	}
}

// SetConfig wires the server config into the listener registry
// so that the /info bot command can report receiver details.
func (m *NotificationManager) SetConfig(c *Config) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetConfig(c)
	}
}

// SetInstanceReporter wires the instance reporter into the listener registry
// so that the /info bot command can report the public URL.
func (m *NotificationManager) SetInstanceReporter(ir *InstanceReporter) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetInstanceReporter(ir)
	}
}

// SetIPBanManager wires the IP ban manager into the listener registry
// so that the /banned bot command can list, add, and remove IP bans.
func (m *NotificationManager) SetIPBanManager(h *IPBanManager) {
	m.mu.RLock()
	reg := m.listeners
	m.mu.RUnlock()
	if reg != nil {
		reg.SetIPBanManager(h)
	}
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
		chanLogs: make(map[string][]ChannelLogEntry),
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
		case "webhook":
			ch = NewWebhookChannel(name, chCfg)
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
			case "webhook":
				ch = NewWebhookChannel(name, chCfg)
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
	// chanLogs is intentionally preserved across reloads so the response history
	// survives a config save. Entries for channels that no longer exist are
	// harmless (they will never be queried) and are cheap to keep.
	m.mu.Unlock()

	// Sync bot command listeners with the new config (start/stop as needed).
	if m.listeners != nil {
		m.listeners.Sync(newCfg)
	}

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

// ListenerStatus returns the runtime status of all active Telegram bot command
// listeners, keyed by channel name. Returns nil if no listeners are running.
func (m *NotificationManager) ListenerStatus() map[string]listenerStatus {
	if m.listeners == nil {
		return nil
	}
	return m.listeners.GetStatus()
}

// CommandHistory returns the per-channel command history (newest-first, up to
// maxCommandHistory entries each) for all active listeners.
func (m *NotificationManager) CommandHistory() map[string][]commandHistoryEntry {
	if m.listeners == nil {
		return nil
	}
	return m.listeners.GetCommandHistory()
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

			// Echo suppression: if this is a chat message injected from a Telegram
			// relay, skip sending it back to the channel it came from. This prevents
			// the relay user from seeing their own messages twice.
			// Joined/left events (Source always empty) are never suppressed.
			if chatEvt, ok := evt.(ChatEvent); ok {
				if chatEvt.Action == ChatActionMessage && chatEvt.Source == "telegram:"+chName {
					if DebugMode {
						log.Printf("[Notifications] Rule %q → channel %q: suppressing relay echo (source: %s)", key, chName, chatEvt.Source)
					}
					continue
				}
			}

			// Render this channel's body (override → rule default → built-in).
			msg, err := m.renderForChannel(key, chName, evt, tmpls)
			if err != nil {
				log.Printf("[Notifications] Rule %q → channel %q: template error: %v", key, chName, err)
				entry := ChannelLogEntry{
					At: time.Now(), Rule: key, EventType: string(evt.EventType()),
					Status: "template_error", ErrorMsg: err.Error(),
				}
				m.mu.Lock()
				m.stats.TotalErrors++
				m.stats.ByRuleErrors[key]++
				m.stats.ByChannelErrors[chName]++
				m.stats.LastError = err.Error()
				now := time.Now()
				m.stats.LastErrorAt = &now
				m.appendChannelLog(chName, entry)
				mqttPub := m.mqtt
				m.mu.Unlock()
				if mqttPub != nil {
					go mqttPub.PublishNotificationDispatch(string(evt.EventType()), key, chName, ch.Type(), "", "template_error", err.Error(), ChannelResponse{})
				}
				continue
			}

			chResp, sendErr := ch.Send(msg)
			if sendErr != nil {
				log.Printf("[Notifications] Rule %q → channel %q: send error: %v", key, chName, sendErr)
				errMsg := fmt.Sprintf("channel %s: %v", chName, sendErr)
				entry := ChannelLogEntry{
					At: time.Now(), Rule: key, EventType: string(evt.EventType()),
					Status: "error", ErrorMsg: sendErr.Error(), Response: chResp,
				}
				m.mu.Lock()
				m.stats.TotalErrors++
				m.stats.ByRuleErrors[key]++
				m.stats.ByChannelErrors[chName]++
				m.stats.LastError = errMsg
				now := time.Now()
				m.stats.LastErrorAt = &now
				m.appendChannelLog(chName, entry)
				mqttPub := m.mqtt
				m.mu.Unlock()
				if mqttPub != nil {
					go mqttPub.PublishNotificationDispatch(string(evt.EventType()), key, chName, ch.Type(), msg, "error", sendErr.Error(), chResp)
				}
			} else {
				entry := ChannelLogEntry{
					At: time.Now(), Rule: key, EventType: string(evt.EventType()),
					Status: "sent", Response: chResp,
				}
				m.mu.Lock()
				m.stats.TotalSent++
				m.stats.ByRule[key]++
				m.stats.ByChannel[chName]++
				now := time.Now()
				m.stats.LastSentAt = &now
				m.appendChannelLog(chName, entry)
				mqttPub := m.mqtt
				m.mu.Unlock()
				if mqttPub != nil {
					go mqttPub.PublishNotificationDispatch(string(evt.EventType()), key, chName, ch.Type(), msg, "sent", "", chResp)
				}
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
		// Include the status so degraded and recovered events for the same
		// component use different rate-limit buckets. Without this, a recovery
		// alert fired within rate_limit_minutes of the preceding degraded alert
		// would be silently dropped — the user would never see the recovery.
		return e.Component + ":" + e.Status
	case UserSessionEvent:
		return string(e.Action) + ":" + e.ClientIP
	case VoiceActivityEvent:
		return fmt.Sprintf("voice:%s:%d", e.Band, e.EstimatedDialFreq/500*500)
	case DigitalRankEvent:
		return fmt.Sprintf("rank:%s:%s", e.Component, e.Dimension)
	case ServerStartupEvent:
		return "startup:" + e.Component
	case ChatEvent:
		if e.Action == ChatActionMessage {
			// Each message is unique content — include the text so every message
			// gets its own rate-limit bucket and none are suppressed by the channel
			// rate limiter when rate_limit_minutes is 0.
			return fmt.Sprintf("chat:message:%s:%s", e.Username, e.Message)
		}
		// joined/left: bucket per user+action so rapid rejoin spam is suppressed.
		return fmt.Sprintf("chat:%s:%s", e.Action, e.Username)
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
	case ChatEvent:
		switch key {
		case "username":
			return e.Username
		case "action":
			return string(e.Action)
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
	case DigitalRankEvent:
		return m.matchDigitalRank(e, f)
	case ServerStartupEvent:
		// Empty Components slice matches both "startup" and "shutdown".
		return matchStringSlice(e.Component, f.Components)
	case ChatEvent:
		return m.matchChat(e, f)
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
	// ExcludeBypassed: nil or true means suppress notifications for bypassed users.
	// Only pass through when explicitly set to false.
	excludeBypassed := f.ExcludeBypassed == nil || *f.ExcludeBypassed
	if excludeBypassed && e.Bypassed {
		return false
	}
	return true
}

func (m *NotificationManager) matchChat(e ChatEvent, f NotificationFilter) bool {
	if !matchStringSlice(string(e.Action), f.ChatActions) {
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

func (m *NotificationManager) matchDigitalRank(e DigitalRankEvent, f NotificationFilter) bool {
	// Component filter: "psk", "wspr", "rbn". Empty = match all.
	if !matchStringSlice(e.Component, f.RankComponents) {
		return false
	}
	// Direction filters — only one should be set; if both are set, both must match.
	if f.RankImproved != nil && *f.RankImproved {
		// Improved = rank number decreased, or first appearance (OldRank was 0).
		improved := (e.OldRank == 0 && e.NewRank > 0) || (e.OldRank > 0 && e.NewRank > 0 && e.NewRank < e.OldRank)
		if !improved {
			return false
		}
	}
	if f.RankWorsened != nil && *f.RankWorsened {
		// Worsened = rank number increased, or dropped off leaderboard (NewRank == 0).
		worsened := e.NewRank == 0 || (e.OldRank > 0 && e.NewRank > e.OldRank)
		if !worsened {
			return false
		}
	}
	// Threshold filter: only fire when new rank is at or better than N.
	if f.RankThreshold != nil && *f.RankThreshold > 0 {
		if e.NewRank == 0 || e.NewRank > *f.RankThreshold {
			return false
		}
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
			if len(e.Issues) > 0 {
				return fmt.Sprintf("✅ %s recovered: %s", e.Component, strings.Join(e.Issues, "; "))
			}
			return fmt.Sprintf("✅ %s recovered", e.Component)
		}
		issues := strings.Join(e.Issues, "; ")
		if issues == "" {
			issues = "unknown issue"
		}
		return fmt.Sprintf("❌ %s unhealthy: %s", e.Component, issues)

	case UserSessionEvent:
		base := fmt.Sprintf("👤 User %s: %s (%s)", e.Action, e.ClientIP, e.Country)
		counts := fmt.Sprintf("\n• Regular users: %d of %d", e.RegularUsers, e.MaxSessions)
		if e.BypassedUsers > 0 {
			counts += fmt.Sprintf("\n• Bypassed users: %d", e.BypassedUsers)
		}
		return base + counts

	case ChatEvent:
		switch e.Action {
		case ChatActionJoined:
			if e.ClientIP != "" {
				return fmt.Sprintf("💬 %s joined chat (%s)", e.Username, e.ClientIP)
			}
			return fmt.Sprintf("💬 %s joined chat", e.Username)
		case ChatActionLeft:
			if e.ClientIP != "" {
				return fmt.Sprintf("💬 %s left chat (%s)", e.Username, e.ClientIP)
			}
			return fmt.Sprintf("💬 %s left chat", e.Username)
		case ChatActionMessage:
			return fmt.Sprintf("💬 %s: %s", e.Username, e.Message)
		}
		return fmt.Sprintf("💬 Chat event: %s (%s)", e.Action, e.Username)

	case VoiceActivityEvent:
		dx := ""
		if e.DXCallsign != "" {
			dx = fmt.Sprintf(" [%s, %s]", e.DXCallsign, e.DXCountry)
		}
		return fmt.Sprintf("🎙️ Voice on %s @ %.3f MHz%s (SNR %.0f dB, conf %.0f%%)",
			e.Band, float64(e.EstimatedDialFreq)/1e6, dx, float64(e.SNR), float64(e.Confidence)*100)

	case DigitalRankEvent:
		oldStr := "unranked"
		if e.OldRank > 0 {
			oldStr = fmt.Sprintf("#%d", e.OldRank)
		}
		newStr := "unranked"
		if e.NewRank > 0 {
			newStr = fmt.Sprintf("#%d", e.NewRank)
		}
		// Direction indicator and places-moved suffix.
		// Lower rank number = better position, so OldRank > NewRank means improvement.
		// 🟢 ▲ = improved, 🔴 ▼ = worsened.
		dirEmoji := ""
		moveStr := ""
		if e.OldRank > 0 && e.NewRank > 0 {
			places := e.OldRank - e.NewRank // positive = improved
			if places > 0 {
				dirEmoji = "🟢 ▲"
				moveStr = fmt.Sprintf(" (+%d)", places)
			} else if places < 0 {
				dirEmoji = "🔴 ▼"
				moveStr = fmt.Sprintf(" (%d)", places)
			}
		} else if e.OldRank == 0 && e.NewRank > 0 {
			dirEmoji = "🟢 ▲" // entered the leaderboard
		} else if e.NewRank == 0 && e.OldRank > 0 {
			dirEmoji = "🔴 ▼" // dropped off the leaderboard
		}
		switch e.Component {
		case "psk":
			dimLabel := "reports"
			unit := "spots"
			if e.Dimension == "countries" {
				dimLabel = "countries"
				unit = "countries"
			}
			if e.NewRank > 0 {
				return fmt.Sprintf("📊 %s PSK %s rank: %s %s → %s%s (%d %s/24h)",
					dirEmoji, dimLabel, e.Callsign, oldStr, newStr, moveStr, e.NewValue, unit)
			}
			return fmt.Sprintf("📊 %s PSK %s rank: %s %s → %s%s",
				dirEmoji, dimLabel, e.Callsign, oldStr, newStr, moveStr)
		case "wspr":
			if e.NewRank > 0 {
				return fmt.Sprintf("📻 %s WSPR %s rank: %s %s → %s%s (%d unique spots)",
					dirEmoji, e.Dimension, e.Callsign, oldStr, newStr, moveStr, e.NewValue)
			}
			return fmt.Sprintf("📻 %s WSPR %s rank: %s %s → %s%s",
				dirEmoji, e.Dimension, e.Callsign, oldStr, newStr, moveStr)
		case "rbn":
			if e.NewRank > 0 && e.TotalRanked > 0 {
				return fmt.Sprintf("📡 %s RBN rank: %s %s → %s%s (%d spots, %d skimmers)",
					dirEmoji, e.Callsign, oldStr, newStr, moveStr, e.NewValue, e.TotalRanked)
			} else if e.NewRank > 0 {
				return fmt.Sprintf("📡 %s RBN rank: %s %s → %s%s (%d spots)",
					dirEmoji, e.Callsign, oldStr, newStr, moveStr, e.NewValue)
			}
			if e.TotalRanked > 0 {
				return fmt.Sprintf("📡 %s RBN rank: %s %s → %s%s (%d skimmers)",
					dirEmoji, e.Callsign, oldStr, newStr, moveStr, e.TotalRanked)
			}
			return fmt.Sprintf("📡 %s RBN rank: %s %s → %s%s", dirEmoji, e.Callsign, oldStr, newStr, moveStr)
		default:
			return fmt.Sprintf("📊 %s %s %s rank: %s %s → %s%s",
				dirEmoji, e.Component, e.Dimension, e.Callsign, oldStr, newStr, moveStr)
		}

	case ServerStartupEvent:
		if e.Component == "shutdown" {
			return fmt.Sprintf("🔄 UberSDR %s shutting down / restarting (%s)", e.Version, e.Callsign)
		}
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

	// Snapshot channels and config under the read lock so a concurrent Reload
	// cannot swap them mid-iteration.
	m.mu.RLock()
	channels := m.channels
	cfg := m.cfg
	m.mu.RUnlock()

	// Build per-channel detail including error rate and status.
	type channelDetail struct {
		Name         string  `json:"name"`
		Type         string  `json:"type"`
		Sent         int64   `json:"sent"`
		Errors       int64   `json:"errors"`
		RateLimited  int64   `json:"rate_limited"`
		Attempts     int64   `json:"attempts"`
		ErrorRatePct float64 `json:"error_rate_pct"`
		Status       string  `json:"status"` // "ok", "warning", "critical"
	}

	chDetails := make([]channelDetail, 0, len(channels))
	overallStatus := "ok"

	for name, ch := range channels {
		sent := stats.ByChannel[name]
		errs := stats.ByChannelErrors[name]
		rl := stats.ByChannelRateLimited[name]
		attempts := sent + errs // rate-limited never reached the channel
		var errRatePct float64
		chStatus := "ok"
		if attempts > 0 {
			errRatePct = float64(errs) / float64(attempts) * 100.0
			if errRatePct > 25.0 {
				chStatus = "critical"
			} else if errRatePct > 5.0 {
				chStatus = "warning"
			}
		} else if errs > 0 {
			// errors but no successful sends at all
			chStatus = "critical"
			errRatePct = 100.0
		}
		// escalate overall status
		if chStatus == "critical" {
			overallStatus = "critical"
		} else if chStatus == "warning" && overallStatus == "ok" {
			overallStatus = "warning"
		}
		chDetails = append(chDetails, channelDetail{
			Name:         name,
			Type:         ch.Type(),
			Sent:         sent,
			Errors:       errs,
			RateLimited:  rl,
			Attempts:     attempts,
			ErrorRatePct: errRatePct,
			Status:       chStatus,
		})
	}

	enabledRules := 0
	for _, r := range cfg.Rules {
		if r.IsEnabled() {
			enabledRules++
		}
	}

	return map[string]interface{}{
		"enabled":       cfg.Enabled,
		"channels":      chDetails,
		"total_rules":   len(cfg.Rules),
		"enabled_rules": enabledRules,
		"stats":         stats,
		"healthy":       overallStatus == "ok",
		"status":        overallStatus,
	}
}

// AppendTestChannelLog records a manual test-send result in the per-channel
// ring buffer. It acquires the write lock itself, unlike appendChannelLog which
// requires the caller to hold it.
func (m *NotificationManager) AppendTestChannelLog(chName string, entry ChannelLogEntry) {
	m.mu.Lock()
	m.appendChannelLog(chName, entry)
	m.mu.Unlock()
}

// appendChannelLog appends an entry to the per-channel ring buffer (last 10).
// Must be called with m.mu held (write lock).
func (m *NotificationManager) appendChannelLog(chName string, entry ChannelLogEntry) {
	if m.chanLogs == nil {
		m.chanLogs = make(map[string][]ChannelLogEntry)
	}
	buf := m.chanLogs[chName]
	buf = append(buf, entry)
	if len(buf) > maxChannelLogEntries {
		buf = buf[len(buf)-maxChannelLogEntries:]
	}
	m.chanLogs[chName] = buf
}

// GetChannelLog returns a copy of the response log for the named channel,
// newest-first. Returns nil if the channel has no log entries.
func (m *NotificationManager) GetChannelLog(chName string) []ChannelLogEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	src := m.chanLogs[chName]
	if len(src) == 0 {
		return nil
	}
	// Return newest-first copy.
	out := make([]ChannelLogEntry, len(src))
	for i, e := range src {
		out[len(src)-1-i] = e
	}
	return out
}
