package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"time"
)

// NoiseType represents different categories of RF noise
type NoiseType string

const (
	NoiseTypeWidebandFlat    NoiseType = "wideband_flat"    // Flat elevated noise across wide bandwidth
	NoiseTypeWidebandSloped  NoiseType = "wideband_sloped"  // Sloped noise (e.g., plasma TV)
	NoiseTypeHarmonic        NoiseType = "harmonic"         // Harmonically related spikes
	NoiseTypeImpulse         NoiseType = "impulse"          // Periodic impulse noise (e.g., electric fence)
	NoiseTypeSwitchingSupply NoiseType = "switching_supply" // Switching power supply noise
	NoiseTypeBroadbandPeak   NoiseType = "broadband_peak"   // Peak with wideband noise spreading from it
	NoiseTypeNarrowbandSpike NoiseType = "narrowband_spike" // Single narrow spike
	NoiseTypeComb            NoiseType = "comb"             // Comb-like pattern (regular spacing)
	NoiseTypePowerline       NoiseType = "powerline"        // 50/60 Hz harmonics
	NoiseTypeAMBroadcast     NoiseType = "am_broadcast"     // AM broadcast station
	NoiseTypeUnknown         NoiseType = "unknown"          // Unclassified interference
)

// NoiseSource represents a detected RF noise source
type NoiseSource struct {
	Type             NoiseType `json:"type"`
	Confidence       float32   `json:"confidence"` // 0-100%
	StartFrequencyHz float64   `json:"center_frequency_hz"`
	BandwidthHz      float64   `json:"bandwidth_hz"`
	PeakPowerDB      float32   `json:"peak_power_db"`
	AveragePowerDB   float32   `json:"average_power_db"`

	// Bin information
	StartBin     int   `json:"start_bin"`
	EndBin       int   `json:"end_bin"`
	PeakBin      int   `json:"peak_bin,omitempty"` // Bin with peak power (if applicable)
	AffectedBins []int `json:"affected_bins"`      // All bins affected by this noise

	// Type-specific data
	Harmonics     []HarmonicPeak `json:"harmonics,omitempty"`        // For harmonic noise
	FundamentalHz float64        `json:"fundamental_hz,omitempty"`   // Fundamental frequency
	SpacingHz     float64        `json:"spacing_hz,omitempty"`       // For comb patterns
	SlopeDBPerMHz float32        `json:"slope_db_per_mhz,omitempty"` // For sloped noise

	// Descriptive information
	Description  string `json:"description"`
	Severity     string `json:"severity"`      // "low", "medium", "high", "critical"
	LikelySource string `json:"likely_source"` // Human-readable guess at source
}

// HarmonicPeak represents a single harmonic in a series
type HarmonicPeak struct {
	FrequencyHz float64 `json:"frequency_hz"`
	PowerDB     float32 `json:"power_db"`
	Bin         int     `json:"bin"`
	Harmonic    int     `json:"harmonic"` // 1 = fundamental, 2 = 2nd harmonic, etc.
}

// NoiseAnalysisResult contains the complete analysis
type NoiseAnalysisResult struct {
	Timestamp       time.Time     `json:"timestamp"`
	Sources         []NoiseSource `json:"sources"`
	BaselineNoiseDB float32       `json:"baseline_noise_db"` // 5th percentile
	MedianNoiseDB   float32       `json:"median_noise_db"`   // 50th percentile
	PeakNoiseDB     float32       `json:"peak_noise_db"`     // Maximum
	DynamicRangeDB  float32       `json:"dynamic_range_db"`  // Peak - baseline

	// Analysis parameters
	AnalysisRange struct {
		StartHz float64 `json:"start_hz"`
		EndHz   float64 `json:"end_hz"`
	} `json:"analysis_range"`

	TotalBins  int     `json:"total_bins"`
	BinWidthHz float64 `json:"bin_width_hz"`

	// Summary statistics
	CleanBinsPercent float32 `json:"clean_bins_percent"` // % of bins near baseline
	NoisyBinsPercent float32 `json:"noisy_bins_percent"` // % of bins elevated

	ProcessingTimeMs float64 `json:"processing_time_ms"`
}

