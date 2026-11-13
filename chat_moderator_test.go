package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ---- unit level: fake connections, fake admin sessions ----

// fakeModAuth stands in for the admin session store.
type fakeModAuth struct {
	mu     sync.Mutex
	tokens map[string]bool
	ipBad  map[string]bool
}

func newFakeModAuth() *fakeModAuth {
	return &fakeModAuth{tokens: map[string]bool{}, ipBad: map[string]bool{}}
}

func (a *fakeModAuth) ValidateAdminSession(token string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tokens[token]
}

func (a *fakeModAuth) AdminIPAllowed(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return !a.ipBad[ip]
}

func (a *fakeModAuth) revoke(token string) {
	a.mu.Lock()
	delete(a.tokens, token)
	a.mu.Unlock()
}

type modTestEnv struct {
	*chatTestEnv
	clk     *testClock
	auth    *fakeModAuth
	sdrBans []string
}

func newModTestEnv(t *testing.T) *modTestEnv {
	t.Helper()
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	m := &modTestEnv{chatTestEnv: e, clk: clk, auth: newFakeModAuth()}
	e.cm.mods.setAuth(m.auth)
	e.cm.SetSDRBanFunc(func(ip, reason, by string) error {
		m.sdrBans = append(m.sdrBans, ip+"|"+reason+"|"+by)
		return nil
	})
	return m
}

// joinMod joins a moderator: a connection holding a valid admin session.
func (m *modTestEnv) joinMod(t *testing.T, sessionID, username, ip string) *websocket.Conn {
	t.Helper()
	c := &websocket.Conn{}
	m.out.mu.Lock()
	m.out.conns[sessionID] = c
	m.out.mu.Unlock()
	m.sm.mu.Lock()
	m.sm.uuidToIP[sessionID] = ip
	m.sm.mu.Unlock()
	tok := "tok-" + sessionID
	m.auth.mu.Lock()
	m.auth.tokens[tok] = true
	m.auth.mu.Unlock()
	m.cm.mods.attach(c, tok, ip, sessionID)
	if err := m.cm.HandleChatMessage(sessionID, c, map[string]interface{}{"type": "chat_set_username", "username": username}); err != nil {
		t.Fatalf("join %s: %v", username, err)
	}
	return c
}

// mod sends a chat_mod and returns the error and the chat_mod_result data.
func (m *modTestEnv) mod(sessionID string, c *websocket.Conn, req map[string]interface{}) (error, map[string]interface{}) {
	req["type"] = "chat_mod"
	err := m.cm.HandleChatMessage(sessionID, c, req)
	m.cm.logWG.Wait()
	res := m.sentOfType(c, "chat_mod_result")
	if len(res) == 0 {
		return err, nil
	}
	return err, res[len(res)-1]["data"].(map[string]interface{})
}

func (m *modTestEnv) lastModerator(t *testing.T, c *websocket.Conn) bool {
	t.Helper()
	f := m.sentOfType(c, "chat_moderator")
	if len(f) == 0 {
		t.Fatalf("no chat_moderator frame")
	}
	return f[len(f)-1]["data"].(map[string]interface{})["enabled"].(bool)
}

func codeOf(err error) string {
	if ce, ok := err.(*ChatCodedError); ok {
		return ce.Code
	}
	return ""
}

func actionRow(t *testing.T, e *chatTestEnv, action string) (ip, username, by, reason string, count int) {
	t.Helper()
	var cnt *int
	if err := e.db.ReadDB().QueryRow(`SELECT ip, username, by_who, reason, count FROM chat_mod_actions WHERE action = ? ORDER BY id DESC LIMIT 1`, action).Scan(&ip, &username, &by, &reason, &cnt); err != nil {
		t.Fatalf("no %s row: %v", action, err)
	}
	if cnt != nil {
		count = *cnt
	}
	return
}

func TestChatModJoinGrantsModerator(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	uc := m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	// joinConn calls SetUsername directly; go through the socket path too
	if err := m.cm.HandleChatMessage("u1", uc, map[string]interface{}{"type": "chat_set_username", "username": "G4ABC"}); err != nil {
		t.Fatal(err)
	}
	if !m.lastModerator(t, mc) || m.lastModerator(t, uc) {
		t.Fatalf("moderator flags wrong")
	}
	if len(m.sentOfType(mc, "chat_mod_state")) != 1 || len(m.sentOfType(uc, "chat_mod_state")) != 0 {
		t.Fatalf("chat_mod_state on join wrong")
	}
	m.cm.activeUsersMu.RLock()
	modFlag, userFlag := m.cm.activeUsers["m1"].Moderator, m.cm.activeUsers["u1"].Moderator
	m.cm.activeUsersMu.RUnlock()
	if !modFlag || userFlag {
		t.Fatalf("ChatUser.Moderator = %v/%v", modFlag, userFlag)
	}

	// A revoked session joins as an ordinary user and is forgotten.
	m.auth.revoke("tok-m1")
	if err := m.cm.HandleChatMessage("m1", mc, map[string]interface{}{"type": "chat_set_username", "username": "G4MOD"}); err != nil {
		t.Fatal(err)
	}
	if m.lastModerator(t, mc) {
		t.Fatalf("revoked session still moderator")
	}
	if _, held := m.cm.mods.entry(mc); held {
		t.Fatalf("revoked token kept")
	}
}

func TestChatModNonModeratorRefused(t *testing.T) {
	m := newModTestEnv(t)
	m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	uc := m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	m.joinConn(t, "u2", "G4XYZ", "10.0.0.2")
	err, res := m.mod("u1", uc, map[string]interface{}{"action": "chat_ban", "username": "G4XYZ", "duration_sec": 3600.0})
	if codeOf(err) != "mod_denied" || res == nil || res["ok"] != false || res["action"] != "chat_ban" || res["username"] != "G4XYZ" {
		t.Fatalf("err=%v res=%v", err, res)
	}
	if len(m.cm.ChatBans()) != 0 || len(m.sentOfType(uc, "chat_mod_state")) != 0 {
		t.Fatalf("non-moderator action had an effect")
	}
	// The chat error frame carries the code
	if p := chatErrorPayload(err); p["code"] != "mod_denied" {
		t.Fatalf("payload %v", p)
	}
}

