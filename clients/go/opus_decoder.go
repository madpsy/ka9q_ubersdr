package main

import (
	"encoding/binary"
	"fmt"
	"os"

	opus "gopkg.in/hraban/opus.v2"
)

// OpusDecoder wraps the Opus decoder for client-side decoding
type OpusDecoder struct {
	decoder    *opus.Decoder
	sampleRate int
	channels   int
}

// NewOpusDecoder creates a new Opus decoder
func NewOpusDecoder(sampleRate int, channels int) (*OpusDecoder, error) {
	decoder, err := opus.NewDecoder(sampleRate, channels)
	if err != nil {
		return nil, fmt.Errorf("failed to create Opus decoder: %w", err)
	}

	return &OpusDecoder{
		decoder:    decoder,
		sampleRate: sampleRate,
		channels:   channels,
	}, nil
}

// Decode decodes Opus data to PCM int16 samples
func (d *OpusDecoder) Decode(opusData []byte, frameSize int) ([]int16, error) {
	// Allocate buffer for decoded PCM samples
	pcmData := make([]int16, frameSize*d.channels)

	// Decode Opus to PCM
	n, err := d.decoder.Decode(opusData, pcmData)
	if err != nil {
		return nil, fmt.Errorf("opus decode error: %w", err)
	}

	// Return only the decoded samples (n samples per channel)
	return pcmData[:n*d.channels], nil
}

// DecodeOpusBinary decodes a binary Opus packet from the server
// Binary packet format:
// - 8 bytes: timestamp (uint64, little-endian)
// - 4 bytes: sample rate (uint32, little-endian)
// - 1 byte: channels (uint8)
// - remaining: Opus encoded data
func (c *RadioClient) DecodeOpusBinary(binaryData []byte) ([]byte, error) {
	if len(binaryData) < 13 {
		return nil, fmt.Errorf("binary packet too short: %d bytes", len(binaryData))
	}

	// Parse header
	timestamp := binary.LittleEndian.Uint64(binaryData[0:8])
	sampleRate := int(binary.LittleEndian.Uint32(binaryData[8:12]))
	channels := int(binaryData[12])
	opusData := binaryData[13:]

	_ = timestamp // Timestamp not currently used

	// Create decoder on first packet with correct sample rate and channels from server
	if c.opusDecoder == nil || c.opusSampleRate != sampleRate || c.opusChannels != channels {
		decoder, err := NewOpusDecoder(sampleRate, channels)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: Failed to initialize Opus decoder (%d Hz, %d ch): %v\n", sampleRate, channels, err)
			fmt.Fprintf(os.Stderr, "Disabling Opus decoding - please reconnect without Opus for this mode\n")
			// Disable Opus to prevent repeated errors
			c.useOpus = false
			c.opusDecoder = nil
			return nil, err
		}
		c.opusDecoder = decoder
		c.opusSampleRate = sampleRate
		c.opusChannels = channels
		fmt.Fprintf(os.Stderr, "Opus decoder initialized: %d Hz, %d channel(s)\n", sampleRate, channels)
	}

	// Calculate frame size based on sample rate (20ms frame = sample_rate * 0.02)
	// Opus typically uses 20ms frames
	frameSize := int(float64(sampleRate) * 0.02)

	// Decode Opus to PCM int16 samples
	pcmSamples, err := c.opusDecoder.Decode(opusData, frameSize)
	if err != nil {
		return nil, fmt.Errorf("opus decode error: %w", err)
	}

	// Convert int16 samples to little-endian bytes
	pcmBytes := make([]byte, len(pcmSamples)*2)
	for i, sample := range pcmSamples {
		binary.LittleEndian.PutUint16(pcmBytes[i*2:], uint16(sample))
	}

	return pcmBytes, nil
}
