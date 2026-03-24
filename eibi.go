package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	eibiBaseURL     = "http://www.eibispace.de/dx/sked-%s.csv"
	eibiMaxBytes    = 1 * 1024 * 1024 // 1 MB hard limit
	eibiRefreshInt  = 24 * time.Hour  // refresh every 24 hours
	eibiHTTPTimeout = 30 * time.Second
)

// EiBiEntry represents a single shortwave broadcast schedule entry from the EiBi database.
//
// The EiBi CSV has 11 semicolon-separated columns (no header row after the first line):
//
//	col 0: kHz        — frequency (integer or decimal, e.g. "720", "9410.0")
//	col 1: Time(UTC)  — "HHMM-HHMM" range (e.g. "0600-0800", "0000-2400")
//	col 2: Days       — empty = daily; otherwise "Mo-Fr", "SaSu", "Mo", "Sa", "irr", "24Dec", etc.
//	col 3: ITU        — ITU country code of transmitter (e.g. "G", "USA", "CHN")
//	col 4: Station    — broadcaster name (e.g. "BBC", "China Radio Int.")
//	col 5: Language   — language/mode code (e.g. "E", "A", "-CW", "-TS"; may be empty)
//	col 6: Target     — target region code (e.g. "WEu", "ME", "SAs")
//	col 7: Remarks    — transmitter site or notes (e.g. "/CYP", "gr", "of"; may be empty)
//	col 8: P          — persistence: 1=permanent, 2=seasonal, 6=special event
//	col 9: Start      — schedule start date DDMM (e.g. "0103"); empty = always
//	col 10: Stop      — schedule stop date DDMM (e.g. "2903"); empty = always
type EiBiEntry struct {
	FreqKHz  float64 // Broadcast frequency in kHz
	StartUTC int     // UTC start time as HHMM integer (e.g. 600 = 06:00)
	EndUTC   int     // UTC end time as HHMM integer (e.g. 800 = 08:00)
	Days     string  // Days qualifier (empty = daily, "Mo-Fr", "SaSu", "irr", date like "24Dec", etc.)
	ITU      string  // ITU country code of transmitter (e.g. "G", "USA", "CHN")
	Station  string  // Broadcaster/station name (e.g. "BBC", "VOA")
	Language string  // Language or mode code (e.g. "E", "A", "-CW")
	Target   string  // Target region code (e.g. "WEu", "ME", "SAs")
	Remarks  string  // Transmitter site or additional notes
}

// EiBiSchedule holds the full in-memory EiBi broadcast schedule and manages
// automatic background refresh every 24 hours.
//
// Other parts of the system should call LookupFrequency to query active
// broadcasts for a given frequency and time.
type EiBiSchedule struct {
	config *EiBiConfig

	mu       sync.RWMutex
	entries  []EiBiEntry // parsed schedule entries (nil = not yet loaded)
	season   string      // season code of currently loaded data (e.g. "A26")
	loadedAt time.Time   // when the data was last successfully loaded

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewEiBiSchedule creates a new EiBiSchedule. Returns nil (disabled) when
// config.Enabled is false.
func NewEiBiSchedule(config *EiBiConfig) *EiBiSchedule {
	if config == nil || !config.Enabled {
		return nil
	}
	return &EiBiSchedule{
		config:   config,
		stopChan: make(chan struct{}),
	}
}

// Start performs an initial fetch and then schedules a refresh every 24 hours.
// It is non-blocking; the refresh loop runs in a background goroutine.
func (s *EiBiSchedule) Start() error {
	if s == nil {
		log.Printf("EiBi: disabled — schedule lookups will return no results")
		return nil
	}

	log.Printf("EiBi: starting (refresh interval: 24h, download limit: 1 MB)")

	// Initial load — log a warning but don't fail startup if the fetch fails.
	if err := s.refresh(); err != nil {
		log.Printf("EiBi: initial load failed: %v (will retry in 24h)", err)
	}

	s.wg.Add(1)
	go s.refreshLoop()

	return nil
}

// Stop shuts down the background refresh goroutine.
func (s *EiBiSchedule) Stop() {
	if s == nil {
		return
	}
	log.Printf("EiBi: stopping background refresh")
	close(s.stopChan)
	s.wg.Wait()
	log.Printf("EiBi: stopped")
}

// refreshLoop runs in the background and triggers a refresh every 24 hours.
func (s *EiBiSchedule) refreshLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(eibiRefreshInt)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopChan:
			return
		case <-ticker.C:
			if err := s.refresh(); err != nil {
				log.Printf("EiBi: scheduled refresh failed: %v (keeping previous data)", err)
			}
		}
	}
}

