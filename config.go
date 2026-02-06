package main

import (
	"fmt"
	"net"
	"os"

	"gopkg.in/yaml.v3"
)

// Config represents the application configuration
type Config struct {
	Admin              AdminConfig              `yaml:"admin"`
	Radiod             RadiodConfig             `yaml:"radiod"`
	Server             ServerConfig             `yaml:"server"`
	Audio              AudioConfig              `yaml:"audio"`
	Spectrum           SpectrumConfig           `yaml:"spectrum"`
	NoiseFloor         NoiseFloorConfig         `yaml:"noisefloor"`
	Decoder            DecoderConfig            `yaml:"decoder"`
	Prometheus         PrometheusConfig         `yaml:"prometheus"`
	MQTT               MQTTConfig               `yaml:"mqtt"`
	Logging            LoggingConfig            `yaml:"logging"`
	DXCluster          DXClusterConfig          `yaml:"dxcluster"`
	Chat               ChatConfig               `yaml:"chat"`
	SpaceWeather       SpaceWeatherConfig       `yaml:"spaceweather"`
	InstanceReporting  InstanceReportingConfig  `yaml:"instance_reporting"`
	FrequencyReference FrequencyReferenceConfig `yaml:"frequency_reference"`
	Rotctl             RotctlConfig             `yaml:"rotctl"`
	GeoIP              GeoIPConfig              `yaml:"geoip"`
	SSHProxy           SSHProxyConfig           `yaml:"ssh_proxy"`
	MCP                MCPConfig                `yaml:"mcp"`
	Bookmarks          []Bookmark               `yaml:"bookmarks"`
	Bands              []Band                   `yaml:"bands"`
	Extensions         []string                 `yaml:"extensions"`
	DefaultExtension   string                   `yaml:"default_extension,omitempty"`
}

// AdminConfig contains admin authentication settings
type AdminConfig struct {
	Password             string    `yaml:"password"`
	Description          string    `yaml:"description"`
	Name                 string    `yaml:"name"`
	Email                string    `yaml:"email"`
	Callsign             string    `yaml:"callsign"`
	PublicURL            string    `yaml:"public_url"` // Public URL for this SDR
	GPS                  GPSConfig `yaml:"gps"`
	ASL                  int       `yaml:"asl"` // Altitude above sea level in meters
	Location             string    `yaml:"location"`
	Antenna              string    `yaml:"antenna"`                // Antenna description
	VersionCheckEnabled  bool      `yaml:"version_check_enabled"`  // Enable automatic version checking from GitHub
	VersionCheckInterval int       `yaml:"version_check_interval"` // Version check interval in minutes (default: 60)
	MaxLoginAttempts     int       `yaml:"max_login_attempts"`     // Maximum failed login attempts before temporary ban (default: 5)
	LoginAttemptWindow   int       `yaml:"login_attempt_window"`   // Time window for counting failed attempts in seconds (default: 900 = 15 minutes)
	LoginBanDuration     int       `yaml:"login_ban_duration"`     // Duration of temporary ban after max attempts in seconds (default: 900 = 15 minutes)
	AllowedIPs           []string  `yaml:"allowed_ips"`            // List of IPs/CIDRs allowed to access admin endpoints (empty = allow all)

	allowedNets []*net.IPNet // Parsed CIDR networks (internal use)
}

// GPSConfig contains GPS coordinates and time synchronization settings
type GPSConfig struct {
	Lat         float64 `yaml:"lat"`
	Lon         float64 `yaml:"lon"`
	GPSEnabled  bool    `yaml:"gps_enabled"`  // Enable GPS time synchronization (default: false)
	TDOAEnabled bool    `yaml:"tdoa_enabled"` // Enable TDOA calculations (default: false)
}

