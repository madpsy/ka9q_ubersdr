package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// ── every table is bounded ───────────────────────────────────────────────────

func schemaTables(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	return names
}

// A table added to the schema without a retention rule fails here, naming it,
// so nothing grows forever because someone forgot. Exempt tables must say how
// they are bounded instead.
func TestEveryTableHasRetention(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()

	ruled := map[string][]retentionRule{}
	for _, r := range retentionRules(RetentionConfig{}) {
		ruled[r.table] = append(ruled[r.table], r)
	}
	// A table split across several rules needs a filter on every one of them,
	// and together the filters must match each kind of row exactly once: no
	// row escapes retention, none is governed twice. The split tables divide
	// on period, whose values are fixed by the summary code.
	for table, rules := range ruled {
		if len(rules) == 1 {
			if rules[0].filter != "" {
				t.Errorf("table %s has a single filtered rule: rows outside %q are kept forever", table, rules[0].filter)
			}
			continue
		}
		for _, period := range []string{"day", "week", "month", "year"} {
			matches := 0
			for _, r := range rules {
				if r.filter == "" {
					t.Errorf("table %s has several rules, one without a filter", table)
					continue
				}
				var hit int
				if err := mgr.DB().QueryRow(`SELECT count(*) FROM (SELECT ? AS period) WHERE `+r.filter, period).Scan(&hit); err != nil {
					t.Fatalf("%s filter %q: %v", table, r.filter, err)
				}
				matches += hit
			}
			if matches != 1 {
				t.Errorf("table %s: a %q row matches %d of its rules, want exactly 1", table, period, matches)
			}
		}
	}
	tables := schemaTables(t, mgr.DB())
	inSchema := map[string]bool{}
	for _, name := range tables {
		inSchema[name] = true
		_, hasRule := ruled[name]
		reason, exempt := retentionExempt[name]
		switch {
		case !hasRule && !exempt:
			t.Errorf("table %s has no retention rule: add it to retentionRules (db_manager.go) with a config default, "+
				"or to retentionExempt with how it is otherwise bounded", name)
		case hasRule && exempt:
			t.Errorf("table %s is both ruled and exempt", name)
		case exempt && strings.TrimSpace(reason) == "":
			t.Errorf("table %s is exempt without a reason", name)
		}
	}
	// No stale entries for tables that no longer exist.
	for name := range ruled {
		if !inSchema[name] {
			t.Errorf("retention rule for %s, which is not in the schema", name)
		}
	}
	for name := range retentionExempt {
		if !inSchema[name] {
			t.Errorf("retention exemption for %s, which is not in the schema", name)
		}
	}

	// Each rule's column exists and the prune finds old rows through an index,
	// not a scan of the whole table every hour.
	for _, r := range retentionRules(RetentionConfig{}) {
		where := r.tsColumn + ` < ?`
		if r.filter != "" {
			where += ` AND (` + r.filter + `)`
		}
		rows, err := mgr.DB().Query(`EXPLAIN QUERY PLAN SELECT id FROM `+r.table+` WHERE `+where+` LIMIT ?`, 1, pruneChunkSize)
		if err != nil {
			t.Errorf("%s: prune query does not run (column %s?): %v", r.table, r.tsColumn, err)
			continue
		}
		var plan string
		for rows.Next() {
			var a, b, c int
			var d string
			rows.Scan(&a, &b, &c, &d)
			plan += d + "; "
		}
		rows.Close()
		if !strings.Contains(plan, "INDEX") {
			t.Errorf("%s: prune does not use an index on %s: %s", r.table, r.tsColumn, plan)
		}
	}
}

// With the settings a receiver gets when it configures nothing, every rule
// prunes: no table is kept forever by default.
func TestRetentionDefaultsPruneEveryTable(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cfg, err := LoadConfig(write("config.yaml", "admin:\n  name: test\n"))
	if err != nil {
		t.Fatal(err)
	}
	// A decoder.yaml from before spots_log_max_age_days existed.
	write("decoder.yaml", "decoder:\n  enabled: true\n")
	prepareDecoderStoreConfig(cfg, dir, true)

	for _, r := range retentionRules(retentionConfigFrom(cfg)) {
		if r.days <= 0 {
			t.Errorf("table %s is kept forever by default (days=%d)", r.table, r.days)
		}
	}
}

