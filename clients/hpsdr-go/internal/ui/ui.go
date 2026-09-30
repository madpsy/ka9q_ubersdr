// Package ui is the terminal interface: a setup screen to choose the receiver
// and how the radio presents itself, and a status screen while it runs.
//
// It is tview on tcell, both pure Go, so the binary stays CGO-free and one
// machine builds it for every platform -- the same reason clients/tui is.
package ui

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/app"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/hpsdr"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// bridgeHandle is what the status screen needs from a running bridge.
type bridgeHandle interface {
	Start()
	Close()
	Status() hpsdr.Status
}

// deps is everything the UI reaches outside itself for, so tests can stand in
// for the network, the sockets and the settings file.
type deps struct {
	probe      func(ctx context.Context, url, password string) (*app.Probe, error)
	build      func(app.Settings, []*app.Probe, func(string)) (bridgeHandle, []string, error)
	directory  func(ctx context.Context) ([]ubersdr.Instance, error)
	local      func(ctx context.Context) *ubersdr.LocalDiscovery
	interfaces func() ([]hpsdr.Iface, error)
	defaultIf  func() (hpsdr.Iface, error)
	save       func(app.Settings) error
}

func realDeps(settingsPath string) deps {
	return deps{
		probe: app.RunProbe,
		build: func(s app.Settings, p []*app.Probe, logf func(string)) (bridgeHandle, []string, error) {
			b, notes, err := app.Build(s, p, logf)
			if err != nil {
				return nil, notes, err
			}
			return b, notes, nil
		},
		directory: func(ctx context.Context) ([]ubersdr.Instance, error) { return ubersdr.FetchDirectory(ctx, "") },
		local: func(ctx context.Context) *ubersdr.LocalDiscovery {
			d := ubersdr.NewLocalDiscovery()
			go func() { _ = d.Run(ctx) }()
			return d
		},
		interfaces: hpsdr.Interfaces,
		defaultIf:  hpsdr.DefaultInterface,
		save: func(s app.Settings) error {
			if settingsPath == "" {
				return nil
			}
			return app.Save(settingsPath, s)
		},
	}
}

// Run shows the UI until the operator quits.
func Run(s app.Settings, settingsPath, version string) error {
	u := newUI(s, realDeps(settingsPath), version)
	defer u.shutdown()
	return u.app.Run()
}

var rates = []int{48, 96, 192, 384}

// formWidth fits the setup form beside a usable receiver panel in 80 columns.
const formWidth = 50

// UI is the whole application.
type UI struct {
	app     *tview.Application
	pages   *tview.Pages
	d       deps
	version string

	ctx    context.Context
	cancel context.CancelFunc

	// setup
	form     *tview.Form
	url      *tview.InputField
	password *tview.InputField
	remember *tview.Checkbox
	rx       *tview.DropDown
	device   *tview.DropDown
	margin   *tview.InputField
	rate     [4]*tview.Checkbox
	iface    *tview.DropDown
	info     *tview.TextView
	hint     *tview.TextView
	ifaces   []hpsdr.Iface
	base     app.Settings

	probe    *app.Probe
	probeKey string
	probing  bool

	bands bandState

	// picker
	picker     *tview.Flex
	filter     *tview.InputField
	list       *tview.List
	listed     []ubersdr.Instance
	directory  []ubersdr.Instance
	dirErr     error
	dirLoading bool
	local      *ubersdr.LocalDiscovery
	// pickTarget takes the receiver picked, and pickBack and pickFocus are
	// where Esc or a pick returns to: the setup screen or a band receiver.
	pickTarget func(ubersdr.Instance)
	pickBack   string
	pickFocus  tview.Primitive

	// running
	bridge   bridgeHandle
	running  *tview.Flex
	header   *tview.TextView
	table    *tview.Table
	ddcBox   *tview.Flex
	legend   *tview.TextView
	logView  *tview.TextView
	logMu    sync.Mutex
	logQueue []string
	tick     chan struct{}
	started  time.Time
	server   string
	proc     procStats
}

