package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// Tools about the receiver as a station: how it ranks against other receivers,
// and how well its frequency reference is holding.

func (m *MCPServer) registerStationTools() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_station_rankings",
			mcpReadOnlyTool,
			mcp.WithDescription("Get this receiver's standing in the public leaderboards it reports to: PSK Reporter (rank by reports and by countries heard, last 24 hours), WSPR Live (rank by unique spots for the rolling 24 hours, yesterday and today) and the Reverse Beacon Network (rank by CW skimmer spot count). Each position has the rank, the value it is based on and the number of stations ranked. Optionally includes how the receiver's rank moved over the last 24 hours, 7 days or 30 days."),
			mcp.WithString("history",
				mcp.Description("Also return the receiver's rank history: 'none' (default), '24h' (every snapshot), '7d' or '30d' (one snapshot per day)"),
				mcp.Enum("none", "24h", "7d", "30d"),
			),
		),
		m.handleGetStationRankings,
	)

	m.mcpServer.AddTool(
		mcp.NewTool("get_frequency_reference",
			mcpReadOnlyTool,
			mcp.WithDescription("Get the state of the receiver's frequency reference tracking: a known reference signal is measured continuously, and its offset from the expected frequency shows how accurately the receiver is calibrated. Returns the current offset in Hz and parts per billion, signal strength and SNR, plus the last hour (per minute) and last day (per hour) of history with a summary of the drift. Use this to judge whether reported frequencies can be trusted to the hertz."),
		),
		m.handleGetFrequencyReference,
	)
}

// rankHistoryPoint is one snapshot of the receiver's rank on one service.
type rankHistoryPoint struct {
	At   string      `json:"at"`
	Rank interface{} `json:"rank"`
}

// lastPerUTCDay keeps the last of each UTC day's points, which arrive oldest
// first. Leaderboards are refreshed hourly; a month of every snapshot is more
// than a client can read, and the day's last one is its settled standing.
func lastPerUTCDay(points []rankHistoryPoint) []rankHistoryPoint {
	out := make([]rankHistoryPoint, 0, len(points))
	for _, p := range points {
		if n := len(out); n > 0 && len(out[n-1].At) >= 10 && len(p.At) >= 10 && out[n-1].At[:10] == p.At[:10] {
			out[n-1] = p
			continue
		}
		out = append(out, p)
	}
	return out
}

func (m *MCPServer) handleGetStationRankings(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	receiverCallsign := ""
	if m.config != nil {
		receiverCallsign = m.config.Decoder.ReceiverCallsign
	}
	cwCallsign := ""
	if m.cwskimmerConfig != nil {
		cwCallsign = m.cwskimmerConfig.Callsign
	}

	summary := BuildRankSummary(m.PSKRank, m.WSPRRank, m.RBNStore, receiverCallsign, cwCallsign)
	result := map[string]interface{}{"current": summary}

	period := request.GetString("history", "none")
	switch period {
	case "", "none":
		return mcpJSON(result)
	case "24h", "7d", "30d":
	default:
		return mcp.NewToolResultError("history must be 'none', '24h', '7d' or '30d'"), nil
	}
	if m.StatsLogger == nil {
		result["history_note"] = "rank history is not recorded on this receiver"
		return mcpJSON(result)
	}
	if !m.allowToolCall(ctx, "get_station_rankings") {
		return mcpRateLimited("get_station_rankings"), nil
	}

	params := func(callsign string) (StatsQueryParams, string) {
		return ParseStatsQueryParams(map[string][]string{"period": {period}, "callsign": {callsign}})
	}
	thin := func(points []rankHistoryPoint) []rankHistoryPoint {
		if period == "24h" {
			return points
		}
		return lastPerUTCDay(points)
	}

	history := map[string]interface{}{"period": period}
	if receiverCallsign != "" {
		p, errMsg := params(receiverCallsign)
		if errMsg != "" {
			return mcp.NewToolResultError(errMsg), nil
		}
		if records, err := m.StatsLogger.ReadWSPR(p); err == nil {
			points := []rankHistoryPoint{}
			for _, r := range records {
				if rank := wsprRankFor(r, p.Callsign); rank != nil {
					points = append(points, rankHistoryPoint{At: r.GeneratedAt.UTC().Format(time.RFC3339), Rank: rank})
				}
			}
			history["wspr"] = thin(points)
		} else {
			history["wspr_error"] = err.Error()
		}
		if records, err := m.StatsLogger.ReadPSK(p); err == nil {
			points := []rankHistoryPoint{}
			for _, r := range records {
				if rank := pskRankFor(r, p.Callsign); rank != nil {
					points = append(points, rankHistoryPoint{At: r.FetchedAt.UTC().Format(time.RFC3339), Rank: rank})
				}
			}
			history["psk_reporter"] = thin(points)
		} else {
			history["psk_reporter_error"] = err.Error()
		}
	}
	if cwCallsign != "" {
		p, errMsg := params(cwCallsign)
		if errMsg != "" {
			return mcp.NewToolResultError(errMsg), nil
		}
		// RBN is already stored as one record per day.
		if records, err := m.StatsLogger.ReadRBN(p); err == nil {
			points := []rankHistoryPoint{}
			for _, r := range records {
				if rank := rbnCallsignDataFor(r, p.Callsign); rank != nil {
					points = append(points, rankHistoryPoint{At: r.FetchedAt.UTC().Format(time.RFC3339), Rank: rank})
				}
			}
			history["rbn"] = points
		} else {
			history["rbn_error"] = err.Error()
		}
	}
	result["history"] = history
	return mcpJSON(result)
}

