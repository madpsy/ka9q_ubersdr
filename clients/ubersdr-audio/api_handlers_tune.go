package main

// api_handlers_tune.go — handlers for tuning endpoints:
//   GET /api/v1/tune
//   PUT /api/v1/tune

import (
	"fmt"
	"net/http"
	"strings"
)

func (s *APIServer) handleTune(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getTune(w, r)
	case http.MethodPut:
		s.putTune(w, r)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut)
	}
}

func (s *APIServer) getTune(w http.ResponseWriter, _ *http.Request) {
	s.state.Mu.RLock()
	freq := s.state.CurrentFreq
	mode := s.state.CurrentMode
	bw := s.state.CurrentBW
	stepIdx := s.state.StepIndex
	s.state.Mu.RUnlock()

	bwLow, bwHigh := bwToLoHi(mode, bw)
	stepHz := 0
	if stepIdx >= 0 && stepIdx < len(freqSteps) {
		stepHz = freqSteps[stepIdx]
	}

	allowedIQ := s.client.AllowedIQModes()
	if allowedIQ == nil {
		allowedIQ = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"frequency_hz":     freq,
		"mode":             mode,
		"bandwidth_low":    bwLow,
		"bandwidth_high":   bwHigh,
		"bandwidth_hz":     bw,
		"step_hz":          stepHz,
		"allowed_iq_modes": allowedIQ,
	})
}

