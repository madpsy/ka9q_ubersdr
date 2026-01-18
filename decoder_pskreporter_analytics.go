package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PSKReporterSubmission represents a single submission to PSKReporter (before deduplication)
type PSKReporterSubmission struct {
	Callsign  string
	Locator   string
	SNR       int
	Frequency uint64
	Timestamp time.Time
	Mode      string
	Sent      bool // Whether this was actually sent to PSKReporter
}

// PSKReporterStats tracks statistics for a callsign/band/mode combination
type PSKReporterStats struct {
	Callsign         string    `json:"callsign"`
	Frequency        uint64    `json:"frequency"`
	Band             string    `json:"band"`
	Mode             string    `json:"mode"`
	Country          string    `json:"country"`
	FirstSeen        time.Time `json:"first_seen"`
	LastSeen         time.Time `json:"last_seen"`
	SubmissionCount  int       `json:"submission_count"`
	SentCount        int       `json:"sent_count"`
	Locators         []string  `json:"locators"`
	NoLocatorCount   int       `json:"no_locator_count"`
	WithLocatorCount int       `json:"with_locator_count"`
	FinalLocator     string    `json:"final_locator"`
}

// PSKReporterAnalytics tracks submission history for analytics
type PSKReporterAnalytics struct {
	submissions []PSKReporterSubmission
	mu          sync.RWMutex
}

// NewPSKReporterAnalytics creates a new analytics tracker
func NewPSKReporterAnalytics() *PSKReporterAnalytics {
	analytics := &PSKReporterAnalytics{
		submissions: make([]PSKReporterSubmission, 0, 10000),
	}

	// Start cleanup goroutine
	go analytics.cleanupOldSubmissions()

	return analytics
}

// RecordSubmission records a submission for analytics
func (pra *PSKReporterAnalytics) RecordSubmission(submission PSKReporterSubmission) {
	pra.mu.Lock()
	defer pra.mu.Unlock()

	pra.submissions = append(pra.submissions, submission)
}

// cleanupOldSubmissions removes submissions older than 24 hours
func (pra *PSKReporterAnalytics) cleanupOldSubmissions() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		pra.mu.Lock()
		cutoff := time.Now().Add(-24 * time.Hour)
		newSubmissions := make([]PSKReporterSubmission, 0, len(pra.submissions))

		for _, sub := range pra.submissions {
			if sub.Timestamp.After(cutoff) {
				newSubmissions = append(newSubmissions, sub)
			}
		}

		pra.submissions = newSubmissions
		pra.mu.Unlock()
	}
}

// GetStats returns statistics for all submissions within the time window
func (pra *PSKReporterAnalytics) GetStats(windowHours int, filters map[string]string) []PSKReporterStats {
	pra.mu.RLock()
	defer pra.mu.RUnlock()

	cutoff := time.Now().Add(-time.Duration(windowHours) * time.Hour)

	// Group submissions by callsign/band/mode
	statsMap := make(map[string]*PSKReporterStats)

	for _, sub := range pra.submissions {
		if sub.Timestamp.Before(cutoff) {
			continue
		}

		// Apply filters
		if !matchesFilters(sub, filters) {
			continue
		}

		band := frequencyToBandUint64(sub.Frequency)
		key := fmt.Sprintf("%s|%s|%s", sub.Callsign, band, sub.Mode)

		stats, exists := statsMap[key]
		if !exists {
			country := ""
			if info := GetCallsignInfo(sub.Callsign); info != nil {
				country = info.Country
			}

			stats = &PSKReporterStats{
				Callsign:  sub.Callsign,
				Frequency: sub.Frequency,
				Band:      band,
				Mode:      sub.Mode,
				Country:   country,
				FirstSeen: sub.Timestamp,
				LastSeen:  sub.Timestamp,
				Locators:  make([]string, 0),
			}
			statsMap[key] = stats
		}

		// Update statistics
		stats.SubmissionCount++
		if sub.Sent {
			stats.SentCount++
		}

		if sub.Timestamp.Before(stats.FirstSeen) {
			stats.FirstSeen = sub.Timestamp
		}
		if sub.Timestamp.After(stats.LastSeen) {
			stats.LastSeen = sub.Timestamp
		}

		// Track locators
		if sub.Locator == "" {
			stats.NoLocatorCount++
		} else {
			stats.WithLocatorCount++
			stats.FinalLocator = sub.Locator

			// Add to locators list if not already present
			found := false
			for _, loc := range stats.Locators {
				if loc == sub.Locator {
					found = true
					break
				}
			}
			if !found {
				stats.Locators = append(stats.Locators, sub.Locator)
			}
		}
	}

	// Convert map to slice
	result := make([]PSKReporterStats, 0, len(statsMap))
	for _, stats := range statsMap {
		result = append(result, *stats)
	}

	return result
}

