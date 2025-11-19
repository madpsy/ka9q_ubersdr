package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MetricsSummaryAggregator handles aggregation of metrics into time-period summaries
type MetricsSummaryAggregator struct {
	metricsDir string
	summaryDir string

	metricsLogger *MetricsLogger

	// Update control
	updateInterval time.Duration
	lastUpdate     time.Time

	mu sync.RWMutex
}

// MetricsSummary represents aggregated metrics for a specific time period
type MetricsSummary struct {
	Period    string    `json:"period"` // "day", "week", "month", "year"
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
	Mode      string    `json:"mode"`
	Band      string    `json:"band"`

	// Tracking for incremental updates
	LastProcessedSnapshot time.Time `json:"last_processed_snapshot"`
	LastUpdated           time.Time `json:"last_updated"`

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

// NewMetricsSummaryAggregator creates a new summary aggregator
func NewMetricsSummaryAggregator(metricsDir, summaryDir string, metricsLogger *MetricsLogger) (*MetricsSummaryAggregator, error) {
	// Create summary directory if it doesn't exist
	if err := os.MkdirAll(summaryDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create summary directory: %w", err)
	}

	msa := &MetricsSummaryAggregator{
		metricsDir:     metricsDir,
		summaryDir:     summaryDir,
		metricsLogger:  metricsLogger,
		updateInterval: 1 * time.Minute,
		lastUpdate:     time.Now(),
	}

	return msa, nil
}

// ShouldUpdate returns true if enough time has passed since last update
func (msa *MetricsSummaryAggregator) ShouldUpdate() bool {
	return time.Since(msa.lastUpdate) >= msa.updateInterval
}

// UpdateAllSummaries updates all summary periods for all active mode/band combinations
func (msa *MetricsSummaryAggregator) UpdateAllSummaries(dm *DigitalDecodeMetrics) error {
	msa.mu.Lock()
	msa.lastUpdate = time.Now()
	msa.mu.Unlock()

	// Get all active mode/band combinations
	combinations := dm.GetAllModeBandCombinations()

	if len(combinations) == 0 {
		return nil
	}

	log.Printf("Updating summaries for %d mode/band combinations", len(combinations))

	// Update summaries for each combination
	var wg sync.WaitGroup
	for _, combo := range combinations {
		wg.Add(4) // 4 periods: daily, weekly, monthly, yearly

		go func(mode, band string) {
			defer wg.Done()
			if err := msa.updateDailySummary(mode, band); err != nil {
				log.Printf("Error updating daily summary for %s/%s: %v", mode, band, err)
			}
		}(combo.Mode, combo.Band)

		go func(mode, band string) {
			defer wg.Done()
			if err := msa.updateWeeklySummary(mode, band); err != nil {
				log.Printf("Error updating weekly summary for %s/%s: %v", mode, band, err)
			}
		}(combo.Mode, combo.Band)

		go func(mode, band string) {
			defer wg.Done()
			if err := msa.updateMonthlySummary(mode, band); err != nil {
				log.Printf("Error updating monthly summary for %s/%s: %v", mode, band, err)
			}
		}(combo.Mode, combo.Band)

		go func(mode, band string) {
			defer wg.Done()
			if err := msa.updateYearlySummary(mode, band); err != nil {
				log.Printf("Error updating yearly summary for %s/%s: %v", mode, band, err)
			}
		}(combo.Mode, combo.Band)
	}

	wg.Wait()
	return nil
}

// updateDailySummary updates the daily summary for a mode/band combination
func (msa *MetricsSummaryAggregator) updateDailySummary(mode, band string) error {
	now := time.Now()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	endOfDay := startOfDay.Add(24 * time.Hour)

	return msa.updateSummary(mode, band, "day", startOfDay, endOfDay)
}

// updateWeeklySummary updates the weekly summary for a mode/band combination
func (msa *MetricsSummaryAggregator) updateWeeklySummary(mode, band string) error {
	now := time.Now()
	// Start of week (Monday)
	weekday := int(now.Weekday())
	if weekday == 0 {
		weekday = 7 // Sunday = 7
	}
	startOfWeek := time.Date(now.Year(), now.Month(), now.Day()-weekday+1, 0, 0, 0, 0, now.Location())
	endOfWeek := startOfWeek.Add(7 * 24 * time.Hour)

	return msa.updateSummary(mode, band, "week", startOfWeek, endOfWeek)
}

// updateMonthlySummary updates the monthly summary for a mode/band combination
func (msa *MetricsSummaryAggregator) updateMonthlySummary(mode, band string) error {
	now := time.Now()
	startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	endOfMonth := startOfMonth.AddDate(0, 1, 0)

	return msa.updateSummary(mode, band, "month", startOfMonth, endOfMonth)
}

// updateYearlySummary updates the yearly summary for a mode/band combination
func (msa *MetricsSummaryAggregator) updateYearlySummary(mode, band string) error {
	now := time.Now()
	startOfYear := time.Date(now.Year(), 1, 1, 0, 0, 0, 0, now.Location())
	endOfYear := startOfYear.AddDate(1, 0, 0)

	return msa.updateSummary(mode, band, "year", startOfYear, endOfYear)
}

// updateSummary updates a summary for a specific period
func (msa *MetricsSummaryAggregator) updateSummary(mode, band, period string, startTime, endTime time.Time) error {
	// Get or create summary
	summary, err := msa.loadOrCreateSummary(mode, band, period, startTime, endTime)
	if err != nil {
		return err
	}

	// Read new snapshots since last processed
	snapshots, err := msa.readNewSnapshots(mode, band, summary.LastProcessedSnapshot, endTime)
	if err != nil {
		return err
	}

	if len(snapshots) == 0 {
		return nil // No new data
	}

	// Process snapshots and update summary
	msa.processSnapshots(summary, snapshots, period)

	// Update metadata
	summary.LastUpdated = time.Now()
	if len(snapshots) > 0 {
		summary.LastProcessedSnapshot = snapshots[len(snapshots)-1].Timestamp
	}

	// Save summary
	return msa.saveSummary(summary)
}

// loadOrCreateSummary loads an existing summary or creates a new one
func (msa *MetricsSummaryAggregator) loadOrCreateSummary(mode, band, period string, startTime, endTime time.Time) (*MetricsSummary, error) {
	filePath := msa.getSummaryFilePath(mode, band, period, startTime)

	// Try to load existing summary
	if data, err := os.ReadFile(filePath); err == nil {
		var summary MetricsSummary
		if err := json.Unmarshal(data, &summary); err == nil {
			// Initialize callsign set from unique count
			summary.callsignSet = make(map[string]bool)
			return &summary, nil
		}
	}

	// Create new summary
	summary := &MetricsSummary{
		Period:                period,
		StartTime:             startTime,
		EndTime:               endTime,
		Mode:                  mode,
		Band:                  band,
		callsignSet:           make(map[string]bool),
		LastProcessedSnapshot: startTime,
	}

	// Initialize hourly breakdown for daily summaries
	if period == "day" {
		summary.HourlyBreakdown = make([]HourlyStats, 24)
		for i := 0; i < 24; i++ {
			summary.HourlyBreakdown[i].Hour = i
		}
	}

	return summary, nil
}

// readNewSnapshots reads snapshots from JSONL files since last processed time
func (msa *MetricsSummaryAggregator) readNewSnapshots(mode, band string, since, until time.Time) ([]MetricsSnapshot, error) {
	if msa.metricsLogger == nil || !msa.metricsLogger.enabled {
		return nil, nil
	}

	// Read from files using the metrics logger
	snapshotsMap, err := msa.metricsLogger.ReadMetricsFromFiles(since, until)
	if err != nil {
		return nil, err
	}

	key := fmt.Sprintf("%s:%s", mode, band)
	snapshots := snapshotsMap[key]

	return snapshots, nil
}

// processSnapshots processes new snapshots and updates the summary
func (msa *MetricsSummaryAggregator) processSnapshots(summary *MetricsSummary, snapshots []MetricsSnapshot, period string) {
	// Deduplicate snapshots to one per hour to avoid counting overlapping Last1Hour windows
	// Key format: "YYYY-MM-DD-HH"
	hourlySnapshots := make(map[string]MetricsSnapshot)
	for _, snapshot := range snapshots {
		hourKey := snapshot.Timestamp.Format("2006-01-02-15") // Hour precision
		// Keep the latest snapshot for each hour
		if existing, ok := hourlySnapshots[hourKey]; !ok || snapshot.Timestamp.After(existing.Timestamp) {
			hourlySnapshots[hourKey] = snapshot
		}
	}

	// Process only one snapshot per hour to avoid overcounting
	for _, snapshot := range hourlySnapshots {
		// Add to total spots (use Last1Hour as incremental value)
		summary.TotalSpots += snapshot.DecodeCounts.Last1Hour

		// Track unique callsigns (this is approximate since we don't have individual callsigns)
		// We'll use the max unique callsigns seen in any snapshot as an approximation
		if snapshot.UniqueCallsigns.Last1Hour > summary.UniqueCallsigns {
			summary.UniqueCallsigns = snapshot.UniqueCallsigns.Last1Hour
		}

		// Update peak spots per hour
		if snapshot.Activity.DecodesPerHour > summary.PeakSpotsPerHour {
			summary.PeakSpotsPerHour = snapshot.Activity.DecodesPerHour
		}

		// Update hourly breakdown for daily summaries
		if period == "day" && summary.HourlyBreakdown != nil {
			hour := snapshot.Timestamp.Hour()
			if hour >= 0 && hour < 24 {
				summary.HourlyBreakdown[hour].Spots += snapshot.DecodeCounts.Last1Hour
				if snapshot.UniqueCallsigns.Last1Hour > summary.HourlyBreakdown[hour].UniqueCallsigns {
					summary.HourlyBreakdown[hour].UniqueCallsigns = snapshot.UniqueCallsigns.Last1Hour
				}
			}
		}

		// Update daily breakdown for weekly/monthly summaries
		if period == "week" || period == "month" {
			dateStr := snapshot.Timestamp.Format("2006-01-02")
			found := false
			for i := range summary.DailyBreakdown {
				if summary.DailyBreakdown[i].Date == dateStr {
					summary.DailyBreakdown[i].Spots += snapshot.DecodeCounts.Last1Hour
					if snapshot.UniqueCallsigns.Last1Hour > summary.DailyBreakdown[i].UniqueCallsigns {
						summary.DailyBreakdown[i].UniqueCallsigns = snapshot.UniqueCallsigns.Last1Hour
					}
					found = true
					break
				}
			}
			if !found {
				summary.DailyBreakdown = append(summary.DailyBreakdown, DailyStats{
					Date:            dateStr,
					Spots:           snapshot.DecodeCounts.Last1Hour,
					UniqueCallsigns: snapshot.UniqueCallsigns.Last1Hour,
				})
			}
		}

		// Update monthly breakdown for yearly summaries
		if period == "year" {
			monthStr := snapshot.Timestamp.Format("2006-01")
			found := false
			for i := range summary.MonthlyBreakdown {
				if summary.MonthlyBreakdown[i].Month == monthStr {
					summary.MonthlyBreakdown[i].Spots += snapshot.DecodeCounts.Last1Hour
					if snapshot.UniqueCallsigns.Last1Hour > summary.MonthlyBreakdown[i].UniqueCallsigns {
						summary.MonthlyBreakdown[i].UniqueCallsigns = snapshot.UniqueCallsigns.Last1Hour
					}
					found = true
					break
				}
			}
			if !found {
				summary.MonthlyBreakdown = append(summary.MonthlyBreakdown, MonthlyStats{
					Month:           monthStr,
					Spots:           snapshot.DecodeCounts.Last1Hour,
					UniqueCallsigns: snapshot.UniqueCallsigns.Last1Hour,
				})
			}
		}
	}

	// Calculate average spots per hour
	if summary.TotalSpots > 0 {
		duration := summary.EndTime.Sub(summary.StartTime).Hours()
		if duration > 0 {
			summary.AvgSpotsPerHour = float64(summary.TotalSpots) / duration
		}
	}
}

// getSummaryFilePath returns the file path for a summary
func (msa *MetricsSummaryAggregator) getSummaryFilePath(mode, band, period string, startTime time.Time) string {
	var dirPath string

	switch period {
	case "day":
		dirPath = filepath.Join(
			msa.summaryDir,
			"daily",
			fmt.Sprintf("%04d", startTime.Year()),
			fmt.Sprintf("%02d", startTime.Month()),
			fmt.Sprintf("%02d", startTime.Day()),
		)
	case "week":
		_, week := startTime.ISOWeek()
		dirPath = filepath.Join(
			msa.summaryDir,
			"weekly",
			fmt.Sprintf("%04d", startTime.Year()),
			fmt.Sprintf("%02d", week),
		)
	case "month":
		dirPath = filepath.Join(
			msa.summaryDir,
			"monthly",
			fmt.Sprintf("%04d", startTime.Year()),
			fmt.Sprintf("%02d", startTime.Month()),
		)
	case "year":
		dirPath = filepath.Join(
			msa.summaryDir,
			"yearly",
			fmt.Sprintf("%04d", startTime.Year()),
		)
	}

	// Create directory if it doesn't exist
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		log.Printf("Warning: failed to create summary directory %s: %v", dirPath, err)
	}

	filename := fmt.Sprintf("%s-%s-summary.json", mode, band)
	return filepath.Join(dirPath, filename)
}