func (s *APIServer) putTune(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FrequencyHz   *int     `json:"frequency_hz"`
		Mode          *string  `json:"mode"`
		BandwidthHz   *float64 `json:"bandwidth_hz"`
		BandwidthLow  *int     `json:"bandwidth_low"`
		BandwidthHigh *int     `json:"bandwidth_high"`
		StepHz        *int     `json:"step_hz"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	s.state.Mu.Lock()
	currentMode := s.state.CurrentMode
	currentFreq := s.state.CurrentFreq
	currentBW := s.state.CurrentBW
	currentStepIdx := s.state.StepIndex
	s.state.Mu.Unlock()

	// ── Validate and apply mode ───────────────────────────────────────────────
	if body.Mode != nil {
		newMode := strings.ToLower(*body.Mode)
		if !isValidMode(newMode) {
			apiFieldError(w, "mode", *body.Mode,
				"must be one of: usb, lsb, am, sam, fm, cwu, cwl, iq, iq48, iq96, iq192, iq384")
			return
		}
		if isWideIQMode(newMode) {
			allowed := s.client.AllowedIQModes()
			permitted := false
			for _, m := range allowed {
				if strings.ToLower(m) == newMode {
					permitted = true
					break
				}
			}
			if !permitted {
				apiConflict(w, "mode",
					fmt.Sprintf("wide IQ mode %q not permitted by the connected server", newMode))
				return
			}
		}
		currentMode = newMode
	}

	// ── Validate and apply bandwidth ──────────────────────────────────────────
	if body.BandwidthHz != nil {
		if isWideIQMode(currentMode) {
			apiFieldError(w, "bandwidth_hz", *body.BandwidthHz,
				fmt.Sprintf("bandwidth_hz cannot be set for wide IQ mode %q (server uses preset)", currentMode))
			return
		}
		maxBW := bwSliderMax(currentMode)
		if *body.BandwidthHz < 0 || *body.BandwidthHz > maxBW {
			apiFieldError(w, "bandwidth_hz", *body.BandwidthHz,
				fmt.Sprintf("0–%.0f Hz for mode %q", maxBW, currentMode))
			return
		}
		currentBW = *body.BandwidthHz
	}

	// ── Validate and apply frequency ──────────────────────────────────────────
	if body.FrequencyHz != nil {
		currentFreq = clampFreq(*body.FrequencyHz)
	}

	// ── Validate and apply step ───────────────────────────────────────────────
	if body.StepHz != nil {
		idx := -1
		for i, s := range freqSteps {
			if s == *body.StepHz {
				idx = i
				break
			}
		}
		if idx < 0 {
			apiFieldError(w, "step_hz", *body.StepHz,
				"must be one of: 1, 10, 100, 500, 1000, 10000, 100000, 1000000")
			return
		}
		currentStepIdx = idx
	}

	// ── Apply to state and widgets ────────────────────────────────────────────
	// Compute the effective lo/hi now (before the direct override below) so we
	// can persist the override values back into state for the response.
	bwLow, bwHigh := bwToLoHi(currentMode, currentBW)
	if body.BandwidthLow != nil && body.BandwidthHz == nil {
		bwLow = *body.BandwidthLow
	}
	if body.BandwidthHigh != nil && body.BandwidthHz == nil {
		bwHigh = *body.BandwidthHigh
	}

	s.state.Mu.Lock()
	s.state.CurrentFreq = currentFreq
	s.state.CurrentMode = currentMode
	s.state.CurrentBW = currentBW
	s.state.StepIndex = currentStepIdx
	s.state.Mu.Unlock()

	// Suppress the sendTune feedback loop while we update Fyne widgets.
	// The OnChanged callbacks on modeSelect, bwSlider, etc. call sendTune()
	// which would overwrite AppState with the old local variable values.
	// We set SuppressTune=true so sendTune() is a no-op during widget updates.
	if s.state.SuppressTune != nil {
		*s.state.SuppressTune = true
	}

	// Update Fyne widgets (goroutine-safe).
	if s.state.FreqEntry != nil {
		s.state.FreqEntry.SetText(formatFreqKHz(currentFreq))
	}
	if body.Mode != nil && s.state.ModeSelect != nil {
		for _, lbl := range s.state.ModeSelect.Options {
			if modeKey(lbl) == currentMode {
				s.state.ModeSelect.SetSelected(lbl)
				break
			}
		}
	}
	if body.BandwidthHz != nil {
		if s.state.BWSlider != nil {
			s.state.BWSlider.SetValue(currentBW)
		}
		if s.state.BWValueLabel != nil {
			s.state.BWValueLabel.SetText(fmt.Sprintf("%.0f Hz", currentBW))
		}
	}
	if body.StepHz != nil && s.state.StepSelect != nil {
		s.state.StepSelect.SetSelectedIndex(currentStepIdx)
	}

	// Re-enable sendTune now that widgets are in sync.
	if s.state.SuppressTune != nil {
		*s.state.SuppressTune = false
	}

	// Send tune to server if connected.
	if s.client.State() == StateConnected {
		prevMode := s.client.Mode // capture before updating
		s.client.Frequency = currentFreq
		s.client.Mode = currentMode
		s.client.BandwidthLow = bwLow
		s.client.BandwidthHigh = bwHigh
		if isWideIQMode(currentMode) {
			s.client.BandwidthLow = 0
			s.client.BandwidthHigh = 0
		}
		// Switching to or from any IQ mode changes the sample rate and requires
		// a full WebSocket reconnect (same as the GUI's modeSelect.OnChanged).
		if body.Mode != nil && currentMode != prevMode &&
			(isIQMode(currentMode) || isIQMode(prevMode)) {
			s.client.ReconnectWS()
		} else {
			_ = s.client.Tune(currentFreq, currentMode, s.client.BandwidthLow, s.client.BandwidthHigh)
		}
		// Push SDR→rig (debounced; no-op if flrig disabled or direction is rig-to-sdr).
		s.flrig.PushSDRState(currentFreq, currentMode)
	}

	stepHz := 0
	if currentStepIdx >= 0 && currentStepIdx < len(freqSteps) {
		stepHz = freqSteps[currentStepIdx]
	}
	allowedIQ := s.client.AllowedIQModes()
	if allowedIQ == nil {
		allowedIQ = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"frequency_hz":     currentFreq,
		"mode":             currentMode,
		"bandwidth_low":    bwLow,
		"bandwidth_high":   bwHigh,
		"bandwidth_hz":     currentBW,
		"step_hz":          stepHz,
		"allowed_iq_modes": allowedIQ,
	})
}

// isValidMode returns true if mode is a known SDR mode string.
func isValidMode(mode string) bool {
	switch mode {
	case "usb", "lsb", "am", "sam", "fm", "cwu", "cwl",
		"iq", "iq48", "iq96", "iq192", "iq384":
		return true
	}
	return false
}
