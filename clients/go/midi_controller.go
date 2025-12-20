package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"gitlab.com/gomidi/midi/v2"
	"gitlab.com/gomidi/midi/v2/drivers"
	_ "gitlab.com/gomidi/midi/v2/drivers/rtmididrv" // auto-register driver
)

// MIDIController manages MIDI input and mappings
type MIDIController struct {
	manager       *WebSocketManager
	configManager *ConfigManager
	mu            sync.RWMutex
	in            drivers.In
	stop          func()
	connected     bool
	deviceName    string
	mappings      map[MIDIKey]MIDIMapping
	lastExecution map[MIDIKey]time.Time
	pendingTimers map[MIDIKey]*time.Timer
	timerMu       sync.Mutex
	learningMode  bool
	learnFunction string
	learnMapBoth  bool
	learnPressKey *MIDIKey
	learnCallback func(MIDILearnResponse)
	ctx           context.Context
	cancel        context.CancelFunc
	// Mute state memory
	mutedState      bool // true if currently muted
	savedLeftState  bool // saved left channel state before muting
	savedRightState bool // saved right channel state before muting
}

// NewMIDIController creates a new MIDI controller
func NewMIDIController(manager *WebSocketManager, configManager *ConfigManager) *MIDIController {
	ctx, cancel := context.WithCancel(context.Background())

	mc := &MIDIController{
		manager:       manager,
		configManager: configManager,
		mappings:      make(map[MIDIKey]MIDIMapping),
		lastExecution: make(map[MIDIKey]time.Time),
		pendingTimers: make(map[MIDIKey]*time.Timer),
		ctx:           ctx,
		cancel:        cancel,
	}

	// Load saved configuration from config manager
	// This will start auto-connect goroutine if needed
	mc.LoadConfig()

	return mc
}

// ListDevices returns a list of available MIDI input devices
func (mc *MIDIController) ListDevices() ([]MIDIDevice, error) {
	ins := midi.GetInPorts()

	devices := make([]MIDIDevice, len(ins))
	for i, port := range ins {
		devices[i] = MIDIDevice{
			Index: i,
			Name:  port.String(),
		}
	}

	return devices, nil
}

// Connect connects to a MIDI input device
func (mc *MIDIController) Connect(deviceName string) error {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	if mc.connected {
		return fmt.Errorf("already connected to %s", mc.deviceName)
	}

	// Find the device
	ins := midi.GetInPorts()

	var targetPort drivers.In
	for _, port := range ins {
		if port.String() == deviceName {
			targetPort = port
			break
		}
	}

	if targetPort == nil {
		return fmt.Errorf("device not found: %s", deviceName)
	}

	// Open the device
	err := targetPort.Open()
	if err != nil {
		return fmt.Errorf("failed to open MIDI device: %w", err)
	}

	// Set up message listener
	stop, err := midi.ListenTo(targetPort, mc.handleMIDIMessage, midi.UseSysEx())
	if err != nil {
		targetPort.Close()
		return fmt.Errorf("failed to set up MIDI listener: %w", err)
	}

	mc.in = targetPort
	mc.stop = stop
	mc.connected = true
	mc.deviceName = deviceName

	log.Printf("Connected to MIDI device: %s", deviceName)
	return nil
}

// Disconnect disconnects from the current MIDI device
func (mc *MIDIController) Disconnect() error {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	if !mc.connected {
		return fmt.Errorf("not connected")
	}

	// Stop listening
	if mc.stop != nil {
		mc.stop()
		mc.stop = nil
	}

	// Close device
	if mc.in != nil {
		mc.in.Close()
		mc.in = nil
	}

	mc.connected = false
	deviceName := mc.deviceName
	mc.deviceName = ""

	log.Printf("Disconnected from MIDI device: %s", deviceName)
	return nil
}

