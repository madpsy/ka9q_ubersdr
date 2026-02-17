package morse

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
)

// MorseDecoder implements a timing-based Morse code decoder
// Based on UHSDR/KiwiSDR algorithm
type MorseDecoder struct {
	// Configuration
	sampleRate      int
	centerFrequency float64
	bandwidth       float64
	minWPM          float64
	maxWPM          float64
	wpmAlpha        float64 // Smoothing factor for WPM estimation
	decoderID       int     // Decoder ID for multi-channel mode (0 for standalone)

	// Signal processing
	envelope        *EnvelopeDetector
	snrEstimator    *SNREstimator
	thresholdSNR    float64
	isAutoThreshold bool    // Use auto threshold (nonlinear) vs fixed threshold
	thresholdLinear float64 // Linear threshold for signal detection

	// SNR tracking
	peakSNR  float64
	snrDecay float64 // Decay factor for peak SNR
	snrMu    sync.Mutex

	// Adaptive timing (KiwiSDR approach)
	pulseAvg            float64 // Composite average for dot/dash discrimination
	dotAvg              float64 // Average dot duration
	dashAvg             float64 // Average dash duration
	symSpaceAvg         float64 // Average symbol space (between dots/dashes)
	cwSpaceAvg          float64 // Average character/word space
	lastWordSpace       float64 // Last word space duration (for correction)
	wordSpaceFlag       bool    // Pending word space to output
	currentWPM          float64 // Calculated WPM
	initialized         bool    // Have we learned timing yet?
	trackTiming         bool    // Continuously adapt timing
	trainingCount       int     // Number of marks processed during training
	wordSpaceCorrection bool    // Enable word space correction (equation 4.15)

	// Error tracking and re-training
	errorCount   int       // Count of decode errors
	errorTimeout time.Time // Time when error count resets

	// State machine (block-based timing)
	keyState      KeyState
	keyDownBlocks int     // Number of blocks in key-down state
	keyUpBlocks   int     // Number of blocks in key-up state
	blockDuration float64 // Duration of one block in seconds
	lastActivity  time.Time
	morseElements string

	// Output
	morseBuffer string
	textBuffer  string

	// Control
	running  bool
	mu       sync.Mutex
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Output buffering
	bufferMu sync.Mutex
}

// KeyState represents the current key state
type KeyState int

const (
	KeyUp KeyState = iota
	KeyDown
)

// MorseConfig contains configuration parameters
type MorseConfig struct {
	CenterFrequency float64 `json:"center_frequency"`  // Hz - for single decoder or assigned frequency
	Bandwidth       float64 `json:"bandwidth"`         // Hz (e.g., 100) - per-decoder filter bandwidth
	MinWPM          float64 `json:"min_wpm"`           // Minimum WPM (e.g., 12)
	MaxWPM          float64 `json:"max_wpm"`           // Maximum WPM (e.g., 45)
	ThresholdSNR    float64 `json:"threshold_snr"`     // SNR threshold in dB (e.g., 10)
	IsAutoThreshold bool    `json:"is_auto_threshold"` // Use auto threshold (nonlinear processing)
	ThresholdLinear float64 `json:"threshold_linear"`  // Linear threshold value (for fixed mode)
}

// DefaultMorseConfig returns default configuration matching KiwiSDR defaults
func DefaultMorseConfig() MorseConfig {
	return MorseConfig{
		CenterFrequency: 600.0, // Not used in multi-channel mode
		Bandwidth:       100.0,
		MinWPM:          12.0,
		MaxWPM:          45.0,
		ThresholdSNR:    10.0,
		IsAutoThreshold: false,   // KiwiSDR default is FIXED mode
		ThresholdLinear: 15849.0, // KiwiSDR AUTO_THRESHOLD_LINEAR (~42 dB)
	}
}

