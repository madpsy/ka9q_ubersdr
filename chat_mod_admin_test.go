package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newChatModAdminEnv(t *testing.T) (*chatTestEnv, *testClock, *ChatModAdminAPI) {
	t.Helper()
	e, clk, store := newLadderEnv(t, t.TempDir(), nil)
	ah := &AdminHandler{dbManager: e.db, dxClusterWsHandler: &DXClusterWebSocketHandler{chatManager: e.cm}}
	return e, clk, NewChatModAdminAPI(ah, store)
}

// call runs a handler and returns the status and decoded JSON (nil if not JSON).
func call(t *testing.T, h http.HandlerFunc, method, target, body string) (int, map[string]interface{}, string) {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	var out map[string]interface{}
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s: bad JSON %q", method, target, rec.Body.String())
		}
	}
	return rec.Code, out, rec.Body.String()
}

func TestChatModAdminModerationSettings(t *testing.T) {
	_, _, api := newChatModAdminEnv(t)

	code, out, _ := call(t, api.HandleModeration, "GET", "/admin/chat/moderation", "")
	if code != 200 || out["settings"].(map[string]interface{})["mode"] != "censor" {
		t.Fatalf("GET = %d %v", code, out)
	}
	if n := out["builtin_count"].(float64); n < 10 || int(n) != len(out["builtin_words"].([]interface{})) {
		t.Fatalf("builtin_count = %v", n)
	}

	code, out, _ = call(t, api.HandleModeration, "PUT", "/admin/chat/moderation", `{"mode":"block","words":["zorglub","shit"]}`)
	if code != 200 || out["status"] != "success" {
		t.Fatalf("PUT = %d %v", code, out)
	}
	s := out["settings"].(map[string]interface{})
	if s["mode"] != "block" || s["links"] != "allow" {
		t.Fatalf("saved settings = %v (partial body must keep other keys)", s)
	}
	if _, ok := out["notes"].([]interface{}); !ok {
		t.Fatalf("notes missing: %v", out)
	}
	if _, ok := out["rejected"].([]interface{}); !ok {
		t.Fatalf("rejected missing: %v", out)
	}
	if api.store.Settings().Mode != "block" {
		t.Fatalf("store not updated")
	}

	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"mode":"shout"}`, 400},
		{`{"links":"maybe"}`, 400},
		{`{not json`, 400},
		{`{"words":["` + strings.Repeat("a", 70<<10) + `"]}`, 413},
	} {
		if code, _, body := call(t, api.HandleModeration, "PUT", "/admin/chat/moderation", tc.body); code != tc.want {
			t.Errorf("PUT %.30s = %d %q, want %d", tc.body, code, body, tc.want)
		}
	}
	if api.store.Settings().Mode != "block" {
		t.Fatalf("a rejected PUT changed the settings")
	}
	if code, _, _ := call(t, api.HandleModeration, "POST", "/admin/chat/moderation", "{}"); code != 405 {
		t.Fatalf("POST = %d", code)
	}
}

func TestChatModAdminTestEndpoint(t *testing.T) {
	_, _, api := newChatModAdminEnv(t)
	code, out, _ := call(t, api.HandleModerationTest, "POST", "/x", `{"message":"hello"}`)
	if code != 200 || out["result"] != "ok" || out["output"] != "hello" || len(out["matches"].([]interface{})) != 0 {
		t.Fatalf("ok = %d %v", code, out)
	}
	code, out, _ = call(t, api.HandleModerationTest, "POST", "/x", `{"message":"oh shit"}`)
	if code != 200 || out["result"] != "censored" || out["output"] != "oh s**t" || out["reason"] == "" {
		t.Fatalf("censored = %d %v", code, out)
	}
	if code, _, _ := call(t, api.HandleModerationTest, "POST", "/x", `{"message":"  "}`); code != 400 {
		t.Fatalf("empty = %d", code)
	}
	if code, _, _ := call(t, api.HandleModerationTest, "POST", "/x", `{}`); code != 400 {
		t.Fatalf("missing = %d", code)
	}
	if code, _, _ := call(t, api.HandleModerationTest, "GET", "/x", ""); code != 405 {
		t.Fatalf("GET = %d", code)
	}
}

func TestChatModAdminBanLiftBansActions(t *testing.T) {
	e, clk, api := newChatModAdminEnv(t)
	c := e.joinConn(t, "s1", "G4XYZ", "10.0.0.1")
	trySay(e, clk, "s1", "hello")

	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"duration_sec":3600}`, 400},                                     // no name or ip
		{`{"username":"G4XYZ","duration_sec":100}`, 400},                   // not a preset
		{`{"ip":"not-an-ip","duration_sec":3600}`, 400},                    // bad ip
		{`{"username":"NOBODY","duration_sec":3600}`, 404},                 // unknown name
		{`{"username":"~relay","ip":"10.1.1.1","duration_sec":3600}`, 400}, // relay
		{`[`, 400},
	} {
		if code, _, body := call(t, api.HandleBan, "POST", "/admin/chat/ban", tc.body); code != tc.want {
			t.Errorf("ban %s = %d %q, want %d", tc.body, code, body, tc.want)
		}
	}
	if code, _, _ := call(t, api.HandleBan, "GET", "/admin/chat/ban", ""); code != 405 {
		t.Fatalf("GET ban = %d", code)
	}

	code, out, _ := call(t, api.HandleBan, "POST", "/admin/chat/ban", `{"username":"G4XYZ","duration_sec":3600,"reason":"rude","delete":true}`)
	if code != 200 || out["status"] != "success" || out["message"] != "G4XYZ is banned from chat for 1 hour (1 message deleted)" {
		t.Fatalf("ban = %d %v", code, out)
	}
	if _, ok := e.cm.GetUsername("s1"); ok {
		t.Fatalf("user still in chat")
	}
	if len(e.sentOfType(c, "chat_notice")) != 1 {
		t.Fatalf("banned user not told")
	}

	code, out, _ = call(t, api.HandleBans, "GET", "/admin/chat/bans", "")
	bans := out["bans"].([]interface{})
	if code != 200 || len(bans) != 1 {
		t.Fatalf("bans = %d %v", code, out)
	}
	b := bans[0].(map[string]interface{})
	if b["ip"] != "10.0.0.1" || b["username"] != "G4XYZ" || b["reason"] != "rude" || b["by"] != "admin" || b["created"] == "" ||
		b["until"] != clk.Now().Add(time.Hour).UTC().Format(time.RFC3339) {
		t.Fatalf("ban entry = %v", b)
	}

	// Ban by IP with another preset.
	if code, out, _ := call(t, api.HandleBan, "POST", "/admin/chat/ban", `{"ip":"10.0.0.7","duration_sec":604800}`); code != 200 || out["message"] != "10.0.0.7 is banned from chat for 7 days" {
		t.Fatalf("ban by ip = %d %v", code, out)
	}

	if code, _, _ := call(t, api.HandleLift, "POST", "/admin/chat/lift", `{}`); code != 400 {
		t.Fatalf("lift without ip = %d", code)
	}
	if code, _, _ := call(t, api.HandleLift, "POST", "/admin/chat/lift", `{"ip":"10.9.9.9"}`); code != 404 {
		t.Fatalf("lift unknown = %d", code)
	}
	code, out, _ = call(t, api.HandleLift, "POST", "/admin/chat/lift", `{"ip":"10.0.0.1"}`)
	if code != 200 || out["message"] != "Chat ban lifted for G4XYZ" {
		t.Fatalf("lift = %d %v", code, out)
	}
	if code, _, _ := call(t, api.HandleLift, "GET", "/admin/chat/lift", ""); code != 405 {
		t.Fatalf("GET lift = %d", code)
	}

	code, out, _ = call(t, api.HandleActions, "GET", "/admin/chat/actions", "")
	acts := out["actions"].([]interface{})
	if code != 200 || len(acts) != 3 {
		t.Fatalf("actions = %d %v", code, out)
	}
	first := acts[0].(map[string]interface{})
	if first["action"] != "lift" || first["by"] != "admin" || first["id"] == nil || first["ts"] == "" {
		t.Fatalf("newest action = %v", first)
	}
	if code, out, _ := call(t, api.HandleActions, "GET", "/admin/chat/actions?q=g4xyz&limit=1", ""); code != 200 || len(out["actions"].([]interface{})) != 1 {
		t.Fatalf("filtered actions = %d %v", code, out)
	}
	for _, bad := range []string{"0", "501", "x"} {
		if code, _, _ := call(t, api.HandleActions, "GET", "/admin/chat/actions?limit="+bad, ""); code != 400 {
			t.Errorf("limit=%s = %d", bad, code)
		}
	}
	if code, _, _ := call(t, api.HandleActions, "POST", "/admin/chat/actions", ""); code != 405 {
		t.Fatalf("POST actions = %d", code)
	}
}