func TestChatModRevokedMidSession(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	if err, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "G4ABC"}); err != nil || res["ok"] != true {
		t.Fatalf("info before revoke: %v %v", err, res)
	}
	m.auth.revoke("tok-m1")
	err, res := m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4ABC"})
	if codeOf(err) != "mod_denied" || res["ok"] != false {
		t.Fatalf("after revoke: %v %v", err, res)
	}
	if m.lastModerator(t, mc) {
		t.Fatalf("not demoted")
	}
	if countActions(t, m.chatTestEnv, "warn") != 0 {
		t.Fatalf("warning recorded after revoke")
	}
	m.cm.activeUsersMu.RLock()
	flag := m.cm.activeUsers["m1"].Moderator
	m.cm.activeUsersMu.RUnlock()
	if flag {
		t.Fatalf("ChatUser still moderator")
	}
}

func TestChatModAddressNoLongerAllowed(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	m.auth.mu.Lock()
	m.auth.ipBad["10.0.0.9"] = true
	m.auth.mu.Unlock()
	if err, _ := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "G4ABC"}); codeOf(err) != "mod_denied" {
		t.Fatalf("err = %v", err)
	}
}

func TestChatModPeriodicRecheck(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	mc2 := m.joinMod(t, "m2", "G4MOD2", "10.0.0.8")
	m.cm.recheckModerators()
	if !m.lastModerator(t, mc) || !m.lastModerator(t, mc2) {
		t.Fatalf("valid moderators demoted")
	}
	m.auth.revoke("tok-m1")
	m.cm.recheckModerators()
	if m.lastModerator(t, mc) || !m.lastModerator(t, mc2) {
		t.Fatalf("recheck wrong")
	}
	if _, held := m.cm.mods.entry(mc); held {
		t.Fatalf("token kept after demotion")
	}
}

func TestChatModSecondConnectionSameSession(t *testing.T) {
	m := newModTestEnv(t)
	m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	other := &websocket.Conn{} // same session id, no admin session
	err, res := m.mod("m1", other, map[string]interface{}{"action": "info", "username": "G4ABC"})
	if codeOf(err) != "mod_denied" || res["ok"] != false || res["info"] != nil {
		t.Fatalf("second connection acted: %v %v", err, res)
	}
}

func TestChatModRefusals(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinMod(t, "m2", "G4OTHER", "10.0.0.8")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	m.joinConn(t, "u2", "G4SAME", "10.0.0.9") // shares the moderator's address
	m.cm.InjectJoin("~relay", "telegram:ch:1")

	refused := []map[string]interface{}{
		{"action": "warn", "username": "G4MOD"},
		{"action": "info", "username": "g4mod"},
		{"action": "chat_ban", "username": "G4OTHER", "duration_sec": 3600.0},
		{"action": "warn", "username": "~relay"},
		{"action": "chat_ban", "username": "~relay", "duration_sec": 3600.0},
		{"action": "sdr_ban", "username": "~relay"},
		{"action": "explode", "username": "G4ABC"},
		{"action": "", "username": "G4ABC"},
		{"action": "info", "username": "bad name"},
		{"action": "info", "username": "ABCDEFGHIJKLMNOP"},
		{"action": "info", "username": "~"},
		{"action": "info", "username": ""},
		{"action": "info", "username": 7.0},
		{"action": "info", "username": "NOBODY"},
		{"action": "chat_ban", "username": "G4ABC", "duration_sec": 60.0},
		{"action": "chat_ban", "username": "G4ABC", "duration_sec": 900.5},
		{"action": "chat_ban", "username": "G4ABC", "duration_sec": "3600"},
		{"action": "chat_ban", "username": "G4ABC"},
		{"action": "chat_ban", "username": "G4SAME", "duration_sec": 900.0},
		{"action": "sdr_ban", "username": "G4SAME"},
		{"action": "lift", "username": "G4ABC"}, // not banned
	}
	for _, req := range refused {
		m.clk.Add(chatModRateWindow) // stay clear of the rate limit
		desc, _ := json.Marshal(req)
		err, res := m.mod("m1", mc, req)
		if err != nil || res == nil || res["ok"] != false {
			t.Errorf("%s: err=%v res=%v", desc, err, res)
		}
	}
	if len(m.cm.ChatBans()) != 0 || len(m.sdrBans) != 0 || countActions(t, m.chatTestEnv, "warn") != 0 {
		t.Fatalf("a refused action had an effect")
	}

	// Relay users: info and delete are allowed.
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "~relay"}); res["ok"] != true || res["info"].(map[string]interface{})["relay"] != true {
		t.Fatalf("relay info: %v", res)
	}
	m.cm.InjectMessage("~relay", "hello from tg", "telegram:ch", "telegram:ch:1")
	m.cm.logWG.Wait()
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "~relay"}); res["ok"] != true || res["message"] != "Removed 1 message from ~relay" {
		t.Fatalf("relay delete: %v", res)
	}
}

func TestChatModRateLimit(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	for i := 0; i < chatModRateLimit; i++ {
		if _, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "G4ABC"}); res["ok"] != true {
			t.Fatalf("request %d refused: %v", i, res)
		}
	}
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "G4ABC"})
	if res["ok"] != false || !strings.Contains(res["message"].(string), "Too many") {
		t.Fatalf("not rate limited: %v", res)
	}
	m.clk.Add(chatModRateWindow)
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "G4ABC"}); res["ok"] != true {
		t.Fatalf("still limited after the window: %v", res)
	}
	// Ordinary connections are limited too (no reply flood).
	uc := m.joinConn(t, "u2", "G4XYZ", "10.0.0.2")
	for i := 0; i < chatModRateLimit+5; i++ {
		m.mod("u2", uc, map[string]interface{}{"action": "info", "username": "G4ABC"})
	}
	_, res = m.mod("u2", uc, map[string]interface{}{"action": "info", "username": "G4ABC"})
	if !strings.Contains(res["message"].(string), "Too many") {
		t.Fatalf("ordinary connection not limited: %v", res)
	}
	// Disconnecting forgets the counters.
	m.cm.mods.detach(uc)
	if len(m.cm.mods.rate) != 1 {
		t.Fatalf("rate entries = %d", len(m.cm.mods.rate))
	}
}

