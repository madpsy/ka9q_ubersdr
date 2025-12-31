package main

import (
	"encoding/csv"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Debug counters for limiting log output
var (
	debug20mDataCount int
)

// BandSpectrum represents a spectrum channel for a single band
type BandSpectrum struct {
	Band          NoiseFloorBand
	SSRC          uint32
	SessionID     string
	SpectrumChan  chan []float32
	LastDataTime  time.Time
	LastReconnect time.Time
	mu            sync.Mutex
}

// NoiseFloorMonitor manages noise floor monitoring across amateur radio bands
// Each band gets its own dedicated spectrum channel for better resolution
type NoiseFloorMonitor struct {
	config   *Config
	radiod   *RadiodController
	sessions *SessionManager

	// Multiple spectrum sessions (one per band)
	bandSpectrums  map[string]*BandSpectrum
	spectrumsReady bool

	// Wide-band spectrum (0-30 MHz full HF coverage)
	wideBandSpectrum  *BandSpectrum
	wideBandFFTBuffer *FFTBuffer

	// CSV logging (one file per band)
	currentFiles map[string]*os.File
	csvWriters   map[string]*csv.Writer
	currentDates map[string]string
	fileMu       sync.Mutex

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Latest measurements (for API)
	latestMeasurements map[string]*BandMeasurement
	measurementsMu     sync.RWMutex

	// FFT sample buffers (rolling window for averaging)
	fftBuffers map[string]*FFTBuffer
	fftMu      sync.RWMutex

	// Prometheus metrics (optional)
	prometheusMetrics *PrometheusMetrics
}

// FFTSample represents a single FFT measurement with timestamp
type FFTSample struct {
	Timestamp time.Time
	Data      []float32
}

// FFTBuffer stores a rolling window of FFT samples for averaging
type FFTBuffer struct {
	Band      string
	StartFreq uint64
	EndFreq   uint64
	BinWidth  float64
	Samples   []FFTSample
	MaxAge    time.Duration // Maximum age of samples to keep
}

// NewFFTBuffer creates a new FFT buffer
func NewFFTBuffer(band string, startFreq, endFreq uint64, binWidth float64, maxAge time.Duration) *FFTBuffer {
	return &FFTBuffer{
		Band:      band,
		StartFreq: startFreq,
		EndFreq:   endFreq,
		BinWidth:  binWidth,
		Samples:   make([]FFTSample, 0, 600), // Pre-allocate for ~1 minute at 100ms poll rate
		MaxAge:    maxAge,
	}
}

// AddSample adds a new FFT sample and removes old samples
func (fb *FFTBuffer) AddSample(timestamp time.Time, data []float32) {
	// Make a copy of the data
	dataCopy := make([]float32, len(data))
	copy(dataCopy, data)

	fb.Samples = append(fb.Samples, FFTSample{
		Timestamp: timestamp,
		Data:      dataCopy,
	})

	// Remove samples older than MaxAge
	cutoff := timestamp.Add(-fb.MaxAge)
	validStart := 0
	for i, sample := range fb.Samples {
		if sample.Timestamp.After(cutoff) {
			validStart = i
			break
		}
	}

	if validStart > 0 {
		fb.Samples = fb.Samples[validStart:]
	}
}

// GetMaxHoldFFT returns the maximum value for each bin over the specified duration
// This preserves peaks and is better for displaying transient signals like FT8
func (fb *FFTBuffer) GetMaxHoldFFT(duration time.Duration) *BandFFT {
	if len(fb.Samples) == 0 {
		return nil
	}

	// Find samples within the duration window
	cutoff := time.Now().Add(-duration)
	validSamples := make([]FFTSample, 0)
	for _, sample := range fb.Samples {
		if sample.Timestamp.After(cutoff) || sample.Timestamp.Equal(cutoff) {
			validSamples = append(validSamples, sample)
		}
	}

	// If no samples in the window, use all available samples
	if len(validSamples) == 0 {
		validSamples = fb.Samples
	}

	// Take maximum value for each bin (max hold)
	numBins := len(validSamples[0].Data)
	maxHold := make([]float32, numBins)

	// Initialize with first sample's data instead of sentinel values
	// This ensures we start with real data, not artificial low values
	copy(maxHold, validSamples[0].Data)

	// Find maximum for each bin across all samples
	for _, sample := range validSamples[1:] {
		for i, val := range sample.Data {
			if val > maxHold[i] {
				maxHold[i] = val
			}
		}
	}

	return &BandFFT{
		Timestamp: time.Now(),
		Band:      fb.Band,
		StartFreq: fb.StartFreq,
		EndFreq:   fb.EndFreq,
		BinWidth:  fb.BinWidth,
		Data:      maxHold,
	}
}

// GetAveragedFFT returns an averaged FFT over the specified duration
// IMPORTANT: Averages in linear power domain, then converts back to dB
func (fb *FFTBuffer) GetAveragedFFT(duration time.Duration) *BandFFT {
	if len(fb.Samples) == 0 {
		return nil
	}

	// Find samples within the duration window (or use all if duration is longer than oldest sample)
	cutoff := time.Now().Add(-duration)
	validSamples := make([]FFTSample, 0)
	for _, sample := range fb.Samples {
		if sample.Timestamp.After(cutoff) || sample.Timestamp.Equal(cutoff) {
			validSamples = append(validSamples, sample)
		}
	}

	// If no samples in the window, use all available samples (better than returning nil)
	if len(validSamples) == 0 {
		validSamples = fb.Samples
	}

	// Average the FFT data in LINEAR power domain
	// Converting dB to linear: power = 10^(dB/10)
	// Then back to dB: dB = 10 * log10(power)
	numBins := len(validSamples[0].Data)
	linearSum := make([]float64, numBins)

	// Debug: Track max values for 20m band
	var maxDbBefore, maxDbAfter float32 = -999, -999
	var maxBinBefore, maxBinAfter int

	for _, sample := range validSamples {
		for i, dbVal := range sample.Data {
			// Track max for debugging
			if fb.Band == "20m" && dbVal > maxDbBefore {
				maxDbBefore = dbVal
				maxBinBefore = i
			}
			// Convert dB to linear power and accumulate
			linearPower := math.Pow(10.0, float64(dbVal)/10.0)
			linearSum[i] += linearPower
		}
	}

	// Average and convert back to dB
	count := float64(len(validSamples))
	averaged := make([]float32, numBins)
	for i := range averaged {
		avgLinearPower := linearSum[i] / count
		// Convert back to dB
		averaged[i] = float32(10.0 * math.Log10(avgLinearPower))

		// Track max after averaging
		if fb.Band == "20m" && averaged[i] > maxDbAfter {
			maxDbAfter = averaged[i]
			maxBinAfter = i
		}
	}

	// Debug logging for 20m band
	if DebugMode && fb.Band == "20m" && debug20mDataCount < 5 {
		log.Printf("DEBUG: 20m FFT averaging - samples=%d, duration=%v", len(validSamples), duration)
		log.Printf("DEBUG: 20m BEFORE avg - max=%.1f dB at bin %d", maxDbBefore, maxBinBefore)
		log.Printf("DEBUG: 20m AFTER avg - max=%.1f dB at bin %d", maxDbAfter, maxBinAfter)
		debug20mDataCount++
	}

	return &BandFFT{
		Timestamp: time.Now(),
		Band:      fb.Band,
		StartFreq: fb.StartFreq,
		EndFreq:   fb.EndFreq,
		BinWidth:  fb.BinWidth,
		Data:      averaged,
	}
}

// BandMeasurement contains noise floor statistics for a band
type BandMeasurement struct {
	Timestamp    time.Time `json:"timestamp"`
	Band         string    `json:"band"`
	MinDB        float32   `json:"min_db"`
	MaxDB        float32   `json:"max_db"`
	MeanDB       float32   `json:"mean_db"`
	MedianDB     float32   `json:"median_db"`
	P5DB         float32   `json:"p5_db"`         // 5th percentile - noise floor estimate
	P10DB        float32   `json:"p10_db"`        // 10th percentile
	P95DB        float32   `json:"p95_db"`        // 95th percentile - signal peak
	DynamicRange float32   `json:"dynamic_range"` // P95 - P5
	OccupancyPct float32   `json:"occupancy_pct"` // % of bins above noise + 10dB
	FT8SNR       float32   `json:"ft8_snr"`       // FT8 SNR in dB (signal power - noise floor)
}

// FrequencyMarker represents a frequency marker to display on the FFT graph
type FrequencyMarker struct {
	DisplayName string `json:"display_name"` // Name to display (e.g., "FT8")
	Frequency   uint64 `json:"frequency"`    // Center frequency in Hz
	Bandwidth   uint64 `json:"bandwidth"`    // Bandwidth in Hz
	Sideband    string `json:"sideband"`     // "upper", "lower", or "both"
}

// BandFFT contains the raw FFT data for a band
type BandFFT struct {
	Timestamp time.Time         `json:"timestamp"`
	Band      string            `json:"band"`
	StartFreq uint64            `json:"start_freq"` // Start frequency in Hz
	EndFreq   uint64            `json:"end_freq"`   // End frequency in Hz
	BinWidth  float64           `json:"bin_width"`  // Frequency width per bin in Hz
	Data      []float32         `json:"data"`       // FFT bin data in dB
	Markers   []FrequencyMarker `json:"markers"`    // Frequency markers to display
}

// NewNoiseFloorMonitor creates a new noise floor monitor
func NewNoiseFloorMonitor(config *Config, radiod *RadiodController, sessions *SessionManager) (*NoiseFloorMonitor, error) {
	if !config.NoiseFloor.Enabled {
		return nil, nil
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(config.NoiseFloor.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create noise floor data directory: %w", err)
	}

	nfm := &NoiseFloorMonitor{
		config:             config,
		radiod:             radiod,
		sessions:           sessions,
		stopChan:           make(chan struct{}),
		bandSpectrums:      make(map[string]*BandSpectrum),
		latestMeasurements: make(map[string]*BandMeasurement),
		fftBuffers:         make(map[string]*FFTBuffer),
		currentFiles:       make(map[string]*os.File),
		csvWriters:         make(map[string]*csv.Writer),
		currentDates:       make(map[string]string),
	}

	// Initialize FFT buffers for each band (store up to 1 minute of samples)
	for _, band := range config.NoiseFloor.Bands {
		nfm.fftBuffers[band.Name] = NewFFTBuffer(
			band.Name,
			band.Start,
			band.End,
			band.BinBandwidth,
			60*time.Second, // Keep 1 minute of samples
		)
	}

	// Initialize wide-band FFT buffer (0-30 MHz full HF coverage)
	// Uses 4096 bins @ 7.5 kHz/bin for high frequency resolution
	nfm.wideBandFFTBuffer = NewFFTBuffer(
		"wideband",
		0,              // 0 Hz start
		30000000,       // 30 MHz end
		7500.0,         // 7.5 kHz bin width (4x better resolution than original 30 kHz)
		60*time.Second, // Keep 1 minute of samples
	)

	return nfm, nil
}

// Start begins noise floor monitoring
// Creates a separate spectrum channel for each band plus a wide-band channel
func (nfm *NoiseFloorMonitor) Start() error {
	if nfm == nil {
		return nil // Disabled
	}

	nfm.running = true

	log.Printf("Creating noise floor spectrum sessions for %d bands + wide-band", len(nfm.config.NoiseFloor.Bands))

	// Create wide-band spectrum session (0-30 MHz full HF coverage)
	// Uses same parameters as main spectrum display
	wideBandSSRC := uint32(rand.Int31())
	if wideBandSSRC == 0 || wideBandSSRC == 0xffffffff {
		wideBandSSRC = 1
	}

	// Ensure SSRC is unique
	nfm.sessions.mu.RLock()
	for {
		if _, exists := nfm.sessions.ssrcToSession[wideBandSSRC]; !exists {
			break
		}
		wideBandSSRC = uint32(rand.Int31())
		if wideBandSSRC == 0 || wideBandSSRC == 0xffffffff {
			wideBandSSRC = 1
		}
	}
	nfm.sessions.mu.RUnlock()

	// Create wide-band spectrum channel
	// Parameters: 15 MHz center, 4096 bins, 7.5 kHz/bin for high resolution
	if DebugMode {
		log.Printf("DEBUG: Creating wide-band spectrum - freq: 15000000 Hz, bins: 4096, bw: 7500.0 Hz")
	}

	if err := nfm.radiod.CreateSpectrumChannel(
		"noisefloor-wideband",
		15000000, // 15 MHz center (covers 0-30 MHz)
		4096,     // 4096 bins (4x original for high resolution)
		7500.0,   // 7.5 kHz per bin (~30.72 MHz total bandwidth, 4x resolution)
		wideBandSSRC,
	); err != nil {
		return fmt.Errorf("failed to create wide-band spectrum channel: %w", err)
	}

	// Create spectrum channel for receiving wide-band data
	wideBandSpectrumChan := make(chan []float32, 10)

	// Register wide-band spectrum session
	wideBandSessionID := fmt.Sprintf("noisefloor-wideband-%08x", wideBandSSRC)
	wideBandSession := &Session{
		ID:           wideBandSessionID,
		SSRC:         wideBandSSRC,
		IsSpectrum:   true,
		Frequency:    15000000,
		BinCount:     4096,
		BinBandwidth: 7500.0,
		SpectrumChan: wideBandSpectrumChan,
		CreatedAt:    time.Now(),
		LastActive:   time.Now(),
	}

	nfm.sessions.mu.Lock()
	nfm.sessions.sessions[wideBandSessionID] = wideBandSession
	nfm.sessions.ssrcToSession[wideBandSSRC] = wideBandSession
	nfm.sessions.mu.Unlock()

	// Store wide-band spectrum info
	nfm.wideBandSpectrum = &BandSpectrum{
		Band: NoiseFloorBand{
			Name:            "wideband",
			Start:           0,
			End:             30000000,
			CenterFrequency: 15000000,
			BinCount:        4096,
			BinBandwidth:    7500.0,
		},
		SSRC:         wideBandSSRC,
		SessionID:    wideBandSessionID,
		SpectrumChan: wideBandSpectrumChan,
	}

	log.Printf("Created wide-band spectrum session (SSRC: 0x%08x, 7.5 kHz resolution, 0-30 MHz, 4096 bins)", wideBandSSRC)

	// Create a spectrum session for each band
	for _, band := range nfm.config.NoiseFloor.Bands {
		// Generate random SSRC for this band
		ssrc := uint32(rand.Int31())
		if ssrc == 0 || ssrc == 0xffffffff {
			ssrc = 1 // Avoid reserved values
		}

		// Ensure SSRC is unique
		nfm.sessions.mu.RLock()
		for {
			if _, exists := nfm.sessions.ssrcToSession[ssrc]; !exists {
				break
			}
			ssrc = uint32(rand.Int31())
			if ssrc == 0 || ssrc == 0xffffffff {
				ssrc = 1
			}
		}
		nfm.sessions.mu.RUnlock()

		// Create spectrum channel for this band
		channelName := fmt.Sprintf("noisefloor-%s", band.Name)

		if DebugMode {
			log.Printf("DEBUG: Creating spectrum for %s - freq: %d Hz, bins: %d, bw: %.1f Hz",
				band.Name, band.CenterFrequency, band.BinCount, band.BinBandwidth)
		}

		if err := nfm.radiod.CreateSpectrumChannel(
			channelName,
			band.CenterFrequency,
			band.BinCount,
			band.BinBandwidth,
			ssrc,
		); err != nil {
			return fmt.Errorf("failed to create spectrum channel for %s: %w", band.Name, err)
		}

		// Create spectrum channel for receiving data
		spectrumChan := make(chan []float32, 10)

		// Register spectrum session with session manager
		sessionID := fmt.Sprintf("noisefloor-%s-%08x", band.Name, ssrc)
		session := &Session{
			ID:           sessionID,
			SSRC:         ssrc,
			IsSpectrum:   true,
			Frequency:    band.CenterFrequency,
			BinCount:     band.BinCount,
			BinBandwidth: band.BinBandwidth,
			SpectrumChan: spectrumChan,
			CreatedAt:    time.Now(),
			LastActive:   time.Now(),
		}

		nfm.sessions.mu.Lock()
		nfm.sessions.sessions[sessionID] = session
		nfm.sessions.ssrcToSession[ssrc] = session
		nfm.sessions.mu.Unlock()

		// Store band spectrum info
		nfm.bandSpectrums[band.Name] = &BandSpectrum{
			Band:         band,
			SSRC:         ssrc,
			SessionID:    sessionID,
			SpectrumChan: spectrumChan,
		}

		log.Printf("Created spectrum session for %s (SSRC: 0x%08x, %.1f Hz resolution)",
			band.Name, ssrc, band.BinBandwidth)
	}

	nfm.spectrumsReady = true

	// Start monitoring loop
	nfm.wg.Add(1)
	go nfm.monitorLoop()

	log.Printf("Noise floor monitor started (poll interval: %d seconds, %d bands + wide-band)",
		nfm.config.NoiseFloor.PollIntervalSec, len(nfm.config.NoiseFloor.Bands))

	// Give radiod a moment to set up the spectrum channels
	time.Sleep(2 * time.Second)
	log.Printf("Noise floor monitor initialization complete")

	return nil
}

// Stop shuts down the noise floor monitor
func (nfm *NoiseFloorMonitor) Stop() {
	if nfm == nil || !nfm.running {
		return
	}

	nfm.running = false
	close(nfm.stopChan)
	nfm.wg.Wait()

	// Close all CSV files
	nfm.fileMu.Lock()
	for band, file := range nfm.currentFiles {
		if file != nil {
			if err := file.Close(); err != nil {
				log.Printf("Error closing noise floor CSV file for %s: %v", band, err)
			}
		}
	}
	nfm.fileMu.Unlock()

	// Disable and remove all band spectrum channels
	if nfm.spectrumsReady {
		// Disable wide-band spectrum channel
		if nfm.wideBandSpectrum != nil {
			if err := nfm.radiod.DisableChannel("noisefloor-wideband", nfm.wideBandSpectrum.SSRC); err != nil {
				log.Printf("Warning: failed to disable wide-band channel: %v", err)
			}

			// Remove from session manager
			nfm.sessions.mu.Lock()
			delete(nfm.sessions.sessions, nfm.wideBandSpectrum.SessionID)
			delete(nfm.sessions.ssrcToSession, nfm.wideBandSpectrum.SSRC)
			nfm.sessions.mu.Unlock()

			// Close spectrum channel
			close(nfm.wideBandSpectrum.SpectrumChan)
		}

		// Disable per-band spectrum channels
		for bandName, bandSpectrum := range nfm.bandSpectrums {
			// Disable radiod channel
			channelName := fmt.Sprintf("noisefloor-%s", bandName)
			if err := nfm.radiod.DisableChannel(channelName, bandSpectrum.SSRC); err != nil {
				log.Printf("Warning: failed to disable %s channel: %v", bandName, err)
			}

			// Remove from session manager
			nfm.sessions.mu.Lock()
			delete(nfm.sessions.sessions, bandSpectrum.SessionID)
			delete(nfm.sessions.ssrcToSession, bandSpectrum.SSRC)
			nfm.sessions.mu.Unlock()

			// Close spectrum channel
			close(bandSpectrum.SpectrumChan)
		}
	}

	log.Printf("Noise floor monitor stopped (%d bands + wide-band cleaned up)", len(nfm.bandSpectrums))
}

// monitorLoop receives and processes spectrum data from multiple band channels
// Each band has its own spectrum channel that receives data independently
func (nfm *NoiseFloorMonitor) monitorLoop() {
	defer nfm.wg.Done()

	if DebugMode {
		log.Printf("DEBUG: Noise floor monitor loop started for %d bands + wide-band", len(nfm.bandSpectrums))
	}

	// Track time for periodic measurements
	ticker := time.NewTicker(time.Duration(nfm.config.NoiseFloor.PollIntervalSec) * time.Second)
	defer ticker.Stop()

	// Start goroutine for wide-band spectrum data
	if nfm.wideBandSpectrum != nil {
		nfm.wg.Add(1)
		go func() {
			defer nfm.wg.Done()

			for {
				select {
				case <-nfm.stopChan:
					return
				case spectrum := <-nfm.wideBandSpectrum.SpectrumChan:
					// Update last data time
					nfm.wideBandSpectrum.mu.Lock()
					nfm.wideBandSpectrum.LastDataTime = time.Now()
					nfm.wideBandSpectrum.mu.Unlock()

					// Add spectrum data to wide-band buffer
					nfm.addWideBandSampleToBuffer(spectrum)
				}
			}
		}()
	}

	// Start a goroutine for each band to receive its spectrum data
	for bandName, bandSpectrum := range nfm.bandSpectrums {
		nfm.wg.Add(1)
		go func(name string, bs *BandSpectrum) {
			defer nfm.wg.Done()

			for {
				select {
				case <-nfm.stopChan:
					return
				case spectrum := <-bs.SpectrumChan:
					// Update last data time
					bs.mu.Lock()
					bs.LastDataTime = time.Now()
					bs.mu.Unlock()

					// Add spectrum data directly to this band's buffer
					nfm.addBandSampleToBuffer(name, spectrum)
				}
			}
		}(bandName, bandSpectrum)
	}

	// Start watchdog goroutine to detect stalled channels
	nfm.wg.Add(1)
	go nfm.watchdogLoop()

	// Main loop for periodic statistics calculation
	for {
		select {
		case <-nfm.stopChan:
			if DebugMode {
				log.Printf("DEBUG: Noise floor monitor loop stopping")
			}
			return

		case <-ticker.C:
			// Calculate statistics periodically (ticker ensures correct interval)
			if DebugMode {
				log.Printf("DEBUG: Noise floor calculating statistics from buffered data")
			}
			nfm.calculateAndLogStatistics()
		}
	}
}

// addBandSampleToBuffer adds a spectrum sample directly to a band's FFT buffer
// No extraction needed - each band has its own dedicated spectrum channel
func (nfm *NoiseFloorMonitor) addBandSampleToBuffer(bandName string, spectrum []float32) {
	timestamp := time.Now()

	// Unwrap FFT bin ordering from radiod (same as spectrum-display.js does)
	// radiod sends: [positive freqs (DC to +Nyquist), negative freqs (-Nyquist to DC)]
	// We need: [negative freqs, positive freqs] for low-to-high frequency display
	N := len(spectrum)
	halfBins := N / 2
	unwrapped := make([]float32, N)

	// Put second half (negative frequencies) first
	copy(unwrapped[0:halfBins], spectrum[halfBins:N])
	// Put first half (positive frequencies) second
	copy(unwrapped[halfBins:N], spectrum[0:halfBins])

	// Debug: Check what's being stored for 20m
	if DebugMode && bandName == "20m" && debug20mDataCount < 5 {
		min, max := float32(999), float32(-999)
		for _, v := range unwrapped {
			if v < min {
				min = v
			}
			if v > max {
				max = v
			}
		}
		log.Printf("DEBUG: 20m STORING to buffer (after unwrap) - min=%.1f dB, max=%.1f dB, bins=%d",
			min, max, len(unwrapped))
		debug20mDataCount++
	}

	// Add unwrapped sample to buffer
	nfm.fftMu.Lock()
	if buffer, ok := nfm.fftBuffers[bandName]; ok {
		buffer.AddSample(timestamp, unwrapped)
	}
	nfm.fftMu.Unlock()
}

// addWideBandSampleToBuffer adds a spectrum sample to the wide-band FFT buffer
func (nfm *NoiseFloorMonitor) addWideBandSampleToBuffer(spectrum []float32) {
	timestamp := time.Now()

	// Unwrap FFT bin ordering from radiod (same as per-band processing)
	N := len(spectrum)
	halfBins := N / 2
	unwrapped := make([]float32, N)

	// Put second half (negative frequencies) first
	copy(unwrapped[0:halfBins], spectrum[halfBins:N])
	// Put first half (positive frequencies) second
	copy(unwrapped[halfBins:N], spectrum[0:halfBins])

	// Add unwrapped sample to wide-band buffer
	nfm.fftMu.Lock()
	if nfm.wideBandFFTBuffer != nil {
		nfm.wideBandFFTBuffer.AddSample(timestamp, unwrapped)
	}
	nfm.fftMu.Unlock()
}

// calculateAndLogStatistics calculates statistics from buffered data and logs to CSV
func (nfm *NoiseFloorMonitor) calculateAndLogStatistics() {
	timestamp := time.Now()
	bandsProcessed := 0

	for _, band := range nfm.config.NoiseFloor.Bands {
		// Get buffer with raw samples
		nfm.fftMu.RLock()
		buffer, ok := nfm.fftBuffers[band.Name]
		nfm.fftMu.RUnlock()

		if !ok {
			continue
		}

		// Get max-hold FFT over 10 seconds for statistics
		// This preserves peaks while smoothing out very short transients
		maxHoldFFT := buffer.GetMaxHoldFFT(10 * time.Second)
		if maxHoldFFT == nil || len(maxHoldFFT.Data) == 0 {
			continue
		}

		// Calculate statistics from the max-hold FFT data
		// This represents the strongest signals seen in each frequency bin over the last 10 seconds
		measurement := nfm.calculateStatistics(timestamp, band.Name, maxHoldFFT.Data)

		// Store latest measurement
		nfm.measurementsMu.Lock()
		nfm.latestMeasurements[band.Name] = measurement
		nfm.measurementsMu.Unlock()

		// Update Prometheus metrics if enabled
		if nfm.prometheusMetrics != nil {
			nfm.prometheusMetrics.UpdateFromMeasurement(measurement)
		}

		// Log to CSV
		if err := nfm.logMeasurement(measurement); err != nil {
			log.Printf("Error logging noise floor measurement: %v", err)
		} else {
			bandsProcessed++
		}
	}

	if DebugMode {
		log.Printf("DEBUG: Logged statistics for %d bands", bandsProcessed)
	}
}

// calculateStatistics calculates noise floor statistics from band data
func (nfm *NoiseFloorMonitor) calculateStatistics(timestamp time.Time, bandName string, data []float32) *BandMeasurement {
	// Sort data for percentile calculations
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	n := len(sorted)
	measurement := &BandMeasurement{
		Timestamp: timestamp,
		Band:      bandName,
		MinDB:     sorted[0],
		MaxDB:     sorted[n-1],
		P5DB:      sorted[n*5/100],
		P10DB:     sorted[n*10/100],
		MedianDB:  sorted[n*50/100],
		P95DB:     sorted[n*95/100],
	}

	// Calculate mean
	sum := float32(0)
	for _, v := range data {
		sum += v
	}
	measurement.MeanDB = sum / float32(n)

	// Calculate dynamic range (peak to noise floor)
	measurement.DynamicRange = measurement.MaxDB - measurement.P5DB

	// Calculate occupancy (% of bins above noise floor + 10dB)
	threshold := measurement.P5DB + 10.0
	aboveThreshold := 0
	for _, v := range data {
		if v > threshold {
			aboveThreshold++
		}
	}
	measurement.OccupancyPct = float32(aboveThreshold) * 100.0 / float32(n)

	// Calculate FT8 SNR if FT8 frequency is configured
	measurement.FT8SNR = nfm.calculateFT8SNR(bandName, data)

	return measurement
}

// calculateFT8SNR calculates the SNR for FT8 signals in a 3 kHz bandwidth
func (nfm *NoiseFloorMonitor) calculateFT8SNR(bandName string, data []float32) float32 {
	// Find the band configuration
	var bandConfig *NoiseFloorBand
	for i := range nfm.config.NoiseFloor.Bands {
		if nfm.config.NoiseFloor.Bands[i].Name == bandName {
			bandConfig = &nfm.config.NoiseFloor.Bands[i]
			break
		}
	}

	// If no band config or FT8 frequency not set, return 0
	if bandConfig == nil || bandConfig.FT8Frequency == 0 {
		return 0
	}

	// Calculate which bins cover the FT8 frequency + 3 kHz bandwidth
	// FT8 signals occupy approximately 50 Hz, but we measure over 3 kHz for better SNR estimation
	ft8StartFreq := bandConfig.FT8Frequency
	ft8EndFreq := bandConfig.FT8Frequency + 3000 // 3 kHz bandwidth

	// Calculate bin indices
	// Bins are arranged from start frequency to end frequency after unwrapping
	totalBandwidth := float64(bandConfig.End - bandConfig.Start)
	binsPerHz := float64(len(data)) / totalBandwidth

	// Calculate start and end bin indices for FT8 bandwidth
	startBin := int((float64(ft8StartFreq) - float64(bandConfig.Start)) * binsPerHz)
	endBin := int((float64(ft8EndFreq) - float64(bandConfig.Start)) * binsPerHz)

	// Clamp to valid range
	if startBin < 0 {
		startBin = 0
	}
	if endBin >= len(data) {
		endBin = len(data) - 1
	}
	if startBin >= endBin {
		return 0 // Invalid range
	}

	// Calculate average power in FT8 bandwidth (in dB)
	// We need to convert to linear, average, then back to dB
	var linearSum float64
	count := 0
	for i := startBin; i <= endBin; i++ {
		// Convert dB to linear power: power = 10^(dB/10)
		linearPower := math.Pow(10.0, float64(data[i])/10.0)
		linearSum += linearPower
		count++
	}

	if count == 0 {
		return 0
	}

	// Average linear power and convert back to dB
	avgLinearPower := linearSum / float64(count)
	ft8SignalDB := float32(10.0 * math.Log10(avgLinearPower))

	// Calculate noise floor from P5 (5th percentile)
	sorted := make([]float32, len(data))
	copy(sorted, data)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})
	noiseFloorDB := sorted[len(sorted)*5/100]

	// SNR = Signal - Noise (in dB)
	snr := ft8SignalDB - noiseFloorDB

	return snr
}

