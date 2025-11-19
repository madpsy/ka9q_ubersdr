package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SummaryResponse is the response structure for the summary API
type SummaryResponse struct {
	Period     string           `json:"period"`
	Date       string           `json:"date"`
	Summaries  []MetricsSummary `json:"summaries"`
	Comparison *ComparisonData  `json:"comparison,omitempty"`
}

// ComparisonData contains comparison between two time periods
type ComparisonData struct {
	PreviousPeriod []MetricsSummary `json:"previous_period"`
	Changes        []MetricChange   `json:"changes"`
}

// MetricChange represents the change between two periods
type MetricChange struct {
	Mode           string  `json:"mode"`
	Band           string  `json:"band"`
	SpotsDelta     int64   `json:"spots_delta"`
	SpotsPercent   float64 `json:"spots_percent_change"`
	CallsignsDelta int     `json:"callsigns_delta"`
}

// handleDecodeMetricsSummary serves aggregated metrics summaries
func handleDecodeMetricsSummary(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *SummaryRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.summaryAggregator == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Metrics summary service is not available",
		})
		return
	}

	// Get query parameters
	period := r.URL.Query().Get("period")            // Required: "day", "week", "month", "year"
	dateStr := r.URL.Query().Get("date")             // Required: date in appropriate format
	mode := r.URL.Query().Get("mode")                // Optional: filter by mode
	band := r.URL.Query().Get("band")                // Optional: filter by band
	compareWith := r.URL.Query().Get("compare_with") // Optional: date to compare with

	// Validate required parameters
	if period == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Missing required parameter 'period' (must be: day, week, month, or year)",
		})
		return
	}

	if dateStr == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Missing required parameter 'date'",
		})
		return
	}

	// Validate period
	if period != "day" && period != "week" && period != "month" && period != "year" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Invalid period. Must be: day, week, month, or year",
		})
		return
	}

	// Parse date based on period
	date, err := parseDateForPeriod(dateStr, period)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Invalid date format: %v", err),
		})
		return
	}

	// Check rate limit (5 requests per second per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Maximum 5 requests per second.",
		})
		log.Printf("Summary endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Read summaries from memory for real-time data (much faster than disk)
	summaries := md.summaryAggregator.GetAllSummariesFromMemory(period, date)

	// Filter by mode and/or band if specified
	filteredSummaries := filterSummaries(summaries, mode, band)

	// Build response
	response := SummaryResponse{
		Period:    period,
		Date:      dateStr,
		Summaries: filteredSummaries,
	}

	// Handle comparison if requested
	if compareWith != "" {
		compareDate, err := parseDateForPeriod(compareWith, period)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Invalid compare_with date format: %v", err),
			})
			return
		}

		// For comparison, try memory first, fall back to disk for historical data
		previousSummaries := md.summaryAggregator.GetAllSummariesFromMemory(period, compareDate)
		if len(previousSummaries) == 0 {
			// Not in memory, try reading from disk (historical data)
			var err error
			previousSummaries, err = md.summaryAggregator.ReadAllSummaries(period, compareDate)
			if err != nil {
				log.Printf("Warning: error reading comparison summaries from disk: %v", err)
			}
		}

		if len(previousSummaries) > 0 {
			filteredPrevious := filterSummaries(previousSummaries, mode, band)
			changes := calculateChanges(filteredSummaries, filteredPrevious)

			response.Comparison = &ComparisonData{
				PreviousPeriod: filteredPrevious,
				Changes:        changes,
			}
		}
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding summary response: %v", err)
	}
}

