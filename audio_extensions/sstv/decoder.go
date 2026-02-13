package sstv

import (
	"encoding/binary"
	"fmt"
	"log"
	"sync"
)

/*
 * SSTV Decoder - Main Orchestration
 * Based on slowrx by Oona Räisänen (OH2EIQ)
 * Simplified flow: VIS detection -> Video demodulation -> Optional sync correction -> Optional FSK ID
 */

// DecoderState represents the current state of the decoder
type DecoderState int

const (
	StateInit DecoderState = iota
	StateWaitingVIS
	StateDecodingVideo
	StateFeedingVideo
	StateComplete
)

// SSTVDecoder is the main SSTV decoder
type SSTVDecoder struct {
	sampleRate float64
	state      DecoderState

	// Components
	visDetector   *VISDetector
	videoDemod    *VideoDemodulator
	syncCorrector *SyncCorrector
	fskDecoder    *FSKDecoder

	// Current mode
	mode        *ModeSpec
	headerShift int

	// Control
	running  bool
	stopChan chan struct{}
	mu       sync.Mutex
	wg       sync.WaitGroup

	// Configuration
	config SSTVConfig
}

// SSTVConfig contains decoder configuration
type SSTVConfig struct {
	AutoSync    bool // Automatically perform sync detection and slant correction
	DecodeFSKID bool // Decode FSK callsign after image
	Adaptive    bool // Use adaptive windowing based on SNR
}

// DefaultSSTVConfig returns default configuration
func DefaultSSTVConfig() SSTVConfig {
	return SSTVConfig{
		AutoSync:    true,
		DecodeFSKID: true,
		Adaptive:    true,
	}
}

// NewSSTVDecoder creates a new SSTV decoder
func NewSSTVDecoder(sampleRate float64, config SSTVConfig) *SSTVDecoder {
	return &SSTVDecoder{
		sampleRate: sampleRate,
		state:      StateInit,
		config:     config,
		stopChan:   make(chan struct{}),
	}
}

// Start begins the decoding process
func (d *SSTVDecoder) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	d.mu.Lock()
	if d.running {
		d.mu.Unlock()
		return fmt.Errorf("decoder already running")
	}
	d.running = true
	d.mu.Unlock()

	d.wg.Add(1)
	go d.decodeLoop(audioChan, resultChan)

	return nil
}

