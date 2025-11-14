package main

import (
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	Timestamp  string   `json:"timestamp"`
	Callsign   string   `json:"callsign"`
	Locator    string   `json:"locator"`
	SNR        int      `json:"snr"`
	Frequency  uint64   `json:"frequency"`
	Band       string   `json:"band"` // Calculated from frequency (e.g., "20m", "40m")
	Message    string   `json:"message"`
	Country    string   `json:"country"`
	CQZone     int      `json:"cq_zone"`
	ITUZone    int      `json:"itu_zone"`
	Continent  string   `json:"continent"`
	DistanceKm *float64 `json:"distance_km,omitempty"` // Distance from receiver in km
	BearingDeg *float64 `json:"bearing_deg,omitempty"` // Bearing from receiver in degrees
	Mode       string   `json:"mode"`
	Name       string   `json:"name"` // Decoder config band name
}

// formatOptionalFloat formats an optional float64 pointer for CSV output
func formatOptionalFloat(val *float64) string {
	if val == nil {
		return ""
	}
	return fmt.Sprintf("%.1f", *val)
}

// matchesDirection checks if a bearing matches a cardinal direction
// Directions are divided into 45-degree sectors:
// N: 337.5-22.5, NE: 22.5-67.5, E: 67.5-112.5, SE: 112.5-157.5
// S: 157.5-202.5, SW: 202.5-247.5, W: 247.5-292.5, NW: 292.5-337.5
func matchesDirection(bearing float64, direction string) bool {
	// Normalize bearing to 0-360 range
	for bearing < 0 {
		bearing += 360
	}
	for bearing >= 360 {
		bearing -= 360
	}

	switch direction {
	case "N":
		return bearing >= 337.5 || bearing < 22.5
	case "NE":
		return bearing >= 22.5 && bearing < 67.5
	case "E":
		return bearing >= 67.5 && bearing < 112.5
	case "SE":
		return bearing >= 112.5 && bearing < 157.5
	case "S":
		return bearing >= 157.5 && bearing < 202.5
	case "SW":
		return bearing >= 202.5 && bearing < 247.5
	case "W":
		return bearing >= 247.5 && bearing < 292.5
	case "NW":
		return bearing >= 292.5 && bearing < 337.5
	default:
		return false
	}
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

	// Calculate band from frequency
	band := frequencyToBand(float64(decode.Frequency))

	// Write CSV record
	record := []string{
		decode.Timestamp.Format(time.RFC3339),
		decode.Callsign,
		decode.Locator,
		fmt.Sprintf("%d", decode.SNR),
		fmt.Sprintf("%d", decode.Frequency),
		band,
		decode.Message,
		decode.Country,
		fmt.Sprintf("%d", decode.CQZone),
		fmt.Sprintf("%d", decode.ITUZone),
		decode.Continent,
		formatOptionalFloat(decode.DistanceKm),
		formatOptionalFloat(decode.BearingDeg),
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
			"timestamp", "callsign", "locator", "snr", "frequency", "band",
			"message", "country", "cq_zone", "itu_zone", "continent",
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
// - band: Filter by calculated band (e.g., "20m", "40m") - empty for all bands
// - name: Filter by decoder config name - empty for all names
// - callsign: Filter by exact callsign match - empty for all callsigns
// - locator: Filter by exact locator match - empty for all locators
// - continent: Filter by continent code (AF, AS, EU, NA, OC, SA, AN) - empty for all
// - direction: Filter by cardinal direction (N, NE, E, SE, S, SW, W, NW) - empty for all
// - fromDate: Start date (YYYY-MM-DD)
// - toDate: End date (YYYY-MM-DD) - empty for single day
// - deduplicate: If true, only return unique callsign/locator combinations per day
// - locatorsOnly: If true, only return spots that have a locator
// - minDistanceKm: Minimum distance in km (0 = no filter)
// - minSNR: Minimum SNR in dB (-999 = no filter)
func (sl *SpotsLogger) GetHistoricalSpots(mode, band, name, callsign, locator, continent, direction, fromDate, toDate string, deduplicate, locatorsOnly bool, minDistanceKm float64, minSNR int) ([]SpotRecord, error) {
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
	seenSpots := make(map[string]SpotRecord) // For deduplication: key = callsign+locator+date, value = latest spot

	// Iterate through each date in the range
	currentDate := startDate
	for !currentDate.After(endDate) {
		dateStr := currentDate.Format("2006-01-02")

		// Query each mode
		for _, m := range modes {
			spots, err := sl.readSpotsForDate(m, name, dateStr)
			if err != nil {
				// Skip if file doesn't exist
				continue
			}

			// Add spots with filtering and deduplication
			for _, spot := range spots {
				// Filter by calculated band if specified
				if band != "" && spot.Band != band {
					continue
				}

				// Filter by exact callsign match if specified
				if callsign != "" && spot.Callsign != callsign {
					continue
				}

				// Filter by exact locator match if specified
				if locator != "" && spot.Locator != locator {
					continue
				}

				// Filter by continent if specified
				if continent != "" && spot.Continent != continent {
					continue
				}

				// Filter by locators only if specified
				if locatorsOnly && spot.Locator == "" {
					continue
				}

				// Filter by minimum distance if specified
				if minDistanceKm > 0 {
					if spot.DistanceKm == nil || *spot.DistanceKm < minDistanceKm {
						continue
					}
				}

				// Filter by direction if specified
				if direction != "" {
					if spot.BearingDeg == nil || !matchesDirection(*spot.BearingDeg, direction) {
						continue
					}
				}

				// Filter by minimum SNR if specified
				if minSNR > -999 {
					if spot.SNR < minSNR {
						continue
					}
				}

				if deduplicate {
					// Create dedup key: callsign+locator+date
					dedupKey := fmt.Sprintf("%s|%s|%s", spot.Callsign, spot.Locator, dateStr)

					// Check if we've seen this combination before
					if existingSpot, exists := seenSpots[dedupKey]; exists {
						// Keep the one with the later timestamp
						if spot.Timestamp > existingSpot.Timestamp {
							seenSpots[dedupKey] = spot
						}
						// Skip adding to allSpots - we'll add deduplicated spots later
						continue
					} else {
						// First time seeing this combination
						seenSpots[dedupKey] = spot
						continue
					}
				}
				allSpots = append(allSpots, spot)
			}
		}

		currentDate = currentDate.AddDate(0, 0, 1)
	}

	// If deduplication was enabled, add the deduplicated spots to allSpots
	if deduplicate {
		for _, spot := range seenSpots {
			allSpots = append(allSpots, spot)
		}
	}

	// Sort spots by timestamp in descending order (newest first)
	sort.Slice(allSpots, func(i, j int) bool {
		return allSpots[i].Timestamp > allSpots[j].Timestamp
	})

	return allSpots, nil
}

// readSpotsForDate reads spots for a specific mode and date
// The 'name' parameter filters by decoder config name (directory name in file structure)
func (sl *SpotsLogger) readSpotsForDate(mode, name, dateStr string) ([]SpotRecord, error) {
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

	// If name is specified, read only that name's file
	if name != "" {
		return sl.readNameFile(dirPath, name, mode)
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

		configName := file.Name()[:len(file.Name())-4] // Remove .csv extension
		spots, err := sl.readNameFile(dirPath, configName, mode)
		if err != nil {
			continue
		}
		allSpots = append(allSpots, spots...)
	}

	return allSpots, nil
}

// readNameFile reads a single decoder config name CSV file
func (sl *SpotsLogger) readNameFile(dirPath, configName, mode string) ([]SpotRecord, error) {
	filename := filepath.Join(dirPath, fmt.Sprintf("%s.csv", configName))

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
		// Support both old format (11 columns) and new format (13 columns)
		if len(record) < 11 {
			continue
		}

		spot := SpotRecord{
			Timestamp: record[0],
			Callsign:  record[1],
			Locator:   record[2],
			Band:      record[5], // Calculated band from frequency
			Message:   record[6],
			Country:   record[7],
			Continent: record[10],
			Mode:      mode,
			Name:      configName, // Decoder config band name
		}

		// Parse numeric fields
		fmt.Sscanf(record[3], "%d", &spot.SNR)
		fmt.Sscanf(record[4], "%d", &spot.Frequency)
		fmt.Sscanf(record[8], "%d", &spot.CQZone)
		fmt.Sscanf(record[9], "%d", &spot.ITUZone)

		// Parse distance and bearing if present (new format with 13 columns)
		if len(record) >= 13 {
			if record[11] != "" {
				var dist float64
				if _, err := fmt.Sscanf(record[11], "%f", &dist); err == nil {
					spot.DistanceKm = &dist
				}
			}
			if record[12] != "" {
				var bearing float64
				if _, err := fmt.Sscanf(record[12], "%f", &bearing); err == nil {
					spot.BearingDeg = &bearing
				}
			}
		}

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

// GetAvailableNames returns a list of unique decoder config names that have spot data
func (sl *SpotsLogger) GetAvailableNames() ([]string, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("spots logging is not enabled")
	}

	nameMap := make(map[string]bool)

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

					// Read CSV files in this day directory
					csvPath := filepath.Join(dayPath, day)
					csvFiles, err := os.ReadDir(csvPath)
					if err != nil {
						continue
					}

					for _, csvFile := range csvFiles {
						if csvFile.IsDir() || filepath.Ext(csvFile.Name()) != ".csv" {
							continue
						}
						// Extract name from filename (remove .csv extension)
						name := csvFile.Name()[:len(csvFile.Name())-4]
						nameMap[name] = true
					}
				}
			}
		}
	}

	// Convert map to sorted slice
	names := make([]string, 0, len(nameMap))
	for name := range nameMap {
		names = append(names, name)
	}

	// Sort names alphabetically
	sort.Strings(names)

	return names, nil
}

