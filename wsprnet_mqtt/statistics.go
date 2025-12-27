package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"sync"
	"time"
)

// InstanceStats tracks statistics for a single UberSDR instance
type InstanceStats struct {
	Name            string                        `json:"Name"`
	TotalSpots      int                           `json:"TotalSpots"`
	UniqueSpots     int                           `json:"UniqueSpots"` // Spots only this instance reported
	BestSNRWins     int                           `json:"BestSNRWins"` // Times this instance had the best SNR
	TiedSNR         int                           `json:"TiedSNR"`     // Times this instance tied for best SNR
	BandStats       map[string]*BandInstanceStats `json:"BandStats"`
	LastReportTime  time.Time                     `json:"LastReportTime"`
	LastWindowTime  time.Time                     `json:"LastWindowTime"`
	RecentCallsigns []string                      `json:"RecentCallsigns"` // Last 10 callsigns reported
}

// BandInstanceStats tracks per-band statistics for an instance
type BandInstanceStats struct {
	TotalSpots      int     `json:"TotalSpots"`
	UniqueSpots     int     `json:"UniqueSpots"`
	BestSNRWins     int     `json:"BestSNRWins"`
	TiedSNR         int     `json:"TiedSNR"`
	AverageSNR      float64 `json:"AverageSNR"`
	TotalSNR        int     `json:"TotalSNR"`
	SNRCount        int     `json:"SNRCount"`
	MinDistance     float64 `json:"MinDistance"`     // km
	MaxDistance     float64 `json:"MaxDistance"`     // km
	TotalDistance   float64 `json:"TotalDistance"`   // km
	DistanceCount   int     `json:"DistanceCount"`   // number of spots with valid distance
	AverageDistance float64 `json:"AverageDistance"` // km
}

// CountryStats tracks statistics for a country on a specific band
type CountryStats struct {
	Country         string
	Band            string
	UniqueCallsigns map[string]bool
	MinSNR          int
	MaxSNR          int
	TotalSNR        int
	Count           int
}

// SpotLocation represents a spot with location info for mapping
type SpotLocation struct {
	Callsign string   `json:"callsign"`
	Locator  string   `json:"locator"`
	Bands    []string `json:"bands"`
	SNR      []int    `json:"snr"` // SNR values corresponding to each band
	Country  string   `json:"country"`
}

// WindowStats tracks statistics for a single submission window
type WindowStats struct {
	WindowTime        time.Time
	TotalSpots        int
	DuplicateCount    int
	UniqueByInstance  map[string][]string // instance -> callsigns unique to that instance
	BestSNRByInstance map[string]int      // instance -> count of best SNR wins
	TiedSNRByInstance map[string]int      // instance -> count of tied SNR
	BandBreakdown     map[string]int      // band -> spot count
	SubmittedAt       time.Time
}

// PersistenceData contains all statistics data for saving/loading
type PersistenceData struct {
	SavedAt      time.Time                               `json:"saved_at"`
	Windows      []*WindowStats                          `json:"windows"`
	Instances    map[string]*InstanceStats               `json:"instances"`
	CountryStats map[string]*CountryStatsExport          `json:"country_stats"`
	MapSpots     map[string]*SpotLocation                `json:"map_spots"`
	SNRHistory   map[string]map[string][]SNRHistoryPoint `json:"snr_history"`
	TotalStats   OverallStats                            `json:"total_stats"`
	WSPRNetStats WSPRNetStats                            `json:"wsprnet_stats"`
}

// WSPRNetStats contains WSPRNet submission statistics
type WSPRNetStats struct {
	Successful int `json:"successful"`
	Failed     int `json:"failed"`
	Retries    int `json:"retries"`
}

// CountryStatsExport is a serializable version of CountryStats
type CountryStatsExport struct {
	Country         string   `json:"country"`
	Band            string   `json:"band"`
	UniqueCallsigns []string `json:"unique_callsigns"`
	MinSNR          int      `json:"min_snr"`
	MaxSNR          int      `json:"max_snr"`
	TotalSNR        int      `json:"total_snr"`
	Count           int      `json:"count"`
}

// OverallStats contains overall statistics
type OverallStats struct {
	TotalSubmitted  int `json:"total_submitted"`
	TotalDuplicates int `json:"total_duplicates"`
	TotalUnique     int `json:"total_unique"`
}

// SNRHistoryPoint represents average SNR for an instance on a band at a specific time
type SNRHistoryPoint struct {
	WindowTime      time.Time `json:"window_time"`
	AverageSNR      float64   `json:"average_snr"`
	SpotCount       int       `json:"spot_count"`
	AverageDistance float64   `json:"average_distance"` // Average distance in km for this window
	DistanceCount   int       `json:"distance_count"`   // Number of spots with valid distance
}