// logMeasurement writes a measurement to the band-specific CSV file
func (nfm *NoiseFloorMonitor) logMeasurement(m *BandMeasurement) error {
	nfm.fileMu.Lock()
	defer nfm.fileMu.Unlock()

	// Check if we need to rotate to a new file for this band
	dateStr := m.Timestamp.Format("2006-01-02")
	if dateStr != nfm.currentDates[m.Band] {
		if err := nfm.rotateFile(m.Band, dateStr); err != nil {
			return err
		}
	}

	// Get writer for this band
	writer := nfm.csvWriters[m.Band]
	if writer == nil {
		return fmt.Errorf("no CSV writer for band %s", m.Band)
	}

	// Write CSV record (no band column needed since it's per-band file)
	record := []string{
		m.Timestamp.Format(time.RFC3339),
		fmt.Sprintf("%.1f", m.MinDB),
		fmt.Sprintf("%.1f", m.MaxDB),
		fmt.Sprintf("%.1f", m.MeanDB),
		fmt.Sprintf("%.1f", m.MedianDB),
		fmt.Sprintf("%.1f", m.P5DB),
		fmt.Sprintf("%.1f", m.P10DB),
		fmt.Sprintf("%.1f", m.P95DB),
		fmt.Sprintf("%.1f", m.DynamicRange),
		fmt.Sprintf("%.1f", m.OccupancyPct),
		fmt.Sprintf("%.1f", m.FT8SNR),
	}

	if err := writer.Write(record); err != nil {
		return err
	}

	// Flush after each write to ensure data is saved
	writer.Flush()
	return writer.Error()
}