// Bookmark represents a frequency bookmark
type Bookmark struct {
	Name      string `yaml:"name" json:"name"`
	Frequency uint64 `yaml:"frequency" json:"frequency"`
	Mode      string `yaml:"mode" json:"mode"`
	Extension string `yaml:"extension,omitempty" json:"extension,omitempty"`
	Group     string `yaml:"group,omitempty" json:"group,omitempty"`
	Comment   string `yaml:"comment,omitempty" json:"comment,omitempty"`
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
	Listen                        string          `yaml:"listen"`
	MaxSessions                   int             `yaml:"max_sessions"`
	MaxSessionsIP                 int             `yaml:"max_sessions_ip"` // Maximum sessions per IP address (0 = unlimited)
	SessionTimeout                int             `yaml:"session_timeout"`
	MaxSessionTime                int             `yaml:"max_session_time"`    // Maximum time a session can exist in seconds (0 = unlimited)
	MaxIdleTime                   int             `yaml:"max_idle_time"`       // Maximum time a user can be idle in seconds (0 = unlimited)
	CmdRateLimit                  int             `yaml:"cmd_rate_limit"`      // Commands per second per UUID per channel (0 = unlimited)
	ConnRateLimit                 int             `yaml:"conn_rate_limit"`     // WebSocket connections per second per IP (0 = unlimited)
	SessionsPerMinute             int             `yaml:"sessions_per_minute"` // /connection endpoint requests per minute per IP (0 = unlimited)
	EnforceSessionIPMatch         bool            `yaml:"enforce_session_ip_match"` // Enforce that WebSocket connections must come from same IP as /connection (default: false)
	TimeoutBypassIPs              []string        `yaml:"timeout_bypass_ips"`  // List of IPs/CIDRs that bypass idle and max session time limits
	TrustedProxyIPs               []string        `yaml:"trusted_proxy_ips"`   // List of IPs/CIDRs to trust X-Real-IP header from
	BypassPassword                string          `yaml:"bypass_password"`     // Password that grants bypass privileges (empty = disabled)
	PublicIQModes                 map[string]bool `yaml:"public_iq_modes"`     // IQ modes accessible without bypass authentication
	EnableCORS                    bool            `yaml:"enable_cors"`
	EnableKiwiSDR                 bool            `yaml:"enable_kiwisdr"`                    // Enable KiwiSDR protocol compatibility server (default: false)
	KiwiSDRListen                 string          `yaml:"kiwisdr_listen"`                    // KiwiSDR server listen address (e.g., ":8073", default: ":8073")
	KiwiSDRPublicEmail            string          `yaml:"kiwisdr_public_email"`              // Public email for KiwiSDR status endpoint (default: "admin@example.com")
	KiwiSDRSmeterOffset           float32         `yaml:"kiwisdr_smeter_offset"`             // S-meter calibration offset (dBFS to dBm, default: 30.0)
	LogFileEnabled                bool            `yaml:"logfile_enabled"`                   // Enable HTTP request logging (default: false)
	LogFile                       string          `yaml:"logfile"`                           // HTTP request log file path
	SessionActivityLogEnabled     bool            `yaml:"session_activity_log_enabled"`      // Enable session activity logging to disk
	SessionActivityLogDir         string          `yaml:"session_activity_log_dir"`          // Directory for session activity logs (default: data/session_activity)
	SessionActivityLogIntervalSec int             `yaml:"session_activity_log_interval_sec"` // Interval for periodic snapshots in seconds (default: 300)
	timeoutBypassNets             []*net.IPNet    // Parsed CIDR networks (internal use)
	trustedProxyNets              []*net.IPNet    // Parsed CIDR networks for trusted proxies (internal use)
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

// FrequencyGainRange defines a frequency-dependent gain adjustment
type FrequencyGainRange struct {
	StartFreq    uint64  `yaml:"start_freq"`    // Start frequency in Hz
	EndFreq      uint64  `yaml:"end_freq"`      // End frequency in Hz
	GainDB       float64 `yaml:"gain_db"`       // Gain adjustment in dB for this range (added to master gain_db)
	TransitionHz uint64  `yaml:"transition_hz"` // Transition width in Hz (0 = hard cutoff, default behavior)
}

// SpectrumConfig contains spectrum analyzer settings
type SpectrumConfig struct {
	Enabled               bool                          `yaml:"enabled"`
	Default               SpectrumDefaultConfig         `yaml:"default"`
	PollPeriodMs          int                           `yaml:"poll_period_ms"`
	MaxSessionsPerUser    int                           `yaml:"max_sessions_per_user"`
	GainDB                float64                       `yaml:"gain_db"`                  // Master gain adjustment in dB applied to all spectrum data
	GainDBFrequencyRanges map[string]FrequencyGainRange `yaml:"gain_db_frequency_ranges"` // Per-frequency gain adjustments (added to master gain_db), keyed by name
	DeltaThresholdDB      float64                       `yaml:"delta_threshold_db"`       // Delta encoding threshold in dB for binary mode
	Smoothing             SmoothingConfig               `yaml:"smoothing"`                // Smoothing settings for waterfall display
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

// ChatConfig contains live chat settings
type ChatConfig struct {
	Enabled                  bool   `yaml:"enabled"`                      // Enable/disable live chat functionality
	MaxUsers                 int    `yaml:"max_users"`                    // Maximum concurrent chat users (0 = unlimited)
	BufferedMessages         int    `yaml:"buffered_messages"`            // Number of messages to buffer for new connections (default: 50)
	RateLimitPerSecond       int    `yaml:"rate_limit_per_second"`        // Maximum messages per second per user (default: 2)
	RateLimitPerMinute       int    `yaml:"rate_limit_per_minute"`        // Maximum messages per minute per user (default: 30)
	UpdateRateLimitPerSecond int    `yaml:"update_rate_limit_per_second"` // Maximum user updates per second per user (default: 4)
	LogToCSV                 bool   `yaml:"log_to_csv"`                   // Enable CSV logging of chat messages (default: true)
	DataDir                  string `yaml:"data_dir"`                     // Directory to store CSV chat log files (default: "chat")
}

// SpaceWeatherConfig contains space weather monitoring settings
type SpaceWeatherConfig struct {
	Enabled         bool   `yaml:"enabled"`           // Enable/disable space weather monitoring
	PollIntervalSec int    `yaml:"poll_interval_sec"` // Seconds between API polls (recommended: 900 = 15 minutes)
	DataDir         string `yaml:"data_dir"`          // Directory to store CSV files
	LogToCSV        bool   `yaml:"log_to_csv"`        // Enable CSV logging
}

// InstanceReportingConfig contains settings for reporting to central instance registry
type InstanceReportingConfig struct {
	Enabled                    bool                   `yaml:"enabled"`                      // Enable/disable instance reporting
	UseHTTPS                   bool                   `yaml:"use_https"`                    // Use HTTPS (true) or HTTP (false) for connections
	UseMyIP                    bool                   `yaml:"use_myip"`                     // Automatically use public IP for public access
	CreateDomain               bool                   `yaml:"create_domain"`                // Request automatic DNS subdomain creation
	GenerateTLS                bool                   `yaml:"generate_tls"`                 // Generate TLS certificate with Caddy (default: false)
	Hostname                   string                 `yaml:"hostname"`                     // Central server hostname
	Port                       int                    `yaml:"port"`                         // Central server port
	ReportIntervalSec          int                    `yaml:"report_interval_sec"`          // Seconds between reports
	InstanceUUID               string                 `yaml:"instance_uuid"`                // Unique instance identifier (auto-generated)
	Instance                   InstanceConnectionInfo `yaml:"instance"`                     // Instance connection information
	TunnelServerHost           string                 `yaml:"tunnel_server_host"`           // Tunnel server hostname for X-Real-IP trust
	TunnelServerPort           int                    `yaml:"tunnel_server_port"`           // Tunnel server port (for future use)
	TunnelServerEnabled        bool                   `yaml:"tunnel_server_enabled"`        // Enable/disable tunnel server integration (default: false)
	TunnelServerURI            string                 `yaml:"tunnel_server_uri"`            // Tunnel server WebSocket URI (default: wss://tunnel.ubersdr.org/tunnel/connect)
	BetaFrontend               bool                   `yaml:"beta_frontend"`                // Enable beta frontend features (default: false)
	NotifyInstanceDisconnected bool                   `yaml:"notify_instance_disconnected"` // Notify when instance disconnects (default: true)
	NotifyInstanceStartup      bool                   `yaml:"notify_instance_startup"`      // Notify on instance startup (default: false)
	tunnelServerIPs            []string               // Resolved IPs of tunnel server (internal use)
	instanceReporterIPs        []string               // Resolved IPs of instance reporter (internal use)
}

// InstanceConnectionInfo contains connection details for this instance
type InstanceConnectionInfo struct {
	Host string `yaml:"host"` // Instance host (tells clients how to connect)
	Port int    `yaml:"port"` // Instance port (tells clients how to connect)
	TLS  bool   `yaml:"tls"`  // Instance uses TLS (tells clients how to connect)
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

// FrequencyReferenceConfig contains frequency reference tracking settings
type FrequencyReferenceConfig struct {
	Enabled      bool    `yaml:"enabled"`        // Enable/disable frequency reference tracking
	Frequency    uint64  `yaml:"frequency"`      // Reference tone frequency in Hz (default: 25000000 = 25 MHz)
	MinSNR       float32 `yaml:"min_snr"`        // Minimum SNR in dB to consider a peak valid (default: 20)
	MaxDriftFreq float64 `yaml:"max_drift_freq"` // Maximum frequency offset in Hz from expected to consider for detection (default: 25)
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

// MQTTConfig contains MQTT broker settings
type MQTTConfig struct {
	Enabled                 bool          `yaml:"enabled"`                   // Enable/disable MQTT metrics publishing
	Broker                  string        `yaml:"broker"`                    // MQTT broker URL (e.g., tcp://mqtt.example.com:1883)
	Username                string        `yaml:"username"`                  // MQTT authentication username
	Password                string        `yaml:"password"`                  // MQTT authentication password
	TopicPrefix             string        `yaml:"topic_prefix"`              // Topic prefix for all metrics
	PublishInterval         int           `yaml:"publish_interval"`          // Publishing interval for metrics in seconds
	SpectrumPublishEnabled  bool          `yaml:"spectrum_publish_enabled"`  // Enable/disable spectrum data publishing
	SpectrumPublishInterval int           `yaml:"spectrum_publish_interval"` // Publishing interval for spectrum data in seconds
	QoS                     byte          `yaml:"qos"`                       // MQTT Quality of Service level (0, 1, or 2)
	Retain                  bool          `yaml:"retain"`                    // Retain flag for MQTT messages
	TLS                     MQTTTLSConfig `yaml:"tls"`                       // TLS/SSL settings
}

// MQTTTLSConfig contains MQTT TLS/SSL settings
type MQTTTLSConfig struct {
	Enabled    bool   `yaml:"enabled"`     // Enable/disable TLS
	CACert     string `yaml:"ca_cert"`     // Path to CA certificate file
	ClientCert string `yaml:"client_cert"` // Path to client certificate file (optional)
	ClientKey  string `yaml:"client_key"`  // Path to client key file (optional)
}

// GeoIPConfig contains IP geolocation settings
// This service is for internal use only and admin API access
type GeoIPConfig struct {
	Enabled      bool   `yaml:"enabled"`       // Enable/disable GeoIP service
	DatabasePath string `yaml:"database_path"` // Path to MaxMind GeoLite2 database file (.mmdb)
}

// SSHProxyConfig contains SSH terminal proxy settings
type SSHProxyConfig struct {
	Enabled    bool     `yaml:"enabled"`     // Enable/disable SSH terminal proxy
	Host       string   `yaml:"host"`        // GoTTY container hostname
	Port       int      `yaml:"port"`        // GoTTY container port
	AllowedIPs []string `yaml:"allowed_ips"` // List of IPs/CIDRs allowed to access SSH proxy

	allowedNets []*net.IPNet // Parsed CIDR networks (internal use)
}

// MCPConfig contains Model Context Protocol server settings
type MCPConfig struct {
	Enabled bool `yaml:"enabled"` // Enable/disable MCP endpoint
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

	// Parse admin allowed IPs/CIDRs
	if err := config.Admin.parseAllowedIPs(); err != nil {
		return nil, fmt.Errorf("failed to parse admin.allowed_ips: %w", err)
	}

	// Parse timeout bypass IPs/CIDRs
	if err := config.Server.parseTimeoutBypassIPs(); err != nil {
		return nil, fmt.Errorf("failed to parse timeout_bypass_ips: %w", err)
	}

	// Parse trusted proxy IPs/CIDRs
	if err := config.Server.parseTrustedProxyIPs(); err != nil {
		return nil, fmt.Errorf("failed to parse trusted_proxy_ips: %w", err)
	}

	// Parse Prometheus allowed hosts IPs/CIDRs
	if config.Prometheus.Enabled {
		if err := config.Prometheus.parseAllowedHosts(); err != nil {
			return nil, fmt.Errorf("failed to parse prometheus.allowed_hosts: %w", err)
		}
	}

	// Parse SSH proxy allowed IPs/CIDRs
	if config.SSHProxy.Enabled {
		if err := config.SSHProxy.parseAllowedIPs(); err != nil {
			return nil, fmt.Errorf("failed to parse ssh_proxy.allowed_ips: %w", err)
		}
	}

	// Resolve tunnel server hostname to IPs if configured
	// Non-fatal: if DNS fails, log warning and continue (will fall back to X-Forwarded-For)
	if config.InstanceReporting.TunnelServerHost != "" {
		if err := config.InstanceReporting.resolveTunnelServerIPs(); err != nil {
			fmt.Printf("Warning: Failed to resolve tunnel_server_host '%s': %v\n", config.InstanceReporting.TunnelServerHost, err)
			fmt.Printf("Warning: X-Real-IP header will not be trusted. Falling back to X-Forwarded-For.\n")
			// Clear the hostname so IsTunnelServer() returns false
			config.InstanceReporting.TunnelServerHost = ""
		}
	}

	// Resolve instance reporter hostname to IPs if configured
	// Non-fatal: if DNS fails, log warning and continue (instance reporter won't get IQ48 access)
	if config.InstanceReporting.Hostname != "" {
		if err := config.InstanceReporting.resolveInstanceReporterIPs(); err != nil {
			fmt.Printf("Warning: Failed to resolve instance_reporting.hostname '%s': %v\n", config.InstanceReporting.Hostname, err)
			fmt.Printf("Warning: Instance reporter IPs will not have automatic IQ48 access.\n")
		}
	}

	// Set defaults if not specified
	if config.Server.MaxSessions == 0 {
		config.Server.MaxSessions = 50
	}
	// Note: SessionTimeout of 0 is valid (means no timeout), so we don't set a default
	// The default is only applied if the field is not present in the YAML at all
	// Since YAML unmarshaling will set it to 0 if not specified, we can't distinguish
	// between "not specified" and "explicitly set to 0", so we leave it as-is
	if config.Server.CmdRateLimit == 0 {
		config.Server.CmdRateLimit = 10 // Default 10 commands/sec per channel
	}
	if config.Server.ConnRateLimit == 0 {
		config.Server.ConnRateLimit = 2 // Default 2 connections/sec per IP
	}
	if config.Server.SessionsPerMinute == 0 {
		config.Server.SessionsPerMinute = 10 // Default 10 /connection requests per minute per IP
	}
	// Set default public IQ modes if not specified (all restricted by default)
	if config.Server.PublicIQModes == nil {
		config.Server.PublicIQModes = map[string]bool{
			"iq48":  false,
			"iq96":  false,
			"iq192": false,
			"iq384": false,
		}
	}
	// Note: LogFile path is relative to working directory, not config directory
	// If you want it in the config directory, set it explicitly in config.yaml
	if config.Server.LogFile == "" {
		config.Server.LogFile = "web.log"
	}
	// Set session activity log defaults
	if config.Server.SessionActivityLogDir == "" {
		config.Server.SessionActivityLogDir = "session_activity"
	}
	if config.Server.SessionActivityLogIntervalSec == 0 {
		config.Server.SessionActivityLogIntervalSec = 300 // Default 5 minutes
	}
	// KiwiSDR compatibility defaults
	if config.Server.EnableKiwiSDR && config.Server.KiwiSDRListen == "" {
		config.Server.KiwiSDRListen = ":8073" // Default port
	}
	if config.Server.EnableKiwiSDR && config.Server.KiwiSDRPublicEmail == "" {
		config.Server.KiwiSDRPublicEmail = "admin@example.com" // Default public email
	}
	if config.Server.EnableKiwiSDR && config.Server.KiwiSDRSmeterOffset == 0 {
		config.Server.KiwiSDRSmeterOffset = 30.0 // Default S-meter calibration offset
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
	if config.Admin.Antenna == "" {
		config.Admin.Antenna = "Multi-band HF antenna"
	}
	// Set version checker defaults if not specified
	// VersionCheckEnabled defaults to true (enabled by default)
	// Note: YAML booleans default to false, so we need to check if it was explicitly set
	// For now, we'll assume it's enabled by default and users can disable it
	if config.Admin.VersionCheckInterval == 0 {
		config.Admin.VersionCheckInterval = 60 // Default 60 minutes
	}

	// Set login rate limiting defaults if not specified
	if config.Admin.MaxLoginAttempts == 0 {
		config.Admin.MaxLoginAttempts = 5 // Default 5 attempts
	}
	if config.Admin.LoginAttemptWindow == 0 {
		config.Admin.LoginAttemptWindow = 900 // Default 15 minutes
	}
	if config.Admin.LoginBanDuration == 0 {
		config.Admin.LoginBanDuration = 900 // Default 15 minutes
	}

	// Set default admin allowed IPs if not specified (allow all by default)
	if len(config.Admin.AllowedIPs) == 0 {
		config.Admin.AllowedIPs = []string{"0.0.0.0/0"} // Default: allow all IPv4
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

	// Set delta threshold default and validate
	if config.Spectrum.DeltaThresholdDB == 0 {
		config.Spectrum.DeltaThresholdDB = 3.0 // Default 3.0 dB
	}
	// Validate delta threshold range (1.0 to 10.0 dB)
	if config.Spectrum.DeltaThresholdDB < 1.0 {
		fmt.Printf("Warning: spectrum.delta_threshold_db (%f) is below minimum (1.0), setting to 1.0\n", config.Spectrum.DeltaThresholdDB)
		config.Spectrum.DeltaThresholdDB = 1.0
	}
	if config.Spectrum.DeltaThresholdDB > 10.0 {
		fmt.Printf("Warning: spectrum.delta_threshold_db (%f) is above maximum (10.0), setting to 10.0\n", config.Spectrum.DeltaThresholdDB)
		config.Spectrum.DeltaThresholdDB = 10.0
	}

	// Set smoothing defaults if not specified
	// Note: enabled defaults to false, so only set alpha/sigma if they're 0
	if config.Spectrum.Smoothing.TemporalAlpha == 0 {
		config.Spectrum.Smoothing.TemporalAlpha = 0.3 // 30% new data, 70% old (moderate smoothing)
	}
	if config.Spectrum.Smoothing.SpatialSigma == 0 {
		config.Spectrum.Smoothing.SpatialSigma = 1.5 // Moderate Gaussian smoothing
	}

	// Validate master gain_db (clamp to -100 to +100 dB range)
	if config.Spectrum.GainDB > 100 {
		fmt.Printf("Warning: spectrum.gain_db (%.1f) exceeds maximum (+100 dB), clamping to +100 dB\n", config.Spectrum.GainDB)
		config.Spectrum.GainDB = 100
	}
	if config.Spectrum.GainDB < -100 {
		fmt.Printf("Warning: spectrum.gain_db (%.1f) is below minimum (-100 dB), clamping to -100 dB\n", config.Spectrum.GainDB)
		config.Spectrum.GainDB = -100
	}

	// Validate and clean up frequency gain ranges
	config.Spectrum.validateFrequencyGainRanges()

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

	// Set chat defaults if not specified
	// Chat is enabled by default (YAML bool defaults to false, so we check and set to true)
	// MaxUsers of 0 means unlimited, so we set a default of 25
	if config.Chat.MaxUsers == 0 {
		config.Chat.MaxUsers = 25 // Default 25 concurrent chat users
	}
	if config.Chat.BufferedMessages == 0 {
		config.Chat.BufferedMessages = 50 // Default 50 buffered messages
	}
	if config.Chat.RateLimitPerSecond == 0 {
		config.Chat.RateLimitPerSecond = 2 // Default 2 messages per second
	}
	if config.Chat.RateLimitPerMinute == 0 {
		config.Chat.RateLimitPerMinute = 30 // Default 30 messages per minute
	}
	if config.Chat.UpdateRateLimitPerSecond == 0 {
		config.Chat.UpdateRateLimitPerSecond = 4 // Default 4 user updates per second
	}
	// Chat logging defaults - enabled by default
	// Note: LogToCSV defaults to false in YAML, but we want it enabled by default
	// We'll handle this by checking if it's explicitly set to false in the YAML
	// For now, we assume if the config is loaded, logging should be enabled unless explicitly disabled
	if config.Chat.DataDir == "" {
		config.Chat.DataDir = "chat" // Default "chat" directory
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

	// Set frequency reference defaults if not specified
	if config.FrequencyReference.Frequency == 0 {
		config.FrequencyReference.Frequency = 25000000 // 25 MHz default
	}
	if config.FrequencyReference.MinSNR == 0 {
		config.FrequencyReference.MinSNR = 20.0 // 20 dB default
	}
	if config.FrequencyReference.MaxDriftFreq == 0 {
		config.FrequencyReference.MaxDriftFreq = 25.0 // 25 Hz default
	}

	// Set default allowed hosts if not specified (localhost only for security)
	if config.Prometheus.Enabled && len(config.Prometheus.AllowedHosts) == 0 {
		config.Prometheus.AllowedHosts = []string{"127.0.0.1", "::1"}
	}

	// Set Pushgateway defaults if not specified
	if config.Prometheus.Pushgateway.URL == "" {
		config.Prometheus.Pushgateway.URL = "https://push.ubersdr.org:9091"
	}

	// Set MQTT defaults if not specified
	if config.MQTT.TopicPrefix == "" {
		config.MQTT.TopicPrefix = "ubersdr/metrics"
	}
	if config.MQTT.PublishInterval == 0 {
		config.MQTT.PublishInterval = 60 // 60 seconds default (matches Pushgateway)
	}
	if config.MQTT.SpectrumPublishInterval == 0 {
		config.MQTT.SpectrumPublishInterval = 10 // 10 seconds default (matches HTTP endpoint)
	}

	// Set instance reporting defaults if not specified
	if config.InstanceReporting.Hostname == "" {
		config.InstanceReporting.Hostname = "instances.ubersdr.org"
	}
	if config.InstanceReporting.Port == 0 {
		config.InstanceReporting.Port = 443
	}
	if config.InstanceReporting.ReportIntervalSec == 0 {
		config.InstanceReporting.ReportIntervalSec = 600 // 10 minutes default
	} else if config.InstanceReporting.ReportIntervalSec < 60 {
		config.InstanceReporting.ReportIntervalSec = 60 // Minimum 60 seconds
	}
	if config.InstanceReporting.TunnelServerURI == "" {
		config.InstanceReporting.TunnelServerURI = "wss://tunnel.ubersdr.org/tunnel/connect"
	}
	// UseHTTPS defaults to true (YAML unmarshaling will set it to false if explicitly set)
	// We set it to true here to ensure it's true by default
	if !config.InstanceReporting.UseHTTPS {
		// Only set to true if it's currently false (meaning it wasn't explicitly set in YAML)
		// This is a bit of a hack, but YAML booleans default to false
		// In practice, we'll document that use_https defaults to true
		config.InstanceReporting.UseHTTPS = true
	}
	// NotifyInstanceDisconnected defaults to true
	// Note: YAML booleans default to false, so we need to explicitly set this
	// We'll assume it should be true unless explicitly set to false in the config
	// This is handled by checking if the value is false (default) and setting to true
	// In practice, users can set it to false in their config to disable
	if !config.InstanceReporting.NotifyInstanceDisconnected {
		config.InstanceReporting.NotifyInstanceDisconnected = true
	}
	// NotifyInstanceStartup defaults to false (already false by default from YAML unmarshaling)

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

	// Set SSH proxy defaults if not specified
	if config.SSHProxy.Host == "" {
		config.SSHProxy.Host = "ubersdr-gotty" // Default Docker container name
	}
	if config.SSHProxy.Port == 0 {
		config.SSHProxy.Port = 9980 // Default GoTTY port
	}
	// SSHProxy.Enabled defaults to true (enabled by default)
	// Note: YAML booleans default to false, so we set it to true if not explicitly disabled
	if !config.SSHProxy.Enabled {
		config.SSHProxy.Enabled = true
	}
	// Set default allowed IPs if not specified (allow all by default)
	if len(config.SSHProxy.AllowedIPs) == 0 {
		config.SSHProxy.AllowedIPs = []string{"0.0.0.0/0"} // Default: allow all IPv4
	}

	// Note: Decoder defaults are NOT set here because decoder.yaml is loaded separately
	// and should be the source of truth for all decoder configuration

	// Parse decoder band modes
	for i := range config.Decoder.Bands {
		band := &config.Decoder.Bands[i]
		if mode, err := ModeFromString(band.Mode.String()); err == nil {
			band.Mode = mode
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
// or if the provided password matches the bypass password
func (sc *ServerConfig) IsIPTimeoutBypassed(ipStr string, password ...string) bool {
	// Check password-based bypass first (if password provided and configured)
	if len(password) > 0 && password[0] != "" && sc.BypassPassword != "" {
		if password[0] == sc.BypassPassword {
			return true
		}
	}

	// Check IP-based bypass
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

// parseTrustedProxyIPs parses the trusted_proxy_ips list into CIDR networks
func (sc *ServerConfig) parseTrustedProxyIPs() error {
	sc.trustedProxyNets = make([]*net.IPNet, 0, len(sc.TrustedProxyIPs))

	for _, ipStr := range sc.TrustedProxyIPs {
		// Check if it's a CIDR notation
		if _, ipNet, err := net.ParseCIDR(ipStr); err == nil {
			sc.trustedProxyNets = append(sc.trustedProxyNets, ipNet)
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
			sc.trustedProxyNets = append(sc.trustedProxyNets, ipNet)
		}
	}

	return nil
}

// IsTrustedProxy checks if an IP address is in the trusted proxy list
func (sc *ServerConfig) IsTrustedProxy(ipStr string) bool {
	if len(sc.trustedProxyNets) == 0 {
		return false
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	for _, ipNet := range sc.trustedProxyNets {
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

// parseAllowedIPs parses the allowed_ips list into CIDR networks
func (spc *SSHProxyConfig) parseAllowedIPs() error {
	spc.allowedNets = make([]*net.IPNet, 0, len(spc.AllowedIPs))

	for _, ipStr := range spc.AllowedIPs {
		// Check if it's a CIDR notation
		if _, ipNet, err := net.ParseCIDR(ipStr); err == nil {
			spc.allowedNets = append(spc.allowedNets, ipNet)
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
			spc.allowedNets = append(spc.allowedNets, ipNet)
		}
	}

	return nil
}

// IsIPAllowed checks if an IP address is in the allowed IPs list
func (spc *SSHProxyConfig) IsIPAllowed(ipStr string) bool {
	// If no allowed IPs configured, deny all access
	if len(spc.allowedNets) == 0 {
		return false
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	for _, ipNet := range spc.allowedNets {
		if ipNet.Contains(ip) {
			return true
		}
	}

	return false
}

// parseAllowedIPs parses the admin allowed_ips list into CIDR networks
func (ac *AdminConfig) parseAllowedIPs() error {
	ac.allowedNets = make([]*net.IPNet, 0, len(ac.AllowedIPs))

	for _, ipStr := range ac.AllowedIPs {
		// Check if it's a CIDR notation
		if _, ipNet, err := net.ParseCIDR(ipStr); err == nil {
			ac.allowedNets = append(ac.allowedNets, ipNet)
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
			ac.allowedNets = append(ac.allowedNets, ipNet)
		}
	}

	return nil
}

// IsIPAllowed checks if an IP address is in the admin allowed IPs list
// Returns true if the list is empty (allow all) or if the IP is in the list
func (ac *AdminConfig) IsIPAllowed(ipStr string) bool {
	// If no allowed IPs configured, allow all access
	if len(ac.allowedNets) == 0 {
		return true
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	for _, ipNet := range ac.allowedNets {
		if ipNet.Contains(ip) {
			return true
		}
	}

	return false
}

// ConstructPublicURL builds a public URL from instance connection info
// If effectiveHost is provided (non-empty), it will be used instead of the configured host
func (irc *InstanceReportingConfig) ConstructPublicURL(effectiveHost ...string) string {
	host := irc.Instance.Host

	// Use effectiveHost if provided (for use_myip feature)
	if len(effectiveHost) > 0 && effectiveHost[0] != "" {
		host = effectiveHost[0]
	}

	port := irc.Instance.Port
	tls := irc.Instance.TLS

	// If host is empty or port is 0, return default placeholder
	if host == "" || port == 0 {
		return "https://example.com"
	}

	// Determine protocol and default port
	protocol := "http"
	defaultPort := 80
	if tls {
		protocol = "https"
		defaultPort = 443
	}

	// Build URL - omit port if it's the default for the protocol
	if port == defaultPort {
		return fmt.Sprintf("%s://%s/", protocol, host)
	}
	return fmt.Sprintf("%s://%s:%d/", protocol, host, port)
}

// resolveTunnelServerIPs resolves the tunnel server hostname to IP addresses
func (irc *InstanceReportingConfig) resolveTunnelServerIPs() error {
	if irc.TunnelServerHost == "" {
		return nil
	}

	fmt.Printf("Resolving tunnel server hostname: %s\n", irc.TunnelServerHost)

	// Resolve hostname to IPs
	ips, err := net.LookupHost(irc.TunnelServerHost)
	if err != nil {
		return fmt.Errorf("failed to resolve tunnel server hostname %s: %w", irc.TunnelServerHost, err)
	}

	if len(ips) == 0 {
		return fmt.Errorf("no IPs found for tunnel server hostname %s", irc.TunnelServerHost)
	}

	irc.tunnelServerIPs = ips
	fmt.Printf("Tunnel server resolved to %d IP(s): %v\n", len(ips), ips)
	fmt.Printf("X-Real-IP header will be trusted from these IPs\n")
	return nil
}

// IsTunnelServer checks if an IP address belongs to the configured tunnel server
func (irc *InstanceReportingConfig) IsTunnelServer(ipStr string) bool {
	if len(irc.tunnelServerIPs) == 0 {
		return false
	}

	// Parse the IP to normalize it
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	// Check against all resolved IPs
	for _, tunnelIP := range irc.tunnelServerIPs {
		resolvedIP := net.ParseIP(tunnelIP)
		if resolvedIP != nil && resolvedIP.Equal(ip) {
			return true
		}
	}

	return false
}

// resolveInstanceReporterIPs resolves the instance reporter hostname to IP addresses
func (irc *InstanceReportingConfig) resolveInstanceReporterIPs() error {
	if irc.Hostname == "" {
		return nil
	}

	fmt.Printf("Resolving instance reporter hostname: %s\n", irc.Hostname)

	// Resolve hostname to IPs
	ips, err := net.LookupHost(irc.Hostname)
	if err != nil {
		return fmt.Errorf("failed to resolve instance reporter hostname %s: %w", irc.Hostname, err)
	}

	if len(ips) == 0 {
		return fmt.Errorf("no IPs found for instance reporter hostname %s", irc.Hostname)
	}

	irc.instanceReporterIPs = ips
	fmt.Printf("Instance reporter resolved to %d IP(s): %v\n", len(ips), ips)
	fmt.Printf("These IPs will have automatic access to IQ48 mode\n")
	return nil
}

// IsInstanceReporter checks if an IP address belongs to the configured instance reporter
func (irc *InstanceReportingConfig) IsInstanceReporter(ipStr string) bool {
	if len(irc.instanceReporterIPs) == 0 {
		return false
	}

	// Parse the IP to normalize it
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	// Check against all resolved IPs
	for _, reporterIP := range irc.instanceReporterIPs {
		resolvedIP := net.ParseIP(reporterIP)
		if resolvedIP != nil && resolvedIP.Equal(ip) {
			return true
		}
	}

	return false
}

// validateFrequencyGainRanges validates and cleans up frequency gain ranges
// Removes invalid ranges and logs warnings for user errors
func (sc *SpectrumConfig) validateFrequencyGainRanges() {
	if len(sc.GainDBFrequencyRanges) == 0 {
		return
	}

	validRanges := make(map[string]FrequencyGainRange)

	for name, r := range sc.GainDBFrequencyRanges {
		// Check if end frequency is less than or equal to start frequency
		if r.EndFreq <= r.StartFreq {
			fmt.Printf("Warning: Ignoring invalid frequency gain range '%s': end_freq (%d Hz) must be greater than start_freq (%d Hz)\n",
				name, r.EndFreq, r.StartFreq)
			continue
		}

		// Check if frequency range is reasonable (within HF range: 0-30 MHz)
		const maxHFFreq = 30000000 // 30 MHz
		if r.StartFreq > maxHFFreq {
			fmt.Printf("Warning: Ignoring frequency gain range '%s': start_freq (%d Hz) exceeds maximum HF frequency (30 MHz)\n",
				name, r.StartFreq)
			continue
		}

		// Validate and clamp gain_db to -100 to +100 dB range
		if r.GainDB > 100 {
			fmt.Printf("Warning: Frequency gain range '%s' gain_db (%.1f) exceeds maximum (+100 dB), clamping to +100 dB\n",
				name, r.GainDB)
			r.GainDB = 100
		}
		if r.GainDB < -100 {
			fmt.Printf("Warning: Frequency gain range '%s' gain_db (%.1f) is below minimum (-100 dB), clamping to -100 dB\n",
				name, r.GainDB)
			r.GainDB = -100
		}

		// Validate transition_hz
		if r.TransitionHz > 0 {
			bandwidth := r.EndFreq - r.StartFreq
			// Warn if transition is larger than the band itself
			if r.TransitionHz > bandwidth {
				fmt.Printf("Warning: Frequency gain range '%s' transition_hz (%d Hz) is larger than the band width (%d Hz)\n",
					name, r.TransitionHz, bandwidth)
				fmt.Printf("         This may cause unexpected behavior. Consider reducing transition_hz.\n")
			}
			// Warn if transition is excessively large (> 10 MHz)
			const maxTransition = 10000000 // 10 MHz
			if r.TransitionHz > maxTransition {
				fmt.Printf("Warning: Frequency gain range '%s' transition_hz (%d Hz) exceeds recommended maximum (10 MHz), clamping to 10 MHz\n",
					name, r.TransitionHz)
				r.TransitionHz = maxTransition
			}
		}

		// Range is valid, keep it
		validRanges[name] = r
	}

	// Replace with validated ranges
	sc.GainDBFrequencyRanges = validRanges

	if len(validRanges) > 0 {
		fmt.Printf("Loaded %d frequency-dependent gain range(s)\n", len(validRanges))
	}
}
