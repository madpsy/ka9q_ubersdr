package main

import (
	"encoding/json"
	"math"
	"math/rand"
	"strings"
	"testing"
	"time"
)

// newSpectrogramDataServer builds an MCP server with an archived day whose
// contents are known exactly:
//
//   - wideband: 300 bins of 100 kHz over 0-30 MHz, noise -110..-108 dBFS
//   - a steady carrier at 7050 kHz (bin 70), -60 dBFS all day
//   - a signal across 14.0-14.6 MHz (bins 140-145), -80 dBFS from 08:00 to 15:59
//   - a broadband burst, +15 dB on every bin, at 07:14-07:15
//   - no data at 10:00-10:04
//   - a '20m' recording, 35 bins of 10 kHz over 14.000-14.350 MHz, with the
//     same 08:00-15:59 signal at 14300 kHz (bin 30)
func newSpectrogramDataServer(t *testing.T) (*MCPServer, string) {
	t.Helper()
	day := time.Now().UTC().AddDate(0, 0, -3)
	midnight := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	date := midnight.Format("2006-01-02")
	open := func(m int) bool { return m >= 8*60 && m < 16*60 }
	gap := func(m int) bool { return m >= 10*60 && m < 10*60+5 }

	wbDir := t.TempDir()
	writeTestDay(t, wbDir, date, midnight, spectrogramMaxRows, 300, func(m, b int) float32 {
		if gap(m) {
			return noDataSentinel
		}
		v := float32(-110 + b%3)
		switch {
		case b == 70:
			v = -60
		case b >= 140 && b <= 145 && open(m):
			v = -80
		}
		if m == 7*60+14 || m == 7*60+15 {
			v += 15
		}
		return v
	})
	bandDir := t.TempDir()
	writeTestDay(t, bandDir, date, midnight, spectrogramMaxRows, 35, func(m, b int) float32 {
		if gap(m) {
			return noDataSentinel
		}
		if b == 30 && open(m) {
			return -80
		}
		return float32(-110 + b%3)
	})

	m := newTestMCPServer(t, nil, nil, nil)
	m.Spectrogram = newSpectrogramRecorderForBand(nil, SpectrogramConfig{DataDir: wbDir},
		"wideband", 0, 30_000_000, 300, func() *BandFFT { return nil })
	m.BandSpectrograms = map[string]*SpectrogramRecorder{
		"20m": newSpectrogramRecorderForBand(nil, SpectrogramConfig{DataDir: bandDir},
			"20m", 14_000_000, 14_350_000, 35, func() *BandFFT { return nil }),
	}
	return m, date
}

// spectrogramData calls the tool from a fresh IP each time so the rate limit
// never interferes, and decodes a successful result.
var sgdTestIP = 0

func spectrogramData(t *testing.T, m *MCPServer, args map[string]interface{}) map[string]interface{} {
	t.Helper()
	sgdTestIP++
	res := callTool(t, m, "get_spectrogram_data", "10.9.0."+itoa(sgdTestIP%250+1), args)
	text := resultText(t, res)
	if res.IsError {
		t.Fatalf("args %v: %s", args, text)
	}
	var out map[string]interface{}
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("decode: %v\n%s", err, text)
	}
	return out
}

func spectrogramDataError(t *testing.T, m *MCPServer, args map[string]interface{}, want string) {
	t.Helper()
	sgdTestIP++
	wantToolError(t, callTool(t, m, "get_spectrogram_data", "10.9.1."+itoa(sgdTestIP%250+1), args), want)
}

