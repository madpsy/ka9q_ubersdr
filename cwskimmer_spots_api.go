package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// CWSpotRecord represents a CW spot from CSV
type CWSpotRecord struct {
	Timestamp  string   `json:"timestamp"`
	Callsign   string   `json:"callsign"`
	SNR        int      `json:"snr"`
	Frequency  uint64   `json:"frequency"`
	Band       string   `json:"band"`
	WPM        int      `json:"wpm"`
	Comment    string   `json:"comment"`
	Country    string   `json:"country"`
	CQZone     int      `json:"cq_zone"`
	ITUZone    int      `json:"itu_zone"`
	Continent  string   `json:"continent"`
	Latitude   *float64 `json:"latitude,omitempty"`
	Longitude  *float64 `json:"longitude,omitempty"`
	DistanceKm *float64 `json:"distance_km,omitempty"`
	BearingDeg *float64 `json:"bearing_deg,omitempty"`
	Name       string   `json:"name"` // Band name from file
}

// GetCWHistoricalSpots reads historical CW spots from CSV files
func (sl *CWSkimmerSpotsLogger) GetCWHistoricalSpots(band, name, callsign, continent, direction, fromDate, toDate, startTime, endTime string, minDistanceKm float64, minSNR int, ctyDatabase *CTYDatabase) ([]CWSpotRecord, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("CW spots logging is not enabled")
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

	// Collect all spots
	allSpots := make([]CWSpotRecord, 0)

	// Iterate through each date in the range
	currentDate := startDate
	for !currentDate.After(endDate) {
		dateStr := currentDate.Format("2006-01-02")

		spots, err := sl.readCWSpotsForDate(name, dateStr)
		if err != nil {
			// Skip if file doesn't exist
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Add spots with filtering and enrich with lat/lon
		for _, spot := range spots {
			// Enrich with latitude/longitude from CTY.dat
			if ctyDatabase != nil {
				if info := ctyDatabase.LookupCallsignFull(spot.Callsign); info != nil {
					// CTY.dat uses West-positive longitude, negate to get standard East-positive
					lat := info.Latitude
					lon := -info.Longitude
					spot.Latitude = &lat
					spot.Longitude = &lon
				}
			}

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

			// Filter by band if specified
			if band != "" && spot.Band != band {
				continue
			}

			// Filter by exact callsign match if specified
			if callsign != "" && spot.Callsign != callsign {
				continue
			}

			// Filter by continent if specified
			if continent != "" && spot.Continent != continent {
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

			allSpots = append(allSpots, spot)
		}

		currentDate = currentDate.AddDate(0, 0, 1)
	}

	// Sort spots by timestamp in descending order (newest first)
	sort.Slice(allSpots, func(i, j int) bool {
		return allSpots[i].Timestamp > allSpots[j].Timestamp
	})

	return allSpots, nil
}

// readCWSpotsForDate reads CW spots for a specific date
func (sl *CWSkimmerSpotsLogger) readCWSpotsForDate(name, dateStr string) ([]CWSpotRecord, error) {
	// Parse date to get year/month/day
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return nil, err
	}

	// Build directory path: base_dir/YYYY/MM/DD/
	dirPath := filepath.Join(
		sl.dataDir,
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
		return sl.readCWNameFile(dirPath, name)
	}

	// Otherwise, read all CSV files in the directory
	files, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	allSpots := make([]CWSpotRecord, 0)
	for _, file := range files {
		if file.IsDir() || filepath.Ext(file.Name()) != ".csv" {
			continue
		}

		bandName := file.Name()[:len(file.Name())-4] // Remove .csv extension
		spots, err := sl.readCWNameFile(dirPath, bandName)
		if err != nil {
			continue
		}
		allSpots = append(allSpots, spots...)
	}

	return allSpots, nil
}

// readCWNameFile reads a single band CSV file
func (sl *CWSkimmerSpotsLogger) readCWNameFile(dirPath, bandName string) ([]CWSpotRecord, error) {
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
	spots := make([]CWSpotRecord, 0, len(records)-1)
	for _, record := range records[1:] {
		if len(record) < 11 {
			continue
		}

		spot := CWSpotRecord{
			Timestamp: record[0],
			Callsign:  record[1],
			Band:      record[4],
			Comment:   record[6],
			Country:   record[7],
			Continent: record[10],
			Name:      bandName,
		}

		// Parse numeric fields
		fmt.Sscanf(record[2], "%d", &spot.SNR)
		fmt.Sscanf(record[3], "%d", &spot.Frequency)
		fmt.Sscanf(record[5], "%d", &spot.WPM)
		fmt.Sscanf(record[8], "%d", &spot.CQZone)
		fmt.Sscanf(record[9], "%d", &spot.ITUZone)

		// Parse distance and bearing if present
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

// GetCWAvailableDates returns a list of dates for which CW spot data is available
func (sl *CWSkimmerSpotsLogger) GetCWAvailableDates() ([]string, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("CW spots logging is not enabled")
	}

	dateMap := make(map[string]bool)

	// Walk through year directories
	yearDirs, err := os.ReadDir(sl.dataDir)
	if err != nil {
		return nil, err
	}

	for _, yearDir := range yearDirs {
		if !yearDir.IsDir() {
			continue
		}
		year := yearDir.Name()

		// Walk through month directories
		monthPath := filepath.Join(sl.dataDir, year)
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

// GetCWAvailableNames returns a list of unique band names that have CW spot data
func (sl *CWSkimmerSpotsLogger) GetCWAvailableNames() ([]string, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("CW spots logging is not enabled")
	}

	nameMap := make(map[string]bool)

	// Walk through year directories
	yearDirs, err := os.ReadDir(sl.dataDir)
	if err != nil {
		return nil, err
	}

	for _, yearDir := range yearDirs {
		if !yearDir.IsDir() {
			continue
		}
		year := yearDir.Name()

		// Walk through month directories
		monthPath := filepath.Join(sl.dataDir, year)
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

	// Convert map to sorted slice
	names := make([]string, 0, len(nameMap))
	for name := range nameMap {
		names = append(names, name)
	}

	// Sort names alphabetically
	sort.Strings(names)

	return names, nil
}

// GetCWHistoricalCSV returns historical CW spots data as CSV string
func (sl *CWSkimmerSpotsLogger) GetCWHistoricalCSV(band, name, callsign, continent, direction, fromDate, toDate, startTime, endTime string, minDistanceKm float64, minSNR int, ctyDatabase *CTYDatabase) (string, error) {
	// Get the spots data using existing method
	spots, err := sl.GetCWHistoricalSpots(band, name, callsign, continent, direction, fromDate, toDate, startTime, endTime, minDistanceKm, minSNR, ctyDatabase)
	if err != nil {
		return "", err
	}

	if len(spots) == 0 {
		return "", fmt.Errorf("no data available for the specified parameters")
	}

	// Build CSV string
	var csvBuilder strings.Builder

	// Write header
	csvBuilder.WriteString("timestamp,callsign,snr,frequency,band,wpm,comment,country,cq_zone,itu_zone,continent,latitude,longitude,distance_km,bearing_deg,name\n")

	// Write data rows
	for _, spot := range spots {
		// Format lat/lon, distance and bearing
		latStr := ""
		if spot.Latitude != nil {
			latStr = fmt.Sprintf("%.6f", *spot.Latitude)
		}
		lonStr := ""
		if spot.Longitude != nil {
			lonStr = fmt.Sprintf("%.6f", *spot.Longitude)
		}
		distStr := ""
		if spot.DistanceKm != nil {
			distStr = fmt.Sprintf("%.1f", *spot.DistanceKm)
		}
		bearingStr := ""
		if spot.BearingDeg != nil {
			bearingStr = fmt.Sprintf("%.1f", *spot.BearingDeg)
		}

		// Escape fields that might contain commas or quotes
		comment := escapeCSVField(spot.Comment)
		country := escapeCSVField(spot.Country)

		csvBuilder.WriteString(fmt.Sprintf("%s,%s,%d,%d,%s,%d,%s,%s,%d,%d,%s,%s,%s,%s,%s,%s\n",
			spot.Timestamp,
			spot.Callsign,
			spot.SNR,
			spot.Frequency,
			spot.Band,
			spot.WPM,
			comment,
			country,
			spot.CQZone,
			spot.ITUZone,
			spot.Continent,
			latStr,
			lonStr,
			distStr,
			bearingStr,
			spot.Name,
		))
	}

	return csvBuilder.String(), nil
}

// HTTP Handlers for CW Spots API

// handleCWSpotsAPI handles the /api/cwskimmer/spots endpoint
func handleCWSpotsAPI(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter, ctyDatabase *CTYDatabase) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil || !cwSkimmer.spotsLogger.enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW spots logging is not enabled",
		})
		return
	}

	// Parse query parameters
	fromDate := r.URL.Query().Get("date")
	toDate := r.URL.Query().Get("to_date")

	if fd := r.URL.Query().Get("from_date"); fd != "" {
		fromDate = fd
	}

	if fromDate == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date or from_date parameter is required (format: YYYY-MM-DD)",
		})
		return
	}

	band := r.URL.Query().Get("band")
	name := r.URL.Query().Get("name")
	callsign := strings.ToUpper(r.URL.Query().Get("callsign"))
	continent := r.URL.Query().Get("continent")
	direction := r.URL.Query().Get("direction")
	startTime := r.URL.Query().Get("start_time")
	endTime := r.URL.Query().Get("end_time")
	minDistanceStr := r.URL.Query().Get("min_distance")
	minSNRStr := r.URL.Query().Get("min_snr")

	minDistanceKm := 0.0
	if minDistanceStr != "" {
		if dist, err := strconv.ParseFloat(minDistanceStr, 64); err == nil && dist >= 0 {
			minDistanceKm = dist
		}
	}

	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Check rate limit
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-spots-%s-%s-%s-%s-%s-%s-%s-%s-%d", band, name, callsign, continent, direction, fromDate, toDate, startTime, minSNR)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		return
	}

	// Get spots
	spots, err := cwSkimmer.spotsLogger.GetCWHistoricalSpots(
		band, name, callsign, continent, direction,
		fromDate, toDate, startTime, endTime, minDistanceKm, minSNR, ctyDatabase,
	)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get spots: %v", err),
		})
		return
	}

	if len(spots) == 0 {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No spots available for the specified parameters",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"spots": spots,
		"count": len(spots),
	}); err != nil {
		fmt.Printf("Error encoding CW spots: %v\n", err)
	}
}

