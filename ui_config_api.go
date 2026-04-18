package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"

	"gopkg.in/yaml.v3"
)

// themeDefaults are the original hardcoded colours used throughout style.css.
// When a theme key is absent or empty in ui.yaml the CSS :root fallback applies,
// reproducing the original appearance exactly.
var themeDefaults = map[string]string{
	"page_bg":    "#adb5bd",
	"panel_dark": "#2c3e50",
	"panel_mid":  "#34495e",
	"accent":     "#667eea",
	"accent_end": "#764ba2",
	"text_light": "#ecf0f1",
}

// validHexColor reports whether s is a valid 6-digit CSS hex colour (#rrggbb).
var hexColorRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func isValidHexColor(s string) bool {
	return hexColorRE.MatchString(s)
}

// handleUIConfig serves the UI configuration defaults to the public frontend.
// This is a public endpoint — no authentication required.
// It returns only the scalar default values (not the full available options list),
// which is all the frontend needs to apply defaults for new visitors.
//
// GET /api/ui-config
// Response:
//
//	{
//	  "smeter_mode":                "smeter-classic",          // ubersdr_smeter_colour_mode
//	  "palette":                    "jet",                     // spectrumColorScheme
//	  "contrast":                   10,                        // spectrumAutoContrast (0-20)
//	  "vu_meter_style":             "bar",                     // vuMeterStyle
//	  "gpu_scroll":                 false,                     // spectrumGpuScrollEnabled
//	  "smoothing":                  false,                     // spectrumSmoothEnabled
//	  "peak_hold":                  true,                      // spectrumHoldEnabled
//	  "line_graph":                 false,                     // spectrumLineGraphEnabled
//	  "bandwidth_indicator_color":  "green",                   // bandwidthIndicatorColor
//	  "spectrum_bg_image":          "/api/spectrum-bg-image",  // URL or "" if not set
//	  "spectrum_bg_opacity":        0.3                        // 0.0–1.0
//	}
func handleUIConfig(w http.ResponseWriter, r *http.Request, config *Config, configDir string) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")

	// Check whether a background image file actually exists on disk
	assetsDir := "assets"
	if configDir != "" && configDir != "." {
		assetsDir = configDir + "/assets"
	}
	bgImageURL := ""
	if _, err := os.Stat(assetsDir + "/spectrum-bg.png"); err == nil {
		bgImageURL = "/api/spectrum-bg-image"
	}

	opacity := config.UI.SpectrumBgOpacity
	if opacity == 0 {
		opacity = 0.3 // sensible default when not explicitly set
	}

	bwColor := config.UI.BandwidthIndicatorColor.Default
	if bwColor == "" {
		bwColor = "green" // built-in fallback
	}

	stationIdColor := config.UI.StationIdColor
	if stationIdColor == "" || !isValidHexColor(stationIdColor) {
		stationIdColor = "#ffffff" // built-in fallback
	}

	// Build the effective theme map: start with defaults, overlay any configured values.
	// This ensures the frontend always receives a complete set of theme tokens even when
	// ui.yaml has no theme section — the CSS :root fallback values match these defaults.
	effectiveTheme := make(map[string]string, len(themeDefaults))
	for k, v := range themeDefaults {
		effectiveTheme[k] = v
	}
	for k, v := range config.UI.Theme {
		if isValidHexColor(v) {
			effectiveTheme[k] = v
		}
	}

	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"signal_meter_mode":         config.UI.SignalMeterMode.Default,
		"smeter_mode":               config.UI.SMeterMode.Default,
		"palette":                   config.UI.Palette.Default,
		"contrast":                  config.UI.Contrast.Default,
		"vu_meter_style":            config.UI.VUMeterStyle.Default,
		"gpu_scroll":                config.UI.GPUScroll.Default,
		"smoothing":                 config.UI.Smoothing.Default,
		"peak_hold":                 config.UI.PeakHold.Default,
		"line_graph":                config.UI.LineGraph.Default,
		"bandwidth_indicator_color": bwColor,
		"spectrum_bg_image":         bgImageURL,
		"spectrum_bg_opacity":       opacity,
		"station_id_overlay":        config.UI.StationIdOverlay,
		"station_id_color":          stationIdColor,
		"theme":                     effectiveTheme,
	}); err != nil {
		log.Printf("Error encoding UI config response: %v", err)
	}
}