// GetCountryStats returns unique countries per band/mode
func (pra *PSKReporterAnalytics) GetCountryStats(windowHours int, filters map[string]string) map[string]map[string][]string {
	pra.mu.RLock()
	defer pra.mu.RUnlock()

	cutoff := time.Now().Add(-time.Duration(windowHours) * time.Hour)

	// Map: band -> mode -> countries
	countryMap := make(map[string]map[string]map[string]bool)

	for _, sub := range pra.submissions {
		if sub.Timestamp.Before(cutoff) {
			continue
		}

		// Apply filters
		if !matchesFilters(sub, filters) {
			continue
		}

		info := GetCallsignInfo(sub.Callsign)
		if info == nil {
			continue
		}

		band := frequencyToBandUint64(sub.Frequency)

		if countryMap[band] == nil {
			countryMap[band] = make(map[string]map[string]bool)
		}
		if countryMap[band][sub.Mode] == nil {
			countryMap[band][sub.Mode] = make(map[string]bool)
		}

		countryMap[band][sub.Mode][info.Country] = true
	}

	// Convert to result format
	result := make(map[string]map[string][]string)
	for band, modes := range countryMap {
		result[band] = make(map[string][]string)
		for mode, countries := range modes {
			countryList := make([]string, 0, len(countries))
			for country := range countries {
				countryList = append(countryList, country)
			}
			result[band][mode] = countryList
		}
	}

	return result
}

// matchesFilters checks if a submission matches the given filters
func matchesFilters(sub PSKReporterSubmission, filters map[string]string) bool {
	if mode, ok := filters["mode"]; ok && mode != "" {
		if !strings.EqualFold(sub.Mode, mode) {
			return false
		}
	}

	if band, ok := filters["band"]; ok && band != "" {
		subBand := frequencyToBandUint64(sub.Frequency)
		if !strings.EqualFold(subBand, band) {
			return false
		}
	}

	if callsign, ok := filters["callsign"]; ok && callsign != "" {
		if !strings.Contains(strings.ToUpper(sub.Callsign), strings.ToUpper(callsign)) {
			return false
		}
	}

	if country, ok := filters["country"]; ok && country != "" {
		info := GetCallsignInfo(sub.Callsign)
		if info == nil || !strings.Contains(strings.ToLower(info.Country), strings.ToLower(country)) {
			return false
		}
	}

	return true
}

// frequencyToBandUint64 converts a frequency in Hz (uint64) to a band name
func frequencyToBandUint64(freqHz uint64) string {
	freq := float64(freqHz) / 1000000.0 // Convert to MHz

	// Amateur radio bands
	if freq >= 0.135 && freq < 0.138 {
		return "2200m"
	} else if freq >= 0.472 && freq < 0.479 {
		return "630m"
	} else if freq >= 1.8 && freq < 2.0 {
		return "160m"
	} else if freq >= 3.5 && freq < 4.0 {
		return "80m"
	} else if freq >= 5.3 && freq < 5.4 {
		return "60m"
	} else if freq >= 7.0 && freq < 7.3 {
		return "40m"
	} else if freq >= 10.1 && freq < 10.15 {
		return "30m"
	} else if freq >= 14.0 && freq < 14.35 {
		return "20m"
	} else if freq >= 18.068 && freq < 18.168 {
		return "17m"
	} else if freq >= 21.0 && freq < 21.45 {
		return "15m"
	} else if freq >= 24.89 && freq < 24.99 {
		return "12m"
	} else if freq >= 28.0 && freq < 29.7 {
		return "10m"
	} else if freq >= 50.0 && freq < 54.0 {
		return "6m"
	} else if freq >= 144.0 && freq < 148.0 {
		return "2m"
	} else if freq >= 222.0 && freq < 225.0 {
		return "1.25m"
	} else if freq >= 420.0 && freq < 450.0 {
		return "70cm"
	}

	return fmt.Sprintf("%.3fMHz", freq)
}

