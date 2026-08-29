package main

import (
	"math"
	"testing"
)

// The averaging count is not the thing that matters; the span of signal it
// covers is. radiod picks fft_n so the channel's sample rate is fft_n * bin_bw,
// so one FFT is always 1/bin_bw seconds and a response is fft_avg/bin_bw.
func windowSeconds(avg int, binBW float64) float64 {
	return float64(avg) / binBW
}

func TestSpectrumAveragesForBoundsTheWindow(t *testing.T) {
	rc := &RadiodController{}
	configured := rc.fftAverages()

	// Every bandwidth the zoom ladder can reach, wide to narrow.
	for _, binBW := range []float64{29296.875, 5000, 2000, 1000, 500, 300, 200, 100, 50, 20, 10, 5, 2, 1, 0.5} {
		avg := rc.spectrumAveragesFor(binBW)

		if avg < minSpectrumFFTAverages {
			t.Errorf("bin_bw %g: averages %d below the minimum %d", binBW, avg, minSpectrumFFTAverages)
		}
		if avg > configured {
			t.Errorf("bin_bw %g: averages %d above the configured %d -- this may only reduce",
				binBW, avg, configured)
		}
		// One FFT is the floor and cannot be traded away: at 2 Hz/bin you are
		// looking at half a second whatever you do. What must not happen is
		// averaging piling more history on top of it.
		if w := windowSeconds(avg, binBW); avg > 1 && w > maxSpectrumAveragingWindow {
			t.Errorf("bin_bw %g: %d averages span %.2fs, over the %.2fs cap",
				binBW, avg, w, maxSpectrumAveragingWindow)
		}
	}
}

// The shallow end must be untouched: this exists for the deep zooms, and
// changing the wide views would be a regression in smoothness for no reason.
func TestSpectrumAveragesForLeavesShallowZoomAlone(t *testing.T) {
	rc := &RadiodController{}
	configured := rc.fftAverages()

	for _, binBW := range []float64{29296.875, 200, 50, 20, 10} {
		if got := rc.spectrumAveragesFor(binBW); got != configured {
			t.Errorf("bin_bw %g: averages %d, want the configured %d unchanged", binBW, got, configured)
		}
	}
}

// The two zoom levels this was written for.
func TestSpectrumAveragesForDeepZoom(t *testing.T) {
	rc := &RadiodController{}

	tests := []struct {
		binBW      float64
		wantAvg    int
		wantWindow float64
	}{
		{binBW: 10, wantAvg: 4, wantWindow: 0.40}, // unchanged
		{binBW: 5, wantAvg: 2, wantWindow: 0.40},  // was 4 averages, 0.80s
		{binBW: 2, wantAvg: 1, wantWindow: 0.50},  // was 4 averages, 2.00s
	}
	for _, tc := range tests {
		got := rc.spectrumAveragesFor(tc.binBW)
		if got != tc.wantAvg {
			t.Errorf("bin_bw %g: averages %d, want %d", tc.binBW, got, tc.wantAvg)
		}
		if w := windowSeconds(got, tc.binBW); w > tc.wantWindow+0.001 {
			t.Errorf("bin_bw %g: window %.2fs, want %.2fs", tc.binBW, w, tc.wantWindow)
		}
	}
}

// A receiver configured for less averaging keeps it: this reduces, never raises.
func TestSpectrumAveragesForNeverRaises(t *testing.T) {
	rc := &RadiodController{}
	rc.SetSpectrumFFTAverages(1)

	for _, binBW := range []float64{29296.875, 10, 2} {
		if got := rc.spectrumAveragesFor(binBW); got != 1 {
			t.Errorf("bin_bw %g: averages %d with 1 configured, want 1", binBW, got)
		}
	}
}

