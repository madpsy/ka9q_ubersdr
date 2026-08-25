package olivia

import (
	"fmt"
)

// AudioExtensionParams contains audio stream parameters (from session, not user-configurable)
type AudioExtensionParams struct {
	SampleRate    int // Hz — 12000 for the sideband modes Olivia is worked in
	Channels      int // 1 = mono, 2 = stereo IQ
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

// Factory creates a new Olivia extension instance.
//
// The mode is deliberately not checked. Olivia lives in the sideband modes and
// the panel says so, but a wrong mode is not a failure here — the tones simply
// are not in the audio, exactly as with FSK. What is refused is stereo IQ,
// where the interleaved samples would be decoded as if they were one channel
// and produce confident nonsense.
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("Olivia requires mono audio (got %d channels) — "+
			"switch the receiver out of an IQ mode", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("Olivia requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}
	return NewExtension(audioParams.SampleRate, extensionParams)
}

// Modes is the set of tones/bandwidth pairs the panel offers.
//
// Olivia is defined for any power-of-two tone count from 2 to 256 against any
// power-of-two multiple of 125 Hz from 125 to 2000, which is far more
// combinations than anyone uses. This is fldigi's quick-change list — the same
// eighteen, in the same order — with the three standard ones marked. Matching
// it matters because it is what people are picking from at the other end.
//
// The 2000 Hz modes need a centre around 1500 Hz rather than 1000: a tone block
// that wide under a 1000 Hz centre runs into DC, and the frequency search
// clamps to nothing. That is reported back in the config frame as `narrowed`
// rather than refused, exactly as the reference behaves.
var Modes = []struct {
	Tones     int
	Bandwidth int
	Standard  bool
}{
	{4, 125, false},
	{4, 250, false},
	{4, 500, false},
	{4, 1000, false},
	{4, 2000, false},
	{8, 125, false},
	{8, 250, true},
	{8, 500, false},
	{8, 1000, false},
	{8, 2000, false},
	{16, 500, true},
	{16, 1000, false},
	{16, 2000, false},
	{32, 1000, true},
	{32, 2000, false},
	{64, 500, false},
	{64, 1000, false},
	{64, 2000, false},
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	modes := make([]map[string]interface{}, 0, len(Modes))
	for _, m := range Modes {
		modes = append(modes, map[string]interface{}{
			"tones":     m.Tones,
			"bandwidth": m.Bandwidth,
			"standard":  m.Standard,
			"label":     fmt.Sprintf("%d/%d", m.Tones, m.Bandwidth),
		})
	}

	return map[string]interface{}{
		"name":        "olivia",
		"description": "Olivia MFSK decoder for weak-signal keyboard-to-keyboard HF",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"tones": map[string]interface{}{
				"type":        "number",
				"description": "Number of tones (rounded down to a power of two)",
				"default":     8,
				"min":         2,
				"max":         256,
				"choices":     modes,
			},
			"bandwidth": map[string]interface{}{
				"type":        "number",
				"description": "Bandwidth in Hz (rounded down to a power-of-two multiple of 125)",
				"default":     250,
				"min":         125,
				"max":         2000,
			},
			"center_frequency": map[string]interface{}{
				"type":        "number",
				"description": "Centre of the tone block in the audio passband, in Hz",
				"default":     1000.0,
				"min":         300.0,
				"max":         2700.0,
			},
			"sync_threshold": map[string]interface{}{
				"type": "number",
				"description": "Squelch: the FEC signal-to-noise a block must reach " +
					"before it is printed. Adjustable while running.",
				"default": SyncThresholdDefault,
				"min":     SyncThresholdMin,
				"max":     SyncThresholdMax,
				"live":    true,
			},
			"sync_margin": map[string]interface{}{
				"type":        "number",
				"description": "Half-width of the frequency search, in FFT bins",
				"default":     syncMarginDeflt,
				"min":         1,
				"max":         32,
			},
			"sync_integ_len": map[string]interface{}{
				"type":        "number",
				"description": "Blocks integrated by the synchroniser before a decision",
				"default":     syncIntegDefault,
				"min":         1,
				"max":         8,
			},
			"reverse": map[string]interface{}{
				"type":        "boolean",
				"description": "Decode an inverted tone block",
				"default":     false,
			},
			"contestia": map[string]interface{}{
				"type":        "boolean",
				"description": "Decode Contestia instead of Olivia (6-bit characters)",
				"default":     false,
			},
			"eight_bit": map[string]interface{}{
				"type":        "boolean",
				"description": "Honour the 127-prefix escape for characters above 126",
				"default":     true,
			},
		},
		"controls": map[string]interface{}{
			"set_squelch": map[string]interface{}{
				"description": "Change the squelch without re-attaching, so a lock that " +
					"took seconds to acquire survives the adjustment",
				"parameters": map[string]interface{}{
					"sync_threshold": map[string]interface{}{
						"type": "number",
						"min":  SyncThresholdMin,
						"max":  SyncThresholdMax,
					},
				},
			},
		},
		"output_format": map[string]interface{}{
			"type": "json",
			"description": "UTF-8 JSON frames, each tagged by \"type\": one \"config\" on " +
				"attach, \"text\" as characters are decoded, \"status\" twice a second",
			"frames": map[string]interface{}{
				FrameConfig: "What the decoder actually runs with after quantisation: " +
					"tones, bandwidth, centre, squelch, symbol length, first carrier, " +
					"baud rate, block period, characters per second, and whether the " +
					"frequency search had to be narrowed",
				FrameText: "{ts: unix ms, text: characters decoded since the last frame}. " +
					"Appended by the client, never replaced. Not sent when empty.",
				FrameStatus: "{ts, synced, snr, snr_db, quality, offset_hz, center_hz}",
			},
		},
	}
}
