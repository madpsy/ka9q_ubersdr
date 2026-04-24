package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ── Minimal stubs ─────────────────────────────────────────────────────────────

// stubRadiod satisfies the radiodController interface used by SessionManager.
// CreateSpectrumChannel and TerminateChannel calls are counted; all others are no-ops.
type stubRadiod struct {
	mu             sync.Mutex
	createCalls    int
	terminateCalls int
	lastCreateSSRC uint32
	lastTermSSRC   uint32
}

func (r *stubRadiod) CreateSpectrumChannel(name string, freq uint64, binCount int, binBW float64, ssrc uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.createCalls++
	r.lastCreateSSRC = ssrc
	return nil
}

func (r *stubRadiod) TerminateChannel(name string, ssrc uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.terminateCalls++
	r.lastTermSSRC = ssrc
	return nil
}

func (r *stubRadiod) CreateChannelWithBandwidth(name string, frequency uint64, mode string, sampleRate int, ssrc uint32, bandwidth int) error {
	return nil
}
func (r *stubRadiod) UpdateSpectrumChannel(ssrc uint32, freq uint64, binBW float64, binCount int, binCountChanged bool) error {
	return nil
}
func (r *stubRadiod) UpdateChannel(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool) error {
	return nil
}
func (r *stubRadiod) UpdateSquelch(ssrc uint32, squelchOpen, squelchClose float32) error {
	return nil
}
func (r *stubRadiod) GetFrontendStatus(ssrc uint32) *FrontendStatus       { return nil }
func (r *stubRadiod) DisableChannelSilent(name string, ssrc uint32) error { return nil }
func (r *stubRadiod) GetAllChannelStatus() map[uint32]*ChannelStatus      { return nil }
func (r *stubRadiod) GetChannelStatus(ssrc uint32) *ChannelStatus         { return nil }

// ── Helpers ───────────────────────────────────────────────────────────────────

// newTestSessionManager creates a minimal SessionManager suitable for unit tests.
// It injects a stubRadiod so all radiod calls succeed without a real UDP connection.
func newTestSessionManager(t *testing.T) *SessionManager {
	t.Helper()
	cfg := &Config{}
	cfg.Server.MaxSessions = 100
	cfg.Server.SessionTimeout = 300
	cfg.Spectrum.Default.CenterFrequency = 15_000_000
	cfg.Spectrum.Default.BinCount = 1024
	cfg.Spectrum.Default.BinBandwidth = 30_000.0

	rc := &stubRadiod{}

	sm := &SessionManager{
		sessions:             make(map[string]*Session),
		ssrcToSession:        make(map[uint32]*Session),
		kickedUUIDs:          make(map[string]time.Time),
		userSessionFirst:     make(map[string]time.Time),
		userSessionUUIDs:     make(map[string]int),
		ipToUUIDs:            make(map[string]map[string]bool),
		userAgents:           make(map[string]string),
		userAgentLastSeen:    make(map[string]time.Time),
		uuidToIP:             make(map[string]string),
		uuidAudioSessions:    make(map[string]string),
		uuidSpectrumSessions: make(map[string]string),
		userSessionBands:     make(map[string]map[string]bool),
		userSessionModes:     make(map[string]map[string]bool),
		rdnsCache:            make(map[string]string),
		rdnsResolved:         make(map[string]bool),
		ssrcToShared:         make(map[uint32]*SharedDefaultChannel),
		config:               cfg,
		radiod:               rc,
		maxSessions:          100,
		timeout:              300 * time.Second,
	}
	return sm
}

