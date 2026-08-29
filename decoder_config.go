package main

import (
	"fmt"
	"time"
)

// DecoderMode represents the type of digital mode to decode
type DecoderMode int

const (
	ModeWSPR DecoderMode = iota
	ModeFT8
	ModeFT4
	ModeJS8
	ModeFT2
)

// String returns the string representation of the decoder mode
func (m DecoderMode) String() string {
	switch m {
	case ModeWSPR:
		return "WSPR"
	case ModeFT8:
		return "FT8"
	case ModeFT4:
		return "FT4"
	case ModeJS8:
		return "JS8"
	case ModeFT2:
		return "FT2"
	default:
		return "Unknown"
	}
}

// MarshalYAML implements yaml.Marshaler for DecoderMode
func (m DecoderMode) MarshalYAML() (interface{}, error) {
	return m.String(), nil
}

// UnmarshalYAML implements yaml.Unmarshaler for DecoderMode
func (m *DecoderMode) UnmarshalYAML(unmarshal func(interface{}) error) error {
	var s string
	if err := unmarshal(&s); err != nil {
		return err
	}

	mode, err := ModeFromString(s)
	if err != nil {
		return err
	}

	*m = mode
	return nil
}

// ModeFromString converts a string to a DecoderMode
func ModeFromString(s string) (DecoderMode, error) {
	switch s {
	case "WSPR", "wspr":
		return ModeWSPR, nil
	case "FT8", "ft8":
		return ModeFT8, nil
	case "FT4", "ft4":
		return ModeFT4, nil
	case "JS8", "js8":
		return ModeJS8, nil
	case "FT2", "ft2":
		return ModeFT2, nil
	default:
		return 0, fmt.Errorf("unknown decoder mode: %s", s)
	}
}

// ModeInfo contains timing and decoder information for each mode
type ModeInfo struct {
	CycleTime        time.Duration // Total cycle time (e.g., 15s for FT8)
	TransmissionTime time.Duration // Actual transmission time (e.g., 12.64s for FT8)
	DecoderCommand   string        // Command to run decoder (e.g., "jt9")
	DecoderArgs      []string      // Arguments for decoder
	Preset           string        // Radiod preset to use (e.g., "usb")
	IsStreaming      bool          // True for streaming modes (continuous audio feed)
}

// GetModeInfo returns the mode information for a given decoder mode
func GetModeInfo(mode DecoderMode) ModeInfo {
	switch mode {
	case ModeWSPR:
		return ModeInfo{
			CycleTime:        120 * time.Second,
			TransmissionTime: 114 * time.Second,
			DecoderCommand:   "wsprd",
			DecoderArgs:      []string{"-f", "{freq}", "-C", "{depth}", "-w", "{file}"},
			Preset:           "usb",
			IsStreaming:      false,
		}
	case ModeFT8:
		return ModeInfo{
			CycleTime:        0, // No fixed cycles for streaming mode
			TransmissionTime: 0,
			DecoderCommand:   "jt9_wrapper",
			DecoderArgs:      []string{"-m", "FT8", "-j", "{jt9_path}", "-s", "-d", "{depth}"},
			Preset:           "usb",
			IsStreaming:      true,
		}
	case ModeFT4:
		return ModeInfo{
			CycleTime:        0, // No fixed cycles for streaming mode
			TransmissionTime: 0,
			DecoderCommand:   "jt9_wrapper",
			DecoderArgs:      []string{"-m", "FT4", "-j", "{jt9_path}", "-s", "-d", "{depth}"},
			Preset:           "usb",
			IsStreaming:      true,
		}
	case ModeJS8:
		return ModeInfo{
			CycleTime:        0, // No fixed cycles for streaming mode
			TransmissionTime: 0,
			DecoderCommand:   "js8",
			DecoderArgs:      []string{"--stdin", "-d", "{depth}"},
			Preset:           "usb",
			IsStreaming:      true,
		}
	case ModeFT2:
		return ModeInfo{
			CycleTime:        0, // No fixed cycles for streaming mode
			TransmissionTime: 0,
			DecoderCommand:   "jt9_wrapper",
			DecoderArgs:      []string{"-m", "FT2", "-j", "{jt9_path}", "-s", "-d", "{depth}"},
			Preset:           "usb",
			IsStreaming:      true,
		}
	default:
		return ModeInfo{}
	}
}

