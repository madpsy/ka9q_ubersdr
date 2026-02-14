package ft8

import (
	"log"
	"math"

	"gonum.org/v1/gonum/dsp/fourier"
)

/*
 * Waterfall Generation
 * Creates time-frequency representation using FFT
 */

// Waterfall represents the time-frequency power spectrum
type Waterfall struct {
	MaxBlocks   int      // Number of blocks (symbols) allocated
	NumBlocks   int      // Number of blocks (symbols) stored
	NumBins     int      // Number of FFT bins (in terms of 6.25 Hz)
	TimeOSR     int      // Time oversampling rate
	FreqOSR     int      // Frequency oversampling rate
	Mag         []uint8  // FFT magnitudes [blocks][time_osr][freq_osr][num_bins]
	BlockStride int      // Helper: time_osr * freq_osr * num_bins
	Protocol    Protocol // FT8 or FT4
}

// Monitor manages DSP processing and waterfall generation
type Monitor struct {
	SymbolPeriod float64    // Symbol period in seconds
	MinBin       int        // First FFT bin in frequency range
	MaxBin       int        // First FFT bin outside frequency range
	BlockSize    int        // Samples per symbol (block)
	SubblockSize int        // Analysis shift size (samples)
	NFFT         int        // FFT size
	FFTNorm      float64    // FFT normalization factor
	Window       []float64  // Window function (Hann)
	LastFrame    []float64  // Current analysis frame
	Waterfall    *Waterfall // Waterfall object
	MaxMag       float64    // Maximum detected magnitude

	// FFT buffers
	timeData []float64    // Time domain input
	freqData []complex128 // Frequency domain output
}

// NewMonitor creates a new monitor for waterfall generation
func NewMonitor(sampleRate int, fMin, fMax float64, timeOSR, freqOSR int, protocol Protocol) *Monitor {
	symbolPeriod := protocol.GetSymbolTime()
	blockSize := int(float64(sampleRate) * symbolPeriod)
	subblockSize := blockSize / timeOSR

	// FFT size calculation
	// We want frequency resolution of 6.25 Hz / freqOSR
	// FFT bin width = sampleRate / NFFT
	// So NFFT = sampleRate / (6.25 / freqOSR)
	toneBinWidth := 6.25 / float64(freqOSR)
	nfft := int(float64(sampleRate) / toneBinWidth)

	// Round up to next power of 2 for efficiency
	nfft = nextPowerOf2(nfft)

	// Calculate frequency bins
	binWidth := float64(sampleRate) / float64(nfft)
	minBin := int(fMin / binWidth)
	maxBin := int(fMax/binWidth) + 1
	numBins := (maxBin - minBin) * freqOSR

	// Calculate number of blocks we can store
	slotTime := protocol.GetSlotTime()
	maxBlocks := int(slotTime/symbolPeriod) + 1

	// Create waterfall
	wf := &Waterfall{
		MaxBlocks:   maxBlocks,
		NumBlocks:   0,
		NumBins:     numBins / freqOSR, // In terms of 6.25 Hz bins
		TimeOSR:     timeOSR,
		FreqOSR:     freqOSR,
		Mag:         make([]uint8, maxBlocks*timeOSR*freqOSR*numBins/freqOSR),
		BlockStride: timeOSR * freqOSR * numBins / freqOSR,
		Protocol:    protocol,
	}

	// Calculate normalization factor (applied to window like C reference)
	fftNorm := 2.0 / float64(nfft)

	// Create Hann window with normalization applied (matching C reference)
	// Reference: window[i] = fft_norm * hann_i(i, nfft)
	// where hann_i(i, N) = sin²(π*i/N)
	window := make([]float64, nfft)
	for i := 0; i < nfft; i++ {
		x := math.Sin(math.Pi * float64(i) / float64(nfft))
		hann := x * x
		window[i] = fftNorm * hann
	}

	return &Monitor{
		SymbolPeriod: symbolPeriod,
		MinBin:       minBin,
		MaxBin:       maxBin,
		BlockSize:    blockSize,
		SubblockSize: subblockSize,
		NFFT:         nfft,
		FFTNorm:      fftNorm,
		Window:       window,
		LastFrame:    make([]float64, nfft),
		Waterfall:    wf,
		MaxMag:       -120.0, // Initialize to minimum dB value
		timeData:     make([]float64, nfft),
		freqData:     make([]complex128, nfft/2+1),
	}
}

