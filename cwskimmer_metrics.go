package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CWSkimmerMetrics tracks detailed metrics for CW Skimmer spots
type CWSkimmerMetrics struct {
	// Per-band tracking
	spotsByBand map[string]*SpotTimeSeries // band -> time series

	// Unique callsign tracking (callsign+band combinations)
	uniqueCallsigns map[string]map[string]map[string]bool // band -> timeWindow -> callsign -> exists

	// Recent spots for rate calculations (last 60 seconds)
	recentSpots []SpotEvent

	// WPM tracking per band
	wpmMeasurements map[string][]WPMEvent // band -> WPM measurements

	// Disk logging
	metricsLogEnabled     bool
	metricsLogDataDir     string
	metricsLogInterval    time.Duration
	summaryDataDir        string
	lastMetricsWrite      time.Time
	summaryUpdateInterval time.Duration

	// Summary aggregator
	summaryAggregator *CWMetricsSummaryAggregator

	mu sync.RWMutex
}

// SpotEvent represents a single CW spot event for time-series tracking
type SpotEvent struct {
	Band      string
	Callsign  string
	WPM       int
	Timestamp time.Time
}

// WPMEvent represents a WPM measurement
type WPMEvent struct {
	WPM       int
	Timestamp time.Time
}

// SpotTimeSeries tracks spots over different time windows
type SpotTimeSeries struct {
	// Total spots in time windows
	Last1Hour   int64
	Last3Hours  int64
	Last6Hours  int64
	Last12Hours int64
	Last24Hours int64

	// Spot events with timestamps for windowing
	events []SpotEvent

	mu sync.RWMutex
}

// CWMetricsSnapshot represents a point-in-time snapshot of CW metrics for JSON logging
type CWMetricsSnapshot struct {
	Timestamp       time.Time                 `json:"timestamp"`
	Band            string                    `json:"band"`
	SpotCounts      CWSpotCountsSnapshot      `json:"spot_counts"`
	UniqueCallsigns CWUniqueCallsignsSnapshot `json:"unique_callsigns"`
	Activity        CWActivitySnapshot        `json:"activity"`
	WPMStats        CWWPMStatsSnapshot        `json:"wpm_stats"`
}

type CWSpotCountsSnapshot struct {
	Last1Hour  int64 `json:"last_1h"`
	Last24Hour int64 `json:"last_24h"`
}

type CWUniqueCallsignsSnapshot struct {
	Last1Hour  int `json:"last_1h"`
	Last24Hour int `json:"last_24h"`
}

type CWActivitySnapshot struct {
	SpotsPerHour     float64 `json:"spots_per_hour"`
	CallsignsPerHour float64 `json:"callsigns_per_hour"`
	ActivityScore    float64 `json:"activity_score"`
}

type CWWPMStatsSnapshot struct {
	Last1Min  CWWPMWindowStats `json:"last_1m"`
	Last5Min  CWWPMWindowStats `json:"last_5m"`
	Last10Min CWWPMWindowStats `json:"last_10m"`
}

type CWWPMWindowStats struct {
	AvgWPM float64 `json:"avg_wpm"`
	MinWPM int     `json:"min_wpm"`
	MaxWPM int     `json:"max_wpm"`
}

// NewCWSkimmerMetrics creates a new CW Skimmer metrics tracker
func NewCWSkimmerMetrics(metricsLogEnabled bool, metricsLogDataDir string, metricsLogIntervalSecs int, summaryDataDir string) *CWSkimmerMetrics {
	if metricsLogIntervalSecs == 0 {
		metricsLogIntervalSecs = 300 // Default 5 minutes
	}

	if summaryDataDir == "" {
		summaryDataDir = "cwskimmer_summaries"
	}

	cm := &CWSkimmerMetrics{
		spotsByBand:           make(map[string]*SpotTimeSeries),
		uniqueCallsigns:       make(map[string]map[string]map[string]bool),
		recentSpots:           make([]SpotEvent, 0, 1000),
		wpmMeasurements:       make(map[string][]WPMEvent),
		metricsLogEnabled:     metricsLogEnabled,
		metricsLogDataDir:     metricsLogDataDir,
		metricsLogInterval:    time.Duration(metricsLogIntervalSecs) * time.Second,
		summaryDataDir:        summaryDataDir,
		summaryUpdateInterval: 60 * time.Second, // Update summaries every minute
	}

	// Initialize summary aggregator
	if summaryDataDir != "" {
		aggregator, err := NewCWMetricsSummaryAggregator(metricsLogDataDir, summaryDataDir)
		if err != nil {
			log.Printf("Warning: failed to create CW summary aggregator: %v", err)
		} else {
			cm.summaryAggregator = aggregator
		}
	}

	return cm
}

