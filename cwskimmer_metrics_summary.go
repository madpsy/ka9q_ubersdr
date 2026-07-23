package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

// CWMetricsSummaryAggregator aggregates CW metrics into time-period summaries in
// memory and periodically persists them to the cw_metrics_summary SQLite table.
type CWMetricsSummaryAggregator struct {
	// summaryDir is retained only for db_import.go historical backfill.
	summaryDir string

	// In-memory summaries (key: "band:period:date")
	summaries map[string]*CWMetricsSummary
	mu        sync.RWMutex

	// DB persistence
	db     *sql.DB // write connection
	readDB *sql.DB // read-only pool

	// Periodic flush control
	writeInterval time.Duration
	lastWrite     time.Time
	writeMu       sync.Mutex
}

// SetDB wires the SQLite write connection and read pool, then loads existing
// summaries for the current periods into memory.
func (msa *CWMetricsSummaryAggregator) SetDB(db, readDB *sql.DB) {
	msa.db = db
	msa.readDB = readDB
	if err := msa.loadExistingSummaries(); err != nil {
		log.Printf("Warning: failed to load existing CW summaries: %v", err)
	}
}

// CWMetricsSummary represents aggregated CW metrics for a specific time period
type CWMetricsSummary struct {
	Period    string    `json:"period"` // "day", "week", "month", "year"
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
	Band      string    `json:"band"`

	// Tracking for incremental updates
	LastUpdated time.Time `json:"last_updated"`

	// Aggregated metrics
	TotalSpots       int64   `json:"total_spots"`
	UniqueCallsigns  int     `json:"unique_callsigns"`
	PeakSpotsPerHour float64 `json:"peak_spots_per_hour"`
	AvgSpotsPerHour  float64 `json:"avg_spots_per_hour"`
	AvgWPM           float64 `json:"avg_wpm"`
	MinWPM           int     `json:"min_wpm"`
	MaxWPM           int     `json:"max_wpm"`

	// Breakdown data
	HourlyBreakdown  []CWHourlyStats  `json:"hourly_breakdown,omitempty"`
	DailyBreakdown   []CWDailyStats   `json:"daily_breakdown,omitempty"`
	MonthlyBreakdown []CWMonthlyStats `json:"monthly_breakdown,omitempty"`

	// Callsign tracking (for unique count)
	callsignSet map[string]bool `json:"-"` // Not serialized

	// WPM tracking
	wpmSum   int64 `json:"-"` // Not serialized
	wpmCount int64 `json:"-"` // Not serialized
}

// CWHourlyStats contains CW metrics for a specific hour
type CWHourlyStats struct {
	Hour            int     `json:"hour"` // 0-23
	Spots           int64   `json:"spots"`
	UniqueCallsigns int     `json:"unique_callsigns"`
	AvgWPM          float64 `json:"avg_wpm"`
}

// CWDailyStats contains CW metrics for a specific day
type CWDailyStats struct {
	Date            string  `json:"date"` // YYYY-MM-DD
	Spots           int64   `json:"spots"`
	UniqueCallsigns int     `json:"unique_callsigns"`
	AvgWPM          float64 `json:"avg_wpm"`
}

// CWMonthlyStats contains CW metrics for a specific month
type CWMonthlyStats struct {
	Month           string  `json:"month"` // YYYY-MM
	Spots           int64   `json:"spots"`
	UniqueCallsigns int     `json:"unique_callsigns"`
	AvgWPM          float64 `json:"avg_wpm"`
}

// NewCWMetricsSummaryAggregator creates a new CW summary aggregator.
// metricsDir is retained for signature compatibility but unused; summaryDir is
// kept only for db_import.go historical backfill. Existing summaries load from
// the DB once SetDB() is called.
func NewCWMetricsSummaryAggregator(_ /*metricsDir*/, summaryDir string) (*CWMetricsSummaryAggregator, error) {
	msa := &CWMetricsSummaryAggregator{
		summaryDir:    summaryDir,
		summaries:     make(map[string]*CWMetricsSummary),
		writeInterval: 1 * time.Minute, // Flush to DB at most once per minute
		lastWrite:     time.Now(),
	}
	return msa, nil
}

// RecordSpot records a CW spot event and updates all relevant summaries
func (msa *CWMetricsSummaryAggregator) RecordSpot(band, callsign string, wpm int, timestamp time.Time) {
	msa.mu.Lock()
	defer msa.mu.Unlock()

	// Update all period summaries for this spot
	msa.incrementSummary(band, callsign, wpm, "day", timestamp)
	msa.incrementSummary(band, callsign, wpm, "week", timestamp)
	msa.incrementSummary(band, callsign, wpm, "month", timestamp)
	msa.incrementSummary(band, callsign, wpm, "year", timestamp)
}

