package main

// telegram_bot_commands.go — all bot command handlers live here.
//
// To add a new command:
//  1. Write a handler:  func (l *TelegramBotListener) handleFoo(chatID int64) (string, string, bool)
//  2. Add one entry to botCommands below.
//
// No other file needs to be touched.

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

// botCommand describes a single optional bot command.
// The handler is called by dispatch() when the command is received and enabled.
// It must return (botText, telegramAPIResponse, apiOK).
type botCommand struct {
	// desc is shown in /help and registered with Telegram's setMyCommands.
	desc string
	// handler sends the reply and returns the bot text, raw Telegram API JSON,
	// and whether the API call succeeded (ok:true in the response).
	handler func(l *TelegramBotListener, chatID int64) (string, string, bool)
}

// botCommands is the registry of all optional commands (excludes /help which is
// always enabled). Add new commands here — dispatch(), /help, and setMyCommands
// all derive their behaviour from this map automatically.
//
// The order of entries in this map is not guaranteed by Go, but the commands are
// sorted alphabetically when building the /help message and setMyCommands payload
// so the output is deterministic.
var botCommands = map[string]botCommand{
	"rotator": {
		desc:    "Show current rotator azimuth",
		handler: (*TelegramBotListener).handleRotator,
	},
	"sessions": {
		desc:    "Show active listener sessions",
		handler: (*TelegramBotListener).handleSessions,
	},
	"switch": {
		desc:    "Show active antenna switch port",
		handler: (*TelegramBotListener).handleSwitch,
	},
}

// ─── Command handlers ─────────────────────────────────────────────────────────

