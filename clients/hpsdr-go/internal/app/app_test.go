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
	if err != nil || s.URL != Defaults().URL || s.Receivers != 10 || s.MinMargin != 26 {
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
		"margin": func(s *Settings) { s.MinMargin = 10 },
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
