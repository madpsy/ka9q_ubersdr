package main

import (
	"testing"
	"time"
)

func TestFreqRefNeedsReconnect(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	never := time.Time{}

	cases := []struct {
		name          string
		lastData      time.Time
		lastReconnect time.Time
		want          bool
	}{
		{"fresh data", now.Add(-5 * time.Second), never, false},
		{"at threshold", now.Add(-freqRefStallThreshold), never, false},
		{"stalled, never reconnected", now.Add(-freqRefStallThreshold - time.Second), never, true},
		{"stalled for days", now.Add(-2498 * time.Minute), never, true},
		{"stalled, in cooldown", now.Add(-5 * time.Minute), now.Add(-30 * time.Second), false},
		{"stalled, cooldown elapsed", now.Add(-5 * time.Minute), now.Add(-freqRefReconnectCooldown), true},
	}
	for _, c := range cases {
		if got := freqRefNeedsReconnect(now, c.lastData, c.lastReconnect); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
