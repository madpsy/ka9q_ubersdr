package main

import (
	"reflect"
	"testing"
	"time"
)

// newTestStatsLogger builds a StatsLogger backed by a real on-disk SQLite DB
// in a temp dir.
func newTestStatsLogger(t *testing.T) (*StatsLogger, *DBManager) {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	sl := NewStatsLogger()
	sl.SetDB(mgr.DB())
	sl.SetReadDB(mgr.ReadDB())
	return sl, mgr
}

// paramsFor returns a StatsQueryParams covering the single UTC day of t.
func paramsFor(ts time.Time) StatsQueryParams {
	day := time.Date(ts.Year(), ts.Month(), ts.Day(), 0, 0, 0, 0, time.UTC)
	return StatsQueryParams{FromDate: day, ToDate: day}
}

func TestWSPRRoundTripsThroughDB(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 13, 0, 0, 0, time.UTC)

	want := &WSPRRankResponse{
		GeneratedAt: ts,
		Rolling24h: WSPRRankWindow{
			FetchedAt: ts,
			FetchedMs: 412,
			Rows:      2,
			Data: []WSPRRankRow{
				{
					RxSign: "G0ABC", RxLoc: "IO91", Raw: 100, Dupe: 10, Unique: 90,
					Bands: []int16{14, 7}, Uniques: []uint64{60, 30},
					Gross: []uint64{70, 30}, Dupes: []uint64{10, 0},
					Versions: []string{"1.2.3"},
				},
				{RxSign: "M0XYZ", RxLoc: "IO83", Raw: 50, Dupe: 5, Unique: 45},
			},
		},
		// Yesterday deliberately holds a failed fetch: zero rows but an error
		// that the API response must still reproduce.
		Yesterday: WSPRRankWindow{FetchedAt: ts, FetchedMs: 9, Error: "upstream timeout"},
		Today:     WSPRRankWindow{FetchedAt: ts, FetchedMs: 200, Rows: 1, Data: []WSPRRankRow{{RxSign: "2E0QQQ", Unique: 7}}},
	}

	sl.WriteWSPR(want)

	got, err := sl.ReadWSPR(paramsFor(ts))
	if err != nil {
		t.Fatalf("ReadWSPR: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("ReadWSPR returned %d snapshots, want 1", len(got))
	}
	if !reflect.DeepEqual(got[0], *want) {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got[0], *want)
	}

	latest := sl.LoadLatestWSPR()
	if latest == nil {
		t.Fatal("LoadLatestWSPR returned nil")
	}
	if !reflect.DeepEqual(*latest, *want) {
		t.Errorf("LoadLatestWSPR mismatch:\n got %+v\nwant %+v", *latest, *want)
	}
}

func TestWSPRRewritesSnapshotAtSameTimestamp(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 13, 0, 0, 0, time.UTC)

	sl.WriteWSPR(&WSPRRankResponse{
		GeneratedAt: ts,
		Rolling24h:  WSPRRankWindow{Rows: 3, Data: []WSPRRankRow{{RxSign: "A"}, {RxSign: "B"}, {RxSign: "C"}}},
	})
	sl.WriteWSPR(&WSPRRankResponse{
		GeneratedAt: ts,
		Rolling24h:  WSPRRankWindow{Rows: 1, Data: []WSPRRankRow{{RxSign: "Z"}}},
	})

	got, err := sl.ReadWSPR(paramsFor(ts))
	if err != nil {
		t.Fatalf("ReadWSPR: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1 (rewrite should replace, not append)", len(got))
	}
	if n := len(got[0].Rolling24h.Data); n != 1 {
		t.Fatalf("got %d rows, want 1 — stale rows from the first write survived", n)
	}
	if got[0].Rolling24h.Data[0].RxSign != "Z" {
		t.Errorf("got rx_sign %q, want Z", got[0].Rolling24h.Data[0].RxSign)
	}
}

func TestPSKRoundTripsThroughDB(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 14, 30, 0, 0, time.UTC)

	want := &PSKRankData{
		FetchedAt: ts,
		FetchedMs: 1234,
		ReportResult: PSKMonitorsByBand{
			"20m": {{Callsign: "G0ABC", Day: 500, Week: 3000}, {Callsign: "M0XYZ", Day: 400, Week: 2000}},
			"40m": {{Callsign: "G0ABC", Day: 100, Week: 700}},
		},
		CountryResult: PSKMonitorsByBand{
			"20m": {{Callsign: "M0XYZ", Day: 60, Week: 90}},
		},
		SoftwareInUse: map[string][]PSKSoftwareEntry{
			"G0ABC": {{Name: "UberSDR", Version: "0.1.58"}},
			"M0XYZ": {{Name: "WSJT-X"}},
		},
	}

	sl.WritePSK(want)

	got, err := sl.ReadPSK(paramsFor(ts))
	if err != nil {
		t.Fatalf("ReadPSK: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("ReadPSK returned %d snapshots, want 1", len(got))
	}
	if !reflect.DeepEqual(got[0], *want) {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got[0], *want)
	}

	// Band ordering must survive: rank is derived from array position.
	if cs := got[0].ReportResult["20m"][0].Callsign; cs != "G0ABC" {
		t.Errorf("20m rank 1 is %q, want G0ABC — entry order was not preserved", cs)
	}

	latest := sl.LoadLatestPSK()
	if latest == nil {
		t.Fatal("LoadLatestPSK returned nil")
	}
	if !reflect.DeepEqual(*latest, *want) {
		t.Errorf("LoadLatestPSK mismatch:\n got %+v\nwant %+v", *latest, *want)
	}
}

