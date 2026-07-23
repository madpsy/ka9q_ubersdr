package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

// MetricsSummaryAggregator handles aggregation of metrics into time-period summaries.
// Summaries are aggregated in memory (event-driven) and periodically persisted to
// the decoder_metrics_summary SQLite table.
type MetricsSummaryAggregator struct {
	// summaryDir is retained only so db_import.go can backfill legacy JSON
	// summary files written before the SQLite migration. Nothing is written
	// here at runtime any more.
	summaryDir string

	metricsLogger *MetricsLogger

	// In-memory summaries (key: "mode:band:period:date")
	summaries map[string]*MetricsSummary
	mu        sync.RWMutex

	// DB persistence
	db     *sql.DB // write connection
	readDB *sql.DB // read-only pool

	// Periodic flush control
	writeInterval time.Duration
	lastWrite     time.Time
	writeMu       sync.Mutex

	// importHold suppresses flushes while db_import.go is still backfilling
	// decoder_metrics_summary from the legacy JSON tree. Without it the
	// aggregator — which started from an empty table — would upsert its
	// history-less in-memory summaries over the rows the backfill is about
	// to insert (or has just inserted), permanently losing every pre-migration
	// month in the yearly breakdowns. Cleared by MergeImportedSummaries or
	// ReleaseImportHold. Guarded by writeMu.
	importHold bool
}

// SetDB wires the SQLite write connection and read pool, then loads existing
// summaries for the current periods into memory.
func (msa *MetricsSummaryAggregator) SetDB(db, readDB *sql.DB) {
	msa.db = db
	msa.readDB = readDB
	if err := msa.loadExistingSummaries(); err != nil {
		log.Printf("Warning: failed to load existing decoder summaries: %v", err)
	}
}

// MetricsSummary represents aggregated metrics for a specific time period
type MetricsSummary struct {
	Period    string    `json:"period"` // "day", "week", "month", "year"
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
	Mode      string    `json:"mode"`
	Band      string    `json:"band"`

	// Tracking for incremental updates
	LastProcessedSnapshot time.Time       `json:"last_processed_snapshot"`
	LastUpdated           time.Time       `json:"last_updated"`
	ProcessedHours        map[string]bool `json:"processed_hours,omitempty"` // Track which hours have been processed

	// Aggregated metrics
	TotalSpots       int64   `json:"total_spots"`
	UniqueCallsigns  int     `json:"unique_callsigns"`
	PeakSpotsPerHour float64 `json:"peak_spots_per_hour"`
	AvgSpotsPerHour  float64 `json:"avg_spots_per_hour"`

	// Breakdown data
	HourlyBreakdown  []HourlyStats  `json:"hourly_breakdown,omitempty"`
	DailyBreakdown   []DailyStats   `json:"daily_breakdown,omitempty"`
	MonthlyBreakdown []MonthlyStats `json:"monthly_breakdown,omitempty"`

	// Callsign tracking (for unique count)
	callsignSet map[string]bool `json:"-"` // Not serialized
}

// HourlyStats contains metrics for a specific hour
type HourlyStats struct {
	Hour            int   `json:"hour"` // 0-23
	Spots           int64 `json:"spots"`
	UniqueCallsigns int   `json:"unique_callsigns"`
}

// DailyStats contains metrics for a specific day
type DailyStats struct {
	Date            string `json:"date"` // YYYY-MM-DD
	Spots           int64  `json:"spots"`
	UniqueCallsigns int    `json:"unique_callsigns"`
}

// MonthlyStats contains metrics for a specific month
type MonthlyStats struct {
	Month           string `json:"month"` // YYYY-MM
	Spots           int64  `json:"spots"`
	UniqueCallsigns int    `json:"unique_callsigns"`
}

