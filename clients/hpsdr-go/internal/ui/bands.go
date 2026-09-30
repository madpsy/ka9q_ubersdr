package ui

import (
	"fmt"
	"strings"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/app"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/hpsdr"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// Band receivers: further UberSDR instances, each taking the DDCs tuned to its
// bands, while the receiver on the setup screen takes everything else. An
// advanced feature, so the setup screen shows it as one line that opens its
// own page, and with none set up everything is as it was.

// ---- a form row that opens something ------------------------------------------

// linkField is a form row whose field is a summary, and Enter, Space or a
// click opens whatever edits it. tview has no such form item; a Button is not
// one.
type linkField struct {
	*tview.Box
	label      string
	text       string
	labelWidth int
	labelColor tcell.Color
	fieldColor tcell.Color
	fieldBg    tcell.Color
	finished   func(tcell.Key)
	selected   func()
	disabled   bool
}

func newLinkField(label string, selected func()) *linkField {
	return &linkField{Box: tview.NewBox(), label: label, selected: selected}
}

func (l *linkField) SetText(t string) *linkField { l.text = t; return l }
func (l *linkField) GetLabel() string            { return l.label }
func (l *linkField) GetFieldWidth() int          { return 0 }
func (l *linkField) GetFieldHeight() int         { return 1 }

func (l *linkField) SetFormAttributes(labelWidth int, labelColor, bgColor, fieldTextColor, fieldBgColor tcell.Color) tview.FormItem {
	l.labelWidth, l.labelColor, l.fieldColor, l.fieldBg = labelWidth, labelColor, fieldTextColor, fieldBgColor
	l.SetBackgroundColor(bgColor)
	return l
}

func (l *linkField) SetFinishedFunc(h func(tcell.Key)) tview.FormItem { l.finished = h; return l }
func (l *linkField) SetDisabled(d bool) tview.FormItem                { l.disabled = d; return l }

func (l *linkField) Draw(screen tcell.Screen) {
	l.DrawForSubclass(screen, l)
	x, y, width, height := l.GetInnerRect()
	if height < 1 || width < 1 {
		return
	}
	lw := l.labelWidth
	if lw == 0 {
		lw = tview.TaggedStringWidth(l.label) + 1
	}
	if lw > width {
		lw = width
	}
	tview.Print(screen, tview.Escape(l.label), x, y, lw, tview.AlignLeft, l.labelColor)
	style := tcell.StyleDefault.Foreground(l.fieldColor).Background(l.fieldBg)
	if l.HasFocus() {
		style = style.Reverse(true)
	}
	text := []rune(l.text + "  ›")
	for i := 0; i < width-lw; i++ {
		r := ' '
		if i < len(text) {
			r = text[i]
		}
		screen.SetContent(x+lw+i, y, r, nil, style)
	}
}

func (l *linkField) InputHandler() func(*tcell.EventKey, func(tview.Primitive)) {
	return l.WrapInputHandler(func(ev *tcell.EventKey, _ func(tview.Primitive)) {
		if l.disabled {
			return
		}
		switch ev.Key() {
		case tcell.KeyEnter:
			l.selected()
		case tcell.KeyRune:
			if ev.Rune() == ' ' {
				l.selected()
			}
		case tcell.KeyTab, tcell.KeyBacktab, tcell.KeyEscape:
			if l.finished != nil {
				l.finished(ev.Key())
			}
		}
	})
}

func (l *linkField) MouseHandler() func(tview.MouseAction, *tcell.EventMouse, func(tview.Primitive)) (bool, tview.Primitive) {
	return l.WrapMouseHandler(func(a tview.MouseAction, ev *tcell.EventMouse, setFocus func(tview.Primitive)) (bool, tview.Primitive) {
		if l.disabled || !l.InRect(ev.Position()) {
			return false, nil
		}
		switch a {
		case tview.MouseLeftDown:
			setFocus(l)
			return true, nil
		case tview.MouseLeftClick:
			l.selected()
			return true, nil
		}
		return false, nil
	})
}

// ---- the mouse wheel ------------------------------------------------------------

// wheelList makes the wheel move a list's selection. tview's own wheel handling
// scrolls the view, and the next draw scrolls it straight back to keep the
// selection in sight, so on its own the wheel appears to do nothing.
func wheelList(l *tview.List) {
	l.SetMouseCapture(func(a tview.MouseAction, ev *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse) {
		if ev == nil || !l.InRect(ev.Position()) {
			return a, ev
		}
		cur := l.GetCurrentItem()
		switch a {
		case tview.MouseScrollUp:
			if cur > 0 {
				l.SetCurrentItem(cur - 1)
			}
			return tview.MouseConsumed, nil
		case tview.MouseScrollDown:
			if cur < l.GetItemCount()-1 {
				l.SetCurrentItem(cur + 1)
			}
			return tview.MouseConsumed, nil
		}
		return a, ev
	})
}

// selectedStyle is a table's highlighted row. tview's default swaps each
// cell's own colours, which turns a cell in the terminal's default colour into
// black on whatever the terminal's background is; this is the blue tview's
// own form fields use.
var selectedStyle = tcell.StyleDefault.Foreground(tview.Styles.PrimaryTextColor).
	Background(tview.Styles.ContrastBackgroundColor)

// mouseTable gives a table with selectable rows the mouse: the wheel moves the
// selection, as wheelList does for a list, and a double-click selects the row
// and calls double with it. Rows that cannot be selected are stepped over and
// ignored.
func mouseTable(t *tview.Table, double func(row int)) {
	t.SetSelectedStyle(selectedStyle)
	t.SetMouseCapture(func(a tview.MouseAction, ev *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse) {
		if ev == nil || !t.InRect(ev.Position()) {
			return a, ev
		}
		step := 0
		switch a {
		case tview.MouseScrollUp:
			step = -1
		case tview.MouseScrollDown:
			step = 1
		case tview.MouseLeftDoubleClick:
			row, _ := t.CellAt(ev.Position())
			if c := t.GetCell(row, 0); row >= 0 && c != nil && !c.NotSelectable && double != nil {
				t.Select(row, 0)
				double(row)
			}
			return tview.MouseConsumed, nil
		default:
			return a, ev
		}
		row, col := t.GetSelection()
		for r := row + step; r >= 0 && r < t.GetRowCount(); r += step {
			if c := t.GetCell(r, 0); c != nil && !c.NotSelectable {
				t.Select(r, col)
				break
			}
		}
		return tview.MouseConsumed, nil
	})
}

// ---- state -------------------------------------------------------------------------

// bandState is the band receivers as the pages edit them.
type bandState struct {
	list   []app.BandInstance
	probes map[string]*app.Probe // by probeKey

	field *linkField

	// the list page
	table   *tview.Table
	buttons *tview.Form
	info    *tview.TextView

	// the edit page
	editIdx      int // -1 adds
	editForm     *tview.Form
	editURL      *tview.InputField
	editPW       *tview.InputField
	editTable    *tview.Table
	editInfo     *tview.TextView
	editBands    map[string]bool
	editProbe    *app.Probe
	editProbeKey string
	editProbing  bool
}

func probeKey(url, password string) string { return strings.TrimSpace(url) + "\x00" + password }

// bandsSummary is the setup screen's one line.
func bandsSummary(list []app.BandInstance) string {
	if len(list) == 0 {
		return "none: one receiver for all"
	}
	var parts []string
	for _, bi := range list {
		parts = append(parts, strings.Join(bi.Bands, " "))
	}
	return fmt.Sprintf("%d: %s", len(list), strings.Join(parts, " · "))
}

func hostOf(url string) string {
	if s, err := ubersdr.NewServer(url, ""); err == nil {
		return s.Host()
	}
	return url
}

// ---- the list page ---------------------------------------------------------------

func (u *UI) buildBands() tview.Primitive {
	b := &u.bands
	b.table = tview.NewTable().SetSelectable(true, false).SetFixed(1, 0)
	b.table.SetBorder(true).SetTitle(" Band receivers ").SetTitleAlign(tview.AlignLeft)
	b.table.SetSelectedFunc(func(row, _ int) { u.editBand(row - 1) })
	mouseTable(b.table, func(row int) { u.editBand(row - 1) })

	b.buttons = tview.NewForm().
		AddButton("Add", func() { u.editBand(-1) }).
		AddButton("Edit", func() {
			if row, _ := b.table.GetSelection(); row >= 1 && row <= len(b.list) {
				u.editBand(row - 1)
			}
		}).
		AddButton("Remove", u.removeBand).
		AddButton("Back", u.hideBands)
	b.buttons.SetButtonsAlign(tview.AlignLeft).SetBorderPadding(0, 0, 1, 1)

	b.info = tview.NewTextView().SetDynamicColors(true).SetWrap(true).SetWordWrap(true)
	b.info.SetText("[gray]Each band receiver takes the DDCs tuned to its bands; the receiver on the setup " +
		"screen takes everything else. A DDC tuned from one to another reconnects there, which a public " +
		"session may do about ten times a minute. Every receiver must allow a rate for it to be offered.[-]")

	hint := tview.NewTextView().SetDynamicColors(true).
		SetText("[gray]Enter or a double-click edits · Tab to the buttons · Esc goes back[-]")

	b.table.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch ev.Key() {
		case tcell.KeyEscape:
			u.hideBands()
			return nil
		case tcell.KeyTab, tcell.KeyBacktab:
			u.app.SetFocus(b.buttons)
			return nil
		}
		return ev
	})
	b.buttons.SetCancelFunc(u.hideBands)
	b.buttons.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		// Tab past the last button goes back to the table rather than round
		// the buttons alone.
		if ev.Key() == tcell.KeyTab {
			if _, btn := b.buttons.GetFocusedItemIndex(); btn == b.buttons.GetButtonCount()-1 {
				u.app.SetFocus(b.table)
				return nil
			}
		}
		return ev
	})

	return tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(b.table, 0, 1, true).
		AddItem(b.buttons, 1, 0, false).
		AddItem(b.info, 4, 0, false).
		AddItem(hint, 1, 0, false)
}

