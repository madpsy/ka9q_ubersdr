package main

import (
	"testing"
	"time"
)

func TestChatModActionsRecordAndRecord30d(t *testing.T) {
	dir := t.TempDir()
	e, clk, _ := newLadderEnv(t, dir, nil)
	a := e.cm.modActions

	// An old action outside the 30-day record.
	if _, err := a.Record(chatActionWarn, "10.0.0.1", "G4ABC", "G4MOD", "old", time.Time{}); err != nil {
		t.Fatal(err)
	}
	clk.Add(31 * 24 * time.Hour)
	for _, act := range []string{chatActionWarn, chatActionAutoWarn, chatActionChatBan, chatActionAutoChatBan, chatActionLift} {
		var exp time.Time
		if act == chatActionChatBan || act == chatActionAutoChatBan {
			exp = clk.Now().Add(-time.Minute) // already over
		}
		if _, err := a.Record(act, "10.0.0.1", "G4ABC", "G4MOD", "", exp); err != nil {
			t.Fatal(err)
		}
	}
	a.Record(chatActionWarn, "10.0.0.2", "G4OTHER", "G4MOD", "", time.Time{})

	var rows int
	e.db.ReadDB().QueryRow(`SELECT COUNT(*) FROM chat_mod_actions`).Scan(&rows)
	if rows != 7 {
		t.Fatalf("rows = %d, want one per Record call (7)", rows)
	}

	// Two removed messages from the address count as "deleted".
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	trySay(e, clk, "s1", "one")
	trySay(e, clk, "s1", "two")
	e.cm.DeleteMessagesByIP("10.0.0.1", "admin")

	rec := a.Record30d("10.0.0.1")
	if rec != (ChatModRecord{Warnings: 2, ChatBans: 2, Deleted: 2}) {
		t.Fatalf("record = %+v", rec)
	}
	if r := a.Record30d("10.9.9.9"); r != (ChatModRecord{}) {
		t.Fatalf("unknown ip record = %+v", r)
	}
}

func TestChatModActionsRecent(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	a := e.cm.modActions
	a.Record(chatActionWarn, "10.0.0.1", "G4ABC", "G4MOD", "first", time.Time{})
	clk.Add(time.Minute)
	a.Record(chatActionChatBan, "10.0.0.2", "M0XYZ", "admin", "second", clk.Now().Add(time.Hour))
	clk.Add(time.Minute)
	a.RecordCount(chatActionDelete, "10.0.0.1", "g4abc", "admin", "", time.Time{}, 4)

	all, err := a.Recent(50, "")
	if err != nil || len(all) != 3 {
		t.Fatalf("recent = %v, %v", all, err)
	}
	if all[0].Action != chatActionDelete || all[0].Count != 4 || all[2].Reason != "first" {
		t.Fatalf("not newest first: %+v", all)
	}
	if all[1].ExpiresAt == "" || all[0].ExpiresAt != "" {
		t.Fatalf("expires_at wrong: %+v", all)
	}
	if one, _ := a.Recent(1, ""); len(one) != 1 || one[0].Action != chatActionDelete {
		t.Fatalf("limit: %+v", one)
	}
	if byName, _ := a.Recent(50, "G4abc"); len(byName) != 2 {
		t.Fatalf("q by name (any case) = %d rows", len(byName))
	}
	if byIP, _ := a.Recent(50, "10.0.0.2"); len(byIP) != 1 || byIP[0].Username != "M0XYZ" {
		t.Fatalf("q by ip = %+v", byIP)
	}
	if none, _ := a.Recent(50, "%"); len(none) != 0 {
		t.Fatalf("%% should be literal, got %d rows", len(none))
	}
}

func TestChatBansReloadAfterRestart(t *testing.T) {
	dir := t.TempDir()
	e, _, _ := newLadderEnv(t, dir, nil)
	e.joinConn(t, "s1", "G4ABC", "10.0.0.1")
	e.cm.ChatBan("10.0.0.1", time.Hour, "admin", "rude", "", false)
	e.cm.ChatBan("10.0.0.2", 15*time.Minute, "auto", "", "G4OLD", false)
	e.cm.ChatBan("10.0.0.3", time.Hour, "admin", "", "G4LIFT", false)
	e.cm.LiftChatBan("10.0.0.3", "admin")

	// Restart at the same time: the two unlifted bans come back.
	e2 := newChatTestEnv(t, dir, ladderT0)
	bans := e2.cm.ChatBans()
	if len(bans) != 2 || bans[0].IP != "10.0.0.2" || bans[1].IP != "10.0.0.1" || bans[1].Reason != "rude" || bans[1].Username != "G4ABC" {
		t.Fatalf("reloaded = %+v", bans)
	}
	e2.sm.uuidToIP["s1"] = "10.0.0.1"
	if err := e2.cm.SetUsername("s1", "G4ABC"); err == nil {
		t.Fatalf("restored ban not enforced")
	}

	// Restart after 20 minutes: the 15-minute ban has expired.
	e3 := newChatTestEnv(t, dir, ladderT0.Add(20*time.Minute))
	if bans := e3.cm.ChatBans(); len(bans) != 1 || bans[0].IP != "10.0.0.1" {
		t.Fatalf("after expiry = %+v", bans)
	}
}

func TestChatBlockedRowsAndUnknownAddresses(t *testing.T) {
	e, clk, _ := newLadderEnv(t, t.TempDir(), nil)
	lg := e.cm.chatLogger
	now := time.Now().UTC()
	// G4ABC: a real address, then a message stored with no address.
	lg.LogMessageFull(101, now.Add(-2*time.Minute), "10.0.0.1", "G4ABC", "hi", "", "", chatStatusOK, "")
	lg.LogMessageFull(102, now.Add(-time.Minute), "unknown", "G4ABC", "hi again", "", "", chatStatusOK, "")
	lg.LogMessageFull(103, now, "telegram:ch", "G4TG", "relayed", "", "", chatStatusOK, "")
	if ip := lg.GetLastKnownIPForUser("g4abc"); ip != "10.0.0.1" {
		t.Fatalf("last known = %q", ip)
	}
	if ip := lg.GetLastKnownIPForUser("G4TG"); ip != "" {
		t.Fatalf("relay source used as an address: %q", ip)
	}

	// Blocked rows are never picked for deletion by address or name.
	at := clk.Now()
	lg.LogMessageFull(201, at, "10.0.0.5", "G4BAD", "fine", "", "", chatStatusOK, "")
	lg.LogMessageFull(202, at, "10.0.0.5", "G4BAD", "bad word", "", "", chatStatusBlocked, "")
	since := at.Add(-time.Hour)
	byIP := chatFindMessageIDs(e.db.ReadDB(), since, buildIPMatchFunc("10.0.0.5"), "")
	byName := chatFindMessageIDs(e.db.ReadDB(), since, nil, "g4bad")
	if len(byIP) != 1 || byIP[0] != 201 || len(byName) != 1 || byName[0] != 201 {
		t.Fatalf("byIP=%v byName=%v", byIP, byName)
	}
	// A blocked row deleted by id doesn't count in the record.
	if _, err := lg.MarkDeleted([]int64{201, 202}, "admin", at); err != nil {
		t.Fatal(err)
	}
	if rec := e.cm.modActions.Record30d("10.0.0.5"); rec.Deleted != 1 {
		t.Fatalf("deleted = %d, want 1", rec.Deleted)
	}
}
