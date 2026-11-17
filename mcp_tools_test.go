package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// ── CW skimmer ──────────────────────────────────────────────────────────────

func TestGetCWSpots(t *testing.T) {
	sl := newTestCWSpotsLogger(t)
	now := time.Now().UTC()
	for _, s := range []*CWSkimmerSpot{
		{Frequency: 14_025_000, DXCall: "G3ABC", Spotter: "SKIM", SNR: 21, WPM: 28, Mode: "CW", Time: now.Add(-20 * time.Minute), Band: "20m", Country: "England", CountryCode: "GB", Continent: "EU"},
		{Frequency: 7_012_000, DXCall: "JA1XYZ", Spotter: "SKIM", SNR: 9, WPM: 22, Mode: "CW", Time: now.Add(-10 * time.Minute), Band: "40m", Country: "Japan", CountryCode: "JP", Continent: "AS"},
		{Frequency: 14_030_000, DXCall: "W1AW", Spotter: "SKIM", SNR: 15, WPM: 25, Mode: "CW", Time: now.Add(-3 * time.Hour), Band: "20m", Country: "United States", CountryCode: "US", Continent: "NA"},
	} {
		sl.insertForTest(t, s)
	}

	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_cw_spots", "127.0.0.1", nil), "not enabled")
	m.CWSkimmer = &CWSkimmerClient{spotsLogger: sl}

	type spotsResult struct {
		Count     int            `json:"count"`
		Truncated bool           `json:"truncated"`
		Spots     []CWSpotRecord `json:"spots"`
	}
	var got spotsResult
	resultJSON(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"hours": 1}), &got)
	if got.Count != 2 || got.Spots[0].Callsign != "JA1XYZ" || got.Spots[1].Callsign != "G3ABC" {
		t.Errorf("last hour: %+v, want JA1XYZ then G3ABC (newest first, W1AW too old)", got.Spots)
	}

	resultJSON(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"hours": 4, "band": "20m"}), &got)
	if got.Count != 2 {
		t.Errorf("20m over 4 hours: %d spots, want 2", got.Count)
	}

	resultJSON(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"hours": 4, "callsign": "w1aw, nobody"}), &got)
	if got.Count != 1 || got.Spots[0].Callsign != "W1AW" {
		t.Errorf("callsign filter: %+v, want W1AW", got.Spots)
	}

	resultJSON(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"hours": 4, "limit": 1}), &got)
	if got.Count != 1 || !got.Truncated || got.Spots[0].Callsign != "JA1XYZ" {
		t.Errorf("limit 1: %+v truncated=%v, want the newest spot and truncated", got.Spots, got.Truncated)
	}

	many := make([]string, 21)
	for i := range many {
		many[i] = fmt.Sprintf("K%dABC", i)
	}
	wantToolError(t, callTool(t, m, "get_cw_spots", "127.0.0.1", map[string]interface{}{"callsign": strings.Join(many, ",")}), "20 callsigns")

	var analytics map[string]interface{}
	resultJSON(t, callTool(t, m, "get_cw_analytics", "127.0.0.1", map[string]interface{}{"hours": 4}), &analytics)
	if _, ok := analytics["by_country"]; !ok {
		t.Errorf("analytics has no by_country: %v", analytics)
	}
	resultJSON(t, callTool(t, m, "get_cw_analytics", "127.0.0.2", map[string]interface{}{"hours": 4, "hourly": true}), &analytics)
	if len(analytics) == 0 {
		t.Error("hourly analytics is empty")
	}
}

// ── DX cluster ──────────────────────────────────────────────────────────────

func testDXCluster(now time.Time) *DXClusterClient {
	return &DXClusterClient{spotBuffer: []DXSpot{
		{Frequency: 14_195_000, DXCall: "3Y0J", Spotter: "G4ABC", Comment: "up 5", Time: now.Add(-5 * time.Minute), Band: "20m", Country: "Bouvet", Continent: "AF", Raw: "DX de G4ABC: ..."},
		{Frequency: 7_074_000, DXCall: "VK2XX", Spotter: "JA1AA", Comment: "FT8", Time: now.Add(-50 * time.Minute), Band: "40m", Country: "Australia", Continent: "OC"},
		{Frequency: 9_411_000, DXCall: "VK3YY", Spotter: "ZL1AA", Comment: "", Time: now.Add(-2 * time.Minute), Band: "other", Country: "Australia", Continent: "OC"},
		{Frequency: 14_074_000, DXCall: "K1OLD", Spotter: "W1AA", Comment: "", Time: now.Add(-3 * time.Hour), Band: "20m", Continent: "NA"},
	}}
}

