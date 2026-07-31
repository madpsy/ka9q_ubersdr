package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
)

func TestParseManualTarget(t *testing.T) {
	cases := []struct {
		in       string
		wantHost string
		wantTLS  bool
	}{
		// A bare host is assumed to be a local receiver on the default port.
		{"localhost", "localhost:8080", false},
		{"192.168.1.50", "192.168.1.50:8080", false},
		// An explicit port is left alone.
		{"192.168.1.50:9000", "192.168.1.50:9000", false},
		// URLs carry their own scheme.
		{"https://example.org", "example.org", true},
		{"http://example.org:8080", "example.org:8080", false},
		{"  https://example.org/  ", "example.org", true},
	}
	for _, c := range cases {
		inst, ok := parseManualTarget(c.in)
		if !ok {
			t.Errorf("parseManualTarget(%q) rejected a valid target", c.in)
			continue
		}
		if inst.Host != c.wantHost || inst.TLS != c.wantTLS {
			t.Errorf("parseManualTarget(%q) = (%q, tls=%v), want (%q, tls=%v)",
				c.in, inst.Host, inst.TLS, c.wantHost, c.wantTLS)
		}
	}

	for _, bad := range []string{"", "   "} {
		if _, ok := parseManualTarget(bad); ok {
			t.Errorf("parseManualTarget(%q) should have been rejected", bad)
		}
	}
}

func TestJoinHostPort(t *testing.T) {
	// Default ports are omitted so displayed addresses stay readable.
	if got := joinHostPort("example.org", 443, true); got != "example.org" {
		t.Errorf("TLS default port not omitted: %q", got)
	}
	if got := joinHostPort("example.org", 80, false); got != "example.org" {
		t.Errorf("plain default port not omitted: %q", got)
	}
	if got := joinHostPort("example.org", 8080, false); got != "example.org:8080" {
		t.Errorf("non-default port dropped: %q", got)
	}
	if got := joinHostPort("example.org", 0, false); got != "example.org" {
		t.Errorf("zero port should be omitted: %q", got)
	}
}

func TestInstanceMatchesFilter(t *testing.T) {
	inst := Instance{
		Name:     "RX888 end-fed",
		Callsign: "M9PSY",
		Location: "Dalgety Bay, Scotland",
		Host:     "m9psy.tunnel.ubersdr.org",
	}
	for _, f := range []string{"", "rx888", "M9PSY", "m9psy", "scotland", "tunnel"} {
		if !inst.matches(f) {
			t.Errorf("filter %q should have matched", f)
		}
	}
	for _, f := range []string{"kiwisdr", "germany"} {
		if inst.matches(f) {
			t.Errorf("filter %q should not have matched", f)
		}
	}
}

func TestInstanceLabelAndDetail(t *testing.T) {
	// The callsign is prefixed only when it isn't already in the name.
	withCall := Instance{Name: "end-fed wire", Callsign: "M9PSY", Host: "h:8080", Available: -1}
	if got := withCall.Label(); !strings.HasPrefix(got, "M9PSY · ") {
		t.Errorf("Label() = %q, want the callsign prefixed", got)
	}
	dup := Instance{Name: "M9PSY RX888", Callsign: "M9PSY", Host: "h:8080", Available: -1}
	if got := dup.Label(); strings.Count(got, "M9PSY") != 1 {
		t.Errorf("Label() = %q, want the callsign not duplicated", got)
	}
	// An instance with no name falls back to its address.
	bare := Instance{Host: "10.0.0.5:8080", Available: -1}
	if got := bare.Label(); got != "10.0.0.5:8080" {
		t.Errorf("Label() = %q, want the host as a fallback", got)
	}

	// Unknown slot counts (local discovery) are omitted rather than shown as -1.
	if got := bare.Detail(); strings.Contains(got, "-1") {
		t.Errorf("Detail() = %q, should not expose the unknown sentinel", got)
	}
	full := Instance{Host: "h:8080", Available: 17, MaxUsers: 20, SNR: 19, Version: "0.1.58"}
	if got := full.Detail(); !strings.Contains(got, "17/20 free") {
		t.Errorf("Detail() = %q, want the slot count", got)
	}
}

