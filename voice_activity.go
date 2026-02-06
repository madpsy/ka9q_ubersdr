package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// VoiceActivity represents a detected voice signal block
type VoiceActivity struct {
	StartFreq          uint64  `json:"start_freq"`           // Start frequency in Hz
	EndFreq            uint64  `json:"end_freq"`             // End frequency in Hz
	Bandwidth          uint64  `json:"bandwidth"`            // Bandwidth in Hz
	AvgSignalDB        float32 `json:"avg_signal_db"`        // Average signal strength in dB
	SignalAboveNoise   float32 `json:"signal_above_noise"`   // Signal strength above noise floor in dB
	EstimatedDialFreq  uint64  `json:"estimated_dial_freq"`  // Estimated dial frequency in Hz (500 Hz increments)
	Mode               string  `json:"mode"`                 // USB or LSB
	PeakSignalDB       float32 `json:"peak_signal_db"`       // Peak signal strength in dB
	StartBin           int     `json:"start_bin"`            // Start bin index
	EndBin             int     `json:"end_bin"`              // End bin index
}

// VoiceActivityResponse represents the API response
type VoiceActivityResponse struct {
	Band           string           `json:"band"`
	Timestamp      string           `json:"timestamp"`
	NoiseFloorDB   float32          `json:"noise_floor_db"`
	ThresholdDB    float32          `json:"threshold_db"`
	MinBandwidth   uint64           `json:"min_bandwidth"`
	MaxBandwidth   uint64           `json:"max_bandwidth"`
	Activities     []VoiceActivity  `json:"activities"`
	TotalActivities int             `json:"total_activities"`
}

// detectVoiceActivity analyzes FFT data to find voice activity
func detectVoiceActivity(fft *BandFFT, thresholdDB float32, minBandwidth, maxBandwidth uint64) []VoiceActivity {
	if fft == nil || len(fft.Data) == 0 {
		return []VoiceActivity{}
	}

	// Calculate noise floor (5th percentile)
	noiseFloor := calculateNoiseFloor(fft.Data)
	
	// Find bins above threshold
	threshold := noiseFloor + thresholdDB
	
	// Group contiguous bins above threshold, allowing small gaps (up to 3 bins)
	// This is more realistic for voice signals which have varying frequency components
	activities := []VoiceActivity{}
	var currentActivity *VoiceActivity
	gapCounter := 0
	maxGap := 3 // Allow up to 3 consecutive bins below threshold within a signal
	
	for i, signalDB := range fft.Data {
		freq := fft.StartFreq + uint64(float64(i)*fft.BinWidth)
		
		if signalDB > threshold {
			if currentActivity == nil {
				// Start new activity
				currentActivity = &VoiceActivity{
					StartFreq:    freq,
					StartBin:     i,
					AvgSignalDB:  signalDB,
					PeakSignalDB: signalDB,
				}
			} else {
				// Continue current activity
				currentActivity.EndFreq = freq
				currentActivity.EndBin = i
				// Update running average (only count bins above threshold)
				binCount := float32(currentActivity.EndBin - currentActivity.StartBin + 1)
				currentActivity.AvgSignalDB = ((currentActivity.AvgSignalDB * (binCount - 1)) + signalDB) / binCount
				// Update peak
				if signalDB > currentActivity.PeakSignalDB {
					currentActivity.PeakSignalDB = signalDB
				}
			}
			gapCounter = 0 // Reset gap counter
		} else {
			// Below threshold
			if currentActivity != nil {
				gapCounter++
				if gapCounter > maxGap {
					// Gap too large, end current activity
					currentActivity.EndFreq = fft.StartFreq + uint64(float64(currentActivity.EndBin)*fft.BinWidth)
					currentActivity.Bandwidth = currentActivity.EndFreq - currentActivity.StartFreq
					currentActivity.SignalAboveNoise = currentActivity.AvgSignalDB - noiseFloor
					
					// Check if bandwidth is within voice range
					if currentActivity.Bandwidth >= minBandwidth && currentActivity.Bandwidth <= maxBandwidth {
						// Estimate dial frequency
						currentActivity.EstimatedDialFreq, currentActivity.Mode = estimateDialFrequency(
							currentActivity.StartFreq,
							currentActivity.EndFreq,
							fft.StartFreq,
							fft.EndFreq,
						)
						activities = append(activities, *currentActivity)
					}
					
					currentActivity = nil
					gapCounter = 0
				} else {
					// Small gap, continue activity but extend end frequency
					currentActivity.EndFreq = freq
					currentActivity.EndBin = i
				}
			}
		}
	}
	
	// Handle activity that extends to end of band
	if currentActivity != nil {
		currentActivity.EndFreq = fft.StartFreq + uint64(float64(currentActivity.EndBin)*fft.BinWidth)
		currentActivity.Bandwidth = currentActivity.EndFreq - currentActivity.StartFreq
		currentActivity.SignalAboveNoise = currentActivity.AvgSignalDB - noiseFloor
		
		if currentActivity.Bandwidth >= minBandwidth && currentActivity.Bandwidth <= maxBandwidth {
			currentActivity.EstimatedDialFreq, currentActivity.Mode = estimateDialFrequency(
				currentActivity.StartFreq,
				currentActivity.EndFreq,
				fft.StartFreq,
				fft.EndFreq,
			)
			activities = append(activities, *currentActivity)
		}
	}
	
	return activities
}

