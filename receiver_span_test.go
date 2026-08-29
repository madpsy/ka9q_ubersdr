package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// testReceiver builds a ReceiverConfig the way resolveReceiver does, with every field
// consistent. Setting only MinFrequency/MaxFrequency leaves SpanHz and CenterHz at zero,
// where the accessors fall back to 30 MHz independently — a fixture that quietly
// describes two different receivers at once.
func testReceiver(span uint64) ReceiverConfig {
	return ReceiverConfig{
		InputSamprate:  64_800_000,
		SamprateSource: "radiod-conf",
		SpanHz:         span,
		CenterHz:       span / 2,
		MinFrequency:   receiverMinFrequency,
		MaxFrequency:   span,
	}
}

// The whole change is supposed to be invisible until the radiod sample rate moves.
// These are the numbers the codebase used to hardcode; if any of them shifts at
// 64.8 Msps, the migration has changed behaviour it promised not to.
func TestReceiverGeometryUnchangedAt64_8Msps(t *testing.T) {
	rc := ReceiverConfig{}
	span := receiverSpanFor(64_800_000)
	rc.SpanHz = span
	rc.CenterHz = span / 2

	if span != 30_000_000 {
		t.Errorf("span: got %d, want 30000000", span)
	}
	if rc.CenterHz != 15_000_000 {
		t.Errorf("centre: got %d, want 15000000", rc.CenterHz)
	}
	if bins := defaultSpectrumBinCount(span); bins != 1024 {
		t.Errorf("bin count: got %d, want 1024", bins)
	}
	if bw := float64(span) / 1024; bw != 29296.875 {
		t.Errorf("bin bandwidth: got %v, want 29296.875", bw)
	}
	nfBins, nfBW := widebandGeometry(span)
	if nfBins != 4096 || nfBW != 7324.21875 {
		t.Errorf("wideband: got %d x %v, want 4096 x 7324.21875", nfBins, nfBW)
	}
}

// 129.6 Msps is the point of the exercise: the span doubles, the bin count doubles
// with it, and Hz-per-bin at full zoom-out does not move — which is what keeps the
// v2 zoom ladder on the same rungs.
func TestReceiverGeometryAt129_6Msps(t *testing.T) {
	span := receiverSpanFor(129_600_000)
	if span != 60_000_000 {
		t.Fatalf("span: got %d, want 60000000", span)
	}
	if span/2 != 30_000_000 {
		t.Errorf("centre: got %d, want 30000000", span/2)
	}
	bins := defaultSpectrumBinCount(span)
	if bins != 2048 {
		t.Fatalf("bin count: got %d, want 2048", bins)
	}
	if bw := float64(span) / float64(bins); bw != 29296.875 {
		t.Errorf("bin bandwidth: got %v, want 29296.875 (same as at 30 MHz)", bw)
	}
	nfBins, nfBW := widebandGeometry(span)
	if nfBins != 8192 || nfBW != 7324.21875 {
		t.Errorf("wideband: got %d x %v, want 8192 x 7324.21875", nfBins, nfBW)
	}
}

func TestReceiverSpanRoundsDownToWholeMHz(t *testing.T) {
	for _, tt := range []struct {
		samprate int
		want     uint64
	}{
		{64_800_000, 30_000_000},  // 30.456 MHz usable
		{129_600_000, 60_000_000}, // 60.912 MHz usable
		{32_000_000, 15_000_000},  // 15.04 MHz usable
		{100_000_000, 47_000_000}, // 47.0 MHz usable
		{0, 30_000_000},           // nonsense falls back rather than degenerating
		{-1, 30_000_000},
		{1000, 30_000_000}, // too narrow to express in whole MHz
	} {
		if got := receiverSpanFor(tt.samprate); got != tt.want {
			t.Errorf("receiverSpanFor(%d) = %d, want %d", tt.samprate, got, tt.want)
		}
	}
}

// An unreadable radiod config must produce a working 30 MHz receiver, not an error:
// booting narrow beats not booting.
func TestResolveReceiverFallsBackWhenConfMissing(t *testing.T) {
	rc := resolveReceiverFrom(filepath.Join(t.TempDir(), "nope.conf"))
	if rc.SamprateSource != "fallback" {
		t.Errorf("source: got %q, want \"fallback\"", rc.SamprateSource)
	}
	if rc.SpanHz != 30_000_000 || rc.CenterHz != 15_000_000 {
		t.Errorf("geometry: got span %d centre %d, want 30000000/15000000", rc.SpanHz, rc.CenterHz)
	}
	if rc.MinFrequency != 10_000 || rc.MaxFrequency != 30_000_000 {
		t.Errorf("limits: got %d-%d, want 10000-30000000", rc.MinFrequency, rc.MaxFrequency)
	}
}

func TestResolveReceiverReadsRadiodConf(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "radiod@ubersdr.conf")
	conf := `[global]
hardware = rx888
samprate = 12000

[rx888]
device = rx888
samprate = 129600000   # full speed
`
	if err := os.WriteFile(path, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}

	rc := resolveReceiverFrom(path)

	if rc.SamprateSource != "radiod-conf" {
		t.Errorf("source: got %q, want \"radiod-conf\"", rc.SamprateSource)
	}
	if rc.InputSamprate != 129_600_000 {
		t.Errorf("samprate: got %d, want 129600000", rc.InputSamprate)
	}
	if rc.SpanHz != 60_000_000 {
		t.Errorf("span: got %d, want 60000000", rc.SpanHz)
	}
}

// [global] samprate is the audio output rate and must never be mistaken for the
// front end rate, even though the key has the same name.
func TestResolveReceiverIgnoresGlobalSamprate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "radiod.conf")
	conf := "[global]\nhardware = rx888\nsamprate = 12000\n\n[rx888]\nsamprate = 64800000\n"
	if err := os.WriteFile(path, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	if rc := resolveReceiverFrom(path); rc.InputSamprate != 64_800_000 {
		t.Errorf("samprate: got %d, want 64800000", rc.InputSamprate)
	}
}