func newUI(s app.Settings, d deps, version string) *UI {
	u := &UI{app: tview.NewApplication(), d: d, version: version, base: s}
	u.bands.probes = map[string]*app.Probe{}
	u.bands.list = append([]app.BandInstance(nil), s.BandInstances...)
	u.ctx, u.cancel = context.WithCancel(context.Background())
	if d.local != nil {
		u.local = d.local(u.ctx)
		go u.watchLocal()
	}
	u.pages = tview.NewPages()
	u.pages.AddPage("setup", u.buildSetup(s), true, true)
	u.pages.AddPage("picker", u.buildPicker(), true, false)
	u.pages.AddPage("bands", u.buildBands(), true, false)
	u.pages.AddPage("bandedit", u.buildBandEdit(), true, false)
	u.pages.AddPage("running", u.buildRunning(), true, false)
	u.app.SetRoot(u.pages, true).EnableMouse(true)
	u.app.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		if ev.Key() == tcell.KeyCtrlC {
			u.quit()
			return nil
		}
		return ev
	})
	return u
}

func (u *UI) shutdown() {
	u.cancel()
	if u.bridge != nil {
		u.bridge.Close()
		u.bridge = nil
	}
}

func (u *UI) quit() {
	u.shutdown()
	u.app.Stop()
}

// ---- setup screen -----------------------------------------------------------

func (u *UI) buildSetup(s app.Settings) tview.Primitive {
	u.form = tview.NewForm()
	u.form.SetBorder(true).SetTitle(" UberSDR HPSDR bridge ").SetTitleAlign(tview.AlignLeft)
	u.form.SetItemPadding(0)

	u.url = tview.NewInputField().SetLabel("Receiver URL").SetText(s.URL).SetFieldWidth(0)
	u.password = tview.NewInputField().SetLabel("Password").SetText(s.Password).SetFieldWidth(0).SetMaskCharacter('*')
	u.remember = boxStyle(tview.NewCheckbox().SetLabel("Remember password").SetChecked(s.RememberPassword))
	// A changed URL or password makes the last check stale; say so rather
	// than keep showing what a different receiver said.
	u.url.SetChangedFunc(func(string) { u.markStale() })
	u.password.SetChangedFunc(func(string) { u.markStale() })

	rxOpts := make([]string, hpsdr.MaxReceivers)
	for i := range rxOpts {
		rxOpts[i] = strconv.Itoa(i + 1)
	}
	cur := s.Receivers - 1
	if cur < 0 || cur >= hpsdr.MaxReceivers {
		cur = hpsdr.MaxReceivers - 1
	}
	u.rx = tview.NewDropDown().SetLabel("Receivers").SetOptions(rxOpts, nil).SetCurrentOption(cur)

	dev := 0
	if s.Device == hpsdr.DeviceHermes {
		dev = 1
	}
	u.device = tview.NewDropDown().SetLabel("Present as").
		SetOptions([]string{"Hermes Lite 2", "Hermes"}, nil).SetCurrentOption(dev)

	u.margin = tview.NewInputField().SetLabel("IQ margin dB").SetFieldWidth(5).
		SetText(strconv.Itoa(s.MinMargin)).
		SetAcceptanceFunc(func(t string, _ rune) bool {
			_, err := strconv.ParseFloat(t, 64)
			return t == "" || err == nil
		})

	want := map[int]bool{}
	for _, r := range s.Rates {
		want[r] = true
	}
	for i, r := range rates {
		u.rate[i] = boxStyle(tview.NewCheckbox().SetLabel(fmt.Sprintf("Offer %d kHz", r)).SetChecked(len(s.Rates) == 0 || want[r]))
	}

	u.iface = tview.NewDropDown().SetLabel("Network interface")
	u.loadInterfaces(s.Interface)

	u.bands.field = newLinkField("Band receivers", u.showBands)
	u.refreshBandsField()

	u.form.AddFormItem(u.url).AddFormItem(u.password).AddFormItem(u.remember).AddFormItem(u.bands.field).
		AddFormItem(u.rx).AddFormItem(u.device).AddFormItem(u.margin)
	for _, c := range u.rate {
		u.form.AddFormItem(c)
	}
	u.form.AddFormItem(u.iface)
	u.form.AddButton("Check", u.runProbe).
		AddButton("Browse", u.showPicker).
		AddButton("Start", u.start).
		AddButton("Quit", u.quit)

	u.info = tview.NewTextView().SetDynamicColors(true).SetWrap(true).SetWordWrap(true)
	u.info.SetBorder(true).SetTitle(" Receiver ").SetTitleAlign(tview.AlignLeft)
	u.info.SetText("[gray]Enter a receiver's URL and choose Check, or Browse the public and local receivers.[-]")

	u.hint = tview.NewTextView().SetDynamicColors(true)
	u.hint.SetText("[gray]Tab moves · Enter selects · IQ margin: 0 lossless, 15-60 dB · Ctrl-C quits[-]")

	// The form is a fixed width so it fits an 80-column terminal beside the
	// receiver panel; the panel takes whatever is left.
	top := tview.NewFlex().
		AddItem(u.form, formWidth, 0, true).
		AddItem(u.info, 0, 1, false)
	return tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(top, 0, 1, true).
		AddItem(u.hint, 1, 0, false)
}

