package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
)

// stats_rbn_history.go — public GET /api/stats/rbn history endpoint.
//
// Returns a time-series of daily RBN snapshots (skew + statistics) from the
// on-disk JSONL store.  Supports fixed period shorthands and explicit date
// ranges, with an optional callsign filter.
//
// Query parameters:
//
//	period    — "24h" | "7d" | "30d"
//	from_date — YYYY-MM-DD  (alternative to period)
//	to_date   — YYYY-MM-DD  (defaults to from_date; ignored when period is set)
//	callsign  — case-insensitive; when set, only the matching skew/stats entry
//	            is returned per snapshot (full arrays are omitted) and snapshots
//	            where the callsign is not found are skipped.
//
// Maximum range: 30 days per request.
// Authentication: none (public endpoint).
// Rate limiting: shared FFTRateLimiter.

// rbnHistorySnapshot is one day's entry in the history response.
type rbnHistorySnapshot struct {
	FetchedAt     string `json:"fetched_at"`
	SourceComment string `json:"source_comment,omitempty"`

	// Full entry arrays — omitted when callsign filter is active.
	SkewEntries  []RBNSkewEntry       `json:"skew_entries,omitempty"`
	StatsEntries []RBNStatisticsEntry `json:"stats_entries,omitempty"`

	// Callsign-filtered data — only present when callsign filter is active.
	CallsignData *rbnCallsignSnapshot `json:"callsign_data,omitempty"`
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
			upper := strings.ToUpper(params.Callsign)
			cd := &rbnCallsignSnapshot{}
			found := false

			// Find skew entry for this callsign.
			for _, e := range rec.SkewEntries {
				if strings.ToUpper(e.Callsign) == upper {
					entry := e
					cd.Skew = &entry
					found = true
					break
				}
			}

			// Find statistics entry and compute rank.
			for _, e := range rec.StatsEntries {
				if strings.ToUpper(e.Callsign) == upper {
					entry := e
					cd.Statistics = &entry
					found = true
					break
				}
			}
			if len(rec.StatsEntries) > 0 {
				cd.StatsRank, cd.StatsTotalSkimmers = computeRBNCallsignRank(rec.StatsEntries, params.Callsign)
			}

			if !found {
				continue // callsign not in this snapshot
			}
			snap.CallsignData = cd
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

	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Printf("[StatsRBN] encode error: %v", err)
	}
}
