package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakePrivateExt is an audio extension that records what the manager does to it.
type fakePrivateExt struct {
	mu           sync.Mutex
	params       AudioExtensionParams
	samples      int
	retunes      []uint64
	stopped      bool
	startErr     error
	retunePanics int // Retune panics this many times before behaving
	crash        chan error
	inputClosed  chan struct{}
	closeInput   sync.Once // Start may run more than once (re-attach reuses the fake)
}

func newFakePrivateExt() *fakePrivateExt {
	return &fakePrivateExt{crash: make(chan error, 1), inputClosed: make(chan struct{})}
}

func (e *fakePrivateExt) Start(in <-chan AudioSample, out chan<- []byte) error {
	if e.startErr != nil {
		return e.startErr
	}
	go func() {
		for range in {
			e.mu.Lock()
			e.samples++
			e.mu.Unlock()
		}
		e.closeInput.Do(func() { close(e.inputClosed) })
	}()
	return nil
}

func (e *fakePrivateExt) Stop() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stopped = true
	return nil
}

func (e *fakePrivateExt) GetName() string         { return "privtest" }
func (e *fakePrivateExt) CrashChan() <-chan error { return e.crash }

func (e *fakePrivateExt) Retune(frequencyHz uint64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.retunePanics > 0 {
		e.retunePanics--
		panic("extension fault in Retune")
	}
	e.retunes = append(e.retunes, frequencyHz)
}

func (e *fakePrivateExt) state() (samples int, retunes []uint64, stopped bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.samples, append([]uint64(nil), e.retunes...), e.stopped
}

func (e *fakePrivateExt) retunedTo(frequency uint64) func() bool {
	return func() bool {
		_, retunes, _ := e.state()
		for _, f := range retunes {
			if f == frequency {
				return true
			}
		}
		return false
	}
}

type privateIQManagerSetup struct {
	aem   *AudioExtensionManager
	sm    *SessionManager
	rd    *privateIQRadiod
	owner *Session
	ext   *fakePrivateExt
}

// newPrivateIQManagerSetup registers one extension, "privtest", with the given
// PrivateIQ mode ("" for an ordinary extension), whose factory returns ext or
// factoryErr.
func newPrivateIQManagerSetup(t *testing.T, privateIQ string, factoryErr error) *privateIQManagerSetup {
	t.Helper()
	sm, rd, owner := newPrivateIQTestSetup(t)
	ext := newFakePrivateExt()
	reg := NewAudioExtensionRegistry()
	reg.Register("privtest", func(p AudioExtensionParams, _ map[string]interface{}) (AudioExtension, error) {
		if factoryErr != nil {
			return nil, factoryErr
		}
		ext.params = p
		return ext, nil
	}, AudioExtensionInfo{Name: "privtest", PrivateIQ: privateIQ})
	return &privateIQManagerSetup{
		aem:   NewAudioExtensionManager(nil, sm, reg, "", nil),
		sm:    sm,
		rd:    rd,
		owner: owner,
		ext:   ext,
	}
}

// attach runs the real attach handler. There is no websocket in these tests,
// so its final reply fails with "connection is nil"; everything before that
// is what is under test.
func (s *privateIQManagerSetup) attach() {
	_ = s.aem.handleAttach(privateIQOwnerUUID, nil, map[string]interface{}{"extension_name": "privtest"})
}

func (s *privateIQManagerSetup) active() *ActiveAudioExtension {
	s.aem.activeExtensionsMu.RLock()
	defer s.aem.activeExtensionsMu.RUnlock()
	return s.aem.activeExtensions[privateIQOwnerUUID]
}

// privateSessions lists the private-channel sessions the manager still holds.
func (s *privateIQManagerSetup) privateSessions() []*Session {
	s.sm.mu.RLock()
	defer s.sm.mu.RUnlock()
	var out []*Session
	for id, sess := range s.sm.sessions {
		if strings.HasPrefix(id, "ext-") {
			out = append(out, sess)
		}
	}
	return out
}

func routePacket(sm *SessionManager, ssrc uint32) {
	ar := &AudioReceiver{sessions: sm}
	ar.routeAudio(ssrc, make([]byte, 16), 1, time.Now().UnixNano())
}

// ── The lifecycle ────────────────────────────────────────────────────────────

