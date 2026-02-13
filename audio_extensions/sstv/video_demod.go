package sstv

import (
	"log"
	"math"
	"time"
)

/*
 * Video Demodulation
 * Ported from slowrx by Oona Räisänen (OH2EIQ)
 *
 * Demodulates the video signal using FM demodulation with adaptive windowing
 */

// VideoDemodulator handles SSTV video signal demodulation
type VideoDemodulator struct {
	mode        *ModeSpec
	sampleRate  float64
	headerShift int

	// Adaptive windowing
	adaptive    bool
	hannWindows [][]float64 // Pre-computed Hann windows of different lengths
	hannLens    []int       // Window lengths

	// FFT
	fftSize   int
	fftInput  []float64
	fftOutput []complex128

	// Sync detection
	hasSync []bool

	// Stored luminance for redrawing
	storedLum []uint8
}

// NewVideoDemodulator creates a new video demodulator
func NewVideoDemodulator(mode *ModeSpec, sampleRate float64, headerShift int, adaptive bool) *VideoDemodulator {
	// Initialize Hann windows of different lengths (for adaptive windowing)
	// slowrx uses fixed lengths [48, 64, 96, 128, 256, 512, 1024] at 44.1kHz
	// We must scale these by sample rate to maintain the same TIME duration
	// At 12kHz: [13, 17, 26, 35, 70, 139, 279]
	// At 44.1kHz: [48, 64, 96, 128, 256, 512, 1024] (original)
	scaleFactor := sampleRate / 44100.0
	hannLens := []int{
		int(math.Round(48 * scaleFactor)),
		int(math.Round(64 * scaleFactor)),
		int(math.Round(96 * scaleFactor)),
		int(math.Round(128 * scaleFactor)),
		int(math.Round(256 * scaleFactor)),
		int(math.Round(512 * scaleFactor)),
		int(math.Round(1024 * scaleFactor)),
	}

	// Ensure minimum window size of at least 8 samples
	for i := range hannLens {
		if hannLens[i] < 8 {
			hannLens[i] = 8
		}
	}

	hannWindows := make([][]float64, len(hannLens))

	for j, length := range hannLens {
		hannWindows[j] = make([]float64, length)
		for i := 0; i < length; i++ {
			hannWindows[j][i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(length-1)))
		}
	}

	// Calculate maximum signal length
	var maxLength int
	if mode.ColorEnc == ColorYUV && mode.ImgWidth >= 512 { // PD modes
		maxLength = int(mode.LineTime * float64(mode.NumLines) / 2 * sampleRate)
	} else {
		maxLength = int(mode.LineTime * float64(mode.NumLines) * sampleRate)
	}

	return &VideoDemodulator{
		mode:        mode,
		sampleRate:  sampleRate,
		headerShift: headerShift,
		adaptive:    adaptive,
		hannWindows: hannWindows,
		hannLens:    hannLens,
		fftSize:     1024,
		fftInput:    make([]float64, 1024),
		fftOutput:   make([]complex128, 1024),
		hasSync:     make([]bool, maxLength/13+1),
		storedLum:   make([]uint8, maxLength),
	}
}

// PixelInfo describes when and where to place a pixel
type PixelInfo struct {
	Time    int   // Sample number when this pixel should be read
	X       int   // X coordinate
	Y       int   // Y coordinate
	Channel uint8 // Color channel (0=R/Y, 1=G/U, 2=B/V, 3=Y for PD)
	Last    bool  // Is this the last pixel?
}

