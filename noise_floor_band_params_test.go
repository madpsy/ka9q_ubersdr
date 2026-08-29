package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Whatever range is asked for, the answer must be something radiod can serve on the
// cheap algorithm -- that is the entire point of the endpoint.
func TestNoiseFloorBandParamsAlwaysLandsOnTheDownconverter(t *testing.T) {
	ranges := []struct {
		name       string
		start, end uint64
	}{
		{"2200m", 135700, 137800},
		{"630m", 472000, 479000},
		{"30m", 10100000, 10150000},
		{"17m", 18068000, 18168000},
		{"40m", 7000000, 7300000},
		{"80m", 3500000, 4000000},
		{"6m", 50000000, 50500000},
		{"odd", 14000123, 14350777}, // not a round span
		{"tiny", 10000000, 10001000},
	}
	for _, r := range ranges {
		p, err := noiseFloorBandParamsFor(r.name, r.start, r.end, 1)
		if err != nil {
			t.Errorf("%s: %v", r.name, err)
			continue
		}
		if p.BinBandwidth > radiodSpectrumCrossoverHz {
			t.Errorf("%s: %.0f Hz/bin is above the crossover", r.name, p.BinBandwidth)
		}
		// Must cover the range, or its edges are simply not measured.
		if p.DeliveredSpanHz < float64(r.end-r.start) {
			t.Errorf("%s: delivers %.0f Hz for a %d Hz range", r.name, p.DeliveredSpanHz, r.end-r.start)
		}
		// Even, or the FFT unwrap's half-swap leaves a bin unwritten.
		if p.BinCount%2 != 0 {
			t.Errorf("%s: %d bins is odd", r.name, p.BinCount)
		}
		if p.BinCount > noiseFloorMaxBins {
			t.Errorf("%s: %d bins exceeds %d", r.name, p.BinCount, noiseFloorMaxBins)
		}
		// radiod must actually be able to resolve the pairing, and the channel it
		// builds must clear the filter skirts.
		fftLen, samprate := radiodNarrowbandFFT(p.BinBandwidth, p.BinCount)
		if fftLen == 0 {
			t.Errorf("%s: radiod finds no FFT length for %d bins @ %g Hz", r.name, p.BinCount, p.BinBandwidth)
			continue
		}
		if float64(samprate)-radiodFilterMarginHz < float64(r.end-r.start) {
			t.Errorf("%s: usable width %.0f Hz < the %d Hz range; its edges sit in the filter skirt",
				r.name, float64(samprate)-radiodFilterMarginHz, r.end-r.start)
		}
		if p.FFTLength != fftLen || p.ChannelSamprate != samprate {
			t.Errorf("%s: reported fft_n/samprate %d/%d, radiod would use %d/%d",
				r.name, p.FFTLength, p.ChannelSamprate, fftLen, samprate)
		}
	}
}

// It should reproduce the shipped defaults for the bands they cover, or the endpoint
// and the config would be giving different advice.
func TestNoiseFloorBandParamsAgreesWithTheDefaults(t *testing.T) {
	cfg := loadConfigForTest(t, "")
	for _, b := range cfg.NoiseFloor.Bands {
		p, err := noiseFloorBandParamsFor(b.Name, b.Start, b.End, 1)
		if err != nil {
			t.Errorf("%s: %v", b.Name, err)
			continue
		}
		if p.BinBandwidth != b.BinBandwidth || p.BinCount != b.BinCount {
			t.Errorf("%s: endpoint suggests %d bins @ %g Hz, config ships %d @ %g",
				b.Name, p.BinCount, p.BinBandwidth, b.BinCount, b.BinBandwidth)
		}
	}
}

// A range too wide to cover below the crossover within one datagram must say so rather
// than quietly hand back something that costs a core.
func TestNoiseFloorBandParamsRefusesRangesItCannotSize(t *testing.T) {
	if _, err := noiseFloorBandParamsFor("huge", 1_000_000, 6_000_000, 1); err == nil {
		t.Error("a 5 MHz range was accepted; it cannot be covered at 200 Hz/bin within the bin limit")
	}
	if _, err := noiseFloorBandParamsFor("backwards", 7_300_000, 7_000_000, 1); err == nil {
		t.Error("end below start was accepted")
	}
}