func TestDecoderSpotsRetentionDefault(t *testing.T) {
	cases := []struct {
		name string
		yaml string // "" = no decoder.yaml
		want int
	}{
		{"key missing", "decoder:\n  enabled: true\n", 90},
		{"explicit 0 means keep forever", "decoder:\n  enabled: true\n  spots_log_max_age_days: 0\n", 0},
		{"explicit value", "decoder:\n  enabled: true\n  spots_log_max_age_days: 14\n", 14},
		{"decoder off, key missing: old spots still age out", "decoder:\n  enabled: false\n", 90},
	}
	for _, c := range cases {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "decoder.yaml"), []byte(c.yaml), 0o644); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadConfig(filepath.Join(dir, "decoder.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		cfg := &Config{Decoder: loaded.Decoder}
		prepareDecoderStoreConfig(cfg, dir, true)
		if cfg.Decoder.SpotsLogMaxAgeDays != c.want {
			t.Errorf("%s: spots retention %d, want %d", c.name, cfg.Decoder.SpotsLogMaxAgeDays, c.want)
		}
	}
	// Without a decoder.yaml at all nothing is read from disk.
	cfg := &Config{}
	prepareDecoderStoreConfig(cfg, t.TempDir(), false)
	if cfg.Decoder.SpotsLogMaxAgeDays != 0 {
		t.Errorf("no decoder.yaml and no spots: retention set to %d", cfg.Decoder.SpotsLogMaxAgeDays)
	}
}

func TestYAMLSetsKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.yaml")
	os.WriteFile(p, []byte("decoder:\n  a: 0\n  b: null\nother: 1\n"), 0o644)
	for _, c := range []struct {
		keys []string
		want bool
	}{
		{[]string{"decoder", "a"}, true},
		{[]string{"decoder", "b"}, true}, // set, even to null
		{[]string{"decoder", "c"}, false},
		{[]string{"other", "a"}, false}, // other is not a mapping
		{[]string{"missing"}, false},
	} {
		if got := yamlSetsKey(p, c.keys...); got != c.want {
			t.Errorf("yamlSetsKey(%v) = %v, want %v", c.keys, got, c.want)
		}
	}
	if yamlSetsKey(filepath.Join(t.TempDir(), "absent.yaml"), "decoder") {
		t.Error("a missing file sets nothing")
	}
}

func TestRetentionGetters(t *testing.T) {
	var dc DatabaseConfig
	got := []int{dc.GetNoiseFloorRetentionDays(), dc.GetCWSpotsRetentionDays(), dc.GetSpaceWeatherRetentionDays(),
		dc.GetChatRetentionDays(), dc.GetMetricsRetentionDays(), dc.GetMetricsSummaryRetentionDays()}
	want := []int{90, 90, 365, 365, 90, 730}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("defaults %v, want %v", got, want)
	}
	zero, seven := 0, 7
	dc = DatabaseConfig{NoiseFloorRetentionDays: &zero, MetricsRetentionDays: &seven}
	if dc.GetNoiseFloorRetentionDays() != 0 || dc.GetMetricsRetentionDays() != 7 {
		t.Error("an explicit value, including 0 (keep forever), must override the default")
	}
}

// ── pruning ──────────────────────────────────────────────────────────────────

