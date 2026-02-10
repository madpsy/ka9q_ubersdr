package fsk

import (
	"log"
	"math"
)

// RTTYRxState represents the RTTY decoder state machine
// Based on fldigi's edge-detection approach
type RTTYRxState int

const (
	StateIdle RTTYRxState = iota
	StateStart
	StateData
	StateStop
)

// CharacterEncoding interface for different character encodings
type CharacterEncoding interface {
	ProcessChar(code uint32) (rune, bool) // Changed to uint32 to support >8 bit codes
	CheckBits(code uint32) bool           // Changed to uint32 to support >8 bit codes
	GetNBits() int
	GetMSB() byte
	GetMSB32() uint32 // Full 32-bit MSB for modes with >8 bits
	Reset()
}

// FSKDemodulator implements an FSK (Frequency Shift Keying) demodulator
// Using fldigi's edge-detection based state machine approach
type FSKDemodulator struct {
	// Configuration
	sampleRate      float64
	centerFrequency float64
	shiftHz         float64
	deviationF      float64
	baudRate        float64
	inverted        bool
	framing         string
	encoding        string

	// Filter parameters
	lowpassFilterF   float64
	markSpaceFilterQ float64
	markF            float64
	spaceF           float64
	audioAverageTC   float64
	audioMinimum     float64

	// Bit timing
	bitDurationSeconds float64
	symbollen          int // samples per symbol (bit)
	halfSymbollen      int // half symbol length for sampling

	// Filters
	biquadMark    *BiQuadFilter
	biquadSpace   *BiQuadFilter
	biquadLowpass *BiQuadFilter

	// Bit buffer for edge detection (fldigi approach)
	bitBuf []bool

	// State machine (fldigi approach)
	rxstate RTTYRxState
	counter int    // countdown timer for state machine
	bitcntr int    // bit counter for data collection
	rxdata  uint32 // received data bits

	// Audio level tracking
	audioAverage float64

	// Character encoding parameters
	nbits        int    // number of data bits
	msb          uint32 // MSB mask for bit shifting
	charEncoding CharacterEncoding

	// Callbacks
	baudErrorCB func(float64)
	outputCB    func(rune)
	stateCB     func(RTTYRxState)

	// Statistics
	succeedTally int
	failTally    int
}

// NewFSKDemodulator creates a new FSK demodulator
func NewFSKDemodulator(sampleRate int, centerFreq, shiftHz, baudRate float64, framing, encoding string, inverted bool) *FSKDemodulator {
	d := &FSKDemodulator{
		sampleRate:      float64(sampleRate),
		centerFrequency: centerFreq,
		shiftHz:         shiftHz,
		baudRate:        baudRate,
		framing:         framing,
		encoding:        encoding,
		inverted:        inverted,
		lowpassFilterF:  140.0,
		audioMinimum:    256.0,
		biquadMark:      NewBiQuadFilter(),
		biquadSpace:     NewBiQuadFilter(),
		biquadLowpass:   NewBiQuadFilter(),
	}

	d.deviationF = d.shiftHz / 2.0
	d.audioAverageTC = 1000.0 / d.sampleRate

	// Ensure baud rate is never zero
	if d.baudRate < 10 {
		d.baudRate = 10
	}

	d.bitDurationSeconds = 1.0 / d.baudRate
	d.symbollen = int(d.sampleRate*d.bitDurationSeconds + 0.5)
	d.halfSymbollen = d.symbollen / 2

	// Initialize bit buffer for edge detection (fldigi approach)
	d.bitBuf = make([]bool, d.symbollen)

	// Initialize encoding
	switch encoding {
	case "CCIR476":
		ccir := NewCCIR476()
		d.charEncoding = ccir
		d.nbits = ccir.GetNBits()
		d.msb = ccir.GetMSB32()
	case "ITA2":
		ita2, err := NewITA2(framing)
		if err != nil {
			log.Printf("[FSK] Failed to create ITA2 decoder: %v, using default", err)
			ita2, _ = NewITA2("5N1.5")
		}
		d.charEncoding = ita2
		d.nbits = ita2.GetNBits()
		d.msb = ita2.GetMSB32()
	case "ASCII":
		// ASCII uses 7 or 8 bits based on framing
		ascii, err := NewASCII(framing)
		if err != nil {
			log.Printf("[FSK] Failed to create ASCII decoder: %v, using default", err)
			ascii, _ = NewASCII("7N1")
		}
		d.charEncoding = ascii
		d.nbits = ascii.GetNBits()
		d.msb = ascii.GetMSB32()
	default:
		log.Printf("[FSK] Unsupported encoding: %s, using ITA2", encoding)
		ita2, err := NewITA2(framing)
		if err != nil {
			log.Printf("[FSK] Failed to create ITA2 decoder: %v, using default", err)
			ita2, _ = NewITA2("5N1.5")
		}
		d.charEncoding = ita2
		d.nbits = ita2.GetNBits()
		d.msb = ita2.GetMSB32()
	}

	d.updateFilters()
	d.rxstate = StateIdle
	d.audioAverage = 0.1

	log.Printf("[FSK] Initialized: SR=%d, CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Framing=%s, Encoding=%s, SymbolLen=%d",
		sampleRate, centerFreq, shiftHz, baudRate, framing, encoding, d.symbollen)

	return d
}

