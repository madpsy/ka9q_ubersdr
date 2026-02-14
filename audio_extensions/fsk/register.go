package fsk

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

// Factory creates a new FSK extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("FSK requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("FSK requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	return NewFSKExtension(audioParams.SampleRate, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "fsk",
		"description": "FSK/RTTY decoder for amateur radio and maritime communications",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"center_frequency": map[string]interface{}{
				"type":        "number",
				"description": "Center frequency in Hz",
				"default":     1000.0,
				"min":         1.0,
				"max":         10000.0,
			},
			"shift": map[string]interface{}{
				"type":        "number",
				"description": "FSK shift in Hz",
				"default":     170.0,
				"min":         1.0,
				"max":         1000.0,
			},
			"baud_rate": map[string]interface{}{
				"type":        "number",
				"description": "Baud rate",
				"default":     45.45,
				"min":         10.0,
				"max":         1000.0,
			},
			"inverted": map[string]interface{}{
				"type":        "boolean",
				"description": "Invert mark/space",
				"default":     false,
			},
			"framing": map[string]interface{}{
				"type":        "string",
				"description": "Framing (5N1.5 for RTTY, 4/7 for NAVTEX, 7/3 for DSC)",
				"default":     "5N1.5",
			},
			"encoding": map[string]interface{}{
				"type":        "string",
				"description": "Character encoding (ITA2, CCIR476, ASCII)",
				"default":     "ITA2",
			},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol with text messages and baud error",
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
							"description": "UTF-8 encoded text",
						},
					},
				},
				"baud_error": map[string]interface{}{
					"type":        0x02,
					"description": "Baud rate error indicator",
					"format":      "[type:1][error:8]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type (0x02 for baud error)",
						},
						{
							"name":        "error",
							"bytes":       8,
							"description": "Baud error value (float64, big-endian)",
						},
					},
				},
				"state_update": map[string]interface{}{
					"type":        0x03,
					"description": "Decoder state update",
					"format":      "[type:1][state:1]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type (0x03 for state)",
						},
						{
							"name":        "state",
							"bytes":       1,
							"description": "State: 0=NoSignal, 1=Sync1, 2=Sync2, 3=ReadData",
						},
					},
				},
			},
		},
	}
}
