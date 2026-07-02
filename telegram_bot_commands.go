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
	"os"
	"runtime"
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
	// writeHint is an optional extra line shown in /help when write access is
	// enabled for this command. Use it to document the write argument(s).
	// Example: "Use /version update to trigger an update."
	writeHint string
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
	"passwords": {
		desc:     "Show configured passwords (admin, bypass, rotator, switch)",
		readOnly: true,
		handler:  (*TelegramBotListener).handlePasswords,
	},
	"info": {
		desc:     "Show receiver info (name, callsign, URL, location, version)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleInfo,
	},
	"qrz": {
		desc:     "Look up a callsign via QRZ (e.g. /qrz MM3NDH)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleQRZ,
	},
	"chat": {
		desc:     "Show the last 10 chat messages",
		readOnly: true,
		handler:  (*TelegramBotListener).handleChat,
	},
	"bands": {
		desc:     "Show band conditions (FT8 SNR per band)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleBands,
	},
	"psk": {
		desc:     "Show PSKReporter rank for this receiver",
		readOnly: true,
		handler:  (*TelegramBotListener).handlePSK,
	},
	"rbn": {
		desc:     "Show RBN skimmer rank and skew data",
		readOnly: true,
		handler:  (*TelegramBotListener).handleRBN,
	},
	"rotator": {
		desc:      "Show rotator azimuth",
		readOnly:  false,
		writeHint: "Use <code>/rotator &lt;0–360&gt;</code> to move to an azimuth, e.g. <code>/rotator 180</code>",
		handler:   (*TelegramBotListener).handleRotator,
	},
	"sessions": {
		desc:     "Show active listener sessions",
		readOnly: true,
		handler:  (*TelegramBotListener).handleSessions,
	},
	"switch": {
		desc:      "Show (or set) antenna switch port",
		readOnly:  false,
		writeHint: "Use <code>/switch &lt;1–N&gt;</code> to select a port, or <code>/switch ground</code> to ground all antennas.",
		handler:   (*TelegramBotListener).handleSwitch,
	},
	"version": {
		desc:      "Show current and latest software version",
		readOnly:  false,
		writeHint: "Use <code>/version update</code> to trigger an update when one is available, or <code>/version update force</code> to force a reinstall.",
		handler:   (*TelegramBotListener).handleVersion,
	},
	"gpsdo": {
		desc:     "Show Leo Bodnar GPSDO device and GPS status",
		readOnly: true,
		handler:  (*TelegramBotListener).handleGPSDO,
	},
	"space": {
		desc:     "Show current space weather report",
		readOnly: true,
		handler:  (*TelegramBotListener).handleSpace,
	},
	"wspr": {
		desc:     "Show WSPR Live rank for this receiver",
		readOnly: true,
		handler:  (*TelegramBotListener).handleWSPR,
	},
}

// ─── Command handlers ─────────────────────────────────────────────────────────

