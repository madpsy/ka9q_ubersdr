package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DRM broadcast schedule — who is transmitting Digital Radio Mondiale, on what
// frequency, and when.
//
// The same shape of thing as eibi.go and deliberately built the same way: a
// background goroutine fetches a public schedule once a day, parses it into
// memory, and never writes it to disk. Nothing here blocks startup, and a
// failed fetch keeps the previous data rather than emptying the list.
//
// Where it differs from EiBi is the source and the audience. EiBi is the whole
// of shortwave broadcasting and is folded into /api/bookmarks; this is the
// eleven stations that transmit DRM, and it exists for the DRM decoder panel,
// which reads it from /api/drm/schedule and shows it nowhere else.
//
// Two sources, tried in order:
//
//   - drmrx.org's schedule feed, which is the schedule DRM listeners actually
//     maintain, published as plain text in the INI-style block format DRM
//     receiver software reads. One request covers shortwave, mediumwave and
//     India MW.
//   - drm.kiwisdr.com's `drmrx.cjson`, KiwiSDR's digest of the same data.
//     Station, frequency and time slots only, but it is small, stable and
//     independently hosted, so it stands in when drmrx.org is unreachable.
//
// Fetching server-side rather than from the browser is what makes the choice
// possible at all: drmrx.org sends no CORS header, so the page itself could
// only ever have used the KiwiSDR mirror.
const (
	drmScheduleURL         = "https://www.drmrx.org/schedules/drmschedules.php"
	drmScheduleFallbackURL = "https://drm.kiwisdr.com/drm/drmrx.cjson"
	drmScheduleMaxBytes    = 2 * 1024 * 1024 // 2 MB hard limit (the feed is ~20 KB)
	drmScheduleRefreshInt  = 24 * time.Hour
	drmScheduleHTTPTimeout = 30 * time.Second

	// The same startup delay EiBi uses, for the same reason: a server in a
	// crash loop must not hammer someone else's site on every restart.
	drmScheduleStartDelay = 2 * time.Minute

	// Per-fetch retries. A daily refresh that gives up on one dropped packet
	// leaves the panel empty until tomorrow, so each URL gets five attempts
	// with the delay doubling between them — 2s, 4s, 8s, 16s, about half a
	// minute in total. Only the transfer is retried: a parse failure is the
	// format having changed and will fail identically every time.
	drmScheduleRetries    = 5
	drmScheduleRetryDelay = 2 * time.Second

	// When a whole refresh fails — both sources, all their attempts — the next
	// one is an hour away rather than a day. A receiver that came up while its
	// network was still settling would otherwise show an empty schedule until
	// tomorrow, which is the failure most likely to actually happen and the one
	// least worth waiting out.
	drmScheduleFailureRetry = time.Hour

	// Past this, data that did load is no longer presented as current. It is
	// two days rather than one so a single missed refresh is not called stale:
	// the schedule changes twice a year, so yesterday's copy is still right.
	drmScheduleStaleAfter = 48 * time.Hour

	// Below this a DRM broadcast is mediumwave rather than shortwave. Only used
	// for the band label; nothing is filtered on it.
	drmScheduleMWCeilingKHz = 1800.0
)

// DRMScheduleEntry is one transmission: a station, on a frequency, over a time
// slot, on certain days. A station appears many times over — several
// frequencies, and several slots on each — which is why this is a flat list
// and not a tree.
type DRMScheduleEntry struct {
	FreqKHz  float64 `json:"freq_khz"`
	FreqHz   uint64  `json:"freq_hz"`
	Station  string  `json:"station"`
	StartUTC int     `json:"start_utc"` // HHMM, e.g. 1830
	EndUTC   int     `json:"end_utc"`   // HHMM; less than StartUTC means it wraps midnight
	DaysMask string  `json:"days_mask"` // 7 chars from Sunday, "1111111" = daily; "" = unknown
	Days     string  `json:"days"`      // the same, as "Daily", "Tue, Thu", "Sun–Fri"
	Language string  `json:"language,omitempty"`
	Target   string  `json:"target,omitempty"`
	Site     string  `json:"site,omitempty"`
	Country  string  `json:"country,omitempty"`
	PowerKW  string  `json:"power_kw,omitempty"` // string: the source writes "?" as well as numbers
	Band     string  `json:"band"`               // "MW" or "SW", derived from the frequency
}

