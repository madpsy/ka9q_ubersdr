package ft8

import (
	"math"
)

// CalculateSNRFromBits computes SNR from the 174-bit codeword
// This is the main entry point called by the decoder after successful decode
func CalculateSNRFromBits(wf *Waterfall, cand *Candidate, codeword []uint8, protocol Protocol) float32 {
	// Reconstruct the transmitted tones from the codeword
	itone := GetTonesFromBits(codeword, protocol)

	// Calculate SNR using the tone sequence
	return CalculateSNR(wf, cand, itone, protocol)
}

// Measures signal power at decoded tone positions vs noise at offset positions
// This is called AFTER successful LDPC decode when we know the transmitted tones
func CalculateSNR(wf *Waterfall, cand *Candidate, itone []int, protocol Protocol) float32 {
	// We need to extract the same information from our waterfall

	var xsig float64
	numSymbols := len(itone)
	validSamples := 0

	// xbase = 10.0**(0.1*(sbase(nint(f1/3.125))-40.0))
	xbase := calculateNoiseFloorBaseline(wf, cand, protocol)

	// Measure signal power across all symbols
	for i := 0; i < numSymbols; i++ {
		block := int(cand.TimeOffset) + i

		if block < 0 || block >= wf.NumBlocks {
			continue
		}

		// Get the transmitted tone for this symbol
		tone := itone[i]

		// Get magnitude at expected tone (signal)
		mag := getWaterfallMag(wf, block, int(cand.FreqOffset)+tone, int(cand.TimeSub), int(cand.FreqSub))

		// Decode uint8 to power: uint8 = 2*dB + 240, so dB = (uint8 - 240)/2
		// Then power = 10^(dB/10)
		magDB := (float64(mag) - 240.0) / 2.0
		power := math.Pow(10.0, magDB/10.0)
		xsig += power

		validSamples++
	}

	finalSNR := -24.0
	if xbase > 0 && validSamples > 0 {
		arg := xsig/xbase/3.0e6 - 1.0
		if arg > 0.1 {
			finalSNR = 10.0*math.Log10(arg) - 27.0
		}
	}

	// Clamp to minimum SNR
	if finalSNR < -24.0 {
		finalSNR = -24.0
	}

	return float32(finalSNR)
}

// calculateNoiseFloorBaseline estimates the noise floor from the waterfall
func calculateNoiseFloorBaseline(wf *Waterfall, cand *Candidate, protocol Protocol) float64 {
	// Calculate average spectrum across all time blocks
	savg := make([]float64, wf.NumBins)

	// Average power across all blocks for each frequency bin
	for block := 0; block < wf.NumBlocks; block++ {
		for freqBin := 0; freqBin < wf.NumBins; freqBin++ {
			mag := getWaterfallMag(wf, block, freqBin, int(cand.TimeSub), int(cand.FreqSub))
			// Decode uint8 to power: uint8 = 2*dB + 240, so dB = (uint8 - 240)/2
			// Then power = 10^(dB/10)
			magDB := (float64(mag) - 240.0) / 2.0
			power := math.Pow(10.0, magDB/10.0)
			savg[freqBin] += power
		}
	}

	// Normalize by number of blocks
	if wf.NumBlocks > 0 {
		for i := 0; i < wf.NumBins; i++ {
			savg[i] /= float64(wf.NumBlocks)
		}
	}

	// Fit baseline to remove signals and find noise floor
	// Use full frequency range
	nfa := 0
	nfb := wf.NumBins - 1
	sbase := calculateBaseline(savg, nfa, nfb)

	// Get baseline value at candidate frequency
	freqBin := int(cand.FreqOffset)
	if freqBin < 0 {
		freqBin = 0
	}
	if freqBin >= len(sbase) {
		freqBin = len(sbase) - 1
	}

	baseline := sbase[freqBin]

	// The -40 dB offset is a reference level adjustment
	baselinePower := math.Pow(10.0, (baseline-40.0)/10.0)

	return baselinePower
}

