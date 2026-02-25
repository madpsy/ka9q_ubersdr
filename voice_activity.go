package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"
)

// ============================================================================
// Result Caching for Stability
// ============================================================================

// CachedVoiceActivity stores a detected activity with timestamp and detection count
type CachedVoiceActivity struct {
	Activity       VoiceActivity
	Timestamp      time.Time
	DetectionCount int // Number of times detected
}

// VoiceActivityCache provides stable results by requiring multiple detections
type VoiceActivityCache struct {
	cache map[string]map[uint64]*CachedVoiceActivity // map[band]map[dialFreq500Hz]*activity
	mu    sync.RWMutex
}

// Global cache instance
var voiceActivityCache = &VoiceActivityCache{
	cache: make(map[string]map[uint64]*CachedVoiceActivity),
}

// StartVoiceActivityBackgroundScanner starts a background goroutine that continuously
// scans all bands for voice activity to keep the cache populated
func StartVoiceActivityBackgroundScanner(nfm *NoiseFloorMonitor) {
	if nfm == nil {
		return
	}

	go func() {
		ticker := time.NewTicker(5 * time.Second) // Scan every 5 seconds
		defer ticker.Stop()

		params := DefaultDetectionParams()

		for range ticker.C {
			// Scan all configured bands
			for _, bandConfig := range nfm.config.NoiseFloor.Bands {
				// Skip excluded bands (2200m, 630m, 30m)
				if bandConfig.Name == "2200m" || bandConfig.Name == "630m" || bandConfig.Name == "30m" {
					continue
				}

				// Get FFT data for this band
				nfm.fftMu.RLock()
				buffer, ok := nfm.fftBuffers[bandConfig.Name]
				nfm.fftMu.RUnlock()

				if !ok {
					continue
				}

				// Detect voice activity using multi-frame analysis
				newActivities := detectVoiceActivityMultiFrame(buffer, params, 5*time.Second)

				// Update cache (this will increment detection counts)
				voiceActivityCache.mergeWithCache(bandConfig.Name, newActivities)
			}
		}
	}()

	log.Printf("Voice activity background scanner started (scans all bands except 2200m, 630m, 30m every 5 seconds)")
}

// mergeWithCache merges new detections with cached results for stability
// Requires an activity to be detected at least 2 times before it's returned
// Returns activities seen in the last 30 seconds that have been confirmed
func (vac *VoiceActivityCache) mergeWithCache(band string, newActivities []VoiceActivity) []VoiceActivity {
	vac.mu.Lock()
	defer vac.mu.Unlock()

	now := time.Now()
	cacheExpiry := 90 * time.Second

	// Initialize band cache if needed
	if vac.cache[band] == nil {
		vac.cache[band] = make(map[uint64]*CachedVoiceActivity)
	}

	bandCache := vac.cache[band]

	// Remove expired cache entries
	for key, ca := range bandCache {
		if now.Sub(ca.Timestamp) > cacheExpiry {
			delete(bandCache, key)
		}
	}

	// Process new activities
	for _, activity := range newActivities {
		// Round dial freq to 500 Hz for grouping (same station)
		key := (activity.EstimatedDialFreq / 500) * 500

		if existing, ok := bandCache[key]; ok {
			// Already seen this frequency - increment count and update
			existing.DetectionCount++
			existing.Timestamp = now
			// Update with newer/better data
			if activity.Confidence > existing.Activity.Confidence {
				existing.Activity = activity
			}
		} else {
			// First time seeing this frequency
			bandCache[key] = &CachedVoiceActivity{
				Activity:       activity,
				Timestamp:      now,
				DetectionCount: 1,
			}
		}
	}

	// Return only activities detected at least 2 times
	result := []VoiceActivity{}
	for _, ca := range bandCache {
		if ca.DetectionCount >= 2 {
			result = append(result, ca.Activity)
		}
	}

	// Sort by frequency
	sort.Slice(result, func(i, j int) bool {
		return result[i].EstimatedDialFreq < result[j].EstimatedDialFreq
	})

	return result
}

// ============================================================================
// Data Structures (API Contract - DO NOT CHANGE)
// ============================================================================

