package ft8

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"reflect"
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

	// Location and enrichment
	receiverLocator string
	ctyDatabase     interface{}

	// Control
	running  bool
	stopChan chan struct{}
	mu       sync.Mutex
	wg       sync.WaitGroup
}

// DecodeResult represents a decoded FT8/FT4 message
type DecodeResult struct {
	Timestamp      int64    `json:"timestamp"`             // Unix timestamp (seconds)
	UTC            string   `json:"utc"`                   // UTC time string "HH:MM:SS"
	SNR            float32  `json:"snr"`                   // Signal-to-noise ratio (dB)
	DeltaT         float32  `json:"delta_t"`               // Time offset from slot start (seconds)
	Frequency      float32  `json:"frequency"`             // Audio frequency (Hz)
	Callsign       string   `json:"callsign"`              // Transmitter callsign
	Locator        string   `json:"locator,omitempty"`     // Grid square locator
	DistanceKm     *float64 `json:"distance_km,omitempty"` // Distance from receiver in km
	BearingDeg     *float64 `json:"bearing_deg,omitempty"` // Bearing from receiver in degrees
	Country        string   `json:"country,omitempty"`     // Country name from CTY database
	Continent      string   `json:"continent,omitempty"`   // Continent code (e.g., "EU", "NA")
	Message        string   `json:"message"`               // Decoded message text
	Protocol       string   `json:"protocol"`              // "FT8" or "FT4"
	SlotNumber     uint64   `json:"slot_number"`           // Slot number since decoder start
	Score          int      `json:"score"`                 // Sync score
	CandidateCount int      `json:"candidate_count"`       // Total candidates found in this slot
	LDPCFailures   int      `json:"ldpc_failures"`         // LDPC decode failures in this slot
	CRCFailures    int      `json:"crc_failures"`          // CRC check failures in this slot
}

