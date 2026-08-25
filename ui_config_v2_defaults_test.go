package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The v2 option lists in ui_config_v2_defaults.go are what the admin UI draws
// its dropdowns from, and they are a hand-written copy of what the interface
// itself has. These tests read the v2 source and fail when the two drift —
// which is the whole failure mode worth guarding here: an admin UI that offers
// seven of eight palettes looks completely correct, and the missing one is
// simply unreachable to every operator until somebody notices.

const v2SrcDir = "static/v2/src"

func readV2Source(t *testing.T, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(v2SrcDir, rel))
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	return string(data)
}

// TestV2PalettesMatchTheInterface checks the palette list against the STOPS
// table in lib/palettes.js, which is where PALETTE_NAMES comes from.
func TestV2PalettesMatchTheInterface(t *testing.T) {
	src := readV2Source(t, "lib/palettes.js")
	stops := src[strings.Index(src, "const STOPS = {"):]
	stops = stops[:strings.Index(stops, "\n};")]

	// Keys at one level of indentation inside STOPS — nested lines are the
	// control points, which are indented further and start with '['.
	re := regexp.MustCompile(`(?m)^    ([a-z0-9]+): \[`)
	want := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(stops, -1) {
		want[m[1]] = true
	}
	if len(want) == 0 {
		t.Fatal("no palettes found in lib/palettes.js — has STOPS been restructured?")
	}

	got := map[string]bool{}
	for _, o := range v2Palettes {
		got[o.Value] = true
		if o.Label == "" {
			t.Errorf("palette %q has no label for the admin UI", o.Value)
		}
		if o.Swatch == "" {
			t.Errorf("palette %q has no gradient swatch", o.Value)
		}
	}

	for name := range want {
		if !got[name] {
			t.Errorf("v2 has palette %q but the admin UI does not offer it (add it to v2Palettes)", name)
		}
	}
	for name := range got {
		if !want[name] {
			t.Errorf("the admin UI offers palette %q, which v2 does not have", name)
		}
	}
}

// TestV2ColorSchemesMatchTheInterface does the same for UI_THEMES.
func TestV2ColorSchemesMatchTheInterface(t *testing.T) {
	src := readV2Source(t, "lib/uiColors.js")
	themes := src[strings.Index(src, "export const UI_THEMES = ["):]
	themes = themes[:strings.Index(themes, "\n];")]

	re := regexp.MustCompile(`(?m)^        id: '([a-z]+)',`)
	want := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(themes, -1) {
		want[m[1]] = true
	}
	if len(want) == 0 {
		t.Fatal("no colour schemes found in lib/uiColors.js — has UI_THEMES been restructured?")
	}

	got := map[string]bool{}
	for _, o := range v2ColorSchemes {
		got[o.Value] = true
		if o.Swatch == "" {
			t.Errorf("colour scheme %q has no swatch", o.Value)
		}
	}

	for id := range want {
		if !got[id] {
			t.Errorf("v2 has colour scheme %q but the admin UI does not offer it (add it to v2ColorSchemes)", id)
		}
	}
	for id := range got {
		if !want[id] {
			t.Errorf("the admin UI offers colour scheme %q, which v2 does not have", id)
		}
	}
}

// TestV2RangesMatchTheClient checks the numeric bounds against V2_RANGES in
// display/uiConfig.js — the table the client clamps with. A wider range here
// than there would let the admin store a value the interface then silently
// pulls back, which looks like the setting being ignored.
func TestV2RangesMatchTheClient(t *testing.T) {
	src := readV2Source(t, "display/uiConfig.js")
	block := src[strings.Index(src, "export const V2_RANGES = {"):]
	block = block[:strings.Index(block, "\n};")]

	re := regexp.MustCompile(`(?m)^    ([a-z_]+): \{ key: '[A-Za-z]+', min: (-?[\d.]+), max: (-?[\d.]+) \}`)
	found := 0
	for _, m := range re.FindAllStringSubmatch(block, -1) {
		found++
		s, ok := v2SettingByKey[m[1]]
		if !ok || s.Range == nil {
			t.Errorf("the client clamps %q but the admin UI has no range for it", m[1])
			continue
		}
		if got := formatNum(s.Range.Min); got != m[2] {
			t.Errorf("%s min: admin %s, client %s", m[1], got, m[2])
		}
		if got := formatNum(s.Range.Max); got != m[3] {
			t.Errorf("%s max: admin %s, client %s", m[1], got, m[3])
		}
	}
	if found == 0 {
		t.Fatal("no ranges parsed from display/uiConfig.js — has V2_RANGES been restructured?")
	}

	// And the other way: every range the admin offers must be one the client
	// knows, or setting it does nothing at all.
	for _, s := range v2Settings {
		if s.Range == nil {
			continue
		}
		if !strings.Contains(block, "\n    "+s.Key+": {") {
			t.Errorf("the admin UI offers %q but the client does not read it", s.Key)
		}
	}
}

