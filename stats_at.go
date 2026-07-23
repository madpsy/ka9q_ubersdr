package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// stats_at.go — shared point-in-time (?at=) support for the three public
// /api/stats/* history endpoints.
//
// Each of the three sources stores complete snapshots rather than a rolled-up
// summary, so the state of any leaderboard at a past instant can be replayed
// exactly by loading the snapshot nearest that instant:
//
//	psk-rank   — psk_rank_snapshots/_entries/psk_software, one per hourly scrape
//	wspr-rank  — wspr_rank_windows/_rows, one per hourly fetch (three windows)
//	rbn        — rbn_skew/rbn_stats, one per UTC day
//
// This file holds the parameter validation and the small response helpers all
// three share. The per-source nearest-snapshot SQL lives in stats_logger_db.go
// and the handlers in stats_{psk,wspr,rbn}_history.go.
//
// Every value below is caller-supplied over the public internet: parse first,
// reject anything not matching an explicit whitelist, and never interpolate a
// caller string into SQL or echo it back unvalidated.

const (
	// statsAtMaxParamLen caps the raw ?at= string before any parsing.
	statsAtMaxParamLen = 32

	// statsAtMinYear rejects timestamps predating any plausible retained data.
	statsAtMinYear = 2010

	// Search windows: how far either side of the requested instant a snapshot
	// may be found. Sized to the source's own fetch cadence, so a miss means
	// the requested time genuinely is not covered by the retained data.
	pskAtSearchWindow  = 24 * time.Hour     // hourly scrapes
	wsprAtSearchWindow = 24 * time.Hour     // hourly fetches
	rbnAtSearchWindow  = 3 * 24 * time.Hour // one fetch per UTC day; tolerates a couple of missed days

	// Row limits for the two sources whose snapshots hold thousands of rows.
	statsAtDefaultLimit = 100
	statsAtMaxLimit     = 1000
)

// statsAtLayouts are tried in order against the ?at= value.
var statsAtLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
}

// reUnixSeconds matches a bare Unix-seconds timestamp (9–11 digits keeps the
// value inside a range time.Unix can represent sensibly).
var reUnixSeconds = regexp.MustCompile(`^\d{9,11}$`)

// parseStatsAtParam validates and parses an ?at= query value into a UTC
// instant. Returns a non-empty error string when the value is unusable.
//
// Accepted: RFC3339, YYYY-MM-DDTHH:MM[:SS], YYYY-MM-DD HH:MM[:SS], YYYY-MM-DD,
// or Unix seconds. A value without a zone offset is read as UTC.
func parseStatsAtParam(raw string) (time.Time, string) {
	if len(raw) > statsAtMaxParamLen {
		return time.Time{}, "at parameter too long"
	}

	var parsed time.Time
	if reUnixSeconds.MatchString(raw) {
		secs, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return time.Time{}, "invalid at — not a valid Unix timestamp"
		}
		parsed = time.Unix(secs, 0).UTC()
	} else {
		ok := false
		for _, layout := range statsAtLayouts {
			t, err := time.Parse(layout, raw)
			if err == nil {
				parsed = t.UTC()
				ok = true
				break
			}
		}
		if !ok {
			return time.Time{}, "invalid at — use RFC3339, YYYY-MM-DDTHH:MM[:SS], YYYY-MM-DD or Unix seconds (UTC)"
		}
	}

	if parsed.Year() < statsAtMinYear {
		return time.Time{}, fmt.Sprintf("at is too far in the past — must be %d or later", statsAtMinYear)
	}
	// One window of slack: a clock a little ahead of ours is not an error.
	if parsed.After(time.Now().UTC().Add(24 * time.Hour)) {
		return time.Time{}, "at is in the future"
	}
	return parsed, ""
}

// parseStatsAtLimit validates the ?limit= row cap. An empty value yields the
// default; anything non-numeric, zero, negative or above statsAtMaxLimit is
// rejected rather than silently clamped, so a caller is never misled about how
// much of the leaderboard they received.
func parseStatsAtLimit(raw string) (int, string) {
	if raw == "" {
		return statsAtDefaultLimit, ""
	}
	if len(raw) > 5 {
		return 0, "invalid limit"
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, "invalid limit — must be a whole number"
	}
	if n < 1 || n > statsAtMaxLimit {
		return 0, fmt.Sprintf("invalid limit — must be between 1 and %d", statsAtMaxLimit)
	}
	return n, ""
}

// statsAtCommon is embedded in every ?at= response so all three endpoints
// describe the match the same way.
type statsAtCommon struct {
	Mode          string `json:"mode"` // always "at"
	RequestedAt   string `json:"requested_at"`
	OffsetSeconds int64  `json:"offset_seconds"` // snapshot time − requested time; negative = snapshot is older
	WindowSeconds int64  `json:"window_seconds"`
	Limit         int    `json:"limit,omitempty"`
}

// newStatsAtCommon builds the shared header for a matched snapshot.
func newStatsAtCommon(at, snapshotAt time.Time, window time.Duration, limit int) statsAtCommon {
	return statsAtCommon{
		Mode:          "at",
		RequestedAt:   formatStatsAtTime(at),
		OffsetSeconds: snapshotAt.UTC().Unix() - at.Unix(),
		WindowSeconds: int64(window / time.Second),
		Limit:         limit,
	}
}

// formatStatsAtTime renders a timestamp in the Z-suffixed form all the
// /api/stats/* endpoints already use.
func formatStatsAtTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

// writeStatsError sends a JSON {"error": …} body with the given status.
func writeStatsError(w http.ResponseWriter, status int, msg string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// writeStatsAtNotFound reports that no snapshot exists near the requested time.
func writeStatsAtNotFound(w http.ResponseWriter, source string, at time.Time, window time.Duration) {
	w.WriteHeader(http.StatusNotFound)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error":          fmt.Sprintf("no %s snapshot found near that time", source),
		"requested_at":   formatStatsAtTime(at),
		"window_seconds": int64(window / time.Second),
	})
}

// rejectCallsignWithAt reports the callsign+at combination as a bad request.
// Point-in-time responses are the whole leaderboard by definition, so the two
// filters are mutually exclusive rather than composable.
func rejectCallsignWithAt(w http.ResponseWriter, r *http.Request) bool {
	q := r.URL.Query()
	if strings.TrimSpace(q.Get("callsign")) == "" && strings.TrimSpace(q.Get("callsign2")) == "" {
		return false
	}
	writeStatsError(w, http.StatusBadRequest,
		"callsign cannot be combined with at — the point-in-time response is the full leaderboard")
	return true
}

// truncateAt returns the first limit elements of a slice along with the
// original length, so a response can report what it left out.
func truncateAt[T any](rows []T, limit int) (out []T, total int) {
	total = len(rows)
	if limit > 0 && total > limit {
		return rows[:limit], total
	}
	return rows, total
}
