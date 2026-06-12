package drm

/*
 * DRM Extension Registration
 * Provides factory and metadata for the audio extension registry
 */

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new DRM extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	return NewDRMExtension(audioParams, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "drm",
		"description": "DRM (Digital Radio Mondiale) decoder via ubersdr-drm",
		"version":     "1.0.0",
		"parameters":  map[string]interface{}{},
		"notes":       "Requires a stereo IQ session (Channels==2) with SampleRate>=12000. Supports iq (12 kHz), iq48, iq96, iq192. Dream scales all OFDM parameters proportionally via ADJ_FOR_SRATE so any rate works. The binary at /opt/ubersdr-drm/ubersdr-drm is spawned automatically. No frontend parameters are required.",
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol carrying Opus-encoded decoded DRM audio frames. Frames are only sent when a DRM signal is actively being decoded.",
			"encoding":    "Opus (AppVoIP, 12 kHz mono, 20 ms frames / 240 samples)",
			"protocol": map[string]interface{}{
				"opus_frame": map[string]interface{}{
					"type":        0x02,
					"description": "Opus-encoded decoded audio frame (only sent when DRM signal is present)",
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
