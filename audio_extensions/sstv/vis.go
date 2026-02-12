package sstv

import (
	"log"
	"math"
)

/*
 * VIS Code Detection
 * Based on slowrx by Oona Räisänen (OH2EIQ)
 * Simplified and adapted for Go
 *
 * VIS (Vertical Interval Signaling) Code Structure:
 * - 300ms 1900 Hz calibration tone (leader)
 * - 10ms break
 * - 300ms 1900 Hz leader
 * - 30ms 1200 Hz start bit
 * - 8 x 30ms data bits (1100 Hz = 1, 1300 Hz = 0)
 * - 30ms 1200 Hz stop bit
 */

// VISDetector handles VIS code detection
type VISDetector struct {
	sampleRate float64
	fftSize    int

	// Buffers
	headerBuf []float64 // Circular buffer of detected frequencies (45 entries = 450ms)
	headerPtr int       // Current position in header buffer
	toneBuf   []float64 // Recent tone frequencies for pattern matching (45 entries)

	// Hann window for FFT
	hannWindow []float64

	// FFT buffers
	fftInput  []float64
	fftOutput []complex128

	// State tracking
	iterationCount int

	// Callback for tone frequency updates
	toneCallback func(freq float64)
}

// NewVISDetector creates a new VIS code detector
func NewVISDetector(sampleRate float64) *VISDetector {
	const headerBufSize = 45 // 45 * 10ms = 450ms buffer

	// Create 20ms Hann window (882 samples at 44.1kHz, scaled for our sample rate)
	samps20ms := int(sampleRate * 20e-3)
	hannWindow := make([]float64, samps20ms)
	for i := 0; i < samps20ms; i++ {
		hannWindow[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(samps20ms-1)))
	}

	return &VISDetector{
		sampleRate:     sampleRate,
		fftSize:        2048,
		headerBuf:      make([]float64, headerBufSize),
		toneBuf:        make([]float64, headerBufSize),
		hannWindow:     hannWindow,
		fftInput:       make([]float64, 2048),
		fftOutput:      make([]complex128, 2048),
		iterationCount: 0,
	}
}

// SetToneCallback sets a callback function to receive tone frequency updates
func (v *VISDetector) SetToneCallback(callback func(freq float64)) {
	v.toneCallback = callback
}

