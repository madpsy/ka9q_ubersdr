package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
)

// stats_psk_history.go — public GET /api/stats/psk-rank history endpoint.
//
// Two mutually exclusive modes:
//
// 1. History (default) — a time-series of PSKRankData snapshots over a date
//    range, with an optional callsign filter.
//
// 2. Point-in-time (?at=…) — the complete leaderboard state as it stood at a
//    given instant, reconstructed from the snapshot nearest that time. The
//    stored snapshots hold every band's full ranking, so this is an exact
//    replay of what pskreporter.info showed at the time of that scrape.
//
// Query parameters — history mode:
//
//	period    — "24h" | "7d" | "30d"
//	from_date — YYYY-MM-DD  (alternative to period)
//	to_date   — YYYY-MM-DD  (defaults to from_date; ignored when period is set)
//	callsign  — case-insensitive; when set, only rank data is returned per
//	            snapshot (full leaderboard arrays are omitted) and snapshots
//	            where the callsign is not found are skipped.
//	callsign2 — optional second station to compare against callsign. Its rank
//	            data is returned alongside as callsign_rank2, and a snapshot is
//	            kept when either station appears in it.
//
// Query parameters — point-in-time mode:
//
//	at        — the instant of interest, UTC. Accepted forms: RFC3339,
//	            YYYY-MM-DDTHH:MM[:SS], YYYY-MM-DD HH:MM[:SS], YYYY-MM-DD, or
//	            Unix seconds. Snapshots are hourly, so the nearest one within
//	            ±pskAtSearchWindow is returned along with the drift.
//	table     — "reports" | "countries" | "all" (default: all)
//	band      — single band (e.g. "20m"); omit or "all" for every band.
//	callsign  — rejected; the response is the whole leaderboard by definition.
//
// Maximum range: 30 days per request (history mode).
// Authentication: none (public endpoint).
// Rate limiting: shared FFTRateLimiter.

// reBandParam constrains ?band= to the shape PSKReporter uses ("20m", "70cm",
// "All"). The value is only ever used as a map key, but validating keeps
// unbounded caller-supplied strings out of the response.
var reBandParam = regexp.MustCompile(`^[A-Za-z0-9]{1,8}$`)

// resolvePSKBandKey maps a caller-supplied band name onto the matching key in
// src, ignoring case. "all" passes through untouched; an unknown band is
// returned as-is so filterPSKByBand yields an empty result.
func resolvePSKBandKey(src PSKMonitorsByBand, band string) string {
	if band == "all" {
		return band
	}
	for key := range src {
		if strings.EqualFold(key, band) {
			return key
		}
	}
	return band
}

// pskAtResponse is the point-in-time (?at=) response body.
type pskAtResponse struct {
	statsAtCommon
	FetchedAt     string                    `json:"fetched_at"`
	Band          string                    `json:"band"`
	ReportResult  PSKMonitorsByBandEnriched `json:"report_result,omitempty"`
	CountryResult PSKMonitorsByBandEnriched `json:"country_result,omitempty"`
	UberSDRCount  int                       `json:"ubersdr_count,omitempty"`
	Error         string                    `json:"error,omitempty"` // scrape error recorded with the snapshot
}

// handlePSKRankAt serves the ?at= point-in-time branch of GET /api/stats/psk-rank.
// The caller has already handled bans, rate limiting and the nil-sl check.
func handlePSKRankAt(w http.ResponseWriter, r *http.Request, sl *StatsLogger, rawAt string) {
	q := r.URL.Query()

	if rejectCallsignWithAt(w, r) {
		return
	}

	at, errMsg := parseStatsAtParam(rawAt)
	if errMsg != "" {
		writeStatsError(w, http.StatusBadRequest, errMsg)
		return
	}

	table := strings.ToLower(strings.TrimSpace(q.Get("table")))
	switch table {
	case "", "all":
		table = "all"
	case "reports", "countries":
		// valid
	default:
		writeStatsError(w, http.StatusBadRequest, "invalid table — accepted values: reports, countries, all")
		return
	}

	band := strings.TrimSpace(q.Get("band"))
	if band != "" && !strings.EqualFold(band, "all") && !reBandParam.MatchString(band) {
		writeStatsError(w, http.StatusBadRequest, "invalid band — expected a short alphanumeric band name such as 20m")
		return
	}
	if band == "" || strings.EqualFold(band, "all") {
		band = "all"
	}

	data, err := sl.ReadPSKAt(at, pskAtSearchWindow)
	if err != nil {
		writeStatsError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if data == nil {
		writeStatsAtNotFound(w, "PSK", at, pskAtSearchWindow)
		return
	}

	sw := data.SoftwareInUse
	if sw == nil {
		sw = map[string][]PSKSoftwareEntry{}
	}
	// filterPSKByBand matches keys exactly, so resolve the requested band
	// against the keys this snapshot actually carries ("20M" → "20m").
	applyFilters := func(src PSKMonitorsByBand) PSKMonitorsByBandEnriched {
		return enrichWithSoftware(filterPSKByBand(src, resolvePSKBandKey(src, band)), sw)
	}

	// PSK snapshots hold only the top handful of monitors per band, so unlike
	// the WSPR and RBN endpoints there is nothing here worth a ?limit=.
	out := pskAtResponse{
		statsAtCommon: newStatsAtCommon(at, data.FetchedAt, pskAtSearchWindow, 0),
		FetchedAt:     formatStatsAtTime(data.FetchedAt),
		Band:          band,
		UberSDRCount:  countUberSDRReporters(sw),
		Error:         data.Error,
	}
	if table == "all" || table == "reports" {
		out.ReportResult = applyFilters(data.ReportResult)
	}
	if table == "all" || table == "countries" {
		out.CountryResult = applyFilters(data.CountryResult)
	}

	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Printf("[StatsPSK] encode at-response error: %v", err)
	}
}

