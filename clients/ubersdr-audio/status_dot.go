package main

import (
	"image/color"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/widget"
)

var (
	dotColorGreen  = color.NRGBA{R: 0x4c, G: 0xaf, B: 0x50, A: 0xff} // connected
	dotColorRed    = color.NRGBA{R: 0xf4, G: 0x43, B: 0x36, A: 0xff} // disconnected / error
	dotColorOrange = color.NRGBA{R: 0xff, G: 0x98, B: 0x00, A: 0xff} // connecting / reconnecting
	dotColorGrey   = color.NRGBA{R: 0x90, G: 0x90, B: 0x90, A: 0xff} // idle
)

// StatusDot is a small coloured circle that indicates connection state.
type StatusDot struct {
	widget.BaseWidget
	circle *canvas.Circle
}

// NewStatusDot creates a StatusDot with the given initial colour.
func NewStatusDot(c color.Color) *StatusDot {
	d := &StatusDot{
		circle: canvas.NewCircle(c),
	}
	d.ExtendBaseWidget(d)
	return d
}

// SetColor changes the dot colour and repaints.
func (d *StatusDot) SetColor(c color.Color) {
	d.circle.FillColor = c
	d.circle.Refresh()
}

// CreateRenderer implements fyne.Widget.
func (d *StatusDot) CreateRenderer() fyne.WidgetRenderer {
	return widget.NewSimpleRenderer(d.circle)
}

// MinSize returns a fixed small square size for the dot.
func (d *StatusDot) MinSize() fyne.Size {
	return fyne.NewSize(12, 12)
}
