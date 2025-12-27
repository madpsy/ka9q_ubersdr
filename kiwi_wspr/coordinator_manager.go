package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// CoordinatorManager manages WSPR coordinators and handles dynamic reconfiguration
type CoordinatorManager struct {
	appConfig     *AppConfig
	coordinators  map[string]*WSPRCoordinator // key is band name
	mqttPublisher *MQTTPublisher
	mu            sync.RWMutex
}

// NewCoordinatorManager creates a new coordinator manager
func NewCoordinatorManager(appConfig *AppConfig, mqttPublisher *MQTTPublisher) *CoordinatorManager {
	return &CoordinatorManager{
		appConfig:     appConfig,
		coordinators:  make(map[string]*WSPRCoordinator),
		mqttPublisher: mqttPublisher,
	}
}

// StartAll starts coordinators for all enabled bands
func (cm *CoordinatorManager) StartAll() error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	enabledBands := cm.appConfig.GetEnabledBands()
	if len(enabledBands) == 0 {
		log.Println("CoordinatorManager: No enabled bands configured")
		return nil
	}

	log.Printf("CoordinatorManager: Starting coordinators for %d bands...", len(enabledBands))

	for _, band := range enabledBands {
		if err := cm.startCoordinator(band); err != nil {
			log.Printf("CoordinatorManager: Failed to start coordinator for %s: %v", band.Name, err)
			continue
		}
	}

	return nil
}

// startCoordinator starts a coordinator for a specific band (must be called with lock held)
func (cm *CoordinatorManager) startCoordinator(band WSPRBand) error {
	// Check if already running
	if _, exists := cm.coordinators[band.Name]; exists {
		return fmt.Errorf("coordinator for %s is already running", band.Name)
	}

	instance := cm.appConfig.GetInstance(band.Instance)
	if instance == nil {
		return fmt.Errorf("band %s references unknown instance %s", band.Name, band.Instance)
	}

	// Create config for this band
	bandConfig := &Config{
		ServerHost:  instance.Host,
		ServerPort:  instance.Port,
		Frequency:   band.Frequency,
		Modulation:  "usb",
		User:        instance.User,
		Password:    instance.Password,
		Duration:    120 * time.Second,
		OutputDir:   cm.appConfig.Decoder.WorkDir,
		LowCut:      300,
		HighCut:     2700,
		AGCGain:     -1,
		Compression: cm.appConfig.Decoder.Compression,
		Quiet:       cm.appConfig.Logging.Quiet,
	}

	// Create coordinator
	coordinator := NewWSPRCoordinator(
		bandConfig,
		cm.appConfig.Decoder.WSPRDPath,
		cm.appConfig.Receiver.Locator,
		cm.appConfig.Receiver.Callsign,
		cm.appConfig.Decoder.WorkDir,
		band.Name,
		cm.mqttPublisher,
	)

	if err := coordinator.Start(); err != nil {
		return fmt.Errorf("failed to start coordinator: %w", err)
	}

	cm.coordinators[band.Name] = coordinator
	log.Printf("CoordinatorManager: Started coordinator for %s (%.3f MHz on %s)", band.Name, band.Frequency, instance.Name)

	return nil
}

// StopAll stops all running coordinators
func (cm *CoordinatorManager) StopAll() {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	log.Println("CoordinatorManager: Stopping all coordinators...")

	for name, coord := range cm.coordinators {
		coord.Stop()
		log.Printf("CoordinatorManager: Stopped coordinator for %s", name)
	}

	cm.coordinators = make(map[string]*WSPRCoordinator)
}

// Reload reloads the configuration and restarts coordinators as needed
func (cm *CoordinatorManager) Reload(newConfig *AppConfig) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	log.Println("CoordinatorManager: Reloading configuration...")

	// Get current and new enabled bands
	oldBands := make(map[string]WSPRBand)
	for _, band := range cm.appConfig.GetEnabledBands() {
		oldBands[band.Name] = band
	}

	newBands := make(map[string]WSPRBand)
	for _, band := range newConfig.GetEnabledBands() {
		newBands[band.Name] = band
	}

	// Stop coordinators for bands that are no longer enabled or have changed
	for name, oldBand := range oldBands {
		newBand, stillEnabled := newBands[name]

		// Stop if disabled or configuration changed
		if !stillEnabled || cm.bandConfigChanged(oldBand, newBand) {
			if coord, exists := cm.coordinators[name]; exists {
				log.Printf("CoordinatorManager: Stopping coordinator for %s (disabled or config changed)", name)
				coord.Stop()
				delete(cm.coordinators, name)
			}
		}
	}

	// Update the app config
	cm.appConfig = newConfig

	// Start coordinators for new or changed bands
	for name, newBand := range newBands {
		oldBand, existed := oldBands[name]

		// Start if new or configuration changed
		if !existed || cm.bandConfigChanged(oldBand, newBand) {
			if err := cm.startCoordinator(newBand); err != nil {
				log.Printf("CoordinatorManager: Failed to start coordinator for %s: %v", name, err)
				continue
			}
		}
	}

	log.Printf("CoordinatorManager: Reload complete. Running coordinators: %d", len(cm.coordinators))

	return nil
}

// bandConfigChanged checks if a band's configuration has changed
func (cm *CoordinatorManager) bandConfigChanged(old, new WSPRBand) bool {
	return old.Frequency != new.Frequency ||
		old.Instance != new.Instance
}

// GetStatus returns the current status of all coordinators
func (cm *CoordinatorManager) GetStatus() map[string]interface{} {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	status := make(map[string]interface{})
	status["running_coordinators"] = len(cm.coordinators)

	bands := make([]string, 0, len(cm.coordinators))
	for name := range cm.coordinators {
		bands = append(bands, name)
	}
	status["active_bands"] = bands

	return status
}
