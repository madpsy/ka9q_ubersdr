package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func f64(v float64) *float64 { return &v }
func boolp(v bool) *bool     { return &v }

// The link test is the one that matters most: it is the only field of a notice
// that can send a listener anywhere, and the admin form is not the only way a
// value reaches it — the import endpoint and a text editor both bypass it.
func TestNoticeLinkOK(t *testing.T) {
	ok := []string{
		"https://www.paypal.com/donate?hosted_button_id=ABC123",
		"http://192.168.1.10:8080/notes",
		"mailto:operator@example.com",
	}
	for _, u := range ok {
		if !noticeLinkOK(u) {
			t.Errorf("noticeLinkOK(%q) = false, want true", u)
		}
	}

	bad := []string{
		"",
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		"data:text/html;base64,PHNjcmlwdD4=",
		"vbscript:msgbox",
		// Protocol-relative: parses clean, has no scheme to reject, and a
		// browser follows it.
		"//evil.example/donate",
		// Relative, which would resolve against the receiver's own page.
		"/admin/",
		"donate.html",
		"https://",
		"mailto:",
		"https://example.com/" + strings.Repeat("a", noticeMaxURL),
	}
	for _, u := range bad {
		if noticeLinkOK(u) {
			t.Errorf("noticeLinkOK(%q) = true, want false", u)
		}
	}
}