func TestChatModInfo(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	m.joinConn(t, "u2", "G4ABD", "10.0.0.1") // same address
	trySay(m.chatTestEnv, m.clk, "u1", "hello")
	trySay(m.chatTestEnv, m.clk, "u2", "hi")
	m.cm.Warn("10.0.0.1", "G4ABC", "be nice", "admin")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "g4abc"})
	info := res["info"].(map[string]interface{})
	if res["ok"] != true || info["username"] != "G4ABC" || info["in_chat"] != true || info["ip"] != "10.0.0.1" ||
		info["shared_ip_users"] != 1 || info["relay"] != false || info["moderator"] != false || info["message_count"] != 2 {
		t.Fatalf("info = %v", info)
	}
	if rec := info["record"].(ChatModRecord); rec.Warnings != 1 {
		t.Fatalf("record = %+v", rec)
	}
	if _, ok := info["chat_banned_until"]; ok {
		t.Fatalf("unexpected ban fields")
	}
	// Banned and left: still found, ban shown
	m.mod("m1", mc, map[string]interface{}{"action": "chat_ban", "username": "G4ABC", "duration_sec": 3600.0})
	_, res = m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "G4ABC"})
	info = res["info"].(map[string]interface{})
	if info["in_chat"] != false || info["chat_banned_until"] != m.clk.Now().Add(time.Hour).UTC().Format(time.RFC3339) || info["chat_ban_by"] != "admin G4MOD" {
		t.Fatalf("info after ban = %v", info)
	}
	// The JSON shape matches the contract
	b, _ := json.Marshal(info)
	if !strings.Contains(string(b), `"record":{"warnings":1,"chat_bans":1,`) {
		t.Fatalf("json = %s", b)
	}
}

func TestChatModWarn(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	tc := m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	sc := m.joinConn(t, "u2", "G4ABD", "10.0.0.1") // same address, not the target
	oc := m.joinConn(t, "u3", "G4XYZ", "10.0.0.3")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4ABC", "reason": "  stop\x07 that\nnow  "})
	if res["ok"] != true || res["message"] != "G4ABC has been warned" {
		t.Fatalf("res = %v", res)
	}
	notes := m.sentOfType(tc, "chat_notice")
	if len(notes) != 1 || noticeData(t, notes[0])["text"] != "A moderator has warned you: stop that now" || noticeData(t, notes[0])["kind"] != "warning" {
		t.Fatalf("notice = %v", notes)
	}
	if len(m.sentOfType(sc, "chat_notice")) != 0 || len(m.sentOfType(oc, "chat_notice")) != 0 || len(m.out.ofType("chat_notice")) != 0 {
		t.Fatalf("warning reached others")
	}
	ip, user, by, reason, _ := actionRow(t, m.chatTestEnv, "warn")
	if ip != "10.0.0.1" || user != "G4ABC" || by != "admin G4MOD" || reason != "stop that now" {
		t.Fatalf("row = %s %s %s %q", ip, user, by, reason)
	}
	// Default text, and a long reason is capped
	m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4XYZ"})
	if n := m.sentOfType(oc, "chat_notice"); noticeData(t, n[0])["text"] != "A moderator has warned you: please keep chat friendly" {
		t.Fatalf("default = %v", n)
	}
	m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4XYZ", "reason": strings.Repeat("é", 300)})
	if _, _, _, reason, _ := actionRow(t, m.chatTestEnv, "warn"); len([]rune(reason)) != chatModReasonMaxLen {
		t.Fatalf("reason length %d", len([]rune(reason)))
	}
	// Someone who left: recorded, plainly reported
	m.cm.RemoveUser("u3")
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4XYZ"}); res["ok"] != true || !strings.Contains(res["message"].(string), "isn't in chat") {
		t.Fatalf("left = %v", res)
	}
}

func TestChatModDeleteUser(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	m.joinConn(t, "u2", "G4XYZ", "10.0.0.2")
	trySay(m.chatTestEnv, m.clk, "u1", "one")
	trySay(m.chatTestEnv, m.clk, "u2", "keep")
	trySay(m.chatTestEnv, m.clk, "u1", "two")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4ABC"})
	if res["ok"] != true || res["message"] != "Removed 2 messages from G4ABC" {
		t.Fatalf("res = %v", res)
	}
	if len(m.out.ofType("chat_messages_deleted")) != 1 || len(m.cm.GetBufferedMessages()) != 1 {
		t.Fatalf("not deleted")
	}
	if ip, user, by, _, count := actionRow(t, m.chatTestEnv, "delete"); ip != "10.0.0.1" || user != "G4ABC" || by != "admin G4MOD" || count != 2 {
		t.Fatalf("row = %s %s %s %d", ip, user, by, count)
	}
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4ABC"}); res["message"] != "G4ABC has no messages to remove" {
		t.Fatalf("second delete = %v", res)
	}
}

func TestChatModChatBanAndLift(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	tc := m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	trySay(m.chatTestEnv, m.clk, "u1", "spam")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "chat_ban", "username": "G4ABC", "duration_sec": 3600.0, "reason": "spam", "delete": true})
	if res["ok"] != true || res["message"] != "G4ABC is banned from chat for 1 hour, and their messages were removed" {
		t.Fatalf("res = %v", res)
	}
	if _, in := m.cm.GetUsername("u1"); in || len(m.cm.GetBufferedMessages()) != 0 {
		t.Fatalf("not removed / not deleted")
	}
	if n := m.sentOfType(tc, "chat_notice"); len(n) != 1 || noticeData(t, n[0])["kind"] != "chat_banned" {
		t.Fatalf("notice = %v", n)
	}
	if ip, user, by, reason, _ := actionRow(t, m.chatTestEnv, "chat_ban"); ip != "10.0.0.1" || user != "G4ABC" || by != "admin G4MOD" || reason != "spam" {
		t.Fatalf("row = %s %s %s %s", ip, user, by, reason)
	}
	// The user has left; lift still resolves them by name
	_, res = m.mod("m1", mc, map[string]interface{}{"action": "lift", "username": "G4ABC"})
	if res["ok"] != true || res["message"] != "G4ABC can join the chat again" || len(m.cm.ChatBans()) != 0 {
		t.Fatalf("lift = %v", res)
	}
	if _, _, by, _, _ := actionRow(t, m.chatTestEnv, "lift"); by != "admin G4MOD" {
		t.Fatalf("lift by %s", by)
	}
}

