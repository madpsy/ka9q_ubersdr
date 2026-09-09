package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/ua-parser/uap-go/uaparser"
)

// One-off backfill of the normalised session tables from the legacy `sessions`
// snapshot log.
//
// The legacy table is an append-only design: every event re-serialises the whole
// active set, so it holds a row per active session per event. A session has an
// identity, so the new tables hold one row per session, updated in place. This
// converts the former into the latter once, at startup, and reports progress
// through the same background-task banner the historical CSV/JSONL import uses.
//
// Following the convention in db_import.go, "already done" is simply "the target
// table is not empty", decided synchronously before any live writer starts.

// migratedSession is one session reconstructed from the snapshot log.
type migratedSession struct {
	userSessionID string
	startedAt     int64
	lastSeen      int64
	clientIP      string
	sourceIP      string
	authMethod    string
	protocol      string
	country       string
	countryCode   string
	userAgent     string
	bands         map[string]bool
	modes         map[string]bool
	hasAudio      bool
	hasSpectrum   bool
}

// MigrateSessionHistoryIfNeeded backfills `session` and its child tables from
// the legacy snapshot log, if that log is still present.
//
// Must be called during startup, before any live session writer runs: every
// session in the legacy table belongs to a previous process lifetime and is
// therefore closed, which is what lets ended_at be set from last_seen.
func MigrateSessionHistoryIfNeeded(db *sql.DB, readDB *sql.DB, geoIPService *GeoIPService) {
	if db == nil || readDB == nil {
		return
	}

	legacyRows, present := legacySessionRows(readDB)
	if !present {
		return
	}
	if legacyRows == 0 {
		dropLegacySessionsTable(db)
		return // nothing to convert
	}

	log.Printf("[session migration] converting %d legacy snapshot rows", legacyRows)

	task := bgTasks.Start("session-history-migration", BackgroundTaskOpts{
		Name: "Session history migration",
		Description: "Converting the session activity snapshot log into per-session records. " +
			"The receiver keeps running normally; session statistics are unavailable until this finishes.",
	})
	task.SetStep("reading snapshot log")

	go func() {
		started := time.Now()
		sessions, err := readLegacySessions(readDB, legacyRows, task)
		if err != nil {
			task.Fail(fmt.Errorf("reading snapshot log: %w", err))
			log.Printf("[session migration] failed: %v", err)
			return
		}

		if err := writeMigratedSessions(db, sessions, geoIPService, task); err != nil {
			task.Fail(fmt.Errorf("writing session records: %w", err))
			log.Printf("[session migration] failed: %v", err)
			return
		}

		// The snapshot log has served its purpose; everything it described now
		// lives in the session tables.
		dropLegacySessionsTable(db)

		log.Printf("[session migration] converted %d snapshot rows into %d sessions in %v",
			legacyRows, len(sessions), time.Since(started).Round(time.Millisecond))
		task.Complete(fmt.Sprintf("%s sessions recovered from %s snapshot rows",
			formatCount(len(sessions)), formatCount(legacyRows)))
	}()
}

// legacySessionRows reports how many rows the legacy snapshot log holds, and
// whether the table is there at all. It is not part of the schema any more: it
// only exists on installations that predate the session tables.
//
// Its presence is the whole gate, because it is dropped only once its contents
// have been converted — so a run that failed part way, or one interrupted by a
// restart, is retried on the next startup instead of stranding the history. The
// `session` table cannot serve as the gate: the live writer starts recording the
// moment the first listener connects, so "not empty" says nothing about whether
// the legacy log was ever converted. Re-running costs nothing but time: every
// insert is conditional on the session not already being recorded.
func legacySessionRows(readDB *sql.DB) (int, bool) {
	var exists int
	if err := readDB.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions')`,
	).Scan(&exists); err != nil {
		log.Printf("[session migration] looking for the legacy sessions table: %v (skipping)", err)
		return 0, false
	}
	if exists == 0 {
		return 0, false
	}

	var rows int
	if err := readDB.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&rows); err != nil {
		log.Printf("[session migration] counting legacy rows: %v (skipping)", err)
		return 0, false
	}
	return rows, true
}