// rotateFile creates a new CSV file for the specified band and date
func (nfm *NoiseFloorMonitor) rotateFile(band, dateStr string) error {
	// Close current file for this band if open
	if nfm.currentFiles[band] != nil {
		if err := nfm.currentFiles[band].Close(); err != nil {
			log.Printf("Warning: error closing previous CSV file for %s: %v", band, err)
		}
	}

	// Parse date to create year/month/day directory structure
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return fmt.Errorf("invalid date format: %w", err)
	}

	// Create directory path: base_dir/YYYY/MM/DD/
	dirPath := filepath.Join(
		nfm.config.NoiseFloor.DataDir,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
	)

	// Create directory structure if it doesn't exist
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return fmt.Errorf("failed to create directory structure: %w", err)
	}

	// Create file: base_dir/YYYY/MM/DD/band.csv
	filename := filepath.Join(dirPath, fmt.Sprintf("%s.csv", band))
	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}

	// Check if file is new (needs header)
	stat, _ := file.Stat()
	needsHeader := stat.Size() == 0

	nfm.currentFiles[band] = file
	nfm.csvWriters[band] = csv.NewWriter(file)
	nfm.currentDates[band] = dateStr

	// Write header if new file (no band column since it's per-band)
	if needsHeader {
		header := []string{
			"timestamp", "min_db", "max_db", "mean_db", "median_db",
			"p5_db", "p10_db", "p95_db", "dynamic_range", "occupancy_pct", "ft8_snr",
		}
		if err := nfm.csvWriters[band].Write(header); err != nil {
			return fmt.Errorf("failed to write CSV header: %w", err)
		}
		nfm.csvWriters[band].Flush()
		log.Printf("Created new noise floor log file: %s", filename)
	}

	return nil
}

