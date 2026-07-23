package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// writePSKAt stores a minimal snapshot at ts so nearest-match can be exercised.
func writePSKAt(sl *StatsLogger, ts time.Time, topCall string) {
	sl.WritePSK(&PSKRankData{
		FetchedAt: ts,
		ReportResult: PSKMonitorsByBand{
			"All": {{Callsign: topCall, Day: 1000, Week: 5000}},
			"20m": {{Callsign: topCall, Day: 600, Week: 3000}},
		},
		CountryResult: PSKMonitorsByBand{
			"All": {{Callsign: topCall, Day: 90, Week: 120}},
		},
		SoftwareInUse: map[string][]PSKSoftwareEntry{
			topCall: {{Name: "UberSDR", Version: "0.1.58"}},
		},
	})
}

func TestReadPSKAtPicksNearestSnapshot(t *testing.T) {
	sl, _ := newTestStatsLogger(t)

	base := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	writePSKAt(sl, base, "G0AAA")                  // 12:00
	writePSKAt(sl, base.Add(time.Hour), "G0BBB")   // 13:00
	writePSKAt(sl, base.Add(2*time.Hour), "G0CCC") // 14:00

	cases := []struct {
		name string
		at   time.Time
		want string
	}{
		{"exact match", base.Add(time.Hour), "G0BBB"},
		{"rounds back", base.Add(70 * time.Minute), "G0BBB"},
		{"rounds forward", base.Add(50 * time.Minute), "G0BBB"},
		{"before first snapshot clamps forward", base.Add(-30 * time.Minute), "G0AAA"},
		{"after last snapshot clamps back", base.Add(5 * time.Hour), "G0CCC"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := sl.ReadPSKAt(tc.at, pskAtSearchWindow)
			if err != nil {
				t.Fatalf("ReadPSKAt: %v", err)
			}
			if got == nil {
				t.Fatal("ReadPSKAt returned nil, want a snapshot")
			}
			if cs := got.ReportResult["All"][0].Callsign; cs != tc.want {
				t.Errorf("nearest snapshot top callsign = %q, want %q (fetched_at=%s)",
					cs, tc.want, got.FetchedAt.Format(time.RFC3339))
			}
		})
	}
}

func TestReadPSKAtOutsideWindowReturnsNil(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	base := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	writePSKAt(sl, base, "G0AAA")

	got, err := sl.ReadPSKAt(base.Add(48*time.Hour), pskAtSearchWindow)
	if err != nil {
		t.Fatalf("ReadPSKAt: %v", err)
	}
	if got != nil {
		t.Errorf("got snapshot %s, want nil — it is outside the ±%s window",
			got.FetchedAt.Format(time.RFC3339), pskAtSearchWindow)
	}
}

func TestParsePSKAtParam(t *testing.T) {
	want := time.Date(2026, 7, 22, 13, 45, 0, 0, time.UTC)

	valid := map[string]time.Time{
		"2026-07-22T13:45:00Z":      want,
		"2026-07-22T13:45:00":       want,
		"2026-07-22T13:45":          want,
		"2026-07-22 13:45":          want,
		"2026-07-22":                time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC),
		"1784727900":                want, // Unix seconds for 2026-07-22T13:45:00Z
		"2026-07-22T14:45:00+01:00": want, // offset normalised to UTC
	}
	for raw, exp := range valid {
		got, errMsg := parseStatsAtParam(raw)
		if errMsg != "" {
			t.Errorf("parseStatsAtParam(%q) = error %q, want success", raw, errMsg)
			continue
		}
		if !got.Equal(exp) {
			t.Errorf("parseStatsAtParam(%q) = %s, want %s", raw, got.Format(time.RFC3339), exp.Format(time.RFC3339))
		}
	}

	invalid := []string{
		"",
		"yesterday",
		"2026-13-45",
		"22/07/2026",
		"1999-01-01T00:00:00Z", // before pskAtMinYear
		"9999-01-01T00:00:00Z", // future
		"'; DROP TABLE psk_rank_snapshots;--",
		"2026-07-22T13:45:00Z-padding-to-exceed-the-length-cap",
	}
	for _, raw := range invalid {
		if _, errMsg := parseStatsAtParam(raw); errMsg == "" {
			t.Errorf("parseStatsAtParam(%q) succeeded, want rejection", raw)
		}
	}
}