// An unknown bandwidth is not a reason to change the averaging.
func TestSpectrumAveragesForIgnoresNonPositive(t *testing.T) {
	rc := &RadiodController{}
	configured := rc.fftAverages()

	for _, binBW := range []float64{0, -5} {
		if got := rc.spectrumAveragesFor(binBW); got != configured {
			t.Errorf("bin_bw %g: averages %d, want the configured %d", binBW, got, configured)
		}
	}
}

// The count has to reach radiod on a zoom, not only at channel creation --
// otherwise a channel created wide and zoomed deep keeps its original averaging
// and the window grows with every step in.
func TestUpdateSpectrumCommandCarriesAveraging(t *testing.T) {
	buf := buildUpdateSpectrumCommand(0x1234, spectrumUpdate{
		frequency:    14_074_000,
		binBandwidth: 2,
		binCount:     1024,
		fftAverages:  1,
	})
	if findTag(buf, tagSpectrumAvg) < 0 {
		t.Error("SPECTRUM_AVG missing from an update that changed the bin bandwidth")
	}

	// A pan carries no bandwidth, so it has no averaging to revise either.
	pan := buildUpdateSpectrumCommand(0x1234, spectrumUpdate{frequency: 14_075_000})
	if findTag(pan, tagSpectrumAvg) >= 0 {
		t.Error("SPECTRUM_AVG sent on a pan, which does not change the averaging window")
	}
}

// Coalescing may drop commands but not parameters: a pan folded onto a zoom
// must keep the zoom's averaging count, exactly as it keeps its bin count.
func TestSpectrumUpdateMergeKeepsAveraging(t *testing.T) {
	zoom := spectrumUpdate{binBandwidth: 2, binCount: 1024, sendBinCount: true, fftAverages: 1}
	pan := spectrumUpdate{frequency: 14_075_000}

	merged := zoom
	merged.merge(pan)

	if merged.fftAverages != 1 {
		t.Errorf("fftAverages = %d after a pan coalesced onto a zoom, want 1 kept", merged.fftAverages)
	}
	if merged.binBandwidth != 2 {
		t.Errorf("binBandwidth = %v, want 2 kept", merged.binBandwidth)
	}
	if merged.frequency != 14_075_000 {
		t.Errorf("frequency = %d, want the pan's", merged.frequency)
	}
}

// ── Wideband transform budget ────────────────────────────────────────────────
//
// Above the crossover radiod's FFT length comes from the front end, not the
// view: fft_n = samprate / bin_bw (src/spectrum.c setup_wideband). The averaging
// count multiplies that, and it is the only part of it a client can give back.

// widebandFFTLength is setup_wideband()'s sizing, reproduced.
func widebandFFTLength(samprate int, binBW float64) float64 {
	return math.Round(float64(samprate) / binBW)
}

// The wideband views a 60 MHz receiver's clients can reach, and what each must
// cost now. Enumerated against setup_wideband()'s own arithmetic rather than
// reasoned about: fft_n = samprate / bin_bw, and the budget buys
// floor(budget / fft_n) averages, floored at one.
func TestSpectrumAveragesForBoundsTheWidebandTransform(t *testing.T) {
	const samprate = 129_600_000
	rc := &RadiodController{}
	rc.SetFrontendSamprate(samprate)

	tests := []struct {
		view    string
		binBW   float64
		wantAvg int
	}{
		{view: "60 MHz", binBW: 58593.75, wantAvg: 4},        // 2,212 pts
		{view: "3.75 MHz", binBW: 3662.109375, wantAvg: 4},   // 35,389 pts: the measured 12% row, untouched
		{view: "1.87 MHz", binBW: 1831.0546875, wantAvg: 3},  // 70,779 pts
		{view: "937 kHz", binBW: 915.52734375, wantAvg: 1},   // 141,558 pts: the measured 47% row
		{view: "469 kHz", binBW: 457.763671875, wantAvg: 1},  // 283,116 pts: the measured 97% row
		{view: "234 kHz", binBW: 228.8818359375, wantAvg: 1}, // 566,231 pts: deepest wideband view
	}
	for _, tc := range tests {
		got := rc.spectrumAveragesFor(tc.binBW)
		if got != tc.wantAvg {
			t.Errorf("%s (%g Hz/bin): averages %d, want %d", tc.view, tc.binBW, got, tc.wantAvg)
		}

		// Either the response fits the budget, or one average already does not
		// -- which is the floor, and the only thing left to bound it is the FFT
		// length itself (websdrSpectrumParams).
		fftN := widebandFFTLength(samprate, tc.binBW)
		if points := fftN * float64(got); points > maxWidebandTransformPoints && got > 1 {
			t.Errorf("%s (%g Hz/bin): %d averages cost %.0f points, over the %d budget with room to give",
				tc.view, tc.binBW, got, points, maxWidebandTransformPoints)
		}
	}
}

