package freedv

/*
 * FreeDV Extension Registration
 * Provides factory and metadata for the audio extension registry
 */

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new FreeDV extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	return NewFreeDVExtension(audioParams, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "freedv",
		"description": "FreeDV RADE digital voice decoder via freedv-ka9q",
		"version":     "1.0.0",
		"parameters":  map[string]interface{}{},
		"notes":       "No frontend parameters required. The tuned frequency is read automatically from the active session. Callsign and locator are taken from the UberSDR instance configuration. The reporting message is fixed as 'UberSDR Decoder'.",
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol carrying Opus-encoded decoded audio frames. Frames are only sent when a RADE signal is actively being decoded.",
			"encoding":    "Opus (AppVoIP, 12 kHz mono, 20 ms frames / 240 samples)",
			"protocol": map[string]interface{}{
				"opus_frame": map[string]interface{}{
					"type":        0x02,
					"description": "Opus-encoded decoded audio frame (only sent when RADE signal is present)",
					"format":      "[type:1][timestamp:8][sample_rate:4][channels:1][opus_data: N bytes]",
					"fields": []map[string]interface{}{
						{
							"name":        "type",
							"bytes":       1,
							"description": "Message type: 0x02 = Opus audio frame",
						},
						{
							"name":        "timestamp",
							"bytes":       8,
							"description": "GPS Unix timestamp in nanoseconds (big-endian uint64)",
						},
						{
							"name":        "sample_rate",
							"bytes":       4,
							"description": "Output sample rate in Hz (big-endian uint32) — always 12000",
						},
						{
							"name":        "channels",
							"bytes":       1,
							"description": "Number of audio channels (uint8) — always 1 (mono)",
						},
						{
							"name":        "opus_data",
							"bytes":       -1,
							"description": "Opus-encoded audio bytes (variable length)",
						},
					},
				},
			},
		},
	}
}
