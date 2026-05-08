package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// psk_rank.go — PSKReporter top-monitor ranking API
//
// Scrapes https://www.pskreporter.info/cgi-bin/pskstats.pl and extracts the
// two embedded JavaScript variables that power the leaderboard tables:
//
//	reportResult  — "Top Monitors by reports over last 24 hours"
//	               map[band][]{ callsign, day (24h count), week (7-day count) }
//
//	countryResult — "Top Monitors by number of different countries reported"
//	               same shape; day/week are distinct-country counts
//
// Background schedule:
//   - Initial fetch 5 minutes after startup.
//   - Subsequent fetches every hour.
//
// Manual refresh:
//   - GET /admin/psk-rank?refresh=1 triggers an immediate synchronous fetch.
//   - Rate-limited to once per minute; returns HTTP 429 if called too soon.
//
// Query parameters for GET /admin/psk-rank:
//
//	?table=<value>   — which leaderboard table to return.
//	                   Accepted: reports | countries | all (default: all)
//
//	?band=<value>    — filter to a single band (e.g. "40m", "20m", "80m").
//	                   Omit or use "all" to return all bands.
//
//	?callsign=<cs>   — case-insensitive filter; returns only the entry for
//	                   that callsign across all bands (or the requested band).
//
//	?refresh=1       — trigger an immediate synchronous fetch.

const (
	pskRankFetchTimeout    = 30 * time.Second
	pskRankMaxBodyBytes    = 4 * 1024 * 1024 // 4 MiB — page is ~560 KB
	pskRankStartupDelay    = 5 * time.Minute
	pskRankRefreshInterval = 1 * time.Hour
	pskRankManualRateLimit = 1 * time.Minute

	pskStatsURL = "https://www.pskreporter.info/cgi-bin/pskstats.pl"
)

// regexes to extract the two JS variables from the HTML page.
// Both variables span many lines, so (?s) (dotall) is required.
var (
	reReportResult  = regexp.MustCompile(`(?s)var reportResult = (\{.*?\});`)
	reCountryResult = regexp.MustCompile(`(?s)var countryResult = (\{.*?\});`)
)

// PSKMonitorEntry is one row inside a band's array in reportResult / countryResult.
type PSKMonitorEntry struct {
	Callsign string `json:"callsign"`
	Day      int    `json:"day"`  // last 24 h count (reports or countries)
	Week     int    `json:"week"` // last 7 days count
}

// PSKMonitorsByBand is the top-level shape of reportResult / countryResult:
// a map from band name (e.g. "40m", "20m") to a slice of entries already
// sorted descending by Day.
type PSKMonitorsByBand map[string][]PSKMonitorEntry

// PSKRankData holds the parsed content of one fetch from pskreporter.
type PSKRankData struct {
	FetchedAt     time.Time         `json:"fetched_at"`
	FetchedMs     int64             `json:"fetched_ms"`
	ReportResult  PSKMonitorsByBand `json:"report_result"`  // by report count
	CountryResult PSKMonitorsByBand `json:"country_result"` // by distinct countries
	Error         string            `json:"error,omitempty"`
}

// PSKRankFetcher fetches and caches the PSKReporter leaderboard data.
// It runs a background goroutine that fetches on startup (after a 5-minute
// delay) and then every hour.  Manual refreshes via the API are rate-limited
// to once per minute.
type PSKRankFetcher struct {
	mu              sync.RWMutex
	cached          *PSKRankData
	lastManualFetch time.Time
	stopCh          chan struct{}
	client          *http.Client
}

// NewPSKRankFetcher creates a fetcher.  Call Start() to begin background fetching.
func NewPSKRankFetcher() *PSKRankFetcher {
	return &PSKRankFetcher{
		stopCh: make(chan struct{}),
		client: &http.Client{
			Timeout: pskRankFetchTimeout,
		},
	}
}

// Start launches the background fetch loop and returns immediately.
func (f *PSKRankFetcher) Start() {
	log.Printf("[PSKRank] Starting (initial fetch in %s, then every %s)", pskRankStartupDelay, pskRankRefreshInterval)
	go f.fetchLoop()
}

