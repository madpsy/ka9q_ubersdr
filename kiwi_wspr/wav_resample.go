//go:build cgo
// +build cgo

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// ResampleWAVFile resamples a WAV file from one sample rate to another
// Returns the path to the resampled file
func ResampleWAVFile(inputPath string, targetSampleRate int) (string, error) {
	// Open input WAV file
	inputFile, err := os.Open(inputPath)
	if err != nil {
		return "", fmt.Errorf("failed to open input file: %w", err)
	}
	defer inputFile.Close()

	// Read WAV header
	header := make([]byte, 44)
	if _, err := io.ReadFull(inputFile, header); err != nil {
		return "", fmt.Errorf("failed to read WAV header: %w", err)
	}

	// Verify it's a WAV file
	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		return "", fmt.Errorf("not a valid WAV file")
	}

	// Extract WAV parameters
	inputSampleRate := int(binary.LittleEndian.Uint32(header[24:28]))
	channels := int(binary.LittleEndian.Uint16(header[22:24]))
	bitsPerSample := int(binary.LittleEndian.Uint16(header[34:36]))

	fmt.Printf("Input WAV: %d Hz, %d channels, %d bits\n", inputSampleRate, channels, bitsPerSample)

	// Check if resampling is needed
	if inputSampleRate == targetSampleRate {
		fmt.Printf("No resampling needed - already at %d Hz\n", targetSampleRate)
		return inputPath, nil // No resampling needed
	}

	if bitsPerSample != 16 {
		return "", fmt.Errorf("only 16-bit WAV files are supported, got %d-bit", bitsPerSample)
	}

	fmt.Printf("Resampling from %d Hz to %d Hz...\n", inputSampleRate, targetSampleRate)

	// Read all audio data
	audioData, err := io.ReadAll(inputFile)
	if err != nil {
		return "", fmt.Errorf("failed to read audio data: %w", err)
	}

	// Convert bytes to int16 samples
	numSamples := len(audioData) / 2
	samples := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		samples[i] = int16(binary.LittleEndian.Uint16(audioData[i*2 : i*2+2]))
	}

	// Create resampler
	resampler, err := NewResampler(inputSampleRate, targetSampleRate, channels, 0) // 0 = best quality
	if err != nil {
		return "", fmt.Errorf("failed to create resampler: %w", err)
	}
	defer resampler.Close()

	// Resample
	resampledSamples := resampler.Process(samples)

	// Create output filename
	outputPath := inputPath[:len(inputPath)-4] + "_12k.wav"

	// Create output file
	outputFile, err := os.Create(outputPath)
	if err != nil {
		return "", fmt.Errorf("failed to create output file: %w", err)
	}
	defer outputFile.Close()

	// Write WAV header with new sample rate
	outputHeader := make([]byte, 44)
	copy(outputHeader, header)

	// Update sample rate
	binary.LittleEndian.PutUint32(outputHeader[24:28], uint32(targetSampleRate))

	// Update byte rate (sample_rate * channels * bytes_per_sample)
	byteRate := targetSampleRate * channels * (bitsPerSample / 8)
	binary.LittleEndian.PutUint32(outputHeader[28:32], uint32(byteRate))

	// Update data chunk size
	dataSize := len(resampledSamples) * 2
	binary.LittleEndian.PutUint32(outputHeader[40:44], uint32(dataSize))

	// Update file size (total size - 8 bytes for RIFF header)
	fileSize := 36 + dataSize
	binary.LittleEndian.PutUint32(outputHeader[4:8], uint32(fileSize))

	// Write header
	if _, err := outputFile.Write(outputHeader); err != nil {
		return "", fmt.Errorf("failed to write WAV header: %w", err)
	}

	// Write resampled audio data
	audioBytes := make([]byte, len(resampledSamples)*2)
	for i, sample := range resampledSamples {
		binary.LittleEndian.PutUint16(audioBytes[i*2:i*2+2], uint16(sample))
	}

	if _, err := outputFile.Write(audioBytes); err != nil {
		return "", fmt.Errorf("failed to write audio data: %w", err)
	}

	return outputPath, nil
}
