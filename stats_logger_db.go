package main

// stats_logger_db.go — SQLite read/write paths for the WSPR, PSK and RBN
// leaderboard stats that back the /api/stats/* history endpoints.
//
// StatsLogger keeps its JSONL writers (see stats_logger.go); this file adds the
// parallel DB path. Every method here is a no-op (writes) or returns an empty
// result (reads) when the corresponding connection has not been attached via
// SetDB / SetReadDB, so the file-only behaviour is preserved when no DB is
// configured.
//
// Table layout is documented in db_manager.go initSchema:
//
//	wspr_rank_windows / wspr_rank_rows  ← WSPRRankResponse
//	psk_rank_snapshots / psk_rank_entries / psk_software ← PSKRankData
//	rbn_skew / rbn_stats                ← RBNSkewEntry / RBNStatisticsEntry

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// wsprWindowNames is the canonical order of the three windows in a
// WSPRRankResponse. Used for both writing and reassembling.
var wsprWindowNames = []string{"rolling_24h", "yesterday", "today"}

// wsprWindowPtr returns a pointer to the named window inside resp,
// or nil when name is not one of the three known windows.
func wsprWindowPtr(resp *WSPRRankResponse, name string) *WSPRRankWindow {
	switch name {
	case "rolling_24h":
		return &resp.Rolling24h
	case "yesterday":
		return &resp.Yesterday
	case "today":
		return &resp.Today
	}
	return nil
}

// dayBounds returns the [start, end) Unix seconds of the UTC day containing t.
func dayBounds(t time.Time) (int64, int64) {
	u := t.UTC()
	start := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	return start.Unix(), start.AddDate(0, 0, 1).Unix()
}

// rangeBounds returns the [start, end) Unix seconds covering the inclusive
// date range in p (both ends are UTC midnights).
func rangeBounds(p StatsQueryParams) (int64, int64) {
	return p.FromDate.UTC().Unix(), p.ToDate.UTC().AddDate(0, 0, 1).Unix()
}

// marshalJSONCol marshals v to a JSON string for storage in a TEXT column.
// Nil / empty slices become "" so the column stays cheap and the read path
// can skip unmarshalling entirely.
func marshalJSONCol(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil || len(b) == 0 || string(b) == "null" || string(b) == "[]" {
		return ""
	}
	return string(b)
}

