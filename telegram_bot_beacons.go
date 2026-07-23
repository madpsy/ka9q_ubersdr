package main

// telegram_bot_beacons.go — /beacons command handler.
//
// Reports the NCDXF/IARU international beacon network: which of the 18 beacons
// is transmitting on each of the 5 HF bands right now (pure arithmetic — the
// schedule is deterministic), plus what this receiver has actually heard,
// derived from the CW skimmer spots in the cw_spots table.
//
//	/beacons          → live schedule + reception summary over the last 60 min
//	/beacons 20m      → one band: every beacon, last heard and best SNR
//	/beacons OH2B     → one beacon: all 5 bands plus next transmission times
//	/beacons 6h       → widen the reception window (default 60 min, max 168h)
//
// The reception half requires the CW skimmer, so the command is gated on it.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

func init() {
	botCommands["beacons"] = botCommand{
		desc:     "Show NCDXF/IARU beacon schedule and which beacons are being heard (e.g. /beacons 20m)",
		readOnly: true,
		handler:  (*TelegramBotListener).handleBeacons,
	}
}

// ─── Beacon roster ────────────────────────────────────────────────────────────

// ncdxfRosterPath is the roster shared with the ncdxf_beacons.html page, so the
// bot and the web UI can never disagree about slots or locations.
const ncdxfRosterPath = "static/ncdxf_beacons.json"

// ncdxfBeacon is one entry of the 18-beacon roster.
type ncdxfBeacon struct {
	Slot        int     `json:"slot"`
	Callsign    string  `json:"callsign"`
	Entity      string  `json:"entity"`
	Location    string  `json:"location"`
	Country     string  `json:"country"`
	CountryCode string  `json:"country_code"`
	Grid        string  `json:"grid"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Operator    string  `json:"operator"`
}

// The five beacon bands, in slot order (index 0 = 20m). A beacon moves one band
// up every 10 s, so the band index is also the slot offset.
var (
	ncdxfBandNames     = []string{"20m", "17m", "15m", "12m", "10m"}
	ncdxfBandMHz       = []string{"14.100", "18.110", "21.150", "24.930", "28.200"}
	ncdxfBandNominalHz = []float64{14_100_000, 18_110_000, 21_150_000, 24_930_000, 28_200_000}
)

// ncdxfBeaconCount is the number of beacons in one full 3-minute cycle.
const ncdxfBeaconCount = 18

var (
	ncdxfRosterMu    sync.Mutex
	ncdxfRosterCache []ncdxfBeacon
)

// loadNCDXFBeacons reads and caches the beacon roster from disk. The roster is
// static data, so it is read once and kept for the life of the process.
func loadNCDXFBeacons() ([]ncdxfBeacon, error) {
	ncdxfRosterMu.Lock()
	defer ncdxfRosterMu.Unlock()
	if len(ncdxfRosterCache) > 0 {
		return ncdxfRosterCache, nil
	}

	raw, err := os.ReadFile(ncdxfRosterPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", ncdxfRosterPath, err)
	}
	var doc struct {
		Beacons struct {
			Beacons []ncdxfBeacon `json:"beacons"`
		} `json:"ncdxf_iaru_beacons"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", ncdxfRosterPath, err)
	}
	if len(doc.Beacons.Beacons) != ncdxfBeaconCount {
		return nil, fmt.Errorf("%s: expected %d beacons, got %d",
			ncdxfRosterPath, ncdxfBeaconCount, len(doc.Beacons.Beacons))
	}
	// Slot order is what the schedule maths indexes into — sort defensively so a
	// hand-edited roster cannot silently shift every beacon by one band.
	beacons := doc.Beacons.Beacons
	sort.Slice(beacons, func(i, j int) bool { return beacons[i].Slot < beacons[j].Slot })

	ncdxfRosterCache = beacons
	return ncdxfRosterCache, nil
}

// ─── Schedule maths ───────────────────────────────────────────────────────────
//
// Mirrors BeaconClock.js by VE3SUN and the ncdxf_beacons.html page:
//   n = floor(unixMillis / 10000) % 18   → index of the beacon on 20m
//   beacon on band i                     → beacons[(18 + n - i) % 18]

