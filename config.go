package main

import (
	"fmt"
	"net"
	"os"

	"gopkg.in/yaml.v3"
)

// Config represents the application configuration
type Config struct {
	Admin            AdminConfig        `yaml:"admin"`
	Radiod           RadiodConfig       `yaml:"radiod"`
	Server           ServerConfig       `yaml:"server"`
	Audio            AudioConfig        `yaml:"audio"`
	Spectrum         SpectrumConfig     `yaml:"spectrum"`
	NoiseFloor       NoiseFloorConfig   `yaml:"noisefloor"`
	Prometheus       PrometheusConfig   `yaml:"prometheus"`
	Logging          LoggingConfig      `yaml:"logging"`
	DXCluster        DXClusterConfig    `yaml:"dxcluster"`
	SpaceWeather     SpaceWeatherConfig `yaml:"spaceweather"`
	Bookmarks        []Bookmark         `yaml:"bookmarks"`
	Bands            []Band             `yaml:"bands"`
	Extensions       []string           `yaml:"extensions"`
	DefaultExtension string             `yaml:"default_extension,omitempty"`
}

// AdminConfig contains admin authentication settings
type AdminConfig struct {
	Password    string    `yaml:"password"`
	Description string    `yaml:"description"`
	Name        string    `yaml:"name"`
	Email       string    `yaml:"email"`
	Callsign    string    `yaml:"callsign"`
	PublicURL   string    `yaml:"public_url"` // Public URL for this SDR
	GPS         GPSConfig `yaml:"gps"`
	ASL         int       `yaml:"asl"` // Altitude above sea level in meters
	Location    string    `yaml:"location"`
}

// GPSConfig contains GPS coordinates
type GPSConfig struct {
	Lat float64 `yaml:"lat"`
	Lon float64 `yaml:"lon"`
}

// Bookmark represents a frequency bookmark
type Bookmark struct {
	Name      string `yaml:"name" json:"name"`
	Frequency uint64 `yaml:"frequency" json:"frequency"`
	Mode      string `yaml:"mode" json:"mode"`
	Extension string `yaml:"extension,omitempty" json:"extension,omitempty"`
}

// Band represents an amateur radio band
type Band struct {
	Label string `yaml:"label" json:"label"`
	Start uint64 `yaml:"start" json:"start"`
	End   uint64 `yaml:"end" json:"end"`
	Group string `yaml:"group,omitempty" json:"group,omitempty"`
	Mode  string `yaml:"mode,omitempty" json:"mode,omitempty"`
}

// RadiodConfig contains radiod connection settings
type RadiodConfig struct {
	StatusGroup string `yaml:"status_group"`
	DataGroup   string `yaml:"data_group"`
	Interface   string `yaml:"interface"`
}

// ServerConfig contains web server settings
type ServerConfig struct {
	Listen            string       `yaml:"listen"`
	MaxSessions       int          `yaml:"max_sessions"`
	MaxSessionsIP     int          `yaml:"max_sessions_ip"` // Maximum sessions per IP address (0 = unlimited)
	SessionTimeout    int          `yaml:"session_timeout"`
	MaxSessionTime    int          `yaml:"max_session_time"`   // Maximum time a session can exist in seconds (0 = unlimited)
	MaxIdleTime       int          `yaml:"max_idle_time"`      // Maximum time a user can be idle in seconds (0 = unlimited)
	CmdRateLimit      int          `yaml:"cmd_rate_limit"`     // Commands per second per UUID per channel (0 = unlimited)
	ConnRateLimit     int          `yaml:"conn_rate_limit"`    // WebSocket connections per second per IP (0 = unlimited)
	TimeoutBypassIPs  []string     `yaml:"timeout_bypass_ips"` // List of IPs/CIDRs that bypass idle and max session time limits
	EnableCORS        bool         `yaml:"enable_cors"`
	LogFile           string       `yaml:"logfile"` // HTTP request log file path
	timeoutBypassNets []*net.IPNet // Parsed CIDR networks (internal use)
}

// AudioConfig contains audio processing settings
type AudioConfig struct {
	BufferSize        int            `yaml:"buffer_size"`
	DefaultSampleRate int            `yaml:"default_sample_rate"`
	ModeSampleRates   map[string]int `yaml:"mode_sample_rates"`
	Opus              OpusConfig     `yaml:"opus"`
}

