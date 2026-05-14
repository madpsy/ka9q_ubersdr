package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// wspr_rank.go — WSPR Live receiver ranking API
//
// Fetches three time-window datasets from db1.wspr.live and exposes them
// via the admin-only endpoint GET /admin/wspr-rank.
//
// Background schedule:
//   - Initial fetch 5 minutes after startup (avoids hammering upstream on
//     rapid restart loops).
//   - Subsequent fetches every hour thereafter.
//
// Manual refresh:
//   - GET /admin/wspr-rank?refresh=1 triggers an immediate synchronous fetch.
//   - Rate-limited to once per minute; returns HTTP 429 if called too soon.
//
// Time windows returned:
//   - rolling_24h : last 24 hours to now
//   - yesterday   : midnight-to-midnight UTC yesterday
//   - today       : midnight UTC today to now

const (
	wsprRankFetchTimeout    = 30 * time.Second
	wsprRankMaxBodyBytes    = 10 * 1024 * 1024 // 10 MiB
	wsprRankStartupDelay    = 5 * time.Minute
	wsprRankRefreshInterval = 1 * time.Hour
	wsprRankManualRateLimit = 1 * time.Minute

	// db1.wspr.live query URLs (JSONCompact format)
	wsprRankURLRolling24h = "https://db1.wspr.live/?query=%20SELECT%20rx_sign%2C%20rx_loc%2C%20arraySum(gross)%20as%20raw%2C%20arraySum(dupes)%20as%20dupe%2C%20arraySum(uniques)%20as%20unique%2C%20groupArray(band)%20as%20bands%2C%20groupArray(uniques)%20as%20uniques%2C%20groupArray(gross)%20as%20gross%2C%20groupArray(dupes)%20as%20dupes%20FROM%20(%20SELECT%20rx_sign%2C%20rx_loc%2C%20band%2C%20count()%20as%20gross%2C%20count(distinct%20tx_sign)%20as%20uniques%20FROM%20wspr.rx%20WHERE%20time%20between%20subtractHours(now()%2C%2024)%20and%20now()%20and%20match(tx_sign%2C%27%5E%5BQ01%5D%27)%3D0%20GROUP%20BY%20rx_loc%2C%20rx_sign%2C%20band%20)%20AS%20a%20LEFT%20JOIN%20(%20SELECT%20rx_sign%2C%20band%2C%20sum(cnt)%20as%20dupes%20FROM%20(%20SELECT%20rx_sign%2C%20band%2C%20count()%20as%20cnt%20FROM%20wspr.rx%20WHERE%20time%20between%20subtractHours(now()%2C%2024)%20and%20now()%20GROUP%20BY%20time%2C%20band%2C%20rx_sign%2C%20tx_sign%20HAVING%20cnt%20%3E%201%20)%20GROUP%20BY%20rx_sign%2C%20band%20)%20AS%20b%20USING%20(rx_sign%2C%20band)%20group%20by%20rx_loc%2C%20rx_sign%20ORDER%20BY%20unique%20DESC%20LIMIT%20200%20format%20JSONCompact"
	wsprRankURLYesterday  = "https://db1.wspr.live/?query=%20SELECT%20rx_sign%2C%20rx_loc%2C%20arraySum(gross)%20as%20raw%2C%20arraySum(dupes)%20as%20dupe%2C%20arraySum(uniques)%20as%20unique%2C%20groupArray(band)%20as%20bands%2C%20groupArray(uniques)%20as%20uniques%2C%20groupArray(gross)%20as%20gross%2C%20groupArray(dupes)%20as%20dupes%20FROM%20(%20SELECT%20rx_sign%2C%20rx_loc%2C%20band%2C%20count()%20as%20gross%2C%20count(distinct%20tx_sign)%20as%20uniques%20FROM%20wspr.rx%20WHERE%20time%20between%20toStartOfDay%20(yesterday())%20and%20toStartOfDay%20(today())%20and%20match(tx_sign%2C%27%5E%5BQ01%5D%27)%3D0%20GROUP%20BY%20rx_loc%2C%20rx_sign%2C%20band%20)%20AS%20a%20LEFT%20JOIN%20(%20SELECT%20rx_sign%2C%20band%2C%20sum(cnt)%20as%20dupes%20FROM%20(%20SELECT%20rx_sign%2C%20band%2C%20count()%20as%20cnt%20FROM%20wspr.rx%20WHERE%20time%20between%20toStartOfDay%20(yesterday())%20and%20toStartOfDay%20(today())%20GROUP%20BY%20time%2C%20band%2C%20rx_sign%2C%20tx_sign%20HAVING%20cnt%20%3E%201%20)%20GROUP%20BY%20rx_sign%2C%20band%20)%20AS%20b%20USING%20(rx_sign%2C%20band)%20group%20by%20rx_loc%2C%20rx_sign%20ORDER%20BY%20unique%20DESC%20LIMIT%20200%20format%20JSONCompact"
	wsprRankURLToday      = "https://db1.wspr.live/?query=%20SELECT%20rx_sign%2C%20rx_loc%2C%20arraySum(gross)%20as%20raw%2C%20arraySum(dupes)%20as%20dupe%2C%20arraySum(uniques)%20as%20unique%2C%20groupArray(band)%20as%20bands%2C%20groupArray(uniques)%20as%20uniques%2C%20groupArray(gross)%20as%20gross%2C%20groupArray(dupes)%20as%20dupes%20FROM%20(%20SELECT%20rx_sign%2C%20rx_loc%2C%20band%2C%20count()%20as%20gross%2C%20count(distinct%20tx_sign)%20as%20uniques%20FROM%20wspr.rx%20WHERE%20time%20between%20toStartOfDay%20(today())%20and%20now()%20and%20match(tx_sign%2C%27%5E%5BQ01%5D%27)%3D0%20GROUP%20BY%20rx_loc%2C%20rx_sign%2C%20band%20)%20AS%20a%20LEFT%20JOIN%20(%20SELECT%20rx_sign%2C%20band%2C%20sum(cnt)%20as%20dupes%20FROM%20(%20SELECT%20rx_sign%2C%20band%2C%20count()%20as%20cnt%20FROM%20wspr.rx%20WHERE%20time%20between%20toStartOfDay%20(today())%20and%20now()%20GROUP%20BY%20time%2C%20band%2C%20rx_sign%2C%20tx_sign%20HAVING%20cnt%20%3E%201%20)%20GROUP%20BY%20rx_sign%2C%20band%20)%20AS%20b%20USING%20(rx_sign%2C%20band)%20group%20by%20rx_loc%2C%20rx_sign%20ORDER%20BY%20unique%20DESC%20LIMIT%20200%20format%20JSONCompact"
)

