package main

import (
	"sync"
	"time"
)

// sessionRecord holds the end time and duration of a completed UUID session block.
// A "session block" is the wall-clock window from when a UUID first connected to
// when it fully disconnected (all its WebSocket connections closed).
type sessionRecord struct {
	endedAt      time.Time
	durationSecs int64
}

// IPDailyTimeTracker tracks cumulative connected time per IP address over a rolling
// 24-hour window. Time is counted per unique UUID (logical user session): audio,
// spectrum, and DX connections that share the same UUID count as one session and
// tick the clock at 1×. Two different UUIDs from the same IP each tick at 1×,
// so the IP's total ticks at 2×.
//
// Design:
//   - activeSessions[ip][uuid] = time when that UUID first connected from this IP.
//     The clock for a UUID starts on its first WebSocket connection and stops when
//     all its connections are gone (tracked via a per-UUID reference count).
//   - uuidRefCount[ip][uuid] = number of active WebSocket connections for this UUID
//     from this IP. When it drops to zero the elapsed time is committed to history.
//   - history[ip] holds completed UUID session blocks (endedAt + durationSecs).
//     Records older than 24 hours are pruned lazily on each access.
//   - GetUsedSeconds sums completed history + live elapsed for all active UUIDs.
//   - The rolling window is always "now - 24h", so no midnight reset is needed.
type IPDailyTimeTracker struct {
	mu             sync.Mutex
	activeSessions map[string]map[string]time.Time // ip → uuid → startedAt
	uuidRefCount   map[string]map[string]int       // ip → uuid → active connection count
	history        map[string][]sessionRecord      // ip → completed session blocks
}

// NewIPDailyTimeTracker creates and returns a ready-to-use IPDailyTimeTracker.
func NewIPDailyTimeTracker() *IPDailyTimeTracker {
	return &IPDailyTimeTracker{
		activeSessions: make(map[string]map[string]time.Time),
		uuidRefCount:   make(map[string]map[string]int),
		history:        make(map[string][]sessionRecord),
	}
}

// RecordSessionStart notes that a new WebSocket connection has been established
// for the given (ip, uuid) pair. If this is the first connection for this UUID
// from this IP, the UUID's clock starts now. Subsequent connections (e.g. audio
// after spectrum) increment the reference count without restarting the clock.
// ip == "" or uuid == "" is a no-op (internal/background sessions).
func (t *IPDailyTimeTracker) RecordSessionStart(ip, uuid string) {
	if ip == "" || uuid == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	// Ensure per-IP maps exist.
	if t.activeSessions[ip] == nil {
		t.activeSessions[ip] = make(map[string]time.Time)
	}
	if t.uuidRefCount[ip] == nil {
		t.uuidRefCount[ip] = make(map[string]int)
	}

	// Start the clock on the first connection for this UUID from this IP.
	if _, exists := t.activeSessions[ip][uuid]; !exists {
		t.activeSessions[ip][uuid] = time.Now()
	}
	t.uuidRefCount[ip][uuid]++
}

// RecordSessionEnd notes that a WebSocket connection for (ip, uuid) has closed.
// When the reference count for this UUID drops to zero (all connections gone),
// the elapsed time since the UUID first connected is committed to history.
// ip == "" or uuid == "" is a no-op.
func (t *IPDailyTimeTracker) RecordSessionEnd(ip, uuid string) {
	if ip == "" || uuid == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.uuidRefCount[ip] == nil {
		return
	}

	t.uuidRefCount[ip][uuid]--
	if t.uuidRefCount[ip][uuid] > 0 {
		// Other connections for this UUID are still active.
		return
	}

	// Last connection for this UUID closed — commit elapsed time to history.
	delete(t.uuidRefCount[ip], uuid)
	if len(t.uuidRefCount[ip]) == 0 {
		delete(t.uuidRefCount, ip)
	}

	startedAt, exists := t.activeSessions[ip][uuid]
	if !exists {
		return
	}
	delete(t.activeSessions[ip], uuid)
	if len(t.activeSessions[ip]) == 0 {
		delete(t.activeSessions, ip)
	}

	now := time.Now()
	elapsed := int64(now.Sub(startedAt).Seconds())
	if elapsed < 0 {
		elapsed = 0
	}

	if t.history[ip] == nil {
		t.history[ip] = make([]sessionRecord, 0, 4)
	}
	t.history[ip] = append(t.history[ip], sessionRecord{
		endedAt:      now,
		durationSecs: elapsed,
	})
}

// GetUsedSeconds returns the total connected seconds for ip within the last 24 hours.
// It sums:
//  1. Completed UUID session blocks whose endedAt is within the last 24 hours.
//  2. The live elapsed time for each UUID currently active from this IP.
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
	now := time.Now()
	cutoff := now.Add(-24 * time.Hour)

	// Prune and sum completed history.
	var total int64
	if records, ok := t.history[ip]; ok {
		kept := records[:0]
		for _, r := range records {
			if r.endedAt.After(cutoff) {
				total += r.durationSecs
				kept = append(kept, r)
			}
		}
		if len(kept) == 0 {
			delete(t.history, ip)
		} else {
			t.history[ip] = kept
		}
	}

	// Add live elapsed time for each active UUID from this IP.
	if uuids, ok := t.activeSessions[ip]; ok {
		for _, startedAt := range uuids {
			live := int64(now.Sub(startedAt).Seconds())
			if live > 0 {
				total += live
			}
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
