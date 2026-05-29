package main

// api_handlers_profiles.go — handlers for profile endpoints:
//   GET    /api/v1/profiles
//   GET    /api/v1/profiles/{name}
//   PUT    /api/v1/profiles/{name}
//   DELETE /api/v1/profiles/{name}
//   POST   /api/v1/profiles/{name}/load

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// handleProfiles handles GET /api/v1/profiles (list all).
func (s *APIServer) handleProfiles(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	names := ListProfiles(s.prefs)
	type profileJSON struct {
		Name        string  `json:"name"`
		URL         string  `json:"url"`
		Callsign    string  `json:"callsign"`
		FrequencyHz int     `json:"frequency_hz"`
		Mode        string  `json:"mode"`
		Bandwidth   float64 `json:"bandwidth"`
		Format      string  `json:"format"`
		StepIndex   int     `json:"step_index"`
		DeviceID    string  `json:"device_id"`
		Volume      float64 `json:"volume"`
		Channel     string  `json:"channel"`
	}

	out := make([]profileJSON, 0, len(names))
	for _, n := range names {
		p, ok := LoadProfile(s.prefs, n)
		if !ok {
			continue
		}
		out = append(out, profileJSON{
			Name:        p.Name,
			URL:         p.URL,
			Callsign:    p.Callsign,
			FrequencyHz: p.FrequencyHz,
			Mode:        p.Mode,
			Bandwidth:   p.Bandwidth,
			Format:      p.Format,
			StepIndex:   p.StepIndex,
			DeviceID:    p.DeviceID,
			Volume:      p.Volume,
			Channel:     p.Channel,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"profiles": out})
}

// handleProfileByName routes /api/v1/profiles/{name} and /api/v1/profiles/{name}/load.
func (s *APIServer) handleProfileByName(w http.ResponseWriter, r *http.Request) {
	// Path is /api/v1/profiles/{name} or /api/v1/profiles/{name}/load
	suffix := pathSuffix("/api/v1/profiles/", r.URL.Path)

	// Check for /load suffix.
	isLoad := strings.HasSuffix(suffix, "/load")
	if isLoad {
		suffix = strings.TrimSuffix(suffix, "/load")
	}

	// URL-decode the name.
	name, err := url.PathUnescape(suffix)
	if err != nil || strings.TrimSpace(name) == "" {
		apiError(w, http.StatusUnprocessableEntity, "profile name must be non-empty")
		return
	}
	name = strings.TrimSpace(name)

	if isLoad {
		if !methodOnly(w, r, http.MethodPost) {
			return
		}
		s.loadProfile(w, name)
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.getProfile(w, name)
	case http.MethodPut:
		s.saveProfile(w, name)
	case http.MethodDelete:
		s.deleteProfile(w, name)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut, http.MethodDelete)
	}
}

func (s *APIServer) getProfile(w http.ResponseWriter, name string) {
	p, ok := LoadProfile(s.prefs, name)
	if !ok {
		apiError(w, http.StatusNotFound, "profile not found: "+name)
		return
	}
	// Return the same shape as the list endpoint — omit the stored password.
	writeJSON(w, http.StatusOK, map[string]any{
		"name":         p.Name,
		"url":          p.URL,
		"callsign":     p.Callsign,
		"frequency_hz": p.FrequencyHz,
		"mode":         p.Mode,
		"bandwidth":    p.Bandwidth,
		"format":       p.Format,
		"step_index":   p.StepIndex,
		"device_id":    p.DeviceID,
		"volume":       p.Volume,
		"channel":      p.Channel,
	})
}