// What the budget is worth: every deep wideband view gives up averaging in
// proportion to what it costs, so the three measured rows drop by the factor
// their averaging drops by. Nothing shallow pays anything.
func TestSpectrumAveragesForCutsDeepWidebandCost(t *testing.T) {
	const samprate = 129_600_000
	rc := &RadiodController{}
	rc.SetFrontendSamprate(samprate)
	before := rc.fftAverages()

	tests := []struct {
		view      string
		binBW     float64
		wantRatio float64 // cost after / cost before
	}{
		{view: "3.75 MHz (12.0%)", binBW: 3662.109375, wantRatio: 1.0},
		{view: "937 kHz (46.9%)", binBW: 915.52734375, wantRatio: 0.25},
		{view: "469 kHz (97.2%)", binBW: 457.763671875, wantRatio: 0.25},
	}
	for _, tc := range tests {
		got := float64(rc.spectrumAveragesFor(tc.binBW)) / float64(before)
		if math.Abs(got-tc.wantRatio) > 0.001 {
			t.Errorf("%s: now costs %.2fx what it did, want %.2fx", tc.view, got, tc.wantRatio)
		}
	}
}

// Below the crossover radiod downconverts and fft_n follows the bin count, so
// the front end rate must not enter the decision at all.
func TestSpectrumAveragesForLeavesNarrowbandAlone(t *testing.T) {
	rc := &RadiodController{}
	rc.SetFrontendSamprate(129_600_000)
	bare := &RadiodController{}

	for _, binBW := range []float64{200, 100, 50, 20, 10, 5, 2, 1, 0.5} {
		if got, want := rc.spectrumAveragesFor(binBW), bare.spectrumAveragesFor(binBW); got != want {
			t.Errorf("bin_bw %g: averages %d with a known samprate, %d without -- the wideband budget leaked below the crossover",
				binBW, got, want)
		}
	}
}

// The channels UberSDR runs for itself are wide and cheap; none of them may lose
// averaging to this.
func TestSpectrumAveragesForLeavesInternalChannelsAlone(t *testing.T) {
	rc := &RadiodController{}
	rc.SetFrontendSamprate(129_600_000)
	configured := rc.fftAverages()

	for _, tc := range []struct {
		what  string
		binBW float64
	}{
		{"full-span default, 30 MHz rx", 29296.875},
		{"full-span default, 60 MHz rx", 29296.875},
		{"noise floor wideband", nfWidebandBinBandwidth},
	} {
		if got := rc.spectrumAveragesFor(tc.binBW); got != configured {
			t.Errorf("%s (%g Hz/bin): averages %d, want the configured %d", tc.what, tc.binBW, got, configured)
		}
	}
}

// An unconfigured controller must behave exactly as it did before the budget
// existed: no samprate, no opinion about the wideband side.
func TestSpectrumAveragesForIgnoresUnknownSamprate(t *testing.T) {
	rc := &RadiodController{}
	configured := rc.fftAverages()

	for _, binBW := range []float64{29296.875, 3662.109375, 457.763671875, 228.8818359375} {
		if got := rc.spectrumAveragesFor(binBW); got != configured {
			t.Errorf("bin_bw %g with no samprate: averages %d, want the configured %d", binBW, got, configured)
		}
	}
}

