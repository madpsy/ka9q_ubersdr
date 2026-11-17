package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSNRParseRequestRejectsInvalidInput(t *testing.T) {
	presets := []snrPreset{{Name: "20m", LoHz: 14_000_000, HiHz: 14_350_000}}
	bad := []string{
		"",                         // nothing asked for
		"range=20m&lo=14000",       // both forms
		"range=17m",                // unknown preset
		"lo=14000",                 // hi missing
		"hi=14350",                 // lo missing
		"lo=14350&hi=14000",        // reversed
		"lo=14000&hi=14000",        // empty
		"lo=-1&hi=100",             // negative
		"lo=NaN&hi=100",            // NaN
		"lo=0&hi=Inf",              // infinite
		"lo=0&hi=1e300",            // overflow
		"lo=0&hi=2000000",          // above snrMaxKHz
		"lo=abc&hi=100",            // not a number
		"lo=0x10&hi=100",           // hex
		"lo= 14000&hi=14350",       // padded
		"lo=14000&hi=14350&avg=-1", // negative window
		"lo=14000&hi=14350&avg=61", // longer than the buffers keep
		"lo=14000&hi=14350&avg=1.5",
		"lo=14000&hi=14350&avg=",
		"range=20m&range=40m",       // repeated
		"lo_khz=14000&hi_khz=14350", // typo'd names
		"range=20m&average=5",
		"lo=14000.00000000001&hi=14350", // over-long value
	}
	for _, raw := range bad {
		q, err := url.ParseQuery(raw)
		if err != nil {
			t.Fatalf("ParseQuery(%q): %v", raw, err)
		}
		if _, _, _, _, err := snrParseRequest(q, presets); err == nil {
			t.Errorf("%q: accepted, want error", raw)
		}
	}
}

func TestSNRParseRequestAccepts(t *testing.T) {
	presets := []snrPreset{{Name: "20m", LoHz: 14_000_000, HiHz: 14_350_000}}
	cases := []struct {
		raw    string
		name   string
		lo, hi uint64
		avg    int
	}{
		{"range=20m", "20m", 14_000_000, 14_350_000, 0},
		{"range=20M&avg=60", "20m", 14_000_000, 14_350_000, 60},
		{"lo=14000&hi=14070.5&avg=5", "", 14_000_000, 14_070_500, 5},
		{"lo=0&hi=54000", "", 0, 54_000_000, 0},
	}
	for _, c := range cases {
		q, _ := url.ParseQuery(c.raw)
		name, lo, hi, avg, err := snrParseRequest(q, presets)
		if err != nil {
			t.Errorf("%q: %v", c.raw, err)
			continue
		}
		if name != c.name || lo != c.lo || hi != c.hi || avg != c.avg {
			t.Errorf("%q: got %q %d-%d avg %d", c.raw, name, lo, hi, avg)
		}
	}
}

func TestSNRResolveSource(t *testing.T) {
	bands := []snrSourceBand{
		{Name: "20m", StartHz: 14_000_000, EndHz: 14_350_000},
		{Name: "6m", StartHz: 50_000_000, EndHz: 54_000_000},
		{Name: "wide20", StartHz: 13_000_000, EndHz: 15_000_000},
	}
	cases := []struct {
		lo, hi, wbEnd uint64
		want          string
	}{
		{14_000_000, 14_350_000, 30_000_000, "20m"},      // whole band
		{14_070_000, 14_080_000, 30_000_000, "20m"},      // narrowest containing band wins
		{13_500_000, 14_100_000, 30_000_000, "wide20"},   // only the wider band contains it
		{5_900_000, 6_200_000, 30_000_000, "wideband"},   // broadcast band, no channel
		{50_100_000, 50_300_000, 61_440_000, "6m"},       // 6m enabled on a 60 MHz receiver
		{40_000_000, 45_000_000, 61_440_000, "wideband"}, // above 30 MHz, inside the span
		{40_000_000, 45_000_000, 30_720_000, ""},         // beyond a 30 MHz receiver
		{1_800_000, 30_000_000, 30_720_000, "wideband"},
	}
	for _, c := range cases {
		if got := snrResolveSource(c.lo, c.hi, bands, c.wbEnd); got != c.want {
			t.Errorf("%d-%d (span %d): got %q, want %q", c.lo, c.hi, c.wbEnd, got, c.want)
		}
	}
}

func TestSNRBinRange(t *testing.T) {
	// 20m channel: 1750 bins of 200 Hz from 14.000 MHz.
	start, end := snrBinRange(14_074_000, 14_077_000, 14_000_000, 14_350_000, 1750)
	if start != 370 || end != 385 {
		t.Errorf("FT8 slice: got %d-%d, want 370-385", start, end)
	}
	start, end = snrBinRange(14_000_000, 14_350_000, 14_000_000, 14_350_000, 1750)
	if start != 0 || end != 1750 {
		t.Errorf("whole band: got %d-%d", start, end)
	}
}

// snrTestBuffer builds a buffer whose sample i has every bin at level(i) dB, except
// the top 10% of bins, which sit 30 dB higher.
func snrTestBuffer(now time.Time, samples int, level func(i int) float32) *FFTBuffer {
	buf := NewFFTBuffer("20m", 14_000_000, 14_350_000, 200, 60*time.Second)
	for i := 0; i < samples; i++ {
		data := make([]float32, 1750)
		for j := range data {
			data[j] = level(i)
			if j >= 1575 {
				data[j] += 30
			}
		}
		buf.AddSample(now.Add(time.Duration(i-samples+1)*time.Second), data)
	}
	return buf
}

