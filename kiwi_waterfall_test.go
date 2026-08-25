package main

import (
	"math"
	"testing"
)

// radiodFFTLength reproduces the search in ka9q-radio src/spectrum.c
// setup_narrowband(): start at bin_count + margin/rbw and step up until the
// length is FFT-friendly and the resulting sample rate is a multiple of
// samprate_base. Returns the chosen length and sample rate, or 0,0 if the
// search runs off the end as radiod's does at 65536.
func radiodFFTLength(rbw float64, binCount int) (int, int) {
	const samprateBase = 200 // lcm(blockrate 50, L*blockrate/N 40) for this front end
	n := int(math.Round(float64(binCount) + radiodFilterMarginHz/rbw))
	for n < 65536 {
		if radiodGoodChoice(n) && int(math.Round(float64(n)*rbw))%samprateBase == 0 {
			return n, int(math.Round(float64(n) * rbw))
		}
		n++
	}
	return 0, 0
}

// radiodGoodChoice reproduces goodchoice() from ka9q-radio src/filter.c: any
// number of factors of 2, 3, 5, 7 plus at most one of 11 or 13.
func radiodGoodChoice(n int) bool {
	elevens := 0
	for _, p := range []int{2, 3, 5, 7} {
		for n%p == 0 {
			n /= p
		}
	}
	for _, p := range []int{11, 13} {
		for n%p == 0 {
			n /= p
			elevens++
		}
	}
	return n == 1 && elevens <= 1
}

// Every zoom level must ask radiod for something it can serve without the FFT
// search running away. This is the whole reason the ladder exists: the exact
// Kiwi bin bandwidths (29296.875 / 2^zoom) drive fft_n into the tens of
// thousands once they fall below the crossover.
func TestKiwiSpectrumParamsStayCheap(t *testing.T) {
	// Generous: today's zoom 9 needs 22464, and the old cap existed to avoid it.
	const maxAcceptableFFT = 4096

	for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
		req := kiwiSpectrumParams(zoom)
		if req.BinBandwidth > radiodSpectrumCrossoverHz {
			continue // wideband mode: no search, no downconverter
		}

		fftLen, samprate := radiodFFTLength(req.BinBandwidth, req.BinCount)
		if fftLen == 0 {
			t.Errorf("zoom %d: bin_bw %.4f Hz x %d bins -- radiod finds no valid FFT length",
				zoom, req.BinBandwidth, req.BinCount)
			continue
		}
		if fftLen > maxAcceptableFFT {
			t.Errorf("zoom %d: bin_bw %.4f Hz x %d bins gives fft_n %d (> %d), too expensive",
				zoom, req.BinBandwidth, req.BinCount, fftLen, maxAcceptableFFT)
		}

		// setup_narrowband sets max_IF to (samprate - 400)/2, so the usable
		// width is samprate - 400. The display span has to fit inside it or its
		// edges sit in the filter skirt.
		usable := float64(samprate) - radiodFilterMarginHz
		if span := req.DisplaySpanHz(); usable < span {
			t.Errorf("zoom %d: usable width %.0f Hz < display span %.0f Hz; view edges fall in the filter skirt",
				zoom, usable, span)
		}
	}
}

// The client's axis is fixed: 1024 bins across 30MHz/2^zoom, whatever we ask
// radiod for.
func TestKiwiSpectrumParamsDisplayGrid(t *testing.T) {
	for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
		req := kiwiSpectrumParams(zoom)
		wantSpan := kiwiFullSpanHz / math.Pow(2, float64(zoom))

		if req.DisplayBins != kiwiWaterfallBins {
			t.Errorf("zoom %d: DisplayBins = %d, want %d", zoom, req.DisplayBins, kiwiWaterfallBins)
		}
		if got := req.DisplaySpanHz(); math.Abs(got-wantSpan) > 0.001 {
			t.Errorf("zoom %d: display span %.4f Hz, want %.4f", zoom, got, wantSpan)
		}
		// The delivered view must cover what the client will draw.
		if covered := float64(req.BinCount) * req.BinBandwidth; covered < wantSpan {
			t.Errorf("zoom %d: requesting %d bins x %.4f Hz = %.0f Hz, short of the %.0f Hz span",
				zoom, req.BinCount, req.BinBandwidth, covered, wantSpan)
		}
		// The bin count is pinned, so the bandwidth has to be rounded up and
		// the view is mildly upscaled. Bound how much: more than one ladder
		// step of slack would mean the ladder had gained a hole.
		if ratio := req.BinBandwidth / req.DisplayBinBW; ratio > 2 {
			t.Errorf("zoom %d: requesting %.4f Hz/bin to draw %.4f Hz/bin -- %.2fx upscale, too soft",
				zoom, req.BinBandwidth, req.DisplayBinBW, ratio)
		}
	}
}

