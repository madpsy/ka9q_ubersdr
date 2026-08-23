package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// A complete panel bundle, of the shape static/v2/CUSTOM_PANELS.md specifies.
func testPanelBundle(manifest string) string {
	return `<template id="ubersdr-panel">
<script type="application/ubersdr-panel+json">
` + manifest + `
</script>
<style>.grid { display: grid; }</style>
<div class="grid" id="clocks"></div>
<script type="module">
const sdr = await ubersdr.ready();
sdr.on('tuning', (t) => render(t));
</script>
</template>`
}

// A v1 widget: a fixed-position overlay reaching for the host page's globals.
const testLegacyWidget = `<style>#w { position: fixed; left: 12px; top: 140px; }</style>
<div id="w"></div>
<script>window.addEventListener('marker_changed', function () {});</script>`

func TestParsePanelBundle(t *testing.T) {
	if _, ok := parsePanelBundle(testLegacyWidget); ok {
		t.Fatal("a v1 widget parsed as a panel — it would vanish from the interface that can run it")
	}
	if _, ok := parsePanelBundle(""); ok {
		t.Fatal("empty content parsed as a panel")
	}

	p, ok := parsePanelBundle(testPanelBundle(`{"ui": 2, "schema": 1, "title": "Clocks", "icon": "Clock"}`))
	if !ok {
		t.Fatal("a valid bundle did not parse")
	}
	if p.UI != 2 || p.Schema != 1 {
		t.Fatalf("parsed ui=%d schema=%d, want 2 and 1", p.UI, p.Schema)
	}

	// The manifest goes to the frontend exactly as authored: fields this build
	// has never heard of are the frontend's business, not the server's.
	var fields map[string]interface{}
	if err := json.Unmarshal(p.Manifest, &fields); err != nil {
		t.Fatalf("manifest did not survive as JSON: %v", err)
	}
	if fields["icon"] != "Clock" || fields["title"] != "Clocks" {
		t.Fatalf("manifest lost fields: %v", fields)
	}

	// The body is what goes into the iframe: the wrapper's contents, without
	// the manifest block, which has done its job by then.
	if strings.Contains(p.Body, "ubersdr-panel+json") {
		t.Fatal("the manifest block is still in the body")
	}
	if !strings.Contains(p.Body, "await ubersdr.ready()") || !strings.Contains(p.Body, "display: grid") {
		t.Fatalf("body lost the panel's own markup or script: %q", p.Body)
	}
	if strings.Contains(p.Body, "<template") {
		t.Fatal("the wrapper is still around the body")
	}
}

func TestParsePanelBundleDefaults(t *testing.T) {
	// v2 is the first interface with panels, so a manifest written before the
	// field existed can only have meant that one.
	p, ok := parsePanelBundle(testPanelBundle(`{"title": "no versions"}`))
	if !ok || p.UI != PanelUIVersion || p.Schema != 1 {
		t.Fatalf("defaults = (ui %d, schema %d, ok %v)", p.UI, p.Schema, ok)
	}

	// Quoted numbers are accepted; hand-written JSON has both.
	p, _ = parsePanelBundle(testPanelBundle(`{"ui": "3"}`))
	if p.UI != 3 {
		t.Fatalf("quoted ui parsed as %d, want 3", p.UI)
	}
}