// DecoderBandConfig represents a single band configuration for decoding
type DecoderBandConfig struct {
	Name      string      `yaml:"name"`      // Human-readable name (e.g., "20m-ft8")
	Mode      DecoderMode `yaml:"mode"`      // Decoder mode
	Frequency uint64      `yaml:"frequency"` // Center frequency in Hz
	Enabled   bool        `yaml:"enabled"`   // Whether this band is enabled
	Depth     int         `yaml:"depth"`     // Decode depth (1-3, default 3)
}

// GetDepth returns the decode depth/cycles, with mode-specific defaults and validation
func (dbc *DecoderBandConfig) GetDepth() int {
	if dbc.Mode == ModeWSPR {
		// WSPR uses cycles (-C flag), default 10000
		if dbc.Depth < 1 {
			return 10000 // Default cycles for WSPR
		}
		return dbc.Depth
	}
	// FT8/FT4 use depth (-d flag), default 2
	if dbc.Depth < 1 || dbc.Depth > 3 {
		return 2 // Default depth for FT8/FT4
	}
	return dbc.Depth
}

// DecoderConfig represents the complete decoder configuration
type DecoderConfig struct {
	Enabled  bool   `yaml:"enabled"`   // Master enable/disable
	DataDir  string `yaml:"data_dir"`  // Directory for WAV files and logs
	KeepWav  bool   `yaml:"keep_wav"`  // Keep WAV files after decoding
	KeepLogs bool   `yaml:"keep_logs"` // Keep decoder log files

	// Binary paths
	JT9Path        string `yaml:"jt9_path"`         // Path to jt9 binary (for FT8/FT4)
	WSPRDPath      string `yaml:"wsprd_path"`       // Path to wsprd binary (for WSPR)
	WSPRDM0LTEPath string `yaml:"wsprd_m0lte_path"` // Path to the M0LTE wsprd build (used when wsprd_m0lte_mode is true)
	JS8Path        string `yaml:"js8_path"`         // Path to js8 binary (for JS8)
	JT9WrapperPath string `yaml:"jt9_wrapper_path"` // Path to jt9_wrapper binary (for FT2)

	// Recording options
	IncludeDeadTime           bool `yaml:"include_dead_time"`            // Record entire cycle including dead time
	ClampExecutionTime        bool `yaml:"clamp_execution_time"`         // Kill decoder if it exceeds cycle time (default: false)
	MaxConcurrentWSPRDecoders int  `yaml:"max_concurrent_wspr_decoders"` // Max simultaneous wsprd processes (0 = unlimited, default: 0)

	// WSPR decoder variant
	WSPRDM0LTEMode bool `yaml:"wsprd_m0lte_mode"` // Use the M0LTE wsprd build and its flag set (default: false)

	// Receiver information
	ReceiverCallsign string `yaml:"receiver_callsign"`
	ReceiverLocator  string `yaml:"receiver_locator"`
	ReceiverAntenna  string `yaml:"receiver_antenna"`

	// Reporting
	PSKReporterEnabled        bool   `yaml:"pskreporter_enabled"`
	PSKReporterRequireLocator bool   `yaml:"pskreporter_require_locator"` // Require locator for digital spots (FT8/FT4/JS8/FT2) to PSKReporter (default: false, WSPR always requires locator)
	WSPRNetEnabled            bool   `yaml:"wsprnet_enabled"`
	WSPRNetCallsign           string `yaml:"wsprnet_callsign"` // Optional: if set, use this callsign for WSPRNet instead of receiver_callsign

	// CSV Logging (independent of reporting)
	SpotsLogEnabled      bool   `yaml:"spots_log_enabled"`       // Enable CSV logging of all spots
	SpotsLogDataDir      string `yaml:"spots_log_data_dir"`      // Directory for spots CSV files (relative or absolute, default: data_dir/spots)
	SpotsLogLocatorsOnly *bool  `yaml:"spots_log_locators_only"` // Only log spots with valid locators to CSV (default: true)
	SpotsLogMaxAgeDays   int    `yaml:"spots_log_max_age_days"`  // Maximum age of spots log files in days (default: 90, 0 = no cleanup)

	// Metrics logging configuration
	MetricsLogEnabled      bool   `yaml:"metrics_log_enabled"`       // Enable JSON Lines logging of decoder metrics
	MetricsLogDataDir      string `yaml:"metrics_log_data_dir"`      // Directory for metrics JSON Lines files (relative or absolute, default: data_dir/decoder_metrics)
	MetricsLogIntervalSecs int    `yaml:"metrics_log_interval_secs"` // Write interval in seconds (default: 300 = 5 minutes)

	// Metrics summary configuration
	MetricsSummaryDataDir string `yaml:"metrics_summary_data_dir"` // Directory for metrics summary files (relative or absolute, default: data_dir/decoder_summaries)

	// WSJT-X UDP Protocol Broadcasting
	WSJTXUDPEnabled      bool            `yaml:"wsjtx_udp_enabled"`       // Enable WSJT-X UDP protocol broadcasting
	WSJTXUDPHost         string          `yaml:"wsjtx_udp_host"`          // UDP host (e.g., "127.0.0.1" or "239.255.0.1" for multicast)
	WSJTXUDPPort         int             `yaml:"wsjtx_udp_port"`          // UDP port (default: 2237)
	WSJTXUDPClientID     string          `yaml:"wsjtx_udp_client_id"`     // Unique client identifier (default: "UberSDR")
	WSJTXUDPEnabledModes map[string]bool `yaml:"wsjtx_udp_enabled_modes"` // Modes to broadcast (e.g., {"FT8": true, "FT4": false, "WSPR": false})

	// Band configurations
	Bands []DecoderBandConfig `yaml:"bands"`

	// The receiver's tuning range, set by pruneOutOfRangeChannels rather than read from
	// YAML — it is a property of the front end, not an operator preference. Zero means
	// not yet known, which allows everything. See GetEnabledBands.
	minFrequency uint64 `yaml:"-"`
	maxFrequency uint64 `yaml:"-"`
}

