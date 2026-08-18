package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestValidateAddonSubTopicRejectsEscapes covers the validator that stands
// between an addon and the rest of the broker's topic space.
func TestValidateAddonSubTopicRejectsEscapes(t *testing.T) {
	bad := []struct {
		sub    string
		reason string
	}{
		{"", "empty"},
		{"/strikes", "leading slash"},
		{"strikes/", "trailing slash"},
		{"a//b", "empty segment"},
		{"../../ubersdr/metrics", "parent traversal"},
		{"..", "dot segment"},
		{"a.b", "dot in segment"},
		{"+", "single-level MQTT wildcard"},
		{"strikes/+", "wildcard segment"},
		{"#", "multi-level MQTT wildcard"},
		{"strikes/#", "wildcard suffix"},
		{"Strikes", "uppercase"},
		{"strikes count", "space"},
		{"status", "reserved — UberSDR owns the per-addon status topic"},
		{"a/b/c/d/e", "too many segments"},
		{strings.Repeat("a", addonSubTopicMaxLen+1), "too long"},
		{"_leading", "segment must start alphanumeric"},
		{"-leading", "segment must start alphanumeric"},
		{"a/\x00b", "null byte"},
		{"a\nb", "newline"},
	}
	for _, tc := range bad {
		if err := validateAddonSubTopic(tc.sub); err == nil {
			t.Errorf("validateAddonSubTopic(%q) accepted it; should reject (%s)", tc.sub, tc.reason)
		}
	}

	good := []string{"strikes", "bands/40m", "a", "a1/b2_c3/d-4", "x/y/z/w"}
	for _, sub := range good {
		if err := validateAddonSubTopic(sub); err != nil {
			t.Errorf("validateAddonSubTopic(%q) rejected it: %v", sub, err)
		}
	}
}

// TestAddonTopicsAreNamespaced verifies an addon's topics land under its own
// namespace and cannot collide with UberSDR's own metrics topics.
func TestAddonTopicsAreNamespaced(t *testing.T) {
	cfg := &MQTTConfig{TopicPrefix: "ubersdr/metrics"}
	cfg.AddonIngest.applyDefaults()

	got := cfg.AddonDataTopic("lightning", "strikes")
	want := "ubersdr/metrics/addons/lightning/strikes"
	if got != want {
		t.Errorf("AddonDataTopic = %q, want %q", got, want)
	}

	gotStatus := cfg.AddonStatusTopic("lightning")
	wantStatus := "ubersdr/metrics/addons/lightning/status"
	if gotStatus != wantStatus {
		t.Errorf("AddonStatusTopic = %q, want %q", gotStatus, wantStatus)
	}

	// Two addons must never be able to reach each other's topics.
	if a, b := cfg.AddonDataTopic("a", "x"), cfg.AddonDataTopic("b", "x"); a == b {
		t.Errorf("distinct addons produced the same topic: %q", a)
	}
}

// TestAddonIngestDefaults checks the zero-config posture: with nothing in
// config.yaml the ingest listener is on, with sane limits.
func TestAddonIngestDefaults(t *testing.T) {
	var c MQTTAddonIngestConfig
	c.applyDefaults()

	if !c.IsEnabled() {
		t.Error("addon ingest should default to enabled so operators need no configuration")
	}
	if !c.IsRetainAllowed() {
		t.Error("retain should default to allowed")
	}
	if c.Port != 6926 || c.TopicNamespace != "addons" || c.MaxQoS != 1 {
		t.Errorf("unexpected defaults: port=%d namespace=%q maxqos=%d", c.Port, c.TopicNamespace, c.MaxQoS)
	}
	if c.RateLimit <= 0 || c.MaxPayloadBytes <= 0 || c.MaxEntities <= 0 || c.OfflineAfterSec <= 0 {
		t.Errorf("limits must all be positive: %+v", c)
	}

	// HA discovery for addons inherits the operator's existing choice.
	if c.IsHomeAssistantEnabled(true) != true {
		t.Error("addon HA discovery should inherit mqtt.homeassistant_discovery=true")
	}
	if c.IsHomeAssistantEnabled(false) != false {
		t.Error("addon HA discovery must stay off when mqtt.homeassistant_discovery is off")
	}

	// An explicit opt-out must never be overridden by the inherited value.
	no := false
	c.HomeAssistant = &no
	if c.IsHomeAssistantEnabled(true) {
		t.Error("explicit homeassistant_discovery=false must win over the inherited value")
	}
}

