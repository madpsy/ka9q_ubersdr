package main

// websdr_scale.go — dynamic frequency-scale PNG tile generator for /~~scale
//
// The WebSDR frontend displays a 1024-pixel-wide frequency scale bar above
// each waterfall.  The bar is rendered by two <img> elements whose src is
// set to e.scaleimgs[zoom][tileIndex].  Each tile is a 1024×14 PNG showing
// frequency tick marks and labels for the portion of the band it covers.
//
// Tile geometry (band = 10 kHz … 30 MHz, i.e. 29 990 kHz wide):
//
//	tileWidthKHz[zoom] = 29990 / (1 << zoom)
//	tileStartKHz       = 10 + tile * tileWidthKHz
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
	scaleBandStartKHz = 10.0
	scaleBandBWKHz    = 29990.0 // 30000 - 10
	scaleImgW         = 1024
	scaleImgH         = 14
)

// handleScalePNG serves GET /~~scale?band=B&zoom=Z&tile=N
// It generates a 1024×14 PNG with frequency tick marks and labels.
func (h *WebSDRHandler) handleScalePNG(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	zoom, _ := strconv.Atoi(q.Get("zoom"))
	tile, _ := strconv.Atoi(q.Get("tile"))

	// Clamp zoom to valid range.
	const maxZoom = 8
	if zoom < 0 {
		zoom = 0
	}
	if zoom > maxZoom {
		zoom = maxZoom
	}

	numTiles := 1 << uint(zoom)
	if tile < 0 {
		tile = 0
	}
	if tile >= numTiles {
		tile = numTiles - 1
	}

	// Tile frequency range.
	tileWidthKHz := scaleBandBWKHz / float64(numTiles)
	tileStartKHz := scaleBandStartKHz + float64(tile)*tileWidthKHz
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
