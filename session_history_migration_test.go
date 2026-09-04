package main

import (
	"os"
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
