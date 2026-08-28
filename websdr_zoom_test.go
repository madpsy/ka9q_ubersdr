package main

import (
	"bytes"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// The WebSDR waterfall used to come back from a zoom somewhere other than where it went.
//
// Zoom is anchored under the mouse pointer, and the client's offset clamp — as the client
// ships — allows the view to hang half a screen off either edge (websdr-waterfall.js, the
// `H` flag; see websdr_client_patch.go). So a wheel zoom-out left the band wherever the
// pointer happened to be and nothing ever pulled it back: on a 60 MHz receiver, 0 Hz
// stranded mid-screen with negative frequencies to its left, or a right-hand edge reading
// 50 MHz. A different wrong answer each time, because it depended on the mouse.
//
// These tests pin both halves of the fix: the clamp itself, and the fact that every window
// the server will stream is one that exists.

// websdrClientZoom reproduces function w() in websdr-waterfall.js with the pan clamp
// enabled — the arithmetic the browser actually runs on a wheel event. `step` is +1 for
// zoom out and -1 for zoom in, `px` is the pointer's x position on the waterfall.
//
// Modelling it here is the point: the server clamp and the client clamp have to agree, and
// the only way to show that is to run the client's own formula.
func websdrClientZoom(b websdrBand, zoom, start, step, px, wfWidth int) (int, int) {
	anchor := start + px<<uint(b.MaxZoom-zoom)
	zoom = b.ClampZoom(zoom - step)
	visible := wfWidth << uint(b.MaxZoom-zoom)
	start = anchor - px<<uint(b.MaxZoom-zoom)
	limit := (1024 << uint(b.MaxZoom)) - visible
	if start < 0 {
		start = 0
	}
	if start > limit {
		start = limit
	}
	return zoom, start
}

// Zooming all the way back out must show the whole band, wherever the pointer was.
func TestWebSDRZoomOutReturnsToTheWholeBand(t *testing.T) {
	for _, span := range []uint64{30_000_000, 60_000_000} {
		rx := testReceiver(span)
		b := websdrBandFor(rx)

		// Pointer positions across the waterfall, including both edges — the reported
		// symptoms depended entirely on where the mouse was.
		for _, px := range []int{0, 1, 137, 512, 900, 1023, 1024} {
			zoom, start := 0, 0
			for i := 0; i < b.MaxZoom; i++ {
				zoom, start = websdrClientZoom(b, zoom, start, -1, px, 1024)
			}
			if zoom != b.MaxZoom {
				t.Fatalf("span %d px %d: zoomed in to %d, want %d", span, px, zoom, b.MaxZoom)
			}
			for i := 0; i < b.MaxZoom; i++ {
				zoom, start = websdrClientZoom(b, zoom, start, +1, px, 1024)
			}
			if zoom != 0 || start != 0 {
				t.Errorf("span %d px %d: back out at zoom=%d start=%d, want zoom=0 start=0",
					span, px, zoom, start)
			}

			view := websdrViewFor(rx, zoom, start, 1024)
			if view.StartHz != 0 || view.BWHz != float64(span) {
				t.Errorf("span %d px %d: view %.0f Hz wide from %.0f Hz, want 0 Hz + %d Hz",
					span, px, view.BWHz, view.StartHz, span)
			}
		}
	}
}

// Zoom in and straight back out at the same pointer is the exact identity the client's
// anchoring promises. It only holds because the clamp never had to intervene, which is
// worth stating separately from the round trip to zoom 0 above.
func TestWebSDRZoomInThenOutIsAnIdentity(t *testing.T) {
	b := websdrBandFor(testReceiver(60_000_000))
	for _, px := range []int{0, 300, 512, 1023} {
		startZoom, startPix := 4, 700_000
		zoom, start := websdrClientZoom(b, startZoom, startPix, -1, px, 1024)
		zoom, start = websdrClientZoom(b, zoom, start, +1, px, 1024)
		if zoom != startZoom || start != startPix {
			t.Errorf("px %d: round trip landed at zoom=%d start=%d, want zoom=%d start=%d",
				px, zoom, start, startZoom, startPix)
		}
	}
}

// Whatever a client asks for, the window that gets streamed is one the receiver has.
//
// The starts below are the ones that produced the reported symptoms — a full screen off
// the left at zoom 0 is "0 Hz in the middle with negatives to its left" — plus values no
// sane client would send, because setband() in the mobile controls clamps nothing at all.
func TestWebSDRViewAlwaysLiesInsideTheBand(t *testing.T) {
	for _, span := range []uint64{30_000_000, 60_000_000} {
		rx := testReceiver(span)
		b := websdrBandFor(rx)
		grid := b.MaxZoomPixels()

		for zoom := -3; zoom <= b.MaxZoom+3; zoom++ {
			for _, start := range []int{
				-grid, -grid / 2, -grid / 6, -1, 0, 1,
				grid / 3, grid / 2, grid - 1, grid, 2 * grid,
				math.MaxInt32, -math.MaxInt32,
			} {
				view := websdrViewFor(rx, zoom, start, 1024)
				if view.StartHz < 0 {
					t.Errorf("span %d zoom %d start %d: window starts at %.0f Hz",
						span, zoom, start, view.StartHz)
				}
				if end := view.StartHz + view.BWHz; end > float64(span)+1e-6 {
					t.Errorf("span %d zoom %d start %d: window ends at %.0f Hz, band ends at %d",
						span, zoom, start, end, span)
				}
				if view.CentreHz < 0 || view.CentreHz > float64(span) {
					t.Errorf("span %d zoom %d start %d: centre %.0f Hz is outside the band",
						span, zoom, start, view.CentreHz)
				}
				if view.Zoom < 0 || view.Zoom > b.MaxZoom {
					t.Errorf("span %d zoom %d: clamped to %d", span, zoom, view.Zoom)
				}
			}
		}
	}
}

// The specific report, as a test: on a 60 MHz receiver a fully zoomed-out client that has
// scrolled a full screen to the left is shown 0–60 MHz, not −30–+30 MHz.
func TestWebSDRZoomZeroCannotBeScrolledOffTheBand(t *testing.T) {
	rx := testReceiver(60_000_000)
	b := websdrBandFor(rx)

	view := websdrViewFor(rx, 0, -b.MaxZoomPixels()/2, 1024)
	if view.StartHz != 0 || view.CentreHz != 30_000_000 || view.BWHz != 60_000_000 {
		t.Errorf("scrolled-off zoom 0: start %.0f centre %.0f width %.0f, want 0 / 30000000 / 60000000",
			view.StartHz, view.CentreHz, view.BWHz)
	}
	if view.Start != 0 {
		t.Errorf("scrolled-off zoom 0: offset %d, want 0", view.Start)
	}
}

// A narrower waterfall shows proportionally less spectrum, because that is what the client
// draws: one screen pixel is 2^(maxzoom−zoom) grid pixels whatever the screen is. The
// mobile page (websdr/m.html) sizes its waterfall to the device width, so at 1024 the span
// is the whole band and at 512 it is half of it — pinned here because the server used to
// send the full band's worth either way, which stretched a phone's axis by 1024/width.
func TestWebSDRViewSpanFollowsTheWaterfallWidth(t *testing.T) {
	rx := testReceiver(60_000_000)

	full := websdrViewFor(rx, 0, 0, 1024)
	if full.BWHz != 60_000_000 {
		t.Fatalf("1024-wide zoom 0: %.0f Hz, want 60000000", full.BWHz)
	}
	half := websdrViewFor(rx, 0, 0, 512)
	if half.BWHz != 30_000_000 {
		t.Errorf("512-wide zoom 0: %.0f Hz, want 30000000", half.BWHz)
	}
	// And a narrow waterfall can still pan, because the band no longer fits on it.
	b := websdrBandFor(rx)
	if got, want := b.ClampStart(math.MaxInt32, 0, 512), b.MaxZoomPixels()/2; got != want {
		t.Errorf("512-wide zoom 0 pan limit: %d, want %d", got, want)
	}
}

// The bin bandwidth and count the view asks radiod for must describe the view, or the
// waterfall is drawn on the wrong axis however well the offset is clamped.
func TestWebSDRViewRequestCoversTheView(t *testing.T) {
	rx := testReceiver(60_000_000)
	b := websdrBandFor(rx)

	for zoom := 0; zoom <= b.MaxZoom; zoom++ {
		view := websdrViewFor(rx, zoom, b.MaxZoomPixels()/3, 1024)
		if view.Req.DisplayBins != view.Width {
			t.Errorf("zoom %d: %d display bins for a %d pixel waterfall",
				zoom, view.Req.DisplayBins, view.Width)
		}
		if got := view.Req.DisplayBinBW * float64(view.Req.DisplayBins); math.Abs(got-view.BWHz) > 1e-6 {
			t.Errorf("zoom %d: display grid spans %.3f Hz, view is %.3f Hz", zoom, got, view.BWHz)
		}
	}
}

// The client's pan clamp has to actually be switched on in what we serve.
func TestWebSDRWaterfallJSPanClampIsEnabled(t *testing.T) {
	raw, err := os.ReadFile("websdr/websdr-waterfall.js")
	if err != nil {
		t.Skipf("vendored client not present: %v", err)
	}
	patched, missed := websdrPatchWaterfallJS(raw)
	if len(missed) > 0 {
		t.Fatalf("websdr-waterfall.js no longer matches %v — zoom and pan can leave the "+
			"band again; re-derive the substitutions against the vendored client", missed)
	}
	for _, p := range websdrWaterfallJSPatches {
		if bytes.Contains(patched, p.from) {
			t.Errorf("patched client still carries the unpatched form of: %s", p.why)
		}
		if !bytes.Contains(patched, p.to) {
			t.Errorf("patched client is missing: %s", p.why)
		}
	}
}

// And it has to be the patched copy that reaches the browser, not the file on disk.
func TestWebSDRServesThePatchedWaterfallJS(t *testing.T) {
	if _, err := os.Stat("websdr/websdr-waterfall.js"); err != nil {
		t.Skipf("vendored client not present: %v", err)
	}
	h := &WebSDRHandler{
		sessions: &SessionManager{},
		config:   &Config{},
		chseq:    newWebSDRChseq(),
		chat:     &websdrChatStore{},
	}
	h.config.Receiver = testReceiver(60_000_000)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/websdr-waterfall.js", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /websdr-waterfall.js: %d", rec.Code)
	}
	for _, p := range websdrWaterfallJSPatches {
		if !bytes.Contains(rec.Body.Bytes(), p.to) {
			t.Errorf("served client is missing: %s", p.why)
		}
	}
	// Browsers are holding the unpatched copy; without revalidation they keep it.
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control: %q, want no-cache", cc)
	}
	if rec.Header().Get("ETag") == "" {
		t.Error("no ETag, so every load re-sends the whole file")
	}
}
