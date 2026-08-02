package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

// ─── Data types ──────────────────────────────────────────────────────────────

// PagesLink represents a single link entry in a pages group or subgroup.
type PagesLink struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	DependsOn   string `json:"depends_on,omitempty"`
	Download    bool   `json:"download,omitempty"`
}

// PagesSubgroup represents a named sub-menu inside a group. Subgroups may nest
// arbitrarily deep — each level becomes another flyout in the Links menu.
type PagesSubgroup struct {
	Name      string          `json:"name"`
	Files     []PagesLink     `json:"files,omitempty"`
	Subgroups []PagesSubgroup `json:"subgroups,omitempty"`
}

// PagesGroup represents one top-level group in the pages menu.
type PagesGroup struct {
	Group     string          `json:"group"`
	DependsOn string          `json:"depends_on,omitempty"`
	Files     []PagesLink     `json:"files,omitempty"`
	Subgroups []PagesSubgroup `json:"subgroups,omitempty"`
}

// PagesData is the top-level structure for both frontend-pages.json and custom-links.json.
type PagesData struct {
	Groups []PagesGroup `json:"groups"`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// readFrontendPages reads and parses the static frontend-pages.json file.
func readFrontendPages() (PagesData, error) {
	data, err := os.ReadFile("frontend-pages.json")
	if err != nil {
		return PagesData{}, err
	}
	var pd PagesData
	if err := json.Unmarshal(data, &pd); err != nil {
		return PagesData{}, err
	}
	return pd, nil
}

// readCustomLinks reads and parses custom-links.json from the config directory.
// Returns an empty PagesData (no error) if the file does not exist.
func readCustomLinks(configDir string) (PagesData, error) {
	path := "custom-links.json"
	if configDir != "" && configDir != "." {
		path = configDir + "/custom-links.json"
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return PagesData{Groups: []PagesGroup{}}, nil
	}
	if err != nil {
		return PagesData{}, err
	}
	var pd PagesData
	if err := json.Unmarshal(data, &pd); err != nil {
		return PagesData{}, err
	}
	return pd, nil
}

// mergePages merges custom groups into the built-in pages data.
//
// Merge rules:
//   - If a custom group's "group" name matches an existing built-in group name,
//     its files are appended to that group's files, and its subgroups are merged
//     by name (matching subgroup names get their files appended and their own
//     subgroups merged recursively; new subgroup names are appended as new
//     subgroups).
//   - If a custom group's name does not match any built-in group, it is appended
//     as a new group after all built-in groups.
func mergePages(builtin, custom PagesData) PagesData {
	// Build an index of built-in groups by name for O(1) lookup.
	index := make(map[string]int, len(builtin.Groups))
	for i, g := range builtin.Groups {
		index[g.Group] = i
	}

	for _, cg := range custom.Groups {
		if i, ok := index[cg.Group]; ok {
			// Extend an existing built-in group.
			builtin.Groups[i].Files = append(builtin.Groups[i].Files, cg.Files...)
			builtin.Groups[i].Subgroups = mergeSubgroups(builtin.Groups[i].Subgroups, cg.Subgroups)
		} else {
			// New group — append after all built-ins.
			builtin.Groups = append(builtin.Groups, cg)
		}
	}

	return builtin
}

// mergeSubgroups merges custom subgroups into built-in ones by name, recursing
// into nested subgroups. Unmatched names are appended as new subgroups.
func mergeSubgroups(builtin, custom []PagesSubgroup) []PagesSubgroup {
	if len(custom) == 0 {
		return builtin
	}

	index := make(map[string]int, len(builtin))
	for i, sg := range builtin {
		index[sg.Name] = i
	}

	for _, csg := range custom {
		if i, ok := index[csg.Name]; ok {
			builtin[i].Files = append(builtin[i].Files, csg.Files...)
			builtin[i].Subgroups = mergeSubgroups(builtin[i].Subgroups, csg.Subgroups)
		} else {
			index[csg.Name] = len(builtin)
			builtin = append(builtin, csg)
		}
	}

	return builtin
}

// ─── Public endpoint ─────────────────────────────────────────────────────────

// handlePagesMenu serves the merged pages menu data.
//
// GET /api/pages-menu
//
// Returns the built-in frontend-pages.json merged with any custom-links.json
// from the config directory. Custom groups that share a name with a built-in
// group have their links injected into that group; unmatched custom groups are
// appended at the end.
//
// This is a public endpoint — no authentication required.
func handlePagesMenu(w http.ResponseWriter, r *http.Request, configDir string) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	builtin, err := readFrontendPages()
	if err != nil {
		log.Printf("pages-menu: failed to read frontend-pages.json: %v", err)
		http.Error(w, "Failed to read pages data", http.StatusInternalServerError)
		return
	}

	custom, err := readCustomLinks(configDir)
	if err != nil {
		log.Printf("pages-menu: failed to read custom-links.json: %v", err)
		// Non-fatal — serve built-in only.
		custom = PagesData{Groups: []PagesGroup{}}
	}

	merged := mergePages(builtin, custom)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	if err := json.NewEncoder(w).Encode(merged); err != nil {
		log.Printf("pages-menu: encode error: %v", err)
	}
}

