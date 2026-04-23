package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// threadStat holds the parsed data for a single thread from the CSV.
type threadStat struct {
	cpuPct float64
	cpuNum int
}

// ThreadCPUStats holds the summarised CPU usage from the radiod thread-stats CSV.
// All *Pct fields are percentages of one logical CPU (100 = one full core).
// Available is false when the CSV file has not been written yet (radiod just started).
// The five Pct fields sum to TotalPct:
//
//	TotalPct = ProcRx888Pct + FftPct + RadioStatPct + ChannelsPct + OtherPct
//
// NumLogicalCPUs is runtime.NumCPU() — the number of logical CPUs visible to this
// process (includes HT siblings).  Divide any *Pct value by NumLogicalCPUs to get
// the fraction of total system CPU capacity used by that group.
type ThreadCPUStats struct {
	Available      bool    `json:"available"`
	NumLogicalCPUs int     `json:"num_logical_cpus"` // runtime.NumCPU()
	ProcRx888Pct   float64 `json:"proc_rx888_pct"`   // sum of proc_rx888 threads
	FftPct         float64 `json:"fft_pct"`          // sum of fft* threads
	ChannelsPct    float64 `json:"channels_pct"`     // sum of threads matched to a channel SSRC (lin/spect/…)
	OtherPct       float64 `json:"other_pct"`        // everything else (radio stat, radiod main, libusb_event, agc_rx888, …)
	TotalPct       float64 `json:"total_pct"`        // grand total of all threads
}

// RadiodChannelInfo represents a summary of a radiod channel for display
type RadiodChannelInfo struct {
	SSRC              string    `json:"ssrc"`
	Frequency         float64   `json:"frequency"`     // Hz
	FrequencyMHz      string    `json:"frequency_mhz"` // Formatted for display
	Preset            string    `json:"preset"`
	DemodType         string    `json:"demod_type"`
	OutputSamprate    int       `json:"output_samprate"`     // Hz
	OutputSampratekHz string    `json:"output_samprate_khz"` // Formatted for display
	FilterLow         float32   `json:"filter_low"`          // Hz
	FilterHigh        float32   `json:"filter_high"`         // Hz
	BasebandPower     float32   `json:"baseband_power"`      // dBFS
	NoiseDensity      float32   `json:"noise_density"`       // dBFS
	SNR               float32   `json:"snr"`                 // dB (calculated)
	OutputDataPackets int64     `json:"output_data_packets"`
	LastUpdate        time.Time `json:"last_update"`
	TimeSinceUpdate   string    `json:"time_since_update"`
	ChannelType       string    `json:"channel_type"`   // "decoder", "noisefloor", "reference", "user_audio", "user_spectrum", "unknown"
	ChannelName       string    `json:"channel_name"`   // Descriptive name based on type
	SessionID         string    `json:"session_id"`     // UberSDR session ID if applicable
	IsInternal        bool      `json:"is_internal"`    // True for decoder/noisefloor channels
	ThreadCPUPct      float64   `json:"thread_cpu_pct"` // CPU% of the thread matched to this channel's SSRC; 0 if not found
	ThreadCPUNum      int       `json:"thread_cpu_num"` // CPU core the thread last ran on; -1 if not found
}

// RadiodChannelsResponse is the API response for all radiod channels
type RadiodChannelsResponse struct {
	Channels      []RadiodChannelInfo `json:"channels"`
	TotalChannels int                 `json:"total_channels"`
	DecoderCount  int                 `json:"decoder_count"`
	OtherCount    int                 `json:"other_count"`
	LastUpdate    time.Time           `json:"last_update"`
	CPUStats      ThreadCPUStats      `json:"cpu_stats"`
}

// threadStatsPath is the CSV written by the radiod container every 2 seconds.
const threadStatsPath = "/var/run/restart-trigger/radiod-thread-stats.csv"