// NewMorseDecoder creates a new Morse decoder
func NewMorseDecoder(sampleRate int, config MorseConfig) *MorseDecoder {
	d := &MorseDecoder{
		sampleRate:      sampleRate,
		centerFrequency: config.CenterFrequency,
		bandwidth:       config.Bandwidth,
		minWPM:          config.MinWPM,
		maxWPM:          config.MaxWPM,
		wpmAlpha:        0.3,  // Smoothing factor from PyMorseLive
		snrDecay:        0.99, // Slow decay for peak SNR (holds peak for ~100 samples)
		thresholdSNR:    config.ThresholdSNR,
		isAutoThreshold: config.IsAutoThreshold,
		thresholdLinear: config.ThresholdLinear,
		currentWPM:      0.0, // Will be calculated from timing
		peakSNR:         0.0,
		keyState:        KeyUp,
		keyDownBlocks:   0,
		keyUpBlocks:     0,
		blockDuration:   32.0 / float64(sampleRate), // 32 samples per block
		lastActivity:    time.Now(),
		stopChan:        make(chan struct{}),
		// Adaptive timing (start with defaults for 16 WPM)
		pulseAvg:            0.0,
		dotAvg:              0.0,
		dashAvg:             0.0,
		symSpaceAvg:         0.0,
		cwSpaceAvg:          0.0,
		lastWordSpace:       0.0,
		initialized:         false,
		trackTiming:         true, // Always track timing changes
		trainingCount:       0,
		wordSpaceCorrection: true, // Enable word space correction
	}

	// Initialize envelope detector with threshold mode
	d.envelope = NewEnvelopeDetector(sampleRate, config.CenterFrequency, config.Bandwidth, config.IsAutoThreshold)

	// Initialize SNR estimator
	d.snrEstimator = NewSNREstimator(100) // 100 sample window

	log.Printf("[Morse] Initialized: SR=%d, CF=%.1f Hz, BW=%.1f Hz, WPM=%.1f-%.1f, Threshold=%s %.0f",
		sampleRate, config.CenterFrequency, config.Bandwidth, config.MinWPM, config.MaxWPM,
		map[bool]string{true: "AUTO", false: "FIXED"}[config.IsAutoThreshold], config.ThresholdLinear)

	return d
}

// initializeTimingFromWPM initializes timing averages from a fixed WPM
func (d *MorseDecoder) initializeTimingFromWPM(wpm float64) {
	// Calculate block duration in blocks (not seconds)
	blocksPerMs := 1.0 / (d.blockDuration * 1000.0)
	msPerElement := 60000.0 / (wpm * 50.0) // PARIS = 50 elements

	d.dotAvg = blocksPerMs * msPerElement
	d.dashAvg = d.dotAvg * 3.0
	d.cwSpaceAvg = d.dotAvg * 4.2
	d.symSpaceAvg = d.dotAvg * 0.93
	d.pulseAvg = (d.dotAvg/4.0 + d.dashAvg) / 2.0

	d.initialized = true
	log.Printf("[Decoder %d] Initialized timing from %d WPM: dot=%.1f, dash=%.1f, pulse=%.1f blocks",
		d.decoderID, int(wpm), d.dotAvg, d.dashAvg, d.pulseAvg)
}

// updateWPM calculates WPM from current timing averages
func (d *MorseDecoder) updateWPM() {
	if !d.initialized {
		return
	}

	// PARIS standard calculation
	spdCalc := 10.0*d.dotAvg + 4.0*d.dashAvg + 9.0*d.symSpaceAvg + 5.0*d.cwSpaceAvg
	if spdCalc <= 0 {
		return
	}

	// Convert to milliseconds per word
	msPerWord := spdCalc * d.blockDuration * 1000.0
	wpmRaw := 60000.0 / msPerWord

	// Smooth the WPM estimate
	if d.currentWPM == 0 {
		d.currentWPM = wpmRaw
	} else {
		d.currentWPM = wpmRaw*0.3 + d.currentWPM*0.7
	}
}

// Start begins processing audio samples
func (d *MorseDecoder) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	d.mu.Lock()
	if d.running {
		d.mu.Unlock()
		return fmt.Errorf("decoder already running")
	}
	d.running = true
	d.mu.Unlock()

	d.wg.Add(1)
	go d.processLoop(audioChan, resultChan)

	return nil
}

// Stop stops the decoder
func (d *MorseDecoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.mu.Unlock()

	close(d.stopChan)
	d.wg.Wait()

	d.mu.Lock()
	d.running = false
	d.mu.Unlock()

	return nil
}

// GetName returns the decoder name
func (d *MorseDecoder) GetName() string {
	return "morse"
}

// processLoop is the main processing loop
func (d *MorseDecoder) processLoop(audioChan <-chan []int16, resultChan chan<- []byte) {
	defer d.wg.Done()

	// Periodic text flush ticker (every 100ms)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	// Periodic WPM update ticker (every 500ms)
	wpmTicker := time.NewTicker(500 * time.Millisecond)
	defer wpmTicker.Stop()

	for {
		select {
		case <-d.stopChan:
			return

		case samples, ok := <-audioChan:
			if !ok {
				return
			}
			// Process audio samples
			d.processSamples(samples)

		case <-ticker.C:
			// Check for word separator timeout
			d.checkWordSeparator()
			// Flush text buffer periodically
			d.flushBuffers(resultChan, d.decoderID)

		case <-wpmTicker.C:
			// Send WPM update
			d.sendWPMUpdate(resultChan, d.decoderID)
		}
	}
}

