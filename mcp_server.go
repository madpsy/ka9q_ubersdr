package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// MCPServer handles Model Context Protocol requests
type MCPServer struct {
	sessions            *SessionManager
	spaceWeatherMonitor *SpaceWeatherMonitor
	noiseFloorMonitor   *NoiseFloorMonitor
	multiDecoder        *MultiDecoder
	config              *Config
	ipBanManager        *IPBanManager
}

// MCPRequest represents an incoming MCP request
type MCPRequest struct {
	Method string                 `json:"method"`
	Params map[string]interface{} `json:"params"`
	ID     interface{}            `json:"id,omitempty"`
}

// MCPResponse represents an MCP response
type MCPResponse struct {
	Result interface{} `json:"result,omitempty"`
	Error  *MCPError   `json:"error,omitempty"`
	ID     interface{} `json:"id,omitempty"`
}

// MCPError represents an error in MCP format
type MCPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// NewMCPServer creates a new MCP server instance
func NewMCPServer(sessions *SessionManager, swm *SpaceWeatherMonitor,
	nfm *NoiseFloorMonitor, md *MultiDecoder, cfg *Config, ipBanManager *IPBanManager) *MCPServer {
	return &MCPServer{
		sessions:            sessions,
		spaceWeatherMonitor: swm,
		noiseFloorMonitor:   nfm,
		multiDecoder:        md,
		config:              cfg,
		ipBanManager:        ipBanManager,
	}
}

// HandleMCP handles MCP protocol requests over HTTP
func (m *MCPServer) HandleMCP(w http.ResponseWriter, r *http.Request) {
	// Check if IP is banned
	if checkIPBan(w, r, m.ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Only accept POST requests
	if r.Method != http.MethodPost {
		m.sendError(w, -32601, "Method not allowed, use POST", nil)
		return
	}

	// Parse request
	var req MCPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		m.sendError(w, -32700, "Parse error: "+err.Error(), nil)
		return
	}

	// Handle the tool call
	result, err := m.handleToolCall(r, req.Method, req.Params)
	if err != nil {
		m.sendError(w, -32603, err.Error(), req.ID)
		return
	}

	// Send success response
	response := MCPResponse{
		Result: result,
		ID:     req.ID,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding MCP response: %v", err)
	}
}

