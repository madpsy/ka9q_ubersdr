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
	Enabled        bool                `yaml:"enabled"`         // Enable/disable scheduled positioning
	Positions      []ScheduledPosition `yaml:"positions"`       // List of scheduled positions
	FollowSun      bool                `yaml:"follow_sun"`      // Enable sun tracking mode
	FollowSunStep  int                 `yaml:"follow_sun_step"` // Update interval in minutes (default: 15)
	FollowSunPath  string              `yaml:"follow_sun_path"` // Path mode: "short" (default) or "long" (adds 180°)
	DaytimeOnly    bool                `yaml:"daytime_only"`    // Only track sun during daytime (default: true)
	DaytimeOverlap int                 `yaml:"daytime_overlap"` // Minutes before sunrise/after sunset to extend tracking (default: 60)
	FollowGreyline bool                `yaml:"follow_greyline"` // Track gray line (perpendicular to sun) instead of sun directly (default: false)
	SunriseStart   string              `yaml:"sunrise_start"`   // Solar event to start sunrise tracking (default: sunrise with overlap)
	SunriseEnd     string              `yaml:"sunrise_end"`     // Solar event to end sunrise tracking (default: sunrise with overlap)
	SunsetStart    string              `yaml:"sunset_start"`    // Solar event to start sunset tracking (default: sunset with overlap)
	SunsetEnd      string              `yaml:"sunset_end"`      // Solar event to end sunset tracking (default: sunset with overlap)
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
	config            *RotatorScheduleConfig
	controller        *RotatorController
	mu                sync.RWMutex
	stopChan          chan struct{}
	running           bool
	configPath        string
	triggerLogs       []ScheduleTriggerLog // Circular buffer of up to 100 trigger events
	gpsLat            float64              // GPS latitude for solar calculations
	gpsLon            float64              // GPS longitude for solar calculations
	cachedSunTimes    *SunTimes            // Cached sun times for today
	lastSunCalc       time.Time            // Last time sun times were calculated
	lastSunAzimuth    float64              // Last sun azimuth (for tracking changes)
	lastSunUpdate     time.Time            // Last time sun position was updated
	sunTrackingActive bool                 // Whether sun tracking is currently active
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

// getAvailableSolarEventsWithTimes returns solar events with their current trigger times for today
// Note: Caller must NOT hold any locks
func (rs *RotatorScheduler) getAvailableSolarEventsWithTimes() []map[string]interface{} {
	// Acquire lock to access cached sun times
	rs.mu.Lock()
	sunTimes := rs.getSunTimesForTodayNoLock()
	rs.mu.Unlock()

	return rs.getAvailableSolarEventsWithTimesNoLock(sunTimes)
}

