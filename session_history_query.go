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

// PublicSessionStatsFromDB computes the public statistics with aggregate queries
// over the session tables. This replaces a fold that replayed every snapshot row
// in the retention window; on a real receiver it is milliseconds rather than
// seconds, and its cost does not grow with the length of the window.
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

	var totalSessions, uniqueUsers int
	var earliest sql.NullInt64
	if err := db.QueryRow(`
		SELECT COUNT(*), COUNT(DISTINCT NULLIF(session.client_ip, '')), MIN(session.ended_at)
		FROM session `+where, args...).Scan(&totalSessions, &uniqueUsers, &earliest); err != nil {
		return nil, fmt.Errorf("totals: %w", err)
	}

	// Averages are over the span actually covered by data, not the nominal
	// window: a receiver with two days of history must not have its activity
	// divided by 28.
	observedStart := startTime
	if earliest.Valid {
		if t := time.Unix(earliest.Int64, 0).UTC(); t.After(startTime) {
			observedStart = t
		}
	}
	observedDays := endTime.Sub(observedStart).Hours() / 24.0
	if observedDays < 1 {
		observedDays = 1
	}

	durationBuckets, err := queryDurationBuckets(db, where, args)
	if err != nil {
		return nil, err
	}
	hourly, err := queryBucketedCounts(db, `CAST(strftime('%H', session.ended_at, 'unixepoch') AS INTEGER)`, 24, where, args)
	if err != nil {
		return nil, fmt.Errorf("hourly: %w", err)
	}
	weekday, err := queryBucketedCounts(db, `CAST(strftime('%w', session.ended_at, 'unixepoch') AS INTEGER)`, 7, where, args)
	if err != nil {
		return nil, fmt.Errorf("weekday: %w", err)
	}

	avgHourly := make([]float64, 24)
	for i, n := range hourly {
		avgHourly[i] = float64(n) / observedDays
	}
	avgWeekday := make([]float64, 7)
	observedWeeks := observedDays / 7.0
	if observedWeeks < 1 {
		observedWeeks = 1
	}
	for i, n := range weekday {
		avgWeekday[i] = float64(n) / observedWeeks
	}

	countries, err := queryCountries(db, where, args)
	if err != nil {
		return nil, err
	}
	browsers, err := queryTopJoined(db, "user_agent", "user_agent.browser", "session.user_agent_id = user_agent.id", where, args, 10)
	if err != nil {
		return nil, fmt.Errorf("browsers: %w", err)
	}
	operatingSystems, err := queryTopJoined(db, "user_agent", "user_agent.os", "session.user_agent_id = user_agent.id", where, args, 10)
	if err != nil {
		return nil, fmt.Errorf("operating systems: %w", err)
	}
	bands, err := queryTopJoined(db, "session_band", "session_band.band", "session_band.session_id = session.id", where, args, 0)
	if err != nil {
		return nil, fmt.Errorf("bands: %w", err)
	}
	modes, err := queryTopJoined(db, "session_mode", "session_mode.mode", "session_mode.session_id = session.id", where, args, 0)
	if err != nil {
		return nil, fmt.Errorf("modes: %w", err)
	}

	return map[string]interface{}{
		"unique_countries":      len(countries),
		"countries":             countries,
		"unique_users":          uniqueUsers,
		"total_sessions":        totalSessions,
		"duration_buckets":      durationBuckets,
		"avg_hourly_activity":   avgHourly,
		"avg_weekday_activity":  avgWeekday,
		"top_browsers":          browsers,
		"top_operating_systems": operatingSystems,
		"top_bands":             bands,
		"top_modes":             modes,
	}, nil
}