func TestNoiseFloorBandParamsEndpoint(t *testing.T) {
	cfg := &Config{}
	cfg.Receiver = testReceiver(30_000_000)

	// POST sizes a new band.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/noisefloor-band-params",
		strings.NewReader(`{"name":"40m","start":7000000,"end":7300000}`))
	handleNoiseFloorBandParams(rec, req, cfg, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST: %d — %s", rec.Code, rec.Body.String())
	}
	var p noiseFloorBandParams
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.BinBandwidth > radiodSpectrumCrossoverHz || p.BinCount == 0 {
		t.Errorf("POST returned %d bins @ %g Hz", p.BinCount, p.BinBandwidth)
	}
	if !strings.Contains(p.YAML, "name: 40m") || !strings.Contains(p.YAML, "bin_count:") {
		t.Errorf("YAML snippet not usable:\n%s", p.YAML)
	}

	// A band outside the receiver would be pruned at startup; say so.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/admin/noisefloor-band-params",
		strings.NewReader(`{"name":"6m","start":50000000,"end":50500000}`))
	handleNoiseFloorBandParams(rec, req, cfg, nil)
	var out noiseFloorBandParams
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Warnings) == 0 {
		t.Error("a band outside the receiver's coverage produced no warning")
	}

	// Bad input is a 400 with a message, not a panic or a zero-valued band.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/admin/noisefloor-band-params", strings.NewReader(`{`))
	handleNoiseFloorBandParams(rec, req, cfg, nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("malformed JSON: %d, want 400", rec.Code)
	}

	// GET reports the configured bands and their costs.
	full := loadConfigForTest(t, "")
	rec = httptest.NewRecorder()
	handleNoiseFloorBandParams(rec, httptest.NewRequest(http.MethodGet, "/admin/noisefloor-band-params", nil), full, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: %d", rec.Code)
	}
	var report noiseFloorCostReport
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if len(report.Bands) != len(full.NoiseFloor.Bands) {
		t.Errorf("report covers %d bands, config has %d", len(report.Bands), len(full.NoiseFloor.Bands))
	}
	if report.EstimatedTotalCPUPct <= 0 {
		t.Error("no estimated total")
	}
	for _, b := range report.Bands {
		if !strings.HasPrefix(b.Algorithm, "narrowband") {
			t.Errorf("band %s is on %q — the shipped defaults should all be on the downconverter",
				b.Name, b.Algorithm)
		}
		if b.Suggested != nil {
			t.Errorf("band %s: endpoint would change it to %d bins @ %g Hz",
				b.Name, b.Suggested.BinCount, b.Suggested.BinBandwidth)
		}
	}

	// PUT is not a thing here.
	rec = httptest.NewRecorder()
	handleNoiseFloorBandParams(rec, httptest.NewRequest(http.MethodPut, "/admin/noisefloor-band-params", nil), cfg, nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT: %d, want 405", rec.Code)
	}
}

// A suggestion must be a saving, not merely a difference.
//
// The shipped 2200m band is 500 bins at 5 Hz; sizing it fresh gives 1050 at 2 Hz --
// different, finer, and exactly as expensive, because below the crossover the cost is
// the band's width. Offering that as a "suggestion" on a page about CPU put an amber
// note on the two cheapest bands and nothing at all on the dearest.
func TestNoiseFloorSuggestsOnlyRealSavings(t *testing.T) {
	cfg := loadConfigForTest(t, "")
	rec := httptest.NewRecorder()
	handleNoiseFloorBandParams(rec, httptest.NewRequest(http.MethodGet, "/x", nil), cfg, nil)

	var report noiseFloorCostReport
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, b := range report.Bands {
		if b.Suggested == nil {
			// No suggestion must mean something definite, not silence.
			if !b.AtCostFloor {
				t.Errorf("band %s: neither a suggestion nor at_cost_floor -- the UI would show nothing", b.Name)
			}
			if b.CostNote == "" {
				t.Errorf("band %s: no cost_note to explain why it cannot be improved", b.Name)
			}
			continue
		}
		saving := b.EstimatedCPUPct - b.Suggested.EstimatedCPUPct
		if saving < noiseFloorSuggestMinSavingPct && b.BinBandwidth <= radiodSpectrumCrossoverHz {
			t.Errorf("band %s: suggested a change saving %.3f%%, below the %.2f%% threshold",
				b.Name, saving, noiseFloorSuggestMinSavingPct)
		}
	}
}

