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

// SpotsLogger handles CSV logging of decoder spots (FT8/FT4/WSPR)
// Logs all spots to separate CSV files organized by mode/date/band
type SpotsLogger struct {
	dataDir string

	// CSV logging (one file per mode/date/band combination)
	openFiles   map[string]*os.File      // key: mode/date/band
	csvWriters  map[string]*csv.Writer   // key: mode/date/band
	fileMu      sync.Mutex

	// Control
	enabled bool
}

// NewSpotsLogger creates a new spots logger
func NewSpotsLogger(dataDir string, enabled bool) (*SpotsLogger, error) {
	if !enabled {
		return &SpotsLogger{enabled: false}, nil
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create spots log directory: %w", err)
	}

	sl := &SpotsLogger{
		dataDir:    dataDir,
		enabled:    true,
		openFiles:  make(map[string]*os.File),
		csvWriters: make(map[string]*csv.Writer),
	}

	return sl, nil
}

// LogSpot writes a spot to the appropriate CSV file (organized by mode/date/band)
func (sl *SpotsLogger) LogSpot(decode *DecodeInfo) error {
	if !sl.enabled {
		return nil
	}

	sl.fileMu.Lock()
	defer sl.fileMu.Unlock()

	// Get or create the CSV writer for this mode/date/band combination
	writer, err := sl.getOrCreateWriter(decode)
	if err != nil {
		return err
	}

	// Write CSV record
	record := []string{
		decode.Timestamp.Format(time.RFC3339),
		decode.Callsign,
		decode.Locator,
		fmt.Sprintf("%d", decode.SNR),
		fmt.Sprintf("%d", decode.Frequency),
		decode.Message,
		decode.Country,
		fmt.Sprintf("%d", decode.CQZone),
		fmt.Sprintf("%d", decode.ITUZone),
		decode.Continent,
	}

	if err := writer.Write(record); err != nil {
		return err
	}

	// Flush after each write to ensure data is saved
	writer.Flush()
	return writer.Error()
}

// getOrCreateWriter gets or creates a CSV writer for the given decode
// File path structure: base_dir/MODE/YYYY/MM/DD/bandname.csv
func (sl *SpotsLogger) getOrCreateWriter(decode *DecodeInfo) (*csv.Writer, error) {
	// Create a unique key for this mode/date/band combination
	dateStr := decode.Timestamp.Format("2006-01-02")
	key := fmt.Sprintf("%s/%s/%s", decode.Mode, dateStr, decode.BandName)

	// Check if we already have a writer for this combination
	if writer, exists := sl.csvWriters[key]; exists {
		return writer, nil
	}

	// Parse date to create year/month/day directory structure
	t := decode.Timestamp

	// Create directory path: base_dir/MODE/YYYY/MM/DD/
	dirPath := filepath.Join(
		sl.dataDir,
		decode.Mode,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
	)

	// Create directory structure if it doesn't exist
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory structure: %w", err)
	}

	// Create file: base_dir/MODE/YYYY/MM/DD/bandname.csv
	filename := filepath.Join(dirPath, fmt.Sprintf("%s.csv", decode.BandName))
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
			"timestamp", "callsign", "locator", "snr", "frequency",
			"message", "country", "cq_zone", "itu_zone", "continent",
		}
		if err := writer.Write(header); err != nil {
			return nil, fmt.Errorf("failed to write CSV header: %w", err)
		}
		writer.Flush()
		log.Printf("Created new spots log file: %s", filename)
	}

	return writer, nil
}

// Close closes all open CSV files
func (sl *SpotsLogger) Close() error {
	if !sl.enabled {
		return nil
	}

	sl.fileMu.Lock()
	defer sl.fileMu.Unlock()

	// Close all open files
	for key, file := range sl.openFiles {
		if err := file.Close(); err != nil {
			log.Printf("Warning: error closing spots CSV file %s: %v", key, err)
		}
	}

	// Clear maps
	sl.openFiles = make(map[string]*os.File)
	sl.csvWriters = make(map[string]*csv.Writer)

	return nil
}