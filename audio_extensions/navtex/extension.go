package navtex

import (
	"fmt"
	"log"
)

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (mono, int16)
	RTPTimestamp uint32  // RTP timestamp from radiod (for jitter/loss detection)
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds (packet arrival time)
}

// NAVTEXExtension wraps the NAVTEX decoder as an AudioExtension
type NAVTEXExtension struct {
	decoder *NAVTEXDecoder
	config  NAVTEXConfig
}

// NewNAVTEXExtension creates a new NAVTEX audio extension
func NewNAVTEXExtension(sampleRate int, extensionParams map[string]interface{}) (*NAVTEXExtension, error) {
	// Start with default config
	config := DefaultNAVTEXConfig()

	// Override with user parameters
	if cf, ok := extensionParams["center_frequency"].(float64); ok {
		config.CenterFrequency = cf
	}
	if shift, ok := extensionParams["shift"].(float64); ok {
		config.Shift = shift
	}
	if baud, ok := extensionParams["baud_rate"].(float64); ok {
		config.BaudRate = baud
	}
	if inv, ok := extensionParams["inverted"].(bool); ok {
		config.Inverted = inv
	}
	if framing, ok := extensionParams["framing"].(string); ok {
		config.Framing = framing
	}
	if encoding, ok := extensionParams["encoding"].(string); ok {
		config.Encoding = encoding
	}

	// Validate configuration
	if config.CenterFrequency <= 0 || config.CenterFrequency > 10000 {
		return nil, fmt.Errorf("invalid center frequency: %.1f Hz (must be 1-10000)", config.CenterFrequency)
	}
	if config.Shift <= 0 || config.Shift > 1000 {
		return nil, fmt.Errorf("invalid shift: %.1f Hz (must be 1-1000)", config.Shift)
	}
	if config.BaudRate <= 0 || config.BaudRate > 1000 {
		return nil, fmt.Errorf("invalid baud rate: %.1f (must be 1-1000)", config.BaudRate)
	}
	if config.Encoding != "CCIR476" {
		return nil, fmt.Errorf("unsupported encoding: %s (only CCIR476 supported)", config.Encoding)
	}

	decoder := NewNAVTEXDecoder(sampleRate, config)

	log.Printf("[NAVTEX Extension] Created with config: CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Encoding=%s",
		config.CenterFrequency, config.Shift, config.BaudRate, config.Encoding)

	return &NAVTEXExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *NAVTEXExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	// Convert AudioSample to []int16 for the decoder
	// In the future, the decoder could use timestamps for message timestamping
	legacyChan := make(chan []int16, cap(audioChan))
	go func() {
		defer close(legacyChan)
		for sample := range audioChan {
			// TODO: Could use sample.GPSTimeNs to timestamp decoded messages
			legacyChan <- sample.PCMData
		}
	}()
	return e.decoder.Start(legacyChan, resultChan)
}

// Stop stops the extension
func (e *NAVTEXExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *NAVTEXExtension) GetName() string {
	return "navtex"
}
