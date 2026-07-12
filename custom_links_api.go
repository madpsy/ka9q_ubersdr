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
}

// PagesSubgroup represents a named sub-menu inside a group.
type PagesSubgroup struct {
	Name  string      `json:"name"`
	Files []PagesLink `json:"files,omitempty"`
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
//     by name (matching subgroup names get their files appended; new subgroup
//     names are appended as new subgroups).
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

			// Merge subgroups by name.
			sgIndex := make(map[string]int, len(builtin.Groups[i].Subgroups))
			for j, sg := range builtin.Groups[i].Subgroups {
				sgIndex[sg.Name] = j
			}
			for _, csg := range cg.Subgroups {
				if j, ok := sgIndex[csg.Name]; ok {
					// Append files into existing subgroup.
					builtin.Groups[i].Subgroups[j].Files = append(
						builtin.Groups[i].Subgroups[j].Files, csg.Files...)
				} else {
					// New subgroup — append.
					builtin.Groups[i].Subgroups = append(builtin.Groups[i].Subgroups, csg)
				}
			}
		} else {
			// New group — append after all built-ins.
			builtin.Groups = append(builtin.Groups, cg)
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

// handleGetCustomLinks returns the current custom-links.json.
func (ah *AdminHandler) handleGetCustomLinks(w http.ResponseWriter, r *http.Request) {
	custom, err := readCustomLinks(ah.configDir)
	if err != nil {
		log.Printf("admin/custom-links GET: %v", err)
		http.Error(w, "Failed to read custom-links.json", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	if err := json.NewEncoder(w).Encode(custom); err != nil {
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

	// Validate: each group must have a non-empty name.
	// Each file entry must have non-empty path and name.
	for gi, g := range body.Groups {
		if g.Group == "" {
			http.Error(w, "groups["+itoa(gi)+"]: group name must not be empty", http.StatusBadRequest)
			return
		}
		for fi, f := range g.Files {
			if f.Path == "" {
				http.Error(w, "groups["+itoa(gi)+"].files["+itoa(fi)+"]: path must not be empty", http.StatusBadRequest)
				return
			}
			if f.Name == "" {
				http.Error(w, "groups["+itoa(gi)+"].files["+itoa(fi)+"]: name must not be empty", http.StatusBadRequest)
				return
			}
		}
		for si, sg := range g.Subgroups {
			if sg.Name == "" {
				http.Error(w, "groups["+itoa(gi)+"].subgroups["+itoa(si)+"]: name must not be empty", http.StatusBadRequest)
				return
			}
			for fi, f := range sg.Files {
				if f.Path == "" {
					http.Error(w, "groups["+itoa(gi)+"].subgroups["+itoa(si)+"].files["+itoa(fi)+"]: path must not be empty", http.StatusBadRequest)
					return
				}
				if f.Name == "" {
					http.Error(w, "groups["+itoa(gi)+"].subgroups["+itoa(si)+"].files["+itoa(fi)+"]: name must not be empty", http.StatusBadRequest)
					return
				}
			}
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
