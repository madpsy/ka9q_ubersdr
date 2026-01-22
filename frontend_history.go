package main

import (
	"log"
	"math"
	"sync"
	"time"
)

// FrontendHistoryTracker tracks historical frontend metrics (RF Gain, IF Power, A/D Overranges)
// Uses the same three-tier aggregation pattern as FrequencyReferenceMonitor
type FrontendHistoryTracker struct {
	statusTracker *FrontendStatusTracker
	widebandSSRC  uint32 // SSRC of wideband spectrum channel to track

	// Historical tracking (1-second samples, 1-minute means, 1-hour means)
	samples       []FrontendSample  // Current minute's samples (up to 60)
	history       []FrontendHistory // Historical minute means (up to 60)
	hourlyHistory []FrontendHistory // Historical hour means (up to 24)
	historyMu     sync.RWMutex

	// Overrange rate calculation
	lastOverrangeCount int64
	lastOverrangeTime  time.Time
	overrangeMu        sync.Mutex

	// Tickers for sampling and aggregation
	sampleTicker    *time.Ticker
	aggregateTicker *time.Ticker
	hourlyTicker    *time.Ticker

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// FrontendSample represents a single 1-second sample
type FrontendSample struct {
	RFGain           float32
	IFPower          float32
	ADOverranges     int64   // Cumulative count
	OverrangeRate    float64 // Overranges per second (calculated delta)
	SamplesSinceOver int64
	Timestamp        time.Time
}

// FrontendHistory represents aggregated 1-minute or 1-hour mean values
type FrontendHistory struct {
	RFGain           float32   `json:"rf_gain"`
	IFPower          float32   `json:"if_power"`
	ADOverranges     int64     `json:"ad_overranges"`      // Cumulative at end of period
	OverrangeRate    float64   `json:"overrange_rate"`     // Mean rate (overranges/sec)
	SamplesSinceOver int64     `json:"samples_since_over"` // At end of period
	Timestamp        time.Time `json:"timestamp"`
}

// NewFrontendHistoryTracker creates a new frontend history tracker
func NewFrontendHistoryTracker(statusTracker *FrontendStatusTracker, widebandSSRC uint32) *FrontendHistoryTracker {
	return &FrontendHistoryTracker{
		statusTracker: statusTracker,
		widebandSSRC:  widebandSSRC,
		stopChan:      make(chan struct{}),
	}
}

// Start begins frontend history tracking
func (fht *FrontendHistoryTracker) Start() error {
	if fht.running {
		return nil
	}

	fht.running = true

	// Initialize historical tracking
	fht.samples = make([]FrontendSample, 0, 60)
	fht.history = make([]FrontendHistory, 0, 60)
	fht.hourlyHistory = make([]FrontendHistory, 0, 24)
	fht.sampleTicker = time.NewTicker(1 * time.Second)
	fht.aggregateTicker = time.NewTicker(1 * time.Minute)
	fht.hourlyTicker = time.NewTicker(1 * time.Hour)

	// Initialize overrange tracking
	status := fht.statusTracker.GetFrontendStatus(fht.widebandSSRC)
	if status != nil {
		fht.lastOverrangeCount = status.ADOverranges
		fht.lastOverrangeTime = time.Now()
	}

	// Start sampling loop
	fht.wg.Add(1)
	go fht.sampleLoop()

	// Start aggregation loop
	fht.wg.Add(1)
	go fht.aggregateLoop()

	// Start hourly aggregation loop
	fht.wg.Add(1)
	go fht.hourlyAggregateLoop()

	log.Printf("Frontend history tracker started (tracking SSRC 0x%08x)", fht.widebandSSRC)

	return nil
}

// Stop shuts down the frontend history tracker
func (fht *FrontendHistoryTracker) Stop() {
	if !fht.running {
		return
	}

	fht.running = false
	close(fht.stopChan)

	// Stop tickers
	if fht.sampleTicker != nil {
		fht.sampleTicker.Stop()
	}
	if fht.aggregateTicker != nil {
		fht.aggregateTicker.Stop()
	}
	if fht.hourlyTicker != nil {
		fht.hourlyTicker.Stop()
	}

	fht.wg.Wait()

	log.Printf("Frontend history tracker stopped")
}

// sampleLoop collects samples every 1 second
func (fht *FrontendHistoryTracker) sampleLoop() {
	defer fht.wg.Done()

	for {
		select {
		case <-fht.stopChan:
			return

		case <-fht.sampleTicker.C:
			// Get current frontend status
			status := fht.statusTracker.GetFrontendStatus(fht.widebandSSRC)
			if status == nil {
				continue // No status available yet
			}

			// Calculate overrange rate (delta since last sample)
			overrangeRate := fht.calculateOverrangeRate(status)

			sample := FrontendSample{
				RFGain:           status.RFGain,
				IFPower:          status.IFPower,
				ADOverranges:     status.ADOverranges,
				OverrangeRate:    overrangeRate,
				SamplesSinceOver: status.SamplesSinceOver,
				Timestamp:        time.Now(),
			}

			// Add to current minute's samples
			fht.historyMu.Lock()
			fht.samples = append(fht.samples, sample)
			// Keep only last 60 samples (shouldn't exceed this, but safety check)
			if len(fht.samples) > 60 {
				fht.samples = fht.samples[len(fht.samples)-60:]
			}
			fht.historyMu.Unlock()
		}
	}
}

// calculateOverrangeRate calculates the overrange rate (overranges per second)
// by comparing current count with previous count
func (fht *FrontendHistoryTracker) calculateOverrangeRate(status *FrontendStatus) float64 {
	fht.overrangeMu.Lock()
	defer fht.overrangeMu.Unlock()

	now := time.Now()
	currentCount := status.ADOverranges

	// Calculate delta
	deltaCount := currentCount - fht.lastOverrangeCount
	deltaTime := now.Sub(fht.lastOverrangeTime).Seconds()

	// Update tracking
	fht.lastOverrangeCount = currentCount
	fht.lastOverrangeTime = now

	// Calculate rate (handle edge cases)
	if deltaTime <= 0 || deltaCount < 0 {
		return 0 // Invalid or counter reset
	}

	return float64(deltaCount) / deltaTime
}

// aggregateLoop calculates mean values every 1 minute
func (fht *FrontendHistoryTracker) aggregateLoop() {
	defer fht.wg.Done()

	for {
		select {
		case <-fht.stopChan:
			return

		case <-fht.aggregateTicker.C:
			fht.historyMu.Lock()

			// Calculate means from samples if we have any
			if len(fht.samples) > 0 {
				var sumRFGain float32
				var sumIFPower float32
				var sumOverrangeRate float64
				var lastOverrangeCount int64
				var lastSamplesSinceOver int64

				for _, sample := range fht.samples {
					sumRFGain += sample.RFGain
					sumIFPower += sample.IFPower
					sumOverrangeRate += sample.OverrangeRate
					lastOverrangeCount = sample.ADOverranges // Use last value
					lastSamplesSinceOver = sample.SamplesSinceOver
				}

				count := float32(len(fht.samples))
				countFloat64 := float64(len(fht.samples))

				historyEntry := FrontendHistory{
					RFGain:           sumRFGain / count,
					IFPower:          sumIFPower / count,
					ADOverranges:     lastOverrangeCount,
					OverrangeRate:    sumOverrangeRate / countFloat64,
					SamplesSinceOver: lastSamplesSinceOver,
					Timestamp:        time.Now(),
				}

				// Add to history
				fht.history = append(fht.history, historyEntry)

				// Keep only last 60 entries (60 minutes)
				if len(fht.history) > 60 {
					fht.history = fht.history[len(fht.history)-60:]
				}

				// Clear samples for next minute
				fht.samples = fht.samples[:0]
			}

			fht.historyMu.Unlock()
		}
	}
}

// hourlyAggregateLoop calculates mean values every 1 hour from minute-level history
func (fht *FrontendHistoryTracker) hourlyAggregateLoop() {
	defer fht.wg.Done()

	for {
		select {
		case <-fht.stopChan:
			return

		case <-fht.hourlyTicker.C:
			fht.historyMu.Lock()

			// Calculate means from the last 60 minute entries if we have any
			if len(fht.history) > 0 {
				var sumRFGain float32
				var sumIFPower float32
				var sumOverrangeRate float64
				var lastOverrangeCount int64
				var lastSamplesSinceOver int64

				for _, entry := range fht.history {
					sumRFGain += entry.RFGain
					sumIFPower += entry.IFPower
					sumOverrangeRate += entry.OverrangeRate
					lastOverrangeCount = entry.ADOverranges // Use last value
					lastSamplesSinceOver = entry.SamplesSinceOver
				}

				count := float32(len(fht.history))
				countFloat64 := float64(len(fht.history))

				hourlyEntry := FrontendHistory{
					RFGain:           sumRFGain / count,
					IFPower:          sumIFPower / count,
					ADOverranges:     lastOverrangeCount,
					OverrangeRate:    sumOverrangeRate / countFloat64,
					SamplesSinceOver: lastSamplesSinceOver,
					Timestamp:        time.Now(),
				}

				// Add to hourly history
				fht.hourlyHistory = append(fht.hourlyHistory, hourlyEntry)

				// Keep only last 24 entries (24 hours)
				if len(fht.hourlyHistory) > 24 {
					fht.hourlyHistory = fht.hourlyHistory[len(fht.hourlyHistory)-24:]
				}
			}

			fht.historyMu.Unlock()
		}
	}
}

// GetHistory returns the historical frontend data (up to 60 minutes)
func (fht *FrontendHistoryTracker) GetHistory() []FrontendHistory {
	if fht == nil {
		return nil
	}

	fht.historyMu.RLock()
	defer fht.historyMu.RUnlock()

	// Return a copy with rounded values for display
	historyCopy := make([]FrontendHistory, len(fht.history))
	for i, entry := range fht.history {
		historyCopy[i] = FrontendHistory{
			RFGain:           float32(math.Round(float64(entry.RFGain)*10) / 10),  // 1 decimal place
			IFPower:          float32(math.Round(float64(entry.IFPower)*10) / 10), // 1 decimal place
			ADOverranges:     entry.ADOverranges,                                  // Integer
			OverrangeRate:    math.Round(entry.OverrangeRate*100) / 100,           // 2 decimal places
			SamplesSinceOver: entry.SamplesSinceOver,                              // Integer
			Timestamp:        entry.Timestamp,
		}
	}

	return historyCopy
}

// GetHourlyHistory returns the hourly aggregated frontend data (up to 24 hours)
// Includes a partial entry for the current hour calculated from available minute-level data
func (fht *FrontendHistoryTracker) GetHourlyHistory() []FrontendHistory {
	if fht == nil {
		return nil
	}

	fht.historyMu.RLock()
	defer fht.historyMu.RUnlock()

	// Start with a copy of stored complete hours with rounded values
	result := make([]FrontendHistory, len(fht.hourlyHistory))
	for i, entry := range fht.hourlyHistory {
		result[i] = FrontendHistory{
			RFGain:           float32(math.Round(float64(entry.RFGain)*10) / 10),  // 1 decimal place
			IFPower:          float32(math.Round(float64(entry.IFPower)*10) / 10), // 1 decimal place
			ADOverranges:     entry.ADOverranges,                                  // Integer
			OverrangeRate:    math.Round(entry.OverrangeRate*100) / 100,           // 2 decimal places
			SamplesSinceOver: entry.SamplesSinceOver,                              // Integer
			Timestamp:        entry.Timestamp,
		}
	}

	// Calculate and append current partial hour from minute-level history
	if len(fht.history) > 0 {
		var sumRFGain float32
		var sumIFPower float32
		var sumOverrangeRate float64
		var lastOverrangeCount int64
		var lastSamplesSinceOver int64

		for _, entry := range fht.history {
			sumRFGain += entry.RFGain
			sumIFPower += entry.IFPower
			sumOverrangeRate += entry.OverrangeRate
			lastOverrangeCount = entry.ADOverranges
			lastSamplesSinceOver = entry.SamplesSinceOver
		}

		count := float32(len(fht.history))
		countFloat64 := float64(len(fht.history))

		partialHourEntry := FrontendHistory{
			RFGain:           float32(math.Round(float64(sumRFGain/count)*10) / 10),  // 1 decimal place
			IFPower:          float32(math.Round(float64(sumIFPower/count)*10) / 10), // 1 decimal place
			ADOverranges:     lastOverrangeCount,                                     // Integer
			OverrangeRate:    math.Round((sumOverrangeRate/countFloat64)*100) / 100,  // 2 decimal places
			SamplesSinceOver: lastSamplesSinceOver,                                   // Integer
			Timestamp:        time.Now(),
		}

		result = append(result, partialHourEntry)

		// Keep only last 24 entries total (23 complete + 1 partial, or up to 24)
		if len(result) > 24 {
			result = result[len(result)-24:]
		}
	}

	return result
}
