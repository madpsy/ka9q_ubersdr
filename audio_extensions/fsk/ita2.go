package fsk

// ITA2 implements the ITA2 (Baudot) character encoding used by RTTY
// Also known as CCITT-2 or Baudot code
// This handles the character encoding only - framing is handled by AsyncFraming
type ITA2 struct {
	// Character tables
	ltrs [32]rune
	figs [32]rune

	// State
	shift bool // false = letters, true = figures

	// Special codes
	letters byte
	figures byte

	// Async framing handler
	framing *AsyncFraming
}

// NewITA2 creates a new ITA2 decoder with async framing
func NewITA2(framingStr string) (*ITA2, error) {
	framing, err := NewAsyncFraming(framingStr)
	if err != nil {
		return nil, err
	}

	i := &ITA2{
		letters: 0x1F,
		figures: 0x1B,
		framing: framing,
	}

	// Initialize letter table (5-bit codes)
	i.ltrs = [32]rune{
		0x00: 0, // NULL
		0x01: 'E',
		0x02: '\n', // Line Feed
		0x03: 'A',
		0x04: ' ', // Space
		0x05: 'S',
		0x06: 'I',
		0x07: 'U',
		0x08: '\r', // Carriage Return
		0x09: 'D',
		0x0A: 'R',
		0x0B: 'J',
		0x0C: 'N',
		0x0D: 'F',
		0x0E: 'C',
		0x0F: 'K',
		0x10: 'T',
		0x11: 'Z',
		0x12: 'L',
		0x13: 'W',
		0x14: 'H',
		0x15: 'Y',
		0x16: 'P',
		0x17: 'Q',
		0x18: 'O',
		0x19: 'B',
		0x1A: 'G',
		0x1B: 0, // FIGS
		0x1C: 'M',
		0x1D: 'X',
		0x1E: 'V',
		0x1F: 0, // LTRS
	}

	// Initialize figures table (5-bit codes)
	i.figs = [32]rune{
		0x00: 0, // NULL
		0x01: '3',
		0x02: '\n', // Line Feed
		0x03: '-',
		0x04: ' ',  // Space
		0x05: '\a', // BEL
		0x06: '8',
		0x07: '7',
		0x08: '\r', // Carriage Return
		0x09: '$',
		0x0A: '4',
		0x0B: '\'',
		0x0C: ',',
		0x0D: '!',
		0x0E: ':',
		0x0F: '(',
		0x10: '5',
		0x11: '"',
		0x12: ')',
		0x13: '2',
		0x14: '#',
		0x15: '6',
		0x16: '0',
		0x17: '1',
		0x18: '9',
		0x19: '?',
		0x1A: '&',
		0x1B: 0, // FIGS
		0x1C: '.',
		0x1D: '/',
		0x1E: ';',
		0x1F: 0, // LTRS
	}

	return i, nil
}

// Reset resets the decoder state
func (i *ITA2) Reset() {
	i.shift = false
}

// GetNBits returns the total number of bits per character (including framing)
func (i *ITA2) GetNBits() int {
	return i.framing.GetNBits()
}

// GetMSB returns the MSB mask for the total bit count
func (i *ITA2) GetMSB() byte {
	return i.framing.GetMSB()
}

// CheckBits checks if a code is valid and extracts data bits
func (i *ITA2) CheckBits(code byte) bool {
	_, valid := i.framing.CheckBitsAndExtract(uint32(code))
	return valid
}

// ProcessChar processes a received character code with framing
// Returns the decoded character (if any) and whether it was successful
func (i *ITA2) ProcessChar(code byte) (rune, bool) {
	// Extract data bits from framed code
	dataCode, valid := i.framing.CheckBitsAndExtract(uint32(code))
	if !valid {
		return 0, false
	}

	// Mask to 5 bits (data bits)
	code = dataCode & 0x1F

	// Check for shift codes
	if code == i.letters {
		i.shift = false
		return 0, true
	}
	if code == i.figures {
		i.shift = true
		return 0, true
	}

	// Get character from appropriate table
	var ch rune
	if i.shift {
		ch = i.figs[code]
	} else {
		ch = i.ltrs[code]
	}

	// Return character if valid
	if ch != 0 {
		return ch, true
	}

	return 0, true
}