func TestExtensionWithPrivateIQIsFedFromItsOwnChannel(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	s.attach()
	a := s.active()
	if a == nil || a.private == nil {
		t.Fatal("attached without a private channel")
	}
	priv := a.private.session

	if s.ext.params != (AudioExtensionParams{SampleRate: 48000, Channels: 2, BitsPerSample: 16}) {
		t.Errorf("extension created with %+v, want the private channel's 48000 Hz stereo", s.ext.params)
	}
	if a.Session != priv || a.Owner != s.owner {
		t.Error("record does not name the private session as the tap and the listener's as the owner")
	}
	if s.owner.HasAudioExtension() {
		t.Error("the listener's own session has the tap; it should be on the private channel")
	}
	if !priv.HasAudioExtension() {
		t.Error("the private channel has no tap")
	}

	// A packet on the private channel reaches the extension; one on the
	// listener's own does not.
	routePacket(s.sm, priv.SSRC)
	waitFor(t, "the private channel's packet to reach the extension", func() bool {
		n, _, _ := s.ext.state()
		return n == 1
	})
	routePacket(s.sm, s.owner.SSRC)
	time.Sleep(20 * time.Millisecond)
	if n, _, _ := s.ext.state(); n != 1 {
		t.Errorf("extension received %d packets; the listener's own audio reached it", n)
	}

	// The listener retunes; the extension hears about it once settled.
	retuneOwner(t, s.sm, s.owner, 830000)
	waitFor(t, "Retune(830000)", s.ext.retunedTo(830000))

	// Detach tears everything down.
	_ = s.aem.handleDetach(privateIQOwnerUUID, nil)
	if _, _, stopped := s.ext.state(); !stopped {
		t.Error("extension not stopped on detach")
	}
	if !s.rd.wasTerminated(priv.SSRC) {
		t.Error("private radiod channel not terminated on detach")
	}
	if len(s.privateSessions()) != 0 {
		t.Error("private session still registered after detach")
	}
	select {
	case <-s.ext.inputClosed:
	case <-time.After(time.Second):
		t.Error("the extension's input was never closed")
	}
}

func TestExtensionWithPrivateIQStopsWhenTheListenersSessionEnds(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	s.attach()
	a := s.active()
	if a == nil || a.private == nil {
		t.Fatal("attached without a private channel")
	}
	priv := a.private.session

	// Kicked, timed out or reconnected: all end in DestroySession, while the
	// DX cluster socket the extension is attached over stays open.
	if err := s.sm.DestroySession(s.owner.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the extension to be removed", func() bool { return s.active() == nil })
	waitFor(t, "the extension to be stopped", func() bool {
		_, _, stopped := s.ext.state()
		return stopped
	})
	waitFor(t, "the private channel to be terminated", func() bool { return s.rd.wasTerminated(priv.SSRC) })
	if len(s.privateSessions()) != 0 {
		t.Error("private session still registered after the listener's session ended")
	}
}

func TestExtensionWithoutPrivateIQIsUnchanged(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "", nil)
	creates := len(s.rd.creates)
	s.attach()
	a := s.active()
	if a == nil {
		t.Fatal("not attached")
	}
	defer s.aem.RemoveSession(privateIQOwnerUUID)

	if a.private != nil || len(s.rd.creates) != creates {
		t.Error("an extension without PrivateIQ was given a channel of its own")
	}
	if a.Session != s.owner || !s.owner.HasAudioExtension() {
		t.Error("tap not on the listener's own session")
	}
	if s.ext.params.SampleRate != 24000 || s.ext.params.Channels != 1 {
		t.Errorf("extension created with %+v, want the listener's AM (24000 Hz mono)", s.ext.params)
	}
	routePacket(s.sm, s.owner.SSRC)
	waitFor(t, "the listener's packet to reach the extension", func() bool {
		n, _, _ := s.ext.state()
		return n == 1
	})

	// As before this change, the listener's session ending does not stop it:
	// only extensions with a private channel are tied to it.
	_ = s.sm.DestroySession(s.owner.ID)
	time.Sleep(30 * time.Millisecond)
	if s.active() == nil {
		t.Error("an ordinary extension was stopped when the listener's session ended; that is new behaviour")
	}
}