func TestChatModSDRBan(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	trySay(m.chatTestEnv, m.clk, "u1", "bad")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "sdr_ban", "username": "G4ABC", "reason": "abuse"})
	if res["ok"] != true || res["message"] != "G4ABC is banned from the SDR" {
		t.Fatalf("res = %v", res)
	}
	if len(m.sdrBans) != 1 || m.sdrBans[0] != "10.0.0.1|abuse|admin G4MOD" {
		t.Fatalf("ban calls = %v", m.sdrBans)
	}
	if len(m.cm.GetBufferedMessages()) != 0 {
		t.Fatalf("messages not deleted")
	}
	if _, in := m.cm.GetUsername("u1"); in {
		t.Fatalf("still in chat")
	}
	if ip, user, by, reason, count := actionRow(t, m.chatTestEnv, "sdr_ban"); ip != "10.0.0.1" || user != "G4ABC" || by != "admin G4MOD" || reason != "abuse" || count != 1 {
		t.Fatalf("row = %s %s %s %s %d", ip, user, by, reason, count)
	}
	// Without a ban function it is refused plainly
	m.cm.SetSDRBanFunc(nil)
	m.joinConn(t, "u2", "G4XYZ", "10.0.0.2")
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "sdr_ban", "username": "G4XYZ"}); res["ok"] != false {
		t.Fatalf("no fn = %v", res)
	}
}

func TestChatModStateOnlyToModerators(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	mc2 := m.joinMod(t, "m2", "G4MOD2", "10.0.0.8")
	gone := m.joinMod(t, "m3", "G4MOD3", "10.0.0.7")
	m.cm.RemoveUser("m3") // left chat: no moderation data
	uc := m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	m.joinConn(t, "u2", "G4XYZ", "10.0.0.2")
	before1, before2, beforeGone := len(m.sentOfType(mc, "chat_mod_state")), len(m.sentOfType(mc2, "chat_mod_state")), len(m.sentOfType(gone, "chat_mod_state"))
	m.mod("m1", mc, map[string]interface{}{"action": "chat_ban", "username": "G4XYZ", "duration_sec": 900.0})
	if len(m.sentOfType(mc, "chat_mod_state")) <= before1 || len(m.sentOfType(mc2, "chat_mod_state")) <= before2 {
		t.Fatalf("moderators not told")
	}
	if len(m.sentOfType(gone, "chat_mod_state")) != beforeGone || len(m.sentOfType(uc, "chat_mod_state")) != 0 || len(m.out.ofType("chat_mod_state")) != 0 {
		t.Fatalf("chat_mod_state reached a non-moderator")
	}
	// A moderator whose session ended is demoted instead of told.
	m.auth.revoke("tok-m2")
	n2 := len(m.sentOfType(mc2, "chat_mod_state"))
	m.mod("m1", mc, map[string]interface{}{"action": "lift", "username": "G4XYZ"})
	if len(m.sentOfType(mc2, "chat_mod_state")) != n2 || m.lastModerator(t, mc2) {
		t.Fatalf("ended session still told")
	}
	// No frame to anyone carries an address except to moderators
	m.out.mu.Lock()
	defer m.out.mu.Unlock()
	for _, f := range m.out.broadcasts {
		b, _ := json.Marshal(f)
		if strings.Contains(string(b), "10.0.0.") {
			t.Fatalf("broadcast carries an address: %s", b)
		}
	}
	for _, f := range m.out.sent[uc] {
		b, _ := json.Marshal(f)
		if strings.Contains(string(b), "10.0.0.") {
			t.Fatalf("user frame carries an address: %s", b)
		}
	}
}

func TestChatModOwnerCallsign(t *testing.T) {
	m := newModTestEnv(t)
	m.cm.adminCallsign = "G0OWN-2"
	m.cm.ownerCallsignFromAdminIPOnly = true
	ac := &AdminConfig{AllowedIPs: []string{"10.0.0.9/32"}}
	if err := ac.parseAllowedIPs(); err != nil {
		t.Fatal(err)
	}
	m.cm.adminConfig = ac
	m.sm.mu.Lock()
	m.sm.uuidToIP["u1"] = "10.0.0.1"
	m.sm.mu.Unlock()
	if err := m.cm.HandleChatMessage("u1", &websocket.Conn{}, map[string]interface{}{"type": "chat_set_username", "username": "G0OWN"}); err != ErrOwnerCallsignRestricted {
		t.Fatalf("ordinary user got the owner callsign: %v", err)
	}
	mc := m.joinMod(t, "m1", "G0OWN", "10.0.0.5")
	if !m.lastModerator(t, mc) {
		t.Fatalf("moderator refused the owner callsign")
	}
}

func TestChatModHelpers(t *testing.T) {
	for name, want := range map[string]bool{"G4ABC": true, "M0/G4ABC": true, "~tg_user": true, "~_x": true, "~": false, "-G4": false, "G4 ABC": false, "ABCDEFGHIJKLMNOP": false, "~ABCDEFGHIJKLMNO": false, "~ABCDEFGHIJKLMN": true} {
		if validModTarget(name) != want {
			t.Errorf("validModTarget(%q) != %v", name, want)
		}
	}
	if got := cleanModReason("\t a\x00b c  \r\n d "); got != "a b c d" {
		t.Errorf("cleanModReason = %q", got)
	}
	if r := chatTokenRef("secret-token"); len(r) != 8 || strings.Contains("secret-token", r) {
		t.Errorf("token ref %q", r)
	}
}

// ---- over a real socket: the handshake decides ----

type modSocketEnv struct {
	h     *DXClusterWebSocketHandler
	cm    *ChatManager
	sm    *SessionManager
	ah    *AdminHandler
	srv   *httptest.Server
	host  string
	mu    sync.Mutex
	raw   []string // every frame any client received
	conns []*websocket.Conn
}