// CalculateSNRFromSync provides a quick SNR estimate from sync score
// Used before decoding when we don't have the transmitted tones yet
func CalculateSNRFromSync(syncScore int) float32 {
	// nsnr = min(99, nint(10.0*log10(sync) - 25.5))
	if syncScore <= 0 {
		return -24.0
	}

	snr := 10.0*math.Log10(float64(syncScore)) - 25.5

	if snr > 99.0 {
		snr = 99.0
	}
	if snr < -24.0 {
		snr = -24.0
	}

	return float32(snr)
}

// GetTonesFromBits reconstructs the transmitted tone sequence from 174-bit codeword
func GetTonesFromBits(codeword []uint8, protocol Protocol) []int {
	if protocol == ProtocolFT8 {
		return getTonesFromBitsFT8(codeword)
	} else {
		return getTonesFromBitsFT4(codeword)
	}
}

// getTonesFromBitsFT8 extracts 79 tones for FT8 from 174-bit codeword
func getTonesFromBitsFT8(codeword []uint8) []int {
	itone := make([]int, FT8_NN) // 79 symbols

	// Message structure: S7 D29 S7 D29 S7
	// Insert Costas sync patterns
	// Reference: icos7 = [3,1,4,0,6,5,2]
	for i := 0; i < 7; i++ {
		itone[i] = int(FT8_Costas_pattern[i])          // First sync block
		itone[36+i] = int(FT8_Costas_pattern[i])       // Second sync block
		itone[FT8_NN-7+i] = int(FT8_Costas_pattern[i]) // Third sync block
	}

	// Insert data symbols (58 symbols, 3 bits each = 174 bits)
	// Reference: genft8.f90 lines 36-43
	k := 7                        // Start after first sync block
	for j := 0; j < FT8_ND; j++ { // ND = 58 data symbols
		i := 3 * j // Bit index (3 bits per symbol)

		// Skip second sync block after 29 data symbols
		if j == 29 {
			k += 7
		}

		// Convert 3 bits to Gray-coded tone (0-7)
		// indx = codeword(i)*4 + codeword(i+1)*2 + codeword(i+2)
		indx := int(codeword[i])*4 + int(codeword[i+1])*2 + int(codeword[i+2])
		itone[k] = int(FT8_Gray_map[indx])
		k++
	}

	return itone
}

// getTonesFromBitsFT4 extracts 105 tones for FT4 from 174-bit codeword
func getTonesFromBitsFT4(codeword []uint8) []int {
	itone := make([]int, FT4_NN) // 105 symbols

	// FT4 structure: R Sa D29 Sb D29 Sc D29 Sd R
	// R = ramp symbol (set to 0)
	itone[0] = 0
	itone[FT4_NN-1] = 0

	// Insert Costas sync patterns (4 different patterns)
	for i := 0; i < 4; i++ {
		itone[1+i] = int(FT4_Costas_pattern[0][i])   // First sync
		itone[34+i] = int(FT4_Costas_pattern[1][i])  // Second sync
		itone[67+i] = int(FT4_Costas_pattern[2][i])  // Third sync
		itone[100+i] = int(FT4_Costas_pattern[3][i]) // Fourth sync
	}

	// Insert data symbols (87 symbols, 2 bits each = 174 bits)
	k := 5                        // Start after R + first sync
	for j := 0; j < FT4_ND; j++ { // ND = 87 data symbols
		i := 2 * j // Bit index (2 bits per symbol)

		// Skip sync blocks
		if j == 29 {
			k += 4 // Skip second sync
		} else if j == 58 {
			k += 4 // Skip third sync
		}

		// Convert 2 bits to Gray-coded tone (0-3)
		indx := int(codeword[i])*2 + int(codeword[i+1])
		itone[k] = int(FT4_Gray_map[indx])
		k++
	}

	return itone
}