func TestReattachingReplacesThePrivateChannel(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	s.attach()
	first := s.active().private
	s.attach()
	second := s.active().private
	defer s.aem.RemoveSession(privateIQOwnerUUID)

	if first == second {
		t.Fatal("re-attach kept the same channel")
	}
	if !s.rd.wasTerminated(first.session.SSRC) {
		t.Error("the replaced channel was not terminated")
	}
	if got := s.privateSessions(); len(got) != 1 || got[0] != second.session {
		t.Errorf("%d private sessions registered, want only the new one", len(got))
	}
	retuneOwner(t, s.sm, s.owner, 830000)
	waitFor(t, "the new channel to follow the listener", s.ext.retunedTo(830000))
}

// ── Failures ─────────────────────────────────────────────────────────────────

func TestExtensionFailingToCreateReleasesItsPrivateChannel(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", errors.New("no binary"))
	s.attach()
	if s.active() != nil {
		t.Fatal("attached despite the factory failing")
	}
	if len(s.privateSessions()) != 0 {
		t.Error("private session left behind by a failed create")
	}
	if len(s.rd.terminated) == 0 {
		t.Error("private radiod channel left behind by a failed create")
	}
}

func TestExtensionFailingToStartReleasesItsPrivateChannel(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	s.ext.startErr = errors.New("would not start")
	s.attach()
	if s.active() != nil {
		t.Fatal("attached despite Start failing")
	}
	if len(s.privateSessions()) != 0 {
		t.Error("private session left behind by a failed start")
	}
	if _, _, stopped := s.ext.state(); !stopped {
		t.Error("extension not stopped after its failed start")
	}
	// The listener can still retune without anything following a dead channel.
	retuneOwner(t, s.sm, s.owner, 830000)
	s.owner.mu.RLock()
	follower := s.owner.retuneFollower
	s.owner.mu.RUnlock()
	if follower != nil {
		t.Error("a failed start left the listener with a retune follower")
	}
}

func TestExtensionCrashReleasesItsPrivateChannel(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	s.attach()
	a := s.active()
	if a == nil || a.private == nil {
		t.Fatal("attached without a private channel")
	}
	defer s.aem.RemoveSession(privateIQOwnerUUID)
	priv := a.private.session

	s.ext.crash <- errors.New("subprocess exited")
	waitFor(t, "the private channel to be released after the crash", func() bool {
		return s.rd.wasTerminated(priv.SSRC)
	})
	// The client still detaches afterwards; that must be harmless.
	s.aem.RemoveSession(privateIQOwnerUUID)
	if len(s.privateSessions()) != 0 {
		t.Error("private session still registered")
	}
}

// ── Panics are contained ─────────────────────────────────────────────────────

func TestPanickingRetuneDoesNotStopTheChannelFollowing(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	s.ext.retunePanics = 1
	s.attach()
	defer s.aem.RemoveSession(privateIQOwnerUUID)

	retuneOwner(t, s.sm, s.owner, 830000) // Retune panics here
	waitFor(t, "the channel to settle on 830000", func() bool {
		return s.active().private.session.currentFrequency() == 830000 && !s.active().private.paused.Load()
	})
	retuneOwner(t, s.sm, s.owner, 840000)
	waitFor(t, "Retune(840000) after the earlier panic", s.ext.retunedTo(840000))
}

type panickingFollower struct{}

func (panickingFollower) followRetune(uint64) { panic("follower fault") }

func TestPanickingRetuneFollowerIsContained(t *testing.T) {
	sm, _, owner := newPrivateIQTestSetup(t)
	owner.setRetuneFollower(panickingFollower{})
	if err := sm.UpdateSessionChannel(owner.ID, 830000, "", 0, 0, false, nil); err != nil {
		t.Fatalf("retune failed: %v", err)
	}
	if owner.currentFrequency() != 830000 {
		t.Error("the retune itself did not take")
	}
}

// A follower whose dynamic type cannot be compared must not make clearing it
// panic, as comparing interface values would.
type uncomparableFollower struct{ seen []uint64 }

func (f uncomparableFollower) followRetune(uint64) {}

func TestClearingAnUncomparableFollowerDoesNotPanic(t *testing.T) {
	s := &Session{}
	gen := s.setRetuneFollower(uncomparableFollower{})
	s.clearRetuneFollower(gen + 1) // stale: must leave it alone
	if s.retuneFollower == nil {
		t.Error("a stale generation cleared the follower")
	}
	s.clearRetuneFollower(gen)
	if s.retuneFollower != nil {
		t.Error("the follower was not cleared by its own generation")
	}
	s.clearRetuneFollower(0) // never installed: a no-op
}