// RecordSpot records a new CW spot event
func (cm *CWSkimmerMetrics) RecordSpot(band, callsign string, wpm int) {
	now := time.Now()
	event := SpotEvent{
		Band:      band,
		Callsign:  callsign,
		WPM:       wpm,
		Timestamp: now,
	}

	// Acquire lock FIRST for all cm operations
	cm.mu.Lock()

	// Add to recent spots (for 60-second rate calculations)
	cm.recentSpots = append(cm.recentSpots, event)

	// Clean old recent spots (keep last 60 seconds)
	cutoff := now.Add(-60 * time.Second)
	newRecent := make([]SpotEvent, 0, len(cm.recentSpots))
	for _, e := range cm.recentSpots {
		if e.Timestamp.After(cutoff) {
			newRecent = append(newRecent, e)
		}
	}
	cm.recentSpots = newRecent

	// Initialize band time series if needed
	if cm.spotsByBand[band] == nil {
		cm.spotsByBand[band] = &SpotTimeSeries{
			events: make([]SpotEvent, 0, 1000),
		}
	}

	// Get time series reference (we'll update it after releasing cm.mu.Lock)
	ts := cm.spotsByBand[band]

	// Record unique callsign for each time window
	cm.recordUniqueCallsign(band, callsign, now)

	// Record WPM measurement
	if wpm > 0 {
		cm.recordWPM(band, wpm, now)
	}

	// Release cm.mu.Lock BEFORE acquiring ts.mu.Lock to avoid nested locking
	cm.mu.Unlock()

	// Now update time series with its own lock (no cm.mu.Lock held)
	ts.mu.Lock()
	ts.events = append(ts.events, event)
	ts.mu.Unlock()

	// Update time series counts (acquires ts.mu.Lock internally)
	cm.updateTimeSeriesCounts(band)

	// Record in summary aggregator LAST (after releasing all locks)
	// This prevents deadlock since summaryAggregator.RecordSpot() acquires its own locks
	if cm.summaryAggregator != nil {
		cm.summaryAggregator.RecordSpot(band, callsign, wpm, now)
	}
}

// recordUniqueCallsign records a callsign as seen in various time windows
func (cm *CWSkimmerMetrics) recordUniqueCallsign(band, callsign string, timestamp time.Time) {
	if cm.uniqueCallsigns[band] == nil {
		cm.uniqueCallsigns[band] = make(map[string]map[string]bool)
	}

	// Record for each time window
	windows := []string{"1h", "3h", "6h", "12h", "24h"}
	for _, window := range windows {
		if cm.uniqueCallsigns[band][window] == nil {
			cm.uniqueCallsigns[band][window] = make(map[string]bool)
		}
		cm.uniqueCallsigns[band][window][callsign] = true
	}
}

// recordWPM records a WPM measurement
func (cm *CWSkimmerMetrics) recordWPM(band string, wpm int, timestamp time.Time) {
	if cm.wpmMeasurements[band] == nil {
		cm.wpmMeasurements[band] = make([]WPMEvent, 0, 100)
	}

	event := WPMEvent{
		WPM:       wpm,
		Timestamp: timestamp,
	}

	cm.wpmMeasurements[band] = append(cm.wpmMeasurements[band], event)

	// Clean old WPM measurements (keep last 24 hours)
	cutoff := timestamp.Add(-24 * time.Hour)
	newWPM := make([]WPMEvent, 0, len(cm.wpmMeasurements[band]))
	for _, e := range cm.wpmMeasurements[band] {
		if e.Timestamp.After(cutoff) {
			newWPM = append(newWPM, e)
		}
	}
	cm.wpmMeasurements[band] = newWPM
}

