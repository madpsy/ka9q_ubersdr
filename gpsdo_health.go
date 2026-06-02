package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// GPSDODeviceStatus mirrors the device_status object from the leobodnar /json endpoint.
type GPSDODeviceStatus struct {
	GPSLock        bool   `json:"gps_lock"`
	PLLLock        bool   `json:"pll_lock"`
	AntennaOK      bool   `json:"antenna_ok"`
	Mode           string `json:"mode"`
	Output1Enabled bool   `json:"output1_enabled"`
	Output1PPS     bool   `json:"output1_pps"`
	Output1Drive   string `json:"output1_drive"`
	FrequencyHz    int64  `json:"frequency_hz"`
}

// GPSDOGPSStatus mirrors the gps object from the leobodnar /json endpoint.
type GPSDOGPSStatus struct {
	DatetimeUTC string  `json:"datetime_utc"`
	Fix         string  `json:"fix"`
	FixMode     string  `json:"fix_mode"`
	SatsUsed    int     `json:"sats_used"`
	GPSInView   int     `json:"gps_in_view"`
	GLOInView   int     `json:"glo_in_view"`
	HDOP        float64 `json:"hdop"`
	VDOP        float64 `json:"vdop"`
	PDOP        float64 `json:"pdop"`
	AltitudeM   float64 `json:"altitude_m"`
	SpeedKnots  float64 `json:"speed_knots"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
}

// GPSDOSnapshot is the full response from the leobodnar /json endpoint.
// The leobodnar container reports the HID device path in the "device" field
// (e.g. "/dev/hidraw0").  A non-empty Device means the USB HID device is present.
type GPSDOSnapshot struct {
	Device       string             `json:"device"` // HID device path, e.g. "/dev/hidraw0" — non-empty means device present
	Serial       string             `json:"serial"` // Serial/TTY path, e.g. "/dev/ttyACM0"
	DeviceStatus *GPSDODeviceStatus `json:"device_status"`
	GPS          *GPSDOGPSStatus    `json:"gps"`
}

// GPSDOHealthStatus is the response for the /admin/gpsdo-health endpoint.
type GPSDOHealthStatus struct {
	Enabled      bool               `json:"enabled"`
	Healthy      bool               `json:"healthy"`
	Issues       []string           `json:"issues"`
	Device       string             `json:"device,omitempty"`
	Serial       string             `json:"serial,omitempty"`
	DeviceStatus *GPSDODeviceStatus `json:"device_status,omitempty"`
	GPS          *GPSDOGPSStatus    `json:"gps,omitempty"`
	LastChecked  string             `json:"last_checked"`
}

const gpsdoExpectedFrequencyHz = 27_000_000
const gpsdoExpectedMode = "PLL"

// fetchGPSDOSnapshot performs a single HTTP GET to the leobodnar container's
// /json endpoint and returns the decoded snapshot.  A 5-second timeout is used.
// Returns an error if the container is unreachable or returns invalid JSON.
func fetchGPSDOSnapshot(config *Config) (*GPSDOSnapshot, error) {
	url := fmt.Sprintf("http://%s:%d/json", config.GPSDO.Host, config.GPSDO.Port)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("cannot reach leobodnar container: %w", err)
	}
	defer resp.Body.Close()

	var snapshot GPSDOSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("invalid JSON from leobodnar container: %w", err)
	}
	return &snapshot, nil
}

// gpsdoFullyOperational returns true when the snapshot indicates the Leo Bodnar
// LBE-1420 is physically connected and all health criteria are met:
//   - device non-empty (USB HID device present, e.g. "/dev/hidraw0")
//   - GPS lock, PLL lock, antenna OK
//   - mode == "PLL"
//   - output 1 enabled
//   - frequency == 27 MHz
func gpsdoFullyOperational(snapshot *GPSDOSnapshot) bool {
	if snapshot == nil || snapshot.Device == "" || snapshot.DeviceStatus == nil {
		return false
	}
	ds := snapshot.DeviceStatus
	return ds.GPSLock && ds.PLLLock && ds.AntennaOK &&
		ds.Mode == gpsdoExpectedMode && ds.Output1Enabled &&
		ds.FrequencyHz == gpsdoExpectedFrequencyHz
}

// ---------------------------------------------------------------------------
// GPSDOMonitor — background cache for /api/description
// ---------------------------------------------------------------------------

// GPSDOMonitor polls the leobodnar container every second and caches the
// last snapshot.  handleDescription reads from this cache so that the public
// /api/description endpoint incurs zero added latency from the GPSDO fetch.
// Errors are only logged on state transitions (first failure / first recovery)
// to avoid log spam when the container is unreachable.
type GPSDOMonitor struct {
	config *Config

	mu          sync.RWMutex
	snapshot    *GPSDOSnapshot // nil if last fetch failed
	lastPollErr bool           // true if the previous poll returned an error
}

// NewGPSDOMonitor creates a new monitor.  Call Start() to begin polling.
func NewGPSDOMonitor(config *Config) *GPSDOMonitor {
	return &GPSDOMonitor{config: config}
}

// Start launches the background polling goroutine.  It performs an initial
// fetch immediately so the cache is warm before the first /api/description
// request arrives.  Polling at 1 s keeps /api/description and the instance
// reporter payload near-real-time on the local Docker network.
func (m *GPSDOMonitor) Start() {
	// Initial fetch (best-effort; errors are logged but not fatal).
	m.poll()

	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			m.poll()
		}
	}()
}

func (m *GPSDOMonitor) poll() {
	snapshot, err := fetchGPSDOSnapshot(m.config)

	m.mu.Lock()
	prevErr := m.lastPollErr
	if err != nil {
		// Only log on the first failure (state transition: ok → error)
		if !prevErr {
			log.Printf("GPSDO monitor: leobodnar container unreachable: %v", err)
		}
		m.lastPollErr = true
		m.snapshot = nil
	} else {
		// Log recovery once (state transition: error → ok)
		if prevErr {
			log.Printf("GPSDO monitor: leobodnar container reachable again")
		}
		m.lastPollErr = false
		m.snapshot = snapshot
	}
	m.mu.Unlock()
}

// GetSnapshot returns the most recently cached snapshot (may be nil if the
// container has never been reachable).
func (m *GPSDOMonitor) GetSnapshot() *GPSDOSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshot
}

// DescriptionInfo returns the map to embed under the "gpsdo" key in
// /api/description (and the instance reporter payload), or nil if the device
// is not fully operational.  When nil is returned the caller should omit the
// key entirely.
//
// The map includes device_status fields plus GPS telemetry (UTC time, fix type,
// satellite counts, DOP values) when GPS data is available.
func (m *GPSDOMonitor) DescriptionInfo() map[string]interface{} {
	snapshot := m.GetSnapshot()
	if !gpsdoFullyOperational(snapshot) {
		return nil
	}
	ds := snapshot.DeviceStatus
	info := map[string]interface{}{
		"enabled":         true,
		"gps_lock":        ds.GPSLock,
		"pll_lock":        ds.PLLLock,
		"antenna_ok":      ds.AntennaOK,
		"mode":            ds.Mode,
		"output1_enabled": ds.Output1Enabled,
		"frequency_hz":    ds.FrequencyHz,
	}
	if gps := snapshot.GPS; gps != nil {
		info["utc"] = gps.DatetimeUTC
		info["fix"] = gps.Fix
		info["fix_mode"] = gps.FixMode
		info["sats_used"] = gps.SatsUsed
		info["gps_in_view"] = gps.GPSInView
		info["glo_in_view"] = gps.GLOInView
		info["hdop"] = gps.HDOP
		info["vdop"] = gps.VDOP
		info["pdop"] = gps.PDOP
	}
	return info
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

// handleGPSDOHealth fetches the leobodnar /json endpoint server-side and returns
// a health payload for the admin monitor tab.
// Enabled is set to true when the leobodnar container reports a non-empty device path
// (e.g. "/dev/hidraw0"), meaning the Leo Bodnar USB HID device is physically present.
// Health criteria: GPS lock, PLL lock, output 1 enabled, frequency == 27 MHz.
func handleGPSDOHealth(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")

	snapshot, err := fetchGPSDOSnapshot(config)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(GPSDOHealthStatus{
			Enabled:     true,
			Healthy:     false,
			Issues:      []string{err.Error()},
			LastChecked: time.Now().UTC().Format(time.RFC3339),
		})
		return
	}

	issues := []string{}

	if snapshot.DeviceStatus == nil {
		issues = append(issues, "HID device not available (no device_status)")
	} else {
		ds := snapshot.DeviceStatus
		if !ds.GPSLock {
			issues = append(issues, "GPS not locked")
		}
		if !ds.PLLLock {
			issues = append(issues, "PLL not locked")
		}
		if !ds.AntennaOK {
			issues = append(issues, "Antenna fault detected")
		}
		if !ds.Output1Enabled {
			issues = append(issues, "Output 1 is disabled")
		}
		if ds.FrequencyHz != gpsdoExpectedFrequencyHz {
			issues = append(issues, fmt.Sprintf("Frequency is %d Hz (expected %d Hz / 27.000000 MHz)",
				ds.FrequencyHz, gpsdoExpectedFrequencyHz))
		}
	}

	if snapshot.GPS == nil {
		issues = append(issues, "No GPS data available")
	}

	// The device is considered "enabled" (present) when the leobodnar container
	// reports a non-empty device path (e.g. "/dev/hidraw0"), indicating the USB
	// HID device is connected.
	devicePresent := snapshot.Device != ""
	healthy := devicePresent && len(issues) == 0

	status := GPSDOHealthStatus{
		Enabled:      devicePresent,
		Healthy:      healthy,
		Issues:       issues,
		Device:       snapshot.Device,
		Serial:       snapshot.Serial,
		DeviceStatus: snapshot.DeviceStatus,
		GPS:          snapshot.GPS,
		LastChecked:  time.Now().UTC().Format(time.RFC3339),
	}

	if !healthy {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	json.NewEncoder(w).Encode(status)
}
