package main

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// profileListRow is a single row in the profiles list.  It renders a bold
// name line and an italic subtitle line inside one RichText widget so there
// is no inter-widget gap between them.  It implements fyne.Tappable and
// fyne.DoubleTappable so it can be used inside a widget.List.
type profileListRow struct {
	widget.BaseWidget
	rich        *widget.RichText
	OnTap       func()
	OnDoubleTap func()
}

func newProfileListRow() *profileListRow {
	r := &profileListRow{}
	r.rich = widget.NewRichText(
		&widget.TextSegment{Text: "", Style: widget.RichTextStyle{Inline: false}},
		&widget.TextSegment{Text: "", Style: widget.RichTextStyle{
			Inline:    false,
			TextStyle: fyne.TextStyle{Italic: true},
			ColorName: theme.ColorNameForeground,
		}},
	)
	r.rich.Wrapping = fyne.TextWrapOff
	r.ExtendBaseWidget(r)
	return r
}

// SetContent updates the name and subtitle text.
func (r *profileListRow) SetContent(name, subtitle string) {
	r.rich.Segments = []widget.RichTextSegment{
		&widget.TextSegment{
			Text: name,
			Style: widget.RichTextStyle{
				Inline:    false,
				ColorName: theme.ColorNameForeground,
			},
		},
		&widget.TextSegment{
			Text: subtitle,
			Style: widget.RichTextStyle{
				Inline:    false,
				TextStyle: fyne.TextStyle{Italic: true},
				ColorName: theme.ColorNameForeground,
			},
		},
	}
	r.rich.Refresh()
}

func (r *profileListRow) CreateRenderer() fyne.WidgetRenderer {
	return widget.NewSimpleRenderer(r.rich)
}

func (r *profileListRow) Tapped(_ *fyne.PointEvent) {
	if r.OnTap != nil {
		r.OnTap()
	}
}

func (r *profileListRow) DoubleTapped(_ *fyne.PointEvent) {
	if r.OnDoubleTap != nil {
		r.OnDoubleTap()
	}
}
