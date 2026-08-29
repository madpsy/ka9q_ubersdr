package main

// websdr_scale.go — dynamic frequency-scale PNG tile generator for /~~scale
//
// The WebSDR frontend displays a 1024-pixel-wide frequency scale bar above
// each waterfall.  The bar is rendered by two <img> elements whose src is
// set to e.scaleimgs[zoom][tileIndex].  Each tile is a 1024×14 PNG showing
// frequency tick marks and labels for the portion of the band it covers.
//
// Tile geometry, for a band of width W kHz starting at S kHz (see websdrBandFor):
//
//	tileWidthKHz[zoom] = W / (1 << zoom)
//	tileStartKHz       = S + tile * tileWidthKHz
//	pixelsPerKHz       = 1024 / tileWidthKHz
//
// Label step is chosen so that labels are at least ~60 px apart.

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"strconv"
)

// ─────────────────────────────────────────────────────────────────────────────
// Tiny 5×7 pixel font — digits 0-9, letters M k H z . space
// Each glyph is 5 columns × 7 rows; bit 4 of each byte = leftmost pixel.
// ─────────────────────────────────────────────────────────────────────────────

type glyph [7]uint8 // 7 rows, 5 bits each (MSB = left)

var pixFont = map[rune]glyph{
	'0': {0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110},
	'1': {0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110},
	'2': {0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111},
	'3': {0b11111, 0b00010, 0b00100, 0b00110, 0b00001, 0b10001, 0b01110},
	'4': {0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010},
	'5': {0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110},
	'6': {0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110},
	'7': {0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000},
	'8': {0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110},
	'9': {0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100},
	'.': {0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100},
	'M': {0b10001, 0b11011, 0b10101, 0b10001, 0b10001, 0b10001, 0b10001},
	'H': {0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001},
	'z': {0b00000, 0b00000, 0b11111, 0b00010, 0b00100, 0b01000, 0b11111},
	'k': {0b10000, 0b10000, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010},
	' ': {0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000},
}

// glyphWidth returns the pixel width of a glyph (5) plus 1 px spacing.
const glyphW = 6

// drawText draws s into img starting at (x, y) in white.
// Returns the x position after the last character.
func drawText(img *image.RGBA, x, y int, s string) int {
	white := color.RGBA{R: 255, G: 255, B: 255, A: 255}
	for _, ch := range s {
		g, ok := pixFont[ch]
		if !ok {
			x += glyphW
			continue
		}
		for row := 0; row < 7; row++ {
			bits := g[row]
			for col := 0; col < 5; col++ {
				if bits&(1<<uint(4-col)) != 0 {
					img.SetRGBA(x+col, y+row, white)
				}
			}
		}
		x += glyphW
	}
	return x
}

// textWidth returns the pixel width of string s.
func textWidth(s string) int { return len([]rune(s)) * glyphW }

// ─────────────────────────────────────────────────────────────────────────────
// Label formatting
// ─────────────────────────────────────────────────────────────────────────────

// formatFreqLabel formats a frequency in kHz as a short label.
// ≥ 1000 kHz → "X.XXX MHz" style; < 1000 kHz → "XXX kHz".
func formatFreqLabel(kHz float64) string {
	if kHz >= 1000 {
		mhz := kHz / 1000.0
		// Trim trailing zeros after decimal point, keep at most 3 dp.
		s := strconv.FormatFloat(mhz, 'f', 3, 64)
		// Remove trailing zeros
		for len(s) > 1 && s[len(s)-1] == '0' {
			s = s[:len(s)-1]
		}
		if s[len(s)-1] == '.' {
			s = s[:len(s)-1]
		}
		return s + "M"
	}
	return strconv.FormatFloat(kHz, 'f', 0, 64) + "k"
}

// ─────────────────────────────────────────────────────────────────────────────
// Label step selection
// ─────────────────────────────────────────────────────────────────────────────

// niceSteps are candidate label spacings in kHz, from finest to coarsest.
var niceSteps = []float64{
	1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
}

