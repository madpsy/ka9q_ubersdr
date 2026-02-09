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

	// PCM buffer for streaming (matches KiwiSDR's approach)
	pcmBuffer *CircularPCMBuffer
	windowPtr int // Current window position (like KiwiSDR's WindowPtr)

	// Callback for tone frequency updates
	toneCallback func(freq float64)
}

// NewVISDetector creates a new VIS code detector
func NewVISDetector(sampleRate float64) *VISDetector {
	const headerBufSize = 100 // 100 * 10ms = 1 second buffer
	const toneBufSize = 100   // For pattern matching
	const pcmBufSize = 4096   // Match KiwiSDR's PCM_BUFLEN

	// Create 20ms Hann window
	samps20ms := int(sampleRate * 20e-3)
	hannWindow := make([]float64, samps20ms)
	for i := 0; i < samps20ms; i++ {
		hannWindow[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(samps20ms-1)))
	}

	return &VISDetector{
		sampleRate: sampleRate,
		fftSize:    2048,
		headerBuf:  make([]float64, headerBufSize),
		toneBuf:    make([]float64, toneBufSize),
		hannWindow: hannWindow,
		fftInput:   make([]float64, 2048),
		fftOutput:  make([]complex128, 2048),
		pcmBuffer:  NewCircularPCMBuffer(pcmBufSize),
		windowPtr:  0,
	}
}

// SetToneCallback sets a callback function to receive tone frequency updates
func (v *VISDetector) SetToneCallback(callback func(freq float64)) {
	v.toneCallback = callback
}