// saveSummary saves a summary to disk
func (msa *MetricsSummaryAggregator) saveSummary(summary *MetricsSummary) error {
	filePath := msa.getSummaryFilePath(summary.Mode, summary.Band, summary.Period, summary.StartTime)

	// Marshal to JSON
	data, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal summary: %w", err)
	}

	// Write to temp file first
	tempPath := filePath + ".tmp"
	if err := os.WriteFile(tempPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write summary: %w", err)
	}

	// Atomic rename
	if err := os.Rename(tempPath, filePath); err != nil {
		return fmt.Errorf("failed to rename summary: %w", err)
	}

	return nil
}

// ReadSummary reads a summary from disk
func (msa *MetricsSummaryAggregator) ReadSummary(mode, band, period string, date time.Time) (*MetricsSummary, error) {
	filePath := msa.getSummaryFilePath(mode, band, period, date)

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	var summary MetricsSummary
	if err := json.Unmarshal(data, &summary); err != nil {
		return nil, err
	}

	return &summary, nil
}

// ReadAllSummaries reads all summaries for a given period and date
func (msa *MetricsSummaryAggregator) ReadAllSummaries(period string, date time.Time) ([]MetricsSummary, error) {
	var dirPath string

	switch period {
	case "day":
		dirPath = filepath.Join(
			msa.summaryDir,
			"daily",
			fmt.Sprintf("%04d", date.Year()),
			fmt.Sprintf("%02d", date.Month()),
			fmt.Sprintf("%02d", date.Day()),
		)
	case "week":
		_, week := date.ISOWeek()
		dirPath = filepath.Join(
			msa.summaryDir,
			"weekly",
			fmt.Sprintf("%04d", date.Year()),
			fmt.Sprintf("%02d", week),
		)
	case "month":
		dirPath = filepath.Join(
			msa.summaryDir,
			"monthly",
			fmt.Sprintf("%04d", date.Year()),
			fmt.Sprintf("%02d", date.Month()),
		)
	case "year":
		dirPath = filepath.Join(
			msa.summaryDir,
			"yearly",
			fmt.Sprintf("%04d", date.Year()),
		)
	default:
		return nil, fmt.Errorf("invalid period: %s", period)
	}

	// Check if directory exists
	if _, err := os.Stat(dirPath); os.IsNotExist(err) {
		return []MetricsSummary{}, nil
	}

	// Read all summary files
	files, err := filepath.Glob(filepath.Join(dirPath, "*-summary.json"))
	if err != nil {
		return nil, err
	}

	summaries := make([]MetricsSummary, 0, len(files))
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			log.Printf("Warning: error reading summary file %s: %v", file, err)
			continue
		}

		var summary MetricsSummary
		if err := json.Unmarshal(data, &summary); err != nil {
			log.Printf("Warning: error unmarshaling summary file %s: %v", file, err)
			continue
		}

		summaries = append(summaries, summary)
	}

	return summaries, nil
}
