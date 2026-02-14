package ft8

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
)

/*
 * FT8 Decoder - Main Orchestration
 * Pure Go implementation for UberSDR
 * Based on ft8_lib by Karlis Goba (YL3JG) and WSJT-X
 */

// DecoderState represents the current state of the decoder
type DecoderState int

const (
	StateWaitingForSlot DecoderState = iota
	StateAccumulating
	StateDecoding
)

// FT8Decoder is the main FT8/FT4 decoder
type FT8Decoder struct {
	sampleRate int
	config     FT8Config
	state      DecoderState

	// Time synchronization
	slotStartTime time.Time
	slotNumber    uint64
	synced        bool

	// Sample buffer
	buffer         []float32
	samplesNeeded  int
	samplesPerSlot int

	// DSP components
	monitor *Monitor

	// Callsign hash table for resolving hashed callsigns
	hashTable *CallsignHashTable

	// Control
	running  bool
	stopChan chan struct{}
	mu       sync.Mutex
	wg       sync.WaitGroup
}

// DecodeResult represents a decoded FT8/FT4 message
type DecodeResult struct {
	Timestamp  int64   `json:"timestamp"`   // Unix timestamp (seconds)
	UTC        string  `json:"utc"`         // UTC time string "HH:MM:SS"
	SNR        float32 `json:"snr"`         // Signal-to-noise ratio (dB)
	DeltaT     float32 `json:"delta_t"`     // Time offset from slot start (seconds)
	Frequency  float32 `json:"frequency"`   // Audio frequency (Hz)
	Message    string  `json:"message"`     // Decoded message text
	Protocol   string  `json:"protocol"`    // "FT8" or "FT4"
	SlotNumber uint64  `json:"slot_number"` // Slot number since decoder start
	Score      int     `json:"score"`       // Sync score
}

// NewFT8Decoder creates a new FT8/FT4 decoder
func NewFT8Decoder(sampleRate int, config FT8Config) *FT8Decoder {
	slotTime := config.Protocol.GetSlotTime()
	samplesPerSlot := int(float64(sampleRate) * slotTime)

	// Active decoding period is slot time minus 0.4 seconds
	samplesNeeded := int(float64(sampleRate) * (slotTime - 0.4))

	// Create monitor for waterfall generation
	monitor := NewMonitor(sampleRate, FreqMin, FreqMax, TimeOSR, FreqOSR, config.Protocol)

	// Create callsign hash table (1 hour retention)
	hashTable := NewCallsignHashTable(1 * time.Hour)

	return &FT8Decoder{
		sampleRate:     sampleRate,
		config:         config,
		state:          StateWaitingForSlot,
		samplesPerSlot: samplesPerSlot,
		samplesNeeded:  samplesNeeded,
		buffer:         make([]float32, 0, samplesPerSlot),
		monitor:        monitor,
		hashTable:      hashTable,
		stopChan:       make(chan struct{}),
	}
}