// handleSessions sends a summary of active sessions to the chat.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSessions(chatID int64) (string, string, bool) {
	if l.sessions == nil {
		msg := "📡 Session data unavailable."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	allSessions := l.sessions.GetAllSessionsInfo()

	// Filter to real audio sessions only (exclude spectrum-only and internal).
	type sessionRow struct {
		freq       uint64
		mode       string
		clientIP   string
		country    string
		countryCC  string
		isBypassed bool
		createdAt  time.Time
	}
	var rows []sessionRow
	for _, s := range allSessions {
		isSpectrum, _ := s["is_spectrum"].(bool)
		isInternal, _ := s["is_internal"].(bool)
		if isSpectrum || isInternal {
			continue
		}
		freq, _ := s["frequency"].(uint64)
		mode, _ := s["mode"].(string)
		clientIP, _ := s["client_ip"].(string)
		country, _ := s["country"].(string)
		cc, _ := s["country_code"].(string)
		bypassed, _ := s["is_bypassed"].(bool)
		var createdAt time.Time
		if ts, ok := s["created_at"].(string); ok {
			createdAt, _ = time.Parse(time.RFC3339, ts)
		}
		rows = append(rows, sessionRow{
			freq:       freq,
			mode:       mode,
			clientIP:   clientIP,
			country:    country,
			countryCC:  cc,
			isBypassed: bypassed,
			createdAt:  createdAt,
		})
	}

	if len(rows) == 0 {
		msg := "📡 No active listeners right now."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>Active Sessions: %d</b>\n\n", len(rows))
	for i, r := range rows {
		freqMHz := float64(r.freq) / 1_000_000.0
		// Build suffix: IP, optional flag+country, optional bypassed tag, duration.
		// All user-supplied strings are HTML-escaped to avoid breaking Telegram's
		// HTML parser (e.g. country names like "Bosnia & Herzegovina").
		var suffix strings.Builder
		if r.clientIP != "" {
			suffix.WriteString(" | ")
			suffix.WriteString(html.EscapeString(r.clientIP))
		}
		if r.country != "" {
			flag := countryCodeToFlag(r.countryCC)
			suffix.WriteString(" ")
			if flag != "" {
				suffix.WriteString(flag)
				suffix.WriteString(" ")
			}
			suffix.WriteString(html.EscapeString(r.country))
		}
		if r.isBypassed {
			suffix.WriteString(" [bypassed]")
		}
		if !r.createdAt.IsZero() {
			suffix.WriteString(" | ")
			// HTML-escape the duration: fmtSessionDuration can return "<1m" which
			// would be interpreted as an HTML tag by Telegram's HTML parser.
			suffix.WriteString(html.EscapeString(fmtSessionDuration(time.Since(r.createdAt))))
		}
		fmt.Fprintf(&sb, "%d. %.3f MHz | %s%s\n", i+1, freqMHz, html.EscapeString(r.mode), suffix.String())
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleRotator reports the current rotator azimuth (and elevation if non-zero).
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleRotator(chatID int64) (string, string, bool) {
	if l.rotctl == nil {
		msg := "🔄 Rotator is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	state := l.rotctl.controller.GetState()
	connected := l.rotctl.controller.client.IsConnected()

	var sb strings.Builder
	sb.WriteString("🔄 <b>Rotator Status</b>\n\n")

	if !connected {
		sb.WriteString("⚠️ <i>Not connected to rotctld</i>\n")
	} else if state.Position != nil {
		az := int(state.Position.Azimuth + 0.5)
		el := int(state.Position.Elevation + 0.5)
		fmt.Fprintf(&sb, "Azimuth: <b>%d°</b>\n", az)
		if el != 0 {
			fmt.Fprintf(&sb, "Elevation: <b>%d°</b>\n", el)
		}
		if state.Moving {
			sb.WriteString("Status: <i>Moving…</i>\n")
		} else {
			sb.WriteString("Status: Stopped\n")
		}
	} else {
		sb.WriteString("<i>Position unknown</i>\n")
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleSwitch reports the currently active antenna switch port(s) and their labels.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSwitch(chatID int64) (string, string, bool) {
	if l.antSwitch == nil {
		msg := "📡 Antenna switch is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	info := l.antSwitch.GetInfo()

	var sb strings.Builder
	sb.WriteString("📡 <b>Antenna Switch Status</b>\n\n")

	grounded, _ := info["grounded"].(bool)
	if grounded {
		sb.WriteString("⚠️ <b>All antennas grounded</b>\n")
	} else {
		selected, _ := info["selected"].([]int)
		labels, _ := info["active_labels"].([]string)
		if len(selected) == 0 {
			sb.WriteString("<i>No antenna selected</i>\n")
		} else {
			for i, port := range selected {
				label := fmt.Sprintf("Antenna %d", port)
				if i < len(labels) && labels[i] != "" {
					label = labels[i]
				}
				fmt.Fprintf(&sb, "Port %d: <b>%s</b>\n", port, html.EscapeString(label))
			}
		}
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleHelp sends a list of all known commands, marking each as enabled or
// disabled based on the current config. /help is always shown as enabled at the
// end — it cannot be disabled.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleHelp(chatID int64) (string, string, bool) {
	var sb strings.Builder
	sb.WriteString("🤖 <b>Bot Commands</b>\n\n")

	for _, name := range sortedBotCommandNames() {
		bc := botCommands[name]
		if l.commandEnabled(name) {
			sb.WriteString("✅ /" + name + " — " + bc.desc + "\n")
		} else {
			sb.WriteString("❌ /" + name + " — " + bc.desc + " <i>(disabled)</i>\n")
		}
	}
	// /help is always available — show it last, always enabled.
	sb.WriteString("✅ /help — Show this help message\n")

	sb.WriteString("\n<i>Only chat admins can use these commands.</i>")
	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// sortedBotCommandNames returns the keys of botCommands sorted alphabetically.
// Used to produce deterministic output in /help and setMyCommands.
func sortedBotCommandNames() []string {
	names := make([]string, 0, len(botCommands))
	for name := range botCommands {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ─── Helpers used by command handlers ─────────────────────────────────────────

// countryCodeToFlag converts an ISO 3166-1 alpha-2 country code to a flag emoji.
// Returns an empty string for unknown/empty codes.
func countryCodeToFlag(cc string) string {
	if len(cc) != 2 {
		return ""
	}
	cc = strings.ToUpper(cc)
	r1 := rune(cc[0]) - 'A' + 0x1F1E6
	r2 := rune(cc[1]) - 'A' + 0x1F1E6
	return string([]rune{r1, r2})
}

// fmtSessionDuration formats a session duration as a human-friendly string.
// Examples: "<1m", "45m", "1h15m", "3h".
func fmtSessionDuration(d time.Duration) string {
	if d < time.Minute {
		return "<1m"
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h == 0 {
		return fmt.Sprintf("%dm", m)
	}
	if m == 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dh%dm", h, m)
}