// SetBaudErrorCallback sets the callback for baud error reporting
func (d *FSKDemodulator) SetBaudErrorCallback(cb func(float64)) {
	d.baudErrorCB = cb
}

// SetOutputCallback sets the callback for decoded characters
func (d *FSKDemodulator) SetOutputCallback(cb func(rune)) {
	d.outputCB = cb
}

// SetStateCallback sets the callback for state changes
func (d *FSKDemodulator) SetStateCallback(cb func(RTTYRxState)) {
	d.stateCB = cb
}

// updateFilters configures the biquad filters
func (d *FSKDemodulator) updateFilters() {
	// Q must change with frequency
	d.markSpaceFilterQ = 6.0 * d.centerFrequency / 1000.0

	// Try to maintain a zero mixer output at the carrier frequency
	qv := d.centerFrequency + (4.0 * 1000.0 / d.centerFrequency)
	d.markF = qv + d.deviationF
	d.spaceF = qv - d.deviationF

	invSqrt2 := 1.0 / math.Sqrt(2.0)

	d.biquadMark.Configure(BiQuadBandpass, d.markF, d.sampleRate, d.markSpaceFilterQ)
	d.biquadSpace.Configure(BiQuadBandpass, d.spaceF, d.sampleRate, d.markSpaceFilterQ)
	d.biquadLowpass.Configure(BiQuadLowpass, d.lowpassFilterF, d.sampleRate, invSqrt2)
}

// setState changes the decoder state
func (d *FSKDemodulator) setState(s RTTYRxState) {
	if s != d.rxstate {
		d.rxstate = s
		if d.stateCB != nil {
			d.stateCB(s)
		}
	}
}

// isMarkSpace detects mark-to-space transition (start bit edge)
// Returns true if edge detected, and correction value for timing adjustment
// Based on fldigi's is_mark_space() function
func (d *FSKDemodulator) isMarkSpace() (bool, int) {
	correction := 0

	// Test for rough bit position: mark at start, space at end
	if d.bitBuf[0] && !d.bitBuf[d.symbollen-1] {
		// Test for mark/space straddle point
		// Count how many marks in the buffer
		for i := 0; i < d.symbollen; i++ {
			if d.bitBuf[i] {
				correction++
			}
		}
		// If transition is near middle of buffer (within 6 samples), it's valid
		if absInt(d.symbollen/2-correction) < 6 {
			return true, correction
		}
	}
	return false, 0
}

// isMark samples the bit value at the middle of the symbol period
// Based on fldigi's is_mark() function
func (d *FSKDemodulator) isMark() bool {
	return d.bitBuf[d.symbollen/2]
}

