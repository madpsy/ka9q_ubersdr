package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
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
	cwskimmerConfig     *CWSkimmerConfig
	instanceReporter    *InstanceReporter
	rotctlHandler       *RotctlAPIHandler
	freqRefMonitor      *FrequencyReferenceMonitor
	mcpServer           *server.MCPServer
	httpServer          *server.StreamableHTTPServer

	// Set by AttachSources once main has built them; nil when the feature is
	// off, and every tool that reads one says so rather than failing.
	MCPSources
}

// MCPSources are the data sources the MCP tools read that main.go creates after
// the MCP server itself. They are attached once, before the HTTP server starts
// serving, and never change afterwards, so the tools read them without locking.
type MCPSources struct {
	SessionDB        *sql.DB // read-only handle on the session history tables
	CWSkimmer        *CWSkimmerClient
	CTY              *CTYDatabase
	DXCluster        *DXClusterClient
	EiBi             *EiBiSchedule
	DRM              *DRMSchedule
	StatsLogger      *StatsLogger
	PSKRank          *PSKRankFetcher
	WSPRRank         *WSPRRankFetcher
	RBNStore         *RBNDataStore
	Spectrogram      *SpectrogramRecorder            // wideband recorder
	BandSpectrograms map[string]*SpectrogramRecorder // per-band recorders
	RateLimiter      *FFTRateLimiter                 // per client IP, keyed per tool
	// Describe builds the public receiver description, the same map
	// GET /api/description serves; get_receiver_info returns it.
	Describe func() map[string]interface{}
}

// AttachSources hands the MCP server the data sources main.go builds after it.
// Must be called before the HTTP server starts serving.
func (m *MCPServer) AttachSources(src MCPSources) {
	m.MCPSources = src
}

// mcpReadOnlyTool marks a tool as reading receiver state only. Every tool is
// one, and must say so: mcp-go's NewTool defaults to readOnlyHint false and
// destructiveHint true, which makes clients treat a query like a write and ask
// for confirmation before each call.
var mcpReadOnlyTool = mcp.WithToolAnnotation(mcp.ToolAnnotation{
	ReadOnlyHint:    mcp.ToBoolPtr(true),
	DestructiveHint: mcp.ToBoolPtr(false),
	IdempotentHint:  mcp.ToBoolPtr(true),
	OpenWorldHint:   mcp.ToBoolPtr(false),
})

// mcpClientIPKey carries the caller's real IP from the HTTP request into the
// tool handlers, which mcp-go otherwise gives no view of the request.
type mcpClientIPKey struct{}

// mcpClientIP returns the caller's IP as getClientIP saw it, or "" outside an
// HTTP request (in tests that call the handlers directly).
func mcpClientIP(ctx context.Context) string {
	ip, _ := ctx.Value(mcpClientIPKey{}).(string)
	return ip
}

// allowToolCall applies the per-IP rate limit to the tools that do real work
// (database scans, image renders). Each tool has its own bucket, so a busy
// session-history query does not lock a client out of everything else.
func (m *MCPServer) allowToolCall(ctx context.Context, tool string) bool {
	if m.RateLimiter == nil {
		return true
	}
	return m.RateLimiter.AllowRequest(mcpClientIP(ctx), "mcp-"+tool)
}

// mcpRateLimited is the result a rate-limited tool call returns.
func mcpRateLimited(tool string) *mcp.CallToolResult {
	return mcp.NewToolResultError(fmt.Sprintf("Rate limit exceeded for %s: wait a couple of seconds and try again", tool))
}

// mcpJSON returns v as an indented JSON tool result.
func mcpJSON(v interface{}) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