// handleToolCall executes the requested tool
func (m *MCPServer) handleToolCall(r *http.Request, method string, params map[string]interface{}) (interface{}, error) {
	switch method {
	case "get_space_weather":
		return m.getSpaceWeather()

	case "get_noise_floor":
		band, _ := params["band"].(string)
		return m.getNoiseFloor(band)

	case "get_decoder_spots":
		mode, _ := params["mode"].(string)
		hoursFloat, _ := params["hours"].(float64)
		hours := int(hoursFloat)
		if hours == 0 {
			hours = 1 // Default to 1 hour
		}
		return m.getDecoderSpots(mode, hours)

	case "get_decoder_analytics":
		country, _ := params["country"].(string)
		continent, _ := params["continent"].(string)
		mode, _ := params["mode"].(string)
		band, _ := params["band"].(string)
		minSNRFloat, _ := params["min_snr"].(float64)
		minSNR := int(minSNRFloat)
		if minSNR == 0 {
			minSNR = -999 // Default to no filter
		}
		hoursFloat, _ := params["hours"].(float64)
		hours := int(hoursFloat)
		if hours == 0 {
			hours = 24 // Default to 24 hours
		}
		return m.getDecoderAnalytics(country, continent, mode, band, minSNR, hours)

	case "get_decoder_analytics_hourly":
		country, _ := params["country"].(string)
		continent, _ := params["continent"].(string)
		mode, _ := params["mode"].(string)
		band, _ := params["band"].(string)
		minSNRFloat, _ := params["min_snr"].(float64)
		minSNR := int(minSNRFloat)
		if minSNR == 0 {
			minSNR = -999 // Default to no filter
		}
		hoursFloat, _ := params["hours"].(float64)
		hours := int(hoursFloat)
		if hours == 0 {
			hours = 24 // Default to 24 hours
		}
		return m.getDecoderAnalyticsHourly(country, continent, mode, band, minSNR, hours)

	case "get_active_sessions":
		return m.getActiveSessions()

	case "get_band_conditions":
		return m.getBandConditions()

	case "list_tools":
		return m.listTools(), nil

	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}

// getSpaceWeather returns current space weather data
func (m *MCPServer) getSpaceWeather() (interface{}, error) {
	if m.spaceWeatherMonitor == nil || !m.spaceWeatherMonitor.config.Enabled {
		return nil, fmt.Errorf("space weather monitoring is not enabled")
	}

	data := m.spaceWeatherMonitor.GetData()
	if data.LastUpdate.IsZero() {
		return nil, fmt.Errorf("space weather data not yet available")
	}

	return data, nil
}

// getNoiseFloor returns noise floor measurements
func (m *MCPServer) getNoiseFloor(band string) (interface{}, error) {
	if m.noiseFloorMonitor == nil {
		return nil, fmt.Errorf("noise floor monitoring is not enabled")
	}

	if band == "" {
		// Return all bands
		measurements := m.noiseFloorMonitor.GetLatestMeasurements()
		if len(measurements) == 0 {
			return nil, fmt.Errorf("no measurements available yet")
		}
		return measurements, nil
	}

	// Return specific band FFT
	fft := m.noiseFloorMonitor.GetLatestFFT(band)
	if fft == nil {
		return nil, fmt.Errorf("no FFT data available for band %s", band)
	}
	return fft, nil
}

// getDecoderSpots returns recent decoder spots
func (m *MCPServer) getDecoderSpots(mode string, hours int) (interface{}, error) {
	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return nil, fmt.Errorf("decoder spots logging is not enabled")
	}

	// Calculate time range
	toTime := time.Now().UTC()
	fromTime := toTime.Add(-time.Duration(hours) * time.Hour)

	// Get spots from the last N hours
	fromDate := fromTime.Format("2006-01-02")
	toDate := toTime.Format("2006-01-02")
	startTime := fromTime.Format("15:04")
	endTime := toTime.Format("15:04")

	spots, err := m.multiDecoder.spotsLogger.GetHistoricalSpots(
		mode, "", "", "", "", "", "", // mode, band, name, callsign, locator, continent, direction
		fromDate, toDate, startTime, endTime,
		true,  // deduplicate
		true,  // locatorsOnly
		0,     // minDistanceKm
		-999,  // minSNR
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get spots: %v", err)
	}

	return map[string]interface{}{
		"spots": spots,
		"count": len(spots),
		"hours": hours,
		"mode":  mode,
	}, nil
}

// getActiveSessions returns list of active sessions
func (m *MCPServer) getActiveSessions() (interface{}, error) {
	m.sessions.mu.RLock()
	defer m.sessions.mu.RUnlock()

	sessions := make([]map[string]interface{}, 0)
	for _, session := range m.sessions.sessions {
		// Skip spectrum sessions and sessions without IP
		if !session.IsSpectrum && session.ClientIP != "" {
			session.mu.RLock()

			// Skip bypassed IPs
			isBypassed := m.sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP)
			if !isBypassed {
				sessionInfo := map[string]interface{}{
					"frequency":      session.Frequency,
					"mode":           session.Mode,
					"bandwidth":      session.Bandwidth,
					"bandwidth_low":  session.BandwidthLow,
					"bandwidth_high": session.BandwidthHigh,
					"created_at":     session.CreatedAt,
					"last_active":    session.LastActive,
					"country":        session.Country,
					"country_code":   session.CountryCode,
				}
				sessions = append(sessions, sessionInfo)
			}
			session.mu.RUnlock()
		}
	}

	return map[string]interface{}{
		"active_sessions": len(sessions),
		"sessions":        sessions,
	}, nil
}