// processSamples processes a batch of audio samples
func (d *MorseDecoder) processSamples(samples []int16) {
	// Convert to float64
	floatSamples := make([]float64, len(samples))
	for i, sample := range samples {
		floatSamples[i] = float64(sample) / 32768.0
	}

	// Process in blocks of 32 samples (like KiwiSDR)
	blockSize := 32
	for i := 0; i < len(floatSamples); i += blockSize {
		end := i + blockSize
		if end > len(floatSamples) {
			end = len(floatSamples)
		}

		block := floatSamples[i:end]
		if len(block) == blockSize {
			// Process complete block
			signal := d.envelope.ProcessBlock(block)

			// Update SNR estimate
			snr := d.snrEstimator.Process(signal)

			// Detect key transitions
			d.detectTransitionBlock(signal, snr)
		}
	}
}

// detectTransitionBlock detects key up/down transitions using block-based timing
func (d *MorseDecoder) detectTransitionBlock(signal, snr float64) {
	// Update peak SNR (with slow decay)
	d.snrMu.Lock()
	if snr > d.peakSNR {
		d.peakSNR = snr
	} else {
		d.peakSNR *= d.snrDecay
	}
	d.snrMu.Unlock()

	// Determine new state based on threshold mode
	var newState bool
	if d.isAutoThreshold {
		// Auto threshold mode: nonlinear processing with configurable threshold
		// KiwiSDR line 484: newstate = (siglevel >= threshold_linear)
		newState = signal >= d.thresholdLinear
	} else {
		// Fixed threshold mode: compare magnitude directly to threshold
		// KiwiSDR line 493: newstate = (siglevel >= threshold_linear)
		// Signal is already low-pass filtered magnitude
		newState = signal >= d.thresholdLinear
	}

	// Noise canceling: require 2 consecutive blocks with same state
	if d.envelope.noiseCancelEnabled {
		if d.envelope.noiseCancelChange {
			// Second consecutive block with new state - confirm transition
			if newState != d.envelope.currentState {
				d.envelope.currentState = newState
				d.envelope.noiseCancelChange = false
				d.processStateChange(newState)
			} else {
				// State changed back - ignore
				d.envelope.noiseCancelChange = false
			}
		} else if newState != d.envelope.currentState {
			// First block with new state - wait for confirmation
			d.envelope.noiseCancelChange = true
		}
	} else {
		// No noise canceling
		if newState != d.envelope.currentState {
			d.envelope.currentState = newState
			d.processStateChange(newState)
		}
	}

	// Increment block counters
	if d.envelope.currentState {
		d.keyDownBlocks++
		d.keyUpBlocks = 0
	} else {
		d.keyUpBlocks++
		d.keyDownBlocks = 0
	}
}

// processStateChange handles state transitions
func (d *MorseDecoder) processStateChange(newState bool) {
	now := time.Now()
	d.lastActivity = now

	if newState {
		// Transition to key-down (mark)
		spaceBlocks := d.keyUpBlocks
		d.keyState = KeyDown
		d.keyDownBlocks = 0

		log.Printf("[Decoder %d] KEY DOWN - space blocks: %d", d.decoderID, spaceBlocks)

		d.processSpace(spaceBlocks)
	} else {
		// Transition to key-up (space)
		markBlocks := d.keyDownBlocks
		d.keyState = KeyUp
		d.keyUpBlocks = 0

		log.Printf("[Decoder %d] KEY UP - mark blocks: %d", d.decoderID, markBlocks)

		d.processMark(markBlocks)
	}
}

