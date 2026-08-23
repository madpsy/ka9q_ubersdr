package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Custom panels — the v2 side of the widget store
//
// See static/v2/CUSTOM_PANELS.md for the whole design. In short: a custom panel
// is a record in the same collector store a v1 widget comes from, distinguished
// by its content rather than by any field. A panel is wrapped in
//
//	<template id="ubersdr-panel">
//	  <script type="application/ubersdr-panel+json">{ "ui": 2, ... }</script>
//	  ...
//	</template>
//
// The <template> is what keeps the two interfaces from rendering each other's
// records: its contents are parsed into an inert DocumentFragment, so a panel
// injected into a v1 page — by this build until v1 goes, or by an older one that
// cannot be patched — draws nothing at all rather than leaking its CSS into the
// host page.
//
// Parsing happens once, when an entry is cached, and never per request: the
// refresh loop already fetches only when the collector's version has changed, so
// that is the natural place for it.
//
// The manifest is carried through verbatim. Beyond the two version fields below,
// what a manifest means is the frontend's business — panels/registry.jsx decides
// defaults, and every unknown value there degrades rather than throwing. A
// server that also had opinions about `icon` or `group` would be a second place
// to change every time the manifest grows.
// ---------------------------------------------------------------------------

// PanelUIVersion is the interface this build serves. A panel written for
// another one is not offered: it would parse, mount, and then fail at runtime on
// an API this interface does not have.
const PanelUIVersion = 2

// PanelSchemaMax is the newest manifest format this build understands. Manifest
// changes are meant to be additive — an older instance ignores fields it does
// not recognise — so this rises only for a change that is not.
const PanelSchemaMax = 1

// Mirrors the collector's parser (collector/panel_manifest.go). The two must
// agree; if they ever drift, the collector's answer only decides how a record is
// listed, while this one decides what is actually served, so the failure is a
// mislabelled browse row rather than a broken panel.
var (
	panelTemplateRe = regexp.MustCompile(`(?is)<template[^>]*\bid\s*=\s*["']ubersdr-panel["'][^>]*>(.*?)</template>`)
	panelManifestRe = regexp.MustCompile(`(?is)<script[^>]*\btype\s*=\s*["']application/ubersdr-panel\+json["'][^>]*>(.*?)</script>`)
)

// ParsedPanel is a panel bundle, taken apart once at cache time.
type ParsedPanel struct {
	// UI is the interface the manifest declares, defaulting to 2 — the first
	// interface to have panels, and so the only thing a manifest written before
	// the field existed can have meant.
	UI int
	// Schema is the manifest format version, defaulting to 1.
	Schema int
	// Manifest is the manifest object exactly as authored, passed to the
	// frontend untouched.
	Manifest json.RawMessage
	// Body is the wrapper's contents with the manifest block removed: what the
	// page assembles into an iframe's srcdoc.
	Body string
}

// parsePanelBundle takes a stored record apart.
//
// ok is false for anything that is not a panel, which is every v1 widget. The
// bar is all three of the wrapper, the manifest block inside it, and a JSON
// object that parses — deliberately strict, because a v1 widget mistaken for a
// panel would vanish from the interface that can actually run it.
func parsePanelBundle(htmlContent string) (p ParsedPanel, ok bool) {
	tpl := panelTemplateRe.FindStringSubmatch(htmlContent)
	if tpl == nil {
		return ParsedPanel{}, false
	}
	block := panelManifestRe.FindStringSubmatch(tpl[1])
	if block == nil {
		return ParsedPanel{}, false
	}

	var fields map[string]json.RawMessage
	raw := strings.TrimSpace(block[1])
	if err := json.Unmarshal([]byte(raw), &fields); err != nil {
		return ParsedPanel{}, false
	}

	p = ParsedPanel{
		UI:       manifestInt(fields, "ui", PanelUIVersion),
		Schema:   manifestInt(fields, "schema", 1),
		Manifest: json.RawMessage(raw),
		Body:     strings.TrimSpace(panelManifestRe.ReplaceAllString(tpl[1], "")),
	}
	return p, true
}

// manifestInt reads a whole-number manifest field, accepting both a JSON number
// and a quoted one — hand-written JSON has both and the difference is not worth
// failing a panel over. A value that cannot be read at all becomes 0, which
// matches no interface and no schema, so such a panel is never served.
func manifestInt(fields map[string]json.RawMessage, name string, fallback int) int {
	raw, present := fields[name]
	if !present {
		return fallback
	}
	var num json.Number
	if err := json.Unmarshal(raw, &num); err != nil {
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return 0
		}
		num = json.Number(strings.TrimSpace(str))
	}
	n, err := strconv.Atoi(strings.TrimSpace(num.String()))
	if err != nil {
		return 0
	}
	return n
}

// Unsupported explains why this build cannot run the panel, or returns "" when
// it can.
//
// The message is written to be shown to an operator deciding whether to enable
// something, so it says what would have to change rather than what is wrong.
func (p ParsedPanel) Unsupported() string {
	if p.UI != PanelUIVersion {
		if p.UI < 1 {
			return "its manifest does not say which interface it is written for"
		}
		return fmt.Sprintf("it is written for the v%d interface and this receiver runs v%d", p.UI, PanelUIVersion)
	}
	if p.Schema < 1 {
		return "its manifest does not declare a valid schema version"
	}
	if p.Schema > PanelSchemaMax {
		return fmt.Sprintf("it uses manifest schema %d and this receiver understands up to %d — the receiver needs updating", p.Schema, PanelSchemaMax)
	}
	return ""
}