// WSPRRankRow is one receiver entry returned by the WSPR Live query.
// The JSONCompact response has a "data" array of arrays; each inner array
// maps to the column order: rx_sign, rx_loc, raw, dupe, unique, bands,
// uniques, gross, dupes.
//
// bands is Array(Int16) — integer metres (e.g. 20, 40, 80).
// raw/dupe/unique and the per-band arrays are UInt64.
type WSPRRankRow struct {
	RxSign       string   `json:"rx_sign"`
	RxLoc        string   `json:"rx_loc"`
	Raw          uint64   `json:"raw"`
	Dupe         uint64   `json:"dupe"`
	Unique       uint64   `json:"unique"`
	Bands        []int16  `json:"bands"`
	Uniques      []uint64 `json:"uniques"`
	Gross        []uint64 `json:"gross"`
	Dupes        []uint64 `json:"dupes"`
	OriginalRank int      `json:"original_rank,omitempty"` // set when row is extracted from a filtered subset; 0 = use position
}

// wsprBandOrder defines the canonical column order for the formatted table,
// matching the wspr.live leaderboard display.
// Key: integer metres value from the ClickHouse query.
// Value: human-readable band name.
var wsprBandOrder = []struct {
	Metres int16
	Name   string
}{
	{-1, "LF"},
	{0, "MF"},
	{1, "160m"},
	{3, "80m"},
	{5, "60m"},
	{7, "40m"},
	{10, "30m"},
	{13, "22m"},
	{14, "20m"},
	{18, "17m"},
	{21, "15m"},
	{24, "12m"},
	{28, "10m"},
	{50, "6m"},
	{70, "4m"},
	{144, "2m"},
	{432, "70cm"},
	{1296, "23cm"},
}

