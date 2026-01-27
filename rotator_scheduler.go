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

// ScheduledPosition represents a single scheduled rotator position
type ScheduledPosition struct {
	Time    string  `yaml:"time"`    // Time in HH:MM format (24-hour) OR solar event name (e.g., "sunrise", "sunset")
	Bearing float64 `yaml:"bearing"` // Azimuth bearing in degrees (0-360)
	Enabled bool    `yaml:"enabled"` // Enable/disable this position (default: true)
	Offset  int     `yaml:"offset"`  // Optional: minutes offset from solar event (+/- for after/before)
}

// SolarEvent represents a solar event trigger option
type SolarEvent struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
}

// RotatorScheduleConfig represents the configuration for scheduled rotator positions
type RotatorScheduleConfig struct {
	Enabled   bool                `yaml:"enabled"`   // Enable/disable scheduled positioning
	Positions []ScheduledPosition `yaml:"positions"` // List of scheduled positions
}

// ScheduleTriggerLog represents a single schedule trigger event
type ScheduleTriggerLog struct {
	Timestamp time.Time `json:"timestamp"`
	Time      string    `json:"time"`            // Scheduled time (HH:MM)
	Bearing   float64   `json:"bearing"`         // Target bearing
	Success   bool      `json:"success"`         // Whether the trigger was successful
	Error     string    `json:"error,omitempty"` // Error message if failed
}

// RotatorScheduler manages scheduled rotator positioning
type RotatorScheduler struct {
	config         *RotatorScheduleConfig
	controller     *RotatorController
	mu             sync.RWMutex
	stopChan       chan struct{}
	running        bool
	configPath     string
	triggerLogs    []ScheduleTriggerLog // Circular buffer of up to 100 trigger events
	gpsLat         float64              // GPS latitude for solar calculations
	gpsLon         float64              // GPS longitude for solar calculations
	cachedSunTimes *SunTimes            // Cached sun times for today
	lastSunCalc    time.Time            // Last time sun times were calculated
}

// GetAvailableSolarEvents returns the list of available solar event triggers
func GetAvailableSolarEvents() []SolarEvent {
	return []SolarEvent{
		{Name: "sunrise", DisplayName: "Sunrise", Description: "Sun rises above horizon (gray-line propagation)"},
		{Name: "sunset", DisplayName: "Sunset", Description: "Sun sets below horizon (gray-line propagation)"},
		{Name: "dawn", DisplayName: "Dawn", Description: "Civil dawn - sun at -6° (twilight begins)"},
		{Name: "dusk", DisplayName: "Dusk", Description: "Civil dusk - sun at -6° (twilight ends)"},
		{Name: "sunriseEnd", DisplayName: "Sunrise End", Description: "Sun fully above horizon"},
		{Name: "sunsetStart", DisplayName: "Sunset Start", Description: "Sun begins setting"},
		{Name: "solarNoon", DisplayName: "Solar Noon", Description: "Sun at highest point (peak daytime ionization)"},
		{Name: "nadir", DisplayName: "Nadir", Description: "Sun at lowest point (deepest night)"},
		{Name: "goldenHour", DisplayName: "Golden Hour", Description: "Evening golden hour begins"},
		{Name: "goldenHourEnd", DisplayName: "Golden Hour End", Description: "Morning golden hour ends"},
		{Name: "nauticalDawn", DisplayName: "Nautical Dawn", Description: "Sun at -12° (nautical twilight)"},
		{Name: "nauticalDusk", DisplayName: "Nautical Dusk", Description: "Sun at -12° (nautical twilight)"},
		{Name: "nightEnd", DisplayName: "Night End", Description: "Astronomical twilight begins - sun at -18°"},
		{Name: "night", DisplayName: "Night", Description: "Astronomical twilight ends - sun at -18°"},
	}
}

// isSolarEvent checks if a time string is a solar event name
func isSolarEvent(timeStr string) bool {
	events := GetAvailableSolarEvents()
	for _, event := range events {
		if event.Name == timeStr {
			return true
		}
	}
	return false
}