// NewMetricsSummaryAggregator creates a new summary aggregator.
// The metricsDir parameter is retained for signature compatibility but unused;
// summaryDir is kept only for db_import.go historical backfill. Existing
// summaries are loaded from the DB later, once SetDB() is called.
func NewMetricsSummaryAggregator(_ /*metricsDir*/, summaryDir string, metricsLogger *MetricsLogger) (*MetricsSummaryAggregator, error) {
	msa := &MetricsSummaryAggregator{
		summaryDir:    summaryDir,
		metricsLogger: metricsLogger,
		summaries:     make(map[string]*MetricsSummary),
		writeInterval: 1 * time.Minute, // Flush to DB at most once per minute
		lastWrite:     time.Now(),
	}
	return msa, nil
}

// RecordDecode records a decode event and updates all relevant summaries
// This is called immediately when a spot is decoded (event-driven)
func (msa *MetricsSummaryAggregator) RecordDecode(mode, band string, timestamp time.Time) {
	msa.mu.Lock()
	defer msa.mu.Unlock()

	// Update all period summaries for this decode
	msa.incrementSummary(mode, band, "day", timestamp, 1)
	msa.incrementSummary(mode, band, "week", timestamp, 1)
	msa.incrementSummary(mode, band, "month", timestamp, 1)
	msa.incrementSummary(mode, band, "year", timestamp, 1)
}

// WriteIfNeeded flushes summaries to the DB if enough time has passed.
func (msa *MetricsSummaryAggregator) WriteIfNeeded() error {
	msa.writeMu.Lock()
	defer msa.writeMu.Unlock()

	if msa.db == nil {
		return nil // DB not available
	}
	if msa.importHold {
		return nil // historical backfill still in flight; see importHold
	}
	if time.Since(msa.lastWrite) < msa.writeInterval {
		return nil // Not time yet
	}

	msa.lastWrite = time.Now()

	// Write all in-memory summaries to disk
	msa.mu.RLock()
	summariesToWrite := make([]*MetricsSummary, 0, len(msa.summaries))
	for _, summary := range msa.summaries {
		summariesToWrite = append(summariesToWrite, summary)
	}
	msa.mu.RUnlock()

	// Write without holding the read lock
	for _, summary := range summariesToWrite {
		if err := msa.saveSummary(summary); err != nil {
			log.Printf("Warning: failed to save summary for %s/%s/%s: %v",
				summary.Mode, summary.Band, summary.Period, err)
		}
	}

	return nil
}

// HoldWritesForImport blocks flushes to decoder_metrics_summary until the
// historical backfill has finished and been merged in. Called synchronously by
// DBImporter.RunImportIfEmpty when the table is queued for backfill, before any
// flush can have run.
func (msa *MetricsSummaryAggregator) HoldWritesForImport() {
	msa.writeMu.Lock()
	msa.importHold = true
	msa.writeMu.Unlock()
}

// ReleaseImportHold re-enables flushes without merging. Used when the backfill
// failed or was aborted — the legacy source tree is left in place for a retry,
// and live aggregation must not stay frozen in the meantime.
func (msa *MetricsSummaryAggregator) ReleaseImportHold() {
	msa.writeMu.Lock()
	msa.importHold = false
	msa.writeMu.Unlock()
}

// MergeImportedSummaries folds the just-backfilled historical rows into the
// in-memory summaries and releases the write hold.
//
// The arithmetic is additive and correct by construction: an imported row holds
// everything up to the migration, while the matching in-memory summary was
// built from zero at startup and holds only what has been decoded since. Unique
// callsign counts are the exception — the callsign sets are not persisted, so
// the two cannot be unioned and the larger of the two is kept.
func (msa *MetricsSummaryAggregator) MergeImportedSummaries() {
	defer msa.ReleaseImportHold()

	if msa.readDB == nil {
		return
	}
	now := time.Now()
	merged := 0
	for _, period := range []string{"day", "week", "month", "year"} {
		imported, err := msa.ReadAllSummaries(period, now)
		if err != nil {
			log.Printf("Warning: failed to read backfilled %s decoder summaries: %v", period, err)
			continue
		}

		msa.mu.Lock()
		for i := range imported {
			key := msa.getSummaryKey(&imported[i])
			live, exists := msa.summaries[key]
			if !exists {
				summaryCopy := imported[i]
				summaryCopy.callsignSet = make(map[string]bool)
				if summaryCopy.ProcessedHours == nil {
					summaryCopy.ProcessedHours = make(map[string]bool)
				}
				msa.summaries[key] = &summaryCopy
				merged++
				continue
			}
			mergeMetricsSummary(live, &imported[i])
			merged++
		}
		msa.mu.Unlock()
	}
	log.Printf("[DB import] decoder_metrics_summary: merged %d backfilled summaries into live aggregation", merged)
}