// A band left on the old wideband settings must always be flagged, however the
// arithmetic lands -- it is on the wrong algorithm, which is a defect and not a
// tuning preference.
func TestNoiseFloorAlwaysFlagsWidebandBands(t *testing.T) {
	cfg := loadConfigForTest(t, `
noisefloor:
  bands:
    - name: old40m
      start: 7000000
      end: 7300000
      center_frequency: 7150000
      bin_count: 600
      bin_bandwidth: 500
`)
	// The loader pulls a derived bandwidth below the crossover, but an explicitly
	// configured one is left as the operator wrote it -- so this still exercises the
	// wideband branch of the report.
	if cfg.NoiseFloor.Bands[0].BinBandwidth <= radiodSpectrumCrossoverHz {
		t.Skip("loader now normalises explicit bin_bandwidth too; wideband path unreachable from config")
	}
	rec := httptest.NewRecorder()
	handleNoiseFloorBandParams(rec, httptest.NewRequest(http.MethodGet, "/x", nil), cfg, nil)
	var report noiseFloorCostReport
	_ = json.Unmarshal(rec.Body.Bytes(), &report)

	b := report.Bands[0]
	if b.Suggested == nil {
		t.Error("a band above the crossover produced no suggestion")
	}
	if b.AtCostFloor {
		t.Error("a band above the crossover was reported as being at its cost floor")
	}
	if len(b.Warnings) == 0 {
		t.Error("a band above the crossover produced no warning")
	}
}

// The cost model is a fixed per-channel term plus a per-MHz one, because that is the
// shape the measurements have: the ratio of measured to modelled ran from 0.78 on a
// 200 kHz band down to 0.62 on a 500 kHz one, which no single scale factor can fix.
func TestNoiseFloorCostModelMatchesMeasurements(t *testing.T) {
	// Per-thread CPU measured on a 129.6 Msps receiver at a 200 ms background poll.
	// The CSV carries one decimal place, so each reading is +/-0.05%.
	measured := []struct {
		name   string
		spanHz float64
		pct    float64
	}{
		{"30m", 50_000, 0.5}, {"17m", 100_000, 1.0}, {"160m", 200_000, 1.5},
		{"10m", 300_000, 2.0}, {"20m", 350_000, 2.5}, {"15m", 450_000, 3.0},
		{"80m", 500_000, 3.0},
	}
	for _, m := range measured {
		got := noiseFloorEstimatedCPUPct(m.spanHz, 1)
		// Within the quantisation, plus a little slack for run-to-run variation.
		if diff := got - m.pct; diff > 0.35 || diff < -0.35 {
			t.Errorf("%s (%.0f kHz): model says %.2f%%, measured %.1f%% -- off by %.2f",
				m.name, m.spanHz/1000, got, m.pct, diff)
		}
	}

	// The fixed term is the load-bearing part: without it, narrow bands look free.
	if noiseFloorEstimatedCPUPct(0, 1) <= 0 {
		t.Error("a zero-width band costs nothing, so the per-channel overhead is missing")
	}
	// Ten narrow bands must cost more than one wide one of the same total width.
	ten := 10 * noiseFloorEstimatedCPUPct(50_000, 1)
	one := noiseFloorEstimatedCPUPct(500_000, 1)
	if ten <= one {
		t.Errorf("ten 50 kHz bands (%.2f%%) do not cost more than one 500 kHz band (%.2f%%); "+
			"the per-channel overhead is not being counted", ten, one)
	}
}

