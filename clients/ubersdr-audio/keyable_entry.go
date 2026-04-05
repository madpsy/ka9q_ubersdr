package main

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"
)

// keyableEntry extends widget.Entry to intercept Up, Down, and Return keys
// so they can be used to navigate and select items in an adjacent list.
type keyableEntry struct {
	widget.Entry
	OnUp    func()
	OnDown  func()
	OnEnter func()
}

func newKeyableEntry() *keyableEntry {
	e := &keyableEntry{}
	e.ExtendBaseWidget(e)
	return e
}

// TypedKey is called for every key press on the entry.
func (e *keyableEntry) TypedKey(key *fyne.KeyEvent) {
	switch key.Name {
	case fyne.KeyUp:
		if e.OnUp != nil {
			e.OnUp()
		}
	case fyne.KeyDown:
		if e.OnDown != nil {
			e.OnDown()
		}
	case fyne.KeyReturn, fyne.KeyEnter:
		if e.OnEnter != nil {
			e.OnEnter()
		}
	default:
		e.Entry.TypedKey(key)
	}
}
