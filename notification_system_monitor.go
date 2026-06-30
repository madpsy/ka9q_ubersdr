package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// DefaultCPUTempThresholdC is the temperature (°C) above which the cpu_temperature
// probe reports unhealthy. Override by passing a custom probe to BuildSystemHealthProbes.
const DefaultCPUTempThresholdC = 80.0

// systemHealthProbe is a named function that returns (healthy bool, issues []string).
type systemHealthProbe struct {
	component string
	probe     func() (bool, []string)
}

// StartSystemMonitorNotifier starts a background goroutine that polls all
// subsystem health probes every pollInterval and fires SystemMonitorEvent
// notifications on state transitions (healthy↔unhealthy).
//
// It only fires on transitions — not on every poll — so a persistently
// unhealthy component does not spam the notification channel.
func StartSystemMonitorNotifier(
	ctx context.Context,
	nm *NotificationManager,
	pollInterval time.Duration,
	probes []systemHealthProbe,
) {
	if nm == nil || !nm.cfg.Enabled {
		return
	}

	// Check whether any system_monitor rules are enabled; skip if none.
	hasRule := false
	for _, r := range nm.cfg.Rules {
		if r.IsEnabled() && r.Event == EventTypeSystemMonitor {
			hasRule = true
			break
		}
	}
	if !hasRule {
		return
	}

	go func() {
		// Track previous health state per component.
		// nil = unknown (first poll), true/false = last known state.
		prevHealthy := make(map[string]*bool, len(probes))

		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for _, p := range probes {
					healthy, issues := p.probe()

					prev := prevHealthy[p.component]

					// First poll: record state but don't fire (no transition yet).
					if prev == nil {
						h := healthy
						prevHealthy[p.component] = &h
						continue
					}

					// No transition — skip.
					if *prev == healthy {
						continue
					}

					// Transition detected — update state and fire event.
					status := "degraded"
					if healthy {
						status = "recovered"
					}

					log.Printf("[SystemMonitor] %s: %s (was healthy=%v, now healthy=%v)",
						p.component, status, *prev, healthy)

					nm.Publish(SystemMonitorEvent{
						Component:         p.component,
						Healthy:           healthy,
						PreviouslyHealthy: *prev,
						Issues:            issues,
						Status:            status,
						Time:              time.Now(),
					})

					h := healthy
					prevHealthy[p.component] = &h
				}
			}
		}
	}()

	log.Printf("[SystemMonitor] Health notifier started (%d probes, poll interval %s)",
		len(probes), pollInterval)
}

