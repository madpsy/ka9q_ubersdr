package main

import (
	"fmt"
	"testing"
	"time"
)

func TestGridCellConversions(t *testing.T) {
	for _, c := range []struct {
		loc       string
		precision int
		lat, lon  float64
	}{
		{"IO86", 4, 56.5, -3},   // Dalgety Bay's square
		{"io86ha", 4, 56.5, -3}, // longer and lower case: first four count
		{"FN42", 4, 42.5, -71},
		{"IO", 2, 55, -10},
		{"AA00", 4, -89.5, -179},
		{"RR99", 4, 89.5, 179},
	} {
		cell, ok := gridCellFromLocator(c.loc, c.precision)
		if !ok {
			t.Fatalf("%s: not parsed", c.loc)
		}
		lat, lon := cell.centre(c.precision)
		if lat != c.lat || lon != c.lon {
			t.Errorf("%s: centre %v,%v want %v,%v", c.loc, lat, lon, c.lat, c.lon)
		}
		back, ok := gridCellFromLatLon(lat, lon, c.precision)
		if !ok || back != cell {
			t.Errorf("%s: lat/lon round trip gave %+v, want %+v", c.loc, back, cell)
		}
		want := c.loc[:c.precision]
		if got := cell.locator(c.precision); got != fmt.Sprintf("%s", upper(want)) {
			t.Errorf("%s: locator %s want %s", c.loc, got, upper(want))
		}
	}
	for _, bad := range []string{"", "I", "ZZ99", "IOxx", "1234"} {
		if _, ok := gridCellFromLocator(bad, 4); ok {
			t.Errorf("%q parsed", bad)
		}
	}
	if _, ok := gridCellFromLatLon(91, 0, 4); ok {
		t.Error("latitude 91 accepted")
	}
	// The east and north edges fall in the last cell, not past it.
	if c, _ := gridCellFromLatLon(90, 180, 4); c.locator(4) != "RR99" {
		t.Errorf("90,180 -> %s, want RR99", c.locator(4))
	}
}

func upper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

type activityResult struct {
	TimeAxis struct {
		StartUTC    string `json:"start_utc"`
		StepMinutes int    `json:"step_minutes"`
		Steps       int    `json:"steps"`
	} `json:"time_axis"`
	Groups map[string]struct {
		Spots    []int  `json:"spots"`
		Stations []int  `json:"stations"`
		BestSNR  []*int `json:"best_snr"`
	} `json:"groups"`
	Totals map[string]map[string]int `json:"totals"`
	Cells  []struct {
		Grid     string   `json:"grid"`
		Lat      float64  `json:"lat"`
		Lon      float64  `json:"lon"`
		Spots    int      `json:"spots"`
		Stations int      `json:"stations"`
		BestSNR  *int     `json:"best_snr"`
		Bands    []string `json:"bands"`
	} `json:"cells"`
	Truncated bool `json:"truncated"`
}