func TestFetchPublicInstances(t *testing.T) {
	// Serve a directory response shaped like the real API.
	body := map[string]interface{}{
		"count": 3,
		"instances": []map[string]interface{}{
			{"name": "Busy", "host": "busy.example", "port": 443, "tls": true,
				"available_clients": 0, "max_clients": 20, "snr_0_30_mhz": 25},
			{"name": "Quiet", "host": "quiet.example", "port": 443, "tls": true,
				"available_clients": 5, "max_clients": 20, "snr_0_30_mhz": 10},
			{"name": "Loud", "host": "loud.example", "port": 8080, "tls": false,
				"available_clients": 3, "max_clients": 20, "snr_0_30_mhz": 22},
			{"name": "No host", "host": ""}, // must be skipped
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()

	// Point the fetcher at the test server.
	orig := publicInstancesURLForTest
	publicInstancesURLForTest = srv.URL
	defer func() { publicInstancesURLForTest = orig }()

	got, err := FetchPublicInstances(context.Background())
	if err != nil {
		t.Fatalf("FetchPublicInstances: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d instances, want 3 (the host-less entry should be skipped)", len(got))
	}

	// Receivers with free slots come first, then by descending SNR.
	if got[0].Name != "Loud" || got[1].Name != "Quiet" {
		t.Errorf("ordering = %q, %q, %q; want free slots first then best SNR",
			got[0].Name, got[1].Name, got[2].Name)
	}
	if got[2].Name != "Busy" {
		t.Errorf("the full receiver should sort last, got %q", got[2].Name)
	}
	// The default TLS port is folded into the host.
	if got[1].Host != "quiet.example" {
		t.Errorf("host = %q, want the :443 suffix omitted", got[1].Host)
	}
	if got[0].Host != "loud.example:8080" {
		t.Errorf("host = %q, want the non-default port kept", got[0].Host)
	}
}

func TestFetchPublicInstancesHandlesErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer srv.Close()

	orig := publicInstancesURLForTest
	publicInstancesURLForTest = srv.URL
	defer func() { publicInstancesURLForTest = orig }()

	if _, err := FetchPublicInstances(context.Background()); err == nil {
		t.Error("expected an error for an HTTP 500 response")
	}
}

func TestParseTXT(t *testing.T) {
	got := parseTXT([]string{"version=0.1.58", "callsign=M9PSY", "malformed", "empty="})
	if got["version"] != "0.1.58" || got["callsign"] != "M9PSY" {
		t.Errorf("parseTXT = %v, want version and callsign parsed", got)
	}
	if _, ok := got["malformed"]; ok {
		t.Error("a record with no '=' should be skipped")
	}
	if v, ok := got["empty"]; !ok || v != "" {
		t.Error("a key with an empty value should still be recorded")
	}
}

func TestPickerNavigation(t *testing.T) {
	p := NewPicker(nil)
	p.publicBusy = false
	p.public = []Instance{
		{Name: "one", Host: "a:8080", Available: -1},
		{Name: "two", Host: "b:8080", Available: -1},
		{Name: "three", Host: "c:8080", Available: -1},
	}

	key := func(k tcell.Key, r rune) *tcell.EventKey { return tcell.NewEventKey(k, r, tcell.ModNone) }

	// The cursor must not run off either end of the list.
	p.HandleKey(key(tcell.KeyUp, 0))
	if p.cursor != 0 {
		t.Errorf("cursor went above the first entry: %d", p.cursor)
	}
	for i := 0; i < 10; i++ {
		p.HandleKey(key(tcell.KeyDown, 0))
	}
	if p.cursor != 2 {
		t.Errorf("cursor ran past the last entry: %d", p.cursor)
	}

	// Enter returns the highlighted instance.
	choice, done := p.HandleKey(key(tcell.KeyEnter, 0))
	if !done || choice == nil {
		t.Fatal("Enter should select the highlighted entry")
	}
	if choice.Name != "three" {
		t.Errorf("selected %q, want \"three\"", choice.Name)
	}
}

func TestPickerTypeToFilter(t *testing.T) {
	// Typing filters immediately — no mode to enter first — and matches on
	// name, callsign and location.
	p := NewPicker(nil)
	p.public = []Instance{
		{Name: "Scotland RX", Callsign: "M9PSY", Location: "Dalgety Bay", Host: "a:8080", Available: -1},
		{Name: "Canary RX", Callsign: "EA8DF4UE", Location: "Fuerteventura", Host: "b:8080", Available: -1},
		{Name: "Texas RX", Callsign: "K5JBT", Location: "Houston, TX", Host: "c:8080", Available: -1},
	}
	key := func(k tcell.Key, r rune) *tcell.EventKey { return tcell.NewEventKey(k, r, tcell.ModNone) }
	typeIn := func(s string) {
		for _, r := range s {
			p.HandleKey(key(tcell.KeyRune, r))
		}
	}

	// By name.
	typeIn("canary")
	if got := p.entries(); len(got) != 1 || got[0].Name != "Canary RX" {
		t.Errorf("name filter produced %d entries, want just Canary", len(got))
	}

	// By callsign.
	p.filter = ""
	typeIn("k5jbt")
	if got := p.entries(); len(got) != 1 || got[0].Name != "Texas RX" {
		t.Errorf("callsign filter produced %d entries, want just Texas", len(got))
	}

	// By location.
	p.filter = ""
	typeIn("houston")
	if got := p.entries(); len(got) != 1 || got[0].Name != "Texas RX" {
		t.Errorf("location filter produced %d entries, want just Texas", len(got))
	}

	// Backspace narrows back out as the search shortens.
	p.HandleKey(key(tcell.KeyBackspace2, 0))
	if p.filter != "housto" {
		t.Errorf("backspace left %q", p.filter)
	}

	// Escape clears the search but keeps the picker open.
	if _, done := p.HandleKey(key(tcell.KeyEscape, 0)); done {
		t.Error("Escape with a search active should clear it, not close the picker")
	}
	if p.filter != "" {
		t.Errorf("Escape left the filter as %q", p.filter)
	}
	if len(p.entries()) != 3 {
		t.Error("clearing the search should restore the full list")
	}

	// A second Escape, with no search, closes.
	if _, done := p.HandleKey(key(tcell.KeyEscape, 0)); !done {
		t.Error("Escape with no search should close the picker")
	}
}

func TestPickerLettersAreSearchNotCommands(t *testing.T) {
	// Letters must reach the search box: a receiver called "Quiet" would be
	// unsearchable if 'q' still meant quit, and 'j'/'k' must not navigate.
	p := NewPicker(nil)
	p.public = []Instance{
		{Name: "Quiet jack", Host: "a:8080", Available: -1},
		{Name: "Other", Host: "b:8080", Available: -1},
	}
	key := func(r rune) *tcell.EventKey { return tcell.NewEventKey(tcell.KeyRune, r, tcell.ModNone) }

	for _, r := range "qjk" {
		if _, done := p.HandleKey(key(r)); done {
			t.Fatalf("typing %q should not close the picker", r)
		}
	}
	if p.filter != "qjk" {
		t.Errorf("filter = %q, want \"qjk\"", p.filter)
	}

	// '/' is now just a character too, not a mode switch.
	p.filter = ""
	p.HandleKey(key('/'))
	if p.filter != "/" {
		t.Errorf("'/' should be literal search text, got filter %q", p.filter)
	}
}

func TestPickerFilterResetsCursorToTopMatch(t *testing.T) {
	// After narrowing the list the selection must land on the first match,
	// not linger at a stale index.
	p := NewPicker(nil)
	p.public = []Instance{
		{Name: "alpha", Host: "a:8080", Available: -1},
		{Name: "beta", Host: "b:8080", Available: -1},
		{Name: "gamma", Host: "c:8080", Available: -1},
	}
	key := func(k tcell.Key, r rune) *tcell.EventKey { return tcell.NewEventKey(k, r, tcell.ModNone) }

	p.HandleKey(key(tcell.KeyDown, 0))
	p.HandleKey(key(tcell.KeyDown, 0))
	if p.cursor != 2 {
		t.Fatalf("setup: cursor = %d, want 2", p.cursor)
	}

	for _, r := range "beta" {
		p.HandleKey(key(tcell.KeyRune, r))
	}
	if p.cursor != 0 {
		t.Errorf("cursor = %d after filtering, want 0", p.cursor)
	}
	choice, done := p.HandleKey(key(tcell.KeyEnter, 0))
	if !done || choice == nil || choice.Name != "beta" {
		t.Errorf("Enter selected %v, want beta", choice)
	}
}

func TestPickerCtrlUClearsSearch(t *testing.T) {
	p := NewPicker(nil)
	p.public = []Instance{{Name: "one", Host: "a:8080", Available: -1}}
	key := func(k tcell.Key, r rune) *tcell.EventKey { return tcell.NewEventKey(k, r, tcell.ModNone) }

	for _, r := range "xyz" {
		p.HandleKey(key(tcell.KeyRune, r))
	}
	p.HandleKey(key(tcell.KeyCtrlU, 0))
	if p.filter != "" {
		t.Errorf("Ctrl-U left the filter as %q", p.filter)
	}
}

func TestPickerManualEntry(t *testing.T) {
	p := NewPicker(nil)
	p.tab = TabManual
	key := func(k tcell.Key, r rune) *tcell.EventKey { return tcell.NewEventKey(k, r, tcell.ModNone) }

	for _, r := range "10.0.0.5:9000" {
		p.HandleKey(key(tcell.KeyRune, r))
	}
	choice, done := p.HandleKey(key(tcell.KeyEnter, 0))
	if !done || choice == nil {
		t.Fatal("Enter should accept the typed address")
	}
	if choice.Host != "10.0.0.5:9000" {
		t.Errorf("host = %q, want \"10.0.0.5:9000\"", choice.Host)
	}

	// Backspace edits, and an empty field is not accepted.
	p2 := NewPicker(nil)
	p2.tab = TabManual
	p2.HandleKey(key(tcell.KeyRune, 'x'))
	p2.HandleKey(key(tcell.KeyBackspace2, 0))
	if p2.manualBuf != "" {
		t.Errorf("backspace left %q", p2.manualBuf)
	}
	if _, done := p2.HandleKey(key(tcell.KeyEnter, 0)); done {
		t.Error("Enter on an empty field should not close the picker")
	}

	// Tab still switches away from the manual tab.
	if _, done := p2.HandleKey(key(tcell.KeyTab, 0)); done {
		t.Error("Tab should not close the picker")
	}
	if p2.tab == TabManual {
		t.Error("Tab should have switched tabs")
	}
}

func TestPickerEscapeRespectsMustChoose(t *testing.T) {
	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }

	// With a connection to fall back to, Escape closes the picker.
	p := NewPicker(nil)
	if _, done := p.HandleKey(key(tcell.KeyEscape)); !done {
		t.Error("Escape should close the picker when a fallback exists")
	}

	// With nothing connected, Escape must not close it silently; the event
	// loop turns that case into a quit instead.
	p2 := NewPicker(nil)
	p2.mustChoose = true
	if _, done := p2.HandleKey(key(tcell.KeyEscape)); done {
		t.Error("Escape should not close a must-choose picker")
	}
}

