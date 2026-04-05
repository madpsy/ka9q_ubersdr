package main

import (
	"encoding/binary"
	"fmt"
	"math"

	"github.com/klauspost/compress/zstd"
)

// PCMBinaryDecoder handles decoding of binary PCM packets with zstd compression
type PCMBinaryDecoder struct {
	zstdDecoder    *zstd.Decoder
	lastSampleRate int
	lastChannels   int
}

// NewPCMBinaryDecoder creates a new PCM binary decoder
func NewPCMBinaryDecoder() (*PCMBinaryDecoder, error) {
	zstdDec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create zstd decoder: %w", err)
	}
	return &PCMBinaryDecoder{zstdDecoder: zstdDec}, nil
}

// DecodePCMBinary decodes a binary PCM packet (zstd-compressed) to little-endian int16 PCM bytes.
//
// Binary packet format (after decompression):
//
//	Full header v1 (29 bytes) — magic 0x5043 "PC", version 1:
//	  [0:2]   magic
//	  [2]     version (1)
//	  [3]     format type
//	  [4:12]  RTP timestamp (uint64 LE)
//	  [12:20] wall clock (uint64 LE)
//	  [20:24] sample rate (uint32 LE)
//	  [24]    channels (uint8)
//	  [25:29] reserved
//	  [29:]   PCM data (big-endian int16)
//
//	Full header v2 (37 bytes) — magic 0x5043 "PC", version 2:
//	  [0:2]   magic
//	  [2]     version (2)
//	  [3]     format type
//	  [4:12]  RTP timestamp (uint64 LE)
//	  [12:20] wall clock (uint64 LE)
//	  [20:24] sample rate (uint32 LE)
//	  [24]    channels (uint8)
//	  [25:29] baseband power (float32 LE, dBFS; -999 = no data)
//	  [29:33] noise density (float32 LE, dBFS; -999 = no data)
//	  [33:37] reserved
//	  [37:]   PCM data (big-endian int16)
//
//	Minimal header (13 bytes) — magic 0x504D "PM":
//	  [0:2]   magic
//	  [2]     version
//	  [3:11]  RTP timestamp (uint64 LE)
//	  [11:13] reserved
//	  [13:]   PCM data (big-endian int16)
//
// Returns pcmLE, sampleRate, channels, basebandPower, noiseDensity, error.
// basebandPower and noiseDensity are -999 when not available.
func (d *PCMBinaryDecoder) DecodePCMBinary(binaryData []byte) (pcmLE []byte, sampleRate, channels int, basebandPower, noiseDensity float32, err error) {
	const noData = float32(-999)

	// Decompress
	decompressed, err := d.zstdDecoder.DecodeAll(binaryData, nil)
	if err != nil {
		return nil, 0, 0, noData, noData, fmt.Errorf("zstd decompression error: %w", err)
	}
	binaryData = decompressed

	if len(binaryData) < 4 {
		return nil, 0, 0, noData, noData, fmt.Errorf("PCM packet too short: %d bytes", len(binaryData))
	}

	magic := binary.LittleEndian.Uint16(binaryData[0:2])
	version := binaryData[2]

	var pcmData []byte
	basebandPower = noData
	noiseDensity = noData

	switch magic {
	case 0x5043: // "PC" — full header
		if version >= 2 {
			// v2: 37-byte header with signal quality fields
			if len(binaryData) < 37 {
				return nil, 0, 0, noData, noData, fmt.Errorf("v2 full-header PCM packet too short: %d bytes", len(binaryData))
			}
			sampleRate = int(binary.LittleEndian.Uint32(binaryData[20:24]))
			channels = int(binaryData[24])
			basebandPower = math.Float32frombits(binary.LittleEndian.Uint32(binaryData[25:29]))
			noiseDensity = math.Float32frombits(binary.LittleEndian.Uint32(binaryData[29:33]))
			pcmData = binaryData[37:]
		} else {
			// v1: 29-byte header, no signal quality
			if len(binaryData) < 29 {
				return nil, 0, 0, noData, noData, fmt.Errorf("v1 full-header PCM packet too short: %d bytes", len(binaryData))
			}
			sampleRate = int(binary.LittleEndian.Uint32(binaryData[20:24]))
			channels = int(binaryData[24])
			pcmData = binaryData[29:]
		}
		d.lastSampleRate = sampleRate
		d.lastChannels = channels

	case 0x504D: // "PM" — minimal header
		if len(binaryData) < 13 {
			return nil, 0, 0, noData, noData, fmt.Errorf("minimal-header PCM packet too short: %d bytes", len(binaryData))
		}
		pcmData = binaryData[13:]
		sampleRate = d.lastSampleRate
		channels = d.lastChannels
		if sampleRate == 0 || channels == 0 {
			return nil, 0, 0, noData, noData, fmt.Errorf("received minimal header before full header")
		}

	default:
		return nil, 0, 0, noData, noData, fmt.Errorf("invalid PCM magic: 0x%04X", magic)
	}

	// Convert big-endian int16 → little-endian int16
	numSamples := len(pcmData) / 2
	pcmLE = make([]byte, len(pcmData))
	for i := 0; i < numSamples; i++ {
		sample := int16(binary.BigEndian.Uint16(pcmData[i*2:]))
		binary.LittleEndian.PutUint16(pcmLE[i*2:], uint16(sample))
	}

	return pcmLE, sampleRate, channels, basebandPower, noiseDensity, nil
}

// Close releases decoder resources.
func (d *PCMBinaryDecoder) Close() {
	if d.zstdDecoder != nil {
		d.zstdDecoder.Close()
	}
}
