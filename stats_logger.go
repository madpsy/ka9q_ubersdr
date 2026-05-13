package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// statsMaxDays is the maximum date range allowed for a single history query.
const statsMaxDays = 30

// stats_logger.go — JSONL persistence for WSPR, PSK and RBN fetched stats.
//
// File layout (all under baseDir):
//
//	wspr/YYYY/MM/DD/rolling_24h.jsonl   — one WSPRRankResponse appended per hourly fetch
//	wspr/YYYY/MM/DD/yesterday.jsonl
//	wspr/YYYY/MM/DD/today.jsonl
//
//	psk/YYYY/MM/DD/report_result.jsonl  — one PSKRankData appended per hourly fetch
//	psk/YYYY/MM/DD/country_result.jsonl
//
//	rbn/YYYY/MM/DD/skew.jsonl           — one record written (truncated) per daily fetch
//	rbn/YYYY/MM/DD/statistics.jsonl
//
// WSPR and PSK files use O_APPEND — each hourly fetch adds a line.
// RBN files use O_TRUNC — each successful daily fetch overwrites the file.
// On startup, LoadLatest* reads the last line of today's (or yesterday's) file
// and seeds the in-memory cache so the UI is populated immediately.

// StatsLogger persists fetched stats for WSPR, PSK and RBN to JSONL files.
type StatsLogger struct {
	baseDir string
	enabled bool
}

// NewStatsLogger creates a StatsLogger rooted at baseDir.
// If enabled is false all methods are no-ops.
func NewStatsLogger(baseDir string, enabled bool) (*StatsLogger, error) {
	if !enabled {
		return &StatsLogger{enabled: false}, nil
	}
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, fmt.Errorf("stats_logger: create base dir %s: %w", baseDir, err)
	}
	return &StatsLogger{baseDir: baseDir, enabled: true}, nil
}

// ---- WSPR ---------------------------------------------------------------

// WriteWSPR appends the full WSPRRankResponse to today's WSPR JSONL files.
// Three files are written (rolling_24h, yesterday, today) — all containing
// the same full response — so that LoadLatestWSPR only needs to read one.
func (sl *StatsLogger) WriteWSPR(resp *WSPRRankResponse) {
	if !sl.enabled || resp == nil {
		return
	}
	now := resp.GeneratedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	for _, name := range []string{"rolling_24h", "yesterday", "today"} {
		if err := sl.appendJSONL("wspr", name+".jsonl", now, resp); err != nil {
			log.Printf("[StatsLogger] WriteWSPR %s: %v", name, err)
		}
	}
}

// LoadLatestWSPR reads the most recent WSPRRankResponse from disk.
// It tries today's file first, then yesterday's.
// Returns nil if no data is found.
func (sl *StatsLogger) LoadLatestWSPR() *WSPRRankResponse {
	if !sl.enabled {
		return nil
	}
	// We only need one file — all three windows are stored in every file.
	for _, t := range sl.candidateDays() {
		path := sl.filePath("wspr", "rolling_24h.jsonl", t)
		var resp WSPRRankResponse
		if sl.readLastLine(path, &resp) {
			log.Printf("[StatsLogger] Loaded WSPR cache from %s (generated_at=%s)", path, resp.GeneratedAt.Format(time.RFC3339))
			return &resp
		}
	}
	return nil
}

// ---- PSK ----------------------------------------------------------------

// pskTableRecord is the envelope written to each PSK JSONL file.
type pskTableRecord struct {
	FetchedAt time.Time   `json:"fetched_at"`
	Data      PSKRankData `json:"data"`
}

// WritePSK appends the PSKRankData to today's PSK JSONL files
// (one file per table: report_result, country_result).
func (sl *StatsLogger) WritePSK(data *PSKRankData) {
	if !sl.enabled || data == nil {
		return
	}
	now := data.FetchedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}

	for _, name := range []string{"report_result", "country_result"} {
		if err := sl.appendJSONL("psk", name+".jsonl", now, data); err != nil {
			log.Printf("[StatsLogger] WritePSK %s: %v", name, err)
		}
	}
}

// LoadLatestPSK reads the most recent PSKRankData from disk.
// Returns nil if no data is found.
func (sl *StatsLogger) LoadLatestPSK() *PSKRankData {
	if !sl.enabled {
		return nil
	}
	for _, t := range sl.candidateDays() {
		path := sl.filePath("psk", "report_result.jsonl", t)
		var data PSKRankData
		if sl.readLastLine(path, &data) {
			log.Printf("[StatsLogger] Loaded PSK cache from %s (fetched_at=%s)", path, data.FetchedAt.Format(time.RFC3339))
			return &data
		}
	}
	return nil
}