// ncdxfSlot returns the index of the beacon transmitting on 20m at time t.
func ncdxfSlot(t time.Time) int {
	return int(((t.UnixMilli() / 10000) % ncdxfBeaconCount))
}

// ncdxfBeaconOn returns the beacon transmitting on band index bandIdx when the
// 20m slot index is n.
func ncdxfBeaconOn(beacons []ncdxfBeacon, n, bandIdx int) ncdxfBeacon {
	return beacons[(ncdxfBeaconCount+n-bandIdx)%ncdxfBeaconCount]
}

// ncdxfBandIndex returns the band index for a band name, or -1 if it is not a
// beacon band.
func ncdxfBandIndex(band string) int {
	for i, b := range ncdxfBandNames {
		if b == band {
			return i
		}
	}
	return -1
}

// ncdxfSpotValid reports whether a spot's callsign matches the beacon scheduled
// on that band at that instant — the same check the web page applies, used to
// separate genuine beacon decodes from skimmer noise on the beacon frequencies.
//
// cw_spots timestamps have one-second resolution and the skimmer stamps a decode
// a moment after the transmission begins, so a ±2 s tolerance is allowed around
// the slot boundary.
func ncdxfSpotValid(beacons []ncdxfBeacon, call, band string, ts time.Time) bool {
	bandIdx := ncdxfBandIndex(band)
	if bandIdx < 0 {
		return false
	}
	for _, off := range []int{0, -1, -2, 1, 2} {
		n := ncdxfSlot(ts.Add(time.Duration(off) * time.Second))
		if ncdxfBeaconOn(beacons, n, bandIdx).Callsign == call {
			return true
		}
	}
	return false
}

// ncdxfNextTransmission returns how long until the beacon at slot index
// beaconIdx next transmits on band index bandIdx, relative to now.
func ncdxfNextTransmission(beaconIdx, bandIdx int, now time.Time) time.Duration {
	wantN := (beaconIdx + bandIdx) % ncdxfBeaconCount
	nowN := ncdxfSlot(now)
	// Milliseconds elapsed inside the current 10 s slot.
	intoSlot := time.Duration(now.UnixMilli()%10000) * time.Millisecond
	delta := (wantN - nowN + ncdxfBeaconCount) % ncdxfBeaconCount
	return time.Duration(delta)*10*time.Second - intoSlot
}

// ─── Spot aggregation ─────────────────────────────────────────────────────────

// ncdxfSpot is one beacon decode read back from cw_spots.
type ncdxfSpot struct {
	ts    time.Time
	call  string
	band  string
	snr   int
	freq  float64 // Hz as decoded
	valid bool    // matches the published schedule for its band
}

// loadNCDXFSpots reads every spot for a beacon callsign in the window
// [since, now] from cw_spots, newest first, tagging each with schedule validity.
func loadNCDXFSpots(db *sql.DB, beacons []ncdxfBeacon, since time.Time) ([]ncdxfSpot, error) {
	placeholders := make([]string, 0, len(beacons))
	args := make([]interface{}, 0, len(beacons)+1)
	args = append(args, since.Unix())
	for _, b := range beacons {
		placeholders = append(placeholders, "?")
		args = append(args, b.Callsign)
	}

	query := `SELECT ts, dx_call, snr, frequency, band
	          FROM cw_spots
	          WHERE ts >= ? AND dx_call IN (` + strings.Join(placeholders, ",") + `)
	          ORDER BY ts DESC`

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("cw_spots beacon query failed: %w", err)
	}
	defer rows.Close()

	var spots []ncdxfSpot
	for rows.Next() {
		var (
			ts   int64
			call string
			snr  int
			freq float64
			band sql.NullString
		)
		if err := rows.Scan(&ts, &call, &snr, &freq, &band); err != nil {
			return nil, fmt.Errorf("cw_spots beacon scan failed: %w", err)
		}
		s := ncdxfSpot{
			ts:   time.Unix(ts, 0).UTC(),
			call: call,
			band: band.String,
			snr:  snr,
			freq: freq,
		}
		s.valid = ncdxfSpotValid(beacons, s.call, s.band, s.ts)
		spots = append(spots, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("cw_spots beacon iteration failed: %w", err)
	}
	return spots, nil
}