func TestParsePanelBundleRejectsNearMisses(t *testing.T) {
	for _, tc := range []struct{ name, content string }{
		{"a template that is not ours", `<template id="row"><li></li></template>`},
		{"our template but no manifest", `<template id="ubersdr-panel"><div></div></template>`},
		{"manifest outside the template", `<script type="application/ubersdr-panel+json">{"ui":2}</script>`},
		{"manifest that is not JSON", testPanelBundle(`{ui: 2,}`)},
		{"a widget mentioning panels in a comment", `<!-- not a <template id="ubersdr-panel"> --><div></div>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := parsePanelBundle(tc.content); ok {
				t.Fatal("parsed as a panel")
			}
		})
	}
}

func TestPanelUnsupported(t *testing.T) {
	if why := (ParsedPanel{UI: PanelUIVersion, Schema: 1}).Unsupported(); why != "" {
		t.Fatalf("a panel for this interface was refused: %s", why)
	}
	// A panel for a later interface would parse, mount, and then fail on an API
	// this build does not have. Better absent.
	if why := (ParsedPanel{UI: 3, Schema: 1}).Unsupported(); why == "" {
		t.Fatal("a v3 panel was accepted by a v2 build")
	}
	if why := (ParsedPanel{UI: 1, Schema: 1}).Unsupported(); why == "" {
		t.Fatal("a panel claiming the v1 interface was accepted")
	}
	if why := (ParsedPanel{UI: PanelUIVersion, Schema: PanelSchemaMax + 1}).Unsupported(); why == "" {
		t.Fatal("a newer manifest schema was accepted")
	}
	if why := (ParsedPanel{UI: 0, Schema: 0}).Unsupported(); why == "" {
		t.Fatal("an unreadable manifest was accepted")
	}
}

// A WidgetManager with a cache and no network, which is all the read paths need.
func newPanelTestManager(t *testing.T, records ...struct {
	id, name, content string
}) *WidgetManager {
	t.Helper()
	cfg := &Config{}
	wm := &WidgetManager{config: cfg, entries: map[string]widgetCacheEntry{}}
	for i, r := range records {
		meta := &WidgetMeta{
			WidgetID:    r.id,
			Name:        r.name,
			Callsign:    "M9PSY",
			InstanceID:  "instance-uuid",
			Description: "a description",
			HTMLContent: r.content,
			Version:     i + 1,
		}
		wm.entries[r.id] = newWidgetCacheEntry(meta)
		cfg.Server.EnabledWidgets = append(cfg.Server.EnabledWidgets, r.id)
	}
	return wm
}

type rec = struct{ id, name, content string }

func mixedManager(t *testing.T) *WidgetManager {
	t.Helper()
	return newPanelTestManager(t,
		rec{"legacy-1", "Legacy widget", testLegacyWidget},
		rec{"panel-v2", "World clocks", testPanelBundle(`{"ui": 2, "schema": 1, "title": "World clocks"}`)},
		rec{"panel-v3", "Future panel", testPanelBundle(`{"ui": 3, "schema": 1}`)},
	)
}

func TestEnabledPanelsExcludesWidgetsAndOtherInterfaces(t *testing.T) {
	panels := mixedManager(t).EnabledPanels()
	if len(panels) != 1 {
		t.Fatalf("got %d panels, want only the v2 one: %+v", len(panels), panels)
	}
	p := panels[0]
	if p.ID != "x:panel-v2" {
		t.Fatalf("id = %q, want the namespaced form", p.ID)
	}
	if p.Name != "World clocks" || p.Callsign != "M9PSY" {
		t.Fatalf("provenance missing: %+v", p)
	}
}

func TestPanelListEndpoint(t *testing.T) {
	wm := mixedManager(t)

	rec1 := httptest.NewRecorder()
	wm.HandlePanelList(rec1, httptest.NewRequest(http.MethodGet, "/api/v2/panels", nil))
	if rec1.Code != http.StatusOK {
		t.Fatalf("GET /api/v2/panels = %d", rec1.Code)
	}
	var body struct {
		ETag   string         `json:"etag"`
		Panels []PanelListing `json:"panels"`
	}
	if err := json.Unmarshal(rec1.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec1.Body.String())
	}
	if len(body.Panels) != 1 || body.Panels[0].ID != "x:panel-v2" {
		t.Fatalf("listing = %+v", body.Panels)
	}
	if rec1.Header().Get("ETag") == "" {
		t.Fatal("no ETag, so every poll would carry the whole list")
	}

	// The lifecycle poll is a 304 while nothing has changed.
	req := httptest.NewRequest(http.MethodGet, "/api/v2/panels", nil)
	req.Header.Set("If-None-Match", rec1.Header().Get("ETag"))
	rec2 := httptest.NewRecorder()
	wm.HandlePanelList(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("revalidation = %d, want 304", rec2.Code)
	}
}

// The ETag has to move when the registry would change, or a page never learns
// that a panel was updated or removed.
func TestPanelListETagTracksTheSet(t *testing.T) {
	wm := mixedManager(t)
	before := panelSetETag(wm.EnabledPanels())

	entry := wm.entries["panel-v2"]
	entry.Version++
	wm.entries["panel-v2"] = entry
	if panelSetETag(wm.EnabledPanels()) == before {
		t.Fatal("a new version of a panel did not change the ETag")
	}

	wm.config.Server.EnabledWidgets = []string{"legacy-1"}
	if panelSetETag(wm.EnabledPanels()) == before {
		t.Fatal("removing a panel did not change the ETag")
	}
}

func TestPanelBodyEndpoint(t *testing.T) {
	wm := mixedManager(t)

	for _, path := range []string{"/api/v2/panels/panel-v2", "/api/v2/panels/x:panel-v2"} {
		rec := httptest.NewRecorder()
		wm.HandlePanelBody(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "await ubersdr.ready()") {
			t.Fatalf("GET %s did not return the bundle body", path)
		}
		if strings.Contains(rec.Body.String(), "ubersdr-panel+json") {
			t.Fatalf("GET %s returned the manifest block too", path)
		}
	}

	// Everything this receiver does not serve is the same answer.
	for _, path := range []string{
		"/api/v2/panels/legacy-1", // a v1 widget is not a panel
		"/api/v2/panels/panel-v3", // a panel this build cannot run
		"/api/v2/panels/not-a-real-id",
		"/api/v2/panels/",
	} {
		rec := httptest.NewRecorder()
		wm.HandlePanelBody(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", path, rec.Code)
		}
	}
}

// A panel's body must never be servable as a document.
//
// The isolation this feature rests on is that a third party's script only ever
// runs inside a sandboxed, opaque-origin frame. An endpoint answering text/html
// undoes that on its own: the same URL opened top-level executes that script
// first-party on the receiver's origin, with this origin's storage and the
// operator's credentials. The consumer reads the response with res.text() and
// never inspects the type, so refusing to be a document costs nothing.
func TestPanelBodyIsNotServedAsADocument(t *testing.T) {
	wm := mixedManager(t)
	rec := httptest.NewRecorder()
	wm.HandlePanelBody(rec, httptest.NewRequest(http.MethodGet, "/api/v2/panels/panel-v2", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); strings.Contains(strings.ToLower(ct), "html") {
		t.Fatalf("Content-Type is %q — a link to this URL would run the author's script on this origin", ct)
	}
	for header, want := range map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"Content-Disposition":     "attachment",
		"Content-Security-Policy": "sandbox",
	} {
		got := rec.Header().Get(header)
		if !strings.Contains(got, want) {
			t.Fatalf("%s is %q, want it to contain %q", header, got, want)
		}
	}

	// And the body itself is still intact, because the frame needs it whole.
	if !strings.Contains(rec.Body.String(), "await ubersdr.ready()") {
		t.Fatal("the bundle body was altered")
	}
}

func TestPanelBodyNotServedWhenDisabled(t *testing.T) {
	wm := mixedManager(t)
	wm.config.Server.EnabledWidgets = []string{"legacy-1"}

	rec := httptest.NewRecorder()
	wm.HandlePanelBody(rec, httptest.NewRequest(http.MethodGet, "/api/v2/panels/panel-v2", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("a cached but disabled panel was served: %d", rec.Code)
	}
}

func TestPanelBodyRevalidates(t *testing.T) {
	wm := mixedManager(t)
	first := httptest.NewRecorder()
	wm.HandlePanelBody(first, httptest.NewRequest(http.MethodGet, "/api/v2/panels/panel-v2", nil))

	req := httptest.NewRequest(http.MethodGet, "/api/v2/panels/panel-v2", nil)
	req.Header.Set("If-None-Match", first.Header().Get("ETag"))
	rec := httptest.NewRecorder()
	wm.HandlePanelBody(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("revalidation = %d, want 304", rec.Code)
	}
}

// A panel must never be injected into the v1 page. Its <template> means it would
// render nothing anyway — which is what protects builds older than this one —
// but this build does not put it there at all.
func TestAssembleHTMLSkipsPanels(t *testing.T) {
	wm := mixedManager(t)
	html := string(wm.AssembleHTML([]string{"legacy-1", "panel-v2", "panel-v3"}))

	if !strings.Contains(html, "widget:legacy-1") {
		t.Fatal("the v1 widget was not injected")
	}
	for _, id := range []string{"panel-v2", "panel-v3"} {
		if strings.Contains(html, "widget:"+id) {
			t.Fatalf("panel %s was injected into the v1 page", id)
		}
	}
	if strings.Contains(html, "ubersdr-panel") {
		t.Fatal("panel markup reached the v1 page")
	}
}

func TestPanelRegistryID(t *testing.T) {
	// Namespaced so a panel can never shadow a built-in panel's id.
	if got := panelRegistryID("9f3c"); got != "x:9f3c" {
		t.Fatalf("panelRegistryID = %q", got)
	}
	if got := panelWidgetID("x:9f3c"); got != "9f3c" {
		t.Fatalf("panelWidgetID = %q", got)
	}
	if got := panelWidgetID("9f3c"); got != "9f3c" {
		t.Fatalf("panelWidgetID on a bare id = %q", got)
	}
	for _, builtin := range []string{"receiver", "layout", "spots"} {
		if panelRegistryID(builtin) == builtin {
			t.Fatalf("a panel could claim the built-in id %q", builtin)
		}
	}
}

func TestPanelListRejectsNonGET(t *testing.T) {
	wm := mixedManager(t)
	for _, h := range []http.HandlerFunc{wm.HandlePanelList, wm.HandlePanelBody} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/api/v2/panels/panel-v2", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST = %d, want 405", rec.Code)
		}
	}
}

// The worked example, through the real parser.
//
// static/v2/example-panel.html is what an author is pointed at, so it has to be
// a panel this build would actually serve — not merely plausible prose in a
// document. A change to the bundle format that this file does not follow fails
// here rather than in somebody's receiver.
func TestExamplePanelIsServable(t *testing.T) {
	content, err := os.ReadFile("static/v2/example-panel.html")
	if err != nil {
		t.Fatalf("read the example panel: %v", err)
	}

	panel, ok := parsePanelBundle(string(content))
	if !ok {
		t.Fatal("the example panel does not parse as a panel bundle")
	}
	if why := panel.Unsupported(); why != "" {
		t.Fatalf("the example panel is not one this build can run: %s", why)
	}
	if panel.UI != PanelUIVersion {
		t.Fatalf("the example targets interface v%d, not v%d", panel.UI, PanelUIVersion)
	}

	// The fields the frontend needs to register it, present and sane.
	var manifest struct {
		Title string `json:"title"`
		Icon  string `json:"icon"`
		Group string `json:"group"`
	}
	if err := json.Unmarshal(panel.Manifest, &manifest); err != nil {
		t.Fatalf("the example's manifest is not an object: %v", err)
	}
	if manifest.Title == "" || manifest.Icon == "" || manifest.Group == "" {
		t.Fatalf("the example is missing a required manifest field: %+v", manifest)
	}

	// The body is what goes into the frame: the wrapper and the manifest have
	// both done their job by then.
	if strings.Contains(panel.Body, "<template") || strings.Contains(panel.Body, "ubersdr-panel+json") {
		t.Fatal("the example's body still carries the wrapper or the manifest")
	}
	// And its code must be a module, or `await ubersdr.ready()` is a syntax
	// error in every browser. The collector refuses a panel without this; the
	// example must not be the thing that teaches the wrong lesson.
	if !strings.Contains(panel.Body, `<script type="module">`) {
		t.Fatal(`the example's code is not <script type="module">`)
	}
}

// The skeleton the admin editor prefills, through the real server parser.
//
// It is the first thing most authors will publish, so it has to be a panel this
// build would actually serve — not merely something the editor is happy with.
// Extracted from admin.html rather than duplicated here, so the two cannot
// drift.
func TestNewPanelSkeletonIsServable(t *testing.T) {
	admin, err := os.ReadFile("static/admin.html")
	if err != nil {
		t.Fatalf("read admin.html: %v", err)
	}
	src := string(admin)

	start := strings.Index(src, "const NEW_PANEL_SKELETON")
	if start < 0 {
		t.Fatal("the admin editor no longer prefills a panel skeleton")
	}
	end := strings.Index(src[start:], "function openNewWidgetEditor")
	if end < 0 {
		t.Fatal("could not find the end of the skeleton")
	}

	// The skeleton is a JS array of single-quoted lines joined by newlines.
	// Rebuilding it exactly is not the point — what matters is that the wrapper,
	// the manifest and a module script all survive into something the parser
	// accepts, so the quoted lines are unescaped and joined the same way.
	region := src[start : start+end]
	var lines []string
	for _, raw := range regexp.MustCompile(`'((?:[^'\\]|\\.)*)'`).FindAllStringSubmatch(region, -1) {
		lit := raw[1]
		lit = strings.ReplaceAll(lit, `\'`, `'`)
		lit = strings.ReplaceAll(lit, `\\`, `\`)
		lit = strings.ReplaceAll(lit, `<\/script>`, `</script>`)
		lines = append(lines, lit)
	}
	skeleton := strings.Join(lines, "\n")

	panel, ok := parsePanelBundle(skeleton)
	if !ok {
		t.Fatalf("the prefilled skeleton does not parse as a panel:\n%s", skeleton)
	}
	if why := panel.Unsupported(); why != "" {
		t.Fatalf("the prefilled skeleton is not one this build can run: %s", why)
	}
	if !strings.Contains(panel.Body, `<script type="module">`) {
		t.Fatal(`the prefilled skeleton's code is not <script type="module">`)
	}
}