func TestSpectrogramDataTimeslice(t *testing.T) {
	m, date := newSpectrogramDataServer(t)
	out := spectrogramData(t, m, map[string]interface{}{
		"view": "timeslice", "date": date, "freqs_khz": "7050, 14300", "step_minutes": 60,
	})
	axis := out["time_axis"].(map[string]interface{})
	if axis["steps"].(float64) != 24 || axis["start_utc"] != date+"T00:00:00Z" {
		t.Fatalf("time axis %v, want 24 hourly steps from midnight", axis)
	}
	series := out["series"].([]interface{})
	carrier := series[0].(map[string]interface{})
	if carrier["source_band"] != "wideband" {
		t.Errorf("7050 kHz read from %v, want wideband (no band covers it)", carrier["source_band"])
	}
	cs := carrier["summary"].(map[string]interface{})
	if cs["minutes_with_data"].(float64) != 1435 || cs["minutes_above_min_snr"].(float64) != 1435 {
		t.Errorf("carrier summary %v: want 1435 minutes, all above the threshold", cs)
	}
	if db := carrier["db"].([]interface{}); db[3].(float64) != -60 {
		t.Errorf("carrier at 03:00 = %v dBFS, want -60", db[3])
	}

	// 14300 kHz is inside the 20m recording, which auto picks for its finer bins.
	sig := series[1].(map[string]interface{})
	if sig["source_band"] != "20m" || sig["bin_hz"].(float64) != 10000 {
		t.Errorf("14300 kHz read from %v at %v Hz, want 20m at 10000", sig["source_band"], sig["bin_hz"])
	}
	ss := sig["summary"].(map[string]interface{})
	if ss["first_above_utc"] != date+"T08:00:00Z" || ss["last_above_utc"] != date+"T15:59:00Z" {
		t.Errorf("signal seen %v to %v, want 08:00 to 15:59", ss["first_above_utc"], ss["last_above_utc"])
	}
	snr := sig["snr_db"].([]interface{})
	// writeTestDay logs a -100 dBFS floor for every minute, as the recorder
	// logs its own measured floor, and SNR is taken against that.
	if snr[4].(float64) > 0 || snr[12].(float64) < 5 {
		t.Errorf("SNR at 04:00 %v, at 12:00 %v: want the band shut then open", snr[4], snr[12])
	}

	// The default step fits a whole day into at most 144 points.
	out = spectrogramData(t, m, map[string]interface{}{"view": "timeslice", "date": date, "freqs_khz": []interface{}{7050.0}})
	if s := out["time_axis"].(map[string]interface{})["step_minutes"].(float64); s != 10 {
		t.Errorf("default step %v minutes, want 10", s)
	}
}

func TestSpectrogramDataSpectrum(t *testing.T) {
	m, date := newSpectrogramDataServer(t)
	out := spectrogramData(t, m, map[string]interface{}{
		"view": "spectrum", "date": date, "at": "12:00", "minutes": 5, "points": 300,
	})
	if out["at_utc"] != date+"T12:00:00Z" || out["minutes_combined"].(float64) != 5 {
		t.Errorf("at %v over %v minutes, want 12:00 over 5", out["at_utc"], out["minutes_combined"])
	}
	if out["noise_floor_db"].(float64) != -110 {
		t.Errorf("noise floor %v, want -110", out["noise_floor_db"])
	}
	peaks := out["peaks"].([]interface{})
	if len(peaks) < 2 {
		t.Fatalf("peaks %v: want the carrier and the 14 MHz signal", peaks)
	}
	top := peaks[0].(map[string]interface{})
	if top["freq_khz"].(float64) != 7050 || top["snr_db"].(float64) != 50 {
		t.Errorf("strongest peak %v, want 7050 kHz at 50 dB SNR", top)
	}
	if f := peaks[1].(map[string]interface{})["freq_khz"].(float64); f < 14000 || f > 14600 {
		t.Errorf("second peak at %v kHz, want 14000-14600", f)
	}
	if db := out["db"].([]interface{}); len(db) != 300 || db[70].(float64) != -60 {
		t.Errorf("%d points, point 70 = %v; want 300 points with the carrier at 70", len(db), db[70])
	}

	// A crop narrows the points; fewer points than bins keep the strongest.
	out = spectrogramData(t, m, map[string]interface{}{
		"view": "spectrum", "date": date, "at": "12:00", "freq_min_khz": 7000, "freq_max_khz": 8000, "points": 8,
	})
	if db := out["db"].([]interface{}); len(db) != 8 || db[0].(float64) != -60 {
		t.Errorf("8 points over 7-8 MHz: %v, want the carrier held in the first", db)
	}

	// Inside the 10:00 gap there is no spectrum.
	spectrogramDataError(t, m, map[string]interface{}{"view": "spectrum", "date": date, "at": "10:03"}, "no spectrum recorded")
}

