package main

// api_handlers_audio.go — handlers for audio endpoints:
//   GET /api/v1/audio
//   PUT /api/v1/audio
//   GET /api/v1/audio/devices

import (
	"fmt"
	"net/http"
	"time"

	"fyne.io/fyne/v2/theme"
)

func (s *APIServer) handleAudio(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getAudio(w, r)
	case http.MethodPut:
		s.putAudio(w, r)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut)
	}
}

func (s *APIServer) getAudio(w http.ResponseWriter, _ *http.Request) {
	s.state.Mu.RLock()
	vol := s.state.Volume
	muted := s.state.Muted
	channel := s.state.ChannelMode
	format := s.state.Format
	devID := s.state.DeviceID
	s.state.Mu.RUnlock()

	devName := "Default Device"
	audioDeviceMu.RLock()
	for _, d := range audioDeviceList {
		if d.ID == devID {
			devName = d.Name
			break
		}
	}
	audioDeviceMu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"volume":      vol,
		"muted":       muted,
		"channel":     channel,
		"format":      format,
		"device_id":   devID,
		"device_name": devName,
	})
}

func (s *APIServer) putAudio(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Volume   *float64 `json:"volume"`
		Muted    *bool    `json:"muted"`
		Channel  *string  `json:"channel"`
		Format   *string  `json:"format"`
		DeviceID *string  `json:"device_id"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	s.state.Mu.Lock()
	vol := s.state.Volume
	muted := s.state.Muted
	premuteVol := s.state.PremuteVol
	channel := s.state.ChannelMode
	format := s.state.Format
	devID := s.state.DeviceID
	currentMode := s.state.CurrentMode
	s.state.Mu.Unlock()

	// ── Volume ────────────────────────────────────────────────────────────────
	if body.Volume != nil {
		v := *body.Volume
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		vol = v
		premuteVol = v
	}

	// ── Mute ──────────────────────────────────────────────────────────────────
	if body.Muted != nil {
		muted = *body.Muted
	}

	// ── Channel ───────────────────────────────────────────────────────────────
	if body.Channel != nil {
		switch *body.Channel {
		case "both", "left", "right":
			channel = *body.Channel
		default:
			apiFieldError(w, "channel", *body.Channel, `"both", "left", or "right"`)
			return
		}
	}

	// ── Format ────────────────────────────────────────────────────────────────
	formatChanged := false
	if body.Format != nil {
		switch *body.Format {
		case "opus", "pcm-zstd":
			// opus is not allowed in IQ modes.
			if *body.Format == "opus" && isIQMode(currentMode) {
				apiConflict(w, "format",
					fmt.Sprintf("format %q not allowed in IQ mode %q; IQ requires pcm-zstd", *body.Format, currentMode))
				return
			}
			if *body.Format != format {
				format = *body.Format
				formatChanged = true
			}
		default:
			apiFieldError(w, "format", *body.Format, `"opus" or "pcm-zstd"`)
			return
		}
	}

	// ── Device ────────────────────────────────────────────────────────────────
	if body.DeviceID != nil {
		newID := *body.DeviceID
		// Validate: must be "" or a known device ID.
		if newID != "" {
			found := false
			audioDeviceMu.RLock()
			for _, d := range audioDeviceList {
				if d.ID == newID {
					found = true
					break
				}
			}
			audioDeviceMu.RUnlock()
			if !found {
				apiFieldError(w, "device_id", newID, "must be a valid device ID from /audio/devices, or empty string for default")
				return
			}
		}
		devID = newID
	}

	// ── Apply to state ────────────────────────────────────────────────────────
	s.state.Mu.Lock()
	s.state.Volume = vol
	s.state.Muted = muted
	s.state.PremuteVol = premuteVol
	s.state.ChannelMode = channel
	s.state.Format = format
	s.state.DeviceID = devID
	s.state.Mu.Unlock()

	// ── Apply to client ───────────────────────────────────────────────────────
	if muted {
		s.client.SetVolume(0)
	} else {
		s.client.SetVolume(vol / 100.0)
	}

	switch channel {
	case "left":
		s.client.SetChannelMode(ChannelModeLeft)
	case "right":
		s.client.SetChannelMode(ChannelModeRight)
	default:
		s.client.SetChannelMode(ChannelModeBoth)
	}

	if body.DeviceID != nil {
		s.client.SetDevice(devID)
	}

	if formatChanged {
		if format == "pcm-zstd" {
			s.client.Format = FormatPCMZstd
		} else {
			s.client.Format = FormatOpus
		}
		// Trigger reconnect if connected (same as GUI).
		if s.client.State() == StateConnected {
			s.client.Disconnect()
			go func() {
				time.Sleep(300 * time.Millisecond)
				s.client.Connect()
			}()
		}
	}

	// ── Update Fyne widgets ───────────────────────────────────────────────────
	if body.Volume != nil && s.state.VolumeSlider != nil {
		s.state.VolumeSlider.SetValue(vol)
	}
	if body.Muted != nil && s.state.MuteBtn != nil {
		if muted {
			s.state.MuteBtn.SetIcon(theme.VolumeMuteIcon())
			if s.state.VolumeSlider != nil {
				s.state.VolumeSlider.Disable()
			}
		} else {
			s.state.MuteBtn.SetIcon(theme.VolumeUpIcon())
			if s.state.VolumeSlider != nil {
				s.state.VolumeSlider.Enable()
			}
		}
	}
	if body.Channel != nil && s.state.ChannelSelect != nil {
		switch channel {
		case "left":
			s.state.ChannelSelect.SetSelected("Left")
		case "right":
			s.state.ChannelSelect.SetSelected("Right")
		default:
			s.state.ChannelSelect.SetSelected("Left & Right")
		}
	}
	if body.Format != nil && s.state.FormatGroup != nil {
		// Suppress the formatGroup.OnChanged feedback loop while we
		// programmatically set the selection from the API handler.
		if s.state.SuppressFormatChange != nil {
			*s.state.SuppressFormatChange = true
		}
		if format == "pcm-zstd" {
			s.state.FormatGroup.SetSelected("Uncompressed")
		} else {
			s.state.FormatGroup.SetSelected("Compressed")
		}
		if s.state.SuppressFormatChange != nil {
			*s.state.SuppressFormatChange = false
		}
	}
	if body.DeviceID != nil && s.state.DeviceSelect != nil {
		audioDeviceMu.RLock()
		for i, d := range audioDeviceList {
			if d.ID == devID {
				s.state.DeviceSelect.SetSelectedIndex(i)
				break
			}
		}
		audioDeviceMu.RUnlock()
	}

	// Build response.
	devName := "Default Device"
	audioDeviceMu.RLock()
	for _, d := range audioDeviceList {
		if d.ID == devID {
			devName = d.Name
			break
		}
	}
	audioDeviceMu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"volume":      vol,
		"muted":       muted,
		"channel":     channel,
		"format":      format,
		"device_id":   devID,
		"device_name": devName,
	})
}

// handleAudioGate handles GET/PUT /api/v1/audio/gate.
//
// GET  → returns {"min_snr": <float32>}  (-999 = disabled)
// PUT  → body {"min_snr": <float32>}     (-999 to +999; -999 = disable)
//
// On PUT the value is stored in AppState and forwarded to the upstream ubersdr
// server via set_audio_gate over the RadioClient WebSocket.
func (s *APIServer) handleAudioGate(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.state.Mu.RLock()
		minSNR := s.state.AudioGateMinSNR
		s.state.Mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"min_snr": minSNR})

	case http.MethodPut:
		var body struct {
			MinSNR *float32 `json:"min_snr"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		if body.MinSNR == nil {
			apiError(w, http.StatusBadRequest, "min_snr is required")
			return
		}
		v := *body.MinSNR
		if v < -999 || v > 999 {
			apiFieldError(w, "min_snr", v, "-999 to +999 (-999 = disabled)")
			return
		}
		s.state.Mu.Lock()
		s.state.AudioGateMinSNR = v
		sl := s.state.SNRSquelchSlider
		s.state.Mu.Unlock()

		// Update the Fyne slider widget so the GUI stays in sync with the web UI.
		if sl != nil {
			sl.SetValue(float64(v))
		}

		// Forward to upstream ubersdr server if connected.
		if s.client.State() == StateConnected {
			if err := s.client.SendSetAudioGate(&v); err != nil {
				// Non-fatal: state is stored, will be applied on next connect.
				_ = err
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"min_snr": v})

	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut)
	}
}

func (s *APIServer) handleAudioDevices(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	devices, err := EnumerateAudioDevices()
	if err != nil || len(devices) == 0 {
		devices = []AudioDevice{{ID: "", Name: "Default Device"}}
	}

	// Update the shared cache so that PUT /audio device_id validation uses the
	// same list that was just returned to the caller.
	audioDeviceMu.Lock()
	audioDeviceList = devices
	audioDeviceMu.Unlock()

	type devJSON struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := make([]devJSON, len(devices))
	for i, d := range devices {
		out[i] = devJSON{ID: d.ID, Name: d.Name}
	}

	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}
