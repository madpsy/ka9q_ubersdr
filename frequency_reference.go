package main

import (
	"fmt"
	"log"
	"math"
	"math/rand"
	"sort"
	"sync"
	"time"
)

// FrequencyReferenceMonitor tracks an external frequency reference tone
// Uses a narrow 1 kHz spectrum window to detect and track the reference signal
// All frequency calculations are performed in the backend
type FrequencyReferenceMonitor struct {
	config   *Config
	radiod   *RadiodController
	sessions *SessionManager

	// Narrow spectrum session (1 kHz wide)
	refSpectrum   *BandSpectrum
	spectrumReady bool

	// Detection results (all calculated in backend)
	detectedFreq    float64   // Detected frequency in Hz (from peak detection + interpolation)
	frequencyOffset float64   // Offset from expected in Hz (detected - expected)
	signalStrength  float32   // Peak power in dBFS
	snr             float32   // Signal-to-noise ratio in dB (peak - noise floor)
	noiseFloor      float32   // Noise floor in dBFS (P5 percentile)
	peakBin         int       // Bin index of detected peak
	lastUpdate      time.Time // Last update timestamp
	latestSpectrum  []float32 // Latest unwrapped spectrum data for frontend display
	mu              sync.RWMutex

	// Spectrum parameters
	centerFreq   uint64  // Center frequency in Hz
	binCount     int     // Number of FFT bins
	binBandwidth float64 // Frequency per bin in Hz

	// Historical tracking (1-second samples, 1-minute means, 1-hour means)
	samples         []FrequencyReferenceSample  // Current minute's samples (up to 60)
	history         []FrequencyReferenceHistory // Historical minute means (up to 60)
	hourlyHistory   []FrequencyReferenceHistory // Historical hour means (up to 24)
	historyMu       sync.RWMutex
	sampleTicker    *time.Ticker
	aggregateTicker *time.Ticker
	hourlyTicker    *time.Ticker

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// FrequencyReferenceSample represents a single 1-second sample
type FrequencyReferenceSample struct {
	DetectedFreq    float64
	FrequencyOffset float64
	SignalStrength  float32
	SNR             float32
	NoiseFloor      float32
	Timestamp       time.Time
}

// FrequencyReferenceHistory represents aggregated 1-minute mean values
type FrequencyReferenceHistory struct {
	DetectedFreq    float64   `json:"detected_frequency"`
	FrequencyOffset float64   `json:"frequency_offset"`
	SignalStrength  float32   `json:"signal_strength"`
	SNR             float32   `json:"snr"`
	NoiseFloor      float32   `json:"noise_floor"`
	Timestamp       time.Time `json:"timestamp"`
}

// NewFrequencyReferenceMonitor creates a new frequency reference monitor
func NewFrequencyReferenceMonitor(config *Config, radiod *RadiodController, sessions *SessionManager) (*FrequencyReferenceMonitor, error) {
	if !config.FrequencyReference.Enabled {
		return nil, nil // Disabled
	}

	frm := &FrequencyReferenceMonitor{
		config:       config,
		radiod:       radiod,
		sessions:     sessions,
		stopChan:     make(chan struct{}),
		centerFreq:   config.FrequencyReference.Frequency,
		binCount:     500,
		binBandwidth: 2.0, // 2 Hz/bin (radiod minimum), 500 bins × 2 Hz = 1000 Hz total
	}

	return frm, nil
}

// Start begins frequency reference monitoring
func (frm *FrequencyReferenceMonitor) Start() error {
	if frm == nil {
		return nil // Disabled
	}

	frm.running = true

	log.Printf("Creating frequency reference spectrum session at %.6f MHz (1 kHz wide, %.2f Hz resolution)",
		float64(frm.centerFreq)/1e6, frm.binBandwidth)

	// Generate random SSRC
	ssrc := uint32(rand.Int31())
	if ssrc == 0 || ssrc == 0xffffffff {
		ssrc = 1
	}

	// Ensure SSRC is unique
	frm.sessions.mu.RLock()
	for {
		if _, exists := frm.sessions.ssrcToSession[ssrc]; !exists {
			break
		}
		ssrc = uint32(rand.Int31())
		if ssrc == 0 || ssrc == 0xffffffff {
			ssrc = 1
		}
	}
	frm.sessions.mu.RUnlock()

	// Create narrow spectrum channel (1 kHz wide centered on reference frequency)
	channelName := "frequency-reference"
	if err := frm.radiod.CreateSpectrumChannel(
		channelName,
		frm.centerFreq,
		frm.binCount,
		frm.binBandwidth,
		ssrc,
	); err != nil {
		return fmt.Errorf("failed to create frequency reference spectrum channel: %w", err)
	}

	// Create spectrum channel for receiving data
	spectrumChan := make(chan []float32, 10)

	// Register spectrum session with session manager
	sessionID := fmt.Sprintf("frequency-reference-%08x", ssrc)
	session := &Session{
		ID:           sessionID,
		ChannelName:  "frequency-reference", // Used to identify channel type in radiod channels list
		SSRC:         ssrc,
		IsSpectrum:   true,
		Frequency:    frm.centerFreq,
		BinCount:     frm.binCount,
		BinBandwidth: frm.binBandwidth,
		SpectrumChan: spectrumChan,
		CreatedAt:    time.Now(),
		LastActive:   time.Now(),
	}

	frm.sessions.mu.Lock()
	frm.sessions.sessions[sessionID] = session
	frm.sessions.ssrcToSession[ssrc] = session
	frm.sessions.mu.Unlock()

	// Store spectrum info
	frm.refSpectrum = &BandSpectrum{
		Band: NoiseFloorBand{
			Name:            "frequency-reference",
			Start:           frm.centerFreq - 500, // -500 Hz
			End:             frm.centerFreq + 500, // +500 Hz
			CenterFrequency: frm.centerFreq,
			BinCount:        frm.binCount,
			BinBandwidth:    frm.binBandwidth,
		},
		SSRC:         ssrc,
		SessionID:    sessionID,
		SpectrumChan: spectrumChan,
	}

	frm.spectrumReady = true

	// Initialize historical tracking
	frm.samples = make([]FrequencyReferenceSample, 0, 60)
	frm.history = make([]FrequencyReferenceHistory, 0, 60)
	frm.hourlyHistory = make([]FrequencyReferenceHistory, 0, 24)
	frm.sampleTicker = time.NewTicker(1 * time.Second)
	frm.aggregateTicker = time.NewTicker(1 * time.Minute)
	frm.hourlyTicker = time.NewTicker(1 * time.Hour)

	// Start monitoring loop
	frm.wg.Add(1)
	go frm.monitorLoop()

	// Start sampling loop
	frm.wg.Add(1)
	go frm.sampleLoop()

	// Start aggregation loop
	frm.wg.Add(1)
	go frm.aggregateLoop()

	// Start hourly aggregation loop
	frm.wg.Add(1)
	go frm.hourlyAggregateLoop()

	log.Printf("Frequency reference monitor started (%.6f MHz ± 500 Hz, %.2f Hz resolution, max drift: ±%.1f Hz)",
		float64(frm.centerFreq)/1e6, frm.binBandwidth, frm.config.FrequencyReference.MaxDriftFreq)

	return nil
}

// Stop shuts down the frequency reference monitor
func (frm *FrequencyReferenceMonitor) Stop() {
	if frm == nil || !frm.running {
		return
	}

	frm.running = false
	close(frm.stopChan)

	// Stop tickers
	if frm.sampleTicker != nil {
		frm.sampleTicker.Stop()
	}
	if frm.aggregateTicker != nil {
		frm.aggregateTicker.Stop()
	}
	if frm.hourlyTicker != nil {
		frm.hourlyTicker.Stop()
	}

	frm.wg.Wait()

	// Disable spectrum channel
	if frm.spectrumReady && frm.refSpectrum != nil {
		if err := frm.radiod.DisableChannel("frequency-reference", frm.refSpectrum.SSRC); err != nil {
			log.Printf("Warning: failed to disable frequency reference channel: %v", err)
		}

		// Remove from session manager
		frm.sessions.mu.Lock()
		delete(frm.sessions.sessions, frm.refSpectrum.SessionID)
		delete(frm.sessions.ssrcToSession, frm.refSpectrum.SSRC)
		frm.sessions.mu.Unlock()

		close(frm.refSpectrum.SpectrumChan)
	}

	log.Printf("Frequency reference monitor stopped")
}

// monitorLoop receives and processes spectrum data continuously
func (frm *FrequencyReferenceMonitor) monitorLoop() {
	defer frm.wg.Done()

	for {
		select {
		case <-frm.stopChan:
			return

		case spectrum := <-frm.refSpectrum.SpectrumChan:
			// Update last data time
			frm.refSpectrum.mu.Lock()
			frm.refSpectrum.LastDataTime = time.Now()
			frm.refSpectrum.mu.Unlock()

			// Process spectrum data (unwrap FFT and detect peak)
			frm.processSpectrum(spectrum)
		}
	}
}

// processSpectrum unwraps FFT data and detects the reference tone
// All frequency calculations are performed here in the backend
func (frm *FrequencyReferenceMonitor) processSpectrum(spectrum []float32) {
	// Unwrap FFT bin ordering from radiod (same as noise_floor.go does)
	// radiod sends: [positive freqs (DC to +Nyquist), negative freqs (-Nyquist to DC)]
	// We need: [negative freqs, positive freqs] for low-to-high frequency display
	N := len(spectrum)
	halfBins := N / 2
	unwrapped := make([]float32, N)

	// Put second half (negative frequencies) first
	copy(unwrapped[0:halfBins], spectrum[halfBins:N])
	// Put first half (positive frequencies) second
	copy(unwrapped[halfBins:N], spectrum[0:halfBins])

	// Detect peak frequency (ALL CALCULATIONS IN BACKEND)
	detectedFreq, signalStrength, peakBin := frm.detectPeakFrequency(unwrapped)

	// Calculate SNR (signal-to-noise ratio) and noise floor
	// Use same method as noise floor: peak power - noise floor (P5)
	snr, noiseFloor := frm.calculateSNR(unwrapped, signalStrength)

	// Calculate offset from expected frequency
	expectedFreq := float64(frm.config.FrequencyReference.Frequency)
	offset := detectedFreq - expectedFreq

	// Store results for API access
	frm.mu.Lock()
	frm.detectedFreq = detectedFreq
	frm.frequencyOffset = offset
	frm.signalStrength = signalStrength
	frm.snr = snr
	frm.noiseFloor = noiseFloor
	frm.peakBin = peakBin
	frm.lastUpdate = time.Now()
	// Store unwrapped spectrum for frontend display
	frm.latestSpectrum = make([]float32, len(unwrapped))
	copy(frm.latestSpectrum, unwrapped)
	frm.mu.Unlock()

}

// sampleLoop collects samples every 1 second
func (frm *FrequencyReferenceMonitor) sampleLoop() {
	defer frm.wg.Done()

	for {
		select {
		case <-frm.stopChan:
			return

		case <-frm.sampleTicker.C:
			// Take a snapshot of current values
			frm.mu.RLock()
			detectedFreq := frm.detectedFreq
			sample := FrequencyReferenceSample{
				DetectedFreq:    frm.detectedFreq,
				FrequencyOffset: frm.frequencyOffset,
				SignalStrength:  frm.signalStrength,
				SNR:             frm.snr,
				NoiseFloor:      frm.noiseFloor,
				Timestamp:       time.Now(),
			}
			frm.mu.RUnlock()

			// Only sample if we have a valid detection (detected frequency > 0)
			// Skip samples when no signal is detected to avoid polluting statistics
			if detectedFreq > 0 {
				// Add to current minute's samples
				frm.historyMu.Lock()
				frm.samples = append(frm.samples, sample)
				// Keep only last 60 samples (shouldn't exceed this, but safety check)
				if len(frm.samples) > 60 {
					frm.samples = frm.samples[len(frm.samples)-60:]
				}
				frm.historyMu.Unlock()
			}
		}
	}
}

// removeOutliersSamples removes outliers from samples using IQR method on frequency offset
// Returns filtered samples, or original if too few samples to filter
func removeOutliersSamples(samples []FrequencyReferenceSample) []FrequencyReferenceSample {
	if len(samples) < 4 {
		return samples // Need at least 4 samples for meaningful IQR
	}

	// Extract frequency offsets and sort them
	offsets := make([]float64, len(samples))
	for i, s := range samples {
		offsets[i] = s.FrequencyOffset
	}
	sort.Float64s(offsets)

	// Calculate quartiles
	n := len(offsets)
	q1 := offsets[n/4]
	q3 := offsets[3*n/4]
	iqr := q3 - q1

	// Calculate bounds (1.5 * IQR is standard for outlier detection)
	lowerBound := q1 - 1.5*iqr
	upperBound := q3 + 1.5*iqr

	// Filter samples within bounds
	filtered := make([]FrequencyReferenceSample, 0, len(samples))
	for _, s := range samples {
		if s.FrequencyOffset >= lowerBound && s.FrequencyOffset <= upperBound {
			filtered = append(filtered, s)
		}
	}

	// If we filtered out too many samples (>50%), return original
	// This prevents over-filtering when data is legitimately variable
	if len(filtered) < len(samples)/2 {
		return samples
	}

	return filtered
}

// removeOutliersHistory removes outliers from history entries using IQR method on frequency offset
// Returns filtered history, or original if too few entries to filter
func removeOutliersHistory(history []FrequencyReferenceHistory) []FrequencyReferenceHistory {
	if len(history) < 4 {
		return history // Need at least 4 entries for meaningful IQR
	}

	// Extract frequency offsets and sort them
	offsets := make([]float64, len(history))
	for i, h := range history {
		offsets[i] = h.FrequencyOffset
	}
	sort.Float64s(offsets)

	// Calculate quartiles
	n := len(offsets)
	q1 := offsets[n/4]
	q3 := offsets[3*n/4]
	iqr := q3 - q1

	// Calculate bounds (1.5 * IQR is standard for outlier detection)
	lowerBound := q1 - 1.5*iqr
	upperBound := q3 + 1.5*iqr

	// Filter history within bounds
	filtered := make([]FrequencyReferenceHistory, 0, len(history))
	for _, h := range history {
		if h.FrequencyOffset >= lowerBound && h.FrequencyOffset <= upperBound {
			filtered = append(filtered, h)
		}
	}

	// If we filtered out too many entries (>50%), return original
	// This prevents over-filtering when data is legitimately variable
	if len(filtered) < len(history)/2 {
		return history
	}

	return filtered
}

// aggregateLoop calculates mean values every 1 minute
func (frm *FrequencyReferenceMonitor) aggregateLoop() {
	defer frm.wg.Done()

	for {
		select {
		case <-frm.stopChan:
			return

		case <-frm.aggregateTicker.C:
			frm.historyMu.Lock()

			// Calculate means from samples if we have any
			if len(frm.samples) > 0 {
				// Remove outliers using IQR method
				filteredSamples := removeOutliersSamples(frm.samples)

				var sumDetectedFreq float64
				var sumFrequencyOffset float64
				var sumSignalStrength float32
				var sumSNR float32
				var sumNoiseFloor float32

				for _, sample := range filteredSamples {
					sumDetectedFreq += sample.DetectedFreq
					sumFrequencyOffset += sample.FrequencyOffset
					sumSignalStrength += sample.SignalStrength
					sumSNR += sample.SNR
					sumNoiseFloor += sample.NoiseFloor
				}

				count := float64(len(filteredSamples))
				countFloat32 := float32(len(filteredSamples))

				historyEntry := FrequencyReferenceHistory{
					DetectedFreq:    sumDetectedFreq / count,
					FrequencyOffset: sumFrequencyOffset / count,
					SignalStrength:  sumSignalStrength / countFloat32,
					SNR:             sumSNR / countFloat32,
					NoiseFloor:      sumNoiseFloor / countFloat32,
					Timestamp:       time.Now(),
				}

				// Add to history
				frm.history = append(frm.history, historyEntry)

				// Keep only last 60 entries (60 minutes)
				if len(frm.history) > 60 {
					frm.history = frm.history[len(frm.history)-60:]
				}

				// Clear samples for next minute
				frm.samples = frm.samples[:0]
			}

			frm.historyMu.Unlock()
		}
	}
}

// hourlyAggregateLoop calculates mean values every 1 hour from minute-level history
func (frm *FrequencyReferenceMonitor) hourlyAggregateLoop() {
	defer frm.wg.Done()

	for {
		select {
		case <-frm.stopChan:
			return

		case <-frm.hourlyTicker.C:
			frm.historyMu.Lock()

			// Calculate means from the last 60 minute entries if we have any
			if len(frm.history) > 0 {
				// Remove outliers using IQR method
				filteredHistory := removeOutliersHistory(frm.history)

				var sumDetectedFreq float64
				var sumFrequencyOffset float64
				var sumSignalStrength float32
				var sumSNR float32
				var sumNoiseFloor float32

				for _, entry := range filteredHistory {
					sumDetectedFreq += entry.DetectedFreq
					sumFrequencyOffset += entry.FrequencyOffset
					sumSignalStrength += entry.SignalStrength
					sumSNR += entry.SNR
					sumNoiseFloor += entry.NoiseFloor
				}

				count := float64(len(filteredHistory))
				countFloat32 := float32(len(filteredHistory))

				hourlyEntry := FrequencyReferenceHistory{
					DetectedFreq:    sumDetectedFreq / count,
					FrequencyOffset: sumFrequencyOffset / count,
					SignalStrength:  sumSignalStrength / countFloat32,
					SNR:             sumSNR / countFloat32,
					NoiseFloor:      sumNoiseFloor / countFloat32,
					Timestamp:       time.Now(),
				}

				// Add to hourly history
				frm.hourlyHistory = append(frm.hourlyHistory, hourlyEntry)

				// Keep only last 24 entries (24 hours)
				if len(frm.hourlyHistory) > 24 {
					frm.hourlyHistory = frm.hourlyHistory[len(frm.hourlyHistory)-24:]
				}
			}

			frm.historyMu.Unlock()
		}
	}
}

// detectPeakFrequency finds the strongest signal in the spectrum and calculates its precise frequency
// For flat-top signals (like reference tones), uses centroid calculation across contiguous peak bins
// Prefers peaks near the center (expected frequency) when they're reasonably strong
// Only searches within max_drift_freq Hz of the expected frequency to avoid false locks
// Returns: detected frequency (Hz), signal strength (dBFS), peak bin index
func (frm *FrequencyReferenceMonitor) detectPeakFrequency(spectrum []float32) (float64, float32, int) {
	if len(spectrum) == 0 {
		return 0, -999, -1
	}

	// Calculate search range based on max_drift_freq
	// Only search within ±max_drift_freq Hz of expected frequency
	maxDriftHz := frm.config.FrequencyReference.MaxDriftFreq
	centerBinIdx := len(spectrum) / 2
	driftBins := int(maxDriftHz / frm.binBandwidth)

	searchStart := centerBinIdx - driftBins
	searchEnd := centerBinIdx + driftBins

	// Clamp to spectrum bounds
	if searchStart < 0 {
		searchStart = 0
	}
	if searchEnd >= len(spectrum) {
		searchEnd = len(spectrum) - 1
	}

	// Find bin with maximum power within allowed drift range
	maxPower := float32(-999)
	maxBin := -1

	for i := searchStart; i <= searchEnd; i++ {
		if spectrum[i] > maxPower {
			maxPower = spectrum[i]
			maxBin = i
		}
	}

	if maxBin < 0 || maxBin >= len(spectrum) {
		return 0, maxPower, maxBin
	}

	// Calculate noise floor to check SNR (P5 percentile)
	sorted := make([]float32, len(spectrum))
	copy(sorted, spectrum)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})
	noiseFloor := sorted[len(sorted)*5/100]

	// Check if peak meets minimum SNR threshold
	peakSNR := maxPower - noiseFloor
	minSNR := frm.config.FrequencyReference.MinSNR
	if peakSNR < minSNR {
		// Peak is too weak (likely noise), return no detection
		if DebugMode {
			log.Printf("Frequency reference: peak SNR %.1f dB below minimum %.1f dB, ignoring", peakSNR, minSNR)
		}
		return 0, maxPower, -1
	}

	// Check if there's a strong peak near the center (expected frequency)
	// If so, prefer it over a slightly stronger peak further away
	centerRegionStart := centerBinIdx - 5 // ±5 bins = ±10 Hz
	centerRegionEnd := centerBinIdx + 5

	// Find strongest peak in center region
	centerPeakPower := float32(-999)
	centerPeakBin := -1

	for i := centerRegionStart; i <= centerRegionEnd && i >= 0 && i < len(spectrum); i++ {
		if spectrum[i] > centerPeakPower {
			centerPeakPower = spectrum[i]
			centerPeakBin = i
		}
	}

	// Check if center peak also meets minimum SNR threshold
	centerPeakSNR := centerPeakPower - noiseFloor

	// If center peak has sufficient SNR and is within 30 dB of global max, prefer it
	// This prioritizes the reference tone at the expected frequency
	if centerPeakBin >= 0 && centerPeakSNR >= minSNR && (maxPower-centerPeakPower) <= 30.0 {
		maxBin = centerPeakBin
		maxPower = centerPeakPower
	}

	// For flat-top signals, use centroid calculation over a narrow range
	// Only consider bins CONTIGUOUS with the peak to avoid distant noise peaks
	threshold := maxPower - 3.0 // 3 dB below peak

	// Find contiguous range around peak that's above threshold
	startBin := maxBin
	endBin := maxBin

	// Expand left while above threshold
	for i := maxBin - 1; i >= 0 && spectrum[i] >= threshold; i-- {
		startBin = i
	}

	// Expand right while above threshold
	for i := maxBin + 1; i < len(spectrum) && spectrum[i] >= threshold; i++ {
		endBin = i
	}

	// Calculate centroid only over this contiguous range
	var weightedSum float64
	var totalWeight float64

	for i := startBin; i <= endBin; i++ {
		// Convert dBFS to linear power for proper weighting
		linearPower := math.Pow(10.0, float64(spectrum[i])/10.0)
		weightedSum += float64(i) * linearPower
		totalWeight += linearPower
	}

	// Calculate centroid (power-weighted average bin position)
	var centroidBin float64
	if totalWeight > 0 {
		centroidBin = weightedSum / totalWeight
	} else {
		// Fallback to parabolic interpolation if centroid fails
		if maxBin > 0 && maxBin < len(spectrum)-1 {
			alpha := float64(spectrum[maxBin-1])
			beta := float64(spectrum[maxBin])
			gamma := float64(spectrum[maxBin+1])

			denominator := alpha - 2*beta + gamma
			if math.Abs(denominator) > 0.001 {
				p := 0.5 * (alpha - gamma) / denominator
				if p > 0.5 {
					p = 0.5
				} else if p < -0.5 {
					p = -0.5
				}
				centroidBin = float64(maxBin) + p
			} else {
				centroidBin = float64(maxBin)
			}
		} else {
			centroidBin = float64(maxBin)
		}
	}

	// Convert bin index to frequency
	// After unwrapping: bins 0 to N/2-1 are negative frequencies (below center)
	//                   bins N/2 to N-1 are positive frequencies (above center)
	centerBin := float64(len(spectrum)) / 2.0
	binOffset := centroidBin - centerBin

	// Frequency = center + (bin offset from center) * bin bandwidth
	detectedFreq := float64(frm.centerFreq) + (binOffset * frm.binBandwidth)

	// Final validation: ensure detected frequency is within max_drift_freq
	// This catches cases where centroid calculation drifted outside the allowed range
	expectedFreq := float64(frm.config.FrequencyReference.Frequency)
	frequencyOffset := math.Abs(detectedFreq - expectedFreq)
	if frequencyOffset > maxDriftHz {
		// Detected frequency is outside allowed drift range, reject it
		return 0, maxPower, -1
	}

	return detectedFreq, maxPower, maxBin
}

