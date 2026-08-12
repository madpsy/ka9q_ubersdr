package main

import (
	"bytes"
	"encoding/json"
	"html/template"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestHandleIndexPageV2Redirect covers the server-side switch between the two
// interfaces: off means the classic page is rendered, on means / redirects to
// /v2/ before any of it is written, and ?v1 always reaches the classic page.
func TestHandleIndexPageV2Redirect(t *testing.T) {
	tests := []struct {
		name         string
		v2           bool
		target       string
		wantStatus   int
		wantLocation string
	}{
		{name: "disabled serves v1", v2: false, target: "/", wantStatus: http.StatusOK},
		{name: "enabled redirects", v2: true, target: "/", wantStatus: http.StatusFound, wantLocation: "/v2/"},
		{name: "enabled redirects index.html", v2: true, target: "/index.html", wantStatus: http.StatusFound, wantLocation: "/v2/"},
		{name: "query is carried across", v2: true, target: "/?f=7074&mode=usb", wantStatus: http.StatusFound, wantLocation: "/v2/?f=7074&mode=usb"},
		{name: "v1 opts out", v2: true, target: "/?v1", wantStatus: http.StatusOK},
		{name: "v1=1 opts out", v2: true, target: "/?v1=1", wantStatus: http.StatusOK},
	}

	// handleIndexPage renders the real template on the non-redirect path.
	if err := loadIndexTemplateForTest(); err != nil {
		t.Fatalf("parsing index template: %v", err)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := &Config{}
			config.UI.V2Interface = tt.v2

			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			rec := httptest.NewRecorder()
			handleIndexPage(rec, req, config, &WidgetManager{})

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if got := rec.Header().Get("Location"); got != tt.wantLocation {
				t.Errorf("Location = %q, want %q", got, tt.wantLocation)
			}
			if tt.wantLocation != "" {
				// A live toggle must not leave a cached redirect behind when
				// it is switched back off.
				if got := rec.Header().Get("Cache-Control"); got != "no-store" {
					t.Errorf("Cache-Control = %q, want %q", got, "no-store")
				}
			}
		})
	}
}

// TestHandleV2IndexPage covers the custom head/body injection into the v2 shell:
// same two config values v1 is given, and no widgets.
func TestHandleV2IndexPage(t *testing.T) {
	if err := loadV2IndexTemplateForTest(); err != nil {
		t.Fatalf("parsing v2 index template: %v", err)
	}

	config := &Config{}
	config.Server.CustomHeadHTML = `<meta name="test-head" content="x">`
	config.Server.CustomBodyHTML = `<div id="test-banner">hello</div>`
	config.Server.EnabledWidgets = []string{"11111111-1111-1111-1111-111111111111"}

	for _, path := range []string{"/v2/", "/v2/index.html"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handleV2IndexPage(rec, req, config)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Errorf("%s: Content-Type = %q", path, ct)
		}

		body := rec.Body.String()
		// Injected verbatim: template.HTML, not escaped into &lt;meta&gt;.
		if !strings.Contains(body, config.Server.CustomHeadHTML) {
			t.Errorf("%s: custom head HTML missing or escaped", path)
		}
		if !strings.Contains(body, config.Server.CustomBodyHTML) {
			t.Errorf("%s: custom body HTML missing or escaped", path)
		}
		// Head content belongs in the head, body content after the root div.
		if strings.Index(body, config.Server.CustomHeadHTML) > strings.Index(body, "</head>") {
			t.Errorf("%s: custom head HTML landed outside <head>", path)
		}
		if strings.Index(body, config.Server.CustomBodyHTML) < strings.Index(body, `id="root"`) {
			t.Errorf("%s: custom body HTML landed before the React root", path)
		}
		// Widgets are v1-only.
		if strings.Contains(body, "<!-- widget:") {
			t.Errorf("%s: widgets were injected into the v2 shell", path)
		}
		// No unrendered actions left behind.
		if strings.Contains(body, "{{") {
			t.Errorf("%s: template action left unrendered", path)
		}
	}
}

// TestHandleV2IndexPageEmptyConfig checks the default case renders cleanly.
func TestHandleV2IndexPageEmptyConfig(t *testing.T) {
	if err := loadV2IndexTemplateForTest(); err != nil {
		t.Fatalf("parsing v2 index template: %v", err)
	}

	rec := httptest.NewRecorder()
	handleV2IndexPage(rec, httptest.NewRequest(http.MethodGet, "/v2/", nil), &Config{})

	body := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(body, `<div id="root">`) || !strings.Contains(body, "dist/v2.js") {
		t.Errorf("v2 shell did not render its own content")
	}
	if strings.Contains(body, "{{") {
		t.Errorf("template action left unrendered")
	}
}

