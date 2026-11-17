package main

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// pskFixture is a scrape with more than one band and table, a callsign with
// several software entries in unsorted order plus a duplicate, and an empty
// band — the cases where the stored form differs from the input.
func pskFixture(ts time.Time) *PSKRankData {
	return &PSKRankData{
		FetchedAt: ts,
		FetchedMs: 321,
		ReportResult: PSKMonitorsByBand{
			"All": {{Callsign: "G0AAA", Day: 900, Week: 5000}, {Callsign: "M9PSY", Day: 500, Week: 3000}},
			"20m": {{Callsign: "M9PSY", Day: 300, Week: 900}},
			"40m": {},
		},
		CountryResult: PSKMonitorsByBand{
			"All": {{Callsign: "K1ABC", Day: 90, Week: 120}},
		},
		SoftwareInUse: map[string][]PSKSoftwareEntry{
			"M9PSY": {{Name: "UberSDR", Version: "0.2.0"}, {Name: "JTDX"}, {Name: "UberSDR", Version: "0.1.0"}},
			"G0AAA": {{Name: "WSJT-X", Version: "2.7"}, {Name: "WSJT-X", Version: "2.7"}},
		},
	}
}

func TestPSKStoreOneRowPerScrapeAndNormalises(t *testing.T) {
	sl, mgr := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 14, 0, 0, 0, time.UTC)
	sl.WritePSK(pskFixture(ts))

	var rows int
	if err := mgr.DB().QueryRow(`SELECT COUNT(*) FROM psk_snapshots`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("psk_snapshots holds %d rows for one scrape, want 1", rows)
	}

	got := sl.LoadLatestPSK()
	if got == nil {
		t.Fatal("LoadLatestPSK returned nil")
	}
	want := pskFixture(ts)
	delete(want.ReportResult, "40m") // empty bands were never readable
	want.SoftwareInUse = map[string][]PSKSoftwareEntry{
		"M9PSY": {{Name: "JTDX"}, {Name: "UberSDR", Version: "0.1.0"}, {Name: "UberSDR", Version: "0.2.0"}},
		"G0AAA": {{Name: "WSJT-X", Version: "2.7"}},
	}
	if !reflect.DeepEqual(*got, *want) {
		t.Errorf("round trip:\n got %+v\nwant %+v", *got, *want)
	}

	// The caller's data must not be reordered by the write.
	in := pskFixture(ts)
	sl.WritePSK(in)
	if in.SoftwareInUse["M9PSY"][0].Version != "0.2.0" {
		t.Error("WritePSK sorted the caller's software slice in place")
	}
}

func TestPSKStoreRewriteAndFailedScrape(t *testing.T) {
	sl, mgr := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 14, 0, 0, 0, time.UTC)

	sl.WritePSK(pskFixture(ts))
	// Same ts again, now a failed scrape: it must replace, not add.
	sl.WritePSK(&PSKRankData{FetchedAt: ts, FetchedMs: 5, Error: "HTTP 503"})

	var rows int
	if err := mgr.DB().QueryRow(`SELECT COUNT(*) FROM psk_snapshots`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("got %d rows after rewriting one ts, want 1", rows)
	}

	got, err := sl.ReadPSK(paramsFor(ts))
	if err != nil || len(got) != 1 {
		t.Fatalf("ReadPSK: %v, %d snapshots", err, len(got))
	}
	want := PSKRankData{
		FetchedAt: ts, FetchedMs: 5, Error: "HTTP 503",
		ReportResult: PSKMonitorsByBand{}, CountryResult: PSKMonitorsByBand{},
	}
	if !reflect.DeepEqual(got[0], want) {
		t.Errorf("failed scrape:\n got %+v\nwant %+v", got[0], want)
	}
}

func TestPSKStoreRangeOrderAndNearest(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	base := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	// Written out of order; reads must come back oldest first.
	for _, h := range []int{2, 0, 1} {
		d := pskFixture(base.Add(time.Duration(h) * time.Hour))
		d.FetchedMs = int64(h)
		sl.WritePSK(d)
	}
	// Next day: outside a single-day range.
	sl.WritePSK(pskFixture(base.Add(24 * time.Hour)))

	got, err := sl.ReadPSK(paramsFor(base))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d snapshots, want 3", len(got))
	}
	for i, d := range got {
		if d.FetchedMs != int64(i) {
			t.Errorf("snapshot %d has fetched_ms %d — not in ts order", i, d.FetchedMs)
		}
	}

	// Equidistant from 10:00 and 11:00: the earlier one wins.
	at, err := sl.ReadPSKAt(base.Add(30*time.Minute), time.Hour)
	if err != nil || at == nil || at.FetchedMs != 0 {
		t.Errorf("ReadPSKAt tie: %+v, %v; want the 10:00 snapshot", at, err)
	}
	at, err = sl.ReadPSKAt(base.Add(100*time.Minute), time.Hour)
	if err != nil || at == nil || at.FetchedMs != 2 {
		t.Errorf("ReadPSKAt 11:40: %+v, %v; want the 12:00 snapshot", at, err)
	}
	if at, _ := sl.ReadPSKAt(base.Add(-3*time.Hour), time.Hour); at != nil {
		t.Errorf("ReadPSKAt outside window returned %s", at.FetchedAt)
	}
}

