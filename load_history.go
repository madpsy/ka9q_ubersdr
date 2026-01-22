package main

import (
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
)

// LoadHistoryTracker tracks historical system load metrics
// Uses the same three-tier aggregation pattern as FrontendHistoryTracker
type LoadHistoryTracker struct {
	cpuCores int // Number of CPU cores for status calculation

	// Historical tracking (1-second samples, 1-minute means, 1-hour means)
	samples       []LoadSample  // Current minute's samples (up to 60)
	history       []LoadHistory // Historical minute means (up to 60)
	hourlyHistory []LoadHistory // Historical hour means (up to 24)
	historyMu     sync.RWMutex

	// Tickers for sampling and aggregation
	sampleTicker    *time.Ticker
	aggregateTicker *time.Ticker
	hourlyTicker    *time.Ticker

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// LoadSample represents a single 1-second sample
type LoadSample struct {
	Load1Min  float64
	Load5Min  float64
	Load15Min float64
	Status    string // "ok", "warning", "critical"
	Timestamp time.Time
}

// LoadHistory represents aggregated 1-minute or 1-hour mean values
type LoadHistory struct {
	Load1Min  float64   `json:"load_1min"`
	Load5Min  float64   `json:"load_5min"`
	Load15Min float64   `json:"load_15min"`
	Status    string    `json:"status"`
	Timestamp time.Time `json:"timestamp"`
}

// NewLoadHistoryTracker creates a new load history tracker
func NewLoadHistoryTracker() *LoadHistoryTracker {
	// Get CPU core count
	cpuCores := 0
	info, err := cpu.Info()
	if err == nil && len(info) > 0 {
		// Sum cores across all CPUs (for multi-socket systems)
		for _, cpuInfo := range info {
			cpuCores += int(cpuInfo.Cores)
		}
	}

	return &LoadHistoryTracker{
		cpuCores: cpuCores,
		stopChan: make(chan struct{}),
	}
}

// Start begins load history tracking
func (lht *LoadHistoryTracker) Start() error {
	if lht.running {
		return nil
	}

	lht.running = true

	// Initialize historical tracking
	lht.samples = make([]LoadSample, 0, 60)
	lht.history = make([]LoadHistory, 0, 60)
	lht.hourlyHistory = make([]LoadHistory, 0, 24)
	lht.sampleTicker = time.NewTicker(1 * time.Second)
	lht.aggregateTicker = time.NewTicker(1 * time.Minute)
	lht.hourlyTicker = time.NewTicker(1 * time.Hour)

	// Start sampling loop
	lht.wg.Add(1)
	go lht.sampleLoop()

	// Start aggregation loop
	lht.wg.Add(1)
	go lht.aggregateLoop()

	// Start hourly aggregation loop
	lht.wg.Add(1)
	go lht.hourlyAggregateLoop()

	log.Printf("Load history tracker started (CPU cores: %d)", lht.cpuCores)

	return nil
}

// Stop shuts down the load history tracker
func (lht *LoadHistoryTracker) Stop() {
	if !lht.running {
		return
	}

	lht.running = false
	close(lht.stopChan)

	// Stop tickers
	if lht.sampleTicker != nil {
		lht.sampleTicker.Stop()
	}
	if lht.aggregateTicker != nil {
		lht.aggregateTicker.Stop()
	}
	if lht.hourlyTicker != nil {
		lht.hourlyTicker.Stop()
	}

	lht.wg.Wait()

	log.Printf("Load history tracker stopped")
}

// sampleLoop collects samples every 1 second
func (lht *LoadHistoryTracker) sampleLoop() {
	defer lht.wg.Done()

	for {
		select {
		case <-lht.stopChan:
			return

		case <-lht.sampleTicker.C:
			// Read /proc/loadavg
			data, err := os.ReadFile("/proc/loadavg")
			if err != nil {
				continue // Skip this sample if we can't read the file
			}

			// Parse the load averages
			fields := strings.Fields(string(data))
			if len(fields) < 3 {
				continue // Invalid format
			}

			// Parse load values
			load1, err1 := strconv.ParseFloat(fields[0], 64)
			load5, err5 := strconv.ParseFloat(fields[1], 64)
			load15, err15 := strconv.ParseFloat(fields[2], 64)

			if err1 != nil || err5 != nil || err15 != nil {
				continue // Skip if parsing failed
			}

			// Calculate status based on average load vs CPU cores
			avgLoad := (load1 + load5 + load15) / 3.0
			status := "ok"
			if lht.cpuCores > 0 {
				if avgLoad >= float64(lht.cpuCores)*2.0 {
					status = "critical"
				} else if avgLoad >= float64(lht.cpuCores) {
					status = "warning"
				}
			}

			sample := LoadSample{
				Load1Min:  load1,
				Load5Min:  load5,
				Load15Min: load15,
				Status:    status,
				Timestamp: time.Now(),
			}

			// Add to current minute's samples
			lht.historyMu.Lock()
			lht.samples = append(lht.samples, sample)
			// Keep only last 60 samples (shouldn't exceed this, but safety check)
			if len(lht.samples) > 60 {
				lht.samples = lht.samples[len(lht.samples)-60:]
			}
			lht.historyMu.Unlock()
		}
	}
}

// aggregateLoop calculates mean values every 1 minute
func (lht *LoadHistoryTracker) aggregateLoop() {
	defer lht.wg.Done()

	for {
		select {
		case <-lht.stopChan:
			return

		case <-lht.aggregateTicker.C:
			lht.historyMu.Lock()

			// Calculate means from samples if we have any
			if len(lht.samples) > 0 {
				var sumLoad1 float64
				var sumLoad5 float64
				var sumLoad15 float64
				statusCounts := make(map[string]int)

				for _, sample := range lht.samples {
					sumLoad1 += sample.Load1Min
					sumLoad5 += sample.Load5Min
					sumLoad15 += sample.Load15Min
					statusCounts[sample.Status]++
				}

				count := float64(len(lht.samples))

				// Determine overall status for the minute (use most severe)
				status := "ok"
				if statusCounts["critical"] > 0 {
					status = "critical"
				} else if statusCounts["warning"] > 0 {
					status = "warning"
				}

				historyEntry := LoadHistory{
					Load1Min:  sumLoad1 / count,
					Load5Min:  sumLoad5 / count,
					Load15Min: sumLoad15 / count,
					Status:    status,
					Timestamp: time.Now(),
				}

				// Add to history
				lht.history = append(lht.history, historyEntry)

				// Keep only last 60 entries (60 minutes)
				if len(lht.history) > 60 {
					lht.history = lht.history[len(lht.history)-60:]
				}

				// Clear samples for next minute
				lht.samples = lht.samples[:0]
			}

			lht.historyMu.Unlock()
		}
	}
}

// hourlyAggregateLoop calculates mean values every 1 hour from minute-level history
func (lht *LoadHistoryTracker) hourlyAggregateLoop() {
	defer lht.wg.Done()

	for {
		select {
		case <-lht.stopChan:
			return

		case <-lht.hourlyTicker.C:
			lht.historyMu.Lock()

			// Calculate means from the last 60 minute entries if we have any
			if len(lht.history) > 0 {
				var sumLoad1 float64
				var sumLoad5 float64
				var sumLoad15 float64
				statusCounts := make(map[string]int)

				for _, entry := range lht.history {
					sumLoad1 += entry.Load1Min
					sumLoad5 += entry.Load5Min
					sumLoad15 += entry.Load15Min
					statusCounts[entry.Status]++
				}

				count := float64(len(lht.history))

				// Determine overall status for the hour (use most severe)
				status := "ok"
				if statusCounts["critical"] > 0 {
					status = "critical"
				} else if statusCounts["warning"] > 0 {
					status = "warning"
				}

				hourlyEntry := LoadHistory{
					Load1Min:  sumLoad1 / count,
					Load5Min:  sumLoad5 / count,
					Load15Min: sumLoad15 / count,
					Status:    status,
					Timestamp: time.Now(),
				}

				// Add to hourly history
				lht.hourlyHistory = append(lht.hourlyHistory, hourlyEntry)

				// Keep only last 24 entries (24 hours)
				if len(lht.hourlyHistory) > 24 {
					lht.hourlyHistory = lht.hourlyHistory[len(lht.hourlyHistory)-24:]
				}
			}

			lht.historyMu.Unlock()
		}
	}
}

// GetHistory returns the historical load data (up to 60 minutes)
func (lht *LoadHistoryTracker) GetHistory() []LoadHistory {
	if lht == nil {
		return nil
	}

	lht.historyMu.RLock()
	defer lht.historyMu.RUnlock()

	// Return a copy with rounded values for display
	historyCopy := make([]LoadHistory, len(lht.history))
	for i, entry := range lht.history {
		historyCopy[i] = LoadHistory{
			Load1Min:  math.Round(entry.Load1Min*100) / 100,  // 2 decimal places
			Load5Min:  math.Round(entry.Load5Min*100) / 100,  // 2 decimal places
			Load15Min: math.Round(entry.Load15Min*100) / 100, // 2 decimal places
			Status:    entry.Status,
			Timestamp: entry.Timestamp,
		}
	}

	return historyCopy
}

// GetHourlyHistory returns the hourly aggregated load data (up to 24 hours)
// Includes a partial entry for the current hour calculated from available minute-level data
func (lht *LoadHistoryTracker) GetHourlyHistory() []LoadHistory {
	if lht == nil {
		return nil
	}

	lht.historyMu.RLock()
	defer lht.historyMu.RUnlock()

	// Start with a copy of stored complete hours with rounded values
	result := make([]LoadHistory, len(lht.hourlyHistory))
	for i, entry := range lht.hourlyHistory {
		result[i] = LoadHistory{
			Load1Min:  math.Round(entry.Load1Min*100) / 100,  // 2 decimal places
			Load5Min:  math.Round(entry.Load5Min*100) / 100,  // 2 decimal places
			Load15Min: math.Round(entry.Load15Min*100) / 100, // 2 decimal places
			Status:    entry.Status,
			Timestamp: entry.Timestamp,
		}
	}

	// Calculate and append current partial hour from minute-level history
	if len(lht.history) > 0 {
		var sumLoad1 float64
		var sumLoad5 float64
		var sumLoad15 float64
		statusCounts := make(map[string]int)

		for _, entry := range lht.history {
			sumLoad1 += entry.Load1Min
			sumLoad5 += entry.Load5Min
			sumLoad15 += entry.Load15Min
			statusCounts[entry.Status]++
		}

		count := float64(len(lht.history))

		// Determine overall status for the partial hour (use most severe)
		status := "ok"
		if statusCounts["critical"] > 0 {
			status = "critical"
		} else if statusCounts["warning"] > 0 {
			status = "warning"
		}

		partialHourEntry := LoadHistory{
			Load1Min:  math.Round((sumLoad1/count)*100) / 100,  // 2 decimal places
			Load5Min:  math.Round((sumLoad5/count)*100) / 100,  // 2 decimal places
			Load15Min: math.Round((sumLoad15/count)*100) / 100, // 2 decimal places
			Status:    status,
			Timestamp: time.Now(),
		}

		result = append(result, partialHourEntry)

		// Keep only last 24 entries total (23 complete + 1 partial, or up to 24)
		if len(result) > 24 {
			result = result[len(result)-24:]
		}
	}

	return result
}
