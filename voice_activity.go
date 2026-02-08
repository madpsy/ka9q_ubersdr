package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// ============================================================================
// Data Structures
// ============================================================================

// VoiceActivity represents a detected voice signal
type VoiceActivity struct {
	// Frequency information
	StartFreq         uint64  `json:"start_freq"`
	EndFreq           uint64  `json:"end_freq"`
	CenterFreq        uint64  `json:"center_freq"`
	Bandwidth         uint64  `json:"bandwidth"`
	EstimatedDialFreq uint64  `json:"estimated_dial_freq"`
	Mode              string  `json:"mode"`

	// Signal strength
	AvgSignalDB      float32 `json:"avg_signal_db"`
	PeakSignalDB     float32 `json:"peak_signal_db"`
	SignalAboveNoise float32 `json:"signal_above_noise"`
	SNR              float32 `json:"snr"`

	// Signal characteristics
	SpectralShape string  `json:"spectral_shape"`
	PowerStdDev   float32 `json:"power_std_dev"`

	// Quality metrics
	Confidence      float32  `json:"confidence"`
	DetectionMethod string   `json:"detection_method"`
	AlternativeDialFreqs []uint64 `json:"alternative_dial_freqs,omitempty"`

	// Internal
	StartBin int `json:"start_bin"`
	EndBin   int `json:"end_bin"`
}

// VoiceActivityResponse represents the API response
type VoiceActivityResponse struct {
	Band            string          `json:"band"`
	Timestamp       string          `json:"timestamp"`
	NoiseFloorDB    float32         `json:"noise_floor_db"`
	ThresholdDB     float32         `json:"threshold_db"`
	MinBandwidth    uint64          `json:"min_bandwidth"`
	MaxBandwidth    uint64          `json:"max_bandwidth"`
	Activities      []VoiceActivity `json:"activities"`
	TotalActivities int             `json:"total_activities"`
	BandType        string          `json:"band_type,omitempty"`
}

// NoiseProfile contains statistical analysis of the noise floor
type NoiseProfile struct {
	P5        float32
	P10       float32
	P25       float32
	P50       float32
	Mean      float32
	StdDev    float32
	BandType  string  // "quiet", "moderate", "busy"
	Threshold float32 // Calculated adaptive threshold
}

// SignalCharacteristics describes a detected signal region
type SignalCharacteristics struct {
	StartFreq    uint64
	EndFreq      uint64
	CenterFreq   uint64
	Bandwidth    uint64
	Bandwidth6dB uint64

	PeakPower   float32
	AvgPower    float32
	PowerStdDev float32

	SNR           float32
	SpectralShape string

	StartBin int
	EndBin   int
	BinCount int
}

// DetectionParams contains tunable detection parameters
type DetectionParams struct {
	ThresholdDB      float32
	MinBandwidth     uint64
	MaxBandwidth     uint64
	MinSNR           float32
	MinPowerVariance float32
	MinConfidence    float32
	FilterOffset     uint64
	RoundingInterval uint64
}

// DefaultDetectionParams returns sensible defaults
func DefaultDetectionParams() DetectionParams {
	return DetectionParams{
		ThresholdDB:      12.0,
		MinBandwidth:     2000,
		MaxBandwidth:     3500,
		MinSNR:           10.0,
		MinPowerVariance: 2.0,
		MinConfidence:    0.6,
		FilterOffset:     350,
		RoundingInterval: 100,
	}
}

// ============================================================================
// Noise Profile Calculation
// ============================================================================

// calculateNoiseProfile performs robust noise floor estimation
func calculateNoiseProfile(data []float32) NoiseProfile {
	if len(data) == 0 {
		return NoiseProfile{P5: -999, P10: -999, P25: -999, P50: -999}
	}

	// Sort data for percentile calculations
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	n := len(sorted)
	profile := NoiseProfile{
		P5:  sorted[n*5/100],
		P10: sorted[n*10/100],
		P25: sorted[n*25/100],
		P50: sorted[n*50/100],
	}

	// Calculate mean and standard deviation
	var sum, sumSq float64
	for _, v := range data {
		sum += float64(v)
		sumSq += float64(v) * float64(v)
	}
	profile.Mean = float32(sum / float64(n))
	variance := (sumSq / float64(n)) - (sum/float64(n))*(sum/float64(n))
	if variance > 0 {
		profile.StdDev = float32(math.Sqrt(variance))
	}

	// Classify band type based on occupancy
	// Count bins significantly above P5
	aboveNoise := 0
	threshold := profile.P5 + 10.0
	for _, v := range data {
		if v > threshold {
			aboveNoise++
		}
	}
	occupancy := float32(aboveNoise) / float32(n)

	if occupancy < 0.1 {
		profile.BandType = "quiet"
		profile.Threshold = profile.P10 // Use P10 for quiet bands
	} else if occupancy < 0.3 {
		profile.BandType = "moderate"
		profile.Threshold = profile.P25 // Use P25 for moderate bands
	} else {
		profile.BandType = "busy"
		profile.Threshold = profile.P25 // Use P25 for busy bands
	}

	return profile
}

