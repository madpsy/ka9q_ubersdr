package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// handleNotificationsHealth returns the current health and statistics of the
// notification manager.
//
// GET /admin/notifications/health
func handleNotificationsHealth(w http.ResponseWriter, r *http.Request, nm *NotificationManager) {
	w.Header().Set("Content-Type", "application/json")

	if nm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
			"enabled": false,
			"error":   "notification manager not initialised",
		})
		return
	}

	health := nm.GetHealth()
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(health) //nolint:errcheck
}

// handleNotificationsTest sends a test message and returns detailed feedback.
//
// POST /admin/notifications/test
//
// Two modes:
//
//  1. Named channel (channel must exist in notifications.yaml):
//     {"channel": "telegram_main"}
//     {"channel": "telegram_main", "message": "custom text"}
//
//  2. Ad-hoc credentials (no config required — useful during initial setup):
//     {"type": "telegram", "bot_token": "7123…", "chat_id": "-100123…"}
//     {"type": "telegram", "bot_token": "7123…", "chat_id": "-100123…",
//     "parse_mode": "HTML", "message": "custom text"}
//
// Response (always JSON):
//
//	{
//	  "ok":           true | false,
//	  "channel":      "telegram_main" | "<ad-hoc>",
//	  "type":         "telegram",
//	  "message_sent": "🔔 UberSDR notification test…",
//	  "duration_ms":  142,
//	  "error":        "telegram API error: chat not found"   // omitted on success
//	}
func handleNotificationsTest(w http.ResponseWriter, r *http.Request, nm *NotificationManager) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "POST required"}) //nolint:errcheck
		return
	}

	// ── Parse request ────────────────────────────────────────────────────────
	var req struct {
		// Mode 1: named channel
		Channel string `json:"channel"`
		// Mode 2: ad-hoc credentials
		Type      string `json:"type"`
		BotToken  string `json:"bot_token"`
		ChatID    string `json:"chat_id"`
		ParseMode string `json:"parse_mode"`
		// Ad-hoc email
		SMTPHost      string   `json:"smtp_host"`
		SMTPPort      int      `json:"smtp_port"`
		SMTPSecurity  string   `json:"smtp_security"`
		SMTPUsername  string   `json:"smtp_username"`
		SMTPPassword  string   `json:"smtp_password"`
		EmailFrom     string   `json:"email_from"`
		EmailTo       []string `json:"email_to"`
		SubjectPrefix string   `json:"subject_prefix"`
		// Ad-hoc webhook
		WebhookURL                string            `json:"webhook_url"`
		WebhookMethod             string            `json:"webhook_method"`
		WebhookFormat             string            `json:"webhook_format"`
		WebhookHeaders            map[string]string `json:"webhook_headers"`
		WebhookSecret             string            `json:"webhook_secret"`
		WebhookTimeoutSeconds     int               `json:"webhook_timeout_seconds"`
		WebhookInsecureSkipVerify bool              `json:"webhook_insecure_skip_verify"`
		WebhookBodyTemplate       string            `json:"webhook_body_template"`
		// Optional in both modes
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid JSON body"}) //nolint:errcheck
		return
	}

	// ── Determine mode ───────────────────────────────────────────────────────
	isAdHoc := req.Channel == "" && req.Type != ""
	isNamed := req.Channel != ""

	if !isAdHoc && !isNamed {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"error": `provide either "channel" (named) or "type"+"bot_token"+"chat_id" (ad-hoc)`,
		})
		return
	}

	// ── Build the channel to test ────────────────────────────────────────────
	var (
		ch          NotificationChannel
		channelName string
		channelType string
	)

	if isNamed {
		// Named channel — must exist in config
		if nm == nil || !nm.cfg.Enabled {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"error": "notification manager disabled — use ad-hoc mode (type+bot_token+chat_id) to test without config"}) //nolint:errcheck
			return
		}
		existing, ok := nm.channels[req.Channel]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
				"error": "channel not found: " + req.Channel,
			})
			return
		}
		ch = existing
		channelName = req.Channel
		channelType = existing.Type()
	} else {
		// Ad-hoc — construct a temporary channel from the supplied credentials
		switch req.Type {
		case "telegram":
			if req.BotToken == "" || req.ChatID == "" {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"error": "bot_token and chat_id are required for telegram"}) //nolint:errcheck
				return
			}
			parseMode := req.ParseMode
			if parseMode == "" {
				parseMode = "HTML"
			}
			ch = NewTelegramChannel("<ad-hoc>", NotificationChannelConfig{
				Type:      "telegram",
				BotToken:  req.BotToken,
				ChatID:    req.ChatID,
				ParseMode: parseMode,
			})
			channelName = "<ad-hoc>"
			channelType = "telegram"
		case "email":
			if req.SMTPHost == "" || req.EmailFrom == "" || len(req.EmailTo) == 0 {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"error": "smtp_host, email_from and at least one email_to are required for email"}) //nolint:errcheck
				return
			}
			// If the password came through masked, reuse the saved channel's value
			// so the user can test an existing channel after editing other fields.
			password := req.SMTPPassword
			if password == "********" && nm != nil && nm.cfg != nil {
				if existing, ok := nm.cfg.Channels[req.Channel]; ok {
					password = existing.SMTPPassword
				} else {
					password = ""
				}
			}
			ch = NewEmailChannel("<ad-hoc>", NotificationChannelConfig{
				Type:          "email",
				SMTPHost:      req.SMTPHost,
				SMTPPort:      req.SMTPPort,
				SMTPSecurity:  req.SMTPSecurity,
				SMTPUsername:  req.SMTPUsername,
				SMTPPassword:  password,
				EmailFrom:     req.EmailFrom,
				EmailTo:       req.EmailTo,
				SubjectPrefix: req.SubjectPrefix,
			})
			channelName = "<ad-hoc>"
			channelType = "email"
		case "webhook":
			if req.WebhookURL == "" {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"error": "webhook_url is required for webhook"}) //nolint:errcheck
				return
			}
			// Resolve masked secret — if the UI sent "********" it means "keep the
			// existing secret". For ad-hoc tests there is no saved channel, so we
			// clear it. This branch is only reached when req.Channel == "" (ad-hoc).
			secret := req.WebhookSecret
			if secret == "********" {
				secret = "" // no saved channel to retrieve from in ad-hoc mode
			}
			cfg := NotificationChannelConfig{
				Type:                      "webhook",
				WebhookURL:                req.WebhookURL,
				WebhookMethod:             req.WebhookMethod,
				WebhookFormat:             req.WebhookFormat,
				WebhookHeaders:            req.WebhookHeaders,
				WebhookSecret:             secret,
				WebhookTimeoutSeconds:     req.WebhookTimeoutSeconds,
				WebhookInsecureSkipVerify: req.WebhookInsecureSkipVerify,
				WebhookBodyTemplate:       req.WebhookBodyTemplate,
			}
			applyChannelDefaults(&cfg)
			ch = NewWebhookChannel("<ad-hoc>", cfg)
			channelName = "<ad-hoc>"
			channelType = "webhook"
		default:
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "unsupported channel type: " + req.Type}) //nolint:errcheck
			return
		}
	}

	// ── Build message ────────────────────────────────────────────────────────
	msg := req.Message
	if msg == "" {
		msg = "🔔 UberSDR notification test — this channel is working correctly."
	}

	// ── Send and time it ─────────────────────────────────────────────────────
	start := time.Now()
	sendErr := ch.Send(msg)
	durationMs := time.Since(start).Milliseconds()

	// ── Build response ───────────────────────────────────────────────────────
	type testResponse struct {
		OK          bool   `json:"ok"`
		Channel     string `json:"channel"`
		Type        string `json:"type"`
		MessageSent string `json:"message_sent"`
		DurationMs  int64  `json:"duration_ms"`
		Error       string `json:"error,omitempty"`
	}

	resp := testResponse{
		OK:          sendErr == nil,
		Channel:     channelName,
		Type:        channelType,
		MessageSent: msg,
		DurationMs:  durationMs,
	}
	if sendErr != nil {
		resp.Error = sendErr.Error()
		w.WriteHeader(http.StatusBadGateway)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	json.NewEncoder(w).Encode(resp) //nolint:errcheck
}

