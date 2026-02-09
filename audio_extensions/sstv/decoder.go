package sstv

import (
	"encoding/binary"
	"fmt"
	"log"
	"sync"
)

/*
 * SSTV Decoder - Main Orchestration
 * Ported from KiwiSDR/extensions/SSTV/sstv.cpp
 *
 * Original copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)
 * Go port (c) 2026, UberSDR project
 */

// DecoderState represents the current state of the decoder
type DecoderState int

const (
	StateInit DecoderState = iota
	StateWaitingVIS
	StateDecodingVideo
	StateComplete
)

// SSTVDecoder is the main SSTV decoder
type SSTVDecoder struct {
	sampleRate float64
	state      DecoderState

	// Components
	visDetector  *VISDetector
	videoDemod   *VideoDemodulator
	syncDetector *SyncDetector
	fskDecoder   *FSKDecoder

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

	// State tracking
	visLoggedOnce bool
}

// SSTVConfig contains decoder configuration
type SSTVConfig struct {
	AutoSync    bool // Automatically perform sync detection and slant correction
	DecodeFSKID bool // Decode FSK callsign after image
	MMSSVOnly   bool // Only decode MMSSTV modes
}

// DefaultSSTVConfig returns default configuration
func DefaultSSTVConfig() SSTVConfig {
	return SSTVConfig{
		AutoSync:    true,
		DecodeFSKID: true,
		MMSSVOnly:   false,
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

	// Create PCM buffer that accumulates audio samples
	pcmBuffer := make([]int16, 0, 1000000) // 1M samples buffer

	// Send initial status
	d.sendStatus(resultChan, "Waiting for signal...")

	for {
		select {
		case <-d.stopChan:
			return

		case samples, ok := <-audioChan:
			if !ok {
				return
			}

			// Accumulate samples
			pcmBuffer = append(pcmBuffer, samples...)

			// Process based on state
			switch d.state {
			case StateInit, StateWaitingVIS:
				// Try to detect VIS code if we have enough samples
				// VIS detection needs ~1 second of audio
				if len(pcmBuffer) >= int(d.sampleRate) {
					if err := d.detectVISFromBuffer(pcmBuffer, resultChan); err == nil {
						// VIS detected, move to video decoding
						d.state = StateDecodingVideo
						d.visLoggedOnce = false // Reset for next image
					}
					// Keep accumulating if VIS not found yet
					// Don't spam logs - VIS detection will log when it finds something
				}

			case StateDecodingVideo:
				// Check if we have enough samples for the full image
				m := d.mode
				requiredSamples := int(m.LineTime * float64(m.NumLines) * d.sampleRate * 1.1) // 10% extra

				if len(pcmBuffer) >= requiredSamples {
					// Decode video
					if err := d.decodeVideoFromBuffer(pcmBuffer, resultChan); err != nil {
						log.Printf("[SSTV] Video decoding failed: %v", err)
						d.state = StateWaitingVIS
						pcmBuffer = pcmBuffer[:0] // Clear buffer
						continue
					}

					// Optionally decode FSK ID (needs more samples)
					if d.config.DecodeFSKID {
						// FSK ID needs additional ~2 seconds
						fskSamples := int(d.sampleRate * 2)
						if len(pcmBuffer) >= requiredSamples+fskSamples {
							d.decodeFSKIDFromBuffer(pcmBuffer[requiredSamples:], resultChan)
						}
					}

					// Reset for next image
					d.state = StateWaitingVIS
					pcmBuffer = pcmBuffer[:0] // Clear buffer
				}
			}

			// Prevent buffer from growing too large
			if len(pcmBuffer) > 2000000 { // 2M samples max
				// Keep only last 1M samples
				pcmBuffer = pcmBuffer[len(pcmBuffer)-1000000:]
			}
		}
	}
}

// detectVISFromBuffer attempts to detect VIS from accumulated buffer
func (d *SSTVDecoder) detectVISFromBuffer(pcmBuffer []int16, resultChan chan<- []byte) error {
	// Log only once to avoid spam
	if !d.visLoggedOnce {
		log.Printf("[SSTV] Waiting for VIS code (have %d samples, need ~%d)...",
			len(pcmBuffer), int(d.sampleRate))
		d.visLoggedOnce = true
	}

	// Create a proper buffer reader with windowing support
	reader := newBufferPCMReader(pcmBuffer)

	// Create VIS detector
	d.visDetector = NewVISDetector(d.sampleRate)

	// Set tone frequency callback to send updates to frontend
	d.visDetector.SetToneCallback(func(freq float64) {
		d.sendToneFreq(resultChan, freq)
	})

	// Try to detect VIS
	modeIdx, headerShift, isExtended, ok := d.visDetector.DetectVIS(reader)
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

	// Check MMSSTV-only filter
	if d.config.MMSSVOnly {
		if modeIdx < ModeMR73 || modeIdx > ModeMP175 {
			d.sendStatus(resultChan, fmt.Sprintf("Skipping non-MMSSTV mode: %s", d.mode.Name))
			return fmt.Errorf("non-MMSSTV mode filtered")
		}
	}

	log.Printf("[SSTV] Detected mode: %s (%dx%d)", d.mode.Name, d.mode.ImgWidth, d.mode.NumLines)

	// Send mode detection message
	d.sendModeDetected(resultChan, modeIdx, isExtended)

	// Send image start message with dimensions
	d.sendImageStart(resultChan)

	return nil
}

// decodeVideoFromBuffer decodes video from accumulated buffer
func (d *SSTVDecoder) decodeVideoFromBuffer(pcmBuffer []int16, resultChan chan<- []byte) error {
	log.Printf("[SSTV] Starting video demodulation from buffer...")

	d.sendStatus(resultChan, fmt.Sprintf("Decoding %s...", d.mode.Name))

	// Create video demodulator
	d.videoDemod = NewVideoDemodulator(d.mode, d.sampleRate, d.headerShift)

	// Initial decode without sync correction - SEND IN REAL-TIME
	skip := 0
	pixels, err := d.videoDemod.DemodulateVideo(pcmBuffer, skip, false)
	if err != nil {
		return fmt.Errorf("video demodulation failed: %w", err)
	}

	// Send uncorrected image data line by line (real-time view)
	log.Printf("[SSTV] Sending real-time uncorrected image...")
	d.sendImageData(resultChan, pixels)

	// Send initial completion (uncorrected image done)
	d.sendComplete(resultChan)

	// Perform sync detection and slant correction if enabled
	if d.config.AutoSync {
		log.Printf("[SSTV] Performing sync detection and slant correction...")
		d.sendStatus(resultChan, "Correcting slant...")

		// Create sync detector
		d.syncDetector = NewSyncDetector(d.mode, d.sampleRate, d.videoDemod.hasSync)

		// Find slant and adjust
		adjustedRate, adjustedSkip := d.syncDetector.FindSlantAndAdjust()

		// Re-create video demodulator with adjusted rate
		d.videoDemod = NewVideoDemodulator(d.mode, adjustedRate, d.headerShift)

		// Re-decode with corrected parameters
		correctedPixels, err := d.videoDemod.DemodulateVideo(pcmBuffer, adjustedSkip, true)
		if err != nil {
			return fmt.Errorf("video re-demodulation failed: %w", err)
		}

		// Signal that corrected image is coming
		d.sendRedrawStart(resultChan)

		// Send corrected image data
		log.Printf("[SSTV] Sending corrected image...")
		d.sendImageData(resultChan, correctedPixels)

		// Send final completion (corrected image done)
		d.sendComplete(resultChan)
	}

	return nil
}

// decodeFSKIDFromBuffer decodes FSK ID from buffer
func (d *SSTVDecoder) decodeFSKIDFromBuffer(pcmBuffer []int16, resultChan chan<- []byte) {
	log.Printf("[SSTV] Attempting FSK ID decode from buffer...")

	reader := &simpleBufferReader{buffer: pcmBuffer, pos: 0}
	d.fskDecoder = NewFSKDecoder(d.sampleRate, d.headerShift)
	callsign := d.fskDecoder.DecodeFSKID(reader)

	if callsign != "" {
		d.sendFSKID(resultChan, callsign)
	}
}

// detectVIS detects the VIS code (old method - kept for compatibility)
func (d *SSTVDecoder) detectVIS(pcmReader *PCMBufferReader, resultChan chan<- []byte) error {
	log.Printf("[SSTV] Waiting for VIS code...")

	// Send status update
	d.sendStatus(resultChan, "Waiting for signal...")

	// Create VIS detector
	d.visDetector = NewVISDetector(d.sampleRate)

	// Detect VIS
	modeIdx, headerShift, isExtended, ok := d.visDetector.DetectVIS(pcmReader)
	if !ok {
		return fmt.Errorf("VIS detection failed")
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

	// Check MMSSTV-only filter
	if d.config.MMSSVOnly {
		if modeIdx < ModeMR73 || modeIdx > ModeMP175 {
			d.sendStatus(resultChan, fmt.Sprintf("Skipping non-MMSSTV mode: %s", d.mode.Name))
			return fmt.Errorf("non-MMSSTV mode filtered")
		}
	}

	log.Printf("[SSTV] Detected mode: %s (%dx%d)", d.mode.Name, d.mode.ImgWidth, d.mode.NumLines)

	// Send mode detection message
	d.sendModeDetected(resultChan, modeIdx, isExtended)

	// Send image start message with dimensions
	d.sendImageStart(resultChan)

	// Transition to video decoding
	d.state = StateDecodingVideo

	return nil
}

// decodeVideo decodes the video signal
func (d *SSTVDecoder) decodeVideo(pcmReader *PCMBufferReader, resultChan chan<- []byte) error {
	log.Printf("[SSTV] Starting video demodulation...")

	d.sendStatus(resultChan, fmt.Sprintf("Decoding %s...", d.mode.Name))

	// Create video demodulator
	d.videoDemod = NewVideoDemodulator(d.mode, d.sampleRate, d.headerShift)

	// Initial decode without sync correction - SEND IN REAL-TIME
	skip := 0
	pixels, err := d.videoDemod.DemodulateVideo(pcmReader.GetBuffer(), skip, false)
	if err != nil {
		return fmt.Errorf("video demodulation failed: %w", err)
	}

	// Send uncorrected image data line by line (real-time view)
	log.Printf("[SSTV] Sending real-time uncorrected image...")
	d.sendImageData(resultChan, pixels)

	// Send initial completion (uncorrected image done)
	d.sendComplete(resultChan)

	// Perform sync detection and slant correction if enabled
	if d.config.AutoSync {
		log.Printf("[SSTV] Performing sync detection and slant correction...")
		d.sendStatus(resultChan, "Correcting slant...")

		// Create sync detector
		d.syncDetector = NewSyncDetector(d.mode, d.sampleRate, d.videoDemod.hasSync)

		// Find slant and adjust
		adjustedRate, adjustedSkip := d.syncDetector.FindSlantAndAdjust()

		// Re-create video demodulator with adjusted rate
		d.videoDemod = NewVideoDemodulator(d.mode, adjustedRate, d.headerShift)

		// Re-decode with corrected parameters
		correctedPixels, err := d.videoDemod.DemodulateVideo(pcmReader.GetBuffer(), adjustedSkip, true)
		if err != nil {
			return fmt.Errorf("video re-demodulation failed: %w", err)
		}

		// Signal that corrected image is coming
		d.sendRedrawStart(resultChan)

		// Send corrected image data
		log.Printf("[SSTV] Sending corrected image...")
		d.sendImageData(resultChan, correctedPixels)

		// Send final completion (corrected image done)
		d.sendComplete(resultChan)
	}

	return nil
}

// decodeFSKID decodes the FSK callsign
func (d *SSTVDecoder) decodeFSKID(pcmReader *PCMBufferReader, resultChan chan<- []byte) {
	log.Printf("[SSTV] Attempting FSK ID decode...")

	d.fskDecoder = NewFSKDecoder(d.sampleRate, d.headerShift)
	callsign := d.fskDecoder.DecodeFSKID(pcmReader)

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
func (d *SSTVDecoder) sendModeDetected(resultChan chan<- []byte, modeIdx uint8, isExtended bool) {
	nameBytes := []byte(d.mode.Name)
	msg := make([]byte, 4+len(nameBytes))

	msg[0] = MsgTypeModeDetected
	msg[1] = modeIdx
	msg[2] = 0
	if isExtended {
		msg[2] = 1
	}
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

// sendToneFreq sends current detected tone frequency
func (d *SSTVDecoder) sendToneFreq(resultChan chan<- []byte, freq float64) {
	msg := make([]byte, 5)
	msg[0] = MsgTypeToneFreq
	// Send frequency as uint32 (Hz * 10 for 0.1 Hz precision)
	binary.BigEndian.PutUint32(msg[1:5], uint32(freq*10))

	select {
	case resultChan <- msg:
	default:
	}
}

// simpleBufferReader implements PCMReader for a static buffer
type simpleBufferReader struct {
	buffer []int16
	pos    int
}

// Read reads from the buffer
func (r *simpleBufferReader) Read(numSamples int) ([]int16, error) {
	if r.pos+numSamples > len(r.buffer) {
		return nil, fmt.Errorf("not enough samples in buffer")
	}

	result := r.buffer[r.pos : r.pos+numSamples]
	r.pos += numSamples
	return result, nil
}

// PCMBufferReader provides a buffered reader interface for PCM data (legacy)
type PCMBufferReader struct {
	audioChan <-chan []int16
	stopChan  <-chan struct{}
	buffer    []int16
	position  int
}

// NewPCMBufferReader creates a new PCM buffer reader (legacy)
func NewPCMBufferReader(audioChan <-chan []int16, stopChan <-chan struct{}) *PCMBufferReader {
	return &PCMBufferReader{
		audioChan: audioChan,
		stopChan:  stopChan,
		buffer:    make([]int16, 0),
		position:  0,
	}
}

// Read reads the specified number of samples (legacy - blocking)
func (r *PCMBufferReader) Read(numSamples int) ([]int16, error) {
	// Ensure we have enough data in buffer
	for len(r.buffer)-r.position < numSamples {
		select {
		case <-r.stopChan:
			return nil, fmt.Errorf("stopped")
		case samples, ok := <-r.audioChan:
			if !ok {
				return nil, fmt.Errorf("audio channel closed")
			}
			r.buffer = append(r.buffer, samples...)
		}
	}

	// Return requested samples
	result := r.buffer[r.position : r.position+numSamples]
	r.position += numSamples

	// Trim buffer if it gets too large
	if r.position > 100000 {
		r.buffer = r.buffer[r.position:]
		r.position = 0
	}

	return result, nil
}

// GetBuffer returns the entire buffer (legacy)
func (r *PCMBufferReader) GetBuffer() []int16 {
	return r.buffer
}

// bufferPCMReader implements PCMReader for a static buffer with proper windowing
type bufferPCMReader struct {
	buffer    []int16
	windowPtr int
	bufLen    int
}

// newBufferPCMReader creates a new buffer-based PCM reader
func newBufferPCMReader(buffer []int16) *bufferPCMReader {
	return &bufferPCMReader{
		buffer:    buffer,
		windowPtr: 0,
		bufLen:    len(buffer),
	}
}

// Read reads numSamples and advances the window pointer
// Returns only the requested window of samples, not the entire buffer
func (r *bufferPCMReader) Read(numSamples int) ([]int16, error) {
	if r.windowPtr+numSamples > r.bufLen {
		return nil, fmt.Errorf("not enough samples in buffer (need %d, have %d remaining)",
			numSamples, r.bufLen-r.windowPtr)
	}

	// Return only the requested window of samples
	result := r.buffer[r.windowPtr : r.windowPtr+numSamples]
	r.windowPtr += numSamples

	return result, nil
}
