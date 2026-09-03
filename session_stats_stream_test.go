package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

// The public session stats endpoint used to load the whole retention window into
// memory before folding it (read all rows -> filter -> convert to events ->
// filter -> aggregate), which on a busy receiver was gigabytes of live objects
// per request and enough to OOM the process. The fold now streams straight out
// of SQLite. These tests pin the streaming path to the batch pipeline it
// replaced, since the sessionisation rules are subtle: a session's end is
// inferred from its absence from a snapshot, so anything that changes which
// snapshots are seen changes the durations.

// insertSessionActivityRow writes one row of the sessions table.
func insertSessionActivityRow(t *testing.T, db *sql.DB, ts time.Time, eventType string, entry SessionActivityEntry) {
	t.Helper()

	sessionTypes, _ := json.Marshal(entry.SessionTypes)
	bands, _ := json.Marshal(entry.Bands)
	modes, _ := json.Marshal(entry.Modes)

	var createdAt, firstSeen int64
	if !entry.CreatedAt.IsZero() {
		createdAt = entry.CreatedAt.Unix()
	}
	if !entry.FirstSeen.IsZero() {
		firstSeen = entry.FirstSeen.Unix()
	}

	if _, err := db.Exec(`
		INSERT INTO sessions
			(snapshot_ts, event_type, user_session_id, client_ip, source_ip, auth_method,
			 session_types, bands, modes, created_at, first_seen, user_agent, country,
			 country_code, protocol)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts.Unix(), eventType, entry.UserSessionID, entry.ClientIP, entry.SourceIP,
		entry.AuthMethod, string(sessionTypes), string(bands), string(modes),
		createdAt, firstSeen, entry.UserAgent, entry.Country, entry.CountryCode,
		entry.Protocol,
	); err != nil {
		t.Fatalf("insert sessions row: %v", err)
	}
}

// seedSessionActivityFixture writes a window exercising every path the fold has
// to get right, and returns the window bounds.
func seedSessionActivityFixture(t *testing.T, db *sql.DB) (time.Time, time.Time) {
	t.Helper()

	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	at := func(minutes int) time.Time { return base.Add(time.Duration(minutes) * time.Minute) }

	regular := func(id, ua, country, code string, bands, modes []string, created time.Time) SessionActivityEntry {
		return SessionActivityEntry{
			UserSessionID: id,
			ClientIP:      "198.51.100." + id[len(id)-1:],
			SourceIP:      "203.0.113.9",
			AuthMethod:    "",
			SessionTypes:  []string{"audio"},
			Bands:         bands,
			Modes:         modes,
			UserAgent:     ua,
			Country:       country,
			CountryCode:   code,
			Protocol:      "native",
			CreatedAt:     created,
			FirstSeen:     created,
		}
	}

	chrome := "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
	uber := "UberSDR/1.0 (Windows NT 10.0; Win64; x64)"

	// A starts here and accumulates a second band/mode at the next snapshot.
	sessionA := regular("user-a", chrome, "United Kingdom", "GB", []string{"20m"}, []string{"usb"}, at(-5))
	// B and C are filtered out by auth method and must never be tracked.
	sessionB := regular("user-b", chrome, "France", "FR", []string{"40m"}, []string{"lsb"}, at(-5))
	sessionB.AuthMethod = "password"
	sessionC := regular("user-c", chrome, "Spain", "ES", []string{"80m"}, []string{"am"}, at(-5))
	sessionC.AuthMethod = "ip_bypass"

	insertSessionActivityRow(t, db, at(0), "snapshot", sessionA)
	insertSessionActivityRow(t, db, at(0), "snapshot", sessionB)
	insertSessionActivityRow(t, db, at(0), "snapshot", sessionC)

	sessionAWider := sessionA
	sessionAWider.Bands = []string{"20m", "15m"}
	sessionAWider.Modes = []string{"usb", "cwu"}
	insertSessionActivityRow(t, db, at(5), "snapshot", sessionAWider)
	insertSessionActivityRow(t, db, at(5), "snapshot", sessionB)

	// A snapshot holding nothing but filtered-out sessions. The batch pipeline
	// drops it entirely rather than treating it as an empty snapshot, so A must
	// NOT be ended here.
	insertSessionActivityRow(t, db, at(10), "snapshot", sessionB)

	// D appears and A drops out, so A ends by absence at this snapshot.
	sessionD := regular("user-d", uber, "United States", "US", []string{"10m"}, []string{"fm"}, at(8))
	insertSessionActivityRow(t, db, at(15), "snapshot", sessionD)

	// D ends explicitly, with final bands and modes carried on the event.
	sessionDFinal := sessionD
	sessionDFinal.Bands = []string{"10m", "6m"}
	sessionDFinal.Modes = []string{"fm", "nfm"}
	insertSessionActivityRow(t, db, at(20), "session_destroyed", sessionDFinal)

	// E is still active when the window ends and must be dropped, not counted.
	sessionE := regular("user-e", chrome, "Germany", "DE", []string{"30m"}, []string{"sam"}, at(23))
	insertSessionActivityRow(t, db, at(25), "snapshot", sessionE)

	return base.Add(-time.Hour), base.Add(time.Hour)
}

// statsViaBatchPipeline reproduces the pipeline the endpoint used before it
// streamed: load the whole window, filter, sessionise, keep end events, fold.
func statsViaBatchPipeline(t *testing.T, readDB *sql.DB, startTime, endTime time.Time) map[string]interface{} {
	t.Helper()

	logs, err := ReadActivityLogsFromDB(readDB, startTime, endTime)
	if err != nil {
		t.Fatalf("ReadActivityLogsFromDB: %v", err)
	}
	logs = FilterSessionsByAuthMethod(logs, []string{"regular"})
	endEvents := filterEventsByType(convertLogsToEvents(logs), []string{"session_end"})

	return calculatePublicSessionStats(func(emit func(SessionEvent)) {
		for _, event := range endEvents {
			emit(event)
		}
	}, startTime, endTime, nil)
}

// canonicaliseStats sorts every ranked list in a stats map by count then label.
//
// The endpoint builds these lists by ranging Go maps and sorting with the
// unstable sort.Slice, so the order of entries with equal counts is already
// undefined from one call to the next -- independent of how the events were fed
// in. Comparing pipelines therefore has to compare sets, not orderings.
func canonicaliseStats(stats map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(stats))
	for key, value := range stats {
		list, ok := value.([]map[string]interface{})
		if !ok {
			out[key] = value
			continue
		}
		sorted := append([]map[string]interface{}(nil), list...)
		sort.SliceStable(sorted, func(i, j int) bool {
			ci, cj := statsEntryCount(sorted[i]), statsEntryCount(sorted[j])
			if ci != cj {
				return ci > cj
			}
			return statsEntryLabel(sorted[i]) < statsEntryLabel(sorted[j])
		})
		out[key] = sorted
	}
	return out
}

func statsEntryCount(entry map[string]interface{}) int {
	for _, key := range []string{"sessions", "count"} {
		if n, ok := entry[key].(int); ok {
			return n
		}
	}
	return 0
}

func statsEntryLabel(entry map[string]interface{}) string {
	for _, key := range []string{"name", "range", "country"} {
		if s, ok := entry[key].(string); ok {
			return s
		}
	}
	return fmt.Sprint(entry)
}

func newSessionStatsTestDB(t *testing.T) *DBManager {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	return mgr
}

func TestPublicSessionStatsStreamingMatchesBatchPipeline(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	startTime, endTime := seedSessionActivityFixture(t, mgr.DB())

	want := statsViaBatchPipeline(t, mgr.ReadDB(), startTime, endTime)

	response, err := computePublicSessionStatsForWindow(mgr.ReadDB(), nil, startTime, endTime)
	if err != nil {
		t.Fatalf("computePublicSessionStatsForWindow: %v", err)
	}
	got, ok := response["stats"].(map[string]interface{})
	if !ok {
		t.Fatalf("stats key missing or wrong type: %#v", response["stats"])
	}

	if wantCanon, gotCanon := canonicaliseStats(want), canonicaliseStats(got); !reflect.DeepEqual(wantCanon, gotCanon) {
		t.Errorf("streaming fold differs from batch pipeline\n batch: %#v\n\n stream: %#v", wantCanon, gotCanon)
	}

	// Guard the fixture itself: if it stopped producing completed sessions the
	// comparison above would pass on two empty results.
	if total, _ := got["total_sessions"].(int); total != 2 {
		t.Errorf("total_sessions = %v, want 2 (A ends by absence, D by session_destroyed; E is still active)", got["total_sessions"])
	}
}

func TestStreamActivityLogsMatchesBatchRead(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	startTime, endTime := seedSessionActivityFixture(t, mgr.DB())

	want, err := ReadActivityLogsFromDB(mgr.ReadDB(), startTime, endTime)
	if err != nil {
		t.Fatalf("ReadActivityLogsFromDB: %v", err)
	}

	var got []SessionActivityLog
	if err := StreamActivityLogsFromDB(context.Background(), mgr.ReadDB(), startTime, endTime,
		func(entry SessionActivityLog) error {
			got = append(got, entry)
			return nil
		}); err != nil {
		t.Fatalf("StreamActivityLogsFromDB: %v", err)
	}

	if !reflect.DeepEqual(want, got) {
		t.Errorf("streamed logs differ from batch read\n want %d entries: %#v\n got %d entries: %#v",
			len(want), want, len(got), got)
	}
	if len(got) == 0 {
		t.Fatal("fixture produced no activity logs")
	}
}

// A caller that stops early must not be ignored, and must not leave the query open.
func TestStreamActivityLogsPropagatesCallbackError(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	startTime, endTime := seedSessionActivityFixture(t, mgr.DB())

	stop := context.Canceled
	calls := 0
	err := StreamActivityLogsFromDB(context.Background(), mgr.ReadDB(), startTime, endTime,
		func(SessionActivityLog) error {
			calls++
			return stop
		})
	if err != stop {
		t.Fatalf("error = %v, want %v", err, stop)
	}
	if calls != 1 {
		t.Errorf("callback called %d times, want 1 (streaming should stop at the first error)", calls)
	}
}

func TestPublicSessionStatsDisabledByConfig(t *testing.T) {
	enabled := ServerConfig{}
	if !enabled.PublicSessionStatsIsEnabled() {
		t.Error("absent key should leave the endpoint enabled")
	}

	on := true
	off := false
	if !(&ServerConfig{PublicSessionStatsEnabled: &on}).PublicSessionStatsIsEnabled() {
		t.Error("explicit true should enable the endpoint")
	}
	if (&ServerConfig{PublicSessionStatsEnabled: &off}).PublicSessionStatsIsEnabled() {
		t.Error("explicit false should disable the endpoint")
	}
}