// Stop signals the background goroutine to exit.
func (f *PSKRankFetcher) Stop() {
	close(f.stopCh)
}

// Cached returns the most recently fetched data, or nil if no fetch has
// completed yet.
func (f *PSKRankFetcher) Cached() *PSKRankData {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.cached
}

// fetchLoop is the background goroutine started by Start.
func (f *PSKRankFetcher) fetchLoop() {
	log.Printf("[PSKRank] Waiting %s before initial fetch", pskRankStartupDelay)
	select {
	case <-f.stopCh:
		log.Println("[PSKRank] Fetcher stopped before initial fetch")
		return
	case <-time.After(pskRankStartupDelay):
	}

	log.Println("[PSKRank] Performing initial fetch")
	f.runFetch()

	ticker := time.NewTicker(pskRankRefreshInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			log.Println("[PSKRank] Running scheduled hourly fetch")
			f.runFetch()
		case <-f.stopCh:
			log.Println("[PSKRank] Fetcher stopped")
			return
		}
	}
}

// runFetch performs a single fetch and stores the result under the write lock.
func (f *PSKRankFetcher) runFetch() {
	data := f.fetch()
	f.mu.Lock()
	f.cached = data
	f.mu.Unlock()
}

// fetch fetches and parses the PSKReporter stats page.
func (f *PSKRankFetcher) fetch() *PSKRankData {
	start := time.Now()
	d := &PSKRankData{FetchedAt: start.UTC()}

	req, err := http.NewRequest(http.MethodGet, pskStatsURL, nil)
	if err != nil {
		d.Error = fmt.Sprintf("build request: %v", err)
		log.Printf("[PSKRank] request build error: %v", err)
		return d
	}
	req.Header.Set("User-Agent", "UberSDR/"+Version+" (psk-rank; https://github.com/ka9q/ubersdr)")
	req.Header.Set("Accept", "text/html")

	resp, err := f.client.Do(req)
	if err != nil {
		d.Error = fmt.Sprintf("http fetch: %v", err)
		log.Printf("[PSKRank] fetch error: %v", err)
		return d
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		d.Error = fmt.Sprintf("upstream HTTP %d", resp.StatusCode)
		log.Printf("[PSKRank] upstream returned HTTP %d", resp.StatusCode)
		return d
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, pskRankMaxBodyBytes))
	if err != nil {
		d.Error = fmt.Sprintf("read body: %v", err)
		log.Printf("[PSKRank] body read error: %v", err)
		return d
	}

	if err := parsePSKStats(body, d); err != nil {
		d.Error = err.Error()
		log.Printf("[PSKRank] parse error: %v", err)
		return d
	}

	d.FetchedMs = time.Since(start).Milliseconds()
	log.Printf("[PSKRank] Fetched OK in %dms — %d bands in reportResult, %d bands in countryResult",
		d.FetchedMs, len(d.ReportResult), len(d.CountryResult))
	return d
}

// parsePSKStats extracts reportResult and countryResult from the HTML page body.
func parsePSKStats(html []byte, d *PSKRankData) error {
	m := reReportResult.FindSubmatch(html)
	if m == nil {
		return fmt.Errorf("reportResult variable not found in page")
	}
	if err := json.Unmarshal(m[1], &d.ReportResult); err != nil {
		return fmt.Errorf("parse reportResult JSON: %w", err)
	}

	m2 := reCountryResult.FindSubmatch(html)
	if m2 == nil {
		return fmt.Errorf("countryResult variable not found in page")
	}
	if err := json.Unmarshal(m2[1], &d.CountryResult); err != nil {
		return fmt.Errorf("parse countryResult JSON: %w", err)
	}

	return nil
}

// filterPSKByBand returns a copy of src containing only the requested band.
// If band is empty or "all", src is returned unchanged.
func filterPSKByBand(src PSKMonitorsByBand, band string) PSKMonitorsByBand {
	if band == "" || band == "all" {
		return src
	}
	entries, ok := src[band]
	if !ok {
		return PSKMonitorsByBand{}
	}
	return PSKMonitorsByBand{band: entries}
}