// processMark processes a mark (key down) duration using KiwiSDR adaptive algorithm
func (d *MorseDecoder) processMark(blocks int) {
	t := float64(blocks)

	// Initialize timing if needed
	if d.trainingCount == 0 {
		// First mark - initialize from default WPM
		d.initializeTimingFromWPM(16.0)
	}

	// Training period (KiwiSDR has 3 phases)
	if !d.initialized {
		d.trainingCount++

		const TRAINING_STABLE = 32

		if d.trainingCount > TRAINING_STABLE {
			// Late training phase - more stable (equations 4.4, 4.5)
			if t > d.pulseAvg {
				d.dashAvg = d.dashAvg + (t-d.dashAvg)/4.0 // Equation 4.5
			} else {
				d.dotAvg = d.dotAvg + (t-d.dotAvg)/4.0 // Equation 4.4
			}
		} else {
			// Early training phase - unstable (equations 4.1, 4.2)
			if t > d.pulseAvg {
				d.dashAvg = (t + d.dashAvg) / 2.0 // Equation 4.2
			} else {
				d.dotAvg = (t + d.dotAvg) / 2.0 // Equation 4.1
			}
		}
		d.pulseAvg = (d.dotAvg/4.0 + d.dashAvg) / 2.0 // Equation 4.3

		// After enough training, mark as initialized
		if d.trainingCount >= TRAINING_STABLE*2 {
			d.initialized = true
			log.Printf("[Decoder %d] Training complete after %d marks: dot=%.1f, dash=%.1f, pulse=%.1f",
				d.decoderID, d.trainingCount, d.dotAvg, d.dashAvg, d.pulseAvg)
		}
		return // Don't decode during training
	}

	// Normal operation - classify as dot or dash (equation 4.10)
	var element string
	if (d.pulseAvg - t) >= 0 {
		// It's a dot
		element = "."
		if d.trackTiming {
			d.dotAvg = d.dotAvg + (t-d.dotAvg)/8.0 // Equation 4.6
		}
	} else {
		// It's a dash
		element = "-"
		if t <= 5.0*d.dashAvg { // Ignore stuck key
			if d.trackTiming {
				d.dashAvg = d.dashAvg + (t-d.dashAvg)/8.0 // Equation 4.7
			}
		}
	}

	// Update pulse_avg (equation 4.3)
	if d.trackTiming {
		d.pulseAvg = (d.dotAvg/4.0 + d.dashAvg) / 2.0
	}

	// Update WPM
	d.updateWPM()

	log.Printf("[Decoder %d] Decoded: %s (%.1f blocks, %.1f WPM)", d.decoderID, element, t, d.currentWPM)

	d.morseElements += element
	d.bufferMu.Lock()
	d.morseBuffer += element
	d.bufferMu.Unlock()
}

// processSpace processes a space (key up) duration using KiwiSDR adaptive algorithm
func (d *MorseDecoder) processSpace(blocks int) {
	t := float64(blocks)

	const TRAINING_STABLE = 32

	// During training, update space averages
	if !d.initialized && d.trainingCount > TRAINING_STABLE {
		// Late training phase - update space averages (equation 4.8)
		if t > d.pulseAvg {
			d.cwSpaceAvg = d.cwSpaceAvg + (t-d.cwSpaceAvg)/4.0
		} else {
			d.symSpaceAvg = d.symSpaceAvg + (t-d.symSpaceAvg)/4.0
		}
		return // Don't decode during training
	}

	if !d.initialized {
		return // Ignore spaces in early training
	}

	// Determine if symbol space or character/word space
	// This uses KiwiSDR equations 4.11-4.14

	// Symbol space (between dots/dashes in same character)
	if (t - d.pulseAvg) < 0 {
		if d.trackTiming {
			d.symSpaceAvg = d.symSpaceAvg + (t-d.symSpaceAvg)/8.0
		}
		return // Not end of character yet
	}

	// Character or word space
	if t <= 10.0*d.dashAvg { // Not a timeout
		if d.trackTiming {
			d.cwSpaceAvg = d.cwSpaceAvg + (t-d.cwSpaceAvg)/8.0 // Equation 4.9
		}

		// Check if word space (equation 4.13)
		if (t - d.cwSpaceAvg) >= 0 {
			// Word space
			d.lastWordSpace = t
			d.wordSpaceFlag = true
			d.processCharacter()
		} else {
			// Character space
			d.wordSpaceFlag = false
			d.processCharacter()
		}
	} else {
		// Timeout - end of transmission
		d.processCharacter()
		d.bufferMu.Lock()
		d.morseBuffer += " / "
		d.textBuffer += " "
		d.bufferMu.Unlock()
	}
}

// checkWordSeparator checks for word separator timeout
func (d *MorseDecoder) checkWordSeparator() {
	if !d.initialized || d.morseElements == "" {
		return
	}

	// Check if we've been idle for more than 10 * dash_avg
	now := time.Now()
	idleBlocks := int(now.Sub(d.lastActivity).Seconds() / d.blockDuration)

	if float64(idleBlocks) > 10.0*d.dashAvg {
		d.processCharacter()
		d.bufferMu.Lock()
		d.morseBuffer += " / "
		d.textBuffer += " "
		d.bufferMu.Unlock()
	}
}

