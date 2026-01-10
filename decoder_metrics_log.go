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

// MetricsLogger handles JSON Lines logging of decoder metrics
// Logs metrics snapshots to separate files organized by year/month/day/band
type MetricsLogger struct {
	dataDir string

	// JSON Lines logging (one file per mode-band combination per day)
	openFiles map[string]*os.File // key: mode-band/date
	fileMu    sync.Mutex

	// Control
	enabled       bool
	writeInterval time.Duration
	lastWrite     time.Time
}

// MetricsSnapshot represents a single metrics snapshot for JSON Lines output
type MetricsSnapshot struct {
	Timestamp time.Time `json:"timestamp"`
	Mode      string    `json:"mode"`
	Band      string    `json:"band"`
	BandName  string    `json:"band_name"` // Decoder config name

	// Decode counts
	DecodeCounts struct {
		Last1Hour   int64 `json:"last_1h"`
		Last3Hours  int64 `json:"last_3h"`
		Last6Hours  int64 `json:"last_6h"`
		Last12Hours int64 `json:"last_12h"`
		Last24Hours int64 `json:"last_24h"`
	} `json:"decode_counts"`

	// Decodes per cycle
	DecodesPerCycle struct {
		Last1Min  float64 `json:"last_1m"`
		Last5Min  float64 `json:"last_5m"`
		Last15Min float64 `json:"last_15m"`
		Last30Min float64 `json:"last_30m"`
		Last60Min float64 `json:"last_60m"`
	} `json:"decodes_per_cycle"`

	// Unique callsigns
	UniqueCallsigns struct {
		Last1Hour   int `json:"last_1h"`
		Last3Hours  int `json:"last_3h"`
		Last6Hours  int `json:"last_6h"`
		Last12Hours int `json:"last_12h"`
		Last24Hours int `json:"last_24h"`
	} `json:"unique_callsigns"`

	// Execution time statistics
	ExecutionTime struct {
		Last1Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_1m"`
		Last5Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_5m"`
		Last10Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_10m"`
	} `json:"execution_time"`

	// Activity metrics
	Activity struct {
		DecodesPerHour   float64 `json:"decodes_per_hour"`
		CallsignsPerHour float64 `json:"callsigns_per_hour"`
		ActivityScore    float64 `json:"activity_score"`
	} `json:"activity"`
}

// NewMetricsLogger creates a new metrics logger
func NewMetricsLogger(dataDir string, enabled bool, writeInterval time.Duration) (*MetricsLogger, error) {
	if !enabled {
		return &MetricsLogger{enabled: false}, nil
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create metrics log directory: %w", err)
	}

	ml := &MetricsLogger{
		dataDir:       dataDir,
		enabled:       true,
		writeInterval: writeInterval,
		lastWrite:     time.Now(),
		openFiles:     make(map[string]*os.File),
	}

	return ml, nil
}

// ShouldWrite returns true if enough time has passed since last write
func (ml *MetricsLogger) ShouldWrite() bool {
	if !ml.enabled {
		return false
	}
	return time.Since(ml.lastWrite) >= ml.writeInterval
}

// WriteMetrics writes current metrics snapshot for all active mode/band combinations
func (ml *MetricsLogger) WriteMetrics(dm *DigitalDecodeMetrics) error {
	if !ml.enabled {
		return nil
	}

	ml.fileMu.Lock()
	defer ml.fileMu.Unlock()

	now := time.Now()
	ml.lastWrite = now

	// Get all active mode/band combinations
	combinations := dm.GetAllModeBandCombinations()

	if len(combinations) == 0 {
		log.Printf("No active mode/band combinations to write metrics for (dm=%p, dm.decodesByModeBand has %d modes)", dm, len(dm.decodesByModeBand))
		return nil
	}

	log.Printf("Writing metrics snapshot for %d mode/band combinations", len(combinations))

	successCount := 0
	for _, combo := range combinations {
		snapshot := ml.createSnapshot(dm, combo.Mode, combo.Band, now)
		if err := ml.writeSnapshot(snapshot); err != nil {
			log.Printf("Error writing metrics snapshot for %s/%s: %v", combo.Mode, combo.Band, err)
			continue
		}
		successCount++
	}

	log.Printf("Wrote metrics snapshot: %d/%d successful", successCount, len(combinations))
	return nil
}

