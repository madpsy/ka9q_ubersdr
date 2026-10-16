package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func exampleConfigWithTimezone(t *testing.T, tz string) map[string]interface{} {
	t.Helper()
	src, err := os.ReadFile("config/config.yaml.example")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := yaml.Unmarshal(src, &m); err != nil {
		t.Fatal(err)
	}
	m["admin"].(map[string]interface{})["timezone"] = tz
	return m
}

// A hand-edited bad timezone once made LoadConfig fail, so the server could not
// start and the admin UI that would fix it was down too. It must fall back.
func TestLoadConfigBadTimezoneFallsBackToUTC(t *testing.T) {
	out, err := yaml.Marshal(exampleConfigWithTimezone(t, "UTC+1"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, out, 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(p)
	if err != nil {
		t.Fatalf("LoadConfig with a bad timezone: %v", err)
	}
	if cfg.Admin.Timezone != "UTC" {
		t.Errorf("timezone = %q, want the UTC fallback", cfg.Admin.Timezone)
	}
}

func TestSaveRejectsBadTimezone(t *testing.T) {
	for _, tz := range []string{"UTC+1", "GMT+1", "CEST", "Europe/Berlinn"} {
		if _, _, err := marshalMainConfigYAML(exampleConfigWithTimezone(t, tz)); err == nil {
			t.Errorf("%q: save accepted, want it refused", tz)
		} else if !strings.Contains(err.Error(), "admin.timezone") {
			t.Errorf("%q: error %q does not name the field", tz, err)
		}
	}
}

func TestSaveTrimsTimezone(t *testing.T) {
	m := exampleConfigWithTimezone(t, " Europe/Berlin ")
	out, _, err := marshalMainConfigYAML(m)
	if err != nil {
		t.Fatalf("save refused a padded valid name: %v", err)
	}
	var back Config
	if err := yaml.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if back.Admin.Timezone != "Europe/Berlin" {
		t.Errorf("saved timezone = %q, want it trimmed", back.Admin.Timezone)
	}
}
