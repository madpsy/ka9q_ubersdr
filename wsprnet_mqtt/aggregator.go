package main

import (
	"fmt"
	"log"
	"sort"
	"sync"
	"time"
)

// SpotAggregator aggregates and deduplicates WSPR spots within 2-minute windows
type SpotAggregator struct {
	wsprNet         *WSPRNet
	stats           *StatisticsTracker
	persistenceFile string

	// Map of 2-minute windows to spots
	// Key: timestamp rounded to 2-minute boundary
	// Value: map of dedup key to report with source info
	windows   map[int64]map[string]*WSPRReportWithSource
	windowsMu sync.Mutex

	// Track duplicates for reporting
	// Key: window timestamp
	// Value: map of callsign to list of duplicate reports
	duplicates   map[int64]map[string][]*WSPRReportWithSource
	duplicatesMu sync.Mutex

	// Channel for incoming spots
	spotChan chan *WSPRReportWithSource

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// WSPRReportWithSource wraps a WSPR report with its source information
type WSPRReportWithSource struct {
	*WSPRReport
	InstanceName string
	Country      string
}

// NewSpotAggregator creates a new spot aggregator
func NewSpotAggregator(wsprNet *WSPRNet, stats *StatisticsTracker, persistenceFile string) *SpotAggregator {
	return &SpotAggregator{
		wsprNet:         wsprNet,
		stats:           stats,
		persistenceFile: persistenceFile,
		windows:         make(map[int64]map[string]*WSPRReportWithSource),
		duplicates:      make(map[int64]map[string][]*WSPRReportWithSource),
		spotChan:        make(chan *WSPRReportWithSource, 1000),
		stopChan:        make(chan struct{}),
	}
}

// Start starts the aggregator
func (sa *SpotAggregator) Start() {
	sa.running = true

	// Start spot processing goroutine
	sa.wg.Add(1)
	go sa.processSpots()

	// Start window flushing goroutine
	sa.wg.Add(1)
	go sa.flushWindows()

	log.Println("Spot aggregator started")
}

// Stop stops the aggregator
func (sa *SpotAggregator) Stop() {
	if !sa.running {
		return
	}

	sa.running = false
	close(sa.stopChan)
	sa.wg.Wait()

	// Flush any remaining windows
	sa.flushAllWindows()

	log.Println("Spot aggregator stopped")
}

// AddSpot adds a spot to the aggregator
func (sa *SpotAggregator) AddSpot(report *WSPRReport, instanceName, country string) {
	if !sa.running {
		return
	}

	reportWithSource := &WSPRReportWithSource{
		WSPRReport:   report,
		InstanceName: instanceName,
		Country:      country,
	}

	select {
	case sa.spotChan <- reportWithSource:
	default:
		log.Println("Aggregator: Spot channel full, dropping spot")
	}
}

// processSpots processes incoming spots
func (sa *SpotAggregator) processSpots() {
	defer sa.wg.Done()

	for {
		select {
		case <-sa.stopChan:
			return
		case report := <-sa.spotChan:
			sa.addToWindow(report)
		}
	}
}

// addToWindow adds a report to the appropriate 2-minute window
func (sa *SpotAggregator) addToWindow(report *WSPRReportWithSource) {
	// Round timestamp to 2-minute boundary (WSPR cycle time)
	// WSPR transmissions start at even minutes (00, 02, 04, etc.)
	timestamp := report.EpochTime.Unix()
	windowKey := (timestamp / 120) * 120

	// Create deduplication key: callsign + mode + window
	// This ensures we only keep one spot per callsign per 2-minute window
	dedupKey := fmt.Sprintf("%s_%s_%d", report.Callsign, report.Mode, windowKey)

	// Determine band
	band := frequencyToBand(report.ReceiverFreq)

	// Record spot in statistics
	sa.stats.RecordSpot(report.InstanceName, band, report.Callsign, report.Country, report.Locator, report.SNR)

	sa.windowsMu.Lock()
	defer sa.windowsMu.Unlock()

	// Create window if it doesn't exist
	if sa.windows[windowKey] == nil {
		sa.windows[windowKey] = make(map[string]*WSPRReportWithSource)
	}

	// Check if we already have this spot
	if existing, exists := sa.windows[windowKey][dedupKey]; exists {
		// Keep the spot with better SNR
		if report.SNR > existing.SNR {
			// New report is better - track the old one as rejected
			sa.trackDuplicate(windowKey, existing)
			sa.windows[windowKey][dedupKey] = report
			// Record that this instance won
			sa.stats.RecordBestSNR(report.InstanceName, band)
			if DebugMode {
				log.Printf("Aggregator: Updated spot for %s (better SNR: %d > %d)",
					report.Callsign, report.SNR, existing.SNR)
			}
		} else if report.SNR == existing.SNR {
			// Tied SNR - track both instances as having tied with each other
			sa.trackDuplicate(windowKey, report)
			sa.stats.RecordTiedSNR(report.InstanceName, band, existing.InstanceName)
			sa.stats.RecordTiedSNR(existing.InstanceName, band, report.InstanceName)
			if DebugMode {
				log.Printf("Aggregator: Tied spot for %s (SNR: %d = %d) - [%s] vs [%s]",
					report.Callsign, report.SNR, existing.SNR, existing.InstanceName, report.InstanceName)
			}
		} else {
			// Existing is better - track the new one as rejected
			sa.trackDuplicate(windowKey, report)
			sa.stats.RecordBestSNR(existing.InstanceName, band)
			if DebugMode {
				log.Printf("Aggregator: Duplicate spot for %s (keeping existing SNR: %d > %d)",
					report.Callsign, existing.SNR, report.SNR)
			}
		}
	} else {
		// New spot for this window
		sa.windows[windowKey][dedupKey] = report
		if DebugMode {
			log.Printf("Aggregator: Added spot for %s to window %d",
				report.Callsign, windowKey)
		}
	}
}

// flushWindows periodically flushes old windows
// Synchronized to run at WSPR cycle boundaries (every 2 minutes at :00, :02, :04, etc.)
func (sa *SpotAggregator) flushWindows() {
	defer sa.wg.Done()

	// Calculate time until next 2-minute boundary
	now := time.Now()
	secondsIntoMinute := now.Second()
	minuteMod := now.Minute() % 2

	// Calculate seconds until next even 2-minute mark
	var secondsUntilNext int
	if minuteMod == 0 {
		// We're in an even minute (0, 2, 4, etc.)
		if secondsIntoMinute == 0 {
			secondsUntilNext = 120 // Next cycle is 2 minutes away
		} else {
			secondsUntilNext = 120 - secondsIntoMinute // Wait until next even 2-minute mark
		}
	} else {
		// We're in an odd minute (1, 3, 5, etc.)
		secondsUntilNext = 60 - secondsIntoMinute // Wait until next even minute
	}

	log.Printf("Aggregator: Synchronizing to WSPR cycles, next flush in %d seconds", secondsUntilNext)

	// Wait until the next 2-minute boundary
	time.Sleep(time.Duration(secondsUntilNext) * time.Second)

	// Now create a ticker that fires every 2 minutes (120 seconds)
	ticker := time.NewTicker(120 * time.Second)
	defer ticker.Stop()

	// Flush immediately at the first boundary
	sa.flushOldWindows()

	for {
		select {
		case <-sa.stopChan:
			return
		case <-ticker.C:
			sa.flushOldWindows()
		}
	}
}

// flushOldWindows flushes windows that are older than 4 minutes
// This gives time for all instances to report their spots for a given window
// (2 minutes for WSPR transmission + up to 2 minutes for decoding + MQTT latency)
func (sa *SpotAggregator) flushOldWindows() {
	now := time.Now().Unix()
	flushThreshold := now - 240 // 4 minutes ago

	sa.windowsMu.Lock()
	windowsToFlush := make(map[int64]map[string]*WSPRReportWithSource)
	for windowKey, spots := range sa.windows {
		if windowKey < flushThreshold {
			windowsToFlush[windowKey] = spots
			delete(sa.windows, windowKey)
		}
	}
	sa.windowsMu.Unlock()

	// Flush each window
	for windowKey, spots := range windowsToFlush {
		sa.flushWindow(windowKey, spots)
	}
}

// flushAllWindows flushes all remaining windows (called on shutdown)
func (sa *SpotAggregator) flushAllWindows() {
	sa.windowsMu.Lock()
	windowsToFlush := make(map[int64]map[string]*WSPRReportWithSource)
	for windowKey, spots := range sa.windows {
		windowsToFlush[windowKey] = spots
	}
	sa.windows = make(map[int64]map[string]*WSPRReportWithSource)
	sa.windowsMu.Unlock()

	for windowKey, spots := range windowsToFlush {
		log.Printf("Aggregator: Flushing remaining window %d with %d unique spots",
			windowKey, len(spots))
		sa.flushWindow(windowKey, spots)
	}
}

// flushWindow flushes a single window with detailed reporting
func (sa *SpotAggregator) flushWindow(windowKey int64, spots map[string]*WSPRReportWithSource) {
	if len(spots) == 0 {
		return
	}

	// Get window time
	windowTime := time.Unix(windowKey, 0).UTC()

	// Start statistics window
	sa.stats.StartWindow(windowTime)

	// Group spots by band
	bandSpots := make(map[string][]*WSPRReportWithSource)
	bandBreakdown := make(map[string]int)
	for _, report := range spots {
		// Determine band from frequency
		band := frequencyToBand(report.ReceiverFreq)
		bandSpots[band] = append(bandSpots[band], report)
		bandBreakdown[band]++
	}

	// Get duplicates for this window
	sa.duplicatesMu.Lock()
	windowDuplicates := sa.duplicates[windowKey]
	totalDuplicates := 0
	for _, dups := range windowDuplicates {
		totalDuplicates += len(dups)
	}
	delete(sa.duplicates, windowKey)
	sa.duplicatesMu.Unlock()

	// Track unique spots per instance
	instanceCallsigns := make(map[string]map[string]bool)
	for _, report := range spots {
		if instanceCallsigns[report.InstanceName] == nil {
			instanceCallsigns[report.InstanceName] = make(map[string]bool)
		}
		instanceCallsigns[report.InstanceName][report.Callsign] = true
	}

	// Find unique callsigns per instance
	allCallsigns := make(map[string]bool)
	for _, callsigns := range instanceCallsigns {
		for callsign := range callsigns {
			allCallsigns[callsign] = true
		}
	}

	for instance, callsigns := range instanceCallsigns {
		for callsign := range callsigns {
			// Check if this callsign is unique to this instance
			isUnique := true
			for otherInstance, otherCallsigns := range instanceCallsigns {
				if otherInstance != instance && otherCallsigns[callsign] {
					isUnique = false
					break
				}
			}
			if isUnique {
				band := ""
				for _, report := range spots {
					if report.Callsign == callsign && report.InstanceName == instance {
						band = frequencyToBand(report.ReceiverFreq)
						break
					}
				}
				sa.stats.RecordUnique(instance, band, callsign)
			}
		}
	}

	// Group duplicates by band
	bandDuplicates := make(map[string]map[string][]*WSPRReportWithSource)
	for callsign, dups := range windowDuplicates {
		if len(dups) > 0 {
			band := frequencyToBand(dups[0].ReceiverFreq)
			if bandDuplicates[band] == nil {
				bandDuplicates[band] = make(map[string][]*WSPRReportWithSource)
			}
			bandDuplicates[band][callsign] = dups
		}
	}

	// Sort bands for consistent output
	bands := make([]string, 0, len(bandSpots))
	for band := range bandSpots {
		bands = append(bands, band)
	}
	sort.Strings(bands)

	// Print summary
	log.Println("================================================================================")
	log.Printf("WSPR Window: %s (submitting %d unique spots)", windowTime.Format("2006-01-02 15:04:05 UTC"), len(spots))
	log.Println("================================================================================")

	for _, band := range bands {
		reports := bandSpots[band]

		// Sort reports by callsign
		sort.Slice(reports, func(i, j int) bool {
			return reports[i].Callsign < reports[j].Callsign
		})

		log.Printf("\n--- %s (%d spots) ---", band, len(reports))
		for _, report := range reports {
			log.Printf("  %-10s  %6.3f MHz  SNR: %3d dB  Power: %2d dBm  Grid: %s  [%s]",
				report.Callsign,
				float64(report.Frequency)/1000000.0,
				report.SNR,
				report.DBm,
				report.Locator,
				report.InstanceName)

			// Submit to WSPRNet
			if err := sa.wsprNet.Submit(report.WSPRReport); err != nil {
				log.Printf("    ERROR: Failed to submit: %v", err)
			}
		}

		// Show duplicates for this band
		if dups, hasDups := bandDuplicates[band]; hasDups && len(dups) > 0 {
			log.Printf("\n  Duplicates found (%d callsigns):", len(dups))

			// Sort callsigns
			callsigns := make([]string, 0, len(dups))
			for callsign := range dups {
				callsigns = append(callsigns, callsign)
			}
			sort.Strings(callsigns)

			for _, callsign := range callsigns {
				dupReports := dups[callsign]
				
				// Find the winning report for this callsign
				var winner *WSPRReportWithSource
				for _, report := range reports {
					if report.Callsign == callsign {
						winner = report
						break
					}
				}
				
				if winner != nil {
					log.Printf("    %s: %d duplicate(s) - Winner: [%s] SNR: %d dB",
						callsign, len(dupReports), winner.InstanceName, winner.SNR)
					for _, dup := range dupReports {
						log.Printf("      Rejected: [%s] SNR: %3d dB", dup.InstanceName, dup.SNR)
					}
				} else {
					// Fallback if winner not found (shouldn't happen)
					log.Printf("    %s: %d duplicate(s)", callsign, len(dupReports))
					for _, dup := range dupReports {
						log.Printf("      Rejected: [%s] SNR: %3d dB", dup.InstanceName, dup.SNR)
					}
				}
			}
		}
	}

	log.Println("================================================================================")

	// Finish statistics window
	sa.stats.FinishWindow(len(spots), totalDuplicates, bandBreakdown)

	// Save statistics to disk if persistence is enabled
	if sa.persistenceFile != "" {
		// Get WSPRNet stats and save them
		wsprnetStats := sa.wsprNet.GetStats()
		if err := sa.stats.SaveToFileWithWSPRNet(sa.persistenceFile, wsprnetStats); err != nil {
			log.Printf("Warning: Failed to save statistics: %v", err)
		}
	}
}

// trackDuplicate tracks a rejected duplicate report for later reporting
func (sa *SpotAggregator) trackDuplicate(windowKey int64, rejected *WSPRReportWithSource) {
	sa.duplicatesMu.Lock()
	defer sa.duplicatesMu.Unlock()

	if sa.duplicates[windowKey] == nil {
		sa.duplicates[windowKey] = make(map[string][]*WSPRReportWithSource)
	}

	// Store only the rejected report
	sa.duplicates[windowKey][rejected.Callsign] = append(
		sa.duplicates[windowKey][rejected.Callsign],
		rejected,
	)
}

// frequencyToBand converts a frequency in Hz to a band name
func frequencyToBand(freq uint64) string {
	freqMHz := float64(freq) / 1000000.0

	switch {
	case freqMHz >= 0.1357 && freqMHz < 0.1378:
		return "2200m"
	case freqMHz >= 0.472 && freqMHz < 0.479:
		return "630m"
	case freqMHz >= 1.8 && freqMHz < 2.0:
		return "160m"
	case freqMHz >= 3.5 && freqMHz < 4.0:
		return "80m"
	case freqMHz >= 5.25 && freqMHz < 5.45:
		return "60m"
	case freqMHz >= 7.0 && freqMHz < 7.3:
		return "40m"
	case freqMHz >= 10.1 && freqMHz < 10.15:
		return "30m"
	case freqMHz >= 14.0 && freqMHz < 14.35:
		return "20m"
	case freqMHz >= 18.068 && freqMHz < 18.168:
		return "17m"
	case freqMHz >= 21.0 && freqMHz < 21.45:
		return "15m"
	case freqMHz >= 24.89 && freqMHz < 24.99:
		return "12m"
	case freqMHz >= 28.0 && freqMHz < 29.7:
		return "10m"
	default:
		return fmt.Sprintf("%.3fMHz", freqMHz)
	}
}

// GetStats returns aggregator statistics
func (sa *SpotAggregator) GetStats() map[string]interface{} {
	sa.windowsMu.Lock()
	defer sa.windowsMu.Unlock()

	totalSpots := 0
	for _, spots := range sa.windows {
		totalSpots += len(spots)
	}

	return map[string]interface{}{
		"active_windows": len(sa.windows),
		"pending_spots":  totalSpots,
	}
}

// DebugMode can be set to enable debug logging
var DebugMode = false