// VoiceActivity represents a detected voice signal
type VoiceActivity struct {
	// Frequency information
	StartFreq         uint64 `json:"start_freq"`
	EndFreq           uint64 `json:"end_freq"`
	CenterFreq        uint64 `json:"center_freq"`
	Bandwidth         uint64 `json:"bandwidth"`
	EstimatedDialFreq uint64 `json:"estimated_dial_freq"`
	Mode              string `json:"mode"`

	// Signal strength
	AvgSignalDB      float32 `json:"avg_signal_db"`
	PeakSignalDB     float32 `json:"peak_signal_db"`
	SignalAboveNoise float32 `json:"signal_above_noise"`
	SNR              float32 `json:"snr"`

	// Signal characteristics
	SpectralShape string  `json:"spectral_shape"`
	PowerStdDev   float32 `json:"power_std_dev"`

	// Quality metrics
	Confidence           float32  `json:"confidence"`
	DetectionMethod      string   `json:"detection_method"`
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

// DetectionParams contains tunable detection parameters
type DetectionParams struct {
	ThresholdDB      float32
	MinBandwidth     uint64
	MaxBandwidth     uint64
	MinSNR           float32
	MinConfidence    float32
	RoundingInterval uint64
}

// DefaultDetectionParams returns sensible defaults
func DefaultDetectionParams() DetectionParams {
	return DetectionParams{
		ThresholdDB:      8.0,  // 6-10 dB above noise
		MinBandwidth:     1500, // 1.5 kHz minimum
		MaxBandwidth:     4000, // 4 kHz maximum
		MinSNR:           6.0,  // Minimum SNR
		MinConfidence:    0.7,  // Minimum confidence (70%)
		RoundingInterval: 100,  // Round to 100 Hz
	}
}

// getBandSSBStartFreq returns the SSB start frequency for a given band
// Returns 0 if no filtering is needed for that band
func getBandSSBStartFreq(band string) uint64 {
	ssbStarts := map[string]uint64{
		"160m": 1843000,  // 1843 kHz
		"80m":  3600000,  // 3600 kHz
		"40m":  7100000,  // 7100 kHz
		"20m":  14112000, // 14112 kHz
		"17m":  18111000, // 18111 kHz
		"15m":  21151000, // 21151 kHz
		"12m":  24940000, // 24940 kHz
		"10m":  28320000, // 28320 kHz
	}

	if freq, ok := ssbStarts[band]; ok {
		return freq
	}
	return 0
}

// filterActivitiesBySSBStart filters out activities below the SSB start frequency
func filterActivitiesBySSBStart(activities []VoiceActivity, band string) []VoiceActivity {
	ssbStart := getBandSSBStartFreq(band)
	if ssbStart == 0 {
		// No filtering needed for this band
		return activities
	}

	filtered := []VoiceActivity{}
	for _, activity := range activities {
		// Check if the estimated dial frequency is at or above the SSB start
		if activity.EstimatedDialFreq >= ssbStart {
			filtered = append(filtered, activity)
		}
	}

	return filtered
}

// filterActivitiesByExclusionRange filters out activities within specific frequency ranges
func filterActivitiesByExclusionRange(activities []VoiceActivity, band string) []VoiceActivity {
	// Define exclusion ranges for specific bands (in Hz)
	exclusionRanges := map[string]struct{ start, end uint64 }{
		"60m": {start: 5354000, end: 5360000}, // Exclude 5.357 MHz ± 3 kHz
	}

	exclusion, hasExclusion := exclusionRanges[band]
	if !hasExclusion {
		// No exclusion range for this band
		return activities
	}

	filtered := []VoiceActivity{}
	for _, activity := range activities {
		// Check if the activity falls within the exclusion range
		// Exclude if the dial frequency is within the range
		if activity.EstimatedDialFreq < exclusion.start || activity.EstimatedDialFreq > exclusion.end {
			filtered = append(filtered, activity)
		}
	}

	return filtered
}

// ============================================================================
// SSB Voice Detection Pipeline
// ============================================================================

// CandidateRegion represents a potential voice signal tracked over time
type CandidateRegion struct {
	StartBin       int
	EndBin         int
	StartFreq      uint64
	EndFreq        uint64
	Bandwidth      uint64
	FirstSeen      time.Time
	LastSeen       time.Time
	FrameCount     int
	AvgPower       float32
	PeakPower      float32
	MinPower       float32   // Minimum power seen (for variance calculation)
	PowerSamples   []float32 // Power samples over time for variance calculation
	NoiseFloor     float32
	SNR            float32
	InferredLowCut uint64
}

// TimeFrequencyView builds a time-frequency representation from FFT frames
type TimeFrequencyView struct {
	Frames    []FFTSample
	StartFreq uint64
	EndFreq   uint64
	BinWidth  float64
	Duration  time.Duration
}

// detectVoiceActivity implements the proper SSB voice detection pipeline
// This is a wrapper that uses multi-frame analysis when available
func detectVoiceActivity(fft *BandFFT, params DetectionParams) []VoiceActivity {
	if fft == nil || len(fft.Data) == 0 {
		return []VoiceActivity{}
	}

	// Single-frame fallback (deprecated - use multi-frame when possible)
	// This version cannot detect temporal variations (syllabic modulation)
	// and will incorrectly classify constant carriers as voice

	// Step 1: Per-frame noise floor estimation using median filter
	noiseFloor := estimateNoiseFloorMedianFilter(fft.Data, 1000, 3000, fft.BinWidth, fft.StartFreq)

	// Step 2: Detect candidate regions (1.5-4 kHz bandwidth, 6-10 dB above noise)
	threshold := noiseFloor + params.ThresholdDB
	candidates := detectCandidateRegions(fft.Data, threshold, fft.BinWidth, fft.StartFreq, params)

	// Step 3: Apply voice-likeness filters
	voiceCandidates := []CandidateRegion{}
	for _, candidate := range candidates {
		// Tonality check: reject if max(E) - median(E) > 20 dB
		if !passesTonalityCheck(fft.Data, candidate.StartBin, candidate.EndBin) {
			continue
		}

		// Spectral variance check: reject flat wideband noise and narrow digital modes
		if !passesSpectralVarianceCheck(fft.Data, candidate.StartBin, candidate.EndBin) {
			continue
		}

		// Bandwidth occupancy check: reject narrow tones in wide regions
		if !passesBandwidthOccupancyCheck(fft.Data, candidate.StartBin, candidate.EndBin, noiseFloor, fft.BinWidth) {
			continue
		}

		// WARNING: Single-frame analysis cannot detect syllabic modulation
		// Constant carriers (beacons, CW, interference) will pass through
		// Use detectVoiceActivityMultiFrame for proper temporal analysis

		voiceCandidates = append(voiceCandidates, candidate)
	}

	// Step 4: Convert candidates to VoiceActivity records
	activities := []VoiceActivity{}
	for _, candidate := range voiceCandidates {
		// Infer low-cut from spectral ramp (80-600 Hz range)
		lowCut := inferLowCutFromSpectralRamp(fft.Data, candidate.StartBin, candidate.EndBin,
			fft.BinWidth, fft.StartFreq, candidate.StartFreq)
		candidate.InferredLowCut = lowCut

		// Calculate dial frequency
		dialFreq, alternatives, mode := calculateDialFrequency(candidate, fft.StartFreq, fft.EndFreq, params)

		// Calculate confidence
		confidence := calculateVoiceConfidence(candidate, params)

		if confidence < params.MinConfidence {
			continue
		}

		activity := VoiceActivity{
			StartFreq:            candidate.StartFreq,
			EndFreq:              candidate.EndFreq,
			CenterFreq:           (candidate.StartFreq + candidate.EndFreq) / 2,
			Bandwidth:            candidate.Bandwidth,
			EstimatedDialFreq:    dialFreq,
			Mode:                 mode,
			AvgSignalDB:          candidate.AvgPower,
			PeakSignalDB:         candidate.PeakPower,
			SignalAboveNoise:     candidate.SNR,
			SNR:                  candidate.SNR,
			SpectralShape:        "voice",
			PowerStdDev:          0, // Not calculated in single-frame version
			Confidence:           confidence,
			DetectionMethod:      "ssb_pipeline_single_frame",
			StartBin:             candidate.StartBin,
			EndBin:               candidate.EndBin,
			AlternativeDialFreqs: alternatives,
		}

		activities = append(activities, activity)
	}

	return activities
}

// estimateNoiseFloorMedianFilter estimates noise floor using sliding median filter
// This rejects SSB blobs but follows band shape
func estimateNoiseFloorMedianFilter(data []float32, minFreq, maxFreq uint64, binWidth float64, startFreq uint64) float32 {
	// Use percentile approach for noise floor (more robust than median filter)
	// Take 10th percentile as noise floor estimate
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	// 10th percentile - robust noise floor that ignores signals
	idx := len(sorted) * 10 / 100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}

	return sorted[idx]
}

