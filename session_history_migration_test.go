package main

import (
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"
)

// loadLegacySessions copies a real `sessions` table into a fresh database so the
// migration can be exercised against production-shaped data. Point
// UBERSDR_SESSIONS_DB at an export of that table.
func loadLegacySessions(t *testing.T, mgr *DBManager) bool {
	t.Helper()

	path := os.Getenv("UBERSDR_SESSIONS_DB")
	if path == "" {
		return false
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("UBERSDR_SESSIONS_DB=%s: %v", path, err)
	}

	if _, err := mgr.DB().Exec(`ATTACH DATABASE ? AS legacy`, path); err != nil {
		t.Fatalf("attach %s: %v", path, err)
	}
	// Fresh databases no longer create the legacy snapshot table, so recreate it
	// here exactly as an installation that predates the session tables would have.
	if _, err := mgr.DB().Exec(`CREATE TABLE sessions AS SELECT * FROM legacy.sessions`); err != nil {
		t.Fatalf("copy legacy rows: %v", err)
	}
	if _, err := mgr.DB().Exec(`DETACH DATABASE legacy`); err != nil {
		t.Fatalf("detach: %v", err)
	}
	return true
}

func TestSessionHistoryMigrationAgainstRealData(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	if !loadLegacySessions(t, mgr) {
		t.Skip("set UBERSDR_SESSIONS_DB to a copy of a real sessions table")
	}

	var legacyRows, distinctSessions int
	if err := mgr.ReadDB().QueryRow(
		`SELECT COUNT(*), COUNT(DISTINCT user_session_id) FROM sessions`,
	).Scan(&legacyRows, &distinctSessions); err != nil {
		t.Fatalf("count legacy: %v", err)
	}

	task := bgTasks.Start("session-history-migration-test", BackgroundTaskOpts{Name: "test"})

	start := time.Now()
	sessions, err := readLegacySessions(mgr.ReadDB(), legacyRows, task)
	if err != nil {
		t.Fatalf("readLegacySessions: %v", err)
	}
	readElapsed := time.Since(start)

	start = time.Now()
	if err := writeMigratedSessions(mgr.DB(), sessions, nil, task); err != nil {
		t.Fatalf("writeMigratedSessions: %v", err)
	}
	writeElapsed := time.Since(start)

	var sessionRows, bandRows, modeRows, uaRows int
	q := func(sql string, dst *int) {
		if err := mgr.ReadDB().QueryRow(sql).Scan(dst); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	q(`SELECT COUNT(*) FROM session`, &sessionRows)
	q(`SELECT COUNT(*) FROM session_band`, &bandRows)
	q(`SELECT COUNT(*) FROM session_mode`, &modeRows)
	q(`SELECT COUNT(*) FROM user_agent`, &uaRows)

	total := sessionRows + bandRows + modeRows + uaRows
	t.Logf("legacy: %d rows describing %d sessions", legacyRows, distinctSessions)
	t.Logf("migrated: session=%d session_band=%d session_mode=%d user_agent=%d (total %d rows, %.1fx fewer)",
		sessionRows, bandRows, modeRows, uaRows, total, float64(legacyRows)/float64(total))
	t.Logf("timing: read %v, write %v", readElapsed.Round(time.Millisecond), writeElapsed.Round(time.Millisecond))

	if sessionRows != distinctSessions {
		t.Errorf("session rows = %d, want %d (one per distinct user_session_id)", sessionRows, distinctSessions)
	}
	if bandRows == 0 || modeRows == 0 || uaRows == 0 {
		t.Errorf("child tables not populated: bands=%d modes=%d agents=%d", bandRows, modeRows, uaRows)
	}

	// Every session must have a usable lifetime.
	var bad int
	q(`SELECT COUNT(*) FROM session WHERE ended_at IS NULL OR ended_at < started_at OR started_at <= 0`, &bad)
	if bad != 0 {
		t.Errorf("%d sessions have an invalid start/end", bad)
	}

	// The whole point: the statistics become an indexed aggregate query.
	start = time.Now()
	var totalSessions, uniqueUsers, uniqueCountries int
	cutoff := time.Now().UTC().Add(-publicSessionStatsDays * 24 * time.Hour).Unix()
	if err := mgr.ReadDB().QueryRow(`
		SELECT COUNT(*), COUNT(DISTINCT client_ip), COUNT(DISTINCT country_code)
		FROM session WHERE ended_at >= ?`, cutoff,
	).Scan(&totalSessions, &uniqueUsers, &uniqueCountries); err != nil {
		t.Fatalf("aggregate query: %v", err)
	}
	t.Logf("aggregate over 28d: total_sessions=%d unique_users=%d unique_countries=%d in %v",
		totalSessions, uniqueUsers, uniqueCountries, time.Since(start).Round(time.Microsecond))
}

// TestSessionHistoryMigrationCollidesWithLiveSession covers a session that the
// live writer has already recorded by the time the migration reaches it.
//
// The migration writes in the background while the receiver serves listeners,
// and the kiwi and websdr session ids are derived from the client, so one that
// was live before a restart can reappear under the same id. The insert then does
// nothing, and the row id the band and mode rows need can no longer come from
// LastInsertId: it still holds the user_agent row interned a moment earlier,
// which either breaks their foreign key or files them against another session.
func TestSessionHistoryMigrationCollidesWithLiveSession(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	createLegacySessionsTable(t, mgr.DB())

	const liveID = "kiwi-1757000000-198.51.100.7"

	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	at := func(minutes int) time.Time { return base.Add(time.Duration(minutes) * time.Minute) }

	entry := func(id, ua string, bands, modes []string, created time.Time) SessionActivityEntry {
		return SessionActivityEntry{
			UserSessionID: id,
			ClientIP:      "198.51.100.7",
			SourceIP:      "203.0.113.9",
			SessionTypes:  []string{"audio"},
			Bands:         bands,
			Modes:         modes,
			UserAgent:     ua,
			Country:       "United Kingdom",
			CountryCode:   "GB",
			Protocol:      protocolFromUserSessionID(id),
			CreatedAt:     created,
			FirstSeen:     created,
		}
	}

	// Two ordinary sessions, then the one that comes back. Distinct user agents,
	// so each interns a fresh user_agent row ahead of its session insert.
	first := entry("11111111-1111-4111-8111-111111111111", "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0", []string{"20m"}, []string{"usb"}, at(0))
	second := entry("22222222-2222-4222-8222-222222222222", "Mozilla/5.0 (Macintosh) Safari/17.0", []string{"80m"}, []string{"am"}, at(1))
	live := entry(liveID, "kiwiclient/1.0", []string{"40m", "15m"}, []string{"cwu"}, at(2))

	insertSessionActivityRow(t, mgr.DB(), at(0), "snapshot", first)
	insertSessionActivityRow(t, mgr.DB(), at(1), "snapshot", first)
	insertSessionActivityRow(t, mgr.DB(), at(1), "snapshot", second)
	insertSessionActivityRow(t, mgr.DB(), at(2), "snapshot", live)

	// User agents the receiver has already seen, so the ids the migration interns
	// start above any session id and a stale LastInsertId cannot land on a real
	// session by luck.
	for i := 0; i < 5; i++ {
		if _, err := mgr.DB().Exec(`INSERT INTO user_agent (ua, browser, os) VALUES (?, '', '')`,
			fmt.Sprintf("seen-before-%d", i)); err != nil {
			t.Fatalf("seed user_agent: %v", err)
		}
	}

	// The live writer has already opened a row for the reconnected listener.
	if _, err := mgr.DB().Exec(`
		INSERT INTO session (user_session_id, started_at, last_seen, client_ip, protocol)
		VALUES (?, ?, ?, '198.51.100.7', 'kiwi')`,
		liveID, at(30).Unix(), at(30).Unix(),
	); err != nil {
		t.Fatalf("seed live session: %v", err)
	}
	var liveRowID int64
	if err := mgr.ReadDB().QueryRow(`SELECT id FROM session WHERE user_session_id = ?`, liveID).Scan(&liveRowID); err != nil {
		t.Fatalf("live session id: %v", err)
	}

	task := bgTasks.Start("session-history-migration-collision-test", BackgroundTaskOpts{Name: "test"})
	defer task.Complete("")

	sessions, err := readLegacySessions(mgr.ReadDB(), 4, task)
	if err != nil {
		t.Fatalf("readLegacySessions: %v", err)
	}
	if len(sessions) != 3 {
		t.Fatalf("reconstructed %d sessions, want 3", len(sessions))
	}
	if err := writeMigratedSessions(mgr.DB(), sessions, nil, task); err != nil {
		t.Fatalf("writeMigratedSessions: %v", err)
	}

	// The live row is the only one for that id, and it was left as the live
	// writer wrote it: still open, still starting when the listener reconnected.
	var rows int
	var startedAt int64
	var endedAt sql.NullInt64
	if err := mgr.ReadDB().QueryRow(
		`SELECT COUNT(*) FROM session WHERE user_session_id = ?`, liveID).Scan(&rows); err != nil {
		t.Fatalf("count live session: %v", err)
	}
	if rows != 1 {
		t.Errorf("session rows for %s = %d, want 1", liveID, rows)
	}
	if err := mgr.ReadDB().QueryRow(
		`SELECT started_at, ended_at FROM session WHERE id = ?`, liveRowID).Scan(&startedAt, &endedAt); err != nil {
		t.Fatalf("read live session: %v", err)
	}
	if startedAt != at(30).Unix() {
		t.Errorf("live session started_at = %d, want %d (migration must not rewrite a live row)", startedAt, at(30).Unix())
	}
	if endedAt.Valid {
		t.Errorf("live session ended_at = %d, want NULL (the session is still open)", endedAt.Int64)
	}

	// Every band and mode belongs to the session that visited it.
	wantBands := map[string][]string{
		first.UserSessionID:  {"20m"},
		second.UserSessionID: {"80m"},
		liveID:               {"15m", "40m"},
	}
	for userSessionID, want := range wantBands {
		got := sessionBands(t, mgr, userSessionID)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("bands for %s = %v, want %v", userSessionID, got, want)
		}
	}

	var orphans int
	if err := mgr.ReadDB().QueryRow(`
		SELECT COUNT(*) FROM session_band b LEFT JOIN session s ON s.id = b.session_id
		WHERE s.id IS NULL`).Scan(&orphans); err != nil {
		t.Fatalf("orphan check: %v", err)
	}
	if orphans != 0 {
		t.Errorf("%d session_band rows point at a session that does not exist", orphans)
	}
}

