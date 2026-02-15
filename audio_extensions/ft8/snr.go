package ft8

import (
	"log"
	"math"
)

/*
 * SNR Calculation
 * Implements WSJT-X method for calculating signal-to-noise ratio
 * Reference: WSJT-X lib/ft8/ft8b.f90 lines 440-461
 */

// CalculateSNRFromBits computes SNR from the 174-bit codeword
// This is the main entry point called by the decoder after successful decode
func CalculateSNRFromBits(wf *Waterfall, cand *Candidate, codeword []uint8, protocol Protocol) float32 {
	// Reconstruct the transmitted tones from the codeword
	itone := GetTonesFromBits(codeword, protocol)

	// Calculate SNR using the tone sequence
	return CalculateSNR(wf, cand, itone, protocol)
}

// CalculateSNR computes SNR using WSJT-X method
// Measures signal power at decoded tone positions vs noise at offset positions
// This is called AFTER successful LDPC decode when we know the transmitted tones
func CalculateSNR(wf *Waterfall, cand *Candidate, itone []int, protocol Protocol) float32 {
	// WSJT-X uses s8(0:7,NN) array which contains magnitude for each tone at each symbol
	// We need to extract the same information from our waterfall
	// Reference: WSJT-X lib/ft8/ft8b.f90 lines 440-444

	var xsig, xnoi float64
	var xbase float64
	numSymbols := len(itone)
	validSamples := 0

	numTones := 8
	if protocol == ProtocolFT4 {
		numTones = 4
	}

	// Measure signal and noise power across all symbols
	for i := 0; i < numSymbols; i++ {
		block := int(cand.TimeOffset) + i

		if block < 0 || block >= wf.NumBlocks {
			continue
		}

		// Get the transmitted tone for this symbol
		tone := itone[i]

		// Get magnitude at expected tone (signal)
		// Use getWaterfallMag which properly handles the waterfall indexing
		mag := getWaterfallMag(wf, block, int(cand.FreqOffset)+tone, int(cand.TimeSub), int(cand.FreqSub))

		// Convert uint8 magnitude to linear power
		// Waterfall encoding: scaled = 2*db + 240
		// So: db = (mag - 240) / 2
		// Linear power = 10^(db/10)
		magDB := (float64(mag) - 240.0) / 2.0
		power := math.Pow(10.0, magDB/10.0)
		xsig += power * power // Sum of squared magnitudes
		xbase += power        // Sum for baseline calculation

		// Get magnitude at offset tone (noise)
		// WSJT-X uses: ios = mod(itone(i)+4, 7) for FT8
		// This wraps around the 8-tone alphabet
		noiseTone := (tone + 4) % numTones
		noiseMag := getWaterfallMag(wf, block, int(cand.FreqOffset)+noiseTone, int(cand.TimeSub), int(cand.FreqSub))
		noiseMagDB := (float64(noiseMag) - 240.0) / 2.0
		noisePower := math.Pow(10.0, noiseMagDB/10.0)
		xnoi += noisePower * noisePower

		validSamples++
	}

	// Calculate SNR using WSJT-X formula
	// Reference: ft8b.f90 lines 445-461

	// Debug logging
	if validSamples > 0 && xbase > 0 {
		// Log first calculation for debugging
		log.Printf("[SNR Debug] validSamples=%d, xsig=%.6e, xbase=%.6e, xnoi=%.6e, xsig/xbase=%.6e",
			validSamples, xsig, xbase, xnoi, xsig/xbase)
	}

	// Method 1: Signal/Noise ratio
	// xsnr = 10.0*log10(xsig/xnoi - 1.0) - 27.0
	// Method 2: Signal/Baseline ratio (used for initial decodes)
	// xsnr2 = 10.0*log10(xsig/xbase/3.0e6 - 1.0) - 27.0

	// Calculate using baseline method (more stable, used by WSJT-X for first-pass)
	finalSNR := -24.0
	if xbase > 0 && validSamples > 0 {
		arg := xsig/xbase/3.0e6 - 1.0
		if arg > 0.1 {
			finalSNR = 10.0*math.Log10(arg) - 27.0
		} else {
			log.Printf("[SNR Debug] arg too small: %.6e (xsig/xbase/3e6 - 1)", arg)
		}
	} else {
		log.Printf("[SNR Debug] xbase=%.6e, validSamples=%d - returning minimum", xbase, validSamples)
	}

	// Clamp to minimum SNR
	// Reference: ft8b.f90 line 460
	if finalSNR < -24.0 {
		finalSNR = -24.0
	}

	return float32(finalSNR)
}

// CalculateSNRFromSync provides a quick SNR estimate from sync score
// This matches WSJT-X's initial estimate in ft8d.f90 line 53
// Used before decoding when we don't have the transmitted tones yet
func CalculateSNRFromSync(syncScore int) float32 {
	// Reference: WSJT-X lib/ft8/ft8d.f90 line 53
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
// This implements WSJT-X's get_ft8_tones_from_77bits function
// Reference: WSJT-X lib/ft8/genft8.f90 lines 28-43
func GetTonesFromBits(codeword []uint8, protocol Protocol) []int {
	if protocol == ProtocolFT8 {
		return getTonesFromBitsFT8(codeword)
	} else {
		return getTonesFromBitsFT4(codeword)
	}
}

// getTonesFromBitsFT8 extracts 79 tones for FT8 from 174-bit codeword
// Reference: WSJT-X lib/ft8/genft8.f90 lines 32-43
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
