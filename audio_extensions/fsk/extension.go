package fsk

import (
	"fmt"
	"log"
)

// FSKExtension wraps the FSK decoder as an AudioExtension
type FSKExtension struct {
	decoder *FSKDecoder
	config  FSKConfig
}

// NewFSKExtension creates a new FSK audio extension
func NewFSKExtension(sampleRate int, extensionParams map[string]interface{}) (*FSKExtension, error) {
	// Start with default config
	config := DefaultFSKConfig()

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

	// Note: Only CCIR476 encoding is supported (NAVTEX mode)

	decoder := NewFSKDecoder(sampleRate, config)

	log.Printf("[FSK Extension] Created with config: CF=%.1f Hz, Shift=%.1f Hz, Baud=%.1f, Encoding=CCIR476, Inverted=%v",
		config.CenterFrequency, config.Shift, config.BaudRate, config.Inverted)

	return &FSKExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *FSKExtension) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension
func (e *FSKExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *FSKExtension) GetName() string {
	return "fsk"
}
