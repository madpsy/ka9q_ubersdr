package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// newTrendsServer is an MCP server whose noise floor database holds the last
// three hours, one row a minute for 20m and 40m: occupancy is 20 or 40, the
// wideband SNR fields 30 and 21, and dynamic_range the minute's index within
// its 10-minute step, so a 10-minute average is 4.5.
func newTrendsServer(t *testing.T) (*MCPServer, time.Time) {
	t.Helper()
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mgr.Close() })
	now := time.Now().UTC()
	start := now.Add(-3 * time.Hour).Truncate(10 * time.Minute)
	tx, err := mgr.DB().Begin()
	if err != nil {
		t.Fatal(err)
	}
	for ts := start; !ts.After(now); ts = ts.Add(time.Minute) {
		for _, b := range []struct {
			name string
			occ  float64
		}{{"20m", 20}, {"40m", 40}} {
			dr := float64(ts.Minute() % 10)
			if _, err := tx.Exec(`INSERT INTO noise_floor (ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db,
				dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				ts.Unix(), b.name, -125, -90, -115, -116, -120, -119, -100, dr, b.occ, 6, 30, 21); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	// Registration needs a configured monitor, so the server is built without
	// one and the database-backed monitor attached afterwards.
	m := newTestMCPServer(t, nil, nil, nil)
	nfm := &NoiseFloorMonitor{}
	nfm.SetReadDB(mgr.ReadDB())
	m.noiseFloorMonitor = nfm
	return m, now
}

type trendColumns struct {
	TimeAxis struct {
		StartUTC    string `json:"start_utc"`
		StepMinutes int    `json:"step_minutes"`
		Steps       int    `json:"steps"`
	} `json:"time_axis"`
	Fields []string                         `json:"fields"`
	Bands  map[string]map[string][]*float64 `json:"bands"`
}

func TestNoiseFloorTrendsDefaultShapeUnchanged(t *testing.T) {
	m, _ := newTrendsServer(t)
	res := callTool(t, m, "get_noise_floor_trends", "127.0.0.1", nil)
	text := resultText(t, res)
	if strings.Contains(text, "\n  ") {
		t.Error("the default result is still indented")
	}
	var all map[string][]BandMeasurement
	if err := json.Unmarshal([]byte(text), &all); err != nil {
		t.Fatalf("default shape changed: %v", err)
	}
	if len(all) != 2 || len(all["20m"]) < 18 {
		t.Fatalf("bands %d, 20m rows %d: want 2 bands of three hours", len(all), len(all["20m"]))
	}
	row := all["20m"][0]
	if row.OccupancyPct != 20 || row.DynamicRange != 4.5 || row.Timestamp.Location() != time.UTC {
		t.Errorf("first row %+v: want occupancy 20, dynamic range 4.5, UTC", row)
	}
	// Averaging used to drop these two, so they always read 0.
	if row.SNR_0_30MHz != 30 || row.SNR_1_8_30MHz != 21 {
		t.Errorf("wideband SNR %v / %v, want 30 / 21", row.SNR_0_30MHz, row.SNR_1_8_30MHz)
	}

	// One band keeps its own original shape, a plain list of rows.
	var one []BandMeasurement
	resultJSON(t, callTool(t, m, "get_noise_floor_trends", "127.0.0.1", map[string]interface{}{"band": "40m"}), &one)
	if len(one) < 18 || one[0].Band != "40m" {
		t.Errorf("band=40m: %d rows of %q", len(one), one[0].Band)
	}
}

func TestNoiseFloorTrendsColumns(t *testing.T) {
	m, now := newTrendsServer(t)
	var c trendColumns
	resultJSON(t, callTool(t, m, "get_noise_floor_trends", "127.0.0.1", map[string]interface{}{
		"bands": []interface{}{"20m"}, "fields": []interface{}{"occupancy_pct", "dynamic_range"}, "hours": 2,
	}), &c)
	if len(c.Bands) != 1 || c.Bands["20m"] == nil {
		t.Fatalf("bands %v, want only 20m", c.Bands)
	}
	if len(c.Fields) != 2 || len(c.Bands["20m"]) != 2 {
		t.Errorf("fields %v / %v, want occupancy_pct and dynamic_range only", c.Fields, c.Bands["20m"])
	}
	if c.TimeAxis.StepMinutes != 10 || c.TimeAxis.Steps < 12 || c.TimeAxis.Steps > 14 {
		t.Errorf("time axis %+v, want about 13 ten-minute steps for 2 hours", c.TimeAxis)
	}
	occ := c.Bands["20m"]["occupancy_pct"]
	if len(occ) != c.TimeAxis.Steps || occ[0] == nil || *occ[0] != 20 {
		t.Errorf("occupancy %v, want %d steps of 20", occ, c.TimeAxis.Steps)
	}

	// Hourly steps average six of the 10-minute ones.
	resultJSON(t, callTool(t, m, "get_noise_floor_trends", "127.0.0.1", map[string]interface{}{
		"bands": "20m, 40m", "fields": "dynamic_range", "step_minutes": 60,
	}), &c)
	if c.TimeAxis.StepMinutes != 60 || len(c.Bands) != 2 {
		t.Fatalf("hourly: %+v with %d bands", c.TimeAxis, len(c.Bands))
	}
	full := c.Bands["40m"]["dynamic_range"][c.TimeAxis.Steps-3] // a complete hour
	if full == nil || *full != 4.5 {
		t.Errorf("hourly dynamic range %v, want 4.5", full)
	}

	// since: only the step holding it and what follows.
	since := now.Add(-15 * time.Minute)
	resultJSON(t, callTool(t, m, "get_noise_floor_trends", "127.0.0.1", map[string]interface{}{
		"fields": []interface{}{"occupancy_pct"}, "since": since.Format(time.RFC3339),
	}), &c)
	wantStart := time.Unix(since.Unix()-since.Unix()%600, 0).UTC().Format(time.RFC3339)
	if c.TimeAxis.StartUTC != wantStart || c.TimeAxis.Steps < 2 || c.TimeAxis.Steps > 3 {
		t.Errorf("since %s: axis %+v, want 2-3 steps from %s", since.Format(time.RFC3339), c.TimeAxis, wantStart)
	}

	// Rows on request.
	var rows struct {
		Bands map[string][]map[string]interface{} `json:"bands"`
	}
	resultJSON(t, callTool(t, m, "get_noise_floor_trends", "127.0.0.1", map[string]interface{}{
		"bands": []interface{}{"40m"}, "fields": []interface{}{"ft8_snr"}, "format": "rows",
	}), &rows)
	if r := rows.Bands["40m"]; len(r) < 18 || r[0]["ft8_snr"] != 6.0 || len(r[0]) != 2 {
		t.Errorf("rows %v, want timestamp and ft8_snr only", r[:1])
	}

	// Nothing new since a moment ago is an empty answer, not an error.
	res := callTool(t, m, "get_noise_floor_trends", "127.0.0.1", map[string]interface{}{"bands": []interface{}{"10m"}, "since": now.Format(time.RFC3339)})
	if res.IsError {
		t.Errorf("an empty incremental fetch failed: %s", resultText(t, res))
	}
}

func TestNoiseFloorTrendsValidation(t *testing.T) {
	m, now := newTrendsServer(t)
	for _, c := range []struct {
		args map[string]interface{}
		want string
	}{
		{map[string]interface{}{"step_minutes": 15}, "multiple of 10"},
		{map[string]interface{}{"step_minutes": 5}, "between 10 and 1440"},
		{map[string]interface{}{"fields": []interface{}{"loudness"}}, "loudness"},
		{map[string]interface{}{"fields": "p5_db, nope"}, "nope"},
		{map[string]interface{}{"bands": []interface{}{"20m; drop"}}, "a name such as 20m"},
		{map[string]interface{}{"bands": "20m,40m; drop"}, "wrong format"},
		{map[string]interface{}{"band": "20m", "bands": []interface{}{"40m"}}, "not both"},
		{map[string]interface{}{"since": "yesterday"}, "RFC 3339"},
		{map[string]interface{}{"since": now.Add(time.Hour).Format(time.RFC3339)}, "future"},
		{map[string]interface{}{"hours": 25}, "between 1 and 24"},
		{map[string]interface{}{"format": "csv"}, "one of columns, rows"},
	} {
		wantToolError(t, callTool(t, m, "get_noise_floor_trends", "127.0.0.1", c.args), c.want)
	}
}

func TestSpotToolsSince(t *testing.T) {
	now := time.Now().UTC()

	// CW skimmer
	cw := newTestCWSpotsLogger(t)
	for i, call := range []string{"G3AAA", "G3BBB", "G3CCC"} {
		cw.insertForTest(t, &CWSkimmerSpot{Frequency: 14_025_000, DXCall: call, Spotter: "SKIM", SNR: 20, WPM: 25, Mode: "CW",
			Time: now.Add(-time.Duration(30-10*i) * time.Minute), Band: "20m", Country: "England", CountryCode: "GB", Continent: "EU"})
	}
	m := newTestMCPServer(t, nil, nil, nil)
	m.CWSkimmer = &CWSkimmerClient{spotsLogger: cw}
	var got struct {
		Count    int            `json:"count"`
		UntilUTC string         `json:"until_utc"`
		Spots    []CWSpotRecord `json:"spots"`
	}
	resultJSON(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"since": now.Add(-15 * time.Minute).Format(time.RFC3339)}), &got)
	if got.Count != 1 || got.Spots[0].Callsign != "G3CCC" || got.UntilUTC == "" {
		t.Errorf("since 15 min ago: %+v until %q, want only G3CCC and an until_utc", got.Spots, got.UntilUTC)
	}
	// since never widens the window past hours.
	resultJSON(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"hours": 1, "since": now.Add(-48 * time.Hour).Format(time.RFC3339)}), &got)
	if got.Count != 3 {
		t.Errorf("since before the window: %d spots, want the window's 3", got.Count)
	}
	wantToolError(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"since": "soon"}), "RFC 3339")

	// Decoder: hours is the last N hours, and since narrows it.
	sl := newTestSpotsLogger(t)
	for i, call := range []string{"K1OLD", "K2MID", "K3NEW"} {
		age := []time.Duration{3 * time.Hour, 40 * time.Minute, 5 * time.Minute}[i]
		if err := sl.LogSpot(&DecodeInfo{
			Callsign: call, Locator: "FN42", Country: "United States", CountryCode: "US", Continent: "NA",
			SNR: -10, Frequency: 14_074_000 + uint64(i)*100, Mode: "FT8", BandName: "20m_FT8", Timestamp: now.Add(-age),
		}); err != nil {
			t.Fatal(err)
		}
	}
	m.multiDecoder = &MultiDecoder{spotsLogger: sl}
	var dec struct {
		Count int          `json:"count"`
		Spots []SpotRecord `json:"spots"`
	}
	resultJSON(t, callTool(t, m, "get_decoder_spots", "127.0.0.1", map[string]interface{}{"hours": 1}), &dec)
	if dec.Count != 2 {
		t.Errorf("hours=1: %d spots %+v, want K2MID and K3NEW only (K1OLD is 3 hours old)", dec.Count, dec.Spots)
	}
	resultJSON(t, callTool(t, m, "get_decoder_spots", "127.0.0.1", map[string]interface{}{"hours": 1, "since": now.Add(-10 * time.Minute).Format(time.RFC3339)}), &dec)
	if dec.Count != 1 || dec.Spots[0].Callsign != "K3NEW" {
		t.Errorf("since 10 min ago: %+v, want K3NEW", dec.Spots)
	}
}
