package fsk

// ASCII implements 7-bit and 8-bit ASCII character encoding
// Used for modes like 7N1, 8N1, etc.
type ASCII struct {
	// Configuration
	bits int // 7 or 8 bits per character

	// No shift state needed for ASCII
}

// NewASCII creates a new ASCII decoder
func NewASCII(bits int) *ASCII {
	if bits != 7 && bits != 8 {
		bits = 7 // Default to 7-bit ASCII
	}

	return &ASCII{
		bits: bits,
	}
}

// Reset resets the decoder state (no state for ASCII)
func (a *ASCII) Reset() {
	// No state to reset for ASCII
}

// GetNBits returns the number of bits per character (7 or 8)
func (a *ASCII) GetNBits() int {
	return a.bits
}

// GetMSB returns the MSB mask for the character size
func (a *ASCII) GetMSB() byte {
	if a.bits == 8 {
		return 0x80
	}
	return 0x40 // 7-bit
}

// CheckBits checks if a code is valid (always true for ASCII - no error detection)
func (a *ASCII) CheckBits(code byte) bool {
	return true // ASCII has no built-in error detection
}

// ProcessChar processes a received character code
// Returns the decoded character (if any) and whether it was successful
func (a *ASCII) ProcessChar(code byte) (rune, bool) {
	// Mask to appropriate bit count
	if a.bits == 7 {
		code &= 0x7F
	}
	// 8-bit uses full byte

	// Convert to rune
	// ASCII printable range is 0x20-0x7E
	// Control characters 0x00-0x1F and 0x7F are also valid
	ch := rune(code)

	// Return all characters including control codes
	// The application can decide how to handle them
	return ch, true
}
