package main

import (
	"fmt"
	"log"
	"os"
	"sort"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// AntSwitchScheduleEntry represents a single scheduled antenna switch action
type AntSwitchScheduleEntry struct {
	Time    string `yaml:"time"`    // Time in HH:MM format (24-hour) OR solar event name (e.g., "sunrise", "sunset")
	Antenna int    `yaml:"antenna"` // Antenna number to select (1-N); ignored when action is "ground"
	Action  string `yaml:"action"`  // "select" (default) or "ground"
	Enabled bool   `yaml:"enabled"` // Enable/disable this entry (default: true)
	Offset  int    `yaml:"offset"`  // Optional: minutes offset from solar event (+/- for after/before)
}

// AntSwitchScheduleConfig represents the configuration for scheduled antenna switching
type AntSwitchScheduleConfig struct {
	Enabled bool                     `yaml:"enabled"` // Enable/disable scheduled switching
	Entries []AntSwitchScheduleEntry `yaml:"entries"` // List of scheduled entries
}

// AntSwitchScheduleTriggerLog represents a single schedule trigger event
type AntSwitchScheduleTriggerLog struct {
	Timestamp time.Time `json:"timestamp"`
	Time      string    `json:"time"`            // Scheduled time (HH:MM or solar event)
	Antenna   int       `json:"antenna"`         // Target antenna (0 = ground)
	Action    string    `json:"action"`          // "select" or "ground"
	Success   bool      `json:"success"`         // Whether the trigger was successful
	Error     string    `json:"error,omitempty"` // Error message if failed
}

// AntSwitchScheduler manages scheduled antenna switching
type AntSwitchScheduler struct {
	config         *AntSwitchScheduleConfig
	handler        *AntSwitchHandler
	mu             sync.RWMutex
	stopChan       chan struct{}
	running        bool
	configPath     string
	triggerLogs    []AntSwitchScheduleTriggerLog // Circular buffer of up to 100 trigger events
	gpsLat         float64                       // GPS latitude for solar calculations
	gpsLon         float64                       // GPS longitude for solar calculations
	cachedSunTimes *SunTimes                     // Cached sun times for today
	lastSunCalc    time.Time                     // Last time sun times were calculated
}

// NewAntSwitchScheduler creates a new antenna switch scheduler
func NewAntSwitchScheduler(configPath string, handler *AntSwitchHandler, gpsLat, gpsLon float64) (*AntSwitchScheduler, error) {
	scheduler := &AntSwitchScheduler{
		handler:    handler,
		stopChan:   make(chan struct{}),
		configPath: configPath,
		gpsLat:     gpsLat,
		gpsLon:     gpsLon,
	}

	// Load configuration
	if err := scheduler.LoadConfig(); err != nil {
		return nil, fmt.Errorf("failed to load ant switch scheduler config: %w", err)
	}

	return scheduler, nil
}

// LoadConfig loads the scheduler configuration from the YAML file
func (as *AntSwitchScheduler) LoadConfig() error {
	as.mu.Lock()
	defer as.mu.Unlock()

	// Read config file
	data, err := os.ReadFile(as.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Config file doesn't exist - create default disabled config
			as.config = &AntSwitchScheduleConfig{
				Enabled: false,
				Entries: []AntSwitchScheduleEntry{},
			}
			log.Printf("Ant switch scheduler config not found at %s - scheduler disabled", as.configPath)
			return nil
		}
		return fmt.Errorf("failed to read config file: %w", err)
	}

	// Parse YAML
	var config AntSwitchScheduleConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("failed to parse config YAML: %w", err)
	}

	// Validate entries
	for i, entry := range config.Entries {
		if err := as.validateEntry(&entry); err != nil {
			return fmt.Errorf("invalid entry at index %d: %w", i, err)
		}
	}

	as.config = &config

	log.Printf("Loaded ant switch scheduler config: enabled=%v, entries=%d", config.Enabled, len(config.Entries))

	return nil
}

