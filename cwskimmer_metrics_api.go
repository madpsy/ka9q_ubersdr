package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"
)

// CWMetricsResponse contains comprehensive CW spot metrics
type CWMetricsResponse struct {
	Summary struct {
		TotalBands int `json:"total_bands"`
		TimeWindow struct {
			Hours int       `json:"hours"`
			Start time.Time `json:"start"`
			End   time.Time `json:"end"`
		} `json:"time_window"`
	} `json:"summary"`
	Metrics       []CWBandMetrics        `json:"metrics"`
	TimeSeries    []CWTimeSeriesPoint    `json:"time_series,omitempty"`
	WPMTimeSeries []CWWPMTimeSeriesPoint `json:"wpm_time_series,omitempty"`
}

// CWBandMetrics contains all metrics for a specific band
type CWBandMetrics struct {
	Band string `json:"band"`

	SpotCounts struct {
		Last1Hour   int64 `json:"last_1h"`
		Last3Hours  int64 `json:"last_3h"`
		Last6Hours  int64 `json:"last_6h"`
		Last12Hours int64 `json:"last_12h"`
		Last24Hours int64 `json:"last_24h"`
	} `json:"spot_counts"`

	UniqueCallsigns struct {
		Last1Hour   int `json:"last_1h"`
		Last3Hours  int `json:"last_3h"`
		Last6Hours  int `json:"last_6h"`
		Last12Hours int `json:"last_12h"`
		Last24Hours int `json:"last_24h"`
	} `json:"unique_callsigns"`

	WPMStats struct {
		Last1Min struct {
			Avg float64 `json:"avg_wpm"`
			Min int     `json:"min_wpm"`
			Max int     `json:"max_wpm"`
		} `json:"last_1m"`
		Last5Min struct {
			Avg float64 `json:"avg_wpm"`
			Min int     `json:"min_wpm"`
			Max int     `json:"max_wpm"`
		} `json:"last_5m"`
		Last10Min struct {
			Avg float64 `json:"avg_wpm"`
			Min int     `json:"min_wpm"`
			Max int     `json:"max_wpm"`
		} `json:"last_10m"`
	} `json:"wpm_stats"`

	Activity struct {
		SpotsPerHour     float64 `json:"spots_per_hour"`
		CallsignsPerHour float64 `json:"callsigns_per_hour"`
		ActivityScore    float64 `json:"activity_score"`
	} `json:"activity"`
}

// CWTimeSeriesPoint represents a single point in time series data
type CWTimeSeriesPoint struct {
	Timestamp time.Time                `json:"timestamp"`
	Interval  string                   `json:"interval"`
	Data      map[string]CWBandSummary `json:"data"` // key: band
}

// CWBandSummary contains summary data for a time bucket
type CWBandSummary struct {
	Band            string  `json:"band"`
	SpotCount       int     `json:"spot_count"`
	UniqueCallsigns int     `json:"unique_callsigns"`
	AvgWPM          float64 `json:"avg_wpm,omitempty"`
}

// CWWPMTimeSeriesPoint represents WPM data over time
type CWWPMTimeSeriesPoint struct {
	Timestamp time.Time                  `json:"timestamp"`
	Interval  string                     `json:"interval"`
	Data      map[string]CWWPMBucketData `json:"data"` // key: band
}

// CWWPMBucketData contains WPM stats for a time bucket
type CWWPMBucketData struct {
	Band        string  `json:"band"`
	AvgWPM      float64 `json:"avg_wpm"`
	MinWPM      int     `json:"min_wpm"`
	MaxWPM      int     `json:"max_wpm"`
	SampleCount int     `json:"sample_count"`
}