// ─── Admin endpoints ─────────────────────────────────────────────────────────

// HandleCustomLinks dispatches GET and PUT requests for the custom links config.
//
// GET  /admin/custom-links  — returns the current custom-links.json (or empty structure)
// PUT  /admin/custom-links  — validates and saves a new custom-links.json
func (ah *AdminHandler) HandleCustomLinks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		ah.handleGetCustomLinks(w, r)
	case http.MethodPut:
		ah.handlePutCustomLinks(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetCustomLinks returns both the built-in pages structure and the current
// custom-links.json in a single response, so the admin UI can render the merged
// view without making a separate (unauthenticated) fetch for frontend-pages.json.
//
// Response: { "builtin": <PagesData>, "custom": <PagesData> }
func (ah *AdminHandler) handleGetCustomLinks(w http.ResponseWriter, r *http.Request) {
	builtin, err := readFrontendPages()
	if err != nil {
		log.Printf("admin/custom-links GET: failed to read frontend-pages.json: %v", err)
		http.Error(w, "Failed to read built-in pages data", http.StatusInternalServerError)
		return
	}

	custom, err := readCustomLinks(ah.configDir)
	if err != nil {
		log.Printf("admin/custom-links GET: %v", err)
		http.Error(w, "Failed to read custom-links.json", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"builtin": builtin,
		"custom":  custom,
	}); err != nil {
		log.Printf("admin/custom-links GET encode: %v", err)
	}
}

// handlePutCustomLinks validates and saves a new custom-links.json.
func (ah *AdminHandler) handlePutCustomLinks(w http.ResponseWriter, r *http.Request) {
	var body PagesData
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Validate: each group must have a non-empty name, and group names must be unique.
	// Each file entry must have non-empty path and name.
	seenGroups := make(map[string]bool, len(body.Groups))
	for gi, g := range body.Groups {
		if g.Group == "" {
			http.Error(w, "groups["+itoa(gi)+"]: group name must not be empty", http.StatusBadRequest)
			return
		}
		if seenGroups[g.Group] {
			http.Error(w, "groups["+itoa(gi)+"]: duplicate group name '"+g.Group+"' — each group name must appear only once", http.StatusBadRequest)
			return
		}
		seenGroups[g.Group] = true
		if err := validateLinks("groups["+itoa(gi)+"]", g.Files); err != "" {
			http.Error(w, err, http.StatusBadRequest)
			return
		}
		if err := validateSubgroups("groups["+itoa(gi)+"]", g.Subgroups); err != "" {
			http.Error(w, err, http.StatusBadRequest)
			return
		}
	}

	// Marshal to JSON with indentation for human readability.
	out, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		http.Error(w, "Failed to marshal data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	path := ah.getConfigPath("custom-links.json")
	if err := os.WriteFile(path, out, 0644); err != nil {
		http.Error(w, "Failed to write custom-links.json: "+err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("custom-links: saved %d group(s) to %s", len(body.Groups), path)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Custom links saved. The Links menu will reflect changes immediately.",
	}); err != nil {
		log.Printf("admin/custom-links PUT encode: %v", err)
	}
}

// validateLinks checks that every link has a non-empty path and name.
// Returns an empty string when valid, otherwise a human-readable error message
// prefixed with the caller's JSON path.
func validateLinks(prefix string, files []PagesLink) string {
	for fi, f := range files {
		if f.Path == "" {
			return prefix + ".files[" + itoa(fi) + "]: path must not be empty"
		}
		if f.Name == "" {
			return prefix + ".files[" + itoa(fi) + "]: name must not be empty"
		}
	}
	return ""
}

// validateSubgroups checks subgroup names, their links, and recurses into any
// nested subgroups. Returns an empty string when valid.
func validateSubgroups(prefix string, subgroups []PagesSubgroup) string {
	for si, sg := range subgroups {
		path := prefix + ".subgroups[" + itoa(si) + "]"
		if sg.Name == "" {
			return path + ": name must not be empty"
		}
		if err := validateLinks(path, sg.Files); err != "" {
			return err
		}
		if err := validateSubgroups(path, sg.Subgroups); err != "" {
			return err
		}
	}
	return ""
}

// itoa is a tiny helper to avoid importing strconv just for index formatting.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := make([]byte, 0, 10)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}