// detectCandidateRegions finds regions 1.5-4 kHz wide, 6-10 dB above noise
func detectCandidateRegions(data []float32, threshold float32, binWidth float64, startFreq uint64, params DetectionParams) []CandidateRegion {
	candidates := []CandidateRegion{}

	// K consecutive bins above threshold (edge finding)
	K := 3 // Require 3 consecutive bins to start/end a region

	// Calculate noise floor for SNR
	noiseFloor := estimateNoiseFloorMedianFilter(data, 0, 0, binWidth, startFreq)

	var current *CandidateRegion
	consecutiveAbove := 0
	consecutiveBelow := 0
	binCount := 0

	for i, power := range data {
		freq := startFreq + uint64(float64(i)*binWidth)

		if power > threshold {
			consecutiveAbove++
			consecutiveBelow = 0

			if current == nil && consecutiveAbove >= K {
				// Start new candidate
				current = &CandidateRegion{
					StartBin:   i - K + 1,
					StartFreq:  startFreq + uint64(float64(i-K+1)*binWidth),
					PeakPower:  power,
					AvgPower:   power,
					FrameCount: 1,
					FirstSeen:  time.Now(),
					LastSeen:   time.Now(),
					NoiseFloor: noiseFloor,
				}
				binCount = 1
			} else if current != nil {
				// Continue current candidate
				current.EndBin = i
				current.EndFreq = freq

				if power > current.PeakPower {
					current.PeakPower = power
				}
				// Running average
				binCount++
				current.AvgPower = (current.AvgPower*float32(binCount-1) + power) / float32(binCount)
			}
		} else {
			consecutiveBelow++
			consecutiveAbove = 0

			// End current candidate if K consecutive bins below threshold
			if current != nil && consecutiveBelow >= K {
				current.Bandwidth = current.EndFreq - current.StartFreq
				current.SNR = current.AvgPower - noiseFloor

				// Check bandwidth constraints
				if current.Bandwidth >= params.MinBandwidth && current.Bandwidth <= params.MaxBandwidth {
					candidates = append(candidates, *current)
				}
				current = nil
				binCount = 0
			}
		}
	}

	// Handle candidate extending to end
	if current != nil {
		current.EndFreq = startFreq + uint64(float64(current.EndBin)*binWidth)
		current.Bandwidth = current.EndFreq - current.StartFreq
		current.SNR = current.AvgPower - noiseFloor

		if current.Bandwidth >= params.MinBandwidth && current.Bandwidth <= params.MaxBandwidth {
			candidates = append(candidates, *current)
		}
	}

	return candidates
}