// handleCWMetrics serves comprehensive CW spot metrics
func handleCWMetrics(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.metrics == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW Skimmer metrics are not available",
		})
		return
	}

	// Get query parameters
	band := r.URL.Query().Get("band")
	hoursStr := r.URL.Query().Get("hours")
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	includeTimeSeries := r.URL.Query().Get("timeseries") == "true"
	intervalStr := r.URL.Query().Get("interval")

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
		// Fall back to hours parameter (default 24, max 168 = 7 days)
		hours := 24
		if hoursStr != "" {
			if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 168 {
				hours = h
			}
		}
		endTime = now
		startTime = now.Add(-time.Duration(hours) * time.Hour)
	}

	// Calculate hours for backward compatibility
	hours := int(endTime.Sub(startTime).Hours())

	// Parse interval (default 15m)
	interval := 15 * time.Minute
	if intervalStr != "" {
		if d, err := time.ParseDuration(intervalStr); err == nil && d > 0 {
			interval = d
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-metrics-%s-%d", band, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("CW metrics endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Build response
	response := CWMetricsResponse{}

	response.Summary.TimeWindow.Hours = hours
	response.Summary.TimeWindow.Start = startTime
	response.Summary.TimeWindow.End = endTime

	// Always try to read from files if metrics logging is enabled
	// This ensures we have data even after restarts or for time ranges with sparse in-memory data
	// ReadMetricsFromFiles will return nil if logging is not enabled
	log.Printf("Reading CW metrics from files for time range: %v to %v", startTime, endTime)
	fileSnapshots, err := cwSkimmer.metrics.ReadMetricsFromFiles(startTime, endTime)
	if err != nil {
		log.Printf("Warning: error reading CW metrics from files: %v", err)
	} else if fileSnapshots != nil {
		log.Printf("Loaded %d bands from CW metrics files", len(fileSnapshots))
		for band, snapshots := range fileSnapshots {
			log.Printf("  Band %s: %d snapshots", band, len(snapshots))
			if len(snapshots) > 0 {
				log.Printf("    First snapshot: %v (Last24h: %d)", snapshots[0].Timestamp.Format("2006-01-02 15:04:05"), snapshots[0].SpotCounts.Last24Hour)
				log.Printf("    Last snapshot: %v (Last24h: %d)", snapshots[len(snapshots)-1].Timestamp.Format("2006-01-02 15:04:05"), snapshots[len(snapshots)-1].SpotCounts.Last24Hour)
			}
		}
	} else {
		log.Printf("fileSnapshots is nil - metrics logging may not be enabled")
	}

	// Get all bands from in-memory data
	bands := cwSkimmer.metrics.GetAllBands()
	log.Printf("Found %d bands in memory", len(bands))

	// Also add bands from file snapshots if available
	if fileSnapshots != nil {
		addedFromFiles := 0
		for fileBand := range fileSnapshots {
			// Apply filter here - only add if it matches the requested band
			if band == "" || fileBand == band {
				// Check if this band already exists
				exists := false
				for _, b := range bands {
					if b == fileBand {
						exists = true
						break
					}
				}
				if !exists {
					bands = append(bands, fileBand)
					addedFromFiles++
				}
			}
		}
		log.Printf("Added %d bands from files (total now: %d)", addedFromFiles, len(bands))
	}

	// Filter bands if specific band requested
	if band != "" {
		// Filter to specific band
		found := false
		for _, b := range bands {
			if b == band {
				bands = []string{band}
				found = true
				break
			}
		}
		if !found {
			bands = []string{}
		}
	}

	response.Summary.TotalBands = len(bands)

	// Collect metrics for each band
	response.Metrics = make([]CWBandMetrics, 0, len(bands))

	for _, b := range bands {
		metrics := CWBandMetrics{
			Band: b,
		}

		// Try to get data from file snapshots first for historical data
		usedFileData := false

		if fileSnapshots != nil {
			if snapshots, exists := fileSnapshots[b]; exists && len(snapshots) > 0 {
				// Find the snapshot with the HIGHEST 24-hour count
				// This ensures we get the best historical data, even after a restart
				// when recent snapshots have low counts
				var bestSnapshot *CWMetricsSnapshot
				maxCount := int64(0)

				for i := range snapshots {
					s := &snapshots[i]
					if s.SpotCounts.Last24Hour > maxCount {
						maxCount = s.SpotCounts.Last24Hour
						bestSnapshot = s
					}
				}

				if bestSnapshot != nil {
					// Use the snapshot's accumulated counts directly
					// These represent the state at that point in time
					metrics.SpotCounts.Last1Hour = bestSnapshot.SpotCounts.Last1Hour
					metrics.SpotCounts.Last24Hours = bestSnapshot.SpotCounts.Last24Hour
					// Estimate intermediate values (snapshots only store 1h and 24h)
					metrics.SpotCounts.Last3Hours = bestSnapshot.SpotCounts.Last24Hour
					metrics.SpotCounts.Last6Hours = bestSnapshot.SpotCounts.Last24Hour
					metrics.SpotCounts.Last12Hours = bestSnapshot.SpotCounts.Last24Hour

					metrics.UniqueCallsigns.Last1Hour = bestSnapshot.UniqueCallsigns.Last1Hour
					metrics.UniqueCallsigns.Last24Hours = bestSnapshot.UniqueCallsigns.Last24Hour
					// Estimate intermediate values
					metrics.UniqueCallsigns.Last3Hours = bestSnapshot.UniqueCallsigns.Last24Hour
					metrics.UniqueCallsigns.Last6Hours = bestSnapshot.UniqueCallsigns.Last24Hour
					metrics.UniqueCallsigns.Last12Hours = bestSnapshot.UniqueCallsigns.Last24Hour

					// WPM stats from best snapshot
					metrics.WPMStats.Last1Min.Avg = bestSnapshot.WPMStats.Last1Min.AvgWPM
					metrics.WPMStats.Last1Min.Min = bestSnapshot.WPMStats.Last1Min.MinWPM
					metrics.WPMStats.Last1Min.Max = bestSnapshot.WPMStats.Last1Min.MaxWPM

					metrics.WPMStats.Last5Min.Avg = bestSnapshot.WPMStats.Last5Min.AvgWPM
					metrics.WPMStats.Last5Min.Min = bestSnapshot.WPMStats.Last5Min.MinWPM
					metrics.WPMStats.Last5Min.Max = bestSnapshot.WPMStats.Last5Min.MaxWPM

					metrics.WPMStats.Last10Min.Avg = bestSnapshot.WPMStats.Last10Min.AvgWPM
					metrics.WPMStats.Last10Min.Min = bestSnapshot.WPMStats.Last10Min.MinWPM
					metrics.WPMStats.Last10Min.Max = bestSnapshot.WPMStats.Last10Min.MaxWPM

					usedFileData = true
					log.Printf("Using best file snapshot from %v for %s - Last24h: %d spots, %d callsigns (from %d total snapshots)",
						bestSnapshot.Timestamp.Format("2006-01-02 15:04:05"), b,
						metrics.SpotCounts.Last24Hours, metrics.UniqueCallsigns.Last24Hours, len(snapshots))
				}
			}
		}

		// Only use in-memory data if no file data was available
		if !usedFileData {
			// Spot counts
			metrics.SpotCounts.Last1Hour = cwSkimmer.metrics.GetTotalSpots(b, 1)
			metrics.SpotCounts.Last3Hours = cwSkimmer.metrics.GetTotalSpots(b, 3)
			metrics.SpotCounts.Last6Hours = cwSkimmer.metrics.GetTotalSpots(b, 6)
			metrics.SpotCounts.Last12Hours = cwSkimmer.metrics.GetTotalSpots(b, 12)
			metrics.SpotCounts.Last24Hours = cwSkimmer.metrics.GetTotalSpots(b, 24)

			// Unique callsigns
			metrics.UniqueCallsigns.Last1Hour = cwSkimmer.metrics.GetUniqueCallsigns(b, 1)
			metrics.UniqueCallsigns.Last3Hours = cwSkimmer.metrics.GetUniqueCallsigns(b, 3)
			metrics.UniqueCallsigns.Last6Hours = cwSkimmer.metrics.GetUniqueCallsigns(b, 6)
			metrics.UniqueCallsigns.Last12Hours = cwSkimmer.metrics.GetUniqueCallsigns(b, 12)
			metrics.UniqueCallsigns.Last24Hours = cwSkimmer.metrics.GetUniqueCallsigns(b, 24)

			// WPM stats
			avg1m, min1m, max1m := cwSkimmer.metrics.GetWPMStats(b, 1)
			metrics.WPMStats.Last1Min.Avg = avg1m
			metrics.WPMStats.Last1Min.Min = min1m
			metrics.WPMStats.Last1Min.Max = max1m

			avg5m, min5m, max5m := cwSkimmer.metrics.GetWPMStats(b, 5)
			metrics.WPMStats.Last5Min.Avg = avg5m
			metrics.WPMStats.Last5Min.Min = min5m
			metrics.WPMStats.Last5Min.Max = max5m

			avg10m, min10m, max10m := cwSkimmer.metrics.GetWPMStats(b, 10)
			metrics.WPMStats.Last10Min.Avg = avg10m
			metrics.WPMStats.Last10Min.Min = min10m
			metrics.WPMStats.Last10Min.Max = max10m
		}

		// Activity metrics (calculate from whatever data we have)
		if metrics.SpotCounts.Last24Hours > 0 {
			metrics.Activity.SpotsPerHour = float64(metrics.SpotCounts.Last24Hours) / 24.0
			metrics.Activity.CallsignsPerHour = float64(metrics.UniqueCallsigns.Last24Hours) / 24.0
			metrics.Activity.ActivityScore = (metrics.Activity.SpotsPerHour / 100.0) * 100.0
			if metrics.Activity.ActivityScore > 100 {
				metrics.Activity.ActivityScore = 100
			}
		}

		response.Metrics = append(response.Metrics, metrics)
	}

	// Generate time series if requested
	if includeTimeSeries {
		response.TimeSeries = generateCWTimeSeriesWithFiles(cwSkimmer.metrics, bands, interval, startTime, endTime, fileSnapshots)
		response.WPMTimeSeries = generateCWWPMTimeSeriesWithFiles(cwSkimmer.metrics, bands, interval, startTime, endTime, fileSnapshots)
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding CW metrics: %v", err)
	}
}

// generateCWTimeSeriesWithFiles creates time-bucketed spot data using both in-memory and file data
func generateCWTimeSeriesWithFiles(cm *CWSkimmerMetrics, bands []string, interval time.Duration, startTime, endTime time.Time, fileSnapshots map[string][]CWMetricsSnapshot) []CWTimeSeriesPoint {
	duration := endTime.Sub(startTime)
	numBuckets := int(duration / interval)
	if numBuckets > 1000 {
		numBuckets = 1000
	}
	if numBuckets < 1 {
		numBuckets = 1
	}

	timeSeries := make([]CWTimeSeriesPoint, 0, numBuckets)

	for i := 0; i < numBuckets; i++ {
		bucketStart := startTime.Add(time.Duration(i) * interval)
		bucketEnd := bucketStart.Add(interval)

		point := CWTimeSeriesPoint{
			Timestamp: bucketStart,
			Interval:  interval.String(),
			Data:      make(map[string]CWBandSummary),
		}

		for _, band := range bands {
			spotCount := 0
			uniqueCallsigns := 0
			avgWPM := 0.0

			// Prefer file snapshots for historical data (more complete)
			if fileSnapshots != nil {
				snapshots := fileSnapshots[band]
				if len(snapshots) > 0 {
					spotCount, uniqueCallsigns = estimateCWCountsFromSnapshots(snapshots, bucketStart, bucketEnd, interval)
				}
			}

			// Only use in-memory data if no file data available (e.g., very recent data not yet written)
			if spotCount == 0 {
				spotCount, uniqueCallsigns, avgWPM = countCWSpotsInTimeRange(cm, band, bucketStart, bucketEnd)
			}

			if spotCount > 0 {
				point.Data[band] = CWBandSummary{
					Band:            band,
					SpotCount:       spotCount,
					UniqueCallsigns: uniqueCallsigns,
					AvgWPM:          avgWPM,
				}
			}
		}

		if len(point.Data) > 0 {
			timeSeries = append(timeSeries, point)
		}
	}

	return timeSeries
}

// estimateCWCountsFromSnapshots estimates spot counts for a time bucket from file snapshots
// Uses the difference between snapshots to calculate per-interval counts
func estimateCWCountsFromSnapshots(snapshots []CWMetricsSnapshot, bucketStart, bucketEnd time.Time, interval time.Duration) (spotCount int, uniqueCallsigns int) {
	if len(snapshots) == 0 {
		return 0, 0
	}

	// Find snapshots that bracket this time bucket
	var beforeSnapshot *CWMetricsSnapshot
	var afterSnapshot *CWMetricsSnapshot
	var withinSnapshot *CWMetricsSnapshot

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
	if withinSnapshot != nil && withinSnapshot.Activity.SpotsPerHour > 0 {
		bucketHours := interval.Hours()
		spotCount = int(withinSnapshot.Activity.SpotsPerHour * bucketHours)
		uniqueCallsigns = int(withinSnapshot.Activity.CallsignsPerHour * bucketHours)
		return spotCount, uniqueCallsigns
	}

	// Strategy 2: If we have before and after snapshots, interpolate
	if beforeSnapshot != nil && afterSnapshot != nil {
		// Calculate the rate of change between the two snapshots
		timeDiff := afterSnapshot.Timestamp.Sub(beforeSnapshot.Timestamp).Seconds()
		if timeDiff > 0 {
			// Use the difference in Last1Hour counts as a proxy for activity
			spotDiff := afterSnapshot.SpotCounts.Last1Hour - beforeSnapshot.SpotCounts.Last1Hour
			callsignDiff := int64(afterSnapshot.UniqueCallsigns.Last1Hour - beforeSnapshot.UniqueCallsigns.Last1Hour)

			// Ensure non-negative
			if spotDiff < 0 {
				spotDiff = 0
			}
			if callsignDiff < 0 {
				callsignDiff = 0
			}

			// Calculate rate per second and apply to bucket
			bucketSeconds := interval.Seconds()
			spotRate := float64(spotDiff) / timeDiff
			callsignRate := float64(callsignDiff) / timeDiff

			spotCount = int(spotRate * bucketSeconds)
			uniqueCallsigns = int(callsignRate * bucketSeconds)
			return spotCount, uniqueCallsigns
		}
	}

	// Strategy 3: Use the closest snapshot's activity rate
	var closestSnapshot *CWMetricsSnapshot
	if beforeSnapshot != nil {
		closestSnapshot = beforeSnapshot
	}
	if afterSnapshot != nil && (closestSnapshot == nil ||
		afterSnapshot.Timestamp.Sub(bucketStart).Abs() < bucketStart.Sub(closestSnapshot.Timestamp).Abs()) {
		closestSnapshot = afterSnapshot
	}

	if closestSnapshot != nil && closestSnapshot.Activity.SpotsPerHour > 0 {
		bucketHours := interval.Hours()
		spotCount = int(closestSnapshot.Activity.SpotsPerHour * bucketHours)
		uniqueCallsigns = int(closestSnapshot.Activity.CallsignsPerHour * bucketHours)
		return spotCount, uniqueCallsigns
	}

	return 0, 0
}

// generateCWWPMTimeSeriesWithFiles creates time-bucketed WPM data using both in-memory and file data
func generateCWWPMTimeSeriesWithFiles(cm *CWSkimmerMetrics, bands []string, interval time.Duration, startTime, endTime time.Time, fileSnapshots map[string][]CWMetricsSnapshot) []CWWPMTimeSeriesPoint {
	duration := endTime.Sub(startTime)
	numBuckets := int(duration / interval)
	if numBuckets > 1000 {
		numBuckets = 1000
	}
	if numBuckets < 1 {
		numBuckets = 1
	}

	timeSeries := make([]CWWPMTimeSeriesPoint, 0, numBuckets)

	for i := 0; i < numBuckets; i++ {
		bucketStart := startTime.Add(time.Duration(i) * interval)
		bucketEnd := bucketStart.Add(interval)

		point := CWWPMTimeSeriesPoint{
			Timestamp: bucketStart,
			Interval:  interval.String(),
			Data:      make(map[string]CWWPMBucketData),
		}

		for _, band := range bands {
			var avgWPM, minWPM, maxWPM float64
			var count int

			// First, try to get data from files for this bucket
			if fileSnapshots != nil {
				snapshots := fileSnapshots[band]
				for _, snapshot := range snapshots {
					if (snapshot.Timestamp.After(bucketStart) || snapshot.Timestamp.Equal(bucketStart)) &&
						(snapshot.Timestamp.Before(bucketEnd) || snapshot.Timestamp.Equal(bucketEnd)) {
						avgWPM = snapshot.WPMStats.Last1Min.AvgWPM
						minWPM = float64(snapshot.WPMStats.Last1Min.MinWPM)
						maxWPM = float64(snapshot.WPMStats.Last1Min.MaxWPM)
						count = 1
						break // Use first matching snapshot
					}
				}
			}

			// If no file data, try in-memory data
			if count == 0 {
				var minWPMInt, maxWPMInt int
				avgWPM, minWPMInt, maxWPMInt, count = getCWWPMStatsInRange(cm, band, bucketStart, bucketEnd)
				minWPM = float64(minWPMInt)
				maxWPM = float64(maxWPMInt)
			}

			if count > 0 {
				point.Data[band] = CWWPMBucketData{
					Band:        band,
					AvgWPM:      avgWPM,
					MinWPM:      int(minWPM),
					MaxWPM:      int(maxWPM),
					SampleCount: count,
				}
			}
		}

		if len(point.Data) > 0 {
			timeSeries = append(timeSeries, point)
		}
	}

	return timeSeries
}

// countCWSpotsInTimeRange counts spots in a specific time range
func countCWSpotsInTimeRange(cm *CWSkimmerMetrics, band string, start, end time.Time) (spotCount int, uniqueCallsigns int, avgWPM float64) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if cm.spotsByBand[band] == nil {
		return 0, 0, 0
	}

	ts := cm.spotsByBand[band]
	ts.mu.RLock()
	defer ts.mu.RUnlock()

	callsigns := make(map[string]bool)
	totalWPM := 0
	wpmCount := 0

	for _, event := range ts.events {
		if (event.Timestamp.After(start) || event.Timestamp.Equal(start)) &&
			(event.Timestamp.Before(end) || event.Timestamp.Equal(end)) {
			spotCount++
			callsigns[event.Callsign] = true
			if event.WPM > 0 {
				totalWPM += event.WPM
				wpmCount++
			}
		}
	}

	uniqueCallsigns = len(callsigns)
	if wpmCount > 0 {
		avgWPM = float64(totalWPM) / float64(wpmCount)
	}

	return spotCount, uniqueCallsigns, avgWPM
}

// getCWWPMStatsInRange gets WPM statistics for a time range
func getCWWPMStatsInRange(cm *CWSkimmerMetrics, band string, start, end time.Time) (avgWPM float64, minWPM, maxWPM, count int) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if cm.wpmMeasurements[band] == nil {
		return 0, 0, 0, 0
	}

	totalWPM := 0
	count = 0
	minWPM = 0
	maxWPM = 0

	for _, e := range cm.wpmMeasurements[band] {
		if (e.Timestamp.After(start) || e.Timestamp.Equal(start)) &&
			(e.Timestamp.Before(end) || e.Timestamp.Equal(end)) {
			totalWPM += e.WPM
			count++

			if count == 1 {
				minWPM = e.WPM
				maxWPM = e.WPM
			} else {
				if e.WPM < minWPM {
					minWPM = e.WPM
				}
				if e.WPM > maxWPM {
					maxWPM = e.WPM
				}
			}
		}
	}

	if count == 0 {
		return 0, 0, 0, 0
	}

	avgWPM = float64(totalWPM) / float64(count)
	return avgWPM, minWPM, maxWPM, count
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
