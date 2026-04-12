package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

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
	// NTPServer is the NTP server that was successfully queried.
	NTPServer string `json:"ntp_server"`
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
			NTPServer:  srv,
			Stratum:    resp.Stratum,
			LastPoll:   pollTime,
		}

		log.Printf("NTP: offset=%.2fms rtt=%.2fms server=%s stratum=%d synced=%v",
			offsetMs, rttMs, srv, resp.Stratum, synced)
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
