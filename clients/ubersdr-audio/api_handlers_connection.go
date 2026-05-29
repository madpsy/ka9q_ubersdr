package main

// api_handlers_connection.go — handlers for connection management endpoints:
//   GET  /api/v1/status
//   POST /api/v1/connect
//   POST /api/v1/disconnect
//   GET  /api/v1/instances
//   POST /api/v1/instances/connect

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ── /status ───────────────────────────────────────────────────────────────────

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	st := s.state
	st.Mu.RLock()
	freq := st.CurrentFreq
	mode := st.CurrentMode
	bw := st.CurrentBW
	bwLow, bwHigh := bwToLoHi(mode, bw)
	stepHz := 0
	if st.StepIndex >= 0 && st.StepIndex < len(freqSteps) {
		stepHz = freqSteps[st.StepIndex]
	}
	vol := st.Volume
	muted := st.Muted
	channel := st.ChannelMode
	format := st.Format
	devID := st.DeviceID
	agcHang := st.AGCHangTime
	agcRec := st.AGCRecoveryRate
	dspAvail := st.DSPAvailable
	dspEnabled := st.DSPEnabled
	dspFilter := st.DSPFilter
	dspFilters := make([]string, 0, len(st.DSPFilters))
	for _, f := range st.DSPFilters {
		dspFilters = append(dspFilters, f.Name)
	}
	callsign := st.ActiveCallsign
	stationName := st.ActiveName
	location := st.ActiveLocation
	sessionMax := st.SessionMaxSecs
	sessionConnectedAt := st.SessionConnectedAt
	maxClients := st.ConnMaxClients
	activeUsers := st.ActiveUsers
	throughput := st.ThroughputBPS
	flrigEnabled := st.FlrigEnabled
	flrigHost := st.FlrigHost
	flrigPort := st.FlrigPort
	flrigDir := st.FlrigDirection
	flrigPTTMute := st.FlrigPTTMute
	flrigPTTActive := st.FlrigPTTActive
	sigBB := st.SignalBasebandDBFS
	sigND := st.SignalNoiseDensityDBFS
	sigSNR := st.SignalSNRDB
	sigAudio := st.SignalAudioDBFS
	sigAt := st.SignalUpdatedAt
	st.Mu.RUnlock()

	connState := s.client.State()
	sessionUnlimited := sessionMax == 0
	sessionRemaining := 0
	if !sessionUnlimited && connState == StateConnected && !sessionConnectedAt.IsZero() {
		elapsed := int(time.Since(sessionConnectedAt).Seconds())
		sessionRemaining = sessionMax - elapsed
		if sessionRemaining < 0 {
			sessionRemaining = 0
		}
	}

	// connection.state must be lowercase per the API spec.
	connStateStr := ""
	switch connState {
	case StateConnected:
		connStateStr = "connected"
	case StateConnecting:
		connStateStr = "connecting"
	case StateError:
		connStateStr = "error"
	default:
		connStateStr = "disconnected"
	}

	// Resolve device name from ID.
	devName := "Default Device"
	audioDeviceMu.RLock()
	for _, d := range audioDeviceList {
		if d.ID == devID {
			devName = d.Name
			break
		}
	}
	audioDeviceMu.RUnlock()

	// Sinks.
	stdoutActive, udpAddrs := s.sinkMgr.Status()

	allowedIQ := s.client.AllowedIQModes()
	if allowedIQ == nil {
		allowedIQ = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"connection": map[string]any{
			"state":               connStateStr,
			"url":                 s.client.BaseURL,
			"callsign":            callsign,
			"name":                stationName,
			"location":            location,
			"session_remaining_s": sessionRemaining,
			"session_unlimited":   sessionUnlimited,
			"bypassed":            s.client.ConnBypassed(),
			"active_users":        activeUsers,
			"max_users":           maxClients,
			"throughput_bps":      throughput,
		},
		"tune": map[string]any{
			"frequency_hz":     freq,
			"mode":             mode,
			"bandwidth_low":    bwLow,
			"bandwidth_high":   bwHigh,
			"bandwidth_hz":     bw,
			"step_hz":          stepHz,
			"allowed_iq_modes": allowedIQ,
		},
		"audio": map[string]any{
			"volume":      vol,
			"muted":       muted,
			"channel":     channel,
			"format":      format,
			"device_id":   devID,
			"device_name": devName,
		},
		"agc": map[string]any{
			"hang_time_s":        agcHang,
			"recovery_rate_db_s": agcRec,
		},
		"signal": map[string]any{
			"baseband_dbfs":      sigBB,
			"noise_density_dbfs": sigND,
			"snr_db":             sigSNR,
			"audio_dbfs":         sigAudio,
			"updated_at":         sigAt,
		},
		"dsp": map[string]any{
			"available": dspAvail,
			"enabled":   dspEnabled,
			"filter":    dspFilter,
			"filters":   dspFilters,
		},
		"flrig": map[string]any{
			"enabled":    flrigEnabled,
			"host":       flrigHost,
			"port":       flrigPort,
			"direction":  flrigDir,
			"ptt_mute":   flrigPTTMute,
			"connected":  s.flrig.IsConnected(),
			"ptt_active": flrigPTTActive,
		},
		"sinks": map[string]any{
			"stdout": stdoutActive,
			"udp":    udpAddrs,
		},
	})
}

