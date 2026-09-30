package ui

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/app"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/hpsdr"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// The UI on a simulated screen: real key events, real drawing, and the network,
// sockets and settings file stood in for.

type fakeBridge struct {
	mu      sync.Mutex
	started bool
	closed  bool
	status  hpsdr.Status
}

func (f *fakeBridge) Start() { f.mu.Lock(); f.started = true; f.mu.Unlock() }
func (f *fakeBridge) Close() { f.mu.Lock(); f.closed = true; f.mu.Unlock() }
func (f *fakeBridge) Status() hpsdr.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status
}

type fakes struct {
	mu       sync.Mutex
	probes   []string // url|password
	saved    []app.Settings
	built    []app.Settings
	bridge   *fakeBridge
	allowed  []string
	bypassed bool
	refuse   string
}

func (f *fakes) deps() deps {
	return deps{
		probe: func(ctx context.Context, url, pw string) (*app.Probe, error) {
			f.mu.Lock()
			f.probes = append(f.probes, url+"|"+pw)
			allowed, bypassed, refuse := f.allowed, f.bypassed, f.refuse
			f.mu.Unlock()
			srv, err := ubersdr.NewServer(url, pw)
			if err != nil {
				return nil, err
			}
			p := &app.Probe{Server: srv, Reached: true,
				Conn: ubersdr.ConnResult{Allowed: refuse == "", Reason: refuse, Status: 403,
					Bypassed: bypassed, AllowedIQModes: allowed, ModesKnown: true},
				Desc: ubersdr.Description{Callsign: "M9PSY", Name: "Test RX", MinHz: 10_000, MaxHz: 30_000_000}}
			return p, nil
		},
		build: func(s app.Settings, p []*app.Probe, logf func(string)) (bridgeHandle, []string, error) {
			f.mu.Lock()
			f.built = append(f.built, s)
			f.mu.Unlock()
			logf("bridge log line")
			return f.bridge, []string{"note from build"}, nil
		},
		directory: func(context.Context) ([]ubersdr.Instance, error) {
			return []ubersdr.Instance{
				{Name: "Alpha", Callsign: "G0ABC", Host: "alpha.example", Port: 8073, PublicIQModes: []string{"iq48"}, Available: -1},
				{Name: "M9PSY RX888", Callsign: "M9PSY", Host: "m9psy-1.instance.ubersdr.org", Port: 443, TLS: true,
					PublicIQModes: []string{"iq48", "iq96"}, Available: 3, MaxClients: 10},
			}, nil
		},
		interfaces: func() ([]hpsdr.Iface, error) {
			return []hpsdr.Iface{
				{Name: "eth0", IP: net.IPv4(192, 168, 1, 2)},
				{Name: "wlan0", IP: net.IPv4(10, 0, 0, 5)},
			}, nil
		},
		defaultIf: func() (hpsdr.Iface, error) { return hpsdr.Iface{Name: "eth0", IP: net.IPv4(192, 168, 1, 2)}, nil },
		save: func(s app.Settings) error {
			f.mu.Lock()
			f.saved = append(f.saved, s)
			f.mu.Unlock()
			return nil
		},
	}
}

// harness runs the UI on a simulation screen.
type harness struct {
	t   *testing.T
	u   *UI
	sim tcell.SimulationScreen
}

func run(t *testing.T, s app.Settings, f *fakes) *harness {
	t.Helper()
	sim := tcell.NewSimulationScreen("UTF-8")
	if err := sim.Init(); err != nil {
		t.Fatal(err)
	}
	// 80x25, the simulator's own size and about the smallest terminal anyone
	// runs: the layout has to hold here.
	u := newUI(s, f.deps(), "test")
	u.app.SetScreen(sim)
	done := make(chan struct{})
	go func() {
		_ = u.app.Run()
		close(done)
	}()
	t.Cleanup(func() {
		u.app.QueueUpdate(u.quit)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("UI did not stop")
		}
	})
	h := &harness{t: t, u: u, sim: sim}
	h.waitScreen("Receiver URL")
	return h
}

