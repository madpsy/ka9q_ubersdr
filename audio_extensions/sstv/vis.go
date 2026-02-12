package sstv

import (
	"log"
	"math"
)

/*
 * VIS Code Detection
 * Ported from KiwiSDR/extensions/SSTV/sstv_vis.cpp
 *
 * Original copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)
 * Go port (c) 2026, UberSDR project
 *
 * VIS (Vertical Interval Signaling) Code Structure:
 * - 300ms 1900 Hz calibration tone (leader)
 * - 10ms break
 * - 300ms 1900 Hz leader
 * - 30ms 1200 Hz start bit
 * - 8 x 30ms data bits (1100 Hz = 1, 1300 Hz = 0)
 * - 30ms 1200 Hz stop bit
 *
 * Extended VIS-16 (MMSSTV):
 * - Same as above but 16 data bits instead of 8
 */

const (
	// VIS detection parameters
	visLeaderFreq = 1900.0 // Hz - calibration tone
	visStartFreq  = 1200.0 // Hz - start bit
	visStopFreq   = 1200.0 // Hz - stop bit
	visBit0Freq   = 1300.0 // Hz - data bit 0
	visBit1Freq   = 1100.0 // Hz - data bit 1
	visBitTime    = 30e-3  // seconds - duration of each bit
	visLeaderTime = 300e-3 // seconds - leader tone duration
	visTolerance  = 25.0   // Hz - frequency tolerance
)

// VISDetector handles VIS code detection
type VISDetector struct {
	sampleRate float64
	fftSize    int

	// Buffers
	headerBuf []float64 // Circular buffer of detected frequencies
	headerPtr int       // Current position in header buffer
	toneBuf   []float64 // Recent tone frequencies for pattern matching

	// Hann window for FFT
	hannWindow []float64

	// FFT buffers
	fftInput  []float64
	fftOutput []complex128

	// State tracking for iterative processing
	iterationCount int
	lastToneReport int
	toneWin        int // Window size for tone pattern matching

	// Callback for tone frequency updates
	toneCallback func(freq float64)
}

// NewVISDetector creates a new VIS code detector
func NewVISDetector(sampleRate float64) *VISDetector {
	const headerBufSize = 100 // 100 * 10ms = 1 second buffer
	const toneBufSize = 100   // For pattern matching

	// Create 20ms Hann window
	samps20ms := int(sampleRate * 20e-3)
	hannWindow := make([]float64, samps20ms)
	for i := 0; i < samps20ms; i++ {
		hannWindow[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(samps20ms-1)))
	}

	return &VISDetector{
		sampleRate:     sampleRate,
		fftSize:        2048,
		headerBuf:      make([]float64, headerBufSize),
		toneBuf:        make([]float64, toneBufSize),
		hannWindow:     hannWindow,
		fftInput:       make([]float64, 2048),
		fftOutput:      make([]complex128, 2048),
		iterationCount: 0,
		lastToneReport: 0,
		toneWin:        45, // 450ms window for 8-bit VIS
	}
}

// SetToneCallback sets a callback function to receive tone frequency updates
func (v *VISDetector) SetToneCallback(callback func(freq float64)) {
	v.toneCallback = callback
}

