package main

import (
	"math"
	"sync"
	"time"
)

// NTPHistory represents an aggregated NTP measurement entry (1-minute or 1-hour mean).
type NTPHistory struct {
	OffsetMs  float64   `json:"offset_ms"` // mean clock offset in milliseconds (signed)
	RTTMs     float64   `json:"rtt_ms"`    // mean round-trip time in milliseconds
	Synced    bool      `json:"synced"`    // true if all samples in this period were synced
	Stratum   uint8     `json:"stratum"`   // stratum of the NTP server (mode of samples)
	Timestamp time.Time `json:"timestamp"` // end of the aggregation period
}

// ntpSample is a single raw NTP poll result stored in the ring buffer.
type ntpSample struct {
	OffsetMs  float64
	RTTMs     float64
	Synced    bool
	Stratum   uint8
	Timestamp time.Time
}

// NTPHistoryTracker accumulates NTP poll results and provides 60-minute and
// 24-hour aggregated history, following the same three-tier pattern as
// LoadHistoryTracker.
//
// Since NTP polls every 64 seconds (~1 per minute), each poll result is stored
// directly as a sample.  Every minute the samples are aggregated into a
// 1-minute mean entry (up to 60 entries = 60 minutes).  Every hour the
// minute-level entries are aggregated into a 1-hour mean entry (up to 24
// entries = 24 hours).
type NTPHistoryTracker struct {
	mu sync.RWMutex

	// Raw poll results accumulated since the last 1-minute aggregation.
	samples []ntpSample

	// 1-minute aggregated history (up to 60 entries).
	history []NTPHistory

	// 1-hour aggregated history (up to 24 entries).
	hourlyHistory []NTPHistory

	aggregateTicker *time.Ticker
	hourlyTicker    *time.Ticker
	stopChan        chan struct{}
	wg              sync.WaitGroup
	running         bool
}

// globalNTPHistory is the singleton NTP history tracker started at boot.
var globalNTPHistory = &NTPHistoryTracker{
	stopChan: make(chan struct{}),
}

// Start begins the background aggregation goroutines.
func (t *NTPHistoryTracker) Start() {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.running {
		return
	}
	t.running = true

	t.samples = make([]ntpSample, 0, 8)
	t.history = make([]NTPHistory, 0, 60)
	t.hourlyHistory = make([]NTPHistory, 0, 24)

	t.aggregateTicker = time.NewTicker(1 * time.Minute)
	t.hourlyTicker = time.NewTicker(1 * time.Hour)

	t.wg.Add(2)
	go t.aggregateLoop()
	go t.hourlyAggregateLoop()
}

// Stop shuts down the background goroutines.
func (t *NTPHistoryTracker) Stop() {
	t.mu.Lock()
	if !t.running {
		t.mu.Unlock()
		return
	}
	t.running = false
	t.mu.Unlock()

	close(t.stopChan)
	if t.aggregateTicker != nil {
		t.aggregateTicker.Stop()
	}
	if t.hourlyTicker != nil {
		t.hourlyTicker.Stop()
	}
	t.wg.Wait()
}

// AddSample records a new NTP poll result.  Called by pollNTP() after each
// successful query.
func (t *NTPHistoryTracker) AddSample(offsetMs, rttMs float64, synced bool, stratum uint8) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.samples = append(t.samples, ntpSample{
		OffsetMs:  offsetMs,
		RTTMs:     rttMs,
		Synced:    synced,
		Stratum:   stratum,
		Timestamp: time.Now(),
	})

	// Safety cap: keep at most 8 samples per minute (64 s poll → ~1/min).
	if len(t.samples) > 8 {
		t.samples = t.samples[len(t.samples)-8:]
	}
}

// aggregateLoop fires every minute and computes a mean entry from accumulated
// samples, then appends it to the 60-minute history ring.
func (t *NTPHistoryTracker) aggregateLoop() {
	defer t.wg.Done()

	for {
		select {
		case <-t.stopChan:
			return
		case <-t.aggregateTicker.C:
			t.mu.Lock()
			if len(t.samples) > 0 {
				entry := aggregateNTPSamples(t.samples, time.Now())
				t.history = append(t.history, entry)
				if len(t.history) > 60 {
					t.history = t.history[len(t.history)-60:]
				}
				t.samples = t.samples[:0]
			}
			t.mu.Unlock()
		}
	}
}