// handleNoiseAnalysis serves RF noise analysis results
func handleNoiseAnalysis(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
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

	// Check rate limit (1 request per 2 seconds per IP for noise analysis)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "noise-analysis") {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Noise analysis rate limit exceeded for IP: %s", clientIP)
		return
	}

	startTime := time.Now()

	// Get wideband FFT data
	fft := nfm.GetWideBandFFT()
	if fft == nil {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No FFT data available yet for noise analysis.",
		})
		return
	}

	// Perform noise analysis
	result := analyzeRFNoise(fft)
	result.ProcessingTimeMs = time.Since(startTime).Seconds() * 1000

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Error encoding noise analysis result: %v", err)
	}
}

// analyzeRFNoise performs comprehensive RF noise analysis on FFT data
func analyzeRFNoise(fft *BandFFT) *NoiseAnalysisResult {
	if fft == nil || len(fft.Data) == 0 {
		return &NoiseAnalysisResult{
			Timestamp: time.Now(),
			Sources:   []NoiseSource{},
		}
	}

	result := &NoiseAnalysisResult{
		Timestamp:  time.Now(),
		TotalBins:  len(fft.Data),
		BinWidthHz: fft.BinWidth,
		Sources:    []NoiseSource{},
	}

	// Set analysis range
	result.AnalysisRange.StartHz = float64(fft.StartFreq)
	result.AnalysisRange.EndHz = float64(fft.EndFreq)

	// Calculate baseline statistics
	baseline, median, peak := calculateNoiseStatistics(fft.Data)
	result.BaselineNoiseDB = baseline
	result.MedianNoiseDB = median
	result.PeakNoiseDB = peak
	result.DynamicRangeDB = peak - baseline

	// Calculate clean vs noisy bins
	threshold := baseline + 6.0 // 6 dB above baseline
	noisyCount := 0
	for _, power := range fft.Data {
		if power > threshold {
			noisyCount++
		}
	}
	result.CleanBinsPercent = float32(len(fft.Data)-noisyCount) * 100.0 / float32(len(fft.Data))
	result.NoisyBinsPercent = float32(noisyCount) * 100.0 / float32(len(fft.Data))

	// Detect different noise types
	sources := []NoiseSource{}

	// 1. Detect AM broadcast stations (below 1.8 MHz, very strong)
	amBroadcastSources := detectAMBroadcast(fft, baseline)
	sources = append(sources, amBroadcastSources...)

	// 2. Detect wideband noise regions
	widebandSources := detectWidebandNoise(fft, baseline)
	sources = append(sources, widebandSources...)

	// 3. Detect harmonic series
	harmonicSources := detectHarmonics(fft, baseline)
	sources = append(sources, harmonicSources...)

	// 4. Detect comb patterns (regular spacing)
	combSources := detectCombPatterns(fft, baseline)
	sources = append(sources, combSources...)

	// 5. Detect powerline harmonics (50/60 Hz)
	powerlineSources := detectPowerlineNoise(fft, baseline)
	sources = append(sources, powerlineSources...)

	// 6. Detect broadband peaks (peak with spreading noise)
	broadbandPeakSources := detectBroadbandPeaks(fft, baseline)
	sources = append(sources, broadbandPeakSources...)

	// 7. Detect isolated spikes
	spikeSources := detectNarrowbandSpikes(fft, baseline)
	sources = append(sources, spikeSources...)

	// Sort by confidence (highest first)
	sort.Slice(sources, func(i, j int) bool {
		return sources[i].Confidence > sources[j].Confidence
	})

	result.Sources = sources

	return result
}

// calculateNoiseStatistics calculates baseline (5th percentile), median, and peak
func calculateNoiseStatistics(data []float32) (baseline, median, peak float32) {
	if len(data) == 0 {
		return 0, 0, 0
	}

	// Create sorted copy
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	// 5th percentile (baseline)
	p5Index := int(float64(len(sorted)) * 0.05)
	baseline = sorted[p5Index]

	// Median (50th percentile)
	medianIndex := len(sorted) / 2
	median = sorted[medianIndex]

	// Peak
	peak = sorted[len(sorted)-1]

	return baseline, median, peak
}

