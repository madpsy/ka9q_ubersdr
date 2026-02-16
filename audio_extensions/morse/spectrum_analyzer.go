package morse

import (
	"math"
	"sort"

	"gonum.org/v1/gonum/dsp/fourier"
)

// SpectrumAnalyzer performs FFT-based spectrum analysis to detect CW tones
type SpectrumAnalyzer struct {
	sampleRate int
	fftSize    int
	minFreq    float64
	maxFreq    float64
	df         float64 // Frequency resolution

	// FFT state
	window      []float64
	buffer      []float64
	bufferIndex int
	fftInstance *fourier.FFT

	// Spectrum data
	spectrum    []float64 // Power spectrum
	snrSpectrum []float64 // SNR spectrum
	freqBins    []float64 // Frequency for each bin
	fftOutput   []complex128
}

// NewSpectrumAnalyzer creates a new spectrum analyzer
func NewSpectrumAnalyzer(sampleRate int, minFreq, maxFreq float64) *SpectrumAnalyzer {
	fftSize := 2048 // Good balance between frequency resolution and time resolution

	sa := &SpectrumAnalyzer{
		sampleRate:  sampleRate,
		fftSize:     fftSize,
		minFreq:     minFreq,
		maxFreq:     maxFreq,
		df:          float64(sampleRate) / float64(fftSize),
		buffer:      make([]float64, fftSize),
		window:      make([]float64, fftSize),
		spectrum:    make([]float64, fftSize/2+1),
		snrSpectrum: make([]float64, fftSize/2+1),
		freqBins:    make([]float64, fftSize/2+1),
		fftOutput:   make([]complex128, fftSize),
		bufferIndex: 0,
	}

	// Create FFT instance (gonum)
	sa.fftInstance = fourier.NewFFT(fftSize)

	// Create Hann window
	for i := 0; i < fftSize; i++ {
		sa.window[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(fftSize-1)))
	}

	// Precompute frequency bins
	for i := range sa.freqBins {
		sa.freqBins[i] = float64(i) * sa.df
	}

	return sa
}

// ProcessSample adds a sample to the buffer and returns true when FFT is ready
func (sa *SpectrumAnalyzer) ProcessSample(sample float64) bool {
	sa.buffer[sa.bufferIndex] = sample
	sa.bufferIndex++

	if sa.bufferIndex >= sa.fftSize {
		sa.bufferIndex = 0
		sa.computeSpectrum()
		return true
	}

	return false
}

// computeSpectrum performs FFT and calculates power spectrum
func (sa *SpectrumAnalyzer) computeSpectrum() {
	// Apply window
	windowed := make([]float64, sa.fftSize)
	for i := 0; i < sa.fftSize; i++ {
		windowed[i] = sa.buffer[i] * sa.window[i]
	}

	// Perform FFT using gonum
	coeffs := sa.fftInstance.Coefficients(nil, windowed)

	// Calculate power spectrum (only positive frequencies)
	for i := 0; i < len(sa.spectrum); i++ {
		real := real(coeffs[i])
		imag := imag(coeffs[i])
		sa.spectrum[i] = real*real + imag*imag
	}

	// Calculate SNR spectrum (signal / noise floor)
	noiseFloor := percentile(sa.spectrum, 20)
	if noiseFloor < 1e-10 {
		noiseFloor = 1e-10
	}

	for i := range sa.snrSpectrum {
		sa.snrSpectrum[i] = sa.spectrum[i] / noiseFloor
	}
}

// DetectPeaks finds the N strongest peaks in the spectrum within the frequency range
func (sa *SpectrumAnalyzer) DetectPeaks(n int, minSNR float64) []Peak {
	// Find bin range for our frequency range
	minBin := int(sa.minFreq / sa.df)
	maxBin := int(sa.maxFreq / sa.df)

	if minBin < 0 {
		minBin = 0
	}
	if maxBin >= len(sa.snrSpectrum) {
		maxBin = len(sa.snrSpectrum) - 1
	}

	// Find all peaks above threshold
	var peaks []Peak

	for i := minBin + 1; i < maxBin; i++ {
		// Check if this is a local maximum
		if sa.snrSpectrum[i] > sa.snrSpectrum[i-1] &&
			sa.snrSpectrum[i] > sa.snrSpectrum[i+1] &&
			sa.snrSpectrum[i] > minSNR {

			// Refine frequency using parabolic interpolation
			freq := sa.refineFrequency(i)

			peaks = append(peaks, Peak{
				Frequency: freq,
				SNR:       10.0 * math.Log10(sa.snrSpectrum[i]),
				Bin:       i,
			})
		}
	}

	// Sort by SNR (strongest first)
	sort.Slice(peaks, func(i, j int) bool {
		return peaks[i].SNR > peaks[j].SNR
	})

	// Return top N peaks
	if len(peaks) > n {
		peaks = peaks[:n]
	}

	return peaks
}

// refineFrequency uses parabolic interpolation to get sub-bin frequency accuracy
func (sa *SpectrumAnalyzer) refineFrequency(bin int) float64 {
	if bin <= 0 || bin >= len(sa.spectrum)-1 {
		return sa.freqBins[bin]
	}

	// Parabolic interpolation
	alpha := sa.spectrum[bin-1]
	beta := sa.spectrum[bin]
	gamma := sa.spectrum[bin+1]

	delta := 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma)

	return sa.freqBins[bin] + delta*sa.df
}

// Peak represents a detected spectral peak
type Peak struct {
	Frequency float64 // Hz
	SNR       float64 // dB
	Bin       int     // FFT bin index
}
