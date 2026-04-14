package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// rbnCallsignRe matches valid callsign query parameters: 1–10 alphanumeric characters.
var rbnCallsignRe = regexp.MustCompile(`^[A-Z0-9]{1,10}$`)

// rbnCommentDateRe extracts a YYYY-MM-DD date from a CSV comment line such as:
//
//	# Created 2026-04-10 00:20:03 UTC
//	# Calculated 2026-04-14 00:15:46
var rbnCommentDateRe = regexp.MustCompile(`(\d{4})-(\d{2})-(\d{2})`)

const (
	rbnSkewURL       = "https://sm7iun.se/rbnskew.csv"
	rbnStatisticsURL = "https://sm7iun.se/statistics.csv"
	rbnFetchTimeout  = 5 * time.Second
	rbnMaxRetries    = 2
	// 100 KiB hard cap on response bodies — the real files are ~5 KiB
	rbnMaxBodyBytes = 100 * 1024
)

// RBNSkewEntry represents one row from rbnskew.csv
// Format: Callsign,Skew,Spots,Correction factor
type RBNSkewEntry struct {
	Callsign         string  `json:"callsign"`
	Skew             float64 `json:"skew"`
	Spots            int     `json:"spots"`
	CorrectionFactor float64 `json:"correction_factor"`
}

// RBNStatisticsEntry represents one row from statistics.csv
// Format: Callsign,Epoch date,Spot count
type RBNStatisticsEntry struct {
	Callsign  string `json:"callsign"`
	EpochDate int    `json:"epoch_date"`
	SpotCount int    `json:"spot_count"`
}

// RBNDataStore holds the latest fetched RBN data in memory
type RBNDataStore struct {
	mu sync.RWMutex

	// Skew data keyed by uppercase callsign
	skewData      map[string]RBNSkewEntry
	skewUpdatedAt *time.Time
	skewComment   string // header comment line from CSV (e.g. "# Calculated 2026-04-10 00:15:42")

	// Statistics data keyed by uppercase callsign
	statsData      map[string]RBNStatisticsEntry
	statsUpdatedAt *time.Time
	statsComment   string // header comment line from CSV
}

// NewRBNDataStore creates an empty store
func NewRBNDataStore() *RBNDataStore {
	return &RBNDataStore{
		skewData:  make(map[string]RBNSkewEntry),
		statsData: make(map[string]RBNStatisticsEntry),
	}
}

// RBNDataFetcher manages periodic fetching of RBN data
type RBNDataFetcher struct {
	store           *RBNDataStore
	cwSkimmerConfig *CWSkimmerConfig // nil or disabled → fetching is skipped
	client          *http.Client
	stopCh          chan struct{}
	mu              sync.Mutex
	lastManualFetch time.Time // guards the once-per-minute manual refresh rate limit
}

// NewRBNDataFetcher creates a new fetcher backed by the given store.
// cwSkimmerConfig may be nil; if it is nil or its Enabled field is false,
// all fetches are skipped.
func NewRBNDataFetcher(store *RBNDataStore, cwSkimmerConfig *CWSkimmerConfig) *RBNDataFetcher {
	return &RBNDataFetcher{
		store:           store,
		cwSkimmerConfig: cwSkimmerConfig,
		client: &http.Client{
			Timeout: rbnFetchTimeout,
		},
		stopCh: make(chan struct{}),
	}
}

// Start launches the background fetch loop and returns immediately.
// The first fetch is delayed by 5 minutes so that a rapid startup/crash loop
// does not hammer the remote server. After the initial fetch the loop sleeps
// until 01:00 UTC each day. If either file's comment date is still yesterday
// (i.e. the remote has not yet published today's data), individual retries are
// scheduled every 3 hours until both files are current.
func (f *RBNDataFetcher) Start() {
	log.Println("[RBN] Starting (initial fetch in 5 min, then daily at 01:00 UTC)")
	go f.fetchLoop()
}

// fetchLoop is the background goroutine started by Start.
func (f *RBNDataFetcher) fetchLoop() {
	// 5-minute startup delay — abortable if Stop() is called.
	log.Println("[RBN] Waiting 5 minutes before initial fetch")
	select {
	case <-f.stopCh:
		log.Println("[RBN] Fetcher stopped before initial fetch")
		return
	case <-time.After(5 * time.Minute):
	}

	// Initial fetch.
	log.Println("[RBN] Performing initial data fetch")
	f.fetchAll()
	f.retryIfStale()

	// Schedule daily refresh at 02:00 UTC — abortable via stopCh.
	for {
		next := nextDailyAt(1, 0, 0)
		log.Printf("[RBN] Next scheduled fetch at %s", next.UTC().Format(time.RFC3339))
		select {
		case <-time.After(time.Until(next)):
			log.Println("[RBN] Running scheduled daily fetch (01:00 UTC)")
			f.fetchAll()
			f.retryIfStale()
		case <-f.stopCh:
			log.Println("[RBN] Fetcher stopped")
			return
		}
	}
}

