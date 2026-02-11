package fsk

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
)

// FSKDecoder implements the FSK decoder using NAVTEX's working implementation
type FSKDecoder struct {
	// Configuration
	sampleRate      int
	centerFrequency float64
	shift           float64
	baudRate        float64
	inverted        bool

	// FSK demodulator (from NAVTEX)
	fsk *FSKDemodulator

	// Control
	running  bool
	mu       sync.Mutex
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Output buffering
	textBuffer []rune
	bufferMu   sync.Mutex

	// Statistics
	baudError float64
	lastState FSKState
}

// FSKConfig contains configuration parameters
type FSKConfig struct {
	CenterFrequency float64 `json:"center_frequency"` // Hz (e.g., 500 for NAVTEX)
	Shift           float64 `json:"shift"`            // Hz (e.g., 170 for NAVTEX)
	BaudRate        float64 `json:"baud_rate"`        // Baud (e.g., 100 for NAVTEX)
	Inverted        bool    `json:"inverted"`         // Invert mark/space (false for NAVTEX)
	Framing         string  `json:"framing"`          // Framing (e.g., "4/7" for CCIR476)
	Encoding        string  `json:"encoding"`         // Encoding (e.g., "CCIR476")
}

// DefaultFSKConfig returns default NAVTEX configuration
func DefaultFSKConfig() FSKConfig {
	return NavtexConfig()
}

// NavtexConfig returns NAVTEX configuration (SITOR-B)
func NavtexConfig() FSKConfig {
	return FSKConfig{
		CenterFrequency: 500.0,
		Shift:           170.0,
		BaudRate:        100.0,
		Inverted:        false,
		Framing:         "4/7",
		Encoding:        "CCIR476",
	}
}

// WeatherConfig returns Weather RTTY configuration
func WeatherConfig() FSKConfig {
	return FSKConfig{
		CenterFrequency: 1000.0,  // Typical audio center frequency
		Shift:           450.0,   // Weather RTTY uses 450 Hz shift
		BaudRate:        50.0,    // 50 baud
		Inverted:        true,    // Inverted
		Framing:         "5N1.5", // 5 data bits, no parity, 1.5 stop bits
		Encoding:        "ITA2",  // Baudot/ITA2 encoding
	}
}

// HamConfig returns Ham RTTY configuration
func HamConfig() FSKConfig {
	return FSKConfig{
		CenterFrequency: 1000.0,  // Typical audio center frequency
		Shift:           170.0,   // Standard amateur RTTY shift
		BaudRate:        45.45,   // Standard amateur RTTY baud rate
		Inverted:        false,   // Not inverted
		Framing:         "5N1.5", // 5 data bits, no parity, 1.5 stop bits
		Encoding:        "ITA2",  // Baudot/ITA2 encoding
	}
}

// NewFSKDecoder creates a new FSK decoder
func NewFSKDecoder(sampleRate int, config FSKConfig) *FSKDecoder {
	d := &FSKDecoder{
		sampleRate:      sampleRate,
		centerFrequency: config.CenterFrequency,
		shift:           config.Shift,
		baudRate:        config.BaudRate,
		inverted:        config.Inverted,
		stopChan:        make(chan struct{}),
	}

	// Create FSK demodulator using NAVTEX implementation
	d.fsk = NewFSKDemodulator(
		sampleRate,
		config.CenterFrequency,
		config.Shift,
		config.BaudRate,
		config.Framing,
		config.Encoding,
		config.Inverted,
	)

	// Set callbacks
	d.fsk.SetBaudErrorCallback(func(err float64) {
		d.baudError = err
	})

	d.fsk.SetOutputCallback(func(ch rune) {
		d.bufferMu.Lock()
		d.textBuffer = append(d.textBuffer, ch)
		d.bufferMu.Unlock()
	})

	d.fsk.SetStateCallback(func(state FSKState) {
		d.lastState = state
	})

	log.Printf("[FSK] Initialized: SR=%d, CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Inverted=%v",
		sampleRate, config.CenterFrequency, config.Shift, config.BaudRate, config.Inverted)

	return d
}

// Start begins processing audio samples
func (d *FSKDecoder) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
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
func (d *FSKDecoder) Stop() error {
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
func (d *FSKDecoder) GetName() string {
	return "fsk"
}

// processLoop is the main processing loop
func (d *FSKDecoder) processLoop(audioChan <-chan []int16, resultChan chan<- []byte) {
	defer d.wg.Done()

	// Periodic text flush ticker (every 100ms)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	// Periodic baud error ticker (every 200ms to match NAVTEX)
	baudTicker := time.NewTicker(200 * time.Millisecond)
	defer baudTicker.Stop()

	// Periodic state update ticker (every 250ms)
	stateTicker := time.NewTicker(250 * time.Millisecond)
	defer stateTicker.Stop()

	lastState := FSKState(-1)

	for {
		select {
		case <-d.stopChan:
			return

		case samples, ok := <-audioChan:
			if !ok {
				return
			}
			// Process audio samples through FSK demodulator
			d.fsk.ProcessSamples(samples)

		case <-ticker.C:
			// Flush text buffer periodically
			d.flushTextBuffer(resultChan)

		case <-baudTicker.C:
			// Send baud error update
			d.sendBaudError(resultChan)

		case <-stateTicker.C:
			// Send state update if changed
			if d.lastState != lastState {
				d.sendStateUpdate(resultChan, d.lastState)
				lastState = d.lastState
			}
		}
	}
}

// flushTextBuffer sends accumulated text to the client
func (d *FSKDecoder) flushTextBuffer(resultChan chan<- []byte) {
	d.bufferMu.Lock()
	if len(d.textBuffer) == 0 {
		d.bufferMu.Unlock()
		return
	}

	// Convert runes to UTF-8 string
	text := string(d.textBuffer)
	d.textBuffer = d.textBuffer[:0] // Clear buffer
	d.bufferMu.Unlock()

	// Send text message
	d.sendTextMessage(resultChan, text)
}

// sendTextMessage sends a text message to the client
// Binary protocol: [type:1][timestamp:8][text_length:4][text:length]
// type: 0x01 = text message
func (d *FSKDecoder) sendTextMessage(resultChan chan<- []byte, text string) {
	textBytes := []byte(text)
	msg := make([]byte, 1+8+4+len(textBytes))

	msg[0] = 0x01 // Text message type
	binary.BigEndian.PutUint64(msg[1:9], uint64(time.Now().Unix()))
	binary.BigEndian.PutUint32(msg[9:13], uint32(len(textBytes)))
	copy(msg[13:], textBytes)

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip this message
	}
}

// sendBaudError sends baud error information to the client
// Binary protocol: [type:1][error:8]
// type: 0x02 = baud error
func (d *FSKDecoder) sendBaudError(resultChan chan<- []byte) {
	msg := make([]byte, 1+8)
	msg[0] = 0x02 // Baud error type

	// Convert float64 to bytes
	binary.BigEndian.PutUint64(msg[1:9], math.Float64bits(d.baudError))

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip
	}
}

// sendStateUpdate sends decoder state update to the client
// Binary protocol: [type:1][state:1]
// type: 0x03 = state update
// state: 0=NoSignal, 1=Sync1, 2=Sync2, 3=ReadData
func (d *FSKDecoder) sendStateUpdate(resultChan chan<- []byte, state FSKState) {
	msg := make([]byte, 2)
	msg[0] = 0x03        // State update type
	msg[1] = byte(state) // State value

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip
	}
}
