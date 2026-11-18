package main

// db_manager.go — SQLite database manager for ka9q_ubersdr.
//
// Uses modernc.org/sqlite — a pure-Go SQLite implementation that requires no
// CGo and therefore builds cleanly in the Docker multi-stage build without any
// additional system packages or build flags.
//
// Schema mirrors the existing flat-file formats exactly so that a future
// migration can INSERT from the CSV/JSONL files without any field mapping:
//
//	sessions      — replaces session_activity_log JSONL (SessionActivityLog / SessionActivityEntry)
//	chat_messages — replaces chat CSV (ChatLogger: timestamp,source_ip,username,message,country,country_code)
//	spots         — replaces decoder spots CSV (SpotRecord / DecodeInfo)
//	cw_spots      — replaces CW skimmer spots CSV (CWSkimmerSpot)
//	noise_floor   — replaces noise floor CSV (BandMeasurement)
//	wspr_rank_*   — replaces stats/wspr JSONL (WSPRRankResponse)
//	psk_snapshots — replaces stats/psk JSONL (PSKRankData)
//	rbn_skew/_stats — replaces stats/rbn JSONL (RBNSkewEntry / RBNStatisticsEntry)
//
// WAL mode is enabled so concurrent readers never block the single writer.

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver; registers as "sqlite"
)

// DBManager wraps the SQLite database connection and owns the schema lifecycle.
// db is the single write connection (MaxOpenConns=1); readDB is a separate
// read-only pool (MaxOpenConns=4) that WAL mode allows to run concurrently
// with the writer without any Go-level serialization.
type DBManager struct {
	db     *sql.DB // write connection — single conn, all INSERTs/UPDATEs/PRAGMAs
	readDB *sql.DB // read-only pool — concurrent SELECTs, never blocks writes
	path   string
}

// NewDBManager opens (or creates) the SQLite database at the given path,
// applies PRAGMA settings, and ensures the schema is up to date.
// The caller is responsible for calling Close() when done.
func NewDBManager(dataDir string) (*DBManager, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("db_manager: create data dir %q: %w", dataDir, err)
	}

	dbPath := filepath.Join(dataDir, "ubersdr.db")

	// modernc driver name is "sqlite" (not "sqlite3")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("db_manager: open %q: %w", dbPath, err)
	}

	// SQLite only supports one writer at a time. Limiting the pool to a single
	// connection ensures all callers share the same connection (and therefore
	// the same PRAGMA settings, including busy_timeout). Without this, Go's
	// database/sql opens additional connections that do not inherit PRAGMAs
	// set on the initial connection, causing immediate SQLITE_BUSY failures
	// instead of the configured retry behaviour.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	// SQLite is not safe for concurrent writers from multiple OS threads unless
	// WAL mode is used. WAL allows one writer + many concurrent readers.
	pragmas := []string{
		// auto_vacuum must come first: it only takes effect on a database that
		// has never been written, and switching to WAL writes the header. Set
		// after journal_mode it was silently ignored, so every database was
		// created in mode NONE and incremental_vacuum never released a page.
		// Databases created that way stay in NONE (converting needs a full
		// VACUUM); their freed pages are reused by later inserts instead.
		"PRAGMA auto_vacuum=INCREMENTAL",
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL", // safe with WAL; faster than FULL
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",  // ms — retry on locked DB instead of failing immediately
		"PRAGMA cache_size=-131072", // 128 MiB page cache (negative value = KiB)
		// After a checkpoint, trim the -wal file back to 64 MiB rather than
		// leaving it at the size of the largest burst it ever held (the first
		// big retention prune, say). Costs nothing and never blocks.
		"PRAGMA journal_size_limit=67108864",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("db_manager: exec %q: %w", p, err)
		}
	}

	mgr := &DBManager{db: db, path: dbPath}

	if err := mgr.initSchema(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("db_manager: init schema: %w", err)
	}

	// Read-only connection pool — WAL mode allows many concurrent readers
	// alongside the single writer without any Go-level serialization.
	// Each connection gets its own OS file descriptor; SQLite WAL handles
	// snapshot isolation so readers never see a partial write transaction.
	//
	// PRAGMAs go in the DSN so the driver applies them to every connection the
	// pool opens; a db.Exec would reach only whichever one it happened to use.
	// busy_timeout: readers can briefly block during a WAL checkpoint; 5 s
	// matches the write connection. cache_size: 16 MiB per connection, so at
	// most 64 MiB across the pool -- SQLite's 2 MiB default is too small to
	// hold the hot pages of a production database.
	readDB, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&_pragma=busy_timeout(5000)&_pragma=cache_size(-16384)")
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("db_manager: open read pool %q: %w", dbPath, err)
	}
	readDB.SetMaxOpenConns(4)
	readDB.SetMaxIdleConns(4)
	if err := readDB.Ping(); err != nil {
		_ = db.Close()
		_ = readDB.Close()
		return nil, fmt.Errorf("db_manager: open read pool: %w", err)
	}
	mgr.readDB = readDB

	log.Printf("[DB] opened %s (write×1 + read×4)", dbPath)
	return mgr, nil
}

// DB returns the write *sql.DB. Use this for all INSERT/UPDATE/DELETE/PRAGMA
// operations. Only one connection is open; all writers are serialized here.
func (m *DBManager) DB() *sql.DB {
	return m.db
}

// ReadDB returns the read-only *sql.DB pool. Use this for all SELECT queries.
// WAL mode allows up to 4 concurrent reads alongside the single write
// connection with no serialization delay.
func (m *DBManager) ReadDB() *sql.DB {
	return m.readDB
}

// DBSizeStats holds the byte accounting of the SQLite database file, derived
// from the page_count / page_size / freelist_count pragmas.
type DBSizeStats struct {
	Path          string `json:"path"`
	PageCount     int64  `json:"page_count"`
	PageSize      int64  `json:"page_size"`
	FreelistCount int64  `json:"freelist_count"`
	TotalBytes    int64  `json:"total_bytes"` // page_count * page_size
	UsedBytes     int64  `json:"used_bytes"`  // (page_count - freelist_count) * page_size
	FreeBytes     int64  `json:"free_bytes"`  // freelist_count * page_size
}

// SizeStats reports the SQLite file's page accounting. Returns nil when the DB
// is unavailable.
func (m *DBManager) SizeStats() (*DBSizeStats, error) {
	if m == nil || m.readDB == nil {
		return nil, fmt.Errorf("database not available")
	}
	var s DBSizeStats
	s.Path = m.path
	err := m.readDB.QueryRow(`
		SELECT page_count, page_size, freelist_count,
		       page_count * page_size                         AS total_bytes,
		       (page_count - freelist_count) * page_size      AS used_bytes,
		       freelist_count * page_size                     AS free_bytes
		FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()`).
		Scan(&s.PageCount, &s.PageSize, &s.FreelistCount, &s.TotalBytes, &s.UsedBytes, &s.FreeBytes)
	if err != nil {
		return nil, fmt.Errorf("db size stats: %w", err)
	}
	return &s, nil
}

// RetentionConfig holds per-table retention periods in days.
// A value of 0 means "keep forever" (no automatic pruning for that table).
// Tables with no corresponding config field default to 0 (unlimited).
type RetentionConfig struct {
	// Sessions: config.Server.SessionActivityLogRetentionDays (default 30)
	SessionsDays int
	// Spots (decoder): decoder config spots_log_max_age_days (default 90)
	SpotsDays int
	// CWSpots: database.cw_spots_retention_days (default 90)
	CWSpotsDays int
	// Chat messages and moderation actions: database.chat_retention_days
	// (default 0 = keep forever)
	ChatDays int
	// NoiseFloor: database.noise_floor_retention_days (default 90)
	NoiseFloorDays int
	// SpaceWeather: database.space_weather_retention_days (default 365)
	SpaceWeatherDays int
	// Stats (WSPR/PSK/RBN leaderboards): the history endpoints refuse ranges
	// longer than statsMaxDays, so anything older is unreachable via the API.
	StatsDays int
	// DecoderMetricsSummary: no config field yet — 0 = unlimited. Summaries are
	// tiny (a handful of rows per band/period) so keeping them forever is cheap.
	DecoderMetricsSummaryDays int
	// CWMetricsSummary: database.metrics_summary_retention_days (default 730)
	CWMetricsSummaryDays int
	// NotificationLog: config.Database.NotificationLogRetentionDays (default 30)
	NotificationLogDays int
	// Decoder and CW skimmer metrics snapshots (decoder_metrics, cw_metrics):
	// database.metrics_retention_days (default 90)
	DecoderMetricsDays int
	CWMetricsDays      int
}