func (u *UI) showBands() {
	u.fillBands()
	u.pages.SwitchToPage("bands")
	u.app.SetFocus(u.bands.table)
}

func (u *UI) hideBands() {
	u.pages.SwitchToPage("setup")
	u.app.SetFocus(u.form)
	u.refreshBandsField()
	u.refreshAllowed()
}

func (u *UI) fillBands() {
	b := &u.bands
	row, _ := b.table.GetSelection()
	b.table.Clear()
	for c, h := range []string{"Bands", "Receiver", "Checked"} {
		b.table.SetCell(0, c, tview.NewTableCell(h).SetAttributes(tcell.AttrBold).SetSelectable(false).SetExpansion(boolInt(c == 2)))
	}
	for i, bi := range b.list {
		checked := "[gray]not yet: checked on Start[-]"
		if p := b.probes[probeKey(bi.URL, bi.Password)]; p != nil {
			checked = probeLine(p)
		}
		b.table.SetCell(i+1, 0, tview.NewTableCell(tview.Escape(strings.Join(bi.Bands, " "))).SetMaxWidth(24))
		b.table.SetCell(i+1, 1, tview.NewTableCell(tview.Escape(hostOf(bi.URL))).SetMaxWidth(28))
		b.table.SetCell(i+1, 2, tview.NewTableCell(checked).SetExpansion(1))
	}
	last := len(b.list) + 1
	b.table.SetCell(last, 0, tview.NewTableCell("[gray]everything else[-]").SetSelectable(false))
	b.table.SetCell(last, 1, tview.NewTableCell("[gray]"+tview.Escape(hostOf(u.url.GetText()))+"[-]").SetSelectable(false).SetMaxWidth(28))
	b.table.SetCell(last, 2, tview.NewTableCell("[gray]the receiver on the setup screen[-]").SetSelectable(false))
	if len(b.list) == 0 {
		b.table.Select(0, 0)
		return
	}
	if row < 1 {
		row = 1
	}
	if row > len(b.list) {
		row = len(b.list)
	}
	b.table.Select(row, 0)
}

