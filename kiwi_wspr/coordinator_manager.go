package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// CoordinatorManager manages WSPR coordinators and handles dynamic reconfiguration
type CoordinatorManager struct {
	appConfig        *AppConfig
	coordinators     map[string]*WSPRCoordinator // key is band name
	mqttPublisher    *MQTTPublisher
	oneShot          bool
	oneShotDone      chan struct{}
	oneShotCount     int
	oneShotCompleted int
	mu               sync.RWMutex
}

// NewCoordinatorManager creates a new coordinator manager
func NewCoordinatorManager(appConfig *AppConfig, mqttPublisher *MQTTPublisher) *CoordinatorManager {
	return &CoordinatorManager{
		appConfig:     appConfig,
		coordinators:  make(map[string]*WSPRCoordinator),
		mqttPublisher: mqttPublisher,
		oneShotDone:   make(chan struct{}),
	}
}

// SetOneShot enables one-shot mode
func (cm *CoordinatorManager) SetOneShot(enabled bool) {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	cm.oneShot = enabled
}

// WaitForOneShotComplete waits for one-shot mode to complete
func (cm *CoordinatorManager) WaitForOneShotComplete() {
	<-cm.oneShotDone
}

// NotifyOneShotComplete signals that one coordinator has completed in one-shot mode
func (cm *CoordinatorManager) NotifyOneShotComplete() {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	cm.oneShotCompleted++
	log.Printf("CoordinatorManager: One-shot progress: %d/%d bands completed", cm.oneShotCompleted, cm.oneShotCount)

	// Check if all coordinators have completed
	if cm.oneShotCompleted >= cm.oneShotCount {
		select {
		case <-cm.oneShotDone:
			// Already closed
		default:
			close(cm.oneShotDone)
		}
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

	// Set one-shot count if in one-shot mode
	if cm.oneShot {
		cm.oneShotCount = len(enabledBands)
		cm.oneShotCompleted = 0
	}

	// Track last instance to add delay only between bands on same instance
	var lastInstance string
	
	for _, band := range enabledBands {
		// Add small delay if this band uses the same instance as the previous one
		// This ensures unique WebSocket connection timestamps and avoids conflicts
		if lastInstance == band.Instance && lastInstance != "" {
			time.Sleep(100 * time.Millisecond)
		}
		
		if err := cm.startCoordinator(band); err != nil {
			log.Printf("CoordinatorManager: Failed to start coordinator for %s: %v", band.Name, err)
			continue
		}
		
		lastInstance = band.Instance
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

	// Check if instance is enabled
	if !instance.Enabled {
		return fmt.Errorf("instance %s is disabled", band.Instance)
	}

	// Create config for this band
	// Frequency is in kHz as expected by KiwiSDR
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

	// Create coordinator with instance name and frequency for unique directory
	// Format: instance_frequency (e.g., kiwi1_14097)
	uniqueID := fmt.Sprintf("%s_%d", band.Instance, int(band.Frequency))

	// Get instance-specific MQTT topic prefix if configured
	mqttTopicPrefix := instance.MQTTTopicPrefix

	coordinator := NewWSPRCoordinator(
		bandConfig,
		cm.appConfig.Decoder.WSPRDPath,
		"", // receiverLocator - not used
		"", // receiverCall - not used
		cm.appConfig.Decoder.WorkDir,
		band.Name,
		uniqueID,
		cm.mqttPublisher,
		mqttTopicPrefix,
		cm.oneShot,
		cm,
	)

	if err := coordinator.Start(); err != nil {
		return fmt.Errorf("failed to start coordinator: %w", err)
	}

	cm.coordinators[band.Name] = coordinator
	log.Printf("CoordinatorManager: Started coordinator for %s (%.1f kHz on %s)", band.Name, band.Frequency, instance.Name)

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

	// Check if MQTT configuration changed
	mqttChanged := cm.mqttConfigChanged(cm.appConfig.MQTT, newConfig.MQTT)
	if mqttChanged {
		log.Println("CoordinatorManager: MQTT configuration changed, reconnecting...")
		
		// Disconnect old MQTT publisher
		if cm.mqttPublisher != nil {
			cm.mqttPublisher.Disconnect()
		}
		
		// Create new MQTT publisher if enabled
		if newConfig.MQTT.Enabled {
			newPublisher, err := NewMQTTPublisher(&newConfig.MQTT)
			if err != nil {
				log.Printf("CoordinatorManager: Warning - failed to connect to MQTT: %v", err)
				cm.mqttPublisher = nil
			} else {
				cm.mqttPublisher = newPublisher
				log.Println("CoordinatorManager: MQTT publisher updated")
			}
		} else {
			cm.mqttPublisher = nil
			log.Println("CoordinatorManager: MQTT disabled")
		}
		
		// Update MQTT publisher in all running coordinators
		// Also update their topic prefixes from the current config
		for name, coord := range cm.coordinators {
			// Find the band to get its instance
			var topicPrefix string
			for _, band := range newConfig.WSPRBands {
				if band.Name == name {
					instance := newConfig.GetInstance(band.Instance)
					if instance != nil {
						topicPrefix = instance.MQTTTopicPrefix
					}
					break
				}
			}
			coord.UpdateMQTTPublisher(cm.mqttPublisher, topicPrefix)
			log.Printf("CoordinatorManager: Updated MQTT publisher for coordinator %s with prefix '%s'", name, topicPrefix)
		}
	}

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

// mqttConfigChanged checks if MQTT configuration has changed
func (cm *CoordinatorManager) mqttConfigChanged(old, new MQTTConfig) bool {
	return old.Enabled != new.Enabled ||
		old.Host != new.Host ||
		old.Port != new.Port ||
		old.UseTLS != new.UseTLS ||
		old.Username != new.Username ||
		old.Password != new.Password ||
		old.TopicPrefix != new.TopicPrefix ||
		old.QoS != new.QoS ||
		old.Retain != new.Retain
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

// GetDetailedStatus returns detailed status including MQTT and band connection states
func (cm *CoordinatorManager) GetDetailedStatus() map[string]interface{} {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	status := make(map[string]interface{})
	
	// MQTT status
	mqttStatus := map[string]interface{}{
		"enabled":   cm.appConfig.MQTT.Enabled,
		"connected": false,
	}
	
	if cm.mqttPublisher != nil && cm.appConfig.MQTT.Enabled {
		mqttStatus["connected"] = cm.mqttPublisher.IsConnected()
	}
	
	status["mqtt"] = mqttStatus
	
	// Band status - include all bands from config with their connection state
	bandStatuses := make([]map[string]interface{}, 0)
	
	for _, band := range cm.appConfig.WSPRBands {
		bandStatus := map[string]interface{}{
			"name":              band.Name,
			"frequency":         band.Frequency,
			"instance":          band.Instance,
			"enabled":           band.Enabled,
			"state":             "disabled", // disabled, waiting, connected, failed
			"last_decode_time":  nil,
			"last_decode_count": 0,
			"error":             "",
		}
		
		// Check if this band has a running coordinator
		if coord, exists := cm.coordinators[band.Name]; exists {
			// Get decode statistics and recording status
			lastDecodeTime, lastDecodeCount, recordingState, lastError := coord.GetStatus()
			
			// Map recording state to status string
			switch recordingState {
			case RecordingStateWaiting:
				bandStatus["state"] = "waiting"
			case RecordingStateSuccess:
				bandStatus["state"] = "connected"
			case RecordingStateFailed:
				bandStatus["state"] = "failed"
				if lastError != "" {
					bandStatus["error"] = lastError
				}
			}
			
			if !lastDecodeTime.IsZero() {
				bandStatus["last_decode_time"] = lastDecodeTime.Format(time.RFC3339)
			}
			bandStatus["last_decode_count"] = lastDecodeCount
		}
		
		bandStatuses = append(bandStatuses, bandStatus)
	}
	
	status["bands"] = bandStatuses
	
	return status
}