// ---- RBN ----------------------------------------------------------------

// rbnSkewRecord is the envelope written to rbn/YYYY/MM/DD/skew.jsonl.
type rbnSkewRecord struct {
	FetchedAt     time.Time      `json:"fetched_at"`
	SourceComment string         `json:"source_comment"`
	Entries       []RBNSkewEntry `json:"entries"`
}

// rbnStatsRecord is the envelope written to rbn/YYYY/MM/DD/statistics.jsonl.
type rbnStatsRecord struct {
	FetchedAt     time.Time            `json:"fetched_at"`
	SourceComment string               `json:"source_comment"`
	Entries       []RBNStatisticsEntry `json:"entries"`
}

// WriteRBNSkew overwrites today's RBN skew JSONL file with the current data.
// The file is truncated on each successful write (daily snapshot semantics).
func (sl *StatsLogger) WriteRBNSkew(entries map[string]RBNSkewEntry, comment string, fetchedAt time.Time) {
	if !sl.enabled {
		return
	}
	slice := make([]RBNSkewEntry, 0, len(entries))
	for _, e := range entries {
		slice = append(slice, e)
	}
	rec := rbnSkewRecord{
		FetchedAt:     fetchedAt,
		SourceComment: comment,
		Entries:       slice,
	}
	if err := sl.overwriteJSONL("rbn", "skew.jsonl", fetchedAt, rec); err != nil {
		log.Printf("[StatsLogger] WriteRBNSkew: %v", err)
	}
}

// WriteRBNStats overwrites today's RBN statistics JSONL file with the current data.
func (sl *StatsLogger) WriteRBNStats(entries map[string]RBNStatisticsEntry, comment string, fetchedAt time.Time) {
	if !sl.enabled {
		return
	}
	slice := make([]RBNStatisticsEntry, 0, len(entries))
	for _, e := range entries {
		slice = append(slice, e)
	}
	rec := rbnStatsRecord{
		FetchedAt:     fetchedAt,
		SourceComment: comment,
		Entries:       slice,
	}
	if err := sl.overwriteJSONL("rbn", "statistics.jsonl", fetchedAt, rec); err != nil {
		log.Printf("[StatsLogger] WriteRBNStats: %v", err)
	}
}

// LoadLatestRBNSkew reads the most recent RBN skew snapshot from disk.
// Returns nil map if no data is found.
func (sl *StatsLogger) LoadLatestRBNSkew() (map[string]RBNSkewEntry, string, *time.Time) {
	if !sl.enabled {
		return nil, "", nil
	}
	for _, t := range sl.candidateDays() {
		path := sl.filePath("rbn", "skew.jsonl", t)
		var rec rbnSkewRecord
		if sl.readLastLine(path, &rec) {
			m := make(map[string]RBNSkewEntry, len(rec.Entries))
			for _, e := range rec.Entries {
				m[e.Callsign] = e
			}
			log.Printf("[StatsLogger] Loaded RBN skew from %s (%d entries)", path, len(m))
			return m, rec.SourceComment, &rec.FetchedAt
		}
	}
	return nil, "", nil
}

// LoadLatestRBNStats reads the most recent RBN statistics snapshot from disk.
// Returns nil map if no data is found.
func (sl *StatsLogger) LoadLatestRBNStats() (map[string]RBNStatisticsEntry, string, *time.Time) {
	if !sl.enabled {
		return nil, "", nil
	}
	for _, t := range sl.candidateDays() {
		path := sl.filePath("rbn", "statistics.jsonl", t)
		var rec rbnStatsRecord
		if sl.readLastLine(path, &rec) {
			m := make(map[string]RBNStatisticsEntry, len(rec.Entries))
			for _, e := range rec.Entries {
				m[e.Callsign] = e
			}
			log.Printf("[StatsLogger] Loaded RBN statistics from %s (%d entries)", path, len(m))
			return m, rec.SourceComment, &rec.FetchedAt
		}
	}
	return nil, "", nil
}

// ---- helpers ------------------------------------------------------------