func (u *UI) loadInterfaces(selected string) {
	opts := []string{"Automatic (all networks)"}
	if u.d.defaultIf != nil {
		if def, err := u.d.defaultIf(); err == nil {
			opts[0] = fmt.Sprintf("Auto: %s, all", def.Name)
		}
	}
	u.ifaces = nil
	if u.d.interfaces != nil {
		u.ifaces, _ = u.d.interfaces()
	}
	cur := 0
	for i, ifc := range u.ifaces {
		opts = append(opts, fmt.Sprintf("%s only", ifc))
		if ifc.Name == selected {
			cur = i + 1
		}
	}
	if selected != "" && cur == 0 {
		// Saved or given but not up now: keep it rather than silently widening
		// to every network.
		opts = append(opts, selected+" (not found)")
		u.ifaces = append(u.ifaces, hpsdr.Iface{Name: selected})
		cur = len(opts) - 1
	}
	u.iface.SetOptions(opts, nil).SetCurrentOption(cur)
}

// settings reads the form.
func (u *UI) settings() (app.Settings, error) {
	s := u.base
	s.URL = strings.TrimSpace(u.url.GetText())
	s.Password = u.password.GetText()
	s.RememberPassword = u.remember.IsChecked()
	i, _ := u.rx.GetCurrentOption()
	s.Receivers = i + 1
	if d, _ := u.device.GetCurrentOption(); d == 1 {
		s.Device = hpsdr.DeviceHermes
	} else {
		s.Device = hpsdr.DeviceHermesLite
	}
	dB, _, err := ubersdr.ParseMinMargin(u.margin.GetText())
	if err != nil {
		return s, err
	}
	s.MinMargin = dB
	s.Rates = nil
	all := true
	for i, c := range u.rate {
		if c.IsChecked() {
			s.Rates = append(s.Rates, rates[i])
		} else {
			all = false
		}
	}
	if len(s.Rates) == 0 {
		return s, fmt.Errorf("choose at least one rate to offer")
	}
	if all {
		s.Rates = nil // every rate the receiver allows
	}
	s.BandInstances = nil
	if len(u.bands.list) > 0 {
		s.BandInstances = append([]app.BandInstance(nil), u.bands.list...)
	}
	if n, _ := u.iface.GetCurrentOption(); n > 0 && n-1 < len(u.ifaces) {
		s.Interface = u.ifaces[n-1].Name
	} else {
		s.Interface = ""
	}
	return s, s.Validate()
}

func (u *UI) key() string { return strings.TrimSpace(u.url.GetText()) + "\x00" + u.password.GetText() }

func (u *UI) markStale() {
	if u.probe != nil && u.key() != u.probeKey {
		u.info.SetText("[gray]Changed since the last check. Choose Check to ask the receiver again.[-]")
		u.applyAllowed(nil)
	}
}

// runProbe asks the receiver what it allows, in the background.
func (u *UI) runProbe() { u.probeThen(nil) }

func (u *UI) probeThen(next func()) {
	if u.probing {
		return
	}
	if _, err := ubersdr.NormalizeURL(u.url.GetText()); err != nil {
		u.info.SetText("[red]" + tview.Escape(err.Error()) + "[-]")
		return
	}
	u.probing = true
	key := u.key()
	url, pw := strings.TrimSpace(u.url.GetText()), u.password.GetText()
	u.info.SetText("[yellow]Checking " + tview.Escape(url) + " ...[-]")
	go func() {
		p, err := u.d.probe(u.ctx, url, pw)
		u.app.QueueUpdateDraw(func() {
			u.probing = false
			if err != nil {
				u.info.SetText("[red]" + tview.Escape(err.Error()) + "[-]")
				return
			}
			u.probe, u.probeKey = p, key
			u.info.SetText(u.renderSetupInfo())
			if p.Reached && p.Conn.Allowed {
				u.refreshAllowed()
			} else {
				u.applyAllowed(nil)
			}
			if next != nil {
				next()
			}
		})
	}()
}