// retentionRule is one table the retention loop prunes: rows whose tsColumn is
// older than days are deleted. days <= 0 keeps the table forever.
type retentionRule struct {
	table string
	days  int
	// tsColumn is the timestamp column retention is measured against. Most
	// tables call it "ts"; the ones that do not have to say so, or the delete
	// fails on every run and the table grows without bound.
	tsColumn string
	// filter, when set, is a fixed SQL condition restricting the rule to some
	// of the table's rows, so different kinds of row can age differently. A
	// table split this way needs rules whose filters together cover every row.
	// Code constants only, never configuration or input.
	filter string
}

// retentionRules lists every table that holds rows over time. Every table in
// the schema must appear here or in retentionExempt; a test checks it, so a
// new table cannot be added that grows forever without anyone deciding so.
func retentionRules(cfg RetentionConfig) []retentionRule {
	return []retentionRule{
		// Sessions still running have no end yet, and "ended_at < cutoff" is
		// never true for NULL, so they are left alone. Bands and modes go with
		// the session via ON DELETE CASCADE.
		{"session", cfg.SessionsDays, "ended_at", ""},
		{"spots", cfg.SpotsDays, "ts", ""},
		{"spot_decoder_names", cfg.SpotsDays, "last_ts", ""},
		{"cw_spots", cfg.CWSpotsDays, "ts", ""},
		{"chat_messages", cfg.ChatDays, "ts", ""},
		{"chat_mod_actions", cfg.ChatDays, "ts", ""},
		{"noise_floor", cfg.NoiseFloorDays, "ts", ""},
		{"space_weather", cfg.SpaceWeatherDays, "ts", ""},
		// Stats tables all carry ts, so each prunes independently.
		{"wspr_rank_rows", cfg.StatsDays, "ts", ""},
		{"wspr_rank_windows", cfg.StatsDays, "ts", ""},
		{"psk_snapshots", cfg.StatsDays, "ts", ""},
		{"rbn_skew", cfg.StatsDays, "ts", ""},
		{"rbn_stats", cfg.StatsDays, "ts", ""},
		{"decoder_metrics", cfg.DecoderMetricsDays, "ts", ""},
		{"cw_metrics", cfg.CWMetricsDays, "ts", ""},
		// Daily summaries are the bulk of the summary tables (a row per band
		// and mode per day) and repeat what the raw metrics hold, so they age
		// with them. Weeks, months and years are a few hundred rows over years
		// and keep longer, so this year can still be compared with last.
		{"decoder_metrics_summary", cfg.DecoderMetricsDays, "ts", "period = 'day'"},
		{"decoder_metrics_summary", cfg.DecoderMetricsSummaryDays, "ts", "period != 'day'"},
		{"cw_metrics_summary", cfg.CWMetricsDays, "ts", "period = 'day'"},
		{"cw_metrics_summary", cfg.CWMetricsSummaryDays, "ts", "period != 'day'"},
		{"notification_log", cfg.NotificationLogDays, "ts", ""},
	}
}

// retentionExempt are the tables with no retention rule of their own, and why
// they are still bounded.
var retentionExempt = map[string]string{
	"session_band": "deleted with its session (ON DELETE CASCADE)",
	"session_mode": "deleted with its session (ON DELETE CASCADE)",
	"user_agent":   "rows no session references are swept after each prune (sweepUnusedUserAgents)",
}

// retentionInterval is how often the retention loop runs after the initial
// startup prune. 1 hour matches the CSV cleanup interval used by the spots
// logger and ensures pruning happens even on short-lived instances.
// Most hourly runs will find 0 rows to delete (cheap no-op).
const retentionInterval = 1 * time.Hour

// retentionStartupDelay holds the first prune back until the server has come
// up, rather than competing with everything it does at startup.
var retentionStartupDelay = 2 * time.Minute

// maintenanceStartupDelay is when the startup analysis of tables with no
// statistics runs: after the first retention pass.
var maintenanceStartupDelay = 3 * time.Minute

// StartRetentionLoop starts a background goroutine that prunes old rows from
// all DB tables shortly after startup and then every retentionInterval
// (hourly). Hourly rather than nightly keeps each run small: it deletes only
// what aged out in the last hour. A backlog (after downtime, or the first run
// under a new retention setting) is bounded per run by pruneMaxBatches and
// vacuumMaxChunks, so it is worked off over the following hours instead of in
// one long burst. It stops when ctx is cancelled (e.g. on graceful shutdown).
// Tables whose retention value is 0 are skipped (kept forever).
func (m *DBManager) StartRetentionLoop(ctx context.Context, cfg RetentionConfig) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(retentionStartupDelay):
		}
		m.safePruneAll(cfg)

		ticker := time.NewTicker(retentionInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.safePruneAll(cfg)
			}
		}
	}()
}

// Nightly maintenance runs at this local time in the receiver's timezone,
// when listeners are fewest.
const (
	dbMaintenanceHour   = 3
	dbMaintenanceMinute = 30
	// dbAnalysisLimit bounds ANALYZE to roughly this many rows per index, so
	// it samples a large table instead of reading all of it. SQLite applies a
	// similar limit by itself from 3.46; setting it keeps that true whatever
	// version the driver bundles.
	dbAnalysisLimit = 1000
	// dbMaintenanceTimeout cancels any one maintenance step that runs longer,
	// so a slow disk can never hold the write connection for long.
	dbMaintenanceTimeout = 2 * time.Minute
)

// StartMaintenanceLoop keeps the query planner's statistics current and the
// WAL in check, nightly at dbMaintenanceHour:dbMaintenanceMinute in loc: a
// sampled ANALYZE of every table, one at a time, then a PASSIVE checkpoint.
//
// Nightly only. ANALYZE's cost grows with the table even under analysis_limit
// (it still walks the table), and on a 5.8 GB database one table took 26 s;
// a pass shortly after startup held up every write for that long. Retention
// keeps tables bounded, so the nightly pass stays short, and it runs when the
// receiver is quietest.
//
// Everything here is chosen not to disturb a running receiver: a table at a
// time with pauses between so queued writes get through, each step with a
// timeout and cancelled at shutdown, the checkpoint PASSIVE (it never waits
// for readers, so it cannot stall the write connection behind a long query),
// a panic caught and logged, and a slow table named in the log. The write
// connection is a single conn, so none of it overlaps the retention loop's
// deletes; it queues behind them.
func (m *DBManager) StartMaintenanceLoop(ctx context.Context, loc *time.Location) {
	if loc == nil {
		loc = time.UTC
	}
	go func() {
		// Tables with no statistics yet (a new table, or every table after
		// the database is rebuilt by repair-database) get them shortly after
		// startup rather than at the next nightly run: without them the
		// planner guesses, and can pick an index that reads months of rows
		// for a one-day query. Tables that already have statistics are left
		// for the nightly run. It follows the first retention pass, so the
		// statistics describe the pruned tables.
		select {
		case <-ctx.Done():
			return
		case <-time.After(maintenanceStartupDelay):
		}
		m.runMaintenance(ctx, "startup", false)

		for {
			next := nextDailyRun(time.Now(), loc, dbMaintenanceHour, dbMaintenanceMinute)
			timer := time.NewTimer(time.Until(next))
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			m.runMaintenance(ctx, "nightly", true)
		}
	}()
}

// Space reclamation for databases created with auto_vacuum NONE (all of them,
// until NewDBManager set it before WAL). In that mode deleted rows and dropped
// tables only go to the freelist and the file never shrinks; only a full
// VACUUM gives the space back. These guard it.
var (
	vacuumMinFreeFraction       = 0.25      // of the file
	vacuumMinFreeBytes    int64 = 256 << 20 // and at least this much
	// The startup VACUUM delays the receiver coming up, so it gives up after
	// about three times the longest measured (3 min 20 s for 2.9 GB) and the
	// server starts normally; it is tried again on the next start.
	vacuumTimeout  = 10 * time.Minute
	vacuumDiskFree = dbDiskFree // replaced in tests
)