// BandSNRHistory tracks SNR history for all instances on a specific band
type BandSNRHistory struct {
	Band      string                       `json:"band"`
	Instances map[string][]SNRHistoryPoint `json:"instances"` // instance name -> history points
}

// StatisticsTracker tracks aggregator statistics
type StatisticsTracker struct {
	// Per-instance statistics
	instances   map[string]*InstanceStats
	instancesMu sync.RWMutex

	// Country statistics per band
	// Key: "band_country" (e.g., "40m_United States")
	countryStats   map[string]*CountryStats
	countryStatsMu sync.RWMutex

	// Spots for mapping from last 24 hours (callsign -> spot info)
	// This is updated from recent windows, not just current window
	mapSpots   map[string]*SpotLocation
	mapSpotsMu sync.RWMutex

	// Recent windows (keep last 720 for 24 hours of history)
	recentWindows   []*WindowStats
	recentWindowsMu sync.RWMutex

	// Current window being built
	currentWindow   *WindowStats
	currentWindowMu sync.Mutex

	// SNR history per band per instance (keep last 720 windows = 24 hours)
	// Key: band name -> instance name -> history points
	snrHistory   map[string]map[string][]SNRHistoryPoint
	snrHistoryMu sync.RWMutex

	// Current window SNR and distance accumulation for history
	// Key: "band_instance" -> {totalSNR, count, totalDistance, distanceCount}
	currentWindowSNR map[string]*struct {
		totalSNR, count, totalDistance int
		distanceCount                  int
	}
	currentWindowSNRMu sync.Mutex

	// Overall statistics
	totalSubmitted  int
	totalDuplicates int
	totalUnique     int
	statsMu         sync.RWMutex

	// Receiver location for distance calculations
	receiverLat float64
	receiverLon float64
}

// haversineDistance calculates the great circle distance between two points
// on the earth (specified in decimal degrees). Returns distance in kilometers.
func haversineDistance(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadius = 6371.0 // Earth's radius in kilometers

	// Convert to radians
	lat1Rad := lat1 * math.Pi / 180
	lat2Rad := lat2 * math.Pi / 180
	deltaLat := (lat2 - lat1) * math.Pi / 180
	deltaLon := (lon2 - lon1) * math.Pi / 180

	// Haversine formula
	a := math.Sin(deltaLat/2)*math.Sin(deltaLat/2) +
		math.Cos(lat1Rad)*math.Cos(lat2Rad)*
			math.Sin(deltaLon/2)*math.Sin(deltaLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))

	return earthRadius * c
}

// maidenheadToLatLon converts a Maidenhead locator to latitude/longitude
// Returns lat, lon in decimal degrees, or 0, 0 if invalid
func maidenheadToLatLon(locator string) (float64, float64) {
	if len(locator) < 4 {
		return 0, 0
	}

	locator = string([]byte{
		locator[0] | 0x20, // to lowercase
		locator[1] | 0x20,
		locator[2],
		locator[3],
	})

	// Field (first 2 chars): 20° longitude, 10° latitude
	lon1 := float64(locator[0]-'a') * 20.0
	lat1 := float64(locator[1]-'a') * 10.0

	// Square (next 2 chars): 2° longitude, 1° latitude
	lon2 := float64(locator[2]-'0') * 2.0
	lat2 := float64(locator[3]-'0') * 1.0

	lon := lon1 + lon2 - 180.0
	lat := lat1 + lat2 - 90.0

	// Subsquare (optional 2 chars): 5' (2/24°) longitude, 2.5' (1/24°) latitude
	if len(locator) >= 6 {
		lon3 := float64(locator[4]|0x20-'a') * (2.0 / 24.0)
		lat3 := float64(locator[5]|0x20-'a') * (1.0 / 24.0)
		lon += lon3
		lat += lat3
		// Center of subsquare
		lon += (1.0 / 24.0)
		lat += (1.0 / 48.0)
	} else {
		// Center of square (4-char locator)
		lon += 1.0
		lat += 0.5
	}

	return lat, lon
}

// NewStatisticsTracker creates a new statistics tracker
func NewStatisticsTracker() *StatisticsTracker {
	st := &StatisticsTracker{
		instances:     make(map[string]*InstanceStats),
		countryStats:  make(map[string]*CountryStats),
		mapSpots:      make(map[string]*SpotLocation),
		recentWindows: make([]*WindowStats, 0, 720),
		snrHistory:    make(map[string]map[string][]SNRHistoryPoint),
		currentWindowSNR: make(map[string]*struct {
			totalSNR, count, totalDistance int
			distanceCount                  int
		}),
	}

	// Start background cleanup goroutine
	go st.cleanupOldData()

	return st
}