// handleCWSpotsDatesAPI handles the /api/cwskimmer/spots/dates endpoint
func handleCWSpotsDatesAPI(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil || !cwSkimmer.spotsLogger.enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW spots logging is not enabled",
		})
		return
	}

	dates, err := cwSkimmer.spotsLogger.GetCWAvailableDates()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get available dates: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"dates": dates,
	}); err != nil {
		fmt.Printf("Error encoding available dates: %v\n", err)
	}
}

// handleCWSpotsNamesAPI handles the /api/cwskimmer/spots/names endpoint
func handleCWSpotsNamesAPI(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil || !cwSkimmer.spotsLogger.enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW spots logging is not enabled",
		})
		return
	}

	names, err := cwSkimmer.spotsLogger.GetCWAvailableNames()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get available names: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"names": names,
	}); err != nil {
		fmt.Printf("Error encoding available names: %v\n", err)
	}
}

// handleCWSpotsCSVAPI handles the /api/cwskimmer/spots/csv endpoint
func handleCWSpotsCSVAPI(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter, ctyDatabase *CTYDatabase) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil || !cwSkimmer.spotsLogger.enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW spots logging is not enabled",
		})
		return
	}

	// Parse query parameters
	fromDate := r.URL.Query().Get("date")
	toDate := r.URL.Query().Get("to_date")

	if fd := r.URL.Query().Get("from_date"); fd != "" {
		fromDate = fd
	}

	if fromDate == "" {
		w.WriteHeader(http.StatusBadRequest)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date or from_date parameter is required (format: YYYY-MM-DD)",
		})
		return
	}

	band := r.URL.Query().Get("band")
	name := r.URL.Query().Get("name")
	callsign := strings.ToUpper(r.URL.Query().Get("callsign"))
	continent := r.URL.Query().Get("continent")
	direction := r.URL.Query().Get("direction")
	startTime := r.URL.Query().Get("start_time")
	endTime := r.URL.Query().Get("end_time")
	minDistanceStr := r.URL.Query().Get("min_distance")
	minSNRStr := r.URL.Query().Get("min_snr")

	minDistanceKm := 0.0
	if minDistanceStr != "" {
		if dist, err := strconv.ParseFloat(minDistanceStr, 64); err == nil && dist >= 0 {
			minDistanceKm = dist
		}
	}

	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Check rate limit
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-spots-csv-%s-%s-%s-%s-%s-%s-%s-%d", band, name, callsign, continent, direction, fromDate, toDate, minSNR)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		return
	}

	// Get CSV data
	csvData, err := cwSkimmer.spotsLogger.GetCWHistoricalCSV(
		band, name, callsign, continent, direction,
		fromDate, toDate, startTime, endTime, minDistanceKm, minSNR, ctyDatabase,
	)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get CSV data: %v", err),
		})
		return
	}

	// Build filename
	filename := fmt.Sprintf("cw-spots-%s.csv", fromDate)
	if toDate != "" && toDate != fromDate {
		filename = fmt.Sprintf("cw-spots-%s-to-%s.csv", fromDate, toDate)
	}
	if band != "" {
		filename = fmt.Sprintf("cw-spots-%s-%s.csv", band, fromDate)
	}

	// Set headers for CSV download
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
	w.WriteHeader(http.StatusOK)

	// Write CSV data
	if _, err := w.Write([]byte(csvData)); err != nil {
		fmt.Printf("Error writing CSV data: %v\n", err)
	}
}
