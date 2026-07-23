package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// statsMaxDays is the maximum date range allowed for a single history query.
const statsMaxDays = 30

// stats_logger.go — SQLite persistence for WSPR, PSK and RBN fetched stats.
//
// Backs the leaderboard panels of static/stats_history.html via the
// /api/stats/{wspr-rank,psk-rank,rbn} endpoints.
//
// Tables (see db_manager.go initSchema for full column lists):
//
//	wspr_rank_windows / wspr_rank_rows                    — one WSPRRankResponse per hourly fetch
//	psk_rank_snapshots / psk_rank_entries / psk_software  — one PSKRankData per hourly fetch
//	rbn_skew / rbn_stats                                  — one snapshot per UTC day
//
// The read/write SQL lives in stats_logger_db.go; this file holds the public
// surface plus the shared query-parameter parsing.
//
// This subsystem previously wrote JSONL files under <configDir>/stats. Those
// writes are gone — db_import.go backfills the existing trees into SQLite once,
// on the first start after upgrading, and nothing reads them afterwards.

// StatsLogger persists fetched stats for WSPR, PSK and RBN to SQLite.
//
// Both connections are attached after construction (main.go) because DBManager
// and the fetchers are wired up at different points during startup. Until they
// are set, every method is a no-op: writes are dropped and reads return nothing,
// which is the correct behaviour when no database is configured.
type StatsLogger struct {
	db     *sql.DB // write connection — nil until SetDB is called
	readDB *sql.DB // read-only pool — nil until SetReadDB is called
}

// NewStatsLogger creates a StatsLogger. It has no state of its own; call
// SetDB/SetReadDB to make it functional.
func NewStatsLogger() *StatsLogger {
	return &StatsLogger{}
}

// SetDB attaches the write connection used by the Write* methods.
func (sl *StatsLogger) SetDB(db *sql.DB) {
	if sl != nil {
		sl.db = db
	}
}

// SetReadDB attaches the read-only pool used by the Read*/LoadLatest* methods.
func (sl *StatsLogger) SetReadDB(db *sql.DB) {
	if sl != nil {
		sl.readDB = db
	}
}

// ---- WSPR ---------------------------------------------------------------

// WriteWSPR persists the full WSPRRankResponse — all three windows and their
// leaderboard rows — as one snapshot keyed on GeneratedAt.
func (sl *StatsLogger) WriteWSPR(resp *WSPRRankResponse) {
	if resp == nil {
		return
	}
	now := resp.GeneratedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	sl.writeWSPRToDB(resp, now)
}

// LoadLatestWSPR reads the most recent WSPRRankResponse.
// Returns nil if no data is found.
func (sl *StatsLogger) LoadLatestWSPR() *WSPRRankResponse {
	return sl.loadLatestWSPRFromDB()
}

// ---- PSK ----------------------------------------------------------------

// WritePSK persists the PSKRankData as one snapshot keyed on FetchedAt.
func (sl *StatsLogger) WritePSK(data *PSKRankData) {
	if data == nil {
		return
	}
	now := data.FetchedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	sl.writePSKToDB(data, now)
}

// LoadLatestPSK reads the most recent PSKRankData.
// Returns nil if no data is found.
func (sl *StatsLogger) LoadLatestPSK() *PSKRankData {
	return sl.loadLatestPSKFromDB()
}

// ---- RBN ----------------------------------------------------------------

// rbnSkewRecord is the RBN skew snapshot envelope. It is the shape published
// over MQTT (mqtt_publisher.go) and the shape of the legacy skew.jsonl lines
// parsed by db_import.go.
type rbnSkewRecord struct {
	FetchedAt     time.Time      `json:"fetched_at"`
	SourceComment string         `json:"source_comment"`
	Entries       []RBNSkewEntry `json:"entries"`
}

// rbnStatsRecord is the RBN statistics snapshot envelope — see rbnSkewRecord.
type rbnStatsRecord struct {
	FetchedAt     time.Time            `json:"fetched_at"`
	SourceComment string               `json:"source_comment"`
	Entries       []RBNStatisticsEntry `json:"entries"`
}

// WriteRBNSkew replaces the day's RBN skew snapshot with the current data.
// RBN publishes once per day, so each write supersedes the day's previous rows.
func (sl *StatsLogger) WriteRBNSkew(entries map[string]RBNSkewEntry, comment string, fetchedAt time.Time) {
	slice := make([]RBNSkewEntry, 0, len(entries))
	for _, e := range entries {
		slice = append(slice, e)
	}
	sl.writeRBNSkewToDB(slice, comment, fetchedAt)
}

// WriteRBNStats replaces the day's RBN statistics snapshot with the current data.
func (sl *StatsLogger) WriteRBNStats(entries map[string]RBNStatisticsEntry, comment string, fetchedAt time.Time) {
	slice := make([]RBNStatisticsEntry, 0, len(entries))
	for _, e := range entries {
		slice = append(slice, e)
	}
	sl.writeRBNStatsToDB(slice, comment, fetchedAt)
}

// LoadLatestRBNSkew reads the most recent RBN skew snapshot, keyed by callsign.
// Returns a nil map if no data is found.
func (sl *StatsLogger) LoadLatestRBNSkew() (map[string]RBNSkewEntry, string, *time.Time) {
	return sl.loadLatestRBNSkewFromDB()
}