// DRMSchedule holds the parsed schedule and refreshes it once a day.
type DRMSchedule struct {
	mu          sync.RWMutex
	entries     []DRMScheduleEntry
	source      string // URL the current data came from
	loadedAt    time.Time
	lastAttempt time.Time
	lastError   string
	failures    int // consecutive failed refreshes, reset by a success

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewDRMSchedule returns a schedule fetcher, or nil (disabled) when the DRM
// extension config turns it off.
func NewDRMSchedule(config *DRMExtensionConfig) *DRMSchedule {
	if config != nil && config.ScheduleEnabled != nil && !*config.ScheduleEnabled {
		return nil
	}
	return &DRMSchedule{stopChan: make(chan struct{})}
}

// Start launches the background refresh and returns immediately.
func (s *DRMSchedule) Start() error {
	if s == nil {
		log.Printf("DRM schedule: disabled — the DRM panel will show no schedule")
		return nil
	}
	log.Printf("DRM schedule: starting (initial fetch in %s, refresh interval: 24h)", drmScheduleStartDelay)
	s.wg.Add(1)
	go s.refreshLoop()
	return nil
}

// Stop shuts the refresh goroutine down.
func (s *DRMSchedule) Stop() {
	if s == nil {
		return
	}
	close(s.stopChan)
	s.wg.Wait()
	log.Printf("DRM schedule: stopped")
}

// refreshLoop fetches after the startup delay and then once a day — except
// after a failure, when it comes back in an hour instead.
//
// A timer rather than a ticker, because the interval is not fixed: a receiver
// whose network was not up yet when it started must not sit on an empty
// schedule until tomorrow.
func (s *DRMSchedule) refreshLoop() {
	defer s.wg.Done()

	delay := drmScheduleStartDelay
	for {
		select {
		case <-s.stopChan:
			return
		case <-time.After(delay):
		}

		if err := s.refresh(); err != nil {
			delay = drmScheduleFailureRetry
			s.mu.RLock()
			had := len(s.entries)
			s.mu.RUnlock()
			if had == 0 {
				log.Printf("DRM schedule: load failed: %v — nothing to show, retrying in %s", err, delay)
			} else {
				log.Printf("DRM schedule: refresh failed: %v — keeping the %d entries already loaded, retrying in %s",
					err, had, delay)
			}
			continue
		}
		delay = drmScheduleRefreshInt
	}
}

// refresh fetches drmrx.org, falling back to the KiwiSDR digest.
func (s *DRMSchedule) refresh() error {
	return s.refreshFrom(drmScheduleURL, drmScheduleFallbackURL)
}

// refreshFrom is refresh against given URLs, so the failure path can be tested
// without waiting on the real ones. On total failure the existing data is left
// alone — a schedule that changes twice a year is still worth showing when
// today's copy could not be had.
func (s *DRMSchedule) refreshFrom(primaryURL, fallbackURL string) error {
	log.Printf("DRM schedule: fetching %s", primaryURL)
	entries, err := s.fetchAndParse(primaryURL, parseDRMScheduleFeed)
	source := primaryURL

	if err != nil {
		log.Printf("DRM schedule: %s unavailable (%v) — falling back to %s", primaryURL, err, fallbackURL)
		entries, err = s.fetchAndParse(fallbackURL, parseDRMScheduleCJSON)
		if err != nil {
			// Both sources are gone. Whatever was loaded before stays exactly
			// as it is — a schedule that changes twice a year is still worth
			// showing when today's copy could not be had.
			s.mu.Lock()
			s.lastAttempt = time.Now()
			s.lastError = err.Error()
			s.failures++
			s.mu.Unlock()
			return fmt.Errorf("both sources failed: %w", err)
		}
		source = fallbackURL
	}

	// Sorted once here rather than on every request: the list is read far more
	// often than it is fetched, and the panel wants it by frequency.
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].FreqKHz != entries[j].FreqKHz {
			return entries[i].FreqKHz < entries[j].FreqKHz
		}
		return entries[i].StartUTC < entries[j].StartUTC
	})

	s.mu.Lock()
	prev := len(s.entries)
	recovered := s.failures
	s.entries = entries
	s.source = source
	s.loadedAt = time.Now()
	s.lastAttempt = s.loadedAt
	s.lastError = ""
	s.failures = 0
	s.mu.Unlock()

	if recovered > 0 {
		log.Printf("DRM schedule: recovered after %d failed refresh(es)", recovered)
	}

	if prev == 0 {
		log.Printf("DRM schedule: loaded %d entries from %s", len(entries), source)
	} else {
		log.Printf("DRM schedule: refreshed from %s — %d entries (was %d)", source, len(entries), prev)
	}
	return nil
}

