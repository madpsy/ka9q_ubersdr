package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// HandleAddonProxies handles CRUD operations for addon proxy entries.
//
//	GET    /admin/addon-proxies          → list all entries (enabled and disabled)
//	POST   /admin/addon-proxies          → add a new entry
//	PUT    /admin/addon-proxies?name=X   → replace an existing entry by name
//	DELETE /admin/addon-proxies?name=X   → remove an entry by name
func (ah *AdminHandler) HandleAddonProxies(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetAddonProxies(w, r)
	case http.MethodPost:
		ah.handleAddAddonProxy(w, r)
	case http.MethodPut:
		ah.handleUpdateAddonProxy(w, r)
	case http.MethodDelete:
		ah.handleDeleteAddonProxy(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleAddonProxyTest performs a connectivity test against the backend of a named
// addon proxy entry. It issues an internal GET to http://<host>:<port>/ with a
// 3-second timeout and returns whether the connection succeeded together with the
// HTTP response code (if one was received).
//
//	GET /admin/addon-proxies/test?name=X
func (ah *AdminHandler) HandleAddonProxyTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "Missing ?name= query parameter", http.StatusBadRequest)
		return
	}

	// Find the entry in the current in-memory config (or re-read from disk).
	ah.addonsMu.Lock()
	var entry *AddonProxyEntry
	if ah.addonsConfig != nil {
		for i := range ah.addonsConfig.Proxies {
			if ah.addonsConfig.Proxies[i].Name == name {
				e := ah.addonsConfig.Proxies[i]
				entry = &e
				break
			}
		}
	}
	ah.addonsMu.Unlock()

	if entry == nil {
		http.Error(w, fmt.Sprintf("Addon proxy %q not found", name), http.StatusNotFound)
		return
	}

	targetURL := fmt.Sprintf("http://%s:%d/", entry.Host, entry.Port)

	client := &http.Client{
		Timeout: 3 * time.Second,
		// Do not follow redirects — we just want to know if the backend is reachable.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := client.Get(targetURL)
	if err != nil {
		log.Printf("Admin: addon proxy test %q → %s: %v", name, targetURL, err)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":     false,
			"status_code": 0,
			"error":       err.Error(),
			"url":         targetURL,
		})
		return
	}
	defer resp.Body.Close()

	log.Printf("Admin: addon proxy test %q → %s: HTTP %d", name, targetURL, resp.StatusCode)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"status_code": resp.StatusCode,
		"error":       "",
		"url":         targetURL,
	})
}

// HandleAddonProxiesRestart triggers a server restart (addon proxy config is already
// persisted on each add/edit/delete, so no save step is needed here).
func (ah *AdminHandler) HandleAddonProxiesRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	ah.restartServer()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "Server is restarting...",
		"restart": true,
	})
}

// addonProxyJSON is the JSON representation sent to / received from the admin UI.
// It mirrors AddonProxyEntry but uses json tags and omits internal fields.
type addonProxyJSON struct {
	Name          string   `json:"name"`
	Enabled       bool     `json:"enabled"`
	Host          string   `json:"host"`
	Port          int      `json:"port"`
	StripPrefix   bool     `json:"strip_prefix"`
	RequireAdmin  bool     `json:"require_admin"`
	RewriteOrigin bool     `json:"rewrite_origin"`
	AllowedIPs    []string `json:"allowed_ips"`
	RateLimit     int      `json:"rate_limit"`
	// Computed field returned by GET — not stored in YAML
	Path string `json:"path,omitempty"`
}

func entryToJSON(e AddonProxyEntry) addonProxyJSON {
	ips := e.AllowedIPs
	if ips == nil {
		ips = []string{}
	}
	return addonProxyJSON{
		Name:          e.Name,
		Enabled:       e.Enabled,
		Host:          e.Host,
		Port:          e.Port,
		StripPrefix:   e.StripPrefix,
		RequireAdmin:  e.RequireAdmin,
		RewriteOrigin: e.RewriteOrigin,
		AllowedIPs:    ips,
		RateLimit:     e.RateLimit,
		Path:          "/addon/" + e.Name + "/",
	}
}

func jsonToEntry(j addonProxyJSON) AddonProxyEntry {
	return AddonProxyEntry{
		Name:          j.Name,
		Enabled:       j.Enabled,
		Host:          j.Host,
		Port:          j.Port,
		StripPrefix:   j.StripPrefix,
		RequireAdmin:  j.RequireAdmin,
		RewriteOrigin: j.RewriteOrigin,
		AllowedIPs:    j.AllowedIPs,
		RateLimit:     j.RateLimit,
	}
}

