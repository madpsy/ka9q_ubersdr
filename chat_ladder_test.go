package main

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testClock is a movable clock for the chat manager.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

var ladderT0 = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

// newLadderEnv is a chat test env with a movable clock and a settings store.
func newLadderEnv(t *testing.T, dir string, mutate func(*ChatModerationSettings)) (*chatTestEnv, *testClock, *ChatModerationStore) {
	t.Helper()
	e := newChatTestEnv(t, dir, ladderT0)
	clk := &testClock{t: ladderT0}
	e.cm.now = clk.Now
	store := NewChatModerationStore(filepath.Join(dir, "chat_moderation.yaml"))
	if mutate != nil {
		s := store.Settings()
		mutate(&s)
		if _, _, _, err := store.Update(s); err != nil {
			t.Fatalf("store.Update: %v", err)
		}
	}
	e.cm.SetModerationStore(store)
	return e, clk, store
}

// joinConn joins a user and gives the session a fake connection.
func (e *chatTestEnv) joinConn(t *testing.T, sessionID, username, ip string) *websocket.Conn {
	t.Helper()
	c := &websocket.Conn{}
	e.out.mu.Lock()
	e.out.conns[sessionID] = c
	e.out.mu.Unlock()
	e.join(t, sessionID, username, ip)
	return c
}

// trySay sends a message 2 s after the last one (past the rate limit).
func trySay(e *chatTestEnv, clk *testClock, sessionID, text string) error {
	clk.Add(2 * time.Second)
	err := e.cm.SendMessage(sessionID, text)
	e.cm.logWG.Wait()
	return err
}

// sentOfType returns the frames of a type sent to one connection.
func (e *chatTestEnv) sentOfType(c *websocket.Conn, typ string) []map[string]interface{} {
	e.out.mu.Lock()
	defer e.out.mu.Unlock()
	var out []map[string]interface{}
	for _, m := range e.out.sent[c] {
		if m["type"] == typ {
			out = append(out, m)
		}
	}
	return out
}

func noticeData(t *testing.T, m map[string]interface{}) map[string]interface{} {
	t.Helper()
	return m["data"].(map[string]interface{})
}

// lastChatRow returns status, message, message_raw of the newest stored row.
func lastChatRow(t *testing.T, e *chatTestEnv) (status, msg, raw string) {
	t.Helper()
	var rawN *string
	if err := e.db.ReadDB().QueryRow(`SELECT status, message, message_raw FROM chat_messages ORDER BY id DESC LIMIT 1`).Scan(&status, &msg, &rawN); err != nil {
		t.Fatal(err)
	}
	if rawN != nil {
		raw = *rawN
	}
	return
}

