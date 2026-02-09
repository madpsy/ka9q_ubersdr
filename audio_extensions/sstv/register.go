package sstv

/*
 * SSTV Extension Registration
 * Provides factory function and metadata for the SSTV decoder
 *
 * Copyright (c) 2026, UberSDR project
 */

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new SSTV extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	return NewSSTVExtension(audioParams, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "sstv",
		"description": "Slow Scan Television (SSTV) decoder supporting 47 modes including Martin, Scottie, Robot, PD, and MMSSTV",
		"version":     "1.0.0",
		"author":      "UberSDR (ported from slowrx by OH2EIQ)",
		"parameters": map[string]interface{}{
			"auto_sync": map[string]interface{}{
				"type":        "boolean",
				"description": "Automatically detect sync pulses and correct image slant",
				"default":     true,
			},
			"decode_fsk_id": map[string]interface{}{
				"type":        "boolean",
				"description": "Decode FSK callsign transmission after image",
				"default":     true,
			},
			"mmsstv_only": map[string]interface{}{
				"type":        "boolean",
				"description": "Only decode MMSSTV modes (MR/MP/ML series)",
				"default":     false,
			},
		},
		"supported_modes": []map[string]interface{}{
			// Martin modes
			{"name": "Martin M1", "short": "M1", "vis": 0x2C, "resolution": "320x256", "color": "GBR"},
			{"name": "Martin M2", "short": "M2", "vis": 0x28, "resolution": "320x256", "color": "GBR"},
			{"name": "Martin M3", "short": "M3", "vis": 0x24, "resolution": "320x256", "color": "GBR"},
			{"name": "Martin M4", "short": "M4", "vis": 0x20, "resolution": "320x256", "color": "GBR"},

			// Scottie modes
			{"name": "Scottie S1", "short": "S1", "vis": 0x3C, "resolution": "320x256", "color": "GBR"},
			{"name": "Scottie S2", "short": "S2", "vis": 0x38, "resolution": "320x256", "color": "GBR"},
			{"name": "Scottie DX", "short": "SDX", "vis": 0x4C, "resolution": "320x256", "color": "GBR"},

			// Robot modes
			{"name": "Robot 12", "short": "R12", "vis": 0x00, "resolution": "320x240", "color": "YUV"},
			{"name": "Robot 24", "short": "R24", "vis": 0x04, "resolution": "320x240", "color": "YUV"},
			{"name": "Robot 36", "short": "R36", "vis": 0x08, "resolution": "320x240", "color": "YUV"},
			{"name": "Robot 72", "short": "R72", "vis": 0x0C, "resolution": "320x240", "color": "YUV"},
			{"name": "Robot 8 B/W", "short": "R8-BW", "vis": 0x02, "resolution": "320x240", "color": "BW"},
			{"name": "Robot 12 B/W", "short": "R12-BW", "vis": 0x06, "resolution": "320x240", "color": "BW"},
			{"name": "Robot 24 B/W", "short": "R24-BW", "vis": 0x0A, "resolution": "320x240", "color": "BW"},
			{"name": "Robot 36 B/W", "short": "R36-BW", "vis": 0x0E, "resolution": "320x240", "color": "BW"},

			// Wraase SC modes
			{"name": "Wraase SC-2 60", "short": "SC60", "vis": 0x3B, "resolution": "320x256", "color": "RGB"},
			{"name": "Wraase SC-2 120", "short": "SC120", "vis": 0x3F, "resolution": "320x256", "color": "RGB"},
			{"name": "Wraase SC-2 180", "short": "SC180", "vis": 0x37, "resolution": "320x256", "color": "RGB"},

			// PD modes
			{"name": "PD-50", "short": "PD50", "vis": 0x5D, "resolution": "320x256", "color": "YUVY"},
			{"name": "PD-90", "short": "PD90", "vis": 0x63, "resolution": "320x256", "color": "YUVY"},
			{"name": "PD-120", "short": "PD120", "vis": 0x5F, "resolution": "640x496", "color": "YUVY"},
			{"name": "PD-160", "short": "PD160", "vis": 0x62, "resolution": "512x400", "color": "YUVY"},
			{"name": "PD-180", "short": "PD180", "vis": 0x60, "resolution": "640x496", "color": "YUVY"},
			{"name": "PD-240", "short": "PD240", "vis": 0x61, "resolution": "640x496", "color": "YUVY"},
			{"name": "PD-290", "short": "PD290", "vis": 0x5E, "resolution": "800x616", "color": "YUVY"},

			// Pasokon modes
			{"name": "Pasokon P3", "short": "P3", "vis": 0x71, "resolution": "640x496", "color": "RGB"},
			{"name": "Pasokon P5", "short": "P5", "vis": 0x72, "resolution": "640x496", "color": "RGB"},
			{"name": "Pasokon P7", "short": "P7", "vis": 0x73, "resolution": "640x496", "color": "RGB"},

			// MMSSTV MP modes
			{"name": "MMSSTV MP73", "short": "MP73", "vis": 0x25, "visx": true, "resolution": "320x256", "color": "YUVY"},
			{"name": "MMSSTV MP115", "short": "MP115", "vis": 0x29, "visx": true, "resolution": "320x256", "color": "YUVY"},
			{"name": "MMSSTV MP140", "short": "MP140", "vis": 0x2A, "visx": true, "resolution": "320x256", "color": "YUVY"},
			{"name": "MMSSTV MP175", "short": "MP175", "vis": 0x2C, "visx": true, "resolution": "320x256", "color": "YUVY"},

			// MMSSTV MR modes
			{"name": "MMSSTV MR73", "short": "MR73", "vis": 0x45, "visx": true, "resolution": "320x256", "color": "YUV"},
			{"name": "MMSSTV MR90", "short": "MR90", "vis": 0x46, "visx": true, "resolution": "320x256", "color": "YUV"},
			{"name": "MMSSTV MR115", "short": "MR115", "vis": 0x49, "visx": true, "resolution": "320x256", "color": "YUV"},
			{"name": "MMSSTV MR140", "short": "MR140", "vis": 0x4A, "visx": true, "resolution": "320x256", "color": "YUV"},
			{"name": "MMSSTV MR175", "short": "MR175", "vis": 0x4C, "visx": true, "resolution": "320x256", "color": "YUV"},

			// MMSSTV ML modes
			{"name": "MMSSTV ML180", "short": "ML180", "vis": 0x05, "visx": true, "resolution": "640x496", "color": "YUV"},
			{"name": "MMSSTV ML240", "short": "ML240", "vis": 0x06, "visx": true, "resolution": "640x496", "color": "YUV"},
			{"name": "MMSSTV ML280", "short": "ML280", "vis": 0x09, "visx": true, "resolution": "640x496", "color": "YUV"},
			{"name": "MMSSTV ML320", "short": "ML320", "vis": 0x0A, "visx": true, "resolution": "640x496", "color": "YUV"},

			// FAX480
			{"name": "FAX480", "short": "FAX480", "vis": 0x05, "resolution": "512x480", "color": "BW"},
		},
		"output_format": map[string]interface{}{
			"type":        "binary",
			"description": "Binary protocol with image lines and status messages",
			"protocol": map[string]interface{}{
				"image_line": map[string]interface{}{
					"type":        0x01,
					"description": "Decoded image line (RGB)",
					"format":      "[type:1][line:4][width:4][rgb_data:width*3]",
					"fields": []map[string]interface{}{
						{"name": "type", "bytes": 1, "description": "Message type (0x01)"},
						{"name": "line", "bytes": 4, "description": "Line number (big-endian uint32)"},
						{"name": "width", "bytes": 4, "description": "Image width in pixels (big-endian uint32)"},
						{"name": "rgb_data", "bytes": -1, "description": "RGB pixel data (3 bytes per pixel)"},
					},
				},
				"mode_detected": map[string]interface{}{
					"type":        0x02,
					"description": "SSTV mode detected",
					"format":      "[type:1][mode_idx:1][extended:1][name_len:1][name:len]",
					"fields": []map[string]interface{}{
						{"name": "type", "bytes": 1, "description": "Message type (0x02)"},
						{"name": "mode_idx", "bytes": 1, "description": "Mode index"},
						{"name": "extended", "bytes": 1, "description": "1 if extended VIS, 0 otherwise"},
						{"name": "name_len", "bytes": 1, "description": "Length of mode name"},
						{"name": "name", "bytes": -1, "description": "Mode name string"},
					},
				},
				"status": map[string]interface{}{
					"type":        0x03,
					"description": "Status update",
					"format":      "[type:1][code:1][msg_len:2][message:len]",
					"fields": []map[string]interface{}{
						{"name": "type", "bytes": 1, "description": "Message type (0x03)"},
						{"name": "code", "bytes": 1, "description": "Status code"},
						{"name": "msg_len", "bytes": 2, "description": "Message length (big-endian uint16)"},
						{"name": "message", "bytes": -1, "description": "Status message string"},
					},
				},
				"sync_detected": map[string]interface{}{
					"type":        0x04,
					"description": "Sync pulse detected",
					"format":      "[type:1][quality:1]",
				},
				"complete": map[string]interface{}{
					"type":        0x05,
					"description": "Image decode complete",
					"format":      "[type:1][total_lines:4]",
					"fields": []map[string]interface{}{
						{"name": "type", "bytes": 1, "description": "Message type (0x05)"},
						{"name": "total_lines", "bytes": 4, "description": "Total lines decoded (big-endian uint32)"},
					},
				},
				"fsk_id": map[string]interface{}{
					"type":        0x06,
					"description": "FSK callsign decoded",
					"format":      "[type:1][len:1][callsign:len]",
					"fields": []map[string]interface{}{
						{"name": "type", "bytes": 1, "description": "Message type (0x06)"},
						{"name": "len", "bytes": 1, "description": "Callsign length"},
						{"name": "callsign", "bytes": -1, "description": "Callsign string"},
					},
				},
			},
		},
		"features": []string{
			"VIS code detection (8-bit and 16-bit extended)",
			"47 SSTV modes supported",
			"Automatic sync detection and slant correction",
			"FFT-based FM demodulation",
			"Color space conversion (RGB, GBR, YUV, YUVY, BW)",
			"FSK callsign decoding",
			"Real-time line-by-line streaming",
			"Adaptive windowing based on SNR",
		},
		"requirements": map[string]interface{}{
			"sample_rate": "Any (tested with 12000, 24000, 48000 Hz)",
			"channels":    1,
			"bit_depth":   16,
			"mode":        "USB (typically)",
		},
	}
}