// passesTonalityCheck rejects signals with max(E) - median(E) > 20 dB (likely CW/carriers)
func passesTonalityCheck(data []float32, startBin, endBin int) bool {
	if startBin < 0 || endBin >= len(data) || startBin >= endBin {
		return false
	}

	signalBins := data[startBin : endBin+1]

	// Find max
	maxPower := signalBins[0]
	for _, power := range signalBins {
		if power > maxPower {
			maxPower = power
		}
	}

	// Find median
	sorted := make([]float32, len(signalBins))
	copy(sorted, signalBins)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})
	medianPower := sorted[len(sorted)/2]

	// Check tonality: voice should have max - median < 20 dB
	tonality := maxPower - medianPower
	return tonality < 20.0
}

// passesSpectralVarianceCheck rejects flat wideband noise and narrow digital modes
// Voice has energy distributed across most of the passband with variations
// Wideband noise has uniform energy distribution
// Digital modes have energy in only a few narrow bins
func passesSpectralVarianceCheck(data []float32, startBin, endBin int) bool {
	if startBin < 0 || endBin >= len(data) || startBin >= endBin {
		return false
	}

	signalBins := data[startBin : endBin+1]

	// Calculate mean power
	var sum float32
	for _, power := range signalBins {
		sum += power
	}
	mean := sum / float32(len(signalBins))

	// Calculate standard deviation
	var variance float32
	for _, power := range signalBins {
		diff := power - mean
		variance += diff * diff
	}
	variance /= float32(len(signalBins))
	stdDev := float32(math.Sqrt(float64(variance)))

	// Check 1: Voice should have at least 3 dB standard deviation
	// Flat wideband noise typically has <2 dB std dev
	minStdDev := float32(3.0) // dB
	if stdDev < minStdDev {
		return false
	}

	// Check 2: Voice should have energy distributed across most of the passband
	// Count bins that are significantly above the mean (indicating active frequency content)
	// Digital modes have energy in only a few bins, voice spreads across many
	significantBins := 0
	threshold := mean - stdDev*0.5 // Bins above (mean - 0.5*stdDev) are considered active

	for _, power := range signalBins {
		if power >= threshold {
			significantBins++
		}
	}

	// Require at least 40% of bins to have significant energy
	// Voice typically has 50-80% of bins active due to formants and harmonics
	// Digital modes typically have <20% of bins active
	// Flat noise would have ~50% but fails the stdDev check above
	minPercentage := float32(0.40)
	activePercentage := float32(significantBins) / float32(len(signalBins))

	return activePercentage >= minPercentage
}

// passesBandwidthOccupancyCheck rejects narrow tones in wide regions
// Voice occupies 50-80% of the detected bandwidth
// A narrow tone (CW, carrier) occupies <10% of the detected bandwidth
func passesBandwidthOccupancyCheck(data []float32, startBin, endBin int, noiseFloor float32, binWidth float64) bool {
	if startBin < 0 || endBin >= len(data) || startBin >= endBin {
		return false
	}

	signalBins := data[startBin : endBin+1]

	// Define "occupied" as bins significantly above noise floor
	// Use noise floor + 6 dB as threshold for occupied bins
	occupancyThreshold := noiseFloor + 6.0

	// Count bins that are occupied (above threshold)
	occupiedBins := 0
	for _, power := range signalBins {
		if power >= occupancyThreshold {
			occupiedBins++
		}
	}

	// Calculate occupied bandwidth
	occupiedBandwidth := float64(occupiedBins) * binWidth
	totalBandwidth := float64(len(signalBins)) * binWidth

	// Calculate occupancy ratio
	occupancyRatio := occupiedBandwidth / totalBandwidth

	// Voice should occupy at least 50% of the detected bandwidth
	// A 50 Hz tone in a 1.5 kHz region would be ~3% occupancy
	// Digital modes are typically 10-30% occupancy
	// Voice is typically 60-80% occupancy
	minOccupancy := 0.50

	return occupancyRatio >= minOccupancy
}

