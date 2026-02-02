package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"time"
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
func handlePublicSessionStats(w http.ResponseWriter, r *http.Request, config *Config, rateLimiter *SessionStatsRateLimiter) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract client IP for rate limiting
	clientIP := r.RemoteAddr
	if forwardedFor := r.Header.Get("X-Forwarded-For"); forwardedFor != "" {
		clientIP = forwardedFor
	}

	// Check rate limit
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
	stats := calculatePublicSessionStats(endEvents, startTime, endTime)

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
func calculatePublicSessionStats(endEvents []SessionEvent, startTime, endTime time.Time) map[string]interface{} {
	// Track unique countries with session counts
	countryStats := make(map[string]map[string]interface{})

	// Track unique IPs (for counting, not exposing)
	uniqueIPs := make(map[string]bool)

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

	// Process each session end event
	for _, event := range endEvents {
		// Skip events without duration
		if event.Duration == nil {
			continue
		}

		// Track unique IPs (for counting only)
		if event.ClientIP != "" {
			uniqueIPs[event.ClientIP] = true
		}

		// Track country statistics
		country := event.Country
		if country == "" {
			country = "Unknown"
		}

		if _, exists := countryStats[country]; !exists {
			countryStats[country] = map[string]interface{}{
				"country":      country,
				"country_code": event.CountryCode,
				"sessions":     0,
			}
		}
		stats := countryStats[country]
		stats["sessions"] = stats["sessions"].(int) + 1

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
	}

	// Convert country stats to sorted slice
	countries := make([]map[string]interface{}, 0, len(countryStats))
	for _, stats := range countryStats {
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

	return map[string]interface{}{
		"unique_countries":    len(countries),
		"countries":           countries,
		"unique_users":        len(uniqueIPs),
		"total_sessions":      len(endEvents),
		"duration_buckets":    durationBucketArray,
		"avg_hourly_activity": avgHourlyActivity,
	}
}
