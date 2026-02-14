package ft8

import (
	"sort"
)

/*
 * Costas Sync Detection
 * Finds candidate signals by detecting Costas sync patterns
 */

// Candidate represents a potential FT8/FT4 signal
type Candidate struct {
	Score      int16 // Sync score (higher = better)
	TimeOffset int16 // Index of time block
	FreqOffset int16 // Index of frequency bin
	TimeSub    uint8 // Time subdivision index
	FreqSub    uint8 // Frequency subdivision index
}

// FindCandidates locates top N candidates by sync strength
func FindCandidates(wf *Waterfall, maxCandidates int, minScore int) []Candidate {
	candidates := make([]Candidate, 0, maxCandidates)

	// Get sync pattern based on protocol
	var syncPattern []uint8
	var syncLength, numSync, syncOffset int

	if wf.Protocol == ProtocolFT8 {
		syncPattern = FT8_Costas_pattern[:]
		syncLength = FT8_LENGTH_SYNC
		numSync = FT8_NUM_SYNC
		syncOffset = FT8_SYNC_OFFSET
	} else {
		// FT4 uses first Costas pattern for initial detection
		syncPattern = FT4_Costas_pattern[0][:]
		syncLength = FT4_LENGTH_SYNC
		numSync = FT4_NUM_SYNC
		syncOffset = FT4_SYNC_OFFSET
	}

	// Search through time and frequency
	for timeSub := 0; timeSub < wf.TimeOSR; timeSub++ {
		for freqSub := 0; freqSub < wf.FreqOSR; freqSub++ {
			for timeOffset := 0; timeOffset < wf.NumBlocks-syncLength*numSync; timeOffset++ {
				for freqOffset := 0; freqOffset < wf.NumBins-8; freqOffset++ {
					// Calculate sync score
					score := calculateSyncScore(wf, timeOffset, freqOffset, timeSub, freqSub,
						syncPattern, syncLength, numSync, syncOffset)

					// Only consider candidates above minimum score
					if score < minScore {
						continue
					}

					// Create candidate
					cand := Candidate{
						Score:      int16(score),
						TimeOffset: int16(timeOffset),
						FreqOffset: int16(freqOffset),
						TimeSub:    uint8(timeSub),
						FreqSub:    uint8(freqSub),
					}

					// Insert into candidate list (maintain sorted order)
					candidates = insertCandidate(candidates, cand, maxCandidates)
				}
			}
		}
	}

	return candidates
}

// calculateSyncScore calculates the sync score for a candidate position
func calculateSyncScore(wf *Waterfall, timeOffset, freqOffset, timeSub, freqSub int,
	syncPattern []uint8, syncLength, numSync, syncOffset int) int {

	score := 0

	// Check all sync blocks
	for syncIdx := 0; syncIdx < numSync; syncIdx++ {
		syncStart := timeOffset + syncIdx*syncOffset

		// Check each symbol in the sync pattern
		for i := 0; i < syncLength; i++ {
			symbolTime := syncStart + i
			if symbolTime >= wf.NumBlocks {
				break
			}

			// Expected tone for this sync symbol
			expectedTone := int(syncPattern[i])

			// Get magnitude at expected tone
			expectedMag := getWaterfallMag(wf, symbolTime, freqOffset+expectedTone, timeSub, freqSub)

			// Get average magnitude of other tones (noise estimate)
			noiseMag := 0
			noiseCount := 0
			for tone := 0; tone < 8; tone++ {
				if tone != expectedTone {
					mag := getWaterfallMag(wf, symbolTime, freqOffset+tone, timeSub, freqSub)
					noiseMag += int(mag)
					noiseCount++
				}
			}
			if noiseCount > 0 {
				noiseMag /= noiseCount
			}

			// Score is signal minus noise
			score += int(expectedMag) - noiseMag
		}
	}

	return score
}

// getWaterfallMag retrieves magnitude from waterfall at specified position
func getWaterfallMag(wf *Waterfall, block, bin, timeSub, freqSub int) uint8 {
	if block < 0 || block >= wf.NumBlocks {
		return 0
	}
	if bin < 0 || bin >= wf.NumBins {
		return 0
	}

	// Calculate index: [block][timeSub][freqSub][bin]
	idx := block*wf.BlockStride + timeSub*wf.FreqOSR*wf.NumBins + freqSub*wf.NumBins + bin

	if idx < 0 || idx >= len(wf.Mag) {
		return 0
	}

	return wf.Mag[idx]
}

// insertCandidate inserts a candidate into the sorted list (min-heap behavior)
func insertCandidate(candidates []Candidate, newCand Candidate, maxCandidates int) []Candidate {
	// If list is not full, just append
	if len(candidates) < maxCandidates {
		candidates = append(candidates, newCand)
		sort.Slice(candidates, func(i, j int) bool {
			return candidates[i].Score > candidates[j].Score
		})
		return candidates
	}

	// If new candidate is better than worst candidate, replace it
	if newCand.Score > candidates[len(candidates)-1].Score {
		candidates[len(candidates)-1] = newCand
		sort.Slice(candidates, func(i, j int) bool {
			return candidates[i].Score > candidates[j].Score
		})
	}

	return candidates
}

// GetCandidateFrequency calculates the audio frequency of a candidate
func GetCandidateFrequency(wf *Waterfall, cand *Candidate, symbolPeriod float64) float64 {
	// Frequency = (minBin + freqOffset + freqSub/freqOSR) / symbolPeriod
	// where each bin represents 6.25 Hz (1/symbolPeriod for FT8)
	freq := (float64(cand.FreqOffset) + float64(cand.FreqSub)/float64(wf.FreqOSR)) / symbolPeriod
	return freq
}

// GetCandidateTime calculates the time offset of a candidate
func GetCandidateTime(wf *Waterfall, cand *Candidate, symbolPeriod float64) float64 {
	// Time = (timeOffset + timeSub/timeOSR) * symbolPeriod
	time := (float64(cand.TimeOffset) + float64(cand.TimeSub)/float64(wf.TimeOSR)) * symbolPeriod
	return time
}