// calculateSNR calculates the signal-to-noise ratio and noise floor
// Uses the same method as noise floor monitoring: peak power - noise floor (P5)
// Returns: SNR (dB), noise floor (dBFS)
func (frm *FrequencyReferenceMonitor) calculateSNR(spectrum []float32, peakPower float32) (float32, float32) {
	if len(spectrum) == 0 {
		return 0, -999
	}

	// Sort data to find 5th percentile (noise floor)
	sorted := make([]float32, len(spectrum))
	copy(sorted, spectrum)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	n := len(sorted)
	noiseFloor := sorted[n*5/100] // 5th percentile

	// SNR = Signal - Noise (in dB)
	snr := peakPower - noiseFloor

	return snr, noiseFloor
}

// GetStatus returns the current frequency reference status
// All calculations are already done in processSpectrum()
// Frontend receives pre-calculated values ready for display
func (frm *FrequencyReferenceMonitor) GetStatus() map[string]interface{} {
	if frm == nil {
		return map[string]interface{}{
			"enabled": false,
		}
	}

	frm.mu.RLock()
	defer frm.mu.RUnlock()

	return map[string]interface{}{
		"enabled":            true,
		"expected_frequency": frm.config.FrequencyReference.Frequency, // Hz
		"detected_frequency": frm.detectedFreq,                        // Hz (calculated in backend)
		"frequency_offset":   frm.frequencyOffset,                     // Hz (calculated in backend)
		"signal_strength":    frm.signalStrength,                      // dBFS (peak power)
		"snr":                frm.snr,                                 // dB (signal-to-noise ratio)
		"noise_floor":        frm.noiseFloor,                          // dBFS (P5 percentile)
		"peak_bin":           frm.peakBin,                             // Bin index for marker
		"spectrum_data":      frm.latestSpectrum,                      // Full FFT array for chart
		"last_update":        frm.lastUpdate,                          // Timestamp
		"bin_count":          frm.binCount,                            // 500
		"bin_bandwidth":      frm.binBandwidth,                        // 2.0 Hz
	}
}