// GetPixelGrid calculates the pixel grid for the mode
func (v *VideoDemodulator) GetPixelGrid(rate float64, skip int) []PixelInfo {
	m := v.mode

	// Calculate channel start times and lengths
	chanStart := make([]float64, 4)
	chanLen := make([]float64, 4)
	numChans := 3

	switch {
	case m.Name == "Robot 36" || m.Name == "Robot 24":
		// Robot modes: Y channel is double width, U/V alternate
		chanLen[0] = m.PixelTime * float64(m.ImgWidth) * 2
		chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		chanStart[0] = m.SyncTime + m.PorchTime
		chanStart[1] = chanStart[0] + chanLen[0] + m.SeptrTime
		chanStart[2] = chanStart[1]
		numChans = 2

	case m.Name == "Scottie S1" || m.Name == "Scottie S2" || m.Name == "Scottie DX":
		// Scottie modes: pGpBSpR format
		chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		chanStart[0] = m.SeptrTime
		chanStart[1] = chanStart[0] + chanLen[0] + m.SeptrTime
		chanStart[2] = chanStart[1] + chanLen[1] + m.SyncTime + m.PorchTime

	case m.ColorEnc == ColorYUV && m.ImgWidth >= 512:
		// PD modes: 4 channels per radio frame, 2 image lines per frame
		chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		chanLen[3] = m.PixelTime * float64(m.ImgWidth)
		chanStart[0] = m.SyncTime + m.PorchTime
		chanStart[1] = chanStart[0] + chanLen[0] + m.SeptrTime
		chanStart[2] = chanStart[1] + chanLen[1] + m.SeptrTime
		chanStart[3] = chanStart[2] + chanLen[2] + m.SeptrTime
		numChans = 4

	case m.ColorEnc == ColorBW:
		// B/W modes: single channel
		chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		chanStart[0] = m.SyncTime + m.PorchTime
		numChans = 1

	default:
		// Standard RGB/GBR modes
		chanLen[0] = m.PixelTime * float64(m.ImgWidth)
		chanLen[1] = m.PixelTime * float64(m.ImgWidth)
		chanLen[2] = m.PixelTime * float64(m.ImgWidth)
		chanStart[0] = m.SyncTime + m.PorchTime
		chanStart[1] = chanStart[0] + chanLen[0] + m.SeptrTime
		chanStart[2] = chanStart[1] + chanLen[1] + m.SeptrTime
	}

	// Build pixel grid
	var pixels []PixelInfo

	if numChans == 4 { // PD modes
		// Each radio frame encodes two image lines
		for y := 0; y < m.NumLines; y += 2 {
			for channel := 0; channel < numChans; channel++ {
				for x := 0; x < m.ImgWidth; x++ {
					// slowrx video.c:140-142 - PD modes pixel time calculation
					// NOTE: slowrx uses Skip=0 for initial decode, only applies skip during redraw
					t := float64(y)/2*m.LineTime + chanStart[channel] + m.PixelTime*(float64(x)+0.5)
					sampleNum := int(math.Round(rate * t))

					if channel == 0 {
						pixels = append(pixels, PixelInfo{Time: sampleNum, X: x, Y: y, Channel: 0})
					} else if channel == 1 || channel == 2 {
						pixels = append(pixels, PixelInfo{Time: sampleNum, X: x, Y: y, Channel: uint8(channel)})
						pixels = append(pixels, PixelInfo{Time: sampleNum, X: x, Y: y + 1, Channel: uint8(channel)})
					} else if channel == 3 {
						pixels = append(pixels, PixelInfo{Time: sampleNum, X: x, Y: y + 1, Channel: 0})
					}
				}
			}
		}
	} else {
		// Standard modes
		for y := 0; y < m.NumLines; y++ {
			for channel := 0; channel < numChans; channel++ {
				for x := 0; x < m.ImgWidth; x++ {
					var ch uint8
					if m.Name == "Robot 36" || m.Name == "Robot 24" {
						if channel == 1 {
							if y%2 == 0 {
								ch = 1
							} else {
								ch = 2
							}
						} else {
							ch = 0
						}
					} else {
						ch = uint8(channel)
					}

					// slowrx video.c:196-198 - use the determined channel for ChanLen lookup
					// NOTE: slowrx uses Skip=0 for initial decode, only applies skip during redraw
					t := float64(y)*m.LineTime + chanStart[channel] + (float64(x)-0.5)/float64(m.ImgWidth)*chanLen[ch]
					sampleNum := int(math.Round(rate * t))

					pixels = append(pixels, PixelInfo{Time: sampleNum, X: x, Y: y, Channel: ch})
				}
			}
		}
	}

	// Mark last pixel
	if len(pixels) > 0 {
		pixels[len(pixels)-1].Last = true
	}

	// Filter out negative time pixels
	var filtered []PixelInfo
	for _, p := range pixels {
		if p.Time >= 0 {
			filtered = append(filtered, p)
		}
	}

	return filtered
}

