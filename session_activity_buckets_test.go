package main

import (
	"testing"
	"time"
)

// A gap with nobody connected writes no rows at all, so the aggregator must emit
// those buckets as zero rather than dropping them (dropped buckets made the admin
// chart draw a flat line between the surviving points forever).
func TestAggregateLogsIntoBucketsFillsIdleGaps(t *testing.T) {
	end := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	start := end.Add(-1 * time.Hour)

	logs := []SessionActivityLog{
		{
			Timestamp: start.Add(2 * time.Minute),
			EventType: "snapshot",
			ActiveSessions: []SessionActivityEntry{
				{UserSessionID: "user-a"},
			},
		},
	}

	timeline := aggregateLogsIntoBuckets(logs, start, end, 5)
	if len(timeline) != 13 { // 12 five-minute buckets plus the closing boundary
		t.Fatalf("expected 13 buckets, got %d", len(timeline))
	}

	regular := func(i int) int {
		return timeline[i]["auth_breakdown"].(map[string]int)["regular"]
	}
	if regular(0) != 1 {
		t.Errorf("bucket 0: expected 1 regular user, got %d", regular(0))
	}
	for i := 1; i < len(timeline); i++ {
		if regular(i) != 0 {
			t.Errorf("bucket %d: expected 0 regular users after the session ended, got %d", i, regular(i))
		}
	}
}

// session_destroyed rows hold a single minimal entry with no auth method; counting
// them reported a phantom "regular" user for the bucket the last user left in.
func TestAggregateLogsIntoBucketsIgnoresDestroyedEvents(t *testing.T) {
	end := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	start := end.Add(-15 * time.Minute)

	logs := []SessionActivityLog{
		{
			Timestamp:      start.Add(6 * time.Minute),
			EventType:      "session_destroyed",
			ActiveSessions: []SessionActivityEntry{{UserSessionID: "user-a"}},
		},
	}

	timeline := aggregateLogsIntoBuckets(logs, start, end, 5)
	for i, bucket := range timeline {
		counts := bucket["auth_breakdown"].(map[string]int)
		if counts["regular"] != 0 || counts["password"] != 0 || counts["bypassed"] != 0 {
			t.Errorf("bucket %d: expected all zeros, got %v", i, counts)
		}
	}
}

// Peak concurrency per bucket, and auth methods, must survive the rewrite.
func TestAggregateLogsIntoBucketsCountsPeakPerAuthMethod(t *testing.T) {
	end := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	start := end.Add(-10 * time.Minute)

	logs := []SessionActivityLog{
		{
			Timestamp: start.Add(1 * time.Minute),
			EventType: "snapshot",
			ActiveSessions: []SessionActivityEntry{
				{UserSessionID: "user-a"},
				{UserSessionID: "user-a"}, // same user, two sessions
				{UserSessionID: "user-b", AuthMethod: "password"},
			},
		},
		{
			Timestamp: start.Add(3 * time.Minute),
			EventType: "session_created",
			ActiveSessions: []SessionActivityEntry{
				{UserSessionID: "user-a"},
				{UserSessionID: "user-c"},
				{UserSessionID: "user-d", AuthMethod: "ip_bypass"},
			},
		},
	}

	timeline := aggregateLogsIntoBuckets(logs, start, end, 5)
	counts := timeline[0]["auth_breakdown"].(map[string]int)
	if counts["regular"] != 2 {
		t.Errorf("expected peak of 2 regular users, got %d", counts["regular"])
	}
	if counts["password"] != 1 {
		t.Errorf("expected 1 password user, got %d", counts["password"])
	}
	if counts["bypassed"] != 1 {
		t.Errorf("expected 1 bypassed user, got %d", counts["bypassed"])
	}
}