// updateTimeSeriesCounts updates the time series counts by cleaning old events
func (cm *CWSkimmerMetrics) updateTimeSeriesCounts(band string) {
	ts := cm.spotsByBand[band]
	if ts == nil {
		return
	}

	ts.mu.Lock()
	defer ts.mu.Unlock()

	now := time.Now()

	// Clean events older than 24 hours
	cutoff24h := now.Add(-24 * time.Hour)
	newEvents := make([]SpotEvent, 0, len(ts.events))
	for _, e := range ts.events {
		if e.Timestamp.After(cutoff24h) {
			newEvents = append(newEvents, e)
		}
	}
	ts.events = newEvents

	// Count events in each time window
	cutoff1h := now.Add(-1 * time.Hour)
	cutoff3h := now.Add(-3 * time.Hour)
	cutoff6h := now.Add(-6 * time.Hour)
	cutoff12h := now.Add(-12 * time.Hour)

	ts.Last1Hour = 0
	ts.Last3Hours = 0
	ts.Last6Hours = 0
	ts.Last12Hours = 0
	ts.Last24Hours = int64(len(ts.events))

	for _, e := range ts.events {
		if e.Timestamp.After(cutoff1h) {
			ts.Last1Hour++
		}
		if e.Timestamp.After(cutoff3h) {
			ts.Last3Hours++
		}
		if e.Timestamp.After(cutoff6h) {
			ts.Last6Hours++
		}
		if e.Timestamp.After(cutoff12h) {
			ts.Last12Hours++
		}
	}
}

// CleanupOldData removes data older than 24 hours (should be called periodically)
func (cm *CWSkimmerMetrics) CleanupOldData() {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	now := time.Now()
	cutoff1h := now.Add(-1 * time.Hour)
	cutoff3h := now.Add(-3 * time.Hour)
	cutoff6h := now.Add(-6 * time.Hour)
	cutoff12h := now.Add(-12 * time.Hour)
	cutoff24h := now.Add(-24 * time.Hour)

	// Clean unique callsigns for each time window
	for band := range cm.uniqueCallsigns {
		// Rebuild unique callsigns based on actual events
		if ts := cm.spotsByBand[band]; ts != nil {
			ts.mu.RLock()

			// Clear and rebuild unique callsigns
			cm.uniqueCallsigns[band] = make(map[string]map[string]bool)
			cm.uniqueCallsigns[band]["1h"] = make(map[string]bool)
			cm.uniqueCallsigns[band]["3h"] = make(map[string]bool)
			cm.uniqueCallsigns[band]["6h"] = make(map[string]bool)
			cm.uniqueCallsigns[band]["12h"] = make(map[string]bool)
			cm.uniqueCallsigns[band]["24h"] = make(map[string]bool)

			for _, e := range ts.events {
				if e.Timestamp.After(cutoff1h) {
					cm.uniqueCallsigns[band]["1h"][e.Callsign] = true
				}
				if e.Timestamp.After(cutoff3h) {
					cm.uniqueCallsigns[band]["3h"][e.Callsign] = true
				}
				if e.Timestamp.After(cutoff6h) {
					cm.uniqueCallsigns[band]["6h"][e.Callsign] = true
				}
				if e.Timestamp.After(cutoff12h) {
					cm.uniqueCallsigns[band]["12h"][e.Callsign] = true
				}
				if e.Timestamp.After(cutoff24h) {
					cm.uniqueCallsigns[band]["24h"][e.Callsign] = true
				}
			}

			ts.mu.RUnlock()
		}
	}
}

// GetTotalSpots returns total spots for a band in a time window
func (cm *CWSkimmerMetrics) GetTotalSpots(band string, hours int) int64 {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if cm.spotsByBand[band] == nil {
		return 0
	}

	ts := cm.spotsByBand[band]
	ts.mu.RLock()
	defer ts.mu.RUnlock()

	switch hours {
	case 1:
		return ts.Last1Hour
	case 3:
		return ts.Last3Hours
	case 6:
		return ts.Last6Hours
	case 12:
		return ts.Last12Hours
	case 24:
		return ts.Last24Hours
	default:
		return 0
	}
}

// GetUniqueCallsigns returns count of unique callsign+band combinations
func (cm *CWSkimmerMetrics) GetUniqueCallsigns(band string, hours int) int {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	var window string
	switch hours {
	case 1:
		window = "1h"
	case 3:
		window = "3h"
	case 6:
		window = "6h"
	case 12:
		window = "12h"
	case 24:
		window = "24h"
	default:
		return 0
	}

	if cm.uniqueCallsigns[band] == nil ||
		cm.uniqueCallsigns[band][window] == nil {
		return 0
	}

	return len(cm.uniqueCallsigns[band][window])
}

// GetAllBands returns all active bands
func (cm *CWSkimmerMetrics) GetAllBands() []string {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	var bands []string
	for band := range cm.spotsByBand {
		bands = append(bands, band)
	}

	return bands
}

// GetAverageWPM returns average WPM for a band over specified minutes
func (cm *CWSkimmerMetrics) GetAverageWPM(band string, minutes int) float64 {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if cm.wpmMeasurements[band] == nil {
		return 0
	}

	now := time.Now()
	cutoff := now.Add(-time.Duration(minutes) * time.Minute)

	var totalWPM int
	count := 0

	for _, e := range cm.wpmMeasurements[band] {
		if e.Timestamp.After(cutoff) {
			totalWPM += e.WPM
			count++
		}
	}

	if count == 0 {
		return 0
	}

	return float64(totalWPM) / float64(count)
}