// Process processes a block of audio samples
func (m *Monitor) Process(frame []float32) {
	// Debug: check input samples for first block
	if m.Waterfall.NumBlocks == 0 {
		var maxSample float32
		for _, s := range frame {
			if abs := s; abs < 0 {
				abs = -abs
			} else if abs > maxSample {
				maxSample = abs
			}
		}
		log.Printf("[Waterfall DEBUG] Input frame: len=%d, max_sample=%.6f", len(frame), maxSample)
	}

	// Process each time subdivision
	for timeSub := 0; timeSub < m.Waterfall.TimeOSR; timeSub++ {
		offset := timeSub * m.SubblockSize

		// Shift last frame and add new samples
		copy(m.LastFrame, m.LastFrame[m.SubblockSize:])
		for i := 0; i < m.SubblockSize && offset+i < len(frame); i++ {
			m.LastFrame[m.NFFT-m.SubblockSize+i] = float64(frame[offset+i])
		}

		// Apply window and copy to FFT buffer
		for i := 0; i < m.NFFT; i++ {
			m.timeData[i] = m.LastFrame[i] * m.Window[i]
		}

		// Perform FFT
		m.fft(m.timeData, m.freqData)

		// Extract magnitudes and store in waterfall
		m.extractMagnitudes(timeSub)
	}

	m.Waterfall.NumBlocks++
}

// fft performs real FFT using gonum
func (m *Monitor) fft(input []float64, output []complex128) {
	n := len(input)

	// Check if n is power of 2
	if n&(n-1) != 0 {
		// Not a power of 2, this shouldn't happen with our NFFT calculation
		return
	}

	// Create FFT instance
	fftInstance := fourier.NewFFT(n)

	// Compute FFT
	coeffs := fftInstance.Coefficients(nil, input)

	// Copy to output
	copy(output, coeffs)
}

// extractMagnitudes extracts FFT magnitudes and stores them in the waterfall
func (m *Monitor) extractMagnitudes(timeSub int) {
	wf := m.Waterfall
	blockIdx := wf.NumBlocks

	if blockIdx >= wf.MaxBlocks {
		return
	}

	// Calculate base index in magnitude array
	baseIdx := blockIdx*wf.BlockStride + timeSub*wf.FreqOSR*wf.NumBins

	// Debug: track some values for first block
	debugBlock := blockIdx == 0 && timeSub == 0

	// Extract magnitudes for each frequency bin
	// Reference C code loops: for (freq_sub) { for (bin) { src_bin = bin*freq_osr + freq_sub; } }
	for freqSub := 0; freqSub < wf.FreqOSR; freqSub++ {
		for bin := 0; bin < wf.NumBins; bin++ {
			// Calculate FFT bin with frequency oversampling
			// Reference: src_bin = (bin * freq_osr) + freq_sub
			fftBin := (m.MinBin+bin)*wf.FreqOSR + freqSub
			if fftBin >= len(m.freqData) {
				break
			}

			// Calculate power (magnitude squared) and convert to dB
			// Normalization already applied in window
			real := real(m.freqData[fftBin])
			imag := imag(m.freqData[fftBin])
			mag2 := real*real + imag*imag
			magDB := 10.0 * math.Log10(1e-12+mag2)

			if debugBlock && bin < 5 && freqSub == 0 {
				log.Printf("[Waterfall DEBUG] bin=%d, freqSub=%d, fftBin=%d, real=%.6f, imag=%.6f, mag2=%.6e, magDB=%.2f, uint8=%d",
					bin, freqSub, fftBin, real, imag, mag2, magDB, int(2.0*magDB+240.0))
			}

			// Track maximum
			if magDB > m.MaxMag {
				m.MaxMag = magDB
			}

			// Convert to uint8: scaled = 2 * db + 240
			// This maps -120 dB -> 0, 0 dB -> 240, +7.5 dB -> 255
			magUint8 := int(2.0*magDB + 240.0)
			if magUint8 < 0 {
				magUint8 = 0
			}
			if magUint8 > 255 {
				magUint8 = 255
			}

			// Store in waterfall
			idx := baseIdx + freqSub*wf.NumBins + bin
			if idx < len(wf.Mag) {
				wf.Mag[idx] = uint8(magUint8)
			}
		}
	}
}

// Reset resets the waterfall for a new time slot
func (m *Monitor) Reset() {
	m.Waterfall.NumBlocks = 0
	m.MaxMag = -120.0 // Reset to minimum dB value
	// Clear last frame
	for i := range m.LastFrame {
		m.LastFrame[i] = 0.0
	}
}

// nextPowerOf2 returns the next power of 2 >= n
func nextPowerOf2(n int) int {
	if n <= 0 {
		return 1
	}
	n--
	n |= n >> 1
	n |= n >> 2
	n |= n >> 4
	n |= n >> 8
	n |= n >> 16
	n++
	return n
}
