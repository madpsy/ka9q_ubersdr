package whisper

import (
	"fmt"
	"log"
)

/*
 * Whisper Speech-to-Text Extension
 * Streams audio to WhisperLive server for real-time transcription
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
	RTPTimestamp uint32  // RTP timestamp from radiod
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds
}

// AudioExtension interface for extensible audio processors
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// WhisperExtension wraps the Whisper decoder as an AudioExtension
type WhisperExtension struct {
	decoder *WhisperDecoder
	config  WhisperConfig
}

// NewWhisperExtension creates a new Whisper audio extension
func NewWhisperExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*WhisperExtension, error) {
	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("whisper requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("whisper requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Start with default config
	// All parameters are server-side only for security and resource management
	config := DefaultWhisperConfig()

	// No user-configurable parameters - all settings are server-side defaults
	// This prevents users from:
	// - Changing the server URL (security)
	// - Selecting expensive models (resource management)
	// - Changing language settings (consistency)

	// Create decoder
	decoder := NewWhisperDecoder(audioParams.SampleRate, config)

	log.Printf("[Whisper Extension] Created with server: %s, model: %s, language: %s, sample rate: %d Hz",
		config.ServerURL, config.Model, config.Language, audioParams.SampleRate)

	return &WhisperExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *WhisperExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension
func (e *WhisperExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *WhisperExtension) GetName() string {
	return "whisper"
}
