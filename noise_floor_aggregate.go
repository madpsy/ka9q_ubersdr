package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"time"
)

// AggregateRequest represents a request for aggregated noise floor data
type AggregateRequest struct {
	Primary    TimeRange  `json:"primary"`
	Comparison *TimeRange `json:"comparison,omitempty"` // Optional comparison range
	Bands      []string   `json:"bands"`
	Fields     []string   `json:"fields"`
	Interval   string     `json:"interval"` // "minute", "hour", "day", "week", "month"
}

// TimeRange represents a time range for data aggregation
type TimeRange struct {
	From string `json:"from"` // RFC3339 format
	To   string `json:"to"`   // RFC3339 format
}

// AggregateResponse contains the aggregated data for primary and optional comparison ranges
type AggregateResponse struct {
	Primary        map[string][]AggregatedMeasurement `json:"primary"`
	Comparison     map[string][]AggregatedMeasurement `json:"comparison,omitempty"`
	ProcessingTime float64                            `json:"processing_time_ms"` // Processing time in milliseconds
	Info           string                             `json:"info,omitempty"`     // Informational message (e.g., interval adjustment)
}

// AggregatedMeasurement represents a single aggregated measurement
type AggregatedMeasurement struct {
	Timestamp   time.Time          `json:"timestamp"`
	Values      map[string]float32 `json:"values"`
	SampleCount int                `json:"sample_count"` // Number of samples in this aggregate
}

// handleNoiseFloorAggregate handles POST requests for aggregated noise floor data
func handleNoiseFloorAggregate(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *AggregateRateLimiter, prometheusMetrics *PrometheusMetrics) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Check rate limit (1 request per 5 seconds per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 5 seconds between aggregate requests.",
		})
		log.Printf("Aggregate rate limit exceeded for IP: %s", clientIP)

		// Record rate limit error in Prometheus
		if prometheusMetrics != nil {
			prometheusMetrics.RecordRateLimitError("aggregate")
		}

		return
	}

	startTime := time.Now()

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if nfm == nil {
		http.Error(w, "Noise floor monitoring not enabled", http.StatusServiceUnavailable)
		return
	}

	// Parse request body
	var req AggregateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	// Validate request
	if err := validateAggregateRequest(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Calculate optimal interval to keep data points manageable
	adjustedInterval, multiplier, infoMsg := calculateOptimalInterval(req.Primary, req.Interval)

	// Process primary range with adjusted interval
	primaryData, err := nfm.GetAggregatedData(req.Primary, req.Bands, req.Fields, adjustedInterval)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get primary data: %v", err), http.StatusInternalServerError)
		return
	}

	response := AggregateResponse{
		Primary: primaryData,
		Info:    infoMsg,
	}

	// Process comparison range if provided
	if req.Comparison != nil {
		// Use same multiplier for comparison to keep intervals consistent
		compAdjustedInterval := adjustIntervalByMultiplier(req.Interval, multiplier)
		comparisonData, err := nfm.GetAggregatedData(*req.Comparison, req.Bands, req.Fields, compAdjustedInterval)
		if err != nil {
			log.Printf("Warning: Failed to get comparison data: %v", err)
			// Don't fail the entire request if comparison fails
		} else {
			response.Comparison = comparisonData
		}
	}

	// Calculate processing time
	processingTime := time.Since(startTime).Seconds() * 1000 // Convert to milliseconds
	response.ProcessingTime = processingTime

	// Record latency in Prometheus (in seconds)
	if prometheusMetrics != nil {
		prometheusMetrics.RecordAggregateLatency(time.Since(startTime).Seconds())
	}

	// Return JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding aggregate response: %v", err)
	}
}

