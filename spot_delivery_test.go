package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ─── When delivery runs ──────────────────────────────────────────────────────

func TestSpotsEnabledHelpers(t *testing.T) {
	for _, tc := range []struct {
		decoder, cw, feed bool
		digital, cwSpots  bool
	}{
		{false, false, false, false, false},
		{true, false, false, true, false},
		{false, true, false, false, true},
		{false, false, true, true, true}, // the feed brings both
		{true, true, true, true, true},
	} {
		cfg := &Config{}
		cfg.Decoder.Enabled = tc.decoder
		cfg.SkimmerFeed.Enabled = tc.feed
		cw := &CWSkimmerConfig{Enabled: tc.cw}
		if got := cfg.DigitalSpotsEnabled(); got != tc.digital {
			t.Errorf("%+v: digital = %v", tc, got)
		}
		if got := cfg.CWSpotsEnabled(cw); got != tc.cwSpots {
			t.Errorf("%+v: cw = %v", tc, got)
		}
	}
	if (&Config{}).CWSpotsEnabled(nil) {
		t.Error("nil cwskimmer config, no feed: CW spots enabled")
	}
}

func TestPrepareDecoderStoreConfig(t *testing.T) {
	// Local decoders on, decoder.yaml read: exactly as main.go resolved them
	// before (relative under the config dir, absolute kept, empty defaulted),
	// and nothing forced.
	cfg := &Config{}
	cfg.Decoder = DecoderConfig{
		Enabled: true, SpotsLogEnabled: true, SpotsLogDataDir: "spots",
		MetricsLogEnabled: true, MetricsLogDataDir: "/abs/metrics",
	}
	prepareDecoderStoreConfig(cfg, "/etc/ubersdr", true)
	d := cfg.Decoder
	if d.DataDir != "/etc/ubersdr/decoder_data" || d.SpotsLogDataDir != "/etc/ubersdr/spots" ||
		d.MetricsLogDataDir != "/abs/metrics" || d.MetricsSummaryDataDir != "/etc/ubersdr/decoder_summaries" {
		t.Errorf("paths = %q %q %q %q", d.DataDir, d.SpotsLogDataDir, d.MetricsLogDataDir, d.MetricsSummaryDataDir)
	}
	if d.SpotsLogLocatorsOnly == nil || !*d.SpotsLogLocatorsOnly {
		t.Error("spots_log_locators_only not defaulted to true")
	}
	if d.SpotsLogMaxAgeDays != 0 {
		t.Errorf("retention forced to %d", d.SpotsLogMaxAgeDays)
	}

	// Decoders off and no feed: untouched.
	cfg = &Config{}
	prepareDecoderStoreConfig(cfg, "/etc/ubersdr", false)
	if cfg.Decoder.SpotsLogEnabled || cfg.Decoder.SpotsLogDataDir != "" || cfg.Decoder.SpotsLogLocatorsOnly != nil {
		t.Errorf("decoder off, no feed, yet changed: %+v", cfg.Decoder)
	}

	// Only the feed, no decoder.yaml: decoder.yaml.example's store settings.
	cfg = &Config{}
	cfg.SkimmerFeed.Enabled = true
	prepareDecoderStoreConfig(cfg, "/etc/ubersdr", false)
	d = cfg.Decoder
	if !d.SpotsLogEnabled || !d.MetricsLogEnabled || d.SpotsLogMaxAgeDays != 90 || d.MetricsLogIntervalSecs != 300 {
		t.Errorf("feed-only defaults = %+v", d)
	}
	if d.SpotsLogDataDir != "/etc/ubersdr/decoder_spots" || d.MetricsLogDataDir != "/etc/ubersdr/decoder_metrics" ||
		d.MetricsSummaryDataDir != "/etc/ubersdr/decoder_summaries" {
		t.Errorf("feed-only paths = %q %q %q", d.SpotsLogDataDir, d.MetricsLogDataDir, d.MetricsSummaryDataDir)
	}
	if d.DataDir != "" {
		t.Errorf("the decoders' work directory set (%q) with no decoders", d.DataDir)
	}
	if d.Enabled {
		t.Error("the decoders were turned on")
	}

	// Only the feed, decoder.yaml read (its decoders off): the file's own
	// store settings stand, spots logging off included.
	cfg = &Config{}
	cfg.SkimmerFeed.Enabled = true
	cfg.Decoder = DecoderConfig{SpotsLogEnabled: false, MetricsLogEnabled: true}
	prepareDecoderStoreConfig(cfg, "/etc/ubersdr", true)
	if cfg.Decoder.SpotsLogEnabled || cfg.Decoder.SpotsLogMaxAgeDays != 0 || cfg.Decoder.MetricsLogDataDir != "/etc/ubersdr/decoder_metrics" {
		t.Errorf("decoder.yaml's settings not kept: %+v", cfg.Decoder)
	}
}