// OpusConfig contains Opus compression settings
type OpusConfig struct {
	Enabled    bool `yaml:"enabled"`
	Bitrate    int  `yaml:"bitrate"`
	Complexity int  `yaml:"complexity"`
}

// SpectrumConfig contains spectrum analyzer settings
type SpectrumConfig struct {
	Enabled            bool                  `yaml:"enabled"`
	Default            SpectrumDefaultConfig `yaml:"default"`
	PollPeriodMs       int                   `yaml:"poll_period_ms"`
	MaxSessionsPerUser int                   `yaml:"max_sessions_per_user"`
	GainDB             float64               `yaml:"gain_db"`   // Gain adjustment in dB applied to spectrum data
	Smoothing          SmoothingConfig       `yaml:"smoothing"` // Smoothing settings for waterfall display
}

// SmoothingConfig contains smoothing parameters for spectrum data
type SmoothingConfig struct {
	Enabled       bool    `yaml:"enabled"`        // Enable/disable smoothing
	TemporalAlpha float32 `yaml:"temporal_alpha"` // EMA alpha for time smoothing (0-1, lower = more smoothing)
	SpatialSigma  float32 `yaml:"spatial_sigma"`  // Gaussian sigma for frequency smoothing (0 = disabled)
}

// SpectrumDefaultConfig contains default parameters for new spectrum channels
type SpectrumDefaultConfig struct {
	CenterFrequency uint64  `yaml:"center_frequency"`
	BinCount        int     `yaml:"bin_count"`
	BinBandwidth    float64 `yaml:"bin_bandwidth"`
}

// LoggingConfig contains logging settings
type LoggingConfig struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// DXClusterConfig contains DX cluster connection settings
type DXClusterConfig struct {
	Enabled        bool   `yaml:"enabled"`
	Host           string `yaml:"host"`
	Port           int    `yaml:"port"`
	Callsign       string `yaml:"callsign"`
	ReconnectDelay int    `yaml:"reconnect_delay"` // Seconds between reconnection attempts
	KeepAliveDelay int    `yaml:"keepalive_delay"` // Seconds between keep-alive messages
}

// SpaceWeatherConfig contains space weather monitoring settings
type SpaceWeatherConfig struct {
	Enabled         bool `yaml:"enabled"`           // Enable/disable space weather monitoring
	PollIntervalSec int  `yaml:"poll_interval_sec"` // Seconds between API polls (recommended: 900 = 15 minutes)
}

// NoiseFloorConfig contains noise floor monitoring settings
type NoiseFloorConfig struct {
	Enabled         bool             `yaml:"enabled"`
	PollIntervalSec int              `yaml:"poll_interval_sec"` // Seconds between measurements
	DataDir         string           `yaml:"data_dir"`          // Directory to store CSV files
	Bands           []NoiseFloorBand `yaml:"bands"`             // Amateur radio bands to monitor
}

// NoiseFloorBand defines an amateur radio band for noise floor monitoring
// Each band gets its own spectrum channel with dedicated parameters
type NoiseFloorBand struct {
	Name            string  `yaml:"name"`             // Band name (e.g., "160m", "80m")
	Start           uint64  `yaml:"start"`            // Start frequency in Hz
	End             uint64  `yaml:"end"`              // End frequency in Hz
	CenterFrequency uint64  `yaml:"center_frequency"` // Center frequency for this band's spectrum
	BinCount        int     `yaml:"bin_count"`        // Number of FFT bins for this band
	BinBandwidth    float64 `yaml:"bin_bandwidth"`    // Bandwidth per bin in Hz for this band
	FT8Frequency    uint64  `yaml:"ft8_frequency"`    // FT8 frequency for SNR calculation (0 = disabled)
}

// PrometheusConfig contains Prometheus metrics settings
type PrometheusConfig struct {
	Enabled      bool              `yaml:"enabled"`       // Enable/disable Prometheus metrics endpoint
	AllowedHosts []string          `yaml:"allowed_hosts"` // List of IPs/CIDRs allowed to access metrics
	Pushgateway  PushgatewayConfig `yaml:"pushgateway"`   // Pushgateway configuration

	allowedNets []*net.IPNet // Parsed CIDR networks (internal use)
}