// TestV2EnumsAndBoolsMatchTheClient checks the word lists and the switches the
// same way, against V2_ENUMS and V2_BOOLS.
func TestV2EnumsAndBoolsMatchTheClient(t *testing.T) {
	src := readV2Source(t, "display/uiConfig.js")

	for _, s := range v2Settings {
		switch s.Kind {
		case "select":
			if s.Key == "color_scheme" || s.Key == "palette" || s.Key == "tune_step" {
				continue // handled by their own tests above
			}
			block := src[strings.Index(src, "export const V2_ENUMS = {"):]
			block = block[:strings.Index(block, "\n};")]
			line := lineWithPrefix(block, "    "+s.Key+": ")
			if line == "" {
				t.Errorf("the admin UI offers %q but V2_ENUMS does not list it", s.Key)
				continue
			}
			for _, o := range s.Options {
				if !strings.Contains(line, "'"+o.Value+"'") {
					t.Errorf("%s: the admin UI offers %q, which the client does not accept", s.Key, o.Value)
				}
			}
		case "bool":
			block := src[strings.Index(src, "export const V2_BOOLS = {"):]
			block = block[:strings.Index(block, "\n};")]
			if !strings.Contains(block, "\n    "+s.Key+": ") {
				t.Errorf("the admin UI offers %q but V2_BOOLS does not list it", s.Key)
			}
		}
	}
}

// TestV2TuneStepsMatchTheInterface checks the step list against both sides of
// the interface: TUNING_STEPS in radio/constants.js, which is what its own step
// menus offer, and V2_STEPS in display/uiConfig.js, which is what it accepts
// from the operator. A step in the admin UI that is in neither is one an
// operator can save and nothing will act on.
func TestV2TuneStepsMatchTheInterface(t *testing.T) {
	steps := func(src, decl string) []string {
		t.Helper()
		i := strings.Index(src, decl)
		if i < 0 {
			t.Fatalf("%q not found — has it been restructured?", decl)
		}
		list := src[i+len(decl):]
		list = list[:strings.Index(list, "]")]
		out := []string{}
		for _, f := range strings.Split(list, ",") {
			if f = strings.TrimSpace(f); f != "" {
				out = append(out, f)
			}
		}
		return out
	}

	want := steps(readV2Source(t, "radio/constants.js"), "export const TUNING_STEPS = [")
	client := steps(readV2Source(t, "display/uiConfig.js"), "tune_step: { key: 'tuneStep', values: [")
	if len(want) == 0 {
		t.Fatal("no tuning steps found in radio/constants.js")
	}
	if strings.Join(want, ",") != strings.Join(client, ",") {
		t.Errorf("the client accepts steps %v but the interface offers %v", client, want)
	}

	got := []string{}
	for _, o := range v2TuneSteps {
		got = append(got, o.Value)
		// Labelled the way the interface's own step menus label it, so the two
		// lists read identically as well as holding the same values — see
		// stepLabel() in radio/constants.js, which is this rule.
		hz, err := strconv.Atoi(o.Value)
		if err != nil {
			t.Errorf("step %q is not a number of hertz", o.Value)
			continue
		}
		want := fmt.Sprintf("%d Hz", hz)
		if hz >= 1000 {
			want = strconv.FormatFloat(float64(hz)/1000, 'f', -1, 64) + " kHz"
		}
		if o.Label != want {
			t.Errorf("step %s is labelled %q here and %q in the interface", o.Value, o.Label, want)
		}
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("the admin UI offers steps %v, in this order; the interface has %v", got, want)
	}
}