// GetHistoricalCSV returns historical spots data as CSV string
// Parameters match GetHistoricalSpots for filtering
func (sl *SpotsLogger) GetHistoricalCSV(mode, band, name, callsign, locator, continent, direction, fromDate, toDate string, deduplicate, locatorsOnly bool, minDistanceKm float64, minSNR int) (string, error) {
	// Get the spots data using existing method
	spots, err := sl.GetHistoricalSpots(mode, band, name, callsign, locator, continent, direction, fromDate, toDate, deduplicate, locatorsOnly, minDistanceKm, minSNR)
	if err != nil {
		return "", err
	}

	if len(spots) == 0 {
		return "", fmt.Errorf("no data available for the specified parameters")
	}

	// Build CSV string
	var csvBuilder strings.Builder

	// Write header
	csvBuilder.WriteString("timestamp,callsign,locator,snr,frequency,band,message,country,cq_zone,itu_zone,continent,distance_km,bearing_deg,mode,name\n")

	// Write data rows
	for _, spot := range spots {
		// Format distance and bearing
		distStr := ""
		if spot.DistanceKm != nil {
			distStr = fmt.Sprintf("%.1f", *spot.DistanceKm)
		}
		bearingStr := ""
		if spot.BearingDeg != nil {
			bearingStr = fmt.Sprintf("%.1f", *spot.BearingDeg)
		}

		// Escape fields that might contain commas or quotes
		message := escapeCSVField(spot.Message)
		country := escapeCSVField(spot.Country)

		csvBuilder.WriteString(fmt.Sprintf("%s,%s,%s,%d,%d,%s,%s,%s,%d,%d,%s,%s,%s,%s,%s\n",
			spot.Timestamp,
			spot.Callsign,
			spot.Locator,
			spot.SNR,
			spot.Frequency,
			spot.Band,
			message,
			country,
			spot.CQZone,
			spot.ITUZone,
			spot.Continent,
			distStr,
			bearingStr,
			spot.Mode,
			spot.Name,
		))
	}

	return csvBuilder.String(), nil
}

// escapeCSVField escapes a field for CSV output
func escapeCSVField(field string) string {
	// If field contains comma, quote, or newline, wrap in quotes and escape quotes
	if strings.ContainsAny(field, ",\"\n\r") {
		field = strings.ReplaceAll(field, "\"", "\"\"")
		return "\"" + field + "\""
	}
	return field
}
