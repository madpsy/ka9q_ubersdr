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

	// FFT plan (will be created externally)
	fftInput  []float64
	fftOutput []complex128
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
		sampleRate: sampleRate,
		fftSize:    2048,
		headerBuf:  make([]float64, headerBufSize),
		toneBuf:    make([]float64, toneBufSize),
		hannWindow: hannWindow,
		fftInput:   make([]float64, 2048),
		fftOutput:  make([]complex128, 2048),
	}
}

// DetectVIS attempts to detect a VIS code from the audio stream
// Returns: mode index, header shift (Hz), extended VIS flag, success
func (v *VISDetector) DetectVIS(pcmReader PCMReader) (uint8, int, bool, bool) {
	samps10ms := int(v.sampleRate * 10e-3)
	samps20ms := len(v.hannWindow)
	toneWin := 45 // 450ms window for 8-bit VIS

	// Sliding window buffer for 20ms of samples
	slidingWindow := make([]int16, samps20ms)
	windowFilled := 0

	for {
		// Read 10ms of audio
		samples, err := pcmReader.Read(samps10ms)
		if err != nil {
			return 0, 0, false, false
		}

		// Slide the window: shift old data left, append new data
		if windowFilled >= samps20ms {
			// Window is full, shift left by samps10ms
			copy(slidingWindow, slidingWindow[samps10ms:])
			copy(slidingWindow[samps20ms-samps10ms:], samples)
		} else {
			// Window is still filling up
			copyLen := samps10ms
			if windowFilled+copyLen > samps20ms {
				copyLen = samps20ms - windowFilled
			}
			copy(slidingWindow[windowFilled:], samples[:copyLen])
			windowFilled += copyLen

			// Skip FFT until we have a full 20ms window
			if windowFilled < samps20ms {
				continue
			}
		}

		// Clear FFT input buffer
		for i := range v.fftInput {
			v.fftInput[i] = 0
		}

		// Apply Hann window to the 20ms sliding window
		for i := 0; i < samps20ms; i++ {
			v.fftInput[i] = float64(slidingWindow[i]) / 32768.0 * v.hannWindow[i]
		}

		// Perform FFT
		fft(v.fftInput, v.fftOutput)

		// Find bin with most power in 500-3300 Hz range
		maxBin := 0
		maxPower := 0.0
		minBin := v.getBin(500.0)
		maxBinLimit := v.getBin(3300.0)

		powers := make([]float64, v.fftSize/2)
		for i := 0; i < v.fftSize/2; i++ {
			powers[i] = real(v.fftOutput[i])*real(v.fftOutput[i]) +
				imag(v.fftOutput[i])*imag(v.fftOutput[i])

			if i >= minBin && i < maxBinLimit && powers[i] > maxPower {
				maxPower = powers[i]
				maxBin = i
			}
		}

		// Gaussian interpolation for peak frequency
		// KiwiSDR formula: MaxBin + log(P+/P-) / (2*log(P^2/(P+*P-)))
		var peakFreq float64
		minBinFreq := v.getBin(500.0)
		maxBinFreq := v.getBin(3300.0)

		if maxBin > minBinFreq && maxBin < maxBinFreq &&
			powers[maxBin] > 0 && powers[maxBin-1] > 0 && powers[maxBin+1] > 0 {

			// KiwiSDR's exact Gaussian interpolation formula
			pwr_mb := powers[maxBin]
			pwr_mo := powers[maxBin-1]
			pwr_po := powers[maxBin+1]

			// Calculate: log(P+/P-) / (2*log(P^2/(P+*P-)))
			numerator := pwr_po / pwr_mo
			denominator := (pwr_mb * pwr_mb) / (pwr_po * pwr_mo)

			// Check for numerical stability
			if numerator > 0 && denominator > 0 && math.Abs(math.Log(denominator)) > 1e-9 {
				delta := math.Log(numerator) / (2.0 * math.Log(denominator))

				// Apply interpolation
				peakFreq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
			} else {
				// Fallback to bin center frequency
				peakFreq = float64(maxBin) / float64(v.fftSize) * v.sampleRate
			}
		} else {
			// Use previous value if we have no valid bin (matches KiwiSDR line 87)
			prevIdx := (v.headerPtr - 1 + len(v.headerBuf)) % len(v.headerBuf)
			if prevIdx < 0 {
				prevIdx = len(v.headerBuf) - 1
			}
			peakFreq = v.headerBuf[prevIdx]
		}

		// Store in circular buffer
		v.headerBuf[v.headerPtr] = peakFreq
		v.headerPtr = (v.headerPtr + 1) % len(v.headerBuf)

		// Copy recent frequencies to tone buffer
		// KiwiSDR: for (i = tone_win-1, hp = HedrPtr-1; i >= 0; i--) { tone[i] = HeaderBuf[hp]; hp--; }
		// This creates: tone[0] = oldest, tone[tone_win-1] = newest
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

		// Look for VIS pattern
		// Pattern: 1900Hz leader (4x30ms) + 1200Hz start bit (30ms) + data bits
		headerShift := 0
		gotVIS := false

		for i := 0; i < 3 && !gotVIS; i++ {
			for j := 0; j < 3 && !gotVIS; j++ {
				// Use tone[0+j] as reference frequency (matches KiwiSDR exactly)
				// This allows detection of frequency-shifted signals
				refFreq := v.toneBuf[0+j]

				// Check for leader pattern: 4 consecutive tones at same frequency (±25 Hz)
				// KiwiSDR lines 115-119: all comparisons are relative to tone[0+j]
				if !v.checkTone(1*3+i, refFreq, visTolerance) ||
					!v.checkTone(2*3+i, refFreq, visTolerance) ||
					!v.checkTone(3*3+i, refFreq, visTolerance) ||
					!v.checkTone(4*3+i, refFreq, visTolerance) {
					continue
				}

				// Check for start bit at 700 Hz below leader (1200 Hz if leader is 1900 Hz)
				// KiwiSDR line 119: tone[5*3+i] > tone[0+j] - 725 && < tone[0+j] - 675
				if !v.checkTone(5*3+i, refFreq-700, 25) {
					continue
				}

				// Found complete VIS header - log it
				log.Printf("[SSTV VIS] Found leader (%.1f Hz) + start bit (%.1f Hz), decoding data bits...", refFreq, refFreq-700)

				// Try to read data bits
				bits := make([]uint8, 16)
				k := 0
				for k = 0; k < 16; k++ {
					toneIdx := 6*3 + i + 3*k
					if toneIdx >= len(v.toneBuf) {
						break
					}

					freq := v.toneBuf[toneIdx]

					// KiwiSDR line 126: 1300 Hz = tone[0+j] - 600 (±25 Hz tolerance = -625 to -575)
					// KiwiSDR line 130: 1100 Hz = tone[0+j] - 800 (±25 Hz tolerance = -825 to -775)
					if freq > refFreq-625 && freq < refFreq-575 {
						bits[k] = 0 // 1300 Hz
					} else if freq > refFreq-825 && freq < refFreq-775 {
						bits[k] = 1 // 1100 Hz
					} else {
						// Invalid bit - break out of bit reading loop
						break
					}
				}

				nbits := 0

				// Check for 8-bit VIS (stop bit at position 8)
				if k == 8 {
					// KiwiSDR line 143: check for 1200 Hz stop bit at position 14*3+i
					stopIdx := 14*3 + i
					if stopIdx < len(v.toneBuf) {
						stopFreq := v.toneBuf[stopIdx]
						// 1200 Hz = refFreq - 700 (±25 Hz tolerance = -725 to -675)
						if stopFreq > refFreq-725 && stopFreq < refFreq-675 {
							log.Printf("[SSTV VIS] Detected VIS-8 (stop bit found)")
							nbits = 8
							gotVIS = true
						}
					}
				}

				// Check for extended 16-bit VIS (KiwiSDR line 154)
				if k == 9 {
					log.Printf("[SSTV VIS] Detected 9th data bit, extending window for VIS-16")
					toneWin = 70 // Extend to 700ms for 16-bit VIS
					break
				}

				if k == 16 {
					// KiwiSDR line 164: check for 1200 Hz stop bit at position 22*3+i
					stopIdx := 22*3 + i
					if stopIdx < len(v.toneBuf) {
						stopFreq := v.toneBuf[stopIdx]
						// 1200 Hz = refFreq - 700 (±25 Hz tolerance = -725 to -675)
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

					if nbits == 8 {
						log.Printf("[SSTV VIS] VIS=%d (0x%02x) @ %+d Hz", vis, vis, headerShift)
					} else {
						log.Printf("[SSTV VIS] VISX=%d|%d (0x%02x|0x%02x) @ %+d Hz",
							vis, vis2, vis, vis2, headerShift)
					}

					// Special case: R12BW has inverted parity
					if VISMap[vis] == ModeR12BW {
						parity = 1 - parity
					}

					// Check parity
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

					// Check if mode is known
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
	}
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
func (v *VISDetector) getBin(freq float64) int {
	return int(freq / v.sampleRate * float64(v.fftSize))
}

// PCMReader interface for reading PCM samples
type PCMReader interface {
	Read(numSamples int) ([]int16, error)
}
