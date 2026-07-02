package main

// telegram_bot_noise.go — /noise command handler.
//
// /noise          → list available bands with a one-line summary each
// /noise <band>   → full per-band metrics card matching noisefloor.html

import (
	"fmt"
	"html"
	"sort"
	"strings"
)

func init() {
	botCommands["noise"] = botCommand{
		desc:     "Show noise floor metrics per band (e.g. /noise 20m)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleNoise,
	}
}

// handleNoise lists available bands (no args) or shows the full metrics card
// for the requested band (args = band name, e.g. "20m").
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleNoise(chatID int64, args string) (string, string, bool) {
	if l.noiseFloor == nil {
		msg := "📡 Noise floor monitoring is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	measurements := l.noiseFloor.GetLatestMeasurements()
	if len(measurements) == 0 {
		msg := "📡 No noise floor data available yet."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Build ordered band list: known HF bands first, then extras alphabetically.
	knownSet := make(map[string]bool, len(hfBandOrder))
	for _, b := range hfBandOrder {
		knownSet[b] = true
	}
	var ordered []string
	for _, b := range hfBandOrder {
		if _, ok := measurements[b]; ok {
			ordered = append(ordered, b)
		}
	}
	var extra []string
	for b := range measurements {
		if !knownSet[b] {
			extra = append(extra, b)
		}
	}
	sort.Strings(extra)
	ordered = append(ordered, extra...)

	bandArg := strings.ToLower(strings.TrimSpace(args))

	// ── No argument: list all bands with a one-line summary ───────────────────
	if bandArg == "" {
		var sb strings.Builder
		sb.WriteString("📡 <b>Noise Floor — Available Bands</b>\n\n")
		for _, band := range ordered {
			m := measurements[band]
			if m == nil {
				continue
			}
			quality := bandSNRQuality(m.FT8SNR)
			var snrPart string
			if m.FT8SNR > 0 {
				snrPart = fmt.Sprintf(" · FT8 %.1f dB (%s)", m.FT8SNR, quality)
			}
			fmt.Fprintf(&sb, "%s <b>%s</b>: P5 %.1f dBm%s\n",
				bandSNREmoji(quality), html.EscapeString(band), m.P5DB, snrPart)
		}
		sb.WriteString("\nUse <code>/noise &lt;band&gt;</code> for full metrics, e.g. <code>/noise 20m</code>")
		msg := sb.String()
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Named band: full metrics card ─────────────────────────────────────────
	// Accept "20m", "20M", "20" (without the m suffix for convenience).
	m, ok := measurements[bandArg]
	if !ok {
		// Try appending "m" if the user typed just the number.
		m, ok = measurements[bandArg+"m"]
		if ok {
			bandArg = bandArg + "m"
		}
	}
	if !ok {
		// Build a comma-separated list of available bands for the error message.
		names := make([]string, 0, len(ordered))
		for _, b := range ordered {
			names = append(names, b)
		}
		msg := fmt.Sprintf("📡 Band <code>%s</code> not found. Available: %s",
			html.EscapeString(args), html.EscapeString(strings.Join(names, ", ")))
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	quality := bandSNRQuality(m.FT8SNR)
	var snrLabel string
	if m.FT8SNR > 0 {
		snrLabel = fmt.Sprintf(" %.1f dB %s %s", m.FT8SNR, bandSNREmoji(quality), quality)
	} else {
		snrLabel = " — no FT8 data"
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>%s Metrics%s</b>\n", html.EscapeString(strings.ToUpper(bandArg)), snrLabel)
	fmt.Fprintf(&sb, "Last update: %s UTC\n\n", m.Timestamp.UTC().Format("15:04:05"))

	fmt.Fprintf(&sb, "Noise Floor (P5):  <b>%.1f dB</b>\n", m.P5DB)
	fmt.Fprintf(&sb, "Signal Peak (Max): <b>%.1f dB</b>\n", m.MaxDB)
	fmt.Fprintf(&sb, "P95:               <b>%.1f dB</b>\n", m.P95DB)
	fmt.Fprintf(&sb, "Dynamic Range:     <b>%.1f dB</b>\n", m.DynamicRange)
	fmt.Fprintf(&sb, "Median:            <b>%.1f dB</b>\n", m.MedianDB)
	fmt.Fprintf(&sb, "Band Occupancy:    <b>%.1f%%</b>\n", m.OccupancyPct)
	if m.FT8SNR > 0 {
		fmt.Fprintf(&sb, "FT8 SNR:           <b>%.1f dB</b>\n", m.FT8SNR)
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}