// retryIfStale checks whether either CSV file's comment date is older than
// today's UTC date and, if so, retries the stale file(s) every 3 hours until
// both are current or Stop() is called.
//
// Both rbnskew.csv and statistics.csv embed a date in their first comment line:
//
//	# Calculated 2026-04-14 00:15:46
//	# Created 2026-04-10 00:20:03 UTC
//
// "Fresh" means the YYYY-MM-DD in that comment equals today's UTC date.
func (f *RBNDataFetcher) retryIfStale() {
	const retryInterval = 3 * time.Hour

	for {
		skewStale := f.commentIsStale(f.skewComment())
		statsStale := f.commentIsStale(f.statsComment())

		if !skewStale && !statsStale {
			return
		}

		if skewStale {
			log.Printf("[RBN] Skew data comment date is stale; will retry in %s", retryInterval)
		}
		if statsStale {
			log.Printf("[RBN] Statistics data comment date is stale; will retry in %s", retryInterval)
		}

		select {
		case <-f.stopCh:
			log.Println("[RBN] Fetcher stopped during stale-data retry wait")
			return
		case <-time.After(retryInterval):
		}

		if skewStale {
			log.Println("[RBN] Retrying skew fetch (stale comment date)")
			f.fetchSkew()
		}
		if statsStale {
			log.Println("[RBN] Retrying statistics fetch (stale comment date)")
			f.fetchStatistics()
		}
	}
}

// skewComment returns the current skew CSV comment string under a read lock.
func (f *RBNDataFetcher) skewComment() string {
	f.store.mu.RLock()
	defer f.store.mu.RUnlock()
	return f.store.skewComment
}

// statsComment returns the current statistics CSV comment string under a read lock.
func (f *RBNDataFetcher) statsComment() string {
	f.store.mu.RLock()
	defer f.store.mu.RUnlock()
	return f.store.statsComment
}

// commentIsStale parses the YYYY-MM-DD date embedded in a CSV comment line and
// returns true when that date is before today's UTC date (or when no date can
// be parsed, which is treated conservatively as stale).
//
// Example comment lines:
//
//	# Calculated 2026-04-14 00:15:46
//	# Created 2026-04-10 00:20:03 UTC
func (f *RBNDataFetcher) commentIsStale(comment string) bool {
	m := rbnCommentDateRe.FindStringSubmatch(comment)
	if m == nil {
		// Cannot determine freshness — treat as stale.
		return true
	}
	year, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])

	commentDate := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	todayUTC := time.Now().UTC().Truncate(24 * time.Hour)

	return commentDate.Before(todayUTC)
}

// Stop signals the background goroutine to exit
func (f *RBNDataFetcher) Stop() {
	close(f.stopCh)
}

// cwSkimmerEnabled returns true when the CW Skimmer config is present and enabled.
func (f *RBNDataFetcher) cwSkimmerEnabled() bool {
	return f.cwSkimmerConfig != nil && f.cwSkimmerConfig.Enabled
}

// fetchAll fetches both CSV files, retrying up to rbnMaxRetries times each.
// It is a no-op when CW Skimmer is not enabled.
func (f *RBNDataFetcher) fetchAll() {
	if !f.cwSkimmerEnabled() {
		log.Println("[RBN] Skipping fetch — CW Skimmer is not enabled")
		return
	}
	f.fetchSkew()
	f.fetchStatistics()
}

// fetchSkew fetches and parses rbnskew.csv, keeping the previous data on failure
func (f *RBNDataFetcher) fetchSkew() {
	var (
		body []byte
		err  error
	)
	for attempt := 1; attempt <= rbnMaxRetries; attempt++ {
		body, err = f.fetchURL(rbnSkewURL)
		if err == nil {
			break
		}
		log.Printf("[RBN] Skew fetch attempt %d/%d failed: %v", attempt, rbnMaxRetries, err)
	}
	if err != nil {
		log.Printf("[RBN] All skew fetch attempts failed, keeping previous data")
		return
	}

	entries, comment, parseErr := parseRBNSkewCSV(string(body))
	if parseErr != nil {
		log.Printf("[RBN] Failed to parse skew CSV: %v, keeping previous data", parseErr)
		return
	}

	now := time.Now().UTC()
	f.store.mu.Lock()
	f.store.skewData = entries
	f.store.skewUpdatedAt = &now
	f.store.skewComment = comment
	f.store.mu.Unlock()
	log.Printf("[RBN] Skew data updated: %d entries (source comment: %q)", len(entries), comment)
}