func TestFilterDXSpots(t *testing.T) {
	now := time.Now()
	spots := testDXCluster(now).GetBufferedSpots()

	got := filterDXSpots(spots, now.Add(-time.Hour), "", "", "")
	if len(got) != 3 || got[0].DXCall != "VK3YY" || got[2].DXCall != "VK2XX" {
		t.Errorf("last hour: %+v, want 3 spots newest first", got)
	}
	if got[1].FrequencyKHz != 14195 {
		t.Errorf("frequency_khz %v, want 14195", got[1].FrequencyKHz)
	}
	if got := filterDXSpots(spots, now.Add(-time.Hour), "20M", "", ""); len(got) != 1 || got[0].DXCall != "3Y0J" {
		t.Errorf("band 20M: %+v", got)
	}
	if got := filterDXSpots(spots, now.Add(-time.Hour), "", "vk", ""); len(got) != 2 {
		t.Errorf("callsign vk: %+v, want both VK stations", got)
	}
	if got := filterDXSpots(spots, now.Add(-time.Hour), "", "", "oc"); len(got) != 2 {
		t.Errorf("continent oc: %+v", got)
	}

	// The raw cluster line repeats the parsed fields, so it is not returned.
	data, _ := json.Marshal(got)
	if strings.Contains(string(data), "DX de") {
		t.Error("raw cluster lines leak into the result")
	}
}

func TestGetDXClusterSpotsTool(t *testing.T) {
	cfg := &Config{}
	m := newTestMCPServer(t, cfg, nil, nil)
	wantToolError(t, callTool(t, m, "get_dx_cluster_spots", "127.0.0.1", nil), "not enabled")

	cfg.DXCluster.Enabled = true
	m.DXCluster = testDXCluster(time.Now())
	var got struct {
		Count int         `json:"count"`
		Spots []mcpDXSpot `json:"spots"`
	}
	resultJSON(t, callTool(t, m, "get_dx_cluster_spots", "127.0.0.1", map[string]interface{}{"minutes": 10}), &got)
	if got.Count != 2 {
		t.Errorf("last 10 minutes: %d spots, want 2", got.Count)
	}
	resultJSON(t, callTool(t, m, "get_dx_cluster_spots", "127.0.0.1", map[string]interface{}{"minutes": 100000}), &got)
	if got.Count != 4 {
		t.Errorf("minutes beyond the max is clamped to a day: %d spots, want all 4", got.Count)
	}
}

// ── Voice activity ──────────────────────────────────────────────────────────

func TestToMCPVoiceSignals(t *testing.T) {
	got := toMCPVoiceSignals([]VoiceActivity{
		{EstimatedDialFreq: 14_250_000, Mode: "USB", Bandwidth: 2700, SNR: 12.345, Confidence: 0.8765, StartBin: 3, EndBin: 9, SpectralShape: "flat"},
		{EstimatedDialFreq: 14_190_000, Mode: "USB", Bandwidth: 2600, SNR: 20, Confidence: 0.9, DXCallsign: "3Y0J", DXCountry: "Bouvet"},
	})
	if len(got) != 2 || got[0].DialFrequencyHz != 14_190_000 {
		t.Fatalf("%+v: want both, lowest frequency first", got)
	}
	if got[1].SNR != 12.3 || got[1].Confidence != 0.88 || got[1].DialFrequencyKHz != 14250 {
		t.Errorf("rounding/units: %+v", got[1])
	}
	if got[0].DXCallsign != "3Y0J" {
		t.Errorf("DX enrichment lost: %+v", got[0])
	}
	data, _ := json.Marshal(got)
	for _, internal := range []string{"start_bin", "spectral_shape"} {
		if strings.Contains(string(data), internal) {
			t.Errorf("detector internal %q is exposed", internal)
		}
	}
}

func TestGetVoiceActivityTool(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_voice_activity", "127.0.0.1", nil), "not enabled")

	m = newTestMCPServer(t, nil, nil, snrTestMonitor(t))
	wantToolError(t, callTool(t, m, "get_voice_activity", "127.0.0.1", map[string]interface{}{"min_confidence": 2}), "between 0 and 1")
	var got map[string]interface{}
	resultJSON(t, callTool(t, m, "get_voice_activity", "127.0.0.1", nil), &got)
	if _, ok := got["bands"]; !ok {
		t.Errorf("all-band scan returned %v", got)
	}
	wantToolError(t, callTool(t, m, "get_voice_activity", "127.0.0.1", map[string]interface{}{"band": "6m"}), "6m")
}

// ── What's on a frequency ───────────────────────────────────────────────────

