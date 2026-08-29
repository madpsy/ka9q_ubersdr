package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// ─────────────────────────────────────────────────────────────────────────────
// Schema construction
// ─────────────────────────────────────────────────────────────────────────────

func TestConfigSchemaResolvesDeclaredKinds(t *testing.T) {
	schema := mainConfigSchema()

	cases := []struct {
		path string
		want reflect.Kind
	}{
		{"server.kiwisdr_port", reflect.Int},              // the field from the reported bug
		{"server.enable_kiwisdr", reflect.Bool},           //
		{"server.kiwisdr_public_email", reflect.String},   //
		{"server.kiwisdr_smeter_offset", reflect.Float32}, //
		{"ssh_proxy.enabled", reflect.Bool},               // *bool must resolve to its element
		{"server.public_iq_modes.iq", reflect.Bool},       // map value type
		{"audio.mode_sample_rates.usb", reflect.Int},      // map value type
		{"audio.opus.bitrate", reflect.Int},               // nested struct
		{"bookmarks.0.frequency", reflect.Uint64},         // slice element field
		{"bookmarks.0.bandwidth_low", reflect.Int},        // *int inside a slice element
		{"bands.3.start", reflect.Uint64},                 //
		{"extensions.0", reflect.String},                  // scalar slice element
		{"ui.theme.background", reflect.String},           // map[string]string
	}

	for _, tc := range cases {
		node := schema.lookup(tc.path)
		if node == nil {
			t.Errorf("%s: not found in schema", tc.path)
			continue
		}
		if node.kind != tc.want {
			t.Errorf("%s: kind = %v, want %v", tc.path, node.kind, tc.want)
		}
	}
}

func TestConfigSchemaExcludesNonYAMLFields(t *testing.T) {
	schema := mainConfigSchema()

	// yaml:"-" fields are derived at runtime, never read from the file, and must
	// not be coerced or reported on.
	for _, path := range []string{"receiver", "admin.description", "instance_reporting.use_https"} {
		if node := schema.lookup(path); node != nil {
			t.Errorf("%s: present in schema but tagged yaml:\"-\"", path)
		}
	}

	// Unexported fields likewise.
	if node := schema.lookup("ssh_proxy.allowednets"); node != nil {
		t.Errorf("ssh_proxy.allowednets: unexported field leaked into schema")
	}
}

// DecoderMode carries its own UnmarshalYAML, so the schema must treat it as
// opaque rather than guessing at its representation.
func TestConfigSchemaMarksCustomUnmarshalersOpaque(t *testing.T) {
	node := mainConfigSchema().lookup("decoder.bands.0.mode")
	if node == nil {
		t.Fatal("decoder.bands.0.mode not found in schema")
	}
	if !node.opaque {
		t.Error("decoder band mode should be opaque (it has a custom UnmarshalYAML)")
	}
}

func TestConfigSchemaHandlesInlineAndRecursion(t *testing.T) {
	type inner struct {
		Deep string `yaml:"deep"`
	}
	type outer struct {
		Inner    inner  `yaml:",inline"`
		Untagged int    // no yaml tag: yaml.v3 lowercases the field name
		Self     *outer `yaml:"self"`
		Skipped  string `yaml:"-"`
	}

	schema := configSchema(reflect.TypeOf(outer{}))

	if node := schema.lookup("deep"); node == nil || node.kind != reflect.String {
		t.Errorf("inline field not hoisted into the parent mapping: %+v", node)
	}
	if node := schema.lookup("untagged"); node == nil || node.kind != reflect.Int {
		t.Errorf("untagged field not resolved by lowercased name: %+v", node)
	}
	if node := schema.lookup("self.self.deep"); node == nil || node.kind != reflect.String {
		t.Errorf("recursive type not resolved: %+v", node)
	}
	if node := schema.lookup("skipped"); node != nil {
		t.Error("yaml:\"-\" field present in schema")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion over the admin UI's decoded JSON
// ─────────────────────────────────────────────────────────────────────────────

// The reported failure: the admin UI sent kiwisdr_port back as a string, the
// server wrote it as a string, and the next boot died with
// `cannot unmarshal !!str '8036' into int`.
func TestCoerceFixesStringPort(t *testing.T) {
	cfg := map[string]interface{}{
		"server": map[string]interface{}{"kiwisdr_port": "8036"},
	}

	repairs, err := coerceToSchema(cfg, mainConfigSchema())
	if err != nil {
		t.Fatalf("coerceToSchema: %v", err)
	}
	if len(repairs) != 1 || repairs[0].Path != "server.kiwisdr_port" {
		t.Fatalf("repairs = %v, want one for server.kiwisdr_port", repairs)
	}

	got := cfg["server"].(map[string]interface{})["kiwisdr_port"]
	if got != int64(8036) {
		t.Fatalf("kiwisdr_port = %#v, want int64(8036)", got)
	}

	// And the whole point: the result must actually load.
	data, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), `"8036"`) {
		t.Errorf("port still quoted in output:\n%s", data)
	}
	var loaded Config
	if err := yaml.Unmarshal(data, &loaded); err != nil {
		t.Fatalf("coerced config does not load: %v", err)
	}
	if loaded.Server.KiwiSDRPort != 8036 {
		t.Errorf("KiwiSDRPort = %d, want 8036", loaded.Server.KiwiSDRPort)
	}
}

