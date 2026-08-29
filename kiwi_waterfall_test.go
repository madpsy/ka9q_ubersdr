package main

import (
	"math"
	"testing"
)

// kiwiTestSamprate is the front end these tests cost the wideband path against.
// Which path a zoom lands on depends on it: wideband cost is samprate/bin_bw and
// narrowband cost is not, so a wider front end pushes more zooms onto the
// downconverter. 129.6 Msps is the receiver this was measured on.
const kiwiTestSamprate = 129_600_000

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
		req := kiwiSpectrumParams(zoom, kiwiTestSamprate)
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
		req := kiwiSpectrumParams(zoom, kiwiTestSamprate)
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

// The shallow zooms stay on the wideband path at exactly the bandwidth the client's
// axis assumes, so the resample is a no-op there and nothing regressed.
//
// It stops at 3 because from 4 down the downconverter is measurably cheaper and the
// levels deliberately move onto it -- see TestKiwiDeepZoomsUseTheDownconverter. Where
// that boundary falls depends on the front end: wideband cost is samprate/bin_bw and
// narrowband cost is not, so a wider receiver pushes more zooms across.
func TestKiwiSpectrumParamsPreservesShallowZoom(t *testing.T) {
	for zoom := 0; zoom <= 3; zoom++ {
		req := kiwiSpectrumParams(zoom, kiwiTestSamprate)
		want := kiwiFullSpanHz / math.Pow(2, float64(zoom)) / kiwiWaterfallBins

		if math.Abs(req.BinBandwidth-want) > 0.0001 {
			t.Errorf("zoom %d: bin_bw %.6f, want the exact %.6f it has always requested",
				zoom, req.BinBandwidth, want)
		}
		if req.BinCount != kiwiWaterfallBins {
			t.Errorf("zoom %d: bin count %d, want %d", zoom, req.BinCount, kiwiWaterfallBins)
		}
		if req.Crossover != 0 {
			t.Errorf("zoom %d: crossover %v, want 0 -- these levels must stay wideband",
				zoom, req.Crossover)
		}
	}
}

// The levels that used to sit on the wideband path transforming the whole front end
// to deliver 1,024 bins of it. Zoom 7 was the worst: 566,231 points for a 234 kHz
// view, measured at 95% of a core on a 129.6 Msps receiver.
func TestKiwiDeepZoomsUseTheDownconverter(t *testing.T) {
	for zoom := 4; zoom <= kiwiMaxZoom; zoom++ {
		req := kiwiSpectrumParams(zoom, kiwiTestSamprate)
		if req.BinBandwidth > req.Crossover {
			t.Errorf("zoom %d: %v Hz/bin against crossover %v -- still on the wideband path",
				zoom, req.BinBandwidth, req.Crossover)
		}
		// Never softer than the grid the client draws.
		if req.BinBandwidth > req.DisplayBinBW {
			t.Errorf("zoom %d: serving %v Hz/bin for a %v Hz display grid",
				zoom, req.BinBandwidth, req.DisplayBinBW)
		}
		// And the downconverter is not paying for span the client never sees.
		if over := float64(req.BinCount)*req.BinBandwidth - req.DisplaySpanHz(); over > 2*req.BinBandwidth {
			t.Errorf("zoom %d: delivers %.0f Hz beyond the view", zoom, over)
		}
	}
}

// Where the two paths swap is a cost boundary, not a fixed bin bandwidth, and it
// moves with the front end: wideband cost is samprate/bin_bw and narrowband cost is
// the span, so doubling the sample rate pushes another zoom onto the downconverter.
//
// This is the property a fixed threshold got wrong -- it would have put a 64.8 Msps
// receiver's zoom 4 on the downconverter, where the wideband FFT is cheaper.
func TestKiwiCrossoverBoundaryFollowsTheSampleRate(t *testing.T) {
	boundary := func(samprate int) int {
		for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
			if req := kiwiSpectrumParams(zoom, samprate); req.Crossover != 0 {
				return zoom
			}
		}
		return -1
	}
	wide, narrow := boundary(129_600_000), boundary(64_800_000)
	if wide < 0 || narrow < 0 {
		t.Fatalf("no zoom uses the downconverter (129.6: %d, 64.8: %d)", wide, narrow)
	}
	if wide >= narrow {
		t.Errorf("boundary at zoom %d on 129.6 Msps and %d on 64.8 Msps: a wider front end "+
			"makes the wideband path dearer, so it must cross sooner, not later", wide, narrow)
	}
	// Every zoom from the boundary down stays on the downconverter; the choice must
	// be monotonic or the waterfall would flip paths as you zoom.
	for _, sr := range []int{129_600_000, 64_800_000} {
		seen := false
		for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
			narrowband := kiwiSpectrumParams(zoom, sr).Crossover != 0
			if seen && !narrowband {
				t.Errorf("%d Msps: zoom %d went back to the wideband path", sr/1_000_000, zoom)
			}
			seen = seen || narrowband
		}
	}
}

func TestKiwiSpectrumParamsClampsZoom(t *testing.T) {
	if got, want := kiwiSpectrumParams(-3, kiwiTestSamprate), kiwiSpectrumParams(0, kiwiTestSamprate); got != want {
		t.Errorf("negative zoom = %+v, want it clamped to zoom 0 (%+v)", got, want)
	}
	if got, want := kiwiSpectrumParams(99, kiwiTestSamprate), kiwiSpectrumParams(kiwiMaxZoom, kiwiTestSamprate); got != want {
		t.Errorf("zoom 99 = %+v, want it clamped to zoom %d (%+v)", got, kiwiMaxZoom, want)
	}
}

// A pass-through must be exactly that: the shallow zooms deliver the display grid
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
	req := kiwiSpectrumParams(8, kiwiTestSamprate)
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
	req := kiwiSpectrumParams(9, kiwiTestSamprate)
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
// The bin count used to be pinned at 1024 because radiod sized a channel's bin_data
// once and raising it overran a heap block. ubersdr-radiod
// patches/0002-spectrum-bin-data-resize.patch fixes that, so the count now follows
// the view -- but two properties still bind.
func TestKiwiSpectrumParamsBinCountIsServable(t *testing.T) {
	for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
		req := kiwiSpectrumParams(zoom, kiwiTestSamprate)
		// Even: radiod returns raw FFT order and the unwrap swaps two halves, so
		// an odd count leaves a bin unwritten.
		if req.BinCount%2 != 0 {
			t.Errorf("zoom %d: bin count %d is odd; the half-swap unwrap would drop a bin",
				zoom, req.BinCount)
		}
		// And no more than one datagram carries.
		if req.BinCount > maxSpectrumBins {
			t.Errorf("zoom %d: bin count %d is more than one datagram carries (%d)",
				zoom, req.BinCount, maxSpectrumBins)
		}
		// The delivered span must still cover what the client draws.
		if delivered, display := float64(req.BinCount)*req.BinBandwidth, req.DisplaySpanHz(); delivered < display-1 {
			t.Errorf("zoom %d: delivers %.0f Hz for a %.0f Hz view", zoom, delivered, display)
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
