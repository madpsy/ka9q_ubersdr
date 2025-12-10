package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// SavedInstance represents a saved server instance configuration
type SavedInstance struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	SSL      bool   `json:"ssl"`
	Password string `json:"password,omitempty"` // Optional password field
}

// ClientConfig represents the persistent configuration
type ClientConfig struct {
	Host                string          `json:"host"`
	Port                int             `json:"port"`
	SSL                 bool            `json:"ssl"`
	Frequency           int             `json:"frequency"`
	Mode                string          `json:"mode"`
	BandwidthLow        *int            `json:"bandwidthLow,omitempty"`
	BandwidthHigh       *int            `json:"bandwidthHigh,omitempty"`
	Password            string          `json:"password,omitempty"`
	OutputMode          string          `json:"outputMode"`
	AudioDevice         int             `json:"audioDevice"`
	NR2Enabled          bool            `json:"nr2Enabled"`
	NR2Strength         float64         `json:"nr2Strength"`
	NR2Floor            float64         `json:"nr2Floor"`
	NR2AdaptRate        float64         `json:"nr2AdaptRate"`
	ResampleEnabled     bool            `json:"resampleEnabled"`
	ResampleOutputRate  int             `json:"resampleOutputRate"`
	OutputChannels      int             `json:"outputChannels"`
	AudioPreviewEnabled bool            `json:"audioPreviewEnabled"`
	AudioPreviewMuted   bool            `json:"audioPreviewMuted"`
	AutoConnect         bool            `json:"autoConnect"`
	SpectrumEnabled     bool            `json:"spectrumEnabled"`
	SpectrumZoomScroll  bool            `json:"spectrumZoomScroll"`
	SpectrumPanScroll   bool            `json:"spectrumPanScroll"`
	SpectrumClickTune   bool            `json:"spectrumClickTune"`
	SpectrumCenterTune  bool            `json:"spectrumCenterTune"`
	APIPort             int             `json:"apiPort"`
	SavedInstances      []SavedInstance `json:"savedInstances,omitempty"`
	FIFOPath            string          `json:"fifoPath,omitempty"`
	FIFOEnabled         bool            `json:"fifoEnabled"`
	UDPHost             string          `json:"udpHost,omitempty"`
	UDPPort             int             `json:"udpPort,omitempty"`
	UDPEnabled          bool            `json:"udpEnabled"`
	PortAudioEnabled    bool            `json:"portAudioEnabled"`
	PortAudioDevice     int             `json:"portAudioDevice"`
	// Radio control settings
	RadioControlType  string `json:"radioControlType,omitempty"` // "none", "flrig", "rigctl", "serial", "omnirig"
	FlrigEnabled      bool   `json:"flrigEnabled"`
	FlrigHost         string `json:"flrigHost,omitempty"`
	FlrigPort         int    `json:"flrigPort,omitempty"`
	FlrigVFO          string `json:"flrigVFO,omitempty"` // "A" or "B"
	FlrigSyncToRig    bool   `json:"flrigSyncToRig"`     // Sync SDR frequency changes to rig
	FlrigSyncFromRig  bool   `json:"flrigSyncFromRig"`   // Sync rig frequency changes to SDR
	RigctlEnabled     bool   `json:"rigctlEnabled"`
	RigctlHost        string `json:"rigctlHost,omitempty"`
	RigctlPort        int    `json:"rigctlPort,omitempty"`
	RigctlVFO         string `json:"rigctlVFO,omitempty"` // "VFOA" or "VFOB"
	RigctlSyncToRig   bool   `json:"rigctlSyncToRig"`     // Sync SDR frequency changes to rig
	RigctlSyncFromRig bool   `json:"rigctlSyncFromRig"`   // Sync rig frequency changes to SDR
}

// ConfigManager handles loading and saving configuration
type ConfigManager struct {
	configPath string
	config     ClientConfig
	mu         sync.RWMutex
}

// NewConfigManager creates a new config manager
func NewConfigManager(configPath string) *ConfigManager {
	return &ConfigManager{
		configPath: configPath,
		config:     getDefaultConfig(),
	}
}