// readLegacySessions folds the snapshot log down to one record per session.
// Memory is bounded by the session count, not the row count — the whole point of
// the new schema, and about 50x fewer objects on a real receiver.
func readLegacySessions(readDB *sql.DB, legacyRows int, task *BackgroundTask) ([]*migratedSession, error) {
	byID := make(map[string]*migratedSession)
	seen := 0

	err := StreamActivityLogsFromDB(context.Background(), readDB, time.Unix(0, 0), time.Now().UTC().Add(24*time.Hour),
		func(entry SessionActivityLog) error {
			ts := entry.Timestamp.Unix()
			for _, e := range entry.ActiveSessions {
				seen++
				rec := byID[e.UserSessionID]
				if rec == nil {
					rec = &migratedSession{
						userSessionID: e.UserSessionID,
						startedAt:     ts,
						bands:         make(map[string]bool),
						modes:         make(map[string]bool),
					}
					byID[e.UserSessionID] = rec
				}

				// Session start: when the user first connected, else when the
				// channel was created, else the snapshot that first saw it.
				for _, candidate := range []int64{unixOrZero(e.FirstSeen), unixOrZero(e.CreatedAt)} {
					if candidate > 0 && candidate < rec.startedAt {
						rec.startedAt = candidate
					}
				}
				if ts > rec.lastSeen {
					rec.lastSeen = ts
				}

				// Stable per-session attributes: keep the last non-empty value.
				assignIfSet(&rec.clientIP, e.ClientIP)
				assignIfSet(&rec.sourceIP, e.SourceIP)
				assignIfSet(&rec.authMethod, e.AuthMethod)
				assignIfSet(&rec.protocol, e.Protocol)
				assignIfSet(&rec.country, e.Country)
				assignIfSet(&rec.countryCode, e.CountryCode)
				assignIfSet(&rec.userAgent, e.UserAgent)

				for _, b := range e.Bands {
					if b != "" {
						rec.bands[b] = true
					}
				}
				for _, m := range e.Modes {
					if m != "" {
						rec.modes[m] = true
					}
				}
				for _, t := range e.SessionTypes {
					switch t {
					case "audio":
						rec.hasAudio = true
					case "spectrum":
						rec.hasSpectrum = true
					}
				}
			}

			if legacyRows > 0 && seen%20000 < len(entry.ActiveSessions) {
				task.SetProgressStep(float64(seen)/float64(legacyRows)*50,
					fmt.Sprintf("reading snapshot log (%s of %s rows)", formatCount(seen), formatCount(legacyRows)))
			}
			return nil
		})
	if err != nil {
		return nil, err
	}

	out := make([]*migratedSession, 0, len(byID))
	for _, rec := range byID {
		out = append(out, rec)
	}
	// Deterministic order, so a re-run inserts identically.
	sort.Slice(out, func(i, j int) bool {
		if out[i].startedAt != out[j].startedAt {
			return out[i].startedAt < out[j].startedAt
		}
		return out[i].userSessionID < out[j].userSessionID
	})
	return out, nil
}

// migrationBatchSize bounds how many sessions are written per transaction.
//
// The migration runs in the background while the receiver is already accepting
// listeners, so it must not hold the write lock long enough for a live session to
// exhaust its busy_timeout (5s). Committing in batches keeps each hold to a
// fraction of a second regardless of how much history there is.
const migrationBatchSize = 2000