// handleNotificationsConfig handles GET and PUT for the notification config.
//
// GET /admin/notifications/config
//
//	Returns the active configuration with sensitive fields redacted and a list
//	of validation issues.
//
// PUT /admin/notifications/config
//
//	Accepts a full NotificationsConfig JSON body, validates it, writes it to
//	the notifications.yaml file, and hot-reloads the notification manager —
//	no server restart required.
//
//	Bot tokens that are sent as the placeholder "********" are preserved from
//	the existing config so the UI can round-trip without exposing secrets.
func handleNotificationsConfig(w http.ResponseWriter, r *http.Request, nm *NotificationManager, cfg *NotificationsConfig, configFile string) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		handleNotificationsConfigGet(w, r, nm.Config())
	case http.MethodPut, http.MethodPost:
		handleNotificationsConfigPut(w, r, nm, nm.Config(), configFile)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleNotificationsConfigGet is the GET branch of handleNotificationsConfig.
func handleNotificationsConfigGet(w http.ResponseWriter, r *http.Request, cfg *NotificationsConfig) {
	if cfg == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{"enabled": false}) //nolint:errcheck
		return
	}

	// Build a redacted view of channels (hide bot tokens, SMTP passwords, and webhook secrets)
	type redactedChannel struct {
		Type             string `json:"type"`
		ChatID           string `json:"chat_id"`
		ParseMode        string `json:"parse_mode"`
		RateLimitMinutes int    `json:"rate_limit_minutes"`
		BotTokenSet      bool   `json:"bot_token_set"`
		// Bot command listener config — returned as-is (no secrets).
		BotCommands TelegramBotCommandsConfig `json:"bot_commands,omitempty"`
		// Email (SMTP) — password is never returned, only whether it is set.
		SMTPHost        string   `json:"smtp_host,omitempty"`
		SMTPPort        int      `json:"smtp_port,omitempty"`
		SMTPSecurity    string   `json:"smtp_security,omitempty"`
		SMTPUsername    string   `json:"smtp_username,omitempty"`
		SMTPPasswordSet bool     `json:"smtp_password_set,omitempty"`
		EmailFrom       string   `json:"email_from,omitempty"`
		EmailTo         []string `json:"email_to,omitempty"`
		SubjectPrefix   string   `json:"subject_prefix,omitempty"`
		// Webhook — secret is never returned, only whether it is set.
		WebhookURL                string            `json:"webhook_url,omitempty"`
		WebhookMethod             string            `json:"webhook_method,omitempty"`
		WebhookFormat             string            `json:"webhook_format,omitempty"`
		WebhookHeaders            map[string]string `json:"webhook_headers,omitempty"`
		WebhookSecretSet          bool              `json:"webhook_secret_set,omitempty"`
		WebhookTimeoutSeconds     int               `json:"webhook_timeout_seconds,omitempty"`
		WebhookInsecureSkipVerify bool              `json:"webhook_insecure_skip_verify,omitempty"`
		WebhookBodyTemplate       string            `json:"webhook_body_template,omitempty"`
	}
	channels := make(map[string]redactedChannel, len(cfg.Channels))
	for name, ch := range cfg.Channels {
		channels[name] = redactedChannel{
			Type:             ch.Type,
			ChatID:           ch.ChatID,
			ParseMode:        ch.ParseMode,
			RateLimitMinutes: ch.RateLimitMinutes,
			BotTokenSet:      ch.BotToken != "",
			BotCommands:      ch.BotCommands,
			SMTPHost:         ch.SMTPHost,
			SMTPPort:         ch.SMTPPort,
			SMTPSecurity:     ch.SMTPSecurity,
			SMTPUsername:     ch.SMTPUsername,
			SMTPPasswordSet:  ch.SMTPPassword != "",
			EmailFrom:        ch.EmailFrom,
			EmailTo:          ch.EmailTo,
			SubjectPrefix:    ch.SubjectPrefix,
			// Webhook fields — secret replaced by a boolean flag; body template returned as-is.
			WebhookURL:                ch.WebhookURL,
			WebhookMethod:             ch.WebhookMethod,
			WebhookFormat:             ch.WebhookFormat,
			WebhookHeaders:            ch.WebhookHeaders,
			WebhookSecretSet:          ch.WebhookSecret != "",
			WebhookTimeoutSeconds:     ch.WebhookTimeoutSeconds,
			WebhookInsecureSkipVerify: ch.WebhookInsecureSkipVerify,
			WebhookBodyTemplate:       ch.WebhookBodyTemplate,
		}
	}

	// Build rule list — include filters and template so the UI can round-trip
	// them without loss. No sensitive data in rules.
	type ruleView struct {
		Name               string                `json:"name"`
		Enabled            bool                  `json:"enabled"`
		Event              NotificationEventType `json:"event"`
		Channels           []string              `json:"channels"`
		Filters            NotificationFilter    `json:"filters"`
		DedupBy            []string              `json:"dedup_by,omitempty"`
		DedupWindowMinutes int                   `json:"dedup_window_minutes,omitempty"`
		Template           string                `json:"template"`
		Templates          map[string]string     `json:"templates,omitempty"`
	}
	rules := make([]ruleView, 0, len(cfg.Rules))
	for _, r := range cfg.Rules {
		rules = append(rules, ruleView{
			Name:               r.Name,
			Enabled:            r.IsEnabled(),
			Event:              r.Event,
			Channels:           r.Channels,
			Filters:            r.Filter,
			DedupBy:            r.DedupBy,
			DedupWindowMinutes: r.DedupWindowMinutes,
			Template:           r.Template,
			Templates:          r.Templates,
		})
	}

	issues := cfg.Validate()

	resp := map[string]interface{}{
		"enabled":  cfg.Enabled,
		"channels": channels,
		"rules":    rules,
		"issues":   issues,
		"healthy":  len(issues) == 0,
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp) //nolint:errcheck
}