// validateAggregateRequest validates the aggregate request parameters
func validateAggregateRequest(req *AggregateRequest) error {
	const maxDuration = 365 * 24 * time.Hour // 1 year maximum

	// Validate primary time range
	if req.Primary.From == "" || req.Primary.To == "" {
		return fmt.Errorf("primary time range must have both 'from' and 'to' fields")
	}

	fromTime, err := time.Parse(time.RFC3339, req.Primary.From)
	if err != nil {
		return fmt.Errorf("invalid primary 'from' time format: %v", err)
	}

	toTime, err := time.Parse(time.RFC3339, req.Primary.To)
	if err != nil {
		return fmt.Errorf("invalid primary 'to' time format: %v", err)
	}

	if toTime.Before(fromTime) {
		return fmt.Errorf("primary 'to' time must be after 'from' time")
	}

	// Check primary duration doesn't exceed 1 year
	primaryDuration := toTime.Sub(fromTime)
	if primaryDuration > maxDuration {
		return fmt.Errorf("primary time range exceeds maximum of 1 year (requested: %.1f days)", primaryDuration.Hours()/24)
	}

	// Validate comparison time range if provided
	if req.Comparison != nil {
		if req.Comparison.From == "" || req.Comparison.To == "" {
			return fmt.Errorf("comparison time range must have both 'from' and 'to' fields")
		}

		compFromTime, err := time.Parse(time.RFC3339, req.Comparison.From)
		if err != nil {
			return fmt.Errorf("invalid comparison 'from' time format: %v", err)
		}

		compToTime, err := time.Parse(time.RFC3339, req.Comparison.To)
		if err != nil {
			return fmt.Errorf("invalid comparison 'to' time format: %v", err)
		}

		if compToTime.Before(compFromTime) {
			return fmt.Errorf("comparison 'to' time must be after 'from' time")
		}

		// Check comparison duration doesn't exceed 1 year
		comparisonDuration := compToTime.Sub(compFromTime)
		if comparisonDuration > maxDuration {
			return fmt.Errorf("comparison time range exceeds maximum of 1 year (requested: %.1f days)", comparisonDuration.Hours()/24)
		}
	}

	// Validate bands
	if len(req.Bands) == 0 {
		return fmt.Errorf("at least one band must be specified")
	}

	// Validate fields
	if len(req.Fields) == 0 {
		return fmt.Errorf("at least one field must be specified")
	}

	validFields := map[string]bool{
		"min_db": true, "max_db": true, "mean_db": true, "median_db": true,
		"p5_db": true, "p10_db": true, "p95_db": true,
		"dynamic_range": true, "occupancy_pct": true, "ft8_snr": true,
	}

	for _, field := range req.Fields {
		if !validFields[field] {
			return fmt.Errorf("invalid field: %s", field)
		}
	}

	// Validate interval
	validIntervals := map[string]bool{
		"minute": true, "hour": true, "day": true, "week": true, "month": true,
	}

	if !validIntervals[req.Interval] {
		return fmt.Errorf("invalid interval: %s (must be one of: minute, hour, day, week, month)", req.Interval)
	}

	return nil
}

// GetAggregatedData retrieves and aggregates noise floor data for the specified time range
func (nfm *NoiseFloorMonitor) GetAggregatedData(timeRange TimeRange, bands []string, fields []string, interval string) (map[string][]AggregatedMeasurement, error) {
	if nfm == nil {
		return nil, fmt.Errorf("noise floor monitor not enabled")
	}

	// Parse time range
	fromTime, err := time.Parse(time.RFC3339, timeRange.From)
	if err != nil {
		return nil, fmt.Errorf("invalid from time: %v", err)
	}

	toTime, err := time.Parse(time.RFC3339, timeRange.To)
	if err != nil {
		return nil, fmt.Errorf("invalid to time: %v", err)
	}

	// Get interval duration
	intervalDuration, err := getIntervalDuration(interval)
	if err != nil {
		return nil, err
	}

	// Collect all measurements for the time range
	allMeasurements := make(map[string][]*BandMeasurement)

	// Determine which dates we need to read
	dates := getDateRange(fromTime, toTime)

	for _, band := range bands {
		bandMeasurements := make([]*BandMeasurement, 0)

		for _, date := range dates {
			measurements, err := nfm.readBandFile(band, date)
			if err != nil {
				// Skip dates without data
				continue
			}

			// Filter to time range
			for _, m := range measurements {
				if (m.Timestamp.Equal(fromTime) || m.Timestamp.After(fromTime)) &&
					(m.Timestamp.Before(toTime) || m.Timestamp.Equal(toTime)) {
					bandMeasurements = append(bandMeasurements, m)
				}
			}
		}

		if len(bandMeasurements) > 0 {
			allMeasurements[band] = bandMeasurements
		}
	}

	// Aggregate measurements by interval
	result := make(map[string][]AggregatedMeasurement)

	for band, measurements := range allMeasurements {
		aggregated := aggregateMeasurements(measurements, intervalDuration, fields)
		if len(aggregated) > 0 {
			result[band] = aggregated
		}
	}

	return result, nil
}