// cleanupOldData periodically removes data older than 24 hours from memory
func (st *StatisticsTracker) cleanupOldData() {
	ticker := time.NewTicker(10 * time.Minute) // Run every 10 minutes
	defer ticker.Stop()

	for range ticker.C {
		cutoff := time.Now().Add(-24 * time.Hour)

		// Clean up recent windows
		st.recentWindowsMu.Lock()
		filtered := make([]*WindowStats, 0, len(st.recentWindows))
		for _, window := range st.recentWindows {
			if window.WindowTime.After(cutoff) {
				filtered = append(filtered, window)
			}
		}
		st.recentWindows = filtered
		st.recentWindowsMu.Unlock()

		// Clean up SNR history
		st.snrHistoryMu.Lock()
		for band, instances := range st.snrHistory {
			for instance, points := range instances {
				filtered := make([]SNRHistoryPoint, 0, len(points))
				for _, point := range points {
					if point.WindowTime.After(cutoff) {
						filtered = append(filtered, point)
					}
				}
				if len(filtered) > 0 {
					st.snrHistory[band][instance] = filtered
				} else {
					delete(st.snrHistory[band], instance)
				}
			}
			// Remove empty band entries
			if len(st.snrHistory[band]) == 0 {
				delete(st.snrHistory, band)
			}
		}
		st.snrHistoryMu.Unlock()

		log.Printf("Cleanup: Removed data older than %s, kept %d windows", cutoff.Format("2006-01-02 15:04:05"), len(st.recentWindows))
	}
}

// SetReceiverLocation sets the receiver's location for distance calculations
func (st *StatisticsTracker) SetReceiverLocation(locator string) {
	lat, lon := maidenheadToLatLon(locator)
	st.receiverLat = lat
	st.receiverLon = lon
	log.Printf("Receiver location set to: %.4f, %.4f (from %s)", lat, lon, locator)
}

// StartWindow begins tracking a new submission window
func (st *StatisticsTracker) StartWindow(windowTime time.Time) {
	st.currentWindowMu.Lock()
	defer st.currentWindowMu.Unlock()

	st.currentWindow = &WindowStats{
		WindowTime:        windowTime,
		UniqueByInstance:  make(map[string][]string),
		BestSNRByInstance: make(map[string]int),
		TiedSNRByInstance: make(map[string]int),
		BandBreakdown:     make(map[string]int),
	}

	// Don't clear currentWindowSNR here - it will be cleared after recording history in FinishWindow
}

// RecordSpot records a spot from an instance
func (st *StatisticsTracker) RecordSpot(instanceName, band, callsign, country, locator string, snr int) {
	st.instancesMu.Lock()
	defer st.instancesMu.Unlock()

	// Get or create instance stats
	if st.instances[instanceName] == nil {
		st.instances[instanceName] = &InstanceStats{
			Name:            instanceName,
			BandStats:       make(map[string]*BandInstanceStats),
			RecentCallsigns: make([]string, 0, 10),
		}
	}
	instance := st.instances[instanceName]

	// Update instance stats
	instance.TotalSpots++
	instance.LastReportTime = time.Now()

	// Update band stats
	if instance.BandStats[band] == nil {
		instance.BandStats[band] = &BandInstanceStats{}
	}
	bandStats := instance.BandStats[band]
	bandStats.TotalSpots++
	bandStats.TotalSNR += snr
	bandStats.SNRCount++
	bandStats.AverageSNR = float64(bandStats.TotalSNR) / float64(bandStats.SNRCount)

	// Calculate distance once if we have valid locators
	var distance float64
	var hasDistance bool
	if locator != "" && st.receiverLat != 0 && st.receiverLon != 0 {
		spotLat, spotLon := maidenheadToLatLon(locator)
		if spotLat != 0 || spotLon != 0 {
			distance = haversineDistance(st.receiverLat, st.receiverLon, spotLat, spotLon)
			hasDistance = true

			// Update distance statistics for 24h summary
			if bandStats.DistanceCount == 0 {
				// First distance measurement
				bandStats.MinDistance = distance
				bandStats.MaxDistance = distance
			} else {
				if distance < bandStats.MinDistance {
					bandStats.MinDistance = distance
				}
				if distance > bandStats.MaxDistance {
					bandStats.MaxDistance = distance
				}
			}
			bandStats.TotalDistance += distance
			bandStats.DistanceCount++
			bandStats.AverageDistance = bandStats.TotalDistance / float64(bandStats.DistanceCount)
		}
	}

	// Update recent callsigns (keep last 10)
	instance.RecentCallsigns = append(instance.RecentCallsigns, callsign)
	if len(instance.RecentCallsigns) > 10 {
		instance.RecentCallsigns = instance.RecentCallsigns[1:]
	}

	// Update country stats
	if country != "" {
		st.recordCountryStats(band, country, callsign, snr)
	}

	// Update current spots for mapping
	if locator != "" {
		st.recordSpotLocation(callsign, locator, band, country, snr)
	}

	// Accumulate SNR and distance for current window history
	st.currentWindowSNRMu.Lock()
	key := band + "_" + instanceName
	if st.currentWindowSNR[key] == nil {
		st.currentWindowSNR[key] = &struct {
			totalSNR, count, totalDistance int
			distanceCount                  int
		}{}
	}
	st.currentWindowSNR[key].totalSNR += snr
	st.currentWindowSNR[key].count++

	// Add distance if we calculated it (reuse the distance we already calculated)
	if hasDistance {
		st.currentWindowSNR[key].totalDistance += int(distance)
		st.currentWindowSNR[key].distanceCount++
	}
	st.currentWindowSNRMu.Unlock()
}

