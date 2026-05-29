package main

// api_handlers_dsp.go — handlers for DSP noise reduction endpoints:
//   GET   /api/v1/dsp
//   PUT   /api/v1/dsp
//   PATCH /api/v1/dsp/params
//   GET   /api/v1/dsp/filters

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

func (s *APIServer) handleDSP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getDSP(w, r)
	case http.MethodPut:
		s.putDSP(w, r)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodPut)
	}
}

func (s *APIServer) getDSP(w http.ResponseWriter, _ *http.Request) {
	s.state.Mu.RLock()
	avail := s.state.DSPAvailable
	enabled := s.state.DSPEnabled
	filter := s.state.DSPFilter
	filters := make([]string, 0, len(s.state.DSPFilters))
	for _, f := range s.state.DSPFilters {
		filters = append(filters, f.Name)
	}
	s.state.Mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"available": avail,
		"enabled":   enabled,
		"filter":    filter,
		"filters":   filters,
	})
}

func (s *APIServer) putDSP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled bool           `json:"enabled"`
		Filter  string         `json:"filter"`
		Params  map[string]any `json:"params"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	s.state.Mu.RLock()
	avail := s.state.DSPAvailable
	dspFilters := s.state.DSPFilters
	s.state.Mu.RUnlock()

	if !avail {
		apiError(w, http.StatusServiceUnavailable, "DSP not available on this instance")
		return
	}

	if body.Enabled {
		if body.Filter == "" {
			apiFieldError(w, "filter", "", "filter name is required when enabled=true")
			return
		}
		// Validate filter name.
		var filterMeta *DSPFilter
		for i := range dspFilters {
			if dspFilters[i].Name == body.Filter {
				filterMeta = &dspFilters[i]
				break
			}
		}
		if filterMeta == nil {
			// Build list of known names for the error message.
			names := make([]string, 0, len(dspFilters))
			for _, f := range dspFilters {
				names = append(names, f.Name)
			}
			apiFieldError(w, "filter", body.Filter,
				fmt.Sprintf("must be one of: %s", strings.Join(names, ", ")))
			return
		}
		// Validate params if provided.
		if body.Params != nil {
			if err := validateDSPParams(filterMeta, body.Params, true); err != nil {
				apiError(w, http.StatusUnprocessableEntity, err.Error())
				return
			}
		}
	}

	// Apply.
	s.state.Mu.Lock()
	s.state.DSPEnabled = body.Enabled
	if body.Enabled {
		s.state.DSPFilter = body.Filter
		if body.Params != nil {
			for k, v := range body.Params {
				s.state.DSPParams[k] = fmt.Sprintf("%v", v)
			}
		}
	}
	filter := s.state.DSPFilter
	enabled := s.state.DSPEnabled
	s.state.Mu.Unlock()

	// Update Fyne widgets.
	if s.state.DSPEnableCheck != nil {
		s.state.DSPEnableCheck.SetChecked(body.Enabled)
	}
	if body.Enabled && s.state.DSPFilterSel != nil {
		s.state.DSPFilterSel.SetSelected(body.Filter)
	}

	// Send to server.
	if s.client.State() == StateConnected {
		var params map[string]interface{}
		if body.Params != nil {
			params = body.Params
		}
		_ = s.client.SendSetDSP(body.Enabled, body.Filter, params)
	}

	s.state.Mu.RLock()
	filters := make([]string, 0, len(s.state.DSPFilters))
	for _, f := range s.state.DSPFilters {
		filters = append(filters, f.Name)
	}
	s.state.Mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"available": avail,
		"enabled":   enabled,
		"filter":    filter,
		"filters":   filters,
	})
}

func (s *APIServer) handleDSPParams(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPatch) {
		return
	}

	var params map[string]any
	if !decodeBody(w, r, &params) {
		return
	}

	s.state.Mu.RLock()
	avail := s.state.DSPAvailable
	enabled := s.state.DSPEnabled
	activeFilter := s.state.DSPFilter
	dspFilters := s.state.DSPFilters
	s.state.Mu.RUnlock()

	if !avail {
		apiError(w, http.StatusServiceUnavailable, "DSP not available on this instance")
		return
	}
	if !enabled {
		apiError(w, http.StatusServiceUnavailable, "DSP insert is not currently enabled")
		return
	}

	// Find active filter metadata.
	var filterMeta *DSPFilter
	for i := range dspFilters {
		if dspFilters[i].Name == activeFilter {
			filterMeta = &dspFilters[i]
			break
		}
	}

	if filterMeta != nil {
		if err := validateDSPParams(filterMeta, params, false); err != nil {
			apiError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
	}

	// Apply to state.
	s.state.Mu.Lock()
	for k, v := range params {
		s.state.DSPParams[k] = fmt.Sprintf("%v", v)
	}
	s.state.Mu.Unlock()

	// Send to server.
	if s.client.State() == StateConnected {
		_ = s.client.SendSetDSPParams(params)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *APIServer) handleDSPFilters(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	s.state.Mu.RLock()
	avail := s.state.DSPAvailable
	dspFilters := s.state.DSPFilters
	s.state.Mu.RUnlock()

	if !avail {
		apiError(w, http.StatusServiceUnavailable, "DSP not available on this instance")
		return
	}

	// If we don't have filter metadata yet, request it from the server.
	if len(dspFilters) == 0 && s.client.State() == StateConnected {
		_ = s.client.SendGetDSPFilters()
	}

	type paramJSON struct {
		Name        string `json:"name"`
		Type        string `json:"type"`
		Default     string `json:"default"`
		Min         string `json:"min,omitempty"`
		Max         string `json:"max,omitempty"`
		Description string `json:"description,omitempty"`
		RuntimeSafe bool   `json:"runtime_safe"`
	}
	type filterJSON struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		Params      []paramJSON `json:"params"`
	}

	out := make([]filterJSON, len(dspFilters))
	for i, f := range dspFilters {
		params := make([]paramJSON, len(f.Params))
		for j, p := range f.Params {
			params[j] = paramJSON{
				Name:        p.Name,
				Type:        p.Type,
				Default:     p.Default,
				Min:         p.Min,
				Max:         p.Max,
				Description: p.Description,
				RuntimeSafe: p.RuntimeSafe,
			}
		}
		out[i] = filterJSON{
			Name:        f.Name,
			Description: f.Description,
			Params:      params,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"available": avail,
		"filters":   out,
	})
}

// validateDSPParams validates a params map against a filter's parameter metadata.
// If initOnly is false, only runtime_safe parameters are accepted.
func validateDSPParams(filter *DSPFilter, params map[string]any, initOnly bool) error {
	// Build a lookup of known params.
	known := make(map[string]DSPFilterInfo, len(filter.Params))
	for _, p := range filter.Params {
		known[p.Name] = p
	}

	for key, val := range params {
		pi, ok := known[key]
		if !ok {
			return fmt.Errorf("unknown parameter %q for filter %q", key, filter.Name)
		}
		if !initOnly && !pi.RuntimeSafe {
			return fmt.Errorf("parameter %q is init-only and cannot be changed mid-stream", key)
		}

		valStr := fmt.Sprintf("%v", val)

		switch pi.Type {
		case "float", "int":
			f, err := strconv.ParseFloat(valStr, 64)
			if err != nil {
				return fmt.Errorf("parameter %q: expected number, got %q", key, valStr)
			}
			if pi.Min != "" {
				minF, _ := strconv.ParseFloat(pi.Min, 64)
				if f < minF {
					return fmt.Errorf("parameter %q: value %.4g is below minimum %s", key, f, pi.Min)
				}
			}
			if pi.Max != "" {
				maxF, _ := strconv.ParseFloat(pi.Max, 64)
				if f > maxF {
					return fmt.Errorf("parameter %q: value %.4g exceeds maximum %s", key, f, pi.Max)
				}
			}
		case "bool":
			lower := strings.ToLower(valStr)
			if lower != "true" && lower != "false" && lower != "1" && lower != "0" {
				return fmt.Errorf("parameter %q: expected bool (true/false/1/0), got %q", key, valStr)
			}
			// "string" and unknown types: pass through
		}
	}
	return nil
}