// createSnapshot creates a metrics snapshot for a specific mode/band
func (ml *MetricsLogger) createSnapshot(dm *DigitalDecodeMetrics, mode, band string, timestamp time.Time) *MetricsSnapshot {
	snapshot := &MetricsSnapshot{
		Timestamp: timestamp,
		Mode:      mode,
		Band:      band,
		BandName:  band, // Use band as band name for now
	}

	// Get cycle seconds
	cycleSeconds := 15
	if mode == "FT4" {
		cycleSeconds = 7
	} else if mode == "WSPR" {
		cycleSeconds = 120
	}

	// Decode counts
	snapshot.DecodeCounts.Last1Hour = dm.GetTotalDecodes(mode, band, 1)
	snapshot.DecodeCounts.Last3Hours = dm.GetTotalDecodes(mode, band, 3)
	snapshot.DecodeCounts.Last6Hours = dm.GetTotalDecodes(mode, band, 6)
	snapshot.DecodeCounts.Last12Hours = dm.GetTotalDecodes(mode, band, 12)
	snapshot.DecodeCounts.Last24Hours = dm.GetTotalDecodes(mode, band, 24)

	// Decodes per cycle
	snapshot.DecodesPerCycle.Last1Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 1)
	snapshot.DecodesPerCycle.Last5Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 5)
	snapshot.DecodesPerCycle.Last15Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 15)
	snapshot.DecodesPerCycle.Last30Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 30)
	snapshot.DecodesPerCycle.Last60Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 60)

	// Unique callsigns
	snapshot.UniqueCallsigns.Last1Hour = dm.GetUniqueCallsigns(mode, band, 1)
	snapshot.UniqueCallsigns.Last3Hours = dm.GetUniqueCallsigns(mode, band, 3)
	snapshot.UniqueCallsigns.Last6Hours = dm.GetUniqueCallsigns(mode, band, 6)
	snapshot.UniqueCallsigns.Last12Hours = dm.GetUniqueCallsigns(mode, band, 12)
	snapshot.UniqueCallsigns.Last24Hours = dm.GetUniqueCallsigns(mode, band, 24)

	// Execution time
	avg1m, min1m, max1m := dm.GetExecutionTimeStats(mode, band, 1)
	snapshot.ExecutionTime.Last1Min.Avg = avg1m
	snapshot.ExecutionTime.Last1Min.Min = min1m
	snapshot.ExecutionTime.Last1Min.Max = max1m

	avg5m, min5m, max5m := dm.GetExecutionTimeStats(mode, band, 5)
	snapshot.ExecutionTime.Last5Min.Avg = avg5m
	snapshot.ExecutionTime.Last5Min.Min = min5m
	snapshot.ExecutionTime.Last5Min.Max = max5m

	avg10m, min10m, max10m := dm.GetExecutionTimeStats(mode, band, 10)
	snapshot.ExecutionTime.Last10Min.Avg = avg10m
	snapshot.ExecutionTime.Last10Min.Min = min10m
	snapshot.ExecutionTime.Last10Min.Max = max10m

	// Activity metrics
	if snapshot.DecodeCounts.Last24Hours > 0 {
		snapshot.Activity.DecodesPerHour = float64(snapshot.DecodeCounts.Last24Hours) / 24.0
		snapshot.Activity.CallsignsPerHour = float64(snapshot.UniqueCallsigns.Last24Hours) / 24.0
		snapshot.Activity.ActivityScore = (snapshot.Activity.DecodesPerHour / 100.0) * 100.0
		if snapshot.Activity.ActivityScore > 100 {
			snapshot.Activity.ActivityScore = 100
		}
	}

	return snapshot
}

