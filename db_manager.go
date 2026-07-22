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
//	psk_rank_*    — replaces stats/psk JSONL (PSKRankData)
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
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL", // safe with WAL; faster than FULL
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",       // ms — retry on locked DB instead of failing immediately
		"PRAGMA cache_size=-131072",      // 128 MiB page cache (negative value = KiB)
		"PRAGMA auto_vacuum=INCREMENTAL", // enables incremental_vacuum; must be set before first write
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
	readDB, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("db_manager: open read pool %q: %w", dbPath, err)
	}
	readDB.SetMaxOpenConns(4)
	readDB.SetMaxIdleConns(4)
	// busy_timeout is still useful on the read pool: readers can briefly block
	// during a WAL checkpoint. 5 s matches the write connection setting.
	if _, err := readDB.Exec("PRAGMA busy_timeout=5000"); err != nil {
		_ = db.Close()
		_ = readDB.Close()
		return nil, fmt.Errorf("db_manager: read pool busy_timeout: %w", err)
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

// RetentionConfig holds per-table retention periods in days.
// A value of 0 means "keep forever" (no automatic pruning for that table).
// Tables with no corresponding config field default to 0 (unlimited).
type RetentionConfig struct {
	// Sessions: config.Server.SessionActivityLogRetentionDays (default 30)
	SessionsDays int
	// Spots (decoder): decoder config spots_log_max_age_days (default 0 = unlimited)
	SpotsDays int
	// CWSpots: no config field yet — 0 = unlimited
	CWSpotsDays int
	// ChatMessages: no config field yet — 0 = unlimited
	ChatDays int
	// NoiseFloor: no config field yet — 0 = unlimited
	NoiseFloorDays int
	// SpaceWeather: no config field yet — 0 = unlimited
	SpaceWeatherDays int
	// Stats (WSPR/PSK/RBN leaderboards): the history endpoints refuse ranges
	// longer than statsMaxDays, so anything older is unreachable via the API.
	StatsDays int
}

// retentionInterval is how often the retention loop runs after the initial
// startup prune. 1 hour matches the CSV cleanup interval used by the spots
// logger and ensures pruning happens even on short-lived instances.
// Most hourly runs will find 0 rows to delete (cheap no-op).
const retentionInterval = 1 * time.Hour

// StartRetentionLoop starts a background goroutine that prunes old rows from
// all DB tables once at startup and then every retentionInterval (6 hours).
// It stops when ctx is cancelled (e.g. on graceful shutdown).
// Tables whose retention value is 0 are skipped (kept forever).
func (m *DBManager) StartRetentionLoop(ctx context.Context, cfg RetentionConfig) {
	go func() {
		// Run immediately at startup so rows aged out while the process was
		// down are removed without waiting for the first interval tick.
		m.pruneAll(cfg)

		ticker := time.NewTicker(retentionInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.pruneAll(cfg)
			}
		}
	}()
}

// pruneAll deletes rows older than the configured retention period from each table,
// then reclaims freed pages via PRAGMA incremental_vacuum.
// Deletes are batched (pruneChunkSize rows at a time) to keep WAL pressure low
// and avoid blocking readers for extended periods on large tables.
func (m *DBManager) pruneAll(cfg RetentionConfig) {
	type tableRule struct {
		table string
		days  int
	}
	rules := []tableRule{
		{"sessions", cfg.SessionsDays},
		{"spots", cfg.SpotsDays},
		{"cw_spots", cfg.CWSpotsDays},
		{"chat_messages", cfg.ChatDays},
		{"noise_floor", cfg.NoiseFloorDays},
		{"space_weather", cfg.SpaceWeatherDays},
		// Stats tables all carry ts, so each prunes independently.
		{"wspr_rank_rows", cfg.StatsDays},
		{"wspr_rank_windows", cfg.StatsDays},
		{"psk_rank_entries", cfg.StatsDays},
		{"psk_software", cfg.StatsDays},
		{"psk_rank_snapshots", cfg.StatsDays},
		{"rbn_skew", cfg.StatsDays},
		{"rbn_stats", cfg.StatsDays},
	}
	anyDeleted := false
	for _, r := range rules {
		if r.days <= 0 {
			continue // 0 = keep forever
		}
		cutoff := time.Now().UTC().AddDate(0, 0, -r.days).Unix()
		if m.pruneTable(r.table, cutoff, r.days) {
			anyDeleted = true
		}
	}

	// Reclaim freed pages from the freelist. Requires auto_vacuum=INCREMENTAL
	// (set at DB creation). This is a no-op when nothing was deleted.
	if anyDeleted {
		if _, err := m.db.Exec("PRAGMA incremental_vacuum"); err != nil {
			log.Printf("[DB] incremental_vacuum: %v", err)
		}
	}
}