func TestWhatsOnFrequency(t *testing.T) {
	now := time.Now().UTC()
	h := now.Hour()
	cfg := &Config{}
	cfg.DXCluster.Enabled = true
	cfg.Bookmarks = []Bookmark{
		{Name: "BBC World Service", Frequency: 9_410_000, Mode: "am"},
		{Name: "Far away", Frequency: 9_600_000, Mode: "am"},
	}
	spectrum := testSession("s9", "spec", "198.51.100.9", 9_410_000, "spectrum")
	spectrum.IsSpectrum = true
	sm := testSessionManager(cfg,
		testSession("s1", "kiwi-1-198.51.100.1", "198.51.100.1", 9_410_000, "am"),
		testSession("s2", "native", "198.51.100.2", 9_413_000, "sam"),
		testSession("s3", "native2", "198.51.100.3", 9_500_000, "am"),
		spectrum,
	)
	m := newTestMCPServer(t, cfg, sm, nil)
	m.DXCluster = testDXCluster(now)
	m.EiBi = &EiBiSchedule{entries: []EiBiEntry{
		{FreqKHz: 9410, StartUTC: 0, EndUTC: 2400, Station: "BBC", Language: "E", Target: "WAf", ITU: "G"},
		// Two hours from now: scheduled, not on air.
		{FreqKHz: 9410, StartUTC: ((h + 2) % 24) * 100, EndUTC: ((h + 3) % 24) * 100, Station: "Later Radio"},
		{FreqKHz: 9500, StartUTC: 0, EndUTC: 2400, Station: "Elsewhere"},
	}}
	m.DRM = &DRMSchedule{entries: []DRMScheduleEntry{
		{FreqKHz: 9410, FreqHz: 9_410_000, Station: "DRM Test", StartUTC: 0, EndUTC: 2400, DaysMask: "1111111"},
		{FreqKHz: 9800, FreqHz: 9_800_000, Station: "Too far", StartUTC: 0, EndUTC: 2400},
	}}

	var got struct {
		Band       string             `json:"band"`
		Broadcasts []mcpBroadcast     `json:"broadcasts_now"`
		Schedule   []mcpBroadcast     `json:"broadcast_schedule"`
		DRM        []DRMScheduleEntry `json:"drm_now"`
		Bookmarks  []Bookmark         `json:"bookmarks"`
		DXSpots    []mcpDXSpot        `json:"dx_spots"`
		Listeners  mcpFreqListeners   `json:"listeners"`
	}
	resultJSON(t, callTool(t, m, "whats_on_frequency", "127.0.0.1",
		map[string]interface{}{"frequency_khz": 9410, "include_schedule": true}), &got)

	if len(got.Broadcasts) != 1 || got.Broadcasts[0].Station != "BBC" || !got.Broadcasts[0].OnAirNow {
		t.Errorf("broadcasts now: %+v, want BBC only", got.Broadcasts)
	}
	if len(got.Schedule) != 2 {
		t.Errorf("schedule: %+v, want BBC and Later Radio", got.Schedule)
	}
	for _, s := range got.Schedule {
		if s.Station == "Later Radio" && s.OnAirNow {
			t.Error("Later Radio is marked on air two hours early")
		}
	}
	if len(got.DRM) != 1 || got.DRM[0].Station != "DRM Test" {
		t.Errorf("DRM: %+v", got.DRM)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0].Name != "BBC World Service" {
		t.Errorf("bookmarks: %+v", got.Bookmarks)
	}
	if len(got.DXSpots) != 1 || got.DXSpots[0].DXCall != "VK3YY" {
		t.Errorf("DX spots: %+v, want VK3YY at 9411", got.DXSpots)
	}
	if got.Listeners.Count != 2 || got.Listeners.ByProtocol["kiwi"] != 1 || got.Listeners.ByProtocol["native"] != 1 ||
		got.Listeners.ByMode["am"] != 1 || got.Listeners.ByMode["sam"] != 1 {
		t.Errorf("listeners: %+v, want the kiwi AM and native SAM listeners within 5 kHz", got.Listeners)
	}

	// A narrower tolerance drops the listener 3 kHz away.
	resultJSON(t, callTool(t, m, "whats_on_frequency", "127.0.0.1",
		map[string]interface{}{"frequency_khz": 9410, "tolerance_khz": 1}), &got)
	if got.Listeners.Count != 1 {
		t.Errorf("1 kHz tolerance: %d listeners, want 1", got.Listeners.Count)
	}

	wantToolError(t, callTool(t, m, "whats_on_frequency", "127.0.0.1", nil), "frequency_khz")
	wantToolError(t, callTool(t, m, "whats_on_frequency", "127.0.0.1", map[string]interface{}{"frequency_khz": -5}), "positive")

	// Without a schedule, it says so rather than reporting no broadcasts.
	m.EiBi = nil
	var bare map[string]interface{}
	resultJSON(t, callTool(t, m, "whats_on_frequency", "127.0.0.1", map[string]interface{}{"frequency_khz": 9410}), &bare)
	if bare["broadcasts_note"] == nil {
		t.Error("no note that the broadcast schedule is unavailable")
	}
}

