package clock

import (
	"fmt"
)

// AudioExtensionParams contains audio stream parameters (from session, not user-configurable)
type AudioExtensionParams struct {
	SampleRate    int // Hz (e.g., 12000)
	Channels      int // Always 1 (mono) for this extension
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

// Factory creates a new clock extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("clock decoder requires mono audio (got %d channels) — "+
			"tune a voice mode, not IQ", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("clock decoder requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	return NewClockExtension(audioParams.SampleRate, extensionParams)
}

// GetInfo returns extension metadata
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "clock",
		"description": "WWV/WWVH/WWVB time-code decoder — decodes the NIST broadcast time code and reports the offset against your clock",
		"version":     "1.0.0",
		"parameters": map[string]interface{}{
			"station": map[string]interface{}{
				"type": "string",
				"description": "wwv, wwvh or wwvb. Normally omitted: the station is " +
					"derived from the session's tuned frequency, since WWV/WWVH and " +
					"WWVB need genuinely different decoders and the dial says which",
				"default": "(from the tuned frequency)",
			},
		},
		"output_format": map[string]interface{}{
			"type": "json",
			"description": "Newline-delimited JSON from the ubersdr-clock binary, " +
				"forwarded verbatim as binary frames, one object per event",
			"events": map[string]interface{}{
				"state": map[string]interface{}{
					"description": "Lock state changed",
					"fields":      "state (nosignal|acquiring|locked), station (unknown|wwv|wwvh|wwvb)",
				},
				"time": map[string]interface{}{
					"description": "A voted timestamp, while locked",
					"fields": "utc, utc_ms, minute, hour, doy, year2, quality (0-100), " +
						"offset_ms, offset_source, last_edge_sample, frame_start_sample, station",
				},
				"frame": map[string]interface{}{
					"description": "One raw frame decode, before voting",
					"fields": "minute, hour, doy, year2, dut1_tenths, dst1, dst2, " +
						"leap_pending, leap_year, confidence, frame_start_sample, station",
				},
				"second": map[string]interface{}{
					"description": "One classified second, with the 1 s alignment arrays",
					"fields": "edge_sample, symbol (0|1|2), confidence, second_of_frame, " +
						"series_rate, window_shift, envelope[], expected[], station",
				},
				"diag": map[string]interface{}{
					"description": "Acquisition telemetry — which stage of the funnel is failing",
					"fields": "state, station, tone_snr_db, pwm_contrast, tone_detected, " +
						"phase_locked, delay_est_ms, anchored, bad_frame_streak, " +
						"frames_in_window, window_size, vote_quality, refusal, samples_consumed",
				},
			},
		},
	}
}