func TestCoerceScalarConversions(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		in       interface{}
		want     interface{}
		repaired bool
	}{
		{"string to int", "server.kiwisdr_port", "8036", int64(8036), true},
		{"string with spaces to int", "server.kiwisdr_port", " 8036 ", int64(8036), true},
		// Still converted, but not *reported*: JSON has no integer type, so every
		// number the admin UI sends arrives as a float64. Reporting those would
		// bury the one line that matters under a repair note per numeric field.
		{"json float to int", "server.kiwisdr_port", float64(8036), int64(8036), false},
		{"int stays int", "server.kiwisdr_port", int64(8036), int64(8036), false},
		{"string to bool", "server.enable_kiwisdr", "true", true, true},
		{"yaml 1.1 yes to bool", "server.enable_kiwisdr", "yes", true, true},
		{"yaml 1.1 off to bool", "server.enable_kiwisdr", "off", false, true},
		{"bool stays bool", "server.enable_kiwisdr", true, true, false},
		{"string to float", "server.kiwisdr_smeter_offset", "20.5", float64(20.5), true},
		{"int to float", "server.kiwisdr_smeter_offset", float64(20), float64(20), false},
		{"number to string", "server.kiwisdr_public_email", float64(12345), "12345", true},
		{"bool to string", "server.kiwisdr_public_email", true, "true", true},
		{"string stays string", "server.kiwisdr_public_email", "a@b.c", "a@b.c", false},
		{"nil untouched", "server.kiwisdr_port", nil, nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			keys := strings.Split(tc.path, ".")
			leaf := map[string]interface{}{keys[1]: tc.in}
			cfg := map[string]interface{}{keys[0]: leaf}

			repairs, err := coerceToSchema(cfg, mainConfigSchema())
			if err != nil {
				t.Fatalf("coerceToSchema: %v", err)
			}
			if got := leaf[keys[1]]; got != tc.want {
				t.Errorf("value = %#v, want %#v", got, tc.want)
			}
			if gotRepaired := len(repairs) > 0; gotRepaired != tc.repaired {
				t.Errorf("repairs = %v, want repaired=%v", repairs, tc.repaired)
			}
		})
	}
}

func TestCoerceRejectsUnconvertibleValues(t *testing.T) {
	cases := []struct {
		name string
		cfg  map[string]interface{}
		want string
	}{
		{
			"letters into a number field",
			map[string]interface{}{"server": map[string]interface{}{"kiwisdr_port": "abc"}},
			"server.kiwisdr_port",
		},
		{
			"fraction into a whole-number field",
			map[string]interface{}{"server": map[string]interface{}{"kiwisdr_port": 80.5}},
			"server.kiwisdr_port",
		},
		{
			"negative into an unsigned field",
			map[string]interface{}{"bookmarks": []interface{}{
				map[string]interface{}{"frequency": float64(-1)},
			}},
			"bookmarks[0].frequency",
		},
		{
			"nonsense into a bool field",
			map[string]interface{}{"server": map[string]interface{}{"enable_kiwisdr": "maybe"}},
			"server.enable_kiwisdr",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := coerceToSchema(tc.cfg, mainConfigSchema())
			if err == nil {
				t.Fatal("expected an error")
			}
			// The whole reason to error here rather than let yaml report a line
			// number is that the message names the field the operator edited.
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not name %q", err, tc.want)
			}
		})
	}
}

// Frequencies used to need a name-based hack (convertFrequencies) because JSON
// round-trips them as float64 and yaml then writes 1.4074e+07, which will not
// unmarshal into uint64. The schema handles it for every integer field, not
// just the ones whose key happens to end in "_freq".
func TestCoerceWritesLargeIntegersWithoutExponent(t *testing.T) {
	cfg := map[string]interface{}{
		"bookmarks": []interface{}{
			map[string]interface{}{"name": "FT8", "frequency": float64(14074000), "mode": "usb"},
		},
		"bands": []interface{}{
			map[string]interface{}{"label": "20m", "start": float64(14000000), "end": float64(14350000)},
		},
		// Not a frequency by name, so the old hack would have missed it.
		"server": map[string]interface{}{"max_sessions": float64(100)},
	}

	if _, err := coerceToSchema(cfg, mainConfigSchema()); err != nil {
		t.Fatalf("coerceToSchema: %v", err)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "e+") {
		t.Errorf("exponent notation in output:\n%s", data)
	}

	var loaded Config
	if err := yaml.Unmarshal(data, &loaded); err != nil {
		t.Fatalf("does not load: %v\n%s", err, data)
	}
	if len(loaded.Bookmarks) != 1 || loaded.Bookmarks[0].Frequency != 14074000 {
		t.Errorf("bookmark frequency = %+v, want 14074000", loaded.Bookmarks)
	}
	if len(loaded.Bands) != 1 || loaded.Bands[0].Start != 14000000 {
		t.Errorf("band start = %+v, want 14000000", loaded.Bands)
	}
}