// ── SNR ─────────────────────────────────────────────────────────────────────

func TestGetSNRTool(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_snr", "127.0.0.1", nil), "not enabled")

	m = newTestMCPServer(t, nil, nil, snrTestMonitor(t))
	var st SNRStats
	resultJSON(t, callTool(t, m, "get_snr", "127.0.0.1", map[string]interface{}{"range": "20M"}), &st)
	if st.Range != "20m" || st.Source != "20m" || st.LoKHz != 14000 {
		t.Errorf("range 20M: %+v", st)
	}
	var custom SNRStats // fresh: "range" is omitted when empty
	resultJSON(t, callTool(t, m, "get_snr", "127.0.0.1", map[string]interface{}{"lo_khz": 14070, "hi_khz": 14080, "avg_sec": 0}), &custom)
	if custom.Source != "20m" || custom.Range != "" || custom.AvgSec != 0 || custom.LoKHz != 14070 {
		t.Errorf("custom range: %+v", custom)
	}

	var all struct {
		Readings    []SNRStats        `json:"readings"`
		Unavailable map[string]string `json:"unavailable"`
	}
	resultJSON(t, callTool(t, m, "get_snr", "127.0.0.1", nil), &all)
	names := map[string]bool{}
	for _, r := range all.Readings {
		names[r.Range] = true
	}
	for _, want := range []string{"20m", "bc49m", "hf"} {
		if !names[want] {
			t.Errorf("all-ranges reading lacks %s: %v", want, names)
		}
	}
	if _, ok := all.Unavailable["6m"]; !ok {
		t.Errorf("6m has no samples and should be listed as unavailable: %v", all.Unavailable)
	}

	for _, c := range []struct {
		args map[string]interface{}
		want string
	}{
		{map[string]interface{}{"range": "20m", "lo_khz": 1}, "not both"},
		{map[string]interface{}{"lo_khz": 14070}, "both lo_khz and hi_khz"},
		{map[string]interface{}{"lo_khz": 14080, "hi_khz": 14070}, "above"},
		{map[string]interface{}{"lo_khz": 14070, "hi_khz": 14071}, "too narrow"},
		{map[string]interface{}{"range": "nope"}, "unknown range"},
		{map[string]interface{}{"range": "20m", "avg_sec": 61}, "avg_sec"},
	} {
		wantToolError(t, callTool(t, m, "get_snr", "127.0.0.1", c.args), c.want)
	}

	// The tool's description lists the configured ranges.
	if d := m.mcpServer.GetTool("get_snr").Tool.Description; !strings.Contains(d, "20m") || !strings.Contains(d, "bc31m") {
		t.Errorf("description does not list the named ranges: %s", d)
	}
}

// ── Sun ─────────────────────────────────────────────────────────────────────

func TestSunPhase(t *testing.T) {
	for alt, want := range map[float64]string{30: "day", 0.1: "day", 0: "twilight", -6: "twilight", -11.9: "twilight", -12: "night", -40: "night"} {
		if got := sunPhase(alt); got != want {
			t.Errorf("sunPhase(%v) = %s, want %s", alt, got, want)
		}
	}
}

func TestSunReport(t *testing.T) {
	// London on the June solstice.
	day := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)
	times := GetTimes(day.Add(12*time.Hour), 51.5, -0.12, 0)
	noon := sunReport(51.5, -0.12, times.SolarNoon, day, 0)
	if math.Abs(noon.SunAzimuthDeg-180) > 1 {
		t.Errorf("azimuth at solar noon %.1f, want due south (180)", noon.SunAzimuthDeg)
	}
	if noon.SunAltitudeDeg < 60 || noon.Phase != "day" || noon.OnGreyline {
		t.Errorf("midsummer noon in London: %+v", noon)
	}
	if noon.Locator != "IO91wm" {
		t.Errorf("locator %s, want IO91wm", noon.Locator)
	}
	sunrise := noon.Times["sunrise"]
	if sunrise == nil || !strings.HasPrefix(*sunrise, "2026-06-21T03:4") {
		t.Errorf("London sunrise %v, want about 03:43 UTC", sunrise)
	}
	atSunrise := sunReport(51.5, -0.12, times.Sunrise, day, 0)
	if !atSunrise.OnGreyline {
		t.Errorf("at sunrise the sun is at %.1f degrees and not on the greyline", atSunrise.SunAltitudeDeg)
	}

	// Polar day: the sun never sets, so there is no sunrise or sunset.
	polar := sunReport(80, 15, day.Add(12*time.Hour), day, 0)
	if polar.Times["sunrise"] != nil || polar.Times["sunset"] != nil {
		t.Errorf("polar day reports sunrise %v sunset %v, want neither", polar.Times["sunrise"], polar.Times["sunset"])
	}
	if polar.Times["solar_noon"] == nil {
		t.Error("polar day lost its solar noon")
	}
}