// GetHistory returns the historical frequency reference data (up to 60 minutes)
func (frm *FrequencyReferenceMonitor) GetHistory() []FrequencyReferenceHistory {
	if frm == nil {
		return nil
	}

	frm.historyMu.RLock()
	defer frm.historyMu.RUnlock()

	// Return a copy with rounded values for display
	historyCopy := make([]FrequencyReferenceHistory, len(frm.history))
	for i, entry := range frm.history {
		historyCopy[i] = FrequencyReferenceHistory{
			DetectedFreq:    math.Round(entry.DetectedFreq*100) / 100,                   // 2 decimal places
			FrequencyOffset: math.Round(entry.FrequencyOffset*100) / 100,                // 2 decimal places
			SignalStrength:  float32(math.Round(float64(entry.SignalStrength)*10) / 10), // 1 decimal place
			SNR:             float32(math.Round(float64(entry.SNR)*10) / 10),            // 1 decimal place
			NoiseFloor:      float32(math.Round(float64(entry.NoiseFloor)*10) / 10),     // 1 decimal place
			Timestamp:       entry.Timestamp,
		}
	}

	return historyCopy
}

// GetHourlyHistory returns the hourly aggregated frequency reference data (up to 24 hours)
// Includes a partial entry for the current hour calculated from available minute-level data
func (frm *FrequencyReferenceMonitor) GetHourlyHistory() []FrequencyReferenceHistory {
	if frm == nil {
		return nil
	}

	frm.historyMu.RLock()
	defer frm.historyMu.RUnlock()

	// Start with a copy of stored complete hours with rounded values
	result := make([]FrequencyReferenceHistory, len(frm.hourlyHistory))
	for i, entry := range frm.hourlyHistory {
		result[i] = FrequencyReferenceHistory{
			DetectedFreq:    math.Round(entry.DetectedFreq*100) / 100,                   // 2 decimal places
			FrequencyOffset: math.Round(entry.FrequencyOffset*100) / 100,                // 2 decimal places
			SignalStrength:  float32(math.Round(float64(entry.SignalStrength)*10) / 10), // 1 decimal place
			SNR:             float32(math.Round(float64(entry.SNR)*10) / 10),            // 1 decimal place
			NoiseFloor:      float32(math.Round(float64(entry.NoiseFloor)*10) / 10),     // 1 decimal place
			Timestamp:       entry.Timestamp,
		}
	}

	// Calculate and append current partial hour from minute-level history
	if len(frm.history) > 0 {
		// Remove outliers using IQR method for partial hour calculation
		filteredHistory := removeOutliersHistory(frm.history)

		var sumDetectedFreq float64
		var sumFrequencyOffset float64
		var sumSignalStrength float32
		var sumSNR float32
		var sumNoiseFloor float32

		for _, entry := range filteredHistory {
			sumDetectedFreq += entry.DetectedFreq
			sumFrequencyOffset += entry.FrequencyOffset
			sumSignalStrength += entry.SignalStrength
			sumSNR += entry.SNR
			sumNoiseFloor += entry.NoiseFloor
		}

		count := float64(len(filteredHistory))
		countFloat32 := float32(len(filteredHistory))

		partialHourEntry := FrequencyReferenceHistory{
			DetectedFreq:    math.Round((sumDetectedFreq/count)*100) / 100,                        // 2 decimal places
			FrequencyOffset: math.Round((sumFrequencyOffset/count)*100) / 100,                     // 2 decimal places
			SignalStrength:  float32(math.Round(float64(sumSignalStrength/countFloat32)*10) / 10), // 1 decimal place
			SNR:             float32(math.Round(float64(sumSNR/countFloat32)*10) / 10),            // 1 decimal place
			NoiseFloor:      float32(math.Round(float64(sumNoiseFloor/countFloat32)*10) / 10),     // 1 decimal place
			Timestamp:       time.Now(),
		}

		result = append(result, partialHourEntry)

		// Keep only last 24 entries total (23 complete + 1 partial, or up to 24)
		if len(result) > 24 {
			result = result[len(result)-24:]
		}
	}

	return result
}

