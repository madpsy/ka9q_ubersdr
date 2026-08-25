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

// The shell must emit valid JSON, and a Config that never went through LoadConfig must
// still produce today's limits — that is the exact case an older deployment or a test
// harness presents.
func TestV2TuningRangeJSONEndToEnd(t *testing.T) {
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
		raw := string(v2TuningRangeJSON(tt.cfg))
		if strings.Contains(raw, "<") || strings.Contains(raw, "&") {
			t.Errorf("%s: output would need escaping in a <script>: %s", tt.name, raw)
		}
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
// There are five: /api/description, the v2 shell's inlined window.__UBERSDR__, and the
// instance reporter's periodic, test and startup payloads. They all go through
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

	// The v2 shell must serialise exactly the same object.
	cfg := &Config{}
	cfg.Receiver = rc
	var shell map[string]interface{}
	if err := json.Unmarshal([]byte(v2TuningRangeJSON(cfg)), &shell); err != nil {
		t.Fatalf("shell JSON: %v", err)
	}
	for _, k := range want {
		if _, ok := shell[k]; !ok {
			t.Errorf("shell is missing %q", k)
		}
	}
	if len(shell) != len(want) {
		t.Errorf("shell field count: got %d (%v), want %d", len(shell), shell, len(want))
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
			// Narrowband: full display width, and a bandwidth off the ladder.
			if req.BinCount != width {
				t.Errorf("zoom %d: narrowband should keep the full width, got %d bins", zoom, req.BinCount)
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

// Zooms 0-7 must ask radiod for exactly what they always did. The point of the change was
// to reach deeper cheaply, not to make the existing levels more expensive — and the two
// zooms just above the crossover are where that could silently have gone wrong.
func TestWebSDRShallowZoomsCostRadiodNoMore(t *testing.T) {
	const sr = 64_800_000
	const width = 1024
	geom := websdrBandFor(testReceiver(30_000_000))

	for zoom := 0; zoom <= 7; zoom++ {
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
	if req.BinCount != width {
		t.Errorf("zoom 8 bins: got %d, want the full %d", req.BinCount, width)
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
	req := kiwiSpectrumParams(0)
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
		c.Decoder.Bands = []DecoderBandConfig{
			{Name: "20m", Frequency: 14_074_000},
			{Name: "6m", Frequency: 50_313_000},
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
	if len(narrow.Decoder.Bands) != 1 || narrow.Decoder.Bands[0].Name != "20m" {
		t.Errorf("decoder bands: got %+v, want just 20m", narrow.Decoder.Bands)
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
	if len(wide.Decoder.Bands) != 2 {
		t.Errorf("decoder bands: got %d, want both", len(wide.Decoder.Bands))
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
	if len(zero.NoiseFloor.Bands) != 1 || len(zero.Decoder.Bands) != 1 {
		t.Errorf("zero config should behave as 10 kHz-30 MHz, got %d/%d bands",
			len(zero.NoiseFloor.Bands), len(zero.Decoder.Bands))
	}
}
