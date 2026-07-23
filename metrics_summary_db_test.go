package main

import (
	"testing"
	"time"
)

// flushSummaries persists all in-memory decoder summaries to the DB, bypassing
// the WriteIfNeeded rate limit.
func (msa *MetricsSummaryAggregator) flushAllForTest(t *testing.T) {
	t.Helper()
	msa.mu.RLock()
	all := make([]*MetricsSummary, 0, len(msa.summaries))
	for _, s := range msa.summaries {
		all = append(all, s)
	}
	msa.mu.RUnlock()
	for _, s := range all {
		if err := msa.saveSummary(s); err != nil {
			t.Fatalf("saveSummary: %v", err)
		}
	}
}

func (msa *CWMetricsSummaryAggregator) flushAllForTest(t *testing.T) {
	t.Helper()
	msa.mu.RLock()
	all := make([]*CWMetricsSummary, 0, len(msa.summaries))
	for _, s := range msa.summaries {
		all = append(all, s)
	}
	msa.mu.RUnlock()
	for _, s := range all {
		if err := msa.saveSummary(s); err != nil {
			t.Fatalf("saveSummary: %v", err)
		}
	}
}

// TestDecoderSummaryRoundTrip records decodes, flushes to the DB, and reads the
// summaries back through the DB-backed ReadAllSummaries, asserting the counts,
// period windows, and hourly breakdown survive the round trip.
func TestDecoderSummaryRoundTrip(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	msa, err := NewMetricsSummaryAggregator("", t.TempDir(), nil)
	if err != nil {
		t.Fatalf("NewMetricsSummaryAggregator: %v", err)
	}
	msa.SetDB(mgr.DB(), mgr.ReadDB())

	// Record two decodes in the same UTC day, one at hour 10 and one at hour 12.
	day := time.Date(2025, 3, 15, 10, 30, 0, 0, time.UTC)
	msa.RecordDecode("FT8", "20m", day)
	msa.RecordDecode("FT8", "20m", day.Add(2*time.Hour)) // 12:30

	msa.flushAllForTest(t)

	// Read the day summary back from the DB.
	got, err := msa.ReadAllSummaries("day", day)
	if err != nil {
		t.Fatalf("ReadAllSummaries: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 day summary, got %d", len(got))
	}
	s := got[0]
	if s.Mode != "FT8" || s.Band != "20m" || s.Period != "day" {
		t.Errorf("summary identity = %s/%s/%s", s.Mode, s.Band, s.Period)
	}
	if s.TotalSpots != 2 {
		t.Errorf("TotalSpots = %d, want 2", s.TotalSpots)
	}
	if len(s.HourlyBreakdown) != 24 {
		t.Fatalf("HourlyBreakdown len = %d, want 24", len(s.HourlyBreakdown))
	}
	if s.HourlyBreakdown[10].Spots != 1 || s.HourlyBreakdown[12].Spots != 1 {
		t.Errorf("hourly[10]=%d hourly[12]=%d, want 1/1",
			s.HourlyBreakdown[10].Spots, s.HourlyBreakdown[12].Spots)
	}

	// week / month / year summaries should also exist.
	for _, period := range []string{"week", "month", "year"} {
		ps, err := msa.ReadAllSummaries(period, day)
		if err != nil {
			t.Fatalf("ReadAllSummaries(%s): %v", period, err)
		}
		if len(ps) != 1 || ps[0].TotalSpots != 2 {
			t.Errorf("%s summary = %+v, want 1 summary with 2 spots", period, ps)
		}
	}

	// Upsert idempotency: record another decode, flush again, expect 3 total
	// (same row updated, not duplicated).
	msa.RecordDecode("FT8", "20m", day.Add(3*time.Hour))
	msa.flushAllForTest(t)
	got2, err := msa.ReadAllSummaries("day", day)
	if err != nil {
		t.Fatalf("ReadAllSummaries after upsert: %v", err)
	}
	if len(got2) != 1 {
		t.Fatalf("upsert produced %d rows, want 1", len(got2))
	}
	if got2[0].TotalSpots != 3 {
		t.Errorf("TotalSpots after upsert = %d, want 3", got2[0].TotalSpots)
	}
}

// TestCWSummaryRoundTrip mirrors the decoder test for the CW aggregator,
// additionally checking WPM aggregation survives the round trip.
func TestCWSummaryRoundTrip(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	msa, err := NewCWMetricsSummaryAggregator("", t.TempDir())
	if err != nil {
		t.Fatalf("NewCWMetricsSummaryAggregator: %v", err)
	}
	msa.SetDB(mgr.DB(), mgr.ReadDB())

	day := time.Date(2025, 4, 1, 8, 0, 0, 0, time.UTC)
	msa.RecordSpot("40m", "G0AAA", 25, day)
	msa.RecordSpot("40m", "K1BBB", 35, day.Add(time.Hour))

	msa.flushAllForTest(t)

	got, err := msa.ReadAllSummaries("day", day)
	if err != nil {
		t.Fatalf("ReadAllSummaries: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 day summary, got %d", len(got))
	}
	s := got[0]
	if s.Band != "40m" || s.Period != "day" {
		t.Errorf("summary identity = %s/%s", s.Band, s.Period)
	}
	if s.TotalSpots != 2 {
		t.Errorf("TotalSpots = %d, want 2", s.TotalSpots)
	}
	if s.MinWPM != 25 || s.MaxWPM != 35 {
		t.Errorf("WPM min/max = %d/%d, want 25/35", s.MinWPM, s.MaxWPM)
	}
	if s.AvgWPM != 30 {
		t.Errorf("AvgWPM = %v, want 30", s.AvgWPM)
	}
}

// TestSummaryPeriodKey checks the DB period_key derivation for each period.
func TestSummaryPeriodKey(t *testing.T) {
	ts := time.Date(2025, 1, 14, 9, 0, 0, 0, time.UTC) // ISO week 03 of 2025
	cases := map[string]string{
		"day":   "2025-01-14",
		"month": "2025-01",
		"year":  "2025",
	}
	for period, want := range cases {
		if got := summaryPeriodKey(period, ts); got != want {
			t.Errorf("summaryPeriodKey(%q) = %q, want %q", period, got, want)
		}
	}
	if got := summaryPeriodKey("week", ts); got != "2025-W03" {
		t.Errorf("summaryPeriodKey(week) = %q, want 2025-W03", got)
	}
}

// TestDBSizeStats verifies the SQLite page-accounting query returns sane values.
func TestDBSizeStats(t *testing.T) {
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	s, err := mgr.SizeStats()
	if err != nil {
		t.Fatalf("SizeStats: %v", err)
	}
	if s.PageSize <= 0 {
		t.Errorf("PageSize = %d, want > 0", s.PageSize)
	}
	if s.PageCount <= 0 {
		t.Errorf("PageCount = %d, want > 0", s.PageCount)
	}
	if s.TotalBytes != s.PageCount*s.PageSize {
		t.Errorf("TotalBytes = %d, want %d", s.TotalBytes, s.PageCount*s.PageSize)
	}
	if s.UsedBytes+s.FreeBytes != s.TotalBytes {
		t.Errorf("used(%d)+free(%d) != total(%d)", s.UsedBytes, s.FreeBytes, s.TotalBytes)
	}
	if s.Path == "" {
		t.Error("Path is empty")
	}
}
