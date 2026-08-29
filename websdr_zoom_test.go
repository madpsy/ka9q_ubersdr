package main

import (
	"bytes"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
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

// ── Waterfall rate ───────────────────────────────────────────────────────────
//
// The client's speed selector was parsed into wfSlow and read by nothing, so
// every WebSDR client polled radiod at full rate however slow a waterfall it
// asked for -- and each poll is a whole spectrum response, which above radiod's
// crossover is an FFT over the entire front end.

// waterparamConn is the least applyWaterparamCommand needs: a session to carry
// the divisor, and a handler for the view rebuild a zoom or pan triggers. The
// session ID is left empty so the retune, which would need a live radiod, is
// skipped.
func waterparamConn() *websdrConn {
	h := &WebSDRHandler{sessions: &SessionManager{}, config: &Config{}}
	h.config.Receiver = testReceiver(60_000_000)
	return &websdrConn{
		handler:     h,
		session:     &Session{IsSpectrum: true},
		wfWidth:     1024,
		wfSlow:      4,
		wfFormat:    9,
		wfState:     NewWebSDRWaterfallState(9),
		wfViewValid: false,
	}
}

func TestWebSDRSpeedSetsThePollDivisor(t *testing.T) {
	// speed n means slow = 4/n: the client's fastest setting polls at full rate,
	// its slowest at a quarter.
	// The operator's base rate is the "fast" setting; the selector multiplies it.
	// Expectations are written as base x slow so the composition is the assertion.
	const base = defaultEmulationPollDivisor
	tests := []struct {
		cmd  string
		want int32
	}{
		{"/~~waterparam?speed=1", base * 4},
		{"/~~waterparam?speed=2", base * 2},
		{"/~~waterparam?speed=3", base * 1}, // 4/3 truncates
		{"/~~waterparam?speed=4", base * 1},
		{"/~~waterparam?slow=1", base * 1},
		{"/~~waterparam?slow=3", base * 3},
		{"/~~waterparam?slow=8", base * 8},
	}
	for _, tc := range tests {
		c := waterparamConn()
		c.applyWaterparamCommand(tc.cmd)
		if got := c.session.PollDivisor.Load(); got != tc.want {
			t.Errorf("%s: poll divisor %d, want %d", tc.cmd, got, tc.want)
		}
	}
}

// The keepalive rides on the poll, so the divisor may not run away: radiod
// reaps a spectrum channel spectrumLifetimeFrames after its last command.
func TestWebSDRPollDivisorIsBounded(t *testing.T) {
	for _, cmd := range []string{"/~~waterparam?slow=9", "/~~waterparam?slow=1000"} {
		c := waterparamConn()
		c.applyWaterparamCommand(cmd)
		if got, want := c.session.PollDivisor.Load(), int32(defaultEmulationPollDivisor*websdrMaxPollDivisor); got != want {
			t.Errorf("%s: poll divisor %d, want the client's share clamped to %d (x base = %d)",
				cmd, got, websdrMaxPollDivisor, want)
		}
	}

	// And the product is bounded against the real tick, not just the client's half:
	// a slow client on a receiver with a long tick must still poll inside the
	// channel lifetime, or the waterfall stops.
	for _, tick := range []int{10, 75, 100, 250} {
		d := spectrumPollDivisor(defaultEmulationPollDivisor*websdrMaxPollDivisor, tick)
		if period := d * tick; period*2 > spectrumLifetimeFrames*20 {
			t.Errorf("tick %d ms: slowest poll %d ms is not inside half the %d ms lifetime",
				tick, period, spectrumLifetimeFrames*20)
		}
	}

	// The bound has to leave the keepalive room at the configured poll period.
	// 250 blocks x 20 ms is 5 s; the slowest poll must be well inside that.
	slowestPoll := time.Duration(websdrMaxPollDivisor) * 250 * time.Millisecond // the largest PollPeriodMs LoadConfig allows
	lifetime := time.Duration(spectrumLifetimeFrames) * 20 * time.Millisecond
	if slowestPoll >= lifetime {
		t.Errorf("slowest poll %v is not inside the %v channel lifetime -- the channel would reap itself between polls",
			slowestPoll, lifetime)
	}
}

// A client that never asks keeps the rate it has today. This honours the
// parsed value; it does not impose one. Both exit paths: a zoom rebuilds the
// view, a scale change returns early, and neither may invent a rate.
func TestWebSDRPollDivisorUntouchedWithoutASpeed(t *testing.T) {
	for _, cmd := range []string{
		"/~~waterparam?zoom=8",
		"/~~waterparam?start=488735",
		"/~~waterparam?scale=1",
		"/~~waterparam?speed=0", // 0 is not a rate; ignored, as it always was
	} {
		c := waterparamConn()
		if got := c.session.PollDivisor.Load(); got != 0 {
			t.Fatalf("%s: divisor started at %d, want the 0 zero value", cmd, got)
		}
		c.applyWaterparamCommand(cmd)
		if got := c.session.PollDivisor.Load(); got != 0 {
			t.Errorf("%s: poll divisor %d, want it left at 0 (full rate)", cmd, got)
		}
	}
}

// wfSlow persists across commands, so a later command that carries no speed
// must not reset the rate the client chose earlier.
func TestWebSDRPollDivisorSurvivesLaterCommands(t *testing.T) {
	c := waterparamConn()
	const want = defaultEmulationPollDivisor * 4
	c.applyWaterparamCommand("/~~waterparam?slow=4")
	if got := c.session.PollDivisor.Load(); got != want {
		t.Fatalf("poll divisor %d after slow=4, want %d", got, want)
	}
	c.applyWaterparamCommand("/~~waterparam?scale=2")
	if got := c.session.PollDivisor.Load(); got != want {
		t.Errorf("poll divisor %d after a command with no speed, want %d kept", got, want)
	}
}

// A zoom that carries a speed takes the other exit -- the one that rebuilds the
// view and retunes radiod -- and must apply the rate there too. This is the
// common case: the real client sends its whole parameter set on every zoom.
func TestWebSDRPollDivisorAppliesOnAZoom(t *testing.T) {
	c := waterparamConn()
	c.applyWaterparamCommand("/~~waterparam?zoom=8&start=488735&width=1024&speed=1")
	if got, want := c.session.PollDivisor.Load(), int32(defaultEmulationPollDivisor*4); got != want {
		t.Errorf("poll divisor %d after a zoom carrying speed=1, want %d", got, want)
	}
	if c.wfZoom != 8 {
		t.Errorf("zoom %d, want 8 -- the rate must not have swallowed the view change", c.wfZoom)
	}
}

// The Speed selector and the waterfall script both carry the default rate, and a
// mismatch is invisible until someone notices the dropdown says one thing and the
// waterfall does another. Both are patched, so both are checked.
func TestWebSDRControlsDefaultToFast(t *testing.T) {
	raw, err := os.ReadFile("websdr/websdr-controls.html")
	if err != nil {
		t.Skipf("vendored client not present: %v", err)
	}
	patched, missed := websdrPatchControlsHTML(raw)
	if len(missed) > 0 {
		t.Fatalf("websdr-controls.html no longer matches %v — re-derive against the vendored client", missed)
	}
	if !bytes.Contains(patched, []byte(`<option value="1" selected>fast</option>`)) {
		t.Error("fast is not the selected Speed option")
	}
	// Exactly one option inside THIS select may be marked, or the browser picks the
	// last one and the patch silently stops meaning anything. Scoped to the speed
	// control: the page has other selects with their own selected options.
	i := bytes.Index(patched, []byte(`id="wfspeed"`))
	if i < 0 {
		t.Fatal(`no id="wfspeed" select in websdr-controls.html`)
	}
	j := bytes.Index(patched[i:], []byte("</select>"))
	if j < 0 {
		t.Fatal("unterminated wfspeed select")
	}
	if n := bytes.Count(patched[i:i+j], []byte(" selected")); n != 1 {
		t.Errorf("%d selected options in the Speed selector, want exactly 1", n)
	}
}

// All three places that carry the waterfall rate must agree, because they are not
// equivalent and the one that wins is not the one that acts first: the applet's b.A
// governs at page load, and websdr-base.js's waterslowness takes over on the first
// zoom. Patching a subset is what made the waterfall fast until you touched it.
func TestWebSDRWaterfallRateDefaultsAgreeAcrossAllThreeFiles(t *testing.T) {
	read := func(name string) []byte {
		b, err := os.ReadFile("websdr/" + name)
		if err != nil {
			t.Skipf("vendored client not present: %v", err)
		}
		return b
	}
	baseJS, missed := websdrPatchBaseJS(read("websdr-base.js"))
	if len(missed) > 0 {
		t.Fatalf("websdr-base.js no longer matches %v — the waterfall would go slow on the first zoom", missed)
	}
	if !bytes.Contains(baseJS, []byte("var waterslowness=1;")) {
		t.Error("websdr-base.js does not default the page's waterfall rate to fast")
	}
	// The applet's own initial rate, which governs before base.js speaks.
	wfJS, _ := websdrPatchWaterfallJS(read("websdr-waterfall.js"))
	if !bytes.Contains(wfJS, []byte(";b.A=1;")) {
		t.Error("websdr-waterfall.js does not start the applet at the fast rate")
	}
	// And the selector has to show what the other two are doing.
	html, _ := websdrPatchControlsHTML(read("websdr-controls.html"))
	if !bytes.Contains(html, []byte(`<option value="1" selected>fast</option>`)) {
		t.Error("the Speed selector does not show fast")
	}
}

// value="1" is what the selector sends, and 1 is what the script must start at:
// the two are the same number in two files, which is exactly how they drift.
func TestWebSDRWaterfallScriptStartsAtTheSelectedSpeed(t *testing.T) {
	js, err := os.ReadFile("websdr/websdr-waterfall.js")
	if err != nil {
		t.Skipf("vendored client not present: %v", err)
	}
	patchedJS, missed := websdrPatchWaterfallJS(js)
	if len(missed) > 0 {
		t.Fatalf("websdr-waterfall.js no longer matches %v", missed)
	}
	html, _ := os.ReadFile("websdr/websdr-controls.html")
	patchedHTML, _ := websdrPatchControlsHTML(html)

	// Whatever the dropdown marks selected has to be the script's initial b.A.
	var want []byte
	for _, v := range [][]byte{[]byte(`"1"`), []byte(`"2"`), []byte(`"4"`)} {
		if bytes.Contains(patchedHTML, append(append([]byte(`<option value=`), v...), []byte(" selected>")...)) {
			want = bytes.Trim(v, `"`)
		}
	}
	if want == nil {
		t.Fatal("no Speed option is marked selected")
	}
	init := append(append([]byte(";b.A="), want...), ';')
	if !bytes.Contains(patchedJS, init) {
		t.Errorf("script does not start at the selected speed: want %q in the patched client", init)
	}
}

// "fast" is the operator's configured rate, not the full tick. A WebSDR client can
// only ever slow itself below what websdr_spectrum_divisor allows -- every poll
// is a whole spectrum response, so letting a client raise its own rate would put the
// receiver's CPU in the client's hands.
func TestWebSDRFastSpeedIsTheConfiguredRate(t *testing.T) {
	for _, cmd := range []string{
		"/~~waterparam?speed=4", // the selector's "fast" sends slow=1
		"/~~waterparam?slow=1",
	} {
		c := waterparamConn()
		c.applyWaterparamCommand(cmd)
		if got := c.session.PollDivisor.Load(); got != defaultEmulationPollDivisor {
			t.Errorf("%s: poll divisor %d, want the configured base %d",
				cmd, got, defaultEmulationPollDivisor)
		}
	}
}

// An operator setting must be honoured, not just the built-in default.
func TestWebSDRPollDivisorHonoursTheConfiguredBase(t *testing.T) {
	c := waterparamConn()
	c.handler.config.Server.WebSDRSpectrumDivisor = 3
	c.applyWaterparamCommand("/~~waterparam?slow=2")
	if got := c.session.PollDivisor.Load(); got != 6 {
		t.Errorf("base 3 x slow 2: poll divisor %d, want 6", got)
	}
}

// The row rate the client sees is the poll tick times its own Speed setting, not the
// rate radiod is polled at. The operator's divisor thins the polling and the gap is
// filled by repeating the last row, so a "fast" waterfall scrolls at a real WebSDR's
// pace without radiod producing a spectrum response for every row.
func TestWebSDRRowIntervalIgnoresTheOperatorsThinning(t *testing.T) {
	c := waterparamConn()
	c.handler.config.Spectrum.PollPeriodMs = 100

	for _, tc := range []struct {
		divisor int
		slow    int
		wantMs  int
		wantFil int
	}{
		{divisor: 1, slow: 1, wantMs: 100, wantFil: 1}, // no thinning, no filling
		{divisor: 2, slow: 1, wantMs: 100, wantFil: 2}, // fast: polled 200ms, drawn 100ms
		{divisor: 2, slow: 2, wantMs: 200, wantFil: 2}, // medium: the client asked to halve it
		{divisor: 2, slow: 4, wantMs: 400, wantFil: 2}, // slow: and to quarter it
		{divisor: 4, slow: 1, wantMs: 100, wantFil: 4},
	} {
		c.handler.config.Server.WebSDRSpectrumDivisor = tc.divisor
		c.mu.Lock()
		c.wfSlow = tc.slow
		c.mu.Unlock()

		if got := c.rowInterval(); got != time.Duration(tc.wantMs)*time.Millisecond {
			t.Errorf("divisor %d slow %d: row interval %v, want %dms",
				tc.divisor, tc.slow, got, tc.wantMs)
		}
		if got := c.pollFillFactor(); got != tc.wantFil {
			t.Errorf("divisor %d slow %d: fill factor %d, want %d",
				tc.divisor, tc.slow, got, tc.wantFil)
		}
		// The client's Speed setting must never be filled back in: someone who
		// picked "slow" asked for a slow waterfall.
		if tc.slow > 1 && c.rowInterval() <= time.Duration(tc.wantMs/tc.slow)*time.Millisecond {
			t.Errorf("slow %d: the client's own thinning was filled in too", tc.slow)
		}
	}
}