// LoadLatestRBNStats reads the most recent RBN statistics snapshot, keyed by
// callsign. Returns a nil map if no data is found.
func (sl *StatsLogger) LoadLatestRBNStats() (map[string]RBNStatisticsEntry, string, *time.Time) {
	return sl.loadLatestRBNStatsFromDB()
}

// ---- date-range query helpers -------------------------------------------

// StatsQueryParams holds the validated, normalised parameters for a history query.
type StatsQueryParams struct {
	FromDate  time.Time // start of range (UTC midnight)
	ToDate    time.Time // end of range (UTC midnight, inclusive)
	Callsign  string    // upper-cased, empty = no filter
	Callsign2 string    // optional second station to compare against Callsign; requires Callsign
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
//	callsign2 — optional second callsign to compare against the first. Same
//	            validation; requires callsign and must differ from it.
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

	// callsign filters
	cs, errMsg := validateCallsignParam(get("callsign"), "callsign")
	if errMsg != "" {
		return p, errMsg
	}
	cs2, errMsg := validateCallsignParam(get("callsign2"), "callsign2")
	if errMsg != "" {
		return p, errMsg
	}
	if cs2 != "" {
		if cs == "" {
			return p, "callsign2 requires callsign — it selects a second station to compare against the first"
		}
		if cs2 == cs {
			return p, "callsign2 must differ from callsign"
		}
	}
	p.Callsign = cs
	p.Callsign2 = cs2
	return p, ""
}

// validateCallsignParam upper-cases and validates one callsign query value.
// An empty value is valid and means "no filter". name appears in error text so
// the caller learns which parameter was rejected.
func validateCallsignParam(raw, name string) (string, string) {
	cs := strings.ToUpper(raw)
	if cs == "" {
		return "", ""
	}
	if len(cs) > 10 {
		return "", name + " too long — maximum 10 characters"
	}
	for _, c := range cs {
		if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '-') {
			return "", "invalid " + name + " — only alphanumeric characters, '/' and '-' are allowed"
		}
	}
	return cs, ""
}

// ---- Read* methods -------------------------------------------------------

// ReadWSPR returns every WSPRRankResponse snapshot in the given date range,
// oldest first.
func (sl *StatsLogger) ReadWSPR(p StatsQueryParams) ([]WSPRRankResponse, error) {
	if sl == nil || sl.readDB == nil {
		return nil, fmt.Errorf("stats database is not available")
	}
	return sl.readWSPRFromDB(p)
}

// ReadPSK returns every PSKRankData snapshot in the given date range,
// oldest first.
func (sl *StatsLogger) ReadPSK(p StatsQueryParams) ([]PSKRankData, error) {
	if sl == nil || sl.readDB == nil {
		return nil, fmt.Errorf("stats database is not available")
	}
	return sl.readPSKFromDB(p)
}

// ReadWSPRAt returns the single WSPRRankResponse snapshot nearest to at,
// searching both backwards and forwards up to window. Returns (nil, nil) when
// the database holds no snapshot inside that window.
func (sl *StatsLogger) ReadWSPRAt(at time.Time, window time.Duration) (*WSPRRankResponse, error) {
	if sl == nil || sl.readDB == nil {
		return nil, fmt.Errorf("stats database is not available")
	}
	return sl.readWSPRAtFromDB(at, window)
}

// ReadPSKAt returns the single PSKRankData snapshot nearest to at, searching
// both backwards and forwards up to window. Returns (nil, nil) when the
// database holds no snapshot inside that window.
func (sl *StatsLogger) ReadPSKAt(at time.Time, window time.Duration) (*PSKRankData, error) {
	if sl == nil || sl.readDB == nil {
		return nil, fmt.Errorf("stats database is not available")
	}
	return sl.readPSKAtFromDB(at, window)
}

// RBNHistoryRecord is one day's RBN snapshot returned by ReadRBN.
type RBNHistoryRecord struct {
	FetchedAt     time.Time            `json:"fetched_at"`
	SourceComment string               `json:"source_comment,omitempty"`
	SkewEntries   []RBNSkewEntry       `json:"skew_entries,omitempty"`
	StatsEntries  []RBNStatisticsEntry `json:"stats_entries,omitempty"`
}

// ReadRBN returns one merged skew+statistics record per UTC day in the given
// date range, oldest first.
func (sl *StatsLogger) ReadRBN(p StatsQueryParams) ([]RBNHistoryRecord, error) {
	if sl == nil || sl.readDB == nil {
		return nil, fmt.Errorf("stats database is not available")
	}
	return sl.readRBNFromDB(p)
}

// ReadRBNAt returns the single day record nearest to at, searching both
// backwards and forwards up to window. RBN is fetched once per UTC day, so the
// match is day-grained. Returns (nil, nil) when nothing falls inside window.
func (sl *StatsLogger) ReadRBNAt(at time.Time, window time.Duration) (*RBNHistoryRecord, error) {
	if sl == nil || sl.readDB == nil {
		return nil, fmt.Errorf("stats database is not available")
	}
	return sl.readRBNAtFromDB(at, window)
}