// detectAMBroadcast detects AM broadcast stations (below 1.8 MHz, very strong signals)
func detectAMBroadcast(fft *BandFFT, baseline float32) []NoiseSource {
	sources := []NoiseSource{}

	// AM broadcast bands:
	// LW: 148.5-283.5 kHz (Europe)
	// MW: 530-1700 kHz (Americas), 531-1602 kHz (Europe)
	// All below 1.8 MHz

	startFreq := float64(fft.StartFreq)

	// Only look below 1.8 MHz
	maxAMFreq := 1.8e6

	for i := 0; i < len(fft.Data); i++ {
		freq := startFreq + float64(i)*fft.BinWidth

		if freq > maxAMFreq {
			break
		}

		// AM broadcast stations are typically very strong (>20 dB above baseline)
		if fft.Data[i] > baseline+20.0 {
			// Check if this is a local peak
			isPeak := true
			if i > 0 && fft.Data[i] <= fft.Data[i-1] {
				isPeak = false
			}
			if i < len(fft.Data)-1 && fft.Data[i] <= fft.Data[i+1] {
				isPeak = false
			}

			if isPeak {
				// Measure the bandwidth of this station (typically 10-20 kHz)
				startBin := i
				endBin := i

				// Find extent of signal (above baseline + 10 dB)
				threshold := baseline + 10.0
				for j := i - 1; j >= 0 && fft.Data[j] > threshold; j-- {
					startBin = j
					binFreq := startFreq + float64(j)*fft.BinWidth
					if binFreq < freq-15e3 { // Max 15 kHz below carrier
						break
					}
				}
				for j := i + 1; j < len(fft.Data) && fft.Data[j] > threshold; j++ {
					endBin = j
					binFreq := startFreq + float64(j)*fft.BinWidth
					if binFreq > freq+15e3 { // Max 15 kHz above carrier
						break
					}
				}

				source := createAMBroadcastSource(fft, startBin, endBin, i, baseline)
				sources = append(sources, source)
			}
		}
	}

	return sources
}

// createAMBroadcastSource creates an AM broadcast station source
func createAMBroadcastSource(fft *BandFFT, startBin, endBin, peakBin int, baseline float32) NoiseSource {
	startFreq := float64(fft.StartFreq)

	freq := startFreq + float64(peakBin)*fft.BinWidth
	bandwidth := float64(endBin-startBin) * fft.BinWidth

	affectedBins := []int{}
	for i := startBin; i <= endBin; i++ {
		affectedBins = append(affectedBins, i)
	}

	peakPower := fft.Data[peakBin]
	elevation := peakPower - baseline

	// Very high confidence for strong signals below 1.8 MHz
	confidence := float32(math.Min(100, float64(elevation)*3)) // 33 dB = 100%

	description := fmt.Sprintf("AM broadcast station at %.0f kHz", freq/1e3)

	// Determine band
	band := "MW"
	if freq < 300e3 {
		band = "LW"
	}

	likelySource := fmt.Sprintf("AM %s broadcast station (%.0f kHz)", band, freq/1e3)

	// AM broadcasts are not "noise" but legitimate signals
	// Mark as low severity unless extremely strong
	severity := "low"
	if elevation > 40 {
		severity = "medium" // Very strong, might cause overload
	}

	return NoiseSource{
		Type:             NoiseTypeAMBroadcast,
		Confidence:       confidence,
		StartFrequencyHz: freq,
		BandwidthHz:      bandwidth,
		PeakPowerDB:      peakPower,
		AveragePowerDB:   peakPower,
		StartBin:         startBin,
		EndBin:           endBin,
		PeakBin:          peakBin,
		AffectedBins:     affectedBins,
		Description:      description,
		Severity:         severity,
		LikelySource:     likelySource,
	}
}

// detectWidebandNoise detects regions of elevated wideband noise
func detectWidebandNoise(fft *BandFFT, baseline float32) []NoiseSource {
	sources := []NoiseSource{}

	// Use sliding window of 1 MHz
	windowBins := int(1e6 / fft.BinWidth)
	if windowBins < 10 {
		windowBins = 10
	}

	threshold := baseline + 12.0            // 12 dB above baseline (much more conservative)
	minWidthBins := int(1e6 / fft.BinWidth) // Minimum 1 MHz to be considered wideband

	inRegion := false
	startBin := 0

	for i := 0; i <= len(fft.Data)-windowBins; i++ {
		// Calculate average in window
		sum := float32(0)
		for j := 0; j < windowBins; j++ {
			sum += fft.Data[i+j]
		}
		avg := sum / float32(windowBins)

		if avg > threshold && !inRegion {
			// Start of elevated region
			inRegion = true
			startBin = i
		} else if (avg <= threshold || i == len(fft.Data)-windowBins) && inRegion {
			// End of elevated region
			endBin := i
			if endBin-startBin >= minWidthBins {
				source := createWidebandSource(fft, startBin, endBin, baseline)
				sources = append(sources, source)
			}
			inRegion = false
		}
	}

	return sources
}