// recordSpotLocation updates spot location info for mapping
func (st *StatisticsTracker) recordSpotLocation(callsign, locator, band, country string, snr int) {
	st.mapSpotsMu.Lock()
	defer st.mapSpotsMu.Unlock()

	if spot, exists := st.mapSpots[callsign]; exists {
		// Add band if not already present
		found := false
		for i, b := range spot.Bands {
			if b == band {
				// Update SNR for this band if better
				if snr > spot.SNR[i] {
					spot.SNR[i] = snr
				}
				found = true
				break
			}
		}
		if !found {
			spot.Bands = append(spot.Bands, band)
			spot.SNR = append(spot.SNR, snr)
		}
	} else {
		st.mapSpots[callsign] = &SpotLocation{
			Callsign: callsign,
			Locator:  locator,
			Bands:    []string{band},
			SNR:      []int{snr},
			Country:  country,
		}
	}
}

// recordCountryStats updates country statistics
func (st *StatisticsTracker) recordCountryStats(band, country, callsign string, snr int) {
	st.countryStatsMu.Lock()
	defer st.countryStatsMu.Unlock()

	key := band + "_" + country
	if st.countryStats[key] == nil {
		st.countryStats[key] = &CountryStats{
			Country:         country,
			Band:            band,
			UniqueCallsigns: make(map[string]bool),
			MinSNR:          snr,
			MaxSNR:          snr,
		}
	}

	stats := st.countryStats[key]
	stats.UniqueCallsigns[callsign] = true
	stats.TotalSNR += snr
	stats.Count++

	if snr < stats.MinSNR {
		stats.MinSNR = snr
	}
	if snr > stats.MaxSNR {
		stats.MaxSNR = snr
	}
}

// RecordUnique records a spot that was unique to an instance
func (st *StatisticsTracker) RecordUnique(instanceName, band, callsign string) {
	st.instancesMu.Lock()
	if st.instances[instanceName] != nil {
		st.instances[instanceName].UniqueSpots++
		if st.instances[instanceName].BandStats[band] != nil {
			st.instances[instanceName].BandStats[band].UniqueSpots++
		}
	}
	st.instancesMu.Unlock()

	st.currentWindowMu.Lock()
	if st.currentWindow != nil {
		st.currentWindow.UniqueByInstance[instanceName] = append(
			st.currentWindow.UniqueByInstance[instanceName],
			callsign,
		)
	}
	st.currentWindowMu.Unlock()
}

// RecordBestSNR records when an instance had the best SNR for a duplicate
func (st *StatisticsTracker) RecordBestSNR(instanceName, band string) {
	st.instancesMu.Lock()
	if st.instances[instanceName] != nil {
		st.instances[instanceName].BestSNRWins++
		if st.instances[instanceName].BandStats[band] != nil {
			st.instances[instanceName].BandStats[band].BestSNRWins++
		}
	}
	st.instancesMu.Unlock()

	st.currentWindowMu.Lock()
	if st.currentWindow != nil {
		st.currentWindow.BestSNRByInstance[instanceName]++
	}
	st.currentWindowMu.Unlock()
}

// RecordTiedSNR records when an instance tied for the best SNR
func (st *StatisticsTracker) RecordTiedSNR(instanceName, band string) {
	st.instancesMu.Lock()
	if st.instances[instanceName] != nil {
		st.instances[instanceName].TiedSNR++
		if st.instances[instanceName].BandStats[band] != nil {
			st.instances[instanceName].BandStats[band].TiedSNR++
		}
	}
	st.instancesMu.Unlock()

	st.currentWindowMu.Lock()
	if st.currentWindow != nil {
		st.currentWindow.TiedSNRByInstance[instanceName]++
	}
	st.currentWindowMu.Unlock()
}