// inferLowCutFromSpectralRamp infers the low-cut filter frequency from spectral ramp
// For LSB: analyzes top ~1 kHz of blob to find where energy "turns on"
// For USB: analyzes bottom ~1 kHz of blob
func inferLowCutFromSpectralRamp(data []float32, startBin, endBin int, binWidth float64, startFreq, signalStartFreq uint64) uint64 {
	if startBin < 0 || endBin >= len(data) || startBin >= endBin {
		return 300 // Default
	}

	signalBins := data[startBin : endBin+1]

	// Find reference level R (70th percentile of middle of blob)
	// Exclude edges (~300 Hz on each side)
	edgeExclude := int(300.0 / binWidth)
	if edgeExclude < 1 {
		edgeExclude = 1
	}

	middleStart := edgeExclude
	middleEnd := len(signalBins) - edgeExclude
	if middleStart >= middleEnd {
		// Signal too narrow, use default
		return 300
	}

	middleBins := make([]float32, middleEnd-middleStart)
	copy(middleBins, signalBins[middleStart:middleEnd])
	sort.Slice(middleBins, func(i, j int) bool {
		return middleBins[i] < middleBins[j]
	})

	refLevel := middleBins[len(middleBins)*70/100] // 70th percentile

	// Look for where signal rises above (refLevel - 8 dB) moving from edge inward
	// This finds the "turn-on" point
	turnOnThreshold := refLevel - 8.0

	// Determine mode based on band (LSB below 10 MHz, USB above)
	// This is critical: we must use the correct edge for each mode
	isLSB := startFreq < 10000000

	// For LSB: scan from top edge (endBin) downward - audio is inverted
	// For USB: scan from bottom edge (startBin) upward - audio is normal
	var lowCutEst uint64 = 300 // Default

	if isLSB {
		// LSB: Only use top edge scan
		var topTurnOn int = -1
		for i := len(signalBins) - 1; i >= 0; i-- {
			if signalBins[i] >= turnOnThreshold {
				topTurnOn = i
				break
			}
		}

		if topTurnOn >= 0 {
			// Distance from top edge to turn-on point
			topOffset := uint64(float64(len(signalBins)-1-topTurnOn) * binWidth)
			if topOffset >= 80 && topOffset <= 600 {
				lowCutEst = topOffset
			}
		}
	} else {
		// USB: Only use bottom edge scan
		var bottomTurnOn int = -1
		for i := 0; i < len(signalBins); i++ {
			if signalBins[i] >= turnOnThreshold {
				bottomTurnOn = i
				break
			}
		}

		if bottomTurnOn >= 0 {
			// Distance from bottom edge to turn-on point
			bottomOffset := uint64(float64(bottomTurnOn) * binWidth)
			if bottomOffset >= 80 && bottomOffset <= 600 {
				lowCutEst = bottomOffset
			}
		}
	}

	// Clamp to reasonable range
	if lowCutEst < 100 {
		lowCutEst = 100
	}
	if lowCutEst > 600 {
		lowCutEst = 600
	}

	return lowCutEst
}

// calculateDialFrequency calculates dial frequency using inferred low-cut
// Applies smart rounding to prefer 500 Hz boundaries (common amateur radio practice)
func calculateDialFrequency(candidate CandidateRegion, bandStart, bandEnd uint64, params DetectionParams) (uint64, []uint64, string) {
	// Determine mode based on band (LSB below 10 MHz, USB above)
	mode := "USB"
	if bandStart < 10000000 {
		mode = "LSB"
	}

	// Use inferred low-cut (L_est)
	lowCut := candidate.InferredLowCut

	// Calculate raw dial frequency:
	// LSB: Fc = fU + L_est (upper edge + low-cut)
	// USB: Fc = fL - L_est (lower edge - low-cut)
	var rawDialFreq uint64
	if mode == "LSB" {
		rawDialFreq = candidate.EndFreq + lowCut
	} else {
		rawDialFreq = candidate.StartFreq - lowCut
	}

	// Smart rounding: prefer 500 Hz boundaries, but only if close
	// Most operators tune to x.x00, x.x50 kHz (500 Hz increments)
	dialFreq := smartRoundTo500Hz(rawDialFreq, params.RoundingInterval)

	// Generate alternatives with different low-cut estimates
	alternatives := []uint64{}
	lowCutVariants := []uint64{200, 300, 400, 500} // Common SSB filter offsets

	for _, lc := range lowCutVariants {
		var altFreq uint64
		if mode == "LSB" {
			altFreq = candidate.EndFreq + lc
		} else {
			altFreq = candidate.StartFreq - lc
		}

		altFreq = smartRoundTo500Hz(altFreq, params.RoundingInterval)

		// Avoid duplicates
		isDuplicate := false
		if altFreq == dialFreq {
			isDuplicate = true
		}
		for _, alt := range alternatives {
			if alt == altFreq {
				isDuplicate = true
				break
			}
		}
		if !isDuplicate {
			alternatives = append(alternatives, altFreq)
		}
	}

	return dialFreq, alternatives, mode
}

// smartRoundTo500Hz applies smart rounding that prefers 500 Hz boundaries
// Strongly prefers .000 kHz boundaries over .500 kHz boundaries (operators tune to whole kHz more often)
func smartRoundTo500Hz(freq uint64, roundingInterval uint64) uint64 {
	// Find nearest 1 kHz boundary (.000)
	nearest1000 := ((freq + 500) / 1000) * 1000

	// Calculate distance to nearest 1 kHz boundary
	var distance1000 uint64
	if freq > nearest1000 {
		distance1000 = freq - nearest1000
	} else {
		distance1000 = nearest1000 - freq
	}

	// If within 600 Hz of a 1 kHz boundary (.000), snap to it
	// Increased from 300 Hz to 600 Hz to catch systematic offsets in LSB/USB detection
	// This fixes the issue where detections appear on .500 boundaries when actually on .000
	if distance1000 <= 600 {
		return nearest1000
	}

	// Find nearest 500 Hz boundary (.000 or .500)
	nearest500 := ((freq + 250) / 500) * 500

	// Calculate distance to nearest 500 Hz boundary
	var distance500 uint64
	if freq > nearest500 {
		distance500 = freq - nearest500
	} else {
		distance500 = nearest500 - freq
	}

	// If within 200 Hz of a 500 Hz boundary, snap to it
	if distance500 <= 200 {
		return nearest500
	}

	// Otherwise, round to the specified interval (100 Hz)
	halfInterval := roundingInterval / 2
	return ((freq + halfInterval) / roundingInterval) * roundingInterval
}

