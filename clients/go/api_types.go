package main

import "time"

// API Request Types

// ConnectRequest represents a request to connect to an SDR server
type ConnectRequest struct {
	Host               string  `json:"host"`
	Port               int     `json:"port"`
	SSL                bool    `json:"ssl"`
	Frequency          int     `json:"frequency"`
	Mode               string  `json:"mode"`
	BandwidthLow       *int    `json:"bandwidthLow,omitempty"`
	BandwidthHigh      *int    `json:"bandwidthHigh,omitempty"`
	Password           string  `json:"password,omitempty"`
	OutputMode         string  `json:"outputMode,omitempty"`
	AudioDevice        int     `json:"audioDevice,omitempty"`
	NR2Enabled         bool    `json:"nr2Enabled,omitempty"`
	NR2Strength        float64 `json:"nr2Strength,omitempty"`
	NR2Floor           float64 `json:"nr2Floor,omitempty"`
	NR2AdaptRate       float64 `json:"nr2AdaptRate,omitempty"`
	ResampleEnabled    bool    `json:"resampleEnabled,omitempty"`
	ResampleOutputRate int     `json:"resampleOutputRate,omitempty"`
	OutputChannels     int     `json:"outputChannels,omitempty"`
	FIFOPath           string  `json:"fifoPath,omitempty"`
	UDPHost            string  `json:"udpHost,omitempty"`
	UDPPort            int     `json:"udpPort,omitempty"`
	UDPEnabled         bool    `json:"udpEnabled,omitempty"`
}

// TuneRequest represents a request to change frequency/mode/bandwidth without reconnecting
type TuneRequest struct {
	Frequency     *int   `json:"frequency,omitempty"`
	Mode          string `json:"mode,omitempty"`
	BandwidthLow  *int   `json:"bandwidthLow,omitempty"`
	BandwidthHigh *int   `json:"bandwidthHigh,omitempty"`
}

// FrequencyRequest represents a request to change only the frequency
type FrequencyRequest struct {
	Frequency int `json:"frequency"`
}

// ModeRequest represents a request to change only the mode
type ModeRequest struct {
	Mode string `json:"mode"`
}

// BandwidthRequest represents a request to change bandwidth
type BandwidthRequest struct {
	BandwidthLow  int `json:"bandwidthLow"`
	BandwidthHigh int `json:"bandwidthHigh"`
}

// AudioDeviceRequest represents a request to change audio device
type AudioDeviceRequest struct {
	DeviceIndex int `json:"deviceIndex"`
}

// VolumeRequest represents a request to change volume
type VolumeRequest struct {
	Volume float64 `json:"volume"` // 0.0 to 2.0 (0-200%)
}

// ConfigUpdateRequest represents a request to update configuration
type ConfigUpdateRequest struct {
	NR2Enabled          *bool    `json:"nr2Enabled,omitempty"`
	NR2Strength         *float64 `json:"nr2Strength,omitempty"`
	NR2Floor            *float64 `json:"nr2Floor,omitempty"`
	NR2AdaptRate        *float64 `json:"nr2AdaptRate,omitempty"`
	AudioPreviewEnabled *bool    `json:"audioPreviewEnabled,omitempty"`
	AudioPreviewMuted   *bool    `json:"audioPreviewMuted,omitempty"`
	AutoConnect         *bool    `json:"autoConnect,omitempty"`
	ConnectOnDemand     *bool    `json:"connectOnDemand,omitempty"`
	StayConnected       *bool    `json:"stayConnected,omitempty"`
	SpectrumEnabled     *bool    `json:"spectrumEnabled,omitempty"`
	SpectrumZoomScroll  *bool    `json:"spectrumZoomScroll,omitempty"`
	SpectrumPanScroll   *bool    `json:"spectrumPanScroll,omitempty"`
	SpectrumClickTune   *bool    `json:"spectrumClickTune,omitempty"`
	SpectrumCenterTune  *bool    `json:"spectrumCenterTune,omitempty"`
	SpectrumSnap        *int     `json:"spectrumSnap,omitempty"`
	Volume              *float64 `json:"volume,omitempty"`
	LeftChannelEnabled  *bool    `json:"leftChannelEnabled,omitempty"`
	RightChannelEnabled *bool    `json:"rightChannelEnabled,omitempty"`
	PortAudioDevice     *int     `json:"portAudioDevice,omitempty"`
	ResampleEnabled     *bool    `json:"resampleEnabled,omitempty"`
	ResampleOutputRate  *int     `json:"resampleOutputRate,omitempty"`
	OutputChannels      *int     `json:"outputChannels,omitempty"`
	RadioControlType    *string  `json:"radioControlType,omitempty"`
	TCIAutoStart        *bool    `json:"tciAutoStart,omitempty"`
	FrequencyLocked     *bool    `json:"frequencyLocked,omitempty"`
	ModeLocked          *bool    `json:"modeLocked,omitempty"`
}

