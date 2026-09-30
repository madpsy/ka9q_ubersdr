package app

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

func TestSaveLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "settings.json")
	s, err := Load(path)
	if err != nil || s.URL != Defaults().URL || s.Receivers != 10 || s.MinMargin != 10 {
		t.Fatalf("defaults %+v %v", s, err)
	}
	s.URL, s.Password, s.Rates, s.Interface = "https://rx", "pw", []int{48, 96}, "eth0"
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	// The password stays out unless asked for.
	if got.Password != "" || got.URL != "https://rx" || len(got.Rates) != 2 || got.Interface != "eth0" {
		t.Fatalf("%+v", got)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "pw") {
		t.Fatal("password written without remember")
	}
	s.RememberPassword = true
	_ = Save(path, s)
	if got, _ := Load(path); got.Password != "pw" {
		t.Fatal("remembered password not kept")
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(path)
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("settings mode %v", fi.Mode().Perm())
		}
	}
	_ = os.WriteFile(path, []byte("{nope"), 0o600)
	if got, err := Load(path); err == nil || got.URL != Defaults().URL {
		t.Fatal("corrupt settings not reported, or not defaulted")
	}
}

func TestValidate(t *testing.T) {
	ok := Defaults()
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*Settings){
		"url":    func(s *Settings) { s.URL = "" },
		"rx":     func(s *Settings) { s.Receivers = 11 },
		"device": func(s *Settings) { s.Device = 2 },
		"margin": func(s *Settings) { s.MinMargin = 9 },
		"rate":   func(s *Settings) { s.Rates = []int{12} },
	} {
		s := Defaults()
		mod(&s)
		if s.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestOfferedKHz(t *testing.T) {
	cases := []struct {
		wanted, allowed, want []int
		ok                    bool
	}{
		{nil, []int{48, 96, 192, 384}, []int{48, 96, 192, 384}, true},
		{nil, []int{48, 96}, []int{48, 96}, true},
		{[]int{96, 384}, []int{48, 96}, []int{96}, true},
		{[]int{384}, []int{48}, []int{384}, false},
		{nil, nil, []int{48, 96, 192, 384}, false},
	}
	for _, c := range cases {
		got, ok := OfferedKHz(c.wanted, c.allowed)
		if ok != c.ok || join(got) != join(c.want) {
			t.Errorf("OfferedKHz(%v, %v) = %v %v, want %v %v", c.wanted, c.allowed, got, ok, c.want, c.ok)
		}
	}
}

func join(v []int) string { return joinKHz(v) }

func TestProbeSummaryAndAllowed(t *testing.T) {
	srv, _ := ubersdr.NewServer("http://rx:8080", "pw")
	p := &Probe{Server: srv, Reached: true,
		Conn: ubersdr.ConnResult{Allowed: true, Bypassed: true, ModesKnown: true, AllowedIQModes: []string{"iq48", "iq384"}},
		Desc: ubersdr.Description{Callsign: "M9PSY", Name: "RX888", Location: "Fife", MinHz: 10_000, MaxHz: 60_000_000}}
	if join(p.AllowedKHz()) != "48/384" {
		t.Fatal(p.AllowedKHz())
	}
	sum := strings.Join(p.Summary(), "\n")
	for _, want := range []string{"M9PSY RX888, Fife", "bypassed", "password accepted", "iq48, iq384", "60.000 MHz"} {
		if !strings.Contains(sum, want) {
			t.Errorf("summary lacks %q:\n%s", want, sum)
		}
	}

	// Unreachable: every rate, since nothing is known.
	p = &Probe{Server: srv, Err: os.ErrDeadlineExceeded}
	if join(p.AllowedKHz()) != "48/96/192/384" || !strings.Contains(strings.Join(p.Summary(), "\n"), "Not reachable") {
		t.Fatal("unreachable probe")
	}
	// Allowed but no wide modes: says a password may be needed.
	p = &Probe{Server: srv, Reached: true, Conn: ubersdr.ConnResult{Allowed: true, ModesKnown: true, AllowedIQModes: []string{}}}
	if len(p.AllowedKHz()) != 0 || !strings.Contains(strings.Join(p.Summary(), "\n"), "A password may be needed") {
		t.Fatal("no-modes probe")
	}
}

// Band receivers: saved and loaded, passwords only when remembered, and the
// caller's settings left alone.
func TestSaveLoadBandInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s := Defaults()
	s.BandInstances = []BandInstance{{URL: "https://forty", Password: "fortypw", Bands: []string{"40m", "20m"}}}
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}
	if s.BandInstances[0].Password != "fortypw" {
		t.Fatal("Save cleared the caller's password")
	}
	got, _ := Load(path)
	if len(got.BandInstances) != 1 || got.BandInstances[0].URL != "https://forty" ||
		strings.Join(got.BandInstances[0].Bands, " ") != "40m 20m" || got.BandInstances[0].Password != "" {
		t.Fatalf("%+v", got.BandInstances)
	}
	s.RememberPassword = true
	_ = Save(path, s)
	if got, _ := Load(path); got.BandInstances[0].Password != "fortypw" {
		t.Fatal("remembered band password not kept")
	}
	// A settings file from before band receivers loads as one receiver.
	_ = os.WriteFile(path, []byte(`{"url":"http://old:8080","receivers":4,"device":6,"min_margin":26}`), 0o600)
	if got, err := Load(path); err != nil || got.BandInstances != nil || got.URL != "http://old:8080" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestValidateBandInstances(t *testing.T) {
	ok := Defaults()
	ok.URL = "http://main:8080"
	ok.BandInstances = []BandInstance{{URL: "forty:8073", Bands: []string{"40m"}}, {URL: "https://six", Bands: []string{"6M", "10m"}}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, bis := range map[string][]BandInstance{
		"no bands":    {{URL: "http://a", Bands: nil}},
		"bad band":    {{URL: "http://a", Bands: []string{"11m"}}},
		"bad url":     {{URL: "ftp://a", Bands: []string{"40m"}}},
		"band twice":  {{URL: "http://a", Bands: []string{"40m"}}, {URL: "http://b", Bands: []string{"40M"}}},
		"url twice":   {{URL: "http://a", Bands: []string{"40m"}}, {URL: "a", Bands: []string{"20m"}}},
		"is the main": {{URL: "main:8080", Bands: []string{"40m"}}},
	} {
		s := ok
		s.BandInstances = bis
		if s.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func probeFor(t *testing.T, url string, modes []string, maxHz int64) *Probe {
	t.Helper()
	srv, err := ubersdr.NewServer(url, "")
	if err != nil {
		t.Fatal(err)
	}
	return &Probe{Server: srv, Reached: true,
		Conn: ubersdr.ConnResult{Allowed: true, ModesKnown: true, AllowedIQModes: modes},
		Desc: ubersdr.Description{MinHz: 10_000, MaxHz: maxHz}}
}

// Every receiver must allow a rate for it to be offered, and the one that does
// not is named.
func TestIntersectAllowed(t *testing.T) {
	main := probeFor(t, "http://main", []string{"iq48", "iq96", "iq192", "iq384"}, 30_000_000)
	forty := probeFor(t, "http://forty", []string{"iq48", "iq96", "iq192"}, 30_000_000)
	six := probeFor(t, "http://six", []string{"iq96", "iq192"}, 60_000_000)
	allowed, blocked := IntersectAllowed([]*Probe{main, forty, six})
	if join(allowed) != "96/192" {
		t.Fatalf("allowed %v", allowed)
	}
	if strings.Join(blocked[384], ",") != "forty,six" || strings.Join(blocked[48], ",") != "six" || len(blocked[96]) != 0 {
		t.Fatalf("blocked %v", blocked)
	}
}

func TestCoverageNotes(t *testing.T) {
	s := Defaults()
	s.BandInstances = []BandInstance{{URL: "http://low", Bands: []string{"6m", "10m", "40m"}}}
	main := probeFor(t, "http://main", nil, 30_000_000)
	low := probeFor(t, "http://low", nil, 29_000_000)
	got := strings.Join(CoverageNotes(s, []*Probe{main, low}), "\n")
	if !strings.Contains(got, "WARNING 6m is set for low") || !strings.Contains(got, "10m is set for low, which tunes only") ||
		strings.Contains(got, "40m") || strings.Contains(got, "Hermes Lite") {
		t.Fatalf("notes:\n%s", got)
	}
	// A receiver reaching 6m behind a Hermes Lite 2: most clients will not tune
	// it there.
	wide := probeFor(t, "http://main", nil, 60_000_000)
	if got := strings.Join(CoverageNotes(Defaults(), []*Probe{wide}), "\n"); !strings.Contains(got, "present as Hermes") {
		t.Fatalf("notes:\n%s", got)
	}
	s = Defaults()
	s.Device = 1
	if got := CoverageNotes(s, []*Probe{wide}); len(got) != 0 {
		t.Fatalf("Hermes noted: %v", got)
	}
}
