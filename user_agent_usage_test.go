package main

import (
	"testing"
	"time"
)

func TestLoadUserAgentUsage(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	writer := newSessionHistoryWriter(mgr.DB(), nil)

	now := time.Now().UTC().Truncate(time.Second)
	record := func(id, ip, ua string, start time.Time) {
		writer.recordActive(SessionActivityEntry{
			UserSessionID: id, ClientIP: ip, UserAgent: ua,
			SessionTypes: []string{"audio"}, CreatedAt: start, FirstSeen: start,
		}, start.Unix())
		writer.closeSession(id, nil, nil, start.Add(time.Minute).Unix())
	}

	record("a", "198.51.100.1", "python-requests/2.31", now.Add(-time.Hour))
	record("b", "198.51.100.2", "python-requests/2.31", now.Add(-2*time.Hour))
	record("c", "198.51.100.2", "python-requests/2.31", now.Add(-3*time.Hour))
	record("d", "198.51.100.3", "curl/8.5.0", now.Add(-10*24*time.Hour))
	record("e", "198.51.100.4", "", now.Add(-time.Hour))

	usage, err := LoadUserAgentUsage(mgr.ReadDB(), now.Add(-7*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(usage) != 1 {
		t.Fatalf("got %d agents in the last week, want 1 (old and empty agents excluded): %+v", len(usage), usage)
	}
	if u := usage[0]; u.UserAgent != "python-requests/2.31" || u.Sessions != 3 || u.IPs != 2 {
		t.Errorf("usage = %+v, want 3 sessions from 2 IPs", u)
	}

	all, err := LoadUserAgentUsage(mgr.ReadDB(), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].UserAgent != "python-requests/2.31" {
		t.Errorf("all history = %+v, want both agents, busiest first", all)
	}
}

func TestExactUserAgentPattern(t *testing.T) {
	ua := "Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0 Safari/537.36"
	re, err := ValidateUserAgentPattern(ExactUserAgentPattern(ua), true)
	if err != nil {
		t.Fatal(err)
	}
	for s, want := range map[string]bool{
		ua:              true,
		ua + " Edg/128": false,
		"x" + ua:        false,
		"mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0 Safari/537.36": false,
		"Mozilla/5.0 (X11; Linux x86_64) Chrome/128a0.0.0 Safari/537.36": false,
	} {
		if got := re.MatchString(s); got != want {
			t.Errorf("match(%q) = %v, want %v", s, got, want)
		}
	}
}
