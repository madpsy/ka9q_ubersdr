package morse

import (
	"fmt"
)

// AudioExtensionParams contains audio stream parameters (from session, not user-configurable)
type AudioExtensionParams struct {
	SampleRate    int // Hz (e.g., 48000)
	Channels      int // Always 1 (mono)
	BitsPerSample int // Always 16
}

// AudioExtension interface for extensible audio processors
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new Morse extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("morse requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("morse requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	return NewMorseExtension(audioParams.SampleRate, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "morse",
		"description": "Morse code decoder with adaptive WPM detection",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"center_frequency": map[string]interface{}{
				"type":        "number",
				"description": "Center frequency in Hz (CW tone frequency)",
				"default":     600.0,
				"min":         100.0,
				"max":         10000.0,
			},
			"bandwidth": map[string]interface{}{
				"type":        "number",
				"description": "Bandwidth in Hz (filter width)",
				"default":     100.0,
				"min":         10.0,
				"max":         1000.0,
			},
			"min_wpm": map[string]interface{}{
				"type":        "number",
				"description": "Minimum words per minute",
				"default":     12.0,
				"min":         5.0,
				"max":         100.0,
			},
			"max_wpm": map[string]interface{}{
				"type":        "number",
				"description": "Maximum words per minute",
				"default":     45.0,
				"min":         5.0,
				"max":         100.0,
			},
			"threshold_snr": map[string]interface{}{
				"type":        "number",
				"description": "SNR threshold in dB for signal detection",
				"default":     10.0,
				"min":         1.0,
				"max":         100.0,
			},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol with decoded text, Morse elements, and WPM",
			"protocol": map[string]interface{}{
				"text_message": map[string]interface{}{
					"type":        0x01,
					"description": "Decoded text message",
					"format":      "[type:1][timestamp:8][text_length:4][text:length]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type (0x01 for text)",
						},
						{
							"name":        "timestamp",
							"bytes":       8,
							"description": "Unix timestamp (big-endian uint64)",
						},
						{
							"name":        "text_length",
							"bytes":       4,
							"description": "Text length in bytes (big-endian uint32)",
						},
						{
							"name":        "text",
							"bytes":       -1,
							"description": "UTF-8 encoded decoded text",
						},
					},
				},
				"morse_message": map[string]interface{}{
					"type":        0x02,
					"description": "Morse code elements (dots and dashes)",
					"format":      "[type:1][timestamp:8][morse_length:4][morse:length]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type (0x02 for morse)",
						},
						{
							"name":        "timestamp",
							"bytes":       8,
							"description": "Unix timestamp (big-endian uint64)",
						},
						{
							"name":        "morse_length",
							"bytes":       4,
							"description": "Morse length in bytes (big-endian uint32)",
						},
						{
							"name":        "morse",
							"bytes":       -1,
							"description": "Morse elements (. - / and spaces)",
						},
					},
				},
				"wpm_update": map[string]interface{}{
					"type":        0x03,
					"description": "Words per minute update",
					"format":      "[type:1][wpm:8]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type (0x03 for WPM)",
						},
						{
							"name":        "wpm",
							"bytes":       8,
							"description": "WPM value (float64, big-endian)",
						},
					},
				},
			},
		},
	}
}
