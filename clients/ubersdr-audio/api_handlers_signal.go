package main

// api_handlers_signal.go — handlers for signal quality endpoints:
//   GET /api/v1/signal
//   GET /api/v1/signal/stream  (SSE — handled directly by SSEBroker.ServeHTTP)

import (
	"net/http"
)

func (s *APIServer) handleSignal(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	bb, nd, snr, audio, updatedAt := s.state.SignalSnapshot()

	writeJSON(w, http.StatusOK, map[string]any{
		"baseband_dbfs":      bb,
		"noise_density_dbfs": nd,
		"snr_db":             snr,
		"audio_dbfs":         audio,
		"updated_at":         updatedAt,
	})
}
