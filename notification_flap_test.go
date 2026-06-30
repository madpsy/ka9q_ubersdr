package main

import (
	"testing"
	"time"
)

func TestFlapDetectorTriggersAndClears(t *testing.T) {
	fc := flapConfig{
		enabled:    true,
		threshold:  4,
		window:     10 * time.Minute,
		clearAfter: 15 * time.Minute,
	}
	d := newFlapDetector()
	base := time.Now()

	// 3 transitions within the window: not yet flapping.
	for i := 0; i < 3; i++ {
		started, count := d.recordTransition("system_load", base.Add(time.Duration(i)*time.Minute), fc)
		if started {
			t.Fatalf("transition %d should not start flapping", i)
		}
		if count != i+1 {
			t.Fatalf("transition %d: count=%d want %d", i, count, i+1)
		}
	}
	if d.isFlapping("system_load") {
		t.Fatal("should not be flapping yet")
	}

	// 4th transition hits the threshold → starts flapping (once).
	started, count := d.recordTransition("system_load", base.Add(3*time.Minute), fc)
	if !started || count != 4 {
		t.Fatalf("4th transition should start flapping with count 4, got started=%v count=%d", started, count)
	}
	if !d.isFlapping("system_load") {
		t.Fatal("should be flapping after threshold reached")
	}

	// Further transitions while flapping must NOT re-trigger the start alert.
	started, _ = d.recordTransition("system_load", base.Add(4*time.Minute), fc)
	if started {
		t.Fatal("subsequent transition should not re-start flapping")
	}

	// Not yet stable long enough → does not clear.
	if d.shouldClear("system_load", base.Add(10*time.Minute), fc) {
		t.Fatal("should not clear before clearAfter elapses")
	}
	if !d.isFlapping("system_load") {
		t.Fatal("still flapping before clear window")
	}

	// Stable for clearAfter since the last transition → clears once.
	last := base.Add(4 * time.Minute)
	if !d.shouldClear("system_load", last.Add(15*time.Minute), fc) {
		t.Fatal("should clear after stable for clearAfter")
	}
	if d.isFlapping("system_load") {
		t.Fatal("should no longer be flapping after clear")
	}
	// shouldClear is idempotent once cleared.
	if d.shouldClear("system_load", last.Add(30*time.Minute), fc) {
		t.Fatal("shouldClear must return false once already cleared")
	}
}

func TestFlapWindowPruning(t *testing.T) {
	fc := flapConfig{enabled: true, threshold: 3, window: 5 * time.Minute, clearAfter: 10 * time.Minute}
	d := newFlapDetector()
	base := time.Now()

	// Two old transitions outside the window, then two fresh ones: pruning means
	// the count stays below threshold so it must not flap.
	d.recordTransition("c", base, fc)
	d.recordTransition("c", base.Add(1*time.Minute), fc)
	started, count := d.recordTransition("c", base.Add(20*time.Minute), fc)
	if started {
		t.Fatalf("stale transitions should be pruned, not flap (count=%d)", count)
	}
	if count != 1 {
		t.Fatalf("expected only the fresh transition to remain, count=%d", count)
	}
}

func ptrInt(i int) *int { return &i }