// readThreadStats parses the radiod thread-stats CSV and returns:
//   - a map from thread name → threadStat (all rows, including duplicates summed)
//   - available: false if the file does not exist yet
//
// The CSV format is:  name,cpu_pct,cpu_num
// Thread names may contain spaces (e.g. "lin 215227422", "radio stat").
// When multiple rows share the same name their cpu_pct values are summed and
// cpu_num is taken from the last row (arbitrary but consistent).
func readThreadStats() (map[string]threadStat, bool) {
	f, err := os.Open(threadStatsPath)
	if err != nil {
		// File not present yet — radiod hasn't written its first sample
		return nil, false
	}
	defer f.Close()

	stats := make(map[string]threadStat)
	scanner := bufio.NewScanner(f)
	firstLine := true
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		// Skip header row
		if firstLine {
			firstLine = false
			if strings.HasPrefix(line, "name") {
				continue
			}
		}
		// Split on the last two commas so thread names with spaces are preserved.
		// Format: <name>,<cpu_pct>,<cpu_num>
		// We split from the right: find last comma for cpu_num, then second-to-last for cpu_pct.
		lastComma := strings.LastIndex(line, ",")
		if lastComma < 0 {
			continue
		}
		cpuNumStr := line[lastComma+1:]
		rest := line[:lastComma]

		secondComma := strings.LastIndex(rest, ",")
		if secondComma < 0 {
			continue
		}
		cpuPctStr := rest[secondComma+1:]
		name := rest[:secondComma]

		cpuPct, err := strconv.ParseFloat(strings.TrimSpace(cpuPctStr), 64)
		if err != nil {
			continue
		}
		cpuNum, err := strconv.Atoi(strings.TrimSpace(cpuNumStr))
		if err != nil {
			continue
		}

		// Accumulate: sum cpu_pct for duplicate names, keep last cpu_num
		existing := stats[name]
		stats[name] = threadStat{
			cpuPct: existing.cpuPct + cpuPct,
			cpuNum: cpuNum,
		}
	}
	return stats, true
}

// matchThreadToSSRC searches threadStats for a thread whose name contains the
// decimal representation of ssrc as a whitespace-delimited token.
// Returns the matched threadStat and true, or a zero value and false.
func matchThreadToSSRC(threadStats map[string]threadStat, ssrc uint32) (threadStat, bool) {
	target := strconv.FormatUint(uint64(ssrc), 10)
	for name, stat := range threadStats {
		// Split name on spaces and check each token
		for _, token := range strings.Fields(name) {
			if token == target {
				return stat, true
			}
		}
	}
	return threadStat{}, false
}

// getUnknownChannelSSRCs returns a list of SSRCs that exist in radiod but not in the session manager
// This identifies orphaned channels that should be cleaned up
func getUnknownChannelSSRCs(sessions *SessionManager, multiDecoder *MultiDecoder) []uint32 {
	// Get all channel status from radiod
	allChannelStatus := sessions.radiod.GetAllChannelStatus()
	if len(allChannelStatus) == 0 {
		return nil
	}

	// Build map of known SSRCs from sessions
	knownSSRCs := make(map[uint32]bool)

	sessions.mu.RLock()
	for _, session := range sessions.sessions {
		knownSSRCs[session.SSRC] = true
	}
	sessions.mu.RUnlock()

	// Also add decoder SSRCs if multiDecoder exists
	// (though decoders should also have sessions, this is a safety check)
	if multiDecoder != nil {
		for _, band := range multiDecoder.decoderBands {
			knownSSRCs[band.SSRC] = true
		}
	}

	// Find unknown SSRCs (only count channels with non-zero frequency)
	unknownSSRCs := make([]uint32, 0)
	for ssrc, status := range allChannelStatus {
		if !knownSSRCs[ssrc] && status.RadioFrequency != 0 {
			unknownSSRCs = append(unknownSSRCs, ssrc)
		}
	}

	return unknownSSRCs
}