func TestCoerceLeavesUnknownAndOpaqueValuesAlone(t *testing.T) {
	cfg := map[string]interface{}{
		"server": map[string]interface{}{
			"kiwisdr_port":       "8036",
			"some_removed_field": "1234", // no longer in the struct
		},
		"not_a_section": map[string]interface{}{"anything": "5678"},
	}

	if _, err := coerceToSchema(cfg, mainConfigSchema()); err != nil {
		t.Fatalf("coerceToSchema: %v", err)
	}

	server := cfg["server"].(map[string]interface{})
	if server["some_removed_field"] != "1234" {
		t.Errorf("unknown key was rewritten: %#v", server["some_removed_field"])
	}
	if cfg["not_a_section"].(map[string]interface{})["anything"] != "5678" {
		t.Error("unknown section was rewritten")
	}
	if server["kiwisdr_port"] != int64(8036) {
		t.Errorf("known key not coerced: %#v", server["kiwisdr_port"])
	}
}

func TestCoerceLeavesStructuralMismatchesToValidation(t *testing.T) {
	// A scalar where a mapping is declared is not something retyping can fix.
	// Coercion must pass it through rather than panic or invent a value; the
	// round-trip validation reports it with yaml's own line number.
	cfg := map[string]interface{}{"server": "not-a-mapping"}

	if _, err := coerceToSchema(cfg, mainConfigSchema()); err != nil {
		t.Fatalf("coerceToSchema should not error on a structural mismatch: %v", err)
	}
	if cfg["server"] != "not-a-mapping" {
		t.Errorf("value was altered: %#v", cfg["server"])
	}

	if _, _, err := marshalMainConfigYAML(cfg); err == nil {
		t.Error("marshalMainConfigYAML accepted a config that cannot load")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The admin write path
// ─────────────────────────────────────────────────────────────────────────────

func TestMarshalMainConfigYAMLRejectsUnloadableConfigs(t *testing.T) {
	// A config the server could not parse must never reach the file.
	_, _, err := marshalMainConfigYAML(map[string]interface{}{
		"server": map[string]interface{}{"kiwisdr_port": "not-a-port"},
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "server.kiwisdr_port") {
		t.Errorf("error %q does not name the offending field", err)
	}
}

func TestMarshalMainConfigYAMLRoundTripsAdminUIPayload(t *testing.T) {
	// Shaped like what the admin UI PUTs: every number arrives as a JSON float,
	// and any field it rendered as a text box arrives as a string.
	cfg := map[string]interface{}{
		"server": map[string]interface{}{
			"kiwisdr_port":          "8036",
			"enable_kiwisdr":        "true",
			"kiwisdr_smeter_offset": float64(20),
			"max_sessions":          float64(50),
			"public_iq_modes":       map[string]interface{}{"iq": "yes"},
		},
		"audio": map[string]interface{}{
			"buffer_size":       float64(4096),
			"mode_sample_rates": map[string]interface{}{"usb": "12000"},
		},
	}

	data, repairs, err := marshalMainConfigYAML(cfg)
	if err != nil {
		t.Fatalf("marshalMainConfigYAML: %v", err)
	}
	if len(repairs) == 0 {
		t.Error("expected the string values to be reported as repairs")
	}

	var loaded Config
	if err := yaml.Unmarshal(data, &loaded); err != nil {
		t.Fatalf("written config does not load: %v\n%s", err, data)
	}
	if loaded.Server.KiwiSDRPort != 8036 {
		t.Errorf("KiwiSDRPort = %d, want 8036", loaded.Server.KiwiSDRPort)
	}
	if !loaded.Server.EnableKiwiSDR {
		t.Error("EnableKiwiSDR = false, want true")
	}
	if loaded.Server.KiwiSDRSmeterOffset != 20 {
		t.Errorf("KiwiSDRSmeterOffset = %v, want 20", loaded.Server.KiwiSDRSmeterOffset)
	}
	if !loaded.Server.PublicIQModes["iq"] {
		t.Error("public_iq_modes[iq] = false, want true")
	}
	if loaded.Audio.ModeSampleRates["usb"] != 12000 {
		t.Errorf("mode_sample_rates[usb] = %d, want 12000", loaded.Audio.ModeSampleRates["usb"])
	}
}

// Saving twice must be a fixed point: the second save sees the types the first
// one wrote and changes nothing. Without that, a value can drift back to a
// string and the bug returns on the next boot.
func TestMarshalMainConfigYAMLIsIdempotent(t *testing.T) {
	first, _, err := marshalMainConfigYAML(map[string]interface{}{
		"server": map[string]interface{}{"kiwisdr_port": "8036", "enable_kiwisdr": "yes"},
	})
	if err != nil {
		t.Fatalf("first save: %v", err)
	}

	var reread map[string]interface{}
	if err := yaml.Unmarshal(first, &reread); err != nil {
		t.Fatalf("re-read: %v", err)
	}

	second, repairs, err := marshalMainConfigYAML(reread)
	if err != nil {
		t.Fatalf("second save: %v", err)
	}
	if len(repairs) != 0 {
		t.Errorf("second save still repairing: %v", repairs)
	}
	if string(first) != string(second) {
		t.Errorf("not idempotent:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

func TestWriteConfigAtomicKeepsPreviousContents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	if err := os.WriteFile(path, []byte("old: 1\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeConfigAtomic(path, []byte("new: 2\n")); err != nil {
		t.Fatalf("writeConfigAtomic: %v", err)
	}

	if got, _ := os.ReadFile(path); string(got) != "new: 2\n" {
		t.Errorf("config = %q, want the new contents", got)
	}
	if got, _ := os.ReadFile(path + ".bak"); string(got) != "old: 1\n" {
		t.Errorf("backup = %q, want the previous contents", got)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("temp file left behind")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The self-repairing loader
// ─────────────────────────────────────────────────────────────────────────────

// The exact file the operator was left with: the server would not start at all.
const brokenConfigYAML = `# UberSDR configuration
admin:
  # The operator's callsign, shown on the status page
  callsign: "M0ABC"
  port: 8080

server:
  # KiwiSDR protocol compatibility
  enable_kiwisdr: true
  # Port advertised to rx.kiwisdr.com (default 8073)
  kiwisdr_port: "8036"   # changed from the admin UI
  kiwisdr_public_email: "admin@example.com"
`

func TestLoadConfigRepairsMistypedValues(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(brokenConfigYAML), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig should have repaired the config, got: %v", err)
	}
	if cfg.Server.KiwiSDRPort != 8036 {
		t.Errorf("KiwiSDRPort = %d, want 8036", cfg.Server.KiwiSDRPort)
	}

	// The repair is persisted, so the admin UI and the next boot both see an int.
	repaired, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(repaired), `"8036"`) {
		t.Errorf("port still quoted on disk:\n%s", repaired)
	}
	if !strings.Contains(string(repaired), "kiwisdr_port: 8036") {
		t.Errorf("expected an unquoted port on disk:\n%s", repaired)
	}

	// And the original is kept.
	backup, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("no backup written: %v", err)
	}
	if string(backup) != brokenConfigYAML {
		t.Error("backup does not hold the original contents")
	}
}

// config.yaml.example is almost entirely documentation. Repairing one port
// number must not cost the operator every comment in the file, which is why the
// repair walks the yaml.Node tree instead of a generic map.
func TestConfigRepairPreservesCommentsAndOrder(t *testing.T) {
	var cfg Config
	repaired, repairs, err := repairConfigYAML([]byte(brokenConfigYAML), mainConfigSchema(), &cfg)
	if err != nil {
		t.Fatalf("repairConfigYAML: %v", err)
	}
	if len(repairs) != 1 || repairs[0].Path != "server.kiwisdr_port" {
		t.Fatalf("repairs = %v, want one for server.kiwisdr_port", repairs)
	}

	out := string(repaired)
	for _, comment := range []string{
		"# UberSDR configuration",
		"# The operator's callsign, shown on the status page",
		"# KiwiSDR protocol compatibility",
		"# Port advertised to rx.kiwisdr.com (default 8073)",
		"# changed from the admin UI",
	} {
		if !strings.Contains(out, comment) {
			t.Errorf("lost comment %q:\n%s", comment, out)
		}
	}

	// Key order is preserved too.
	if strings.Index(out, "admin:") > strings.Index(out, "server:") {
		t.Errorf("section order changed:\n%s", out)
	}
	if strings.Index(out, "enable_kiwisdr") > strings.Index(out, "kiwisdr_port") {
		t.Errorf("key order changed:\n%s", out)
	}

	// Two-space indent, matching the shipped config files.
	if !strings.Contains(out, "\n  kiwisdr_port: 8036") {
		t.Errorf("expected a two-space indent:\n%s", out)
	}
}

func TestConfigRepairHandlesYAML11Booleans(t *testing.T) {
	// `enabled: yes` is a YAML 1.1 boolean that yaml.v3 parses as the string
	// "yes", so it fails to load into a bool field — a common hand-edit trap.
	src := "server:\n  enable_kiwisdr: yes\n  enable_cors: 'false'\n"

	var into Config
	if err := yaml.Unmarshal([]byte(src), &into); err == nil {
		t.Skip("yaml.v3 accepted the YAML 1.1 spellings; nothing to repair")
	}

	var cfg Config
	repaired, repairs, err := repairConfigYAML([]byte(src), mainConfigSchema(), &cfg)
	if err != nil {
		t.Fatalf("repairConfigYAML: %v", err)
	}
	if len(repairs) != 2 {
		t.Errorf("repairs = %v, want 2", repairs)
	}
	if !cfg.Server.EnableKiwiSDR {
		t.Errorf("enable_kiwisdr = false, want true\n%s", repaired)
	}
	if cfg.Server.EnableCORS {
		t.Errorf("enable_cors = true, want false\n%s", repaired)
	}
}

func TestConfigRepairQuotesNumbersDestinedForStringFields(t *testing.T) {
	// A bare number in a string field must come back quoted, or re-encoding it
	// plain would just parse as an int again on the next load.
	src := "admin:\n  callsign: 12345\n"

	var cfg Config
	repaired, repairs, err := repairConfigYAML([]byte(src), mainConfigSchema(), &cfg)
	if err != nil {
		t.Fatalf("repairConfigYAML: %v", err)
	}
	if len(repairs) != 1 {
		t.Fatalf("repairs = %v, want 1", repairs)
	}
	if cfg.Admin.Callsign != "12345" {
		t.Errorf("callsign = %q, want \"12345\"", cfg.Admin.Callsign)
	}
	if !strings.Contains(string(repaired), `"12345"`) {
		t.Errorf("expected the value to be quoted:\n%s", repaired)
	}
}

func TestLoadConfigStillFailsOnUnrepairableConfigs(t *testing.T) {
	dir := t.TempDir()

	cases := map[string]string{
		"malformed yaml":       "server:\n  kiwisdr_port: [1, 2\n",
		"scalar where mapping": "server: 5\n",
		"unconvertible scalar": "server:\n  kiwisdr_port: \"not-a-port\"\n",
	}

	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, strings.ReplaceAll(name, " ", "_")+".yaml")
			if err := os.WriteFile(path, []byte(src), 0644); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadConfig(path); err == nil {
				t.Fatal("expected LoadConfig to fail")
			} else if !strings.Contains(err.Error(), "failed to parse config file") {
				t.Errorf("error = %v, want the original parse failure", err)
			}
		})
	}
}

// A config that already loads must be left completely untouched — no rewrite,
// no backup, no repair log.
func TestLoadConfigLeavesValidConfigsAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	src := strings.ReplaceAll(brokenConfigYAML, `kiwisdr_port: "8036"`, "kiwisdr_port: 8036")
	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadConfig(path); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	after, _ := os.ReadFile(path)
	if string(after) != src {
		t.Errorf("file was rewritten:\n%s", after)
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Error("backup written for a config that did not need repair")
	}
}

