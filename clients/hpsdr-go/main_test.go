package main

import (
	"runtime"
	"strings"
	"testing"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/app"
)

func TestParseRates(t *testing.T) {
	got, err := parseRates("48, 96k,384")
	if err != nil || len(got) != 3 || got[0] != 48 || got[1] != 96 || got[2] != 384 {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range []string{"", "12", "48,,96", "fast"} {
		if _, err := parseRates(bad); err == nil {
			t.Errorf("parseRates(%q) accepted", bad)
		}
	}
}

func TestClip(t *testing.T) {
	if clip("short", 10) != "short" || clip("a very long name", 8) != "a very.." {
		t.Fatal(clip("a very long name", 8))
	}
}

func TestParseRoute(t *testing.T) {
	bi, err := parseRoute("40m, 20M=https://:s3cr%40t@rx2.example.org")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(bi.Bands, " ") != "40m 20M" || bi.URL != "https://rx2.example.org" || bi.Password != "s3cr@t" {
		t.Fatalf("%+v", bi)
	}
	if bi, err := parseRoute("6m=rx3:8073"); err != nil || bi.URL != "rx3:8073" || bi.Password != "" {
		t.Fatalf("%+v %v", bi, err)
	}
	if bi, err := parseRoute("6m=pw@rx3:8073"); err != nil || bi.Password != "pw" || strings.Contains(bi.URL, "pw") {
		t.Fatalf("%+v %v", bi, err)
	}
	for _, bad := range []string{"40m", "40m=", "11m=http://rx", "=http://rx", "40m=ftp://rx"} {
		if _, err := parseRoute(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// Headless and the setup screen start from what was saved, with only the
// options given on the command line laid over it.
func TestWithSaved(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("XDG_CONFIG_HOME steers the config directory on Linux only")
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	flags := app.Defaults()
	flags.URL = "http://cli:8080"
	flags.Receivers = 2

	// Nothing saved: the defaults and the command line.
	s, path, found, err := withSaved(flags, map[string]bool{"u": true})
	if err != nil || found || s.URL != "http://cli:8080" || s.Receivers != app.Defaults().Receivers {
		t.Fatalf("%+v %v %v", s, found, err)
	}

	saved := app.Defaults()
	saved.URL, saved.Receivers, saved.MinMargin = "http://saved:8080", 4, 30
	saved.BandInstances = []app.BandInstance{{URL: "http://forty", Bands: []string{"40m"}}}
	if err := app.Save(path, saved); err != nil {
		t.Fatal(err)
	}
	// No options: exactly what was saved.
	s, _, found, err = withSaved(app.Defaults(), map[string]bool{})
	if err != nil || !found || s.URL != "http://saved:8080" || s.Receivers != 4 || s.MinMargin != 30 || len(s.BandInstances) != 1 {
		t.Fatalf("%+v %v %v", s, found, err)
	}
	// --url and -n override those two; the rest stays as saved.
	s, _, _, _ = withSaved(flags, map[string]bool{"url": true, "n": true})
	if s.URL != "http://cli:8080" || s.Receivers != 2 || s.MinMargin != 30 || len(s.BandInstances) != 1 {
		t.Fatalf("%+v", s)
	}
}