// The radiod config is the only input. There is no config.yaml key that can influence the
// span, and RadiodConfPath is a constant rather than a setting — this test exists so that
// adding one is a deliberate act that breaks something, not a quiet drift back to two
// sources of truth.
func TestReceiverHasNoConfigYAMLInfluence(t *testing.T) {
	if RadiodConfPath != "/etc/ka9q-radio/radiod@ubersdr.conf" {
		t.Errorf("RadiodConfPath moved: %q", RadiodConfPath)
	}

	// A Config with everything in it must not change what resolveReceiverFrom returns:
	// the function does not take one.
	dir := t.TempDir()
	path := filepath.Join(dir, "radiod.conf")
	if err := os.WriteFile(path, []byte("[rx888]\nsamprate = 129600000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rc := resolveReceiverFrom(path)
	if rc.SamprateSource != "radiod-conf" || rc.SpanHz != 60_000_000 {
		t.Errorf("radiod conf not honoured: source %q span %d", rc.SamprateSource, rc.SpanHz)
	}

	// RadiodConfig carries only the multicast wiring — no span-related fields.
	if n := reflect.TypeOf(RadiodConfig{}).NumField(); n != 3 {
		t.Errorf("RadiodConfig gained a field (%d, want 3) — is the span settable again?", n)
	}
}

func TestParseRadiodFrequencySuffixes(t *testing.T) {
	for _, tt := range []struct {
		in   string
		want int
		ok   bool
	}{
		{"129600000", 129_600_000, true},
		{"64800000", 64_800_000, true},
		{"129.6m", 129_600_000, true},
		{"64800k", 64_800_000, true},
		{"12k", 12_000, true},
		{"", 0, false},
		{"-5", 0, false},
		{"0", 0, false},
		{"banana", 0, false},
	} {
		got, err := parseRadiodFrequency(tt.in)
		if tt.ok && (err != nil || got != tt.want) {
			t.Errorf("parseRadiodFrequency(%q) = %d, %v; want %d, nil", tt.in, got, err, tt.want)
		}
		if !tt.ok && err == nil {
			t.Errorf("parseRadiodFrequency(%q) = %d, nil; want an error", tt.in, got)
		}
	}
}

// The cross-check reports disagreement; it must never be the thing that changes the
// geometry, because the span has already sized buffers and archives by this point.
func TestVerifyReceiverAgainstFrontend(t *testing.T) {
	rc := ReceiverConfig{
		InputSamprate: 64_800_000, SamprateSource: "radiod-conf",
		SpanHz: 30_000_000, CenterHz: 15_000_000,
		MinFrequency: 10_000, MaxFrequency: 30_000_000,
	}

	if issues := verifyReceiverAgainstFrontend(rc, nil); issues != nil {
		t.Errorf("nil status should be silent, got %v", issues)
	}

	agreeing := &FrontendStatus{
		InputSamprate: 64_800_000,
		FeLowEdge:     15_000,
		FeHighEdge:    30_456_000,
	}
	if issues := verifyReceiverAgainstFrontend(rc, agreeing); len(issues) != 0 {
		// Silent, despite the 10 kHz floor sitting below radiod's 15 kHz min_IF: that
		// gap is deliberate policy, and flagging it would warn on every healthy
		// receiver forever.
		t.Errorf("an agreeing front end must be silent, got %v", issues)
	}

	// A front end that genuinely cannot reach what we advertise is worth saying.
	narrow := &FrontendStatus{InputSamprate: 64_800_000, FeLowEdge: 15_000, FeHighEdge: 20_000_000}
	if issues := verifyReceiverAgainstFrontend(rc, narrow); len(issues) != 1 {
		t.Errorf("a front end narrower than the advertised range must be reported, got %v", issues)
	}

	disagreeing := &FrontendStatus{
		InputSamprate: 129_600_000,
		FeLowEdge:     15_000,
		FeHighEdge:    60_912_000,
	}
	issues := verifyReceiverAgainstFrontend(rc, disagreeing)
	if len(issues) == 0 {
		t.Fatal("a doubled sample rate must be reported")
	}
	// And the geometry it was handed is untouched.
	if rc.SpanHz != 30_000_000 {
		t.Errorf("verify mutated the geometry: span now %d", rc.SpanHz)
	}
}

// The two published wideband SNR figures must mean the same thing on any receiver.
//
// They are DB columns (snr_0_30_mhz, snr_1_8_30_mhz), Home Assistant sensors named
// "SNR 0-30 MHz" / "SNR 1.8-30 MHz", and KiwiSDR sa/sh stats. Letting them widen with
// the span would put a step change in every history on the day the sample rate was
// raised, with every label still saying 30.
func TestWidebandSNRIsPinnedToFixedBands(t *testing.T) {
	// A 30 MHz receiver: 4096 bins of 7324.21875 Hz.
	narrow := &BandFFT{BinWidth: 7324.21875, Data: make([]float32, 4096)}
	// A 60 MHz receiver at the same resolution: twice the bins, same Hz each.
	wide := &BandFFT{BinWidth: 7324.21875, Data: make([]float32, 8192)}

	// Same spectrum in the shared 0-30 MHz, and something very loud above it that must
	// not reach either figure.
	for i := range narrow.Data {
		narrow.Data[i] = float32(-100 + i%20)
		wide.Data[i] = narrow.Data[i]
	}
	for i := 4096; i < len(wide.Data); i++ {
		wide.Data[i] = 40 // a huge signal at 30-60 MHz
	}

	n030, n1830 := widebandSNRBands(narrow)
	w030, w1830 := widebandSNRBands(wide)

	if n030 != w030 {
		t.Errorf("snr_0_30 moved with the span: %v vs %v", n030, w030)
	}
	if n1830 != w1830 {
		t.Errorf("snr_1_8_30 moved with the span: %v vs %v", n1830, w1830)
	}
	if n030 < 0 || n1830 < 0 {
		t.Errorf("expected real figures, got %v / %v", n030, n1830)
	}
}

func TestWidebandSNRHandlesShortAndEmptyFFTs(t *testing.T) {
	for _, tt := range []struct {
		name string
		fft  *BandFFT
	}{
		{"nil", nil},
		{"no data", &BandFFT{BinWidth: 7324.21875}},
		{"no bin width", &BandFFT{Data: make([]float32, 4096)}},
	} {
		a, b := widebandSNRBands(tt.fft)
		if a != -1 || b != -1 {
			t.Errorf("%s: got %v/%v, want -1/-1", tt.name, a, b)
		}
	}

	// A receiver narrower than 30 MHz must still report something rather than slicing
	// past the end of the buffer.
	short := &BandFFT{BinWidth: 7324.21875, Data: make([]float32, 1024)} // ~7.5 MHz
	for i := range short.Data {
		short.Data[i] = float32(-100 + i%20)
	}
	if a, b := widebandSNRBands(short); a < 0 || b < 0 {
		t.Errorf("a narrow receiver should still report: got %v/%v", a, b)
	}
}

// The published object must survive a JSON round trip, and a Config that never went
// through LoadConfig must still produce today's limits — that is the exact case an older
// deployment or a test harness presents.
//
// This used to go through v2TuningRangeJSON, which inlined the same object into the v2
// shell as window.__UBERSDR__. That second publisher is gone (see constants.js: the
// bundled desktop and mobile apps strip the shell's Go template actions, so they never
// received it and silently fell back to 30 MHz). /api/description is now the only way
// these numbers leave the process, so the round trip is asserted against the builder the
// handler marshals.
func TestTuningRangeJSONEndToEnd(t *testing.T) {
	for _, tt := range []struct {
		name string
		cfg  *Config
		want map[string]float64
	}{
		{"zero config", &Config{}, map[string]float64{
			"min_frequency": 10000, "max_frequency": 30000000,
			"spectrum_span_hz": 30000000, "spectrum_center_hz": 15000000}},
		{"60 MHz receiver", func() *Config {
			c := &Config{}
			c.Receiver = ReceiverConfig{MinFrequency: 10000, MaxFrequency: 60000000,
				SpanHz: 60000000, CenterHz: 30000000}
			return c
		}(), map[string]float64{
			"min_frequency": 10000, "max_frequency": 60000000,
			"spectrum_span_hz": 60000000, "spectrum_center_hz": 30000000}},
	} {
		encoded, err := json.Marshal(tt.cfg.Receiver.TuningRange())
		if err != nil {
			t.Fatalf("%s: marshalling the tuning range failed: %v", tt.name, err)
		}
		raw := string(encoded)
		var got map[string]interface{}
		if err := json.Unmarshal([]byte(raw), &got); err != nil {
			t.Fatalf("%s: not valid JSON (%v): %s", tt.name, err, raw)
		}
		for k, want := range tt.want {
			num, ok := got[k].(float64)
			if !ok || num != want {
				t.Errorf("%s: %s = %v, want %v", tt.name, k, got[k], want)
			}
		}
		// Never an empty string: a consumer reading samprate_source should be told
		// "fallback", not left to guess what "" meant.
		if src, _ := got["samprate_source"].(string); src == "" {
			t.Errorf("%s: samprate_source is empty", tt.name)
		}
	}
}

// End-to-end through the real LoadConfig, not the helpers.
//
// RadiodConfPath does not exist in a test environment, so this exercises the fallback
// path — which is exactly the one that must reproduce today's behaviour byte for byte.
func TestLoadConfigDerivesTodaysSpectrumGeometry(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("admin:\n  name: test\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	if got := cfg.Receiver.Span(); got != 30_000_000 {
		t.Errorf("span: got %d, want 30000000", got)
	}
	if got := cfg.Receiver.Centre(); got != 15_000_000 {
		t.Errorf("centre: got %d, want 15000000", got)
	}
	if got := cfg.Receiver.MinFreq(); got != 10_000 {
		t.Errorf("min: got %d, want 10000", got)
	}
	if got := cfg.Receiver.MaxFreq(); got != 30_000_000 {
		t.Errorf("max: got %d, want 30000000", got)
	}
	if cfg.Receiver.SamprateSource != "fallback" {
		t.Errorf("source: got %q, want fallback", cfg.Receiver.SamprateSource)
	}

	// The derived spectrum defaults — the numbers every client sees.
	if cfg.Spectrum.Default.CenterFrequency != 15_000_000 {
		t.Errorf("spectrum centre: got %d, want 15000000", cfg.Spectrum.Default.CenterFrequency)
	}
	if cfg.Spectrum.Default.BinCount != 1024 {
		t.Errorf("bin count: got %d, want 1024", cfg.Spectrum.Default.BinCount)
	}
	if cfg.Spectrum.Default.BinBandwidth != 29296.875 {
		t.Errorf("bin bandwidth: got %v, want 29296.875", cfg.Spectrum.Default.BinBandwidth)
	}
	// The invariant the old code stated as a comment: binCount x binBandwidth == span.
	total := float64(cfg.Spectrum.Default.BinCount) * cfg.Spectrum.Default.BinBandwidth
	if total != float64(cfg.Receiver.Span()) {
		t.Errorf("binCount x binBandwidth = %v, want %d", total, cfg.Receiver.Span())
	}
}

// Every publisher of the receiver's range must send the same fields.
//
// There are four: /api/description and the instance reporter's periodic, test and
// startup payloads. (A fifth, the v2 shell's inlined window.__UBERSDR__, was removed —
// the bundled apps strip the shell's template actions and so never saw it.) They all go
// through
// ReceiverConfig.TuningRange() precisely so a field cannot end up present in one, stale in
// another and missing from the third — this test is what stops someone hand-rolling a
// sixth.
func TestTuningRangeIsOneShape(t *testing.T) {
	want := []string{
		"min_frequency", "max_frequency",
		"spectrum_span_hz", "spectrum_center_hz",
		"input_samprate", "samprate_source",
	}

	rc := ReceiverConfig{
		InputSamprate: 129_600_000, SamprateSource: "radiod-conf",
		SpanHz: 60_000_000, CenterHz: 30_000_000,
		MinFrequency: 10_000, MaxFrequency: 60_000_000,
	}
	tr := rc.TuningRange()
	if len(tr) != len(want) {
		t.Errorf("field count: got %d (%v), want %d", len(tr), tr, len(want))
	}
	for _, k := range want {
		if _, ok := tr[k]; !ok {
			t.Errorf("missing field %q", k)
		}
	}

	// And the instance reporter carries the identical map on all three payload paths.
	if got := (&InstanceReport{TuningRange: rc.TuningRange()}).TuningRange; len(got) != len(want) {
		t.Errorf("reporter field count: got %d, want %d", len(got), len(want))
	}
}

// A zero ReceiverConfig — a Config that never went through LoadConfig — must publish
// today's numbers, not a row of zeroes that a consumer would read as "no range".
func TestTuningRangeOfZeroConfigIsTodaysRange(t *testing.T) {
	tr := ReceiverConfig{}.TuningRange()
	for k, want := range map[string]uint64{
		"min_frequency": 10_000, "max_frequency": 30_000_000,
		"spectrum_span_hz": 30_000_000, "spectrum_center_hz": 15_000_000,
	} {
		if got, _ := tr[k].(uint64); got != want {
			t.Errorf("%s: got %v, want %d", k, tr[k], want)
		}
	}
	if got, _ := tr["input_samprate"].(int); got != 64_800_000 {
		t.Errorf("input_samprate: got %v, want 64800000", tr["input_samprate"])
	}
}

// The WebSDR emulation follows the receiver, unlike the KiwiSDR one.
//
// Its client builds the whole frequency axis from bandinfo[] — khzperpixel =
// samplerate/1024, plus centerfreq and maxzoom — so a wider band is all it needs. The
// Kiwi client computes 30 MHz / 2^zoom itself with no field to override, which is why
// only that one stays pinned.
func TestWebSDRBandFollowsTheReceiver(t *testing.T) {
	narrow := websdrBandFor(testReceiver(30_000_000))
	wide := websdrBandFor(testReceiver(60_000_000))

	// The band spans the receiver edge to edge, from DC, so that zoom 0 is exactly the
	// shared spectrum channel's view — see TestWebSDRZoomZeroSharesTheDefaultSpectrumChannel.
	if narrow.StartHz != 0 || narrow.EndHz != 30_000_000 {
		t.Errorf("narrow band: got %v-%v, want 0-30000000", narrow.StartHz, narrow.EndHz)
	}
	if narrow.WidthHz() != 30_000_000 {
		t.Errorf("narrow width: got %v, want 30000000", narrow.WidthHz())
	}
	if narrow.CentreHz() != 15_000_000 {
		t.Errorf("narrow centre: got %v, want 15000000", narrow.CentreHz())
	}
	if narrow.MaxZoom != websdrBaseMaxZoom {
		t.Errorf("narrow maxZoom: got %d, want %d", narrow.MaxZoom, websdrBaseMaxZoom)
	}
	if want := 1024 << uint(websdrBaseMaxZoom); narrow.MaxZoomPixels() != want {
		t.Errorf("narrow maxzoom grid: got %d, want %d", narrow.MaxZoomPixels(), want)
	}

	// A wider receiver gets a wider band...
	if wide.WidthHz() != 60_000_000 {
		t.Errorf("wide width: got %v, want 60000000", wide.WidthHz())
	}
	// ...and one more zoom level, so the deepest view stays about as narrow as it was.
	if wide.MaxZoom != websdrBaseMaxZoom+1 {
		t.Errorf("wide maxZoom: got %d, want %d", wide.MaxZoom, websdrBaseMaxZoom+1)
	}
	deepNarrow := narrow.WidthHz() / float64(int(1)<<uint(narrow.MaxZoom))
	deepWide := wide.WidthHz() / float64(int(1)<<uint(wide.MaxZoom))
	if ratio := deepWide / deepNarrow; ratio < 0.9 || ratio > 1.1 {
		t.Errorf("deepest zoom width moved: %v Hz vs %v Hz", deepWide, deepNarrow)
	}

	// The deepest zoom must land on a bandwidth radiod will actually serve, at the full
	// 1024-bin display width — no bin-count halving any more.
	for _, b := range []websdrBand{narrow, wide} {
		visible := b.WidthHz() / float64(int(1)<<uint(b.MaxZoom))
		display := visible / 1024
		served := radiodRoundUpBinBW(display)
		if served < radiodBinBandwidthLadder[0] {
			t.Errorf("deepest zoom asks for %v Hz/bin, below radiod's %v floor",
				served, radiodBinBandwidthLadder[0])
		}
		// Rounding up must never deliver less than the client draws.
		if served < display {
			t.Errorf("served %v Hz/bin is narrower than the display's %v", served, display)
		}
	}
}

// A zero ReceiverConfig must give the emulation today's band, since Config literals
// built outside LoadConfig reach it.
func TestWebSDRBandOfZeroConfig(t *testing.T) {
	b := websdrBandFor(ReceiverConfig{})
	if b.StartHz != 0 || b.EndHz != 30_000_000 || b.MaxZoom != websdrBaseMaxZoom {
		t.Errorf("got %v-%v maxZoom %d, want 0-30000000 maxZoom %d",
			b.StartHz, b.EndHz, b.MaxZoom, websdrBaseMaxZoom)
	}
}

// The tile count grows as 2^(maxZoom+1)-1 URLs in bandinfo.js, so the cap matters.
func TestWebSDRMaxZoomIsCapped(t *testing.T) {
	huge := websdrBandFor(testReceiver(30_000_000_000))
	if huge.MaxZoom > websdrMaxZoomCap {
		t.Errorf("maxZoom uncapped: %d", huge.MaxZoom)
	}
}

// The WebSDR waterfall's deep zooms used to halve their bin count to keep the bandwidth
// above a claimed 500 Hz "radiod minimum". That figure was a misreading — radiod serves
// 0.5 Hz per bin — but the halving was not simply wrong: above radiod's crossover it is
// the only thing bounding the wideband FFT, which setup_wideband sizes as samprate/rbw
// with no ceiling of its own.
//
// So the rule is now cost-based rather than floor-based, and this pins both halves of it.
func TestWebSDRSpectrumParamsPicksTheCheapRegime(t *testing.T) {
	const sr = 64_800_000
	const width = 1024
	geom := websdrBandFor(testReceiver(30_000_000))

	for zoom := 0; zoom <= geom.MaxZoom; zoom++ {
		visible := geom.WidthHz() / float64(int(1)<<uint(zoom))
		req := websdrSpectrumParams(visible, width, sr)

		// The delivered span must always cover what the client draws. Under-covering
		// would put every signal at the wrong frequency — the one failure to avoid.
		delivered := float64(req.BinCount) * req.BinBandwidth
		display := float64(req.DisplayBins) * req.DisplayBinBW
		if delivered < display-1 {
			t.Errorf("zoom %d: delivers %.0f Hz for a %.0f Hz view", zoom, delivered, display)
		}

		// And radiod's transform must stay affordable on whichever path it picks.
		var fftN float64
		if req.BinBandwidth > radiodSpectrumCrossoverHz {
			fftN = sr / req.BinBandwidth
			if fftN > websdrMaxWidebandFFT {
				t.Errorf("zoom %d: wideband fft_n %.0f exceeds the %d cap", zoom, fftN, websdrMaxWidebandFFT)
			}
		} else {
			// Narrowband: at least the display width -- a view too wide to reach
			// the crossover at 1024 bins reaches it at more (websdrNarrowbandBins)
			// -- and a bandwidth off the ladder.
			if req.BinCount < width {
				t.Errorf("zoom %d: narrowband below the display width, got %d bins", zoom, req.BinCount)
			}
			if req.BinCount > maxSpectrumBins {
				t.Errorf("zoom %d: %d bins is more than one datagram carries (%d)",
					zoom, req.BinCount, maxSpectrumBins)
			}
			found := false
			for _, l := range radiodBinBandwidthLadder {
				if l == req.BinBandwidth {
					found = true
				}
			}
			if !found {
				t.Errorf("zoom %d: %v is not on the ladder", zoom, req.BinBandwidth)
			}
		}
	}
}

// The shallow zooms must ask radiod for exactly what they always did. The point of the
// change was to reach deeper cheaply, not to make the existing levels more expensive.
//
// It stops at 4 because from 5 down the narrowband path is measurably cheaper and the
// zooms deliberately move onto it -- see TestWebSDRZoomsAboveTheCrossoverGoNarrowband.
// On this 64.8 Msps receiver zoom 5 is a 937.5 kHz view: 1.17M points/s to downconvert
// against 2.83M to transform the whole front end. Where that boundary falls depends on the
// sample rate, which is why the code compares the two rather than testing a threshold.
func TestWebSDRShallowZoomsCostRadiodNoMore(t *testing.T) {
	const sr = 64_800_000
	const width = 1024
	geom := websdrBandFor(testReceiver(30_000_000))

	for zoom := 0; zoom <= 4; zoom++ {
		visible := geom.WidthHz() / float64(int(1)<<uint(zoom))

		// What the old code did: halve the bin count until bin_bw reached 500 Hz.
		oldBins := width
		for oldBins > 1 && visible/float64(oldBins) < 500 {
			oldBins /= 2
		}
		oldBinBW := visible / float64(oldBins)

		req := websdrSpectrumParams(visible, width, sr)
		if req.BinCount != oldBins || math.Abs(req.BinBandwidth-oldBinBW) > 0.001 {
			t.Errorf("zoom %d changed: now %d bins @ %.1f Hz, was %d @ %.1f",
				zoom, req.BinCount, req.BinBandwidth, oldBins, oldBinBW)
		}
	}
}

// Zoom 8 is where the old floor bit hardest: 128 bins across 1024 pixels, on a 70k-point
// wideband FFT. The narrowband path serves the full width for a thousandth of the work.
func TestWebSDRDeepZoomIsSharperAndCheaper(t *testing.T) {
	const sr = 64_800_000
	const width = 1024
	geom := websdrBandFor(testReceiver(30_000_000))
	visible := geom.WidthHz() / 256 // zoom 8

	req := websdrSpectrumParams(visible, width, sr)
	// At least the display width, and no wider a span than the view -- the bin count
	// now follows the span rather than being pinned to 1024 with the bandwidth rounded
	// up, which used to ask for 204.8 kHz to draw a 117.2 kHz view.
	if req.BinCount < width {
		t.Errorf("zoom 8 bins: got %d, want at least the display width %d", req.BinCount, width)
	}
	if over := float64(req.BinCount)*req.BinBandwidth - visible; over > 2*req.BinBandwidth {
		t.Errorf("zoom 8 delivers %.0f Hz over a %.0f Hz view", over, visible)
	}
	if req.BinBandwidth > radiodSpectrumCrossoverHz {
		t.Errorf("zoom 8 should be on the cheap narrowband path, got %v Hz/bin", req.BinBandwidth)
	}
	newFFT := float64(req.BinCount) + 400/req.BinBandwidth
	oldFFT := sr / 915.2 // what the halved-bin-count wideband request cost
	if newFFT > oldFFT/10 {
		t.Errorf("zoom 8 fft_n %.0f is not materially cheaper than the old %.0f", newFFT, oldFFT)
	}
}

// The resample has to put the view back where the client's axis expects it. A round
// bandwidth wider than the display means radiod delivers a wider span, symmetric about
// the same centre, which is cropped back.
func TestWebSDRResampleCropsToTheDisplaySpan(t *testing.T) {
	const dstBins = 1024
	dstBinBW := 114.4                        // what a deep zoom wants
	srcBinBW := radiodRoundUpBinBW(dstBinBW) // 200 Hz off the ladder
	if srcBinBW <= dstBinBW {
		t.Fatalf("expected the ladder to round up, got %v for %v", srcBinBW, dstBinBW)
	}

	// A single loud bin at the centre of the delivered span must land at the centre of
	// the display, not drift.
	src := make([]float32, dstBins)
	for i := range src {
		src[i] = -120
	}
	src[len(src)/2] = 0

	out := resampleSpectrumOntoGrid(src, srcBinBW, dstBinBW, dstBins)
	if len(out) != dstBins {
		t.Fatalf("got %d bins, want %d", len(out), dstBins)
	}
	peak, at := float32(-999), -1
	for i, v := range out {
		if v > peak {
			peak, at = v, i
		}
	}
	if peak != 0 {
		t.Errorf("carrier lost: peak %v, want 0", peak)
	}
	if at < dstBins/2-2 || at > dstBins/2+2 {
		t.Errorf("carrier moved to bin %d, want ~%d", at, dstBins/2)
	}
}

// Whether a WebSDR or KiwiSDR viewer at full zoom-out lands on the *shared* spectrum
// channel, instead of opening a private radiod channel to be shown what everyone else is
// already receiving.
//
// isAtDefaultSpectrumParams demands exact equality on centre, bin bandwidth and bin count.
// Two of those are now fixed:
//
//   - the centre matches, because websdrBandFor starts the band at 0 rather than at the
//     10 kHz tuning floor. It used to put the centre at 15.005 MHz against the shared
//     channel's 15.000 — close enough to look right, different enough to refuse the match.
//   - the bandwidth follows from the span and the bin count.
//
// The bin count is the one that cannot be fixed here. Both emulations are pinned to 1024
// by their wire protocols (kiwiWaterfallBins is the Kiwi client's wf_fft_size; the WebSDR
// waterfall clamps width to 1024), while the shared channel uses the operator's
// spectrum.bin_count. They share only when those two coincide.
func TestEmulationSharesSpectrumOnlyWhenBinCountsCoincide(t *testing.T) {
	const emulationBins = 1024 // kiwiWaterfallBins, and the WebSDR width cap

	for _, span := range []uint64{30_000_000, 60_000_000} {
		rx := testReceiver(span)
		defBins := defaultSpectrumBinCount(span)
		defBinBW := float64(span) / float64(defBins)

		geom := websdrBandFor(rx)
		req := websdrSpectrumParams(geom.WidthHz(), emulationBins, rx.Samprate())

		// The centre must agree at every span — this is the part the band fix bought.
		if uint64(geom.CentreHz()) != rx.Centre() {
			t.Errorf("span %d: websdr centre %.0f != shared %d", span, geom.CentreHz(), rx.Centre())
		}
		if geom.StartHz != 0 || uint64(geom.EndHz) != span {
			t.Errorf("span %d: band is %.0f-%.0f, want 0-%d", span, geom.StartHz, geom.EndHz, span)
		}

		shares := req.BinCount == defBins && req.BinBandwidth == defBinBW
		wantShares := defBins == emulationBins
		if shares != wantShares {
			t.Errorf("span %d: shares=%v, want %v (default %d bins @ %v, emulation %d @ %v)",
				span, shares, wantShares, defBins, defBinBW, req.BinCount, req.BinBandwidth)
		}

		// Spell the consequence out rather than leaving it implicit: at 60 MHz the
		// default bin count doubles to hold Hz-per-bin steady, so it stops coinciding
		// with the emulations' fixed 1024 and they fall back to private channels.
		if span == 30_000_000 && !shares {
			t.Errorf("a 1024-bin receiver should share with the emulations")
		}
		if span == 60_000_000 && shares {
			t.Errorf("a 2048-bin receiver cannot share with a 1024-bin emulation")
		}
	}
}

// Widening the waterfall band to start at 0 must not let anyone tune below the
// receiver's floor — the two are deliberately different bounds.
func TestWebSDRBandStartIsNotATuningBound(t *testing.T) {
	rx := testReceiver(30_000_000)
	if websdrBandFor(rx).StartHz != 0 {
		t.Fatal("the waterfall band should start at DC")
	}
	if rx.MinFreq() != 10_000 {
		t.Errorf("tuning floor moved to %d; it must stay independent of the band", rx.MinFreq())
	}
}

// bandinfo.js, the scale tiles and the spectrum window must all describe the same band.
//
// The WebSDR client builds its entire axis from two numbers in bandinfo.js — centerfreq
// and samplerate (khzperpixel = samplerate/1024) — while the tick labels are
// server-rendered PNGs and the waterfall bins come from a spectrum channel, both sized
// from websdrBandFor. Take the centre from one band and the width from another and
// nothing errors: the dial still reads correctly, every tick and every bin just sits at
// the wrong frequency.
//
// That is exactly what happened when the band was moved to start at DC and bandinfo.js
// was left deriving its width from the old MinFreq..MaxFreq slice: tuned to 14074 kHz,
// the marker landed where the ticks said 14071.
//
// So this drives the real handler and parses what it emits. An earlier version of this
// test compared geom against itself and passed happily with the bug reintroduced.
func TestWebSDRBandInfoAxisMatchesServerGeometry(t *testing.T) {
	for _, span := range []uint64{30_000_000, 60_000_000} {
		h := &WebSDRHandler{
			sessions: &SessionManager{},
			config:   &Config{},
			chseq:    newWebSDRChseq(),
			chat:     &websdrChatStore{},
		}
		h.config.Receiver = testReceiver(span)

		rec := httptest.NewRecorder()
		h.handleBandInfoJS(rec, httptest.NewRequest(http.MethodGet, "/tmp/bandinfo.js", nil))
		body := rec.Body.String()

		grab := func(key string) float64 {
			m := regexp.MustCompile(key + `: ([0-9.]+)`).FindStringSubmatch(body)
			if m == nil {
				t.Fatalf("span %d: %s missing from bandinfo.js", span, key)
			}
			v, err := strconv.ParseFloat(m[1], 64)
			if err != nil {
				t.Fatalf("span %d: %s unparseable: %v", span, key, err)
			}
			return v
		}
		centreKHz, widthKHz := grab("centerfreq"), grab("samplerate")

		// The band the client therefore believes in must be the one the tiles and the
		// spectrum are drawn for.
		geom := websdrBandFor(h.config.Receiver)
		if lo := centreKHz - widthKHz/2; math.Abs(lo-geom.StartHz/1000.0) > 1e-9 {
			t.Errorf("span %d: client low edge %.3f kHz != server %.3f kHz",
				span, lo, geom.StartHz/1000.0)
		}
		if hi := centreKHz + widthKHz/2; math.Abs(hi-geom.EndHz/1000.0) > 1e-9 {
			t.Errorf("span %d: client high edge %.3f kHz != server %.3f kHz",
				span, hi, geom.EndHz/1000.0)
		}

		// And a tuned frequency must land on the same pixel in both descriptions.
		const tuneKHz = 14074.0
		pixel := (tuneKHz - (centreKHz - widthKHz/2)) / (widthKHz / 1024)
		serverKHz := geom.StartHz/1000.0 + pixel*(geom.WidthHz()/1000.0/1024)
		if math.Abs(serverKHz-tuneKHz) > 0.001 {
			t.Errorf("span %d: client draws %.1f kHz where the server labels %.3f kHz (off by %.1f Hz)",
				span, tuneKHz, serverKHz, (serverKHz-tuneKHz)*1000)
		}
	}
}

// The KiwiSDR emulation must present the same 30 MHz device no matter how wide the
// receiver actually is.
//
// This is the opposite decision from the WebSDR emulation, and it is safe for a
// structural reason worth stating: every number the Kiwi path uses — the advertised
// bands=, center_freq and bandwidth, the pan clamps, and kiwiSpectrumParams — derives
// from the single kiwiFullSpanHz constant. It reads config.Receiver nowhere. The WebSDR
// misalignment happened because that emulation had two sources of geometry which drifted
// apart; this one cannot, because it has one.
func TestKiwiGeometryIsIndependentOfReceiverSpan(t *testing.T) {
	if kiwiFullSpanHz != 30e6 {
		t.Fatalf("kiwiFullSpanHz is %v; the Kiwi client assumes 30 MHz / 2^zoom with no "+
			"protocol field to say otherwise", kiwiFullSpanHz)
	}

	// Whatever the receiver, zoom 0 asks for a 30 MHz window of 1024 bins.
	req := kiwiSpectrumParams(0, 129_600_000)
	if got := req.DisplayBinBW * float64(req.DisplayBins); got != 30e6 {
		t.Errorf("zoom 0 display span %v, want 30000000", got)
	}
	if req.DisplayBins != kiwiWaterfallBins {
		t.Errorf("zoom 0 bins %d, want %d", req.DisplayBins, kiwiWaterfallBins)
	}

	// And the window it asks for sits inside the receiver at either span, without the
	// server's centre clamp having to move it — the clamp would silently shift the
	// picture away from where the client's axis says it is.
	for _, span := range []uint64{30_000_000, 60_000_000} {
		rx := testReceiver(span)
		const kiwiCentre = 15_000_000.0
		half := req.DisplayBinBW * float64(req.DisplayBins) / 2

		lo := float64(rx.MinFreq())
		if half > lo {
			lo = half
		}
		hi := lo
		if float64(rx.MaxFreq()) > half && float64(rx.MaxFreq())-half > lo {
			hi = float64(rx.MaxFreq()) - half
		}
		if kiwiCentre < lo || kiwiCentre > hi {
			t.Errorf("span %d: Kiwi's 15 MHz centre would be clamped into [%.0f, %.0f]",
				span, lo, hi)
		}
	}
}

// Anything that creates a radiod channel at an operator-chosen frequency must be
// disabled when that frequency falls outside the receiver — and left in the config, so
// widening the front end again brings it back.
func TestPruneOutOfRangeChannels(t *testing.T) {
	build := func(span uint64) *Config {
		c := &Config{}
		c.Receiver = testReceiver(span)
		c.NoiseFloor.Bands = []NoiseFloorBand{
			{Name: "20m", Start: 14_000_000, End: 14_350_000, CenterFrequency: 14_175_000},
			{Name: "6m", Start: 50_000_000, End: 52_000_000, CenterFrequency: 51_000_000},
		}
		// Enabled, so the prune has something to act on — a disabled band is inert and
		// deliberately left alone. See TestDecoderBandsDisabledInPlaceOnlyWhenEnabled.
		c.Decoder.Bands = []DecoderBandConfig{
			{Name: "20m", Frequency: 14_074_000, Enabled: true},
			{Name: "6m", Frequency: 50_313_000, Enabled: true},
		}
		c.FrequencyReference.Enabled = true
		c.FrequencyReference.Frequency = 25_000_000
		return c
	}

	// 30 MHz: the 6 m entries go, the HF ones stay, the 25 MHz reference stays.
	narrow := build(30_000_000)
	pruneOutOfRangeChannels(narrow)
	if len(narrow.NoiseFloor.Bands) != 1 || narrow.NoiseFloor.Bands[0].Name != "20m" {
		t.Errorf("noise floor bands: got %+v, want just 20m", narrow.NoiseFloor.Bands)
	}
	// Switched off, not deleted — the entry has to survive to be switched on again if the
	// front end widens.
	if len(narrow.Decoder.Bands) != 2 {
		t.Errorf("decoder bands were deleted: got %+v", narrow.Decoder.Bands)
	}
	if enabled := narrow.Decoder.GetEnabledBands(); len(enabled) != 1 || enabled[0].Name != "20m" {
		t.Errorf("enabled decoder bands: got %+v, want just 20m", enabled)
	}
	if !narrow.FrequencyReference.Enabled {
		t.Error("a 25 MHz reference is reachable on a 30 MHz receiver")
	}

	// 60 MHz: everything is in range and nothing is touched.
	wide := build(60_000_000)
	pruneOutOfRangeChannels(wide)
	if len(wide.NoiseFloor.Bands) != 2 {
		t.Errorf("noise floor bands: got %d, want both", len(wide.NoiseFloor.Bands))
	}
	if enabled := wide.Decoder.GetEnabledBands(); len(enabled) != 2 {
		t.Errorf("enabled decoder bands: got %d, want both", len(enabled))
	}

	// A reference above the receiver is switched off rather than left to ask radiod for
	// a channel it cannot serve.
	ref := build(30_000_000)
	ref.FrequencyReference.Frequency = 50_000_000
	pruneOutOfRangeChannels(ref)
	if ref.FrequencyReference.Enabled {
		t.Error("a 50 MHz reference must be disabled on a 30 MHz receiver")
	}

	// A zero ReceiverConfig means today's range, so HF survives and 6 m does not.
	zero := &Config{}
	zero.NoiseFloor.Bands = build(30_000_000).NoiseFloor.Bands
	zero.Decoder.Bands = build(30_000_000).Decoder.Bands
	pruneOutOfRangeChannels(zero)
	if len(zero.NoiseFloor.Bands) != 1 {
		t.Errorf("zero config should behave as 10 kHz-30 MHz, got %d noise floor bands",
			len(zero.NoiseFloor.Bands))
	}
	if enabled := zero.Decoder.GetEnabledBands(); len(enabled) != 1 {
		t.Errorf("zero config should behave as 10 kHz-30 MHz, got %d enabled decoder bands",
			len(enabled))
	}
}

// The shipped band list carries 6m, which only a receiver at 129.6 Msps can reach. It has
// to disappear quietly on a narrower front end and come back by itself on a wider one,
// with no edit to config.yaml either way — that is the whole point of shipping it.
func TestSixMetreBandAppearsOnlyWhenReachable(t *testing.T) {
	sixM := NoiseFloorBand{
		Name: "6m", Start: 50_000_000, End: 50_500_000,
		CenterFrequency: 50_250_000, BinCount: 1000, BinBandwidth: 500,
		FT8Frequency: 50_313_000,
	}
	// The invariants the rest of the list keeps.
	if got := uint64(sixM.BinCount) * uint64(sixM.BinBandwidth); got != sixM.End-sixM.Start {
		t.Errorf("bin_count x bin_bandwidth = %d, want %d", got, sixM.End-sixM.Start)
	}
	if sixM.CenterFrequency != (sixM.Start+sixM.End)/2 {
		t.Errorf("centre %d is not the midpoint of %d-%d", sixM.CenterFrequency, sixM.Start, sixM.End)
	}
	if sixM.FT8Frequency < sixM.Start || sixM.FT8Frequency > sixM.End {
		t.Errorf("FT8 at %d is outside the band", sixM.FT8Frequency)
	}

	has := func(bands []NoiseFloorBand, name string) bool {
		for _, b := range bands {
			if b.Name == name {
				return true
			}
		}
		return false
	}

	// Same config, two receivers. Nothing about the config changes between them.
	for _, tt := range []struct {
		span uint64
		want bool
	}{
		{30_000_000, false},
		{60_000_000, true},
	} {
		c := &Config{}
		c.Receiver = testReceiver(tt.span)
		c.NoiseFloor.Bands = []NoiseFloorBand{
			{Name: "20m", Start: 14_000_000, End: 14_350_000, CenterFrequency: 14_175_000},
			sixM,
		}
		pruneOutOfRangeChannels(c)

		if got := has(c.NoiseFloor.Bands, "6m"); got != tt.want {
			t.Errorf("span %d: 6m present = %v, want %v", tt.span, got, tt.want)
		}
		if !has(c.NoiseFloor.Bands, "20m") {
			t.Errorf("span %d: 20m must survive either way", tt.span)
		}
	}
}

// The built-in defaults — used when config.yaml has no bands: section — must carry it too,
// and must still be self-consistent.
func TestBuiltInBandDefaultsIncludeSixMetres(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("admin:\n  name: test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	// LoadConfig prunes, and the test environment has no radiod config, so the receiver
	// falls back to 30 MHz — 6m must have been dropped.
	for _, b := range cfg.NoiseFloor.Bands {
		if b.Name == "6m" {
			t.Errorf("6m survived on a %.0f MHz receiver", float64(cfg.Receiver.Span())/1e6)
		}
		if b.CenterFrequency > cfg.Receiver.MaxFreq() {
			t.Errorf("band %s centre %d is past the receiver", b.Name, b.CenterFrequency)
		}
	}
	if len(cfg.NoiseFloor.Bands) == 0 {
		t.Error("every HF band was pruned; the defaults should survive a 30 MHz receiver")
	}
}

// The shipped bookmark list carries 6m digital entries that only a receiver at 129.6 Msps
// can reach. /api/bookmarks must not publish them on a narrower front end — a visitor
// offered a bookmark whose only outcome is a refused click is worse served than one who
// never sees it — while the admin tab, which reads bookmarks.yaml separately, still shows
// them flagged.
func TestBookmarksAPIDropsUnreachableEntries(t *testing.T) {
	bookmarks := []Bookmark{
		{Name: "FT8 20m", Frequency: 14_074_000, Mode: "usb"},
		{Name: "WSPR 6m", Frequency: 50_293_000, Mode: "usb"},
		{Name: "FT8 6m", Frequency: 50_313_000, Mode: "usb"},
		{Name: "VLF", Frequency: 5_000, Mode: "usb"},
	}

	for _, tt := range []struct {
		span uint64
		want []string
	}{
		{30_000_000, []string{"FT8 20m"}},
		{60_000_000, []string{"FT8 20m", "WSPR 6m", "FT8 6m"}},
	} {
		cfg := &Config{}
		cfg.Receiver = testReceiver(tt.span)
		cfg.Bookmarks = bookmarks

		rec := httptest.NewRecorder()
		handleBookmarks(rec, httptest.NewRequest(http.MethodGet, "/api/bookmarks?eibi=0", nil), cfg, nil)

		var got []Bookmark
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("span %d: %v (body %s)", tt.span, err, rec.Body.String())
		}
		// Compared as a set: the handler sorts by name, which is its business, not this
		// test's.
		names := make([]string, 0, len(got))
		for _, b := range got {
			names = append(names, b.Name)
		}
		sort.Strings(names)
		want := append([]string(nil), tt.want...)
		sort.Strings(want)
		if strings.Join(names, ",") != strings.Join(want, ",") {
			t.Errorf("span %d: got %v, want %v", tt.span, names, want)
		}
	}

	// The list itself is untouched — dropping happens on the way out, so the operator's
	// file and the admin tab still have everything.
	if len(bookmarks) != 4 {
		t.Errorf("the source list was mutated: %d entries left", len(bookmarks))
	}
}

// Decoder bands are switched off in place, and only when they were switched on.
//
// The shipped decoder.yaml carries every band this software knows about with
// enabled: false — 6m included, for a receiver at 129.6 Msps. A disabled band spawns no
// decoder, so pruning it would be both pointless and six warnings of noise per boot. An
// enabled one that has gone out of reach would spawn a decoder that can never hear
// anything, so that is disabled and reported.
func TestDecoderBandsDisabledInPlaceOnlyWhenEnabled(t *testing.T) {
	build := func() []DecoderBandConfig {
		return []DecoderBandConfig{
			{Name: "20m-ft8", Frequency: 14_074_000, Enabled: true},
			{Name: "6m-ft8", Frequency: 50_313_000, Enabled: false}, // shipped, off
			{Name: "6m-wspr", Frequency: 50_293_000, Enabled: true}, // operator switched on
		}
	}

	narrow := &Config{}
	narrow.Receiver = testReceiver(30_000_000)
	narrow.Decoder.Bands = build()
	pruneOutOfRangeChannels(narrow)

	// Nothing is removed — the entries have to survive to be switched on again later.
	if len(narrow.Decoder.Bands) != 3 {
		t.Fatalf("bands were deleted: %d left, want 3", len(narrow.Decoder.Bands))
	}
	byName := map[string]DecoderBandConfig{}
	for _, b := range narrow.Decoder.Bands {
		byName[b.Name] = b
	}
	if !byName["20m-ft8"].Enabled {
		t.Error("a reachable enabled band must stay enabled")
	}
	if byName["6m-ft8"].Enabled {
		t.Error("a shipped disabled band must stay disabled")
	}
	if byName["6m-wspr"].Enabled {
		t.Error("an enabled band out of reach must be switched off")
	}

	// On a receiver that reaches them, nothing is touched at all.
	wide := &Config{}
	wide.Receiver = testReceiver(60_000_000)
	wide.Decoder.Bands = build()
	pruneOutOfRangeChannels(wide)
	for _, b := range wide.Decoder.Bands {
		want := b.Name != "6m-ft8" // the only one that started disabled
		if b.Enabled != want {
			t.Errorf("%s: enabled=%v, want %v on a 60 MHz receiver", b.Name, b.Enabled, want)
		}
	}
}

// The admin API refuses to switch a band on outside the receiver, but saving one disabled
// is fine — that is how the shipped 6m entries get to sit there waiting.
func TestValidateDecoderBandRange(t *testing.T) {
	rx := testReceiver(30_000_000)

	if err := validateDecoderBandRange(map[string]interface{}{
		"frequency": float64(50_313_000), "enabled": false,
	}, rx); err != nil {
		t.Errorf("saving a 6m band disabled must be allowed: %v", err)
	}
	if err := validateDecoderBandRange(map[string]interface{}{
		"frequency": float64(50_313_000), "enabled": true,
	}, rx); err == nil {
		t.Error("enabling a 6m band on a 30 MHz receiver must be refused")
	}
	if err := validateDecoderBandRange(map[string]interface{}{
		"frequency": float64(14_074_000), "enabled": true,
	}, rx); err != nil {
		t.Errorf("enabling a reachable band must be allowed: %v", err)
	}
	// A 60 MHz receiver allows it.
	if err := validateDecoderBandRange(map[string]interface{}{
		"frequency": float64(50_313_000), "enabled": true,
	}, testReceiver(60_000_000)); err != nil {
		t.Errorf("enabling 6m on a 60 MHz receiver must be allowed: %v", err)
	}
	// A missing or unusable frequency is the caller's own validation to report.
	if err := validateDecoderBandRange(map[string]interface{}{"enabled": true}, rx); err != nil {
		t.Errorf("a missing frequency is not this check's business: %v", err)
	}
}

// The question this answers: can a 6m decoder start if 50 MHz is not available?
//
// pruneOutOfRangeChannels switches such bands off at startup, but that is one call in one
// startup sequence. GetEnabledBands is the single question every consumer asks — the
// decoder that spawns processes, the metrics API, the instance reporter — so the refusal
// lives there too and holds however the band came to be enabled.
func TestEnabledBandsNeverIncludeUnreachableOnes(t *testing.T) {
	dc := &DecoderConfig{
		Bands: []DecoderBandConfig{
			{Name: "20m-ft8", Frequency: 14_074_000, Enabled: true},
			{Name: "6m-ft8", Frequency: 50_313_000, Enabled: true}, // hand-edited into the file
			{Name: "6m-wspr", Frequency: 50_293_000, Enabled: false},
		},
	}

	// Before the receiver is known, nothing is filtered — a config loaded in isolation
	// behaves exactly as it always did.
	if got := len(dc.GetEnabledBands()); got != 2 {
		t.Errorf("with no range set: got %d enabled, want 2", got)
	}

	// A 30 MHz receiver: the 6m band is refused even though the file says enabled.
	dc.SetReceiverRange(10_000, 30_000_000)
	got := dc.GetEnabledBands()
	if len(got) != 1 || got[0].Name != "20m-ft8" {
		t.Errorf("on 30 MHz: got %+v, want just 20m-ft8", got)
	}
	// And the underlying record is untouched — this is a refusal to run it, not an edit.
	if !dc.Bands[1].Enabled {
		t.Error("GetEnabledBands must not mutate the config")
	}

	// A 60 MHz receiver runs it.
	dc.SetReceiverRange(10_000, 60_000_000)
	if got := len(dc.GetEnabledBands()); got != 2 {
		t.Errorf("on 60 MHz: got %d enabled, want 2", got)
	}
}

// The radiod config editor is a free-text box, so the sample rate it writes has to be
// checked before anything reaches disk. Two things are being defended: a value the RX888
// cannot cleanly synthesise, and the full rate on hardware that has not been modified for
// it — which destroys the receiver rather than merely performing badly.
func TestValidateRadiodSamprate(t *testing.T) {
	conf := func(rate string) []byte {
		return []byte("[global]\nhardware = rx888\nsamprate = 12000\n\n[rx888]\nsamprate = " + rate + "\n")
	}

	// The two supported rates, staying where they are.
	if err := validateRadiodSamprate(conf("64800000"), SamprateHalf, false); err != nil {
		t.Errorf("half rate must be accepted: %v", err)
	}
	if err := validateRadiodSamprate(conf("129600000"), SamprateFull, false); err != nil {
		t.Errorf("staying at the full rate must not re-ask for agreement: %v", err)
	}

	// Anything else is refused, however plausible.
	for _, bad := range []string{"130000000", "64000000", "12960000", "100000000", "0", "-1"} {
		if err := validateRadiodSamprate(conf(bad), SamprateHalf, false); err == nil {
			t.Errorf("samprate %s should have been refused", bad)
		}
	}

	// A config with no [rx888] samprate at all.
	if err := validateRadiodSamprate([]byte("[global]\nhardware = rx888\n"), SamprateHalf, false); err == nil {
		t.Error("a config with no front end samprate must be refused")
	}

	// Raising to the full rate needs the operator's agreement...
	err := validateRadiodSamprate(conf("129600000"), SamprateHalf, false)
	if err == nil {
		t.Fatal("raising to 129.6 MSPS without agreement must be refused")
	}
	if !strings.Contains(err.Error(), "overheat") || !strings.Contains(err.Error(), "permanently damaged") {
		t.Errorf("the refusal must say what actually happens, got: %v", err)
	}

	// ...and is allowed with it.
	if err := validateRadiodSamprate(conf("129600000"), SamprateHalf, true); err != nil {
		t.Errorf("with agreement the full rate must be accepted: %v", err)
	}

	// Dropping back down never needs agreement.
	if err := validateRadiodSamprate(conf("64800000"), SamprateFull, false); err != nil {
		t.Errorf("dropping to the half rate must always be allowed: %v", err)
	}

	// Inline comments and suffixes are the operator's normal habit, not an error.
	if err := validateRadiodSamprate(
		[]byte("[rx888]\nsamprate = 129600000  # full speed\n"), SamprateFull, false); err != nil {
		t.Errorf("an inline comment must not break parsing: %v", err)
	}
	if err := validateRadiodSamprate(
		[]byte("[rx888]\nsamprate = 129.6m\n"), SamprateFull, false); err != nil {
		t.Errorf("a suffixed frequency must parse: %v", err)
	}
}

// The admin editor validates the sample rate in the browser and the server validates it
// again. They must read the same file the same way, or an operator is refused for a value
// the server would have accepted, or worse, waved through one it would not.
func TestSamprateParserParity(t *testing.T) {
	for _, c := range []struct {
		conf string
		want int
	}{
		{"[rx888]\nsamprate = 64800000\n", 64800000},
		{"[rx888]\nsamprate = 129600000  # full speed\n", 129600000},
		{"[rx888]\nsamprate = 129.6m\n", 129600000},
		{"[global]\nsamprate = 12000\n[rx888]\nsamprate = 64800000\n", 64800000},
		{"[global]\nsamprate = 12000\n", 0},
		{"[rx888]\n#samprate = 129600000\n", 0},
		{"[rx888]\nsamprate = 64800000\nsamprate = 129600000\n", 129600000},
		{"[rx888]\ndevice = rx888\n", 0},
		{"[rx888]\nsamprate = 64800000\n[global]\nsamprate = 12000\n", 64800000},
	} {
		got, err := samprateFromRadiodConfBytes([]byte(c.conf))
		if c.want == 0 {
			if err == nil {
				t.Errorf("%q: got %d, want an error", c.conf, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%q: got %d (%v), want %d", c.conf, got, err, c.want)
		}
	}
}

// The shared default spectrum channel runs at full rate.
//
// It is what every client sees before touching the zoom, and one radiod spectrum_poll()
// serves all of them, so throttling it made the most-looked-at view visibly less smooth
// than the private channel a zoom moves you onto. Pinned because the constant is the only
// thing saying so and it has drifted from its own documentation before — the comments
// claimed a third while the code did a half.
func TestSharedSpectrumPollsAtFullRate(t *testing.T) {
	if sharedPollDivisor != 1 {
		t.Errorf("sharedPollDivisor is %d; the shared channel should poll every tick",
			sharedPollDivisor)
	}

	// The poll loop's own test: tick % divisor == 0. At 1 that is every tick.
	polled := 0
	for tick := 1; tick <= 10; tick++ {
		if tick%sharedPollDivisor == 0 {
			polled++
		}
	}
	if polled != 10 {
		t.Errorf("polled on %d of 10 ticks, want 10", polled)
	}
}

// The two zooms that used to be stuck on the wideband path, and are the whole point of
// ubersdr-radiod patches/0002-spectrum-bin-data-resize.patch: they need more bins than the
// display has, which radiod could not be asked for until that patch let a live channel's
// bin count grow.
//
// Before, both were capped wideband — 512 and 256 bins at 915.5 Hz, the same resolution
// for two different zoom levels, so zooming in stopped adding detail. Now each gets the
// span it draws at 200 Hz per bin, finer than its own display grid.
func TestWebSDRZoomsAboveTheCrossoverGoNarrowband(t *testing.T) {
	const sr = 64_800_000
	const width = 1024
	geom := websdrBandFor(testReceiver(30_000_000))

	tests := []struct {
		zoom     int
		wantBins int
	}{
		{zoom: 6, wantBins: 2344}, // 468.75 kHz / 200
		{zoom: 7, wantBins: 1172}, // 234.375 kHz / 200
	}
	for _, tc := range tests {
		visible := geom.WidthHz() / float64(int(1)<<uint(tc.zoom))
		req := websdrSpectrumParams(visible, width, sr)

		if req.BinBandwidth != radiodSpectrumCrossoverHz {
			t.Errorf("zoom %d: %v Hz/bin, want the crossover %v -- it is still on the wideband path",
				tc.zoom, req.BinBandwidth, radiodSpectrumCrossoverHz)
		}
		if req.BinCount != tc.wantBins {
			t.Errorf("zoom %d: %d bins, want %d", tc.zoom, req.BinCount, tc.wantBins)
		}
		// Sharper than the grid the client draws, not softer.
		if req.BinBandwidth > req.DisplayBinBW {
			t.Errorf("zoom %d: serving %v Hz/bin for a %v Hz display grid -- that is a softer picture",
				tc.zoom, req.BinBandwidth, req.DisplayBinBW)
		}
	}
}

// The narrowband geometry must sit just sharper than the display grid -- never softer,
// never wastefully finer -- and must fall back when it cannot be reached at all.
func TestWebSDRNarrowbandFor(t *testing.T) {
	tests := []struct {
		name      string
		visible   float64
		display   float64
		wantBinBW float64
		wantBins  int
		wantOK    bool
	}{
		{"z5 1.87 MHz", 1_875_000, 1831.0546875, 1000, 1876, true},
		{"z6 937 kHz", 937_500, 915.52734375, 500, 1876, true},
		{"z7 469 kHz", 468_750, 457.763671875, 200, 2344, true},
		{"z8 234 kHz", 234_375, 228.8818359375, 200, 1172, true},
		{"z9 117 kHz", 117_187.5, 114.44091796875, 100, 1172, true},
		{"z10 59 kHz", 58_593.75, 57.220458984375, 50, 1172, true},
		{"z11 29 kHz", 29_296.875, 28.6102294921875, 20, 1466, true},
	}
	for _, tc := range tests {
		binBW, bins, ok := radiodNarrowbandFor(tc.visible, tc.display)
		if ok != tc.wantOK {
			t.Errorf("%s: ok=%v, want %v", tc.name, ok, tc.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if binBW != tc.wantBinBW || bins != tc.wantBins {
			t.Errorf("%s: %d bins @ %v Hz, want %d @ %v", tc.name, bins, binBW, tc.wantBins, tc.wantBinBW)
		}
		// Never softer than the grid the client draws...
		if binBW > tc.display {
			t.Errorf("%s: %v Hz/bin is softer than the %v Hz display grid", tc.name, binBW, tc.display)
		}
		// ...and never more than one ladder step sharper than it needs to be, which
		// would be payload spent on detail the resample discards.
		if binBW*4 < tc.display {
			t.Errorf("%s: %v Hz/bin is needlessly fine for a %v Hz grid", tc.name, binBW, tc.display)
		}
		// The delivered span must cover the view, and barely.
		delivered := float64(bins) * binBW
		if delivered < tc.visible {
			t.Errorf("%s: delivers %.0f Hz for a %.0f Hz view", tc.name, delivered, tc.visible)
		}
		// Up to two bins of slack: one from covering the span, one from rounding
		// the count up to even for the unwrap.
		if delivered > tc.visible+2*binBW {
			t.Errorf("%s: delivers %.0f Hz for a %.0f Hz view -- the downconverter pays for the excess",
				tc.name, delivered, tc.visible)
		}
		if bins > maxSpectrumBins {
			t.Errorf("%s: %d bins is more than one datagram carries", tc.name, bins)
		}
		// Even, or the FFT half-swap unwrap leaves a bin unwritten.
		if bins%2 != 0 {
			t.Errorf("%s: %d bins is odd", tc.name, bins)
		}
	}
}

// The deepest zooms used to pin the bin count to the display width and round the bandwidth
// up, so they asked for up to twice the span they drew and the downconverter was paid for
// spectrum that was cropped off before it reached the client.
func TestWebSDRDeepZoomsDoNotOverdeliverSpan(t *testing.T) {
	const width = 1024
	geom := websdrBandFor(testReceiver(60_000_000))
	for zoom := 5; zoom <= geom.MaxZoom; zoom++ {
		visible := geom.WidthHz() / float64(int(1)<<uint(zoom))
		req := websdrSpectrumParams(visible, width, 129_600_000)
		if req.BinBandwidth > radiodSpectrumCrossoverHz && req.Crossover == 0 {
			continue // wideband
		}
		over := float64(req.BinCount)*req.BinBandwidth - visible
		if over > 2*req.BinBandwidth {
			t.Errorf("zoom %d: delivers %.0f Hz over a %.0f Hz view -- %.1f%% of the downconverter is cropped away",
				zoom, over, visible, 100*over/visible)
		}
	}
}

// Which radiod algorithm runs is our decision, sent as CROSSOVER, not a coincidence of
// where the bin bandwidth happened to land relative to radiod's 200 Hz default.
func TestWebSDRCrossoverMatchesTheChosenPath(t *testing.T) {
	const width = 1024
	for _, spanHz := range []uint64{30_000_000, 60_000_000} {
		geom := websdrBandFor(testReceiver(spanHz))
		sr := 64_800_000
		if spanHz > 30_000_000 {
			sr = 129_600_000
		}
		for zoom := 0; zoom <= geom.MaxZoom; zoom++ {
			visible := geom.WidthHz() / float64(int(1)<<uint(zoom))
			req := websdrSpectrumParams(visible, width, sr)
			// radiod: rbw > crossover is wideband, rbw <= crossover is narrowband.
			narrowband := req.BinBandwidth <= req.Crossover
			if req.Crossover == 0 && narrowband {
				t.Errorf("%d MHz zoom %d: crossover 0 must mean wideband", spanHz/1_000_000, zoom)
			}
			if req.Crossover != 0 && req.Crossover != req.BinBandwidth {
				t.Errorf("%d MHz zoom %d: crossover %v does not match bin bandwidth %v",
					spanHz/1_000_000, zoom, req.Crossover, req.BinBandwidth)
			}
			// And it may only be chosen where it actually costs radiod less.
			if narrowband {
				wide := radiodWidebandPointsPerSec(visible/float64(width), sr)
				got := radiodNarrowbandPointsPerSec(float64(req.BinCount) * req.BinBandwidth)
				if got >= wide {
					t.Errorf("%d MHz zoom %d: narrowband costs %.0f points/s against wideband's %.0f",
						spanHz/1_000_000, zoom, got, wide)
				}
			}
		}
	}
}

// Whatever regime is chosen, radiod has to be able to serve it: the narrowband FFT search
// must terminate, and the channel's usable width must cover the view. This is the check
// that would have caught asking for a bin count whose fft_n search runs to 65536.
func TestWebSDRNarrowbandRequestsAreServable(t *testing.T) {
	const width = 1024
	for _, spanHz := range []uint64{30_000_000, 60_000_000} {
		geom := websdrBandFor(testReceiver(spanHz))
		sr := 64_800_000
		if spanHz > 30_000_000 {
			sr = 129_600_000
		}
		for zoom := 0; zoom <= geom.MaxZoom; zoom++ {
			visible := geom.WidthHz() / float64(int(1)<<uint(zoom))
			req := websdrSpectrumParams(visible, width, sr)
			if req.BinBandwidth > radiodSpectrumCrossoverHz {
				continue // wideband: no search, no downconverter
			}

			fftLen, samprate := radiodNarrowbandFFT(req.BinBandwidth, req.BinCount)
			if fftLen == 0 {
				t.Errorf("%d MHz zoom %d: %d bins @ %v Hz -- radiod finds no valid FFT length",
					spanHz/1_000_000, zoom, req.BinCount, req.BinBandwidth)
				continue
			}
			// setup_narrowband reserves radiodFilterMarginHz for the filter skirts.
			usable := float64(samprate) - radiodFilterMarginHz
			if display := float64(req.DisplayBins) * req.DisplayBinBW; usable < display {
				t.Errorf("%d MHz zoom %d: usable width %.0f Hz < the %.0f Hz view; its edges sit in the filter skirt",
					spanHz/1_000_000, zoom, usable, display)
			}
		}
	}
}

// A wideband request that has had to halve its bin count is not the same picture as
// one that has not, and must never be preferred to a downconverter that can serve the
// full width.
//
// The two paths are compared on cost, and halving is how the wideband side buys cost
// reductions -- by delivering fewer, wider bins. Left to compete freely it wins ties
// while looking three or four times softer: at a 937 kHz view it costs what the
// downconverter costs and delivers 512 bins where the downconverter delivers 1,876.
// That is how this ladder came to serve three zoom levels at an identical 1831 Hz per
// bin, and it reappeared the moment the averaging budget moved.
func TestWebSDRHalvedWidebandNeverBeatsTheDownconverter(t *testing.T) {
	const width = 1024
	for _, spanHz := range []uint64{30_000_000, 60_000_000} {
		geom := websdrBandFor(testReceiver(spanHz))
		sr := 64_800_000
		if spanHz > 30_000_000 {
			sr = 129_600_000
		}
		for zoom := 0; zoom <= geom.MaxZoom; zoom++ {
			visible := geom.WidthHz() / float64(int(1)<<uint(zoom))
			req := websdrSpectrumParams(visible, width, sr)
			if req.Crossover != 0 || req.BinCount >= width {
				continue // downconverter, or wideband at the full display width
			}
			// A halved wideband result is only defensible when the downconverter
			// could not have served this view at all.
			if _, _, ok := radiodNarrowbandFor(visible, req.DisplayBinBW); ok {
				t.Errorf("%d MHz zoom %d: %d bins @ %.1f Hz (halved from %d) chosen over an "+
					"available downconverter -- same cost, softer picture",
					spanHz/1_000_000, zoom, req.BinCount, req.BinBandwidth, width)
			}
		}
	}
}

// No level on either ladder may cost more than the crossing does. The peak is where
// the two curves meet and it is a floor: a single average on the wideband side, a
// span-determined downconverter on the other.
func TestSpectrumLaddersHaveNoPeakAboveTheCrossing(t *testing.T) {
	const sr = 129_600_000
	rc := &RadiodController{}
	rc.SetFrontendSamprate(sr)
	// %CPU per unit of work, from the two measurements on the live receiver.
	const perWidebandPoint = 27.0 / 212337.0 // fft_n x avg
	const perNarrowbandHz = 4.5 / 468750.0   // Hz of delivered span
	const ceiling = 9.5                      // the 9% crossing, with a little slack

	cost := func(binCount int, binBW, crossover float64) float64 {
		avg := float64(rc.spectrumAveragesFor(binBW, crossover))
		if binBW <= crossover {
			return perNarrowbandHz * float64(binCount) * binBW
		}
		return perWidebandPoint * (float64(sr) / binBW) * avg
	}

	geom := websdrBandFor(testReceiver(60_000_000))
	for zoom := 0; zoom <= geom.MaxZoom; zoom++ {
		visible := geom.WidthHz() / float64(int(1)<<uint(zoom))
		r := websdrSpectrumParams(visible, 1024, sr)
		if c := cost(r.BinCount, r.BinBandwidth, r.Crossover); c > ceiling {
			t.Errorf("websdr zoom %d costs %.1f%%, above the %.1f%% crossing", zoom, c, ceiling)
		}
	}
	for zoom := 0; zoom <= kiwiMaxZoom; zoom++ {
		r := kiwiSpectrumParams(zoom, sr)
		if c := cost(r.BinCount, r.BinBandwidth, r.Crossover); c > ceiling {
			t.Errorf("kiwi zoom %d costs %.1f%%, above the %.1f%% crossing", zoom, c, ceiling)
		}
	}
}