// GetWPMStats returns min, max, and average WPM for a band over specified minutes
func (cm *CWSkimmerMetrics) GetWPMStats(band string, minutes int) (avgWPM float64, minWPM, maxWPM int) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if cm.wpmMeasurements[band] == nil {
		return 0, 0, 0
	}

	now := time.Now()
	cutoff := now.Add(-time.Duration(minutes) * time.Minute)

	var totalWPM int
	count := 0
	minWPM = 0
	maxWPM = 0

	for _, e := range cm.wpmMeasurements[band] {
		if e.Timestamp.After(cutoff) {
			totalWPM += e.WPM
			count++

			if count == 1 {
				minWPM = e.WPM
				maxWPM = e.WPM
			} else {
				if e.WPM < minWPM {
					minWPM = e.WPM
				}
				if e.WPM > maxWPM {
					maxWPM = e.WPM
				}
			}
		}
	}

	if count == 0 {
		return 0, 0, 0
	}

	avgWPM = float64(totalWPM) / float64(count)
	return avgWPM, minWPM, maxWPM
}

// WriteMetricsSnapshot writes current metrics to disk (JSON Lines format)
func (cm *CWSkimmerMetrics) WriteMetricsSnapshot() error {
	if !cm.metricsLogEnabled {
		return nil
	}

	cm.mu.RLock()
	defer cm.mu.RUnlock()

	now := time.Now()

	// Write snapshot for each active band
	for band := range cm.spotsByBand {
		snapshot := cm.createSnapshot(band, now)

		// Create directory structure: metrics_dir/YYYY/MM/DD/
		dirPath := filepath.Join(
			cm.metricsLogDataDir,
			fmt.Sprintf("%04d", now.Year()),
			fmt.Sprintf("%02d", now.Month()),
			fmt.Sprintf("%02d", now.Day()),
		)

		if err := os.MkdirAll(dirPath, 0755); err != nil {
			return fmt.Errorf("failed to create metrics directory: %w", err)
		}

		// File: metrics_dir/YYYY/MM/DD/BAND.jsonl
		filename := filepath.Join(dirPath, fmt.Sprintf("%s.jsonl", band))

		// Open file in append mode
		file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return fmt.Errorf("failed to open metrics file: %w", err)
		}

		// Write JSON line
		encoder := json.NewEncoder(file)
		if err := encoder.Encode(snapshot); err != nil {
			file.Close()
			return fmt.Errorf("failed to write metrics snapshot: %w", err)
		}

		// Close file and check for errors
		if err := file.Close(); err != nil {
			return fmt.Errorf("failed to close metrics file: %w", err)
		}
	}

	cm.lastMetricsWrite = now
	return nil
}

// createSnapshot creates a metrics snapshot for a band
func (cm *CWSkimmerMetrics) createSnapshot(band string, timestamp time.Time) CWMetricsSnapshot {
	// Get spot counts
	spotCounts := CWSpotCountsSnapshot{
		Last1Hour:  cm.GetTotalSpots(band, 1),
		Last24Hour: cm.GetTotalSpots(band, 24),
	}

	// Get unique callsigns
	uniqueCallsigns := CWUniqueCallsignsSnapshot{
		Last1Hour:  cm.GetUniqueCallsigns(band, 1),
		Last24Hour: cm.GetUniqueCallsigns(band, 24),
	}

	// Calculate activity metrics
	spotsPerHour := float64(spotCounts.Last1Hour)
	callsignsPerHour := float64(uniqueCallsigns.Last1Hour)
	activityScore := (spotsPerHour / 100.0) * 100.0 // Simple score: spots/hour as percentage of 100
	if activityScore > 100 {
		activityScore = 100
	}

	activity := CWActivitySnapshot{
		SpotsPerHour:     spotsPerHour,
		CallsignsPerHour: callsignsPerHour,
		ActivityScore:    activityScore,
	}

	// Get WPM stats
	avg1m, min1m, max1m := cm.GetWPMStats(band, 1)
	avg5m, min5m, max5m := cm.GetWPMStats(band, 5)
	avg10m, min10m, max10m := cm.GetWPMStats(band, 10)

	wpmStats := CWWPMStatsSnapshot{
		Last1Min: CWWPMWindowStats{
			AvgWPM: avg1m,
			MinWPM: min1m,
			MaxWPM: max1m,
		},
		Last5Min: CWWPMWindowStats{
			AvgWPM: avg5m,
			MinWPM: min5m,
			MaxWPM: max5m,
		},
		Last10Min: CWWPMWindowStats{
			AvgWPM: avg10m,
			MinWPM: min10m,
			MaxWPM: max10m,
		},
	}

	return CWMetricsSnapshot{
		Timestamp:       timestamp,
		Band:            band,
		SpotCounts:      spotCounts,
		UniqueCallsigns: uniqueCallsigns,
		Activity:        activity,
		WPMStats:        wpmStats,
	}
}

