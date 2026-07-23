package main

// db_import.go — one-time historical backfill from CSV/JSONL files into SQLite.
//
// DBImporter.RunImportIfEmpty() is called at startup (before the main HTTP
// server starts accepting requests). For each table it checks COUNT(*); if the
// table is empty it walks the corresponding file tree and INSERTs all rows.
//
// Design goals:
//   - Idempotent: INSERT OR IGNORE means re-running is safe.
//   - Non-blocking: each table import runs sequentially in a single background
//     goroutine so startup is never delayed.
//   - Transparent: errors are logged but never fatal; the file-based read path
//     continues to work regardless.
//   - Batched: rows are committed in transactions of importBatchSize to keep
//     WAL pressure low and avoid blocking concurrent readers.
//
// File → DB column mapping mirrors the existing write paths exactly:
//
//	chat_messages  ← <chatDir>/YYYY/MM/DD/chat.csv
//	noise_floor    ← <noiseFloorDir>/YYYY/MM/DD/<band>.csv
//	spots          ← <spotsDir>/<MODE>/YYYY/MM/DD/<name>.csv
//	cw_spots       ← <cwSpotsDir>/YYYY/MM/DD/<band>.csv
//	sessions       ← <sessionsDir>/YYYY/MM/DD/sessions.jsonl
//	space_weather  ← <spaceWeatherDir>/YYYY/MM/spaceweather-YYYY-MM-DD.csv
//	decoder_metrics← <decoderMetricsDir>/YYYY/MM/DD/<MODE>-<BAND>.jsonl
//	cw_metrics     ← <cwMetricsDir>/YYYY/MM/DD/<BAND>.jsonl
//	wspr_rank_*    ← <statsDir>/wspr/YYYY/MM/DD/rolling_24h.jsonl
//	psk_rank_*     ← <statsDir>/psk/YYYY/MM/DD/report_result.jsonl
//	rbn_skew/_stats← <statsDir>/rbn/YYYY/MM/DD/{skew,statistics}.jsonl

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const importBatchSize = 100000

// importSpotsDays limits how far back the spots and cw_spots backfill reaches.
// Rows older than this many days are skipped — they would be pruned by the
// retention loop anyway and importing them wastes time and disk space.
const importSpotsDays = 30

// importStatsDays limits how far back the WSPR/PSK/RBN stats backfill reaches.
//
// Unlike the spots directories, the stats tree was never pruned on disk — the
// old file-based StatsLogger had no cleanup loop — so it holds every snapshot
// since the instance was installed. Importing all of it is by far the most
// expensive part of the backfill: a single hourly WSPR snapshot expands to a
// full leaderboard per window (~150k rows/day).
//
// 30 matches statsMaxDays, the largest range the /api/stats/* history
// endpoints will serve, so anything older cannot be read back anyway. It also
// matches the default database.stats_retention_days, meaning older rows would
// be deleted by the first prune pass regardless.
const importStatsDays = 30

// DBImporter holds the database handle and per-subsystem data directories.
// All directory fields are optional: an empty string means that subsystem is
// not configured and its import is skipped.
type DBImporter struct {
	db *sql.DB

	ChatDir           string // chat_messages: <chatDir>/YYYY/MM/DD/chat.csv
	NoiseFloorDir     string // noise_floor:   <dir>/YYYY/MM/DD/<band>.csv
	SpotsDir          string // spots:         <dir>/<MODE>/YYYY/MM/DD/<name>.csv
	CWSpotsDir        string // cw_spots:      <dir>/YYYY/MM/DD/<band>.csv
	SessionsDir       string // sessions:      <dir>/YYYY/MM/DD/sessions.jsonl
	SpaceWeatherDir   string // space_weather: <dir>/YYYY/MM/spaceweather-YYYY-MM-DD.csv
	DecoderMetricsDir string // decoder_metrics: <dir>/YYYY/MM/DD/<MODE>-<BAND>.jsonl
	CWMetricsDir      string // cw_metrics:    <dir>/YYYY/MM/DD/<BAND>.jsonl
	StatsDir          string // wspr/psk/rbn stats root: <dir>/{wspr,psk,rbn}/YYYY/MM/DD/*.jsonl
	// Metrics summary roots: <dir>/{daily,weekly,monthly,yearly}/…/*-summary.json
	DecoderSummaryDir string // decoder_metrics_summary: <MODE>-<BAND>-summary.json
	CWSummaryDir      string // cw_metrics_summary:      <BAND>-summary.json

	// migrationDone is closed once the backfill has removed at least one source
	// directory, signalling that the process should restart onto the DB-only
	// paths. Created lazily so the zero value of DBImporter stays usable and so
	// the accessor and the closer agree on one channel whatever the call order.
	migrationOnce sync.Once
	migrationDone chan struct{}
	restartOnce   sync.Once

	// SummaryHooks maps a summary table to the live aggregator that owns it.
	// The two summary aggregators start up before this importer runs, read an
	// empty table, and would then upsert their history-less in-memory summaries
	// over the rows backfilled here — silently dropping every pre-migration
	// month from the yearly/monthly breakdowns. The hook freezes those writes
	// for the duration of the backfill and merges the result in afterwards.
	SummaryHooks map[string]SummaryImportHook
}

// SummaryImportHook is implemented by the metrics summary aggregators so the
// importer can suspend their persistence while backfilling the table they own.
type SummaryImportHook interface {
	HoldWritesForImport()
	MergeImportedSummaries()
	ReleaseImportHold()
}

// tableImport binds a table to the directory it is backfilled from and the
// function that does the work.
type tableImport struct {
	table    string
	dir      string
	importFn func(context.Context) error
}

