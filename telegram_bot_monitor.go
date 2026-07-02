package main

// telegram_bot_monitor.go — /monitor command handler.
//
// Reports the health of every enabled subsystem, mirroring the admin UI
// Monitor tab. Each subsystem is shown as ✅ OK, ⚠️ Warning, or 🔴 Critical.
// Disabled subsystems are omitted entirely so the output stays concise.

import (
	"fmt"
	"html"
	"strings"
)

func init() {
	botCommands["monitor"] = botCommand{
		desc:     "Show health status of all enabled subsystems",
		readOnly: true,
		handler:  (*TelegramBotListener).handleMonitor,
	}
}

// handleMonitor reports the current health of every enabled subsystem.
// It calls the same in-process build functions used by the admin health
// endpoints so the output is always consistent with the admin monitor tab.
// Returns (botText, telegramAPIResponse, apiOK).
func (l *TelegramBotListener) handleMonitor(chatID int64, args string) (string, string, bool) {
	if l.adminHandler == nil {
		msg := "🖥️ Monitor data is not available (admin handler not wired)."
		apiResp, apiOK := l.sendMessage(chatID, msg)
		return msg, apiResp, apiOK
	}
	ah := l.adminHandler

	type item struct {
		name   string
		ok     bool
		warn   bool // true = warning severity (not critical) when !ok
		issues []string
	}

	var items []item

	// ── System load & CPU temperature ─────────────────────────────────────────
	{
		load := getSystemLoad()
		// Apply the configured CPU temp threshold (same as HandleSystemLoad does).
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
		loadStatus, _ := load["status"].(string) // "ok", "warning", "critical" — set by getSystemLoad()
		load1, _ := load["load_1min"].(string)
		load5, _ := load["load_5min"].(string)
		load15, _ := load["load_15min"].(string)
		cores, _ := load["cpu_cores"].(int)

		// Combine load status and temp status: worst of the two wins.
		isCritical := tempStatus == "critical" || loadStatus == "critical"
		isWarn := !isCritical && (tempStatus == "warning" || loadStatus == "warning")
		isOK := !isCritical && !isWarn

		var issues []string
		// Load issues (load status is based on 15-min average vs core count).
		if loadStatus == "critical" {
			issues = append(issues, fmt.Sprintf("Load average critical: %s / %s / %s (%d cores, threshold %.0f×)", load1, load5, load15, cores, 2.0))
		} else if loadStatus == "warning" {
			issues = append(issues, fmt.Sprintf("Load average high: %s / %s / %s (%d cores, threshold %.0f×)", load1, load5, load15, cores, 1.0))
		}
		// CPU temp issues.
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
		// Prepend load detail as first issue line (informational summary).
		issues = append([]string{detail}, issues...)

		items = append(items, item{
			name:   "System Load",
			ok:     isOK,
			warn:   isWarn,
			issues: issues,
		})
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
		items = append(items, item{
			name:   "Software Version",
			ok:     !updateAvailable && !checkFailed,
			warn:   true, // update available is a warning, not critical
			issues: issues,
		})
	}

	// ── NTP ───────────────────────────────────────────────────────────────────
	{
		ntp := buildNTPHealthPayload(ah.config)
		items = append(items, item{
			name:   "NTP",
			ok:     ntp.Healthy,
			issues: ntp.Issues,
		})
	}

	// ── Frontend status (SDR hardware) ────────────────────────────────────────
	{
		// Find the wideband SSRC by scanning sessions for the noisefloor-wideband session.
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
				items = append(items, item{
					name:   "Frontend (SDR)",
					ok:     healthy,
					issues: issues,
				})
			}
		}
	}

	// ── Noise floor ───────────────────────────────────────────────────────────
	if ah.noiseFloorMonitor != nil {
		nf := ah.noiseFloorMonitor.GetHealthStatus()
		if nf.Enabled {
			items = append(items, item{
				name:   "Noise Floor",
				ok:     nf.Healthy,
				issues: nf.Issues,
			})
		}
	}

	// ── Space weather ─────────────────────────────────────────────────────────
	if ah.spaceWeatherMonitor != nil {
		sw := ah.spaceWeatherMonitor.GetHealthStatus()
		if sw.Enabled {
			items = append(items, item{
				name:   "Space Weather",
				ok:     sw.Healthy,
				issues: sw.Issues,
			})
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
			items = append(items, item{
				name:   "Frequency Reference",
				ok:     healthy,
				issues: issues,
			})
		}
	}

	// ── Decoder ───────────────────────────────────────────────────────────────
	if ah.multiDecoder != nil {
		dec := ah.multiDecoder.GetHealthStatus()
		if dec.Enabled {
			items = append(items, item{
				name:   "Decoder",
				ok:     dec.Healthy,
				issues: dec.Issues,
			})
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
		items = append(items, item{
			name:   "CW Skimmer",
			ok:     healthy,
			issues: issues,
		})
	}

	// ── DSP ───────────────────────────────────────────────────────────────────
	if ah.config.DSP.Enabled {
		stats := ah.sessions.GetDSPStats()
		healthy := stats.RejectedCount == 0
		var issues []string
		if stats.RejectedCount > 0 {
			issues = append(issues, fmt.Sprintf("DSP capacity limit reached %d time(s) since server start", stats.RejectedCount))
		}
		items = append(items, item{
			name:   "DSP",
			ok:     healthy,
			warn:   true, // capacity limit hit is a warning, not critical
			issues: issues,
		})
	}

	// ── MQTT ──────────────────────────────────────────────────────────────────
	if ah.mqttPublisher != nil && ah.config.MQTT.Enabled {
		healthData := ah.mqttPublisher.GetHealthStatus()
		connected, _ := healthData["connected"].(bool)
		var issues []string
		if !connected {
			issues = append(issues, "Not connected to MQTT broker")
		}
		items = append(items, item{
			name:   "MQTT",
			ok:     connected,
			issues: issues,
		})
	}

	// ── Rotator ───────────────────────────────────────────────────────────────
	if ah.config.Rotctl.Enabled {
		rot := buildRotctlHealthPayload(ah.config, ah.rotctlHandler, ah.rotatorScheduler)
		healthy, _ := rot["healthy"].(bool)
		var issues []string
		if raw, ok := rot["issues"].([]string); ok {
			issues = raw
		}
		items = append(items, item{
			name:   "Rotator",
			ok:     healthy,
			issues: issues,
		})
	}

	// ── Antenna switch ────────────────────────────────────────────────────────
	if ah.config.AntSwitch.Enabled {
		ant := buildAntSwitchHealthPayload(ah.config, ah.antSwitchHandler)
		healthy, _ := ant["healthy"].(bool)
		var issues []string
		if raw, ok := ant["issues"].([]string); ok {
			issues = raw
		}
		items = append(items, item{
			name:   "Ant Switch",
			ok:     healthy,
			issues: issues,
		})
	}

	// ── GPSDO ─────────────────────────────────────────────────────────────────
	if l.gpsdoMonitor != nil {
		snap := l.gpsdoMonitor.GetSnapshot()
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
			items = append(items, item{
				name:   "GPSDO",
				ok:     healthy,
				issues: issues,
			})
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
		items = append(items, item{
			name:   "Instance Reporter",
			ok:     healthy,
			issues: issues,
		})
	}

	// ── Notifications ─────────────────────────────────────────────────────────
	if l.notifManager != nil {
		h := l.notifManager.GetHealth()
		enabled, _ := h["enabled"].(bool)
		if enabled {
			status, _ := h["status"].(string)
			healthy := status == "ok" || status == ""
			warn := status == "warning"
			stats := l.notifManager.GetStats()
			var issues []string
			// Per-channel error rates — iterate ByChannelErrors keys (public API)
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
			// Summary line always shown
			summary := fmt.Sprintf("Sent: %d · Errors: %d · Rate limited: %d",
				stats.TotalSent, stats.TotalErrors, stats.TotalRateLimited)
			issues = append([]string{summary}, issues...)
			items = append(items, item{
				name:   "Notifications",
				ok:     healthy,
				warn:   warn,
				issues: issues,
			})
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
		items = append(items, item{
			name:   "Tunnel",
			ok:     up,
			issues: issues,
		})
	}

	// ── Format output ─────────────────────────────────────────────────────────
	var sb strings.Builder
	sb.WriteString("🖥️ <b>System Health</b>\n\n")

	allOK := true
	for _, it := range items {
		var icon string
		switch {
		case it.ok:
			icon = "✅"
		case it.warn:
			icon = "⚠️"
			allOK = false
		default:
			icon = "🔴"
			allOK = false
		}
		sb.WriteString(icon + " <b>" + html.EscapeString(it.name) + "</b>")
		if len(it.issues) > 0 {
			sb.WriteString("\n")
			for _, iss := range it.issues {
				sb.WriteString("    ↳ " + html.EscapeString(iss) + "\n")
			}
		} else {
			sb.WriteString("\n")
		}
	}

	if len(items) == 0 {
		sb.WriteString("<i>No monitored subsystems are enabled.</i>\n")
	} else if allOK {
		sb.WriteString("\n✅ <i>All systems healthy.</i>")
	}

	msg := sb.String()
	apiResp, apiOK := l.sendMessage(chatID, msg)
	return msg, apiResp, apiOK
}
