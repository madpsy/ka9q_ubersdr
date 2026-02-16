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
	MaxDecoders        = 5   // Maximum number of simultaneous decoders
	DecoderMaxIdleSec  = 15  // Seconds before idle decoder is removed
	SpectrumUpdateRate = 0.1 // Seconds between spectrum updates
)

// MultiChannelDecoder manages multiple parallel Morse decoders
type MultiChannelDecoder struct {
	// Configuration
	sampleRate   int
	minFreq      float64
	maxFreq      float64
	minWPM       float64
	maxWPM       float64
	thresholdSNR float64
	bandwidth    float64

	// Spectrum analyzer
	spectrum *SpectrumAnalyzer

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
func NewMultiChannelDecoder(sampleRate int, config MorseConfig) *MultiChannelDecoder {
	// Use bandwidth to determine frequency range if not specified
	minFreq := config.CenterFrequency - 500 // Default: ±500 Hz around center
	maxFreq := config.CenterFrequency + 500

	mcd := &MultiChannelDecoder{
		sampleRate:   sampleRate,
		minFreq:      minFreq,
		maxFreq:      maxFreq,
		minWPM:       config.MinWPM,
		maxWPM:       config.MaxWPM,
		thresholdSNR: config.ThresholdSNR,
		bandwidth:    config.Bandwidth,
		decoders:     make([]*DecoderSlot, MaxDecoders),
		stopChan:     make(chan struct{}),
	}

	// Initialize spectrum analyzer
	mcd.spectrum = NewSpectrumAnalyzer(sampleRate, minFreq, maxFreq)

	// Initialize decoder slots
	for i := 0; i < MaxDecoders; i++ {
		mcd.decoders[i] = &DecoderSlot{
			ID:     i,
			Active: false,
		}
	}

	log.Printf("[Multi-Morse] Initialized: %d decoders, freq range %.0f-%.0f Hz, SNR threshold %.1f dB",
		MaxDecoders, minFreq, maxFreq, config.ThresholdSNR)

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

	// Ticker for decoder management
	managementTicker := time.NewTicker(1 * time.Second)
	defer managementTicker.Stop()

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

		case <-managementTicker.C:
			// Clean up idle decoders and reassign to new peaks
			mcd.manageDecoders(resultChan)

		case <-statusTicker.C:
			// Send status update
			mcd.sendStatusUpdate(resultChan)
		}
	}
}

// processSamples processes audio samples through spectrum analyzer and decoders
func (mcd *MultiChannelDecoder) processSamples(samples []int16, resultChan chan<- []byte) {
	for _, sample := range samples {
		// Convert to float and normalize
		floatSample := float64(sample) / 32768.0

		// Feed to spectrum analyzer
		if mcd.spectrum.ProcessSample(floatSample) {
			// Spectrum is ready, detect peaks
			peaks := mcd.spectrum.DetectPeaks(MaxDecoders, mcd.thresholdSNR)

			// Update decoder assignments based on peaks
			mcd.updateDecoderAssignments(peaks, resultChan)
		}

		// Feed sample to all active decoders
		mcd.decodersMu.RLock()
		for _, slot := range mcd.decoders {
			if slot.Active && slot.Decoder != nil {
				// Create envelope detector for this decoder's frequency
				// (In practice, each decoder has its own envelope detector)
				slot.Decoder.processSamples([]int16{int16(floatSample * 32768.0)})
			}
		}
		mcd.decodersMu.RUnlock()
	}
}

// updateDecoderAssignments assigns decoders to detected peaks
func (mcd *MultiChannelDecoder) updateDecoderAssignments(peaks []Peak, resultChan chan<- []byte) {
	mcd.decodersMu.Lock()
	defer mcd.decodersMu.Unlock()

	now := time.Now()

	// Match peaks to existing decoders (within bandwidth)
	for i, peak := range peaks {
		matched := false

		// Try to match with existing decoder
		for _, slot := range mcd.decoders {
			if slot.Active {
				freqDiff := peak.Frequency - slot.Frequency
				if freqDiff < 0 {
					freqDiff = -freqDiff
				}

				// If peak is close to existing decoder frequency, update it
				if freqDiff < mcd.bandwidth/2 {
					slot.LastActivity = now
					matched = true
					break
				}
			}
		}

		// If not matched, assign to free slot
		if !matched {
			for _, slot := range mcd.decoders {
				if !slot.Active {
					mcd.assignDecoder(slot, peak, resultChan)
					break
				}
			}
		}

		// Stop if we've assigned all available slots
		if i >= MaxDecoders-1 {
			break
		}
	}
}

// assignDecoder assigns a decoder slot to a specific frequency
func (mcd *MultiChannelDecoder) assignDecoder(slot *DecoderSlot, peak Peak, resultChan chan<- []byte) {
	slot.mu.Lock()
	defer slot.mu.Unlock()

	// Stop existing decoder if any
	if slot.Decoder != nil {
		_ = slot.Decoder.Stop()
	}

	// Create new decoder for this frequency
	config := MorseConfig{
		CenterFrequency: peak.Frequency,
		Bandwidth:       mcd.bandwidth,
		MinWPM:          mcd.minWPM,
		MaxWPM:          mcd.maxWPM,
		ThresholdSNR:    mcd.thresholdSNR,
	}

	slot.Decoder = NewMorseDecoder(mcd.sampleRate, config)
	slot.Frequency = peak.Frequency
	slot.LastActivity = time.Now()
	slot.Active = true

	log.Printf("[Multi-Morse] Decoder %d assigned to %.1f Hz (SNR: %.1f dB)",
		slot.ID, peak.Frequency, peak.SNR)

	// Send decoder assignment message
	mcd.sendDecoderAssignment(resultChan, slot.ID, peak.Frequency, true)
}

// manageDecoders removes idle decoders
func (mcd *MultiChannelDecoder) manageDecoders(resultChan chan<- []byte) {
	mcd.decodersMu.Lock()
	defer mcd.decodersMu.Unlock()

	now := time.Now()

	for _, slot := range mcd.decoders {
		if slot.Active {
			idleTime := now.Sub(slot.LastActivity).Seconds()

			if idleTime > DecoderMaxIdleSec {
				slot.mu.Lock()
				if slot.Decoder != nil {
					_ = slot.Decoder.Stop()
					slot.Decoder = nil
				}
				slot.Active = false
				slot.mu.Unlock()

				log.Printf("[Multi-Morse] Decoder %d removed (idle for %.1fs)", slot.ID, idleTime)

				// Send decoder removal message
				mcd.sendDecoderAssignment(resultChan, slot.ID, slot.Frequency, false)
			}
		}
	}
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
// decoder_data: [id:1][frequency:8][wpm:8] repeated for each active decoder
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
	msg := make([]byte, 2+numActive*17) // 2 header + 17 bytes per decoder
	msg[0] = 0x05                       // Status update type
	msg[1] = byte(numActive)

	offset := 2
	for _, slot := range mcd.decoders {
		if slot.Active {
			msg[offset] = byte(slot.ID)
			binary.BigEndian.PutUint64(msg[offset+1:offset+9], math.Float64bits(slot.Frequency))

			wpm := 0.0
			if slot.Decoder != nil {
				wpm = slot.Decoder.currentWPM
			}
			binary.BigEndian.PutUint64(msg[offset+9:offset+17], math.Float64bits(wpm))

			offset += 17
		}
	}

	select {
	case resultChan <- msg:
	default:
	}
}
