package main

import "strings"

// Mode is a demodulation mode the server accepts on the audio socket. IQ modes
// are deliberately excluded: they carry wideband RF rather than audio and the
// server rejects bandwidth changes for them.
type Mode struct {
	Name string
	// Default filter edges in Hz relative to the tuned frequency. Low may be
	// negative, and for LSB both edges are negative.
	Low, High int
	// MaxHz is the Nyquist limit for this mode's channel sample rate, from
	// GetSampleRateForMode in config.go: 12 kHz for the narrow modes and 24 kHz
	// for the wide ones. Asking for more than this is meaningless.
	MaxHz int
	Desc  string
}

// Defaults match LocalBookmarksUI.BW_DEFAULTS in the web UI, so a frequency
// sounds the same here as it does in a browser.
var modes = []Mode{
	{"usb", 50, 2700, 6000, "upper sideband"},
	{"lsb", -2700, -50, 6000, "lower sideband"},
	{"cwu", -200, 200, 6000, "CW, upper"},
	{"cwl", -200, 200, 6000, "CW, lower"},
	{"am", -5000, 5000, 12000, "AM"},
	{"sam", -5000, 5000, 12000, "synchronous AM"},
	{"nfm", -5000, 5000, 12000, "narrow FM"},
	{"fm", -8000, 8000, 12000, "FM"},
}

// sidebandCutoff is the conventional amateur crossover: LSB below it, USB
// above. 10 MHz splits 40 m and 30 m, which is where the convention flips.
const sidebandCutoff = 10_000_000.0

// The server clamps bandwidth to ±12 kHz for non-bypassed sessions.
const maxBandwidthHz = 12000

// modeSampleRate is the radio channel's sample rate for a mode, mirroring
// GetSampleRateForMode in the server's config.go. It matters because the
// server builds its Opus encoder once, from the rate in force at connect.
func modeSampleRate(name string) int {
	switch strings.ToLower(name) {
	case "am", "sam", "fm", "nfm":
		return 24000
	default:
		return 12000
	}
}

func lookupMode(name string) (Mode, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, m := range modes {
		if m.Name == name {
			return m, true
		}
	}
	return Mode{}, false
}

func modeIndex(name string) int {
	for i, m := range modes {
		if m.Name == name {
			return i
		}
	}
	return 0
}

// autoMode picks the sideband conventionally used at a frequency. Only the
// sideband modes flip; if the user has chosen AM or FM, that is a deliberate
// choice and crossing 10 MHz should not undo it.
func autoMode(freq float64) string {
	if freq < sidebandCutoff {
		return "lsb"
	}
	return "usb"
}

// isSideband reports whether a mode participates in automatic sideband
// selection.
func isSideband(name string) bool {
	return name == "usb" || name == "lsb"
}

// mirrorSideband converts filter edges between upper and lower sideband,
// preserving the width and offset the user has dialled in rather than snapping
// back to the defaults.
func mirrorSideband(low, high int) (int, int) {
	return -high, -low
}

// clampBandwidth keeps the edges inside what the mode can actually carry and
// ensures the filter has non-zero width with low below high.
//
// The limit is per mode, not a flat server cap: the narrow modes run on a
// 12 kHz channel, so asking USB for ±12 kHz is past its Nyquist and the extra
// is imaginary.
func clampBandwidth(modeName string, low, high int) (int, int) {
	limit := maxBandwidthHz
	if m, ok := lookupMode(modeName); ok && m.MaxHz > 0 {
		limit = m.MaxHz
	}

	if low > high {
		low, high = high, low
	}
	if low < -limit {
		low = -limit
	}
	if high > limit {
		high = limit
	}
	// A collapsed filter would mute the channel; keep a usable minimum.
	const minWidth = 50
	if high-low < minWidth {
		high = low + minWidth
		if high > limit {
			high = limit
			low = high - minWidth
		}
	}
	return low, high
}

// filterRange returns the absolute frequency range the current filter passes,
// which is what the spectrum and waterfall shade.
func filterRange(tuned float64, low, high int) (float64, float64) {
	return tuned + float64(low), tuned + float64(high)
}
