package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	// MaxEnabledWidgets is the maximum number of widgets that can be enabled at once
	MaxEnabledWidgets = 10
	// widgetCacheTTL is how long a cached widget entry is considered fresh
	widgetCacheTTL = 15 * time.Minute
	// widgetFetchTimeout is the HTTP timeout for collector requests
	widgetFetchTimeout = 10 * time.Second
)

// WidgetMeta is the metadata shape returned by the collector list endpoints.
// html_content is absent in list responses; present in single-widget responses.
type WidgetMeta struct {
	WidgetID    string `json:"widget_id"`
	InstanceID  string `json:"instance_id"`
	Callsign    string `json:"callsign"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	HTMLContent string `json:"html_content,omitempty"`
	IsPublic    bool   `json:"is_public"`
	Version     int    `json:"version"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// widgetCacheEntry holds a fetched widget's HTML and metadata.
type widgetCacheEntry struct {
	HTML        string
	Name        string
	Callsign    string
	InstanceID  string
	Description string
	Version     int
	FetchedAt   time.Time
}

// errWidgetGone is returned by fetchWidgetVersion when the collector responds
// with 404 (widget deleted or made private by its owner).
var errWidgetGone = fmt.Errorf("widget no longer available")

// WidgetManager manages the in-memory widget cache and proxies requests to the
// collector widget API on behalf of the authenticated admin.
type WidgetManager struct {
	config     *Config
	configFile string // path to the main config YAML for persistence
	httpClient *http.Client

	mu      sync.RWMutex
	entries map[string]widgetCacheEntry // keyed by widget_id UUID

	stopChan chan struct{}
}

// NewWidgetManager creates a WidgetManager and starts the background refresh ticker.
// configFile is the path to the main config YAML (same value as AdminHandler.configFile).
func NewWidgetManager(config *Config, configFile string) *WidgetManager {
	wm := &WidgetManager{
		config:     config,
		configFile: configFile,
		entries:    make(map[string]widgetCacheEntry),
		stopChan:   make(chan struct{}),
		httpClient: &http.Client{
			Timeout: widgetFetchTimeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
			},
		},
	}
	// Pre-populate cache for any already-configured widgets.
	wm.refreshAll()
	// Start background refresh ticker.
	go wm.backgroundRefresh()
	return wm
}

// Stop halts the background refresh goroutine.
func (wm *WidgetManager) Stop() {
	close(wm.stopChan)
}

// collectorBaseURL returns the base URL for the collector API.
func (wm *WidgetManager) collectorBaseURL() string {
	scheme := "https"
	if !wm.config.InstanceReporting.UseHTTPS {
		scheme = "http"
	}
	host := wm.config.InstanceReporting.Hostname
	if host == "" {
		host = "instances.ubersdr.org"
	}
	port := wm.config.InstanceReporting.Port
	if port == 0 || port == 443 {
		return fmt.Sprintf("%s://%s", scheme, host)
	}
	return fmt.Sprintf("%s://%s:%d", scheme, host, port)
}

// instanceSecret returns the X-Instance-Secret value.
func (wm *WidgetManager) instanceSecret() string {
	return wm.config.InstanceReporting.InstanceUUID
}

