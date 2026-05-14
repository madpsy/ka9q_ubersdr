package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// NtpHealthStatus is the response for the /admin/ntp-health endpoint.
type NtpHealthStatus struct {
	Healthy     bool     `json:"healthy"`
	Synced      bool     `json:"synced"`
	OffsetMs    float64  `json:"offset_ms"`
	RTTMs       float64  `json:"rtt_ms"`
	Stratum     uint8    `json:"stratum"`
	LastPoll    string   `json:"last_poll"`
	ServerTime  string   `json:"server_time,omitempty"`
	NTPTime     string   `json:"ntp_time,omitempty"`
	NTPServer   string   `json:"ntp_server"`
	ToleranceMs int      `json:"tolerance_ms"`
	Issues      []string `json:"issues"`
}

// buildNTPHealthPayload builds the NtpHealthStatus payload from global NTP state.
// This is the same data returned by GET /admin/ntp-health and published to MQTT.
func buildNTPHealthPayload(cfg *Config) NtpHealthStatus {
	toleranceMs := cfg.NTP.SyncToleranceMs
	if toleranceMs <= 0 {
		toleranceMs = 500
	}

	globalNTPState.mu.RLock()
	result := globalNTPState.result
	lastPoll := globalNTPState.lastPoll
	globalNTPState.mu.RUnlock()

	issues := []string{}

	if result == nil {
		issues = append(issues, "NTP check has not completed yet")
		return NtpHealthStatus{
			Healthy:     false,
			NTPServer:   cfg.NTP.ntpServer(),
			ToleranceMs: toleranceMs,
			Issues:      issues,
		}
	}

	if result.Error != "" {
		issues = append(issues, "NTP query failed: "+result.Error)
		return NtpHealthStatus{
			Healthy:     false,
			LastPoll:    result.LastPoll,
			NTPServer:   cfg.NTP.ntpServer(),
			ToleranceMs: toleranceMs,
			Issues:      issues,
		}
	}

	// Check for stale data (more than 3× poll interval)
	staleThreshold := 3 * ntpPollInterval
	if !lastPoll.IsZero() && time.Since(lastPoll) > staleThreshold {
		issues = append(issues, "NTP data is stale — last poll was more than 3 minutes ago")
	}

	if !result.Synced {
		issues = append(issues, "Clock offset exceeds tolerance: "+
			formatOffsetMs(result.OffsetMs)+" ms (tolerance: "+
			formatOffsetMs(float64(toleranceMs))+" ms)")
	}

	healthy := len(issues) == 0

	return NtpHealthStatus{
		Healthy:     healthy,
		Synced:      result.Synced,
		OffsetMs:    result.OffsetMs,
		RTTMs:       result.RTTMs,
		Stratum:     result.Stratum,
		LastPoll:    result.LastPoll,
		ServerTime:  result.ServerTime,
		NTPTime:     result.NTPTime,
		NTPServer:   cfg.NTP.ntpServer(),
		ToleranceMs: toleranceMs,
		Issues:      issues,
	}
}

// handleNTPHealth serves the NTP time sync health status for the admin monitor.
func handleNTPHealth(w http.ResponseWriter, r *http.Request, cfg *Config) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(buildNTPHealthPayload(cfg))
}

// formatOffsetMs formats a float64 millisecond value to 2 decimal places as a string.
func formatOffsetMs(ms float64) string {
	if ms < 0 {
		ms = -ms
	}
	return fmt.Sprintf("%.2f", ms)
}

const ntpPollInterval = 64 * time.Second

// ntpState holds the most recently cached NTP query result.
type ntpState struct {
	mu       sync.RWMutex
	result   *TimeResponse
	lastPoll time.Time
}

var globalNTPState = &ntpState{}

// TimeResponse is the JSON response for the /api/time endpoint.
type TimeResponse struct {
	// ServerTime is the local system time at the moment the cached result was computed (UTC, RFC3339Nano).
	ServerTime string `json:"server_time"`
	// NTPTime is the NTP-corrected time at the moment of the last poll (UTC, RFC3339Nano).
	NTPTime string `json:"ntp_time"`
	// OffsetMs is the clock offset in milliseconds (positive = local clock is behind NTP).
	OffsetMs float64 `json:"offset_ms"`
	// RTTMs is the round-trip time to the NTP server in milliseconds.
	RTTMs float64 `json:"rtt_ms"`
	// Synced is true when the absolute clock offset is within the configured tolerance.
	Synced bool `json:"synced"`
	// Stratum is the NTP stratum of the responding server (1 = GPS/atomic, 2+ = secondary).
	Stratum uint8 `json:"stratum"`
	// LastPoll is when the NTP server was last queried (UTC, RFC3339).
	LastPoll string `json:"last_poll,omitempty"`
	// Error contains an error message if the last NTP query failed.
	Error string `json:"error,omitempty"`
}

