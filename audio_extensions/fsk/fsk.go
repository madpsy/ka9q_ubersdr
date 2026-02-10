package fsk

import (
	"log"
	"math"
)

// FSKState represents the decoder state machine
type FSKState int

const (
	StateNoSignal FSKState = iota
	StateSync1
	StateSync2
	StateReadData
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
// Ported from KiwiSDR JNX.js and navtex FSK decoder
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
	bitSampleCount     int
	halfBitSampleCount int

	// Filters
	biquadMark    *BiQuadFilter
	biquadSpace   *BiQuadFilter
	biquadLowpass *BiQuadFilter

	// State
	state             FSKState
	audioAverage      float64
	signalAccumulator int
	bitDuration       int
	sampleCount       int
	nextEventCount    int
	averagedMarkState bool
	oldMarkState      bool
	pulseEdgeEvent    bool

	// Zero crossing detection for baud rate tracking
	zeroCrossingSamples  int
	zeroCrossingsDivisor int
	zeroCrossingCount    int
	zeroCrossings        []int
	syncDelta            float64
	baudError            float64

	// Bit synchronization
	bitCount     int
	codeBits     uint32 // Changed from byte to uint32 to handle up to 15 bits for 5N1.5
	nbits        int
	msb          uint32 // Changed from byte to uint32 to handle modes with >8 bits
	syncSetup    bool
	syncChars    []uint32 // Changed from []byte to []uint32
	validCount   int
	errorCount   int
	waiting      bool
	stopVariable bool // true for modes with variable stop bits (EFR modes only)

	// Encoding
	charEncoding CharacterEncoding

	// Callbacks
	baudErrorCB func(float64)
	outputCB    func(rune)
	stateCB     func(FSKState)

	// Statistics
	succeedTally int
	failTally    int
}