// WriteIfNeeded flushes summaries to the DB if enough time has passed.
func (msa *CWMetricsSummaryAggregator) WriteIfNeeded() error {
	msa.writeMu.Lock()
	defer msa.writeMu.Unlock()

	if msa.db == nil {
		return nil // DB not available
	}
	if time.Since(msa.lastWrite) < msa.writeInterval {
		return nil // Not time yet
	}

	msa.lastWrite = time.Now()

	// Write all in-memory summaries to disk
	msa.mu.RLock()
	summariesToWrite := make([]*CWMetricsSummary, 0, len(msa.summaries))
	for _, summary := range msa.summaries {
		summariesToWrite = append(summariesToWrite, summary)
	}
	msa.mu.RUnlock()

	// Write without holding the read lock
	for _, summary := range summariesToWrite {
		if err := msa.saveSummary(summary); err != nil {
			log.Printf("Warning: failed to save CW summary for %s/%s: %v",
				summary.Band, summary.Period, err)
		}
	}

	return nil
}

// incrementSummary increments the count for a specific summary period
// Must be called with msa.mu held
func (msa *CWMetricsSummaryAggregator) incrementSummary(band, callsign string, wpm int, period string, timestamp time.Time) {
	// Calculate period boundaries
	var startTime, endTime time.Time
	var key string

	switch period {
	case "day":
		startTime = time.Date(timestamp.Year(), timestamp.Month(), timestamp.Day(), 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.Add(24 * time.Hour)
		key = fmt.Sprintf("%s:day:%s", band, startTime.Format("2006-01-02"))
	case "week":
		weekday := int(timestamp.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		startTime = time.Date(timestamp.Year(), timestamp.Month(), timestamp.Day()-weekday+1, 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.Add(7 * 24 * time.Hour)
		year, week := startTime.ISOWeek()
		key = fmt.Sprintf("%s:week:%d-W%02d", band, year, week)
	case "month":
		startTime = time.Date(timestamp.Year(), timestamp.Month(), 1, 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.AddDate(0, 1, 0)
		key = fmt.Sprintf("%s:month:%s", band, startTime.Format("2006-01"))
	case "year":
		startTime = time.Date(timestamp.Year(), 1, 1, 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.AddDate(1, 0, 0)
		key = fmt.Sprintf("%s:year:%d", band, timestamp.Year())
	default:
		return
	}

	// Get or create summary
	summary, exists := msa.summaries[key]
	if !exists {
		summary = &CWMetricsSummary{
			Period:      period,
			StartTime:   startTime,
			EndTime:     endTime,
			Band:        band,
			callsignSet: make(map[string]bool),
		}

		// Initialize hourly breakdown for daily summaries
		if period == "day" {
			summary.HourlyBreakdown = make([]CWHourlyStats, 24)
			for i := 0; i < 24; i++ {
				summary.HourlyBreakdown[i].Hour = i
			}
		}

		msa.summaries[key] = summary
	}

	// Increment total spots
	summary.TotalSpots++
	summary.LastUpdated = time.Now()

	// Track unique callsign
	if !summary.callsignSet[callsign] {
		summary.callsignSet[callsign] = true
		summary.UniqueCallsigns = len(summary.callsignSet)
	}

	// Track WPM
	if wpm > 0 {
		summary.wpmSum += int64(wpm)
		summary.wpmCount++
		summary.AvgWPM = float64(summary.wpmSum) / float64(summary.wpmCount)

		if summary.MinWPM == 0 || wpm < summary.MinWPM {
			summary.MinWPM = wpm
		}
		if wpm > summary.MaxWPM {
			summary.MaxWPM = wpm
		}
	}

	// Update hourly breakdown for daily summaries
	if period == "day" && summary.HourlyBreakdown != nil {
		hour := timestamp.Hour()
		if hour >= 0 && hour < 24 {
			summary.HourlyBreakdown[hour].Spots++
			// Update hourly WPM (simplified - just track in the hour)
			if wpm > 0 {
				summary.HourlyBreakdown[hour].AvgWPM = float64(wpm) // Simplified
			}
		}
	}

	// Update daily breakdown for weekly/monthly summaries
	if period == "week" || period == "month" {
		dateStr := timestamp.Format("2006-01-02")
		found := false
		for i := range summary.DailyBreakdown {
			if summary.DailyBreakdown[i].Date == dateStr {
				summary.DailyBreakdown[i].Spots++
				found = true
				break
			}
		}
		if !found {
			summary.DailyBreakdown = append(summary.DailyBreakdown, CWDailyStats{
				Date:   dateStr,
				Spots:  1,
				AvgWPM: float64(wpm),
			})
		}
	}

	// Update monthly breakdown for yearly summaries
	if period == "year" {
		monthStr := timestamp.Format("2006-01")
		found := false
		for i := range summary.MonthlyBreakdown {
			if summary.MonthlyBreakdown[i].Month == monthStr {
				summary.MonthlyBreakdown[i].Spots++
				found = true
				break
			}
		}
		if !found {
			summary.MonthlyBreakdown = append(summary.MonthlyBreakdown, CWMonthlyStats{
				Month:  monthStr,
				Spots:  1,
				AvgWPM: float64(wpm),
			})
		}
	}

	// Recalculate average spots per hour
	if summary.TotalSpots > 0 {
		duration := summary.EndTime.Sub(summary.StartTime).Hours()
		if duration > 0 {
			summary.AvgSpotsPerHour = float64(summary.TotalSpots) / duration
		}
	}

	// Update peak spots per hour (simplified - based on current rate)
	if summary.AvgSpotsPerHour > summary.PeakSpotsPerHour {
		summary.PeakSpotsPerHour = summary.AvgSpotsPerHour
	}
}

// loadExistingSummaries loads the current day/week/month/year summaries from
// the DB into memory so aggregation resumes across restarts.
func (msa *CWMetricsSummaryAggregator) loadExistingSummaries() error {
	if msa.readDB == nil {
		return nil
	}
	now := time.Now()
	for _, period := range []string{"day", "week", "month", "year"} {
		summaries, err := msa.ReadAllSummaries(period, now)
		if err != nil {
			log.Printf("Warning: failed to load %s CW summaries: %v", period, err)
			continue
		}

		msa.mu.Lock()
		for _, summary := range summaries {
			key := msa.getSummaryKey(&summary)
			summaryCopy := summary
			summaryCopy.callsignSet = make(map[string]bool)
			msa.summaries[key] = &summaryCopy
		}
		msa.mu.Unlock()
	}

	return nil
}

// getSummaryKey generates a unique in-memory key for a summary.
func (msa *CWMetricsSummaryAggregator) getSummaryKey(summary *CWMetricsSummary) string {
	switch summary.Period {
	case "day":
		return fmt.Sprintf("%s:day:%s", summary.Band, summary.StartTime.Format("2006-01-02"))
	case "week":
		year, week := summary.StartTime.ISOWeek()
		return fmt.Sprintf("%s:week:%d-W%02d", summary.Band, year, week)
	case "month":
		return fmt.Sprintf("%s:month:%s", summary.Band, summary.StartTime.Format("2006-01"))
	case "year":
		return fmt.Sprintf("%s:year:%d", summary.Band, summary.StartTime.Year())
	default:
		return fmt.Sprintf("%s:%s:%s", summary.Band, summary.Period, summary.StartTime.Format("2006-01-02"))
	}
}

// saveSummary upserts a summary into the cw_metrics_summary table.
// (summaryPeriodKey is shared with the decoder aggregator in the same package.)
func (msa *CWMetricsSummaryAggregator) saveSummary(summary *CWMetricsSummary) error {
	if msa.db == nil {
		return nil
	}
	data, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("failed to marshal summary: %w", err)
	}
	periodKey := summaryPeriodKey(summary.Period, summary.StartTime)
	_, err = msa.db.Exec(
		`INSERT INTO cw_metrics_summary
		   (ts, band, period, period_key, end_ts, updated_ts, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(band, period, period_key)
		 DO UPDATE SET end_ts = excluded.end_ts,
		               updated_ts = excluded.updated_ts,
		               data = excluded.data`,
		summary.StartTime.Unix(), summary.Band, summary.Period, periodKey,
		summary.EndTime.Unix(), summary.LastUpdated.Unix(), string(data),
	)
	if err != nil {
		return fmt.Errorf("cw_metrics_summary upsert: %w", err)
	}
	return nil
}

// ReadAllSummaries reads all summaries for a given period whose time window
// contains date, from the cw_metrics_summary table.
func (msa *CWMetricsSummaryAggregator) ReadAllSummaries(period string, date time.Time) ([]CWMetricsSummary, error) {
	if msa.readDB == nil {
		return []CWMetricsSummary{}, nil
	}
	target := date.Unix()
	rows, err := msa.readDB.Query(
		`SELECT data FROM cw_metrics_summary
		 WHERE period = ? AND ts <= ? AND end_ts > ?`,
		period, target, target,
	)
	if err != nil {
		return nil, fmt.Errorf("cw_metrics_summary query: %w", err)
	}
	defer rows.Close()

	summaries := make([]CWMetricsSummary, 0)
	for rows.Next() {
		var blob string
		if err := rows.Scan(&blob); err != nil {
			return nil, fmt.Errorf("cw_metrics_summary scan: %w", err)
		}
		var summary CWMetricsSummary
		if err := json.Unmarshal([]byte(blob), &summary); err != nil {
			log.Printf("Warning: error unmarshaling CW summary: %v", err)
			continue
		}
		summaries = append(summaries, summary)
	}
	return summaries, rows.Err()
}

// GetAllSummariesFromMemory returns all summaries for a given period and date from memory
func (msa *CWMetricsSummaryAggregator) GetAllSummariesFromMemory(period string, date time.Time) []CWMetricsSummary {
	msa.mu.RLock()
	defer msa.mu.RUnlock()

	summaries := make([]CWMetricsSummary, 0)

	for _, summary := range msa.summaries {
		if summary.Period != period {
			continue
		}

		if (date.Equal(summary.StartTime) || date.After(summary.StartTime)) &&
			date.Before(summary.EndTime) {
			summaryCopy := *summary
			summaries = append(summaries, summaryCopy)
		}
	}

	return summaries
}
