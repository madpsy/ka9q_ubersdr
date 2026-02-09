package wefax

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"sync"
)

// Bandwidth represents FIR filter bandwidth options
type Bandwidth int

const (
	BandwidthNarrow Bandwidth = 0
	BandwidthMiddle Bandwidth = 1
	BandwidthWide   Bandwidth = 2
)

// HeaderType represents the type of line detected
type HeaderType int

const (
	HeaderImage HeaderType = 0
	HeaderStart HeaderType = 1
	HeaderStop  HeaderType = 2
)

// FIRFilter implements a 17-tap low-pass filter
type FIRFilter struct {
	bandwidth Bandwidth
	buffer    [17]float64
	current   int
}

// NewFIRFilter creates a new FIR filter with the specified bandwidth
func NewFIRFilter(bandwidth Bandwidth) *FIRFilter {
	return &FIRFilter{
		bandwidth: bandwidth,
		current:   0,
	}
}

// Apply applies the FIR filter to a sample
func (f *FIRFilter) Apply(sample float64) float64 {
	// Low pass filter coefficients from ACfax
	lpfCoeff := [3][17]float64{
		{-7, -18, -15, 11, 56, 116, 177, 223, 240, 223, 177, 116, 56, 11, -15, -18, -7}, // Narrow
		{0, -18, -38, -39, 0, 83, 191, 284, 320, 284, 191, 83, 0, -39, -38, -18, 0},     // Middle
		{6, 20, 7, -42, -74, -12, 159, 353, 440, 353, 159, -12, -74, -42, 7, 20, 6},     // Wide
	}

	coeff := lpfCoeff[f.bandwidth]

	// Replace oldest value with current
	f.buffer[f.current] = sample

	// Convolution
	sum := 0.0
	idx := f.current
	for i := 0; i < 17; i++ {
		sum += f.buffer[idx] * coeff[i]
		idx++
		if idx >= 17 {
			idx = 0
		}
	}

	// Point to oldest value for next iteration
	f.current--
	if f.current < 0 {
		f.current = 16
	}

	return sum
}

// WEFAXDecoder implements weather fax decoding
type WEFAXDecoder struct {
	// Configuration
	lpm                      int     // Lines per minute
	imageWidth               int     // Image width in pixels
	bitsPerPixel             int     // Bits per pixel (typically 8)
	carrier                  float64 // Carrier frequency (Hz)
	deviation                float64 // Deviation (Hz)
	minusSaturationThreshold float64 // Saturation threshold
	includeHeadersInImages   bool    // Include start/stop headers in image
	usePhasing               bool    // Use phasing line detection
	autoStop                 bool    // Auto-stop on stop signal
	autoStart                bool    // Auto-start on start signal (don't decode until START detected)
	skipHeaderDetection      bool    // Skip header detection

	// Sample rate
	samplesPerSecNom      float64
	samplesPerSecFrac     float64
	samplesPerSecFracPrev float64
	sampleRateRatio       float64
	samplesPerLine        int

	// Demodulation state
	firFilters [2]*FIRFilter
	iPrev      float64
	qPrev      float64

	// Sample buffering
	samples   []int16
	sampIdx   int
	fi        float64
	demodData []uint8
	skip      int

	// Image state
	imgData      []uint8
	outImage     []uint8
	imageLine    int
	imageColors  int
	height       int
	imgPos       int
	lineIncrFrac float64
	lineIncrAcc  float64
	lineBlend    float64

	// Header detection
	startIOC576Frequency int
	startIOC288Frequency int
	stopFrequency        int
	startStopLength      int
	lastType             HeaderType
	typeCount            int

	// Phasing
	phasingLines     int
	phasingPos       []int
	phasingLinesLeft int
	phasingSkipData  int
	havePhasing      bool

	// Control
	autoStopped bool
	autoStarted bool // Track if START signal has been detected (for auto_start mode)
	running     bool
	mu          sync.Mutex
	stopChan    chan struct{}
	wg          sync.WaitGroup
}

