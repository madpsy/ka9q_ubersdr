package main

// telegram_bot_commands.go — all bot command handlers live here.
//
// To add a new command:
//  1. Write a handler:  func (l *TelegramBotListener) handleFoo(chatID int64, args string) (string, string, bool)
//  2. Add one entry to botCommands below (set readOnly:true if the command never changes hardware state).
//
// No other file needs to be touched.

import (
	"fmt"
	"html"
	"sort"
	"strconv"
	"strings"
	"time"
)

// botCommand describes a single optional bot command.
// The handler is called by dispatch() when the command is received and enabled.
// It must return (botText, telegramAPIResponse, apiOK).
type botCommand struct {
	// desc is shown in /help and registered with Telegram's setMyCommands.
	desc string
	// readOnly is true when the command only reports state and never accepts
	// arguments that change hardware. The UI uses this to decide whether to
	// show a "allow write" toggle for the command.
	readOnly bool
	// handler sends the reply and returns the bot text, raw Telegram API JSON,
	// and whether the API call succeeded (ok:true in the response).
	// args is the text after the command token (empty string for status-only calls).
	handler func(l *TelegramBotListener, chatID int64, args string) (string, string, bool)
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
		desc:     "Show (or set) rotator azimuth",
		readOnly: false,
		handler:  (*TelegramBotListener).handleRotator,
	},
	"sessions": {
		desc:     "Show active listener sessions",
		readOnly: true,
		handler:  (*TelegramBotListener).handleSessions,
	},
	"switch": {
		desc:     "Show (or set) antenna switch port",
		readOnly: false,
		handler:  (*TelegramBotListener).handleSwitch,
	},
}

// ─── Command handlers ─────────────────────────────────────────────────────────

// handleSessions sends a summary of active sessions to the chat.
// args is ignored — sessions is always read-only.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSessions(chatID int64, args string) (string, string, bool) {
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

// handleRotator reports the current rotator azimuth (and elevation if non-zero),
// or — when args is non-empty and write access is enabled — moves to the given azimuth.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleRotator(chatID int64, args string) (string, string, bool) {
	if l.rotctl == nil {
		msg := "🔄 Rotator is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Set mode: /rotator <azimuth> ─────────────────────────────────────────
	if args != "" {
		if !l.commandWriteEnabled("rotator") {
			msg := "⚠️ Write access is not enabled for /rotator. Enable it in the bot listener config."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		az, err := strconv.ParseFloat(args, 64)
		if err != nil || az < 0 || az > 360 {
			msg := "⚠️ Invalid azimuth. Use a number 0–360, e.g. <code>/rotator 180</code>"
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		// Guard: only one move confirmation goroutine at a time.
		l.rotatorMoveMu.Lock()
		if l.rotatorMovePending {
			l.rotatorMoveMu.Unlock()
			msg := "⚠️ Already moving — use /rotator to check progress."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		l.rotatorMovePending = true
		l.rotatorMoveMu.Unlock()

		// Send the move command (returns quickly — does not wait for arrival).
		if err := l.rotctl.controller.SetAzimuth(az); err != nil {
			l.rotatorMoveMu.Lock()
			l.rotatorMovePending = false
			l.rotatorMoveMu.Unlock()
			msg := fmt.Sprintf("⚠️ Failed to send move command: %s", html.EscapeString(err.Error()))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		ackMsg := fmt.Sprintf("🔄 Moving to <b>%d°</b>… I'll confirm when done.", int(az+0.5))
		apiResp, apiOK := l.sendMessage(chatID, ackMsg)

		// Spawn goroutine to poll until the rotator stops, then send confirmation.
		go func() {
			defer func() {
				l.rotatorMoveMu.Lock()
				l.rotatorMovePending = false
				l.rotatorMoveMu.Unlock()
			}()
			const pollInterval = 2 * time.Second
			const timeout = 5 * time.Minute
			deadline := time.Now().Add(timeout)
			for time.Now().Before(deadline) {
				time.Sleep(pollInterval)
				state := l.rotctl.controller.GetState()
				if !state.Moving {
					var confirmMsg string
					if state.Position != nil {
						reached := int(state.Position.Azimuth + 0.5)
						confirmMsg = fmt.Sprintf("🔄 Reached <b>%d°</b> ✅", reached)
					} else {
						confirmMsg = "🔄 Rotator stopped ✅"
					}
					l.sendMessage(chatID, confirmMsg) //nolint:errcheck
					return
				}
			}
			// Timed out.
			state := l.rotctl.controller.GetState()
			var timeoutMsg string
			if state.Position != nil {
				cur := int(state.Position.Azimuth + 0.5)
				timeoutMsg = fmt.Sprintf("⚠️ Timed out — rotator still moving. Currently at <b>%d°</b>.", cur)
			} else {
				timeoutMsg = "⚠️ Timed out waiting for rotator to reach target."
			}
			l.sendMessage(chatID, timeoutMsg) //nolint:errcheck
		}()

		return ackMsg, apiResp, apiOK
	}

	// ── Status mode: /rotator ─────────────────────────────────────────────────
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

// handleSwitch reports the currently active antenna switch port(s) and their labels,
// or — when args is non-empty and write access is enabled — selects a port or grounds all.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSwitch(chatID int64, args string) (string, string, bool) {
	if l.antSwitch == nil {
		msg := "📡 Antenna switch is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Set mode: /switch <port|ground|0> ────────────────────────────────────
	if args != "" {
		if !l.commandWriteEnabled("switch") {
			msg := "⚠️ Write access is not enabled for /switch. Enable it in the bot listener config."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		numPorts := l.antSwitch.config.NumAntennas
		argLower := strings.ToLower(strings.TrimSpace(args))

		if argLower == "ground" || argLower == "0" {
			// Ground all antennas.
			state, _, err := l.antSwitch.groundAll()
			if err != nil {
				msg := fmt.Sprintf("⚠️ Failed to ground antennas: %s", html.EscapeString(err.Error()))
				apiResp, apiOK := l.sendMessage(chatID, msg)
				return msg, apiResp, apiOK
			}
			_ = state
			msg := "📡 <b>All antennas grounded</b> ✅"
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		n, err := strconv.Atoi(argLower)
		if err != nil || n < 1 || n > numPorts {
			msg := fmt.Sprintf("⚠️ Invalid port. Use 1–%d or <code>ground</code>, e.g. <code>/switch 2</code>", numPorts)
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		_, _, err = l.antSwitch.selectAntenna(n)
		if err != nil {
			msg := fmt.Sprintf("⚠️ Failed to select port %d: %s", n, html.EscapeString(err.Error()))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		label := l.antSwitch.antennaLabel(n)
		msg := fmt.Sprintf("📡 Switched to Port %d: <b>%s</b> ✅", n, html.EscapeString(label))
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Status mode: /switch ──────────────────────────────────────────────────
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
// args is ignored — help is always read-only.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleHelp(chatID int64, args string) (string, string, bool) {
	var sb strings.Builder
	sb.WriteString("🤖 <b>Bot Commands</b>\n\n")

	for _, name := range sortedBotCommandNames() {
		bc := botCommands[name]
		enabled := l.commandEnabled(name)
		var line string
		if enabled {
			line = "✅ /" + name + " — " + bc.desc
			if !bc.readOnly && l.commandWriteEnabled(name) {
				line += " <i>(read/write)</i>"
			}
		} else {
			line = "❌ /" + name + " — " + bc.desc + " <i>(disabled)</i>"
		}
		sb.WriteString(line + "\n")
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
