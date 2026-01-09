package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
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
	IsDecoderChannel  bool      `json:"is_decoder_channel"` // True if this is a UberSDR decoder channel
	DecoderBandName   string    `json:"decoder_band_name"`  // Name of decoder band if applicable
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

	// Build decoder SSRC map for quick lookup
	decoderSSRCs := make(map[uint32]string) // SSRC -> band name
	if ah.multiDecoder != nil {
		for name, band := range ah.multiDecoder.decoderBands {
			decoderSSRCs[band.SSRC] = name
		}
	}

	// Convert to display format
	channels := make([]RadiodChannelInfo, 0, len(allChannelStatus))
	decoderCount := 0
	otherCount := 0

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

		// Check if this is a decoder channel
		bandName, isDecoder := decoderSSRCs[ssrc]
		if isDecoder {
			decoderCount++
		} else {
			otherCount++
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
			IsDecoderChannel:  isDecoder,
			DecoderBandName:   bandName,
		}

		channels = append(channels, channelInfo)
	}

	// Sort channels by frequency
	sort.Slice(channels, func(i, j int) bool {
		return channels[i].Frequency < channels[j].Frequency
	})

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
