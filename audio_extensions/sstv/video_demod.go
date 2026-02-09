package sstv

import (
	"math"
)

/*
 * Video Demodulation - FM Demodulation and SNR Estimation
 * Ported from KiwiSDR/extensions/SSTV/sstv_video.cpp
 *
 * Original copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)
 * Go port (c) 2026, UberSDR project
 */

// DemodulateVideo performs FM demodulation on the audio signal
// Returns the decoded image data as RGB pixels
func (v *VideoDemodulator) DemodulateVideo(pcmBuffer []int16, skip int, redraw bool) ([]uint8, error) {
	m := v.mode

	// Build pixel grid with skip offset
	v.buildPixelGrid(skip)

	// Total length in samples
	length := int(m.LineTime * float64(m.NumLines) * v.sampleRate)

	// Sync detection parameters
	syncTargetBin := v.getBin(1200.0 + float64(v.headerShift))
	syncSampleNum := 0
	nextSyncTime := 0
	nextSNRTime := 0

	// FFT buffers
	fftInput := make([]float64, v.fftSize)
	fftOutput := make([]complex128, v.fftSize)
	power := make([]float64, v.fftSize)

	// Current frequency
	var freq float64

	// Pixel grid index
	pixelIdx := 0

	// Output pixel buffer
	pixels := make([]uint8, m.ImgWidth*m.NumLines*3)

	// Process each sample
	for sampleNum := 0; sampleNum < length; sampleNum++ {

		if !redraw {
			// Store sync band for later adjustments
			if sampleNum == nextSyncTime {
				pRaw, pSync := v.detectSync(pcmBuffer, sampleNum, fftInput, fftOutput, syncTargetBin)

				// If sync power is more than 2x video power, we have sync
				if syncSampleNum < len(v.hasSync) {
					v.hasSync[syncSampleNum] = pSync > 2*pRaw
				}

				nextSyncTime += 13
				syncSampleNum++
			}

			// Estimate SNR periodically
			if sampleNum == nextSNRTime {
				v.estimateSNR(pcmBuffer, sampleNum, fftInput, fftOutput)
				nextSNRTime += 256
			}

			// FM demodulation - take FFT every fm_sample_interval samples
			if sampleNum%v.fmSampleInterval == 0 {
				freq = v.demodulateFrequency(pcmBuffer, sampleNum, fftInput, fftOutput, power)
			}

			// Convert frequency to luminance and store
			if sampleNum < len(v.storedLum) {
				v.storedLum[sampleNum] = clip((freq - (1500.0 + float64(v.headerShift))) / 3.1372549)
			}
		}

		// Extract pixel at the right time
		if pixelIdx < len(v.pixelGrid) && sampleNum == v.pixelGrid[pixelIdx].Time {
			pg := v.pixelGrid[pixelIdx]

			// Store pixel in image buffer
			if sampleNum < len(v.storedLum) {
				v.image[pg.X][pg.Y][pg.Channel] = v.storedLum[sampleNum]

				// Some modes have R-Y & B-Y channels that are twice the height
				if pg.Channel > 0 && m.Format == Format420 && pg.Y+1 < m.NumLines {
					v.image[pg.X][pg.Y+1][pg.Channel] = v.storedLum[sampleNum]
				}
			}

			// Convert and output line when complete
			if pg.X == m.ImgWidth-1 || pg.Last {
				v.convertAndOutputLine(pg.Y, pixels)
			}

			pixelIdx++
		}
	}

	return pixels, nil
}