// ReclaimSpaceAtStartup runs reclaimSpace before the rest of the server
// starts. A VACUUM holds the only write connection for its whole run (3 min 20 s
// for a 2.9 GB database on an SSD), and decoder spots are written on the live
// decode delivery path, so while the server is up it would stall decodes to
// listeners. Before startup nothing is waiting on it.
//
// whileVacuuming, if not nil, is called only once a VACUUM is certain to run,
// just before it starts, and the function it returns is called when the
// VACUUM ends however it ends. main uses it to answer health checks on the
// HTTP port meanwhile, so Docker does not mark the container unhealthy.
func (m *DBManager) ReclaimSpaceAtStartup(ctx context.Context, whileVacuuming func() (done func())) bool {
	return m.reclaimSpace(ctx, "startup", whileVacuuming)
}

// reclaimSpace runs a one-time VACUUM on a database still in auto_vacuum NONE
// once enough of it is free space, switching it to INCREMENTAL as it does so
// (VACUUM applies a pending auto_vacuum change): from then on the chunked
// incremental_vacuum after each prune returns space as it is freed, and this
// never runs again. It reports whether it vacuumed.
//
// It runs only when it is worth it, only with room on disk for the rebuilt
// copy and its WAL, and under a timeout: an interrupted VACUUM rolls back
// cleanly and is tried again on the next start.
func (m *DBManager) reclaimSpace(ctx context.Context, when string, whileVacuuming func() (done func())) (vacuumed bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[DB] %s maintenance: reclaim recovered from panic: %v", when, r)
			vacuumed = false
		}
	}()
	var mode, pageSize, pages, free int64
	if err := m.db.QueryRowContext(ctx, "PRAGMA auto_vacuum").Scan(&mode); err != nil || mode == 2 {
		return false // INCREMENTAL: the prune loop's incremental_vacuum handles it
	}
	m.db.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize)
	m.db.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages)
	m.db.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&free)
	if pages == 0 || free*pageSize < vacuumMinFreeBytes || float64(free) < vacuumMinFreeFraction*float64(pages) {
		return false
	}
	used := (pages - free) * pageSize
	need := 2*used + (256 << 20)
	if m.path == "" {
		return false
	}
	avail, err := vacuumDiskFree(m.path)
	if err != nil {
		log.Printf("[DB] %s maintenance: not reclaiming %d MB of free space: %v", when, free*pageSize>>20, err)
		return false
	}
	if avail < need {
		log.Printf("[DB] %s maintenance: not reclaiming %d MB of free space: VACUUM needs about %d MB of disk, %d MB available",
			when, free*pageSize>>20, need>>20, avail>>20)
		return false
	}

	vctx, cancel := context.WithTimeout(ctx, vacuumTimeout)
	defer cancel()
	conn, err := m.db.Conn(vctx)
	if err != nil {
		return false
	}
	defer conn.Close()
	if whileVacuuming != nil {
		if done := whileVacuuming(); done != nil {
			defer done()
		}
	}
	log.Printf("[DB] %s maintenance: VACUUM to reclaim %d MB of %d MB. One-time, switching the database to incremental "+
		"auto_vacuum; this can take several minutes and the receiver starts when it finishes",
		when, free*pageSize>>20, pages*pageSize>>20)
	start := time.Now()
	if _, err := conn.ExecContext(vctx, "PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
		log.Printf("[DB] %s maintenance: auto_vacuum: %v", when, err)
		return false
	}
	if _, err := conn.ExecContext(vctx, "VACUUM"); err != nil {
		log.Printf("[DB] %s maintenance: VACUUM failed after %v (rolled back; tried again on the next start): %v",
			when, time.Since(start).Round(time.Millisecond), err)
		return false
	}
	// In WAL mode the rebuilt database is in the WAL until checkpointed; fold
	// it back now so the file shrinks and the WAL does not stay huge.
	var busy, frames, done int
	conn.QueryRowContext(vctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &frames, &done)
	var after, newMode int64
	conn.QueryRowContext(vctx, "PRAGMA page_count").Scan(&after)
	conn.QueryRowContext(vctx, "PRAGMA auto_vacuum").Scan(&newMode)
	log.Printf("[DB] %s maintenance: VACUUM took %v: %d MB -> %d MB, auto_vacuum now %d",
		when, time.Since(start).Round(time.Millisecond), pages*pageSize>>20, after*pageSize>>20, newMode)
	return true
}

// dbAnalyzePause is the gap between tables in a maintenance pass, so writes
// queued behind one table's ANALYZE get the connection before the next.
var dbAnalyzePause = 500 * time.Millisecond

// runMaintenance analyses tables one at a time and, at night, checkpoints the
// WAL. It returns the tables it analysed.
//
// One table per step, each on its own hold of the write connection with
// analysis_limit set, rather than a single PRAGMA optimize: that held the
// connection for 34 s on a 5.8 GB database, queueing every write behind it.
// Per-table steps let writes through between tables, give each table its own
// timeout, and log any table that is slow, so the cause shows in the log.
// nightly=false analyses only tables with no statistics yet.
func (m *DBManager) runMaintenance(ctx context.Context, when string, nightly bool) []string {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[DB] %s maintenance: recovered from panic: %v", when, r)
		}
	}()

	tables, err := m.analyzeCandidates(ctx, !nightly)
	if err != nil {
		log.Printf("[DB] %s maintenance: listing tables: %v", when, err)
	}
	var analysed []string
	var total, slowest time.Duration
	slowestTable := ""
	for i, table := range tables {
		if i > 0 {
			select {
			case <-ctx.Done():
			case <-time.After(dbAnalyzePause):
			}
		}
		if ctx.Err() != nil {
			break
		}
		took, err := m.analyzeTable(ctx, table)
		total += took
		if err != nil {
			log.Printf("[DB] %s maintenance: ANALYZE %s failed after %v: %v", when, table, took.Round(time.Millisecond), err)
			continue
		}
		analysed = append(analysed, table)
		if took > time.Second {
			log.Printf("[DB] %s maintenance: ANALYZE %s took %v", when, table, took.Round(time.Millisecond))
		}
		if took > slowest {
			slowest, slowestTable = took, table
		}
	}
	if len(analysed) > 0 {
		log.Printf("[DB] %s maintenance: analysed %d tables in %v (slowest %s, %v)",
			when, len(analysed), total.Round(time.Millisecond), slowestTable, slowest.Round(time.Millisecond))
	}

	if nightly && ctx.Err() == nil {
		cctx, cancel := context.WithTimeout(ctx, dbMaintenanceTimeout)
		defer cancel()
		start := time.Now()
		var busy, frames, done int
		if err := m.db.QueryRowContext(cctx, "PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &frames, &done); err != nil {
			log.Printf("[DB] %s maintenance: wal_checkpoint failed: %v", when, err)
		} else {
			log.Printf("[DB] %s maintenance: wal_checkpoint(PASSIVE) took %v (%d of %d frames checkpointed)",
				when, time.Since(start).Round(time.Millisecond), done, frames)
		}
	}
	return analysed
}

// analyzeCandidates lists the user tables, or with onlyNew just those that
// have no statistics yet.
func (m *DBManager) analyzeCandidates(ctx context.Context, onlyNew bool) ([]string, error) {
	query := `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
	if onlyNew {
		var hasStats int
		if err := m.db.QueryRowContext(ctx,
			`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`).Scan(&hasStats); err != nil {
			return nil, err
		}
		if hasStats > 0 {
			query += ` AND name NOT IN (SELECT DISTINCT tbl FROM sqlite_stat1)`
		}
	}
	rows, err := m.db.QueryContext(ctx, query+` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

// analyzeTable runs a sampled ANALYZE of one table on a held connection, so
// the analysis_limit it sets is the one ANALYZE sees.
func (m *DBManager) analyzeTable(ctx context.Context, table string) (time.Duration, error) {
	tctx, cancel := context.WithTimeout(ctx, dbMaintenanceTimeout)
	defer cancel()
	conn, err := m.db.Conn(tctx)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(tctx, fmt.Sprintf("PRAGMA analysis_limit=%d", dbAnalysisLimit)); err != nil {
		return 0, err
	}
	start := time.Now()
	_, err = conn.ExecContext(tctx, `ANALYZE "`+strings.ReplaceAll(table, `"`, `""`)+`"`)
	return time.Since(start), err
}

// nextDailyRun is the next hour:minute in loc strictly after now.
func nextDailyRun(now time.Time, loc *time.Location, hour, minute int) time.Time {
	l := now.In(loc)
	next := time.Date(l.Year(), l.Month(), l.Day(), hour, minute, 0, 0, loc)
	if !next.After(l) {
		next = time.Date(l.Year(), l.Month(), l.Day()+1, hour, minute, 0, 0, loc)
	}
	return next
}

// pruneAll deletes rows older than the configured retention period from each table,
// then reclaims freed pages via PRAGMA incremental_vacuum.
// Deletes are batched (pruneChunkSize rows at a time) to keep WAL pressure low
// and avoid blocking readers for extended periods on large tables.
// safePruneAll is pruneAll for the background loop: a panic is logged rather
// than taking the server down, and the next hourly run tries again.
func (m *DBManager) safePruneAll(cfg RetentionConfig) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[DB] retention: recovered from panic: %v", r)
		}
	}()
	m.pruneAll(cfg)
}