// createWidebandSource creates a wideband noise source from bin range
func createWidebandSource(fft *BandFFT, startBin, endBin int, baseline float32) NoiseSource {
	// Calculate statistics for this region
	sum := float32(0)
	maxPower := float32(-999)
	peakBin := startBin

	affectedBins := []int{}
	for i := startBin; i <= endBin && i < len(fft.Data); i++ {
		power := fft.Data[i]
		sum += power
		affectedBins = append(affectedBins, i)
		if power > maxPower {
			maxPower = power
			peakBin = i
		}
	}

	avgPower := sum / float32(len(affectedBins))

	// Calculate frequencies
	startFreq := float64(fft.StartFreq) + float64(startBin)*fft.BinWidth
	endFreq := float64(fft.StartFreq) + float64(endBin)*fft.BinWidth
	centerFreq := (startFreq + endFreq) / 2
	bandwidth := endFreq - startFreq

	// Check if sloped
	slope := calculateSlope(fft.Data[startBin:endBin+1], fft.BinWidth)

	noiseType := NoiseTypeWidebandFlat
	description := fmt.Sprintf("Flat wideband noise %.2f-%.2f MHz", startFreq/1e6, endFreq/1e6)
	likelySource := "Unknown broadband interference"

	if math.Abs(float64(slope)) > 2.0 { // More than 2 dB/MHz slope
		noiseType = NoiseTypeWidebandSloped
		description = fmt.Sprintf("Sloped wideband noise %.2f-%.2f MHz (%.1f dB/MHz)",
			startFreq/1e6, endFreq/1e6, slope)
		likelySource = "Plasma TV, LED lighting, or solar panel inverter"
	}

	// Calculate confidence based on elevation above baseline
	elevation := avgPower - baseline
	confidence := float32(math.Min(100, float64(elevation)*5)) // 20 dB = 100% confidence

	// Determine severity
	severity := "low"
	if elevation > 15 {
		severity = "critical"
	} else if elevation > 10 {
		severity = "high"
	} else if elevation > 6 {
		severity = "medium"
	}

	return NoiseSource{
		Type:             noiseType,
		Confidence:       confidence,
		StartFrequencyHz: centerFreq,
		BandwidthHz:      bandwidth,
		PeakPowerDB:      maxPower,
		AveragePowerDB:   avgPower,
		StartBin:         startBin,
		EndBin:           endBin,
		PeakBin:          peakBin,
		AffectedBins:     affectedBins,
		SlopeDBPerMHz:    slope,
		Description:      description,
		Severity:         severity,
		LikelySource:     likelySource,
	}
}

// calculateSlope calculates the slope in dB/MHz
func calculateSlope(data []float32, binWidth float64) float32 {
	if len(data) < 2 {
		return 0
	}

	// Simple linear regression
	n := float64(len(data))
	sumX := 0.0
	sumY := 0.0
	sumXY := 0.0
	sumX2 := 0.0

	for i, y := range data {
		x := float64(i) * binWidth / 1e6 // Convert to MHz
		sumX += x
		sumY += float64(y)
		sumXY += x * float64(y)
		sumX2 += x * x
	}

	slope := (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX)
	return float32(slope)
}

// detectHarmonics detects harmonically related spikes
func detectHarmonics(fft *BandFFT, baseline float32) []NoiseSource {
	sources := []NoiseSource{}

	// Find all peaks above threshold
	peaks := findPeaks(fft, baseline+15.0) // 15 dB above baseline (much more conservative)

	if len(peaks) < 2 {
		return sources
	}

	// Try to find harmonic series
	used := make(map[int]bool)
	for i := 0; i < len(peaks); i++ {
		if used[i] {
			continue
		}

		fundamental := peaks[i]
		harmonics := []HarmonicPeak{fundamental}
		used[i] = true

		// Look for harmonics (2f, 3f, 4f, 5f)
		for h := 2; h <= 10; h++ {
			expectedFreq := fundamental.FrequencyHz * float64(h)

			// Find peak near expected frequency (within 1% tolerance)
			tolerance := expectedFreq * 0.01
			for j := i + 1; j < len(peaks); j++ {
				if used[j] {
					continue
				}
				if math.Abs(peaks[j].FrequencyHz-expectedFreq) < tolerance {
					peak := peaks[j]
					peak.Harmonic = h
					harmonics = append(harmonics, peak)
					used[j] = true
					break
				}
			}
		}

		// If we found at least 3 harmonics, it's likely a harmonic series
		if len(harmonics) >= 3 {
			source := createHarmonicSource(harmonics, baseline)
			sources = append(sources, source)
		}
	}

	return sources
}

