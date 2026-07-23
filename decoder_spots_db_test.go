package main

import (
	"testing"
	"time"
)

// newTestSpotsLogger builds a SpotsLogger backed by a real on-disk SQLite DB.
func newTestSpotsLogger(t *testing.T) *SpotsLogger {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	sl, err := NewSpotsLogger(t.TempDir(), true, 0)
	if err != nil {
		t.Fatalf("NewSpotsLogger: %v", err)
	}
	sl.SetDB(mgr.DB())
	sl.SetReadDB(mgr.ReadDB())
	return sl
}

func iptr(v int) *int { return &v }

// TestDecoderSpotsRoundTrip proves the write path and every migrated read
// function work against a real SQLite database with the production schema.
func TestDecoderSpotsRoundTrip(t *testing.T) {
	sl := newTestSpotsLogger(t)

	base := time.Date(2025, 4, 10, 14, 20, 0, 0, time.UTC)
	dist := 5000.0
	bearing := 90.0 // E
	// 14.074 MHz → 20m band (LogSpot computes band from frequency).
	decode := &DecodeInfo{
		Callsign:   "K1ABC",
		Locator:    "FN42",
		Country:    "United States",
		CQZone:     5,
		ITUZone:    8,
		Continent:  "NA",
		SNR:        -12,
		Frequency:  14074000,
		Timestamp:  base,
		Mode:       "FT8",
		Message:    "CQ K1ABC FN42",
		BandName:   "20m_FT8",
		DistanceKm: &dist,
		BearingDeg: &bearing,
	}
	if err := sl.LogSpot(decode); err != nil {
		t.Fatalf("LogSpot: %v", err)
	}

	day := base.Format("2006-01-02")

	// --- no filters ---
	spots, err := sl.GetHistoricalSpots("", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil {
		t.Fatalf("GetHistoricalSpots: %v", err)
	}
	if len(spots) != 1 {
		t.Fatalf("expected 1 spot, got %d", len(spots))
	}
	got := spots[0]
	if got.Callsign != "K1ABC" || got.Locator != "FN42" {
		t.Errorf("Callsign/Locator = %q/%q", got.Callsign, got.Locator)
	}
	if got.Frequency != 14074000 {
		t.Errorf("Frequency = %d, want 14074000", got.Frequency)
	}
	if got.Band != "20m" {
		t.Errorf("Band = %q, want 20m", got.Band)
	}
	if got.Mode != "FT8" {
		t.Errorf("Mode = %q, want FT8", got.Mode)
	}
	if got.Name != "20m_FT8" {
		t.Errorf("Name = %q, want 20m_FT8 (decoder_name)", got.Name)
	}
	if got.SNR != -12 || got.CQZone != 5 || got.ITUZone != 8 {
		t.Errorf("SNR/CQ/ITU = %d/%d/%d", got.SNR, got.CQZone, got.ITUZone)
	}
	if got.DistanceKm == nil || *got.DistanceKm != 5000.0 {
		t.Errorf("DistanceKm = %v, want 5000", got.DistanceKm)
	}
	if got.BearingDeg == nil || *got.BearingDeg != 90.0 {
		t.Errorf("BearingDeg = %v, want 90", got.BearingDeg)
	}
	if got.Timestamp != base.Format(time.RFC3339) {
		t.Errorf("Timestamp = %q, want %q", got.Timestamp, base.Format(time.RFC3339))
	}

	// --- filter dimensions ---
	check := func(label string, want int, mode, band, name, cs, loc, cont, dir, st, et string, locOnly bool, minDist float64, minSNR int) {
		t.Helper()
		s, err := sl.GetHistoricalSpots(mode, band, name, cs, loc, cont, dir, day, day, st, et, false, locOnly, minDist, minSNR)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if len(s) != want {
			t.Errorf("%s: expected %d, got %d", label, want, len(s))
		}
	}
	check("mode FT8", 1, "FT8", "", "", "", "", "", "", "", "", false, 0, -999)
	check("mode WSPR", 0, "WSPR", "", "", "", "", "", "", "", "", false, 0, -999)
	check("band 20m", 1, "", "20m", "", "", "", "", "", "", "", false, 0, -999)
	check("band 40m", 0, "", "40m", "", "", "", "", "", "", "", false, 0, -999)
	check("name 20m_FT8", 1, "", "", "20m_FT8", "", "", "", "", "", "", false, 0, -999)
	check("callsign K1ABC", 1, "", "", "", "K1ABC", "", "", "", "", "", false, 0, -999)
	check("callsign W9XYZ", 0, "", "", "", "W9XYZ", "", "", "", "", "", false, 0, -999)
	check("locator FN42", 1, "", "", "", "", "FN42", "", "", "", "", false, 0, -999)
	check("continent NA", 1, "", "", "", "", "", "NA", "", "", "", false, 0, -999)
	check("continent EU", 0, "", "", "", "", "", "EU", "", "", "", false, 0, -999)
	check("locatorsOnly", 1, "", "", "", "", "", "", "", "", "", true, 0, -999)
	check("minDist 4000", 1, "", "", "", "", "", "", "", "", "", false, 4000, -999)
	check("minDist 6000", 0, "", "", "", "", "", "", "", "", "", false, 6000, -999)
	check("minSNR -20", 1, "", "", "", "", "", "", "", "", "", false, 0, -20)
	check("minSNR 0", 0, "", "", "", "", "", "", "", "", "", false, 0, 0)
	check("direction E", 1, "", "", "", "", "", "", "E", "", "", false, 0, -999)
	check("direction W", 0, "", "", "", "", "", "", "W", "", "", false, 0, -999)
	check("time 14:00-15:00", 1, "", "", "", "", "", "", "", "14:00", "15:00", false, 0, -999)
	check("time 15:00-16:00", 0, "", "", "", "", "", "", "", "15:00", "16:00", false, 0, -999)

	// --- GetAvailableDates / GetAvailableNames ---
	dates, err := sl.GetAvailableDates()
	if err != nil {
		t.Fatalf("GetAvailableDates: %v", err)
	}
	if len(dates) != 1 || dates[0] != day {
		t.Errorf("dates = %v, want [%s]", dates, day)
	}
	names, err := sl.GetAvailableNames()
	if err != nil {
		t.Fatalf("GetAvailableNames: %v", err)
	}
	if len(names) != 1 || names[0] != "20m_FT8" {
		t.Errorf("names = %v, want [20m_FT8]", names)
	}

	// --- GetHistoricalCSV ---
	csv, err := sl.GetHistoricalCSV("", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil {
		t.Fatalf("GetHistoricalCSV: %v", err)
	}
	if csv == "" {
		t.Error("CSV output empty")
	}
}

// TestDecoderSpotsDedup verifies deduplication keeps the latest timestamp per
// (callsign, locator, band, mode, day).
func TestDecoderSpotsDedup(t *testing.T) {
	sl := newTestSpotsLogger(t)

	day := "2025-05-01"
	mk := func(hour, min, snr int) *DecodeInfo {
		return &DecodeInfo{
			Callsign:  "G0AAA",
			Locator:   "IO91",
			Country:   "England",
			Continent: "EU",
			SNR:       snr,
			Frequency: 14074000, // 20m
			Timestamp: time.Date(2025, 5, 1, hour, min, 0, 0, time.UTC),
			Mode:      "FT8",
			Message:   "CQ",
			BandName:  "20m_FT8",
		}
	}
	// Three spots of the same callsign/locator/band/mode on the same day.
	if err := sl.LogSpot(mk(10, 0, -15)); err != nil {
		t.Fatal(err)
	}
	if err := sl.LogSpot(mk(12, 30, -8)); err != nil { // latest
		t.Fatal(err)
	}
	if err := sl.LogSpot(mk(11, 0, -20)); err != nil {
		t.Fatal(err)
	}

	// Without dedup: all 3.
	all, err := sl.GetHistoricalSpots("", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("no-dedup expected 3, got %d", len(all))
	}

	// With dedup: 1, and it must be the latest (12:30).
	deduped, err := sl.GetHistoricalSpots("", "", "", "", "", "", "", day, day, "", "", true, false, 0, -999)
	if err != nil {
		t.Fatal(err)
	}
	if len(deduped) != 1 {
		t.Fatalf("dedup expected 1, got %d", len(deduped))
	}
	want := time.Date(2025, 5, 1, 12, 30, 0, 0, time.UTC).Format(time.RFC3339)
	if deduped[0].Timestamp != want {
		t.Errorf("dedup kept %q, want latest %q", deduped[0].Timestamp, want)
	}
}

// TestDecoderSpotsWSPRDbmAndNulls verifies WSPR dbm round-trips and NULL
// distance/bearing/dbm scan back as nil pointers.
func TestDecoderSpotsWSPRDbmAndNulls(t *testing.T) {
	sl := newTestSpotsLogger(t)

	base := time.Date(2025, 6, 15, 3, 0, 0, 0, time.UTC)
	// WSPR spot with dbm set, no distance/bearing.
	wspr := &DecodeInfo{
		Callsign:  "VK2AAA",
		Locator:   "QF56",
		Country:   "Australia",
		Continent: "OC",
		SNR:       -25,
		Frequency: 14097000, // 20m WSPR
		Timestamp: base,
		Mode:      "WSPR",
		Message:   "VK2AAA QF56 30",
		BandName:  "20m_WSPR",
		IsWSPR:    true,
		DBm:       30,
	}
	if err := sl.LogSpot(wspr); err != nil {
		t.Fatalf("LogSpot: %v", err)
	}

	day := base.Format("2006-01-02")
	spots, err := sl.GetHistoricalSpots("WSPR", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil {
		t.Fatalf("GetHistoricalSpots: %v", err)
	}
	if len(spots) != 1 {
		t.Fatalf("expected 1 spot, got %d", len(spots))
	}
	got := spots[0]
	if got.DBm == nil || *got.DBm != 30 {
		t.Errorf("DBm = %v, want 30", got.DBm)
	}
	if got.DistanceKm != nil {
		t.Errorf("DistanceKm = %v, want nil", got.DistanceKm)
	}
	if got.BearingDeg != nil {
		t.Errorf("BearingDeg = %v, want nil", got.BearingDeg)
	}

	// A non-WSPR FT8 spot must have NULL dbm → nil pointer.
	ft8 := &DecodeInfo{
		Callsign:  "JA1AAA",
		Locator:   "PM95",
		Continent: "AS",
		SNR:       -5,
		Frequency: 7074000, // 40m
		Timestamp: base.Add(time.Minute),
		Mode:      "FT8",
		BandName:  "40m_FT8",
		IsWSPR:    false,
	}
	if err := sl.LogSpot(ft8); err != nil {
		t.Fatal(err)
	}
	ft8spots, err := sl.GetHistoricalSpots("FT8", "", "", "", "", "", "", day, day, "", "", false, false, 0, -999)
	if err != nil {
		t.Fatal(err)
	}
	if len(ft8spots) != 1 {
		t.Fatalf("expected 1 FT8 spot, got %d", len(ft8spots))
	}
	if ft8spots[0].DBm != nil {
		t.Errorf("FT8 DBm = %v, want nil", ft8spots[0].DBm)
	}
	_ = iptr // reserved for future NULL-int assertions
}