// fetchWidgetVersion fetches the latest version number for a widget from the
// collector's versions endpoint (no HTML content — lightweight check).
// Returns errWidgetGone if the collector responds with 404 (deleted or private).
// Returns a regular error for transient failures (network, 5xx) — caller should
// keep the stale cache in that case.
func (wm *WidgetManager) fetchWidgetVersion(widgetID string) (int, error) {
	url := fmt.Sprintf("%s/api/widgets/%s/versions", wm.collectorBaseURL(), widgetID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	if secret := wm.instanceSecret(); secret != "" {
		req.Header.Set("X-Instance-Secret", secret)
	}
	resp, err := wm.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return 0, errWidgetGone
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("collector returned %d for widget %s versions", resp.StatusCode, widgetID)
	}
	// Collector returns a JSON array of WidgetVersionMeta ordered by version DESC.
	// The first entry is the latest version.
	var versions []struct {
		Version int `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&versions); err != nil {
		return 0, fmt.Errorf("failed to decode versions for widget %s: %w", widgetID, err)
	}
	if len(versions) == 0 {
		return 0, errWidgetGone
	}
	return versions[0].Version, nil
}

// fetchWidgetHTML fetches a single widget's full HTML content from the collector.
// Always sends the secret so private (own) widgets are accessible.
func (wm *WidgetManager) fetchWidgetHTML(widgetID string) (*WidgetMeta, error) {
	url := fmt.Sprintf("%s/api/widgets/%s", wm.collectorBaseURL(), widgetID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if secret := wm.instanceSecret(); secret != "" {
		req.Header.Set("X-Instance-Secret", secret)
	}
	resp, err := wm.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("collector returned %d for widget %s", resp.StatusCode, widgetID)
	}
	var meta WidgetMeta
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

// refreshAll performs a two-phase refresh of all currently enabled widgets:
//  1. Cheap version check via /api/widgets/:id/versions (no HTML download).
//     - 404 → widget gone (deleted or made private): auto-evict from enabled list + cache.
//     - Network/5xx error → transient failure: keep stale cache, do not evict.
//     - Version unchanged → skip HTML re-fetch.
//  2. Full HTML fetch only when the version has changed.
func (wm *WidgetManager) refreshAll() {
	// Snapshot the enabled list under read lock to avoid holding the lock
	// during slow network calls.
	wm.mu.RLock()
	ids := make([]string, len(wm.config.Server.EnabledWidgets))
	copy(ids, wm.config.Server.EnabledWidgets)
	wm.mu.RUnlock()

	if len(ids) == 0 {
		return
	}

	var toEvict []string

	for _, id := range ids {
		latestVersion, err := wm.fetchWidgetVersion(id)
		if err == errWidgetGone {
			log.Printf("[WidgetManager] Widget %s is no longer available — removing from enabled list", id)
			toEvict = append(toEvict, id)
			continue
		}
		if err != nil {
			// Transient error (network, 5xx) — keep stale cache.
			log.Printf("[WidgetManager] Transient error checking widget %s version: %v (keeping stale cache)", id, err)
			continue
		}

		// Check cached version.
		wm.mu.RLock()
		cached, hasCached := wm.entries[id]
		wm.mu.RUnlock()

		if hasCached && cached.Version == latestVersion {
			// No change — skip HTML fetch.
			continue
		}

		// Version changed (or not yet cached) — fetch full HTML.
		meta, err := wm.fetchWidgetHTML(id)
		if err != nil {
			log.Printf("[WidgetManager] Failed to fetch HTML for widget %s (v%d): %v", id, latestVersion, err)
			continue
		}
		wm.mu.Lock()
		wm.entries[id] = widgetCacheEntry{
			HTML:        meta.HTMLContent,
			Name:        meta.Name,
			Callsign:    meta.Callsign,
			InstanceID:  meta.InstanceID,
			Description: meta.Description,
			Version:     meta.Version,
			FetchedAt:   time.Now(),
		}
		wm.mu.Unlock()
		if hasCached {
			log.Printf("[WidgetManager] Widget %s (%q) updated v%d → v%d", id, meta.Name, cached.Version, meta.Version)
		} else {
			log.Printf("[WidgetManager] Widget %s (%q) cached at v%d", id, meta.Name, meta.Version)
		}
	}

	// Evict widgets that are no longer available.
	if len(toEvict) > 0 {
		evictSet := make(map[string]bool, len(toEvict))
		for _, id := range toEvict {
			evictSet[id] = true
			wm.RemoveFromCache(id)
		}
		wm.mu.Lock()
		newEnabled := make([]string, 0, len(wm.config.Server.EnabledWidgets))
		for _, id := range wm.config.Server.EnabledWidgets {
			if !evictSet[id] {
				newEnabled = append(newEnabled, id)
			}
		}
		wm.config.Server.EnabledWidgets = newEnabled
		wm.mu.Unlock()
		if err := wm.saveEnabledWidgets(wm.config.Server.EnabledWidgets); err != nil {
			log.Printf("[WidgetManager] Failed to save enabled_widgets after eviction: %v", err)
		}
	}
}

// backgroundRefresh runs a ticker that refreshes all enabled widgets every widgetCacheTTL.
func (wm *WidgetManager) backgroundRefresh() {
	ticker := time.NewTicker(widgetCacheTTL)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			log.Printf("[WidgetManager] Background refresh of %d widget(s)", len(wm.config.Server.EnabledWidgets))
			wm.refreshAll()
		case <-wm.stopChan:
			return
		}
	}
}

// AddToCache immediately fetches and caches a single widget.
// Called when the admin enables a new widget.
func (wm *WidgetManager) AddToCache(widgetID string) error {
	meta, err := wm.fetchWidgetHTML(widgetID)
	if err != nil {
		return err
	}
	wm.mu.Lock()
	wm.entries[widgetID] = widgetCacheEntry{
		HTML:        meta.HTMLContent,
		Name:        meta.Name,
		Callsign:    meta.Callsign,
		InstanceID:  meta.InstanceID,
		Description: meta.Description,
		Version:     meta.Version,
		FetchedAt:   time.Now(),
	}
	wm.mu.Unlock()
	log.Printf("[WidgetManager] Added widget %s (%q) v%d to cache", widgetID, meta.Name, meta.Version)
	return nil
}

// RemoveFromCache evicts a widget from the cache.
// Called when the admin disables a widget.
func (wm *WidgetManager) RemoveFromCache(widgetID string) {
	wm.mu.Lock()
	delete(wm.entries, widgetID)
	wm.mu.Unlock()
}

// AssembleHTML builds the WidgetsHTML template.HTML value for index.html rendering.
// It iterates EnabledWidgets in order and injects each widget's HTML directly into
// the page (wrapped in a comment marker for identification).
// Missing cache entries (fetch failed at startup) are silently skipped.
func (wm *WidgetManager) AssembleHTML(enabledIDs []string) template.HTML {
	if len(enabledIDs) == 0 {
		return ""
	}
	wm.mu.RLock()
	defer wm.mu.RUnlock()

	var sb strings.Builder
	for _, id := range enabledIDs {
		entry, ok := wm.entries[id]
		if !ok || entry.HTML == "" {
			continue
		}
		fmt.Fprintf(&sb, "\n<!-- widget:%s -->\n%s\n<!-- /widget:%s -->\n", id, entry.HTML, id)
	}
	return template.HTML(sb.String())
}

// ---------------------------------------------------------------------------
// Admin HTTP handlers
// ---------------------------------------------------------------------------

// HandleEnabled handles GET and POST /admin/widgets/enabled.
//
//	GET  → returns the current EnabledWidgets list and cache status.
//	POST → replaces the EnabledWidgets list (max 10), fetches new entries,
//	       evicts removed entries, and saves the config to disk.
func (wm *WidgetManager) HandleEnabled(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		wm.handleGetEnabled(w, r)
	case http.MethodPost:
		wm.handlePostEnabled(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (wm *WidgetManager) handleGetEnabled(w http.ResponseWriter, _ *http.Request) {
	wm.mu.RLock()
	defer wm.mu.RUnlock()

	type enabledEntry struct {
		WidgetID    string `json:"widget_id"`
		Name        string `json:"name"`
		Callsign    string `json:"callsign,omitempty"`
		InstanceID  string `json:"instance_id,omitempty"`
		Description string `json:"description,omitempty"`
		Cached      bool   `json:"cached"`
		FetchedAt   string `json:"fetched_at,omitempty"`
	}

	result := make([]enabledEntry, 0, len(wm.config.Server.EnabledWidgets))
	for _, id := range wm.config.Server.EnabledWidgets {
		entry, ok := wm.entries[id]
		e := enabledEntry{WidgetID: id, Cached: ok}
		if ok {
			e.Name = entry.Name
			e.Callsign = entry.Callsign
			e.InstanceID = entry.InstanceID
			e.Description = entry.Description
			e.FetchedAt = entry.FetchedAt.UTC().Format(time.RFC3339)
		}
		result = append(result, e)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":     result,
		"count":       len(result),
		"max_allowed": MaxEnabledWidgets,
	})
}

func (wm *WidgetManager) handlePostEnabled(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WidgetIDs []string `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Deduplicate while preserving order.
	seen := make(map[string]bool)
	deduped := make([]string, 0, len(body.WidgetIDs))
	for _, id := range body.WidgetIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		deduped = append(deduped, id)
	}

	if len(deduped) > MaxEnabledWidgets {
		http.Error(w, fmt.Sprintf("Too many widgets: maximum %d enabled at once", MaxEnabledWidgets), http.StatusBadRequest)
		return
	}

	// Determine which IDs are newly added vs removed.
	oldSet := make(map[string]bool)
	for _, id := range wm.config.Server.EnabledWidgets {
		oldSet[id] = true
	}
	newSet := make(map[string]bool)
	for _, id := range deduped {
		newSet[id] = true
	}

	// Fetch newly added widgets; abort if any fetch fails.
	var fetchErrors []string
	for _, id := range deduped {
		if !oldSet[id] {
			if err := wm.AddToCache(id); err != nil {
				fetchErrors = append(fetchErrors, fmt.Sprintf("%s: %v", id, err))
			}
		}
	}
	if len(fetchErrors) > 0 {
		http.Error(w, fmt.Sprintf("Failed to fetch widget(s): %s", strings.Join(fetchErrors, "; ")), http.StatusBadGateway)
		return
	}

	// Evict removed widgets from cache.
	for id := range oldSet {
		if !newSet[id] {
			wm.RemoveFromCache(id)
		}
	}

	// Update live config.
	wm.config.Server.EnabledWidgets = deduped

	// Persist to disk.
	if err := wm.saveEnabledWidgets(deduped); err != nil {
		log.Printf("[WidgetManager] Failed to save enabled_widgets to config: %v", err)
		// Non-fatal: live config is already updated; log and continue.
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"count":   len(deduped),
		"widgets": deduped,
	})
}