// HandleRadiodChannels returns all active radiod channels
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func (ah *AdminHandler) HandleRadiodChannels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get all channel status from radiod (via sessions)
	allChannelStatus := ah.sessions.radiod.GetAllChannelStatus()

	// Debug: log the count
	log.Printf("DEBUG: Radiod Channels API - GetAllChannelStatus returned %d channels", len(allChannelStatus))

	// Also log session count for comparison
	ah.sessions.mu.RLock()
	sessionCount := len(ah.sessions.sessions)
	ah.sessions.mu.RUnlock()
	log.Printf("DEBUG: Radiod Channels API - SessionManager has %d sessions", sessionCount)

	// If no STATUS packets received yet, build channel list from sessions instead
	// This ensures we show something even if radiod hasn't sent STATUS packets
	if len(allChannelStatus) == 0 {
		log.Printf("DEBUG: No STATUS packets received from radiod, building from sessions")
		allChannelStatus = make(map[uint32]*ChannelStatus)

		// Add all sessions to the channel status map with minimal info
		ah.sessions.mu.RLock()
		for _, session := range ah.sessions.sessions {
			allChannelStatus[session.SSRC] = &ChannelStatus{
				SSRC:           session.SSRC,
				RadioFrequency: float64(session.Frequency),
				Preset:         session.Mode,
				OutputSamprate: session.SampleRate,
				LastUpdate:     session.LastActive,
			}
		}
		ah.sessions.mu.RUnlock()

		log.Printf("DEBUG: Built %d channels from sessions", len(allChannelStatus))
	}

	// Build maps for quick lookup of different channel types
	decoderSSRCs := make(map[uint32]string) // SSRC -> decoder band name
	sessionSSRCs := make(map[uint32]string) // SSRC -> session ID
	sessionTypes := make(map[uint32]string) // SSRC -> "audio" or "spectrum"

	// Map decoder channels
	if ah.multiDecoder != nil {
		for name, band := range ah.multiDecoder.decoderBands {
			decoderSSRCs[band.SSRC] = name
		}
	}

	// Map all sessions (user, noise floor, decoder, etc.)
	ah.sessions.mu.RLock()
	for sessionID, session := range ah.sessions.sessions {
		sessionSSRCs[session.SSRC] = sessionID
		if session.IsSpectrum {
			sessionTypes[session.SSRC] = "spectrum"
		} else {
			sessionTypes[session.SSRC] = "audio"
		}
	}
	ah.sessions.mu.RUnlock()

	// Convert to display format
	channels := make([]RadiodChannelInfo, 0, len(allChannelStatus))
	decoderCount := 0
	noiseFloorCount := 0
	userCount := 0

	for ssrc, status := range allChannelStatus {
		// Determine demod type string
		demodType := "Unknown"
		switch status.DemodType {
		case 0:
			demodType = "Linear"
		case 1:
			demodType = "FM"
		case 2:
			demodType = "WFM"
		case 3:
			demodType = "Spectrum"
		}

		// Calculate SNR if we have both baseband power and noise density
		var snr float32
		if status.BasebandPower > -200 && status.NoiseDensity > -200 {
			// SNR = (Signal - Noise) / Noise in linear, then convert to dB
			// In dBFS: SNR_dB = BasebandPower_dBFS - NoiseDensity_dBFS
			snr = status.BasebandPower - status.NoiseDensity
		}

		// Format time since update
		timeSinceUpdate := "N/A"
		if !status.LastUpdate.IsZero() {
			duration := time.Since(status.LastUpdate)
			if duration < time.Minute {
				timeSinceUpdate = duration.Round(time.Second).String()
			} else if duration < time.Hour {
				timeSinceUpdate = duration.Round(time.Second).String()
			} else {
				timeSinceUpdate = duration.Round(time.Minute).String()
			}
		}

		// Determine channel type and name by examining session ID patterns
		var channelType, channelName, sessionID string
		var isInternal bool

		if decoderName, isDecoder := decoderSSRCs[ssrc]; isDecoder {
			// This is a decoder channel
			channelType = "decoder"
			channelName = fmt.Sprintf("Decoder: %s", decoderName)
			isInternal = true
			decoderCount++
			if sessID, hasSession := sessionSSRCs[ssrc]; hasSession {
				sessionID = sessID
			}
		} else if sessID, hasSession := sessionSSRCs[ssrc]; hasSession {
			// This is a session - determine type from session ID prefix
			sessionID = sessID

			if len(sessID) >= 10 && sessID[:10] == "noisefloor" {
				// Noise floor session
				channelType = "noisefloor"
				isInternal = true
				noiseFloorCount++

				// Extract band name from session ID (format: "noisefloor-BANDNAME-XXXXXXXX")
				parts := strings.Split(sessID, "-")
				if len(parts) >= 2 {
					channelName = fmt.Sprintf("Noise Floor: %s", parts[1])
				} else {
					channelName = "Noise Floor"
				}
			} else if len(sessID) >= 19 && sessID[:19] == "frequency-reference" {
				// Frequency reference session
				channelType = "reference"
				channelName = "Frequency Reference"
				isInternal = true
				noiseFloorCount++ // Count with noise floor for internal channels
			} else {
				// User session (audio or spectrum)
				isInternal = false
				userCount++

				if sessionTypes[ssrc] == "spectrum" {
					channelType = "user_spectrum"
					channelName = "User Spectrum"
				} else {
					channelType = "user_audio"
					channelName = "User Audio"
				}
			}
		} else {
			// Unknown channel (not in our session map)
			channelType = "unknown"
			channelName = "Unknown"
			isInternal = false
		}

		// Sanitize float values to avoid JSON encoding errors (replace Inf/NaN with 0)
		sanitizeFloat32 := func(f float32) float32 {
			if math.IsInf(float64(f), 0) || math.IsNaN(float64(f)) {
				return 0
			}
			return f
		}

		channelInfo := RadiodChannelInfo{
			SSRC:              fmt.Sprintf("0x%08x", ssrc),
			Frequency:         status.RadioFrequency,
			FrequencyMHz:      fmt.Sprintf("%.6f", status.RadioFrequency/1e6),
			Preset:            status.Preset,
			DemodType:         demodType,
			OutputSamprate:    status.OutputSamprate,
			OutputSampratekHz: fmt.Sprintf("%.1f", float64(status.OutputSamprate)/1e3),
			FilterLow:         sanitizeFloat32(status.LowEdge),
			FilterHigh:        sanitizeFloat32(status.HighEdge),
			BasebandPower:     sanitizeFloat32(status.BasebandPower),
			NoiseDensity:      sanitizeFloat32(status.NoiseDensity),
			SNR:               sanitizeFloat32(snr),
			OutputDataPackets: status.OutputDataPackets,
			LastUpdate:        status.LastUpdate,
			TimeSinceUpdate:   timeSinceUpdate,
			ChannelType:       channelType,
			ChannelName:       channelName,
			SessionID:         sessionID,
			IsInternal:        isInternal,
		}

		channels = append(channels, channelInfo)
	}

	// ── Thread CPU stats ──────────────────────────────────────────────────────
	threadStats, statsAvailable := readThreadStats()

	cpuStats := ThreadCPUStats{
		Available:      statsAvailable,
		NumLogicalCPUs: runtime.NumCPU(),
	}

	if statsAvailable {
		// Build a set of SSRCs present in the channel list for fast lookup
		channelSSRCs := make(map[uint32]bool, len(channels))
		for _, ch := range channels {
			// Parse the hex SSRC string back to uint32
			var ssrcVal uint32
			if _, err := fmt.Sscanf(ch.SSRC, "0x%08x", &ssrcVal); err == nil {
				channelSSRCs[ssrcVal] = true
			}
		}

		for name, stat := range threadStats {
			cpuStats.TotalPct += stat.cpuPct

			nameLower := strings.ToLower(name)
			switch {
			case nameLower == "proc_rx888":
				cpuStats.ProcRx888Pct += stat.cpuPct
			case strings.HasPrefix(nameLower, "fft"):
				cpuStats.FftPct += stat.cpuPct
			default:
				// Check if this thread belongs to a known channel SSRC
				matchedChannel := false
				for _, token := range strings.Fields(name) {
					if v, err := strconv.ParseUint(token, 10, 32); err == nil {
						if channelSSRCs[uint32(v)] {
							cpuStats.ChannelsPct += stat.cpuPct
							matchedChannel = true
							break
						}
					}
				}
				if !matchedChannel {
					cpuStats.OtherPct += stat.cpuPct
				}
			}
		}

		// Round to 1 decimal place to avoid floating-point noise
		round1 := func(f float64) float64 {
			return math.Round(f*10) / 10
		}
		cpuStats.ProcRx888Pct = round1(cpuStats.ProcRx888Pct)
		cpuStats.FftPct = round1(cpuStats.FftPct)
		cpuStats.ChannelsPct = round1(cpuStats.ChannelsPct)
		cpuStats.OtherPct = round1(cpuStats.OtherPct)
		cpuStats.TotalPct = round1(cpuStats.TotalPct)
	}

	// Attach per-channel thread CPU info
	for i := range channels {
		channels[i].ThreadCPUNum = -1 // default: no match
		if statsAvailable {
			var ssrcVal uint32
			if _, err := fmt.Sscanf(channels[i].SSRC, "0x%08x", &ssrcVal); err == nil {
				if stat, found := matchThreadToSSRC(threadStats, ssrcVal); found {
					channels[i].ThreadCPUPct = math.Round(stat.cpuPct*10) / 10
					channels[i].ThreadCPUNum = stat.cpuNum
				}
			}
		}
	}

	// Sort channels by frequency
	sort.Slice(channels, func(i, j int) bool {
		return channels[i].Frequency < channels[j].Frequency
	})

	// Calculate other count (total - decoder - noisefloor)
	otherCount := len(channels) - decoderCount - noiseFloorCount

	log.Printf("DEBUG: Built %d channel info structs (decoder=%d, noisefloor=%d, user=%d, other=%d)",
		len(channels), decoderCount, noiseFloorCount, userCount, otherCount)

	response := RadiodChannelsResponse{
		Channels:      channels,
		TotalChannels: len(channels),
		DecoderCount:  decoderCount,
		OtherCount:    otherCount,
		LastUpdate:    time.Now(),
		CPUStats:      cpuStats,
	}

	log.Printf("DEBUG: Sending response with %d channels", len(response.Channels))

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("ERROR: Failed to encode radiod channels response: %v", err)
		http.Error(w, fmt.Sprintf("Failed to encode response: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("DEBUG: Response sent successfully")
}