// writeSnapshot writes a single metrics snapshot to the appropriate file
// File path structure: base_dir/YYYY/MM/DD/MODE-BAND.jsonl
func (ml *MetricsLogger) writeSnapshot(snapshot *MetricsSnapshot) error {
	// Get or create file for this mode-band/date combination
	file, err := ml.getOrCreateFile(snapshot)
	if err != nil {
		return err
	}

	// Marshal snapshot to JSON
	jsonData, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("failed to marshal metrics snapshot: %w", err)
	}

	// Write JSON line
	if _, err := file.Write(jsonData); err != nil {
		return err
	}
	if _, err := file.Write([]byte("\n")); err != nil {
		return err
	}

	// Sync to ensure data is written to disk
	return file.Sync()
}

// getOrCreateFile gets or creates a file for the given snapshot
// File path structure: base_dir/YYYY/MM/DD/MODE-BAND.jsonl
func (ml *MetricsLogger) getOrCreateFile(snapshot *MetricsSnapshot) (*os.File, error) {
	// Create a unique key for this mode-band/date combination
	dateStr := snapshot.Timestamp.Format("2006-01-02")
	key := fmt.Sprintf("%s-%s/%s", snapshot.Mode, snapshot.Band, dateStr)

	// Check if we already have a file for this combination
	if file, exists := ml.openFiles[key]; exists {
		return file, nil
	}

	// Parse date to create year/month/day directory structure
	t := snapshot.Timestamp

	// Create directory path: base_dir/YYYY/MM/DD/
	dirPath := filepath.Join(
		ml.dataDir,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
	)

	// Create directory structure if it doesn't exist
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory structure: %w", err)
	}

	// Create file: base_dir/YYYY/MM/DD/MODE-BAND.jsonl
	filename := filepath.Join(dirPath, fmt.Sprintf("%s-%s.jsonl", snapshot.Mode, snapshot.Band))

	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}

	// Store file
	ml.openFiles[key] = file

	return file, nil
}

// Close closes all open files
func (ml *MetricsLogger) Close() error {
	if !ml.enabled {
		return nil
	}

	ml.fileMu.Lock()
	defer ml.fileMu.Unlock()

	// Close all open files
	for key, file := range ml.openFiles {
		if err := file.Close(); err != nil {
			log.Printf("Warning: error closing metrics file %s: %v", key, err)
		}
	}

	// Clear map
	ml.openFiles = make(map[string]*os.File)

	return nil
}

// CleanupOldFiles closes files that are no longer for today
// This should be called periodically (e.g., once per day) to prevent keeping old files open
func (ml *MetricsLogger) CleanupOldFiles() error {
	if !ml.enabled {
		return nil
	}

	ml.fileMu.Lock()
	defer ml.fileMu.Unlock()

	today := time.Now().Format("2006-01-02")
	filesToClose := make([]string, 0)

	// Find files that are not for today
	for key := range ml.openFiles {
		// Key format is "MODE-BAND/YYYY-MM-DD"
		// Extract date from key
		parts := filepath.SplitList(key)
		if len(parts) > 0 {
			dateStr := parts[len(parts)-1]
			if dateStr != today {
				filesToClose = append(filesToClose, key)
			}
		}
	}

	// Close old files
	for _, key := range filesToClose {
		if file, exists := ml.openFiles[key]; exists {
			if err := file.Close(); err != nil {
				log.Printf("Warning: error closing old metrics file %s: %v", key, err)
			}
			delete(ml.openFiles, key)
		}
	}

	return nil
}

// LoadRecentMetrics reads recent metrics from JSON Lines files and populates in-memory metrics
// Reads files from the last 24 hours to restore state after a restart
func (ml *MetricsLogger) LoadRecentMetrics(dm *DigitalDecodeMetrics) error {
	if !ml.enabled {
		return nil
	}

	now := time.Now()
	startTime := now.Add(-24 * time.Hour)

	log.Printf("Loading recent metrics from files (last 24 hours)...")

	// Determine which dates to check (today and yesterday)
	dates := []time.Time{now, now.AddDate(0, 0, -1)}
	if startTime.Day() != now.AddDate(0, 0, -1).Day() {
		// If 24 hours ago spans 3 days, add the day before yesterday
		dates = append(dates, now.AddDate(0, 0, -2))
	}

	totalSnapshots := 0
	for _, date := range dates {
		// Build directory path for this date
		dirPath := filepath.Join(
			ml.dataDir,
			fmt.Sprintf("%04d", date.Year()),
			fmt.Sprintf("%02d", date.Month()),
			fmt.Sprintf("%02d", date.Day()),
		)

		// Check if directory exists
		if _, err := os.Stat(dirPath); os.IsNotExist(err) {
			continue
		}

		// Read all .jsonl files in this directory
		files, err := filepath.Glob(filepath.Join(dirPath, "*.jsonl"))
		if err != nil {
			log.Printf("Warning: error reading metrics directory %s: %v", dirPath, err)
			continue
		}

		for _, filePath := range files {
			count, err := ml.loadMetricsFromFile(filePath, dm, startTime)
			if err != nil {
				log.Printf("Warning: error loading metrics from %s: %v", filePath, err)
				continue
			}
			totalSnapshots += count
		}
	}

	if totalSnapshots > 0 {
		log.Printf("Loaded %d metric snapshots from files", totalSnapshots)
	} else {
		log.Printf("No recent metrics found in files")
	}

	return nil
}

