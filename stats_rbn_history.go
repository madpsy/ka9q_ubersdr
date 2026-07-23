package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sort"
	"strings"
)

// stats_rbn_history.go — public GET /api/stats/rbn history endpoint.
//
// Two mutually exclusive modes:
//
// 1. History (default) — a time-series of daily RBN snapshots (skew +
//    statistics) over a date range, with an optional callsign filter.
//
// 2. Point-in-time (?at=…) — the full skimmer list as it stood on the day
//    nearest a given instant. RBN is fetched once per UTC day, so the match is
//    day-grained; the response reports the drift.
//
// Query parameters — history mode:
//
//	period    — "24h" | "7d" | "30d"
//	from_date — YYYY-MM-DD  (alternative to period)
//	to_date   — YYYY-MM-DD  (defaults to from_date; ignored when period is set)
//	callsign  — case-insensitive; when set, only the matching skew/stats entry
//	            is returned per snapshot (full arrays are omitted) and snapshots
//	            where the callsign is not found are skipped.
//	callsign2 — optional second station to compare against callsign. Its data is
//	            returned alongside as callsign_data2, and a snapshot is kept
//	            when either station appears in it.
//
// Query parameters — point-in-time mode (see stats_at.go):
//
//	at        — the instant of interest, UTC. The day snapshot nearest that
//	            time (within ±rbnAtSearchWindow) is returned with its drift.
//	limit     — entries per list, 1…1000 (default 100)
//	callsign  — rejected; the response is the whole skimmer list by definition.
//
// Maximum range: 30 days per request (history mode).
// Authentication: none (public endpoint).
// Rate limiting: shared FFTRateLimiter.

// ── Point-in-time (?at=) ──────────────────────────────────────────────────

// rbnAtResponse is the point-in-time (?at=) response body.
//
// Both entry lists are returned in ranked order rather than the source's CSV
// order: statistics by spot count descending (which is the leaderboard), skew
// by absolute skew descending (the worst offenders first), matching how the
// stats page charts them.
type rbnAtResponse struct {
	statsAtCommon
	FetchedAt     string `json:"fetched_at"`
	SourceComment string `json:"source_comment,omitempty"`

	SkewEntries  []RBNSkewEntry       `json:"skew_entries"`
	StatsEntries []RBNStatisticsEntry `json:"stats_entries"`

	TotalSkewEntries  int `json:"total_skew_entries"`  // before the limit
	TotalStatsEntries int `json:"total_stats_entries"` // before the limit
}

// sortRBNStatsByCount returns entries sorted by spot count descending, ties
// broken by callsign so the ranking is stable across requests.
func sortRBNStatsByCount(entries []RBNStatisticsEntry) []RBNStatisticsEntry {
	out := make([]RBNStatisticsEntry, len(entries))
	copy(out, entries)
	sort.Slice(out, func(i, j int) bool {
		if out[i].SpotCount != out[j].SpotCount {
			return out[i].SpotCount > out[j].SpotCount
		}
		return out[i].Callsign < out[j].Callsign
	})
	return out
}

// sortRBNSkewByMagnitude returns entries sorted by |skew| descending, ties
// broken by callsign.
func sortRBNSkewByMagnitude(entries []RBNSkewEntry) []RBNSkewEntry {
	out := make([]RBNSkewEntry, len(entries))
	copy(out, entries)
	sort.Slice(out, func(i, j int) bool {
		ai, aj := math.Abs(out[i].Skew), math.Abs(out[j].Skew)
		if ai != aj {
			return ai > aj
		}
		return out[i].Callsign < out[j].Callsign
	})
	return out
}

// handleRBNAt serves the ?at= point-in-time branch of GET /api/stats/rbn.
// The caller has already handled bans, rate limiting and the nil-sl check.
//
// RBN is fetched once per UTC day, so this is day-grained: the response always
// reports offset_seconds so the caller can see how far the matched snapshot
// sits from the requested instant. A day holds a few hundred skimmers, capped
// by ?limit= (default 100, max 1000).
func handleRBNAt(w http.ResponseWriter, r *http.Request, sl *StatsLogger, rawAt string) {
	if rejectCallsignWithAt(w, r) {
		return
	}

	at, errMsg := parseStatsAtParam(rawAt)
	if errMsg != "" {
		writeStatsError(w, http.StatusBadRequest, errMsg)
		return
	}

	limit, errMsg := parseStatsAtLimit(strings.TrimSpace(r.URL.Query().Get("limit")))
	if errMsg != "" {
		writeStatsError(w, http.StatusBadRequest, errMsg)
		return
	}

	rec, err := sl.ReadRBNAt(at, rbnAtSearchWindow)
	if err != nil {
		writeStatsError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if rec == nil {
		writeStatsAtNotFound(w, "RBN", at, rbnAtSearchWindow)
		return
	}

	skew, totalSkew := truncateAt(sortRBNSkewByMagnitude(rec.SkewEntries), limit)
	stats, totalStats := truncateAt(sortRBNStatsByCount(rec.StatsEntries), limit)

	out := rbnAtResponse{
		statsAtCommon:     newStatsAtCommon(at, rec.FetchedAt, rbnAtSearchWindow, limit),
		FetchedAt:         formatStatsAtTime(rec.FetchedAt),
		SourceComment:     rec.SourceComment,
		SkewEntries:       skew,
		StatsEntries:      stats,
		TotalSkewEntries:  totalSkew,
		TotalStatsEntries: totalStats,
	}

	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Printf("[StatsRBN] encode at-response error: %v", err)
	}
}

