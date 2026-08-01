package main

import (
	"fmt"
	"math"

	"github.com/gdamore/tcell/v2"
)

// Signal meter scales, taken from static/signal-meter.js so the reading here
// means the same thing as in the browser (which in turn matches
// s-meter-needle.js).
//
// The dBFS span is the S-meter's: S1 sits at -115 dBFS and each S-unit is 6 dB,
// so -127..-33 covers below S0 up to well past S9+. The SNR span starts at 30
// rather than 0 because this is baseband power over noise density, which does
// not approach zero on a live channel.
const (
	meterDBFSMin = -127.0
	meterDBFSMax = -33.0
	meterSNRMin  = 30.0
	meterSNRMax  = 60.0

	// Colour saturates over a narrower span than the bar fills, again matching
	// the web UI: the bar keeps growing past the point where it is already
	// unambiguously green.
	meterDBFSRedAt   = -121.0
	meterDBFSGreenAt = -73.0
	meterSNRRedAt    = 30.0
	meterSNRGreenAt  = 50.0
)

// meterWidth is the number of cells in the bar itself, excluding the label,
// reading and brackets.
const meterWidth = 16

// meterReading returns the value to display, its 0..1 position on the scale,
// and whether there is a reading at all.
func (u *UI) meterReading() (value float64, frac float64, ok bool) {
	if !u.audioOn || !u.signal.Valid() {
		return 0, 0, false
	}

	if u.meterSNR {
		if !u.signal.NoiseValid() {
			return 0, 0, false
		}
		snr := float64(u.signal.SNR())
		return snr, clamp01((snr - meterSNRMin) / (meterSNRMax - meterSNRMin)), true
	}

	power := float64(u.signal.Power)
	return power, clamp01((power - meterDBFSMin) / (meterDBFSMax - meterDBFSMin)), true
}

func clamp01(v float64) float64 {
	if v < 0 || math.IsNaN(v) {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// meterColour maps a reading to the red-through-green ramp the web UI uses:
// hue 0 to 120 at 90% saturation and 55% lightness.
func (u *UI) meterColour(value float64) tcell.Color {
	var lo, hi float64
	if u.meterSNR {
		lo, hi = meterSNRRedAt, meterSNRGreenAt
	} else {
		lo, hi = meterDBFSRedAt, meterDBFSGreenAt
	}

	t := clamp01((value - lo) / (hi - lo))
	r, g, b := hslToRGB(t*120, 0.90, 0.55)
	return tcell.NewRGBColor(r, g, b)
}

// hslToRGB converts an HSL triple to 8-bit RGB. hue is in degrees.
func hslToRGB(hue, sat, light float64) (int32, int32, int32) {
	c := (1 - math.Abs(2*light-1)) * sat
	hp := math.Mod(hue/60, 6)
	x := c * (1 - math.Abs(math.Mod(hp, 2)-1))
	m := light - c/2

	var r, g, b float64
	switch {
	case hp < 1:
		r, g, b = c, x, 0
	case hp < 2:
		r, g, b = x, c, 0
	case hp < 3:
		r, g, b = 0, c, x
	case hp < 4:
		r, g, b = 0, x, c
	case hp < 5:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}

	to8 := func(v float64) int32 {
		n := int32(math.Round((v + m) * 255))
		if n < 0 {
			return 0
		}
		if n > 255 {
			return 255
		}
		return n
	}
	return to8(r), to8(g), to8(b)
}

// meterModeName names the current scale for status messages.
func meterModeName(snr bool) string {
	if snr {
		return "SNR"
	}
	return "dBFS"
}

// meterText is the label and numeric reading, at a fixed width so the bar does
// not slide as the value changes.
func (u *UI) meterText() string {
	label := "dBFS"
	if u.meterSNR {
		label = "SNR "
	}

	value, _, ok := u.meterReading()
	if !ok {
		return fmt.Sprintf("%s %6s", label, "—")
	}
	return fmt.Sprintf("%s %6.1f", label, value)
}

// meterCells is the total width the meter occupies on the status row.
func meterCells() int {
	// "dBFS -112.4 [" + bar + "]"
	return 4 + 1 + 6 + 1 + 1 + meterWidth + 1
}

// meterRegion returns the columns the meter occupies on the status row, and
// whether it is being drawn at all.
//
// Drawing and hit-testing both go through this so a click can never toggle a
// meter that is not on screen.
func (u *UI) meterRegion(l Layout) (x0, x1 int, ok bool) {
	// Below this width the status hints are more useful than a meter: they
	// carry the keys for mute, squelch and noise reduction, which cannot be
	// discovered any other way.
	if !u.audioOn || l.W <= meterCells()+45 {
		return 0, 0, false
	}
	return l.W - meterCells(), l.W, true
}

// MeterHit reports whether a screen position lands on the meter.
func (u *UI) MeterHit(l Layout, x, y int) bool {
	x0, x1, ok := u.meterRegion(l)
	return ok && y == l.StatusY && x >= x0 && x < x1
}

// drawMeter paints the signal meter at the right-hand end of the status row.
//
// The filled portion takes the colour of the current reading rather than a
// per-cell gradient, matching the web UI: hue alone carries the quality, so a
// glance at the colour is enough without reading the number.
func (u *UI) drawMeter(s tcell.Screen, l Layout) {
	x, _, ok := u.meterRegion(l)
	if !ok {
		return
	}

	bg := tcell.NewRGBColor(45, 45, 55)
	base := tcell.StyleDefault.Background(bg)

	value, frac, hasReading := u.meterReading()
	filled := int(math.Round(frac * meterWidth))

	textStyle := base.Foreground(tcell.NewRGBColor(200, 200, 210))
	if hasReading {
		textStyle = base.Foreground(u.meterColour(value))
	}
	drawText(s, x, l.StatusY, textStyle, u.meterText())

	bx := x + 4 + 1 + 6 + 1
	drawText(s, bx, l.StatusY, base.Foreground(tcell.NewRGBColor(110, 110, 125)), "[")

	fill := tcell.NewRGBColor(90, 90, 105)
	if hasReading {
		fill = u.meterColour(value)
	}
	empty := base.Foreground(tcell.NewRGBColor(80, 80, 95))
	lit := base.Foreground(fill)

	for i := 0; i < meterWidth; i++ {
		ch, style := '─', empty
		if i < filled {
			ch, style = '█', lit
		}
		s.SetContent(bx+1+i, l.StatusY, ch, nil, style)
	}
	drawText(s, bx+1+meterWidth, l.StatusY, base.Foreground(tcell.NewRGBColor(110, 110, 125)), "]")
}
