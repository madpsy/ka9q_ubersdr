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
	"time"
)

const importBatchSize = 100000

// importSpotsDays limits how far back the spots and cw_spots backfill reaches.
// Rows older than this many days are skipped — they would be pruned by the
// retention loop anyway and importing them wastes time and disk space.
const importSpotsDays = 30

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
}

// RunImportIfEmpty checks each table synchronously (before live writers start),
// then backfills only the empty ones in a background goroutine.
//
// The empty check MUST happen synchronously so that live writes arriving after
// startup cannot cause a table to appear non-empty before the decision is made.
func (imp *DBImporter) RunImportIfEmpty(ctx context.Context) {
	type tableImport struct {
		table    string
		dir      string
		importFn func(context.Context) error
	}
	all := []tableImport{
		{"chat_messages", imp.ChatDir, imp.importChat},
		{"noise_floor", imp.NoiseFloorDir, imp.importNoiseFloor},
		{"spots", imp.SpotsDir, imp.importSpots},
		{"cw_spots", imp.CWSpotsDir, imp.importCWSpots},
		{"sessions", imp.SessionsDir, imp.importSessions},
		{"space_weather", imp.SpaceWeatherDir, imp.importSpaceWeather},
		{"decoder_metrics", imp.DecoderMetricsDir, imp.importDecoderMetrics},
		{"cw_metrics", imp.CWMetricsDir, imp.importCWMetrics},
	}

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
		toImport = append(toImport, t)
	}

	if len(toImport) == 0 {
		return // nothing to do
	}

	// Run the actual file-reading and inserting in the background so startup
	// is not blocked. The decision of WHICH tables to import was already made
	// above, so live writes arriving now cannot affect it.
	go func() {
		for _, t := range toImport {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[DB import] %s: starting backfill", t.table)
			start := time.Now()
			if err := t.importFn(ctx); err != nil {
				log.Printf("[DB import] %s backfill error: %v", t.table, err)
			} else {
				log.Printf("[DB import] %s backfill complete in %v", t.table, time.Since(start).Round(time.Millisecond))
			}
		}
	}()
}

// tableIsEmpty returns true when COUNT(*) == 0 for the named table.
func (imp *DBImporter) tableIsEmpty(table string) (bool, error) {
	var n int
	// Table name is not user-supplied; safe to interpolate.
	err := imp.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n)
	return n == 0, err
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
	cutoffDate := time.Now().UTC().AddDate(0, 0, -importSpotsDays).Truncate(24 * time.Hour)

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
				// Compute the relative path from modeDir; if it has exactly
				// 3 components (year/month/day) parse the date and skip the
				// entire subtree when it predates the cutoff.
				rel, relErr := filepath.Rel(modeDir, path)
				if relErr == nil {
					parts := strings.Split(rel, string(filepath.Separator))
					if len(parts) == 3 {
						dayStr := parts[0] + "-" + parts[1] + "-" + parts[2]
						if dayTime, parseErr := time.Parse("2006-01-02", dayStr); parseErr == nil {
							if dayTime.Before(cutoffDate) {
								return filepath.SkipDir // skip entire day subtree
							}
						}
					}
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
	cutoffDate := time.Now().UTC().AddDate(0, 0, -importSpotsDays).Truncate(24 * time.Hour)

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
			rel, relErr := filepath.Rel(imp.CWSpotsDir, path)
			if relErr == nil {
				parts := strings.Split(rel, string(filepath.Separator))
				if len(parts) == 3 {
					dayStr := parts[0] + "-" + parts[1] + "-" + parts[2]
					if dayTime, parseErr := time.Parse("2006-01-02", dayStr); parseErr == nil {
						if dayTime.Before(cutoffDate) {
							return filepath.SkipDir // skip entire day subtree
						}
					}
				}
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
func readJSONL(path string, fn func(line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1 MiB max line
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