// fetchStatistics fetches and parses statistics.csv, keeping the previous data on failure
func (f *RBNDataFetcher) fetchStatistics() {
	var (
		body []byte
		err  error
	)
	for attempt := 1; attempt <= rbnMaxRetries; attempt++ {
		body, err = f.fetchURL(rbnStatisticsURL)
		if err == nil {
			break
		}
		log.Printf("[RBN] Statistics fetch attempt %d/%d failed: %v", attempt, rbnMaxRetries, err)
	}
	if err != nil {
		log.Printf("[RBN] All statistics fetch attempts failed, keeping previous data")
		return
	}

	entries, comment, parseErr := parseRBNStatisticsCSV(string(body))
	if parseErr != nil {
		log.Printf("[RBN] Failed to parse statistics CSV: %v, keeping previous data", parseErr)
		return
	}

	now := time.Now().UTC()
	f.store.mu.Lock()
	f.store.statsData = entries
	f.store.statsUpdatedAt = &now
	f.store.statsComment = comment
	f.store.mu.Unlock()
	log.Printf("[RBN] Statistics data updated: %d entries (source comment: %q)", len(entries), comment)
}

// fetchURL performs a GET request and returns the body bytes.
// The response body is capped at rbnMaxBodyBytes to guard against runaway responses.
// A descriptive User-Agent is sent so that sm7iun.se can identify the client.
func (f *RBNDataFetcher) fetchURL(url string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building request for %s: %w", url, err)
	}
	req.Header.Set("User-Agent", "UberSDR/"+Version+" (https://github.com/ka9q/ka9q-radio)")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	// LimitReader returns io.EOF after rbnMaxBodyBytes; if the real file is
	// larger than the cap we treat it as an error rather than silently truncating.
	limited := io.LimitReader(resp.Body, rbnMaxBodyBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("reading body from %s: %w", url, err)
	}
	if int64(len(data)) > rbnMaxBodyBytes {
		return nil, fmt.Errorf("response from %s exceeds %d byte limit", url, rbnMaxBodyBytes)
	}
	return data, nil
}

// parseRBNSkewCSV parses the rbnskew.csv content.
// Lines starting with '#' are treated as comments (the first one is returned).
// Expected header: Callsign,Skew,Spots,Correction factor
// Returns an error if the header is missing or unrecognised (guards against HTML error pages etc.).
func parseRBNSkewCSV(content string) (map[string]RBNSkewEntry, string, error) {
	var comment string
	var csvLines []string

	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			if comment == "" {
				comment = trimmed
			}
			continue
		}
		csvLines = append(csvLines, line)
	}

	if len(csvLines) == 0 {
		return nil, comment, fmt.Errorf("no data rows found (empty or comment-only response)")
	}

	r := csv.NewReader(strings.NewReader(strings.Join(csvLines, "\n")))
	r.TrimLeadingSpace = true

	records, err := r.ReadAll()
	if err != nil {
		return nil, comment, fmt.Errorf("CSV parse error: %w", err)
	}

	if len(records) == 0 {
		return nil, comment, fmt.Errorf("CSV contained no records")
	}

	// Validate header row: first record must be Callsign,Skew,Spots,<anything>
	hdr := records[0]
	if len(hdr) < 4 ||
		!strings.EqualFold(strings.TrimSpace(hdr[0]), "callsign") ||
		!strings.EqualFold(strings.TrimSpace(hdr[1]), "skew") ||
		!strings.EqualFold(strings.TrimSpace(hdr[2]), "spots") {
		return nil, comment, fmt.Errorf("unexpected CSV header %v (expected Callsign,Skew,Spots,...)", hdr)
	}

	entries := make(map[string]RBNSkewEntry)
	for _, rec := range records[1:] { // skip validated header
		if len(rec) < 4 {
			continue
		}

		callsign := strings.ToUpper(strings.TrimSpace(rec[0]))
		if callsign == "" {
			continue
		}

		var skew float64
		fmt.Sscanf(strings.TrimSpace(rec[1]), "%f", &skew)

		var spots int
		fmt.Sscanf(strings.TrimSpace(rec[2]), "%d", &spots)

		var corrFactor float64
		fmt.Sscanf(strings.TrimSpace(rec[3]), "%f", &corrFactor)

		entries[callsign] = RBNSkewEntry{
			Callsign:         callsign,
			Skew:             skew,
			Spots:            spots,
			CorrectionFactor: corrFactor,
		}
	}

	return entries, comment, nil
}