// saveEnabledWidgets persists the enabled_widgets list to the main config YAML file.
// It reads the current YAML, updates only the server.enabled_widgets key, and writes back.
func (wm *WidgetManager) saveEnabledWidgets(ids []string) error {
	if wm.configFile == "" {
		return fmt.Errorf("config file path not set")
	}

	data, err := os.ReadFile(wm.configFile)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	if configMap == nil {
		configMap = make(map[string]interface{})
	}

	server, ok := configMap["server"].(map[string]interface{})
	if !ok {
		server = make(map[string]interface{})
		configMap["server"] = server
	}

	// Store as []interface{} so yaml.Marshal produces a proper YAML list.
	if len(ids) == 0 {
		server["enabled_widgets"] = []interface{}{}
	} else {
		list := make([]interface{}, len(ids))
		for i, id := range ids {
			list[i] = id
		}
		server["enabled_widgets"] = list
	}

	yamlData, err := yaml.Marshal(configMap)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	if err := os.WriteFile(wm.configFile, yamlData, 0644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Collector proxy handlers — all require admin auth (enforced by AuthMiddleware)
// ---------------------------------------------------------------------------

// HandleMine proxies GET /admin/widgets/mine → collector GET /api/widgets/mine
// The collector may return either a JSON array or an object keyed by string
// integers; this handler normalises both into {"widgets": [...]}.
// If no instance UUID is configured, returns an empty list immediately rather
// than forwarding a request that will 401 (which would trigger a false logout
// in the admin UI).
func (wm *WidgetManager) HandleMine(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if wm.instanceSecret() == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"widgets":[]}`))
		return
	}
	wm.proxyWidgetList(w, "/api/widgets/mine", true)
}

// HandlePublic proxies GET /admin/widgets/public → collector GET /api/widgets
// Supports ?instance_id= and ?callsign= query params forwarded as-is.
// Normalises the response into {"widgets": [...]}.
func (wm *WidgetManager) HandlePublic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := "/api/widgets"
	if q := r.URL.RawQuery; q != "" {
		path += "?" + q
	}
	wm.proxyWidgetList(w, path, false)
}

// proxyWidgetList fetches a widget list from the collector, normalises the
// response (array OR string-keyed object) into {"widgets": [...]}, and writes
// it to w.  This handles collector implementations that return objects like
// {"0":{...},"1":{...}} instead of a proper JSON array.
// Auth errors (401/403) from the collector are translated to an empty list
// with 200 OK so they never trigger a false session-expiry logout in the
// admin UI.
func (wm *WidgetManager) proxyWidgetList(w http.ResponseWriter, path string, withSecret bool) {
	body, statusCode := wm.proxyToCollectorRaw(http.MethodGet, path, withSecret, nil)
	w.Header().Set("Content-Type", "application/json")
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		// Collector auth failure — return empty list rather than forwarding
		// the 401/403 which would cause the admin UI to log the user out.
		log.Printf("[WidgetManager] Collector returned %d for %s — returning empty widget list", statusCode, path)
		w.Write([]byte(`{"widgets":[]}`))
		return
	}
	if statusCode != http.StatusOK {
		w.WriteHeader(statusCode)
		w.Write(body)
		return
	}

	// Try to decode as array first.
	var asArray []json.RawMessage
	if err := json.Unmarshal(body, &asArray); err == nil {
		// Already an array — wrap it.
		out, _ := json.Marshal(map[string]interface{}{"widgets": asArray})
		w.Write(out)
		return
	}

	// Try to decode as object (string-keyed map).
	var asMap map[string]json.RawMessage
	if err := json.Unmarshal(body, &asMap); err == nil {
		// Collect values in key order (0, 1, 2, …).
		widgets := make([]json.RawMessage, 0, len(asMap))
		for i := 0; i < len(asMap); i++ {
			key := fmt.Sprintf("%d", i)
			if v, ok := asMap[key]; ok {
				widgets = append(widgets, v)
			}
		}
		// Fall back to unordered if key sequence is broken.
		if len(widgets) != len(asMap) {
			widgets = widgets[:0]
			for _, v := range asMap {
				widgets = append(widgets, v)
			}
		}
		out, _ := json.Marshal(map[string]interface{}{"widgets": widgets})
		w.Write(out)
		return
	}

	// Unknown shape — pass through as-is wrapped in an error envelope.
	w.WriteHeader(http.StatusBadGateway)
	w.Write([]byte(`{"error":"unexpected response shape from collector"}`))
}

// collectorAuthError returns true if the status code indicates a collector
// authentication/authorisation failure (401 or 403).  In that case it writes
// a 400 Bad Request with a descriptive JSON error to w so the admin UI never
// sees a 401 and never triggers a false session-expiry logout.
func collectorAuthError(w http.ResponseWriter, statusCode int) bool {
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"Widget features require instance reporting to be enabled and registered with the collector"}`))
		return true
	}
	return false
}

