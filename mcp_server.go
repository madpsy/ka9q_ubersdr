package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// MCPServer handles Model Context Protocol requests
type MCPServer struct {
	sessions            *SessionManager
	spaceWeatherMonitor *SpaceWeatherMonitor
	noiseFloorMonitor   *NoiseFloorMonitor
	multiDecoder        *MultiDecoder
	config              *Config
	ipBanManager        *IPBanManager
	geoIPService        *GeoIPService
	dxClusterWsHandler  *DXClusterWebSocketHandler
	mcpServer           *server.MCPServer
	httpServer          *server.StreamableHTTPServer
}

// NewMCPServer creates a new MCP server instance
func NewMCPServer(sessions *SessionManager, swm *SpaceWeatherMonitor,
	nfm *NoiseFloorMonitor, md *MultiDecoder, cfg *Config, ipBanManager *IPBanManager,
	geoIPService *GeoIPService, dxClusterWsHandler *DXClusterWebSocketHandler) *MCPServer {

	m := &MCPServer{
		sessions:            sessions,
		spaceWeatherMonitor: swm,
		noiseFloorMonitor:   nfm,
		multiDecoder:        md,
		config:              cfg,
		ipBanManager:        ipBanManager,
		geoIPService:        geoIPService,
		dxClusterWsHandler:  dxClusterWsHandler,
	}

	// Create MCP server with server info
	m.mcpServer = server.NewMCPServer(
		"UberSDR",
		"1.0.0",
		server.WithToolCapabilities(true),
	)

	// Register all tools
	m.registerTools()

	// Create HTTP server wrapper
	m.httpServer = server.NewStreamableHTTPServer(m.mcpServer)

	return m
}

