package main

import (
	"bytes"
	"log"
	"os"
	"strings"
	"testing"
	"time"
)

// TestPruneAllMatchesSchema runs every retention rule against a freshly created
// schema. A rule naming a table or timestamp column that does not exist fails
// only in the log, once per cycle, while the table grows forever — which is how
// the legacy `sessions` table (snapshot_ts, no ts) went unpruned in 0.1.61.
func TestPruneAllMatchesSchema(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	db := mgr.DB()

	now := time.Now().UTC().Unix()
	old := now - 60*86400
	// An ended session past retention, one ended recently, and one still open.
	for _, s := range []struct {
		id      string
		started int64
		ended   interface{}
	}{
		{"old", old, old + 600},
		{"recent", now - 3600, now - 600},
		{"open", old, nil},
	} {
		res, err := db.Exec(`INSERT INTO session (user_session_id, started_at, ended_at, last_seen)
			VALUES (?, ?, ?, ?)`, s.id, s.started, s.ended, now)
		if err != nil {
			t.Fatalf("insert session %s: %v", s.id, err)
		}
		id, _ := res.LastInsertId()
		if _, err := db.Exec(`INSERT INTO session_band (session_id, band) VALUES (?, '20m')`, id); err != nil {
			t.Fatalf("insert session_band %s: %v", s.id, err)
		}
	}

	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	mgr.pruneAll(RetentionConfig{
		SessionsDays:              30,
		SpotsDays:                 30,
		CWSpotsDays:               30,
		ChatDays:                  30,
		NoiseFloorDays:            30,
		SpaceWeatherDays:          30,
		StatsDays:                 30,
		DecoderMetricsSummaryDays: 30,
		CWMetricsSummaryDays:      30,
		NotificationLogDays:       30,
	})
	log.SetOutput(os.Stderr)

	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "retention prune") && !strings.Contains(line, "deleted") {
			t.Errorf("retention rule failed: %s", line)
		}
	}

	rows, err := db.Query(`SELECT user_session_id FROM session ORDER BY user_session_id`)
	if err != nil {
		t.Fatalf("query session: %v", err)
	}
	var kept []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		kept = append(kept, id)
	}
	rows.Close()
	if got := strings.Join(kept, ","); got != "open,recent" {
		t.Errorf("sessions kept = %q, want \"open,recent\"", got)
	}

	var bands int
	if err := db.QueryRow(`SELECT COUNT(*) FROM session_band`).Scan(&bands); err != nil {
		t.Fatalf("count session_band: %v", err)
	}
	if bands != 2 {
		t.Errorf("session_band rows = %d, want 2 (the pruned session's band should cascade)", bands)
	}
}