// HandleCreate proxies POST /admin/widgets/create → collector POST /api/widgets
func (wm *WidgetManager) HandleCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if wm.instanceSecret() == "" {
		collectorAuthError(w, http.StatusUnauthorized)
		return
	}
	respBody, statusCode := wm.proxyToCollectorRaw(http.MethodPost, "/api/widgets", true, r.Body)
	w.Header().Set("Content-Type", "application/json")
	if collectorAuthError(w, statusCode) {
		return
	}
	w.WriteHeader(statusCode)
	w.Write(respBody)
}

// HandleUpdate proxies POST /admin/widgets/update → collector PUT /api/widgets/:id
// Accepts a JSON body with widget_id plus the update fields.
// Also refreshes the cache entry if the widget is currently enabled.
func (wm *WidgetManager) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Buffer the body so we can extract widget_id and forward the rest.
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	// Extract widget_id from the JSON body (it's included by the JS but the
	// collector doesn't need it in the body — it goes in the URL path).
	var peek struct {
		WidgetID string `json:"widget_id"`
	}
	if err := json.Unmarshal(bodyBytes, &peek); err != nil || peek.WidgetID == "" {
		// Fall back to query param for backward compat.
		peek.WidgetID = r.URL.Query().Get("widget_id")
	}
	if peek.WidgetID == "" {
		http.Error(w, "Missing widget_id", http.StatusBadRequest)
		return
	}
	widgetID := peek.WidgetID

	respBody, statusCode := wm.proxyToCollectorRaw(http.MethodPut, fmt.Sprintf("/api/widgets/%s", widgetID), true, bytes.NewReader(bodyBytes))
	w.Header().Set("Content-Type", "application/json")
	if collectorAuthError(w, statusCode) {
		return
	}
	w.WriteHeader(statusCode)
	w.Write(respBody)

	// If update succeeded and widget is enabled, refresh its cache entry.
	if statusCode == http.StatusOK {
		wm.mu.RLock()
		_, isEnabled := wm.entries[widgetID]
		wm.mu.RUnlock()
		if isEnabled {
			if err := wm.AddToCache(widgetID); err != nil {
				log.Printf("[WidgetManager] Failed to refresh cache for updated widget %s: %v", widgetID, err)
			}
		}
	}
}