// ── /connect ──────────────────────────────────────────────────────────────────

func (s *APIServer) handleConnect(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPost) {
		return
	}

	var body struct {
		URL      string `json:"url"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	rawURL := strings.TrimSpace(body.URL)
	if rawURL == "" {
		apiFieldError(w, "url", rawURL, "must be a non-empty HTTP/HTTPS URL")
		return
	}
	// Require an explicit http:// or https:// scheme; url.Parse alone accepts
	// relative URLs and non-HTTP schemes which are not valid for this endpoint.
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		apiFieldError(w, "url", rawURL, "must be a valid HTTP/HTTPS URL (must start with http:// or https://)")
		return
	}
	if _, err := url.Parse(rawURL); err != nil {
		apiFieldError(w, "url", rawURL, "must be a valid HTTP/HTTPS URL")
		return
	}

	// Update URL entry widget (goroutine-safe).
	s.state.Mu.Lock()
	s.state.UserDisconnected = false
	s.state.Mu.Unlock()

	if s.state.URLEntry != nil {
		s.state.URLEntry.SetText(rawURL)
	}
	if s.state.PasswordEntry != nil {
		s.state.PasswordEntry.SetText(body.Password)
	}

	if s.state.DoConnect != nil {
		go s.state.DoConnect()
	}

	writeJSON(w, http.StatusOK, map[string]string{"state": "connecting"})
}

// ── /disconnect ───────────────────────────────────────────────────────────────

func (s *APIServer) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPost) {
		return
	}

	s.state.Mu.Lock()
	s.state.UserDisconnected = true
	s.state.Mu.Unlock()

	s.client.Disconnect()
	writeJSON(w, http.StatusOK, map[string]string{"state": "disconnected"})
}

// ── /instances ────────────────────────────────────────────────────────────────

func (s *APIServer) handleInstances(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	public, _ := FetchPublicInstances()
	var local []DiscoveredInstance
	if s.mdns != nil {
		local = s.mdns.Instances()
	}

	all := make([]DiscoveredInstance, 0, len(local)+len(public))
	all = append(all, local...)
	all = append(all, public...)

	type instJSON struct {
		Source           string `json:"source"`
		Name             string `json:"name"`
		Callsign         string `json:"callsign"`
		Host             string `json:"host"`
		Port             int    `json:"port"`
		TLS              bool   `json:"tls"`
		Location         string `json:"location"`
		AvailableClients int    `json:"available_clients"`
		MaxClients       int    `json:"max_clients"`
	}

	out := make([]instJSON, len(all))
	for i, inst := range all {
		out[i] = instJSON{
			Source:           inst.Source,
			Name:             inst.Name,
			Callsign:         inst.Callsign,
			Host:             inst.Host,
			Port:             inst.Port,
			TLS:              inst.TLS,
			Location:         inst.Location,
			AvailableClients: inst.AvailableClients,
			MaxClients:       inst.MaxClients,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"instances": out})
}

// ── /instances/connect ────────────────────────────────────────────────────────

func (s *APIServer) handleInstancesConnect(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPost) {
		return
	}

	var body struct {
		Callsign string `json:"callsign"`
		Name     string `json:"name"`
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	if body.Callsign == "" && body.Name == "" && body.Host == "" {
		apiError(w, http.StatusUnprocessableEntity, "provide at least one of: callsign, name, host")
		return
	}

	// Fetch fresh instance list.
	public, _ := FetchPublicInstances()
	var local []DiscoveredInstance
	if s.mdns != nil {
		local = s.mdns.Instances()
	}
	all := append(local, public...)

	// Match: callsign > host+port > name.
	var match *DiscoveredInstance
	if body.Callsign != "" {
		q := strings.ToLower(body.Callsign)
		for i := range all {
			if strings.ToLower(all[i].Callsign) == q {
				match = &all[i]
				break
			}
		}
	}
	if match == nil && body.Host != "" {
		for i := range all {
			if all[i].Host == body.Host && (body.Port == 0 || all[i].Port == body.Port) {
				match = &all[i]
				break
			}
		}
	}
	if match == nil && body.Name != "" {
		q := strings.ToLower(body.Name)
		for i := range all {
			if strings.Contains(strings.ToLower(all[i].Name), q) {
				match = &all[i]
				break
			}
		}
	}

	if match == nil {
		apiError(w, http.StatusNotFound, "no matching instance found")
		return
	}

	scheme := "http"
	if match.TLS {
		scheme = "https"
	}
	rawURL := fmt.Sprintf("%s://%s:%d", scheme, match.Host, match.Port)

	s.state.Mu.Lock()
	s.state.UserDisconnected = false
	s.state.Mu.Unlock()

	if s.state.URLEntry != nil {
		s.state.URLEntry.SetText(rawURL)
	}
	if s.state.PasswordEntry != nil {
		s.state.PasswordEntry.SetText(body.Password)
	}

	if s.state.DoConnect != nil {
		go func() {
			// Brief pause to let the widget updates settle.
			time.Sleep(50 * time.Millisecond)
			s.state.DoConnect()
		}()
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"state": "connecting",
		"url":   rawURL,
	})
}