// handleNotificationsConfigPut is the PUT/POST branch of handleNotificationsConfig.
func handleNotificationsConfigPut(w http.ResponseWriter, r *http.Request, nm *NotificationManager, existingCfg *NotificationsConfig, configFile string) {
	if nm == nil {
		http.Error(w, "notification manager not initialised", http.StatusServiceUnavailable)
		return
	}

	// Decode the incoming JSON body into a full NotificationsConfig.
	var newCfg NotificationsConfig
	if err := json.NewDecoder(r.Body).Decode(&newCfg); err != nil {
		http.Error(w, fmt.Sprintf("invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Preserve masked secrets — the UI sends "********" when it doesn't want to
	// change a secret (it never receives the real value from GET). This applies
	// to both the Telegram bot token and the SMTP password.
	if existingCfg != nil {
		for name, ch := range newCfg.Channels {
			existing, ok := existingCfg.Channels[name]
			if !ok {
				continue
			}
			if ch.BotToken == "********" {
				ch.BotToken = existing.BotToken
			}
			if ch.SMTPPassword == "********" {
				ch.SMTPPassword = existing.SMTPPassword
			}
			if ch.WebhookSecret == "********" {
				ch.WebhookSecret = existing.WebhookSecret
			}
			newCfg.Channels[name] = ch
		}
	}

	// Apply the same defaults that LoadNotificationsConfig applies.
	for name, ch := range newCfg.Channels {
		applyChannelDefaults(&ch)
		newCfg.Channels[name] = ch
	}

	// Validate before writing anything.
	if issues := newCfg.Validate(); len(issues) > 0 {
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
			"ok":     false,
			"error":  "validation failed",
			"issues": issues,
		})
		return
	}

	// Persist to disk.
	if err := SaveNotificationsConfig(configFile, &newCfg); err != nil {
		http.Error(w, fmt.Sprintf("failed to save config: %v", err), http.StatusInternalServerError)
		return
	}

	// Hot-reload the notification manager — no restart required.
	if err := nm.Reload(&newCfg); err != nil {
		// Config is already saved; reload failed (e.g. bad template). Report
		// the error but don't roll back the file — the admin can fix and retry.
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
			"ok":    false,
			"error": fmt.Sprintf("config saved but reload failed: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
		"ok":       true,
		"message":  "notifications config saved and reloaded",
		"enabled":  newCfg.Enabled,
		"channels": len(newCfg.Channels),
		"rules":    len(newCfg.Rules),
	})
}

// handleNotificationsSchema returns the static system capabilities of the
// notification system: supported channel types, event types with their filter
// fields, and available template functions.
//
// This endpoint is intended for UI consumption — it never changes at runtime
// and requires no configuration to be present.
//
// GET /admin/notifications/schema
func handleNotificationsSchema(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// ── Channel types ────────────────────────────────────────────────────────

	type channelField struct {
		Name        string   `json:"name"`
		Type        string   `json:"type"`
		Required    bool     `json:"required"`
		Description string   `json:"description"`
		ValidValues []string `json:"valid_values,omitempty"`
		Example     string   `json:"example,omitempty"`
	}
	type channelType struct {
		Type        string         `json:"type"`
		Description string         `json:"description"`
		Fields      []channelField `json:"fields"`
	}

	channelTypes := []channelType{
		{
			Type:        "telegram",
			Description: "Telegram Bot API — sends messages to a personal chat, group, or channel.",
			Fields: []channelField{
				{Name: "bot_token", Type: "string", Required: true, Description: "Token from @BotFather.", Example: "7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},
				{Name: "chat_id", Type: "string", Required: true, Description: "Target chat ID. Negative for groups/channels, positive for personal chats.", Example: "-1001234567890"},
				{Name: "parse_mode", Type: "string", Required: false, Description: "Message formatting. Default: HTML.", ValidValues: []string{"HTML", "Markdown", "MarkdownV2", ""}, Example: "HTML"},
				{Name: "rate_limit_minutes", Type: "int", Required: false, Description: "Suppress duplicate (rule+subject) alerts within this window. 0 = no limit. Default: 10.", Example: "10"},
			},
		},
		{
			Type:        "email",
			Description: "SMTP email — works with any provider. Gmail requires 2-Step Verification + a 16-character App Password (used as smtp_password); no OAuth needed.",
			Fields: []channelField{
				{Name: "smtp_host", Type: "string", Required: true, Description: "Mail server hostname.", Example: "smtp.gmail.com"},
				{Name: "smtp_port", Type: "int", Required: false, Description: "Mail server port. Default: 587.", Example: "587"},
				{Name: "smtp_security", Type: "string", Required: false, Description: "Transport security. Default: starttls.", ValidValues: []string{"starttls", "tls", "none"}, Example: "starttls"},
				{Name: "smtp_username", Type: "string", Required: false, Description: "SMTP auth username (usually the full email address). Blank = unauthenticated relay.", Example: "me@gmail.com"},
				{Name: "smtp_password", Type: "string", Required: false, Description: "SMTP auth password. For Gmail this is the App Password, not the account password.", Example: "abcd efgh ijkl mnop"},
				{Name: "email_from", Type: "string", Required: true, Description: "From address. May be 'Name <addr@example.com>' or a bare address.", Example: "UberSDR <me@gmail.com>"},
				{Name: "email_to", Type: "[]string", Required: true, Description: "Recipient address(es).", Example: `["you@example.com"]`},
				{Name: "subject_prefix", Type: "string", Required: false, Description: "Prepended to the dynamic subject (prefix + first line of the message). Default: [UberSDR].", Example: "[UberSDR]"},
				{Name: "rate_limit_minutes", Type: "int", Required: false, Description: "Suppress duplicate (rule+subject) alerts within this window. 0 = no limit. Default: 10.", Example: "10"},
			},
		},
		{
			Type:        "webhook",
			Description: "HTTP webhook — POSTs a notification to any URL. Works with ntfy, Slack, Discord, Zapier, Home Assistant, n8n, and custom endpoints. Supports HMAC-SHA256 request signing.",
			Fields: []channelField{
				{Name: "webhook_url", Type: "string", Required: true, Description: "Destination URL. Must be http:// or https://. Plain http:// is only allowed for private/LAN addresses.", Example: "https://ntfy.sh/my-topic"},
				{Name: "webhook_method", Type: "string", Required: false, Description: "HTTP method. Default: POST.", ValidValues: []string{"POST", "PUT"}, Example: "POST"},
				{Name: "webhook_format", Type: "string", Required: false, Description: `Payload format. "text" = text/plain body; "json" = JSON envelope {channel,message,timestamp}; "slack" = {"text":"…"}; "discord" = {"content":"…"}. Default: text.`, ValidValues: []string{"text", "json", "slack", "discord"}, Example: "text"},
				{Name: "webhook_secret", Type: "string", Required: false, Description: "HMAC-SHA256 signing secret. When set, every request includes X-Hub-Signature-256: sha256=<hmac>.", Example: "my-secret-key"},
				{Name: "webhook_headers", Type: "map[string]string", Required: false, Description: "Extra HTTP headers sent with every request.", Example: `{"Authorization":"Bearer token123"}`},
				{Name: "webhook_timeout_seconds", Type: "int", Required: false, Description: "Per-request timeout in seconds. Range: 1–60. Default: 10.", Example: "10"},
				{Name: "webhook_insecure_skip_verify", Type: "bool", Required: false, Description: "Skip TLS certificate verification. Only for self-signed certs on private LANs.", Example: "false"},
				{Name: "webhook_body_template", Type: "string", Required: false, Description: `Go text/template string rendered as the full request body. Overrides webhook_format when set. Template data: .Message (string), .Channel (string), .Timestamp (RFC3339 string). Content-Type defaults to application/json; override via webhook_headers.`, Example: `{"message":"{{.Message}}","title":"UberSDR","priority":5}`},
				{Name: "rate_limit_minutes", Type: "int", Required: false, Description: "Suppress duplicate (rule+subject) alerts within this window. 0 = no limit. Default: 10.", Example: "10"},
			},
		},
	}

	// ── Filter fields per event type ─────────────────────────────────────────

	type filterField struct {
		Name        string   `json:"name"`
		Type        string   `json:"type"`
		Description string   `json:"description"`
		ValidValues []string `json:"valid_values,omitempty"`
		Example     string   `json:"example,omitempty"`
	}
	type templateField struct {
		Name        string `json:"name"`
		GoType      string `json:"go_type"`
		Description string `json:"description"`
	}
	type eventType struct {
		Type           string          `json:"type"`
		Description    string          `json:"description"`
		FilterFields   []filterField   `json:"filter_fields"`
		TemplateFields []templateField `json:"template_fields"`
		// DedupKeys lists the valid dedup_by keys for high-volume spot events
		// (empty for all other event types). A rule for one of these events must
		// set a selective filter or dedup_by, else it is rejected on save.
		DedupKeys []string `json:"dedup_keys,omitempty"`
	}

	eventTypes := []eventType{
		{
			Type:        "cw_spot",
			Description: "CW Skimmer spot received.",
			DedupKeys:   []string{"callsign", "country", "country_code", "continent", "cq_zone", "itu_zone", "band", "mode"},
			FilterFields: []filterField{
				{Name: "callsigns", Type: "[]string", Description: "Exact callsign match (case-insensitive).", Example: `["G3XYZ","M0ABC"]`},
				{Name: "callsign_prefixes", Type: "[]string", Description: "Callsign prefix match (e.g. DXCC prefixes).", Example: `["3Y","JD1","VK0"]`},
				{Name: "countries", Type: "[]string", Description: "CTY country name.", Example: `["Japan","Australia"]`},
				{Name: "country_codes", Type: "[]string", Description: "ISO 3166-1 alpha-2 country code.", Example: `["JP","AU"]`},
				{Name: "continents", Type: "[]string", Description: "Continent code.", ValidValues: []string{"NA", "SA", "EU", "AF", "AS", "OC", "AN"}, Example: `["OC","AN"]`},
				{Name: "cq_zones", Type: "[]int", Description: "CQ zone numbers.", Example: `[3,4]`},
				{Name: "itu_zones", Type: "[]int", Description: "ITU zone numbers.", Example: `[6,7]`},
				{Name: "bands", Type: "[]string", Description: "Band name.", Example: `["40m","20m"]`},
				{Name: "modes", Type: "[]string", Description: "CW mode string.", ValidValues: []string{"CW", "RTTY"}, Example: `["CW"]`},
				{Name: "min_snr", Type: "int", Description: "Minimum SNR in dB (inclusive).", Example: "5"},
				{Name: "max_snr", Type: "int", Description: "Maximum SNR in dB (inclusive).", Example: "30"},
				{Name: "min_wpm", Type: "int", Description: "Minimum speed in WPM (inclusive).", Example: "20"},
				{Name: "min_distance_km", Type: "float64", Description: "Minimum distance in km (requires locator data).", Example: "5000"},
				{Name: "max_distance_km", Type: "float64", Description: "Maximum distance in km.", Example: "1000"},
			},
			TemplateFields: []templateField{
				{Name: ".DXCall", GoType: "string", Description: "Spotted callsign."},
				{Name: ".Spotter", GoType: "string", Description: "Spotter callsign."},
				{Name: ".Frequency", GoType: "float64", Description: "Frequency in Hz. Use khz for display."},
				{Name: ".Band", GoType: "string", Description: "Band name, e.g. \"40m\"."},
				{Name: ".SNR", GoType: "int", Description: "Signal-to-noise ratio in dB."},
				{Name: ".WPM", GoType: "int", Description: "Speed in words per minute."},
				{Name: ".Mode", GoType: "string", Description: "Mode string: \"CW\" or \"RTTY\"."},
				{Name: ".Comment", GoType: "string", Description: "Spot comment (may be empty)."},
				{Name: ".Country", GoType: "string", Description: "CTY country name."},
				{Name: ".CountryCode", GoType: "string", Description: "ISO 3166-1 alpha-2 code."},
				{Name: ".CQZone", GoType: "int", Description: "CQ zone."},
				{Name: ".ITUZone", GoType: "int", Description: "ITU zone."},
				{Name: ".Continent", GoType: "string", Description: "Continent code."},
				{Name: ".DistanceKm", GoType: "*float64", Description: "Distance in km (nil if unknown). Guard with {{if .DistanceKm}}."},
				{Name: ".BearingDeg", GoType: "*float64", Description: "Bearing in degrees (nil if unknown). Use bearing function."},
				{Name: ".Latitude", GoType: "float64", Description: "Station latitude in decimal degrees (0 if unknown)."},
				{Name: ".Longitude", GoType: "float64", Description: "Station longitude in decimal degrees (0 if unknown)."},
				{Name: ".Name", GoType: "string", Description: "Operator name (may be empty)."},
				{Name: ".Grid", GoType: "string", Description: "Maidenhead locator (may be empty)."},
				{Name: ".Time", GoType: "time.Time", Description: "Spot timestamp."},
			},
		},
		{
			Type:        "dx_spot",
			Description: "DX Cluster spot received.",
			DedupKeys:   []string{"callsign", "country", "country_code", "continent", "band"},
			FilterFields: []filterField{
				{Name: "callsigns", Type: "[]string", Description: "Exact callsign match.", Example: `["G3XYZ"]`},
				{Name: "callsign_prefixes", Type: "[]string", Description: "Callsign prefix match.", Example: `["3Y","JD1"]`},
				{Name: "countries", Type: "[]string", Description: "CTY country name.", Example: `["Japan"]`},
				{Name: "country_codes", Type: "[]string", Description: "ISO 3166-1 alpha-2 code.", Example: `["JP"]`},
				{Name: "continents", Type: "[]string", Description: "Continent code.", ValidValues: []string{"NA", "SA", "EU", "AF", "AS", "OC", "AN"}, Example: `["OC"]`},
				{Name: "bands", Type: "[]string", Description: "Band name.", Example: `["20m"]`},
				{Name: "spotters", Type: "[]string", Description: "Spotter callsign (exact match).", Example: `["G3XYZ"]`},
				{Name: "comment_contains", Type: "[]string", Description: "Spot comment contains any of these substrings (case-insensitive).", Example: `["FT8","digi"]`},
			},
			TemplateFields: []templateField{
				{Name: ".DXCall", GoType: "string", Description: "Spotted callsign."},
				{Name: ".Spotter", GoType: "string", Description: "Spotter callsign."},
				{Name: ".Frequency", GoType: "float64", Description: "Frequency in Hz. Use khz for display."},
				{Name: ".Band", GoType: "string", Description: "Band name."},
				{Name: ".Comment", GoType: "string", Description: "Spot comment (may be empty)."},
				{Name: ".Country", GoType: "string", Description: "CTY country name."},
				{Name: ".CountryCode", GoType: "string", Description: "ISO 3166-1 alpha-2 code."},
				{Name: ".Continent", GoType: "string", Description: "Continent code."},
				{Name: ".TimeOffset", GoType: "float64", Description: "Time offset in minutes from spot time."},
				{Name: ".Time", GoType: "time.Time", Description: "Spot timestamp."},
			},
		},
		{
			Type:        "digital_decode",
			Description: "FT8 / FT4 / WSPR / JS8 decode from the built-in decoder.",
			DedupKeys:   []string{"callsign", "country", "country_code", "continent", "cq_zone", "itu_zone", "band", "mode"},
			FilterFields: []filterField{
				{Name: "callsigns", Type: "[]string", Description: "Exact callsign match.", Example: `["G3XYZ"]`},
				{Name: "callsign_prefixes", Type: "[]string", Description: "Callsign prefix match.", Example: `["VK","ZL"]`},
				{Name: "countries", Type: "[]string", Description: "CTY country name.", Example: `["Australia"]`},
				{Name: "country_codes", Type: "[]string", Description: "ISO 3166-1 alpha-2 code.", Example: `["AU"]`},
				{Name: "continents", Type: "[]string", Description: "Continent code.", ValidValues: []string{"NA", "SA", "EU", "AF", "AS", "OC", "AN"}, Example: `["OC","AN"]`},
				{Name: "cq_zones", Type: "[]int", Description: "CQ zone numbers.", Example: `[29,30]`},
				{Name: "itu_zones", Type: "[]int", Description: "ITU zone numbers.", Example: `[55,58]`},
				{Name: "bands", Type: "[]string", Description: "Band name.", Example: `["20m","40m"]`},
				{Name: "digital_modes", Type: "[]string", Description: "Decode mode.", ValidValues: []string{"FT8", "FT4", "WSPR", "JS8"}, Example: `["FT8","FT4"]`},
				{Name: "min_snr", Type: "int", Description: "Minimum SNR in dB.", Example: "-10"},
				{Name: "max_snr", Type: "int", Description: "Maximum SNR in dB.", Example: "10"},
				{Name: "min_distance_km", Type: "float64", Description: "Minimum distance in km.", Example: "8000"},
				{Name: "max_distance_km", Type: "float64", Description: "Maximum distance in km.", Example: "500"},
				{Name: "message_contains", Type: "[]string", Description: "Decoded message contains any of these substrings.", Example: `["CQ","73"]`},
			},
			TemplateFields: []templateField{
				{Name: ".Callsign", GoType: "string", Description: "Decoded callsign."},
				{Name: ".Locator", GoType: "string", Description: "Maidenhead locator (may be empty)."},
				{Name: ".Country", GoType: "string", Description: "CTY country name."},
				{Name: ".CountryCode", GoType: "string", Description: "ISO 3166-1 alpha-2 code."},
				{Name: ".CQZone", GoType: "int", Description: "CQ zone."},
				{Name: ".ITUZone", GoType: "int", Description: "ITU zone."},
				{Name: ".Continent", GoType: "string", Description: "Continent code."},
				{Name: ".SNR", GoType: "int", Description: "SNR in dB."},
				{Name: ".Frequency", GoType: "uint64", Description: "Signal frequency in Hz. Use mhz for display."},
				{Name: ".DialFrequency", GoType: "uint64", Description: "Dial frequency in Hz. Use mhz for display."},
				{Name: ".Mode", GoType: "string", Description: "Decode mode: FT8, FT4, WSPR, JS8."},
				{Name: ".Message", GoType: "string", Description: "Full decoded message text."},
				{Name: ".Band", GoType: "string", Description: "Band name."},
				{Name: ".DistanceKm", GoType: "*float64", Description: "Distance in km (nil if unknown)."},
				{Name: ".BearingDeg", GoType: "*float64", Description: "Bearing in degrees (nil if unknown)."},
				{Name: ".DBm", GoType: "int", Description: "Transmit power in dBm (WSPR only)."},
				{Name: ".TxFrequency", GoType: "uint64", Description: "Transmit frequency in Hz (WSPR only). Use mhz for display."},
				{Name: ".Timestamp", GoType: "time.Time", Description: "Decode timestamp."},
			},
		},
		{
			Type:        "space_weather",
			Description: "Space weather update — fires when K-index, A-index, or SFI crosses a threshold.",
			FilterFields: []filterField{
				{Name: "k_min", Type: "int", Description: "Fire when K-index >= this value.", Example: "5"},
				{Name: "k_max", Type: "int", Description: "Fire when K-index <= this value.", Example: "2"},
				{Name: "a_min", Type: "int", Description: "Fire when A-index >= this value.", Example: "20"},
				{Name: "sfi_min", Type: "float64", Description: "Fire when SFI >= this value.", Example: "150"},
				{Name: "sfi_max", Type: "float64", Description: "Fire when SFI <= this value.", Example: "70"},
			},
			TemplateFields: []templateField{
				{Name: ".SFI", GoType: "float64", Description: "Solar Flux Index."},
				{Name: ".KIndex", GoType: "int", Description: "Current K-index (0–9)."},
				{Name: ".KIndexStatus", GoType: "string", Description: "K-index status description."},
				{Name: ".AIndex", GoType: "int", Description: "Current A-index."},
				{Name: ".SolarWindBz", GoType: "float64", Description: "Solar wind Bz component in nT."},
				{Name: ".PropagationQuality", GoType: "string", Description: "Human-readable propagation quality string."},
				{Name: ".PreviousKIndex", GoType: "int", Description: "K-index from previous update (for trend arrows)."},
				{Name: ".PreviousSFI", GoType: "float64", Description: "SFI from previous update."},
			},
		},
		{
			Type:        "antenna_switch",
			Description: "Antenna switch changed state.",
			FilterFields: []filterField{
				{Name: "ant_actions", Type: "[]string", Description: "Action that triggered the change.", ValidValues: []string{"select", "ground", "add", "remove", "default"}, Example: `["ground"]`},
				{Name: "ant_numbers", Type: "[]int", Description: "Specific antenna port numbers.", Example: `[1,2]`},
				{Name: "ant_sources", Type: "[]string", Description: "Source of the command.", ValidValues: []string{"public", "admin", "startup", "sync", "scheduler"}, Example: `["scheduler"]`},
			},
			TemplateFields: []templateField{
				{Name: ".Action", GoType: "string", Description: "Action: select, ground, add, remove, default."},
				{Name: ".Antenna", GoType: "int", Description: "Antenna port number (0 for ground/default)."},
				{Name: ".Label", GoType: "string", Description: "Human-readable antenna name."},
				{Name: ".Selected", GoType: "[]int", Description: "Resulting selected antenna ports. Use {{range .Selected}} or join."},
				{Name: ".Grounded", GoType: "bool", Description: "True when all antennas are grounded."},
				{Name: ".Source", GoType: "string", Description: "Command source: public, admin, startup, sync, scheduler."},
				{Name: ".Time", GoType: "time.Time", Description: "Event timestamp."},
			},
		},
		{
			Type:        "rotator",
			Description: "Rotator position or moving state changed.",
			FilterFields: []filterField{
				{Name: "rotator_moving", Type: "bool", Description: "true = fire only when movement starts; false = fire only when movement stops. Omit to fire on any change.", Example: "false"},
			},
			TemplateFields: []templateField{
				{Name: ".Azimuth", GoType: "float64", Description: "Current azimuth in degrees."},
				{Name: ".Elevation", GoType: "float64", Description: "Current elevation in degrees."},
				{Name: ".Moving", GoType: "bool", Description: "True while the rotator is moving."},
				{Name: ".TargetAzimuth", GoType: "float64", Description: "Target azimuth in degrees."},
				{Name: ".TargetElevation", GoType: "float64", Description: "Target elevation in degrees."},
				{Name: ".Time", GoType: "time.Time", Description: "Event timestamp."},
			},
		},
		{
			Type:        "system_monitor",
			Description: "A subsystem transitioned between healthy and unhealthy states.",
			FilterFields: []filterField{
				{Name: "components", Type: "[]string", Description: "Subsystem names to watch. Empty = all components.", ValidValues: []string{"noise_floor", "space_weather", "decoder", "cw_skimmer", "mqtt", "rotator", "ant_switch", "frequency_reference", "instance_reporter", "sdr_frontend", "gpsdo", "system_load", "cpu_temperature", "dsp", "software_version"}, Example: `["decoder","cw_skimmer"]`},
				{Name: "on_unhealthy", Type: "bool", Description: "Fire only on healthy→unhealthy transition.", Example: "true"},
				{Name: "on_recovery", Type: "bool", Description: "Fire only on unhealthy→healthy transition.", Example: "true"},
				{Name: "flap_detection", Type: "bool", Description: "Suppress repeated alerts when a component oscillates; sends one flap alert then resumes once stable. Default: on.", Example: "true"},
				{Name: "flap_threshold", Type: "int", Description: "Health changes within flap_window_minutes to trigger flap detection (default 6).", Example: "6"},
				{Name: "flap_window_minutes", Type: "int", Description: "Rolling window for counting changes (default 10).", Example: "10"},
				{Name: "flap_clear_minutes", Type: "int", Description: "Stable minutes before alerts resume — prevents suppressing forever (default 15).", Example: "15"},
			},
			TemplateFields: []templateField{
				{Name: ".Component", GoType: "string", Description: "Subsystem name."},
				{Name: ".Healthy", GoType: "bool", Description: "Current health state."},
				{Name: ".PreviouslyHealthy", GoType: "bool", Description: "Health state before this event."},
				{Name: ".Issues", GoType: "[]string", Description: "List of issue descriptions. Use {{range .Issues}} or join."},
				{Name: ".Status", GoType: "string", Description: "Status string: degraded, recovered, flapping, stabilized, or unknown."},
				{Name: ".Flapping", GoType: "bool", Description: "True on a flap-detection activation alert."},
				{Name: ".Time", GoType: "time.Time", Description: "Event timestamp."},
			},
		},
		{
			Type:        "user_session",
			Description: "A user connected or disconnected.",
			FilterFields: []filterField{
				{Name: "session_actions", Type: "[]string", Description: "Session event type.", ValidValues: []string{"connected", "disconnected"}, Example: `["connected"]`},
				{Name: "session_country_codes", Type: "[]string", Description: "User's country (ISO alpha-2).", Example: `["US","CA"]`},
				{Name: "session_continents", Type: "[]string", Description: "User's continent code.", ValidValues: []string{"NA", "SA", "EU", "AF", "AS", "OC", "AN"}, Example: `["NA","SA","AS","OC","AF","AN"]`},
				{Name: "user_agent_contains", Type: "[]string", Description: "User-agent string contains any of these substrings.", Example: `["bot","curl"]`},
				{Name: "client_ips", Type: "[]string", Description: "Specific client IP addresses.", Example: `["1.2.3.4"]`},
			},
			TemplateFields: []templateField{
				{Name: ".Action", GoType: "string", Description: "\"connected\" or \"disconnected\"."},
				{Name: ".ClientIP", GoType: "string", Description: "Client IP address."},
				{Name: ".Country", GoType: "string", Description: "CTY/GeoIP country name."},
				{Name: ".CountryCode", GoType: "string", Description: "ISO 3166-1 alpha-2 code."},
				{Name: ".Continent", GoType: "string", Description: "Continent code."},
				{Name: ".UserAgent", GoType: "string", Description: "HTTP User-Agent string."},
				{Name: ".UserSessionID", GoType: "string", Description: "Internal session UUID."},
				{Name: ".Frequency", GoType: "uint64", Description: "Tuned frequency in Hz at connect time."},
				{Name: ".Mode", GoType: "string", Description: "Mode at connect time."},
				{Name: ".Time", GoType: "time.Time", Description: "Event timestamp."},
			},
		},
		{
			Type:         "server_startup",
			Description:  "Server finished initialising. Fires once per start. Useful for crash/restart detection.",
			FilterFields: []filterField{
				// No filter fields — always fires on startup
			},
			TemplateFields: []templateField{
				{Name: ".Version", GoType: "string", Description: "UberSDR version string."},
				{Name: ".Callsign", GoType: "string", Description: "Configured station callsign."},
				{Name: ".Name", GoType: "string", Description: "Configured station name."},
				{Name: ".StartTime", GoType: "time.Time", Description: "Server start timestamp."},
			},
		},
		{
			Type:        "digital_rank",
			Description: "Our station's rank changed in PSK Reporter, WSPR Live, or RBN. Fires when the overall rank number changes between hourly (PSK/WSPR) or daily (RBN) fetches.",
			FilterFields: []filterField{
				{Name: "rank_components", Type: "[]string", Description: "Ranking systems to watch. Empty = all enabled components.", ValidValues: []string{"psk", "wspr", "rbn"}, Example: `["psk","wspr"]`},
				{Name: "rank_improved", Type: "bool", Description: "Fire only when rank improves (number decreases, or first appearance on leaderboard).", Example: "true"},
				{Name: "rank_worsened", Type: "bool", Description: "Fire only when rank worsens (number increases or drops off leaderboard).", Example: "true"},
				{Name: "rank_threshold", Type: "int", Description: "Fire only when new rank is at or better than this value (e.g. 10 = top 10 only). 0 = no threshold.", Example: "10"},
			},
			TemplateFields: []templateField{
				{Name: ".Component", GoType: "string", Description: `Ranking system: "psk", "wspr", or "rbn".`},
				{Name: ".Dimension", GoType: "string", Description: `Sub-table: "reports" or "countries" (PSK); "rolling_24h", "yesterday", or "today" (WSPR); "spots" (RBN).`},
				{Name: ".Callsign", GoType: "string", Description: "Station callsign."},
				{Name: ".OldRank", GoType: "int", Description: "Previous rank (0 = was not ranked / first observation)."},
				{Name: ".NewRank", GoType: "int", Description: "New rank (0 = dropped off leaderboard)."},
				{Name: ".OldValue", GoType: "int", Description: "Previous count (spots/countries/unique spots)."},
				{Name: ".NewValue", GoType: "int", Description: "New count."},
				{Name: ".TotalRanked", GoType: "int", Description: "Total entries in leaderboard (RBN only; 0 for PSK/WSPR)."},
				{Name: ".Time", GoType: "time.Time", Description: "Event timestamp."},
			},
		},
		{
			Type:        "voice_activity",
			Description: "New voice signal detected on a band (requires noise floor monitor). Optionally enriched with DX cluster callsign data.",
			FilterFields: []filterField{
				{Name: "voice_bands", Type: "[]string", Description: "Band names to watch. Empty = all bands.", Example: `["20m","40m"]`},
				{Name: "voice_country_codes", Type: "[]string", Description: "DX cluster enriched country code (ISO alpha-2). Only fires when a callsign has been spotted nearby.", Example: `["JP","VK"]`},
				{Name: "voice_continents", Type: "[]string", Description: "DX cluster enriched continent code.", ValidValues: []string{"NA", "SA", "EU", "AF", "AS", "OC", "AN"}, Example: `["AS","OC"]`},
				{Name: "voice_callsigns", Type: "[]string", Description: "DX cluster enriched callsign (exact match).", Example: `["JA1XYZ"]`},
				{Name: "voice_min_snr", Type: "float32", Description: "Minimum detected SNR in dB.", Example: "5.0"},
				{Name: "voice_min_confidence", Type: "float32", Description: "Minimum detection confidence (0.0–1.0).", Example: "0.6"},
			},
			TemplateFields: []templateField{
				{Name: ".Band", GoType: "string", Description: "Band name."},
				{Name: ".CenterFreq", GoType: "uint64", Description: "Signal centre frequency in Hz. Use mhz for display."},
				{Name: ".EstimatedDialFreq", GoType: "uint64", Description: "Estimated dial frequency in Hz. Use mhz for display."},
				{Name: ".StartFreq", GoType: "uint64", Description: "Signal start frequency in Hz."},
				{Name: ".EndFreq", GoType: "uint64", Description: "Signal end frequency in Hz."},
				{Name: ".Bandwidth", GoType: "uint64", Description: "Signal bandwidth in Hz."},
				{Name: ".Mode", GoType: "string", Description: "Estimated mode (USB, LSB, AM, etc.)."},
				{Name: ".SNR", GoType: "float32", Description: "Detected SNR in dB. Wrap with f32 before printf/mulf."},
				{Name: ".Confidence", GoType: "float32", Description: "Detection confidence 0.0–1.0. Wrap with f32 before printf/mulf."},
				{Name: ".DXCallsign", GoType: "string", Description: "DX cluster enriched callsign (may be empty)."},
				{Name: ".DXCountry", GoType: "string", Description: "DX cluster enriched country name (may be empty)."},
				{Name: ".DXCountryCode", GoType: "string", Description: "DX cluster enriched ISO alpha-2 code (may be empty)."},
				{Name: ".DXContinent", GoType: "string", Description: "DX cluster enriched continent code (may be empty)."},
				{Name: ".Time", GoType: "time.Time", Description: "Detection timestamp."},
			},
		},
	}

	// ── Template functions ───────────────────────────────────────────────────

	type templateFunc struct {
		Name       string `json:"name"`
		Signature  string `json:"signature"`
		Returns    string `json:"returns"`
		InputTypes string `json:"input_types"`
		Example    string `json:"example"`
		Notes      string `json:"notes,omitempty"`
	}

	templateFuncs := []templateFunc{
		{Name: "flag", Signature: "flag code", Returns: "string", InputTypes: "string", Example: `{{flag .CountryCode}}`, Notes: "ISO 3166-1 alpha-2 → flag emoji. e.g. \"JP\" → 🇯🇵"},
		{Name: "bearing", Signature: "bearing deg", Returns: "string", InputTypes: "*float64 or float64", Example: `{{bearing .BearingDeg}}`, Notes: "Compass direction string (N, NE, ENE…). Handles nil *float64 → \"?\"."},
		{Name: "deref", Signature: "deref ptr", Returns: "float64", InputTypes: "*float64", Example: `{{printf \"%.0f\" (deref .DistanceKm)}}`, Notes: "Nil-safe dereference. Returns 0.0 for nil. Guard with {{if .DistanceKm}} first."},
		{Name: "divf", Signature: "divf a b", Returns: "float64", InputTypes: "float64 float64", Example: `{{printf \"%.3f\" (divf .Frequency 1000000.0)}}`, Notes: "Float division. Returns 0 if b is 0."},
		{Name: "mulf", Signature: "mulf a b", Returns: "float64", InputTypes: "float64 float64", Example: `{{printf \"%.0f\" (mulf (f32 .Confidence) 100)}}`, Notes: "Float multiplication. Use with f32 for float32 fields."},
		{Name: "f32", Signature: "f32 v", Returns: "float64", InputTypes: "float32", Example: `{{printf \"%.1f\" (f32 .SNR)}}`, Notes: "Converts float32 to float64 for use with printf, mulf, divf."},
		{Name: "mhz", Signature: "mhz hz", Returns: "string", InputTypes: "uint64", Example: `{{mhz .EstimatedDialFreq}}`, Notes: "uint64 Hz → MHz string with 3 decimal places. Use for digital_decode and voice_activity frequencies."},
		{Name: "khz", Signature: "khz hz", Returns: "string", InputTypes: "float64", Example: `{{khz .Frequency}}`, Notes: "float64 Hz → kHz string with 1 decimal place. Use for cw_spot and dx_spot .Frequency only."},
		{Name: "join", Signature: "join sep items", Returns: "string", InputTypes: "string []string", Example: `{{join \", \" .Issues}}`, Notes: "Joins a string slice with a separator."},
		{Name: "upper", Signature: "upper s", Returns: "string", InputTypes: "string", Example: `{{upper .Mode}}`, Notes: "Converts string to upper case."},
		{Name: "lower", Signature: "lower s", Returns: "string", InputTypes: "string", Example: `{{lower .Band}}`, Notes: "Converts string to lower case."},
	}

	// ── Assemble response ────────────────────────────────────────────────────

	resp := map[string]interface{}{
		"channel_types":   channelTypes,
		"event_types":     eventTypes,
		"template_funcs":  templateFuncs,
		"continents":      []string{"NA", "SA", "EU", "AF", "AS", "OC", "AN"},
		"session_actions": []string{"connected", "disconnected"},
		"ant_actions":     []string{"select", "ground", "add", "remove", "default"},
		"ant_sources":     []string{"public", "admin", "startup", "sync", "scheduler"},
		"digital_modes":   []string{"FT8", "FT4", "WSPR", "JS8"},
		"cw_modes":        []string{"CW", "RTTY"},
		"monitor_components": []string{
			"noise_floor", "space_weather", "decoder", "cw_skimmer", "mqtt",
			"rotator", "ant_switch", "frequency_reference", "instance_reporter",
			"sdr_frontend", "gpsdo", "system_load", "cpu_temperature", "dsp",
			"software_version",
		},
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp) //nolint:errcheck
}

// handleTelegramGetUpdates calls the Telegram Bot API getUpdates method with the
// supplied bot token and returns a deduplicated list of chats that have messaged
// the bot. This lets a UI discover the chat_id without the user having to use
// external tools.
//
// POST /admin/notifications/telegram-updates
//
//	{"bot_token": "123:ABC…"}
//
// Response:
//
//	{
//	  "ok": true,
//	  "bot_username": "MyUberSDRBot",
//	  "chats": [
//	    {"id": -100123456789, "type": "group",   "title": "My Ham Radio Group"},
//	    {"id": 987654321,     "type": "private", "first_name": "Nathan"}
//	  ]
//	}
func handleTelegramGetUpdates(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "POST required"}) //nolint:errcheck
		return
	}

	var req struct {
		BotToken string `json:"bot_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.BotToken == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "bot_token is required"}) //nolint:errcheck
		return
	}

	apiBase := fmt.Sprintf("https://api.telegram.org/bot%s", req.BotToken)
	client := &http.Client{Timeout: 10 * time.Second}

	// ── getMe — validate token and get bot username ───────────────────────────
	meResp, err := client.Get(apiBase + "/getMe")
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": "telegram API unreachable: " + err.Error()}) //nolint:errcheck
		return
	}
	defer meResp.Body.Close()
	meBody, _ := io.ReadAll(meResp.Body)

	var meResult struct {
		OK     bool `json:"ok"`
		Result struct {
			Username string `json:"username"`
		} `json:"result"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(meBody, &meResult); err != nil || !meResult.OK {
		desc := meResult.Description
		if desc == "" {
			desc = "invalid bot token or unexpected response"
		}
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": desc}) //nolint:errcheck
		return
	}

	// ── getUpdates — fetch recent messages to discover chats ─────────────────
	// offset=-1 tells Telegram to re-deliver the most recent update even if it
	// was previously consumed by another getUpdates call. Without this, the
	// queue appears empty after the first poll. We fetch up to 100 updates so
	// that multiple chats (groups, channels, DMs) are all discoverable.
	updatesURL := apiBase + "/getUpdates?offset=-1&limit=100&timeout=0"
	updResp, err := client.Get(updatesURL)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": "getUpdates failed: " + err.Error()}) //nolint:errcheck
		return
	}
	defer updResp.Body.Close()
	updBody, _ := io.ReadAll(updResp.Body)

	// Minimal struct — we only need the chat fields from each update.
	var updResult struct {
		OK     bool `json:"ok"`
		Result []struct {
			Message *struct {
				Chat struct {
					ID        int64  `json:"id"`
					Type      string `json:"type"`
					Title     string `json:"title,omitempty"`
					Username  string `json:"username,omitempty"`
					FirstName string `json:"first_name,omitempty"`
					LastName  string `json:"last_name,omitempty"`
				} `json:"chat"`
			} `json:"message,omitempty"`
			ChannelPost *struct {
				Chat struct {
					ID        int64  `json:"id"`
					Type      string `json:"type"`
					Title     string `json:"title,omitempty"`
					Username  string `json:"username,omitempty"`
					FirstName string `json:"first_name,omitempty"`
					LastName  string `json:"last_name,omitempty"`
				} `json:"chat"`
			} `json:"channel_post,omitempty"`
		} `json:"result"`
	}
	_ = json.Unmarshal(updBody, &updResult) // best-effort; empty result is fine

	// Deduplicate chats by ID.
	type chatInfo struct {
		ID        int64  `json:"id"`
		Type      string `json:"type"`
		Title     string `json:"title,omitempty"`
		Username  string `json:"username,omitempty"`
		FirstName string `json:"first_name,omitempty"`
		LastName  string `json:"last_name,omitempty"`
	}
	seen := make(map[int64]bool)
	var chats []chatInfo

	addChat := func(id int64, typ, title, username, first, last string) {
		if seen[id] {
			return
		}
		seen[id] = true
		chats = append(chats, chatInfo{
			ID: id, Type: typ, Title: title,
			Username: username, FirstName: first, LastName: last,
		})
	}

	for _, upd := range updResult.Result {
		if upd.Message != nil {
			c := upd.Message.Chat
			addChat(c.ID, c.Type, c.Title, c.Username, c.FirstName, c.LastName)
		}
		if upd.ChannelPost != nil {
			c := upd.ChannelPost.Chat
			addChat(c.ID, c.Type, c.Title, c.Username, c.FirstName, c.LastName)
		}
	}

	// ── Respond ───────────────────────────────────────────────────────────────
	type response struct {
		OK          bool       `json:"ok"`
		BotUsername string     `json:"bot_username"`
		Chats       []chatInfo `json:"chats"`
		Hint        string     `json:"hint,omitempty"`
	}
	out := response{
		OK:          true,
		BotUsername: meResult.Result.Username,
		Chats:       chats,
	}
	if len(chats) == 0 {
		out.Hint = "No chats found. Send a message to your bot (or add it to a group) then try again."
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(out) //nolint:errcheck
}