// This reduces, never raises -- including against a receiver configured for less.
func TestWidebandBudgetNeverRaises(t *testing.T) {
	rc := &RadiodController{}
	rc.SetFrontendSamprate(129_600_000)
	rc.SetSpectrumFFTAverages(1)

	for _, binBW := range []float64{29296.875, 3662.109375, 228.8818359375} {
		if got := rc.spectrumAveragesFor(binBW); got != 1 {
			t.Errorf("bin_bw %g: averages %d with 1 configured, want 1", binBW, got)
		}
	}
}

// ── CROSSOVER on the wire ────────────────────────────────────────────────────
//
// radiod picks between its two spectrum algorithms with `rbw > crossover`, so
// this tag is what decides whether a request downconverts or transforms the
// whole front end. Nothing else proves it leaves the process.

func TestCreateSpectrumCommandCarriesCrossover(t *testing.T) {
	buf := buildCreateSpectrumCommand(14_100_000, 1172, 200, 0x1234, 4, 200)
	if findTag(buf, tagCrossover) < 0 {
		t.Error("CROSSOVER missing from a create command")
	}
}

// 0 is not "absent" here -- it is how a wideband request is expressed, since
// nothing can be at or below zero. A zero test in place of the flag would drop
// exactly the requests that need it most.
func TestUpdateSpectrumCommandCarriesZeroCrossover(t *testing.T) {
	wide := buildUpdateSpectrumCommand(0x1234, spectrumUpdate{
		binBandwidth: 3662.109375, binCount: 1024, crossover: 0, sendCrossover: true,
	})
	if findTag(wide, tagCrossover) < 0 {
		t.Error("CROSSOVER 0 dropped from a wideband update -- radiod would keep its old algorithm")
	}

	narrow := buildUpdateSpectrumCommand(0x1234, spectrumUpdate{
		binBandwidth: 200, binCount: 2344, crossover: 200, sendCrossover: true,
	})
	if findTag(narrow, tagCrossover) < 0 {
		t.Error("CROSSOVER missing from a narrowband update")
	}

	// A pan carries no bandwidth, so it has no algorithm choice to restate.
	pan := buildUpdateSpectrumCommand(0x1234, spectrumUpdate{frequency: 14_075_000})
	if findTag(pan, tagCrossover) >= 0 {
		t.Error("CROSSOVER sent on a pan, which does not change the algorithm")
	}
}

// Coalescing may drop commands but not parameters: a pan folded onto a zoom must
// keep the zoom's crossover, or the bin bandwidth arrives without the choice that
// makes sense of it.
func TestSpectrumUpdateMergeKeepsCrossover(t *testing.T) {
	zoom := spectrumUpdate{binBandwidth: 200, binCount: 2344, sendBinCount: true, crossover: 200, sendCrossover: true}
	merged := zoom
	merged.merge(spectrumUpdate{frequency: 14_075_000})

	if !merged.sendCrossover || merged.crossover != 200 {
		t.Errorf("crossover %v (sent=%v) after a pan coalesced onto a zoom, want 200 kept",
			merged.crossover, merged.sendCrossover)
	}

	// And a wideband zoom's 0 must survive the same way -- the case a zero test breaks.
	wide := spectrumUpdate{binBandwidth: 3662, binCount: 1024, crossover: 0, sendCrossover: true}
	merged = wide
	merged.merge(spectrumUpdate{frequency: 14_075_000})
	if !merged.sendCrossover || merged.crossover != 0 {
		t.Errorf("crossover %v (sent=%v) after coalescing a wideband zoom, want 0 kept",
			merged.crossover, merged.sendCrossover)
	}
}
