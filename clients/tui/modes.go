package main

import (
	"fmt"
	"strings"
)

// Mode is a mode the server accepts on the audio socket: a demodulator, or one
// of the IQ modes, which carry the quadrature baseband as two channels instead
// of demodulating anything.
type Mode struct {
	Name string
	// Default filter edges in Hz relative to the tuned frequency. Low may be
	// negative, and for LSB both edges are negative.
	Low, High int
	// MaxHz is the Nyquist limit for this mode's channel sample rate, from
	// GetSampleRateForMode in config.go. Asking for more than this is
	// meaningless.
	MaxHz int
	// Rate is that channel sample rate in Hz. It is what the mode really
	// selects for the IQ modes, where the number in the name is the rate in
	// kilohertz; for the rest it is 12 or 24 kHz depending on the demodulator.
	//
	// The packets carry the rate too, so this is only what the display shows
	// before the first one arrives — but it is also what says how much data a
	// mode is about to cost, which for iq384 is worth knowing in advance.
	Rate int
	// IQ marks a quadrature mode: two channels rather than one, and served
	// losslessly whatever format was asked for, since there is no Opus encoder
	// for RF.
	IQ   bool
	Desc string
}

// Defaults match LocalBookmarksUI.BW_DEFAULTS in the web UI, so a frequency
// sounds the same here as it does in a browser.
//
// The IQ edges match the server's defaultBandwidthForMode, which for iq is the
// whole 12 kHz baseband. Asking for less would put a filter inside the preset's
// own passband and quietly empty the top and bottom of every capture. The wide
// IQ modes keep the preset's bandwidth and are never sent one at all — see
// isWideIQMode — so their edges here are the preset's, for display only.
var modes = []Mode{
	{"usb", 50, 2700, 6000, 12000, false, "upper sideband"},
	{"lsb", -2700, -50, 6000, 12000, false, "lower sideband"},
	{"cwu", -200, 200, 6000, 12000, false, "CW, upper"},
	{"cwl", -200, 200, 6000, 12000, false, "CW, lower"},
	{"am", -5000, 5000, 12000, 24000, false, "AM"},
	{"sam", -5000, 5000, 12000, 24000, false, "synchronous AM"},
	{"nfm", -5000, 5000, 12000, 24000, false, "narrow FM"},
	{"fm", -8000, 8000, 12000, 24000, false, "FM"},
	{"iq", -6000, 6000, 6000, 12000, true, "quadrature baseband, 12 kHz"},
	{"iq48", -24000, 24000, 24000, 48000, true, "quadrature baseband, 48 kHz"},
	{"iq96", -48000, 48000, 48000, 96000, true, "quadrature baseband, 96 kHz"},
	{"iq192", -96000, 96000, 96000, 192000, true, "quadrature baseband, 192 kHz"},
	{"iq384", -192000, 192000, 192000, 384000, true, "quadrature baseband, 384 kHz"},
}

// modeCost describes the widest a mode's stream can be: its raw sample rate,
// which nothing exceeds and the codec generally beats.
//
// Worth putting in front of the user because the IQ modes span a factor of
// thirty-two and iq384 is three keystrokes from anywhere. Measured against a
// live receiver, an iq384 stream cost 1110 kB/s lossless against the 1536 here,
// and 354 at the default 15 dB margin — so "up to" is the honest word.
func modeCost(name string) string {
	m, ok := lookupMode(name)
	if !ok || m.Rate <= 0 {
		return ""
	}
	channels := 1
	if m.IQ {
		channels = 2
	}
	kBps := float64(m.Rate*channels*2) / 1000
	if kBps < 1000 {
		return fmt.Sprintf("up to %.0f kB/s", kBps)
	}
	return fmt.Sprintf("up to %.1f MB/s", kBps/1000)
}

// isIQMode reports whether a mode carries quadrature baseband rather than
// demodulated audio.
func isIQMode(name string) bool {
	m, ok := lookupMode(name)
	return ok && m.IQ
}

// isWideIQMode reports whether a mode is one of the wide IQ variants.
//
// Two things follow from it, both from the server. Their bandwidth is the
// radiod preset's and must not be sent — the server skips the filter command
// for them entirely, and a client that sent edges anyway would be asking for a
// filter inside the preset's own passband. And they are gated: the receiver
// says which of them a session may use in /connection's allowed_iq_modes, where
// plain iq is always available and never listed.
func isWideIQMode(name string) bool {
	return isIQMode(name) && name != "iq"
}

// sidebandCutoff is the conventional amateur crossover: LSB below it, USB
// above. 10 MHz splits 40 m and 30 m, which is where the convention flips.
const sidebandCutoff = 10_000_000.0

// The server clamps bandwidth to ±12 kHz for non-bypassed sessions.
const maxBandwidthHz = 12000

func lookupMode(name string) (Mode, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, m := range modes {
		if m.Name == name {
			return m, true
		}
	}
	return Mode{}, false
}

// modeNames lists the modes this client can demodulate, for error messages.
func modeNames() []string {
	out := make([]string, len(modes))
	for i, m := range modes {
		out[i] = m.Name
	}
	return out
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
