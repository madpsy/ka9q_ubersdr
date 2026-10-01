package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// userListFixture is a session manager holding hand-made sessions, plus a
// KiwiSDR handler on top of it, for exercising slot allocation and user_cb.
type userListFixture struct {
	sm *SessionManager
	h  *KiwiWebSocketHandler
	n  int
}

func newUserListFixture(t *testing.T, maxSessions int, bypassIPs ...string) *userListFixture {
	t.Helper()
	cfg := &Config{}
	cfg.Server.MaxSessions = maxSessions
	cfg.Server.TimeoutBypassIPs = bypassIPs
	if err := cfg.Server.parseTimeoutBypassIPs(); err != nil {
		t.Fatal(err)
	}
	sm := &SessionManager{
		config:           cfg,
		sessions:         make(map[string]*Session),
		userSessionUUIDs: make(map[string]int),
		userAgents:       make(map[string]string),
	}
	h := &KiwiWebSocketHandler{
		sessions:         sm,
		config:           cfg,
		kiwiRXSlots:      make(map[string]int),
		kiwiGeolocations: make(map[string]string),
		kiwiLiveConns:    make(map[string]int),
		activeSNDConns:   make(map[string]*kiwiConn),
	}
	return &userListFixture{sm: sm, h: h}
}

// listen adds a tuned audio session for uid; later ones are newer.
func (f *userListFixture) listen(uid, ip string, freq uint64) {
	f.n++
	id := fmt.Sprintf("s%d", f.n)
	f.sm.sessions[id] = &Session{
		ID:            id,
		UserSessionID: uid,
		ClientIP:      ip,
		Frequency:     freq,
		Mode:          "usb",
		CreatedAt:     time.Unix(int64(1000+f.n), 0),
	}
	f.sm.userSessionUUIDs[uid]++
}

// leave removes every session belonging to uid.
func (f *userListFixture) leave(uid string) {
	for id, s := range f.sm.sessions {
		if s.UserSessionID == uid {
			delete(f.sm.sessions, id)
		}
	}
	delete(f.sm.userSessionUUIDs, uid)
}

// rows returns the user list as slot -> frequency (0 for an empty slot), after
// checking the shape the KiwiSDR frontend depends on.
func (f *userListFixture) rows(t *testing.T, viewer string) []int {
	t.Helper()
	users := f.h.buildUserList(viewer)
	if len(users) != f.h.config.Server.MaxSessions {
		t.Fatalf("%d entries, want one per slot (%d)", len(users), f.h.config.Server.MaxSessions)
	}
	out := make([]int, len(users))
	for i, u := range users {
		if u.Index != i {
			t.Fatalf("entry %d has i=%d; entries must be in slot order, one per slot", i, u.Index)
		}
		if u.Antenna != "" {
			t.Errorf("slot %d sends client IP %q to viewers", i, u.Antenna)
		}
		if u.Occupied {
			out[i] = u.Frequency
		}
	}
	return out
}

func TestKiwiUserListOneEntryPerSlot(t *testing.T) {
	f := newUserListFixture(t, 4)
	f.listen("native-a", "203.0.113.1", 7100000)
	f.listen("websdr-b", "203.0.113.2", 14200000)
	f.listen("kiwi-1-203.0.113.3", "203.0.113.3", 3600000)

	got := f.rows(t, "")
	want := []int{7100000, 14200000, 3600000, 0}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("rows %v, want %v (every protocol listed, oldest first)", got, want)
	}

	// The wire form: occupied slots carry every field, empty ones only "i".
	data, err := json.Marshal(f.h.buildUserList(""))
	if err != nil {
		t.Fatal(err)
	}
	var raw []map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw[0]["n"]; !ok {
		t.Errorf("occupied slot has no \"n\": %v", raw[0])
	}
	if len(raw[3]) != 1 {
		t.Errorf("empty slot is %v, want only {\"i\":3}", raw[3])
	}
}