// PushgatewayConfig contains Prometheus Pushgateway settings
type PushgatewayConfig struct {
	Enabled  bool   `yaml:"enabled"`  // Enable/disable pushing to Pushgateway
	URL      string `yaml:"url"`      // Pushgateway URL (e.g., http://pushgateway:9091)
	Instance string `yaml:"instance"` // Instance UUID for basic auth username
	Token    string `yaml:"token"`    // Token UUID for basic auth password
}

// LoadConfig loads configuration from a YAML file
func LoadConfig(filename string) (*Config, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	// Parse timeout bypass IPs/CIDRs
	if err := config.Server.parseTimeoutBypassIPs(); err != nil {
		return nil, fmt.Errorf("failed to parse timeout_bypass_ips: %w", err)
	}

	// Parse Prometheus allowed hosts IPs/CIDRs
	if config.Prometheus.Enabled {
		if err := config.Prometheus.parseAllowedHosts(); err != nil {
			return nil, fmt.Errorf("failed to parse prometheus.allowed_hosts: %w", err)
		}
	}

	// Set defaults if not specified
	if config.Server.MaxSessions == 0 {
		config.Server.MaxSessions = 50
	}
	if config.Server.SessionTimeout == 0 {
		config.Server.SessionTimeout = 300
	}
	if config.Server.CmdRateLimit == 0 {
		config.Server.CmdRateLimit = 10 // Default 10 commands/sec per channel
	}
	if config.Server.ConnRateLimit == 0 {
		config.Server.ConnRateLimit = 2 // Default 2 connections/sec per IP
	}
	// Note: LogFile path is relative to working directory, not config directory
	// If you want it in the config directory, set it explicitly in config.yaml
	if config.Server.LogFile == "" {
		config.Server.LogFile = "web.log"
	}
	if config.Audio.BufferSize == 0 {
		config.Audio.BufferSize = 4096
	}
	if config.Audio.DefaultSampleRate == 0 {
		config.Audio.DefaultSampleRate = 12000
	}
	// Set Opus defaults if not specified
	if config.Audio.Opus.Bitrate == 0 {
		config.Audio.Opus.Bitrate = 48000 // 48 kbps default
	}
	if config.Audio.Opus.Complexity == 0 {
		config.Audio.Opus.Complexity = 5 // Medium complexity default
	}
	if config.Logging.Level == "" {
		config.Logging.Level = "info"
	}
	if config.Logging.Format == "" {
		config.Logging.Format = "text"
	}

	// Set admin defaults if not specified
	if config.Admin.Description == "" {
		config.Admin.Description = `Welcome! This SDR is running <a href="https://github.com/madpsy/ka9q_ubersdr" target="_blank">UberSDR</a>`
	}
	if config.Admin.Name == "" {
		config.Admin.Name = "My SDR operated by myself!"
	}
	if config.Admin.Email == "" {
		config.Admin.Email = "me@example.com"
	}
	if config.Admin.Callsign == "" {
		config.Admin.Callsign = "N0CALL"
	}
	if config.Admin.PublicURL == "" {
		config.Admin.PublicURL = "https://example.com"
	}
	if config.Admin.GPS.Lat == 0 && config.Admin.GPS.Lon == 0 {
		// Default to London coordinates
		config.Admin.GPS.Lat = 51.507
		config.Admin.GPS.Lon = -0.128
	}
	if config.Admin.ASL == 0 {
		config.Admin.ASL = 30 // Default altitude in meters
	}
	if config.Admin.Location == "" {
		config.Admin.Location = "Dalgety Bay, Scotland, UK"
	}

	// Set spectrum defaults if not specified
	if config.Spectrum.Default.CenterFrequency == 0 {
		config.Spectrum.Default.CenterFrequency = 15000000 // 15 MHz for 0-30 MHz coverage
	}
	if config.Spectrum.Default.BinCount == 0 {
		config.Spectrum.Default.BinCount = 1024
	}
	if config.Spectrum.Default.BinBandwidth == 0 {
		config.Spectrum.Default.BinBandwidth = 30000.0 // 30 kHz bins for full HF
	}
	if config.Spectrum.PollPeriodMs == 0 {
		config.Spectrum.PollPeriodMs = 100 // 100ms default (10 Hz update rate)
	}
	if config.Spectrum.MaxSessionsPerUser == 0 {
		config.Spectrum.MaxSessionsPerUser = 2
	}

	// Set smoothing defaults if not specified
	// Note: enabled defaults to false, so only set alpha/sigma if they're 0
	if config.Spectrum.Smoothing.TemporalAlpha == 0 {
		config.Spectrum.Smoothing.TemporalAlpha = 0.3 // 30% new data, 70% old (moderate smoothing)
	}
	if config.Spectrum.Smoothing.SpatialSigma == 0 {
		config.Spectrum.Smoothing.SpatialSigma = 1.5 // Moderate Gaussian smoothing
	}

	// Set DX cluster defaults if not specified
	if config.DXCluster.Port == 0 {
		config.DXCluster.Port = 7300 // Default DX cluster port
	}
	if config.DXCluster.ReconnectDelay == 0 {
		config.DXCluster.ReconnectDelay = 30 // 30 seconds default
	}
	if config.DXCluster.KeepAliveDelay == 0 {
		config.DXCluster.KeepAliveDelay = 300 // 5 minutes default
	}

	// Set space weather defaults if not specified
	if config.SpaceWeather.PollIntervalSec == 0 {
		config.SpaceWeather.PollIntervalSec = 900 // 15 minutes default
	}

	// Set noise floor defaults if not specified
	if config.NoiseFloor.PollIntervalSec == 0 {
		config.NoiseFloor.PollIntervalSec = 60 // 60 seconds default
	}
	// Note: DataDir will be set relative to config directory in main.go
	// Default is "noisefloor" subdirectory in config directory

	// Set default allowed hosts if not specified (localhost only for security)
	if config.Prometheus.Enabled && len(config.Prometheus.AllowedHosts) == 0 {
		config.Prometheus.AllowedHosts = []string{"127.0.0.1", "::1"}
	}

	// Set Pushgateway defaults if not specified
	if config.Prometheus.Pushgateway.URL == "" {
		config.Prometheus.Pushgateway.URL = "https://push.ubersdr.org:9091"
	}

	// Set default amateur radio bands with per-band spectrum parameters if not specified
	if len(config.NoiseFloor.Bands) == 0 {
		config.NoiseFloor.Bands = []NoiseFloorBand{
			{Name: "160m", Start: 1800000, End: 2000000, CenterFrequency: 1900000, BinCount: 1000, BinBandwidth: 200},
			{Name: "80m", Start: 3500000, End: 4000000, CenterFrequency: 3750000, BinCount: 1000, BinBandwidth: 500},
			{Name: "60m", Start: 5250000, End: 5450000, CenterFrequency: 5350000, BinCount: 1000, BinBandwidth: 200},
			{Name: "40m", Start: 7000000, End: 7300000, CenterFrequency: 7150000, BinCount: 1000, BinBandwidth: 300},
			{Name: "30m", Start: 10100000, End: 10150000, CenterFrequency: 10125000, BinCount: 500, BinBandwidth: 100},
			{Name: "20m", Start: 14000000, End: 14350000, CenterFrequency: 14175000, BinCount: 1000, BinBandwidth: 350},
			{Name: "17m", Start: 18068000, End: 18168000, CenterFrequency: 18118000, BinCount: 500, BinBandwidth: 200},
			{Name: "15m", Start: 21000000, End: 21450000, CenterFrequency: 21225000, BinCount: 1000, BinBandwidth: 450},
			{Name: "12m", Start: 24890000, End: 24990000, CenterFrequency: 24940000, BinCount: 500, BinBandwidth: 200},
			{Name: "10m", Start: 28000000, End: 29700000, CenterFrequency: 28850000, BinCount: 1000, BinBandwidth: 1700},
		}
	}

	// Set per-band spectrum parameters if not specified
	for i := range config.NoiseFloor.Bands {
		band := &config.NoiseFloor.Bands[i]
		if band.CenterFrequency == 0 {
			// Calculate center frequency from start/end
			band.CenterFrequency = (band.Start + band.End) / 2
		}
		if band.BinCount == 0 {
			band.BinCount = 1000 // Default 1000 bins per band
		}
		if band.BinBandwidth == 0 {
			// Calculate bin bandwidth to cover the band
			bandwidth := float64(band.End - band.Start)
			band.BinBandwidth = bandwidth / float64(band.BinCount)
		}
	}

	return &config, nil
}