func TestChatModAdminChatOff(t *testing.T) {
	e, _, api := newChatModAdminEnv(t)
	// Long enough to still be in force by the wall clock the DB fallback uses.
	e.cm.ChatBan("10.0.0.1", 5*365*24*time.Hour, "admin", "", "G4ABC", false)
	api.ah = &AdminHandler{dbManager: e.db} // chat switched off

	if code, _, _ := call(t, api.HandleBan, "POST", "/admin/chat/ban", `{"ip":"10.0.0.2","duration_sec":900}`); code != 503 {
		t.Fatalf("ban with chat off = %d", code)
	}
	code, out, _ := call(t, api.HandleBans, "GET", "/admin/chat/bans", "")
	if code != 200 || len(out["bans"].([]interface{})) != 1 {
		t.Fatalf("bans from DB = %d %v", code, out)
	}
	code, out, _ = call(t, api.HandleActions, "GET", "/admin/chat/actions", "")
	if code != 200 || len(out["actions"].([]interface{})) != 1 {
		t.Fatalf("actions from DB = %d %v", code, out)
	}
}

// sdrBanAdmin is an admin handler able to Ban from SDR in the chat test env.
func sdrBanAdmin(e *chatTestEnv, ban *IPBanManager) *AdminHandler {
	return &AdminHandler{
		dbManager:          e.db,
		ipBanManager:       ban,
		sessions:           e.sm,
		dxClusterWsHandler: &DXClusterWebSocketHandler{chatManager: e.cm, sessions: e.sm},
	}
}

