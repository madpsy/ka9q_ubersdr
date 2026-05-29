package main

// api_handlers_instance.go — handler for the connected instance description endpoint:
//   GET /api/v1/instance

import (
	"net/http"
)

// handleInstance serves GET /api/v1/instance.
// It fetches the full /api/description from the currently connected instance
// and returns it as JSON.  Returns 503 when not connected.
func (s *APIServer) handleInstance(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	if s.client.State() != StateConnected {
		apiError(w, http.StatusServiceUnavailable, "not connected to an instance")
		return
	}

	desc, err := s.client.FetchDescription()
	if err != nil {
		apiError(w, http.StatusServiceUnavailable, "failed to fetch instance description: "+err.Error())
		return
	}

	dspFilters := desc.DSP.Filters
	if dspFilters == nil {
		dspFilters = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"url":               s.client.BaseURL,
		"name":              desc.Receiver.Name,
		"callsign":          desc.Receiver.Callsign,
		"location":          desc.Receiver.Location,
		"default_frequency": desc.DefaultFrequency,
		"default_mode":      desc.DefaultMode,
		"max_session_time":  desc.MaxSessionTime,
		"max_clients":       desc.MaxClients,
		"dsp": map[string]any{
			"available": desc.DSP.Enabled,
			"filters":   dspFilters,
		},
		"allowed_iq_modes": func() []string {
			m := s.client.AllowedIQModes()
			if m == nil {
				return []string{}
			}
			return m
		}(),
	})
}
