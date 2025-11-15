package main

import (
	"sync"
	"time"
)

// DigitalDecodeMetrics tracks detailed metrics for digital decodes
type DigitalDecodeMetrics struct {
	// Per-mode per-band tracking
	decodesByModeBand map[string]map[string]*DecodeTimeSeries // mode -> band -> time series

	// Unique callsign tracking (callsign+band+mode combinations)
	uniqueCallsigns map[string]map[string]map[string]map[string]bool // mode -> band -> timeWindow -> callsign -> exists

	// Raw decode counts for cycle tracking (last 60 seconds) - includes ALL decodes even without callsigns
	recentDecodes []DecodeEvent

	// Raw cycle decode counts (total decodes per cycle, including unparseable ones)
	rawCycleDecodes []RawCycleEvent

	// Decoder execution time tracking
	executionTimes map[string]map[string][]ExecutionTimeEvent // mode -> band -> execution times

	mu sync.RWMutex
}

// DecodeEvent represents a single decode event for time-series tracking
type DecodeEvent struct {
	Mode      string
	Band      string
	Callsign  string
	Timestamp time.Time
}

// ExecutionTimeEvent represents a decoder execution time measurement
type ExecutionTimeEvent struct {
	Duration  time.Duration
	Timestamp time.Time
}

// RawCycleEvent represents raw decode count from a cycle (before parsing)
type RawCycleEvent struct {
	Mode      string
	Band      string
	Count     int // Total number of decode lines in the cycle
	Timestamp time.Time
}

// DecodeTimeSeries tracks decodes over different time windows
type DecodeTimeSeries struct {
	// Total decodes in time windows
	Last1Hour   int64
	Last3Hours  int64
	Last6Hours  int64
	Last12Hours int64
	Last24Hours int64

	// Decode events with timestamps for windowing
	events []DecodeEvent

	mu sync.RWMutex
}

// NewDigitalDecodeMetrics creates a new digital decode metrics tracker
func NewDigitalDecodeMetrics() *DigitalDecodeMetrics {
	return &DigitalDecodeMetrics{
		decodesByModeBand: make(map[string]map[string]*DecodeTimeSeries),
		uniqueCallsigns:   make(map[string]map[string]map[string]map[string]bool),
		recentDecodes:     make([]DecodeEvent, 0, 1000),
		rawCycleDecodes:   make([]RawCycleEvent, 0, 100),
		executionTimes:    make(map[string]map[string][]ExecutionTimeEvent),
	}
}

// RecordDecode records a new decode event
func (dm *DigitalDecodeMetrics) RecordDecode(mode, band, callsign string) {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	now := time.Now()
	event := DecodeEvent{
		Mode:      mode,
		Band:      band,
		Callsign:  callsign,
		Timestamp: now,
	}

	// Add to recent decodes (for 60-second average)
	dm.recentDecodes = append(dm.recentDecodes, event)

	// Clean old recent decodes (keep last 60 seconds)
	cutoff := now.Add(-60 * time.Second)
	newRecent := make([]DecodeEvent, 0, len(dm.recentDecodes))
	for _, e := range dm.recentDecodes {
		if e.Timestamp.After(cutoff) {
			newRecent = append(newRecent, e)
		}
	}
	dm.recentDecodes = newRecent

	// Initialize mode map if needed
	if dm.decodesByModeBand[mode] == nil {
		dm.decodesByModeBand[mode] = make(map[string]*DecodeTimeSeries)
	}

	// Initialize band time series if needed
	if dm.decodesByModeBand[mode][band] == nil {
		dm.decodesByModeBand[mode][band] = &DecodeTimeSeries{
			events: make([]DecodeEvent, 0, 1000),
		}
	}

	// Add to time series
	ts := dm.decodesByModeBand[mode][band]
	ts.mu.Lock()
	ts.events = append(ts.events, event)
	ts.mu.Unlock()

	// Record unique callsign for each time window
	dm.recordUniqueCallsign(mode, band, callsign, now)

	// Update time series counts
	dm.updateTimeSeriesCounts(mode, band)
}

// recordUniqueCallsign records a callsign as seen in various time windows
func (dm *DigitalDecodeMetrics) recordUniqueCallsign(mode, band, callsign string, timestamp time.Time) {
	if dm.uniqueCallsigns[mode] == nil {
		dm.uniqueCallsigns[mode] = make(map[string]map[string]map[string]bool)
	}
	if dm.uniqueCallsigns[mode][band] == nil {
		dm.uniqueCallsigns[mode][band] = make(map[string]map[string]bool)
	}

	// Record for each time window
	windows := []string{"1h", "3h", "6h", "12h", "24h"}
	for _, window := range windows {
		if dm.uniqueCallsigns[mode][band][window] == nil {
			dm.uniqueCallsigns[mode][band][window] = make(map[string]bool)
		}
		dm.uniqueCallsigns[mode][band][window][callsign] = true
	}
}

