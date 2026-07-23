package main

import (
	"testing"
	"time"
)

// newTestCWSpotsLogger builds a CWSkimmerSpotsLogger backed by a real on-disk
// SQLite DB in a temp dir, with the async log worker running.
func newTestCWSpotsLogger(t *testing.T) *CWSkimmerSpotsLogger {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	sl, err := NewCWSkimmerSpotsLogger(t.TempDir(), true)
	if err != nil {
		t.Fatalf("NewCWSkimmerSpotsLogger: %v", err)
	}
	sl.SetDB(mgr.DB())
	sl.SetReadDB(mgr.ReadDB())
	t.Cleanup(func() { _ = sl.Close() })
	return sl
}

// insertCWSpot writes a spot synchronously (bypassing the async channel so the
// test does not race the worker) and returns nothing.
func (sl *CWSkimmerSpotsLogger) insertForTest(t *testing.T, spot *CWSkimmerSpot) {
	t.Helper()
	if err := sl.writeSpot(spot); err != nil {
		t.Fatalf("writeSpot: %v", err)
	}
}

func fptr(v float64) *float64 { return &v }

// TestCWSpotsRoundTrip proves the write path and every migrated read function
// work against a real SQLite database with the production schema. In
// particular it guards against the REAL→uint64 frequency scan bug.
func TestCWSpotsRoundTrip(t *testing.T) {
	sl := newTestCWSpotsLogger(t)

	base := time.Date(2025, 3, 15, 12, 30, 0, 0, time.UTC)
	spot := &CWSkimmerSpot{
		Frequency:   14025000, // 14.025 MHz in Hz — stored as REAL
		DXCall:      "G3ABC",
		Spotter:     "W1XYZ",
		SNR:         21,
		WPM:         28,
		Mode:        "CW",
		Comment:     "CQ",
		Time:        base,
		Band:        "20m",
		Country:     "England",
		CountryCode: "GB",
		CQZone:      14,
		ITUZone:     27,
		Continent:   "EU",
		Latitude:    52.5,
		Longitude:   -1.5,
		DistanceKm:  fptr(1200.0),
		BearingDeg:  fptr(45.0), // NE
	}
	sl.insertForTest(t, spot)

	day := base.Format("2006-01-02")

	// --- GetCWHistoricalSpots: no filters ---
	spots, err := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 0, -999, nil)
	if err != nil {
		t.Fatalf("GetCWHistoricalSpots: %v", err)
	}
	if len(spots) != 1 {
		t.Fatalf("expected 1 spot, got %d", len(spots))
	}
	got := spots[0]
	if got.Callsign != "G3ABC" {
		t.Errorf("Callsign = %q, want G3ABC", got.Callsign)
	}
	if got.Frequency != 14025000 {
		t.Errorf("Frequency = %d, want 14025000 (REAL→uint64 scan)", got.Frequency)
	}
	if got.SNR != 21 || got.WPM != 28 {
		t.Errorf("SNR/WPM = %d/%d, want 21/28", got.SNR, got.WPM)
	}
	if got.Band != "20m" || got.Name != "20m" {
		t.Errorf("Band/Name = %q/%q, want 20m/20m", got.Band, got.Name)
	}
	if got.Country != "England" || got.Continent != "EU" {
		t.Errorf("Country/Continent = %q/%q", got.Country, got.Continent)
	}
	if got.CQZone != 14 || got.ITUZone != 27 {
		t.Errorf("CQ/ITU zone = %d/%d, want 14/27", got.CQZone, got.ITUZone)
	}
	if got.Latitude == nil || *got.Latitude != 52.5 {
		t.Errorf("Latitude = %v, want 52.5", got.Latitude)
	}
	if got.Longitude == nil || *got.Longitude != -1.5 {
		t.Errorf("Longitude = %v, want -1.5", got.Longitude)
	}
	if got.DistanceKm == nil || *got.DistanceKm != 1200.0 {
		t.Errorf("DistanceKm = %v, want 1200", got.DistanceKm)
	}
	if got.BearingDeg == nil || *got.BearingDeg != 45.0 {
		t.Errorf("BearingDeg = %v, want 45", got.BearingDeg)
	}
	wantTS := base.Format(time.RFC3339)
	if got.Timestamp != wantTS {
		t.Errorf("Timestamp = %q, want %q", got.Timestamp, wantTS)
	}

	// --- band filter (match / no match) ---
	if s, _ := sl.GetCWHistoricalSpots("20m", "", nil, "", "", day, day, "", "", 0, -999, nil); len(s) != 1 {
		t.Errorf("band=20m expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("40m", "", nil, "", "", day, day, "", "", 0, -999, nil); len(s) != 0 {
		t.Errorf("band=40m expected 0, got %d", len(s))
	}

	// --- name filter (maps to band) ---
	if s, _ := sl.GetCWHistoricalSpots("", "20m", nil, "", "", day, day, "", "", 0, -999, nil); len(s) != 1 {
		t.Errorf("name=20m expected 1, got %d", len(s))
	}

	// --- callsign set filter ---
	if s, _ := sl.GetCWHistoricalSpots("", "", map[string]bool{"G3ABC": true}, "", "", day, day, "", "", 0, -999, nil); len(s) != 1 {
		t.Errorf("callsign G3ABC expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("", "", map[string]bool{"K1AA": true}, "", "", day, day, "", "", 0, -999, nil); len(s) != 0 {
		t.Errorf("callsign K1AA expected 0, got %d", len(s))
	}

	// --- continent filter ---
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "EU", "", day, day, "", "", 0, -999, nil); len(s) != 1 {
		t.Errorf("continent EU expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "NA", "", day, day, "", "", 0, -999, nil); len(s) != 0 {
		t.Errorf("continent NA expected 0, got %d", len(s))
	}

	// --- minDistanceKm filter ---
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 1000, -999, nil); len(s) != 1 {
		t.Errorf("minDist 1000 expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 2000, -999, nil); len(s) != 0 {
		t.Errorf("minDist 2000 expected 0, got %d", len(s))
	}

	// --- minSNR filter ---
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 0, 10, nil); len(s) != 1 {
		t.Errorf("minSNR 10 expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 0, 30, nil); len(s) != 0 {
		t.Errorf("minSNR 30 expected 0, got %d", len(s))
	}

	// --- direction filter (bearing 45 = NE) ---
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "NE", day, day, "", "", 0, -999, nil); len(s) != 1 {
		t.Errorf("direction NE expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "SW", day, day, "", "", 0, -999, nil); len(s) != 0 {
		t.Errorf("direction SW expected 0, got %d", len(s))
	}

	// --- time-of-day filter (spot at 12:30 UTC) ---
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "12:00", "13:00", 0, -999, nil); len(s) != 1 {
		t.Errorf("time 12:00-13:00 expected 1, got %d", len(s))
	}
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "13:00", "14:00", 0, -999, nil); len(s) != 0 {
		t.Errorf("time 13:00-14:00 expected 0, got %d", len(s))
	}

	// --- GetCWAvailableDates ---
	dates, err := sl.GetCWAvailableDates()
	if err != nil {
		t.Fatalf("GetCWAvailableDates: %v", err)
	}
	if len(dates) != 1 || dates[0] != day {
		t.Errorf("dates = %v, want [%s]", dates, day)
	}

	// --- GetCWAvailableNames (bands) ---
	names, err := sl.GetCWAvailableNames()
	if err != nil {
		t.Fatalf("GetCWAvailableNames: %v", err)
	}
	if len(names) != 1 || names[0] != "20m" {
		t.Errorf("names = %v, want [20m]", names)
	}

	// --- GetCWHistoricalCSV (rides on GetCWHistoricalSpots) ---
	csv, err := sl.GetCWHistoricalCSV("", "", nil, "", "", day, day, "", "", 0, -999, nil)
	if err != nil {
		t.Fatalf("GetCWHistoricalCSV: %v", err)
	}
	if csv == "" {
		t.Error("CSV output is empty")
	}
}