// calculateNoiseFloor calculates the 5th percentile as noise floor
func calculateNoiseFloor(data []float32) float32 {
	if len(data) == 0 {
		return -999
	}
	
	// Sort a copy of the data
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})
	
	// Return 5th percentile
	idx := len(sorted) * 5 / 100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// estimateDialFrequency estimates the dial frequency based on voice activity
// Assumes dial frequency is in 500 Hz increments
// LSB for bands < 10 MHz (voice below dial)
// USB for bands >= 10 MHz (voice above dial)
// Accounts for typical voice low-frequency filter cutoff (~100 Hz)
func estimateDialFrequency(startFreq, endFreq, bandStart, bandEnd uint64) (uint64, string) {
	// Determine if this is LSB or USB based on band
	// Bands below 10 MHz use LSB, above use USB
	isLSB := bandStart < 10000000
	
	var dialFreq uint64
	var mode string
	
	// Calculate bandwidth
	bandwidth := endFreq - startFreq
	
	if isLSB {
		// LSB: voice is below dial frequency
		// The dial is at the top edge of the voice signal (plus ~100 Hz filter offset)
		// Detection often overshoots by ~500 Hz due to FFT bin resolution and spillover
		// Subtract 500 Hz then round to nearest 500 Hz
		estimatedDial := startFreq + bandwidth - 500
		dialFreq = ((estimatedDial + 250) / 500) * 500
		mode = "LSB"
	} else {
		// USB: voice is above dial frequency
		// The dial is at the bottom edge of the voice signal (minus ~100 Hz filter offset)
		// Detection often undershoots by ~500 Hz due to FFT bin resolution
		// Add 500 Hz then round to nearest 500 Hz
		estimatedDial := startFreq + 500
		dialFreq = ((estimatedDial + 250) / 500) * 500
		mode = "USB"
	}
	
	return dialFreq, mode
}

// handleVoiceActivity serves voice activity detection for a specific band
func handleVoiceActivity(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Get band parameter (required)
	band := r.URL.Query().Get("band")
	if band == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "band parameter is required (e.g., 20m, 40m)",
		})
		return
	}

	// Get optional parameters
	thresholdDBStr := r.URL.Query().Get("threshold_db")
	minBandwidthStr := r.URL.Query().Get("min_bandwidth")
	maxBandwidthStr := r.URL.Query().Get("max_bandwidth")

	// Parse threshold (default 10 dB)
	thresholdDB := float32(10.0)
	if thresholdDBStr != "" {
		if val, err := strconv.ParseFloat(thresholdDBStr, 32); err == nil && val > 0 && val < 50 {
			thresholdDB = float32(val)
		}
	}

	// Parse min bandwidth (default 2700 Hz)
	minBandwidth := uint64(2700)
	if minBandwidthStr != "" {
		if val, err := strconv.ParseUint(minBandwidthStr, 10, 64); err == nil && val > 0 {
			minBandwidth = val
		}
	}

	// Parse max bandwidth (default 4000 Hz)
	maxBandwidth := uint64(4000)
	if maxBandwidthStr != "" {
		if val, err := strconv.ParseUint(maxBandwidthStr, 10, 64); err == nil && val > minBandwidth {
			maxBandwidth = val
		}
	}

	// Check rate limit (1 request per 2 seconds per band per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("voice-activity-%s", band)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Rate limit exceeded for band %s. Please wait 2 seconds between requests.", band),
		})
		log.Printf("Voice activity rate limit exceeded for IP: %s, band: %s", clientIP, band)
		return
	}

	// Get 30-second max-hold FFT data for the band
	// Max-hold preserves voice signals even if they're transient within the window
	// Averaging would smooth them out and make them disappear into the noise floor
	// 30 seconds provides better persistence for ongoing conversations with natural pauses
	nfm.fftMu.RLock()
	buffer, ok := nfm.fftBuffers[band]
	nfm.fftMu.RUnlock()
	
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": fmt.Sprintf("No FFT buffer found for band %s", band),
		})
		return
	}
	
	fft := buffer.GetMaxHoldFFT(30 * time.Second)
	if fft == nil {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": fmt.Sprintf("No FFT data available yet for band %s. Data will be available after the first spectrum samples are collected.", band),
		})
		if DebugMode {
			log.Printf("DEBUG: Voice activity request for band %s returned no data (buffer may be empty)", band)
		}
		return
	}

	// Detect voice activity
	activities := detectVoiceActivity(fft, thresholdDB, minBandwidth, maxBandwidth)

	// Calculate noise floor for response
	noiseFloor := calculateNoiseFloor(fft.Data)

	// Build response
	response := VoiceActivityResponse{
		Band:            band,
		Timestamp:       fft.Timestamp.Format("2006-01-02T15:04:05Z07:00"),
		NoiseFloorDB:    noiseFloor,
		ThresholdDB:     thresholdDB,
		MinBandwidth:    minBandwidth,
		MaxBandwidth:    maxBandwidth,
		Activities:      activities,
		TotalActivities: len(activities),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding voice activity response: %v", err)
	}

}