// The synthetic fixture above is a handful of lines; config.yaml.example is
// hundreds, almost all of them documentation. Break one value in the real file
// and check that repairing it costs the operator nothing else.
func TestConfigRepairPreservesTheShippedExample(t *testing.T) {
	original, err := os.ReadFile(filepath.Join("config", "config.yaml.example"))
	if err != nil {
		t.Skipf("example config not available: %v", err)
	}
	if !strings.Contains(string(original), "kiwisdr_port: 8073") {
		t.Skip("example config no longer contains the field this test breaks")
	}

	broken := strings.Replace(string(original), "kiwisdr_port: 8073", `kiwisdr_port: "8036"`, 1)

	var cfg Config
	if err := yaml.Unmarshal([]byte(broken), &cfg); err == nil {
		t.Fatal("the broken example unexpectedly loaded; the fixture no longer reproduces the bug")
	}

	repaired, repairs, err := repairConfigYAML([]byte(broken), mainConfigSchema(), &cfg)
	if err != nil {
		t.Fatalf("repairConfigYAML: %v", err)
	}
	if len(repairs) != 1 || repairs[0].Path != "server.kiwisdr_port" {
		t.Fatalf("repairs = %v, want exactly one for server.kiwisdr_port", repairs)
	}
	if cfg.Server.KiwiSDRPort != 8036 {
		t.Errorf("KiwiSDRPort = %d, want 8036", cfg.Server.KiwiSDRPort)
	}

	// The strong claim: byte-for-byte identical to the original except the one
	// line that was broken. Comments, blank lines, key order, indentation,
	// quoting style and trailing inline comments all survive untouched.
	before := strings.Split(string(original), "\n")
	after := strings.Split(string(repaired), "\n")
	if len(before) != len(after) {
		t.Fatalf("line count changed: %d -> %d", len(before), len(after))
	}
	var changed []int
	for i := range before {
		if before[i] != after[i] {
			changed = append(changed, i)
		}
	}
	if len(changed) != 1 {
		t.Fatalf("%d lines changed, want exactly 1: %v", len(changed), changed)
	}
	if got, want := strings.TrimSpace(after[changed[0]]), "kiwisdr_port: 8036"; got != want {
		t.Errorf("changed line = %q, want %q", got, want)
	}
}