// NewFT8Decoder creates a new FT8/FT4 decoder
func NewFT8Decoder(sampleRate int, config FT8Config, receiverLocator string, ctyDatabase interface{}) *FT8Decoder {
	slotTime := config.Protocol.GetSlotTime()
	samplesPerSlot := int(float64(sampleRate) * slotTime)

	// Active decoding period is slot time minus 0.4 seconds
	samplesNeeded := int(float64(sampleRate) * (slotTime - 0.4))

	// Create monitor for waterfall generation
	monitor := NewMonitor(sampleRate, FreqMin, FreqMax, TimeOSR, FreqOSR, config.Protocol)

	// Create callsign hash table (1 hour retention)
	hashTable := NewCallsignHashTable(1 * time.Hour)

	return &FT8Decoder{
		sampleRate:      sampleRate,
		config:          config,
		state:           StateWaitingForSlot,
		samplesPerSlot:  samplesPerSlot,
		samplesNeeded:   samplesNeeded,
		buffer:          make([]float32, 0, samplesPerSlot),
		monitor:         monitor,
		hashTable:       hashTable,
		receiverLocator: receiverLocator,
		ctyDatabase:     ctyDatabase,
		stopChan:        make(chan struct{}),
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

	return true
}

// decode performs the actual FT8/FT4 decoding
func (d *FT8Decoder) decode() []DecodeResult {
	wf := d.monitor.Waterfall

	// Find candidates using Costas sync detection
	candidates := FindCandidates(wf, d.config.MaxCandidates, d.config.MinScore)

	results := make([]DecodeResult, 0)
	decodedHashes := make(map[uint16]bool) // Prevent duplicate decodes

	// Track decode failure reasons
	ldpcFailures := 0
	crcFailures := 0

	// Process each candidate
	for i, cand := range candidates {
		// Attempt to decode this candidate
		message, status, success := DecodeCandidate(wf, &cand, d.config.Protocol, d.config.LDPCIterations)

		if !success {
			// Decoding failed (LDPC errors or CRC mismatch)
			if status.LDPCErrors > 0 {
				ldpcFailures++
				if i < 5 { // Log first 5 failures
					log.Printf("[FT8 Decoder] Candidate %d: LDPC failed with %d errors (score=%d, freq=%.1f Hz)",
						i, status.LDPCErrors, cand.Score, status.Frequency)
				}
			} else {
				crcFailures++
				if i < 5 { // Log first 5 failures
					log.Printf("[FT8 Decoder] Candidate %d: CRC mismatch (extracted=%04X, calculated=%04X, score=%d, freq=%.1f Hz)",
						i, status.CRCExtracted, status.CRCCalculated, cand.Score, status.Frequency)
				}
			}
			continue
		}

		// Check for duplicate (same message hash)
		if decodedHashes[message.Hash] {
			continue
		}
		decodedHashes[message.Hash] = true

		// Calculate SNR from sync score (matches KiwiSDR implementation)
		// Reference: KiwiSDR/extensions/FT8/ft8_lib/decode_ft8.c:307
		// SNR = score * 0.5 + SNR_adj, where SNR_adj = -22 dB
		snr := float32(cand.Score)*0.5 - 22.0

		// Unpack message payload to human-readable text with hash table support
		messageText := UnpackMessageWithHash(message.Payload, d.hashTable)

		// Extract callsign and grid locator from message
		callsign, locator := extractCallsignLocator(messageText)

		result := DecodeResult{
			Timestamp:      d.slotStartTime.Unix(),
			UTC:            d.slotStartTime.UTC().Format("15:04:05"),
			SNR:            snr,
			DeltaT:         status.Time,
			Frequency:      status.Frequency,
			Callsign:       callsign,
			Locator:        locator,
			Message:        messageText,
			Protocol:       d.config.Protocol.String(),
			SlotNumber:     d.slotNumber,
			Score:          int(cand.Score),
			CandidateCount: len(candidates),
			LDPCFailures:   ldpcFailures,
			CRCFailures:    crcFailures,
		}

		// Enrich with CTY data and calculate distance/bearing
		d.enrichResult(&result)

		results = append(results, result)
	}

	return results
}

// enrichResult enriches a decode result with CTY data and distance/bearing
func (d *FT8Decoder) enrichResult(result *DecodeResult) {
	// Skip if no callsign
	if result.Callsign == "" {
		return
	}

	// Try to get CTY information if database is available
	var ctyLat, ctyLon float64
	var hasCTY bool
	if d.ctyDatabase != nil {
		// Use reflection to call LookupCallsignFull method
		dbValue := reflect.ValueOf(d.ctyDatabase)
		method := dbValue.MethodByName("LookupCallsignFull")
		if method.IsValid() {
			results := method.Call([]reflect.Value{reflect.ValueOf(result.Callsign)})
			if len(results) > 0 && !results[0].IsNil() {
				infoValue := results[0]
				if infoValue.Kind() == reflect.Ptr {
					infoValue = infoValue.Elem()
				}
				if infoValue.Kind() == reflect.Struct {
					if country := infoValue.FieldByName("Country"); country.IsValid() && country.Kind() == reflect.String {
						result.Country = country.String()
					}
					if continent := infoValue.FieldByName("Continent"); continent.IsValid() && continent.Kind() == reflect.String {
						result.Continent = continent.String()
					}
					if lat := infoValue.FieldByName("Latitude"); lat.IsValid() && lat.Kind() == reflect.Float64 {
						ctyLat = lat.Float()
					}
					if lon := infoValue.FieldByName("Longitude"); lon.IsValid() && lon.Kind() == reflect.Float64 {
						ctyLon = lon.Float()
					}
					hasCTY = result.Country != "" || result.Continent != ""
				}
			}
		}
	}

	// Calculate distance and bearing if receiver locator is set
	if d.receiverLocator == "" {
		return
	}

	// Priority 1: Use grid square if available
	if result.Locator != "" && len(result.Locator) >= 4 {
		receiverLat, receiverLon, err1 := MaidenheadToLatLon(d.receiverLocator)
		txLat, txLon, err2 := MaidenheadToLatLon(result.Locator)
		if err1 == nil && err2 == nil {
			dist, bearing := CalculateDistanceAndBearing(receiverLat, receiverLon, txLat, txLon)
			result.DistanceKm = &dist
			result.BearingDeg = &bearing
		}
	} else if hasCTY && (ctyLat != 0 || ctyLon != 0) {
		// Priority 2: Fall back to CTY country lat/lon if no grid square
		receiverLat, receiverLon, err := MaidenheadToLatLon(d.receiverLocator)
		if err == nil {
			dist, bearing := CalculateDistanceAndBearing(receiverLat, receiverLon, ctyLat, ctyLon)
			result.DistanceKm = &dist
			result.BearingDeg = &bearing
		}
	}
}
