package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeChatOut captures everything the chat manager sends.
type fakeChatOut struct {
	mu         sync.Mutex
	broadcasts []map[string]interface{}
	sent       map[*websocket.Conn][]map[string]interface{}
	conns      map[string]*websocket.Conn
}

func newFakeChatOut() *fakeChatOut {
	return &fakeChatOut{sent: map[*websocket.Conn][]map[string]interface{}{}, conns: map[string]*websocket.Conn{}}
}

func (f *fakeChatOut) broadcast(m map[string]interface{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broadcasts = append(f.broadcasts, m)
}

func (f *fakeChatOut) sendMessage(c *websocket.Conn, m map[string]interface{}) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent[c] = append(f.sent[c], m)
	return nil
}

func (f *fakeChatOut) GetConnForSession(id string) *websocket.Conn {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conns[id]
}

func (f *fakeChatOut) ofType(typ string) []map[string]interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]interface{}
	for _, m := range f.broadcasts {
		if m["type"] == typ {
			out = append(out, m)
		}
	}
	return out
}

type chatTestEnv struct {
	cm  *ChatManager
	out *fakeChatOut
	db  *DBManager
	sm  *SessionManager
	ban *IPBanManager
	dir string
}

// newChatTestEnv builds a chat manager on a real SQLite database in dir.
// Calling it twice with the same dir simulates a server restart.
func newChatTestEnv(t *testing.T, dir string, now time.Time) *chatTestEnv {
	t.Helper()
	db, err := NewDBManager(dir)
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	logger, _ := NewChatLogger(dir, true)
	out := newFakeChatOut()
	sm := &SessionManager{uuidToIP: map[string]string{}}
	ban := NewIPBanManager(filepath.Join(dir, "banned_ips.yaml"))
	cm := NewChatManager(out, sm, 50, 0, 0, 0, 0, logger, nil, &AdminConfig{}, ChatConfig{}, ban)
	cm.now = func() time.Time { return now }
	cm.SetDB(db.DB())
	cm.SetReadDB(db.ReadDB())
	return &chatTestEnv{cm: cm, out: out, db: db, sm: sm, ban: ban, dir: dir}
}

func (e *chatTestEnv) join(t *testing.T, sessionID, username, ip string) {
	t.Helper()
	e.sm.mu.Lock()
	e.sm.uuidToIP[sessionID] = ip
	e.sm.mu.Unlock()
	if err := e.cm.SetUsername(sessionID, username); err != nil {
		t.Fatalf("SetUsername(%s): %v", username, err)
	}
}

func (e *chatTestEnv) say(t *testing.T, sessionID, text string) {
	t.Helper()
	// Step past the per-user rate limit window.
	cur := e.cm.now()
	e.cm.now = func() time.Time { return cur.Add(2 * time.Second) }
	if err := e.cm.SendMessage(sessionID, text); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	e.cm.logWG.Wait()
}

func bufferIDs(cm *ChatManager) []int64 {
	var ids []int64
	for _, m := range cm.GetBufferedMessages() {
		ids = append(ids, m.ID)
	}
	return ids
}

func deletedIDsInDB(t *testing.T, db *DBManager) map[int64]string {
	t.Helper()
	rows, err := db.ReadDB().Query(`SELECT id, deleted_by FROM chat_messages WHERE deleted_at IS NOT NULL`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var by string
		rows.Scan(&id, &by)
		out[id] = by
	}
	return out
}

func broadcastIDs(m map[string]interface{}) []int64 {
	data := m["data"].(map[string]interface{})
	return data["ids"].([]int64)
}

var chatT0 = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func TestChatMessageIDsContinueAfterRestart(t *testing.T) {
	dir := t.TempDir()
	e := newChatTestEnv(t, dir, chatT0)
	e.join(t, "s1", "G4ABC", "10.0.0.1")
	e.say(t, "s1", "one")
	e.say(t, "s1", "two")
	e.cm.InjectMessage("~tg", "relayed", "telegram:chan", "tg:1")
	e.cm.logWG.Wait()

	if got := bufferIDs(e.cm); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("ids = %v, want [1 2 3]", got)
	}
	msgs := e.out.ofType("chat_message")
	if len(msgs) != 3 || msgs[2]["data"].(map[string]interface{})["id"] != int64(3) {
		t.Fatalf("broadcasts missing ids: %v", msgs)
	}
	e.db.Close()

	e2 := newChatTestEnv(t, dir, chatT0.Add(time.Minute))
	if got := bufferIDs(e2.cm); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("seeded ids = %v", got)
	}
	if ip := e2.cm.GetBufferedMessages()[0].SourceIP; ip != "10.0.0.1" {
		t.Fatalf("seeded SourceIP = %q", ip)
	}
	e2.join(t, "s2", "M0XYZ", "10.0.0.2")
	e2.say(t, "s2", "after restart")
	if got := bufferIDs(e2.cm); got[len(got)-1] != 4 {
		t.Fatalf("id after restart = %v, want 4", got)
	}
}