func (s *DRMSchedule) fetchAndParse(url string, parse func([]byte) ([]DRMScheduleEntry, error)) ([]DRMScheduleEntry, error) {
	data, err := s.fetchWithRetry(url)
	if err != nil {
		return nil, err
	}
	entries, err := parse(data)
	if err != nil {
		return nil, fmt.Errorf("parsing %s: %w", url, err)
	}
	return entries, nil
}

// fetchWithRetry downloads url, retrying a failed transfer with an exponential
// backoff. Returns the last error once the attempts are spent.
//
// The wait is abortable: a shutdown during the backoff must not hold Stop()
// open for the half-minute the retries can add up to.
func (s *DRMSchedule) fetchWithRetry(url string) ([]byte, error) {
	delay := drmScheduleRetryDelay
	var lastErr error

	for attempt := 1; attempt <= drmScheduleRetries; attempt++ {
		data, err := s.fetchOnce(url)
		if err == nil {
			if attempt > 1 {
				log.Printf("DRM schedule: %s succeeded on attempt %d", url, attempt)
			}
			return data, nil
		}
		lastErr = err

		if attempt == drmScheduleRetries {
			break
		}
		log.Printf("DRM schedule: attempt %d/%d for %s failed (%v) — retrying in %s",
			attempt, drmScheduleRetries, url, err, delay)
		select {
		case <-s.stopChan:
			return nil, fmt.Errorf("shutting down: %w", err)
		case <-time.After(delay):
		}
		delay *= 2
	}

	return nil, fmt.Errorf("%d attempts failed, last error: %w", drmScheduleRetries, lastErr)
}

// fetchOnce is one attempt at the transfer, enforcing the size limit.
func (s *DRMSchedule) fetchOnce(url string) ([]byte, error) {
	client := &http.Client{Timeout: drmScheduleHTTPTimeout}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building request for %s: %w", url, err)
	}
	// Named rather than anonymous: this is a once-a-day fetch of someone else's
	// site and they should be able to tell who is doing it.
	req.Header.Set("User-Agent", "UberSDR/1.0 (DRM schedule; https://github.com/cwsl/ka9q_ubersdr)")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("network error fetching %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}

	limited := io.LimitReader(resp.Body, int64(drmScheduleMaxBytes)+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("error reading response body from %s: %w", url, err)
	}
	if len(data) > drmScheduleMaxBytes {
		return nil, fmt.Errorf("response from %s exceeds %d byte limit — rejected", url, drmScheduleMaxBytes)
	}
	return data, nil
}

// ── drmrx.org feed ──────────────────────────────────────────────────────────

// parseDRMScheduleFeed parses drmrx.org's schedule feed.
//
// Plain text, one blank-line-separated block per transmission, in the INI-style
// format DRM receiver software reads:
//
//	[DRMSchedule]
//	StartStopTimeUTC=1800-1830
//	Days[SMTWTFS]=1111111
//	Frequency=5910
//	Target=Central Europe
//	Power=30
//	Programme=Radio Romania International
//	Language=Italian
//	Site=Saftica
//	Country=Romania
//
// The `[DRMSchedule]` header appears once, at the top, not per block — so
// blocks are split on blank lines and any bracketed line is skipped rather than
// treated as a record boundary.
//
// Keys are read by name, not position, and a block missing a frequency or a
// parsable time range is dropped. Everything else is optional: the feed fills
// all nine fields today, but an entry with a frequency and a time slot is still
// worth showing.
func parseDRMScheduleFeed(data []byte) ([]DRMScheduleEntry, error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")

	// An HTML error page or a WordPress redirect would otherwise parse as zero
	// blocks and produce a bare "no entries" message that says nothing about
	// what actually came back.
	if trimmed := strings.TrimSpace(text); strings.HasPrefix(trimmed, "<") {
		return nil, fmt.Errorf("expected the plain-text schedule feed, got HTML")
	}

	var entries []DRMScheduleEntry

	for _, block := range strings.Split(text, "\n\n") {
		fields := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "[") || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, found := strings.Cut(line, "=")
			if !found {
				continue
			}
			fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
		if len(fields) == 0 {
			continue
		}

		freqKHz, err := strconv.ParseFloat(fields["Frequency"], 64)
		if err != nil || freqKHz <= 0 {
			continue
		}
		start, end := parseEiBiTimeRange(fields["StartStopTimeUTC"])
		if start < 0 || end < 0 {
			continue
		}

		entry := newDRMScheduleEntry(freqKHz, start, end, fields["Programme"], fields["Days[SMTWTFS]"])
		entry.Language = fields["Language"]
		entry.Target = fields["Target"]
		entry.Site = fields["Site"]
		entry.Country = fields["Country"]
		entry.PowerKW = fields["Power"]
		entries = append(entries, entry)
	}

	if len(entries) == 0 {
		return nil, fmt.Errorf("no schedule blocks found — the feed format has probably changed")
	}
	return entries, nil
}

