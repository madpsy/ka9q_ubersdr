package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// stats_psk_golden_test.go — every PSK-serving endpoint and tool, fed the same
// input snapshots, must answer exactly as it did with the row-per-entry
// storage that psk_snapshots replaced.
//
// testdata/psk_store_golden.json was recorded by running this test against
// the previous storage (psk_rank_snapshots / psk_rank_entries / psk_software)
// with PSK_GOLDEN_RECORD=1. It is the reference; do not re-record it from the
// current storage, or the comparison proves nothing.
//
// Snapshot times are relative to now because the period= and MCP history
// options are. Each YYYY-MM-DD in a response is rewritten as {D-n}, n days
// before today, so the recording stays comparable on any later day.

const pskGoldenFile = "testdata/psk_store_golden.json"

// pskGoldenInput is the shared input: three full scrapes an hour apart on
// two days, then a failed scrape. Callsigns repeat across bands and tables,
// software lists are unsorted and contain a duplicate, and one band is empty.
func pskGoldenInput(base time.Time) []*PSKRankData {
	var out []*PSKRankData
	for i, at := range []time.Time{
		base.AddDate(0, 0, -1), // a day earlier: exercises per-day thinning
		base,
		base.Add(time.Hour),
		base.Add(2 * time.Hour),
	} {
		out = append(out, &PSKRankData{
			FetchedAt: at,
			FetchedMs: int64(100 + i),
			ReportResult: PSKMonitorsByBand{
				"All": {{Callsign: "G0AAA", Day: 900 + i, Week: 5000}, {Callsign: "M9PSY", Day: 500 - i, Week: 3000}, {Callsign: "K1ABC", Day: 10, Week: 20}},
				"20m": {{Callsign: "M9PSY", Day: 300, Week: 900}, {Callsign: "g0aaa", Day: 200, Week: 800}},
				"40m": {},
			},
			CountryResult: PSKMonitorsByBand{
				"All": {{Callsign: "K1ABC", Day: 90, Week: 120}, {Callsign: "M9PSY", Day: 80 + i, Week: 110}},
				"20m": {{Callsign: "M9PSY", Day: 40, Week: 60}},
			},
			SoftwareInUse: map[string][]PSKSoftwareEntry{
				"M9PSY": {{Name: "UberSDR", Version: "0.2.0"}, {Name: "UberSDR", Version: "0.1.0"}, {Name: "JTDX"}},
				"G0AAA": {{Name: "WSJT-X", Version: "2.7"}, {Name: "WSJT-X", Version: "2.7"}},
				"N0ONE": {{Name: "UberSDR WSPR"}}, // not ranked anywhere, but counted
			},
		})
	}
	out = append(out, &PSKRankData{FetchedAt: base.Add(5 * time.Hour), FetchedMs: 7, Error: "upstream returned HTTP 503"})
	return out
}

var (
	pskGoldenDate = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)
	// generated_at (rank-summary) is the time of the request, not data.
	pskGoldenGeneratedAt = regexp.MustCompile(`"generated_at":"[^"]*"`)
)

// pskGoldenComparable drops the parts of a recorded response that depend on
// when the request ran rather than on the stored data. Applied to both sides,
// so the recording keeps them verbatim.
func pskGoldenComparable(s string) string {
	return pskGoldenGeneratedAt.ReplaceAllString(s, `"generated_at":"{NOW}"`)
}

// pskGoldenNormalise rewrites dates relative to today.
func pskGoldenNormalise(s string, today time.Time) string {
	return pskGoldenDate.ReplaceAllStringFunc(s, func(d string) string {
		t, err := time.Parse("2006-01-02", d)
		if err != nil {
			return d
		}
		return fmt.Sprintf("{D-%d}", int(today.Sub(t).Hours()/24))
	})
}