// handlePSKReporterStats handles GET requests for PSKReporter statistics
// Query parameters:
//   - hours: Time window in hours (default: 24, max: 168)
//   - mode: Filter by mode (e.g., FT8, FT4, WSPR)
//   - band: Filter by band (e.g., 20m, 40m)
//   - callsign: Filter by callsign (partial match)
//   - country: Filter by country (partial match)
func handlePSKReporterStats(w http.ResponseWriter, r *http.Request, multiDecoder *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check IP ban
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Get client IP
	clientIP := getClientIP(r)

	// Rate limiting
	if rateLimiter != nil && !rateLimiter.AllowRequest(clientIP, "pskr-stats") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse query parameters
	hoursStr := r.URL.Query().Get("hours")
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 168 {
			hours = h
		}
	}

	filters := map[string]string{
		"mode":     r.URL.Query().Get("mode"),
		"band":     r.URL.Query().Get("band"),
		"callsign": r.URL.Query().Get("callsign"),
		"country":  r.URL.Query().Get("country"),
	}

	// Get statistics
	if multiDecoder == nil || multiDecoder.pskReporter == nil || multiDecoder.pskReporter.analytics == nil {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, "PSKReporter analytics not available", http.StatusServiceUnavailable)
		return
	}

	stats := multiDecoder.pskReporter.analytics.GetStats(hours, filters)

	response := map[string]interface{}{
		"stats":        stats,
		"window_hours": hours,
		"window_start": time.Now().Add(-time.Duration(hours) * time.Hour),
		"window_end":   time.Now(),
		"filters":      filters,
		"count":        len(stats),
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding PSKReporter stats response: %v", err)
	}
}

// handlePSKReporterCountries handles GET requests for unique countries per band/mode
// Query parameters:
//   - hours: Time window in hours (default: 24, max: 168)
//   - mode: Filter by mode (e.g., FT8, FT4, WSPR)
//   - band: Filter by band (e.g., 20m, 40m)
func handlePSKReporterCountries(w http.ResponseWriter, r *http.Request, multiDecoder *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check IP ban
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Get client IP
	clientIP := getClientIP(r)

	// Rate limiting
	if rateLimiter != nil && !rateLimiter.AllowRequest(clientIP, "pskr-countries") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse query parameters
	hoursStr := r.URL.Query().Get("hours")
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 168 {
			hours = h
		}
	}

	filters := map[string]string{
		"mode": r.URL.Query().Get("mode"),
		"band": r.URL.Query().Get("band"),
	}

	// Get country statistics
	if multiDecoder == nil || multiDecoder.pskReporter == nil || multiDecoder.pskReporter.analytics == nil {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, "PSKReporter analytics not available", http.StatusServiceUnavailable)
		return
	}

	countries := multiDecoder.pskReporter.analytics.GetCountryStats(hours, filters)

	response := map[string]interface{}{
		"countries_by_band_mode": countries,
		"window_hours":           hours,
		"window_start":           time.Now().Add(-time.Duration(hours) * time.Hour),
		"window_end":             time.Now(),
		"filters":                filters,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding PSKReporter countries response: %v", err)
	}
}

// getClientIP is a helper that extracts client IP (defined in main.go but used here)
// This is just a reference - the actual function is in main.go
func getClientIPLocal(r *http.Request) string {
	sourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = host
	}
	return sourceIP
}