// insertMinimalRow adds a row to table with col = ts and every other NOT NULL
// column without a default given a value of its type, unique per call so
// UNIQUE constraints never collide.
func insertMinimalRow(t *testing.T, db *sql.DB, table, col string, ts int64, seq int) {
	t.Helper()
	rows, err := db.Query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{col}
	vals := []interface{}{ts}
	for rows.Next() {
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		rows.Scan(&name, &typ, &notnull, &dflt, &pk)
		if name == col || pk == 1 || notnull == 0 || dflt.Valid {
			continue
		}
		names = append(names, name)
		switch u := strings.ToUpper(typ); {
		case strings.Contains(u, "INT"):
			vals = append(vals, int64(seq))
		case strings.Contains(u, "REAL"), strings.Contains(u, "FLOA"), strings.Contains(u, "DOUB"):
			vals = append(vals, float64(seq))
		default:
			vals = append(vals, fmt.Sprintf("v%d", seq))
		}
	}
	rows.Close()
	q := fmt.Sprintf(`INSERT INTO %s (%s) VALUES (?%s)`, table, strings.Join(names, ", "), strings.Repeat(", ?", len(names)-1))
	if _, err := db.Exec(q, vals...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

// Every ruled table loses its old rows and keeps its recent ones.
func TestPruneAllEveryTable(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	cfg := RetentionConfig{SessionsDays: 30, SpotsDays: 30, CWSpotsDays: 30, ChatDays: 30, NoiseFloorDays: 30,
		SpaceWeatherDays: 30, StatsDays: 30, DecoderMetricsSummaryDays: 30, CWMetricsSummaryDays: 30,
		NotificationLogDays: 30, DecoderMetricsDays: 30, CWMetricsDays: 30}
	now := time.Now().Unix()
	seq := 0
	// One old and one recent row per table (not per rule: a split table's
	// rows are covered by one of its rules or another).
	var tables []retentionRule
	seen := map[string]bool{}
	for _, r := range retentionRules(cfg) {
		if r.days != 30 {
			t.Fatalf("%s: the test's config misses this rule's field", r.table)
		}
		if seen[r.table] {
			continue
		}
		seen[r.table] = true
		tables = append(tables, r)
		seq++
		insertMinimalRow(t, mgr.DB(), r.table, r.tsColumn, now-100*86400, seq)
		seq++
		insertMinimalRow(t, mgr.DB(), r.table, r.tsColumn, now-86400, seq)
	}
	mgr.pruneAll(cfg)
	for _, r := range tables {
		var old, recent int
		mgr.DB().QueryRow(`SELECT count(*) FROM `+r.table+` WHERE `+r.tsColumn+` < ?`, now-30*86400).Scan(&old)
		mgr.DB().QueryRow(`SELECT count(*) FROM `+r.table+` WHERE `+r.tsColumn+` >= ?`, now-30*86400).Scan(&recent)
		if old != 0 || recent != 1 {
			t.Errorf("%s: %d old and %d recent rows after the prune, want 0 and 1", r.table, old, recent)
		}
	}

	// Days <= 0 keeps everything.
	insertMinimalRow(t, mgr.DB(), "noise_floor", "ts", now-1000*86400, 9999)
	mgr.pruneAll(RetentionConfig{})
	var n int
	mgr.DB().QueryRow(`SELECT count(*) FROM noise_floor WHERE ts < ?`, now-999*86400).Scan(&n)
	if n != 1 {
		t.Error("a 0-day rule pruned anyway")
	}
}

// Pruning a session takes its bands and modes with it, and the sweep removes
// user agents no session uses while keeping the ones still in use.
func TestUserAgentSweep(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	db := mgr.DB()
	now := time.Now().Unix()
	db.Exec(`INSERT INTO user_agent (id, ua) VALUES (1, 'old-browser'), (2, 'current-browser'), (3, 'never-used')`)
	db.Exec(`INSERT INTO session (id, user_session_id, started_at, ended_at, last_seen, user_agent_id) VALUES
		(1, 'old', ?, ?, ?, 1), (2, 'recent', ?, ?, ?, 2), (3, 'live', ?, NULL, ?, 2)`,
		now-100*86400, now-100*86400, now-100*86400, now-86400, now-86400, now-86400, now, now)
	db.Exec(`INSERT INTO session_band (session_id, band) VALUES (1, '20m'), (2, '40m')`)
	db.Exec(`INSERT INTO session_mode (session_id, mode) VALUES (1, 'usb'), (2, 'lsb')`)

	mgr.pruneAll(RetentionConfig{SessionsDays: 30})

	var sessions, bands, modes int
	db.QueryRow(`SELECT count(*) FROM session`).Scan(&sessions)
	db.QueryRow(`SELECT count(*) FROM session_band`).Scan(&bands)
	db.QueryRow(`SELECT count(*) FROM session_mode`).Scan(&modes)
	if sessions != 2 || bands != 1 || modes != 1 {
		t.Errorf("after prune: %d sessions, %d bands, %d modes; want 2, 1, 1 (the old session's went with it)", sessions, bands, modes)
	}
	var left []string
	rows, _ := db.Query(`SELECT ua FROM user_agent ORDER BY id`)
	for rows.Next() {
		var ua string
		rows.Scan(&ua)
		left = append(left, ua)
	}
	rows.Close()
	if fmt.Sprint(left) != "[current-browser]" {
		t.Errorf("user agents left %v, want only the one live and recent sessions use", left)
	}
}

// The session writer must keep working across a sweep: it used to cache agent
// ids for the life of the process, so after the sweep removed one, the next
// session with that browser would have failed its foreign key.
func TestSessionWriterAfterUserAgentSweep(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	db := mgr.DB()
	w := newSessionHistoryWriter(db, nil)
	ua := "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0"
	now := time.Now()

	w.recordActive(SessionActivityEntry{UserSessionID: "first", UserAgent: ua, CreatedAt: now}, now.Unix())
	w.closeSession("first", nil, nil, now.Unix())
	// Age the session out and prune: its agent is now unused and swept.
	db.Exec(`UPDATE session SET ended_at = ?, started_at = ? WHERE user_session_id = 'first'`, now.Add(-100*24*time.Hour).Unix(), now.Add(-100*24*time.Hour).Unix())
	mgr.pruneAll(RetentionConfig{SessionsDays: 30})
	var n int
	db.QueryRow(`SELECT count(*) FROM user_agent`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d user agents left after the sweep, want 0", n)
	}

	w.recordActive(SessionActivityEntry{UserSessionID: "second", UserAgent: ua, CreatedAt: now}, now.Unix())
	var browser sql.NullString
	if err := db.QueryRow(`SELECT ua.browser FROM session s JOIN user_agent ua ON ua.id = s.user_agent_id WHERE s.user_session_id = 'second'`).Scan(&browser); err != nil {
		t.Fatalf("second session not recorded with its user agent: %v", err)
	}
	if !strings.Contains(browser.String, "Firefox") {
		t.Errorf("browser %q, want Firefox (parsed again after the sweep)", browser.String)
	}
}

// ── vacuum ───────────────────────────────────────────────────────────────────

func TestNewDatabaseUsesIncrementalVacuum(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	var mode int
	mgr.DB().QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
	if mode != 2 {
		t.Errorf("auto_vacuum %d on a new database, want 2 (INCREMENTAL)", mode)
	}
	var limit int64
	mgr.DB().QueryRow(`PRAGMA journal_size_limit`).Scan(&limit)
	if limit != 64<<20 {
		t.Errorf("journal_size_limit %d, want 64 MiB", limit)
	}
}

func TestIncrementalVacuumInChunks(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	db := mgr.DB()
	tx, _ := db.Begin()
	pad := strings.Repeat("x", 3000)
	for i := 0; i < 12000; i++ {
		tx.Exec(`INSERT INTO noise_floor (ts, band) VALUES (?, ?)`, i, pad)
	}
	tx.Commit()
	db.Exec(`DELETE FROM noise_floor`)
	var before, after int64
	db.QueryRow("PRAGMA freelist_count").Scan(&before)
	if before <= vacuumChunkPages {
		t.Fatalf("only %d free pages; the test needs more than one chunk (%d)", before, vacuumChunkPages)
	}
	mgr.incrementalVacuum()
	db.QueryRow("PRAGMA freelist_count").Scan(&after)
	if after != 0 {
		t.Errorf("freelist %d pages after vacuum (was %d), want 0", after, before)
	}

	// A database created in auto_vacuum NONE (every one before this fix)
	// returns at once rather than looping on a freelist that never shrinks.
	old, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	old.SetMaxOpenConns(1)
	old.Exec(`CREATE TABLE x (v TEXT)`)
	otx, _ := old.Begin()
	for i := 0; i < 2000; i++ {
		otx.Exec(`INSERT INTO x VALUES (?)`, pad)
	}
	otx.Commit()
	old.Exec(`DELETE FROM x`)
	var oldFree int64
	old.QueryRow("PRAGMA freelist_count").Scan(&oldFree)
	if oldFree == 0 {
		t.Fatal("the mode-NONE fixture has no free pages")
	}
	start := time.Now()
	(&DBManager{db: old}).incrementalVacuum()
	if d := time.Since(start); d > time.Second {
		t.Errorf("vacuum on a non-incremental database took %v; it should return at once", d)
	}
}

// ── nightly maintenance ──────────────────────────────────────────────────────

func TestNextDailyRun(t *testing.T) {
	london, err := time.LoadLocation("Europe/London")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	newYork, _ := time.LoadLocation("America/New_York")
	cases := []struct {
		now  time.Time
		loc  *time.Location
		want string
	}{
		{time.Date(2026, 11, 17, 2, 0, 0, 0, time.UTC), time.UTC, "2026-11-17T03:30:00Z"},
		{time.Date(2026, 11, 17, 3, 30, 0, 0, time.UTC), time.UTC, "2026-11-18T03:30:00Z"}, // exactly now: tomorrow
		{time.Date(2026, 11, 17, 18, 0, 0, 0, time.UTC), time.UTC, "2026-11-18T03:30:00Z"},
		{time.Date(2026, 12, 31, 23, 0, 0, 0, time.UTC), time.UTC, "2027-01-01T03:30:00Z"}, // year end
		// Summer in London: 03:30 BST is 02:30 UTC.
		{time.Date(2026, 7, 1, 1, 0, 0, 0, time.UTC), london, "2026-07-01T03:30:00+01:00"},
		// The night the clocks go forward (29 March 2026, 01:00 -> 02:00).
		{time.Date(2026, 3, 28, 22, 0, 0, 0, time.UTC), london, "2026-03-29T03:30:00+01:00"},
		// The night they go back (25 October 2026).
		{time.Date(2026, 10, 24, 22, 0, 0, 0, time.UTC), london, "2026-10-25T03:30:00Z"},
		// New York skips 02:00-03:00 on 8 March 2026; 03:30 still exists.
		{time.Date(2026, 3, 8, 5, 0, 0, 0, time.UTC), newYork, "2026-03-08T03:30:00-04:00"},
	}
	for _, c := range cases {
		got := nextDailyRun(c.now, c.loc, 3, 30)
		if got.Format(time.RFC3339) != c.want {
			t.Errorf("now %s in %s: next %s, want %s", c.now.Format(time.RFC3339), c.loc, got.Format(time.RFC3339), c.want)
		}
		if !got.After(c.now) || got.Sub(c.now) > 25*time.Hour {
			t.Errorf("next %s is not within a day after %s", got, c.now)
		}
	}
}

func TestDBMaintenanceAnalysesTables(t *testing.T) {
	oldPause := dbAnalyzePause
	dbAnalyzePause = 0
	t.Cleanup(func() { dbAnalyzePause = oldPause })
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	tx, _ := mgr.DB().Begin()
	now := time.Now().Unix()
	for i := 0; i < 5000; i++ {
		tx.Exec(`INSERT INTO noise_floor (ts, band, p5_db) VALUES (?, ?, -120)`, now-int64(i)*60, []string{"20m", "40m", "80m"}[i%3])
	}
	tx.Commit()

	var n int
	mgr.DB().QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat1'`).Scan(&n)
	if n != 0 {
		t.Fatal("a new database should start without statistics")
	}

	mgr.runMaintenance(context.Background(), "startup", false)
	if err := mgr.DB().QueryRow(`SELECT count(*) FROM sqlite_stat1 WHERE tbl = 'noise_floor'`).Scan(&n); err != nil || n == 0 {
		t.Fatalf("startup pass left noise_floor unanalysed (%d stat rows, %v)", n, err)
	}
	var limit int
	conn, _ := mgr.DB().Conn(context.Background())
	conn.QueryRowContext(context.Background(), `PRAGMA analysis_limit`).Scan(&limit)
	conn.Close()
	if limit != dbAnalysisLimit {
		t.Errorf("analysis_limit %d on the write connection, want %d", limit, dbAnalysisLimit)
	}

	// The nightly pass runs cleanly too, checkpoint included, and leaves the
	// database usable.
	mgr.runMaintenance(context.Background(), "nightly", true)
	if _, err := mgr.DB().Exec(`INSERT INTO noise_floor (ts, band) VALUES (?, '20m')`, now); err != nil {
		t.Errorf("write after maintenance: %v", err)
	}

	// A cancelled context stops a pass without hanging or panicking.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { mgr.runMaintenance(ctx, "nightly", true); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("maintenance with a cancelled context did not return")
	}
}

// The loop runs the startup pass, then stops cleanly when its context ends.
func TestMaintenanceLoopStops(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	ctx, cancel := context.WithCancel(context.Background())
	mgr.StartMaintenanceLoop(ctx, nil) // nil location falls back to UTC
	cancel()
	// Nothing to assert beyond not hanging or panicking; the loop's goroutine
	// sees the cancellation while waiting for the night.
	time.Sleep(50 * time.Millisecond)
}

func TestRetentionRuleOrderStable(t *testing.T) {
	// Deterministic order keeps the prune log readable; also catches an
	// accidental map-based rewrite.
	a, b := retentionRules(RetentionConfig{}), retentionRules(RetentionConfig{})
	names := func(rs []retentionRule) []string {
		var out []string
		for _, r := range rs {
			out = append(out, r.table)
		}
		return out
	}
	if fmt.Sprint(names(a)) != fmt.Sprint(names(b)) {
		t.Error("retentionRules order is not stable")
	}
	sorted := append([]string(nil), names(a)...)
	sort.Strings(sorted)
	if len(sorted) == 0 {
		t.Error("no retention rules")
	}
}

// A backlog larger than one run's cap is worked off across runs, never in one
// burst: each run deletes at most pruneMaxBatches x pruneChunkSize rows a table.
func TestPruneBacklogSpreadAcrossRuns(t *testing.T) {
	oldChunk, oldMax := pruneChunkSize, pruneMaxBatches
	pruneChunkSize, pruneMaxBatches = 10, 2
	t.Cleanup(func() { pruneChunkSize, pruneMaxBatches = oldChunk, oldMax })

	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	now := time.Now().Unix()
	tx, _ := mgr.DB().Begin()
	for i := 0; i < 45; i++ {
		tx.Exec(`INSERT INTO noise_floor (ts, band) VALUES (?, '20m')`, now-100*86400-int64(i))
	}
	tx.Exec(`INSERT INTO noise_floor (ts, band) VALUES (?, '20m')`, now)
	tx.Commit()

	count := func() (n int) { mgr.DB().QueryRow(`SELECT count(*) FROM noise_floor`).Scan(&n); return }
	for run, want := range []int{26, 6, 1, 1} { // 45 old rows at 20 a run, then just the recent one
		mgr.pruneAll(RetentionConfig{NoiseFloorDays: 30})
		if got := count(); got != want {
			t.Fatalf("after run %d: %d rows, want %d", run+1, got, want)
		}
	}
}

func TestVacuumBoundedPerRun(t *testing.T) {
	oldPages, oldMax := vacuumChunkPages, vacuumMaxChunks
	vacuumChunkPages, vacuumMaxChunks = 64, 2
	t.Cleanup(func() { vacuumChunkPages, vacuumMaxChunks = oldPages, oldMax })

	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	db := mgr.DB()
	tx, _ := db.Begin()
	pad := strings.Repeat("x", 3000)
	for i := 0; i < 2000; i++ {
		tx.Exec(`INSERT INTO noise_floor (ts, band) VALUES (?, ?)`, i, pad)
	}
	tx.Commit()
	db.Exec(`DELETE FROM noise_floor`)
	var before, after int64
	db.QueryRow("PRAGMA freelist_count").Scan(&before)
	if before < 4*64 {
		t.Fatalf("only %d free pages; the test needs more than two chunks", before)
	}
	mgr.incrementalVacuum()
	db.QueryRow("PRAGMA freelist_count").Scan(&after)
	if freed := before - after; freed != 2*64 {
		t.Errorf("one run freed %d pages, want the cap of %d", freed, 2*64)
	}
}

// The first prune waits for the startup delay, and a shutdown during it
// prunes nothing.
func TestRetentionLoopStartupDelay(t *testing.T) {
	old := retentionStartupDelay
	retentionStartupDelay = 200 * time.Millisecond
	t.Cleanup(func() { retentionStartupDelay = old })

	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	ins := func() {
		mgr.DB().Exec(`INSERT INTO noise_floor (ts, band) VALUES (?, '20m')`, time.Now().Unix()-100*86400)
	}
	count := func() (n int) { mgr.DB().QueryRow(`SELECT count(*) FROM noise_floor`).Scan(&n); return }

	ins()
	ctx, cancel := context.WithCancel(context.Background())
	mgr.StartRetentionLoop(ctx, RetentionConfig{NoiseFloorDays: 30})
	time.Sleep(50 * time.Millisecond)
	if count() != 1 {
		t.Error("pruned before the startup delay")
	}
	deadline := time.Now().Add(3 * time.Second)
	for count() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if count() != 0 {
		t.Error("not pruned after the startup delay")
	}
	cancel()

	// Cancelled during the delay: nothing is pruned.
	ins()
	ctx2, cancel2 := context.WithCancel(context.Background())
	mgr.StartRetentionLoop(ctx2, RetentionConfig{NoiseFloorDays: 30})
	cancel2()
	time.Sleep(400 * time.Millisecond)
	if count() != 1 {
		t.Error("pruned although cancelled during the startup delay")
	}
}

// Daily summaries age with the raw metrics; weeks, months and years keep
// their longer horizon, so this year can still be compared with last.
func TestSummaryRetentionByPeriod(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	now := time.Now().Unix()
	day := int64(86400)
	type row struct {
		period string
		age    int64
		kept   bool
	}
	rows := []row{
		{"day", 10, true}, {"day", 100, false}, // past the 90-day metrics retention
		{"week", 100, true}, {"month", 400, true}, {"year", 700, true}, // within 730
		{"week", 800, false}, {"year", 800, false},
	}
	for _, table := range []string{"decoder_metrics_summary", "cw_metrics_summary"} {
		for i, r := range rows {
			cols := `ts, band, period, period_key, end_ts, updated_ts, data`
			vals := []interface{}{now - r.age*day, "20m", r.period, fmt.Sprintf("k%d", i), now, now, "{}"}
			if table == "decoder_metrics_summary" {
				cols += `, mode`
				vals = append(vals, "FT8")
			}
			q := `INSERT INTO ` + table + ` (` + cols + `) VALUES (?` + strings.Repeat(`, ?`, len(vals)-1) + `)`
			if _, err := mgr.DB().Exec(q, vals...); err != nil {
				t.Fatalf("%s: %v", table, err)
			}
		}
	}
	mgr.pruneAll(RetentionConfig{DecoderMetricsDays: 90, CWMetricsDays: 90, DecoderMetricsSummaryDays: 730, CWMetricsSummaryDays: 730})
	for _, table := range []string{"decoder_metrics_summary", "cw_metrics_summary"} {
		for _, r := range rows {
			var n int
			mgr.DB().QueryRow(`SELECT count(*) FROM `+table+` WHERE period = ? AND ts = ?`, r.period, now-r.age*day).Scan(&n)
			if (n == 1) != r.kept {
				t.Errorf("%s: %s summary %d days old kept=%v, want %v", table, r.period, r.age, n == 1, r.kept)
			}
		}
	}
}

// oldStyleDB makes a database the way NewDBManager did before the auto_vacuum
// fix (WAL first, so auto_vacuum stays NONE), fills it and deletes most of
// it, leaving a large freelist.
func oldStyleDB(t *testing.T) (*DBManager, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ubersdr.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	for _, p := range []string{"PRAGMA journal_mode=WAL", "PRAGMA auto_vacuum=INCREMENTAL",
		"CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)", "CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)"} {
		if _, err := db.Exec(p); err != nil {
			t.Fatal(err)
		}
	}
	tx, _ := db.Begin()
	pad := strings.Repeat("x", 2000)
	for i := 0; i < 3000; i++ {
		tx.Exec(`INSERT INTO big (v) VALUES (?)`, pad)
	}
	for i := 0; i < 50; i++ {
		tx.Exec(`INSERT INTO keep (v) VALUES (?)`, fmt.Sprintf("row%d", i))
	}
	tx.Commit()
	db.Exec(`DROP TABLE big`)
	db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	var mode int
	db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
	if mode != 0 {
		t.Fatalf("fixture auto_vacuum %d, want 0 like the old databases", mode)
	}
	return &DBManager{db: db, path: path}, path
}

func withVacuumGuards(t *testing.T, free int64, freeErr error) {
	t.Helper()
	oldDisk, oldBytes := vacuumDiskFree, vacuumMinFreeBytes
	vacuumDiskFree = func(string) (int64, error) { return free, freeErr }
	vacuumMinFreeBytes = 1 << 20
	t.Cleanup(func() { vacuumDiskFree, vacuumMinFreeBytes = oldDisk, oldBytes })
}

func TestReclaimSpaceVacuumsOldDatabaseOnce(t *testing.T) {
	withVacuumGuards(t, 1<<40, nil)
	mgr, path := oldStyleDB(t)
	before, _ := os.Stat(path)

	if !mgr.reclaimSpace(context.Background(), "nightly") {
		t.Fatal("did not vacuum a database that is mostly free space")
	}
	var mode, free int64
	mgr.db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
	mgr.db.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	after, _ := os.Stat(path)
	if mode != 2 || free != 0 {
		t.Errorf("after VACUUM: auto_vacuum %d, freelist %d; want 2 and 0", mode, free)
	}
	if after.Size() >= before.Size()/2 {
		t.Errorf("file %d bytes after, %d before; want it to shrink", after.Size(), before.Size())
	}
	var kept int
	mgr.db.QueryRow(`SELECT count(*) FROM keep`).Scan(&kept)
	if kept != 50 {
		t.Errorf("%d rows kept, want 50", kept)
	}
	// Now incremental: never again.
	if mgr.reclaimSpace(context.Background(), "nightly") {
		t.Error("vacuumed again once incremental")
	}
}

func TestReclaimSpaceGuards(t *testing.T) {
	// Not enough disk for the rebuilt copy.
	withVacuumGuards(t, 1<<20, nil)
	mgr, _ := oldStyleDB(t)
	if mgr.reclaimSpace(context.Background(), "nightly") {
		t.Error("vacuumed without room on disk")
	}
	// Free disk unknown: skipped, never run blind.
	vacuumDiskFree = func(string) (int64, error) { return 0, fmt.Errorf("unknown") }
	if mgr.reclaimSpace(context.Background(), "nightly") {
		t.Error("vacuumed with free disk space unknown")
	}
	var mode int
	mgr.db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
	if mode != 0 {
		t.Errorf("auto_vacuum changed to %d by a skipped pass", mode)
	}
	// Too little free space to be worth it.
	vacuumDiskFree = func(string) (int64, error) { return 1 << 40, nil }
	vacuumMinFreeBytes = 1 << 40
	if mgr.reclaimSpace(context.Background(), "nightly") {
		t.Error("vacuumed below the free-space threshold")
	}
	// A database created by NewDBManager is incremental already.
	vacuumMinFreeBytes = 1
	fresh, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if fresh.reclaimSpace(context.Background(), "nightly") {
		t.Error("vacuumed an incremental database")
	}
}

// The reclaim belongs to startup: the nightly pass never vacuums, because a
// VACUUM while running would stall decode delivery for minutes.
func TestReclaimOnlyAtStartup(t *testing.T) {
	withVacuumGuards(t, 1<<40, nil)
	oldPause := dbAnalyzePause
	dbAnalyzePause = 0
	t.Cleanup(func() { dbAnalyzePause = oldPause })

	mgr, _ := oldStyleDB(t)
	mgr.runMaintenance(context.Background(), "nightly", true)
	var mode int
	mgr.db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
	if mode != 0 {
		t.Fatalf("the nightly pass changed auto_vacuum to %d; it must not vacuum", mode)
	}
	if !mgr.ReclaimSpaceAtStartup(context.Background()) {
		t.Fatal("startup did not reclaim")
	}
	mgr.db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
	if mode != 2 {
		t.Errorf("auto_vacuum %d after the startup reclaim, want 2", mode)
	}
}

// Pages freed by something other than the prune's own deletes (the background
// drop of the old PSK tables) are still released by the hourly pass.
func TestPruneReleasesPagesFreedElsewhere(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	db := mgr.DB()
	db.Exec(`CREATE TABLE legacy (id INTEGER PRIMARY KEY, v TEXT)`)
	tx, _ := db.Begin()
	pad := strings.Repeat("x", 2000)
	for i := 0; i < 3000; i++ {
		tx.Exec(`INSERT INTO legacy (v) VALUES (?)`, pad)
	}
	tx.Commit()
	db.Exec(`DROP TABLE legacy`)
	var free int64
	db.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	if free == 0 {
		t.Fatal("fixture freed nothing")
	}
	mgr.pruneAll(RetentionConfig{}) // nothing to prune
	db.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	if free != 0 {
		t.Errorf("%d free pages left after the hourly pass, want 0", free)
	}
}

// A VACUUM stopped part-way (a stop request at startup, or the timeout) rolls
// back: the database is intact, unchanged, and reclaims on a later start.
func TestReclaimInterruptedIsSafe(t *testing.T) {
	withVacuumGuards(t, 1<<40, nil)
	mgr, _ := oldStyleDB(t)
	// More data, so the VACUUM is still running when the context ends.
	tx, _ := mgr.db.Begin()
	pad := strings.Repeat("y", 3000)
	for i := 0; i < 40000; i++ {
		tx.Exec(`INSERT INTO keep (v) VALUES (?)`, pad)
	}
	tx.Commit()
	mgr.db.Exec(`DELETE FROM keep WHERE id > 20050`)

	interrupted := false
	for _, d := range []time.Duration{time.Millisecond, 5 * time.Millisecond, 20 * time.Millisecond, 80 * time.Millisecond} {
		ctx, cancel := context.WithTimeout(context.Background(), d)
		ok := mgr.reclaimSpace(ctx, "startup")
		cancel()
		if ok {
			t.Skipf("VACUUM finished within %v; cannot interrupt it on this machine", d)
		}
		var mode int
		mgr.db.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode)
		if mode == 0 {
			interrupted = true
			break
		}
	}
	if !interrupted {
		t.Fatal("could not interrupt the VACUUM")
	}
	var check string
	mgr.db.QueryRow(`PRAGMA integrity_check`).Scan(&check)
	var rows int
	mgr.db.QueryRow(`SELECT count(*) FROM keep`).Scan(&rows)
	if check != "ok" || rows != 20050 {
		t.Fatalf("after an interrupted VACUUM: integrity %q, %d rows; want ok and 20050", check, rows)
	}
	if !mgr.reclaimSpace(context.Background(), "startup") {
		t.Error("a later reclaim did not run")
	}
}