// GetLatestMeasurements returns the most recent measurements for all bands
func (nfm *NoiseFloorMonitor) GetLatestMeasurements() map[string]*BandMeasurement {
	if nfm == nil {
		return nil
	}

	nfm.measurementsMu.RLock()
	defer nfm.measurementsMu.RUnlock()

	// Create a copy to avoid race conditions
	result := make(map[string]*BandMeasurement, len(nfm.latestMeasurements))
	for k, v := range nfm.latestMeasurements {
		measurement := *v // Copy the measurement
		result[k] = &measurement
	}

	return result
}

// GetHistoricalData reads historical data from band-specific CSV files
// Returns only the requested day's data (00:00:00 to 23:59:59)
func (nfm *NoiseFloorMonitor) GetHistoricalData(date string, band string) ([]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}

	// Parse the requested date
	requestedDate, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("invalid date format: %w", err)
	}

	// Set time boundaries for the requested day only
	startTime := requestedDate                   // 00:00:00 of requested day
	endTime := requestedDate.Add(24 * time.Hour) // 00:00:00 of next day

	var allMeasurements []*BandMeasurement

	// If band is specified, read only that band's file
	if band != "" {
		measurements, err := nfm.readBandFile(band, date)
		if err != nil {
			return nil, fmt.Errorf("no data found for band %s on date %s: %w", band, date, err)
		}
		allMeasurements = append(allMeasurements, measurements...)
	} else {
		// Read all band files for the requested date
		for _, bandConfig := range nfm.config.NoiseFloor.Bands {
			measurements, err := nfm.readBandFile(bandConfig.Name, date)
			if err != nil {
				// Skip bands that don't have data
				continue
			}
			allMeasurements = append(allMeasurements, measurements...)
		}
	}

	if len(allMeasurements) == 0 {
		return nil, fmt.Errorf("no data found for date %s", date)
	}

	// Filter measurements to only include those within the requested day
	filteredMeasurements := make([]*BandMeasurement, 0, len(allMeasurements))
	for _, m := range allMeasurements {
		if (m.Timestamp.Equal(startTime) || m.Timestamp.After(startTime)) &&
			m.Timestamp.Before(endTime) {
			filteredMeasurements = append(filteredMeasurements, m)
		}
	}

	// Sort by timestamp (oldest first) for consistent ordering
	sort.Slice(filteredMeasurements, func(i, j int) bool {
		return filteredMeasurements[i].Timestamp.Before(filteredMeasurements[j].Timestamp)
	})

	return filteredMeasurements, nil
}