// lastNCDXFSpotTime returns the timestamp of the most recent beacon spot of any
// age, used to explain an empty window (never heard vs. simply quiet lately).
// The zero time means no beacon has ever been logged.
func lastNCDXFSpotTime(db *sql.DB, beacons []ncdxfBeacon) time.Time {
	placeholders := make([]string, 0, len(beacons))
	args := make([]interface{}, 0, len(beacons))
	for _, b := range beacons {
		placeholders = append(placeholders, "?")
		args = append(args, b.Callsign)
	}
	var ts sql.NullInt64
	err := db.QueryRow(
		`SELECT MAX(ts) FROM cw_spots WHERE dx_call IN (`+strings.Join(placeholders, ",")+`)`,
		args...).Scan(&ts)
	if err != nil || !ts.Valid {
		return time.Time{}
	}
	return time.Unix(ts.Int64, 0).UTC()
}

// ─── /beacons ─────────────────────────────────────────────────────────────────

// ncdxfWindowRe matches a window argument such as "6h" or "24h".
var ncdxfWindowRe = regexp.MustCompile(`^(\d+)h$`)

// handleBeacons reports the live NCDXF/IARU beacon schedule and this receiver's
// recent beacon reception.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleBeacons(chatID int64, args string) (string, string, bool) {
	// The reception half of this command comes from the CW skimmer, so without
	// it there is nothing meaningful to report.
	if l.cwSkimmerConfig == nil || !l.cwSkimmerConfig.Enabled {
		msg := "📡 The CW skimmer is not enabled on this receiver, so beacon reception " +
			"cannot be reported.\n\nEnable the CW skimmer (and make sure it covers " +
			"14.100, 18.110, 21.150, 24.930 and 28.200 MHz) to use <code>/beacons</code>."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	if l.readDB == nil {
		msg := "📡 Beacon spot history is not available (database not wired)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	beacons, err := loadNCDXFBeacons()
	if err != nil {
		msg := "📡 Beacon roster could not be loaded: " + html.EscapeString(err.Error())
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	// ── Parse arguments: a band, a callsign, and/or a window ──────────────────
	window := time.Hour
	var bandFilter string
	var callFilter string
	for _, tok := range strings.Fields(strings.TrimSpace(args)) {
		lower := strings.ToLower(tok)
		if m := ncdxfWindowRe.FindStringSubmatch(lower); m != nil {
			var hours int
			fmt.Sscanf(m[1], "%d", &hours) //nolint:errcheck // regex guarantees digits
			if hours < 1 {
				hours = 1
			}
			if hours > 168 {
				hours = 168
			}
			window = time.Duration(hours) * time.Hour
			continue
		}
		if ncdxfBandIndex(lower) >= 0 {
			bandFilter = lower
			continue
		}
		if ncdxfBandIndex(lower+"m") >= 0 { // "/beacons 20"
			bandFilter = lower + "m"
			continue
		}
		callFilter = strings.ToUpper(tok)
	}

	if callFilter != "" {
		var found *ncdxfBeacon
		for i := range beacons {
			if beacons[i].Callsign == callFilter {
				found = &beacons[i]
				break
			}
		}
		if found == nil {
			calls := make([]string, 0, len(beacons))
			for _, b := range beacons {
				calls = append(calls, b.Callsign)
			}
			msg := fmt.Sprintf("📡 <code>%s</code> is not an NCDXF/IARU beacon. The 18 beacons are:\n%s",
				html.EscapeString(callFilter), html.EscapeString(strings.Join(calls, ", ")))
			apiResp, apiOK := l.sendMessage(chatID, msg)
			return msg, apiResp, apiOK
		}
	}

	now := time.Now().UTC()
	since := now.Add(-window)

	spots, err := loadNCDXFSpots(l.readDB, beacons, since)
	if err != nil {
		msg := "📡 Beacon spot lookup failed: " + html.EscapeString(err.Error())
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}

	var sb strings.Builder
	switch {
	case callFilter != "":
		l.writeBeaconCallsignReport(&sb, beacons, spots, callFilter, now, window)
	case bandFilter != "":
		l.writeBeaconBandReport(&sb, beacons, spots, bandFilter, now, window)
	default:
		l.writeBeaconOverview(&sb, beacons, spots, now, window)
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}

// ─── Report sections ──────────────────────────────────────────────────────────

// writeBeaconOverview writes the default report: what is transmitting right now
// on all five bands, followed by a reception summary for the window.
func (l *TelegramBotListener) writeBeaconOverview(sb *strings.Builder, beacons []ncdxfBeacon,
	spots []ncdxfSpot, now time.Time, window time.Duration) {

	n := ncdxfSlot(now)
	intoSlot := (now.UnixMilli() % 10000) / 1000

	fmt.Fprintf(sb, "📡 <b>NCDXF/IARU Beacons</b> — %s UTC\n", now.Format("15:04:05"))
	fmt.Fprintf(sb, "<i>Slot %d/18 · %ds into slot</i>\n\n", n+1, intoSlot)

	sb.WriteString("<b>Transmitting now:</b>\n")
	for i, band := range ncdxfBandNames {
		b := ncdxfBeaconOn(beacons, n, i)
		fmt.Fprintf(sb, "  <code>%-4s %s</code>  %s\n", band, ncdxfBandMHz[i], l.beaconLabel(b))
	}

	// The beacon that takes over 20m when the slot rotates.
	next := ncdxfBeaconOn(beacons, (n+1)%ncdxfBeaconCount, 0)
	fmt.Fprintf(sb, "<i>Next on 20m in %ds: %s</i>\n\n", 10-intoSlot, html.EscapeString(next.Callsign))

	l.writeBeaconReception(sb, beacons, spots, now, window)
}

// writeBeaconReception writes the "heard here" half of the report: per-band
// beacon counts, signal extremes, receiver frequency offset and decode quality.
func (l *TelegramBotListener) writeBeaconReception(sb *strings.Builder, beacons []ncdxfBeacon,
	spots []ncdxfSpot, now time.Time, window time.Duration) {

	byCall := make(map[string]ncdxfBeacon, len(beacons))
	for _, b := range beacons {
		byCall[b.Callsign] = b
	}

	// Valid spots only — off-schedule decodes are counted separately below and
	// must not inflate the propagation picture.
	var (
		valid, invalid int
		heard          = map[string]bool{}
		bandHeard      = map[string]map[string]bool{}
		bandSpots      = map[string]int{}
		bandBestSNR    = map[string]int{}
		bandBestCall   = map[string]string{}
		snrSum         int
		snrCount       int
		offsetSum      float64
		offsetCount    int
		bestDistKm     float64
		bestDistCall   string
		bestDistBand   string
		lastValid      time.Time
	)
	for _, s := range spots {
		if !s.valid {
			invalid++
			continue
		}
		valid++
		heard[s.call] = true
		if bandHeard[s.band] == nil {
			bandHeard[s.band] = map[string]bool{}
		}
		bandHeard[s.band][s.call] = true
		bandSpots[s.band]++
		if cur, ok := bandBestSNR[s.band]; !ok || s.snr > cur {
			bandBestSNR[s.band] = s.snr
			bandBestCall[s.band] = s.call
		}
		snrSum += s.snr
		snrCount++
		if s.ts.After(lastValid) {
			lastValid = s.ts
		}
		if idx := ncdxfBandIndex(s.band); idx >= 0 && s.freq > 0 {
			offsetSum += s.freq - ncdxfBandNominalHz[idx]
			offsetCount++
		}
		if b, ok := byCall[s.call]; ok {
			if km, _, ok := l.beaconDistance(b); ok && km > bestDistKm {
				bestDistKm, bestDistCall, bestDistBand = km, s.call, s.band
			}
		}
	}

	fmt.Fprintf(sb, "<b>Heard here — last %s:</b>\n", fmtBeaconWindow(window))
	if valid == 0 {
		l.writeBeaconNothingHeard(sb, beacons, invalid, now, window)
		return
	}

	fmt.Fprintf(sb, "%d/18 beacons · %d spots\n", len(heard), valid)
	for i, band := range ncdxfBandNames {
		count := len(bandHeard[band])
		if count == 0 {
			fmt.Fprintf(sb, "  <code>%-4s %s ░░░░░░░░</code>  closed\n", band, ncdxfBandMHz[i])
			continue
		}
		fmt.Fprintf(sb, "  <code>%-4s %s %s</code>  %d beacons · best %s %s\n",
			band, ncdxfBandMHz[i], beaconBar(count),
			count, html.EscapeString(bandBestCall[band]), fmtBeaconSNR(bandBestSNR[band]))
	}

	if snrCount > 0 {
		fmt.Fprintf(sb, "\nAvg SNR: <b>%s</b>", fmtBeaconSNR(int(math.Round(float64(snrSum)/float64(snrCount)))))
	}
	if bestDistCall != "" {
		fmt.Fprintf(sb, " · Best DX: <b>%s</b> %s km on %s",
			html.EscapeString(bestDistCall), fmtBeaconKm(bestDistKm), html.EscapeString(bestDistBand))
	}
	sb.WriteString("\n")
	if !lastValid.IsZero() {
		fmt.Fprintf(sb, "Last decode: %s UTC (%s ago)\n",
			lastValid.Format("15:04:05"), fmtBeaconAgo(now.Sub(lastValid)))
	}

	// Beacon frequencies are exact by definition, so the mean error of the
	// decoded frequency is a direct calibration reading for this receiver.
	if offsetCount > 0 {
		avg := offsetSum / float64(offsetCount)
		fmt.Fprintf(sb, "Rx frequency offset: <b>%+.1f Hz</b> (mean of %d decodes)\n", avg, offsetCount)
	}

	// A high off-schedule rate means the skimmer is decoding something other
	// than the beacons on those frequencies.
	if invalid > 0 {
		pct := float64(invalid) / float64(valid+invalid) * 100
		fmt.Fprintf(sb, "Off-schedule decodes: <b>%d</b> (%.0f%%) — ignored above\n", invalid, pct)
	}

	// Which beacons stayed silent, which is as informative as which did not.
	var missing []string
	for _, b := range beacons {
		if !heard[b.Callsign] {
			missing = append(missing, b.Callsign)
		}
	}
	if len(missing) > 0 {
		fmt.Fprintf(sb, "\nNot heard: <i>%s</i>\n", html.EscapeString(strings.Join(missing, ", ")))
	}

	sb.WriteString("\n<i>Use /beacons &lt;band&gt;, /beacons &lt;callsign&gt; or /beacons &lt;N&gt;h for detail.</i>")
}

// writeBeaconNothingHeard explains an empty window: either the skimmer has never
// logged a beacon (most likely it does not cover the beacon frequencies) or the
// bands are simply dead right now.
func (l *TelegramBotListener) writeBeaconNothingHeard(sb *strings.Builder, beacons []ncdxfBeacon,
	invalid int, now time.Time, window time.Duration) {

	last := lastNCDXFSpotTime(l.readDB, beacons)
	if last.IsZero() {
		sb.WriteString("No beacon has ever been logged by the CW skimmer.\n")
		sb.WriteString("<i>Check that the skimmer covers 14.100, 18.110, 21.150, 24.930 and 28.200 MHz.</i>\n")
		return
	}
	fmt.Fprintf(sb, "Nothing in the last %s — bands closed or receiver quiet.\n", fmtBeaconWindow(window))
	fmt.Fprintf(sb, "Last beacon decode was %s ago (%s UTC).\n",
		fmtBeaconAgo(now.Sub(last)), last.Format("2006-01-02 15:04"))
	if invalid > 0 {
		fmt.Fprintf(sb, "(%d off-schedule decodes on beacon frequencies were ignored.)\n", invalid)
	}
	sb.WriteString("\n<i>Use /beacons &lt;N&gt;h to widen the window, e.g. /beacons 24h.</i>")
}

// writeBeaconBandReport writes the per-beacon detail for a single band: every
// beacon in slot order with its last decode and best signal in the window.
func (l *TelegramBotListener) writeBeaconBandReport(sb *strings.Builder, beacons []ncdxfBeacon,
	spots []ncdxfSpot, band string, now time.Time, window time.Duration) {

	bandIdx := ncdxfBandIndex(band)
	n := ncdxfSlot(now)
	current := ncdxfBeaconOn(beacons, n, bandIdx)

	fmt.Fprintf(sb, "📡 <b>NCDXF Beacons — %s (%s MHz)</b>\n", strings.ToUpper(band), ncdxfBandMHz[bandIdx])
	fmt.Fprintf(sb, "%s UTC · on air now: <b>%s</b>\n\n", now.Format("15:04:05"), html.EscapeString(current.Callsign))

	type stat struct {
		last    time.Time
		best    int
		count   int
		hasBest bool
	}
	stats := map[string]*stat{}
	for _, s := range spots {
		if !s.valid || s.band != band {
			continue
		}
		st := stats[s.call]
		if st == nil {
			st = &stat{}
			stats[s.call] = st
		}
		st.count++
		if s.ts.After(st.last) {
			st.last = s.ts
		}
		if !st.hasBest || s.snr > st.best {
			st.best, st.hasBest = s.snr, true
		}
	}

	fmt.Fprintf(sb, "<b>Last %s:</b> %d/18 beacons heard\n", fmtBeaconWindow(window), len(stats))
	for _, b := range beacons {
		st := stats[b.Callsign]
		if st == nil {
			fmt.Fprintf(sb, "  <code>%-7s</code> —\n", b.Callsign)
			continue
		}
		fmt.Fprintf(sb, "  <code>%-7s</code> %s · %d× · %s ago\n",
			b.Callsign, fmtBeaconSNR(st.best), st.count, fmtBeaconAgo(now.Sub(st.last)))
	}
	sb.WriteString("\n<i>Signal shown is the best decode in the window.</i>")
}

// writeBeaconCallsignReport writes the detail for a single beacon: where it is,
// how far away, when it next transmits on each band and how it has been heard.
func (l *TelegramBotListener) writeBeaconCallsignReport(sb *strings.Builder, beacons []ncdxfBeacon,
	spots []ncdxfSpot, call string, now time.Time, window time.Duration) {

	var b ncdxfBeacon
	var beaconIdx int
	for i := range beacons {
		if beacons[i].Callsign == call {
			b, beaconIdx = beacons[i], i
			break
		}
	}

	fmt.Fprintf(sb, "📡 <b>%s</b> — %s\n", l.beaconFlagged(b), html.EscapeString(b.Entity))
	fmt.Fprintf(sb, "%s · <code>%s</code> · slot %d/18\n",
		html.EscapeString(b.Location), html.EscapeString(b.Grid), b.Slot)
	if b.Operator != "" {
		fmt.Fprintf(sb, "Operated by %s\n", html.EscapeString(b.Operator))
	}
	if km, bearing, ok := l.beaconDistance(b); ok {
		fmt.Fprintf(sb, "Distance: <b>%s km</b> · bearing <b>%.0f°</b>\n", fmtBeaconKm(km), bearing)
	}

	sb.WriteString("\n<b>Next transmissions:</b>\n")
	type sched struct {
		bandIdx int
		in      time.Duration
	}
	upcoming := make([]sched, 0, len(ncdxfBandNames))
	for i := range ncdxfBandNames {
		upcoming = append(upcoming, sched{i, ncdxfNextTransmission(beaconIdx, i, now)})
	}
	sort.Slice(upcoming, func(i, j int) bool { return upcoming[i].in < upcoming[j].in })
	for _, u := range upcoming {
		when := "now"
		if u.in > 0 {
			when = "in " + fmtBeaconCountdown(u.in)
		}
		fmt.Fprintf(sb, "  <code>%-4s %s</code>  %s\n", ncdxfBandNames[u.bandIdx], ncdxfBandMHz[u.bandIdx], when)
	}

	// Per-band reception for this beacon.
	type stat struct {
		last    time.Time
		best    int
		count   int
		hasBest bool
	}
	stats := map[string]*stat{}
	for _, s := range spots {
		if !s.valid || s.call != call {
			continue
		}
		st := stats[s.band]
		if st == nil {
			st = &stat{}
			stats[s.band] = st
		}
		st.count++
		if s.ts.After(st.last) {
			st.last = s.ts
		}
		if !st.hasBest || s.snr > st.best {
			st.best, st.hasBest = s.snr, true
		}
	}

	fmt.Fprintf(sb, "\n<b>Heard here — last %s:</b>\n", fmtBeaconWindow(window))
	if len(stats) == 0 {
		fmt.Fprintf(sb, "Not heard on any band.\n")
		sb.WriteString("\n<i>Use /beacons " + html.EscapeString(call) + " 24h to widen the window.</i>")
		return
	}
	for i, band := range ncdxfBandNames {
		st := stats[band]
		if st == nil {
			fmt.Fprintf(sb, "  <code>%-4s %s</code>  —\n", band, ncdxfBandMHz[i])
			continue
		}
		fmt.Fprintf(sb, "  <code>%-4s %s</code>  %s · %d× · %s ago\n",
			band, ncdxfBandMHz[i], fmtBeaconSNR(st.best), st.count, fmtBeaconAgo(now.Sub(st.last)))
	}
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

// beaconLabel renders a beacon as "🇯🇵 JA2IGY  Mt. Asama, Nagano  9,240 km az 42°",
// omitting the distance when the receiver has no GPS coordinates configured.
func (l *TelegramBotListener) beaconLabel(b ncdxfBeacon) string {
	label := fmt.Sprintf("<b>%s</b> %s", l.beaconFlagged(b), html.EscapeString(b.Location))
	if km, bearing, ok := l.beaconDistance(b); ok {
		label += fmt.Sprintf(" · %s km az %.0f°", fmtBeaconKm(km), bearing)
	}
	return label
}

// beaconFlagged returns the beacon callsign prefixed with its country flag.
func (l *TelegramBotListener) beaconFlagged(b ncdxfBeacon) string {
	if flag := countryCodeToFlag(b.CountryCode); flag != "" {
		return flag + " " + html.EscapeString(b.Callsign)
	}
	return html.EscapeString(b.Callsign)
}

// beaconDistance returns the great-circle distance and bearing from the receiver
// to a beacon. ok is false when the receiver has no GPS coordinates configured.
func (l *TelegramBotListener) beaconDistance(b ncdxfBeacon) (km float64, bearing float64, ok bool) {
	if l.config == nil {
		return 0, 0, false
	}
	lat, lon := l.config.Admin.GPS.Lat, l.config.Admin.GPS.Lon
	if lat == 0 && lon == 0 {
		return 0, 0, false
	}
	km, bearing = CalculateDistanceAndBearing(lat, lon, b.Latitude, b.Longitude)
	return km, bearing, true
}

// beaconBar renders an 8-cell bar showing how many of the 18 beacons were heard.
func beaconBar(count int) string {
	filled := int(math.Round(float64(count) / float64(ncdxfBeaconCount) * 8))
	if count > 0 && filled == 0 {
		filled = 1 // never render a heard band as empty
	}
	if filled > 8 {
		filled = 8
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", 8-filled)
}

// fmtBeaconSNR formats an SNR with an explicit sign, e.g. "+14 dB".
func fmtBeaconSNR(snr int) string {
	return fmt.Sprintf("%+d dB", snr)
}

// fmtBeaconKm formats a distance with thousands separators, e.g. "18,700".
func fmtBeaconKm(km float64) string {
	s := fmt.Sprintf("%.0f", km)
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, c)
	}
	return string(out)
}

// fmtBeaconWindow formats the reception window, e.g. "60 min" or "24h".
func fmtBeaconWindow(d time.Duration) string {
	if d < time.Hour {
		return fmt.Sprintf("%d min", int(d.Minutes()))
	}
	if d == time.Hour {
		return "60 min"
	}
	return fmt.Sprintf("%dh", int(d.Hours()))
}

// fmtBeaconCountdown formats a wait as "42s" or "2m10s". Consecutive slots are
// only 10 s apart, so seconds are always kept.
func fmtBeaconCountdown(d time.Duration) string {
	total := int(d.Round(time.Second).Seconds())
	if total < 60 {
		return fmt.Sprintf("%ds", total)
	}
	return fmt.Sprintf("%dm%02ds", total/60, total%60)
}

// fmtBeaconAgo formats a short elapsed/remaining duration, e.g. "8s", "12m", "3h10m".
func fmtBeaconAgo(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if m == 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dh%dm", h, m)
}
