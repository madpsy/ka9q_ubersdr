package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

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
	ChannelType       string    `json:"channel_type"` // "decoder", "noisefloor", "user_audio", "user_spectrum", "unknown"
	ChannelName       string    `json:"channel_name"` // Descriptive name based on type
	SessionID         string    `json:"session_id"`   // UberSDR session ID if applicable
	IsInternal        bool      `json:"is_internal"`  // True for decoder/noisefloor channels
}

// RadiodChannelsResponse is the API response for all radiod channels
type RadiodChannelsResponse struct {
	Channels      []RadiodChannelInfo `json:"channels"`
	TotalChannels int                 `json:"total_channels"`
	DecoderCount  int                 `json:"decoder_count"`
	OtherCount    int                 `json:"other_count"`
	LastUpdate    time.Time           `json:"last_update"`
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

		channelInfo := RadiodChannelInfo{
			SSRC:              fmt.Sprintf("0x%08x", ssrc),
			Frequency:         status.RadioFrequency,
			FrequencyMHz:      fmt.Sprintf("%.6f", status.RadioFrequency/1e6),
			Preset:            status.Preset,
			DemodType:         demodType,
			OutputSamprate:    status.OutputSamprate,
			OutputSampratekHz: fmt.Sprintf("%.1f", float64(status.OutputSamprate)/1e3),
			FilterLow:         status.LowEdge,
			FilterHigh:        status.HighEdge,
			BasebandPower:     status.BasebandPower,
			NoiseDensity:      status.NoiseDensity,
			SNR:               snr,
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

	// Sort channels by frequency
	sort.Slice(channels, func(i, j int) bool {
		return channels[i].Frequency < channels[j].Frequency
	})

	// Calculate other count (total - decoder - noisefloor)
	otherCount := len(channels) - decoderCount - noiseFloorCount

	response := RadiodChannelsResponse{
		Channels:      channels,
		TotalChannels: len(channels),
		DecoderCount:  decoderCount,
		OtherCount:    otherCount,
		LastUpdate:    time.Now(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
