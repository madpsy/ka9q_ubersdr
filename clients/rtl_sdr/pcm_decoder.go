package main

import (
	"encoding/binary"
	"fmt"
	"os"

	"github.com/klauspost/compress/zstd"
)

// PCMBinaryDecoder handles decoding of binary PCM packets with optional zstd compression
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

	// Initialize zstd decoder
	zstdDec, err := zstd.NewReader(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to create zstd decoder: %v\n", err)
		decoder.zstdAvailable = false
		return decoder, nil
	}
	decoder.zstdDecoder = zstdDec

	return decoder, nil
}

// DecodePCMBinary decodes a binary PCM packet (with optional zstd compression) to PCM bytes
//
// Binary packet format from server (hybrid header strategy):
//   - If zstd compressed: decompress entire packet first
//   - Full header (29 bytes):
//   - 2 bytes: Magic (0x5043 = "PC")
//   - 1 byte: Version (1)
//   - 1 byte: Format type (0=PCM, 2=PCM-zstd)
//   - 8 bytes: RTP timestamp (uint64, little-endian)
//   - 8 bytes: Wall clock time (uint64, little-endian)
//   - 4 bytes: Sample rate (uint32, little-endian)
//   - 1 byte: Channels (uint8)
//   - 4 bytes: Reserved
//   - remaining: PCM data (big-endian int16)
//   - Minimal header (13 bytes):
//   - 2 bytes: Magic (0x504D = "PM")
//   - 1 byte: Version (1)
//   - 8 bytes: RTP timestamp (uint64, little-endian)
//   - 2 bytes: Reserved
//   - remaining: PCM data (big-endian int16)
//
// Args:
//
//	binaryData: Raw binary packet from server (possibly zstd-compressed)
//	isZstd: True if entire packet is zstd-compressed
//
// Returns:
//
//	PCM data as bytes (int16, little-endian), sample rate, channels, error
func (d *PCMBinaryDecoder) DecodePCMBinary(binaryData []byte, isZstd bool) ([]byte, int, int, error) {
	// Decompress entire packet first if zstd
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

	// Check magic bytes (little-endian uint16)
	magic := binary.LittleEndian.Uint16(binaryData[0:2])

	var sampleRate, channels int
	var pcmData []byte

	if magic == 0x5043 { // "PC" - Full header
		if len(binaryData) < 29 {
			return nil, 0, 0, fmt.Errorf("full header PCM packet too short: %d bytes", len(binaryData))
		}

		// Parse full header (little-endian)
		// version := binaryData[2]
		// formatType := binaryData[3]
		// rtpTimestamp := binary.LittleEndian.Uint64(binaryData[4:12])
		// wallClock := binary.LittleEndian.Uint64(binaryData[12:20])
		sampleRate = int(binary.LittleEndian.Uint32(binaryData[20:24]))
		channels = int(binaryData[24])
		// reserved := binary.LittleEndian.Uint32(binaryData[25:29])
		pcmData = binaryData[29:]

		// Update tracked metadata
		d.lastSampleRate = sampleRate
		d.lastChannels = channels

	} else if magic == 0x504D { // "PM" - Minimal header
		if len(binaryData) < 13 {
			return nil, 0, 0, fmt.Errorf("minimal header PCM packet too short: %d bytes", len(binaryData))
		}

		// Parse minimal header (little-endian)
		// version := binaryData[2]
		// rtpTimestamp := binary.LittleEndian.Uint64(binaryData[3:11])
		// reserved := binary.LittleEndian.Uint16(binaryData[11:13])
		pcmData = binaryData[13:]

		// Use last known metadata
		sampleRate = d.lastSampleRate
		channels = d.lastChannels

		if sampleRate == 0 || channels == 0 {
			return nil, 0, 0, fmt.Errorf("received minimal header before full header")
		}

	} else {
		return nil, 0, 0, fmt.Errorf("invalid PCM magic bytes: 0x%04X", magic)
	}

	// Convert from big-endian to little-endian
	// PCM data is int16, so convert in chunks of 2 bytes
	numSamples := len(pcmData) / 2
	pcmLE := make([]byte, len(pcmData))

	for i := 0; i < numSamples; i++ {
		// Read big-endian int16
		sample := int16(binary.BigEndian.Uint16(pcmData[i*2:]))
		// Write as little-endian int16
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
