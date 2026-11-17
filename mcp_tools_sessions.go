package main

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// get_session_history: listener numbers over a date range, for comparing the
// receiver's use against outside data such as a web analytics report.
//
// It reads the session history tables directly (LoadSessionRecords, the same
// loader the admin activity views use) rather than the public /api/session-stats
// endpoint, because that endpoint only ever describes a fixed 28-day window and
// has no time series or protocol split.

const (
	// mcpHistoryMaxDays bounds one query. LoadSessionRecords holds every session
	// in the window in memory, and a busy receiver logs a couple of thousand a
	// day.
	mcpHistoryMaxDays = 31

	// mcpHistoryMaxHourlyDays bounds hourly buckets: beyond a week the series is
	// longer than a client can usefully read in one response.
	mcpHistoryMaxHourlyDays = 7

	// mcpHistoryTopN is how many entries each top-N breakdown lists.
	mcpHistoryTopN = 15
)

// mcpProtocols are the client protocols a session can arrive over, in the order
// they are reported.
var mcpProtocols = []string{"native", "kiwi", "websdr"}

func (m *MCPServer) registerSessionHistoryTool() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_session_history",
			mcpReadOnlyTool,
			mcp.WithDescription("Get listener statistics for a date range: sessions started, unique listeners, peak concurrent listeners and total listening hours, as a per-day or per-hour series and as totals, each split by client protocol ('native' = UberSDR web/app client, 'kiwi' = KiwiSDR-compatible client, 'websdr' = WebSDR-compatible client). Also lists the top countries, regions (states, provinces), cities, bands, modes, browsers and operating systems. Filter by country_code to break one country down, e.g. country_code 'US' to see which states most listeners are in. Use this to compare receiver usage against web analytics (e.g. Google Analytics or AdSense), to see where listeners are, or to see how usage changes over time. For who is connected right now, use get_active_sessions instead. Listeners are counted by IP address, which is never returned; regions and cities come from GeoIP and are approximate."),
			mcp.WithString("from_date",
				mcp.Pattern(`^\d{4}-\d{2}-\d{2}$`),
				mcp.MaxLength(32),
				mcp.Description("First day to include, YYYY-MM-DD, in the chosen timezone (default: 6 days before to_date, i.e. a 7-day window)"),
			),
			mcp.WithString("to_date",
				mcp.Pattern(`^\d{4}-\d{2}-\d{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Last day to include, YYYY-MM-DD, in the chosen timezone (default: today). The range may cover at most 31 days."),
			),
			mcp.WithString("bucket",
				mcp.Description("Series granularity: 'day' or 'hour' (default: 'hour' for ranges of 2 days or less, otherwise 'day'). 'hour' is limited to 7 days."),
				mcp.Enum("day", "hour"),
			),
			mcp.WithString("timezone",
				mcp.Pattern(`^[A-Za-z0-9_+\-/]+$`),
				mcp.MaxLength(64),
				mcp.Description("IANA timezone that day and hour boundaries follow, e.g. 'Europe/London' or 'America/New_York'. Match this to the analytics property's timezone when comparing. Default: the receiver's configured timezone."),
			),
			mcp.WithString("protocol",
				mcp.Description("Only count sessions using this protocol: 'native', 'kiwi' or 'websdr' (default: all)"),
				mcp.Enum("native", "kiwi", "websdr"),
			),
			mcp.WithString("country_code",
				mcp.Pattern(`^[A-Za-z]{2}$`),
				mcp.MaxLength(32),
				mcp.Description("Only count listeners in this country, as a two-letter ISO code, e.g. 'US', 'GB', 'DE' (default: all)"),
			),
			mcp.WithBoolean("include_bypassed",
				mcp.Description("Include sessions from IP addresses that bypass session limits, usually the operator's own (default: false)"),
				mcp.DefaultBool(false),
			),
		),
		m.handleGetSessionHistory,
	)
}

func (m *MCPServer) handleGetSessionHistory(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.SessionDB == nil {
		return mcp.NewToolResultError("Session history is not available on this receiver (database not configured)"), nil
	}

	tzName := request.GetString("timezone", "")
	if tzName == "" && m.config != nil {
		tzName = m.config.Admin.Timezone
	}
	if tzName == "" {
		tzName = "UTC"
	}
	loc, err := time.LoadLocation(tzName)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Unknown timezone %q: use an IANA name such as 'Europe/London'", tzName)), nil
	}

	q := mcpHistoryQuery{
		Location:        loc,
		Bucket:          request.GetString("bucket", ""),
		Protocol:        request.GetString("protocol", ""),
		CountryCode:     strings.ToUpper(strings.TrimSpace(request.GetString("country_code", ""))),
		IncludeBypassed: request.GetBool("include_bypassed", false),
	}
	if q.CountryCode != "" && len(q.CountryCode) != 2 {
		return mcp.NewToolResultError("country_code must be a two-letter ISO code such as 'US'"), nil
	}
	if m.geoIPService != nil && m.geoIPService.IsEnabled() {
		q.Locate = geoIPLocator(m.geoIPService)
	}
	if errMsg := q.setDates(request.GetString("from_date", ""), request.GetString("to_date", ""), time.Now()); errMsg != "" {
		return mcp.NewToolResultError(errMsg), nil
	}
	if q.Protocol != "" && !containsString(mcpProtocols, q.Protocol) {
		return mcp.NewToolResultError("protocol must be 'native', 'kiwi' or 'websdr'"), nil
	}

	if !m.allowToolCall(ctx, "get_session_history") {
		return mcpRateLimited("get_session_history"), nil
	}

	authMethods := []string{"regular", "password"}
	if q.IncludeBypassed {
		authMethods = append(authMethods, "bypassed")
	}
	records, err := LoadSessionRecords(m.SessionDB, q.Start, q.End, authMethods)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to read session history: %v", err)), nil
	}

	return mcpJSON(buildMCPSessionHistory(records, q))
}

// mcpHistoryQuery is a validated get_session_history request.
type mcpHistoryQuery struct {
	Location        *time.Location
	Start, End      time.Time // [Start, End), local midnights in Location
	Days            int
	Bucket          string // "day" or "hour"
	Protocol        string // "" = all
	CountryCode     string // "" = all; ISO 3166-1 alpha-2
	IncludeBypassed bool
	Now             time.Time // the request time; series stop here

	// Locate resolves a client IP to its region (state, province) and city.
	// nil when GeoIP is not available, and the breakdowns are then left out.
	Locate func(ip string) (region, city string)
}

// geoIPLocator resolves IPs through the GeoIP City database, at query time:
// sessions store only country and coordinates, but they do keep the IP, so the
// region and city can be recovered for the whole history. A listener's IP is
// looked up once per call however many sessions it has.
func geoIPLocator(g *GeoIPService) func(ip string) (string, string) {
	type place struct{ region, city string }
	cache := map[string]place{}
	return func(ip string) (string, string) {
		if p, ok := cache[ip]; ok {
			return p.region, p.city
		}
		var p place
		if res, err := g.Lookup(ip, false); err == nil {
			if len(res.Subdivisions) > 0 {
				p.region = res.Subdivisions[0].Name
			}
			p.city = res.City
		}
		cache[ip] = p
		return p.region, p.city
	}
}

// setDates resolves the date range and the bucket size. Returns an error message
// for the caller, or "".
func (q *mcpHistoryQuery) setDates(fromStr, toStr string, now time.Time) string {
	q.Now = now
	loc := q.Location
	localNow := now.In(loc)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, loc)

	parse := func(s string) (time.Time, bool) {
		t, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(s), loc)
		return t, err == nil
	}

	to := today
	if toStr != "" {
		t, ok := parse(toStr)
		if !ok {
			return "to_date must be a date in the form YYYY-MM-DD"
		}
		to = t
	}
	from := to.AddDate(0, 0, -6)
	if fromStr != "" {
		t, ok := parse(fromStr)
		if !ok {
			return "from_date must be a date in the form YYYY-MM-DD"
		}
		from = t
	}
	if to.Before(from) {
		return "to_date must be on or after from_date"
	}
	if from.After(today) {
		return "from_date is in the future"
	}

	// Count calendar days rather than dividing durations: a DST change makes
	// one day 23 or 25 hours long.
	days := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		days++
	}
	if days > mcpHistoryMaxDays {
		return fmt.Sprintf("date range covers %d days; the maximum is %d", days, mcpHistoryMaxDays)
	}

	switch q.Bucket {
	case "":
		q.Bucket = "day"
		if days <= 2 {
			q.Bucket = "hour"
		}
	case "day":
	case "hour":
		if days > mcpHistoryMaxHourlyDays {
			return fmt.Sprintf("hourly buckets are limited to %d days; use bucket 'day' or a shorter range", mcpHistoryMaxHourlyDays)
		}
	default:
		return "bucket must be 'day' or 'hour'"
	}

	q.Start = from
	q.End = to.AddDate(0, 0, 1)
	q.Days = days
	return ""
}

// mcpHistoryBucket is one step of the series.
type mcpHistoryBucket struct {
	Start           string         `json:"start"`
	SessionsStarted int            `json:"sessions_started"`
	UniqueListeners int            `json:"unique_listeners"`
	PeakConcurrent  int            `json:"peak_concurrent"`
	ListeningHours  float64        `json:"listening_hours"`
	ByProtocol      map[string]int `json:"sessions_started_by_protocol"`
}

// mcpHistoryTotals summarises the whole range, or one protocol within it.
type mcpHistoryTotals struct {
	SessionsStarted       int     `json:"sessions_started"`
	UniqueListeners       int     `json:"unique_listeners"`
	PeakConcurrent        int     `json:"peak_concurrent"`
	ListeningHours        float64 `json:"listening_hours"`
	MedianSessionMinutes  float64 `json:"median_session_minutes"`
	AverageSessionMinutes float64 `json:"average_session_minutes"`
}

// mcpHistoryEnd is when a session stopped counting: its end, or for one still
// open its last heartbeat. An open session's row is touched every few minutes,
// so last_seen trails the truth by at most one heartbeat, and unlike "now" it
// cannot inflate a session whose end was never written.
func mcpHistoryEnd(rec SessionHistoryRecord) time.Time {
	if rec.EndedAt != nil {
		return *rec.EndedAt
	}
	return rec.LastSeen
}

// mcpListenerKey identifies a listener: their IP, or the session's own ID for
// the rare row without one.
func mcpListenerKey(rec SessionHistoryRecord) string {
	if rec.ClientIP != "" {
		return "ip:" + rec.ClientIP
	}
	return "session:" + rec.UserSessionID
}

// mcpRecordProtocol is the protocol a session used. Rows written before the
// protocol column existed have none stored; the session ID prefix says the same.
func mcpRecordProtocol(rec SessionHistoryRecord) string {
	if rec.Protocol != "" {
		return rec.Protocol
	}
	return protocolFromUserSessionID(rec.UserSessionID)
}

// buildMCPSessionHistory folds session records into the get_session_history
// response. Pure apart from reading q, so it is tested without a database.
//
// Definitions, all within the requested window:
//   - sessions_started: sessions whose start falls in the bucket.
//   - unique_listeners: distinct listeners with a session overlapping the bucket.
//   - peak_concurrent: the most sessions open at any one moment in the bucket.
//   - listening_hours: total session time inside the bucket.
func buildMCPSessionHistory(records []SessionHistoryRecord, q mcpHistoryQuery) map[string]interface{} {
	// Bucket boundaries, built in local time so days and hours follow the
	// timezone through DST changes. The series stops at the current bucket.
	var bounds []time.Time
	for t := q.Start; t.Before(q.End) && !t.After(q.Now); {
		bounds = append(bounds, t)
		if q.Bucket == "hour" {
			t = t.Add(time.Hour)
		} else {
			t = t.AddDate(0, 0, 1)
		}
	}
	seriesEnd := q.End
	if q.Now.Before(seriesEnd) {
		seriesEnd = q.Now
	}
	bucketEnd := func(i int) time.Time {
		if i+1 < len(bounds) {
			return bounds[i+1]
		}
		return seriesEnd
	}
	bucketOf := func(t time.Time) int {
		i := sort.Search(len(bounds), func(i int) bool { return bounds[i].After(t) }) - 1
		if i < 0 || !t.Before(seriesEnd) {
			return -1
		}
		return i
	}

	type protoAgg struct {
		started   int
		listeners map[string]struct{}
		seconds   float64
		durations []float64 // minutes, of sessions started in range
		events    []mcpSweepEvent
	}
	newAgg := func() *protoAgg { return &protoAgg{listeners: map[string]struct{}{}} }
	all := newAgg()
	byProto := map[string]*protoAgg{}
	for _, p := range mcpProtocols {
		byProto[p] = newAgg()
	}

	buckets := make([]mcpHistoryBucket, len(bounds))
	bucketListeners := make([]map[string]struct{}, len(bounds))
	for i, b := range bounds {
		buckets[i] = mcpHistoryBucket{Start: b.Format(time.RFC3339), ByProtocol: map[string]int{}}
		for _, p := range mcpProtocols {
			buckets[i].ByProtocol[p] = 0
		}
		bucketListeners[i] = map[string]struct{}{}
	}

	countries := map[string]int{}
	countryCodes := map[string]string{}
	regions := newPlaceCounter()
	cities := newPlaceCounter()
	bands := map[string]int{}
	modes := map[string]int{}
	browsers := map[string]int{}
	oses := map[string]int{}

	for _, rec := range records {
		proto := mcpRecordProtocol(rec)
		if q.Protocol != "" && proto != q.Protocol {
			continue
		}
		if q.CountryCode != "" && !strings.EqualFold(rec.CountryCode, q.CountryCode) {
			continue
		}
		start, end := rec.StartedAt, mcpHistoryEnd(rec)
		if end.Before(start) {
			end = start
		}
		// Clip to the window; a session entirely outside it contributes nothing.
		clipStart, clipEnd := start, end
		if clipStart.Before(q.Start) {
			clipStart = q.Start
		}
		if clipEnd.After(seriesEnd) {
			clipEnd = seriesEnd
		}
		if clipEnd.Before(clipStart) || (clipEnd.Equal(clipStart) && !start.Equal(end)) {
			continue
		}

		key := mcpListenerKey(rec)
		agg := byProto[proto]
		if agg == nil {
			agg = newAgg()
			byProto[proto] = agg
		}
		for _, a := range []*protoAgg{all, agg} {
			a.listeners[key] = struct{}{}
			a.seconds += clipEnd.Sub(clipStart).Seconds()
			a.events = append(a.events, mcpSweepEvent{clipStart, +1}, mcpSweepEvent{clipEnd, -1})
		}

		// Overlap with each bucket the session touches: the one it starts in,
		// and every later one that begins before it ends. A session ending
		// exactly on a boundary does not reach into the next bucket.
		if first := bucketOf(clipStart); first >= 0 {
			for i := first; i < len(bounds); i++ {
				bs, be := bounds[i], bucketEnd(i)
				if i > first && !bs.Before(clipEnd) {
					break
				}
				s, e := clipStart, clipEnd
				if s.Before(bs) {
					s = bs
				}
				if e.After(be) {
					e = be
				}
				if e.After(s) {
					buckets[i].ListeningHours += e.Sub(s).Hours()
				}
				bucketListeners[i][key] = struct{}{}
			}
		}

		// Everything below describes sessions that started inside the range.
		bi := bucketOf(start)
		if start.Before(q.Start) || bi < 0 {
			continue
		}
		buckets[bi].SessionsStarted++
		buckets[bi].ByProtocol[proto]++
		minutes := end.Sub(start).Minutes()
		for _, a := range []*protoAgg{all, agg} {
			a.started++
			a.durations = append(a.durations, minutes)
		}

		country := rec.Country
		if country == "" {
			country = "Unknown"
		}
		countries[country]++
		if q.Locate != nil && rec.ClientIP != "" {
			region, city := q.Locate(rec.ClientIP)
			regionLabel := region
			if regionLabel == "" {
				regionLabel = "Unknown"
			}
			if q.CountryCode == "" {
				regionLabel = country + " / " + regionLabel
			}
			regions.add(regionLabel, key)
			if city != "" {
				cityLabel := city
				if region != "" {
					cityLabel += ", " + region
				}
				if q.CountryCode == "" {
					cityLabel += ", " + country
				}
				cities.add(cityLabel, key)
			}
		}
		if rec.CountryCode != "" && (countryCodes[country] == "" || rec.CountryCode < countryCodes[country]) {
			countryCodes[country] = rec.CountryCode
		}
		for _, b := range rec.Bands {
			bands[b]++
		}
		for _, md := range rec.Modes {
			modes[md]++
		}
		if rec.Browser != "" {
			browsers[rec.Browser]++
		}
		if rec.OS != "" {
			oses[rec.OS]++
		}
	}

	// Peak concurrency per bucket from one sweep over every start and end.
	peaks := mcpPeakPerBucket(all.events, bounds, seriesEnd)
	for i := range buckets {
		buckets[i].UniqueListeners = len(bucketListeners[i])
		buckets[i].PeakConcurrent = peaks[i]
		buckets[i].ListeningHours = roundTo(buckets[i].ListeningHours, 2)
	}

	totals := func(a *protoAgg) mcpHistoryTotals {
		t := mcpHistoryTotals{
			SessionsStarted: a.started,
			UniqueListeners: len(a.listeners),
			PeakConcurrent:  maxInts(mcpPeakPerBucket(a.events, bounds, seriesEnd)),
			ListeningHours:  roundTo(a.seconds/3600, 2),
		}
		if len(a.durations) > 0 {
			sorted := append([]float64(nil), a.durations...)
			sort.Float64s(sorted)
			mid := len(sorted) / 2
			median := sorted[mid]
			if len(sorted)%2 == 0 {
				median = (sorted[mid-1] + sorted[mid]) / 2
			}
			var sum float64
			for _, d := range sorted {
				sum += d
			}
			t.MedianSessionMinutes = roundTo(median, 1)
			t.AverageSessionMinutes = roundTo(sum/float64(len(sorted)), 1)
		}
		return t
	}

	protoTotals := map[string]mcpHistoryTotals{}
	for p, a := range byProto {
		if q.Protocol != "" && p != q.Protocol {
			continue
		}
		protoTotals[p] = totals(a)
	}

	topCountries := make([]map[string]interface{}, 0, len(countries))
	for _, entry := range rankCounts(countries, mcpHistoryTopN) {
		name, _ := entry["name"].(string)
		entry["country_code"] = countryCodes[name]
		topCountries = append(topCountries, entry)
	}

	filters := map[string]interface{}{"include_bypassed": q.IncludeBypassed}
	if q.Protocol != "" {
		filters["protocol"] = q.Protocol
	}
	if q.CountryCode != "" {
		filters["country_code"] = q.CountryCode
	}

	out := map[string]interface{}{
		"period": map[string]interface{}{
			"from_date": q.Start.Format("2006-01-02"),
			"to_date":   q.End.AddDate(0, 0, -1).Format("2006-01-02"),
			"days":      q.Days,
			"timezone":  q.Location.String(),
			"bucket":    q.Bucket,
			"complete":  !q.Now.Before(q.End),
		},
		"filters":               filters,
		"totals":                totals(all),
		"totals_by_protocol":    protoTotals,
		"series":                buckets,
		"top_countries":         topCountries,
		"top_bands":             rankCounts(bands, mcpHistoryTopN),
		"top_modes":             rankCounts(modes, mcpHistoryTopN),
		"top_browsers":          rankCounts(browsers, 10),
		"top_operating_systems": rankCounts(oses, 10),
		"definitions": map[string]string{
			"sessions_started": "sessions whose start falls in the bucket",
			"unique_listeners": "distinct listeners (by IP address) with a session overlapping the bucket",
			"peak_concurrent":  "the most sessions open at once at any moment in the bucket",
			"listening_hours":  "total session time that falls inside the bucket",
		},
	}
	if q.Locate != nil {
		out["top_regions"] = regions.top(mcpHistoryTopN)
		out["top_cities"] = cities.top(mcpHistoryTopN)
		out["location_note"] = "regions and cities are from GeoIP lookups of listener IP addresses at query time; they are approximate, and a VPN or mobile network can place a listener far from where they are"
	} else {
		out["location_note"] = "regions and cities are unavailable: GeoIP is not enabled on this receiver"
	}
	return out
}

// placeCounter counts sessions and distinct listeners per place.
type placeCounter struct {
	sessions  map[string]int
	listeners map[string]map[string]struct{}
}

func newPlaceCounter() *placeCounter {
	return &placeCounter{sessions: map[string]int{}, listeners: map[string]map[string]struct{}{}}
}

func (c *placeCounter) add(place, listener string) {
	c.sessions[place]++
	if c.listeners[place] == nil {
		c.listeners[place] = map[string]struct{}{}
	}
	c.listeners[place][listener] = struct{}{}
}

// top lists places with the most distinct listeners first (sessions, then
// name, break ties): "where are my listeners" is about people, and one
// listener reconnecting all day should not outrank a town of them.
func (c *placeCounter) top(n int) []map[string]interface{} {
	names := make([]string, 0, len(c.sessions))
	for name := range c.sessions {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		li, lj := len(c.listeners[names[i]]), len(c.listeners[names[j]])
		if li != lj {
			return li > lj
		}
		if c.sessions[names[i]] != c.sessions[names[j]] {
			return c.sessions[names[i]] > c.sessions[names[j]]
		}
		return names[i] < names[j]
	})
	if len(names) > n {
		names = names[:n]
	}
	out := make([]map[string]interface{}, len(names))
	for i, name := range names {
		out[i] = map[string]interface{}{
			"name":             name,
			"unique_listeners": len(c.listeners[name]),
			"sessions":         c.sessions[name],
		}
	}
	return out
}

// mcpSweepEvent is a session opening (+1) or closing (-1).
type mcpSweepEvent struct {
	at    time.Time
	delta int
}

// mcpPeakPerBucket returns, for each bucket, the most sessions open at once
// within it. Ends sort before starts at the same instant, so back-to-back
// sessions from a reconnect do not count as overlapping.
func mcpPeakPerBucket(events []mcpSweepEvent, bounds []time.Time, seriesEnd time.Time) []int {
	peaks := make([]int, len(bounds))
	if len(bounds) == 0 {
		return peaks
	}
	sorted := append([]mcpSweepEvent(nil), events...)
	sort.Slice(sorted, func(i, j int) bool {
		if !sorted[i].at.Equal(sorted[j].at) {
			return sorted[i].at.Before(sorted[j].at)
		}
		return sorted[i].delta < sorted[j].delta
	})

	open, e := 0, 0
	for i := range bounds {
		bs := bounds[i]
		be := seriesEnd
		if i+1 < len(bounds) {
			be = bounds[i+1]
		}
		// Sessions already open as the bucket begins.
		for e < len(sorted) && sorted[e].at.Before(bs) {
			open += sorted[e].delta
			e++
		}
		peak := open
		for e < len(sorted) && sorted[e].at.Before(be) {
			open += sorted[e].delta
			if open > peak {
				peak = open
			}
			e++
		}
		peaks[i] = peak
	}
	return peaks
}

func maxInts(v []int) int {
	m := 0
	for _, x := range v {
		if x > m {
			m = x
		}
	}
	return m
}

func roundTo(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
