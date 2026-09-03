package main

import (
	"context"
	"database/sql"
	"fmt"
	"runtime"
	"testing"
	"time"
)

// Peak-memory comparison between the batch pipeline the public session stats
// endpoint used to run and the streaming fold that replaced it.
//
// Skipped under -short: it seeds a production-sized activity window (~900k rows)
// and the point of the test is the memory profile, not a correctness assertion.

type sessionStatsFixtureScale struct {
	concurrentSessions int           // sessions present in each snapshot
	snapshotInterval   time.Duration // server.session_activity_log_interval_sec
	window             time.Duration // reporting window
	sessionLifetime    time.Duration // how long a session stays in the snapshots
}

// productionScale mirrors the receiver that was being OOM-killed: ~115 concurrent
// sessions, snapshots every 5 minutes, a 28-day window.
var productionScale = sessionStatsFixtureScale{
	concurrentSessions: 115,
	snapshotInterval:   5 * time.Minute,
	window:             28 * 24 * time.Hour,
	sessionLifetime:    20 * time.Minute,
}

// seedActivityWindow writes a synthetic activity window and reports the row count.
// Sessions turn over on sessionLifetime so the window contains realistic numbers
// of distinct users, IPs and user agents rather than one long-lived set.
func seedActivityWindow(t *testing.T, db *sql.DB, scale sessionStatsFixtureScale) (time.Time, time.Time, int) {
	t.Helper()

	endTime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	startTime := endTime.Add(-scale.window)

	userAgents := []string{
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
		"UberSDR/1.0 (Windows NT 10.0; Win64; x64)",
	}
	countries := []struct{ name, code string }{
		{"United Kingdom", "GB"}, {"United States", "US"}, {"Germany", "DE"},
		{"Japan", "JP"}, {"Australia", "AU"}, {"Brazil", "BR"},
	}
	bands := []string{"160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"}
	modes := []string{"usb", "lsb", "cwu", "cwl", "am", "fm", "sam", "nfm"}

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	stmt, err := tx.Prepare(`
		INSERT INTO sessions
			(snapshot_ts, event_type, user_session_id, client_ip, source_ip, auth_method,
			 session_types, bands, modes, created_at, first_seen, user_agent, country,
			 country_code, protocol)
		VALUES (?, 'snapshot', ?, ?, ?, '', '["audio"]', ?, ?, ?, ?, ?, ?, ?, 'native')`)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	rows := 0
	generation := 0
	for ts := startTime; ts.Before(endTime); ts = ts.Add(scale.snapshotInterval) {
		// A whole cohort of sessions retires and is replaced every sessionLifetime,
		// which is what makes a session "end" (it stops appearing in snapshots).
		generation = int(ts.Sub(startTime) / scale.sessionLifetime)

		for slot := 0; slot < scale.concurrentSessions; slot++ {
			id := fmt.Sprintf("user-%d-%d", generation, slot)
			created := startTime.Add(time.Duration(generation) * scale.sessionLifetime)
			country := countries[(generation+slot)%len(countries)]

			bandJSON := fmt.Sprintf(`["%s","%s"]`, bands[slot%len(bands)], bands[(slot+3)%len(bands)])
			modeJSON := fmt.Sprintf(`["%s"]`, modes[slot%len(modes)])

			if _, err := stmt.Exec(
				ts.Unix(), id,
				fmt.Sprintf("198.51.%d.%d", (generation+slot)%256, slot%256),
				"203.0.113.9",
				bandJSON, modeJSON,
				created.Unix(), created.Unix(),
				userAgents[slot%len(userAgents)],
				country.name, country.code,
			); err != nil {
				t.Fatalf("insert: %v", err)
			}
			rows++
		}
	}
	if err := stmt.Close(); err != nil {
		t.Fatalf("stmt close: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	return startTime, endTime, rows
}

// peakHeapDuring runs fn and returns the highest heap-object total observed, in
// bytes, sampled from a helper goroutine. This is the figure the runtime sizes
// the heap against, so it is what drives the arena growth that killed the
// process -- not the live set after a collection.
func peakHeapDuring(fn func()) uint64 {
	runtime.GC()

	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	peak := stats.HeapAlloc

	done := make(chan struct{})
	sampled := make(chan uint64)
	go func() {
		local := peak
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				var s runtime.MemStats
				runtime.ReadMemStats(&s)
				if s.HeapAlloc > local {
					local = s.HeapAlloc
				}
			case <-done:
				sampled <- local
				return
			}
		}
	}()

	fn()
	close(done)
	return <-sampled
}