// validateEntry validates a scheduled entry
func (as *AntSwitchScheduler) validateEntry(entry *AntSwitchScheduleEntry) error {
	// Check if it's a solar event or fixed time
	if isSolarEvent(entry.Time) {
		// Solar event - validate offset range
		if entry.Offset < -120 || entry.Offset > 120 {
			return fmt.Errorf("offset %d out of range (must be -120 to +120 minutes)", entry.Offset)
		}
	} else {
		// Fixed time - validate time format (HH:MM)
		_, err := time.Parse("15:04", entry.Time)
		if err != nil {
			return fmt.Errorf("invalid time format '%s' (expected HH:MM or solar event name): %w", entry.Time, err)
		}
	}

	// Validate action
	action := entry.Action
	if action == "" {
		action = "select"
	}
	if action != "select" && action != "ground" {
		return fmt.Errorf("invalid action '%s' (must be 'select' or 'ground')", action)
	}

	// Validate antenna number when action is select
	if action == "select" && entry.Antenna < 1 {
		return fmt.Errorf("antenna number must be >= 1 for action 'select'")
	}

	return nil
}

// getSunTimesForTodayNoLock calculates sun times for today (cached)
// Note: This method does NOT acquire locks - caller must hold appropriate lock
func (as *AntSwitchScheduler) getSunTimesForTodayNoLock() *SunTimes {
	now := time.Now()

	// Check if we need to recalculate (cache is older than today)
	if as.cachedSunTimes == nil || !isSameDay(as.lastSunCalc, now) {
		// Calculate sun times for today
		as.cachedSunTimes = &SunTimes{}
		*as.cachedSunTimes = GetTimes(now, as.gpsLat, as.gpsLon)
		as.lastSunCalc = now
		log.Printf("Ant switch scheduler: calculated sun times for today: sunrise=%s, sunset=%s",
			as.cachedSunTimes.Sunrise.Format("15:04"), as.cachedSunTimes.Sunset.Format("15:04"))
	}

	return as.cachedSunTimes
}

// resolveEntryTime resolves an entry's time to HH:MM format
// Handles both fixed times (HH:MM) and solar events (sunrise, sunset, etc.)
// Note: Caller must NOT hold any locks
func (as *AntSwitchScheduler) resolveEntryTime(entry *AntSwitchScheduleEntry) (string, error) {
	// If it's a fixed time, return as-is
	if !isSolarEvent(entry.Time) {
		return entry.Time, nil
	}

	// It's a solar event - calculate the time
	as.mu.Lock()
	sunTimes := as.getSunTimesForTodayNoLock()
	as.mu.Unlock()

	return as.resolveEntryTimeNoLock(entry, sunTimes)
}

// resolveEntryTimeNoLock resolves an entry's time to HH:MM format
// Handles both fixed times (HH:MM) and solar events (sunrise, sunset, etc.)
// Note: This version takes pre-fetched sun times and does not acquire any locks
func (as *AntSwitchScheduler) resolveEntryTimeNoLock(entry *AntSwitchScheduleEntry, sunTimes *SunTimes) (string, error) {
	// If it's a fixed time, return as-is
	if !isSolarEvent(entry.Time) {
		return entry.Time, nil
	}

	// It's a solar event - calculate the time
	var eventTime time.Time
	switch entry.Time {
	case "sunrise":
		eventTime = sunTimes.Sunrise
	case "sunset":
		eventTime = sunTimes.Sunset
	case "dawn":
		eventTime = sunTimes.Dawn
	case "dusk":
		eventTime = sunTimes.Dusk
	case "sunriseEnd":
		eventTime = sunTimes.SunriseEnd
	case "sunsetStart":
		eventTime = sunTimes.SunsetStart
	case "solarNoon":
		eventTime = sunTimes.SolarNoon
	case "nadir":
		eventTime = sunTimes.Nadir
	case "goldenHour":
		eventTime = sunTimes.GoldenHour
	case "goldenHourEnd":
		eventTime = sunTimes.GoldenHourEnd
	case "nauticalDawn":
		eventTime = sunTimes.NauticalDawn
	case "nauticalDusk":
		eventTime = sunTimes.NauticalDusk
	case "nightEnd":
		eventTime = sunTimes.NightEnd
	case "night":
		eventTime = sunTimes.Night
	default:
		return "", fmt.Errorf("unknown solar event: %s", entry.Time)
	}

	// Apply offset if specified
	if entry.Offset != 0 {
		eventTime = eventTime.Add(time.Duration(entry.Offset) * time.Minute)
	}

	return eventTime.UTC().Format("15:04"), nil
}