// Zoom 0-7 are the levels the emulation already offered; they must keep asking
// for exactly what they always did, so this change cannot regress them.
func TestKiwiSpectrumParamsPreservesShallowZoom(t *testing.T) {
	for zoom := 0; zoom <= 7; zoom++ {
		req := kiwiSpectrumParams(zoom)
		want := kiwiFullSpanHz / math.Pow(2, float64(zoom)) / kiwiWaterfallBins

		if math.Abs(req.BinBandwidth-want) > 0.0001 {
			t.Errorf("zoom %d: bin_bw %.6f, want the exact %.6f it has always requested",
				zoom, req.BinBandwidth, want)
		}
		if req.BinCount != kiwiWaterfallBins {
			t.Errorf("zoom %d: bin count %d, want %d", zoom, req.BinCount, kiwiWaterfallBins)
		}
		if req.BinBandwidth <= radiodSpectrumCrossoverHz {
			t.Errorf("zoom %d: bin_bw %.4f is at or below the crossover, so this level "+
				"is no longer on the wideband path", zoom, req.BinBandwidth)
		}
	}
}

// Zoom 8 is the first level below the crossover and the first that was
// previously unreachable.
func TestKiwiSpectrumParamsCrossoverBoundary(t *testing.T) {
	if req := kiwiSpectrumParams(7); req.BinBandwidth <= radiodSpectrumCrossoverHz {
		t.Errorf("zoom 7 bin_bw %.4f should be above the %.0f Hz crossover",
			req.BinBandwidth, radiodSpectrumCrossoverHz)
	}
	req := kiwiSpectrumParams(8)
	if req.BinBandwidth > radiodSpectrumCrossoverHz {
		t.Fatalf("zoom 8 bin_bw %.4f should be at or below the crossover", req.BinBandwidth)
	}
	// Rounded up, not down: with the bin count pinned, a narrower bandwidth
	// would deliver less span than the client draws.
	if req.BinBandwidth != 200 {
		t.Errorf("zoom 8 bin_bw = %v, want the 200 Hz ladder step", req.BinBandwidth)
	}
}

func TestKiwiSpectrumParamsClampsZoom(t *testing.T) {
	if got, want := kiwiSpectrumParams(-3), kiwiSpectrumParams(0); got != want {
		t.Errorf("negative zoom = %+v, want it clamped to zoom 0 (%+v)", got, want)
	}
	if got, want := kiwiSpectrumParams(99), kiwiSpectrumParams(kiwiMaxZoom); got != want {
		t.Errorf("zoom 99 = %+v, want it clamped to zoom %d (%+v)", got, kiwiMaxZoom, want)
	}
}

// A pass-through must be exactly that: zoom 0-7 deliver the display grid
// already, and the data must reach the client untouched.
func TestResampleKiwiWaterfallIdentity(t *testing.T) {
	src := make([]float32, kiwiWaterfallBins)
	for i := range src {
		src[i] = float32(-120 + i%40)
	}
	out := resampleSpectrumOntoGrid(src, 114.44, 114.44, kiwiWaterfallBins)
	if len(out) != kiwiWaterfallBins {
		t.Fatalf("length %d, want %d", len(out), kiwiWaterfallBins)
	}
	for i := range src {
		if out[i] != src[i] {
			t.Fatalf("bin %d = %v, want %v unchanged", i, out[i], src[i])
		}
	}
}

// The output must always be exactly the bin count the client's axis assumes,
// whatever radiod sent.
func TestResampleKiwiWaterfallAlwaysDisplayBins(t *testing.T) {
	for _, srcLen := range []int{1, 100, 512, 1023, 1024, 1176, 1465, 2232, 4096} {
		src := make([]float32, srcLen)
		out := resampleSpectrumOntoGrid(src, 100, 114.44, kiwiWaterfallBins)
		if len(out) != kiwiWaterfallBins {
			t.Errorf("src %d bins -> %d out, want %d", srcLen, len(out), kiwiWaterfallBins)
		}
	}
}

// The point of peak-hold. A single-bin carrier anywhere in the input must
// survive to the output; point sampling at these ratios drops roughly one
// input bin in seven.
func TestResampleKiwiWaterfallKeepsNarrowCarriers(t *testing.T) {
	// Zoom 8 geometry: 1024 bins at 200 Hz up to 1024 bins at 114.4409 Hz.
	req := kiwiSpectrumParams(8)
	const floor, carrier = -130.0, -20.0

	lost := 0
	// Only bins inside the cropped display span can survive; the request
	// covers slightly more than the client draws.
	margin := int((float64(req.BinCount)*req.BinBandwidth - req.DisplaySpanHz()) / (2 * req.BinBandwidth))
	for pos := margin + 1; pos < req.BinCount-margin-1; pos++ {
		src := make([]float32, req.BinCount)
		for i := range src {
			src[i] = floor
		}
		src[pos] = carrier

		out := resampleSpectrumOntoGrid(src, req.BinBandwidth, req.DisplayBinBW, req.DisplayBins)
		peak := float32(floor)
		for _, v := range out {
			if v > peak {
				peak = v
			}
		}
		if peak < carrier-0.001 {
			lost++
		}
	}
	if lost != 0 {
		t.Errorf("%d of %d single-bin carriers vanished in the resample; peak-hold is not working",
			lost, req.BinCount-2*margin-2)
	}
}

