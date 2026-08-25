package main

import "fmt"

// Operator defaults for the v2 interface.
//
// Kept apart from the rest of UIConfig, in its own `ui.v2:` block, because the
// two interfaces disagree about what several of the shared-looking keys mean.
// `contrast` is a symmetric dB offset in v1 and a gamma on the colour mapping in
// v2; `smoothing` is a spatial on/off there and a 0..1 temporal average here;
// and of v1's seven palettes v2 has two. Stretching one key over both would give
// the operator a control whose preview lies, so each interface names its own.
//
// The keys that genuinely mean the same thing in both — station ID, min span,
// default buffer, band colour intensity, the spectrum backdrop — stay at the top
// level of ui.yaml and are not repeated here.
//
// Every field is a pointer, and that is the whole design: absent means the
// operator has not chosen, which is not the same as choosing what v2 already
// defaults to. The client applies only the keys that are present, and only to a
// browser with no display settings of its own (see display/uiConfig.js and
// DisplayContext.jsx) — so this sets the first impression and never overrides a
// listener who has since picked something else.
//
// Adding a setting means: a field here, an entry in v2Settings below, and a case
// in applyV2Defaults() on the client. The option lists are checked against the v2
// source in ui_config_v2_defaults_test.go, so a palette or colour scheme added to
// the interface and not to this file fails the build's tests rather than quietly
// going missing from the admin UI.
type UIConfigV2 struct {
	// ── Interface ───────────────────────────────────────────────────────────
	// One of the colour schemes in the interface's own Colours menu. Carries
	// both the accent/text colours and whether the page is dark or light, which
	// is why it is one setting rather than three.
	ColorScheme *string `yaml:"color_scheme,omitempty" json:"color_scheme,omitempty"`
	// Multiplier on every font size, as the top bar's A- / A+ buttons set.
	UIScale *float64 `yaml:"ui_scale,omitempty" json:"ui_scale,omitempty"`

	// ── Spectrum and waterfall ──────────────────────────────────────────────
	Palette       *string  `yaml:"palette,omitempty"        json:"palette,omitempty"`
	Contrast      *float64 `yaml:"contrast,omitempty"       json:"contrast,omitempty"`
	ViewMode      *string  `yaml:"view_mode,omitempty"      json:"view_mode,omitempty"`
	WaterfallMode *string  `yaml:"waterfall_mode,omitempty" json:"waterfall_mode,omitempty"`
	DssSeconds    *float64 `yaml:"dss_seconds,omitempty"    json:"dss_seconds,omitempty"`
	WaterfallPan  *string  `yaml:"waterfall_pan,omitempty"  json:"waterfall_pan,omitempty"`
	WaterfallRate *float64 `yaml:"waterfall_rate,omitempty" json:"waterfall_rate,omitempty"`
	RowHeight     *float64 `yaml:"row_height,omitempty"     json:"row_height,omitempty"`
	SmoothScroll  *bool    `yaml:"smooth_scroll,omitempty"  json:"smooth_scroll,omitempty"`
	Smoothing     *float64 `yaml:"smoothing,omitempty"      json:"smoothing,omitempty"`
	PeakHold      *bool    `yaml:"peak_hold,omitempty"      json:"peak_hold,omitempty"`
	Fill          *bool    `yaml:"fill,omitempty"           json:"fill,omitempty"`
	Grid          *bool    `yaml:"grid,omitempty"           json:"grid,omitempty"`

	// ── Tuning ──────────────────────────────────────────────────────────────
	// The step the +/- buttons, click-to-tune and the keyboard all move by.
	//
	// A string rather than a number, because it is a select like the ones above
	// and travels as its option's value: the admin page sends what the <select>
	// holds, and keeping the wire form the same as every other select is what
	// lets it be validated against the option list rather than needing a rule of
	// its own. The client parses it back to a number.
	TuneStep *string `yaml:"tune_step,omitempty" json:"tune_step,omitempty"`
	// What the scroll wheel does over the spectrum: zoom the view, or step the
	// frequency by TuneStep.
	WheelAction *string `yaml:"wheel_action,omitempty" json:"wheel_action,omitempty"`

	// The operator's page-load notices. Here because they are v2's alone, and
	// the one field of this block that is not a display default: it is exempt
	// from the rule above — no v2Settings entry, no applyV2Defaults case —
	// because those describe a control the listener also has in the Display
	// panel, and this is not a setting anybody chooses. They reach the client as
	// their own top-level `v2_notices` key rather than inside `v2`, because
	// everything in `v2` is applied to first-time visitors only and a notice is
	// for everyone. See ui_config_notice.go.
	//
	// json:"-" so they do not also travel inside the `v2` object the public
	// endpoint sends — that copy would be the raw config rather than the
	// clamped one, and two versions of the same notice on the wire is one too
	// many. The admin UI reads them from ui.yaml, which is YAML either way.
	Notices []UINotice `yaml:"notices,omitempty" json:"-"`
}

