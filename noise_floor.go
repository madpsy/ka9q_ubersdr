package main

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
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

	// SQLite write connection (for INSERTs)
	db *sql.DB

	// SQLite read-only pool (for SELECTs)
	readDB *sql.DB

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
	Timestamp     time.Time `json:"timestamp"`
	Band          string    `json:"band"`
	MinDB         float32   `json:"min_db"`
	MaxDB         float32   `json:"max_db"`
	MeanDB        float32   `json:"mean_db"`
	MedianDB      float32   `json:"median_db"`
	P5DB          float32   `json:"p5_db"`          // 5th percentile - noise floor estimate
	P10DB         float32   `json:"p10_db"`         // 10th percentile
	P95DB         float32   `json:"p95_db"`         // 95th percentile - signal peak
	DynamicRange  float32   `json:"dynamic_range"`  // P95 - P5
	OccupancyPct  float32   `json:"occupancy_pct"`  // % of bins above noise + 10dB
	FT8SNR        float32   `json:"ft8_snr"`        // FT8 SNR in dB (signal power - noise floor)
	SNR_0_30MHz   float32   `json:"snr_0_30_mhz"`   // SNR for 0-30 MHz (dynamic range)
	SNR_1_8_30MHz float32   `json:"snr_1_8_30_mhz"` // SNR for 1.8-30 MHz HF bands (dynamic range)
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

	nfm := &NoiseFloorMonitor{
		config:             config,
		radiod:             radiod,
		sessions:           sessions,
		stopChan:           make(chan struct{}),
		bandSpectrums:      make(map[string]*BandSpectrum),
		latestMeasurements: make(map[string]*BandMeasurement),
		fftBuffers:         make(map[string]*FFTBuffer),
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
	// Uses 4096 bins @ 7.32421875 kHz/bin for exact 0-30 MHz coverage (4096 * 7324.21875 = 30 MHz)
	nfm.wideBandFFTBuffer = NewFFTBuffer(
		"wideband",
		0,              // 0 Hz start
		30000000,       // 30 MHz end
		7324.21875,     // 7324.21875 Hz bin width (30 MHz / 4096 bins = exact coverage)
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
	// Parameters: 15 MHz center, 4096 bins, 7.32421875 kHz/bin for exact 0-30 MHz coverage
	if DebugMode {
		log.Printf("DEBUG: Creating wide-band spectrum - freq: 15000000 Hz, bins: 4096, bw: 7324.21875 Hz")
	}

	if err := nfm.radiod.CreateSpectrumChannel(
		"noisefloor-wideband",
		15000000,   // 15 MHz center (covers 0-30 MHz)
		4096,       // 4096 bins (half of 8192 for lower CPU usage)
		7324.21875, // 7324.21875 Hz per bin (30 MHz / 4096 = exact 0-30 MHz coverage)
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
		IsBackground: true,
		Frequency:    15000000,
		BinCount:     4096,
		BinBandwidth: 7324.21875,
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
			BinBandwidth:    7324.21875,
		},
		SSRC:         wideBandSSRC,
		SessionID:    wideBandSessionID,
		SpectrumChan: wideBandSpectrumChan,
	}

	log.Printf("Created wide-band spectrum session (SSRC: 0x%08x, 7.32 kHz resolution, 0-30 MHz, 4096 bins)", wideBandSSRC)

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
			IsBackground: true,
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

			// Close spectrum channel safely (check if not already closed)
			//
			// MAY NEED FIXING: this close can panic the *sender*, not this
			// goroutine — user_spectrum.go routeSpectrumToSession() sends into
			// this channel because the wide-band session is registered in
			// ssrcToSession, and its Done is nil so the sender's select guard can
			// never fire. The recover() below only protects against a double-close
			// here. Same class of bug as the "panic: send on closed channel" of
			// 2026-07-21; see the note in session.go DestroySession() for the
			// reasoning and the fix applied there.
			if nfm.wideBandSpectrum.SpectrumChan != nil {
				// Use defer/recover to handle potential double-close
				func() {
					defer func() {
						if r := recover(); r != nil {
							// Channel was already closed, ignore
						}
					}()
					close(nfm.wideBandSpectrum.SpectrumChan)
				}()
			}
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

			// Close spectrum channel safely (check if not already closed)
			//
			// MAY NEED FIXING: same issue as the wide-band close above — this can
			// panic user_spectrum.go routeSpectrumToSession() rather than this
			// goroutine, and bandSpectrum's session has a nil Done so the sender's
			// select guard cannot protect it. See session.go DestroySession().
			if bandSpectrum.SpectrumChan != nil {
				// Use defer/recover to handle potential double-close
				func() {
					defer func() {
						if r := recover(); r != nil {
							// Channel was already closed, ignore
						}
					}()
					close(bandSpectrum.SpectrumChan)
				}()
			}
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

	// Calculate wideband SNR measurements (0-30 MHz and 1.8-30 MHz)
	var snr_0_30, snr_1_8_30 float32
	if nfm.wideBandFFTBuffer != nil {
		widebandFFT := nfm.wideBandFFTBuffer.GetAveragedFFT(10 * time.Second)
		if widebandFFT != nil && len(widebandFFT.Data) > 0 {
			// Calculate 0-30 MHz SNR (dynamic range = P95 - P5)
			_, _, fullDynamicRange := calculateDynamicRangeFromFFT(widebandFFT.Data)
			snr_0_30 = fullDynamicRange

			// Calculate 1.8-30 MHz HF SNR
			// Wideband FFT covers 0-30 MHz with bin width of 7324.21875 Hz
			// 1.8 MHz starts at bin: 1800000 / 7324.21875 ≈ 246
			startBin := int(1800000.0 / widebandFFT.BinWidth)
			if startBin < len(widebandFFT.Data) {
				hfBins := widebandFFT.Data[startBin:]
				_, _, hfDynamicRange := calculateDynamicRangeFromFFT(hfBins)
				snr_1_8_30 = hfDynamicRange
			}

			log.Printf("Wideband SNR: 0-30 MHz = %.1f dB, 1.8-30 MHz = %.1f dB", snr_0_30, snr_1_8_30)
		}
	}

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

		// Add wideband SNR measurements to each band measurement
		measurement.SNR_0_30MHz = snr_0_30
		measurement.SNR_1_8_30MHz = snr_1_8_30

		// Store latest measurement
		nfm.measurementsMu.Lock()
		nfm.latestMeasurements[band.Name] = measurement
		nfm.measurementsMu.Unlock()

		// Update Prometheus metrics if enabled
		if nfm.prometheusMetrics != nil {
			nfm.prometheusMetrics.UpdateFromMeasurement(measurement)
		}

		// Log to DB
		if err := nfm.logToDB(measurement); err != nil {
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

// SetDB wires the SQLite write connection into the noise floor monitor.
func (nfm *NoiseFloorMonitor) SetDB(db *sql.DB) {
	nfm.db = db
}

// SetReadDB wires the SQLite read-only pool into the noise floor monitor.
func (nfm *NoiseFloorMonitor) SetReadDB(readDB *sql.DB) {
	nfm.readDB = readDB
}

// logToDB inserts a measurement into the noise_floor SQLite table.
func (nfm *NoiseFloorMonitor) logToDB(m *BandMeasurement) error {
	if nfm.db == nil {
		return fmt.Errorf("noise floor database not configured")
	}
	_, err := nfm.db.Exec(
		`INSERT INTO noise_floor
		 (ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
		  dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.Timestamp.Unix(), m.Band,
		m.MinDB, m.MaxDB, m.MeanDB, m.MedianDB,
		m.P5DB, m.P10DB, m.P95DB,
		m.DynamicRange, m.OccupancyPct,
		m.FT8SNR, m.SNR_0_30MHz, m.SNR_1_8_30MHz,
	)
	if err != nil {
		return fmt.Errorf("[DB] noise_floor insert error: %w", err)
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

// GetHistoricalData returns data for a specific date from the SQLite database.
// Returns only the requested day's data (00:00:00 to 23:59:59).
func (nfm *NoiseFloorMonitor) GetHistoricalData(date string, band string) ([]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}
	if nfm.readDB == nil {
		return nil, fmt.Errorf("noise floor historical data is not available (database not configured)")
	}

	requestedDate, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("invalid date format: %w", err)
	}
	startTS := requestedDate.Unix()
	endTS := requestedDate.Add(24 * time.Hour).Unix()

	query := `SELECT ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
	                 dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz
	          FROM noise_floor
	          WHERE ts >= ? AND ts < ?`
	args := []interface{}{startTS, endTS}
	if band != "" {
		query += " AND band = ?"
		args = append(args, band)
	}
	query += " ORDER BY ts ASC"

	rows, err := nfm.readDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("noise_floor query error: %w", err)
	}
	defer rows.Close()

	var measurements []*BandMeasurement
	for rows.Next() {
		var ts int64
		m := &BandMeasurement{}
		if err := rows.Scan(&ts, &m.Band, &m.MinDB, &m.MaxDB, &m.MeanDB, &m.MedianDB,
			&m.P5DB, &m.P10DB, &m.P95DB, &m.DynamicRange, &m.OccupancyPct,
			&m.FT8SNR, &m.SNR_0_30MHz, &m.SNR_1_8_30MHz); err != nil {
			return nil, fmt.Errorf("noise_floor scan error: %w", err)
		}
		m.Timestamp = time.Unix(ts, 0).UTC()
		measurements = append(measurements, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(measurements) == 0 {
		return nil, fmt.Errorf("no data found for date %s", date)
	}
	return measurements, nil
}

// GetRecentData returns the last hour of data from the SQLite database.
func (nfm *NoiseFloorMonitor) GetRecentData(band string) ([]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}
	if nfm.readDB == nil {
		return nil, fmt.Errorf("noise floor historical data is not available (database not configured)")
	}

	now := time.Now()
	startTS := now.Add(-1 * time.Hour).Unix()
	endTS := now.Unix()

	query := `SELECT ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
	                 dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz
	          FROM noise_floor
	          WHERE ts >= ? AND ts <= ?`
	args := []interface{}{startTS, endTS}
	if band != "" {
		query += " AND band = ?"
		args = append(args, band)
	}
	query += " ORDER BY ts ASC"

	rows, err := nfm.readDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("noise_floor recent query error: %w", err)
	}
	defer rows.Close()

	var measurements []*BandMeasurement
	for rows.Next() {
		var ts int64
		m := &BandMeasurement{}
		if err := rows.Scan(&ts, &m.Band, &m.MinDB, &m.MaxDB, &m.MeanDB, &m.MedianDB,
			&m.P5DB, &m.P10DB, &m.P95DB, &m.DynamicRange, &m.OccupancyPct,
			&m.FT8SNR, &m.SNR_0_30MHz, &m.SNR_1_8_30MHz); err != nil {
			return nil, fmt.Errorf("noise_floor scan error: %w", err)
		}
		m.Timestamp = time.Unix(ts, 0).UTC()
		measurements = append(measurements, m)
	}
	return measurements, rows.Err()
}

// GetTrendData returns 24 hours of data averaged in 10-minute chunks from the SQLite database.
func (nfm *NoiseFloorMonitor) GetTrendData(date string, band string) ([]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}
	if nfm.readDB == nil {
		return nil, fmt.Errorf("noise floor historical data is not available (database not configured)")
	}

	today := time.Now().Format("2006-01-02")
	var rawData []*BandMeasurement

	if date == today {
		// Rolling 24-hour window from DB
		now := time.Now()
		startTS := now.Add(-24 * time.Hour).Unix()
		endTS := now.Unix()

		query := `SELECT ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
		                 dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz
		          FROM noise_floor WHERE ts >= ? AND ts <= ?`
		args := []interface{}{startTS, endTS}
		if band != "" {
			query += " AND band = ?"
			args = append(args, band)
		}
		query += " ORDER BY ts ASC"

		rows, err := nfm.readDB.Query(query, args...)
		if err != nil {
			return nil, fmt.Errorf("noise_floor trend query error: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var ts int64
			m := &BandMeasurement{}
			if err := rows.Scan(&ts, &m.Band, &m.MinDB, &m.MaxDB, &m.MeanDB, &m.MedianDB,
				&m.P5DB, &m.P10DB, &m.P95DB, &m.DynamicRange, &m.OccupancyPct,
				&m.FT8SNR, &m.SNR_0_30MHz, &m.SNR_1_8_30MHz); err != nil {
				return nil, fmt.Errorf("noise_floor scan error: %w", err)
			}
			m.Timestamp = time.Unix(ts, 0).UTC()
			rawData = append(rawData, m)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	} else {
		// Historical date — reuse GetHistoricalData (already DB-backed)
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

// GetTrendDataAllBands returns 24 hours of data for all bands averaged in 10-minute chunks from the SQLite database.
func (nfm *NoiseFloorMonitor) GetTrendDataAllBands() (map[string][]*BandMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}
	if nfm.readDB == nil {
		return nil, fmt.Errorf("noise floor historical data is not available (database not configured)")
	}

	now := time.Now()
	startTS := now.Add(-24 * time.Hour).Unix()
	endTS := now.Unix()

	rows, err := nfm.readDB.Query(
		`SELECT ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
		        dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz
		 FROM noise_floor WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
		startTS, endTS,
	)
	if err != nil {
		return nil, fmt.Errorf("noise_floor all-bands trend query error: %w", err)
	}
	defer rows.Close()

	var rawData []*BandMeasurement
	for rows.Next() {
		var ts int64
		m := &BandMeasurement{}
		if err := rows.Scan(&ts, &m.Band, &m.MinDB, &m.MaxDB, &m.MeanDB, &m.MedianDB,
			&m.P5DB, &m.P10DB, &m.P95DB, &m.DynamicRange, &m.OccupancyPct,
			&m.FT8SNR, &m.SNR_0_30MHz, &m.SNR_1_8_30MHz); err != nil {
			return nil, fmt.Errorf("noise_floor scan error: %w", err)
		}
		m.Timestamp = time.Unix(ts, 0).UTC()
		rawData = append(rawData, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
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

// GetAvailableDates returns a list of dates for which noise floor data exists in the SQLite database.
// If includeToday is false, excludes today's date (it uses a rolling 24-hour window instead).
func (nfm *NoiseFloorMonitor) GetAvailableDates(includeToday bool) ([]string, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}
	if nfm.readDB == nil {
		return nil, fmt.Errorf("noise floor historical data is not available (database not configured)")
	}

	rows, err := nfm.readDB.Query(
		`SELECT DISTINCT DATE(ts, 'unixepoch') AS date FROM noise_floor ORDER BY date DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("noise_floor dates query error: %w", err)
	}
	defer rows.Close()

	today := time.Now().Format("2006-01-02")
	var dates []string
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			return nil, err
		}
		if includeToday || date != today {
			dates = append(dates, date)
		}
	}
	return dates, rows.Err()
}

// GetLatestFFT returns the max-hold FFT data for a specific band.
// The max-hold window matches the background poll period so the window always
// covers exactly one poll cycle — no stale data, no blending across cycles.
// Uses max hold instead of averaging to preserve transient peaks (e.g., FT8 signals).
func (nfm *NoiseFloorMonitor) GetLatestFFT(band string) *BandFFT {
	nfm.fftMu.RLock()
	defer nfm.fftMu.RUnlock()

	if buffer, ok := nfm.fftBuffers[band]; ok {
		// Use the configured background poll period as the max-hold window.
		// This ensures the window covers exactly one poll cycle regardless of
		// whether background_poll_period_ms is 500, 1000, or any other value.
		pollWindow := time.Duration(nfm.config.Spectrum.BackgroundPollPeriodMs) * time.Millisecond
		fft := buffer.GetMaxHoldFFT(pollWindow)
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

// GetWidebandSNR returns the current wideband SNR measurements (0-30 MHz and 1.8-30 MHz)
// Returns -1 for both values if no data is available
func (nfm *NoiseFloorMonitor) GetWidebandSNR() (snr_0_30, snr_1_8_30 float32) {
	if nfm == nil {
		return -1, -1
	}

	nfm.fftMu.RLock()
	defer nfm.fftMu.RUnlock()

	if nfm.wideBandFFTBuffer != nil {
		widebandFFT := nfm.wideBandFFTBuffer.GetAveragedFFT(10 * time.Second)
		if widebandFFT != nil && len(widebandFFT.Data) > 0 {
			// Calculate 0-30 MHz SNR (dynamic range = P95 - P5)
			_, _, fullDynamicRange := calculateDynamicRangeFromFFT(widebandFFT.Data)
			snr_0_30 = fullDynamicRange

			// Calculate 1.8-30 MHz HF SNR
			// Wideband FFT covers 0-30 MHz with bin width of 7324.21875 Hz
			// 1.8 MHz starts at bin: 1800000 / 7324.21875 ≈ 246
			startBin := int(1800000.0 / widebandFFT.BinWidth)
			if startBin < len(widebandFFT.Data) {
				hfBins := widebandFFT.Data[startBin:]
				_, _, hfDynamicRange := calculateDynamicRangeFromFFT(hfBins)
				snr_1_8_30 = hfDynamicRange
			}

			return snr_0_30, snr_1_8_30
		}
	}

	return -1, -1
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

	// If all bands are still stalled 30s after their first reconnect attempt,
	// radiod has likely died and is not recovering. Exit ubersdr so the process
	// manager restarts it, which in turn triggers a fresh radiod restart via
	// entrypoint.sh (touch /var/run/restart-trigger/restart).
	if nfm.config.NoiseFloor.RestartOnStall != nil && *nfm.config.NoiseFloor.RestartOnStall {
		stalledPostReconnect := 0
		eligible := 0
		for _, bs := range nfm.bandSpectrums {
			bs.mu.Lock()
			lastData := bs.LastDataTime
			lastReconnect := bs.LastReconnect
			bs.mu.Unlock()

			if lastData.IsZero() {
				continue // still initialising, don't count
			}
			eligible++
			// Band is stalled AND a reconnect was attempted at least 30s ago with no recovery
			if now.Sub(lastData) > stallThreshold &&
				!lastReconnect.IsZero() &&
				now.Sub(lastReconnect) > 30*time.Second {
				stalledPostReconnect++
			}
		}
		if eligible > 0 && stalledPostReconnect == eligible {
			log.Printf("CRITICAL: All %d bands still stalled 30s after reconnect attempt, exiting for clean restart", eligible)
			os.Exit(0)
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
