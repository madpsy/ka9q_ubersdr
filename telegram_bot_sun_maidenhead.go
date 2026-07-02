package main

// telegram_bot_sun_maidenhead.go — /sun and /maidenhead command handlers.

import (
	"fmt"
	"html"
	"math"
	"strings"
	"time"
)

func init() {
	botCommands["sun"] = botCommand{
		desc:     "Show today's sunrise, sunset and grey-line times for the receiver location",
		readOnly: true,
		handler:  (*TelegramBotListener).handleSun,
	}
	botCommands["maidenhead"] = botCommand{
		desc:     "Convert a Maidenhead grid square to lat/lon, or lat/lon to grid (e.g. /maidenhead IO85 or /maidenhead 55.5 -4.2)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleMaidenhead,
	}
}

// ─── /sun ─────────────────────────────────────────────────────────────────────

// handleSun reports today's sun and grey-line times for the receiver's GPS
// coordinates, plus current sun position and moon phase.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSun(chatID int64, args string) (string, string, bool) {
	if l.config == nil {
		msg := "☀️ Sun data unavailable (config not wired)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	lat := l.config.Admin.GPS.Lat
	lon := l.config.Admin.GPS.Lon
	if lat == 0 && lon == 0 {
		msg := "☀️ GPS coordinates are not configured on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	now := time.Now().UTC()
	alt := float64(l.config.Admin.ASL)

	sunTimes := GetTimes(now, lat, lon, alt)
	sunPos := GetPosition(now, lat, lon)
	moonIllum := GetMoonIllumination(now)
	moonTimes := GetMoonTimes(now, lat, lon, true)

	isDaytime := now.After(sunTimes.Sunrise) && now.Before(sunTimes.Sunset)
	dayNight := "🌙 Night"
	if isDaytime {
		dayNight = "☀️ Day"
	}

	// Sun azimuth: GetPosition returns radians offset from south; convert to
	// compass bearing (0° = North).
	azDeg := sunPos.Azimuth/rad*-1 + 180
	if azDeg < 0 {
		azDeg += 360
	}
	if azDeg >= 360 {
		azDeg -= 360
	}
	altDeg := sunPos.Altitude / rad

	phaseName := getMoonPhaseName(moonIllum.Phase)
	moonPct := moonIllum.Fraction * 100

	fmtT := func(t time.Time) string {
		if t.IsZero() {
			return "—"
		}
		return t.UTC().Format("15:04") + " UTC"
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "☀️ <b>Sun &amp; Sky</b> — %s\n", now.UTC().Format("02 Jan 2006"))
	fmt.Fprintf(&sb, "<i>%.4f°, %.4f°</i>\n\n", lat, lon)

	fmt.Fprintf(&sb, "Now: <b>%s</b> · Sun %.1f° az, %.1f° el\n\n", dayNight, azDeg, altDeg)

	sb.WriteString("<b>Sun times (UTC):</b>\n")
	fmt.Fprintf(&sb, "  🌅 Dawn (civil):    %s\n", fmtT(sunTimes.Dawn))
	fmt.Fprintf(&sb, "  🌄 Sunrise:         %s\n", fmtT(sunTimes.Sunrise))
	fmt.Fprintf(&sb, "  🌞 Solar noon:      %s\n", fmtT(sunTimes.SolarNoon))
	fmt.Fprintf(&sb, "  🌇 Sunset:          %s\n", fmtT(sunTimes.Sunset))
	fmt.Fprintf(&sb, "  🌆 Dusk (civil):    %s\n", fmtT(sunTimes.Dusk))
	fmt.Fprintf(&sb, "  🌃 Nautical dusk:   %s\n", fmtT(sunTimes.NauticalDusk))
	fmt.Fprintf(&sb, "  🌑 Night:           %s\n", fmtT(sunTimes.Night))

	// Grey line = ±30 min around sunrise/sunset — useful for HF propagation.
	greyRiseStart := sunTimes.Sunrise.Add(-30 * time.Minute)
	greyRiseEnd := sunTimes.Sunrise.Add(30 * time.Minute)
	greySetStart := sunTimes.Sunset.Add(-30 * time.Minute)
	greySetEnd := sunTimes.Sunset.Add(30 * time.Minute)
	fmt.Fprintf(&sb, "\n<b>Grey line (±30 min):</b>\n")
	fmt.Fprintf(&sb, "  Morning: %s – %s\n", fmtT(greyRiseStart), fmtT(greyRiseEnd))
	fmt.Fprintf(&sb, "  Evening: %s – %s\n", fmtT(greySetStart), fmtT(greySetEnd))

	// Moon.
	fmt.Fprintf(&sb, "\n<b>Moon:</b> %s (%.0f%% illuminated)\n",
		html.EscapeString(phaseName), moonPct)
	if moonTimes.Rise != nil {
		fmt.Fprintf(&sb, "  🌕 Moonrise: %s\n", fmtT(*moonTimes.Rise))
	}
	if moonTimes.Set != nil {
		fmt.Fprintf(&sb, "  🌑 Moonset:  %s\n", fmtT(*moonTimes.Set))
	}
	if moonTimes.AlwaysUp {
		sb.WriteString("  (Moon above horizon all day)\n")
	} else if moonTimes.AlwaysDown {
		sb.WriteString("  (Moon below horizon all day)\n")
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// ─── /maidenhead ──────────────────────────────────────────────────────────────

// handleMaidenhead converts between Maidenhead grid squares and lat/lon.
//
// Usage:
//
//	/maidenhead IO85        → grid → lat/lon + Google Maps link
//	/maidenhead 55.5 -4.2  → lat/lon → grid square
//	/maidenhead             → show the receiver's own grid square
//
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleMaidenhead(chatID int64, args string) (string, string, bool) {
	arg := strings.TrimSpace(args)

	// ── No argument: show receiver's own grid square ──────────────────────────
	if arg == "" {
		if l.config == nil {
			msg := "📍 Config not available."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		lat := l.config.Admin.GPS.Lat
		lon := l.config.Admin.GPS.Lon
		if lat == 0 && lon == 0 {
			msg := "📍 GPS coordinates are not configured on this receiver.\n\nUsage:\n<code>/maidenhead IO85</code> — grid → lat/lon\n<code>/maidenhead 55.5 -4.2</code> — lat/lon → grid"
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		grid6 := latLonToMaidenhead(lat, lon, 6)
		mapsURL := fmt.Sprintf("https://maps.google.com/?q=%.6f,%.6f", lat, lon)
		msg := fmt.Sprintf("📍 <b>Receiver location</b>\n\nGrid: <code>%s</code>\nCoords: <a href=\"%s\">%.4f, %.4f</a>",
			grid6, mapsURL, lat, lon)
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	parts := strings.Fields(arg)

	// ── Two numeric args: lat/lon → grid ──────────────────────────────────────
	if len(parts) == 2 {
		var lat, lon float64
		if _, err := fmt.Sscanf(parts[0], "%f", &lat); err != nil {
			msg := "⚠️ Invalid latitude. Usage: <code>/maidenhead &lt;lat&gt; &lt;lon&gt;</code>"
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		if _, err := fmt.Sscanf(parts[1], "%f", &lon); err != nil {
			msg := "⚠️ Invalid longitude. Usage: <code>/maidenhead &lt;lat&gt; &lt;lon&gt;</code>"
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		if lat < -90 || lat > 90 {
			msg := "⚠️ Latitude must be between -90 and 90."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		if lon < -180 || lon > 180 {
			msg := "⚠️ Longitude must be between -180 and 180."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		grid4 := latLonToMaidenhead(lat, lon, 4)
		grid6 := latLonToMaidenhead(lat, lon, 6)
		mapsURL := fmt.Sprintf("https://maps.google.com/?q=%.6f,%.6f", lat, lon)
		msg := fmt.Sprintf("📍 <b>Lat/Lon → Maidenhead</b>\n\n4-char: <code>%s</code>\n6-char: <code>%s</code>\nCoords: <a href=\"%s\">%.4f, %.4f</a>",
			grid4, grid6, mapsURL, lat, lon)
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Single arg: grid → lat/lon ────────────────────────────────────────────
	if len(parts) == 1 {
		locator := strings.ToUpper(parts[0])
		lat, lon, err := MaidenheadToLatLon(locator)
		if err != nil {
			msg := fmt.Sprintf("⚠️ Invalid Maidenhead locator <code>%s</code>: %s\n\nMust be 4, 6, or 8 characters (e.g. <code>IO85</code>, <code>IO85jq</code>).",
				html.EscapeString(locator), html.EscapeString(err.Error()))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		mapsURL := fmt.Sprintf("https://maps.google.com/?q=%.6f,%.6f", lat, lon)

		// If the receiver has GPS configured, also show distance and bearing.
		var distPart string
		if l.config != nil {
			rxLat := l.config.Admin.GPS.Lat
			rxLon := l.config.Admin.GPS.Lon
			if rxLat != 0 || rxLon != 0 {
				distKm, bearing := CalculateDistanceAndBearing(rxLat, rxLon, lat, lon)
				distPart = fmt.Sprintf("\nFrom receiver: <b>%.0f km</b> at <b>%.0f°</b>", distKm, bearing)
			}
		}

		msg := fmt.Sprintf("📍 <b>Maidenhead → Lat/Lon</b>\n\nGrid: <code>%s</code>\nCoords: <a href=\"%s\">%.4f, %.4f</a>%s",
			html.EscapeString(locator), mapsURL, lat, lon, distPart)
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Unexpected number of args.
	msg := "📍 Usage:\n<code>/maidenhead IO85</code> — grid → lat/lon\n<code>/maidenhead 55.5 -4.2</code> — lat/lon → grid\n<code>/maidenhead</code> — show receiver location"
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// latLonToMaidenhead converts a latitude/longitude to a Maidenhead locator of
// the given precision (4 or 6 characters). Precision 6 is the standard amateur
// radio grid square format.
func latLonToMaidenhead(lat, lon float64, precision int) string {
	// Normalise to 0–360 longitude, 0–180 latitude.
	lon += 180.0
	lat += 90.0

	// Field (A–R): 20° lon × 10° lat
	field0 := byte(math.Floor(lon/20.0)) + 'A'
	field1 := byte(math.Floor(lat/10.0)) + 'A'

	// Square (0–9): 2° lon × 1° lat within field
	sq0 := byte(math.Floor(math.Mod(lon, 20.0)/2.0)) + '0'
	sq1 := byte(math.Floor(math.Mod(lat, 10.0)/1.0)) + '0'

	if precision == 4 {
		return string([]byte{field0, field1, sq0, sq1})
	}

	// Subsquare (A–X): 5' lon × 2.5' lat within square
	subLon := math.Mod(lon, 2.0) * 12.0 // 0–24
	subLat := math.Mod(lat, 1.0) * 24.0 // 0–24
	sub0 := byte(math.Floor(subLon)) + 'A'
	sub1 := byte(math.Floor(subLat)) + 'A'

	return string([]byte{field0, field1, sq0, sq1, sub0, sub1})
}