// ─── Option metadata for the admin UI ────────────────────────────────────────

// V2Option is one choice in a select, as the admin UI draws it.
type V2Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
	// What it looks like, for the swatch beside the label: a CSS colour for a
	// colour scheme, a CSS gradient for a waterfall palette. Empty for settings
	// that are not about colour.
	Swatch string `json:"swatch,omitempty"`
	Note   string `json:"note,omitempty"`
}

// V2Range describes a numeric setting: the same bounds the interface's own
// slider uses, so the admin cannot offer a value the Display panel could not.
type V2Range struct {
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Step    float64 `json:"step"`
	Default float64 `json:"default"`
	// Appended to the value in the readout — "px", " rows/s", "s".
	Unit string `json:"unit,omitempty"`
}

// V2Setting is one row of the v2 group in the admin UI. The admin page builds
// its controls from this list rather than from hardcoded HTML, so a setting
// added here appears there with no page edit.
type V2Setting struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// "interface" or "spectrum" — which subsection it is drawn under.
	Group string `json:"group"`
	// "select", "bool" or "range".
	Kind string `json:"kind"`
	Hint string `json:"hint,omitempty"`
	// What v2 itself does when this is unset, named so the admin's "not set"
	// option can say which it is rather than leaving the operator to guess.
	Default string     `json:"default,omitempty"`
	Options []V2Option `json:"options,omitempty"`
	Range   *V2Range   `json:"range,omitempty"`
}

// The colour schemes in v2's Colours menu, in menu order. Values are the `id`
// fields of UI_THEMES in static/v2/src/lib/uiColors.js; the swatch is each
// scheme's accent, which is what the menu draws it as.
var v2ColorSchemes = []V2Option{
	{Value: "default", Label: "UberSDR", Swatch: "#667eea", Note: "The receiver's own blue on the dark page"},
	{Value: "contrast", Label: "High contrast", Swatch: "#ffa000", Note: "Maximum legibility: white on near-black"},
	{Value: "amber", Label: "Amber", Swatch: "#ffb000", Note: "An amber monitor, as the first ones were"},
	{Value: "phosphor", Label: "Phosphor", Swatch: "#35e07a", Note: "Green screen"},
	{Value: "night", Label: "Night", Swatch: "#ff4b2e", Note: "Deep red only, to keep dark adaptation at the radio"},
	{Value: "ice", Label: "Ice", Swatch: "#45d6e6", Note: "Cyan on near-black"},
	{Value: "violet", Label: "Violet", Swatch: "#a58bff", Note: "The violet the app uses for its second colour"},
	{Value: "mono", Label: "Mono", Swatch: "#aab6c6", Note: "No hue in the interface at all"},
	{Value: "paper", Label: "Paper", Swatch: "#0a5ea8", Note: "Ink on paper, for a bright room — the light scheme"},
}

