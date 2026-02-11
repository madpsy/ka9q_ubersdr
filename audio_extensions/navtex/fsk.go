package navtex

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
type FSKDecoder struct {
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
	bitCount   int
	codeBits   byte
	nbits      int
	msb        byte
	syncSetup  bool
	syncChars  []byte
	validCount int
	errorCount int
	waiting    bool

	// Encoding
	ccir476 *CCIR476

	// Callbacks
	baudErrorCB func(float64)
	outputCB    func(rune)

	// Statistics
	succeedTally int
	failTally    int
}

// NewFSKDecoder creates a new FSK decoder
func NewFSKDecoder(sampleRate int, centerFreq, shiftHz, baudRate float64, framing, encoding string, inverted bool) *FSKDecoder {
	d := &FSKDecoder{
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

	// Initialize encoding
	switch encoding {
	case "CCIR476":
		d.ccir476 = NewCCIR476()
		d.nbits = d.ccir476.GetNBits()
		d.msb = d.ccir476.GetMSB()
	default:
		log.Printf("[FSK] Unsupported encoding: %s", encoding)
		d.nbits = 7
		d.msb = 0x40
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
func (d *FSKDecoder) SetBaudErrorCallback(cb func(float64)) {
	d.baudErrorCB = cb
}

// SetOutputCallback sets the callback for decoded characters
func (d *FSKDecoder) SetOutputCallback(cb func(rune)) {
	d.outputCB = cb
}

// updateFilters configures the biquad filters
func (d *FSKDecoder) updateFilters() {
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
func (d *FSKDecoder) setState(s FSKState) {
	if s != d.state {
		d.state = s
		// log.Printf("[FSK] State: %v", s)
	}
}

// ProcessSamples processes incoming audio samples
func (d *FSKDecoder) ProcessSamples(samples []int16) {
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
func (d *FSKDecoder) processBit(bit bool) {
	bitVal := byte(0)
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
		if d.ccir476 != nil && d.ccir476.CheckBits(d.codeBits) {
			d.syncChars = append(d.syncChars, d.codeBits)
			d.validCount++
			d.bitCount = 0
			d.codeBits = 0
			d.setState(StateSync2)
			d.waiting = true
		}

	case StateSync2:
		// Sample and validate bits in groups of nbits
		d.codeBits = (d.codeBits >> 1) | (bitVal * d.msb)
		d.bitCount++

		if d.bitCount == d.nbits {
			if d.ccir476 != nil && d.ccir476.CheckBits(d.codeBits) {
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
func (d *FSKDecoder) processCharacter(code byte) bool {
	if d.ccir476 == nil {
		return false
	}

	result := d.ccir476.ProcessChar(code)

	// Log for debugging
	log.Printf("[FSK] ProcessChar: code=0x%02X, bitSuccess=%v, tally=%d, ch=%c (0x%04X), errorCount=%d",
		code, result.BitSuccess, result.Tally, result.Char, result.Char, d.errorCount)

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
}

// Reset resets the decoder state
func (d *FSKDecoder) Reset() {
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

	d.biquadMark.Reset()
	d.biquadSpace.Reset()
	d.biquadLowpass.Reset()
}
