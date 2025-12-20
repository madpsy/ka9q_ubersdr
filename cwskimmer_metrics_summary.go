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

// CWMetricsSummaryAggregator handles aggregation of CW metrics into time-period summaries
type CWMetricsSummaryAggregator struct {
	metricsDir string
	summaryDir string

	// In-memory summaries (key: "band:period:date")
	summaries map[string]*CWMetricsSummary
	mu        sync.RWMutex

	// File write control
	writeInterval time.Duration
	lastWrite     time.Time
	writeMu       sync.Mutex
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

// NewCWMetricsSummaryAggregator creates a new CW summary aggregator
func NewCWMetricsSummaryAggregator(metricsDir, summaryDir string) (*CWMetricsSummaryAggregator, error) {
	// Create summary directory if it doesn't exist
	if err := os.MkdirAll(summaryDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create summary directory: %w", err)
	}

	msa := &CWMetricsSummaryAggregator{
		metricsDir:    metricsDir,
		summaryDir:    summaryDir,
		summaries:     make(map[string]*CWMetricsSummary),
		writeInterval: 1 * time.Minute, // Write to disk every minute
		lastWrite:     time.Now(),
	}

	// Load existing summaries from disk
	if err := msa.loadExistingSummaries(); err != nil {
		log.Printf("Warning: failed to load existing CW summaries: %v", err)
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

// WriteIfNeeded writes summaries to disk if enough time has passed
func (msa *CWMetricsSummaryAggregator) WriteIfNeeded() error {
	msa.writeMu.Lock()
	defer msa.writeMu.Unlock()

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

// loadExistingSummaries loads all existing summary files from disk into memory
func (msa *CWMetricsSummaryAggregator) loadExistingSummaries() error {
	now := time.Now()

	periods := []struct {
		name string
		date time.Time
	}{
		{"day", now},
		{"week", now},
		{"month", now},
		{"year", now},
	}

	for _, p := range periods {
		summaries, err := msa.ReadAllSummaries(p.name, p.date)
		if err != nil {
			log.Printf("Warning: failed to load %s CW summaries: %v", p.name, err)
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

// getSummaryKey generates a unique key for a summary
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

// getSummaryFilePath returns the file path for a summary
func (msa *CWMetricsSummaryAggregator) getSummaryFilePath(band, period string, startTime time.Time) string {
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
		log.Printf("Warning: failed to create CW summary directory %s: %v", dirPath, err)
	}

	filename := fmt.Sprintf("%s-summary.json", band)
	return filepath.Join(dirPath, filename)
}

// saveSummary saves a summary to disk
func (msa *CWMetricsSummaryAggregator) saveSummary(summary *CWMetricsSummary) error {
	filePath := msa.getSummaryFilePath(summary.Band, summary.Period, summary.StartTime)

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
func (msa *CWMetricsSummaryAggregator) ReadSummary(band, period string, date time.Time) (*CWMetricsSummary, error) {
	filePath := msa.getSummaryFilePath(band, period, date)

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	var summary CWMetricsSummary
	if err := json.Unmarshal(data, &summary); err != nil {
		return nil, err
	}

	return &summary, nil
}

// ReadAllSummaries reads all summaries for a given period and date
func (msa *CWMetricsSummaryAggregator) ReadAllSummaries(period string, date time.Time) ([]CWMetricsSummary, error) {
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
		return []CWMetricsSummary{}, nil
	}

	// Read all summary files
	files, err := filepath.Glob(filepath.Join(dirPath, "*-summary.json"))
	if err != nil {
		return nil, err
	}

	summaries := make([]CWMetricsSummary, 0, len(files))
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			log.Printf("Warning: error reading CW summary file %s: %v", file, err)
			continue
		}

		var summary CWMetricsSummary
		if err := json.Unmarshal(data, &summary); err != nil {
			log.Printf("Warning: error unmarshaling CW summary file %s: %v", file, err)
			continue
		}

		summaries = append(summaries, summary)
	}

	return summaries, nil
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