// applyAllowed marks the rates this session may not use. nil means unknown:
// everything is selectable.
func (u *UI) applyAllowed(allowed []int) {
	ok := map[int]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	// tview's SetDisabled tells the form the item is "finished", which moves
	// focus to the next item; a check result arriving would otherwise yank the
	// cursor off the Check button.
	focused := u.app.GetFocus()
	defer func() {
		if focused != nil {
			u.app.SetFocus(focused)
		}
	}()
	for i, r := range rates {
		// Marked in the box, not the label: a longer label widens the whole
		// form's label column.
		c := u.rate[i]
		if allowed == nil || ok[r] {
			boxStyle(c)
			c.SetDisabled(false)
		} else {
			na := tview.Escape("[-] not allowed")
			c.SetCheckedString(na).SetUncheckedString(na)
			c.SetDisabled(true)
		}
	}
}

func renderProbe(p *app.Probe) string {
	var b strings.Builder
	for i, line := range p.Summary() {
		esc := tview.Escape(line)
		switch {
		case i == 0:
			b.WriteString("[::b]" + esc + "[::-]\n\n")
		case strings.HasPrefix(line, "Not reachable"), strings.HasPrefix(line, "Refused"):
			b.WriteString("[red]" + esc + "[-]\n")
		case strings.HasPrefix(line, "Allowed"):
			b.WriteString("[green]" + esc + "[-]\n")
		case strings.Contains(line, "none open"), strings.Contains(line, "inverted"):
			b.WriteString("[yellow]" + esc + "[-]\n")
		default:
			b.WriteString(esc + "\n")
		}
	}
	if p.Reached && p.Conn.Allowed {
		b.WriteString("\n[gray]Rates the receiver does not allow this session are greyed out. " +
			"The ones ticked are what HPSDR clients are offered.[-]")
	}
	return b.String()
}

// start checks the receiver if the last check is stale, then runs the bridge.
func (u *UI) start() {
	s, err := u.settings()
	if err != nil {
		u.info.SetText("[red]" + tview.Escape(err.Error()) + "[-]")
		return
	}
	if u.probe == nil || u.probeKey != u.key() {
		u.probeThen(u.start)
		return
	}
	if stale := u.staleBands(); len(stale) > 0 {
		u.probeBands(stale, u.start)
		return
	}
	probes := u.allProbes()
	u.logMu.Lock()
	u.logQueue = nil
	u.logMu.Unlock()
	u.logView.Clear()
	b, notes, err := u.d.build(s, probes, u.logf)
	for _, n := range notes {
		u.logf(n)
	}
	if err != nil {
		u.info.SetText("[red]Could not start: " + tview.Escape(err.Error()) + "[-]\n\n" + u.renderSetupInfo())
		return
	}
	if u.d.save != nil {
		if err := u.d.save(s); err != nil {
			u.logf("Settings not saved: " + err.Error())
		}
	}
	u.base = s
	u.bridge = b
	u.server = u.probe.Server.Base
	u.started = time.Now()
	u.proc = procStats{}
	u.proc.sample(u.started)
	b.Start()
	// Every DDC visible: header, borders and one row each; the log gets the rest.
	u.running.ResizeItem(u.ddcBox, s.Receivers+3+legendLines(s), 0)
	u.logView.ScrollToEnd()
	u.pages.SwitchToPage("running")
	u.app.SetFocus(u.table)
	u.tick = make(chan struct{})
	go u.ticker(u.tick, b)
	u.refresh()
}

// ---- instance picker ----------------------------------------------------------

