package main

import (
	"strings"
	"testing"
	"time"
)

// countingExt is an extension that does nothing, for counting attaches.
type countingExt struct{ stopped bool }

func (e *countingExt) Start(in <-chan AudioSample, _ chan<- []byte) error {
	go func() {
		for range in {
		}
	}()
	return nil
}
func (e *countingExt) Stop() error     { e.stopped = true; return nil }
func (e *countingExt) GetName() string { return "counting" }

// limitsSetup is a manager with two extensions besides privtest: "cooled",
// with a restart cooldown and a private channel as HD Radio has, and "plain",
// with neither. created counts successful factory calls per name.
type limitsSetup struct {
	*privateIQManagerSetup
	created map[string]int
}

func newLimitsSetup(t *testing.T, cooldown time.Duration) *limitsSetup {
	t.Helper()
	s := &limitsSetup{privateIQManagerSetup: newPrivateIQManagerSetup(t, "iq48", nil), created: map[string]int{}}
	for _, name := range []string{"cooled", "plain"} {
		name := name
		info := AudioExtensionInfo{Name: name}
		if name == "cooled" {
			info.PrivateIQ = "iq48"
			info.DisplayName = "Cooled Decoder"
			info.RestartCooldown = cooldown
		}
		s.aem.registry.Register(name, func(AudioExtensionParams, map[string]interface{}) (AudioExtension, error) {
			s.created[name]++
			return &countingExt{}, nil
		}, info)
	}
	t.Cleanup(func() { s.aem.RemoveSession(privateIQOwnerUUID) })
	return s
}

func (s *limitsSetup) attachAs(uuid, name string) {
	_ = s.aem.handleAttach(uuid, nil, map[string]interface{}{"extension_name": name})
}

func (s *limitsSetup) detachAs(uuid string) {
	_ = s.aem.handleDetach(uuid, nil)
}

func (s *limitsSetup) running(uuid string) string {
	s.aem.activeExtensionsMu.RLock()
	defer s.aem.activeExtensionsMu.RUnlock()
	if a := s.aem.activeExtensions[uuid]; a != nil {
		return a.ExtensionName
	}
	return ""
}

func generousAttachLimit(t *testing.T) {
	t.Helper()
	b, r := attachBurst, attachRefillPerSec
	attachBurst, attachRefillPerSec = 1000, 1000
	t.Cleanup(func() { attachBurst, attachRefillPerSec = b, r })
}

// ── Restart cooldown ─────────────────────────────────────────────────────────

func TestRestartCooldownRefusesAQuickRestartBeforeCreatingAChannel(t *testing.T) {
	generousAttachLimit(t)
	s := newLimitsSetup(t, 200*time.Millisecond)

	s.attachAs(privateIQOwnerUUID, "cooled")
	s.detachAs(privateIQOwnerUUID)
	channels := len(s.rd.creates)
	s.attachAs(privateIQOwnerUUID, "cooled")
	if s.running(privateIQOwnerUUID) != "" || s.created["cooled"] != 1 {
		t.Fatal("restarted inside the cooldown")
	}
	if len(s.rd.creates) != channels {
		t.Error("a refused restart still created a radiod channel")
	}
	if err := s.aem.restartCooldownError("cooled", privateIQOwnerUUID); err == nil ||
		!strings.HasPrefix(err.Error(), "Cooled Decoder restarted too quickly — please wait ") {
		t.Errorf("refusal reads %v", err)
	}

	time.Sleep(220 * time.Millisecond)
	s.attachAs(privateIQOwnerUUID, "cooled")
	if s.running(privateIQOwnerUUID) != "cooled" {
		t.Error("still refused after the cooldown")
	}
}

