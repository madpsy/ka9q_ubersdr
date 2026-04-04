package main

import (
	"fmt"
	"image/color"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/widget"
)

// LevelBar is a labelled horizontal bar that shows a value within [min, max].
// The bar colour transitions green → yellow → red as the value rises.
//
// Usage:
//
//	bar := NewLevelBar("Signal", -120, -50, "dBFS")
//	bar.SetValue(-80)   // updates the bar
//	bar.SetNoData()     // greys out the bar (no signal)
type LevelBar struct {
	widget.BaseWidget

	label  string  // e.g. "Signal"
	unit   string  // e.g. "dBFS"
	minVal float64 // e.g. -120
	maxVal float64 // e.g. -50

	value  float64
	hasVal bool
}

// NewLevelBar creates a new LevelBar.
func NewLevelBar(label string, minVal, maxVal float64, unit string) *LevelBar {
	lb := &LevelBar{
		label:  label,
		unit:   unit,
		minVal: minVal,
		maxVal: maxVal,
	}
	lb.ExtendBaseWidget(lb)
	return lb
}

// SetValue updates the displayed value and redraws.
func (lb *LevelBar) SetValue(v float64) {
	lb.value = v
	lb.hasVal = true
	lb.Refresh()
}

// SetNoData greys out the bar (called when no signal data is available).
func (lb *LevelBar) SetNoData() {
	lb.hasVal = false
	lb.Refresh()
}

// MinSize returns the minimum size for the bar widget.
func (lb *LevelBar) MinSize() fyne.Size {
	return fyne.NewSize(200, 22)
}

// CreateRenderer implements fyne.Widget.
func (lb *LevelBar) CreateRenderer() fyne.WidgetRenderer {
	bg := canvas.NewRectangle(color.NRGBA{R: 50, G: 50, B: 50, A: 255})
	fill := canvas.NewRectangle(color.NRGBA{R: 80, G: 80, B: 80, A: 255})
	textLbl := canvas.NewText("", color.White)
	textLbl.TextSize = 11
	textLbl.Alignment = fyne.TextAlignCenter
	nameTag := canvas.NewText(lb.label, color.NRGBA{R: 200, G: 200, B: 200, A: 255})
	nameTag.TextSize = 11

	return &levelBarRenderer{
		lb:      lb,
		bg:      bg,
		fill:    fill,
		textLbl: textLbl,
		nameTag: nameTag,
	}
}

// ── renderer ─────────────────────────────────────────────────────────────────

type levelBarRenderer struct {
	lb      *LevelBar
	bg      *canvas.Rectangle
	fill    *canvas.Rectangle
	textLbl *canvas.Text
	nameTag *canvas.Text
}

const levelBarTagW = float32(42) // width reserved for the name tag on the left
const levelBarPad = float32(4)

func (r *levelBarRenderer) Layout(size fyne.Size) {
	lb := r.lb

	barX := levelBarTagW + levelBarPad
	barW := size.Width - barX
	barH := size.Height

	// Name tag on the left, vertically centred.
	tagSz := fyne.MeasureText(lb.label, r.nameTag.TextSize, r.nameTag.TextStyle)
	r.nameTag.Move(fyne.NewPos(0, (barH-tagSz.Height)/2))
	r.nameTag.Resize(fyne.NewSize(levelBarTagW, barH))

	r.bg.Move(fyne.NewPos(barX, 0))
	r.bg.Resize(fyne.NewSize(barW, barH))

	// Compute fill width
	fillW := float32(0)
	if lb.hasVal {
		frac := (lb.value - lb.minVal) / (lb.maxVal - lb.minVal)
		if frac < 0 {
			frac = 0
		}
		if frac > 1 {
			frac = 1
		}
		fillW = float32(frac) * barW
		r.fill.FillColor = barColour(frac)
	} else {
		r.fill.FillColor = color.NRGBA{R: 60, G: 60, B: 60, A: 255}
	}
	r.fill.Move(fyne.NewPos(barX, 0))
	r.fill.Resize(fyne.NewSize(fillW, barH))

	// Value text centred over the bar.
	// fyne.MeasureText gives the actual rendered bounding box size.
	if lb.hasVal {
		r.textLbl.Text = fmt.Sprintf("%.1f %s", lb.value, lb.unit)
	} else {
		r.textLbl.Text = "—"
	}
	txtSz := fyne.MeasureText(r.textLbl.Text, r.textLbl.TextSize, r.textLbl.TextStyle)
	r.textLbl.Move(fyne.NewPos(barX, (barH-txtSz.Height)/2))
	r.textLbl.Resize(fyne.NewSize(barW, txtSz.Height))
}

func (r *levelBarRenderer) MinSize() fyne.Size {
	return r.lb.MinSize()
}

func (r *levelBarRenderer) Refresh() {
	r.Layout(r.lb.Size())
	canvas.Refresh(r.lb)
}

func (r *levelBarRenderer) Objects() []fyne.CanvasObject {
	return []fyne.CanvasObject{r.bg, r.fill, r.nameTag, r.textLbl}
}

func (r *levelBarRenderer) Destroy() {}

// barColour maps a 0–1 fraction to red→yellow→green.
// Low fraction = weak/bad (red), high fraction = strong/good (green).
func barColour(frac float64) color.Color {
	if frac < 0.5 {
		// red → yellow: red stays at 220, green rises from 0 to 200
		rv := uint8(220)
		g := uint8(frac * 2 * 200)
		return color.NRGBA{R: rv, G: g, B: 0, A: 255}
	}
	// yellow → green: green stays at 200, red falls from 220 to 0
	g := uint8(200)
	rv := uint8((1 - (frac-0.5)*2) * 220)
	return color.NRGBA{R: rv, G: g, B: 0, A: 255}
}