// OutputControlRequest represents a request to control an output
type OutputControlRequest struct {
	Enabled     bool   `json:"enabled"`
	DeviceIndex *int   `json:"deviceIndex,omitempty"` // For PortAudio
	Path        string `json:"path,omitempty"`        // For FIFO
	Host        string `json:"host,omitempty"`        // For UDP
	Port        int    `json:"port,omitempty"`        // For UDP
}

// FlrigConnectRequest represents a request to connect to flrig
type FlrigConnectRequest struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	VFO         string `json:"vfo"`         // "A" or "B"
	SyncToRig   bool   `json:"syncToRig"`   // Sync SDR frequency changes to rig
	SyncFromRig bool   `json:"syncFromRig"` // Sync rig frequency changes to SDR
}

// FlrigVFORequest represents a request to change flrig VFO
type FlrigVFORequest struct {
	VFO string `json:"vfo"` // "A" or "B"
}

// FlrigSyncRequest represents a request to update flrig sync settings
type FlrigSyncRequest struct {
	SyncToRig   bool `json:"syncToRig"`   // Sync SDR frequency changes to rig
	SyncFromRig bool `json:"syncFromRig"` // Sync rig frequency changes to SDR
}

// RigctlConnectRequest represents a request to connect to rigctld
type RigctlConnectRequest struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	VFO         string `json:"vfo"`         // "VFOA" or "VFOB"
	SyncToRig   bool   `json:"syncToRig"`   // Sync SDR frequency changes to rig
	SyncFromRig bool   `json:"syncFromRig"` // Sync rig frequency changes to SDR
}

// RigctlVFORequest represents a request to change rigctl VFO
type RigctlVFORequest struct {
	VFO string `json:"vfo"` // "VFOA" or "VFOB"
}

// RigctlSyncRequest represents a request to update rigctl sync settings
type RigctlSyncRequest struct {
	SyncToRig   bool `json:"syncToRig"`   // Sync SDR frequency changes to rig
	SyncFromRig bool `json:"syncFromRig"` // Sync rig frequency changes to SDR
}

// SerialConnectRequest represents a request to connect to serial port
type SerialConnectRequest struct {
	Port        string `json:"port"`
	Baudrate    int    `json:"baudrate"`
	VFO         string `json:"vfo"`         // "A" or "B"
	SyncToRig   bool   `json:"syncToRig"`   // Sync SDR frequency changes to rig
	SyncFromRig bool   `json:"syncFromRig"` // Sync rig frequency changes to SDR
}

// SerialVFORequest represents a request to change serial VFO
type SerialVFORequest struct {
	VFO string `json:"vfo"` // "A" or "B"
}

// SerialSyncRequest represents a request to update serial sync settings
type SerialSyncRequest struct {
	SyncToRig   bool `json:"syncToRig"`   // Sync SDR frequency changes to rig
	SyncFromRig bool `json:"syncFromRig"` // Sync rig frequency changes to SDR
}

// TCIConnectRequest represents a request to start TCI server
type TCIConnectRequest struct {
	Port      int  `json:"port"`      // TCI server port (default: 40001)
	AutoStart bool `json:"autoStart"` // Auto-start TCI server on program start
}

// MIDIConnectRequest represents a request to connect to a MIDI device
type MIDIConnectRequest struct {
	DeviceName string `json:"deviceName"`
}

// MIDILearnRequest represents a request to start MIDI learn mode
type MIDILearnRequest struct {
	Function string `json:"function"` // Function to learn
	MapBoth  bool   `json:"mapBoth"`  // Map both press and release
}

// MIDIAddMappingRequest represents a request to add a MIDI mapping
type MIDIAddMappingRequest struct {
	Type       uint8  `json:"type"`       // MIDI message type (0x90=Note On, 0x80=Note Off, 0xB0=CC)
	Channel    uint8  `json:"channel"`    // MIDI channel (0-15)
	Data1      uint8  `json:"data1"`      // Note number or CC number
	Function   string `json:"function"`   // Function to execute
	ThrottleMS int    `json:"throttleMs"` // Throttle time in milliseconds
	Mode       string `json:"mode"`       // Throttle mode: "debounce" or "rate_limit"
}

