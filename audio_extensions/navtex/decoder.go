package navtex

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
)

// NAVTEXDecoder implements the NAVTEX decoder
type NAVTEXDecoder struct {
	// Configuration
	sampleRate      int
	centerFrequency float64
	shift           float64
	baudRate        float64
	inverted        bool
	framing         string
	encoding        string

	// FSK decoder
	fsk *FSKDecoder

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
}

// NAVTEXConfig contains configuration parameters
type NAVTEXConfig struct {
	CenterFrequency float64 `json:"center_frequency"` // Hz (e.g., 500)
	Shift           float64 `json:"shift"`            // Hz (e.g., 170)
	BaudRate        float64 `json:"baud_rate"`        // Baud (e.g., 100)
	Inverted        bool    `json:"inverted"`         // Invert mark/space
	Framing         string  `json:"framing"`          // "4/7" for NAVTEX
	Encoding        string  `json:"encoding"`         // "CCIR476" for NAVTEX
}

// DefaultNAVTEXConfig returns default NAVTEX configuration
func DefaultNAVTEXConfig() NAVTEXConfig {
	return NAVTEXConfig{
		CenterFrequency: 500.0,
		Shift:           170.0,
		BaudRate:        100.0,
		Inverted:        false,
		Framing:         "4/7",
		Encoding:        "CCIR476",
	}
}

// NewNAVTEXDecoder creates a new NAVTEX decoder
func NewNAVTEXDecoder(sampleRate int, config NAVTEXConfig) *NAVTEXDecoder {
	d := &NAVTEXDecoder{
		sampleRate:      sampleRate,
		centerFrequency: config.CenterFrequency,
		shift:           config.Shift,
		baudRate:        config.BaudRate,
		inverted:        config.Inverted,
		framing:         config.Framing,
		encoding:        config.Encoding,
		stopChan:        make(chan struct{}),
	}

	// Create FSK decoder
	d.fsk = NewFSKDecoder(
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

	log.Printf("[NAVTEX] Initialized: SR=%d, CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Encoding=%s",
		sampleRate, config.CenterFrequency, config.Shift, config.BaudRate, config.Encoding)

	return d
}

// Start begins processing audio samples
func (d *NAVTEXDecoder) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
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
func (d *NAVTEXDecoder) Stop() error {
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
func (d *NAVTEXDecoder) GetName() string {
	return "navtex"
}

// processLoop is the main processing loop
func (d *NAVTEXDecoder) processLoop(audioChan <-chan []int16, resultChan chan<- []byte) {
	defer d.wg.Done()

	// Periodic text flush ticker (every 100ms)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	// Periodic baud error ticker (every 500ms)
	baudTicker := time.NewTicker(500 * time.Millisecond)
	defer baudTicker.Stop()

	for {
		select {
		case <-d.stopChan:
			return

		case samples, ok := <-audioChan:
			if !ok {
				return
			}
			// Process audio samples through FSK decoder
			d.fsk.ProcessSamples(samples)

		case <-ticker.C:
			// Flush text buffer periodically
			d.flushTextBuffer(resultChan)

		case <-baudTicker.C:
			// Send baud error update
			d.sendBaudError(resultChan)
		}
	}
}

// flushTextBuffer sends accumulated text to the client
func (d *NAVTEXDecoder) flushTextBuffer(resultChan chan<- []byte) {
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
func (d *NAVTEXDecoder) sendTextMessage(resultChan chan<- []byte, text string) {
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
func (d *NAVTEXDecoder) sendBaudError(resultChan chan<- []byte) {
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