// NewMCPServer creates a new MCP server instance
func NewMCPServer(sessions *SessionManager, swm *SpaceWeatherMonitor,
	nfm *NoiseFloorMonitor, md *MultiDecoder, cfg *Config, ipBanManager *IPBanManager,
	geoIPService *GeoIPService, dxClusterWsHandler *DXClusterWebSocketHandler,
	cwskimmerConfig *CWSkimmerConfig, instanceReporter *InstanceReporter,
	rotctlHandler *RotctlAPIHandler, freqRefMonitor *FrequencyReferenceMonitor) *MCPServer {

	m := &MCPServer{
		sessions:            sessions,
		spaceWeatherMonitor: swm,
		noiseFloorMonitor:   nfm,
		multiDecoder:        md,
		config:              cfg,
		ipBanManager:        ipBanManager,
		geoIPService:        geoIPService,
		dxClusterWsHandler:  dxClusterWsHandler,
		cwskimmerConfig:     cwskimmerConfig,
		instanceReporter:    instanceReporter,
		rotctlHandler:       rotctlHandler,
		freqRefMonitor:      freqRefMonitor,
	}

	// Create MCP server with server info
	m.mcpServer = server.NewMCPServer(
		"UberSDR",
		"1.0.0",
		server.WithToolCapabilities(true),
		// Outermost, so a panic anywhere in a tool call, argument
		// validation included, becomes an error for that call instead of
		// taking the receiver down.
		server.WithRecovery(),
		server.WithToolHandlerMiddleware(m.validateToolArgs),
	)

	// Register all tools, then withdraw the ones the operator turned off
	m.registerTools()
	m.removeDisabledTools()

	// Wrap tool handlers with logging
	m.wrapToolHandlersWithLogging()

	// Create HTTP server wrapper. The context function hands each tool call the
	// caller's real IP, for per-client rate limiting.
	m.httpServer = server.NewStreamableHTTPServer(m.mcpServer,
		server.WithHTTPContextFunc(func(ctx context.Context, r *http.Request) context.Context {
			return context.WithValue(ctx, mcpClientIPKey{}, getClientIP(r))
		}),
	)

	return m
}

// removeDisabledTools drops every tool named in mcp.disabled_tools. A name that
// matches no tool is logged rather than fatal: tools come and go between
// versions, and a stale entry should not stop the server starting.
func (m *MCPServer) removeDisabledTools() {
	if m.config == nil || len(m.config.MCP.DisabledTools) == 0 {
		return
	}
	registered := m.mcpServer.ListTools()
	var remove []string
	for name := range registered {
		if m.config.MCP.IsToolDisabled(name) {
			remove = append(remove, name)
		}
	}
	sort.Strings(remove)
	for _, want := range m.config.MCP.DisabledTools {
		found := false
		for name := range registered {
			if strings.EqualFold(strings.TrimSpace(want), name) {
				found = true
				break
			}
		}
		if !found {
			log.Printf("MCP: disabled_tools entry %q matches no tool", want)
		}
	}
	if len(remove) > 0 {
		m.mcpServer.DeleteTools(remove...)
		log.Printf("MCP: disabled tools: %v", remove)
	}
}

// wrapToolHandlersWithLogging wraps all tool handlers to log requests
func (m *MCPServer) wrapToolHandlersWithLogging() {
	// Note: The mcp-go library doesn't provide a way to intercept all tool calls
	// So we'll add logging in the HandleMCP function instead
}