func TestPickerRendersEverySize(t *testing.T) {
	local := NewLocalDiscovery()
	for _, size := range [][2]int{{20, 5}, {30, 10}, {80, 24}, {200, 60}} {
		for _, tab := range []PickerTab{TabPublic, TabLocal, TabManual} {
			p := NewPicker(local)
			p.tab = tab
			p.public = []Instance{
				{Name: strings.Repeat("very long name ", 20), Location: "somewhere",
					Host: "a:8080", Available: 5, MaxUsers: 20},
				{Name: "second", Host: "b:8080", Available: -1},
			}
			p.filter = "e"

			screen := tcell.NewSimulationScreen("UTF-8")
			if err := screen.Init(); err != nil {
				t.Fatal(err)
			}
			screen.SetSize(size[0], size[1])

			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("picker panicked at %dx%d tab=%d: %v", size[0], size[1], tab, r)
					}
				}()
				p.Draw(screen)
			}()
		}
	}
}

func TestUIResetClearsPerConnectionState(t *testing.T) {
	ui := NewUI("old")
	ui.cfg = SpectrumConfig{CenterFreq: 7e6, BinCount: 1024, TotalBandwidth: 200e3}
	ui.SetFrame([]float32{-100, -50}, 0, 0)
	ui.vfo = 7.1e6
	ui.fps = 12
	ui.haveRange = true

	ui.Reset()

	if ui.bins != nil || ui.wf.Len() != 0 {
		t.Error("Reset should drop the spectrum and waterfall history")
	}
	if ui.vfo != 0 || ui.fps != 0 || ui.haveRange {
		t.Error("Reset should clear the VFO, frame rate and dB range")
	}
	if ui.cfg.BinCount != 0 {
		t.Error("Reset should clear the server config")
	}
	// Settings the user chose must survive a receiver switch.
	if ui.mode != ViewSplit || !ui.autoScale {
		t.Error("Reset should not disturb user display preferences")
	}
}