// probeLine is a check result in a few words.
func probeLine(p *app.Probe) string {
	switch {
	case !p.Reached:
		return "[red]not reachable[-]"
	case !p.Conn.Allowed:
		return "[red]refused: " + tview.Escape(p.Conn.Refusal(p.Server.Password != "")) + "[-]"
	}
	var rates []string
	for _, k := range p.AllowedKHz() {
		rates = append(rates, fmt.Sprint(k))
	}
	who := "public"
	if p.Conn.Bypassed {
		who = "bypassed"
	}
	name := p.Desc.Callsign
	if name == "" {
		name = p.Server.Host()
	}
	return fmt.Sprintf("[green]%s[-], %s, %s kHz", tview.Escape(name), who, strings.Join(rates, "/"))
}

func (u *UI) removeBand() {
	b := &u.bands
	row, _ := b.table.GetSelection()
	if row < 1 || row > len(b.list) {
		return
	}
	b.list = append(b.list[:row-1:row-1], b.list[row:]...)
	u.fillBands()
	u.app.SetFocus(b.table)
}

func (u *UI) refreshBandsField() {
	u.bands.field.SetText(bandsSummary(u.bands.list))
}

// ---- the edit page ---------------------------------------------------------------

func (u *UI) buildBandEdit() tview.Primitive {
	b := &u.bands
	b.editURL = tview.NewInputField().SetLabel("Receiver URL").SetFieldWidth(0)
	b.editPW = tview.NewInputField().SetLabel("Password").SetFieldWidth(0).SetMaskCharacter('*')
	stale := func(string) {
		if b.editProbe != nil && probeKey(b.editURL.GetText(), b.editPW.GetText()) != b.editProbeKey {
			b.editProbe = nil
			b.editInfo.SetText("[gray]Changed since the last check. Choose Check to ask the receiver again.[-]")
			u.fillEditBands()
		}
	}
	b.editURL.SetChangedFunc(stale)
	b.editPW.SetChangedFunc(stale)

	b.editForm = tview.NewForm().AddFormItem(b.editURL).AddFormItem(b.editPW).
		AddButton("Check", u.checkEdit).
		AddButton("Browse", func() {
			u.showPickerFor(func(inst ubersdr.Instance) {
				b.editURL.SetText(inst.URL())
				u.checkEdit()
			}, "bandedit", b.editForm)
		}).
		AddButton("Save", u.saveEdit).
		AddButton("Cancel", u.cancelEdit)
	b.editForm.SetItemPadding(0).SetBorderPadding(0, 0, 1, 1).SetBorder(true).SetTitle(" Band receiver ").SetTitleAlign(tview.AlignLeft)
	b.editForm.SetCancelFunc(u.cancelEdit)

	b.editTable = tview.NewTable().SetSelectable(true, false).SetFixed(1, 0)
	b.editTable.SetBorder(true).SetTitle(" Bands ").SetTitleAlign(tview.AlignLeft)
	b.editTable.SetSelectedFunc(func(row, _ int) { u.toggleEditBand(row) })
	mouseTable(b.editTable, u.toggleEditBand)
	b.editTable.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch {
		case ev.Key() == tcell.KeyRune && ev.Rune() == ' ':
			row, _ := b.editTable.GetSelection()
			u.toggleEditBand(row)
			return nil
		case ev.Key() == tcell.KeyEscape:
			u.cancelEdit()
			return nil
		case ev.Key() == tcell.KeyTab, ev.Key() == tcell.KeyBacktab:
			u.app.SetFocus(b.editForm)
			return nil
		}
		return ev
	})
	b.editForm.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		if ev.Key() == tcell.KeyTab {
			if _, btn := b.editForm.GetFocusedItemIndex(); btn == b.editForm.GetButtonCount()-1 {
				u.app.SetFocus(b.editTable)
				return nil
			}
		}
		return ev
	})

	b.editInfo = tview.NewTextView().SetDynamicColors(true).SetWrap(true).SetWordWrap(true)
	b.editInfo.SetBorder(true).SetTitle(" Receiver ").SetTitleAlign(tview.AlignLeft)

	hint := tview.NewTextView().SetDynamicColors(true).
		SetText("[gray]Space, Enter or a double-click ticks a band · Tab moves · Esc cancels[-]")

	bottom := tview.NewFlex().
		AddItem(b.editTable, 0, 3, false).
		AddItem(b.editInfo, 0, 2, false)
	return tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(b.editForm, 6, 0, true).
		AddItem(bottom, 0, 1, false).
		AddItem(hint, 1, 0, false)
}