// v2's waterfall colour maps, in the order the Colours menu lists them. The
// swatch is the palette's own gradient, built from the same control points as
// STOPS in static/v2/src/lib/palettes.js.
var v2Palettes = []V2Option{
	{Value: "turbo", Label: "Turbo", Swatch: "linear-gradient(90deg,rgb(48,18,59) 0%,rgb(70,107,227) 13%,rgb(54,168,237) 25%,rgb(42,217,184) 38%,rgb(118,244,112) 50%,rgb(200,246,56) 63%,rgb(253,197,39) 75%,rgb(245,111,25) 88%,rgb(122,4,3) 100%)"},
	{Value: "viridis", Label: "Viridis", Swatch: "linear-gradient(90deg,rgb(68,1,84) 0%,rgb(59,82,139) 25%,rgb(33,145,140) 50%,rgb(94,201,98) 75%,rgb(253,231,37) 100%)"},
	{Value: "inferno", Label: "Inferno", Swatch: "linear-gradient(90deg,rgb(0,0,4) 0%,rgb(87,16,110) 25%,rgb(188,55,84) 50%,rgb(249,142,9) 75%,rgb(252,255,164) 100%)"},
	{Value: "magma", Label: "Magma", Swatch: "linear-gradient(90deg,rgb(0,0,4) 0%,rgb(81,18,124) 25%,rgb(183,55,121) 50%,rgb(252,137,97) 75%,rgb(252,253,191) 100%)"},
	{Value: "classic", Label: "Classic", Swatch: "linear-gradient(90deg,rgb(0,0,0) 0%,rgb(0,0,140) 20%,rgb(0,160,220) 40%,rgb(240,230,60) 62%,rgb(240,90,30) 82%,rgb(255,255,255) 100%)", Note: "Black-blue-cyan-yellow-white, as SDR waterfalls have always looked"},
	{Value: "mono", Label: "Mono", Swatch: "linear-gradient(90deg,rgb(4,5,8) 0%,rgb(245,248,255) 100%)"},
	{Value: "ice", Label: "Ice", Swatch: "linear-gradient(90deg,rgb(4,8,16) 0%,rgb(12,66,104) 35%,rgb(62,180,208) 70%,rgb(226,250,255) 100%)"},
	{Value: "radar", Label: "Radar", Swatch: "linear-gradient(90deg,rgb(2,10,5) 0%,rgb(6,54,24) 30%,rgb(12,122,46) 55%,rgb(46,200,78) 78%,rgb(130,240,132) 92%,rgb(226,255,226) 100%)", Note: "A radar scope: one green hue up to a hot trace"},
}

// The tuning steps the interface offers, in the order its own step menus list
// them. Values are TUNING_STEPS from static/v2/src/radio/constants.js, written
// as the strings a <select> holds — see TuneStep — and labelled the way
// stepLabel() there labels them.
var v2TuneSteps = []V2Option{
	{Value: "1", Label: "1 Hz"},
	{Value: "10", Label: "10 Hz"},
	{Value: "100", Label: "100 Hz"},
	{Value: "500", Label: "500 Hz", Note: "Suits SSB, which is most of what these bands carry"},
	{Value: "1000", Label: "1 kHz"},
	{Value: "5000", Label: "5 kHz", Note: "Shortwave broadcast spacing"},
	{Value: "9000", Label: "9 kHz", Note: "Medium wave channel spacing outside the Americas"},
	{Value: "10000", Label: "10 kHz", Note: "Medium wave channel spacing in the Americas"},
	{Value: "100000", Label: "100 kHz"},
}

