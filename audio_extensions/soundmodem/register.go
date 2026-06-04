package soundmodem

import (
	"fmt"
	"os"
)

/*
 * Sound Modem Extension Registration
 * Provides factory and metadata for the audio extension registry.
 */

// AudioExtensionFactory is a function that creates a new extension instance.
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// AudioExtensionInfo contains metadata about a registered extension.
type AudioExtensionInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

// Factory creates a new SoundModemExtension instance.
// If the binary is missing it returns a stub that immediately sends a 0x21
// error frame when Start() is called, so the frontend shows a clear message.
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("sound modem requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("sound modem requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Check binary exists before trying to create the extension.
	if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
		return &missingBinaryStub{
			msg: fmt.Sprintf("QtSoundModem binary not found at %s", binaryPath),
		}, nil
	}

	return NewSoundModemExtension(audioParams, extensionParams)
}

// GetInfo returns extension metadata and wire-protocol documentation.
func GetInfo() map[string]interface{} {
	modemTypes := []map[string]interface{}{
		{"value": 0, "label": "AFSK AX.25 300bd"},
		{"value": 1, "label": "AFSK AX.25 1200bd (Bell 202)"},
		{"value": 2, "label": "AFSK AX.25 600bd"},
		{"value": 3, "label": "AFSK AX.25 2400bd"},
		{"value": 4, "label": "BPSK AX.25 1200bd"},
		{"value": 5, "label": "BPSK AX.25 600bd"},
		{"value": 6, "label": "BPSK AX.25 300bd"},
		{"value": 7, "label": "BPSK AX.25 2400bd"},
		{"value": 8, "label": "QPSK AX.25 4800bd"},
		{"value": 9, "label": "QPSK AX.25 3600bd"},
		{"value": 10, "label": "QPSK AX.25 2400bd"},
		{"value": 11, "label": "BPSK FEC 4×100bd"},
		{"value": 12, "label": "DW QPSK V26A 2400bd"},
		{"value": 13, "label": "DW 8PSK V27 4800bd"},
		{"value": 14, "label": "DW QPSK V26B 2400bd"},
		{"value": 15, "label": "ARDOP Packet"},
	}

	return map[string]interface{}{
		"name":        "soundmodem",
		"displayName": "Sound Modem (AX.25 Packet)",
		"version":     "1.0.0",
		"description": "AX.25 packet decoder powered by QtSoundModem. Decodes AFSK/PSK/QPSK packet radio frames and delivers raw AX.25 data via KISS TNC. Supports up to 4 simultaneous modem channels.",
		"parameters": map[string]interface{}{
			"output_mode": map[string]interface{}{
				"type":        "string",
				"description": "Optional. Controls what the backend sends for each decoded frame. \"ax25\" (default) strips KISS framing and sends raw AX.25 bytes in a 0x20 envelope (use for the built-in web display). \"kiss\" sends the complete raw KISS frame with 0xC0 delimiters in a 0x22 envelope (use for piping to direwolf or other KISS software). Can be changed at runtime via audio_extension_control set_output_mode without restarting the modem.",
				"enum":        []string{"ax25", "kiss"},
				"default":     "ax25",
				"required":    false,
			},
			"channels": map[string]interface{}{
				"type":        "array",
				"description": "Array of up to 4 modem channel configurations. Each entry configures one QtSoundModem decoder channel.",
				"maxItems":    4,
				"items": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"enabled": map[string]interface{}{
							"type":        "boolean",
							"description": "Whether this channel is active",
							"default":     false,
						},
						"modem": map[string]interface{}{
							"type":        "integer",
							"description": "Modem type index",
							"default":     1,
							"enum":        modemTypes,
						},
						"freq": map[string]interface{}{
							"type":        "number",
							"description": "Center frequency in Hz (100–4000). For Bell 202 AFSK use 1700. For HF 300bd use 1500.",
							"minimum":     100,
							"maximum":     4000,
							"default":     1700,
						},
						"rcvr_pairs": map[string]interface{}{
							"type":        "integer",
							"description": "Number of receiver diversity pairs (0–8). More pairs improve decode rate at the cost of CPU.",
							"minimum":     0,
							"maximum":     8,
							"default":     0,
						},
						"fx25": map[string]interface{}{
							"type":        "integer",
							"description": "FX.25 forward error correction mode: 0=off, 1=RX only (default), 2=RX+TX",
							"minimum":     0,
							"maximum":     2,
							"default":     1,
						},
						"il2p": map[string]interface{}{
							"type":        "integer",
							"description": "IL2P mode: 0=off (default), 1=IL2P, 2=IL2P+CRC, 3=both",
							"minimum":     0,
							"maximum":     3,
							"default":     0,
						},
					},
				},
			},
			"dcd_threshold": map[string]interface{}{
				"type":        "integer",
				"description": "DCD (Data Carrier Detect) threshold (1–100). Lower = more sensitive but more false triggers. Default: 20.",
				"minimum":     1,
				"maximum":     100,
				"default":     20,
				"optional":    true,
			},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary frames sent over the WebSocket",
			"protocol": map[string]interface{}{
				"packet_frame": map[string]interface{}{
					"type_byte":   "0x20",
					"description": "Decoded AX.25 packet frame",
					"format":      "[type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type: 0x20 = AX.25 packet frame",
						},
						{
							"name":        "kiss_port",
							"bytes":       1,
							"description": "KISS port number (0 = channel A, 1 = channel B, etc.)",
						},
						{
							"name":        "frame_len",
							"bytes":       4,
							"description": "Length of the AX.25 frame in bytes (big-endian uint32)",
						},
						{
							"name":        "ax25_frame",
							"bytes":       -1,
							"description": "Raw AX.25 frame bytes (variable length)",
						},
					},
				},
				"kiss_frame": map[string]interface{}{
					"type_byte":   "0x22",
					"description": "Complete raw KISS frame (output_mode=\"kiss\" only). Contains the full KISS-framed bytes including 0xC0 delimiters and type byte. Can be piped directly to direwolf or other KISS-aware software.",
					"format":      "[type:1=0x22][frame_len:4 uint32 BE][kiss_frame: N bytes]",
					"note":        "kiss_frame = 0xC0 [kiss_type_byte] [ax25_data...] 0xC0",
				},
				"error_event": map[string]interface{}{
					"type_byte":   "0x21",
					"description": "Error message (e.g. binary not found, subprocess crash)",
					"format":      "[type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]",
				},
			},
		},
	}
}

// missingBinaryStub is returned by Factory when QtSoundModem is not installed.
// It sends a single 0x21 error frame on Start() so the frontend can show a
// meaningful message, then exits cleanly.
type missingBinaryStub struct {
	msg string
}

func (s *missingBinaryStub) GetName() string { return "soundmodem" }

func (s *missingBinaryStub) Start(_ <-chan AudioSample, resultChan chan<- []byte) error {
	go func() {
		resultChan <- encodeErrorFrame(s.msg)
	}()
	return nil
}

func (s *missingBinaryStub) Stop() error { return nil }