// mergeMetricsSummary adds the imported summary's totals and breakdowns into
// the live one. Must be called with msa.mu held.
func mergeMetricsSummary(live, imported *MetricsSummary) {
	live.TotalSpots += imported.TotalSpots
	if imported.UniqueCallsigns > live.UniqueCallsigns {
		live.UniqueCallsigns = imported.UniqueCallsigns
	}
	if imported.PeakSpotsPerHour > live.PeakSpotsPerHour {
		live.PeakSpotsPerHour = imported.PeakSpotsPerHour
	}

	// Hourly breakdown is a fixed 24-slot array indexed by hour.
	for _, h := range imported.HourlyBreakdown {
		if h.Hour < 0 || h.Hour >= len(live.HourlyBreakdown) {
			continue
		}
		live.HourlyBreakdown[h.Hour].Spots += h.Spots
		if h.UniqueCallsigns > live.HourlyBreakdown[h.Hour].UniqueCallsigns {
			live.HourlyBreakdown[h.Hour].UniqueCallsigns = h.UniqueCallsigns
		}
	}

	for _, d := range imported.DailyBreakdown {
		found := false
		for i := range live.DailyBreakdown {
			if live.DailyBreakdown[i].Date == d.Date {
				live.DailyBreakdown[i].Spots += d.Spots
				if d.UniqueCallsigns > live.DailyBreakdown[i].UniqueCallsigns {
					live.DailyBreakdown[i].UniqueCallsigns = d.UniqueCallsigns
				}
				found = true
				break
			}
		}
		if !found {
			live.DailyBreakdown = append(live.DailyBreakdown, d)
		}
	}

	for _, m := range imported.MonthlyBreakdown {
		found := false
		for i := range live.MonthlyBreakdown {
			if live.MonthlyBreakdown[i].Month == m.Month {
				live.MonthlyBreakdown[i].Spots += m.Spots
				if m.UniqueCallsigns > live.MonthlyBreakdown[i].UniqueCallsigns {
					live.MonthlyBreakdown[i].UniqueCallsigns = m.UniqueCallsigns
				}
				found = true
				break
			}
		}
		if !found {
			live.MonthlyBreakdown = append(live.MonthlyBreakdown, m)
		}
	}

	if duration := live.EndTime.Sub(live.StartTime).Hours(); duration > 0 {
		live.AvgSpotsPerHour = float64(live.TotalSpots) / duration
	}
	live.LastUpdated = time.Now()
}

