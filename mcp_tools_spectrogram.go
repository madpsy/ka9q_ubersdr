package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// get_spectrogram: the recorded waterfall of the last 24 hours as an image a
// vision-capable client can look at, with the numbers behind it alongside.
//
// It reads the same rolling 24-hour window the spectrogram page shows, but
// renders it at a fixed size suited to a model's image input instead of one
// pixel per bin and minute, which for the wideband recorder is thousands of
// pixels wide.

const (
	mcpSpectrogramMaxW = 1024
	mcpSpectrogramMinW = 256
	mcpSpectrogramMaxH = 720
	mcpSpectrogramMinH = 120
)

func (m *MCPServer) registerSpectrogramTool() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_spectrogram",
			mcpReadOnlyTool,
			mcp.WithDescription("Get the receiver's recorded spectrogram (waterfall) for up to the last 24 hours as a PNG image, plus a text summary with the frequency and time axes, the colour scale, and the noise floor and signal level for each hour. In the image, time runs top (oldest) to bottom (newest) at one row per minute, frequency runs left (lowest) to right (highest), and colour shows signal strength (see the summary for the scale). Use this to see when bands opened and closed, spot interference or broadcasts across the day, or compare activity by time. Bands: 'wideband' (the whole receiver), 'wideband-hf' (1.8-30 MHz), or a monitored amateur band such as '20m'."),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Which recording: 'wideband' (default), 'wideband-hf', or a band name such as '40m'"),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(24),
				mcp.Description("How many of the most recent hours to show, 1-24 (default: 24)"),
				mcp.DefaultNumber(24),
			),
			mcp.WithNumber("freq_min_khz",
				mcp.Min(0),
				mcp.Max(1000000),
				mcp.Description("Crop: lowest frequency to show, in kHz"),
			),
			mcp.WithNumber("freq_max_khz",
				mcp.Min(0),
				mcp.Max(1000000),
				mcp.Description("Crop: highest frequency to show, in kHz"),
			),
		),
		m.handleGetSpectrogram,
	)
}

// BandSpectrogramsOrEmpty is BandSpectrograms, never nil.
func (m *MCPServer) BandSpectrogramsOrEmpty() map[string]*SpectrogramRecorder {
	if m.BandSpectrograms == nil {
		return map[string]*SpectrogramRecorder{}
	}
	return m.BandSpectrograms
}

// spectrogramHourSummary is one hour of the per-minute row statistics.
type spectrogramHourSummary struct {
	HourStartUTC string  `json:"hour_start_utc"`
	Minutes      int     `json:"minutes_with_data"`
	NoiseFloorDB float64 `json:"noise_floor_db"` // mean of each minute's 5th percentile
	SignalDB     float64 `json:"signal_db"`      // mean of each minute's 95th percentile
	SpreadDB     float64 `json:"spread_db"`      // signal minus noise floor
}

// rowHasData reports whether a spectrogram row holds any measurement; missing
// minutes are filled with the no-data sentinel.
func rowHasData(row []float32) bool {
	for _, v := range row {
		if !math.IsInf(float64(v), -1) && !math.IsNaN(float64(v)) {
			return true
		}
	}
	return false
}

// summariseSpectrogramHours groups rows by UTC hour, using each minute's
// recorded P5 and P95, or computing them from the row (cropped to the shown
// bins) when the recorder did not keep them.
func summariseSpectrogramHours(rows [][]float32, meta []SpectrogramRowMeta, startBin, endBin int) []spectrogramHourSummary {
	type acc struct {
		n           int
		noise, peak float64
	}
	byHour := map[int64]*acc{}
	for i, row := range rows {
		if i >= len(meta) || !rowHasData(row) {
			continue
		}
		cells := row
		if endBin > startBin && endBin <= len(row) {
			cells = row[startBin:endBin]
		}
		valid := make([]float32, 0, len(cells))
		for _, v := range cells {
			if !math.IsInf(float64(v), -1) && !math.IsNaN(float64(v)) {
				valid = append(valid, v)
			}
		}
		if len(valid) == 0 {
			continue
		}
		hour := meta[i].Unix - meta[i].Unix%3600
		a := byHour[hour]
		if a == nil {
			a = &acc{}
			byHour[hour] = a
		}
		a.n++
		a.noise += float64(rowP5(valid))
		a.peak += float64(rowP95(valid))
	}

	hours := make([]int64, 0, len(byHour))
	for h := range byHour {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i] < hours[j] })
	out := make([]spectrogramHourSummary, 0, len(hours))
	for _, h := range hours {
		a := byHour[h]
		noise, peak := a.noise/float64(a.n), a.peak/float64(a.n)
		out = append(out, spectrogramHourSummary{
			HourStartUTC: time.Unix(h, 0).UTC().Format(time.RFC3339),
			Minutes:      a.n,
			NoiseFloorDB: roundTo(noise, 1),
			SignalDB:     roundTo(peak, 1),
			SpreadDB:     roundTo(peak-noise, 1),
		})
	}
	return out
}

