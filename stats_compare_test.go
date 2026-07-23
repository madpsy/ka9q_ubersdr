package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stats_compare_test.go — the ?callsign2= comparison filter shared by the three
// /api/stats/* history endpoints.

func TestParseStatsQueryParamsCallsign2(t *testing.T) {
	q := func(kv ...string) map[string][]string {
		m := map[string][]string{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = []string{kv[i+1]}
		}
		return m
	}

	t.Run("accepts and upper-cases both", func(t *testing.T) {
		p, errMsg := ParseStatsQueryParams(q("period", "7d", "callsign", "g0abc", "callsign2", "mm3psy"))
		if errMsg != "" {
			t.Fatalf("unexpected error: %s", errMsg)
		}
		if p.Callsign != "G0ABC" || p.Callsign2 != "MM3PSY" {
			t.Errorf("got %q / %q, want G0ABC / MM3PSY", p.Callsign, p.Callsign2)
		}
	})

	for _, tc := range []struct {
		name string
		args map[string][]string
	}{
		{"callsign2 without callsign", q("period", "7d", "callsign2", "MM3PSY")},
		{"identical callsigns", q("period", "7d", "callsign", "G0ABC", "callsign2", "g0abc")},
		{"callsign2 too long", q("period", "7d", "callsign", "G0ABC", "callsign2", "ABCDEFGHIJK")},
		{"callsign2 bad characters", q("period", "7d", "callsign", "G0ABC", "callsign2", "M0X<Z")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, errMsg := ParseStatsQueryParams(tc.args); errMsg == "" {
				t.Error("accepted, want rejection")
			}
		})
	}
}