// WEFAXConfig contains configuration parameters for the WEFAX decoder
type WEFAXConfig struct {
	LPM                      int       `json:"lpm"`                        // Lines per minute (60, 90, 120, 240)
	ImageWidth               int       `json:"image_width"`                // Image width in pixels (typically 1809)
	BitsPerPixel             int       `json:"bits_per_pixel"`             // Bits per pixel (8)
	Carrier                  float64   `json:"carrier"`                    // Carrier frequency in Hz (1900)
	Deviation                float64   `json:"deviation"`                  // Deviation in Hz (400)
	Bandwidth                Bandwidth `json:"bandwidth"`                  // Filter bandwidth (0=narrow, 1=middle, 2=wide)
	MinusSaturationThreshold float64   `json:"minus_saturation_threshold"` // Saturation threshold
	IncludeHeadersInImages   bool      `json:"include_headers_in_images"`  // Include headers in output
	UsePhasing               bool      `json:"use_phasing"`                // Use phasing line detection
	AutoStop                 bool      `json:"auto_stop"`                  // Auto-stop on stop signal
	AutoStart                bool      `json:"auto_start"`                 // Auto-start on start signal (wait for START before decoding)
}

// DefaultWEFAXConfig returns default configuration
func DefaultWEFAXConfig() WEFAXConfig {
	return WEFAXConfig{
		LPM:                      120,
		ImageWidth:               1809,
		BitsPerPixel:             8,
		Carrier:                  1900.0,
		Deviation:                400.0,
		Bandwidth:                BandwidthMiddle,
		MinusSaturationThreshold: 0.0,
		IncludeHeadersInImages:   false,
		UsePhasing:               true,
		AutoStop:                 false,
		AutoStart:                false,
	}
}

// NewWEFAXDecoder creates a new WEFAX decoder
func NewWEFAXDecoder(sampleRate int, config WEFAXConfig) *WEFAXDecoder {
	d := &WEFAXDecoder{
		lpm:                      config.LPM,
		imageWidth:               config.ImageWidth,
		bitsPerPixel:             config.BitsPerPixel,
		carrier:                  config.Carrier,
		deviation:                config.Deviation,
		minusSaturationThreshold: config.MinusSaturationThreshold,
		includeHeadersInImages:   config.IncludeHeadersInImages,
		usePhasing:               config.UsePhasing,
		autoStop:                 config.AutoStop,
		autoStart:                config.AutoStart,
		samplesPerSecNom:         float64(sampleRate),
		samplesPerSecFrac:        float64(sampleRate),
		samplesPerSecFracPrev:    float64(sampleRate),
		imageColors:              1,
		startIOC576Frequency:     300,
		startIOC288Frequency:     675,
		stopFrequency:            450,
		startStopLength:          5,
		phasingLines:             40,
		lastType:                 HeaderImage,
		stopChan:                 make(chan struct{}),
	}

	// Initialize FIR filters
	d.firFilters[0] = NewFIRFilter(config.Bandwidth)
	d.firFilters[1] = NewFIRFilter(config.Bandwidth)

	// Skip header detection if not using phasing, autostop, or autostart
	d.skipHeaderDetection = !d.usePhasing && !d.autoStop && !d.autoStart

	// Calculate samples per line
	samplesPerMin := d.samplesPerSecNom * 60.0
	d.samplesPerLine = int(samplesPerMin / float64(d.lpm))

	// Allocate buffers
	d.samples = make([]int16, d.samplesPerLine)
	d.demodData = make([]uint8, d.samplesPerLine)
	d.phasingPos = make([]int, d.phasingLines)

	// Initialize image
	d.height = 256 // Initial height, will grow as needed
	d.imgData = make([]uint8, d.imageWidth*d.height*d.imageColors)
	d.outImage = make([]uint8, d.imageWidth*d.imageColors)

	// Line blending
	d.lineIncrFrac = float64(d.imageWidth) / (math.Pi * 576)
	d.sampleRateRatio = d.samplesPerSecFrac / d.samplesPerSecNom

	log.Printf("[WEFAX] Initialized: LPM=%d, Width=%d, Carrier=%.1f Hz, Deviation=%.1f Hz, SamplesPerLine=%d",
		d.lpm, d.imageWidth, d.carrier, d.deviation, d.samplesPerLine)

	return d
}

// Start begins processing audio samples
func (d *WEFAXDecoder) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	d.mu.Lock()
	if d.running {
		d.mu.Unlock()
		return fmt.Errorf("decoder already running")
	}
	d.running = true
	d.mu.Unlock()

	d.wg.Add(1)
	go d.processLoop(audioChan, resultChan)

	return nil
}

