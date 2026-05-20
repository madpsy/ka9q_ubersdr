package morse

import (
	"fmt"
)

// AudioExtensionParams contains audio stream parameters passed in from the session.
type AudioExtensionParams struct {
	SampleRate    int // Hz — must be 12000 for cw-decoder
	Channels      int // Always 1 (mono)
	BitsPerSample int // Always 16
}

// AudioExtension is the interface all audio extensions must satisfy.
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// AudioExtensionFactory creates a new extension instance.
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new ExternalMorseExtension.
// If the cw-decoder binary is missing it returns a stub that immediately sends
// a 0x12 error frame when Start() is called, so the frontend can display a
// human-readable message rather than a silent failure.
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("morse requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("morse requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	ext, err := NewMorseExtension(audioParams.SampleRate, extensionParams)
	if err != nil {
		// Binary missing — return a stub that reports the error to the frontend.
		return &missingBinaryStub{msg: err.Error()}, nil
	}
	return ext, nil
}

// GetInfo returns extension metadata and wire-protocol documentation.
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "morse",
		"displayName": "Morse Code Decoder",
		"version":     "2.0.0",
		"description": "CW decoder powered by ggmorse (cw-decoder subprocess). Auto-detects pitch and speed.",
		"parameters": map[string]interface{}{
			"pitch": map[string]interface{}{
				"type":        "number",
				"description": "CW tone frequency in Hz passed to --pitch. Sets the ggmorse search window to pitch±150 Hz and locks pitch detection. Omit to use full auto-detect (default: ggmorse searches 500–700 Hz).",
				"optional":    true,
			},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary frames sent over the WebSocket",
			"protocol": map[string]interface{}{
				"decode_event": map[string]interface{}{
					"type_byte":   "0x10",
					"description": "Decoded text with quality metadata",
					"format":      "[type:1=0x10][confidence:1][cost:4 float32 BE][pitch:4 float32 BE][speed:4 float32 BE][text_len:4 uint32 BE][text: UTF-8]",
					"confidence_values": map[string]interface{}{
						"0": "high   (cost < 0.15)",
						"1": "medium (cost < 0.35)",
						"2": "low    (cost < 0.60)",
						"3": "poor   (cost >= 0.60)",
					},
				},
				"stats_event": map[string]interface{}{
					"type_byte":   "0x11",
					"description": "Pitch/speed update without new text",
					"format":      "[type:1=0x11][pitch:4 float32 BE][speed:4 float32 BE]",
				},
				"error_event": map[string]interface{}{
					"type_byte":   "0x12",
					"description": "Error message (e.g. binary not found)",
					"format":      "[type:1=0x12][msg_len:4 uint32 BE][msg: UTF-8]",
				},
			},
		},
	}
}

// missingBinaryStub is returned by Factory when cw-decoder is not installed.
// It sends a single 0x12 error frame on Start() so the frontend can show a
// meaningful message, then exits cleanly.
type missingBinaryStub struct {
	msg string
}

func (s *missingBinaryStub) GetName() string { return "morse" }

func (s *missingBinaryStub) Start(_ <-chan AudioSample, resultChan chan<- []byte) error {
	go func() {
		resultChan <- encodeErrorMsg(s.msg)
	}()
	return nil
}

func (s *missingBinaryStub) Stop() error { return nil }