// calculateVoiceConfidence computes detection confidence score (0-1)
func calculateVoiceConfidence(candidate CandidateRegion, params DetectionParams) float32 {
	var score float32 = 0.0

	// SNR contribution (0-0.4)
	snrScore := math.Min(float64(candidate.SNR)/30.0, 1.0) * 0.4
	score += float32(snrScore)

	// Bandwidth match contribution (0-0.3)
	idealBW := 2700.0 // Typical SSB voice
	bwDiff := math.Abs(float64(candidate.Bandwidth) - idealBW)
	bwScore := math.Max(0, 1.0-(bwDiff/1000.0)) * 0.3
	score += float32(bwScore)

	// Low-cut inference quality (0-0.2)
	// Prefer low-cuts in typical range (200-400 Hz)
	if candidate.InferredLowCut >= 200 && candidate.InferredLowCut <= 400 {
		score += 0.2
	} else if candidate.InferredLowCut >= 100 && candidate.InferredLowCut <= 600 {
		score += 0.1
	}

	// Duration/stability (0-0.1)
	// For single-frame analysis, give partial credit
	score += 0.05

	return float32(math.Min(float64(score), 1.0))
}

// ============================================================================
// Multi-Frame Analysis (Future Enhancement)
// ============================================================================

// detectVoiceActivityMultiFrame analyzes multiple FFT frames for better accuracy
// This is the full implementation of the SSB voice detection pipeline
func detectVoiceActivityMultiFrame(buffer *FFTBuffer, params DetectionParams, windowDuration time.Duration) []VoiceActivity {
	if buffer == nil || len(buffer.Samples) == 0 {
		return []VoiceActivity{}
	}

	// Build time-frequency view over 2-5 seconds
	cutoff := time.Now().Add(-windowDuration)
	frames := []FFTSample{}
	for _, sample := range buffer.Samples {
		if sample.Timestamp.After(cutoff) {
			frames = append(frames, sample)
		}
	}

	if len(frames) == 0 {
		return []VoiceActivity{}
	}

	// Track candidate regions over time
	regionTracker := make(map[string]*CandidateRegion)

	for _, frame := range frames {
		// Per-frame noise floor estimation
		noiseFloor := estimateNoiseFloorMedianFilter(frame.Data, 1000, 3000, buffer.BinWidth, buffer.StartFreq)

		// Detect candidates in this frame
		threshold := noiseFloor + params.ThresholdDB
		frameCandidates := detectCandidateRegions(frame.Data, threshold, buffer.BinWidth, buffer.StartFreq, params)

		// Update region tracker with fuzzy matching
		// Voice signals may shift bins slightly, so match within ±2 bins
		for _, candidate := range frameCandidates {
			// Try to find existing region with similar frequency range
			var matched *CandidateRegion

			for _, existing := range regionTracker {
				// Check if bins overlap or are within ±2 bins
				binTolerance := 2
				if (candidate.StartBin >= existing.StartBin-binTolerance && candidate.StartBin <= existing.EndBin+binTolerance) ||
					(candidate.EndBin >= existing.StartBin-binTolerance && candidate.EndBin <= existing.EndBin+binTolerance) ||
					(existing.StartBin >= candidate.StartBin-binTolerance && existing.StartBin <= candidate.EndBin+binTolerance) {
					matched = existing
					break
				}
			}

			if matched != nil {
				// Update existing region
				matched.LastSeen = frame.Timestamp
				matched.FrameCount++
				matched.AvgPower = (matched.AvgPower*float32(matched.FrameCount-1) + candidate.AvgPower) / float32(matched.FrameCount)
				if candidate.PeakPower > matched.PeakPower {
					matched.PeakPower = candidate.PeakPower
				}
				if matched.MinPower == 0 || candidate.AvgPower < matched.MinPower {
					matched.MinPower = candidate.AvgPower
				}
				// Track power samples for variance calculation
				matched.PowerSamples = append(matched.PowerSamples, candidate.AvgPower)
			} else {
				// New region
				key := fmt.Sprintf("%d-%d", candidate.StartBin, candidate.EndBin)
				candidate.FirstSeen = frame.Timestamp
				candidate.LastSeen = frame.Timestamp
				candidate.NoiseFloor = noiseFloor
				candidate.SNR = candidate.AvgPower - noiseFloor
				candidate.MinPower = candidate.AvgPower
				candidate.PowerSamples = []float32{candidate.AvgPower}
				regionTracker[key] = &candidate
			}
		}
	}

	// Filter regions by persistence and voice-likeness
	activities := []VoiceActivity{}

	for _, region := range regionTracker {
		// Require region to appear in at least 30% of frames
		minFrames := int(float64(len(frames)) * 0.3)
		if region.FrameCount < minFrames {
			continue
		}

		// Apply voice-likeness filters on the most recent frame
		lastFrame := frames[len(frames)-1]
		if !passesTonalityCheck(lastFrame.Data, region.StartBin, region.EndBin) {
			continue
		}

		// Spectral variance check: reject flat wideband noise and narrow digital modes
		if !passesSpectralVarianceCheck(lastFrame.Data, region.StartBin, region.EndBin) {
			continue
		}

		// Bandwidth occupancy check: reject narrow tones in wide regions
		if !passesBandwidthOccupancyCheck(lastFrame.Data, region.StartBin, region.EndBin, region.NoiseFloor, buffer.BinWidth) {
			continue
		}

		// Syllabic modulation check: reject constant carriers
		// Voice shows amplitude variation over time (syllabic modulation)
		// Carriers, beacons, CW, and interference are constant
		if !passesSyllabicModulationCheck(region) {
			continue
		}

		// Infer low-cut
		lowCut := inferLowCutFromSpectralRamp(lastFrame.Data, region.StartBin, region.EndBin,
			buffer.BinWidth, buffer.StartFreq, region.StartFreq)
		region.InferredLowCut = lowCut

		// Calculate dial frequency with median stabilization
		dialFreq, alternatives, mode := calculateDialFrequency(*region, buffer.StartFreq, buffer.EndFreq, params)

		// Calculate confidence
		confidence := calculateVoiceConfidence(*region, params)

		if confidence < params.MinConfidence {
			continue
		}

		// Calculate power standard deviation for reporting
		powerStdDev := calculatePowerStdDev(region.PowerSamples, region.AvgPower)

		activity := VoiceActivity{
			StartFreq:            region.StartFreq,
			EndFreq:              region.EndFreq,
			CenterFreq:           (region.StartFreq + region.EndFreq) / 2,
			Bandwidth:            region.Bandwidth,
			EstimatedDialFreq:    dialFreq,
			Mode:                 mode,
			AvgSignalDB:          region.AvgPower,
			PeakSignalDB:         region.PeakPower,
			SignalAboveNoise:     region.SNR,
			SNR:                  region.SNR,
			SpectralShape:        "voice",
			PowerStdDev:          powerStdDev,
			Confidence:           confidence,
			DetectionMethod:      "ssb_pipeline_multiframe",
			StartBin:             region.StartBin,
			EndBin:               region.EndBin,
			AlternativeDialFreqs: alternatives,
		}

		activities = append(activities, activity)
	}

	return activities
}

