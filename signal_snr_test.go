package main

import (
	"math"
	"testing"
)

// The reading this fix came from: radiod reporting N0 = -148.4 dBFS/Hz with a
// baseband power of -114.8 dBFS through a 2.65 kHz SSB filter, which the Signal
// panel showed as "33.6 dB SNR" on an empty patch of 20 m.
func TestNoisePowerMatchesTheMeasuredChannel(t *testing.T) {
	cs := &ChannelStatus{
		NoiseDensity:  -148.4,
		BasebandPower: -114.8,
		LowEdge:       50,
		HighEdge:      2700,
	}

	if bw := cs.FilterBandwidthHz(); math.Abs(float64(bw)-2650) > 0.001 {
		t.Fatalf("FilterBandwidthHz() = %v, want 2650", bw)
	}

	// -148.4 + 10*log10(2650)
	np := channelNoisePower(cs.NoiseDensity, cs.FilterBandwidthHz())
	if math.Abs(float64(np)+114.17) > 0.01 {
		t.Errorf("channelNoisePower() = %v, want about -114.17", np)
	}

	// Noise-only air reads just below 0 dB, not 33.6.
	if snr := cs.BasebandPower - np; math.Abs(float64(snr)+0.63) > 0.02 {
		t.Errorf("snr = %v, want about -0.63 dB", snr)
	}

	// The old subtraction was S/N0 in dB·Hz: high by exactly 10*log10(2650).
	old := cs.BasebandPower - cs.NoiseDensity
	if drift := old - (cs.BasebandPower - np); math.Abs(float64(drift)-34.23) > 0.02 {
		t.Errorf("pre-fix figure ran %v dB high, want 34.23", drift)
	}
}

// The property the whole change exists for: with the signal a fixed number of dB
// over the noise, the SNR must not move when the filter does.  It used to, which
// is why a squelch set on SSB gated wrongly the moment the user switched to CW.
func TestSnrDoesNotMoveWithFilterWidth(t *testing.T) {
	const n0 float32 = -148.4
	const over float32 = 10 // dB above the noise, in every filter

	for _, bw := range []float32{300, 500, 2650, 6000, 9400} {
		np := channelNoisePower(n0, bw)
		bb := np + over

		if snr := bb - np; math.Abs(float64(snr-over)) > 0.001 {
			t.Errorf("bw=%v: snr = %v, want %v", bw, snr, over)
		}

		// And confirm the old form really did depend on the filter, so this
		// test would have failed before the fix rather than passing by luck.
		if old := bb - n0; math.Abs(float64(old-over)) < 1 {
			t.Errorf("bw=%v: pre-fix figure was %v, expected it to be far from %v", bw, old, over)
		}
	}
}

// An absent reading must stay absent.  Returning N0 unscaled when the bandwidth
// is unknown would be silently wrong by tens of dB, and letting -999 through the
// arithmetic would hand audioGateAllows an SNR near +900 and hold the squelch
// open — the one failure mode a gate must not have.
func TestNoisePowerKeepsSentinels(t *testing.T) {
	if got := channelNoisePower(SignalUnavailable, 2650); got != SignalUnavailable {
		t.Errorf("absent N0 became %v", got)
	}
	if got := channelNoisePower(-148.4, 0); got != SignalUnavailable {
		t.Errorf("unknown bandwidth became %v", got)
	}
	if got := channelNoisePower(float32(math.NaN()), 2650); got != SignalUnavailable {
		t.Errorf("NaN N0 became %v", got)
	}

	for _, cs := range []*ChannelStatus{
		{LowEdge: 2700, HighEdge: 50}, // inverted
		{LowEdge: 50, HighEdge: 50},   // zero width
		{},                            // nothing reported
	} {
		if bw := cs.FilterBandwidthHz(); bw != 0 {
			t.Errorf("edges %v..%v gave bandwidth %v, want 0", cs.LowEdge, cs.HighEdge, bw)
		}
	}
}

// A negative-edge passband (LSB) is as wide as its positive-edge mirror.
func TestFilterBandwidthHandlesNegativeEdges(t *testing.T) {
	lsb := &ChannelStatus{LowEdge: -2700, HighEdge: -50}
	usb := &ChannelStatus{LowEdge: 50, HighEdge: 2700}
	if lsb.FilterBandwidthHz() != usb.FilterBandwidthHz() {
		t.Errorf("LSB %v != USB %v", lsb.FilterBandwidthHz(), usb.FilterBandwidthHz())
	}
}