func newModSocketEnv(t *testing.T, allowedIPs []string) *modSocketEnv {
	t.Helper()
	dir := t.TempDir()
	db, err := NewDBManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	sm := &SessionManager{
		config:               &Config{},
		uuidToIP:             map[string]string{},
		userAgents:           map[string]string{},
		userAgentLastSeen:    map[string]time.Time{},
		kickedUUIDs:          map[string]time.Time{},
		kickedUUIDLastLogged: map[string]time.Time{},
	}
	ban := NewIPBanManager(filepath.Join(dir, "banned_ips.yaml"))
	h := &DXClusterWebSocketHandler{
		clients:           map[*websocket.Conn]*sync.Mutex{},
		dxCluster:         &DXClusterClient{},
		sessions:          sm,
		ipBanManager:      ban,
		connToSessionID:   map[*websocket.Conn]string{},
		connSubscriptions: map[*websocket.Conn]*Subscriptions{},
		dxBytesSent:       map[string]uint64{},
		dxBytesSamples:    map[string][]BytesSample{},
		upgrader:          websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
	logger, _ := NewChatLogger(dir, true)
	cm := NewChatManager(h, sm, 50, 0, 0, 0, 0, logger, nil, &AdminConfig{}, ChatConfig{}, ban)
	cm.SetDB(db.DB())
	cm.SetReadDB(db.ReadDB())
	h.chatManager = cm
	ah := &AdminHandler{adminSessions: NewAdminSessionStore(nil), config: &Config{Admin: AdminConfig{AllowedIPs: allowedIPs}}}
	if err := ah.config.Admin.parseAllowedIPs(); err != nil {
		t.Fatal(err)
	}
	h.SetModeratorAuth(ah)
	srv := httptest.NewServer(http.HandlerFunc(h.HandleWebSocket))
	e := &modSocketEnv{h: h, cm: cm, sm: sm, ah: ah, srv: srv, host: strings.TrimPrefix(srv.URL, "http://")}
	t.Cleanup(func() {
		e.mu.Lock()
		for _, c := range e.conns {
			c.Close()
		}
		e.mu.Unlock()
		srv.Close()
	})
	return e
}

type modSocketClient struct {
	conn   *websocket.Conn
	frames chan map[string]interface{}
}

// dial opens a socket for session id with the given Origin and admin cookie.
func (e *modSocketEnv) dial(t *testing.T, id, origin, token string) *modSocketClient {
	t.Helper()
	e.sm.mu.Lock()
	e.sm.userAgents[id] = "test"
	e.sm.uuidToIP[id] = "127.0.0.1"
	e.sm.mu.Unlock()
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	if token != "" {
		hdr.Set("Cookie", "admin_session="+token)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+e.host+"/ws/dxcluster?user_session_id="+id, hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &modSocketClient{conn: conn, frames: make(chan map[string]interface{}, 256)}
	e.mu.Lock()
	e.conns = append(e.conns, conn)
	e.mu.Unlock()
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				close(c.frames)
				return
			}
			e.mu.Lock()
			e.raw = append(e.raw, string(data))
			e.mu.Unlock()
			var m map[string]interface{}
			if json.Unmarshal(data, &m) == nil {
				c.frames <- m
			}
		}
	}()
	c.send(t, map[string]interface{}{"type": "subscribe_chat"})
	c.wait(t, "subscription_status")
	return c
}

func (c *modSocketClient) send(t *testing.T, m map[string]interface{}) {
	t.Helper()
	if err := c.conn.WriteJSON(m); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// wait returns the next frame of type typ, skipping others.
func (c *modSocketClient) wait(t *testing.T, typ string) map[string]interface{} {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m, ok := <-c.frames:
			if !ok {
				t.Fatalf("socket closed waiting for %s", typ)
			}
			if m["type"] == typ {
				return m
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}

// drain returns every frame that arrives within d.
func (c *modSocketClient) drain(d time.Duration) []map[string]interface{} {
	var out []map[string]interface{}
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-c.frames:
			if !ok {
				return out
			}
			out = append(out, m)
		case <-deadline:
			return out
		}
	}
}

func (c *modSocketClient) join(t *testing.T, name string) bool {
	t.Helper()
	c.send(t, map[string]interface{}{"type": "chat_set_username", "username": name})
	return c.wait(t, "chat_moderator")["data"].(map[string]interface{})["enabled"].(bool)
}

func (e *modSocketEnv) assertNoToken(t *testing.T, tokens ...string) {
	t.Helper()
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, f := range e.raw {
		for _, tok := range tokens {
			if tok != "" && strings.Contains(f, tok) {
				t.Fatalf("token leaked in frame: %s", f)
			}
		}
	}
}

func TestChatModeratorHandshake(t *testing.T) {
	cases := []struct {
		name    string
		allowed []string
		origin  func(e *modSocketEnv) string
		token   func(e *modSocketEnv) string
		want    bool
	}{
		{"own origin, valid session", nil, func(e *modSocketEnv) string { return "http://" + e.host }, validToken, true},
		{"own origin, upper case", nil, func(e *modSocketEnv) string { return "HTTP://" + strings.ToUpper(e.host) }, validToken, true},
		{"foreign origin", nil, func(e *modSocketEnv) string { return "https://evil.example" }, validToken, false},
		{"foreign origin, same host other port", nil, func(e *modSocketEnv) string { return "http://127.0.0.1:1" }, validToken, false},
		{"missing origin", nil, func(e *modSocketEnv) string { return "" }, validToken, false},
		{"null origin", nil, func(e *modSocketEnv) string { return "null" }, validToken, false},
		{"unknown token", nil, func(e *modSocketEnv) string { return "http://" + e.host }, func(*modSocketEnv) string { return "not-a-session" }, false},
		{"expired token", nil, func(e *modSocketEnv) string { return "http://" + e.host }, expiredToken, false},
		{"no cookie", nil, func(e *modSocketEnv) string { return "http://" + e.host }, func(*modSocketEnv) string { return "" }, false},
		{"address not allowed", []string{"10.9.9.9/32"}, func(e *modSocketEnv) string { return "http://" + e.host }, validToken, false},
		{"address allowed", []string{"127.0.0.1/32"}, func(e *modSocketEnv) string { return "http://" + e.host }, validToken, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newModSocketEnv(t, tc.allowed)
			tok := tc.token(e)
			c := e.dial(t, "11111111-1111-4111-8111-111111111111", tc.origin(e), tok)
			if got := c.join(t, "G4MOD"); got != tc.want {
				t.Fatalf("moderator = %v, want %v", got, tc.want)
			}
			if tc.want {
				c.wait(t, "chat_mod_state")
			} else {
				for _, f := range c.drain(200 * time.Millisecond) {
					if f["type"] == "chat_mod_state" {
						t.Fatalf("non-moderator got chat_mod_state")
					}
				}
				// And can't act
				c.send(t, map[string]interface{}{"type": "chat_mod", "action": "info", "username": "G4XYZ"})
				if r := c.wait(t, "chat_mod_result"); r["data"].(map[string]interface{})["ok"] != false {
					t.Fatalf("non-moderator acted: %v", r)
				}
				if e := c.wait(t, "chat_error"); e["code"] != "mod_denied" {
					t.Fatalf("chat_error = %v", e)
				}
			}
			e.assertNoToken(t, tok)
		})
	}
}