// parseRBNStatisticsCSV parses the statistics.csv content.
// Lines starting with '#' are treated as comments (the first one is returned).
// Expected header: Callsign,Epoch date,Spot count
// Returns an error if the header is missing or unrecognised.
func parseRBNStatisticsCSV(content string) (map[string]RBNStatisticsEntry, string, error) {
	var comment string
	var csvLines []string

	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			if comment == "" {
				comment = trimmed
			}
			continue
		}
		csvLines = append(csvLines, line)
	}

	if len(csvLines) == 0 {
		return nil, comment, fmt.Errorf("no data rows found (empty or comment-only response)")
	}

	r := csv.NewReader(strings.NewReader(strings.Join(csvLines, "\n")))
	r.TrimLeadingSpace = true

	records, err := r.ReadAll()
	if err != nil {
		return nil, comment, fmt.Errorf("CSV parse error: %w", err)
	}

	if len(records) == 0 {
		return nil, comment, fmt.Errorf("CSV contained no records")
	}

	// Validate header row: first record must be Callsign,Epoch date,Spot count
	hdr := records[0]
	if len(hdr) < 3 ||
		!strings.EqualFold(strings.TrimSpace(hdr[0]), "callsign") ||
		!strings.EqualFold(strings.TrimSpace(hdr[1]), "epoch date") ||
		!strings.EqualFold(strings.TrimSpace(hdr[2]), "spot count") {
		return nil, comment, fmt.Errorf("unexpected CSV header %v (expected Callsign,Epoch date,Spot count)", hdr)
	}

	entries := make(map[string]RBNStatisticsEntry)
	for _, rec := range records[1:] { // skip validated header
		if len(rec) < 3 {
			continue
		}

		callsign := strings.ToUpper(strings.TrimSpace(rec[0]))
		if callsign == "" {
			continue
		}

		var epochDate int
		fmt.Sscanf(strings.TrimSpace(rec[1]), "%d", &epochDate)

		var spotCount int
		fmt.Sscanf(strings.TrimSpace(rec[2]), "%d", &spotCount)

		entries[callsign] = RBNStatisticsEntry{
			Callsign:  callsign,
			EpochDate: epochDate,
			SpotCount: spotCount,
		}
	}

	return entries, comment, nil
}

// nextDailyAt returns the next occurrence of the given UTC hour:min:sec.
// If that time has already passed today it returns tomorrow's occurrence.
func nextDailyAt(hour, min, sec int) time.Time {
	now := time.Now().UTC()
	candidate := time.Date(now.Year(), now.Month(), now.Day(), hour, min, sec, 0, time.UTC)
	if !candidate.After(now) {
		candidate = candidate.Add(24 * time.Hour)
	}
	return candidate
}

// ---- Admin API handler ----

// RBNCallsignResponse is the JSON response for a single callsign lookup
type RBNCallsignResponse struct {
	Callsign string `json:"callsign"`

	// Skew data (nil if not present)
	Skew *RBNSkewEntry `json:"skew,omitempty"`

	// Statistics data (nil if not present)
	Statistics *RBNStatisticsEntry `json:"statistics,omitempty"`

	// Metadata
	SkewUpdatedAt   *time.Time `json:"skew_updated_at,omitempty"`
	StatsUpdatedAt  *time.Time `json:"stats_updated_at,omitempty"`
	SkewSourceNote  string     `json:"skew_source_note,omitempty"`
	StatsSourceNote string     `json:"stats_source_note,omitempty"`
}

// RBNAllResponse is the JSON response when no callsign filter is requested
type RBNAllResponse struct {
	Skew struct {
		UpdatedAt  *time.Time     `json:"updated_at"`
		SourceNote string         `json:"source_note,omitempty"`
		Entries    []RBNSkewEntry `json:"entries"`
	} `json:"skew"`
	Statistics struct {
		UpdatedAt  *time.Time           `json:"updated_at"`
		SourceNote string               `json:"source_note,omitempty"`
		Entries    []RBNStatisticsEntry `json:"entries"`
	} `json:"statistics"`
}