// FinishWindow completes the current window and adds it to history
func (st *StatisticsTracker) FinishWindow(totalSpots, duplicates int, bandBreakdown map[string]int) {
	st.currentWindowMu.Lock()
	if st.currentWindow != nil {
		windowTime := st.currentWindow.WindowTime

		st.currentWindow.TotalSpots = totalSpots
		st.currentWindow.DuplicateCount = duplicates
		st.currentWindow.BandBreakdown = bandBreakdown
		st.currentWindow.SubmittedAt = time.Now()

		// Update instance last window times
		st.instancesMu.Lock()
		for _, instance := range st.instances {
			instance.LastWindowTime = st.currentWindow.WindowTime
		}
		st.instancesMu.Unlock()

		// Add to recent windows
		st.recentWindowsMu.Lock()
		st.recentWindows = append(st.recentWindows, st.currentWindow)
		// Keep only last 720 windows (24 hours)
		if len(st.recentWindows) > 720 {
			st.recentWindows = st.recentWindows[1:]
		}
		st.recentWindowsMu.Unlock()

		// Update overall stats
		st.statsMu.Lock()
		st.totalSubmitted += totalSpots
		st.totalDuplicates += duplicates
		st.totalUnique += (totalSpots - duplicates)
		st.statsMu.Unlock()

		// Record SNR history for this window
		st.recordSNRHistory(windowTime)

		// Clear current window SNR and distance accumulation AFTER recording history
		st.currentWindowSNRMu.Lock()
		st.currentWindowSNR = make(map[string]*struct {
			totalSNR, count, totalDistance int
			distanceCount                  int
		})
		st.currentWindowSNRMu.Unlock()
	}
	st.currentWindow = nil
	st.currentWindowMu.Unlock()
}

// recordSNRHistory records the average SNR for each band/instance combination for this window
func (st *StatisticsTracker) recordSNRHistory(windowTime time.Time) {
	st.currentWindowSNRMu.Lock()
	defer st.currentWindowSNRMu.Unlock()

	st.snrHistoryMu.Lock()
	defer st.snrHistoryMu.Unlock()

	if len(st.currentWindowSNR) == 0 {
		log.Printf("SNR History: No data to record for window %s", windowTime.Format("15:04:05"))
		return
	}

	log.Printf("SNR History: Recording data for %d band/instance combinations", len(st.currentWindowSNR))

	// Process each band_instance combination
	for key, data := range st.currentWindowSNR {
		if data.count == 0 {
			continue
		}

		// Parse band and instance from key
		// Key format: "band_instance"
		var band, instance string
		for i := 0; i < len(key); i++ {
			if key[i] == '_' {
				band = key[:i]
				instance = key[i+1:]
				break
			}
		}

		if band == "" || instance == "" {
			log.Printf("SNR History: Failed to parse key '%s'", key)
			continue
		}

		avgSNR := float64(data.totalSNR) / float64(data.count)

		// Calculate average distance if we have distance data
		avgDistance := 0.0
		if data.distanceCount > 0 {
			avgDistance = float64(data.totalDistance) / float64(data.distanceCount)
		}

		// Initialize band map if needed
		if st.snrHistory[band] == nil {
			st.snrHistory[band] = make(map[string][]SNRHistoryPoint)
		}

		// Add history point with distance
		point := SNRHistoryPoint{
			WindowTime:      windowTime,
			AverageSNR:      avgSNR,
			SpotCount:       data.count,
			AverageDistance: avgDistance,
			DistanceCount:   data.distanceCount,
		}

		st.snrHistory[band][instance] = append(st.snrHistory[band][instance], point)

		if data.distanceCount > 0 {
			log.Printf("SNR History: %s/%s - Avg SNR: %.1f dB, Avg Dist: %.0f km (%d spots), Total points: %d",
				band, instance, avgSNR, avgDistance, data.count, len(st.snrHistory[band][instance]))
		} else {
			log.Printf("SNR History: %s/%s - Avg SNR: %.1f dB (%d spots), Total points: %d",
				band, instance, avgSNR, data.count, len(st.snrHistory[band][instance]))
		}

		// Keep only last 720 points (24 hours)
		if len(st.snrHistory[band][instance]) > 720 {
			st.snrHistory[band][instance] = st.snrHistory[band][instance][1:]
		}
	}
}

// GetInstanceStats returns statistics for all instances
func (st *StatisticsTracker) GetInstanceStats() map[string]*InstanceStats {
	st.instancesMu.RLock()
	defer st.instancesMu.RUnlock()

	// Create a copy to avoid race conditions
	result := make(map[string]*InstanceStats)
	for k, v := range st.instances {
		instanceCopy := &InstanceStats{
			Name:            v.Name,
			TotalSpots:      v.TotalSpots,
			UniqueSpots:     v.UniqueSpots,
			BestSNRWins:     v.BestSNRWins,
			LastReportTime:  v.LastReportTime,
			LastWindowTime:  v.LastWindowTime,
			RecentCallsigns: make([]string, len(v.RecentCallsigns)),
			BandStats:       make(map[string]*BandInstanceStats),
		}
		copy(instanceCopy.RecentCallsigns, v.RecentCallsigns)

		for band, stats := range v.BandStats {
			instanceCopy.BandStats[band] = &BandInstanceStats{
				TotalSpots:      stats.TotalSpots,
				UniqueSpots:     stats.UniqueSpots,
				BestSNRWins:     stats.BestSNRWins,
				TiedSNR:         stats.TiedSNR,
				AverageSNR:      stats.AverageSNR,
				TotalSNR:        stats.TotalSNR,
				SNRCount:        stats.SNRCount,
				MinDistance:     stats.MinDistance,
				MaxDistance:     stats.MaxDistance,
				TotalDistance:   stats.TotalDistance,
				DistanceCount:   stats.DistanceCount,
				AverageDistance: stats.AverageDistance,
			}
		}
		result[k] = instanceCopy
	}
	return result
}

