package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// sortedCallsignKey returns a stable, sorted, comma-joined string from a callsign
// set, suitable for use as a rate-limit cache key.
func sortedCallsignKey(callsigns map[string]bool) string {
	if len(callsigns) == 0 {
		return ""
	}
	keys := make([]string, 0, len(callsigns))
	for cs := range callsigns {
		keys = append(keys, cs)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

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

// GetCWHistoricalSpots reads historical CW spots from the cw_spots SQLite table.
// callsigns is a set of uppercase callsigns to match; an empty map means no filter.
//
// Latitude/longitude are normally populated at write time and stored directly
// in the cw_spots table. Rows imported from the pre-database CSV files have no
// coordinates (the CSVs never carried them), so ctyDatabase is used as a
// read-time fallback for those rows — matching the behaviour of the old
// file-based reader.
func (sl *CWSkimmerSpotsLogger) GetCWHistoricalSpots(band, name string, callsigns map[string]bool, continent, direction, fromDate, toDate, startTime, endTime string, minDistanceKm float64, minSNR int, ctyDatabase *CTYDatabase) ([]CWSpotRecord, error) {
	if sl.readDB == nil {
		return nil, fmt.Errorf("CW spots database is not available")
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

	// Build the query dynamically. The date range is a half-open interval
	// [startOfFromDate, startOfDayAfterToDate) in UTC Unix seconds so it matches
	// the old per-day file semantics.
	startTS := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, time.UTC).Unix()
	endTS := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1).Unix()

	var conditions []string
	var args []interface{}

	conditions = append(conditions, "ts >= ? AND ts < ?")
	args = append(args, startTS, endTS)

	// name filter maps to the band column (the file-based "name" was the band
	// CSV filename); band and name are functionally the same dimension here.
	if band != "" {
		conditions = append(conditions, "band = ?")
		args = append(args, band)
	}
	if name != "" {
		conditions = append(conditions, "band = ?")
		args = append(args, name)
	}

	// Callsign set filter → dx_call IN (?,?,...)
	if len(callsigns) > 0 {
		placeholders := make([]string, 0, len(callsigns))
		for cs := range callsigns {
			placeholders = append(placeholders, "?")
			args = append(args, cs)
		}
		conditions = append(conditions, "dx_call IN ("+strings.Join(placeholders, ",")+")")
	}

	if continent != "" {
		conditions = append(conditions, "continent = ?")
		args = append(args, continent)
	}

	if minDistanceKm > 0 {
		conditions = append(conditions, "distance_km IS NOT NULL AND distance_km >= ?")
		args = append(args, minDistanceKm)
	}

	if minSNR > -999 {
		conditions = append(conditions, "snr >= ?")
		args = append(args, minSNR)
	}

	// Time-of-day filter (HH:MM in UTC). Compute minutes-of-day in SQL.
	if startTime != "" {
		if mins, ok := parseHourMinToMinutes(startTime); ok {
			conditions = append(conditions,
				"(CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) * 60 + CAST(strftime('%M', ts, 'unixepoch') AS INTEGER)) >= ?")
			args = append(args, mins)
		}
	}
	if endTime != "" {
		if mins, ok := parseHourMinToMinutes(endTime); ok {
			conditions = append(conditions,
				"(CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) * 60 + CAST(strftime('%M', ts, 'unixepoch') AS INTEGER)) <= ?")
			args = append(args, mins)
		}
	}

	query := `SELECT ts, dx_call, snr, frequency, band, wpm, comment,
	                 country, cq_zone, itu_zone, continent,
	                 latitude, longitude, distance_km, bearing_deg
	          FROM cw_spots
	          WHERE ` + strings.Join(conditions, " AND ") + `
	          ORDER BY ts DESC`

	rows, err := sl.readDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("cw_spots query failed: %w", err)
	}
	defer rows.Close()

	allSpots := make([]CWSpotRecord, 0)
	for rows.Next() {
		var (
			ts        int64
			dxCall    string
			snr       int
			frequency float64 // stored as REAL (Hz); matches CWSkimmerSpot.Frequency
			bandCol   string
			wpm       int
			comment   string
			country   string
			cqZone    int
			ituZone   int
			cont      string
			lat       sql.NullFloat64
			lon       sql.NullFloat64
			dist      sql.NullFloat64
			bearing   sql.NullFloat64
		)
		if err := rows.Scan(&ts, &dxCall, &snr, &frequency, &bandCol, &wpm, &comment,
			&country, &cqZone, &ituZone, &cont,
			&lat, &lon, &dist, &bearing); err != nil {
			return nil, fmt.Errorf("cw_spots scan failed: %w", err)
		}

		spot := CWSpotRecord{
			Timestamp: time.Unix(ts, 0).UTC().Format(time.RFC3339),
			Callsign:  dxCall,
			SNR:       snr,
			Frequency: uint64(frequency), // truncate Hz to integer, matching the CSV "%.0f" path
			Band:      bandCol,
			WPM:       wpm,
			Comment:   comment,
			Country:   country,
			CQZone:    cqZone,
			ITUZone:   ituZone,
			Continent: cont,
			Name:      bandCol, // "name" is the band, matching the file-based path
		}
		if lat.Valid {
			v := lat.Float64
			spot.Latitude = &v
		}
		if lon.Valid {
			v := lon.Float64
			spot.Longitude = &v
		}
		// Fallback for rows without a stored position: CSV-imported rows have
		// NULL lat/lon, and live rows whose callsign resolved to nothing store
		// 0/0 (the columns are plain float64 on the write path). Both are
		// filled in from CTY.dat here, as the file-based reader used to do.
		if !hasPosition(spot.Latitude, spot.Longitude) && ctyDatabase != nil {
			if info := ctyDatabase.LookupCallsignFull(dxCall); info != nil {
				// CTY.dat coordinates are already standard East-positive.
				ctyLat, ctyLon := info.Latitude, info.Longitude
				if ctyLat != 0 || ctyLon != 0 {
					spot.Latitude = &ctyLat
					spot.Longitude = &ctyLon
				}
			}
		}
		if dist.Valid {
			v := dist.Float64
			spot.DistanceKm = &v
		}
		if bearing.Valid {
			v := bearing.Float64
			spot.BearingDeg = &v
		}

		// Direction filter — SQLite has no bearing-to-compass function, so it is
		// applied in Go against the bearing_deg column.
		if direction != "" {
			if spot.BearingDeg == nil || !matchesDirection(*spot.BearingDeg, direction) {
				continue
			}
		}

		allSpots = append(allSpots, spot)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("cw_spots row iteration failed: %w", err)
	}

	return allSpots, nil
}