// registerTools registers all available MCP tools
func (m *MCPServer) registerTools() {
	// Tool: get_space_weather
	m.mcpServer.AddTool(
		mcp.NewTool("get_space_weather",
			mcpReadOnlyTool,
			mcp.WithDescription("Get current space weather conditions including Solar Flux Index (SFI), A-index, and K-index which affect HF radio propagation. Use this to understand current ionospheric conditions. Higher SFI (>150) = better HF propagation. Higher K-index (>5) = disturbed conditions and poor propagation."),
			mcp.WithString("format",
				mcp.Enum("json", "text"),
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetSpaceWeather,
	)

	// Tool: get_noise_floor
	m.mcpServer.AddTool(
		mcp.NewTool("get_noise_floor",
			mcpReadOnlyTool,
			mcp.WithDescription("Get noise floor measurements for amateur radio bands, including dynamic range, occupancy, and estimated FT8 SNR. Use this to assess current band conditions and signal quality. Lower noise floor = better conditions. Higher estimated FT8 SNR = better decode capability."),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Specific band name (e.g., '20m', '40m', '80m') or leave empty for all bands"),
			),
			mcp.WithString("format",
				mcp.Enum("json", "text"),
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetNoiseFloor,
	)

	// Tool: get_decoder_spots
	m.mcpServer.AddTool(
		mcp.NewTool("get_decoder_spots", append([]mcp.ToolOption{
			mcpReadOnlyTool,
			mcp.WithDescription("Get individual digital mode spots (FT8, FT4, WSPR, JS8, FT2) decoded by the radio: callsign, locator, SNR, frequency, band, message, country and distance, collapsed to one row per callsign, locator, band, mode and day (seen_count says how many raw decodes each row stands for). Newest first. " +
				"A busy receiver decodes tens of thousands of stations a day, so filter (mode, band, callsign, min_snr, a time window) and ask for only the fields you need; format 'columns' sends the field names once instead of on every spot. limit caps the result (truncated says when it did). " +
				"For counts per band or mode over time, or per grid square, use get_spot_activity; for statistics by country, get_decoder_analytics."),
			mcp.WithString("mode",
				mcp.Pattern(`^[A-Za-z0-9]+$`),
				mcp.MaxLength(32),
				mcp.Description("Mode filter: 'FT8', 'FT4', 'WSPR', 'JS8', 'FT2', or empty for all modes"),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band filter, e.g. '20m' (default: all)"),
			),
			mcp.WithString("callsign",
				mcp.Pattern(`^[A-Za-z0-9/]+$`),
				mcp.MaxLength(20),
				mcp.Description("Only this callsign"),
			),
			mcp.WithNumber("min_snr",
				mcp.Min(-60),
				mcp.Max(60),
				mcp.Description("Minimum SNR in dB (default: no filter)"),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(48),
				mcp.Description("Hours of history to retrieve (default: 1, max: 48)"),
				mcp.DefaultNumber(1.0),
			),
			mcpSinceProp(),
			mcp.WithNumber("limit",
				mcp.Min(1),
				mcp.Max(mcpMaxDecoderSpots),
				mcp.Description(fmt.Sprintf("Most spots to return, newest first (default %d, max %d)", mcpDefaultDecoderSpots, mcpMaxDecoderSpots)),
			),
			mcpFieldsProp(decoderSpotFields, "spot"),
			mcpCollapseProp(),
			mcp.WithString("format",
				mcp.Enum("json", "columns", "text"),
				mcp.Description("'json' (one object per spot, default), 'columns' (field names once, then one array per spot) or 'text' (a human-readable summary)"),
				mcp.DefaultString("json"),
			),
		}, mcpWindowProps()...)...),
		m.handleGetDecoderSpots,
	)

	// Tool: get_decoder_analytics
	m.mcpServer.AddTool(
		mcp.NewTool("get_decoder_analytics",
			mcpReadOnlyTool,
			mcp.WithDescription("Get aggregated analytics about decoder spots by country, continent, mode, and band. Use this to answer questions about WHICH bands/countries have the most activity overall (e.g., 'which band is best for South Korea?'). Returns total spot counts, average SNR, and band distribution for each country."),
			mcp.WithString("country",
				mcp.Description("Country name filter (e.g., 'South Korea', 'Japan', 'United States', 'Germany') or empty for all countries"),
			),
			mcp.WithString("continent",
				mcp.Pattern(`^[A-Za-z]{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Continent code: 'AF' (Africa), 'AS' (Asia), 'EU' (Europe), 'NA' (North America), 'OC' (Oceania), 'SA' (South America), 'AN' (Antarctica), or empty for all"),
			),
			mcp.WithString("mode",
				mcp.Pattern(`^[A-Za-z0-9]+$`),
				mcp.MaxLength(32),
				mcp.Description("Mode filter: 'FT8', 'FT4', 'WSPR', or empty for all modes"),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band filter (e.g., '20m', '40m') or empty for all bands"),
			),
			mcp.WithNumber("min_snr",
				mcp.Min(-999),
				mcp.Max(100),
				mcp.Description("Minimum SNR in dB (default: -999 = no filter)"),
				mcp.DefaultNumber(-999.0),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(48),
				mcp.Description("Hours of history (default: 24, max: 48)"),
				mcp.DefaultNumber(24.0),
			),
			mcp.WithString("format",
				mcp.Enum("json", "text"),
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetDecoderAnalytics,
	)

	// Tool: get_decoder_analytics_hourly
	m.mcpServer.AddTool(
		mcp.NewTool("get_decoder_analytics_hourly",
			mcpReadOnlyTool,
			mcp.WithDescription("Get hourly aggregated analytics about decoder spots, broken down by hour for trend analysis. Use this to answer questions about WHEN specific countries/bands are most active (e.g., 'what time is South Korea most active on 20m?'). Returns spot counts and SNR data for each hour of the day, allowing you to identify peak propagation times."),
			mcp.WithString("country",
				mcp.Description("Country name filter (e.g., 'South Korea', 'Japan', 'United States') or empty for all countries"),
			),
			mcp.WithString("continent",
				mcp.Pattern(`^[A-Za-z]{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Continent code (AF, AS, EU, NA, OC, SA, AN) or empty for all"),
			),
			mcp.WithString("mode",
				mcp.Pattern(`^[A-Za-z0-9]+$`),
				mcp.MaxLength(32),
				mcp.Description("Mode filter: 'FT8', 'FT4', 'WSPR', or empty for all modes"),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band filter (e.g., '20m', '40m') or empty for all bands"),
			),
			mcp.WithNumber("min_snr",
				mcp.Min(-999),
				mcp.Max(100),
				mcp.Description("Minimum SNR in dB (default: -999 = no filter)"),
				mcp.DefaultNumber(-999.0),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(48),
				mcp.Description("Hours of history (default: 24, max: 48)"),
				mcp.DefaultNumber(24.0),
			),
			mcp.WithString("format",
				mcp.Enum("json", "text"),
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetDecoderAnalyticsHourly,
	)

	// Tool: get_active_sessions
	m.mcpServer.AddTool(
		mcp.NewTool("get_active_sessions",
			mcpReadOnlyTool,
			mcp.WithDescription("Get list of active radio listening sessions showing what frequencies and modes are currently in use by other users. Frequencies are in Hz (frequency_khz gives the same in kHz). Each session's protocol says which client it uses: 'native' (the UberSDR web or app client), 'kiwi' (a KiwiSDR-compatible client) or 'websdr' (a WebSDR-compatible client). Includes approximate location (GeoIP, rounded to 0.1 degree), country, and chat usernames. Use this to see what other people are listening to right now; for listener numbers over days or weeks use get_session_history."),
			mcp.WithString("format",
				mcp.Enum("json", "text"),
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetActiveSessions,
	)

	// Tool: get_band_conditions
	m.mcpServer.AddTool(
		mcp.NewTool("get_band_conditions",
			mcpReadOnlyTool,
			mcp.WithDescription("Get comprehensive band conditions analysis combining space weather, noise floor measurements, and recent decoder activity. Use this for a quick overview of current HF propagation conditions across all bands. Perfect for answering 'what are conditions like right now?' or 'which bands are open?'"),
			mcp.WithString("format",
				mcp.Enum("json", "text"),
				mcp.Description("Output format: 'json' for structured data or 'text' for human-readable summary"),
				mcp.DefaultString("json"),
			),
		),
		m.handleGetBandConditions,
	)

	// Tool: get_wideband_spectrum
	//
	// The span is this receiver's, not a fixed 0-30 MHz: an LLM client picks its
	// center_freq out of these strings, so a stale ceiling here is a model politely
	// refusing to look at 6 m on a receiver that covers it.
	//
	// Note the SNR bands named in get_receiver_info below are deliberately NOT derived —
	// see noise_floor.go, where they are pinned so history stays comparable.
	spectrumTopMHz := float64(m.config.Receiver.Span()) / 1e6
	spectrumCentreMHz := float64(m.config.Receiver.Centre()) / 1e6
	spectrumSpanKHz := float64(m.config.Receiver.Span()) / 1e3
	m.mcpServer.AddTool(
		mcp.NewTool("get_wideband_spectrum",
			mcpReadOnlyTool,
			mcp.WithDescription(fmt.Sprintf("Get full HF spectrum FFT data (0-%.0f MHz) showing the entire radio spectrum with noise floor and signal levels across all frequencies. Returns raw FFT bins with frequency and power data. Use this for detailed spectrum analysis or to identify signals across the entire HF spectrum.", spectrumTopMHz)),
			mcp.WithNumber("center_freq",
				mcp.Min(0),
				mcp.Max(1000),
				mcp.Description(fmt.Sprintf("Center frequency in MHz (default: %.1f, range: 0-%.0f)", spectrumCentreMHz, spectrumTopMHz)),
				// The schema default has to be derived too, not just the sentence beside
				// it: an LLM client reads the description but *fills in* this number, so
				// a literal 15 here would quietly contradict a description saying 30.
				mcp.DefaultNumber(spectrumCentreMHz),
			),
			mcp.WithNumber("span",
				mcp.Min(3),
				mcp.Max(1000000),
				mcp.Description(fmt.Sprintf("Frequency span in kHz (default: %.0f = full spectrum, min: 3)", spectrumSpanKHz)),
				mcp.DefaultNumber(spectrumSpanKHz),
			),
		),
		m.handleGetWidebandSpectrum,
	)

	// Tool: get_noise_floor_trends
	m.mcpServer.AddTool(
		mcp.NewTool("get_noise_floor_trends",
			mcpReadOnlyTool,
			mcp.WithDescription("Get noise floor trend data for analysing propagation over the last 24 hours: per band, averaged into 10-minute (or longer) steps, with noise floor percentiles, dynamic range, occupancy and an FT8 SNR estimate. Use this to identify the best times for specific bands or to see how conditions changed. "+
				"With no arguments it returns every field for every band, about 500 KB; ask for only what you need with bands, fields, hours or since and the result comes back as compact columns (one shared time axis, one array per field) instead. "+
				"To keep a chart current, pass since = the time_axis.start_utc of the newest step you already have: that step (which may have grown) and anything newer come back."),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("One band (e.g. '20m'), returned in the original row format; use bands for several"),
			),
			mcp.WithArray("bands",
				mcp.Description("Only these bands, e.g. ['20m', '40m'] (default: all)"),
				mcp.Items(map[string]interface{}{"type": "string", "pattern": `^[A-Za-z0-9.\-]+$`, "maxLength": 32}),
				mcp.MaxItems(32),
			),
			mcp.WithArray("fields",
				mcp.Description("Only these values per step (default: all): "+strings.Join(nfTrendFieldNames, ", ")),
				mcp.Items(map[string]interface{}{"type": "string", "enum": nfTrendFieldNames}),
				mcp.MaxItems(len(nfTrendFieldNames)),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(24),
				mcp.Description("The most recent N hours, 1-24 (default 24)"),
			),
			mcp.WithString("since",
				mcp.MaxLength(40),
				mcp.Description("RFC 3339 time: only steps starting at or after the step containing it (within the window)"),
			),
			mcp.WithNumber("step_minutes",
				mcp.Min(10),
				mcp.Max(1440),
				mcp.Description("Average into steps of this many minutes, a multiple of 10 (default 10)"),
			),
			mcp.WithString("format",
				mcp.Enum("columns", "rows"),
				mcp.Description("'columns' (time axis plus one array per field) or 'rows' (one object per step). Default: 'columns' when any other option is given, otherwise the original rows"),
			),
		),
		m.handleGetNoiseFloorTrends,
	)

	// Tool: get_receiver_info
	m.mcpServer.AddTool(
		mcp.NewTool("get_receiver_info",
			mcpReadOnlyTool,
			mcp.WithDescription("Get comprehensive information about the SDR receiver, the same as its public /api/description: name, callsign, location (GPS, Maidenhead grid square, country, timezone), antenna, tuning range, default frequency and mode, available and maximum client slots, session time limit, spectrum dynamic range (SNR for 0-30 MHz and 1.8-30 MHz), enabled features (space weather, noise floor, spectrogram, digital decodes and which modes, CW skimmer, DX cluster, chat, speech to text, DSP filters, add-ons, widgets), rotator and antenna switch status, frequency reference and GPSDO, leaderboard ranks, server time and software version. Use this to understand the receiver's configuration, capabilities, and current status."),
		),
		m.handleGetReceiverInfo,
	)

	m.registerSessionHistoryTool()
	m.registerSpotTools()
	m.registerFrequencyTools()
	m.registerPropagationTools()
	m.registerStationTools()
	m.registerSpectrogramTool()
	m.registerSpectrogramDataTool()
	m.registerSpotActivityTool()
}

// HandleMCP handles MCP protocol requests over HTTP
func (m *MCPServer) HandleMCP(w http.ResponseWriter, r *http.Request) {
	// Check if IP is banned
	if checkIPBan(w, r, m.ipBanManager) {
		return
	}

	// Only clients in mcp.allowed_ips may use the endpoint at all.
	if clientIP := getClientIP(r); !m.config.MCP.IsIPAllowed(clientIP) {
		log.Printf("MCP access denied for IP %s (not in mcp.allowed_ips)", clientIP)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Access denied: this receiver only accepts MCP connections from addresses listed in mcp.allowed_ips",
		})
		return
	}

	// Then the auth token, when mcp.require_auth is on (the default).
	if !checkMCPAuth(w, r) {
		return
	}

	// Log MCP requests if it's a POST with JSON body
	if r.Method == http.MethodPost && globalMCPRequestLogger != nil {
		// Read and log the request body
		body := make([]byte, r.ContentLength)
		if r.ContentLength > 0 && r.ContentLength < 1024*1024 { // Max 1MB
			n, err := r.Body.Read(body)
			if err == nil || err.Error() == "EOF" {
				body = body[:n]

				// Parse JSON to extract method and params
				var reqData map[string]interface{}
				if err := json.Unmarshal(body, &reqData); err == nil {
					method, _ := reqData["method"].(string)
					id := reqData["id"]

					// Extract params if present
					params := make(map[string]interface{})
					if paramsData, ok := reqData["params"].(map[string]interface{}); ok {
						// For tools/call, extract the tool name and arguments
						if method == "tools/call" {
							if toolName, ok := paramsData["name"].(string); ok {
								params["tool_name"] = toolName
							}
							if args, ok := paramsData["arguments"].(map[string]interface{}); ok {
								for k, v := range args {
									params[k] = v
								}
							}
						} else {
							params = paramsData
						}
					}

					globalMCPRequestLogger.LogRequest(method, params, id)
				}

				// Restore body for the actual handler
				r.Body = io.NopCloser(bytes.NewBuffer(body))
			}
		}
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
			"Solar Flux Index (SFI): %.1f\n"+
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

// Decoder spot limits: a full day of every mode on a busy receiver is tens of
// thousands of rows, so the default answers "what was heard" without paging
// through megabytes.
const (
	mcpDefaultDecoderSpots = 1000
	mcpMaxDecoderSpots     = 10000
)

var decoderSpotFields = []string{"timestamp", "callsign", "locator", "snr", "frequency", "band", "message",
	"country", "cq_zone", "itu_zone", "continent", "distance_km", "bearing_deg", "dbm", "mode", "name", "seen_count"}

func (m *MCPServer) handleGetDecoderSpots(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mode := request.GetString("mode", "")
	format := request.GetString("format", "json")
	hours := int(request.GetFloat("hours", 1))

	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return mcp.NewToolResultError("Decoder spots logging is not enabled"), nil
	}
	a := newMCPArgs(request)
	fields := []string(nil)
	if a.has("fields") {
		fields = a.stringList("fields", len(decoderSpotFields), decoderSpotFields, nil)
	}
	if a.Err() != nil {
		return mcp.NewToolResultError(a.Err().Error()), nil
	}
	limit := int(request.GetFloat("limit", mcpDefaultDecoderSpots))
	minSNR := -999 // the spot logger's "no filter"
	if a.has("min_snr") {
		minSNR = int(math.Floor(request.GetFloat("min_snr", -999)))
	}

	// An absolute window: the date range picks the days and fromTS/toTS trim
	// them, so 'hours' means the last N hours rather than every spot since
	// midnight on the first day it touches.
	fromTime, toTime, msg := mcpSpotWindow(request, 1, 48, time.Now().UTC())
	if msg != "" {
		return mcp.NewToolResultError(msg), nil
	}

	// One past the limit, so a cut-off result can say so.
	spots, err := m.multiDecoder.spotsLogger.GetHistoricalSpotsRange(
		mode, request.GetString("band", ""), "", strings.ToUpper(request.GetString("callsign", "")), "", "", "", "",
		fromTime.Format("2006-01-02"), toTime.Format("2006-01-02"), "", "",
		request.GetString("collapse", "day") != "none", true, 0, minSNR,
		fromTime.Unix(), toTime.Unix()+1, limit+1,
	)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to get spots: %v", err)), nil
	}
	truncated := len(spots) > limit
	if truncated {
		spots = spots[:limit]
	}

	if format == "json" || format == "columns" {
		shaped, err := mcpShapeRecords(spots, fields, format == "columns")
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to shape spots: %v", err)), nil
		}
		return mcpCompactJSON(map[string]interface{}{
			"spots":     shaped,
			"count":     len(spots),
			"truncated": truncated,
			"hours":     hours,
			"mode":      mode,
			"from_utc":  fromTime.Format(time.RFC3339),
			"until_utc": toTime.Format(time.RFC3339),
		})
	}

	result := map[string]interface{}{
		"spots":     spots,
		"count":     len(spots),
		"hours":     hours,
		"mode":      mode,
		"from_utc":  fromTime.Format(time.RFC3339),
		"until_utc": toTime.Format(time.RFC3339),
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
		// One entry per listener: a secondary VFO is the same listener again.
		if !session.IsSpectrum && !session.IsSecondary && session.ClientIP != "" {
			session.mu.RLock()

			isBypassed := m.sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP)
			if !isBypassed {
				sessionInfo := map[string]interface{}{
					"index":          index,
					"frequency":      session.Frequency,
					"frequency_khz":  float64(session.Frequency) / 1e3,
					"mode":           session.Mode,
					"protocol":       protocolFromUserSessionID(session.UserSessionID),
					"bandwidth_low":  session.BandwidthLow,
					"bandwidth_high": session.BandwidthHigh,
					"created_at":     session.CreatedAt,
					"last_active":    session.LastActive,
					"country":        session.Country,
					"country_code":   session.CountryCode,
				}

				// Add GeoIP coordinates if available. GeoIP is city-level at
				// best, so the coordinates are rounded to 0.1 degree (about
				// 11 km) rather than handing out false precision about where a
				// listener is.
				if m.geoIPService != nil && m.geoIPService.IsEnabled() {
					if result, err := m.geoIPService.Lookup(session.ClientIP, false); err == nil {
						if result.Latitude != nil {
							sessionInfo["latitude"] = roundCoordinate(*result.Latitude)
						}
						if result.Longitude != nil {
							sessionInfo["longitude"] = roundCoordinate(*result.Longitude)
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
				freqKHz, _ := sess["frequency_khz"].(float64)
				mode, _ := sess["mode"].(string)
				protocol, _ := sess["protocol"].(string)
				country, _ := sess["country"].(string)
				text += fmt.Sprintf("%d. %.3f kHz | %s | %s | %s", idx, freqKHz, mode, protocol, country)
				if username, ok := sess["chat_username"].(string); ok && username != "" {
					text += fmt.Sprintf(" | User: %s", username)
				}
				if lat, ok := sess["latitude"].(float64); ok {
					if lon, ok := sess["longitude"].(float64); ok {
						text += fmt.Sprintf(" | Coords: %.1f, %.1f", lat, lon)
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
		// An exact hour. The time-of-day filter this used before applied
		// "HH:MM between start and end" within each day, so an hour across
		// midnight (23:30-00:30) matched nothing.
		toTime := time.Now().UTC()
		modeCounts, total, err := m.multiDecoder.spotsLogger.CountSpotsByMode(
			toTime.Add(-time.Hour).Unix(), toTime.Unix()+1)
		if err == nil {
			result["decoder_activity"] = map[string]interface{}{
				"last_hour_spots": total,
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
	// The method returns the receiver's full spectrum, whatever it covers; the reply's
	// start_freq/end_freq/bin_width say what that is.
	// These parameters are kept for future enhancement possibilities

	if m.noiseFloorMonitor == nil {
		return mcp.NewToolResultError("Noise floor monitoring is not enabled"), nil
	}

	// Get wideband FFT data (the receiver's full spectrum; self-describing, see above)
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

var mcpBandNameRe = regexp.MustCompile(`^[A-Za-z0-9.\-]{1,32}$`)

// nfTrendFieldNames are the per-step values get_noise_floor_trends can return.
var nfTrendFieldNames = []string{"p5_db", "p10_db", "median_db", "mean_db", "p95_db", "min_db", "max_db",
	"dynamic_range", "occupancy_pct", "ft8_snr", "snr_0_30_mhz", "snr_1_8_30_mhz"}

func nfTrendField(bm *BandMeasurement, name string) float32 {
	switch name {
	case "p5_db":
		return bm.P5DB
	case "p10_db":
		return bm.P10DB
	case "median_db":
		return bm.MedianDB
	case "mean_db":
		return bm.MeanDB
	case "p95_db":
		return bm.P95DB
	case "min_db":
		return bm.MinDB
	case "max_db":
		return bm.MaxDB
	case "dynamic_range":
		return bm.DynamicRange
	case "occupancy_pct":
		return bm.OccupancyPct
	case "ft8_snr":
		return bm.FT8SNR
	case "snr_0_30_mhz":
		return bm.SNR_0_30MHz
	case "snr_1_8_30_mhz":
		return bm.SNR_1_8_30MHz
	}
	return float32(math.NaN())
}

func (m *MCPServer) handleGetNoiseFloorTrends(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.noiseFloorMonitor == nil {
		return mcp.NewToolResultError("Noise floor monitoring is not enabled"), nil
	}
	a := newMCPArgs(request)
	band := a.str("band", "", 32)
	bands := a.stringList("bands", 32, nil, mcpBandNameRe)
	if band != "" && len(bands) > 0 {
		a.fail("give band or bands, not both")
	}
	fields := nfTrendFieldNames
	if a.has("fields") {
		fields = a.stringList("fields", len(nfTrendFieldNames), nfTrendFieldNames, nil)
	}
	hours := a.integer("hours", 24, 1, 24)
	step := a.integer("step_minutes", 10, 10, 1440)
	if step%10 != 0 {
		a.fail("step_minutes must be a multiple of 10")
	}
	now := time.Now().UTC()
	from := now.Add(-time.Duration(hours) * time.Hour)
	since := a.str("since", "", 40)
	if since != "" {
		t, err := time.Parse(time.RFC3339, since)
		switch {
		case err != nil:
			a.fail("since must be an RFC 3339 time such as 2026-11-17T17:40:00Z")
		case t.After(now):
			a.fail("since is in the future")
		case t.After(from):
			from = t.UTC()
		}
	}
	// Whole steps only: start at the step containing 'from'.
	stepSec := int64(step) * 60
	from = time.Unix(from.Unix()-from.Unix()%stepSec, 0).UTC()
	options := len(bands) > 0 || a.has("fields") || a.has("hours") || since != "" || a.has("step_minutes")
	format := a.enum("format", "", "columns", "rows")
	if a.Err() != nil {
		return mcp.NewToolResultError(a.Err().Error()), nil
	}

	query := bands
	if band != "" {
		query = []string{band}
	}
	trends, err := m.noiseFloorMonitor.QueryTrend(from, now, query, time.Duration(step)*time.Minute)
	if err != nil {
		if err.Error() == "no data available" && options {
			trends = map[string][]*BandMeasurement{} // an incremental fetch with nothing new is not an error
		} else {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get trend data: %v", err)), nil
		}
	}

	// The original shapes, for callers that pass nothing new.
	if !options && format != "columns" {
		if band != "" {
			return mcpCompactJSON(trends[band])
		}
		return mcpCompactJSON(trends)
	}

	if format == "rows" {
		out := map[string][]map[string]interface{}{}
		for b, list := range trends {
			for _, bm := range list {
				row := map[string]interface{}{"timestamp": bm.Timestamp.Format(time.RFC3339)}
				for _, f := range fields {
					row[f] = roundTo(float64(nfTrendField(bm, f)), 2)
				}
				out[b] = append(out[b], row)
			}
		}
		return mcpCompactJSON(map[string]interface{}{"step_minutes": step, "bands": out})
	}

	// Columns: one time axis shared by every band, null where a band has no
	// measurement in a step.
	nSteps := int((now.Unix()-from.Unix())/stepSec) + 1
	cols := map[string]map[string][]*float64{}
	for b, list := range trends {
		c := map[string][]*float64{}
		for _, f := range fields {
			c[f] = make([]*float64, nSteps)
		}
		for _, bm := range list {
			i := int((bm.Timestamp.Unix() - from.Unix()) / stepSec)
			if i < 0 || i >= nSteps {
				continue
			}
			for _, f := range fields {
				v := roundTo(float64(nfTrendField(bm, f)), 1)
				c[f][i] = &v
			}
		}
		cols[b] = c
	}
	return mcpCompactJSON(map[string]interface{}{
		"time_axis": map[string]interface{}{
			"start_utc":    from.Format(time.RFC3339),
			"step_minutes": step,
			"steps":        nSteps,
			"note":         "value i covers start_utc + i*step_minutes; the last step is still filling; null = no measurement",
		},
		"fields": fields,
		"bands":  cols,
	})
}

// mcpCompactJSON is mcpJSON without indentation, for results large enough
// that the whitespace is a sizeable share of them.
func mcpCompactJSON(v interface{}) (*mcp.CallToolResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

func (m *MCPServer) handleGetReceiverInfo(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.Describe == nil {
		return mcp.NewToolResultError("Receiver information is not available yet"), nil
	}
	return mcpJSON(m.Describe())
}

// roundCoordinate rounds a GeoIP latitude or longitude to 0.1 degree.
func roundCoordinate(v float64) float64 {
	return math.Round(v*10) / 10
}