// ============================================================================
// Candidate Region Detection
// ============================================================================

// findCandidateRegions identifies regions above threshold
// No gap-filling to preserve accurate edges
func findCandidateRegions(data []float32, threshold float32, binWidth float64, startFreq uint64) []SignalCharacteristics {
	candidates := []SignalCharacteristics{}
	var current *SignalCharacteristics

	for i, power := range data {
		freq := startFreq + uint64(float64(i)*binWidth)

		if power > threshold {
			if current == nil {
				// Start new candidate
				current = &SignalCharacteristics{
					StartFreq: freq,
					StartBin:  i,
					PeakPower: power,
					AvgPower:  power,
					BinCount:  1,
				}
			} else {
				// Continue current candidate
				current.EndFreq = freq
				current.EndBin = i
				current.BinCount++

				// Update statistics
				if power > current.PeakPower {
					current.PeakPower = power
				}
				// Running average
				current.AvgPower = ((current.AvgPower * float32(current.BinCount-1)) + power) / float32(current.BinCount)
			}
		} else {
			// Below threshold - end current candidate
			if current != nil {
				current.EndFreq = startFreq + uint64(float64(current.EndBin)*binWidth)
				current.Bandwidth = current.EndFreq - current.StartFreq
				candidates = append(candidates, *current)
				current = nil
			}
		}
	}

	// Handle candidate extending to end
	if current != nil {
		current.EndFreq = startFreq + uint64(float64(current.EndBin)*binWidth)
		current.Bandwidth = current.EndFreq - current.StartFreq
		candidates = append(candidates, *current)
	}

	return candidates
}

// ============================================================================
// Signal Characterization
// ============================================================================

// characterizeSignal performs detailed analysis of a signal region
func characterizeSignal(data []float32, candidate SignalCharacteristics,
	noiseProfile NoiseProfile, binWidth float64, startFreq uint64) SignalCharacteristics {

	// Extract signal bins
	signalBins := data[candidate.StartBin : candidate.EndBin+1]

	// Calculate weighted centroid frequency
	var weightedSum, totalWeight float64
	for i, power := range signalBins {
		binFreq := startFreq + uint64(float64(candidate.StartBin+i)*binWidth)
		// Use linear power for weighting
		linearPower := math.Pow(10.0, float64(power)/10.0)
		weightedSum += float64(binFreq) * linearPower
		totalWeight += linearPower
	}
	candidate.CenterFreq = uint64(weightedSum / totalWeight)

	// Calculate 3dB and 6dB bandwidths
	peakPower := candidate.PeakPower
	threshold3dB := peakPower - 3.0
	threshold6dB := peakPower - 6.0

	var bw3dBStart, bw3dBEnd, bw6dBStart, bw6dBEnd int
	found3dBStart := false
	found6dBStart := false

	for i, power := range signalBins {
		if !found3dBStart && power >= threshold3dB {
			bw3dBStart = i
			found3dBStart = true
		}
		if found3dBStart && power >= threshold3dB {
			bw3dBEnd = i
		}

		if !found6dBStart && power >= threshold6dB {
			bw6dBStart = i
			found6dBStart = true
		}
		if found6dBStart && power >= threshold6dB {
			bw6dBEnd = i
		}
	}

	if found3dBStart {
		candidate.Bandwidth = uint64(float64(bw3dBEnd-bw3dBStart+1) * binWidth)
	}
	if found6dBStart {
		candidate.Bandwidth6dB = uint64(float64(bw6dBEnd-bw6dBStart+1) * binWidth)
	}

	// Calculate power standard deviation
	var sumSq float64
	for _, power := range signalBins {
		diff := power - candidate.AvgPower
		sumSq += float64(diff * diff)
	}
	candidate.PowerStdDev = float32(math.Sqrt(sumSq / float64(len(signalBins))))

	// Calculate SNR
	candidate.SNR = candidate.AvgPower - noiseProfile.Threshold

	// Determine spectral shape
	candidate.SpectralShape = determineSpectralShape(candidate)

	return candidate
}