// Start begins the decoding process
func (d *FT8Decoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
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
func (d *FT8Decoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.running = false
	d.mu.Unlock()

	close(d.stopChan)
	d.wg.Wait()
	return nil
}

// decodeLoop is the main processing loop
func (d *FT8Decoder) decodeLoop(audioChan <-chan AudioSample, resultChan chan<- []byte) {
	defer d.wg.Done()

	log.Printf("[FT8 Decoder] Starting decode loop for %s (sample rate: %d Hz, slot time: %.1f s)",
		d.config.Protocol.String(), d.sampleRate, d.config.Protocol.GetSlotTime())

	for {
		select {
		case <-d.stopChan:
			log.Printf("[FT8 Decoder] Stopped")
			return

		case sample, ok := <-audioChan:
			if !ok {
				log.Printf("[FT8 Decoder] Audio channel closed")
				return
			}

			// Process this audio sample
			d.processSample(sample, resultChan)
		}
	}
}

// processSample processes a single audio sample
func (d *FT8Decoder) processSample(sample AudioSample, resultChan chan<- []byte) {
	// Check if we need to sync to a time slot
	if !d.synced {
		if !d.syncToSlot(sample.GPSTimeNs) {
			return // Wait for slot boundary
		}
		// Reset monitor for new slot
		d.monitor.Reset()
	}

	// Convert int16 samples to float32 normalized to ±1.0
	for _, s := range sample.PCMData {
		d.buffer = append(d.buffer, float32(s)/32768.0)
	}

	// Process samples in blocks for waterfall generation
	blockSize := d.monitor.BlockSize
	for len(d.buffer) >= blockSize {
		// Extract one block
		block := d.buffer[:blockSize]
		d.buffer = d.buffer[blockSize:]

		// Process block through monitor (generates waterfall)
		d.monitor.Process(block)
	}

	// Check if we have accumulated enough blocks for decoding
	if d.monitor.Waterfall.NumBlocks >= d.config.Protocol.GetSymbolCount() {
		d.state = StateDecoding

		// Decode the accumulated waterfall
		results := d.decode()

		// Send results to client
		for _, result := range results {
			if data, err := json.Marshal(result); err == nil {
				select {
				case resultChan <- data:
				default:
					log.Printf("[FT8 Decoder] Result channel full, dropping decode")
				}
			}
		}

		// Reset for next slot
		d.buffer = d.buffer[:0]
		d.synced = false
		d.state = StateWaitingForSlot
		d.slotNumber++
	}
}

// syncToSlot synchronizes to the start of a time slot using GPS time
func (d *FT8Decoder) syncToSlot(gpsTimeNs int64) bool {
	// Convert GPS nanoseconds to seconds
	timeSec := float64(gpsTimeNs) / 1e9

	// Get slot period for this protocol
	slotPeriod := d.config.Protocol.GetSlotTime()

	// Calculate time within current slot (with 0.8s offset like KiwiSDR)
	timeWithinSlot := math.Mod(timeSec-0.8, slotPeriod)

	// Only start accumulating at the beginning of a slot
	// Allow up to 1/4 of slot period to start
	if timeWithinSlot > slotPeriod/4.0 {
		return false
	}

	// Calculate slot start time
	slotStartSec := timeSec - timeWithinSlot
	d.slotStartTime = time.Unix(int64(slotStartSec), int64((slotStartSec-math.Floor(slotStartSec))*1e9))
	d.synced = true
	d.state = StateAccumulating

	log.Printf("[FT8 Decoder] Synced to slot at %s (time within slot: %.3f s)",
		d.slotStartTime.UTC().Format("15:04:05"), timeWithinSlot)

	return true
}

// decode performs the actual FT8/FT4 decoding
func (d *FT8Decoder) decode() []DecodeResult {
	wf := d.monitor.Waterfall

	log.Printf("[FT8 Decoder] Decoding waterfall: %d blocks, max_mag=%.1f dB for slot %d",
		wf.NumBlocks, d.monitor.MaxMag, d.slotNumber)

	// Find candidates using Costas sync detection
	candidates := FindCandidates(wf, d.config.MaxCandidates, d.config.MinScore)

	log.Printf("[FT8 Decoder] Found %d candidates (min_score=%d)", len(candidates), d.config.MinScore)

	results := make([]DecodeResult, 0)
	decodedHashes := make(map[uint16]bool) // Prevent duplicate decodes

	// Process each candidate
	for _, cand := range candidates {
		// Attempt to decode this candidate
		message, status, success := DecodeCandidate(wf, &cand, d.config.Protocol, d.config.LDPCIterations)

		if !success {
			// Decoding failed (LDPC errors or CRC mismatch)
			continue
		}

		// Check for duplicate (same message hash)
		if decodedHashes[message.Hash] {
			continue
		}
		decodedHashes[message.Hash] = true

		// Estimate SNR from sync score
		// TODO: Implement proper SNR calculation
		snr := float32(cand.Score)/10.0 - 15.0

		// Unpack message payload to human-readable text with hash table support
		messageText := UnpackMessageWithHash(message.Payload, d.hashTable)

		result := DecodeResult{
			Timestamp:  d.slotStartTime.Unix(),
			UTC:        d.slotStartTime.UTC().Format("15:04:05"),
			SNR:        snr,
			DeltaT:     status.Time,
			Frequency:  status.Frequency,
			Message:    messageText,
			Protocol:   d.config.Protocol.String(),
			SlotNumber: d.slotNumber,
			Score:      int(cand.Score),
		}

		results = append(results, result)

		log.Printf("[FT8 Decoder] Decoded: %s %.1f Hz, SNR %.1f dB, CRC %04X",
			result.UTC, result.Frequency, result.SNR, message.Hash)
	}

	log.Printf("[FT8 Decoder] Successfully decoded %d messages in slot %d", len(results), d.slotNumber)

	return results
}