// detectSync detects sync pulses at 1200 Hz
func (v *VideoDemodulator) detectSync(pcmBuffer []int16, sampleNum int, fftInput []float64, fftOutput []complex128, syncTargetBin int) (float64, float64) {
	// Clear FFT input
	for i := range fftInput {
		fftInput[i] = 0
	}

	// Apply 64-sample Hann window
	windowSize := 64
	hannWindow := v.hannWindows[1] // 64-sample window

	for i := 0; i < windowSize; i++ {
		idx := sampleNum + i - 32
		if idx >= 0 && idx < len(pcmBuffer) {
			fftInput[i] = float64(pcmBuffer[idx]) / 32768.0 * hannWindow[i]
		}
	}

	// Perform FFT
	fft(fftInput, fftOutput)

	// Calculate power in video band (1500-2300 Hz)
	pRaw := 0.0
	minBin := v.getBin(1500.0 + float64(v.headerShift))
	maxBin := v.getBin(2300.0 + float64(v.headerShift))

	for i := minBin; i <= maxBin && i < len(fftOutput); i++ {
		pRaw += real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])
	}
	pRaw /= float64(maxBin - minBin + 1)

	// Calculate power in sync band (1200 Hz ± 1 bin)
	pSync := 0.0
	for i := syncTargetBin - 1; i <= syncTargetBin+1 && i >= 0 && i < len(fftOutput); i++ {
		weight := 1.0 - 0.5*math.Abs(float64(syncTargetBin-i))
		pSync += (real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])) * weight
	}
	pSync /= 2.0

	return pRaw, pSync
}

// estimateSNR estimates the signal-to-noise ratio
func (v *VideoDemodulator) estimateSNR(pcmBuffer []int16, sampleNum int, fftInput []float64, fftOutput []complex128) {
	// Clear FFT input
	for i := range fftInput {
		fftInput[i] = 0
	}

	// Apply 1024-sample Hann window
	hannWindow := v.hannWindows[6] // 1024-sample window

	for i := 0; i < v.fftSize; i++ {
		idx := sampleNum + i - v.fftSize/2
		if idx >= 0 && idx < len(pcmBuffer) {
			fftInput[i] = float64(pcmBuffer[idx]) / 32768.0 * hannWindow[i]
		}
	}

	// Perform FFT
	fft(fftInput, fftOutput)

	// Calculate video-plus-noise power (1500-2300 Hz)
	pVideoPlusNoise := 0.0
	minBin := v.getBin(1500.0 + float64(v.headerShift))
	maxBin := v.getBin(2300.0 + float64(v.headerShift))

	for i := minBin; i <= maxBin && i < len(fftOutput); i++ {
		pVideoPlusNoise += real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])
	}

	// Calculate noise-only power (400-800 Hz + 2700-3400 Hz)
	pNoiseOnly := 0.0

	minBin1 := v.getBin(400.0 + float64(v.headerShift))
	maxBin1 := v.getBin(800.0 + float64(v.headerShift))
	for i := minBin1; i <= maxBin1 && i < len(fftOutput); i++ {
		pNoiseOnly += real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])
	}

	minBin2 := v.getBin(2700.0 + float64(v.headerShift))
	maxBin2 := v.getBin(3400.0 + float64(v.headerShift))
	for i := minBin2; i <= maxBin2 && i < len(fftOutput); i++ {
		pNoiseOnly += real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])
	}

	// Calculate bandwidths
	videoPlusNoiseBins := v.getBin(2300.0) - v.getBin(1500.0) + 1
	noiseOnlyBins := (v.getBin(800.0) - v.getBin(400.0) + 1) +
		(v.getBin(3400.0) - v.getBin(2700.0) + 1)
	receiverBins := v.getBin(3400.0) - v.getBin(400.0)

	// Estimate noise and signal power
	pNoise := pNoiseOnly * float64(receiverBins) / float64(noiseOnlyBins)
	pSignal := pVideoPlusNoise - pNoiseOnly*float64(videoPlusNoiseBins)/float64(noiseOnlyBins)

	// Calculate SNR in dB (lower bound -20 dB)
	ratio := pSignal / pNoise
	if ratio < 0.01 {
		v.snr = -20.0
	} else {
		v.snr = 10.0 * math.Log10(ratio)
	}
}