// registerTools registers all available MCP tools
func (m *MCPServer) registerTools() {
	// Tool: get_space_weather
	m.mcpServer.AddTool(
		mcp.NewTool("get_space_weather",
			mcp.WithDescription("Get current space weather conditions including Solar Flux Index (SFI), A-index, and K-index which affect HF radio propagation. Use this to understand current ionospheric conditions. Higher SFI (>150) = better HF propagation. Higher K-index (>5) = disturbed conditions and poor propagation."),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetSpaceWeather,
	)

	// Tool: get_noise_floor
	m.mcpServer.AddTool(
		mcp.NewTool("get_noise_floor",
			mcp.WithDescription("Get noise floor measurements for amateur radio bands, including dynamic range, occupancy, and estimated FT8 SNR. Use this to assess current band conditions and signal quality. Lower noise floor = better conditions. Higher estimated FT8 SNR = better decode capability."),
			mcp.WithString("band",
				mcp.Description("Specific band name (e.g., '20m', '40m', '80m') or leave empty for all bands"),
			),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetNoiseFloor,
	)

	// Tool: get_decoder_spots
	m.mcpServer.AddTool(
		mcp.NewTool("get_decoder_spots",
			mcp.WithDescription("Get recent individual digital mode spots (FT8, FT4, WSPR, JS8) decoded from the radio. Use this for RAW spot data with callsigns, locators, SNR, frequencies, and messages. For questions about specific callsigns, locators, or individual decodes, use this tool. For aggregated statistics by country/band/time, use get_decoder_analytics or get_decoder_analytics_hourly instead."),
			mcp.WithString("mode",
				mcp.Description("Mode filter: 'FT8', 'FT4', 'WSPR', 'JS8', or empty for all modes"),
			),
			mcp.WithNumber("hours",
				mcp.Description("Hours of history to retrieve (default: 1, max: 48)"),
				mcp.DefaultNumber(1.0),
			),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetDecoderSpots,
	)

	// Tool: get_decoder_analytics
	m.mcpServer.AddTool(
		mcp.NewTool("get_decoder_analytics",
			mcp.WithDescription("Get aggregated analytics about decoder spots by country, continent, mode, and band. Use this to answer questions about WHICH bands/countries have the most activity overall (e.g., 'which band is best for South Korea?'). Returns total spot counts, average SNR, and band distribution for each country."),
			mcp.WithString("country",
				mcp.Description("Country name filter (e.g., 'South Korea', 'Japan', 'United States', 'Germany') or empty for all countries"),
			),
			mcp.WithString("continent",
				mcp.Description("Continent code: 'AF' (Africa), 'AS' (Asia), 'EU' (Europe), 'NA' (North America), 'OC' (Oceania), 'SA' (South America), 'AN' (Antarctica), or empty for all"),
			),
			mcp.WithString("mode",
				mcp.Description("Mode filter: 'FT8', 'FT4', 'WSPR', or empty for all modes"),
			),
			mcp.WithString("band",
				mcp.Description("Band filter (e.g., '20m', '40m') or empty for all bands"),
			),
			mcp.WithNumber("min_snr",
				mcp.Description("Minimum SNR in dB (default: -999 = no filter)"),
				mcp.DefaultNumber(-999.0),
			),
			mcp.WithNumber("hours",
				mcp.Description("Hours of history (default: 24, max: 48)"),
				mcp.DefaultNumber(24.0),
			),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetDecoderAnalytics,
	)

	// Tool: get_decoder_analytics_hourly
	m.mcpServer.AddTool(
		mcp.NewTool("get_decoder_analytics_hourly",
			mcp.WithDescription("Get hourly aggregated analytics about decoder spots, broken down by hour for trend analysis. Use this to answer questions about WHEN specific countries/bands are most active (e.g., 'what time is South Korea most active on 20m?'). Returns spot counts and SNR data for each hour of the day, allowing you to identify peak propagation times."),
			mcp.WithString("country",
				mcp.Description("Country name filter (e.g., 'South Korea', 'Japan', 'United States') or empty for all countries"),
			),
			mcp.WithString("continent",
				mcp.Description("Continent code (AF, AS, EU, NA, OC, SA, AN) or empty for all"),
			),
			mcp.WithString("mode",
				mcp.Description("Mode filter: 'FT8', 'FT4', 'WSPR', or empty for all modes"),
			),
			mcp.WithString("band",
				mcp.Description("Band filter (e.g., '20m', '40m') or empty for all bands"),
			),
			mcp.WithNumber("min_snr",
				mcp.Description("Minimum SNR in dB (default: -999 = no filter)"),
				mcp.DefaultNumber(-999.0),
			),
			mcp.WithNumber("hours",
				mcp.Description("Hours of history (default: 24, max: 48)"),
				mcp.DefaultNumber(24.0),
			),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetDecoderAnalyticsHourly,
	)

	// Tool: get_active_sessions
	m.mcpServer.AddTool(
		mcp.NewTool("get_active_sessions",
			mcp.WithDescription("Get list of active radio listening sessions showing what frequencies and modes are currently in use by other users. Includes geographic location (latitude/longitude), country, and chat usernames. Use this to see what other people are listening to right now."),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetActiveSessions,
	)

	// Tool: get_band_conditions
	m.mcpServer.AddTool(
		mcp.NewTool("get_band_conditions",
			mcp.WithDescription("Get comprehensive band conditions analysis combining space weather, noise floor measurements, and recent decoder activity. Use this for a quick overview of current HF propagation conditions across all bands. Perfect for answering 'what are conditions like right now?' or 'which bands are open?'"),
			mcp.WithString("format",
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetBandConditions,
	)

	// Tool: get_wideband_spectrum
	m.mcpServer.AddTool(
		mcp.NewTool("get_wideband_spectrum",
			mcp.WithDescription("Get full HF spectrum FFT data (0-30 MHz) showing the entire radio spectrum with noise floor and signal levels across all frequencies. Returns raw FFT bins with frequency and power data. Use this for detailed spectrum analysis or to identify signals across the entire HF spectrum."),
			mcp.WithNumber("center_freq",
				mcp.Description("Center frequency in MHz (default: 15.0, range: 0-30)"),
				mcp.DefaultNumber(15.0),
			),
			mcp.WithNumber("span",
				mcp.Description("Frequency span in kHz (default: 30000 = full spectrum, min: 3)"),
				mcp.DefaultNumber(30000.0),
			),
		),
		m.handleGetWidebandSpectrum,
	)

	// Tool: get_noise_floor_trends
	m.mcpServer.AddTool(
		mcp.NewTool("get_noise_floor_trends",
			mcp.WithDescription("Get 24-hour noise floor trend data for analyzing propagation patterns over time. Includes measurements averaged in 10-minute intervals showing how noise floor changes throughout the day. Use this to identify best times for specific bands or to analyze propagation trends."),
			mcp.WithString("band",
				mcp.Description("Specific band name (e.g., '20m', '40m') or empty for all bands"),
			),
		),
		m.handleGetNoiseFloorTrends,
	)
}

// HandleMCP handles MCP protocol requests over HTTP
func (m *MCPServer) HandleMCP(w http.ResponseWriter, r *http.Request) {
	// Check if IP is banned
	if checkIPBan(w, r, m.ipBanManager) {
		return
	}

	// Let the StreamableHTTPServer handle the request
	m.httpServer.ServeHTTP(w, r)
}

// Tool handlers

func (m *MCPServer) handleGetSpaceWeather(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	format := request.GetString("format", "json")

	if m.spaceWeatherMonitor == nil || !m.spaceWeatherMonitor.config.Enabled {
		return mcp.NewToolResultError("Space weather monitoring is not enabled"), nil
	}

	data := m.spaceWeatherMonitor.GetData()
	if data.LastUpdate.IsZero() {
		return mcp.NewToolResultError("Space weather data not yet available"), nil
	}

	if format == "text" {
		text := fmt.Sprintf("Space Weather Conditions:\n"+
			"Solar Flux Index (SFI): %d\n"+
			"A-index: %d\n"+
			"K-index: %d\n"+
			"Last Updated: %s\n\n"+
			"Interpretation:\n"+
			"- SFI > 150: Excellent HF conditions\n"+
			"- SFI 100-150: Good HF conditions\n"+
			"- SFI < 100: Fair to poor HF conditions\n"+
			"- K-index < 3: Quiet conditions\n"+
			"- K-index 3-5: Unsettled conditions\n"+
			"- K-index > 5: Disturbed conditions (poor propagation)",
			data.SolarFlux, data.AIndex, data.KIndex, data.LastUpdate.Format(time.RFC3339))
		return mcp.NewToolResultText(text), nil
	}

	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetNoiseFloor(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	band := request.GetString("band", "")
	format := request.GetString("format", "json")

	if m.noiseFloorMonitor == nil {
		return mcp.NewToolResultError("Noise floor monitoring is not enabled"), nil
	}

	if band == "" {
		// Return all bands
		measurements := m.noiseFloorMonitor.GetLatestMeasurements()
		if len(measurements) == 0 {
			return mcp.NewToolResultError("No measurements available yet"), nil
		}

		if format == "text" {
			text := "Noise Floor Measurements:\n\n"
			for _, meas := range measurements {
				text += fmt.Sprintf("Band %s:\n"+
					"  Noise Floor: %.1f dB\n"+
					"  Median: %.1f dB\n"+
					"  Dynamic Range: %.1f dB\n"+
					"  Occupancy: %.1f%%\n"+
					"  Estimated FT8 SNR: %.1f dB\n\n",
					meas.Band, meas.P5DB, meas.MedianDB, meas.DynamicRange, meas.OccupancyPct, meas.FT8SNR)
			}
			return mcp.NewToolResultText(text), nil
		}

		jsonData, err := json.MarshalIndent(measurements, "", "  ")
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
		}
		return mcp.NewToolResultText(string(jsonData)), nil
	}

	// Return specific band FFT
	fft := m.noiseFloorMonitor.GetLatestFFT(band)
	if fft == nil {
		return mcp.NewToolResultError(fmt.Sprintf("No FFT data available for band %s", band)), nil
	}

	jsonData, err := json.MarshalIndent(fft, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetDecoderSpots(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mode := request.GetString("mode", "")
	hoursFloat := request.GetFloat("hours", 1.0)
	format := request.GetString("format", "json")

	hours := int(hoursFloat)
	if hours == 0 {
		hours = 1
	}
	if hours > 48 {
		hours = 48
	}

	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return mcp.NewToolResultError("Decoder spots logging is not enabled"), nil
	}

	// Calculate time range
	toTime := time.Now().UTC()
	fromTime := toTime.Add(-time.Duration(hours) * time.Hour)

	fromDate := fromTime.Format("2006-01-02")
	toDate := toTime.Format("2006-01-02")
	startTime := fromTime.Format("15:04")
	endTime := toTime.Format("15:04")

	spots, err := m.multiDecoder.spotsLogger.GetHistoricalSpots(
		mode, "", "", "", "", "", "",
		fromDate, toDate, startTime, endTime,
		true, true, 0, -999,
	)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to get spots: %v", err)), nil
	}

	result := map[string]interface{}{
		"spots": spots,
		"count": len(spots),
		"hours": hours,
		"mode":  mode,
	}

	if format == "text" {
		text := fmt.Sprintf("Decoder Spots (Last %d hour(s)):\n", hours)
		if mode != "" {
			text += fmt.Sprintf("Mode: %s\n", mode)
		}
		text += fmt.Sprintf("Total Spots: %d\n\n", len(spots))

		if len(spots) > 0 {
			text += "Recent spots:\n"
			limit := 20
			if len(spots) < limit {
				limit = len(spots)
			}
			for i := 0; i < limit; i++ {
				spot := spots[i]
				text += fmt.Sprintf("  %s | %s | %s | %.1f MHz | SNR: %d dB | %s\n",
					spot.Timestamp, spot.Mode, spot.Callsign, float64(spot.Frequency)/1e6, spot.SNR, spot.Locator)
			}
			if len(spots) > limit {
				text += fmt.Sprintf("  ... and %d more spots\n", len(spots)-limit)
			}
		}
		return mcp.NewToolResultText(text), nil
	}

	jsonData, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetDecoderAnalytics(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	country := request.GetString("country", "")
	continent := request.GetString("continent", "")
	mode := request.GetString("mode", "")
	band := request.GetString("band", "")
	minSNRFloat := request.GetFloat("min_snr", -999.0)
	hoursFloat := request.GetFloat("hours", 24.0)
	format := request.GetString("format", "json")

	minSNR := int(minSNRFloat)
	hours := int(hoursFloat)
	if hours == 0 {
		hours = 24
	}
	if hours > 48 {
		hours = 48
	}

	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return mcp.NewToolResultError("Decoder spots logging is not enabled"), nil
	}

	analytics, err := m.multiDecoder.spotsLogger.GetSpotsAnalytics(country, continent, mode, band, minSNR, hours)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to get analytics: %v", err)), nil
	}

	if format == "text" {
		text := fmt.Sprintf("Decoder Analytics (Last %d hours):\n\n", hours)
		// Calculate total spots from analytics
		totalSpots := 0
		for _, countryData := range analytics.ByCountry {
			totalSpots += countryData.TotalSpots
		}
		if totalSpots > 0 {
			text += fmt.Sprintf("Total Spots: %d\n", totalSpots)
		}
		text += "\nFilters applied:\n"
		if country != "" {
			text += fmt.Sprintf("  Country: %s\n", country)
		}
		if continent != "" {
			text += fmt.Sprintf("  Continent: %s\n", continent)
		}
		if mode != "" {
			text += fmt.Sprintf("  Mode: %s\n", mode)
		}
		if band != "" {
			text += fmt.Sprintf("  Band: %s\n", band)
		}
		if minSNR > -999 {
			text += fmt.Sprintf("  Min SNR: %d dB\n", minSNR)
		}
		return mcp.NewToolResultText(text), nil
	}

	jsonData, err := json.MarshalIndent(analytics, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetDecoderAnalyticsHourly(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	country := request.GetString("country", "")
	continent := request.GetString("continent", "")
	mode := request.GetString("mode", "")
	band := request.GetString("band", "")
	minSNRFloat := request.GetFloat("min_snr", -999.0)
	hoursFloat := request.GetFloat("hours", 24.0)

	minSNR := int(minSNRFloat)
	hours := int(hoursFloat)
	if hours == 0 {
		hours = 24
	}
	if hours > 48 {
		hours = 48
	}

	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return mcp.NewToolResultError("Decoder spots logging is not enabled"), nil
	}

	analytics, err := m.multiDecoder.spotsLogger.GetSpotsAnalyticsHourly(country, continent, mode, band, minSNR, hours)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to get hourly analytics: %v", err)), nil
	}

	jsonData, err := json.MarshalIndent(analytics, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetActiveSessions(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	format := request.GetString("format", "json")

	m.sessions.mu.RLock()
	defer m.sessions.mu.RUnlock()

	sessions := make([]map[string]interface{}, 0)
	index := 1
	for _, session := range m.sessions.sessions {
		if !session.IsSpectrum && session.ClientIP != "" {
			session.mu.RLock()

			isBypassed := m.sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP)
			if !isBypassed {
				sessionInfo := map[string]interface{}{
					"index":          index,
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

				// Add GeoIP coordinates if available
				if m.geoIPService != nil && m.geoIPService.IsEnabled() {
					if result, err := m.geoIPService.Lookup(session.ClientIP); err == nil {
						if result.Latitude != nil {
							sessionInfo["latitude"] = *result.Latitude
						}
						if result.Longitude != nil {
							sessionInfo["longitude"] = *result.Longitude
						}
						if result.AccuracyRadius != nil {
							sessionInfo["accuracy_radius_km"] = *result.AccuracyRadius
						}
					}
				}

				// Add chat username if available
				if m.dxClusterWsHandler != nil && m.dxClusterWsHandler.chatManager != nil && session.UserSessionID != "" {
					if username, exists := m.dxClusterWsHandler.chatManager.GetUsername(session.UserSessionID); exists {
						sessionInfo["chat_username"] = username
					}
				}

				sessions = append(sessions, sessionInfo)
				index++
			}
			session.mu.RUnlock()
		}
	}

	result := map[string]interface{}{
		"active_sessions": len(sessions),
		"sessions":        sessions,
	}

	if format == "text" {
		text := fmt.Sprintf("Active Radio Sessions: %d\n\n", len(sessions))
		if len(sessions) > 0 {
			for _, sess := range sessions {
				idx, _ := sess["index"].(int)
				freq, _ := sess["frequency"].(int)
				mode, _ := sess["mode"].(string)
				country, _ := sess["country"].(string)
				text += fmt.Sprintf("%d. %.3f MHz | %s | %s", idx, float64(freq)/1e3, mode, country)
				if username, ok := sess["chat_username"].(string); ok && username != "" {
					text += fmt.Sprintf(" | User: %s", username)
				}
				if lat, ok := sess["latitude"].(float64); ok {
					if lon, ok := sess["longitude"].(float64); ok {
						text += fmt.Sprintf(" | Coords: %.4f, %.4f", lat, lon)
					}
				}
				text += "\n"
			}
		} else {
			text += "No active sessions at the moment.\n"
		}
		return mcp.NewToolResultText(text), nil
	}

	jsonData, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetBandConditions(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	format := request.GetString("format", "json")

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
		toTime := time.Now().UTC()
		fromTime := toTime.Add(-1 * time.Hour)
		fromDate := fromTime.Format("2006-01-02")
		toDate := toTime.Format("2006-01-02")
		startTime := fromTime.Format("15:04")
		endTime := toTime.Format("15:04")

		spots, err := m.multiDecoder.spotsLogger.GetHistoricalSpots(
			"", "", "", "", "", "", "",
			fromDate, toDate, startTime, endTime,
			true, true, 0, -999,
		)
		if err == nil {
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
		return mcp.NewToolResultError("No band condition data available"), nil
	}

	if format == "text" {
		text := "Band Conditions Summary:\n\n"

		if sw, ok := result["space_weather"].(map[string]interface{}); ok {
			text += "Space Weather:\n"
			if sfi, ok := sw["sfi"].(int); ok {
				text += fmt.Sprintf("  Solar Flux Index: %d\n", sfi)
			}
			if aIndex, ok := sw["a_index"].(int); ok {
				text += fmt.Sprintf("  A-index: %d\n", aIndex)
			}
			if kIndex, ok := sw["k_index"].(int); ok {
				text += fmt.Sprintf("  K-index: %d\n", kIndex)
			}
			text += "\n"
		}

		if nf, ok := result["noise_floor"].(map[string]interface{}); ok {
			text += "Noise Floor by Band:\n"
			for band, data := range nf {
				if bandData, ok := data.(map[string]interface{}); ok {
					if noiseFloor, ok := bandData["noise_floor_db"].(float64); ok {
						if ft8snr, ok := bandData["ft8_snr"].(float64); ok {
							text += fmt.Sprintf("  %s: %.1f dB (Est. FT8 SNR: %.1f dB)\n", band, noiseFloor, ft8snr)
						}
					}
				}
			}
			text += "\n"
		}

		if activity, ok := result["decoder_activity"].(map[string]interface{}); ok {
			if spots, ok := activity["last_hour_spots"].(int); ok {
				text += fmt.Sprintf("Recent Activity: %d spots in last hour\n", spots)
			}
			if byMode, ok := activity["by_mode"].(map[string]int); ok {
				for mode, count := range byMode {
					text += fmt.Sprintf("  %s: %d spots\n", mode, count)
				}
			}
		}

		return mcp.NewToolResultText(text), nil
	}

	jsonData, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetWidebandSpectrum(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	// Note: center_freq and span parameters are accepted but not used by GetWideBandFFT()
	// The method returns the full 0-30 MHz spectrum
	// These parameters are kept for future enhancement possibilities

	if m.noiseFloorMonitor == nil {
		return mcp.NewToolResultError("Noise floor monitoring is not enabled"), nil
	}

	// Get wideband FFT data (full 0-30 MHz spectrum)
	fft := m.noiseFloorMonitor.GetWideBandFFT()
	if fft == nil {
		return mcp.NewToolResultError("No wideband FFT data available"), nil
	}

	jsonData, err := json.MarshalIndent(fft, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}

func (m *MCPServer) handleGetNoiseFloorTrends(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	band := request.GetString("band", "")

	if m.noiseFloorMonitor == nil {
		return mcp.NewToolResultError("Noise floor monitoring is not enabled"), nil
	}

	var trends interface{}
	var err error

	if band == "" {
		// Get trends for all bands
		trends, err = m.noiseFloorMonitor.GetTrendDataAllBands()
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get trend data: %v", err)), nil
		}
	} else {
		// Get trends for specific band (last 24 hours from today)
		today := time.Now().Format("2006-01-02")
		trends, err = m.noiseFloorMonitor.GetTrendData(today, band)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get trend data for band %s: %v", band, err)), nil
		}
	}

	if trends == nil {
		return mcp.NewToolResultError("No trend data available"), nil
	}

	jsonData, err := json.MarshalIndent(trends, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(jsonData)), nil
}