func TestChatWelcomeHasNoID(t *testing.T) {
	e := newChatTestEnv(t, t.TempDir(), chatT0)
	e.cm.welcomeMessage = &ChatMessage{Username: "OWNER", Message: "hello"}
	conn := &websocket.Conn{}
	e.out.conns["s1"] = conn
	e.join(t, "s1", "G4ABC", "10.0.0.1")
	sent := e.out.sent[conn]
	if len(sent) != 1 {
		t.Fatalf("welcome not sent: %v", sent)
	}
	if _, has := sent[0]["data"].(map[string]interface{})["id"]; has {
		t.Fatalf("welcome carries an id: %v", sent[0])
	}
}

func TestChatDeleteMessages(t *testing.T) {
	setup := func(t *testing.T) *chatTestEnv {
		e := newChatTestEnv(t, t.TempDir(), chatT0)
		e.join(t, "a", "G4ABC", "10.0.0.1")
		e.join(t, "b", "M0XYZ", "10.0.0.2")
		e.say(t, "a", "a1") // 1
		e.say(t, "b", "b1") // 2
		e.say(t, "a", "a2") // 3
		return e
	}

	t.Run("by id", func(t *testing.T) {
		e := setup(t)
		got := e.cm.DeleteMessageIDs([]int64{2}, "admin")
		if !reflect.DeepEqual(got, []int64{2}) {
			t.Fatalf("deleted %v", got)
		}
		if ids := bufferIDs(e.cm); !reflect.DeepEqual(ids, []int64{1, 3}) {
			t.Fatalf("buffer %v", ids)
		}
		if d := deletedIDsInDB(t, e.db); len(d) != 1 || d[2] != "admin" {
			t.Fatalf("db %v", d)
		}
		del := e.out.ofType("chat_messages_deleted")
		if len(del) != 1 || !reflect.DeepEqual(broadcastIDs(del[0]), []int64{2}) {
			t.Fatalf("broadcasts %v", del)
		}
		// Deleting again changes nothing and broadcasts nothing.
		if got := e.cm.DeleteMessageIDs([]int64{2}, "admin"); len(got) != 0 {
			t.Fatalf("second delete %v", got)
		}
		if n := len(e.out.ofType("chat_messages_deleted")); n != 1 {
			t.Fatalf("%d broadcasts after repeat", n)
		}
	})

	t.Run("by ip after user left", func(t *testing.T) {
		e := setup(t)
		e.cm.RemoveUser("a")
		e.sm.mu.Lock()
		delete(e.sm.uuidToIP, "a")
		e.sm.mu.Unlock()
		got := e.cm.DeleteMessagesByIP("10.0.0.0/24", "mod")
		if !reflect.DeepEqual(got, []int64{1, 2, 3}) {
			t.Fatalf("cidr deleted %v", got)
		}
		if len(e.cm.GetBufferedMessages()) != 0 {
			t.Fatal("buffer not empty")
		}
		if n := len(e.out.ofType("chat_messages_deleted")); n != 1 {
			t.Fatalf("%d broadcasts, want 1", n)
		}
	})

	t.Run("by exact ip", func(t *testing.T) {
		e := setup(t)
		got := e.cm.DeleteMessagesByIP("10.0.0.1", "admin")
		if !reflect.DeepEqual(got, []int64{1, 3}) {
			t.Fatalf("deleted %v", got)
		}
	})

	t.Run("by username", func(t *testing.T) {
		e := setup(t)
		got := e.cm.DeleteMessagesByUsername("m0xyz", "admin")
		if !reflect.DeepEqual(got, []int64{2}) {
			t.Fatalf("deleted %v", got)
		}
	})

	t.Run("by session uses its ip", func(t *testing.T) {
		e := setup(t)
		got := e.cm.DeleteMessagesForSession("a", "admin")
		if !reflect.DeepEqual(got, []int64{1, 3}) {
			t.Fatalf("deleted %v", got)
		}
	})

	t.Run("after restart", func(t *testing.T) {
		dir := t.TempDir()
		e := newChatTestEnv(t, dir, chatT0)
		e.join(t, "a", "G4ABC", "10.0.0.1")
		e.join(t, "b", "M0XYZ", "10.0.0.2")
		e.say(t, "a", "a1")
		e.say(t, "b", "b1")
		e.db.Close()

		e2 := newChatTestEnv(t, dir, chatT0.Add(time.Hour))
		if got := e2.cm.DeleteMessagesByIP("10.0.0.1", "admin"); !reflect.DeepEqual(got, []int64{1}) {
			t.Fatalf("by ip after restart %v", got)
		}
		if got := e2.cm.DeleteMessagesByUsername("M0XYZ", "admin"); !reflect.DeepEqual(got, []int64{2}) {
			t.Fatalf("by name after restart %v", got)
		}
		e2.db.Close()
		e3 := newChatTestEnv(t, dir, chatT0.Add(2*time.Hour))
		if n := len(e3.cm.GetBufferedMessages()); n != 0 {
			t.Fatalf("deleted messages came back after restart: %d", n)
		}
	})

	t.Run("old row not in buffer", func(t *testing.T) {
		e := setup(t)
		e.cm.removeFromBuffer(func(m ChatMessage) bool { return m.ID == 1 }) // aged out
		got := e.cm.DeleteMessageIDs([]int64{1}, "admin")
		if !reflect.DeepEqual(got, []int64{1}) {
			t.Fatalf("deleted %v", got)
		}
		if _, ok := deletedIDsInDB(t, e.db)[1]; !ok {
			t.Fatal("row 1 not marked")
		}
	})

	t.Run("delete before insert lands", func(t *testing.T) {
		e := newChatTestEnv(t, t.TempDir(), chatT0)
		msg := ChatMessage{ID: e.cm.nextMessageID(), Username: "X", Message: "m", SourceIP: "10.9.9.9"}
		e.cm.addMessageToBuffer(msg)
		e.cm.DeleteMessageIDs([]int64{msg.ID}, "admin")
		if err := e.cm.chatLogger.LogMessageFull(msg.ID, chatT0, "10.9.9.9", "X", "m", "", "", "", ""); err != nil {
			t.Fatal(err)
		}
		e.cm.applyPendingDelete(msg.ID)
		if _, ok := deletedIDsInDB(t, e.db)[msg.ID]; !ok {
			t.Fatal("late insert not marked deleted")
		}
	})
}