// writeMigratedSessions inserts the reconstructed sessions and their band and
// mode rows, committing in batches.
func writeMigratedSessions(db *sql.DB, sessions []*migratedSession, geoIPService *GeoIPService, task *BackgroundTask) error {
	task.SetProgressStep(50, "writing session records")

	parser := uaparser.NewFromSaved()
	uaIDs := make(map[string]int64)
	geoCache := make(map[string]*GeoIPResult)

	for start := 0; start < len(sessions); start += migrationBatchSize {
		end := start + migrationBatchSize
		if end > len(sessions) {
			end = len(sessions)
		}
		if err := writeMigratedSessionBatch(db, sessions[start:end], geoIPService, parser, uaIDs, geoCache); err != nil {
			return err
		}
		if len(sessions) > 0 {
			task.SetProgressStep(50+float64(end)/float64(len(sessions))*50,
				fmt.Sprintf("writing session records (%s of %s)", formatCount(end), formatCount(len(sessions))))
		}
	}
	return nil
}

// writeMigratedSessionBatch writes one batch inside a single transaction.
func writeMigratedSessionBatch(db *sql.DB, sessions []*migratedSession, geoIPService *GeoIPService,
	parser *uaparser.Parser, uaIDs map[string]int64, geoCache map[string]*GeoIPResult) error {

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	insertSession, err := tx.Prepare(`
		INSERT INTO session
			(user_session_id, started_at, ended_at, last_seen, client_ip, source_ip,
			 auth_method, protocol, user_agent_id, country, country_code,
			 latitude, longitude, has_audio, has_spectrum)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_session_id) DO NOTHING`)
	if err != nil {
		return err
	}
	defer insertSession.Close()

	// The row id of a session that already exists cannot come from LastInsertId;
	// see migratedSessionID.
	selectSessionID, err := tx.Prepare(`SELECT id FROM session WHERE user_session_id = ?`)
	if err != nil {
		return err
	}
	defer selectSessionID.Close()

	insertBand, err := tx.Prepare(`INSERT OR IGNORE INTO session_band (session_id, band) VALUES (?, ?)`)
	if err != nil {
		return err
	}
	defer insertBand.Close()

	insertMode, err := tx.Prepare(`INSERT OR IGNORE INTO session_mode (session_id, mode) VALUES (?, ?)`)
	if err != nil {
		return err
	}
	defer insertMode.Close()

	for _, rec := range sessions {
		uaID, err := userAgentIDTx(tx, parser, uaIDs, rec.userAgent)
		if err != nil {
			return err
		}

		// Resolve coordinates once per IP so the map keeps working for
		// historical sessions; the legacy rows never stored them.
		var lat, lon interface{}
		country, countryCode := rec.country, rec.countryCode
		if geoIPService != nil && geoIPService.IsEnabled() && rec.clientIP != "" {
			geo, cached := geoCache[rec.clientIP]
			if !cached {
				geo, _ = geoIPService.Lookup(rec.clientIP, false)
				geoCache[rec.clientIP] = geo
			}
			if geo != nil {
				if geo.Country != "" {
					country, countryCode = geo.Country, geo.CountryCode
				}
				if geo.Latitude != nil && geo.Longitude != nil {
					lat, lon = *geo.Latitude, *geo.Longitude
				}
			}
		}

		// Every session in the legacy table belongs to a previous process
		// lifetime, so it is closed: the last time it was seen is its end.
		res, err := insertSession.Exec(
			rec.userSessionID, rec.startedAt, rec.lastSeen, rec.lastSeen,
			rec.clientIP, rec.sourceIP, rec.authMethod, rec.protocol,
			nullableID(uaID), country, countryCode, lat, lon,
			boolToInt(rec.hasAudio), boolToInt(rec.hasSpectrum),
		)
		if err != nil {
			return fmt.Errorf("insert session %s: %w", rec.userSessionID, err)
		}
		sessionID, err := migratedSessionID(res, selectSessionID, rec.userSessionID)
		if err != nil {
			return err
		}

		for band := range rec.bands {
			if _, err := insertBand.Exec(sessionID, band); err != nil {
				return err
			}
		}
		for mode := range rec.modes {
			if _, err := insertMode.Exec(sessionID, mode); err != nil {
				return err
			}
		}

	}

	return tx.Commit()
}