// WSPRRankTableRow is one row in the formatted leaderboard table.
// BandUniques maps band name → unique count for that band.
type WSPRRankTableRow struct {
	Rank        int               `json:"rank"`
	Reporter    string            `json:"reporter"`
	Locator     string            `json:"locator"`
	Raw         uint64            `json:"raw"`
	Dupes       uint64            `json:"dupes"`
	Unique      uint64            `json:"unique"`
	BandUniques map[string]uint64 `json:"band_uniques"`
}

// WSPRRankTable is the formatted leaderboard for one time window.
type WSPRRankTable struct {
	FetchedAt   time.Time          `json:"fetched_at"`
	FetchedMs   int64              `json:"fetched_ms"`
	Bands       []string           `json:"bands"`  // ordered band names present in this dataset
	Totals      map[string]uint64  `json:"totals"` // band name → total unique count across all rows
	TotalRaw    uint64             `json:"total_raw"`
	TotalDupes  uint64             `json:"total_dupes"`
	TotalUnique uint64             `json:"total_unique"`
	Rows        []WSPRRankTableRow `json:"rows"`
	Error       string             `json:"error,omitempty"`
}

// WSPRRankTableResponse wraps all three formatted windows.
type WSPRRankTableResponse struct {
	GeneratedAt time.Time     `json:"generated_at"`
	Rolling24h  WSPRRankTable `json:"rolling_24h"`
	Yesterday   WSPRRankTable `json:"yesterday"`
	Today       WSPRRankTable `json:"today"`
}

// formatWSPRRankWindow converts a raw WSPRRankWindow into a WSPRRankTable.
func formatWSPRRankWindow(w WSPRRankWindow) WSPRRankTable {
	t := WSPRRankTable{
		FetchedAt: w.FetchedAt,
		FetchedMs: w.FetchedMs,
		Error:     w.Error,
		Totals:    make(map[string]uint64),
	}
	if w.Error != "" || len(w.Data) == 0 {
		return t
	}

	// Determine which bands are actually present across all rows, in canonical order.
	presentBands := make(map[int16]bool)
	for _, row := range w.Data {
		for _, b := range row.Bands {
			presentBands[b] = true
		}
	}
	var orderedBands []struct {
		Metres int16
		Name   string
	}
	for _, bd := range wsprBandOrder {
		if presentBands[bd.Metres] {
			orderedBands = append(orderedBands, bd)
			t.Bands = append(t.Bands, bd.Name)
			t.Totals[bd.Name] = 0
		}
	}

	// Build index: metres → band name for fast lookup.
	metresName := make(map[int16]string, len(orderedBands))
	for _, bd := range orderedBands {
		metresName[bd.Metres] = bd.Name
	}

	for rank, raw := range w.Data {
		effectiveRank := rank + 1
		if raw.OriginalRank > 0 {
			effectiveRank = raw.OriginalRank
		}
		tableRow := WSPRRankTableRow{
			Rank:        effectiveRank,
			Reporter:    raw.RxSign,
			Locator:     raw.RxLoc,
			Raw:         raw.Raw,
			Dupes:       raw.Dupe,
			Unique:      raw.Unique,
			BandUniques: make(map[string]uint64, len(raw.Bands)),
		}

		for i, metres := range raw.Bands {
			name, ok := metresName[metres]
			if !ok {
				continue
			}
			var u uint64
			if i < len(raw.Uniques) {
				u = raw.Uniques[i]
			}
			tableRow.BandUniques[name] = u
			t.Totals[name] += u
		}

		t.TotalRaw += raw.Raw
		t.TotalDupes += raw.Dupe
		t.TotalUnique += raw.Unique
		t.Rows = append(t.Rows, tableRow)
	}

	return t
}