// updateTimeSeriesCounts updates the time series counts by cleaning old events
func (dm *DigitalDecodeMetrics) updateTimeSeriesCounts(mode, band string) {
	ts := dm.decodesByModeBand[mode][band]
	if ts == nil {
		return
	}

	ts.mu.Lock()
	defer ts.mu.Unlock()

	now := time.Now()

	// Clean events older than 24 hours
	cutoff24h := now.Add(-24 * time.Hour)
	newEvents := make([]DecodeEvent, 0, len(ts.events))
	for _, e := range ts.events {
		if e.Timestamp.After(cutoff24h) {
			newEvents = append(newEvents, e)
		}
	}
	ts.events = newEvents

	// Count events in each time window
	cutoff1h := now.Add(-1 * time.Hour)
	cutoff3h := now.Add(-3 * time.Hour)
	cutoff6h := now.Add(-6 * time.Hour)
	cutoff12h := now.Add(-12 * time.Hour)

	ts.Last1Hour = 0
	ts.Last3Hours = 0
	ts.Last6Hours = 0
	ts.Last12Hours = 0
	ts.Last24Hours = int64(len(ts.events))

	for _, e := range ts.events {
		if e.Timestamp.After(cutoff1h) {
			ts.Last1Hour++
		}
		if e.Timestamp.After(cutoff3h) {
			ts.Last3Hours++
		}
		if e.Timestamp.After(cutoff6h) {
			ts.Last6Hours++
		}
		if e.Timestamp.After(cutoff12h) {
			ts.Last12Hours++
		}
	}
}

// CleanupOldData removes data older than 24 hours (should be called periodically)
func (dm *DigitalDecodeMetrics) CleanupOldData() {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	now := time.Now()
	cutoff1h := now.Add(-1 * time.Hour)
	cutoff3h := now.Add(-3 * time.Hour)
	cutoff6h := now.Add(-6 * time.Hour)
	cutoff12h := now.Add(-12 * time.Hour)
	cutoff24h := now.Add(-24 * time.Hour)

	// Clean unique callsigns for each time window
	for mode := range dm.uniqueCallsigns {
		for band := range dm.uniqueCallsigns[mode] {
			// Rebuild unique callsigns based on actual events
			if ts := dm.decodesByModeBand[mode][band]; ts != nil {
				ts.mu.RLock()

				// Clear and rebuild unique callsigns
				dm.uniqueCallsigns[mode][band] = make(map[string]map[string]bool)
				dm.uniqueCallsigns[mode][band]["1h"] = make(map[string]bool)
				dm.uniqueCallsigns[mode][band]["3h"] = make(map[string]bool)
				dm.uniqueCallsigns[mode][band]["6h"] = make(map[string]bool)
				dm.uniqueCallsigns[mode][band]["12h"] = make(map[string]bool)
				dm.uniqueCallsigns[mode][band]["24h"] = make(map[string]bool)

				for _, e := range ts.events {
					if e.Timestamp.After(cutoff1h) {
						dm.uniqueCallsigns[mode][band]["1h"][e.Callsign] = true
					}
					if e.Timestamp.After(cutoff3h) {
						dm.uniqueCallsigns[mode][band]["3h"][e.Callsign] = true
					}
					if e.Timestamp.After(cutoff6h) {
						dm.uniqueCallsigns[mode][band]["6h"][e.Callsign] = true
					}
					if e.Timestamp.After(cutoff12h) {
						dm.uniqueCallsigns[mode][band]["12h"][e.Callsign] = true
					}
					if e.Timestamp.After(cutoff24h) {
						dm.uniqueCallsigns[mode][band]["24h"][e.Callsign] = true
					}
				}

				ts.mu.RUnlock()
			}
		}
	}
}

// RecordRawCycleDecodes records the raw decode count from a cycle (before parsing)
func (dm *DigitalDecodeMetrics) RecordRawCycleDecodes(mode, band string, count int) {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	now := time.Now()
	event := RawCycleEvent{
		Mode:      mode,
		Band:      band,
		Count:     count,
		Timestamp: now,
	}

	dm.rawCycleDecodes = append(dm.rawCycleDecodes, event)

	// Clean old raw cycle decodes (keep last 60 minutes for the longest window)
	cutoff := now.Add(-60 * time.Minute)
	newRaw := make([]RawCycleEvent, 0, len(dm.rawCycleDecodes))
	for _, e := range dm.rawCycleDecodes {
		if e.Timestamp.After(cutoff) {
			newRaw = append(newRaw, e)
		}
	}
	dm.rawCycleDecodes = newRaw
}

// GetAverageDecodesPerCycle returns average decodes per cycle for the specified time window (raw count before parsing)
func (dm *DigitalDecodeMetrics) GetAverageDecodesPerCycle(mode, band string, cycleSeconds int, minutes int) float64 {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if cycleSeconds == 0 || minutes == 0 {
		return 0
	}

	// Count raw decodes in the specified time window for this mode/band
	now := time.Now()
	cutoff := now.Add(-time.Duration(minutes) * time.Minute)
	totalCount := 0
	cycleCount := 0

	for _, e := range dm.rawCycleDecodes {
		if e.Mode == mode && e.Band == band && e.Timestamp.After(cutoff) {
			totalCount += e.Count
			cycleCount++
		}
	}

	// If we have actual cycle data, use it
	if cycleCount > 0 {
		return float64(totalCount) / float64(cycleCount)
	}

	// Fallback: count individual decodes and divide by theoretical cycles
	count := 0
	for _, e := range dm.recentDecodes {
		if e.Mode == mode && e.Band == band && e.Timestamp.After(cutoff) {
			count++
		}
	}

	windowSeconds := float64(minutes * 60)
	cycles := windowSeconds / float64(cycleSeconds)
	if cycles == 0 {
		return 0
	}

	return float64(count) / cycles
}