// parseDateForPeriod parses a date string based on the period type
func parseDateForPeriod(dateStr, period string) (time.Time, error) {
	now := time.Now()

	switch period {
	case "day":
		// Expected format: YYYY-MM-DD
		if dateStr == "today" {
			return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()), nil
		}
		t, err := time.Parse("2006-01-02", dateStr)
		if err != nil {
			return time.Time{}, fmt.Errorf("expected format YYYY-MM-DD (e.g., 2025-11-19)")
		}
		return t, nil

	case "week":
		// Expected format: YYYY-WNN (e.g., 2025-W47)
		if dateStr == "this-week" {
			weekday := int(now.Weekday())
			if weekday == 0 {
				weekday = 7
			}
			startOfWeek := time.Date(now.Year(), now.Month(), now.Day()-weekday+1, 0, 0, 0, 0, now.Location())
			return startOfWeek, nil
		}

		parts := strings.Split(dateStr, "-W")
		if len(parts) != 2 {
			return time.Time{}, fmt.Errorf("expected format YYYY-WNN (e.g., 2025-W47)")
		}

		year, err := strconv.Atoi(parts[0])
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid year in week format")
		}

		week, err := strconv.Atoi(parts[1])
		if err != nil || week < 1 || week > 53 {
			return time.Time{}, fmt.Errorf("invalid week number (must be 1-53)")
		}

		// Calculate the date of the first day of the week
		jan1 := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
		weekday := int(jan1.Weekday())
		if weekday == 0 {
			weekday = 7
		}

		// Find the Monday of week 1
		daysToMonday := (8 - weekday) % 7
		if daysToMonday == 0 && weekday != 1 {
			daysToMonday = 7
		}
		firstMonday := jan1.AddDate(0, 0, daysToMonday)

		// Add weeks
		targetDate := firstMonday.AddDate(0, 0, (week-1)*7)
		return targetDate, nil

	case "month":
		// Expected format: YYYY-MM
		if dateStr == "this-month" {
			return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location()), nil
		}
		t, err := time.Parse("2006-01", dateStr)
		if err != nil {
			return time.Time{}, fmt.Errorf("expected format YYYY-MM (e.g., 2025-11)")
		}
		return t, nil

	case "year":
		// Expected format: YYYY
		if dateStr == "this-year" {
			return time.Date(now.Year(), 1, 1, 0, 0, 0, 0, now.Location()), nil
		}
		year, err := strconv.Atoi(dateStr)
		if err != nil || year < 2000 || year > 2100 {
			return time.Time{}, fmt.Errorf("expected format YYYY (e.g., 2025)")
		}
		return time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC), nil

	default:
		return time.Time{}, fmt.Errorf("invalid period: %s", period)
	}
}

// filterSummaries filters summaries by mode and/or band
func filterSummaries(summaries []MetricsSummary, mode, band string) []MetricsSummary {
	if mode == "" && band == "" {
		return summaries
	}

	filtered := make([]MetricsSummary, 0)
	for _, summary := range summaries {
		if (mode == "" || summary.Mode == mode) && (band == "" || summary.Band == band) {
			filtered = append(filtered, summary)
		}
	}

	return filtered
}

// calculateChanges calculates the changes between current and previous summaries
func calculateChanges(current, previous []MetricsSummary) []MetricChange {
	changes := make([]MetricChange, 0)

	// Create a map of previous summaries for quick lookup
	prevMap := make(map[string]MetricsSummary)
	for _, prev := range previous {
		key := fmt.Sprintf("%s:%s", prev.Mode, prev.Band)
		prevMap[key] = prev
	}

	// Calculate changes for each current summary
	for _, curr := range current {
		key := fmt.Sprintf("%s:%s", curr.Mode, curr.Band)
		prev, exists := prevMap[key]

		change := MetricChange{
			Mode: curr.Mode,
			Band: curr.Band,
		}

		if exists {
			// Calculate deltas
			change.SpotsDelta = curr.TotalSpots - prev.TotalSpots
			change.CallsignsDelta = curr.UniqueCallsigns - prev.UniqueCallsigns

			// Calculate percentage change
			if prev.TotalSpots > 0 {
				change.SpotsPercent = (float64(change.SpotsDelta) / float64(prev.TotalSpots)) * 100.0
			} else if curr.TotalSpots > 0 {
				change.SpotsPercent = 100.0 // New activity
			}
		} else {
			// No previous data - all current values are new
			change.SpotsDelta = curr.TotalSpots
			change.CallsignsDelta = curr.UniqueCallsigns
			change.SpotsPercent = 100.0
		}

		changes = append(changes, change)
	}

	return changes
}
