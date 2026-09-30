package hdradio

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// Factory creates a new HD Radio extension instance.
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	return NewHDRadioExtension(audioParams, extensionParams)
}

// GetInfo returns extension metadata.
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "hdradio",
		"description": "HD Radio (NRSC-5) AM decoder via ubersdr-hdradio",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"program": map[string]interface{}{
				"type":        "number",
				"description": "Program to play at start, 0 (HD1) to 7 (HD8). Switch afterwards with the set_program control, which does not restart the decoder.",
				"default":     0,
			},
		},
		"notes": "Runs on a private iq48 channel of its own on the listener's frequency, so the listener stays in their own mode and is not sent the IQ. " +
			"Tune to the station's carrier. The binary at /opt/ubersdr-hdradio/ubersdr-hdradio_<arch> is spawned automatically.",
		"output_format": map[string]interface{}{
			"type": "binary",
			"protocol": map[string]interface{}{
				"audio":  "[0x02][timestamp u64 BE ns][sample_rate u32 BE = 48000][channels u8 = 2][Opus, 20 ms], only while the program is decoding",
				"status": "[0x03][JSON status line from the binary, unchanged]",
				"image":  "[0x04][header length u32 BE][header JSON: kind, program, lot, mime, name, bounds][JPEG or PNG]",
			},
		},
	}
}