// loadMetricsFromFile reads metrics from a single JSON Lines file
func (ml *MetricsLogger) loadMetricsFromFile(filePath string, dm *DigitalDecodeMetrics, startTime time.Time) (int, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	count := 0
	lineNum := 0
	maxErrors := 10 // Stop after 10 consecutive errors to prevent infinite loops

	consecutiveErrors := 0
	for {
		lineNum++
		var snapshot MetricsSnapshot
		if err := decoder.Decode(&snapshot); err != nil {
			if err.Error() == "EOF" {
				break
			}
			// Skip malformed lines but track consecutive errors
			consecutiveErrors++
			if consecutiveErrors >= maxErrors {
				log.Printf("Warning: too many consecutive errors (%d) in %s at line %d, skipping rest of file", consecutiveErrors, filePath, lineNum)
				break
			}
			continue
		}

		// Reset consecutive error counter on successful decode
		consecutiveErrors = 0

		// Only load snapshots from the last 24 hours
		if snapshot.Timestamp.Before(startTime) {
			continue
		}

		// Restore execution time data points
		// We'll add data points at the snapshot timestamp with the recorded values
		if snapshot.ExecutionTime.Last1Min.Avg > 0 {
			// Create a synthetic execution time entry
			execTime := time.Duration(snapshot.ExecutionTime.Last1Min.Avg * float64(time.Second))
			dm.RecordExecutionTime(snapshot.Mode, snapshot.Band, execTime)
		}

		count++
	}

	return count, nil
}

// ReadMetricsFromFiles reads metrics snapshots from files for a given time range
// Returns snapshots grouped by mode-band combination
func (ml *MetricsLogger) ReadMetricsFromFiles(startTime, endTime time.Time) (map[string][]MetricsSnapshot, error) {
	if !ml.enabled {
		return nil, nil
	}

	result := make(map[string][]MetricsSnapshot)

	// Determine which dates to read
	currentDate := startTime
	for currentDate.Before(endTime) || currentDate.Equal(endTime) {
		// Build directory path for this date
		dirPath := filepath.Join(
			ml.dataDir,
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
			log.Printf("Warning: error reading metrics directory %s: %v", dirPath, err)
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Read each file
		for _, filePath := range files {
			snapshots, err := ml.readSnapshotsFromFile(filePath, startTime, endTime)
			if err != nil {
				log.Printf("Warning: error reading metrics from %s: %v", filePath, err)
				continue
			}

			// Group by mode-band
			for _, snapshot := range snapshots {
				key := fmt.Sprintf("%s:%s", snapshot.Mode, snapshot.Band)
				result[key] = append(result[key], snapshot)
			}
		}

		// Move to next day
		currentDate = currentDate.AddDate(0, 0, 1)
	}

	return result, nil
}

// readSnapshotsFromFile reads snapshots from a single file within the time range
func (ml *MetricsLogger) readSnapshotsFromFile(filePath string, startTime, endTime time.Time) ([]MetricsSnapshot, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var snapshots []MetricsSnapshot
	decoder := json.NewDecoder(file)

	for {
		var snapshot MetricsSnapshot
		if err := decoder.Decode(&snapshot); err != nil {
			if err.Error() == "EOF" {
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
