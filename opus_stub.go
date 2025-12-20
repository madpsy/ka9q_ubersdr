//go:build !opus
// +build !opus

package main

import (
	"encoding/base64"
	"log"
)

// OpusEncoderWrapper wraps the Opus encoder (stub version without Opus support)
type OpusEncoderWrapper struct {
	enabled bool
}

// NewOpusEncoder creates a stub encoder when Opus is not available
func NewOpusEncoder(config *Config, sampleRate int) *OpusEncoderWrapper {
	if config.Audio.Opus.Enabled {
		log.Printf("WARNING: Opus encoding requested but not compiled in")
		log.Printf("To enable Opus support: sudo apt install libopus-dev libopusfile-dev pkg-config")
		log.Printf("Then rebuild with: go build -tags opus")
		log.Printf("Falling back to PCM audio")
	}
	return &OpusEncoderWrapper{enabled: false}
}

// Encode always returns PCM in stub version
func (w *OpusEncoderWrapper) Encode(pcmData []byte) (encoded string, format string, err error) {
	return base64.StdEncoding.EncodeToString(pcmData), "pcm", nil
}

// IsEnabled always returns false in stub version
func (w *OpusEncoderWrapper) IsEnabled() bool {
	return false
}