// The bug this replaces: slots were never freed for WebSDR/native listeners and
// the counter wrapped, so a live user shared a slot with a stale one and the
// stale {"i":N} that followed blanked the live row.
func TestKiwiUserListReusesFreedSlots(t *testing.T) {
	f := newUserListFixture(t, 2)
	for i := 0; i < 10; i++ {
		uid := fmt.Sprintf("native-%d", i)
		f.listen(uid, "203.0.113.1", uint64(7000000+i))
		f.rows(t, "")
		f.leave(uid)
	}
	f.listen("native-live", "203.0.113.1", 7100000)
	f.listen("websdr-live", "203.0.113.2", 14200000)

	for poll := 0; poll < 3; poll++ {
		got := f.rows(t, "")
		if fmt.Sprint(got) != fmt.Sprint([]int{7100000, 14200000}) {
			t.Fatalf("poll %d: rows %v, want both live listeners shown", poll, got)
		}
	}
	if n := len(f.h.kiwiRXSlots); n != 2 {
		t.Errorf("%d slots held, want 2: departed listeners must be pruned", n)
	}
}

func TestKiwiUserListSlotsAreStable(t *testing.T) {
	f := newUserListFixture(t, 4)
	f.listen("native-a", "203.0.113.1", 7100000)
	f.listen("native-b", "203.0.113.2", 14200000)
	f.listen("native-c", "203.0.113.3", 3600000)
	f.rows(t, "")

	// A leaving does not move B or C; the next arrival takes A's freed slot.
	f.leave("native-a")
	f.listen("native-d", "203.0.113.4", 21000000)
	got := f.rows(t, "")
	want := []int{21000000, 14200000, 3600000, 0}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("rows %v, want %v", got, want)
	}
}

func TestKiwiUserListBypassedSeesOnlyItself(t *testing.T) {
	f := newUserListFixture(t, 4, "198.51.100.0/24")
	f.listen("native-a", "203.0.113.1", 7100000)
	const me = "kiwi-1-198.51.100.7"
	const otherBypassed = "kiwi-2-198.51.100.8"

	// Both bypassed KiwiSDR clients claim their slots from the top, as their
	// sockets do in sendInitMessages.
	for _, uid := range []string{me, otherBypassed} {
		f.h.addLiveConn(uid)
		f.h.getOrAssignRXSlot(uid, true)
		f.listen(uid, "198.51.100.7", 5000000)
	}
	mySlot := f.h.kiwiRXSlots[me]
	if mySlot != 3 {
		t.Fatalf("bypassed client got slot %d, want the top slot 3", mySlot)
	}

	got := f.rows(t, me)
	want := []int{7100000, 0, 0, 5000000}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("bypassed viewer sees %v, want %v (itself and regular users only)", got, want)
	}
	got = f.rows(t, "")
	want = []int{7100000, 0, 0, 0}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("other viewers see %v, want %v (no bypassed users)", got, want)
	}
}

func TestKiwiUserListOpenSocketHoldsSlot(t *testing.T) {
	f := newUserListFixture(t, 2)
	const uid = "kiwi-1-203.0.113.9"

	// Init hands out the slot before "SET mod" creates any session.
	f.h.addLiveConn(uid)
	slot := f.h.getOrAssignRXSlot(uid, false)
	f.listen("native-a", "203.0.113.1", 7100000)
	f.rows(t, "")
	if got := f.h.kiwiRXSlots[uid]; got != slot {
		t.Fatalf("slot moved from %d to %d while the socket was open", slot, got)
	}

	f.h.removeLiveConn(uid)
	f.rows(t, "")
	if _, held := f.h.kiwiRXSlots[uid]; held {
		t.Error("slot still held after the socket closed with no session left")
	}
}

func TestKiwiRXSlotExhaustion(t *testing.T) {
	f := newUserListFixture(t, 2)
	if a, b := f.h.getOrAssignRXSlot("a", false), f.h.getOrAssignRXSlot("b", true); a != 0 || b != 1 {
		t.Fatalf("slots %d, %d; want 0 and 1", a, b)
	}
	if c := f.h.getOrAssignRXSlot("c", false); c != -1 {
		t.Errorf("third user got slot %d with 2 slots, want -1", c)
	}
}