// determineSpectralShape classifies signal based on bandwidth and shape
func determineSpectralShape(char SignalCharacteristics) string {
	bw := char.Bandwidth

	if bw < 500 {
		return "narrow" // CW, carrier, beacon
	} else if bw >= 2000 && bw <= 3500 {
		// Check shape factor (6dB BW / 3dB BW)
		if char.Bandwidth6dB > 0 {
			shapeFactor := float64(char.Bandwidth6dB) / float64(char.Bandwidth)
			if shapeFactor >= 1.3 && shapeFactor <= 1.8 {
				return "voice" // Typical SSB voice shape
			}
		}
		return "wide"
	} else if bw > 3500 {
		return "wide" // Too wide for voice
	}

	return "irregular"
}

// ============================================================================
// Validation Filters
// ============================================================================

// isValidVoiceSignal applies multiple validation filters
func isValidVoiceSignal(char SignalCharacteristics, params DetectionParams) bool {
	// Bandwidth check
	if char.Bandwidth < params.MinBandwidth || char.Bandwidth > params.MaxBandwidth {
		return false
	}

	// SNR check
	if char.SNR < params.MinSNR {
		return false
	}

	// Spectral shape check
	if char.SpectralShape == "narrow" || char.SpectralShape == "irregular" {
		return false
	}

	// Power variation check (voice varies, carriers don't)
	// Typical voice has StdDev > 2 dB
	if char.PowerStdDev < params.MinPowerVariance {
		return false // Too steady, likely carrier
	}

	return true
}

// ============================================================================
// Frequency Estimation
// ============================================================================

// calculateAdaptiveOffset determines offset based on signal characteristics
func calculateAdaptiveOffset(char SignalCharacteristics, params DetectionParams) uint64 {
	// Base offset from configuration (default 350 Hz)
	baseOffset := params.FilterOffset

	// Adjust based on bandwidth
	// Narrower signals (2.0-2.4 kHz): carrier closer to edge (~300 Hz)
	// Typical signals (2.4-2.8 kHz): standard offset (~350 Hz)
	// Wider signals (2.8-3.5 kHz): carrier further from edge (~400 Hz)

	bw := float64(char.Bandwidth)
	var adjustment float64

	if bw < 2400 {
		// Narrow signal - reduce offset
		adjustment = -50.0 * (2400.0 - bw) / 400.0 // Up to -50 Hz
	} else if bw > 2800 {
		// Wide signal - increase offset
		adjustment = 50.0 * (bw - 2800.0) / 700.0 // Up to +50 Hz
	} else {
		// Typical bandwidth - no adjustment
		adjustment = 0
	}

	offset := uint64(float64(baseOffset) + adjustment)

	// Clamp to reasonable range (250-450 Hz)
	if offset < 250 {
		offset = 250
	}
	if offset > 450 {
		offset = 450
	}

	return offset
}

// estimateDialFrequency calculates dial frequency from signal centroid
func estimateDialFrequency(char SignalCharacteristics, bandStart, bandEnd uint64,
	params DetectionParams) (uint64, []uint64, string) {

	centerFreq := char.CenterFreq

	// Determine mode based on band
	mode := determineMode(centerFreq, bandStart, bandEnd)

	// Calculate primary estimate with adaptive offset
	primaryOffset := calculateAdaptiveOffset(char, params)

	// Generate alternatives with different offsets
	alternatives := []uint64{}
	offsets := []uint64{300, 350, 400} // Common SSB filter offsets

	for _, offset := range offsets {
		var dialFreq uint64
		if mode == "LSB" {
			dialFreq = centerFreq + offset
		} else {
			dialFreq = centerFreq - offset
		}

		// Round
		halfInterval := params.RoundingInterval / 2
		dialFreq = ((dialFreq + halfInterval) / params.RoundingInterval) * params.RoundingInterval

		// Avoid duplicates
		isDuplicate := false
		for _, alt := range alternatives {
			if alt == dialFreq {
				isDuplicate = true
				break
			}
		}
		if !isDuplicate {
			alternatives = append(alternatives, dialFreq)
		}
	}

	// Primary estimate
	var primaryDialFreq uint64
	if mode == "LSB" {
		primaryDialFreq = centerFreq + primaryOffset
	} else {
		primaryDialFreq = centerFreq - primaryOffset
	}
	primaryDialFreq = ((primaryDialFreq + params.RoundingInterval/2) / params.RoundingInterval) * params.RoundingInterval

	return primaryDialFreq, alternatives, mode
}