func validToken(e *modSocketEnv) string { return e.ah.adminSessions.CreateSession("127.0.0.1", "test") }

func expiredToken(e *modSocketEnv) string {
	tok := e.ah.adminSessions.CreateSession("127.0.0.1", "test")
	e.ah.adminSessions.mu.Lock()
	e.ah.adminSessions.sessions[tok].ExpiresAt = time.Now().Add(-time.Minute)
	e.ah.adminSessions.mu.Unlock()
	return tok
}

func TestChatModeratorSocketRevokeAndSecondConnection(t *testing.T) {
	e := newModSocketEnv(t, nil)
	tok := validToken(e)
	own := "http://" + e.host
	modID := "22222222-2222-4222-8222-222222222222"
	mod := e.dial(t, modID, own, tok)
	if !mod.join(t, "G4MOD") {
		t.Fatalf("not a moderator")
	}
	mod.wait(t, "chat_mod_state")
	user := e.dial(t, "33333333-3333-4333-8333-333333333333", own, "")
	if user.join(t, "G4ABC") {
		t.Fatalf("user is a moderator")
	}

	// Info works and carries the address to the moderator only
	mod.send(t, map[string]interface{}{"type": "chat_mod", "action": "info", "username": "G4ABC"})
	r := mod.wait(t, "chat_mod_result")["data"].(map[string]interface{})
	if r["ok"] != true || r["info"].(map[string]interface{})["ip"] != "127.0.0.1" {
		t.Fatalf("info = %v", r)
	}

	// A second connection on the moderator's session id without the cookie
	// gets nothing, even though the session is in chat as a moderator.
	twin := e.dial(t, modID, own, "")
	twin.send(t, map[string]interface{}{"type": "chat_mod", "action": "warn", "username": "G4ABC"})
	if r := twin.wait(t, "chat_mod_result")["data"].(map[string]interface{}); r["ok"] != false {
		t.Fatalf("twin acted: %v", r)
	}
	if e := twin.wait(t, "chat_error"); e["code"] != "mod_denied" {
		t.Fatalf("twin error = %v", e)
	}

	// Sign out: the very next action is refused and moderator tools go off
	e.ah.adminSessions.DeleteSession(tok)
	mod.send(t, map[string]interface{}{"type": "chat_mod", "action": "warn", "username": "G4ABC"})
	if r := mod.wait(t, "chat_mod_result")["data"].(map[string]interface{}); r["ok"] != false {
		t.Fatalf("acted after logout: %v", r)
	}
	if m := mod.wait(t, "chat_moderator"); m["data"].(map[string]interface{})["enabled"] != false {
		t.Fatalf("not demoted: %v", m)
	}
	if e := mod.wait(t, "chat_error"); e["code"] != "mod_denied" {
		t.Fatalf("error = %v", e)
	}
	for _, f := range user.drain(200 * time.Millisecond) {
		if f["type"] == "chat_notice" || f["type"] == "chat_mod_state" || f["type"] == "chat_mod_result" {
			t.Fatalf("user got %v", f)
		}
	}
	// A fresh sign-in on the same socket doesn't bring it back: the cookie is
	// only read at the handshake.
	tok2 := validToken(e)
	if mod.join(t, "G4MOD") {
		t.Fatalf("moderator again without a new handshake")
	}
	e.assertNoToken(t, tok, tok2)

	// Disconnecting forgets the connection
	mod.conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for len(e.cm.mods.all()) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := len(e.cm.mods.all()); n != 0 {
		t.Fatalf("%d sessions kept after disconnect", n)
	}
}

func TestChatModeratorSocketRecheckDemotes(t *testing.T) {
	e := newModSocketEnv(t, nil)
	tok := validToken(e)
	mod := e.dial(t, "44444444-4444-4444-8444-444444444444", "http://"+e.host, tok)
	if !mod.join(t, "G4MOD") {
		t.Fatalf("not a moderator")
	}
	e.ah.adminSessions.ForceDeleteSession(tok)
	e.cm.recheckModerators()
	if m := mod.wait(t, "chat_moderator"); m["data"].(map[string]interface{})["enabled"] != false {
		t.Fatalf("not demoted: %v", m)
	}
	e.assertNoToken(t, tok)
}

// ---- AuthMiddleware: the shared host check must not change its behaviour ----

