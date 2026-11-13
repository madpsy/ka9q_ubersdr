package main

import (
	"errors"
	"testing"
	"time"
)

const exemptTestPW = "letmein"

// withBypass gives the env a server config with 10.9.0.0/24 on the bypass
// list and a bypass password.
func withBypass(t *testing.T, e *chatTestEnv) {
	t.Helper()
	cfg := &Config{}
	cfg.Server.TimeoutBypassIPs = []string{"10.9.0.0/24"}
	cfg.Server.BypassPassword = exemptTestPW
	if err := cfg.Server.parseTimeoutBypassIPs(); err != nil {
		t.Fatal(err)
	}
	e.sm.mu.Lock()
	e.sm.config = cfg
	e.sm.sessions = map[string]*Session{}
	e.sm.mu.Unlock()
}

// addAudioSession registers a radio session for a chat user, as the audio
// WebSocket would, optionally with a bypass password.
func addAudioSession(e *chatTestEnv, userSessionID, ip, password string) {
	e.sm.mu.Lock()
	e.sm.sessions["audio-"+userSessionID] = &Session{UserSessionID: userSessionID, ClientIP: ip, BypassPassword: password}
	e.sm.uuidToIP[userSessionID] = ip
	e.sm.mu.Unlock()
}

func TestChatExemptBypassIPSkipsFilterAndStrikes(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) { s.Mode = "block" })
	withBypass(t, e)
	c := e.joinConn(t, "s1", "G4BYP", "10.9.0.5")
	for i := 0; i < 4; i++ {
		if err := trySay(e, clk, "s1", "what a shit day"); err != nil {
			t.Fatalf("bypassed message %d refused: %v", i, err)
		}
	}
	msgs := e.out.ofType("chat_message")
	if got := msgs[len(msgs)-1]["data"].(map[string]interface{})["message"]; got != "what a shit day" {
		t.Fatalf("bypassed message altered: %q", got)
	}
	if len(e.sentOfType(c, "chat_notice")) != 0 || len(e.cm.ChatBans()) != 0 || countActions(t, e, "auto_warn") != 0 {
		t.Fatalf("bypassed user was struck")
	}
}

func TestChatExemptBypassPassword(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) { s.Mode = "block" })
	withBypass(t, e)
	addAudioSession(e, "s1", "203.0.113.7", exemptTestPW)
	addAudioSession(e, "s2", "203.0.113.8", "wrong")

	// Username filter is skipped for the password user only.
	if err := e.cm.SetUsername("s1", "shit"); err != nil {
		t.Fatalf("bypassed username refused: %v", err)
	}
	if err := e.cm.SetUsername("s2", "shit2"); err != ErrProfaneUsername {
		t.Fatalf("wrong password: err = %v", err)
	}
	if err := e.cm.SetUsername("s2", "G4NOPE"); err != nil {
		t.Fatal(err)
	}
	if err := trySay(e, clk, "s1", "shit"); err != nil {
		t.Fatalf("password-bypassed message refused: %v", err)
	}
	if err := trySay(e, clk, "s2", "shit"); !errors.Is(err, ErrMessageBlocked) {
		t.Fatalf("ordinary user: err = %v", err)
	}
}

func TestChatExemptModeratorUsername(t *testing.T) {
	e, _, _ := newLadderEnv(t, t.TempDir(), nil)
	e.sm.uuidToIP["s1"] = "10.0.0.1"
	if err := e.cm.setUsername("s1", "shit", true); err != nil {
		t.Fatalf("moderator username refused: %v", err)
	}
}

func TestChatExemptAutoBanSparesBypassedAndModerators(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	withBypass(t, e)
	// Three users behind one address: an ordinary user, a bypass-password
	// user and a moderator.
	addAudioSession(e, "s1", "198.51.100.1", "")
	addAudioSession(e, "s2", "198.51.100.1", exemptTestPW)
	e.sm.uuidToIP["s3"] = "198.51.100.1"
	bad := e.joinConn(t, "s1", "G4BAD", "198.51.100.1")
	byp := e.joinConn(t, "s2", "G4BYP", "198.51.100.1")
	if err := e.cm.setUsername("s3", "G4MOD", true); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 3; i++ {
		trySay(e, clk, "s1", "shit")
	}
	if len(e.cm.ChatBans()) != 1 {
		t.Fatalf("ordinary user not auto-banned")
	}
	if _, ok := e.cm.GetUsername("s1"); ok {
		t.Fatalf("ordinary user still in chat")
	}
	if _, ok := e.cm.GetUsername("s2"); !ok {
		t.Fatalf("bypassed user removed by an automatic ban")
	}
	if _, ok := e.cm.GetUsername("s3"); !ok {
		t.Fatalf("moderator removed by an automatic ban")
	}
	for _, n := range e.sentOfType(byp, "chat_notice") {
		if noticeData(t, n)["kind"] == "chat_banned" {
			t.Fatalf("bypassed user told they were banned")
		}
	}
	_ = bad
	if err := trySay(e, clk, "s2", "still here"); err != nil {
		t.Fatalf("bypassed user refused under an automatic ban: %v", err)
	}
	if err := trySay(e, clk, "s3", "still here"); err != nil {
		t.Fatalf("moderator refused under an automatic ban: %v", err)
	}
	if err := e.cm.SetUsername("s1", "G4BAD"); codeOf(err) != "chat_banned" {
		t.Fatalf("ordinary user rejoined: %v", err)
	}
}

func TestChatExemptManualBanStillAppliesToBypassed(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	withBypass(t, e)
	e.joinConn(t, "s1", "G4BYP", "10.9.0.5")
	e.sm.uuidToIP["s2"] = "10.9.0.5"
	if err := e.cm.setUsername("s2", "G4MOD", true); err != nil {
		t.Fatal(err)
	}
	res, err := e.cm.ChatBan("10.9.0.5", time.Hour, "admin", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Removed) != 1 || res.Removed[0] != "G4BYP" {
		t.Fatalf("removed = %v, want only the bypassed user", res.Removed)
	}
	if err := e.cm.SetUsername("s1", "G4BYP"); codeOf(err) != "chat_banned" {
		t.Fatalf("bypassed user rejoined under a manual ban: %v", err)
	}
	if err := trySay(e, clk, "s2", "hi"); err != nil {
		t.Fatalf("moderator refused under a manual ban: %v", err)
	}
}

func TestChatExemptNoSDREscalationForBypassed(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) {
		s.SDREscalation.Enabled = true
		s.SDREscalation.ChatBans = 2
		s.SDREscalation.WindowDays = 30
	})
	withBypass(t, e)
	var calls []string
	e.cm.SetSDRBanFunc(func(ip, reason, by string) error {
		calls = append(calls, ip)
		return nil
	})
	// Bypass list address, and an address with a bypass-password session.
	addAudioSession(e, "s2", "198.51.100.2", exemptTestPW)
	for _, ip := range []string{"10.9.0.5", "198.51.100.2"} {
		e.cm.ChatBan(ip, 15*time.Minute, "admin", "", "", false)
		clk.Add(20 * time.Minute)
		if r, _ := e.cm.ChatBan(ip, 15*time.Minute, "admin", "", "", false); r.SDRBanned {
			t.Fatalf("%s escalated to Ban from SDR", ip)
		}
	}
	if len(calls) != 0 {
		t.Fatalf("Ban from SDR called: %v", calls)
	}
}
