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
// The entries above 200 are for the WebSDR waterfall only. radiodRoundUpBinBW returns
// early above the crossover and never reaches them, so the Kiwi path -- which pins its bin
// count and must round up -- is unaffected by their presence. See websdrNarrowbandFor for
// what uses them and why a channel that can vary its bin count rounds the other way.
var radiodBinBandwidthLadder = []float64{0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000}

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

// The two spectrum paths cost quite different things, and both were measured on a
// 129.6 Msps receiver with one client at the full poll rate:
//
//	narrowband  the downconverter runs every block, so its cost is 1.25 x delivered
//	            span in points/second -- independent of bin count AND of block time.
//	            Measured: a 469 kHz span cost 4.5% of a core.
//	wideband    one FFT over the whole front end per response: poll rate x fft_avg x
//	            samprate / bin_bw. Measured: fft_n 70,779 with 3 averages cost 27%.
//
// Those two agree on a common rate -- 7.7e-6 and 9.5e-6 %CPU per point/second -- which is
// what makes them comparable at all, and is why the choice below can be made by counting
// points rather than by a threshold tuned per receiver.
//
// A fixed crossing bin bandwidth was the first attempt and it was wrong: the wideband cost
// scales with the front end's sample rate and the narrowband cost does not, so the crossing
// sits at ~2.0 kHz on a 129.6 Msps receiver and ~1.4 kHz on a 64.8 Msps one. Hardcoding the
// first put a 64.8 Msps receiver's zoom 4 on the narrowband path where wideband is 24%
// cheaper. Comparing the two candidates directly has no such receiver dependence.
const (
	// radiodSpectrumPollRateHz is how often a user-facing spectrum channel is polled, which
	// is what turns a wideband response into a rate. Measured on the live receiver;
	// spectrum.poll_period_ms is the setting behind it.
	radiodSpectrumPollRateHz = 13.35

	// radiodNarrowbandPointsPerHz is the downconverter's inverse FFT per second per Hz
	// of delivered span: blocklen x N/L points per block at 1/blocktime blocks per
	// second, which cancels to span x (N/L). N/L is 1.25 for this front end.
	radiodNarrowbandPointsPerHz = 1.25

	// radiodMaxNarrowbandSpanHz stops the comparison ever proposing an absurd
	// downconverter for a very wide view, whatever the arithmetic says.
	radiodMaxNarrowbandSpanHz = 4e6
)

// radiodWidebandPointsPerSec is what radiod spends per second on the wideband path for a
// request, mirroring setup_wideband (fft_n = samprate / bin_bw) and spectrumAveragesFor.
func radiodWidebandPointsPerSec(binBW float64, samprate int) float64 {
	if binBW <= 0 || samprate <= 0 {
		return math.Inf(1)
	}
	fftN := float64(samprate) / binBW
	avg := math.Floor(float64(maxWidebandTransformPoints) / fftN)
	if avg > float64(defaultSpectrumFFTAverages) {
		avg = float64(defaultSpectrumFFTAverages)
	}
	if avg < 1 {
		avg = 1
	}
	return radiodSpectrumPollRateHz * avg * fftN
}

// radiodNarrowbandPointsPerSec is what the downconverter spends per second to deliver a
// span. The bin count does not appear: it sets the resolution, not the cost.
func radiodNarrowbandPointsPerSec(deliveredSpanHz float64) float64 {
	return radiodNarrowbandPointsPerHz * deliveredSpanHz
}

