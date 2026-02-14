package ft8

/*
 * CRC-14 for FT8/FT4
 * Converted from ft8_lib by Karlis Goba (YL3JG)
 */

const (
	CRC_TOPBIT = 1 << (FT8_CRC_WIDTH - 1)
)

// ComputeCRC calculates 14-bit CRC for a sequence of bits
// Adapted from https://barrgroup.com/Embedded-Systems/How-To/CRC-Calculation-C-Code
// message: byte sequence (MSB first)
// numBits: number of bits in the sequence
func ComputeCRC(message []uint8, numBits int) uint16 {
	remainder := uint16(0)
	idxByte := 0

	// Perform modulo-2 division, a bit at a time
	for idxBit := 0; idxBit < numBits; idxBit++ {
		if idxBit%8 == 0 {
			// Bring the next byte into the remainder
			remainder ^= uint16(message[idxByte]) << (FT8_CRC_WIDTH - 8)
			idxByte++
		}

		// Try to divide the current data bit
		if remainder&CRC_TOPBIT != 0 {
			remainder = (remainder << 1) ^ FT8_CRC_POLYNOMIAL
		} else {
			remainder = remainder << 1
		}
	}

	return remainder & ((CRC_TOPBIT << 1) - 1)
}

// ExtractCRC extracts the CRC from a 91-bit message (77 bits payload + 14 bits CRC)
// a91: 12 bytes containing 91 bits (77 payload + 14 CRC)
func ExtractCRC(a91 []uint8) uint16 {
	// CRC is stored in bits 77-90 (14 bits)
	// a91[9] bits 0-2 (3 bits, upper part)
	// a91[10] all 8 bits (middle part)
	// a91[11] bits 5-7 (3 bits, lower part)
	chksum := uint16(a91[9]&0x07)<<11 | uint16(a91[10])<<3 | uint16(a91[11]>>5)
	return chksum
}

// PackBits packs an array of bits (0/1) into bytes (MSB first)
// plain: array of bits (0 or 1)
// numBits: number of bits to pack
// Returns: packed bytes
func PackBits(plain []uint8, numBits int) []uint8 {
	numBytes := (numBits + 7) / 8
	packed := make([]uint8, numBytes)

	for i := 0; i < numBits; i++ {
		if plain[i] != 0 {
			packed[i/8] |= 1 << (7 - (i % 8))
		}
	}

	return packed
}
