package fsk

import (
	"log"
	"sync"
	"time"
)

var (
	lastCheckBitsLog time.Time
	checkBitsLogMu   sync.Mutex
)

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
	shift     bool // false = letters, true = figures
	lastCode  byte // Previous code (ITA2 processes previous character)
	firstChar bool // Track if this is the first character

	// Special codes
	letters byte
	figures byte

	// Framing
	framing  string // e.g., "5N1.5"
	nbits    int    // Total bits including framing
	dataBits int    // Data bits only (5 for ITA2)
}

// NewITA2 creates a new ITA2 decoder
func NewITA2(framing string) *ITA2 {
	i := &ITA2{
		letters:   0x1f,
		figures:   0x1b,
		firstChar: true, // Start with first character flag
		framing:   framing,
		dataBits:  5,
		codeLtrs:  make(map[byte]rune),
		codeFigs:  make(map[byte]rune),
		ltrsCode:  make(map[rune]byte),
		figsCode:  make(map[rune]byte),
	}

	// Calculate total bits based on framing
	// Format: <data>N<stop> where N means no parity
	// For 5N1.5: 1 start + 5 data + 0 parity + 1.5 stop = 7.5 bits
	// KiwiSDR doubles this for 1.5 stop bits: 15 bits total
	startBits := 1
	stopBits := 1.5 // For 5N1.5

	if framing == "5N1.5" {
		// Total: 1 + 5 + 1.5 = 7.5, doubled = 15
		i.nbits = int((float64(startBits) + float64(i.dataBits) + stopBits) * 2)
	} else {
		// Default to just data bits for other framings
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
// For 5N1.5 framing, this validates that:
// - Start bits are 00 (2 bits)
// - Each data bit pair is either 00 or 11 (10 bits total for 5 data bits)
// - Stop bits are 111 (3 bits)
func (i *ITA2) CheckBits(code uint16) bool {
	if i.nbits != 15 {
		// For non-doubled framings, accept all codes
		return true
	}

	// For 5N1.5 (15-bit doubled frame), validate structure
	// Bits come in LSB-first from the demodulator, so frame is:
	// [stop:3][data4:2][data3:2][data2:2][data1:2][data0:2][start:2]
	v := uint16(code)

	// Rate-limited debug logging (max once per second)
	shouldLog := false
	checkBitsLogMu.Lock()
	if time.Since(lastCheckBitsLog) > time.Second {
		shouldLog = true
		lastCheckBitsLog = time.Now()
	}
	checkBitsLogMu.Unlock()

	if shouldLog {
		log.Printf("[ITA2] CheckBits sample: code=0x%04x (%015b)", code, code)
	}

	// Check stop bits first (LSB, should be 111)
	stopBits := v & 7
	if stopBits != 7 {
		if shouldLog {
			log.Printf("[ITA2] CheckBits FAIL: stop bits = %03b (expected 111)", stopBits)
		}
		return false
	}
	v >>= 3

	// Check data bits (each 2-bit pair should be 00 or 11)
	// Process from data4 down to data0 (LSB order)
	for bit := i.dataBits - 1; bit >= 0; bit-- {
		d := v & 3
		if d != 0 && d != 3 {
			if shouldLog {
				log.Printf("[ITA2] CheckBits FAIL: data bit %d = %02b (expected 00 or 11)", bit, d)
			}
			return false
		}
		v >>= 2
	}

	// Check start bits last (MSB, should be 00)
	startBits := v & 3
	if startBits != 0 {
		if shouldLog {
			log.Printf("[ITA2] CheckBits FAIL: start bits = %02b (expected 00)", startBits)
		}
		return false
	}
	v >>= 2

	// Should have consumed all bits
	if v != 0 {
		if shouldLog {
			log.Printf("[ITA2] CheckBits FAIL: remaining bits = 0x%x (expected 0)", v)
		}
		return false
	}

	if shouldLog {
		log.Printf("[ITA2] CheckBits SUCCESS")
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
// IMPORTANT: ITA2 processes the PREVIOUS character, because shift codes
// affect the NEXT character, not themselves
func (i *ITA2) ProcessChar(code uint16) ITA2CharResult {
	// Extract data bits from the frame
	// For 5N1.5 with 15 total bits, each bit is doubled
	// Bits come in LSB-first: [stop:3][data4:2][data3:2][data2:2][data1:2][data0:2][start:2]

	var dataBits byte
	if i.nbits == 15 {
		// For 15-bit frame (5N1.5 doubled):
		// Following KiwiSDR's check_bits logic but accounting for LSB-first order

		v := uint16(code)

		// Skip stop bits (3 bits, LSB)
		v >>= 3

		// Extract 5 data bits (each doubled), from data4 down to data0
		dataBits = 0
		dataMSB := byte(1 << (i.dataBits - 1))
		for bit := i.dataBits - 1; bit >= 0; bit-- {
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
