package main

// Frozen copies of the voice-activity noise floor and candidate detection as
// they were before they were optimised, so voice_activity_floor_test.go can
// require the current code to reach the same floor, the same candidates and
// the same activities. Do not "fix" these.

import (
	"fmt"
	"sort"
	"time"
)

func refEstimateNoiseFloorMedianFilter(data []float32, minFreq, maxFreq uint64, binWidth float64, startFreq uint64) float32 {
	// Use percentile approach for noise floor (more robust than median filter)
	// Take 10th percentile as noise floor estimate
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	if len(sorted) == 0 {
		return 0
	}

	// 10th percentile - robust noise floor that ignores signals
	idx := len(sorted) * 10 / 100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}

	return sorted[idx]
}

func refDetectCandidateRegions(data []float32, threshold float32, binWidth float64, startFreq uint64, params DetectionParams) []CandidateRegion {
	candidates := []CandidateRegion{}

	// K consecutive bins above threshold (edge finding)
	K := 3 // Require 3 consecutive bins to start/end a region

	// Calculate noise floor for SNR
	noiseFloor := refEstimateNoiseFloorMedianFilter(data, 0, 0, binWidth, startFreq)

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

func refDetectVoiceActivityMultiFrame(buffer *FFTBuffer, params DetectionParams, windowDuration time.Duration) []VoiceActivity {
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
		if len(frame.Data) == 0 {
			continue
		}
		// Per-frame noise floor estimation
		noiseFloor := refEstimateNoiseFloorMedianFilter(frame.Data, 1000, 3000, buffer.BinWidth, buffer.StartFreq)

		// Detect candidates in this frame
		threshold := noiseFloor + params.ThresholdDB
		frameCandidates := refDetectCandidateRegions(frame.Data, threshold, buffer.BinWidth, buffer.StartFreq, params)

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

func refDetectVoiceActivity(fft *BandFFT, params DetectionParams) []VoiceActivity {
	if fft == nil || len(fft.Data) == 0 {
		return []VoiceActivity{}
	}

	// Single-frame fallback (deprecated - use multi-frame when possible)
	// This version cannot detect temporal variations (syllabic modulation)
	// and will incorrectly classify constant carriers as voice

	// Step 1: Per-frame noise floor estimation using median filter
	noiseFloor := refEstimateNoiseFloorMedianFilter(fft.Data, 1000, 3000, fft.BinWidth, fft.StartFreq)

	// Step 2: Detect candidate regions (1.5-4 kHz bandwidth, 6-10 dB above noise)
	threshold := noiseFloor + params.ThresholdDB
	candidates := refDetectCandidateRegions(fft.Data, threshold, fft.BinWidth, fft.StartFreq, params)

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