// Stop stops the decoder
func (d *WEFAXDecoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.mu.Unlock()

	close(d.stopChan)
	d.wg.Wait()

	d.mu.Lock()
	d.running = false
	d.mu.Unlock()

	return nil
}

// GetName returns the decoder name
func (d *WEFAXDecoder) GetName() string {
	return "wefax"
}

// processLoop is the main processing loop
func (d *WEFAXDecoder) processLoop(audioChan <-chan []int16, resultChan chan<- []byte) {
	defer d.wg.Done()

	for {
		select {
		case <-d.stopChan:
			return
		case samples, ok := <-audioChan:
			if !ok {
				return
			}
			d.processSamples(samples, resultChan)
		}
	}
}

// processSamples processes incoming audio samples
func (d *WEFAXDecoder) processSamples(samps []int16, resultChan chan<- []byte) {
	i := 0

	// Handle skip
	if d.skip > 0 {
		skip := d.skip
		if skip > len(samps) {
			skip = len(samps)
		}
		samps = samps[skip:]
		d.skip -= skip
	}

	for i < len(samps) {
		// Accumulate samples for one line
		for i < len(samps) && d.sampIdx < d.samplesPerLine {
			d.samples[d.sampIdx] = samps[i]
			d.sampIdx++
			d.fi += d.sampleRateRatio
			i = int(math.Trunc(d.fi))
		}

		// Process complete line
		if d.sampIdx == d.samplesPerLine {
			d.decodeFaxLine(resultChan)
			d.sampIdx = 0
		}
	}

	d.fi -= float64(len(samps)) // Keep bounded
}

// decodeFaxLine decodes a single fax line
func (d *WEFAXDecoder) decodeFaxLine(resultChan chan<- []byte) {
	const phasingSkipLines = 2

	// Demodulate the data
	d.demodulateData()

	// Detect line type (START, STOP, or IMAGE)
	var lineType HeaderType
	if d.skipHeaderDetection {
		lineType = HeaderImage
	} else {
		bufferLen := d.samplesPerLine
		if bufferLen > 3000 {
			bufferLen = 3000
		}
		lineType = d.detectLineType(d.demodData, bufferLen)
	}

	// Accumulate start/stop line counts
	if lineType == d.lastType && lineType != HeaderImage {
		d.typeCount++
	} else {
		d.typeCount--
		if d.typeCount < 0 {
			d.typeCount = 0
		}
	}
	d.lastType = lineType

	// Handle start/stop detection
	if lineType != HeaderImage {
		leewayLines := 4
		threshold := d.startStopLength*d.lpm/60 - leewayLines

		if d.typeCount == threshold {
			if lineType == HeaderStart {
				// Prepare for phasing
				if !d.includeHeadersInImages {
					d.imageLine = 0
					d.imgPos = 0
					d.lineIncrAcc = 0
				}
				d.phasingLinesLeft = d.phasingLines
				d.phasingSkipData = 0
				d.havePhasing = false
				if d.autoStopped {
					d.autoStopped = false
					log.Printf("[WEFAX] Auto-stop cleared at line %d", d.imageLine)
				}
				// Handle auto-start
				if d.autoStart && !d.autoStarted {
					d.autoStarted = true
					log.Printf("[WEFAX] Auto-start: START signal detected, beginning decode at line %d", d.imageLine)
				}
			} else if lineType == HeaderStop {
				if d.autoStop {
					d.autoStopped = true
					log.Printf("[WEFAX] Auto-stopped at line %d", d.imageLine)
				}
				// Reset auto-start flag on STOP signal
				if d.autoStart && d.autoStarted {
					d.autoStarted = false
					log.Printf("[WEFAX] Auto-start: STOP signal detected, waiting for next START at line %d", d.imageLine)
				}
			}
		}
	}

	// Phasing line detection
	if d.usePhasing && d.phasingLinesLeft > 0 && d.phasingLinesLeft <= d.phasingLines-phasingSkipLines {
		d.phasingPos[d.phasingLinesLeft-1] = d.faxPhasingLinePosition(d.demodData)
	}

	if d.usePhasing && lineType == HeaderImage && d.phasingLinesLeft >= -phasingSkipLines {
		d.phasingLinesLeft--
		if d.phasingLinesLeft == 0 {
			// Calculate median phasing position
			d.phasingSkipData = median(d.phasingPos[:d.phasingLines-phasingSkipLines])

			// Validate phasing data distribution
			tenPct := percentile(d.phasingPos[:d.phasingLines-phasingSkipLines], 10)
			ninetyPct := percentile(d.phasingPos[:d.phasingLines-phasingSkipLines], 90)

			if (ninetyPct - tenPct) > d.samplesPerLine/6 {
				log.Printf("[WEFAX] Bad phasing data detected, ignoring")
				d.phasingSkipData = 0
			} else {
				log.Printf("[WEFAX] Phasing detected: skip=%d pixels", d.phasingSkipData)
			}
		}
	}

	// Decode image line
	if d.includeHeadersInImages || !d.usePhasing || (lineType == HeaderImage && d.phasingLinesLeft < -phasingSkipLines) {
		// Grow image buffer if needed
		if d.imageLine >= d.height {
			d.height *= 2
			newData := make([]uint8, d.imageWidth*d.height*d.imageColors)
			copy(newData, d.imgData)
			d.imgData = newData
		}

		// Decode the line only if:
		// - Not auto-stopped (if auto-stop is enabled)
		// - Auto-started (if auto-start is enabled), or auto-start is disabled
		shouldDecode := !d.autoStopped && (!d.autoStart || d.autoStarted)

		if shouldDecode {
			d.decodeImageLine(d.demodData, resultChan)
		}

		// Apply phasing offset
		d.phasingSkipData %= d.samplesPerLine
		if d.phasingSkipData != 0 && d.usePhasing && !d.havePhasing {
			d.skip = d.phasingSkipData
			d.havePhasing = true
			log.Printf("[WEFAX] Applied phasing offset: %d samples", d.phasingSkipData)
		}

		d.imgPos += d.imageWidth * d.imageColors
		d.imageLine++
	}
}