// NewRotatorScheduler creates a new rotator scheduler
func NewRotatorScheduler(configPath string, controller *RotatorController, gpsLat, gpsLon float64) (*RotatorScheduler, error) {
	scheduler := &RotatorScheduler{
		controller: controller,
		stopChan:   make(chan struct{}),
		configPath: configPath,
		gpsLat:     gpsLat,
		gpsLon:     gpsLon,
	}

	// Load configuration
	if err := scheduler.LoadConfig(); err != nil {
		return nil, fmt.Errorf("failed to load scheduler config: %w", err)
	}

	return scheduler, nil
}

// LoadConfig loads the scheduler configuration from the YAML file
func (rs *RotatorScheduler) LoadConfig() error {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	// Read config file
	data, err := os.ReadFile(rs.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Config file doesn't exist - create default disabled config
			rs.config = &RotatorScheduleConfig{
				Enabled:   false,
				Positions: []ScheduledPosition{},
			}
			log.Printf("Rotator scheduler config not found at %s - scheduler disabled", rs.configPath)
			return nil
		}
		return fmt.Errorf("failed to read config file: %w", err)
	}

	// Parse YAML
	var config RotatorScheduleConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("failed to parse config YAML: %w", err)
	}

	// Validate positions
	for i, pos := range config.Positions {
		if err := rs.validatePosition(&pos); err != nil {
			return fmt.Errorf("invalid position at index %d: %w", i, err)
		}
	}

	rs.config = &config
	log.Printf("Loaded rotator scheduler config: enabled=%v, positions=%d", config.Enabled, len(config.Positions))

	return nil
}

// validatePosition validates a scheduled position
func (rs *RotatorScheduler) validatePosition(pos *ScheduledPosition) error {
	// Check if it's a solar event or fixed time
	if isSolarEvent(pos.Time) {
		// Solar event - validate offset range
		if pos.Offset < -120 || pos.Offset > 120 {
			return fmt.Errorf("offset %d out of range (must be -120 to +120 minutes)", pos.Offset)
		}
	} else {
		// Fixed time - validate time format (HH:MM)
		_, err := time.Parse("15:04", pos.Time)
		if err != nil {
			return fmt.Errorf("invalid time format '%s' (expected HH:MM or solar event name): %w", pos.Time, err)
		}
	}

	// Validate bearing range
	if pos.Bearing < 0 || pos.Bearing > 360 {
		return fmt.Errorf("bearing %.2f out of range (must be 0-360)", pos.Bearing)
	}

	return nil
}

// getSunTimesForToday calculates sun times for today (cached)
func (rs *RotatorScheduler) getSunTimesForToday() *SunTimes {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	now := time.Now()

	// Check if we need to recalculate (cache is older than today)
	if rs.cachedSunTimes == nil || !isSameDay(rs.lastSunCalc, now) {
		// Calculate sun times for today
		rs.cachedSunTimes = &SunTimes{}
		*rs.cachedSunTimes = GetTimes(now, rs.gpsLat, rs.gpsLon)
		rs.lastSunCalc = now
		log.Printf("Calculated sun times for today: sunrise=%s, sunset=%s",
			rs.cachedSunTimes.Sunrise.Format("15:04"), rs.cachedSunTimes.Sunset.Format("15:04"))
	}

	return rs.cachedSunTimes
}

// isSameDay checks if two times are on the same day
func isSameDay(t1, t2 time.Time) bool {
	y1, m1, d1 := t1.Date()
	y2, m2, d2 := t2.Date()
	return y1 == y2 && m1 == m2 && d1 == d2
}

// resolvePositionTime resolves a position's time to HH:MM format
// Handles both fixed times (HH:MM) and solar events (sunrise, sunset, etc.)
func (rs *RotatorScheduler) resolvePositionTime(pos *ScheduledPosition) (string, error) {
	// If it's a fixed time, return as-is
	if !isSolarEvent(pos.Time) {
		return pos.Time, nil
	}

	// It's a solar event - calculate the time
	sunTimes := rs.getSunTimesForToday()

	var eventTime time.Time
	switch pos.Time {
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
		return "", fmt.Errorf("unknown solar event: %s", pos.Time)
	}

	// Apply offset if specified
	if pos.Offset != 0 {
		eventTime = eventTime.Add(time.Duration(pos.Offset) * time.Minute)
	}

	return eventTime.Format("15:04"), nil
}

