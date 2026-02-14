package fsk

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

// FSKExtension wraps the FSK decoder as an AudioExtension
type FSKExtension struct {
	decoder *FSKDecoder
	config  FSKConfig
}

// NewFSKExtension creates a new FSK audio extension
func NewFSKExtension(sampleRate int, extensionParams map[string]interface{}) (*FSKExtension, error) {
	// Start with default config
	config := DefaultFSKConfig()

	// Check for preset first
	if preset, ok := extensionParams["preset"].(string); ok {
		switch preset {
		case "navtex":
			config = NavtexConfig()
		case "weather":
			config = WeatherConfig()
		default:
			log.Printf("[FSK Extension] Unknown preset: %s, using default", preset)
		}
	}

	// Override with user parameters (these take precedence over preset)
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
		return nil, fmt.Errorf("invalid baud rate: %.1f (must be 10-1000)", config.BaudRate)
	}

	decoder := NewFSKDecoder(sampleRate, config)

	log.Printf("[FSK Extension] Created with config: CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Framing=%s, Encoding=%s, Inverted=%v",
		config.CenterFrequency, config.Shift, config.BaudRate, config.Framing, config.Encoding, config.Inverted)

	return &FSKExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *FSKExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
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
func (e *FSKExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *FSKExtension) GetName() string {
	return "fsk"
}