func TestGetSunTimesTool(t *testing.T) {
	cfg := &Config{}
	m := newTestMCPServer(t, cfg, nil, nil)
	wantToolError(t, callTool(t, m, "get_sun_times", "127.0.0.1", nil), "not configured")

	cfg.Admin.GPS.Lat, cfg.Admin.GPS.Lon = 51.5, -0.12
	var got struct {
		Receiver mcpSunReport           `json:"receiver"`
		FarEnd   *mcpSunReport          `json:"far_end"`
		Path     map[string]interface{} `json:"path"`
	}
	resultJSON(t, callTool(t, m, "get_sun_times", "127.0.0.1", map[string]interface{}{"locator": "FN31pr", "date": "2026-06-21"}), &got)
	if got.FarEnd == nil || got.Path == nil {
		t.Fatalf("no far end or path: %+v", got)
	}
	// London to Connecticut is about 5,500 km, bearing a little north of west.
	if d := got.Path["distance_km"].(float64); d < 5300 || d > 5700 {
		t.Errorf("distance %v km, want about 5500", d)
	}
	if b := got.Path["bearing_deg"].(float64); b < 280 || b > 300 {
		t.Errorf("bearing %v, want about 290", b)
	}

	resultJSON(t, callTool(t, m, "get_sun_times", "127.0.0.1", map[string]interface{}{"latitude": -33.9, "longitude": 151.2}), &got)
	if got.FarEnd == nil || got.FarEnd.Locator[:4] != "QF56" {
		t.Errorf("latitude/longitude far end: %+v", got.FarEnd)
	}

	wantToolError(t, callTool(t, m, "get_sun_times", "127.0.0.1", map[string]interface{}{"latitude": 10}), "both latitude and longitude")
	wantToolError(t, callTool(t, m, "get_sun_times", "127.0.0.1", map[string]interface{}{"latitude": 95, "longitude": 0}), "-90 to 90")
	wantToolError(t, callTool(t, m, "get_sun_times", "127.0.0.1", map[string]interface{}{"locator": "ZZ99"}), "locator")
	wantToolError(t, callTool(t, m, "get_sun_times", "127.0.0.1", map[string]interface{}{"date": "21/06/2026"}), "YYYY-MM-DD")
}

// ── Station ─────────────────────────────────────────────────────────────────

func TestLastPerUTCDay(t *testing.T) {
	in := []rankHistoryPoint{
		{At: "2026-11-15T01:00:00Z", Rank: 1},
		{At: "2026-11-15T23:00:00Z", Rank: 2},
		{At: "2026-11-16T05:00:00Z", Rank: 3},
		{At: "2026-11-17T00:00:00Z", Rank: 4},
		{At: "2026-11-17T12:00:00Z", Rank: 5},
	}
	got := lastPerUTCDay(in)
	if len(got) != 3 || got[0].Rank != 2 || got[1].Rank != 3 || got[2].Rank != 5 {
		t.Errorf("lastPerUTCDay = %+v, want ranks 2, 3, 5", got)
	}
}

func TestGetStationRankingsTool(t *testing.T) {
	cfg := &Config{}
	cfg.Decoder.ReceiverCallsign = "M9PSY"
	m := newTestMCPServer(t, cfg, nil, nil)

	var got map[string]interface{}
	resultJSON(t, callTool(t, m, "get_station_rankings", "127.0.0.1", nil), &got)
	current, ok := got["current"].(map[string]interface{})
	if !ok || current["receiver_callsign"] != "M9PSY" {
		t.Errorf("current summary %v", got["current"])
	}
	if _, has := got["history"]; has {
		t.Error("history returned without being asked for")
	}

	resultJSON(t, callTool(t, m, "get_station_rankings", "127.0.0.1", map[string]interface{}{"history": "7d"}), &got)
	if got["history_note"] == nil {
		t.Error("asked for history with no stats logger: want a note saying it is not recorded")
	}
	wantToolError(t, callTool(t, m, "get_station_rankings", "127.0.0.1", map[string]interface{}{"history": "1y"}), "history must be")
}