// TestAddonHADeclarationRejectsBadFields exercises the discovery allowlists.
func TestAddonHADeclarationRejectsBadFields(t *testing.T) {
	base := func() AddonHADeclaration {
		return AddonHADeclaration{SubTopic: "strikes", Component: "sensor", Name: "Strikes"}
	}

	cases := []struct {
		name   string
		mutate func(*AddonHADeclaration)
	}{
		{"unknown component", func(d *AddonHADeclaration) { d.Component = "switch" }},
		{"command-capable component", func(d *AddonHADeclaration) { d.Component = "number" }},
		{"unknown device class", func(d *AddonHADeclaration) { d.DeviceClass = "nonsense" }},
		{"unknown state class", func(d *AddonHADeclaration) { d.StateClass = "cumulative" }},
		{"state class on binary_sensor", func(d *AddonHADeclaration) {
			d.Component = "binary_sensor"
			d.StateClass = "measurement"
		}},
		{"entity category config", func(d *AddonHADeclaration) { d.EntityCategory = "config" }},
		{"non-mdi icon", func(d *AddonHADeclaration) { d.Icon = "https://evil.example/x.png" }},
		{"empty name", func(d *AddonHADeclaration) { d.Name = "" }},
		{"newline in name", func(d *AddonHADeclaration) { d.Name = "a\nb" }},
		{"oversized name", func(d *AddonHADeclaration) { d.Name = strings.Repeat("x", addonHANameMaxLen+1) }},
		{"oversized template", func(d *AddonHADeclaration) {
			d.ValueTemplate = strings.Repeat("x", addonHATemplateMaxLen+1)
		}},
		{"payload_on on a sensor", func(d *AddonHADeclaration) { d.PayloadOn = "ON" }},
		{"wildcard sub_topic", func(d *AddonHADeclaration) { d.SubTopic = "#" }},
		{"reserved sub_topic", func(d *AddonHADeclaration) { d.SubTopic = "status" }},
	}

	for _, tc := range cases {
		d := base()
		tc.mutate(&d)
		if err := d.Validate(); err == nil {
			t.Errorf("%s: declaration accepted, should have been rejected", tc.name)
		}
	}

	// A well-formed declaration passes and gets binary_sensor defaults.
	d := AddonHADeclaration{SubTopic: "alarm", Component: "binary_sensor", Name: "Alarm", DeviceClass: "problem"}
	if err := d.Validate(); err != nil {
		t.Fatalf("valid declaration rejected: %v", err)
	}
	if d.PayloadOn != "ON" || d.PayloadOff != "OFF" {
		t.Errorf("binary_sensor payload defaults not applied: on=%q off=%q", d.PayloadOn, d.PayloadOff)
	}
}

// TestAddonHADeclarationDropsUnknownFields is the anti-smuggling check: an addon
// must not be able to set state_topic, device, unique_id or any other field that
// would let it escape its namespace or hijack another device.
func TestAddonHADeclarationDropsUnknownFields(t *testing.T) {
	raw := `{
		"sub_topic": "strikes",
		"component": "sensor",
		"name": "Strikes",
		"state_topic": "ubersdr/metrics/noisefloor/40m",
		"availability_topic": "attacker/controlled",
		"unique_id": "ubersdr_active_users",
		"object_id": "active_users",
		"device": {"identifiers": ["some_other_device"]},
		"json_attributes_topic": "ubersdr/metrics/sessions"
	}`

	var d AddonHADeclaration
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if err := d.Validate(); err != nil {
		t.Fatalf("declaration should be valid after dropping unknown fields: %v", err)
	}

	// Round-trip through the entity builder and confirm nothing from the
	// smuggled fields survived.
	mp := testAddonPublisher()
	entity := mp.buildAddonEntity(testAddonConfig(), addonHAEntry{Addon: "lightning", AddonHADeclaration: d})

	if entity.StateTopic != "ubersdr/metrics/addons/lightning/strikes" {
		t.Errorf("state_topic was influenced by input: %q", entity.StateTopic)
	}
	if entity.AvailabilityTopic != "" {
		t.Errorf("availability_topic should be unset (multi-topic form is used): %q", entity.AvailabilityTopic)
	}
	if entity.JSONAttributesTopic != "" {
		t.Errorf("json_attributes_topic leaked from input: %q", entity.JSONAttributesTopic)
	}
	if entity.UniqueID != "ubersdr_m9psy_addon_lightning_strikes" {
		t.Errorf("unique_id was influenced by input: %q", entity.UniqueID)
	}
	if got := entity.Device.Identifiers; len(got) != 1 || got[0] != "ubersdr_m9psy_addon_lightning" {
		t.Errorf("device identifiers were influenced by input: %v", got)
	}
}

