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
func (v *VISDetector) ProcessIteration(pcmBuffer *SlidingPCMBuffer) (uint8, int, bool, bool) {
	samps10ms := int(v.sampleRate * 10e-3)
	samps20ms := len(v.hannWindow)

	v.iterationCount++

	// Need enough samples for 20ms FFT window
	if pcmBuffer.Available() < samps20ms {
		return 0, 0, false, false
	}

	// Get 20ms window for FFT
	// slowrx: fft.in[i] = pcm.Buffer[pcm.WindowPtr + i - 441]
	// Window is centered at WindowPtr, going back samps10ms
	// offset = -samps10ms, length = samps20ms
	window, err := pcmBuffer.GetWindow(-samps10ms, samps20ms)
	if err != nil {
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

	// Copy frequencies from last 450ms to tone buffer (in chronological order)
	for i := 0; i < len(v.toneBuf); i++ {
		v.toneBuf[i] = v.headerBuf[(v.headerPtr+i)%len(v.headerBuf)]
	}

	// Only start looking for VIS after we have enough history (450ms)
	if v.iterationCount < 45 {
		// Advance window by 10ms and continue (slowrx line 165)
		pcmBuffer.AdvanceWindow(samps10ms)
		return 0, 0, false, false
	}

	// Look for VIS pattern (based on slowrx algorithm)
	// Try different phase alignments (i) and reference positions (j)
	// slowrx uses i=0..2 and j=0..2, but at 12kHz we need to search more positions
	// The VIS pattern might start anywhere in the first ~200ms of the buffer
	// Try up to j=20 (200ms) to find where the pattern actually starts
	for i := 0; i < 3; i++ {
		for j := 0; j < 20; j++ {
			// Use tone[0+j] as reference frequency (exactly like slowrx line 85)
			refFreq := v.toneBuf[0+j]

			// Check for complete VIS pattern
			// slowrx uses ±25 Hz at 44.1 kHz, but at 12 kHz we need wider tolerance
			// due to transmitter drift and receiver offset
			// Use ±50 Hz tolerance for 12 kHz sample rate
			tolerance := 50.0
			if v.sampleRate > 40000 {
				tolerance = 25.0 // Use tighter tolerance at higher sample rates
			}

			if !v.checkToneRange(1*3+i, refFreq-tolerance, refFreq+tolerance) ||
				!v.checkToneRange(2*3+i, refFreq-tolerance, refFreq+tolerance) ||
				!v.checkToneRange(3*3+i, refFreq-tolerance, refFreq+tolerance) ||
				!v.checkToneRange(4*3+i, refFreq-tolerance, refFreq+tolerance) ||
				!v.checkToneRange(5*3+i, refFreq-700-tolerance, refFreq-700+tolerance) || // start bit
				!v.checkToneRange(14*3+i, refFreq-700-tolerance, refFreq-700+tolerance) { // stop bit
				continue
			}

			// Found potential VIS - try to decode the 8 data bits
			bits := make([]uint8, 8)
			validBits := true

			for k := 0; k < 8; k++ {
				// slowrx line 98: tone[6*3+i+3*k]
				// This gives us the data bit positions after the start bit
				toneIdx := 6*3 + i + 3*k
				if toneIdx >= len(v.toneBuf) {
					validBits = false
					break
				}

				freq := v.toneBuf[toneIdx]

				// Bit 0: 1300 Hz (refFreq - 600)
				// Bit 1: 1100 Hz (refFreq - 800)
				// slowrx uses ±25 Hz tolerance at 44.1 kHz (lines 98-99)
				// At 12 kHz we need wider tolerance due to frequency drift
				bitTolerance := 50.0
				if v.sampleRate > 40000 {
					bitTolerance = 25.0
				}

				bit0Center := refFreq - 600 // 1300 Hz nominal
				bit1Center := refFreq - 800 // 1100 Hz nominal

				if freq > bit0Center-bitTolerance && freq < bit0Center+bitTolerance {
					bits[k] = 0 // 1300 Hz
				} else if freq > bit1Center-bitTolerance && freq < bit1Center+bitTolerance {
					bits[k] = 1 // 1100 Hz
				} else {
					validBits = false
					break
				}
			}

			if !validBits {
				continue
			}

			// Decode VIS code
			vis := bits[0] | (bits[1] << 1) | (bits[2] << 2) | (bits[3] << 3) |
				(bits[4] << 4) | (bits[5] << 5) | (bits[6] << 6)
			parityBit := bits[7]
			parity := bits[0] ^ bits[1] ^ bits[2] ^ bits[3] ^ bits[4] ^ bits[5] ^ bits[6]

			// Special case: R12BW has inverted parity
			if VISMap[vis] == ModeR12BW {
				parity = 1 - parity
			}

			// Check parity
			if parity != parityBit {
				continue
			}

			// Check if mode is known
			if VISMap[vis] == ModeUnknown {
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

			// Skip the rest of the stop bit to position at video signal start
			// slowrx vis.c:169-170: readPcm(20e-3 * 44100); pcm.WindowPtr += 20e-3 * 44100;
			// This positions windowPtr at the START of the video signal (after VIS stop bit)
			stopBitSkip := int(20e-3 * v.sampleRate) // 240 samples at 12kHz, 882 at 44.1kHz
			pcmBuffer.AdvanceWindow(stopBitSkip)

			log.Printf("[SSTV VIS] Advanced windowPtr by %d samples past stop bit to video signal start", stopBitSkip)

			return mode, headerShift, false, true
		}
	}

	// No VIS found, advance window by 10ms and continue
	// slowrx: pcm.WindowPtr += 441 (after readPcm which shifts buffer)
	// Our Write() already shifts buffer and moves WindowPtr back
	// So we need to advance WindowPtr forward to compensate
	pcmBuffer.AdvanceWindow(samps10ms)

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
func (v *VISDetector) DetectVISStreaming(pcmBuffer *SlidingPCMBuffer) (uint8, int, bool, bool) {
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