// getAvailableSolarEventsWithTimes returns solar events with their current trigger times for today
// Note: Caller must NOT hold any locks
func (as *AntSwitchScheduler) getAvailableSolarEventsWithTimes() []map[string]interface{} {
	as.mu.Lock()
	sunTimes := as.getSunTimesForTodayNoLock()
	as.mu.Unlock()

	return as.getAvailableSolarEventsWithTimesNoLock(sunTimes)
}

// getAvailableSolarEventsWithTimesNoLock returns solar events with their current trigger times for today
// Note: This version takes pre-fetched sun times and does not acquire any locks
func (as *AntSwitchScheduler) getAvailableSolarEventsWithTimesNoLock(sunTimes *SunTimes) []map[string]interface{} {
	events := GetAvailableSolarEvents()

	result := make([]map[string]interface{}, len(events))
	for i, event := range events {
		var eventTime time.Time
		switch event.Name {
		case "sunrise":
			eventTime = sunTimes.Sunrise
		case "sunset":
			eventTime = sunTimes.Sunset
		case "dawn":
			eventTime = sunTimes.Dawn
		case "dusk":
			eventTime = sunTimes.Dusk
		case "sunriseEnd":
			eventTime = sunTimes.SunriseEnd
		case "sunsetStart":
			eventTime = sunTimes.SunsetStart
		case "solarNoon":
			eventTime = sunTimes.SolarNoon
		case "nadir":
			eventTime = sunTimes.Nadir
		case "goldenHour":
			eventTime = sunTimes.GoldenHour
		case "goldenHourEnd":
			eventTime = sunTimes.GoldenHourEnd
		case "nauticalDawn":
			eventTime = sunTimes.NauticalDawn
		case "nauticalDusk":
			eventTime = sunTimes.NauticalDusk
		case "nightEnd":
			eventTime = sunTimes.NightEnd
		case "night":
			eventTime = sunTimes.Night
		}

		eventMap := map[string]interface{}{
			"name":         event.Name,
			"display_name": event.DisplayName,
			"description":  event.Description,
		}
		if !eventTime.IsZero() {
			eventMap["time"] = eventTime.UTC().Format("15:04")
		}
		result[i] = eventMap
	}

	return result
}

// Start starts the scheduler background task
func (as *AntSwitchScheduler) Start() error {
	as.mu.Lock()
	defer as.mu.Unlock()

	if as.running {
		return fmt.Errorf("ant switch scheduler already running")
	}

	if !as.config.Enabled {
		log.Printf("Ant switch scheduler is disabled in configuration")
		return nil
	}

	if len(as.config.Entries) == 0 {
		log.Printf("Ant switch scheduler has no entries configured")
		return nil
	}

	as.running = true
	go as.schedulerLoop()

	log.Printf("Ant switch scheduler started with %d scheduled entries", len(as.config.Entries))
	return nil
}

// Stop stops the scheduler background task
func (as *AntSwitchScheduler) Stop() {
	as.mu.Lock()
	defer as.mu.Unlock()

	if !as.running {
		return
	}

	close(as.stopChan)
	as.running = false
	log.Printf("Ant switch scheduler stopped")
}

// schedulerLoop is the main scheduler loop that runs in the background
func (as *AntSwitchScheduler) schedulerLoop() {
	// Calculate delay until the next minute boundary to align with clock
	now := time.Now()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	initialDelay := nextMinute.Sub(now)

	log.Printf("Ant switch scheduler: aligning to minute boundary (waiting %v until %s)",
		initialDelay.Round(time.Second), nextMinute.Format("15:04:05"))

	// Wait until the next minute boundary before starting ticker
	time.Sleep(initialDelay)

	// Now create ticker that fires every minute (already aligned to :00 seconds)
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	// Check immediately (we're now at a minute boundary)
	as.checkScheduledEntries()

	for {
		select {
		case <-ticker.C:
			as.checkScheduledEntries()
		case <-as.stopChan:
			return
		}
	}
}

