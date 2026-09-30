package main

import (
	"sync"
	"testing"
	"time"
)

// privateIQRadiod is a radiodController that behaves enough like radiod for a
// private channel to be followed: every update is recorded, an applied one is
// answered with a channel status carrying the new frequency (after
// answerDelay, as radiod answers on its next block), and updates can be
// dropped or left unanswered to stand in for radiod's one-entry command queue
// and a broken status path.
type privateIQRadiod struct {
	mu          sync.Mutex
	creates     []privateIQCreate
	updates     map[uint32][]uint64
	terminated  []uint32
	status      map[uint32]*ChannelStatus
	drop        map[uint32]int
	silent      bool
	answerDelay time.Duration
	// channels is what GetAllChannelStatus reports in use, for the cap.
	channels int
	// panicUpdates makes that many updates to panicSSRC panic, to prove a
	// fault inside a retune is contained.
	panicUpdates int
	panicSSRC    uint32
}

type privateIQCreate struct {
	name       string
	frequency  uint64
	mode       string
	sampleRate int
	ssrc       uint32
	bandwidth  int
}

func newPrivateIQRadiod() *privateIQRadiod {
	return &privateIQRadiod{
		updates: make(map[uint32][]uint64),
		status:  make(map[uint32]*ChannelStatus),
		drop:    make(map[uint32]int),
	}
}

func (r *privateIQRadiod) CreateChannelWithBandwidth(name string, frequency uint64, mode string, sampleRate int, ssrc uint32, bandwidth int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.creates = append(r.creates, privateIQCreate{name, frequency, mode, sampleRate, ssrc, bandwidth})
	r.status[ssrc] = &ChannelStatus{SSRC: ssrc, LastUpdate: time.Now(), RadioFrequency: float64(frequency)}
	return nil
}

func (r *privateIQRadiod) UpdateChannelWithAGC(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, agc *AGCParams) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.updates[ssrc] = append(r.updates[ssrc], frequency)
	if ssrc == r.panicSSRC && r.panicUpdates > 0 {
		r.panicUpdates--
		panic("radiod fault during a retune")
	}
	if r.drop[ssrc] > 0 {
		r.drop[ssrc]--
		return nil // lost in radiod's queue: no answer, nothing moves
	}
	if r.silent || frequency == 0 {
		return nil
	}
	r.status[ssrc] = &ChannelStatus{SSRC: ssrc, LastUpdate: time.Now().Add(r.answerDelay), RadioFrequency: float64(frequency)}
	return nil
}

func (r *privateIQRadiod) GetChannelStatus(ssrc uint32) *ChannelStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	cs := r.status[ssrc]
	if cs == nil || time.Now().Before(cs.LastUpdate) {
		// Not answered yet: what is visible is whatever came before, which
		// for these tests is nothing useful.
		return nil
	}
	c := *cs
	return &c
}

func (r *privateIQRadiod) GetAllChannelStatus() map[uint32]*ChannelStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := make(map[uint32]*ChannelStatus, r.channels)
	for i := 0; i < r.channels; i++ {
		m[uint32(i+1)] = &ChannelStatus{}
	}
	return m
}

func (r *privateIQRadiod) TerminateChannel(name string, ssrc uint32) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.terminated = append(r.terminated, ssrc)
	return nil
}

func (r *privateIQRadiod) updatesFor(ssrc uint32) []uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]uint64(nil), r.updates[ssrc]...)
}

func (r *privateIQRadiod) wasTerminated(ssrc uint32) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.terminated {
		if s == ssrc {
			return true
		}
	}
	return false
}

func (r *privateIQRadiod) CreateSpectrumChannel(string, uint64, int, float64, uint32, float64) error {
	return nil
}
func (r *privateIQRadiod) UpdateSpectrumChannel(uint32, uint64, float64, int, bool, float64) error {
	return nil
}
func (r *privateIQRadiod) UpdateChannel(uint32, uint64, string, int, int, bool) error { return nil }
func (r *privateIQRadiod) UpdateSquelch(uint32, float32, float32) error               { return nil }
func (r *privateIQRadiod) SetAGC(uint32, AGCParams) error                             { return nil }
func (r *privateIQRadiod) GetFrontendStatus(uint32) *FrontendStatus                   { return nil }
func (r *privateIQRadiod) RefreshAudioLifetime(uint32) error                          { return nil }