// pollNTP queries the configured NTP server and updates the global cache.
func pollNTP(cfg *Config) {
	srv := cfg.NTP.ntpServer()
	tolerance := cfg.NTP.ntpSyncTolerance()

	var (
		resp     *NtpResponse
		queryErr error
	)

	resp, queryErr = NtpQuery(srv)
	if queryErr == nil {
		if err := resp.Validate(); err != nil {
			log.Printf("NTP: server %s returned invalid response: %v", srv, err)
			queryErr = err
			resp = nil
		}
	} else {
		log.Printf("NTP: query to %s failed: %v", srv, queryErr)
	}

	now := time.Now().UTC()
	pollTime := now.Format(time.RFC3339)

	var result *TimeResponse
	if queryErr != nil || resp == nil {
		errMsg := "all NTP servers failed"
		if queryErr != nil {
			errMsg = queryErr.Error()
		}
		result = &TimeResponse{
			ServerTime: now.Format(time.RFC3339Nano),
			LastPoll:   pollTime,
			Error:      errMsg,
		}
	} else {
		ntpTime := now.Add(resp.ClockOffset)
		offsetMs := float64(resp.ClockOffset) / float64(time.Millisecond)
		rttMs := float64(resp.RTT) / float64(time.Millisecond)
		synced := resp.ClockOffset.Abs() <= tolerance

		result = &TimeResponse{
			ServerTime: now.Format(time.RFC3339Nano),
			NTPTime:    ntpTime.UTC().Format(time.RFC3339Nano),
			OffsetMs:   offsetMs,
			RTTMs:      rttMs,
			Synced:     synced,
			Stratum:    resp.Stratum,
			LastPoll:   pollTime,
		}

		log.Printf("NTP: offset=%.2fms rtt=%.2fms server=%s stratum=%d synced=%v",
			offsetMs, rttMs, srv, resp.Stratum, synced)

		// Record this poll result in the history tracker.
		globalNTPHistory.AddSample(offsetMs, rttMs, synced, resp.Stratum)
	}

	globalNTPState.mu.Lock()
	globalNTPState.result = result
	globalNTPState.lastPoll = now
	globalNTPState.mu.Unlock()
}

// GetNTPSynced returns the cached sync status from the last NTP poll.
// Returns false if no poll has completed yet or if the last poll failed.
func GetNTPSynced() bool {
	globalNTPState.mu.RLock()
	defer globalNTPState.mu.RUnlock()
	if globalNTPState.result == nil || globalNTPState.result.Error != "" {
		return false
	}
	return globalNTPState.result.Synced
}

// StartNTPChecker starts a background goroutine that polls NTP every 64 seconds.
// An initial poll is performed immediately at startup.
func StartNTPChecker(cfg *Config) {
	log.Printf("NTP: starting checker (polling every %v, server: %s)", ntpPollInterval, cfg.NTP.ntpServer())

	// Initial poll at startup.
	go pollNTP(cfg)

	go func() {
		ticker := time.NewTicker(ntpPollInterval)
		defer ticker.Stop()
		for range ticker.C {
			pollNTP(cfg)
		}
	}()
}

// handleTimeAPI serves the cached NTP time comparison result.
// The cache is refreshed every 64 seconds by the background poller.
func handleTimeAPI(w http.ResponseWriter, r *http.Request, cfg *Config) {
	w.Header().Set("Content-Type", "application/json")

	globalNTPState.mu.RLock()
	result := globalNTPState.result
	globalNTPState.mu.RUnlock()

	if result == nil {
		// Poller hasn't completed its first run yet.
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(TimeResponse{
			ServerTime: time.Now().UTC().Format(time.RFC3339Nano),
			Error:      "NTP check pending, please retry shortly",
		})
		return
	}

	if result.Error != "" {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	json.NewEncoder(w).Encode(result)
}

// handleNTPHistory serves the 60-minute NTP offset history for the admin monitor.
func handleNTPHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	history := globalNTPHistory.GetHistory()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"history": history,
	})
}

// handleNTPHourlyHistory serves the 24-hour NTP offset history for the admin monitor.
func handleNTPHourlyHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	history := globalNTPHistory.GetHourlyHistory()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"history": history,
	})
}
