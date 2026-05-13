package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// stats_wspr_history.go — public GET /api/stats/wspr-rank history endpoint.
//
// Returns a time-series of WSPRRankResponse snapshots from the on-disk JSONL
// store.  Supports fixed period shorthands and explicit date ranges, with an
// optional callsign filter.
//
// Query parameters:
//
//	period    — "24h" | "7d" | "30d"
//	from_date — YYYY-MM-DD  (alternative to period)
//	to_date   — YYYY-MM-DD  (defaults to from_date; ignored when period is set)
//	callsign  — case-insensitive; when set, only rank data is returned per
//	            snapshot (full data arrays are omitted) and snapshots where
//	            the callsign is not found are skipped.
//
// Maximum range: 30 days per request.
// Authentication: none (public endpoint).
// Rate limiting: shared FFTRateLimiter (same as decoder spots).

// wsprHistorySnapshot is one entry in the history response.
// When callsign is set, only the rank fields are populated.
type wsprHistorySnapshot struct {
	GeneratedAt string `json:"generated_at"`

	// Full window data — omitted when callsign filter is active.
	Rolling24h *WSPRRankWindow `json:"rolling_24h,omitempty"`
	Yesterday  *WSPRRankWindow `json:"yesterday,omitempty"`
	Today      *WSPRRankWindow `json:"today,omitempty"`

	// Callsign-filtered rank data — only present when callsign filter is active.
	CallsignRank *wsprCallsignRank `json:"callsign_rank,omitempty"`
}

// wsprCallsignRank holds the rank of a single callsign across the three windows.
type wsprCallsignRank struct {
	Rolling24h *wsprWindowRank `json:"rolling_24h,omitempty"`
	Yesterday  *wsprWindowRank `json:"yesterday,omitempty"`
	Today      *wsprWindowRank `json:"today,omitempty"`
}

// wsprWindowRank is the rank of a callsign within one time window.
type wsprWindowRank struct {
	Rank   int    `json:"rank"`
	Unique uint64 `json:"unique"`
	Raw    uint64 `json:"raw"`
}

// extractWSPRWindowRank finds callsign in win.Data and returns its rank, or nil.
func extractWSPRWindowRank(win WSPRRankWindow, callsign string) *wsprWindowRank {
	upper := strings.ToUpper(callsign)
	for i, row := range win.Data {
		if strings.ToUpper(row.RxSign) == upper {
			return &wsprWindowRank{
				Rank:   i + 1,
				Unique: row.Unique,
				Raw:    row.Raw,
			}
		}
	}
	return nil
}

// handleWSPRRankHistory serves GET /api/stats/wspr-rank.
func handleWSPRRankHistory(w http.ResponseWriter, r *http.Request, sl *StatsLogger, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
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

	// Rate limit: 1 request per 2 seconds per IP (shared key prefix).
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "stats-wspr") {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded — please wait before retrying"})
		log.Printf("[StatsWSPR] rate limit exceeded for IP: %s", clientIP)
		return
	}

	params, errMsg := ParseStatsQueryParams(map[string][]string(r.URL.Query()))
	if errMsg != "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": errMsg})
		return
	}

	records, err := sl.ReadWSPR(params)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	snapshots := make([]wsprHistorySnapshot, 0, len(records))
	for _, resp := range records {
		snap := wsprHistorySnapshot{
			GeneratedAt: resp.GeneratedAt.UTC().Format("2006-01-02T15:04:05Z"),
		}

		if params.Callsign != "" {
			// Callsign filter: return only rank data; skip snapshots with no match.
			cr := &wsprCallsignRank{
				Rolling24h: extractWSPRWindowRank(resp.Rolling24h, params.Callsign),
				Yesterday:  extractWSPRWindowRank(resp.Yesterday, params.Callsign),
				Today:      extractWSPRWindowRank(resp.Today, params.Callsign),
			}
			if cr.Rolling24h == nil && cr.Yesterday == nil && cr.Today == nil {
				continue // callsign not in this snapshot
			}
			snap.CallsignRank = cr
		} else {
			// No filter: return full window data.
			r24 := resp.Rolling24h
			yest := resp.Yesterday
			tod := resp.Today
			snap.Rolling24h = &r24
			snap.Yesterday = &yest
			snap.Today = &tod
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
		log.Printf("[StatsWSPR] encode error: %v", err)
	}
}