// getDefaultConfig returns default configuration values
func getDefaultConfig() ClientConfig {
	return ClientConfig{
		Host:                "localhost",
		Port:                8080,
		SSL:                 false,
		Frequency:           14074000,
		Mode:                "usb",
		BandwidthLow:        intPtr(50),
		BandwidthHigh:       intPtr(2700),
		OutputMode:          "portaudio",
		AudioDevice:         -1,
		NR2Enabled:          false,
		NR2Strength:         40.0,
		NR2Floor:            10.0,
		NR2AdaptRate:        1.0,
		ResampleEnabled:     false,
		ResampleOutputRate:  44100,
		OutputChannels:      2, // Default to stereo for better device compatibility
		AudioPreviewEnabled: false,
		AudioPreviewMuted:   true,  // Muted by default
		AutoConnect:         false, // Disabled by default
		APIPort:             8090,
		FIFOPath:            "",          // No FIFO by default
		FIFOEnabled:         false,       // FIFO disabled by default
		UDPHost:             "127.0.0.1", // Default UDP host
		UDPPort:             8888,        // Default UDP port
		UDPEnabled:          false,       // UDP disabled by default
		PortAudioEnabled:    false,       // PortAudio disabled by default
		PortAudioDevice:     -1,          // Auto-select device
		RadioControlType:    "none",      // No radio control by default
		FlrigEnabled:        false,       // flrig disabled by default
		FlrigHost:           "localhost", // Default flrig host
		FlrigPort:           12345,       // Default flrig port
		FlrigVFO:            "A",         // Default to VFO A
		FlrigSyncToRig:      true,        // Sync SDR->rig by default
		FlrigSyncFromRig:    true,        // Sync rig->SDR by default
		RigctlEnabled:       false,       // rigctl disabled by default
		RigctlHost:          "localhost", // Default rigctld host
		RigctlPort:          4532,        // Default rigctld port
		RigctlVFO:           "VFOA",      // Default to VFO A
		RigctlSyncToRig:     true,        // Sync SDR->rig by default
		RigctlSyncFromRig:   true,        // Sync rig->SDR by default
	}
}

// Load loads configuration from file, returns default if file doesn't exist
func (cm *ConfigManager) Load() error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	// Check if file exists
	if _, err := os.Stat(cm.configPath); os.IsNotExist(err) {
		// File doesn't exist, use defaults
		cm.config = getDefaultConfig()
		return nil
	}

	// Read file
	data, err := os.ReadFile(cm.configPath)
	if err != nil {
		return fmt.Errorf("failed to read config file: %w", err)
	}

	// Parse JSON
	if err := json.Unmarshal(data, &cm.config); err != nil {
		return fmt.Errorf("failed to parse config file: %w", err)
	}

	return nil
}