// ── Helpers ───────────────────────────────────────────────────────────────────

// fastPrivateIQTiming runs the retune confirmation in milliseconds.
func fastPrivateIQTiming(t *testing.T) {
	t.Helper()
	poll, confirm, attempts, tail := privateIQPollInterval, privateIQConfirmTimeout, privateIQMaxAttempts, privateIQSettleTail
	t.Cleanup(func() {
		privateIQPollInterval, privateIQConfirmTimeout, privateIQMaxAttempts, privateIQSettleTail = poll, confirm, attempts, tail
	})
	privateIQPollInterval = 2 * time.Millisecond
	privateIQConfirmTimeout = 60 * time.Millisecond
	privateIQMaxAttempts = 3
	privateIQSettleTail = 10 * time.Millisecond
}

const privateIQOwnerUUID = "11111111-2222-4333-8444-555555555555"

// newPrivateIQTestSetup returns a session manager on a privateIQRadiod, with an
// ordinary listener (the owner) tuned to 820 kHz AM.
func newPrivateIQTestSetup(t *testing.T) (*SessionManager, *privateIQRadiod, *Session) {
	t.Helper()
	fastPrivateIQTiming(t)
	sm := newTestSessionManager(t)
	rd := newPrivateIQRadiod()
	sm.radiod = rd
	sm.dailyTracker = NewIPDailyTimeTracker()
	owner, err := sm.CreateSessionWithBandwidthAndPassword(820000, "am", 10000, "203.0.113.5", "203.0.113.5", privateIQOwnerUUID, "")
	if err != nil {
		t.Fatalf("creating the owner's session: %v", err)
	}
	return sm, rd, owner
}

// settleRecorder collects onSettled calls.
type settleRecorder struct {
	mu    sync.Mutex
	calls []settledCall
}

type settledCall struct {
	frequency uint64
	blocked   bool
}

func (r *settleRecorder) record(frequency uint64, blocked bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, settledCall{frequency, blocked})
}

func (r *settleRecorder) last() (settledCall, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) == 0 {
		return settledCall{}, false
	}
	return r.calls[len(r.calls)-1], true
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func settledAt(rec *settleRecorder, frequency uint64) func() bool {
	return func() bool {
		c, ok := rec.last()
		return ok && c.frequency == frequency
	}
}

func retuneOwner(t *testing.T, sm *SessionManager, owner *Session, frequency uint64) {
	t.Helper()
	if err := sm.UpdateSessionChannel(owner.ID, frequency, "", 0, 0, false, nil); err != nil {
		t.Fatalf("retuning the owner to %d: %v", frequency, err)
	}
}

// ── Creation ──────────────────────────────────────────────────────────────────