// GetSNRHistory returns SNR history for all bands and instances
func (st *StatisticsTracker) GetSNRHistory() map[string]*BandSNRHistory {
	st.snrHistoryMu.RLock()
	defer st.snrHistoryMu.RUnlock()

	result := make(map[string]*BandSNRHistory)

	// Calculate cutoff time (24 hours ago)
	cutoff := time.Now().Add(-24 * time.Hour)

	for band, instances := range st.snrHistory {
		bandHistory := &BandSNRHistory{
			Band:      band,
			Instances: make(map[string][]SNRHistoryPoint),
		}

		for instance, points := range instances {
			// Filter and copy only points from last 24 hours
			filteredPoints := make([]SNRHistoryPoint, 0, len(points))
			for _, point := range points {
				if point.WindowTime.After(cutoff) {
					filteredPoints = append(filteredPoints, point)
				}
			}
			if len(filteredPoints) > 0 {
				bandHistory.Instances[instance] = filteredPoints
			}
		}

		result[band] = bandHistory
	}

	return result
}

// GetRecentWindows returns the recent window statistics
func (st *StatisticsTracker) GetRecentWindows(count int) []*WindowStats {
	st.recentWindowsMu.RLock()
	defer st.recentWindowsMu.RUnlock()

	if count <= 0 || count > len(st.recentWindows) {
		count = len(st.recentWindows)
	}

	// Return the last N windows
	start := len(st.recentWindows) - count
	result := make([]*WindowStats, count)
	copy(result, st.recentWindows[start:])
	return result
}

// GetCountryStats returns country statistics grouped by band
func (st *StatisticsTracker) GetCountryStats() map[string][]map[string]interface{} {
	st.countryStatsMu.RLock()
	defer st.countryStatsMu.RUnlock()

	// Group by band
	result := make(map[string][]map[string]interface{})

	for _, stats := range st.countryStats {
		avgSNR := 0.0
		if stats.Count > 0 {
			avgSNR = float64(stats.TotalSNR) / float64(stats.Count)
		}

		countryData := map[string]interface{}{
			"country":          stats.Country,
			"unique_callsigns": len(stats.UniqueCallsigns),
			"min_snr":          stats.MinSNR,
			"max_snr":          stats.MaxSNR,
			"avg_snr":          avgSNR,
			"total_spots":      stats.Count,
		}

		result[stats.Band] = append(result[stats.Band], countryData)
	}

	return result
}

// SaveToFile saves all statistics to a JSON file (without WSPRNet stats)
func (st *StatisticsTracker) SaveToFile(filename string) error {
	return st.SaveToFileWithWSPRNet(filename, nil)
}