// serveAt drives the public handler with the given query string.
func serveAt(t *testing.T, sl *StatsLogger, query string) (*httptest.ResponseRecorder, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/stats/psk-rank?"+query, nil)
	rec := httptest.NewRecorder()
	// checkIPBan dereferences the manager unconditionally, so pass a real one
	// backed by a temp file rather than nil.
	handlePSKRankHistory(rec, req, sl, NewIPBanManager(t.TempDir()+"/bans.json"), NewFFTRateLimiter())

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return rec, body
}

func TestPSKRankAtEndpoint(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	base := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	writePSKAt(sl, base, "G0AAA")

	t.Run("returns nearest snapshot with drift", func(t *testing.T) {
		rec, body := serveAt(t, sl, "at=2026-07-22T12:20:00Z")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d, want 200 (body %s)", rec.Code, rec.Body.String())
		}
		if body["mode"] != "at" {
			t.Errorf("mode = %v, want \"at\"", body["mode"])
		}
		if body["fetched_at"] != "2026-07-22T12:00:00Z" {
			t.Errorf("fetched_at = %v, want 2026-07-22T12:00:00Z", body["fetched_at"])
		}
		if off, _ := body["offset_seconds"].(float64); off != -1200 {
			t.Errorf("offset_seconds = %v, want -1200", body["offset_seconds"])
		}
		if _, ok := body["report_result"]; !ok {
			t.Error("report_result missing")
		}
		if _, ok := body["country_result"]; !ok {
			t.Error("country_result missing")
		}
	})

	t.Run("band filter is case-insensitive", func(t *testing.T) {
		_, body := serveAt(t, sl, "at=2026-07-22T12:00:00Z&band=20M&table=reports")
		rr, ok := body["report_result"].(map[string]interface{})
		if !ok {
			t.Fatalf("report_result missing or wrong type: %v", body["report_result"])
		}
		if len(rr) != 1 {
			t.Fatalf("report_result has %d bands, want only 20m: %v", len(rr), rr)
		}
		if _, ok := rr["20m"]; !ok {
			t.Errorf("report_result keys = %v, want 20m", rr)
		}
		if _, ok := body["country_result"]; ok {
			t.Error("country_result present despite table=reports")
		}
	})

	t.Run("rejects bad input", func(t *testing.T) {
		for _, q := range []string{
			"at=2026-07-22T12:00:00Z&callsign=G0AAA",
			"at=not-a-time",
			"at=2026-07-22T12:00:00Z&table=bogus",
			"at=2026-07-22T12:00:00Z&band=<script>",
			"at=2026-07-22T12:00:00Z&band=verylongbandname",
		} {
			rec, _ := serveAt(t, sl, q)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("query %q returned %d, want 400", q, rec.Code)
			}
		}
	})

	t.Run("404 outside window", func(t *testing.T) {
		rec, body := serveAt(t, sl, "at=2026-07-01T12:00:00Z")
		if rec.Code != http.StatusNotFound {
			t.Errorf("status %d, want 404", rec.Code)
		}
		if body["error"] == nil {
			t.Error("404 body has no error field")
		}
	})
}

// ── WSPR point-in-time ────────────────────────────────────────────────────

// writeWSPRAt stores a snapshot at ts whose rolling_24h window holds n rows,
// the first of which is topCall.
func writeWSPRAt(sl *StatsLogger, ts time.Time, topCall string, n int) {
	rows := make([]WSPRRankRow, 0, n)
	rows = append(rows, WSPRRankRow{RxSign: topCall, Unique: uint64(1000 + n)})
	for i := 1; i < n; i++ {
		rows = append(rows, WSPRRankRow{RxSign: fmt.Sprintf("FILL%03d", i), Unique: uint64(1000 + n - i)})
	}
	sl.WriteWSPR(&WSPRRankResponse{
		GeneratedAt: ts,
		Rolling24h:  WSPRRankWindow{FetchedAt: ts, FetchedMs: 100, Rows: n, Data: rows},
		Yesterday:   WSPRRankWindow{FetchedAt: ts, FetchedMs: 90, Rows: 1, Data: []WSPRRankRow{{RxSign: "YEST1", Unique: 5}}},
		Today:       WSPRRankWindow{FetchedAt: ts, FetchedMs: 80, Rows: 1, Data: []WSPRRankRow{{RxSign: "TODY1", Unique: 3}}},
	})
}