// HandleRBNData is the admin API handler for /admin/rbn-data
// Query params:
//
//	?callsign=XX1YY  — return skew + statistics for a specific callsign (case-insensitive)
//	(no params)      — return all data
func (ah *AdminHandler) HandleRBNData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if ah.rbnStore == nil {
		http.Error(w, `{"error":"RBN data store not initialised"}`, http.StatusServiceUnavailable)
		return
	}

	// If the store has never been populated yet (startup delay still running),
	// perform an immediate synchronous fetch so the caller gets real data.
	ah.rbnStore.mu.RLock()
	noData := ah.rbnStore.skewUpdatedAt == nil && ah.rbnStore.statsUpdatedAt == nil
	ah.rbnStore.mu.RUnlock()
	if noData && ah.rbnFetcher != nil {
		log.Println("[RBN] Store empty on first API call — fetching immediately")
		ah.rbnFetcher.fetchAll()
	}

	callsign := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("callsign")))

	// Validate callsign: alphanumeric only, max 10 characters
	if callsign != "" && !rbnCallsignRe.MatchString(callsign) {
		http.Error(w, "invalid callsign: must be 1–10 alphanumeric characters", http.StatusBadRequest)
		return
	}

	ah.rbnStore.mu.RLock()
	defer ah.rbnStore.mu.RUnlock()

	if callsign != "" {
		// Single callsign lookup
		resp := RBNCallsignResponse{
			Callsign:        callsign,
			SkewUpdatedAt:   ah.rbnStore.skewUpdatedAt,
			StatsUpdatedAt:  ah.rbnStore.statsUpdatedAt,
			SkewSourceNote:  ah.rbnStore.skewComment,
			StatsSourceNote: ah.rbnStore.statsComment,
		}

		if entry, ok := ah.rbnStore.skewData[callsign]; ok {
			e := entry
			resp.Skew = &e
		}
		if entry, ok := ah.rbnStore.statsData[callsign]; ok {
			e := entry
			resp.Statistics = &e
		}

		if err := json.NewEncoder(w).Encode(resp); err != nil {
			log.Printf("[RBN] Error encoding callsign response: %v", err)
		}
		return
	}

	// Return all data
	var resp RBNAllResponse
	resp.Skew.UpdatedAt = ah.rbnStore.skewUpdatedAt
	resp.Skew.SourceNote = ah.rbnStore.skewComment
	resp.Statistics.UpdatedAt = ah.rbnStore.statsUpdatedAt
	resp.Statistics.SourceNote = ah.rbnStore.statsComment

	for _, e := range ah.rbnStore.skewData {
		resp.Skew.Entries = append(resp.Skew.Entries, e)
	}
	for _, e := range ah.rbnStore.statsData {
		resp.Statistics.Entries = append(resp.Statistics.Entries, e)
	}

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("[RBN] Error encoding all-data response: %v", err)
	}
}

// HandleRBNRefresh is the admin API handler for POST /admin/rbn-data/refresh.
// It triggers an immediate fetch of both CSV sources.
// Rate-limited to once per minute; returns HTTP 429 with a sensible error if called too soon.
func (ah *AdminHandler) HandleRBNRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if ah.rbnFetcher == nil || ah.rbnStore == nil {
		http.Error(w, `{"error":"RBN fetcher not initialised"}`, http.StatusServiceUnavailable)
		return
	}

	// Rate-limit: at most one manual refresh per minute
	ah.rbnFetcher.mu.Lock()
	since := time.Since(ah.rbnFetcher.lastManualFetch)
	if since < time.Minute {
		remaining := time.Minute - since
		ah.rbnFetcher.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"error":            "rate limited — manual refresh is allowed at most once per minute",
			"retry_after_secs": int(remaining.Seconds()) + 1,
		}); err != nil {
			log.Printf("[RBN] Error encoding rate-limit response: %v", err)
		}
		return
	}
	ah.rbnFetcher.lastManualFetch = time.Now()
	ah.rbnFetcher.mu.Unlock()

	// Run the fetch synchronously so the response reflects the outcome
	log.Println("[RBN] Manual refresh triggered via admin API")
	ah.rbnFetcher.fetchAll()

	ah.rbnStore.mu.RLock()
	skewUpdated := ah.rbnStore.skewUpdatedAt
	statsUpdated := ah.rbnStore.statsUpdatedAt
	skewCount := len(ah.rbnStore.skewData)
	statsCount := len(ah.rbnStore.statsData)
	ah.rbnStore.mu.RUnlock()

	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":             "ok",
		"skew_entries":       skewCount,
		"statistics_entries": statsCount,
		"skew_updated_at":    skewUpdated,
		"stats_updated_at":   statsUpdated,
	}); err != nil {
		log.Printf("[RBN] Error encoding refresh response: %v", err)
	}
}