func (u *UI) buildPicker() tview.Primitive {
	u.filter = tview.NewInputField().SetLabel("Filter ").SetFieldWidth(30)
	u.filter.SetChangedFunc(func(string) { u.fillList() })
	u.list = tview.NewList().ShowSecondaryText(true)
	wheelList(u.list)
	u.list.SetBorder(true).SetTitle(" Receivers ").SetTitleAlign(tview.AlignLeft)
	u.list.SetSelectedFunc(func(i int, _, _ string, _ rune) { u.pick(i) })
	help := tview.NewTextView().SetDynamicColors(true).
		SetText("[gray]Type to filter · Tab/↓ to the list · Enter picks · Esc goes back[-]")

	u.filter.SetDoneFunc(func(k tcell.Key) {
		switch k {
		case tcell.KeyEscape:
			u.hidePicker()
		case tcell.KeyTab, tcell.KeyDown, tcell.KeyEnter:
			u.app.SetFocus(u.list)
		}
	})
	u.list.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch ev.Key() {
		case tcell.KeyEscape:
			u.hidePicker()
			return nil
		case tcell.KeyTab, tcell.KeyBacktab:
			u.app.SetFocus(u.filter)
			return nil
		case tcell.KeyRune:
			// Typing in the list goes to the filter.
			u.app.SetFocus(u.filter)
			u.filter.SetText(u.filter.GetText() + string(ev.Rune()))
			return nil
		}
		return ev
	})
	u.picker = tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(u.filter, 1, 0, true).
		AddItem(u.list, 0, 1, false).
		AddItem(help, 1, 0, false)
	return u.picker
}

// showPicker picks the setup screen's receiver.
func (u *UI) showPicker() {
	u.showPickerFor(func(inst ubersdr.Instance) {
		u.url.SetText(inst.URL())
		u.runProbe()
	}, "setup", u.form)
}

// showPickerFor picks a receiver for target, returning to page and focus.
func (u *UI) showPickerFor(target func(ubersdr.Instance), page string, focus tview.Primitive) {
	u.pickTarget, u.pickBack, u.pickFocus = target, page, focus
	u.pages.SwitchToPage("picker")
	u.app.SetFocus(u.filter)
	u.fillList()
	if u.directory == nil && !u.dirLoading && u.d.directory != nil {
		u.dirLoading = true
		go func() {
			list, err := u.d.directory(u.ctx)
			u.app.QueueUpdateDraw(func() {
				u.dirLoading = false
				u.directory, u.dirErr = list, err
				if list == nil && err == nil {
					u.directory = []ubersdr.Instance{}
				}
				u.fillList()
			})
		}()
	}
}

func (u *UI) hidePicker() {
	if u.pickBack == "" {
		u.pickBack, u.pickFocus = "setup", u.form
	}
	u.pages.SwitchToPage(u.pickBack)
	u.app.SetFocus(u.pickFocus)
}

// watchLocal refreshes the list as LAN receivers are found.
func (u *UI) watchLocal() {
	for {
		select {
		case <-u.ctx.Done():
			return
		case <-u.local.Updates:
			u.app.QueueUpdateDraw(u.fillList)
		}
	}
}

func (u *UI) fillList() {
	f := u.filter.GetText()
	// Rebuilt whenever a LAN receiver turns up, which must not throw away
	// the operator's place in the list.
	keep := ""
	if cur := u.list.GetCurrentItem(); cur >= 0 && cur < len(u.listed) {
		keep = u.listed[cur].URL()
	}
	u.list.Clear()
	u.listed = nil
	add := func(i ubersdr.Instance) {
		if !i.Matches(f) {
			return
		}
		where := "public"
		if i.Local {
			where = "LAN"
		}
		detail := []string{where, i.URL()}
		if i.Location != "" {
			detail = append(detail, i.Location)
		}
		if len(i.PublicIQModes) > 0 {
			detail = append(detail, "public "+strings.Join(i.PublicIQModes, " "))
		}
		if i.Available >= 0 && i.MaxClients > 0 {
			detail = append(detail, fmt.Sprintf("%d/%d free", i.Available, i.MaxClients))
		}
		u.list.AddItem(tview.Escape(i.Label()), "  "+tview.Escape(strings.Join(detail, " · ")), 0, nil)
		u.listed = append(u.listed, i)
	}
	if u.local != nil {
		for _, i := range u.local.Instances() {
			add(i)
		}
	}
	for _, i := range u.directory {
		add(i)
	}
	for i, inst := range u.listed {
		if keep != "" && inst.URL() == keep {
			u.list.SetCurrentItem(i)
			break
		}
	}
	title := fmt.Sprintf(" Receivers (%d) ", len(u.listed))
	switch {
	case u.dirLoading:
		title = " Receivers: loading the public directory ... "
	case u.dirErr != nil:
		title = " Receivers: directory unavailable (" + tview.Escape(u.dirErr.Error()) + ") "
	}
	u.list.SetTitle(title)
}

