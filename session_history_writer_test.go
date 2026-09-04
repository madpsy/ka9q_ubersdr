package main

import (
	"testing"
	"time"
)

// The point of the schema: a session is one row that gets updated, not a growing
// pile of rows. These tests pin that down, because it is exactly what regressed
// into the old design — every event re-serialising the whole active set.

func countRows(t *testing.T, mgr *DBManager, query string) int {
	t.Helper()
	var n int
	if err := mgr.ReadDB().QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func TestSessionIsOneRowUpdatedInPlace(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	writer := newSessionHistoryWriter(mgr.DB(), nil)

	base := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	entry := SessionActivityEntry{
		UserSessionID: "user-1",
		ClientIP:      "198.51.100.7",
		AuthMethod:    "",
		SessionTypes:  []string{"audio"},
		Bands:         []string{"20m"},
		Modes:         []string{"usb"},
		UserAgent:     "Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0 Safari/537.36",
		Country:       "United Kingdom",
		CountryCode:   "GB",
		Protocol:      "native",
		CreatedAt:     base,
		FirstSeen:     base,
	}

	// Session starts.
	writer.recordActive(entry, base.Unix())

	// The listener retunes to 40m and switches mode, then adds a spectrum view.
	// Under the old design each of these produced another copy of every active
	// session; here they refine the row that already exists.
	retuned := entry
	retuned.Bands = []string{"20m", "40m"}
	retuned.Modes = []string{"usb", "lsb"}
	retuned.SessionTypes = []string{"audio", "spectrum"}
	writer.recordActive(retuned, base.Add(5*time.Minute).Unix())

	// Twenty heartbeats, as a session lasting over an hour and a half would see.
	for i := 0; i < 20; i++ {
		ts := base.Add(time.Duration(10+i*5) * time.Minute)
		writer.touchOpenSessions(ts.Unix())
		writer.recordActive(retuned, ts.Unix())
	}

	// Session ends, carrying one last band.
	endedAt := base.Add(2 * time.Hour)
	writer.closeSession("user-1", map[string]bool{"15m": true}, map[string]bool{"cwu": true}, endedAt.Unix())

	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session`); n != 1 {
		t.Errorf("session rows = %d, want 1 — a session must be one row updated in place", n)
	}
	if n := countRows(t, mgr, `SELECT COUNT(*) FROM user_agent`); n != 1 {
		t.Errorf("user_agent rows = %d, want 1 — the agent is interned, not repeated", n)
	}

	// One row per distinct band and mode, regardless of how often they were seen.
	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session_band`); n != 3 {
		t.Errorf("session_band rows = %d, want 3 (20m, 40m, 15m)", n)
	}
	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session_mode`); n != 3 {
		t.Errorf("session_mode rows = %d, want 3 (usb, lsb, cwu)", n)
	}

	var startedAt, endedAtStored int64
	var hasAudio, hasSpectrum bool
	if err := mgr.ReadDB().QueryRow(
		`SELECT started_at, ended_at, has_audio, has_spectrum FROM session WHERE user_session_id = ?`, "user-1",
	).Scan(&startedAt, &endedAtStored, &hasAudio, &hasSpectrum); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if startedAt != base.Unix() {
		t.Errorf("started_at = %d, want %d — the start must survive every update", startedAt, base.Unix())
	}
	if endedAtStored != endedAt.Unix() {
		t.Errorf("ended_at = %d, want %d", endedAtStored, endedAt.Unix())
	}
	if !hasAudio || !hasSpectrum {
		t.Errorf("session types = audio:%v spectrum:%v, want both — the flags accumulate", hasAudio, hasSpectrum)
	}
}

// Row count must track the number of sessions, not the number of events.
func TestSessionRowsTrackSessionsNotEvents(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	writer := newSessionHistoryWriter(mgr.DB(), nil)

	base := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	const sessions, eventsPerSession = 5, 50

	for i := 0; i < sessions; i++ {
		id := string(rune('a' + i))
		for e := 0; e < eventsPerSession; e++ {
			writer.recordActive(SessionActivityEntry{
				UserSessionID: "user-" + id,
				ClientIP:      "198.51.100." + id,
				SessionTypes:  []string{"audio"},
				Bands:         []string{"20m"},
				Modes:         []string{"usb"},
				CreatedAt:     base,
				FirstSeen:     base,
			}, base.Add(time.Duration(e)*time.Minute).Unix())
		}
	}

	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session`); n != sessions {
		t.Errorf("session rows = %d after %d events across %d sessions, want %d",
			n, sessions*eventsPerSession, sessions, sessions)
	}
	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session_band`); n != sessions {
		t.Errorf("session_band rows = %d, want %d (one band each, however often it is re-reported)", n, sessions)
	}
}

// A session left open by a crash is closed at the time it was last seen, so it
// still counts and still has a duration.
func TestOpenSessionsSweptOnStartup(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	base := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

	writer := newSessionHistoryWriter(mgr.DB(), nil)
	writer.recordActive(SessionActivityEntry{
		UserSessionID: "user-crashed",
		ClientIP:      "198.51.100.9",
		SessionTypes:  []string{"audio"},
		CreatedAt:     base,
		FirstSeen:     base,
	}, base.Unix())
	lastSeen := base.Add(30 * time.Minute)
	writer.touchOpenSessions(lastSeen.Unix())

	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session WHERE ended_at IS NULL`); n != 1 {
		t.Fatalf("open sessions = %d, want 1 before the sweep", n)
	}

	// Next process start.
	newSessionHistoryWriter(mgr.DB(), nil).sweepOpenSessions()

	if n := countRows(t, mgr, `SELECT COUNT(*) FROM session WHERE ended_at IS NULL`); n != 0 {
		t.Errorf("open sessions = %d after the sweep, want 0", n)
	}
	var endedAt int64
	if err := mgr.ReadDB().QueryRow(`SELECT ended_at FROM session WHERE user_session_id = ?`, "user-crashed").Scan(&endedAt); err != nil {
		t.Fatalf("read swept session: %v", err)
	}
	if endedAt != lastSeen.Unix() {
		t.Errorf("ended_at = %d, want %d (the last time it was seen)", endedAt, lastSeen.Unix())
	}
}