// TestBuildAddonEntityIdentity pins the identity scheme and the two-source
// availability that makes a dead addon show as unavailable rather than stale.
func TestBuildAddonEntityIdentity(t *testing.T) {
	mp := testAddonPublisher()
	cfg := testAddonConfig()

	d := AddonHADeclaration{
		SubTopic: "bands/40m", Component: "sensor", Name: "40m Strikes",
		ValueTemplate: "{{ value_json.count }}", StateClass: "measurement",
		AddonVersion: "1.2.3",
	}
	if err := d.Validate(); err != nil {
		t.Fatalf("declaration invalid: %v", err)
	}
	e := mp.buildAddonEntity(cfg, addonHAEntry{Addon: "lightning", AddonHADeclaration: d})

	if e.StateTopic != "ubersdr/metrics/addons/lightning/bands/40m" {
		t.Errorf("state_topic = %q", e.StateTopic)
	}
	if e.ObjectID != "ubersdr_addon_lightning_bands_40m" {
		t.Errorf("object_id = %q", e.ObjectID)
	}
	if e.DefaultEntityID != "sensor.ubersdr_addon_lightning_bands_40m" {
		t.Errorf("default_entity_id = %q", e.DefaultEntityID)
	}

	// Child device, linked to the receiver.
	if e.Device.ViaDevice != "ubersdr_m9psy" {
		t.Errorf("via_device = %q, want the receiver node id", e.Device.ViaDevice)
	}
	if e.Device.SwVersion != "1.2.3" {
		t.Errorf("device sw_version = %q, want the addon's own version", e.Device.SwVersion)
	}
	if e.Device.ConfigURL != "https://rx.example.org/addon/lightning/" {
		t.Errorf("device configuration_url = %q", e.Device.ConfigURL)
	}

	// Availability must require BOTH UberSDR and the addon to be online.
	if e.AvailabilityMode != "all" {
		t.Errorf("availability_mode = %q, want \"all\"", e.AvailabilityMode)
	}
	if len(e.Availability) != 2 {
		t.Fatalf("want 2 availability sources, got %d", len(e.Availability))
	}
	if e.Availability[0].Topic != "ubersdr/metrics/status" {
		t.Errorf("first availability topic = %q", e.Availability[0].Topic)
	}
	if e.Availability[1].Topic != "ubersdr/metrics/addons/lightning/status" {
		t.Errorf("second availability topic = %q", e.Availability[1].Topic)
	}
	// HA rejects a config carrying both availability forms.
	if e.AvailabilityTopic != "" {
		t.Errorf("availability_topic must not be set alongside the availability list")
	}
}

// TestHAFinalizeStillDefaultsBuiltInAvailability guards the refactor: built-in
// entities, which pass no availability of their own, must keep getting the
// single-topic form.
func TestHAFinalizeStillDefaultsBuiltInAvailability(t *testing.T) {
	e := haFinalize(haEntity{component: "sensor", ObjectID: "active_users"},
		"ubersdr_m9psy", "ubersdr/metrics/status", haDevice{})

	if e.AvailabilityTopic != "ubersdr/metrics/status" {
		t.Errorf("availability_topic = %q, want the status topic", e.AvailabilityTopic)
	}
	if e.PayloadAvailable != "online" || e.PayloadNotAvailable != "offline" {
		t.Errorf("availability payloads = %q/%q", e.PayloadAvailable, e.PayloadNotAvailable)
	}
	if e.UniqueID != "ubersdr_m9psy_active_users" {
		t.Errorf("unique_id = %q", e.UniqueID)
	}
	if e.DefaultEntityID != "sensor.ubersdr_active_users" {
		t.Errorf("default_entity_id = %q — must stay callsign-free", e.DefaultEntityID)
	}
}