func (u *UI) pick(i int) {
	if i < 0 || i >= len(u.listed) {
		return
	}
	target := u.pickTarget
	u.hidePicker()
	if target != nil {
		target(u.listed[i])
	}
}

// ---- running screen ------------------------------------------------------------

func (u *UI) buildRunning() tview.Primitive {
	u.header = tview.NewTextView().SetDynamicColors(true)
	u.table = tview.NewTable().SetFixed(1, 0).SetSelectable(false, false)
	u.legend = tview.NewTextView().SetDynamicColors(true).SetWrap(true).SetWordWrap(true)
	u.ddcBox = tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(u.table, 0, 1, true).
		AddItem(u.legend, 1, 0, false)
	u.ddcBox.SetBorder(true).SetTitle(" Receivers ").SetTitleAlign(tview.AlignLeft)
	u.logView = tview.NewTextView().SetDynamicColors(false).SetMaxLines(2000).
		SetChangedFunc(func() {})
	u.logView.SetBorder(true).SetTitle(" Log ").SetTitleAlign(tview.AlignLeft)
	foot := tview.NewTextView().SetDynamicColors(true).
		SetText("[gray]s/Esc stop and return to setup · q quit · ↑↓ scroll the log[-]")
	u.running = tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(u.header, 3, 0, false).
		AddItem(u.ddcBox, 0, 1, true).
		AddItem(u.logView, 0, 1, false).
		AddItem(foot, 1, 0, false)
	u.running.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch {
		case ev.Key() == tcell.KeyEscape, ev.Key() == tcell.KeyRune && ev.Rune() == 's':
			u.stop()
			return nil
		case ev.Key() == tcell.KeyRune && ev.Rune() == 'q':
			u.quit()
			return nil
		case ev.Key() == tcell.KeyUp, ev.Key() == tcell.KeyDown, ev.Key() == tcell.KeyPgUp, ev.Key() == tcell.KeyPgDn:
			u.logView.InputHandler()(ev, nil)
			return nil
		}
		return ev
	})
	return u.running
}

// logf queues a line from any goroutine; the ticker writes it out.
func (u *UI) logf(line string) {
	ts := time.Now().Format("15:04:05")
	u.logMu.Lock()
	u.logQueue = append(u.logQueue, ts+" "+line)
	u.logMu.Unlock()
}

// ticker redraws the running screen, but only when something on it has
// changed: redrawing a screen that had not changed four times a second was
// nearly all the CPU the bridge used with no client. Idle, the uptime still
// changes once a second, so it redraws once a second; streaming, the counters
// change every time and it redraws every tick.
func (u *UI) ticker(stop chan struct{}, b bridgeHandle) {
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	last := ""
	for {
		select {
		case <-stop:
			return
		case <-u.ctx.Done():
			return
		case <-t.C:
		}
		u.logMu.Lock()
		logs := len(u.logQueue) > 0
		u.logMu.Unlock()
		sig := fmt.Sprintf("%v|%d", b.Status(), time.Since(u.started)/time.Second)
		if sig == last && !logs {
			continue
		}
		last = sig
		u.app.QueueUpdateDraw(u.refresh)
	}
}

func (u *UI) stop() {
	if u.tick != nil {
		close(u.tick)
		u.tick = nil
	}
	b := u.bridge
	u.bridge = nil
	if b != nil {
		b.Close()
	}
	u.flushLog()
	u.pages.SwitchToPage("setup")
	u.app.SetFocus(u.form)
	if u.probe != nil {
		u.info.SetText(u.renderSetupInfo() + "\n\n[gray]Bridge stopped.[-]")
	}
}

