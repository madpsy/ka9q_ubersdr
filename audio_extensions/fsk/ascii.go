package fsk

// ASCII implements 7-bit and 8-bit ASCII character encoding
// Used for modes like 7N1, 8N1, etc.
// This handles the character encoding only - framing is handled by AsyncFraming
type ASCII struct {
	// Configuration
	bits int // 7 or 8 bits per character

	// Async framing handler
	framing *AsyncFraming
}

// NewASCII creates a new ASCII decoder with async framing
func NewASCII(framingStr string) (*ASCII, error) {
	framing, err := NewAsyncFraming(framingStr)
	if err != nil {
		return nil, err
	}

	// Determine bit count from framing
	bits := 7 // Default to 7-bit
	if len(framingStr) > 0 {
		switch framingStr[0] {
		case '7':
			bits = 7
		case '8':
			bits = 8
		}
	}

	return &ASCII{
		bits:    bits,
		framing: framing,
	}, nil
}

// Reset resets the decoder state (no state for ASCII)
func (a *ASCII) Reset() {
	// No state to reset for ASCII
}

// GetNBits returns the total number of bits per character (including framing)
func (a *ASCII) GetNBits() int {
	return a.framing.GetNBits()
}

// GetMSB returns the MSB mask for the total bit count
func (a *ASCII) GetMSB() byte {
	return a.framing.GetMSB()
}

// GetMSB32 returns the full 32-bit MSB mask
func (a *ASCII) GetMSB32() uint32 {
	return a.framing.GetMSB32()
}

// CheckBits checks if a code is valid and extracts data bits
func (a *ASCII) CheckBits(code uint32) bool {
	_, valid := a.framing.CheckBitsAndExtract(code)
	return valid
}

// ProcessChar processes a received character code with framing
// Returns the decoded character (if any) and whether it was successful
func (a *ASCII) ProcessChar(code uint32) (rune, bool) {
	// Extract data bits from framed code
	dataCode, valid := a.framing.CheckBitsAndExtract(code)
	if !valid {
		return 0, false
	}

	// Mask to appropriate bit count
	if a.bits == 7 {
		dataCode &= 0x7F
	}
	// 8-bit uses full byte

	// Convert to rune
	// ASCII printable range is 0x20-0x7E
	// Control characters 0x00-0x1F and 0x7F are also valid
	ch := rune(dataCode)

	// Return all characters including control codes
	// The application can decide how to handle them
	return ch, true
}