func TestPrivateIQChannelIsAnInternalSession(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)

	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatalf("newPrivateIQChannel: %v", err)
	}
	defer p.close()
	s := p.session

	// radiod was asked for the IQ preset on the owner's frequency, with the
	// preset's own filter.
	var create *privateIQCreate
	for i := range rd.creates {
		if rd.creates[i].ssrc == s.SSRC {
			create = &rd.creates[i]
		}
	}
	if create == nil {
		t.Fatal("no radiod channel was created for the private session")
	}
	if create.mode != "iq48" || create.frequency != 820000 || create.sampleRate != 48000 || create.bandwidth != 0 {
		t.Errorf("radiod create = %+v, want iq48 at 820000 Hz, 48000 Hz, bandwidth 0", *create)
	}
	if s.Mode != "iq48" || s.SampleRate != 48000 || s.Channels != 2 || s.Frequency != 820000 {
		t.Errorf("session mode %s, rate %d, channels %d, frequency %d; want iq48, 48000, 2, 820000",
			s.Mode, s.SampleRate, s.Channels, s.Frequency)
	}

	// Registered where keepalive and routing look, and nowhere a user is.
	sm.mu.RLock()
	_, inSessions := sm.sessions[s.ID]
	routed := sm.ssrcToSession[s.SSRC] == s
	ownersAudio := sm.uuidAudioSessions[privateIQOwnerUUID]
	users := sm.userSessionUUIDs[privateIQOwnerUUID]
	sm.mu.RUnlock()
	if !inSessions {
		t.Error("not in sm.sessions, so keepaliveAudioChannels would never refresh it and radiod would reap it")
	}
	if !routed {
		t.Error("not in ssrcToSession, so routeAudio would never deliver its packets")
	}
	if s.UserSessionID != "" || s.ClientIP != "" {
		t.Errorf("carries UserSessionID %q / ClientIP %q; it must be internal", s.UserSessionID, s.ClientIP)
	}
	if ownersAudio != owner.ID {
		t.Errorf("the owner's audio session is now %q, want %q", ownersAudio, owner.ID)
	}
	if users != 1 {
		t.Errorf("the owner's UUID has %d sessions counted, want 1", users)
	}
	if n := len(sm.GetNonBypassedAudioUsers()); n != 1 {
		t.Errorf("%d audio users listed, want 1 (the owner only)", n)
	}
	// Map order is random, so ask many times: the owner must always be the
	// one found, never the private channel.
	for i := 0; i < 50; i++ {
		if got := sm.findAudioSessionByUserID(privateIQOwnerUUID); got != owner {
			t.Fatalf("findAudioSessionByUserID returned %v, want the owner's session", got)
		}
	}
	if s.blockExempt != owner.blockExempt {
		t.Errorf("blockExempt = %v, want the owner's %v", s.blockExempt, owner.blockExempt)
	}
}

func TestPrivateIQChannelRejectsNonIQModes(t *testing.T) {
	sm, _, owner := newPrivateIQTestSetup(t)
	if _, err := sm.newPrivateIQChannel(owner, "x", "usb"); err == nil {
		t.Fatal("a private channel was created in usb; only IQ modes make sense")
	}
}

func TestPrivateIQChannelRespectsTheRadiodChannelCap(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	rd.channels = maxRadiodChannels
	if _, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48"); err == nil {
		t.Fatal("created with radiod at its channel cap")
	}
}

func TestPrivateIQChannelIsRateLimitedPerListener(t *testing.T) {
	sm, _, owner := newPrivateIQTestSetup(t)
	sm.sessionCreateLimiter = NewSessionCreateRateLimiter(6, 1)

	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatalf("first channel: %v", err)
	}
	p.close()
	if _, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48"); err == nil {
		t.Fatal("a second channel straight after the first was not rate limited")
	}
}

func TestPrivateIQChannelRefusedInsideABlockedRange(t *testing.T) {
	withBlockedState(t, announcementClips(), []Band{
		{Label: "Medium wave", Start: 526500, End: 1606500, Group: "Blocked"},
	})
	sm, _, owner := newPrivateIQTestSetup(t)
	if _, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48"); err == nil {
		t.Fatal("private IQ was created for an ordinary listener inside a blocked range")
	}
}

// ── Following the owner ──────────────────────────────────────────────────────

func TestPrivateIQChannelFollowsTheOwner(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	rec := &settleRecorder{}
	p.start(rec.record)

	retuneOwner(t, sm, owner, 830000)
	waitFor(t, "the channel to settle on 830000", settledAt(rec, 830000))

	if f := p.session.currentFrequency(); f != 830000 {
		t.Errorf("private session frequency %d, want 830000", f)
	}
	if u := rd.updatesFor(p.session.SSRC); len(u) == 0 || u[len(u)-1] != 830000 {
		t.Errorf("radiod updates for the private channel %v, want the last to be 830000", u)
	}
	if p.paused.Load() {
		t.Error("relay still held shut after the channel settled")
	}
	if c, _ := rec.last(); c.blocked {
		t.Error("reported blocked with no blocked ranges")
	}

	// The owner's own mode is nothing to do with the channel's.
	if err := sm.UpdateSessionChannel(owner.ID, 0, "usb", 0, 3000, true, nil); err != nil {
		t.Fatal(err)
	}
	if p.session.Mode != "iq48" {
		t.Errorf("private channel mode changed to %s with the owner's", p.session.Mode)
	}
}