// editBand opens the edit page for band receiver i, or a new one for -1.
func (u *UI) editBand(i int) {
	b := &u.bands
	if i >= len(b.list) {
		return
	}
	b.editIdx = i
	b.editBands = map[string]bool{}
	var bi app.BandInstance
	if i >= 0 {
		bi = b.list[i]
	}
	for _, n := range bi.Bands {
		if band, ok := hpsdr.BandNamed(n); ok {
			b.editBands[band.Name] = true
		}
	}
	b.editURL.SetText(bi.URL)
	b.editPW.SetText(bi.Password)
	b.editProbe = b.probes[probeKey(bi.URL, bi.Password)]
	b.editProbeKey = probeKey(bi.URL, bi.Password)
	if b.editProbe != nil {
		b.editInfo.SetText(renderProbe(b.editProbe))
	} else {
		b.editInfo.SetText("[gray]Enter the receiver's URL and choose Check, or Browse. Its tuning range decides which bands it can take.[-]")
	}
	u.fillEditBands()
	u.pages.SwitchToPage("bandedit")
	if i < 0 {
		u.app.SetFocus(b.editForm)
	} else {
		u.app.SetFocus(b.editTable)
	}
}

// bandOwner is the other band receiver a band is set for, if any.
func (u *UI) bandOwner(name string) string {
	b := &u.bands
	for i, bi := range b.list {
		if i == b.editIdx {
			continue
		}
		for _, n := range bi.Bands {
			if strings.EqualFold(n, name) {
				// By callsign where known, as the status names instances.
				if p := b.probes[probeKey(bi.URL, bi.Password)]; p != nil && p.Desc.Callsign != "" {
					return p.Desc.Callsign
				}
				return hostOf(bi.URL)
			}
		}
	}
	return ""
}

