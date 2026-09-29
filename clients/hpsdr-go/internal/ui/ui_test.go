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
		build: func(s app.Settings, p *app.Probe, logf func(string)) (bridgeHandle, []string, error) {
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