// StartPeriodicTasks starts background tasks for metrics logging and cleanup
func (cm *CWSkimmerMetrics) StartPeriodicTasks() {
	// Metrics logging task
	if cm.metricsLogEnabled {
		go func() {
			ticker := time.NewTicker(cm.metricsLogInterval)
			defer ticker.Stop()

			for range ticker.C {
				if err := cm.WriteMetricsSnapshot(); err != nil {
					log.Printf("Error writing CW metrics snapshot: %v", err)
				}
			}
		}()
	}

	// Cleanup task (every hour)
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		for range ticker.C {
			cm.CleanupOldData()
		}
	}()

	// Summary update task (every minute) - writes summaries to disk
	go func() {
		ticker := time.NewTicker(cm.summaryUpdateInterval)
		defer ticker.Stop()

		for range ticker.C {
			if err := cm.UpdateSummaries(); err != nil {
				log.Printf("Error updating CW summaries: %v", err)
			}
		}
	}()
}

// UpdateSummaries writes summary files to disk
func (cm *CWSkimmerMetrics) UpdateSummaries() error {
	if cm.summaryAggregator == nil {
		return nil
	}

	// Write summaries to disk if needed (rate-limited to once per minute)
	return cm.summaryAggregator.WriteIfNeeded()
}

// ReadMetricsFromFiles reads CW metrics snapshots from files for a given time range
// Returns snapshots grouped by band
func (cm *CWSkimmerMetrics) ReadMetricsFromFiles(startTime, endTime time.Time) (map[string][]CWMetricsSnapshot, error) {
	if !cm.metricsLogEnabled {
		return nil, nil
	}

	result := make(map[string][]CWMetricsSnapshot)

	// Determine which dates to read
	currentDate := startTime
	for currentDate.Before(endTime) || currentDate.Equal(endTime) {
		// Build directory path for this date
		dirPath := filepath.Join(
			cm.metricsLogDataDir,
			fmt.Sprintf("%04d", currentDate.Year()),
			fmt.Sprintf("%02d", currentDate.Month()),
			fmt.Sprintf("%02d", currentDate.Day()),
		)

		// Check if directory exists
		if _, err := os.Stat(dirPath); os.IsNotExist(err) {
			// Skip to next day
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Read all .jsonl files in this directory
		files, err := filepath.Glob(filepath.Join(dirPath, "*.jsonl"))
		if err != nil {
			log.Printf("Warning: error reading CW metrics directory %s: %v", dirPath, err)
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Read each file
		for _, filePath := range files {
			snapshots, err := cm.readSnapshotsFromFile(filePath, startTime, endTime)
			if err != nil {
				log.Printf("Warning: error reading CW metrics from %s: %v", filePath, err)
				continue
			}

			// Group by band
			for _, snapshot := range snapshots {
				result[snapshot.Band] = append(result[snapshot.Band], snapshot)
			}
		}

		// Move to next day
		currentDate = currentDate.AddDate(0, 0, 1)
	}

	return result, nil
}

// readSnapshotsFromFile reads CW metrics snapshots from a single file within the time range
func (cm *CWSkimmerMetrics) readSnapshotsFromFile(filePath string, startTime, endTime time.Time) ([]CWMetricsSnapshot, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var snapshots []CWMetricsSnapshot
	decoder := json.NewDecoder(file)

	for {
		var snapshot CWMetricsSnapshot
		if err := decoder.Decode(&snapshot); err != nil {
			if err.Error() == "EOF" || strings.Contains(err.Error(), "EOF") {
				break
			}
			// Skip malformed lines
			continue
		}

		// Only include snapshots within the time range
		if (snapshot.Timestamp.Equal(startTime) || snapshot.Timestamp.After(startTime)) &&
			(snapshot.Timestamp.Equal(endTime) || snapshot.Timestamp.Before(endTime)) {
			snapshots = append(snapshots, snapshot)
		}
	}

	return snapshots, nil
}