// TestHandleAdminPutV2Interface checks that the toggle persists to ui.yaml and
// to the in-memory config without disturbing anything else in the file.
func TestHandleAdminPutV2Interface(t *testing.T) {
	dir := t.TempDir()
	existing := "ui:\n  v2_interface: false\n  palette:\n    default: viridis\n  station_id_color: \"#ff0000\"\n"
	if err := os.WriteFile(filepath.Join(dir, "ui.yaml"), []byte(existing), 0644); err != nil {
		t.Fatalf("seeding ui.yaml: %v", err)
	}

	config := &Config{}
	req := httptest.NewRequest(http.MethodPut, "/admin/ui-config-v2", bytes.NewReader([]byte(`{"enabled":true}`)))
	rec := httptest.NewRecorder()
	handleAdminPutV2Interface(rec, req, dir, config)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var resp struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if !resp.Enabled {
		t.Errorf("response enabled = false, want true")
	}
	if !config.UI.V2Interface {
		t.Errorf("in-memory config not updated — the redirect reads this, so it would need a restart")
	}

	saved := readUIYAML(t, filepath.Join(dir, "ui.yaml"))
	if saved["v2_interface"] != true {
		t.Errorf("ui.yaml v2_interface = %v, want true", saved["v2_interface"])
	}
	if saved["station_id_color"] != "#ff0000" {
		t.Errorf("unrelated key clobbered: station_id_color = %v", saved["station_id_color"])
	}
	if _, ok := saved["palette"]; !ok {
		t.Errorf("unrelated key dropped: palette missing")
	}

	// And back off again.
	req = httptest.NewRequest(http.MethodPut, "/admin/ui-config-v2", bytes.NewReader([]byte(`{"enabled":false}`)))
	rec = httptest.NewRecorder()
	handleAdminPutV2Interface(rec, req, dir, config)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if config.UI.V2Interface {
		t.Errorf("in-memory config still enabled after disabling")
	}
	if saved := readUIYAML(t, filepath.Join(dir, "ui.yaml")); saved["v2_interface"] != false {
		t.Errorf("ui.yaml v2_interface = %v, want false", saved["v2_interface"])
	}
}

// TestHandleAdminPutUIConfigKeepsV2Interface guards the interaction between the
// two save paths: pressing Save UI Defaults must not switch the interface off
// just because the body says nothing about it.
func TestHandleAdminPutUIConfigKeepsV2Interface(t *testing.T) {
	dir := t.TempDir()
	config := &Config{}
	config.UI.V2Interface = true

	body := `{"ui":{"palette":{"default":"jet","available":[{"value":"jet","label":"Jet"}]},"band_color_intensity":0.5}}`
	req := httptest.NewRequest(http.MethodPut, "/admin/ui-config", bytes.NewReader([]byte(body)))
	rec := httptest.NewRecorder()
	handleAdminPutUIConfig(rec, req, dir, config)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if !config.UI.V2Interface {
		t.Errorf("v2_interface was switched off by a save that never mentioned it")
	}
	if saved := readUIYAML(t, filepath.Join(dir, "ui.yaml")); saved["v2_interface"] != true {
		t.Errorf("ui.yaml v2_interface = %v, want true", saved["v2_interface"])
	}

	// An explicit false in the body still turns it off.
	body = `{"ui":{"v2_interface":false,"palette":{"default":"jet","available":[{"value":"jet","label":"Jet"}]},"band_color_intensity":0.5}}`
	req = httptest.NewRequest(http.MethodPut, "/admin/ui-config", bytes.NewReader([]byte(body)))
	rec = httptest.NewRecorder()
	handleAdminPutUIConfig(rec, req, dir, config)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if config.UI.V2Interface {
		t.Errorf("explicit v2_interface:false was ignored")
	}
}

// loadIndexTemplateForTest populates the package-level template that
// handleIndexPage renders on the non-redirect path (normally done at startup).
func loadIndexTemplateForTest() error {
	if indexTemplate != nil {
		return nil
	}
	tmpl, err := template.ParseFiles("static/index.html")
	if err != nil {
		return err
	}
	indexTemplate = tmpl
	return nil
}

// loadV2IndexTemplateForTest is loadIndexTemplateForTest for the v2 shell.
func loadV2IndexTemplateForTest() error {
	if v2IndexTemplate != nil {
		return nil
	}
	tmpl, err := template.ParseFiles("static/v2/index.html")
	if err != nil {
		return err
	}
	v2IndexTemplate = tmpl
	return nil
}

func readUIYAML(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	ui, ok := raw["ui"].(map[string]interface{})
	if !ok {
		t.Fatalf("no ui section in %s: %s", path, data)
	}
	return ui
}
