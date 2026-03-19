package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"

	"github.com/klauspost/compress/zstd"
)

// PCMBinaryDecoder handles decoding of binary PCM packets with zstd compression.
//
// Only Version 2 of the full header format is supported (Version 1 is obsolete).
type PCMBinaryDecoder struct {
	zstdDecoder    *zstd.Decoder
	lastSampleRate int
	lastChannels   int
	zstdAvailable  bool
}

// NewPCMBinaryDecoder creates a new PCM binary decoder
func NewPCMBinaryDecoder() (*PCMBinaryDecoder, error) {
	decoder := &PCMBinaryDecoder{
		zstdAvailable: true,
	}

	zstdDec, err := zstd.NewReader(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to create zstd decoder: %v\n", err)
		decoder.zstdAvailable = false
		return decoder, nil
	}
	decoder.zstdDecoder = zstdDec

	return decoder, nil
}

// DecodePCMBinary decodes a zstd-compressed binary PCM packet to PCM bytes.
//
// Binary packet format (Version 2 full header, 37 bytes):
//
//	Bytes  0-1:  Magic 0x5043 ("PC", little-endian uint16)
//	Byte   2:    Version = 2
//	Byte   3:    Format type (0=PCM, 2=PCM-zstd)
//	Bytes  4-11: RTP timestamp (uint64, little-endian)
//	Bytes 12-19: Wall clock time (uint64, little-endian)
//	Bytes 20-23: Sample rate (uint32, little-endian)
//	Byte  24:    Channels (uint8)
//	Bytes 25-28: Baseband power (float32, little-endian)
//	Bytes 29-32: Noise density (float32, little-endian)
//	Bytes 33-36: Reserved (uint32)
//	Bytes 37+:   PCM data (big-endian int16 samples)
//
// Minimal header (13 bytes, sent for subsequent packets after a full header):
//
//	Bytes  0-1:  Magic 0x504D ("PM", little-endian uint16)
//	Byte   2:    Version
//	Bytes  3-10: RTP timestamp (uint64, little-endian)
//	Bytes 11-12: Reserved (uint16)
//	Bytes 13+:   PCM data (big-endian int16 samples)
//
// Returns: PCM data as bytes (int16, little-endian), sample rate, channels, error
func (d *PCMBinaryDecoder) DecodePCMBinary(binaryData []byte, isZstd bool) ([]byte, int, int, error) {
	// Decompress entire packet first
	if isZstd {
		if !d.zstdAvailable || d.zstdDecoder == nil {
			return nil, 0, 0, fmt.Errorf("received zstd-compressed PCM but zstd not available")
		}
		decompressed, err := d.zstdDecoder.DecodeAll(binaryData, nil)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("zstd decompression error: %w", err)
		}
		binaryData = decompressed
	}

	if len(binaryData) < 4 {
		return nil, 0, 0, fmt.Errorf("binary PCM packet too short: %d bytes", len(binaryData))
	}

	magic := binary.LittleEndian.Uint16(binaryData[0:2])

	var sampleRate, channels int
	var pcmData []byte

	switch magic {
	case 0x5043: // "PC" — Version 2 full header (37 bytes)
		const headerSize = 37
		if len(binaryData) < headerSize {
			return nil, 0, 0, fmt.Errorf("full header PCM packet too short: %d bytes (need %d)", len(binaryData), headerSize)
		}

		version := binaryData[2]
		if version != 2 {
			return nil, 0, 0, fmt.Errorf("unsupported PCM header version %d (only version 2 supported)", version)
		}

		// Bytes 20-23: sample rate
		sampleRate = int(binary.LittleEndian.Uint32(binaryData[20:24]))
		// Byte 24: channels
		channels = int(binaryData[24])
		// Bytes 25-28: baseband power (float32) — available for future use
		_ = math.Float32frombits(binary.LittleEndian.Uint32(binaryData[25:29]))
		// Bytes 29-32: noise density (float32) — available for future use
		_ = math.Float32frombits(binary.LittleEndian.Uint32(binaryData[29:33]))
		// Bytes 33-36: reserved
		pcmData = binaryData[headerSize:]

		d.lastSampleRate = sampleRate
		d.lastChannels = channels

	case 0x504D: // "PM" — Minimal header (13 bytes)
		const headerSize = 13
		if len(binaryData) < headerSize {
			return nil, 0, 0, fmt.Errorf("minimal header PCM packet too short: %d bytes (need %d)", len(binaryData), headerSize)
		}

		pcmData = binaryData[headerSize:]
		sampleRate = d.lastSampleRate
		channels = d.lastChannels

		if sampleRate == 0 || channels == 0 {
			return nil, 0, 0, fmt.Errorf("received minimal header before full header")
		}

	default:
		return nil, 0, 0, fmt.Errorf("invalid PCM magic bytes: 0x%04X", magic)
	}

	// Convert PCM data from big-endian to little-endian int16
	numSamples := len(pcmData) / 2
	pcmLE := make([]byte, len(pcmData))
	for i := 0; i < numSamples; i++ {
		sample := int16(binary.BigEndian.Uint16(pcmData[i*2:]))
		binary.LittleEndian.PutUint16(pcmLE[i*2:], uint16(sample))
	}

	return pcmLE, sampleRate, channels, nil
}

// Close closes the decoder and releases resources
func (d *PCMBinaryDecoder) Close() {
	if d.zstdDecoder != nil {
		d.zstdDecoder.Close()
	}
}
