package main

import "testing"

func TestValidateConfigCallsign(t *testing.T) {
	cases := []struct {
		in         string
		allowSlash bool
		ok         bool
	}{
		{"-", false, false},
		{"--", false, false},
		{"", false, false},
		{"   ", false, false},
		{"AB", false, false},
		{"A1", true, false},
		{"ABC", false, true},
		{"WESSEX", false, true},
		{"wessex-2", true, true},
		{"M9PSY-", false, false},
		{"G 4ABC", false, false},
		{"M9PSY/P", false, false},
		{"/M9PSY", true, false},
		{"M9PSY", false, true},
		{"m9psy-2", false, true},
		{"M1NDH-1", false, true},
		{"M1NDH-1", true, true},
		{"2E0ABC", false, true},
		{"N0CALL", false, true}, // shipped default; the wizard rejects it, the API must not
		{"M9PSY/P", true, true},
		{"VP2E/M9PSY", true, true},
	}
	for _, c := range cases {
		err := validateConfigCallsign("Callsign", c.in, c.allowSlash)
		if (err == nil) != c.ok {
			t.Errorf("validateConfigCallsign(%q, slash=%v) err=%v, want ok=%v", c.in, c.allowSlash, err, c.ok)
		}
	}
}

func TestValidateMainConfigCallsigns(t *testing.T) {
	bad := map[string]interface{}{"admin": map[string]interface{}{"callsign": "-"}}
	if validateMainConfigCallsigns(bad) == nil {
		t.Error(`admin.callsign "-" accepted`)
	}
	disabledDX := map[string]interface{}{
		"admin":     map[string]interface{}{"callsign": "M9PSY"},
		"dxcluster": map[string]interface{}{"callsign": ""},
	}
	if err := validateMainConfigCallsigns(disabledDX); err != nil {
		t.Errorf("empty dxcluster.callsign rejected: %v", err)
	}
}

func TestLoadConfigReplacesInvalidCallsign(t *testing.T) {
	for in, want := range map[string]string{
		`"-"`:       "N0CALL",
		`"-X"`:      "N0CALL",
		`"AB"`:      "N0CALL",
		`m9psy`:     "M9PSY",
		`""`:        "N0CALL",
		`" G4ABC "`: "G4ABC",
	} {
		cfg := loadConfigForTest(t, "admin:\n  callsign: "+in+"\n")
		if cfg.Admin.Callsign != want {
			t.Errorf("callsign %s loaded as %q, want %q", in, cfg.Admin.Callsign, want)
		}
	}
}

func TestConstructPublicURLBracketsIPv6(t *testing.T) {
	irc := &InstanceReportingConfig{}
	irc.Instance.Host, irc.Instance.Port = "2001:db8::1", 8073
	if got := irc.ConstructPublicURL(); got != "http://[2001:db8::1]:8073/" {
		t.Errorf("got %q", got)
	}
	irc.Instance.Host, irc.Instance.Port, irc.Instance.TLS = "sdr.example.org", 443, true
	if got := irc.ConstructPublicURL(); got != "https://sdr.example.org/" {
		t.Errorf("got %q", got)
	}
}