// SaveToFileWithWSPRNet saves all statistics including WSPRNet stats to a JSON file
func (st *StatisticsTracker) SaveToFileWithWSPRNet(filename string, wsprnetStats map[string]interface{}) error {
	// Gather all data with appropriate locks
	st.recentWindowsMu.RLock()
	windows := make([]*WindowStats, len(st.recentWindows))
	copy(windows, st.recentWindows)
	st.recentWindowsMu.RUnlock()

	st.instancesMu.RLock()
	instances := make(map[string]*InstanceStats)
	for k, v := range st.instances {
		instances[k] = v
	}
	st.instancesMu.RUnlock()

	st.countryStatsMu.RLock()
	countryStats := make(map[string]*CountryStatsExport)
	for k, v := range st.countryStats {
		// Convert map to slice for JSON serialization
		callsigns := make([]string, 0, len(v.UniqueCallsigns))
		for cs := range v.UniqueCallsigns {
			callsigns = append(callsigns, cs)
		}
		countryStats[k] = &CountryStatsExport{
			Country:         v.Country,
			Band:            v.Band,
			UniqueCallsigns: callsigns,
			MinSNR:          v.MinSNR,
			MaxSNR:          v.MaxSNR,
			TotalSNR:        v.TotalSNR,
			Count:           v.Count,
		}
	}
	st.countryStatsMu.RUnlock()

	st.mapSpotsMu.RLock()
	mapSpots := make(map[string]*SpotLocation)
	for k, v := range st.mapSpots {
		mapSpots[k] = v
	}
	st.mapSpotsMu.RUnlock()

	st.snrHistoryMu.RLock()
	snrHistory := make(map[string]map[string][]SNRHistoryPoint)
	for band, instances := range st.snrHistory {
		snrHistory[band] = make(map[string][]SNRHistoryPoint)
		for inst, points := range instances {
			snrHistory[band][inst] = points
		}
	}
	st.snrHistoryMu.RUnlock()

	st.statsMu.RLock()
	totalStats := OverallStats{
		TotalSubmitted:  st.totalSubmitted,
		TotalDuplicates: st.totalDuplicates,
		TotalUnique:     st.totalUnique,
	}
	st.statsMu.RUnlock()

	// Extract WSPRNet stats if provided
	wsprnetStatsData := WSPRNetStats{}
	if wsprnetStats != nil {
		if successful, ok := wsprnetStats["successful"].(int); ok {
			wsprnetStatsData.Successful = successful
		}
		if failed, ok := wsprnetStats["failed"].(int); ok {
			wsprnetStatsData.Failed = failed
		}
		if retries, ok := wsprnetStats["retries"].(int); ok {
			wsprnetStatsData.Retries = retries
		}
	}

	// Create persistence data structure
	data := PersistenceData{
		SavedAt:      time.Now(),
		Windows:      windows,
		Instances:    instances,
		CountryStats: countryStats,
		MapSpots:     mapSpots,
		SNRHistory:   snrHistory,
		TotalStats:   totalStats,
		WSPRNetStats: wsprnetStatsData,
	}

	// Marshal to JSON
	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal persistence data: %w", err)
	}

	// Write to file
	if err := os.WriteFile(filename, jsonData, 0644); err != nil {
		return fmt.Errorf("failed to write persistence file: %w", err)
	}

	return nil
}

// LoadFromFile loads all statistics from a JSON file and filters to last 24 hours
// Returns WSPRNet stats separately so they can be restored to the WSPRNet client
func (st *StatisticsTracker) LoadFromFile(filename string) (*WSPRNetStats, error) {
	// Check if file exists
	if _, err := os.Stat(filename); os.IsNotExist(err) {
		// File doesn't exist yet, that's okay
		return nil, nil
	}

	// Read file
	jsonData, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read persistence file: %w", err)
	}

	// Unmarshal data
	var data PersistenceData
	if err := json.Unmarshal(jsonData, &data); err != nil {
		return nil, fmt.Errorf("failed to unmarshal persistence data: %w", err)
	}

	// Restore all windows (will be filtered at query time and cleaned up periodically)
	st.recentWindowsMu.Lock()
	st.recentWindows = data.Windows
	if st.recentWindows == nil {
		st.recentWindows = make([]*WindowStats, 0, 720)
	}
	st.recentWindowsMu.Unlock()

	// Restore instances (full data)
	st.instancesMu.Lock()
	st.instances = data.Instances
	if st.instances == nil {
		st.instances = make(map[string]*InstanceStats)
	}
	st.instancesMu.Unlock()

	// Restore country stats (convert back from export format)
	st.countryStatsMu.Lock()
	st.countryStats = make(map[string]*CountryStats)
	for k, v := range data.CountryStats {
		callsignsMap := make(map[string]bool)
		for _, cs := range v.UniqueCallsigns {
			callsignsMap[cs] = true
		}
		st.countryStats[k] = &CountryStats{
			Country:         v.Country,
			Band:            v.Band,
			UniqueCallsigns: callsignsMap,
			MinSNR:          v.MinSNR,
			MaxSNR:          v.MaxSNR,
			TotalSNR:        v.TotalSNR,
			Count:           v.Count,
		}
	}
	st.countryStatsMu.Unlock()

	// Restore map spots
	st.mapSpotsMu.Lock()
	st.mapSpots = data.MapSpots
	if st.mapSpots == nil {
		st.mapSpots = make(map[string]*SpotLocation)
	}
	st.mapSpotsMu.Unlock()

	// Restore SNR history (will be filtered at query time and cleaned up periodically)
	st.snrHistoryMu.Lock()
	st.snrHistory = data.SNRHistory
	if st.snrHistory == nil {
		st.snrHistory = make(map[string]map[string][]SNRHistoryPoint)
	}
	st.snrHistoryMu.Unlock()

	// Restore overall stats
	st.statsMu.Lock()
	st.totalSubmitted = data.TotalStats.TotalSubmitted
	st.totalDuplicates = data.TotalStats.TotalDuplicates
	st.totalUnique = data.TotalStats.TotalUnique
	st.statsMu.Unlock()

	// Return WSPRNet stats for restoration
	return &data.WSPRNetStats, nil
}

// GetOverallStats returns overall statistics
func (st *StatisticsTracker) GetOverallStats() map[string]interface{} {
	st.statsMu.RLock()
	defer st.statsMu.RUnlock()

	return map[string]interface{}{
		"total_submitted":  st.totalSubmitted,
		"total_duplicates": st.totalDuplicates,
		"total_unique":     st.totalUnique,
	}
}