func TestSummariseFreqRef(t *testing.T) {
	base := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	h := []FrequencyReferenceHistory{
		{DetectedFreq: 25_000_001, FrequencyOffset: 1.0, SNR: 30, Timestamp: base},
		{DetectedFreq: 0, FrequencyOffset: -25_000_000, Timestamp: base.Add(time.Minute)}, // signal lost
		{DetectedFreq: 25_000_002, FrequencyOffset: 2.0, SNR: 34, Timestamp: base.Add(2 * time.Minute)},
		{DetectedFreq: 25_000_000.5, FrequencyOffset: 0.5, SNR: 32, Timestamp: base.Add(3 * time.Minute)},
	}
	d := summariseFreqRef(h, 25_000_000)
	if d.Samples != 4 || d.NoSignalPct != 25 {
		t.Errorf("samples %d no-signal %v%%, want 4 and 25%%", d.Samples, d.NoSignalPct)
	}
	if d.MinHz != 0.5 || d.MaxHz != 2 || d.SpreadHz != 1.5 || d.ChangeHz != -0.5 {
		t.Errorf("min %v max %v spread %v change %v, want 0.5 2 1.5 -0.5 (the lost-signal point ignored)", d.MinHz, d.MaxHz, d.SpreadHz, d.ChangeHz)
	}
	if d.MeanHz != roundTo(3.5/3, 3) || d.MeanSNRDB != 32 {
		t.Errorf("mean %v snr %v", d.MeanHz, d.MeanSNRDB)
	}
	if d.SpreadPPB != 60 { // 1.5 Hz of 25 MHz
		t.Errorf("spread %v ppb, want 60", d.SpreadPPB)
	}
	if empty := summariseFreqRef(nil, 25e6); empty.Samples != 0 || empty.From != "" {
		t.Errorf("empty history: %+v", empty)
	}
}

func TestGetFrequencyReferenceTool(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_frequency_reference", "127.0.0.1", nil), "not enabled")

	cfg := &Config{}
	cfg.FrequencyReference.Frequency = 25_000_000
	now := time.Now().UTC()
	m.freqRefMonitor = &FrequencyReferenceMonitor{
		config:          cfg,
		detectedFreq:    25_000_002,
		frequencyOffset: 2,
		snr:             31,
		latestSpectrum:  make([]float32, 500),
		history: []FrequencyReferenceHistory{
			{DetectedFreq: 25_000_001, FrequencyOffset: 1, SNR: 30, Timestamp: now.Add(-2 * time.Minute)},
			{DetectedFreq: 25_000_002, FrequencyOffset: 2, SNR: 31, Timestamp: now.Add(-time.Minute)},
		},
	}
	var got struct {
		Current map[string]interface{} `json:"current"`
		Hour    freqRefDrift           `json:"last_hour_summary"`
	}
	resultJSON(t, callTool(t, m, "get_frequency_reference", "127.0.0.1", nil), &got)
	if _, has := got.Current["spectrum_data"]; has {
		t.Error("the raw chart spectrum is included")
	}
	if got.Current["frequency_offset_ppb"] != 80.0 { // 2 Hz of 25 MHz
		t.Errorf("offset ppb %v, want 80", got.Current["frequency_offset_ppb"])
	}
	if got.Hour.Samples != 2 || got.Hour.ChangeHz != 1 {
		t.Errorf("last hour: %+v", got.Hour)
	}
}

// ── Spectrogram ─────────────────────────────────────────────────────────────

func TestRenderRowsScaled(t *testing.T) {
	rows := [][]float32{{-100, -90}, {-80, float32(math.Inf(-1))}}
	for _, size := range [][2]int{{300, 168}, {4, 2}, {1, 1}} {
		img, err := png.Decode(bytes.NewReader(renderRowsScaled(rows, "jet", -120, -60, 2, 0, 0, size[0], size[1])))
		if err != nil {
			t.Fatalf("%v: %v", size, err)
		}
		if b := img.Bounds(); b.Dx() != size[0] || b.Dy() != size[1] {
			t.Errorf("rendered %dx%d, want %dx%d", b.Dx(), b.Dy(), size[0], size[1])
		}
	}
	// Upscaled, the no-data cell stays black and real cells do not.
	img, _ := png.Decode(bytes.NewReader(renderRowsScaled(rows, "jet", -120, -60, 2, 0, 0, 4, 2)))
	if r, g, b, _ := img.At(3, 1).RGBA(); r|g|b != 0 {
		t.Errorf("no-data cell rendered as %d,%d,%d, want black", r, g, b)
	}
	if r, g, b, _ := img.At(0, 0).RGBA(); r|g|b == 0 {
		t.Error("a measured cell rendered black")
	}
	if renderRowsScaled(nil, "jet", -120, -60, 2, 0, 0, 10, 10) != nil || renderRowsScaled(rows, "jet", -120, -60, 2, 0, 0, 0, 10) != nil {
		t.Error("empty input or a zero size must render nothing")
	}
}

func TestSpectrogramImageSize(t *testing.T) {
	for _, c := range []struct{ bins, rows, w, h int }{
		{8192, 1440, 1024, 720},
		{600, 400, 600, 400},
		{4, 60, 256, 120},
	} {
		if w, h := spectrogramImageSize(c.bins, c.rows); w != c.w || h != c.h {
			t.Errorf("size(%d bins, %d rows) = %dx%d, want %dx%d", c.bins, c.rows, w, h, c.w, c.h)
		}
	}
}