func TestPrivateIQChannelSendsADroppedRetuneAgain(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	rd.mu.Lock()
	rd.drop[p.session.SSRC] = 1
	rd.mu.Unlock()
	rec := &settleRecorder{}
	p.start(rec.record)

	retuneOwner(t, sm, owner, 840000)
	waitFor(t, "the channel to settle on 840000", settledAt(rec, 840000))

	sent := 0
	for _, f := range rd.updatesFor(p.session.SSRC) {
		if f == 840000 {
			sent++
		}
	}
	if sent < 2 {
		t.Errorf("840000 was sent %d times; the dropped command was never sent again", sent)
	}
}

func TestPrivateIQChannelCoalescesARapidRunOfRetunes(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	rec := &settleRecorder{}
	p.start(rec.record)

	// A VFO being scrolled: 30 retunes back to back.
	const final = 820000 + 30*1000
	for f := uint64(821000); f <= final; f += 1000 {
		retuneOwner(t, sm, owner, f)
	}
	waitFor(t, "the channel to settle on the last frequency", settledAt(rec, final))

	if f := p.session.currentFrequency(); f != final {
		t.Errorf("private channel on %d, want %d", f, final)
	}
	if n := len(rd.updatesFor(p.session.SSRC)); n > 5 {
		t.Errorf("%d commands sent to radiod for 30 back-to-back retunes; want them coalesced", n)
	}
}

func TestPrivateIQChannelCarriesOnIfRadiodNeverAnswers(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	rd.mu.Lock()
	rd.silent = true
	rd.mu.Unlock()
	rec := &settleRecorder{}
	p.start(rec.record)

	retuneOwner(t, sm, owner, 850000)
	waitFor(t, "the channel to give up waiting and settle", settledAt(rec, 850000))

	if n := len(rd.updatesFor(p.session.SSRC)); n != privateIQMaxAttempts {
		t.Errorf("%d attempts, want %d", n, privateIQMaxAttempts)
	}
	if p.paused.Load() {
		t.Error("audio held back for ever because the status path is silent")
	}
}

func TestPrivateIQChannelRelayHoldsAudioWhileMoving(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	rd.mu.Lock()
	rd.answerDelay = 50 * time.Millisecond
	rd.mu.Unlock()

	tap := make(chan AudioSample, 16)
	out := make(chan AudioSample, 16)
	go p.relay(tap, out)
	rec := &settleRecorder{}
	p.start(rec.record)

	tap <- AudioSample{RTPTimestamp: 1}
	if got := <-out; got.RTPTimestamp != 1 {
		t.Fatalf("got %d, want 1", got.RTPTimestamp)
	}

	retuneOwner(t, sm, owner, 860000)
	waitFor(t, "the relay to close while the channel moves", p.paused.Load)
	tap <- AudioSample{RTPTimestamp: 2}
	select {
	case got := <-out:
		t.Fatalf("sample %d passed while the channel was still moving", got.RTPTimestamp)
	case <-time.After(20 * time.Millisecond):
	}

	waitFor(t, "the channel to settle", settledAt(rec, 860000))
	tap <- AudioSample{RTPTimestamp: 3}
	if got := <-out; got.RTPTimestamp != 3 {
		t.Fatalf("got %d after settling, want 3", got.RTPTimestamp)
	}

	close(tap)
	if _, ok := <-out; ok {
		t.Error("relay output still open after the tap closed")
	}
}

