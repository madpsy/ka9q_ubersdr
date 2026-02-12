package fsk

// ITA2 implements the ITA2/Baudot code used by RTTY (Radio Teletype)
// This is a 5-bit character encoding with letters and figures shift states
// Also supports ASCII mode for 7/8-bit direct character encoding
type ITA2 struct {
	// Character tables
	ltrs     [32]rune
	figs     [32]rune
	codeLtrs map[byte]rune
	codeFigs map[byte]rune
	ltrsCode map[rune]byte
	figsCode map[rune]byte

	// State
	shift     bool // false = letters, true = figures
	lastCode  byte // Previous code (ITA2 processes previous character)
	firstChar bool // Track if this is the first character

	// Special codes
	letters byte
	figures byte

	// Framing
	framing  string // e.g., "5N1.5", "7N1", "8N1"
	nbits    int    // Total bits including framing
	dataBits int    // Data bits only (5 for ITA2, 7 or 8 for ASCII)

	// Mode
	asciiMode bool // true = ASCII mode (direct byte-to-char), false = ITA2 mode
}

// NewITA2 creates a new ITA2 decoder (also handles ASCII mode)
func NewITA2(framing string) *ITA2 {
	i := &ITA2{
		letters:   0x1f,
		figures:   0x1b,
		firstChar: true, // Start with first character flag
		framing:   framing,
		dataBits:  5, // Default to 5 bits
		codeLtrs:  make(map[byte]rune),
		codeFigs:  make(map[byte]rune),
		ltrsCode:  make(map[rune]byte),
		figsCode:  make(map[rune]byte),
	}

	// Parse framing format: <data>N<stop>
	// Examples: 5N1, 5N1.5, 5N2, 7N1, 8N1
	// Format: <data bits>N<stop bits>
	if len(framing) >= 3 && framing[1] == 'N' {
		// Extract data bits (first character)
		i.dataBits = int(framing[0] - '0')

		// Extract stop bits (after 'N')
		stopBits := 1.0
		stopStr := framing[2:]
		if stopStr == "1.5" {
			stopBits = 1.5
		} else if stopStr == "2" {
			stopBits = 2.0
		} else if stopStr == "1" {
			stopBits = 1.0
		}

		// Calculate total bits: start + data + stop
		startBits := 1
		totalBits := float64(startBits) + float64(i.dataBits) + stopBits

		// doubles bit count for 1.5 stop bits (oversampling)
		if stopBits == 1.5 {
			i.nbits = int(totalBits * 2)
		} else {
			i.nbits = int(totalBits)
		}
	} else {
		// Fallback for unknown framing
		i.nbits = i.dataBits
	}

	var NUL rune = '\x00'
	var QUO rune = '\''
	var LF rune = '\n'
	var CR rune = '\r'
	var BEL rune = '\x07'
	var FGS rune = '_' // Figures shift - documentation only
	var LTR rune = '_' // Letters shift - documentation only

	// ITA2 letter table (US-TTY version)
	// See: https://en.wikipedia.org/wiki/Baudot_code
	// http://www.quadibloc.com/crypto/tele03.htm
	// This is the US-TTY version: BEL $ # ' " and ; differ from standard ITA2
	ltrs := []rune{
		//  x0   x1   x2   x3   x4   x5   x6   x7   x8   x9   xa   xb   xc   xd   xe   xf
		NUL, 'E', LF, 'A', ' ', 'S', 'I', 'U', CR, 'D', 'R', 'J', 'N', 'F', 'C', 'K', // 0x
		'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', FGS, 'M', 'X', 'V', LTR, // 1x
	}

	// ITA2 figures table (US-TTY version)
	figs := []rune{
		//  x0   x1   x2   x3   x4   x5   x6   x7   x8   x9   xa   xb   xc   xd   xe   xf
		NUL, '3', LF, '-', ' ', BEL, '8', '7', CR, '$', '4', QUO, ',', '!', ':', '(', // 0x
		'5', '"', ')', '2', '#', '6', '0', '1', '9', '?', '&', FGS, '.', '/', ';', LTR, // 1x
	}

	copy(i.ltrs[:], ltrs)
	copy(i.figs[:], figs)

	// Build lookup tables
	for code := byte(0); code < 32; code++ {
		ltrv := i.ltrs[code]
		if ltrv != '_' {
			i.codeLtrs[code] = ltrv
			i.ltrsCode[ltrv] = code
		}

		figv := i.figs[code]
		if figv != '_' {
			i.codeFigs[code] = figv
			i.figsCode[figv] = code
		}
	}

	return i
}

// Reset resets the decoder state
func (i *ITA2) Reset() {
	i.shift = false
	i.lastCode = 0
	i.firstChar = true
}

// GetNBits returns the total number of bits including framing
func (i *ITA2) GetNBits() int {
	return i.nbits
}

// GetMSB returns the MSB mask for the total bit count
func (i *ITA2) GetMSB() uint16 {
	return uint16(1 << (i.nbits - 1))
}

// GetDataBits returns the number of data bits (5 for ITA2)
func (i *ITA2) GetDataBits() int {
	return i.dataBits
}