func TestSummariseSpectrogramHours(t *testing.T) {
	hour := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC).Unix()
	nd := float32(math.Inf(-1))
	rows := [][]float32{
		{-120, -110, -100, -60},
		{-120, -110, -100, -60},
		{nd, nd, nd, nd}, // a missing minute does not drag the hour down
		{-100, -100, -100, -100},
	}
	meta := []SpectrogramRowMeta{{Unix: hour}, {Unix: hour + 60}, {Unix: hour + 120}, {Unix: hour + 3600}}
	got := summariseSpectrogramHours(rows, meta, 0, 4)
	if len(got) != 2 || got[0].Minutes != 2 || got[1].Minutes != 1 {
		t.Fatalf("%+v: want two hours with 2 and 1 minutes", got)
	}
	if got[0].NoiseFloorDB != -120 || got[0].SignalDB != -60 || got[0].SpreadDB != 60 {
		t.Errorf("first hour %+v, want floor -120, signal -60", got[0])
	}
	// Cropped to the two quietest bins.
	if c := summariseSpectrogramHours(rows, meta, 0, 2); c[0].SignalDB != -110 {
		t.Errorf("crop ignored: %+v", c[0])
	}
}

func TestGetSpectrogramTool(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_spectrogram", "127.0.0.1", nil), "not enabled")

	now := time.Now().UTC()
	rec := newTestRollingRecorder(t, now, now.Hour()*60+now.Minute())
	m.Spectrogram = rec
	m.BandSpectrograms = map[string]*SpectrogramRecorder{"20m": rec}

	res := callTool(t, m, "get_spectrogram", "127.0.0.1", map[string]interface{}{"hours": 1})
	if res.IsError {
		t.Fatalf("error: %s", resultText(t, res))
	}
	var summary struct {
		Frequency map[string]interface{} `json:"frequency_axis"`
		Time      map[string]interface{} `json:"time_axis"`
		Size      string                 `json:"image_size"`
		Hourly    []spectrogramHourSummary
	}
	if err := json.Unmarshal([]byte(resultText(t, res)), &summary); err != nil {
		t.Fatal(err)
	}
	if mins := summary.Time["minutes"].(float64); mins < 55 || mins > 61 {
		t.Errorf("hours=1 covers %v minutes, want about 60", mins)
	}
	if summary.Frequency["left_khz"] != 0.0 || summary.Frequency["right_khz"] != 30000.0 {
		t.Errorf("frequency axis %v, want 0-30000 kHz", summary.Frequency)
	}

	var img *mcp.ImageContent
	for _, c := range res.Content {
		if ic, ok := c.(mcp.ImageContent); ok {
			img = &ic
		}
	}
	if img == nil || img.MIMEType != "image/png" {
		t.Fatalf("no PNG image in the result: %+v", res.Content)
	}
	raw, err := base64.StdEncoding.DecodeString(img.Data)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("image does not decode: %v", err)
	}
	if b := decoded.Bounds(); summary.Size != "256x120" || b.Dx() != 256 || b.Dy() != 120 {
		t.Errorf("image %dx%d, summary says %s; want 256x120 for 4 bins over an hour", b.Dx(), b.Dy(), summary.Size)
	}

	// A crop narrows the frequency axis. The fixture has four 7.5 MHz bins,
	// so the crop is on a bin edge.
	res = callTool(t, m, "get_spectrogram", "127.0.0.2", map[string]interface{}{"freq_min_khz": 7500, "freq_max_khz": 22500})
	if err := json.Unmarshal([]byte(resultText(t, res)), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Frequency["left_khz"] != 7500.0 || summary.Frequency["right_khz"] != 22500.0 {
		t.Errorf("crop 7500-22500 kHz: axis %v", summary.Frequency)
	}
	if res := callTool(t, m, "get_spectrogram", "127.0.0.6", map[string]interface{}{"band": "wideband-hf"}); res.IsError {
		t.Errorf("wideband-hf: %s", resultText(t, res))
	}

	if res := callTool(t, m, "get_spectrogram", "127.0.0.3", map[string]interface{}{"band": "20m"}); res.IsError {
		t.Errorf("band 20m: %s", resultText(t, res))
	}
	wantToolError(t, callTool(t, m, "get_spectrogram", "127.0.0.4", map[string]interface{}{"band": "2m"}), "available: wideband, wideband-hf, 20m")
	wantToolError(t, callTool(t, m, "get_spectrogram", "127.0.0.5", map[string]interface{}{"freq_min_khz": 9000, "freq_max_khz": 8000}), "above")
}

// ── Propagation predictions ─────────────────────────────────────────────────