// passesSyllabicModulationCheck checks if a signal shows amplitude variation over time
// Voice has syllabic modulation (varies as people speak)
// Constant carriers (beacons, CW, interference) are rejected
func passesSyllabicModulationCheck(region *CandidateRegion) bool {
	// Need at least 5 samples for reliable variance calculation
	// With 5-second window and typical FFT rate, this is reasonable
	if len(region.PowerSamples) < 5 {
		// Not enough samples yet - allow it through (will be checked again later)
		return true
	}

	// Calculate power variation metrics
	peakToPeak := region.PeakPower - region.MinPower
	avgPower := region.AvgPower
	stdDev := calculatePowerStdDev(region.PowerSamples, avgPower)

	// RELAXED thresholds - only reject obvious constant carriers
	// Voice is highly variable, so we use OR logic (fail any ONE test = reject)

	// Test 1: Extremely constant (< 2 dB variation)
	// Even weak voice varies by at least 2-3 dB
	// Strong constant carriers vary by < 1.5 dB
	if peakToPeak < 2.0 && stdDev < 1.5 {
		return false // Definitely a constant carrier
	}

	// Test 2: Check for suspiciously stable power
	// If >85% of samples are within 1.5 dB of average, it's too constant
	// Real voice has pauses, syllables, fading - creates more variation
	veryStableCount := 0
	tightTolerance := float32(1.5)
	for _, sample := range region.PowerSamples {
		if math.Abs(float64(sample-avgPower)) <= float64(tightTolerance) {
			veryStableCount++
		}
	}
	veryStableRatio := float32(veryStableCount) / float32(len(region.PowerSamples))
	if veryStableRatio > 0.85 {
		return false // Too stable - likely a carrier
	}

	// If we get here, signal shows enough variation to be voice
	return true
}

// calculatePowerStdDev calculates standard deviation of power samples
func calculatePowerStdDev(samples []float32, mean float32) float32 {
	if len(samples) == 0 {
		return 0
	}

	var variance float32
	for _, sample := range samples {
		diff := sample - mean
		variance += diff * diff
	}
	variance /= float32(len(samples))

	return float32(math.Sqrt(float64(variance)))
}

