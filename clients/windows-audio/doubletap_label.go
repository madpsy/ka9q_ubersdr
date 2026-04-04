package main

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"
)

// doubleTapLabel is a Label that also implements fyne.DoubleTappable.
// OnDoubleTap is called when the user double-clicks the widget.
type doubleTapLabel struct {
	widget.Label
	OnDoubleTap func()
}

func newDoubleTapLabel(text string, onDoubleTap func()) *doubleTapLabel {
	l := &doubleTapLabel{OnDoubleTap: onDoubleTap}
	l.ExtendBaseWidget(l)
	l.SetText(text)
	return l
}

// DoubleTapped implements fyne.DoubleTappable.
func (l *doubleTapLabel) DoubleTapped(_ *fyne.PointEvent) {
	if l.OnDoubleTap != nil {
		l.OnDoubleTap()
	}
}