// Stop stops the decoder
func (d *SSTVDecoder) Stop() error {
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
func (d *SSTVDecoder) GetName() string {
	return "sstv"
}

// decodeLoop is the main decoding loop
func (d *SSTVDecoder) decodeLoop(audioChan <-chan []int16, resultChan chan<- []byte) {
	defer d.wg.Done()

	// Create sliding window PCM buffer
	// VIS pattern is ~450ms, need buffer large enough to hold it plus margin
	// Use 16384 samples (~1.37 seconds at 12kHz) to ensure VIS pattern fits comfortably
	const pcmBufSize = 16384
	pcmBuffer := NewSlidingPCMBuffer(pcmBufSize)

	// Send initial status
	d.sendStatus(resultChan, "Waiting for signal...")

	// Wait for initial buffer fill
	// slowrx fills entire buffer first, then sets WindowPtr to middle
	log.Printf("[SSTV] Waiting for initial buffer fill...")

	// Fill buffer initially
	for pcmBuffer.GetWindowPtr() == 0 {
		select {
		case <-d.stopChan:
			return
		case samples, ok := <-audioChan:
			if !ok {
				return
			}
			pcmBuffer.Write(samples)
		}
	}

	log.Printf("[SSTV] Buffer filled, WindowPtr=%d, starting VIS detection", pcmBuffer.GetWindowPtr())

	// Main processing loop - accumulate samples to 10ms chunks like slowrx
	// slowrx processes exactly 441 samples (10ms at 44.1kHz) per iteration
	// We need to process exactly 120 samples (10ms at 12kHz) per iteration
	samps10ms := int(d.sampleRate * 10e-3)
	accumulator := make([]int16, 0, samps10ms*2)

	log.Printf("[SSTV] Processing in %d sample chunks (10ms at %.0f Hz)", samps10ms, d.sampleRate)

	for {
		select {
		case <-d.stopChan:
			return

		case samples, ok := <-audioChan:
			if !ok {
				log.Printf("[SSTV Main] audioChan closed, exiting decode loop")
				return
			}

			// Accumulate samples
			accumulator = append(accumulator, samples...)

			// Process in 10ms chunks
			for len(accumulator) >= samps10ms {
				// Take exactly 10ms worth of samples
				chunk := accumulator[:samps10ms]
				accumulator = accumulator[samps10ms:]

				// Write to buffer (like slowrx readPcm)
				pcmBuffer.Write(chunk)

				// Process based on current state
				switch d.state {
				case StateInit, StateWaitingVIS:
					// Try to detect VIS code
					if err := d.detectVIS(pcmBuffer, resultChan); err == nil {
						log.Printf("[SSTV] VIS detected, transitioning to video decoding")
						d.state = StateDecodingVideo
					}
					// VIS not found yet, will try again on next 10ms chunk
					// Log occasionally to show we're still running
					if d.visDetector != nil && d.visDetector.iterationCount%500 == 0 {
						log.Printf("[SSTV] Main loop: Still waiting for VIS (iteration %d, buffer=%d)",
							d.visDetector.iterationCount, pcmBuffer.Available())
					}

				case StateDecodingVideo:
					// Start video decoding in background, then immediately switch to feeding state
					// This allows main loop to continue feeding buffer while video decodes
					log.Printf("[SSTV Main] Launching video decoder goroutine, buffer has %d samples", pcmBuffer.Available())
					go func() {
						// Recover from panics (e.g., send on closed channel if user detaches)
						defer func() {
							if r := recover(); r != nil {
								log.Printf("[SSTV Video Goroutine] Recovered from panic: %v", r)
							}
							// Always reset state
							log.Printf("[SSTV Main] Video decode goroutine finished, resetting state")
							d.state = StateWaitingVIS
							pcmBuffer.Reset()
							// Reset VIS detector to clear internal state and prevent false detections
							d.visDetector = nil
						}()

						if err := d.decodeVideo(pcmBuffer, resultChan); err != nil {
							log.Printf("[SSTV] Video decoding failed: %v", err)
						} else {
							log.Printf("[SSTV] Video decoding complete")

							// Optionally decode FSK ID
							if d.config.DecodeFSKID {
								d.decodeFSKID(pcmBuffer, resultChan)
							}
						}
					}()

					// Switch to feeding state so main loop continues
					d.state = StateFeedingVideo
					log.Printf("[SSTV Main] Switched to StateFeedingVideo, main loop will continue feeding")

				case StateFeedingVideo:
					// Buffer is already written at line 179
					// Just continue feeding silently
				}
			}
		}
	}
}

// detectVIS attempts to detect VIS code
func (d *SSTVDecoder) detectVIS(pcmBuffer *SlidingPCMBuffer, resultChan chan<- []byte) error {
	// Create VIS detector if not exists
	if d.visDetector == nil {
		log.Printf("[SSTV] Creating VIS detector with sample rate %.1f Hz", d.sampleRate)
		d.visDetector = NewVISDetector(d.sampleRate)
	}

	// Try to detect VIS
	modeIdx, headerShift, _, ok := d.visDetector.DetectVISStreaming(pcmBuffer)
	if !ok {
		return fmt.Errorf("VIS not found yet")
	}

	// Get mode specification
	d.mode = GetModeByIndex(modeIdx)
	if d.mode == nil {
		return fmt.Errorf("invalid mode index: %d", modeIdx)
	}

	d.headerShift = headerShift

	// Check if mode is supported
	if d.mode.Unsupported {
		d.sendStatus(resultChan, fmt.Sprintf("Mode not supported: %s", d.mode.Name))
		return fmt.Errorf("mode not supported: %s", d.mode.Name)
	}

	log.Printf("[SSTV] Detected mode: %s (%dx%d)", d.mode.Name, d.mode.ImgWidth, d.mode.NumLines)

	// Send mode detection message
	d.sendModeDetected(resultChan, modeIdx)

	// Send image start message with dimensions
	d.sendImageStart(resultChan)

	return nil
}

// decodeVideo decodes the video signal
// Note: This function is called from a goroutine, and the main loop continues feeding the buffer
func (d *SSTVDecoder) decodeVideo(pcmBuffer *SlidingPCMBuffer, resultChan chan<- []byte) error {
	log.Printf("[SSTV Video Goroutine] Starting video demodulation, buffer has %d samples", pcmBuffer.Available())

	d.sendStatus(resultChan, fmt.Sprintf("Decoding %s...", d.mode.Name))

	// Create video demodulator
	d.videoDemod = NewVideoDemodulator(d.mode, d.sampleRate, d.headerShift, d.config.Adaptive)

	// Initial decode without sync correction
	rate := d.sampleRate
	skip := 0

	// Demodulate video from buffer with progressive line sending
	// The main loop continues to feed the buffer while we consume from it
	log.Printf("[SSTV Video Goroutine] Calling Demodulate(), buffer has %d samples", pcmBuffer.Available())

	// Create line sender callback to send lines as they're completed
	lineSender := func(lineNum int, lineData []uint8) {
		// Create message: [type:1][line:4][width:4][rgb_data:width*3]
		msg := make([]byte, 1+4+4+len(lineData))
		msg[0] = MsgTypeImageLine
		binary.BigEndian.PutUint32(msg[1:5], uint32(lineNum))
		binary.BigEndian.PutUint32(msg[5:9], uint32(d.mode.ImgWidth))
		copy(msg[9:], lineData)

		select {
		case resultChan <- msg:
		default:
			// Channel full or closed, skip this line
		}
	}

	_, err := d.videoDemod.Demodulate(pcmBuffer, rate, skip, lineSender)
	log.Printf("[SSTV Video Goroutine] Demodulate() returned, err=%v", err)
	if err != nil {
		return fmt.Errorf("video demodulation failed: %w", err)
	}

	// All lines have been sent progressively, no need to send again
	log.Printf("[SSTV] Video demodulation complete, all lines sent progressively")

	// Send initial completion
	d.sendComplete(resultChan)

	// Perform sync detection and slant correction if enabled
	if d.config.AutoSync {
		log.Printf("[SSTV] Performing sync detection and slant correction...")
		d.sendStatus(resultChan, "Correcting slant...")

		// Create sync corrector
		d.syncCorrector = NewSyncCorrector(d.mode, d.sampleRate, d.videoDemod.hasSync)

		// Find slant and adjust
		adjustedRate, adjustedSkip := d.syncCorrector.FindSync()

		log.Printf("[SSTV] Redrawing with corrected parameters: rate=%.1f Hz, skip=%d", adjustedRate, adjustedSkip)

		// Redraw from stored luminance with corrected parameters
		correctedPixels := d.videoDemod.RedrawFromLuminance(adjustedRate, adjustedSkip)

		// Signal that corrected image is coming
		d.sendRedrawStart(resultChan)

		// Send corrected image data
		log.Printf("[SSTV] Sending corrected image...")
		d.sendImageData(resultChan, correctedPixels)

		// Send final completion
		d.sendComplete(resultChan)
	}

	return nil
}

// decodeFSKID decodes FSK ID
func (d *SSTVDecoder) decodeFSKID(pcmBuffer *SlidingPCMBuffer, resultChan chan<- []byte) {
	log.Printf("[SSTV] Attempting FSK ID decode...")

	d.fskDecoder = NewFSKDecoder(d.sampleRate, d.headerShift)
	callsign := d.fskDecoder.DecodeFSKID(pcmBuffer)

	if callsign != "" {
		d.sendFSKID(resultChan, callsign)
	}
}

// Binary protocol message types
const (
	MsgTypeImageLine    = 0x01
	MsgTypeModeDetected = 0x02
	MsgTypeStatus       = 0x03
	MsgTypeSyncDetected = 0x04
	MsgTypeComplete     = 0x05
	MsgTypeFSKID        = 0x06
	MsgTypeImageStart   = 0x07
	MsgTypeRedrawStart  = 0x08 // Signals start of corrected image redraw
	MsgTypeToneFreq     = 0x09 // Current detected tone frequency
)

// sendImageStart sends image start message with dimensions
func (d *SSTVDecoder) sendImageStart(resultChan chan<- []byte) {
	m := d.mode
	msg := make([]byte, 9)

	msg[0] = MsgTypeImageStart
	binary.BigEndian.PutUint32(msg[1:5], uint32(m.ImgWidth))
	binary.BigEndian.PutUint32(msg[5:9], uint32(m.NumLines))

	select {
	case resultChan <- msg:
	default:
	}
}

// sendModeDetected sends mode detection message
func (d *SSTVDecoder) sendModeDetected(resultChan chan<- []byte, modeIdx uint8) {
	nameBytes := []byte(d.mode.Name)
	msg := make([]byte, 4+len(nameBytes))

	msg[0] = MsgTypeModeDetected
	msg[1] = modeIdx
	msg[2] = 0 // extended flag (always 0 for slowrx modes)
	msg[3] = uint8(len(nameBytes))
	copy(msg[4:], nameBytes)

	select {
	case resultChan <- msg:
	default:
	}
}

// sendStatus sends a status update message
func (d *SSTVDecoder) sendStatus(resultChan chan<- []byte, status string) {
	statusBytes := []byte(status)
	msg := make([]byte, 4+len(statusBytes))

	msg[0] = MsgTypeStatus
	msg[1] = 0 // Status code
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(statusBytes)))
	copy(msg[4:], statusBytes)

	select {
	case resultChan <- msg:
	default:
	}
}