func TestSystemMonitorFlapConfig(t *testing.T) {
	on := true
	off := false
	thr := 9
	win := 3

	cases := []struct {
		name        string
		rules       []NotificationRule
		wantEnabled bool
		wantThresh  int
		wantWindow  time.Duration
	}{
		{
			name:        "default on when rule has no flap fields",
			rules:       []NotificationRule{{Event: EventTypeSystemMonitor, Channels: []string{"c"}}},
			wantEnabled: true,
			wantThresh:  defaultFlapThreshold,
			wantWindow:  defaultFlapWindowMin * time.Minute,
		},
		{
			name:        "explicitly disabled",
			rules:       []NotificationRule{{Event: EventTypeSystemMonitor, Channels: []string{"c"}, Filter: NotificationFilter{FlapDetection: &off}}},
			wantEnabled: false,
			wantThresh:  defaultFlapThreshold,
			wantWindow:  defaultFlapWindowMin * time.Minute,
		},
		{
			name:        "custom threshold and window",
			rules:       []NotificationRule{{Event: EventTypeSystemMonitor, Channels: []string{"c"}, Filter: NotificationFilter{FlapDetection: &on, FlapThreshold: &thr, FlapWindowMinutes: &win}}},
			wantEnabled: true,
			wantThresh:  9,
			wantWindow:  3 * time.Minute,
		},
		{
			name:        "out-of-range values are clamped at runtime",
			rules:       []NotificationRule{{Event: EventTypeSystemMonitor, Channels: []string{"c"}, Filter: NotificationFilter{FlapThreshold: ptrInt(0), FlapWindowMinutes: ptrInt(999999)}}},
			wantEnabled: true,
			wantThresh:  minFlapThreshold,
			wantWindow:  maxFlapWindowMinutes * time.Minute,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := systemMonitorFlapConfig(&NotificationsConfig{Enabled: true, Rules: tc.rules})
			if got.enabled != tc.wantEnabled {
				t.Errorf("enabled=%v want %v", got.enabled, tc.wantEnabled)
			}
			if got.threshold != tc.wantThresh {
				t.Errorf("threshold=%d want %d", got.threshold, tc.wantThresh)
			}
			if got.window != tc.wantWindow {
				t.Errorf("window=%v want %v", got.window, tc.wantWindow)
			}
		})
	}
}

func TestValidateFlapParams(t *testing.T) {
	mkCfg := func(f NotificationFilter) *NotificationsConfig {
		return &NotificationsConfig{
			Enabled:  true,
			Channels: map[string]NotificationChannelConfig{"ch": {Type: "telegram", BotToken: "t", ChatID: "1"}},
			Rules:    []NotificationRule{{Name: "sysmon", Event: EventTypeSystemMonitor, Channels: []string{"ch"}, Filter: f}},
		}
	}
	p := func(i int) *int { return &i }

	cases := []struct {
		name      string
		filter    NotificationFilter
		wantIssue bool
	}{
		{"all nil uses defaults", NotificationFilter{}, false},
		{"valid explicit values", NotificationFilter{FlapThreshold: p(6), FlapWindowMinutes: p(10), FlapClearMinutes: p(15)}, false},
		{"threshold below min", NotificationFilter{FlapThreshold: p(1)}, true},
		{"threshold zero", NotificationFilter{FlapThreshold: p(0)}, true},
		{"threshold negative", NotificationFilter{FlapThreshold: p(-3)}, true},
		{"window zero", NotificationFilter{FlapWindowMinutes: p(0)}, true},
		{"window too large", NotificationFilter{FlapWindowMinutes: p(99999)}, true},
		{"clear zero", NotificationFilter{FlapClearMinutes: p(0)}, true},
		{"minimum valid threshold", NotificationFilter{FlapThreshold: p(2)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issues := mkCfg(tc.filter).Validate()
			if tc.wantIssue && len(issues) == 0 {
				t.Fatal("expected a validation issue, got none")
			}
			if !tc.wantIssue && len(issues) != 0 {
				t.Fatalf("expected no issues, got: %v", issues)
			}
		})
	}
}

func TestMatchSystemMonitorFlapBypass(t *testing.T) {
	m := &NotificationManager{}
	onlyUnhealthy := true
	f := NotificationFilter{OnUnhealthy: &onlyUnhealthy}

	// A flap activation alert (component healthy at the moment) would normally be
	// filtered out by on_unhealthy, but flap alerts must bypass that filter.
	flap := SystemMonitorEvent{Component: "system_load", Healthy: true, PreviouslyHealthy: true, Status: "flapping", Flapping: true}
	if !m.matchSystemMonitor(flap, f) {
		t.Fatal("flap alert should bypass on_unhealthy and match")
	}

	stab := SystemMonitorEvent{Component: "system_load", Status: "stabilized"}
	if !m.matchSystemMonitor(stab, f) {
		t.Fatal("stabilized alert should bypass on_unhealthy and match")
	}

	// A flap alert for a different component still respects the Components filter.
	scoped := NotificationFilter{Components: []string{"decoder"}}
	if m.matchSystemMonitor(flap, scoped) {
		t.Fatal("flap alert must still respect the Components filter")
	}
}