// TestAddonHARegistryRejectsSlugCollisions covers the case where two distinct
// declarations slug to the same Home Assistant object_id — haSlug maps both "-"
// and "/" to "_". Without the check the second would silently overwrite the
// first's entity.
func TestAddonHARegistryRejectsSlugCollisions(t *testing.T) {
	dir := t.TempDir()
	reg := NewAddonHARegistry(dir+"/addon_ha_entities.yaml", testAddonPublisher(), testAddonConfig(), 20)

	first := AddonHADeclaration{SubTopic: "bands/40m", Component: "sensor", Name: "40m"}
	if err := reg.Declare("lightning", first); err != nil {
		t.Fatalf("first declaration rejected: %v", err)
	}

	// "bands_40m" slugs to the same object_id as "bands/40m".
	clash := AddonHADeclaration{SubTopic: "bands_40m", Component: "sensor", Name: "40m again"}
	if err := reg.Declare("lightning", clash); err == nil {
		t.Error("colliding sub_topic was accepted; it would overwrite the existing entity")
	}

	// Re-declaring the SAME sub_topic must still be an idempotent update.
	if err := reg.Declare("lightning", first); err != nil {
		t.Errorf("re-declaring the same entity should be idempotent, got: %v", err)
	}
	if n := reg.CountFor("lightning"); n != 1 {
		t.Errorf("CountFor = %d, want 1", n)
	}
}

// TestAddonHARegistryPersistsAndReloads verifies declarations survive a restart,
// which is what lets discovery be republished when an addon is down.
func TestAddonHARegistryPersistsAndReloads(t *testing.T) {
	path := t.TempDir() + "/addon_ha_entities.yaml"

	reg := NewAddonHARegistry(path, testAddonPublisher(), testAddonConfig(), 20)
	d := AddonHADeclaration{SubTopic: "strikes", Component: "sensor", Name: "Strikes", StateClass: "measurement"}
	if err := reg.Declare("lightning", d); err != nil {
		t.Fatalf("declare failed: %v", err)
	}

	reloaded := NewAddonHARegistry(path, testAddonPublisher(), testAddonConfig(), 20)
	got := reloaded.Snapshot()
	if len(got) != 1 {
		t.Fatalf("reloaded %d entries, want 1", len(got))
	}
	if got[0].Addon != "lightning" || got[0].SubTopic != "strikes" || got[0].StateClass != "measurement" {
		t.Errorf("reloaded entry does not match: %+v", got[0])
	}

	// Reconcile must clear entities whose addon is no longer installed.
	reloaded.Reconcile(map[string]bool{"someotheraddon": true})
	// The broker is unreachable in this test, so teardown defers rather than
	// dropping the entry — the entity must not be reported as live, and must
	// still be on disk so the clear is retried.
	if n := len(reloaded.Snapshot()); n != 0 {
		t.Errorf("stale entity still reported live after Reconcile: %d", n)
	}
	if n := len(reloaded.snapshotAll()); n != 1 {
		t.Errorf("deferred teardown should keep the entry for retry, got %d", n)
	}
}

// TestAddonHAEntityKey covers several entities sharing one state topic — the
// normal MQTT shape, where one retained payload backs a handful of entities that
// each pull a different field out of it.
func TestAddonHAEntityKey(t *testing.T) {
	reg := NewAddonHARegistry(t.TempDir()+"/r.yaml", testAddonPublisher(), testAddonConfig(), 20)

	rate := AddonHADeclaration{
		SubTopic: "summary", EntityKey: "rate", Component: "sensor",
		Name: "Strike Rate", ValueTemplate: "{{ value_json.per_hour }}",
	}
	snr := AddonHADeclaration{
		SubTopic: "summary", EntityKey: "snr", Component: "sensor",
		Name: "Last SNR", ValueTemplate: "{{ value_json.snr_db }}",
	}
	if err := reg.Declare("lightning", rate); err != nil {
		t.Fatalf("first entity rejected: %v", err)
	}
	if err := reg.Declare("lightning", snr); err != nil {
		t.Fatalf("second entity on the same sub_topic rejected: %v", err)
	}
	if n := reg.CountFor("lightning"); n != 2 {
		t.Errorf("CountFor = %d, want 2", n)
	}

	// Both must point at the same state topic but be distinct entities.
	mp, cfg := testAddonPublisher(), testAddonConfig()
	e1 := mp.buildAddonEntity(cfg, addonHAEntry{Addon: "lightning", AddonHADeclaration: rate})
	e2 := mp.buildAddonEntity(cfg, addonHAEntry{Addon: "lightning", AddonHADeclaration: snr})

	if e1.StateTopic != e2.StateTopic {
		t.Errorf("entities should share a state topic: %q vs %q", e1.StateTopic, e2.StateTopic)
	}
	if e1.StateTopic != "ubersdr/metrics/addons/lightning/summary" {
		t.Errorf("state topic = %q", e1.StateTopic)
	}
	if e1.UniqueID == e2.UniqueID {
		t.Errorf("entities collided on unique_id: %q", e1.UniqueID)
	}
	if e1.DefaultEntityID != "sensor.ubersdr_addon_lightning_rate" {
		t.Errorf("entity_id = %q", e1.DefaultEntityID)
	}

	// A keyless entity whose sub_topic slugs to an existing entity_key collides
	// (both become addon_lightning_rate) and must be rejected.
	clash := AddonHADeclaration{
		SubTopic: "rate", Component: "sensor", Name: "Clash",
	}
	if err := reg.Declare("lightning", clash); err == nil {
		t.Error("sub_topic colliding with an existing entity_key was accepted")
	}

	// entity_key must be a single segment — no slashes widening the object id.
	bad := AddonHADeclaration{
		SubTopic: "summary", EntityKey: "a/b", Component: "sensor", Name: "Bad",
	}
	if err := bad.Validate(); err == nil {
		t.Error("entity_key with a slash was accepted")
	}

	// Deleting by sub_topic alone removes every entity behind it.
	if err := reg.Delete("lightning", "summary", ""); err != nil {
		t.Fatalf("bulk delete failed: %v", err)
	}
	if n := reg.CountFor("lightning"); n != 0 {
		t.Errorf("CountFor after bulk delete = %d, want 0", n)
	}
}