// Two mistyped values on one line must both be rewritten; the patcher applies
// them right-to-left so the first replacement cannot shift the second.
func TestConfigRepairHandlesSeveralValuesOnOneLine(t *testing.T) {
	src := "admin:\n  gps: {lat: \"51.507\", lon: \"-0.128\"}  # trailing comment\n"

	var cfg Config
	repaired, repairs, err := repairConfigYAML([]byte(src), mainConfigSchema(), &cfg)
	if err != nil {
		t.Fatalf("repairConfigYAML: %v", err)
	}
	if len(repairs) != 2 {
		t.Fatalf("repairs = %v, want 2", repairs)
	}
	if cfg.Admin.GPS.Lat != 51.507 || cfg.Admin.GPS.Lon != -0.128 {
		t.Errorf("gps = %v, %v; want 51.507, -0.128", cfg.Admin.GPS.Lat, cfg.Admin.GPS.Lon)
	}
	want := "admin:\n  gps: {lat: 51.507, lon: -0.128}  # trailing comment\n"
	if string(repaired) != want {
		t.Errorf("repaired =\n%q\nwant\n%q", repaired, want)
	}
}

// The patcher must never write a file it is not certain about. If the text at a
// position yaml reported is not the value yaml said was there, the whole repair
// is abandoned rather than a byte being changed on a guess.
func TestApplyScalarFixesRefusesToPatchUnexpectedText(t *testing.T) {
	data := []byte("server:\n  kiwisdr_port: \"8036\"\n")

	cases := map[string]scalarFix{
		"value does not match": {
			line: 2, col: 17, style: yaml.DoubleQuotedStyle, value: "9999", newText: "9999",
			repair: ConfigRepair{Path: "server.kiwisdr_port"},
		},
		"line out of range": {
			line: 99, col: 1, style: 0, value: "8036", newText: "8036",
			repair: ConfigRepair{Path: "server.kiwisdr_port"},
		},
		"column past end of line": {
			line: 1, col: 200, style: 0, value: "8036", newText: "8036",
			repair: ConfigRepair{Path: "server.kiwisdr_port"},
		},
	}

	for name, fix := range cases {
		t.Run(name, func(t *testing.T) {
			out, err := applyScalarFixes(data, []scalarFix{fix})
			if err == nil {
				t.Fatalf("expected an error, got:\n%s", out)
			}
			if out != nil {
				t.Error("returned data alongside an error")
			}
			if !strings.Contains(err.Error(), "server.kiwisdr_port") {
				t.Errorf("error %q does not name the field", err)
			}
		})
	}
}

