package navtex

import "fmt"

// CCIR476 implements the CCIR476 error-correcting code used by NAVTEX
// Each character has exactly 4 mark bits (1) and 3 space bits (0) for error detection
type CCIR476 struct {
	// Character tables
	ltrs       [128]rune
	figs       [128]rune
	validCodes [128]bool
	codeLtrs   map[byte]rune
	codeFigs   map[byte]rune
	ltrsCode   map[rune]byte
	figsCode   map[rune]byte

	// State
	shift      bool // false = letters, true = figures
	alphaPhase bool // alternating alpha/rep phases for error correction
	c1, c2, c3 byte // previous characters for error correction

	// Special codes
	codeAlpha  byte
	codeBeta   byte
	codeChar32 byte
	codeRep    byte
	letters    byte
	figures    byte
}

// NewCCIR476 creates a new CCIR476 decoder
func NewCCIR476() *CCIR476 {
	c := &CCIR476{
		codeAlpha:  0x0f,
		codeBeta:   0x33,
		codeChar32: 0x6a,
		codeRep:    0x66,
		letters:    0x5a,
		figures:    0x36,
		codeLtrs:   make(map[byte]rune),
		codeFigs:   make(map[byte]rune),
		ltrsCode:   make(map[rune]byte),
		figsCode:   make(map[rune]byte),
	}

	// Initialise letter table
	// Note: Control codes (ALF, BET, FGS, LTR, REP, C32) are kept as '_' placeholders
	// They are handled specially in ProcessChar and should not be in the lookup maps
	ltrs := []rune{
		//  x0   x1   x2   x3   x4   x5   x6   x7   x8   x9   xa   xb   xc   xd   xe   xf
		'_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', // 0x (0x0f=ALF)
		'_', '_', '_', '_', '_', '_', '_', 'J', '_', '_', '_', 'F', '_', 'C', 'K', '_', // 1x
		'_', '_', '_', '_', '_', '_', '_', 'W', '_', '_', '_', 'Y', '_', 'P', 'Q', '_', // 2x
		'_', '_', '_', '_', '_', 'G', '_', '_', '_', 'M', 'X', '_', 'V', '_', '_', '_', // 3x (0x33=BET, 0x36=FGS)
		'_', '_', '_', '_', '_', '_', '_', 'A', '_', '_', '_', 'S', '_', 'I', 'U', '_', // 4x
		'_', '_', '_', 'D', '_', 'R', 'E', '_', '_', 'N', '_', '_', ' ', '_', '_', '_', // 5x (0x5a=LTR)
		'_', '_', '_', 'Z', '_', 'L', '_', '_', '_', 'H', '_', '_', '\n', '_', '_', '_', // 6x (0x66=REP, 0x6a=C32)
		'_', 'O', 'B', '_', 'T', '_', '_', '_', '\r', '_', '_', '_', '_', '_', '_', '_', // 7x
	}

	// Initialise figures table
	// Note: Control codes are kept as '_' placeholders, same as letters table
	figs := []rune{
		//  x0   x1   x2   x3   x4   x5   x6   x7   x8   x9   xa   xb   xc   xd   xe   xf
		'_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', '_', // 0x (0x0f=ALF)
		'_', '_', '_', '_', '_', '_', '_', '\'', '_', '_', '_', '!', '_', ':', '(', '_', // 1x
		'_', '_', '_', '_', '_', '_', '_', '2', '_', '_', '_', '6', '_', '0', '1', '_', // 2x
		'_', '_', '_', '_', '_', '&', '_', '_', '_', '.', '/', '_', ';', '_', '_', '_', // 3x (0x33=BET, 0x36=FGS)
		'_', '_', '_', '_', '_', '_', '_', '-', '_', '_', '_', '\a', '_', '8', '7', '_', // 4x (BEL = \a)
		'_', '_', '_', '$', '_', '4', '3', '_', '_', ',', '_', '_', ' ', '_', '_', '_', // 5x (0x5a=LTR)
		'_', '_', '_', '"', '_', ')', '_', '_', '_', '#', '_', '_', '\n', '_', '_', '_', // 6x (0x66=REP, 0x6a=C32)
		'_', '9', '?', '_', '5', '_', '_', '_', '\r', '_', '_', '_', '_', '_', '_', '_', // 7x
	}

	copy(c.ltrs[:], ltrs)
	copy(c.figs[:], figs)

	// Build lookup tables
	for code := byte(0); code < 128; code++ {
		if c.checkBits(code) {
			c.validCodes[code] = true

			ltrv := c.ltrs[code]
			if ltrv != '_' {
				c.codeLtrs[code] = ltrv
				c.ltrsCode[ltrv] = code
			}

			figv := c.figs[code]
			if figv != '_' {
				c.codeFigs[code] = figv
				c.figsCode[figv] = code
			}
		}
	}

	return c
}

