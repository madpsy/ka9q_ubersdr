package main

import (
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// CWSkimmerSpotsLogger handles CSV logging of CW Skimmer spots
// Logs spots to separate CSV files organized by date/band with CW-specific fields
type CWSkimmerSpotsLogger struct {
	dataDir string

	// CSV logging (one file per date/band combination)
	openFiles  map[string]*os.File    // key: date/band
	csvWriters map[string]*csv.Writer // key: date/band
	fileMu     sync.Mutex

	// Control
	enabled bool
}

// NewCWSkimmerSpotsLogger creates a new CW Skimmer spots logger
func NewCWSkimmerSpotsLogger(dataDir string, enabled bool) (*CWSkimmerSpotsLogger, error) {
	if !enabled {
		return &CWSkimmerSpotsLogger{enabled: false}, nil
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create CW Skimmer spots log directory: %w", err)
	}

	sl := &CWSkimmerSpotsLogger{
		dataDir:    dataDir,
		enabled:    true,
		openFiles:  make(map[string]*os.File),
		csvWriters: make(map[string]*csv.Writer),
	}

	return sl, nil
}

// LogSpot writes a CW Skimmer spot to the appropriate CSV file (organized by date/band)
func (sl *CWSkimmerSpotsLogger) LogSpot(spot *CWSkimmerSpot) error {
	if !sl.enabled {
		return nil
	}

	sl.fileMu.Lock()
	defer sl.fileMu.Unlock()

	// Get or create the CSV writer for this date/band combination
	writer, err := sl.getOrCreateWriter(spot)
	if err != nil {
		return err
	}

	// Format optional float pointers
	distanceStr := ""
	if spot.DistanceKm != nil {
		distanceStr = fmt.Sprintf("%.1f", *spot.DistanceKm)
	}
	bearingStr := ""
	if spot.BearingDeg != nil {
		bearingStr = fmt.Sprintf("%.1f", *spot.BearingDeg)
	}

	// Write CSV record
	record := []string{
		spot.Time.Format(time.RFC3339),
		spot.DXCall,
		fmt.Sprintf("%d", spot.SNR),
		fmt.Sprintf("%.0f", spot.Frequency), // Frequency in Hz
		spot.Band,
		fmt.Sprintf("%d", spot.WPM),
		spot.Comment, // CQ, DE, or empty
		spot.Country,
		fmt.Sprintf("%d", spot.CQZone),
		fmt.Sprintf("%d", spot.ITUZone),
		spot.Continent,
		distanceStr,
		bearingStr,
	}

	if err := writer.Write(record); err != nil {
		return err
	}

	// Flush after each write to ensure data is saved
	writer.Flush()
	return writer.Error()
}

// getOrCreateWriter gets or creates a CSV writer for the given spot
// File path structure: base_dir/YYYY/MM/DD/bandname.csv
func (sl *CWSkimmerSpotsLogger) getOrCreateWriter(spot *CWSkimmerSpot) (*csv.Writer, error) {
	// Create a unique key for this date/band combination
	dateStr := spot.Time.Format("2006-01-02")
	key := fmt.Sprintf("%s/%s", dateStr, spot.Band)

	// Check if we already have a writer for this combination
	if writer, exists := sl.csvWriters[key]; exists {
		return writer, nil
	}

	// Parse date to create year/month/day directory structure
	t := spot.Time

	// Create directory path: base_dir/YYYY/MM/DD/
	dirPath := filepath.Join(
		sl.dataDir,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
	)

	// Create directory structure if it doesn't exist
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory structure: %w", err)
	}

	// Create file: base_dir/YYYY/MM/DD/bandname.csv
	filename := filepath.Join(dirPath, fmt.Sprintf("%s.csv", spot.Band))

	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}

	// Check if file is new (needs header)
	stat, _ := file.Stat()
	needsHeader := stat.Size() == 0

	// Create CSV writer
	writer := csv.NewWriter(file)

	// Store file and writer
	sl.openFiles[key] = file
	sl.csvWriters[key] = writer

	// Write header if new file
	if needsHeader {
		header := []string{
			"timestamp", "callsign", "snr", "frequency", "band", "wpm",
			"comment", "country", "cq_zone", "itu_zone", "continent",
			"distance_km", "bearing_deg",
		}
		if err := writer.Write(header); err != nil {
			return nil, fmt.Errorf("failed to write CSV header: %w", err)
		}
		writer.Flush()
	}

	return writer, nil
}

// Close closes all open CSV files
func (sl *CWSkimmerSpotsLogger) Close() error {
	if !sl.enabled {
		return nil
	}

	sl.fileMu.Lock()
	defer sl.fileMu.Unlock()

	// Close all open files
	for key, file := range sl.openFiles {
		if err := file.Close(); err != nil {
			log.Printf("Warning: error closing CW Skimmer spots CSV file %s: %v", key, err)
		}
	}

	// Clear maps
	sl.openFiles = make(map[string]*os.File)
	sl.csvWriters = make(map[string]*csv.Writer)

	return nil

}