// The shipped example is the config most operators start from: it must load,
// and running it through the coercion must find nothing to fix. If this fails,
// either the example or the schema has drifted from the structs.
func TestExampleConfigNeedsNoRepair(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("config", "config.yaml.example"))
	if err != nil {
		t.Skipf("example config not available: %v", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("config.yaml.example does not load: %v", err)
	}

	var asMap map[string]interface{}
	if err := yaml.Unmarshal(data, &asMap); err != nil {
		t.Fatalf("unmarshal to map: %v", err)
	}
	repairs, err := coerceToSchema(asMap, mainConfigSchema())
	if err != nil {
		t.Fatalf("coerceToSchema on the shipped example: %v", err)
	}
	if len(repairs) != 0 {
		t.Errorf("shipped example needs %d repair(s): %v", len(repairs), repairs)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The other config files
// ─────────────────────────────────────────────────────────────────────────────

// Every config file the admin UI writes goes through the same JSON round-trip
// that broke config.yaml, so every one of them needs the same gate. This is the
// table of root types the write path knows about.
func TestMarshalCheckedYAMLGatesEveryConfigRoot(t *testing.T) {
	cases := []struct {
		name  string
		root  reflect.Type
		in    map[string]interface{}
		bad   map[string]interface{} // must be rejected outright
		check func(t *testing.T, data []byte)
	}{
		{
			name: "cwskimmer.yaml",
			root: cwSkimmerRootType,
			in: map[string]interface{}{
				"port": "7300", "enabled": "yes", "reconnect_delay": float64(30),
			},
			bad: map[string]interface{}{"port": "not-a-port"},
			check: func(t *testing.T, data []byte) {
				var c CWSkimmerConfig
				if err := yaml.Unmarshal(data, &c); err != nil {
					t.Fatalf("does not load: %v\n%s", err, data)
				}
				if c.Port != 7300 || !c.Enabled || c.ReconnectDelay != 30 {
					t.Errorf("got port=%d enabled=%v delay=%d", c.Port, c.Enabled, c.ReconnectDelay)
				}
			},
		},
		{
			name: "rotator scheduler",
			root: rotatorScheduleRootType,
			in: map[string]interface{}{
				"follow_sun": "true", "follow_sun_step": "15", "daytime_overlap": float64(60),
			},
			bad: map[string]interface{}{"follow_sun_step": "quarter-hourly"},
			check: func(t *testing.T, data []byte) {
				var c RotatorScheduleConfig
				if err := yaml.Unmarshal(data, &c); err != nil {
					t.Fatalf("does not load: %v\n%s", err, data)
				}
				if !c.FollowSun || c.FollowSunStep != 15 || c.DaytimeOverlap != 60 {
					t.Errorf("got %+v", c)
				}
			},
		},
		{
			name: "ant switch scheduler",
			root: antSwitchScheduleRootType,
			in: map[string]interface{}{
				"enabled": "on",
				"entries": []interface{}{
					map[string]interface{}{"time": "06:00", "antenna": "3", "action": "select"},
				},
			},
			bad: map[string]interface{}{"entries": []interface{}{
				map[string]interface{}{"time": "06:00", "antenna": "third", "action": "select"},
			}},
			check: func(t *testing.T, data []byte) {
				var c AntSwitchScheduleConfig
				if err := yaml.Unmarshal(data, &c); err != nil {
					t.Fatalf("does not load: %v\n%s", err, data)
				}
				if !c.Enabled || len(c.Entries) != 1 || c.Entries[0].Antenna != 3 {
					t.Errorf("got %+v", c)
				}
			},
		},
		{
			name: "addons.yaml",
			root: addonProxiesRootType,
			in: map[string]interface{}{
				"proxies": []interface{}{
					map[string]interface{}{
						"name": "grafana", "enabled": "true",
						"host": "grafana", "port": "3000", "rate_limit": float64(100),
					},
				},
			},
			bad: map[string]interface{}{"proxies": []interface{}{
				map[string]interface{}{"name": "grafana", "port": "three thousand"},
			}},
			check: func(t *testing.T, data []byte) {
				var c AddonProxiesConfig
				if err := yaml.Unmarshal(data, &c); err != nil {
					t.Fatalf("does not load: %v\n%s", err, data)
				}
				if len(c.Proxies) != 1 || c.Proxies[0].Port != 3000 || !c.Proxies[0].Enabled {
					t.Errorf("got %+v", c.Proxies)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, repairs, err := marshalCheckedYAML(tc.in, tc.root)
			if err != nil {
				t.Fatalf("marshalCheckedYAML: %v", err)
			}
			if len(repairs) == 0 {
				t.Error("expected the string values to be reported as repairs")
			}
			if strings.Contains(string(data), "e+") {
				t.Errorf("exponent notation in output:\n%s", data)
			}
			tc.check(t, data)

			// And the gate must reject what it cannot convert, rather than
			// writing a file that only fails on the next boot.
			if _, _, err := marshalCheckedYAML(tc.bad, tc.root); err == nil {
				t.Error("gate accepted an unconvertible value")
			}
		})
	}
}

// The satellite files main.go loads with LoadConfig — bands, bookmarks,
// extensions, decoder — are each a partial Config document, so they must
// validate against Config's schema rather than needing one of their own.
func TestSatelliteFilesValidateAgainstConfigSchema(t *testing.T) {
	cases := map[string]map[string]interface{}{
		"bookmarks.yaml": {"bookmarks": []interface{}{
			map[string]interface{}{"name": "FT8", "frequency": "14074000", "mode": "usb"},
		}},
		"bands.yaml": {"bands": []interface{}{
			map[string]interface{}{"label": "20m", "start": float64(14000000), "end": "14350000"},
		}},
		"extensions.yaml": {"extensions": []interface{}{"ft8", "sstv"}},
		"decoder.yaml": {"decoder": map[string]interface{}{
			"enabled": "yes", "max_concurrent_wspr_decoders": "4",
		}},
	}

	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			data, _, err := marshalCheckedYAML(in, configRootType)
			if err != nil {
				t.Fatalf("marshalCheckedYAML: %v", err)
			}
			if strings.Contains(string(data), "e+") {
				t.Errorf("exponent notation in output:\n%s", data)
			}
			var cfg Config
			if err := yaml.Unmarshal(data, &cfg); err != nil {
				t.Fatalf("does not load: %v\n%s", err, data)
			}
		})
	}
}