// editRange is the checked receiver's range, ok false before a check.
func (u *UI) editRange() (lo, hi int64, ok bool) {
	p := u.bands.editProbe
	if p == nil || !p.Reached {
		return 0, 0, false
	}
	return p.Desc.MinHz, p.Desc.MaxHz, true
}

func bandRange(b hpsdr.Band) string {
	if b.Hi < 1_000_000 {
		return fmt.Sprintf("%.1f-%.1f kHz", float64(b.Lo)/1e3, float64(b.Hi)/1e3)
	}
	return fmt.Sprintf("%.3f-%.3f MHz", float64(b.Lo)/1e6, float64(b.Hi)/1e6)
}

func (u *UI) fillEditBands() {
	b := &u.bands
	row, _ := b.editTable.GetSelection()
	b.editTable.Clear()
	for c, h := range []string{"", "Band", "Range", ""} {
		b.editTable.SetCell(0, c, tview.NewTableCell(h).SetAttributes(tcell.AttrBold).SetSelectable(false).SetExpansion(boolInt(c == 3)))
	}
	lo, hi, known := u.editRange()
	for i, band := range hpsdr.Bands {
		box, note, color := "[ ]", "", tview.Styles.PrimaryTextColor
		if b.editBands[band.Name] {
			box = "[x]"
		}
		switch owner := u.bandOwner(band.Name); {
		case owner != "":
			box, note, color = "   ", "on "+owner, tcell.ColorGray
		case known:
			switch any, all := band.Covers(lo, hi); {
			case !any:
				box, note, color = "   ", "out of range", tcell.ColorGray
			case !all:
				note = "partly in range"
			}
		}
		b.editTable.SetCell(i+1, 0, tview.NewTableCell(tview.Escape(box)).SetTextColor(color))
		b.editTable.SetCell(i+1, 1, tview.NewTableCell(band.Name).SetTextColor(color))
		b.editTable.SetCell(i+1, 2, tview.NewTableCell(bandRange(band)).SetTextColor(color))
		b.editTable.SetCell(i+1, 3, tview.NewTableCell(tview.Escape(note)).SetTextColor(color))
	}
	if row < 1 {
		row = 1
	}
	b.editTable.Select(row, 0)
}