// findPeaks finds all peaks above threshold
func findPeaks(fft *BandFFT, threshold float32) []HarmonicPeak {
	peaks := []HarmonicPeak{}

	startFreq := float64(fft.StartFreq)

	for i := 1; i < len(fft.Data)-1; i++ {
		// Check if this is a local maximum above threshold
		if fft.Data[i] > threshold &&
			fft.Data[i] > fft.Data[i-1] &&
			fft.Data[i] > fft.Data[i+1] {
			freq := startFreq + float64(i)*fft.BinWidth
			peaks = append(peaks, HarmonicPeak{
				FrequencyHz: freq,
				PowerDB:     fft.Data[i],
				Bin:         i,
				Harmonic:    1, // Will be updated if part of series
			})
		}
	}

	return peaks
}

// createHarmonicSource creates a harmonic noise source
func createHarmonicSource(harmonics []HarmonicPeak, baseline float32) NoiseSource {
	fundamental := harmonics[0]

	// Collect affected bins
	affectedBins := []int{}
	for _, h := range harmonics {
		affectedBins = append(affectedBins, h.Bin)
	}

	// Calculate confidence based on number of harmonics and their strength
	confidence := float32(len(harmonics)) * 15.0 // 3 harmonics = 45%, 5 = 75%, 7 = 100%
	if confidence > 100 {
		confidence = 100
	}

	// Determine likely source based on fundamental frequency
	likelySource := "Unknown harmonic source"
	noiseType := NoiseTypeHarmonic

	fundMHz := fundamental.FrequencyHz / 1e6
	if fundMHz < 0.5 {
		likelySource = "Switching power supply or DC-DC converter"
		noiseType = NoiseTypeSwitchingSupply
	} else if fundMHz >= 0.5 && fundMHz < 2.0 {
		likelySource = "Switching power supply (500 kHz - 2 MHz typical)"
		noiseType = NoiseTypeSwitchingSupply
	}

	description := fmt.Sprintf("%d harmonics from %.3f MHz fundamental",
		len(harmonics), fundamental.FrequencyHz/1e6)

	// Severity based on peak power
	elevation := fundamental.PowerDB - baseline
	severity := "low"
	if elevation > 20 {
		severity = "critical"
	} else if elevation > 15 {
		severity = "high"
	} else if elevation > 10 {
		severity = "medium"
	}

	return NoiseSource{
		Type:             noiseType,
		Confidence:       confidence,
		StartFrequencyHz: fundamental.FrequencyHz,
		BandwidthHz:      harmonics[len(harmonics)-1].FrequencyHz - fundamental.FrequencyHz,
		PeakPowerDB:      fundamental.PowerDB,
		AveragePowerDB:   fundamental.PowerDB,
		StartBin:         harmonics[0].Bin,
		EndBin:           harmonics[len(harmonics)-1].Bin,
		PeakBin:          fundamental.Bin,
		AffectedBins:     affectedBins,
		Harmonics:        harmonics,
		FundamentalHz:    fundamental.FrequencyHz,
		Description:      description,
		Severity:         severity,
		LikelySource:     likelySource,
	}
}

