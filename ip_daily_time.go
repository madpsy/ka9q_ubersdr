package main

import (
	"sync"
	"time"
)

// sessionRecord holds the end time and duration of a completed session block for one IP.
// A "session block" is the wall-clock window from when the first session from an IP
// started to when the last concurrent session from that IP ended.
type sessionRecord struct {
	endedAt      time.Time
	durationSecs int64
}

// ipActivity tracks currently-active sessions for a single IP address.
// sessionCount is a reference count: incremented on each new session, decremented on
// each session end. When it drops to zero the elapsed time is committed to history.
type ipActivity struct {
	startedAt    time.Time // when the first (or only) session from this IP began
	sessionCount int       // number of currently active sessions from this IP
}

// IPDailyTimeTracker tracks cumulative connected time per IP address over a rolling
// 24-hour window. It is safe for concurrent use from multiple goroutines.
//
// Design:
//   - history[ip] holds completed session blocks (endedAt + durationSecs).
//     Records older than 24 hours are pruned lazily on each access.
//   - activeSessions[ip] holds the reference-counted start time for IPs that
//     currently have at least one active session.
//   - GetUsedSeconds sums completed history + live elapsed time for the IP.
//   - The rolling window is always "now - 24h", so no midnight reset is needed.
type IPDailyTimeTracker struct {
	mu             sync.Mutex
	history        map[string][]sessionRecord // IP → completed session blocks
	activeSessions map[string]*ipActivity     // IP → current activity (nil when idle)
}

// NewIPDailyTimeTracker creates and returns a ready-to-use IPDailyTimeTracker.
func NewIPDailyTimeTracker() *IPDailyTimeTracker {
	return &IPDailyTimeTracker{
		history:        make(map[string][]sessionRecord),
		activeSessions: make(map[string]*ipActivity),
	}
}

// RecordSessionStart notes that a new session has started from ip.
// If this is the first concurrent session from ip, the clock starts now.
// If ip already has active sessions the reference count is incremented but
// the start time is not changed (the clock is already running).
// ip == "" is a no-op (internal/background sessions have no client IP).
func (t *IPDailyTimeTracker) RecordSessionStart(ip string) {
	if ip == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	if act, ok := t.activeSessions[ip]; ok {
		// Already tracking this IP — just bump the reference count.
		act.sessionCount++
	} else {
		// First session from this IP.
		t.activeSessions[ip] = &ipActivity{
			startedAt:    time.Now(),
			sessionCount: 1,
		}
	}
}

// RecordSessionEnd notes that a session from ip has ended.
// When the reference count drops to zero the elapsed wall-clock time since the
// first session started is appended to history.
// ip == "" is a no-op.
func (t *IPDailyTimeTracker) RecordSessionEnd(ip string) {
	if ip == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	act, ok := t.activeSessions[ip]
	if !ok {
		// No active session tracked for this IP — nothing to do.
		// This can happen if the tracker was created after the session started
		// (e.g. on server restart) or if ip was empty at creation time.
		return
	}

	act.sessionCount--
	if act.sessionCount > 0 {
		// Other sessions from this IP are still active; keep the clock running.
		return
	}

	// Last session from this IP ended — commit the elapsed time to history.
	now := time.Now()
	elapsed := int64(now.Sub(act.startedAt).Seconds())
	if elapsed < 0 {
		elapsed = 0
	}

	t.history[ip] = append(t.history[ip], sessionRecord{
		endedAt:      now,
		durationSecs: elapsed,
	})

	delete(t.activeSessions, ip)
}

// GetUsedSeconds returns the total connected seconds for ip within the last 24 hours.
// It sums:
//  1. Completed session blocks whose endedAt is within the last 24 hours.
//  2. The live elapsed time if ip currently has active sessions.
//
// Stale records (older than 24 hours) are pruned from history as a side effect.
// ip == "" always returns 0.
func (t *IPDailyTimeTracker) GetUsedSeconds(ip string) int64 {
	if ip == "" {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	return t.getUsedSecondsLocked(ip)
}

// getUsedSecondsLocked is the internal implementation; caller must hold t.mu.
func (t *IPDailyTimeTracker) getUsedSecondsLocked(ip string) int64 {
	cutoff := time.Now().Add(-24 * time.Hour)

	// Prune and sum completed history.
	var total int64
	if records, ok := t.history[ip]; ok {
		kept := records[:0] // reuse backing array
		for _, r := range records {
			if r.endedAt.After(cutoff) {
				total += r.durationSecs
				kept = append(kept, r)
			}
			// Records at or before cutoff are dropped (pruned).
		}
		if len(kept) == 0 {
			delete(t.history, ip)
		} else {
			t.history[ip] = kept
		}
	}

	// Add live elapsed time if the IP currently has active sessions.
	if act, ok := t.activeSessions[ip]; ok {
		live := int64(time.Since(act.startedAt).Seconds())
		if live > 0 {
			total += live
		}
	}

	return total
}

// IsLimitExceeded returns true if ip has used at least limitSecs seconds in the
// last 24 hours. Returns false if limitSecs <= 0 (feature disabled) or ip == "".
func (t *IPDailyTimeTracker) IsLimitExceeded(ip string, limitSecs int) bool {
	if limitSecs <= 0 || ip == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	return t.getUsedSecondsLocked(ip) >= int64(limitSecs)
}

// AllIPs returns a snapshot of all IPs that have any history or active sessions.
// Used by the enforcement loop to iterate over candidates without holding the lock
// for the entire kick operation.
func (t *IPDailyTimeTracker) AllIPs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()

	seen := make(map[string]struct{}, len(t.history)+len(t.activeSessions))
	for ip := range t.history {
		seen[ip] = struct{}{}
	}
	for ip := range t.activeSessions {
		seen[ip] = struct{}{}
	}

	ips := make([]string, 0, len(seen))
	for ip := range seen {
		ips = append(ips, ip)
	}
	return ips
}