func TestChatModAdminSDRBanRecorded(t *testing.T) {
	e, clk, _ := newChatModAdminEnv(t)
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	trySay(e, clk, "s1", "hello")
	ah := sdrBanAdmin(e, e.ban)

	// Admin page Ban from SDR: one row, with the name and message count.
	code, _, body := call(t, ah.HandleBanUser, "POST", "/admin/ban", `{"ip":"10.0.0.1","reason":"abuse"}`)
	if code != 200 {
		t.Fatalf("ban = %d %s", code, body)
	}
	ip, user, by, reason, count := actionRow(t, e, "sdr_ban")
	if ip != "10.0.0.1" || user != "G4ABC" || by != "admin" || reason != "abuse" || count != 1 || countActions(t, e, "sdr_ban") != 1 {
		t.Fatalf("row = %s %s %s %s %d", ip, user, by, reason, count)
	}

	// Another caller (e.g. the Telegram bot) gets its own row.
	if _, _, n, err := ah.BanIPWithKick("10.0.0.2", "spam", "telegram"); err != nil || n != 0 {
		t.Fatalf("BanIPWithKick: %d %v", n, err)
	}
	if ip, _, by, _, _ := actionRow(t, e, "sdr_ban"); ip != "10.0.0.2" || by != "telegram" || countActions(t, e, "sdr_ban") != 2 {
		t.Fatalf("telegram row = %s %s", ip, by)
	}

	// Started by chat moderation: recorded once, by the moderator path.
	e.joinConn(t, "s3", "G4XYZ", "10.0.0.3")
	trySay(e, clk, "s3", "spam")
	e.cm.SetSDRBanFunc(func(ip, reason, by string) error {
		_, _, _, err := ah.BanIPWithKick(ip, reason, by)
		return err
	})
	auth := newFakeModAuth()
	e.cm.mods.setAuth(auth)
	mc := &websocket.Conn{}
	e.out.mu.Lock()
	e.out.conns["m1"] = mc
	e.out.mu.Unlock()
	e.sm.mu.Lock()
	e.sm.uuidToIP["m1"] = "10.0.0.9"
	e.sm.mu.Unlock()
	auth.tokens["tok"] = true
	e.cm.mods.attach(mc, "tok", "10.0.0.9", "m1")
	if err := e.cm.HandleChatMessage("m1", mc, map[string]interface{}{"type": "chat_set_username", "username": "G4MOD"}); err != nil {
		t.Fatal(err)
	}
	if err := e.cm.HandleChatMessage("m1", mc, map[string]interface{}{"type": "chat_mod", "action": "sdr_ban", "username": "G4XYZ"}); err != nil {
		t.Fatal(err)
	}
	if countActions(t, e, "sdr_ban") != 3 {
		t.Fatalf("sdr_ban rows = %d, want 3 (no double row)", countActions(t, e, "sdr_ban"))
	}
	if ip, user, by, _, count := actionRow(t, e, "sdr_ban"); ip != "10.0.0.3" || user != "G4XYZ" || by != "admin G4MOD" || count != 1 {
		t.Fatalf("moderator row = %s %s %s %d", ip, user, by, count)
	}
	if !e.ban.IsBanned("10.0.0.3") {
		t.Fatalf("not banned")
	}
}