// loadYAMLWithRepair is the shared read gate: a mistyped value must not take a
// subsystem down, and the fix must be persisted with the original kept as .bak.
func TestLoadYAMLWithRepairFixesAndPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cwskimmer.yaml")
	src := "# CW Skimmer\nhost: localhost\nport: \"7300\"  # moved off the default\nenabled: yes\n"
	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(path)
	var cfg CWSkimmerConfig
	repairs, err := loadYAMLWithRepair(path, data, &cfg)
	if err != nil {
		t.Fatalf("loadYAMLWithRepair: %v", err)
	}
	if len(repairs) != 2 {
		t.Errorf("repairs = %v, want 2", repairs)
	}
	if cfg.Port != 7300 || !cfg.Enabled || cfg.Host != "localhost" {
		t.Errorf("got %+v", cfg)
	}

	after, _ := os.ReadFile(path)
	if !strings.Contains(string(after), "port: 7300") {
		t.Errorf("port not corrected on disk:\n%s", after)
	}
	if !strings.Contains(string(after), "# moved off the default") {
		t.Errorf("inline comment lost:\n%s", after)
	}
	if backup, err := os.ReadFile(path + ".bak"); err != nil || string(backup) != src {
		t.Errorf("backup missing or wrong: %v %q", err, backup)
	}
}