func TestSpectrogramDataGrid(t *testing.T) {
	m, date := newSpectrogramDataServer(t)
	out := spectrogramData(t, m, map[string]interface{}{
		"view": "grid", "date": date, "freq_bins": 30, "stat": "max",
	})
	if out["step_minutes"].(float64) != 60 {
		t.Errorf("default grid step %v, want 60 for a day", out["step_minutes"])
	}
	rows := out["rows"].([]interface{})
	if len(rows) != 24 {
		t.Fatalf("%d rows, want 24", len(rows))
	}
	cols := out["columns"].(map[string]interface{})
	if cols["count"].(float64) != 30 || cols["width_khz"].(float64) != 1000 {
		t.Errorf("columns %v, want 30 strips of 1000 kHz", cols)
	}
	at := func(hour, col int) float64 {
		return rows[hour].(map[string]interface{})["db"].([]interface{})[col].(float64)
	}
	if at(3, 7) != -60 || at(3, 14) != -108 || at(12, 14) != -80 {
		t.Errorf("7 MHz at 03:00 %v, 14 MHz at 03:00 %v and 12:00 %v; want -60, -108, -80", at(3, 7), at(3, 14), at(12, 14))
	}
	if r := rows[10].(map[string]interface{}); r["minutes_with_data"].(float64) != 55 {
		t.Errorf("10:00 has %v minutes, want 55 (5 missing)", r["minutes_with_data"])
	}

	spectrogramDataError(t, m, map[string]interface{}{"view": "grid", "date": date, "step_minutes": 1, "freq_bins": 512}, "at most 2400")
}

func TestSpectrogramDataEvents(t *testing.T) {
	m, date := newSpectrogramDataServer(t)
	out := spectrogramData(t, m, map[string]interface{}{"view": "events", "date": date})

	gaps := out["gaps"].([]interface{})
	if len(gaps) != 1 {
		t.Fatalf("gaps %v, want one", gaps)
	}
	if g := gaps[0].(map[string]interface{}); g["from_utc"] != date+"T10:00:00Z" || g["minutes"].(float64) != 5 {
		t.Errorf("gap %v, want 5 minutes from 10:00", g)
	}

	bursts := out["bursts"].([]interface{})
	if len(bursts) != 1 {
		t.Fatalf("bursts %v, want one", bursts)
	}
	b := bursts[0].(map[string]interface{})
	if b["from_utc"] != date+"T07:14:00Z" || b["minutes"].(float64) != 2 || b["broadband_pct"].(float64) < 95 {
		t.Errorf("burst %v, want 2 broadband minutes from 07:14", b)
	}
	if e := b["peak_excess_db"].(float64); math.Abs(e-15) > 1.5 {
		t.Errorf("burst excess %v dB, want about 15", e)
	}

	carriers := out["carriers"].([]interface{})
	if len(carriers) != 1 || carriers[0].(map[string]interface{})["freq_khz"].(float64) != 7050 {
		t.Errorf("carriers %v, want only 7050 kHz", carriers)
	}
	signals := out["signals"].([]interface{})
	if len(signals) != 1 {
		t.Fatalf("signals %v, want the 14 MHz one", signals)
	}
	s := signals[0].(map[string]interface{})
	if s["first_seen_utc"] != date+"T08:00:00Z" || s["last_seen_utc"] != date+"T15:59:00Z" || s["width_khz"].(float64) != 600 {
		t.Errorf("signal %v, want 600 kHz wide, 08:00 to 15:59", s)
	}
}

func TestSpectrogramDataRolling(t *testing.T) {
	now := time.Now().UTC()
	if now.Hour() == 0 && now.Minute() < 5 {
		t.Skip("too close to UTC midnight for a rolling window with today's rows")
	}
	m := newTestMCPServer(t, nil, nil, nil)
	m.Spectrogram = newTestRollingRecorder(t, now, now.Hour()*60+now.Minute())
	out := spectrogramData(t, m, map[string]interface{}{"view": "grid", "hours": 2, "freq_bins": 4})
	n, step := len(out["rows"].([]interface{})), out["step_minutes"].(float64)
	if span := float64(n) * step; n > 24 || span < 120 || span > 120+2*step {
		t.Errorf("2 hours gave %d rows of %v minutes, want about 120 minutes in at most 24 rows", n, step)
	}
	if out := spectrogramData(t, m, map[string]interface{}{"view": "spectrum"}); out["at_utc"] == nil {
		t.Error("spectrum without 'at' should use the latest minute")
	}
}