// DetectVISStreaming attempts to detect a VIS code from streaming audio
// This matches KiwiSDR's exact approach with proper windowing
// Returns: mode index, header shift (Hz), extended VIS flag, success
func (v *VISDetector) DetectVISStreaming(pcmBuffer *CircularPCMBuffer) (uint8, int, bool, bool) {
	v.pcmBuffer = pcmBuffer

	samps10ms := int(v.sampleRate * 10e-3)
	samps20ms := len(v.hannWindow)
	toneWin := 45 // 450ms window for 8-bit VIS

	// Initialize WindowPtr on first run (like KiwiSDR line 88-91)
	if v.windowPtr == 0 {
		// Wait for buffer to fill
		if pcmBuffer.Available() < pcmBuffer.size {
			return 0, 0, false, false
		}
		v.windowPtr = pcmBuffer.size / 2
	}

	// For tone frequency reporting
	iterationCount := 0
	lastToneReport := 0
	lastLeaderLog := 0

	for {
		iterationCount++

		// Read 10ms from buffer (like KiwiSDR line 55: sstv_pcm_read)
		_, err := pcmBuffer.Read(samps10ms)
		if err != nil {
			return 0, 0, false, false
		}

		// WindowPtr moves back relative to new data (like KiwiSDR line 96)
		v.windowPtr -= samps10ms
		if v.windowPtr < 0 {
			v.windowPtr = 0
		}

		// Get 20ms window for FFT, looking backward from WindowPtr
		// KiwiSDR line 58-59: e->fft.in2k[i] = e->pcm.Buffer[e->pcm.WindowPtr + i - samps_10ms]
		windowStart := v.windowPtr - samps10ms
		window, err := pcmBuffer.GetWindowAbsolute(windowStart, samps20ms)
		if err != nil {
			// Not enough data yet, continue accumulating
			continue
		}

		// Clear FFT input buffer
		for i := range v.fftInput {
			v.fftInput[i] = 0
		}

		// Apply Hann window (KiwiSDR line 58-59)
		for i := 0; i < samps20ms; i++ {
			v.fftInput[i] = float64(window[i]) / 32768.0 * v.hannWindow[i]
		}

		// Perform FFT (KiwiSDR line 62)
		fft(v.fftInput, v.fftOutput)

		// Find bin with most power in 500-3300 Hz range (KiwiSDR line 65-72)
		maxBin := 0
		minBin := v.getBin(500.0)
		maxBinLimit := v.getBin(3300.0)

		powers := make([]float64, v.fftSize/2)
		for i := 0; i < v.fftSize/2; i++ {
			// KiwiSDR line 68: Power[i] = POWER(e->fft.out2k[i])
			// where POWER(coeff) = coeff[0]*coeff[0] + coeff[1]*coeff[1]
			powers[i] = real(v.fftOutput[i])*real(v.fftOutput[i]) +
				imag(v.fftOutput[i])*imag(v.fftOutput[i])

			if i >= minBin && i < maxBinLimit && (maxBin == 0 || powers[i] > powers[maxBin]) {
				maxBin = i
			}
		}

		// Gaussian interpolation for peak frequency (KiwiSDR line 74-91)
		var peakFreq float64
		minBinFreq := v.getBin(500.0)
		maxBinFreq := v.getBin(3300.0)

		// KiwiSDR line 83-88: Check bounds and power values
		if maxBin > minBinFreq && maxBin < maxBinFreq &&
			powers[maxBin] > 0 && powers[maxBin-1] > 0 && powers[maxBin+1] > 0 {

			// KiwiSDR's exact Gaussian interpolation formula (line 84)
			pwr_mb := powers[maxBin]
			pwr_mo := powers[maxBin-1]
			pwr_po := powers[maxBin+1]

			// Calculate: MaxBin + log(P+/P-) / (2*log(P^2/(P+*P-)))
			numerator := pwr_po / pwr_mo
			denominator := (pwr_mb * pwr_mb) / (pwr_po * pwr_mo)

			// Check for numerical stability
			if numerator > 0 && denominator > 0 && math.Abs(math.Log(denominator)) > 1e-9 {
				delta := math.Log(numerator) / (2.0 * math.Log(denominator))

				// Apply interpolation and convert to Hz (KiwiSDR line 84, 91)
				peakFreq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
			} else {
				// Fallback to bin center frequency
				peakFreq = float64(maxBin) / float64(v.fftSize) * v.sampleRate
			}
		} else {
			// Use previous value (KiwiSDR line 86-87)
			prevIdx := (v.headerPtr - 1 + len(v.headerBuf)) % len(v.headerBuf)
			if prevIdx < 0 {
				prevIdx = len(v.headerBuf) - 1
			}
			peakFreq = v.headerBuf[prevIdx]
		}

		// Store in circular buffer (KiwiSDR line 91-94)
		v.headerBuf[v.headerPtr] = peakFreq
		v.headerPtr = (v.headerPtr + 1) % len(v.headerBuf)

		// Report tone frequency every 500ms (50 iterations of 10ms each)
		if v.toneCallback != nil && iterationCount-lastToneReport >= 50 {
			v.toneCallback(peakFreq)
			lastToneReport = iterationCount
		}

		// Copy recent frequencies to tone buffer (KiwiSDR line 97-104)
		// KiwiSDR: for (i = tone_win-1, hp = HedrPtr-1; i >= 0; i--) { tone[i] = HeaderBuf[hp]; hp--; }
		hp := v.headerPtr - 1
		for i := toneWin - 1; i >= 0; i-- {
			if hp < 0 {
				hp = len(v.headerBuf) - 1
			}
			if i < len(v.toneBuf) {
				v.toneBuf[i] = v.headerBuf[hp]
			}
			hp--
		}

		// Look for VIS pattern (KiwiSDR line 106-251)
		headerShift := 0
		gotVIS := false

		// Rate limit logging
		shouldLog := iterationCount-lastLeaderLog > 100
		if shouldLog {
			lastLeaderLog = iterationCount
		}

		// KiwiSDR line 111-251: Pattern matching loops
		for i := 0; i < 3 && !gotVIS; i++ {
			for j := 0; j < 3 && !gotVIS; j++ {
				// Use tone[0+j] as reference frequency (KiwiSDR line 115-119)
				refFreq := v.toneBuf[0+j]

				// Check for leader pattern: 4 consecutive tones at same frequency (±25 Hz)
				// KiwiSDR line 115-119
				if !v.checkTone(1*3+i, refFreq, visTolerance) ||
					!v.checkTone(2*3+i, refFreq, visTolerance) ||
					!v.checkTone(3*3+i, refFreq, visTolerance) ||
					!v.checkTone(4*3+i, refFreq, visTolerance) {
					continue
				}

				// Check for start bit at 700 Hz below leader (KiwiSDR line 119)
				// tone[5*3+i] > tone[0+j] - 725 && < tone[0+j] - 675
				if !v.checkTone(5*3+i, refFreq-700, 25) {
					continue
				}

				// Found complete VIS header
				if shouldLog {
					log.Printf("[SSTV VIS] Found leader (%.1f Hz) + start bit (%.1f Hz), decoding data bits...", refFreq, refFreq-700)
				}

				// Try to read data bits (KiwiSDR line 124-137)
				bits := make([]uint8, 16)
				k := 0
				for k = 0; k < 16; k++ {
					toneIdx := 6*3 + i + 3*k
					if toneIdx >= len(v.toneBuf) {
						break
					}

					freq := v.toneBuf[toneIdx]

					// KiwiSDR line 126: 1300 Hz = tone[0+j] - 600 (±25 Hz)
					// KiwiSDR line 130: 1100 Hz = tone[0+j] - 800 (±25 Hz)
					if freq > refFreq-625 && freq < refFreq-575 {
						bits[k] = 0 // 1300 Hz
					} else if freq > refFreq-825 && freq < refFreq-775 {
						bits[k] = 1 // 1100 Hz
					} else {
						// Invalid bit
						if k == 0 && shouldLog {
							log.Printf("[SSTV VIS] First data bit invalid: freq=%.1f Hz (expected %.1f or %.1f Hz)",
								freq, refFreq-600, refFreq-800)
						}
						break
					}
				}

				nbits := 0

				// Check for 8-bit VIS (KiwiSDR line 142-148)
				if k == 8 {
					stopIdx := 14*3 + i
					if stopIdx < len(v.toneBuf) {
						stopFreq := v.toneBuf[stopIdx]
						// 1200 Hz = refFreq - 700 (±25 Hz)
						if stopFreq > refFreq-725 && stopFreq < refFreq-675 {
							log.Printf("[SSTV VIS] Detected VIS-8 (stop bit found)")
							nbits = 8
							gotVIS = true
						}
					}
				}

				// Check for extended 16-bit VIS (KiwiSDR line 154-158)
				if k == 9 {
					log.Printf("[SSTV VIS] Detected 9th data bit, extending window for VIS-16")
					toneWin = 70 // Extend to 700ms for 16-bit VIS
					break
				}

				if k == 16 {
					// KiwiSDR line 164-168
					stopIdx := 22*3 + i
					if stopIdx < len(v.toneBuf) {
						stopFreq := v.toneBuf[stopIdx]
						if stopFreq > refFreq-725 && stopFreq < refFreq-675 {
							log.Printf("[SSTV VIS] Detected VIS-16 (stop bit found)")
							nbits = 16
							gotVIS = true
						}
					}
				}

				if gotVIS {
					// KiwiSDR line 172: HeaderShift = tone[0+j] - 1900
					headerShift = int(refFreq - visLeaderFreq)

					// Decode VIS code (KiwiSDR line 174-177)
					vis := bits[0] | (bits[1] << 1) | (bits[2] << 2) | (bits[3] << 3) |
						(bits[4] << 4) | (bits[5] << 5) | (bits[6] << 6)
					parityBit := bits[7]
					parity := bits[0] ^ bits[1] ^ bits[2] ^ bits[3] ^ bits[4] ^ bits[5] ^ bits[6]

					var vis2 uint8
					var parityBit2, parity2 uint8

					if nbits == 16 {
						// KiwiSDR line 179-183
						vis2 = bits[8] | (bits[9] << 1) | (bits[10] << 2) | (bits[11] << 3) |
							(bits[12] << 4) | (bits[13] << 5) | (bits[14] << 6)
						parityBit2 = bits[15]
						parity2 = parity ^ bits[8] ^ bits[9] ^ bits[10] ^ bits[11] ^
							bits[12] ^ bits[13] ^ bits[14]
					}

					if nbits == 8 {
						log.Printf("[SSTV VIS] VIS=%d (0x%02x) @ %+d Hz", vis, vis, headerShift)
					} else {
						log.Printf("[SSTV VIS] VISX=%d|%d (0x%02x|0x%02x) @ %+d Hz",
							vis, vis2, vis, vis2, headerShift)
					}

					// Special case: R12BW has inverted parity (KiwiSDR line 191)
					if VISMap[vis] == ModeR12BW {
						parity = 1 - parity
					}

					// Check parity (KiwiSDR line 193-200)
					parityOK := true
					if nbits == 8 && parity != parityBit {
						log.Printf("[SSTV VIS] Parity check failed")
						parityOK = false
					} else if nbits == 16 && parity2 != parityBit2 {
						log.Printf("[SSTV VIS] Parity2 check failed")
						parityOK = false
					}

					if !parityOK {
						gotVIS = false
						continue
					}

					// Check if mode is known (KiwiSDR line 209-217)
					if VISMap[vis] == ModeUnknown {
						log.Printf("[SSTV VIS] Unknown VIS code: 0x%02x", vis)
						gotVIS = false
						continue
					}

					if nbits == 16 && (VISMap[vis] != ModeVISX || VISXMap[vis2] == ModeUnknown) {
						log.Printf("[SSTV VIS] Unknown extended VIS code: 0x%02x%02x", vis, vis2)
						gotVIS = false
						continue
					}

					// Determine mode (KiwiSDR line 219-226)
					var mode uint8
					if nbits == 8 {
						mode = VISMap[vis]
					} else {
						mode = VISXMap[vis2]
					}

					// Get mode spec
					modeSpec := GetModeByIndex(mode)
					if modeSpec == nil {
						log.Printf("[SSTV VIS] Invalid mode index: %d", mode)
						gotVIS = false
						continue
					}

					if modeSpec.Unsupported {
						log.Printf("[SSTV VIS] Mode not supported: %s", modeSpec.Name)
						gotVIS = false
						continue
					}

					log.Printf("[SSTV VIS] Detected mode: %s (%dx%d)",
						modeSpec.Name, modeSpec.ImgWidth, modeSpec.NumLines)

					return mode, headerShift, nbits == 16, true
				}
			}
		}

		if gotVIS {
			break
		}
	}

	return 0, 0, false, false
}

// DetectVIS is the legacy interface - now redirects to streaming version
func (v *VISDetector) DetectVIS(pcmReader PCMReader) (uint8, int, bool, bool) {
	// This is kept for compatibility but should use DetectVISStreaming instead
	log.Printf("[SSTV VIS] Warning: Using legacy DetectVIS interface")
	return 0, 0, false, false
}

// checkTone checks if the tone at the given index matches the expected frequency
func (v *VISDetector) checkTone(idx int, expectedFreq, tolerance float64) bool {
	if idx >= len(v.toneBuf) {
		return false
	}
	freq := v.toneBuf[idx]
	return freq > expectedFreq-tolerance && freq < expectedFreq+tolerance
}

// getBin converts a frequency to an FFT bin index
// KiwiSDR: GET_BIN(freq, FFTLen) = (freq / nom_rate * FFTLen)
func (v *VISDetector) getBin(freq float64) int {
	return int(freq / v.sampleRate * float64(v.fftSize))
}

// PCMReader interface for reading PCM samples
type PCMReader interface {
	Read(numSamples int) ([]int16, error)
}