// sessionBands returns the bands recorded against a session, sorted.
func sessionBands(t *testing.T, mgr *DBManager, userSessionID string) []string {
	t.Helper()
	rows, err := mgr.ReadDB().Query(`
		SELECT b.band FROM session_band b
		JOIN session s ON s.id = b.session_id
		WHERE s.user_session_id = ? ORDER BY b.band`, userSessionID)
	if err != nil {
		t.Fatalf("bands for %s: %v", userSessionID, err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var band string
		if err := rows.Scan(&band); err != nil {
			t.Fatalf("scan band: %v", err)
		}
		out = append(out, band)
	}
	return out
}

// TestSessionHistoryMigrationGate covers the decision to run at all. A run that
// fails part way leaves the legacy table in place and `session` half populated,
// so the gate has to be the legacy table, not an empty `session`.
func TestSessionHistoryMigrationGate(t *testing.T) {
	mgr := newSessionStatsTestDB(t)

	if rows, present := legacySessionRows(mgr.ReadDB()); present || rows != 0 {
		t.Errorf("fresh database: rows=%d present=%v, want 0/false", rows, present)
	}

	createLegacySessionsTable(t, mgr.DB())
	if rows, present := legacySessionRows(mgr.ReadDB()); !present || rows != 0 {
		t.Errorf("empty legacy table: rows=%d present=%v, want 0/true", rows, present)
	}

	// A previous attempt converted some of the log before failing, and listeners
	// have been recorded since. Neither means the conversion finished.
	insertSessionActivityRow(t, mgr.DB(), time.Now().UTC(), "snapshot", SessionActivityEntry{
		UserSessionID: "33333333-3333-4333-8333-333333333333",
		ClientIP:      "198.51.100.3",
		SessionTypes:  []string{"audio"},
		Bands:         []string{"20m"},
		Modes:         []string{"usb"},
		Protocol:      "native",
	})
	if _, err := mgr.DB().Exec(`
		INSERT INTO session (user_session_id, started_at, last_seen)
		VALUES ('44444444-4444-4444-8444-444444444444', 1, 2)`); err != nil {
		t.Fatalf("seed session row: %v", err)
	}
	if rows, present := legacySessionRows(mgr.ReadDB()); !present || rows != 1 {
		t.Errorf("partly converted: rows=%d present=%v, want 1/true", rows, present)
	}

	// Only a completed conversion drops the table, and then it stays dropped.
	dropLegacySessionsTable(mgr.DB())
	if rows, present := legacySessionRows(mgr.ReadDB()); present || rows != 0 {
		t.Errorf("after drop: rows=%d present=%v, want 0/false", rows, present)
	}
}

// TestSessionHistoryMigrationRerunIsIdempotent covers the retry the gate now
// allows: the second pass must converge on the same rows rather than duplicating
// or re-attaching them.
func TestSessionHistoryMigrationRerunIsIdempotent(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	createLegacySessionsTable(t, mgr.DB())

	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	entry := SessionActivityEntry{
		UserSessionID: "55555555-5555-4555-8555-555555555555",
		ClientIP:      "198.51.100.5",
		SessionTypes:  []string{"audio", "spectrum"},
		Bands:         []string{"20m", "40m"},
		Modes:         []string{"usb"},
		UserAgent:     "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0",
		Country:       "United Kingdom",
		CountryCode:   "GB",
		Protocol:      "native",
		CreatedAt:     base,
		FirstSeen:     base,
	}
	insertSessionActivityRow(t, mgr.DB(), base, "snapshot", entry)
	insertSessionActivityRow(t, mgr.DB(), base.Add(5*time.Minute), "snapshot", entry)

	task := bgTasks.Start("session-history-migration-rerun-test", BackgroundTaskOpts{Name: "test"})
	defer task.Complete("")

	counts := func() (sessions, bands, modes, agents int) {
		t.Helper()
		q := func(query string, dst *int) {
			if err := mgr.ReadDB().QueryRow(query).Scan(dst); err != nil {
				t.Fatalf("%s: %v", query, err)
			}
		}
		q(`SELECT COUNT(*) FROM session`, &sessions)
		q(`SELECT COUNT(*) FROM session_band`, &bands)
		q(`SELECT COUNT(*) FROM session_mode`, &modes)
		q(`SELECT COUNT(*) FROM user_agent`, &agents)
		return
	}

	var first [4]int
	for pass := 1; pass <= 2; pass++ {
		sessions, err := readLegacySessions(mgr.ReadDB(), 2, task)
		if err != nil {
			t.Fatalf("pass %d readLegacySessions: %v", pass, err)
		}
		if err := writeMigratedSessions(mgr.DB(), sessions, nil, task); err != nil {
			t.Fatalf("pass %d writeMigratedSessions: %v", pass, err)
		}

		s, b, m, a := counts()
		if pass == 1 {
			first = [4]int{s, b, m, a}
			if s != 1 || b != 2 || m != 1 || a != 1 {
				t.Fatalf("pass 1 wrote session=%d band=%d mode=%d agent=%d, want 1/2/1/1", s, b, m, a)
			}
			continue
		}
		if got := [4]int{s, b, m, a}; got != first {
			t.Errorf("pass 2 changed the row counts: %v, want %v", got, first)
		}
	}

	if got, want := sessionBands(t, mgr, entry.UserSessionID), []string{"20m", "40m"}; !reflect.DeepEqual(got, want) {
		t.Errorf("bands = %v, want %v", got, want)
	}
}

// TestSessionHistoryMigrationResumesAfterPartialRun covers the state a receiver
// is left in when a batch fails part way: some sessions converted and committed,
// the rest missing, live sessions recorded since, and the legacy log still on
// disk because it is only dropped on success. The next startup must fill the gap
// without touching what is already there.
func TestSessionHistoryMigrationResumesAfterPartialRun(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	createLegacySessionsTable(t, mgr.DB())

	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	at := func(minutes int) time.Time { return base.Add(time.Duration(minutes) * time.Minute) }

	historical := []SessionActivityEntry{}
	for i := 0; i < 6; i++ {
		historical = append(historical, SessionActivityEntry{
			UserSessionID: fmt.Sprintf("6666666%d-6666-4666-8666-666666666666", i),
			ClientIP:      fmt.Sprintf("198.51.100.%d", i),
			SessionTypes:  []string{"audio"},
			Bands:         []string{fmt.Sprintf("%dm", 20+i)},
			Modes:         []string{"usb"},
			UserAgent:     fmt.Sprintf("Mozilla/5.0 (X11; Linux x86_64) Firefox/1%d.0", i),
			Protocol:      "native",
			CreatedAt:     at(i),
			FirstSeen:     at(i),
		})
		insertSessionActivityRow(t, mgr.DB(), at(i), "snapshot", historical[i])
	}

	task := bgTasks.Start("session-history-migration-resume-test", BackgroundTaskOpts{Name: "test"})
	defer task.Complete("")

	all, err := readLegacySessions(mgr.ReadDB(), len(historical), task)
	if err != nil {
		t.Fatalf("readLegacySessions: %v", err)
	}
	if len(all) != len(historical) {
		t.Fatalf("reconstructed %d sessions, want %d", len(all), len(historical))
	}

	// The run that failed: the first three sessions committed, then it stopped.
	if err := writeMigratedSessions(mgr.DB(), all[:3], nil, task); err != nil {
		t.Fatalf("partial run: %v", err)
	}

	// The receiver kept serving, so the live writer has added sessions of its own.
	if _, err := mgr.DB().Exec(`
		INSERT INTO session (user_session_id, started_at, last_seen, client_ip)
		VALUES ('77777777-7777-4777-8777-777777777777', ?, ?, '198.51.100.99')`,
		at(600).Unix(), at(600).Unix(),
	); err != nil {
		t.Fatalf("seed live session: %v", err)
	}

	// The legacy log is untouched, so the next startup converts it again.
	if rows, present := legacySessionRows(mgr.ReadDB()); !present || rows != len(historical) {
		t.Fatalf("legacy log after a failed run: rows=%d present=%v, want %d/true", rows, present, len(historical))
	}
	resumed, err := readLegacySessions(mgr.ReadDB(), len(historical), task)
	if err != nil {
		t.Fatalf("resumed readLegacySessions: %v", err)
	}
	if err := writeMigratedSessions(mgr.DB(), resumed, nil, task); err != nil {
		t.Fatalf("resumed run: %v", err)
	}

	// Every historical session is present exactly once, with its own band, and
	// the live session is still there and still open.
	var sessionRows, bandRows int
	if err := mgr.ReadDB().QueryRow(`SELECT COUNT(*) FROM session`).Scan(&sessionRows); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if err := mgr.ReadDB().QueryRow(`SELECT COUNT(*) FROM session_band`).Scan(&bandRows); err != nil {
		t.Fatalf("count bands: %v", err)
	}
	if want := len(historical) + 1; sessionRows != want {
		t.Errorf("session rows = %d, want %d (one per session, no duplicates)", sessionRows, want)
	}
	if bandRows != len(historical) {
		t.Errorf("session_band rows = %d, want %d", bandRows, len(historical))
	}
	for i, entry := range historical {
		if got, want := sessionBands(t, mgr, entry.UserSessionID), []string{fmt.Sprintf("%dm", 20+i)}; !reflect.DeepEqual(got, want) {
			t.Errorf("bands for %s = %v, want %v", entry.UserSessionID, got, want)
		}
	}

	var liveOpen int
	if err := mgr.ReadDB().QueryRow(`
		SELECT COUNT(*) FROM session
		WHERE user_session_id = '77777777-7777-4777-8777-777777777777' AND ended_at IS NULL`).Scan(&liveOpen); err != nil {
		t.Fatalf("live session check: %v", err)
	}
	if liveOpen != 1 {
		t.Errorf("live session rows still open = %d, want 1", liveOpen)
	}
}
