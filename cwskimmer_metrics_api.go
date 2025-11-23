package main

import (
	"encoding/json"
	"log"
	"net/http"
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

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW Skimmer spots logging is not available",
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
	date := r.URL.Query().Get("date")     // YYYY-MM-DD or YYYY-MM or YYYY or "this-week"

	if period == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "period parameter is required (day, week, month, or year)",
		})
		return
	}

	if date == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date parameter is required",
		})
		return
	}

	// TODO: Implement CW metrics summary similar to decoder metrics summary
	// For now, return a placeholder response with empty summaries
	response := map[string]interface{}{
		"period":    period,
		"date":      date,
		"summaries": []interface{}{},
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding CW metrics summary: %v", err)
	}
}
