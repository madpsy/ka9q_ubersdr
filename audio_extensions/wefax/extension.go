package wefax

import (
	"fmt"
	"log"
)

// WEFAXExtension wraps the WEFAX decoder as an AudioExtension
type WEFAXExtension struct {
	decoder *WEFAXDecoder
	config  WEFAXConfig
}

// NewWEFAXExtension creates a new WEFAX audio extension
func NewWEFAXExtension(sampleRate int, extensionParams map[string]interface{}) (*WEFAXExtension, error) {
	// Start with default config
	config := DefaultWEFAXConfig()

	// Override with user parameters
	if lpm, ok := extensionParams["lpm"].(float64); ok {
		config.LPM = int(lpm)
	}
	if width, ok := extensionParams["image_width"].(float64); ok {
		config.ImageWidth = int(width)
	}
	if carrier, ok := extensionParams["carrier"].(float64); ok {
		config.Carrier = carrier
	}
	if deviation, ok := extensionParams["deviation"].(float64); ok {
		config.Deviation = deviation
	}
	if bandwidth, ok := extensionParams["bandwidth"].(float64); ok {
		config.Bandwidth = Bandwidth(int(bandwidth))
	}
	if usePhasing, ok := extensionParams["use_phasing"].(bool); ok {
		config.UsePhasing = usePhasing
	}
	if autoStop, ok := extensionParams["auto_stop"].(bool); ok {
		config.AutoStop = autoStop
	}
	if autoStart, ok := extensionParams["auto_start"].(bool); ok {
		config.AutoStart = autoStart
	}
	if includeHeaders, ok := extensionParams["include_headers_in_images"].(bool); ok {
		config.IncludeHeadersInImages = includeHeaders
	}

	// Validate configuration
	if config.LPM <= 0 || config.LPM > 300 {
		return nil, fmt.Errorf("invalid LPM: %d (must be 1-300)", config.LPM)
	}
	if config.ImageWidth <= 0 || config.ImageWidth > 4000 {
		return nil, fmt.Errorf("invalid image width: %d (must be 1-4000)", config.ImageWidth)
	}
	if config.Carrier <= 0 || config.Carrier > 10000 {
		return nil, fmt.Errorf("invalid carrier frequency: %.1f Hz (must be 1-10000)", config.Carrier)
	}
	if config.Deviation <= 0 || config.Deviation > 1000 {
		return nil, fmt.Errorf("invalid deviation: %.1f Hz (must be 1-1000)", config.Deviation)
	}
	if config.Bandwidth < BandwidthNarrow || config.Bandwidth > BandwidthWide {
		return nil, fmt.Errorf("invalid bandwidth: %d (must be 0-2)", config.Bandwidth)
	}

	decoder := NewWEFAXDecoder(sampleRate, config)

	log.Printf("[WEFAX Extension] Created with config: LPM=%d, Width=%d, Carrier=%.1f Hz, Deviation=%.1f Hz",
		config.LPM, config.ImageWidth, config.Carrier, config.Deviation)

	return &WEFAXExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *WEFAXExtension) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension
func (e *WEFAXExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *WEFAXExtension) GetName() string {
	return "wefax"
}