// demodulateFrequency performs FM demodulation to extract frequency
func (v *VideoDemodulator) demodulateFrequency(pcmBuffer []int16, sampleNum int, fftInput []float64, fftOutput []complex128, power []float64) float64 {
	// Select window size based on SNR
	winIdx := v.selectWindowIndex()

	// Special case for Scottie DX - use larger window
	if v.mode.VIS == ModeSDX && winIdx < 6 {
		winIdx++
	}

	winLength := v.hannLengths[winIdx]
	hannWindow := v.hannWindows[winIdx]

	// Clear buffers
	for i := range fftInput {
		fftInput[i] = 0
	}
	for i := range power {
		power[i] = 0
	}

	// Apply Hann window
	for i := 0; i < winLength; i++ {
		idx := sampleNum + i - winLength/2
		if idx >= 0 && idx < len(pcmBuffer) {
			fftInput[i] = float64(pcmBuffer[idx]) / 32768.0 * hannWindow[i]
		}
	}

	// Perform FFT
	fft(fftInput, fftOutput)

	// Find bin with most power in video band (1500-2300 Hz)
	maxBin := 0
	maxPower := 0.0

	minBin := v.getBin(1500.0+float64(v.headerShift)) - 1
	maxBinLimit := v.getBin(2300.0+float64(v.headerShift)) + 1

	for i := minBin; i <= maxBinLimit && i >= 0 && i < len(fftOutput); i++ {
		power[i] = real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])
		if power[i] > maxPower {
			maxPower = power[i]
			maxBin = i
		}
	}

	// Gaussian interpolation for peak frequency
	var freq float64

	if maxBin > minBin && maxBin < maxBinLimit &&
		power[maxBin] > 0 && power[maxBin-1] > 0 && power[maxBin+1] > 0 {

		delta := math.Log(power[maxBin+1]/power[maxBin-1]) /
			(2.0 * math.Log(power[maxBin]*power[maxBin]/(power[maxBin+1]*power[maxBin-1])))

		freq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
	} else {
		// Clip if out of bounds
		if maxBin > v.getBin(1900.0+float64(v.headerShift)) {
			freq = 2300.0 + float64(v.headerShift)
		} else {
			freq = 1500.0 + float64(v.headerShift)
		}
	}

	return freq
}

// convertAndOutputLine converts a line from YUV/GBR to RGB and stores in output buffer
func (v *VideoDemodulator) convertAndOutputLine(y int, pixels []uint8) {
	m := v.mode

	// Calculate line offset in output buffer
	lineOffset := y * m.ImgWidth * 3

	for x := 0; x < m.ImgWidth; x++ {
		pixelOffset := lineOffset + x*3

		switch m.ColorEnc {
		case ColorRGB:
			// Direct RGB
			pixels[pixelOffset+0] = v.image[x][y][0]
			pixels[pixelOffset+1] = v.image[x][y][1]
			pixels[pixelOffset+2] = v.image[x][y][2]

		case ColorGBR:
			// GBR to RGB
			pixels[pixelOffset+0] = v.image[x][y][2] // R from B channel
			pixels[pixelOffset+1] = v.image[x][y][0] // G from G channel
			pixels[pixelOffset+2] = v.image[x][y][1] // B from R channel

		case ColorYUV, ColorYUVY:
			// YUV to RGB conversion
			Y := float64(v.image[x][y][0])
			U := float64(v.image[x][y][1]) // R-Y
			V := float64(v.image[x][y][2]) // B-Y

			// Convert using standard YUV formulas
			// R = Y + 1.140 * V
			// G = Y - 0.395 * U - 0.581 * V
			// B = Y + 2.032 * U
			// But the original uses different coefficients:
			pixels[pixelOffset+0] = clip((100*Y + 140*U - 17850) / 100.0)
			pixels[pixelOffset+1] = clip((100*Y - 71*U - 33*V + 13260) / 100.0)
			pixels[pixelOffset+2] = clip((100*Y + 178*V - 22695) / 100.0)

		case ColorBW:
			// Black and white
			lum := v.image[x][y][0]
			pixels[pixelOffset+0] = lum
			pixels[pixelOffset+1] = lum
			pixels[pixelOffset+2] = lum
		}
	}
}
