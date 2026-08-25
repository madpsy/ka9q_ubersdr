package main

import "math"

// Waterfall geometry for the KiwiSDR emulation.
//
// The Kiwi client derives its entire frequency axis from the zoom level and
// x_bin it is echoed in the W/F packet header: it assumes the server returns
// exactly wf_fft_size (1024) bins spanning exactly 30 MHz / 2^zoom, and there
// is no protocol field with which to tell it otherwise. Deliver a different
// span and signals simply appear at the wrong frequencies, silently.
//
// radiod, meanwhile, has strong opinions about which bin bandwidths are cheap.
// From ka9q-radio src/spectrum.c setup_narrowband(), the requested bin
// bandwidth (rbw) is always honoured exactly, but the FFT length is searched:
//
//	fft_n = bin_count + 400/rbw, then incremented until
//	goodchoice(fft_n) && lrint(fft_n * rbw) % samprate_base == 0
//
// where samprate_base is lcm(blockrate, L*blockrate/N) = 200 for this front end
// and goodchoice() (src/filter.c) accepts only 2/3/5/7-smooth lengths with at
// most one factor of 11 or 13. Asking for a Kiwi zoom step's exact bin
// bandwidth -- 29296.875 / 2^zoom, never a round number -- sends that search a
// very long way up: zoom 9 lands on fft_n = 22464 with a 1.2854 MHz
// downconverter, for a 58 kHz display span.
//
// So we ask radiod for a round bin bandwidth it can serve cheaply and resample
// onto the client's grid before transmitting. Same picture, ~19x less work at
// zoom 9, and the deep zoom levels become reachable at all.
const (
	// kiwiWaterfallBins is wf_fft_size: the bin count the Kiwi client's axis
	// assumes, announced at connect and fixed for the life of the connection.
	kiwiWaterfallBins = 1024

	// kiwiFullSpanHz is the 0-30 MHz coverage the emulation advertises, which
	// zoom 0 shows in full.
	//
	// Deliberately fixed, and deliberately NOT config.Receiver.Span(): a real KiwiSDR is
	// a 30 MHz device, and the client derives its whole frequency axis from the zoom
	// level with no protocol field to say otherwise (see the note above). On a receiver
	// that reaches further, this emulation shows the bottom 30 MHz of it and the v2
	// frontend is where the rest lives. Widening it would put every signal at the wrong
	// frequency in every Kiwi client, silently. See RECEIVER_SPAN.md.
	kiwiFullSpanHz = 30e6

	// kiwiMaxZoom is the deepest zoom level offered. At zoom 14 the span is
	// 1.83 kHz -- 1.79 Hz per displayed bin -- which is also a real KiwiSDR's
	// limit, so the client is on home ground.
	kiwiMaxZoom = 14

	// radiodSpectrumCrossoverHz is where radiod switches between its two
	// spectral analysis algorithms: above it the wideband FFT over the front
	// end, at or below it a per-channel downconverter. ka9q-radio src/modes.c
	// sets DEFAULT_CROSSOVER = 200 and calls it "about where the two spectral
	// analysis algorithms use equal CPU"; nothing here overrides it.
	radiodSpectrumCrossoverHz = 200.0

	// radiodFilterMarginHz is the guard band radiod reserves for the
	// downconverter's filter skirts: setup_narrowband() sets max_IF to
	// (samprate - 400)/2, so a span is only fully usable if the channel's
	// sample rate exceeds it by this much.
	radiodFilterMarginHz = 400.0
)

// radiodBinBandwidthLadder holds the round bin bandwidths radiod resolves to a
// small FFT. Each is a value for which the samprate condition above is met
// within a few tens of steps of the search's starting point, so fft_n stays
// near bin_count instead of running into the tens of thousands. It matches the
// ladder the v2 spectrum path uses for the same reason.
//
// This is a property of radiod, not of either emulation: the WebSDR waterfall uses it
// too. 0.5 Hz is radiod's real floor — the figure to reach for instead of inventing a
// conservative one.
var radiodBinBandwidthLadder = []float64{0.5, 1, 2, 5, 10, 20, 50, 100, 200}

// radiodRoundUpBinBW returns the bin bandwidth to ask radiod for when a display wants
// `want` Hz per bin.
//
// Above the crossover the exact value is already cheap — the wideband FFT length is just
// samprate/rbw, no search and no downconverter — so it is passed through and the caller's
// resample is a no-op.
//
// At or below it, the smallest ladder value that still *covers* the view. Rounding down
// would deliver a narrower span than the client is going to draw and put signals at the
// wrong frequencies, which is the one failure this must not have; rounding up costs
// sharpness instead, which is recoverable.
func radiodRoundUpBinBW(want float64) float64 {
	if want > radiodSpectrumCrossoverHz {
		return want
	}
	binBW := radiodBinBandwidthLadder[len(radiodBinBandwidthLadder)-1]
	for i := len(radiodBinBandwidthLadder) - 1; i >= 0; i-- {
		if radiodBinBandwidthLadder[i] >= want {
			binBW = radiodBinBandwidthLadder[i]
		}
	}
	return binBW
}