func TestSpotActivityDecoder(t *testing.T) {
	sl := newTestSpotsLogger(t)
	now := time.Now().UTC()
	hourStart := now.Truncate(time.Hour).Add(-3 * time.Hour) // a whole hour, three hours back
	logSpot := func(call, loc string, freq uint64, mode string, snr int, at time.Time) {
		t.Helper()
		if err := sl.LogSpot(&DecodeInfo{Callsign: call, Locator: loc, SNR: snr, Frequency: freq, Mode: mode,
			BandName: "b", Timestamp: at}); err != nil {
			t.Fatal(err)
		}
	}
	// In one hour on 20m FT8: K1A twice, K2B once (three decodes, two stations).
	logSpot("K1A", "FN42", 14_074_100, "FT8", -10, hourStart.Add(5*time.Minute))
	logSpot("K1A", "FN42", 14_074_200, "FT8", -3, hourStart.Add(20*time.Minute))
	logSpot("K2B", "FN31", 14_074_300, "FT8", -15, hourStart.Add(40*time.Minute))
	// 40m FT4 from Europe, and a spot without a locator.
	logSpot("DL1C", "JO31", 7_047_500, "FT4", -8, hourStart.Add(10*time.Minute))
	logSpot("NOLOC", "", 7_047_600, "FT4", 0, hourStart.Add(11*time.Minute))
	// Outside a 2-hour window.
	logSpot("OLD", "FN42", 14_074_000, "FT8", 5, now.Add(-30*time.Hour))

	m := newTestMCPServer(t, nil, nil, nil)
	m.multiDecoder = &MultiDecoder{spotsLogger: sl}

	var r activityResult
	resultJSON(t, callTool(t, m, "get_spot_activity", "10.1.0.1", map[string]interface{}{
		"hours": 24, "step_minutes": 60,
	}), &r)
	if r.TimeAxis.StepMinutes != 60 || r.TimeAxis.Steps < 24 {
		t.Fatalf("time axis %+v", r.TimeAxis)
	}
	g20, ok := r.Groups["20m"]
	if !ok {
		t.Fatalf("no 20m group: %v", r.Groups)
	}
	start, _ := time.Parse(time.RFC3339, r.TimeAxis.StartUTC)
	i := int(hourStart.Sub(start) / time.Hour)
	if g20.Spots[i] != 3 || g20.Stations[i] != 2 || g20.BestSNR[i] == nil || *g20.BestSNR[i] != -3 {
		t.Errorf("20m in hour %d: spots %d stations %d best %v; want 3, 2, -3", i, g20.Spots[i], g20.Stations[i], g20.BestSNR[i])
	}
	if r.Totals["20m"]["spots"] != 3 || r.Totals["40m"]["stations"] != 2 {
		t.Errorf("totals %v", r.Totals)
	}

	// By mode, filtered to FT4.
	r = activityResult{}
	resultJSON(t, callTool(t, m, "get_spot_activity", "10.1.0.2", map[string]interface{}{
		"group_by": "mode", "mode": "ft4",
	}), &r)
	if len(r.Groups) != 1 || r.Totals["FT4"]["spots"] != 2 {
		t.Errorf("mode FT4: groups %v totals %v", r.Groups, r.Totals)
	}

	// Grid squares, busiest first; the spot with no locator is left out.
	r = activityResult{}
	resultJSON(t, callTool(t, m, "get_spot_activity", "10.1.0.3", map[string]interface{}{
		"group_by": "grid", "hours": 24,
	}), &r)
	if len(r.Cells) != 3 || r.Cells[0].Grid != "FN42" || r.Cells[0].Spots != 2 || r.Cells[0].Stations != 1 {
		t.Fatalf("cells %+v; want FN42 (2 spots, 1 station) first of 3", r.Cells)
	}
	if r.Cells[0].Lat != 42.5 || len(r.Cells[0].Bands) != 1 || r.Cells[0].Bands[0] != "20m" {
		t.Errorf("FN42 cell %+v", r.Cells[0])
	}
	r = activityResult{}
	resultJSON(t, callTool(t, m, "get_spot_activity", "10.1.0.4", map[string]interface{}{
		"group_by": "grid", "grid_precision": "field", "hours": 24, "max_items": 1,
	}), &r)
	if len(r.Cells) != 1 || r.Cells[0].Grid != "FN" || r.Cells[0].Spots != 3 || !r.Truncated {
		t.Errorf("field cells %+v truncated %v; want FN with 3 spots, truncated", r.Cells, r.Truncated)
	}

	// Validation and limits.
	wantToolError(t, callTool(t, m, "get_spot_activity", "10.1.0.5", map[string]interface{}{"source": "cw"}), "not enabled")
	wantToolError(t, callTool(t, m, "get_spot_activity", "10.1.0.6", map[string]interface{}{"step_minutes": 1, "hours": 48}), "at most")
	wantToolError(t, callTool(t, m, "get_spot_activity", "10.1.0.7", map[string]interface{}{"group_by": "country"}), "one of")
}