func (m *DBManager) pruneAll(cfg RetentionConfig) {
	for _, r := range retentionRules(cfg) {
		if r.days <= 0 {
			continue // 0 = keep forever
		}
		m.pruneTable(r, time.Now().UTC().AddDate(0, 0, -r.days).Unix())
	}
	m.sweepUnusedUserAgents()

	// Release free pages, whatever freed them: these deletes, or others such
	// as the background drop of the old PSK tables. Requires
	// auto_vacuum=INCREMENTAL, and returns at once when there is nothing free.
	m.incrementalVacuum()
}

// sweepUnusedUserAgents deletes user agents no session refers to any more,
// which once their sessions have been pruned is most of them. The session
// writer interns an agent in the same transaction as the session that uses it,
// and the write side is a single connection, so this can never remove an agent
// between its insertion and its first use.
func (m *DBManager) sweepUnusedUserAgents() bool {
	res, err := m.db.Exec(`DELETE FROM user_agent WHERE NOT EXISTS
		(SELECT 1 FROM session WHERE session.user_agent_id = user_agent.id)`)
	if err != nil {
		log.Printf("[DB] retention sweep user_agent: %v", err)
		return false
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		log.Printf("[DB] retention sweep user_agent: deleted %d agents no session uses", n)
	}
	return n > 0
}

// vacuumChunkPages is how many free pages one incremental_vacuum step
// releases: 4096 pages is 16 MiB at the default page size.
//
// vacuumMaxChunks caps one run at 256 chunks, 1 GiB at the default page
// size; the rest of the freelist is released on later runs (and its pages are
// reused by inserts meanwhile).
var (
	vacuumChunkPages int64 = 4096
	vacuumMaxChunks        = 256
)

// incrementalVacuum releases the freelist in chunks with a pause between
// them. A bare "PRAGMA incremental_vacuum" frees every page in one write
// transaction, which after a large prune (the first one under a new retention
// setting can delete months of rows) holds the write connection for as long
// as it takes to move gigabytes.
//
// A database created before auto_vacuum=INCREMENTAL was set stays in mode 0,
// where incremental_vacuum does nothing; it is skipped there, and the loop
// also stops as soon as a step fails to shrink the freelist, so it can never
// spin.
func (m *DBManager) incrementalVacuum() {
	var mode int
	if err := m.db.QueryRow("PRAGMA auto_vacuum").Scan(&mode); err != nil || mode != 2 {
		return
	}
	var freed int64
	last := int64(-1)
	for i := 0; i < vacuumMaxChunks; i++ {
		var free int64
		if err := m.db.QueryRow("PRAGMA freelist_count").Scan(&free); err != nil {
			log.Printf("[DB] incremental_vacuum: freelist_count: %v", err)
			return
		}
		if free == 0 || free == last {
			break
		}
		last = free
		if _, err := m.db.Exec(fmt.Sprintf("PRAGMA incremental_vacuum(%d)", vacuumChunkPages)); err != nil {
			log.Printf("[DB] incremental_vacuum: %v", err)
			return
		}
		if free > vacuumChunkPages {
			free = vacuumChunkPages
		}
		freed += free
		time.Sleep(100 * time.Millisecond)
	}
	if freed > vacuumChunkPages {
		log.Printf("[DB] incremental_vacuum: released %d pages", freed)
	}
}

// pruneChunkSize is the maximum number of rows deleted per batch.
// Keeping this small limits WAL growth and reader-blocking time.
//
// pruneMaxBatches caps the batches one table gets per run: 100 x 10,000 is a
// million rows, about 10 s of deleting with the pauses between batches. What
// is left is taken on the next hourly run.
var (
	pruneChunkSize  = 10_000
	pruneMaxBatches = 100
)

// pruneTable deletes rows with ts < cutoff from the named table in chunks,
// sleeping 100 ms between batches to yield to concurrent readers/writers.
// Returns true if any rows were deleted.
func (m *DBManager) pruneTable(r retentionRule, cutoff int64) bool {
	table, tsColumn, days := r.table, r.tsColumn, r.days
	if tsColumn == "" {
		tsColumn = "ts"
	}
	where := tsColumn + ` < ?`
	label := table
	if r.filter != "" {
		where += ` AND (` + r.filter + `)`
		label += " (" + r.filter + ")"
	}
	total := int64(0)
	query := `DELETE FROM ` + table + ` WHERE id IN (
		SELECT id FROM ` + table + ` WHERE ` + where + ` LIMIT ?
	)`
	backlog := false
	for batch := 0; ; batch++ {
		if batch == pruneMaxBatches {
			backlog = true
			break
		}
		res, err := m.db.Exec(query, cutoff, pruneChunkSize)
		if err != nil {
			log.Printf("[DB] retention prune %s: %v", label, err)
			return total > 0
		}
		n, _ := res.RowsAffected()
		total += n
		if n < int64(pruneChunkSize) {
			break // last (or only) batch
		}
		// Yield between batches so readers aren't starved.
		time.Sleep(100 * time.Millisecond)
	}
	if total > 0 {
		more := ""
		if backlog {
			more = "; more remain, continuing next run"
		}
		log.Printf("[DB] retention prune %s: deleted %d rows older than %d days%s", label, total, days, more)
	}
	return total > 0
}

// Close closes both the write connection and the read-only pool.
func (m *DBManager) Close() error {
	if m.readDB != nil {
		_ = m.readDB.Close()
	}
	if m.db != nil {
		log.Printf("[DB] closing %s", m.path)
		return m.db.Close()
	}
	return nil
}

// migrateColumns adds columns that were introduced after a table's original
// definition. Each entry is skipped when the table does not exist yet (a fresh
// database gets the column from the CREATE TABLE statement in initSchema) or
// when the column is already present.
func (m *DBManager) migrateColumns() error {
	migrations := []struct {
		table  string
		column string
		ddl    string
	}{
		// protocol: "native" | "kiwi" | "websdr" — which front-end the listener
		// connected through. Backfilled below from the user_session_id prefix.
		{"sessions", "protocol", `ALTER TABLE sessions ADD COLUMN protocol TEXT`},
		// Chat moderation: what the filter did, the original text when it was
		// changed, and soft deletion so removed messages stay in the admin logs.
		{"chat_messages", "status", `ALTER TABLE chat_messages ADD COLUMN status TEXT DEFAULT 'ok'`},
		{"chat_messages", "message_raw", `ALTER TABLE chat_messages ADD COLUMN message_raw TEXT`},
		{"chat_messages", "deleted_at", `ALTER TABLE chat_messages ADD COLUMN deleted_at INTEGER`},
		{"chat_messages", "deleted_by", `ALTER TABLE chat_messages ADD COLUMN deleted_by TEXT`},
	}

	for _, mig := range migrations {
		exists, hasCol, err := m.tableColumnState(mig.table, mig.column)
		if err != nil {
			return err
		}
		if !exists || hasCol {
			continue
		}
		if _, err := m.db.Exec(mig.ddl); err != nil {
			return fmt.Errorf("migrate %s.%s: %w", mig.table, mig.column, err)
		}
		log.Printf("[DB] migration: added column %s.%s", mig.table, mig.column)

		if mig.table == "sessions" && mig.column == "protocol" {
			res, err := m.db.Exec(`UPDATE sessions SET protocol = CASE
				WHEN user_session_id LIKE 'kiwi-%'   THEN 'kiwi'
				WHEN user_session_id LIKE 'websdr-%' THEN 'websdr'
				ELSE 'native' END`)
			if err != nil {
				return fmt.Errorf("backfill sessions.protocol: %w", err)
			}
			if n, err := res.RowsAffected(); err == nil {
				log.Printf("[DB] migration: backfilled protocol on %d sessions rows", n)
			}
		}
	}

	return nil
}