func TestAdminAuthMiddlewareCSRFUnchanged(t *testing.T) {
	ah := &AdminHandler{adminSessions: NewAdminSessionStore(nil), config: &Config{}, ipBanManager: NewIPBanManager(filepath.Join(t.TempDir(), "b.yaml"))}
	tok := ah.adminSessions.CreateSession("192.0.2.1", "test")
	ok := ah.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	cases := []struct {
		name            string
		origin, referer string
		xfh             string
		cookie          string
		want            int
	}{
		{"same origin", "http://admin.example:8080", "", "", tok, http.StatusTeapot},
		{"foreign origin", "http://evil.example", "", "", tok, http.StatusForbidden},
		{"same referer", "", "http://admin.example:8080/admin.html", "", tok, http.StatusTeapot},
		{"foreign referer", "", "http://evil.example/x", "", tok, http.StatusForbidden},
		{"neither", "", "", "", tok, http.StatusTeapot},
		{"untrusted forwarded host", "http://public.example", "", "public.example", tok, http.StatusForbidden},
		{"no session", "http://admin.example:8080", "", "", "", http.StatusUnauthorized},
		{"bad session", "http://admin.example:8080", "", "", "nope", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "http://admin.example:8080/admin/x", nil)
		req.RemoteAddr = "192.0.2.1:5000"
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		if tc.referer != "" {
			req.Header.Set("Referer", tc.referer)
		}
		if tc.xfh != "" {
			req.Header.Set("X-Forwarded-Host", tc.xfh)
		}
		if tc.cookie != "" {
			req.AddCookie(&http.Cookie{Name: "admin_session", Value: tc.cookie})
		}
		rec := httptest.NewRecorder()
		ok(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: status %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
	// The socket check uses the same hosts but needs an Origin
	req := httptest.NewRequest(http.MethodGet, "http://admin.example:8080/ws/dxcluster", nil)
	if adminOriginMatches(req) {
		t.Errorf("missing Origin accepted")
	}
	req.Header.Set("Origin", "http://admin.example:8080")
	if !adminOriginMatches(req) {
		t.Errorf("own Origin refused")
	}
	req.Header.Set("Origin", "ftp://admin.example:8080")
	if adminOriginMatches(req) {
		t.Errorf("non-http Origin accepted")
	}
}

// ---- review fixes ----

func TestChatModNeverActsOnModeratorAddresses(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinMod(t, "m2", "G4MOD2", "10.0.0.8")
	m.joinConn(t, "u1", "G4NEAR", "10.0.0.8") // on another moderator's address

	// An admin session held by a connection that hasn't joined chat.
	m.cm.mods.attach(&websocket.Conn{}, "tok-x", "10.0.0.7", "mx")
	m.joinConn(t, "u2", "G4HELD", "10.0.0.7")

	// A chat user flagged as a moderator (no held connection).
	m.joinConn(t, "m3", "G4FLAG", "10.0.0.6")
	m.cm.activeUsersMu.Lock()
	m.cm.activeUsers["m3"].Moderator = true
	m.cm.activeUsersMu.Unlock()
	m.joinConn(t, "u3", "G4BYFLAG", "10.0.0.6")

	trySay(m.chatTestEnv, m.clk, "u1", "hello")
	for _, name := range []string{"G4NEAR", "G4HELD", "G4BYFLAG"} {
		for _, req := range []map[string]interface{}{
			{"action": "warn", "username": name},
			{"action": "chat_ban", "username": name, "duration_sec": 900.0},
			{"action": "sdr_ban", "username": name},
		} {
			m.clk.Add(chatModRateWindow)
			_, res := m.mod("m1", mc, req)
			if res["ok"] != false || !strings.Contains(res["message"].(string), "a moderator") {
				t.Errorf("%s %v: %v", name, req["action"], res)
			}
		}
	}
	if len(m.cm.ChatBans()) != 0 || len(m.sdrBans) != 0 || countActions(t, m.chatTestEnv, "warn") != 0 {
		t.Fatalf("an action reached a moderator's address")
	}
	// A moderator flagged in chat is refused by name too.
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4FLAG"}); res["ok"] != false || res["message"] != "G4FLAG is also a moderator." {
		t.Fatalf("flagged moderator = %v", res)
	}
	// Deleting a user who is in chat only touches their own messages, so it
	// is allowed even on a moderator's address.
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4NEAR"}); res["ok"] != true || res["message"] != "Removed 1 message from G4NEAR" {
		t.Fatalf("delete in chat = %v", res)
	}
	// Once they have left, delete falls back to the address: refused.
	m.cm.RemoveUser("u1")
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4NEAR"}); res["ok"] != false || !strings.Contains(res["message"].(string), "a moderator") {
		t.Fatalf("delete after leaving = %v", res)
	}
}

func TestChatModDeleteAndWarnScope(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	sc := m.joinConn(t, "u2", "G4ABD", "10.0.0.1") // same address
	m.joinConn(t, "u3", "G4SAME", "10.0.0.9")      // the moderator's address
	trySay(m.chatTestEnv, m.clk, "u1", "one")
	trySay(m.chatTestEnv, m.clk, "u2", "two")
	trySay(m.chatTestEnv, m.clk, "u3", "three")

	// In chat: only their own messages.
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4ABC"}); res["ok"] != true || res["message"] != "Removed 1 message from G4ABC" {
		t.Fatalf("delete in chat = %v", res)
	}
	if got := len(m.cm.GetBufferedMessages()); got != 2 {
		t.Fatalf("buffer = %d, want 2 (the other user on the address keeps theirs)", got)
	}

	// Left: a warning is only recorded, nobody else on the address sees it.
	m.cm.RemoveUser("u1")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "warn", "username": "G4ABC"})
	if res["ok"] != true || !strings.Contains(res["message"].(string), "isn't in chat") || !strings.Contains(res["message"].(string), "saved to their record") {
		t.Fatalf("warn left = %v", res)
	}
	if len(m.sentOfType(sc, "chat_notice")) != 0 {
		t.Fatalf("warning fanned out to another user on the address")
	}
	if countActions(t, m.chatTestEnv, "warn") != 1 {
		t.Fatalf("warning not recorded")
	}

	// Left: delete falls back to the address.
	trySay(m.chatTestEnv, m.clk, "u2", "four")
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4ABC"}); res["ok"] != true || res["message"] != "Removed 2 messages from G4ABC" {
		t.Fatalf("delete after leaving = %v", res)
	}
	// ... but never the moderator's own address.
	m.cm.RemoveUser("u3")
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "delete_user", "username": "G4SAME"}); res["ok"] != false || !strings.Contains(res["message"].(string), "same internet connection as you") {
		t.Fatalf("delete own address = %v", res)
	}
	if len(m.cm.GetBufferedMessages()) != 1 {
		t.Fatalf("moderator's address messages deleted")
	}

	// An admin warning by address (no name) still reaches everyone on it.
	if n := m.cm.Warn("10.0.0.1", "", "be civil", "admin"); n != 1 || len(m.sentOfType(sc, "chat_notice")) != 1 {
		t.Fatalf("address warning reached %d", n)
	}
}