func TestSpotActivityCW(t *testing.T) {
	sl := newTestCWSpotsLogger(t)
	now := time.Now().UTC().Add(-time.Hour)
	for i, s := range []struct {
		call     string
		lat, lon float64
		band     string
	}{
		{"G3AAA", 56.4, -3.2, "20m"}, // IO86
		{"G3AAA", 56.4, -3.2, "40m"},
		{"G4BBB", 56.9, -2.1, "20m"}, // IO86 too
		{"JA1CCC", 35.7, 139.7, "20m"},
	} {
		sl.insertForTest(t, &CWSkimmerSpot{DXCall: s.call, Spotter: "SKIM", SNR: 10 + i, Frequency: 14_025_000, Mode: "CW",
			Time: now.Add(time.Duration(i) * time.Minute), Band: s.band, Latitude: s.lat, Longitude: s.lon})
	}
	m := newTestMCPServer(t, nil, nil, nil)
	m.CWSkimmer = &CWSkimmerClient{spotsLogger: sl}
	var r activityResult
	resultJSON(t, callTool(t, m, "get_spot_activity", "10.2.0.1", map[string]interface{}{
		"source": "cw", "group_by": "grid", "hours": 3,
	}), &r)
	if len(r.Cells) != 2 || r.Cells[0].Grid != "IO86" || r.Cells[0].Spots != 3 || r.Cells[0].Stations != 2 {
		t.Fatalf("CW cells %+v; want IO86 (3 spots, 2 stations) then the Tokyo square", r.Cells)
	}
	if fmt.Sprint(r.Cells[0].Bands) != "[20m 40m]" {
		t.Errorf("IO86 bands %v", r.Cells[0].Bands)
	}
	r = activityResult{}
	resultJSON(t, callTool(t, m, "get_spot_activity", "10.2.0.2", map[string]interface{}{"source": "cw", "hours": 3}), &r)
	if r.Totals["20m"]["spots"] != 3 || r.Totals["20m"]["stations"] != 3 {
		t.Errorf("CW totals %v", r.Totals)
	}
}

// The spot tools' new options: field selection, columns, absolute windows,
// limits that say when they cut.
func TestSpotToolsShapes(t *testing.T) {
	sl := newTestSpotsLogger(t)
	now := time.Now().UTC()
	for i := 0; i < 5; i++ {
		sl.LogSpot(&DecodeInfo{Callsign: fmt.Sprintf("K%dA", i), Locator: "FN42", SNR: -i, Frequency: 14_074_000,
			Mode: "FT8", BandName: "b", Timestamp: now.Add(-time.Duration(10+i) * time.Minute)})
	}
	m := newTestMCPServer(t, nil, nil, nil)
	m.multiDecoder = &MultiDecoder{spotsLogger: sl}

	var cols struct {
		Spots struct {
			Fields []string        `json:"fields"`
			Rows   [][]interface{} `json:"rows"`
		} `json:"spots"`
		Truncated bool `json:"truncated"`
		Count     int  `json:"count"`
	}
	resultJSON(t, callTool(t, m, "get_decoder_spots", "10.3.0.1", map[string]interface{}{
		"fields": []interface{}{"callsign", "snr"}, "format": "columns", "limit": 3,
	}), &cols)
	if fmt.Sprint(cols.Spots.Fields) != "[callsign snr]" || len(cols.Spots.Rows) != 3 || !cols.Truncated {
		t.Fatalf("columns %+v truncated %v", cols.Spots, cols.Truncated)
	}
	if cols.Spots.Rows[0][0] != "K0A" {
		t.Errorf("first row %v, want the newest, K0A", cols.Spots.Rows[0])
	}

	var objs struct {
		Spots []map[string]interface{} `json:"spots"`
		Count int                      `json:"count"`
	}
	resultJSON(t, callTool(t, m, "get_decoder_spots", "10.3.0.2", map[string]interface{}{
		"fields": "callsign", "from_utc": now.Add(-13 * time.Minute).Format(time.RFC3339),
		"to_utc": now.Add(-11 * time.Minute).Format(time.RFC3339), "min_snr": -2,
	}), &objs)
	// K1A (11 min, -1 dB) and K2A (12 min, -2 dB) are in the window and pass
	// the SNR filter; K3A (13 min) is at -3 dB.
	if objs.Count != 2 || len(objs.Spots[0]) != 1 || objs.Spots[0]["callsign"] != "K1A" || objs.Spots[1]["callsign"] != "K2A" {
		t.Errorf("window 13-11 min ago with min_snr -2: %v, want K1A then K2A, callsign only", objs.Spots)
	}
	wantToolError(t, callTool(t, m, "get_decoder_spots", "10.3.0.3", map[string]interface{}{"fields": []interface{}{"password"}}), "fields")
	wantToolError(t, callTool(t, m, "get_decoder_spots", "10.3.0.4", map[string]interface{}{"from_utc": now.Add(-72 * time.Hour).Format(time.RFC3339)}), "within the last 48 hours")
	wantToolError(t, callTool(t, m, "get_decoder_spots", "10.3.0.5", map[string]interface{}{
		"from_utc": now.Add(-time.Hour).Format(time.RFC3339), "to_utc": now.Add(-2 * time.Hour).Format(time.RFC3339)}), "window is empty")
}