// Demodulate performs FM demodulation of the video signal
// lineSender is an optional callback to send completed lines progressively
func (v *VideoDemodulator) Demodulate(pcmBuffer *SlidingPCMBuffer, rate float64, skip int, lineSender func(lineNum int, lineData []uint8)) ([]uint8, error) {
	m := v.mode
	pixelGrid := v.GetPixelGrid(rate, skip)

	log.Printf("[SSTV Video] Demodulating %s: %dx%d, %d pixels",
		m.Name, m.ImgWidth, m.NumLines, len(pixelGrid))

	// Calculate signal length
	var length int
	if m.ColorEnc == ColorYUV && m.ImgWidth >= 512 { // PD modes
		length = int(m.LineTime * float64(m.NumLines) / 2 * v.sampleRate)
	} else {
		length = int(m.LineTime * float64(m.NumLines) * v.sampleRate)
	}

	syncTargetBin := v.getBin(1200.0 + float64(v.headerShift))

	// Like slowrx, we advance WindowPtr by 1 each sample during decode
	// The buffer management keeps pace by shifting/refilling as needed
	log.Printf("[SSTV Video] Starting decode at windowPtr=%d", pcmBuffer.GetWindowPtr())

	// Initialize image buffer
	image := make([][][]uint8, m.ImgWidth)
	for x := range image {
		image[x] = make([][]uint8, m.NumLines)
		for y := range image[x] {
			image[x][y] = make([]uint8, 3)
		}
	}

	pixelIdx := 0
	nextSyncTime := 0
	nextSNRTime := 0
	syncSampleNum := 0
	snr := 0.0
	freq := 0.0

	// Process signal
	lastLogSample := 0
	for sampleNum := 0; sampleNum < length; sampleNum++ {
		// Log progress every 50k samples (~4 seconds at 12kHz)
		if sampleNum-lastLogSample >= 50000 {
			progress := float64(sampleNum) / float64(length) * 100
			log.Printf("[SSTV Video] Progress: %d/%d samples (%.1f%%), buffer has %d samples",
				sampleNum, length, progress, pcmBuffer.Available())
			lastLogSample = sampleNum
		}

		// Like slowrx video.c:266, ensure we have enough samples ahead
		// We need at least 1024 samples available for FFT operations
		available := pcmBuffer.Available()
		if available < 1024 {
			// Wait for more samples to arrive
			maxWaits := 500 // 5 seconds
			for i := 0; i < maxWaits && pcmBuffer.Available() < 1024; i++ {
				time.Sleep(10 * time.Millisecond)
			}
			if pcmBuffer.Available() < 1024 {
				log.Printf("[SSTV Video] Timeout waiting for samples at sampleNum=%d/%d (%.1f%% complete), ending decode",
					sampleNum, length, float64(sampleNum)/float64(length)*100)
				break
			}
		}

		// Sync detection (like slowrx video.c:271-297)
		if sampleNum == nextSyncTime {
			v.detectSync(pcmBuffer, syncTargetBin, syncSampleNum)
			nextSyncTime += 13
			syncSampleNum++
		}

		// SNR estimation (like slowrx video.c:304-344)
		if sampleNum == nextSNRTime {
			snr = v.estimateSNR(pcmBuffer)
			nextSNRTime += 256
		}

		// FM demodulation (like slowrx video.c:350-400, every 6 samples)
		if sampleNum%6 == 0 {
			freq = v.demodulateFrequency(pcmBuffer, snr)
		}

		// Store luminance
		lum := clip((freq - (1500.0 + float64(v.headerShift))) / 3.1372549)
		if sampleNum < len(v.storedLum) {
			v.storedLum[sampleNum] = lum
		}

		// Place pixels
		for pixelIdx < len(pixelGrid) && pixelGrid[pixelIdx].Time == sampleNum {
			p := pixelGrid[pixelIdx]
			image[p.X][p.Y][p.Channel] = lum

			// Some modes have R-Y & B-Y channels that are twice the height
			if p.Channel > 0 && (m.Name == "Robot 36" || m.Name == "Robot 24") {
				if p.Y+1 < m.NumLines {
					image[p.X][p.Y+1][p.Channel] = lum
				}
			}

			// Send line progressively when last pixel of line is placed (like slowrx line 428-457)
			if lineSender != nil && p.X == m.ImgWidth-1 {
				// Extract line data with proper color conversion (slowrx video.c:432-456)
				lineData := make([]uint8, m.ImgWidth*3)
				for x := 0; x < m.ImgWidth; x++ {
					offset := x * 3

					// Apply color conversion based on mode encoding
					switch m.ColorEnc {
					case ColorRGB:
						// slowrx video.c:434-438
						lineData[offset] = image[x][p.Y][0]
						lineData[offset+1] = image[x][p.Y][1]
						lineData[offset+2] = image[x][p.Y][2]

					case ColorGBR:
						// slowrx video.c:440-444
						lineData[offset] = image[x][p.Y][2]   // R from channel 2
						lineData[offset+1] = image[x][p.Y][0] // G from channel 0
						lineData[offset+2] = image[x][p.Y][1] // B from channel 1

					case ColorYUV:
						// slowrx video.c:446-450
						r := clip((100*float64(image[x][p.Y][0]) + 140*float64(image[x][p.Y][1]) - 17850) / 100.0)
						g := clip((100*float64(image[x][p.Y][0]) - 71*float64(image[x][p.Y][1]) - 33*float64(image[x][p.Y][2]) + 13260) / 100.0)
						b := clip((100*float64(image[x][p.Y][0]) + 178*float64(image[x][p.Y][2]) - 22695) / 100.0)
						lineData[offset] = r
						lineData[offset+1] = g
						lineData[offset+2] = b

					case ColorBW:
						// slowrx video.c:453-455
						lineData[offset] = image[x][p.Y][0]
						lineData[offset+1] = image[x][p.Y][0]
						lineData[offset+2] = image[x][p.Y][0]
					}
				}
				lineSender(p.Y, lineData)
			}

			pixelIdx++
		}

		// CRITICAL: Advance WindowPtr by 1 each sample, like slowrx video.c:484
		// This keeps WindowPtr tracking through the signal and prevents wraparound issues
		pcmBuffer.AdvanceWindow(1)
	}

	log.Printf("[SSTV Video] Decode complete, windowPtr advanced through entire signal")

	// Convert image to RGB byte array
	return v.convertToRGB(image), nil
}