func TestValidateUINotice(t *testing.T) {
	cases := []struct {
		name    string
		notice  *UINotice
		wantErr bool
	}{
		{"absent", nil, false},
		{"a plain one", &UINotice{Enabled: true, Text: "Antenna work until 18:00"}, false},
		{"drafted but off, with nothing in it", &UINotice{}, false},
		{"on with nothing to say", &UINotice{Enabled: true}, true},
		{"bad severity", &UINotice{Enabled: true, Text: "x", Severity: "urgent"}, true},
		{"bad repeat", &UINotice{Enabled: true, Text: "x", Repeat: "hourly"}, true},
		{"negative timeout", &UINotice{Enabled: true, Text: "x", TimeoutSeconds: f64(-1)}, true},
		{"timeout past the cap", &UINotice{Enabled: true, Text: "x", TimeoutSeconds: f64(120)}, true},
		{"until dismissed", &UINotice{Enabled: true, Text: "x", TimeoutSeconds: f64(0)}, false},
		{"script link", &UINotice{Enabled: true, Text: "x", LinkURL: "javascript:alert(1)"}, true},
		{"donate link", &UINotice{Enabled: true, Text: "x", LinkURL: "https://paypal.com/donate?hosted_button_id=A"}, false},
		{"title too long", &UINotice{Enabled: true, Title: strings.Repeat("a", noticeMaxTitle+1)}, true},
		{"text too long", &UINotice{Enabled: true, Text: strings.Repeat("a", noticeMaxText+1)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateUINotice(tc.notice)
			if (err != nil) != tc.wantErr {
				t.Errorf("validateUINotice() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

// What the public endpoint sends is clamped rather than trusted, because a
// ui.yaml can also arrive through the import endpoint or an editor — neither of
// which passes the validation above.
func TestNoticeForWire(t *testing.T) {
	t.Run("nothing to show sends nothing", func(t *testing.T) {
		if got := noticeForWire(nil); got != nil {
			t.Errorf("nil notice = %v, want nil", got)
		}
		if got := noticeForWire(&UINotice{Text: "written but not switched on"}); got != nil {
			t.Errorf("disabled notice = %v, want nil", got)
		}
		if got := noticeForWire(&UINotice{Enabled: true, Text: "   "}); got != nil {
			t.Errorf("whitespace-only notice = %v, want nil", got)
		}
	})

	t.Run("defaults fill in", func(t *testing.T) {
		got := noticeForWire(&UINotice{Enabled: true, Text: "Antenna work"})
		if got["severity"] != "info" {
			t.Errorf("severity = %v, want info", got["severity"])
		}
		if got["timeout_seconds"] != float64(noticeDefTimeout) {
			t.Errorf("timeout_seconds = %v, want %d", got["timeout_seconds"], noticeDefTimeout)
		}
		if got["dismissible"] != true {
			t.Errorf("dismissible = %v, want true", got["dismissible"])
		}
		if got["repeat"] != noticeDefRepeat {
			t.Errorf("repeat = %v, want %s", got["repeat"], noticeDefRepeat)
		}
		if _, ok := got["link_url"]; ok {
			t.Errorf("link_url present with no link set: %v", got)
		}
	})

	t.Run("a hand-edited file is clamped, not obeyed", func(t *testing.T) {
		got := noticeForWire(&UINotice{
			Enabled:        true,
			Severity:       "catastrophic",
			Repeat:         "constantly",
			Title:          strings.Repeat("t", 400),
			Text:           strings.Repeat("x", 900),
			TimeoutSeconds: f64(99999),
		})
		if got["severity"] != "info" || got["repeat"] != noticeDefRepeat {
			t.Errorf("unknown words not replaced by defaults: %v", got)
		}
		if n := len([]rune(got["title"].(string))); n != noticeMaxTitle {
			t.Errorf("title kept %d runes, want %d", n, noticeMaxTitle)
		}
		if n := len([]rune(got["text"].(string))); n != noticeMaxText {
			t.Errorf("text kept %d runes, want %d", n, noticeMaxText)
		}
		if got["timeout_seconds"] != float64(noticeMaxTimeout) {
			t.Errorf("timeout_seconds = %v, want %d", got["timeout_seconds"], noticeMaxTimeout)
		}
	})

	t.Run("a bad link is dropped, the words are not", func(t *testing.T) {
		got := noticeForWire(&UINotice{
			Enabled:   true,
			Text:      "Antenna work until 18:00",
			LinkURL:   "javascript:alert(1)",
			LinkLabel: "Donate",
		})
		if got == nil {
			t.Fatal("the whole notice was withheld because of its link")
		}
		if _, ok := got["link_url"]; ok {
			t.Errorf("a javascript: link reached the client: %v", got)
		}
		if _, ok := got["link_label"]; ok {
			t.Errorf("label kept after its link was dropped: %v", got)
		}
	})

	t.Run("the id follows the wording", func(t *testing.T) {
		a := noticeForWire(&UINotice{Enabled: true, Text: "Back at 16:00"})
		b := noticeForWire(&UINotice{Enabled: true, Text: "Back at 18:00"})
		again := noticeForWire(&UINotice{Enabled: true, Text: "Back at 16:00"})
		if a["id"] == b["id"] {
			t.Error("editing the text left the id alone — a 'once' notice would never be seen again")
		}
		if a["id"] != again["id"] {
			t.Error("the same notice got two ids — a 'once' notice would show every load")
		}
	})
}

// The whole path a notice takes: the admin page's JSON, through ui.yaml on
// disk, out of the public endpoint — and, at the end, the one thing the v2
// block must not do to it.
func TestNoticeRoundTrip(t *testing.T) {
	dir := t.TempDir()
	config := &Config{}

	body := map[string]interface{}{
		"ui": map[string]interface{}{
			"band_color_intensity": 0.5,
			"v2": map[string]interface{}{
				"palette": "ice",
				// The two the feature exists for, together: a temporary amber
				// warning and a standing donate button, each with its own clock.
				"notices": []interface{}{
					map[string]interface{}{
						"enabled":         true,
						"severity":        "warning",
						"title":           "Antenna maintenance",
						"text":            "Reception may be impacted until 18:00 UTC.",
						"timeout_seconds": 5,
						"repeat":          "every-load",
					},
					map[string]interface{}{
						"enabled":         true,
						"severity":        "info",
						"title":           "Support this receiver",
						"text":            "Running costs are met by listeners like you.",
						"link_url":        "https://www.paypal.com/donate?hosted_button_id=ABC",
						"link_label":      "Donate",
						"timeout_seconds": 0,
						"repeat":          "once",
					},
				},
			},
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleAdminPutUIConfig(rec, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(raw))), dir, config)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}

	// On disk, under ui.v2.notices, where an operator with an editor will find them.
	onDisk, err := os.ReadFile(dir + "/ui.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		UI struct {
			V2 struct {
				Notices []UINotice `yaml:"notices"`
			} `yaml:"v2"`
		} `yaml:"ui"`
	}
	if err := yaml.Unmarshal(onDisk, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored.UI.V2.Notices) != 2 {
		t.Fatalf("ui.yaml holds %d notices, want 2: %+v", len(stored.UI.V2.Notices), stored.UI.V2.Notices)
	}
	if stored.UI.V2.Notices[0].Title != "Antenna maintenance" || !stored.UI.V2.Notices[0].Enabled {
		t.Errorf("ui.yaml notices[0] = %+v", stored.UI.V2.Notices[0])
	}

	// In memory, so the very next page load has them with no restart — the whole
	// point of the setting being here rather than in config.yaml.
	if len(config.UI.V2.Notices) != 2 {
		t.Fatalf("in-memory config was not updated: %+v", config.UI.V2)
	}

	pub := httptest.NewRecorder()
	handleUIConfig(pub, httptest.NewRequest(http.MethodGet, "/api/ui-config", nil), config, dir)
	var reply map[string]interface{}
	if err := json.Unmarshal(pub.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}

	list, ok := reply["v2_notices"].([]interface{})
	if !ok || len(list) != 2 {
		t.Fatalf("v2_notices missing or short in the public reply: %s", pub.Body.String())
	}
	warning, _ := list[0].(map[string]interface{})
	donate, _ := list[1].(map[string]interface{})
	// In the order the operator wrote them, each keeping its own clock — the
	// whole reason this is a list and not one message.
	if warning["title"] != "Antenna maintenance" || warning["severity"] != "warning" {
		t.Errorf("notices[0] = %v", warning)
	}
	if warning["timeout_seconds"] != float64(5) || warning["repeat"] != "every-load" {
		t.Errorf("notices[0] = %v", warning)
	}
	if donate["link_label"] != "Donate" || donate["severity"] != "info" {
		t.Errorf("notices[1] = %v", donate)
	}
	if donate["timeout_seconds"] != float64(0) || donate["repeat"] != "once" {
		t.Errorf("notices[1] = %v", donate)
	}
	if warning["id"] == donate["id"] {
		t.Error("two different notices share an id — dismissing one would silence the other")
	}

	// Not inside `v2`. Everything in that block is applied to a first-time
	// visitor only (see parseV2Defaults), so a notice that travelled in it
	// would be shown to nobody who had been here before.
	if v2, ok := reply["v2"].(map[string]interface{}); ok {
		if _, dup := v2["notices"]; dup {
			t.Errorf("notices also sent inside v2, where they would only reach first-time visitors: %v", v2)
		}
	}

	// A save from a page that never rendered the v2 group leaves it alone —
	// the existing rule, checked here because the notice now rides in it and a
	// silently dropped maintenance warning is worse than a dropped palette.
	noV2, err := json.Marshal(map[string]interface{}{"ui": map[string]interface{}{"band_color_intensity": 0.5}})
	if err != nil {
		t.Fatal(err)
	}
	keep := httptest.NewRecorder()
	handleAdminPutUIConfig(keep, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(noV2))), dir, config)
	if keep.Code != http.StatusOK {
		t.Fatalf("save without a v2 block: %d %s", keep.Code, keep.Body.String())
	}
	if len(config.UI.V2.Notices) != 2 || config.UI.V2.Notices[0].Title != "Antenna maintenance" {
		t.Errorf("the notices were lost by a save that never mentioned v2: %+v", config.UI.V2.Notices)
	}
}

// A notice the interface would refuse is refused on the way in, with a message
// that names the field — the admin sees this as the reason their save failed.
func TestAdminPutRejectsABadNotice(t *testing.T) {
	dir := t.TempDir()
	config := &Config{}

	raw, err := json.Marshal(map[string]interface{}{
		"ui": map[string]interface{}{
			"band_color_intensity": 0.5,
			"v2": map[string]interface{}{
				"notices": []interface{}{
					map[string]interface{}{"enabled": true, "text": "Antenna work until 18:00"},
					map[string]interface{}{
						"enabled":  true,
						"text":     "Support the receiver",
						"link_url": "javascript:alert(document.cookie)",
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleAdminPutUIConfig(rec, httptest.NewRequest(http.MethodPut, "/admin/ui-config", strings.NewReader(string(raw))), dir, config)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "link_url") {
		t.Errorf("the error does not say which field is wrong: %s", rec.Body.String())
	}
	// Which of three identical-looking cards, too: "the second one" is the only
	// useful way to say it.
	if !strings.Contains(rec.Body.String(), "message 2") {
		t.Errorf("the error does not say which message is wrong: %s", rec.Body.String())
	}
	if _, err := os.Stat(dir + "/ui.yaml"); !os.IsNotExist(err) {
		t.Errorf("a rejected save still wrote ui.yaml")
	}
}

// The list's own rules, as distinct from each notice's.
func TestNoticesForWire(t *testing.T) {
	t.Run("none, and none worth sending", func(t *testing.T) {
		if got := noticesForWire(nil); got != nil {
			t.Errorf("no notices = %v, want nil", got)
		}
		if got := noticesForWire([]UINotice{{Text: "drafted"}, {Enabled: true}}); got != nil {
			t.Errorf("nothing showable = %v, want nil", got)
		}
	})

	t.Run("one switched off does not end the list", func(t *testing.T) {
		got := noticesForWire([]UINotice{
			{Enabled: true, Text: "Antenna work"},
			{Text: "written for next month"},
			{Enabled: true, Text: "Support the receiver"},
		})
		if len(got) != 2 {
			t.Fatalf("got %d notices, want 2 — the third was dropped with the second", len(got))
		}
		if got[1]["text"] != "Support the receiver" {
			t.Errorf("order not kept: %v", got)
		}
	})

	t.Run("the front door is not a billboard", func(t *testing.T) {
		many := make([]UINotice, 6)
		for i := range many {
			many[i] = UINotice{Enabled: true, Text: "something"}
		}
		if got := noticesForWire(many); len(got) != noticeMaxCount {
			t.Errorf("got %d, want the cap of %d", len(got), noticeMaxCount)
		}
		if err := validateUINotices(many); err == nil {
			t.Error("saving more than the cap was accepted, so the extras would vanish silently")
		}
	})
}