// GetSampleRateForMode returns the appropriate sample rate for a given mode
func (c *AudioConfig) GetSampleRateForMode(mode string) int {
	if rate, ok := c.ModeSampleRates[mode]; ok {
		return rate
	}
	return c.DefaultSampleRate
}

// Validate checks if the configuration is valid
func (c *Config) Validate() error {
	if c.Radiod.StatusGroup == "" {
		return fmt.Errorf("radiod.status_group is required")
	}
	if c.Radiod.DataGroup == "" {
		return fmt.Errorf("radiod.data_group is required")
	}
	if c.Server.Listen == "" {
		return fmt.Errorf("server.listen is required")
	}
	if c.Server.MaxSessions < 1 {
		return fmt.Errorf("server.max_sessions must be at least 1")
	}
	if c.Audio.BufferSize < 256 {
		return fmt.Errorf("audio.buffer_size must be at least 256")
	}
	if c.Audio.DefaultSampleRate < 8000 {
		return fmt.Errorf("audio.default_sample_rate must be at least 8000")
	}
	return nil
}

// parseTimeoutBypassIPs parses the timeout_bypass_ips list into CIDR networks
func (sc *ServerConfig) parseTimeoutBypassIPs() error {
	sc.timeoutBypassNets = make([]*net.IPNet, 0, len(sc.TimeoutBypassIPs))

	for _, ipStr := range sc.TimeoutBypassIPs {
		// Check if it's a CIDR notation
		if _, ipNet, err := net.ParseCIDR(ipStr); err == nil {
			sc.timeoutBypassNets = append(sc.timeoutBypassNets, ipNet)
		} else {
			// Try parsing as a single IP address
			ip := net.ParseIP(ipStr)
			if ip == nil {
				return fmt.Errorf("invalid IP or CIDR: %s", ipStr)
			}
			// Convert single IP to CIDR (/32 for IPv4, /128 for IPv6)
			var ipNet *net.IPNet
			if ip.To4() != nil {
				_, ipNet, _ = net.ParseCIDR(ipStr + "/32")
			} else {
				_, ipNet, _ = net.ParseCIDR(ipStr + "/128")
			}
			sc.timeoutBypassNets = append(sc.timeoutBypassNets, ipNet)
		}
	}

	return nil
}