// GetRecentData returns the last hour of data with all data points
func (nfm *NoiseFloorMonitor) GetRecentData(band string) ([]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}

	// Calculate time range (last hour)
	now := time.Now()
	startTime := now.Add(-1 * time.Hour)

	// Determine which dates we might need (current and possibly previous day)
	currentDate := now.Format("2006-01-02")
	startDate := startTime.Format("2006-01-02")

	dates := []string{currentDate}

	// If start time is on a different day than now, also read that day's file
	if startDate != currentDate {
		dates = append([]string{startDate}, dates...)
	}

	var allMeasurements []*BandMeasurement

	// Read data from relevant dates
	if band != "" {
		for _, d := range dates {
			measurements, err := nfm.readBandFile(band, d)
			if err != nil {
				continue
			}
			allMeasurements = append(allMeasurements, measurements...)
		}
	} else {
		// Read all bands
		for _, d := range dates {
			for _, bandConfig := range nfm.config.NoiseFloor.Bands {
				measurements, err := nfm.readBandFile(bandConfig.Name, d)
				if err != nil {
					continue
				}
				allMeasurements = append(allMeasurements, measurements...)
			}
		}
	}

	// Filter to last hour
	recentMeasurements := make([]*BandMeasurement, 0)
	for _, m := range allMeasurements {
		if (m.Timestamp.Equal(startTime) || m.Timestamp.After(startTime)) &&
			(m.Timestamp.Before(now) || m.Timestamp.Equal(now)) {
			recentMeasurements = append(recentMeasurements, m)
		}
	}

	// Sort by timestamp (oldest first)
	sort.Slice(recentMeasurements, func(i, j int) bool {
		return recentMeasurements[i].Timestamp.Before(recentMeasurements[j].Timestamp)
	})

	return recentMeasurements, nil
}