// GetVoiceActivityForBand is a helper function to get voice activity programmatically
// This can be used by other parts of the codebase
func GetVoiceActivityForBand(nfm *NoiseFloorMonitor, band string, thresholdDB float32, minBandwidth, maxBandwidth uint64) ([]VoiceActivity, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not available")
	}

	fft := nfm.GetLatestFFT(band)
	if fft == nil {
		return nil, fmt.Errorf("no FFT data available for band %s", band)
	}

	activities := detectVoiceActivity(fft, thresholdDB, minBandwidth, maxBandwidth)
	return activities, nil
}

// GetAllBandsVoiceActivity gets voice activity for all configured bands
func GetAllBandsVoiceActivity(nfm *NoiseFloorMonitor, thresholdDB float32, minBandwidth, maxBandwidth uint64) map[string][]VoiceActivity {
	if nfm == nil {
		return nil
	}

	result := make(map[string][]VoiceActivity)

	for _, bandConfig := range nfm.config.NoiseFloor.Bands {
		activities, err := GetVoiceActivityForBand(nfm, bandConfig.Name, thresholdDB, minBandwidth, maxBandwidth)
		if err == nil && len(activities) > 0 {
			result[bandConfig.Name] = activities
		}
	}

	return result
}

// handleAllBandsVoiceActivity serves voice activity detection for all bands
func handleAllBandsVoiceActivity(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Get optional parameters
	thresholdDBStr := r.URL.Query().Get("threshold_db")
	minBandwidthStr := r.URL.Query().Get("min_bandwidth")
	maxBandwidthStr := r.URL.Query().Get("max_bandwidth")

	// Parse threshold (default 10 dB)
	thresholdDB := float32(10.0)
	if thresholdDBStr != "" {
		if val, err := strconv.ParseFloat(thresholdDBStr, 32); err == nil && val > 0 && val < 50 {
			thresholdDB = float32(val)
		}
	}

	// Parse min bandwidth (default 2700 Hz)
	minBandwidth := uint64(2700)
	if minBandwidthStr != "" {
		if val, err := strconv.ParseUint(minBandwidthStr, 10, 64); err == nil && val > 0 {
			minBandwidth = val
		}
	}

	// Parse max bandwidth (default 4000 Hz)
	maxBandwidth := uint64(4000)
	if maxBandwidthStr != "" {
		if val, err := strconv.ParseUint(maxBandwidthStr, 10, 64); err == nil && val > minBandwidth {
			maxBandwidth = val
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "voice-activity-all") {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Voice activity all bands rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get voice activity for all bands
	allActivities := GetAllBandsVoiceActivity(nfm, thresholdDB, minBandwidth, maxBandwidth)

	// Build response
	response := map[string]interface{}{
		"threshold_db":  thresholdDB,
		"min_bandwidth": minBandwidth,
		"max_bandwidth": maxBandwidth,
		"bands":         allActivities,
		"total_bands":   len(allActivities),
	}

	// Count total activities across all bands
	totalActivities := 0
	for _, activities := range allActivities {
		totalActivities += len(activities)
	}
	response["total_activities"] = totalActivities

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding all bands voice activity response: %v", err)
	}

	if DebugMode && totalActivities > 0 {
		log.Printf("DEBUG: Voice activity detected across %d bands: %d total activities", len(allActivities), totalActivities)
	}
}
