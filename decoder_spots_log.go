package main

import (
	"database/sql"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

// SpotsLogger persists decoder spots (FT8/FT4/WSPR/JS8/FT2) to SQLite.
// Spots are written to the spots table; there is no file-based path.
type SpotsLogger struct {
	// dataDir is retained solely so db_import.go can backfill historical CSV
	// files written before the SQLite migration. Nothing is written here at
	// runtime any more.
	dataDir string

	// Control
	enabled bool

	// SQLite write connection (single-writer pool). nil when DB not available.
	db *sql.DB

	// SQLite read-only connection pool. Used for all SELECT queries.
	readDB *sql.DB
}

// SetDB wires the SQLite write connection into the spots logger.
func (sl *SpotsLogger) SetDB(db *sql.DB) {
	sl.db = db
}

// SetReadDB wires the SQLite read-only pool used for all SELECT queries.
func (sl *SpotsLogger) SetReadDB(readDB *sql.DB) {
	sl.readDB = readDB
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
	DBm        *int     `json:"dbm,omitempty"`         // Transmitter power in dBm (WSPR only)
	Mode       string   `json:"mode"`
	Name       string   `json:"name"`       // Decoder config band name
	SeenCount  int      `json:"seen_count"` // Raw decodes collapsed into this row (1 when not deduplicating)
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

// NewSpotsLogger creates a new spots logger.
// maxAgeDays is retained for signature compatibility but no longer used at
// runtime: DB retention is handled by RetentionConfig.SpotsDays in the
// DBManager. Historical file cleanup is gone with the file write path.
func NewSpotsLogger(dataDir string, enabled bool, maxAgeDays int) (*SpotsLogger, error) {
	if !enabled {
		return &SpotsLogger{enabled: false}, nil
	}

	sl := &SpotsLogger{
		dataDir: dataDir,
		enabled: true,
	}

	return sl, nil
}

// LogSpot writes a spot to the spots table.
func (sl *SpotsLogger) LogSpot(decode *DecodeInfo) error {
	if !sl.enabled {
		return nil
	}
	if sl.db == nil {
		return nil
	}

	// Calculate band from frequency
	band := frequencyToBand(float64(decode.Frequency))

	var dbm interface{} // NULL unless WSPR
	if decode.IsWSPR {
		dbm = decode.DBm
	}
	_, err := sl.db.Exec(
		`INSERT INTO spots
		 (ts, mode, decoder_name, callsign, locator, snr, frequency, band,
		  message, country, cq_zone, itu_zone, continent,
		  distance_km, bearing_deg, dbm)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		decode.Timestamp.Unix(),
		decode.Mode,
		decode.BandName,
		decode.Callsign,
		decode.Locator,
		decode.SNR,
		decode.Frequency,
		band,
		decode.Message,
		decode.Country,
		decode.CQZone,
		decode.ITUZone,
		decode.Continent,
		decode.DistanceKm, // *float64 — nil becomes NULL
		decode.BearingDeg, // *float64 — nil becomes NULL
		dbm,
	)
	if err != nil {
		log.Printf("[DB] spots insert error: %v", err)
		return err
	}

	return nil
}

// Close is a no-op — there are no file handles or goroutines to release.
func (sl *SpotsLogger) Close() error {
	return nil
}

// GetHistoricalSpots reads historical spots from the spots SQLite table.
// Parameters:
// - mode: Filter by mode (FT8, FT4, WSPR) - empty for all modes
// - band: Filter by calculated band (e.g., "20m", "40m") - empty for all bands
// - name: Filter by decoder config name - empty for all names
// - callsign: Filter by exact callsign match - empty for all callsigns
// - locator: Filter by exact locator match - empty for all locators
// - continent: Filter by continent code (AF, AS, EU, NA, OC, SA, AN) - empty for all
// - country: Filter by exact CTY country name (as returned by /api/cty/countries) - empty for all
// - direction: Filter by cardinal direction (N, NE, E, SE, S, SW, W, NW) - empty for all
// - fromDate: Start date (YYYY-MM-DD)
// - toDate: End date (YYYY-MM-DD) - empty for single day
// - startTime: Start time (HH:MM) - empty for no time filter
// - endTime: End time (HH:MM) - empty for no time filter
// - deduplicate: If true, only return unique callsign/locator combinations per day
// - locatorsOnly: If true, only return spots that have a locator
// - minDistanceKm: Minimum distance in km (0 = no filter)
// - minSNR: Minimum SNR in dB (-999 = no filter)
func (sl *SpotsLogger) GetHistoricalSpots(mode, band, name, callsign, locator, continent, country, direction, fromDate, toDate, startTime, endTime string, deduplicate, locatorsOnly bool, minDistanceKm float64, minSNR int) ([]SpotRecord, error) {
	if sl.readDB == nil {
		return nil, fmt.Errorf("spots database is not available")
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

	// Half-open date range [startOfFromDate, startOfDayAfterToDate) in UTC Unix
	// seconds, matching the old per-day file semantics.
	startTS := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, time.UTC).Unix()
	endTS := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1).Unix()

	var conditions []string
	var args []interface{}

	conditions = append(conditions, "ts >= ? AND ts < ?")
	args = append(args, startTS, endTS)

	if mode != "" {
		conditions = append(conditions, "mode = ?")
		args = append(args, mode)
	}
	if band != "" {
		conditions = append(conditions, "band = ?")
		args = append(args, band)
	}
	// The file-based "name" filter selected a decoder config file; it maps to
	// the decoder_name column.
	if name != "" {
		conditions = append(conditions, "decoder_name = ?")
		args = append(args, name)
	}
	if callsign != "" {
		conditions = append(conditions, "callsign = ?")
		args = append(args, callsign)
	}
	if locator != "" {
		conditions = append(conditions, "locator = ?")
		args = append(args, locator)
	}
	if continent != "" {
		conditions = append(conditions, "continent = ?")
		args = append(args, continent)
	}
	if country != "" {
		conditions = append(conditions, "country = ?")
		args = append(args, country)
	}
	if locatorsOnly {
		conditions = append(conditions, "locator != ''")
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

	query := `SELECT ts, mode, decoder_name, callsign, locator, snr, frequency, band,
	                 message, country, cq_zone, itu_zone, continent,
	                 distance_km, bearing_deg, dbm
	          FROM spots
	          WHERE ` + strings.Join(conditions, " AND ") + `
	          ORDER BY ts DESC`

	rows, err := sl.readDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("spots query failed: %w", err)
	}
	defer rows.Close()

	allSpots := make([]SpotRecord, 0)
	// For deduplication: key = callsign|locator|band|mode|date, value = latest spot.
	seenSpots := make(map[string]SpotRecord)
	// Raw decodes collapsed into each dedup key, reported as SeenCount.
	seenCounts := make(map[string]int)

	for rows.Next() {
		var (
			ts          int64
			modeCol     string
			decoderName sql.NullString
			cs          string
			loc         string
			snr         int
			frequency   uint64
			bandCol     string
			message     string
			country     string
			cqZone      int
			ituZone     int
			cont        string
			dist        sql.NullFloat64
			bearing     sql.NullFloat64
			dbm         sql.NullInt64
		)
		if err := rows.Scan(&ts, &modeCol, &decoderName, &cs, &loc, &snr, &frequency, &bandCol,
			&message, &country, &cqZone, &ituZone, &cont,
			&dist, &bearing, &dbm); err != nil {
			return nil, fmt.Errorf("spots scan failed: %w", err)
		}

		utc := time.Unix(ts, 0).UTC()
		spot := SpotRecord{
			Timestamp: utc.Format(time.RFC3339),
			Callsign:  cs,
			Locator:   loc,
			SNR:       snr,
			Frequency: frequency,
			Band:      bandCol,
			Message:   message,
			Country:   country,
			CQZone:    cqZone,
			ITUZone:   ituZone,
			Continent: cont,
			Mode:      modeCol,
			Name:      decoderName.String, // "" when NULL, matching the file-based config name
		}
		if dist.Valid {
			v := dist.Float64
			spot.DistanceKm = &v
		}
		if bearing.Valid {
			v := bearing.Float64
			spot.BearingDeg = &v
		}
		if dbm.Valid {
			v := int(dbm.Int64)
			spot.DBm = &v
		}

		// Direction filter — SQLite has no bearing-to-compass function, so it is
		// applied in Go against the bearing_deg column.
		if direction != "" {
			if spot.BearingDeg == nil || !matchesDirection(*spot.BearingDeg, direction) {
				continue
			}
		}

		if deduplicate {
			// Dedup key: callsign+locator+band+mode+date (UTC day). Same callsign
			// on different bands/modes/days is kept distinct. Keep the later
			// timestamp, matching the old string comparison on RFC3339 values.
			dateStr := utc.Format("2006-01-02")
			dedupKey := fmt.Sprintf("%s|%s|%s|%s|%s", spot.Callsign, spot.Locator, spot.Band, spot.Mode, dateStr)
			seenCounts[dedupKey]++
			if existing, exists := seenSpots[dedupKey]; exists {
				if spot.Timestamp > existing.Timestamp {
					seenSpots[dedupKey] = spot
				}
				continue
			}
			seenSpots[dedupKey] = spot
			continue
		}

		spot.SeenCount = 1
		allSpots = append(allSpots, spot)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("spots row iteration failed: %w", err)
	}

	// If deduplication was enabled, collect the deduplicated spots.
	if deduplicate {
		for key, spot := range seenSpots {
			spot.SeenCount = seenCounts[key]
			allSpots = append(allSpots, spot)
		}
	}

	// Sort spots by timestamp in descending order (newest first). The query
	// already returns rows in this order, but dedup uses a map that loses
	// ordering, so re-sort to guarantee it.
	sort.Slice(allSpots, func(i, j int) bool {
		return allSpots[i].Timestamp > allSpots[j].Timestamp
	})

	return allSpots, nil
}

// GetAvailableDates returns a list of dates for which spot data is available
func (sl *SpotsLogger) GetAvailableDates() ([]string, error) {
	if sl.readDB == nil {
		return nil, fmt.Errorf("spots database is not available")
	}

	rows, err := sl.readDB.Query(
		`SELECT DISTINCT DATE(ts, 'unixepoch') AS date FROM spots ORDER BY date DESC`)
	if err != nil {
		return nil, fmt.Errorf("spots dates query failed: %w", err)
	}
	defer rows.Close()

	dates := make([]string, 0)
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			return nil, fmt.Errorf("spots dates scan failed: %w", err)
		}
		dates = append(dates, date)
	}
	return dates, rows.Err()
}

// GetAvailableNames returns a list of unique decoder config names that have spot data
func (sl *SpotsLogger) GetAvailableNames() ([]string, error) {
	if sl.readDB == nil {
		return nil, fmt.Errorf("spots database is not available")
	}

	rows, err := sl.readDB.Query(
		`SELECT DISTINCT decoder_name FROM spots WHERE decoder_name IS NOT NULL AND decoder_name != '' ORDER BY decoder_name ASC`)
	if err != nil {
		return nil, fmt.Errorf("spots names query failed: %w", err)
	}
	defer rows.Close()

	names := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("spots names scan failed: %w", err)
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

// GetHistoricalCSV returns historical spots data as CSV string
// Parameters match GetHistoricalSpots for filtering
func (sl *SpotsLogger) GetHistoricalCSV(mode, band, name, callsign, locator, continent, country, direction, fromDate, toDate, startTime, endTime string, deduplicate, locatorsOnly bool, minDistanceKm float64, minSNR int) (string, error) {
	// Get the spots data using existing method
	spots, err := sl.GetHistoricalSpots(mode, band, name, callsign, locator, continent, country, direction, fromDate, toDate, startTime, endTime, deduplicate, locatorsOnly, minDistanceKm, minSNR)
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
		filterCountry,   // country filter
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
		filterCountry,   // country filter
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
