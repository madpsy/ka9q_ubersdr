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
}

// API Response Types

// StatusResponse represents the current client status
type StatusResponse struct {
	Connected          bool      `json:"connected"`
	Frequency          int       `json:"frequency"`
	Mode               string    `json:"mode"`
	BandwidthLow       *int      `json:"bandwidthLow,omitempty"`
	BandwidthHigh      *int      `json:"bandwidthHigh,omitempty"`
	SampleRate         int       `json:"sampleRate"`
	Channels           int       `json:"channels"`
	SessionID          string    `json:"sessionId,omitempty"`
	UserSessionID      string    `json:"userSessionId"`
	AudioDevice        string    `json:"audioDevice"`
	AudioDeviceIdx     int       `json:"audioDeviceIndex"`
	OutputMode         string    `json:"outputMode"`
	NR2Enabled         bool      `json:"nr2Enabled"`
	NR2Strength        float64   `json:"nr2Strength"`
	NR2Floor           float64   `json:"nr2Floor"`
	NR2AdaptRate       float64   `json:"nr2AdaptRate"`
	ResampleEnabled    bool      `json:"resampleEnabled"`
	ResampleOutputRate int       `json:"resampleOutputRate"`
	OutputChannels     int       `json:"outputChannels"`
	Host               string    `json:"host,omitempty"`
	Port               int       `json:"port,omitempty"`
	SSL                bool      `json:"ssl"`
	ConnectedAt        time.Time `json:"connectedAt,omitempty"`
	Uptime             string    `json:"uptime,omitempty"`
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
	Type       string    `json:"type"` // "status"
	Connected  bool      `json:"connected"`
	Frequency  int       `json:"frequency"`
	Mode       string    `json:"mode"`
	SampleRate int       `json:"sampleRate"`
	Channels   int       `json:"channels"`
	SessionID  string    `json:"sessionId,omitempty"`
	Timestamp  time.Time `json:"timestamp"`
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