// handleMIDIMessage processes incoming MIDI messages
func (mc *MIDIController) handleMIDIMessage(msg midi.Message, timestampms int32) {
	var channel, note, velocity uint8
	var controller, value uint8

	// Parse message type
	var key MIDIKey
	var midiValue uint8

	switch {
	case msg.GetNoteOn(&channel, &note, &velocity):
		if velocity == 0 {
			// Note On with velocity 0 is Note Off
			key = MIDIKey{Type: 0x80, Channel: channel, Data1: note}
		} else {
			key = MIDIKey{Type: 0x90, Channel: channel, Data1: note}
		}
		midiValue = velocity

	case msg.GetNoteOff(&channel, &note, &velocity):
		key = MIDIKey{Type: 0x80, Channel: channel, Data1: note}
		midiValue = velocity

	case msg.GetControlChange(&channel, &controller, &value):
		key = MIDIKey{Type: 0xB0, Channel: channel, Data1: controller}
		midiValue = value

	default:
		// Unsupported message type
		return
	}

	// Check if in learn mode
	mc.mu.RLock()
	learning := mc.learningMode
	learnFunc := mc.learnFunction
	mc.mu.RUnlock()

	if learning && learnFunc != "" {
		mc.handleLearnMode(key, midiValue)
		return
	}

	// Execute mapped function
	mc.mu.RLock()
	mapping, exists := mc.mappings[key]
	mc.mu.RUnlock()

	if exists {
		mc.executeMapping(key, mapping, midiValue)
	}
}

// handleLearnMode handles MIDI input during learn mode
func (mc *MIDIController) handleLearnMode(key MIDIKey, value uint8) {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	isNoteOff := key.Type == 0x80
	isNoteOn := key.Type == 0x90

	if mc.learnMapBoth {
		// Map both press and release
		if isNoteOn {
			// Store press key
			mc.learnPressKey = &key
			if mc.learnCallback != nil {
				mc.learnCallback(MIDILearnResponse{
					Type:    "midi_learn_captured",
					Control: key.String(),
					Message: "Press captured! Now release the button...",
				})
			}
		} else if isNoteOff && mc.learnPressKey != nil {
			// Got release - create both mappings
			pressKey := *mc.learnPressKey
			releaseKey := key

			// Create default parameters
			params := mc.getDefaultParams(mc.learnFunction)

			// Store both mappings
			mc.mappings[pressKey] = MIDIMapping{
				Function:   mc.learnFunction,
				ThrottleMS: params.ThrottleMS,
				Mode:       params.Mode,
			}
			mc.mappings[releaseKey] = MIDIMapping{
				Function:   mc.learnFunction,
				ThrottleMS: params.ThrottleMS,
				Mode:       params.Mode,
			}

			// Complete learn mode
			if mc.learnCallback != nil {
				mc.learnCallback(MIDILearnResponse{
					Type:    "midi_learn_completed",
					Control: fmt.Sprintf("%s and %s", pressKey.String(), releaseKey.String()),
					Message: fmt.Sprintf("Mapped both: %s and %s → %s", pressKey.String(), releaseKey.String(), mc.learnFunction),
				})
			}

			mc.learningMode = false
			mc.learnFunction = ""
			mc.learnMapBoth = false
			mc.learnPressKey = nil

			// Save config
			go mc.SaveConfig()
		}
	} else {
		// Single mapping mode - ignore Note Off
		if isNoteOff {
			return
		}

		// Create default parameters
		params := mc.getDefaultParams(mc.learnFunction)

		// Store mapping
		mc.mappings[key] = MIDIMapping{
			Function:   mc.learnFunction,
			ThrottleMS: params.ThrottleMS,
			Mode:       params.Mode,
		}

		// Complete learn mode
		if mc.learnCallback != nil {
			mc.learnCallback(MIDILearnResponse{
				Type:    "midi_learn_completed",
				Control: key.String(),
				Message: fmt.Sprintf("Mapped: %s → %s", key.String(), mc.learnFunction),
			})
		}

		mc.learningMode = false
		mc.learnFunction = ""
		mc.learnMapBoth = false

		// Save config
		go mc.SaveConfig()
	}
}

// getDefaultParams returns default parameters for a function
func (mc *MIDIController) getDefaultParams(function string) MIDIMapping {
	// Encoder functions get 100ms rate_limit by default
	if len(function) >= 18 && function[:18] == "Frequency: Encoder" {
		return MIDIMapping{
			ThrottleMS: 100,
			Mode:       "rate_limit",
		}
	}
	return MIDIMapping{}
}

// executeMapping executes a mapped function with throttling
func (mc *MIDIController) executeMapping(key MIDIKey, mapping MIDIMapping, value uint8) {
	if mapping.ThrottleMS > 0 {
		if mapping.Mode == "rate_limit" {
			mc.executeRateLimited(key, mapping, value)
		} else {
			mc.executeDebounced(key, mapping, value)
		}
	} else {
		mc.executeFunction(mapping.Function, value)
	}
}