func TestTuningStepsAndFormat(t *testing.T) {
	ui := NewUI("test")
	if ui.StepHz() != 1000 {
		t.Errorf("default step = %v Hz, want 1000", ui.StepHz())
	}
	// Cycling wraps around the whole list.
	for i := 0; i < len(tuningSteps); i++ {
		ui.stepIdx = (ui.stepIdx + 1) % len(tuningSteps)
	}
	if ui.StepHz() != 1000 {
		t.Errorf("a full cycle should return to 1000 Hz, got %v", ui.StepHz())
	}

	if got := formatStep(10); got != "10Hz" {
		t.Errorf("formatStep(10) = %q, want \"10Hz\"", got)
	}
	if got := formatStep(9000); got != "9k" {
		t.Errorf("formatStep(9000) = %q, want \"9k\"", got)
	}
}

func TestLocalDiscoveryStartsEmpty(t *testing.T) {
	d := NewLocalDiscovery()
	if got := d.Instances(); len(got) != 0 {
		t.Errorf("new discovery reported %d instances", len(got))
	}
}

// TestLiveLocalDiscovery browses the real network. It is skipped unless
// UBERSDR_TEST_MDNS is set, since results depend on the LAN.
func TestLiveLocalDiscovery(t *testing.T) {
	if os.Getenv("UBERSDR_TEST_MDNS") == "" {
		t.Skip("set UBERSDR_TEST_MDNS to browse the local network")
	}

	d := NewLocalDiscovery()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := d.Run(ctx); err != nil {
		t.Fatalf("browse failed: %v", err)
	}
	// Run returns as soon as the query goes out; answers arrive afterwards,
	// and enrichment adds another round trip on top.
	<-ctx.Done()

	found := d.Instances()
	t.Logf("found %d local receiver(s)", len(found))
	for _, inst := range found {
		t.Logf("  %-40s %s", inst.Label(), inst.Detail())
		if strings.Contains(inst.Name, `\`) {
			t.Errorf("name still contains DNS escaping: %q", inst.Name)
		}
	}
}

// TestLivePublicDirectory fetches the real directory and renders the picker
// with it. Gated on UBERSDR_TEST_DIRECTORY since it needs the network.
func TestLivePublicDirectory(t *testing.T) {
	if os.Getenv("UBERSDR_TEST_DIRECTORY") == "" {
		t.Skip("set UBERSDR_TEST_DIRECTORY to fetch the live directory")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	list, err := FetchPublicInstances(ctx)
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	if len(list) == 0 {
		t.Fatal("directory returned no receivers")
	}
	t.Logf("fetched %d public receivers", len(list))

	p := NewPicker(NewLocalDiscovery())
	p.public = list

	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(110, 26)
	p.Draw(screen)
	screen.Show() // Draw fills the buffer; the event loop normally commits it
	t.Logf("\n%s", dump(screen))
}

func TestUnescapeDNSName(t *testing.T) {
	cases := []struct{ in, want string }{
		// The reported case: spaces escaped as "\ ".
		{`ubersdr\ on\ ubersdr`, "ubersdr on ubersdr"},
		// Nothing to do.
		{"plainname", "plainname"},
		{"", ""},
		// Escaped dots must survive as literal dots.
		{`my\.receiver`, "my.receiver"},
		// Decimal byte escapes: \032 is a space, \046 a dot.
		{`RX888\032MkII`, "RX888 MkII"},
		{`a\046b`, "a.b"},
		// A backslash escaping a backslash.
		{`back\\slash`, `back\slash`},
		// Multi-byte UTF-8 escaped byte by byte reassembles correctly
		// (\195\169 is "é").
		{`caf\195\169`, "café"},
		// A trailing backslash is dropped rather than panicking.
		{`trailing\`, "trailing"},
		// Digits that aren't a complete triple are treated as a literal escape.
		{`n\12`, "n12"},
	}
	for _, c := range cases {
		if got := unescapeDNSName(c.in); got != c.want {
			t.Errorf("unescapeDNSName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestLocalDiscoveryEnrichesFromDescription(t *testing.T) {
	// A receiver's own /api/description should replace the bare mDNS name.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/description" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"receiver": map[string]interface{}{
				"name":     "RX888 with end-fed long wire",
				"location": "Dalgety Bay, Scotland, UK",
				"callsign": "M9PSY",
			},
			"max_clients":       20,
			"available_clients": 17,
			"version":           "0.1.58",
		})
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://")
	d := NewLocalDiscovery()
	d.found["key"] = Instance{Name: "ubersdr on ubersdr", Host: host, Available: -1, Local: true}

	d.enrich("key", d.found["key"])

	got := d.Instances()
	if len(got) != 1 {
		t.Fatalf("expected 1 instance, got %d", len(got))
	}
	if got[0].Name != "RX888 with end-fed long wire" {
		t.Errorf("name = %q, want the receiver's own name", got[0].Name)
	}
	if got[0].Location != "Dalgety Bay, Scotland, UK" {
		t.Errorf("location = %q", got[0].Location)
	}
	if got[0].Available != 17 || got[0].MaxUsers != 20 {
		t.Errorf("slots = %d/%d, want 17/20", got[0].Available, got[0].MaxUsers)
	}
	// The host must not be rewritten by enrichment.
	if got[0].Host != host {
		t.Errorf("host changed to %q, want %q", got[0].Host, host)
	}
}

func TestLocalDiscoveryEnrichSurvivesBadResponses(t *testing.T) {
	// An unreachable or nonsense receiver must leave the mDNS entry intact
	// rather than blanking or dropping it.
	for _, handler := range []http.HandlerFunc{
		func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusInternalServerError) },
		func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("not json")) },
		func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(map[string]string{}) },
	} {
		srv := httptest.NewServer(handler)
		host := strings.TrimPrefix(srv.URL, "http://")

		d := NewLocalDiscovery()
		original := Instance{Name: "fallback name", Host: host, Available: -1, Local: true}
		d.found["key"] = original
		d.enrich("key", original)

		got := d.Instances()
		if len(got) != 1 {
			t.Fatalf("entry disappeared after a bad response")
		}
		if got[0].Name != "fallback name" {
			t.Errorf("name = %q, want the mDNS name preserved", got[0].Name)
		}
		srv.Close()
	}

	// An entry removed before enrichment finishes must not be resurrected.
	d := NewLocalDiscovery()
	d.enrich("missing", Instance{Host: "127.0.0.1:1", Available: -1})
	if len(d.Instances()) != 0 {
		t.Error("enrich resurrected an entry that no longer exists")
	}
}