// handleGetAddonProxies returns the full list of addon proxy entries as JSON.
// It always re-reads from disk so edits made via the admin UI are immediately visible.
func (ah *AdminHandler) handleGetAddonProxies(w http.ResponseWriter, r *http.Request) {
	path := ah.addonsConfigPath
	if path == "" {
		path = ah.getConfigPath("addons.yaml")
	}

	cfg, err := LoadAddonProxiesConfig(path)
	if err != nil {
		// File may not exist yet — return empty list
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode([]addonProxyJSON{})
		return
	}

	// Keep in-memory copy in sync
	ah.addonsMu.Lock()
	ah.addonsConfig = cfg
	ah.addonsMu.Unlock()

	result := make([]addonProxyJSON, 0, len(cfg.Proxies))
	for _, e := range cfg.Proxies {
		result = append(result, entryToJSON(e))
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(result)
}

// handleAddAddonProxy adds a new proxy entry and persists addons.yaml.
func (ah *AdminHandler) handleAddAddonProxy(w http.ResponseWriter, r *http.Request) {
	var req addonProxyJSON
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	ah.addonsMu.Lock()
	defer ah.addonsMu.Unlock()

	if ah.addonsConfig == nil {
		ah.addonsConfig = &AddonProxiesConfig{}
	}

	// Check for duplicate name
	for _, e := range ah.addonsConfig.Proxies {
		if e.Name == req.Name {
			http.Error(w, fmt.Sprintf("Addon proxy with name %q already exists", req.Name), http.StatusConflict)
			return
		}
	}

	newEntry := jsonToEntry(req)

	// Validate the new entry
	all := append(ah.addonsConfig.Proxies, newEntry)
	if err := validateAddonProxies(all); err != nil {
		http.Error(w, fmt.Sprintf("Validation error: %v", err), http.StatusBadRequest)
		return
	}

	ah.addonsConfig.Proxies = all

	if err := ah.saveAddonsConfig(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to save addons.yaml: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Admin: added addon proxy %q (enabled=%v, require_admin=%v)", newEntry.Name, newEntry.Enabled, newEntry.RequireAdmin)

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": fmt.Sprintf("Addon proxy %q added. Restart server to apply changes.", newEntry.Name),
		"proxy":   entryToJSON(newEntry),
	})
}

// handleUpdateAddonProxy replaces an existing proxy entry by name.
func (ah *AdminHandler) handleUpdateAddonProxy(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "Missing ?name= query parameter", http.StatusBadRequest)
		return
	}

	var req addonProxyJSON
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	ah.addonsMu.Lock()
	defer ah.addonsMu.Unlock()

	if ah.addonsConfig == nil {
		http.Error(w, "No addon proxies configured", http.StatusNotFound)
		return
	}

	idx := -1
	for i, e := range ah.addonsConfig.Proxies {
		if e.Name == name {
			idx = i
			break
		}
	}
	if idx == -1 {
		http.Error(w, fmt.Sprintf("Addon proxy %q not found", name), http.StatusNotFound)
		return
	}

	updated := jsonToEntry(req)
	// If the name changed, check for conflicts
	if updated.Name != name {
		for i, e := range ah.addonsConfig.Proxies {
			if i != idx && e.Name == updated.Name {
				http.Error(w, fmt.Sprintf("Addon proxy with name %q already exists", updated.Name), http.StatusConflict)
				return
			}
		}
	}

	// Build the new list and validate
	newList := make([]AddonProxyEntry, len(ah.addonsConfig.Proxies))
	copy(newList, ah.addonsConfig.Proxies)
	newList[idx] = updated

	if err := validateAddonProxies(newList); err != nil {
		http.Error(w, fmt.Sprintf("Validation error: %v", err), http.StatusBadRequest)
		return
	}

	ah.addonsConfig.Proxies = newList

	if err := ah.saveAddonsConfig(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to save addons.yaml: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Admin: updated addon proxy %q (enabled=%v, require_admin=%v)", updated.Name, updated.Enabled, updated.RequireAdmin)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": fmt.Sprintf("Addon proxy %q updated. Restart server to apply changes.", updated.Name),
		"proxy":   entryToJSON(updated),
	})
}

// handleDeleteAddonProxy removes a proxy entry by name.
func (ah *AdminHandler) handleDeleteAddonProxy(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "Missing ?name= query parameter", http.StatusBadRequest)
		return
	}

	ah.addonsMu.Lock()
	defer ah.addonsMu.Unlock()

	if ah.addonsConfig == nil {
		http.Error(w, "No addon proxies configured", http.StatusNotFound)
		return
	}

	idx := -1
	for i, e := range ah.addonsConfig.Proxies {
		if e.Name == name {
			idx = i
			break
		}
	}
	if idx == -1 {
		http.Error(w, fmt.Sprintf("Addon proxy %q not found", name), http.StatusNotFound)
		return
	}

	ah.addonsConfig.Proxies = append(ah.addonsConfig.Proxies[:idx], ah.addonsConfig.Proxies[idx+1:]...)

	if err := ah.saveAddonsConfig(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to save addons.yaml: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Admin: deleted addon proxy %q", name)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Addon proxy %q deleted. Restart server to apply changes.", name),
	})
}

// saveAddonsConfig serialises ah.addonsConfig to addons.yaml (with timestamped backup).
// Caller must hold ah.addonsMu (write lock).
func (ah *AdminHandler) saveAddonsConfig() error {
	path := ah.addonsConfigPath
	if path == "" {
		path = ah.getConfigPath("addons.yaml")
	}

	// Backup existing file
	if _, err := os.Stat(path); err == nil {
		timestamp := time.Now().Format("20060102-150405")
		backupPath := fmt.Sprintf("%s.%s", path, timestamp)
		if err := os.Rename(path, backupPath); err != nil {
			log.Printf("Warning: Failed to backup addons.yaml: %v", err)
		} else {
			log.Printf("Backed up addons.yaml to %s", backupPath)
		}
	}

	data, err := yaml.Marshal(ah.addonsConfig)
	if err != nil {
		return fmt.Errorf("marshal addons config: %w", err)
	}

	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("write addons.yaml: %w", err)
	}

	return nil
}