func (u *UI) flushLog() {
	u.logMu.Lock()
	q := u.logQueue
	u.logQueue = nil
	u.logMu.Unlock()
	if len(q) == 0 {
		return
	}
	// The view follows the end by itself until the operator scrolls up, and
	// again once they scroll back down; a new line must not move them.
	_, _ = u.logView.Write([]byte(strings.Join(q, "\n") + "\n"))
}

// refresh redraws the running screen from the bridge's status.
func (u *UI) refresh() {
	u.flushLog()
	if u.bridge == nil {
		return
	}
	st := u.bridge.Status()
	now := time.Now()
	client := "[yellow]waiting for an HPSDR client (discovery on UDP 1024)[-]"
	switch st.Protocol {
	case 1:
		client = "[green]protocol 1 client " + tview.Escape(st.Client) + "[-]"
	case 2:
		client = "[green]protocol 2 client " + tview.Escape(st.Client) + "[-]"
	}
	up := time.Since(u.started).Truncate(time.Second)
	server := tview.Escape(u.server)
	if n := len(st.Routes) - 1; n > 0 {
		server += fmt.Sprintf(" + %d band receiver", n)
		if n > 1 {
			server += "s"
		}
	}
	u.proc.sample(now)
	from := "UberSDR"
	if len(st.Routes) > 1 {
		from = "instances"
	}
	head := fmt.Sprintf(" [::b]%s[::-]  up %s  version %s\n %s\n IQ from %s %s · to client %s   %s",
		server, up, tview.Escape(u.version), client, from, rate(st.TotalKbps), rate(st.TotalOutKbps), u.proc.String())
	// An instance holding DDCs back gets a line of its own: several DDCs
	// waiting on one instance are one problem, not several.
	headLines := 3
	for _, r := range st.Routes {
		if r.LimitedUntil.IsZero() {
			continue
		}
		waiting := 0
		for _, rx := range st.Receivers {
			if rx.State == hpsdr.RxRateLimited && rx.Instance == r.Name {
				waiting++
			}
		}
		head += fmt.Sprintf("\n [yellow]%s: rate limited, %d DDC(s) waiting, retry in %s[-]",
			tview.Escape(routeLabel(r.Callsign, r.Name)), waiting, secondsUntil(now, r.LimitedUntil))
		headLines++
	}
	u.header.SetText(head)
	u.running.ResizeItem(u.header, headLines, 0)

	const detailCol = 8
	heads := []string{"DDC", "Socket", "Rate", "Frequency", "Instance", "Why", "In kbps", "Packets", "Detail"}
	u.table.Clear()
	for c, h := range heads {
		u.table.SetCell(0, c, tview.NewTableCell(h).SetAttributes(tcell.AttrBold).SetSelectable(false).SetExpansion(boolInt(c == detailCol)))
	}
	for r, rx := range st.Receivers {
		row := r + 1
		color := tcell.ColorGray
		switch rx.State {
		case hpsdr.RxStreaming:
			color = tcell.ColorGreen
		case hpsdr.RxConnecting, hpsdr.RxSwitching, hpsdr.RxRateLimited:
			color = tcell.ColorYellow
		case hpsdr.RxRefused, hpsdr.RxNotOffered, hpsdr.RxError, hpsdr.RxOutOfRange:
			color = tcell.ColorRed
		}
		rate, freq := "", ""
		if rx.RateKHz > 0 {
			rate = fmt.Sprintf("%d kHz", rx.RateKHz)
		}
		if rx.FreqHz > 0 {
			freq = fmt.Sprintf("%.6f MHz", float64(rx.FreqHz)/1e6)
		}
		kbps := ""
		if rx.Kbps > 0 {
			kbps = fmt.Sprintf("%.0f", rx.Kbps)
		}
		inst, why := "", ""
		if rx.State == hpsdr.RxOutOfRange {
			why = string(rune(hpsdr.WhyOut))
		} else if rx.State != hpsdr.RxIdle && rx.State != hpsdr.RxNotOffered {
			inst = routeLabel(rx.Callsign, rx.Instance)
			if rx.Why != hpsdr.WhyNone {
				why = string(rune(rx.Why))
			}
		}
		detail := rx.Detail
		if !rx.RetryAt.IsZero() {
			// The Instance column already says who; the countdown is the news.
			detail = "retry in " + secondsUntil(now, rx.RetryAt)
		}
		cells := []string{fmt.Sprint(rx.Index), rx.State.String(), rate, freq, inst, why, kbps,
			count(rx.Packets), detail}
		for c, v := range cells {
			cell := tview.NewTableCell(tview.Escape(v)).SetExpansion(boolInt(c == detailCol))
			switch c {
			case 1:
				cell.SetTextColor(color)
			case 4:
				cell.SetMaxWidth(10)
			case 5:
				cell.SetAlign(tview.AlignCenter)
			case 6, 7:
				cell.SetAlign(tview.AlignRight)
			}
			u.table.SetCell(row, c, cell)
		}
	}

	_, _, width, _ := u.ddcBox.GetInnerRect()
	lines := legend(st, width)
	u.legend.SetText(strings.Join(lines, "\n"))
	u.ddcBox.ResizeItem(u.legend, len(lines), 0)
	u.running.ResizeItem(u.ddcBox, len(st.Receivers)+3+len(lines), 0)
}