// GetHealthStatus analyzes the 60-minute history to determine health status
// Returns health status with mean offset, standard deviation, and any issues
func (frm *FrequencyReferenceMonitor) GetHealthStatus() map[string]interface{} {
	if frm == nil {
		return map[string]interface{}{
			"enabled": false,
			"healthy": true,
		}
	}

	frm.historyMu.RLock()
	history := frm.history
	frm.historyMu.RUnlock()

	// Check if we have recent data (within last 5 minutes)
	frm.mu.RLock()
	lastUpdate := frm.lastUpdate
	frm.mu.RUnlock()

	timeSinceUpdate := time.Since(lastUpdate)
	
	result := map[string]interface{}{
		"enabled":       true,
		"healthy":       true,
		"issues":        []string{},
		"mean_offset":   0.0,
		"stddev_offset": 0.0,
	}

	issues := []string{}

	// Check data freshness
	if timeSinceUpdate > 5*time.Minute {
		issues = append(issues, fmt.Sprintf("No data received in last %.0f minutes", timeSinceUpdate.Minutes()))
		result["healthy"] = false
	}

	// Need at least 10 minutes of data for meaningful statistics
	if len(history) < 10 {
		if len(history) > 0 {
			issues = append(issues, fmt.Sprintf("Insufficient history data (%d minutes, need 10+)", len(history)))
		} else {
			issues = append(issues, "No history data available yet")
		}
		result["issues"] = issues
		result["healthy"] = len(issues) == 0
		return result
	}

	// Calculate mean and standard deviation of frequency offsets
	var sumOffset float64
	for _, entry := range history {
		sumOffset += entry.FrequencyOffset
	}
	meanOffset := sumOffset / float64(len(history))

	var sumSquaredDiff float64
	for _, entry := range history {
		diff := entry.FrequencyOffset - meanOffset
		sumSquaredDiff += diff * diff
	}
	stddevOffset := math.Sqrt(sumSquaredDiff / float64(len(history)))

	result["mean_offset"] = math.Round(meanOffset*100) / 100       // 2 decimal places
	result["stddev_offset"] = math.Round(stddevOffset*100) / 100   // 2 decimal places

	// Check for instability (high standard deviation)
	if stddevOffset > 2.0 {
		issues = append(issues, fmt.Sprintf("Unstable frequency reference (stddev: %.2f Hz > 2 Hz threshold)", stddevOffset))
	}

	// Check for consistent offset (mean offset too high)
	if math.Abs(meanOffset) > 3.0 {
		issues = append(issues, fmt.Sprintf("Consistent frequency offset (mean: %.2f Hz, exceeds ±3 Hz threshold)", meanOffset))
	}

	result["issues"] = issues
	result["healthy"] = len(issues) == 0

	return result
}