// freqRefDrift summarises offsets: their mean, spread and the change from the
// first to the last, each in Hz and parts per billion of the reference.
type freqRefDrift struct {
	Samples     int     `json:"samples"`
	From        string  `json:"from,omitempty"`
	To          string  `json:"to,omitempty"`
	MeanHz      float64 `json:"mean_offset_hz"`
	MinHz       float64 `json:"min_offset_hz"`
	MaxHz       float64 `json:"max_offset_hz"`
	SpreadHz    float64 `json:"spread_hz"`
	ChangeHz    float64 `json:"change_hz"`
	MeanPPB     float64 `json:"mean_offset_ppb"`
	SpreadPPB   float64 `json:"spread_ppb"`
	ChangePPB   float64 `json:"change_ppb"`
	MeanSNRDB   float64 `json:"mean_snr_db"`
	NoSignalPct float64 `json:"no_signal_pct"`
}

// summariseFreqRef folds a history into a freqRefDrift. Points with no detected
// signal (zero frequency) are counted but kept out of the offset figures, where
// they would read as a huge offset.
func summariseFreqRef(history []FrequencyReferenceHistory, expectedHz float64) freqRefDrift {
	d := freqRefDrift{Samples: len(history)}
	if len(history) == 0 {
		return d
	}
	d.From = history[0].Timestamp.UTC().Format(time.RFC3339)
	d.To = history[len(history)-1].Timestamp.UTC().Format(time.RFC3339)

	var sum, snrSum float64
	n, missing := 0, 0
	var first, last float64
	d.MinHz, d.MaxHz = math.Inf(1), math.Inf(-1)
	for _, h := range history {
		if h.DetectedFreq == 0 {
			missing++
			continue
		}
		if n == 0 {
			first = h.FrequencyOffset
		}
		last = h.FrequencyOffset
		sum += h.FrequencyOffset
		snrSum += float64(h.SNR)
		d.MinHz = math.Min(d.MinHz, h.FrequencyOffset)
		d.MaxHz = math.Max(d.MaxHz, h.FrequencyOffset)
		n++
	}
	d.NoSignalPct = roundTo(float64(missing)*100/float64(len(history)), 1)
	if n == 0 {
		d.MinHz, d.MaxHz = 0, 0
		return d
	}
	ppb := func(hz float64) float64 {
		if expectedHz <= 0 {
			return 0
		}
		return roundTo(hz/expectedHz*1e9, 2)
	}
	d.MeanHz = roundTo(sum/float64(n), 3)
	d.MeanSNRDB = roundTo(snrSum/float64(n), 1)
	d.SpreadHz = roundTo(d.MaxHz-d.MinHz, 3)
	d.ChangeHz = roundTo(last-first, 3)
	d.MinHz, d.MaxHz = roundTo(d.MinHz, 3), roundTo(d.MaxHz, 3)
	d.MeanPPB, d.SpreadPPB, d.ChangePPB = ppb(d.MeanHz), ppb(d.SpreadHz), ppb(d.ChangeHz)
	return d
}

func (m *MCPServer) handleGetFrequencyReference(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.freqRefMonitor == nil {
		return mcp.NewToolResultError("Frequency reference tracking is not enabled on this receiver"), nil
	}

	status := m.freqRefMonitor.GetStatus()
	// The live spectrum is for drawing a chart; to a reader it is a thousand
	// meaningless numbers.
	for _, k := range []string{"spectrum_data", "peak_bin", "bin_count", "bin_bandwidth"} {
		delete(status, k)
	}

	var expectedHz float64
	switch v := status["expected_frequency"].(type) {
	case uint64:
		expectedHz = float64(v)
	case int:
		expectedHz = float64(v)
	case int64:
		expectedHz = float64(v)
	case float64:
		expectedHz = v
	}
	if off, ok := status["frequency_offset"].(float64); ok && expectedHz > 0 {
		status["frequency_offset_ppb"] = roundTo(off/expectedHz*1e9, 2)
	}

	minutes := m.freqRefMonitor.GetHistory()
	hours := m.freqRefMonitor.GetHourlyHistory()
	return mcpJSON(map[string]interface{}{
		"current":           status,
		"last_hour_summary": summariseFreqRef(minutes, expectedHz),
		"last_day_summary":  summariseFreqRef(hours, expectedHz),
		"per_minute":        minutes,
		"per_hour":          hours,
		"note":              fmt.Sprintf("offsets are measured on the reference signal at %.0f Hz; ppb (parts per billion) scales them to any frequency: at 14 MHz, 1 ppb is 0.014 Hz", expectedHz),
	})
}
