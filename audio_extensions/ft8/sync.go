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

	// Determine number of tones based on protocol
	numTones := 8
	if wf.Protocol == ProtocolFT4 {
		numTones = 4
	}

	// Search through time and frequency
	// Note: time_offset can be negative to allow partial sync patterns at boundaries
	for timeSub := 0; timeSub < wf.TimeOSR; timeSub++ {
		for freqSub := 0; freqSub < wf.FreqOSR; freqSub++ {
			// Allow time offsets from -10 to +20 like reference implementation
			// This allows us to decode signals that start before or after slot boundary
			for timeOffset := -10; timeOffset < 20; timeOffset++ {
				// Frequency offset must fit all tones within the waterfall
				for freqOffset := 0; freqOffset+numTones-1 < wf.NumBins; freqOffset++ {
					// Calculate sync score based on protocol
					var score int
					if wf.Protocol == ProtocolFT8 {
						score = calculateFT8SyncScore(wf, timeOffset, freqOffset, timeSub, freqSub)
					} else {
						score = calculateFT4SyncScore(wf, timeOffset, freqOffset, timeSub, freqSub)
					}

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

// calculateFT8SyncScore calculates sync score for FT8
func calculateFT8SyncScore(wf *Waterfall, timeOffset, freqOffset, timeSub, freqSub int) int {
	score := 0
	numAverage := 0

	// Compute average score over sync symbols (blocks 0-7, 36-43, 72-79)
	for m := 0; m < FT8_NUM_SYNC; m++ {
		for k := 0; k < FT8_LENGTH_SYNC; k++ {
			block := (FT8_SYNC_OFFSET * m) + k
			blockAbs := timeOffset + block

			// Check for time boundaries
			if blockAbs < 0 {
				continue
			}
			if blockAbs >= wf.NumBlocks {
				break
			}

			// Expected tone for this sync symbol
			sm := int(FT8_Costas_pattern[k])

			// Get magnitude at expected tone
			expectedMag := int(getWaterfallMag(wf, blockAbs, freqOffset+sm, timeSub, freqSub))

			// Check only the neighbors of the expected symbol frequency- and time-wise
			if sm > 0 {
				// Look at one frequency bin lower
				lowerMag := int(getWaterfallMag(wf, blockAbs, freqOffset+sm-1, timeSub, freqSub))
				score += expectedMag - lowerMag
				numAverage++
			}
			if sm < 7 {
				// Look at one frequency bin higher
				higherMag := int(getWaterfallMag(wf, blockAbs, freqOffset+sm+1, timeSub, freqSub))
				score += expectedMag - higherMag
				numAverage++
			}
			if k > 0 && blockAbs > 0 {
				// Look one symbol back in time
				prevMag := int(getWaterfallMag(wf, blockAbs-1, freqOffset+sm, timeSub, freqSub))
				score += expectedMag - prevMag
				numAverage++
			}
			if k+1 < FT8_LENGTH_SYNC && blockAbs+1 < wf.NumBlocks {
				// Look one symbol forward in time
				nextMag := int(getWaterfallMag(wf, blockAbs+1, freqOffset+sm, timeSub, freqSub))
				score += expectedMag - nextMag
				numAverage++
			}
		}
	}

	if numAverage > 0 {
		return score / numAverage
	}
	return score
}

// calculateFT4SyncScore calculates sync score for FT4
func calculateFT4SyncScore(wf *Waterfall, timeOffset, freqOffset, timeSub, freqSub int) int {
	score := 0
	numAverage := 0

	// Compute average score over sync symbols (blocks 1-4, 34-37, 67-70, 100-103)
	for m := 0; m < FT4_NUM_SYNC; m++ {
		for k := 0; k < FT4_LENGTH_SYNC; k++ {
			block := 1 + (FT4_SYNC_OFFSET * m) + k
			blockAbs := timeOffset + block

			// Check for time boundaries
			if blockAbs < 0 {
				continue
			}
			if blockAbs >= wf.NumBlocks {
				break
			}

			// Expected tone for this sync symbol (FT4 has 4 different patterns)
			sm := int(FT4_Costas_pattern[m][k])

			// Get magnitude at expected tone
			expectedMag := int(getWaterfallMag(wf, blockAbs, freqOffset+sm, timeSub, freqSub))

			// Check only the neighbors of the expected symbol frequency- and time-wise
			if sm > 0 {
				// Look at one frequency bin lower
				lowerMag := int(getWaterfallMag(wf, blockAbs, freqOffset+sm-1, timeSub, freqSub))
				score += expectedMag - lowerMag
				numAverage++
			}
			if sm < 3 {
				// Look at one frequency bin higher
				higherMag := int(getWaterfallMag(wf, blockAbs, freqOffset+sm+1, timeSub, freqSub))
				score += expectedMag - higherMag
				numAverage++
			}
			if k > 0 && blockAbs > 0 {
				// Look one symbol back in time
				prevMag := int(getWaterfallMag(wf, blockAbs-1, freqOffset+sm, timeSub, freqSub))
				score += expectedMag - prevMag
				numAverage++
			}
			if k+1 < FT4_LENGTH_SYNC && blockAbs+1 < wf.NumBlocks {
				// Look one symbol forward in time
				nextMag := int(getWaterfallMag(wf, blockAbs+1, freqOffset+sm, timeSub, freqSub))
				score += expectedMag - nextMag
				numAverage++
			}
		}
	}

	if numAverage > 0 {
		return score / numAverage
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
	// Reference: freq_hz = (mon->min_bin + cand->freq_offset + (float)cand->freq_sub / wf->freq_osr) / mon->symbol_period
	freq := (float64(wf.MinBin) + float64(cand.FreqOffset) + float64(cand.FreqSub)/float64(wf.FreqOSR)) / symbolPeriod
	return freq
}

// GetCandidateTime calculates the time offset of a candidate
func GetCandidateTime(wf *Waterfall, cand *Candidate, symbolPeriod float64) float64 {
	// Time = (timeOffset + timeSub/timeOSR) * symbolPeriod
	time := (float64(cand.TimeOffset) + float64(cand.TimeSub)/float64(wf.TimeOSR)) * symbolPeriod
	return time
}
