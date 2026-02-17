package morse

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
)

const (
	MaxDecoders = 5 // Maximum number of simultaneous decoders
)

// MultiChannelDecoder manages multiple parallel Morse decoders
type MultiChannelDecoder struct {
	// Configuration
	sampleRate   int
	minWPM       float64
	maxWPM       float64
	thresholdSNR float64
	bandwidth    float64

	// Channel frequencies (user-specified)
	channelFrequencies [MaxDecoders]float64

	// Decoder slots
	decoders   []*DecoderSlot
	decodersMu sync.RWMutex

	// Control
	running  bool
	mu       sync.Mutex
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// DecoderSlot represents one decoder instance
type DecoderSlot struct {
	ID           int
	Decoder      *MorseDecoder
	Frequency    float64
	LastActivity time.Time
	Active       bool
	mu           sync.Mutex
}

// NewMultiChannelDecoder creates a new multi-channel decoder
func NewMultiChannelDecoder(sampleRate int, config MorseConfig, channelFreqs [MaxDecoders]float64) *MultiChannelDecoder {
	mcd := &MultiChannelDecoder{
		sampleRate:         sampleRate,
		minWPM:             config.MinWPM,
		maxWPM:             config.MaxWPM,
		thresholdSNR:       config.ThresholdSNR,
		bandwidth:          config.Bandwidth,
		channelFrequencies: channelFreqs,
		decoders:           make([]*DecoderSlot, MaxDecoders),
		stopChan:           make(chan struct{}),
	}

	// Initialize decoder slots
	for i := 0; i < MaxDecoders; i++ {
		mcd.decoders[i] = &DecoderSlot{
			ID:     i,
			Active: false,
		}
	}

	log.Printf("[Multi-Morse] Initialized: %d decoders, SNR threshold %.1f dB",
		MaxDecoders, config.ThresholdSNR)

	// Create decoders for non-zero frequencies
	for i := 0; i < MaxDecoders; i++ {
		if channelFreqs[i] > 0 {
			mcd.activateChannelAtFrequency(i, channelFreqs[i])
		}
	}

	return mcd
}

// Start begins processing audio samples
func (mcd *MultiChannelDecoder) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	mcd.mu.Lock()
	if mcd.running {
		mcd.mu.Unlock()
		return fmt.Errorf("multi-decoder already running")
	}
	mcd.running = true
	mcd.mu.Unlock()

	mcd.wg.Add(1)
	go mcd.processLoop(audioChan, resultChan)

	return nil
}

// Stop stops all decoders
func (mcd *MultiChannelDecoder) Stop() error {
	mcd.mu.Lock()
	if !mcd.running {
		mcd.mu.Unlock()
		return nil
	}
	mcd.mu.Unlock()

	close(mcd.stopChan)
	mcd.wg.Wait()

	// Stop all active decoders
	mcd.decodersMu.Lock()
	for _, slot := range mcd.decoders {
		if slot.Active && slot.Decoder != nil {
			_ = slot.Decoder.Stop()
		}
	}
	mcd.decodersMu.Unlock()

	mcd.mu.Lock()
	mcd.running = false
	mcd.mu.Unlock()

	return nil
}

// GetName returns the decoder name
func (mcd *MultiChannelDecoder) GetName() string {
	return "morse_multi"
}

// processLoop is the main processing loop
func (mcd *MultiChannelDecoder) processLoop(audioChan <-chan []int16, resultChan chan<- []byte) {
	defer mcd.wg.Done()

	// Ticker for status updates
	statusTicker := time.NewTicker(5 * time.Second)
	defer statusTicker.Stop()

	for {
		select {
		case <-mcd.stopChan:
			return

		case samples, ok := <-audioChan:
			if !ok {
				return
			}
			mcd.processSamples(samples, resultChan)

		case <-statusTicker.C:
			// Send status update
			mcd.sendStatusUpdate(resultChan)
		}
	}
}