func TestPrivateIQChannelZeroedAfterFollowingIntoABlockedRange(t *testing.T) {
	withBlockedState(t, announcementClips(), []Band{
		{Label: "Blocked", Start: 1000000, End: 1100000, Group: "Blocked"},
	})
	sm, _, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatalf("outside the blocked range: %v", err)
	}
	defer p.close()
	rec := &settleRecorder{}
	p.start(rec.record)

	// The owner is on AM, so tuning in is allowed; they hear the announcement.
	retuneOwner(t, sm, owner, 1050000)
	waitFor(t, "the channel to settle inside the range", settledAt(rec, 1050000))
	if c, _ := rec.last(); !c.blocked {
		t.Error("settled inside a blocked range without saying so")
	}

	// routeAudio's own blocked-range handling does the rest: the private IQ is
	// zeroed as the owner's own IQ would be.
	pcm := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	p.session.applyBlockedAudio(pcm, 48000, 2)
	for i, b := range pcm {
		if b != 0 {
			t.Fatalf("byte %d = %d: IQ from inside a blocked range reached the extension", i, b)
		}
	}
}

// ── Teardown ─────────────────────────────────────────────────────────────────

func TestPrivateIQChannelCloseTearsDown(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	p.start(nil)
	s := p.session

	p.close()
	p.close() // idempotent

	if !rd.wasTerminated(s.SSRC) {
		t.Error("radiod channel not terminated")
	}
	sm.mu.RLock()
	_, inSessions := sm.sessions[s.ID]
	_, routed := sm.ssrcToSession[s.SSRC]
	sm.mu.RUnlock()
	if inSessions || routed {
		t.Errorf("still registered after close (sessions %v, ssrcToSession %v)", inSessions, routed)
	}
	select {
	case <-s.Done:
	default:
		t.Error("session Done not closed")
	}
	owner.mu.RLock()
	follower := owner.retuneFollower
	owner.mu.RUnlock()
	if follower != nil {
		t.Error("the owner still has the closed channel as its retune follower")
	}

	before := len(rd.updatesFor(s.SSRC))
	retuneOwner(t, sm, owner, 870000)
	time.Sleep(20 * time.Millisecond)
	if after := len(rd.updatesFor(s.SSRC)); after != before {
		t.Error("a closed channel was still retuned")
	}
}

func TestPrivateIQChannelCloseLeavesAReplacementFollowerAlone(t *testing.T) {
	sm, _, owner := newPrivateIQTestSetup(t)
	first, err := sm.newPrivateIQChannel(owner, "a", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	first.start(nil)
	second, err := sm.newPrivateIQChannel(owner, "b", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	second.start(nil)
	defer second.close()

	first.close()
	owner.mu.RLock()
	follower := owner.retuneFollower
	owner.mu.RUnlock()
	if owner.retuneFollowerGen != second.followerGen || follower == nil {
		t.Error("closing the first channel removed the second as the owner's follower")
	}
}

func TestPrivateIQChannelRecoversFromAPanicWhileRetuning(t *testing.T) {
	sm, rd, owner := newPrivateIQTestSetup(t)
	p, err := sm.newPrivateIQChannel(owner, "hdradio", "iq48")
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	rd.mu.Lock()
	rd.panicSSRC = p.session.SSRC
	rd.panicUpdates = 1
	rd.mu.Unlock()
	rec := &settleRecorder{}
	p.start(rec.record)

	retuneOwner(t, sm, owner, 830000) // the private channel's update panics
	// Released after the panic. A wake-up already queued may retry 830000
	// straight away, which is right (the channel has not got there), so the
	// count is at least one rather than exactly one.
	waitFor(t, "the audio to be released after the panic", func() bool {
		return len(rd.updatesFor(p.session.SSRC)) >= 1 && !p.paused.Load()
	})

	retuneOwner(t, sm, owner, 840000)
	waitFor(t, "the channel to follow the next retune", settledAt(rec, 840000))
	if f := p.session.currentFrequency(); f != 840000 {
		t.Errorf("private channel on %d, want 840000", f)
	}
}