// NewFSKDemodulator creates a new FSK demodulator
func NewFSKDemodulator(sampleRate int, centerFreq, shiftHz, baudRate float64, framing, encoding string, inverted bool) *FSKDemodulator {
	d := &FSKDemodulator{
		sampleRate:           float64(sampleRate),
		centerFrequency:      centerFreq,
		shiftHz:              shiftHz,
		baudRate:             baudRate,
		framing:              framing,
		encoding:             encoding,
		inverted:             inverted,
		lowpassFilterF:       140.0,
		audioMinimum:         256.0,
		zeroCrossingSamples:  16,
		zeroCrossingsDivisor: 4,
		biquadMark:           NewBiQuadFilter(),
		biquadSpace:          NewBiQuadFilter(),
		biquadLowpass:        NewBiQuadFilter(),
	}

	d.deviationF = d.shiftHz / 2.0
	d.audioAverageTC = 1000.0 / d.sampleRate

	// Ensure baud rate is never zero
	if d.baudRate < 10 {
		d.baudRate = 10
	}

	d.bitDurationSeconds = 1.0 / d.baudRate
	d.bitSampleCount = int(d.sampleRate*d.bitDurationSeconds + 0.5)
	d.halfBitSampleCount = d.bitSampleCount / 2

	// Determine if framing has variable stop bits (needs start bit detection)
	// Only enable for special EFR modes, NOT for standard async serial framings
	// Standard framings like 5N1.5, 5N2, 7N1, 8N1, 4/7 do NOT need this
	d.stopVariable = false
	if len(framing) > 0 {
		// Only enable for framings that explicitly contain 'EFR' or end with 'V'
		// This is very restrictive to avoid breaking normal modes
		if len(framing) >= 3 && (framing[:3] == "EFR" || framing[len(framing)-1] == 'V') {
			d.stopVariable = true
			log.Printf("[FSK] Variable stop bit mode enabled for framing: %s", framing)
		}
	}

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

	// Initialize zero crossing array
	d.zeroCrossings = make([]int, d.bitSampleCount/d.zeroCrossingsDivisor)

	d.updateFilters()
	d.state = StateNoSignal
	d.audioAverage = 0.1

	log.Printf("[FSK] Initialized: SR=%d, CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Framing=%s, Encoding=%s",
		sampleRate, centerFreq, shiftHz, baudRate, framing, encoding)

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
func (d *FSKDemodulator) SetStateCallback(cb func(FSKState)) {
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
func (d *FSKDemodulator) setState(s FSKState) {
	if s != d.state {
		d.state = s
		if d.stateCB != nil {
			d.stateCB(s)
		}
	}
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

		// Determine mark state
		markState := logicLevel > 0
		if markState {
			d.signalAccumulator++
		} else {
			d.signalAccumulator--
		}
		d.bitDuration++

		// Zero crossing detection for baud rate tracking
		if markState != d.oldMarkState {
			// Valid bit duration must be longer than half bit duration
			if (d.bitDuration % d.bitSampleCount) > d.halfBitSampleCount {
				// Create a relative index for this zero crossing
				index := (d.sampleCount - d.nextEventCount + d.bitSampleCount*8) % d.bitSampleCount
				d.zeroCrossings[index/d.zeroCrossingsDivisor]++
			}
			d.bitDuration = 0
		}
		d.oldMarkState = markState

		// Periodic zero crossing analysis
		if d.sampleCount%d.bitSampleCount == 0 {
			d.zeroCrossingCount++
			if d.zeroCrossingCount >= d.zeroCrossingSamples {
				// Find max zero crossing
				best := 0
				bestIndex := 0
				for j := 0; j < len(d.zeroCrossings); j++ {
					if d.zeroCrossings[j] > best {
						best = d.zeroCrossings[j]
						bestIndex = j
					}
					d.zeroCrossings[j] = 0
				}

				if best > 0 {
					// Create a signed correction value
					bestIndex *= d.zeroCrossingsDivisor
					bestIndex = ((bestIndex + d.halfBitSampleCount) % d.bitSampleCount) - d.halfBitSampleCount
					// Limit loop gain
					bestIndex /= 8
					d.syncDelta = float64(bestIndex)
					d.baudError = float64(bestIndex)

					if d.baudErrorCB != nil {
						d.baudErrorCB(d.baudError)
					}
				}
				d.zeroCrossingCount = 0
			}
		}

		// Flag the center of signal pulses
		d.pulseEdgeEvent = (d.sampleCount >= d.nextEventCount)
		if d.pulseEdgeEvent {
			d.averagedMarkState = (d.signalAccumulator > 0) != d.inverted
			d.signalAccumulator = 0
			// Set new timeout value, include zero crossing correction
			d.nextEventCount = d.sampleCount + d.bitSampleCount + int(d.syncDelta+0.5)
			d.syncDelta = 0
		}

		// Check for signal loss
		if d.audioAverage < d.audioMinimum && d.state != StateNoSignal {
			d.setState(StateNoSignal)
		} else if d.state == StateNoSignal {
			d.syncSetup = true
		}

		if !d.pulseEdgeEvent {
			d.sampleCount++
			continue
		}

		// Process bit at pulse edge
		d.processBit(d.averagedMarkState)
		d.sampleCount++
	}
}

// processBit processes a single decoded bit
func (d *FSKDemodulator) processBit(bit bool) {
	bitVal := uint32(0)
	if bit {
		bitVal = 1
	}
	msbVal := uint32(d.msb)

	if d.syncSetup {
		d.bitCount = 0
		d.codeBits = 0
		d.errorCount = 0
		d.validCount = 0
		if d.charEncoding != nil {
			d.charEncoding.Reset()
		}
		d.syncChars = nil
		d.setState(StateSync1)
		d.syncSetup = false
	}

	switch d.state {
	case StateNoSignal:
		// Do nothing

	case StateSync1:
		// Scan indefinitely for valid bit pattern
		d.codeBits = (d.codeBits >> 1) | (bitVal * msbVal)
		if d.charEncoding != nil && d.charEncoding.CheckBits(d.codeBits) {
			d.syncChars = append(d.syncChars, d.codeBits)
			d.validCount++
			d.bitCount = 0
			d.codeBits = 0
			d.setState(StateSync2)
			d.waiting = true
		}

	case StateSync2:
		// Wait for start bit if there are variable stop bits (EFR modes only)
		if d.stopVariable && d.waiting && bit {
			// Still in stop bit (mark), wait for start bit (space)
			break
		}
		d.waiting = false

		// Sample and validate bits in groups of nbits
		d.codeBits = (d.codeBits >> 1) | (bitVal * msbVal)
		d.bitCount++

		if d.bitCount == d.nbits {
			if d.charEncoding != nil && d.charEncoding.CheckBits(d.codeBits) {
				d.syncChars = append(d.syncChars, d.codeBits)
				d.codeBits = 0
				d.bitCount = 0
				d.validCount++

				// Successfully read 4 characters?
				if d.validCount == 4 {
					// Process sync characters
					for _, code := range d.syncChars {
						d.processCharacter(code)
					}
					d.setState(StateReadData)
				}
			} else {
				// Failed subsequent bit test - restart sync
				d.codeBits = 0
				d.bitCount = 0
				d.syncSetup = true
			}
			d.waiting = true
		}

	case StateReadData:
		// Wait for start bit if there are variable stop bits (EFR modes only)
		if d.stopVariable && d.waiting && bit {
			// Still in stop bit (mark), wait for start bit (space)
			break
		}
		d.waiting = false

		// Read data bits
		d.codeBits = (d.codeBits >> 1) | (bitVal * msbVal)
		d.bitCount++

		if d.bitCount == d.nbits {
			d.processCharacter(d.codeBits)
			d.codeBits = 0
			d.bitCount = 0
			d.waiting = true
		}
	}
}

// processCharacter processes a decoded character code
func (d *FSKDemodulator) processCharacter(code uint32) {
	if d.charEncoding == nil {
		return
	}

	ch, success := d.charEncoding.ProcessChar(code)
	if success {
		if ch != 0 && d.outputCB != nil {
			d.outputCB(ch)
		}
		d.succeedTally++
	} else {
		d.failTally++
	}
}

// Reset resets the decoder state
func (d *FSKDemodulator) Reset() {
	d.state = StateNoSignal
	d.syncSetup = true
	d.bitCount = 0
	d.codeBits = 0
	d.sampleCount = 0
	d.nextEventCount = 0
	d.signalAccumulator = 0
	d.audioAverage = 0.1

	if d.charEncoding != nil {
		d.charEncoding.Reset()
	}

	d.biquadMark.Reset()
	d.biquadSpace.Reset()
	d.biquadLowpass.Reset()
}
