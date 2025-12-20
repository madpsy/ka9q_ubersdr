//go:build opus
// +build opus

package main

import (
	"encoding/base64"
	"encoding/binary"
	"log"

	opus "gopkg.in/hraban/opus.v2"
)

// OpusEncoderWrapper wraps the Opus encoder
type OpusEncoderWrapper struct {
	encoder *opus.Encoder
	enabled bool
}

// NewOpusEncoder creates a new Opus encoder if enabled in config
func NewOpusEncoder(config *Config, sampleRate int) *OpusEncoderWrapper {
	wrapper := &OpusEncoderWrapper{enabled: false}

	if !config.Audio.Opus.Enabled {
		return wrapper
	}

	encoder, err := opus.NewEncoder(sampleRate, 1, opus.Application(2049)) // OPUS_APPLICATION_VOIP
	if err != nil {
		log.Printf("WARNING: Opus encoding requested but failed to initialize: %v", err)
		log.Printf("To enable Opus support: sudo apt install libopus-dev libopusfile-dev pkg-config")
		log.Printf("Then rebuild with: go build -tags opus")
		log.Printf("Falling back to PCM.")
		return wrapper
	}

	// Configure encoder with settings from config
	if err := encoder.SetBitrate(config.Audio.Opus.Bitrate); err != nil {
		log.Printf("Warning: Failed to set Opus bitrate: %v", err)
	}
	if err := encoder.SetComplexity(config.Audio.Opus.Complexity); err != nil {
		log.Printf("Warning: Failed to set Opus complexity: %v", err)
	}

	wrapper.encoder = encoder
	wrapper.enabled = true
	log.Printf("Opus encoder initialized: %d Hz, %d bps, complexity %d",
		sampleRate, config.Audio.Opus.Bitrate, config.Audio.Opus.Complexity)

	return wrapper
}

// Encode encodes PCM data to Opus
func (w *OpusEncoderWrapper) Encode(pcmData []byte) (encoded string, format string, err error) {
	if !w.enabled || w.encoder == nil {
		// Return PCM
		return base64.StdEncoding.EncodeToString(pcmData), "pcm", nil
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
		return base64.StdEncoding.EncodeToString(pcmData), "pcm", err
	}

	// Successfully encoded with Opus
	return base64.StdEncoding.EncodeToString(opusData[:n]), "opus", nil
}

// IsEnabled returns whether Opus encoding is enabled
func (w *OpusEncoderWrapper) IsEnabled() bool {
	return w.enabled
}
