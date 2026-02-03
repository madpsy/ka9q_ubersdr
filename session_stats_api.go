package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"time"

	"github.com/ua-parser/uap-go/uaparser"
)

// handlePublicSessionStats returns public session statistics for the last month
// This is a PUBLIC endpoint (no authentication required)
// Returns privacy-conscious statistics:
// - Unique countries with session counts (includes country codes)
// - Duration buckets (for showing top 5 duration ranges)
// - Per-hour average session activity (00-23)
// - Unique user count (without exposing IPs)
// - Only includes 'regular' auth users (not bypassed/password)
// Rate limited to 1 request per 3 seconds per IP
func handlePublicSessionStats(w http.ResponseWriter, r *http.Request, config *Config, rateLimiter *SessionStatsRateLimiter, geoIPService *GeoIPService) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check rate limit (1 request per 3 seconds per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "rate_limit_exceeded",
			"message": "Rate limit exceeded. Please wait before making another request (1 request per 3 seconds).",
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if session activity logging is enabled
	if !config.Server.SessionActivityLogEnabled {
		http.Error(w, "Session activity logging is not enabled", http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "not_enabled",
			"message": "Session activity logging is not enabled in configuration",
		})
		return
	}

	// Calculate time range: last 4 weeks (28 days)
	endTime := time.Now().UTC()
	startTime := endTime.Add(-28 * 24 * time.Hour)

	// Read logs from disk
	logs, err := ReadActivityLogs(config.Server.SessionActivityLogDir, startTime, endTime)
	if err != nil {
		http.Error(w, "Failed to read activity logs", http.StatusInternalServerError)
		log.Printf("Error reading activity logs for public stats: %v", err)
		return
	}

	// Filter to only include 'regular' auth users (not bypassed or password)
	logs = FilterSessionsByAuthMethod(logs, []string{"regular"})

	// Convert logs to events to get session start/end information
	events := convertLogsToEvents(logs)

	// Filter to only session_end events (which have duration information)
	endEvents := filterEventsByType(events, []string{"session_end"})

	// Calculate public statistics
	stats := calculatePublicSessionStats(endEvents, startTime, endTime, geoIPService)

	// Return statistics
	response := map[string]interface{}{
		"period_start": startTime.Format(time.RFC3339),
		"period_end":   endTime.Format(time.RFC3339),
		"period_days":  28,
		"stats":        stats,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding public session stats: %v", err)
	}
}