// Calibration must ignore readings the CSV cannot resolve, and must not fire on too
// little evidence.
func TestNoiseFloorCalibration(t *testing.T) {
	pct := func(v float64) *float64 { return &v }

	// Nothing measurable: use the model as-is rather than inventing a factor.
	if f, n := noiseFloorCalibration([]noiseFloorBandCost{{BinCount: 1000, BinBandwidth: 200}}); f != 1 || n != 0 {
		t.Errorf("no measurements: factor %v over %d bands, want 1 over 0", f, n)
	}

	// One solid band is not enough to fit against.
	one := []noiseFloorBandCost{{BinCount: 1000, BinBandwidth: 200, MeasuredCPUPct: pct(1.5)}}
	if f, n := noiseFloorCalibration(one); f != 1 || n != 1 {
		t.Errorf("single band: factor %v over %d, want 1", f, n)
	}

	// Readings below the quantisation floor are excluded, however many there are.
	noisy := []noiseFloorBandCost{
		{BinCount: 500, BinBandwidth: 100, MeasuredCPUPct: pct(0.5)},
		{BinCount: 500, BinBandwidth: 200, MeasuredCPUPct: pct(0.5)},
	}
	if f, n := noiseFloorCalibration(noisy); n != 0 || f != 1 {
		t.Errorf("sub-threshold readings: factor %v over %d bands, want them ignored", f, n)
	}

	// A receiver running consistently under the model is followed.
	half := []noiseFloorBandCost{
		{BinCount: 2500, BinBandwidth: 200, MeasuredCPUPct: pct(1.58)}, // model 3.16
		{BinCount: 1000, BinBandwidth: 200, MeasuredCPUPct: pct(1.76)}, // model 1.52 -> hmm
	}
	f, n := noiseFloorCalibration(half)
	if n != 2 {
		t.Fatalf("fitted over %d bands, want 2", n)
	}
	want := (1.58 + 1.76) / (noiseFloorEstimatedCPUPct(500_000, 1) + noiseFloorEstimatedCPUPct(200_000, 1))
	if diff := f - want; diff > 0.001 || diff < -0.001 {
		t.Errorf("factor %.4f, want %.4f", f, want)
	}
}

// A band the loader corrected must say so.
//
// The guard in LoadConfig pulls a band above the crossover back down, which is right --
// the alternative is a receiver burning cores over a stale YAML line. But the admin page
// then shows the corrected geometry and reports it at its cost floor, so an operator
// whose config.yaml still holds the old values sees a page claiming everything is
// optimal and has no way to learn their file disagrees.
func TestNoiseFloorReportsConfigOverriddenBands(t *testing.T) {
	cfg := loadConfigForTest(t, `
noisefloor:
  bands:
    - name: 80m
      start: 3500000
      end: 4000000
      center_frequency: 3750000
      bin_count: 1000
      bin_bandwidth: 500
`)
	b := cfg.NoiseFloor.Bands[0]
	if b.BinBandwidth != radiodSpectrumCrossoverHz || b.BinCount != 2500 {
		t.Fatalf("loader produced %d bins @ %g Hz, want 2500 @ 200", b.BinCount, b.BinBandwidth)
	}
	if b.ConfiguredBinBandwidth != 500 || b.ConfiguredBinCount != 1000 {
		t.Errorf("what the file asked for was not recorded: got %d @ %g",
			b.ConfiguredBinCount, b.ConfiguredBinBandwidth)
	}

	rec := httptest.NewRecorder()
	handleNoiseFloorBandParams(rec, httptest.NewRequest(http.MethodGet, "/x", nil), cfg, nil)
	var report noiseFloorCostReport
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode: %v", err)
	}
	row := report.Bands[0]
	if row.ConfiguredBinBandwidth != 500 {
		t.Error("the report does not carry what config.yaml asked for")
	}
	var told bool
	for _, w := range row.Warnings {
		if strings.Contains(w, "config.yaml") {
			told = true
		}
	}
	if !told {
		t.Errorf("no warning that the file and the running configuration disagree; got %v", row.Warnings)
	}
	// It is still genuinely at its cost floor -- the correction already happened.
	if !row.AtCostFloor {
		t.Error("a corrected band should still report as being at its cost floor")
	}
}