func TestRestartCooldownIsNotStartedByTheServer(t *testing.T) {
	generousAttachLimit(t)
	s := newLimitsSetup(t, time.Hour)

	// The listener's audio session ends (a reconnect): the server stops the
	// extension, and the client re-attaches within 1.5 s. That must work.
	s.attachAs(privateIQOwnerUUID, "cooled")
	if err := s.sm.DestroySession(s.owner.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the extension to stop with the session", func() bool { return s.running(privateIQOwnerUUID) == "" })
	owner, err := s.sm.CreateSessionWithBandwidthAndPassword(820000, "am", 10000, "203.0.113.5", "203.0.113.5", privateIQOwnerUUID, "")
	if err != nil {
		t.Fatal(err)
	}
	s.owner = owner
	s.attachAs(privateIQOwnerUUID, "cooled")
	if s.running(privateIQOwnerUUID) != "cooled" {
		t.Fatal("a re-attach after a reconnect was refused by the cooldown")
	}

	// Closing the socket, though, is the listener's doing.
	s.aem.RemoveSession(privateIQOwnerUUID)
	if s.aem.restartCooldownError("cooled", privateIQOwnerUUID) == nil {
		t.Error("closing the socket did not start the cooldown")
	}
}

func TestRestartCooldownIsPerExtensionAndOptIn(t *testing.T) {
	generousAttachLimit(t)
	s := newLimitsSetup(t, time.Hour)

	// Replacing one extension with another: the cooldown is the stopped
	// one's, so the new one starts.
	s.attachAs(privateIQOwnerUUID, "cooled")
	s.attachAs(privateIQOwnerUUID, "plain")
	if s.running(privateIQOwnerUUID) != "plain" {
		t.Fatal("another extension was refused by cooled's cooldown")
	}
	// An extension without a cooldown restarts freely.
	s.detachAs(privateIQOwnerUUID)
	s.attachAs(privateIQOwnerUUID, "plain")
	if s.running(privateIQOwnerUUID) != "plain" {
		t.Error("an extension with no cooldown was refused a restart")
	}
}

// ── Attach rate limit ────────────────────────────────────────────────────────

func TestAttachRateLimitAllowsABurstThenRefuses(t *testing.T) {
	s := newLimitsSetup(t, 0)
	for i := 0; i < int(attachBurst); i++ {
		s.attachAs(privateIQOwnerUUID, "plain")
	}
	if s.created["plain"] != int(attachBurst) {
		t.Fatalf("%d of the first %d attaches went through", s.created["plain"], int(attachBurst))
	}
	s.attachAs(privateIQOwnerUUID, "plain")
	if s.created["plain"] != int(attachBurst) {
		t.Error("an attach past the burst went through")
	}
	// A refused attach leaves the running one alone.
	if s.running(privateIQOwnerUUID) != "plain" {
		t.Error("a refused attach tore down the running extension")
	}
}

func TestAttachRateLimitIsPerListenerAndSurvivesTheSocketClosing(t *testing.T) {
	s := newLimitsSetup(t, 0)
	for i := 0; i <= int(attachBurst); i++ {
		s.attachAs(privateIQOwnerUUID, "plain")
	}
	before := s.created["plain"]

	// Closing and reopening the socket does not refill it.
	s.aem.RemoveSession(privateIQOwnerUUID)
	s.attachAs(privateIQOwnerUUID, "plain")
	if s.created["plain"] != before {
		t.Error("closing the socket reset the attach budget")
	}

	// Another listener has a budget of their own.
	other := "22222222-3333-4444-8555-666666666666"
	if _, err := s.sm.CreateSessionWithBandwidthAndPassword(820000, "am", 10000, "198.51.100.7", "198.51.100.7", other, ""); err != nil {
		t.Fatal(err)
	}
	defer s.aem.RemoveSession(other)
	s.attachAs(other, "plain")
	if s.running(other) != "plain" {
		t.Error("one listener's exhausted budget refused another listener")
	}
}

func TestAttachRateLimitIsNotSpentWithoutASession(t *testing.T) {
	s := newLimitsSetup(t, 0)
	// The client's retries while its audio session is reconnecting.
	nobody := "33333333-4444-4555-8666-777777777777"
	for i := 0; i < 50; i++ {
		s.attachAs(nobody, "plain")
	}
	if _, err := s.sm.CreateSessionWithBandwidthAndPassword(820000, "am", 10000, "192.0.2.9", "192.0.2.9", nobody, ""); err != nil {
		t.Fatal(err)
	}
	defer s.aem.RemoveSession(nobody)
	s.attachAs(nobody, "plain")
	if s.running(nobody) != "plain" {
		t.Error("attaches refused for want of a session spent the budget")
	}
}

func TestAttachRateLimitExemptsBypassedListeners(t *testing.T) {
	s := newLimitsSetup(t, 0)
	s.sm.config.Server.TimeoutBypassIPs = []string{"203.0.113.5"}
	if err := s.sm.config.Server.parseTimeoutBypassIPs(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < int(attachBurst)*3; i++ {
		s.attachAs(privateIQOwnerUUID, "plain")
	}
	if s.created["plain"] != int(attachBurst)*3 {
		t.Errorf("a bypassed listener was limited: %d of %d", s.created["plain"], int(attachBurst)*3)
	}
}
