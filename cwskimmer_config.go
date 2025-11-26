package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// CWSkimmerConfig represents the CW Skimmer configuration
type CWSkimmerConfig struct {
	Enabled        bool   `yaml:"enabled"`
	Host           string `yaml:"host"`
	Port           int    `yaml:"port"`
	Callsign       string `yaml:"callsign"`
	ReconnectDelay int    `yaml:"reconnect_delay"` // Seconds between reconnection attempts
	KeepAliveDelay int    `yaml:"keepalive_delay"` // Seconds between keep-alive messages

	// CSV Logging (follows decoder pattern)
	SpotsLogEnabled bool   `yaml:"spots_log_enabled"`  // Enable CSV logging
	SpotsLogDataDir string `yaml:"spots_log_data_dir"` // Directory for spots CSV files (default: data/spots)

	// Metrics Logging (JSON Lines format for time-series data)
	MetricsLogEnabled      bool   `yaml:"metrics_log_enabled"`       // Enable JSON Lines logging of CW metrics
	MetricsLogDataDir      string `yaml:"metrics_log_data_dir"`      // Directory for metrics files (default: cwskimmer_metrics)
	MetricsLogIntervalSecs int    `yaml:"metrics_log_interval_secs"` // Write interval in seconds (default: 300 = 5 minutes)

	// Metrics Summary (Pre-aggregated time-series summaries)
	MetricsSummaryDataDir string `yaml:"metrics_summary_data_dir"` // Directory for summary files (default: cwskimmer_summaries)

	// PSKReporter configuration
	PSKReporterEnabled  bool   `yaml:"pskreporter_enabled"`  // Enable PSKReporter uploads
	PSKReporterCallsign string `yaml:"pskreporter_callsign"` // Callsign for PSKReporter (defaults to main callsign)
	PSKReporterLocator  string `yaml:"pskreporter_locator"`  // Grid locator for PSKReporter
	PSKReporterAntenna  string `yaml:"pskreporter_antenna"`  // Antenna description for PSKReporter (optional)
}

// LoadCWSkimmerConfig loads CW Skimmer configuration from a YAML file
func LoadCWSkimmerConfig(filename string) (*CWSkimmerConfig, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read cwskimmer config file: %w", err)
	}

	var config CWSkimmerConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse cwskimmer config file: %w", err)
	}

	// Set defaults if not specified
	if config.Port == 0 {
		config.Port = 7300 // Default CW Skimmer port
	}
	if config.ReconnectDelay == 0 {
		config.ReconnectDelay = 5 // 5 seconds default
	}
	if config.KeepAliveDelay == 0 {
		config.KeepAliveDelay = 300 // 5 minutes default
	}
	if config.SpotsLogDataDir == "" {
		config.SpotsLogDataDir = "data/spots" // Default to same directory as decoder spots
	}
	if config.MetricsLogDataDir == "" {
		config.MetricsLogDataDir = "cwskimmer_metrics"
	}
	if config.MetricsLogIntervalSecs == 0 {
		config.MetricsLogIntervalSecs = 300 // 5 minutes default
	}
	if config.MetricsSummaryDataDir == "" {
		config.MetricsSummaryDataDir = "cwskimmer_summaries"
	}
	// Default PSKReporter callsign to main callsign if not specified
	if config.PSKReporterCallsign == "" {
		config.PSKReporterCallsign = config.Callsign
	}

	return &config, nil
}

// Validate checks if the CW Skimmer configuration is valid
func (c *CWSkimmerConfig) Validate() error {
	if !c.Enabled {
		return nil // Not enabled, no validation needed
	}

	if c.Host == "" {
		return fmt.Errorf("cwskimmer host cannot be empty")
	}

	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("cwskimmer port must be between 1 and 65535")
	}

	if c.Callsign == "" {
		return fmt.Errorf("cwskimmer callsign cannot be empty")
	}

	if c.ReconnectDelay < 1 {
		return fmt.Errorf("cwskimmer reconnect_delay must be at least 1 second")
	}

	if c.KeepAliveDelay < 1 {
		return fmt.Errorf("cwskimmer keepalive_delay must be at least 1 second")
	}

	if c.SpotsLogEnabled && c.SpotsLogDataDir == "" {
		return fmt.Errorf("cwskimmer spots_log_data_dir cannot be empty when logging is enabled")
	}

	// Validate PSKReporter configuration if enabled
	if c.PSKReporterEnabled {
		if c.PSKReporterCallsign == "" {
			return fmt.Errorf("cwskimmer pskreporter_callsign cannot be empty when PSKReporter is enabled")
		}
		if c.PSKReporterLocator == "" {
			return fmt.Errorf("cwskimmer pskreporter_locator cannot be empty when PSKReporter is enabled")
		}
		if !isValidGridLocator(c.PSKReporterLocator) {
			return fmt.Errorf("cwskimmer pskreporter_locator must be a valid grid locator (e.g., IO91vl)")
		}
	}

	return nil
}
