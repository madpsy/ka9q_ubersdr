package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// handleCWMetrics serves comprehensive CW spot metrics (placeholder for now)
func handleCWMetrics(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW Skimmer spots logging is not available",
		})
		return
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := "cw-metrics"
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("CW metrics endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// TODO: Implement full CW metrics similar to decoder metrics
	// For now, return a placeholder response
	w.WriteHeader(http.StatusNotImplemented)
	json.NewEncoder(w).Encode(map[string]string{
		"error": "CW metrics endpoint is not yet fully implemented. Coming soon!",
	})
}

// handleCWMetricsSummary serves aggregated CW metrics summaries
func handleCWMetricsSummary(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *SummaryRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW Skimmer is not available",
		})
		return
	}

	// Check if metrics are available
	if cwSkimmer.metrics == nil || cwSkimmer.metrics.summaryAggregator == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW metrics summaries are not enabled",
		})
		return
	}

	// Check rate limit (10 requests per second per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Maximum 10 requests per second.",
		})
		log.Printf("CW metrics summary endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get query parameters
	period := r.URL.Query().Get("period") // day, week, month, year
	dateStr := r.URL.Query().Get("date")  // YYYY-MM-DD or YYYY-MM or YYYY or "this-week"

	if period == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "period parameter is required (day, week, month, or year)",
		})
		return
	}

	if dateStr == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date parameter is required",
		})
		return
	}

	// Parse date parameter
	var targetDate time.Time
	var err error

	if dateStr == "this-week" {
		targetDate = time.Now()
	} else {
		// Try parsing as YYYY-MM-DD
		targetDate, err = time.Parse("2006-01-02", dateStr)
		if err != nil {
			// Try parsing as YYYY-MM
			targetDate, err = time.Parse("2006-01", dateStr)
			if err != nil {
				// Try parsing as YYYY
				targetDate, err = time.Parse("2006", dateStr)
				if err != nil {
					w.WriteHeader(http.StatusBadRequest)
					json.NewEncoder(w).Encode(map[string]string{
						"error": "Invalid date format. Use YYYY-MM-DD, YYYY-MM, YYYY, or 'this-week'",
					})
					return
				}
			}
		}
	}

	// Get summaries from memory (fast, real-time data)
	summaries := cwSkimmer.metrics.summaryAggregator.GetAllSummariesFromMemory(period, targetDate)

	// If no summaries in memory, try loading from disk
	if len(summaries) == 0 {
		summaries, err = cwSkimmer.metrics.summaryAggregator.ReadAllSummaries(period, targetDate)
		if err != nil {
			log.Printf("Warning: failed to read CW summaries from disk: %v", err)
			summaries = []CWMetricsSummary{} // Return empty array instead of error
		}
	}

	response := map[string]interface{}{
		"period":    period,
		"date":      dateStr,
		"summaries": summaries,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding CW metrics summary: %v", err)
	}
}