// migratedSessionID returns the row id the band and mode rows must point at.
//
// LastInsertId is only meaningful when the statement actually inserted a row.
// SQLite leaves last_insert_rowid() untouched when ON CONFLICT DO NOTHING fires,
// and the write handle is a single connection shared by every writer in the
// process, so what is left over is some other statement's row id — most often
// the user_agent row interned moments earlier in this same transaction. Handing
// that to the child inserts either fails their foreign key (787,
// SQLITE_CONSTRAINT_FOREIGNKEY) or, worse, silently files this session's bands
// and modes against an unrelated session that happens to hold the same id.
//
// A conflict means a live listener is already recorded under this id: the
// migration runs in the background while the receiver serves, and the kiwi and
// websdr ids are derived from the client, so one can repeat across a restart.
// That row describes the live session and must not be rewritten — notably its
// ended_at, which is still open. Its id is returned so the historical bands and
// modes merge into it, which is what the live writer does when it meets the same
// id twice.
func migratedSessionID(res sql.Result, lookup *sql.Stmt, userSessionID string) (int64, error) {
	if inserted, err := res.RowsAffected(); err == nil && inserted > 0 {
		id, err := res.LastInsertId()
		if err != nil {
			return 0, fmt.Errorf("row id for session %s: %w", userSessionID, err)
		}
		if id > 0 {
			return id, nil
		}
	}

	var id int64
	if err := lookup.QueryRow(userSessionID).Scan(&id); err != nil {
		return 0, fmt.Errorf("resolving existing session %s: %w", userSessionID, err)
	}
	if id <= 0 {
		return 0, fmt.Errorf("resolving existing session %s: got row id %d", userSessionID, id)
	}
	return id, nil
}

// userAgentIDTx interns a user agent string, parsing it once per distinct value.
func userAgentIDTx(tx *sql.Tx, parser *uaparser.Parser, cache map[string]int64, ua string) (int64, error) {
	if ua == "" {
		return 0, nil
	}
	if id, ok := cache[ua]; ok {
		return id, nil
	}

	browser, os := parseUserAgent(parser, ua)
	if _, err := tx.Exec(`INSERT OR IGNORE INTO user_agent (ua, browser, os) VALUES (?, ?, ?)`, ua, browser, os); err != nil {
		return 0, err
	}
	var id int64
	if err := tx.QueryRow(`SELECT id FROM user_agent WHERE ua = ?`, ua).Scan(&id); err != nil {
		return 0, err
	}
	cache[ua] = id
	return id, nil
}

// parseUserAgent derives the browser and OS labels the statistics group by. The
// UberSDR clients are special-cased the way the old stats fold did it.
func parseUserAgent(parser *uaparser.Parser, ua string) (browser, os string) {
	if ua == "" {
		return "", ""
	}
	client := parser.Parse(ua)

	if len(ua) >= 7 && ua[:7] == "UberSDR" {
		browser = "UberSDR Client"
	} else if client.UserAgent.Family != "" {
		browser = client.UserAgent.Family
		if client.UserAgent.Major != "" {
			browser += " " + client.UserAgent.Major
		}
	}

	if client.Os.Family != "" {
		os = client.Os.Family
		if client.Os.Major != "" {
			os += " " + client.Os.Major
		}
	}
	return browser, os
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

func assignIfSet(dst *string, value string) {
	if value != "" {
		*dst = value
	}
}

func nullableID(id int64) interface{} {
	if id == 0 {
		return nil
	}
	return id
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// dropLegacySessionsTable removes the snapshot log once its contents have been
// converted. Reclaiming the pages matters: it is by far the largest table on a
// busy receiver, holding a row per active session per event.
func dropLegacySessionsTable(db *sql.DB) {
	if _, err := db.Exec(`DROP TABLE IF EXISTS sessions`); err != nil {
		log.Printf("[session migration] dropping legacy sessions table: %v", err)
		return
	}
	if _, err := db.Exec(`PRAGMA incremental_vacuum`); err != nil {
		log.Printf("[session migration] reclaiming space: %v", err)
	}
	log.Printf("[session migration] dropped the legacy sessions table")
}