// checkBits verifies that a code has exactly 4 mark bits (error detection)
func (c *CCIR476) checkBits(v byte) bool {
	bitCount := 0
	for v != 0 {
		bitCount++
		v &= v - 1
	}
	return bitCount == 4
}

// Reset resets the decoder state
func (c *CCIR476) Reset() {
	c.shift = false
	c.alphaPhase = false
	c.c1 = 0
	c.c2 = 0
	c.c3 = 0
}

// GetNBits returns the number of bits per character (7)
func (c *CCIR476) GetNBits() int {
	return 7
}

// GetMSB returns the MSB mask for 7-bit characters
func (c *CCIR476) GetMSB() byte {
	return 0x40
}

// CheckBits checks if a code is valid (has 4 mark bits)
func (c *CCIR476) CheckBits(code byte) bool {
	return c.validCodes[code]
}

// codeToChar converts a code to a character based on shift state
func (c *CCIR476) codeToChar(code byte, shift bool) (rune, error) {
	var ch rune
	if shift {
		ch = c.codeFigs[code]
	} else {
		ch = c.codeLtrs[code]
	}

	if ch == 0 {
		return 0, fmt.Errorf("invalid code: 0x%02x", code)
	}

	return ch, nil
}

// CharResult holds the result of processing a character
type CharResult struct {
	Char       rune // The decoded character (0 if no output)
	BitSuccess bool // Whether the bits were valid (for error counting)
	Tally      int  // Character decode result: 1=success, -1=fail, 0=control/no-output
}

// ProcessChar processes a received character code
// Implements the alpha/rep phase error correction scheme
func (c *CCIR476) ProcessChar(code byte) CharResult {
	// Check bit validity - this NEVER changes throughout the function
	bitSuccess := c.checkBits(code)
	tally := 0
	var chr byte = 0xff

	// Force phasing with the two phasing characters
	if code == c.codeRep {
		c.alphaPhase = false
	} else if code == c.codeAlpha {
		c.alphaPhase = true
	}

	if !c.alphaPhase {
		// Rep phase: store characters for later comparison
		c.c1 = c.c2
		c.c2 = c.c3
		c.c3 = code
	} else {
		// Alpha phase: compare with rep phase character
		// Try to recover the character using forward error correction
		if bitSuccess && c.c1 == code {
			// Both alpha and rep match - perfect
			chr = code
		} else if bitSuccess {
			// Alpha is valid, use it
			chr = code
		} else if c.checkBits(c.c1) {
			// Alpha is invalid, but rep is valid - use rep
			chr = c.c1
		}

		if chr == 0xff {
			// Failed to decode
			tally = -1
		} else {
			// Successfully decoded a character
			tally = 1

			// Process special control codes
			switch chr {
			case c.codeRep, c.codeAlpha, c.codeBeta, c.codeChar32:
				// Control codes - don't output
				c.alphaPhase = !c.alphaPhase
				return CharResult{Char: 0, BitSuccess: bitSuccess, Tally: tally}

			case c.letters:
				c.shift = false
				c.alphaPhase = !c.alphaPhase
				return CharResult{Char: 0, BitSuccess: bitSuccess, Tally: tally}

			case c.figures:
				c.shift = true
				c.alphaPhase = !c.alphaPhase
				return CharResult{Char: 0, BitSuccess: bitSuccess, Tally: tally}

			default:
				// Regular character
				ch, err := c.codeToChar(chr, c.shift)
				if err != nil {
					// Invalid character code - don't output
					c.alphaPhase = !c.alphaPhase
					return CharResult{Char: 0, BitSuccess: bitSuccess, Tally: tally}
				}
				c.alphaPhase = !c.alphaPhase
				return CharResult{Char: ch, BitSuccess: bitSuccess, Tally: tally}
			}
		}
	}

	// Alpha/rep phasing - return bit validity and tally
	c.alphaPhase = !c.alphaPhase
	return CharResult{Char: 0, BitSuccess: bitSuccess, Tally: tally}
}