// ── KiwiSDR cjson fallback ──────────────────────────────────────────────────

// parseDRMScheduleCJSON parses KiwiSDR's `drmrx.cjson`.
//
// "cjson" is JSON with `//` line comments. The structure is an array of groups;
// within a group, the key whose value is null is the band label and every other
// key is a station:
//
//	[ { "SW": null,
//	    "BBC World Service": ["https://…", 5875, "-5:0", "6:0", 17575, "-15:0", "16:0"] },
//	  { "MW": null, … }, {} ]
//
// Each station's array is an optional URL followed by (frequency, start, stop)
// triples — the same "a station has several slots on several frequencies" shape
// the feed has, written more densely. A start/stop pair may also be a pair of
// arrays of alternating times. Times are "H:M" or a bare hour, and a leading
// minus marks the slot as verified by a listener rather than meaning a negative
// time. There are no days here, so every entry is taken as daily.
//
// The band label is ignored: with only a frequency in hand it is derived, and
// that removes any dependence on Go preserving JSON object key order, which it
// does not.
func parseDRMScheduleCJSON(data []byte) ([]DRMScheduleEntry, error) {
	var clean strings.Builder
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		clean.WriteString(line)
		clean.WriteByte('\n')
	}

	var groups []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(clean.String()), &groups); err != nil {
		return nil, fmt.Errorf("JSON parse failed: %w", err)
	}

	var entries []DRMScheduleEntry
	for _, group := range groups {
		for station, raw := range group {
			if string(raw) == "null" {
				continue // the band label
			}
			var items []json.RawMessage
			if err := json.Unmarshal(raw, &items); err != nil {
				continue
			}
			// Underscores are the source's line-break marker in station names.
			name := strings.ReplaceAll(station, "_", " ")

			for i := 0; i < len(items); i++ {
				var freqKHz float64
				if err := json.Unmarshal(items[i], &freqKHz); err != nil {
					continue // the leading URL, or anything else unexpected
				}
				if freqKHz <= 0 || i+2 >= len(items) {
					continue
				}
				startRaw, endRaw := items[i+1], items[i+2]
				i += 2

				// A slot pair may be two arrays of alternating times rather
				// than two scalars.
				var startList, endList []json.RawMessage
				if json.Unmarshal(startRaw, &startList) == nil && json.Unmarshal(endRaw, &endList) == nil {
					for j := 0; j+1 < len(startList); j += 2 {
						start, ok1 := drmCJSONTime(startList[j])
						end, ok2 := drmCJSONTime(startList[j+1])
						if ok1 && ok2 {
							entries = append(entries, newDRMScheduleEntry(freqKHz, start, end, name, ""))
						}
					}
					continue
				}

				start, ok1 := drmCJSONTime(startRaw)
				end, ok2 := drmCJSONTime(endRaw)
				if !ok1 || !ok2 {
					continue
				}
				entries = append(entries, newDRMScheduleEntry(freqKHz, start, end, name, ""))
			}
		}
	}

	if len(entries) == 0 {
		return nil, fmt.Errorf("no schedule entries found")
	}
	return entries, nil
}