// calculatePublicSessionStats calculates privacy-conscious statistics from session end events
func calculatePublicSessionStats(endEvents []SessionEvent, startTime, endTime time.Time, geoIPService *GeoIPService) map[string]interface{} {
	// Track unique countries with session counts
	countryStats := make(map[string]map[string]interface{})
	
	// Track unique locations (lat/lon) per country with session counts
	type LocationData struct {
		Lat      float64
		Lon      float64
		Sessions int
	}
	countryLocations := make(map[string]map[string]*LocationData) // country -> "lat,lon" -> LocationData

	// Track unique IPs (for counting, not exposing)
	uniqueIPs := make(map[string]bool)
	
	// Track session counts per IP with event info for GeoIP lookups
	type IPSessionInfo struct {
		SessionCount int
		EventCountry string
		EventCode    string
	}
	ipSessions := make(map[string]*IPSessionInfo) // IP -> session info

	// Duration buckets (in minutes): 0-1, 1-5, 5-15, 15-30, 30-60, 60-120, 120+
	durationBuckets := map[string]int{
		"0-1min":    0,
		"1-5min":    0,
		"5-15min":   0,
		"15-30min":  0,
		"30-60min":  0,
		"60-120min": 0,
		"120min+":   0,
	}

	// Per-hour activity (00-23) - count of sessions that ended in each hour
	hourlyActivity := make([]int, 24)

	// Per-weekday activity (Sunday=0 to Saturday=6) - count of sessions that ended on each day
	weekdayActivity := make([]int, 7)

	// User agent statistics
	browserCounts := make(map[string]int)
	osCounts := make(map[string]int)
	
	// Band and mode statistics
	bandCounts := make(map[string]int)
	modeCounts := make(map[string]int)
	
	// Initialize user agent parser
	parser := uaparser.NewFromSaved()

	// Process each session end event
	for _, event := range endEvents {
		// Skip events without duration
		if event.Duration == nil {
			continue
		}

		// Track unique IPs (for counting only)
		if event.ClientIP != "" {
			uniqueIPs[event.ClientIP] = true
			
			// Track session counts per IP with country info from event
			if _, exists := ipSessions[event.ClientIP]; !exists {
				ipSessions[event.ClientIP] = &IPSessionInfo{
					SessionCount: 0,
					EventCountry: event.Country,
					EventCode:    event.CountryCode,
				}
			}
			ipSessions[event.ClientIP].SessionCount++
		}

		// Parse user agent if available
		if event.UserAgent != "" {
			// Check for UberSDR user agents first (special handling)
			if len(event.UserAgent) >= 7 && event.UserAgent[:7] == "UberSDR" {
				// Extract UberSDR client type and version
				// Examples: "UberSDR/1.0", "UberSDR Client 1.0 (go)", "UberSDR_HPSDR/1.0"
				browserCounts["UberSDR Client"]++
				
				// UberSDR is a browser/client, not an OS
				// Try to parse the OS from the rest of the user agent string
				client := parser.Parse(event.UserAgent)
				if client.Os.Family != "" {
					os := client.Os.Family
					if client.Os.Major != "" {
						os += " " + client.Os.Major
					}
					osCounts[os]++
				}
			} else {
				// Parse regular user agents
				client := parser.Parse(event.UserAgent)
				
				// Track browser (family + major version)
				if client.UserAgent.Family != "" {
					browser := client.UserAgent.Family
					if client.UserAgent.Major != "" {
						browser += " " + client.UserAgent.Major
					}
					browserCounts[browser]++
				}
				
				// Track OS (family + major version)
				if client.Os.Family != "" {
					os := client.Os.Family
					if client.Os.Major != "" {
						os += " " + client.Os.Major
					}
					osCounts[os]++
				}
			}
		}
		
		// Track bands visited during this session
		for _, band := range event.Bands {
			if band != "" {
				bandCounts[band]++
			}
		}
		
		// Track modes used during this session
		for _, mode := range event.Modes {
			if mode != "" {
				modeCounts[mode]++
			}
		}

		// Categorize duration into buckets
		durationMinutes := *event.Duration / 60.0
		if durationMinutes < 1 {
			durationBuckets["0-1min"]++
		} else if durationMinutes < 5 {
			durationBuckets["1-5min"]++
		} else if durationMinutes < 15 {
			durationBuckets["5-15min"]++
		} else if durationMinutes < 30 {
			durationBuckets["15-30min"]++
		} else if durationMinutes < 60 {
			durationBuckets["30-60min"]++
		} else if durationMinutes < 120 {
			durationBuckets["60-120min"]++
		} else {
			durationBuckets["120min+"]++
		}

		// Track hourly activity (hour when session ended)
		hour := event.Timestamp.Hour()
		hourlyActivity[hour]++

		// Track weekday activity (day when session ended)
		weekday := int(event.Timestamp.Weekday())
		weekdayActivity[weekday]++
	}

	// Perform GeoIP lookups for all IPs to get country and location data
	// This will use fresh GeoIP data which may be more accurate than stored event data
	if geoIPService != nil && geoIPService.IsEnabled() {
		for ip, info := range ipSessions {
			geoResult, err := geoIPService.Lookup(ip)
			if err != nil {
				// GeoIP lookup failed, fall back to event country if available
				country := info.EventCountry
				if country == "" {
					country = "Unknown"
				}
				
				// Initialize country stats if needed
				if _, exists := countryStats[country]; !exists {
					countryStats[country] = map[string]interface{}{
						"country":      country,
						"country_code": info.EventCode,
						"sessions":     0,
					}
					countryLocations[country] = make(map[string]*LocationData)
				}
				countryStats[country]["sessions"] = countryStats[country]["sessions"].(int) + info.SessionCount
				continue
			}
			
			// Use GeoIP country if available, otherwise fall back to event country
			country := geoResult.Country
			countryCode := geoResult.CountryCode
			if country == "" {
				country = info.EventCountry
				countryCode = info.EventCode
			}
			if country == "" {
				country = "Unknown"
			}
			
			// Initialize country stats if needed
			if _, exists := countryStats[country]; !exists {
				countryStats[country] = map[string]interface{}{
					"country":      country,
					"country_code": countryCode,
					"sessions":     0,
				}
				countryLocations[country] = make(map[string]*LocationData)
			}
			countryStats[country]["sessions"] = countryStats[country]["sessions"].(int) + info.SessionCount
			
			// Add location data if available
			if geoResult.Latitude != nil && geoResult.Longitude != nil {
				lat := *geoResult.Latitude
				lon := *geoResult.Longitude
				locKey := fmt.Sprintf("%.4f,%.4f", lat, lon)
				
				if _, exists := countryLocations[country][locKey]; !exists {
					countryLocations[country][locKey] = &LocationData{
						Lat:      lat,
						Lon:      lon,
						Sessions: 0,
					}
				}
				countryLocations[country][locKey].Sessions += info.SessionCount
			}
		}
	} else {
		// No GeoIP service available, use country from events
		for _, info := range ipSessions {
			country := info.EventCountry
			if country == "" {
				country = "Unknown"
			}
			
			if _, exists := countryStats[country]; !exists {
				countryStats[country] = map[string]interface{}{
					"country":      country,
					"country_code": info.EventCode,
					"sessions":     0,
				}
				countryLocations[country] = make(map[string]*LocationData)
			}
			countryStats[country]["sessions"] = countryStats[country]["sessions"].(int) + info.SessionCount
		}
	}
	
	// Convert country stats to sorted slice and add locations array
	countries := make([]map[string]interface{}, 0, len(countryStats))
	for countryName, stats := range countryStats {
		// Add locations array for this country
		locations := make([]map[string]interface{}, 0)
		if locs, ok := countryLocations[countryName]; ok {
			for _, loc := range locs {
				locations = append(locations, map[string]interface{}{
					"latitude":  loc.Lat,
					"longitude": loc.Lon,
					"sessions":  loc.Sessions,
				})
			}
		}
		stats["locations"] = locations
		countries = append(countries, stats)
	}

	// Sort countries by session count (descending)
	sort.Slice(countries, func(i, j int) bool {
		return countries[i]["sessions"].(int) > countries[j]["sessions"].(int)
	})

	// Calculate average hourly activity
	periodHours := endTime.Sub(startTime).Hours()
	avgHourlyActivity := make([]float64, 24)
	for hour := 0; hour < 24; hour++ {
		// Calculate how many times this hour occurred in the period
		daysInPeriod := periodHours / 24.0
		if daysInPeriod > 0 {
			avgHourlyActivity[hour] = float64(hourlyActivity[hour]) / daysInPeriod
		}
	}

	// Prepare duration buckets as sorted array for easier display
	durationBucketArray := []map[string]interface{}{
		{"range": "0-1min", "count": durationBuckets["0-1min"]},
		{"range": "1-5min", "count": durationBuckets["1-5min"]},
		{"range": "5-15min", "count": durationBuckets["5-15min"]},
		{"range": "15-30min", "count": durationBuckets["15-30min"]},
		{"range": "30-60min", "count": durationBuckets["30-60min"]},
		{"range": "60-120min", "count": durationBuckets["60-120min"]},
		{"range": "120min+", "count": durationBuckets["120min+"]},
	}

	// Sort duration buckets by count (descending) to show top 5
	sort.Slice(durationBucketArray, func(i, j int) bool {
		return durationBucketArray[i]["count"].(int) > durationBucketArray[j]["count"].(int)
	})

	// Calculate average weekday activity (sessions per weekday over the 4-week period)
	// 4 weeks = 4 occurrences of each weekday
	avgWeekdayActivity := make([]float64, 7)
	for day := 0; day < 7; day++ {
		avgWeekdayActivity[day] = float64(weekdayActivity[day]) / 4.0
	}

	// Prepare browser statistics (top 10)
	type BrowserStat struct {
		Name     string
		Sessions int
	}
	browsers := make([]BrowserStat, 0, len(browserCounts))
	for browser, count := range browserCounts {
		browsers = append(browsers, BrowserStat{Name: browser, Sessions: count})
	}
	sort.Slice(browsers, func(i, j int) bool {
		return browsers[i].Sessions > browsers[j].Sessions
	})
	// Take top 10
	if len(browsers) > 10 {
		browsers = browsers[:10]
	}
	
	// Convert to map format for JSON
	browserStats := make([]map[string]interface{}, len(browsers))
	for i, b := range browsers {
		browserStats[i] = map[string]interface{}{
			"name":     b.Name,
			"sessions": b.Sessions,
		}
	}

	// Prepare OS statistics (top 10)
	type OSStat struct {
		Name     string
		Sessions int
	}
	operatingSystems := make([]OSStat, 0, len(osCounts))
	for os, count := range osCounts {
		operatingSystems = append(operatingSystems, OSStat{Name: os, Sessions: count})
	}
	sort.Slice(operatingSystems, func(i, j int) bool {
		return operatingSystems[i].Sessions > operatingSystems[j].Sessions
	})
	// Take top 10
	if len(operatingSystems) > 10 {
		operatingSystems = operatingSystems[:10]
	}
	
	// Convert to map format for JSON
	osStats := make([]map[string]interface{}, len(operatingSystems))
	for i, os := range operatingSystems {
		osStats[i] = map[string]interface{}{
			"name":     os.Name,
			"sessions": os.Sessions,
		}
	}

	// Prepare band statistics (sorted by session count)
	type BandStat struct {
		Name     string
		Sessions int
	}
	bands := make([]BandStat, 0, len(bandCounts))
	for band, count := range bandCounts {
		bands = append(bands, BandStat{Name: band, Sessions: count})
	}
	sort.Slice(bands, func(i, j int) bool {
		return bands[i].Sessions > bands[j].Sessions
	})
	
	// Convert to map format for JSON
	bandStats := make([]map[string]interface{}, len(bands))
	for i, b := range bands {
		bandStats[i] = map[string]interface{}{
			"name":     b.Name,
			"sessions": b.Sessions,
		}
	}

	// Prepare mode statistics (sorted by session count)
	type ModeStat struct {
		Name     string
		Sessions int
	}
	modes := make([]ModeStat, 0, len(modeCounts))
	for mode, count := range modeCounts {
		modes = append(modes, ModeStat{Name: mode, Sessions: count})
	}
	sort.Slice(modes, func(i, j int) bool {
		return modes[i].Sessions > modes[j].Sessions
	})
	
	// Convert to map format for JSON
	modeStats := make([]map[string]interface{}, len(modes))
	for i, m := range modes {
		modeStats[i] = map[string]interface{}{
			"name":     m.Name,
			"sessions": m.Sessions,
		}
	}

	return map[string]interface{}{
		"unique_countries":      len(countries),
		"countries":             countries,
		"unique_users":          len(uniqueIPs),
		"total_sessions":        len(endEvents),
		"duration_buckets":      durationBucketArray,
		"avg_hourly_activity":   avgHourlyActivity,
		"avg_weekday_activity":  avgWeekdayActivity,
		"top_browsers":          browserStats,
		"top_operating_systems": osStats,
		"top_bands":             bandStats,
		"top_modes":             modeStats,
	}
}
