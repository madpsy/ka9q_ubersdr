package main

import (
	"encoding/json"
	"testing"
)

func TestSessionsToGeoJSON(t *testing.T) {
	raw := []map[string]interface{}{
		// A normal external listener with a location -> should become a Feature.
		{
			"user_session_id": "sess-abc",
			"ssrc":            "0x0000000a",
			"latitude":        52.5,
			"longitude":       13.4,
			"country":         "Germany",
			"country_code":    "DE",
			"city":            "Berlin",
			"mode":            "usb",
			"frequency":       float64(14175000),
			"chat_username":   "G0ABC",
			"accuracy_radius_km": 50,
		},
		// Internal pseudo-session -> excluded.
		{
			"is_internal": true,
			"latitude":    1.0,
			"longitude":   2.0,
		},
		// Spectrum session -> excluded.
		{
			"is_spectrum": true,
			"latitude":    1.0,
			"longitude":   2.0,
		},
		// Shared subscriber -> excluded.
		{
			"is_shared_subscriber": true,
			"latitude":             1.0,
			"longitude":            2.0,
		},
		// External but no geo -> excluded.
		{
			"user_session_id": "sess-nogeo",
			"mode":            "cw",
		},
		// Zero-island coords -> excluded.
		{
			"user_session_id": "sess-zero",
			"latitude":        0.0,
			"longitude":       0.0,
		},
	}

	fc := sessionsToGeoJSON(raw)

	if fc.Type != "FeatureCollection" {
		t.Fatalf("type = %q, want FeatureCollection", fc.Type)
	}
	if len(fc.Features) != 1 {
		t.Fatalf("got %d features, want 1", len(fc.Features))
	}

	f := fc.Features[0]
	if f.Type != "Feature" {
		t.Errorf("feature type = %q", f.Type)
	}
	if f.ID != "sess-abc" {
		t.Errorf("feature id = %q, want sess-abc (stable across polls)", f.ID)
	}
	// GeoJSON coordinate order is [longitude, latitude].
	if len(f.Geometry.Coordinates) != 2 || f.Geometry.Coordinates[0] != 13.4 || f.Geometry.Coordinates[1] != 52.5 {
		t.Errorf("coordinates = %v, want [13.4 52.5]", f.Geometry.Coordinates)
	}
	if got := f.Properties["title"]; got != "G0ABC · 14175.0 kHz USB · Germany" {
		t.Errorf("title = %q", got)
	}
	if got := f.Properties["frequency_khz"]; got != 14175.0 {
		t.Errorf("frequency_khz = %v, want 14175", got)
	}
	if got := f.Properties["country"]; got != "Germany" {
		t.Errorf("country = %v", got)
	}

	// Ensure it serializes to valid GeoJSON with lowercase type fields.
	b, err := json.Marshal(fc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back map[string]interface{}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back["type"] != "FeatureCollection" {
		t.Errorf("round-trip type = %v", back["type"])
	}
}

func TestGeoJSONSessionTitleFallback(t *testing.T) {
	if got := geoJSONSessionTitle(map[string]interface{}{}); got != "Listener" {
		t.Errorf("empty title = %q, want Listener", got)
	}
	// Country only.
	got := geoJSONSessionTitle(map[string]interface{}{"country": "France"})
	if got != "France" {
		t.Errorf("country-only title = %q, want France", got)
	}
}

func TestBuildReceiverInfoPayload(t *testing.T) {
	// All monitors nil -> safe fallbacks (no panics, sane defaults).
	mp := &MQTTPublisher{}
	cfg := &Config{}
	cfg.Admin.Callsign = "M9PSY"
	cfg.Admin.Name = "RX888 long wire"
	cfg.Admin.Location = "Dalgety Bay, Scotland, UK"
	cfg.Admin.Antenna = "Multi-band"
	cfg.Admin.GPS.Lat = 56.0403
	cfg.Admin.GPS.Lon = -3.3554
	cfg.Server.MaxSessions = 20
	cfg.Chat.Enabled = true

	p := mp.buildReceiverInfoPayload(cfg)

	if p["callsign"] != "M9PSY" {
		t.Errorf("callsign = %v", p["callsign"])
	}
	if p["location"] != "Dalgety Bay, Scotland, UK" {
		t.Errorf("location = %v", p["location"])
	}
	// With no session manager, all slots are free.
	if p["available_clients"] != 20 {
		t.Errorf("available_clients = %v, want 20", p["available_clients"])
	}
	// Grid square derived from lat/lon (Dalgety Bay -> IO86).
	grid, _ := p["grid_square"].(string)
	if len(grid) < 4 || grid[:4] != "IO86" {
		t.Errorf("grid_square = %q, want IO86xx", grid)
	}
	if p["version"] != Version {
		t.Errorf("version = %v, want %v", p["version"], Version)
	}
	if p["chat_enabled"] != true {
		t.Errorf("chat_enabled = %v", p["chat_enabled"])
	}
}