// Validate checks if the decoder configuration is valid
// wsprdM0LTEDefaultPath is where the container image installs the M0LTE wsprd
// build; it sits alongside stock wsprd so both are always available.
const wsprdM0LTEDefaultPath = "/usr/bin/wsprd-m0lte"

// WSPRDBinary returns the wsprd binary to invoke for WSPR decoding. In M0LTE
// mode this is a different build entirely, not stock wsprd with extra flags.
func (dc *DecoderConfig) WSPRDBinary() string {
	if !dc.WSPRDM0LTEMode {
		return dc.WSPRDPath
	}
	if dc.WSPRDM0LTEPath != "" {
		return dc.WSPRDM0LTEPath
	}
	return wsprdM0LTEDefaultPath
}

func (dc *DecoderConfig) Validate() error {
	if !dc.Enabled {
		return nil // Not enabled, no validation needed
	}

	if dc.DataDir == "" {
		return fmt.Errorf("decoder data_dir cannot be empty")
	}

	if len(dc.Bands) == 0 {
		return fmt.Errorf("no decoder bands configured")
	}

	// Check if any bands need specific decoders
	needsJT9 := false
	needsWSPRD := false
	needsJS8 := false
	needsFT2 := false
	for _, band := range dc.Bands {
		if !band.Enabled {
			continue
		}
		if band.Mode == ModeFT8 || band.Mode == ModeFT4 {
			needsJT9 = true
		}
		if band.Mode == ModeWSPR {
			needsWSPRD = true
		}
		if band.Mode == ModeJS8 {
			needsJS8 = true
		}
		if band.Mode == ModeFT2 {
			needsFT2 = true
		}
	}

	// Validate binary paths for needed decoders
	if needsJT9 && dc.JT9Path == "" {
		return fmt.Errorf("jt9_path required for FT8/FT4 decoding")
	}
	if needsWSPRD && dc.WSPRDBinary() == "" {
		return fmt.Errorf("wsprd_path required for WSPR decoding")
	}
	if needsJS8 && dc.JS8Path == "" {
		return fmt.Errorf("js8_path required for JS8 decoding")
	}
	if needsFT2 && dc.JT9WrapperPath == "" {
		return fmt.Errorf("jt9_wrapper_path required for FT2 decoding")
	}

	// Validate receiver info if reporting is enabled
	if dc.PSKReporterEnabled || dc.WSPRNetEnabled {
		if dc.ReceiverCallsign == "" {
			return fmt.Errorf("receiver callsign required for reporting")
		}
		if dc.ReceiverLocator == "" {
			return fmt.Errorf("receiver locator required for reporting")
		}
	}

	// Validate each band
	for i, band := range dc.Bands {
		if band.Name == "" {
			return fmt.Errorf("band %d: name cannot be empty", i)
		}
		if band.Frequency == 0 {
			return fmt.Errorf("band %s: frequency cannot be zero", band.Name)
		}
		// Validate depth if specified (0 means use default)
		if band.Depth != 0 {
			if band.Mode == ModeWSPR {
				// WSPR uses cycles, should be positive
				if band.Depth < 1 {
					return fmt.Errorf("band %s: WSPR cycles must be positive (got %d)", band.Name, band.Depth)
				}
			} else if band.Mode == ModeJS8 || band.Mode == ModeFT2 {
				// JS8/FT2 use depth 1-3 (same as FT8/FT4)
				if band.Depth < 1 || band.Depth > 3 {
					return fmt.Errorf("band %s: %s depth must be between 1 and 3 (got %d)", band.Name, band.Mode.String(), band.Depth)
				}
			} else {
				// FT8/FT4 use depth 1-3
				if band.Depth < 1 || band.Depth > 3 {
					return fmt.Errorf("band %s: FT8/FT4 depth must be between 1 and 3 (got %d)", band.Name, band.Depth)
				}
			}
		}
	}

	return nil
}