// TestCWSpotsNullableColumns verifies that NULL distance/bearing/lat/lon scan
// back as nil pointers rather than erroring.
func TestCWSpotsNullableColumns(t *testing.T) {
	sl := newTestCWSpotsLogger(t)

	base := time.Date(2025, 6, 1, 8, 0, 0, 0, time.UTC)
	spot := &CWSkimmerSpot{
		Frequency:  7005000,
		DXCall:     "K1AA",
		SNR:        5,
		WPM:        20,
		Mode:       "CW",
		Time:       base,
		Band:       "40m",
		Country:    "United States",
		Continent:  "NA",
		DistanceKm: nil, // NULL
		BearingDeg: nil, // NULL
	}
	sl.insertForTest(t, spot)

	day := base.Format("2006-01-02")
	spots, err := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 0, -999, nil)
	if err != nil {
		t.Fatalf("GetCWHistoricalSpots: %v", err)
	}
	if len(spots) != 1 {
		t.Fatalf("expected 1 spot, got %d", len(spots))
	}
	if spots[0].DistanceKm != nil {
		t.Errorf("DistanceKm = %v, want nil", spots[0].DistanceKm)
	}
	if spots[0].BearingDeg != nil {
		t.Errorf("BearingDeg = %v, want nil", spots[0].BearingDeg)
	}

	// A distance filter must exclude rows with NULL distance.
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "", day, day, "", "", 100, -999, nil); len(s) != 0 {
		t.Errorf("minDist with NULL distance expected 0, got %d", len(s))
	}
	// A direction filter must exclude rows with NULL bearing.
	if s, _ := sl.GetCWHistoricalSpots("", "", nil, "", "N", day, day, "", "", 0, -999, nil); len(s) != 0 {
		t.Errorf("direction with NULL bearing expected 0, got %d", len(s))
	}
}
