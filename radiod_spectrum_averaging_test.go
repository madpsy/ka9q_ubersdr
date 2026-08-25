package main

import "testing"

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
