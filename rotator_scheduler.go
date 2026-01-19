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
	Time    string  `yaml:"time"`    // Time in HH:MM format (24-hour)
	Bearing float64 `yaml:"bearing"` // Azimuth bearing in degrees (0-360)
}

// RotatorScheduleConfig represents the configuration for scheduled rotator positions
type RotatorScheduleConfig struct {
	Enabled   bool                `yaml:"enabled"`   // Enable/disable scheduled positioning
	Positions []ScheduledPosition `yaml:"positions"` // List of scheduled positions
}

// RotatorScheduler manages scheduled rotator positioning
type RotatorScheduler struct {
	config     *RotatorScheduleConfig
	controller *RotatorController
	mu         sync.RWMutex
	stopChan   chan struct{}
	running    bool
	configPath string
}

// NewRotatorScheduler creates a new rotator scheduler
func NewRotatorScheduler(configPath string, controller *RotatorController) (*RotatorScheduler, error) {
	scheduler := &RotatorScheduler{
		controller: controller,
		stopChan:   make(chan struct{}),
		configPath: configPath,
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
	// Validate time format (HH:MM)
	_, err := time.Parse("15:04", pos.Time)
	if err != nil {
		return fmt.Errorf("invalid time format '%s' (expected HH:MM): %w", pos.Time, err)
	}

	// Validate bearing range
	if pos.Bearing < 0 || pos.Bearing > 360 {
		return fmt.Errorf("bearing %.2f out of range (must be 0-360)", pos.Bearing)
	}

	return nil
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
		if pos.Time == currentTime {
			rs.executeScheduledPosition(&pos)
		}
	}
}

// executeScheduledPosition executes a scheduled position change
func (rs *RotatorScheduler) executeScheduledPosition(pos *ScheduledPosition) {
	// Check if rotator is connected
	if !rs.controller.client.IsConnected() {
		log.Printf("Skipping scheduled position (time=%s, bearing=%.0f°) - rotator not connected", 
			pos.Time, pos.Bearing)
		return
	}

	log.Printf("Executing scheduled position: time=%s, bearing=%.0f°", pos.Time, pos.Bearing)

	// Set the azimuth (keeping current elevation)
	if err := rs.controller.SetAzimuth(pos.Bearing); err != nil {
		log.Printf("Failed to set scheduled position (time=%s, bearing=%.0f°): %v", 
			pos.Time, pos.Bearing, err)
		return
	}

	log.Printf("Successfully set rotator to scheduled bearing %.0f°", pos.Bearing)
}

// GetStatus returns the current scheduler status
func (rs *RotatorScheduler) GetStatus() map[string]interface{} {
	rs.mu.RLock()
	defer rs.mu.RUnlock()

	status := map[string]interface{}{
		"enabled":        rs.config.Enabled,
		"running":        rs.running,
		"position_count": len(rs.config.Positions),
	}

	if rs.config.Enabled && len(rs.config.Positions) > 0 {
		// Add next scheduled position
		nextPos := rs.getNextScheduledPosition()
		if nextPos != nil {
			status["next_position"] = map[string]interface{}{
				"time":    nextPos.Time,
				"bearing": nextPos.Bearing,
			}
		}

		// Add all positions
		positions := make([]map[string]interface{}, len(rs.config.Positions))
		for i, pos := range rs.config.Positions {
			positions[i] = map[string]interface{}{
				"time":    pos.Time,
				"bearing": pos.Bearing,
			}
		}
		status["positions"] = positions
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

	// Convert all positions to minutes since midnight and sort
	type posWithMinutes struct {
		pos     ScheduledPosition
		minutes int
	}

	positionsWithMinutes := make([]posWithMinutes, 0, len(rs.config.Positions))
	for _, pos := range rs.config.Positions {
		t, err := time.Parse("15:04", pos.Time)
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

	// Find next position after current time
	for _, pwm := range positionsWithMinutes {
		if pwm.minutes > currentMinutes {
			return &pwm.pos
		}
	}

	// If no position found after current time, return first position (tomorrow)
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
	}

	// Reload config
	if err := rs.LoadConfig(); err != nil {
		return err
	}

	// Restart if it was running and still enabled
	rs.mu.RLock()
	shouldStart := rs.config.Enabled && len(rs.config.Positions) > 0
	rs.mu.RUnlock()

	if wasRunning && shouldStart {
		return rs.Start()
	}

	return nil
}