// getIntervalDuration converts interval string to time.Duration
// Supports both simple intervals ("minute", "hour") and multiplied intervals ("10minute", "2hour")
func getIntervalDuration(interval string) (time.Duration, error) {
	// Try to parse multiplied interval (e.g., "10minute")
	var multiplier int
	var baseInterval string

	n, err := fmt.Sscanf(interval, "%d%s", &multiplier, &baseInterval)
	if err != nil || n != 2 {
		// Not a multiplied interval, treat as simple interval
		multiplier = 1
		baseInterval = interval
	}

	var baseDuration time.Duration
	switch baseInterval {
	case "minute":
		baseDuration = time.Minute
	case "hour":
		baseDuration = time.Hour
	case "day":
		baseDuration = 24 * time.Hour
	case "week":
		baseDuration = 7 * 24 * time.Hour
	case "month":
		baseDuration = 30 * 24 * time.Hour // Approximate
	default:
		return 0, fmt.Errorf("invalid interval: %s", interval)
	}

	return time.Duration(multiplier) * baseDuration, nil
}

// getDateRange returns all dates between from and to (inclusive)
func getDateRange(from, to time.Time) []string {
	dates := make([]string, 0)

	// Start at beginning of from date
	current := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, from.Location())
	// End at beginning of day after to date
	end := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, to.Location()).Add(24 * time.Hour)

	for current.Before(end) {
		dates = append(dates, current.Format("2006-01-02"))
		current = current.Add(24 * time.Hour)
	}

	return dates
}

// aggregateMeasurements groups measurements by interval and calculates averages
func aggregateMeasurements(measurements []*BandMeasurement, interval time.Duration, fields []string) []AggregatedMeasurement {
	if len(measurements) == 0 {
		return nil
	}

	// Group measurements into buckets
	buckets := make(map[int64][]*BandMeasurement)

	for _, m := range measurements {
		// Calculate bucket timestamp (rounded down to interval boundary)
		bucketTime := m.Timestamp.Truncate(interval).Unix()
		buckets[bucketTime] = append(buckets[bucketTime], m)
	}

	// Calculate averages for each bucket
	aggregated := make([]AggregatedMeasurement, 0, len(buckets))

	for bucketTime, bucketMeasurements := range buckets {
		if len(bucketMeasurements) == 0 {
			continue
		}

		values := make(map[string]float32)
		count := float32(len(bucketMeasurements))

		// Calculate averages for requested fields
		for _, field := range fields {
			sum := float32(0)
			for _, m := range bucketMeasurements {
				sum += getFieldValue(m, field)
			}
			values[field] = sum / count
		}

		aggregated = append(aggregated, AggregatedMeasurement{
			Timestamp:   time.Unix(bucketTime, 0),
			Values:      values,
			SampleCount: len(bucketMeasurements),
		})
	}

	// Sort by timestamp (oldest first)
	sort.Slice(aggregated, func(i, j int) bool {
		return aggregated[i].Timestamp.Before(aggregated[j].Timestamp)
	})

	return aggregated
}

