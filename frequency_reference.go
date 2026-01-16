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

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup
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

	// Start monitoring loop
	frm.wg.Add(1)
	go frm.monitorLoop()

	log.Printf("Frequency reference monitor started (%.6f MHz ± 500 Hz, %.2f Hz resolution)",
		float64(frm.centerFreq)/1e6, frm.binBandwidth)

	return nil
}

// Stop shuts down the frequency reference monitor
func (frm *FrequencyReferenceMonitor) Stop() {
	if frm == nil || !frm.running {
		return
	}

	frm.running = false
	close(frm.stopChan)
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

	if DebugMode {
		log.Printf("Frequency reference: detected=%.2f Hz, expected=%.0f Hz, offset=%+.2f Hz, strength=%.1f dBFS, SNR=%.1f dB, bin=%d",
			detectedFreq, expectedFreq, offset, signalStrength, snr, peakBin)
	}
}

// detectPeakFrequency finds the strongest signal in the spectrum and calculates its precise frequency
// For flat-top signals (like reference tones), uses centroid calculation across contiguous peak bins
// Returns: detected frequency (Hz), signal strength (dBFS), peak bin index
func (frm *FrequencyReferenceMonitor) detectPeakFrequency(spectrum []float32) (float64, float32, int) {
	if len(spectrum) == 0 {
		return 0, -999, -1
	}

	// Find bin with maximum power
	maxPower := float32(-999)
	maxBin := -1

	for i, power := range spectrum {
		if power > maxPower {
			maxPower = power
			maxBin = i
		}
	}

	if maxBin < 0 || maxBin >= len(spectrum) {
		return 0, maxPower, maxBin
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