// TestValidateUIConfigV2 covers the save-time check.
func TestValidateUIConfigV2(t *testing.T) {
	str := func(s string) *string { return &s }
	num := func(f float64) *float64 { return &f }

	t.Run("empty is valid", func(t *testing.T) {
		if err := validateUIConfigV2(UIConfigV2{}); err != nil {
			t.Errorf("an operator who set nothing must be valid: %v", err)
		}
	})

	t.Run("known values pass", func(t *testing.T) {
		v := UIConfigV2{
			ColorScheme: str("paper"), Palette: str("radar"), ViewMode: str("waterfall"),
			WaterfallMode: str("both"), WaterfallPan: str("hold"),
			UIScale: num(1.6), Contrast: num(0.4), Smoothing: num(0), RowHeight: num(4),
		}
		if err := validateUIConfigV2(v); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("a palette v2 does not have is rejected", func(t *testing.T) {
		// jet is the classic interface's default, and one of the five it has
		// that v2 does not — exactly the mistake this catches.
		if err := validateUIConfigV2(UIConfigV2{Palette: str("jet")}); err == nil {
			t.Error("expected an error for palette jet")
		}
	})

	t.Run("out of range is rejected", func(t *testing.T) {
		for _, v := range []UIConfigV2{
			{UIScale: num(3)},
			{Contrast: num(0)},
			{Smoothing: num(1)}, // the slider stops at 0.92
			{WaterfallRate: num(1)},
			{DssSeconds: num(31)},
		} {
			if err := validateUIConfigV2(v); err == nil {
				t.Errorf("expected an error for %+v", v)
			}
		}
	})
}

// TestUIConfigV2OverTheWire covers the two things the client depends on: unset
// keys are absent rather than zeroed, and set ones arrive under "v2".
func TestUIConfigV2OverTheWire(t *testing.T) {
	t.Run("an untouched receiver sends an empty object", func(t *testing.T) {
		data, err := json.Marshal(UIConfigV2{})
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "{}" {
			t.Errorf("got %s, want {} — an unset key must not reach the client as a value", data)
		}
	})

	t.Run("only what was set is sent", func(t *testing.T) {
		pal := "classic"
		grid := false
		data, err := json.Marshal(UIConfigV2{Palette: &pal, Grid: &grid})
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]interface{}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 {
			t.Errorf("got %v, want exactly palette and grid", got)
		}
		// grid:false is a choice, not an absence — omitempty on a *bool keys
		// off the pointer, which is why the field is one.
		if v, ok := got["grid"]; !ok || v != false {
			t.Errorf("grid: got %v (present=%v), want false", v, ok)
		}
	})

	t.Run("the public endpoint carries the block", func(t *testing.T) {
		scheme := "night"
		config := &Config{}
		config.UI.V2.ColorScheme = &scheme

		req := httptest.NewRequest(http.MethodGet, "/api/ui-config", nil)
		rec := httptest.NewRecorder()
		handleUIConfig(rec, req, config, "")

		var body struct {
			V2 map[string]interface{} `json:"v2"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decoding reply: %v", err)
		}
		if body.V2["color_scheme"] != "night" {
			t.Errorf("color_scheme = %v, want night", body.V2["color_scheme"])
		}
		if len(body.V2) != 1 {
			t.Errorf("v2 = %v, want only the key that was set", body.V2)
		}
	})
}

// TestAdminUIConfigV2RoundTrip covers the path a save actually takes: the admin
// page's JSON, through YAML on disk, back out of the admin endpoint and out of
// the public one. The pointers are the fragile part — a plain field would make
// "not set" and "set to the zero value" the same thing by the time it lands.
func TestAdminUIConfigV2RoundTrip(t *testing.T) {
	dir := t.TempDir()
	config := &Config{}

	body := map[string]interface{}{
		"ui": map[string]interface{}{
			// band_color_intensity has a floor of 0.5 and is validated on save,
			// so a bare {} body would be rejected before reaching the v2 block.
			"band_color_intensity": 0.5,
			"v2": map[string]interface{}{
				"palette":  "ice",
				"grid":     false,
				"ui_scale": 1.15,
				// A step is a select like the rest, so the admin page sends the
				// string its <select> holds — the round trip has to keep it one
				// rather than turning it into a number the client then cannot
				// tell from a hand-edited ui.yaml.
				"tune_step":    "9000",
				"wheel_action": "tune",
			},
		},
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(raw)))
	rec := httptest.NewRecorder()
	handleAdminPutUIConfig(rec, req, dir, config)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d: %s", rec.Code, rec.Body.String())
	}

	// In memory, immediately — no restart.
	if config.UI.V2.Palette == nil || *config.UI.V2.Palette != "ice" {
		t.Errorf("palette = %v, want ice", config.UI.V2.Palette)
	}
	if config.UI.V2.Grid == nil || *config.UI.V2.Grid != false {
		t.Errorf("grid = %v, want a pointer to false — not nil, which would mean unset", config.UI.V2.Grid)
	}
	if config.UI.V2.TuneStep == nil || *config.UI.V2.TuneStep != "9000" {
		t.Errorf("tune_step = %v, want the string 9000", config.UI.V2.TuneStep)
	}
	if config.UI.V2.WheelAction == nil || *config.UI.V2.WheelAction != "tune" {
		t.Errorf("wheel_action = %v, want tune", config.UI.V2.WheelAction)
	}
	if config.UI.V2.Contrast != nil {
		t.Errorf("contrast = %v, want nil: the operator did not set it", *config.UI.V2.Contrast)
	}

	// On disk, as YAML the operator can read and edit.
	onDisk, err := os.ReadFile(filepath.Join(dir, "ui.yaml"))
	if err != nil {
		t.Fatalf("reading back ui.yaml: %v", err)
	}
	for _, want := range []string{"palette: ice", "grid: false", "ui_scale: 1.15", `tune_step: "9000"`, "wheel_action: tune"} {
		if !strings.Contains(string(onDisk), want) {
			t.Errorf("ui.yaml is missing %q:\n%s", want, onDisk)
		}
	}
	if strings.Contains(string(onDisk), "v2_settings") {
		t.Error("the option lists were written into ui.yaml, where they would go stale")
	}

	// And back out of the admin endpoint, with the option lists beside it.
	getRec := httptest.NewRecorder()
	handleAdminGetUIConfig(getRec, httptest.NewRequest(http.MethodGet, "/admin/ui-config", nil), dir, config)
	var got struct {
		UI struct {
			V2 map[string]interface{} `json:"v2"`
		} `json:"ui"`
		V2Settings []V2Setting `json:"v2_settings"`
	}
	if err := json.Unmarshal(getRec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding admin reply: %v", err)
	}
	if got.UI.V2["palette"] != "ice" {
		t.Errorf("admin GET palette = %v, want ice", got.UI.V2["palette"])
	}
	if len(got.V2Settings) != len(v2Settings) {
		t.Errorf("admin GET sent %d settings, want %d — the admin UI builds its controls from these",
			len(got.V2Settings), len(v2Settings))
	}

	// A save that carries no v2 block at all leaves the stored one alone. This
	// is the stale-page case: every key in the block is optional, so a wipe and
	// an operator who set nothing produce the same JSON, and the difference has
	// to be carried by the key's presence rather than by its contents.
	noBlock, _ := json.Marshal(map[string]interface{}{
		"ui": map[string]interface{}{"band_color_intensity": 0.5},
	})
	noRec := httptest.NewRecorder()
	handleAdminPutUIConfig(noRec, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(noBlock))), dir, config)
	if noRec.Code != http.StatusOK {
		t.Fatalf("PUT without a v2 block: status = %d: %s", noRec.Code, noRec.Body.String())
	}
	if config.UI.V2.Palette == nil || *config.UI.V2.Palette != "ice" {
		t.Errorf("palette = %v after a save with no v2 block, want it left at ice", config.UI.V2.Palette)
	}
	if again, err := os.ReadFile(filepath.Join(dir, "ui.yaml")); err != nil {
		t.Fatal(err)
	} else if !strings.Contains(string(again), "palette: ice") {
		t.Errorf("the v2 block was dropped from ui.yaml by a save that never mentioned it:\n%s", again)
	}

	// An explicitly empty block is a different thing, and does clear it: that is
	// an operator un-ticking every row.
	empty, _ := json.Marshal(map[string]interface{}{
		"ui": map[string]interface{}{"band_color_intensity": 0.5, "v2": map[string]interface{}{}},
	})
	emptyRec := httptest.NewRecorder()
	handleAdminPutUIConfig(emptyRec, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(empty))), dir, config)
	if emptyRec.Code != http.StatusOK {
		t.Fatalf("PUT with an empty v2 block: status = %d: %s", emptyRec.Code, emptyRec.Body.String())
	}
	if config.UI.V2.Palette != nil {
		t.Errorf("palette = %v, want nil: every row was un-ticked", *config.UI.V2.Palette)
	}

	// Put it back for the check below.
	restoreRec := httptest.NewRecorder()
	handleAdminPutUIConfig(restoreRec, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(raw))), dir, config)
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("restoring: status = %d: %s", restoreRec.Code, restoreRec.Body.String())
	}

	// A value v2 has no idea what to do with is refused rather than stored.
	bad, _ := json.Marshal(map[string]interface{}{
		"ui": map[string]interface{}{
			"band_color_intensity": 0.5,
			"v2":                   map[string]interface{}{"palette": "jet"},
		},
	})
	badRec := httptest.NewRecorder()
	handleAdminPutUIConfig(badRec, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(bad))), dir, config)
	if badRec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a palette v2 does not have", badRec.Code)
	}
	if config.UI.V2.Palette == nil || *config.UI.V2.Palette != "ice" {
		t.Error("a rejected save changed the in-memory config")
	}
}

// TestV2SettingsTableIsWellFormed guards the contract the admin page's renderer
// relies on: every row has a control it knows how to draw, in a group it draws.
func TestV2SettingsTableIsWellFormed(t *testing.T) {
	// Read from the page rather than listed here: a setting in a group the
	// renderer has no section for is dropped without a word, which looks
	// exactly like the server not sending it.
	admin, err := os.ReadFile(filepath.Join("static", "admin.html"))
	if err != nil {
		t.Fatalf("reading static/admin.html: %v", err)
	}
	groups := string(admin)[strings.Index(string(admin), "const GROUPS = ["):]
	groups = groups[:strings.Index(groups, "\n            ];")]
	adminGroups := map[string]bool{}
	for _, m := range regexp.MustCompile(`id: '([a-z]+)'`).FindAllStringSubmatch(groups, -1) {
		adminGroups[m[1]] = true
	}
	if len(adminGroups) == 0 {
		t.Fatal("no groups found in admin.html — has renderV2Settings been restructured?")
	}

	seen := map[string]bool{}
	for _, s := range v2Settings {
		if seen[s.Key] {
			t.Errorf("duplicate key %q", s.Key)
		}
		seen[s.Key] = true

		if !adminGroups[s.Group] {
			t.Errorf("%s: group %q is not one the admin UI renders", s.Key, s.Group)
		}
		switch s.Kind {
		case "select":
			if len(s.Options) == 0 {
				t.Errorf("%s: a select with no options", s.Key)
			}
			// The "not set" label names v2's own default by *label*, and the
			// renderer opens the list on it — a typo there would silently open
			// on the first option instead.
			found := false
			for _, o := range s.Options {
				if o.Label == s.Default {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: default %q does not name any option's label", s.Key, s.Default)
			}
		case "bool":
			if s.Default != "on" && s.Default != "off" {
				t.Errorf("%s: bool default %q must be on or off", s.Key, s.Default)
			}
		case "range":
			if s.Range == nil {
				t.Errorf("%s: a range with no bounds", s.Key)
				continue
			}
			if s.Range.Min >= s.Range.Max {
				t.Errorf("%s: min %g is not below max %g", s.Key, s.Range.Min, s.Range.Max)
			}
			if s.Range.Default < s.Range.Min || s.Range.Default > s.Range.Max {
				t.Errorf("%s: default %g is outside its own bounds", s.Key, s.Range.Default)
			}
		default:
			t.Errorf("%s: kind %q is not one the admin UI renders", s.Key, s.Kind)
		}
		if s.Hint == "" {
			t.Errorf("%s: no hint — the admin UI has a line for it", s.Key)
		}
	}
}

// ─── helpers ────────────────────────────────────────────────────────────────

// formatNum renders a float the way the JS source writes it: 0.92, 30, 1.6.
func formatNum(f float64) string {
	s := strings.TrimRight(strings.TrimRight(formatFloat(f), "0"), ".")
	if s == "" || s == "-" {
		return "0"
	}
	return s
}

func formatFloat(f float64) string {
	b, _ := json.Marshal(f)
	s := string(b)
	if !strings.Contains(s, ".") {
		return s + ".0"
	}
	return s
}

// lineWithPrefix returns the first line of s starting with prefix, or "".
func lineWithPrefix(s, prefix string) string {
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, prefix) {
			return line
		}
	}
	return ""
}
