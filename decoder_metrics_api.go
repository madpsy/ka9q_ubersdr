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

// DecodeMetricsResponse contains comprehensive decode metrics
type DecodeMetricsResponse struct {
	// Summary statistics
	Summary struct {
		TotalModes int `json:"total_modes"`
		TotalBands int `json:"total_bands"`
		TimeWindow struct {
			Hours int       `json:"hours"`
			Start time.Time `json:"start"`
			End   time.Time `json:"end"`
		} `json:"time_window"`
	} `json:"summary"`

	// Per mode/band metrics
	Metrics []ModeBandMetrics `json:"metrics"`

	// Time series data (optional, based on query params)
	TimeSeries []TimeSeriesPoint `json:"time_series,omitempty"`

	// Execution time time series (optional, based on query params)
	ExecutionTimeSeries []ExecutionTimeSeriesPoint `json:"execution_time_series,omitempty"`

	// Top performers
	TopCallsigns []CallsignStats `json:"top_callsigns,omitempty"`
}

// ModeBandMetrics contains all metrics for a specific mode/band combination
type ModeBandMetrics struct {
	Mode string `json:"mode"`
	Band string `json:"band"`

	// Decode counts
	DecodeCounts struct {
		Last1Hour   int64 `json:"last_1h"`
		Last3Hours  int64 `json:"last_3h"`
		Last6Hours  int64 `json:"last_6h"`
		Last12Hours int64 `json:"last_12h"`
		Last24Hours int64 `json:"last_24h"`
	} `json:"decode_counts"`

	// Average decodes per cycle
	DecodesPerCycle struct {
		Last1Min  float64 `json:"last_1m"`
		Last5Min  float64 `json:"last_5m"`
		Last15Min float64 `json:"last_15m"`
		Last30Min float64 `json:"last_30m"`
		Last60Min float64 `json:"last_60m"`
	} `json:"decodes_per_cycle"`

	// Unique callsigns
	UniqueCallsigns struct {
		Last1Hour   int `json:"last_1h"`
		Last3Hours  int `json:"last_3h"`
		Last6Hours  int `json:"last_6h"`
		Last12Hours int `json:"last_12h"`
		Last24Hours int `json:"last_24h"`
	} `json:"unique_callsigns"`

	// Decoder performance
	ExecutionTime struct {
		Last1Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_1m"`
		Last5Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_5m"`
		Last10Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_10m"`
	} `json:"execution_time"`

	// Activity metrics
	Activity struct {
		DecodesPerHour   float64 `json:"decodes_per_hour"`
		CallsignsPerHour float64 `json:"callsigns_per_hour"`
		ActivityScore    float64 `json:"activity_score"` // Normalized 0-100
	} `json:"activity"`
}

// TimeSeriesPoint represents a single point in time series data
type TimeSeriesPoint struct {
	Timestamp time.Time                  `json:"timestamp"`
	Interval  string                     `json:"interval"` // e.g., "15m", "1h"
	Data      map[string]ModeBandSummary `json:"data"`     // key: "mode:band"
}

// ModeBandSummary contains summary data for a time bucket
type ModeBandSummary struct {
	Mode            string  `json:"mode"`
	Band            string  `json:"band"`
	DecodeCount     int     `json:"decode_count"`
	UniqueCallsigns int     `json:"unique_callsigns"`
	AvgSNR          float64 `json:"avg_snr,omitempty"`
}

// ExecutionTimeSeriesPoint represents execution time data over time
type ExecutionTimeSeriesPoint struct {
	Timestamp time.Time                          `json:"timestamp"`
	Interval  string                             `json:"interval"`
	Data      map[string]ExecutionTimeBucketData `json:"data"` // key: "mode:band"
}

// ExecutionTimeBucketData contains execution time stats for a time bucket
type ExecutionTimeBucketData struct {
	Mode        string  `json:"mode"`
	Band        string  `json:"band"`
	AvgSeconds  float64 `json:"avg_seconds"`
	MinSeconds  float64 `json:"min_seconds"`
	MaxSeconds  float64 `json:"max_seconds"`
	SampleCount int     `json:"sample_count"`
}

// CallsignStats contains statistics for a callsign
type CallsignStats struct {
	Callsign    string    `json:"callsign"`
	DecodeCount int       `json:"decode_count"`
	Modes       []string  `json:"modes"`
	Bands       []string  `json:"bands"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`
}

