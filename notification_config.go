package main

import (
	"fmt"
	"os"

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

// NotificationChannelConfig describes a single output channel.
// The Type field selects the implementation; remaining fields are
// type-specific and ignored when not relevant.
type NotificationChannelConfig struct {
	// Type selects the channel implementation.
	// Currently supported: "telegram"
	// Future: "email", "matrix", "ntfy", "webhook"
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

	// ── Rate limiting ────────────────────────────────────────────────────────
	// RateLimitMinutes suppresses duplicate alerts for the same
	// callsign+band (or component for system_monitor) within this window.
	// 0 = no rate limiting (every matching event fires).
	// Default: 10 minutes.
	RateLimitMinutes int `yaml:"rate_limit_minutes" json:"rate_limit_minutes"`
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
	//         server_startup
	Event NotificationEventType `yaml:"event" json:"event"`

	// Filter contains optional match criteria. All specified criteria must
	// match (AND logic). Omitting a field means "match anything".
	// JSON key is "filters" (plural) to match the admin UI convention.
	Filter NotificationFilter `yaml:"filter" json:"filters"`

	// Template is a Go text/template string rendered against the event struct.
	// Available template functions: flag, bearing, deref, divf, mulf, f32,
	// mhz, khz, join, upper, lower.
	// Leave empty to use the built-in default template for the event type.
	Template string `yaml:"template" json:"template"`

	// Channels is a list of channel names (keys in NotificationsConfig.Channels)
	// that receive the rendered message when this rule fires.
	Channels []string `yaml:"channels" json:"channels"`
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
	// AntSources matches source strings: "public", "admin", "startup", "scheduler".
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
		if ch.ParseMode == "" {
			ch.ParseMode = "HTML"
		}
		if ch.RateLimitMinutes == 0 {
			ch.RateLimitMinutes = 10
		}
		cfg.Channels[name] = ch
	}

	return &cfg, nil
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
	}

	return issues
}
