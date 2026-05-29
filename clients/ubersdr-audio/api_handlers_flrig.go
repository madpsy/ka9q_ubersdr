package main

// api_handlers_flrig.go — handlers for FLRig sync endpoints:
//   GET /api/v1/flrig
//   PUT /api/v1/flrig

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

func (s *APIServer) handleFlrig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getFlrig(w, r)
	case http.MethodPut:
		s.putFlrig(w, r)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut)
	}
}

func (s *APIServer) getFlrig(w http.ResponseWriter, _ *http.Request) {
	s.state.Mu.RLock()
	enabled := s.state.FlrigEnabled
	host := s.state.FlrigHost
	port := s.state.FlrigPort
	dir := s.state.FlrigDirection
	pttMute := s.state.FlrigPTTMute
	pttActive := s.state.FlrigPTTActive
	s.state.Mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":    enabled,
		"host":       host,
		"port":       port,
		"direction":  dir,
		"ptt_mute":   pttMute,
		"connected":  s.flrig.IsConnected(),
		"ptt_active": pttActive,
	})
}

func (s *APIServer) putFlrig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled   *bool   `json:"enabled"`
		Host      *string `json:"host"`
		Port      *int    `json:"port"`
		Direction *string `json:"direction"`
		PTTMute   *bool   `json:"ptt_mute"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	s.state.Mu.Lock()
	enabled := s.state.FlrigEnabled
	host := s.state.FlrigHost
	port := s.state.FlrigPort
	dir := s.state.FlrigDirection
	pttMute := s.state.FlrigPTTMute
	s.state.Mu.Unlock()

	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	if body.Host != nil {
		h := strings.TrimSpace(*body.Host)
		if h == "" {
			h = "127.0.0.1" // default, matching GUI behaviour
		}
		host = h
	}

	if body.Port != nil {
		p := *body.Port
		if p < 1 || p > 65535 {
			p = 12345 // default, matching GUI behaviour
		}
		port = p
	}

	if body.Direction != nil {
		switch *body.Direction {
		case "sdr-to-rig", "rig-to-sdr", "both":
			dir = *body.Direction
		default:
			apiFieldError(w, "direction", *body.Direction,
				fmt.Sprintf(`"sdr-to-rig", "rig-to-sdr", or "both"`))
			return
		}
	}

	if body.PTTMute != nil {
		pttMute = *body.PTTMute
	}

	// Persist to AppState.
	s.state.Mu.Lock()
	s.state.FlrigEnabled = enabled
	s.state.FlrigHost = host
	s.state.FlrigPort = port
	s.state.FlrigDirection = dir
	s.state.FlrigPTTMute = pttMute
	s.state.Mu.Unlock()

	// Sync ALL Fyne flrig widgets so the GUI stays in sync.
	// This must happen BEFORE DoApplyFlrigConfig is called, because that
	// function reads the widget values to call Configure() — if we don't
	// update them first it will overwrite our values with the old widget state.
	if s.state.FlrigEnabledChk != nil {
		s.state.FlrigEnabledChk.SetChecked(enabled)
	}
	if s.state.FlrigHostEnt != nil {
		s.state.FlrigHostEnt.SetText(host)
	}
	if s.state.FlrigPortEnt != nil {
		s.state.FlrigPortEnt.SetText(strconv.Itoa(port))
	}
	if s.state.FlrigDirSel != nil {
		s.state.FlrigDirSel.SetSelected(dir)
	}
	if s.state.FlrigPTTMuteChk != nil {
		s.state.FlrigPTTMuteChk.SetChecked(pttMute)
	}

	// The SetChecked/SetText/SetSelected calls above each fire OnChanged on the
	// Fyne widgets, which in turn call applyFlrigConfig() — so Configure() has
	// already been called with the correct values by the time we reach here.
	// We call DoApplyFlrigConfig once more explicitly as a safety net in case
	// the widget callbacks were suppressed or not yet wired.
	if s.state.DoApplyFlrigConfig != nil {
		s.state.DoApplyFlrigConfig()
	} else {
		// Fallback: apply directly if the GUI callback isn't wired yet.
		s.flrig.Configure(host, port, dir, enabled)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":    enabled,
		"host":       host,
		"port":       port,
		"direction":  dir,
		"ptt_mute":   pttMute,
		"connected":  s.flrig.IsConnected(),
		"ptt_active": s.state.FlrigPTTActive,
	})
}