// dbImportOrder returns the backfill sequence. Small/fast tables come first so
// they are available quickly; cw_spots and spots are deliberately LAST because
// they are by far the largest tables and everything queued behind them would
// otherwise wait hours.
func dbImportOrder(imp *DBImporter) []tableImport {
	return []tableImport{
		{"chat_messages", imp.ChatDir, imp.importChat},
		{"noise_floor", imp.NoiseFloorDir, imp.importNoiseFloor},
		{"sessions", imp.SessionsDir, imp.importSessions},
		{"space_weather", imp.SpaceWeatherDir, imp.importSpaceWeather},
		{"decoder_metrics", imp.DecoderMetricsDir, imp.importDecoderMetrics},
		{"cw_metrics", imp.CWMetricsDir, imp.importCWMetrics},
		// Stats share one root directory; each importer walks its own subtree.
		// importRBN fills both rbn_skew and rbn_stats, so only rbn_skew is
		// checked — they are always written together.
		// These sit ahead of the spots imports: the stats tables are the sole
		// source for /api/stats/* now that the JSONL writers are gone, so the
		// history page stays blank until they land.
		{"rbn_skew", imp.StatsDir, imp.importRBN},
		{"psk_rank_snapshots", imp.StatsDir, imp.importPSKRank},
		{"wspr_rank_windows", imp.StatsDir, imp.importWSPRRank},
		{"decoder_metrics_summary", imp.DecoderSummaryDir, imp.importDecoderSummary},
		{"cw_metrics_summary", imp.CWSummaryDir, imp.importCWSummary},
		{"cw_spots", imp.CWSpotsDir, imp.importCWSpots},
		{"spots", imp.SpotsDir, imp.importSpots},
	}
}

// RunImportIfEmpty checks each table synchronously (before live writers start),
// then backfills only the empty ones in a background goroutine.
//
// The empty check MUST happen synchronously so that live writes arriving after
// startup cannot cause a table to appear non-empty before the decision is made.
func (imp *DBImporter) RunImportIfEmpty(ctx context.Context) {
	all := dbImportOrder(imp)

	// Determine which tables need importing NOW, before any live writers start.
	var toImport []tableImport
	for _, t := range all {
		if t.dir == "" {
			continue // subsystem not configured
		}
		if _, err := os.Stat(t.dir); os.IsNotExist(err) {
			continue // data directory doesn't exist yet
		}
		empty, err := imp.tableIsEmpty(t.table)
		if err != nil {
			log.Printf("[DB import] checking %s: %v (skipping)", t.table, err)
			continue
		}
		if !empty {
			log.Printf("[DB import] %s already has data — skipping backfill", t.table)
			continue
		}
		log.Printf("[DB import] %s is empty — queued for backfill from %s", t.table, t.dir)
		// Freeze the owning aggregator's writes here, in the synchronous phase,
		// so no flush can land between this decision and the backfill.
		if hook := imp.SummaryHooks[t.table]; hook != nil {
			hook.HoldWritesForImport()
		}
		toImport = append(toImport, t)
	}

	if len(toImport) == 0 {
		return // nothing to do
	}

	// Run the actual file-reading and inserting in the background so startup
	// is not blocked. The decision of WHICH tables to import was already made
	// above, so live writes arriving now cannot affect it.
	go func() {
		// Track, per source directory, whether every import that reads from it
		// succeeded. A directory is only deleted once ALL of its imports
		// finished without error and the context was never cancelled — a
		// directory shared by several importers (e.g. StatsDir feeds rbn/psk/
		// wspr) must not be removed until the last of them is done. This is why
		// deletion is deferred to the very end rather than done per-table.
		dirOK := make(map[string]bool)   // dir → all imports so far succeeded
		dirSeen := make(map[string]bool) // dir → appeared in toImport
		aborted := false

		// Any aggregator still frozen when this goroutine exits — because its
		// import was skipped by an abort, or panicked — must be thawed, or it
		// would never persist again.
		defer func() {
			for _, hook := range imp.SummaryHooks {
				hook.ReleaseImportHold()
			}
		}()

		for _, t := range toImport {
			if ctx.Err() != nil {
				aborted = true
				break
			}
			if !dirSeen[t.dir] {
				dirSeen[t.dir] = true
				dirOK[t.dir] = true // optimistic; cleared on any failure below
			}
			log.Printf("[DB import] %s: starting backfill", t.table)
			start := time.Now()
			err := t.importFn(ctx)
			if err != nil {
				log.Printf("[DB import] %s backfill error: %v", t.table, err)
				dirOK[t.dir] = false // keep the source dir for a future retry
			} else {
				log.Printf("[DB import] %s backfill complete in %v", t.table, time.Since(start).Round(time.Millisecond))
			}
			// Hand the backfilled rows to the live aggregator (or thaw it on
			// failure) as soon as this table is done, rather than waiting for
			// the slow spots imports queued behind it.
			if hook := imp.SummaryHooks[t.table]; hook != nil {
				if err != nil {
					hook.ReleaseImportHold()
				} else {
					hook.MergeImportedSummaries()
				}
			}
		}

		// Deferred, all-at-once cleanup: only after every queued import has run
		// (and none were aborted) do we remove the source directories whose
		// imports all succeeded. Historical file trees are then fully replaced
		// by the SQLite database.
		if aborted || ctx.Err() != nil {
			log.Printf("[DB import] backfill interrupted — leaving source directories in place")
			return
		}
		if removed := imp.cleanupImportedDirs(dirOK); removed > 0 {
			// The migrated trees are gone; whoever is listening restarts the
			// process so it comes back up reading only from SQLite.
			log.Printf("[DB import] %d source director(ies) removed — requesting restart", removed)
			imp.restartOnce.Do(func() { close(imp.restartChan()) })
		}
	}()
}

// RestartRequested returns a channel that is closed once the backfill has
// finished AND removed at least one migrated source directory. It never fires
// when the import was aborted, when every directory was kept because an import
// failed, or when the directories were already gone.
//
// Closing happens whether or not anyone is listening yet, so a caller wired up
// later in startup (the admin handler is built long after the importer starts)
// still observes it.
func (imp *DBImporter) RestartRequested() <-chan struct{} {
	return imp.restartChan()
}

// restartChan lazily creates the migration-complete channel.
func (imp *DBImporter) restartChan() chan struct{} {
	imp.migrationOnce.Do(func() { imp.migrationDone = make(chan struct{}) })
	return imp.migrationDone
}