// BuildSystemHealthProbes constructs the list of health probes from the
// available subsystem monitors. Pass nil for any subsystem that is not
// configured — it will be skipped.
func BuildSystemHealthProbes(
	noiseFloorMonitor *NoiseFloorMonitor,
	spaceWeatherMonitor *SpaceWeatherMonitor,
	multiDecoder *MultiDecoder,
	cwSkimmer *CWSkimmerClient,
	mqttPublisher *MQTTPublisher,
	rotctlHandler *RotctlAPIHandler,
	antSwitchHandler *AntSwitchHandler,
	freqRefMonitor *FrequencyReferenceMonitor,
	gpsdoMonitor *GPSDOMonitor,
	instanceReporter *InstanceReporter,
	config *Config,
	sessions *SessionManager,
) []systemHealthProbe {
	var probes []systemHealthProbe

	if noiseFloorMonitor != nil {
		probes = append(probes, systemHealthProbe{
			component: "noise_floor",
			probe: func() (bool, []string) {
				s := noiseFloorMonitor.GetHealthStatus()
				return s.Healthy, s.Issues
			},
		})
	}

	if spaceWeatherMonitor != nil {
		probes = append(probes, systemHealthProbe{
			component: "space_weather",
			probe: func() (bool, []string) {
				s := spaceWeatherMonitor.GetHealthStatus()
				return s.Healthy, s.Issues
			},
		})
	}

	if multiDecoder != nil {
		probes = append(probes, systemHealthProbe{
			component: "decoder",
			probe: func() (bool, []string) {
				s := multiDecoder.GetHealthStatus()
				return s.Healthy, s.Issues
			},
		})
	}

	if cwSkimmer != nil {
		probes = append(probes, systemHealthProbe{
			component: "cw_skimmer",
			probe: func() (bool, []string) {
				connected := cwSkimmer.IsConnected()
				if !connected {
					return false, []string{"Not connected to CW Skimmer server"}
				}
				cwSkimmer.mu.RLock()
				lastSpot := cwSkimmer.lastSpotTime
				cwSkimmer.mu.RUnlock()
				if !lastSpot.IsZero() && time.Since(lastSpot) > 5*time.Minute {
					return false, []string{fmt.Sprintf("No CW spots for %d seconds", int(time.Since(lastSpot).Seconds()))}
				}
				return true, nil
			},
		})
	}

	if mqttPublisher != nil {
		probes = append(probes, systemHealthProbe{
			component: "mqtt",
			probe: func() (bool, []string) {
				h := mqttPublisher.GetHealthStatus()
				healthy, _ := h["connected"].(bool)
				if !healthy {
					if msg, ok := h["last_error"].(string); ok && msg != "" {
						return false, []string{msg}
					}
					return false, []string{"MQTT not connected"}
				}
				return true, nil
			},
		})
	}

	if rotctlHandler != nil {
		probes = append(probes, systemHealthProbe{
			component: "rotator",
			probe: func() (bool, []string) {
				if rotctlHandler.controller == nil {
					return false, []string{"rotator controller not initialised"}
				}
				state := rotctlHandler.controller.GetState()
				if !rotctlHandler.wasConnected {
					return false, []string{"rotator not connected"}
				}
				if state.LastError != nil {
					return false, []string{fmt.Sprintf("rotator error: %v", state.LastError)}
				}
				if !state.UpdatedAt.IsZero() && time.Since(state.UpdatedAt) > 30*time.Second {
					return false, []string{fmt.Sprintf("rotator state stale (last update %s ago)", formatDuration(time.Since(state.UpdatedAt)))}
				}
				return true, nil
			},
		})
	}

	if antSwitchHandler != nil {
		probes = append(probes, systemHealthProbe{
			component: "ant_switch",
			probe: func() (bool, []string) {
				state := antSwitchHandler.getState()
				if state.LastError != "" {
					return false, []string{state.LastError}
				}
				return true, nil
			},
		})
	}

	if freqRefMonitor != nil {
		probes = append(probes, systemHealthProbe{
			component: "frequency_reference",
			probe: func() (bool, []string) {
				s := freqRefMonitor.GetHealthStatus()
				healthy, _ := s["healthy"].(bool)
				if !healthy {
					if issueList, ok := s["issues"].([]string); ok {
						return false, issueList
					}
					return false, []string{"frequency reference unhealthy"}
				}
				return true, nil
			},
		})
	}

	// System load probe — reads /proc/loadavg directly (Linux only).
	// Fires when 1-minute load average exceeds 2× the number of CPU cores.
	probes = append(probes, systemHealthProbe{
		component: "system_load",
		probe: func() (bool, []string) {
			data, err := os.ReadFile("/proc/loadavg")
			if err != nil {
				return true, nil // not Linux or unreadable — skip
			}
			fields := strings.Fields(string(data))
			if len(fields) < 1 {
				return true, nil
			}
			var load1 float64
			fmt.Sscanf(fields[0], "%f", &load1)
			// Get CPU count
			cpuData, err := os.ReadFile("/proc/cpuinfo")
			cpuCount := 1
			if err == nil {
				for _, line := range strings.Split(string(cpuData), "\n") {
					if strings.HasPrefix(line, "processor") {
						cpuCount++
					}
				}
			}
			threshold := float64(cpuCount) * 2.0
			if load1 > threshold {
				return false, []string{fmt.Sprintf("load average %.2f exceeds threshold %.0f (%d cores)", load1, threshold, cpuCount)}
			}
			return true, nil
		},
	})

	// Instance reporter probe — checks last HTTP response code.
	if instanceReporter != nil && config != nil && config.InstanceReporting.Enabled {
		probes = append(probes, systemHealthProbe{
			component: "instance_reporter",
			probe: func() (bool, []string) {
				payload := buildInstanceReporterHealthPayload(config, instanceReporter)
				healthy, _ := payload["healthy"].(bool)
				if !healthy {
					if issueList, ok := payload["issues"].([]string); ok {
						return false, issueList
					}
					return false, []string{"instance reporter unhealthy"}
				}
				return true, nil
			},
		})
	}

	// SDR frontend probe — checks for A/D overranges and stale status.
	// Finds the wideband spectrum session and queries radiod for its frontend status.
	if sessions != nil {
		probes = append(probes, systemHealthProbe{
			component: "sdr_frontend",
			probe: func() (bool, []string) {
				var widebandSSRC uint32
				sessions.mu.RLock()
				for id, session := range sessions.sessions {
					if len(id) >= 19 && id[:19] == "noisefloor-wideband" {
						widebandSSRC = session.SSRC
						break
					}
				}
				sessions.mu.RUnlock()
				if widebandSSRC == 0 {
					return true, nil // wideband not running — skip
				}
				fs := sessions.radiod.GetFrontendStatus(widebandSSRC)
				if fs == nil {
					return false, []string{"SDR frontend status unavailable (radiod not responding)"}
				}
				payload := buildFrontendStatusPayload(fs)
				healthy, _ := payload["healthy"].(bool)
				if !healthy {
					if issueList, ok := payload["issues"].([]string); ok {
						return false, issueList
					}
					return false, []string{"SDR frontend unhealthy"}
				}
				return true, nil
			},
		})
	}

	// GPSDO probe — checks GPS lock, PLL lock, and antenna status.
	// Only active when the leobodnar container is reachable and a device is present.
	if gpsdoMonitor != nil {
		probes = append(probes, systemHealthProbe{
			component: "gpsdo",
			probe: func() (bool, []string) {
				snapshot := gpsdoMonitor.GetSnapshot()
				if snapshot == nil {
					// Container unreachable or no device present — skip silently
					// (GPSDO is optional; only report when a device has been seen before)
					return true, nil
				}
				if snapshot.Device == "" {
					// Device not present — skip (GPSDO not connected)
					return true, nil
				}
				ds := snapshot.DeviceStatus
				if ds == nil {
					return false, []string{"GPSDO device status unavailable"}
				}
				var issues []string
				if !ds.GPSLock {
					issues = append(issues, "GPS not locked")
				}
				if !ds.PLLLock {
					issues = append(issues, "PLL not locked")
				}
				if !ds.AntennaOK {
					issues = append(issues, "GPS antenna fault")
				}
				if len(issues) > 0 {
					return false, issues
				}
				return true, nil
			},
		})
	}

	// CPU temperature probe — uses the same getCPUTemperature() function as the
	// admin system-stats endpoint. Fires when temperature exceeds DefaultCPUTempThresholdC.
	// Silently skipped on systems where no thermal sensor is found.
	probes = append(probes, systemHealthProbe{
		component: "cpu_temperature",
		probe: func() (bool, []string) {
			tempC, _, err := getCPUTemperature()
			if err != nil {
				return true, nil // no sensor — skip
			}
			if tempC >= DefaultCPUTempThresholdC {
				return false, []string{fmt.Sprintf("CPU temperature %.1f°C exceeds threshold %.0f°C", tempC, DefaultCPUTempThresholdC)}
			}
			return true, nil
		},
	})

	return probes
}