func countActions(t *testing.T, e *chatTestEnv, action string) int {
	t.Helper()
	var n int
	if err := e.db.ReadDB().QueryRow(`SELECT COUNT(*) FROM chat_mod_actions WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---- send path ----

func TestChatSendOKAndCensored(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")

	if err := trySay(e, clk, "s1", "hello there"); err != nil {
		t.Fatal(err)
	}
	if st, msg, raw := lastChatRow(t, e); st != "ok" || msg != "hello there" || raw != "" {
		t.Fatalf("ok row = %q %q %q", st, msg, raw)
	}

	if err := trySay(e, clk, "s1", "what a shit day"); err != nil {
		t.Fatal(err)
	}
	msgs := e.out.ofType("chat_message")
	got := msgs[len(msgs)-1]["data"].(map[string]interface{})["message"]
	if got != "what a s**t day" {
		t.Fatalf("broadcast = %q", got)
	}
	if st, msg, raw := lastChatRow(t, e); st != "censored" || msg != "what a s**t day" || raw != "what a shit day" {
		t.Fatalf("censored row = %q %q %q", st, msg, raw)
	}
}

func TestChatSendBlocked(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) { s.Mode = "block" })
	c := e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	events := make(chan ChatEvent, 10)
	e.cm.OnChatEvent(func(ev ChatEvent) { events <- ev })

	before := len(e.out.ofType("chat_message"))
	bufBefore := len(e.cm.GetBufferedMessages())
	err := trySay(e, clk, "s1", "what a shit day")
	if !errors.Is(err, ErrMessageBlocked) {
		t.Fatalf("err = %v, want ErrMessageBlocked", err)
	}
	p := chatErrorPayload(err)
	if p["code"] != "blocked" || !strings.Contains(p["error"].(string), "isn't allowed") {
		t.Fatalf("chat_error = %v", p)
	}
	if n := len(e.out.ofType("chat_message")); n != before {
		t.Fatalf("blocked message was broadcast")
	}
	if n := len(e.cm.GetBufferedMessages()); n != bufBefore {
		t.Fatalf("blocked message was buffered")
	}
	select {
	case ev := <-events:
		t.Fatalf("blocked message fired an event: %+v", ev)
	case <-time.After(50 * time.Millisecond):
	}
	if st, msg, _ := lastChatRow(t, e); st != "blocked" || msg != "what a shit day" {
		t.Fatalf("blocked row = %q %q", st, msg)
	}
	// The strike still warned the sender.
	if n := len(e.sentOfType(c, "chat_notice")); n != 1 {
		t.Fatalf("want 1 auto warning, got %d", n)
	}
	// The next message's id must not collide with the blocked row's.
	if err := trySay(e, clk, "s1", "sorry"); err != nil {
		t.Fatal(err)
	}
	if st, _, _ := lastChatRow(t, e); st != "ok" {
		t.Fatalf("next message row status = %q", st)
	}
}

func TestChatSendLinkBlocked(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) { s.Links = "block" })
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	if err := trySay(e, clk, "s1", "see https://example.com/x"); !errors.Is(err, ErrMessageBlocked) {
		t.Fatalf("err = %v", err)
	}
	if err := trySay(e, clk, "s1", "listening on 14.074 MHz"); err != nil {
		t.Fatalf("plain message refused: %v", err)
	}
}

func TestChatRelayFiltered(t *testing.T) {
	e, _, store := newLadderEnv(t, t.TempDir(), nil)
	e.cm.InjectJoin("~bob", "telegram:chan:1")
	e.cm.InjectMessage("~bob", "this is shit", "telegram:chan", "telegram:chan:1")
	e.cm.logWG.Wait()
	msgs := e.out.ofType("chat_message")
	if got := msgs[len(msgs)-1]["data"].(map[string]interface{})["message"]; got != "this is s**t" {
		t.Fatalf("relayed = %q", got)
	}
	if st, _, raw := lastChatRow(t, e); st != "censored" || raw != "this is shit" {
		t.Fatalf("relayed row = %q raw %q", st, raw)
	}

	s := store.Settings()
	s.Mode = "block"
	store.Update(s)
	n := len(e.out.ofType("chat_message"))
	e.cm.InjectMessage("~bob", "this is shit", "telegram:chan", "telegram:chan:1")
	e.cm.logWG.Wait()
	if len(e.out.ofType("chat_message")) != n {
		t.Fatalf("blocked relay message was broadcast")
	}
	if st, _, _ := lastChatRow(t, e); st != "blocked" {
		t.Fatalf("blocked relay row status = %q", st)
	}
	// Relay users never strike.
	for i := 0; i < 5; i++ {
		e.cm.InjectMessage("~bob", "shit", "telegram:chan", "telegram:chan:1")
	}
	e.cm.logWG.Wait()
	if len(e.cm.ChatBans()) != 0 || countActions(t, e, "auto_warn") != 0 {
		t.Fatalf("relay user was struck")
	}
}

func TestChatUsernameFilter(t *testing.T) {
	e, _, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) { s.Words = []string{"zorglub"} })
	e.sm.uuidToIP["s1"] = "10.0.0.1"
	if err := e.cm.SetUsername("s1", "shit"); err != ErrProfaneUsername {
		t.Fatalf("built-in word: err = %v", err)
	}
	if err := e.cm.SetUsername("s1", "zorglub"); err != ErrProfaneUsername {
		t.Fatalf("custom word: err = %v", err)
	}
	if err := e.cm.SetUsername("s1", "G4ABC"); err != nil {
		t.Fatalf("callsign refused: %v", err)
	}
}

// ---- ladder ----

func TestChatLadderWarningsThenAutoBan(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil) // defaults: 3 in 10 min -> 60 min
	c := e.joinConn(t, "s1", "G4BAD", "10.0.0.1")
	other := e.joinConn(t, "s2", "G4OK", "10.0.0.2")

	for i := 1; i <= 2; i++ {
		if err := trySay(e, clk, "s1", "shit"); err != nil {
			t.Fatal(err)
		}
		notes := e.sentOfType(c, "chat_notice")
		if len(notes) != i {
			t.Fatalf("after strike %d: %d notices", i, len(notes))
		}
		d := noticeData(t, notes[i-1])
		if d["kind"] != "auto_warning" || d["strikes"] != i || d["limit"] != 3 {
			t.Fatalf("notice %d = %v", i, d)
		}
		text := d["text"].(string)
		if !strings.Contains(text, "warning "+string(rune('0'+i))+" of 3") || !strings.Contains(text, "1 hour") {
			t.Fatalf("notice text = %q", text)
		}
	}
	if n := countActions(t, e, "auto_warn"); n != 2 {
		t.Fatalf("auto_warn rows = %d", n)
	}
	if len(e.sentOfType(other, "chat_notice")) != 0 {
		t.Fatalf("warning reached another user")
	}

	// Third strike: chat ban.
	if err := trySay(e, clk, "s1", "shit"); err != nil {
		t.Fatal(err)
	}
	notes := e.sentOfType(c, "chat_notice")
	d := noticeData(t, notes[len(notes)-1])
	wantUntil := clk.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if d["kind"] != "chat_banned" || d["until"] != wantUntil || d["text"] != "You've been banned from chat. You can still listen to the receiver." {
		t.Fatalf("ban notice = %v (want until %s)", d, wantUntil)
	}
	if _, ok := e.cm.GetUsername("s1"); ok {
		t.Fatalf("banned user still in chat")
	}
	if _, ok := e.cm.GetUsername("s2"); !ok {
		t.Fatalf("other user removed")
	}
	left := e.out.ofType("chat_user_left")
	if len(left) == 0 || left[len(left)-1]["data"].(map[string]interface{})["username"] != "G4BAD" {
		t.Fatalf("no chat_user_left for the banned user")
	}
	if n := countActions(t, e, "auto_chat_ban"); n != 1 {
		t.Fatalf("auto_chat_ban rows = %d", n)
	}

	// Can't rejoin; the error carries the code and the end time.
	err := e.cm.SetUsername("s1", "G4BAD")
	var ce *ChatCodedError
	if !errors.As(err, &ce) || ce.Code != "chat_banned" || ce.Until.Format(time.RFC3339) != wantUntil {
		t.Fatalf("rejoin err = %v", err)
	}
	if p := chatErrorPayload(err); p["code"] != "chat_banned" || p["until"] != wantUntil {
		t.Fatalf("chat_error = %v", p)
	}

	// Expiry restores.
	clk.Add(61 * time.Minute)
	if err := e.cm.SetUsername("s1", "G4BAD"); err != nil {
		t.Fatalf("rejoin after expiry: %v", err)
	}
	// Strikes were cleared by the ban: the next one is warning 1 again.
	if err := trySay(e, clk, "s1", "shit"); err != nil {
		t.Fatal(err)
	}
	notes = e.sentOfType(c, "chat_notice")
	if d := noticeData(t, notes[len(notes)-1]); d["strikes"] != 1 {
		t.Fatalf("after ban, strikes = %v", d["strikes"])
	}
}

func TestChatLadderWindowExpiry(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	c := e.joinConn(t, "s1", "G4BAD", "10.0.0.1")
	trySay(e, clk, "s1", "shit")
	trySay(e, clk, "s1", "shit")
	clk.Add(11 * time.Minute)
	trySay(e, clk, "s1", "shit")
	notes := e.sentOfType(c, "chat_notice")
	if d := noticeData(t, notes[len(notes)-1]); d["kind"] != "auto_warning" || d["strikes"] != 1 {
		t.Fatalf("strike after window = %v", d)
	}
	if len(e.cm.ChatBans()) != 0 {
		t.Fatalf("banned for strikes outside the window")
	}
}

func TestChatLadderDisabled(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) { s.AutoModeration.Enabled = false })
	c := e.joinConn(t, "s1", "G4BAD", "10.0.0.1")
	for i := 0; i < 5; i++ {
		trySay(e, clk, "s1", "shit")
	}
	if len(e.sentOfType(c, "chat_notice")) != 0 || len(e.cm.ChatBans()) != 0 {
		t.Fatalf("automatic moderation ran while switched off")
	}
}

func TestChatLadderModeratorNeverStrikes(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	c := e.joinConn(t, "s1", "G4MOD", "10.0.0.1")
	e.cm.activeUsersMu.Lock()
	e.cm.activeUsers["s1"].Moderator = true
	e.cm.activeUsersMu.Unlock()
	for i := 0; i < 4; i++ {
		trySay(e, clk, "s1", "shit")
	}
	if len(e.sentOfType(c, "chat_notice")) != 0 || len(e.cm.ChatBans()) != 0 {
		t.Fatalf("moderator was struck")
	}
}

func TestChatBanSharedIPDeleteAndRefuseSend(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	c1 := e.joinConn(t, "s1", "G4ONE", "10.0.0.1")
	c2 := e.joinConn(t, "s2", "G4TWO", "10.0.0.1")
	e.joinConn(t, "s3", "G4OTHER", "10.0.0.9")
	trySay(e, clk, "s1", "hello")
	trySay(e, clk, "s3", "hi")

	res, err := e.cm.ChatBan("10.0.0.1", 15*time.Minute, "admin", "spam", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Removed) != 2 || res.Deleted != 1 || res.SDRBanned {
		t.Fatalf("result = %+v", res)
	}
	for _, c := range []*websocket.Conn{c1, c2} {
		notes := e.sentOfType(c, "chat_notice")
		if len(notes) != 1 || noticeData(t, notes[0])["kind"] != "chat_banned" {
			t.Fatalf("shared-IP user not told: %v", notes)
		}
	}
	if len(e.cm.GetBufferedMessages()) != 1 {
		t.Fatalf("banned user's messages not deleted")
	}

	// A message racing the ban is refused with the ban error.
	e.cm.modMu.Lock()
	e.cm.chatBans["10.0.0.9"] = &chatBanEntry{IP: "10.0.0.9", Until: clk.Now().Add(time.Hour)}
	e.cm.modMu.Unlock()
	var ce *ChatCodedError
	if err := trySay(e, clk, "s3", "hi"); !errors.As(err, &ce) || ce.Code != "chat_banned" {
		t.Fatalf("send while banned: %v", err)
	}
}

func TestChatBanLift(t *testing.T) {
	e, _, _ := newLadderEnv(t, t.TempDir(), nil)
	c := e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	if _, err := e.cm.ChatBan("10.0.0.1", time.Hour, "admin", "", "", false); err != nil {
		t.Fatal(err)
	}
	if e.cm.LiftChatBan("10.0.0.2", "admin") {
		t.Fatalf("lifted a ban that doesn't exist")
	}
	if !e.cm.LiftChatBan("10.0.0.1", "admin") {
		t.Fatalf("lift failed")
	}
	notes := e.sentOfType(c, "chat_notice")
	if d := noticeData(t, notes[len(notes)-1]); d["kind"] != "chat_ban_lifted" {
		t.Fatalf("lift notice = %v", d)
	}
	if err := e.cm.SetUsername("s1", "G4ABC"); err != nil {
		t.Fatalf("rejoin after lift: %v", err)
	}
	var lifted int
	e.db.ReadDB().QueryRow(`SELECT COUNT(*) FROM chat_mod_actions WHERE action='chat_ban' AND lifted_at IS NOT NULL`).Scan(&lifted)
	if lifted != 1 || countActions(t, e, "lift") != 1 {
		t.Fatalf("lift not recorded (lifted=%d)", lifted)
	}
}

func TestChatBanEscalation(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		e, clk, _ := newLadderEnv(t, t.TempDir(), func(s *ChatModerationSettings) {
			s.SDREscalation.Enabled = enabled
			s.SDREscalation.ChatBans = 2
			s.SDREscalation.WindowDays = 30
		})
		var calls []string
		e.cm.SetSDRBanFunc(func(ip, reason, by string) error {
			calls = append(calls, ip+"|"+by)
			return nil
		})
		e.joinConn(t, "s1", "G4BAD", "10.0.0.1")

		r1, _ := e.cm.ChatBan("10.0.0.1", 15*time.Minute, "admin", "", "", false)
		clk.Add(20 * time.Minute)
		r2, _ := e.cm.ChatBan("10.0.0.1", 15*time.Minute, "auto", "", "", false)
		if r1.SDRBanned {
			t.Fatalf("enabled=%v: escalated on the first chat ban", enabled)
		}
		if r2.SDRBanned != enabled || (len(calls) == 1) != enabled {
			t.Fatalf("enabled=%v: second ban escalated=%v calls=%v", enabled, r2.SDRBanned, calls)
		}
		if enabled && (calls[0] != "10.0.0.1|auto" || countActions(t, e, "auto_sdr_ban") != 1) {
			t.Fatalf("escalation call/record wrong: %v", calls)
		}
	}
}

func TestChatModStateAndWarn(t *testing.T) {
	e, _, _ := newLadderEnv(t, t.TempDir(), nil)
	c := e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	if n := e.cm.Warn("10.0.0.1", "", "be civil", "G4MOD"); n != 1 {
		t.Fatalf("warned %d sessions", n)
	}
	notes := e.sentOfType(c, "chat_notice")
	if d := noticeData(t, notes[0]); d["kind"] != "warning" || d["text"] != "A moderator has warned you: be civil" {
		t.Fatalf("warning = %v", d)
	}
	e.cm.ChatBan("10.0.0.1", time.Hour, "G4MOD", "rude", "", false)
	st := e.cm.ModStateFor()
	data := st["data"].(map[string]interface{})
	bans := data["bans"].([]map[string]interface{})
	if st["type"] != "chat_mod_state" || len(bans) != 1 || bans[0]["username"] != "G4ABC" || bans[0]["by"] != "G4MOD" {
		t.Fatalf("mod state = %v", st)
	}
	if w := data["warnings"].(map[string]int); w["G4ABC"] != 1 {
		t.Fatalf("warnings = %v", w)
	}
}

func TestChatBanPresetsAndFormatting(t *testing.T) {
	for _, s := range []int64{900, 3600, 86400, 604800, 2592000} {
		if !chatBanPresetOK(s) {
			t.Errorf("%d not a preset", s)
		}
	}
	if chatBanPresetOK(60) || chatBanPresetOK(0) {
		t.Errorf("non-preset accepted")
	}
	cases := map[time.Duration]string{15 * time.Minute: "15 minutes", time.Hour: "1 hour", 2 * time.Hour: "2 hours", 24 * time.Hour: "1 day", 7 * 24 * time.Hour: "7 days"}
	for d, want := range cases {
		if got := formatChatDuration(d); got != want {
			t.Errorf("formatChatDuration(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestChatStrikesPruned(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil) // 10-minute window
	e.joinConn(t, "s1", "G4BAD", "10.0.0.1")
	e.joinConn(t, "s2", "G4BAD2", "10.0.0.2")
	trySay(e, clk, "s1", "shit")
	clk.Add(6 * time.Minute)
	trySay(e, clk, "s2", "shit")
	clk.Add(5 * time.Minute) // s1's newest strike is now 11 minutes old
	e.cm.pruneStrikes()
	e.cm.modMu.Lock()
	_, kept1 := e.cm.strikes["10.0.0.1"]
	_, kept2 := e.cm.strikes["10.0.0.2"]
	e.cm.modMu.Unlock()
	if kept1 || !kept2 {
		t.Fatalf("pruned wrong: 10.0.0.1 kept=%v 10.0.0.2 kept=%v", kept1, kept2)
	}
}

func TestChatBanTextsHaveNoClockTime(t *testing.T) {
	e, _, _ := newLadderEnv(t, t.TempDir(), nil)
	c := e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	e.cm.ChatBan("10.0.0.1", 24*time.Hour, "admin", "", "", false)
	err := e.cm.SetUsername("s1", "G4ABC")
	texts := []string{err.Error(), noticeData(t, e.sentOfType(c, "chat_notice")[0])["text"].(string)}
	for _, txt := range texts {
		if strings.Contains(txt, "UTC") || strings.Contains(txt, ":") || strings.Contains(txt, "removed") || !strings.Contains(txt, "banned from chat") {
			t.Errorf("text %q", txt)
		}
	}
}