// getBandConditions returns combined band conditions analysis
func (m *MCPServer) getBandConditions() (interface{}, error) {
	result := make(map[string]interface{})

	// Add space weather if available
	if m.spaceWeatherMonitor != nil && m.spaceWeatherMonitor.config.Enabled {
		data := m.spaceWeatherMonitor.GetData()
		if !data.LastUpdate.IsZero() {
			result["space_weather"] = map[string]interface{}{
				"sfi":         data.SolarFlux,
				"a_index":     data.AIndex,
				"k_index":     data.KIndex,
				"last_update": data.LastUpdate,
			}
		}
	}

	// Add noise floor summary if available
	if m.noiseFloorMonitor != nil {
		measurements := m.noiseFloorMonitor.GetLatestMeasurements()
		if len(measurements) > 0 {
			bandSummary := make(map[string]interface{})
			for _, meas := range measurements {
				bandSummary[meas.Band] = map[string]interface{}{
					"noise_floor_db": meas.P5DB,
					"median_db":      meas.MedianDB,
					"dynamic_range":  meas.DynamicRange,
					"occupancy":      meas.OccupancyPct,
					"ft8_snr":        meas.FT8SNR,
				}
			}
			result["noise_floor"] = bandSummary
		}
	}

	// Add decoder activity summary if available
	if m.multiDecoder != nil && m.multiDecoder.spotsLogger != nil {
		// Get last hour of activity
		toTime := time.Now().UTC()
		fromTime := toTime.Add(-1 * time.Hour)
		fromDate := fromTime.Format("2006-01-02")
		toDate := toTime.Format("2006-01-02")
		startTime := fromTime.Format("15:04")
		endTime := toTime.Format("15:04")

		spots, err := m.multiDecoder.spotsLogger.GetHistoricalSpots(
			"", "", "", "", "", "", "", // all modes, all bands
			fromDate, toDate, startTime, endTime,
			true, true, 0, -999,
		)
		if err == nil {
			// Count by mode
			modeCounts := make(map[string]int)
			for _, spot := range spots {
				modeCounts[spot.Mode]++
			}
			result["decoder_activity"] = map[string]interface{}{
				"last_hour_spots": len(spots),
				"by_mode":         modeCounts,
			}
		}
	}

	if len(result) == 0 {
		return nil, fmt.Errorf("no band condition data available")
	}

	return result, nil
}

// getDecoderAnalytics returns aggregated analytics about decoder spots
func (m *MCPServer) getDecoderAnalytics(country, continent, mode, band string, minSNR, hours int) (interface{}, error) {
	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return nil, fmt.Errorf("decoder spots logging is not enabled")
	}

	// Get analytics from the spots logger
	analytics, err := m.multiDecoder.spotsLogger.GetSpotsAnalytics(country, continent, mode, band, minSNR, hours)
	if err != nil {
		return nil, fmt.Errorf("failed to get analytics: %v", err)
	}

	return analytics, nil
}

// getDecoderAnalyticsHourly returns hourly aggregated analytics about decoder spots
func (m *MCPServer) getDecoderAnalyticsHourly(country, continent, mode, band string, minSNR, hours int) (interface{}, error) {
	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return nil, fmt.Errorf("decoder spots logging is not enabled")
	}

	// Get hourly analytics from the spots logger
	analytics, err := m.multiDecoder.spotsLogger.GetSpotsAnalyticsHourly(country, continent, mode, band, minSNR, hours)
	if err != nil {
		return nil, fmt.Errorf("failed to get hourly analytics: %v", err)
	}

	return analytics, nil
}