// tableColumnState reports whether the table exists and, if so, whether it
// already has the named column.
func (m *DBManager) tableColumnState(table, column string) (tableExists, hasColumn bool, err error) {
	rows, err := m.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, false, fmt.Errorf("table_info(%s): %w", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dfltValue, &pk); err != nil {
			return false, false, fmt.Errorf("table_info(%s) scan: %w", table, err)
		}
		tableExists = true
		if name == column {
			hasColumn = true
		}
	}
	if err := rows.Err(); err != nil {
		return false, false, err
	}
	return tableExists, hasColumn, nil
}

// initSchema creates all tables and indexes if they do not already exist.
// Column names and types mirror the existing Go structs and CSV column order
// so that future migration code can map fields 1-to-1.
func (m *DBManager) initSchema() error {
	// Bring pre-existing tables up to date before the DDL below runs: CREATE
	// TABLE IF NOT EXISTS is a no-op on an existing table, so new columns must
	// be added explicitly. This runs first so that indexes referencing new
	// columns can be created unconditionally further down.
	if err := m.migrateColumns(); err != nil {
		return err
	}

	stmts := []struct {
		name string
		ddl  string
	}{
		// The legacy `sessions` snapshot table is deliberately NOT created here.
		// Receivers record sessions in the tables below; the old table only exists
		// on installations that predate them, where it is converted once and then
		// dropped -- see session_history_migration.go.

		// ----------------------------------------------------------------
		// session / session_band / session_mode / user_agent
		//
		// Replaces the `sessions` snapshot log above for everything written
		// from this version on. That table is an append-only JSONL design
		// carried over verbatim: every event re-serialises the whole active
		// set, so a row is written per active session per event and the row
		// count grows as (events x concurrent sessions). On a real receiver
		// that is ~50x more rows than there were sessions, and answering
		// "what happened over the last 28 days" meant replaying all of them
		// and reconstructing session lifetimes by diffing consecutive
		// snapshots.
		//
		// A session has an identity (user_session_id), so it gets one row
		// that is updated in place. Tuning from 20m to 40m is an INSERT OR
		// IGNORE into session_band, not another copy of the whole session.
		// Statistics become ordinary aggregate queries over an indexed table
		// the size of the session count.
		// ----------------------------------------------------------------
		{
			"user_agent",
			`CREATE TABLE IF NOT EXISTS user_agent (
				id      INTEGER PRIMARY KEY AUTOINCREMENT,
				ua      TEXT NOT NULL UNIQUE,
				browser TEXT NOT NULL DEFAULT '',   -- parsed once per distinct agent
				os      TEXT NOT NULL DEFAULT ''
			)`,
		},
		{
			"session",
			`CREATE TABLE IF NOT EXISTS session (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				user_session_id TEXT    NOT NULL UNIQUE,
				started_at      INTEGER NOT NULL,   -- Unix seconds UTC
				ended_at        INTEGER,            -- NULL while the session is live
				last_seen       INTEGER NOT NULL,   -- heartbeat, so a crash can be swept up
				client_ip       TEXT,
				source_ip       TEXT,
				auth_method     TEXT    NOT NULL DEFAULT '',  -- "" | "password" | "ip_bypass"
				protocol        TEXT,                          -- "native" | "kiwi" | "websdr"
				user_agent_id   INTEGER REFERENCES user_agent(id),
				-- Geo resolved once, at session start, so reads never call GeoIP.
				country         TEXT,
				country_code    TEXT,
				latitude        REAL,
				longitude       REAL,
				has_audio       INTEGER NOT NULL DEFAULT 0,
				has_spectrum    INTEGER NOT NULL DEFAULT 0
			)`,
		},
		{"session_idx_ended", `CREATE INDEX IF NOT EXISTS session_idx_ended   ON session(ended_at)`},
		{"session_idx_started", `CREATE INDEX IF NOT EXISTS session_idx_started ON session(started_at)`},
		{"session_idx_open", `CREATE INDEX IF NOT EXISTS session_idx_open    ON session(last_seen) WHERE ended_at IS NULL`},
		// For the retention sweep of unused user agents, and for SQLite's own
		// foreign key check when one is deleted: without it each costs a scan
		// of every session.
		{"session_idx_user_agent", `CREATE INDEX IF NOT EXISTS session_idx_user_agent ON session(user_agent_id)`},
		{
			"session_band",
			`CREATE TABLE IF NOT EXISTS session_band (
				session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
				band       TEXT    NOT NULL,
				PRIMARY KEY (session_id, band)
			)`,
		},
		{"session_band_idx_band", `CREATE INDEX IF NOT EXISTS session_band_idx_band ON session_band(band)`},
		{
			"session_mode",
			`CREATE TABLE IF NOT EXISTS session_mode (
				session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
				mode       TEXT    NOT NULL,
				PRIMARY KEY (session_id, mode)
			)`,
		},
		{"session_mode_idx_mode", `CREATE INDEX IF NOT EXISTS session_mode_idx_mode ON session_mode(mode)`},

		// ----------------------------------------------------------------
		// chat_messages
		//
		// Replaces: <dataDir>/YYYY/MM/DD/chat.csv
		// CSV columns: timestamp, source_ip, username, message, country, country_code
		// Source: ChatLogger.LogMessage()
		// ----------------------------------------------------------------
		{
			"chat_messages",
			`CREATE TABLE IF NOT EXISTS chat_messages (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				ts           INTEGER NOT NULL,  -- Unix seconds UTC
				source_ip    TEXT,
				username     TEXT,
				message      TEXT,
				country      TEXT,
				country_code TEXT,              -- ISO 3166-1 alpha-2
				status       TEXT DEFAULT 'ok', -- ok | censored | blocked
				message_raw  TEXT,              -- original text when status != ok
				deleted_at   INTEGER,           -- Unix seconds UTC, NULL = visible
				deleted_by   TEXT
			)`,
		},
		{"chat_idx_ts", `CREATE INDEX IF NOT EXISTS chat_idx_ts       ON chat_messages(ts)`},
		{"chat_idx_ip", `CREATE INDEX IF NOT EXISTS chat_idx_ip       ON chat_messages(source_ip)`},
		{"chat_idx_username", `CREATE INDEX IF NOT EXISTS chat_idx_username ON chat_messages(username)`},

		// ----------------------------------------------------------------
		// chat_mod_actions — chat moderation history and active chat bans.
		// action: warn | auto_warn | delete | chat_ban | auto_chat_ban |
		//         lift | sdr_ban | auto_sdr_ban
		// ----------------------------------------------------------------
		{
			"chat_mod_actions",
			`CREATE TABLE IF NOT EXISTS chat_mod_actions (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				ts         INTEGER NOT NULL,  -- Unix seconds UTC
				action     TEXT    NOT NULL,
				ip         TEXT,
				username   TEXT,
				by_who     TEXT,
				reason     TEXT,
				expires_at INTEGER,           -- chat bans: Unix seconds UTC
				lifted_at  INTEGER,
				count      INTEGER            -- e.g. messages deleted
			)`,
		},
		{"chat_mod_actions_idx_ts", `CREATE INDEX IF NOT EXISTS chat_mod_actions_idx_ts ON chat_mod_actions(ts)`},
		{"chat_mod_actions_idx_ip", `CREATE INDEX IF NOT EXISTS chat_mod_actions_idx_ip ON chat_mod_actions(ip)`},

		// ----------------------------------------------------------------
		// spots
		//
		// Replaces: <dataDir>/<MODE>/YYYY/MM/DD/<band>.csv
		// CSV columns (v2, 14 cols): timestamp, callsign, locator, snr,
		//   frequency, band, message, country, cq_zone, itu_zone, continent,
		//   distance_km, bearing_deg, dbm
		// Source struct: SpotRecord / DecodeInfo
		// ----------------------------------------------------------------
		{
			"spots",
			`CREATE TABLE IF NOT EXISTS spots (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				ts           INTEGER NOT NULL,  -- Unix seconds UTC
				mode         TEXT    NOT NULL,  -- "FT8" | "FT4" | "WSPR" | "JS8" | "FT2" …
				decoder_name TEXT,              -- decoder config band name (SpotRecord.Name)
				callsign     TEXT,
				locator      TEXT,              -- Maidenhead grid square
				snr          INTEGER,           -- dB
				frequency    INTEGER,           -- Hz
				band         TEXT,              -- calculated from frequency e.g. "20m"
				message      TEXT,              -- raw decoded message
				country      TEXT,
				cq_zone      INTEGER,
				itu_zone     INTEGER,
				continent    TEXT,
				distance_km  REAL,              -- NULL when not computed
				bearing_deg  REAL,              -- NULL when not computed
				dbm          INTEGER            -- transmitter power dBm (WSPR only, else NULL)
			)`,
		},
		// Every spots query has a ts range, so (ts, mode) serves them all,
		// including the dates list and the retention prune; callsign serves
		// callsign searches across the whole retention period. On a busy
		// receiver each index costs about as much as a fifth of the table,
		// so there are no others: see obsoleteIndexes for the ones earlier
		// versions created and why each was dropped.
		{"spots_idx_ts_mode", `CREATE INDEX IF NOT EXISTS spots_idx_ts_mode     ON spots(ts, mode)`},
		{"spots_idx_callsign", `CREATE INDEX IF NOT EXISTS spots_idx_callsign    ON spots(callsign)`},

		// ----------------------------------------------------------------
		// spot_decoder_names
		//
		// The decoder config names that have spots, for the history page's
		// name filter (GetAvailableNames). One row per name, so listing them
		// does not need an index over every spot's decoder_name. LogSpot
		// keeps last_ts current (rounded up to the hour, at most one write
		// per name per hour) and retention drops a name with its last spots.
		// ----------------------------------------------------------------
		{
			"spot_decoder_names",
			`CREATE TABLE IF NOT EXISTS spot_decoder_names (
				id      INTEGER PRIMARY KEY,
				name    TEXT    NOT NULL UNIQUE,
				last_ts INTEGER NOT NULL  -- Unix seconds UTC of its newest spot (or later)
			)`,
		},
		{"spot_decoder_names_idx_last_ts", `CREATE INDEX IF NOT EXISTS spot_decoder_names_idx_last_ts ON spot_decoder_names(last_ts)`},

		// ----------------------------------------------------------------
		// cw_spots
		//
		// Replaces: <dataDir>/YYYY/MM/DD/<band>.csv
		// CSV columns (13 cols): timestamp, dx_call, snr, frequency, band,
		//   wpm, comment, country, cq_zone, itu_zone, continent,
		//   distance_km, bearing_deg
		// Source struct: CWSkimmerSpot
		// ----------------------------------------------------------------
		{
			"cw_spots",
			`CREATE TABLE IF NOT EXISTS cw_spots (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				ts           INTEGER NOT NULL,  -- Unix seconds UTC (CWSkimmerSpot.Time)
				dx_call      TEXT,              -- callsign being spotted
				spotter      TEXT,              -- skimmer callsign
				snr          INTEGER,           -- dB
				frequency    REAL,              -- Hz (stored as float to match CWSkimmerSpot.Frequency)
				band         TEXT,
				wpm          INTEGER,           -- speed in WPM (CW) or BPS (RTTY)
				mode         TEXT,              -- "CW" | "RTTY"
				comment      TEXT,              -- "CQ", "DE", or empty
				country      TEXT,
				country_code TEXT,              -- ISO 3166-1 alpha-2
				cq_zone      INTEGER,
				itu_zone     INTEGER,
				continent    TEXT,
				latitude     REAL,
				longitude    REAL,
				distance_km  REAL,              -- NULL when not computed
				bearing_deg  REAL,              -- NULL when not computed
				-- QRZ enrichment (optional, populated when callsign lookup enabled)
				op_name      TEXT,              -- operator name (QRZ name_fmt)
				state        TEXT,              -- state/region
				grid         TEXT,              -- Maidenhead grid square
				geoloc       TEXT,              -- QRZ geoloc source
				tz_iana      TEXT,              -- IANA timezone
				loc_source   TEXT               -- "qrz" | "cty"
			)`,
		},
		// (ts, band) serves every time-range query and the dates list; band
		// the band list; dx_call callsign searches. See obsoleteIndexes for
		// the ones dropped.
		{"cw_spots_idx_ts_band", `CREATE INDEX IF NOT EXISTS cw_spots_idx_ts_band  ON cw_spots(ts, band)`},
		{"cw_spots_idx_band", `CREATE INDEX IF NOT EXISTS cw_spots_idx_band     ON cw_spots(band)`},
		{"cw_spots_idx_dx_call", `CREATE INDEX IF NOT EXISTS cw_spots_idx_dx_call  ON cw_spots(dx_call)`},

		// ----------------------------------------------------------------
		// noise_floor
		//
		// Replaces: <dataDir>/YYYY/MM/DD/<band>.csv
		// CSV columns (13 cols): timestamp, min_db, max_db, mean_db,
		//   median_db, p5_db, p10_db, p95_db, dynamic_range, occupancy_pct,
		//   ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz
		// Source struct: BandMeasurement
		// ----------------------------------------------------------------
		{
			"noise_floor",
			`CREATE TABLE IF NOT EXISTS noise_floor (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				ts              INTEGER NOT NULL,  -- Unix seconds UTC
				band            TEXT    NOT NULL,  -- e.g. "20m", "40m"
				min_db          REAL,
				max_db          REAL,
				mean_db         REAL,
				median_db       REAL,
				p5_db           REAL,              -- 5th percentile — noise floor estimate
				p10_db          REAL,              -- 10th percentile
				p95_db          REAL,              -- 95th percentile — signal peak
				dynamic_range   REAL,              -- p95_db - p5_db
				occupancy_pct   REAL,              -- % of bins above noise + 10 dB
				ft8_snr         REAL,              -- FT8 signal power minus noise floor (dB)
				snr_0_30_mhz    REAL,              -- wideband SNR 0–30 MHz
				snr_1_8_30_mhz  REAL               -- wideband SNR 1.8–30 MHz (HF bands only)
			)`,
		},
		{"noise_floor_idx_ts", `CREATE INDEX IF NOT EXISTS noise_floor_idx_ts      ON noise_floor(ts)`},
		{"noise_floor_idx_band", `CREATE INDEX IF NOT EXISTS noise_floor_idx_band    ON noise_floor(band)`},
		{"noise_floor_idx_ts_band", `CREATE INDEX IF NOT EXISTS noise_floor_idx_ts_band ON noise_floor(ts, band)`},

		// ----------------------------------------------------------------
		// space_weather
		//
		// Replaces: <dataDir>/YYYY/MM/spaceweather-YYYY-MM-DD.csv
		// CSV columns: timestamp, solar_flux, k_index, k_index_status,
		//   a_index, solar_wind_bz, propagation_quality,
		//   forecast_g_scale, forecast_g_text,
		//   forecast_r_scale, forecast_r_text, forecast_r_minor_prob, forecast_r_major_prob,
		//   forecast_s_scale, forecast_s_text, forecast_s_prob, forecast_summary,
		//   day_160m … day_10m (10 cols), night_160m … night_10m (10 cols)
		// Source struct: SpaceWeatherData / ForecastData
		// ----------------------------------------------------------------
		{
			"space_weather",
			`CREATE TABLE IF NOT EXISTS space_weather (
				id                    INTEGER PRIMARY KEY AUTOINCREMENT,
				ts                    INTEGER NOT NULL,  -- Unix seconds UTC (SpaceWeatherData.LastUpdate)
				solar_flux            REAL,              -- 10.7cm solar flux (SFU)
				k_index               INTEGER,           -- Planetary K-index (0-9)
				k_index_status        TEXT,              -- "Quiet" | "Unsettled" | "Active" | "Storm"
				a_index               INTEGER,           -- Planetary A-index
				solar_wind_bz         REAL,              -- Solar wind Bz component (nT)
				propagation_quality   TEXT,              -- "Poor" | "Fair" | "Good" | "Excellent"
				-- Forecast (NULL when not available)
				forecast_g_scale      TEXT,
				forecast_g_text       TEXT,
				forecast_r_scale      TEXT,
				forecast_r_text       TEXT,
				forecast_r_minor_prob TEXT,
				forecast_r_major_prob TEXT,
				forecast_s_scale      TEXT,
				forecast_s_text       TEXT,
				forecast_s_prob       TEXT,
				forecast_summary      TEXT,
				-- Band conditions (day) — "Poor" | "Fair" | "Good"
				day_160m TEXT, day_80m TEXT, day_60m TEXT, day_40m TEXT, day_30m TEXT,
				day_20m  TEXT, day_17m TEXT, day_15m TEXT, day_12m TEXT, day_10m TEXT,
				-- Band conditions (night)
				night_160m TEXT, night_80m TEXT, night_60m TEXT, night_40m TEXT, night_30m TEXT,
				night_20m  TEXT, night_17m TEXT, night_15m TEXT, night_12m TEXT, night_10m TEXT
			)`,
		},
		{"space_weather_idx_ts", `CREATE INDEX IF NOT EXISTS space_weather_idx_ts ON space_weather(ts)`},

		// ----------------------------------------------------------------
		// decoder_metrics
		//
		// Replaces: <dataDir>/YYYY/MM/DD/<MODE>-<BAND>.jsonl
		// Source struct: MetricsSnapshot (decoder_metrics_log.go)
		// Written every metrics_log_interval (default 5 min) per mode/band.
		// ----------------------------------------------------------------
		{
			"decoder_metrics",
			`CREATE TABLE IF NOT EXISTS decoder_metrics (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				ts                   INTEGER NOT NULL,  -- Unix seconds UTC
				mode                 TEXT    NOT NULL,  -- e.g. "FT8", "WSPR"
				band                 TEXT    NOT NULL,  -- e.g. "20m"
				band_name            TEXT,              -- decoder config name
				-- Decode counts
				decodes_1h           INTEGER,
				decodes_3h           INTEGER,
				decodes_6h           INTEGER,
				decodes_12h          INTEGER,
				decodes_24h          INTEGER,
				-- Decodes per cycle (rolling averages)
				dpc_1m               REAL,
				dpc_5m               REAL,
				dpc_15m              REAL,
				dpc_30m              REAL,
				dpc_60m              REAL,
				-- Unique callsigns
				unique_calls_1h      INTEGER,
				unique_calls_3h      INTEGER,
				unique_calls_6h      INTEGER,
				unique_calls_12h     INTEGER,
				unique_calls_24h     INTEGER,
				-- Execution time (seconds)
				exec_avg_1m          REAL,
				exec_min_1m          REAL,
				exec_max_1m          REAL,
				exec_avg_5m          REAL,
				exec_min_5m          REAL,
				exec_max_5m          REAL,
				-- Activity
				decodes_per_hour     REAL,
				callsigns_per_hour   REAL,
				activity_score       REAL
			)`,
		},
		{"decoder_metrics_idx_ts", `CREATE INDEX IF NOT EXISTS decoder_metrics_idx_ts      ON decoder_metrics(ts)`},
		{"decoder_metrics_idx_mode_band", `CREATE INDEX IF NOT EXISTS decoder_metrics_idx_mode_band ON decoder_metrics(mode, band)`},
		{"decoder_metrics_idx_ts_mode_band", `CREATE INDEX IF NOT EXISTS decoder_metrics_idx_ts_mode_band ON decoder_metrics(ts, mode, band)`},

		// ----------------------------------------------------------------
		// cw_metrics
		//
		// Replaces: <dataDir>/YYYY/MM/DD/<BAND>.jsonl
		// Source struct: CWMetricsSnapshot (cwskimmer_metrics.go)
		// Written every metrics_log_interval (default 5 min) per band.
		// ----------------------------------------------------------------
		{
			"cw_metrics",
			`CREATE TABLE IF NOT EXISTS cw_metrics (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				ts                   INTEGER NOT NULL,  -- Unix seconds UTC
				band                 TEXT    NOT NULL,  -- e.g. "20m"
				-- Spot counts
				spots_1h             INTEGER,
				spots_24h            INTEGER,
				-- Unique callsigns
				unique_calls_1h      INTEGER,
				unique_calls_24h     INTEGER,
				-- Activity
				spots_per_hour       REAL,
				callsigns_per_hour   REAL,
				activity_score       REAL,
				-- WPM stats (1-minute window)
				wpm_avg_1m           REAL,
				wpm_min_1m           INTEGER,
				wpm_max_1m           INTEGER,
				-- WPM stats (5-minute window)
				wpm_avg_5m           REAL,
				wpm_min_5m           INTEGER,
				wpm_max_5m           INTEGER,
				-- WPM stats (10-minute window)
				wpm_avg_10m          REAL,
				wpm_min_10m          INTEGER,
				wpm_max_10m          INTEGER
			)`,
		},
		{"cw_metrics_idx_ts", `CREATE INDEX IF NOT EXISTS cw_metrics_idx_ts   ON cw_metrics(ts)`},
		{"cw_metrics_idx_band", `CREATE INDEX IF NOT EXISTS cw_metrics_idx_band ON cw_metrics(band)`},
		{"cw_metrics_idx_ts_band", `CREATE INDEX IF NOT EXISTS cw_metrics_idx_ts_band ON cw_metrics(ts, band)`},

		// ----------------------------------------------------------------
		// wspr_rank_windows / wspr_rank_rows
		//
		// Replaces: <statsDir>/wspr/YYYY/MM/DD/rolling_24h.jsonl
		// Source structs: WSPRRankResponse → WSPRRankWindow → WSPRRankRow
		//
		// One WSPRRankResponse (written hourly) holds three windows
		// (rolling_24h, yesterday, today), each with its own fetch metadata
		// and a leaderboard of receivers. The window envelope goes in
		// wspr_rank_windows and the leaderboard rows in wspr_rank_rows.
		//
		// A separate envelope table (rather than denormalising onto every
		// row as sessions does) is required because a window can legitimately
		// have zero rows — a failed fetch still carries fetched_ms and error
		// that the API response must reproduce.
		//
		// ts is WSPRRankResponse.GeneratedAt on BOTH tables so that date-range
		// queries and retention pruning work on either without a join.
		//
		// The per-band parallel arrays (bands/uniques/gross/dupes) and
		// versions are stored as JSON TEXT. Normalising them would multiply
		// the row count by ~10 (one row per receiver per band per hour) for
		// data that is only ever read back as a whole row.
		//
		// Indexes: none beyond the UNIQUE constraints. Both tables are only
		// ever queried as `WHERE ts >= ? AND ts < ?` with an ORDER BY that the
		// UNIQUE index already satisfies — UNIQUE(ts, window_name, rank_pos)
		// serves `ORDER BY ts, window_name, rank_pos` (loadWSPRSnapshots) with
		// no sort, and also serves the retention DELETE and MAX(ts). Adding a
		// separate (ts) or (ts, window_name, rank_pos) index only duplicates
		// it: wspr_rank_rows takes ~150k inserts/day, so every extra B-tree is
		// paid on every one of them.
		//
		// An rx_sign index would be dead weight too — the callsign filter on
		// /api/stats/wspr-rank is applied in Go after the whole range is
		// loaded (extractWSPRWindowRank), never in SQL. If that filter is ever
		// pushed down, the index to add is (rx_sign, ts), not (rx_sign).
		// ----------------------------------------------------------------
		{
			"wspr_rank_windows",
			`CREATE TABLE IF NOT EXISTS wspr_rank_windows (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				ts           INTEGER NOT NULL,  -- Unix seconds UTC (WSPRRankResponse.GeneratedAt)
				window_name  TEXT    NOT NULL,  -- "rolling_24h" | "yesterday" | "today"
				fetched_at   INTEGER,           -- Unix seconds UTC (WSPRRankWindow.FetchedAt)
				fetched_ms   INTEGER,           -- round-trip duration of the wspr.live query
				row_count    INTEGER,           -- WSPRRankWindow.Rows as reported by the source
				error        TEXT,              -- non-empty when the window's fetch failed
				UNIQUE(ts, window_name)
			)`,
		},
		{
			"wspr_rank_rows",
			`CREATE TABLE IF NOT EXISTS wspr_rank_rows (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				ts           INTEGER NOT NULL,  -- Unix seconds UTC — matches wspr_rank_windows.ts
				window_name  TEXT    NOT NULL,  -- "rolling_24h" | "yesterday" | "today"
				rank_pos     INTEGER NOT NULL,  -- 0-based position in the source array; preserves order
				rx_sign      TEXT    NOT NULL,  -- receiver callsign
				rx_loc       TEXT,              -- Maidenhead locator
				raw          INTEGER,           -- total spots
				dupe         INTEGER,           -- duplicate spots
				unique_count INTEGER,           -- unique spots (WSPRRankRow.Unique)
				bands        TEXT,              -- JSON array of int16 metres
				uniques      TEXT,              -- JSON array of uint64, parallel to bands
				gross        TEXT,              -- JSON array of uint64, parallel to bands
				dupes        TEXT,              -- JSON array of uint64, parallel to bands
				versions     TEXT,              -- JSON array of client version strings
				UNIQUE(ts, window_name, rank_pos)
			)`,
		},

		// ----------------------------------------------------------------
		// psk_snapshots
		//
		// Source struct: PSKRankData (psk_rank.go), one row per hourly scrape
		// of pskreporter.info. The two leaderboards and the software map are
		// zstd-compressed blobs; stats_psk_store.go explains why (every reader
		// wants whole snapshots). This replaced the row-per-entry
		// psk_rank_snapshots / psk_rank_entries / psk_software tables, which
		// dropLegacyPSKTables removes in the background.
		//
		// UNIQUE(ts) serves the range, nearest-ts and latest lookups.
		// ----------------------------------------------------------------
		{
			"psk_snapshots",
			`CREATE TABLE IF NOT EXISTS psk_snapshots (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				ts         INTEGER NOT NULL UNIQUE,  -- Unix seconds UTC (PSKRankData.FetchedAt)
				fetched_ms INTEGER,                  -- scrape duration in milliseconds
				error      TEXT,                     -- non-empty when the scrape failed
				encoding   INTEGER NOT NULL,         -- blob format; 1 = zstd(binary), see stats_psk_store.go
				boards     BLOB,                     -- report + country leaderboards (~16 KB)
				software   BLOB                      -- callsign -> software map (~180 KB)
			)`,
		},

		// ----------------------------------------------------------------
		// rbn_skew / rbn_stats
		//
		// Replaces: <statsDir>/rbn/YYYY/MM/DD/skew.jsonl
		//           <statsDir>/rbn/YYYY/MM/DD/statistics.jsonl
		// Source structs: RBNSkewEntry / RBNStatisticsEntry (rbn_data.go)
		//
		// Both are flat CSV rows from sm7iun.se, fetched once per day. The
		// JSONL writer truncates the day's file on each successful fetch;
		// the DB writer mirrors that by deleting the day's rows first, so
		// there is exactly one snapshot per UTC day.
		//
		// source_comment (the "# Calculated …" header line) is denormalised
		// onto every row — it is per-snapshot, but carrying it avoids a join
		// for what is a single short string.
		//
		// Indexes: unlike the WSPR and PSK tables these DO keep a standalone
		// (ts) index, and it is not redundant with UNIQUE(ts, callsign).
		// readRBNFromDB orders by `ts, id`; a (ts) index yields that directly
		// (entries with equal keys are stored in rowid order), whereas the
		// UNIQUE index orders by callsign within a ts and forces a sort —
		// EXPLAIN QUERY PLAN reports "USE TEMP B-TREE FOR LAST TERM OF ORDER
		// BY" without it. A callsign index is not needed: nothing filters on
		// callsign in SQL.
		// ----------------------------------------------------------------
		{
			"rbn_skew",
			`CREATE TABLE IF NOT EXISTS rbn_skew (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				ts                INTEGER NOT NULL,  -- Unix seconds UTC (fetch time)
				source_comment    TEXT,              -- CSV header comment line
				callsign          TEXT    NOT NULL,
				skew              REAL,              -- frequency skew in Hz
				spots             INTEGER,           -- spot count the skew was derived from
				correction_factor REAL,
				UNIQUE(ts, callsign)
			)`,
		},
		{"rbn_skew_idx_ts", `CREATE INDEX IF NOT EXISTS rbn_skew_idx_ts       ON rbn_skew(ts)`},
		{
			"rbn_stats",
			`CREATE TABLE IF NOT EXISTS rbn_stats (
				id             INTEGER PRIMARY KEY AUTOINCREMENT,
				ts             INTEGER NOT NULL,  -- Unix seconds UTC (fetch time)
				source_comment TEXT,              -- CSV header comment line
				callsign       TEXT    NOT NULL,
				epoch_date     INTEGER,           -- epoch day number as published by RBN
				spot_count     INTEGER,
				UNIQUE(ts, callsign)
			)`,
		},
		{"rbn_stats_idx_ts", `CREATE INDEX IF NOT EXISTS rbn_stats_idx_ts       ON rbn_stats(ts)`},

		// ----------------------------------------------------------------
		// decoder_metrics_summary
		//
		// Replaces: <summaryDir>/{daily,weekly,monthly,yearly}/…/<MODE>-<BAND>-summary.json
		// One row per (mode, band, period, period_key) time-period summary.
		// The full MetricsSummary struct (including hourly/daily/monthly
		// breakdown arrays) is stored as a JSON blob in `data`; the scalar
		// columns exist only for range queries and retention pruning.
		// Source struct: MetricsSummary
		// ----------------------------------------------------------------
		{
			"decoder_metrics_summary",
			`CREATE TABLE IF NOT EXISTS decoder_metrics_summary (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				ts          INTEGER NOT NULL,           -- StartTime, Unix seconds UTC (named ts for retention pruning)
				mode        TEXT    NOT NULL,
				band        TEXT    NOT NULL,
				period      TEXT    NOT NULL,           -- "day" | "week" | "month" | "year"
				period_key  TEXT    NOT NULL,           -- e.g. "2025-01-14", "2025-W03", "2025-01", "2025"
				end_ts      INTEGER NOT NULL,           -- EndTime, Unix seconds UTC
				updated_ts  INTEGER NOT NULL,           -- LastUpdated, Unix seconds UTC
				data        TEXT    NOT NULL,           -- full MetricsSummary as JSON
				UNIQUE(mode, band, period, period_key)
			)`,
		},
		{"decoder_metrics_summary_idx_lookup", `CREATE INDEX IF NOT EXISTS decoder_metrics_summary_idx_lookup ON decoder_metrics_summary(period, ts, end_ts)`},

		// ----------------------------------------------------------------
		// cw_metrics_summary
		//
		// Replaces: <summaryDir>/{daily,weekly,monthly,yearly}/…/<BAND>-summary.json
		// One row per (band, period, period_key). CW summaries have no mode
		// dimension. Full CWMetricsSummary struct stored as JSON in `data`.
		// Source struct: CWMetricsSummary
		// ----------------------------------------------------------------
		{
			"cw_metrics_summary",
			`CREATE TABLE IF NOT EXISTS cw_metrics_summary (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				ts          INTEGER NOT NULL,           -- StartTime, Unix seconds UTC (named ts for retention pruning)
				band        TEXT    NOT NULL,
				period      TEXT    NOT NULL,           -- "day" | "week" | "month" | "year"
				period_key  TEXT    NOT NULL,
				end_ts      INTEGER NOT NULL,
				updated_ts  INTEGER NOT NULL,
				data        TEXT    NOT NULL,           -- full CWMetricsSummary as JSON
				UNIQUE(band, period, period_key)
			)`,
		},
		{"cw_metrics_summary_idx_lookup", `CREATE INDEX IF NOT EXISTS cw_metrics_summary_idx_lookup ON cw_metrics_summary(period, ts, end_ts)`},

		// ----------------------------------------------------------------
		// notification_log
		//
		// Records every notification dispatch attempt (one row per rule →
		// channel send), replacing the in-memory per-channel ring buffer
		// that used to live in NotificationManager.chanLogs (last 10
		// entries, lost on restart). Written from NotificationManager.Publish
		// (notification_manager.go) for "sent", "error", and "template_error"
		// outcomes, plus manual test sends from the admin API.
		// ----------------------------------------------------------------
		{
			"notification_log",
			`CREATE TABLE IF NOT EXISTS notification_log (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				ts           INTEGER NOT NULL,  -- Unix seconds UTC
				rule         TEXT,              -- rule name/key, or "(test)" for admin test sends
				event_type   TEXT,              -- e.g. "cw_spot", "system_monitor"
				channel_name TEXT,              -- configured channel name
				channel_type TEXT,              -- "telegram" | "email" | "webhook" | "galactic_unicorn" | "sse"
				status       TEXT    NOT NULL,  -- "sent" | "error" | "template_error"
				error_msg    TEXT,              -- non-empty on error/template_error
				resp_code    INTEGER,           -- HTTP status code (0 for SMTP or when unavailable)
				resp_body    TEXT,              -- response body/result snippet (≤512 bytes)
				message      TEXT               -- rendered notification text that was sent
			)`,
		},
		{"notification_log_idx_ts", `CREATE INDEX IF NOT EXISTS notification_log_idx_ts      ON notification_log(ts)`},
		{"notification_log_idx_channel", `CREATE INDEX IF NOT EXISTS notification_log_idx_channel ON notification_log(channel_name, ts)`},
		{"notification_log_idx_status", `CREATE INDEX IF NOT EXISTS notification_log_idx_status  ON notification_log(status, ts)`},
	}

	for _, s := range stmts {
		if _, err := m.db.Exec(s.ddl); err != nil {
			return fmt.Errorf("create %q: %w", s.name, err)
		}
	}

	return nil
}