// getAvailableSolarEventsWithTimesNoLock returns solar events with their current trigger times for today
// Note: This version takes pre-fetched sun times and does not acquire any locks
func (rs *RotatorScheduler) getAvailableSolarEventsWithTimesNoLock(sunTimes *SunTimes) []map[string]interface{} {
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

		result[i] = map[string]interface{}{
			"name":         event.Name,
			"display_name": event.DisplayName,
			"description":  event.Description,
			"time":         eventTime.Format("15:04"), // HH:MM format for today
		}
	}

	return result
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
				Enabled:        false,
				Positions:      []ScheduledPosition{},
				FollowSun:      false,
				FollowSunStep:  15,
				DaytimeOnly:    true,
				DaytimeOverlap: 60,
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

	// Set defaults for sun tracking if not specified
	if config.FollowSunStep == 0 {
		config.FollowSunStep = 15
	}
	// Enforce minimum of 5 minutes
	if config.FollowSunStep < 5 {
		log.Printf("Warning: follow_sun_step %d is below minimum, setting to 5 minutes", config.FollowSunStep)
		config.FollowSunStep = 5
	}
	// Enforce maximum of 60 minutes
	if config.FollowSunStep > 60 {
		log.Printf("Warning: follow_sun_step %d exceeds maximum, setting to 60 minutes", config.FollowSunStep)
		config.FollowSunStep = 60
	}
	// Set default path to "short" if not specified
	if config.FollowSunPath == "" {
		config.FollowSunPath = "short"
	}
	// Validate path setting
	if config.FollowSunPath != "short" && config.FollowSunPath != "long" {
		log.Printf("Warning: invalid follow_sun_path '%s', setting to 'short' (valid options: 'short', 'long')", config.FollowSunPath)
		config.FollowSunPath = "short"
	}
	if config.DaytimeOverlap == 0 {
		config.DaytimeOverlap = 60
	}
	// DaytimeOnly defaults to true if follow_sun is enabled
	if config.FollowSun && !config.DaytimeOnly {
		// User explicitly set daytime_only to false, respect it
	} else if config.FollowSun {
		config.DaytimeOnly = true
	}

	// Validate positions
	for i, pos := range config.Positions {
		if err := rs.validatePosition(&pos); err != nil {
			return fmt.Errorf("invalid position at index %d: %w", i, err)
		}
	}

	rs.config = &config

	if config.FollowSun {
		trackingMode := "sun"
		if config.FollowGreyline {
			trackingMode = "greyline"
		}
		log.Printf("Loaded rotator scheduler config: enabled=%v, follow_sun=%v, mode=%s, path=%s, step=%dm, daytime_only=%v, overlap=%dm, positions=%d",
			config.Enabled, config.FollowSun, trackingMode, config.FollowSunPath, config.FollowSunStep, config.DaytimeOnly, config.DaytimeOverlap, len(config.Positions))
	} else {
		log.Printf("Loaded rotator scheduler config: enabled=%v, positions=%d", config.Enabled, len(config.Positions))
	}

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
// Note: This method does NOT acquire locks - caller must hold appropriate lock
func (rs *RotatorScheduler) getSunTimesForTodayNoLock() *SunTimes {
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

// isSameMinute checks if two times are in the same minute
func isSameMinute(t1, t2 time.Time) bool {
	return t1.Year() == t2.Year() && t1.Month() == t2.Month() && t1.Day() == t2.Day() &&
		t1.Hour() == t2.Hour() && t1.Minute() == t2.Minute()
}

// resolvePositionTime resolves a position's time to HH:MM format
// Handles both fixed times (HH:MM) and solar events (sunrise, sunset, etc.)
// Note: Caller must NOT hold any locks
func (rs *RotatorScheduler) resolvePositionTime(pos *ScheduledPosition) (string, error) {
	// If it's a fixed time, return as-is
	if !isSolarEvent(pos.Time) {
		return pos.Time, nil
	}

	// It's a solar event - calculate the time
	rs.mu.Lock()
	sunTimes := rs.getSunTimesForTodayNoLock()
	rs.mu.Unlock()

	return rs.resolvePositionTimeNoLock(pos, sunTimes)
}

// resolvePositionTimeNoLock resolves a position's time to HH:MM format
// Handles both fixed times (HH:MM) and solar events (sunrise, sunset, etc.)
// Note: This version takes pre-fetched sun times and does not acquire any locks
func (rs *RotatorScheduler) resolvePositionTimeNoLock(pos *ScheduledPosition, sunTimes *SunTimes) (string, error) {
	// If it's a fixed time, return as-is
	if !isSolarEvent(pos.Time) {
		return pos.Time, nil
	}

	// It's a solar event - calculate the time
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

// getSolarEventTime returns the time for a given solar event name
// Note: Caller must hold the lock
func (rs *RotatorScheduler) getSolarEventTime(sunTimes *SunTimes, eventName string) time.Time {
	switch eventName {
	case "sunrise":
		return sunTimes.Sunrise
	case "sunset":
		return sunTimes.Sunset
	case "dawn":
		return sunTimes.Dawn
	case "dusk":
		return sunTimes.Dusk
	case "sunriseEnd":
		return sunTimes.SunriseEnd
	case "sunsetStart":
		return sunTimes.SunsetStart
	case "solarNoon":
		return sunTimes.SolarNoon
	case "nadir":
		return sunTimes.Nadir
	case "goldenHour":
		return sunTimes.GoldenHour
	case "goldenHourEnd":
		return sunTimes.GoldenHourEnd
	case "nauticalDawn":
		return sunTimes.NauticalDawn
	case "nauticalDusk":
		return sunTimes.NauticalDusk
	case "nightEnd":
		return sunTimes.NightEnd
	case "night":
		return sunTimes.Night
	default:
		// Default to sunrise for unknown events
		return sunTimes.Sunrise
	}
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
	if !rs.config.Enabled {
		rs.mu.RUnlock()
		return
	}

	// Check if sun tracking is enabled
	followSun := rs.config.FollowSun
	rs.mu.RUnlock()

	// Handle sun tracking mode
	if followSun {
		rs.updateSunTracking()
	}

	// Handle scheduled positions
	rs.mu.RLock()
	if len(rs.config.Positions) == 0 {
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

// updateSunTracking updates the rotator position to track the sun
func (rs *RotatorScheduler) updateSunTracking() {
	now := time.Now()

	rs.mu.Lock()
	defer rs.mu.Unlock()

	// Check if it's time to update (based on step interval aligned to standard clock intervals)
	stepMinutes := rs.config.FollowSunStep
	currentMinutes := now.Hour()*60 + now.Minute()

	// Check if current time aligns with the step interval (e.g., 00:00, 00:30, 01:00 for 30-minute steps)
	if currentMinutes%stepMinutes != 0 {
		return // Not at a standard interval boundary
	}

	// Prevent duplicate updates within the same minute
	if !rs.lastSunUpdate.IsZero() && isSameMinute(rs.lastSunUpdate, now) {
		return // Already updated this minute
	}

	// Get sun times for today
	sunTimes := rs.getSunTimesForTodayNoLock()

	// Determine if we're in a tracking window
	var inTrackingWindow bool

	// Check if custom events are specified (takes precedence over daytime_only)
	if rs.config.SunriseStart != "" && rs.config.SunriseEnd != "" && rs.config.SunsetStart != "" && rs.config.SunsetEnd != "" {
		// Use custom solar events for two separate tracking windows
		// Custom windows apply regardless of daytime_only setting
		sunriseWindowStart := rs.getSolarEventTime(sunTimes, rs.config.SunriseStart)
		sunriseWindowEnd := rs.getSolarEventTime(sunTimes, rs.config.SunriseEnd)
		sunsetWindowStart := rs.getSolarEventTime(sunTimes, rs.config.SunsetStart)
		sunsetWindowEnd := rs.getSolarEventTime(sunTimes, rs.config.SunsetEnd)

		// Check if we're in either the sunrise or sunset window
		inSunriseWindow := now.After(sunriseWindowStart) && now.Before(sunriseWindowEnd)
		inSunsetWindow := now.After(sunsetWindowStart) && now.Before(sunsetWindowEnd)
		inTrackingWindow = inSunriseWindow || inSunsetWindow
	} else if rs.config.DaytimeOnly {
		// Use default overlap-based tracking window (single continuous window)
		overlapDuration := time.Duration(rs.config.DaytimeOverlap) * time.Minute
		trackingStart := sunTimes.Sunrise.Add(-overlapDuration)
		trackingEnd := sunTimes.Sunset.Add(overlapDuration)
		inTrackingWindow = now.After(trackingStart) && now.Before(trackingEnd)
	} else {
		// daytime_only is false and no custom windows - track 24/7
		inTrackingWindow = true
	}

	if !inTrackingWindow {
		// Outside tracking window
		if rs.sunTrackingActive {
			log.Printf("Sun tracking: Outside tracking window (sunrise: %s, sunset: %s, overlap: %dm)",
				sunTimes.Sunrise.Format("15:04"), sunTimes.Sunset.Format("15:04"), rs.config.DaytimeOverlap)
			rs.sunTrackingActive = false
		}
		return
	}

	// Calculate current sun position
	sunPos := GetPosition(now, rs.gpsLat, rs.gpsLon)

	// Normalize azimuth to 0-360 degrees
	azimuthDeg := sunPos.Azimuth / rad
	azimuthDeg = azimuthDeg + 180.0
	if azimuthDeg < 0 {
		azimuthDeg += 360.0
	} else if azimuthDeg >= 360 {
		azimuthDeg -= 360.0
	}

	// If follow_greyline is enabled, calculate gray line bearing (perpendicular to sun)
	// The gray line is the terminator between day and night
	// Add 90° to point along the gray line instead of at the sun
	if rs.config.FollowGreyline {
		azimuthDeg = azimuthDeg + 90.0
		if azimuthDeg >= 360.0 {
			azimuthDeg -= 360.0
		}
	}

	// Apply long path if configured (adds 180° to point in opposite direction)
	if rs.config.FollowSunPath == "long" {
		azimuthDeg = azimuthDeg + 180.0
		if azimuthDeg >= 360.0 {
			azimuthDeg -= 360.0
		}
	}

	// At this point, we're at a standard interval boundary and haven't updated this minute yet
	// We can proceed with the update

	// Check if rotator is connected
	if !rs.controller.client.IsConnected() {
		if rs.sunTrackingActive {
			log.Printf("Sun tracking: Rotator not connected")
			rs.sunTrackingActive = false
		}
		return
	}

	// Update rotator position
	if err := rs.controller.SetAzimuth(azimuthDeg); err != nil {
		log.Printf("Sun tracking: Failed to set azimuth to %.1f°: %v", azimuthDeg, err)
		return
	}

	// Log the update
	if !rs.sunTrackingActive {
		trackingMode := "sun"
		if rs.config.FollowGreyline {
			trackingMode = "greyline"
		}
		pathMode := rs.config.FollowSunPath
		log.Printf("Sun tracking: Started (mode: %s, path: %s, step: %dm, daytime_only: %v, overlap: %dm)",
			trackingMode, pathMode, rs.config.FollowSunStep, rs.config.DaytimeOnly, rs.config.DaytimeOverlap)
	}

	altitudeDeg := sunPos.Altitude / rad
	trackingType := "sun"
	if rs.config.FollowGreyline {
		trackingType = "greyline"
	}
	pathDesc := rs.config.FollowSunPath + " path"
	log.Printf("Sun tracking: Updated rotator to %.1f° (%s tracking, %s, sun altitude: %.1f°)", azimuthDeg, trackingType, pathDesc, altitudeDeg)

	// Update tracking state
	rs.lastSunAzimuth = azimuthDeg
	rs.lastSunUpdate = now
	rs.sunTrackingActive = true

	// Add to trigger logs (round bearing to nearest integer)
	triggerLog := ScheduleTriggerLog{
		Timestamp: now,
		Time:      "sun_tracking",
		Bearing:   float64(int(azimuthDeg + 0.5)),
		Success:   true,
	}
	rs.triggerLogs = append(rs.triggerLogs, triggerLog)
	if len(rs.triggerLogs) > 100 {
		rs.triggerLogs = rs.triggerLogs[len(rs.triggerLogs)-100:]
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

	// Count enabled positions
	enabledCount := 0
	for _, pos := range rs.config.Positions {
		if pos.Enabled {
			enabledCount++
		}
	}

	enabled := rs.config.Enabled
	running := rs.running
	positionCount := len(rs.config.Positions)

	// Copy positions for processing outside lock
	positionsCopy := make([]ScheduledPosition, len(rs.config.Positions))
	copy(positionsCopy, rs.config.Positions)

	// Get sun times while we have the lock
	sunTimes := rs.getSunTimesForTodayNoLock()

	rs.mu.RUnlock()

	// Get solar events with times (pass sun times to avoid re-locking)
	solarEvents := rs.getAvailableSolarEventsWithTimesNoLock(sunTimes)

	// Get sun tracking info
	rs.mu.RLock()
	followSun := rs.config.FollowSun
	followSunStep := rs.config.FollowSunStep
	followSunPath := rs.config.FollowSunPath
	daytimeOnly := rs.config.DaytimeOnly
	daytimeOverlap := rs.config.DaytimeOverlap
	sunTrackingActive := rs.sunTrackingActive
	lastSunAzimuth := rs.lastSunAzimuth
	lastSunUpdate := rs.lastSunUpdate
	rs.mu.RUnlock()

	// Get greyline and custom event settings
	rs.mu.RLock()
	followGreyline := rs.config.FollowGreyline
	sunriseStart := rs.config.SunriseStart
	sunriseEnd := rs.config.SunriseEnd
	sunsetStart := rs.config.SunsetStart
	sunsetEnd := rs.config.SunsetEnd
	rs.mu.RUnlock()

	status := map[string]interface{}{
		"enabled":                enabled,
		"running":                running,
		"position_count":         positionCount,
		"enabled_position_count": enabledCount,
		"solar_events":           solarEvents,
		"follow_sun":             followSun,
		"follow_sun_step":        followSunStep,
		"follow_sun_path":        followSunPath,
		"daytime_only":           daytimeOnly,
		"daytime_overlap":        daytimeOverlap,
		"follow_greyline":        followGreyline,
		"sunrise_start":          sunriseStart,
		"sunrise_end":            sunriseEnd,
		"sunset_start":           sunsetStart,
		"sunset_end":             sunsetEnd,
		"sun_tracking_active":    sunTrackingActive,
	}

	// Add current sun position if tracking is active
	if sunTrackingActive && !lastSunUpdate.IsZero() {
		status["sun_azimuth"] = lastSunAzimuth
		status["sun_last_update"] = lastSunUpdate.Format(time.RFC3339)
	}

	// Process positions (no lock needed - using copy)
	positions := make([]map[string]interface{}, len(positionsCopy))
	for i, pos := range positionsCopy {
		posMap := map[string]interface{}{
			"time":    pos.Time,
			"bearing": pos.Bearing,
			"enabled": pos.Enabled,
		}
		// Add offset if it's a solar event
		if isSolarEvent(pos.Time) && pos.Offset != 0 {
			posMap["offset"] = pos.Offset
		}
		// Add resolved time for display (pass sun times to avoid locking)
		if resolvedTime, err := rs.resolvePositionTimeNoLock(&pos, sunTimes); err == nil {
			posMap["resolved_time"] = resolvedTime
		}
		positions[i] = posMap
	}
	status["positions"] = positions

	// Add next scheduled position only if enabled and has positions
	if enabled && len(positionsCopy) > 0 {
		// Calculate next position without holding lock (use copied positions and sun times)
		nextPos := rs.getNextScheduledPositionNoLock(positionsCopy, sunTimes)

		if nextPos != nil {
			nextPosMap := map[string]interface{}{
				"time":    nextPos.Time,
				"bearing": nextPos.Bearing,
			}
			// Add resolved time (pass sun times to avoid locking)
			if resolvedTime, err := rs.resolvePositionTimeNoLock(nextPos, sunTimes); err == nil {
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

	// Get sun times while we have the lock
	sunTimes := rs.getSunTimesForTodayNoLock()

	// Make a copy of positions
	positionsCopy := make([]ScheduledPosition, len(rs.config.Positions))
	copy(positionsCopy, rs.config.Positions)

	// Use the no-lock version
	return rs.getNextScheduledPositionNoLock(positionsCopy, sunTimes)
}

// getNextScheduledPositionNoLock returns the next scheduled position without acquiring locks
// Takes pre-fetched positions and sun times
func (rs *RotatorScheduler) getNextScheduledPositionNoLock(positions []ScheduledPosition, sunTimes *SunTimes) *ScheduledPosition {
	if len(positions) == 0 {
		return nil
	}

	now := time.Now()
	currentMinutes := now.Hour()*60 + now.Minute()

	// Convert all ENABLED positions to minutes since midnight and sort
	type posWithMinutes struct {
		pos     ScheduledPosition
		minutes int
	}

	positionsWithMinutes := make([]posWithMinutes, 0, len(positions))
	for _, pos := range positions {
		// Skip disabled positions
		if !pos.Enabled {
			continue
		}

		// Resolve position time (handles both fixed times and solar events) - use no-lock version
		resolvedTime, err := rs.resolvePositionTimeNoLock(&pos, sunTimes)
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