// determineMode determines USB or LSB based on band
func determineMode(centerFreq, bandStart, bandEnd uint64) string {
	// Traditional rule: LSB below 10 MHz, USB above
	if bandStart < 10000000 {
		return "LSB"
	}
	return "USB"
}

// ============================================================================
// Confidence Scoring
// ============================================================================

// calculateConfidence computes detection confidence score (0-1)
func calculateConfidence(char SignalCharacteristics, params DetectionParams) float32 {
	var score float32 = 0.0

	// SNR contribution (0-0.4)
	snrScore := math.Min(float64(char.SNR)/30.0, 1.0) * 0.4
	score += float32(snrScore)

	// Bandwidth match contribution (0-0.3)
	idealBW := 2700.0 // Typical SSB voice
	bwDiff := math.Abs(float64(char.Bandwidth) - idealBW)
	bwScore := math.Max(0, 1.0-(bwDiff/1000.0)) * 0.3
	score += float32(bwScore)

	// Spectral shape contribution (0-0.2)
	if char.SpectralShape == "voice" {
		score += 0.2
	} else if char.SpectralShape == "wide" {
		score += 0.1
	}

	// Power variation contribution (0-0.1)
	// Voice typically has StdDev 2-6 dB
	varScore := math.Min(float64(char.PowerStdDev)/6.0, 1.0) * 0.1
	score += float32(varScore)

	return float32(math.Min(float64(score), 1.0))
}

// ============================================================================
// Main Detection Function
// ============================================================================

// detectVoiceActivity is the enhanced detection algorithm
func detectVoiceActivity(fft *BandFFT, params DetectionParams) []VoiceActivity {
	if fft == nil || len(fft.Data) == 0 {
		return []VoiceActivity{}
	}

	// Step 1: Calculate noise profile
	noiseProfile := calculateNoiseProfile(fft.Data)

	// Step 2: Set adaptive threshold
	threshold := noiseProfile.Threshold + params.ThresholdDB

	// Step 3: Find candidate regions
	candidates := findCandidateRegions(fft.Data, threshold, fft.BinWidth, fft.StartFreq)

	// Step 4: Analyze and filter candidates
	activities := []VoiceActivity{}

	for _, candidate := range candidates {
		// Characterize signal
		char := characterizeSignal(fft.Data, candidate, noiseProfile, fft.BinWidth, fft.StartFreq)

		// Validate
		if !isValidVoiceSignal(char, params) {
			continue
		}

		// Calculate confidence
		confidence := calculateConfidence(char, params)

		// Apply confidence threshold
		if confidence < params.MinConfidence {
			continue
		}

		// Estimate dial frequency
		dialFreq, alternatives, mode := estimateDialFrequency(char, fft.StartFreq, fft.EndFreq, params)

		// Create activity record
		activity := VoiceActivity{
			StartFreq:         char.StartFreq,
			EndFreq:           char.EndFreq,
			CenterFreq:        char.CenterFreq,
			Bandwidth:         char.Bandwidth,
			EstimatedDialFreq: dialFreq,
			Mode:              mode,
			AvgSignalDB:       char.AvgPower,
			PeakSignalDB:      char.PeakPower,
			SignalAboveNoise:  char.SNR,
			SNR:               char.SNR,
			SpectralShape:     char.SpectralShape,
			PowerStdDev:       char.PowerStdDev,
			Confidence:        confidence,
			DetectionMethod:   "enhanced",
			StartBin:          char.StartBin,
			EndBin:            char.EndBin,
			AlternativeDialFreqs: alternatives,
		}

		activities = append(activities, activity)
	}

	return activities
}

