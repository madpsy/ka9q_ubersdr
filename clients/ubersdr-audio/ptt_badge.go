package main

import (
	"image/color"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/widget"
)

// PTTBadge is a small coloured pill that shows "RX" (green) or "TX" (red).
type PTTBadge struct {
	widget.BaseWidget
	bg   *canvas.Rectangle
	text *canvas.Text
}

var (
	pttRXColor = color.NRGBA{R: 0x4c, G: 0xaf, B: 0x50, A: 0xff} // green
	pttTXColor = color.NRGBA{R: 0xf4, G: 0x43, B: 0x36, A: 0xff} // red
)

// NewPTTBadge creates a PTTBadge starting in RX state.
func NewPTTBadge() *PTTBadge {
	b := &PTTBadge{
		bg:   canvas.NewRectangle(pttRXColor),
		text: canvas.NewText("RX", color.White),
	}
	b.bg.CornerRadius = 3
	b.text.TextStyle = fyne.TextStyle{Bold: true}
	b.text.TextSize = 11
	b.text.Alignment = fyne.TextAlignCenter
	b.ExtendBaseWidget(b)
	return b
}

// SetTX switches the badge to TX (red) or RX (green).
func (b *PTTBadge) SetTX(tx bool) {
	if tx {
		b.bg.FillColor = pttTXColor
		b.text.Text = "TX"
	} else {
		b.bg.FillColor = pttRXColor
		b.text.Text = "RX"
	}
	b.bg.Refresh()
	b.text.Refresh()
}

// CreateRenderer implements fyne.Widget.
func (b *PTTBadge) CreateRenderer() fyne.WidgetRenderer {
	c := container.NewStack(b.bg, container.NewPadded(b.text))
	return widget.NewSimpleRenderer(c)
}

// MinSize returns a fixed size for the badge.
func (b *PTTBadge) MinSize() fyne.Size {
	return fyne.NewSize(34, 20)
}