// Save saves current configuration to file
func (cm *ConfigManager) Save() error {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	// Ensure directory exists
	dir := filepath.Dir(cm.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Marshal to JSON with indentation
	data, err := json.MarshalIndent(cm.config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	// Write to file
	if err := os.WriteFile(cm.configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}

// Get returns a copy of the current configuration
func (cm *ConfigManager) Get() ClientConfig {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	return cm.config
}

// Update updates the configuration and saves it
func (cm *ConfigManager) Update(updater func(*ClientConfig)) error {
	cm.mu.Lock()
	updater(&cm.config)
	cm.mu.Unlock()

	return cm.Save()
}

// UpdateFromConnectRequest updates config from a connect request
func (cm *ConfigManager) UpdateFromConnectRequest(req ConnectRequest) error {
	return cm.Update(func(c *ClientConfig) {
		c.Host = req.Host
		c.Port = req.Port
		c.SSL = req.SSL
		c.Frequency = req.Frequency
		c.Mode = req.Mode
		c.BandwidthLow = req.BandwidthLow
		c.BandwidthHigh = req.BandwidthHigh
		if req.Password != "" {
			c.Password = req.Password
		}
		if req.OutputMode != "" {
			c.OutputMode = req.OutputMode
		}
		c.AudioDevice = req.AudioDevice
		c.NR2Enabled = req.NR2Enabled
		c.NR2Strength = req.NR2Strength
		c.NR2Floor = req.NR2Floor
		c.NR2AdaptRate = req.NR2AdaptRate
		c.ResampleEnabled = req.ResampleEnabled
		c.ResampleOutputRate = req.ResampleOutputRate
		c.OutputChannels = req.OutputChannels
		c.FIFOPath = req.FIFOPath
		c.UDPHost = req.UDPHost
		c.UDPPort = req.UDPPort
		c.UDPEnabled = req.UDPEnabled
		// Note: PortAudio and FIFO enabled states are managed separately via output control API
	})
}

// UpdateFromTuneRequest updates config from a tune request
func (cm *ConfigManager) UpdateFromTuneRequest(req TuneRequest) error {
	return cm.Update(func(c *ClientConfig) {
		if req.Frequency != nil {
			c.Frequency = *req.Frequency
		}
		if req.Mode != "" {
			c.Mode = req.Mode
		}
		if req.BandwidthLow != nil {
			c.BandwidthLow = req.BandwidthLow
		}
		if req.BandwidthHigh != nil {
			c.BandwidthHigh = req.BandwidthHigh
		}
	})
}

// UpdateNR2Config updates NR2 configuration
func (cm *ConfigManager) UpdateNR2Config(req ConfigUpdateRequest) error {
	return cm.Update(func(c *ClientConfig) {
		if req.NR2Enabled != nil {
			c.NR2Enabled = *req.NR2Enabled
		}
		if req.NR2Strength != nil {
			c.NR2Strength = *req.NR2Strength
		}
		if req.NR2Floor != nil {
			c.NR2Floor = *req.NR2Floor
		}
		if req.NR2AdaptRate != nil {
			c.NR2AdaptRate = *req.NR2AdaptRate
		}
		if req.AudioPreviewEnabled != nil {
			c.AudioPreviewEnabled = *req.AudioPreviewEnabled
		}
		if req.AudioPreviewMuted != nil {
			c.AudioPreviewMuted = *req.AudioPreviewMuted
		}
		if req.AutoConnect != nil {
			c.AutoConnect = *req.AutoConnect
		}
		if req.SpectrumEnabled != nil {
			c.SpectrumEnabled = *req.SpectrumEnabled
		}
		if req.SpectrumZoomScroll != nil {
			c.SpectrumZoomScroll = *req.SpectrumZoomScroll
		}
		if req.SpectrumPanScroll != nil {
			c.SpectrumPanScroll = *req.SpectrumPanScroll
		}
		if req.SpectrumClickTune != nil {
			c.SpectrumClickTune = *req.SpectrumClickTune
		}
		if req.SpectrumCenterTune != nil {
			c.SpectrumCenterTune = *req.SpectrumCenterTune
		}
	})
}

// UpdateOutputStates updates the output enabled states
func (cm *ConfigManager) UpdateOutputStates(portAudioEnabled bool, portAudioDevice int, fifoEnabled bool, udpEnabled bool) error {
	return cm.Update(func(c *ClientConfig) {
		c.PortAudioEnabled = portAudioEnabled
		c.PortAudioDevice = portAudioDevice
		c.FIFOEnabled = fifoEnabled
		c.UDPEnabled = udpEnabled
	})
}

// GetConfigPath returns the default config file path
func GetConfigPath() string {
	// Try to use user's config directory
	if configDir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(configDir, "ubersdr", "client_config.json")
	}

	// Fallback to current directory
	return "client_config.json"
}

// GetSavedInstances returns the list of saved instances
func (cm *ConfigManager) GetSavedInstances() []SavedInstance {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	// Return a copy to prevent external modification
	instances := make([]SavedInstance, len(cm.config.SavedInstances))
	copy(instances, cm.config.SavedInstances)
	return instances
}

// SaveInstance adds or updates a saved instance
func (cm *ConfigManager) SaveInstance(instance SavedInstance) error {
	return cm.Update(func(c *ClientConfig) {
		// Check if instance with this name already exists
		found := false
		for i, existing := range c.SavedInstances {
			if existing.Name == instance.Name {
				// Update existing instance
				c.SavedInstances[i] = instance
				found = true
				break
			}
		}

		// Add new instance if not found
		if !found {
			c.SavedInstances = append(c.SavedInstances, instance)
		}
	})
}

// DeleteInstance removes a saved instance by name
func (cm *ConfigManager) DeleteInstance(name string) error {
	return cm.Update(func(c *ClientConfig) {
		// Filter out the instance with the given name
		filtered := make([]SavedInstance, 0, len(c.SavedInstances))
		for _, instance := range c.SavedInstances {
			if instance.Name != name {
				filtered = append(filtered, instance)
			}
		}
		c.SavedInstances = filtered
	})
}

// LoadInstance loads a saved instance by name and updates current connection settings
func (cm *ConfigManager) LoadInstance(name string) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	// Find the instance
	var found *SavedInstance
	for _, instance := range cm.config.SavedInstances {
		if instance.Name == name {
			found = &instance
			break
		}
	}

	if found == nil {
		return fmt.Errorf("instance not found: %s", name)
	}

	// Update current connection settings
	cm.config.Host = found.Host
	cm.config.Port = found.Port
	cm.config.SSL = found.SSL

	// Save the updated config
	cm.mu.Unlock()
	err := cm.Save()
	cm.mu.Lock()

	return err
}

// Helper function to create int pointer
func intPtr(i int) *int {
	return &i
}
