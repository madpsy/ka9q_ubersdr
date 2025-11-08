package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// WAVWriter handles writing PCM audio data to WAV files
type WAVWriter struct {
	file          *os.File
	sampleRate    int
	channels      int
	bitsPerSample int
	dataSize      int64
	headerWritten bool
}

// WAVHeader represents a simplified WAV file header
type WAVHeader struct {
	// RIFF chunk
	ChunkID   [4]byte // "RIFF"
	ChunkSize uint32  // File size - 8
	Format    [4]byte // "WAVE"

	// fmt sub-chunk
	Subchunk1ID   [4]byte // "fmt "
	Subchunk1Size uint32  // 16 for PCM
	AudioFormat   uint16  // 1 for PCM
	NumChannels   uint16  // 1 or 2
	SampleRate    uint32  // Sample rate in Hz
	ByteRate      uint32  // SampleRate * NumChannels * BitsPerSample/8
	BlockAlign    uint16  // NumChannels * BitsPerSample/8
	BitsPerSample uint16  // 8, 16, etc.

	// data sub-chunk
	Subchunk2ID   [4]byte // "data"
	Subchunk2Size uint32  // NumSamples * NumChannels * BitsPerSample/8
}

// NewWAVWriter creates a new WAV file writer
func NewWAVWriter(filename string, sampleRate, channels, bitsPerSample int) (*WAVWriter, error) {
	file, err := os.Create(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to create WAV file: %w", err)
	}

	w := &WAVWriter{
		file:          file,
		sampleRate:    sampleRate,
		channels:      channels,
		bitsPerSample: bitsPerSample,
		dataSize:      0,
		headerWritten: false,
	}

	// Write placeholder header (will be updated on close)
	if err := w.writeHeader(); err != nil {
		file.Close()
		return nil, err
	}

	return w, nil
}

// writeHeader writes the WAV header to the file
func (w *WAVWriter) writeHeader() error {
	header := WAVHeader{
		ChunkID:       [4]byte{'R', 'I', 'F', 'F'},
		ChunkSize:     0xFFFFFFFF, // Placeholder, will be updated on close
		Format:        [4]byte{'W', 'A', 'V', 'E'},
		Subchunk1ID:   [4]byte{'f', 'm', 't', ' '},
		Subchunk1Size: 16,
		AudioFormat:   1, // PCM
		NumChannels:   uint16(w.channels),
		SampleRate:    uint32(w.sampleRate),
		ByteRate:      uint32(w.sampleRate * w.channels * w.bitsPerSample / 8),
		BlockAlign:    uint16(w.channels * w.bitsPerSample / 8),
		BitsPerSample: uint16(w.bitsPerSample),
		Subchunk2ID:   [4]byte{'d', 'a', 't', 'a'},
		Subchunk2Size: 0xFFFFFFFF, // Placeholder, will be updated on close
	}

	if err := binary.Write(w.file, binary.LittleEndian, &header); err != nil {
		return fmt.Errorf("failed to write WAV header: %w", err)
	}

	w.headerWritten = true
	return nil
}

// WriteSamples writes PCM samples to the WAV file
// samples should be int16 values in little-endian format
func (w *WAVWriter) WriteSamples(samples []int16) error {
	if !w.headerWritten {
		return fmt.Errorf("header not written")
	}

	for _, sample := range samples {
		if err := binary.Write(w.file, binary.LittleEndian, sample); err != nil {
			return fmt.Errorf("failed to write sample: %w", err)
		}
		w.dataSize += int64(w.bitsPerSample / 8)
	}

	return nil
}

// WriteBytes writes raw PCM bytes to the WAV file
// This converts from big-endian (radiod RTP format) to little-endian (WAV format)
func (w *WAVWriter) WriteBytes(data []byte) (int, error) {
	if !w.headerWritten {
		return 0, fmt.Errorf("header not written")
	}

	// Convert big-endian int16 samples to little-endian for WAV
	numSamples := len(data) / 2
	if len(data)%2 != 0 {
		return 0, fmt.Errorf("invalid PCM data length: %d (must be even)", len(data))
	}

	for i := 0; i < numSamples; i++ {
		// Read as big-endian (radiod RTP format)
		sample := int16(binary.BigEndian.Uint16(data[i*2 : i*2+2]))
		// Write as little-endian (WAV format)
		if err := binary.Write(w.file, binary.LittleEndian, sample); err != nil {
			return i * 2, fmt.Errorf("failed to write sample %d: %w", i, err)
		}
	}

	bytesWritten := numSamples * 2
	w.dataSize += int64(bytesWritten)
	return bytesWritten, nil
}

// Close finalizes the WAV file by updating the header with correct sizes
func (w *WAVWriter) Close() error {
	if w.file == nil {
		return nil
	}

	// Seek to beginning to update header
	if _, err := w.file.Seek(0, io.SeekStart); err != nil {
		w.file.Close()
		return fmt.Errorf("failed to seek to beginning: %w", err)
	}

	// Update header with actual sizes
	header := WAVHeader{
		ChunkID:       [4]byte{'R', 'I', 'F', 'F'},
		ChunkSize:     uint32(w.dataSize + 36), // 36 = header size - 8
		Format:        [4]byte{'W', 'A', 'V', 'E'},
		Subchunk1ID:   [4]byte{'f', 'm', 't', ' '},
		Subchunk1Size: 16,
		AudioFormat:   1,
		NumChannels:   uint16(w.channels),
		SampleRate:    uint32(w.sampleRate),
		ByteRate:      uint32(w.sampleRate * w.channels * w.bitsPerSample / 8),
		BlockAlign:    uint16(w.channels * w.bitsPerSample / 8),
		BitsPerSample: uint16(w.bitsPerSample),
		Subchunk2ID:   [4]byte{'d', 'a', 't', 'a'},
		Subchunk2Size: uint32(w.dataSize),
	}

	if err := binary.Write(w.file, binary.LittleEndian, &header); err != nil {
		w.file.Close()
		return fmt.Errorf("failed to update WAV header: %w", err)
	}

	return w.file.Close()
}

// GetDataSize returns the number of bytes written to the data section
func (w *WAVWriter) GetDataSize() int64 {
	return w.dataSize
}

// GetDuration returns the duration of the recorded audio
func (w *WAVWriter) GetDuration() float64 {
	bytesPerSample := w.bitsPerSample / 8
	samplesWritten := w.dataSize / int64(w.channels*bytesPerSample)
	return float64(samplesWritten) / float64(w.sampleRate)
}