// Start starts the scheduler background task
func (rs *RotatorScheduler) Start() error {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	if rs.running {
		return fmt.Errorf("scheduler already running")
	}

	if !rs.config.Enabled {
		log.Printf("Rotator scheduler is disabled in configuration")
		return nil
	}

	if len(rs.config.Positions) == 0 {
		log.Printf("Rotator scheduler has no positions configured")
		return nil
	}

	rs.running = true
	go rs.schedulerLoop()

	log.Printf("Rotator scheduler started with %d scheduled positions", len(rs.config.Positions))
	return nil
}

// Stop stops the scheduler background task
func (rs *RotatorScheduler) Stop() {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	if !rs.running {
		return
	}

	close(rs.stopChan)
	rs.running = false
	log.Printf("Rotator scheduler stopped")
}

// schedulerLoop is the main scheduler loop that runs in the background
func (rs *RotatorScheduler) schedulerLoop() {
	// Check every minute for scheduled positions
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	// Also check immediately on startup
	rs.checkScheduledPositions()

	for {
		select {
		case <-ticker.C:
			rs.checkScheduledPositions()
		case <-rs.stopChan:
			return
		}
	}
}

// checkScheduledPositions checks if any positions should be executed now
func (rs *RotatorScheduler) checkScheduledPositions() {
	rs.mu.RLock()
	if !rs.config.Enabled || len(rs.config.Positions) == 0 {
		rs.mu.RUnlock()
		return
	}

	// Get current time in HH:MM format
	now := time.Now()
	currentTime := now.Format("15:04")

	// Check each scheduled position
	positions := make([]ScheduledPosition, len(rs.config.Positions))
	copy(positions, rs.config.Positions)
	rs.mu.RUnlock()

	for _, pos := range positions {
		// Skip disabled positions
		if !pos.Enabled {
			continue
		}

		// Resolve position time (handles both fixed times and solar events)
		resolvedTime, err := rs.resolvePositionTime(&pos)
		if err != nil {
			log.Printf("Error resolving position time for '%s': %v", pos.Time, err)
			continue
		}

		if resolvedTime == currentTime {
			rs.executeScheduledPosition(&pos)
		}
	}
}

// executeScheduledPosition executes a scheduled position change
func (rs *RotatorScheduler) executeScheduledPosition(pos *ScheduledPosition) {
	triggerLog := ScheduleTriggerLog{
		Timestamp: time.Now(),
		Time:      pos.Time,
		Bearing:   pos.Bearing,
		Success:   false,
	}

	// Check if rotator is connected
	if !rs.controller.client.IsConnected() {
		triggerLog.Error = "rotator not connected"
		rs.addTriggerLog(triggerLog)
		log.Printf("Skipping scheduled position (time=%s, bearing=%.0f°) - rotator not connected",
			pos.Time, pos.Bearing)
		return
	}

	log.Printf("Executing scheduled position: time=%s, bearing=%.0f°", pos.Time, pos.Bearing)

	// Set the azimuth (keeping current elevation)
	if err := rs.controller.SetAzimuth(pos.Bearing); err != nil {
		triggerLog.Error = err.Error()
		rs.addTriggerLog(triggerLog)
		log.Printf("Failed to set scheduled position (time=%s, bearing=%.0f°): %v",
			pos.Time, pos.Bearing, err)
		return
	}

	triggerLog.Success = true
	rs.addTriggerLog(triggerLog)
	log.Printf("Successfully set rotator to scheduled bearing %.0f°", pos.Bearing)
}

// addTriggerLog adds a trigger log entry, maintaining a maximum of 100 entries
func (rs *RotatorScheduler) addTriggerLog(log ScheduleTriggerLog) {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	// Add the new log entry
	rs.triggerLogs = append(rs.triggerLogs, log)

	// Keep only the last 100 entries
	if len(rs.triggerLogs) > 100 {
		rs.triggerLogs = rs.triggerLogs[len(rs.triggerLogs)-100:]
	}
}

// GetTriggerLogs returns the trigger logs (most recent first)
func (rs *RotatorScheduler) GetTriggerLogs() []ScheduleTriggerLog {
	rs.mu.RLock()
	defer rs.mu.RUnlock()

	// Return a copy in reverse order (most recent first)
	logs := make([]ScheduleTriggerLog, len(rs.triggerLogs))
	for i, log := range rs.triggerLogs {
		logs[len(rs.triggerLogs)-1-i] = log
	}

	return logs
}