// pskHistorySnapshot is one entry in the history response.
type pskHistorySnapshot struct {
	FetchedAt string `json:"fetched_at"`

	// Full leaderboard data — omitted when callsign filter is active.
	ReportResult  PSKMonitorsByBand `json:"report_result,omitempty"`
	CountryResult PSKMonitorsByBand `json:"country_result,omitempty"`

	// Callsign-filtered rank data — only present when callsign filter is active.
	CallsignRank *PSKCallsignRank `json:"callsign_rank,omitempty"`

	// Second callsign's rank data — only present when callsign2 is set and that
	// station appears in this snapshot.
	CallsignRank2 *PSKCallsignRank `json:"callsign_rank2,omitempty"`
}

// pskRankFor returns the rank data for callsign in data, or nil when the
// callsign appears in neither leaderboard.
func pskRankFor(data PSKRankData, callsign string) *PSKCallsignRank {
	if callsign == "" {
		return nil
	}
	upper := strings.ToUpper(callsign)
	reports := computeCallsignRank(data.ReportResult, upper)
	countries := computeCallsignRank(data.CountryResult, upper)
	if len(reports) == 0 && len(countries) == 0 {
		return nil
	}
	return &PSKCallsignRank{Reports: reports, Countries: countries}
}

// handlePSKRankHistory serves GET /api/stats/psk-rank.
func handlePSKRankHistory(w http.ResponseWriter, r *http.Request, sl *StatsLogger, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
		return
	}

	if sl == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "stats logging is not enabled"})
		return
	}

	// Rate limit: 1 request per 2 seconds per IP.
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "stats-psk") {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded — please wait before retrying"})
		log.Printf("[StatsPSK] rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Point-in-time mode takes precedence over the date-range parameters, which
	// it does not use at all.
	if rawAt := strings.TrimSpace(r.URL.Query().Get("at")); rawAt != "" {
		handlePSKRankAt(w, r, sl, rawAt)
		return
	}

	params, errMsg := ParseStatsQueryParams(map[string][]string(r.URL.Query()))
	if errMsg != "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": errMsg})
		return
	}

	records, err := sl.ReadPSK(params)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	snapshots := make([]pskHistorySnapshot, 0, len(records))
	for _, data := range records {
		snap := pskHistorySnapshot{
			FetchedAt: data.FetchedAt.UTC().Format("2006-01-02T15:04:05Z"),
		}

		if params.Callsign != "" {
			// Callsign filter: compute rank data for one or both stations.
			// The snapshot is kept when either is present, so a comparison
			// keeps its time axis aligned even where one station is missing.
			snap.CallsignRank = pskRankFor(data, params.Callsign)
			snap.CallsignRank2 = pskRankFor(data, params.Callsign2)
			if snap.CallsignRank == nil && snap.CallsignRank2 == nil {
				continue // neither callsign is in this snapshot
			}
		} else {
			snap.ReportResult = data.ReportResult
			snap.CountryResult = data.CountryResult
		}

		snapshots = append(snapshots, snap)
	}

	out := map[string]interface{}{
		"from_date": params.FromDate.Format("2006-01-02"),
		"to_date":   params.ToDate.Format("2006-01-02"),
		"count":     len(snapshots),
		"snapshots": snapshots,
	}
	if params.Callsign != "" {
		out["callsign"] = params.Callsign
	}
	if params.Callsign2 != "" {
		out["callsign2"] = params.Callsign2
	}

	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Printf("[StatsPSK] encode error: %v", err)
	}
}
