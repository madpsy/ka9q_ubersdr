package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func histRecord(uid, ip, proto string, start, end time.Time) SessionHistoryRecord {
	e := end
	return SessionHistoryRecord{
		UserSessionID: uid, ClientIP: ip, Protocol: proto,
		StartedAt: start, LastSeen: end, EndedAt: &e,
		Country: "United States", CountryCode: "US",
	}
}

func historyQuery(t *testing.T, tz, from, to, bucket string, now time.Time) mcpHistoryQuery {
	t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatal(err)
	}
	q := mcpHistoryQuery{Location: loc, Bucket: bucket}
	if msg := q.setDates(from, to, now); msg != "" {
		t.Fatalf("setDates: %s", msg)
	}
	return q
}

// roundTrip turns the response into plain JSON values, as a client sees it.
func historyJSON(t *testing.T, v interface{}) map[string]interface{} {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSessionHistoryDateRange(t *testing.T) {
	now := time.Date(2026, 11, 17, 15, 0, 0, 0, time.UTC)

	q := historyQuery(t, "UTC", "", "", "", now)
	if q.Days != 7 || q.Bucket != "day" || q.Start.Format("2006-01-02") != "2026-11-11" {
		t.Errorf("default: %d days from %s, bucket %s; want 7 days from 2026-11-11 by day", q.Days, q.Start.Format("2006-01-02"), q.Bucket)
	}

	q = historyQuery(t, "UTC", "2026-11-16", "2026-11-17", "", now)
	if q.Bucket != "hour" {
		t.Errorf("a 2-day range defaults to %q buckets, want hour", q.Bucket)
	}

	loc := time.UTC
	for _, c := range []struct{ from, to, bucket, want string }{
		{"2026-10-01", "2026-11-17", "", "maximum is 31"},
		{"2026-11-01", "2026-11-17", "hour", "limited to 7 days"},
		{"2026-11-17", "2026-11-10", "", "on or after"},
		{"2026-12-01", "2026-12-02", "", "future"},
		{"17/11/2026", "", "", "YYYY-MM-DD"},
		{"", "", "week", "'day' or 'hour'"},
	} {
		q := mcpHistoryQuery{Location: loc, Bucket: c.bucket}
		msg := q.setDates(c.from, c.to, now)
		if msg == "" || !containsFold(msg, c.want) {
			t.Errorf("from=%q to=%q bucket=%q: error %q, want one mentioning %q", c.from, c.to, c.bucket, msg, c.want)
		}
	}
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

func TestSessionHistoryHourlyCounts(t *testing.T) {
	day := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	at := func(h, m int) time.Time { return day.Add(time.Duration(h)*time.Hour + time.Duration(m)*time.Minute) }
	now := day.Add(36 * time.Hour)

	records := []SessionHistoryRecord{
		// Started the day before and ran into it: overlaps hour 0, but did
		// not start in the range.
		histRecord("a", "198.51.100.1", "native", day.Add(-30*time.Minute), at(0, 30)),
		// Two at once in hour 1; one carries on into hour 2.
		histRecord("b", "198.51.100.2", "kiwi", at(1, 0), at(1, 30)),
		histRecord("c", "198.51.100.3", "websdr", at(1, 15), at(2, 15)),
		// The same listener reconnects in hour 3, back to back: one listener,
		// two sessions, never two at once.
		histRecord("d1", "198.51.100.4", "native", at(3, 0), at(3, 20)),
		histRecord("d2", "198.51.100.4", "native", at(3, 20), at(3, 40)),
		// A row written before the protocol column: the prefix says kiwi.
		histRecord("kiwi-1-198.51.100.5", "198.51.100.5", "", at(4, 0), at(4, 6)),
	}
	q := historyQuery(t, "UTC", "2026-11-16", "2026-11-16", "hour", now)
	out := historyJSON(t, buildMCPSessionHistory(records, q))

	series := out["series"].([]interface{})
	if len(series) != 24 {
		t.Fatalf("%d hourly buckets, want 24", len(series))
	}
	bucket := func(h int) map[string]interface{} { return series[h].(map[string]interface{}) }
	num := func(m map[string]interface{}, k string) float64 { return m[k].(float64) }

	checks := []struct {
		hour                     int
		started, listeners, peak float64
		hours                    float64
		native, kiwi, websdr     float64
	}{
		{0, 0, 1, 1, 0.5, 0, 0, 0},
		{1, 2, 2, 2, 0.5 + 0.75, 0, 1, 1},
		{2, 0, 1, 1, 0.25, 0, 0, 0},
		{3, 2, 1, 1, 40.0 / 60, 2, 0, 0},
		{4, 1, 1, 1, 0.1, 0, 1, 0},
		{5, 0, 0, 0, 0, 0, 0, 0},
	}
	for _, c := range checks {
		b := bucket(c.hour)
		if num(b, "sessions_started") != c.started || num(b, "unique_listeners") != c.listeners || num(b, "peak_concurrent") != c.peak {
			t.Errorf("hour %d: started %v listeners %v peak %v, want %v %v %v", c.hour,
				b["sessions_started"], b["unique_listeners"], b["peak_concurrent"], c.started, c.listeners, c.peak)
		}
		if got := num(b, "listening_hours"); got != roundTo(c.hours, 2) {
			t.Errorf("hour %d: listening_hours %v, want %v", c.hour, got, roundTo(c.hours, 2))
		}
		bp := b["sessions_started_by_protocol"].(map[string]interface{})
		if num(bp, "native") != c.native || num(bp, "kiwi") != c.kiwi || num(bp, "websdr") != c.websdr {
			t.Errorf("hour %d: by protocol %v, want native %v kiwi %v websdr %v", c.hour, bp, c.native, c.kiwi, c.websdr)
		}
	}

	totals := out["totals"].(map[string]interface{})
	if num(totals, "sessions_started") != 5 || num(totals, "unique_listeners") != 5 || num(totals, "peak_concurrent") != 2 {
		t.Errorf("totals %v: want 5 started (a began before the range), 5 listeners, peak 2", totals)
	}
	// 30 + 30 + 60 + 20 + 20 + 6 minutes inside the range.
	if got := num(totals, "listening_hours"); got != roundTo(166.0/60, 2) {
		t.Errorf("total listening_hours %v, want %v", got, roundTo(166.0/60, 2))
	}
	// Durations of sessions started in range: 30, 60, 20, 20, 6 → median 20.
	if got := num(totals, "median_session_minutes"); got != 20 {
		t.Errorf("median_session_minutes %v, want 20", got)
	}

	byProto := out["totals_by_protocol"].(map[string]interface{})
	kiwi := byProto["kiwi"].(map[string]interface{})
	if num(kiwi, "sessions_started") != 2 || num(kiwi, "unique_listeners") != 2 {
		t.Errorf("kiwi totals %v: want 2 sessions from 2 listeners", kiwi)
	}
	native := byProto["native"].(map[string]interface{})
	if num(native, "sessions_started") != 2 || num(native, "unique_listeners") != 2 {
		t.Errorf("native totals %v: want 2 started (d1, d2) from 2 listeners (a, d)", native)
	}
}

func TestSessionHistoryStopsAtNow(t *testing.T) {
	day := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	now := day.Add(10*time.Hour + 30*time.Minute)
	q := historyQuery(t, "UTC", "2026-11-17", "2026-11-17", "hour", now)
	out := historyJSON(t, buildMCPSessionHistory(nil, q))
	if n := len(out["series"].([]interface{})); n != 11 {
		t.Errorf("%d buckets for a day 10.5 hours old, want 11 (none in the future)", n)
	}
	if out["period"].(map[string]interface{})["complete"] != false {
		t.Error("today's period is reported complete")
	}
}

func TestSessionHistoryDaysFollowTimezoneAcrossDST(t *testing.T) {
	// Europe/London leaves summer time on 25 October 2026, so that day has
	// 25 hours. Day buckets must start at local midnight either side of it.
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	q := historyQuery(t, "Europe/London", "2026-10-24", "2026-10-26", "day", now)
	london := q.Location

	// One session in the last local hour of the 25th (23:30 GMT).
	late := time.Date(2026, 10, 25, 23, 30, 0, 0, london)
	out := historyJSON(t, buildMCPSessionHistory([]SessionHistoryRecord{
		histRecord("x", "198.51.100.9", "native", late, late.Add(10*time.Minute)),
	}, q))

	series := out["series"].([]interface{})
	wantStarts := []string{"2026-10-24T00:00:00+01:00", "2026-10-25T00:00:00+01:00", "2026-10-26T00:00:00Z"}
	if len(series) != len(wantStarts) {
		t.Fatalf("%d day buckets, want %d", len(series), len(wantStarts))
	}
	for i, want := range wantStarts {
		b := series[i].(map[string]interface{})
		if b["start"] != want {
			t.Errorf("bucket %d starts %v, want %s", i, b["start"], want)
		}
		wantStarted := 0.0
		if i == 1 {
			wantStarted = 1
		}
		if b["sessions_started"] != wantStarted {
			t.Errorf("bucket %d: %v sessions, want %v", i, b["sessions_started"], wantStarted)
		}
	}
	if out["period"].(map[string]interface{})["timezone"] != "Europe/London" {
		t.Error("response does not say which timezone its days follow")
	}
}

func TestSessionHistoryFiltersAndPlaces(t *testing.T) {
	day := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	at := func(h int) time.Time { return day.Add(time.Duration(h) * time.Hour) }
	gb := histRecord("g", "203.0.113.50", "native", at(1), at(2))
	gb.Country, gb.CountryCode = "United Kingdom", "GB"

	records := []SessionHistoryRecord{
		// Texas: one listener with three sessions.
		histRecord("t1", "198.51.100.1", "native", at(1), at(2)),
		histRecord("t2", "198.51.100.1", "native", at(3), at(4)),
		histRecord("t3", "198.51.100.1", "native", at(5), at(6)),
		// California: two listeners, one session each. Fewer sessions than
		// Texas but more people, so it ranks first.
		histRecord("c1", "198.51.100.2", "kiwi", at(1), at(2)),
		histRecord("c2", "198.51.100.3", "native", at(1), at(2)),
		gb,
	}
	places := map[string][2]string{
		"198.51.100.1": {"Texas", "Austin"},
		"198.51.100.2": {"California", "San Jose"},
		"198.51.100.3": {"California", "Fresno"},
		"203.0.113.50": {"England", "Leeds"},
	}
	lookups := 0
	locate := func(ip string) (string, string) {
		lookups++
		p := places[ip]
		return p[0], p[1]
	}

	q := historyQuery(t, "UTC", "2026-11-16", "2026-11-16", "day", day.Add(48*time.Hour))
	q.Locate = locate
	q.CountryCode = "US"
	out := historyJSON(t, buildMCPSessionHistory(records, q))

	regions := out["top_regions"].([]interface{})
	if len(regions) != 2 {
		t.Fatalf("top_regions %v: want California and Texas only (GB filtered out)", regions)
	}
	first := regions[0].(map[string]interface{})
	if first["name"] != "California" || first["unique_listeners"] != 2.0 || first["sessions"] != 2.0 {
		t.Errorf("first region %v, want California with 2 listeners and 2 sessions", first)
	}
	second := regions[1].(map[string]interface{})
	if second["name"] != "Texas" || second["unique_listeners"] != 1.0 || second["sessions"] != 3.0 {
		t.Errorf("second region %v, want Texas with 1 listener and 3 sessions", second)
	}
	cities := out["top_cities"].([]interface{})
	if c := cities[0].(map[string]interface{}); c["name"] != "Austin, Texas" {
		t.Errorf("filtered to one country, city labels drop the country: got %v", c["name"])
	}
	if out["totals"].(map[string]interface{})["sessions_started"] != 5.0 {
		t.Errorf("country filter: totals %v, want 5 US sessions", out["totals"])
	}

	// Unfiltered, region names carry their country.
	q.CountryCode = ""
	out = historyJSON(t, buildMCPSessionHistory(records, q))
	names := map[string]bool{}
	for _, r := range out["top_regions"].([]interface{}) {
		names[r.(map[string]interface{})["name"].(string)] = true
	}
	for _, want := range []string{"United States / California", "United States / Texas", "United Kingdom / England"} {
		if !names[want] {
			t.Errorf("unfiltered top_regions lacks %q: %v", want, names)
		}
	}

	// The protocol filter narrows everything to that client.
	q.Protocol = "kiwi"
	out = historyJSON(t, buildMCPSessionHistory(records, q))
	if out["totals"].(map[string]interface{})["sessions_started"] != 1.0 {
		t.Errorf("protocol=kiwi: totals %v, want the one kiwi session", out["totals"])
	}

	// Without GeoIP there are no place breakdowns, and the response says why.
	q = historyQuery(t, "UTC", "2026-11-16", "2026-11-16", "day", day.Add(48*time.Hour))
	out = historyJSON(t, buildMCPSessionHistory(records, q))
	if _, has := out["top_regions"]; has {
		t.Error("top_regions reported without a GeoIP locator")
	}
	if out["location_note"] == nil {
		t.Error("no note explaining the missing regions")
	}
}

func TestGeoIPLocatorCachesPerIP(t *testing.T) {
	// A disabled service fails every lookup; the locator must still answer
	// (with nothing) and only ask once per address.
	locate := geoIPLocator(&GeoIPService{})
	for i := 0; i < 3; i++ {
		if r, c := locate("198.51.100.1"); r != "" || c != "" {
			t.Fatalf("disabled GeoIP resolved to %q, %q", r, c)
		}
	}
}

// End to end: sessions written by the real history writer, read back through
// the tool.
func TestGetSessionHistoryTool(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	writer := newSessionHistoryWriter(mgr.DB(), nil)

	now := time.Now().UTC()
	start := now.Add(-3 * time.Hour).Truncate(time.Minute)
	entry := func(uid, ip, proto, cc string) SessionActivityEntry {
		return SessionActivityEntry{
			UserSessionID: uid, ClientIP: ip, SessionTypes: []string{"audio"},
			Bands: []string{"20m"}, Modes: []string{"usb"}, Country: "Somewhere", CountryCode: cc,
			Protocol: proto, CreatedAt: start, FirstSeen: start,
		}
	}
	for _, e := range []SessionActivityEntry{
		entry("u1", "198.51.100.1", "native", "US"),
		entry("kiwi-1-198.51.100.2", "198.51.100.2", "kiwi", "US"),
		entry("websdr-1-198.51.100.3", "198.51.100.3", "websdr", "DE"),
	} {
		writer.recordActive(e, start.Unix())
		writer.closeSession(e.UserSessionID, nil, nil, start.Add(time.Hour).Unix())
	}
	// A bypassed session, the operator's own: left out unless asked for.
	own := entry("own", "192.168.1.5", "native", "GB")
	own.AuthMethod = "ip_bypass"
	writer.recordActive(own, start.Unix())
	writer.closeSession("own", nil, nil, start.Add(time.Hour).Unix())

	m := newTestMCPServer(t, &Config{}, nil, nil)
	m.SessionDB = mgr.ReadDB()

	var got struct {
		Totals     map[string]float64            `json:"totals"`
		ByProtocol map[string]map[string]float64 `json:"totals_by_protocol"`
		Period     map[string]interface{}        `json:"period"`
	}
	resultJSON(t, callTool(t, m, "get_session_history", "127.0.0.1", map[string]interface{}{"timezone": "UTC"}), &got)
	if got.Totals["sessions_started"] != 3 || got.Totals["unique_listeners"] != 3 {
		t.Errorf("totals %v: want 3 sessions from 3 listeners (bypassed excluded)", got.Totals)
	}
	for _, p := range []string{"native", "kiwi", "websdr"} {
		if got.ByProtocol[p]["sessions_started"] != 1 {
			t.Errorf("%s: %v sessions, want 1", p, got.ByProtocol[p]["sessions_started"])
		}
	}
	if got.Period["timezone"] != "UTC" || got.Period["days"] != 7.0 {
		t.Errorf("period %v: want 7 days in UTC", got.Period)
	}

	resultJSON(t, callTool(t, m, "get_session_history", "127.0.0.2", map[string]interface{}{"timezone": "UTC", "include_bypassed": true}), &got)
	if got.Totals["sessions_started"] != 4 {
		t.Errorf("include_bypassed: %v sessions, want 4", got.Totals["sessions_started"])
	}

	resultJSON(t, callTool(t, m, "get_session_history", "127.0.0.3", map[string]interface{}{"timezone": "UTC", "country_code": "us"}), &got)
	if got.Totals["sessions_started"] != 2 {
		t.Errorf("country_code=us: %v sessions, want 2", got.Totals["sessions_started"])
	}

	wantToolError(t, callTool(t, m, "get_session_history", "127.0.0.4", map[string]interface{}{"timezone": "Mars/Olympus"}), "timezone")
	wantToolError(t, callTool(t, m, "get_session_history", "127.0.0.4", map[string]interface{}{"country_code": "USA"}), "two-letter")

	// Rate limited per client.
	m.RateLimiter = NewFFTRateLimiter()
	callTool(t, m, "get_session_history", "10.9.9.9", nil)
	wantToolError(t, callTool(t, m, "get_session_history", "10.9.9.9", nil), "rate limit")

	// No database at all.
	m.SessionDB = nil
	wantToolError(t, callTool(t, m, "get_session_history", "127.0.0.5", nil), "not available")
}