// incrementSummary increments the count for a specific summary period
// Must be called with msa.mu held
func (msa *MetricsSummaryAggregator) incrementSummary(mode, band, period string, timestamp time.Time, count int64) {
	// Calculate period boundaries
	var startTime, endTime time.Time
	var key string

	switch period {
	case "day":
		startTime = time.Date(timestamp.Year(), timestamp.Month(), timestamp.Day(), 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.Add(24 * time.Hour)
		key = fmt.Sprintf("%s:%s:day:%s", mode, band, startTime.Format("2006-01-02"))
	case "week":
		weekday := int(timestamp.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		startTime = time.Date(timestamp.Year(), timestamp.Month(), timestamp.Day()-weekday+1, 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.Add(7 * 24 * time.Hour)
		year, week := startTime.ISOWeek()
		key = fmt.Sprintf("%s:%s:week:%d-W%02d", mode, band, year, week)
	case "month":
		startTime = time.Date(timestamp.Year(), timestamp.Month(), 1, 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.AddDate(0, 1, 0)
		key = fmt.Sprintf("%s:%s:month:%s", mode, band, startTime.Format("2006-01"))
	case "year":
		startTime = time.Date(timestamp.Year(), 1, 1, 0, 0, 0, 0, timestamp.Location())
		endTime = startTime.AddDate(1, 0, 0)
		key = fmt.Sprintf("%s:%s:year:%d", mode, band, timestamp.Year())
	default:
		return
	}

	// Get or create summary
	summary, exists := msa.summaries[key]
	if !exists {
		summary = &MetricsSummary{
			Period:         period,
			StartTime:      startTime,
			EndTime:        endTime,
			Mode:           mode,
			Band:           band,
			callsignSet:    make(map[string]bool),
			ProcessedHours: make(map[string]bool),
		}

		// Initialize hourly breakdown for daily summaries
		if period == "day" {
			summary.HourlyBreakdown = make([]HourlyStats, 24)
			for i := 0; i < 24; i++ {
				summary.HourlyBreakdown[i].Hour = i
			}
		}

		msa.summaries[key] = summary
	}

	// Increment total spots
	summary.TotalSpots += count
	summary.LastUpdated = time.Now()

	// Update hourly breakdown for daily summaries
	if period == "day" && summary.HourlyBreakdown != nil {
		hour := timestamp.Hour()
		if hour >= 0 && hour < 24 {
			summary.HourlyBreakdown[hour].Spots += count
		}
	}

	// Update daily breakdown for weekly/monthly summaries
	if period == "week" || period == "month" {
		dateStr := timestamp.Format("2006-01-02")
		found := false
		for i := range summary.DailyBreakdown {
			if summary.DailyBreakdown[i].Date == dateStr {
				summary.DailyBreakdown[i].Spots += count
				found = true
				break
			}
		}
		if !found {
			summary.DailyBreakdown = append(summary.DailyBreakdown, DailyStats{
				Date:  dateStr,
				Spots: count,
			})
		}
	}

	// Update monthly breakdown for yearly summaries
	if period == "year" {
		monthStr := timestamp.Format("2006-01")
		found := false
		for i := range summary.MonthlyBreakdown {
			if summary.MonthlyBreakdown[i].Month == monthStr {
				summary.MonthlyBreakdown[i].Spots += count
				found = true
				break
			}
		}
		if !found {
			summary.MonthlyBreakdown = append(summary.MonthlyBreakdown, MonthlyStats{
				Month: monthStr,
				Spots: count,
			})
		}
	}

	// Recalculate average
	if summary.TotalSpots > 0 {
		duration := summary.EndTime.Sub(summary.StartTime).Hours()
		if duration > 0 {
			summary.AvgSpotsPerHour = float64(summary.TotalSpots) / duration
		}
	}
}

// loadExistingSummaries loads the current day/week/month/year summaries from
// the DB into memory so aggregation resumes across restarts.
func (msa *MetricsSummaryAggregator) loadExistingSummaries() error {
	if msa.readDB == nil {
		return nil
	}
	now := time.Now()
	for _, period := range []string{"day", "week", "month", "year"} {
		summaries, err := msa.ReadAllSummaries(period, now)
		if err != nil {
			log.Printf("Warning: failed to load %s summaries: %v", period, err)
			continue
		}

		msa.mu.Lock()
		for _, summary := range summaries {
			key := msa.getSummaryKey(&summary)
			summaryCopy := summary
			summaryCopy.callsignSet = make(map[string]bool)
			if summaryCopy.ProcessedHours == nil {
				summaryCopy.ProcessedHours = make(map[string]bool)
			}
			msa.summaries[key] = &summaryCopy
		}
		msa.mu.Unlock()
	}

	return nil
}

// getSummaryKey generates a unique in-memory key for a summary.
func (msa *MetricsSummaryAggregator) getSummaryKey(summary *MetricsSummary) string {
	switch summary.Period {
	case "day":
		return fmt.Sprintf("%s:%s:day:%s", summary.Mode, summary.Band, summary.StartTime.Format("2006-01-02"))
	case "week":
		year, week := summary.StartTime.ISOWeek()
		return fmt.Sprintf("%s:%s:week:%d-W%02d", summary.Mode, summary.Band, year, week)
	case "month":
		return fmt.Sprintf("%s:%s:month:%s", summary.Mode, summary.Band, summary.StartTime.Format("2006-01"))
	case "year":
		return fmt.Sprintf("%s:%s:year:%d", summary.Mode, summary.Band, summary.StartTime.Year())
	default:
		return fmt.Sprintf("%s:%s:%s:%s", summary.Mode, summary.Band, summary.Period, summary.StartTime.Format("2006-01-02"))
	}
}

// summaryPeriodKey derives the DB period_key column from a summary's period
// and start time (matching the in-memory key suffix used in incrementSummary).
func summaryPeriodKey(period string, startTime time.Time) string {
	switch period {
	case "day":
		return startTime.Format("2006-01-02")
	case "week":
		year, week := startTime.ISOWeek()
		return fmt.Sprintf("%d-W%02d", year, week)
	case "month":
		return startTime.Format("2006-01")
	case "year":
		return fmt.Sprintf("%d", startTime.Year())
	default:
		return startTime.Format("2006-01-02")
	}
}

// saveSummary upserts a summary into the decoder_metrics_summary table.
func (msa *MetricsSummaryAggregator) saveSummary(summary *MetricsSummary) error {
	if msa.db == nil {
		return nil
	}
	data, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("failed to marshal summary: %w", err)
	}
	periodKey := summaryPeriodKey(summary.Period, summary.StartTime)
	_, err = msa.db.Exec(
		`INSERT INTO decoder_metrics_summary
		   (ts, mode, band, period, period_key, end_ts, updated_ts, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(mode, band, period, period_key)
		 DO UPDATE SET end_ts = excluded.end_ts,
		               updated_ts = excluded.updated_ts,
		               data = excluded.data`,
		summary.StartTime.Unix(), summary.Mode, summary.Band, summary.Period, periodKey,
		summary.EndTime.Unix(), summary.LastUpdated.Unix(), string(data),
	)
	if err != nil {
		return fmt.Errorf("decoder_metrics_summary upsert: %w", err)
	}
	return nil
}

// ReadAllSummaries reads all summaries for a given period whose time window
// contains date, from the decoder_metrics_summary table.
func (msa *MetricsSummaryAggregator) ReadAllSummaries(period string, date time.Time) ([]MetricsSummary, error) {
	if msa.readDB == nil {
		return []MetricsSummary{}, nil
	}
	target := date.Unix()
	rows, err := msa.readDB.Query(
		`SELECT data FROM decoder_metrics_summary
		 WHERE period = ? AND ts <= ? AND end_ts > ?`,
		period, target, target,
	)
	if err != nil {
		return nil, fmt.Errorf("decoder_metrics_summary query: %w", err)
	}
	defer rows.Close()

	summaries := make([]MetricsSummary, 0)
	for rows.Next() {
		var blob string
		if err := rows.Scan(&blob); err != nil {
			return nil, fmt.Errorf("decoder_metrics_summary scan: %w", err)
		}
		var summary MetricsSummary
		if err := json.Unmarshal([]byte(blob), &summary); err != nil {
			log.Printf("Warning: error unmarshaling decoder summary: %v", err)
			continue
		}
		summaries = append(summaries, summary)
	}
	return summaries, rows.Err()
}

// GetAllSummariesFromMemory returns all summaries for a given period and date from memory
// This is much faster than reading from disk and provides real-time data
func (msa *MetricsSummaryAggregator) GetAllSummariesFromMemory(period string, date time.Time) []MetricsSummary {
	msa.mu.RLock()
	defer msa.mu.RUnlock()

	summaries := make([]MetricsSummary, 0)

	// Iterate through all in-memory summaries and filter by period and date
	for _, summary := range msa.summaries {
		if summary.Period != period {
			continue
		}

		// Check if the date falls within this summary's time range
		if (date.Equal(summary.StartTime) || date.After(summary.StartTime)) &&
			date.Before(summary.EndTime) {
			// Make a copy to avoid race conditions
			summaryCopy := *summary
			summaries = append(summaries, summaryCopy)
		}
	}

	return summaries
}