func TestPSKStoreSkipsUndecodableRow(t *testing.T) {
	sl, mgr := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	sl.WritePSK(pskFixture(ts))
	if _, err := mgr.DB().Exec(`INSERT INTO psk_snapshots (ts, encoding, boards) VALUES (?, 1, x'00ff')`,
		ts.Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	got, err := sl.ReadPSK(paramsFor(ts))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Errorf("got %d snapshots, want the 1 good one", len(got))
	}
}

func TestStationRankingsHistoryFromPSKStore(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	day := time.Now().UTC().AddDate(0, 0, -1)
	base := time.Date(day.Year(), day.Month(), day.Day(), 10, 0, 0, 0, time.UTC)
	sl.WritePSK(pskFixture(base))
	sl.WritePSK(pskFixture(base.Add(time.Hour)))

	cfg := &Config{}
	cfg.Decoder.ReceiverCallsign = "M9PSY"
	m := newTestMCPServer(t, cfg, nil, nil)
	m.StatsLogger = sl

	var got map[string]interface{}
	resultJSON(t, callTool(t, m, "get_station_rankings", "127.0.0.1", map[string]interface{}{"history": "7d"}), &got)
	hist, _ := got["history"].(map[string]interface{})
	points, _ := hist["psk_reporter"].([]interface{})
	if len(points) != 1 { // 7d keeps the last snapshot of each UTC day
		t.Fatalf("psk_reporter history %v, want one point", hist["psk_reporter"])
	}
	p := points[0].(map[string]interface{})
	if p["at"] != base.Add(time.Hour).Format(time.RFC3339) {
		t.Errorf("point at %v, want the day's last snapshot", p["at"])
	}
	rank := p["rank"].(map[string]interface{})
	all := rank["reports"].(map[string]interface{})["All"].(map[string]interface{})
	if all["rank"].(float64) != 2 || all["day"].(float64) != 500 {
		t.Errorf("All-band report rank %v, want rank 2 day 500", all)
	}
}