// handleVersion reports the current and latest software version.
// With argument "update" (and write access enabled) it triggers an update only
// when a newer version is available. With "update force" it always triggers,
// matching the "Update" button in the admin UI footer.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleVersion(chatID int64, args string) (string, string, bool) {
	currentVersion := Version
	latestVersion := GetLatestVersion()

	// ── Update mode: /version update [force] ─────────────────────────────────
	argNorm := strings.TrimSpace(strings.ToLower(args))
	if argNorm == "update" || argNorm == "update force" {
		if !l.commandWriteEnabled("version") {
			msg := "⚠️ Write access is not enabled for /version. Enable it in the bot listener config."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		force := argNorm == "update force"

		// Without force, only proceed if an update is actually available.
		if !force && (latestVersion == "" || latestVersion == currentVersion) {
			msg := fmt.Sprintf("🔄 <b>Software Version</b>\n\nCurrent: <code>%s</code>\n\n<i>No update available — already on the latest version.</i>\n\nUse <code>/version update force</code> to force a reinstall.",
				html.EscapeString(currentVersion))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		// Determine what to write: prefer latest, fall back to current (force case).
		versionToWrite := latestVersion
		if versionToWrite == "" {
			versionToWrite = currentVersion
		}

		if err := WriteVersionFile(versionToWrite); err != nil {
			msg := fmt.Sprintf("⚠️ Failed to trigger update: %s", html.EscapeString(err.Error()))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}

		var sb strings.Builder
		fmt.Fprintf(&sb, "🔄 <b>Software Version</b>\n\nCurrent: <code>%s</code>\n", html.EscapeString(currentVersion))
		if latestVersion != "" && latestVersion != currentVersion {
			fmt.Fprintf(&sb, "Latest:  <code>%s</code>\n", html.EscapeString(latestVersion))
		}
		if force {
			sb.WriteString("\n✅ Force update triggered. The server will reinstall within 1 minute.")
		} else {
			sb.WriteString("\n✅ Update triggered. The server will update within 1 minute.")
		}
		msg := sb.String()
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Status mode: /version ─────────────────────────────────────────────────
	var sb strings.Builder
	fmt.Fprintf(&sb, "🔄 <b>Software Version</b>\n\nCurrent: <code>%s</code>\n", html.EscapeString(currentVersion))

	if latestVersion == "" {
		sb.WriteString("Latest:  <i>not yet checked</i>\n")
	} else if latestVersion == currentVersion {
		fmt.Fprintf(&sb, "Latest:  <code>%s</code>\n\n✅ Up to date", html.EscapeString(latestVersion))
	} else {
		fmt.Fprintf(&sb, "Latest:  <code>%s</code>\n\n⚠️ Update available!", html.EscapeString(latestVersion))
		if l.commandWriteEnabled("version") {
			sb.WriteString(" Use <code>/version update</code> to trigger the update.")
		}
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handlePSK reports the PSKReporter rank for the configured receiver callsign.
// handlePasswords reports the configured passwords: admin, bypass, rotator, and
// antenna switch. The latter three are omitted when empty.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handlePasswords(chatID int64, args string) (string, string, bool) {
	if l.config == nil {
		msg := "🔑 Password info unavailable."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	cfg := l.config
	var sb strings.Builder
	sb.WriteString("🔑 <b>Passwords</b>\n\n")

	// Admin password — always shown (required field).
	fmt.Fprintf(&sb, "🛡️ <b>Admin:</b> <code>%s</code>\n", html.EscapeString(cfg.Admin.Password))

	// Bypass password — omit when empty.
	if cfg.Server.BypassPassword != "" {
		fmt.Fprintf(&sb, "🔓 <b>Bypass:</b> <code>%s</code>\n", html.EscapeString(cfg.Server.BypassPassword))
	}

	// Rotator password — omit when empty.
	if cfg.Rotctl.Password != "" {
		fmt.Fprintf(&sb, "🧭 <b>Rotator:</b> <code>%s</code>\n", html.EscapeString(cfg.Rotctl.Password))
	}

	// Antenna switch password — omit when empty.
	if cfg.AntSwitch.Password != "" {
		fmt.Fprintf(&sb, "🔌 <b>Switch:</b> <code>%s</code>\n", html.EscapeString(cfg.AntSwitch.Password))
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleInfo reports receiver details: name, callsign, public URL, GPS location,
// version, and server time. Mirrors the key fields from GET /api/description.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleInfo(chatID int64, args string) (string, string, bool) {
	if l.config == nil {
		msg := "ℹ️ Receiver info unavailable."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	cfg := l.config

	// Build public URL using effective host from instance reporter when available.
	var publicURL string
	if l.instanceReporter != nil {
		publicURL = cfg.InstanceReporting.ConstructPublicURL(l.instanceReporter.GetEffectiveHost())
	} else {
		publicURL = cfg.InstanceReporting.ConstructPublicURL()
	}

	var sb strings.Builder
	sb.WriteString("ℹ️ <b>Receiver Info</b>\n\n")

	// Name
	if cfg.Admin.Name != "" {
		fmt.Fprintf(&sb, "📻 <b>Name:</b> %s\n", html.EscapeString(cfg.Admin.Name))
	}

	// Callsign
	if cfg.Admin.Callsign != "" {
		fmt.Fprintf(&sb, "📡 <b>Callsign:</b> <code>%s</code>\n", html.EscapeString(cfg.Admin.Callsign))
	}

	// Public URL and admin URL
	if publicURL != "" {
		fmt.Fprintf(&sb, "🌐 <b>URL:</b> %s\n", html.EscapeString(publicURL))
		adminURL := strings.TrimRight(publicURL, "/") + "/admin.html"
		fmt.Fprintf(&sb, "🔧 <b>Admin URL:</b> %s\n", html.EscapeString(adminURL))
	}

	// GPS coordinates as a Google Maps link
	lat := cfg.Admin.GPS.Lat
	lon := cfg.Admin.GPS.Lon
	if lat != 0 || lon != 0 {
		mapsURL := fmt.Sprintf("https://maps.google.com/?q=%.6f,%.6f", lat, lon)
		fmt.Fprintf(&sb, "📍 <b>Location:</b> <a href=\"%s\">%.4f, %.4f</a>\n",
			mapsURL, lat, lon)
	}

	// Available client slots
	if l.sessions != nil {
		regularCount := l.sessions.GetNonBypassedUserCount()
		maxSessions := cfg.Server.MaxSessions
		available := maxSessions - regularCount
		if available < 0 {
			available = 0
		}
		fmt.Fprintf(&sb, "👥 <b>Listeners:</b> %d of %d (%d available)\n", regularCount, maxSessions, available)
	}

	// Version
	fmt.Fprintf(&sb, "🔖 <b>Version:</b> <code>%s</code>\n", html.EscapeString(Version))

	// Server time in local time (UTC+1 for Europe/London, but we use the process TZ)
	now := time.Now()
	fmt.Fprintf(&sb, "🕐 <b>Server time:</b> %s\n", html.EscapeString(now.Format("2006-01-02 15:04:05 MST")))

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handlePSK(chatID int64, args string) (string, string, bool) {
	if l.pskRank == nil {
		msg := "📡 PSKReporter rank is not available (decoder not enabled)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	cached := l.pskRank.Cached()
	if cached == nil {
		msg := "📡 PSKReporter data not yet fetched. Try again in a few minutes."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	if cached.Error != "" {
		msg := "📡 PSKReporter fetch error: " + html.EscapeString(cached.Error)
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	cs := l.receiverCallsign
	if cs == "" {
		msg := "📡 No receiver callsign configured."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	reportRanks := computeCallsignRank(cached.ReportResult, cs)
	countryRanks := computeCallsignRank(cached.CountryResult, cs)

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>PSKReporter Rank</b> — <code>%s</code>\n", html.EscapeString(cs))
	fmt.Fprintf(&sb, "<i>Data from %s</i>\n\n", cached.FetchedAt.UTC().Format("02 Jan 15:04 UTC"))

	if len(reportRanks) == 0 && len(countryRanks) == 0 {
		sb.WriteString("<i>Callsign not found in current leaderboard.</i>\n")
	} else {
		// Extract the cross-band "All" totals so they can be shown at the end.
		reportAll, hasReportAll := reportRanks["All"]
		countryAll, hasCountryAll := countryRanks["All"]

		if len(reportRanks) > 0 {
			sb.WriteString("<b>Reports (24h / 7d):</b>\n")
			for _, band := range hfBandOrder {
				if r, ok := reportRanks[band]; ok {
					fmt.Fprintf(&sb, "  %s: #%d — %s reports (7d: %s)\n",
						band, r.Rank, fmtCount(r.Day), fmtCount(r.Week))
				}
			}
			for band, r := range reportRanks {
				if !hfBandKnown(band) && band != "All" {
					fmt.Fprintf(&sb, "  %s: #%d — %s reports (7d: %s)\n",
						html.EscapeString(band), r.Rank, fmtCount(r.Day), fmtCount(r.Week))
				}
			}
		}
		if len(countryRanks) > 0 {
			sb.WriteString("\n<b>Countries (24h / 7d):</b>\n")
			for _, band := range hfBandOrder {
				if r, ok := countryRanks[band]; ok {
					fmt.Fprintf(&sb, "  %s: #%d — %s countries (7d: %s)\n",
						band, r.Rank, fmtCount(r.Day), fmtCount(r.Week))
				}
			}
			for band, r := range countryRanks {
				if !hfBandKnown(band) && band != "All" {
					fmt.Fprintf(&sb, "  %s: #%d — %s countries (7d: %s)\n",
						html.EscapeString(band), r.Rank, fmtCount(r.Day), fmtCount(r.Week))
				}
			}
		}
		// Totals section — "All" band shown last with a blank line separator.
		if hasReportAll || hasCountryAll {
			sb.WriteString("\n<b>Totals (all bands):</b>\n")
			if hasReportAll {
				fmt.Fprintf(&sb, "  Reports: #%d — %s (7d: %s)\n",
					reportAll.Rank, fmtCount(reportAll.Day), fmtCount(reportAll.Week))
			}
			if hasCountryAll {
				fmt.Fprintf(&sb, "  Countries: #%d — %s (7d: %s)\n",
					countryAll.Rank, fmtCount(countryAll.Day), fmtCount(countryAll.Week))
			}
		}
	}
	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleWSPR reports the WSPR Live rank for the configured receiver callsign.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleWSPR(chatID int64, args string) (string, string, bool) {
	if l.wsprRank == nil {
		msg := "📻 WSPR rank is not available (WSPR decoder not enabled)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	cached := l.wsprRank.Cached()
	if cached == nil {
		msg := "📻 WSPR rank data not yet fetched. Try again in a few minutes."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	cs := l.receiverCallsign
	if cs == "" {
		msg := "📻 No receiver callsign configured."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📻 <b>WSPR Live Rank</b> — <code>%s</code>\n\n", html.EscapeString(cs))

	type windowResult struct {
		label string
		win   WSPRRankWindow
	}
	windows := []windowResult{
		{"Rolling 24h", cached.Rolling24h},
		{"Today", cached.Today},
		{"Yesterday", cached.Yesterday},
	}
	found := false
	for _, w := range windows {
		if w.win.Error != "" {
			fmt.Fprintf(&sb, "%s: <i>%s</i>\n", w.label, html.EscapeString(w.win.Error))
			continue
		}
		filtered := filterWSPRRankWindowByCallsign(w.win, cs)
		if len(filtered.Data) == 0 {
			fmt.Fprintf(&sb, "%s: <i>not ranked</i>\n", w.label)
			continue
		}
		found = true
		row := filtered.Data[0]
		rank := row.OriginalRank
		if rank == 0 {
			rank = 1
		}
		fmt.Fprintf(&sb, "%s: <b>#%d</b> — %s unique spots\n",
			w.label, rank, fmtCount(int(row.Unique)))
	}
	if !found {
		sb.WriteString("\n<i>Callsign not found in any WSPR Live window.</i>\n")
	}
	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleRBN reports the RBN skimmer rank and skew data for the configured callsign.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleRBN(chatID int64, args string) (string, string, bool) {
	if l.rbnStore == nil {
		msg := "📡 RBN data is not available (CW skimmer not enabled)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	cs := strings.ToUpper(l.cwSkimmerCallsign)
	if cs == "" {
		cs = strings.ToUpper(l.receiverCallsign)
	}
	if cs == "" {
		msg := "📡 No callsign configured for RBN lookup."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	l.rbnStore.mu.RLock()
	skewEntry, hasSkew := l.rbnStore.skewData[cs]
	statsEntry, hasStats := l.rbnStore.statsData[cs]
	statsUpdatedAt := l.rbnStore.statsUpdatedAt
	totalSkimmers := len(l.rbnStore.statsData)
	type rankEntry struct {
		callsign  string
		spotCount int
	}
	var rank int
	if hasStats && totalSkimmers > 0 {
		all := make([]rankEntry, 0, totalSkimmers)
		for k, v := range l.rbnStore.statsData {
			all = append(all, rankEntry{k, v.SpotCount})
		}
		sort.Slice(all, func(i, j int) bool {
			if all[i].spotCount != all[j].spotCount {
				return all[i].spotCount > all[j].spotCount
			}
			return all[i].callsign < all[j].callsign
		})
		for idx, re := range all {
			if re.callsign == cs {
				rank = idx + 1
				break
			}
		}
	}
	l.rbnStore.mu.RUnlock()

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>RBN Skimmer</b> — <code>%s</code>\n", html.EscapeString(cs))
	if statsUpdatedAt != nil {
		fmt.Fprintf(&sb, "<i>Data from %s</i>\n", statsUpdatedAt.UTC().Format("02 Jan 15:04 UTC"))
	}
	sb.WriteString("\n")
	if !hasSkew && !hasStats {
		sb.WriteString("<i>Callsign not found in RBN data.</i>\n")
	} else {
		if hasStats {
			if rank > 0 {
				fmt.Fprintf(&sb, "Rank: <b>#%d</b> of %d skimmers\n", rank, totalSkimmers)
			}
			fmt.Fprintf(&sb, "Spot count: <b>%s</b>\n", fmtCount(statsEntry.SpotCount))
		}
		if hasSkew {
			sign := "+"
			if skewEntry.Skew < 0 {
				sign = ""
			}
			fmt.Fprintf(&sb, "Frequency skew: <b>%s%.2f Hz</b> (from %s spots)\n",
				sign, skewEntry.Skew, fmtCount(skewEntry.Spots))
			if skewEntry.CorrectionFactor != 0 && skewEntry.CorrectionFactor != 1 {
				fmt.Fprintf(&sb, "Correction factor: %.4f\n", skewEntry.CorrectionFactor)
			}
		}
	}
	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// hfBandKnown returns true if band is in the hfBandOrder list.
func hfBandKnown(band string) bool {
	for _, b := range hfBandOrder {
		if b == band {
			return true
		}
	}
	return false
}

// fmtCount formats an integer with thousands separators for readability.
func fmtCount(n int) string {
	if n < 1000 {
		return strconv.Itoa(n)
	}
	s := strconv.Itoa(n)
	var out []byte
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, byte(c))
	}
	return string(out)
}

// hfBandOrder lists HF amateur bands in frequency order (lowest first).
// Bands not in this list are sorted alphabetically after the known ones.
var hfBandOrder = []string{
	"160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m",
}

// bandSNRQuality returns a quality label matching the UI thresholds in bandconditions.js.
// snr < 6 → POOR, 6–19 → FAIR, 20–29 → GOOD, ≥ 30 → EXCELLENT.
func bandSNRQuality(snr float32) string {
	switch {
	case snr >= 30:
		return "EXCELLENT"
	case snr >= 20:
		return "GOOD"
	case snr >= 6:
		return "FAIR"
	default:
		return "POOR"
	}
}

// handleBands reports the FT8 SNR and quality label for each configured band.
// Bands with no FT8 data (FT8SNR == 0) are skipped.
// args is ignored — bands is always read-only.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleBands(chatID int64, args string) (string, string, bool) {
	if l.noiseFloor == nil {
		msg := "📻 Band conditions are not available (noise floor monitoring not enabled)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	measurements := l.noiseFloor.GetLatestMeasurements()
	if len(measurements) == 0 {
		msg := "📻 No band data available yet."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Build ordered list: known HF bands first (in frequency order), then any
	// remaining bands sorted alphabetically.
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
	// Append any bands not in the known list, sorted alphabetically.
	var extra []string
	for b := range measurements {
		if !knownSet[b] {
			extra = append(extra, b)
		}
	}
	sort.Strings(extra)
	ordered = append(ordered, extra...)

	var sb strings.Builder
	sb.WriteString("📻 <b>Band Conditions</b>\n\n")

	wrote := 0
	for _, band := range ordered {
		m := measurements[band]
		if m == nil || m.FT8SNR <= 0 {
			continue // skip bands with no FT8 data
		}
		quality := bandSNRQuality(m.FT8SNR)
		fmt.Fprintf(&sb, "<b>%s</b>: %.1f dB — %s\n",
			html.EscapeString(band), m.FT8SNR, quality)
		wrote++
	}

	if wrote == 0 {
		sb.WriteString("<i>No FT8 data available for any band.</i>\n")
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleSessions sends a summary of active sessions to the chat.
// Mirrors the admin panel Sessions tab: one row per unique user (grouped by
// user_session_id), showing audio frequency/mode plus emoji indicators for
// which connection types are active (🔊 audio, 📊 spectrum, 🌐 DX cluster).
// args is ignored — sessions is always read-only.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSessions(chatID int64, args string) (string, string, bool) {
	if l.sessions == nil {
		msg := "📡 Session data unavailable."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	allSessions := l.sessions.GetAllSessionsInfo()

	// Group non-internal sessions by user_session_id (falling back to client_ip
	// then source_ip), exactly as the admin panel does.
	type userGroup struct {
		audioFreq   uint64
		audioMode   string
		hasAudio    bool
		hasSpectrum bool
		hasDX       bool
		clientIP    string
		country     string
		countryCC   string
		isBypassed  bool
		createdAt   time.Time
		key         string
	}
	groupMap := make(map[string]*userGroup)
	var groupOrder []string // preserve insertion order for stable output

	for _, s := range allSessions {
		isInternal, _ := s["is_internal"].(bool)
		if isInternal {
			continue
		}
		isSpectrum, _ := s["is_spectrum"].(bool)

		userSessionID, _ := s["user_session_id"].(string)
		clientIP, _ := s["client_ip"].(string)
		sourceIP, _ := s["source_ip"].(string)

		key := userSessionID
		if key == "" {
			key = clientIP
		}
		if key == "" {
			key = sourceIP
		}
		if key == "" {
			continue // no usable key — skip
		}

		g, exists := groupMap[key]
		if !exists {
			country, _ := s["country"].(string)
			cc, _ := s["country_code"].(string)
			bypassed, _ := s["is_bypassed"].(bool)
			var createdAt time.Time
			if ts, ok := s["created_at"].(string); ok {
				createdAt, _ = time.Parse(time.RFC3339, ts)
			}
			g = &userGroup{
				clientIP:   clientIP,
				country:    country,
				countryCC:  cc,
				isBypassed: bypassed,
				createdAt:  createdAt,
				key:        key,
			}
			groupMap[key] = g
			groupOrder = append(groupOrder, key)
		}

		if isSpectrum {
			g.hasSpectrum = true
		} else {
			// Audio session — capture frequency and mode.
			g.hasAudio = true
			freq, _ := s["frequency"].(uint64)
			mode, _ := s["mode"].(string)
			g.audioFreq = freq
			g.audioMode = strings.ToUpper(mode)
		}

		// DX cluster: present when dxcluster_kbps key exists in the map.
		if _, hasDXKey := s["dxcluster_kbps"]; hasDXKey {
			g.hasDX = true
		}
	}

	if len(groupOrder) == 0 {
		msg := "📡 No active sessions right now."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Count regular (non-bypassed) and bypassed unique users.
	regularCount := l.sessions.GetNonBypassedUserCount()
	bypassedCount := 0
	for _, key := range groupOrder {
		if groupMap[key].isBypassed {
			bypassedCount++
		}
	}
	maxSessions := l.sessions.config.Server.MaxSessions

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>Active Sessions: %d</b>\n\n", len(groupOrder))
	for i, key := range groupOrder {
		g := groupMap[key]
		freqMHz := float64(g.audioFreq) / 1_000_000.0

		// Build the connection-type emoji string (no spaces between emojis).
		var icons strings.Builder
		if g.hasAudio {
			icons.WriteString("🔊")
		}
		if g.hasSpectrum {
			icons.WriteString("📊")
		}
		if g.hasDX {
			icons.WriteString("🌐")
		}

		// Build the main frequency+mode part (only when audio is present).
		var freqPart string
		if g.hasAudio {
			freqPart = fmt.Sprintf("%.3f MHz | %s | ", freqMHz, html.EscapeString(g.audioMode))
		}

		// Build suffix: IP, optional flag+country, optional bypassed tag, duration.
		// All user-supplied strings are HTML-escaped to avoid breaking Telegram's
		// HTML parser (e.g. country names like "Bosnia & Herzegovina").
		var suffix strings.Builder
		if g.clientIP != "" {
			suffix.WriteString(html.EscapeString(g.clientIP))
		}
		if g.country != "" {
			flag := countryCodeToFlag(g.countryCC)
			suffix.WriteString(" ")
			if flag != "" {
				suffix.WriteString(flag)
				suffix.WriteString(" ")
			}
			suffix.WriteString(html.EscapeString(g.country))
		}
		if g.isBypassed {
			suffix.WriteString(" 🔓")
		}
		if !g.createdAt.IsZero() {
			suffix.WriteString(" | ")
			// HTML-escape the duration: fmtSessionDuration can return "<1m" which
			// would be interpreted as an HTML tag by Telegram's HTML parser.
			suffix.WriteString(html.EscapeString(fmtSessionDuration(time.Since(g.createdAt))))
		}

		fmt.Fprintf(&sb, "%d. %s%s | %s\n", i+1, freqPart, icons.String(), suffix.String())
	}

	// Summary footer — user counts, load averages, CPU temperature.
	sb.WriteString("\n")
	fmt.Fprintf(&sb, "• Regular users: %d of %d\n", regularCount, maxSessions)
	if bypassedCount > 0 {
		fmt.Fprintf(&sb, "• Bypassed users: %d\n", bypassedCount)
	}

	// Load averages from /proc/loadavg.
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			var l1, l5, l15 float64
			fmt.Sscanf(fields[0], "%f", &l1)
			fmt.Sscanf(fields[1], "%f", &l5)
			fmt.Sscanf(fields[2], "%f", &l15)
			// Warning when 1-minute load exceeds 2× CPU core count.
			cpuCount := runtime.NumCPU()
			loadThreshold := float64(cpuCount) * 2.0
			loadStatus := "OK"
			if l1 > loadThreshold {
				loadStatus = "⚠️ Warning"
			}
			fmt.Fprintf(&sb, "• Load 1m: %.2f 5m: %.2f 15m: %.2f (%s)\n", l1, l5, l15, loadStatus)
		}
	}

	// CPU temperature (silently omitted if sensor unavailable).
	if tempC, _, err := getCPUTemperature(); err == nil {
		tempStatus := "OK"
		if tempC >= DefaultCPUTempThresholdC {
			tempStatus = "⚠️ Warning"
		}
		fmt.Fprintf(&sb, "• CPU: %.0f°C (%s)\n", tempC, tempStatus)
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

// handleQRZ looks up a callsign via the configured QRZ service (or CTY-only if
// QRZ is not configured) and returns a concise summary.
// Usage: /qrz <callsign>
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleQRZ(chatID int64, args string) (string, string, bool) {
	// Require a callsign argument.
	rawCS := strings.TrimSpace(args)
	if rawCS == "" {
		msg := "📡 Usage: <code>/qrz &lt;callsign&gt;</code> — e.g. <code>/qrz MM3NDH</code>"
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Normalise (strip /P, /M, country-prefix overlays, etc.).
	cs := NormaliseCallsign(rawCS)
	if !reValidCallsign.MatchString(cs) {
		msg := "⚠️ Invalid callsign. Must be 3–10 alphanumeric characters after normalisation."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Check whether QRZ lookups are enabled at all.
	if globalQRZService == nil {
		// Fall back to CTY-only if available.
		if globalCTY == nil {
			msg := "📡 QRZ lookup service is not enabled on this receiver."
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		// CTY-only response.
		cty := globalCTY.LookupCallsignFull(cs)
		if cty == nil {
			msg := fmt.Sprintf("📡 <code>%s</code> — not found in CTY database.", html.EscapeString(cs))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "📡 <b>%s</b> (CTY only)\n\n", html.EscapeString(cs))
		if cty.Country != "" {
			fmt.Fprintf(&sb, "Country: %s\n", html.EscapeString(cty.Country))
		}
		if cty.Continent != "" {
			fmt.Fprintf(&sb, "Continent: %s\n", html.EscapeString(cty.Continent))
		}
		if cty.CQZone != 0 {
			fmt.Fprintf(&sb, "CQ Zone: %d\n", cty.CQZone)
		}
		if cty.ITUZone != 0 {
			fmt.Fprintf(&sb, "ITU Zone: %d\n", cty.ITUZone)
		}
		msg := sb.String()
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Full QRZ lookup (cache-first, then live API).
	result, err := globalQRZService.Lookup(cs)
	if err != nil {
		msg := fmt.Sprintf("⚠️ QRZ lookup failed: %s", html.EscapeString(err.Error()))
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	if result == nil {
		msg := fmt.Sprintf("📡 <code>%s</code> — callsign not found in QRZ database.", html.EscapeString(cs))
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>%s</b>\n\n", html.EscapeString(result.Call))

	// Operator name.
	name := result.NameFmt
	if name == "" {
		name = strings.TrimSpace(result.FName + " " + result.Name)
	}
	if name != "" {
		fmt.Fprintf(&sb, "Name: %s\n", html.EscapeString(name))
	}

	// Location.
	location := result.Addr2
	if result.State != "" {
		if location != "" {
			location += ", " + result.State
		} else {
			location = result.State
		}
	}
	if result.Country != "" {
		if location != "" {
			location += ", " + result.Country
		} else {
			location = result.Country
		}
	}
	if location != "" {
		fmt.Fprintf(&sb, "Location: %s\n", html.EscapeString(location))
	}

	// Grid square.
	if result.Grid != "" {
		fmt.Fprintf(&sb, "Grid: <code>%s</code>\n", html.EscapeString(result.Grid))
	}

	// Licence class.
	if result.Class != "" {
		fmt.Fprintf(&sb, "Class: %s\n", html.EscapeString(result.Class))
	}

	// CQ / ITU zones (prefer CTY augmentation if available).
	cqZone := result.CQZone
	ituZone := result.ITUZone
	if globalCTY != nil {
		if cty := globalCTY.LookupCallsignFull(cs); cty != nil {
			if cty.CQZone != 0 {
				cqZone = cty.CQZone
			}
			if cty.ITUZone != 0 {
				ituZone = cty.ITUZone
			}
		}
	}
	if cqZone != 0 {
		fmt.Fprintf(&sb, "CQ Zone: %d\n", cqZone)
	}
	if ituZone != 0 {
		fmt.Fprintf(&sb, "ITU Zone: %d\n", ituZone)
	}

	// QRZ profile URL.
	fmt.Fprintf(&sb, "\n<a href=\"https://www.qrz.com/db/%s\">View on QRZ.com</a>",
		html.EscapeString(result.Call))

	// Google Maps link when coordinates are available.
	if result.Lat != 0 || result.Lon != 0 {
		fmt.Fprintf(&sb, " · <a href=\"https://maps.google.com/?q=%.6f,%.6f\">Map</a>",
			result.Lat, result.Lon)
	}

	msg := sb.String()

	// If a profile photo is available, send it with the text as caption.
	// sendPhoto falls back to a plain text message on any fetch/upload error.
	if result.Image != "" {
		apiResp, apiOK := l.sendPhoto(chatID, result.Image, msg)
		return msg, apiResp, apiOK
	}

	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleChat reports the last 10 messages from the in-memory chat ring buffer —
// the same history that new websocket clients receive on connect.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleChat(chatID int64, args string) (string, string, bool) {
	if l.chatManager == nil {
		msg := "💬 Chat is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	all := l.chatManager.GetBufferedMessages()
	if len(all) == 0 {
		msg := "💬 No chat messages yet."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// Take the last 10 messages.
	const maxChat = 10
	start := len(all) - maxChat
	if start < 0 {
		start = 0
	}
	msgs := all[start:]

	var sb strings.Builder
	fmt.Fprintf(&sb, "💬 <b>Recent Chat</b> (%d messages)\n\n", len(msgs))
	for _, m := range msgs {
		ts := m.Timestamp.UTC().Format("15:04")
		fmt.Fprintf(&sb, "<code>%s</code> <b>%s</b>: %s\n",
			ts,
			html.EscapeString(m.Username),
			html.EscapeString(m.Message),
		)
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleSpace reports the current space weather conditions and 24-hour forecast.
// It mirrors the forecast summary shown at the top of bandconditions.html plus
// the key solar indices shown in the space weather panel.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleSpace(chatID int64, args string) (string, string, bool) {
	if l.spaceWeather == nil {
		msg := "☀️ Space weather monitoring is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	data := l.spaceWeather.GetData()
	if data == nil || data.LastUpdate.IsZero() {
		msg := "☀️ Space weather data not yet available. Try again in a few minutes."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	var sb strings.Builder
	sb.WriteString("☀️ <b>Space Weather Report</b>\n")
	fmt.Fprintf(&sb, "<i>Updated %s</i>\n\n", data.LastUpdate.UTC().Format("02 Jan 15:04 UTC"))

	// ── Forecast summary (mirrors the top banner in bandconditions.html) ──────
	if data.Forecast != nil && data.Forecast.Summary != "" {
		fmt.Fprintf(&sb, "<i>%s</i>\n\n", html.EscapeString(data.Forecast.Summary))
	}

	// ── Key solar indices ─────────────────────────────────────────────────────
	fmt.Fprintf(&sb, "Solar Flux: <b>%.0f SFU</b>\n", data.SolarFlux)
	fmt.Fprintf(&sb, "K-Index: <b>%d</b>", data.KIndex)
	if data.KIndexStatus != "" {
		fmt.Fprintf(&sb, " (%s)", html.EscapeString(data.KIndexStatus))
	}
	sb.WriteString("\n")
	fmt.Fprintf(&sb, "A-Index: <b>%d</b>\n", data.AIndex)

	// Solar wind Bz — positive = northward (generally benign), negative = southward (storm risk).
	bzDir := "Northward"
	if data.SolarWindBz < 0 {
		bzDir = "Southward"
	}
	fmt.Fprintf(&sb, "Solar Wind Bz: <b>%.1f nT</b> (%s)\n", data.SolarWindBz, bzDir)

	// Overall propagation quality.
	if data.PropagationQuality != "" {
		fmt.Fprintf(&sb, "Propagation: <b>%s</b>\n", html.EscapeString(data.PropagationQuality))
	}

	// ── 24-hour forecast detail (when available) ──────────────────────────────
	if data.Forecast != nil {
		sb.WriteString("\n<b>24-hour Forecast:</b>\n")
		if data.Forecast.GeomagneticStorm != "" {
			fmt.Fprintf(&sb, "  Geomagnetic storm: %s\n", html.EscapeString(data.Forecast.GeomagneticStorm))
		}
		if data.Forecast.RadioBlackout != "" {
			fmt.Fprintf(&sb, "  Radio blackout: %s\n", html.EscapeString(data.Forecast.RadioBlackout))
		}
		if data.Forecast.SolarRadiation != "" {
			fmt.Fprintf(&sb, "  Solar radiation: %s\n", html.EscapeString(data.Forecast.SolarRadiation))
		}
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// handleGPSDO reports the current Leo Bodnar LBE-1420 GPSDO device and GPS status.
// It shows device lock states, output configuration, frequency, and full GPS telemetry.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleGPSDO(chatID int64, args string) (string, string, bool) {
	if l.gpsdoMonitor == nil {
		msg := "📡 GPSDO monitoring is not enabled on this receiver."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	snap := l.gpsdoMonitor.GetSnapshot()
	if snap == nil {
		msg := "📡 GPSDO data not available — the Leo Bodnar container may be unreachable."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	boolIcon := func(v bool) string {
		if v {
			return "✅"
		}
		return "❌"
	}

	var sb strings.Builder
	sb.WriteString("📡 <b>GPSDO Status (Leo Bodnar LBE-1420)</b>\n\n")

	// ── Device paths ──────────────────────────────────────────────────────────
	if snap.Device != "" {
		fmt.Fprintf(&sb, "HID device: <code>%s</code>\n", html.EscapeString(snap.Device))
	}
	if snap.Serial != "" {
		fmt.Fprintf(&sb, "Serial port: <code>%s</code>\n", html.EscapeString(snap.Serial))
	}

	// ── Device status ─────────────────────────────────────────────────────────
	if ds := snap.DeviceStatus; ds != nil {
		sb.WriteString("\n<b>Device</b>\n")
		fmt.Fprintf(&sb, "  GPS lock: %s\n", boolIcon(ds.GPSLock))
		fmt.Fprintf(&sb, "  PLL lock: %s\n", boolIcon(ds.PLLLock))
		fmt.Fprintf(&sb, "  Antenna: %s\n", boolIcon(ds.AntennaOK))
		if ds.Mode != "" {
			fmt.Fprintf(&sb, "  Mode: <b>%s</b>\n", html.EscapeString(ds.Mode))
		}
		if ds.FrequencyHz > 0 {
			mhz := float64(ds.FrequencyHz) / 1_000_000.0
			fmt.Fprintf(&sb, "  Frequency: <b>%.6f MHz</b>\n", mhz)
		}
		sb.WriteString("\n<b>Output 1</b>\n")
		fmt.Fprintf(&sb, "  Enabled: %s\n", boolIcon(ds.Output1Enabled))
		fmt.Fprintf(&sb, "  1PPS: %s\n", boolIcon(ds.Output1PPS))
		if ds.Output1Drive != "" {
			fmt.Fprintf(&sb, "  Drive: %s\n", html.EscapeString(ds.Output1Drive))
		}
	} else {
		sb.WriteString("\n⚠️ <i>Device status unavailable</i>\n")
	}

	// ── GPS telemetry ─────────────────────────────────────────────────────────
	if gps := snap.GPS; gps != nil {
		sb.WriteString("\n<b>GPS</b>\n")
		if gps.DatetimeUTC != "" {
			fmt.Fprintf(&sb, "  UTC time: <b>%s</b>\n", html.EscapeString(gps.DatetimeUTC))
		}
		if gps.Fix != "" {
			fmt.Fprintf(&sb, "  Fix: <b>%s</b>", html.EscapeString(gps.Fix))
			if gps.FixMode != "" {
				fmt.Fprintf(&sb, " (%s)", html.EscapeString(gps.FixMode))
			}
			sb.WriteString("\n")
		}
		fmt.Fprintf(&sb, "  Satellites used: <b>%d</b>", gps.SatsUsed)
		if gps.GPSInView > 0 || gps.GLOInView > 0 {
			fmt.Fprintf(&sb, " (GPS in view: %d", gps.GPSInView)
			if gps.GLOInView > 0 {
				fmt.Fprintf(&sb, ", GLONASS in view: %d", gps.GLOInView)
			}
			sb.WriteString(")")
		}
		sb.WriteString("\n")

		// DOP values
		fmt.Fprintf(&sb, "  HDOP: %.2f  VDOP: %.2f  PDOP: %.2f\n", gps.HDOP, gps.VDOP, gps.PDOP)

		// Position
		if gps.AltitudeM != 0 {
			fmt.Fprintf(&sb, "  Altitude: <b>%.1f m</b>\n", gps.AltitudeM)
		}
		if gps.Latitude != 0 || gps.Longitude != 0 {
			fmt.Fprintf(&sb, "  Position: <b>%.6f, %.6f</b>\n", gps.Latitude, gps.Longitude)
		}
		if gps.SpeedKnots != 0 {
			fmt.Fprintf(&sb, "  Speed: %.2f kn\n", gps.SpeedKnots)
		}
	} else {
		sb.WriteString("\n⚠️ <i>GPS data unavailable</i>\n")
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
				if bc.writeHint != "" {
					line += "\n    ↳ " + bc.writeHint
				}
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