// ============================================================================
// API Handlers
// ============================================================================

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
	minSNRStr := r.URL.Query().Get("min_snr")
	minConfidenceStr := r.URL.Query().Get("min_confidence")

	// Start with defaults
	params := DefaultDetectionParams()

	// Parse threshold (default 12 dB)
	if thresholdDBStr != "" {
		if val, err := strconv.ParseFloat(thresholdDBStr, 32); err == nil && val > 0 && val < 50 {
			params.ThresholdDB = float32(val)
		}
	}

	// Parse min bandwidth (default 2000 Hz)
	if minBandwidthStr != "" {
		if val, err := strconv.ParseUint(minBandwidthStr, 10, 64); err == nil && val > 0 {
			params.MinBandwidth = val
		}
	}

	// Parse max bandwidth (default 3500 Hz)
	if maxBandwidthStr != "" {
		if val, err := strconv.ParseUint(maxBandwidthStr, 10, 64); err == nil && val > params.MinBandwidth {
			params.MaxBandwidth = val
		}
	}

	// Parse min SNR (default 10 dB)
	if minSNRStr != "" {
		if val, err := strconv.ParseFloat(minSNRStr, 32); err == nil && val > 0 {
			params.MinSNR = float32(val)
		}
	}

	// Parse min confidence (default 0.6)
	if minConfidenceStr != "" {
		if val, err := strconv.ParseFloat(minConfidenceStr, 32); err == nil && val >= 0 && val <= 1 {
			params.MinConfidence = float32(val)
		}
	}

	// Rate limit: 2 requests per second (same as noise-analysis endpoint)
	// Using "noise-analysis" key to get 2 req/sec rate limit
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "noise-analysis") {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Maximum 2 requests per second.",
		})
		log.Printf("Voice activity rate limit exceeded for IP: %s, band: %s", clientIP, band)
		return
	}

	// Get 5-second averaged FFT data for the band
	// Shorter averaging preserves voice characteristics while providing stability
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

	fft := buffer.GetAveragedFFT(5 * time.Second)
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
	activities := detectVoiceActivity(fft, params)

	// Calculate noise profile for response
	noiseProfile := calculateNoiseProfile(fft.Data)

	// Build response
	response := VoiceActivityResponse{
		Band:            band,
		Timestamp:       fft.Timestamp.Format("2006-01-02T15:04:05Z07:00"),
		NoiseFloorDB:    noiseProfile.Threshold,
		ThresholdDB:     params.ThresholdDB,
		MinBandwidth:    params.MinBandwidth,
		MaxBandwidth:    params.MaxBandwidth,
		Activities:      activities,
		TotalActivities: len(activities),
		BandType:        noiseProfile.BandType,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding voice activity response: %v", err)
	}

	if DebugMode && len(activities) > 0 {
		log.Printf("DEBUG: Voice activity detected on %s: %d activities (band type: %s)", band, len(activities), noiseProfile.BandType)
	}
}

// GetVoiceActivityForBand is a helper function to get voice activity programmatically
func GetVoiceActivityForBand(nfm *NoiseFloorMonitor, band string, params DetectionParams) ([]VoiceActivity, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not available")
	}

	nfm.fftMu.RLock()
	buffer, ok := nfm.fftBuffers[band]
	nfm.fftMu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("no FFT buffer found for band %s", band)
	}

	fft := buffer.GetAveragedFFT(5 * time.Second)
	if fft == nil {
		return nil, fmt.Errorf("no FFT data available for band %s", band)
	}

	activities := detectVoiceActivity(fft, params)
	return activities, nil
}

// GetAllBandsVoiceActivity gets voice activity for all configured bands
func GetAllBandsVoiceActivity(nfm *NoiseFloorMonitor, params DetectionParams) map[string][]VoiceActivity {
	if nfm == nil {
		return nil
	}

	result := make(map[string][]VoiceActivity)

	for _, bandConfig := range nfm.config.NoiseFloor.Bands {
		activities, err := GetVoiceActivityForBand(nfm, bandConfig.Name, params)
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
	minSNRStr := r.URL.Query().Get("min_snr")
	minConfidenceStr := r.URL.Query().Get("min_confidence")

	// Start with defaults
	params := DefaultDetectionParams()

	// Parse parameters
	if thresholdDBStr != "" {
		if val, err := strconv.ParseFloat(thresholdDBStr, 32); err == nil && val > 0 && val < 50 {
			params.ThresholdDB = float32(val)
		}
	}

	if minBandwidthStr != "" {
		if val, err := strconv.ParseUint(minBandwidthStr, 10, 64); err == nil && val > 0 {
			params.MinBandwidth = val
		}
	}

	if maxBandwidthStr != "" {
		if val, err := strconv.ParseUint(maxBandwidthStr, 10, 64); err == nil && val > params.MinBandwidth {
			params.MaxBandwidth = val
		}
	}

	if minSNRStr != "" {
		if val, err := strconv.ParseFloat(minSNRStr, 32); err == nil && val > 0 {
			params.MinSNR = float32(val)
		}
	}

	if minConfidenceStr != "" {
		if val, err := strconv.ParseFloat(minConfidenceStr, 32); err == nil && val >= 0 && val <= 1 {
			params.MinConfidence = float32(val)
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
	allActivities := GetAllBandsVoiceActivity(nfm, params)

	// Build response
	response := map[string]interface{}{
		"threshold_db":  params.ThresholdDB,
		"min_bandwidth": params.MinBandwidth,
		"max_bandwidth": params.MaxBandwidth,
		"min_snr":       params.MinSNR,
		"min_confidence": params.MinConfidence,
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