// GetTrendData returns 24 hours of data averaged in 10-minute chunks
func (nfm *NoiseFloorMonitor) GetTrendData(date string, band string) ([]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}

	// Check if this is today - if so, use rolling 24-hour window
	today := time.Now().Format("2006-01-02")
	var rawData []*BandMeasurement

	if date == today {
		// For today (live mode), get rolling 24-hour window
		now := time.Now()
		startTime := now.Add(-24 * time.Hour)
		startDate := startTime.Format("2006-01-02")

		dates := []string{today}
		if startDate != today {
			dates = append([]string{startDate}, dates...)
		}

		// Read data from relevant dates
		var allMeasurements []*BandMeasurement
		if band != "" {
			for _, d := range dates {
				measurements, err := nfm.readBandFile(band, d)
				if err != nil {
					continue
				}
				allMeasurements = append(allMeasurements, measurements...)
			}
		} else {
			for _, d := range dates {
				for _, bandConfig := range nfm.config.NoiseFloor.Bands {
					measurements, err := nfm.readBandFile(bandConfig.Name, d)
					if err != nil {
						continue
					}
					allMeasurements = append(allMeasurements, measurements...)
				}
			}
		}

		// Filter to last 24 hours
		for _, m := range allMeasurements {
			if (m.Timestamp.Equal(startTime) || m.Timestamp.After(startTime)) &&
				(m.Timestamp.Before(now) || m.Timestamp.Equal(now)) {
				rawData = append(rawData, m)
			}
		}
	} else {
		// For historical dates, get single day's data
		var err error
		rawData, err = nfm.GetHistoricalData(date, band)
		if err != nil {
			return nil, err
		}
	}

	if len(rawData) == 0 {
		return nil, fmt.Errorf("no data available")
	}

	// Group measurements into 10-minute buckets
	bucketSize := 10 * time.Minute
	buckets := make(map[int64]map[string][]*BandMeasurement)

	for _, m := range rawData {
		// Calculate bucket timestamp (rounded down to 10-minute boundary)
		bucketTime := m.Timestamp.Truncate(bucketSize).Unix()

		if buckets[bucketTime] == nil {
			buckets[bucketTime] = make(map[string][]*BandMeasurement)
		}

		buckets[bucketTime][m.Band] = append(buckets[bucketTime][m.Band], m)
	}

	// Average each bucket
	averaged := make([]*BandMeasurement, 0)

	for bucketTime, bandData := range buckets {
		for bandName, measurements := range bandData {
			if len(measurements) == 0 {
				continue
			}

			// Calculate averages
			var sumMin, sumMax, sumMean, sumMedian, sumP5, sumP10, sumP95, sumDynRange, sumOccupancy, sumFT8SNR float32
			count := float32(len(measurements))

			for _, m := range measurements {
				sumMin += m.MinDB
				sumMax += m.MaxDB
				sumMean += m.MeanDB
				sumMedian += m.MedianDB
				sumP5 += m.P5DB
				sumP10 += m.P10DB
				sumP95 += m.P95DB
				sumDynRange += m.DynamicRange
				sumOccupancy += m.OccupancyPct
				sumFT8SNR += m.FT8SNR
			}

			averaged = append(averaged, &BandMeasurement{
				Timestamp:    time.Unix(bucketTime, 0),
				Band:         bandName,
				MinDB:        sumMin / count,
				MaxDB:        sumMax / count,
				MeanDB:       sumMean / count,
				MedianDB:     sumMedian / count,
				P5DB:         sumP5 / count,
				P10DB:        sumP10 / count,
				P95DB:        sumP95 / count,
				DynamicRange: sumDynRange / count,
				OccupancyPct: sumOccupancy / count,
				FT8SNR:       sumFT8SNR / count,
			})
		}
	}

	// Sort by timestamp (oldest first)
	sort.Slice(averaged, func(i, j int) bool {
		return averaged[i].Timestamp.Before(averaged[j].Timestamp)
	})

	return averaged, nil
}