// HandleDelete proxies DELETE /admin/widgets/delete?widget_id=<id> → collector DELETE /api/widgets/:id
// Also removes the widget from EnabledWidgets and cache if present.
func (wm *WidgetManager) HandleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Accept widget_id from JSON body (POST) or query param (DELETE).
	var widgetID string
	if r.Method == http.MethodPost {
		var body struct {
			WidgetID string `json:"widget_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		widgetID = body.WidgetID
	} else {
		widgetID = r.URL.Query().Get("widget_id")
	}
	if widgetID == "" {
		http.Error(w, "Missing widget_id", http.StatusBadRequest)
		return
	}

	respBody, statusCode := wm.proxyToCollectorRaw(http.MethodDelete, fmt.Sprintf("/api/widgets/%s", widgetID), true, nil)
	w.Header().Set("Content-Type", "application/json")
	if collectorAuthError(w, statusCode) {
		return
	}
	w.WriteHeader(statusCode)
	w.Write(respBody)

	if statusCode == http.StatusOK {
		// Remove from enabled list and cache.
		wm.RemoveFromCache(widgetID)
		newEnabled := make([]string, 0, len(wm.config.Server.EnabledWidgets))
		for _, id := range wm.config.Server.EnabledWidgets {
			if id != widgetID {
				newEnabled = append(newEnabled, id)
			}
		}
		if len(newEnabled) != len(wm.config.Server.EnabledWidgets) {
			wm.config.Server.EnabledWidgets = newEnabled
			if err := wm.saveEnabledWidgets(newEnabled); err != nil {
				log.Printf("[WidgetManager] Failed to save enabled_widgets after delete: %v", err)
			}
		}
	}
}

// HandleVersions proxies GET /admin/widgets/versions?widget_id=<id> → collector GET /api/widgets/:id/versions
// Wraps the bare array response into {"versions": [...]} for the frontend.
func (wm *WidgetManager) HandleVersions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	widgetID := r.URL.Query().Get("widget_id")
	if widgetID == "" {
		http.Error(w, "Missing widget_id query parameter", http.StatusBadRequest)
		return
	}
	body, statusCode := wm.proxyToCollectorRaw(http.MethodGet, fmt.Sprintf("/api/widgets/%s/versions", widgetID), true, nil)
	w.Header().Set("Content-Type", "application/json")
	if collectorAuthError(w, statusCode) {
		return
	}
	if statusCode != http.StatusOK {
		w.WriteHeader(statusCode)
		w.Write(body)
		return
	}
	// Collector returns a bare array; wrap into {"versions": [...]}
	var versions json.RawMessage
	if err := json.Unmarshal(body, &versions); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"error":"unexpected response from collector"}`))
		return
	}
	out, _ := json.Marshal(map[string]interface{}{"versions": versions})
	w.Write(out)
}

