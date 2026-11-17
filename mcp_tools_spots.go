package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// Activity heard on the receiver beyond the digital decoders: the CW skimmer,
// the DX cluster feed and SSB voice detection.

const (
	mcpDefaultSpotLimit = 100
	mcpMaxSpotLimit     = 500
)

func (m *MCPServer) registerSpotTools() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_cw_spots",
			mcpReadOnlyTool,
			mcp.WithDescription("Get recent CW (Morse) signals decoded by this receiver's CW skimmer: callsign, frequency (Hz), band, SNR, speed in WPM, country, continent and distance. Spots are collapsed to one row per callsign, band and day by default (seen_count says how many raw spots each row stands for). Newest first. For aggregated CW activity by country, continent or hour, use get_cw_analytics."),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(48),
				mcp.Description("Hours of history (default: 1, max: 48)"),
				mcp.DefaultNumber(1),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band filter, e.g. '20m', '40m' (default: all bands)"),
			),
			mcp.WithString("callsign",
				mcp.Pattern(`^[A-Za-z0-9/, ]+$`),
				mcp.MaxLength(200),
				mcp.Description("Only spots of these callsigns, comma-separated, e.g. 'G3XYZ,W1AW' (max 20)"),
			),
			mcp.WithString("country",
				mcp.Description("Country name filter, e.g. 'Japan'"),
			),
			mcp.WithString("continent",
				mcp.Pattern(`^[A-Za-z]{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Continent code: AF, AS, EU, NA, OC, SA or AN"),
			),
			mcp.WithNumber("min_snr",
				mcp.Min(-999),
				mcp.Max(100),
				mcp.Description("Minimum SNR in dB (default: no filter)"),
			),
			mcp.WithNumber("limit",
				mcp.Min(1),
				mcp.Max(500),
				mcp.Description("Most spots to return (default: 100, max: 500)"),
				mcp.DefaultNumber(mcpDefaultSpotLimit),
			),
		),
		m.handleGetCWSpots,
	)

	m.mcpServer.AddTool(
		mcp.NewTool("get_cw_analytics",
			mcpReadOnlyTool,
			mcp.WithDescription("Get aggregated CW skimmer activity: spot counts, unique callsigns and SNR by country, continent and band, or (with hourly=true) broken down by hour of day. Use this to answer which bands or times are best for CW to a given country or continent. For individual CW spots use get_cw_spots."),
			mcp.WithBoolean("hourly",
				mcp.Description("Break the analytics down by hour of day (default: false)"),
				mcp.DefaultBool(false),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(48),
				mcp.Description("Hours of history (default: 24, max: 48)"),
				mcp.DefaultNumber(24),
			),
			mcp.WithString("country",
				mcp.Description("Country name filter, e.g. 'Japan'"),
			),
			mcp.WithString("continent",
				mcp.Pattern(`^[A-Za-z]{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Continent code: AF, AS, EU, NA, OC, SA or AN"),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band filter, e.g. '20m'"),
			),
			mcp.WithNumber("min_snr",
				mcp.Min(-999),
				mcp.Max(100),
				mcp.Description("Minimum SNR in dB (default: no filter)"),
			),
		),
		m.handleGetCWAnalytics,
	)

	m.mcpServer.AddTool(
		mcp.NewTool("get_dx_cluster_spots",
			mcpReadOnlyTool,
			mcp.WithDescription("Get recent spots from the DX cluster this receiver follows: callsign spotted, spotter, frequency (Hz and kHz), band, comment, and the spotted station's country and continent. Covers the last 100 spots the cluster sent that are within the receiver's range. Newest first. Use this for questions like 'what DX is on 20m right now?'."),
			mcp.WithNumber("minutes",
				mcp.Min(1),
				mcp.Max(1440),
				mcp.Description("Only spots from the last N minutes (default: 60, max: 1440)"),
				mcp.DefaultNumber(60),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band filter, e.g. '20m'"),
			),
			mcp.WithString("callsign",
				mcp.Pattern(`^[A-Za-z0-9/, ]+$`),
				mcp.MaxLength(200),
				mcp.Description("Only spots whose DX callsign contains this text, e.g. 'VK' or '3Y0J'"),
			),
			mcp.WithString("continent",
				mcp.Pattern(`^[A-Za-z]{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Continent code of the spotted station: AF, AS, EU, NA, OC, SA or AN"),
			),
		),
		m.handleGetDXClusterSpots,
	)

	m.mcpServer.AddTool(
		mcp.NewTool("get_voice_activity",
			mcpReadOnlyTool,
			mcp.WithDescription("Get SSB voice signals detected on the amateur bands right now from the receiver's spectrum: estimated dial frequency (Hz), sideband, bandwidth, SNR and detection confidence, plus the callsign and country when the DX cluster has spotted a station on that frequency in the last 30 minutes. 30m, 630m and 2200m are not scanned (no voice there). Use this to find active SSB stations or a busy band."),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Band to scan, e.g. '20m' (default: all bands)"),
			),
			mcp.WithNumber("min_confidence",
				mcp.Min(0),
				mcp.Max(1),
				mcp.Description("Minimum detection confidence from 0 to 1 (default: 0.7; lower finds weaker signals but more false detections)"),
			),
		),
		m.handleGetVoiceActivity,
	)
}

// mcpHoursParam reads an hours argument clamped to [1, max].
func mcpHoursParam(request mcp.CallToolRequest, def, max int) int {
	h := int(request.GetFloat("hours", float64(def)))
	if h < 1 {
		h = def
	}
	if h > max {
		h = max
	}
	return h
}

// mcpMinSNRParam reads min_snr, with -999 meaning no filter as the spot
// loggers expect.
func mcpMinSNRParam(request mcp.CallToolRequest) int {
	return int(request.GetFloat("min_snr", -999))
}

func (m *MCPServer) cwSpotsAvailable() bool {
	return m.CWSkimmer != nil && m.CWSkimmer.spotsLogger != nil && m.CWSkimmer.spotsLogger.enabled
}

func (m *MCPServer) handleGetCWSpots(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if !m.cwSpotsAvailable() {
		return mcp.NewToolResultError("CW skimmer spot logging is not enabled on this receiver"), nil
	}

	hours := mcpHoursParam(request, 1, 48)
	limit := int(request.GetFloat("limit", mcpDefaultSpotLimit))
	if limit < 1 {
		limit = mcpDefaultSpotLimit
	}
	if limit > mcpMaxSpotLimit {
		limit = mcpMaxSpotLimit
	}

	callsigns := map[string]bool{}
	for _, part := range strings.Split(request.GetString("callsign", ""), ",") {
		if cs := strings.ToUpper(strings.TrimSpace(part)); cs != "" {
			callsigns[cs] = true
		}
	}
	if len(callsigns) > 20 {
		return mcp.NewToolResultError("At most 20 callsigns can be given"), nil
	}

	if !m.allowToolCall(ctx, "get_cw_spots") {
		return mcpRateLimited("get_cw_spots"), nil
	}

	to := time.Now().UTC()
	from := to.Add(-time.Duration(hours) * time.Hour)
	band := request.GetString("band", "")
	// One past the limit, so a cut-off result can say so.
	spots, err := m.CWSkimmer.spotsLogger.GetCWHistoricalSpotsRange(
		band, "", callsigns,
		strings.ToUpper(request.GetString("continent", "")), request.GetString("country", ""), "",
		from.Format("2006-01-02"), to.Format("2006-01-02"), "", "",
		true, 0, mcpMinSNRParam(request), m.CTY,
		from.Unix(), to.Unix()+1, limit+1,
	)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to read CW spots: %v", err)), nil
	}
	sort.SliceStable(spots, func(i, j int) bool { return spots[i].Timestamp > spots[j].Timestamp })
	truncated := len(spots) > limit
	if truncated {
		spots = spots[:limit]
	}

	return mcpJSON(map[string]interface{}{
		"hours":     hours,
		"count":     len(spots),
		"truncated": truncated,
		"spots":     spots,
	})
}

func (m *MCPServer) handleGetCWAnalytics(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if !m.cwSpotsAvailable() {
		return mcp.NewToolResultError("CW skimmer spot logging is not enabled on this receiver"), nil
	}
	if !m.allowToolCall(ctx, "get_cw_analytics") {
		return mcpRateLimited("get_cw_analytics"), nil
	}

	hours := mcpHoursParam(request, 24, 48)
	country := request.GetString("country", "")
	continent := strings.ToUpper(request.GetString("continent", ""))
	band := request.GetString("band", "")
	minSNR := mcpMinSNRParam(request)

	if request.GetBool("hourly", false) {
		analytics, err := m.CWSkimmer.spotsLogger.GetCWSpotsAnalyticsHourly(country, continent, band, minSNR, hours, m.CTY)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Failed to get hourly CW analytics: %v", err)), nil
		}
		return mcpJSON(analytics)
	}
	analytics, err := m.CWSkimmer.spotsLogger.GetCWSpotsAnalytics(country, continent, band, minSNR, hours, m.CTY)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to get CW analytics: %v", err)), nil
	}
	return mcpJSON(analytics)
}

// mcpDXSpot is a DX cluster spot as the MCP tools return it: the parsed fields
// without the raw cluster line, which only repeats them.
type mcpDXSpot struct {
	Time         time.Time `json:"time"`
	DXCall       string    `json:"dx_call"`
	Spotter      string    `json:"spotter"`
	FrequencyHz  float64   `json:"frequency"`
	FrequencyKHz float64   `json:"frequency_khz"`
	Band         string    `json:"band"`
	Comment      string    `json:"comment"`
	Country      string    `json:"country,omitempty"`
	CountryCode  string    `json:"country_code,omitempty"`
	Continent    string    `json:"continent,omitempty"`
}

// filterDXSpots returns the spots newer than since that match the filters,
// newest first. band and continent match exactly (case-insensitive); callsign
// matches any part of the DX callsign.
func filterDXSpots(spots []DXSpot, since time.Time, band, callsign, continent string) []mcpDXSpot {
	callsign = strings.ToUpper(strings.TrimSpace(callsign))
	out := make([]mcpDXSpot, 0, len(spots))
	for _, s := range spots {
		if s.Time.Before(since) {
			continue
		}
		if band != "" && !strings.EqualFold(s.Band, band) {
			continue
		}
		if continent != "" && !strings.EqualFold(s.Continent, continent) {
			continue
		}
		if callsign != "" && !strings.Contains(strings.ToUpper(s.DXCall), callsign) {
			continue
		}
		out = append(out, mcpDXSpot{
			Time:         s.Time.UTC(),
			DXCall:       s.DXCall,
			Spotter:      s.Spotter,
			FrequencyHz:  s.Frequency,
			FrequencyKHz: s.Frequency / 1e3,
			Band:         s.Band,
			Comment:      s.Comment,
			Country:      s.Country,
			CountryCode:  s.CountryCode,
			Continent:    s.Continent,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.After(out[j].Time) })
	return out
}

func (m *MCPServer) handleGetDXClusterSpots(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.DXCluster == nil || m.config == nil || !m.config.DXCluster.Enabled {
		return mcp.NewToolResultError("The DX cluster feed is not enabled on this receiver"), nil
	}
	minutes := int(request.GetFloat("minutes", 60))
	if minutes < 1 {
		minutes = 60
	}
	if minutes > 1440 {
		minutes = 1440
	}

	spots := filterDXSpots(m.DXCluster.GetBufferedSpots(), time.Now().Add(-time.Duration(minutes)*time.Minute),
		request.GetString("band", ""), request.GetString("callsign", ""), request.GetString("continent", ""))

	return mcpJSON(map[string]interface{}{
		"connected": m.DXCluster.IsConnected(),
		"minutes":   minutes,
		"count":     len(spots),
		"spots":     spots,
	})
}

// mcpVoiceSignal is a detected SSB signal with the detector's internals (bin
// indices, spectral shape statistics) left out.
type mcpVoiceSignal struct {
	DialFrequencyHz  uint64   `json:"dial_frequency"`
	DialFrequencyKHz float64  `json:"dial_frequency_khz"`
	Mode             string   `json:"mode"`
	BandwidthHz      uint64   `json:"bandwidth"`
	SNR              float32  `json:"snr_db"`
	Confidence       float32  `json:"confidence"`
	DXCallsign       string   `json:"dx_callsign,omitempty"`
	DXCountry        string   `json:"dx_country,omitempty"`
	DXContinent      string   `json:"dx_continent,omitempty"`
	AlternativeDials []uint64 `json:"alternative_dial_frequencies,omitempty"`
}

func toMCPVoiceSignals(activities []VoiceActivity) []mcpVoiceSignal {
	out := make([]mcpVoiceSignal, 0, len(activities))
	for _, a := range activities {
		out = append(out, mcpVoiceSignal{
			DialFrequencyHz:  a.EstimatedDialFreq,
			DialFrequencyKHz: float64(a.EstimatedDialFreq) / 1e3,
			Mode:             a.Mode,
			BandwidthHz:      a.Bandwidth,
			SNR:              roundFloat32(a.SNR, 1),
			Confidence:       roundFloat32(a.Confidence, 2),
			DXCallsign:       a.DXCallsign,
			DXCountry:        a.DXCountry,
			DXContinent:      a.DXContinent,
			AlternativeDials: a.AlternativeDialFreqs,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DialFrequencyHz < out[j].DialFrequencyHz })
	return out
}

func roundFloat32(v float32, places int) float32 {
	return float32(roundTo(float64(v), places))
}

func (m *MCPServer) handleGetVoiceActivity(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.noiseFloorMonitor == nil {
		return mcp.NewToolResultError("Noise floor monitoring, which voice detection reads, is not enabled on this receiver"), nil
	}

	params := DefaultDetectionParams()
	if c := request.GetFloat("min_confidence", -1); c >= 0 {
		if c > 1 {
			return mcp.NewToolResultError("min_confidence must be between 0 and 1"), nil
		}
		params.MinConfidence = float32(c)
	}

	if !m.allowToolCall(ctx, "get_voice_activity") {
		return mcpRateLimited("get_voice_activity"), nil
	}

	band := request.GetString("band", "")
	if band != "" {
		activities, err := GetVoiceActivityForBand(m.noiseFloorMonitor, band, params)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("No voice data for band %s: %v", band, err)), nil
		}
		signals := toMCPVoiceSignals(activities)
		return mcpJSON(map[string]interface{}{
			"band":           band,
			"min_confidence": params.MinConfidence,
			"count":          len(signals),
			"signals":        signals,
		})
	}

	byBand := map[string][]mcpVoiceSignal{}
	total := 0
	for name, activities := range GetAllBandsVoiceActivity(m.noiseFloorMonitor, params) {
		byBand[name] = toMCPVoiceSignals(activities)
		total += len(byBand[name])
	}
	return mcpJSON(map[string]interface{}{
		"min_confidence": params.MinConfidence,
		"total_signals":  total,
		"bands":          byBand,
	})
}