func TestReadWSPRAtPicksNearestSnapshot(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	base := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	writeWSPRAt(sl, base, "G0AAA", 3)
	writeWSPRAt(sl, base.Add(time.Hour), "G0BBB", 3)

	for _, tc := range []struct {
		at   time.Time
		want string
	}{
		{base.Add(50 * time.Minute), "G0BBB"},
		{base.Add(20 * time.Minute), "G0AAA"},
		{base.Add(-6 * time.Hour), "G0AAA"},
	} {
		got, err := sl.ReadWSPRAt(tc.at, wsprAtSearchWindow)
		if err != nil {
			t.Fatalf("ReadWSPRAt(%s): %v", tc.at.Format(time.RFC3339), err)
		}
		if got == nil {
			t.Fatalf("ReadWSPRAt(%s) returned nil", tc.at.Format(time.RFC3339))
		}
		if cs := got.Rolling24h.Data[0].RxSign; cs != tc.want {
			t.Errorf("at %s: top callsign = %q, want %q", tc.at.Format(time.RFC3339), cs, tc.want)
		}
	}

	if got, err := sl.ReadWSPRAt(base.Add(72*time.Hour), wsprAtSearchWindow); err != nil || got != nil {
		t.Errorf("outside window: got (%v, %v), want (nil, nil)", got, err)
	}
}

// serveStatsAt drives a public stats handler with the given query string.
func serveStatsAt(t *testing.T, sl *StatsLogger, path, query string,
	h func(http.ResponseWriter, *http.Request, *StatsLogger, *IPBanManager, *FFTRateLimiter),
) (*httptest.ResponseRecorder, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path+"?"+query, nil)
	rec := httptest.NewRecorder()
	h(rec, req, sl, NewIPBanManager(t.TempDir()+"/bans.json"), NewFFTRateLimiter())

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return rec, body
}

func TestWSPRRankAtEndpoint(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	base := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	writeWSPRAt(sl, base, "G0AAA", 250)

	t.Run("caps rows at the default limit", func(t *testing.T) {
		rec, body := serveStatsAt(t, sl, "/api/stats/wspr-rank", "at=2026-07-22T12:30:00Z", handleWSPRRankHistory)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
		}
		if off, _ := body["offset_seconds"].(float64); off != -1800 {
			t.Errorf("offset_seconds = %v, want -1800", body["offset_seconds"])
		}
		win, ok := body["rolling_24h"].(map[string]interface{})
		if !ok {
			t.Fatalf("rolling_24h missing: %v", body)
		}
		data, _ := win["data"].([]interface{})
		if len(data) != statsAtDefaultLimit {
			t.Errorf("returned %d rows, want the %d-row default cap", len(data), statsAtDefaultLimit)
		}
		if total, _ := win["total_rows"].(float64); int(total) != 250 {
			t.Errorf("total_rows = %v, want 250", win["total_rows"])
		}
	})

	t.Run("window filter", func(t *testing.T) {
		_, body := serveStatsAt(t, sl, "/api/stats/wspr-rank", "at=2026-07-22T12:00:00Z&window=today", handleWSPRRankHistory)
		if _, ok := body["today"]; !ok {
			t.Error("today window missing")
		}
		for _, k := range []string{"rolling_24h", "yesterday"} {
			if _, ok := body[k]; ok {
				t.Errorf("%s present despite window=today", k)
			}
		}
	})

	t.Run("explicit limit", func(t *testing.T) {
		_, body := serveStatsAt(t, sl, "/api/stats/wspr-rank", "at=2026-07-22T12:00:00Z&window=rolling_24h&limit=5", handleWSPRRankHistory)
		win, _ := body["rolling_24h"].(map[string]interface{})
		data, _ := win["data"].([]interface{})
		if len(data) != 5 {
			t.Errorf("returned %d rows, want 5", len(data))
		}
	})

	t.Run("rejects bad input", func(t *testing.T) {
		for _, q := range []string{
			"at=2026-07-22T12:00:00Z&callsign=G0AAA",
			"at=nope",
			"at=2026-07-22T12:00:00Z&window=bogus",
			"at=2026-07-22T12:00:00Z&limit=0",
			"at=2026-07-22T12:00:00Z&limit=-5",
			"at=2026-07-22T12:00:00Z&limit=9999",
			"at=2026-07-22T12:00:00Z&limit=abc",
		} {
			rec, _ := serveStatsAt(t, sl, "/api/stats/wspr-rank", q, handleWSPRRankHistory)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("query %q returned %d, want 400", q, rec.Code)
			}
		}
	})

	t.Run("404 outside window", func(t *testing.T) {
		rec, _ := serveStatsAt(t, sl, "/api/stats/wspr-rank", "at=2026-06-01T12:00:00Z", handleWSPRRankHistory)
		if rec.Code != http.StatusNotFound {
			t.Errorf("status %d, want 404", rec.Code)
		}
	})
}

