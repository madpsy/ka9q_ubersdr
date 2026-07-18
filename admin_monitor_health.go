package main

// admin_monitor_health.go — GET /admin/monitor-health
//
// Returns a JSON snapshot of every enabled subsystem's health status,
// mirroring exactly what the /monitor Telegram bot command reports.
// Each item carries a name, status ("ok" | "warning" | "critical"), and an
// optional list of human-readable issue strings.  The top-level "overall"
// field is the worst status across all items.
//
// The handler calls the same shared build*HealthPayload helpers used by the
// individual /admin/*-health endpoints and the /monitor bot command, so the
// output is always consistent with both.

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// MonitorHealthItem describes the health of a single subsystem.
type MonitorHealthItem struct {
	Name   string   `json:"name"`
	Status string   `json:"status"` // "ok" | "warning" | "critical"
	Issues []string `json:"issues,omitempty"`
}

// MonitorHealthResponse is the JSON body returned by GET /admin/monitor-health.
type MonitorHealthResponse struct {
	Overall string              `json:"overall"` // "ok" | "warning" | "critical"
	Items   []MonitorHealthItem `json:"items"`
}

// itemStatus converts the ok/warn flags used internally into a status string.
func itemStatus(ok, warn bool) string {
	if ok {
		return "ok"
	}
	if warn {
		return "warning"
	}
	return "critical"
}

// HandleMonitorHealth serves GET /admin/monitor-health.
// It assembles the same health items as the /monitor Telegram bot command and
// returns them as JSON.  Disabled subsystems are omitted entirely.
func (ah *AdminHandler) HandleMonitorHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	items := ah.buildMonitorHealthItems()

	overall := "ok"
	for _, it := range items {
		switch it.Status {
		case "critical":
			overall = "critical"
		case "warning":
			if overall != "critical" {
				overall = "warning"
			}
		}
	}

	resp := MonitorHealthResponse{
		Overall: overall,
		Items:   items,
	}

	w.Header().Set("Content-Type", "application/json")
	if overall == "critical" {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	json.NewEncoder(w).Encode(resp)
}