// kiwiSpectrumBins is the bin count every request uses, at every zoom, for the
// life of the channel.
//
// radiod sizes a spectrum channel's bin_data buffer exactly once. The guard in
// spectrum.c that should resize it on a bin count change compares against a
// local that the reinitialisation block has already updated, so only its
// "buffer is NULL" arm can ever fire; every later change leaves the buffer at
// its original size while narrowband_poll memsets and fills bin_count entries.
// Asking an existing channel for more bins than it was created with therefore
// writes past the end of a heap block, and radiod dies with glibc's "corrupted
// size vs. prev_size in fastbins".
//
// So the emulation holds bin_count at the display width for the life of the
// channel and varies only the bin bandwidth. The cost is that a round bandwidth
// has to be rounded up rather than down -- the delivered view must still span
// what the client draws -- which leaves the waterfall between 1.1x and 1.75x
// softer than the display grid at the deepest zooms. Zoom 0-7 are unaffected:
// they ask for the exact bandwidth, as they always have.
//
// v2 escapes the same bug by only ever reducing its bin count from the
// configured default and restoring it to that same value.
const kiwiSpectrumBins = kiwiWaterfallBins

// kiwiSpectrumRequest is what to ask radiod for at a given zoom, paired with
// the grid the client is going to assume it received.
type kiwiSpectrumRequest struct {
	BinBandwidth float64 // Hz per bin to request from radiod
	BinCount     int     // bins to request from radiod
	DisplayBinBW float64 // Hz per bin the client's axis assumes
	DisplayBins  int     // always kiwiWaterfallBins
}

// DisplaySpanHz is the width of the view the client will draw.
func (r kiwiSpectrumRequest) DisplaySpanHz() float64 {
	return r.DisplayBinBW * float64(r.DisplayBins)
}

// kiwiSpectrumParams chooses radiod parameters for a zoom level.
//
// Above radiod's crossover the exact bin bandwidth is already cheap -- the
// wideband FFT length is just samprate/rbw, with no search and no downconverter
// -- so it is requested unchanged and the resample below is a no-op. That keeps
// zoom 0-7, every level the emulation used to offer, on exactly the path they
// have always taken.
//
// At or below the crossover the round ladder takes over, rounded up so the
// delivered span still covers what the client draws.
func kiwiSpectrumParams(zoom int) kiwiSpectrumRequest {
	if zoom < 0 {
		zoom = 0
	}
	if zoom > kiwiMaxZoom {
		zoom = kiwiMaxZoom
	}

	span := kiwiFullSpanHz / math.Pow(2, float64(zoom))
	displayBinBW := span / float64(kiwiWaterfallBins)

	req := kiwiSpectrumRequest{
		DisplayBinBW: displayBinBW,
		DisplayBins:  kiwiWaterfallBins,
	}

	// Never varies; see kiwiSpectrumBins.
	req.BinCount = kiwiSpectrumBins

	// With the bin count pinned, bin_count x bin_bw is the delivered span, which is why
	// this rounds up rather than down. See radiodRoundUpBinBW.
	req.BinBandwidth = radiodRoundUpBinBW(displayBinBW)
	return req
}

// resampleSpectrumOntoGrid maps a spectrum radiod delivered onto the grid a client
// assumes, given both bin bandwidths. Used by both emulations' waterfalls. Both are centred on the same
// frequency; src is expected to be at least as wide as the display span, and is
// cropped symmetrically to it.
//
// Every output bin takes the peak of the source bins its frequency range
// overlaps, in both directions. A waterfall exists to show narrow signals, and
// the alternatives lose them: point sampling skips whole source bins when
// downsampling, and interpolating between dB values when upsampling smears a
// single-bin carrier into its neighbours until, if no output bin happens to
// land on it, it is not visible at all. Taking the peak of the overlap keeps
// a carrier at full height and merely widens it to the two output bins it
// genuinely straddles.
//
// src must already be in ascending frequency order; unwrap radiod's raw FFT
// halves before calling.
func resampleSpectrumOntoGrid(src []float32, srcBinBW, dstBinBW float64, dstBins int) []float32 {
	if dstBins <= 0 {
		return nil
	}
	if len(src) == 0 {
		return make([]float32, dstBins)
	}
	// Already the right grid: nothing to do. This is the zoom 0-7 path.
	if len(src) == dstBins && srcBinBW == dstBinBW {
		out := make([]float32, dstBins)
		copy(out, src)
		return out
	}
	if srcBinBW <= 0 || dstBinBW <= 0 {
		// Unknown geometry: fall back to treating src as covering exactly the
		// display span, which is what this path assumed before the ladder
		// existed. Wrong resolution beats a wrong frequency axis.
		srcBinBW = dstBinBW * float64(dstBins) / float64(len(src))
	}

	srcSpan := float64(len(src)) * srcBinBW
	dstSpan := float64(dstBins) * dstBinBW

	// Offset of the display window's low edge within src, in source bins.
	// Both are centred on the channel frequency, so the crop is symmetric.
	offset := (srcSpan - dstSpan) / (2 * srcBinBW)
	step := dstBinBW / srcBinBW

	out := make([]float32, dstBins)
	for i := 0; i < dstBins; i++ {
		lo := offset + float64(i)*step
		hi := lo + step

		// The source bins this output bin overlaps. With step < 1 that is the
		// one or two it straddles; with step > 1 it is the whole group.
		start := int(math.Floor(lo))
		end := int(math.Ceil(hi))
		if start < 0 {
			start = 0
		}
		if end > len(src) {
			end = len(src)
		}
		if start >= end {
			// Entirely outside the delivered data, which the crop should have
			// made impossible; clamp rather than read out of range.
			if start >= len(src) {
				start = len(src) - 1
			}
			out[i] = src[start]
			continue
		}
		peak := src[start]
		for j := start + 1; j < end; j++ {
			if src[j] > peak {
				peak = src[j]
			}
		}
		out[i] = peak
	}
	return out
}