// ============================================================================
// API Handlers (Unchanged)
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

	// Return empty results for 2200m, 630m, and 30m bands
	if band == "2200m" || band == "630m" || band == "30m" {
		params := DefaultDetectionParams()
		response := VoiceActivityResponse{
			Band:            band,
			Timestamp:       time.Now().Format("2006-01-02T15:04:05Z07:00"),
			NoiseFloorDB:    0,
			ThresholdDB:     params.ThresholdDB,
			MinBandwidth:    params.MinBandwidth,
			MaxBandwidth:    params.MaxBandwidth,
			Activities:      []VoiceActivity{},
			TotalActivities: 0,
			BandType:        "excluded",
		}
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(response); err != nil {
			log.Printf("Error encoding voice activity response: %v", err)
		}
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

	// Parse threshold (default 8 dB)
	if thresholdDBStr != "" {
		if val, err := strconv.ParseFloat(thresholdDBStr, 32); err == nil && val > 0 && val < 50 {
			params.ThresholdDB = float32(val)
		}
	}

	// Parse min bandwidth (default 1500 Hz)
	if minBandwidthStr != "" {
		if val, err := strconv.ParseUint(minBandwidthStr, 10, 64); err == nil && val > 0 {
			params.MinBandwidth = val
		}
	}

	// Parse max bandwidth (default 4000 Hz)
	if maxBandwidthStr != "" {
		if val, err := strconv.ParseUint(maxBandwidthStr, 10, 64); err == nil && val > params.MinBandwidth {
			params.MaxBandwidth = val
		}
	}

	// Parse min SNR (default 6 dB)
	if minSNRStr != "" {
		if val, err := strconv.ParseFloat(minSNRStr, 32); err == nil && val > 0 {
			params.MinSNR = float32(val)
		}
	}

	// Parse min confidence (default 0.3)
	if minConfidenceStr != "" {
		if val, err := strconv.ParseFloat(minConfidenceStr, 32); err == nil && val >= 0 && val <= 1 {
			params.MinConfidence = float32(val)
		}
	}

	// Rate limit: 2 requests per second
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "noise-analysis") {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Maximum 2 requests per second.",
		})
		log.Printf("Voice activity rate limit exceeded for IP: %s, band: %s", clientIP, band)
		return
	}

	// Get FFT buffer for the band
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

	// Use multi-frame analysis for better accuracy (detects temporal variations)
	// This properly rejects constant carriers and interference
	newActivities := detectVoiceActivityMultiFrame(buffer, params, 5*time.Second)

	// Filter by SSB start frequency for applicable bands
	newActivities = filterActivitiesBySSBStart(newActivities, band)

	// Filter by exclusion ranges (e.g., 60m exclusion zone)
	newActivities = filterActivitiesByExclusionRange(newActivities, band)

	// Merge with cache for stability (keeps activities from last 30 seconds)
	activities := voiceActivityCache.mergeWithCache(band, newActivities)

	// Apply SSB start filter to cached results as well
	activities = filterActivitiesBySSBStart(activities, band)

	// Apply exclusion range filter to cached results as well
	activities = filterActivitiesByExclusionRange(activities, band)

	// Filter by minimum confidence (user-requested threshold)
	filteredActivities := []VoiceActivity{}
	for _, activity := range activities {
		if activity.Confidence >= params.MinConfidence {
			filteredActivities = append(filteredActivities, activity)
		}
	}
	activities = filteredActivities

	// Get averaged FFT for noise floor calculation and timestamp
	fft := buffer.GetAveragedFFT(5 * time.Second)
	var noiseFloor float32
	var timestamp string
	if fft != nil {
		noiseFloor = estimateNoiseFloorMedianFilter(fft.Data, 1000, 3000, fft.BinWidth, fft.StartFreq)
		timestamp = fft.Timestamp.Format("2006-01-02T15:04:05Z07:00")
	} else {
		noiseFloor = 0
		timestamp = time.Now().Format("2006-01-02T15:04:05Z07:00")
	}

	// Build response
	response := VoiceActivityResponse{
		Band:            band,
		Timestamp:       timestamp,
		NoiseFloorDB:    noiseFloor,
		ThresholdDB:     params.ThresholdDB,
		MinBandwidth:    params.MinBandwidth,
		MaxBandwidth:    params.MaxBandwidth,
		Activities:      activities,
		TotalActivities: len(activities),
		BandType:        "normal",
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding voice activity response: %v", err)
	}

}

// GetVoiceActivityForBand is a helper function to get voice activity programmatically
func GetVoiceActivityForBand(nfm *NoiseFloorMonitor, band string, params DetectionParams) ([]VoiceActivity, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not available")
	}

	// Return empty for excluded bands
	if band == "2200m" || band == "630m" || band == "30m" {
		return []VoiceActivity{}, nil
	}

	nfm.fftMu.RLock()
	buffer, ok := nfm.fftBuffers[band]
	nfm.fftMu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("no FFT buffer found for band %s", band)
	}

	// Use multi-frame analysis for proper temporal detection
	activities := detectVoiceActivityMultiFrame(buffer, params, 5*time.Second)

	// Filter by SSB start frequency for applicable bands
	activities = filterActivitiesBySSBStart(activities, band)

	return activities, nil
}

// GetAllBandsVoiceActivity gets voice activity for all configured bands
func GetAllBandsVoiceActivity(nfm *NoiseFloorMonitor, params DetectionParams) map[string][]VoiceActivity {
	if nfm == nil {
		return nil
	}

	result := make(map[string][]VoiceActivity)

	for _, bandConfig := range nfm.config.NoiseFloor.Bands {
		// Skip excluded bands (2200m, 630m, 30m)
		if bandConfig.Name == "2200m" || bandConfig.Name == "630m" || bandConfig.Name == "30m" {
			continue
		}

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
		"threshold_db":   params.ThresholdDB,
		"min_bandwidth":  params.MinBandwidth,
		"max_bandwidth":  params.MaxBandwidth,
		"min_snr":        params.MinSNR,
		"min_confidence": params.MinConfidence,
		"bands":          allActivities,
		"total_bands":    len(allActivities),
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

}
