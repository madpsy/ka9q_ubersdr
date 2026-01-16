package main

import (
	"fmt"
	"log"
	"math"
	"math/rand"
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
		binCount:     1024,
		binBandwidth: 1000.0 / 1024.0, // 1 kHz / 1024 bins = ~0.98 Hz/bin
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

	// Calculate offset from expected frequency
	expectedFreq := float64(frm.config.FrequencyReference.Frequency)
	offset := detectedFreq - expectedFreq

	// Store results for API access
	frm.mu.Lock()
	frm.detectedFreq = detectedFreq
	frm.frequencyOffset = offset
	frm.signalStrength = signalStrength
	frm.peakBin = peakBin
	frm.lastUpdate = time.Now()
	// Store unwrapped spectrum for frontend display
	frm.latestSpectrum = make([]float32, len(unwrapped))
	copy(frm.latestSpectrum, unwrapped)
	frm.mu.Unlock()

	if DebugMode {
		log.Printf("Frequency reference: detected=%.2f Hz, expected=%.0f Hz, offset=%+.2f Hz, strength=%.1f dBFS, bin=%d",
			detectedFreq, expectedFreq, offset, signalStrength, peakBin)
	}
}

// detectPeakFrequency finds the strongest signal in the spectrum and calculates its precise frequency
// Uses parabolic interpolation for sub-bin accuracy
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

	// Apply parabolic interpolation for sub-bin accuracy
	// This improves frequency resolution from ~9.77 Hz to ~0.1 Hz
	var interpolatedBin float64
	if maxBin > 0 && maxBin < len(spectrum)-1 {
		// Get three points around the peak
		alpha := float64(spectrum[maxBin-1])
		beta := float64(spectrum[maxBin])
		gamma := float64(spectrum[maxBin+1])

		// Parabolic interpolation formula
		// p = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma)
		// This gives the fractional bin offset from maxBin
		denominator := alpha - 2*beta + gamma
		if math.Abs(denominator) > 0.001 {
			p := 0.5 * (alpha - gamma) / denominator
			// Clamp p to reasonable range [-0.5, 0.5]
			if p > 0.5 {
				p = 0.5
			} else if p < -0.5 {
				p = -0.5
			}
			interpolatedBin = float64(maxBin) + p
		} else {
			// Denominator too small, no interpolation
			interpolatedBin = float64(maxBin)
		}
	} else {
		// Peak is at edge, can't interpolate
		interpolatedBin = float64(maxBin)
	}

	// Convert bin index to frequency
	// After unwrapping: bins 0 to N/2-1 are negative frequencies (below center)
	//                   bins N/2 to N-1 are positive frequencies (above center)
	centerBin := float64(len(spectrum)) / 2.0
	binOffset := interpolatedBin - centerBin

	// Frequency = center + (bin offset from center) * bin bandwidth
	detectedFreq := float64(frm.centerFreq) + (binOffset * frm.binBandwidth)

	return detectedFreq, maxPower, maxBin
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
		"signal_strength":    frm.signalStrength,                      // dBFS
		"peak_bin":           frm.peakBin,                             // Bin index for marker
		"spectrum_data":      frm.latestSpectrum,                      // Full FFT array for chart
		"last_update":        frm.lastUpdate,                          // Timestamp
		"bin_count":          frm.binCount,                            // 1024
		"bin_bandwidth":      frm.binBandwidth,                        // ~9.77 Hz
	}
}