// listTools returns available MCP tools
func (m *MCPServer) listTools() interface{} {
	return map[string]interface{}{
		"tools": []map[string]interface{}{
			{
				"name":        "get_space_weather",
				"description": "Get current space weather conditions (SFI, A-index, K-index)",
				"parameters":  map[string]interface{}{},
			},
			{
				"name":        "get_noise_floor",
				"description": "Get noise floor measurements for amateur radio bands",
				"parameters": map[string]interface{}{
					"band": map[string]interface{}{
						"type":        "string",
						"description": "Band name (e.g., 20m, 40m, 80m) or empty for all bands",
						"optional":    true,
					},
				},
			},
			{
				"name":        "get_decoder_spots",
				"description": "Get recent digital mode spots (FT8, FT4, WSPR)",
				"parameters": map[string]interface{}{
					"mode": map[string]interface{}{
						"type":        "string",
						"description": "Mode filter (FT8, FT4, WSPR) or empty for all modes",
						"optional":    true,
					},
					"hours": map[string]interface{}{
						"type":        "number",
						"description": "Hours of history (default 1)",
						"optional":    true,
					},
				},
			},
			{
				"name":        "get_decoder_analytics",
				"description": "Get aggregated analytics about decoder spots by country/continent",
				"parameters": map[string]interface{}{
					"country": map[string]interface{}{
						"type":        "string",
						"description": "Country name filter or empty for all",
						"optional":    true,
					},
					"continent": map[string]interface{}{
						"type":        "string",
						"description": "Continent code (AF, AS, EU, NA, OC, SA, AN) or empty for all",
						"optional":    true,
					},
					"mode": map[string]interface{}{
						"type":        "string",
						"description": "Mode filter (FT8, FT4, WSPR) or empty for all",
						"optional":    true,
					},
					"band": map[string]interface{}{
						"type":        "string",
						"description": "Band filter (e.g., 20m, 40m) or empty for all",
						"optional":    true,
					},
					"min_snr": map[string]interface{}{
						"type":        "number",
						"description": "Minimum SNR in dB (default -999 = no filter)",
						"optional":    true,
					},
					"hours": map[string]interface{}{
						"type":        "number",
						"description": "Hours of history (default 24, max 48)",
						"optional":    true,
					},
				},
			},
			{
				"name":        "get_decoder_analytics_hourly",
				"description": "Get hourly aggregated analytics about decoder spots broken down by hour",
				"parameters": map[string]interface{}{
					"country": map[string]interface{}{
						"type":        "string",
						"description": "Country name filter or empty for all",
						"optional":    true,
					},
					"continent": map[string]interface{}{
						"type":        "string",
						"description": "Continent code (AF, AS, EU, NA, OC, SA, AN) or empty for all",
						"optional":    true,
					},
					"mode": map[string]interface{}{
						"type":        "string",
						"description": "Mode filter (FT8, FT4, WSPR) or empty for all",
						"optional":    true,
					},
					"band": map[string]interface{}{
						"type":        "string",
						"description": "Band filter (e.g., 20m, 40m) or empty for all",
						"optional":    true,
					},
					"min_snr": map[string]interface{}{
						"type":        "number",
						"description": "Minimum SNR in dB (default -999 = no filter)",
						"optional":    true,
					},
					"hours": map[string]interface{}{
						"type":        "number",
						"description": "Hours of history (default 24, max 48)",
						"optional":    true,
					},
				},
			},
			{
				"name":        "get_active_sessions",
				"description": "Get list of active radio sessions and frequencies in use",
				"parameters":  map[string]interface{}{},
			},
			{
				"name":        "get_band_conditions",
				"description": "Get combined band conditions analysis (space weather + noise floor + activity)",
				"parameters":  map[string]interface{}{},
			},
			{
				"name":        "list_tools",
				"description": "List all available MCP tools",
				"parameters":  map[string]interface{}{},
			},
		},
	}
}

// sendError sends an error response
func (m *MCPServer) sendError(w http.ResponseWriter, code int, message string, id interface{}) {
	response := MCPResponse{
		Error: &MCPError{
			Code:    code,
			Message: message,
		},
		ID: id,
	}

	w.WriteHeader(http.StatusOK) // MCP errors are sent with 200 OK
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding MCP error response: %v", err)
	}
}