// queryDurationBuckets groups sessions by how long they lasted.
func queryDurationBuckets(db *sql.DB, where string, args []interface{}) ([]map[string]interface{}, error) {
	const bucketExpr = `
		CASE
			WHEN (session.ended_at - session.started_at) <   60 THEN '0-1min'
			WHEN (session.ended_at - session.started_at) <  300 THEN '1-5min'
			WHEN (session.ended_at - session.started_at) <  900 THEN '5-15min'
			WHEN (session.ended_at - session.started_at) < 1800 THEN '15-30min'
			WHEN (session.ended_at - session.started_at) < 3600 THEN '30-60min'
			WHEN (session.ended_at - session.started_at) < 7200 THEN '60-120min'
			ELSE '120min+'
		END`

	counts := map[string]int{}
	rows, err := db.Query(`SELECT `+bucketExpr+` AS bucket, COUNT(*) FROM session `+where+` GROUP BY bucket`, args...)
	if err != nil {
		return nil, fmt.Errorf("duration buckets: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var bucket string
		var n int
		if err := rows.Scan(&bucket, &n); err != nil {
			return nil, err
		}
		counts[bucket] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]map[string]interface{}, 0, 7)
	for _, name := range []string{"0-1min", "1-5min", "5-15min", "15-30min", "30-60min", "60-120min", "120min+"} {
		out = append(out, map[string]interface{}{"range": name, "count": counts[name]})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i]["count"].(int) > out[j]["count"].(int) })
	return out, nil
}

// queryBucketedCounts counts sessions per value of a small integer expression.
func queryBucketedCounts(db *sql.DB, expr string, size int, where string, args []interface{}) ([]int, error) {
	counts := make([]int, size)
	rows, err := db.Query(`SELECT `+expr+` AS bucket, COUNT(*) FROM session `+where+` GROUP BY bucket`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var bucket, n int
		if err := rows.Scan(&bucket, &n); err != nil {
			return nil, err
		}
		if bucket >= 0 && bucket < size {
			counts[bucket] = n
		}
	}
	return counts, rows.Err()
}

// queryCountries groups sessions by country, with the distinct coordinates seen
// for each so the map still has points to plot.
func queryCountries(db *sql.DB, where string, args []interface{}) ([]map[string]interface{}, error) {
	type countryAgg struct {
		name      string
		code      string
		sessions  int
		locations map[string]map[string]interface{}
	}
	byName := map[string]*countryAgg{}

	rows, err := db.Query(`
		SELECT COALESCE(NULLIF(session.country, ''), 'Unknown'), COALESCE(session.country_code, ''),
		       session.latitude, session.longitude, COUNT(*)
		FROM session `+where+`
		GROUP BY 1, 2, 3, 4`, args...)
	if err != nil {
		return nil, fmt.Errorf("countries: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name, code string
		var lat, lon sql.NullFloat64
		var n int
		if err := rows.Scan(&name, &code, &lat, &lon, &n); err != nil {
			return nil, err
		}
		agg := byName[name]
		if agg == nil {
			agg = &countryAgg{name: name, code: code, locations: map[string]map[string]interface{}{}}
			byName[name] = agg
		}
		if agg.code == "" {
			agg.code = code
		}
		agg.sessions += n
		if lat.Valid && lon.Valid {
			key := fmt.Sprintf("%.4f,%.4f", lat.Float64, lon.Float64)
			if loc, ok := agg.locations[key]; ok {
				loc["sessions"] = loc["sessions"].(int) + n
			} else {
				agg.locations[key] = map[string]interface{}{
					"latitude": lat.Float64, "longitude": lon.Float64, "sessions": n,
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]map[string]interface{}, 0, len(byName))
	for _, agg := range byName {
		locations := make([]map[string]interface{}, 0, len(agg.locations))
		for _, loc := range agg.locations {
			locations = append(locations, loc)
		}
		out = append(out, map[string]interface{}{
			"country":      agg.name,
			"country_code": agg.code,
			"sessions":     agg.sessions,
			"locations":    locations,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["sessions"].(int) > out[j]["sessions"].(int) })
	return out, nil
}

// queryTopJoined counts sessions per value of a joined column, most common first.
// limit <= 0 returns every value.
func queryTopJoined(db *sql.DB, table, column, on, where string, args []interface{}, limit int) ([]map[string]interface{}, error) {
	q := `SELECT ` + column + ` AS label, COUNT(*) FROM session
	      JOIN ` + table + ` ON ` + on + ` ` + where + `
	      AND ` + column + ` IS NOT NULL AND ` + column + ` != ''
	      GROUP BY label ORDER BY COUNT(*) DESC`
	if limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", limit)
	}

	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []map[string]interface{}{}
	for rows.Next() {
		var label string
		var n int
		if err := rows.Scan(&label, &n); err != nil {
			return nil, err
		}
		out = append(out, map[string]interface{}{"name": label, "sessions": n})
	}
	return out, rows.Err()
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