func TestRBNRoundTripsThroughDB(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	ts := time.Date(2026, 7, 22, 0, 15, 42, 0, time.UTC)
	const comment = "# Calculated 2026-07-22 00:15:42"

	skew := map[string]RBNSkewEntry{
		"G0ABC": {Callsign: "G0ABC", Skew: -1.5, Spots: 1200, CorrectionFactor: 0.9999},
		"M0XYZ": {Callsign: "M0XYZ", Skew: 0.25, Spots: 800, CorrectionFactor: 1.0001},
	}
	stats := map[string]RBNStatisticsEntry{
		"G0ABC": {Callsign: "G0ABC", EpochDate: 20657, SpotCount: 1200},
		"M0XYZ": {Callsign: "M0XYZ", EpochDate: 20657, SpotCount: 800},
	}

	sl.WriteRBNSkew(skew, comment, ts)
	sl.WriteRBNStats(stats, comment, ts)

	got, err := sl.ReadRBN(paramsFor(ts))
	if err != nil {
		t.Fatalf("ReadRBN: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("ReadRBN returned %d records, want 1 (one per UTC day)", len(got))
	}
	rec := got[0]
	if rec.SourceComment != comment {
		t.Errorf("source_comment = %q, want %q", rec.SourceComment, comment)
	}
	if !rec.FetchedAt.Equal(ts) {
		t.Errorf("fetched_at = %v, want %v", rec.FetchedAt, ts)
	}
	if len(rec.SkewEntries) != 2 || len(rec.StatsEntries) != 2 {
		t.Fatalf("got %d skew / %d stats entries, want 2 / 2", len(rec.SkewEntries), len(rec.StatsEntries))
	}
	for _, e := range rec.SkewEntries {
		if !reflect.DeepEqual(e, skew[e.Callsign]) {
			t.Errorf("skew entry %s: got %+v, want %+v", e.Callsign, e, skew[e.Callsign])
		}
	}
	for _, e := range rec.StatsEntries {
		if !reflect.DeepEqual(e, stats[e.Callsign]) {
			t.Errorf("stats entry %s: got %+v, want %+v", e.Callsign, e, stats[e.Callsign])
		}
	}

	gotSkew, gotComment, at := sl.LoadLatestRBNSkew()
	if !reflect.DeepEqual(gotSkew, skew) {
		t.Errorf("LoadLatestRBNSkew: got %+v, want %+v", gotSkew, skew)
	}
	if gotComment != comment || at == nil || !at.Equal(ts) {
		t.Errorf("LoadLatestRBNSkew metadata: comment=%q at=%v", gotComment, at)
	}

	gotStats, _, _ := sl.LoadLatestRBNStats()
	if !reflect.DeepEqual(gotStats, stats) {
		t.Errorf("LoadLatestRBNStats: got %+v, want %+v", gotStats, stats)
	}
}

// RBN publishes one snapshot per day; a second fetch on the same UTC day must
// replace the first rather than accumulate alongside it.
func TestRBNSecondFetchSameDayReplacesFirst(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	morning := time.Date(2026, 7, 22, 0, 15, 0, 0, time.UTC)
	evening := time.Date(2026, 7, 22, 18, 45, 0, 0, time.UTC)

	sl.WriteRBNSkew(map[string]RBNSkewEntry{
		"G0ABC": {Callsign: "G0ABC", Skew: -1.5},
		"M0XYZ": {Callsign: "M0XYZ", Skew: 0.25},
	}, "morning", morning)
	sl.WriteRBNSkew(map[string]RBNSkewEntry{
		"G0ABC": {Callsign: "G0ABC", Skew: -2.0},
	}, "evening", evening)

	got, err := sl.ReadRBN(paramsFor(morning))
	if err != nil {
		t.Fatalf("ReadRBN: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d records, want 1", len(got))
	}
	if n := len(got[0].SkewEntries); n != 1 {
		t.Fatalf("got %d skew entries, want 1 — the morning snapshot was not replaced", n)
	}
	if got[0].SourceComment != "evening" {
		t.Errorf("source_comment = %q, want evening", got[0].SourceComment)
	}
}

// Snapshots outside the requested date range must not be returned.
func TestStatsReadHonoursDateRange(t *testing.T) {
	sl, _ := newTestStatsLogger(t)
	inRange := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	outOfRange := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)

	sl.WritePSK(&PSKRankData{FetchedAt: inRange, ReportResult: PSKMonitorsByBand{"20m": {{Callsign: "IN"}}}})
	sl.WritePSK(&PSKRankData{FetchedAt: outOfRange, ReportResult: PSKMonitorsByBand{"20m": {{Callsign: "OUT"}}}})

	got, err := sl.ReadPSK(paramsFor(inRange))
	if err != nil {
		t.Fatalf("ReadPSK: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(got))
	}
	if cs := got[0].ReportResult["20m"][0].Callsign; cs != "IN" {
		t.Errorf("got callsign %q, want IN", cs)
	}

	// A range spanning both days returns both, oldest first.
	both := StatsQueryParams{
		FromDate: time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC),
		ToDate:   time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC),
	}
	got, err = sl.ReadPSK(both)
	if err != nil {
		t.Fatalf("ReadPSK: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d snapshots, want 2", len(got))
	}
	if !got[0].FetchedAt.Before(got[1].FetchedAt) {
		t.Errorf("snapshots not ordered oldest first: %v then %v", got[0].FetchedAt, got[1].FetchedAt)
	}
}