// A carrier must land at the right place, not merely survive: this is the
// property the whole zoom limit existed to protect.
func TestResampleKiwiWaterfallPreservesFrequency(t *testing.T) {
	req := kiwiSpectrumParams(9)
	const floor, carrier = -130.0, -20.0

	// Put a carrier at a known offset from the centre of the view and check it
	// lands in the matching output bin.
	for _, offsetHz := range []float64{-20000, -5000, 0, 5000, 20000} {
		src := make([]float32, req.BinCount)
		for i := range src {
			src[i] = floor
		}
		srcCentre := float64(req.BinCount) / 2
		srcIdx := int(srcCentre + offsetHz/req.BinBandwidth)
		src[srcIdx] = carrier

		out := resampleSpectrumOntoGrid(src, req.BinBandwidth, req.DisplayBinBW, req.DisplayBins)

		peakIdx, peak := -1, float32(floor)
		for i, v := range out {
			if v > peak {
				peak, peakIdx = v, i
			}
		}
		if peakIdx < 0 {
			t.Errorf("offset %+.0f Hz: carrier lost entirely", offsetHz)
			continue
		}
		gotHz := (float64(peakIdx) - float64(req.DisplayBins)/2) * req.DisplayBinBW
		// One output bin of slack: the source bin has finite width.
		if math.Abs(gotHz-offsetHz) > req.DisplayBinBW {
			t.Errorf("offset %+.0f Hz: carrier drawn at %+.0f Hz (bin %d), off by %.0f Hz",
				offsetHz, gotHz, peakIdx, math.Abs(gotHz-offsetHz))
		}
	}
}

// Unknown geometry (a packet from before the first zoom command) must fall
// back to treating the data as covering the display span rather than producing
// a wrong axis or a panic.
func TestResampleKiwiWaterfallUnknownGeometry(t *testing.T) {
	src := make([]float32, 512)
	for i := range src {
		src[i] = float32(i)
	}
	out := resampleSpectrumOntoGrid(src, 0, 114.44, kiwiWaterfallBins)
	if len(out) != kiwiWaterfallBins {
		t.Fatalf("length %d, want %d", len(out), kiwiWaterfallBins)
	}
	// Ends should still map to the ends of the input.
	if out[0] != src[0] {
		t.Errorf("first bin = %v, want %v", out[0], src[0])
	}
	if last := out[len(out)-1]; last < src[len(src)-1]-1 {
		t.Errorf("last bin = %v, want about %v", last, src[len(src)-1])
	}
}

func TestResampleKiwiWaterfallDegenerateInput(t *testing.T) {
	if got := resampleSpectrumOntoGrid(nil, 100, 114.44, kiwiWaterfallBins); len(got) != kiwiWaterfallBins {
		t.Errorf("nil input gave %d bins, want %d of silence", len(got), kiwiWaterfallBins)
	}
	if got := resampleSpectrumOntoGrid([]float32{1, 2, 3}, 100, 114.44, 0); got != nil {
		t.Errorf("zero output bins gave %v, want nil", got)
	}
}

// The bin count must never change between zoom levels.
//
// radiod sizes a spectrum channel's bin_data buffer on its first allocation and
// the guard meant to resize it can never fire (spectrum.c updates the local it
// compares against before the check), so asking an existing channel for more
// bins than it was created with overruns a heap block and aborts radiod with
// "corrupted size vs. prev_size in fastbins". Varying only the bin bandwidth is
// what keeps the emulation clear of it.
func TestKiwiSpectrumParamsBinCountNeverChanges(t *testing.T) {
	for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
		req := kiwiSpectrumParams(zoom)
		if req.BinCount != kiwiSpectrumBins {
			t.Errorf("zoom %d: bin count %d, want %d at every zoom -- a change would crash radiod",
				zoom, req.BinCount, kiwiSpectrumBins)
		}
		// Even, too: the FFT unwrap swaps halves, and an odd length leaves the
		// last bin unwritten.
		if req.BinCount%2 != 0 {
			t.Errorf("zoom %d: bin count %d is odd; the half-swap unwrap would drop a bin",
				zoom, req.BinCount)
		}
	}
}

// Reproduces the unwrap in streamWaterfall to prove an odd count would have
// left a zero bin, so the guard above is load-bearing rather than decorative.
func TestFFTUnwrapNeedsEvenBinCount(t *testing.T) {
	unwrap := func(src []float32) []float32 {
		n := len(src)
		half := n / 2
		out := make([]float32, n)
		copy(out[0:half], src[half:n])
		copy(out[half:n], src[0:half])
		return out
	}

	for _, n := range []int{1024, 1025} {
		src := make([]float32, n)
		for i := range src {
			src[i] = -100 // a uniform noise floor: no bin is legitimately zero
		}
		out := unwrap(src)

		zeros := 0
		for _, v := range out {
			if v == 0 {
				zeros++
			}
		}
		if n%2 == 0 && zeros != 0 {
			t.Errorf("even length %d: %d bins left unwritten, want 0", n, zeros)
		}
		if n%2 != 0 && zeros == 0 {
			t.Errorf("odd length %d: expected the unwrap to leave a bin unwritten, "+
				"but it did not -- the even-count guard may no longer be needed", n)
		}
	}
}
