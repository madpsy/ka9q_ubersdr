package sstv

import "math"

/*
 * Video Demodulation - Common Structures and Utilities
 * Ported from KiwiSDR/extensions/SSTV/sstv_video.cpp
 *
 * Original copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)
 * Go port (c) 2026, UberSDR project
 */

// PixelGrid represents a pixel to be extracted at a specific time
type PixelGrid struct {
	X       int   // X coordinate in image
	Y       int   // Y coordinate in image
	Time    int   // Sample number when this pixel should be extracted
	Channel uint8 // Color channel (0=R/Y, 1=G/U, 2=B/V)
	Last    bool  // True if this is the last pixel in the grid
}

// VideoDemodulator handles SSTV video signal demodulation
type VideoDemodulator struct {
	// Configuration
	mode        *ModeSpec
	sampleRate  float64
	headerShift int // Frequency shift detected in VIS (Hz)

	// FFT parameters
	fftSize int

	// Hann windows of different lengths for adaptive windowing
	hannWindows [][]float64
	hannLengths []int

	// Channel timing
	chanStart [4]float64 // Start time of each channel (seconds)
	chanLen   [4]float64 // Length of each channel (seconds)
	numChans  int        // Number of channels per line

	// Pixel grid - pre-calculated sample times for each pixel
	pixelGrid []PixelGrid

	// Image buffer [x][y][channel]
	image [][][]uint8

	// Stored luminance values for all samples
	storedLum []uint8

	// Sync detection
	hasSync []bool

	// FM demodulation
	fmSampleInterval int

	// SNR tracking
	snr float64

	// Adaptive windowing
	adaptive bool
}

// NewVideoDemodulator creates a new video demodulator
func NewVideoDemodulator(mode *ModeSpec, sampleRate float64, headerShift int) *VideoDemodulator {
	v := &VideoDemodulator{
		mode:        mode,
		sampleRate:  sampleRate,
		headerShift: headerShift,
		fftSize:     1024,
		adaptive:    true,
	}

	// Calculate FM sample interval
	samplesPerPixel := sampleRate * mode.LineTime / float64(mode.ImgWidth)
	v.fmSampleInterval = int(samplesPerPixel * 0.75)

	// Initialize Hann windows
	v.initHannWindows()

	// Calculate channel timing
	v.calculateChannelTiming()

	// Allocate buffers
	v.allocateBuffers()

	return v
}

// initHannWindows creates Hann windows of different lengths for adaptive windowing
func (v *VideoDemodulator) initHannWindows() {
	v.hannLengths = []int{48, 64, 96, 128, 256, 512, 1024}
	v.hannWindows = make([][]float64, len(v.hannLengths))

	for i, length := range v.hannLengths {
		v.hannWindows[i] = make([]float64, length)
		for j := 0; j < length; j++ {
			v.hannWindows[i][j] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(j)/float64(length-1)))
		}
	}
}

// calculateChannelTiming calculates the start time and length of each color channel
func (v *VideoDemodulator) calculateChannelTiming() {
	m := v.mode

	switch m.Format {
	case Format420:
		// Sp00g[12] - Y channel is double width, U/V alternate
		v.chanLen[0] = m.PixelTime * float64(m.ImgWidth) * 2
		v.chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		v.chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		v.chanStart[0] = m.SyncTime + m.PorchTime
		v.chanStart[1] = v.chanStart[0] + v.chanLen[0] + m.SeptrTime
		v.chanStart[2] = v.chanStart[1]
		v.numChans = 2

	case Format422:
		// Sp00g1g2 - Y channel is double width
		v.chanLen[0] = m.PixelTime * float64(m.ImgWidth) * 2
		v.chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		v.chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		v.chanStart[0] = m.SyncTime + m.PorchTime
		v.chanStart[1] = v.chanStart[0] + v.chanLen[0] + m.SeptrTime
		v.chanStart[2] = v.chanStart[1] + v.chanLen[1] + m.SeptrTime
		v.numChans = 3

	case Format242:
		// S0112 - Special subsampling
		tPixels := m.PixelTime * float64(m.ImgWidth) * 3.0 / 4.0
		v.chanLen[0] = tPixels
		v.chanLen[1] = tPixels * 2
		v.chanLen[2] = tPixels
		v.chanStart[0] = m.SyncTime + m.PorchTime
		v.chanStart[1] = v.chanStart[0] + v.chanLen[0]
		v.chanStart[2] = v.chanStart[1] + v.chanLen[1]
		v.numChans = 3

	case Format111Rev:
		// g0g1Sp2 - Reversed order (Scottie)
		v.chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		v.chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		v.chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		v.chanStart[0] = m.SeptrTime
		v.chanStart[1] = v.chanStart[0] + v.chanLen[0] + m.SeptrTime
		v.chanStart[2] = v.chanStart[1] + v.chanLen[1] + m.SyncTime + m.PorchTime
		v.numChans = 3

	case FormatBW:
		// S0 - Black and white
		v.chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		v.chanStart[0] = m.SyncTime + m.PorchTime
		v.numChans = 1

	default: // Format111
		// Sp0g1g2 - Standard RGB/GBR
		v.chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		v.chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		v.chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		v.chanStart[0] = m.SyncTime + m.PorchTime
		v.chanStart[1] = v.chanStart[0] + v.chanLen[0] + m.SeptrTime
		v.chanStart[2] = v.chanStart[1] + v.chanLen[1] + m.SeptrTime
		v.numChans = 3
	}
}

