package main

import (
	"fmt"
	"html/template"
	"net"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// SaveNotificationsConfig marshals cfg to YAML and writes it atomically to
// filename (write to a temp file then rename so a crash mid-write never
// leaves a truncated file).
func SaveNotificationsConfig(filename string, cfg *NotificationsConfig) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal notifications config: %w", err)
	}

	// Write to a sibling temp file then rename for atomicity.
	tmp := filename + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("failed to write notifications config: %w", err)
	}
	if err := os.Rename(tmp, filename); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("failed to rename notifications config: %w", err)
	}
	return nil
}

// NotificationsConfig is the top-level structure loaded from notifications.yaml.
type NotificationsConfig struct {
	// Enabled is a master switch. When false the manager is a no-op.
	Enabled bool `yaml:"enabled" json:"enabled"`

	// Channels defines named output destinations (Telegram bots, etc.).
	// Each entry is keyed by a user-chosen name referenced in Rules.
	Channels map[string]NotificationChannelConfig `yaml:"channels" json:"channels"`

	// Rules is an ordered list of notification rules. Multiple rules can
	// match the same event; all matching rules fire independently.
	Rules []NotificationRule `yaml:"rules" json:"rules"`
}

// TelegramBotCommandsConfig configures the interactive bot command listener.
// When Enabled is true, a long-polling goroutine runs for the channel and
// responds to /commands sent by chat admins.
type TelegramBotCommandsConfig struct {
	// Enabled turns the command listener on or off.
	Enabled bool `yaml:"enabled" json:"enabled"`
	// Commands is the list of built-in command names to activate.
	// Unknown names are silently ignored so future commands can be added
	// without breaking existing configs.
	Commands []string `yaml:"commands,omitempty" json:"commands,omitempty"`
	// RWCommands is the subset of Commands for which write access is also
	// permitted (e.g. "/rotator 180" to move the rotator). Commands not in
	// this list are read-only even if they support write arguments.
	RWCommands []string `yaml:"rw_commands,omitempty" json:"rw_commands,omitempty"`
}

