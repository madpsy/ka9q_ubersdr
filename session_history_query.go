package main

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Read side of the normalised session tables.
//
// The public statistics are ordinary aggregate queries — the reason the schema
// exists. The admin views need whole sessions, so they get a record loader; the
// two that are still snapshot-shaped get their snapshots synthesised from
// session intervals, which keeps their response contracts unchanged.

// SessionHistoryRecord is one session read back from the normalised tables.
type SessionHistoryRecord struct {
	ID            int64
	UserSessionID string
	StartedAt     time.Time
	LastSeen      time.Time
	EndedAt       *time.Time
	ClientIP      string
	SourceIP      string
	AuthMethod    string
	Protocol      string
	Country       string
	CountryCode   string
	Latitude      *float64
	Longitude     *float64
	UserAgent     string
	Browser       string
	OS            string
	HasAudio      bool
	HasSpectrum   bool
	Bands         []string
	Modes         []string
}

// authMethodValues maps the filter names the admin API uses onto the values
// stored in session.auth_method.
func authMethodValues(filterNames []string) []string {
	values := make([]string, 0, len(filterNames))
	for _, name := range filterNames {
		switch strings.TrimSpace(name) {
		case "regular":
			values = append(values, "")
		case "password":
			values = append(values, "password")
		case "bypassed":
			values = append(values, "ip_bypass")
		}
	}
	return values
}

// authMethodClause builds a SQL predicate restricting to the given filter names.
func authMethodClause(filterNames []string) (string, []interface{}) {
	values := authMethodValues(filterNames)
	if len(values) == 0 {
		return "", nil
	}
	args := make([]interface{}, len(values))
	placeholders := make([]string, len(values))
	for i, v := range values {
		args[i] = v
		placeholders[i] = "?"
	}
	return " AND COALESCE(session.auth_method, '') IN (" + strings.Join(placeholders, ",") + ")", args
}