func TestPrepareCWSkimmerStoreConfig(t *testing.T) {
	// Telnet client on, cwskimmer.yaml read: as main.go resolved them before.
	cw := &CWSkimmerConfig{Enabled: true, SpotsLogEnabled: true, SpotsLogDataDir: "data/spots", MetricsLogEnabled: true,
		MetricsLogDataDir: "cwskimmer_metrics", MetricsSummaryDataDir: "/abs/summaries"}
	prepareCWSkimmerStoreConfig(cw, false, "/etc/ubersdr", true)
	if cw.SpotsLogDataDir != "/etc/ubersdr/data/spots" || cw.MetricsLogDataDir != "/etc/ubersdr/cwskimmer_metrics" ||
		cw.MetricsSummaryDataDir != "/abs/summaries" {
		t.Errorf("paths = %q %q %q", cw.SpotsLogDataDir, cw.MetricsLogDataDir, cw.MetricsSummaryDataDir)
	}

	// No cwskimmer.yaml and no feed: left as main.go always left it.
	cw = &CWSkimmerConfig{}
	prepareCWSkimmerStoreConfig(cw, false, "/etc/ubersdr", false)
	if *cw != (CWSkimmerConfig{}) {
		t.Errorf("no file, no feed, yet changed: %+v", *cw)
	}

	// No cwskimmer.yaml, feed on: the file's defaults and spots and metrics
	// logged; the telnet client and its PSK Reporter stay off.
	cw = &CWSkimmerConfig{}
	prepareCWSkimmerStoreConfig(cw, true, "/etc/ubersdr", false)
	if cw.Enabled || cw.PSKReporterEnabled {
		t.Errorf("telnet or PSK Reporter turned on: %+v", *cw)
	}
	if !cw.SpotsLogEnabled || !cw.MetricsLogEnabled || cw.MetricsLogIntervalSecs != 300 {
		t.Errorf("feed-only defaults = %+v", *cw)
	}
	if cw.SpotsLogDataDir != "/etc/ubersdr/data/spots" || cw.MetricsLogDataDir != "/etc/ubersdr/cwskimmer_metrics" ||
		cw.MetricsSummaryDataDir != "/etc/ubersdr/cwskimmer_summaries" {
		t.Errorf("feed-only paths = %q %q %q", cw.SpotsLogDataDir, cw.MetricsLogDataDir, cw.MetricsSummaryDataDir)
	}

	// cwskimmer.yaml read but disabled, feed on: the file's settings stand.
	cw = &CWSkimmerConfig{SpotsLogEnabled: false, MetricsLogEnabled: true, MetricsLogDataDir: "m", MetricsSummaryDataDir: "s"}
	prepareCWSkimmerStoreConfig(cw, true, "/etc/ubersdr", true)
	if cw.SpotsLogEnabled || cw.MetricsLogDataDir != "/etc/ubersdr/m" {
		t.Errorf("cwskimmer.yaml's settings not kept: %+v", *cw)
	}
}

// ─── Ingest-only MultiDecoder ────────────────────────────────────────────────

// newIngestDecoder is an ingest-only MultiDecoder over a real SQLite DB, with
// spots and metrics logged as a feed-only receiver has them.
func newIngestDecoder(t *testing.T, locatorsOnly bool) *MultiDecoder {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	dir := t.TempDir()
	cfg := &DecoderConfig{
		SpotsLogEnabled: true, SpotsLogDataDir: filepath.Join(dir, "spots"), SpotsLogLocatorsOnly: &locatorsOnly,
		MetricsLogEnabled: true, MetricsLogDataDir: filepath.Join(dir, "metrics"), MetricsSummaryDataDir: filepath.Join(dir, "summaries"),
		// Reporting asked for in the file: ingest-only must ignore it.
		PSKReporterEnabled: true, WSPRNetEnabled: true, ReceiverCallsign: "M9PSY", ReceiverLocator: "IO86ha",
	}
	md, err := NewMultiDecoderIngestOnly(cfg, nil)
	if err != nil {
		t.Fatalf("NewMultiDecoderIngestOnly: %v", err)
	}
	md.SetDB(mgr.DB())
	md.SetReadDB(mgr.ReadDB())
	return md
}