// Every v2 setting the admin UI offers, in display order. Ranges mirror the
// Display panel's own sliders (static/v2/src/panels/DisplayPanel.jsx) and the
// defaults mirror DEFAULTS in static/v2/src/display/DisplayContext.jsx.
var v2Settings = []V2Setting{
	{
		Key: "color_scheme", Label: "Colour scheme", Group: "interface", Kind: "select",
		Hint:    "Accent, text and whether the page is dark or light — one choice, as the Colours menu makes it.",
		Default: "UberSDR", Options: v2ColorSchemes,
	},
	{
		Key: "ui_scale", Label: "Text size", Group: "interface", Kind: "range",
		Hint:  "Multiplier on every font size, as the top bar's A- / A+ buttons set.",
		Range: &V2Range{Min: 0.75, Max: 1.6, Step: 0.05, Default: 1},
	},
	{
		Key: "palette", Label: "Waterfall palette", Group: "spectrum", Kind: "select",
		Hint:    "The colour map for the waterfall and the spectrum trace.",
		Default: "Classic", Options: v2Palettes,
	},
	{
		Key: "contrast", Label: "Contrast", Group: "spectrum", Kind: "range",
		Hint:  "Gamma on the amplitude-to-colour mapping. Below 1 lifts weak signals, above 1 darkens the noise. Not v1's contrast, which is a dB offset.",
		Range: &V2Range{Min: 0.4, Max: 2.5, Step: 0.05, Default: 1},
	},
	{
		Key: "view_mode", Label: "View", Group: "spectrum", Kind: "select",
		Hint:    "Which panes the display opens with.",
		Default: "Split", Options: []V2Option{
			{Value: "split", Label: "Split", Note: "Spectrum above, waterfall below"},
			{Value: "spectrum", Label: "Spectrum only"},
			{Value: "waterfall", Label: "Waterfall only"},
		},
	},
	{
		Key: "waterfall_mode", Label: "Waterfall style", Group: "spectrum", Kind: "select",
		Hint:    "How the history is drawn.",
		Default: "2D", Options: []V2Option{
			{Value: "2d", Label: "2D", Note: "Heat map — the classic waterfall"},
			{Value: "3d", Label: "3D", Note: "Perspective stack of recent traces"},
			{Value: "both", Label: "2D + 3D", Note: "Both, newest rows meeting in the middle"},
		},
	},
	{
		Key: "dss_seconds", Label: "3D depth", Group: "spectrum", Kind: "range",
		Hint:  "Seconds of history the 3D surface reaches back. Only applies where the waterfall style is 3D or 2D+3D.",
		Range: &V2Range{Min: 1, Max: 30, Step: 1, Default: 10, Unit: "s"},
	},
	{
		Key: "waterfall_pan", Label: "History on pan", Group: "spectrum", Kind: "select",
		Hint:    "What the waterfall's existing rows do when the view is dragged or zoomed.",
		Default: "Follow the scale", Options: []V2Option{
			{Value: "follow", Label: "Follow the scale", Note: "Rows shift with the axis, so a signal keeps its column"},
			{Value: "hold", Label: "Hold in place", Note: "Rows stay where they were painted, as v1 does"},
		},
	},
	{
		Key: "waterfall_rate", Label: "Waterfall speed", Group: "spectrum", Kind: "range",
		Hint:  "Committed rows per second.",
		Range: &V2Range{Min: 2, Max: 40, Step: 1, Default: 20, Unit: " rows/s"},
	},
	{
		Key: "row_height", Label: "Row height", Group: "spectrum", Kind: "range",
		Hint:  "Device pixels per waterfall row. Taller rows mean less history on screen.",
		Range: &V2Range{Min: 1, Max: 4, Step: 1, Default: 2, Unit: " px"},
	},
	{
		Key: "smoothing", Label: "Trace smoothing", Group: "spectrum", Kind: "range",
		Hint:  "Temporal averaging of the spectrum trace. 0 is off. Not v1's smoothing, which is spatial.",
		Range: &V2Range{Min: 0, Max: 0.92, Step: 0.02, Default: 0.5},
	},
	{
		Key: "smooth_scroll", Label: "Smooth scroll", Group: "spectrum", Kind: "bool",
		Hint:    "Slide each new row into view instead of letting it appear in one frame. v1 calls this GPU sub-pixel scroll.",
		Default: "on",
	},
	{Key: "peak_hold", Label: "Peak hold", Group: "spectrum", Kind: "bool", Hint: "Hold the highest trace seen, decaying slowly.", Default: "off"},
	{Key: "fill", Label: "Fill under trace", Group: "spectrum", Kind: "bool", Hint: "Solid area beneath the spectrum line.", Default: "on"},
	{Key: "grid", Label: "Grid", Group: "spectrum", Kind: "bool", Hint: "dB gridlines across the spectrum pane.", Default: "off"},
	{
		Key: "tune_step", Label: "Step size", Group: "tuning", Kind: "select",
		Hint:    "How far the +/- buttons, click-to-tune and the arrow keys move the dial. The Receiver panel's step menu sets the same thing.",
		Default: "500 Hz", Options: v2TuneSteps,
	},
	{
		Key: "wheel_action", Label: "Scroll wheel", Group: "tuning", Kind: "select",
		Hint:    "What the wheel does over the spectrum. Shift+wheel sets the filter width either way.",
		Default: "Zoom", Options: []V2Option{
			{Value: "zoom", Label: "Zoom", Note: "A notch in or out of the view"},
			{Value: "tune", Label: "Tune", Note: "A notch moves the dial by the step size"},
		},
	},
}