// calculateOptimalInterval determines if the requested interval would generate too many data points
// and adjusts it if necessary. Returns the adjusted interval string, multiplier used, and an info message.
func calculateOptimalInterval(timeRange TimeRange, requestedInterval string) (string, int, string) {
	const maxDataPoints = 5000 // Maximum data points per band to keep charts responsive

	// Parse time range
	fromTime, err := time.Parse(time.RFC3339, timeRange.From)
	if err != nil {
		return requestedInterval, 1, fmt.Sprintf("Using %s interval", requestedInterval)
	}

	toTime, err := time.Parse(time.RFC3339, timeRange.To)
	if err != nil {
		return requestedInterval, 1, fmt.Sprintf("Using %s interval", requestedInterval)
	}

	// Calculate duration in minutes
	duration := toTime.Sub(fromTime)
	durationMinutes := duration.Minutes()

	// Get base interval duration in minutes
	var baseIntervalMinutes float64
	switch requestedInterval {
	case "minute":
		baseIntervalMinutes = 1
	case "hour":
		baseIntervalMinutes = 60
	case "day":
		baseIntervalMinutes = 24 * 60
	case "week":
		baseIntervalMinutes = 7 * 24 * 60
	case "month":
		baseIntervalMinutes = 30 * 24 * 60
	default:
		return requestedInterval, 1, fmt.Sprintf("Using %s interval", requestedInterval)
	}

	// Calculate expected data points
	expectedPoints := int(durationMinutes / baseIntervalMinutes)

	// If within limit, return original interval with info message
	if expectedPoints <= maxDataPoints {
		infoMsg := fmt.Sprintf("Using %s interval (~%d data points per band)",
			formatInterval(requestedInterval, 1),
			expectedPoints)
		return requestedInterval, 1, infoMsg
	}

	// Calculate required multiplier to bring points under limit
	multiplier := (expectedPoints + maxDataPoints - 1) / maxDataPoints // Round up

	// Adjust interval based on multiplier
	adjustedInterval := adjustIntervalByMultiplier(requestedInterval, multiplier)

	// Generate info message
	infoMsg := fmt.Sprintf("Interval automatically adjusted from %s to %s to limit data points (would have been %d points, now ~%d points)",
		formatInterval(requestedInterval, 1),
		formatInterval(requestedInterval, multiplier),
		expectedPoints,
		expectedPoints/multiplier)

	return adjustedInterval, multiplier, infoMsg
}

// adjustIntervalByMultiplier adjusts an interval by a multiplier
// For example: "minute" with multiplier 10 becomes "10minute"
func adjustIntervalByMultiplier(baseInterval string, multiplier int) string {
	if multiplier <= 1 {
		return baseInterval
	}
	return fmt.Sprintf("%d%s", multiplier, baseInterval)
}

// formatInterval formats an interval with multiplier for display
func formatInterval(baseInterval string, multiplier int) string {
	if multiplier <= 1 {
		return baseInterval
	}

	// Format with proper pluralization
	unit := baseInterval
	if multiplier > 1 {
		unit += "s"
	}

	return fmt.Sprintf("%d %s", multiplier, unit)
}

// getFieldValue extracts the specified field value from a measurement
func getFieldValue(m *BandMeasurement, field string) float32 {
	switch field {
	case "min_db":
		return m.MinDB
	case "max_db":
		return m.MaxDB
	case "mean_db":
		return m.MeanDB
	case "median_db":
		return m.MedianDB
	case "p5_db":
		return m.P5DB
	case "p10_db":
		return m.P10DB
	case "p95_db":
		return m.P95DB
	case "dynamic_range":
		return m.DynamicRange
	case "occupancy_pct":
		return m.OccupancyPct
	case "ft8_snr":
		return m.FT8SNR
	default:
		return 0
	}
}
