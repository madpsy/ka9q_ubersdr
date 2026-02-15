package ft8

import (
	"fmt"
	"log"
)

/*
 * FT8 Extension Wrapper
 * Integrates FT8 decoder with UberSDR audio extension framework
 *
 * Copyright (c) 2026, UberSDR project
 */

// AudioExtensionParams contains audio stream parameters
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (mono, int16)
	RTPTimestamp uint32  // RTP timestamp from radiod (for jitter/loss detection)
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds (packet arrival time)
}

// AudioExtension interface for extensible audio processors
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// FT8Extension wraps the FT8 decoder as an AudioExtension
type FT8Extension struct {
	decoder *FT8Decoder
	config  FT8Config
}

// NewFT8Extension creates a new FT8 audio extension
func NewFT8Extension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*FT8Extension, error) {
	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("FT8 requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("FT8 requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}
	if audioParams.SampleRate < 12000 {
		return nil, fmt.Errorf("FT8 requires at least 12 kHz sample rate (got %d Hz)", audioParams.SampleRate)
	}

	// Start with default config
	config := DefaultFT8Config()

	// Override with user parameters
	if protocol, ok := extensionParams["protocol"].(string); ok {
		if protocol == "FT4" {
			config.Protocol = ProtocolFT4
		} else {
			config.Protocol = ProtocolFT8
		}
	}

	// min_score is always 0 (matches reference implementation)
	// Frontend cannot override this parameter

	if maxCandidates, ok := extensionParams["max_candidates"].(float64); ok {
		config.MaxCandidates = int(maxCandidates)
	}

	// Extract receiver locator (optional)
	receiverLocator := ""
	if locator, ok := extensionParams["receiver_locator"].(string); ok {
		receiverLocator = locator
	}

	// Extract CTY database (optional, passed as interface)
	var ctyDatabase interface{}
	if cty, ok := extensionParams["cty_database"]; ok {
		ctyDatabase = cty
	}

	// Create decoder
	decoder := NewFT8Decoder(audioParams.SampleRate, config, receiverLocator, ctyDatabase)

	protocolName := "FT8"
	if config.Protocol == ProtocolFT4 {
		protocolName = "FT4"
	}

	log.Printf("[FT8 Extension] Created %s decoder with sample rate: %d Hz, min_score: %d, max_candidates: %d",
		protocolName, audioParams.SampleRate, config.MinScore, config.MaxCandidates)

	return &FT8Extension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *FT8Extension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension
func (e *FT8Extension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *FT8Extension) GetName() string {
	return "ft8"
}