// processCharacter converts accumulated Morse elements to a character
func (d *MorseDecoder) processCharacter() {
	if d.morseElements == "" {
		return
	}

	char := morseToChar(d.morseElements)
	d.morseElements = ""

	// Check for decode error (unknown character)
	if char == "?" && d.trackTiming {
		d.errorCount++
		d.errorTimeout = time.Now().Add(8 * time.Second) // ERROR_TIMEOUT = 8 seconds

		log.Printf("[Decoder %d] Decode error %d/4", d.decoderID, d.errorCount)

		// After 3 errors, trigger re-training
		if d.errorCount > 3 {
			log.Printf("[Decoder %d] Too many errors - re-training", d.decoderID)
			d.initialized = false
			d.trainingCount = 0
			d.errorCount = 0
			d.errorTimeout = time.Time{}
		}
	}

	// Reset error count after timeout
	if !d.errorTimeout.IsZero() && time.Now().After(d.errorTimeout) {
		d.errorCount = 0
		d.errorTimeout = time.Time{}
	}

	d.bufferMu.Lock()
	d.textBuffer += char

	// Handle word space with correction (KiwiSDR equation 4.15)
	if d.wordSpaceFlag {
		d.wordSpaceFlag = false

		// Word space correction for characters ending in dash (I, J, Q, U, V, Z)
		if d.wordSpaceCorrection {
			needsCorrection := char == "I" || char == "J" || char == "Q" ||
				char == "U" || char == "V" || char == "Z"

			if needsCorrection {
				// Equation 4.15: Check if space was long enough
				x := (d.cwSpaceAvg + d.pulseAvg) - d.lastWordSpace
				if x < 0 {
					// Space was long enough - add word space
					d.morseBuffer += " / "
					d.textBuffer += " "
				}
				// else: space was too short, treat as character space (no output)
			} else {
				// Normal word space
				d.morseBuffer += " / "
				d.textBuffer += " "
			}
		} else {
			// No correction - always add word space
			d.morseBuffer += " / "
			d.textBuffer += " "
		}
	} else {
		// Character space
		d.morseBuffer += " "
	}

	d.bufferMu.Unlock()
}

// flushBuffers sends accumulated morse and text to the client in a combined message
func (d *MorseDecoder) flushBuffers(resultChan chan<- []byte, decoderID int) {
	d.bufferMu.Lock()

	hasMorse := len(d.morseBuffer) > 0
	hasText := len(d.textBuffer) > 0

	morse := d.morseBuffer
	text := d.textBuffer

	d.morseBuffer = ""
	d.textBuffer = ""
	d.bufferMu.Unlock()

	// Send combined message if we have either morse or text
	if hasMorse || hasText {
		d.sendCombinedMessage(resultChan, decoderID, morse, text)
	}
}

// sendCombinedMessage sends both morse and text in a single message
// Binary protocol: [type:1][decoder_id:1][timestamp:8][morse_length:4][morse:length][text_length:4][text:length]
// type: 0x01 = combined morse+text message
func (d *MorseDecoder) sendCombinedMessage(resultChan chan<- []byte, decoderID int, morse, text string) {
	morseBytes := []byte(morse)
	textBytes := []byte(text)

	msg := make([]byte, 1+1+8+4+len(morseBytes)+4+len(textBytes))

	msg[0] = 0x01 // Combined message type
	msg[1] = byte(decoderID)
	binary.BigEndian.PutUint64(msg[2:10], uint64(time.Now().Unix()))

	// Morse data
	binary.BigEndian.PutUint32(msg[10:14], uint32(len(morseBytes)))
	copy(msg[14:], morseBytes)

	// Text data
	offset := 14 + len(morseBytes)
	binary.BigEndian.PutUint32(msg[offset:offset+4], uint32(len(textBytes)))
	copy(msg[offset+4:], textBytes)

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip this message
	}
}

// sendWPMUpdate sends WPM information to the client
// Binary protocol: [type:1][decoder_id:1][wpm:8]
// type: 0x03 = WPM update
func (d *MorseDecoder) sendWPMUpdate(resultChan chan<- []byte, decoderID int) {
	msg := make([]byte, 1+1+8)
	msg[0] = 0x03 // WPM update type
	msg[1] = byte(decoderID)

	// Convert float64 to bytes
	binary.BigEndian.PutUint64(msg[2:10], math.Float64bits(d.currentWPM))

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip
	}
}