// ProcessIteration processes one 10ms iteration of VIS detection
// Returns: mode index, header shift (Hz), extended VIS flag, success
// This should be called repeatedly until it returns success=true
func (v *VISDetector) ProcessIteration(pcmBuffer *CircularPCMBuffer) (uint8, int, bool, bool) {
	samps10ms := int(v.sampleRate * 10e-3)
	samps20ms := len(v.hannWindow)

	v.iterationCount++

	// We need enough samples to:
	// 1. Have a 20ms window for FFT analysis
	// 2. Have accumulated enough history for VIS pattern detection (at least 450ms for 8-bit VIS)
	minRequired := samps20ms
	if v.iterationCount > 1 {
		// After first iteration, we need more history for pattern matching
		minRequired = int(v.sampleRate * 0.5) // 500ms buffer
	}

	if pcmBuffer.Available() < minRequired {
		return 0, 0, false, false
	}

	// Get 20ms window for FFT - get the LATEST 20ms of audio
	// We want samples from (current position - 20ms) to (current position)
	// Since readPtr points to oldest available sample, and we have 'filled' samples,
	// the newest sample is at readPtr + filled - 1
	// So we want: [readPtr + filled - samps20ms] to [readPtr + filled]
	// Which is offset = filled - samps20ms, length = samps20ms
	windowOffset := pcmBuffer.Available() - samps20ms
	window, err := pcmBuffer.GetWindowAbsolute(windowOffset, samps20ms)
	if err != nil {
		log.Printf("[SSTV VIS] Failed to get FFT window: %v (available=%d, need=%d)",
			err, pcmBuffer.Available(), samps20ms)
		return 0, 0, false, false
	}

	// Clear FFT input buffer
	for i := range v.fftInput {
		v.fftInput[i] = 0
	}

	// Apply Hann window
	for i := 0; i < samps20ms; i++ {
		v.fftInput[i] = float64(window[i]) / 32768.0 * v.hannWindow[i]
	}

	// Perform FFT
	fft(v.fftInput, v.fftOutput)

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

	// Gaussian interpolation for peak frequency
	var peakFreq float64
	minBinFreq := v.getBin(500.0)
	maxBinFreq := v.getBin(3300.0)

	if maxBin > minBinFreq && maxBin < maxBinFreq &&
		powers[maxBin] > 0 && powers[maxBin-1] > 0 && powers[maxBin+1] > 0 {

		pwr_mb := powers[maxBin]
		pwr_mo := powers[maxBin-1]
		pwr_po := powers[maxBin+1]

		numerator := pwr_po / pwr_mo
		denominator := (pwr_mb * pwr_mb) / (pwr_po * pwr_mo)

		if numerator > 0 && denominator > 0 && math.Abs(math.Log(denominator)) > 1e-9 {
			delta := math.Log(numerator) / (2.0 * math.Log(denominator))
			peakFreq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
		} else {
			peakFreq = float64(maxBin) / float64(v.fftSize) * v.sampleRate
		}
	} else {
		prevIdx := (v.headerPtr - 1 + len(v.headerBuf)) % len(v.headerBuf)
		if prevIdx < 0 {
			prevIdx = len(v.headerBuf) - 1
		}
		peakFreq = v.headerBuf[prevIdx]
	}

	// Store in circular buffer
	v.headerBuf[v.headerPtr] = peakFreq
	v.headerPtr = (v.headerPtr + 1) % len(v.headerBuf)

	// Report tone frequency every 500ms (50 iterations)
	if v.toneCallback != nil && v.iterationCount-v.lastToneReport >= 50 {
		v.toneCallback(peakFreq)
		v.lastToneReport = v.iterationCount
	}

	// Debug logging every 100 iterations (1 second)
	if v.iterationCount%100 == 0 {
		log.Printf("[SSTV VIS] Iteration %d: freq=%.1f Hz, headerPtr=%d, toneWin=%d",
			v.iterationCount, peakFreq, v.headerPtr, v.toneWin)
	}

	// Copy recent frequencies to tone buffer
	hp := v.headerPtr - 1
	for i := v.toneWin - 1; i >= 0; i-- {
		if hp < 0 {
			hp = len(v.headerBuf) - 1
		}
		if i < len(v.toneBuf) {
			v.toneBuf[i] = v.headerBuf[hp]
		}
		hp--
	}

	// Look for VIS pattern
	headerShift := 0
	gotVIS := false

	// Only start looking for VIS after we have enough history
	if v.iterationCount < 45 {
		// Need at least 450ms of history for 8-bit VIS
		// Consume 10ms and continue
		_, _ = pcmBuffer.Read(samps10ms)
		return 0, 0, false, false
	}

	for i := 0; i < 3 && !gotVIS; i++ {
		for j := 0; j < 3 && !gotVIS; j++ {
			refFreq := v.toneBuf[0+j]

			// Check for leader pattern (1900 Hz for ~300ms = 30 iterations)
			if !v.checkTone(1*3+i, refFreq, visTolerance) ||
				!v.checkTone(2*3+i, refFreq, visTolerance) ||
				!v.checkTone(3*3+i, refFreq, visTolerance) ||
				!v.checkTone(4*3+i, refFreq, visTolerance) {
				continue
			}

			// Check for start bit (1200 Hz = refFreq - 700)
			if !v.checkTone(5*3+i, refFreq-700, 25) {
				continue
			}

			// Log potential VIS detection
			if v.iterationCount%10 == 0 {
				log.Printf("[SSTV VIS] Potential leader at i=%d, j=%d, refFreq=%.1f Hz", i, j, refFreq)
			}

			// Try to read data bits
			bits := make([]uint8, 16)
			k := 0
			for k = 0; k < 16; k++ {
				toneIdx := 6*3 + i + 3*k
				if toneIdx >= len(v.toneBuf) {
					break
				}

				freq := v.toneBuf[toneIdx]

				if freq > refFreq-625 && freq < refFreq-575 {
					bits[k] = 0 // 1300 Hz
				} else if freq > refFreq-825 && freq < refFreq-775 {
					bits[k] = 1 // 1100 Hz
				} else {
					break
				}
			}

			nbits := 0

			// Check for 8-bit VIS
			if k == 8 {
				stopIdx := 14*3 + i
				if stopIdx < len(v.toneBuf) {
					stopFreq := v.toneBuf[stopIdx]
					if stopFreq > refFreq-725 && stopFreq < refFreq-675 {
						nbits = 8
						gotVIS = true
					}
				}
			}

			// Check for extended 16-bit VIS
			if k == 9 {
				v.toneWin = 70 // Extend to 700ms for 16-bit VIS
				break
			}

			if k == 16 {
				stopIdx := 22*3 + i
				if stopIdx < len(v.toneBuf) {
					stopFreq := v.toneBuf[stopIdx]
					if stopFreq > refFreq-725 && stopFreq < refFreq-675 {
						nbits = 16
						gotVIS = true
					}
				}
			}

			if gotVIS {
				headerShift = int(refFreq - visLeaderFreq)

				// Decode VIS code
				vis := bits[0] | (bits[1] << 1) | (bits[2] << 2) | (bits[3] << 3) |
					(bits[4] << 4) | (bits[5] << 5) | (bits[6] << 6)
				parityBit := bits[7]
				parity := bits[0] ^ bits[1] ^ bits[2] ^ bits[3] ^ bits[4] ^ bits[5] ^ bits[6]

				var vis2 uint8
				var parityBit2, parity2 uint8

				if nbits == 16 {
					vis2 = bits[8] | (bits[9] << 1) | (bits[10] << 2) | (bits[11] << 3) |
						(bits[12] << 4) | (bits[13] << 5) | (bits[14] << 6)
					parityBit2 = bits[15]
					parity2 = parity ^ bits[8] ^ bits[9] ^ bits[10] ^ bits[11] ^
						bits[12] ^ bits[13] ^ bits[14]
				}

				// Special case: R12BW has inverted parity
				if VISMap[vis] == ModeR12BW {
					parity = 1 - parity
				}

				// Check parity
				parityOK := true
				if nbits == 8 && parity != parityBit {
					parityOK = false
				} else if nbits == 16 && parity2 != parityBit2 {
					parityOK = false
				}

				if !parityOK {
					gotVIS = false
					continue
				}

				// Check if mode is known
				if VISMap[vis] == ModeUnknown {
					gotVIS = false
					continue
				}

				if nbits == 16 && (VISMap[vis] != ModeVISX || VISXMap[vis2] == ModeUnknown) {
					gotVIS = false
					continue
				}

				// Determine mode
				var mode uint8
				if nbits == 8 {
					mode = VISMap[vis]
				} else {
					mode = VISXMap[vis2]
				}

				// Get mode spec
				modeSpec := GetModeByIndex(mode)
				if modeSpec == nil {
					gotVIS = false
					continue
				}

				if modeSpec.Unsupported {
					gotVIS = false
					continue
				}

				// Log only when VIS is detected
				if nbits == 8 {
					log.Printf("[SSTV VIS] ✓ Detected mode: %s (VIS=%d, 0x%02x) @ %+d Hz",
						modeSpec.Name, vis, vis, headerShift)
				} else {
					log.Printf("[SSTV VIS] ✓ Detected mode: %s (VISX=%d|%d, 0x%02x|0x%02x) @ %+d Hz",
						modeSpec.Name, vis, vis2, vis, vis2, headerShift)
				}

				return mode, headerShift, nbits == 16, true
			}
		}
	}

	// Consume 10ms of samples to advance
	_, _ = pcmBuffer.Read(samps10ms)

	return 0, 0, false, false
}