// GetCurrentSpots returns spots for mapping from the last 24 hours
func (st *StatisticsTracker) GetCurrentSpots() []*SpotLocation {
	st.mapSpotsMu.RLock()
	defer st.mapSpotsMu.RUnlock()

	result := make([]*SpotLocation, 0, len(st.mapSpots))
	for _, spot := range st.mapSpots {
		// Create a copy to avoid race conditions
		spotCopy := &SpotLocation{
			Callsign: spot.Callsign,
			Locator:  spot.Locator,
			Bands:    make([]string, len(spot.Bands)),
			SNR:      make([]int, len(spot.SNR)),
			Country:  spot.Country,
		}
		copy(spotCopy.Bands, spot.Bands)
		copy(spotCopy.SNR, spot.SNR)
		result = append(result, spotCopy)
	}
	return result
}

// InstancePerformancePoint represents spot count for an instance at a specific time
type InstancePerformancePoint struct {
	WindowTime time.Time `json:"window_time"`
	SpotCount  int       `json:"spot_count"`
}

// GetInstancePerformance returns spot counts per instance over time from recent windows (post-deduplication)
func (st *StatisticsTracker) GetInstancePerformance() map[string][]InstancePerformancePoint {
	st.recentWindowsMu.RLock()
	defer st.recentWindowsMu.RUnlock()

	// Map to accumulate spots per instance per window
	// Key: instance name -> list of performance points
	result := make(map[string][]InstancePerformancePoint)

	// Calculate cutoff time (24 hours ago)
	cutoff := time.Now().Add(-24 * time.Hour)

	// Process each window (only include windows from last 24 hours)
	for _, window := range st.recentWindows {
		// Skip windows older than 24 hours
		if window.WindowTime.Before(cutoff) {
			continue
		}
		// Count spots per instance in this window
		instanceSpots := make(map[string]int)

		// Count unique spots
		for instance, callsigns := range window.UniqueByInstance {
			instanceSpots[instance] += len(callsigns)
		}

		// Count best SNR wins (these are also spots)
		for instance, count := range window.BestSNRByInstance {
			instanceSpots[instance] += count
		}

		// Count tied SNR (these are also spots)
		for instance, count := range window.TiedSNRByInstance {
			instanceSpots[instance] += count
		}

		// Add performance points for each instance that had activity
		for instance, count := range instanceSpots {
			if count > 0 {
				result[instance] = append(result[instance], InstancePerformancePoint{
					WindowTime: window.WindowTime,
					SpotCount:  count,
				})
			}
		}
	}

	return result
}

// GetInstancePerformanceRaw returns raw spot counts per instance over time (pre-deduplication)
// This uses the SNR history data which tracks all spots before deduplication
func (st *StatisticsTracker) GetInstancePerformanceRaw() map[string][]InstancePerformancePoint {
	st.snrHistoryMu.RLock()
	defer st.snrHistoryMu.RUnlock()

	// Map to accumulate total spots per instance per window
	// Key: instance name -> list of performance points
	result := make(map[string][]InstancePerformancePoint)

	// Calculate cutoff time (24 hours ago)
	cutoff := time.Now().Add(-24 * time.Hour)

	// Collect all unique window times across all bands (only from last 24 hours)
	windowTimes := make(map[time.Time]bool)
	for _, instances := range st.snrHistory {
		for _, points := range instances {
			for _, point := range points {
				// Skip points older than 24 hours
				if point.WindowTime.Before(cutoff) {
					continue
				}
				windowTimes[point.WindowTime] = true
			}
		}
	}

	// For each instance, aggregate spot counts across all bands per window
	instanceWindows := make(map[string]map[time.Time]int) // instance -> window -> total spots

	for _, instances := range st.snrHistory {
		for instance, points := range instances {
			if instanceWindows[instance] == nil {
				instanceWindows[instance] = make(map[time.Time]int)
			}
			for _, point := range points {
				// Skip points older than 24 hours
				if point.WindowTime.Before(cutoff) {
					continue
				}
				instanceWindows[instance][point.WindowTime] += point.SpotCount
			}
		}
	}

	// Convert to result format
	for instance, windows := range instanceWindows {
		points := make([]InstancePerformancePoint, 0, len(windows))
		for windowTime, count := range windows {
			points = append(points, InstancePerformancePoint{
				WindowTime: windowTime,
				SpotCount:  count,
			})
		}
		// Sort by time
		for i := 0; i < len(points)-1; i++ {
			for j := i + 1; j < len(points); j++ {
				if points[i].WindowTime.After(points[j].WindowTime) {
					points[i], points[j] = points[j], points[i]
				}
			}
		}
		result[instance] = points
	}

	return result
}