// sendImageData sends image data line by line
func (d *SSTVDecoder) sendImageData(resultChan chan<- []byte, pixels []uint8) {
	m := d.mode

	for y := 0; y < m.NumLines; y++ {
		// Extract line data
		lineOffset := y * m.ImgWidth * 3
		lineData := pixels[lineOffset : lineOffset+m.ImgWidth*3]

		// Create message: [type:1][line:4][width:4][rgb_data:width*3]
		msg := make([]byte, 1+4+4+len(lineData))
		msg[0] = MsgTypeImageLine
		binary.BigEndian.PutUint32(msg[1:5], uint32(y))
		binary.BigEndian.PutUint32(msg[5:9], uint32(m.ImgWidth))
		copy(msg[9:], lineData)

		select {
		case resultChan <- msg:
		default:
			// Channel full, skip this line
		}
	}
}

// sendFSKID sends FSK callsign message
func (d *SSTVDecoder) sendFSKID(resultChan chan<- []byte, callsign string) {
	callsignBytes := []byte(callsign)
	msg := make([]byte, 2+len(callsignBytes))

	msg[0] = MsgTypeFSKID
	msg[1] = uint8(len(callsignBytes))
	copy(msg[2:], callsignBytes)

	select {
	case resultChan <- msg:
	default:
	}
}

// sendComplete sends completion message
func (d *SSTVDecoder) sendComplete(resultChan chan<- []byte) {
	msg := make([]byte, 5)
	msg[0] = MsgTypeComplete
	binary.BigEndian.PutUint32(msg[1:5], uint32(d.mode.NumLines))

	select {
	case resultChan <- msg:
	default:
	}
}

// sendRedrawStart signals that corrected image redraw is starting
func (d *SSTVDecoder) sendRedrawStart(resultChan chan<- []byte) {
	msg := make([]byte, 1)
	msg[0] = MsgTypeRedrawStart

	select {
	case resultChan <- msg:
	default:
	}

	log.Printf("[SSTV] Sent redraw start signal")
}