// hourlyAggregateLoop fires every hour and computes a mean entry from the
// current minute-level history, then appends it to the 24-hour ring.
func (t *NTPHistoryTracker) hourlyAggregateLoop() {
	defer t.wg.Done()

	for {
		select {
		case <-t.stopChan:
			return
		case <-t.hourlyTicker.C:
			t.mu.Lock()
			if len(t.history) > 0 {
				// Convert []NTPHistory → []ntpSample for reuse of aggregation helper.
				pseudo := make([]ntpSample, len(t.history))
				for i, h := range t.history {
					pseudo[i] = ntpSample{
						OffsetMs:  h.OffsetMs,
						RTTMs:     h.RTTMs,
						Synced:    h.Synced,
						Stratum:   h.Stratum,
						Timestamp: h.Timestamp,
					}
				}
				entry := aggregateNTPSamples(pseudo, time.Now())
				t.hourlyHistory = append(t.hourlyHistory, entry)
				if len(t.hourlyHistory) > 24 {
					t.hourlyHistory = t.hourlyHistory[len(t.hourlyHistory)-24:]
				}
			}
			t.mu.Unlock()
		}
	}
}

// aggregateNTPSamples computes mean offset, mean RTT, majority-vote synced
// flag, and mode stratum from a slice of samples.
func aggregateNTPSamples(samples []ntpSample, ts time.Time) NTPHistory {
	var sumOffset, sumRTT float64
	syncedCount := 0
	stratumCounts := make(map[uint8]int)

	for _, s := range samples {
		sumOffset += s.OffsetMs
		sumRTT += s.RTTMs
		if s.Synced {
			syncedCount++
		}
		stratumCounts[s.Stratum]++
	}

	n := float64(len(samples))

	// Mode stratum (most frequent).
	var modeStratum uint8
	maxCount := 0
	for stratum, count := range stratumCounts {
		if count > maxCount {
			maxCount = count
			modeStratum = stratum
		}
	}

	return NTPHistory{
		OffsetMs:  math.Round((sumOffset/n)*100) / 100, // 2 decimal places
		RTTMs:     math.Round((sumRTT/n)*100) / 100,
		Synced:    syncedCount > len(samples)/2, // majority synced
		Stratum:   modeStratum,
		Timestamp: ts,
	}
}

// GetHistory returns the 60-minute history plus a partial entry for the
// current in-progress minute (if any samples have been collected).
func (t *NTPHistoryTracker) GetHistory() []NTPHistory {
	t.mu.RLock()
	defer t.mu.RUnlock()

	result := make([]NTPHistory, len(t.history))
	copy(result, t.history)

	// Append partial entry for the current minute so the chart shows data
	// immediately without waiting for the first aggregation tick.
	if len(t.samples) > 0 {
		partial := aggregateNTPSamples(t.samples, time.Now())
		result = append(result, partial)
		if len(result) > 60 {
			result = result[len(result)-60:]
		}
	}

	return result
}

// GetHourlyHistory returns the 24-hour history plus a partial entry for the
// current in-progress hour (derived from minute-level history).
func (t *NTPHistoryTracker) GetHourlyHistory() []NTPHistory {
	t.mu.RLock()
	defer t.mu.RUnlock()

	result := make([]NTPHistory, len(t.hourlyHistory))
	copy(result, t.hourlyHistory)

	// Append partial entry for the current hour from minute-level data.
	if len(t.history) > 0 {
		pseudo := make([]ntpSample, len(t.history))
		for i, h := range t.history {
			pseudo[i] = ntpSample{
				OffsetMs:  h.OffsetMs,
				RTTMs:     h.RTTMs,
				Synced:    h.Synced,
				Stratum:   h.Stratum,
				Timestamp: h.Timestamp,
			}
		}
		partial := aggregateNTPSamples(pseudo, time.Now())
		result = append(result, partial)
		if len(result) > 24 {
			result = result[len(result)-24:]
		}
	}

	return result
}
