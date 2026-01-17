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

// SpotsLogger handles CSV logging of decoder spots (FT8/FT4/WSPR/JS8)
// Logs all spots to separate CSV files organized by mode/date/band
type SpotsLogger struct {
	dataDir    string
	maxAgeDays int // Maximum age of log files in days (0 = no cleanup)

	// CSV logging (one file per mode/date/band combination)
	openFiles  map[string]*os.File    // key: mode/date/band
	csvWriters map[string]*csv.Writer // key: mode/date/band
	fileMu     sync.Mutex

	// Control
	enabled   bool
	stopClean chan struct{} // Signal to stop cleanup goroutine
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
func NewSpotsLogger(dataDir string, enabled bool, maxAgeDays int) (*SpotsLogger, error) {
	if !enabled {
		return &SpotsLogger{enabled: false}, nil
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create spots log directory: %w", err)
	}

	// Default to 90 days if not specified
	if maxAgeDays == 0 {
		maxAgeDays = 90
	}

	sl := &SpotsLogger{
		dataDir:    dataDir,
		maxAgeDays: maxAgeDays,
		enabled:    true,
		openFiles:  make(map[string]*os.File),
		csvWriters: make(map[string]*csv.Writer),
		stopClean:  make(chan struct{}),
	}

	// Start cleanup goroutine if maxAgeDays > 0
	if maxAgeDays > 0 {
		go sl.cleanupLoop()
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

// Close closes all open CSV files and stops the cleanup goroutine
func (sl *SpotsLogger) Close() error {
	if !sl.enabled {
		return nil
	}

	// Stop cleanup goroutine
	if sl.stopClean != nil {
		close(sl.stopClean)
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
// - startTime: Start time (HH:MM) - empty for no time filter
// - endTime: End time (HH:MM) - empty for no time filter
// - deduplicate: If true, only return unique callsign/locator combinations per day
// - locatorsOnly: If true, only return spots that have a locator
// - minDistanceKm: Minimum distance in km (0 = no filter)
// - minSNR: Minimum SNR in dB (-999 = no filter)
func (sl *SpotsLogger) GetHistoricalSpots(mode, band, name, callsign, locator, continent, direction, fromDate, toDate, startTime, endTime string, deduplicate, locatorsOnly bool, minDistanceKm float64, minSNR int) ([]SpotRecord, error) {
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
	modes := []string{"FT8", "FT4", "WSPR", "JS8"}
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
				// Filter by time range if specified
				if startTime != "" || endTime != "" {
					spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
					if err != nil {
						continue
					}
					spotHourMin := spotTime.Format("15:04")

					if startTime != "" && spotHourMin < startTime {
						continue
					}
					if endTime != "" && spotHourMin > endTime {
						continue
					}
				}

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
					// Create dedup key: callsign+locator+band+mode+date
					// This allows the same callsign/locator to appear on different bands/modes
					dedupKey := fmt.Sprintf("%s|%s|%s|%s|%s", spot.Callsign, spot.Locator, spot.Band, spot.Mode, dateStr)

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
	modes := []string{"FT8", "FT4", "WSPR", "JS8"}
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
	modes := []string{"FT8", "FT4", "WSPR", "JS8"}
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
func (sl *SpotsLogger) GetHistoricalCSV(mode, band, name, callsign, locator, continent, direction, fromDate, toDate, startTime, endTime string, deduplicate, locatorsOnly bool, minDistanceKm float64, minSNR int) (string, error) {
	// Get the spots data using existing method
	spots, err := sl.GetHistoricalSpots(mode, band, name, callsign, locator, continent, direction, fromDate, toDate, startTime, endTime, deduplicate, locatorsOnly, minDistanceKm, minSNR)
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

// CallsignInfo represents a callsign with its mode/band combinations
type CallsignInfo struct {
	Callsign string   `json:"callsign"`
	Bands    []string `json:"bands"` // e.g., ["FT8 20m", "WSPR 40m"]
}

// LocatorStats represents statistics for a specific locator
type LocatorStats struct {
	Locator         string         `json:"locator"`
	AvgSNR          float64        `json:"avg_snr"`
	Count           int            `json:"count"`
	UniqueCallsigns int            `json:"unique_callsigns"`
	Callsigns       []CallsignInfo `json:"callsigns"` // List of all unique callsigns with their bands
}

// BandAnalytics represents analytics for a specific band
type BandAnalytics struct {
	Band               string         `json:"band"`
	Spots              int            `json:"spots"`
	UniqueCallsigns    int            `json:"unique_callsigns"`
	MinSNR             float64        `json:"min_snr"`
	AvgSNR             float64        `json:"avg_snr"`
	MaxSNR             float64        `json:"max_snr"`
	UniqueLocators     []LocatorStats `json:"unique_locators"`
	BestHoursUTC       []int          `json:"best_hours_utc"`
	HourlyDistribution map[string]int `json:"hourly_distribution"`
}

// CountryAnalytics represents analytics for a specific country
type CountryAnalytics struct {
	Country    string          `json:"country"`
	Continent  string          `json:"continent"`
	Latitude   *float64        `json:"latitude,omitempty"`  // Representative lat from CTY.dat
	Longitude  *float64        `json:"longitude,omitempty"` // Representative lon from CTY.dat
	TotalSpots int             `json:"total_spots"`
	Bands      []BandAnalytics `json:"bands"`
}

// ContinentAnalytics represents analytics for a specific continent
type ContinentAnalytics struct {
	Continent      string          `json:"continent"`
	ContinentName  string          `json:"continent_name"`
	TotalSpots     int             `json:"total_spots"`
	CountriesCount int             `json:"countries_count"`
	Bands          []BandAnalytics `json:"bands"`
}

// AnalyticsResponse represents the complete analytics response
type AnalyticsResponse struct {
	TimeRange struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Hours int    `json:"hours"`
	} `json:"time_range"`
	Filters struct {
		MinSNR    int    `json:"min_snr"`
		Country   string `json:"country,omitempty"`
		Continent string `json:"continent,omitempty"`
	} `json:"filters"`
	ByCountry   []CountryAnalytics   `json:"by_country"`
	ByContinent []ContinentAnalytics `json:"by_continent"`
}

// GetSpotsAnalytics aggregates spots data for analytics
func (sl *SpotsLogger) GetSpotsAnalytics(filterCountry, filterContinent, filterMode, filterBand string, minSNR, hours int) (*AnalyticsResponse, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("spots logging is not enabled")
	}

	// Calculate date range
	now := time.Now()
	toDate := now.Format("2006-01-02")
	fromTime := now.Add(-time.Duration(hours) * time.Hour)
	fromDate := fromTime.Format("2006-01-02")

	// Get spots using existing method
	spots, err := sl.GetHistoricalSpots(
		filterMode,      // mode filter
		filterBand,      // band filter
		"",              // name - all names
		"",              // callsign - all callsigns
		"",              // locator - all locators
		filterContinent, // continent filter
		"",              // direction - all directions
		fromDate,
		toDate,
		"",    // startTime - no time filter
		"",    // endTime - no time filter
		false, // deduplicate
		true,  // locatorsOnly
		0,     // minDistanceKm
		minSNR,
	)
	if err != nil {
		return nil, err
	}

	// Filter by country if specified
	if filterCountry != "" {
		filtered := make([]SpotRecord, 0)
		for _, spot := range spots {
			if spot.Country == filterCountry {
				filtered = append(filtered, spot)
			}
		}
		spots = filtered
	}

	// Filter by time window (only keep spots within the hours range)
	cutoffTime := fromTime
	filtered := make([]SpotRecord, 0)
	for _, spot := range spots {
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		if spotTime.After(cutoffTime) || spotTime.Equal(cutoffTime) {
			filtered = append(filtered, spot)
		}
	}
	spots = filtered

	// Build analytics response
	response := &AnalyticsResponse{}
	response.TimeRange.From = fromTime.Format(time.RFC3339)
	response.TimeRange.To = now.Format(time.RFC3339)
	response.TimeRange.Hours = hours
	response.Filters.MinSNR = minSNR
	response.Filters.Country = filterCountry
	response.Filters.Continent = filterContinent

	// Aggregate by country and band
	countryData := make(map[string]map[string]*bandAggregator)
	continentData := make(map[string]map[string]*bandAggregator)
	continentCountries := make(map[string]map[string]bool)

	// Track unique callsigns per locator with mode+band combinations
	countryLocatorCallsigns := make(map[string]map[string]map[string]map[string]bool)   // country -> locator -> callsign -> mode+band
	continentLocatorCallsigns := make(map[string]map[string]map[string]map[string]bool) // continent -> locator -> callsign -> mode+band

	for _, spot := range spots {
		// Skip spots without country info
		if spot.Country == "" {
			continue
		}

		// Initialize country map if needed
		if countryData[spot.Country] == nil {
			countryData[spot.Country] = make(map[string]*bandAggregator)
		}
		if countryData[spot.Country][spot.Band] == nil {
			countryData[spot.Country][spot.Band] = &bandAggregator{
				hourly:   make(map[int]int),
				locators: make(map[string]*locatorAggregator),
				minSNR:   float64(spot.SNR),
				maxSNR:   float64(spot.SNR),
			}
		}

		// Initialize continent map if needed
		if spot.Continent != "" {
			if continentData[spot.Continent] == nil {
				continentData[spot.Continent] = make(map[string]*bandAggregator)
				continentCountries[spot.Continent] = make(map[string]bool)
			}
			if continentData[spot.Continent][spot.Band] == nil {
				continentData[spot.Continent][spot.Band] = &bandAggregator{
					hourly:   make(map[int]int),
					locators: make(map[string]*locatorAggregator),
					minSNR:   float64(spot.SNR),
					maxSNR:   float64(spot.SNR),
				}
			}
			continentCountries[spot.Continent][spot.Country] = true
		}

		// Parse timestamp to get hour
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		hour := spotTime.UTC().Hour()

		// Aggregate country data
		agg := countryData[spot.Country][spot.Band]
		agg.count++
		agg.totalSNR += float64(spot.SNR)
		if float64(spot.SNR) < agg.minSNR {
			agg.minSNR = float64(spot.SNR)
		}
		if float64(spot.SNR) > agg.maxSNR {
			agg.maxSNR = float64(spot.SNR)
		}
		agg.hourly[hour]++
		// Track locator statistics per band (only if locator is not empty)
		if spot.Locator != "" {
			if agg.locators[spot.Locator] == nil {
				agg.locators[spot.Locator] = &locatorAggregator{
					callsigns: make(map[string]bool),
				}
			}
			agg.locators[spot.Locator].totalSNR += float64(spot.SNR)
			agg.locators[spot.Locator].count++
			// Track unique callsigns for this locator
			if spot.Callsign != "" {
				agg.locators[spot.Locator].callsigns[spot.Callsign] = true
			}

			// Also track unique callsigns with mode+band combinations for this locator
			if spot.Callsign != "" {
				if countryLocatorCallsigns[spot.Country] == nil {
					countryLocatorCallsigns[spot.Country] = make(map[string]map[string]map[string]bool)
				}
				if countryLocatorCallsigns[spot.Country][spot.Locator] == nil {
					countryLocatorCallsigns[spot.Country][spot.Locator] = make(map[string]map[string]bool)
				}
				if countryLocatorCallsigns[spot.Country][spot.Locator][spot.Callsign] == nil {
					countryLocatorCallsigns[spot.Country][spot.Locator][spot.Callsign] = make(map[string]bool)
				}
				modeBand := fmt.Sprintf("%s %s", spot.Mode, spot.Band)
				countryLocatorCallsigns[spot.Country][spot.Locator][spot.Callsign][modeBand] = true
			}
		}

		// Aggregate continent data
		if spot.Continent != "" {
			contAgg := continentData[spot.Continent][spot.Band]
			contAgg.count++
			contAgg.totalSNR += float64(spot.SNR)
			if float64(spot.SNR) < contAgg.minSNR {
				contAgg.minSNR = float64(spot.SNR)
			}
			if float64(spot.SNR) > contAgg.maxSNR {
				contAgg.maxSNR = float64(spot.SNR)
			}
			contAgg.hourly[hour]++
			// Track locator statistics per band (only if locator is not empty)
			if spot.Locator != "" {
				if contAgg.locators[spot.Locator] == nil {
					contAgg.locators[spot.Locator] = &locatorAggregator{
						callsigns: make(map[string]bool),
					}
				}
				contAgg.locators[spot.Locator].totalSNR += float64(spot.SNR)
				contAgg.locators[spot.Locator].count++
				// Track unique callsigns for this locator
				if spot.Callsign != "" {
					contAgg.locators[spot.Locator].callsigns[spot.Callsign] = true
				}

				// Also track unique callsigns with mode+band combinations for this locator
				if spot.Callsign != "" {
					if continentLocatorCallsigns[spot.Continent] == nil {
						continentLocatorCallsigns[spot.Continent] = make(map[string]map[string]map[string]bool)
					}
					if continentLocatorCallsigns[spot.Continent][spot.Locator] == nil {
						continentLocatorCallsigns[spot.Continent][spot.Locator] = make(map[string]map[string]bool)
					}
					if continentLocatorCallsigns[spot.Continent][spot.Locator][spot.Callsign] == nil {
						continentLocatorCallsigns[spot.Continent][spot.Locator][spot.Callsign] = make(map[string]bool)
					}
					modeBand := fmt.Sprintf("%s %s", spot.Mode, spot.Band)
					continentLocatorCallsigns[spot.Continent][spot.Locator][spot.Callsign][modeBand] = true
				}
			}
		}
	}

	// Build country analytics
	continentNames := map[string]string{
		"AF": "Africa",
		"AS": "Asia",
		"EU": "Europe",
		"NA": "North America",
		"OC": "Oceania",
		"SA": "South America",
		"AN": "Antarctica",
	}

	for country, bands := range countryData {
		countryAnalytics := CountryAnalytics{
			Country: country,
			Bands:   make([]BandAnalytics, 0),
		}

		// Find continent for this country (from first spot)
		for _, spot := range spots {
			if spot.Country == country {
				countryAnalytics.Continent = spot.Continent
				break
			}
		}

		totalSpots := 0
		for band, agg := range bands {
			// Convert locator statistics to sorted slice for this band
			locatorStats := make([]LocatorStats, 0, len(agg.locators))
			for locator, locAgg := range agg.locators {
				// Build CallsignInfo list with mode+band combinations
				callsignInfoList := make([]CallsignInfo, 0)
				if countryLocatorCallsigns[country] != nil && countryLocatorCallsigns[country][locator] != nil {
					for callsign, modeBands := range countryLocatorCallsigns[country][locator] {
						bands := make([]string, 0, len(modeBands))
						for modeBand := range modeBands {
							bands = append(bands, modeBand)
						}
						sort.Strings(bands)
						callsignInfoList = append(callsignInfoList, CallsignInfo{
							Callsign: callsign,
							Bands:    bands,
						})
					}
				}
				// Sort callsigns alphabetically
				sort.Slice(callsignInfoList, func(i, j int) bool {
					return callsignInfoList[i].Callsign < callsignInfoList[j].Callsign
				})

				locatorStats = append(locatorStats, LocatorStats{
					Locator:         locator,
					AvgSNR:          locAgg.totalSNR / float64(locAgg.count),
					Count:           locAgg.count,
					UniqueCallsigns: len(locAgg.callsigns),
					Callsigns:       callsignInfoList,
				})
			}
			// Sort by locator name
			sort.Slice(locatorStats, func(i, j int) bool {
				return locatorStats[i].Locator < locatorStats[j].Locator
			})

			// Calculate unique callsigns for this band
			uniqueCallsignsForBand := make(map[string]bool)
			for _, locStat := range locatorStats {
				for _, csInfo := range locStat.Callsigns {
					// Check if this callsign was heard on this specific band
					for _, modeBand := range csInfo.Bands {
						if strings.Contains(modeBand, band) {
							uniqueCallsignsForBand[csInfo.Callsign] = true
							break
						}
					}
				}
			}

			bandAnalytics := BandAnalytics{
				Band:               band,
				Spots:              agg.count,
				UniqueCallsigns:    len(uniqueCallsignsForBand),
				MinSNR:             agg.minSNR,
				AvgSNR:             agg.totalSNR / float64(agg.count),
				MaxSNR:             agg.maxSNR,
				UniqueLocators:     locatorStats,
				BestHoursUTC:       findBestHours(agg.hourly, 3),
				HourlyDistribution: formatHourlyDistribution(agg.hourly),
			}
			countryAnalytics.Bands = append(countryAnalytics.Bands, bandAnalytics)
			totalSpots += agg.count
		}

		// Sort bands by spot count (descending)
		sort.Slice(countryAnalytics.Bands, func(i, j int) bool {
			return countryAnalytics.Bands[i].Spots > countryAnalytics.Bands[j].Spots
		})

		countryAnalytics.TotalSpots = totalSpots
		response.ByCountry = append(response.ByCountry, countryAnalytics)
	}

	// Sort countries by total spots (descending)
	sort.Slice(response.ByCountry, func(i, j int) bool {
		return response.ByCountry[i].TotalSpots > response.ByCountry[j].TotalSpots
	})

	// Build continent analytics
	for continent, bands := range continentData {
		continentAnalytics := ContinentAnalytics{
			Continent:      continent,
			ContinentName:  continentNames[continent],
			CountriesCount: len(continentCountries[continent]),
			Bands:          make([]BandAnalytics, 0),
		}

		if continentAnalytics.ContinentName == "" {
			continentAnalytics.ContinentName = continent
		}

		totalSpots := 0
		for band, agg := range bands {
			// Convert locator statistics to sorted slice for this band
			locatorStats := make([]LocatorStats, 0, len(agg.locators))
			for locator, locAgg := range agg.locators {
				// Build CallsignInfo list with mode+band combinations
				callsignInfoList := make([]CallsignInfo, 0)
				uniqueCallsigns := 0
				if continentLocatorCallsigns[continent] != nil && continentLocatorCallsigns[continent][locator] != nil {
					uniqueCallsigns = len(continentLocatorCallsigns[continent][locator])
					for callsign, modeBands := range continentLocatorCallsigns[continent][locator] {
						bands := make([]string, 0, len(modeBands))
						for modeBand := range modeBands {
							bands = append(bands, modeBand)
						}
						sort.Strings(bands)
						callsignInfoList = append(callsignInfoList, CallsignInfo{
							Callsign: callsign,
							Bands:    bands,
						})
					}
				}
				// Sort callsigns alphabetically
				sort.Slice(callsignInfoList, func(i, j int) bool {
					return callsignInfoList[i].Callsign < callsignInfoList[j].Callsign
				})

				locatorStats = append(locatorStats, LocatorStats{
					Locator:         locator,
					AvgSNR:          locAgg.totalSNR / float64(locAgg.count),
					Count:           locAgg.count,
					UniqueCallsigns: uniqueCallsigns,
					Callsigns:       callsignInfoList,
				})
			}
			// Sort by locator name
			sort.Slice(locatorStats, func(i, j int) bool {
				return locatorStats[i].Locator < locatorStats[j].Locator
			})

			// Calculate unique callsigns for this band
			uniqueCallsignsForBand := make(map[string]bool)
			for _, locStat := range locatorStats {
				for _, csInfo := range locStat.Callsigns {
					// Check if this callsign was heard on this specific band
					for _, modeBand := range csInfo.Bands {
						if strings.Contains(modeBand, band) {
							uniqueCallsignsForBand[csInfo.Callsign] = true
							break
						}
					}
				}
			}

			bandAnalytics := BandAnalytics{
				Band:               band,
				Spots:              agg.count,
				UniqueCallsigns:    len(uniqueCallsignsForBand),
				MinSNR:             agg.minSNR,
				AvgSNR:             agg.totalSNR / float64(agg.count),
				MaxSNR:             agg.maxSNR,
				UniqueLocators:     locatorStats,
				BestHoursUTC:       findBestHours(agg.hourly, 3),
				HourlyDistribution: formatHourlyDistribution(agg.hourly),
			}
			continentAnalytics.Bands = append(continentAnalytics.Bands, bandAnalytics)
			totalSpots += agg.count
		}

		// Sort bands by spot count (descending)
		sort.Slice(continentAnalytics.Bands, func(i, j int) bool {
			return continentAnalytics.Bands[i].Spots > continentAnalytics.Bands[j].Spots
		})

		continentAnalytics.TotalSpots = totalSpots
		response.ByContinent = append(response.ByContinent, continentAnalytics)
	}

	// Sort continents by total spots (descending)
	sort.Slice(response.ByContinent, func(i, j int) bool {
		return response.ByContinent[i].TotalSpots > response.ByContinent[j].TotalSpots
	})

	return response, nil
}

// HourlyLocatorData represents locator data for a specific hour
type HourlyLocatorData struct {
	Hour      int            `json:"hour"`      // UTC hour (0-23)
	Timestamp string         `json:"timestamp"` // ISO 8601 timestamp for the hour
	Locators  []LocatorStats `json:"locators"`  // Locator statistics for this hour
}

// HourlyAnalyticsResponse represents the hourly analytics response
type HourlyAnalyticsResponse struct {
	TimeRange struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Hours int    `json:"hours"`
	} `json:"time_range"`
	Filters struct {
		MinSNR    int    `json:"min_snr"`
		Country   string `json:"country,omitempty"`
		Continent string `json:"continent,omitempty"`
	} `json:"filters"`
	HourlyData []HourlyLocatorData `json:"hourly_data"`
}

// GetSpotsAnalyticsHourly returns analytics data broken down by hour
func (sl *SpotsLogger) GetSpotsAnalyticsHourly(filterCountry, filterContinent, filterMode, filterBand string, minSNR, hours int) (*HourlyAnalyticsResponse, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("spots logging is not enabled")
	}

	// Calculate date range
	now := time.Now()
	toDate := now.Format("2006-01-02")
	fromTime := now.Add(-time.Duration(hours) * time.Hour)
	fromDate := fromTime.Format("2006-01-02")

	// Get spots using existing method
	spots, err := sl.GetHistoricalSpots(
		filterMode,      // mode filter
		filterBand,      // band filter
		"",              // name - all names
		"",              // callsign - all callsigns
		"",              // locator - all locators
		filterContinent, // continent filter
		"",              // direction - all directions
		fromDate,
		toDate,
		"",    // startTime - no time filter
		"",    // endTime - no time filter
		false, // deduplicate
		true,  // locatorsOnly
		0,     // minDistanceKm
		minSNR,
	)
	if err != nil {
		return nil, err
	}

	// Filter by country if specified
	if filterCountry != "" {
		filtered := make([]SpotRecord, 0)
		for _, spot := range spots {
			if spot.Country == filterCountry {
				filtered = append(filtered, spot)
			}
		}
		spots = filtered
	}

	// Filter by time window (only keep spots within the hours range)
	cutoffTime := fromTime
	filtered := make([]SpotRecord, 0)
	for _, spot := range spots {
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		if spotTime.After(cutoffTime) || spotTime.Equal(cutoffTime) {
			filtered = append(filtered, spot)
		}
	}
	spots = filtered

	// Build hourly analytics response
	response := &HourlyAnalyticsResponse{}
	response.TimeRange.From = fromTime.Format(time.RFC3339)
	response.TimeRange.To = now.Format(time.RFC3339)
	response.TimeRange.Hours = hours
	response.Filters.MinSNR = minSNR
	response.Filters.Country = filterCountry
	response.Filters.Continent = filterContinent

	// Group spots by hour
	hourlySpots := make(map[int][]SpotRecord)
	for _, spot := range spots {
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		hour := spotTime.UTC().Hour()
		hourlySpots[hour] = append(hourlySpots[hour], spot)
	}

	// Build hourly data for each hour (0-23)
	response.HourlyData = make([]HourlyLocatorData, 0, 24)

	for hour := 0; hour < 24; hour++ {
		// Create timestamp for this hour (use today's date with the hour)
		hourTime := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, time.UTC)

		hourData := HourlyLocatorData{
			Hour:      hour,
			Timestamp: hourTime.Format(time.RFC3339),
			Locators:  make([]LocatorStats, 0),
		}

		// Get spots for this hour
		spotsForHour := hourlySpots[hour]
		if len(spotsForHour) == 0 {
			// Include empty hour data
			response.HourlyData = append(response.HourlyData, hourData)
			continue
		}

		// Aggregate locators for this hour
		locatorMap := make(map[string]*locatorAggregator)
		callsignsByLocator := make(map[string]map[string]map[string]bool) // locator -> callsign -> mode+band

		for _, spot := range spotsForHour {
			if spot.Locator == "" {
				continue
			}

			if locatorMap[spot.Locator] == nil {
				locatorMap[spot.Locator] = &locatorAggregator{
					callsigns: make(map[string]bool),
				}
			}

			agg := locatorMap[spot.Locator]
			agg.totalSNR += float64(spot.SNR)
			agg.count++
			if spot.Callsign != "" {
				agg.callsigns[spot.Callsign] = true
			}

			// Track callsigns with mode+band combinations
			if spot.Callsign != "" {
				if callsignsByLocator[spot.Locator] == nil {
					callsignsByLocator[spot.Locator] = make(map[string]map[string]bool)
				}
				if callsignsByLocator[spot.Locator][spot.Callsign] == nil {
					callsignsByLocator[spot.Locator][spot.Callsign] = make(map[string]bool)
				}
				modeBand := fmt.Sprintf("%s %s", spot.Mode, spot.Band)
				callsignsByLocator[spot.Locator][spot.Callsign][modeBand] = true
			}
		}

		// Convert to LocatorStats
		for locator, agg := range locatorMap {
			// Build CallsignInfo list
			callsignInfoList := make([]CallsignInfo, 0)
			if callsignsByLocator[locator] != nil {
				for callsign, modeBands := range callsignsByLocator[locator] {
					bands := make([]string, 0, len(modeBands))
					for modeBand := range modeBands {
						bands = append(bands, modeBand)
					}
					sort.Strings(bands)
					callsignInfoList = append(callsignInfoList, CallsignInfo{
						Callsign: callsign,
						Bands:    bands,
					})
				}
			}
			// Sort callsigns alphabetically
			sort.Slice(callsignInfoList, func(i, j int) bool {
				return callsignInfoList[i].Callsign < callsignInfoList[j].Callsign
			})

			hourData.Locators = append(hourData.Locators, LocatorStats{
				Locator:         locator,
				AvgSNR:          agg.totalSNR / float64(agg.count),
				Count:           agg.count,
				UniqueCallsigns: len(agg.callsigns),
				Callsigns:       callsignInfoList,
			})
		}

		// Sort locators by name
		sort.Slice(hourData.Locators, func(i, j int) bool {
			return hourData.Locators[i].Locator < hourData.Locators[j].Locator
		})

		response.HourlyData = append(response.HourlyData, hourData)
	}

	return response, nil
}

// locatorAggregator tracks statistics for a specific locator
type locatorAggregator struct {
	totalSNR  float64
	count     int
	callsigns map[string]bool
}

// bandAggregator helps aggregate band statistics
type bandAggregator struct {
	count    int
	totalSNR float64
	minSNR   float64
	maxSNR   float64
	hourly   map[int]int
	locators map[string]*locatorAggregator
}

// findBestHours returns the top N hours with most spots (only hours with count > 0)
func findBestHours(hourly map[int]int, topN int) []int {
	type hourCount struct {
		hour  int
		count int
	}

	hours := make([]hourCount, 0, len(hourly))
	for hour, count := range hourly {
		// Only include hours that have spots
		if count > 0 {
			hours = append(hours, hourCount{hour, count})
		}
	}

	// Sort by count descending
	sort.Slice(hours, func(i, j int) bool {
		if hours[i].count == hours[j].count {
			return hours[i].hour < hours[j].hour
		}
		return hours[i].count > hours[j].count
	})

	// Get top N hours (or fewer if there aren't N hours with spots)
	result := make([]int, 0, topN)
	for i := 0; i < len(hours) && i < topN; i++ {
		result = append(result, hours[i].hour)
	}

	// Sort result by hour
	sort.Ints(result)
	return result
}

// formatHourlyDistribution converts hourly map to string-keyed map for JSON
func formatHourlyDistribution(hourly map[int]int) map[string]int {
	result := make(map[string]int)
	for hour := 0; hour < 24; hour++ {
		key := fmt.Sprintf("%02d", hour)
		result[key] = hourly[hour]
	}
	return result
}

// cleanupLoop runs hourly to clean up old spot log files
func (sl *SpotsLogger) cleanupLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	// Run cleanup immediately on start
	if err := sl.cleanupOldFiles(); err != nil {
		log.Printf("Error during initial spots log cleanup: %v", err)
	}

	for {
		select {
		case <-ticker.C:
			if err := sl.cleanupOldFiles(); err != nil {
				log.Printf("Error during spots log cleanup: %v", err)
			}
		case <-sl.stopClean:
			return
		}
	}
}

// cleanupOldFiles removes spot log files older than maxAgeDays
func (sl *SpotsLogger) cleanupOldFiles() error {
	if sl.maxAgeDays <= 0 {
		return nil // Cleanup disabled
	}

	cutoffDate := time.Now().AddDate(0, 0, -sl.maxAgeDays)
	log.Printf("Cleaning up spots logs older than %d days (before %s)", sl.maxAgeDays, cutoffDate.Format("2006-01-02"))

	removedCount := 0

	// Check all modes
	modes := []string{"FT8", "FT4", "WSPR", "JS8"}
	for _, mode := range modes {
		modePath := filepath.Join(sl.dataDir, mode)

		// Check if mode directory exists
		if _, err := os.Stat(modePath); os.IsNotExist(err) {
			continue
		}

		// Walk through year directories
		yearDirs, err := os.ReadDir(modePath)
		if err != nil {
			log.Printf("Warning: error reading mode directory %s: %v", modePath, err)
			continue
		}

		for _, yearDir := range yearDirs {
			if !yearDir.IsDir() {
				continue
			}
			year := yearDir.Name()
			yearPath := filepath.Join(modePath, year)

			// Walk through month directories
			monthDirs, err := os.ReadDir(yearPath)
			if err != nil {
				log.Printf("Warning: error reading year directory %s: %v", yearPath, err)
				continue
			}

			for _, monthDir := range monthDirs {
				if !monthDir.IsDir() {
					continue
				}
				month := monthDir.Name()
				monthPath := filepath.Join(yearPath, month)

				// Walk through day directories
				dayDirs, err := os.ReadDir(monthPath)
				if err != nil {
					log.Printf("Warning: error reading month directory %s: %v", monthPath, err)
					continue
				}

				for _, dayDir := range dayDirs {
					if !dayDir.IsDir() {
						continue
					}
					day := dayDir.Name()

					// Parse date from directory structure
					dateStr := fmt.Sprintf("%s-%s-%s", year, month, day)
					dirDate, err := time.Parse("2006-01-02", dateStr)
					if err != nil {
						log.Printf("Warning: invalid date directory %s: %v", dateStr, err)
						continue
					}

					// Check if directory is older than cutoff
					if dirDate.Before(cutoffDate) {
						dayPath := filepath.Join(monthPath, day)
						log.Printf("Removing old spots log directory: %s", dayPath)
						if err := os.RemoveAll(dayPath); err != nil {
							log.Printf("Warning: error removing directory %s: %v", dayPath, err)
						} else {
							removedCount++
						}
					}
				}

				// Check if month directory is now empty and remove it
				if isEmpty, _ := isDirEmpty(monthPath); isEmpty {
					log.Printf("Removing empty month directory: %s", monthPath)
					os.Remove(monthPath)
				}
			}

			// Check if year directory is now empty and remove it
			if isEmpty, _ := isDirEmpty(yearPath); isEmpty {
				log.Printf("Removing empty year directory: %s", yearPath)
				os.Remove(yearPath)
			}
		}
	}

	if removedCount > 0 {
		log.Printf("Spots log cleanup completed: removed %d old directories", removedCount)
	} else {
		log.Printf("Spots log cleanup completed: no old directories to remove")
	}

	return nil
}

// isDirEmpty checks if a directory is empty
func isDirEmpty(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}