// GetStatus returns the current scheduler status
func (rs *RotatorScheduler) GetStatus() map[string]interface{} {
	rs.mu.RLock()
	defer rs.mu.RUnlock()

	// Count enabled positions
	enabledCount := 0
	for _, pos := range rs.config.Positions {
		if pos.Enabled {
			enabledCount++
		}
	}

	status := map[string]interface{}{
		"enabled":                rs.config.Enabled,
		"running":                rs.running,
		"position_count":         len(rs.config.Positions),
		"enabled_position_count": enabledCount,
		"solar_events":           GetAvailableSolarEvents(), // Add available solar events
	}

	// Always add all positions (even when disabled or empty)
	positions := make([]map[string]interface{}, len(rs.config.Positions))
	for i, pos := range rs.config.Positions {
		posMap := map[string]interface{}{
			"time":    pos.Time,
			"bearing": pos.Bearing,
			"enabled": pos.Enabled,
		}
		// Add offset if it's a solar event
		if isSolarEvent(pos.Time) && pos.Offset != 0 {
			posMap["offset"] = pos.Offset
		}
		// Add resolved time for display
		if resolvedTime, err := rs.resolvePositionTime(&pos); err == nil {
			posMap["resolved_time"] = resolvedTime
		}
		positions[i] = posMap
	}
	status["positions"] = positions

	// Add next scheduled position only if enabled and has positions
	if rs.config.Enabled && len(rs.config.Positions) > 0 {
		nextPos := rs.getNextScheduledPosition()
		if nextPos != nil {
			nextPosMap := map[string]interface{}{
				"time":    nextPos.Time,
				"bearing": nextPos.Bearing,
			}
			// Add resolved time
			if resolvedTime, err := rs.resolvePositionTime(nextPos); err == nil {
				nextPosMap["resolved_time"] = resolvedTime
			}
			status["next_position"] = nextPosMap
		}
	}

	return status
}

// getNextScheduledPosition returns the next scheduled position (must be called with lock held)
func (rs *RotatorScheduler) getNextScheduledPosition() *ScheduledPosition {
	if len(rs.config.Positions) == 0 {
		return nil
	}

	now := time.Now()
	currentMinutes := now.Hour()*60 + now.Minute()

	// Convert all ENABLED positions to minutes since midnight and sort
	type posWithMinutes struct {
		pos     ScheduledPosition
		minutes int
	}

	positionsWithMinutes := make([]posWithMinutes, 0, len(rs.config.Positions))
	for _, pos := range rs.config.Positions {
		// Skip disabled positions
		if !pos.Enabled {
			continue
		}

		// Resolve position time (handles both fixed times and solar events)
		resolvedTime, err := rs.resolvePositionTime(&pos)
		if err != nil {
			log.Printf("Error resolving position time for '%s': %v", pos.Time, err)
			continue
		}

		t, err := time.Parse("15:04", resolvedTime)
		if err != nil {
			continue
		}
		minutes := t.Hour()*60 + t.Minute()
		positionsWithMinutes = append(positionsWithMinutes, posWithMinutes{
			pos:     pos,
			minutes: minutes,
		})
	}

	// Sort by time
	sort.Slice(positionsWithMinutes, func(i, j int) bool {
		return positionsWithMinutes[i].minutes < positionsWithMinutes[j].minutes
	})

	// Find next enabled position after current time
	for _, pwm := range positionsWithMinutes {
		if pwm.minutes > currentMinutes {
			return &pwm.pos
		}
	}

	// If no position found after current time, return first enabled position (tomorrow)
	if len(positionsWithMinutes) > 0 {
		return &positionsWithMinutes[0].pos
	}

	return nil
}

// Reload reloads the configuration from disk
func (rs *RotatorScheduler) Reload() error {
	wasRunning := false

	rs.mu.Lock()
	wasRunning = rs.running
	rs.mu.Unlock()

	// Stop if running
	if wasRunning {
		rs.Stop()
		// Recreate the stop channel for next start
		rs.stopChan = make(chan struct{})
	}

	// Reload config
	if err := rs.LoadConfig(); err != nil {
		return err
	}

	// Start if enabled and has positions (regardless of whether it was running before)
	// This allows the scheduler to start when enabled is toggled from false to true
	rs.mu.RLock()
	shouldStart := rs.config.Enabled && len(rs.config.Positions) > 0
	rs.mu.RUnlock()

	if shouldStart {
		return rs.Start()
	}

	return nil
}