// LocalBookmarkRequest represents a request to save a local bookmark
type LocalBookmarkRequest struct {
	Name          string `json:"name"`
	Frequency     int    `json:"frequency"`
	Mode          string `json:"mode"`
	BandwidthLow  *int   `json:"bandwidthLow,omitempty"`
	BandwidthHigh *int   `json:"bandwidthHigh,omitempty"`
}

// LocalBookmarkUpdateRequest represents a request to update a local bookmark
type LocalBookmarkUpdateRequest struct {
	NewName       string `json:"newName,omitempty"`
	Frequency     *int   `json:"frequency,omitempty"`
	Mode          string `json:"mode,omitempty"`
	BandwidthLow  *int   `json:"bandwidthLow,omitempty"`
	BandwidthHigh *int   `json:"bandwidthHigh,omitempty"`
}

// API Response Types

// StatusResponse represents the current client status
type StatusResponse struct {
	Connected          bool                   `json:"connected"`
	Frequency          int                    `json:"frequency"`
	Mode               string                 `json:"mode"`
	BandwidthLow       *int                   `json:"bandwidthLow,omitempty"`
	BandwidthHigh      *int                   `json:"bandwidthHigh,omitempty"`
	SampleRate         int                    `json:"sampleRate"`
	Channels           int                    `json:"channels"`
	SessionID          string                 `json:"sessionId,omitempty"`
	UserSessionID      string                 `json:"userSessionId"`
	AudioDevice        string                 `json:"audioDevice"`
	AudioDeviceIdx     int                    `json:"audioDeviceIndex"`
	OutputMode         string                 `json:"outputMode"`
	NR2Enabled         bool                   `json:"nr2Enabled"`
	NR2Strength        float64                `json:"nr2Strength"`
	NR2Floor           float64                `json:"nr2Floor"`
	NR2AdaptRate       float64                `json:"nr2AdaptRate"`
	ResampleEnabled    bool                   `json:"resampleEnabled"`
	ResampleOutputRate int                    `json:"resampleOutputRate"`
	OutputChannels     int                    `json:"outputChannels"`
	Host               string                 `json:"host,omitempty"`
	Port               int                    `json:"port,omitempty"`
	SSL                bool                   `json:"ssl"`
	ConnectedAt        time.Time              `json:"connectedAt,omitempty"`
	Uptime             string                 `json:"uptime,omitempty"`
	FIFOPath           string                 `json:"fifoPath,omitempty"`
	UDPHost            string                 `json:"udpHost,omitempty"`
	UDPPort            int                    `json:"udpPort,omitempty"`
	UDPEnabled         bool                   `json:"udpEnabled"`
	Bypassed           bool                   `json:"bypassed"`
	AllowedIQModes     []string               `json:"allowedIQModes,omitempty"`
	MaxSessionTime     int                    `json:"maxSessionTime"`
	SessionStartTime   time.Time              `json:"sessionStartTime,omitempty"`
	OutputStatus       map[string]interface{} `json:"outputStatus,omitempty"`
	CurrentBand        string                 `json:"currentBand,omitempty"` // Current amateur radio band (e.g., "20m", "40m", or "" if not in a band)
	FrequencyLocked    bool                   `json:"frequencyLocked"`
	ModeLocked         bool                   `json:"modeLocked"`
}

// AudioDevice represents an audio output device
type AudioDevice struct {
	Index       int     `json:"index"`
	Name        string  `json:"name"`
	MaxChannels int     `json:"maxChannels"`
	SampleRate  float64 `json:"sampleRate"`
	Latency     float64 `json:"latency"` // in milliseconds
	IsDefault   bool    `json:"isDefault"`
}

// AudioDevicesResponse represents the list of available audio devices
type AudioDevicesResponse struct {
	Devices []AudioDevice `json:"devices"`
}