// createLegacyPSKTables lays down the pre-psk_snapshots schema with n rows in
// psk_rank_entries.
func createLegacyPSKTables(t *testing.T, db *sql.DB, n int) {
	t.Helper()
	for _, ddl := range []string{
		`CREATE TABLE psk_rank_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL UNIQUE, fetched_ms INTEGER, error TEXT)`,
		`CREATE TABLE psk_rank_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, result_type TEXT NOT NULL,
			band TEXT NOT NULL, rank_pos INTEGER NOT NULL, callsign TEXT NOT NULL, day_count INTEGER, week_count INTEGER,
			UNIQUE(ts, result_type, band, rank_pos))`,
		`CREATE TABLE psk_software (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, callsign TEXT NOT NULL,
			name TEXT NOT NULL, version TEXT, UNIQUE(ts, callsign, name, version))`,
	} {
		if _, err := db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		if _, err := tx.Exec(`INSERT INTO psk_rank_entries (ts, result_type, band, rank_pos, callsign, day_count, week_count)
			VALUES (?, 'report', '20m', ?, ?, 1, 2)`, i/100, i%100, fmt.Sprintf("C%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO psk_rank_snapshots (ts) VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO psk_software (ts, callsign, name) VALUES (1, 'M9PSY', 'UberSDR')`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func tableExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}

func TestDropLegacyPSKTables(t *testing.T) {
	sl, mgr := newTestStatsLogger(t)
	db := mgr.DB()
	createLegacyPSKTables(t, db, 2_345)

	// Live data in the new table and an unrelated table must survive.
	ts := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	sl.WritePSK(pskFixture(ts))
	sl.WriteWSPR(&WSPRRankResponse{GeneratedAt: ts, Rolling24h: WSPRRankWindow{FetchedAt: ts, Rows: 1,
		Data: []WSPRRankRow{{RxSign: "M9PSY"}}}})

	// A cancelled run stops part-way and leaves the rest for the next start.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dropLegacyPSKTables(ctx, db, 100, 0)
	if !tableExists(t, db, "psk_rank_entries") {
		t.Fatal("a cancelled run dropped psk_rank_entries")
	}

	// Batches smaller than the table, so several DELETE rounds run.
	dropLegacyPSKTables(context.Background(), db, 1_000, time.Millisecond)
	for _, table := range legacyPSKTables {
		if tableExists(t, db, table) {
			t.Errorf("%s still exists", table)
		}
	}

	// Idempotent: a second run finds nothing to do and touches nothing.
	dropLegacyPSKTables(context.Background(), db, 1_000, time.Millisecond)

	if got := sl.LoadLatestPSK(); got == nil || got.FetchedAt != ts {
		t.Errorf("psk_snapshots lost its row: %+v", got)
	}
	if w, err := sl.ReadWSPR(paramsFor(ts)); err != nil || len(w) != 1 {
		t.Errorf("wspr rows lost: %d, %v", len(w), err)
	}

	// A fresh schema never recreates the old tables.
	if err := mgr.initSchema(); err != nil {
		t.Fatal(err)
	}
	for _, table := range legacyPSKTables {
		if tableExists(t, db, table) {
			t.Errorf("initSchema recreated %s", table)
		}
	}
}

// The cleanup must leave space reclamation to the maintenance job: even on a
// database where incremental vacuum is available, the file keeps its size and
// the emptied tables' pages stay on the freelist.
func TestDropLegacyPSKTablesDoesNotVacuum(t *testing.T) {
	db, err := sql.Open("sqlite", t.TempDir()+"/inc.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	for _, p := range []string{"PRAGMA auto_vacuum=INCREMENTAL", "PRAGMA journal_mode=WAL"} {
		if _, err := db.Exec(p); err != nil {
			t.Fatal(err)
		}
	}
	createLegacyPSKTables(t, db, 20_000)

	pages := func() (total, free int64) {
		if err := db.QueryRow(`SELECT page_count, freelist_count FROM pragma_page_count(), pragma_freelist_count()`).
			Scan(&total, &free); err != nil {
			t.Fatal(err)
		}
		return
	}
	before, _ := pages()
	dropLegacyPSKTables(context.Background(), db, 5_000, 0)
	after, free := pages()
	if after != before {
		t.Errorf("page_count %d -> %d: the cleanup vacuumed", before, after)
	}
	if free == 0 {
		t.Error("freelist is empty: the cleanup vacuumed")
	}
}

// pskQueryPlan returns the EXPLAIN QUERY PLAN detail lines for query.
func pskQueryPlan(t *testing.T, db *sql.DB, query string, args ...interface{}) []string {
	t.Helper()
	rows, err := db.Query(`EXPLAIN QUERY PLAN `+query, args...)
	if err != nil {
		t.Fatalf("explain %q: %v", query, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		out = append(out, detail)
	}
	return out
}

// Every query against psk_snapshots must reach its rows through an index —
// the UNIQUE(ts) autoindex or the rowid — never by scanning the table.
func TestPSKSnapshotQueriesUseIndex(t *testing.T) {
	sl, mgr := newTestStatsLogger(t)
	base := time.Date(2026, 7, 22, 10, 0, 0, 0, time.UTC)
	for h := 0; h < 48; h++ {
		sl.WritePSK(pskFixture(base.Add(time.Duration(h) * time.Hour)))
	}

	cases := []struct {
		name  string
		query string
		args  []interface{}
	}{
		{"history range (ReadPSK)", pskSnapshotsSQL(false, pskWhereRange), []interface{}{1, 2}},
		{"nearest (ReadPSKAt)", pskSnapshotsSQL(true, pskWhereNearest), []interface{}{1, 2, 3}},
		{"latest (LoadLatestPSK)", pskSnapshotsSQL(true, pskWhereLatest), nil},
		// The retention prune as db_manager.go pruneTable issues it, on the ts
		// column its rule names.
		{"retention prune", `DELETE FROM psk_snapshots WHERE id IN (
			SELECT id FROM psk_snapshots WHERE ts < ? LIMIT ?)`, []interface{}{1, 10_000}},
		// The upsert's ON CONFLICT(ts) is resolved through the same UNIQUE(ts)
		// index by construction; SQLite prints no plan line for it to assert.
	}
	for _, c := range cases {
		plan := pskQueryPlan(t, mgr.DB(), c.query, c.args...)
		searched := false
		for _, line := range plan {
			if strings.HasPrefix(line, "SCAN psk_snapshots") {
				t.Errorf("%s: full scan: %q (plan %q)", c.name, line, plan)
			}
			if strings.HasPrefix(line, "SEARCH psk_snapshots USING") {
				searched = true
			}
		}
		if !searched {
			t.Errorf("%s: no index SEARCH in plan %q", c.name, plan)
		}
		t.Logf("%s: %q", c.name, plan)
	}

	// Exactly one index: UNIQUE(ts). Anything more is write and disk cost no
	// query above uses.
	rows, err := mgr.DB().Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'psk_snapshots'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var idx []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		idx = append(idx, n)
	}
	if len(idx) != 1 {
		t.Errorf("psk_snapshots indexes %v, want only the UNIQUE(ts) autoindex", idx)
	}
}
