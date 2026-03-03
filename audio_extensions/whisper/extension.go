package whisper

import (
	"fmt"
	"log"
	"sync"
)

// ConfigProvider is set by main package to provide access to configuration
type ConfigProvider struct {
	Enabled        bool
	ServerURL      string
	Model          string
	Language       string
	Translate      bool
	SendIntervalMs int
	InitialPrompt  string
	InstanceUUID   string
	MaxUsers       int
}

// GlobalConfigProvider is set by main package
var GlobalConfigProvider *ConfigProvider

// activeUserCount tracks the number of concurrent whisper users
var activeUserCount int
var activeUserMutex sync.Mutex

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
	// Check if extension is enabled
	if GlobalConfigProvider != nil && !GlobalConfigProvider.Enabled {
		return nil, fmt.Errorf("whisper extension is disabled in configuration (set whisper.enabled: true in config.yaml)")
	}

	// Check max users limit
	if GlobalConfigProvider != nil && GlobalConfigProvider.MaxUsers > 0 {
		activeUserMutex.Lock()
		if activeUserCount >= GlobalConfigProvider.MaxUsers {
			activeUserMutex.Unlock()
			return nil, fmt.Errorf("maximum whisper users reached (%d/%d)", activeUserCount, GlobalConfigProvider.MaxUsers)
		}
		activeUserCount++
		currentCount := activeUserCount
		activeUserMutex.Unlock()
		log.Printf("[Whisper Extension] User connected (%d/%d)", currentCount, GlobalConfigProvider.MaxUsers)
	}

	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("whisper requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("whisper requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Get config from global config or use defaults
	var config WhisperConfig
	if GlobalConfigProvider != nil {
		config = WhisperConfig{
			Enabled:        GlobalConfigProvider.Enabled,
			ServerURL:      GlobalConfigProvider.ServerURL,
			Model:          GlobalConfigProvider.Model,
			Language:       GlobalConfigProvider.Language,
			Translate:      GlobalConfigProvider.Translate,
			SendIntervalMs: GlobalConfigProvider.SendIntervalMs,
			InitialPrompt:  GlobalConfigProvider.InitialPrompt,
			InstanceUUID:   GlobalConfigProvider.InstanceUUID,
		}
		log.Printf("[Whisper Extension] Using configuration from config.yaml")
	} else {
		// Default configuration if global config not available
		config = WhisperConfig{
			Enabled:        true, // Assume enabled if no config
			ServerURL:      "ws://whisperlive:9090",
			Model:          "small",
			Language:       "en",
			Translate:      true, // Default to translation enabled
			SendIntervalMs: 100,
			InitialPrompt:  "",
			InstanceUUID:   "",
		}
		log.Printf("[Whisper Extension] Using default configuration (config not available)")
	}

	// Override language from frontend parameter if provided
	if language, ok := extensionParams["language"].(string); ok && language != "" {
		config.Language = language
		log.Printf("[Whisper Extension] Language overridden from frontend: %s", language)
	}

	// Create decoder
	decoder := NewWhisperDecoder(audioParams.SampleRate, config)

	log.Printf("[Whisper Extension] Created with server: %s, model: %s, language: %s, translate: %v, sample rate: %d Hz",
		config.ServerURL, config.Model, config.Language, config.Translate, audioParams.SampleRate)

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
	// Decrement active user count
	if GlobalConfigProvider != nil && GlobalConfigProvider.MaxUsers > 0 {
		activeUserMutex.Lock()
		if activeUserCount > 0 {
			activeUserCount--
		}
		currentCount := activeUserCount
		activeUserMutex.Unlock()
		log.Printf("[Whisper Extension] User disconnected (%d/%d)", currentCount, GlobalConfigProvider.MaxUsers)
	}

	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *WhisperExtension) GetName() string {
	return "whisper"
}