// rbnHistorySnapshot is one day's entry in the history response.
type rbnHistorySnapshot struct {
	FetchedAt     string `json:"fetched_at"`
	SourceComment string `json:"source_comment,omitempty"`

	// Full entry arrays — omitted when callsign filter is active.
	SkewEntries  []RBNSkewEntry       `json:"skew_entries,omitempty"`
	StatsEntries []RBNStatisticsEntry `json:"stats_entries,omitempty"`

	// Callsign-filtered data — only present when callsign filter is active.
	CallsignData *rbnCallsignSnapshot `json:"callsign_data,omitempty"`

	// Second callsign's data — only present when callsign2 is set and that
	// station appears in this snapshot.
	CallsignData2 *rbnCallsignSnapshot `json:"callsign_data2,omitempty"`
}

// rbnCallsignDataFor extracts one callsign's skew and statistics from a day
// record, together with its rank by spot count. Returns nil when the callsign
// appears in neither list.
func rbnCallsignDataFor(rec RBNHistoryRecord, callsign string) *rbnCallsignSnapshot {
	if callsign == "" {
		return nil
	}
	upper := strings.ToUpper(callsign)
	cd := &rbnCallsignSnapshot{}
	found := false

	for _, e := range rec.SkewEntries {
		if strings.ToUpper(e.Callsign) == upper {
			entry := e
			cd.Skew = &entry
			found = true
			break
		}
	}
	for _, e := range rec.StatsEntries {
		if strings.ToUpper(e.Callsign) == upper {
			entry := e
			cd.Statistics = &entry
			found = true
			break
		}
	}
	if !found {
		return nil
	}
	if len(rec.StatsEntries) > 0 {
		cd.StatsRank, cd.StatsTotalSkimmers = computeRBNCallsignRank(rec.StatsEntries, callsign)
	}
	return cd
}

// rbnCallsignSnapshot holds the skew and statistics for a single callsign on
// one day, together with the callsign's rank by spot count.
type rbnCallsignSnapshot struct {
	Skew               *RBNSkewEntry       `json:"skew,omitempty"`
	Statistics         *RBNStatisticsEntry `json:"statistics,omitempty"`
	StatsRank          int                 `json:"stats_rank,omitempty"` // 1-based rank by spot_count; 0 = not ranked
	StatsTotalSkimmers int                 `json:"stats_total_skimmers,omitempty"`
}

// computeRBNCallsignRank returns the 1-based rank of callsign in entries
// sorted descending by SpotCount (stable by callsign for ties).
// Returns 0 if callsign is not found.
func computeRBNCallsignRank(entries []RBNStatisticsEntry, callsign string) (rank, total int) {
	if len(entries) == 0 {
		return 0, 0
	}
	sorted := make([]RBNStatisticsEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].SpotCount != sorted[j].SpotCount {
			return sorted[i].SpotCount > sorted[j].SpotCount
		}
		return sorted[i].Callsign < sorted[j].Callsign
	})
	upper := strings.ToUpper(callsign)
	for i, e := range sorted {
		if strings.ToUpper(e.Callsign) == upper {
			return i + 1, len(sorted)
		}
	}
	return 0, len(sorted)
}

// handleRBNHistory serves GET /api/stats/rbn.
func handleRBNHistory(w http.ResponseWriter, r *http.Request, sl *StatsLogger, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
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
	if !rateLimiter.AllowRequest(clientIP, "stats-rbn") {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded — please wait before retrying"})
		log.Printf("[StatsRBN] rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Point-in-time mode takes precedence over the date-range parameters, which
	// it does not use at all.
	if rawAt := strings.TrimSpace(r.URL.Query().Get("at")); rawAt != "" {
		handleRBNAt(w, r, sl, rawAt)
		return
	}

	params, errMsg := ParseStatsQueryParams(map[string][]string(r.URL.Query()))
	if errMsg != "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": errMsg})
		return
	}

	records, err := sl.ReadRBN(params)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	snapshots := make([]rbnHistorySnapshot, 0, len(records))
	for _, rec := range records {
		snap := rbnHistorySnapshot{
			FetchedAt:     rec.FetchedAt.UTC().Format("2006-01-02T15:04:05Z"),
			SourceComment: rec.SourceComment,
		}

		if params.Callsign != "" {
			// Keep the snapshot when either station appears in it, so a
			// comparison keeps its time axis aligned even on days where one
			// of the two was absent.
			snap.CallsignData = rbnCallsignDataFor(rec, params.Callsign)
			snap.CallsignData2 = rbnCallsignDataFor(rec, params.Callsign2)
			if snap.CallsignData == nil && snap.CallsignData2 == nil {
				continue // neither callsign is in this snapshot
			}
		} else {
			snap.SkewEntries = rec.SkewEntries
			snap.StatsEntries = rec.StatsEntries
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
		log.Printf("[StatsRBN] encode error: %v", err)
	}
}