func TestChatModSDRBanFailureDeletesNothing(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinConn(t, "u1", "G4ABC", "10.0.0.1")
	trySay(m.chatTestEnv, m.clk, "u1", "bad")
	m.cm.SetSDRBanFunc(func(ip, reason, by string) error { return errors.New("disk full") })
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "sdr_ban", "username": "G4ABC"})
	if res["ok"] != false || !strings.Contains(res["message"].(string), "didn't work") {
		t.Fatalf("res = %v", res)
	}
	if len(m.cm.GetBufferedMessages()) != 1 || len(m.out.ofType("chat_messages_deleted")) != 0 {
		t.Fatalf("messages deleted although the ban failed")
	}
	if _, in := m.cm.GetUsername("u1"); !in || countActions(t, m.chatTestEnv, "sdr_ban") != 0 {
		t.Fatalf("failed ban had an effect")
	}
	// A ban function that removes the messages itself reports its count.
	m.cm.SetSDRBanFunc(func(ip, reason, by string) error {
		n := len(m.cm.DeleteMessagesByIP(ip, by))
		if !m.cm.ClaimSDRBanFromChat(ip, n) {
			t.Errorf("chat moderation ban not claimed")
		}
		return nil
	})
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "sdr_ban", "username": "G4ABC"}); res["ok"] != true {
		t.Fatalf("ban = %v", res)
	}
	if _, _, _, _, count := actionRow(t, m.chatTestEnv, "sdr_ban"); count != 1 || countActions(t, m.chatTestEnv, "sdr_ban") != 1 {
		t.Fatalf("sdr_ban count = %d rows = %d", count, countActions(t, m.chatTestEnv, "sdr_ban"))
	}
	if m.cm.ClaimSDRBanFromChat("10.0.0.1", 0) {
		t.Fatalf("claim left behind after the ban")
	}
}

func TestChatModNoAddressKnown(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	// Only ever seen with an unknown address.
	m.cm.usernameIPsMu.Lock()
	m.cm.usernameIPs["g4ghost"] = "unknown"
	m.cm.usernameIPsMu.Unlock()
	for _, act := range []string{"warn", "chat_ban", "sdr_ban", "delete_user", "info"} {
		m.clk.Add(chatModRateWindow)
		_, res := m.mod("m1", mc, map[string]interface{}{"action": act, "username": "G4GHOST", "duration_sec": 900.0})
		if res["ok"] != false || res["message"] != "No address is known for G4GHOST." {
			t.Errorf("%s = %v", act, res)
		}
	}
	if len(m.cm.ChatBans()) != 0 || len(m.sdrBans) != 0 {
		t.Fatalf("acted on an unknown address")
	}
}

func TestChatModDemoteBroadcastsUserUpdate(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	before := len(m.out.ofType("chat_user_update"))
	m.auth.revoke("tok-m1")
	m.cm.recheckModerators()
	ups := m.out.ofType("chat_user_update")
	if len(ups) != before+1 {
		t.Fatalf("user updates %d -> %d", before, len(ups))
	}
	d := ups[len(ups)-1]["data"].(map[string]interface{})
	if d["username"] != "G4MOD" || d["moderator"] != nil {
		t.Fatalf("update = %v", d)
	}
	if m.lastModerator(t, mc) {
		t.Fatalf("still a moderator")
	}
}

func TestChatModLiftByBannedName(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	// Chat ban held under a name, while the name's last known address moved on.
	m.cm.ChatBan("10.0.0.5", time.Hour, "admin", "", "G4MOVED", false)
	m.cm.usernameIPsMu.Lock()
	m.cm.usernameIPs["g4moved"] = "10.0.0.6"
	m.cm.usernameIPsMu.Unlock()
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "lift", "username": "g4moved"})
	if res["ok"] != true || len(m.cm.ChatBans()) != 0 {
		t.Fatalf("lift = %v bans=%v", res, m.cm.ChatBans())
	}
	if ip, _, _, _, _ := actionRow(t, m.chatTestEnv, "lift"); ip != "10.0.0.5" {
		t.Fatalf("lifted %s", ip)
	}
	// No ban under the name: falls back to the last known address.
	m.cm.ChatBan("10.0.0.6", time.Hour, "admin", "", "SOMEONE", false)
	m.clk.Add(time.Second)
	if _, res := m.mod("m1", mc, map[string]interface{}{"action": "lift", "username": "G4MOVED"}); res["ok"] != true || len(m.cm.ChatBans()) != 0 {
		t.Fatalf("fallback lift = %v", res)
	}
}

func TestChatModInfoOnModerator(t *testing.T) {
	m := newModTestEnv(t)
	mc := m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	m.joinMod(t, "m2", "G4MOD2", "10.0.0.8")
	_, res := m.mod("m1", mc, map[string]interface{}{"action": "info", "username": "g4mod2"})
	if res["ok"] != true {
		t.Fatalf("res = %v", res)
	}
	info := res["info"].(map[string]interface{})
	if info["moderator"] != true || info["username"] != "G4MOD2" || info["ip"] != "" || info["in_chat"] != true {
		t.Fatalf("info = %v", info)
	}
}

func TestChatModeratorSkipsFilter(t *testing.T) {
	m := newModTestEnv(t)
	m.joinMod(t, "m1", "G4MOD", "10.0.0.9")
	if err := trySay(m.chatTestEnv, m.clk, "m1", "that is\x07 shit https://example.com"); err != nil {
		t.Fatal(err)
	}
	msgs := m.cm.GetBufferedMessages()
	// Not starred out, but still tidied (the control character is gone).
	if len(msgs) != 1 || msgs[0].Message != "that is shit https://example.com" {
		t.Fatalf("moderator message = %v", msgs)
	}
	if status, _, _ := lastChatRow(t, m.chatTestEnv); status != "ok" {
		t.Fatalf("stored status = %s", status)
	}
}

func TestChatModDeniedWording(t *testing.T) {
	if ErrModDenied.Message != "Your admin sign-in has ended. Sign in on the admin page, then reload this page." {
		t.Fatalf("wording = %q", ErrModDenied.Message)
	}
}