// refresh downloads and parses the EiBi CSV for the current season.
// On any error it leaves the existing in-memory data untouched.
func (s *EiBiSchedule) refresh() error {
	now := time.Now().UTC()
	season := currentEiBiSeason(now)
	url := fmt.Sprintf(eibiBaseURL, season)

	log.Printf("EiBi: fetching season %s from %s", season, url)
	entries, err := s.fetchAndParse(url)
	if err != nil {
		// Try the previous season as a fallback (handles the transition window
		// where the new season file hasn't been published yet).
		prevSeason := previousEiBiSeason(now)
		if prevSeason != season {
			fallbackURL := fmt.Sprintf(eibiBaseURL, prevSeason)
			log.Printf("EiBi: season %s unavailable (%v) — falling back to %s (%s)", season, err, prevSeason, fallbackURL)
			entries, err = s.fetchAndParse(fallbackURL)
			if err != nil {
				log.Printf("EiBi: fallback season %s also failed: %v — keeping previous data", prevSeason, err)
				return fmt.Errorf("season %s and fallback %s both failed: %w", season, prevSeason, err)
			}
			season = prevSeason
		} else {
			log.Printf("EiBi: fetch failed: %v — keeping previous data", err)
			return err
		}
	}

	s.mu.Lock()
	prev := len(s.entries)
	s.entries = entries
	s.season = season
	s.loadedAt = time.Now()
	s.mu.Unlock()

	if prev == 0 {
		log.Printf("EiBi: loaded %d entries for season %s", len(entries), season)
	} else {
		log.Printf("EiBi: refreshed season %s — %d entries (was %d)", season, len(entries), prev)
	}
	return nil
}

// fetchAndParse downloads the CSV at url (enforcing the 1 MB limit) and
// returns the parsed entries.
func (s *EiBiSchedule) fetchAndParse(url string) ([]EiBiEntry, error) {
	client := &http.Client{Timeout: eibiHTTPTimeout}

	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("network error fetching %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}

	// Enforce 1 MB download limit.
	// Read up to eibiMaxBytes+1 bytes; if we get more than eibiMaxBytes the
	// file is too large and we reject it without parsing.
	limited := io.LimitReader(resp.Body, int64(eibiMaxBytes)+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("error reading response body from %s: %w", url, err)
	}
	if len(data) > eibiMaxBytes {
		return nil, fmt.Errorf("response from %s exceeds 1 MB limit (%d bytes) — rejected", url, len(data))
	}

	log.Printf("EiBi: downloaded %d bytes from %s — parsing", len(data), url)
	entries, err := parseEiBiCSV(data)
	if err != nil {
		return nil, fmt.Errorf("CSV parse error for %s: %w", url, err)
	}
	return entries, nil
}

// parseEiBiCSV parses the raw EiBi CSV bytes into a slice of EiBiEntry.
//
// EiBi CSV format — 11 semicolon-separated columns, first line is a header:
//
//	kHz ; Time(UTC)  ; Days  ; ITU ; Station ; Lng ; Target ; Remarks ; P ; Start ; Stop
//	720 ; 0600-0630  ;       ; G   ; BBC     ; A   ; ME     ; /CYP    ; 1 ;       ;
//	720 ; 1400-1430  ; Mo-Fr ; G   ; BBC     ; A   ; ME     ; /CYP    ; 1 ;       ;
//
// The first line (header) is skipped because its first field starts with a letter.
// Lines with fewer than 9 fields or a non-numeric first field are also skipped.
func parseEiBiCSV(data []byte) ([]EiBiEntry, error) {
	r := csv.NewReader(strings.NewReader(string(data)))
	r.Comma = ';'
	r.FieldsPerRecord = -1 // variable number of fields per record
	r.LazyQuotes = true
	r.TrimLeadingSpace = true

	var entries []EiBiEntry

	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Skip malformed lines rather than aborting the whole parse.
			continue
		}
		// Need at least 9 fields: kHz, Time, Days, ITU, Station, Lng, Target, Remarks, P
		if len(record) < 9 {
			continue
		}

		// Skip header / comment lines — first field must start with a digit.
		freqStr := strings.TrimSpace(record[0])
		if freqStr == "" || (freqStr[0] < '0' || freqStr[0] > '9') {
			continue
		}

		freqKHz, err := strconv.ParseFloat(freqStr, 64)
		if err != nil || freqKHz <= 0 {
			continue
		}

		// col 1: "HHMM-HHMM" — split on '-' to get start and end times.
		startUTC, endUTC := parseEiBiTimeRange(strings.TrimSpace(record[1]))
		if startUTC < 0 || endUTC < 0 {
			continue
		}

		entries = append(entries, EiBiEntry{
			FreqKHz:  freqKHz,
			StartUTC: startUTC,
			EndUTC:   endUTC,
			Days:     strings.TrimSpace(record[2]), // empty = daily; "Mo-Fr", "SaSu", "irr", "24Dec", etc.
			ITU:      strings.TrimSpace(record[3]), // ITU country code of transmitter
			Station:  strings.TrimSpace(record[4]), // broadcaster name
			Language: strings.TrimSpace(record[5]), // language/mode code
			Target:   strings.TrimSpace(record[6]), // target region
			Remarks:  strings.TrimSpace(record[7]), // transmitter site / notes
		})
	}

	if len(entries) == 0 {
		return nil, fmt.Errorf("no valid entries parsed from CSV")
	}

	return entries, nil
}