func TestChatModAdminSDRBanFailureKeepsMessages(t *testing.T) {
	e, clk, _ := newChatModAdminEnv(t)
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	trySay(e, clk, "s1", "hello")
	// A ban list that can't be saved.
	broken := NewIPBanManager(filepath.Join(t.TempDir(), "missing", "dir", "banned_ips.yaml"))
	ah := sdrBanAdmin(e, broken)
	if code, _, _ := call(t, ah.HandleBanUser, "POST", "/admin/ban", `{"ip":"10.0.0.1"}`); code != 500 {
		t.Fatalf("ban = %d", code)
	}
	if _, _, _, err := ah.BanIPWithKick("10.0.0.1", "x", "telegram"); err == nil {
		t.Fatalf("BanIPWithKick succeeded")
	}
	if len(e.cm.GetBufferedMessages()) != 1 || countActions(t, e, "sdr_ban") != 0 {
		t.Fatalf("a failed ban deleted messages or was recorded")
	}
}

func TestChatModAdminDeleteByIDRecorded(t *testing.T) {
	e, clk, _ := newChatModAdminEnv(t)
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	e.joinConn(t, "s2", "G4XYZ", "10.0.0.2")
	trySay(e, clk, "s1", "one")
	trySay(e, clk, "s2", "two")
	trySay(e, clk, "s1", "three")
	ah := sdrBanAdmin(e, e.ban)
	ids := bufferIDs(e.cm)
	body, _ := json.Marshal(map[string]interface{}{"ids": ids})
	if code, out, _ := call(t, ah.HandleChatDelete, "POST", "/admin/chat/delete", string(body)); code != 200 || out["deleted"] != 3.0 {
		t.Fatalf("delete = %d %v", code, out)
	}
	rows, err := e.db.ReadDB().Query(`SELECT ip, username, by_who, count FROM chat_mod_actions WHERE action = 'delete' ORDER BY ip`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var ip, user, by string
		var n int
		rows.Scan(&ip, &user, &by, &n)
		got = append(got, fmt.Sprintf("%s %s %s %d", ip, user, by, n))
	}
	if strings.Join(got, ",") != "10.0.0.1 G4ABC admin 2,10.0.0.2 G4XYZ admin 1" {
		t.Fatalf("rows = %v", got)
	}
	if rec := e.cm.modActions.Record30d("10.0.0.1"); rec.Deleted != 2 {
		t.Fatalf("record = %+v", rec)
	}
}

func TestChatModAdminBanUnknownAddress(t *testing.T) {
	e, _, api := newChatModAdminEnv(t)
	e.cm.usernameIPsMu.Lock()
	e.cm.usernameIPs["g4ghost"] = "unknown"
	e.cm.usernameIPsMu.Unlock()
	code, _, body := call(t, api.HandleBan, "POST", "/admin/chat/ban", `{"username":"G4GHOST","duration_sec":900}`)
	if code != 404 || !strings.Contains(body, "No address is known for G4GHOST") {
		t.Fatalf("ban = %d %q", code, body)
	}
	if len(e.cm.ChatBans()) != 0 {
		t.Fatalf("banned %v", e.cm.ChatBans())
	}
}