// spectrogramImageSize picks the rendered size: one pixel per bin and minute
// where that fits, within the bounds a model's image input handles well.
func spectrogramImageSize(bins, rows int) (int, int) {
	w := bins
	if w > mcpSpectrogramMaxW {
		w = mcpSpectrogramMaxW
	}
	if w < mcpSpectrogramMinW {
		w = mcpSpectrogramMinW
	}
	h := rows
	if h > mcpSpectrogramMaxH {
		h = mcpSpectrogramMaxH
	}
	if h < mcpSpectrogramMinH {
		h = mcpSpectrogramMinH
	}
	return w, h
}

func (m *MCPServer) handleGetSpectrogram(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	band := strings.TrimSpace(request.GetString("band", ""))
	if band == "" {
		band = "wideband"
	}
	var rec *SpectrogramRecorder
	freqMinHz := request.GetFloat("freq_min_khz", 0) * 1e3
	freqMaxHz := request.GetFloat("freq_max_khz", 0) * 1e3
	switch band {
	case "wideband", "wideband-hf":
		rec = m.Spectrogram
		if band == "wideband-hf" && freqMinHz < 1_800_000 {
			freqMinHz = 1_800_000
		}
	default:
		rec = m.BandSpectrogramsOrEmpty()[band]
		if rec == nil && m.Spectrogram != nil {
			names := make([]string, 0, len(m.BandSpectrograms))
			for n := range m.BandSpectrograms {
				names = append(names, n)
			}
			sort.Strings(names)
			return mcp.NewToolResultError(fmt.Sprintf("No spectrogram is recorded for band %q; available: wideband, wideband-hf, %s",
				band, strings.Join(names, ", "))), nil
		}
	}
	if rec == nil {
		return mcp.NewToolResultError("Spectrogram recording is not enabled on this receiver"), nil
	}
	if freqMaxHz > 0 && freqMaxHz <= freqMinHz {
		return mcp.NewToolResultError("freq_max_khz must be above freq_min_khz"), nil
	}

	hours := mcpHoursParam(request, 24, 24)
	if !m.allowToolCall(ctx, "get_spectrogram") {
		return mcpRateLimited("get_spectrogram"), nil
	}

	rr := rec.getRolling24hRows()
	if rr == nil || len(rr.rows) == 0 {
		return mcp.NewToolResultError("No spectrogram data has been recorded yet"), nil
	}
	rows, meta := rr.rows, rr.metaRows
	if len(meta) < len(rows) {
		rows = rows[:len(meta)]
	}

	// The most recent N hours. rr is shared with other requests, so slice it
	// rather than modifying it.
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour).Unix()
	first := sort.Search(len(rows), func(i int) bool { return meta[i].Unix >= cutoff })
	rows, meta = rows[first:], meta[first:]
	if len(rows) == 0 || !anyRowHasData(rows) {
		return mcp.NewToolResultError(fmt.Sprintf("No spectrogram data in the last %d hours", hours)), nil
	}

	startHz, endHz := float64(rec.startFreqHz), float64(rec.endFreqHz)
	sb, eb := binSliceForFreqRange(startHz, endHz, rr.binCount, freqMinHz, freqMaxHz)
	binHz := (endHz - startHz) / float64(rr.binCount)
	dbMin, dbMax := autoRangeRowsSlice(rows, sb, eb, spectrogramDefaultDBMin, spectrogramDefaultDBMax)

	w, h := spectrogramImageSize(eb-sb, len(rows))
	png := renderRowsScaled(rows, spectrogramDefaultPalette, dbMin, dbMax, rr.binCount, sb, eb, w, h)
	if len(png) == 0 {
		return mcp.NewToolResultError("Failed to render the spectrogram"), nil
	}

	summary := map[string]interface{}{
		"band": band,
		"frequency_axis": map[string]interface{}{
			"left_khz":     roundTo((startHz+float64(sb)*binHz)/1e3, 1),
			"right_khz":    roundTo((startHz+float64(eb)*binHz)/1e3, 1),
			"khz_per_px":   roundTo(float64(eb-sb)*binHz/1e3/float64(w), 3),
			"orientation":  "frequency increases left to right",
			"recorded_bin": fmt.Sprintf("%.0f Hz", binHz),
		},
		"time_axis": map[string]interface{}{
			"top_utc":     time.Unix(meta[0].Unix, 0).UTC().Format(time.RFC3339),
			"bottom_utc":  time.Unix(meta[len(meta)-1].Unix, 0).UTC().Format(time.RFC3339),
			"minutes":     len(rows),
			"orientation": "oldest at the top, newest at the bottom; one recorded row per minute",
		},
		"colour_scale": map[string]interface{}{
			"palette": "jet: dark blue (weakest) through blue, cyan, yellow and red to dark red (strongest); black means no data was recorded for that minute",
			"min_db":  roundTo(float64(dbMin), 1),
			"max_db":  roundTo(float64(dbMax), 1),
			"units":   "dBFS, power relative to the receiver's full scale",
		},
		"image_size":   fmt.Sprintf("%dx%d", w, h),
		"hourly_level": summariseSpectrogramHours(rows, meta, sb, eb),
	}
	text, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to marshal data: %v", err)), nil
	}
	return mcp.NewToolResultImage(string(text), base64.StdEncoding.EncodeToString(png), "image/png"), nil
}

func anyRowHasData(rows [][]float32) bool {
	for _, r := range rows {
		if rowHasData(r) {
			return true
		}
	}
	return false
}
