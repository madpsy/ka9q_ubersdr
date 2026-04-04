package main

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"
)

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