// chooseLabelStep picks the finest step that still places labels at least
// minPxApart pixels apart given pixelsPerKHz.  Iterating from finest to
// coarsest, we return the first step where step*pixelsPerKHz >= minPxApart.
// This guarantees the maximum label density without crowding.
func chooseLabelStep(pixelsPerKHz, minPxApart float64) float64 {
	for _, s := range niceSteps {
		if s*pixelsPerKHz >= minPxApart {
			return s
		}
	}
	return niceSteps[len(niceSteps)-1]
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale PNG handler
// ─────────────────────────────────────────────────────────────────────────────

const (
	scaleImgW = 1024
	scaleImgH = 14
)

// websdrBand is the single band the emulation advertises, and the one description of it
// that bandinfo.js, the scale tiles, the waterfall geometry and the tune clamp all share.
//
// Unlike the KiwiSDR emulation, this one is not pinned to 30 MHz. A WebSDR client builds
// its entire frequency axis from bandinfo[] — `khzperpixel = samplerate/1024` and
// `centerfreq` in websdr-base.js — and takes maxzoom from the same place, so telling it a
// wider band is all that is needed. (The Kiwi client computes 30 MHz / 2^zoom itself, with
// no field to override; that is why the two are treated differently. See RECEIVER_SPAN.md.)
//
// These used to be four sets of constants in three files kept in step by a comment saying
// they "MUST match". They are one struct now because that comment was the only thing
// enforcing it.
type websdrBand struct {
	StartHz float64
	EndHz   float64
	MaxZoom int
}

// websdrBaseMaxZoom is the deepest zoom on a 30 MHz receiver: 1024x, showing ~29 kHz.
//
// It was 8 (~117 kHz) while the waterfall path believed radiod could not serve better
// than 500 Hz per bin. It can — 0.5 Hz, via radiodBinBandwidthLadder — so resolution is
// no longer what bounds this. What bounds it now is bandinfo.js, which carries
// 2^(MaxZoom+1)-1 scale-tile URLs and is served no-cache, so every level doubles what is
// re-fetched on each page load:
//
//	 8  ~117 kHz    511 tiles   ~18 KB
//	10   ~29 kHz   2047 tiles   ~72 KB   <- here
//	12    ~7 kHz   8191 tiles  ~288 KB
//
// 10 buys four times the depth of the old limit for a page-weight cost that is still
// small. Going deeper is a page-weight decision, not a signal-processing one.
const websdrBaseMaxZoom = 10

// websdrMaxZoomCap bounds the growth below, at ~288 KB of tile URLs.
const websdrMaxZoomCap = 12

// websdrBandFor describes the band for a receiver.
//
// MaxZoom grows with the span so the deepest zoom always shows about the same width of
// spectrum: websdrBaseMaxZoom on a 30 MHz receiver, one more on a 60 MHz one. Without
// that a wider receiver would silently lose half its zoom depth.
func websdrBandFor(rx ReceiverConfig) websdrBand {
	b := websdrBand{
		// From 0 Hz, not from the tuning minimum.
		//
		// This is the band the *waterfall* draws, and it has to be exactly the span the
		// shared spectrum channel covers or zoom 0 cannot use it. It used to start at
		// 10 kHz, which put the centre at 15.005 MHz against the shared channel's
		// 15.000 and the bin width at 29287.11 Hz against 29296.875 — near enough to
		// look right on screen, different enough that isAtDefaultSpectrumParams refused
		// the match, so every WebSDR viewer opened a private radiod channel to be shown
		// the same 0-30 MHz everyone else was already receiving.
		//
		// Tuning is bounded separately, by Receiver.MinFreq()/MaxFreq(), which is where
		// the 10 kHz floor belongs: a waterfall showing down to DC is ordinary, and the
		// client still cannot tune there.
		StartHz: 0,
		EndHz:   float64(rx.Span()),
		MaxZoom: websdrBaseMaxZoom,
	}
	for span := b.WidthHz(); span > receiverTodaySpanHz && b.MaxZoom < websdrMaxZoomCap; span /= 2 {
		b.MaxZoom++
	}
	return b
}

// WidthHz is the band's width — `samplerate` in bandinfo, once converted to kHz.
func (b websdrBand) WidthHz() float64 {
	w := b.EndHz - b.StartHz
	if w <= 0 {
		return 192000 // a degenerate band would divide by zero downstream
	}
	return w
}

// CentreHz is the midpoint the client hangs its axis on.
func (b websdrBand) CentreHz() float64 { return b.StartHz + b.WidthHz()/2 }

// MaxZoomPixels is the width of the maxzoom pixel grid the client sends `start` offsets in.
func (b websdrBand) MaxZoomPixels() int { return scaleImgW << uint(b.MaxZoom) }

// ClampZoom pins a zoom level to the range the band advertises in bandinfo.js.
func (b websdrBand) ClampZoom(zoom int) int {
	if zoom < 0 {
		return 0
	}
	if zoom > b.MaxZoom {
		return b.MaxZoom
	}
	return zoom
}

// ClampWidth pins a waterfall width to the range the row encoder can carry.
func (b websdrBand) ClampWidth(wfWidth int) int {
	if wfWidth < 1 || wfWidth > scaleImgW {
		return scaleImgW
	}
	return wfWidth
}

// VisiblePixels is the width of the window on screen, measured in maxzoom-grid pixels.
//
// One screen pixel at zoom z covers 2^(maxzoom-z) grid pixels, so a waterfall wfWidth
// screen pixels wide shows wfWidth<<(maxzoom-z) of them — the whole band at zoom 0 only
// when wfWidth is the full 1024. websdr/m.html sizes its waterfall to the device width
// and builds its axis from that number, so the span has to come from the same place
// rather than from a hardcoded 1024, or a phone is shown the wrong width of spectrum.
func (b websdrBand) VisiblePixels(zoom, wfWidth int) int {
	return b.ClampWidth(wfWidth) << uint(b.MaxZoom-b.ClampZoom(zoom))
}

// ClampStart pins a maxzoom-grid start offset so the visible window lies wholly inside
// the band.
//
// This is the clamp the WebSDR client itself applies when its `H` flag is set, and the
// reason it matters is that the shipped flag is 0, which instead lets the view hang half
// a screen off either edge (websdr-waterfall.js, functions N/w) — and `setband`/`setzoom`
// bound the offset not at all. At zoom 0 on a 60 MHz receiver that admits any start in
// ±30 MHz, so a wheel zoom-out anchored under the pointer leaves the band wherever the
// pointer happened to be: 0 Hz in the middle of the screen with negative frequencies to
// its left, or a right-hand edge reading 50 MHz on a 60 MHz receiver.
//
// The server clamps as well as the client because the client is not the only one: an old
// cached page, the mobile controls' setband path, or anything else speaking the protocol
// can still ask for a window that is not there. Whatever asks, the answer is the window
// that exists, echoed back in init frame 1 so the client can put the row where it belongs.
func (b websdrBand) ClampStart(start, zoom, wfWidth int) int {
	limit := b.MaxZoomPixels() - b.VisiblePixels(zoom, wfWidth)
	if limit < 0 {
		limit = 0
	}
	if start < 0 {
		return 0
	}
	if start > limit {
		return limit
	}
	return start
}

// websdrView is one waterfall window: what the client is drawing, and what radiod has to
// be asked for to fill it. Every field is derived from the clamped (zoom, start, width),
// so a view is in-band by construction and the centre needs no clamp of its own.
type websdrView struct {
	Zoom     int // clamped to [0, MaxZoom]
	Start    int // maxzoom-grid pixels from the band's left edge, clamped into the band
	Width    int // waterfall width in screen pixels
	StartHz  float64
	BWHz     float64
	CentreHz float64
	Req      websdrSpectrumRequest
}

// websdrViewFor builds the view for a client's requested zoom, start and width.
func websdrViewFor(rx ReceiverConfig, zoom, start, wfWidth int) websdrView {
	b := websdrBandFor(rx)

	v := websdrView{}
	v.Zoom = b.ClampZoom(zoom)
	v.Width = b.ClampWidth(wfWidth)
	v.Start = b.ClampStart(start, v.Zoom, v.Width)

	// The band and the grid are two ways of measuring the same axis; one conversion
	// factor keeps the window, the centre and the scale tiles on it.
	hzPerGridPixel := b.WidthHz() / float64(b.MaxZoomPixels())
	v.StartHz = b.StartHz + float64(v.Start)*hzPerGridPixel
	v.BWHz = float64(b.VisiblePixels(v.Zoom, v.Width)) * hzPerGridPixel
	v.CentreHz = v.StartHz + v.BWHz/2

	v.Req = websdrSpectrumParams(v.BWHz, v.Width, rx.Samprate())
	return v
}

// websdrMaxWidebandFFT bounds the FFT length radiod is asked for on its wideband path.
//
// radiod has two spectrum algorithms and the requested bin bandwidth picks between them:
//
//	rbw >  crossover (200 Hz)  ->  wideband, fft_n = samprate / rbw
//	rbw <= crossover           ->  narrowband downconverter, fft_n ~ bin_count + 400/rbw
//
// The narrowband path is cheap at any depth. The wideband one is not: setup_wideband
// takes fft_n = lrint(samprate/rbw) with no ceiling -- its own comment says "should limit
// to a sane value" and then does not -- so halving the bandwidth doubles the transform.
//
// That is why the old code reduced bin_count at deep zoom, and it was right to, even
// though the 500 Hz figure it used to decide when was not radiod's floor. Asking for the
// full display width at zoom 6-7 would put fft_n at 142k and 283k points against today's
// 71k: two and four times the work, on the one path that will not push back.
//
// 2^17 permits exactly what a full-width zoom 5 already costs, so the zooms that were
// affordable before stay affordable, and the arithmetic follows the sample rate rather
// than a constant tuned for 64.8 Msps.
const websdrMaxWidebandFFT = 1 << 17

// websdrSpectrumRequest is what to ask radiod for at a zoom level, paired with the grid
// the client is going to draw. They differ whenever the cheap request is not the exact
// one; streamWaterfall resamples between them.
type websdrSpectrumRequest struct {
	BinBandwidth float64 // Hz per bin to request from radiod
	BinCount     int     // bins to request
	DisplayBinBW float64 // Hz per bin the client's axis assumes
	DisplayBins  int     // the client's pixel width

	// Crossover is radiod's CROSSOVER for this request: the bin bandwidth above
	// which it uses the wideband algorithm. Sent explicitly rather than left at
	// radiod's 200 Hz default so which path it takes is our decision and not a
	// coincidence of where the bin bandwidth landed. BinBandwidth for a
	// narrowband request (radiod tests rbw > crossover, so equal is narrowband);
	// 0 for a wideband one, which nothing can be at or below.
	Crossover float64
}

// websdrSpectrumParams chooses radiod parameters for a view.
//
// Narrowband wherever it is the cheaper path, which is most of the ladder: its cost is the
// span the client is looking at, while the wideband path's is set by the front end and is
// the same whether the view is 30 MHz or 30 kHz. See websdrNarrowbandMaxBinBW for the
// measurements behind that, and radiodNarrowbandFor for the geometry.
//
// Otherwise wideband, where the only lever is the bin count, because the bandwidth is
// pinned to the span the client draws. Halve it until the FFT fits websdrMaxWidebandFFT.
// That trade costs resolution -- it is what pinned three zoom levels to the same 1831 Hz
// per bin, so zooming in magnified the picture without adding to it -- which is why it is
// now the fallback rather than the rule.
func websdrSpectrumParams(visibleBWHz float64, wfWidth int, samprate int) websdrSpectrumRequest {
	if wfWidth < 1 {
		wfWidth = 1
	}
	req := websdrSpectrumRequest{
		DisplayBins:  wfWidth,
		DisplayBinBW: visibleBWHz / float64(wfWidth),
	}

	// Both candidates, then whichever costs radiod less. Wideband first: bin_count x
	// bin_bw must stay equal to the visible span, so trading bins for bandwidth is the
	// only way to shorten the transform.
	wideBins := wfWidth
	for wideBins > 1 && samprate > 0 && float64(samprate)/(visibleBWHz/float64(wideBins)) > websdrMaxWidebandFFT {
		wideBins /= 2
	}
	wideBinBW := visibleBWHz / float64(wideBins)

	if binBW, bins, ok := radiodNarrowbandFor(visibleBWHz, req.DisplayBinBW); ok {
		narrow := radiodNarrowbandPointsPerSec(float64(bins) * binBW)
		if narrow < radiodWidebandPointsPerSec(wideBinBW, samprate) {
			req.BinBandwidth = binBW
			req.BinCount = bins
			req.Crossover = binBW // rbw > crossover is wideband, so equal is narrowband
			return req
		}
	}

	req.BinCount = wideBins
	req.BinBandwidth = wideBinBW
	req.Crossover = 0 // nothing is at or below 0, so radiod always picks wideband
	return req
}

// handleScalePNG serves GET /~~scale?band=B&zoom=Z&tile=N
// It generates a 1024×14 PNG with frequency tick marks and labels.
func (h *WebSDRHandler) handleScalePNG(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	zoom, _ := strconv.Atoi(q.Get("zoom"))
	tile, _ := strconv.Atoi(q.Get("tile"))

	band := websdrBandFor(h.config.Receiver)

	// Clamp zoom to valid range.
	if zoom < 0 {
		zoom = 0
	}
	if zoom > band.MaxZoom {
		zoom = band.MaxZoom
	}

	numTiles := 1 << uint(zoom)
	if tile < 0 {
		tile = 0
	}
	if tile >= numTiles {
		tile = numTiles - 1
	}

	// Tile frequency range.
	tileWidthKHz := band.WidthHz() / 1000.0 / float64(numTiles)
	tileStartKHz := band.StartHz/1000.0 + float64(tile)*tileWidthKHz
	tileEndKHz := tileStartKHz + tileWidthKHz
	pixelsPerKHz := float64(scaleImgW) / tileWidthKHz

	// Choose label step: labels at least 60 px apart.
	labelStep := chooseLabelStep(pixelsPerKHz, 60.0)

	// Create image (black background).
	img := image.NewRGBA(image.Rect(0, 0, scaleImgW, scaleImgH))
	// Background is already zero (transparent black); fill with opaque black.
	black := color.RGBA{R: 0, G: 0, B: 0, A: 255}
	for y := 0; y < scaleImgH; y++ {
		for x := 0; x < scaleImgW; x++ {
			img.SetRGBA(x, y, black)
		}
	}

	white := color.RGBA{R: 255, G: 255, B: 255, A: 255}
	grey := color.RGBA{R: 160, G: 160, B: 160, A: 255}

	// First label frequency at or after tileStart, aligned to labelStep.
	firstLabel := math.Ceil(tileStartKHz/labelStep) * labelStep

	// Minor tick step: 1/5 of label step if it gives ≥ 8 px spacing.
	minorStep := labelStep / 5.0
	if minorStep*pixelsPerKHz < 8 {
		minorStep = labelStep // no minor ticks
	}

	// Draw minor ticks.
	firstMinor := math.Ceil(tileStartKHz/minorStep) * minorStep
	for f := firstMinor; f <= tileEndKHz+minorStep*0.5; f += minorStep {
		px := int(math.Round((f - tileStartKHz) * pixelsPerKHz))
		if px < 0 || px >= scaleImgW {
			continue
		}
		// Short tick: bottom 4 rows.
		for y := scaleImgH - 4; y < scaleImgH; y++ {
			img.SetRGBA(px, y, grey)
		}
	}

	// Draw major ticks and labels.
	for f := firstLabel; f <= tileEndKHz+labelStep*0.5; f += labelStep {
		px := int(math.Round((f - tileStartKHz) * pixelsPerKHz))
		if px < 0 || px >= scaleImgW {
			continue
		}
		// Full-height tick.
		for y := 0; y < scaleImgH; y++ {
			img.SetRGBA(px, y, white)
		}
		// Label: centred above the tick, drawn at y=1 (1 px from top).
		label := formatFreqLabel(f)
		tw := textWidth(label)
		lx := px - tw/2
		// Clamp so label stays within tile.
		if lx < 0 {
			lx = 0
		}
		if lx+tw > scaleImgW {
			lx = scaleImgW - tw
		}
		drawText(img, lx, 1, label)
	}

	// Serve with a short cache lifetime so stale tiles expire quickly.
	// Tiles are deterministic so they can be cached, but we use a short
	// window to avoid stale black tiles from before the scale generator existed.
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = png.Encode(w, img)
}