// GetTrendDataAllBands returns 24 hours of data for all bands averaged in 10-minute chunks
// This is more efficient than calling GetTrendData for each band individually
func (nfm *NoiseFloorMonitor) GetTrendDataAllBands() (map[string][]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}

	// Get today's date for rolling 24-hour window
	today := time.Now().Format("2006-01-02")
	now := time.Now()
	startTime := now.Add(-24 * time.Hour)
	startDate := startTime.Format("2006-01-02")

	dates := []string{today}
	if startDate != today {
		dates = append([]string{startDate}, dates...)
	}

	// Read data from relevant dates for all bands
	var allMeasurements []*BandMeasurement
	for _, d := range dates {
		for _, bandConfig := range nfm.config.NoiseFloor.Bands {
			measurements, err := nfm.readBandFile(bandConfig.Name, d)
			if err != nil {
				continue
			}
			allMeasurements = append(allMeasurements, measurements...)
		}
	}

	// Filter to last 24 hours
	var rawData []*BandMeasurement
	for _, m := range allMeasurements {
		if (m.Timestamp.Equal(startTime) || m.Timestamp.After(startTime)) &&
			(m.Timestamp.Before(now) || m.Timestamp.Equal(now)) {
			rawData = append(rawData, m)
		}
	}

	if len(rawData) == 0 {
		return nil, fmt.Errorf("no data available")
	}

	// Group measurements into 10-minute buckets by band
	bucketSize := 10 * time.Minute
	buckets := make(map[int64]map[string][]*BandMeasurement)

	for _, m := range rawData {
		// Calculate bucket timestamp (rounded down to 10-minute boundary)
		bucketTime := m.Timestamp.Truncate(bucketSize).Unix()

		if buckets[bucketTime] == nil {
			buckets[bucketTime] = make(map[string][]*BandMeasurement)
		}

		buckets[bucketTime][m.Band] = append(buckets[bucketTime][m.Band], m)
	}

	// Average each bucket and organize by band
	result := make(map[string][]*BandMeasurement)

	for bucketTime, bandData := range buckets {
		for bandName, measurements := range bandData {
			if len(measurements) == 0 {
				continue
			}

			// Calculate averages
			var sumMin, sumMax, sumMean, sumMedian, sumP5, sumP10, sumP95, sumDynRange, sumOccupancy, sumFT8SNR float32
			count := float32(len(measurements))

			for _, m := range measurements {
				sumMin += m.MinDB
				sumMax += m.MaxDB
				sumMean += m.MeanDB
				sumMedian += m.MedianDB
				sumP5 += m.P5DB
				sumP10 += m.P10DB
				sumP95 += m.P95DB
				sumDynRange += m.DynamicRange
				sumOccupancy += m.OccupancyPct
				sumFT8SNR += m.FT8SNR
			}

			averaged := &BandMeasurement{
				Timestamp:    time.Unix(bucketTime, 0),
				Band:         bandName,
				MinDB:        sumMin / count,
				MaxDB:        sumMax / count,
				MeanDB:       sumMean / count,
				MedianDB:     sumMedian / count,
				P5DB:         sumP5 / count,
				P10DB:        sumP10 / count,
				P95DB:        sumP95 / count,
				DynamicRange: sumDynRange / count,
				OccupancyPct: sumOccupancy / count,
				FT8SNR:       sumFT8SNR / count,
			}

			result[bandName] = append(result[bandName], averaged)
		}
	}

	// Sort each band's data by timestamp (oldest first)
	for bandName := range result {
		sort.Slice(result[bandName], func(i, j int) bool {
			return result[bandName][i].Timestamp.Before(result[bandName][j].Timestamp)
		})
	}

	return result, nil
}

// readBandFile reads a single band's CSV file for a specific date
func (nfm *NoiseFloorMonitor) readBandFile(band, date string) ([]*BandMeasurement, error) {
	// Parse date to create year/month/day directory structure
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("invalid date format: %w", err)
	}

	// Build path: base_dir/YYYY/MM/DD/band.csv
	filename := filepath.Join(
		nfm.config.NoiseFloor.DataDir,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
		fmt.Sprintf("%s.csv", band),
	)

	file, err := os.Open(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to open file: %w", err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("Warning: error closing file %s: %v", filename, err)
		}
	}()

	reader := csv.NewReader(file)
	// Allow variable number of fields per record for backward compatibility
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("failed to read CSV: %w", err)
	}

	if len(records) < 2 {
		return nil, fmt.Errorf("no data in file")
	}

	// Skip header
	records = records[1:]

	measurements := make([]*BandMeasurement, 0, len(records))
	for _, record := range records {
		// Need at least 10 columns (old format without FT8 SNR)
		// New format has 11 columns (with FT8 SNR)
		if len(record) < 10 {
			continue
		}

		timestamp, err := time.Parse(time.RFC3339, record[0])
		if err != nil {
			continue
		}

		m := &BandMeasurement{
			Timestamp: timestamp,
			Band:      band, // Band comes from filename, not CSV
		}

		// Parse float values (no band column in per-band files)
		_, _ = fmt.Sscanf(record[1], "%f", &m.MinDB)
		_, _ = fmt.Sscanf(record[2], "%f", &m.MaxDB)
		_, _ = fmt.Sscanf(record[3], "%f", &m.MeanDB)
		_, _ = fmt.Sscanf(record[4], "%f", &m.MedianDB)
		_, _ = fmt.Sscanf(record[5], "%f", &m.P5DB)
		_, _ = fmt.Sscanf(record[6], "%f", &m.P10DB)
		_, _ = fmt.Sscanf(record[7], "%f", &m.P95DB)
		_, _ = fmt.Sscanf(record[8], "%f", &m.DynamicRange)
		_, _ = fmt.Sscanf(record[9], "%f", &m.OccupancyPct)

		// Parse FT8 SNR if available (for backward compatibility with old CSV files)
		if len(record) >= 11 {
			_, _ = fmt.Sscanf(record[10], "%f", &m.FT8SNR)
		}

		measurements = append(measurements, m)
	}

	return measurements, nil
}

// GetAvailableDates returns a list of dates for which data is available
// Scans the year/month/day directory structure
// If includeToday is false, excludes today's date since it uses a rolling 24-hour window
func (nfm *NoiseFloorMonitor) GetAvailableDates(includeToday bool) ([]string, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}

	dateMap := make(map[string]bool)
	today := time.Now().Format("2006-01-02")

	// Walk through year directories
	yearDirs, err := os.ReadDir(nfm.config.NoiseFloor.DataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read data directory: %w", err)
	}

	for _, yearDir := range yearDirs {
		if !yearDir.IsDir() {
			continue
		}
		year := yearDir.Name()

		// Walk through month directories
		monthPath := filepath.Join(nfm.config.NoiseFloor.DataDir, year)
		monthDirs, err := os.ReadDir(monthPath)
		if err != nil {
			continue
		}

		for _, monthDir := range monthDirs {
			if !monthDir.IsDir() {
				continue
			}
			month := monthDir.Name()

			// Walk through day directories
			dayPath := filepath.Join(monthPath, month)
			dayDirs, err := os.ReadDir(dayPath)
			if err != nil {
				continue
			}

			for _, dayDir := range dayDirs {
				if !dayDir.IsDir() {
					continue
				}
				day := dayDir.Name()

				// Check if this day directory has any CSV files
				csvPath := filepath.Join(dayPath, day)
				files, err := os.ReadDir(csvPath)
				if err != nil {
					continue
				}

				hasCSV := false
				for _, file := range files {
					if !file.IsDir() && filepath.Ext(file.Name()) == ".csv" {
						hasCSV = true
						break
					}
				}

				if hasCSV {
					// Format as YYYY-MM-DD
					date := fmt.Sprintf("%s-%s-%s", year, month, day)
					// Conditionally exclude today's date based on includeToday parameter
					if includeToday || date != today {
						dateMap[date] = true
					}
				}
			}
		}
	}

	// Convert map to sorted slice
	dates := make([]string, 0, len(dateMap))
	for date := range dateMap {
		dates = append(dates, date)
	}

	// Sort dates in descending order (newest first)
	sort.Slice(dates, func(i, j int) bool {
		return dates[i] > dates[j]
	})

	return dates, nil
}

