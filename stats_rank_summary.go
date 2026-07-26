package main

// stats_rank_summary.go — public GET /api/stats/rank-summary.
//
// One small response holding this receiver's current standing in every
// leaderboard it tracks: PSK Reporter (by reports and by countries), WSPR Live
// (all three windows), and the Reverse Beacon Network (by spot count).
//
// It is served entirely from the in-memory caches the background fetchers keep
// up to date — no database query, no outbound request — so it is cheap enough
// to poll. That also means it reports the leaderboards as of each component's
// last fetch, not as of the request: every section carries its own timestamp.
//
// For the history behind these numbers, see /api/stats/psk-rank,
// /api/stats/wspr-rank and /api/stats/rbn, which read the persisted snapshots.

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// RankPosition is one station's standing in one leaderboard.
type RankPosition struct {
	// Rank is 1-based. 0 means the station does not appear in this leaderboard
	// (no reports in the window, or the dataset has not been fetched yet).
	Rank int `json:"rank"`
	// Value is the metric the rank is based on — see the parent field's docs.
	Value int `json:"value"`
	// Total is how many stations are in the leaderboard, giving Rank a scale.
	Total int `json:"total"`
}

// PSKRankSummary is this receiver's standing on PSK Reporter over 24 hours.
type PSKRankSummary struct {
	// Available is false when PSK Reporter ranking is disabled or has not
	// fetched yet; the positions below are then zero.
	Available bool       `json:"available"`
	FetchedAt *time.Time `json:"fetched_at,omitempty"`
	// Error carries the last fetch error, if the cached result holds one.
	Error string `json:"error,omitempty"`
	// Reports ranks by number of spots reported (the "All" band table).
	Reports RankPosition `json:"reports"`
	// Countries ranks by distinct countries heard (the "All" band table).
	Countries RankPosition `json:"countries"`
}

// WSPRRankSummary is this receiver's standing on WSPR Live, by unique spots,
// in each of the three windows WSPR Live publishes.
type WSPRRankSummary struct {
	Available   bool         `json:"available"`
	GeneratedAt *time.Time   `json:"generated_at,omitempty"`
	Rolling24h  RankPosition `json:"rolling_24h"`
	Yesterday   RankPosition `json:"yesterday"`
	Today       RankPosition `json:"today"`
}

// RBNRankSummary is this receiver's standing among RBN skimmers. RBN publishes
// no rank of its own, so this is derived from the cumulative spot counts in
// statistics.csv and precomputed when that file is fetched.
type RBNRankSummary struct {
	Available bool       `json:"available"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
	// Spots ranks by cumulative spot count.
	Spots RankPosition `json:"spots"`
}

// RankSummaryResponse is the body of GET /api/stats/rank-summary.
type RankSummaryResponse struct {
	GeneratedAt time.Time `json:"generated_at"`
	// ReceiverCallsign is the callsign PSK and WSPR are looked up under.
	ReceiverCallsign string `json:"receiver_callsign,omitempty"`
	// CWSkimmerCallsign is the callsign RBN is looked up under — often the same
	// station but a different callsign (e.g. a -1 suffix).
	CWSkimmerCallsign string          `json:"cw_skimmer_callsign,omitempty"`
	PSK               PSKRankSummary  `json:"psk"`
	WSPR              WSPRRankSummary `json:"wspr"`
	RBN               RBNRankSummary  `json:"rbn"`
}

// ─── Shared rank extraction ───────────────────────────────────────────────────
// These are the single source of truth for "where does this callsign sit in
// this leaderboard". The digital_rank notifier uses them too, so a summary and
// a notification can never disagree.

// pskRankIn returns the station's position in one PSK Reporter table
// (reportResult or countryResult), using the combined "All" band entry.
func pskRankIn(src PSKMonitorsByBand, callsign string) RankPosition {
	entries, ok := src["All"]
	if !ok {
		return RankPosition{}
	}
	pos := RankPosition{Total: len(entries)}
	upper := strings.ToUpper(callsign)
	for i, e := range entries {
		if strings.ToUpper(e.Callsign) == upper {
			pos.Rank = i + 1
			pos.Value = e.Day // 24 h count
			break
		}
	}
	return pos
}

// wsprRankIn returns the station's position in one WSPR Live window.
func wsprRankIn(win WSPRRankWindow, callsign string) RankPosition {
	pos := RankPosition{Total: len(win.Data)}
	upper := strings.ToUpper(callsign)
	for i, row := range win.Data {
		if strings.ToUpper(row.RxSign) == upper {
			pos.Rank = i + 1
			pos.Value = int(row.Unique)
			break
		}
	}
	return pos
}

// ─── Summary assembly ─────────────────────────────────────────────────────────

// BuildRankSummary reads the current standing out of the in-memory caches.
// Any fetcher may be nil (that component is disabled), and any callsign may be
// empty (nothing to look up) — the corresponding section is then unavailable.
func BuildRankSummary(psk *PSKRankFetcher, wspr *WSPRRankFetcher, rbn *RBNDataStore,
	receiverCallsign, cwSkimmerCallsign string) RankSummaryResponse {

	resp := RankSummaryResponse{
		GeneratedAt:       time.Now().UTC(),
		ReceiverCallsign:  receiverCallsign,
		CWSkimmerCallsign: cwSkimmerCallsign,
	}

	if psk != nil && receiverCallsign != "" {
		if cached := psk.Cached(); cached != nil {
			fetchedAt := cached.FetchedAt
			resp.PSK = PSKRankSummary{
				Available: cached.Error == "",
				FetchedAt: &fetchedAt,
				Error:     cached.Error,
				Reports:   pskRankIn(cached.ReportResult, receiverCallsign),
				Countries: pskRankIn(cached.CountryResult, receiverCallsign),
			}
		}
	}

	if wspr != nil && receiverCallsign != "" {
		if cached := wspr.Cached(); cached != nil {
			generatedAt := cached.GeneratedAt
			resp.WSPR = WSPRRankSummary{
				Available:   true,
				GeneratedAt: &generatedAt,
				Rolling24h:  wsprRankIn(cached.Rolling24h, receiverCallsign),
				Yesterday:   wsprRankIn(cached.Yesterday, receiverCallsign),
				Today:       wsprRankIn(cached.Today, receiverCallsign),
			}
		}
	}

	if rbn != nil && cwSkimmerCallsign != "" {
		if updatedAt := rbn.StatsUpdatedAt(); updatedAt != nil {
			rank, spots, total := rbn.RankFor(cwSkimmerCallsign)
			resp.RBN = RBNRankSummary{
				Available: true,
				UpdatedAt: updatedAt,
				Spots:     RankPosition{Rank: rank, Value: spots, Total: total},
			}
		}
	}

	return resp
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

// handleRankSummary serves GET /api/stats/rank-summary.
func handleRankSummary(w http.ResponseWriter, r *http.Request,
	psk *PSKRankFetcher, wspr *WSPRRankFetcher, rbn *RBNDataStore,
	receiverCallsign, cwSkimmerCallsign string,
	ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {

	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
		return
	}

	clientIP := getClientIP(r)
	if rateLimiter != nil && !rateLimiter.AllowRequest(clientIP, "stats-rank-summary") {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded — please wait before retrying"})
		log.Printf("[RankSummary] rate limit exceeded for IP: %s", clientIP)
		return
	}

	resp := BuildRankSummary(psk, wspr, rbn, receiverCallsign, cwSkimmerCallsign)

	// Served from memory and refreshed hourly at best — let clients and any
	// intermediary hold it briefly rather than re-asking on every page paint.
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}
