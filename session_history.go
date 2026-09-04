package main

import (
	"database/sql"
	"log"
	"sync"
	"time"

	"github.com/ua-parser/uap-go/uaparser"
)

// Live writer for the normalised session tables.
//
// A session has an identity, so it gets one row that is updated in place:
// created once, touched while it lives, closed when it ends. Tuning from 20m to
// 40m is an INSERT OR IGNORE into session_band rather than another copy of the
// whole session, and the periodic heartbeat is a single UPDATE across every open
// row rather than a row per active session.
//
// See session_history_migration.go for the one-off conversion of the legacy
// `sessions` snapshot log into this shape.

type sessionHistoryWriter struct {
	db     *sql.DB
	geo    *GeoIPService
	parser *uaparser.Parser

	mu    sync.Mutex
	uaIDs map[string]int64 // interned user agents, so each is parsed once per process
	ids   map[string]int64 // user_session_id -> session.id, for the open sessions
}

func newSessionHistoryWriter(db *sql.DB, geo *GeoIPService) *sessionHistoryWriter {
	return &sessionHistoryWriter{
		db:     db,
		geo:    geo,
		parser: uaparser.NewFromSaved(),
		uaIDs:  make(map[string]int64),
		ids:    make(map[string]int64),
	}
}

// sweepOpenSessions closes sessions left open by a previous process. Nothing is
// live at startup, so any row without an end belongs to a lifetime that ended
// when the process did; last_seen is the best evidence of when.
func (w *sessionHistoryWriter) sweepOpenSessions() {
	if w == nil || w.db == nil {
		return
	}
	res, err := w.db.Exec(`UPDATE session SET ended_at = last_seen WHERE ended_at IS NULL`)
	if err != nil {
		log.Printf("[session history] sweeping open sessions: %v", err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("[session history] closed %d session(s) left open by a previous run", n)
	}
}

// recordActive inserts or refreshes one session and its bands and modes.
func (w *sessionHistoryWriter) recordActive(entry SessionActivityEntry, now int64) {
	if w == nil || w.db == nil || entry.UserSessionID == "" {
		return
	}

	startedAt := now
	for _, candidate := range []int64{unixOrZero(entry.FirstSeen), unixOrZero(entry.CreatedAt)} {
		if candidate > 0 && candidate < startedAt {
			startedAt = candidate
		}
	}

	uaID, err := w.userAgentID(entry.UserAgent)
	if err != nil {
		log.Printf("[session history] interning user agent: %v", err)
	}

	country, countryCode := entry.Country, entry.CountryCode
	var lat, lon interface{}
	if w.geo != nil && w.geo.IsEnabled() && entry.ClientIP != "" {
		if geo, err := w.geo.Lookup(entry.ClientIP, false); err == nil && geo != nil {
			if geo.Country != "" {
				country, countryCode = geo.Country, geo.CountryCode
			}
			if geo.Latitude != nil && geo.Longitude != nil {
				lat, lon = *geo.Latitude, *geo.Longitude
			}
		}
	}

	hasAudio, hasSpectrum := 0, 0
	for _, t := range entry.SessionTypes {
		switch t {
		case "audio":
			hasAudio = 1
		case "spectrum":
			hasSpectrum = 1
		}
	}

	// Attributes are refreshed rather than replaced: a later snapshot may carry a
	// blank where the first one had a value (e.g. GeoIP not yet resolved), and the
	// type flags only ever accumulate.
	if _, err := w.db.Exec(`
		INSERT INTO session
			(user_session_id, started_at, last_seen, client_ip, source_ip, auth_method,
			 protocol, user_agent_id, country, country_code, latitude, longitude,
			 has_audio, has_spectrum)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_session_id) DO UPDATE SET
			last_seen     = excluded.last_seen,
			started_at    = MIN(session.started_at, excluded.started_at),
			ended_at      = NULL,
			client_ip     = COALESCE(NULLIF(excluded.client_ip, ''), session.client_ip),
			source_ip     = COALESCE(NULLIF(excluded.source_ip, ''), session.source_ip),
			auth_method   = COALESCE(NULLIF(excluded.auth_method, ''), session.auth_method),
			protocol      = COALESCE(NULLIF(excluded.protocol, ''), session.protocol),
			user_agent_id = COALESCE(excluded.user_agent_id, session.user_agent_id),
			country       = COALESCE(NULLIF(excluded.country, ''), session.country),
			country_code  = COALESCE(NULLIF(excluded.country_code, ''), session.country_code),
			latitude      = COALESCE(excluded.latitude, session.latitude),
			longitude     = COALESCE(excluded.longitude, session.longitude),
			has_audio     = MAX(session.has_audio, excluded.has_audio),
			has_spectrum  = MAX(session.has_spectrum, excluded.has_spectrum)`,
		entry.UserSessionID, startedAt, now, entry.ClientIP, entry.SourceIP,
		entry.AuthMethod, entry.Protocol, nullableID(uaID), country, countryCode,
		lat, lon, hasAudio, hasSpectrum,
	); err != nil {
		log.Printf("[session history] recording session %s: %v", entry.UserSessionID, err)
		return
	}

	sessionID, err := w.sessionID(entry.UserSessionID)
	if err != nil {
		log.Printf("[session history] resolving session %s: %v", entry.UserSessionID, err)
		return
	}
	w.recordBandsModes(sessionID, entry.Bands, entry.Modes)
}

// recordBandsModes adds any newly visited bands and modes. Repeats are no-ops,
// which is what makes it safe to call on every heartbeat.
func (w *sessionHistoryWriter) recordBandsModes(sessionID int64, bands, modes []string) {
	if sessionID == 0 {
		return
	}
	for _, band := range bands {
		if band == "" {
			continue
		}
		if _, err := w.db.Exec(`INSERT OR IGNORE INTO session_band (session_id, band) VALUES (?, ?)`, sessionID, band); err != nil {
			log.Printf("[session history] recording band %q: %v", band, err)
		}
	}
	for _, mode := range modes {
		if mode == "" || !isValidModeForLogging(mode) {
			continue
		}
		if _, err := w.db.Exec(`INSERT OR IGNORE INTO session_mode (session_id, mode) VALUES (?, ?)`, sessionID, mode); err != nil {
			log.Printf("[session history] recording mode %q: %v", mode, err)
		}
	}
}

// closeSession ends a session, merging any final bands and modes carried by the
// destroy event.
func (w *sessionHistoryWriter) closeSession(userSessionID string, bands, modes map[string]bool, now int64) {
	if w == nil || w.db == nil || userSessionID == "" {
		return
	}

	if len(bands) > 0 || len(modes) > 0 {
		if sessionID, err := w.sessionID(userSessionID); err == nil && sessionID != 0 {
			w.recordBandsModes(sessionID, setKeys(bands), setKeys(modes))
		}
	}

	if _, err := w.db.Exec(
		`UPDATE session SET ended_at = ?, last_seen = ? WHERE user_session_id = ? AND ended_at IS NULL`,
		now, now, userSessionID,
	); err != nil {
		log.Printf("[session history] closing session %s: %v", userSessionID, err)
	}

	w.mu.Lock()
	delete(w.ids, userSessionID)
	w.mu.Unlock()
}

// touchOpenSessions is the heartbeat: one statement for every live session,
// rather than a row written per session per interval.
func (w *sessionHistoryWriter) touchOpenSessions(now int64) {
	if w == nil || w.db == nil {
		return
	}
	if _, err := w.db.Exec(`UPDATE session SET last_seen = ? WHERE ended_at IS NULL`, now); err != nil {
		log.Printf("[session history] heartbeat: %v", err)
	}
}

// sessionID resolves and caches the row id for a live session.
func (w *sessionHistoryWriter) sessionID(userSessionID string) (int64, error) {
	w.mu.Lock()
	if id, ok := w.ids[userSessionID]; ok {
		w.mu.Unlock()
		return id, nil
	}
	w.mu.Unlock()

	var id int64
	if err := w.db.QueryRow(`SELECT id FROM session WHERE user_session_id = ?`, userSessionID).Scan(&id); err != nil {
		if err == sql.ErrNoRows {
			return 0, nil
		}
		return 0, err
	}

	w.mu.Lock()
	w.ids[userSessionID] = id
	w.mu.Unlock()
	return id, nil
}

// userAgentID interns a user agent, so it is parsed once per distinct string
// rather than once per session — a real receiver sees a few hundred distinct
// agents across thousands of sessions.
func (w *sessionHistoryWriter) userAgentID(ua string) (int64, error) {
	if ua == "" {
		return 0, nil
	}

	w.mu.Lock()
	if id, ok := w.uaIDs[ua]; ok {
		w.mu.Unlock()
		return id, nil
	}
	w.mu.Unlock()

	browser, os := parseUserAgent(w.parser, ua)
	if _, err := w.db.Exec(`INSERT OR IGNORE INTO user_agent (ua, browser, os) VALUES (?, ?, ?)`, ua, browser, os); err != nil {
		return 0, err
	}
	var id int64
	if err := w.db.QueryRow(`SELECT id FROM user_agent WHERE ua = ?`, ua).Scan(&id); err != nil {
		return 0, err
	}

	w.mu.Lock()
	w.uaIDs[ua] = id
	w.mu.Unlock()
	return id, nil
}

// pruneSessionHistory drops sessions that ended before the cutoff. The child
// rows go with them via ON DELETE CASCADE.
func pruneSessionHistory(db *sql.DB, olderThan time.Time) (int64, error) {
	if db == nil {
		return 0, nil
	}
	res, err := db.Exec(`DELETE FROM session WHERE ended_at IS NOT NULL AND ended_at < ?`, olderThan.Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func setKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k, v := range set {
		if v {
			out = append(out, k)
		}
	}
	return out
}
