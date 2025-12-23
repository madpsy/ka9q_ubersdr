package main

import (
	"encoding/binary"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

// Binary PCM Packet Format Documentation
// =======================================
//
// This file implements a hybrid binary PCM format with optional zstd compression.
// The format sends full metadata headers only when needed (first packet or metadata changes),
// and minimal headers for subsequent packets to minimize overhead.
//
// PACKET TYPES:
// -------------
// 1. FULL HEADER PACKET (29 bytes header + PCM data)
//    - Sent on first packet or when sample rate/channels change
//    - Contains all metadata for self-describing packets
//
// 2. MINIMAL HEADER PACKET (13 bytes header + PCM data)
//    - Sent for subsequent packets when metadata hasn't changed
//    - Contains only timestamp and essential info
//
// FULL HEADER FORMAT (29 bytes):
// ------------------------------
// Offset | Size | Type    | Description
// -------|------|---------|--------------------------------------------------
// 0      | 2    | uint16  | Magic bytes: 0x5043 ("PC" for PCM)
// 2      | 1    | uint8   | Version: 1 (for future compatibility)
// 3      | 1    | uint8   | Format type: 0=PCM, 1=Opus, 2=PCM-zstd
// 4      | 8    | uint64  | RTP timestamp (sample count for drift-free sync)
// 12     | 8    | uint64  | Wall clock time in milliseconds (NTP-synced)
// 20     | 4    | uint32  | Sample rate in Hz (e.g., 12000, 48000)
// 24     | 1    | uint8   | Number of channels (1=mono, 2=stereo)
// 25     | 4    | uint32  | Reserved for future use (compression level, etc.)
// 29     | N    | []byte  | PCM audio data (big-endian int16 samples)
//
// MINIMAL HEADER FORMAT (13 bytes):
// ---------------------------------
// Offset | Size | Type    | Description
// -------|------|---------|--------------------------------------------------
// 0      | 2    | uint16  | Magic bytes: 0x504D ("PM" for PCM Minimal)
// 2      | 1    | uint8   | Version: 1
// 3      | 8    | uint64  | RTP timestamp
// 11     | 2    | uint16  | Reserved (for future use)
// 13     | N    | []byte  | PCM audio data (big-endian int16 samples)
//
// COMPRESSION:
// -----------
// When format type is 2 (PCM-zstd), the entire packet (header + data) is
// compressed with zstd before transmission. The client must decompress first,
// then parse the header to determine packet type and extract metadata.
//
// HYBRID STRATEGY:
// ---------------
// - First packet: Always send FULL header
// - Subsequent packets: Send MINIMAL header if metadata unchanged
// - Metadata change: Send FULL header again
// - This reduces average overhead from 29 bytes to ~13.5 bytes per packet

const (
	// Magic bytes for packet identification
	PCMBinaryMagicFull    uint16 = 0x5043 // "PC" - Full header packet
	PCMBinaryMagicMinimal uint16 = 0x504D // "PM" - Minimal header packet

	// Version for future compatibility
	PCMBinaryVersion uint8 = 1

	// Format types
	PCMFormatUncompressed uint8 = 0 // Raw PCM (no compression)
	PCMFormatOpus         uint8 = 1 // Opus codec (for reference)
	PCMFormatZstd         uint8 = 2 // PCM with zstd compression

	// Header sizes
	PCMFullHeaderSize    = 29 // Full metadata header
	PCMMinimalHeaderSize = 13 // Minimal header (timestamp only)
)

// PCMBinaryEncoder handles encoding PCM audio to binary format with optional compression
type PCMBinaryEncoder struct {
	// Compression
	useCompression bool
	zstdEncoder    *zstd.Encoder
	encoderMu      sync.Mutex

	// Metadata tracking for hybrid approach
	lastSampleRate int
	lastChannels   int
	packetCount    uint64
}

// zstdEncoderPool provides reusable zstd encoders for efficiency
var zstdEncoderPool = sync.Pool{
	New: func() interface{} {
		// Use compression level 3 (default) for good balance of speed/compression
		// Level 3 provides ~2.5-3.5x compression with ~1ms latency
		encoder, _ := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault))
		return encoder
	},
}

// NewPCMBinaryEncoder creates a new PCM binary encoder
func NewPCMBinaryEncoder(useCompression bool) *PCMBinaryEncoder {
	encoder := &PCMBinaryEncoder{
		useCompression: useCompression,
		lastSampleRate: -1, // Force full header on first packet
		lastChannels:   -1,
		packetCount:    0,
	}

	if useCompression {
		// Get encoder from pool
		encoder.zstdEncoder = zstdEncoderPool.Get().(*zstd.Encoder)
	}

	return encoder
}