// GetTotalDecodes returns total decodes for a mode/band in a time window
func (dm *DigitalDecodeMetrics) GetTotalDecodes(mode, band string, hours int) int64 {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if dm.decodesByModeBand[mode] == nil || dm.decodesByModeBand[mode][band] == nil {
		return 0
	}

	ts := dm.decodesByModeBand[mode][band]
	ts.mu.RLock()
	defer ts.mu.RUnlock()

	switch hours {
	case 1:
		return ts.Last1Hour
	case 3:
		return ts.Last3Hours
	case 6:
		return ts.Last6Hours
	case 12:
		return ts.Last12Hours
	case 24:
		return ts.Last24Hours
	default:
		return 0
	}
}

// GetUniqueCallsigns returns count of unique callsign+band+mode combinations
func (dm *DigitalDecodeMetrics) GetUniqueCallsigns(mode, band string, hours int) int {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	var window string
	switch hours {
	case 1:
		window = "1h"
	case 3:
		window = "3h"
	case 6:
		window = "6h"
	case 12:
		window = "12h"
	case 24:
		window = "24h"
	default:
		return 0
	}

	if dm.uniqueCallsigns[mode] == nil ||
		dm.uniqueCallsigns[mode][band] == nil ||
		dm.uniqueCallsigns[mode][band][window] == nil {
		return 0
	}

	return len(dm.uniqueCallsigns[mode][band][window])
}

// GetAllModeBandCombinations returns all active mode/band combinations
func (dm *DigitalDecodeMetrics) GetAllModeBandCombinations() []struct{ Mode, Band string } {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	var combinations []struct{ Mode, Band string }
	for mode, bands := range dm.decodesByModeBand {
		for band := range bands {
			combinations = append(combinations, struct{ Mode, Band string }{Mode: mode, Band: band})
		}
	}

	return combinations
}

// RecordExecutionTime records a decoder execution time
func (dm *DigitalDecodeMetrics) RecordExecutionTime(mode, band string, duration time.Duration) {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	now := time.Now()
	event := ExecutionTimeEvent{
		Duration:  duration,
		Timestamp: now,
	}

	// Initialize mode map if needed
	if dm.executionTimes[mode] == nil {
		dm.executionTimes[mode] = make(map[string][]ExecutionTimeEvent)
	}

	// Initialize band slice if needed
	if dm.executionTimes[mode][band] == nil {
		dm.executionTimes[mode][band] = make([]ExecutionTimeEvent, 0, 100)
	}

	// Add execution time
	dm.executionTimes[mode][band] = append(dm.executionTimes[mode][band], event)

	// Clean old execution times (keep last 24 hours to match decode retention)
	cutoff := now.Add(-24 * time.Hour)
	newTimes := make([]ExecutionTimeEvent, 0, len(dm.executionTimes[mode][band]))
	for _, e := range dm.executionTimes[mode][band] {
		if e.Timestamp.After(cutoff) {
			newTimes = append(newTimes, e)
		}
	}
	dm.executionTimes[mode][band] = newTimes
}

// GetAverageExecutionTime returns average execution time for a mode/band over specified minutes
func (dm *DigitalDecodeMetrics) GetAverageExecutionTime(mode, band string, minutes int) float64 {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if dm.executionTimes[mode] == nil || dm.executionTimes[mode][band] == nil {
		return 0
	}

	now := time.Now()
	cutoff := now.Add(-time.Duration(minutes) * time.Minute)

	var totalDuration time.Duration
	count := 0

	for _, e := range dm.executionTimes[mode][band] {
		if e.Timestamp.After(cutoff) {
			totalDuration += e.Duration
			count++
		}
	}

	if count == 0 {
		return 0
	}

	// Return average in seconds
	return totalDuration.Seconds() / float64(count)
}

// GetExecutionTimeStats returns min, max, and average execution time for a mode/band over specified minutes
func (dm *DigitalDecodeMetrics) GetExecutionTimeStats(mode, band string, minutes int) (avgTime, minTime, maxTime float64) {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	if dm.executionTimes[mode] == nil || dm.executionTimes[mode][band] == nil {
		return 0, 0, 0
	}

	now := time.Now()
	cutoff := now.Add(-time.Duration(minutes) * time.Minute)

	var totalDuration time.Duration
	var minDuration time.Duration
	var maxDuration time.Duration
	count := 0

	for _, e := range dm.executionTimes[mode][band] {
		if e.Timestamp.After(cutoff) {
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
		return 0, 0, 0
	}

	// Return all values in seconds
	return totalDuration.Seconds() / float64(count), minDuration.Seconds(), maxDuration.Seconds()
}
