package sstv

import (
	"fmt"
	"log"
)

/*
 * SSTV Extension Wrapper
 * Integrates SSTV decoder with UberSDR audio extension framework
 *
 * Copyright (c) 2026, UberSDR project
 */

// AudioExtensionParams contains audio stream parameters
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioExtension interface for extensible audio processors
type AudioExtension interface {
	Start(audioChan <-chan []int16, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// SSTVExtension wraps the SSTV decoder as an AudioExtension
type SSTVExtension struct {
	decoder *SSTVDecoder
	config  SSTVConfig
}

// NewSSTVExtension creates a new SSTV audio extension
func NewSSTVExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*SSTVExtension, error) {
	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("SSTV requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("SSTV requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Start with default config
	config := DefaultSSTVConfig()

	// Override with user parameters
	if autoSync, ok := extensionParams["auto_sync"].(bool); ok {
		config.AutoSync = autoSync
	}
	if decodeFSKID, ok := extensionParams["decode_fsk_id"].(bool); ok {
		config.DecodeFSKID = decodeFSKID
	}
	if adaptive, ok := extensionParams["adaptive"].(bool); ok {
		config.Adaptive = adaptive
	}

	// Create decoder
	decoder := NewSSTVDecoder(float64(audioParams.SampleRate), config)

	log.Printf("[SSTV Extension] Created with sample rate: %d Hz, auto_sync: %v, decode_fsk_id: %v, adaptive: %v",
		audioParams.SampleRate, config.AutoSync, config.DecodeFSKID, config.Adaptive)

	return &SSTVExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *SSTVExtension) Start(audioChan <-chan []int16, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension
func (e *SSTVExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *SSTVExtension) GetName() string {
	return "sstv"
}