// pruneChunkSize is the maximum number of rows deleted per batch.
// Keeping this small limits WAL growth and reader-blocking time.
const pruneChunkSize = 10_000

// pruneTable deletes rows with ts < cutoff from the named table in chunks,
// sleeping 100 ms between batches to yield to concurrent readers/writers.
// Returns true if any rows were deleted.
func (m *DBManager) pruneTable(table string, cutoff int64, days int) bool {
	total := int64(0)
	query := `DELETE FROM ` + table + ` WHERE id IN (
		SELECT id FROM ` + table + ` WHERE ts < ? LIMIT ?
	)`
	for {
		res, err := m.db.Exec(query, cutoff, pruneChunkSize)
		if err != nil {
			log.Printf("[DB] retention prune %s: %v", table, err)
			return total > 0
		}
		n, _ := res.RowsAffected()
		total += n
		if n < pruneChunkSize {
			break // last (or only) batch
		}
		// Yield between batches so readers aren't starved.
		time.Sleep(100 * time.Millisecond)
	}
	if total > 0 {
		log.Printf("[DB] retention prune %s: deleted %d rows older than %d days", table, total, days)
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

// initSchema creates all tables and indexes if they do not already exist.
// Column names and types mirror the existing Go structs and CSV column order
// so that future migration code can map fields 1-to-1.
func (m *DBManager) initSchema() error {
	stmts := []struct {
		name string
		ddl  string
	}{
		// ----------------------------------------------------------------
		// sessions
		//
		// Replaces: <dataDir>/YYYY/MM/DD/sessions.jsonl
		// Source structs: SessionActivityLog / SessionActivityEntry
		//
		// The JSONL format stores a snapshot envelope (SessionActivityLog)
		// containing a list of active sessions ([]SessionActivityEntry).
		// Here each SessionActivityEntry becomes one row; the snapshot
		// envelope fields (timestamp, event_type) are denormalised onto
		// every row so queries don't need a join.
		// ----------------------------------------------------------------
		{
			"sessions",
			`CREATE TABLE IF NOT EXISTS sessions (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				-- envelope fields (from SessionActivityLog)
				snapshot_ts     INTEGER NOT NULL,   -- Unix seconds UTC (SessionActivityLog.Timestamp)
				event_type      TEXT    NOT NULL,   -- "snapshot" | "session_created" | "session_destroyed"
				-- per-session fields (from SessionActivityEntry)
				user_session_id TEXT    NOT NULL,
				client_ip       TEXT,
				source_ip       TEXT,
				auth_method     TEXT,               -- "" | "password" | "ip_bypass"
				session_types   TEXT,               -- JSON array e.g. ["audio","spectrum"]
				bands           TEXT,               -- JSON array e.g. ["20m","40m"]
				modes           TEXT,               -- JSON array e.g. ["usb","ft8"]
				created_at      INTEGER,            -- Unix seconds UTC
				first_seen      INTEGER,            -- Unix seconds UTC
				user_agent      TEXT,
				country         TEXT,
				country_code    TEXT                -- ISO 3166-1 alpha-2
			)`,
		},
		{"sessions_idx_snapshot_ts", `CREATE INDEX IF NOT EXISTS sessions_idx_snapshot_ts ON sessions(snapshot_ts)`},
		{"sessions_idx_source_ip", `CREATE INDEX IF NOT EXISTS sessions_idx_source_ip   ON sessions(source_ip)`},
		{"sessions_idx_session_id", `CREATE INDEX IF NOT EXISTS sessions_idx_session_id  ON sessions(user_session_id)`},

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
				country_code TEXT               -- ISO 3166-1 alpha-2
			)`,
		},
		{"chat_idx_ts", `CREATE INDEX IF NOT EXISTS chat_idx_ts       ON chat_messages(ts)`},
		{"chat_idx_ip", `CREATE INDEX IF NOT EXISTS chat_idx_ip       ON chat_messages(source_ip)`},
		{"chat_idx_username", `CREATE INDEX IF NOT EXISTS chat_idx_username ON chat_messages(username)`},

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
		{"spots_idx_ts", `CREATE INDEX IF NOT EXISTS spots_idx_ts          ON spots(ts)`},
		{"spots_idx_mode_band", `CREATE INDEX IF NOT EXISTS spots_idx_mode_band   ON spots(mode, band)`},
		{"spots_idx_callsign", `CREATE INDEX IF NOT EXISTS spots_idx_callsign    ON spots(callsign)`},
		{"spots_idx_ts_mode", `CREATE INDEX IF NOT EXISTS spots_idx_ts_mode     ON spots(ts, mode)`},

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
		{"cw_spots_idx_ts", `CREATE INDEX IF NOT EXISTS cw_spots_idx_ts       ON cw_spots(ts)`},
		{"cw_spots_idx_band", `CREATE INDEX IF NOT EXISTS cw_spots_idx_band     ON cw_spots(band)`},
		{"cw_spots_idx_dx_call", `CREATE INDEX IF NOT EXISTS cw_spots_idx_dx_call  ON cw_spots(dx_call)`},
		{"cw_spots_idx_ts_band", `CREATE INDEX IF NOT EXISTS cw_spots_idx_ts_band  ON cw_spots(ts, band)`},

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
		// psk_rank_snapshots / psk_rank_entries / psk_software
		//
		// Replaces: <statsDir>/psk/YYYY/MM/DD/report_result.jsonl
		// Source struct: PSKRankData (psk_rank.go)
		//
		// PSKRankData holds two band→[]PSKMonitorEntry maps (reportResult and
		// countryResult) plus a callsign→software map, all from one hourly
		// scrape of pskreporter.info. The two maps are flattened into
		// psk_rank_entries with result_type distinguishing them; the software
		// map becomes psk_software.
		//
		// As with WSPR, the snapshot envelope is its own table so a failed
		// fetch (zero entries, non-empty error) still round-trips.
		// ts is PSKRankData.FetchedAt on all three tables.
		//
		// Indexes: none beyond the UNIQUE constraints, for the same reasons as
		// the WSPR tables. UNIQUE(ts, result_type, band, rank_pos) satisfies
		// loadPSKSnapshots' `ORDER BY ts, result_type, band, rank_pos` without
		// a sort, and UNIQUE(ts, callsign, name, version) covers psk_software's
		// `ORDER BY ts, callsign, name`. The callsign filter is applied in Go
		// (stats_psk_history.go), so a callsign index is never consulted.
		// ----------------------------------------------------------------
		{
			"psk_rank_snapshots",
			`CREATE TABLE IF NOT EXISTS psk_rank_snapshots (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				ts         INTEGER NOT NULL UNIQUE,  -- Unix seconds UTC (PSKRankData.FetchedAt)
				fetched_ms INTEGER,                  -- scrape duration in milliseconds
				error      TEXT                      -- non-empty when the scrape failed
			)`,
		},
		{
			"psk_rank_entries",
			`CREATE TABLE IF NOT EXISTS psk_rank_entries (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				ts          INTEGER NOT NULL,  -- Unix seconds UTC — matches psk_rank_snapshots.ts
				result_type TEXT    NOT NULL,  -- "report" (reportResult) | "country" (countryResult)
				band        TEXT    NOT NULL,  -- e.g. "20m", "All"
				rank_pos    INTEGER NOT NULL,  -- 0-based position within the band array; preserves order
				callsign    TEXT    NOT NULL,
				day_count   INTEGER,           -- last 24 h count (PSKMonitorEntry.Day)
				week_count  INTEGER,           -- last 7 days count (PSKMonitorEntry.Week)
				UNIQUE(ts, result_type, band, rank_pos)
			)`,
		},
		{
			"psk_software",
			`CREATE TABLE IF NOT EXISTS psk_software (
				id       INTEGER PRIMARY KEY AUTOINCREMENT,
				ts       INTEGER NOT NULL,  -- Unix seconds UTC — matches psk_rank_snapshots.ts
				callsign TEXT    NOT NULL,  -- UPPER-cased, as stored in PSKRankData.SoftwareInUse
				name     TEXT    NOT NULL,  -- canonical software name, e.g. "UberSDR"
				version  TEXT,              -- version suffix; empty when the detail row had none
				UNIQUE(ts, callsign, name, version)
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
	}

	for _, s := range stmts {
		if _, err := m.db.Exec(s.ddl); err != nil {
			return fmt.Errorf("create %q: %w", s.name, err)
		}
	}

	return nil
}
