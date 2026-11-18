package main

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

// The CREATE statements earlier versions used for obsoleteIndexes.
var oldIndexDDL = []string{
	`CREATE INDEX spots_idx_ts          ON spots(ts)`,
	`CREATE INDEX spots_idx_mode_band   ON spots(mode, band)`,
	`CREATE INDEX spots_idx_date         ON spots (DATE(ts, 'unixepoch') DESC)`,
	`CREATE INDEX spots_idx_decoder_name ON spots (decoder_name) WHERE decoder_name IS NOT NULL AND decoder_name != ''`,
	`CREATE INDEX cw_spots_idx_ts       ON cw_spots(ts)`,
	`CREATE INDEX cw_spots_idx_date    ON cw_spots (DATE(ts, 'unixepoch') DESC)`,
}

func indexNames(t *testing.T, db *sql.DB) map[string]bool {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'index'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		out[n] = true
	}
	return out
}

func insertSpot(t *testing.T, db *sql.DB, ts int64, mode, name, call, band string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO spots (ts, mode, decoder_name, callsign, band) VALUES (?, ?, ?, ?, ?)`,
		ts, mode, name, call, band); err != nil {
		t.Fatal(err)
	}
}

// oldIndexDB is a database as an earlier version left it: the current schema
// plus the obsolete indexes, with spots under several decoder names and an
// empty spot_decoder_names.
func oldIndexDB(t *testing.T) *DBManager {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mgr.Close() })
	for _, ddl := range oldIndexDDL {
		if _, err := mgr.db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).Unix()
	for i := 0; i < 300; i++ {
		name := []string{"20m FT8", "40m FT8", "30m WSPR"}[i%3]
		insertSpot(t, mgr.db, base+int64(i)*600, "FT8", name, "CALL", "20m")
	}
	insertSpot(t, mgr.db, base+5, "FT8", "", "NONAME", "20m") // no decoder name
	return mgr
}

func TestDropObsoleteIndexes(t *testing.T) {
	mgr := oldIndexDB(t)

	held, released := 0, 0
	dropped := mgr.DropObsoleteIndexesAtStartup(context.Background(), func() func() {
		held++
		return func() { released++ }
	})
	if len(dropped) != len(obsoleteIndexes) {
		t.Errorf("dropped %v; want all %d obsolete indexes", dropped, len(obsoleteIndexes))
	}
	if held != 1 || released != 1 {
		t.Errorf("hold called %d, released %d; want 1 each", held, released)
	}
	have := indexNames(t, mgr.db)
	for _, ix := range obsoleteIndexes {
		if have[ix.name] {
			t.Errorf("%s still present", ix.name)
		}
	}
	for _, keep := range []string{"spots_idx_ts_mode", "spots_idx_callsign", "cw_spots_idx_ts_band", "cw_spots_idx_band", "cw_spots_idx_dx_call"} {
		if !have[keep] {
			t.Errorf("%s was dropped; it is still needed", keep)
		}
	}

	// The names list was carried over, each with its newest spot's ts.
	rows, err := mgr.db.Query(`SELECT n.name, n.last_ts, (SELECT MAX(ts) FROM spots WHERE decoder_name = n.name)
	                             FROM spot_decoder_names n ORDER BY n.name`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var name string
		var last, want int64
		rows.Scan(&name, &last, &want)
		got = append(got, name)
		if last != want {
			t.Errorf("%s: last_ts %d, want its newest spot %d", name, last, want)
		}
	}
	rows.Close()
	if strings.Join(got, ",") != "20m FT8,30m WSPR,40m FT8" {
		t.Errorf("names %v", got)
	}

	// Next start: nothing to do, so no holding server.
	if again := mgr.DropObsoleteIndexesAtStartup(context.Background(), func() func() {
		t.Error("hold started with nothing to drop")
		return nil
	}); len(again) != 0 {
		t.Errorf("dropped again: %v", again)
	}
}

func TestNewDatabaseHasNoObsoleteIndexes(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	have := indexNames(t, mgr.db)
	for _, ix := range obsoleteIndexes {
		if have[ix.name] {
			t.Errorf("a new database has %s", ix.name)
		}
	}
	if mgr.DropObsoleteIndexesAtStartup(context.Background(), func() func() {
		t.Error("hold started on a new database")
		return nil
	}) != nil {
		t.Error("dropped something on a new database")
	}
}

// A stop request before or during the drops leaves every remaining index in
// place and the database intact; the next start finishes the job.
func TestDropObsoleteIndexesCancelled(t *testing.T) {
	mgr := oldIndexDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	mgr.DropObsoleteIndexesAtStartup(ctx, nil)
	var check string
	mgr.db.QueryRow(`PRAGMA integrity_check`).Scan(&check)
	if check != "ok" {
		t.Fatalf("integrity after a cancelled drop: %s", check)
	}
	if got := mgr.DropObsoleteIndexesAtStartup(context.Background(), nil); len(got) == 0 {
		t.Error("the next start dropped nothing")
	}
	have := indexNames(t, mgr.db)
	for _, ix := range obsoleteIndexes {
		if have[ix.name] {
			t.Errorf("%s still present after the next start", ix.name)
		}
	}
}

// Without spots_idx_decoder_name the names cannot be filled cheaply; if the
// fill fails the index must be kept so the list stays right.
func TestDecoderNameIndexKeptIfFillFails(t *testing.T) {
	mgr := oldIndexDB(t)
	if _, err := mgr.db.Exec(`DROP TABLE spot_decoder_names`); err != nil {
		t.Fatal(err)
	}
	mgr.DropObsoleteIndexesAtStartup(context.Background(), nil)
	if !indexNames(t, mgr.db)["spots_idx_decoder_name"] {
		t.Error("spots_idx_decoder_name dropped although spot_decoder_names could not be filled")
	}
}

func TestSpotDatesUsesTsIndex(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	day := func(s string) int64 {
		d, _ := time.Parse("2006-01-02 15:04:05", s)
		return d.Unix()
	}
	// Day boundaries on both sides, several rows a day, and a gap.
	for _, s := range []string{
		"2026-11-01 00:00:00", "2026-11-01 12:00:00", "2026-11-01 23:59:59",
		"2026-11-02 00:00:00",
		"2026-11-05 23:59:59", "2026-11-05 00:00:01",
	} {
		insertSpot(t, mgr.db, day(s), "FT8", "20m FT8", "X", "20m")
		if _, err := mgr.db.Exec(`INSERT INTO cw_spots (ts, dx_call, band) VALUES (?, 'X', '20m')`, day(s)); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"spots", "cw_spots"} {
		rows, err := mgr.db.Query(spotDatesSQL(table))
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for rows.Next() {
			var d string
			rows.Scan(&d)
			got = append(got, d)
		}
		rows.Close()
		if strings.Join(got, ",") != "2026-11-05,2026-11-02,2026-11-01" {
			t.Errorf("%s dates %v", table, got)
		}

		// One index seek per day, not a scan.
		plan := queryPlan(t, mgr.db, spotDatesSQL(table))
		if strings.Contains(plan, "SCAN "+table) && !strings.Contains(plan, "COVERING INDEX") {
			t.Errorf("%s dates query scans the table:\n%s", table, plan)
		}
		if !strings.Contains(plan, "SEARCH "+table+" USING COVERING INDEX") {
			t.Errorf("%s dates query does not seek the ts index:\n%s", table, plan)
		}
	}
}

func queryPlan(t *testing.T, db *sql.DB, q string, args ...interface{}) string {
	t.Helper()
	rows, err := db.Query(`EXPLAIN QUERY PLAN `+q, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var id, parent, notused int
		var detail string
		rows.Scan(&id, &parent, &notused, &detail)
		b.WriteString(detail + "\n")
	}
	return b.String()
}

// The common history query (one day, a mode and a band) must use the ts
// index with or without statistics. With spots_idx_mode_band present and no
// statistics, SQLite chose it and read every 20m FT8 spot ever kept.
func TestSpotQueriesUseTsIndex(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	base := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Unix()
	tx, _ := mgr.db.Begin()
	for i := 0; i < 20000; i++ {
		tx.Exec(`INSERT INTO spots (ts, mode, decoder_name, callsign, locator, band) VALUES (?, 'FT8', '20m FT8', ?, 'IO91', '20m')`,
			base+int64(i)*300, "C"+string(rune('A'+i%26)))
	}
	tx.Commit()

	day := base + 30*86400
	dedup := `SELECT MAX(ts), mode, callsign, COUNT(*) FROM spots
	           WHERE ts >= ? AND ts < ? AND mode = ? AND band = ?
	           GROUP BY callsign, locator, band, mode, ts / 86400 ORDER BY 1 DESC`
	for _, stats := range []bool{false, true} {
		if stats {
			mgr.db.Exec(`ANALYZE`)
		}
		plan := queryPlan(t, mgr.db, dedup, day, day+86400, "FT8", "20m")
		if !strings.Contains(plan, "spots_idx_ts_mode") {
			t.Errorf("statistics %v: one-day query does not use the ts index:\n%s", stats, plan)
		}
		plan = queryPlan(t, mgr.db, `SELECT * FROM spots WHERE ts >= ? AND ts < ? AND callsign = ?`, base, base+90*86400, "CA")
		if !strings.Contains(plan, "spots_idx_callsign") && !strings.Contains(plan, "spots_idx_ts_mode") {
			t.Errorf("statistics %v: callsign query uses no index:\n%s", stats, plan)
		}
	}
}

func TestNoteDecoderName(t *testing.T) {
	sl := newTestSpotsLogger(t)
	ts := time.Date(2026, 11, 18, 7, 20, 0, 0, time.UTC)
	log := func(at time.Time, name string) {
		t.Helper()
		if err := sl.LogSpot(&DecodeInfo{Callsign: "K1ABC", Mode: "FT8", Frequency: 14074000, Timestamp: at, BandName: name}); err != nil {
			t.Fatal(err)
		}
	}
	lastTS := func(name string) int64 {
		var v int64
		sl.db.QueryRow(`SELECT last_ts FROM spot_decoder_names WHERE name = ?`, name).Scan(&v)
		return v
	}
	hourEnd := time.Date(2026, 11, 18, 8, 0, 0, 0, time.UTC).Unix()

	log(ts, "20m FT8")
	if got := lastTS("20m FT8"); got != hourEnd {
		t.Errorf("last_ts %d, want the end of the hour %d", got, hourEnd)
	}
	// Later in the same hour: no write. Seen by changing the row behind its
	// back; a write would put it back.
	sl.db.Exec(`UPDATE spot_decoder_names SET last_ts = 1`)
	log(ts.Add(30*time.Minute), "20m FT8")
	if got := lastTS("20m FT8"); got != 1 {
		t.Errorf("wrote again within the hour (last_ts %d)", got)
	}
	// The next hour writes.
	log(ts.Add(time.Hour), "20m FT8")
	if got := lastTS("20m FT8"); got != hourEnd+3600 {
		t.Errorf("next hour: last_ts %d, want %d", got, hourEnd+3600)
	}
	// No name, no row.
	log(ts, "")
	var n int
	sl.db.QueryRow(`SELECT count(*) FROM spot_decoder_names`).Scan(&n)
	if n != 1 {
		t.Errorf("%d names, want 1", n)
	}
	names, _ := sl.GetAvailableNames()
	if strings.Join(names, ",") != "20m FT8" {
		t.Errorf("GetAvailableNames %v", names)
	}
}

// Retention never drops a name while it still has spots: last_ts is at or
// after its newest spot, and both use the same cutoff.
func TestDecoderNamesRetention(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	sl, _ := NewSpotsLogger(t.TempDir(), true, 0)
	sl.SetDB(mgr.DB())
	sl.SetReadDB(mgr.ReadDB())

	now := time.Now()
	old := now.Add(-40 * 24 * time.Hour)
	edge := now.Add(-30*24*time.Hour + 30*time.Minute) // just inside 30 days
	for _, d := range []struct {
		at   time.Time
		name string
	}{{old, "gone"}, {edge, "edge"}, {now, "live"}} {
		if err := sl.LogSpot(&DecodeInfo{Callsign: "X", Mode: "FT8", Frequency: 14074000, Timestamp: d.at, BandName: d.name}); err != nil {
			t.Fatal(err)
		}
	}
	mgr.pruneAll(RetentionConfig{SpotsDays: 30})
	names, _ := sl.GetAvailableNames()
	if strings.Join(names, ",") != "edge,live" {
		t.Errorf("after pruning: %v; want edge,live", names)
	}
}

func TestImportDecoderNamesSQL(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	insertSpot(t, mgr.db, 100, "FT8", "a", "X", "20m")
	insertSpot(t, mgr.db, 300, "FT8", "a", "X", "20m")
	insertSpot(t, mgr.db, 200, "FT8", "b", "X", "20m")
	insertSpot(t, mgr.db, 200, "FT8", "", "X", "20m")
	mgr.db.Exec(upsertDecoderNameSQL, "a", 1000) // newer than any imported spot
	for i := 0; i < 2; i++ {                     // repeatable
		if _, err := mgr.db.Exec(importDecoderNamesSQL); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := mgr.db.Query(`SELECT name || ':' || last_ts FROM spot_decoder_names ORDER BY name`)
	var got []string
	for rows.Next() {
		var s string
		rows.Scan(&s)
		got = append(got, s)
	}
	rows.Close()
	if strings.Join(got, ",") != "a:1000,b:200" {
		t.Errorf("names %v; want a:1000,b:200", got)
	}
}

// Tables with no statistics are analysed shortly after startup, not left to
// the nightly run.
func TestMaintenanceLoopAnalysesNewTablesAtStartup(t *testing.T) {
	oldDelay, oldPause := maintenanceStartupDelay, dbAnalyzePause
	maintenanceStartupDelay, dbAnalyzePause = 50*time.Millisecond, 0
	defer func() { maintenanceStartupDelay, dbAnalyzePause = oldDelay, oldPause }()

	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	insertSpot(t, mgr.db, 100, "FT8", "a", "X", "20m")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.StartMaintenanceLoop(ctx, time.UTC)

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		mgr.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat1'`).Scan(&n)
		if n == 1 {
			mgr.db.QueryRow(`SELECT count(*) FROM sqlite_stat1 WHERE tbl = 'spots'`).Scan(&n)
			if n > 0 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("spots was not analysed after startup")
}