// radiodNarrowbandFor picks the narrowband geometry for a view, or reports that the view
// belongs on the wideband path.
//
// Two things make this different from the Kiwi path's radiodRoundUpBinBW, and both come
// from the WebSDR emulation being able to vary its bin count:
//
// It rounds the bin bandwidth DOWN, to the finest round value the display grid justifies.
// Kiwi must round up because its bin count is pinned, so bin_count x bin_bw is all it has
// to cover the span with. Here the bin count absorbs that instead, which means the
// delivered picture is never softer than the one being drawn.
//
// And the bin count follows the view rather than the display width. That is what the cost
// of this path actually is: bins x bin_bw is the span the downconverter has to run at.
// Pinning bins to 1024 and rounding the bandwidth up -- which is what this used to do below
// 200 Hz -- asked for 204.8 kHz to draw a 117.2 kHz view, so the deepest zooms paid 1.75x
// for spectrum that was cropped away before it reached the client.
func radiodNarrowbandFor(visibleBWHz, displayBinBW float64) (binBW float64, bins int, ok bool) {
	if visibleBWHz <= 0 || displayBinBW <= 0 || visibleBWHz > radiodMaxNarrowbandSpanHz {
		return 0, 0, false
	}

	// The coarsest value that is still at least as sharp as the display grid. Going
	// finer than the grid costs bins -- four bytes each, every poll -- for detail the
	// peak-hold resample onto the client's pixels then throws away. It buys no CPU
	// either: the downconverter's cost is the delivered span, which is the same
	// whichever bandwidth carries it.
	fits := func(l float64) bool { return radiodEvenBinCount(visibleBWHz, l) <= maxSpectrumBins }
	best := 0.0
	for _, l := range radiodBinBandwidthLadder {
		if l > displayBinBW {
			break
		}
		if fits(l) {
			best = l // ascending, so this ends on the coarsest that qualifies
		}
	}
	if best == 0 {
		// Nothing at or below the grid fits in one datagram. Accept a softer
		// picture rather than the wideband path, which would be softer still.
		for _, l := range radiodBinBandwidthLadder {
			if fits(l) {
				best = l
				break
			}
		}
	}
	if best == 0 {
		return 0, 0, false
	}
	return best, radiodEvenBinCount(visibleBWHz, best), true
}

// radiodEvenBinCount is how many bins of binBW it takes to cover a span, rounded up
// to an even number.
//
// Even matters: radiod returns bins in raw FFT order and every consumer swaps the two
// halves to get ascending frequency. An odd count has no two equal halves, so the swap
// leaves a bin unwritten -- a single dead pixel that moves as you tune. Rounding up
// keeps the delivered span covering the view, which rounding down would not.
func radiodEvenBinCount(visibleBWHz, binBW float64) int {
	n := int(math.Ceil(visibleBWHz / binBW))
	if n%2 != 0 {
		n++
	}
	return n
}

// kiwiSpectrumRequest is what to ask radiod for at a given zoom, paired with
// the grid the client is going to assume it received.
type kiwiSpectrumRequest struct {
	BinBandwidth float64 // Hz per bin to request from radiod
	BinCount     int     // bins to request from radiod
	DisplayBinBW float64 // Hz per bin the client's axis assumes
	DisplayBins  int     // always kiwiWaterfallBins

	// Crossover is radiod's CROSSOVER for this request: BinBandwidth when the
	// downconverter is wanted, 0 when the wideband FFT is. See websdrSpectrumParams.
	Crossover float64
}

// DisplaySpanHz is the width of the view the client will draw.
func (r kiwiSpectrumRequest) DisplaySpanHz() float64 {
	return r.DisplayBinBW * float64(r.DisplayBins)
}

// kiwiSpectrumParams chooses radiod parameters for a zoom level.
//
// The Kiwi client's axis is fixed -- 1024 bins across 30 MHz / 2^zoom, with no protocol
// field to say otherwise -- but that is the grid it is SENT, not the geometry we have to
// ask radiod for. streamWaterfall resamples between them, so the request is free to be
// whatever radiod serves most cheaply.
//
// The bin count used to be pinned at 1024 for a different reason: ka9q-radio sized a
// spectrum channel's bin_data once and never resized it, so raising a live channel's bin
// count overran a heap block and killed radiod. ubersdr-radiod
// patches/0002-spectrum-bin-data-resize.patch fixes that, which is what lets this size the
// request to the view like the WebSDR path does.
//
// Both paths are costed and the cheaper wins -- see radiodNarrowbandFor. It matters most
// here: this ladder reaches a 234 kHz view at 228.88 Hz per bin, and on the wideband path
// that is an FFT over the entire front end, 566,231 points to deliver 1,024 of them.
// Downconverting to the same 234 kHz instead is around thirty times less work.
func kiwiSpectrumParams(zoom int, samprate int) kiwiSpectrumRequest {
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

	if binBW, bins, ok := radiodNarrowbandFor(span, displayBinBW); ok {
		narrow := radiodNarrowbandPointsPerSec(float64(bins) * binBW)
		if narrow < radiodWidebandPointsPerSec(displayBinBW, samprate) {
			req.BinBandwidth = binBW
			req.BinCount = bins
			req.Crossover = binBW // rbw > crossover is wideband, so equal is narrowband
			return req
		}
	}

	// Wideband, at the exact bandwidth the client's axis assumes: the resample is then
	// a no-op. Only the shallow zooms land here, where samprate/bin_bw is small.
	req.BinCount = kiwiWaterfallBins
	req.BinBandwidth = displayBinBW
	req.Crossover = 0 // nothing is at or below 0, so radiod always picks wideband
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
