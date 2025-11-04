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
}

// AggregatedMeasurement represents a single aggregated measurement
type AggregatedMeasurement struct {
	Timestamp   time.Time          `json:"timestamp"`
	Values      map[string]float32 `json:"values"`
	SampleCount int                `json:"sample_count"` // Number of samples in this aggregate
}

// handleNoiseFloorAggregate handles POST requests for aggregated noise floor data
func handleNoiseFloorAggregate(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor) {
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

	// Process primary range
	primaryData, err := nfm.GetAggregatedData(req.Primary, req.Bands, req.Fields, req.Interval)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get primary data: %v", err), http.StatusInternalServerError)
		return
	}

	response := AggregateResponse{
		Primary: primaryData,
	}

	// Process comparison range if provided
	if req.Comparison != nil {
		comparisonData, err := nfm.GetAggregatedData(*req.Comparison, req.Bands, req.Fields, req.Interval)
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

	// Return JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding aggregate response: %v", err)
	}
}

// validateAggregateRequest validates the aggregate request parameters
func validateAggregateRequest(req *AggregateRequest) error {
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
func getIntervalDuration(interval string) (time.Duration, error) {
	switch interval {
	case "minute":
		return time.Minute, nil
	case "hour":
		return time.Hour, nil
	case "day":
		return 24 * time.Hour, nil
	case "week":
		return 7 * 24 * time.Hour, nil
	case "month":
		return 30 * 24 * time.Hour, nil // Approximate
	default:
		return 0, fmt.Errorf("invalid interval: %s", interval)
	}
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