// HandleVersionContent proxies GET /admin/widgets/version?widget_id=<id>&version=<n>
// → collector GET /api/widgets/:id/versions/:n
func (wm *WidgetManager) HandleVersionContent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	widgetID := r.URL.Query().Get("widget_id")
	version := r.URL.Query().Get("version")
	if widgetID == "" || version == "" {
		http.Error(w, "Missing widget_id or version query parameter", http.StatusBadRequest)
		return
	}
	respBody, statusCode := wm.proxyToCollectorRaw(http.MethodGet, fmt.Sprintf("/api/widgets/%s/versions/%s", widgetID, version), true, nil)
	w.Header().Set("Content-Type", "application/json")
	if collectorAuthError(w, statusCode) {
		return
	}
	w.WriteHeader(statusCode)
	w.Write(respBody)
}

// ---------------------------------------------------------------------------
// Internal proxy helpers
// ---------------------------------------------------------------------------

// proxyToCollector forwards a request to the collector and writes the response directly.
func (wm *WidgetManager) proxyToCollector(w http.ResponseWriter, _ *http.Request, method, path string, withSecret bool, body io.Reader) {
	respBody, statusCode := wm.proxyToCollectorRaw(method, path, withSecret, body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	w.Write(respBody)
}

// proxyToCollectorRaw performs the collector request and returns the raw body + status code.
func (wm *WidgetManager) proxyToCollectorRaw(method, path string, withSecret bool, body io.Reader) ([]byte, int) {
	url := wm.collectorBaseURL() + path
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return []byte(fmt.Sprintf(`{"error":"failed to build request: %v"}`, err)), http.StatusInternalServerError
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withSecret {
		if secret := wm.instanceSecret(); secret != "" {
			req.Header.Set("X-Instance-Secret", secret)
		}
	}

	resp, err := wm.httpClient.Do(req)
	if err != nil {
		return []byte(fmt.Sprintf(`{"error":"collector unreachable: %v"}`, err)), http.StatusBadGateway
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return []byte(`{"error":"failed to read collector response"}`), http.StatusBadGateway
	}
	return respBody, resp.StatusCode
}