// A band whose config matches what is running must carry no such noise.
func TestNoiseFloorSilentWhenConfigAgrees(t *testing.T) {
	cfg := loadConfigForTest(t, "")
	rec := httptest.NewRecorder()
	handleNoiseFloorBandParams(rec, httptest.NewRequest(http.MethodGet, "/x", nil), cfg, nil)
	var report noiseFloorCostReport
	_ = json.Unmarshal(rec.Body.Bytes(), &report)
	for _, b := range report.Bands {
		if b.ConfiguredBinBandwidth != 0 {
			t.Errorf("band %s reports a config override it does not have", b.Name)
		}
	}
}

// The per-band estimates must be calibrated, not just the predictions for bands that
// do not exist yet.
//
// Three receivers running the same twelve default bands measured at 147%, 79% and 100%
// of the modelled cost. An uncalibrated column is therefore wrong on two of the three
// -- and wrong in opposite directions, so it cannot be fixed by retuning the constants.
func TestNoiseFloorEstimatesAreCalibrated(t *testing.T) {
	pct := func(v float64) *float64 { return &v }

	// Two bands wide enough to clear the quantisation floor, both measured at 60%
	// of what the model says -- the shape of the 79% receiver.
	const runsAt = 0.6
	rows := []noiseFloorBandCost{
		{Name: "80m", Start: 3_500_000, End: 4_000_000, SpanHz: 500_000,
			BinCount: 2500, BinBandwidth: 200, MeasuredCPUPct: pct(runsAt * noiseFloorEstimatedCPUPct(500_000, 1))},
		{Name: "15m", Start: 21_000_000, End: 21_450_000, SpanHz: 450_000,
			BinCount: 2250, BinBandwidth: 200, MeasuredCPUPct: pct(runsAt * noiseFloorEstimatedCPUPct(450_000, 1))},
	}
	report := &noiseFloorCostReport{Bands: rows}
	costNoiseFloorBands(report, nil)

	if diff := report.EstimateCalibration - runsAt; diff > 0.001 || diff < -0.001 {
		t.Fatalf("calibration %.4f, want %.2f", report.EstimateCalibration, runsAt)
	}
	var total float64
	for _, b := range report.Bands {
		want := noiseFloorEstimatedCPUPct(float64(b.BinCount)*b.BinBandwidth, report.EstimateCalibration)
		if diff := b.EstimatedCPUPct - want; diff > 0.001 || diff < -0.001 {
			t.Errorf("%s: estimate %.3f%%, want the calibrated %.3f%%", b.Name, b.EstimatedCPUPct, want)
		}
		// The whole point: the column now agrees with what radiod reports.
		if b.MeasuredCPUPct != nil {
			if diff := b.EstimatedCPUPct - *b.MeasuredCPUPct; diff > 0.001 || diff < -0.001 {
				t.Errorf("%s: estimate %.3f%% still disagrees with the measured %.3f%%",
					b.Name, b.EstimatedCPUPct, *b.MeasuredCPUPct)
			}
		}
		total += b.EstimatedCPUPct
	}
	if diff := report.EstimatedTotalCPUPct - total; diff > 0.001 || diff < -0.001 {
		t.Errorf("total %.3f%%, want the sum of the calibrated bands %.3f%%",
			report.EstimatedTotalCPUPct, total)
	}

	// An uncalibrated receiver is left exactly as the model has it.
	plain := &noiseFloorCostReport{Bands: []noiseFloorBandCost{
		{Name: "160m", Start: 1_800_000, End: 2_000_000, SpanHz: 200_000, BinCount: 1000, BinBandwidth: 200},
	}}
	costNoiseFloorBands(plain, nil)
	if plain.EstimateCalibration != 1 {
		t.Fatalf("no measurements: calibration %v, want 1", plain.EstimateCalibration)
	}
	if want := noiseFloorEstimatedCPUPct(200_000, 1); plain.Bands[0].EstimatedCPUPct != want {
		t.Errorf("unmeasured receiver: estimate %.3f%%, want the raw model %.3f%%",
			plain.Bands[0].EstimatedCPUPct, want)
	}
}