// bandAllowed says whether a band can be ticked, and why not.
func (u *UI) bandAllowed(band hpsdr.Band) (bool, string) {
	if owner := u.bandOwner(band.Name); owner != "" {
		return false, band.Name + " is already set for " + owner + "; remove it there first."
	}
	if lo, hi, known := u.editRange(); known {
		if any, _ := band.Covers(lo, hi); !any {
			return false, fmt.Sprintf("%s is outside this receiver's range (%.3f kHz - %.3f MHz).",
				band.Name, float64(lo)/1e3, float64(hi)/1e6)
		}
	}
	return true, ""
}

func (u *UI) toggleEditBand(row int) {
	b := &u.bands
	if row < 1 || row > len(hpsdr.Bands) {
		return
	}
	band := hpsdr.Bands[row-1]
	if b.editBands[band.Name] {
		delete(b.editBands, band.Name)
	} else if ok, why := u.bandAllowed(band); ok {
		b.editBands[band.Name] = true
	} else {
		b.editInfo.SetText("[yellow]" + tview.Escape(why) + "[-]")
	}
	u.fillEditBands()
}

func (u *UI) checkEdit() {
	b := &u.bands
	if b.editProbing {
		return
	}
	url, pw := strings.TrimSpace(b.editURL.GetText()), b.editPW.GetText()
	if _, err := ubersdr.NormalizeURL(url); err != nil {
		b.editInfo.SetText("[red]" + tview.Escape(err.Error()) + "[-]")
		return
	}
	b.editProbing = true
	b.editInfo.SetText("[yellow]Checking " + tview.Escape(url) + " ...[-]")
	go func() {
		p, err := u.d.probe(u.ctx, url, pw)
		u.app.QueueUpdateDraw(func() {
			b.editProbing = false
			if err != nil {
				b.editInfo.SetText("[red]" + tview.Escape(err.Error()) + "[-]")
				return
			}
			key := probeKey(url, pw)
			b.editProbe, b.editProbeKey = p, key
			b.probes[key] = p
			// Bands a now-known range cannot reach come off.
			for name := range b.editBands {
				if band, ok := hpsdr.BandNamed(name); ok {
					if ok, _ := u.bandAllowed(band); !ok {
						delete(b.editBands, name)
					}
				}
			}
			b.editInfo.SetText(renderProbe(p))
			u.fillEditBands()
		})
	}()
}

func (u *UI) saveEdit() {
	b := &u.bands
	bi := app.BandInstance{URL: strings.TrimSpace(b.editURL.GetText()), Password: b.editPW.GetText()}
	for _, band := range hpsdr.Bands {
		if b.editBands[band.Name] {
			bi.Bands = append(bi.Bands, band.Name)
		}
	}
	list := append([]app.BandInstance(nil), b.list...)
	if b.editIdx >= 0 {
		list[b.editIdx] = bi
	} else {
		list = append(list, bi)
	}
	if err := app.ValidateBandInstances(u.url.GetText(), list); err != nil {
		b.editInfo.SetText("[red]" + tview.Escape(err.Error()) + "[-]")
		return
	}
	b.list = list
	if b.editIdx < 0 {
		b.editIdx = len(list) - 1
	}
	u.fillBands()
	b.table.Select(b.editIdx+1, 0)
	u.pages.SwitchToPage("bands")
	u.app.SetFocus(b.table)
}

func (u *UI) cancelEdit() {
	u.fillBands()
	u.pages.SwitchToPage("bands")
	u.app.SetFocus(u.bands.table)
}

// ---- checking them all -------------------------------------------------------------