// v2SettingByKey indexes the table above for validation.
var v2SettingByKey = func() map[string]V2Setting {
	m := make(map[string]V2Setting, len(v2Settings))
	for _, s := range v2Settings {
		m[s.Key] = s
	}
	return m
}()

// v2OptionValid reports whether val is one of the options for key.
func v2OptionValid(key, val string) bool {
	for _, o := range v2SettingByKey[key].Options {
		if o.Value == val {
			return true
		}
	}
	return false
}

// v2RangeValid reports whether val is inside the slider bounds for key.
func v2RangeValid(key string, val float64) bool {
	r := v2SettingByKey[key].Range
	return r != nil && val >= r.Min && val <= r.Max
}

// validateUIConfigV2 rejects a value the interface could not act on: a palette
// or colour scheme it does not have, or a number outside the slider that sets
// it. Absent keys are always fine — that is the operator not choosing.
//
// Checked rather than clamped, because every one of these arrives from a control
// built out of v2Settings: a value off the end of the list is a bug in the admin
// page or a hand-edited ui.yaml, and silently storing the nearest legal value
// would hide both.
func validateUIConfigV2(v UIConfigV2) error {
	sel := []struct {
		key string
		val *string
	}{
		{"color_scheme", v.ColorScheme},
		{"palette", v.Palette},
		{"view_mode", v.ViewMode},
		{"waterfall_mode", v.WaterfallMode},
		{"waterfall_pan", v.WaterfallPan},
		{"tune_step", v.TuneStep},
		{"wheel_action", v.WheelAction},
	}
	for _, s := range sel {
		if s.val != nil && !v2OptionValid(s.key, *s.val) {
			return fmt.Errorf("ui.v2.%s: %q is not one of the v2 interface's options", s.key, *s.val)
		}
	}

	num := []struct {
		key string
		val *float64
	}{
		{"ui_scale", v.UIScale},
		{"contrast", v.Contrast},
		{"dss_seconds", v.DssSeconds},
		{"waterfall_rate", v.WaterfallRate},
		{"row_height", v.RowHeight},
		{"smoothing", v.Smoothing},
	}
	for _, n := range num {
		if n.val == nil {
			continue
		}
		if !v2RangeValid(n.key, *n.val) {
			r := v2SettingByKey[n.key].Range
			return fmt.Errorf("ui.v2.%s: %g is outside %g-%g", n.key, *n.val, r.Min, r.Max)
		}
	}

	return validateUINotices(v.Notices)
}