// candidateDays returns [today, yesterday] in UTC — the two days to probe
// when looking for the most recent persisted data.
func (sl *StatsLogger) candidateDays() []time.Time {
	now := time.Now().UTC()
	return []time.Time{now, now.AddDate(0, 0, -1)}
}

// filePath builds the full path for source/filename on the given day.
// Layout: baseDir/source/YYYY/MM/DD/filename
func (sl *StatsLogger) filePath(source, filename string, t time.Time) string {
	return filepath.Join(
		sl.baseDir,
		source,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", int(t.Month())),
		fmt.Sprintf("%02d", t.Day()),
		filename,
	)
}

// ensureDir creates the directory for the given file path if it does not exist.
func ensureDir(path string) error {
	return os.MkdirAll(filepath.Dir(path), 0755)
}

// appendJSONL marshals v as a single JSON line and appends it to the file
// at source/YYYY/MM/DD/filename (creating directories as needed).
func (sl *StatsLogger) appendJSONL(source, filename string, t time.Time, v interface{}) error {
	path := sl.filePath(source, filename, t)
	if err := ensureDir(path); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	data = append(data, '\n')
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// overwriteJSONL marshals v as a single JSON line and writes it as the sole
// content of source/YYYY/MM/DD/filename, truncating any previous content.
func (sl *StatsLogger) overwriteJSONL(source, filename string, t time.Time, v interface{}) error {
	path := sl.filePath(source, filename, t)
	if err := ensureDir(path); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	f, err := os.OpenFile(path, os.O_TRUNC|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	data = append(data, '\n')
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// readLastLine reads the last non-empty line of path and unmarshals it into v.
// Returns false if the file does not exist, is empty, or cannot be parsed.
func (sl *StatsLogger) readLastLine(path string, v interface{}) bool {
	f, err := os.Open(path)
	if err != nil {
		return false // file not found is normal on first run
	}
	defer f.Close()

	var lastLine string
	scanner := bufio.NewScanner(f)
	// Allow lines up to 16 MiB (WSPR response can be large)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)
	for scanner.Scan() {
		if line := scanner.Text(); line != "" {
			lastLine = line
		}
	}
	if lastLine == "" {
		return false
	}
	if err := json.Unmarshal([]byte(lastLine), v); err != nil {
		log.Printf("[StatsLogger] readLastLine %s: unmarshal error: %v", path, err)
		return false
	}
	return true
}

// ---- date-range query helpers -------------------------------------------

// StatsQueryParams holds the validated, normalised parameters for a history query.
type StatsQueryParams struct {
	FromDate time.Time // start of range (UTC midnight)
	ToDate   time.Time // end of range (UTC midnight, inclusive)
	Callsign string    // upper-cased, empty = no filter
}

// ParseStatsQueryParams validates and normalises the query parameters shared by
// all three /stats/* history endpoints.
//
// Accepted parameters (from r.URL.Query()):
//
//	period    — "24h" | "7d" | "30d"  (sets from/to relative to today UTC)
//	from_date — YYYY-MM-DD            (overridden by period)
//	to_date   — YYYY-MM-DD            (defaults to from_date; overridden by period)
//	callsign  — alphanumeric, max 10 chars (case-insensitive)
//
// Returns an error string (non-empty) when validation fails.
func ParseStatsQueryParams(q map[string][]string) (StatsQueryParams, string) {
	get := func(k string) string {
		if v, ok := q[k]; ok && len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}

	var p StatsQueryParams
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	// period shorthand
	switch get("period") {
	case "24h":
		p.FromDate = today.AddDate(0, 0, -1)
		p.ToDate = today
	case "7d":
		p.FromDate = today.AddDate(0, 0, -6)
		p.ToDate = today
	case "30d":
		p.FromDate = today.AddDate(0, 0, -29)
		p.ToDate = today
	case "":
		// use explicit from_date / to_date
		fromStr := get("from_date")
		if fromStr == "" {
			return p, "from_date or period parameter is required (period: 24h|7d|30d; from_date: YYYY-MM-DD)"
		}
		t, err := time.Parse("2006-01-02", fromStr)
		if err != nil {
			return p, "invalid from_date format — use YYYY-MM-DD"
		}
		p.FromDate = t.UTC()

		toStr := get("to_date")
		if toStr == "" {
			p.ToDate = p.FromDate
		} else {
			t2, err := time.Parse("2006-01-02", toStr)
			if err != nil {
				return p, "invalid to_date format — use YYYY-MM-DD"
			}
			p.ToDate = t2.UTC()
		}
	default:
		return p, "invalid period — accepted values: 24h, 7d, 30d"
	}

	if p.ToDate.Before(p.FromDate) {
		return p, "to_date must be on or after from_date"
	}
	days := int(p.ToDate.Sub(p.FromDate).Hours()/24) + 1
	if days > statsMaxDays {
		return p, fmt.Sprintf("date range too large — maximum is %d days", statsMaxDays)
	}

	// callsign filter
	cs := strings.ToUpper(get("callsign"))
	if cs != "" {
		if len(cs) > 10 {
			return p, "callsign too long — maximum 10 characters"
		}
		for _, c := range cs {
			if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '-') {
				return p, "invalid callsign — only alphanumeric characters, '/' and '-' are allowed"
			}
		}
	}
	p.Callsign = cs
	return p, ""
}

// dateRange returns a slice of UTC midnight times from from to to (inclusive).
func dateRange(from, to time.Time) []time.Time {
	var days []time.Time
	cur := from
	for !cur.After(to) {
		days = append(days, cur)
		cur = cur.AddDate(0, 0, 1)
	}
	return days
}

// ---- Read* methods -------------------------------------------------------

// ReadWSPR reads all WSPRRankResponse records from the rolling_24h JSONL files
// for the given date range.  Each line in each file is one record.
func (sl *StatsLogger) ReadWSPR(p StatsQueryParams) ([]WSPRRankResponse, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("stats logging is not enabled")
	}
	var out []WSPRRankResponse
	for _, day := range dateRange(p.FromDate, p.ToDate) {
		path := sl.filePath("wspr", "rolling_24h.jsonl", day)
		f, err := os.Open(path)
		if err != nil {
			continue // no data for this day
		}
		scanner := bufio.NewScanner(f)
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 16*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			var resp WSPRRankResponse
			if err := json.Unmarshal([]byte(line), &resp); err != nil {
				continue
			}
			out = append(out, resp)
		}
		f.Close()
	}
	return out, nil
}

