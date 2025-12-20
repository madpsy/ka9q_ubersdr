package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// SpaceWeatherHealthStatus represents the health status of the space weather monitor
type SpaceWeatherHealthStatus struct {
	Healthy       bool                     `json:"healthy"`
	Enabled       bool                     `json:"enabled"`
	LastUpdate    string                   `json:"last_update"`
	TimeSinceData string                   `json:"time_since_data"`
	Issues        []string                 `json:"issues"`
	CurrentData   *SpaceWeatherData        `json:"current_data,omitempty"`
	Diagnostics   *SpaceWeatherDiagnostics `json:"diagnostics,omitempty"`
}

// SpaceWeatherDiagnostics contains detailed diagnostic information
type SpaceWeatherDiagnostics struct {
	Enabled         bool      `json:"enabled"`
	PollIntervalSec int       `json:"poll_interval_sec"`
	LogToCSV        bool      `json:"log_to_csv"`
	DataDir         string    `json:"data_dir"`
	LastUpdate      time.Time `json:"last_update"`
	TimeSinceUpdate string    `json:"time_since_update"`
	HasData         bool      `json:"has_data"`
}

// GetHealthStatus returns the current health status of the space weather monitor
func (swm *SpaceWeatherMonitor) GetHealthStatus() *SpaceWeatherHealthStatus {
	if swm == nil {
		return &SpaceWeatherHealthStatus{
			Healthy: false,
			Enabled: false,
			Issues:  []string{"Space weather monitor not initialized"},
		}
	}

	status := &SpaceWeatherHealthStatus{
		Healthy: true,
		Enabled: swm.config.Enabled,
		Issues:  make([]string, 0),
	}

	if !swm.config.Enabled {
		status.Healthy = false
		status.Issues = append(status.Issues, "Space weather monitoring is disabled in configuration")
		return status
	}

	swm.mu.RLock()
	data := swm.data
	swm.mu.RUnlock()

	// Check if we have any data
	if data == nil || data.LastUpdate.IsZero() {
		status.Healthy = false
		status.Issues = append(status.Issues, "No space weather data has been fetched yet")
		status.LastUpdate = "Never"
		status.TimeSinceData = "N/A"
		return status
	}

	// Calculate time since last update
	timeSince := time.Since(data.LastUpdate)
	status.LastUpdate = data.LastUpdate.Format(time.RFC3339)
	status.TimeSinceData = formatDuration(timeSince)

	// Check if data is stale (more than 2x poll interval + 60 seconds grace period)
	maxAge := time.Duration(swm.config.PollIntervalSec*2+60) * time.Second
	if timeSince > maxAge {
		status.Healthy = false
		status.Issues = append(status.Issues,
			fmt.Sprintf("Space weather data is stale (last update: %s ago, expected every %d seconds)",
				formatDuration(timeSince), swm.config.PollIntervalSec))
	}

	// Check for missing critical data
	if data.SolarFlux == 0 {
		status.Issues = append(status.Issues, "Solar flux data is missing or zero")
	}

	// Include current data in response
	status.CurrentData = data

	return status
}

// IsHealthy returns true if the space weather monitor is functioning properly
func (swm *SpaceWeatherMonitor) IsHealthy() bool {
	status := swm.GetHealthStatus()
	return status.Healthy
}

// GetStartupDiagnostics returns detailed diagnostic information for troubleshooting
func (swm *SpaceWeatherMonitor) GetStartupDiagnostics() *SpaceWeatherDiagnostics {
	if swm == nil {
		return &SpaceWeatherDiagnostics{
			Enabled: false,
		}
	}

	swm.mu.RLock()
	data := swm.data
	swm.mu.RUnlock()

	diag := &SpaceWeatherDiagnostics{
		Enabled:         swm.config.Enabled,
		PollIntervalSec: swm.config.PollIntervalSec,
		LogToCSV:        swm.config.LogToCSV,
		DataDir:         swm.config.DataDir,
		HasData:         data != nil && !data.LastUpdate.IsZero(),
	}

	if data != nil && !data.LastUpdate.IsZero() {
		diag.LastUpdate = data.LastUpdate
		diag.TimeSinceUpdate = formatDuration(time.Since(data.LastUpdate))
	}

	return diag
}

// formatDuration formats a duration in a human-readable way
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.0f seconds", d.Seconds())
	} else if d < time.Hour {
		return fmt.Sprintf("%.1f minutes", d.Minutes())
	} else if d < 24*time.Hour {
		return fmt.Sprintf("%.1f hours", d.Hours())
	}
	return fmt.Sprintf("%.1f days", d.Hours()/24)
}

// MarshalHealthStatusJSON marshals the health status to JSON
func (swm *SpaceWeatherMonitor) MarshalHealthStatusJSON() ([]byte, error) {
	status := swm.GetHealthStatus()
	return json.Marshal(status)
}

// MarshalDiagnosticsJSON marshals the diagnostics to JSON
func (swm *SpaceWeatherMonitor) MarshalDiagnosticsJSON() ([]byte, error) {
	diag := swm.GetStartupDiagnostics()
	return json.Marshal(diag)
}