// detectCombPatterns detects regularly spaced interference (comb pattern)
func detectCombPatterns(fft *BandFFT, baseline float32) []NoiseSource {
	sources := []NoiseSource{}

	peaks := findPeaks(fft, baseline+12.0) // 12 dB above baseline (more conservative)
	if len(peaks) < 5 {                    // Require at least 5 peaks for comb pattern
		return sources
	}

	// Look for regular spacing
	used := make(map[int]bool)
	for i := 0; i < len(peaks)-3; i++ {
		if used[i] {
			continue
		}

		spacing1 := peaks[i+1].FrequencyHz - peaks[i].FrequencyHz
		spacing2 := peaks[i+2].FrequencyHz - peaks[i+1].FrequencyHz
		spacing3 := peaks[i+3].FrequencyHz - peaks[i+2].FrequencyHz

		// Check if spacings are similar (within 5%)
		avgSpacing := (spacing1 + spacing2 + spacing3) / 3
		tolerance := avgSpacing * 0.05

		if math.Abs(spacing1-avgSpacing) < tolerance &&
			math.Abs(spacing2-avgSpacing) < tolerance &&
			math.Abs(spacing3-avgSpacing) < tolerance {

			// Found a comb pattern
			combPeaks := []HarmonicPeak{peaks[i], peaks[i+1], peaks[i+2], peaks[i+3]}
			used[i] = true
			used[i+1] = true
			used[i+2] = true
			used[i+3] = true

			// Extend the pattern
			for j := i + 4; j < len(peaks); j++ {
				if used[j] {
					continue
				}
				expectedFreq := combPeaks[len(combPeaks)-1].FrequencyHz + avgSpacing
				if math.Abs(peaks[j].FrequencyHz-expectedFreq) < tolerance {
					combPeaks = append(combPeaks, peaks[j])
					used[j] = true
				} else {
					break
				}
			}

			if len(combPeaks) >= 4 {
				source := createCombSource(combPeaks, avgSpacing, baseline)
				sources = append(sources, source)
			}
		}
	}

	return sources
}

// createCombSource creates a comb pattern noise source
func createCombSource(peaks []HarmonicPeak, spacing float64, baseline float32) NoiseSource {
	affectedBins := []int{}
	maxPower := float32(-999)
	peakBin := peaks[0].Bin

	for _, p := range peaks {
		affectedBins = append(affectedBins, p.Bin)
		if p.PowerDB > maxPower {
			maxPower = p.PowerDB
			peakBin = p.Bin
		}
	}

	centerFreq := (peaks[0].FrequencyHz + peaks[len(peaks)-1].FrequencyHz) / 2
	bandwidth := peaks[len(peaks)-1].FrequencyHz - peaks[0].FrequencyHz

	confidence := float32(len(peaks)) * 12.0 // 4 peaks = 48%, 8 = 96%
	if confidence > 100 {
		confidence = 100
	}

	description := fmt.Sprintf("Comb pattern: %d peaks spaced %.1f kHz apart",
		len(peaks), spacing/1e3)

	likelySource := "Digital device, microprocessor clock, or data transmission"

	elevation := maxPower - baseline
	severity := "medium"
	if elevation > 15 {
		severity = "high"
	} else if elevation > 10 {
		severity = "medium"
	}

	return NoiseSource{
		Type:             NoiseTypeComb,
		Confidence:       confidence,
		StartFrequencyHz: centerFreq,
		BandwidthHz:      bandwidth,
		PeakPowerDB:      maxPower,
		AveragePowerDB:   maxPower,
		StartBin:         peaks[0].Bin,
		EndBin:           peaks[len(peaks)-1].Bin,
		PeakBin:          peakBin,
		AffectedBins:     affectedBins,
		SpacingHz:        spacing,
		Description:      description,
		Severity:         severity,
		LikelySource:     likelySource,
	}
}

// detectPowerlineNoise detects 50/60 Hz harmonics
func detectPowerlineNoise(fft *BandFFT, baseline float32) []NoiseSource {
	// Powerline harmonics are typically below 10 kHz, which is below our HF range
	// This function is a placeholder for completeness
	return []NoiseSource{}
}

// detectBroadbandPeaks detects peaks with wideband noise spreading from them
func detectBroadbandPeaks(fft *BandFFT, baseline float32) []NoiseSource {
	sources := []NoiseSource{}

	peaks := findPeaks(fft, baseline+20.0) // Very strong peaks only (more conservative)

	for _, peak := range peaks {
		// Check if noise spreads from this peak
		leftSpread := 0
		rightSpread := 0
		threshold := baseline + 6.0

		// Measure spread to the left
		for i := peak.Bin - 1; i >= 0; i-- {
			if fft.Data[i] > threshold {
				leftSpread++
			} else {
				break
			}
		}

		// Measure spread to the right
		for i := peak.Bin + 1; i < len(fft.Data); i++ {
			if fft.Data[i] > threshold {
				rightSpread++
			} else {
				break
			}
		}

		// If significant spread on both sides, it's a broadband peak
		minSpreadBins := int(100e3 / fft.BinWidth) // At least 100 kHz spread
		if leftSpread > minSpreadBins && rightSpread > minSpreadBins {
			source := createBroadbandPeakSource(fft, peak, leftSpread, rightSpread, baseline)
			sources = append(sources, source)
		}
	}

	return sources
}