// RedrawFromLuminance redraws the image from stored luminance with corrected parameters
// This matches slowrx's GetVideo(..., TRUE) - redraw from cached luminance
func (v *VideoDemodulator) RedrawFromLuminance(rate float64, skip int) []uint8 {
	m := v.mode
	pixelGrid := v.GetPixelGrid(rate, skip)

	log.Printf("[SSTV Video] Redrawing from stored luminance with rate=%.1f Hz, skip=%d", rate, skip)

	// Initialize image buffer
	image := make([][][]uint8, m.ImgWidth)
	for x := range image {
		image[x] = make([][]uint8, m.NumLines)
		for y := range image[x] {
			image[x][y] = make([]uint8, 3)
		}
	}

	// Place pixels from stored luminance
	for _, p := range pixelGrid {
		if p.Time >= 0 && p.Time < len(v.storedLum) {
			lum := v.storedLum[p.Time]
			image[p.X][p.Y][p.Channel] = lum

			// Some modes have R-Y & B-Y channels that are twice the height
			if p.Channel > 0 && (m.Name == "Robot 36" || m.Name == "Robot 24") {
				if p.Y+1 < m.NumLines {
					image[p.X][p.Y+1][p.Channel] = lum
				}
			}
		}
	}

	// Convert image to RGB byte array
	return v.convertToRGB(image)
}