// cleanupImportedDirs removes each source data directory whose imports all
// completed successfully. Called once, after every queued import has run.
//
// A directory is skipped (kept on disk) if any import reading from it failed,
// so a subsequent startup can retry the backfill from the intact files.
// Directories shared by multiple importers (StatsDir) are removed only when
// every importer that read from them succeeded.
//
// Returns the number of directories actually removed from disk — the caller
// uses it to decide whether a restart is warranted.
func (imp *DBImporter) cleanupImportedDirs(dirOK map[string]bool) int {
	removed := 0
	// Deduplicate: StatsDir appears three times in the import list.
	seen := make(map[string]bool)
	for dir, ok := range dirOK {
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		if !ok {
			log.Printf("[DB import] keeping %s — one or more imports from it did not succeed", dir)
			continue
		}
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			continue // already gone
		}
		log.Printf("[DB import] removing migrated source directory %s", dir)
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("[DB import] WARNING: failed to remove %s: %v", dir, err)
			continue
		}
		removed++
	}
	return removed
}

// tableIsEmpty returns true when COUNT(*) == 0 for the named table.
func (imp *DBImporter) tableIsEmpty(table string) (bool, error) {
	var n int
	// Table name is not user-supplied; safe to interpolate.
	err := imp.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n)
	return n == 0, err
}

// dayDirBefore reports whether path is a YYYY/MM/DD day directory under root
// whose date precedes cutoff.
//
// All the dated import trees nest exactly three levels below their root, so a
// walk can call this on every directory and return filepath.SkipDir to discard
// a whole day without opening any files. Paths that are not three levels deep,
// or whose components do not parse as a date, return false so the walk
// continues — an unrecognised layout must never silently skip data.
func dayDirBefore(root, path string, cutoff time.Time) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 3 {
		return false
	}
	day, err := time.Parse("2006-01-02", parts[0]+"-"+parts[1]+"-"+parts[2])
	if err != nil {
		return false
	}
	return day.Before(cutoff)
}

// importCutoff returns the earliest day that will be imported: midnight UTC,
// days before today.
func importCutoff(days int) time.Time {
	return time.Now().UTC().AddDate(0, 0, -days).Truncate(24 * time.Hour)
}

// beginBatch starts a transaction for a batch of INSERTs.
func (imp *DBImporter) beginBatch(ctx context.Context) (*sql.Tx, error) {
	return imp.db.BeginTx(ctx, nil)
}