// drmCJSONTime converts one cjson time to an HHMM integer.
//
// Accepts "H:M" and a bare number of hours, possibly fractional ("18.5" is half
// past six in the evening), with a leading minus meaning "verified" rather than
// negative. Minutes of 60 or more carry into the hour: the live file contains
// "5:60", and reading that as 5:60 rather than 6:00 would put the entry an hour
// out.
func drmCJSONTime(raw json.RawMessage) (int, bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		var f float64
		if err := json.Unmarshal(raw, &f); err != nil {
			return 0, false
		}
		if f < 0 {
			f = -f
		}
		h := int(f)
		m := int((f-float64(h))*60.0 + 0.5)
		return drmClampHHMM(h*60 + m), true
	}

	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "-"))
	parts := strings.SplitN(s, ":", 2)
	h, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || h < 0 {
		return 0, false
	}
	m := 0
	if len(parts) == 2 {
		if m, err = strconv.Atoi(strings.TrimSpace(parts[1])); err != nil || m < 0 {
			return 0, false
		}
	}
	return drmClampHHMM(h*60 + m), true
}

// drmClampHHMM turns minutes-past-midnight into the HHMM integer the rest of
// this file uses, capped at 2400.
func drmClampHHMM(minutes int) int {
	if minutes < 0 {
		minutes = 0
	}
	if minutes > 24*60 {
		minutes = 24 * 60
	}
	return (minutes/60)*100 + minutes%60
}

// ── entries and lookups ─────────────────────────────────────────────────────

func newDRMScheduleEntry(freqKHz float64, start, end int, station, daysMask string) DRMScheduleEntry {
	band := "SW"
	if freqKHz < drmScheduleMWCeilingKHz {
		band = "MW"
	}
	mask := strings.TrimSpace(daysMask)
	if len(mask) != 7 {
		mask = "" // unrecognised means "no day information", i.e. every day
	}
	return DRMScheduleEntry{
		FreqKHz:  freqKHz,
		FreqHz:   uint64(freqKHz * 1000),
		Station:  strings.TrimSpace(station),
		StartUTC: start,
		EndUTC:   end,
		DaysMask: mask,
		Days:     drmDaysLabel(mask),
		Band:     band,
	}
}

// drmSlotActive reports whether an HHMM time falls inside a slot. Same three
// cases EiBi has: all-day, a normal window, and one that wraps midnight.
func drmSlotActive(start, end, now int) bool {
	switch {
	case start == 0 && end == 2400:
		return true
	case start == end:
		return true
	case end > start:
		return now >= start && now < end
	default:
		return now >= start || now < end
	}
}

// drmDayNames is indexed the way the feed's mask is: Sunday first.
var drmDayNames = [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

// drmDaysMatch reports whether a `Days[SMTWTFS]` mask includes the given day.
// An absent or malformed mask is taken as daily — no day information is not a
// reason to hide a broadcast.
func drmDaysMatch(mask string, weekday time.Weekday) bool {
	if len(mask) != 7 {
		return true
	}
	return mask[int(weekday)] == '1'
}

// drmDaysLabel renders a mask as something readable: "Daily", a run as
// "Sun–Fri", anything else as a comma list. Done here rather than in the client
// so every consumer says it the same way.
func drmDaysLabel(mask string) string {
	if len(mask) != 7 {
		return "Daily"
	}

	var on []int
	for i := 0; i < 7; i++ {
		if mask[i] == '1' {
			on = append(on, i)
		}
	}
	switch len(on) {
	case 0:
		return "Off air"
	case 7:
		return "Daily"
	}

	// A single unbroken run reads better as a range. Runs that wrap the end of
	// the week (Fri–Mon) are left to the comma list: spelling them as a range
	// would need a "which end is the start" rule for a case the feed has never
	// produced.
	if on[len(on)-1]-on[0] == len(on)-1 {
		if len(on) == 2 {
			return drmDayNames[on[0]] + ", " + drmDayNames[on[1]]
		}
		return drmDayNames[on[0]] + "–" + drmDayNames[on[len(on)-1]]
	}

	names := make([]string, 0, len(on))
	for _, d := range on {
		names = append(names, drmDayNames[d])
	}
	return strings.Join(names, ", ")
}

// IsOnAir reports whether an entry is transmitting at time t.
func (e DRMScheduleEntry) IsOnAir(t time.Time) bool {
	utc := t.UTC()
	if !drmDaysMatch(e.DaysMask, utc.Weekday()) {
		return false
	}
	return drmSlotActive(e.StartUTC, e.EndUTC, utc.Hour()*100+utc.Minute())
}

// Entries returns every entry the receiver can tune, in frequency order.
//
// Out-of-range entries are dropped for the reason EiBi's GetActiveEntries
// gives: the caller turns these into something clickable, and a row that can
// only refuse to tune is worse than an absent one. A receiver that does not
// reach mediumwave therefore never sees the All India Radio block.
func (s *DRMSchedule) Entries(minHz, maxHz uint64) []DRMScheduleEntry {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	entries := s.entries
	s.mu.RUnlock()

	out := make([]DRMScheduleEntry, 0, len(entries))
	for _, e := range entries {
		if maxHz > 0 && e.FreqHz > maxHz {
			continue
		}
		if e.FreqHz < minHz {
			continue
		}
		out = append(out, e)
	}
	return out
}

// GetActiveEntries returns the entries on air at t, within the receiver's range.
func (s *DRMSchedule) GetActiveEntries(t time.Time, minHz, maxHz uint64) []DRMScheduleEntry {
	var out []DRMScheduleEntry
	for _, e := range s.Entries(minHz, maxHz) {
		if e.IsOnAir(t) {
			out = append(out, e)
		}
	}
	return out
}

// IsLoaded reports whether the schedule has loaded at least once.
func (s *DRMSchedule) IsLoaded() bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries) > 0
}