// screen is the drawn screen as text. The simulation screen's cells are only
// safe to read on the UI goroutine, after a draw, so it is read there.
func (h *harness) screen() string {
	out := make(chan string, 1)
	h.u.app.QueueUpdateDraw(func() {})
	h.u.app.QueueUpdate(func() { out <- h.contents() })
	return <-out
}

func (h *harness) contents() string {
	cells, w, _ := h.sim.GetContents()
	var b strings.Builder
	for i, c := range cells {
		if len(c.Runes) > 0 {
			b.WriteRune(c.Runes[0])
		} else {
			b.WriteByte(' ')
		}
		if (i+1)%w == 0 {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func (h *harness) waitScreen(want string) {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(h.screen(), want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("screen never showed %q:\n%s", want, h.screen())
}

// do runs f on the UI goroutine and waits.
func (h *harness) do(f func()) {
	done := make(chan struct{})
	h.u.app.QueueUpdateDraw(func() { f(); close(done) })
	<-done
}

func (h *harness) key(k tcell.Key, r rune) {
	h.sim.InjectKey(k, r, tcell.ModNone)
	time.Sleep(5 * time.Millisecond)
}

func (h *harness) typeText(s string) {
	for _, r := range s {
		h.key(tcell.KeyRune, r)
	}
}

// typeInto focuses a field, types into it, and waits until the keys have
// landed: injected keys and queued updates are separate channels, so without
// the wait a later focus change can overtake the typing.
func (h *harness) typeInto(field *tview.InputField, text string) {
	h.t.Helper()
	h.do(func() { field.SetText(""); h.u.app.SetFocus(field) })
	h.typeText(text)
	deadline := time.Now().Add(3 * time.Second)
	for {
		var got string
		h.do(func() { got = field.GetText() })
		if got == text {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("field holds %q, typed %q", got, text)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ---- tests --------------------------------------------------------------------

// The form reads back what it was given, and reads the operator's changes.
func TestSettingsRoundTrip(t *testing.T) {
	f := &fakes{}
	in := app.Settings{URL: "http://rx:8080", Password: "pw", RememberPassword: true, Receivers: 4,
		Device: hpsdr.DeviceHermes, MinMargin: 30, Rates: []int{48, 192}, Interface: "wlan0"}
	u := newUI(in, f.deps(), "test")
	defer u.shutdown()
	got, err := u.settings()
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != in.URL || got.Password != "pw" || !got.RememberPassword || got.Receivers != 4 ||
		got.Device != hpsdr.DeviceHermes || got.MinMargin != 30 || got.Interface != "wlan0" ||
		len(got.Rates) != 2 || got.Rates[0] != 48 || got.Rates[1] != 192 {
		t.Fatalf("%+v", got)
	}

	// Every rate ticked means "whatever the receiver allows".
	for _, c := range u.rate {
		c.SetChecked(true)
	}
	u.iface.SetCurrentOption(0)
	u.margin.SetText("0")
	got, _ = u.settings()
	if got.Rates != nil || got.Interface != "" || got.MinMargin != 0 {
		t.Fatalf("%+v", got)
	}

	for _, c := range u.rate {
		c.SetChecked(false)
	}
	if _, err := u.settings(); err == nil {
		t.Fatal("no rates accepted")
	}
	u.rate[0].SetChecked(true)
	u.margin.SetText("6")
	if _, err := u.settings(); err == nil {
		t.Fatal("a 6 dB margin accepted")
	}
	u.margin.SetText("26")
	u.url.SetText("ftp://nope")
	if _, err := u.settings(); err == nil {
		t.Fatal("a bad URL accepted")
	}
}

// A saved interface that is not up now is kept, not widened to everyone.
func TestMissingInterfaceKept(t *testing.T) {
	f := &fakes{}
	s := app.Defaults()
	s.Interface = "tun9"
	u := newUI(s, f.deps(), "test")
	defer u.shutdown()
	got, err := u.settings()
	if err != nil || got.Interface != "tun9" {
		t.Fatalf("%+v %v", got, err)
	}
}

// Check asks the receiver with the typed URL and password, shows what it said,
// and greys out the rates the session may not use.
func TestProbeShowsAllowedRates(t *testing.T) {
	f := &fakes{allowed: []string{"iq48", "iq96"}}
	s := app.Defaults()
	h := run(t, s, f)

	// Type a URL and password into the form.
	h.typeInto(h.u.url, "rx.example:8073")
	h.typeInto(h.u.password, "hunter2")
	h.do(h.u.runProbe)
	h.waitScreen("IQ rates: iq48, iq96")
	// Allowed rates stay ticked; the others are marked.
	h.waitScreen("Offer 48 kHz      [x]")
	h.waitScreen("Offer 192 kHz     [-] not allowed")
	if !strings.Contains(h.screen(), "*******") || strings.Contains(h.screen(), "hunter2") {
		t.Fatal("password not masked")
	}
	f.mu.Lock()
	probe := f.probes[len(f.probes)-1]
	f.mu.Unlock()
	if probe != "rx.example:8073|hunter2" {
		t.Fatalf("probed %q", probe)
	}
	// Password given, allowed, not bypassed: it did nothing, and says so.
	h.waitScreen("password had no effect")

	// Changing the password makes the check stale and re-enables everything.
	h.do(func() { h.u.password.SetText("other") })
	h.waitScreen("Changed since the last")
	h.waitScreen("Offer 384 kHz     [x]")
	h.do(func() {
		for i, c := range h.u.rate {
			if !c.IsChecked() {
				t.Errorf("rate %d lost its tick", i)
			}
		}
	})
}

func TestProbeRefused(t *testing.T) {
	f := &fakes{refuse: "Invalid password"}
	h := run(t, app.Defaults(), f)
	h.do(func() { h.u.password.SetText("bad") })
	h.do(h.u.runProbe)
	h.waitScreen("Refused: Invalid password")
	h.waitScreen("(the password was not")
}

// Start checks first when needed, builds, saves, and shows the status screen;
// s stops the bridge and returns to setup.
func TestStartAndStop(t *testing.T) {
	fb := &fakeBridge{status: hpsdr.Status{Protocol: 2, Client: "192.168.1.50:50000", Running: true, TotalKbps: 2386,
		Receivers: []hpsdr.RxStatus{
			{Index: 0, Enabled: true, RateKHz: 192, FreqHz: 14_074_000, State: hpsdr.RxStreaming, ServerMode: "iq192", Kbps: 2386, Packets: 1234},
			{Index: 1, State: hpsdr.RxNotOffered, RateKHz: 384, Enabled: true, FreqHz: 7_000_000, Detail: "384 kHz"},
		}}}
	f := &fakes{allowed: []string{"iq48", "iq96", "iq192"}, bypassed: true, bridge: fb}
	s := app.Defaults()
	s.Password = "secret"
	s.Receivers = 2
	h := run(t, s, f)

	h.do(h.u.start)
	h.waitScreen("protocol 2 client 192.168.1.50:50000")
	h.waitScreen("14.074000 MHz")
	h.waitScreen("rate not allowed")
	h.waitScreen("note from build")
	h.waitScreen("bridge log line")
	if testing.Verbose() {
		t.Log("\n" + h.screen())
	}
	fb.mu.Lock()
	started := fb.started
	fb.mu.Unlock()
	if !started {
		t.Fatal("bridge not started")
	}
	f.mu.Lock()
	if len(f.probes) != 1 || len(f.built) != 1 || len(f.saved) != 1 {
		t.Fatalf("probes %d built %d saved %d", len(f.probes), len(f.built), len(f.saved))
	}
	if f.built[0].Password != "secret" || f.built[0].Receivers != 2 {
		t.Fatalf("built with %+v", f.built[0])
	}
	f.mu.Unlock()

	h.key(tcell.KeyRune, 's')
	h.waitScreen("Bridge stopped.")
	fb.mu.Lock()
	closed := fb.closed
	fb.mu.Unlock()
	if !closed {
		t.Fatal("bridge not closed on s")
	}
}

// Browse: the directory is listed, typing filters it, and Enter fills the URL
// and checks that receiver.
func TestPicker(t *testing.T) {
	f := &fakes{allowed: []string{"iq48"}}
	h := run(t, app.Defaults(), f)
	h.do(h.u.showPicker)
	h.waitScreen("G0ABC · Alpha")
	h.waitScreen("public iq48 iq96")
	h.typeText("m9p")
	h.waitScreen("Receivers (1)")
	h.key(tcell.KeyTab, 0)
	h.key(tcell.KeyEnter, 0)
	h.waitScreen("Receiver URL")
	h.do(func() {
		if got := h.u.url.GetText(); got != "https://m9psy-1.instance.ubersdr.org" {
			t.Errorf("URL %q", got)
		}
	})
	h.waitScreen("IQ rates: iq48")

	// Esc from the picker goes back without changing anything.
	h.do(h.u.showPicker)
	h.waitScreen("Filter")
	h.key(tcell.KeyEscape, 0)
	h.waitScreen("Receiver URL")
}

// A check result must not move the cursor: Enter on Check, then Tab twice,
// is Start.
func TestProbeKeepsFocus(t *testing.T) {
	f := &fakes{allowed: []string{"iq48"}}
	h := run(t, app.Defaults(), f)
	check := h.u.form.GetButton(h.u.form.GetButtonIndex("Check"))
	h.do(func() { h.u.app.SetFocus(check) })
	h.key(tcell.KeyEnter, 0)
	h.waitScreen("IQ rates: iq48")
	h.do(func() {
		if !check.HasFocus() {
			t.Errorf("focus moved to %T", h.u.app.GetFocus())
		}
	})
}

// ---- band receivers ---------------------------------------------------------

// The DDC table names each DDC's instance by callsign with a one-letter reason,
// explains the letters and who takes which bands underneath, and puts a rate
// limited instance in the header with a countdown.
func TestRunningShowsInstances(t *testing.T) {
	now := time.Now()
	fb := &fakeBridge{status: hpsdr.Status{Protocol: 2, Client: "192.168.1.50:50000", Running: true,
		Routes: []hpsdr.RouteStatus{
			{Name: "main.example:8073", Callsign: "G0ABC", CatchAll: true},
			{Name: "forty.example", Callsign: "M9PSY", Bands: []string{"40m", "20m"},
				LimitedUntil: now.Add(9 * time.Second), Backoff: 6 * time.Second},
		},
		Receivers: []hpsdr.RxStatus{
			{Index: 0, Enabled: true, RateKHz: 192, FreqHz: 3_573_000, State: hpsdr.RxStreaming,
				Instance: "main.example:8073", Callsign: "G0ABC", Why: hpsdr.WhyAll},
			{Index: 1, Enabled: true, RateKHz: 192, FreqHz: 7_074_000, State: hpsdr.RxRateLimited,
				Instance: "forty.example", Callsign: "M9PSY", Why: hpsdr.WhyBand,
				RetryAt: now.Add(9 * time.Second), Detail: "rate limited by forty.example"},
		}}}
	f := &fakes{allowed: []string{"iq48", "iq96", "iq192"}, bridge: fb}
	s := app.Defaults()
	s.Receivers = 2
	s.BandInstances = []app.BandInstance{{URL: "forty.example", Bands: []string{"40m", "20m"}}}
	h := run(t, s, f)
	h.do(h.u.start)
	h.waitScreen("Instance Why")
	h.waitScreen("G0ABC     A")
	h.waitScreen("M9PSY     B")
	h.waitScreen("M9PSY     B")
	h.waitScreen(" 0 retry in")
	h.waitScreen("Why: B band assigned · A all others · R only one in range · O out of range")
	h.waitScreen("G0ABC: everything else · M9PSY: 40m 20m")
	h.waitScreen("+ 1 band receiver")
	h.waitScreen("M9PSY: rate limited, 1 DDC(s) waiting, retry in")
	if testing.Verbose() {
		t.Log("\n" + h.screen())
	}
	// Start checked the band receiver too, and built with both.
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.probes) != 2 || f.probes[1] != "forty.example|" || len(f.built) != 1 || len(f.built[0].BandInstances) != 1 {
		t.Fatalf("probes %v built %+v", f.probes, f.built)
	}
}

// One receiver, the default: the letter key is there, the band list is not.
func TestRunningOneInstance(t *testing.T) {
	fb := &fakeBridge{status: hpsdr.Status{Protocol: 2, Running: true,
		Routes: []hpsdr.RouteStatus{{Name: "rx", Callsign: "G0ABC", CatchAll: true}},
		Receivers: []hpsdr.RxStatus{{Index: 0, Enabled: true, RateKHz: 96, FreqHz: 7_074_000,
			State: hpsdr.RxStreaming, Instance: "rx", Callsign: "G0ABC", Why: hpsdr.WhyAll}}}}
	f := &fakes{allowed: []string{"iq96"}, bridge: fb}
	s := app.Defaults()
	s.Receivers = 1
	h := run(t, s, f)
	h.do(h.u.start)
	h.waitScreen("G0ABC     A")
	scr := h.screen()
	if strings.Contains(scr, "everything else") || strings.Contains(scr, "band receiver") {
		t.Fatalf("band receivers shown with none:\n%s", scr)
	}
}

// Adding a band receiver: open the page from the setup form, add, check, tick
// a band, save; the setup line and the settings carry it, and bands out of the
// receiver's range or set for another cannot be ticked.
func TestBandReceiverPages(t *testing.T) {
	f := &fakes{allowed: []string{"iq48", "iq96"}}
	h := run(t, app.Defaults(), f)
	h.waitScreen("Band receivers    none: one receiver for all")

	h.do(func() { h.u.app.SetFocus(h.u.bands.field) })
	h.key(tcell.KeyEnter, 0)
	h.waitScreen("the receiver on the setup screen")
	h.do(func() { h.u.editBand(-1) })
	h.waitScreen("tuning range decides which")
	h.typeInto(h.u.bands.editURL, "forty.example:8073")
	h.do(h.u.checkEdit)
	h.waitScreen("Receiver: M9PSY Test RX")
	// The fake receiver tunes to 30 MHz: 6m cannot be ticked.
	h.waitScreen("6m    50.000-54.000 MHz out of range")
	h.do(func() {
		h.u.app.SetFocus(h.u.bands.editTable)
		h.u.bands.editTable.Select(13, 0)
	})
	h.key(tcell.KeyRune, ' ')
	h.waitScreen("6m is outside this")
	// 40m is row 6.
	h.do(func() { h.u.bands.editTable.Select(6, 0) })
	h.key(tcell.KeyRune, ' ')
	h.waitScreen("[x] 40m")
	h.do(h.u.saveEdit)
	h.waitScreen("forty.example:8073")
	h.key(tcell.KeyEscape, 0)
	h.waitScreen("Band receivers    1: 40m")
	h.do(func() {
		s, err := h.u.settings()
		if err != nil || len(s.BandInstances) != 1 || s.BandInstances[0].URL != "forty.example:8073" ||
			strings.Join(s.BandInstances[0].Bands, " ") != "40m" {
			t.Errorf("%+v %v", s.BandInstances, err)
		}
	})

	// A second band receiver sees 40m as taken.
	h.do(func() { h.u.editBand(-1) })
	h.waitScreen("40m   7.000-7.300 MHz   on M9PSY")
	h.do(func() {
		h.u.app.SetFocus(h.u.bands.editTable)
		h.u.bands.editTable.Select(6, 0)
	})
	h.key(tcell.KeyEnter, 0)
	h.waitScreen("40m is already set for")
	h.do(h.u.cancelEdit)
	h.waitScreen("Band receivers ")
}

// ---- the mouse wheel ----------------------------------------------------------

func (h *harness) wheel(x, y int, dir tcell.ButtonMask) {
	h.sim.InjectMouse(x, y, dir, tcell.ModNone)
	h.sim.InjectMouse(x, y, tcell.ButtonNone, tcell.ModNone)
	time.Sleep(10 * time.Millisecond)
}

// The wheel moves the picker's selection, and a LAN receiver turning up does
// not throw the place away.
func TestPickerWheel(t *testing.T) {
	f := &fakes{}
	h := run(t, app.Defaults(), f)
	h.do(h.u.showPicker)
	h.waitScreen("Receivers (2)")
	cur := func() (i int) { h.do(func() { i = h.u.list.GetCurrentItem() }); return }
	h.wheel(10, 5, tcell.WheelDown)
	deadline := time.Now().Add(wait)
	for cur() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("wheel left the selection at %d", cur())
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.do(h.u.fillList)
	if cur() != 1 {
		t.Fatal("refilling the list lost the selection")
	}
	h.wheel(10, 5, tcell.WheelUp)
	for cur() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("wheel up left the selection at %d", cur())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The wheel moves the band table's selection.
func TestBandTableWheel(t *testing.T) {
	h := run(t, app.Defaults(), &fakes{})
	h.do(func() { h.u.editBand(-1) })
	h.waitScreen("2200m")
	row := func() (r int) { h.do(func() { r, _ = h.u.bands.editTable.GetSelection() }); return }
	if row() != 1 {
		t.Fatalf("starts at %d", row())
	}
	for i := 0; i < 3; i++ {
		h.wheel(10, 12, tcell.WheelDown)
	}
	deadline := time.Now().Add(wait)
	for row() != 4 {
		if time.Now().After(deadline) {
			t.Fatalf("row %d after three notches", row())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Scrolled up in the log, new lines do not pull the operator back down.
func TestLogStaysScrolled(t *testing.T) {
	fb := &fakeBridge{status: hpsdr.Status{}}
	h := run(t, app.Defaults(), &fakes{allowed: []string{"iq48"}, bridge: fb})
	h.do(h.u.start)
	h.waitScreen("bridge log line")
	for i := 0; i < 60; i++ {
		h.u.logf("filler line")
	}
	h.do(h.u.refresh)
	var x, y int
	h.do(func() { x, y, _, _ = h.u.logView.GetInnerRect() })
	for i := 0; i < 80; i++ {
		h.wheel(x+2, y+1, tcell.WheelUp)
	}
	offset := func() (r int) { h.do(func() { r, _ = h.u.logView.GetScrollOffset() }); return }
	deadline := time.Now().Add(wait)
	for offset() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("wheel up left the log at %d", offset())
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.u.logf("a new line")
	h.do(h.u.refresh)
	h.do(func() {})
	if o := offset(); o != 0 {
		t.Fatalf("a new line moved the log to %d", o)
	}
}

const wait = 3 * time.Second

// The highlighted band is drawn readably, not in swapped terminal-default
// colours (which came out black), and a double-click ticks and unticks it.
func TestBandTableSelectionAndDoubleClick(t *testing.T) {
	h := run(t, app.Defaults(), &fakes{})
	h.do(func() { h.u.editBand(-1); h.u.app.SetFocus(h.u.bands.editTable) })
	h.waitScreen("2200m")

	// Find the 40m row on screen.
	var x, y int
	h.do(func() {
		h.u.app.ForceDraw()
		cells, w, _ := h.sim.GetContents()
		for i := range cells {
			if i+3 <= len(cells) && len(cells[i].Runes) > 0 && cells[i].Runes[0] == '4' &&
				len(cells[i+1].Runes) > 0 && cells[i+1].Runes[0] == '0' && cells[i+2].Runes[0] == 'm' {
				x, y = i%w, i/w
				break
			}
		}
	})
	if y == 0 {
		t.Fatal("40m not on screen")
	}

	h.do(func() { h.u.bands.editTable.Select(6, 0) })
	h.do(func() {
		h.u.app.ForceDraw()
		cells, w, _ := h.sim.GetContents()
		fg, bg, _ := cells[y*w+x].Style.Decompose()
		if fg != tview.Styles.PrimaryTextColor || bg != tview.Styles.ContrastBackgroundColor {
			t.Errorf("selected band drawn %v on %v", fg, bg)
		}
	})

	click := func() {
		h.sim.InjectMouse(x, y, tcell.Button1, tcell.ModNone)
		h.sim.InjectMouse(x, y, tcell.ButtonNone, tcell.ModNone)
	}
	ticked := func() (on bool) { h.do(func() { on = h.u.bands.editBands["40m"] }); return }

	// One click selects without ticking.
	h.do(func() { h.u.bands.editTable.Select(1, 0) })
	click()
	time.Sleep(600 * time.Millisecond) // past tview's double-click interval
	h.do(func() {})
	if ticked() {
		t.Fatal("a single click ticked the band")
	}
	if r, _ := h.u.bands.editTable.GetSelection(); r != 6 {
		t.Fatalf("a click selected row %d", r)
	}
	click()
	click()
	h.waitScreen("[x] 40m")
	if !ticked() {
		t.Fatal("double-click did not tick 40m")
	}
	time.Sleep(600 * time.Millisecond)
	click()
	click()
	h.waitScreen("[ ] 40m")
}

// The header says which IQ rate is which, and shows the bridge's CPU and memory.
func TestHeaderRatesAndProcess(t *testing.T) {
	fb := &fakeBridge{status: hpsdr.Status{Protocol: 2, Running: true, TotalKbps: 2386, TotalOutKbps: 18600,
		Routes: []hpsdr.RouteStatus{{Name: "rx", CatchAll: true}}}}
	h := run(t, app.Defaults(), &fakes{allowed: []string{"iq48"}, bridge: fb})
	h.do(h.u.start)
	h.waitScreen("IQ from UberSDR 2386 kbps · to client 18.6 Mbps")
	h.waitScreen("mem ")
	// CPU needs a second of history before it is a number.
	h.waitScreen("CPU -")
	deadline := time.Now().Add(3 * time.Second)
	for strings.Contains(h.screen(), "CPU -") {
		if time.Now().After(deadline) {
			t.Fatalf("CPU never measured:\n%s", h.screen())
		}
		time.Sleep(100 * time.Millisecond)
	}
	fb.mu.Lock()
	fb.status.Routes = append(fb.status.Routes, hpsdr.RouteStatus{Name: "b", Bands: []string{"40m"}})
	fb.mu.Unlock()
	h.waitScreen("IQ from instances 2386 kbps")
}

func TestProcStats(t *testing.T) {
	if _, ok := cpuTime(); !ok {
		t.Skip("no CPU time on this platform")
	}
	var p procStats
	t0 := time.Now()
	p.sample(t0)
	if p.have || !strings.HasPrefix(p.String(), "CPU -") {
		t.Fatal(p.String())
	}
	// Burn most of a core for a little over the window.
	x := 0
	for time.Since(t0) < procWindow+100*time.Millisecond {
		x++
	}
	p.sample(time.Now())
	if !p.have || p.pct < 30 || p.pct > 400 || x == 0 {
		t.Fatalf("%.0f%% after a busy second", p.pct)
	}
	if memBytes() < 1<<20 {
		t.Fatalf("memory %d", memBytes())
	}
}

func TestCount(t *testing.T) {
	for n, want := range map[uint64]string{
		0: "0", 1234: "1234", 9999: "9999", 10_000: "10.00k", 12_345: "12.35k", 999_994: "999.99k",
		999_995: "1.00M", 1_000_000: "1.00M", 999_994_999: "999.99M", 999_995_000: "1.00G", 23_456_789: "23.46M", 4_560_000_000: "4.56G",
	} {
		if got := count(n); got != want {
			t.Errorf("count(%d) = %q, want %q", n, got, want)
		}
	}
}