// legend explains the Why letters and, with band receivers, which callsign
// takes which bands, packed into lines of at most width.
func legend(st hpsdr.Status, width int) []string {
	if width < 20 {
		width = 78
	}
	var keys []string
	for _, k := range hpsdr.WhyKeys {
		keys = append(keys, fmt.Sprintf("%c %s", k.Why, k.Text))
	}
	lines := pack("[gray]Why: ", keys, width)
	if len(st.Routes) > 1 {
		var who []string
		for _, r := range st.Routes {
			bands := "everything else"
			if !r.CatchAll {
				bands = strings.Join(r.Bands, " ")
			}
			who = append(who, routeLabel(r.Callsign, r.Name)+": "+bands)
		}
		lines = append(lines, pack("[gray]", who, width)...)
	}
	for i := range lines {
		lines[i] += "[-]"
	}
	return lines
}

// pack joins parts with " · " into lines no wider than width, the first
// starting with prefix (a colour tag, so it takes no width beyond its text).
func pack(prefix string, parts []string, width int) []string {
	var lines []string
	line := prefix
	for i, p := range parts {
		sep := ""
		if i > 0 {
			sep = " · "
		}
		p = tview.Escape(p)
		if tview.TaggedStringWidth(line+sep+p) > width && tview.TaggedStringWidth(line) > 0 {
			lines = append(lines, line)
			line, sep = "[gray]", ""
		}
		line += sep + p
	}
	return append(lines, line)
}

// routeLabel is an instance's callsign, or its host if it has none.
func routeLabel(callsign, host string) string {
	if callsign != "" {
		return callsign
	}
	return host
}

// legendLines is the legend's height before the first status arrives.
func legendLines(s app.Settings) int {
	if len(s.BandInstances) > 0 {
		return 2
	}
	return 1
}

// count is a packet count short enough for its column: exact to 9999, then
// with a unit and two decimals. 384 kHz is 1600 packets a second, so an
// evening's session runs to tens of millions.
func count(n uint64) string {
	switch {
	case n < 10_000:
		return fmt.Sprint(n)
	case n < 999_995: // above rounds to 1000.00k: say 1.00M instead
		return fmt.Sprintf("%.2fk", float64(n)/1e3)
	case n < 999_995_000:
		return fmt.Sprintf("%.2fM", float64(n)/1e6)
	}
	return fmt.Sprintf("%.2fG", float64(n)/1e9)
}

// rate is a bit rate in kbps, switching to Mbps where kbps gets long: the IQ
// sent to a client is 18 Mbps per 384 kHz DDC.
func rate(kbps float64) string {
	if kbps >= 10_000 {
		return fmt.Sprintf("%.1f Mbps", kbps/1000)
	}
	return fmt.Sprintf("%.0f kbps", kbps)
}

func secondsUntil(now, t time.Time) string {
	d := t.Sub(now)
	if d < 0 {
		d = 0
	}
	return fmt.Sprintf("%ds", int((d+time.Second-1)/time.Second))
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// boxStyle draws a checkbox as [x] or [ ], which reads as a checkbox on any
// terminal; tview's default leaves an unchecked box blank. Escaped, because
// tview reads "[x]" as a style tag and prints nothing.
func boxStyle(c *tview.Checkbox) *tview.Checkbox {
	return c.SetCheckedString(tview.Escape("[x]")).SetUncheckedString(tview.Escape("[ ]"))
}