// ── RBN point-in-time ─────────────────────────────────────────────────────

func TestRBNAtEndpoint(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 0, 15, 0, 0, time.UTC)

	sl.WriteRBNSkew(map[string]RBNSkewEntry{
		"G0ABC": {Callsign: "G0ABC", Skew: -1.5, Spots: 1200},
		"M0XYZ": {Callsign: "M0XYZ", Skew: 4.25, Spots: 800},
		"DL1AA": {Callsign: "DL1AA", Skew: 0.1, Spots: 50},
	}, "# Calculated 2026-07-22", ts)
	sl.WriteRBNStats(map[string]RBNStatisticsEntry{
		"G0ABC": {Callsign: "G0ABC", SpotCount: 1200},
		"M0XYZ": {Callsign: "M0XYZ", SpotCount: 800},
		"DL1AA": {Callsign: "DL1AA", SpotCount: 50},
	}, "# Calculated 2026-07-22", ts)

	t.Run("returns the day nearest the instant, ranked", func(t *testing.T) {
		// Mid-afternoon request matches the 00:15 fetch of the same day.
		rec, body := serveStatsAt(t, sl, "/api/stats/rbn", "at=2026-07-22T15:00:00Z", handleRBNHistory)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
		}
		if body["fetched_at"] != "2026-07-22T00:15:00Z" {
			t.Errorf("fetched_at = %v, want 2026-07-22T00:15:00Z", body["fetched_at"])
		}
		if off, _ := body["offset_seconds"].(float64); off != -53100 {
			t.Errorf("offset_seconds = %v, want -53100", body["offset_seconds"])
		}

		stats, _ := body["stats_entries"].([]interface{})
		if len(stats) != 3 {
			t.Fatalf("got %d stats entries, want 3", len(stats))
		}
		first, _ := stats[0].(map[string]interface{})
		if first["callsign"] != "G0ABC" {
			t.Errorf("top stats entry = %v, want G0ABC (highest spot count)", first["callsign"])
		}

		skew, _ := body["skew_entries"].([]interface{})
		firstSkew, _ := skew[0].(map[string]interface{})
		if firstSkew["callsign"] != "M0XYZ" {
			t.Errorf("top skew entry = %v, want M0XYZ (largest |skew|)", firstSkew["callsign"])
		}
		if total, _ := body["total_skew_entries"].(float64); int(total) != 3 {
			t.Errorf("total_skew_entries = %v, want 3", body["total_skew_entries"])
		}
	})

	t.Run("limit truncates but reports the total", func(t *testing.T) {
		_, body := serveStatsAt(t, sl, "/api/stats/rbn", "at=2026-07-22T00:15:00Z&limit=1", handleRBNHistory)
		stats, _ := body["stats_entries"].([]interface{})
		if len(stats) != 1 {
			t.Errorf("got %d stats entries, want 1", len(stats))
		}
		if total, _ := body["total_stats_entries"].(float64); int(total) != 3 {
			t.Errorf("total_stats_entries = %v, want 3", body["total_stats_entries"])
		}
	})

	t.Run("rejects bad input", func(t *testing.T) {
		for _, q := range []string{
			"at=2026-07-22T00:15:00Z&callsign=G0ABC",
			"at=garbage",
			"at=2026-07-22T00:15:00Z&limit=0",
			"at=2026-07-22T00:15:00Z&limit=100000",
		} {
			rec, _ := serveStatsAt(t, sl, "/api/stats/rbn", q, handleRBNHistory)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("query %q returned %d, want 400", q, rec.Code)
			}
		}
	})

	t.Run("404 outside window", func(t *testing.T) {
		rec, _ := serveStatsAt(t, sl, "/api/stats/rbn", "at=2026-07-10T00:00:00Z", handleRBNHistory)
		if rec.Code != http.StatusNotFound {
			t.Errorf("status %d, want 404", rec.Code)
		}
	})
}