// filterPSKByCallsign returns a copy of src containing only entries whose
// callsign matches cs (case-insensitive).  Bands with no match are omitted.
func filterPSKByCallsign(src PSKMonitorsByBand, cs string) PSKMonitorsByBand {
	if cs == "" {
		return src
	}
	upper := strings.ToUpper(strings.TrimSpace(cs))
	out := make(PSKMonitorsByBand)
	for band, entries := range src {
		for _, e := range entries {
			if strings.ToUpper(e.Callsign) == upper {
				out[band] = []PSKMonitorEntry{e}
				break
			}
		}
	}
	return out
}

// HandlePSKRank is the admin API handler for GET /admin/psk-rank.
//
// Query params:
//
//	?table=<value>   — reports | countries | all (default: all)
//	?band=<value>    — single band name, or "all" (default: all)
//	?callsign=<cs>   — case-insensitive callsign filter
//	?refresh=1       — trigger immediate synchronous fetch (rate-limited 1/min)
func (ah *AdminHandler) HandlePSKRank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if ah.pskRank == nil {
		http.Error(w, `{"error":"PSK rank fetcher not initialised"}`, http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query()

	// Validate ?table= parameter.
	table := q.Get("table")
	if table == "" {
		table = "all"
	}
	validTables := map[string]bool{
		"all":       true,
		"reports":   true,
		"countries": true,
	}
	if !validTables[table] {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "invalid table parameter; accepted values: all, reports, countries",
		})
		return
	}

	// ?band= — optional single-band filter.
	band := strings.TrimSpace(q.Get("band"))

	// ?callsign= — optional callsign filter.
	callsign := strings.TrimSpace(q.Get("callsign"))

	// Handle ?refresh=1 — rate-limited manual fetch.
	if q.Get("refresh") == "1" {
		ah.pskRank.mu.Lock()
		since := time.Since(ah.pskRank.lastManualFetch)
		if since < pskRankManualRateLimit {
			remaining := pskRankManualRateLimit - since
			ah.pskRank.mu.Unlock()
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"error":            "rate limited — manual refresh is allowed at most once per minute",
				"retry_after_secs": int(remaining.Seconds()) + 1,
			})
			return
		}
		ah.pskRank.lastManualFetch = time.Now()
		ah.pskRank.mu.Unlock()

		log.Println("[PSKRank] Manual refresh triggered via admin API")
		ah.pskRank.runFetch()
	}

	cached := ah.pskRank.Cached()
	if cached == nil {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status": "pending",
			"note":   "initial fetch not yet complete; data will be available after the 5-minute startup delay",
		})
		return
	}

	// Apply band + callsign filters to the requested table(s).
	applyFilters := func(src PSKMonitorsByBand) PSKMonitorsByBand {
		out := filterPSKByBand(src, band)
		out = filterPSKByCallsign(out, callsign)
		return out
	}

	type pskRankResponse struct {
		FetchedAt     time.Time         `json:"fetched_at"`
		FetchedMs     int64             `json:"fetched_ms"`
		ReportResult  PSKMonitorsByBand `json:"report_result,omitempty"`
		CountryResult PSKMonitorsByBand `json:"country_result,omitempty"`
		Error         string            `json:"error,omitempty"`
	}

	out := pskRankResponse{
		FetchedAt: cached.FetchedAt,
		FetchedMs: cached.FetchedMs,
		Error:     cached.Error,
	}

	switch table {
	case "reports":
		out.ReportResult = applyFilters(cached.ReportResult)
	case "countries":
		out.CountryResult = applyFilters(cached.CountryResult)
	default: // "all"
		out.ReportResult = applyFilters(cached.ReportResult)
		out.CountryResult = applyFilters(cached.CountryResult)
	}

	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Printf("[PSKRank] encode response error: %v", err)
	}
}