// serveCompare drives a public stats handler and returns the decoded body.
func serveCompare(t *testing.T, sl *StatsLogger, path, query string,
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

// snapshotsOf pulls the snapshots array out of a decoded history response.
func snapshotsOf(t *testing.T, body map[string]interface{}) []map[string]interface{} {
	t.Helper()
	raw, _ := body["snapshots"].([]interface{})
	out := make([]map[string]interface{}, 0, len(raw))
	for _, s := range raw {
		m, ok := s.(map[string]interface{})
		if !ok {
			t.Fatalf("snapshot is not an object: %v", s)
		}
		out = append(out, m)
	}
	return out
}

func TestPSKHistoryComparesTwoCallsigns(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	day := time.Now().UTC().AddDate(0, 0, -1)
	base := time.Date(day.Year(), day.Month(), day.Day(), 10, 0, 0, 0, time.UTC)

	// First snapshot has both stations, second has only G0AAA.
	sl.WritePSK(&PSKRankData{
		FetchedAt: base,
		ReportResult: PSKMonitorsByBand{
			"All": {{Callsign: "G0AAA", Day: 900}, {Callsign: "M0BBB", Day: 500}},
		},
	})
	sl.WritePSK(&PSKRankData{
		FetchedAt: base.Add(time.Hour),
		ReportResult: PSKMonitorsByBand{
			"All": {{Callsign: "G0AAA", Day: 950}},
		},
	})

	rec, body := serveCompare(t, sl, "/api/stats/psk-rank", "period=7d&callsign=G0AAA&callsign2=M0BBB", handlePSKRankHistory)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if body["callsign2"] != "M0BBB" {
		t.Errorf("callsign2 echoed as %v, want M0BBB", body["callsign2"])
	}

	snaps := snapshotsOf(t, body)
	if len(snaps) != 2 {
		t.Fatalf("got %d snapshots, want 2", len(snaps))
	}
	if _, ok := snaps[0]["callsign_rank2"]; !ok {
		t.Error("first snapshot is missing callsign_rank2 — both stations were present")
	}
	// The second snapshot must survive on the strength of callsign alone, with
	// no rank2 key — that is what keeps the two series on one time axis.
	if _, ok := snaps[1]["callsign_rank"]; !ok {
		t.Error("second snapshot is missing callsign_rank")
	}
	if _, ok := snaps[1]["callsign_rank2"]; ok {
		t.Error("second snapshot has callsign_rank2, but M0BBB was absent from it")
	}
}

func TestWSPRHistoryComparesTwoCallsigns(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	day := time.Now().UTC().AddDate(0, 0, -1)
	base := time.Date(day.Year(), day.Month(), day.Day(), 10, 0, 0, 0, time.UTC)

	sl.WriteWSPR(&WSPRRankResponse{
		GeneratedAt: base,
		Rolling24h: WSPRRankWindow{FetchedAt: base, Rows: 2, Data: []WSPRRankRow{
			{RxSign: "G0AAA", Unique: 900}, {RxSign: "M0BBB", Unique: 500},
		}},
	})
	sl.WriteWSPR(&WSPRRankResponse{
		GeneratedAt: base.Add(time.Hour),
		Rolling24h: WSPRRankWindow{FetchedAt: base.Add(time.Hour), Rows: 1, Data: []WSPRRankRow{
			{RxSign: "M0BBB", Unique: 600},
		}},
	})

	_, body := serveCompare(t, sl, "/api/stats/wspr-rank", "period=7d&callsign=G0AAA&callsign2=M0BBB", handleWSPRRankHistory)
	snaps := snapshotsOf(t, body)
	if len(snaps) != 2 {
		t.Fatalf("got %d snapshots, want 2", len(snaps))
	}

	first, _ := snaps[0]["callsign_rank"].(map[string]interface{})
	firstWin, _ := first["rolling_24h"].(map[string]interface{})
	if rank, _ := firstWin["rank"].(float64); rank != 1 {
		t.Errorf("G0AAA rank = %v, want 1", firstWin["rank"])
	}
	second2, _ := snaps[0]["callsign_rank2"].(map[string]interface{})
	secondWin, _ := second2["rolling_24h"].(map[string]interface{})
	if rank, _ := secondWin["rank"].(float64); rank != 2 {
		t.Errorf("M0BBB rank = %v, want 2", secondWin["rank"])
	}

	// Snapshot two holds only the compared station: it must still be returned.
	if _, ok := snaps[1]["callsign_rank"]; ok {
		t.Error("second snapshot has callsign_rank, but G0AAA was absent from it")
	}
	if _, ok := snaps[1]["callsign_rank2"]; !ok {
		t.Error("second snapshot is missing callsign_rank2 — it should survive on callsign2 alone")
	}
}

func TestRBNHistoryComparesTwoCallsigns(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	day := time.Now().UTC().AddDate(0, 0, -1)
	ts := time.Date(day.Year(), day.Month(), day.Day(), 0, 15, 0, 0, time.UTC)

	sl.WriteRBNStats(map[string]RBNStatisticsEntry{
		"G0AAA": {Callsign: "G0AAA", SpotCount: 900},
		"M0BBB": {Callsign: "M0BBB", SpotCount: 500},
	}, "# day", ts)
	sl.WriteRBNSkew(map[string]RBNSkewEntry{
		"G0AAA": {Callsign: "G0AAA", Skew: -1.0},
		"M0BBB": {Callsign: "M0BBB", Skew: 2.0},
	}, "# day", ts)

	_, body := serveCompare(t, sl, "/api/stats/rbn", "period=7d&callsign=G0AAA&callsign2=M0BBB", handleRBNHistory)
	snaps := snapshotsOf(t, body)
	if len(snaps) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(snaps))
	}

	cd, _ := snaps[0]["callsign_data"].(map[string]interface{})
	if rank, _ := cd["stats_rank"].(float64); rank != 1 {
		t.Errorf("G0AAA stats_rank = %v, want 1", cd["stats_rank"])
	}
	cd2, ok := snaps[0]["callsign_data2"].(map[string]interface{})
	if !ok {
		t.Fatalf("callsign_data2 missing: %v", snaps[0])
	}
	if rank, _ := cd2["stats_rank"].(float64); rank != 2 {
		t.Errorf("M0BBB stats_rank = %v, want 2", cd2["stats_rank"])
	}
	stats2, _ := cd2["statistics"].(map[string]interface{})
	if count, _ := stats2["spot_count"].(float64); count != 500 {
		t.Errorf("M0BBB spot_count = %v, want 500", stats2["spot_count"])
	}
}

// callsign2 is meaningless for a point-in-time request, which already returns
// every station.
func TestPointInTimeRejectsCallsign2(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	for _, tc := range []struct {
		path string
		h    func(http.ResponseWriter, *http.Request, *StatsLogger, *IPBanManager, *FFTRateLimiter)
	}{
		{"/api/stats/psk-rank", handlePSKRankHistory},
		{"/api/stats/wspr-rank", handleWSPRRankHistory},
		{"/api/stats/rbn", handleRBNHistory},
	} {
		rec, _ := serveCompare(t, sl, tc.path, "at=2026-07-22T12:00:00Z&callsign2=M0BBB", tc.h)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s returned %d, want 400", tc.path, rec.Code)
		}
	}
}