// hasPosition reports whether a spot carries usable coordinates. A stored
// 0/0 counts as "no position": it is what the write path records when a
// callsign resolves to nothing, and 0°N 0°E is open ocean for CW purposes.
func hasPosition(lat, lon *float64) bool {
	if lat == nil || lon == nil {
		return false
	}
	return *lat != 0 || *lon != 0
}

// parseHourMinToMinutes converts a "HH:MM" string to minutes-of-day. Returns
// false if the string is not a valid time.
func parseHourMinToMinutes(hm string) (int, bool) {
	t, err := time.Parse("15:04", hm)
	if err != nil {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

// GetCWAvailableDates returns a list of dates for which CW spot data is available
func (sl *CWSkimmerSpotsLogger) GetCWAvailableDates() ([]string, error) {
	if sl.readDB == nil {
		return nil, fmt.Errorf("CW spots database is not available")
	}

	rows, err := sl.readDB.Query(
		`SELECT DISTINCT DATE(ts, 'unixepoch') AS date FROM cw_spots ORDER BY date DESC`)
	if err != nil {
		return nil, fmt.Errorf("cw_spots dates query failed: %w", err)
	}
	defer rows.Close()

	dates := make([]string, 0)
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			return nil, fmt.Errorf("cw_spots dates scan failed: %w", err)
		}
		dates = append(dates, date)
	}
	return dates, rows.Err()
}