// TestAddonHADeleteSingleEntityKey checks targeted deletion.
func TestAddonHADeleteSingleEntityKey(t *testing.T) {
	reg := NewAddonHARegistry(t.TempDir()+"/r.yaml", testAddonPublisher(), testAddonConfig(), 20)

	for _, k := range []string{"rate", "snr"} {
		d := AddonHADeclaration{SubTopic: "summary", EntityKey: k, Component: "sensor", Name: k}
		if err := reg.Declare("lightning", d); err != nil {
			t.Fatalf("declare %s: %v", k, err)
		}
	}
	if err := reg.Delete("lightning", "summary", "rate"); err != nil {
		t.Fatalf("targeted delete failed: %v", err)
	}

	left := reg.Snapshot()
	if len(left) != 1 || left[0].EntityKey != "snr" {
		t.Errorf("expected only \"snr\" to remain, got %+v", left)
	}
	if err := reg.Delete("lightning", "summary", "rate"); err == nil {
		t.Error("deleting an already-deleted entity should error")
	}
}

// TestAddonHAMaxEntities checks the per-addon cap.
func TestAddonHAMaxEntities(t *testing.T) {
	reg := NewAddonHARegistry(t.TempDir()+"/r.yaml", testAddonPublisher(), testAddonConfig(), 2)

	for i, sub := range []string{"a", "b"} {
		d := AddonHADeclaration{SubTopic: sub, Component: "sensor", Name: "N"}
		if err := reg.Declare("lightning", d); err != nil {
			t.Fatalf("declaration %d rejected: %v", i, err)
		}
	}
	over := AddonHADeclaration{SubTopic: "c", Component: "sensor", Name: "N"}
	if err := reg.Declare("lightning", over); err == nil {
		t.Error("declaration beyond max_entities was accepted")
	}
	// A different addon has its own budget.
	if err := reg.Declare("doppler", over); err != nil {
		t.Errorf("second addon should have its own entity budget, got: %v", err)
	}
	// An addon at its limit can still UPDATE an existing entity.
	upd := AddonHADeclaration{SubTopic: "a", Component: "sensor", Name: "Renamed"}
	if err := reg.Declare("lightning", upd); err != nil {
		t.Errorf("updating an existing entity at the limit should be allowed, got: %v", err)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func testAddonPublisher() *MQTTPublisher {
	cfg := &MQTTConfig{TopicPrefix: "ubersdr/metrics", HomeAssistantPrefix: "homeassistant"}
	cfg.AddonIngest.applyDefaults()
	return &MQTTPublisher{config: cfg}
}

func testAddonConfig() *Config {
	c := &Config{}
	c.Admin.Callsign = "M9PSY"
	c.Admin.Location = "Dalgety Bay"
	c.Admin.PublicURL = "https://rx.example.org"
	return c
}
