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

// FSKDecoder implements an FSK (Frequency Shift Keying) demodulator
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
	codeBits     uint16 // Changed from byte to support 15-bit codes (5N1.5)
	nbits        int
	msb          uint16 // Changed from byte to support 15-bit codes
	syncSetup    bool
	syncChars    []uint16 // Changed from []byte to support 15-bit codes
	validCount   int
	errorCount   int
	waiting      bool
	stopVariable bool // For async framing with variable stop bits (e.g., 1.5 stop bits)

	// Encoding (only one will be non-nil)
	ccir476 *CCIR476
	ita2    *ITA2

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

	// Initialize encoding first to determine if we need to double the baud rate
	switch encoding {
	case "CCIR476":
		d.ccir476 = NewCCIR476()
		d.nbits = d.ccir476.GetNBits()
		d.msb = d.ccir476.GetMSB()
	case "ITA2":
		d.ita2 = NewITA2(framing)
		d.nbits = d.ita2.GetNBits()
		d.msb = d.ita2.GetMSB()
		// For async framing with 1.5 stop bits, double the baud rate for oversampling
		// This allows us to sample each bit twice for validation
		if framing == "5N1.5" {
			d.baudRate *= 2
			d.stopVariable = true
			log.Printf("[FSK] 5N1.5 framing: doubled baud rate to %.1f for oversampling", d.baudRate)
		}
	default:
		log.Printf("[FSK] Unsupported encoding: %s, defaulting to CCIR476", encoding)
		d.ccir476 = NewCCIR476()
		d.nbits = d.ccir476.GetNBits()
		d.msb = d.ccir476.GetMSB()
	}

	// Calculate bit timing AFTER potentially doubling baud rate
	d.bitDurationSeconds = 1.0 / d.baudRate
	d.bitSampleCount = int(d.sampleRate*d.bitDurationSeconds + 0.5)
	d.halfBitSampleCount = d.bitSampleCount / 2

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
		// Notify callback of state change
		if d.stateCB != nil {
			d.stateCB(s)
		}
		// log.Printf("[FSK] State: %v", s)
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
	bitVal := uint16(0)
	if bit {
		bitVal = 1
	}

	if d.syncSetup {
		d.bitCount = 0
		d.codeBits = 0
		d.errorCount = 0
		d.validCount = 0
		if d.ccir476 != nil {
			d.ccir476.Reset()
		}
		if d.ita2 != nil {
			d.ita2.Reset()
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
		d.codeBits = (d.codeBits >> 1) | (bitVal * d.msb)

		// Debug: log bit collection every second
		if d.ita2 != nil && d.bitCount%50 == 0 {
			log.Printf("[FSK] SYNC1: bit=%d, codeBits=0x%04x (%015b)", bitVal, d.codeBits, d.codeBits)
		}

		// Check validity based on encoding
		valid := false
		if d.ccir476 != nil {
			valid = d.ccir476.CheckBits(d.codeBits)
		} else if d.ita2 != nil {
			// For ITA2 with async framing, validate frame structure
			valid = d.ita2.CheckBits(d.codeBits)
		}

		if valid {
			d.syncChars = append(d.syncChars, d.codeBits)
			d.validCount++
			d.bitCount = 0
			d.codeBits = 0
			d.setState(StateSync2)
			d.waiting = true
		}

	case StateSync2:
		// Wait for start bit if there are variable stop bits (async framing)
		if d.stopVariable && d.waiting && bit {
			// Still in stop bits (mark state), keep waiting
			return
		}
		d.waiting = false

		// Sample and validate bits in groups of nbits
		d.codeBits = (d.codeBits >> 1) | (bitVal * d.msb)
		d.bitCount++

		if d.bitCount == d.nbits {
			valid := false
			if d.ccir476 != nil {
				valid = d.ccir476.CheckBits(d.codeBits)
			} else if d.ita2 != nil {
				// For ITA2 with async framing, validate frame structure
				valid = d.ita2.CheckBits(d.codeBits)
			}

			if valid {
				d.syncChars = append(d.syncChars, d.codeBits)
				d.codeBits = 0
				d.bitCount = 0
				d.validCount++

				// For CCIR476, wait for 4 characters; for ITA2, start immediately
				requiredChars := 4
				if d.ita2 != nil {
					requiredChars = 1
				}

				if d.validCount >= requiredChars {
					// Process sync characters
					for _, code := range d.syncChars {
						d.processCharacter(code)
					}
					d.setState(StateReadData)
				}
			} else {
				// Failed subsequent bit test - restart sync (CCIR476 only)
				d.codeBits = 0
				d.bitCount = 0
				d.syncSetup = true
			}
			d.waiting = true
		}

	case StateReadData:
		// Wait for start bit if there are variable stop bits (async framing)
		if d.stopVariable && d.waiting && bit {
			// Still in stop bits (mark state), keep waiting
			return
		}
		d.waiting = false

		// Read data bits
		d.codeBits = (d.codeBits >> 1) | (bitVal * d.msb)
		d.bitCount++

		if d.bitCount == d.nbits {
			// Process character and track errors for automatic resync
			success := d.processCharacter(d.codeBits)

			// Error recovery logic
			if success {
				// Decrement error count on successful decode
				if d.errorCount > 0 {
					d.errorCount--
				}
			} else {
				// Increment error count on failed decode
				d.errorCount++
				// If too many consecutive errors, return to sync mode
				if d.errorCount > 2 {
					log.Printf("[FSK] Too many errors (%d), returning to sync mode", d.errorCount)
					d.syncSetup = true
				}
			}

			d.codeBits = 0
			d.bitCount = 0
			d.waiting = true
		}
	}
}

// processCharacter processes a decoded character code
// Returns true if the character was successfully decoded
func (d *FSKDemodulator) processCharacter(code uint16) bool {
	if d.ccir476 != nil {
		result := d.ccir476.ProcessChar(code)

		// Output character if present
		if result.Char != 0 && d.outputCB != nil {
			d.outputCB(result.Char)
		}

		// Update tallies based on character decode result
		if result.Tally == 1 {
			d.succeedTally++
		} else if result.Tally == -1 {
			d.failTally++
		}

		// Return bit validity for error counting
		return result.BitSuccess
	} else if d.ita2 != nil {
		result := d.ita2.ProcessChar(code)

		// Output character if present
		if result.Char != 0 && d.outputCB != nil {
			d.outputCB(result.Char)
		}

		// Update tallies based on character decode result
		if result.Tally == 1 {
			d.succeedTally++
		}

		// ITA2 has no error correction, so always return true
		return result.BitSuccess
	}

	return false
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

	if d.ccir476 != nil {
		d.ccir476.Reset()
	}
	if d.ita2 != nil {
		d.ita2.Reset()
	}

	d.biquadMark.Reset()
	d.biquadSpace.Reset()
	d.biquadLowpass.Reset()
}