// executeRateLimited executes with rate limiting
func (mc *MIDIController) executeRateLimited(key MIDIKey, mapping MIDIMapping, value uint8) {
	mc.mu.Lock()
	lastTime, exists := mc.lastExecution[key]
	mc.mu.Unlock()

	now := time.Now()
	if !exists || now.Sub(lastTime) >= time.Duration(mapping.ThrottleMS)*time.Millisecond {
		mc.mu.Lock()
		mc.lastExecution[key] = now
		mc.mu.Unlock()

		mc.executeFunction(mapping.Function, value)
	}
}

// executeDebounced executes with debouncing
func (mc *MIDIController) executeDebounced(key MIDIKey, mapping MIDIMapping, value uint8) {
	mc.timerMu.Lock()

	// Cancel existing timer
	if timer, exists := mc.pendingTimers[key]; exists {
		timer.Stop()
	}

	// Create new timer
	timer := time.AfterFunc(time.Duration(mapping.ThrottleMS)*time.Millisecond, func() {
		mc.executeFunction(mapping.Function, value)

		mc.timerMu.Lock()
		delete(mc.pendingTimers, key)
		mc.timerMu.Unlock()

		mc.mu.Lock()
		mc.lastExecution[key] = time.Now()
		mc.mu.Unlock()
	})

	mc.pendingTimers[key] = timer
	mc.timerMu.Unlock()
}