func TestIngestOnlyMultiDecoderDelivers(t *testing.T) {
	md := newIngestDecoder(t, true)
	if md.pskReporter != nil || md.wsprNet != nil {
		t.Fatal("an ingest-only decoder made a reporter")
	}
	if !md.IsIngestOnly() {
		t.Fatal("not ingest-only")
	}
	got := make(chan DecodeInfo, 4)
	md.OnDecode(func(d DecodeInfo) { got <- d })
	if err := md.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer md.Stop()
	if len(md.decoderBands) != 0 {
		t.Fatalf("Start made %d bands", len(md.decoderBands))
	}

	ft8 := skimmerFeedDecode(parseFeedSpot(t, feedFT8Locator))
	md.IngestDecode(ft8)
	select {
	case d := <-got:
		if d.Callsign != "DG8LAS" || d.BandName != "skimmer_40m_FT8" {
			t.Errorf("callback got %+v", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the decode callback was not called")
	}

	// In the spots store, under its own band name.
	day := ft8.Timestamp.Format("2006-01-02")
	spots, err := md.spotsLogger.GetHistoricalSpots("", "", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil {
		t.Fatalf("GetHistoricalSpots: %v", err)
	}
	if len(spots) != 1 || spots[0].Callsign != "DG8LAS" || spots[0].Name != "skimmer_40m_FT8" || spots[0].Locator != "JO40" ||
		spots[0].Message != "G0ABI DG8LAS JO40" || spots[0].Frequency != 7074318 {
		t.Errorf("stored = %+v", spots)
	}

	// Counted, and its mode listed for the receiver description.
	if md.stats.SpotsPerBand["skimmer_40m_FT8"] != 1 || md.stats.DecodesPerBand["skimmer_40m_FT8"] != 1 {
		t.Errorf("stats: decodes %v spots %v", md.stats.DecodesPerBand, md.stats.SpotsPerBand)
	}
	if modes := md.IngestedModes(); len(modes) != 1 || modes[0] != "FT8" {
		t.Errorf("ingested modes = %v", modes)
	}

	// Without a locator: shown (the callback) but not stored, as
	// spots_log_locators_only has it for local decodes.
	md.IngestDecode(skimmerFeedDecode(parseFeedSpot(t, feedFT8Cty)))
	select {
	case d := <-got:
		if d.Callsign != "CT1DHR" {
			t.Errorf("callback got %+v", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the callback was not called for a spot with no locator")
	}
	spots, _ = md.spotsLogger.GetHistoricalSpots("", "", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if len(spots) != 1 {
		t.Errorf("stored %d spots; the one with no locator must not be", len(spots))
	}

	// WSPR and JS8 go the same way.
	md.IngestDecode(skimmerFeedDecode(parseFeedSpot(t, feedWSPR)))
	md.IngestDecode(skimmerFeedDecode(parseFeedSpot(t, feedJS8)))
	for i := 0; i < 2; i++ {
		select {
		case <-got:
		case <-time.After(2 * time.Second):
			t.Fatal("WSPR/JS8 not delivered")
		}
	}
	if modes := md.IngestedModes(); fmt.Sprint(modes) != "[FT8 JS8 WSPR]" {
		t.Errorf("ingested modes = %v", modes)
	}
}

func TestIngestOnlyLocatorsOnlyOff(t *testing.T) {
	md := newIngestDecoder(t, false)
	if err := md.Start(); err != nil {
		t.Fatal(err)
	}
	defer md.Stop()
	d := skimmerFeedDecode(parseFeedSpot(t, feedFT8Cty))
	md.IngestDecode(d)
	day := d.Timestamp.Format("2006-01-02")
	spots, err := md.spotsLogger.GetHistoricalSpots("", "", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil || len(spots) != 1 {
		t.Errorf("with spots_log_locators_only false, a spot with no locator is stored: got %d, %v", len(spots), err)
	}
}

func TestIngestCycleSeconds(t *testing.T) {
	for _, tc := range []struct {
		mode, submode string
		want          int
	}{
		{"FT8", "", 0}, {"FT4", "", 0}, {"FT2", "", 0}, {"JS8", "A", 0},
		{"WSPR", "", 120}, {"WSPR", "WSPR-15", 900}, {"WSPR", "FST4W-120", 120}, {"WSPR", "FST4W-1800", 1800},
		{"WSPR", "FST4W-x", 120},
	} {
		if got := ingestCycleSeconds(tc.mode, tc.submode); got != tc.want {
			t.Errorf("%s/%s = %d, want %d", tc.mode, tc.submode, got, tc.want)
		}
	}
}

func TestIngestDecodeNilSafe(t *testing.T) {
	var md *MultiDecoder
	md.IngestDecode(DecodeInfo{Mode: "FT8"}) // a receiver with digital spots off
	if md.IngestedModes() != nil || md.IsIngestOnly() {
		t.Error("nil decoder")
	}
}

// ─── CW client with no telnet connection ─────────────────────────────────────

func newIngestCWClient(t *testing.T) *CWSkimmerClient {
	t.Helper()
	cfg := &CWSkimmerConfig{}
	prepareCWSkimmerStoreConfig(cfg, true, t.TempDir(), false)
	// PSK Reporter asked for in a file: the feed's spots must never reach it.
	cfg.PSKReporterEnabled = true
	c := NewCWSkimmerClient(cfg, nil, 0, 0, 30_000_000)
	c.SetSpotsLogger(newTestCWSpotsLogger(t))
	return c
}

func TestCWClientIngestOnly(t *testing.T) {
	c := newIngestCWClient(t)
	if c.TelnetEnabled() {
		t.Fatal("telnet enabled")
	}
	if err := c.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Stop()
	if c.IsConnected() {
		t.Fatal("connected with no telnet configured")
	}
	var mu sync.Mutex
	var handled []CWSkimmerSpot
	c.OnSpot(func(s CWSkimmerSpot) { mu.Lock(); handled = append(handled, s); mu.Unlock() })

	spot := skimmerFeedCWSpot(parseFeedSpot(t, feedCWQRZ))
	c.IngestSpot(spot)
	c.IngestSpot(skimmerFeedCWSpot(parseFeedSpot(t, feedRTTY)))
	high := spot
	high.Frequency = 50_313_000 // above the receiver
	c.IngestSpot(high)

	waitForFeed(t, "two spots handled", func() bool { mu.Lock(); defer mu.Unlock(); return len(handled) == 2 })
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	if len(handled) != 2 {
		t.Errorf("handled %d spots; the one above the receiver's range must be dropped", len(handled))
	}
	mu.Unlock()

	// In the CW spots store, enriched as the feed sent it (no lookups here).
	day := spot.Time.Format("2006-01-02")
	var stored []CWSpotRecord
	waitForFeed(t, "the spot stored", func() bool {
		recs, err := c.spotsLogger.GetCWHistoricalSpots("", "", nil, "", "", "", day, day, "", "", false, 0, -999, nil)
		if err != nil {
			t.Fatalf("GetCWHistoricalSpots: %v", err)
		}
		stored = recs
		return len(recs) >= 1
	})
	var hg *CWSpotRecord
	for i := range stored {
		if stored[i].Callsign == "HG0R" {
			hg = &stored[i]
		}
	}
	if hg == nil {
		t.Fatalf("HG0R not stored: %+v", stored)
	}
	if hg.WPM != 27 || hg.Country != "Hungary" || hg.Comment != "CQ" || hg.Band != "20m" || hg.CQZone != 15 ||
		hg.Latitude == nil || *hg.Latitude != 47.5 || hg.DistanceKm == nil || *hg.DistanceKm != 1617 {
		t.Errorf("stored = %+v", *hg)
	}

	c.mu.RLock()
	last := c.lastSpotTime
	c.mu.RUnlock()
	if last.IsZero() {
		t.Error("last spot time not updated")
	}
	if c.pskReporter != nil {
		t.Error("a PSK Reporter was set")
	}
}

func TestCWIngestNilSafe(t *testing.T) {
	var c *CWSkimmerClient
	c.IngestSpot(CWSkimmerSpot{Frequency: 7e6})
	if c.TelnetEnabled() {
		t.Error("nil client telnet enabled")
	}
}

// A client with no telnet connection has none to probe: no "not connected"
// alarm on a feed-only receiver.  With telnet configured, the probe is there.
func TestCWHealthProbeOnlyWithTelnet(t *testing.T) {
	cfg := &Config{}
	names := func(c *CWSkimmerClient) []string {
		var n []string
		for _, p := range BuildSystemHealthProbes(nil, nil, nil, c, nil, nil, nil, nil, nil, nil, nil, cfg, nil, nil) {
			n = append(n, p.component)
		}
		return n
	}
	ingest := NewCWSkimmerClient(&CWSkimmerConfig{}, nil, 0, 0, 0)
	for _, n := range names(ingest) {
		if n == "cw_skimmer" {
			t.Error("a CW health probe for a client with no telnet connection")
		}
	}
	telnet := NewCWSkimmerClient(&CWSkimmerConfig{Enabled: true, Host: "skimmer", Callsign: "M9PSY"}, nil, 0, 0, 0)
	found := false
	for _, n := range names(telnet) {
		found = found || n == "cw_skimmer"
	}
	if !found {
		t.Error("no CW health probe for the telnet client")
	}
}

// ─── The whole path: feed → delivery, with local decoders and CW off ─────────

// The skimmer's feed delivered into ingest-only stores, as main.go wires them
// on a receiver with decoder.yaml and cwskimmer.yaml disabled: every spot
// reaches the stores and the callbacks, and no reporter exists to reach.
func TestSkimmerFeedIntoIngestOnlyDelivery(t *testing.T) {
	md := newIngestDecoder(t, true)
	if err := md.Start(); err != nil {
		t.Fatal(err)
	}
	defer md.Stop()
	cw := newIngestCWClient(t)
	_ = cw.Start()
	defer cw.Stop()

	var mu sync.Mutex
	var digital, cwSpots []string
	md.OnDecode(func(d DecodeInfo) { mu.Lock(); digital = append(digital, d.Mode+":"+d.Callsign); mu.Unlock() })
	cw.OnSpot(func(s CWSkimmerSpot) { mu.Lock(); cwSpots = append(cwSpots, s.Mode+":"+s.DXCall); mu.Unlock() })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, d := range []string{feedCWCty, feedFT8Locator, feedRTTY, feedWSPR, feedJS8, feedJTTY} {
			fmt.Fprint(w, sseSpot(d))
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	feed := newTestFeedClient(srv.URL)
	feed.OnDigitalSpot(md.IngestDecode)
	feed.OnCWSpot(cw.IngestSpot)
	feed.Start()
	defer feed.Stop()

	waitForFeed(t, "all six spots delivered", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(digital) == 3 && len(cwSpots) == 3
	})
	if md.pskReporter != nil || md.wsprNet != nil || cw.pskReporter != nil {
		t.Error("a reporter exists on the feed's path")
	}
	day := time.Unix(1791789765, 0).UTC().Format("2006-01-02")
	spots, err := md.spotsLogger.GetHistoricalSpots("", "", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	calls := map[string]bool{}
	for _, sp := range spots {
		calls[sp.Callsign] = true
	}
	// That day's FT8 and JS8 spots (both with a locator); WSPR's is another day's.
	if err != nil || len(spots) != 2 || !calls["DG8LAS"] || !calls["DK1NJB"] {
		t.Errorf("digital store = %+v, %v", spots, err)
	}
}

func TestSkimmerFeedOverlapWarnings(t *testing.T) {
	md := &MultiDecoder{}
	cwc := &CWSkimmerClient{}
	cfg := &Config{}
	if w := skimmerFeedOverlapWarnings(cfg, &CWSkimmerConfig{Enabled: true}, nil, nil); w != nil {
		t.Errorf("feed off, yet warnings: %v", w)
	}
	cfg.SkimmerFeed.Enabled = true
	if w := skimmerFeedOverlapWarnings(cfg, &CWSkimmerConfig{}, md, cwc); len(w) != 0 {
		t.Errorf("feed alone, yet warnings: %v", w)
	}
	cfg.Decoder.Enabled = true
	w := skimmerFeedOverlapWarnings(cfg, &CWSkimmerConfig{Enabled: true, Host: "Skimmer"}, md, cwc)
	if len(w) != 2 || !strings.Contains(w[0], "decoder.enabled: false") || !strings.Contains(w[1], "telnet port") {
		t.Errorf("warnings = %q", w)
	}
	cfg.Decoder.Enabled = false
	w = skimmerFeedOverlapWarnings(cfg, &CWSkimmerConfig{Enabled: true, Host: "cwskimmer"}, nil, nil)
	if len(w) != 3 || strings.Contains(w[0], "telnet port") || !strings.Contains(w[1], "digital spots will be dropped") ||
		!strings.Contains(w[2], "CW spots will be dropped") {
		t.Errorf("warnings = %q", w)
	}
}

func TestStartSkimmerFeedOffIsNil(t *testing.T) {
	if f := startSkimmerFeed(&Config{}, &CWSkimmerConfig{}, nil, nil); f != nil {
		f.Stop()
		t.Fatal("started with skimmer_feed off")
	}
}

// main.go's wiring: startSkimmerFeed into an ingest-only decoder and a CW
// client with no telnet, repeats of a CW call held back, FST4W as WSPR.
func TestStartSkimmerFeedDelivers(t *testing.T) {
	md := newIngestDecoder(t, true)
	if err := md.Start(); err != nil {
		t.Fatal(err)
	}
	defer md.Stop()
	cwc := newIngestCWClient(t)
	_ = cwc.Start()
	defer cwc.Stop()

	var mu sync.Mutex
	var digital, cw []string
	md.OnDecode(func(d DecodeInfo) {
		mu.Lock()
		digital = append(digital, d.Mode+"/"+d.Submode+":"+d.Callsign)
		mu.Unlock()
	})
	cwc.OnSpot(func(s CWSkimmerSpot) { mu.Lock(); cw = append(cw, s.Mode+":"+s.DXCall); mu.Unlock() })

	again := strings.Replace(strings.Replace(feedCWCty, `"seq":1791789752582`, `"seq":1791789752590`, 1), `"t":1791789782`, `"t":1791789842`, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, d := range []string{feedCWCty, again, feedFT8Locator, feedFST4W, feedJS8} {
			fmt.Fprint(w, sseSpot(d))
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	cfg := &Config{}
	cfg.SkimmerFeed = SkimmerFeedConfig{Enabled: true, URL: srv.URL + "/api/feed"}
	feed := startSkimmerFeed(cfg, &CWSkimmerConfig{}, md, cwc)
	if feed == nil {
		t.Fatal("not started")
	}
	defer feed.Stop()

	waitForFeed(t, "the spots", func() bool { mu.Lock(); defer mu.Unlock(); return len(digital) == 3 && len(cw) == 1 })
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(cw) != "[CW:DL6LV/P]" {
		t.Errorf("CW = %v: the repeat a minute on is to be held back", cw)
	}
	got := map[string]bool{}
	for _, d := range digital {
		got[d] = true
	}
	if !got["FT8/:DG8LAS"] || !got["WSPR/FST4W-300:DL0HOT"] || !got["JS8/A:DK1NJB"] {
		t.Errorf("digital = %v", digital)
	}
	if st := feed.Status(); st.Held != 1 {
		t.Errorf("held = %d", st.Held)
	}
}

// The CW stream (/api/cwskimmer/stream, read by the dxcluster addon) says each
// spot's mode, so the skimmer feed's RTTY and JTTY are not taken for CW.
func TestCWSkimmerSSECarriesMode(t *testing.T) {
	hub := NewCWSkimmerSSEHub()
	c := &cwSkimmerSSEClient{ch: make(chan string, 8)}
	hub.register(c)
	for _, d := range []string{feedCWCty, feedRTTY, feedJTTY} {
		hub.Broadcast(skimmerFeedCWSpot(parseFeedSpot(t, d)))
	}
	var modes []string
	for i := 0; i < 3; i++ {
		line := <-c.ch
		var evt CWSkimmerSSEEvent
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data: "))), &evt); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		modes = append(modes, evt.Mode+":"+evt.Callsign)
	}
	if fmt.Sprint(modes) != "[CW:DL6LV/P RTTY:OH2BH JTTY:HA5X]" {
		t.Errorf("modes = %v", modes)
	}
}