// NotificationChannelConfig describes a single output channel.
// The Type field selects the implementation; remaining fields are
// type-specific and ignored when not relevant.
type NotificationChannelConfig struct {
	// Type selects the channel implementation.
	// Currently supported: "telegram", "email"
	// Future: "matrix", "ntfy", "webhook"
	Type string `yaml:"type" json:"type"`

	// ── Telegram ────────────────────────────────────────────────────────────
	// BotToken is the token obtained from @BotFather.
	BotToken string `yaml:"bot_token" json:"bot_token"`
	// ChatID is the target chat (personal, group, or channel).
	// Use a negative number for groups/channels (e.g. -1001234567890).
	ChatID string `yaml:"chat_id" json:"chat_id"`
	// ParseMode controls Telegram message formatting.
	// Valid values: "HTML" (default), "Markdown", "MarkdownV2", or "" (plain text).
	ParseMode string `yaml:"parse_mode" json:"parse_mode"`
	// BotCommands configures the interactive command listener for this channel.
	// Only relevant when Type is "telegram".
	BotCommands TelegramBotCommandsConfig `yaml:"bot_commands,omitempty" json:"bot_commands,omitempty"`

	// ── Email (SMTP) ─────────────────────────────────────────────────────────
	// One generic SMTP channel covers every provider; only the host/port/
	// security/credentials differ. Gmail works with an App Password (the
	// account must have 2-Step Verification enabled) as SMTPPassword against
	// smtp.gmail.com:587 — no OAuth required.
	//
	// SMTPHost is the mail server hostname, e.g. "smtp.gmail.com".
	SMTPHost string `yaml:"smtp_host" json:"smtp_host"`
	// SMTPPort is the mail server port. Default: 587 (STARTTLS).
	SMTPPort int `yaml:"smtp_port" json:"smtp_port"`
	// SMTPSecurity selects the transport security:
	//   "starttls" (default) — connect plain then upgrade (port 587)
	//   "tls"                 — implicit TLS from the start (port 465)
	//   "none"                — no encryption (test/relay only; not recommended)
	SMTPSecurity string `yaml:"smtp_security" json:"smtp_security"`
	// SMTPUsername is the SMTP auth username (usually the full email address).
	// Leave empty for an unauthenticated relay.
	SMTPUsername string `yaml:"smtp_username" json:"smtp_username"`
	// SMTPPassword is the SMTP auth password. For Gmail this is the 16-character
	// App Password, not the account password.
	SMTPPassword string `yaml:"smtp_password" json:"smtp_password"`
	// EmailFrom is the From address. May be "Name <addr@example.com>" or a bare
	// address; the envelope sender is derived from it.
	EmailFrom string `yaml:"email_from" json:"email_from"`
	// EmailTo is the list of recipient addresses.
	EmailTo []string `yaml:"email_to" json:"email_to"`
	// SubjectPrefix is prepended to the dynamic subject line. The subject of each
	// notification is "<prefix> <first line of the rendered message>".
	// Default: "[UberSDR]".
	SubjectPrefix string `yaml:"subject_prefix" json:"subject_prefix"`

	// ── Rate limiting ────────────────────────────────────────────────────────
	// RateLimitMinutes suppresses duplicate alerts for the same
	// callsign+band (or component for system_monitor) within this window.
	// 0 = no rate limiting (every matching event fires).
	// Default: 10 minutes.
	RateLimitMinutes int `yaml:"rate_limit_minutes" json:"rate_limit_minutes"`

	// ── Webhook (HTTP POST) ───────────────────────────────────────────────────
	// WebhookURL is the endpoint to POST to. Must be http:// or https://.
	// Required when Type is "webhook".
	WebhookURL string `yaml:"webhook_url,omitempty" json:"webhook_url,omitempty"`
	// WebhookMethod is the HTTP method. "POST" (default) or "PUT".
	WebhookMethod string `yaml:"webhook_method,omitempty" json:"webhook_method,omitempty"`
	// WebhookFormat controls the Content-Type and body shape:
	//   "text"    (default) — text/plain, body = rendered message (ntfy, custom)
	//   "json"              — application/json structured envelope (n8n, Zapier, HA)
	//   "slack"             — application/json {"text":"…"} (Slack incoming webhooks)
	//   "discord"           — application/json {"content":"…"} (Discord webhooks)
	WebhookFormat string `yaml:"webhook_format,omitempty" json:"webhook_format,omitempty"`
	// WebhookSecret is an optional HMAC-SHA256 signing secret. When set, every
	// request carries X-Hub-Signature-256: sha256=<hmac> so the receiver can
	// verify authenticity. Never returned by the GET config endpoint.
	WebhookSecret string `yaml:"webhook_secret,omitempty" json:"webhook_secret,omitempty"`
	// WebhookHeaders holds extra HTTP headers sent with every request, e.g.
	// {"Authorization": "Bearer <token>", "X-Gotify-Key": "<token>"}.
	// Header names and values are validated for printable ASCII on save.
	WebhookHeaders map[string]string `yaml:"webhook_headers,omitempty" json:"webhook_headers,omitempty"`
	// WebhookTimeoutSeconds is the per-request timeout. Default: 10. Range: 1–60.
	WebhookTimeoutSeconds int `yaml:"webhook_timeout_seconds,omitempty" json:"webhook_timeout_seconds,omitempty"`
	// WebhookInsecureSkipVerify disables TLS certificate verification.
	// Only for self-signed certificates on private LANs — never use on public endpoints.
	WebhookInsecureSkipVerify bool `yaml:"webhook_insecure_skip_verify,omitempty" json:"webhook_insecure_skip_verify,omitempty"`
	// WebhookBodyTemplate is an optional Go text/template string that, when set,
	// overrides WebhookFormat entirely and renders the full request body.
	// The template receives a WebhookTemplateData struct with fields:
	//   .Message   string    — the rendered notification text
	//   .Channel   string    — the channel name
	//   .Timestamp string    — UTC time in RFC3339 format
	// The Content-Type defaults to application/json when the template is set;
	// override it by setting a "Content-Type" entry in WebhookHeaders.
	// Example (Gotify): {"message":"{{.Message}}","title":"UberSDR","priority":5}
	WebhookBodyTemplate string `yaml:"webhook_body_template,omitempty" json:"webhook_body_template,omitempty"`
}