// handleDecodeMetrics serves comprehensive decode metrics
func handleDecodeMetrics(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.prometheusMetrics == nil || md.prometheusMetrics.digitalMetrics == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decode metrics are not available",
		})
		return
	}

	// Get query parameters
	mode := r.URL.Query().Get("mode")      // Filter by mode
	band := r.URL.Query().Get("band")      // Filter by band
	hoursStr := r.URL.Query().Get("hours") // Time window (default 24, deprecated in favor of from/to)
	fromStr := r.URL.Query().Get("from")   // Start time (RFC3339 or Unix timestamp)
	toStr := r.URL.Query().Get("to")       // End time (RFC3339 or Unix timestamp)
	includeTimeSeries := r.URL.Query().Get("timeseries") == "true"
	intervalStr := r.URL.Query().Get("interval") // Time series interval (default "15m")
	includeTopCallsigns := r.URL.Query().Get("top_callsigns") == "true"
	topLimitStr := r.URL.Query().Get("top_limit") // Limit for top callsigns (default 10)

	// Determine time range
	var startTime, endTime time.Time
	now := time.Now()

	// Priority: from/to parameters, then hours parameter, then default 24 hours
	if fromStr != "" && toStr != "" {
		// Parse from/to timestamps
		var err error
		startTime, err = parseTimeParam(fromStr)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Invalid 'from' parameter: %v", err),
			})
			return
		}

		endTime, err = parseTimeParam(toStr)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Invalid 'to' parameter: %v", err),
			})
			return
		}

		// Validate time range
		if endTime.Before(startTime) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "'to' time must be after 'from' time",
			})
			return
		}

		// Limit maximum range to 7 days
		maxDuration := 7 * 24 * time.Hour
		if endTime.Sub(startTime) > maxDuration {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "Time range cannot exceed 7 days",
			})
			return
		}
	} else {
		// Fall back to hours parameter (default 24, max 48)
		hours := 24
		if hoursStr != "" {
			if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 168 { // Max 7 days
				hours = h
			}
		}
		endTime = now
		startTime = now.Add(-time.Duration(hours) * time.Hour)
	}

	// Calculate hours for backward compatibility
	hours := int(endTime.Sub(startTime).Hours())

	// Parse top limit (default 10, max 100)
	topLimit := 10
	if topLimitStr != "" {
		if limit, err := strconv.Atoi(topLimitStr); err == nil && limit > 0 && limit <= 100 {
			topLimit = limit
		}
	}

	// Parse interval (default 15m)
	interval := 15 * time.Minute
	if intervalStr != "" {
		if d, err := time.ParseDuration(intervalStr); err == nil && d > 0 {
			interval = d
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("decode-metrics-%s-%s-%d", mode, band, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Decode metrics endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Build response
	response := DecodeMetricsResponse{}

	// Set time window
	response.Summary.TimeWindow.Hours = hours
	response.Summary.TimeWindow.End = endTime
	response.Summary.TimeWindow.Start = startTime

	// Always try to read from files if metrics logging is enabled
	// This ensures we have data even after restarts or for time ranges with sparse in-memory data
	var fileSnapshots map[string][]MetricsSnapshot
	if md.metricsLogger != nil && md.metricsLogger.enabled {
		log.Printf("Reading metrics from files for time range: %v to %v", startTime, endTime)
		var err error
		fileSnapshots, err = md.metricsLogger.ReadMetricsFromFiles(startTime, endTime)
		if err != nil {
			log.Printf("Warning: error reading metrics from files: %v", err)
		} else {
			log.Printf("Loaded %d mode-band combinations from files", len(fileSnapshots))
		}
	}

	// Get all mode/band combinations from in-memory data
	combinations := md.prometheusMetrics.digitalMetrics.GetAllModeBandCombinations()
	log.Printf("Found %d mode-band combinations in memory", len(combinations))

	// Also add combinations from file snapshots if available (BEFORE filtering)
	if fileSnapshots != nil {
		addedFromFiles := 0
		for key := range fileSnapshots {
			// Parse key format "mode:band" using strings.Split
			parts := strings.Split(key, ":")
			if len(parts) == 2 {
				foundMode := parts[0]
				foundBand := parts[1]

				// Apply filter here - only add if it matches the requested mode/band
				// Note: Band names are user-defined and may not match standard names
				// For exact match filtering to work, the band parameter must match exactly
				if (mode == "" || foundMode == mode) && (band == "" || foundBand == band) {
					// Check if this combination already exists
					exists := false
					for _, combo := range combinations {
						if combo.Mode == foundMode && combo.Band == foundBand {
							exists = true
							break
						}
					}
					if !exists {
						combinations = append(combinations, struct{ Mode, Band string }{Mode: foundMode, Band: foundBand})
						addedFromFiles++
					}
				}
			}
		}
		log.Printf("Added %d mode-band combinations from files (total now: %d)", addedFromFiles, len(combinations))
	}

	// Filter combinations if mode or band specified
	filteredCombinations := []struct{ Mode, Band string }{}
	for _, combo := range combinations {
		if (mode == "" || combo.Mode == mode) && (band == "" || combo.Band == band) {
			filteredCombinations = append(filteredCombinations, combo)
		}
	}

	response.Summary.TotalModes = countUniqueModes(filteredCombinations)
	response.Summary.TotalBands = countUniqueBands(filteredCombinations)

	// Collect metrics for each combination
	response.Metrics = make([]ModeBandMetrics, 0, len(filteredCombinations))

	for _, combo := range filteredCombinations {
		metrics := ModeBandMetrics{
			Mode: combo.Mode,
			Band: combo.Band,
		}

		// Get cycle seconds (default 15 for FT8)
		cycleSeconds := 15
		if combo.Mode == "FT4" {
			cycleSeconds = 7
		} else if combo.Mode == "WSPR" {
			cycleSeconds = 120
		}

		// Calculate summary metrics from time series data for consistency
		key := fmt.Sprintf("%s:%s", combo.Mode, combo.Band)

		// Always generate time series first to ensure we have the data
		if !includeTimeSeries {
			// Generate time series temporarily just for summary calculation
			tempTimeSeries := generateTimeSeriesWithFiles(md.prometheusMetrics.digitalMetrics, []struct{ Mode, Band string }{combo}, interval, startTime, endTime, fileSnapshots)

			// Count total decodes from time series
			totalDecodes := int64(0)
			totalUniqueCallsigns := 0

			for _, point := range tempTimeSeries {
				if data, exists := point.Data[key]; exists {
					totalDecodes += int64(data.DecodeCount)
					// Sum unique callsigns across all buckets (this is an upper bound estimate)
					totalUniqueCallsigns += data.UniqueCallsigns
				}
			}

			// Use time series totals for the requested time range
			if totalDecodes > 0 {
				metrics.DecodeCounts.Last24Hours = totalDecodes
				metrics.UniqueCallsigns.Last24Hours = totalUniqueCallsigns

				// Estimate shorter windows proportionally
				if hours >= 1 {
					metrics.DecodeCounts.Last1Hour = totalDecodes * 1 / int64(hours)
					metrics.UniqueCallsigns.Last1Hour = totalUniqueCallsigns * 1 / hours
				}
				if hours >= 3 {
					metrics.DecodeCounts.Last3Hours = totalDecodes * 3 / int64(hours)
					metrics.UniqueCallsigns.Last3Hours = totalUniqueCallsigns * 3 / hours
				}
				if hours >= 6 {
					metrics.DecodeCounts.Last6Hours = totalDecodes * 6 / int64(hours)
					metrics.UniqueCallsigns.Last6Hours = totalUniqueCallsigns * 6 / hours
				}
				if hours >= 12 {
					metrics.DecodeCounts.Last12Hours = totalDecodes * 12 / int64(hours)
					metrics.UniqueCallsigns.Last12Hours = totalUniqueCallsigns * 12 / hours
				}

				log.Printf("Using time series data for %s - Total: %d decodes, ~%d unique callsigns over %d hours",
					key, totalDecodes, totalUniqueCallsigns, hours)
			} else {
				// Fallback to in-memory if no time series data
				metrics.DecodeCounts.Last1Hour = md.prometheusMetrics.digitalMetrics.GetTotalDecodes(combo.Mode, combo.Band, 1)
				metrics.DecodeCounts.Last3Hours = md.prometheusMetrics.digitalMetrics.GetTotalDecodes(combo.Mode, combo.Band, 3)
				metrics.DecodeCounts.Last6Hours = md.prometheusMetrics.digitalMetrics.GetTotalDecodes(combo.Mode, combo.Band, 6)
				metrics.DecodeCounts.Last12Hours = md.prometheusMetrics.digitalMetrics.GetTotalDecodes(combo.Mode, combo.Band, 12)
				metrics.DecodeCounts.Last24Hours = md.prometheusMetrics.digitalMetrics.GetTotalDecodes(combo.Mode, combo.Band, 24)

				metrics.UniqueCallsigns.Last1Hour = md.prometheusMetrics.digitalMetrics.GetUniqueCallsigns(combo.Mode, combo.Band, 1)
				metrics.UniqueCallsigns.Last3Hours = md.prometheusMetrics.digitalMetrics.GetUniqueCallsigns(combo.Mode, combo.Band, 3)
				metrics.UniqueCallsigns.Last6Hours = md.prometheusMetrics.digitalMetrics.GetUniqueCallsigns(combo.Mode, combo.Band, 6)
				metrics.UniqueCallsigns.Last12Hours = md.prometheusMetrics.digitalMetrics.GetUniqueCallsigns(combo.Mode, combo.Band, 12)
				metrics.UniqueCallsigns.Last24Hours = md.prometheusMetrics.digitalMetrics.GetUniqueCallsigns(combo.Mode, combo.Band, 24)
			}
		}

		// Decodes per cycle - use in-memory data (recent activity only)
		metrics.DecodesPerCycle.Last1Min = md.prometheusMetrics.digitalMetrics.GetAverageDecodesPerCycle(combo.Mode, combo.Band, cycleSeconds, 1)
		metrics.DecodesPerCycle.Last5Min = md.prometheusMetrics.digitalMetrics.GetAverageDecodesPerCycle(combo.Mode, combo.Band, cycleSeconds, 5)
		metrics.DecodesPerCycle.Last15Min = md.prometheusMetrics.digitalMetrics.GetAverageDecodesPerCycle(combo.Mode, combo.Band, cycleSeconds, 15)
		metrics.DecodesPerCycle.Last30Min = md.prometheusMetrics.digitalMetrics.GetAverageDecodesPerCycle(combo.Mode, combo.Band, cycleSeconds, 30)
		metrics.DecodesPerCycle.Last60Min = md.prometheusMetrics.digitalMetrics.GetAverageDecodesPerCycle(combo.Mode, combo.Band, cycleSeconds, 60)

		// Execution time
		avg1m, min1m, max1m := md.prometheusMetrics.digitalMetrics.GetExecutionTimeStats(combo.Mode, combo.Band, 1)
		metrics.ExecutionTime.Last1Min.Avg = avg1m
		metrics.ExecutionTime.Last1Min.Min = min1m
		metrics.ExecutionTime.Last1Min.Max = max1m

		avg5m, min5m, max5m := md.prometheusMetrics.digitalMetrics.GetExecutionTimeStats(combo.Mode, combo.Band, 5)
		metrics.ExecutionTime.Last5Min.Avg = avg5m
		metrics.ExecutionTime.Last5Min.Min = min5m
		metrics.ExecutionTime.Last5Min.Max = max5m

		avg10m, min10m, max10m := md.prometheusMetrics.digitalMetrics.GetExecutionTimeStats(combo.Mode, combo.Band, 10)
		metrics.ExecutionTime.Last10Min.Avg = avg10m
		metrics.ExecutionTime.Last10Min.Min = min10m
		metrics.ExecutionTime.Last10Min.Max = max10m

		// Activity metrics
		if metrics.DecodeCounts.Last24Hours > 0 {
			metrics.Activity.DecodesPerHour = float64(metrics.DecodeCounts.Last24Hours) / 24.0
			metrics.Activity.CallsignsPerHour = float64(metrics.UniqueCallsigns.Last24Hours) / 24.0

			// Activity score: normalized based on decodes per hour (0-100 scale)
			// Assume 100 decodes/hour = 100% activity
			metrics.Activity.ActivityScore = (metrics.Activity.DecodesPerHour / 100.0) * 100.0
			if metrics.Activity.ActivityScore > 100 {
				metrics.Activity.ActivityScore = 100
			}
		}

		response.Metrics = append(response.Metrics, metrics)
	}

	// Generate time series if requested
	if includeTimeSeries {
		response.TimeSeries = generateTimeSeriesWithFiles(md.prometheusMetrics.digitalMetrics, filteredCombinations, interval, startTime, endTime, fileSnapshots)
		response.ExecutionTimeSeries = generateExecutionTimeSeriesWithFiles(md.prometheusMetrics.digitalMetrics, filteredCombinations, interval, startTime, endTime, fileSnapshots)

		// Now update summary metrics from the generated time series
		for i := range response.Metrics {
			metrics := &response.Metrics[i]
			key := fmt.Sprintf("%s:%s", metrics.Mode, metrics.Band)

			// Count total decodes and unique callsigns from time series
			totalDecodes := int64(0)
			totalUniqueCallsigns := 0

			for _, point := range response.TimeSeries {
				if data, exists := point.Data[key]; exists {
					totalDecodes += int64(data.DecodeCount)
					// Sum unique callsigns across all buckets (upper bound estimate)
					totalUniqueCallsigns += data.UniqueCallsigns
				}
			}

			// Update metrics with time series totals
			if totalDecodes > 0 {
				metrics.DecodeCounts.Last24Hours = totalDecodes
				metrics.UniqueCallsigns.Last24Hours = totalUniqueCallsigns

				// Estimate shorter windows proportionally
				if hours >= 1 {
					metrics.DecodeCounts.Last1Hour = totalDecodes * 1 / int64(hours)
					metrics.UniqueCallsigns.Last1Hour = totalUniqueCallsigns * 1 / hours
				}
				if hours >= 3 {
					metrics.DecodeCounts.Last3Hours = totalDecodes * 3 / int64(hours)
					metrics.UniqueCallsigns.Last3Hours = totalUniqueCallsigns * 3 / hours
				}
				if hours >= 6 {
					metrics.DecodeCounts.Last6Hours = totalDecodes * 6 / int64(hours)
					metrics.UniqueCallsigns.Last6Hours = totalUniqueCallsigns * 6 / hours
				}
				if hours >= 12 {
					metrics.DecodeCounts.Last12Hours = totalDecodes * 12 / int64(hours)
					metrics.UniqueCallsigns.Last12Hours = totalUniqueCallsigns * 12 / hours
				}

				// Recalculate activity metrics based on actual time range
				metrics.Activity.DecodesPerHour = float64(totalDecodes) / float64(hours)
				metrics.Activity.CallsignsPerHour = float64(totalUniqueCallsigns) / float64(hours)
				metrics.Activity.ActivityScore = (metrics.Activity.DecodesPerHour / 100.0) * 100.0
				if metrics.Activity.ActivityScore > 100 {
					metrics.Activity.ActivityScore = 100
				}

				log.Printf("Updated summary for %s from time series - Total: %d decodes, ~%d unique callsigns over %d hours",
					key, totalDecodes, totalUniqueCallsigns, hours)
			}
		}
	}

	// Generate top callsigns if requested
	if includeTopCallsigns && md.spotsLogger != nil {
		response.TopCallsigns = getTopCallsigns(md.spotsLogger, mode, band, hours, topLimit)
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding decode metrics: %v", err)
	}
}

// countUniqueModes counts unique modes in combinations
func countUniqueModes(combinations []struct{ Mode, Band string }) int {
	modes := make(map[string]bool)
	for _, combo := range combinations {
		modes[combo.Mode] = true
	}
	return len(modes)
}

// countUniqueBands counts unique bands in combinations
func countUniqueBands(combinations []struct{ Mode, Band string }) int {
	bands := make(map[string]bool)
	for _, combo := range combinations {
		bands[combo.Band] = true
	}
	return len(bands)
}

// generateTimeSeries creates time-bucketed decode data
func generateTimeSeries(dm *DigitalDecodeMetrics, combinations []struct{ Mode, Band string }, interval time.Duration, hours int) []TimeSeriesPoint {
	now := time.Now()
	startTime := now.Add(-time.Duration(hours) * time.Hour)

	// Calculate number of buckets
	numBuckets := int(time.Duration(hours) * time.Hour / interval)
	if numBuckets > 1000 {
		numBuckets = 1000 // Cap at 1000 buckets
	}

	timeSeries := make([]TimeSeriesPoint, 0, numBuckets)

	// Create buckets
	for i := 0; i < numBuckets; i++ {
		bucketStart := startTime.Add(time.Duration(i) * interval)
		bucketEnd := bucketStart.Add(interval)

		point := TimeSeriesPoint{
			Timestamp: bucketStart,
			Interval:  interval.String(),
			Data:      make(map[string]ModeBandSummary),
		}

		// For each mode/band combination, count decodes in this bucket
		for _, combo := range combinations {
			key := fmt.Sprintf("%s:%s", combo.Mode, combo.Band)

			// Get events for this mode/band
			count := countDecodesInTimeRange(dm, combo.Mode, combo.Band, bucketStart, bucketEnd)
			uniqueCallsigns := countUniqueCallsignsInTimeRange(dm, combo.Mode, combo.Band, bucketStart, bucketEnd)

			if count > 0 {
				point.Data[key] = ModeBandSummary{
					Mode:            combo.Mode,
					Band:            combo.Band,
					DecodeCount:     count,
					UniqueCallsigns: uniqueCallsigns,
				}
			}
		}

		// Only add point if it has data
		if len(point.Data) > 0 {
			timeSeries = append(timeSeries, point)
		}
	}

	return timeSeries
}

// generateTimeSeriesWithFiles creates time-bucketed decode data using both in-memory and file data
func generateTimeSeriesWithFiles(dm *DigitalDecodeMetrics, combinations []struct{ Mode, Band string }, interval time.Duration, startTime, endTime time.Time, fileSnapshots map[string][]MetricsSnapshot) []TimeSeriesPoint {
	// Calculate number of buckets
	duration := endTime.Sub(startTime)
	numBuckets := int(duration / interval)
	if numBuckets > 1000 {
		numBuckets = 1000 // Cap at 1000 buckets
	}
	if numBuckets < 1 {
		numBuckets = 1
	}

	timeSeries := make([]TimeSeriesPoint, 0, numBuckets)

	// Create buckets
	for i := 0; i < numBuckets; i++ {
		bucketStart := startTime.Add(time.Duration(i) * interval)
		bucketEnd := bucketStart.Add(interval)

		point := TimeSeriesPoint{
			Timestamp: bucketStart,
			Interval:  interval.String(),
			Data:      make(map[string]ModeBandSummary),
		}

		// For each mode/band combination
		for _, combo := range combinations {
			key := fmt.Sprintf("%s:%s", combo.Mode, combo.Band)

			decodeCount := 0
			uniqueCallsigns := 0

			// Prefer file snapshots for historical data (more complete)
			if fileSnapshots != nil {
				snapshots := fileSnapshots[key]
				if len(snapshots) > 0 {
					decodeCount, uniqueCallsigns = estimateCountsFromSnapshots(snapshots, bucketStart, bucketEnd, interval)
				}
			}

			// Only use in-memory data if no file data available (e.g., very recent data not yet written)
			if decodeCount == 0 {
				decodeCount = countDecodesInTimeRange(dm, combo.Mode, combo.Band, bucketStart, bucketEnd)
				uniqueCallsigns = countUniqueCallsignsInTimeRange(dm, combo.Mode, combo.Band, bucketStart, bucketEnd)
			}

			if decodeCount > 0 {
				point.Data[key] = ModeBandSummary{
					Mode:            combo.Mode,
					Band:            combo.Band,
					DecodeCount:     decodeCount,
					UniqueCallsigns: uniqueCallsigns,
				}
			}
		}

		// Only add point if it has data
		if len(point.Data) > 0 {
			timeSeries = append(timeSeries, point)
		}
	}

	return timeSeries
}

// estimateCountsFromSnapshots estimates decode counts for a time bucket from file snapshots
// Uses the difference between snapshots to calculate per-interval counts
func estimateCountsFromSnapshots(snapshots []MetricsSnapshot, bucketStart, bucketEnd time.Time, interval time.Duration) (decodeCount int, uniqueCallsigns int) {
	if len(snapshots) == 0 {
		return 0, 0
	}

	// Find snapshots that bracket this time bucket
	var beforeSnapshot *MetricsSnapshot
	var afterSnapshot *MetricsSnapshot
	var withinSnapshot *MetricsSnapshot

	for i := range snapshots {
		s := &snapshots[i]

		// Find snapshot within the bucket
		if (s.Timestamp.After(bucketStart) || s.Timestamp.Equal(bucketStart)) &&
			(s.Timestamp.Before(bucketEnd) || s.Timestamp.Equal(bucketEnd)) {
			if withinSnapshot == nil || s.Timestamp.After(withinSnapshot.Timestamp) {
				withinSnapshot = s
			}
		}

		// Find snapshot before bucket start (closest to start)
		if s.Timestamp.Before(bucketStart) {
			if beforeSnapshot == nil || s.Timestamp.After(beforeSnapshot.Timestamp) {
				beforeSnapshot = s
			}
		}

		// Find snapshot after bucket end (closest to end)
		if s.Timestamp.After(bucketEnd) {
			if afterSnapshot == nil || s.Timestamp.Before(afterSnapshot.Timestamp) {
				afterSnapshot = s
			}
		}
	}

	// Strategy 1: If we have a snapshot within the bucket, use its activity rate
	if withinSnapshot != nil && withinSnapshot.Activity.DecodesPerHour > 0 {
		bucketHours := interval.Hours()
		decodeCount = int(withinSnapshot.Activity.DecodesPerHour * bucketHours)
		uniqueCallsigns = int(withinSnapshot.Activity.CallsignsPerHour * bucketHours)
		return decodeCount, uniqueCallsigns
	}

	// Strategy 2: If we have before and after snapshots, interpolate
	if beforeSnapshot != nil && afterSnapshot != nil {
		// Calculate the rate of change between the two snapshots
		timeDiff := afterSnapshot.Timestamp.Sub(beforeSnapshot.Timestamp).Seconds()
		if timeDiff > 0 {
			// Use the difference in Last1Hour counts as a proxy for activity
			decodeDiff := afterSnapshot.DecodeCounts.Last1Hour - beforeSnapshot.DecodeCounts.Last1Hour
			callsignDiff := afterSnapshot.UniqueCallsigns.Last1Hour - beforeSnapshot.UniqueCallsigns.Last1Hour

			// Ensure non-negative
			if decodeDiff < 0 {
				decodeDiff = 0
			}
			if callsignDiff < 0 {
				callsignDiff = 0
			}

			// Calculate rate per second and apply to bucket
			bucketSeconds := interval.Seconds()
			decodeRate := float64(decodeDiff) / timeDiff
			callsignRate := float64(callsignDiff) / timeDiff

			decodeCount = int(decodeRate * bucketSeconds)
			uniqueCallsigns = int(callsignRate * bucketSeconds)
			return decodeCount, uniqueCallsigns
		}
	}

	// Strategy 3: Use the closest snapshot's activity rate
	var closestSnapshot *MetricsSnapshot
	if beforeSnapshot != nil {
		closestSnapshot = beforeSnapshot
	}
	if afterSnapshot != nil && (closestSnapshot == nil ||
		afterSnapshot.Timestamp.Sub(bucketStart).Abs() < bucketStart.Sub(closestSnapshot.Timestamp).Abs()) {
		closestSnapshot = afterSnapshot
	}

	if closestSnapshot != nil && closestSnapshot.Activity.DecodesPerHour > 0 {
		bucketHours := interval.Hours()
		decodeCount = int(closestSnapshot.Activity.DecodesPerHour * bucketHours)
		uniqueCallsigns = int(closestSnapshot.Activity.CallsignsPerHour * bucketHours)
		return decodeCount, uniqueCallsigns
	}

	return 0, 0
}

// generateExecutionTimeSeriesWithFiles creates time-bucketed execution time data using both in-memory and file data
func generateExecutionTimeSeriesWithFiles(dm *DigitalDecodeMetrics, combinations []struct{ Mode, Band string }, interval time.Duration, startTime, endTime time.Time, fileSnapshots map[string][]MetricsSnapshot) []ExecutionTimeSeriesPoint {
	// Calculate number of buckets
	duration := endTime.Sub(startTime)
	numBuckets := int(duration / interval)
	if numBuckets > 1000 {
		numBuckets = 1000 // Cap at 1000 buckets
	}
	if numBuckets < 1 {
		numBuckets = 1
	}

	timeSeries := make([]ExecutionTimeSeriesPoint, 0, numBuckets)

	// Create buckets
	for i := 0; i < numBuckets; i++ {
		bucketStart := startTime.Add(time.Duration(i) * interval)
		bucketEnd := bucketStart.Add(interval)

		point := ExecutionTimeSeriesPoint{
			Timestamp: bucketStart,
			Interval:  interval.String(),
			Data:      make(map[string]ExecutionTimeBucketData),
		}

		// For each mode/band combination
		for _, combo := range combinations {
			key := fmt.Sprintf("%s:%s", combo.Mode, combo.Band)

			// First, try to get data from files for this bucket
			var avgTime, minTime, maxTime float64
			count := 0

			if fileSnapshots != nil {
				snapshots := fileSnapshots[key]
				for _, snapshot := range snapshots {
					if snapshot.Timestamp.After(bucketStart) && snapshot.Timestamp.Before(bucketEnd) {
						avgTime = snapshot.ExecutionTime.Last1Min.Avg
						minTime = snapshot.ExecutionTime.Last1Min.Min
						maxTime = snapshot.ExecutionTime.Last1Min.Max
						count = 1
						break // Use first matching snapshot
					}
				}
			}

			// If no file data, try in-memory data
			if count == 0 {
				avgTime, minTime, maxTime, count = getExecutionTimeStatsInRange(dm, combo.Mode, combo.Band, bucketStart, bucketEnd)
			}

			if count > 0 {
				point.Data[key] = ExecutionTimeBucketData{
					Mode:        combo.Mode,
					Band:        combo.Band,
					AvgSeconds:  avgTime,
					MinSeconds:  minTime,
					MaxSeconds:  maxTime,
					SampleCount: count,
				}
			}
		}

		// Only add point if it has data
		if len(point.Data) > 0 {
			timeSeries = append(timeSeries, point)
		}
	}

	return timeSeries
}

// countDecodesInTimeRange counts decodes in a specific time range
func countDecodesInTimeRange(dm *DigitalDecodeMetrics, mode, band string, start, end time.Time) int {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if dm.decodesByModeBand[mode] == nil || dm.decodesByModeBand[mode][band] == nil {
		return 0
	}

	ts := dm.decodesByModeBand[mode][band]
	ts.mu.RLock()
	defer ts.mu.RUnlock()

	count := 0
	for _, event := range ts.events {
		if event.Timestamp.After(start) && event.Timestamp.Before(end) {
			count++
		}
	}

	return count
}

// generateExecutionTimeSeries creates time-bucketed execution time data
func generateExecutionTimeSeries(dm *DigitalDecodeMetrics, combinations []struct{ Mode, Band string }, interval time.Duration, hours int) []ExecutionTimeSeriesPoint {
	now := time.Now()
	startTime := now.Add(-time.Duration(hours) * time.Hour)

	// Calculate number of buckets
	numBuckets := int(time.Duration(hours) * time.Hour / interval)
	if numBuckets > 1000 {
		numBuckets = 1000 // Cap at 1000 buckets
	}

	timeSeries := make([]ExecutionTimeSeriesPoint, 0, numBuckets)

	// Create buckets
	for i := 0; i < numBuckets; i++ {
		bucketStart := startTime.Add(time.Duration(i) * interval)
		bucketEnd := bucketStart.Add(interval)

		point := ExecutionTimeSeriesPoint{
			Timestamp: bucketStart,
			Interval:  interval.String(),
			Data:      make(map[string]ExecutionTimeBucketData),
		}

		// For each mode/band combination, get execution time stats in this bucket
		for _, combo := range combinations {
			key := fmt.Sprintf("%s:%s", combo.Mode, combo.Band)

			avg, min, max, count := getExecutionTimeStatsInRange(dm, combo.Mode, combo.Band, bucketStart, bucketEnd)

			if count > 0 {
				point.Data[key] = ExecutionTimeBucketData{
					Mode:        combo.Mode,
					Band:        combo.Band,
					AvgSeconds:  avg,
					MinSeconds:  min,
					MaxSeconds:  max,
					SampleCount: count,
				}
			}
		}

		// Only add point if it has data
		if len(point.Data) > 0 {
			timeSeries = append(timeSeries, point)
		}
	}

	return timeSeries
}

// getExecutionTimeStatsInRange gets execution time statistics for a time range
func getExecutionTimeStatsInRange(dm *DigitalDecodeMetrics, mode, band string, start, end time.Time) (avgTime, minTime, maxTime float64, count int) {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if dm.executionTimes[mode] == nil || dm.executionTimes[mode][band] == nil {
		return 0, 0, 0, 0
	}

	var totalDuration time.Duration
	var minDuration time.Duration
	var maxDuration time.Duration
	count = 0

	for _, e := range dm.executionTimes[mode][band] {
		if e.Timestamp.After(start) && e.Timestamp.Before(end) {
			totalDuration += e.Duration
			count++

			if count == 1 {
				minDuration = e.Duration
				maxDuration = e.Duration
			} else {
				if e.Duration < minDuration {
					minDuration = e.Duration
				}
				if e.Duration > maxDuration {
					maxDuration = e.Duration
				}
			}
		}
	}

	if count == 0 {
		return 0, 0, 0, 0
	}

	// Return all values in seconds
	return totalDuration.Seconds() / float64(count), minDuration.Seconds(), maxDuration.Seconds(), count
}

// countUniqueCallsignsInTimeRange counts unique callsigns in a specific time range
func countUniqueCallsignsInTimeRange(dm *DigitalDecodeMetrics, mode, band string, start, end time.Time) int {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if dm.decodesByModeBand[mode] == nil || dm.decodesByModeBand[mode][band] == nil {
		return 0
	}

	ts := dm.decodesByModeBand[mode][band]
	ts.mu.RLock()
	defer ts.mu.RUnlock()

	callsigns := make(map[string]bool)
	for _, event := range ts.events {
		if event.Timestamp.After(start) && event.Timestamp.Before(end) {
			callsigns[event.Callsign] = true
		}
	}

	return len(callsigns)
}

// getTopCallsigns retrieves top callsigns from spots logger
func getTopCallsigns(logger *SpotsLogger, mode, band string, hours, limit int) []CallsignStats {
	// This would require accessing the spots logger's data
	// For now, return empty slice as spots logger doesn't have this aggregation built-in
	// This could be enhanced by adding a method to DecoderSpotsLogger
	return []CallsignStats{}
}

// parseTimeParam parses a time parameter that can be either RFC3339 format or Unix timestamp
func parseTimeParam(param string) (time.Time, error) {
	// Try parsing as RFC3339 first
	if t, err := time.Parse(time.RFC3339, param); err == nil {
		return t, nil
	}

	// Try parsing as Unix timestamp (seconds)
	if timestamp, err := strconv.ParseInt(param, 10, 64); err == nil {
		return time.Unix(timestamp, 0), nil
	}

	// Try parsing as ISO 8601 without timezone
	if t, err := time.Parse("2006-01-02T15:04:05", param); err == nil {
		return t, nil
	}

	// Try parsing as date only (YYYY-MM-DD)
	if t, err := time.Parse("2006-01-02", param); err == nil {
		return t, nil
	}

	return time.Time{}, fmt.Errorf("invalid time format, expected RFC3339, Unix timestamp, or YYYY-MM-DD")
}

// handleDecoderBandNames returns the list of configured decoder band names (public endpoint)
func handleDecoderBandNames(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.config == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder configuration is not available",
		})
		return
	}

	// Extract band names from decoder configuration
	bandNames := make([]string, 0)
	for _, band := range md.config.Bands {
		if band.Enabled {
			bandNames = append(bandNames, band.Name)
		}
	}

	response := map[string]interface{}{
		"band_names": bandNames,
		"count":      len(bandNames),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding decoder band names: %v", err)
	}
}
