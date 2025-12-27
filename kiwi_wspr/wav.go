package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// WAVWriter writes PCM audio data in WAV format
type WAVWriter struct {
	file        *os.File
	sampleRate  int
	numChannels int
	dataSize    uint32
}

// NewWAVWriter creates a new WAV file writer
func NewWAVWriter(file *os.File, sampleRate, numChannels int) *WAVWriter {
	return &WAVWriter{
		file:        file,
		sampleRate:  sampleRate,
		numChannels: numChannels,
		dataSize:    0,
	}
}

// WriteHeader writes the WAV file header
func (w *WAVWriter) WriteHeader() error {
	// Write a placeholder header (will be updated on close)
	return w.writeWAVHeader(0)
}

// writeWAVHeader writes the WAV header with the given data size
func (w *WAVWriter) writeWAVHeader(dataSize uint32) error {
	bitsPerSample := uint16(16)
	byteRate := uint32(w.sampleRate * int(w.numChannels) * int(bitsPerSample) / 8)
	blockAlign := uint16(w.numChannels * int(bitsPerSample) / 8)

	// RIFF header
	if err := binary.Write(w.file, binary.LittleEndian, []byte("RIFF")); err != nil {
		return err
	}
	fileSize := dataSize + 36
	if err := binary.Write(w.file, binary.LittleEndian, fileSize); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, []byte("WAVE")); err != nil {
		return err
	}

	// fmt chunk
	if err := binary.Write(w.file, binary.LittleEndian, []byte("fmt ")); err != nil {
		return err
	}
	fmtSize := uint32(16)
	if err := binary.Write(w.file, binary.LittleEndian, fmtSize); err != nil {
		return err
	}
	audioFormat := uint16(1) // PCM
	if err := binary.Write(w.file, binary.LittleEndian, audioFormat); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, uint16(w.numChannels)); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, uint32(w.sampleRate)); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, byteRate); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, blockAlign); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, bitsPerSample); err != nil {
		return err
	}

	// data chunk header
	if err := binary.Write(w.file, binary.LittleEndian, []byte("data")); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, dataSize); err != nil {
		return err
	}

	return nil
}

// WriteSamples writes audio samples to the WAV file
func (w *WAVWriter) WriteSamples(samples []int16) error {
	for _, sample := range samples {
		if err := binary.Write(w.file, binary.LittleEndian, sample); err != nil {
			return err
		}
		w.dataSize += 2
	}
	return nil
}

// Close finalizes the WAV file by updating the header with the correct size
func (w *WAVWriter) Close() error {
	if w.file == nil {
		return nil
	}

	// Seek to beginning and rewrite header with correct size
	if _, err := w.file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("failed to seek to start: %w", err)
	}

	if err := w.writeWAVHeader(w.dataSize); err != nil {
		return fmt.Errorf("failed to update WAV header: %w", err)
	}

	return nil
}