// NotificationRule maps an event type to a filter, a template, and one or
// more output channels.
type NotificationRule struct {
	// Name is a human-readable label shown in logs and the admin API.
	Name string `yaml:"name" json:"name"`

	// Enabled allows individual rules to be toggled without removing them.
	// Defaults to true when omitted.
	Enabled *bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`

	// Event is the event type this rule matches.
	// One of: cw_spot, dx_spot, digital_decode, space_weather,
	//         antenna_switch, rotator, system_monitor, user_session,
	//         server_startup, chat
	Event NotificationEventType `yaml:"event" json:"event"`

	// Filter contains optional match criteria. All specified criteria must
	// match (AND logic). Omitting a field means "match anything".
	// JSON key is "filters" (plural) to match the admin UI convention.
	Filter NotificationFilter `yaml:"filter" json:"filters"`

	// Template is a Go text/template string rendered against the event struct.
	// Available template functions: flag, bearing, deref, divf, mulf, f32,
	// mhz, khz, join, upper, lower.
	// Leave empty to use the built-in default template for the event type.
	// It is the default body for every channel; Templates can override it
	// per channel (e.g. HTML markup for Telegram vs. plain wording for email).
	Template string `yaml:"template" json:"template"`

	// Templates holds optional per-channel template overrides, keyed by channel
	// name. When a channel listed in Channels has an entry here, that template is
	// rendered for it instead of Template; channels without an entry fall back to
	// Template (and then to the built-in default). This lets one rule format its
	// message differently for each transport rather than sharing a single body.
	Templates map[string]string `yaml:"templates,omitempty" json:"templates,omitempty"`

	// Channels is a list of channel names (keys in NotificationsConfig.Channels)
	// that receive the rendered message when this rule fires.
	Channels []string `yaml:"channels" json:"channels"`

	// DedupBy turns a high-volume spot rule into a "notify once per new X" rule.
	// Each entry names a dimension of the event (see dedupKeysForEvent); the rule
	// fires only the first time a given combination of those values is seen within
	// DedupWindowMinutes. For example DedupBy ["country_code"] on a digital_decode
	// rule fires once the first time each DXCC is decoded instead of on every
	// decode. Empty = no deduplication (every matching event fires).
	DedupBy []string `yaml:"dedup_by,omitempty" json:"dedup_by,omitempty"`

	// DedupWindowMinutes is how long a value stays "seen" before it can notify
	// again. 0 (with a non-empty DedupBy) means once per value until the server
	// restarts. Ignored when DedupBy is empty.
	DedupWindowMinutes int `yaml:"dedup_window_minutes,omitempty" json:"dedup_window_minutes,omitempty"`
}

// highVolumeSpotEvents are the event types that fire many times per minute, for
// which a rule must narrow its volume via a selective filter or DedupBy.
var highVolumeSpotEvents = map[NotificationEventType]bool{
	EventTypeCWSpot:        true,
	EventTypeDXSpot:        true,
	EventTypeDigitalDecode: true,
}

// dedupKeysForEvent returns the set of valid DedupBy keys for an event type.
// Keys correspond to fields actually present on the event struct.
func dedupKeysForEvent(evt NotificationEventType) map[string]bool {
	switch evt {
	case EventTypeCWSpot, EventTypeDigitalDecode:
		return map[string]bool{
			"callsign": true, "country": true, "country_code": true,
			"continent": true, "cq_zone": true, "itu_zone": true,
			"band": true, "mode": true,
		}
	case EventTypeDXSpot:
		// DX cluster spots carry no zone or mode information.
		return map[string]bool{
			"callsign": true, "country": true, "country_code": true,
			"continent": true, "band": true,
		}
	case EventTypeChat:
		return map[string]bool{
			"username": true, "action": true,
		}
	default:
		return nil
	}
}

// filterNarrowsHighVolume reports whether f contains at least one criterion
// selective enough to keep a high-volume spot rule from firing on essentially
// every event. Band, mode and SNR/WPM thresholds deliberately do NOT count — a
// whole band of FT8 is still hundreds of decodes per minute.
func filterNarrowsHighVolume(f NotificationFilter) bool {
	return len(f.Callsigns) > 0 ||
		len(f.CallsignPrefixes) > 0 ||
		len(f.Countries) > 0 ||
		len(f.CountryCodes) > 0 ||
		len(f.Continents) > 0 ||
		len(f.CQZones) > 0 ||
		len(f.ITUZones) > 0 ||
		f.MinDistanceKm != nil ||
		f.MaxDistanceKm != nil ||
		len(f.MessageContains) > 0 ||
		len(f.CommentContains) > 0 ||
		len(f.Spotters) > 0
}

// IsEnabled returns true if the rule is enabled (nil pointer defaults to true).
func (r *NotificationRule) IsEnabled() bool {
	return r.Enabled == nil || *r.Enabled
}

// NotificationFilter holds all optional filter criteria for a rule.
// All non-zero/non-empty fields must match for the rule to fire.
// Within a slice field, any element matching is sufficient (OR within field).
type NotificationFilter struct {
	// ── Callsign / station filters (cw_spot, dx_spot, digital_decode) ───────
	// Callsigns is an exact-match list of callsigns to watch for.
	Callsigns []string `yaml:"callsigns,omitempty" json:"callsigns,omitempty"`
	// CallsignPrefixes matches callsigns that start with any of these prefixes.
	CallsignPrefixes []string `yaml:"callsign_prefixes,omitempty" json:"callsign_prefixes,omitempty"`

	// ── Geography (cw_spot, dx_spot, digital_decode) ─────────────────────────
	// Countries matches the CTY country name (e.g. "Japan").
	Countries []string `yaml:"countries,omitempty" json:"countries,omitempty"`
	// CountryCodes matches ISO 3166-1 alpha-2 codes (e.g. "JP").
	CountryCodes []string `yaml:"country_codes,omitempty" json:"country_codes,omitempty"`
	// Continents matches continent codes: NA, SA, EU, AF, AS, OC, AN.
	Continents []string `yaml:"continents,omitempty" json:"continents,omitempty"`
	// CQZones matches CQ zone numbers.
	CQZones []int `yaml:"cq_zones,omitempty" json:"cq_zones,omitempty"`
	// ITUZones matches ITU zone numbers.
	ITUZones []int `yaml:"itu_zones,omitempty" json:"itu_zones,omitempty"`

	// ── Band / frequency (cw_spot, dx_spot, digital_decode) ──────────────────
	// Bands matches band names (e.g. "20m", "40m").
	Bands []string `yaml:"bands,omitempty" json:"bands,omitempty"`

	// ── Signal quality (cw_spot, digital_decode) ─────────────────────────────
	// MinSNR requires SNR >= this value (dB). Omit or set to 0 to disable.
	MinSNR *int `yaml:"min_snr,omitempty" json:"min_snr,omitempty"`
	// MaxSNR requires SNR <= this value (dB). Omit to disable.
	MaxSNR *int `yaml:"max_snr,omitempty" json:"max_snr,omitempty"`

	// ── CW-specific (cw_spot) ────────────────────────────────────────────────
	// MinWPM requires WPM >= this value.
	MinWPM *int `yaml:"min_wpm,omitempty" json:"min_wpm,omitempty"`
	// Modes matches CW mode strings: "CW", "RTTY".
	Modes []string `yaml:"modes,omitempty" json:"modes,omitempty"`

	// ── Digital-mode-specific (digital_decode) ───────────────────────────────
	// DigitalModes matches decode mode strings: "FT8", "FT4", "WSPR", "JS8".
	DigitalModes []string `yaml:"digital_modes,omitempty" json:"digital_modes,omitempty"`
	// MessageContains requires the decoded message to contain any of these substrings.
	MessageContains []string `yaml:"message_contains,omitempty" json:"message_contains,omitempty"`

	// ── Distance (cw_spot, digital_decode) ───────────────────────────────────
	// MinDistanceKm requires distance >= this value (km). Useful for DX-only alerts.
	MinDistanceKm *float64 `yaml:"min_distance_km,omitempty" json:"min_distance_km,omitempty"`
	// MaxDistanceKm requires distance <= this value (km). Useful for local alerts.
	MaxDistanceKm *float64 `yaml:"max_distance_km,omitempty" json:"max_distance_km,omitempty"`

	// ── DX Cluster (dx_spot) ─────────────────────────────────────────────────
	// CommentContains requires the spot comment to contain any of these substrings.
	CommentContains []string `yaml:"comment_contains,omitempty" json:"comment_contains,omitempty"`
	// Spotters filters by spotter callsign (exact match).
	Spotters []string `yaml:"spotters,omitempty" json:"spotters,omitempty"`

	// ── Space weather (space_weather) ────────────────────────────────────────
	// KMin fires when KIndex >= this value.
	KMin *int `yaml:"k_min,omitempty" json:"k_min,omitempty"`
	// KMax fires when KIndex <= this value.
	KMax *int `yaml:"k_max,omitempty" json:"k_max,omitempty"`
	// AMin fires when AIndex >= this value.
	AMin *int `yaml:"a_min,omitempty" json:"a_min,omitempty"`
	// SFIMin fires when SFI >= this value (good conditions alert).
	SFIMin *float64 `yaml:"sfi_min,omitempty" json:"sfi_min,omitempty"`
	// SFIMax fires when SFI <= this value (poor conditions alert).
	SFIMax *float64 `yaml:"sfi_max,omitempty" json:"sfi_max,omitempty"`

	// ── Antenna switch (antenna_switch) ──────────────────────────────────────
	// AntActions matches action strings: "select", "ground", "add", "remove".
	AntActions []string `yaml:"ant_actions,omitempty" json:"ant_actions,omitempty"`
	// AntNumbers matches specific antenna numbers.
	AntNumbers []int `yaml:"ant_numbers,omitempty" json:"ant_numbers,omitempty"`
	// AntSources matches source strings: "public", "admin", "startup", "sync", "scheduler".
	AntSources []string `yaml:"ant_sources,omitempty" json:"ant_sources,omitempty"`

	// ── Rotator (rotator) ────────────────────────────────────────────────────
	// RotatorMoving: true = only fire when moving starts, false = only when stops.
	// Omit (nil) to fire on any rotator event.
	RotatorMoving *bool `yaml:"rotator_moving,omitempty" json:"rotator_moving,omitempty"`

	// ── System monitor (system_monitor) ──────────────────────────────────────
	// Components matches subsystem names: "decoder", "cw_skimmer", "mqtt",
	// "noise_floor", "space_weather", "rotator", "ant_switch", "ntp", etc.
	// Empty = match all components.
	Components []string `yaml:"components,omitempty" json:"components,omitempty"`
	// OnUnhealthy fires when a component transitions to unhealthy.
	OnUnhealthy *bool `yaml:"on_unhealthy,omitempty" json:"on_unhealthy,omitempty"`
	// OnRecovery fires when a component transitions back to healthy.
	OnRecovery *bool `yaml:"on_recovery,omitempty" json:"on_recovery,omitempty"`
	// FlapDetection suppresses repeated transition alerts for a component that is
	// oscillating between healthy and unhealthy (e.g. system load near a
	// threshold). nil = enabled (the default); set false to disable. When a
	// component flaps, one "flap detection activated" alert is sent and further
	// transition alerts are held until it stabilises; a "stabilised" alert is
	// then sent and normal alerting resumes.
	FlapDetection *bool `yaml:"flap_detection,omitempty" json:"flap_detection,omitempty"`
	// FlapThreshold is the number of healthy↔unhealthy transitions within
	// FlapWindowMinutes that marks a component as flapping. nil = default (6).
	FlapThreshold *int `yaml:"flap_threshold,omitempty" json:"flap_threshold,omitempty"`
	// FlapWindowMinutes is the rolling look-back window for counting transitions.
	// nil = default (10).
	FlapWindowMinutes *int `yaml:"flap_window_minutes,omitempty" json:"flap_window_minutes,omitempty"`
	// FlapClearMinutes is how long a flapping component must stay stable (no
	// transitions) before it clears and normal alerting resumes. nil = default
	// (15). This is what stops flap detection from suppressing alerts forever.
	FlapClearMinutes *int `yaml:"flap_clear_minutes,omitempty" json:"flap_clear_minutes,omitempty"`

	// ── Voice activity (voice_activity) ──────────────────────────────────────
	// VoiceBands matches band names (e.g. "20m", "40m"). Empty = all bands.
	VoiceBands []string `yaml:"voice_bands,omitempty" json:"voice_bands,omitempty"`
	// VoiceCountryCodes matches the DX cluster enriched country code (ISO alpha-2).
	// Only fires when a callsign has been spotted on the frequency.
	VoiceCountryCodes []string `yaml:"voice_country_codes,omitempty" json:"voice_country_codes,omitempty"`
	// VoiceContinents matches the DX cluster enriched continent code.
	VoiceContinents []string `yaml:"voice_continents,omitempty" json:"voice_continents,omitempty"`
	// VoiceCallsigns matches the DX cluster enriched callsign (exact match).
	VoiceCallsigns []string `yaml:"voice_callsigns,omitempty" json:"voice_callsigns,omitempty"`
	// VoiceMinSNR requires SNR >= this value (dB).
	VoiceMinSNR *float32 `yaml:"voice_min_snr,omitempty" json:"voice_min_snr,omitempty"`
	// VoiceMinConfidence requires confidence >= this value (0.0–1.0).
	VoiceMinConfidence *float32 `yaml:"voice_min_confidence,omitempty" json:"voice_min_confidence,omitempty"`

	// ── User session (user_session) ───────────────────────────────────────────
	// SessionActions matches "connected" or "disconnected".
	SessionActions []string `yaml:"session_actions,omitempty" json:"session_actions,omitempty"`
	// SessionCountryCodes matches the connecting user's country (ISO alpha-2).
	SessionCountryCodes []string `yaml:"session_country_codes,omitempty" json:"session_country_codes,omitempty"`
	// SessionContinents matches the connecting user's continent code.
	SessionContinents []string `yaml:"session_continents,omitempty" json:"session_continents,omitempty"`
	// UserAgentContains matches if the user agent contains any of these substrings.
	UserAgentContains []string `yaml:"user_agent_contains,omitempty" json:"user_agent_contains,omitempty"`
	// ClientIPs matches specific client IP addresses.
	ClientIPs []string `yaml:"client_ips,omitempty" json:"client_ips,omitempty"`
	// ExcludeBypassed suppresses notifications for users who authenticated via a
	// bypass password or whose IP is in the timeout_bypass_ips list.
	// nil (omitted) and true both mean "exclude bypassed users" (the default).
	// Set to false to also receive notifications for bypassed users.
	ExcludeBypassed *bool `yaml:"exclude_bypassed,omitempty" json:"exclude_bypassed,omitempty"`

	// ── Chat (chat) ───────────────────────────────────────────────────────────
	// ChatActions matches "joined", "left", or "message".
	ChatActions []string `yaml:"chat_actions,omitempty" json:"chat_actions,omitempty"`

	// ── Digital Rank (digital_rank) ───────────────────────────────────────────
	// RankComponents selects which ranking systems to watch.
	// Valid values: "psk", "wspr", "rbn". Empty = all enabled components.
	RankComponents []string `yaml:"rank_components,omitempty" json:"rank_components,omitempty"`
	// RankImproved fires only when rank improves (number decreases, or first appearance).
	// nil (omitted) = fire on any rank change.
	RankImproved *bool `yaml:"rank_improved,omitempty" json:"rank_improved,omitempty"`
	// RankWorsened fires only when rank worsens (number increases or drops off leaderboard).
	// nil (omitted) = fire on any rank change.
	RankWorsened *bool `yaml:"rank_worsened,omitempty" json:"rank_worsened,omitempty"`
	// RankThreshold fires only when the new rank is at or better than this value
	// (e.g. 10 = only fire when in the top 10). 0 or nil = no threshold.
	RankThreshold *int `yaml:"rank_threshold,omitempty" json:"rank_threshold,omitempty"`
}

// LoadNotificationsConfig loads the notifications configuration from a YAML file.
// Returns a disabled config (not an error) when the file does not exist, so the
// server starts normally without a notifications.yaml.
func LoadNotificationsConfig(filename string) (*NotificationsConfig, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		if os.IsNotExist(err) {
			return &NotificationsConfig{Enabled: false}, nil
		}
		return nil, fmt.Errorf("failed to read notifications config: %w", err)
	}

	var cfg NotificationsConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse notifications config: %w", err)
	}

	// Apply defaults
	for name, ch := range cfg.Channels {
		applyChannelDefaults(&ch)
		cfg.Channels[name] = ch
	}

	return &cfg, nil
}

// applyChannelDefaults fills in the conventional defaults for a channel config.
// It is shared by LoadNotificationsConfig and the admin API PUT handler so a
// hand-edited file and an admin-UI save behave identically.
func applyChannelDefaults(ch *NotificationChannelConfig) {
	if ch.ParseMode == "" {
		ch.ParseMode = "HTML"
	}
	if ch.RateLimitMinutes == 0 {
		ch.RateLimitMinutes = 10
	}
	if ch.Type == "email" {
		if ch.SMTPPort == 0 {
			ch.SMTPPort = 587
		}
		if ch.SMTPSecurity == "" {
			ch.SMTPSecurity = "starttls"
		}
		if ch.SubjectPrefix == "" {
			ch.SubjectPrefix = "[UberSDR]"
		}
	}
	if ch.Type == "webhook" {
		if ch.WebhookMethod == "" {
			ch.WebhookMethod = "POST"
		}
		if ch.WebhookFormat == "" {
			ch.WebhookFormat = "text"
		}
		if ch.WebhookTimeoutSeconds == 0 {
			ch.WebhookTimeoutSeconds = 10
		}
	}
}

// Validate checks the config for obvious errors and returns a list of issues.
func (cfg *NotificationsConfig) Validate() []string {
	var issues []string
	if !cfg.Enabled {
		return issues
	}

	for name, ch := range cfg.Channels {
		switch ch.Type {
		case "telegram":
			if ch.BotToken == "" {
				issues = append(issues, fmt.Sprintf("channel %q: telegram bot_token is required", name))
			}
			if ch.ChatID == "" {
				issues = append(issues, fmt.Sprintf("channel %q: telegram chat_id is required", name))
			}
		case "email":
			if ch.SMTPHost == "" {
				issues = append(issues, fmt.Sprintf("channel %q: email smtp_host is required", name))
			}
			if ch.EmailFrom == "" {
				issues = append(issues, fmt.Sprintf("channel %q: email email_from is required", name))
			}
			if len(ch.EmailTo) == 0 {
				issues = append(issues, fmt.Sprintf("channel %q: email needs at least one email_to recipient", name))
			}
			switch ch.SMTPSecurity {
			case "", "starttls", "tls", "none":
			default:
				issues = append(issues, fmt.Sprintf("channel %q: email smtp_security must be starttls, tls, or none (got %q)", name, ch.SMTPSecurity))
			}
			// A username with no password (or vice-versa) is almost always a mistake.
			if (ch.SMTPUsername == "") != (ch.SMTPPassword == "") {
				issues = append(issues, fmt.Sprintf("channel %q: email smtp_username and smtp_password must be set together", name))
			}
		case "webhook":
			issues = append(issues, validateWebhookChannel(name, ch)...)
		case "":
			issues = append(issues, fmt.Sprintf("channel %q: type is required", name))
		default:
			issues = append(issues, fmt.Sprintf("channel %q: unknown type %q", name, ch.Type))
		}
	}

	validEvents := map[NotificationEventType]bool{
		EventTypeCWSpot:        true,
		EventTypeDXSpot:        true,
		EventTypeDigitalDecode: true,
		EventTypeSpaceWeather:  true,
		EventTypeAntennaSwitch: true,
		EventTypeRotator:       true,
		EventTypeSystemMonitor: true,
		EventTypeUserSession:   true,
		EventTypeServerStartup: true,
		EventTypeVoiceActivity: true,
		EventTypeDigitalRank:   true,
		EventTypeChat:          true,
	}

	for i, rule := range cfg.Rules {
		label := rule.Name
		if label == "" {
			label = fmt.Sprintf("rule[%d]", i)
		}
		if !validEvents[rule.Event] {
			issues = append(issues, fmt.Sprintf("%s: unknown event type %q", label, rule.Event))
		}
		for _, ch := range rule.Channels {
			if _, ok := cfg.Channels[ch]; !ok {
				issues = append(issues, fmt.Sprintf("%s: references unknown channel %q", label, ch))
			}
		}
		if len(rule.Channels) == 0 {
			issues = append(issues, fmt.Sprintf("%s: no channels specified", label))
		}
		// Per-channel template overrides must target a channel the rule sends to,
		// otherwise the override is dead config.
		for chName := range rule.Templates {
			inRule := false
			for _, c := range rule.Channels {
				if c == chName {
					inRule = true
					break
				}
			}
			if !inRule {
				issues = append(issues, fmt.Sprintf("%s: template override for channel %q which is not in the rule's channels", label, chName))
			}
		}

		// High-volume spot events (cw_spot, dx_spot, digital_decode) fire many
		// times per minute. A rule with no selective filter and no deduplication
		// would notify on every spot — hundreds per minute. Require one or the
		// other.
		if highVolumeSpotEvents[rule.Event] {
			validKeys := dedupKeysForEvent(rule.Event)
			for _, k := range rule.DedupBy {
				if !validKeys[k] {
					issues = append(issues, fmt.Sprintf("%s: invalid dedup_by key %q for event %q", label, k, rule.Event))
				}
			}
			if rule.DedupWindowMinutes < 0 {
				issues = append(issues, fmt.Sprintf("%s: dedup_window_minutes cannot be negative", label))
			}
			if len(rule.DedupBy) == 0 && !filterNarrowsHighVolume(rule.Filter) {
				issues = append(issues, fmt.Sprintf(
					"%s: %q rules fire on every spot (hundreds per minute) — add a selective filter "+
						"(callsign, country, continent, CQ/ITU zone, distance, or message/comment text) "+
						"or set 'notify once per' (dedup_by) to limit volume",
					label, rule.Event))
			}
		}

		// System monitor flap-detection parameters must be sensible when present.
		// A missing value is fine (the notifier substitutes a default); a present
		// value that is out of range is rejected so the admin sees the mistake.
		if rule.Event == EventTypeSystemMonitor {
			issues = append(issues, validateFlapParams(label, rule.Filter)...)
		}
	}

	return issues
}

// flap parameter bounds. Minimums guard correctness; the generous maximums catch
// fat-finger errors (e.g. a window of 100000) without constraining real use.
const (
	minFlapThreshold     = 2     // a flap needs at least an up+down pair
	maxFlapThreshold     = 1000  //
	minFlapWindowMinutes = 1     //
	maxFlapWindowMinutes = 10080 // one week
	minFlapClearMinutes  = 1     //
	maxFlapClearMinutes  = 10080 // one week
)

// validateFlapParams checks that any explicitly-set flap-detection values are in
// range. nil values are intentionally allowed (defaults apply at runtime).
func validateFlapParams(label string, f NotificationFilter) []string {
	var issues []string
	if v := f.FlapThreshold; v != nil && (*v < minFlapThreshold || *v > maxFlapThreshold) {
		issues = append(issues, fmt.Sprintf("%s: flap_threshold must be between %d and %d (got %d)",
			label, minFlapThreshold, maxFlapThreshold, *v))
	}
	if v := f.FlapWindowMinutes; v != nil && (*v < minFlapWindowMinutes || *v > maxFlapWindowMinutes) {
		issues = append(issues, fmt.Sprintf("%s: flap_window_minutes must be between %d and %d (got %d)",
			label, minFlapWindowMinutes, maxFlapWindowMinutes, *v))
	}
	if v := f.FlapClearMinutes; v != nil && (*v < minFlapClearMinutes || *v > maxFlapClearMinutes) {
		issues = append(issues, fmt.Sprintf("%s: flap_clear_minutes must be between %d and %d (got %d)",
			label, minFlapClearMinutes, maxFlapClearMinutes, *v))
	}
	return issues
}

// ── Webhook validation helpers ────────────────────────────────────────────────

// validateWebhookChannel checks all webhook-specific fields for a channel.
func validateWebhookChannel(name string, ch NotificationChannelConfig) []string {
	var issues []string

	// URL — required, must be http:// or https://, max 2048 chars, must have a host.
	if ch.WebhookURL == "" {
		issues = append(issues, fmt.Sprintf("channel %q: webhook_url is required", name))
	} else if len(ch.WebhookURL) > 2048 {
		issues = append(issues, fmt.Sprintf("channel %q: webhook_url exceeds 2048 characters", name))
	} else {
		// Use net/url via strings — avoid importing net/url just for this; parse manually.
		// We need the scheme and host, so do a minimal parse.
		lower := strings.ToLower(ch.WebhookURL)
		var scheme, rest string
		if idx := strings.Index(ch.WebhookURL, "://"); idx >= 0 {
			scheme = lower[:idx]
			rest = ch.WebhookURL[idx+3:]
		}
		if scheme != "http" && scheme != "https" {
			issues = append(issues, fmt.Sprintf("channel %q: webhook_url must start with http:// or https://", name))
		} else {
			// Extract host (everything before the first / or end of string).
			host := rest
			if i := strings.IndexByte(rest, '/'); i >= 0 {
				host = rest[:i]
			}
			// Strip port for loopback check.
			if host == "" {
				issues = append(issues, fmt.Sprintf("channel %q: webhook_url has no host", name))
			} else if scheme == "http" && !webhookIsPrivateHost(host) {
				// Plain http to a clearly public host — block it. LAN addresses
				// (loopback, RFC-1918, .local) are allowed without https.
				issues = append(issues, fmt.Sprintf("channel %q: webhook_url uses plain http:// to a public host — use https:// to protect credentials and payloads", name))
			}
		}
	}

	// Method — POST or PUT only.
	switch strings.ToUpper(ch.WebhookMethod) {
	case "", "POST", "PUT":
	default:
		issues = append(issues, fmt.Sprintf("channel %q: webhook_method must be POST or PUT (got %q)", name, ch.WebhookMethod))
	}

	// Format — known values only.
	switch ch.WebhookFormat {
	case "", "text", "json", "slack", "discord":
	default:
		issues = append(issues, fmt.Sprintf("channel %q: webhook_format must be text, json, slack, or discord (got %q)", name, ch.WebhookFormat))
	}

	// Timeout — 0 means "use default" (applied by applyChannelDefaults); explicit values must be 1–60.
	if ch.WebhookTimeoutSeconds != 0 && (ch.WebhookTimeoutSeconds < 1 || ch.WebhookTimeoutSeconds > 60) {
		issues = append(issues, fmt.Sprintf("channel %q: webhook_timeout_seconds must be 1–60 (got %d)", name, ch.WebhookTimeoutSeconds))
	}

	// Headers — validate names (RFC 7230 token) and values (printable ASCII, no CR/LF).
	for k, v := range ch.WebhookHeaders {
		if !webhookValidHeaderName(k) {
			issues = append(issues, fmt.Sprintf("channel %q: webhook header name %q is not a valid HTTP header name", name, k))
		}
		if !webhookValidHeaderValue(v) {
			issues = append(issues, fmt.Sprintf("channel %q: webhook header %q has an invalid value (must be printable ASCII, no CR or LF)", name, k))
		}
	}

	// InsecureSkipVerify only makes sense with https — flag it as a useless setting.
	// (It's not a security risk to have it set with http://, just pointless.)
	if ch.WebhookInsecureSkipVerify {
		lower := strings.ToLower(ch.WebhookURL)
		if !strings.HasPrefix(lower, "https://") {
			issues = append(issues, fmt.Sprintf("channel %q: webhook_insecure_skip_verify has no effect without https://", name))
		}
	}

	// Body template — compile-check it at save time so errors surface immediately.
	// Use the same FuncMap as the runtime so template functions like jsonEscape
	// are recognised during validation.
	if ch.WebhookBodyTemplate != "" {
		if _, err := template.New("webhook_body").Funcs(webhookTemplateFuncs).Parse(ch.WebhookBodyTemplate); err != nil {
			issues = append(issues, fmt.Sprintf("channel %q: webhook_body_template is not a valid Go template: %v", name, err))
		}
	}

	return issues
}

// WebhookTemplateData is the data passed to WebhookBodyTemplate when rendering
// the request body. All fields are safe to use in JSON templates directly.
type WebhookTemplateData struct {
	// Message is the fully-rendered notification text (from the rule template or
	// the built-in default). May contain newlines.
	Message string
	// Channel is the webhook channel name as configured in notifications.yaml.
	Channel string
	// Timestamp is the current UTC time in RFC3339 format (e.g. "2026-07-01T11:00:00Z").
	Timestamp string
}

// webhookIsPrivateHost reports whether host (with or without port) is a
// private/LAN address where plain http:// is acceptable:
//   - loopback: localhost, 127.x.x.x, ::1
//   - RFC-1918: 10.x, 172.16-31.x, 192.168.x
//   - link-local: 169.254.x, fe80::
//   - mDNS .local names (e.g. homeassistant.local)
func webhookIsPrivateHost(host string) bool {
	h := host
	// Strip port if present.
	if strings.Contains(h, ":") {
		if stripped, _, err := net.SplitHostPort(h); err == nil {
			h = stripped
		}
	}
	// mDNS / .local hostnames.
	if strings.HasSuffix(strings.ToLower(h), ".local") || strings.ToLower(h) == "local" {
		return true
	}
	// Named loopback.
	if strings.ToLower(h) == "localhost" {
		return true
	}
	// Parse as IP.
	ip := net.ParseIP(h)
	if ip == nil {
		return false // unknown hostname — treat as public
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// webhookHeaderNameRe matches a valid RFC 7230 header field name (token).
var webhookHeaderNameRe = regexp.MustCompile(`^[!#$%&'*+\-.0-9A-Z^_` + "`" + `a-z|~]+$`)

// webhookValidHeaderName reports whether s is a valid HTTP header field name.
func webhookValidHeaderName(s string) bool {
	return s != "" && webhookHeaderNameRe.MatchString(s)
}

// webhookValidHeaderValue reports whether s is a valid HTTP header field value:
// printable ASCII (0x20–0x7E) plus horizontal tab (0x09), no CR or LF.
func webhookValidHeaderValue(s string) bool {
	for _, c := range s {
		if c == '\r' || c == '\n' || (c < 0x20 && c != '\t') || c == 0x7f {
			return false
		}
	}
	return true
}