// createBroadbandPeakSource creates a broadband peak noise source
func createBroadbandPeakSource(fft *BandFFT, peak HarmonicPeak, leftSpread, rightSpread int, baseline float32) NoiseSource {
	startBin := peak.Bin - leftSpread
	endBin := peak.Bin + rightSpread

	startFreq := float64(fft.StartFreq)
	centerFreq := startFreq + float64(peak.Bin)*fft.BinWidth
	bandwidth := float64(leftSpread+rightSpread) * fft.BinWidth

	affectedBins := []int{}
	for i := startBin; i <= endBin; i++ {
		affectedBins = append(affectedBins, i)
	}

	elevation := peak.PowerDB - baseline
	confidence := float32(math.Min(100, float64(elevation)*4)) // 25 dB = 100%

	description := fmt.Sprintf("Broadband peak at %.3f MHz with %.1f kHz spread",
		centerFreq/1e6, bandwidth/1e3)

	severity := "high"
	if elevation > 20 {
		severity = "critical"
	}

	return NoiseSource{
		Type:             NoiseTypeBroadbandPeak,
		Confidence:       confidence,
		StartFrequencyHz: centerFreq,
		BandwidthHz:      bandwidth,
		PeakPowerDB:      peak.PowerDB,
		AveragePowerDB:   peak.PowerDB,
		StartBin:         startBin,
		EndBin:           endBin,
		PeakBin:          peak.Bin,
		AffectedBins:     affectedBins,
		Description:      description,
		Severity:         severity,
		LikelySource:     "Arcing power line, faulty equipment, or strong local transmitter",
	}
}

// detectNarrowbandSpikes detects isolated narrowband spikes
func detectNarrowbandSpikes(fft *BandFFT, baseline float32) []NoiseSource {
	sources := []NoiseSource{}

	threshold := baseline + 18.0             // 18 dB above baseline (much more conservative)
	maxWidthBins := int(10e3 / fft.BinWidth) // Max 10 kHz wide

	// Limit total number of spikes to prevent overwhelming the system
	maxSpikes := 10

	startFreq := float64(fft.StartFreq)

	for i := 1; i < len(fft.Data)-1; i++ {
		if fft.Data[i] > threshold &&
			fft.Data[i] > fft.Data[i-1]+3 &&
			fft.Data[i] > fft.Data[i+1]+3 {

			// Found a spike, measure its width
			width := 1
			for j := 1; j < maxWidthBins && i-j >= 0 && i+j < len(fft.Data); j++ {
				if fft.Data[i-j] > baseline+3 || fft.Data[i+j] > baseline+3 {
					width = j * 2
				} else {
					break
				}
			}

			if width <= maxWidthBins {
				freq := startFreq + float64(i)*fft.BinWidth
				bandwidth := float64(width) * fft.BinWidth

				affectedBins := []int{}
				for j := i - width/2; j <= i+width/2 && j >= 0 && j < len(fft.Data); j++ {
					affectedBins = append(affectedBins, j)
				}

				elevation := fft.Data[i] - baseline
				confidence := float32(math.Min(100, float64(elevation)*5)) // 20 dB = 100%

				description := fmt.Sprintf("Narrowband spike at %.3f MHz (%.1f kHz wide)",
					freq/1e6, bandwidth/1e3)

				severity := "low"
				if elevation > 20 {
					severity = "high"
				} else if elevation > 15 {
					severity = "medium"
				}

				source := NoiseSource{
					Type:             NoiseTypeNarrowbandSpike,
					Confidence:       confidence,
					StartFrequencyHz: freq,
					BandwidthHz:      bandwidth,
					PeakPowerDB:      fft.Data[i],
					AveragePowerDB:   fft.Data[i],
					StartBin:         i - width/2,
					EndBin:           i + width/2,
					PeakBin:          i,
					AffectedBins:     affectedBins,
					Description:      description,
					Severity:         severity,
					LikelySource:     "Birdie, oscillator, or narrow interference",
				}

				sources = append(sources, source)

				// Limit total spikes to prevent overwhelming the system
				if len(sources) >= maxSpikes {
					return sources
				}
			}
		}
	}

	return sources
}