// GetLatestFFT returns the max-hold FFT data for a specific band over 1 second
// Uses max hold instead of averaging to preserve transient peaks (e.g., FT8 signals)
func (nfm *NoiseFloorMonitor) GetLatestFFT(band string) *BandFFT {
	nfm.fftMu.RLock()
	defer nfm.fftMu.RUnlock()

	if buffer, ok := nfm.fftBuffers[band]; ok {
		// Return 1-second max hold for real-time display (preserves peaks)
		fft := buffer.GetMaxHoldFFT(1 * time.Second)
		if fft == nil && DebugMode {
			log.Printf("DEBUG: FFT max hold returned nil for band %s (may need more samples)", band)
		}

		// Add markers if FFT data is available
		if fft != nil {
			fft.Markers = nfm.getMarkersForBand(band)
		}

		return fft
	}
	if DebugMode {
		log.Printf("DEBUG: No FFT buffer found for band %s", band)
	}
	return nil
}

// getMarkersForBand returns frequency markers for a specific band
func (nfm *NoiseFloorMonitor) getMarkersForBand(bandName string) []FrequencyMarker {
	markers := make([]FrequencyMarker, 0)

	// Find the band configuration
	for i := range nfm.config.NoiseFloor.Bands {
		if nfm.config.NoiseFloor.Bands[i].Name == bandName {
			bandConfig := &nfm.config.NoiseFloor.Bands[i]

			// Add FT8 marker if configured
			if bandConfig.FT8Frequency > 0 {
				markers = append(markers, FrequencyMarker{
					DisplayName: "FT8",
					Frequency:   bandConfig.FT8Frequency,
					Bandwidth:   3000, // 3 kHz bandwidth
					Sideband:    "upper",
				})
			}
			break
		}
	}

	return markers
}

// GetAveragedFFT returns the averaged FFT data for a specific band over a custom duration
func (nfm *NoiseFloorMonitor) GetAveragedFFT(band string, duration time.Duration) *BandFFT {
	nfm.fftMu.RLock()
	defer nfm.fftMu.RUnlock()

	if buffer, ok := nfm.fftBuffers[band]; ok {
		return buffer.GetAveragedFFT(duration)
	}
	return nil
}

// GetWideBandFFT returns the averaged FFT data for the wide-band spectrum (0-30 MHz) over 10 seconds
// Uses averaging instead of max-hold to reject lightning spikes and other brief transients
func (nfm *NoiseFloorMonitor) GetWideBandFFT() *BandFFT {
	nfm.fftMu.RLock()
	defer nfm.fftMu.RUnlock()

	if nfm.wideBandFFTBuffer != nil {
		// Return 10-second average for wide-band display (rejects lightning spikes)
		fft := nfm.wideBandFFTBuffer.GetAveragedFFT(10 * time.Second)
		if fft == nil && DebugMode {
			log.Printf("DEBUG: Wide-band FFT max hold returned nil (may need more samples)")
		}

		// No markers for wide-band spectrum (covers all bands)
		return fft
	}
	if DebugMode {
		log.Printf("DEBUG: No wide-band FFT buffer found")
	}
	return nil
}

// watchdogLoop monitors for stalled spectrum channels and attempts reconnection
func (nfm *NoiseFloorMonitor) watchdogLoop() {
	defer nfm.wg.Done()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-nfm.stopChan:
			return
		case <-ticker.C:
			nfm.checkAndReconnectStalled()
		}
	}
}

// checkAndReconnectStalled checks for bands that haven't received data and attempts reconnection
func (nfm *NoiseFloorMonitor) checkAndReconnectStalled() {
	now := time.Now()
	stallThreshold := 90 * time.Second    // Consider stalled if no data for 90 seconds
	reconnectCooldown := 60 * time.Second // Don't reconnect more than once per minute

	for bandName, bs := range nfm.bandSpectrums {
		bs.mu.Lock()
		lastData := bs.LastDataTime
		lastReconnect := bs.LastReconnect
		bs.mu.Unlock()

		// Skip if we've never received data yet (still initializing)
		if lastData.IsZero() {
			continue
		}

		// Check if channel is stalled
		timeSinceData := now.Sub(lastData)
		if timeSinceData > stallThreshold {
			// Check if we're in cooldown period
			timeSinceReconnect := now.Sub(lastReconnect)
			if timeSinceReconnect < reconnectCooldown {
				if DebugMode {
					log.Printf("DEBUG: Band %s stalled (%.0fs since data) but in reconnect cooldown (%.0fs since last attempt)",
						bandName, timeSinceData.Seconds(), timeSinceReconnect.Seconds())
				}
				continue
			}

			log.Printf("WARNING: Band %s spectrum stalled (%.0fs since last data), attempting reconnection with same SSRC 0x%08x",
				bandName, timeSinceData.Seconds(), bs.SSRC)

			// Update reconnect time
			bs.mu.Lock()
			bs.LastReconnect = now
			bs.mu.Unlock()

			// Attempt to recreate the channel with the same SSRC
			if err := nfm.reconnectBand(bandName, bs); err != nil {
				log.Printf("ERROR: Failed to reconnect band %s: %v", bandName, err)
			} else {
				log.Printf("Successfully requested reconnection for band %s", bandName)
			}
		}
	}
}

// reconnectBand attempts to recreate a spectrum channel for a band using the same SSRC
func (nfm *NoiseFloorMonitor) reconnectBand(bandName string, bs *BandSpectrum) error {
	channelName := fmt.Sprintf("noisefloor-%s", bandName)

	if DebugMode {
		log.Printf("DEBUG: Reconnecting %s - freq: %d Hz, bins: %d, bw: %.1f Hz, SSRC: 0x%08x",
			bandName, bs.Band.CenterFrequency, bs.Band.BinCount, bs.Band.BinBandwidth, bs.SSRC)
	}

	// Request the channel again with the same SSRC
	// radiod should recognize the SSRC and resume sending data
	if err := nfm.radiod.CreateSpectrumChannel(
		channelName,
		bs.Band.CenterFrequency,
		bs.Band.BinCount,
		bs.Band.BinBandwidth,
		bs.SSRC,
	); err != nil {
		return fmt.Errorf("failed to recreate spectrum channel: %w", err)
	}

	return nil
}
