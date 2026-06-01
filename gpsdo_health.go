package main

import (
	"encoding/json"
	"fmt"
	"net/http"
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
type GPSDOSnapshot struct {
	Device       string             `json:"device"`
	Serial       string             `json:"serial"`
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

// handleGPSDOHealth fetches the leobodnar /json endpoint server-side and returns
// a health payload for the admin monitor tab.
// Health criteria: GPS lock, PLL lock, output 1 enabled, frequency == 27 MHz.
func handleGPSDOHealth(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")

	if !config.GPSDO.Enabled {
		json.NewEncoder(w).Encode(GPSDOHealthStatus{
			Enabled:     false,
			Healthy:     false,
			Issues:      []string{"GPSDO is not enabled in configuration"},
			LastChecked: time.Now().UTC().Format(time.RFC3339),
		})
		return
	}

	url := fmt.Sprintf("http://%s:%d/json", config.GPSDO.Host, config.GPSDO.Port)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(GPSDOHealthStatus{
			Enabled:     true,
			Healthy:     false,
			Issues:      []string{fmt.Sprintf("Cannot reach leobodnar container: %v", err)},
			LastChecked: time.Now().UTC().Format(time.RFC3339),
		})
		return
	}
	defer resp.Body.Close()

	var snapshot GPSDOSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(GPSDOHealthStatus{
			Enabled:     true,
			Healthy:     false,
			Issues:      []string{fmt.Sprintf("Invalid JSON from leobodnar container: %v", err)},
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

	healthy := len(issues) == 0

	status := GPSDOHealthStatus{
		Enabled:      true,
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
