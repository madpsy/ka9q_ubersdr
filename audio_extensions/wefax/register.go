package wefax

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
	Start(audioChan <-chan []int16, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new WEFAX extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("WEFAX requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("WEFAX requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	return NewWEFAXExtension(audioParams.SampleRate, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "wefax",
		"description": "Weather Fax (WEFAX) decoder for HF radiofax transmissions",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"lpm": map[string]interface{}{
				"type":        "integer",
				"description": "Lines per minute (60, 90, 120, 240)",
				"default":     120,
				"min":         1,
				"max":         300,
			},
			"image_width": map[string]interface{}{
				"type":        "integer",
				"description": "Image width in pixels",
				"default":     1809,
				"min":         1,
				"max":         4000,
			},
			"carrier": map[string]interface{}{
				"type":        "number",
				"description": "Carrier frequency in Hz",
				"default":     1900.0,
				"min":         1.0,
				"max":         10000.0,
			},
			"deviation": map[string]interface{}{
				"type":        "number",
				"description": "Deviation in Hz",
				"default":     400.0,
				"min":         1.0,
				"max":         1000.0,
			},
			"bandwidth": map[string]interface{}{
				"type":        "integer",
				"description": "Filter bandwidth (0=narrow, 1=middle, 2=wide)",
				"default":     1,
				"min":         0,
				"max":         2,
			},
			"use_phasing": map[string]interface{}{
				"type":        "boolean",
				"description": "Enable phasing line detection for image alignment",
				"default":     true,
			},
			"auto_stop": map[string]interface{}{
				"type":        "boolean",
				"description": "Automatically stop decoding on stop signal",
				"default":     false,
			},
			"include_headers_in_images": map[string]interface{}{
				"type":        "boolean",
				"description": "Include start/stop headers in decoded image",
				"default":     false,
			},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol with image lines",
			"protocol": map[string]interface{}{
				"image_line": map[string]interface{}{
					"type":        0x01,
					"description": "Decoded image line",
					"format":      "[type:1][line_number:4][width:4][pixel_data:width]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type (0x01 for image line)",
						},
						{
							"name":        "line_number",
							"bytes":       4,
							"description": "Line number (big-endian uint32)",
						},
						{
							"name":        "width",
							"bytes":       4,
							"description": "Image width in pixels (big-endian uint32)",
						},
						{
							"name":        "pixel_data",
							"bytes":       -1,
							"description": "Grayscale pixel data (0-255 per pixel)",
						},
					},
				},
			},
		},
	}
}
