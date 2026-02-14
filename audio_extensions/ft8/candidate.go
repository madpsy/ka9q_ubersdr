package ft8

/*
 * Candidate Decoding
 * Decodes a single FT8/FT4 candidate using LDPC and CRC
 */

// DecodeStatus contains the status of decoding steps
type DecodeStatus struct {
	LDPCErrors    int    // Number of LDPC parity errors
	CRCExtracted  uint16 // CRC value from message
	CRCCalculated uint16 // CRC value calculated
	Frequency     float32
	Time          float32
	Codeword      []uint8 // 174-bit LDPC codeword (for SNR calculation)
}

// Message represents a decoded FT8/FT4 message
type Message struct {
	Payload [10]uint8 // 77-bit payload (10 bytes)
	Hash    uint16    // Message hash (from CRC)
}

// DecodeCandidate attempts to decode a candidate
// Returns: decoded message, status, and success flag
func DecodeCandidate(wf *Waterfall, cand *Candidate, protocol Protocol, maxIterations int) (*Message, *DecodeStatus, bool) {
	status := &DecodeStatus{}

	// Calculate frequency and time for status
	symbolPeriod := protocol.GetSymbolTime()
	status.Frequency = float32(GetCandidateFrequency(wf, cand, symbolPeriod))
	status.Time = float32(GetCandidateTime(wf, cand, symbolPeriod))

	// Extract log-likelihood values for 174 bits
	log174 := ExtractLikelihood(wf, cand, protocol)

	// Perform LDPC decoding
	plain174, ldpcErrors := LDPCDecode(log174, maxIterations)
	status.LDPCErrors = ldpcErrors

	// Store the codeword for SNR calculation
	status.Codeword = plain174

	if ldpcErrors > 0 {
		return nil, status, false
	}

	// Pack the first 91 bits (payload + CRC) into bytes
	a91 := PackBits(plain174[:FTX_LDPC_K], FTX_LDPC_K)

	// Extract and verify CRC
	status.CRCExtracted = ExtractCRC(a91)

	// Zero-extend from 77 to 82 bits for CRC calculation
	// 'The CRC is calculated on the source-encoded message, zero-extended from 77 to 82 bits'
	a91[9] &= 0xF8
	a91[10] &= 0x00
	status.CRCCalculated = ComputeCRC(a91, 96-14) // 82 bits

	if status.CRCExtracted != status.CRCCalculated {
		return nil, status, false
	}

	// Create message
	message := &Message{
		Hash: status.CRCCalculated,
	}

	// Handle FT4 XOR descrambling
	if protocol == ProtocolFT4 {
		// FT4: XOR with pseudorandom sequence
		for i := 0; i < 10; i++ {
			message.Payload[i] = a91[i] ^ FT4_XOR_sequence[i]
		}
	} else {
		// FT8: use as-is
		for i := 0; i < 10; i++ {
			message.Payload[i] = a91[i]
		}
	}

	return message, status, true
}