// checkScheduledEntries checks if any entries should be executed now
func (as *AntSwitchScheduler) checkScheduledEntries() {
	as.mu.RLock()
	if !as.config.Enabled {
		as.mu.RUnlock()
		return
	}

	if len(as.config.Entries) == 0 {
		as.mu.RUnlock()
		return
	}

	// Get current time in HH:MM format (UTC, matching resolveEntryTimeNoLock output)
	now := time.Now().UTC()
	currentTime := now.Format("15:04")

	// Copy entries for processing outside lock
	entries := make([]AntSwitchScheduleEntry, len(as.config.Entries))
	copy(entries, as.config.Entries)
	as.mu.RUnlock()

	for _, entry := range entries {
		// Skip disabled entries
		if !entry.Enabled {
			continue
		}

		// Resolve entry time (handles both fixed times and solar events)
		resolvedTime, err := as.resolveEntryTime(&entry)
		if err != nil {
			log.Printf("Error resolving entry time for '%s': %v", entry.Time, err)
			continue
		}

		if resolvedTime == currentTime {
			as.executeScheduledEntry(&entry)
		}
	}
}

// executeScheduledEntry executes a scheduled antenna switch action
func (as *AntSwitchScheduler) executeScheduledEntry(entry *AntSwitchScheduleEntry) {
	action := entry.Action
	if action == "" {
		action = "select"
	}

	triggerLog := AntSwitchScheduleTriggerLog{
		Timestamp: time.Now(),
		Time:      entry.Time,
		Antenna:   entry.Antenna,
		Action:    action,
		Success:   false,
	}

	if action == "ground" {
		log.Printf("Ant switch scheduler: executing ground all (time=%s)", entry.Time)
		_, _, err := as.handler.groundAll()
		if err != nil {
			triggerLog.Error = err.Error()
			as.addTriggerLog(triggerLog)
			log.Printf("Ant switch scheduler: failed to ground all (time=%s): %v", entry.Time, err)
			return
		}
		triggerLog.Success = true
		as.addTriggerLog(triggerLog)
		log.Printf("Ant switch scheduler: successfully grounded all antennas")
	} else {
		log.Printf("Ant switch scheduler: executing select antenna %d (time=%s)", entry.Antenna, entry.Time)
		_, _, err := as.handler.selectAntenna(entry.Antenna)
		if err != nil {
			triggerLog.Error = err.Error()
			as.addTriggerLog(triggerLog)
			log.Printf("Ant switch scheduler: failed to select antenna %d (time=%s): %v", entry.Antenna, entry.Time, err)
			return
		}
		triggerLog.Success = true
		as.addTriggerLog(triggerLog)
		log.Printf("Ant switch scheduler: successfully selected antenna %d", entry.Antenna)
	}
}

// addTriggerLog adds a trigger log entry, maintaining a maximum of 100 entries
func (as *AntSwitchScheduler) addTriggerLog(entry AntSwitchScheduleTriggerLog) {
	as.mu.Lock()
	defer as.mu.Unlock()

	as.triggerLogs = append(as.triggerLogs, entry)

	// Keep only the last 100 entries
	if len(as.triggerLogs) > 100 {
		as.triggerLogs = as.triggerLogs[len(as.triggerLogs)-100:]
	}
}

// GetTriggerLogs returns the trigger logs (most recent first)
func (as *AntSwitchScheduler) GetTriggerLogs() []AntSwitchScheduleTriggerLog {
	as.mu.RLock()
	defer as.mu.RUnlock()

	// Return a copy in reverse order (most recent first)
	logs := make([]AntSwitchScheduleTriggerLog, len(as.triggerLogs))
	for i, l := range as.triggerLogs {
		logs[len(as.triggerLogs)-1-i] = l
	}

	return logs
}

