package main

import (
	"math"
	"os"
	"testing"
	"time"
)

// End-to-end check of the schema change against a real database: compute the
// public statistics the old way (replaying the legacy snapshot log), migrate the
// data into the normalised session tables, then compute them again with the
// aggregate queries the endpoint now uses, and compare.
//
// Point UBERSDR_SESSIONS_DB at a copy of a live receiver's database. Skipped when
// it is unset, so it never runs in CI.

// relativeDelta returns |a-b| / max(a,b), or 0 when both are zero.
func relativeDelta(a, b int) float64 {
	if a == 0 && b == 0 {
		return 0
	}
	larger := a
	if b > larger {
		larger = b
	}
	return math.Abs(float64(a-b)) / float64(larger)
}

func intStat(t *testing.T, stats map[string]interface{}, key string) int {
	t.Helper()
	n, ok := stats[key].(int)
	if !ok {
		t.Fatalf("stat %q missing or not an int: %#v", key, stats[key])
	}
	return n
}

func TestPublicSessionStatsMatchAfterMigration(t *testing.T) {
	if os.Getenv("UBERSDR_SESSIONS_DB") == "" {
		t.Skip("set UBERSDR_SESSIONS_DB to a copy of a real receiver database")
	}

	mgr := newSessionStatsTestDB(t)
	if !loadLegacySessions(t, mgr) {
		t.Skip("no legacy sessions to migrate")
	}

	var newest int64
	if err := mgr.ReadDB().QueryRow(`SELECT MAX(snapshot_ts) FROM sessions`).Scan(&newest); err != nil {
		t.Fatalf("read newest snapshot: %v", err)
	}
	endTime := time.Unix(newest, 0).UTC()
	startTime := endTime.Add(-publicSessionStatsDays * 24 * time.Hour)

	// Before: the fold that replayed the snapshot log.
	foldStart := time.Now()
	legacyResponse, err := computePublicSessionStatsForWindow(mgr.ReadDB(), nil, startTime, endTime)
	if err != nil {
		t.Fatalf("legacy fold: %v", err)
	}
	foldElapsed := time.Since(foldStart)
	legacy := legacyResponse["stats"].(map[string]interface{})

	// Migrate.
	task := bgTasks.Start("session-history-migration-compare", BackgroundTaskOpts{Name: "test"})
	records, err := readLegacySessions(mgr.ReadDB(), 0, task)
	if err != nil {
		t.Fatalf("readLegacySessions: %v", err)
	}
	if err := writeMigratedSessions(mgr.DB(), records, nil, task); err != nil {
		t.Fatalf("writeMigratedSessions: %v", err)
	}

	// After: aggregate queries over the session tables.
	sqlStart := time.Now()
	migrated, err := PublicSessionStatsFromDB(mgr.ReadDB(), startTime, endTime)
	if err != nil {
		t.Fatalf("PublicSessionStatsFromDB: %v", err)
	}
	sqlElapsed := time.Since(sqlStart)

	t.Logf("timing: legacy fold %v, aggregate queries %v (%.0fx faster)",
		foldElapsed.Round(time.Millisecond), sqlElapsed.Round(time.Microsecond),
		float64(foldElapsed)/float64(sqlElapsed))

	for _, key := range []string{"total_sessions", "unique_users", "unique_countries"} {
		before, after := intStat(t, legacy, key), intStat(t, migrated, key)
		delta := relativeDelta(before, after)
		t.Logf("%-16s legacy=%-7d migrated=%-7d delta=%.1f%%", key, before, after, delta*100)

		// The two disagree slightly by construction. The fold ended a session at
		// the first snapshot it was missing from; the migration ends it at the
		// last snapshot it was seen in, up to one snapshot interval earlier. That
		// moves a few sessions across the window boundary. Anything beyond a few
		// percent would mean sessions are being lost or duplicated.
		if delta > 0.05 {
			t.Errorf("%s moved by %.1f%% across the migration (legacy %d, migrated %d)",
				key, delta*100, before, after)
		}
	}

	// The ranked lists should describe the same receiver.
	for _, key := range []string{"top_bands", "top_modes", "top_browsers", "top_operating_systems"} {
		before, _ := legacy[key].([]map[string]interface{})
		after, _ := migrated[key].([]map[string]interface{})
		if len(before) == 0 || len(after) == 0 {
			t.Errorf("%s empty on one side: legacy=%d migrated=%d", key, len(before), len(after))
			continue
		}
		if before[0]["name"] != after[0]["name"] {
			t.Errorf("%s top entry differs: legacy %v, migrated %v", key, before[0], after[0])
		}
	}

	// Averages must be divided by the span actually covered by data. The legacy
	// fold always divided by the nominal window, which understated every young
	// receiver; this only checks the new side is populated and finite.
	hourly, ok := migrated["avg_hourly_activity"].([]float64)
	if !ok || len(hourly) != 24 {
		t.Fatalf("avg_hourly_activity malformed: %#v", migrated["avg_hourly_activity"])
	}
	for hour, value := range hourly {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			t.Errorf("avg_hourly_activity[%d] = %v", hour, value)
		}
	}
}