// detectSync detects sync pulses for slant correction
func (v *VideoDemodulator) detectSync(pcmBuffer *SlidingPCMBuffer, syncTargetBin int, syncSampleNum int) {
	// Get 64-sample window centered at WindowPtr
	// slowrx: pcm.Buffer[pcm.WindowPtr+i-32]
	samples, err := pcmBuffer.GetWindow(-32, 64)
	if err != nil {
		return
	}

	// Apply Hann window (64 samples)
	for i := 0; i < 64 && i < len(v.fftInput); i++ {
		if i < len(v.hannWindows[1]) {
			v.fftInput[i] = float64(samples[i]) / 32768.0 * v.hannWindows[1][i]
		}
	}
	for i := 64; i < len(v.fftInput); i++ {
		v.fftInput[i] = 0
	}

	// FFT
	fft(v.fftInput, v.fftOutput)

	// Calculate power in sync and video bands
	pRaw := 0.0
	pSync := 0.0

	minBin := v.getBin(1500.0 + float64(v.headerShift))
	maxBin := v.getBin(2300.0 + float64(v.headerShift))

	for i := minBin; i <= maxBin && i < len(v.fftOutput); i++ {
		pRaw += v.power(v.fftOutput[i])
	}

	for i := syncTargetBin - 1; i <= syncTargetBin+1 && i < len(v.fftOutput); i++ {
		weight := 1.0 - 0.5*math.Abs(float64(syncTargetBin-i))
		pSync += v.power(v.fftOutput[i]) * weight
	}

	pRaw /= float64(maxBin - minBin)
	pSync /= 2.0

	// Sync detected if more than 2x power in sync band
	if syncSampleNum < len(v.hasSync) {
		v.hasSync[syncSampleNum] = (pSync > 2*pRaw)
	}
}

// estimateSNR estimates the signal-to-noise ratio
func (v *VideoDemodulator) estimateSNR(pcmBuffer *SlidingPCMBuffer) float64 {
	// Get 1024-sample window centered at WindowPtr
	// slowrx: pcm.Buffer[pcm.WindowPtr + i - FFTLen/2]
	samples, err := pcmBuffer.GetWindow(-512, 1024)
	if err != nil {
		return 0
	}

	// Apply Hann window
	for i := 0; i < 1024 && i < len(v.fftInput); i++ {
		if i < len(v.hannWindows[6]) {
			v.fftInput[i] = float64(samples[i]) / 32768.0 * v.hannWindows[6][i]
		}
	}

	// FFT
	fft(v.fftInput, v.fftOutput)

	// Calculate video+noise power (1500-2300 Hz)
	pVideoNoise := 0.0
	minBin := v.getBin(1500.0 + float64(v.headerShift))
	maxBin := v.getBin(2300.0 + float64(v.headerShift))
	for i := minBin; i <= maxBin && i < len(v.fftOutput); i++ {
		pVideoNoise += v.power(v.fftOutput[i])
	}

	// Calculate noise-only power (400-800 Hz + 2700-3400 Hz)
	pNoiseOnly := 0.0
	for i := v.getBin(400.0 + float64(v.headerShift)); i <= v.getBin(800.0+float64(v.headerShift)) && i < len(v.fftOutput); i++ {
		pNoiseOnly += v.power(v.fftOutput[i])
	}
	for i := v.getBin(2700.0 + float64(v.headerShift)); i <= v.getBin(3400.0+float64(v.headerShift)) && i < len(v.fftOutput); i++ {
		pNoiseOnly += v.power(v.fftOutput[i])
	}

	// Calculate SNR
	videoBins := maxBin - minBin + 1
	noiseBins := (v.getBin(800.0) - v.getBin(400.0) + 1) + (v.getBin(3400.0) - v.getBin(2700.0) + 1)
	receiverBins := v.getBin(3400.0) - v.getBin(400.0)

	pNoise := pNoiseOnly * float64(receiverBins) / float64(noiseBins)
	pSignal := pVideoNoise - pNoiseOnly*float64(videoBins)/float64(noiseBins)

	if pSignal/pNoise < 0.01 {
		return -20.0
	}
	return 10.0 * math.Log10(pSignal/pNoise)
}