// absInt returns absolute value of an integer
func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// ProcessSamples processes incoming audio samples
func (d *FSKDemodulator) ProcessSamples(samples []int16) {
	for _, sample := range samples {
		dv := float64(sample)

		// Separate mark and space by narrow filtering
		markLevel := d.biquadMark.Filter(dv)
		spaceLevel := d.biquadSpace.Filter(dv)

		markAbs := math.Abs(markLevel)
		spaceAbs := math.Abs(spaceLevel)

		// Update audio average
		maxAbs := math.Max(markAbs, spaceAbs)
		d.audioAverage += (maxAbs - d.audioAverage) * d.audioAverageTC
		d.audioAverage = math.Max(0.1, d.audioAverage)

		// Produce difference of absolutes of mark and space
		diffAbs := (markAbs - spaceAbs) / d.audioAverage

		// Low-pass filter the difference
		logicLevel := d.biquadLowpass.Filter(diffAbs)

		// Determine mark state (apply inversion here)
		bit := (logicLevel > 0) != d.inverted

		// Shift bit buffer and add new bit (fldigi approach)
		for i := 1; i < d.symbollen; i++ {
			d.bitBuf[i-1] = d.bitBuf[i]
		}
		d.bitBuf[d.symbollen-1] = bit

		// Process state machine
		d.rx(bit)
	}
}

// rx processes a single bit through the state machine
// Based on fldigi's rx() function with edge detection
func (d *FSKDemodulator) rx(bit bool) bool {
	flag := false
	var c rune
	var correction int

	switch d.rxstate {
	case StateIdle:
		// Wait for mark-to-space transition (start bit edge)
		if isEdge, corr := d.isMarkSpace(); isEdge {
			d.setState(StateStart)
			d.counter = corr
		}

	case StateStart:
		// Validate start bit at middle of symbol period
		if d.counter--; d.counter == 0 {
			if !d.isMark() {
				// Valid start bit (space), move to data state
				d.setState(StateData)
				d.counter = d.symbollen
				d.bitcntr = 0
				d.rxdata = 0
			} else {
				// False start, back to idle
				d.setState(StateIdle)
			}
		}

	case StateData:
		// Sample data bits at middle of each symbol period
		if d.counter--; d.counter == 0 {
			// Sample bit and shift into rxdata
			if d.isMark() {
				d.rxdata |= (1 << uint(d.bitcntr))
			}
			d.bitcntr++
			d.counter = d.symbollen
		}
		// Check if we've collected all data bits
		if d.bitcntr == d.nbits {
			d.setState(StateStop)
		}

	case StateStop:
		// Validate stop bit at middle of symbol period
		if d.counter--; d.counter == 0 {
			if d.isMark() {
				// Valid stop bit (mark), decode character
				c = d.decodeChar(d.rxdata)
				if c != 0 && d.outputCB != nil {
					d.outputCB(c)
				}
				flag = true
			}
			// Return to idle regardless of stop bit validity
			d.setState(StateIdle)
		}
	}

	// Suppress unused variable warning
	_ = correction

	return flag
}

// decodeChar decodes a character using the configured encoding
func (d *FSKDemodulator) decodeChar(code uint32) rune {
	if d.charEncoding == nil {
		return 0
	}

	ch, success := d.charEncoding.ProcessChar(code)
	if success {
		d.succeedTally++
		return ch
	}
	d.failTally++
	return 0
}

// Reset resets the decoder state
func (d *FSKDemodulator) Reset() {
	d.rxstate = StateIdle
	d.counter = 0
	d.bitcntr = 0
	d.rxdata = 0
	d.audioAverage = 0.1

	// Clear bit buffer
	for i := range d.bitBuf {
		d.bitBuf[i] = false
	}

	if d.charEncoding != nil {
		d.charEncoding.Reset()
	}

	d.biquadMark.Reset()
	d.biquadSpace.Reset()
	d.biquadLowpass.Reset()
}