// unmarshalJSONCol parses a TEXT column written by marshalJSONCol into v.
// An empty string leaves v untouched (it stays the zero value / nil slice).
func unmarshalJSONCol(s string, v interface{}) {
	if s == "" {
		return
	}
	if err := json.Unmarshal([]byte(s), v); err != nil {
		log.Printf("[StatsLogger] DB: unmarshal column: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// WSPR — write
// ─────────────────────────────────────────────────────────────────────────────

// writeWSPRToDB replaces the snapshot at generatedAt with resp.
// The three windows and all their leaderboard rows are written in a single
// transaction so a reader never sees a half-written snapshot.
// Errors are logged, not returned: a lost hourly snapshot must not disturb the
// fetcher, and the next fetch supersedes it an hour later.
func (sl *StatsLogger) writeWSPRToDB(resp *WSPRRankResponse, generatedAt time.Time) {
	if sl == nil || sl.db == nil || resp == nil {
		return
	}
	if err := sl.writeWSPRTx(resp, generatedAt); err != nil {
		log.Printf("[StatsLogger] WriteWSPR: %v", err)
	}
}

func (sl *StatsLogger) writeWSPRTx(resp *WSPRRankResponse, generatedAt time.Time) error {
	ts := generatedAt.UTC().Unix()

	tx, err := sl.db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op after a successful Commit

	// Replace any existing snapshot for this exact generated_at.
	if _, err := tx.Exec(`DELETE FROM wspr_rank_rows WHERE ts = ?`, ts); err != nil {
		return fmt.Errorf("delete rows: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM wspr_rank_windows WHERE ts = ?`, ts); err != nil {
		return fmt.Errorf("delete windows: %w", err)
	}

	winStmt, err := tx.Prepare(`INSERT INTO wspr_rank_windows
		(ts, window_name, fetched_at, fetched_ms, row_count, error)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare window: %w", err)
	}
	defer winStmt.Close()

	rowStmt, err := tx.Prepare(`INSERT INTO wspr_rank_rows
		(ts, window_name, rank_pos, rx_sign, rx_loc, raw, dupe, unique_count,
		 bands, uniques, gross, dupes, versions)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare row: %w", err)
	}
	defer rowStmt.Close()

	for _, name := range wsprWindowNames {
		win := wsprWindowPtr(resp, name)
		if win == nil {
			continue
		}
		var fetchedAt interface{}
		if !win.FetchedAt.IsZero() {
			fetchedAt = win.FetchedAt.UTC().Unix()
		}
		if _, err := winStmt.Exec(ts, name, fetchedAt, win.FetchedMs, win.Rows, win.Error); err != nil {
			return fmt.Errorf("insert window %s: %w", name, err)
		}
		for i, row := range win.Data {
			if _, err := rowStmt.Exec(
				ts, name, i,
				row.RxSign, row.RxLoc,
				int64(row.Raw), int64(row.Dupe), int64(row.Unique),
				marshalJSONCol(row.Bands), marshalJSONCol(row.Uniques),
				marshalJSONCol(row.Gross), marshalJSONCol(row.Dupes),
				marshalJSONCol(row.Versions),
			); err != nil {
				return fmt.Errorf("insert row %s/%d: %w", name, i, err)
			}
		}
	}

	return tx.Commit()
}

// ─────────────────────────────────────────────────────────────────────────────
// WSPR — read
// ─────────────────────────────────────────────────────────────────────────────

// readWSPRFromDB returns every snapshot whose generated_at falls in p's date
// range, oldest first, reassembled into the same shape the JSONL files hold.
func (sl *StatsLogger) readWSPRFromDB(p StatsQueryParams) ([]WSPRRankResponse, error) {
	if sl == nil || sl.readDB == nil {
		return nil, nil
	}
	from, to := rangeBounds(p)
	return sl.loadWSPRSnapshots(`ts >= ? AND ts < ?`, from, to)
}

// loadLatestWSPRFromDB returns the most recent snapshot, or nil when the
// tables are empty or no DB is attached.
func (sl *StatsLogger) loadLatestWSPRFromDB() *WSPRRankResponse {
	if sl == nil || sl.readDB == nil {
		return nil
	}
	var ts sql.NullInt64
	if err := sl.readDB.QueryRow(`SELECT MAX(ts) FROM wspr_rank_windows`).Scan(&ts); err != nil {
		log.Printf("[StatsLogger] DB: latest WSPR ts: %v", err)
		return nil
	}
	if !ts.Valid {
		return nil
	}
	out, err := sl.loadWSPRSnapshots(`ts = ?`, ts.Int64)
	if err != nil {
		log.Printf("[StatsLogger] DB: load latest WSPR: %v", err)
		return nil
	}
	if len(out) == 0 {
		return nil
	}
	resp := out[len(out)-1]
	log.Printf("[StatsLogger] Loaded WSPR cache from DB (generated_at=%s)", resp.GeneratedAt.Format(time.RFC3339))
	return &resp
}

// loadWSPRSnapshots is the shared assembly routine: it runs the same WHERE
// clause against both WSPR tables and stitches the results back into
// WSPRRankResponse values ordered oldest first.
func (sl *StatsLogger) loadWSPRSnapshots(where string, args ...interface{}) ([]WSPRRankResponse, error) {
	// Pass 1 — window envelopes. This also establishes which snapshots exist
	// and in what order, so a window with zero rows is still represented.
	winRows, err := sl.readDB.Query(`
		SELECT ts, window_name, fetched_at, fetched_ms, row_count, error
		FROM wspr_rank_windows
		WHERE `+where+`
		ORDER BY ts`, args...)
	if err != nil {
		return nil, fmt.Errorf("query wspr_rank_windows: %w", err)
	}
	defer winRows.Close()

	byTS := make(map[int64]*WSPRRankResponse)
	var order []int64

	for winRows.Next() {
		var (
			ts         int64
			name       string
			fetchedAt  sql.NullInt64
			fetchedMs  sql.NullInt64
			rowCount   sql.NullInt64
			errMessage sql.NullString
		)
		if err := winRows.Scan(&ts, &name, &fetchedAt, &fetchedMs, &rowCount, &errMessage); err != nil {
			return nil, fmt.Errorf("scan wspr_rank_windows: %w", err)
		}
		resp, ok := byTS[ts]
		if !ok {
			resp = &WSPRRankResponse{GeneratedAt: time.Unix(ts, 0).UTC()}
			byTS[ts] = resp
			order = append(order, ts)
		}
		win := wsprWindowPtr(resp, name)
		if win == nil {
			continue // unknown window name — ignore rather than fail the query
		}
		if fetchedAt.Valid {
			win.FetchedAt = time.Unix(fetchedAt.Int64, 0).UTC()
		}
		win.FetchedMs = fetchedMs.Int64
		win.Rows = int(rowCount.Int64)
		win.Error = errMessage.String
	}
	if err := winRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate wspr_rank_windows: %w", err)
	}
	if len(order) == 0 {
		return nil, nil
	}

	// Pass 2 — leaderboard rows, in stored order so rank == index+1 holds.
	dataRows, err := sl.readDB.Query(`
		SELECT ts, window_name, rx_sign, rx_loc, raw, dupe, unique_count,
		       bands, uniques, gross, dupes, versions
		FROM wspr_rank_rows
		WHERE `+where+`
		ORDER BY ts, window_name, rank_pos`, args...)
	if err != nil {
		return nil, fmt.Errorf("query wspr_rank_rows: %w", err)
	}
	defer dataRows.Close()

	for dataRows.Next() {
		var (
			ts                                 int64
			name                               string
			rxSign                             string
			rxLoc                              sql.NullString
			raw, dupe, uniq                    sql.NullInt64
			bands, uniques, gross, dupes, vers sql.NullString
		)
		if err := dataRows.Scan(&ts, &name, &rxSign, &rxLoc, &raw, &dupe, &uniq,
			&bands, &uniques, &gross, &dupes, &vers); err != nil {
			return nil, fmt.Errorf("scan wspr_rank_rows: %w", err)
		}
		resp, ok := byTS[ts]
		if !ok {
			continue // row without an envelope — should not happen
		}
		win := wsprWindowPtr(resp, name)
		if win == nil {
			continue
		}
		row := WSPRRankRow{
			RxSign: rxSign,
			RxLoc:  rxLoc.String,
			Raw:    uint64(raw.Int64),
			Dupe:   uint64(dupe.Int64),
			Unique: uint64(uniq.Int64),
		}
		unmarshalJSONCol(bands.String, &row.Bands)
		unmarshalJSONCol(uniques.String, &row.Uniques)
		unmarshalJSONCol(gross.String, &row.Gross)
		unmarshalJSONCol(dupes.String, &row.Dupes)
		unmarshalJSONCol(vers.String, &row.Versions)
		win.Data = append(win.Data, row)
	}
	if err := dataRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate wspr_rank_rows: %w", err)
	}

	out := make([]WSPRRankResponse, 0, len(order))
	for _, ts := range order {
		out = append(out, *byTS[ts])
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// PSK — write
// ─────────────────────────────────────────────────────────────────────────────

// pskResultTypes maps the DB result_type discriminator to the corresponding
// field of PSKRankData.
func pskResultTypes(data *PSKRankData) map[string]PSKMonitorsByBand {
	return map[string]PSKMonitorsByBand{
		"report":  data.ReportResult,
		"country": data.CountryResult,
	}
}

// writePSKToDB replaces the snapshot at fetchedAt with data.
// Errors are logged, not returned — see writeWSPRToDB.
func (sl *StatsLogger) writePSKToDB(data *PSKRankData, fetchedAt time.Time) {
	if sl == nil || sl.db == nil || data == nil {
		return
	}
	if err := sl.writePSKTx(data, fetchedAt); err != nil {
		log.Printf("[StatsLogger] WritePSK: %v", err)
	}
}

func (sl *StatsLogger) writePSKTx(data *PSKRankData, fetchedAt time.Time) error {
	ts := fetchedAt.UTC().Unix()

	tx, err := sl.db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op after a successful Commit

	for _, table := range []string{"psk_rank_entries", "psk_software", "psk_rank_snapshots"} {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE ts = ?`, ts); err != nil {
			return fmt.Errorf("delete %s: %w", table, err)
		}
	}

	if _, err := tx.Exec(`INSERT INTO psk_rank_snapshots (ts, fetched_ms, error) VALUES (?, ?, ?)`,
		ts, data.FetchedMs, data.Error); err != nil {
		return fmt.Errorf("insert snapshot: %w", err)
	}

	entStmt, err := tx.Prepare(`INSERT INTO psk_rank_entries
		(ts, result_type, band, rank_pos, callsign, day_count, week_count)
		VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare entry: %w", err)
	}
	defer entStmt.Close()

	for resultType, byBand := range pskResultTypes(data) {
		for band, entries := range byBand {
			for i, e := range entries {
				if _, err := entStmt.Exec(ts, resultType, band, i, e.Callsign, e.Day, e.Week); err != nil {
					return fmt.Errorf("insert entry %s/%s/%d: %w", resultType, band, i, err)
				}
			}
		}
	}

	if len(data.SoftwareInUse) > 0 {
		swStmt, err := tx.Prepare(`INSERT OR IGNORE INTO psk_software
			(ts, callsign, name, version) VALUES (?, ?, ?, ?)`)
		if err != nil {
			return fmt.Errorf("prepare software: %w", err)
		}
		defer swStmt.Close()
		for callsign, list := range data.SoftwareInUse {
			for _, sw := range list {
				if _, err := swStmt.Exec(ts, callsign, sw.Name, sw.Version); err != nil {
					return fmt.Errorf("insert software %s: %w", callsign, err)
				}
			}
		}
	}

	return tx.Commit()
}

// ─────────────────────────────────────────────────────────────────────────────
// PSK — read
// ─────────────────────────────────────────────────────────────────────────────

// readPSKFromDB returns every snapshot in p's date range, oldest first.
func (sl *StatsLogger) readPSKFromDB(p StatsQueryParams) ([]PSKRankData, error) {
	if sl == nil || sl.readDB == nil {
		return nil, nil
	}
	from, to := rangeBounds(p)
	return sl.loadPSKSnapshots(`ts >= ? AND ts < ?`, from, to)
}

// loadLatestPSKFromDB returns the most recent snapshot, or nil when the tables
// are empty or no DB is attached.
func (sl *StatsLogger) loadLatestPSKFromDB() *PSKRankData {
	if sl == nil || sl.readDB == nil {
		return nil
	}
	var ts sql.NullInt64
	if err := sl.readDB.QueryRow(`SELECT MAX(ts) FROM psk_rank_snapshots`).Scan(&ts); err != nil {
		log.Printf("[StatsLogger] DB: latest PSK ts: %v", err)
		return nil
	}
	if !ts.Valid {
		return nil
	}
	out, err := sl.loadPSKSnapshots(`ts = ?`, ts.Int64)
	if err != nil {
		log.Printf("[StatsLogger] DB: load latest PSK: %v", err)
		return nil
	}
	if len(out) == 0 {
		return nil
	}
	data := out[len(out)-1]
	log.Printf("[StatsLogger] Loaded PSK cache from DB (fetched_at=%s)", data.FetchedAt.Format(time.RFC3339))
	return &data
}

// loadPSKSnapshots runs the same WHERE clause against all three PSK tables and
// reassembles PSKRankData values ordered oldest first.
func (sl *StatsLogger) loadPSKSnapshots(where string, args ...interface{}) ([]PSKRankData, error) {
	snapRows, err := sl.readDB.Query(`
		SELECT ts, fetched_ms, error
		FROM psk_rank_snapshots
		WHERE `+where+`
		ORDER BY ts`, args...)
	if err != nil {
		return nil, fmt.Errorf("query psk_rank_snapshots: %w", err)
	}
	defer snapRows.Close()

	byTS := make(map[int64]*PSKRankData)
	var order []int64

	for snapRows.Next() {
		var (
			ts         int64
			fetchedMs  sql.NullInt64
			errMessage sql.NullString
		)
		if err := snapRows.Scan(&ts, &fetchedMs, &errMessage); err != nil {
			return nil, fmt.Errorf("scan psk_rank_snapshots: %w", err)
		}
		byTS[ts] = &PSKRankData{
			FetchedAt:     time.Unix(ts, 0).UTC(),
			FetchedMs:     fetchedMs.Int64,
			Error:         errMessage.String,
			ReportResult:  make(PSKMonitorsByBand),
			CountryResult: make(PSKMonitorsByBand),
		}
		order = append(order, ts)
	}
	if err := snapRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate psk_rank_snapshots: %w", err)
	}
	if len(order) == 0 {
		return nil, nil
	}

	entRows, err := sl.readDB.Query(`
		SELECT ts, result_type, band, callsign, day_count, week_count
		FROM psk_rank_entries
		WHERE `+where+`
		ORDER BY ts, result_type, band, rank_pos`, args...)
	if err != nil {
		return nil, fmt.Errorf("query psk_rank_entries: %w", err)
	}
	defer entRows.Close()

	for entRows.Next() {
		var (
			ts               int64
			resultType, band string
			callsign         string
			day, week        sql.NullInt64
		)
		if err := entRows.Scan(&ts, &resultType, &band, &callsign, &day, &week); err != nil {
			return nil, fmt.Errorf("scan psk_rank_entries: %w", err)
		}
		data, ok := byTS[ts]
		if !ok {
			continue
		}
		target := data.ReportResult
		if resultType == "country" {
			target = data.CountryResult
		}
		target[band] = append(target[band], PSKMonitorEntry{
			Callsign: callsign,
			Day:      int(day.Int64),
			Week:     int(week.Int64),
		})
	}
	if err := entRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate psk_rank_entries: %w", err)
	}

	swRows, err := sl.readDB.Query(`
		SELECT ts, callsign, name, version
		FROM psk_software
		WHERE `+where+`
		ORDER BY ts, callsign, name`, args...)
	if err != nil {
		return nil, fmt.Errorf("query psk_software: %w", err)
	}
	defer swRows.Close()

	for swRows.Next() {
		var (
			ts       int64
			callsign string
			name     string
			version  sql.NullString
		)
		if err := swRows.Scan(&ts, &callsign, &name, &version); err != nil {
			return nil, fmt.Errorf("scan psk_software: %w", err)
		}
		data, ok := byTS[ts]
		if !ok {
			continue
		}
		if data.SoftwareInUse == nil {
			data.SoftwareInUse = make(map[string][]PSKSoftwareEntry)
		}
		data.SoftwareInUse[callsign] = append(data.SoftwareInUse[callsign],
			PSKSoftwareEntry{Name: name, Version: version.String})
	}
	if err := swRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate psk_software: %w", err)
	}

	out := make([]PSKRankData, 0, len(order))
	for _, ts := range order {
		out = append(out, *byTS[ts])
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// RBN — write
// ─────────────────────────────────────────────────────────────────────────────

// writeRBNSkewToDB replaces the day's skew snapshot, mirroring the O_TRUNC
// semantics of the JSONL writer (one snapshot per UTC day).
func (sl *StatsLogger) writeRBNSkewToDB(entries []RBNSkewEntry, comment string, fetchedAt time.Time) {
	if sl == nil || sl.db == nil {
		return
	}
	if err := sl.writeRBNSkewTx(entries, comment, fetchedAt); err != nil {
		log.Printf("[StatsLogger] WriteRBNSkew: %v", err)
	}
}

func (sl *StatsLogger) writeRBNSkewTx(entries []RBNSkewEntry, comment string, fetchedAt time.Time) error {
	ts := fetchedAt.UTC().Unix()
	dayStart, dayEnd := dayBounds(fetchedAt)

	tx, err := sl.db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op after a successful Commit

	if _, err := tx.Exec(`DELETE FROM rbn_skew WHERE ts >= ? AND ts < ?`, dayStart, dayEnd); err != nil {
		return fmt.Errorf("delete day: %w", err)
	}

	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO rbn_skew
		(ts, source_comment, callsign, skew, spots, correction_factor)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for _, e := range entries {
		if _, err := stmt.Exec(ts, comment, e.Callsign, e.Skew, e.Spots, e.CorrectionFactor); err != nil {
			return fmt.Errorf("insert %s: %w", e.Callsign, err)
		}
	}

	return tx.Commit()
}

// writeRBNStatsToDB replaces the day's statistics snapshot.
func (sl *StatsLogger) writeRBNStatsToDB(entries []RBNStatisticsEntry, comment string, fetchedAt time.Time) {
	if sl == nil || sl.db == nil {
		return
	}
	if err := sl.writeRBNStatsTx(entries, comment, fetchedAt); err != nil {
		log.Printf("[StatsLogger] WriteRBNStats: %v", err)
	}
}

func (sl *StatsLogger) writeRBNStatsTx(entries []RBNStatisticsEntry, comment string, fetchedAt time.Time) error {
	ts := fetchedAt.UTC().Unix()
	dayStart, dayEnd := dayBounds(fetchedAt)

	tx, err := sl.db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op after a successful Commit

	if _, err := tx.Exec(`DELETE FROM rbn_stats WHERE ts >= ? AND ts < ?`, dayStart, dayEnd); err != nil {
		return fmt.Errorf("delete day: %w", err)
	}

	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO rbn_stats
		(ts, source_comment, callsign, epoch_date, spot_count)
		VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for _, e := range entries {
		if _, err := stmt.Exec(ts, comment, e.Callsign, e.EpochDate, e.SpotCount); err != nil {
			return fmt.Errorf("insert %s: %w", e.Callsign, err)
		}
	}

	return tx.Commit()
}

// ─────────────────────────────────────────────────────────────────────────────
// RBN — read
// ─────────────────────────────────────────────────────────────────────────────

// rbnDaySnapshot accumulates one UTC day's skew and statistics entries while
// the two queries are being merged.
type rbnDaySnapshot struct {
	day     int64 // UTC midnight, used only for ordering
	rec     RBNHistoryRecord
	haveAny bool
}

// readRBNFromDB returns one merged skew+statistics record per UTC day in p's
// date range, oldest first — the same shape ReadRBN builds from the files.
func (sl *StatsLogger) readRBNFromDB(p StatsQueryParams) ([]RBNHistoryRecord, error) {
	if sl == nil || sl.readDB == nil {
		return nil, nil
	}
	from, to := rangeBounds(p)

	byDay := make(map[int64]*rbnDaySnapshot)
	var order []int64

	// get returns the accumulator for the UTC day containing ts, creating it
	// (and recording its position in the output order) on first use.
	get := func(ts int64) *rbnDaySnapshot {
		dayStart, _ := dayBounds(time.Unix(ts, 0).UTC())
		s, ok := byDay[dayStart]
		if !ok {
			s = &rbnDaySnapshot{day: dayStart}
			byDay[dayStart] = s
			order = append(order, dayStart)
		}
		return s
	}

	skewRows, err := sl.readDB.Query(`
		SELECT ts, source_comment, callsign, skew, spots, correction_factor
		FROM rbn_skew
		WHERE ts >= ? AND ts < ?
		ORDER BY ts, id`, from, to)
	if err != nil {
		return nil, fmt.Errorf("query rbn_skew: %w", err)
	}
	defer skewRows.Close()

	for skewRows.Next() {
		var (
			ts         int64
			comment    sql.NullString
			callsign   string
			skew       sql.NullFloat64
			spots      sql.NullInt64
			correction sql.NullFloat64
		)
		if err := skewRows.Scan(&ts, &comment, &callsign, &skew, &spots, &correction); err != nil {
			return nil, fmt.Errorf("scan rbn_skew: %w", err)
		}
		s := get(ts)
		if !s.haveAny {
			s.rec.FetchedAt = time.Unix(ts, 0).UTC()
			s.rec.SourceComment = comment.String
			s.haveAny = true
		}
		s.rec.SkewEntries = append(s.rec.SkewEntries, RBNSkewEntry{
			Callsign:         callsign,
			Skew:             skew.Float64,
			Spots:            int(spots.Int64),
			CorrectionFactor: correction.Float64,
		})
	}
	if err := skewRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rbn_skew: %w", err)
	}

	statsRows, err := sl.readDB.Query(`
		SELECT ts, source_comment, callsign, epoch_date, spot_count
		FROM rbn_stats
		WHERE ts >= ? AND ts < ?
		ORDER BY ts, id`, from, to)
	if err != nil {
		return nil, fmt.Errorf("query rbn_stats: %w", err)
	}
	defer statsRows.Close()

	for statsRows.Next() {
		var (
			ts        int64
			comment   sql.NullString
			callsign  string
			epochDate sql.NullInt64
			spotCount sql.NullInt64
		)
		if err := statsRows.Scan(&ts, &comment, &callsign, &epochDate, &spotCount); err != nil {
			return nil, fmt.Errorf("scan rbn_stats: %w", err)
		}
		s := get(ts)
		if !s.haveAny {
			s.rec.FetchedAt = time.Unix(ts, 0).UTC()
			s.rec.SourceComment = comment.String
			s.haveAny = true
		}
		s.rec.StatsEntries = append(s.rec.StatsEntries, RBNStatisticsEntry{
			Callsign:  callsign,
			EpochDate: int(epochDate.Int64),
			SpotCount: int(spotCount.Int64),
		})
	}
	if err := statsRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rbn_stats: %w", err)
	}

	out := make([]RBNHistoryRecord, 0, len(order))
	for _, day := range order {
		if s := byDay[day]; s.haveAny {
			out = append(out, s.rec)
		}
	}
	return out, nil
}

// loadLatestRBNSkewFromDB returns the most recent skew snapshot keyed by
// callsign, or a nil map when the table is empty or no DB is attached.
func (sl *StatsLogger) loadLatestRBNSkewFromDB() (map[string]RBNSkewEntry, string, *time.Time) {
	if sl == nil || sl.readDB == nil {
		return nil, "", nil
	}
	var ts sql.NullInt64
	if err := sl.readDB.QueryRow(`SELECT MAX(ts) FROM rbn_skew`).Scan(&ts); err != nil {
		log.Printf("[StatsLogger] DB: latest RBN skew ts: %v", err)
		return nil, "", nil
	}
	if !ts.Valid {
		return nil, "", nil
	}

	rows, err := sl.readDB.Query(`
		SELECT source_comment, callsign, skew, spots, correction_factor
		FROM rbn_skew WHERE ts = ?`, ts.Int64)
	if err != nil {
		log.Printf("[StatsLogger] DB: load RBN skew: %v", err)
		return nil, "", nil
	}
	defer rows.Close()

	m := make(map[string]RBNSkewEntry)
	var comment string
	for rows.Next() {
		var (
			c          sql.NullString
			callsign   string
			skew       sql.NullFloat64
			spots      sql.NullInt64
			correction sql.NullFloat64
		)
		if err := rows.Scan(&c, &callsign, &skew, &spots, &correction); err != nil {
			log.Printf("[StatsLogger] DB: scan RBN skew: %v", err)
			return nil, "", nil
		}
		comment = c.String
		m[callsign] = RBNSkewEntry{
			Callsign:         callsign,
			Skew:             skew.Float64,
			Spots:            int(spots.Int64),
			CorrectionFactor: correction.Float64,
		}
	}
	if len(m) == 0 {
		return nil, "", nil
	}
	at := time.Unix(ts.Int64, 0).UTC()
	log.Printf("[StatsLogger] Loaded RBN skew from DB (%d entries)", len(m))
	return m, comment, &at
}

// loadLatestRBNStatsFromDB returns the most recent statistics snapshot keyed by
// callsign, or a nil map when the table is empty or no DB is attached.
func (sl *StatsLogger) loadLatestRBNStatsFromDB() (map[string]RBNStatisticsEntry, string, *time.Time) {
	if sl == nil || sl.readDB == nil {
		return nil, "", nil
	}
	var ts sql.NullInt64
	if err := sl.readDB.QueryRow(`SELECT MAX(ts) FROM rbn_stats`).Scan(&ts); err != nil {
		log.Printf("[StatsLogger] DB: latest RBN stats ts: %v", err)
		return nil, "", nil
	}
	if !ts.Valid {
		return nil, "", nil
	}

	rows, err := sl.readDB.Query(`
		SELECT source_comment, callsign, epoch_date, spot_count
		FROM rbn_stats WHERE ts = ?`, ts.Int64)
	if err != nil {
		log.Printf("[StatsLogger] DB: load RBN stats: %v", err)
		return nil, "", nil
	}
	defer rows.Close()

	m := make(map[string]RBNStatisticsEntry)
	var comment string
	for rows.Next() {
		var (
			c         sql.NullString
			callsign  string
			epochDate sql.NullInt64
			spotCount sql.NullInt64
		)
		if err := rows.Scan(&c, &callsign, &epochDate, &spotCount); err != nil {
			log.Printf("[StatsLogger] DB: scan RBN stats: %v", err)
			return nil, "", nil
		}
		comment = c.String
		m[callsign] = RBNStatisticsEntry{
			Callsign:  callsign,
			EpochDate: int(epochDate.Int64),
			SpotCount: int(spotCount.Int64),
		}
	}
	if len(m) == 0 {
		return nil, "", nil
	}
	at := time.Unix(ts.Int64, 0).UTC()
	log.Printf("[StatsLogger] Loaded RBN statistics from DB (%d entries)", len(m))
	return m, comment, &at
}