// pskGoldenOutputs writes the input through StatsLogger and collects every
// PSK reader's response, keyed by a name for the endpoint and query.
func pskGoldenOutputs(t *testing.T) map[string]string {
	t.Helper()
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	base := today.AddDate(0, 0, -1).Add(10 * time.Hour) // yesterday 10:00

	sl, _ := newTestStatsLogger(t)
	for _, d := range pskGoldenInput(base) {
		sl.WritePSK(d)
	}

	out := make(map[string]string)
	record := func(name, body string) { out[name] = pskGoldenNormalise(strings.TrimSpace(body), today) }
	atParam := func(d time.Duration) string { return base.Add(d).Format(time.RFC3339) }

	// /api/stats/psk-rank — history and point-in-time modes (DB-backed).
	for name, q := range map[string]string{
		"history period=7d":                   "period=7d",
		"history from/to":                     "from_date=" + base.AddDate(0, 0, -1).Format("2006-01-02") + "&to_date=" + base.Format("2006-01-02"),
		"history callsign":                    "period=7d&callsign=m9psy",
		"history callsign+callsign2":          "period=24h&callsign=M9PSY&callsign2=K1ABC",
		"history callsign absent":             "period=7d&callsign=ZZ9ZZ",
		"at nearest":                          "at=" + atParam(70*time.Minute),
		"at tie":                              "at=" + atParam(90*time.Minute),
		"at band=20M table=reports":           "at=" + atParam(70*time.Minute) + "&band=20M&table=reports",
		"at band=All table=countries":         "at=" + atParam(0) + "&band=All&table=countries",
		"at failed scrape":                    "at=" + atParam(5*time.Hour),
		"at outside window":                   "at=" + base.AddDate(0, 0, -5).Format(time.RFC3339),
		"at unix seconds, unknown band":       fmt.Sprintf("at=%d&band=6m", base.Add(time.Hour).Unix()),
		"history period=30d callsign=g0aaa":   "period=30d&callsign=g0aaa",
		"history from/to single day callsign": "from_date=" + base.Format("2006-01-02") + "&callsign=K1ABC",
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/stats/psk-rank?"+q, nil)
		rec := httptest.NewRecorder()
		handlePSKRankHistory(rec, req, sl, NewIPBanManager(t.TempDir()+"/bans.json"), NewFFTRateLimiter())
		record("/api/stats/psk-rank "+name, fmt.Sprintf("%d %s", rec.Code, rec.Body.String()))
	}

	// MCP get_station_rankings history (DB-backed via ReadPSK).
	cfg := &Config{}
	cfg.Decoder.ReceiverCallsign = "M9PSY"
	for _, period := range []string{"24h", "7d", "30d"} {
		m := newTestMCPServer(t, cfg, nil, nil)
		m.StatsLogger = sl
		var got map[string]interface{}
		resultJSON(t, callTool(t, m, "get_station_rankings", "127.0.0.1", map[string]interface{}{"history": period}), &got)
		hist, _ := got["history"].(map[string]interface{})
		b, _ := json.Marshal(map[string]interface{}{"psk_reporter": hist["psk_reporter"], "psk_reporter_error": hist["psk_reporter_error"]})
		record("mcp get_station_rankings history="+period, string(b))
	}

	// The in-memory cache readers see whatever LoadLatestPSK seeds at startup
	// (PSKRankFetcher.Start), until the first live fetch replaces it.
	fetcher := NewPSKRankFetcher()
	fetcher.cached = sl.LoadLatestPSK()
	// The latest snapshot is the failed scrape; seed from the newest good one
	// as well, since that is the case with data in it.
	good, err := sl.ReadPSKAt(base.Add(2*time.Hour), time.Minute)
	if err != nil || good == nil {
		t.Fatalf("ReadPSKAt: %v", err)
	}
	for _, seed := range []struct {
		name string
		data *PSKRankData
	}{{"latest", fetcher.cached}, {"good", good}} {
		f := NewPSKRankFetcher()
		f.cached = seed.data
		ah := &AdminHandler{pskRank: f}
		for _, q := range []string{"", "table=reports&band=20m", "table=countries", "callsign=m9psy", "band=All"} {
			req := httptest.NewRequest(http.MethodGet, "/admin/psk-rank?"+q, nil)
			rec := httptest.NewRecorder()
			ah.HandlePSKRank(rec, req)
			record("/admin/psk-rank seed="+seed.name+" "+q, fmt.Sprintf("%d %s", rec.Code, rec.Body.String()))
		}

		req := httptest.NewRequest(http.MethodGet, "/api/stats/rank-summary", nil)
		rec := httptest.NewRecorder()
		handleRankSummary(rec, req, f, nil, nil, "M9PSY", "", NewIPBanManager(t.TempDir()+"/bans.json"), NewFFTRateLimiter())
		record("/api/stats/rank-summary seed="+seed.name, fmt.Sprintf("%d %s", rec.Code, rec.Body.String()))

		// /api/description pskreporter_rank, built the way buildDescription
		// builds it from the cache.
		c := f.Cached()
		b, _ := json.Marshal(PSKCallsignRank{
			LastUpdated:      c.FetchedAt,
			ReporterCallsign: "M9PSY",
			Reports:          computeCallsignRank(c.ReportResult, "M9PSY"),
			Countries:        computeCallsignRank(c.CountryResult, "M9PSY"),
		})
		record("/api/description pskreporter_rank seed="+seed.name, string(b))

		// The cache itself: what MQTT-free consumers (telegram /psk, monitor
		// display, notifier, instance reporter) read field by field.
		b, _ = json.Marshal(c)
		record("cache seed="+seed.name, string(b))
	}
	return out
}

func TestPSKEndpointsMatchPreviousStorage(t *testing.T) {
	got := pskGoldenOutputs(t)

	if os.Getenv("PSK_GOLDEN_RECORD") == "1" {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.MkdirAll("testdata", 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(pskGoldenFile, append(b, '\n'), 0644); err != nil {
			t.Fatal(err)
		}
		t.Skipf("recorded %d outputs to %s", len(got), pskGoldenFile)
	}

	raw, err := os.ReadFile(pskGoldenFile)
	if err != nil {
		t.Fatalf("read %s: %v", pskGoldenFile, err)
	}
	var want map[string]string
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("parse %s: %v", pskGoldenFile, err)
	}

	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		g, ok := got[name]
		if !ok {
			t.Errorf("%s: no longer produced", name)
			continue
		}
		if pskGoldenComparable(g) != pskGoldenComparable(want[name]) {
			t.Errorf("%s: response differs from the previous storage\n got %s\nwant %s", name, g, want[name])
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("%s: not in %s", name, pskGoldenFile)
		}
	}
}