// parseEiBiTimeRange splits an EiBi time range string "HHMM-HHMM" into two
// HHMM integers. Returns (-1, -1) on any parse failure.
//
// Examples:
//
//	"0600-0800" → (600, 800)
//	"0000-2400" → (0, 2400)
//	"1620-0120" → (1620, 120)  — wraps midnight, handled in LookupFrequency
func parseEiBiTimeRange(s string) (start, end int) {
	parts := strings.SplitN(s, "-", 2)
	if len(parts) != 2 {
		return -1, -1
	}
	startVal, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	endVal, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil {
		return -1, -1
	}
	if startVal < 0 || startVal > 2400 || endVal < 0 || endVal > 2400 {
		return -1, -1
	}
	return startVal, endVal
}

// LookupFrequency returns all EiBi entries that are currently active on the
// given frequency (in Hz) at the given UTC time.
//
// Matching criteria:
//   - Frequency within ±1 kHz of the entry's frequency
//   - Current UTC time falls within [StartUTC, EndUTC)
//
// Returns nil (not an error) when the schedule is not yet loaded or no matches
// are found.
func (s *EiBiSchedule) LookupFrequency(freqHz float64, t time.Time) []EiBiEntry {
	if s == nil {
		return nil
	}

	s.mu.RLock()
	entries := s.entries
	s.mu.RUnlock()

	if len(entries) == 0 {
		return nil
	}

	freqKHz := freqHz / 1000.0
	utc := t.UTC()
	timeInt := utc.Hour()*100 + utc.Minute() // e.g. 14:30 → 1430

	var matches []EiBiEntry
	for _, e := range entries {
		// Frequency match: within ±1 kHz (EiBi uses 1 kHz resolution).
		if math.Abs(e.FreqKHz-freqKHz) > 1.0 {
			continue
		}

		// Time match — three cases:
		var active bool
		switch {
		case e.StartUTC == 0 && e.EndUTC == 2400:
			// "0000-2400" — broadcast runs all day.
			active = true
		case e.EndUTC == e.StartUTC:
			// Equal start/end treated as always active (shouldn't normally occur).
			active = true
		case e.EndUTC > e.StartUTC:
			// Normal same-day window, e.g. 0600-0800.
			active = timeInt >= e.StartUTC && timeInt < e.EndUTC
		default:
			// EndUTC < StartUTC — wraps midnight, e.g. 1620-0120.
			active = timeInt >= e.StartUTC || timeInt < e.EndUTC
		}

		if active {
			matches = append(matches, e)
		}
	}

	return matches
}