// createTestSpectrumSession is a thin wrapper that calls the real
// createSpectrumSessionWithUserIDAndPassword with empty IP/password so it
// bypasses all rate-limit checks.
func createTestSpectrumSession(t *testing.T, sm *SessionManager, uuid string) *Session {
	t.Helper()
	// Empty clientIP bypasses all IP-based limits.
	sess, err := sm.createSpectrumSessionWithUserIDAndPassword("", "", uuid, "")
	if err != nil {
		t.Fatalf("createSpectrumSession(%s): %v", uuid, err)
	}
	return sess
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Test 1: N users connect at defaults → only 1 radiod CreateSpectrumChannel call.
func TestSharedChannel_NUsersAtDefaults_OneRadiodChannel(t *testing.T) {
	sm := newTestSessionManager(t)

	const N = 5
	sessions := make([]*Session, N)
	for i := 0; i < N; i++ {
		sessions[i] = createTestSpectrumSession(t, sm, "uuid-"+string(rune('A'+i)))
	}

	// All sessions should be shared subscribers.
	for i, s := range sessions {
		if !s.IsSharedSubscriber {
			t.Errorf("session[%d] should be a shared subscriber", i)
		}
	}

	// All sessions should share the same SSRC.
	sharedSSRC := sessions[0].SSRC
	for i, s := range sessions {
		if s.SSRC != sharedSSRC {
			t.Errorf("session[%d] SSRC 0x%08x != shared SSRC 0x%08x", i, s.SSRC, sharedSSRC)
		}
	}

	// The shared channel should have N subscribers.
	sm.mu.RLock()
	sdc := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdc == nil {
		t.Fatal("sharedDefaultChan is nil after N connections")
	}
	sdc.mu.RLock()
	count := len(sdc.subscribers)
	sdc.mu.RUnlock()
	if count != N {
		t.Errorf("expected %d subscribers, got %d", N, count)
	}

	// ssrcToSession must NOT contain the shared SSRC.
	sm.mu.RLock()
	_, inSession := sm.ssrcToSession[sharedSSRC]
	sm.mu.RUnlock()
	if inSession {
		t.Error("shared SSRC must not be in ssrcToSession")
	}
}

// Test 2: Last subscriber disconnects → TerminateChannel called exactly once.
// We verify by checking sharedDefaultChan is nil and ssrcToShared is empty.
func TestSharedChannel_LastSubscriberLeaves_ChannelTornDown(t *testing.T) {
	sm := newTestSessionManager(t)

	s1 := createTestSpectrumSession(t, sm, "uuid-1")
	s2 := createTestSpectrumSession(t, sm, "uuid-2")

	sharedSSRC := s1.SSRC

	// Destroy first session — shared channel should still be active.
	if err := sm.DestroySession(s1.ID); err != nil {
		t.Fatalf("DestroySession(s1): %v", err)
	}
	sm.mu.RLock()
	sdc := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdc == nil {
		t.Fatal("sharedDefaultChan should still exist after first subscriber leaves")
	}

	// Destroy second (last) session — shared channel should be torn down.
	if err := sm.DestroySession(s2.ID); err != nil {
		t.Fatalf("DestroySession(s2): %v", err)
	}
	sm.mu.RLock()
	sdcAfter := sm.sharedDefaultChan
	_, stillInShared := sm.ssrcToShared[sharedSSRC]
	sm.mu.RUnlock()

	if sdcAfter != nil {
		t.Error("sharedDefaultChan should be nil after last subscriber leaves")
	}
	if stillInShared {
		t.Error("shared SSRC should be removed from ssrcToShared after teardown")
	}
}

// Test 3: User zooms in → private channel created; user resets → private channel
// terminated and shared channel re-subscribed.
func TestSharedChannel_ZoomInThenReset_PrivateChannelLifecycle(t *testing.T) {
	sm := newTestSessionManager(t)

	sess := createTestSpectrumSession(t, sm, "uuid-zoom")
	if !sess.IsSharedSubscriber {
		t.Fatal("session should start as shared subscriber")
	}
	originalSharedSSRC := sess.SSRC

	// Zoom in — parameters differ from defaults.
	zoomFreq := uint64(7_000_000)
	zoomBinBW := 1000.0
	zoomBinCount := 512
	if err := sm.UpdateSpectrumSession(sess.ID, zoomFreq, zoomBinBW, zoomBinCount); err != nil {
		t.Fatalf("UpdateSpectrumSession (zoom): %v", err)
	}

	// Session should now be private.
	if sess.IsSharedSubscriber {
		t.Error("session should NOT be a shared subscriber after zoom")
	}
	privateSSRC := sess.SSRC
	if privateSSRC == originalSharedSSRC {
		t.Error("private SSRC should differ from the original shared SSRC")
	}

	// Private SSRC must be in ssrcToSession.
	sm.mu.RLock()
	_, inSession := sm.ssrcToSession[privateSSRC]
	sm.mu.RUnlock()
	if !inSession {
		t.Error("private SSRC should be in ssrcToSession after zoom")
	}

	// Shared channel should be gone (we were the only subscriber).
	sm.mu.RLock()
	sdcAfterZoom := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdcAfterZoom != nil {
		t.Error("sharedDefaultChan should be nil after sole subscriber zoomed away")
	}

	// Reset — should return to shared channel.
	if err := sm.ReturnToSharedChannel(sess.ID); err != nil {
		t.Fatalf("ReturnToSharedChannel: %v", err)
	}

	if !sess.IsSharedSubscriber {
		t.Error("session should be a shared subscriber after reset")
	}

	// Private SSRC must no longer be in ssrcToSession.
	sm.mu.RLock()
	_, stillPrivate := sm.ssrcToSession[privateSSRC]
	sdcAfterReset := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if stillPrivate {
		t.Error("private SSRC should be removed from ssrcToSession after reset")
	}
	if sdcAfterReset == nil {
		t.Error("sharedDefaultChan should exist again after reset")
	}

	// Session parameters should be back to defaults.
	def := sm.config.Spectrum.Default
	if sess.Frequency != def.CenterFrequency {
		t.Errorf("frequency after reset: got %d, want %d", sess.Frequency, def.CenterFrequency)
	}
	if sess.BinBandwidth != def.BinBandwidth {
		t.Errorf("binBandwidth after reset: got %f, want %f", sess.BinBandwidth, def.BinBandwidth)
	}
	if sess.BinCount != def.BinCount {
		t.Errorf("binCount after reset: got %d, want %d", sess.BinCount, def.BinCount)
	}
}

// Test 4: Mixed users — some at defaults (shared), some zoomed (private).
func TestSharedChannel_MixedUsers(t *testing.T) {
	sm := newTestSessionManager(t)

	// Two users at defaults.
	s1 := createTestSpectrumSession(t, sm, "uuid-default-1")
	s2 := createTestSpectrumSession(t, sm, "uuid-default-2")
	// One user zooms in.
	s3 := createTestSpectrumSession(t, sm, "uuid-zoom")
	if err := sm.UpdateSpectrumSession(s3.ID, 7_000_000, 1000.0, 512); err != nil {
		t.Fatalf("UpdateSpectrumSession: %v", err)
	}

	// s1 and s2 should be shared.
	if !s1.IsSharedSubscriber || !s2.IsSharedSubscriber {
		t.Error("s1 and s2 should be shared subscribers")
	}
	// s3 should be private.
	if s3.IsSharedSubscriber {
		t.Error("s3 should NOT be a shared subscriber after zoom")
	}
	// s1 and s2 share the same SSRC; s3 has a different one.
	if s1.SSRC != s2.SSRC {
		t.Error("s1 and s2 should share the same SSRC")
	}
	if s3.SSRC == s1.SSRC {
		t.Error("s3 should have a different SSRC from the shared channel")
	}

	// Shared channel should still be active (s1 and s2 are still subscribed).
	sm.mu.RLock()
	sdc := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdc == nil {
		t.Fatal("sharedDefaultChan should still exist")
	}
	sdc.mu.RLock()
	count := len(sdc.subscribers)
	sdc.mu.RUnlock()
	if count != 2 {
		t.Errorf("expected 2 shared subscribers, got %d", count)
	}
}

// Test 4 (plan): 3 defaults + 2 zoomed → 3 radiod channels total (not 5).
// Disconnect zoomed users → 2 private channels terminated, shared still active.
// Disconnect all default users → shared channel terminated.
func TestSharedChannel_MixedUsersFullLifecycle(t *testing.T) {
	sm := newTestSessionManager(t)
	stub := sm.radiod.(*stubRadiod)

	// Connect 3 users at defaults.
	d1 := createTestSpectrumSession(t, sm, "uuid-def-1")
	d2 := createTestSpectrumSession(t, sm, "uuid-def-2")
	d3 := createTestSpectrumSession(t, sm, "uuid-def-3")

	// Connect 2 users who immediately zoom in.
	z1 := createTestSpectrumSession(t, sm, "uuid-zoom-1")
	if err := sm.UpdateSpectrumSession(z1.ID, 7_000_000, 1000.0, 512); err != nil {
		t.Fatalf("zoom z1: %v", err)
	}
	z2 := createTestSpectrumSession(t, sm, "uuid-zoom-2")
	if err := sm.UpdateSpectrumSession(z2.ID, 10_000_000, 500.0, 256); err != nil {
		t.Fatalf("zoom z2: %v", err)
	}

	// Assert: 1 shared + 2 private = 3 CreateSpectrumChannel calls total.
	stub.mu.Lock()
	creates := stub.createCalls
	stub.mu.Unlock()
	if creates != 3 {
		t.Errorf("expected 3 CreateSpectrumChannel calls, got %d", creates)
	}

	// Shared channel should have 3 subscribers.
	sm.mu.RLock()
	sdc := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdc == nil {
		t.Fatal("sharedDefaultChan should exist")
	}
	sdc.mu.RLock()
	sharedCount := len(sdc.subscribers)
	sdc.mu.RUnlock()
	if sharedCount != 3 {
		t.Errorf("expected 3 shared subscribers, got %d", sharedCount)
	}

	// Disconnect zoomed users → 2 TerminateChannel calls, shared still active.
	if err := sm.DestroySession(z1.ID); err != nil {
		t.Fatalf("DestroySession(z1): %v", err)
	}
	if err := sm.DestroySession(z2.ID); err != nil {
		t.Fatalf("DestroySession(z2): %v", err)
	}
	stub.mu.Lock()
	terms := stub.terminateCalls
	stub.mu.Unlock()
	if terms != 2 {
		t.Errorf("expected 2 TerminateChannel calls after zoomed users leave, got %d", terms)
	}
	sm.mu.RLock()
	sdcStillActive := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdcStillActive == nil {
		t.Error("sharedDefaultChan should still exist after zoomed users leave")
	}

	// Disconnect all default users → shared channel terminated (1 more TerminateChannel).
	if err := sm.DestroySession(d1.ID); err != nil {
		t.Fatalf("DestroySession(d1): %v", err)
	}
	if err := sm.DestroySession(d2.ID); err != nil {
		t.Fatalf("DestroySession(d2): %v", err)
	}
	if err := sm.DestroySession(d3.ID); err != nil {
		t.Fatalf("DestroySession(d3): %v", err)
	}
	stub.mu.Lock()
	termsAfter := stub.terminateCalls
	stub.mu.Unlock()
	if termsAfter != 3 {
		t.Errorf("expected 3 total TerminateChannel calls after all users leave, got %d", termsAfter)
	}
	sm.mu.RLock()
	sdcGone := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdcGone != nil {
		t.Error("sharedDefaultChan should be nil after all users leave")
	}
}

// Test 5 (plan): Concurrent connections at defaults — race detector should not fire.
func TestSharedChannel_ConcurrentConnections(t *testing.T) {
	sm := newTestSessionManager(t)

	const N = 20
	var wg sync.WaitGroup
	var errCount int64

	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			uuid := "uuid-concurrent-" + string(rune('A'+idx%26))
			_, err := sm.createSpectrumSessionWithUserIDAndPassword("", "", uuid, "")
			if err != nil {
				atomic.AddInt64(&errCount, 1)
			}
		}(i)
	}
	wg.Wait()

	if errCount > 0 {
		t.Errorf("%d concurrent session creations failed", errCount)
	}

	sm.mu.RLock()
	sdc := sm.sharedDefaultChan
	sm.mu.RUnlock()
	if sdc == nil {
		t.Fatal("sharedDefaultChan should exist after concurrent connections")
	}
}
