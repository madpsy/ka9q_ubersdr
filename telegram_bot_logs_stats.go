package main

// telegram_bot_logs_stats.go — /logs and /stats command handlers.

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

func init() {
	botCommands["logs"] = botCommand{
		desc:      "Show system log containers, or last 20 lines for a container",
		readOnly:  true,
		writeHint: "",
		handler:   (*TelegramBotListener).handleLogs,
	}
	botCommands["stats"] = botCommand{
		desc:     "Show 24-hour listener session statistics",
		readOnly: true,
		handler:  (*TelegramBotListener).handleStats,
	}
}

// handleLogs lists available log containers (no args) or shows the last 20
// lines for the named container (args = container name).
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleLogs(chatID int64, args string) (string, string, bool) {
	receiver := GetLogReceiver()
	if receiver == nil {
		msg := "📋 Log receiver is not initialised on this server."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	containerName := strings.TrimSpace(args)

	// ── No argument: list available containers ────────────────────────────────
	if containerName == "" {
		names := receiver.GetContainerNames()
		if len(names) == 0 {
			msg := "📋 No log containers available yet."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		sort.Strings(names)
		var sb strings.Builder
		sb.WriteString("📋 <b>Available log containers</b>\n\n")
		for _, n := range names {
			count := receiver.GetLogCount(n)
			fmt.Fprintf(&sb, "• <code>%s</code> (%s entries)\n",
				html.EscapeString(n), fmtCount(count))
		}
		sb.WriteString("\nUse <code>/logs &lt;container&gt;</code> to view the last 20 lines.")
		msg := sb.String()
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Named container: show last 20 lines ───────────────────────────────────
	const maxLines = 20
	entries := receiver.GetRecentLogs(maxLines, containerName)
	if len(entries) == 0 {
		// Check whether the container exists at all.
		known := receiver.GetContainerNames()
		found := false
		for _, n := range known {
			if strings.EqualFold(n, containerName) {
				found = true
				break
			}
		}
		if !found {
			msg := fmt.Sprintf("📋 Container <code>%s</code> not found. Use <code>/logs</code> to list available containers.",
				html.EscapeString(containerName))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		msg := fmt.Sprintf("📋 No log entries for <code>%s</code> yet.", html.EscapeString(containerName))
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📋 <b>%s</b> — last %d lines\n\n",
		html.EscapeString(containerName), len(entries))

	for _, e := range entries {
		ts := e.Timestamp.UTC().Format("15:04:05")
		// Strip trailing newline that Fluent Bit often appends.
		line := strings.TrimRight(e.Log, "\n\r")
		fmt.Fprintf(&sb, "<code>%s</code> %s\n",
			ts, html.EscapeString(line))
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleStats reports 24-hour listener session statistics derived from the
// on-disk session activity log. Mirrors the data shown in the admin Stats tab
// but scoped to the last 24 hours.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleStats(chatID int64, args string) (string, string, bool) {
	if l.config == nil {
		msg := "📊 Stats unavailable (config not wired)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	if l.readDB == nil {
		msg := "📊 Session activity data is not available (database not configured)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	endTime := time.Now().UTC()
	startTime := endTime.Add(-24 * time.Hour)

	logs, err := ReadActivityLogsFromDB(l.readDB, startTime, endTime)
	if err != nil {
		msg := fmt.Sprintf("📊 Failed to read activity logs: %s", html.EscapeString(err.Error()))
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Only count regular (non-bypassed) sessions, matching the public stats API.
	logs = FilterSessionsByAuthMethod(logs, []string{"regular"})
	events := convertLogsToEvents(logs)
	endEvents := filterEventsByType(events, []string{"session_end"})

	// ── Aggregate ─────────────────────────────────────────────────────────────
	totalSessions := len(endEvents)
	uniqueIPs := make(map[string]bool)
	uniqueCountries := make(map[string]bool)
	bandCounts := make(map[string]int)
	modeCounts := make(map[string]int)

	var totalDurationSecs float64
	durationCount := 0

	for _, ev := range endEvents {
		if ev.ClientIP != "" {
			uniqueIPs[ev.ClientIP] = true
		}
		if ev.Country != "" {
			uniqueCountries[ev.Country] = true
		}
		for _, b := range ev.Bands {
			if b != "" {
				bandCounts[b]++
			}
		}
		for _, m := range ev.Modes {
			if m != "" && isValidMode(m) {
				modeCounts[strings.ToLower(m)]++
			}
		}
		if ev.Duration != nil {
			totalDurationSecs += *ev.Duration
			durationCount++
		}
	}

	// ── Format ────────────────────────────────────────────────────────────────
	var sb strings.Builder
	sb.WriteString("📊 <b>24-Hour Session Stats</b>\n")
	fmt.Fprintf(&sb, "<i>%s → %s UTC</i>\n\n",
		startTime.Format("02 Jan 15:04"),
		endTime.Format("02 Jan 15:04"))

	fmt.Fprintf(&sb, "👥 <b>Sessions:</b> %s\n", fmtCount(totalSessions))
	fmt.Fprintf(&sb, "🌐 <b>Unique IPs:</b> %s\n", fmtCount(len(uniqueIPs)))
	fmt.Fprintf(&sb, "🏳️ <b>Countries:</b> %s\n", fmtCount(len(uniqueCountries)))

	if durationCount > 0 {
		avgSecs := totalDurationSecs / float64(durationCount)
		fmt.Fprintf(&sb, "⏱️ <b>Avg session:</b> %s\n", fmtDurationSecs(avgSecs))
	}

	// Top bands (up to 5).
	if len(bandCounts) > 0 {
		sb.WriteString("\n<b>Top bands:</b>\n")
		type kv struct {
			k string
			v int
		}
		var sorted []kv
		for k, v := range bandCounts {
			sorted = append(sorted, kv{k, v})
		}
		sort.Slice(sorted, func(i, j int) bool {
			return sorted[i].v > sorted[j].v
		})
		limit := 5
		if len(sorted) < limit {
			limit = len(sorted)
		}
		for _, item := range sorted[:limit] {
			fmt.Fprintf(&sb, "  %s: %s session(s)\n",
				html.EscapeString(item.k), fmtCount(item.v))
		}
	}

	// Top modes (up to 5).
	if len(modeCounts) > 0 {
		sb.WriteString("\n<b>Top modes:</b>\n")
		type kv struct {
			k string
			v int
		}
		var sorted []kv
		for k, v := range modeCounts {
			sorted = append(sorted, kv{k, v})
		}
		sort.Slice(sorted, func(i, j int) bool {
			return sorted[i].v > sorted[j].v
		})
		limit := 5
		if len(sorted) < limit {
			limit = len(sorted)
		}
		for _, item := range sorted[:limit] {
			fmt.Fprintf(&sb, "  %s: %s session(s)\n",
				strings.ToUpper(html.EscapeString(item.k)), fmtCount(item.v))
		}
	}

	if totalSessions == 0 {
		sb.WriteString("\n<i>No completed sessions recorded in the last 24 hours.</i>")
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// fmtDurationSecs formats a duration given in seconds as a human-friendly string.
// Examples: "45s", "3m 20s", "1h 15m".
func fmtDurationSecs(secs float64) string {
	d := time.Duration(secs) * time.Second
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	switch {
	case h > 0 && m > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case h > 0:
		return fmt.Sprintf("%dh", h)
	case m > 0 && s > 0:
		return fmt.Sprintf("%dm %ds", m, s)
	case m > 0:
		return fmt.Sprintf("%dm", m)
	default:
		return fmt.Sprintf("%ds", s)
	}
}