// LoadSessionRecords returns every session overlapping [startTime, endTime],
// with its bands and modes attached.
func LoadSessionRecords(db *sql.DB, startTime, endTime time.Time, authMethods []string) ([]SessionHistoryRecord, error) {
	if db == nil {
		return nil, fmt.Errorf("session database not configured")
	}

	clause, clauseArgs := authMethodClause(authMethods)
	args := append([]interface{}{endTime.Unix(), startTime.Unix()}, clauseArgs...)

	rows, err := db.Query(`
		SELECT session.id, session.user_session_id, session.started_at, session.ended_at,
		       session.last_seen, COALESCE(session.client_ip, ''), COALESCE(session.source_ip, ''),
		       COALESCE(session.auth_method, ''), COALESCE(session.protocol, ''),
		       COALESCE(session.country, ''), COALESCE(session.country_code, ''),
		       session.latitude, session.longitude,
		       COALESCE(user_agent.ua, ''), COALESCE(user_agent.browser, ''), COALESCE(user_agent.os, ''),
		       session.has_audio, session.has_spectrum
		FROM session
		LEFT JOIN user_agent ON user_agent.id = session.user_agent_id
		WHERE session.started_at <= ?
		  AND (session.ended_at IS NULL OR session.ended_at >= ?)`+clause+`
		ORDER BY session.started_at`, args...)
	if err != nil {
		return nil, fmt.Errorf("session query: %w", err)
	}
	defer rows.Close()

	var records []SessionHistoryRecord
	byID := make(map[int64]*SessionHistoryRecord)
	for rows.Next() {
		var rec SessionHistoryRecord
		var startedAt, lastSeen int64
		var endedAt sql.NullInt64
		if err := rows.Scan(
			&rec.ID, &rec.UserSessionID, &startedAt, &endedAt, &lastSeen,
			&rec.ClientIP, &rec.SourceIP, &rec.AuthMethod, &rec.Protocol,
			&rec.Country, &rec.CountryCode, &rec.Latitude, &rec.Longitude,
			&rec.UserAgent, &rec.Browser, &rec.OS, &rec.HasAudio, &rec.HasSpectrum,
		); err != nil {
			return nil, fmt.Errorf("session scan: %w", err)
		}
		rec.StartedAt = time.Unix(startedAt, 0).UTC()
		rec.LastSeen = time.Unix(lastSeen, 0).UTC()
		if endedAt.Valid {
			t := time.Unix(endedAt.Int64, 0).UTC()
			rec.EndedAt = &t
		}
		records = append(records, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range records {
		byID[records[i].ID] = &records[i]
	}

	// Bands and modes in one pass each, rather than a query per session.
	attach := func(table, column string, assign func(*SessionHistoryRecord, string)) error {
		q := fmt.Sprintf(`
			SELECT child.session_id, child.%s
			FROM %s AS child
			JOIN session ON session.id = child.session_id
			WHERE session.started_at <= ?
			  AND (session.ended_at IS NULL OR session.ended_at >= ?)`+clause, column, table)
		childRows, err := db.Query(q, args...)
		if err != nil {
			return fmt.Errorf("%s query: %w", table, err)
		}
		defer childRows.Close()
		for childRows.Next() {
			var id int64
			var value string
			if err := childRows.Scan(&id, &value); err != nil {
				return fmt.Errorf("%s scan: %w", table, err)
			}
			if rec := byID[id]; rec != nil {
				assign(rec, value)
			}
		}
		return childRows.Err()
	}

	if err := attach("session_band", "band", func(r *SessionHistoryRecord, v string) { r.Bands = append(r.Bands, v) }); err != nil {
		return nil, err
	}
	if err := attach("session_mode", "mode", func(r *SessionHistoryRecord, v string) { r.Modes = append(r.Modes, v) }); err != nil {
		return nil, err
	}
	for i := range records {
		sort.Strings(records[i].Bands)
		sort.Strings(records[i].Modes)
	}

	return records, nil
}

// SessionEventsFromRecords turns sessions into the start/end event stream the
// admin views consume. Starts and ends are now exact, rather than inferred from
// a session's absence from the next snapshot.
func SessionEventsFromRecords(records []SessionHistoryRecord) []SessionEvent {
	events := make([]SessionEvent, 0, len(records)*2)
	for _, rec := range records {
		base := SessionEvent{
			UserSessionID: rec.UserSessionID,
			ClientIP:      rec.ClientIP,
			SourceIP:      rec.SourceIP,
			AuthMethod:    rec.AuthMethod,
			SessionTypes:  rec.sessionTypes(),
			Bands:         rec.Bands,
			Modes:         rec.Modes,
			UserAgent:     rec.UserAgent,
			Country:       rec.Country,
			CountryCode:   rec.CountryCode,
			Protocol:      rec.Protocol,
		}

		start := base
		start.Timestamp = rec.StartedAt
		start.EventType = "session_start"
		events = append(events, start)

		if rec.EndedAt != nil {
			duration := rec.EndedAt.Sub(rec.StartedAt).Seconds()
			end := base
			end.Timestamp = *rec.EndedAt
			end.EventType = "session_end"
			end.Duration = &duration
			events = append(events, end)
		}
	}

	// Most recent first, matching the order convertLogsToEvents returned.
	sort.Slice(events, func(i, j int) bool { return events[i].Timestamp.After(events[j].Timestamp) })
	return events
}

func (r SessionHistoryRecord) sessionTypes() []string {
	types := make([]string, 0, 2)
	if r.HasAudio {
		types = append(types, "audio")
	}
	if r.HasSpectrum {
		types = append(types, "spectrum")
	}
	return types
}

// SynthesiseActivityLogs rebuilds snapshot-shaped data from session intervals, so
// the admin endpoints that still speak in snapshots keep their response shape.
// A session appears in every snapshot between its start and its end.
func SynthesiseActivityLogs(records []SessionHistoryRecord, startTime, endTime time.Time, interval time.Duration) []SessionActivityLog {
	if interval <= 0 {
		interval = 5 * time.Minute
	}

	logs := make([]SessionActivityLog, 0)
	for ts := startTime.Truncate(interval); !ts.After(endTime); ts = ts.Add(interval) {
		entry := SessionActivityLog{
			Timestamp:      ts,
			EventType:      "snapshot",
			ActiveSessions: []SessionActivityEntry{},
		}
		for _, rec := range records {
			if rec.StartedAt.After(ts) {
				continue
			}
			if rec.EndedAt != nil && rec.EndedAt.Before(ts) {
				continue
			}
			entry.ActiveSessions = append(entry.ActiveSessions, SessionActivityEntry{
				UserSessionID: rec.UserSessionID,
				ClientIP:      rec.ClientIP,
				SourceIP:      rec.SourceIP,
				AuthMethod:    rec.AuthMethod,
				SessionTypes:  rec.sessionTypes(),
				Bands:         rec.Bands,
				Modes:         rec.Modes,
				CreatedAt:     rec.StartedAt,
				FirstSeen:     rec.StartedAt,
				UserAgent:     rec.UserAgent,
				Country:       rec.Country,
				CountryCode:   rec.CountryCode,
				Protocol:      rec.Protocol,
			})
		}
		if len(entry.ActiveSessions) > 0 {
			logs = append(logs, entry)
		}
	}
	return logs
}

// ─── public statistics ────────────────────────────────────────────────────────

// PublicSessionStatsFromDB computes the public statistics from the session
// tables. This replaces a fold that replayed every snapshot row in the retention
// window; its cost is linear in the sessions that ended inside the window, not in
// the length of the retention.
//
// Everything but bands and modes comes from one scan of the window, aggregated
// here: each pass over the window costs as much as the next, so one scan instead
// of seven halves the time. Bands and modes are one-to-many, so they are counted
// in SQL by a second query.
//
// Only sessions that ended inside the window count, matching the old behaviour of
// aggregating session_end events.
func PublicSessionStatsFromDB(db *sql.DB, startTime, endTime time.Time) (map[string]interface{}, error) {
	if db == nil {
		return nil, fmt.Errorf("session database not configured")
	}

	// "Regular" auth users only, as the endpoint has always done.
	const where = `WHERE session.ended_at >= ? AND session.ended_at <= ? AND COALESCE(session.auth_method, '') = ''`
	args := []interface{}{startTime.Unix(), endTime.Unix()}

	rows, err := db.Query(`
		SELECT session.started_at, session.ended_at, COALESCE(session.client_ip, ''),
		       COALESCE(NULLIF(session.country, ''), 'Unknown'), COALESCE(session.country_code, ''),
		       session.latitude, session.longitude,
		       COALESCE(user_agent.browser, ''), COALESCE(user_agent.os, '')
		FROM session LEFT JOIN user_agent ON session.user_agent_id = user_agent.id `+where, args...)
	if err != nil {
		return nil, fmt.Errorf("sessions: %w", err)
	}
	defer rows.Close()

	type countryAgg struct {
		code      string
		sessions  int
		locations map[[2]float64]int
	}
	var (
		totalSessions int
		earliest      int64
		durations     = make([]int, len(publicDurationBuckets))
		hourly        = make([]int, 24)
		weekday       = make([]int, 7)
		users         = map[string]struct{}{}
		browsers      = map[string]int{}
		oses          = map[string]int{}
		countries     = map[string]*countryAgg{}
	)
	for rows.Next() {
		var started, ended int64
		var ip, country, code, browser, osName string
		var lat, lon sql.NullFloat64
		if err := rows.Scan(&started, &ended, &ip, &country, &code, &lat, &lon, &browser, &osName); err != nil {
			return nil, err
		}

		if totalSessions == 0 || ended < earliest {
			earliest = ended
		}
		totalSessions++
		if ip != "" {
			users[ip] = struct{}{}
		}
		if browser != "" {
			browsers[browser]++
		}
		if osName != "" {
			oses[osName]++
		}

		bucket := len(publicDurationBuckets) - 1
		for i, b := range publicDurationBuckets[:bucket] {
			if ended-started < b.below {
				bucket = i
				break
			}
		}
		durations[bucket]++

		at := time.Unix(ended, 0).UTC()
		hourly[at.Hour()]++
		weekday[at.Weekday()]++

		agg := countries[country]
		if agg == nil {
			agg = &countryAgg{locations: map[[2]float64]int{}}
			countries[country] = agg
		}
		// A country seen under several codes reports the lowest non-empty one.
		if code != "" && (agg.code == "" || code < agg.code) {
			agg.code = code
		}
		agg.sessions++
		if lat.Valid && lon.Valid {
			agg.locations[[2]float64{lat.Float64, lon.Float64}]++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	bands, modes, err := queryBandsAndModes(db, where, args)
	if err != nil {
		return nil, err
	}

	// Averages are over the span actually covered by data, not the nominal
	// window: a receiver with two days of history must not have its activity
	// divided by 28.
	observedStart := startTime
	if totalSessions > 0 {
		if t := time.Unix(earliest, 0).UTC(); t.After(startTime) {
			observedStart = t
		}
	}
	observedDays := endTime.Sub(observedStart).Hours() / 24.0
	if observedDays < 1 {
		observedDays = 1
	}
	observedWeeks := observedDays / 7.0
	if observedWeeks < 1 {
		observedWeeks = 1
	}
	avgHourly := make([]float64, 24)
	for i, n := range hourly {
		avgHourly[i] = float64(n) / observedDays
	}
	avgWeekday := make([]float64, 7)
	for i, n := range weekday {
		avgWeekday[i] = float64(n) / observedWeeks
	}

	durationBuckets := make([]map[string]interface{}, len(publicDurationBuckets))
	for i, b := range publicDurationBuckets {
		durationBuckets[i] = map[string]interface{}{"range": b.name, "count": durations[i]}
	}
	sort.SliceStable(durationBuckets, func(i, j int) bool {
		return durationBuckets[i]["count"].(int) > durationBuckets[j]["count"].(int)
	})

	countryList := make([]map[string]interface{}, 0, len(countries))
	for name, agg := range countries {
		// Points closer than the precision shown on the map are one point.
		merged := map[string]map[string]interface{}{}
		for ll, n := range agg.locations {
			key := fmt.Sprintf("%.4f,%.4f", ll[0], ll[1])
			if loc, ok := merged[key]; ok {
				loc["sessions"] = loc["sessions"].(int) + n
			} else {
				merged[key] = map[string]interface{}{"latitude": ll[0], "longitude": ll[1], "sessions": n}
			}
		}
		locations := make([]map[string]interface{}, 0, len(merged))
		for _, loc := range merged {
			locations = append(locations, loc)
		}
		countryList = append(countryList, map[string]interface{}{
			"country":      name,
			"country_code": agg.code,
			"sessions":     agg.sessions,
			"locations":    locations,
		})
	}
	sort.Slice(countryList, func(i, j int) bool {
		a, b := countryList[i], countryList[j]
		if a["sessions"].(int) != b["sessions"].(int) {
			return a["sessions"].(int) > b["sessions"].(int)
		}
		return a["country"].(string) < b["country"].(string)
	})

	return map[string]interface{}{
		"unique_countries":      len(countryList),
		"countries":             countryList,
		"unique_users":          len(users),
		"total_sessions":        totalSessions,
		"duration_buckets":      durationBuckets,
		"avg_hourly_activity":   avgHourly,
		"avg_weekday_activity":  avgWeekday,
		"top_browsers":          rankCounts(browsers, 10),
		"top_operating_systems": rankCounts(oses, 10),
		"top_bands":             rankCounts(bands, 0),
		"top_modes":             rankCounts(modes, 0),
	}, nil
}

// publicDurationBuckets are the session-length ranges, shortest first. The last
// one is open-ended; its bound is never compared.
var publicDurationBuckets = []struct {
	name  string
	below int64 // seconds
}{
	{"0-1min", 60},
	{"1-5min", 300},
	{"5-15min", 900},
	{"15-30min", 1800},
	{"30-60min", 3600},
	{"60-120min", 7200},
	{"120min+", 0},
}

// queryBandsAndModes counts the sessions that visited each band and used each
// mode, in one round trip.
func queryBandsAndModes(db *sql.DB, where string, args []interface{}) (bands, modes map[string]int, err error) {
	rows, err := db.Query(`
		SELECT 0, session_band.band, COUNT(*) FROM session
		JOIN session_band ON session_band.session_id = session.id `+where+` AND session_band.band != ''
		GROUP BY 2
		UNION ALL
		SELECT 1, session_mode.mode, COUNT(*) FROM session
		JOIN session_mode ON session_mode.session_id = session.id `+where+` AND session_mode.mode != ''
		GROUP BY 2`, append(append([]interface{}{}, args...), args...)...)
	if err != nil {
		return nil, nil, fmt.Errorf("bands and modes: %w", err)
	}
	defer rows.Close()

	bands, modes = map[string]int{}, map[string]int{}
	for rows.Next() {
		var kind, n int
		var label string
		if err := rows.Scan(&kind, &label, &n); err != nil {
			return nil, nil, err
		}
		if kind == 0 {
			bands[label] = n
		} else {
			modes[label] = n
		}
	}
	return bands, modes, rows.Err()
}

// rankCounts lists counts most common first, ties by name. limit <= 0 keeps all.
func rankCounts(counts map[string]int, limit int) []map[string]interface{} {
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	if limit > 0 && len(names) > limit {
		names = names[:limit]
	}
	out := make([]map[string]interface{}, len(names))
	for i, name := range names {
		out[i] = map[string]interface{}{"name": name, "sessions": counts[name]}
	}
	return out
}

// SessionBucketsFromRecords counts the sessions active at each bucket boundary,
// split by auth method — the shape the admin activity chart consumes.
//
// The old implementation sampled the snapshot log and took the peak within each
// bucket. Sessions are intervals now, so the count at each instant is exact, and
// a sweep over starts and ends makes it linear in buckets plus sessions rather
// than materialising a snapshot per bucket.
func SessionBucketsFromRecords(records []SessionHistoryRecord, startTime, endTime time.Time, bucketMinutes int) []map[string]interface{} {
	if bucketMinutes <= 0 {
		bucketMinutes = 5
	}
	bucketDuration := time.Duration(bucketMinutes) * time.Minute

	firstBucket := startTime.Truncate(bucketDuration)
	lastBucket := endTime.Truncate(bucketDuration)
	if lastBucket.Before(firstBucket) {
		return []map[string]interface{}{}
	}

	// Starts and ends per auth method, each sorted, so a pair of pointers can
	// walk them alongside the ascending buckets.
	type timeline struct{ starts, ends []int64 }
	timelines := map[string]*timeline{
		"regular":  {},
		"password": {},
		"bypassed": {},
	}
	for _, rec := range records {
		name := "regular"
		switch rec.AuthMethod {
		case "password":
			name = "password"
		case "ip_bypass":
			name = "bypassed"
		}
		tl := timelines[name]
		tl.starts = append(tl.starts, rec.StartedAt.Unix())
		end := endTime.Unix()
		if rec.EndedAt != nil {
			end = rec.EndedAt.Unix()
		}
		tl.ends = append(tl.ends, end)
	}
	for _, tl := range timelines {
		sort.Slice(tl.starts, func(i, j int) bool { return tl.starts[i] < tl.starts[j] })
		sort.Slice(tl.ends, func(i, j int) bool { return tl.ends[i] < tl.ends[j] })
	}

	cursors := map[string]*struct{ started, ended int }{
		"regular":  {},
		"password": {},
		"bypassed": {},
	}

	out := make([]map[string]interface{}, 0)
	for ts := firstBucket; !ts.After(lastBucket); ts = ts.Add(bucketDuration) {
		unix := ts.Unix()
		counts := map[string]int{}
		for name, tl := range timelines {
			cur := cursors[name]
			for cur.started < len(tl.starts) && tl.starts[cur.started] <= unix {
				cur.started++
			}
			for cur.ended < len(tl.ends) && tl.ends[cur.ended] < unix {
				cur.ended++
			}
			counts[name] = cur.started - cur.ended
		}
		out = append(out, map[string]interface{}{
			"timestamp": ts.Format(time.RFC3339),
			"auth_breakdown": map[string]int{
				"regular":  counts["regular"],
				"password": counts["password"],
				"bypassed": counts["bypassed"],
			},
		})
	}
	return out
}