// demodulateData performs FM demodulation
func (d *WEFAXDecoder) demodulateData() {
	phaseInc := d.carrier / d.samplesPerSecFrac
	phase := 0.0

	scale := -1.3 * (d.samplesPerSecNom / d.deviation / 8)

	for i := 0; i < d.samplesPerLine; i++ {
		// Normalize sample to -1..0..1
		samp := float64(d.samples[i]) / 32768.0

		// Mix to carrier frequency
		iCur := d.firFilters[0].Apply(samp * math.Cos(2*math.Pi*phase))
		qCur := d.firFilters[1].Apply(samp * math.Sin(2*math.Pi*phase))

		phase += phaseInc
		if phase > 1.0 {
			phase -= 1.0
		}

		// Normalize I/Q
		mag := math.Sqrt(qCur*qCur + iCur*iCur)
		if mag > 0 {
			iCur /= mag
			qCur /= mag
		}

		// FM demodulation
		x := (iCur*(qCur-d.qPrev) - qCur*(iCur-d.iPrev)) * scale
		x = x/2.0 + 0.5

		// Convert to pixel value
		pixel := int(x * 255.0)
		if pixel < 0 {
			pixel = 0
		} else if pixel > 255 {
			pixel = 255
		}

		d.demodData[i] = uint8(pixel)

		d.iPrev = iCur
		d.qPrev = qCur
	}
}

// fourierTransformSub performs Fourier transform at a specific frequency
func (d *WEFAXDecoder) fourierTransformSub(buffer []uint8, freq int) float64 {
	k := -2 * math.Pi * float64(freq) * 60.0 / float64(d.lpm) / float64(d.samplesPerLine)
	retr := 0.0
	reti := 0.0

	for n := 0; n < len(buffer); n++ {
		retr += float64(buffer[n]) * math.Cos(k*float64(n))
		reti += float64(buffer[n]) * math.Sin(k*float64(n))
	}

	return math.Sqrt(retr*retr + reti*reti)
}

