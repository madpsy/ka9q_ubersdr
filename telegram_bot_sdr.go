package main

// telegram_bot_sdr.go — /sdr command handler.
//
// Reports the SDR frontend status of the wideband spectrum channel: sample
// rate, RF gain chain, IF power and A/D overranges. This is the same set of
// figures shown in the admin UI Monitor tab's "SDR Frontend" tiles (the FFT
// details are deliberately left out to keep the message short).
//
// Values come from buildFrontendStatusPayload, the same builder used by
// /api/frontend-status, /admin/frontend-status and MQTT, so the derived
// figures (input power in dBm, overrange seconds, stable-for) always agree.

import (
	"fmt"
	"html"
	"strconv"
	"strings"
)

func init() {
	botCommands["sdr"] = botCommand{
		desc:     "Show SDR frontend status (sample rate, gain, IF power, overranges)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleSDR,
	}
}

// fmtPayloadFloat renders a sanitised number from a frontend status payload.
// Those fields are float32/float64 when radiod has reported a usable value and
// nil when it has not, so anything else becomes "N/A".
func fmtPayloadFloat(v interface{}, decimals int) string {
	switch n := v.(type) {
	case float32:
		return strconv.FormatFloat(float64(n), 'f', decimals, 64)
	case float64:
		return strconv.FormatFloat(n, 'f', decimals, 64)
	}
	return "N/A"
}

// fmtThousands renders n with comma thousands separators (1280 -> "1,280"),
// matching the admin UI's toLocaleString() formatting.
func fmtThousands(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}

	var sb strings.Builder
	for i, digit := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			sb.WriteByte(',')
		}
		sb.WriteRune(digit)
	}

	if neg {
		return "-" + sb.String()
	}
	return sb.String()
}

// handleSDR reports the SDR frontend status for the wideband spectrum channel.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSDR(chatID int64, args string) (string, string, bool) {
	if l.sessions == nil || l.sessions.radiod == nil {
		msg := "📻 SDR frontend status is not available."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	widebandSSRC := l.sessions.WidebandSSRC()
	if widebandSSRC == 0 {
		msg := "📻 The wideband spectrum channel is not running, so no SDR frontend status is available."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	frontendStatus := l.sessions.radiod.GetFrontendStatus(widebandSSRC)
	if frontendStatus == nil {
		msg := "📻 No SDR frontend status received yet (radiod not responding)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	p := buildFrontendStatusPayload(frontendStatus, l.sessions.config.Receiver)

	// Health header: ✅ OK, ⚠️ Warning, 🔴 Critical — same severities as /monitor.
	healthy, _ := p["healthy"].(bool)
	status, _ := p["status"].(string)
	headerIcon := "✅"
	if !healthy {
		headerIcon = "⚠️"
		if status == "critical" {
			headerIcon = "🔴"
		}
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📻 <b>SDR Frontend</b> %s\n\n", headerIcon)

	// Sample rate, with the top of the tuning range beneath it.
	//
	// Not samprate/2: half the sample rate is the theoretical Nyquist, but radiod caps the
	// front end at 0.47 x samprate and the display span is rounded down from there, so a
	// 64.8 Msps receiver tunes to 30 MHz rather than the 32.4 that figure implied. Report
	// what can actually be tuned — see receiver_span.go.
	if samprate, _ := p["input_samprate"].(int); samprate > 0 {
		fmt.Fprintf(&sb, "⏱ <b>Sample Rate:</b> %.2f MSPS (tunes to %.0f MHz)\n",
			float64(samprate)/1e6, float64(receiverSpanFor(samprate))/1e6)
	} else {
		sb.WriteString("⏱ <b>Sample Rate:</b> N/A\n")
	}

	// RF gain chain.
	rfAGC := "OFF"
	if agc, _ := p["rf_agc"].(int32); agc != 0 {
		rfAGC = "ON"
	}
	fmt.Fprintf(&sb, "🎚 <b>RF AGC:</b> %s\n", rfAGC)
	fmt.Fprintf(&sb, "📶 <b>RF Gain:</b> %s\n", fmtPayloadFloat(p["rf_gain"], 1))
	fmt.Fprintf(&sb, "🔉 <b>RF Attenuation:</b> %s\n", fmtPayloadFloat(p["rf_atten"], 1))

	// IF power in dBFS, with the calibrated absolute input power in dBm.
	fmt.Fprintf(&sb, "⚡ <b>IF Power:</b> %s dBFS (%s dBm)\n",
		fmtPayloadFloat(p["if_power"], 1), fmtPayloadFloat(p["input_power_dbm"], 2))

	// A/D overranges: seconds' worth, then the lifetime count.
	overranges, _ := p["ad_overranges"].(int64)
	fmt.Fprintf(&sb, "📊 <b>A/D Overranges:</b> %s (%s total)\n",
		fmtPayloadFloat(p["overrange_seconds"], 1), fmtThousands(overranges))

	stableFor, _ := p["time_since_overrange"].(string)
	if stableFor == "" {
		stableFor = "N/A"
	}
	fmt.Fprintf(&sb, "🕒 <b>Stable For:</b> %s (since last overrange)\n",
		html.EscapeString(stableFor))

	// Any health issues (currently IF power out of its usable window).
	if issues, _ := p["issues"].([]string); len(issues) > 0 {
		sb.WriteString("\n")
		for _, issue := range issues {
			fmt.Fprintf(&sb, "%s %s\n", headerIcon, html.EscapeString(issue))
		}
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}