// filterWSPRRankWindowByCallsign returns a copy of w containing only the row
// whose RxSign matches callsign (case-insensitive).  The matching row has its
// OriginalRank set to its 1-based position in the full dataset so that
// formatWSPRRankWindow can display the correct rank rather than always "1".
// If no match is found the returned window has an empty Data slice.
func filterWSPRRankWindowByCallsign(w WSPRRankWindow, callsign string) WSPRRankWindow {
	out := WSPRRankWindow{
		FetchedAt: w.FetchedAt,
		FetchedMs: w.FetchedMs,
		Error:     w.Error,
	}
	upper := strings.ToUpper(strings.TrimSpace(callsign))
	for i, row := range w.Data {
		if strings.ToUpper(row.RxSign) == upper {
			row.OriginalRank = i + 1 // 1-based rank in the full dataset
			out.Data = []WSPRRankRow{row}
			out.Rows = 1
			return out
		}
	}
	return out
}

// wsprLiveCompact is the top-level shape of a JSONCompact response from
// db1.wspr.live.  Only the fields we need are decoded; the rest are ignored.
type wsprLiveCompact struct {
	Meta []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"meta"`
	Data            [][]json.RawMessage `json:"data"`
	Rows            int                 `json:"rows"`
	RowsBeforeLimit int                 `json:"rows_before_limit_at_least"`
}

// WSPRRankWindow holds the parsed rows for one time window plus fetch metadata.
type WSPRRankWindow struct {
	FetchedAt time.Time     `json:"fetched_at"`
	FetchedMs int64         `json:"fetched_ms"` // round-trip duration in milliseconds
	Rows      int           `json:"rows"`
	Data      []WSPRRankRow `json:"data"`
	Error     string        `json:"error,omitempty"`
}

// WSPRRankResponse is the full response returned by GET /admin/wspr-rank.
type WSPRRankResponse struct {
	GeneratedAt time.Time      `json:"generated_at"`
	Rolling24h  WSPRRankWindow `json:"rolling_24h"`
	Yesterday   WSPRRankWindow `json:"yesterday"`
	Today       WSPRRankWindow `json:"today"`
}

// WSPRRankFetcher fetches and caches the three WSPR Live ranking datasets.
// It runs a background goroutine that fetches on startup (after a 5-minute
// delay) and then every hour.  Manual refreshes via the API are rate-limited
// to once per minute.
type WSPRRankFetcher struct {
	mu              sync.RWMutex
	cached          *WSPRRankResponse
	lastManualFetch time.Time // guards the once-per-minute manual refresh rate limit
	stopCh          chan struct{}
	client          *http.Client
	statsLogger     *StatsLogger   // may be nil
	mqttPublisher   *MQTTPublisher // may be nil
}

// NewWSPRRankFetcher creates a fetcher.  Call Start() to begin background fetching.
func NewWSPRRankFetcher() *WSPRRankFetcher {
	return &WSPRRankFetcher{
		stopCh: make(chan struct{}),
		client: &http.Client{
			Timeout: wsprRankFetchTimeout,
		},
	}
}

// SetStatsLogger attaches a StatsLogger so that every successful fetch is
// persisted to disk and the cache can be seeded from disk on startup.
func (f *WSPRRankFetcher) SetStatsLogger(sl *StatsLogger) {
	f.statsLogger = sl
}

// SetMQTTPublisher attaches an MQTTPublisher so that every successful fetch
// is also published to MQTT.
func (f *WSPRRankFetcher) SetMQTTPublisher(mp *MQTTPublisher) {
	f.mqttPublisher = mp
}

// Start launches the background fetch loop and returns immediately.
// If a StatsLogger is attached, the in-memory cache is seeded from the most
// recent persisted data before the background goroutine begins, so the UI is
// populated immediately rather than waiting for the 5-minute startup delay.
func (f *WSPRRankFetcher) Start() {
	log.Printf("[WSPRRank] Starting (initial fetch in %s, then every %s)", wsprRankStartupDelay, wsprRankRefreshInterval)
	if f.statsLogger != nil {
		if cached := f.statsLogger.LoadLatestWSPR(); cached != nil {
			f.mu.Lock()
			f.cached = cached
			f.mu.Unlock()
		}
	}
	go f.fetchLoop()
}

// Stop signals the background goroutine to exit.
func (f *WSPRRankFetcher) Stop() {
	close(f.stopCh)
}

// fetchLoop is the background goroutine started by Start.
func (f *WSPRRankFetcher) fetchLoop() {
	// 5-minute startup delay — abortable if Stop() is called.
	log.Printf("[WSPRRank] Waiting %s before initial fetch", wsprRankStartupDelay)
	select {
	case <-f.stopCh:
		log.Println("[WSPRRank] Fetcher stopped before initial fetch")
		return
	case <-time.After(wsprRankStartupDelay):
	}

	log.Println("[WSPRRank] Performing initial fetch")
	f.runFetch()

	ticker := time.NewTicker(wsprRankRefreshInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			log.Println("[WSPRRank] Running scheduled hourly fetch")
			f.runFetch()
		case <-f.stopCh:
			log.Println("[WSPRRank] Fetcher stopped")
			return
		}
	}
}

// runFetch fetches all three windows, stores the result under the write lock,
// and persists it to disk via the StatsLogger (if configured).
func (f *WSPRRankFetcher) runFetch() {
	resp := f.fetchAll()
	f.mu.Lock()
	f.cached = resp
	f.mu.Unlock()
	if resp != nil && resp.Rolling24h.Error == "" {
		if f.statsLogger != nil {
			f.statsLogger.WriteWSPR(resp)
		}
		if f.mqttPublisher != nil {
			go f.mqttPublisher.PublishWSPRRank(resp)
		}
	}
}

// Cached returns the most recently fetched data, or nil if no fetch has
// completed yet.
func (f *WSPRRankFetcher) Cached() *WSPRRankResponse {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.cached
}

// fetchAll fetches all three time windows concurrently.
func (f *WSPRRankFetcher) fetchAll() *WSPRRankResponse {
	type result struct {
		window WSPRRankWindow
		key    string
	}

	type fetchSpec struct {
		key string
		url string
	}

	specs := []fetchSpec{
		{"rolling24h", wsprRankURLRolling24h},
		{"yesterday", wsprRankURLYesterday},
		{"today", wsprRankURLToday},
	}

	results := make(chan result, len(specs))

	for _, spec := range specs {
		spec := spec
		go func() {
			w := f.fetchWindow(spec.url)
			results <- result{window: w, key: spec.key}
		}()
	}

	resp := &WSPRRankResponse{
		GeneratedAt: time.Now().UTC(),
	}

	for range specs {
		r := <-results
		switch r.key {
		case "rolling24h":
			resp.Rolling24h = r.window
		case "yesterday":
			resp.Yesterday = r.window
		case "today":
			resp.Today = r.window
		}
	}

	return resp
}

// fetchWindow fetches and parses a single WSPR Live JSONCompact endpoint.
func (f *WSPRRankFetcher) fetchWindow(url string) WSPRRankWindow {
	start := time.Now()
	w := WSPRRankWindow{FetchedAt: start.UTC()}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		w.Error = fmt.Sprintf("build request: %v", err)
		log.Printf("[WSPRRank] request build error: %v", err)
		return w
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "UberSDR/"+Version+" (wspr-rank; https://github.com/ka9q/ubersdr)")

	resp, err := f.client.Do(req)
	if err != nil {
		w.Error = fmt.Sprintf("http fetch: %v", err)
		log.Printf("[WSPRRank] fetch error: %v", err)
		return w
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		w.Error = fmt.Sprintf("upstream HTTP %d", resp.StatusCode)
		log.Printf("[WSPRRank] upstream returned HTTP %d", resp.StatusCode)
		return w
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, wsprRankMaxBodyBytes))
	if err != nil {
		w.Error = fmt.Sprintf("read body: %v", err)
		log.Printf("[WSPRRank] body read error: %v", err)
		return w
	}

	var compact wsprLiveCompact
	if err := json.Unmarshal(body, &compact); err != nil {
		w.Error = fmt.Sprintf("json parse: %v", err)
		log.Printf("[WSPRRank] JSON parse error: %v", err)
		return w
	}

	rows, err := parseWSPRLiveCompact(&compact)
	if err != nil {
		w.Error = fmt.Sprintf("row parse: %v", err)
		log.Printf("[WSPRRank] row parse error: %v", err)
		return w
	}

	w.Data = rows
	w.Rows = len(rows)
	w.FetchedMs = time.Since(start).Milliseconds()
	return w
}

// parseWSPRLiveCompact converts the raw JSONCompact data array into typed rows.
// Column order from the query: rx_sign, rx_loc, raw, dupe, unique, bands, uniques, gross, dupes
func parseWSPRLiveCompact(c *wsprLiveCompact) ([]WSPRRankRow, error) {
	rows := make([]WSPRRankRow, 0, len(c.Data))
	for i, raw := range c.Data {
		if len(raw) < 9 {
			return nil, fmt.Errorf("row %d: expected 9 columns, got %d", i, len(raw))
		}

		var row WSPRRankRow

		if err := json.Unmarshal(raw[0], &row.RxSign); err != nil {
			return nil, fmt.Errorf("row %d rx_sign: %w", i, err)
		}
		if err := json.Unmarshal(raw[1], &row.RxLoc); err != nil {
			return nil, fmt.Errorf("row %d rx_loc: %w", i, err)
		}
		if err := json.Unmarshal(raw[2], &row.Raw); err != nil {
			return nil, fmt.Errorf("row %d raw: %w", i, err)
		}
		if err := json.Unmarshal(raw[3], &row.Dupe); err != nil {
			return nil, fmt.Errorf("row %d dupe: %w", i, err)
		}
		if err := json.Unmarshal(raw[4], &row.Unique); err != nil {
			return nil, fmt.Errorf("row %d unique: %w", i, err)
		}
		if err := json.Unmarshal(raw[5], &row.Bands); err != nil {
			return nil, fmt.Errorf("row %d bands: %w", i, err)
		}
		if err := json.Unmarshal(raw[6], &row.Uniques); err != nil {
			return nil, fmt.Errorf("row %d uniques: %w", i, err)
		}
		if err := json.Unmarshal(raw[7], &row.Gross); err != nil {
			return nil, fmt.Errorf("row %d gross: %w", i, err)
		}
		if err := json.Unmarshal(raw[8], &row.Dupes); err != nil {
			return nil, fmt.Errorf("row %d dupes: %w", i, err)
		}

		rows = append(rows, row)
	}
	return rows, nil
}

// HandleWSPRRank is the admin API handler for GET /admin/wspr-rank.
//
// Query params:
//
//	?window=<value>  — which time window(s) to include in the response.
//	                   Accepted values:
//	                     rolling_24h  — last 24 hours to now
//	                     yesterday    — midnight-to-midnight UTC yesterday
//	                     today        — midnight UTC today to now
//	                     all          — all three windows (default)
//
//	?format=<value>  — response shape.
//	                   Accepted values:
//	                     raw    — raw parsed rows from WSPR Live (default)
//	                     table  — formatted leaderboard with per-band unique
//	                              counts, totals row, and rank numbers
//
//	?refresh=1       — trigger an immediate synchronous fetch from WSPR Live,
//	                   bypassing the hourly schedule.  Rate-limited to once per
//	                   minute; returns HTTP 429 with retry_after_secs if called
//	                   too soon.
//
// Response when ?window=all (or omitted): full wrapper JSON.
// Response when a single window is requested: window JSON (no wrapper).
// If no background fetch has completed yet and ?refresh=1 is not set, returns
// HTTP 202 with a {"status":"pending"} body.
func (ah *AdminHandler) HandleWSPRRank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if ah.wsprRank == nil {
		http.Error(w, `{"error":"WSPR rank fetcher not initialised"}`, http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query()

	// Validate ?window= parameter.
	window := q.Get("window")
	if window == "" {
		window = "all"
	}
	validWindows := map[string]bool{
		"all":         true,
		"rolling_24h": true,
		"yesterday":   true,
		"today":       true,
	}
	if !validWindows[window] {
		w.WriteHeader(http.StatusBadRequest)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"error": "invalid window parameter; accepted values: all, rolling_24h, yesterday, today",
		}); err != nil {
			log.Printf("[WSPRRank] encode bad-request response error: %v", err)
		}
		return
	}

	// Validate ?format= parameter.
	format := q.Get("format")
	if format == "" {
		format = "raw"
	}
	if format != "raw" && format != "table" {
		w.WriteHeader(http.StatusBadRequest)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"error": "invalid format parameter; accepted values: raw, table",
		}); err != nil {
			log.Printf("[WSPRRank] encode bad-request response error: %v", err)
		}
		return
	}

	// Handle ?refresh=1 — rate-limited manual fetch.
	if q.Get("refresh") == "1" {
		ah.wsprRank.mu.Lock()
		since := time.Since(ah.wsprRank.lastManualFetch)
		if since < wsprRankManualRateLimit {
			remaining := wsprRankManualRateLimit - since
			ah.wsprRank.mu.Unlock()
			w.WriteHeader(http.StatusTooManyRequests)
			if err := json.NewEncoder(w).Encode(map[string]interface{}{
				"error":            "rate limited — manual refresh is allowed at most once per minute",
				"retry_after_secs": int(remaining.Seconds()) + 1,
			}); err != nil {
				log.Printf("[WSPRRank] encode rate-limit response error: %v", err)
			}
			return
		}
		ah.wsprRank.lastManualFetch = time.Now()
		ah.wsprRank.mu.Unlock()

		log.Println("[WSPRRank] Manual refresh triggered via admin API")
		ah.wsprRank.runFetch()
	}

	resp := ah.wsprRank.Cached()
	if resp == nil {
		// Background fetch has not completed yet.
		w.WriteHeader(http.StatusAccepted)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"status": "pending",
			"note":   "initial fetch not yet complete; data will be available after the 5-minute startup delay",
		}); err != nil {
			log.Printf("[WSPRRank] encode pending response error: %v", err)
		}
		return
	}

	// Optional ?callsign= filter — case-insensitive, applied before formatting.
	callsign := strings.TrimSpace(q.Get("callsign"))

	// applyCallsign filters a window if a callsign was requested.
	applyCallsign := func(win WSPRRankWindow) WSPRRankWindow {
		if callsign == "" {
			return win
		}
		return filterWSPRRankWindowByCallsign(win, callsign)
	}

	// Return the requested window(s) in the requested format.
	var payload interface{}
	if format == "table" {
		switch window {
		case "rolling_24h":
			payload = formatWSPRRankWindow(applyCallsign(resp.Rolling24h))
		case "yesterday":
			payload = formatWSPRRankWindow(applyCallsign(resp.Yesterday))
		case "today":
			payload = formatWSPRRankWindow(applyCallsign(resp.Today))
		default: // "all"
			payload = WSPRRankTableResponse{
				GeneratedAt: resp.GeneratedAt,
				Rolling24h:  formatWSPRRankWindow(applyCallsign(resp.Rolling24h)),
				Yesterday:   formatWSPRRankWindow(applyCallsign(resp.Yesterday)),
				Today:       formatWSPRRankWindow(applyCallsign(resp.Today)),
			}
		}
	} else {
		switch window {
		case "rolling_24h":
			payload = applyCallsign(resp.Rolling24h)
		case "yesterday":
			payload = applyCallsign(resp.Yesterday)
		case "today":
			payload = applyCallsign(resp.Today)
		default: // "all"
			if callsign == "" {
				payload = resp
			} else {
				payload = WSPRRankResponse{
					GeneratedAt: resp.GeneratedAt,
					Rolling24h:  applyCallsign(resp.Rolling24h),
					Yesterday:   applyCallsign(resp.Yesterday),
					Today:       applyCallsign(resp.Today),
				}
			}
		}
	}

	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("[WSPRRank] encode response error: %v", err)
	}
}
