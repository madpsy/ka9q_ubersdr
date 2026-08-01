package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseBandwidth(t *testing.T) {
	for _, tc := range []struct {
		spec      string
		low, high int
	}{
		{"300:2700", 300, 2700},
		{"-2700:-300", -2700, -300}, // lower sideband: both edges negative
		{"-5000:5000", -5000, 5000},
		{" 50 : 2400 ", 50, 2400},
	} {
		low, high, err := parseBandwidth(tc.spec)
		if err != nil {
			t.Errorf("%q: %v", tc.spec, err)
			continue
		}
		if low != tc.low || high != tc.high {
			t.Errorf("%q gave %d/%d, want %d/%d", tc.spec, low, high, tc.low, tc.high)
		}
	}

	for _, bad := range []string{"", "2400", "300:", ":2700", "a:b", "2700:300", "300:300", "1:2:3"} {
		if _, _, err := parseBandwidth(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}

	// The message has to say what the form is, since there is no UI to explore.
	if _, _, err := parseBandwidth("2400"); err == nil || !strings.Contains(err.Error(), "low:high") {
		t.Errorf("unhelpful complaint: %v", err)
	}
}

func TestLooksLikeHost(t *testing.T) {
	for _, host := range []string{
		"localhost", "localhost:8080", "192.168.1.50:8080", "sdr.example.org",
		"https://m9psy.tunnel.ubersdr.org", "http://box:8080",
	} {
		if !looksLikeHost(host) {
			t.Errorf("%q was taken for a receiver name", host)
		}
	}
	for _, name := range []string{"m9psy", "VE4DRK", "nb3a"} {
		if looksLikeHost(name) {
			t.Errorf("%q was taken for an address", name)
		}
	}
}

// stubDirectory points the public lookup at a local server for the duration of
// a test.
func stubDirectory(t *testing.T, instances []map[string]interface{}) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"count": len(instances), "instances": instances,
		})
	}))
	orig := publicInstancesURLForTest
	publicInstancesURLForTest = srv.URL
	t.Cleanup(func() {
		publicInstancesURLForTest = orig
		srv.Close()
	})
}

// -server takes an address or the name of a public receiver, so that a script
// can name the receiver it means rather than an address that may move.
func TestResolveTarget(t *testing.T) {
	stubDirectory(t, []map[string]interface{}{
		{"name": "M9PSY UK", "callsign": "M9PSY", "location": "Reading",
			"host": "m9psy.example", "port": 443, "tls": true, "available_clients": 4},
		{"name": "VE4DRK-proxmox", "callsign": "VE4DRK", "location": "Winnipeg",
			"host": "ve4drk.example", "port": 443, "tls": true, "available_clients": 2},
		{"name": "Reading Club", "callsign": "G0RDG", "location": "Reading",
			"host": "club.example", "port": 8080, "available_clients": 1},
	})

	// An address is taken as one, without asking the directory anything.
	for _, tc := range []struct {
		spec string
		host string
		tls  bool
	}{
		{"localhost:8080", "localhost:8080", false},
		{"https://sdr.example.org", "sdr.example.org", true},
		{"192.168.1.50:8080", "192.168.1.50:8080", false},
	} {
		got, err := resolveTarget(context.Background(), tc.spec, false)
		if err != nil {
			t.Errorf("%q: %v", tc.spec, err)
			continue
		}
		if got.Host != tc.host || got.TLS != tc.tls {
			t.Errorf("%q gave %q tls=%v", tc.spec, got.Host, got.TLS)
		}
	}

	// A callsign, in any case, is the receiver meant.
	for _, spec := range []string{"m9psy", "M9PSY"} {
		got, err := resolveTarget(context.Background(), spec, false)
		if err != nil {
			t.Fatalf("%q: %v", spec, err)
		}
		if got.Host != "m9psy.example" {
			t.Errorf("%q resolved to %q", spec, got.Host)
		}
	}

	// So is a name that only one receiver answers to.
	if got, err := resolveTarget(context.Background(), "proxmox", false); err != nil {
		t.Errorf("a unique name failed: %v", err)
	} else if got.Host != "ve4drk.example" {
		t.Errorf("resolved to %q", got.Host)
	}

	// An ambiguous one is refused, and says what it matched so the next attempt
	// can be exact.
	_, err := resolveTarget(context.Background(), "reading", false)
	if err == nil {
		t.Fatal("an ambiguous name was accepted")
	}
	if !strings.Contains(err.Error(), "M9PSY") || !strings.Contains(err.Error(), "G0RDG") {
		t.Errorf("the complaint does not list the candidates: %v", err)
	}

	// And one that matches nothing says what to do instead.
	_, err = resolveTarget(context.Background(), "nosuchthing", false)
	if err == nil || !strings.Contains(err.Error(), "host:port") {
		t.Errorf("unhelpful complaint: %v", err)
	}
}

// An exact callsign wins over a receiver that merely contains those letters.
func TestResolveTargetPrefersAnExactMatch(t *testing.T) {
	stubDirectory(t, []map[string]interface{}{
		{"name": "Long Name Mentioning NB3A", "callsign": "G9XYZ",
			"host": "other.example", "port": 443, "tls": true},
		{"name": "NB3A", "callsign": "NB3A", "host": "nb3a.example", "port": 443, "tls": true},
	})

	got, err := resolveTarget(context.Background(), "nb3a", false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Host != "nb3a.example" {
		t.Errorf("resolved to %q, want the receiver actually called NB3A", got.Host)
	}
}
