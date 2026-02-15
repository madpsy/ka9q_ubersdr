package ft8

import (
	"math"
)

/*
 * Symbol Extraction
 * Extracts soft-decision log-likelihood ratios from waterfall
 */

// ExtractLikelihood extracts 174 log-likelihood values for LDPC decoding
func ExtractLikelihood(wf *Waterfall, cand *Candidate, protocol Protocol) []float32 {
	log174 := make([]float32, FTX_LDPC_N)

	if protocol == ProtocolFT4 {
		extractLikelihoodFT4(wf, cand, log174)
	} else {
		extractLikelihoodFT8(wf, cand, log174)
	}

	// Normalize the log-likelihood values
	normalizeLikelihood(log174)

	return log174
}

// extractLikelihoodFT8 extracts likelihood for FT8 (58 data symbols, 3 bits each = 174 bits)
func extractLikelihoodFT8(wf *Waterfall, cand *Candidate, log174 []float32) {
	// Get pointer to first symbol of candidate
	baseIdx := getCandidateIndex(wf, cand)

	// Go over 58 data symbols, skipping Costas sync symbols
	// FT8 structure: 7 sync, 29 data, 7 sync, 29 data, 7 sync
	for k := 0; k < FT8_ND; k++ {
		// Skip sync symbols: first 7, then 7 more after 29 data symbols
		var symIdx int
		if k < 29 {
			symIdx = k + 7 // Skip first 7 sync symbols
		} else {
			symIdx = k + 14 // Skip first 7 + second 7 sync symbols
		}

		bitIdx := 3 * k

		// Check time boundaries
		block := int(cand.TimeOffset) + symIdx
		if block < 0 || block >= wf.NumBlocks {
			// Out of bounds, set to zero
			log174[bitIdx+0] = 0
			log174[bitIdx+1] = 0
			log174[bitIdx+2] = 0
		} else {
			// Extract 3 bits from this symbol
			magIdx := baseIdx + symIdx*wf.BlockStride
			extractSymbolFT8(wf.Mag, magIdx, log174[bitIdx:bitIdx+3])
		}
	}
}

// extractLikelihoodFT4 extracts likelihood for FT4 (87 data symbols, 2 bits each = 174 bits)
func extractLikelihoodFT4(wf *Waterfall, cand *Candidate, log174 []float32) {
	// Get pointer to first symbol of candidate
	baseIdx := getCandidateIndex(wf, cand)

	// Go over 87 data symbols, skipping Costas sync symbols and ramp symbols
	// FT4 structure: R, 4 sync, 29 data, 4 sync, 29 data, 4 sync, 29 data, 4 sync, R
	for k := 0; k < FT4_ND; k++ {
		// Skip ramp and sync symbols
		var symIdx int
		if k < 29 {
			symIdx = k + 5 // Skip R + 4 sync
		} else if k < 58 {
			symIdx = k + 9 // Skip R + 4 + 29 + 4 sync
		} else {
			symIdx = k + 13 // Skip R + 4 + 29 + 4 + 29 + 4 sync
		}

		bitIdx := 2 * k

		// Check time boundaries
		block := int(cand.TimeOffset) + symIdx
		if block < 0 || block >= wf.NumBlocks {
			// Out of bounds, set to zero
			log174[bitIdx+0] = 0
			log174[bitIdx+1] = 0
		} else {
			// Extract 2 bits from this symbol
			magIdx := baseIdx + symIdx*wf.BlockStride
			extractSymbolFT4(wf.Mag, magIdx, log174[bitIdx:bitIdx+2])
		}
	}
}

// extractSymbolFT8 extracts 3 soft bits from one FT8 symbol (8-FSK)
func extractSymbolFT8(mag []uint8, idx int, logl []float32) {
	// Get magnitudes for all 8 tones (Gray-coded)
	s2 := make([]float32, 8)
	for j := 0; j < 8; j++ {
		grayIdx := FT8_Gray_map[j]
		if idx+int(grayIdx) < len(mag) {
			// Convert uint8 magnitude to float (0-255 -> -120 to +7.5 dB)
			s2[j] = float32(mag[idx+int(grayIdx)])*0.5 - 120.0
		}
	}

	// Compute log-likelihood ratios for 3 bits
	// Each bit divides the 8 tones into two groups of 4
	// logl[i] = log(P(bit=1) / P(bit=0)) = max(tones where bit=1) - max(tones where bit=0)

	// Bit 0 (MSB): tones 4-7 vs 0-3
	logl[0] = max4(s2[4], s2[5], s2[6], s2[7]) - max4(s2[0], s2[1], s2[2], s2[3])

	// Bit 1: tones 2,3,6,7 vs 0,1,4,5
	logl[1] = max4(s2[2], s2[3], s2[6], s2[7]) - max4(s2[0], s2[1], s2[4], s2[5])

	// Bit 2 (LSB): tones 1,3,5,7 vs 0,2,4,6
	logl[2] = max4(s2[1], s2[3], s2[5], s2[7]) - max4(s2[0], s2[2], s2[4], s2[6])
}

// extractSymbolFT4 extracts 2 soft bits from one FT4 symbol (4-FSK)
func extractSymbolFT4(mag []uint8, idx int, logl []float32) {
	// Get magnitudes for all 4 tones (Gray-coded)
	s2 := make([]float32, 4)
	for j := 0; j < 4; j++ {
		grayIdx := FT4_Gray_map[j]
		if idx+int(grayIdx) < len(mag) {
			// Convert uint8 magnitude to float
			s2[j] = float32(mag[idx+int(grayIdx)])*0.5 - 120.0
		}
	}

	// Compute log-likelihood ratios for 2 bits
	// Bit 0: tones 2,3 vs 0,1
	logl[0] = max2(s2[2], s2[3]) - max2(s2[0], s2[1])

	// Bit 1: tones 1,3 vs 0,2
	logl[1] = max2(s2[1], s2[3]) - max2(s2[0], s2[2])
}

// normalizeLikelihood normalizes the log-likelihood distribution
func normalizeLikelihood(log174 []float32) {
	// Compute variance
	var sum, sum2 float32
	for i := 0; i < FTX_LDPC_N; i++ {
		sum += log174[i]
		sum2 += log174[i] * log174[i]
	}

	invN := 1.0 / float32(FTX_LDPC_N)
	variance := (sum2 - (sum * sum * invN)) * invN

	// Normalize and scale (experimentally found coefficient from ft8_lib)
	normFactor := float32(math.Sqrt(float64(24.0 / variance)))
	for i := 0; i < FTX_LDPC_N; i++ {
		log174[i] *= normFactor
	}
}

// getCandidateIndex calculates the waterfall array index for a candidate
func getCandidateIndex(wf *Waterfall, cand *Candidate) int {
	offset := int(cand.TimeOffset)
	offset = (offset * wf.TimeOSR) + int(cand.TimeSub)
	offset = (offset * wf.FreqOSR) + int(cand.FreqSub)
	offset = (offset * wf.NumBins) + int(cand.FreqOffset)
	return offset
}

// max2 returns the maximum of two values
func max2(a, b float32) float32 {
	if a >= b {
		return a
	}
	return b
}

// max4 returns the maximum of four values
func max4(a, b, c, d float32) float32 {
	return max2(max2(a, b), max2(c, d))
}