// ConfigResponse represents the current configuration
type ConfigResponse struct {
	Host                string  `json:"host"`
	Port                int     `json:"port"`
	SSL                 bool    `json:"ssl"`
	Frequency           int     `json:"frequency"`
	Mode                string  `json:"mode"`
	BandwidthLow        *int    `json:"bandwidthLow,omitempty"`
	BandwidthHigh       *int    `json:"bandwidthHigh,omitempty"`
	OutputMode          string  `json:"outputMode"`
	AudioDevice         int     `json:"audioDevice"`
	NR2Enabled          bool    `json:"nr2Enabled"`
	NR2Strength         float64 `json:"nr2Strength"`
	NR2Floor            float64 `json:"nr2Floor"`
	NR2AdaptRate        float64 `json:"nr2AdaptRate"`
	ResampleEnabled     bool    `json:"resampleEnabled"`
	ResampleOutputRate  int     `json:"resampleOutputRate"`
	OutputChannels      int     `json:"outputChannels"`
	AudioPreviewEnabled bool    `json:"audioPreviewEnabled"`
	AudioPreviewMuted   bool    `json:"audioPreviewMuted"`
	AutoConnect         bool    `json:"autoConnect"`
	ConnectOnDemand     bool    `json:"connectOnDemand"`
	StayConnected       bool    `json:"stayConnected"`
	SpectrumEnabled     bool    `json:"spectrumEnabled"`
	SpectrumZoomScroll  bool    `json:"spectrumZoomScroll"`
	SpectrumPanScroll   bool    `json:"spectrumPanScroll"`
	SpectrumClickTune   bool    `json:"spectrumClickTune"`
	SpectrumCenterTune  bool    `json:"spectrumCenterTune"`
	SpectrumSnap        int     `json:"spectrumSnap"`
	FIFOPath            string  `json:"fifoPath,omitempty"`
	UDPHost             string  `json:"udpHost,omitempty"`
	UDPPort             int     `json:"udpPort,omitempty"`
	UDPEnabled          bool    `json:"udpEnabled"`
	Volume              float64 `json:"volume"`
	LeftChannelEnabled  bool    `json:"leftChannelEnabled"`
	RightChannelEnabled bool    `json:"rightChannelEnabled"`
	PortAudioDevice     int     `json:"portAudioDevice"`
	// Radio control settings
	RadioControlType  string `json:"radioControlType,omitempty"`
	FlrigEnabled      bool   `json:"flrigEnabled"`
	FlrigHost         string `json:"flrigHost,omitempty"`
	FlrigPort         int    `json:"flrigPort,omitempty"`
	FlrigVFO          string `json:"flrigVFO,omitempty"`
	FlrigSyncToRig    bool   `json:"flrigSyncToRig"`
	FlrigSyncFromRig  bool   `json:"flrigSyncFromRig"`
	RigctlEnabled     bool   `json:"rigctlEnabled"`
	RigctlHost        string `json:"rigctlHost,omitempty"`
	RigctlPort        int    `json:"rigctlPort,omitempty"`
	RigctlVFO         string `json:"rigctlVFO,omitempty"`
	RigctlSyncToRig   bool   `json:"rigctlSyncToRig"`
	RigctlSyncFromRig bool   `json:"rigctlSyncFromRig"`
	SerialEnabled     bool   `json:"serialEnabled"`
	SerialPort        string `json:"serialPort,omitempty"`
	SerialBaudrate    int    `json:"serialBaudrate,omitempty"`
	SerialVFO         string `json:"serialVFO,omitempty"`
	SerialSyncToRig   bool   `json:"serialSyncToRig"`
	SerialSyncFromRig bool   `json:"serialSyncFromRig"`
	TCIEnabled        bool   `json:"tciEnabled"`
	TCIPort           int    `json:"tciPort,omitempty"`
	TCIAutoStart      bool   `json:"tciAutoStart"`
	// Lock settings
	FrequencyLocked bool `json:"frequencyLocked"`
	ModeLocked      bool `json:"modeLocked"`
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// SuccessResponse represents a generic success response
type SuccessResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

// WebSocket Message Types (for frontend updates)

// WSStatusUpdate represents a WebSocket status update message
type WSStatusUpdate struct {
	Type            string    `json:"type"` // "status"
	Connected       bool      `json:"connected"`
	Frequency       int       `json:"frequency"`
	Mode            string    `json:"mode"`
	SampleRate      int       `json:"sampleRate"`
	Channels        int       `json:"channels"`
	SessionID       string    `json:"sessionId,omitempty"`
	CurrentBand     string    `json:"currentBand,omitempty"` // Current amateur radio band
	FrequencyLocked bool      `json:"frequencyLocked"`
	ModeLocked      bool      `json:"modeLocked"`
	Timestamp       time.Time `json:"timestamp"`
}

// WSErrorUpdate represents a WebSocket error message
type WSErrorUpdate struct {
	Type      string    `json:"type"` // "error"
	Error     string    `json:"error"`
	Message   string    `json:"message,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// WSConnectionUpdate represents a WebSocket connection state change
type WSConnectionUpdate struct {
	Type      string    `json:"type"` // "connection"
	Connected bool      `json:"connected"`
	Reason    string    `json:"reason,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}
