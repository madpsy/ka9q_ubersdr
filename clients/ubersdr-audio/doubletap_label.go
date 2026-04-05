package main

import (
	"image/color"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/widget"
)

// newWhiteSeparator returns a 1-pixel-tall white horizontal rule, suitable
// for use as a dividing line above the status bar in dark-theme windows.
func newWhiteSeparator() fyne.CanvasObject {
	line := canvas.NewRectangle(color.White)
	return container.New(&fixedHeightLayout{height: 1}, line)
}

// fixedHeightLayout is a fyne.Layout that gives every child the full
// container width and a fixed height, ignoring the child's own MinSize.
type fixedHeightLayout struct{ height float32 }

func (f *fixedHeightLayout) Layout(objects []fyne.CanvasObject, size fyne.Size) {
	for _, o := range objects {
		o.Resize(fyne.NewSize(size.Width, f.height))
		o.Move(fyne.NewPos(0, 0))
	}
}

func (f *fixedHeightLayout) MinSize(_ []fyne.CanvasObject) fyne.Size {
	return fyne.NewSize(0, f.height)
}

// tightVBoxLayout stacks objects vertically with no padding between them.
// Use it instead of container.NewVBox when you want items to sit flush
// against each other (e.g. a name label immediately above a subtitle label).
type tightVBoxLayout struct{}

func (t *tightVBoxLayout) Layout(objects []fyne.CanvasObject, size fyne.Size) {
	y := float32(0)
	for _, o := range objects {
		h := o.MinSize().Height
		o.Resize(fyne.NewSize(size.Width, h))
		o.Move(fyne.NewPos(0, y))
		y += h
	}
}

func (t *tightVBoxLayout) MinSize(objects []fyne.CanvasObject) fyne.Size {
	w := float32(0)
	h := float32(0)
	for _, o := range objects {
		ms := o.MinSize()
		if ms.Width > w {
			w = ms.Width
		}
		h += ms.Height
	}
	return fyne.NewSize(w, h)
}

// doubleTapLabel is a Label that also implements fyne.Tappable and
// fyne.DoubleTappable so it can be used inside a widget.List without
// consuming tap events that the list needs to highlight the selected row.
//
// OnTap is called on a single tap (use it to call list.Select so the row
// gets highlighted). OnDoubleTap is called on a double-tap.
type doubleTapLabel struct {
	widget.Label
	OnTap       func()
	OnDoubleTap func()
}

func newDoubleTapLabel(text string, onDoubleTap func()) *doubleTapLabel {
	l := &doubleTapLabel{OnDoubleTap: onDoubleTap}
	l.ExtendBaseWidget(l)
	l.SetText(text)
	return l
}

// Tapped implements fyne.Tappable. Forwarding the single-tap to OnTap lets
// the caller drive list.Select(), which gives the row its highlight.
func (l *doubleTapLabel) Tapped(_ *fyne.PointEvent) {
	if l.OnTap != nil {
		l.OnTap()
	}
}

// DoubleTapped implements fyne.DoubleTappable.
func (l *doubleTapLabel) DoubleTapped(_ *fyne.PointEvent) {
	if l.OnDoubleTap != nil {
		l.OnDoubleTap()
	}
}