func TestLoadYAMLWithRepairLeavesGoodFilesAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "addons.yaml")
	src := "proxies:\n  - name: grafana\n    enabled: true\n    host: grafana\n    port: 3000\n"
	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}

	var cfg AddonProxiesConfig
	repairs, err := loadYAMLWithRepair(path, []byte(src), &cfg)
	if err != nil {
		t.Fatalf("loadYAMLWithRepair: %v", err)
	}
	if len(repairs) != 0 {
		t.Errorf("repairs = %v, want none", repairs)
	}
	if after, _ := os.ReadFile(path); string(after) != src {
		t.Errorf("file was rewritten:\n%s", after)
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Error("backup written for a file that needed no repair")
	}
}

// An unrepairable file must surface the original parse error and leave the file
// untouched, so the operator still has what they wrote to look at.
func TestLoadYAMLWithRepairKeepsOriginalErrorAndFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cwskimmer.yaml")
	src := "port: \"not-a-port\"\n"
	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}

	var cfg CWSkimmerConfig
	if _, err := loadYAMLWithRepair(path, []byte(src), &cfg); err == nil {
		t.Fatal("expected an error")
	} else if !strings.Contains(err.Error(), "cannot unmarshal") {
		t.Errorf("error = %v, want the original yaml parse failure", err)
	}
	if after, _ := os.ReadFile(path); string(after) != src {
		t.Errorf("file was rewritten:\n%s", after)
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Error("backup written for a failed repair")
	}
}

// Every noise floor band must sit on radiod's downconverter.
//
// This is not about resolution. Above the crossover radiod transforms the entire front
// end at the requested bin bandwidth and keeps only the bins asked for, so a 300 kHz
// band at 500 Hz/bin is a 259,200-point FFT of all 129.6 MHz on every poll. Below it
// radiod downconverts to the band and the cost is the band's width -- and, unlike the
// wideband path, does not rise with the poll rate at all.
//
// These defaults were all above the crossover: ~26% of a core at the 1000 ms
// background poll, and ~200% at the 100 ms operators usually set for a smooth SSE
// spectrum stream.
func TestNoiseFloorBandsStayOnTheDownconverter(t *testing.T) {
	cfg := loadConfigForTest(t, "")

	// %CPU per point/s, from the measurements on the live 129.6 Msps receiver.
	const perNarrowbandPoint = 4.5 / 585937.5
	total := 0.0

	for _, b := range cfg.NoiseFloor.Bands {
		if b.BinBandwidth > radiodSpectrumCrossoverHz {
			t.Errorf("band %s: %.0f Hz/bin is above the %.0f Hz crossover -- radiod would "+
				"transform the whole front end for it, on every poll",
				b.Name, b.BinBandwidth, radiodSpectrumCrossoverHz)
		}
		// The delivered span must cover the band, or the edges are simply not measured.
		if span := float64(b.BinCount) * b.BinBandwidth; span < float64(b.End-b.Start) {
			t.Errorf("band %s: %d bins x %.0f Hz = %.0f Hz does not cover its %d Hz",
				b.Name, b.BinCount, b.BinBandwidth, span, b.End-b.Start)
		}
		// Even, or the FFT unwrap's half-swap leaves a bin unwritten.
		if b.BinCount%2 != 0 {
			t.Errorf("band %s: %d bins is odd", b.Name, b.BinCount)
		}
		if b.BinCount > maxSpectrumBins {
			t.Errorf("band %s: %d bins is more than one datagram carries", b.Name, b.BinCount)
		}
		total += perNarrowbandPoint * 1.25 * float64(b.BinCount) * b.BinBandwidth
	}

	// The whole set, at any poll rate. Well under one core.
	if total > 40 {
		t.Errorf("noise floor bands cost %.1f%% of a core in total, want well under 40%%", total)
	}
	t.Logf("%d bands, %.1f%% of a core in total, independent of the poll rate",
		len(cfg.NoiseFloor.Bands), total)
}

// A band configured with only start/end and a bin count can still land above the
// crossover. Widening the bin count is free below it; widening the bandwidth is not.
func TestNoiseFloorDerivedBandIsPulledBelowTheCrossover(t *testing.T) {
	cfg := loadConfigForTest(t, `
noisefloor:
  bands:
    - name: wide
      start: 7000000
      end: 7300000
      bin_count: 100
`) // 300 kHz over 100 bins would derive 3000 Hz/bin

	b := cfg.NoiseFloor.Bands[0]
	if b.BinBandwidth > radiodSpectrumCrossoverHz {
		t.Errorf("derived %.0f Hz/bin, want it pulled to at most %.0f", b.BinBandwidth, radiodSpectrumCrossoverHz)
	}
	if span := float64(b.BinCount) * b.BinBandwidth; span < 300000 {
		t.Errorf("%d bins x %.0f Hz = %.0f Hz, does not cover the 300 kHz band", b.BinCount, b.BinBandwidth, span)
	}
	if b.BinCount%2 != 0 {
		t.Errorf("%d bins is odd", b.BinCount)
	}
}

// loadConfigForTest runs extra YAML through the real LoadConfig, so the defaults under
// test are the ones a receiver actually starts with rather than a reimplementation.
func loadConfigForTest(t *testing.T, extra string) *Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(extra), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	return cfg
}
