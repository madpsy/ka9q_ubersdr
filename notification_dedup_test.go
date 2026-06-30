package main

import (
	"testing"
	"time"
)

// boolPtr is a small helper for building filter pointer fields in tests.
func intPtr(i int) *int { return &i }

func ruleWithFilter(event NotificationEventType, f NotificationFilter, dedupBy []string) NotificationRule {
	return NotificationRule{
		Name:     "test",
		Event:    event,
		Channels: []string{"ch"},
		Filter:   f,
		DedupBy:  dedupBy,
	}
}

func TestValidateHighVolumeGuardrail(t *testing.T) {
	mkCfg := func(rule NotificationRule) *NotificationsConfig {
		return &NotificationsConfig{
			Enabled:  true,
			Channels: map[string]NotificationChannelConfig{"ch": {Type: "telegram", BotToken: "t", ChatID: "1"}},
			Rules:    []NotificationRule{rule},
		}
	}

	cases := []struct {
		name      string
		rule      NotificationRule
		wantIssue bool
	}{
		{
			name:      "digital_decode no filter no dedup rejected",
			rule:      ruleWithFilter(EventTypeDigitalDecode, NotificationFilter{}, nil),
			wantIssue: true,
		},
		{
			name:      "digital_decode band+mode only still rejected",
			rule:      ruleWithFilter(EventTypeDigitalDecode, NotificationFilter{Bands: []string{"20m"}, DigitalModes: []string{"FT8"}}, nil),
			wantIssue: true,
		},
		{
			name:      "digital_decode SNR only rejected",
			rule:      ruleWithFilter(EventTypeDigitalDecode, NotificationFilter{MinSNR: intPtr(10)}, nil),
			wantIssue: true,
		},
		{
			name:      "digital_decode with country filter accepted",
			rule:      ruleWithFilter(EventTypeDigitalDecode, NotificationFilter{CountryCodes: []string{"JP"}}, nil),
			wantIssue: false,
		},
		{
			name:      "digital_decode with dedup_by accepted",
			rule:      ruleWithFilter(EventTypeDigitalDecode, NotificationFilter{}, []string{"country_code"}),
			wantIssue: false,
		},
		{
			name:      "dx_spot dedup by zone is invalid key",
			rule:      ruleWithFilter(EventTypeDXSpot, NotificationFilter{}, []string{"cq_zone"}),
			wantIssue: true,
		},
		{
			name:      "cw_spot dedup by zone is valid",
			rule:      ruleWithFilter(EventTypeCWSpot, NotificationFilter{}, []string{"cq_zone"}),
			wantIssue: false,
		},
		{
			name:      "space_weather empty filter allowed (not high-volume)",
			rule:      NotificationRule{Name: "sw", Event: EventTypeSpaceWeather, Channels: []string{"ch"}},
			wantIssue: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issues := mkCfg(tc.rule).Validate()
			if tc.wantIssue && len(issues) == 0 {
				t.Fatalf("expected a validation issue, got none")
			}
			if !tc.wantIssue && len(issues) != 0 {
				t.Fatalf("expected no validation issues, got: %v", issues)
			}
		})
	}
}

func TestDedupTracker(t *testing.T) {
	d := newNotifDedupTracker()
	k := func(s string) rateLimitKey { return rateLimitKey{ruleName: "r", subject: s} }

	// Once-until-restart (window 0): first allowed, second denied.
	if !d.allow(k("JP"), 0) {
		t.Fatal("first JP should be allowed")
	}
	if d.allow(k("JP"), 0) {
		t.Fatal("second JP should be deduplicated")
	}
	// A different value is independent.
	if !d.allow(k("US"), 0) {
		t.Fatal("first US should be allowed")
	}

	// Positive window: re-arms after the window elapses.
	if !d.allow(k("DE"), 1) {
		t.Fatal("first DE should be allowed")
	}
	if d.allow(k("DE"), 1) {
		t.Fatal("second DE within window should be deduplicated")
	}
	// Force the entry to look old, then cleanup should drop it and re-arm.
	d.mu.Lock()
	d.entries[k("DE")] = dedupEntry{lastSent: time.Now().Add(-2 * time.Minute), windowMinutes: 1}
	d.mu.Unlock()
	d.cleanup()
	if !d.allow(k("DE"), 1) {
		t.Fatal("DE should be re-armed after window elapsed + cleanup")
	}

	// cleanup must never drop once-until-restart entries.
	d.cleanup()
	if d.allow(k("JP"), 0) {
		t.Fatal("JP (window 0) must survive cleanup and stay deduplicated")
	}
}

func TestRuntimeGuardrailBlockset(t *testing.T) {
	cfg := &NotificationsConfig{
		Enabled: true,
		Rules: []NotificationRule{
			{Name: "flood", Event: EventTypeDigitalDecode, Channels: []string{"ch"}},                                                       // blocked
			{Name: "byCountry", Event: EventTypeDigitalDecode, Channels: []string{"ch"}, DedupBy: []string{"country_code"}},                // allowed (dedup)
			{Name: "byFilter", Event: EventTypeCWSpot, Channels: []string{"ch"}, Filter: NotificationFilter{CountryCodes: []string{"JP"}}}, // allowed (filter)
			{Name: "bandOnly", Event: EventTypeDXSpot, Channels: []string{"ch"}, Filter: NotificationFilter{Bands: []string{"20m"}}},       // blocked (band not selective)
			{Name: "weather", Event: EventTypeSpaceWeather, Channels: []string{"ch"}},                                                      // allowed (not high-volume)
		},
	}
	blocked := computeBlockedRules(cfg)
	want := map[string]bool{"flood": true, "bandOnly": true}
	if len(blocked) != len(want) {
		t.Fatalf("blocked = %v, want keys %v", blocked, want)
	}
	for k := range want {
		if !blocked[k] {
			t.Errorf("expected rule %q to be blocked at runtime", k)
		}
	}
	for _, allowed := range []string{"byCountry", "byFilter", "weather"} {
		if blocked[allowed] {
			t.Errorf("rule %q should not be blocked", allowed)
		}
	}
}

func TestDedupValue(t *testing.T) {
	e := DigitalDecodeEvent{Callsign: "VK3ABC", CountryCode: "AU", Continent: "OC", CQZone: 30, Band: "20m", Mode: "FT8"}
	if got := dedupValue(e, "country_code"); got != "AU" {
		t.Fatalf("country_code: got %q want AU", got)
	}
	if got := dedupValue(e, "cq_zone"); got != "30" {
		t.Fatalf("cq_zone: got %q want 30", got)
	}
	if got := dedupValue(e, "unknown"); got != "" {
		t.Fatalf("unknown key: got %q want empty", got)
	}
	// DX spots have no zone field; the key yields empty rather than panicking.
	if got := dedupValue(DXSpotEvent{CountryCode: "JP"}, "cq_zone"); got != "" {
		t.Fatalf("dx_spot cq_zone: got %q want empty", got)
	}
}
