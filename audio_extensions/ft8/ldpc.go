package ft8

// LDPCDecode decodes a 174-bit codeword using LDPC error correction
// codeword: 174 log-likelihood values (log(P(bit=0)/P(bit=1)))
// maxIters: maximum number of iterations (typically 25)
// Returns: decoded bits and number of parity errors (0 = success)
func LDPCDecode(codeword []float32, maxIters int) ([]uint8, int) {
	// Use belief propagation decoder (more efficient)
	return bpDecode(codeword, maxIters)
}

// bpDecode implements belief propagation LDPC decoding
func bpDecode(codeword []float32, maxIters int) ([]uint8, int) {
	// Message arrays
	// tov[n][m]: message from variable node n to check node m
	// toc[m][n]: message from check node m to variable node n
	var tov [FTX_LDPC_N][3]float32
	var toc [FTX_LDPC_M][7]float32

	plain := make([]uint8, FTX_LDPC_N)
	minErrors := FTX_LDPC_M

	// Initialize messages to zero
	for n := 0; n < FTX_LDPC_N; n++ {
		tov[n][0] = 0
		tov[n][1] = 0
		tov[n][2] = 0
	}

	for iter := 0; iter < maxIters; iter++ {
		// Make hard decision (tov=0 in first iteration)
		plainSum := 0
		for n := 0; n < FTX_LDPC_N; n++ {
			sum := codeword[n] + tov[n][0] + tov[n][1] + tov[n][2]
			if sum > 0 {
				plain[n] = 1
			} else {
				plain[n] = 0
			}
			plainSum += int(plain[n])
		}

		// Check for all-zeros (prohibited codeword)
		if plainSum == 0 {
			break
		}

		// Check parity constraints
		errors := ldpcCheck(plain)

		if errors < minErrors {
			minErrors = errors
			if errors == 0 {
				// Perfect decode!
				break
			}
		}

		// Send messages from variable nodes to check nodes
		for m := 0; m < FTX_LDPC_M; m++ {
			numRows := int(LDPC_Num_rows[m])
			for nIdx := 0; nIdx < numRows; nIdx++ {
				n := int(LDPC_Nm[m][nIdx]) - 1

				// Calculate message from variable node n to check node m
				Tnm := codeword[n]
				for mIdx := 0; mIdx < 3; mIdx++ {
					if int(LDPC_Mn[n][mIdx])-1 != m {
						Tnm += tov[n][mIdx]
					}
				}
				toc[m][nIdx] = fastTanh(-Tnm / 2.0)
			}
		}

		// Send messages from check nodes to variable nodes
		for n := 0; n < FTX_LDPC_N; n++ {
			for mIdx := 0; mIdx < 3; mIdx++ {
				m := int(LDPC_Mn[n][mIdx]) - 1

				// Calculate message from check node m to variable node n
				Tmn := float32(1.0)
				numRows := int(LDPC_Num_rows[m])
				for nIdx := 0; nIdx < numRows; nIdx++ {
					if int(LDPC_Nm[m][nIdx])-1 != n {
						Tmn *= toc[m][nIdx]
					}
				}
				tov[n][mIdx] = -2.0 * fastAtanh(Tmn)
			}
		}
	}

	return plain, minErrors
}

// ldpcCheck verifies if a codeword passes all LDPC parity checks
// Returns the number of parity errors (0 = success)
func ldpcCheck(codeword []uint8) int {
	errors := 0

	for m := 0; m < FTX_LDPC_M; m++ {
		x := uint8(0)
		numRows := int(LDPC_Num_rows[m])
		for i := 0; i < numRows; i++ {
			x ^= codeword[int(LDPC_Nm[m][i])-1]
		}
		if x != 0 {
			errors++
		}
	}

	return errors
}

// fastTanh computes a fast approximation of tanh(x)
// Uses rational polynomial approximation
func fastTanh(x float32) float32 {
	if x < -4.97 {
		return -1.0
	}
	if x > 4.97 {
		return 1.0
	}

	x2 := x * x
	a := x * (945.0 + x2*(105.0+x2))
	b := 945.0 + x2*(420.0+x2*15.0)
	return a / b
}

// fastAtanh computes a fast approximation of atanh(x)
// Uses rational polynomial approximation
func fastAtanh(x float32) float32 {
	x2 := x * x
	a := x * (945.0 + x2*(-735.0+x2*64.0))
	b := 945.0 + x2*(-1050.0+x2*225.0)
	return a / b
}