// handleTelegramBotManage is a multi-action endpoint for managing a Telegram
// bot and its target chat from the admin UI.
//
// POST /admin/notifications/telegram-manage
//
// Request body:
//
//	{
//	  "bot_token":   "123:ABC…",   // required for all actions
//	  "chat_id":     "-100123…",   // required for chat-scoped actions
//	  "action":      "get_info" | "set_title" | "set_description" |
//	                 "export_invite_link" | "get_admins" |
//	                 "get_commands" | "set_commands" |
//	                 "set_bot_name" | "set_bot_description",
//	  "title":       "New title",          // set_title
//	  "description": "New description",    // set_description, set_bot_description
//	  "name":        "New bot name",       // set_bot_name
//	  "commands": [                        // set_commands
//	    {"command": "help", "description": "Show help"}
//	  ]
//	}
//
// Response always contains {"ok": true/false, "error": "…"} plus action-specific fields.
func handleTelegramBotManage(w http.ResponseWriter, r *http.Request) {
	handleTelegramBotManageWithManager(w, r, nil)
}

// handleTelegramBotManageWithManager is the real implementation; nm is used to
// resolve a saved channel's bot_token when the UI sends an empty token (masked).
func handleTelegramBotManageWithManager(w http.ResponseWriter, r *http.Request, nm *NotificationManager) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "POST required"}) //nolint:errcheck
		return
	}

	type botCommand struct {
		Command     string `json:"command"`
		Description string `json:"description"`
	}

	var req struct {
		// Channel is the named channel to look up when BotToken is empty.
		Channel     string       `json:"channel"`
		BotToken    string       `json:"bot_token"`
		ChatID      string       `json:"chat_id"`
		Action      string       `json:"action"`
		Title       string       `json:"title"`
		Description string       `json:"description"`
		Name        string       `json:"name"`
		Commands    []botCommand `json:"commands"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid JSON: " + err.Error()}) //nolint:errcheck
		return
	}

	// If the UI sent an empty token (masked channel), resolve from saved config.
	if req.BotToken == "" && req.Channel != "" && nm != nil {
		cfg := nm.Config()
		if cfg != nil {
			if ch, ok := cfg.Channels[req.Channel]; ok {
				req.BotToken = ch.BotToken
				if req.ChatID == "" {
					req.ChatID = ch.ChatID
				}
			}
		}
	}

	if req.BotToken == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "bot_token is required (or provide a saved channel name)"}) //nolint:errcheck
		return
	}
	if req.Action == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "action is required"}) //nolint:errcheck
		return
	}

	apiBase := fmt.Sprintf("https://api.telegram.org/bot%s", req.BotToken)
	client := &http.Client{Timeout: 10 * time.Second}

	tgGet := func(endpoint string) (map[string]interface{}, error) {
		resp, err := client.Get(apiBase + endpoint)
		if err != nil {
			return nil, fmt.Errorf("telegram API unreachable: %w", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var out map[string]interface{}
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, fmt.Errorf("unexpected response: %s", string(body))
		}
		return out, nil
	}

	tgPost := func(endpoint string, payload interface{}) (map[string]interface{}, error) {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("marshal error: %w", err)
		}
		resp, err := client.Post(apiBase+endpoint, "application/json", bytes.NewReader(b))
		if err != nil {
			return nil, fmt.Errorf("telegram API unreachable: %w", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var out map[string]interface{}
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, fmt.Errorf("unexpected response: %s", string(body))
		}
		return out, nil
	}

	tgOK := func(res map[string]interface{}) bool {
		ok, _ := res["ok"].(bool)
		return ok
	}
	tgDesc := func(res map[string]interface{}) string {
		if d, ok := res["description"].(string); ok && d != "" {
			return d
		}
		return "unknown Telegram API error"
	}

	respond := func(payload interface{}) {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(payload) //nolint:errcheck
	}
	fail := func(msg string) {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg}) //nolint:errcheck
	}

	switch req.Action {

	case "get_info":
		if req.ChatID == "" {
			fail("chat_id is required for get_info")
			return
		}
		meRes, err := tgGet("/getMe")
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(meRes) {
			fail("getMe: " + tgDesc(meRes))
			return
		}
		chatRes, err := tgPost("/getChat", map[string]string{"chat_id": req.ChatID})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(chatRes) {
			fail("getChat: " + tgDesc(chatRes))
			return
		}
		countRes, err := tgPost("/getChatMemberCount", map[string]string{"chat_id": req.ChatID})
		if err != nil {
			fail(err.Error())
			return
		}
		memberCount := 0
		if tgOK(countRes) {
			if n, ok := countRes["result"].(float64); ok {
				memberCount = int(n)
			}
		}

		// Fetch bot description and short description. These are separate API
		// calls not included in getMe, so we fetch them best-effort (failures
		// are non-fatal — the UI just shows an empty field).
		botDescription := ""
		if descRes, descErr := tgGet("/getMyDescription"); descErr == nil && tgOK(descRes) {
			if result, ok := descRes["result"].(map[string]interface{}); ok {
				botDescription, _ = result["description"].(string)
			}
		}
		botShortDescription := ""
		if sdRes, sdErr := tgGet("/getMyShortDescription"); sdErr == nil && tgOK(sdRes) {
			if result, ok := sdRes["result"].(map[string]interface{}); ok {
				botShortDescription, _ = result["short_description"].(string)
			}
		}

		respond(map[string]interface{}{
			"ok":                    true,
			"bot":                   meRes["result"],
			"chat":                  chatRes["result"],
			"member_count":          memberCount,
			"bot_description":       botDescription,
			"bot_short_description": botShortDescription,
		})

	case "set_title":
		if req.ChatID == "" {
			fail("chat_id is required")
			return
		}
		if req.Title == "" {
			fail("title is required")
			return
		}
		res, err := tgPost("/setChatTitle", map[string]string{"chat_id": req.ChatID, "title": req.Title})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("setChatTitle: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "message": "Chat title updated."})

	case "set_description":
		if req.ChatID == "" {
			fail("chat_id is required")
			return
		}
		res, err := tgPost("/setChatDescription", map[string]string{"chat_id": req.ChatID, "description": req.Description})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("setChatDescription: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "message": "Chat description updated."})

	case "export_invite_link":
		if req.ChatID == "" {
			fail("chat_id is required")
			return
		}
		res, err := tgPost("/exportChatInviteLink", map[string]string{"chat_id": req.ChatID})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("exportChatInviteLink: " + tgDesc(res))
			return
		}
		link, _ := res["result"].(string)
		respond(map[string]interface{}{"ok": true, "invite_link": link})

	case "get_admins":
		if req.ChatID == "" {
			fail("chat_id is required")
			return
		}
		res, err := tgPost("/getChatAdministrators", map[string]string{"chat_id": req.ChatID})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("getChatAdministrators: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "admins": res["result"]})

	case "get_commands":
		res, err := tgGet("/getMyCommands")
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("getMyCommands: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "commands": res["result"]})

	case "set_commands":
		if req.Commands == nil {
			req.Commands = []botCommand{}
		}
		res, err := tgPost("/setMyCommands", map[string]interface{}{"commands": req.Commands})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("setMyCommands: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "message": "Bot commands updated."})

	case "set_bot_name":
		if req.Name == "" {
			fail("name is required")
			return
		}
		res, err := tgPost("/setMyName", map[string]string{"name": req.Name})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("setMyName: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "message": "Bot name updated."})

	case "set_bot_description":
		res, err := tgPost("/setMyDescription", map[string]string{"description": req.Description})
		if err != nil {
			fail(err.Error())
			return
		}
		if !tgOK(res) {
			fail("setMyDescription: " + tgDesc(res))
			return
		}
		respond(map[string]interface{}{"ok": true, "message": "Bot description updated."})

	default:
		fail("unknown action: " + req.Action)
	}
}

// handleTelegramListenerStatus returns the runtime status of all active
// Telegram bot command listeners (one per channel with bot_commands.enabled=true).
// GET /admin/notifications/telegram-listener-status
func handleTelegramListenerStatus(w http.ResponseWriter, r *http.Request, nm *NotificationManager) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "GET required"}) //nolint:errcheck
		return
	}

	if nm == nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "listeners": map[string]interface{}{}}) //nolint:errcheck
		return
	}

	statuses := nm.ListenerStatus()
	if statuses == nil {
		statuses = map[string]listenerStatus{}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
		"ok":        true,
		"listeners": statuses,
	})
}

// handleTelegramAvailableCommands returns the list of optional bot commands
// registered in botCommands (telegram_bot_commands.go), sorted alphabetically.
// The UI uses this to build the command checkboxes dynamically so adding a new
// command to the Go file is sufficient — no JS changes required.
// GET /admin/notifications/telegram-available-commands
func handleTelegramAvailableCommands(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "GET required"}) //nolint:errcheck
		return
	}

	type cmdInfo struct {
		Name     string `json:"name"`
		Desc     string `json:"desc"`
		ReadOnly bool   `json:"read_only"`
	}
	names := sortedBotCommandNames()
	cmds := make([]cmdInfo, 0, len(names))
	for _, name := range names {
		bc := botCommands[name]
		cmds = append(cmds, cmdInfo{Name: name, Desc: bc.desc, ReadOnly: bc.readOnly})
	}
	json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
		"ok":       true,
		"commands": cmds,
	})
}

// handleTelegramCommandHistory returns the in-memory command history for all
// active Telegram bot listeners (newest-first, up to 100 entries per channel).
func handleTelegramCommandHistory(w http.ResponseWriter, r *http.Request, nm *NotificationManager) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "GET required"}) //nolint:errcheck
		return
	}

	if nm == nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "history": map[string]interface{}{}}) //nolint:errcheck
		return
	}

	history := nm.CommandHistory()
	if history == nil {
		history = map[string][]commandHistoryEntry{}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{ //nolint:errcheck
		"ok":      true,
		"history": history,
	})
}