// DetectVISStreaming is kept for compatibility but now uses ProcessIteration
func (v *VISDetector) DetectVISStreaming(pcmBuffer *CircularPCMBuffer) (uint8, int, bool, bool) {
	return v.ProcessIteration(pcmBuffer)
}

// DetectVIS is the legacy interface
func (v *VISDetector) DetectVIS(pcmReader PCMReader) (uint8, int, bool, bool) {
	log.Printf("[SSTV] Warning: Using legacy DetectVIS interface")
	return 0, 0, false, false
}

// checkTone checks if the tone at the given index matches the expected frequency
func (v *VISDetector) checkTone(idx int, expectedFreq, tolerance float64) bool {
	if idx < 0 || idx >= len(v.toneBuf) {
		return false
	}
	freq := v.toneBuf[idx]
	match := freq > expectedFreq-tolerance && freq < expectedFreq+tolerance

	// Debug logging for tone checks (only occasionally to avoid spam)
	if v.iterationCount%200 == 0 && idx < 10 {
		log.Printf("[SSTV VIS] checkTone[%d]: freq=%.1f Hz, expected=%.1f±%.1f Hz, match=%v",
			idx, freq, expectedFreq, tolerance, match)
	}

	return match
}

// getBin converts a frequency to an FFT bin index
func (v *VISDetector) getBin(freq float64) int {
	return int(freq / v.sampleRate * float64(v.fftSize))
}

// PCMReader interface for reading PCM samples
type PCMReader interface {
	Read(numSamples int) ([]int16, error)
}