// demodulateFrequency performs FM demodulation to extract frequency
func (v *VideoDemodulator) demodulateFrequency(pcmBuffer *SlidingPCMBuffer, snr float64) float64 {
	// Select window size based on SNR (adaptive windowing)
	winIdx := 0
	if v.adaptive {
		switch {
		case snr >= 20:
			winIdx = 0
		case snr >= 10:
			winIdx = 1
		case snr >= 9:
			winIdx = 2
		case snr >= 3:
			winIdx = 3
		case snr >= -5:
			winIdx = 4
		case snr >= -10:
			winIdx = 5
		default:
			winIdx = 6
		}

		// Minimum window length can be doubled for Scottie DX
		if v.mode.Name == "Scottie DX" && winIdx < 6 {
			winIdx++
		}
	}

	winLength := v.hannLens[winIdx]

	// Get window centered at WindowPtr
	// slowrx: pcm.Buffer[pcm.WindowPtr + i - WinLength/2]
	samples, err := pcmBuffer.GetWindow(-winLength/2, winLength)
	if err != nil {
		return 1500.0 + float64(v.headerShift)
	}

	// Apply Hann window
	for i := 0; i < len(v.fftInput); i++ {
		v.fftInput[i] = 0
	}
	for i := 0; i < winLength && i < len(v.fftInput); i++ {
		if i < len(v.hannWindows[winIdx]) {
			v.fftInput[i] = float64(samples[i]) / 32768.0 * v.hannWindows[winIdx][i]
		}
	}

	// FFT
	fft(v.fftInput, v.fftOutput)

	// Find peak frequency
	maxBin := 0
	maxPower := 0.0
	minBin := v.getBin(1500.0+float64(v.headerShift)) - 1
	maxBinLimit := v.getBin(2300.0+float64(v.headerShift)) + 1

	powers := make([]float64, v.fftSize)
	for i := minBin; i <= maxBinLimit && i < len(v.fftOutput); i++ {
		powers[i] = v.power(v.fftOutput[i])
		if powers[i] > maxPower {
			maxPower = powers[i]
			maxBin = i
		}
	}

	// Gaussian interpolation
	var freq float64
	if maxBin > minBin && maxBin < maxBinLimit && powers[maxBin] > 0 && powers[maxBin-1] > 0 && powers[maxBin+1] > 0 {
		numerator := powers[maxBin+1] / powers[maxBin-1]
		denominator := (powers[maxBin] * powers[maxBin]) / (powers[maxBin+1] * powers[maxBin-1])

		if numerator > 0 && denominator > 0 {
			delta := math.Log(numerator) / (2.0 * math.Log(denominator))
			freq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
		} else {
			freq = float64(maxBin) / float64(v.fftSize) * v.sampleRate
		}
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

// convertToRGB converts the image array to RGB byte array
func (v *VideoDemodulator) convertToRGB(image [][][]uint8) []uint8 {
	m := v.mode
	rgb := make([]uint8, m.ImgWidth*m.NumLines*3)

	for y := 0; y < m.NumLines; y++ {
		for x := 0; x < m.ImgWidth; x++ {
			offset := (y*m.ImgWidth + x) * 3

			switch m.ColorEnc {
			case ColorRGB:
				rgb[offset] = image[x][y][0]
				rgb[offset+1] = image[x][y][1]
				rgb[offset+2] = image[x][y][2]

			case ColorGBR:
				rgb[offset] = image[x][y][2]
				rgb[offset+1] = image[x][y][0]
				rgb[offset+2] = image[x][y][1]

			case ColorYUV:
				r := clip((100*float64(image[x][y][0]) + 140*float64(image[x][y][1]) - 17850) / 100.0)
				g := clip((100*float64(image[x][y][0]) - 71*float64(image[x][y][1]) - 33*float64(image[x][y][2]) + 13260) / 100.0)
				b := clip((100*float64(image[x][y][0]) + 178*float64(image[x][y][2]) - 22695) / 100.0)
				rgb[offset] = r
				rgb[offset+1] = g
				rgb[offset+2] = b

			case ColorBW:
				rgb[offset] = image[x][y][0]
				rgb[offset+1] = image[x][y][0]
				rgb[offset+2] = image[x][y][0]
			}
		}
	}

	return rgb
}

// Helper functions

func (v *VideoDemodulator) getBin(freq float64) int {
	return int(freq / v.sampleRate * float64(v.fftSize))
}

func (v *VideoDemodulator) power(c complex128) float64 {
	return real(c)*real(c) + imag(c)*imag(c)
}

func clip(value float64) uint8 {
	if value < 0 {
		return 0
	}
	if value > 255 {
		return 255
	}
	return uint8(value)
}