func TestSpotToolsCollapseNone(t *testing.T) {
	sl := newTestSpotsLogger(t)
	now := time.Now().UTC()
	// The same station three times in an hour.
	for i := 0; i < 3; i++ {
		sl.LogSpot(&DecodeInfo{Callsign: "K1A", Locator: "FN42", SNR: -i, Frequency: 14_074_000,
			Mode: "FT8", BandName: "b", Timestamp: now.Add(-time.Duration(10+20*i) * time.Minute)})
	}
	m := newTestMCPServer(t, nil, nil, nil)
	m.multiDecoder = &MultiDecoder{spotsLogger: sl}
	var r struct {
		Count int                      `json:"count"`
		Spots []map[string]interface{} `json:"spots"`
	}
	resultJSON(t, callTool(t, m, "get_decoder_spots", "10.4.0.1", map[string]interface{}{"hours": 2}), &r)
	if r.Count != 1 || r.Spots[0]["seen_count"] != 3.0 {
		t.Errorf("collapsed: %v, want one row seen 3 times", r.Spots)
	}
	resultJSON(t, callTool(t, m, "get_decoder_spots", "10.4.0.2", map[string]interface{}{"hours": 2, "collapse": "none", "limit": 2}), &r)
	if r.Count != 2 || r.Spots[0]["snr"] != 0.0 || r.Spots[1]["snr"] != -1.0 {
		t.Errorf("collapse none, limit 2: %v, want the two newest decodes", r.Spots)
	}

	cw := newTestCWSpotsLogger(t)
	for i := 0; i < 3; i++ {
		cw.insertForTest(t, &CWSkimmerSpot{DXCall: "G3A", Spotter: "S", SNR: 10 + i, Frequency: 14_025_000, Mode: "CW",
			Time: now.Add(-time.Duration(10+20*i) * time.Minute), Band: "20m"})
	}
	m.CWSkimmer = &CWSkimmerClient{spotsLogger: cw}
	resultJSON(t, callTool(t, m, "get_cw_spots", "10.4.0.3", map[string]interface{}{"hours": 2}), &r)
	if r.Count != 1 || r.Spots[0]["seen_count"] != 3.0 {
		t.Errorf("CW collapsed: %v, want one row seen 3 times", r.Spots)
	}
	resultJSON(t, callTool(t, m, "get_cw_spots", "10.4.0.4", map[string]interface{}{"hours": 2, "collapse": "none"}), &r)
	if r.Count != 3 {
		t.Errorf("CW collapse none: %d spots, want 3", r.Count)
	}
}