// ProcessIteration processes one 10ms iteration of VIS detection
// Returns: mode index, header shift (Hz), extended VIS flag, success
func (v *VISDetector) ProcessIteration(pcmBuffer *CircularPCMBuffer) (uint8, int, bool, bool) {
	samps10ms := int(v.sampleRate * 10e-3)
	samps20ms := len(v.hannWindow)

	v.iterationCount++

	// Log first iteration
	if v.iterationCount == 1 {
		log.Printf("[SSTV VIS] Starting VIS detection: samps10ms=%d, samps20ms=%d",
			samps10ms, samps20ms)
	}

	// Need enough samples for 20ms FFT window
	if pcmBuffer.Available() < samps20ms {
		if v.iterationCount <= 5 || v.iterationCount%50 == 0 {
			log.Printf("[SSTV VIS] Iteration %d: Waiting for samples (have %d, need %d)",
				v.iterationCount, pcmBuffer.Available(), samps20ms)
		}
		return 0, 0, false, false
	}

	// Log progress every 100 iterations
	if v.iterationCount%100 == 0 {
		log.Printf("[SSTV VIS] Iteration %d: Processing (buffer=%d samples, freq detection active)",
			v.iterationCount, pcmBuffer.Available())
	}

	// Get 20ms window for FFT
	// slowrx: fft.in[i] = pcm.Buffer[pcm.WindowPtr + i - 441]
	// This means the window is CENTERED at WindowPtr, going back samps10ms
	// We need: [current_position - samps10ms - samps20ms] for length samps20ms
	// But since we consume samps10ms each iteration, current position advances
	// So we want the window centered at (Available - samps10ms)

	// Check we have enough for centered window
	if pcmBuffer.Available() < samps10ms+samps20ms {
		if v.iterationCount <= 5 || v.iterationCount%50 == 0 {
			log.Printf("[SSTV VIS] Iteration %d: Need %d samples for centered window (have %d)",
				v.iterationCount, samps10ms+samps20ms, pcmBuffer.Available())
		}
		return 0, 0, false, false
	}

	// Get window centered at (Available - samps10ms)
	// Window goes from (Available - samps10ms - samps20ms) to (Available - samps10ms)
	windowOffset := pcmBuffer.Available() - samps10ms - samps20ms
	window, err := pcmBuffer.GetWindowAbsolute(windowOffset, samps20ms)
	if err != nil {
		log.Printf("[SSTV VIS] Failed to get FFT window: %v", err)
		return 0, 0, false, false
	}

	// Clear FFT input buffer
	for i := range v.fftInput {
		v.fftInput[i] = 0
	}

	// Apply Hann window
	for i := 0; i < samps20ms && i < len(v.fftInput); i++ {
		v.fftInput[i] = float64(window[i]) / 32768.0 * v.hannWindow[i]
	}

	// Perform FFT
	fft(v.fftInput, v.fftOutput)

	// Debug: Check FFT output on first iteration
	if v.iterationCount == 1 {
		totalPower := 0.0
		for i := 0; i < v.fftSize/2; i++ {
			totalPower += real(v.fftOutput[i])*real(v.fftOutput[i]) + imag(v.fftOutput[i])*imag(v.fftOutput[i])
		}
		log.Printf("[SSTV VIS] FFT check: total power=%.2e, fftSize=%d, output len=%d",
			totalPower, v.fftSize, len(v.fftOutput))
	}

	// Find bin with most power in 500-3300 Hz range
	maxBin := 0
	minBin := v.getBin(500.0)
	maxBinLimit := v.getBin(3300.0)

	powers := make([]float64, v.fftSize/2)
	for i := 0; i < v.fftSize/2; i++ {
		powers[i] = real(v.fftOutput[i])*real(v.fftOutput[i]) +
			imag(v.fftOutput[i])*imag(v.fftOutput[i])

		if i >= minBin && i < maxBinLimit && (maxBin == 0 || powers[i] > powers[maxBin]) {
			maxBin = i
		}
	}

	// Debug: Log max bin info every 100 iterations
	if v.iterationCount%100 == 0 {
		maxBinFreq := float64(maxBin) / float64(v.fftSize) * v.sampleRate
		log.Printf("[SSTV VIS] FFT: maxBin=%d (%.1f Hz), power=%.2e, minBin=%d, maxBinLimit=%d",
			maxBin, maxBinFreq, powers[maxBin], minBin, maxBinLimit)
	}

	// Gaussian interpolation for peak frequency
	var peakFreq float64
	if maxBin > minBin && maxBin < maxBinLimit-1 &&
		powers[maxBin] > 0 && powers[maxBin-1] > 0 && powers[maxBin+1] > 0 {

		// Gaussian interpolation (from slowrx)
		numerator := powers[maxBin+1] / powers[maxBin-1]
		denominator := (powers[maxBin] * powers[maxBin]) / (powers[maxBin+1] * powers[maxBin-1])

		if numerator > 0 && denominator > 0 && math.Abs(math.Log(denominator)) > 1e-9 {
			delta := math.Log(numerator) / (2.0 * math.Log(denominator))
			peakFreq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
		} else {
			peakFreq = float64(maxBin) / float64(v.fftSize) * v.sampleRate
		}
	} else {
		// Use previous frequency if invalid
		prevIdx := (v.headerPtr - 1 + len(v.headerBuf)) % len(v.headerBuf)
		if prevIdx < 0 {
			prevIdx = len(v.headerBuf) - 1
		}
		peakFreq = v.headerBuf[prevIdx]
	}

	// Store in circular buffer
	v.headerBuf[v.headerPtr] = peakFreq
	v.headerPtr = (v.headerPtr + 1) % len(v.headerBuf)

	// Report tone frequency periodically
	if v.toneCallback != nil && v.iterationCount%50 == 0 {
		v.toneCallback(peakFreq)
	}

	// Debug: Log detected frequency every 100 iterations
	if v.iterationCount%100 == 0 {
		log.Printf("[SSTV VIS] Iteration %d: Detected freq=%.1f Hz (expecting ~1900 Hz for leader)",
			v.iterationCount, peakFreq)
	}

	// Copy frequencies from last 450ms to tone buffer (in chronological order)
	for i := 0; i < len(v.toneBuf); i++ {
		v.toneBuf[i] = v.headerBuf[(v.headerPtr+i)%len(v.headerBuf)]
	}

	// Only start looking for VIS after we have enough history (450ms)
	if v.iterationCount < 45 {
		// Consume 10ms and continue
		_, _ = pcmBuffer.Read(samps10ms)
		return 0, 0, false, false
	}

	// Look for VIS pattern (based on slowrx algorithm)
	// Try different phase alignments (i) and reference positions (j)
	for i := 0; i < 3; i++ {
		for j := 0; j < 3; j++ {
			refFreq := v.toneBuf[0+j]

			// Debug: Log pattern check attempts every 200 iterations
			if v.iterationCount%200 == 0 && i == 0 && j == 0 {
				log.Printf("[SSTV VIS] Pattern check: refFreq=%.1f Hz, tone[3]=%.1f, tone[6]=%.1f, tone[9]=%.1f, tone[12]=%.1f, tone[15]=%.1f",
					refFreq, v.toneBuf[3], v.toneBuf[6], v.toneBuf[9], v.toneBuf[12], v.toneBuf[15])
			}

			// Check for complete VIS pattern:
			// - 4 leader tones at refFreq (1900 Hz nominal)
			// - start bit at refFreq-700 (1200 Hz nominal)
			// - stop bit at refFreq-700 (1200 Hz nominal)
			if !v.checkToneRange(1*3+i, refFreq-25, refFreq+25) ||
				!v.checkToneRange(2*3+i, refFreq-25, refFreq+25) ||
				!v.checkToneRange(3*3+i, refFreq-25, refFreq+25) ||
				!v.checkToneRange(4*3+i, refFreq-25, refFreq+25) ||
				!v.checkToneRange(5*3+i, refFreq-725, refFreq-675) || // start bit
				!v.checkToneRange(14*3+i, refFreq-725, refFreq-675) { // stop bit
				continue
			}

			// If we get here, we found a potential VIS!
			log.Printf("[SSTV VIS] *** POTENTIAL VIS FOUND *** at i=%d, j=%d, refFreq=%.1f Hz", i, j, refFreq)

			// Found potential VIS - try to decode the 8 data bits
			bits := make([]uint8, 8)
			validBits := true

			log.Printf("[SSTV VIS] Decoding data bits for potential VIS at i=%d, j=%d, refFreq=%.1f Hz", i, j, refFreq)

			for k := 0; k < 8; k++ {
				toneIdx := 6*3 + i + 3*k
				if toneIdx >= len(v.toneBuf) {
					log.Printf("[SSTV VIS] Bit %d: toneIdx=%d out of range (len=%d)", k, toneIdx, len(v.toneBuf))
					validBits = false
					break
				}

				freq := v.toneBuf[toneIdx]

				// Bit 0: 1300 Hz (refFreq - 600)
				// Bit 1: 1100 Hz (refFreq - 800)
				if freq > refFreq-625 && freq < refFreq-575 {
					bits[k] = 0 // 1300 Hz
					log.Printf("[SSTV VIS] Bit %d [idx=%d]: freq=%.1f Hz -> 0 (1300 Hz nominal)", k, toneIdx, freq)
				} else if freq > refFreq-825 && freq < refFreq-775 {
					bits[k] = 1 // 1100 Hz
					log.Printf("[SSTV VIS] Bit %d [idx=%d]: freq=%.1f Hz -> 1 (1100 Hz nominal)", k, toneIdx, freq)
				} else {
					log.Printf("[SSTV VIS] Bit %d [idx=%d]: freq=%.1f Hz INVALID (need %.1f-%.1f for 0, or %.1f-%.1f for 1)",
						k, toneIdx, freq, refFreq-625, refFreq-575, refFreq-825, refFreq-775)
					validBits = false
					break
				}
			}

			// Log the complete bit pattern
			if validBits {
				visValue := bits[0] | (bits[1] << 1) | (bits[2] << 2) | (bits[3] << 3) |
					(bits[4] << 4) | (bits[5] << 5) | (bits[6] << 6)
				log.Printf("[SSTV VIS] Decoded VIS=%d (0x%02x), bits=%d%d%d%d%d%d%d%d, parity bit=%d",
					visValue, visValue, bits[0], bits[1], bits[2], bits[3], bits[4], bits[5], bits[6], bits[7])
			}

			if !validBits {
				log.Printf("[SSTV VIS] Data bits invalid, continuing search")
				continue
			}

			log.Printf("[SSTV VIS] All 8 data bits decoded successfully!")

			// Decode VIS code
			vis := bits[0] | (bits[1] << 1) | (bits[2] << 2) | (bits[3] << 3) |
				(bits[4] << 4) | (bits[5] << 5) | (bits[6] << 6)
			parityBit := bits[7]
			parity := bits[0] ^ bits[1] ^ bits[2] ^ bits[3] ^ bits[4] ^ bits[5] ^ bits[6]

			// Special case: R12BW has inverted parity
			if VISMap[vis] == ModeR12BW {
				parity = 1 - parity
				log.Printf("[SSTV VIS] R12BW detected, inverting parity")
			}

			// Check parity
			if parity != parityBit {
				log.Printf("[SSTV VIS] Parity fail for VIS=%d (0x%02x): calculated=%d, received=%d, mode=%d",
					vis, vis, parity, parityBit, VISMap[vis])
				continue
			}

			// Check if mode is known
			if VISMap[vis] == ModeUnknown {
				log.Printf("[SSTV VIS] Unknown VIS code: %d (0x%02x)", vis, vis)
				continue
			}

			// Calculate header shift
			headerShift := int(refFreq - 1900)

			// Get mode spec
			mode := VISMap[vis]
			modeSpec := GetModeByIndex(mode)
			if modeSpec == nil || modeSpec.Unsupported {
				continue
			}

			log.Printf("[SSTV VIS] ✓ Detected mode: %s (VIS=%d, 0x%02x) @ %+d Hz",
				modeSpec.Name, vis, vis, headerShift)

			return mode, headerShift, false, true
		}
	}

	// No VIS found, consume 10ms and continue
	_, _ = pcmBuffer.Read(samps10ms)

	return 0, 0, false, false
}

// checkToneRange checks if the tone at the given index is within the frequency range
func (v *VISDetector) checkToneRange(idx int, minFreq, maxFreq float64) bool {
	if idx < 0 || idx >= len(v.toneBuf) {
		return false
	}
	freq := v.toneBuf[idx]
	return freq > minFreq && freq < maxFreq
}

// getBin converts a frequency to an FFT bin index
func (v *VISDetector) getBin(freq float64) int {
	return int(freq / v.sampleRate * float64(v.fftSize))
}

// DetectVISStreaming is kept for compatibility
func (v *VISDetector) DetectVISStreaming(pcmBuffer *CircularPCMBuffer) (uint8, int, bool, bool) {
	return v.ProcessIteration(pcmBuffer)
}

// DetectVIS is the legacy interface (not used)
func (v *VISDetector) DetectVIS(pcmReader PCMReader) (uint8, int, bool, bool) {
	log.Printf("[SSTV] Warning: Using legacy DetectVIS interface")
	return 0, 0, false, false
}

// PCMReader interface for reading PCM samples
type PCMReader interface {
	Read(numSamples int) ([]int16, error)
}
