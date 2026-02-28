package whisper

/*
 * Whisper Extension Registration
 * Provides factory and metadata for the audio extension registry
 */

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new Whisper extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	return NewWhisperExtension(audioParams, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "whisper",
		"description": "OpenAI Whisper speech-to-text transcription via WhisperLive streaming",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"server_url": map[string]interface{}{
				"type":        "string",
				"description": "WhisperLive WebSocket URL",
				"default":     "ws://localhost:9090",
			},
			"model": map[string]interface{}{
				"type":        "string",
				"description": "Whisper model size",
				"default":     "base",
				"options":     []string{"tiny", "base", "small", "medium", "large"},
			},
			"language": map[string]interface{}{
				"type":        "string",
				"description": "Language code (e.g., 'en', 'es', 'auto')",
				"default":     "en",
			},
			"send_interval_ms": map[string]interface{}{
				"type":        "number",
				"description": "Audio send interval in milliseconds",
				"default":     100,
				"min":         50,
				"max":         500,
			},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol with transcribed text",
			"protocol": map[string]interface{}{
				"text_message": map[string]interface{}{
					"type":        0x01,
					"description": "Transcribed text message",
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
							"description": "Unix timestamp in nanoseconds (big-endian uint64)",
						},
						{
							"name":        "text_length",
							"bytes":       4,
							"description": "Text length in bytes (big-endian uint32)",
						},
						{
							"name":        "text",
							"bytes":       -1,
							"description": "UTF-8 encoded transcribed text",
						},
					},
				},
			},
		},
	}
}
