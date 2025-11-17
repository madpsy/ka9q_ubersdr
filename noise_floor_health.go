package main

import (
	"fmt"
	"time"
)

// HealthStatus represents the health status of the noise floor monitor
type HealthStatus struct {
	Enabled            bool              `json:"enabled"`
	Running            bool              `json:"running"`
	BandsConfigured    int               `json:"bands_configured"`
	BandsReceivingData int               `json:"bands_receiving_data"`
	StalledBands       []string          `json:"stalled_bands,omitempty"`
	LastDataTimes      map[string]string `json:"last_data_times"`
	InitializedAt      time.Time         `json:"initialized_at,omitempty"`
	Healthy            bool              `json:"healthy"`
	Issues             []string          `json:"issues,omitempty"`
}

// GetHealthStatus returns the current health status of the noise floor monitor
func (nfm *NoiseFloorMonitor) GetHealthStatus() *HealthStatus {
	if nfm == nil {
		return &HealthStatus{
			Enabled: false,
			Healthy: false,
			Issues:  []string{"Noise floor monitoring is not enabled"},
		}
	}

	status := &HealthStatus{
		Enabled:         true,
		Running:         nfm.running,
		BandsConfigured: len(nfm.config.NoiseFloor.Bands),
		LastDataTimes:   make(map[string]string),
		Healthy:         true,
		Issues:          make([]string, 0),
	}

	if !nfm.running {
		status.Healthy = false
		status.Issues = append(status.Issues, "Monitor is not running")
		return status
	}

	// Check each band's data reception status
	now := time.Now()
	stallThreshold := 90 * time.Second
	receivingCount := 0

	for bandName, bs := range nfm.bandSpectrums {
		bs.mu.Lock()
		lastData := bs.LastDataTime
		bs.mu.Unlock()

		// Format last data time
		if lastData.IsZero() {
			status.LastDataTimes[bandName] = "never"
		} else {
			status.LastDataTimes[bandName] = lastData.Format(time.RFC3339)
			receivingCount++

			// Check if stalled
			timeSinceData := now.Sub(lastData)
			if timeSinceData > stallThreshold {
				status.StalledBands = append(status.StalledBands, bandName)
				status.Healthy = false
				status.Issues = append(status.Issues,
					fmt.Sprintf("Band %s stalled: %.0f seconds since last data",
						bandName, timeSinceData.Seconds()))
			}
		}
	}

	status.BandsReceivingData = receivingCount

	// Check if no bands have received data yet (startup issue)
	if receivingCount == 0 {
		status.Healthy = false
		status.Issues = append(status.Issues,
			"No bands have received data yet - possible startup failure")
	}

	// Check if some but not all bands are receiving data
	if receivingCount > 0 && receivingCount < status.BandsConfigured {
		status.Healthy = false
		status.Issues = append(status.Issues,
			fmt.Sprintf("Only %d of %d bands receiving data",
				receivingCount, status.BandsConfigured))
	}

	return status
}

// IsHealthy returns true if the noise floor monitor is functioning properly
func (nfm *NoiseFloorMonitor) IsHealthy() bool {
	status := nfm.GetHealthStatus()
	return status.Healthy
}

// GetStartupDiagnostics provides detailed diagnostics for troubleshooting startup issues
func (nfm *NoiseFloorMonitor) GetStartupDiagnostics() map[string]interface{} {
	if nfm == nil {
		return map[string]interface{}{
			"error": "Noise floor monitor is nil (not initialized)",
		}
	}

	diagnostics := make(map[string]interface{})
	diagnostics["running"] = nfm.running
	diagnostics["spectrums_ready"] = nfm.spectrumsReady
	diagnostics["bands_configured"] = len(nfm.config.NoiseFloor.Bands)

	// Check spectrum sessions
	bandStatus := make(map[string]interface{})
	for bandName, bs := range nfm.bandSpectrums {
		bs.mu.Lock()
		bandInfo := map[string]interface{}{
			"ssrc":             fmt.Sprintf("0x%08x", bs.SSRC),
			"session_id":       bs.SessionID,
			"last_data_time":   bs.LastDataTime,
			"last_reconnect":   bs.LastReconnect,
			"center_frequency": bs.Band.CenterFrequency,
			"bin_count":        bs.Band.BinCount,
			"bin_bandwidth":    bs.Band.BinBandwidth,
		}
		bs.mu.Unlock()

		// Check if session exists in session manager
		nfm.sessions.mu.RLock()
		session, exists := nfm.sessions.sessions[bs.SessionID]
		bandInfo["session_exists"] = exists
		if exists {
			bandInfo["session_active"] = session.LastActive
		}
		nfm.sessions.mu.RUnlock()

		// Check FFT buffer status
		nfm.fftMu.RLock()
		if buffer, ok := nfm.fftBuffers[bandName]; ok {
			bandInfo["buffer_samples"] = len(buffer.Samples)
		} else {
			bandInfo["buffer_samples"] = 0
		}
		nfm.fftMu.RUnlock()

		bandStatus[bandName] = bandInfo
	}
	diagnostics["bands"] = bandStatus

	// Check for measurements
	nfm.measurementsMu.RLock()
	diagnostics["measurements_available"] = len(nfm.latestMeasurements)
	nfm.measurementsMu.RUnlock()

	return diagnostics
}