// staleBands are the band receivers not checked with their current URL and
// password.
func (u *UI) staleBands() []app.BandInstance {
	var out []app.BandInstance
	for _, bi := range u.bands.list {
		if u.bands.probes[probeKey(bi.URL, bi.Password)] == nil {
			out = append(out, bi)
		}
	}
	return out
}

// probeBands checks band receivers in the background, then runs next.
func (u *UI) probeBands(list []app.BandInstance, next func()) {
	if u.probing {
		return
	}
	u.probing = true
	u.info.SetText(fmt.Sprintf("[yellow]Checking %d band receiver(s) ...[-]", len(list)))
	go func() {
		probes := make([]*app.Probe, len(list))
		errs := make([]error, len(list))
		done := make(chan int)
		for i, bi := range list {
			go func(i int, bi app.BandInstance) {
				probes[i], errs[i] = u.d.probe(u.ctx, bi.URL, bi.Password)
				done <- i
			}(i, bi)
		}
		for range list {
			<-done
		}
		u.app.QueueUpdateDraw(func() {
			u.probing = false
			for i, bi := range list {
				if errs[i] != nil {
					u.info.SetText("[red]" + tview.Escape(hostOf(bi.URL)+": "+errs[i].Error()) + "[-]")
					return
				}
				u.bands.probes[probeKey(bi.URL, bi.Password)] = probes[i]
			}
			u.refreshAllowed()
			if next != nil {
				next()
			}
		})
	}()
}

// allProbes is the main probe and each band receiver's, in settings order, or
// nil if any is missing.
func (u *UI) allProbes() []*app.Probe {
	if u.probe == nil || u.probeKey != u.key() {
		return nil
	}
	out := []*app.Probe{u.probe}
	for _, bi := range u.bands.list {
		p := u.bands.probes[probeKey(bi.URL, bi.Password)]
		if p == nil {
			return nil
		}
		out = append(out, p)
	}
	return out
}

// refreshAllowed greys out the rates some checked receiver does not allow.
func (u *UI) refreshAllowed() {
	if u.probe == nil || u.probeKey != u.key() || !u.probe.Reached || !u.probe.Conn.Allowed {
		if u.probe == nil || u.probeKey != u.key() {
			u.applyAllowed(nil)
		}
		return
	}
	probes := []*app.Probe{u.probe}
	for _, bi := range u.bands.list {
		if p := u.bands.probes[probeKey(bi.URL, bi.Password)]; p != nil && p.Reached && p.Conn.Allowed {
			probes = append(probes, p)
		}
	}
	allowed, _ := app.IntersectAllowed(probes)
	u.applyAllowed(allowed)
	u.info.SetText(u.renderSetupInfo())
}

// renderSetupInfo is the main check, and with band receivers what they add.
func (u *UI) renderSetupInfo() string {
	text := renderProbe(u.probe)
	if len(u.bands.list) == 0 {
		return text
	}
	// The panel is small; what the rates line would say, the per-rate lines
	// below say more exactly.
	text = strings.TrimSuffix(text, "\n[gray]Rates the receiver does not allow this session are greyed out. "+
		"The ones ticked are what HPSDR clients are offered.[-]")
	var b strings.Builder
	b.WriteString("\n\n[::b]Band receivers[::-]\n")
	for _, bi := range u.bands.list {
		line := "[gray]not checked yet[-]"
		if p := u.bands.probes[probeKey(bi.URL, bi.Password)]; p != nil {
			line = probeLine(p)
		}
		b.WriteString(tview.Escape(strings.Join(bi.Bands, " ")) + ": " + line + "\n")
	}
	if probes := u.allProbes(); probes != nil {
		s, _ := u.settings()
		_, blocked := app.IntersectAllowed(probes)
		for _, k := range rates {
			if by := blocked[k]; len(by) > 0 {
				b.WriteString(fmt.Sprintf("[yellow]%d kHz: not allowed by %s[-]\n", k, tview.Escape(strings.Join(by, ", "))))
			}
		}
		for _, n := range app.CoverageNotes(s, probes) {
			b.WriteString("[yellow]" + tview.Escape(n) + "[-]\n")
		}
	}
	return text + b.String()
}