// handleAdminGetUIConfig returns the full UI configuration including available options.
// Used by the admin UI to build dynamic dropdowns without hardcoding option values in HTML.
//
// GET /admin/ui-config
// Response: full UIConfig struct with default + available[] for each select setting
func handleAdminGetUIConfig(w http.ResponseWriter, r *http.Request, configDir string, config *Config) {
	// Try to read the raw ui.yaml file first so we return exactly what's on disk
	uiPath := "ui.yaml"
	if configDir != "" && configDir != "." {
		uiPath = configDir + "/ui.yaml"
	}

	data, err := os.ReadFile(uiPath)
	if err != nil {
		// File doesn't exist — return the in-memory config (built-in defaults)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"ui": config.UI,
		}); err != nil {
			log.Printf("Error encoding UI config response: %v", err)
		}
		return
	}

	// Parse the raw YAML into a generic map so we return it exactly as stored
	var rawConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &rawConfig); err != nil {
		http.Error(w, "Failed to parse ui.yaml", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(rawConfig); err != nil {
		log.Printf("Error encoding UI config response: %v", err)
	}
}

// handleAdminPutUIConfig saves updated UI configuration to ui.yaml.
// Validates that each select setting's default value exists in its available list.
// Updates config.UI in memory immediately so the public endpoint reflects changes
// without requiring a server restart.
//
// PUT /admin/ui-config
// Body: {"ui": {"smeter_mode": {"default": "smeter-classic", "available": [...]}, ...}}
func handleAdminPutUIConfig(w http.ResponseWriter, r *http.Request, configDir string, config *Config) {
	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Re-marshal to YAML for storage
	yamlData, err := yaml.Marshal(body)
	if err != nil {
		http.Error(w, "Failed to marshal config: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Parse into typed UIConfig to validate and update in-memory config
	var parsed struct {
		UI UIConfig `yaml:"ui"`
	}
	if err := yaml.Unmarshal(yamlData, &parsed); err != nil {
		http.Error(w, "Failed to parse UI config: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Validate select settings: default must be present in available list
	if err := validateUISelectSetting("signal_meter_mode", parsed.UI.SignalMeterMode); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateUISelectSetting("smeter_mode", parsed.UI.SMeterMode); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateUISelectSetting("palette", parsed.UI.Palette); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateUISelectSetting("vu_meter_style", parsed.UI.VUMeterStyle); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateUISelectSetting("bandwidth_indicator_color", parsed.UI.BandwidthIndicatorColor); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Validate contrast range (0-20 to match the UI slider)
	if parsed.UI.Contrast.Default < parsed.UI.Contrast.Min || parsed.UI.Contrast.Default > parsed.UI.Contrast.Max {
		http.Error(w, "contrast.default must be between contrast.min and contrast.max", http.StatusBadRequest)
		return
	}

	// Validate station_id_color — must be a valid 6-digit hex colour if non-empty
	if parsed.UI.StationIdColor != "" && !isValidHexColor(parsed.UI.StationIdColor) {
		http.Error(w, fmt.Sprintf("station_id_color: invalid hex colour '%s' (expected #rrggbb)", parsed.UI.StationIdColor), http.StatusBadRequest)
		return
	}

	// Validate theme colours — each value must be a valid 6-digit hex colour if present
	for key, val := range parsed.UI.Theme {
		if val != "" && !isValidHexColor(val) {
			http.Error(w, fmt.Sprintf("theme.%s: invalid hex colour '%s' (expected #rrggbb)", key, val), http.StatusBadRequest)
			return
		}
	}

	// Write to ui.yaml
	uiPath := "ui.yaml"
	if configDir != "" && configDir != "." {
		uiPath = configDir + "/ui.yaml"
	}

	if err := os.WriteFile(uiPath, yamlData, 0644); err != nil {
		http.Error(w, "Failed to write ui.yaml: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Update in-memory config immediately — no restart needed
	config.UI = parsed.UI

	log.Printf("UI config updated: palette=%s, smeter_mode=%s, contrast=%d, vu_meter=%s, gpu=%v, smooth=%v, hold=%v, linegraph=%v, bw_color=%s, bg_opacity=%.2f, station_id_overlay=%v, station_id_color=%s, theme=%v",
		config.UI.Palette.Default, config.UI.SMeterMode.Default, config.UI.Contrast.Default,
		config.UI.VUMeterStyle.Default, config.UI.GPUScroll.Default, config.UI.Smoothing.Default,
		config.UI.PeakHold.Default, config.UI.LineGraph.Default,
		config.UI.BandwidthIndicatorColor.Default, config.UI.SpectrumBgOpacity,
		config.UI.StationIdOverlay, config.UI.StationIdColor, config.UI.Theme)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "UI configuration saved. New visitors will see these defaults immediately.",
	}); err != nil {
		log.Printf("Error encoding UI config save response: %v", err)
	}
}

// validateUISelectSetting checks that the default value exists in the available list.
func validateUISelectSetting(name string, s UISelectSetting) error {
	if s.Default == "" {
		return nil // empty default is allowed (will use built-in fallback)
	}
	for _, opt := range s.Available {
		if opt.Value == s.Default {
			return nil
		}
	}
	return &uiValidationError{
		field:   name,
		value:   s.Default,
		message: "default value '" + s.Default + "' is not in the available options list for '" + name + "'",
	}
}

// uiValidationError is returned when a UI config value fails validation.
type uiValidationError struct {
	field   string
	value   string
	message string
}

func (e *uiValidationError) Error() string {
	return e.message
}