// executeFunction executes a mapped function
func (mc *MIDIController) executeFunction(function string, value uint8) {
	if mc.manager == nil {
		return
	}

	// Get current status
	status := mc.manager.GetStatus()

	switch function {
	// Frequency controls
	case "Frequency: Step Up":
		mc.manager.SetFrequency(status.Frequency + 1000)

	case "Frequency: Step Down":
		mc.manager.SetFrequency(status.Frequency - 1000)

	case "Frequency: Encoder (10 Hz)":
		mc.handleEncoder(status.Frequency, value, 10)
	case "Frequency: Encoder (100 Hz)":
		mc.handleEncoder(status.Frequency, value, 100)
	case "Frequency: Encoder (500 Hz)":
		mc.handleEncoder(status.Frequency, value, 500)
	case "Frequency: Encoder (1 kHz)":
		mc.handleEncoder(status.Frequency, value, 1000)
	case "Frequency: Encoder (10 kHz)":
		mc.handleEncoder(status.Frequency, value, 10000)

	case "Frequency: Lock Toggle":
		if value > 0 {
			// Get fresh status to read current lock state
			currentStatus := mc.manager.GetStatus()
			newLocked := !currentStatus.FrequencyLocked
			// Save to config manager (which persists to disk)
			if mc.configManager != nil {
				err := mc.configManager.UpdateConfig(ConfigUpdateRequest{
					FrequencyLocked: &newLocked,
				})
				if err != nil {
					log.Printf("MIDI: Failed to save frequency lock config: %v", err)
				}
			}
			log.Printf("MIDI: Frequency lock toggled from %v to %v", currentStatus.FrequencyLocked, newLocked)
			// Small delay to ensure config is saved before broadcasting
			time.Sleep(50 * time.Millisecond)
			// Broadcast status update so UI gets the new lock state
			mc.manager.BroadcastStatus()
		}

	// Mode controls
	case "Mode: USB":
		mc.manager.SetMode("usb")
	case "Mode: LSB":
		mc.manager.SetMode("lsb")
	case "Mode: AM":
		mc.manager.SetMode("am")
	case "Mode: FM":
		mc.manager.SetMode("fm")
	case "Mode: CW":
		mc.manager.SetMode("cwu")
	case "Mode: Next":
		mc.cycleMode(status.Mode, 1)
	case "Mode: Previous":
		mc.cycleMode(status.Mode, -1)

	case "Mode: Lock Toggle":
		if value > 0 {
			// Get fresh status to read current lock state
			currentStatus := mc.manager.GetStatus()
			newLocked := !currentStatus.ModeLocked
			// Save to config manager (which persists to disk)
			if mc.configManager != nil {
				err := mc.configManager.UpdateConfig(ConfigUpdateRequest{
					ModeLocked: &newLocked,
				})
				if err != nil {
					log.Printf("MIDI: Failed to save mode lock config: %v", err)
				}
			}
			log.Printf("MIDI: Mode lock toggled from %v to %v", currentStatus.ModeLocked, newLocked)
			// Small delay to ensure config is saved before broadcasting
			time.Sleep(50 * time.Millisecond)
			// Broadcast status update so UI gets the new lock state
			mc.manager.BroadcastStatus()
		}

	// Band controls
	case "Band: 160m":
		mc.manager.SetFrequency(1900000)
	case "Band: 80m":
		mc.manager.SetFrequency(3573000)
	case "Band: 60m":
		mc.manager.SetFrequency(5357000)
	case "Band: 40m":
		mc.manager.SetFrequency(7074000)
	case "Band: 30m":
		mc.manager.SetFrequency(10136000)
	case "Band: 20m":
		mc.manager.SetFrequency(14074000)
	case "Band: 17m":
		mc.manager.SetFrequency(18100000)
	case "Band: 15m":
		mc.manager.SetFrequency(21074000)
	case "Band: 12m":
		mc.manager.SetFrequency(24915000)
	case "Band: 10m":
		mc.manager.SetFrequency(28074000)

	// Bandwidth controls
	case "Bandwidth: Low":
		if status.BandwidthLow != nil {
			// Map MIDI 0-127 to bandwidth range (-5000 to 0)
			newLow := int(-5000 + (int(value) * 5000 / 127))
			mc.manager.SetBandwidth(newLow, *status.BandwidthHigh)
		}
	case "Bandwidth: High":
		if status.BandwidthHigh != nil {
			// Map MIDI 0-127 to bandwidth range (0 to 5000)
			newHigh := int(int(value) * 5000 / 127)
			mc.manager.SetBandwidth(*status.BandwidthLow, newHigh)
		}

	// Volume control
	case "Volume":
		// Map MIDI 0-127 to volume 0.0-1.0 (0-100%)
		volume := float64(value) / 127.0
		mc.manager.UpdateConfig(ConfigUpdateRequest{
			Volume: &volume,
		})

	// Mute control
	case "Mute":
		if value > 0 {
			// Toggle mute with state memory
			// Get current channel states from the manager (runtime state)
			leftEnabled, rightEnabled := mc.manager.GetChannelStates()

			mc.mu.Lock()
			if mc.mutedState {
				// Currently muted - restore previous state
				log.Printf("Unmuting - restoring Left: %v, Right: %v", mc.savedLeftState, mc.savedRightState)
				mc.manager.UpdateConfig(ConfigUpdateRequest{
					LeftChannelEnabled:  &mc.savedLeftState,
					RightChannelEnabled: &mc.savedRightState,
				})
				mc.mutedState = false
			} else {
				// Currently unmuted - save state and mute
				mc.savedLeftState = leftEnabled
				mc.savedRightState = rightEnabled
				muted := false
				log.Printf("Muting - saving Left: %v, Right: %v", leftEnabled, rightEnabled)
				mc.manager.UpdateConfig(ConfigUpdateRequest{
					LeftChannelEnabled:  &muted,
					RightChannelEnabled: &muted,
				})
				mc.mutedState = true
			}
			mc.mu.Unlock()
		}

	// Toggle controls (only on button press, value > 0)
	case "NR2: Toggle":
		if value > 0 {
			mc.manager.UpdateConfig(ConfigUpdateRequest{
				NR2Enabled: boolPtr(!status.NR2Enabled),
			})
		}
	}
}

// handleEncoder handles encoder input
func (mc *MIDIController) handleEncoder(currentFreq int, value uint8, step int) {
	var newFreq int
	if value >= 64 {
		// Counter-clockwise
		newFreq = currentFreq - step
	} else {
		// Clockwise
		newFreq = currentFreq + step
	}
	mc.manager.SetFrequency(newFreq)
}

// cycleMode cycles through modes
func (mc *MIDIController) cycleMode(currentMode string, direction int) {
	modes := []string{"usb", "lsb", "cwu", "cwl", "am", "fm"}

	// Find current mode index
	currentIndex := 0
	for i, mode := range modes {
		if mode == currentMode {
			currentIndex = i
			break
		}
	}

	// Calculate new index
	newIndex := (currentIndex + direction + len(modes)) % len(modes)
	mc.manager.SetMode(modes[newIndex])
}

// StartLearnMode starts learn mode
func (mc *MIDIController) StartLearnMode(function string, mapBoth bool, callback func(MIDILearnResponse)) error {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	if !mc.connected {
		return fmt.Errorf("not connected to MIDI device")
	}

	mc.learningMode = true
	mc.learnFunction = function
	mc.learnMapBoth = mapBoth
	mc.learnCallback = callback
	mc.learnPressKey = nil

	return nil
}