// allocateBuffers allocates memory for image and processing buffers
func (v *VideoDemodulator) allocateBuffers() {
	m := v.mode

	// Allocate image buffer [x][y][channel]
	v.image = make([][][]uint8, m.ImgWidth)
	for x := 0; x < m.ImgWidth; x++ {
		v.image[x] = make([][]uint8, m.NumLines)
		for y := 0; y < m.NumLines; y++ {
			v.image[x][y] = make([]uint8, 3)
		}
	}

	// Allocate stored luminance buffer
	totalSamples := int((m.LineTime*float64(m.NumLines) + 1) * v.sampleRate)
	v.storedLum = make([]uint8, totalSamples)

	// Allocate sync detection buffer
	syncSamples := int(m.LineTime * float64(m.NumLines+1) / (13.0 / v.sampleRate))
	v.hasSync = make([]bool, syncSamples)
}

// buildPixelGrid pre-calculates the sample times for each pixel
func (v *VideoDemodulator) buildPixelGrid(skip int) {
	m := v.mode

	// Allocate pixel grid
	gridSize := m.ImgWidth * m.NumLines * v.numChans
	v.pixelGrid = make([]PixelGrid, gridSize)

	pixelIdx := 0

	for y := 0; y < m.NumLines; y++ {
		for channel := 0; channel < v.numChans; channel++ {
			for x := 0; x < m.ImgWidth; x++ {
				// Determine actual channel for this pixel
				actualChannel := channel
				if m.Format == Format420 {
					if channel == 1 {
						if y%2 == 0 {
							actualChannel = 1 // U
						} else {
							actualChannel = 2 // V
						}
					} else {
						actualChannel = 0 // Y
					}
				}

				// Calculate time for this pixel
				time := float64(y)*m.LineTime + v.chanStart[actualChannel] +
					(float64(x)-0.5)/float64(m.ImgWidth)*v.chanLen[actualChannel]

				sampleTime := int(math.Round(v.sampleRate*time)) + skip

				v.pixelGrid[pixelIdx] = PixelGrid{
					X:       x,
					Y:       y,
					Time:    sampleTime,
					Channel: uint8(actualChannel),
					Last:    false,
				}

				pixelIdx++
			}
		}
	}

	// Mark last pixel
	if pixelIdx > 0 {
		v.pixelGrid[pixelIdx-1].Last = true
	}

	// Find first pixel with positive time
	firstIdx := 0
	for i := 0; i < len(v.pixelGrid); i++ {
		if v.pixelGrid[i].Time >= 0 {
			firstIdx = i
			break
		}
	}

	// Trim grid if needed
	if firstIdx > 0 {
		v.pixelGrid = v.pixelGrid[firstIdx:]
	}
}

// clip clips a value to 0-255 range
func clip(value float64) uint8 {
	if value < 0 {
		return 0
	}
	if value > 255 {
		return 255
	}
	return uint8(value)
}

// getBin converts a frequency to an FFT bin index
func (v *VideoDemodulator) getBin(freq float64) int {
	return int(freq / v.sampleRate * float64(v.fftSize))
}

// selectWindowIndex selects the appropriate Hann window based on SNR
func (v *VideoDemodulator) selectWindowIndex() int {
	if !v.adaptive {
		return 0
	}

	snr := v.snr

	if snr >= 20 {
		return 0 // 48 samples
	} else if snr >= 10 {
		return 1 // 64 samples
	} else if snr >= 9 {
		return 2 // 96 samples
	} else {
		return 3 // 128 samples
	}

	// Note: Original has more window sizes for very low SNR,
	// but they're commented out as "too CPU intensive for Kiwi"
}