func TestChatSeedNewestSkipsDeletedBlockedBanned(t *testing.T) {
	dir := t.TempDir()
	e := newChatTestEnv(t, dir, chatT0)
	cl := e.cm.chatLogger
	// 60 messages, one per minute; buffer holds 50.
	for i := 1; i <= 60; i++ {
		ip := "10.0.0.1"
		status := ""
		switch i {
		case 58:
			ip = "192.0.2.7" // banned below
		case 59:
			status = chatStatusBlocked
		}
		if err := cl.LogMessageFull(int64(i), chatT0.Add(time.Duration(i)*time.Minute), ip, "U", "m", "", "", status, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := cl.MarkDeleted([]int64{57}, "admin", chatT0); err != nil {
		t.Fatal(err)
	}
	e.ban.BanIP("192.0.2.7", "test", "admin")
	e.db.Close()

	e2 := newChatTestEnv(t, dir, chatT0.Add(2*time.Hour))
	e2.ban.BanIP("192.0.2.7", "test", "admin")
	// Re-seed now that the ban is in place.
	e2.cm.messageBuffer = nil
	e2.cm.seedMessagesFromDB()
	ids := bufferIDs(e2.cm)
	if len(ids) != 50 {
		t.Fatalf("seeded %d, want 50", len(ids))
	}
	if ids[len(ids)-1] != 60 || ids[0] != 8 {
		t.Fatalf("seeded range %d..%d, want 8..60", ids[0], ids[len(ids)-1])
	}
	for _, id := range ids {
		if id == 57 || id == 58 || id == 59 {
			t.Fatalf("seed contains %d", id)
		}
	}
	if e2.cm.nextMessageID() != 61 {
		t.Fatal("id counter not seeded from MAX(id)")
	}
}

func TestChatSyncAfterReplay(t *testing.T) {
	e := newChatTestEnv(t, t.TempDir(), chatT0)
	conn := &websocket.Conn{}

	e.cm.SendBufferedMessages(conn)
	sent := e.out.sent[conn]
	if len(sent) != 1 || sent[0]["type"] != "chat_sync" {
		t.Fatalf("empty replay sent %v", sent)
	}
	data := sent[0]["data"].(map[string]interface{})
	if data["min_id"] != int64(0) || data["max_id"] != int64(0) || len(data["ids"].([]int64)) != 0 {
		t.Fatalf("empty sync %v", data)
	}
	b, _ := json.Marshal(sent[0])
	if !strings.Contains(string(b), `"ids":[]`) {
		t.Fatalf("ids must encode as []: %s", b)
	}

	e.join(t, "a", "G4ABC", "10.0.0.1")
	e.say(t, "a", "1")
	e.say(t, "a", "2")
	e.say(t, "a", "3")
	e.cm.DeleteMessageIDs([]int64{2}, "admin")

	conn2 := &websocket.Conn{}
	e.cm.SendBufferedMessages(conn2)
	sent = e.out.sent[conn2]
	if len(sent) != 3 {
		t.Fatalf("replay sent %d frames, want 3", len(sent))
	}
	if sent[0]["data"].(map[string]interface{})["id"] != int64(1) {
		t.Fatalf("replay missing id: %v", sent[0])
	}
	sync := sent[2]
	if sync["type"] != "chat_sync" {
		t.Fatalf("last frame %v", sync)
	}
	data = sync["data"].(map[string]interface{})
	if data["min_id"] != int64(1) || data["max_id"] != int64(3) || !reflect.DeepEqual(data["ids"], []int64{1, 3}) {
		t.Fatalf("sync %v", data)
	}
}

func TestDXClusterBroadcastChatGating(t *testing.T) {
	h := &DXClusterWebSocketHandler{
		clients:           map[*websocket.Conn]*sync.Mutex{},
		connSubscriptions: map[*websocket.Conn]*Subscriptions{},
		connToSessionID:   map[*websocket.Conn]string{},
		dxBytesSent:       map[string]uint64{},
		dxBytesSamples:    map[string][]BytesSample{},
	}
	upgrader := websocket.Upgrader{}
	var mu sync.Mutex
	chatSub := true
	ready := make(chan struct{}, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mu.Lock()
		h.clients[c] = &sync.Mutex{}
		h.connSubscriptions[c] = &Subscriptions{Chat: chatSub}
		chatSub = false
		mu.Unlock()
		ready <- struct{}{}
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")

	dial := func() *websocket.Conn {
		c, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatal(err)
		}
		<-ready
		return c
	}
	subscribed := dial()
	defer subscribed.Close()
	other := dial()
	defer other.Close()

	for _, typ := range []string{"chat_messages_deleted", "chat_sync", "chat_message", "chat_notice", "status"} {
		h.broadcast(map[string]interface{}{"type": typ})
	}

	readTypes := func(c *websocket.Conn) []string {
		var types []string
		for {
			c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
			_, b, err := c.ReadMessage()
			if err != nil {
				return types
			}
			var m map[string]interface{}
			json.Unmarshal(b, &m)
			types = append(types, m["type"].(string))
		}
	}
	if got := readTypes(subscribed); len(got) != 5 {
		t.Fatalf("chat subscriber got %v", got)
	}
	if got := readTypes(other); !reflect.DeepEqual(got, []string{"status"}) {
		t.Fatalf("non-subscriber got %v", got)
	}
}

func TestAdminChatDeleteAndLogs(t *testing.T) {
	e := newChatTestEnv(t, t.TempDir(), time.Now().UTC())
	e.join(t, "a", "G4ABC", "10.0.0.1")
	e.join(t, "b", "M0XYZ", "10.0.0.2")
	e.say(t, "a", "hello")
	e.say(t, "b", "you are a shit") // censored
	e.say(t, "a", "bye")

	ah := &AdminHandler{dbManager: e.db, dxClusterWsHandler: &DXClusterWebSocketHandler{chatManager: e.cm}}

	post := func(body string) (int, map[string]interface{}) {
		req := httptest.NewRequest(http.MethodPost, "/admin/chat/delete", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()
		ah.HandleChatDelete(rec, req)
		var out map[string]interface{}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	if code, _ := post(`{}`); code != http.StatusBadRequest {
		t.Fatalf("empty request -> %d", code)
	}
	if code, _ := post(`{"ip":"nope"}`); code != http.StatusBadRequest {
		t.Fatalf("bad ip -> %d", code)
	}
	code, out := post(`{"ids":[1]}`)
	if code != 200 || out["status"] != "success" || out["deleted"] != float64(1) || out["message"] != "Deleted 1 message" {
		t.Fatalf("delete ids -> %d %v", code, out)
	}
	code, out = post(`{"username":"m0xyz"}`)
	if code != 200 || out["deleted"] != float64(1) {
		t.Fatalf("delete username -> %d %v", code, out)
	}
	if n := len(e.out.ofType("chat_messages_deleted")); n != 2 {
		t.Fatalf("%d delete broadcasts, want 2", n)
	}

	logs := func(q string) []map[string]interface{} {
		req := httptest.NewRequest(http.MethodGet, "/admin/chat/logs?"+q, nil)
		rec := httptest.NewRecorder()
		ah.HandleChatLogs(rec, req)
		if rec.Code != 200 {
			t.Fatalf("logs %q -> %d %s", q, rec.Code, rec.Body.String())
		}
		var out struct {
			Logs []map[string]interface{} `json:"logs"`
		}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out.Logs
	}

	all := logs("")
	if len(all) != 3 {
		t.Fatalf("all logs = %d", len(all))
	}
	byID := map[float64]map[string]interface{}{}
	for _, l := range all {
		byID[l["id"].(float64)] = l
	}
	if byID[1]["deleted_by"] != "admin" || byID[1]["deleted_at"] == nil {
		t.Fatalf("row 1 %v", byID[1])
	}
	if byID[2]["status"] != "censored" || byID[2]["message_raw"] != "you are a shit" {
		t.Fatalf("row 2 %v", byID[2])
	}
	if byID[3]["status"] != "ok" || byID[3]["message_raw"] != "" {
		t.Fatalf("row 3 %v", byID[3])
	}
	if _, has := byID[3]["deleted_at"]; has {
		t.Fatalf("visible row has deleted_at: %v", byID[3])
	}
	if v := logs("show=visible"); len(v) != 1 || v[0]["id"] != float64(3) {
		t.Fatalf("visible %v", v)
	}
	if r := logs("show=removed"); len(r) != 2 {
		t.Fatalf("removed %v", r)
	}
	req := httptest.NewRequest(http.MethodGet, "/admin/chat/logs?show=bogus", nil)
	rec := httptest.NewRecorder()
	ah.HandleChatLogs(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bogus show -> %d", rec.Code)
	}

	// Chat switched off: deletion still marks stored rows.
	ah2 := &AdminHandler{dbManager: e.db}
	req = httptest.NewRequest(http.MethodPost, "/admin/chat/delete", bytes.NewBufferString(`{"ip":"10.0.0.1"}`))
	rec = httptest.NewRecorder()
	ah2.HandleChatDelete(rec, req)
	if !strings.Contains(rec.Body.String(), `"deleted":1`) {
		t.Fatalf("db-only delete -> %s", rec.Body.String())
	}
}

func TestChatMessagesMigrationAddsColumns(t *testing.T) {
	dir := t.TempDir()
	db, err := NewDBManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Recreate chat_messages with the pre-moderation schema.
	for _, q := range []string{
		`DROP TABLE chat_messages`,
		`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
			source_ip TEXT, username TEXT, message TEXT, country TEXT, country_code TEXT)`,
		`INSERT INTO chat_messages (ts, source_ip, username, message) VALUES (1, '10.0.0.1', 'OLD', 'hi')`,
	} {
		if _, err := db.DB().Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	db, err = NewDBManager(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db.Close()
	var status string
	var raw, by *string
	var at *int64
	if err := db.DB().QueryRow(`SELECT COALESCE(status, 'ok'), message_raw, deleted_at, deleted_by FROM chat_messages`).Scan(&status, &raw, &at, &by); err != nil {
		t.Fatal(err)
	}
	if status != "ok" || raw != nil || at != nil || by != nil {
		t.Fatalf("migrated row: %s %v %v %v", status, raw, at, by)
	}
	if _, err := db.DB().Exec(`INSERT INTO chat_mod_actions (ts, action, ip) VALUES (1, 'warn', '10.0.0.1')`); err != nil {
		t.Fatalf("chat_mod_actions: %v", err)
	}
}