// GetCWAvailableNames returns a list of unique band names that have CW spot data.
// The "name" dimension maps to the band column in the DB.
func (sl *CWSkimmerSpotsLogger) GetCWAvailableNames() ([]string, error) {
	if sl.readDB == nil {
		return nil, fmt.Errorf("CW spots database is not available")
	}

	rows, err := sl.readDB.Query(
		`SELECT DISTINCT band FROM cw_spots WHERE band IS NOT NULL AND band != '' ORDER BY band ASC`)
	if err != nil {
		return nil, fmt.Errorf("cw_spots names query failed: %w", err)
	}
	defer rows.Close()

	names := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("cw_spots names scan failed: %w", err)
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

// GetCWHistoricalCSV returns historical CW spots data as CSV string.
// callsigns is a set of uppercase callsigns to match; an empty map means no filter.
func (sl *CWSkimmerSpotsLogger) GetCWHistoricalCSV(band, name string, callsigns map[string]bool, continent, direction, fromDate, toDate, startTime, endTime string, minDistanceKm float64, minSNR int, ctyDatabase *CTYDatabase) (string, error) {
	// Get the spots data using existing method
	spots, err := sl.GetCWHistoricalSpots(band, name, callsigns, continent, direction, fromDate, toDate, startTime, endTime, minDistanceKm, minSNR, ctyDatabase)
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
	continent := r.URL.Query().Get("continent")
	direction := r.URL.Query().Get("direction")
	startTime := r.URL.Query().Get("start_time")
	endTime := r.URL.Query().Get("end_time")
	minDistanceStr := r.URL.Query().Get("min_distance")
	minSNRStr := r.URL.Query().Get("min_snr")

	// Parse callsigns: supports comma-separated (?callsign=G3XYZ,W1AW) and
	// repeated parameters (?callsign=G3XYZ&callsign=W1AW). Max 20 callsigns.
	callsigns := make(map[string]bool)
	for _, raw := range r.URL.Query()["callsign"] {
		for _, part := range strings.Split(raw, ",") {
			if p := strings.TrimSpace(strings.ToUpper(part)); p != "" {
				callsigns[p] = true
			}
		}
	}
	if len(callsigns) > 20 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "too many callsigns: maximum 20 allowed",
		})
		return
	}

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

	// Build a stable rate-limit key from the sorted callsign set
	callsignKey := sortedCallsignKey(callsigns)

	// Check rate limit
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-spots-%s-%s-%s-%s-%s-%s-%s-%s-%d", band, name, callsignKey, continent, direction, fromDate, toDate, startTime, minSNR)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		return
	}

	// Get spots
	spots, err := cwSkimmer.spotsLogger.GetCWHistoricalSpots(
		band, name, callsigns, continent, direction,
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
	continent := r.URL.Query().Get("continent")
	direction := r.URL.Query().Get("direction")
	startTime := r.URL.Query().Get("start_time")
	endTime := r.URL.Query().Get("end_time")
	minDistanceStr := r.URL.Query().Get("min_distance")
	minSNRStr := r.URL.Query().Get("min_snr")

	// Parse callsigns: supports comma-separated (?callsign=G3XYZ,W1AW) and
	// repeated parameters (?callsign=G3XYZ&callsign=W1AW). Max 20 callsigns.
	callsigns := make(map[string]bool)
	for _, raw := range r.URL.Query()["callsign"] {
		for _, part := range strings.Split(raw, ",") {
			if p := strings.TrimSpace(strings.ToUpper(part)); p != "" {
				callsigns[p] = true
			}
		}
	}
	if len(callsigns) > 20 {
		w.WriteHeader(http.StatusBadRequest)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "too many callsigns: maximum 20 allowed",
		})
		return
	}

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

	// Build a stable rate-limit key from the sorted callsign set
	callsignKey := sortedCallsignKey(callsigns)

	// Check rate limit
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-spots-csv-%s-%s-%s-%s-%s-%s-%s-%d", band, name, callsignKey, continent, direction, fromDate, toDate, minSNR)
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
		band, name, callsigns, continent, direction,
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