// panelRegistryID is the id the frontend registers the panel under.
//
// Namespaced so a panel can never collide with a built-in — `receiver`,
// `layout` — and derived from the collector's immutable record id rather than
// from anything the author chose, so that renaming a panel or editing its
// manifest cannot orphan the layouts that refer to it.
func panelRegistryID(widgetID string) string { return "x:" + widgetID }

// panelWidgetID is the reverse, tolerating either form in a URL.
func panelWidgetID(id string) string { return strings.TrimPrefix(id, "x:") }

// ---------------------------------------------------------------------------
// Endpoints
//
// Two, because bodies are the big part: ten of them is on the order of a
// megabyte, the frontend does not mount a collapsed panel's body at all, and a
// body can be cached hard against its version while the list stays fresh.
// ---------------------------------------------------------------------------

// PanelListing is one entry of GET /api/v2/panels.
type PanelListing struct {
	ID       string          `json:"id"`
	Version  int             `json:"version"`
	Manifest json.RawMessage `json:"manifest"`

	// Provenance. Shown in the layout manager beside the switch that turns the
	// panel off, because "who wrote this and what is it" is a fair question to
	// ask of code that came off a shared collector.
	Name        string `json:"name"`
	Callsign    string `json:"callsign,omitempty"`
	InstanceID  string `json:"instanceId,omitempty"`
	Description string `json:"description,omitempty"`
}

// EnabledPanels returns the panels this receiver serves, in the operator's
// order.
//
// Only the ones this build can actually run: a panel for another interface is
// left out rather than offered and then failing to work. Legacy widgets are
// absent by construction — they parse as nothing.
func (wm *WidgetManager) EnabledPanels() []PanelListing {
	wm.mu.RLock()
	defer wm.mu.RUnlock()

	out := make([]PanelListing, 0, len(wm.config.Server.EnabledWidgets))
	for _, id := range wm.config.Server.EnabledWidgets {
		entry, ok := wm.entries[id]
		if !ok || entry.Panel == nil || entry.Panel.Unsupported() != "" {
			continue
		}
		out = append(out, PanelListing{
			ID:          panelRegistryID(id),
			Version:     entry.Version,
			Manifest:    entry.Panel.Manifest,
			Name:        entry.Name,
			Callsign:    entry.Callsign,
			InstanceID:  entry.InstanceID,
			Description: entry.Description,
		})
	}
	return out
}

// panelSetETag identifies the enabled set by what would change the frontend's
// registry: which panels there are, and at which version. A poll for updates is
// then a 304 in the ordinary case.
func panelSetETag(panels []PanelListing) string {
	h := fnv.New64a()
	for _, p := range panels {
		fmt.Fprintf(h, "%s@%d;", p.ID, p.Version)
	}
	return fmt.Sprintf(`"%x"`, h.Sum64())
}

// HandlePanelList serves GET /api/v2/panels.
func (wm *WidgetManager) HandlePanelList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	panels := wm.EnabledPanels()
	etag := panelSetETag(panels)

	w.Header().Set("ETag", etag)
	// Always revalidate: the set changes when an operator enables something or a
	// panel's author publishes a new version, neither of which is on a clock the
	// page can predict. The ETag is what makes that cheap.
	w.Header().Set("Cache-Control", "no-cache")
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"etag":   etag,
		"panels": panels,
	})
}

// HandlePanelBody serves GET /api/v2/panels/{id}.
//
// The id may carry the `x:` prefix the frontend registers it under or not; both
// name the same record and refusing one of them would only be a trap.
func (wm *WidgetManager) HandlePanelBody(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id := panelWidgetID(strings.TrimPrefix(r.URL.Path, "/api/v2/panels/"))
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	wm.mu.RLock()
	entry, cached := wm.entries[id]
	enabled := false
	for _, e := range wm.config.Server.EnabledWidgets {
		if e == id {
			enabled = true
			break
		}
	}
	wm.mu.RUnlock()

	// Not enabled here, not cached, not a panel, or not one this build runs —
	// all the same answer. A panel the operator has not enabled is not a thing
	// this receiver has, and saying which of the four it is would only describe
	// other people's widgets to anyone who asked.
	if !enabled || !cached || entry.Panel == nil || entry.Panel.Unsupported() != "" {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	etag := fmt.Sprintf(`"%d"`, entry.Version)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Served as inert text, never as HTML, and this is load-bearing rather than
	// fastidious.
	//
	// The body is a third party's markup and script. The whole isolation
	// argument — CUSTOM_PANELS.md §6 — is that it only ever executes inside
	// `<iframe sandbox="allow-scripts">`, on an opaque origin, reaching the
	// receiver through one port. But a URL that answers `text/html` can be
	// opened as a *top-level document*, and there the sandbox does not exist: a
	// link to this endpoint would run the author's script first-party on the
	// receiver's origin, with this origin's storage and its credentials, which
	// is precisely what the frame is there to prevent.
	//
	// The only consumer reads it with `res.text()` and never looks at the type
	// (CustomPanel.jsx), so nothing is lost by refusing to be a document. Four
	// headers rather than one because they fail independently: the type is the
	// rule, `nosniff` stops a browser second-guessing it, `sandbox` denies the
	// response an origin at all if it is rendered anyway, and the disposition
	// makes a direct navigation a download rather than a page.
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Content-Disposition", "attachment")
	w.Write([]byte(entry.Panel.Body))
}