// processSamples processes audio samples through active decoders
func (mcd *MultiChannelDecoder) processSamples(samples []int16, resultChan chan<- []byte) {
	// Feed samples to all active decoders
	mcd.decodersMu.RLock()
	for _, slot := range mcd.decoders {
		if slot.Active && slot.Decoder != nil {
			// Process samples through decoder
			slot.Decoder.processSamples(samples)
		}
	}
	mcd.decodersMu.RUnlock()

	// Check for word separators and flush buffers periodically
	mcd.decodersMu.RLock()
	for _, slot := range mcd.decoders {
		if slot.Active && slot.Decoder != nil {
			slot.Decoder.checkWordSeparator()
			slot.Decoder.flushBuffers(resultChan, slot.ID)
		}
	}
	mcd.decodersMu.RUnlock()
}

// activateChannelAtFrequency activates a decoder channel at a specific frequency
func (mcd *MultiChannelDecoder) activateChannelAtFrequency(channelID int, frequency float64) {
	if channelID < 0 || channelID >= MaxDecoders {
		return
	}

	slot := mcd.decoders[channelID]
	slot.mu.Lock()
	defer slot.mu.Unlock()

	// Stop existing decoder if any
	if slot.Decoder != nil {
		_ = slot.Decoder.Stop()
	}

	// Create new decoder for this frequency
	config := MorseConfig{
		CenterFrequency: frequency,
		Bandwidth:       mcd.bandwidth,
		MinWPM:          mcd.minWPM,
		MaxWPM:          mcd.maxWPM,
		ThresholdSNR:    mcd.thresholdSNR,
	}

	decoder := NewMorseDecoder(mcd.sampleRate, config)
	decoder.decoderID = slot.ID

	slot.Decoder = decoder
	slot.Frequency = frequency
	slot.LastActivity = time.Now()
	slot.Active = true

	log.Printf("[Multi-Morse] Channel %d activated at %.1f Hz", slot.ID, frequency)
}

// manageDecoders is no longer needed with manual frequency control
// Channels stay active at their assigned frequencies
func (mcd *MultiChannelDecoder) manageDecoders(resultChan chan<- []byte) {
	// No-op: channels are manually controlled
}

// sendDecoderAssignment sends decoder assignment/removal message
// Binary protocol: [type:1][decoder_id:1][frequency:8][active:1]
// type: 0x04 = decoder assignment
func (mcd *MultiChannelDecoder) sendDecoderAssignment(resultChan chan<- []byte, decoderID int, frequency float64, active bool) {
	msg := make([]byte, 1+1+8+1)
	msg[0] = 0x04 // Decoder assignment type
	msg[1] = byte(decoderID)
	binary.BigEndian.PutUint64(msg[2:10], math.Float64bits(frequency))
	if active {
		msg[10] = 1
	} else {
		msg[10] = 0
	}

	select {
	case resultChan <- msg:
	default:
	}
}

// sendStatusUpdate sends status of all decoders
// Binary protocol: [type:1][num_active:1][decoder_data...]
// decoder_data: [id:1][frequency:8][wpm:8][snr:8] repeated for each active decoder
// type: 0x05 = status update
func (mcd *MultiChannelDecoder) sendStatusUpdate(resultChan chan<- []byte) {
	mcd.decodersMu.RLock()
	defer mcd.decodersMu.RUnlock()

	// Count active decoders
	numActive := 0
	for _, slot := range mcd.decoders {
		if slot.Active {
			numActive++
		}
	}

	// Build message
	msg := make([]byte, 2+numActive*25) // 2 header + 25 bytes per decoder (id:1 + freq:8 + wpm:8 + snr:8)
	msg[0] = 0x05                       // Status update type
	msg[1] = byte(numActive)

	offset := 2
	for _, slot := range mcd.decoders {
		if slot.Active {
			msg[offset] = byte(slot.ID)
			binary.BigEndian.PutUint64(msg[offset+1:offset+9], math.Float64bits(slot.Frequency))

			wpm := 0.0
			snr := 0.0
			if slot.Decoder != nil {
				wpm = slot.Decoder.currentWPM
				slot.Decoder.snrMu.Lock()
				snr = slot.Decoder.peakSNR
				slot.Decoder.snrMu.Unlock()
			}
			binary.BigEndian.PutUint64(msg[offset+9:offset+17], math.Float64bits(wpm))
			binary.BigEndian.PutUint64(msg[offset+17:offset+25], math.Float64bits(snr))

			offset += 25
		}
	}

	select {
	case resultChan <- msg:
	default:
	}
}
