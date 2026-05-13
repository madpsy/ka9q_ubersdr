package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// stats_psk_history.go — public GET /api/stats/psk-rank history endpoint.
//
// Returns a time-series of PSKRankData snapshots from the on-disk JSONL store.
// Supports fixed period shorthands and explicit date ranges, with an optional
// callsign filter.
//
// Query parameters:
//
//	period    — "24h" | "7d" | "30d"
//	from_date — YYYY-MM-DD  (alternative to period)
//	to_date   — YYYY-MM-DD  (defaults to from_date; ignored when period is set)
//	callsign  — case-insensitive; when set, only rank data is returned per
//	            snapshot (full leaderboard arrays are omitted) and snapshots
//	            where the callsign is not found are skipped.
//
// Maximum range: 30 days per request.
// Authentication: none (public endpoint).
// Rate limiting: shared FFTRateLimiter.

// pskHistorySnapshot is one entry in the history response.
type pskHistorySnapshot struct {
	FetchedAt string `json:"fetched_at"`

	// Full leaderboard data — omitted when callsign filter is active.
	ReportResult  PSKMonitorsByBand `json:"report_result,omitempty"`
	CountryResult PSKMonitorsByBand `json:"country_result,omitempty"`

	// Callsign-filtered rank data — only present when callsign filter is active.
	CallsignRank *PSKCallsignRank `json:"callsign_rank,omitempty"`
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
			// Callsign filter: compute rank data; skip snapshots with no match.
			upper := strings.ToUpper(params.Callsign)
			reports := computeCallsignRank(data.ReportResult, upper)
			countries := computeCallsignRank(data.CountryResult, upper)
			if len(reports) == 0 && len(countries) == 0 {
				continue // callsign not in this snapshot
			}
			snap.CallsignRank = &PSKCallsignRank{
				Reports:   reports,
				Countries: countries,
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

	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Printf("[StatsPSK] encode error: %v", err)
	}
}
