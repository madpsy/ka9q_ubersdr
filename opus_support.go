package main

import (
	"encoding/binary"
	"log"

	opus "gopkg.in/hraban/opus.v2"
)

// OpusEncoderWrapper wraps the Opus encoder
type OpusEncoderWrapper struct {
	encoder *opus.Encoder
	enabled bool
}

// NewOpusEncoder creates a new Opus encoder (always disabled - only used when client requests it)
func NewOpusEncoder(config *Config, sampleRate int) *OpusEncoderWrapper {
	// Opus is now client-requested only, not server-configured
	// Return disabled wrapper - will be enabled per-connection if client requests it
	return &OpusEncoderWrapper{enabled: false}
}

// NewOpusEncoderForClient creates a new Opus encoder for a specific client request
func NewOpusEncoderForClient(sampleRate int, bitrate int, complexity int) (*OpusEncoderWrapper, error) {
	wrapper := &OpusEncoderWrapper{enabled: false}

	// Opus encoder: use actual sample rate and mono (1 channel)
	// The client will create a matching decoder from the packet header
	encoder, err := opus.NewEncoder(sampleRate, 1, opus.AppVoIP)
	if err != nil {
		log.Printf("WARNING: Opus encoding requested but failed to initialize: %v", err)
		log.Printf("To enable Opus support: sudo apt install libopus-dev libopusfile-dev pkg-config")
		log.Printf("Then rebuild with: go build -tags opus")
		return nil, err
	}

	// Configure encoder with settings
	if err := encoder.SetBitrate(bitrate); err != nil {
		log.Printf("Warning: Failed to set Opus bitrate: %v", err)
	}
	if err := encoder.SetComplexity(complexity); err != nil {
		log.Printf("Warning: Failed to set Opus complexity: %v", err)
	}

	wrapper.encoder = encoder
	wrapper.enabled = true
	log.Printf("Opus encoder initialized for client: %d Hz, %d bps, complexity %d, 1 channel (mono)",
		sampleRate, bitrate, complexity)

	return wrapper, nil
}

// EncodeBinary encodes PCM data to Opus (returns raw binary bytes)
func (w *OpusEncoderWrapper) EncodeBinary(pcmData []byte) (encoded []byte, err error) {
	if !w.enabled || w.encoder == nil {
		// Return PCM as-is
		return pcmData, nil
	}

	// Convert PCM bytes to int16 samples for Opus
	numSamples := len(pcmData) / 2
	pcmInt16 := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		// Big-endian int16
		pcmInt16[i] = int16(binary.BigEndian.Uint16(pcmData[i*2 : i*2+2]))
	}

	// Encode with Opus
	opusData := make([]byte, 4000) // Max Opus frame size
	n, err := w.encoder.Encode(pcmInt16, opusData)
	if err != nil {
		log.Printf("Opus encoding error: %v, sending PCM", err)
		// Fall back to PCM on error
		return pcmData, err
	}

	// Successfully encoded with Opus - return raw bytes
	return opusData[:n], nil
}

// IsEnabled returns whether Opus encoding is enabled
func (w *OpusEncoderWrapper) IsEnabled() bool {
	return w.enabled
}