// EncodePCMPacket encodes a PCM audio packet with hybrid header strategy
//
// Parameters:
//   - pcmData: Raw PCM audio data (big-endian int16 samples from radiod)
//   - rtpTimestamp: RTP timestamp for drift-free audio alignment
//   - sampleRate: Audio sample rate in Hz
//   - channels: Number of audio channels (1=mono, 2=stereo)
//
// Returns:
//   - Encoded packet ready for WebSocket transmission
//   - Error if encoding fails
func (e *PCMBinaryEncoder) EncodePCMPacket(pcmData []byte, rtpTimestamp uint32, sampleRate int, channels int) ([]byte, error) {
	e.encoderMu.Lock()
	defer e.encoderMu.Unlock()

	e.packetCount++

	// Determine if we need to send full header
	// Full header required when:
	// 1. First packet (lastSampleRate == -1)
	// 2. Sample rate changed
	// 3. Channel count changed
	needFullHeader := e.lastSampleRate != sampleRate || e.lastChannels != channels

	var packet []byte

	if needFullHeader {
		// FULL HEADER PACKET (29 bytes + data)
		packet = e.buildFullHeaderPacket(pcmData, rtpTimestamp, sampleRate, channels)

		// Update tracking
		e.lastSampleRate = sampleRate
		e.lastChannels = channels
	} else {
		// MINIMAL HEADER PACKET (13 bytes + data)
		packet = e.buildMinimalHeaderPacket(pcmData, rtpTimestamp)
	}

	// Apply compression if enabled
	if e.useCompression && e.zstdEncoder != nil {
		// Compress the entire packet (header + data)
		// zstd compression provides ~2.5-3.5x reduction for voice/SDR signals
		compressed := e.zstdEncoder.EncodeAll(packet, make([]byte, 0, len(packet)))
		return compressed, nil
	}

	return packet, nil
}

// buildFullHeaderPacket creates a packet with full metadata header (29 bytes)
func (e *PCMBinaryEncoder) buildFullHeaderPacket(pcmData []byte, rtpTimestamp uint32, sampleRate int, channels int) []byte {
	// Allocate buffer: 29 byte header + PCM data
	packet := make([]byte, PCMFullHeaderSize+len(pcmData))
	offset := 0

	// Magic bytes (2 bytes): 0x5043 = "PC" for PCM
	binary.LittleEndian.PutUint16(packet[offset:], PCMBinaryMagicFull)
	offset += 2

	// Version (1 byte): Protocol version for future compatibility
	packet[offset] = PCMBinaryVersion
	offset += 1

	// Format type (1 byte): 0=PCM, 1=Opus, 2=PCM-zstd
	if e.useCompression {
		packet[offset] = PCMFormatZstd
	} else {
		packet[offset] = PCMFormatUncompressed
	}
	offset += 1

	// RTP timestamp (8 bytes): Sample count for drift-free synchronization
	// This is critical for maintaining audio timing across network jitter
	binary.LittleEndian.PutUint64(packet[offset:], uint64(rtpTimestamp))
	offset += 8

	// Wall clock time (8 bytes): NTP-synced time in milliseconds
	// Used for multi-server alignment and latency measurement
	binary.LittleEndian.PutUint64(packet[offset:], uint64(time.Now().UnixMilli()))
	offset += 8

	// Sample rate (4 bytes): Audio sample rate in Hz
	binary.LittleEndian.PutUint32(packet[offset:], uint32(sampleRate))
	offset += 4

	// Channels (1 byte): Number of audio channels
	packet[offset] = byte(channels)
	offset += 1

	// Reserved (4 bytes): For future use (compression level, bit depth, etc.)
	binary.LittleEndian.PutUint32(packet[offset:], 0)
	offset += 4

	// PCM data: Copy raw audio samples (big-endian int16 from radiod)
	copy(packet[offset:], pcmData)

	return packet
}

// buildMinimalHeaderPacket creates a packet with minimal header (13 bytes)
func (e *PCMBinaryEncoder) buildMinimalHeaderPacket(pcmData []byte, rtpTimestamp uint32) []byte {
	// Allocate buffer: 13 byte header + PCM data
	packet := make([]byte, PCMMinimalHeaderSize+len(pcmData))
	offset := 0

	// Magic bytes (2 bytes): 0x504D = "PM" for PCM Minimal
	binary.LittleEndian.PutUint16(packet[offset:], PCMBinaryMagicMinimal)
	offset += 2

	// Version (1 byte)
	packet[offset] = PCMBinaryVersion
	offset += 1

	// RTP timestamp (8 bytes): Only essential timing info in minimal header
	binary.LittleEndian.PutUint64(packet[offset:], uint64(rtpTimestamp))
	offset += 8

	// Reserved (2 bytes): For future use
	binary.LittleEndian.PutUint16(packet[offset:], 0)
	offset += 2

	// PCM data: Copy raw audio samples
	copy(packet[offset:], pcmData)

	return packet
}

// Close releases resources used by the encoder
func (e *PCMBinaryEncoder) Close() {
	if e.zstdEncoder != nil {
		// Return encoder to pool for reuse
		zstdEncoderPool.Put(e.zstdEncoder)
		e.zstdEncoder = nil
	}
}

// GetStats returns statistics about the encoder's operation
func (e *PCMBinaryEncoder) GetStats() map[string]interface{} {
	e.encoderMu.Lock()
	defer e.encoderMu.Unlock()

	return map[string]interface{}{
		"packetCount":    e.packetCount,
		"useCompression": e.useCompression,
		"lastSampleRate": e.lastSampleRate,
		"lastChannels":   e.lastChannels,
	}
}