func (s *APIServer) saveProfile(w http.ResponseWriter, name string) {
	if !profileNameValid(name) {
		apiError(w, http.StatusUnprocessableEntity, "profile name must be non-empty")
		return
	}

	// Snapshot current state.
	s.state.Mu.RLock()
	freq := s.state.CurrentFreq
	mode := s.state.CurrentMode
	bw := s.state.CurrentBW
	stepIdx := s.state.StepIndex
	vol := s.state.Volume
	channel := s.state.ChannelMode
	format := s.state.Format
	devID := s.state.DeviceID
	callsign := s.state.ActiveCallsign
	rawURL := ""
	if s.state.URLEntry != nil {
		rawURL = s.state.URLEntry.Text
	}
	password := ""
	if s.state.PasswordEntry != nil {
		password = s.state.PasswordEntry.Text
	}
	s.state.Mu.RUnlock()

	p := Profile{
		Name:        name,
		URL:         strings.TrimSpace(rawURL),
		Password:    password,
		FrequencyHz: freq,
		Mode:        mode,
		Bandwidth:   bw,
		Format:      format,
		StepIndex:   stepIdx,
		DeviceID:    devID,
		Volume:      vol,
		Channel:     channel,
		Callsign:    callsign,
	}

	SaveProfile(s.prefs, p)
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "saved": true})
}

func (s *APIServer) deleteProfile(w http.ResponseWriter, name string) {
	if _, ok := LoadProfile(s.prefs, name); !ok {
		apiError(w, http.StatusNotFound, "profile not found: "+name)
		return
	}
	DeleteProfile(s.prefs, name)
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "deleted": true})
}

func (s *APIServer) loadProfile(w http.ResponseWriter, name string) {
	p, ok := LoadProfile(s.prefs, name)
	if !ok {
		apiError(w, http.StatusNotFound, "profile not found: "+name)
		return
	}

	// Derive canonical string values for AppState.
	fmtStr := "opus"
	if p.Format == "Uncompressed" {
		fmtStr = "pcm-zstd"
	}
	chStr := "both"
	switch p.Channel {
	case "Left":
		chStr = "left"
	case "Right":
		chStr = "right"
	}

	// Update AppState immediately so the web UI poll reflects the new
	// settings within 2 s, before the Fyne GUI has a chance to update.
	s.state.Mu.Lock()
	s.state.CurrentFreq = p.FrequencyHz
	s.state.CurrentMode = p.Mode
	s.state.CurrentBW = p.Bandwidth
	s.state.StepIndex = p.StepIndex
	s.state.Volume = p.Volume
	s.state.ChannelMode = chStr
	s.state.Format = fmtStr
	s.state.DeviceID = p.DeviceID
	s.state.Mu.Unlock()

	// Sync Fyne widgets so the GUI stays in sync (all Set* methods are goroutine-safe).
	if s.state.URLEntry != nil {
		s.state.URLEntry.SetText(p.URL)
	}
	if s.state.FreqEntry != nil {
		s.state.FreqEntry.SetText(formatFreqKHz(p.FrequencyHz))
	}
	if s.state.ModeSelect != nil {
		for _, lbl := range s.state.ModeSelect.Options {
			if modeKey(lbl) == p.Mode {
				s.state.ModeSelect.SetSelected(lbl)
				break
			}
		}
	}
	if s.state.BWSlider != nil {
		s.state.BWSlider.SetValue(p.Bandwidth)
	}
	if s.state.BWValueLabel != nil {
		s.state.BWValueLabel.SetText(formatBWLabel(p.Mode, p.Bandwidth))
	}
	if s.state.StepSelect != nil {
		s.state.StepSelect.SetSelectedIndex(p.StepIndex)
	}
	if s.state.VolumeSlider != nil {
		s.state.VolumeSlider.SetValue(p.Volume)
	}
	if s.state.ChannelSelect != nil {
		s.state.ChannelSelect.SetSelected(channelDisplayName(p.Channel))
	}

	// DoProfileConnectByName calls applyProfile (which also updates widgets)
	// then profileConnectAndClose in a background goroutine.
	if s.state.DoProfileConnectByName != nil {
		if err := s.state.DoProfileConnectByName(name); err != nil {
			apiError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"state": "connecting",
		"url":   p.URL,
	})
}

// formatBWLabel returns a human-readable bandwidth label for a mode/BW pair.
func formatBWLabel(mode string, bw float64) string {
	if isWideIQMode(mode) {
		return "server preset"
	}
	return fmt.Sprintf("%.0f Hz", bw)
}

// channelDisplayName maps the stored channel key to the Fyne select label.
func channelDisplayName(ch string) string {
	switch ch {
	case "Left":
		return "Left"
	case "Right":
		return "Right"
	default:
		return "Left & Right"
	}
}
