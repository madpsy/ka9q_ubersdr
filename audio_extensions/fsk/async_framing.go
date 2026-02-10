package fsk

import (
	"fmt"
	"strings"
)

// AsyncFraming handles asynchronous serial framing (start/data/parity/stop bits)
// Ported from KiwiSDR FSK_async.js
type AsyncFraming struct {
	framing      string
	startBit     int
	dataBits     int
	parityBits   int
	stopBits     float64
	stopVariable bool
	nbits        int
	msb          uint32
	dataMSB      byte
	lastCode     byte
}

// NewAsyncFraming creates a new async framing handler
func NewAsyncFraming(framing string) (*AsyncFraming, error) {
	a := &AsyncFraming{
		framing:  framing,
		startBit: 1, // Always one start bit in async comm
	}

	// Parse framing string to extract data bits
	// Format: <data_bits>N<stop_bits> or <data_bits><parity><stop_bits>
	// Examples: 5N1.5, 7N1, 8N1, 7E1, 8O2
	if len(framing) == 0 {
		return nil, fmt.Errorf("empty framing string")
	}

	// Extract data bits (first character)
	switch framing[0] {
	case '5':
		a.dataBits = 5
	case '7':
		a.dataBits = 7
	case '8':
		a.dataBits = 8
	default:
		return nil, fmt.Errorf("unsupported data bits: %c", framing[0])
	}

	// Check for variable stop bits
	if strings.HasSuffix(framing, "V") || strings.Contains(framing, "EFR") {
		a.stopVariable = true
	}

	// Parse stop bits
	if strings.HasSuffix(framing, "0V") {
		a.stopBits = 0
	} else if strings.HasSuffix(framing, "1V") {
		a.stopBits = 1
	} else if strings.HasSuffix(framing, "1.5") {
		a.stopBits = 1.5
	} else if strings.HasSuffix(framing, "2") {
		a.stopBits = 2
	} else {
		a.stopBits = 1
	}

	// Check for parity
	if strings.Contains(framing, "E") || strings.Contains(framing, "O") || strings.Contains(framing, "P") {
		a.parityBits = 1
	}

	// Calculate total bits
	nbitsFloat := float64(a.startBit+a.dataBits+a.parityBits) + a.stopBits
	if a.stopBits == 1.5 {
		nbitsFloat *= 2 // Double for fractional stop bits
	}
	a.nbits = int(nbitsFloat)

	a.msb = 1 << (a.nbits - 1)
	a.dataMSB = 1 << (a.dataBits - 1)

	return a, nil
}

// GetNBits returns the total number of bits per character
func (a *AsyncFraming) GetNBits() int {
	return a.nbits
}

// GetMSB returns the MSB mask for the total bit count
// Returns byte for compatibility, but only works correctly for nbits <= 8
// For nbits > 8, use GetMSB32() instead
func (a *AsyncFraming) GetMSB() byte {
	if a.nbits <= 8 {
		return byte(a.msb)
	}
	return byte(a.msb >> (a.nbits - 8))
}

// GetMSB32 returns the full 32-bit MSB mask
func (a *AsyncFraming) GetMSB32() uint32 {
	return a.msb
}

// GetDataBits returns the number of data bits (not including start/stop/parity)
func (a *AsyncFraming) GetDataBits() int {
	return a.dataBits
}

// GetParityBits returns the number of parity bits (0 or 1)
func (a *AsyncFraming) GetParityBits() int {
	return a.parityBits
}

// CheckBitsAndExtract validates the bit pattern and extracts the data bits
// Returns the data code and whether it's valid
func (a *AsyncFraming) CheckBitsAndExtract(v uint32) (byte, bool) {
	switch a.stopBits {
	case 1.5:
		// N1.5: ttt d4 d3 d2 d1 d0 ss (1.5 stop bits, 15 bits total for 5N1.5)
		// Each bit is represented as 2 physical bits

		// Check start bit = 00 (space)
		if (v & 3) != 0 {
			return 0, false
		}
		v >>= 2

		// Extract data bits - each must be 00 or 11
		a.lastCode = 0
		for i := 0; i < a.dataBits; i++ {
			d := v & 3
			if d != 0 && d != 3 {
				return 0, false // Data half-bits not the same
			}
			if d != 0 {
				a.lastCode = (a.lastCode >> 1) | a.dataMSB
			} else {
				a.lastCode = a.lastCode >> 1
			}
			v >>= 2
		}

		// Check stop bits = 111 (1.5 stop bits as mark)
		if (v & 7) != 7 {
			return 0, false
		}
		v >>= 3

		// Should have consumed all bits
		if v != 0 {
			return 0, false
		}

	default:
		// N0, N1, N2: standard framing

		// Check start bit = 0 (space)
		if (v & 1) != 0 {
			return 0, false
		}
		v >>= 1

		// Extract data bits
		a.lastCode = 0
		for i := 0; i < a.dataBits; i++ {
			if (v & 1) != 0 {
				a.lastCode = (a.lastCode >> 1) | a.dataMSB
			} else {
				a.lastCode = a.lastCode >> 1
			}
			v >>= 1
		}

		// Skip parity bit if present
		if a.parityBits == 1 {
			v >>= 1
		}

		// Check stop bits
		if a.stopBits == 2 {
			if (v & 3) != 3 {
				return 0, false // 2 stop bits = 11
			}
			v >>= 2
		} else if a.stopBits == 1 {
			if (v & 1) != 1 {
				return 0, false // 1 stop bit = 1
			}
			v >>= 1
		}

		// Should have consumed all bits
		if v != 0 {
			return 0, false
		}
	}

	return a.lastCode, true
}

// IsStopVariable returns whether this framing uses variable stop bits
func (a *AsyncFraming) IsStopVariable() bool {
	return a.stopVariable
}
