package fsk

// ITA2 implements the ITA2/Baudot code used by RTTY (Radio Teletype)
// This is a 5-bit character encoding with letters and figures shift states
type ITA2 struct {
	// Character tables
	ltrs     [32]rune
	figs     [32]rune
	codeLtrs map[byte]rune
	codeFigs map[byte]rune
	ltrsCode map[rune]byte
	figsCode map[rune]byte

	// State
	shift    bool // false = letters, true = figures
	lastCode byte // Previous code (ITA2 processes previous character)

	// Special codes
	letters byte
	figures byte
}

// NewITA2 creates a new ITA2 decoder
func NewITA2() *ITA2 {
	i := &ITA2{
		letters:  0x1f,
		figures:  0x1b,
		codeLtrs: make(map[byte]rune),
		codeFigs: make(map[byte]rune),
		ltrsCode: make(map[rune]byte),
		figsCode: make(map[rune]byte),
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
}

// GetNBits returns the number of bits per character (5)
func (i *ITA2) GetNBits() int {
	return 5
}

// GetMSB returns the MSB mask for 5-bit characters
func (i *ITA2) GetMSB() byte {
	return 0x10
}

// CheckBits checks if a code is valid (always true for ITA2 - no error correction)
func (i *ITA2) CheckBits(code byte) bool {
	// ITA2 has no error correction, all 5-bit codes are valid
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
// IMPORTANT: ITA2 processes the PREVIOUS character, because shift codes
// affect the NEXT character, not themselves
func (i *ITA2) ProcessChar(code byte) ITA2CharResult {
	// Mask to 5 bits
	code &= 0x1f

	// Always return success for ITA2 (no error correction)
	result := ITA2CharResult{Char: 0, BitSuccess: true, Tally: 1}

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

	// Store current code for next iteration
	i.lastCode = code

	return result
}