func TestPredictionToolsNeedTheirSources(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_propagation_predictions", "127.0.0.1", nil), "not enabled")
	wantToolError(t, callTool(t, m, "get_ssb_predictions", "127.0.0.1", nil), "not enabled")

	m.multiDecoder = &MultiDecoder{spotsLogger: newTestSpotsLogger(t)}
	wantToolError(t, callTool(t, m, "get_propagation_predictions", "127.0.0.1", nil), "space weather")
}

func TestGetPropagationPredictionsTool(t *testing.T) {
	sl := newTestSpotsLogger(t)
	now := time.Now().UTC()
	for i, call := range []string{"K1ABC", "K2DEF", "K3GHI"} {
		if err := sl.LogSpot(&DecodeInfo{
			Callsign: call, Locator: "FN42", Country: "United States", CountryCode: "US", Continent: "NA",
			SNR: -12, Frequency: 14_074_000, Mode: "FT8", BandName: "20m_FT8",
			Timestamp: now.Add(-time.Duration(i+1) * 20 * time.Minute),
		}); err != nil {
			t.Fatalf("LogSpot: %v", err)
		}
	}

	m := newTestMCPServer(t, nil, nil, nil)
	m.multiDecoder = &MultiDecoder{spotsLogger: sl}
	m.spaceWeatherMonitor = &SpaceWeatherMonitor{data: &SpaceWeatherData{KIndex: 2, SolarFlux: 150}}

	var got BandPredictionsResponse
	resultJSON(t, callTool(t, m, "get_propagation_predictions", "127.0.0.1", map[string]interface{}{"continent": "na", "hours": 500}), &got)
	if got.CurrentSpaceWeather.SolarFlux != 150 || got.CurrentSpaceWeather.KIndex != 2 {
		t.Errorf("space weather %+v, want SFI 150 K 2", got.CurrentSpaceWeather)
	}
	if got.TimeRange.Hours != 168 {
		t.Errorf("hours %d, want the 168-hour cap", got.TimeRange.Hours)
	}
	if got.Filters.Continent != "NA" {
		t.Errorf("continent filter %q, want NA (upper-cased)", got.Filters.Continent)
	}
}

func TestGetSSBPredictionsTool(t *testing.T) {
	// The WSPR spots behind this are cached process-wide for two minutes;
	// start from an empty cache so another test's spots cannot leak in.
	resetWSPRCache := func() {
		wsprSpotsCache.mu.Lock()
		wsprSpotsCache.spots, wsprSpotsCache.fetchedAt = nil, time.Time{}
		wsprSpotsCache.mu.Unlock()
	}
	resetWSPRCache()
	t.Cleanup(resetWSPRCache)

	sl := newTestSpotsLogger(t)
	// A 5 W (37 dBm) beacon heard at -10 dB. At 100 W (50 dBm) an SSB signal
	// on the same path would be -10 + 13 - 0.33 = 2.7 dB: "poor". At 1 kW
	// (60 dBm) it would be 12.7 dB: "good".
	if err := sl.LogSpot(&DecodeInfo{
		Callsign: "K1ABC", Locator: "FN42", Country: "United States", CountryCode: "US", Continent: "NA",
		SNR: -10, DBm: 37, IsWSPR: true, Frequency: 14_097_100, Mode: "WSPR", BandName: "20m_WSPR",
		Timestamp: time.Now().UTC().Add(-10 * time.Minute),
	}); err != nil {
		t.Fatalf("LogSpot: %v", err)
	}

	m := newTestMCPServer(t, nil, nil, nil)
	m.multiDecoder = &MultiDecoder{spotsLogger: sl}

	text := func(args map[string]interface{}) string {
		res := callTool(t, m, "get_ssb_predictions", "127.0.0.1", args)
		if res.IsError {
			t.Fatalf("%v: %s", args, resultText(t, res))
		}
		return resultText(t, res)
	}

	// The default bar is "good" or better, which 100 W does not reach.
	if got := text(nil); strings.Contains(got, "United States") {
		t.Errorf("100 W, default min_ssb_snr 10: the 2.7 dB path is listed:\n%s", got)
	}
	if got := text(map[string]interface{}{"power_w": 1000}); !strings.Contains(got, "United States") || !strings.Contains(got, `"good"`) {
		t.Errorf("1 kW: want United States rated good:\n%s", got)
	}
	if got := text(map[string]interface{}{"min_ssb_snr": -60, "group_by": "band"}); !strings.Contains(got, `"20m"`) || !strings.Contains(got, `"poor"`) {
		t.Errorf("100 W by band, no SNR floor: want 20m rated poor:\n%s", got)
	}

	wantToolError(t, callTool(t, m, "get_ssb_predictions", "127.0.0.1", map[string]interface{}{"power_w": 77}), "phone_power_w must be one of")
	wantToolError(t, callTool(t, m, "get_ssb_predictions", "127.0.0.1", map[string]interface{}{"band": "2m"}), "band must be one of")
}