// ReadPSK reads all PSKRankData records from the report_result JSONL files
// for the given date range.
func (sl *StatsLogger) ReadPSK(p StatsQueryParams) ([]PSKRankData, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("stats logging is not enabled")
	}
	var out []PSKRankData
	for _, day := range dateRange(p.FromDate, p.ToDate) {
		path := sl.filePath("psk", "report_result.jsonl", day)
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 16*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			var data PSKRankData
			if err := json.Unmarshal([]byte(line), &data); err != nil {
				continue
			}
			out = append(out, data)
		}
		f.Close()
	}
	return out, nil
}

// RBNHistoryRecord is one day's RBN snapshot returned by ReadRBN.
type RBNHistoryRecord struct {
	FetchedAt     time.Time            `json:"fetched_at"`
	SourceComment string               `json:"source_comment,omitempty"`
	SkewEntries   []RBNSkewEntry       `json:"skew_entries,omitempty"`
	StatsEntries  []RBNStatisticsEntry `json:"stats_entries,omitempty"`
}

// ReadRBN reads all RBN daily snapshots for the given date range.
// Skew and statistics are merged into a single RBNHistoryRecord per day.
func (sl *StatsLogger) ReadRBN(p StatsQueryParams) ([]RBNHistoryRecord, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("stats logging is not enabled")
	}
	var out []RBNHistoryRecord
	for _, day := range dateRange(p.FromDate, p.ToDate) {
		var rec RBNHistoryRecord

		skewPath := sl.filePath("rbn", "skew.jsonl", day)
		var skewRec rbnSkewRecord
		if sl.readLastLine(skewPath, &skewRec) {
			rec.FetchedAt = skewRec.FetchedAt
			rec.SourceComment = skewRec.SourceComment
			rec.SkewEntries = skewRec.Entries
		}

		statsPath := sl.filePath("rbn", "statistics.jsonl", day)
		var statsRec rbnStatsRecord
		if sl.readLastLine(statsPath, &statsRec) {
			if rec.FetchedAt.IsZero() {
				rec.FetchedAt = statsRec.FetchedAt
				rec.SourceComment = statsRec.SourceComment
			}
			rec.StatsEntries = statsRec.Entries
		}

		if rec.FetchedAt.IsZero() {
			continue // no data for this day
		}
		out = append(out, rec)
	}
	return out, nil
}
