package main

// api_handlers_settings.go — handlers for application settings endpoints:
//   GET  /api/v1/settings
//   PUT  /api/v1/settings

import "net/http"

const prefKeyBrowserAutoConnect = "browser_auto_connect"

// ── /settings ─────────────────────────────────────────────────────────────────

func (s *APIServer) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getSettings(w, r)
	case http.MethodPut:
		s.putSettings(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) getSettings(w http.ResponseWriter, r *http.Request) {
	s.state.Mu.RLock()
	bac := s.state.BrowserAutoConnect
	s.state.Mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"browser_auto_connect": bac,
	})
}

func (s *APIServer) putSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BrowserAutoConnect *bool `json:"browser_auto_connect"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	s.state.Mu.Lock()
	if body.BrowserAutoConnect != nil {
		s.state.BrowserAutoConnect = *body.BrowserAutoConnect
		s.prefs.SetBool(prefKeyBrowserAutoConnect, *body.BrowserAutoConnect)
		// Sync the Fyne checkbox if it exists.
		if s.state.BrowserAutoConnectChk != nil {
			chk := s.state.BrowserAutoConnectChk
			val := *body.BrowserAutoConnect
			go func() { chk.SetChecked(val) }()
		}
	}
	bac := s.state.BrowserAutoConnect
	s.state.Mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"browser_auto_connect": bac,
	})
}