func TestPublicSessionStatsPeakMemory(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds a production-sized activity window")
	}

	mgr := newSessionStatsTestDB(t)
	startTime, endTime, rows := seedActivityWindow(t, mgr.DB(), productionScale)
	t.Logf("seeded %d rows over %v (%d concurrent sessions, snapshots every %v)",
		rows, productionScale.window, productionScale.concurrentSessions, productionScale.snapshotInterval)

	var batchStats, streamStats map[string]interface{}

	batchPeak := peakHeapDuring(func() {
		logs, err := ReadActivityLogsFromDB(mgr.ReadDB(), startTime, endTime)
		if err != nil {
			t.Errorf("ReadActivityLogsFromDB: %v", err)
			return
		}
		logs = FilterSessionsByAuthMethod(logs, []string{"regular"})
		endEvents := filterEventsByType(convertLogsToEvents(logs), []string{"session_end"})
		batchStats = calculatePublicSessionStats(func(emit func(SessionEvent)) {
			for _, event := range endEvents {
				emit(event)
			}
		}, startTime, endTime, nil)
		// Keep every intermediate reachable across the fold, as the old pipeline did.
		runtime.KeepAlive(logs)
		runtime.KeepAlive(endEvents)
	})
	if t.Failed() {
		return
	}

	streamPeak := peakHeapDuring(func() {
		response, err := computePublicSessionStatsForWindow(mgr.ReadDB(), nil, startTime, endTime)
		if err != nil {
			t.Errorf("computePublicSessionStatsForWindow: %v", err)
			return
		}
		streamStats, _ = response["stats"].(map[string]interface{})
	})
	if t.Failed() {
		return
	}

	const mb = 1024 * 1024
	t.Logf("peak heap: batch %d MB, streaming %d MB (%.1fx less)",
		batchPeak/mb, streamPeak/mb, float64(batchPeak)/float64(streamPeak))
	t.Logf("total_sessions: batch %v, streaming %v", batchStats["total_sessions"], streamStats["total_sessions"])

	if got, want := streamStats["total_sessions"], batchStats["total_sessions"]; got != want {
		t.Errorf("total_sessions = %v, want %v — the two pipelines disagree at scale", got, want)
	}

	// The point of the change: peak must not scale with the size of the window.
	// A generous bound, so this fails on a regression rather than on noise.
	if streamPeak > batchPeak/4 {
		t.Errorf("streaming peak %d MB is not materially below batch peak %d MB",
			streamPeak/mb, batchPeak/mb)
	}
}

// TestStreamingPeakIsIndependentOfWindow is the property that actually matters:
// doubling the retention window must not double peak memory.
func TestStreamingPeakIsIndependentOfWindow(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds a production-sized activity window")
	}

	const mb = 1024 * 1024
	peaks := make(map[time.Duration]uint64)

	for _, window := range []time.Duration{7 * 24 * time.Hour, 28 * 24 * time.Hour} {
		scale := productionScale
		scale.window = window

		mgr := newSessionStatsTestDB(t)
		startTime, endTime, rows := seedActivityWindow(t, mgr.DB(), scale)

		peaks[window] = peakHeapDuring(func() {
			if _, err := computePublicSessionStatsForWindow(mgr.ReadDB(), nil, startTime, endTime); err != nil {
				t.Errorf("computePublicSessionStatsForWindow: %v", err)
			}
		})
		t.Logf("window %v (%d rows): peak heap %d MB", window, rows, peaks[window]/mb)

		if err := StreamActivityLogsFromDB(context.Background(), mgr.ReadDB(), startTime, endTime,
			func(SessionActivityLog) error { return nil }); err != nil {
			t.Fatalf("StreamActivityLogsFromDB: %v", err)
		}
	}

	short, long := peaks[7*24*time.Hour], peaks[28*24*time.Hour]
	if long > 3*short {
		t.Errorf("peak grew %.1fx for a 4x larger window (%d MB -> %d MB); the fold is still retaining per-row state",
			float64(long)/float64(short), short/mb, long/mb)
	}
}