// IsIPTimeoutBypassed checks if an IP address is in the timeout bypass list
func (sc *ServerConfig) IsIPTimeoutBypassed(ipStr string) bool {
	if len(sc.timeoutBypassNets) == 0 {
		return false
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	for _, ipNet := range sc.timeoutBypassNets {
		if ipNet.Contains(ip) {
			return true
		}
	}

	return false
}

// parseAllowedHosts parses the allowed_hosts list into CIDR networks
func (pc *PrometheusConfig) parseAllowedHosts() error {
	pc.allowedNets = make([]*net.IPNet, 0, len(pc.AllowedHosts))

	for _, ipStr := range pc.AllowedHosts {
		// Check if it's a CIDR notation
		if _, ipNet, err := net.ParseCIDR(ipStr); err == nil {
			pc.allowedNets = append(pc.allowedNets, ipNet)
		} else {
			// Try parsing as a single IP address
			ip := net.ParseIP(ipStr)
			if ip == nil {
				return fmt.Errorf("invalid IP or CIDR: %s", ipStr)
			}
			// Convert single IP to CIDR (/32 for IPv4, /128 for IPv6)
			var ipNet *net.IPNet
			if ip.To4() != nil {
				_, ipNet, _ = net.ParseCIDR(ipStr + "/32")
			} else {
				_, ipNet, _ = net.ParseCIDR(ipStr + "/128")
			}
			pc.allowedNets = append(pc.allowedNets, ipNet)
		}
	}

	return nil
}

// IsIPAllowed checks if an IP address is in the allowed hosts list
func (pc *PrometheusConfig) IsIPAllowed(ipStr string) bool {
	if len(pc.allowedNets) == 0 {
		return false
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	for _, ipNet := range pc.allowedNets {
		if ipNet.Contains(ip) {
			return true
		}
	}

	return false
}
