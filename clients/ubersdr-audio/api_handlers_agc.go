package main

// api_handlers_agc.go — handlers for AGC endpoints:
//   GET /api/v1/agc
//   PUT /api/v1/agc

import (
	"fmt"
	"net/http"
)

func (s *APIServer) handleAGC(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getAGC(w, r)
	case http.MethodPut:
		s.putAGC(w, r)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut)
	}
}

func (s *APIServer) getAGC(w http.ResponseWriter, _ *http.Request) {
	s.state.Mu.RLock()
	hang := s.state.AGCHangTime
	rec := s.state.AGCRecoveryRate
	s.state.Mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"hang_time_s":        hang,
		"recovery_rate_db_s": rec,
	})
}

func (s *APIServer) putAGC(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HangTime     *float64 `json:"hang_time_s"`
		RecoveryRate *float64 `json:"recovery_rate_db_s"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	// AGC only applies in USB/LSB modes.
	s.state.Mu.RLock()
	mode := s.state.CurrentMode
	hang := s.state.AGCHangTime
	rec := s.state.AGCRecoveryRate
	s.state.Mu.RUnlock()

	if mode != "usb" && mode != "lsb" {
		apiConflict(w, "mode",
			fmt.Sprintf("AGC parameters only apply in usb/lsb mode; current mode is %q", mode))
		return
	}

	if body.HangTime != nil {
		if *body.HangTime < 0.0 || *body.HangTime > 10.0 {
			apiFieldError(w, "hang_time_s", *body.HangTime, "0.0–10.0 seconds")
			return
		}
		hang = *body.HangTime
	}

	if body.RecoveryRate != nil {
		if *body.RecoveryRate < 1.0 || *body.RecoveryRate > 100.0 {
			apiFieldError(w, "recovery_rate_db_s", *body.RecoveryRate, "1.0–100.0 dB/s")
			return
		}
		rec = *body.RecoveryRate
	}

	// Apply to state.
	s.state.Mu.Lock()
	s.state.AGCHangTime = hang
	s.state.AGCRecoveryRate = rec
	s.state.Mu.Unlock()

	// Update Fyne widgets.
	if s.state.AGCHangSlider != nil {
		s.state.AGCHangSlider.SetValue(hang)
	}
	if s.state.AGCHangLabel != nil {
		s.state.AGCHangLabel.SetText(fmt.Sprintf("%.1f s", hang))
	}
	if s.state.AGCRecSlider != nil {
		s.state.AGCRecSlider.SetValue(rec)
	}
	if s.state.AGCRecLabel != nil {
		s.state.AGCRecLabel.SetText(fmt.Sprintf("%.0f dB/s", rec))
	}

	// Send to server if connected.
	if s.client.State() == StateConnected {
		ht := float32(hang)
		rr := float32(rec)
		_ = s.client.SendSetAGC(&ht, &rr)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"hang_time_s":        hang,
		"recovery_rate_db_s": rec,
	})
}
