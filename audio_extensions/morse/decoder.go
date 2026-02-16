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
// Based on PyMorseLive algorithm
type MorseDecoder struct {
	// Configuration
	sampleRate      int
	centerFrequency float64
	bandwidth       float64
	minWPM          float64
	maxWPM          float64
	wpmAlpha        float64 // Smoothing factor for WPM estimation

	// Signal processing
	envelope     *EnvelopeDetector
	snrEstimator *SNREstimator
	thresholdSNR float64

	// Timing decoder
	currentWPM float64
	timeUnit   float64 // Duration of one "dit" in seconds
	timeSpec   TimeSpec

	// State machine
	keyState      KeyState
	keyDownTime   time.Time
	keyUpTime     time.Time
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

// TimeSpec contains timing thresholds for Morse decoding
type TimeSpec struct {
	DotShort     float64 // Minimum duration for a dot
	DotLong      float64 // Maximum duration for a dot
	CharSepShort float64 // Minimum duration for character separator
	CharSepLong  float64 // Maximum duration for character separator
	WordSep      float64 // Minimum duration for word separator
}

// MorseConfig contains configuration parameters
type MorseConfig struct {
	CenterFrequency float64 `json:"center_frequency"` // Hz (e.g., 600 for CW)
	Bandwidth       float64 `json:"bandwidth"`        // Hz (e.g., 100)
	MinWPM          float64 `json:"min_wpm"`          // Minimum WPM (e.g., 12)
	MaxWPM          float64 `json:"max_wpm"`          // Maximum WPM (e.g., 45)
	ThresholdSNR    float64 `json:"threshold_snr"`    // SNR threshold in dB (e.g., 10)
}

// DefaultMorseConfig returns default configuration
func DefaultMorseConfig() MorseConfig {
	return MorseConfig{
		CenterFrequency: 600.0,
		Bandwidth:       100.0,
		MinWPM:          12.0,
		MaxWPM:          45.0,
		ThresholdSNR:    10.0,
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
		wpmAlpha:        0.3, // Smoothing factor from PyMorseLive
		thresholdSNR:    config.ThresholdSNR,
		currentWPM:      16.0, // Start with 16 WPM
		keyState:        KeyUp,
		keyUpTime:       time.Now(),
		lastActivity:    time.Now(),
		stopChan:        make(chan struct{}),
	}

	// Initialize envelope detector
	d.envelope = NewEnvelopeDetector(sampleRate, config.CenterFrequency, config.Bandwidth)

	// Initialize SNR estimator
	d.snrEstimator = NewSNREstimator(100) // 100 sample window

	// Calculate initial timing specifications
	d.updateTimeSpec()

	log.Printf("[Morse] Initialized: SR=%d, CF=%.1f Hz, BW=%.1f Hz, WPM=%.1f-%.1f",
		sampleRate, config.CenterFrequency, config.Bandwidth, config.MinWPM, config.MaxWPM)

	return d
}

// updateTimeSpec updates timing thresholds based on current WPM
func (d *MorseDecoder) updateTimeSpec() {
	// PARIS standard: 1 dit = 1.2 / WPM seconds
	d.timeUnit = 1.2 / d.currentWPM

	// Timing thresholds from PyMorseLive
	d.timeSpec = TimeSpec{
		DotShort:     0.8 * d.timeUnit,
		DotLong:      2.0 * d.timeUnit,
		CharSepShort: 1.5 * d.timeUnit,
		CharSepLong:  4.0 * d.timeUnit,
		WordSep:      6.5 * d.timeUnit,
	}
}

// updateWPM updates the WPM estimate with smoothing
func (d *MorseDecoder) updateWPM(markDuration float64) {
	// Calculate WPM from mark duration
	// A dit should be 1.2/WPM seconds, a dah should be 3*1.2/WPM seconds
	minDitTime := 1.2 / d.maxWPM
	maxDitTime := 1.2 / d.minWPM
	maxDahTime := 3 * maxDitTime

	if markDuration < minDitTime || markDuration > maxDahTime {
		return // Out of range, ignore
	}

	var wpmNew float64
	if markDuration < maxDitTime {
		// It's a dit
		wpmNew = 1.2 / markDuration
	} else {
		// It's a dah (3 dits)
		wpmNew = 3 * 1.2 / markDuration
	}

	// Clamp to valid range
	if wpmNew < d.minWPM {
		wpmNew = d.minWPM
	}
	if wpmNew > d.maxWPM {
		wpmNew = d.maxWPM
	}

	// Smooth the WPM estimate
	d.currentWPM = d.wpmAlpha*wpmNew + (1-d.wpmAlpha)*d.currentWPM
	d.updateTimeSpec()
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
			d.flushBuffers(resultChan)

		case <-wpmTicker.C:
			// Send WPM update
			d.sendWPMUpdate(resultChan)
		}
	}
}