// commitAndMaybeBegin commits tx and starts a new one when count reaches the
// batch size. Logs progress every batch. Returns the (possibly new) transaction
// and updated count.
func (imp *DBImporter) commitAndMaybeBegin(ctx context.Context, tx *sql.Tx, count, total *int, table string) (*sql.Tx, error) {
	*count++
	*total++
	if *count < importBatchSize {
		return tx, nil
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	log.Printf("[DB import] %s: %d rows imported so far…", table, *total)
	*count = 0
	return imp.beginBatch(ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
// chat_messages  ← <ChatDir>/YYYY/MM/DD/chat.csv
//
// CSV header: timestamp, source_ip, username, message, country, country_code
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importChat(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO chat_messages
		(ts, source_ip, username, message, country, country_code)
		VALUES (?, ?, ?, ?, ?, ?)`

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = walkCSVFiles(imp.ChatDir, "chat.csv", func(path string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return readCSV(path, func(rec []string) error {
			if len(rec) < 6 {
				return nil
			}
			ts, err := parseTimestamp(rec[0])
			if err != nil {
				return nil // skip malformed rows
			}
			_, err = tx.ExecContext(ctx, stmt, ts, rec[1], rec[2], rec[3], rec[4], rec[5])
			if err != nil {
				return err
			}
			tx, err = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "chat_messages")
			return err
		})
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] chat_messages: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// noise_floor  ← <NoiseFloorDir>/YYYY/MM/DD/<band>.csv
//
// CSV header: timestamp, min_db, max_db, mean_db, median_db, p5_db, p10_db,
//             p95_db, dynamic_range, occupancy_pct, ft8_snr,
//             snr_0_30_mhz, snr_1_8_30_mhz
// Band comes from the filename stem (e.g. "20m.csv" → "20m").
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importNoiseFloor(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO noise_floor
		(ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
		 dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(imp.NoiseFloorDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if d.IsDir() || ctx.Err() != nil {
			return nil
		}
		if !strings.HasSuffix(path, ".csv") {
			return nil
		}
		band := strings.TrimSuffix(filepath.Base(path), ".csv")
		if band == "" {
			return nil
		}

		if ferr := readCSV(path, func(rec []string) error {
			if len(rec) < 13 {
				return nil
			}
			ts, err := parseTimestamp(rec[0])
			if err != nil {
				return nil
			}
			vals := parseFloats(rec[1:13]) // 12 float columns
			_, err = tx.ExecContext(ctx, stmt,
				ts, band,
				vals[0], vals[1], vals[2], vals[3], vals[4], vals[5],
				vals[6], vals[7], vals[8], vals[9], vals[10], vals[11],
			)
			if err != nil {
				return err
			}
			tx, err = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "noise_floor")
			return err
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] noise_floor: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// spots  ← <SpotsDir>/<MODE>/YYYY/MM/DD/<name>.csv
//
// CSV header: timestamp, callsign, locator, snr, frequency, band, message,
//             country, cq_zone, itu_zone, continent, distance_km, bearing_deg, dbm
// mode comes from the first path component under SpotsDir.
// decoder_name comes from the filename stem.
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importSpots(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO spots
		(ts, mode, decoder_name, callsign, locator, snr, frequency, band,
		 message, country, cq_zone, itu_zone, continent,
		 distance_km, bearing_deg, dbm)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	// Compute the earliest date we will import. The directory structure is
	// <SpotsDir>/<MODE>/YYYY/MM/DD/ so we can skip entire day directories
	// without opening any files.
	cutoffDate := importCutoff(importSpotsDays)

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	// Top-level entries under SpotsDir are MODE directories (FT8, WSPR, …)
	modeDirs, err := os.ReadDir(imp.SpotsDir)
	if err != nil {
		return err
	}

	for _, modeEntry := range modeDirs {
		if !modeEntry.IsDir() || ctx.Err() != nil {
			continue
		}
		mode := modeEntry.Name()
		modeDir := filepath.Join(imp.SpotsDir, mode)

		_ = filepath.WalkDir(modeDir, func(path string, d os.DirEntry, werr error) error {
			if werr != nil {
				log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
				return nil
			}
			if ctx.Err() != nil {
				return nil
			}
			if d.IsDir() {
				// The day directory is 3 levels below modeDir: YYYY/MM/DD.
				if dayDirBefore(modeDir, path, cutoffDate) {
					return filepath.SkipDir // skip entire day subtree
				}
				return nil
			}
			if !strings.HasSuffix(path, ".csv") {
				return nil
			}
			decoderName := strings.TrimSuffix(filepath.Base(path), ".csv")

			if ferr := readCSV(path, func(rec []string) error {
				if len(rec) < 14 {
					return nil
				}
				ts, err := parseTimestamp(rec[0])
				if err != nil {
					return nil
				}
				snr := parseInt(rec[3])
				freq := parseInt(rec[4])
				cqZone := parseInt(rec[8])
				ituZone := parseInt(rec[9])
				distKm := nullableFloat(rec[11])
				bearDeg := nullableFloat(rec[12])
				dbm := nullableInt(rec[13])

				_, err = tx.ExecContext(ctx, stmt,
					ts, mode, decoderName,
					rec[1], rec[2], snr, freq, rec[5],
					rec[6], rec[7], cqZone, ituZone, rec[10],
					distKm, bearDeg, dbm,
				)
				if err != nil {
					return err
				}
				tx, err = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "spots")
				return err
			}); ferr != nil {
				log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
			}
			return nil
		})
	}

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] spots: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// cw_spots  ← <CWSpotsDir>/YYYY/MM/DD/<band>.csv
//
// CSV header: timestamp, callsign, snr, frequency, band, wpm, comment,
//             country, cq_zone, itu_zone, continent, distance_km, bearing_deg
// dx_call = col[1] ("callsign" in file).
// spotter, country_code, lat, lon, QRZ fields → NULL (not in CSV).
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importCWSpots(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO cw_spots
		(ts, dx_call, snr, frequency, band, wpm, comment,
		 country, cq_zone, itu_zone, continent, distance_km, bearing_deg)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	// CW spots directory structure: <CWSpotsDir>/YYYY/MM/DD/<band>.csv
	// Skip entire day directories that predate the cutoff.
	cutoffDate := importCutoff(importSpotsDays)

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(imp.CWSpotsDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if ctx.Err() != nil {
			return nil
		}
		if d.IsDir() {
			// Day directories are 3 levels below CWSpotsDir: YYYY/MM/DD.
			if dayDirBefore(imp.CWSpotsDir, path, cutoffDate) {
				return filepath.SkipDir // skip entire day subtree
			}
			return nil
		}
		if !strings.HasSuffix(path, ".csv") {
			return nil
		}

		if ferr := readCSV(path, func(rec []string) error {
			if len(rec) < 13 {
				return nil
			}
			ts, err := parseTimestamp(rec[0])
			if err != nil {
				return nil
			}
			snr := parseInt(rec[2])
			freq := parseFloat(rec[3])
			wpm := parseInt(rec[5])
			cqZone := parseInt(rec[8])
			ituZone := parseInt(rec[9])
			distKm := nullableFloat(rec[11])
			bearDeg := nullableFloat(rec[12])

			_, err = tx.ExecContext(ctx, stmt,
				ts, rec[1], snr, freq, rec[4], wpm, rec[6],
				rec[7], cqZone, ituZone, rec[10],
				distKm, bearDeg,
			)
			if err != nil {
				return err
			}
			tx, err = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "cw_spots")
			return err
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] cw_spots: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// sessions  ← <SessionsDir>/YYYY/MM/DD/sessions.jsonl
//
// Each line is a JSON SessionActivityLog. Denormalised: one DB row per
// SessionActivityEntry per snapshot.
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importSessions(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO sessions
		(snapshot_ts, event_type, user_session_id, client_ip, source_ip,
		 auth_method, session_types, bands, modes,
		 created_at, first_seen, user_agent, country, country_code)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = walkJSONLFiles(imp.SessionsDir, "sessions.jsonl", func(path string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return readJSONL(path, func(line []byte) error {
			var logEntry SessionActivityLog
			if err := json.Unmarshal(line, &logEntry); err != nil {
				return nil // skip malformed lines
			}
			snapshotTS := logEntry.Timestamp.Unix()

			for _, entry := range logEntry.ActiveSessions {
				sessionTypesJSON, _ := json.Marshal(entry.SessionTypes)
				bandsJSON, _ := json.Marshal(entry.Bands)
				modesJSON, _ := json.Marshal(entry.Modes)

				var createdAt, firstSeen int64
				if !entry.CreatedAt.IsZero() {
					createdAt = entry.CreatedAt.Unix()
				}
				if !entry.FirstSeen.IsZero() {
					firstSeen = entry.FirstSeen.Unix()
				}

				_, err := tx.ExecContext(ctx, stmt,
					snapshotTS, logEntry.EventType,
					entry.UserSessionID, entry.ClientIP, entry.SourceIP,
					entry.AuthMethod,
					string(sessionTypesJSON), string(bandsJSON), string(modesJSON),
					createdAt, firstSeen,
					entry.UserAgent, entry.Country, entry.CountryCode,
				)
				if err != nil {
					return err
				}
				var txErr error
				tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "sessions")
				if txErr != nil {
					return txErr
				}
			}
			return nil
		})
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] sessions: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// space_weather  ← <SpaceWeatherDir>/YYYY/MM/spaceweather-YYYY-MM-DD.csv
//
// CSV header (37 cols):
//   timestamp, solar_flux, k_index, k_index_status, a_index, solar_wind_bz,
//   propagation_quality,
//   g_scale, g_text, r_scale, r_text, r_minor_prob, r_major_prob,
//   s_scale, s_text, s_prob, forecast_summary,
//   band_160m_day … band_10m_day (10 cols),
//   band_160m_night … band_10m_night (10 cols)
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importSpaceWeather(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO space_weather
		(ts, solar_flux, k_index, k_index_status, a_index, solar_wind_bz,
		 propagation_quality,
		 forecast_g_scale, forecast_g_text,
		 forecast_r_scale, forecast_r_text, forecast_r_minor_prob, forecast_r_major_prob,
		 forecast_s_scale, forecast_s_text, forecast_s_prob, forecast_summary,
		 day_160m, day_80m, day_60m, day_40m, day_30m,
		 day_20m, day_17m, day_15m, day_12m, day_10m,
		 night_160m, night_80m, night_60m, night_40m, night_30m,
		 night_20m, night_17m, night_15m, night_12m, night_10m)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(imp.SpaceWeatherDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if d.IsDir() || ctx.Err() != nil {
			return nil
		}
		if !strings.HasPrefix(filepath.Base(path), "spaceweather-") || !strings.HasSuffix(path, ".csv") {
			return nil
		}

		if ferr := readCSV(path, func(rec []string) error {
			if len(rec) < 37 {
				return nil
			}
			ts, err := parseTimestamp(rec[0])
			if err != nil {
				return nil
			}
			solarFlux := parseFloat(rec[1])
			kIndex := parseInt(rec[2])
			aIndex := parseInt(rec[4])
			solarWindBz := parseFloat(rec[5])

			// Nullable string columns — empty string → nil
			ns := func(s string) interface{} {
				if s == "" {
					return nil
				}
				return s
			}

			_, err = tx.ExecContext(ctx, stmt,
				ts, solarFlux, kIndex, ns(rec[3]), aIndex, solarWindBz, ns(rec[6]),
				ns(rec[7]), ns(rec[8]), ns(rec[9]), ns(rec[10]), ns(rec[11]), ns(rec[12]),
				ns(rec[13]), ns(rec[14]), ns(rec[15]), ns(rec[16]),
				// day bands: cols 17–26
				ns(rec[17]), ns(rec[18]), ns(rec[19]), ns(rec[20]), ns(rec[21]),
				ns(rec[22]), ns(rec[23]), ns(rec[24]), ns(rec[25]), ns(rec[26]),
				// night bands: cols 27–36
				ns(rec[27]), ns(rec[28]), ns(rec[29]), ns(rec[30]), ns(rec[31]),
				ns(rec[32]), ns(rec[33]), ns(rec[34]), ns(rec[35]), ns(rec[36]),
			)
			if err != nil {
				return err
			}
			tx, err = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "space_weather")
			return err
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] space_weather: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// decoder_metrics  ← <DecoderMetricsDir>/YYYY/MM/DD/<MODE>-<BAND>.jsonl
//
// Each line is a JSON MetricsSnapshot.
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importDecoderMetrics(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO decoder_metrics (
		ts, mode, band, band_name,
		decodes_1h, decodes_3h, decodes_6h, decodes_12h, decodes_24h,
		dpc_1m, dpc_5m, dpc_15m, dpc_30m, dpc_60m,
		unique_calls_1h, unique_calls_3h, unique_calls_6h, unique_calls_12h, unique_calls_24h,
		exec_avg_1m, exec_min_1m, exec_max_1m,
		exec_avg_5m, exec_min_5m, exec_max_5m,
		decodes_per_hour, callsigns_per_hour, activity_score
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(imp.DecoderMetricsDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if d.IsDir() || ctx.Err() != nil {
			return nil
		}
		if !strings.HasSuffix(path, ".jsonl") {
			return nil
		}

		if ferr := readJSONL(path, func(line []byte) error {
			var s MetricsSnapshot
			if err := json.Unmarshal(line, &s); err != nil {
				return nil
			}
			_, err := tx.ExecContext(ctx, stmt,
				s.Timestamp.Unix(), s.Mode, s.Band, s.BandName,
				s.DecodeCounts.Last1Hour, s.DecodeCounts.Last3Hours,
				s.DecodeCounts.Last6Hours, s.DecodeCounts.Last12Hours, s.DecodeCounts.Last24Hours,
				s.DecodesPerCycle.Last1Min, s.DecodesPerCycle.Last5Min,
				s.DecodesPerCycle.Last15Min, s.DecodesPerCycle.Last30Min, s.DecodesPerCycle.Last60Min,
				s.UniqueCallsigns.Last1Hour, s.UniqueCallsigns.Last3Hours,
				s.UniqueCallsigns.Last6Hours, s.UniqueCallsigns.Last12Hours, s.UniqueCallsigns.Last24Hours,
				s.ExecutionTime.Last1Min.Avg, s.ExecutionTime.Last1Min.Min, s.ExecutionTime.Last1Min.Max,
				s.ExecutionTime.Last5Min.Avg, s.ExecutionTime.Last5Min.Min, s.ExecutionTime.Last5Min.Max,
				s.Activity.DecodesPerHour, s.Activity.CallsignsPerHour, s.Activity.ActivityScore,
			)
			if err != nil {
				return err
			}
			var txErr error
			tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "decoder_metrics")
			return txErr
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] decoder_metrics: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// cw_metrics  ← <CWMetricsDir>/YYYY/MM/DD/<BAND>.jsonl
//
// Each line is a JSON CWMetricsSnapshot.
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importCWMetrics(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO cw_metrics (
		ts, band,
		spots_1h, spots_24h,
		unique_calls_1h, unique_calls_24h,
		spots_per_hour, callsigns_per_hour, activity_score,
		wpm_avg_1m, wpm_min_1m, wpm_max_1m,
		wpm_avg_5m, wpm_min_5m, wpm_max_5m,
		wpm_avg_10m, wpm_min_10m, wpm_max_10m
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(imp.CWMetricsDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if d.IsDir() || ctx.Err() != nil {
			return nil
		}
		if !strings.HasSuffix(path, ".jsonl") {
			return nil
		}

		if ferr := readJSONL(path, func(line []byte) error {
			var s CWMetricsSnapshot
			if err := json.Unmarshal(line, &s); err != nil {
				return nil
			}
			_, err := tx.ExecContext(ctx, stmt,
				s.Timestamp.Unix(), s.Band,
				s.SpotCounts.Last1Hour, s.SpotCounts.Last24Hour,
				s.UniqueCallsigns.Last1Hour, s.UniqueCallsigns.Last24Hour,
				s.Activity.SpotsPerHour, s.Activity.CallsignsPerHour, s.Activity.ActivityScore,
				s.WPMStats.Last1Min.AvgWPM, s.WPMStats.Last1Min.MinWPM, s.WPMStats.Last1Min.MaxWPM,
				s.WPMStats.Last5Min.AvgWPM, s.WPMStats.Last5Min.MinWPM, s.WPMStats.Last5Min.MaxWPM,
				s.WPMStats.Last10Min.AvgWPM, s.WPMStats.Last10Min.MinWPM, s.WPMStats.Last10Min.MaxWPM,
			)
			if err != nil {
				return err
			}
			var txErr error
			tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "cw_metrics")
			return txErr
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] cw_metrics: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// walkCSVFiles walks dir recursively and calls fn for every file named filename.
// Directory-level errors (e.g. permission denied) are logged and skipped so
// that one bad directory does not abort the entire table import.
func walkCSVFiles(dir, filename string, fn func(path string) error) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, err)
			return nil // skip unreadable entries, don't abort
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Base(path) == filename {
			if ferr := fn(path); ferr != nil {
				log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
			}
		}
		return nil
	})
}

// walkJSONLFiles walks dir recursively and calls fn for every file named filename.
// Directory-level errors are logged and skipped.
func walkJSONLFiles(dir, filename string, fn func(path string) error) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, err)
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Base(path) == filename {
			if ferr := fn(path); ferr != nil {
				log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
			}
		}
		return nil
	})
}

// readCSV opens path, skips the header row, and calls fn for each data row.
// Corrupt/malformed CSV rows are logged and skipped; only DB errors from fn
// are returned (which will abort the current file but not the whole import,
// since walkCSVFiles logs and continues on file-level errors).
func readCSV(path string, fn func(rec []string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.ReuseRecord = true
	r.LazyQuotes = true
	r.FieldsPerRecord = -1 // allow variable column counts; callers guard with len(rec) < N

	// Skip header row
	if _, err := r.Read(); err != nil {
		return nil // empty file — not an error
	}

	skipped := 0
	for {
		rec, err := r.Read()
		if err == io.EOF {
			if skipped > 0 {
				log.Printf("[DB import] %s: skipped %d malformed CSV row(s)", path, skipped)
			}
			return nil
		}
		if err != nil {
			// Corrupt line — log once per file at the end, skip and continue
			skipped++
			continue
		}
		// Make a copy because ReuseRecord reuses the backing array
		row := make([]string, len(rec))
		copy(row, rec)
		if err := fn(row); err != nil {
			return err // DB error — propagate so walkCSVFiles can log and skip the file
		}
	}
}

// readJSONL opens path and calls fn for each non-empty line.
// Lines that exceed the scanner buffer are logged and skipped; scanner errors
// (e.g. I/O errors mid-file) are logged and the function returns nil so the
// walk continues with the next file.
// ─────────────────────────────────────────────────────────────────────────────
// wspr_rank_windows / wspr_rank_rows  ← <StatsDir>/wspr/YYYY/MM/DD/rolling_24h.jsonl
//
// Each line is a full JSON WSPRRankResponse containing all three windows, so
// only rolling_24h.jsonl is read — yesterday.jsonl and today.jsonl hold byte-
// identical copies (see StatsLogger.WriteWSPR).
// ─────────────────────────────────────────────────────────────────────────────

// statsMaxJSONLine caps line length for the stats importers. A WSPRRankResponse
// with three populated leaderboards is the largest record the project writes.
const statsMaxJSONLine = 32 * 1024 * 1024

func (imp *DBImporter) importWSPRRank(ctx context.Context) error {
	const winStmt = `INSERT OR IGNORE INTO wspr_rank_windows (
		ts, window_name, fetched_at, fetched_ms, row_count, error
	) VALUES (?,?,?,?,?,?)`
	const rowStmt = `INSERT OR IGNORE INTO wspr_rank_rows (
		ts, window_name, rank_pos, rx_sign, rx_loc, raw, dupe, unique_count,
		bands, uniques, gross, dupes, versions
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`

	// Directory structure: <StatsDir>/wspr/YYYY/MM/DD/rolling_24h.jsonl
	// Day directories older than the cutoff are skipped wholesale.
	root := filepath.Join(imp.StatsDir, "wspr")
	cutoffDate := importCutoff(importStatsDays)

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(root, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if ctx.Err() != nil {
			return nil
		}
		if d.IsDir() {
			if dayDirBefore(root, path, cutoffDate) {
				return filepath.SkipDir // skip entire day subtree
			}
			return nil
		}
		if filepath.Base(path) != "rolling_24h.jsonl" {
			return nil
		}

		if ferr := readJSONLMax(path, statsMaxJSONLine, func(line []byte) error {
			var resp WSPRRankResponse
			if err := json.Unmarshal(line, &resp); err != nil {
				return nil // malformed line — skip
			}
			if resp.GeneratedAt.IsZero() {
				return nil
			}
			ts := resp.GeneratedAt.UTC().Unix()

			for _, name := range wsprWindowNames {
				win := wsprWindowPtr(&resp, name)
				if win == nil {
					continue
				}
				var fetchedAt interface{}
				if !win.FetchedAt.IsZero() {
					fetchedAt = win.FetchedAt.UTC().Unix()
				}
				if _, err := tx.ExecContext(ctx, winStmt,
					ts, name, fetchedAt, win.FetchedMs, win.Rows, win.Error); err != nil {
					return err
				}
				for i, row := range win.Data {
					if _, err := tx.ExecContext(ctx, rowStmt,
						ts, name, i, row.RxSign, row.RxLoc,
						int64(row.Raw), int64(row.Dupe), int64(row.Unique),
						marshalJSONCol(row.Bands), marshalJSONCol(row.Uniques),
						marshalJSONCol(row.Gross), marshalJSONCol(row.Dupes),
						marshalJSONCol(row.Versions),
					); err != nil {
						return err
					}
					var txErr error
					tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "wspr_rank_rows")
					if txErr != nil {
						return txErr
					}
				}
			}
			return nil
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] wspr_rank_rows: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// psk_rank_snapshots / psk_rank_entries / psk_software
//   ← <StatsDir>/psk/YYYY/MM/DD/report_result.jsonl
//
// Each line is a full JSON PSKRankData holding both result maps, so only
// report_result.jsonl is read — country_result.jsonl is an identical copy
// (see StatsLogger.WritePSK).
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importPSKRank(ctx context.Context) error {
	const snapStmt = `INSERT OR IGNORE INTO psk_rank_snapshots (ts, fetched_ms, error) VALUES (?,?,?)`
	const entStmt = `INSERT OR IGNORE INTO psk_rank_entries (
		ts, result_type, band, rank_pos, callsign, day_count, week_count
	) VALUES (?,?,?,?,?,?,?)`
	const swStmt = `INSERT OR IGNORE INTO psk_software (ts, callsign, name, version) VALUES (?,?,?,?)`

	// Directory structure: <StatsDir>/psk/YYYY/MM/DD/report_result.jsonl
	// Day directories older than the cutoff are skipped wholesale.
	root := filepath.Join(imp.StatsDir, "psk")
	cutoffDate := importCutoff(importStatsDays)

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(root, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if ctx.Err() != nil {
			return nil
		}
		if d.IsDir() {
			if dayDirBefore(root, path, cutoffDate) {
				return filepath.SkipDir // skip entire day subtree
			}
			return nil
		}
		if filepath.Base(path) != "report_result.jsonl" {
			return nil
		}

		if ferr := readJSONLMax(path, statsMaxJSONLine, func(line []byte) error {
			var data PSKRankData
			if err := json.Unmarshal(line, &data); err != nil {
				return nil
			}
			if data.FetchedAt.IsZero() {
				return nil
			}
			ts := data.FetchedAt.UTC().Unix()

			if _, err := tx.ExecContext(ctx, snapStmt, ts, data.FetchedMs, data.Error); err != nil {
				return err
			}
			for resultType, byBand := range pskResultTypes(&data) {
				for band, entries := range byBand {
					for i, e := range entries {
						if _, err := tx.ExecContext(ctx, entStmt,
							ts, resultType, band, i, e.Callsign, e.Day, e.Week); err != nil {
							return err
						}
						var txErr error
						tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "psk_rank_entries")
						if txErr != nil {
							return txErr
						}
					}
				}
			}
			for callsign, list := range data.SoftwareInUse {
				for _, sw := range list {
					if _, err := tx.ExecContext(ctx, swStmt, ts, callsign, sw.Name, sw.Version); err != nil {
						return err
					}
				}
			}
			return nil
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] psk_rank_entries: inserted %d rows total", total)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// rbn_skew / rbn_stats  ← <StatsDir>/rbn/YYYY/MM/DD/{skew,statistics}.jsonl
//
// Each file holds a single line (the writer truncates on every fetch), so one
// day yields at most one snapshot per file. Both tables are filled by this one
// importer; it is registered against rbn_skew in RunImportIfEmpty.
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importRBN(ctx context.Context) error {
	const skewStmt = `INSERT OR IGNORE INTO rbn_skew (
		ts, source_comment, callsign, skew, spots, correction_factor
	) VALUES (?,?,?,?,?,?)`
	const statsStmt = `INSERT OR IGNORE INTO rbn_stats (
		ts, source_comment, callsign, epoch_date, spot_count
	) VALUES (?,?,?,?,?)`

	// Directory structure: <StatsDir>/rbn/YYYY/MM/DD/{skew,statistics}.jsonl
	// Day directories older than the cutoff are skipped wholesale.
	root := filepath.Join(imp.StatsDir, "rbn")
	cutoffDate := importCutoff(importStatsDays)

	tx, err := imp.beginBatch(ctx)
	if err != nil {
		return err
	}
	count, total := 0, 0

	err = filepath.WalkDir(root, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			log.Printf("[DB import] walk error at %s: %v (skipping)", path, werr)
			return nil
		}
		if ctx.Err() != nil {
			return nil
		}
		if d.IsDir() {
			if dayDirBefore(root, path, cutoffDate) {
				return filepath.SkipDir // skip entire day subtree
			}
			return nil
		}
		base := filepath.Base(path)
		if base != "skew.jsonl" && base != "statistics.jsonl" {
			return nil
		}

		if ferr := readJSONLMax(path, statsMaxJSONLine, func(line []byte) error {
			if base == "skew.jsonl" {
				var rec rbnSkewRecord
				if err := json.Unmarshal(line, &rec); err != nil || rec.FetchedAt.IsZero() {
					return nil
				}
				ts := rec.FetchedAt.UTC().Unix()
				for _, e := range rec.Entries {
					if _, err := tx.ExecContext(ctx, skewStmt,
						ts, rec.SourceComment, e.Callsign, e.Skew, e.Spots, e.CorrectionFactor); err != nil {
						return err
					}
					var txErr error
					tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "rbn_skew")
					if txErr != nil {
						return txErr
					}
				}
				return nil
			}

			var rec rbnStatsRecord
			if err := json.Unmarshal(line, &rec); err != nil || rec.FetchedAt.IsZero() {
				return nil
			}
			ts := rec.FetchedAt.UTC().Unix()
			for _, e := range rec.Entries {
				if _, err := tx.ExecContext(ctx, statsStmt,
					ts, rec.SourceComment, e.Callsign, e.EpochDate, e.SpotCount); err != nil {
					return err
				}
				var txErr error
				tx, txErr = imp.commitAndMaybeBegin(ctx, tx, &count, &total, "rbn_stats")
				if txErr != nil {
					return txErr
				}
			}
			return nil
		}); ferr != nil {
			log.Printf("[DB import] error processing %s: %v (skipping file)", path, ferr)
		}
		return nil
	})

	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[DB import] rbn_skew/rbn_stats: inserted %d rows total", total)
	return nil
}

func readJSONL(path string, fn func(line []byte) error) error {
	return readJSONLMax(path, 1024*1024, fn) // 1 MiB max line
}

// readJSONLMax is readJSONL with an explicit maximum line length. The stats
// importers need a much larger cap: a single WSPRRankResponse line holds three
// full leaderboards and runs to several MiB.
func readJSONLMax(path string, maxLine int, fn func(line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), maxLine)
	skipped := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if err := fn(line); err != nil {
			return err // DB error — propagate so walk can log and skip the file
		}
	}
	if err := scanner.Err(); err != nil {
		// I/O or buffer-overflow error mid-file — log but don't abort the walk
		log.Printf("[DB import] %s: scanner error after %d lines skipped: %v (partial import)", path, skipped, err)
	}
	return nil
}

// parseTimestamp parses an RFC3339 timestamp string and returns Unix seconds.
// Returns an error for empty or unparseable strings.
func parseTimestamp(s string) (int64, error) {
	if s == "" {
		return 0, io.ErrUnexpectedEOF
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		// Try without timezone (some older files may use a different format)
		t, err = time.Parse("2006-01-02T15:04:05", s)
		if err != nil {
			return 0, err
		}
	}
	return t.Unix(), nil
}

// parseInt parses a decimal integer string; returns 0 on error.
func parseInt(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

// parseFloat parses a float string; returns 0 on error.
func parseFloat(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

// parseFloats parses a slice of float strings; returns a slice of float64.
// Elements that fail to parse become 0.
func parseFloats(ss []string) []float64 {
	out := make([]float64, len(ss))
	for i, s := range ss {
		out[i] = parseFloat(s)
	}
	return out
}

// nullableFloat returns nil for empty/zero strings, otherwise the parsed float64.
// Used for optional columns like distance_km and bearing_deg.
func nullableFloat(s string) interface{} {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return v
}

// nullableInt returns nil for empty strings, otherwise the parsed int64.
// Used for optional columns like dbm.
func nullableInt(s string) interface{} {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return nil
	}
	return v
}

// ─────────────────────────────────────────────────────────────────────────────
// decoder_metrics_summary ← <DecoderSummaryDir>/{daily,weekly,monthly,yearly}/…/<MODE>-<BAND>-summary.json
// cw_metrics_summary      ← <CWSummaryDir>/{daily,weekly,monthly,yearly}/…/<BAND>-summary.json
//
// Each legacy summary file holds one full MetricsSummary / CWMetricsSummary as
// JSON. The whole struct is stored verbatim in the `data` column; scalar
// columns (ts, end_ts, updated_ts, mode/band/period/period_key) are derived
// from the parsed struct. INSERT OR IGNORE keeps the backfill idempotent.
// ─────────────────────────────────────────────────────────────────────────────

func (imp *DBImporter) importDecoderSummary(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO decoder_metrics_summary
		(ts, mode, band, period, period_key, end_ts, updated_ts, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	total := 0
	err := filepath.WalkDir(imp.DecoderSummaryDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			return nil // skip unreadable entries
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() || !strings.HasSuffix(path, "-summary.json") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			log.Printf("[DB import] decoder_metrics_summary: read %s: %v", path, err)
			return nil
		}
		var s MetricsSummary
		if err := json.Unmarshal(raw, &s); err != nil {
			log.Printf("[DB import] decoder_metrics_summary: parse %s: %v", path, err)
			return nil
		}
		if s.Period == "" || s.Mode == "" || s.Band == "" {
			return nil // not a valid summary file
		}
		periodKey := summaryPeriodKey(s.Period, s.StartTime)
		if _, err := imp.db.Exec(stmt,
			s.StartTime.Unix(), s.Mode, s.Band, s.Period, periodKey,
			s.EndTime.Unix(), s.LastUpdated.Unix(), string(raw),
		); err != nil {
			log.Printf("[DB import] decoder_metrics_summary: insert %s: %v", path, err)
			return nil
		}
		total++
		return nil
	})
	if err != nil {
		return err
	}
	log.Printf("[DB import] decoder_metrics_summary: inserted %d rows total", total)
	return nil
}

func (imp *DBImporter) importCWSummary(ctx context.Context) error {
	const stmt = `INSERT OR IGNORE INTO cw_metrics_summary
		(ts, band, period, period_key, end_ts, updated_ts, data)
		VALUES (?, ?, ?, ?, ?, ?, ?)`

	total := 0
	err := filepath.WalkDir(imp.CWSummaryDir, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() || !strings.HasSuffix(path, "-summary.json") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			log.Printf("[DB import] cw_metrics_summary: read %s: %v", path, err)
			return nil
		}
		var s CWMetricsSummary
		if err := json.Unmarshal(raw, &s); err != nil {
			log.Printf("[DB import] cw_metrics_summary: parse %s: %v", path, err)
			return nil
		}
		if s.Period == "" || s.Band == "" {
			return nil
		}
		periodKey := summaryPeriodKey(s.Period, s.StartTime)
		if _, err := imp.db.Exec(stmt,
			s.StartTime.Unix(), s.Band, s.Period, periodKey,
			s.EndTime.Unix(), s.LastUpdated.Unix(), string(raw),
		); err != nil {
			log.Printf("[DB import] cw_metrics_summary: insert %s: %v", path, err)
			return nil
		}
		total++
		return nil
	})
	if err != nil {
		return err
	}
	log.Printf("[DB import] cw_metrics_summary: inserted %d rows total", total)
	return nil
}
