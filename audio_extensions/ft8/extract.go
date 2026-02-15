package ft8

import (
	"log"
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

	// Debug: log first few symbols
	debugSymbolCount := 0

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
			extractSymbolFT8(wf.Mag, magIdx, log174[bitIdx:bitIdx+3], debugSymbolCount < 3)
			debugSymbolCount++
		}
	}
}

// extractLikelihoodFT4 extracts likelihood for FT4 (87 data symbols, 2 bits each = 174 bits)
func extractLikelihoodFT4(wf *Waterfall, cand *Candidate, log174 []float32) {
	// Get pointer to first symbol of candidate
	baseIdx := getCandidateIndex(wf, cand)

	// Debug: log first few symbols
	debugSymbolCount := 0

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
			extractSymbolFT4(wf.Mag, magIdx, log174[bitIdx:bitIdx+2], debugSymbolCount < 3)
			debugSymbolCount++
		}
	}
}

// extractSymbolFT8 extracts 3 soft bits from one FT8 symbol (8-FSK)
func extractSymbolFT8(mag []uint8, idx int, logl []float32, debug bool) {
	// Get magnitudes for all 8 tones (Gray-coded)
	s2 := make([]float32, 8)
	s2_raw := make([]float32, 8)
	magRaw := make([]uint8, 8)

	for j := 0; j < 8; j++ {
		grayIdx := FT8_Gray_map[j]
		if idx+int(grayIdx) < len(mag) {
			magRaw[j] = mag[idx+int(grayIdx)]
			// Convert uint8 magnitude to float (0-255 -> -120 to +7.5 dB)
			s2[j] = float32(magRaw[j])*0.5 - 120.0
			// Also try raw values
			s2_raw[j] = float32(magRaw[j])
		}
	}

	// Compute log-likelihood ratios for 3 bits (with conversion)
	// Each bit divides the 8 tones into two groups of 4
	// logl[i] = log(P(bit=1) / P(bit=0)) = max(tones where bit=1) - max(tones where bit=0)

	// Bit 0 (MSB): tones 4-7 vs 0-3
	logl[0] = max4(s2[4], s2[5], s2[6], s2[7]) - max4(s2[0], s2[1], s2[2], s2[3])

	// Bit 1: tones 2,3,6,7 vs 0,1,4,5
	logl[1] = max4(s2[2], s2[3], s2[6], s2[7]) - max4(s2[0], s2[1], s2[4], s2[5])

	// Bit 2 (LSB): tones 1,3,5,7 vs 0,2,4,6
	logl[2] = max4(s2[1], s2[3], s2[5], s2[7]) - max4(s2[0], s2[2], s2[4], s2[6])

	// Debug logging for first few symbols
	if debug {
		// Also compute with raw values
		logl_raw_0 := max4(s2_raw[4], s2_raw[5], s2_raw[6], s2_raw[7]) - max4(s2_raw[0], s2_raw[1], s2_raw[2], s2_raw[3])
		logl_raw_1 := max4(s2_raw[2], s2_raw[3], s2_raw[6], s2_raw[7]) - max4(s2_raw[0], s2_raw[1], s2_raw[4], s2_raw[5])
		logl_raw_2 := max4(s2_raw[1], s2_raw[3], s2_raw[5], s2_raw[7]) - max4(s2_raw[0], s2_raw[2], s2_raw[4], s2_raw[6])

		log.Printf("[FT8 Extract Debug] Raw mag: [%d, %d, %d, %d, %d, %d, %d, %d]",
			magRaw[0], magRaw[1], magRaw[2], magRaw[3], magRaw[4], magRaw[5], magRaw[6], magRaw[7])
		log.Printf("[FT8 Extract Debug] Converted s2 (dB): [%.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f]",
			s2[0], s2[1], s2[2], s2[3], s2[4], s2[5], s2[6], s2[7])
		log.Printf("[FT8 Extract Debug] Raw s2: [%.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f]",
			s2_raw[0], s2_raw[1], s2_raw[2], s2_raw[3], s2_raw[4], s2_raw[5], s2_raw[6], s2_raw[7])
		log.Printf("[FT8 Extract Debug] Log-likelihood (dB): [%.4f, %.4f, %.4f]", logl[0], logl[1], logl[2])
		log.Printf("[FT8 Extract Debug] Log-likelihood (raw): [%.4f, %.4f, %.4f]", logl_raw_0, logl_raw_1, logl_raw_2)
	}
}

// extractSymbolFT4 extracts 2 soft bits from one FT4 symbol (4-FSK)
func extractSymbolFT4(mag []uint8, idx int, logl []float32, debug bool) {
	// Get magnitudes for all 4 tones (Gray-coded)
	s2 := make([]float32, 4)
	s2_raw := make([]float32, 4)
	magRaw := make([]uint8, 4)

	for j := 0; j < 4; j++ {
		grayIdx := FT4_Gray_map[j]
		if idx+int(grayIdx) < len(mag) {
			magRaw[j] = mag[idx+int(grayIdx)]
			// Convert uint8 magnitude to float
			s2[j] = float32(magRaw[j])*0.5 - 120.0
			// Also try raw values
			s2_raw[j] = float32(magRaw[j])
		}
	}

	// Compute log-likelihood ratios for 2 bits (with conversion)
	// Bit 0: tones 2,3 vs 0,1
	logl[0] = max2(s2[2], s2[3]) - max2(s2[0], s2[1])

	// Bit 1: tones 1,3 vs 0,2
	logl[1] = max2(s2[1], s2[3]) - max2(s2[0], s2[2])

	// Debug logging for first few symbols
	if debug {
		// Also compute with raw values
		logl_raw_0 := max2(s2_raw[2], s2_raw[3]) - max2(s2_raw[0], s2_raw[1])
		logl_raw_1 := max2(s2_raw[1], s2_raw[3]) - max2(s2_raw[0], s2_raw[2])

		log.Printf("[FT4 Extract Debug] Raw mag: [%d, %d, %d, %d]", magRaw[0], magRaw[1], magRaw[2], magRaw[3])
		log.Printf("[FT4 Extract Debug] Converted s2 (dB): [%.2f, %.2f, %.2f, %.2f]", s2[0], s2[1], s2[2], s2[3])
		log.Printf("[FT4 Extract Debug] Raw s2: [%.2f, %.2f, %.2f, %.2f]", s2_raw[0], s2_raw[1], s2_raw[2], s2_raw[3])
		log.Printf("[FT4 Extract Debug] Log-likelihood (dB): [%.4f, %.4f]", logl[0], logl[1])
		log.Printf("[FT4 Extract Debug] Log-likelihood (raw): [%.4f, %.4f]", logl_raw_0, logl_raw_1)
	}
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

	// Debug: log statistics before normalization
	mean := sum * invN
	log.Printf("[Normalize Debug] Before: mean=%.4f, variance=%.4f, sum=%.4f, sum2=%.4f", mean, variance, sum, sum2)
	log.Printf("[Normalize Debug] Sample values before: [%.4f, %.4f, %.4f, %.4f, %.4f]",
		log174[0], log174[1], log174[2], log174[3], log174[4])

	// Normalize and scale (experimentally found coefficient from ft8_lib)
	normFactor := float32(math.Sqrt(float64(24.0 / variance)))
	log.Printf("[Normalize Debug] Normalization factor: %.4f", normFactor)

	for i := 0; i < FTX_LDPC_N; i++ {
		log174[i] *= normFactor
	}

	log.Printf("[Normalize Debug] Sample values after: [%.4f, %.4f, %.4f, %.4f, %.4f]",
		log174[0], log174[1], log174[2], log174[3], log174[4])
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