// processSamples processes a batch of audio samples
func (d *MorseDecoder) processSamples(samples []int16) {
	for _, sample := range samples {
		// Convert to float and normalize
		floatSample := float64(sample) / 32768.0

		// Get envelope (signal strength)
		envelope := d.envelope.Process(floatSample)

		// Update SNR estimate
		snr := d.snrEstimator.Process(envelope)

		// Detect key transitions based on SNR threshold
		d.detectTransition(snr)
	}
}

// detectTransition detects key up/down transitions
func (d *MorseDecoder) detectTransition(snr float64) {
	now := time.Now()

	// Normalize SNR to 0-1 range for threshold comparison
	level := math.Min(snr/d.thresholdSNR, 1.0)

	// Key down transition (signal appears)
	if d.keyState == KeyUp && level > 0.6 {
		spaceDuration := now.Sub(d.keyUpTime).Seconds()
		d.keyState = KeyDown
		d.keyDownTime = now
		d.lastActivity = now

		// Process the space duration
		d.processSpace(spaceDuration)
	}

	// Key up transition (signal disappears)
	if d.keyState == KeyDown && level < 0.4 {
		markDuration := now.Sub(d.keyDownTime).Seconds()
		d.keyState = KeyUp
		d.keyUpTime = now
		d.lastActivity = now

		// Process the mark duration
		d.processMark(markDuration)
	}
}

// processMark processes a mark (key down) duration
func (d *MorseDecoder) processMark(duration float64) {
	ts := d.timeSpec

	if duration < ts.DotShort {
		return // Too short, ignore
	}

	// Update WPM estimate
	d.updateWPM(duration)

	// Classify as dit or dah
	var element string
	if duration < ts.DotLong {
		element = "."
	} else {
		element = "-"
	}

	d.morseElements += element
	d.bufferMu.Lock()
	d.morseBuffer += element
	d.bufferMu.Unlock()
}

// processSpace processes a space (key up) duration
func (d *MorseDecoder) processSpace(duration float64) {
	ts := d.timeSpec

	if duration < ts.CharSepShort {
		return // Too short, ignore
	}

	// Character separator
	if duration < ts.CharSepLong {
		d.processCharacter()
		d.bufferMu.Lock()
		d.morseBuffer += " "
		d.bufferMu.Unlock()
		return
	}

	// Word separator
	d.processCharacter()
	d.bufferMu.Lock()
	d.morseBuffer += " / "
	d.textBuffer += " "
	d.bufferMu.Unlock()
}

// checkWordSeparator checks for word separator timeout
func (d *MorseDecoder) checkWordSeparator() {
	if d.morseElements == "" {
		return
	}

	now := time.Now()
	if now.Sub(d.lastActivity).Seconds() > d.timeSpec.WordSep {
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

	d.bufferMu.Lock()
	d.textBuffer += char
	d.bufferMu.Unlock()
}

// flushBuffers sends accumulated morse and text to the client in a combined message
func (d *MorseDecoder) flushBuffers(resultChan chan<- []byte) {
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
		d.sendCombinedMessage(resultChan, morse, text)
	}
}

// sendCombinedMessage sends both morse and text in a single message
// Binary protocol: [type:1][timestamp:8][morse_length:4][morse:length][text_length:4][text:length]
// type: 0x01 = combined morse+text message
func (d *MorseDecoder) sendCombinedMessage(resultChan chan<- []byte, morse, text string) {
	morseBytes := []byte(morse)
	textBytes := []byte(text)

	msg := make([]byte, 1+8+4+len(morseBytes)+4+len(textBytes))

	msg[0] = 0x01 // Combined message type
	binary.BigEndian.PutUint64(msg[1:9], uint64(time.Now().Unix()))

	// Morse data
	binary.BigEndian.PutUint32(msg[9:13], uint32(len(morseBytes)))
	copy(msg[13:], morseBytes)

	// Text data
	offset := 13 + len(morseBytes)
	binary.BigEndian.PutUint32(msg[offset:offset+4], uint32(len(textBytes)))
	copy(msg[offset+4:], textBytes)

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip this message
	}
}

// sendWPMUpdate sends WPM information to the client
// Binary protocol: [type:1][wpm:8]
// type: 0x03 = WPM update
func (d *MorseDecoder) sendWPMUpdate(resultChan chan<- []byte) {
	msg := make([]byte, 1+8)
	msg[0] = 0x03 // WPM update type

	// Convert float64 to bytes
	binary.BigEndian.PutUint64(msg[1:9], math.Float64bits(d.currentWPM))

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip
	}
}