// buildMonitorHealthItems assembles the health item list for every enabled
// subsystem.  The logic mirrors handleMonitor() in telegram_bot_monitor.go
// exactly — both call the same shared build*HealthPayload helpers.
func (ah *AdminHandler) buildMonitorHealthItems() []MonitorHealthItem {
	var items []MonitorHealthItem

	add := func(name string, ok, warn bool, issues []string) {
		items = append(items, MonitorHealthItem{
			Name:   name,
			Status: itemStatus(ok, warn),
			Issues: issues,
		})
	}

	// ── System load & CPU temperature ─────────────────────────────────────────
	{
		load := getSystemLoad()
		configuredThreshold := ah.config.Server.CPUTempThresholdC
		if configuredThreshold <= 0 {
			configuredThreshold = DefaultCPUTempThresholdC
		}
		if avail, _ := load["cpu_temp_available"].(bool); avail && configuredThreshold != DefaultCPUTempThresholdC {
			tempC, _ := load["cpu_temp_c"].(float64)
			tempStatus := "ok"
			if tempC >= configuredThreshold {
				tempStatus = "critical"
			} else if tempC >= configuredThreshold*0.85 {
				tempStatus = "warning"
			}
			load["cpu_temp_status"] = tempStatus
			load["cpu_temp_threshold_c"] = configuredThreshold
		}

		tempStatus, _ := load["cpu_temp_status"].(string)
		tempAvail, _ := load["cpu_temp_available"].(bool)
		tempC, _ := load["cpu_temp_c"].(float64)
		loadStatus, _ := load["status"].(string)
		load1, _ := load["load_1min"].(string)
		load5, _ := load["load_5min"].(string)
		load15, _ := load["load_15min"].(string)
		cores, _ := load["cpu_cores"].(int)

		isCritical := tempStatus == "critical" || loadStatus == "critical"
		isWarn := !isCritical && (tempStatus == "warning" || loadStatus == "warning")
		isOK := !isCritical && !isWarn

		var issues []string
		if loadStatus == "critical" {
			issues = append(issues, fmt.Sprintf("Load average critical: %s / %s / %s (%d cores, threshold %.0f×)", load1, load5, load15, cores, 2.0))
		} else if loadStatus == "warning" {
			issues = append(issues, fmt.Sprintf("Load average high: %s / %s / %s (%d cores, threshold %.0f×)", load1, load5, load15, cores, 1.0))
		}
		if tempStatus == "critical" {
			issues = append(issues, fmt.Sprintf("CPU temperature critical: %.1f°C (threshold %.0f°C)", tempC, configuredThreshold))
		} else if tempStatus == "warning" {
			issues = append(issues, fmt.Sprintf("CPU temperature high: %.1f°C (threshold %.0f°C)", tempC, configuredThreshold))
		}

		detail := fmt.Sprintf("Load: %s / %s / %s", load1, load5, load15)
		if cores > 0 {
			detail += fmt.Sprintf(" (%d cores)", cores)
		}
		if tempAvail {
			detail += fmt.Sprintf(" · CPU: %.1f°C", tempC)
		}
		issues = append([]string{detail}, issues...)

		add("System Load", isOK, isWarn, issues)
	}

	// ── Software version ──────────────────────────────────────────────────────
	{
		latestVersion := GetLatestVersion()
		checkFailed := ah.config.Admin.VersionCheckEnabled && latestVersion == ""
		updateAvailable := !checkFailed && latestVersion != "" && latestVersion != Version
		var issues []string
		if updateAvailable {
			issues = append(issues, fmt.Sprintf("Update available: %s → %s", Version, latestVersion))
		}
		if checkFailed {
			issues = append(issues, "Version check failed or not yet completed")
		}
		add("Software Version", !updateAvailable && !checkFailed, true /* warn only */, issues)
	}

	// ── NTP ───────────────────────────────────────────────────────────────────
	{
		ntp := buildNTPHealthPayload(ah.config)
		add("NTP", ntp.Healthy, false, ntp.Issues)
	}

	// ── Frontend status (SDR hardware) ────────────────────────────────────────
	{
		var widebandSSRC uint32
		ah.sessions.mu.RLock()
		for id, session := range ah.sessions.sessions {
			if len(id) >= 19 && id[:19] == "noisefloor-wideband" {
				widebandSSRC = session.SSRC
				break
			}
		}
		ah.sessions.mu.RUnlock()

		if widebandSSRC != 0 {
			frontendStatus := ah.sessions.radiod.GetFrontendStatus(widebandSSRC)
			if frontendStatus != nil {
				payload := buildFrontendStatusPayload(frontendStatus)
				healthy, _ := payload["healthy"].(bool)
				var issues []string
				if raw, ok := payload["issues"].([]string); ok {
					issues = raw
				}
				add("Frontend (SDR)", healthy, false, issues)
			}
		}
	}

	// ── Noise floor ───────────────────────────────────────────────────────────
	if ah.noiseFloorMonitor != nil {
		nf := ah.noiseFloorMonitor.GetHealthStatus()
		if nf.Enabled {
			add("Noise Floor", nf.Healthy, false, nf.Issues)
		}
	}

	// ── Space weather ─────────────────────────────────────────────────────────
	if ah.spaceWeatherMonitor != nil {
		sw := ah.spaceWeatherMonitor.GetHealthStatus()
		if sw.Enabled {
			add("Space Weather", sw.Healthy, false, sw.Issues)
		}
	}

	// ── Frequency reference ───────────────────────────────────────────────────
	if ah.freqRefMonitor != nil && ah.config.FrequencyReference.Enabled {
		fr := ah.freqRefMonitor.GetHealthStatus()
		enabled, _ := fr["enabled"].(bool)
		if enabled {
			healthy, _ := fr["healthy"].(bool)
			var issues []string
			if raw, ok := fr["issues"].([]string); ok {
				issues = raw
			}
			add("Frequency Reference", healthy, false, issues)
		}
	}

	// ── Decoder ───────────────────────────────────────────────────────────────
	if ah.multiDecoder != nil {
		dec := ah.multiDecoder.GetHealthStatus()
		if dec.Enabled {
			add("Decoder", dec.Healthy, false, dec.Issues)
		}
	}

	// ── CW Skimmer ────────────────────────────────────────────────────────────
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled {
		cw := buildCWSkimmerHealthPayload(ah.cwSkimmerConfig, ah.cwSkimmerClient)
		healthy, _ := cw["healthy"].(bool)
		var issues []string
		if raw, ok := cw["issues"].([]string); ok {
			issues = raw
		}
		add("CW Skimmer", healthy, false, issues)
	}

	// ── DSP ───────────────────────────────────────────────────────────────────
	if ah.config.DSP.Enabled {
		stats := ah.sessions.GetDSPStats()
		healthy := stats.RejectedCount == 0
		var issues []string
		if stats.RejectedCount > 0 {
			issues = append(issues, fmt.Sprintf("DSP capacity limit reached %d time(s) since server start", stats.RejectedCount))
		}
		add("DSP", healthy, true /* warn only */, issues)
	}

	// ── MQTT ──────────────────────────────────────────────────────────────────
	if ah.mqttPublisher != nil && ah.config.MQTT.Enabled {
		healthData := ah.mqttPublisher.GetHealthStatus()
		connected, _ := healthData["connected"].(bool)
		var issues []string
		if !connected {
			issues = append(issues, "Not connected to MQTT broker")
		}
		add("MQTT", connected, false, issues)
	}

	// ── Rotator ───────────────────────────────────────────────────────────────
	if ah.config.Rotctl.Enabled {
		rot := buildRotctlHealthPayload(ah.config, ah.rotctlHandler, ah.rotatorScheduler)
		healthy, _ := rot["healthy"].(bool)
		var issues []string
		if raw, ok := rot["issues"].([]string); ok {
			issues = raw
		}
		add("Rotator", healthy, false, issues)
	}

	// ── Antenna switch ────────────────────────────────────────────────────────
	if ah.config.AntSwitch.Enabled {
		ant := buildAntSwitchHealthPayload(ah.config, ah.antSwitchHandler)
		healthy, _ := ant["healthy"].(bool)
		var issues []string
		if raw, ok := ant["issues"].([]string); ok {
			issues = raw
		}
		add("Ant Switch", healthy, false, issues)
	}

	// ── GPSDO ─────────────────────────────────────────────────────────────────
	if ah.gpsdoMonitor != nil {
		snap := ah.gpsdoMonitor.GetSnapshot()
		if snap != nil && snap.Device != "" {
			healthy := gpsdoFullyOperational(snap)
			var issues []string
			if snap.DeviceStatus != nil {
				ds := snap.DeviceStatus
				if !ds.GPSLock {
					issues = append(issues, "GPS not locked")
				}
				if !ds.PLLLock {
					issues = append(issues, "PLL not locked")
				}
				if !ds.AntennaOK {
					issues = append(issues, "Antenna fault")
				}
				if !ds.Output1Enabled {
					issues = append(issues, "Output 1 disabled")
				}
				if ds.FrequencyHz != gpsdoExpectedFrequencyHz {
					issues = append(issues, fmt.Sprintf("Frequency %d Hz (expected %d Hz)", ds.FrequencyHz, gpsdoExpectedFrequencyHz))
				}
			}
			add("GPSDO", healthy, false, issues)
		}
	}

	// ── Instance reporter ─────────────────────────────────────────────────────
	if ah.instanceReporter != nil && ah.config.InstanceReporting.Enabled {
		ir := buildInstanceReporterHealthPayload(ah.config, ah.instanceReporter)
		healthy, _ := ir["healthy"].(bool)
		var issues []string
		if raw, ok := ir["issues"].([]string); ok {
			issues = raw
		}
		add("Instance Reporter", healthy, false, issues)
	}

	// ── Notifications ─────────────────────────────────────────────────────────
	if ah.notifManager != nil {
		h := ah.notifManager.GetHealth()
		enabled, _ := h["enabled"].(bool)
		if enabled {
			status, _ := h["status"].(string)
			healthy := status == "ok" || status == ""
			warn := status == "warning"
			stats := ah.notifManager.GetStats()
			var issues []string
			for chName, errs := range stats.ByChannelErrors {
				if errs == 0 {
					continue
				}
				sent := stats.ByChannel[chName]
				attempts := sent + errs
				var errRate float64
				if attempts > 0 {
					errRate = float64(errs) / float64(attempts) * 100.0
				} else {
					errRate = 100.0
				}
				if errRate > 5.0 {
					issues = append(issues, fmt.Sprintf(
						"channel %q: %.1f%% error rate (%d errors / %d attempts)",
						chName, errRate, errs, attempts))
				}
			}
			summary := fmt.Sprintf("Sent: %d · Errors: %d · Rate limited: %d",
				stats.TotalSent, stats.TotalErrors, stats.TotalRateLimited)
			issues = append([]string{summary}, issues...)
			add("Notifications", healthy, warn, issues)
		}
	}

	// ── Tunnel server ─────────────────────────────────────────────────────────
	if ah.config.InstanceReporting.TunnelServerEnabled {
		tun := fetchTunnelServerHealth(ah.config)
		up, _ := tun["tunnel_up"].(bool)
		var issues []string
		if !up {
			if errMsg, ok := tun["message"].(string); ok && errMsg != "" {
				issues = append(issues, errMsg)
			} else {
				issues = append(issues, "Tunnel is not up")
			}
		}
		add("Tunnel", up, false, issues)
	}

	return items
}