// staleLocked reports whether the loaded data has aged past the point where it
// should still be presented as current. Caller holds the lock.
func (s *DRMSchedule) staleLocked() bool {
	if len(s.entries) == 0 || s.loadedAt.IsZero() {
		return false // nothing loaded is not the same as something stale
	}
	return time.Since(s.loadedAt) > drmScheduleStaleAfter
}

// Status summarises the schedule for the health/status APIs.
func (s *DRMSchedule) Status() map[string]interface{} {
	if s == nil {
		return map[string]interface{}{"enabled": false}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := map[string]interface{}{
		"enabled":   true,
		"entries":   len(s.entries),
		"loaded":    len(s.entries) > 0,
		"loaded_at": s.loadedAt,
		"source":    s.source,
		"stale":     s.staleLocked(),
	}
	if s.lastError != "" {
		st["last_error"] = s.lastError
		st["failures"] = s.failures
	}
	if !s.lastAttempt.IsZero() {
		st["last_attempt"] = s.lastAttempt
	}
	return st
}

// ── HTTP ────────────────────────────────────────────────────────────────────

// handleDRMSchedule serves the DRM broadcast schedule for the DRM decoder panel.
//
// Query parameters:
//
//	on_air=1  – only the entries transmitting right now
//
// `on_air` is computed here and sent with every entry rather than left to the
// client, so a browser with a wrong clock still agrees with the server about
// what is on — the panel's whole purpose is answering "what can I hear now".
func handleDRMSchedule(w http.ResponseWriter, r *http.Request, config *Config, schedule *DRMSchedule) {
	now := time.Now().UTC()

	type scheduleRow struct {
		DRMScheduleEntry
		OnAir bool `json:"on_air"`
	}

	resp := map[string]interface{}{
		"now_utc": now.Format(time.RFC3339),
		"entries": []scheduleRow{},
	}

	if schedule == nil {
		resp["enabled"] = false
		resp["loaded"] = false
	} else {
		status := schedule.Status()
		resp["enabled"] = status["enabled"]
		resp["loaded"] = status["loaded"]
		resp["loaded_at"] = status["loaded_at"]
		resp["source"] = status["source"]
		resp["stale"] = status["stale"]
		// Why the last fetch failed, so the panel can say whether the empty
		// list is "not tried yet" or "drmrx.org is unreachable from here".
		// Cleared by a success, so a schedule that is loaded and current
		// carries nothing.
		if msg, ok := status["last_error"]; ok {
			resp["last_error"] = msg
		}

		onAirOnly := r.URL.Query().Get("on_air") == "1"
		entries := schedule.Entries(config.Receiver.MinFreq(), config.Receiver.MaxFreq())
		rows := make([]scheduleRow, 0, len(entries))
		for _, e := range entries {
			onAir := e.IsOnAir(now)
			if onAirOnly && !onAir {
				continue
			}
			rows = append(rows, scheduleRow{DRMScheduleEntry: e, OnAir: onAir})
		}
		resp["entries"] = rows
	}

	w.Header().Set("Content-Type", "application/json")
	// A minute of caching: the data changes daily, but a panel reopened
	// repeatedly should not re-serialise the list every time.
	w.Header().Set("Cache-Control", "public, max-age=60")
	json.NewEncoder(w).Encode(resp)
}