// GetStatus returns the current scheduler status
func (as *AntSwitchScheduler) GetStatus() map[string]interface{} {
	as.mu.RLock()

	// Count enabled entries
	enabledCount := 0
	for _, entry := range as.config.Entries {
		if entry.Enabled {
			enabledCount++
		}
	}

	enabled := as.config.Enabled
	running := as.running
	entryCount := len(as.config.Entries)

	// Copy entries for processing outside lock
	entriesCopy := make([]AntSwitchScheduleEntry, len(as.config.Entries))
	copy(entriesCopy, as.config.Entries)

	// Get sun times while we have the lock
	sunTimes := as.getSunTimesForTodayNoLock()

	as.mu.RUnlock()

	// Get solar events with times (pass sun times to avoid re-locking)
	solarEvents := as.getAvailableSolarEventsWithTimesNoLock(sunTimes)

	status := map[string]interface{}{
		"enabled":             enabled,
		"running":             running,
		"entry_count":         entryCount,
		"enabled_entry_count": enabledCount,
		"solar_events":        solarEvents,
	}

	// Process entries (no lock needed - using copy)
	entries := make([]map[string]interface{}, len(entriesCopy))
	for i, entry := range entriesCopy {
		action := entry.Action
		if action == "" {
			action = "select"
		}
		entryMap := map[string]interface{}{
			"time":    entry.Time,
			"antenna": entry.Antenna,
			"action":  action,
			"enabled": entry.Enabled,
		}
		// Add offset if it's a solar event
		if isSolarEvent(entry.Time) && entry.Offset != 0 {
			entryMap["offset"] = entry.Offset
		}
		// Add resolved time for display (pass sun times to avoid locking)
		if resolvedTime, err := as.resolveEntryTimeNoLock(&entry, sunTimes); err == nil {
			entryMap["resolved_time"] = resolvedTime
		}
		entries[i] = entryMap
	}
	status["entries"] = entries

	// Add next scheduled entry only if enabled and has entries
	if enabled && len(entriesCopy) > 0 {
		nextEntry := as.getNextScheduledEntryNoLock(entriesCopy, sunTimes)
		if nextEntry != nil {
			action := nextEntry.Action
			if action == "" {
				action = "select"
			}
			nextEntryMap := map[string]interface{}{
				"time":    nextEntry.Time,
				"antenna": nextEntry.Antenna,
				"action":  action,
			}
			if resolvedTime, err := as.resolveEntryTimeNoLock(nextEntry, sunTimes); err == nil {
				nextEntryMap["resolved_time"] = resolvedTime
			}
			status["next_entry"] = nextEntryMap
		}
	}

	return status
}

// getNextScheduledEntryNoLock returns the next scheduled entry without acquiring locks
// Takes pre-fetched entries and sun times
func (as *AntSwitchScheduler) getNextScheduledEntryNoLock(entries []AntSwitchScheduleEntry, sunTimes *SunTimes) *AntSwitchScheduleEntry {
	if len(entries) == 0 {
		return nil
	}

	now := time.Now().UTC()
	currentMinutes := now.Hour()*60 + now.Minute()

	// Convert all ENABLED entries to minutes since midnight and sort
	type entryWithMinutes struct {
		entry   AntSwitchScheduleEntry
		minutes int
	}

	entriesWithMinutes := make([]entryWithMinutes, 0, len(entries))
	for _, entry := range entries {
		// Skip disabled entries
		if !entry.Enabled {
			continue
		}

		// Resolve entry time (handles both fixed times and solar events) - use no-lock version
		resolvedTime, err := as.resolveEntryTimeNoLock(&entry, sunTimes)
		if err != nil {
			log.Printf("Error resolving entry time for '%s': %v", entry.Time, err)
			continue
		}

		t, err := time.Parse("15:04", resolvedTime)
		if err != nil {
			continue
		}
		minutes := t.Hour()*60 + t.Minute()
		entriesWithMinutes = append(entriesWithMinutes, entryWithMinutes{
			entry:   entry,
			minutes: minutes,
		})
	}

	// Sort by time
	sort.Slice(entriesWithMinutes, func(i, j int) bool {
		return entriesWithMinutes[i].minutes < entriesWithMinutes[j].minutes
	})

	// Find next enabled entry after current time
	for _, ewm := range entriesWithMinutes {
		if ewm.minutes > currentMinutes {
			return &ewm.entry
		}
	}

	// If no entry found after current time, return first enabled entry (tomorrow)
	if len(entriesWithMinutes) > 0 {
		return &entriesWithMinutes[0].entry
	}

	return nil
}

// Reload reloads the configuration from disk
func (as *AntSwitchScheduler) Reload() error {
	wasRunning := false

	as.mu.Lock()
	wasRunning = as.running
	as.mu.Unlock()

	// Stop if running
	if wasRunning {
		as.Stop()
		// Recreate the stop channel for next start
		as.stopChan = make(chan struct{})
	}

	// Reload config
	if err := as.LoadConfig(); err != nil {
		return err
	}

	// Start if enabled and has entries (regardless of whether it was running before)
	// This allows the scheduler to start when enabled is toggled from false to true
	as.mu.RLock()
	shouldStart := as.config.Enabled && len(as.config.Entries) > 0
	as.mu.RUnlock()

	if shouldStart {
		return as.Start()
	}

	return nil
}