// CheckBits validates the frame structure for async framing
// For doubled framings (5N1.5), validates bit pairs
// For non-doubled framings (5N1, 5N2, 7N1, 8N1), validates start/stop bits
func (i *ITA2) CheckBits(code uint16) bool {
	v := uint16(code)

	// Check if this is a doubled framing (only 5N1.5 uses 15 bits)
	if i.nbits == 15 {
		// For 5N1.5 (15-bit doubled frame), validate structure
		// Frame: [start:2][data0-4:10][stop:3] (LSB to MSB)

		// Check start bits (LSB, should be 00)
		if (v & 3) != 0 {
			return false
		}
		v >>= 2

		// Check data bits (each 2-bit pair should be 00 or 11)
		for bit := 0; bit < i.dataBits; bit++ {
			d := v & 3
			if d != 0 && d != 3 {
				return false
			}
			v >>= 2
		}

		// Check stop bits (MSB, should be 111)
		if (v & 7) != 7 {
			return false
		}
		v >>= 3

		// Should have consumed all bits
		if v != 0 {
			return false
		}

		return true
	}

	// For non-doubled framings (5N1, 5N2, 7N1, 8N1), validate start/stop bits
	// Frame structure: [start:1][data:N][stop:1 or 2]

	// Check start bit (LSB, should be 0)
	if (v & 1) != 0 {
		return false
	}
	v >>= 1

	// Skip data bits (don't validate content)
	v >>= uint(i.dataBits)

	// Check stop bits (should be all 1s)
	stopBits := i.nbits - 1 - i.dataBits // Total - start - data = stop bits
	stopMask := uint16((1 << uint(stopBits)) - 1)
	if (v & stopMask) != stopMask {
		return false
	}

	return true
}

// codeToChar converts a code to a character based on shift state
func (i *ITA2) codeToChar(code byte, shift bool) rune {
	var ch rune
	if shift {
		ch = i.codeFigs[code]
	} else {
		ch = i.codeLtrs[code]
	}

	if ch == 0 {
		return 0 // Invalid code
	}

	return ch
}

// CharResult holds the result of processing a character
type ITA2CharResult struct {
	Char       rune // The decoded character (0 if no output)
	BitSuccess bool // Whether the bits were valid (always true for ITA2)
	Tally      int  // Character decode result: 1=success, 0=control/no-output
}

// ProcessChar processes a received character code
// ITA2 uses a simple shift mechanism (no error correction like CCIR476)
// ASCII mode does direct byte-to-character conversion
// IMPORTANT: ITA2 processes the PREVIOUS character, because shift codes
// affect the NEXT character, not themselves
func (i *ITA2) ProcessChar(code uint16) ITA2CharResult {
	// ASCII mode: direct conversion, no shift states
	if i.asciiMode {
		// Extract data bits (skip start bit, mask to data bits)
		dataByte := byte((code >> 1) & uint16((1<<i.dataBits)-1))

		// Skip: 0x00-0x09, 0x0B-0x0C, 0x0E-0x1F, 0x7F+
		if (dataByte >= 0x00 && dataByte <= 0x09) ||
			(dataByte >= 0x0B && dataByte <= 0x0C) ||
			(dataByte >= 0x0E && dataByte <= 0x1F) ||
			(dataByte >= 0x7F) {
			return ITA2CharResult{BitSuccess: true, Tally: 0} // Skip non-printable
		}

		// Convert byte directly to character
		return ITA2CharResult{
			Char:       rune(dataByte),
			BitSuccess: true,
			Tally:      1,
		}
	}

	// ITA2 mode: extract data bits from the frame
	// For 5N1.5 with 15 total bits, each bit is doubled
	// Frame: [start:2][data0-4:10][stop:3] (LSB to MSB)

	var dataBits byte
	if i.nbits == 15 {
		// For 15-bit frame (5N1.5 doubled):

		v := uint16(code)

		// Skip start bits (2 bits, LSB)
		v >>= 2

		// Extract 5 data bits (each doubled), from data0 to data4
		dataBits = 0
		dataMSB := byte(1 << (i.dataBits - 1))
		for bit := 0; bit < i.dataBits; bit++ {
			d := v & 3 // Get 2-bit pair
			// If d is non-zero (11 = 3), set the bit
			dataBits = (dataBits >> 1) | (func() byte {
				if d != 0 {
					return dataMSB
				}
				return 0
			}())
			v >>= 2 // Move to next 2-bit pair
		}
	} else {
		// For other framings, just mask to data bits
		dataBits = byte(code & uint16((1<<i.dataBits)-1))
	}

	// Always return success for ITA2 (no error correction)
	result := ITA2CharResult{Char: 0, BitSuccess: true, Tally: 0}

	// Skip the first character - just store it
	if i.firstChar {
		i.lastCode = dataBits
		i.firstChar = false
		return result
	}

	// Process the PREVIOUS character based on current shift state
	switch i.lastCode {
	case i.letters:
		// Previous character was LETTERS shift - switch to letters mode
		i.shift = false
		result.Tally = 0 // Control code, no output

	case i.figures:
		// Previous character was FIGURES shift - switch to figures mode
		i.shift = true
		result.Tally = 0 // Control code, no output

	default:
		// Regular character - decode using current shift state
		ch := i.codeToChar(i.lastCode, i.shift)
		if ch == 0 {
			// Invalid character code - don't output
			result.Tally = 0
		} else {
			result.Char = ch
			result.Tally = 1
		}
	}

	// Store current data bits for next iteration
	i.lastCode = dataBits

	return result
}
