package main

// telegram_bot_cw_voice.go — /cw and /voice command handlers.

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

func init() {
	botCommands["cw"] = botCommand{
		desc:     "Show last 10 CW spots (optionally filtered by band, e.g. /cw 20m)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleCW,
	}
	botCommands["voice"] = botCommand{
		desc:     "Show detected voice/SSB activity across all bands (or /voice 20m for one band)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleVoice,
	}
}

// ─── /cw ──────────────────────────────────────────────────────────────────────

// handleCW shows the last 10 CW spots from the live buffer, optionally
// filtered to a specific band.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleCW(chatID int64, args string) (string, string, bool) {
	if l.dxClusterWS == nil {
		msg := "📡 CW spot data is not available (DX cluster not enabled)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	bandArg := strings.ToLower(strings.TrimSpace(args))
	const maxSpots = 10

	spots := l.dxClusterWS.GetRecentCWSpots(maxSpots, bandArg)
	if len(spots) == 0 {
		var msg string
		if bandArg != "" {
			msg = fmt.Sprintf("📡 No CW spots on <b>%s</b> in the buffer yet.", html.EscapeString(bandArg))
		} else {
			msg = "📡 No CW spots in the buffer yet."
		}
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Reverse so newest is first.
	for i, j := 0, len(spots)-1; i < j; i, j = i+1, j-1 {
		spots[i], spots[j] = spots[j], spots[i]
	}

	var sb strings.Builder
	if bandArg != "" {
		fmt.Fprintf(&sb, "📡 <b>CW Spots — %s (last %d)</b>\n\n", html.EscapeString(strings.ToUpper(bandArg)), len(spots))
	} else {
		fmt.Fprintf(&sb, "📡 <b>CW Spots — last %d</b>\n\n", len(spots))
	}

	for i, s := range spots {
		dxCall, _ := s["dx_call"].(string)
		freqHz, _ := s["frequency"].(float64)
		wpm, _ := s["wpm"].(int)
		snr, _ := s["snr"].(int)
		comment, _ := s["comment"].(string)
		band, _ := s["band"].(string)
		country, _ := s["country"].(string)
		countryCode, _ := s["country_code"].(string)
		distKm, hasDistKm := s["distance_km"].(float64)
		spotTime, _ := s["time"].(time.Time)

		freqMHz := freqHz / 1_000_000.0

		// Line 1: callsign (tappable /qrz link if enabled), freq, WPM, SNR, comment, band
		line1 := fmt.Sprintf("<b>%s</b>  %.3f MHz  %d WPM  %d dB",
			l.callsignQRZLink(dxCall), freqMHz, wpm, snr)
		if comment != "" {
			line1 += "  " + html.EscapeString(comment)
		}
		if bandArg == "" && band != "" {
			line1 += "  [" + html.EscapeString(band) + "]"
		}

		// Line 2: country + flag, distance, time
		var parts []string
		if country != "" {
			flag := countryCodeToFlag(countryCode)
			if flag != "" {
				parts = append(parts, flag+" "+html.EscapeString(country))
			} else {
				parts = append(parts, html.EscapeString(country))
			}
		}
		if hasDistKm && distKm > 0 {
			parts = append(parts, fmt.Sprintf("%.0f km", distKm))
		}
		if !spotTime.IsZero() {
			parts = append(parts, spotTime.UTC().Format("15:04")+" UTC")
		}

		fmt.Fprintf(&sb, "%d. %s\n", i+1, line1)
		if len(parts) > 0 {
			fmt.Fprintf(&sb, "   %s\n", strings.Join(parts, " · "))
		}
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// ─── /voice ───────────────────────────────────────────────────────────────────

// handleVoice reports detected voice/SSB activity from the noise floor monitor.
// With no args it scans all configured bands; with a band arg it shows only
// that band.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleVoice(chatID int64, args string) (string, string, bool) {
	if l.noiseFloor == nil {
		msg := "🎙️ Voice activity detection is not available (noise floor monitoring not enabled)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	bandArg := strings.ToLower(strings.TrimSpace(args))
	params := DefaultDetectionParams()

	// Determine which bands to scan.
	var bandsToScan []string
	if bandArg != "" {
		bandsToScan = []string{bandArg}
	} else {
		// All known HF bands in frequency order, then extras.
		measurements := l.noiseFloor.GetLatestMeasurements()
		knownSet := make(map[string]bool, len(hfBandOrder))
		for _, b := range hfBandOrder {
			knownSet[b] = true
		}
		for _, b := range hfBandOrder {
			if _, ok := measurements[b]; ok {
				bandsToScan = append(bandsToScan, b)
			}
		}
		var extra []string
		for b := range measurements {
			if !knownSet[b] {
				extra = append(extra, b)
			}
		}
		sort.Strings(extra)
		bandsToScan = append(bandsToScan, extra...)
	}

	type bandResult struct {
		band       string
		activities []VoiceActivity
		err        error
	}

	var results []bandResult
	for _, band := range bandsToScan {
		acts, err := GetVoiceActivityForBand(l.noiseFloor, band, params)
		results = append(results, bandResult{band: band, activities: acts, err: err})
	}

	// Count total active signals.
	totalActive := 0
	for _, r := range results {
		totalActive += len(r.activities)
	}

	var sb strings.Builder
	if bandArg != "" {
		fmt.Fprintf(&sb, "🎙️ <b>Voice Activity — %s</b>\n\n", html.EscapeString(strings.ToUpper(bandArg)))
	} else {
		fmt.Fprintf(&sb, "🎙️ <b>Voice Activity — All Bands</b>\n\n")
	}

	if totalActive == 0 {
		if bandArg != "" {
			sb.WriteString("<i>No voice activity detected on this band.</i>")
		} else {
			sb.WriteString("<i>No voice activity detected on any band.</i>")
		}
		msg := sb.String()
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	for _, r := range results {
		if len(r.activities) == 0 {
			continue
		}
		fmt.Fprintf(&sb, "<b>%s</b> (%d signal%s)\n",
			html.EscapeString(strings.ToUpper(r.band)),
			len(r.activities),
			pluralS(len(r.activities)))

		for _, act := range r.activities {
			freqMHz := float64(act.EstimatedDialFreq) / 1_000_000.0
			line := fmt.Sprintf("  %.3f MHz  %s  SNR %.0f dB",
				freqMHz,
				html.EscapeString(act.Mode),
				act.SNR)

			// DX callsign enrichment (from DX cluster).
			if act.DXCallsign != "" {
				flag := countryCodeToFlag(act.DXCountryCode)
				line += "  " + l.callsignQRZLink(act.DXCallsign)
				if act.DXCountry != "" {
					if flag != "" {
						line += " " + flag
					}
					line += " " + html.EscapeString(act.DXCountry)
				}
			}

			sb.WriteString(line + "\n")
		}
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// pluralS returns "s" when n != 1, empty string otherwise.
func pluralS(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// callsignQRZLink renders a callsign as a tappable /qrz command only when the
// /qrz command is enabled for this listener. Falls back to plain text.
// In Telegram's HTML parse mode, /command text is rendered as a tappable link
// that sends the command to the bot when tapped.
func (l *TelegramBotListener) callsignQRZLink(callsign string) string {
	if callsign == "" {
		return ""
	}
	if l.commandEnabled("qrz") {
		return "/qrz " + html.EscapeString(callsign)
	}
	return html.EscapeString(callsign)
}

// ipLookupLink renders an IP address as a tappable /ip command only when the
// /ip command is enabled for this listener. Falls back to <code>ip</code>.
// Only plain IP addresses (not CIDRs) are linked — CIDRs are always plain.
func (l *TelegramBotListener) ipLookupLink(ip string) string {
	if ip == "" {
		return ""
	}
	// Only link plain IPs, not CIDR ranges.
	if strings.Contains(ip, "/") {
		return "<code>" + html.EscapeString(ip) + "</code>"
	}
	if l.commandEnabled("ip") {
		return "/ip " + html.EscapeString(ip)
	}
	return "<code>" + html.EscapeString(ip) + "</code>"
}

// ipBanLink returns a tappable /banned ban <ip> command when /banned is both
// enabled and write-enabled for this listener, otherwise returns empty string.
// Only plain IPs are linkable (not CIDRs).
func (l *TelegramBotListener) ipBanLink(ip string) string {
	if ip == "" || strings.Contains(ip, "/") {
		return ""
	}
	if l.commandEnabled("banned") && l.commandWriteEnabled("banned") {
		return " [/banned ban " + html.EscapeString(ip) + "]"
	}
	return ""
}

// ipUnbanLink returns a tappable /banned unban <ip> command when /banned is
// both enabled and write-enabled for this listener, otherwise returns empty string.
func (l *TelegramBotListener) ipUnbanLink(ip string) string {
	if ip == "" {
		return ""
	}
	if l.commandEnabled("banned") && l.commandWriteEnabled("banned") {
		return " [/banned unban " + html.EscapeString(ip) + "]"
	}
	return ""
}