// GetEnabledBands returns only the enabled bands
func (dc *DecoderConfig) GetEnabledBands() []DecoderBandConfig {
	enabled := make([]DecoderBandConfig, 0)
	for _, band := range dc.Bands {
		if !band.Enabled {
			continue
		}
		// Second line of defence behind pruneOutOfRangeChannels, which switches these off
		// at startup. Every consumer — the decoder itself, the metrics API, the instance
		// reporter, /api/description — asks this one question, so a band that cannot be
		// heard is refused here no matter how it came to be enabled: a hand-edited
		// decoder.yaml, a future reload path that forgets to prune, a config assembled in
		// code. A decoder spawned on a frequency the front end cannot reach is a process
		// burning CPU on silence with nothing to show for it.
		if !dc.bandReachable(band.Frequency) {
			continue
		}
		enabled = append(enabled, band)
	}
	return enabled
}

// SetReceiverRange records what the front end can tune, for GetEnabledBands to filter on.
// Called by pruneOutOfRangeChannels once the receiver has been resolved.
func (dc *DecoderConfig) SetReceiverRange(minHz, maxHz uint64) {
	dc.minFrequency, dc.maxFrequency = minHz, maxHz
}

// bandReachable answers whether a frequency is inside the recorded range. An unset range
// means "not known yet" and allows everything, so a DecoderConfig built in a test or
// loaded before the receiver is resolved behaves exactly as it always did.
func (dc *DecoderConfig) bandReachable(hz uint64) bool {
	if dc.maxFrequency == 0 {
		return true
	}
	return hz >= dc.minFrequency && hz <= dc.maxFrequency
}