// detectLineType detects if line is START, STOP, or IMAGE
func (d *WEFAXDecoder) detectLineType(buffer []uint8, bufferLen int) HeaderType {
	const threshold = 5.0

	startDet := d.fourierTransformSub(buffer[:bufferLen], d.startIOC576Frequency) / float64(bufferLen)
	stopDet := d.fourierTransformSub(buffer[:bufferLen], d.stopFrequency) / float64(bufferLen)

	if startDet > threshold {
		return HeaderStart
	}
	if stopDet > threshold {
		return HeaderStop
	}
	return HeaderImage
}

// faxPhasingLinePosition detects the start position from phasing line
func (d *WEFAXDecoder) faxPhasingLinePosition(image []uint8) int {
	n := int(float64(d.samplesPerLine) * 0.07)
	minTotal := -1
	minPos := 0

	pixelResolution := 4
	sampsIncr := (d.samplesPerLine / d.imageWidth) * pixelResolution

	for i := 0; i < d.samplesPerLine; i += sampsIncr {
		total := 0
		for j := 0; j < n; j += pixelResolution {
			wedge := n/2 - abs(j-n/2)
			idx := (i + j) % d.samplesPerLine
			total += wedge * (255 - int(image[idx]))
		}

		if total < minTotal || minTotal == -1 {
			minTotal = total
			minPos = i
		}
	}

	return (minPos + n/2) % d.samplesPerLine
}

// decodeImageLine decodes a single image line
func (d *WEFAXDecoder) decodeImageLine(buffer []uint8, resultChan chan<- []byte) {
	// Resample buffer to image width
	for i := 0; i < d.imageWidth; i++ {
		firstSample := d.samplesPerLine * i / d.imageWidth
		lastSample := d.samplesPerLine*(i+1)/d.imageWidth - 1

		pixel := 0
		pixelSamples := 0

		for sample := firstSample; sample <= lastSample; sample++ {
			pixel += int(buffer[sample])
			pixelSamples++
		}

		pixel /= pixelSamples
		d.imgData[d.imgPos+i] = uint8(pixel)
	}

	// Line blending for sample rate adaptation
	emit := false
	if d.lineIncrAcc >= 1.0 {
		d.lineIncrAcc -= 1.0

		if d.imageLine != 0 && d.lineIncrAcc != 0 {
			lineNextBlend := d.lineIncrAcc / d.lineBlend
			linePrevBlend := 1.0 - lineNextBlend

			prevLineStart := d.imgPos - d.imageWidth
			for i := 0; i < d.imageWidth; i++ {
				pixel := float64(d.imgData[d.imgPos+i])*lineNextBlend +
					float64(d.imgData[prevLineStart+i])*linePrevBlend
				if pixel > 255 {
					pixel = 255
				}
				d.outImage[i] = uint8(pixel)
			}
			d.lineBlend = d.lineIncrFrac
		} else {
			copy(d.outImage, d.imgData[d.imgPos:d.imgPos+d.imageWidth])
		}
		emit = true
	} else {
		d.lineBlend += d.lineIncrFrac
	}
	d.lineIncrAcc += d.lineIncrFrac

	// Send image line to client
	if emit {
		d.sendImageLine(resultChan)
	}
}

// sendImageLine sends a decoded image line to the client
func (d *WEFAXDecoder) sendImageLine(resultChan chan<- []byte) {
	// Binary protocol: [type:1][line_number:4][width:4][data:width]
	// type: 0x01 = image line
	msg := make([]byte, 1+4+4+d.imageWidth)
	msg[0] = 0x01 // Image line type
	binary.BigEndian.PutUint32(msg[1:5], uint32(d.imageLine))
	binary.BigEndian.PutUint32(msg[5:9], uint32(d.imageWidth))
	copy(msg[9:], d.outImage[:d.imageWidth])

	select {
	case resultChan <- msg:
	default:
		// Channel full, skip this line
	}
}

// Helper functions

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func median(values []int) int {
	if len(values) == 0 {
		return 0
	}

	// Make a copy and sort
	sorted := make([]int, len(values))
	copy(sorted, values)

	// Simple bubble sort (good enough for small arrays)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[i] > sorted[j] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	return sorted[len(sorted)/2]
}

func percentile(values []int, pct int) int {
	if len(values) == 0 {
		return 0
	}

	// Make a copy and sort
	sorted := make([]int, len(values))
	copy(sorted, values)

	// Simple bubble sort
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[i] > sorted[j] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	idx := (len(sorted) * pct) / 100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}

	return sorted[idx]
}
