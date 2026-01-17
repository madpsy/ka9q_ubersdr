package main

import (
	"sync"
	"time"
)

// DecodeInfo represents a decoded signal with all relevant information
type DecodeInfo struct {
	// Common fields for all modes
	Callsign      string
	Locator       string
	Country       string  // DXCC country name from CTY.DAT
	CQZone        int     // CQ Zone from CTY.DAT
	ITUZone       int     // ITU Zone from CTY.DAT
	Continent     string  // Continent code from CTY.DAT (e.g., "NA", "EU", "AS")
	TimeOffset    float64 // UTC time offset from CTY.DAT
	SNR           int
	Frequency     uint64 // Actual RF frequency in Hz
	DialFrequency uint64 // Dial frequency (center frequency) in Hz
	Timestamp     time.Time
	Mode          string // "FT8", "FT4", "WSPR", "JS8"
	Submode       string // JS8 submode: "A" (Normal), "B" (Fast), "C" (Turbo), "E" (Slow)
	Message       string
	BandName      string // Name of the decoder band (e.g., "20m_FT8")

	// Distance and bearing (calculated if receiver locator is configured)
	DistanceKm *float64 `json:"distance_km,omitempty"`
	BearingDeg *float64 `json:"bearing_deg,omitempty"`

	// WSPR-specific fields
	DT          float32 // Time drift in seconds
	Drift       int     // Frequency drift in Hz
	DBm         int     // Transmitter power in dBm
	TxFrequency uint64  // Transmitter frequency in Hz

	// Validity flags
	HasCallsign bool
	HasLocator  bool
	IsWSPR      bool
}

// DecoderBand represents an active decoder band with its session
type DecoderBand struct {
	Config       DecoderBandConfig
	SSRC         uint32
	SessionID    string
	AudioChan    chan AudioPacket
	LastDataTime time.Time
	mu           sync.Mutex

	// Decoder session state
	DecoderSession *DecoderSession
}

// DecoderSession manages the recording and decoding for a single band
type DecoderSession struct {
	Band           *DecoderBand
	CurrentCycle   int64
	FileCycle      int64
	WavFile        *WAVWriter
	Filename       string
	SamplesWritten int64
	TotalSamples   int64
	SampleRate     int
	Channels       int
	mu             sync.Mutex
}

// SpotFile represents a temporary file containing decoded spots
type SpotFile struct {
	Filename  string
	BandName  string
	Frequency uint64
	Mode      DecoderMode
	Timestamp time.Time
}

// DecoderStats tracks statistics for the decoder
type DecoderStats struct {
	TotalDecodes    int64
	TotalSpots      int64
	DecodesPerBand  map[string]int64
	SpotsPerBand    map[string]int64
	LastDecodeTime  time.Time
	PSKReporterSent int64
	WSPRNetSent     int64
	DecoderErrors   int64
	mu              sync.RWMutex
}

// NewDecoderStats creates a new decoder statistics tracker
func NewDecoderStats() *DecoderStats {
	return &DecoderStats{
		DecodesPerBand: make(map[string]int64),
		SpotsPerBand:   make(map[string]int64),
	}
}

// IncrementDecodes increments the decode counter for a band
func (ds *DecoderStats) IncrementDecodes(bandName string, count int64) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.TotalDecodes += count
	ds.DecodesPerBand[bandName] += count
	ds.LastDecodeTime = time.Now()
}

// IncrementSpots increments the spot counter for a band
func (ds *DecoderStats) IncrementSpots(bandName string, count int64) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.TotalSpots += count
	ds.SpotsPerBand[bandName] += count
}

// IncrementPSKReporter increments the PSKReporter submission counter
func (ds *DecoderStats) IncrementPSKReporter(count int64) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.PSKReporterSent += count
}

// IncrementWSPRNet increments the WSPRNet submission counter
func (ds *DecoderStats) IncrementWSPRNet(count int64) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.WSPRNetSent += count
}

// IncrementErrors increments the decoder error counter
func (ds *DecoderStats) IncrementErrors() {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.DecoderErrors++
}

// GetStats returns a copy of the current statistics
func (ds *DecoderStats) GetStats() map[string]interface{} {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	decodesPerBand := make(map[string]int64)
	for k, v := range ds.DecodesPerBand {
		decodesPerBand[k] = v
	}

	spotsPerBand := make(map[string]int64)
	for k, v := range ds.SpotsPerBand {
		spotsPerBand[k] = v
	}

	return map[string]interface{}{
		"total_decodes":    ds.TotalDecodes,
		"total_spots":      ds.TotalSpots,
		"decodes_per_band": decodesPerBand,
		"spots_per_band":   spotsPerBand,
		"last_decode_time": ds.LastDecodeTime,
		"pskreporter_sent": ds.PSKReporterSent,
		"wsprnet_sent":     ds.WSPRNetSent,
		"decoder_errors":   ds.DecoderErrors,
	}
}
