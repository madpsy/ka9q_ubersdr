package main

import "fmt"

// Reduced-depth IQ
// ================
//
// The lossless stream is bit-exact, and for the wide IQ modes that is a lot of
// bytes: iq384 runs at over a megabyte a second. The server can instead drop
// the bits that sit under the band's own noise floor, and the client asks for
// that as a MARGIN in dB -- how far below the noise floor the quantisation
// floor must stay -- rather than as a bit depth, because a depth means
// something different on every band (see pcm_lossy.go in the repository root).
//
// Only IQ modes are reduced. A demodulated stream is sent whole whatever is
// asked, so outside IQ nothing is sent and no control is shown, which is what
// the v2 web UI does too.
//
// These mirror the server's clamp in pcm_lossy.go and the v2 UI's constants in
// static/v2/src/radio/constants.js; iq_margin_test.go pins them.
const (
	marginMinDB = 10
	marginMaxDB = 60

	// marginDefaultDB is what an IQ session asks for until the operator moves
	// the control, as in v2: not the floor of the range but 15 dB, where the
	// added quantisation noise lifts the noise floor by about what a meter
	// resolves (0.14 dB). The floor, 10 dB, is there for an operator who
	// chooses to trade a visible 0.4 dB for the bandwidth.
	marginDefaultDB = 15

	// marginSliderLossless is the slider's top stop, one step past the widest
	// margin, which means lossless: asking for a wider and wider margin buys
	// less and less, and a little past 60 dB every packet comes back bit for
	// bit, so lossless is the limit of the control rather than a separate one.
	marginSliderLossless = marginMaxDB + 1
)

// clampMargin coerces a requested margin to one the server honours unchanged.
// Zero or below is lossless.
func clampMargin(dB int) int {
	switch {
	case dB <= 0:
		return 0
	case dB < marginMinDB:
		return marginMinDB
	case dB > marginMaxDB:
		return marginMaxDB
	}
	return dB
}

// marginToWire is the min_margin to send for a mode: nothing at all (0)
// unless this is an IQ mode with a margin set.
func marginToWire(mode string, margin int) int {
	if !isIQMode(mode) {
		return 0
	}
	return clampMargin(margin)
}

// marginFromSlider turns a slider position into the margin it asks for; the
// top stop is lossless.
func marginFromSlider(v float64) int {
	if v >= marginSliderLossless {
		return 0
	}
	return clampMargin(int(v + 0.5))
}

// sliderFromMargin is the slider position that shows a margin.
func sliderFromMargin(dB int) float64 {
	if m := clampMargin(dB); m > 0 {
		return float64(m)
	}
	return marginSliderLossless
}

// marginLabel is how a margin reads beside the slider.
func marginLabel(dB int) string {
	if m := clampMargin(dB); m > 0 {
		return fmt.Sprintf("%d dB", m)
	}
	return "Lossless"
}