// LookupFrequencyAll returns all EiBi entries for the given frequency (in Hz)
// regardless of the current time. Useful for showing upcoming schedules.
func (s *EiBiSchedule) LookupFrequencyAll(freqHz float64) []EiBiEntry {
	if s == nil {
		return nil
	}

	s.mu.RLock()
	entries := s.entries
	s.mu.RUnlock()

	if len(entries) == 0 {
		return nil
	}

	freqKHz := freqHz / 1000.0

	var matches []EiBiEntry
	for _, e := range entries {
		if math.Abs(e.FreqKHz-freqKHz) <= 1.0 {
			matches = append(matches, e)
		}
	}

	return matches
}

// GetActiveEntries returns all EiBi entries that are currently active at time t
// and whose frequency falls within the shortwave range (0–30 MHz / 0–30,000 kHz).
// Returns nil when the schedule is not loaded or no entries are active.
func (s *EiBiSchedule) GetActiveEntries(t time.Time) []EiBiEntry {
	if s == nil {
		return nil
	}

	s.mu.RLock()
	entries := s.entries
	s.mu.RUnlock()

	if len(entries) == 0 {
		return nil
	}

	utc := t.UTC()
	timeInt := utc.Hour()*100 + utc.Minute() // e.g. 14:30 → 1430

	var matches []EiBiEntry
	for _, e := range entries {
		// Shortwave range: 0–30 MHz (0–30,000 kHz).
		if e.FreqKHz <= 0 || e.FreqKHz > 30000 {
			continue
		}

		// Time match — same logic as LookupFrequency.
		var active bool
		switch {
		case e.StartUTC == 0 && e.EndUTC == 2400:
			active = true
		case e.EndUTC == e.StartUTC:
			active = true
		case e.EndUTC > e.StartUTC:
			active = timeInt >= e.StartUTC && timeInt < e.EndUTC
		default:
			// Wraps midnight, e.g. 1620-0120.
			active = timeInt >= e.StartUTC || timeInt < e.EndUTC
		}

		if active {
			matches = append(matches, e)
		}
	}

	return matches
}

// Status returns a summary of the current EiBi schedule state suitable for
// inclusion in health/status API responses.
func (s *EiBiSchedule) Status() map[string]interface{} {
	if s == nil {
		return map[string]interface{}{"enabled": false}
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	return map[string]interface{}{
		"enabled":   true,
		"season":    s.season,
		"entries":   len(s.entries),
		"loaded_at": s.loadedAt,
		"loaded":    len(s.entries) > 0,
	}
}

// IsLoaded reports whether the schedule has been successfully loaded at least once.
func (s *EiBiSchedule) IsLoaded() bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries) > 0
}

// currentEiBiSeason returns the EiBi season code for the given UTC time.
//
// Season boundaries (approximate — exact dates vary by year):
//
//	A-season: last Sunday of March → last Sunday of October
//	B-season: last Sunday of October → last Sunday of March
//
// We use a month-based approximation:
//
//	Months 4–10  → A-season (e.g. "A26")
//	Month  11–12 → B-season, year = current year (e.g. "B26")
//	Months 1–3   → B-season, year = previous year  (e.g. "B25")
func currentEiBiSeason(t time.Time) string {
	year := t.Year() % 100
	month := t.Month()

	if month >= 4 && month <= 10 {
		return fmt.Sprintf("A%02d", year)
	}
	if month >= 11 {
		return fmt.Sprintf("B%02d", year)
	}
	// January–March: B-season started in the previous calendar year.
	return fmt.Sprintf("B%02d", year-1)
}

// previousEiBiSeason returns the season code immediately before the current one.
// Used as a fallback when the current season file is not yet published.
func previousEiBiSeason(t time.Time) string {
	month := t.Month()
	year := t.Year() % 100

	// If we're in A-season (Apr–Oct), the previous season is B of the previous year.
	if month >= 4 && month <= 10 {
		return fmt.Sprintf("B%02d", year-1)
	}
	// If we're in B-season (Nov–Dec), the previous season is A of the current year.
	if month >= 11 {
		return fmt.Sprintf("A%02d", year)
	}
	// Jan–Mar: current is B(year-1), previous is A(year-1).
	return fmt.Sprintf("A%02d", year-1)
}