func TestSNRComputeStatsNewestAndAverage(t *testing.T) {
	now := time.Now()
	// Older samples at -100 dB, newest at -90 dB.
	buf := snrTestBuffer(now, 10, func(i int) float32 {
		if i == 9 {
			return -90
		}
		return -100
	})

	st, err := snrComputeStats(buf, 0, 1750, 0)
	if err != nil {
		t.Fatal(err)
	}
	if st.Samples != 1 || math.Abs(float64(st.P5DB+90)) > 0.01 || math.Abs(float64(st.SNRDB-30)) > 0.01 {
		t.Errorf("avg=0: samples %d p5 %.2f snr %.2f, want 1 / -90 / 30", st.Samples, st.P5DB, st.SNRDB)
	}

	// avg=1 takes the newest sample and the one a second before it.
	st, err = snrComputeStats(buf, 0, 1750, 1)
	if err != nil {
		t.Fatal(err)
	}
	wantP5 := 10 * math.Log10((math.Pow(10, -9)+math.Pow(10, -10))/2)
	if st.Samples != 2 || math.Abs(float64(st.P5DB)-wantP5) > 0.01 {
		t.Errorf("avg=1: samples %d p5 %.2f, want 2 / %.2f", st.Samples, st.P5DB, wantP5)
	}

	// A window longer than the buffer uses every sample.
	st, _ = snrComputeStats(buf, 0, 1750, 60)
	if st.Samples != 10 {
		t.Errorf("avg=60: samples %d, want 10", st.Samples)
	}
}

func snrTestMonitor(t *testing.T) *NoiseFloorMonitor {
	t.Helper()
	cfg := &Config{}
	cfg.Spectrum.BackgroundPollPeriodMs = 1000
	cfg.NoiseFloor.Bands = []NoiseFloorBand{
		{Name: "20m", Start: 14_000_000, End: 14_350_000, BinBandwidth: 200},
		{Name: "6m", Start: 50_000_000, End: 54_000_000, BinBandwidth: 200},
	}
	now := time.Now()
	wb := NewFFTBuffer("wideband", 0, 61_440_000, 7500, 60*time.Second)
	wbData := make([]float32, 8192)
	for j := range wbData {
		wbData[j] = -110
	}
	wb.AddSample(now, wbData)
	return &NoiseFloorMonitor{
		config:            cfg,
		fftBuffers:        map[string]*FFTBuffer{"20m": snrTestBuffer(now, 5, func(int) float32 { return -100 })},
		wideBandFFTBuffer: wb,
	}
}

func TestHandleSNR(t *testing.T) {
	nfm := snrTestMonitor(t)
	bans := &IPBanManager{entries: map[string]*bannedEntry{}, uaEntries: map[string]*bannedUAEntry{}}

	cases := []struct {
		query  string
		status int
		source string
	}{
		{"range=20m", http.StatusOK, "20m"},
		{"lo=14070&hi=14080&avg=3", http.StatusOK, "20m"},
		{"range=bc49m", http.StatusOK, "wideband"},
		{"lo=40000&hi=45000", http.StatusOK, "wideband"}, // above 30 MHz on a 60 MHz receiver
		{"lo=70000&hi=71000", http.StatusBadRequest, ""}, // beyond the span
		{"lo=14070&hi=14071", http.StatusBadRequest, ""}, // 5 bins: too narrow
		{"range=6m", http.StatusServiceUnavailable, ""},  // configured but no samples yet
		{"lo=1&hi=2&bogus=1", http.StatusBadRequest, ""},
	}
	for i, c := range cases {
		// A fresh limiter per case: this test is about validation, not rate.
		limiter := NewFFTRateLimiter()
		req := httptest.NewRequest(http.MethodGet, "/api/snr?"+c.query, nil)
		req.RemoteAddr = "192.0.2.1:1234"
		rec := httptest.NewRecorder()
		handleSNR(rec, req, nfm, bans, limiter)
		if rec.Code != c.status {
			t.Errorf("case %d %q: status %d, want %d (%s)", i, c.query, rec.Code, c.status, strings.TrimSpace(rec.Body.String()))
			continue
		}
		if c.status != http.StatusOK {
			continue
		}
		var st SNRStats
		if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if st.Source != c.source {
			t.Errorf("case %d %q: source %q, want %q", i, c.query, st.Source, c.source)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/snr?range=20m", nil)
	rec := httptest.NewRecorder()
	handleSNR(rec, req, nfm, bans, NewFFTRateLimiter())
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: status %d, want 405", rec.Code)
	}
}

func TestHandleSNRRateLimit(t *testing.T) {
	nfm := snrTestMonitor(t)
	bans := &IPBanManager{entries: map[string]*bannedEntry{}, uaEntries: map[string]*bannedUAEntry{}}
	limiter := NewFFTRateLimiter()
	limited := 0
	for i := 0; i < 6; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/snr?range=20m", nil)
		req.RemoteAddr = "192.0.2.2:1234"
		rec := httptest.NewRecorder()
		handleSNR(rec, req, nfm, bans, limiter)
		if rec.Code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited != 2 {
		t.Errorf("6 back-to-back requests: %d limited, want 2 (burst of 4)", limited)
	}
}