// StopLearnMode stops learn mode
func (mc *MIDIController) StopLearnMode() {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	mc.learningMode = false
	mc.learnFunction = ""
	mc.learnMapBoth = false
	mc.learnCallback = nil
	mc.learnPressKey = nil
}

// GetStatus returns the current MIDI controller status
func (mc *MIDIController) GetStatus() MIDIStatus {
	mc.mu.RLock()
	defer mc.mu.RUnlock()

	return MIDIStatus{
		Connected:    mc.connected,
		DeviceName:   mc.deviceName,
		MappingCount: len(mc.mappings),
		LearningMode: mc.learningMode,
	}
}

// GetMappings returns all current mappings
func (mc *MIDIController) GetMappings() map[MIDIKey]MIDIMapping {
	mc.mu.RLock()
	defer mc.mu.RUnlock()

	// Return a copy
	mappings := make(map[MIDIKey]MIDIMapping, len(mc.mappings))
	for k, v := range mc.mappings {
		mappings[k] = v
	}
	return mappings
}

// AddMapping adds or updates a mapping
func (mc *MIDIController) AddMapping(key MIDIKey, mapping MIDIMapping) {
	mc.mu.Lock()
	mc.mappings[key] = mapping
	mc.mu.Unlock()

	go mc.SaveConfig()
}

// DeleteMapping deletes a mapping
func (mc *MIDIController) DeleteMapping(key MIDIKey) {
	mc.mu.Lock()
	delete(mc.mappings, key)
	mc.mu.Unlock()

	go mc.SaveConfig()
}

// ClearMappings clears all mappings
func (mc *MIDIController) ClearMappings() {
	mc.mu.Lock()
	mc.mappings = make(map[MIDIKey]MIDIMapping)
	mc.mu.Unlock()

	go mc.SaveConfig()
}

// SaveConfig saves the configuration to the config manager
func (mc *MIDIController) SaveConfig() error {
	mc.mu.RLock()
	enabled := mc.connected
	deviceName := mc.deviceName
	mappings := make(map[MIDIKey]MIDIMapping, len(mc.mappings))
	for k, v := range mc.mappings {
		mappings[k] = v
	}
	mc.mu.RUnlock()

	if mc.configManager != nil {
		if err := mc.configManager.UpdateMIDIConfig(enabled, deviceName, mappings); err != nil {
			return fmt.Errorf("failed to save MIDI config: %w", err)
		}
		log.Printf("MIDI configuration saved")
	}

	return nil
}

// LoadConfig loads the configuration from the config manager
func (mc *MIDIController) LoadConfig() error {
	if mc.configManager == nil {
		return nil
	}

	enabled, deviceName, mappings := mc.configManager.GetMIDIConfig()

	mc.mu.Lock()
	mc.mappings = mappings
	if mc.mappings == nil {
		mc.mappings = make(map[MIDIKey]MIDIMapping)
	}
	alreadyConnected := mc.connected
	mc.mu.Unlock()

	log.Printf("MIDI configuration loaded (%d mappings)", len(mappings))

	// Auto-connect to saved device if specified and not already connected
	if enabled && deviceName != "" && !alreadyConnected {
		// Capture device name for goroutine
		savedDeviceName := deviceName

		// Use a timer-based approach for delayed auto-connect
		time.AfterFunc(1*time.Second, func() {
			// Double-check we're still not connected
			mc.mu.RLock()
			stillNotConnected := !mc.connected
			mc.mu.RUnlock()

			if stillNotConnected {
				if err := mc.Connect(savedDeviceName); err != nil {
					log.Printf("Failed to auto-connect to MIDI device %s: %v", savedDeviceName, err)
				} else {
					log.Printf("Auto-connected to MIDI device: %s", savedDeviceName)
				}
			}
		})
	}

	return nil
}

// Cleanup cleans up resources
func (mc *MIDIController) Cleanup() {
	mc.cancel()

	if mc.connected {
		mc.Disconnect()
	}

	// Cancel all pending timers
	mc.timerMu.Lock()
	for _, timer := range mc.pendingTimers {
		timer.Stop()
	}
	mc.pendingTimers = make(map[MIDIKey]*time.Timer)
	mc.timerMu.Unlock()
}

// Helper function
func boolPtr(b bool) *bool {
	return &b
}
