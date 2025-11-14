package main

import (
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// SpotsLogger handles CSV logging of decoder spots (FT8/FT4/WSPR)
// Logs all spots to separate CSV files organized by mode/date/band
type SpotsLogger struct {
	dataDir string

	// CSV logging (one file per mode/date/band combination)
	openFiles  map[string]*os.File    // key: mode/date/band
	csvWriters map[string]*csv.Writer // key: mode/date/band
	fileMu     sync.Mutex

	// Control
	enabled bool
}

// SpotRecord represents a decoded spot from CSV
type SpotRecord struct {
	Timestamp string `json:"timestamp"`
	Callsign  string `json:"callsign"`
	Locator   string `json:"locator"`
	SNR       int    `json:"snr"`
	Frequency uint64 `json:"frequency"`
	Message   string `json:"message"`
	Country   string `json:"country"`
	CQZone    int    `json:"cq_zone"`
	ITUZone   int    `json:"itu_zone"`
	Continent string `json:"continent"`
	Mode      string `json:"mode"`
	Band      string `json:"band"`
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

// GetHistoricalSpots reads historical spots from CSV files
// Parameters:
// - mode: Filter by mode (FT8, FT4, WSPR) - empty for all modes
// - band: Filter by band name - empty for all bands
// - fromDate: Start date (YYYY-MM-DD)
// - toDate: End date (YYYY-MM-DD) - empty for single day
// - deduplicate: If true, only return unique callsign/locator combinations per day
func (sl *SpotsLogger) GetHistoricalSpots(mode, band, fromDate, toDate string, deduplicate bool) ([]SpotRecord, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("spots logging is not enabled")
	}

	// If toDate is empty, use fromDate (single day query)
	if toDate == "" {
		toDate = fromDate
	}

	// Parse dates
	startDate, err := time.Parse("2006-01-02", fromDate)
	if err != nil {
		return nil, fmt.Errorf("invalid from_date format (use YYYY-MM-DD): %w", err)
	}

	endDate, err := time.Parse("2006-01-02", toDate)
	if err != nil {
		return nil, fmt.Errorf("invalid to_date format (use YYYY-MM-DD): %w", err)
	}

	// Ensure startDate <= endDate
	if startDate.After(endDate) {
		return nil, fmt.Errorf("from_date must be before or equal to to_date")
	}

	// Determine which modes to query
	modes := []string{"FT8", "FT4", "WSPR"}
	if mode != "" {
		modes = []string{mode}
	}

	// Collect all spots
	allSpots := make([]SpotRecord, 0)
	seenSpots := make(map[string]bool) // For deduplication: key = callsign+locator+date

	// Iterate through each date in the range
	currentDate := startDate
	for !currentDate.After(endDate) {
		dateStr := currentDate.Format("2006-01-02")

		// Query each mode
		for _, m := range modes {
			spots, err := sl.readSpotsForDate(m, band, dateStr)
			if err != nil {
				// Skip if file doesn't exist
				continue
			}

			// Add spots with deduplication if requested
			for _, spot := range spots {
				if deduplicate {
					// Create dedup key: callsign+locator+date
					dedupKey := fmt.Sprintf("%s|%s|%s", spot.Callsign, spot.Locator, dateStr)
					if seenSpots[dedupKey] {
						continue // Skip duplicate
					}
					seenSpots[dedupKey] = true
				}
				allSpots = append(allSpots, spot)
			}
		}

		currentDate = currentDate.AddDate(0, 0, 1)
	}

	return allSpots, nil
}

// readSpotsForDate reads spots for a specific mode and date
func (sl *SpotsLogger) readSpotsForDate(mode, band, dateStr string) ([]SpotRecord, error) {
	// Parse date to get year/month/day
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return nil, err
	}

	// Build directory path: base_dir/MODE/YYYY/MM/DD/
	dirPath := filepath.Join(
		sl.dataDir,
		mode,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
		fmt.Sprintf("%02d", t.Day()),
	)

	// Check if directory exists
	if _, err := os.Stat(dirPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("no data for date %s", dateStr)
	}

	// If band is specified, read only that band's file
	if band != "" {
		return sl.readBandFile(dirPath, band, mode)
	}

	// Otherwise, read all CSV files in the directory
	files, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	allSpots := make([]SpotRecord, 0)
	for _, file := range files {
		if file.IsDir() || filepath.Ext(file.Name()) != ".csv" {
			continue
		}

		bandName := file.Name()[:len(file.Name())-4] // Remove .csv extension
		spots, err := sl.readBandFile(dirPath, bandName, mode)
		if err != nil {
			continue
		}
		allSpots = append(allSpots, spots...)
	}

	return allSpots, nil
}

// readBandFile reads a single band CSV file
func (sl *SpotsLogger) readBandFile(dirPath, bandName, mode string) ([]SpotRecord, error) {
	filename := filepath.Join(dirPath, fmt.Sprintf("%s.csv", bandName))

	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	reader := csv.NewReader(file)
	records, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}

	if len(records) < 2 {
		return nil, nil // No data (only header or empty)
	}

	// Parse records (skip header)
	spots := make([]SpotRecord, 0, len(records)-1)
	for _, record := range records[1:] {
		if len(record) < 10 {
			continue
		}

		spot := SpotRecord{
			Timestamp: record[0],
			Callsign:  record[1],
			Locator:   record[2],
			Message:   record[5],
			Country:   record[6],
			Continent: record[9],
			Mode:      mode,
			Band:      bandName,
		}

		// Parse numeric fields
		fmt.Sscanf(record[3], "%d", &spot.SNR)
		fmt.Sscanf(record[4], "%d", &spot.Frequency)
		fmt.Sscanf(record[7], "%d", &spot.CQZone)
		fmt.Sscanf(record[8], "%d", &spot.ITUZone)

		spots = append(spots, spot)
	}

	return spots, nil
}

// GetAvailableDates returns a list of dates for which spot data is available
func (sl *SpotsLogger) GetAvailableDates() ([]string, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("spots logging is not enabled")
	}

	dateMap := make(map[string]bool)

	// Check all modes
	modes := []string{"FT8", "FT4", "WSPR"}
	for _, mode := range modes {
		modePath := filepath.Join(sl.dataDir, mode)

		// Check if mode directory exists
		if _, err := os.Stat(modePath); os.IsNotExist(err) {
			continue
		}

		// Walk through year directories
		yearDirs, err := os.ReadDir(modePath)
		if err != nil {
			continue
		}

		for _, yearDir := range yearDirs {
			if !yearDir.IsDir() {
				continue
			}
			year := yearDir.Name()

			// Walk through month directories
			monthPath := filepath.Join(modePath, year)
			monthDirs, err := os.ReadDir(monthPath)
			if err != nil {
				continue
			}

			for _, monthDir := range monthDirs {
				if !monthDir.IsDir() {
					continue
				}
				month := monthDir.Name()

				// Walk through day directories
				dayPath := filepath.Join(monthPath, month)
				dayDirs, err := os.ReadDir(dayPath)
				if err != nil {
					continue
				}

				for _, dayDir := range dayDirs {
					if !dayDir.IsDir() {
						continue
					}
					day := dayDir.Name()

					// Construct date string
					dateStr := fmt.Sprintf("%s-%s-%s", year, month, day)
					dateMap[dateStr] = true
				}
			}
		}
	}

	// Convert map to sorted slice
	dates := make([]string, 0, len(dateMap))
	for date := range dateMap {
		dates = append(dates, date)
	}

	// Sort dates in descending order (newest first)
	sort.Slice(dates, func(i, j int) bool {
		return dates[i] > dates[j]
	})

	return dates, nil
}