// Every argument is checked before any data is read.
func TestSpectrogramDataValidation(t *testing.T) {
	m, date := newSpectrogramDataServer(t)
	cases := []struct {
		args map[string]interface{}
		want string
	}{
		{map[string]interface{}{}, "view is required"},
		{map[string]interface{}{"view": "waterfall"}, "view must be one of"},
		{map[string]interface{}{"view": "grid", "colour": "red"}, `unknown argument "colour"`},
		{map[string]interface{}{"view": "grid", "hours": "NaN"}, "finite"},
		{map[string]interface{}{"view": "grid", "hours": "Inf"}, "finite"},
		{map[string]interface{}{"view": "grid", "hours": 25}, "between 1 and 24"},
		{map[string]interface{}{"view": "grid", "hours": 2.5}, "whole number"},
		{map[string]interface{}{"view": "grid", "hours": true}, "must be a number"},
		{map[string]interface{}{"view": "grid", "date": "../../etc/passwd"}, "too long"},
		{map[string]interface{}{"view": "grid", "date": "../../etc"}, "YYYY-MM-DD"},
		{map[string]interface{}{"view": "grid", "date": "2026-1-5"}, "YYYY-MM-DD"},
		{map[string]interface{}{"view": "grid", "date": "2099-01-01"}, "future"},
		{map[string]interface{}{"view": "grid", "date": "2001-01-01"}, "no spectrogram is archived"},
		{map[string]interface{}{"view": "grid", "date": date, "hours": 3}, "hours applies to the rolling window"},
		{map[string]interface{}{"view": "grid", "date": date, "from_utc": "12:00", "to_utc": "11:00"}, "after from_utc"},
		{map[string]interface{}{"view": "grid", "date": date, "from_utc": "25:00"}, "HH:MM"},
		{map[string]interface{}{"view": "grid", "from_utc": "2001-01-01T00:00:00Z"}, "last 24 hours"},
		{map[string]interface{}{"view": "grid", "band": "2m"}, "no spectrogram is recorded for band"},
		{map[string]interface{}{"view": "grid", "band": strings.Repeat("x", 100)}, "too long"},
		{map[string]interface{}{"view": "grid", "band": "20m\x00"}, "control characters"},
		{map[string]interface{}{"view": "grid", "date": date, "freq_min_khz": 50000}, "outside"},
		{map[string]interface{}{"view": "grid", "freq_min_khz": 9000, "freq_max_khz": 8000}, "above freq_min_khz"},
		{map[string]interface{}{"view": "grid", "freq_min_khz": -1}, "between 0 and"},
		{map[string]interface{}{"view": "grid", "points": 10}, "does not apply to the grid view"},
		{map[string]interface{}{"view": "timeslice"}, "needs freqs_khz"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": "1,2,3,4,5,6,7,8,9"}, "at most 8"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": "7050, abc"}, "entry 2"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": []interface{}{"NaN"}}, "finite"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": "7050", "bandwidth_khz": 0}, "between"},
		{map[string]interface{}{"view": "timeslice", "date": date, "freqs_khz": "40000"}, "outside"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": "7050", "freq_min_khz": 7000}, "not freq_min_khz"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": "1,2,3,4,5,6,7,8", "step_minutes": 1}, "at most 2880"},
		{map[string]interface{}{"view": "spectrum", "minutes": 61}, "between 1 and 60"},
		{map[string]interface{}{"view": "spectrum", "date": date, "at": "2001-01-01T00:00:00Z"}, "within the window"},
		{map[string]interface{}{"view": "events", "max_items": 51}, "between 0 and 50"},
		{map[string]interface{}{"view": "events", "stat": "mode"}, "must be one of"},
		{map[string]interface{}{"view": "events", "stat": "max"}, "does not apply"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": []interface{}{7050.0, nil}}, "entry 2 is null"},
		{map[string]interface{}{"view": "timeslice", "freqs_khz": []interface{}{1, 2, 3, 4, 5, 6, 7, 8, 9}}, "at most 8"},
	}
	for _, c := range cases {
		spectrogramDataError(t, m, c.args, c.want)
	}
}

func TestSgdSelectMatchesSort(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(400)
		vals := make([]float32, n)
		for i := range vals {
			if trial%2 == 0 {
				vals[i] = float32(-110 + rng.Intn(3)) // mostly repeats, like quiet noise
			} else {
				vals[i] = rng.Float32()*60 - 120
			}
		}
		sorted := append([]float32(nil), vals...)
		sortFloat32Slice(sorted)
		k := rng.Intn(n)
		if got := sgdSelect(append([]float32(nil), vals...), k); got != sorted[k] {
			t.Fatalf("trial %d: select(%d of %d) = %v, want %v", trial, k, n, got, sorted[k])
		}
	}
}
