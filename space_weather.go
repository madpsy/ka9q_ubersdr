package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// SpaceWeatherMonitor fetches and caches space weather data from NOAA SWPC
type SpaceWeatherMonitor struct {
	config            *SpaceWeatherConfig
	mu                sync.RWMutex
	data              *SpaceWeatherData
	client            *http.Client
	ctx               context.Context
	cancel            context.CancelFunc
	prometheusMetrics *PrometheusMetrics

	// CSV logging
	currentFile *os.File
	csvWriter   *csv.Writer
	currentDate string
	fileMu      sync.Mutex
}

// SpaceWeatherData contains aggregated space weather information
type SpaceWeatherData struct {
	SolarFlux           float64           `json:"solar_flux"`            // 10.7cm solar flux (SFU)
	KIndex              int               `json:"k_index"`               // Planetary K-index (0-9)
	KIndexStatus        string            `json:"k_index_status"`        // Quiet/Unsettled/Active/Storm
	AIndex              int               `json:"a_index"`               // Planetary A-index
	SolarWindBz         float64           `json:"solar_wind_bz"`         // Solar wind Bz component (nT, negative values can trigger storms)
	BandConditionsDay   map[string]string `json:"band_conditions_day"`   // Per-band propagation during day
	BandConditionsNight map[string]string `json:"band_conditions_night"` // Per-band propagation during night
	PropagationQuality  string            `json:"propagation_quality"`   // Overall: Poor/Fair/Good/Excellent
	Forecast            *ForecastData     `json:"forecast,omitempty"`    // 24-hour forecast
	LastUpdate          time.Time         `json:"last_update"`           // When data was last fetched
	Timestamp           string            `json:"timestamp"`             // ISO 8601 timestamp
}

// ForecastData contains NOAA space weather forecast for next 24 hours
type ForecastData struct {
	GeomagneticStorm string `json:"geomagnetic_storm"` // e.g., "G3 - Strong"
	RadioBlackout    string `json:"radio_blackout"`    // e.g., "R2 - Moderate"
	SolarRadiation   string `json:"solar_radiation"`   // e.g., "S1 - Minor"
	Summary          string `json:"summary"`           // Human-readable summary

	// Raw NOAA scale values for CSV storage
	GScale     string `json:"g_scale,omitempty"`      // Geomagnetic storm scale (0-5)
	GText      string `json:"g_text,omitempty"`       // Geomagnetic storm description
	RScale     string `json:"r_scale,omitempty"`      // Radio blackout scale (0-5)
	RText      string `json:"r_text,omitempty"`       // Radio blackout description
	RMinorProb string `json:"r_minor_prob,omitempty"` // R1+ probability percentage
	RMajorProb string `json:"r_major_prob,omitempty"` // R3+ probability percentage
	SScale     string `json:"s_scale,omitempty"`      // Solar radiation scale (0-5)
	SText      string `json:"s_text,omitempty"`       // Solar radiation description
	SProb      string `json:"s_prob,omitempty"`       // S1+ probability percentage
}

// noaaScalesResponse represents the NOAA scales JSON response
type noaaScalesResponse map[string]struct {
	DateStamp string `json:"DateStamp"`
	TimeStamp string `json:"TimeStamp"`
	R         struct {
		Scale     string `json:"Scale"`
		Text      string `json:"Text"`
		MinorProb string `json:"MinorProb"`
		MajorProb string `json:"MajorProb"`
	} `json:"R"`
	S struct {
		Scale string `json:"Scale"`
		Text  string `json:"Text"`
		Prob  string `json:"Prob"`
	} `json:"S"`
	G struct {
		Scale string `json:"Scale"`
		Text  string `json:"Text"`
	} `json:"G"`
}

// NOAA API response structures
type noaaSolarFluxResponse struct {
	TimeTag string  `json:"time_tag"`
	Flux    float64 `json:"flux"`
}

// noaaKIndexResponse represents the official 3-hour K-index data
// Response is an array of arrays: ["2025-11-06 09:00:00.000", "3.33", "18", "8"]
// [0] = time_tag, [1] = Kp value, [2] = a_running (A-index), [3] = station_count
type noaaKIndexResponse []interface{}

type noaaSolarWindResponse struct {
	TimeTag string  `json:"time_tag"`
	BT      float64 `json:"bt"`     // Total magnetic field
	BzGSM   float64 `json:"bz_gsm"` // Bz component (important for geomagnetic activity)
}

// NewSpaceWeatherMonitor creates a new space weather monitor
func NewSpaceWeatherMonitor(config *SpaceWeatherConfig, prometheusMetrics *PrometheusMetrics) (*SpaceWeatherMonitor, error) {
	ctx, cancel := context.WithCancel(context.Background())

	swm := &SpaceWeatherMonitor{
		config:            config,
		prometheusMetrics: prometheusMetrics,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		ctx:    ctx,
		cancel: cancel,
		data: &SpaceWeatherData{
			BandConditionsDay:   make(map[string]string),
			BandConditionsNight: make(map[string]string),
			LastUpdate:          time.Time{},
		},
	}

	// Create data directory if CSV logging is enabled
	if config.LogToCSV && config.DataDir != "" {
		if err := os.MkdirAll(config.DataDir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create space weather data directory: %w", err)
		}
	}

	return swm, nil
}

// Start begins the space weather monitoring loop
func (swm *SpaceWeatherMonitor) Start() error {
	if !swm.config.Enabled {
		log.Println("Space weather monitoring is disabled")
		return nil
	}

	log.Printf("Starting space weather monitor (poll interval: %d seconds)", swm.config.PollIntervalSec)

	// Fetch initial data immediately
	if err := swm.fetchData(); err != nil {
		log.Printf("Warning: Initial space weather fetch failed: %v", err)
	}

	// Start background polling
	go swm.pollLoop()

	return nil
}

// Stop stops the space weather monitoring
func (swm *SpaceWeatherMonitor) Stop() {
	if swm.cancel != nil {
		swm.cancel()
	}

	// Close CSV file if open
	swm.fileMu.Lock()
	if swm.currentFile != nil {
		if err := swm.currentFile.Close(); err != nil {
			log.Printf("Error closing space weather CSV file: %v", err)
		}
	}
	swm.fileMu.Unlock()

	log.Println("Space weather monitor stopped")
}

// pollLoop continuously fetches space weather data
func (swm *SpaceWeatherMonitor) pollLoop() {
	ticker := time.NewTicker(time.Duration(swm.config.PollIntervalSec) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-swm.ctx.Done():
			return
		case <-ticker.C:
			if err := swm.fetchData(); err != nil {
				log.Printf("Error fetching space weather data: %v", err)
			}
		}
	}
}

// fetchData retrieves current space weather from NOAA SWPC APIs
func (swm *SpaceWeatherMonitor) fetchData() error {
	log.Println("Fetching space weather data from NOAA SWPC...")

	data := &SpaceWeatherData{
		BandConditionsDay:   make(map[string]string),
		BandConditionsNight: make(map[string]string),
		LastUpdate:          time.Now(),
		Timestamp:           time.Now().UTC().Format(time.RFC3339),
	}

	// Fetch solar flux (10.7cm)
	solarFlux, err := swm.fetchSolarFlux()
	if err != nil {
		log.Printf("Warning: Failed to fetch solar flux: %v", err)
	} else {
		data.SolarFlux = solarFlux
	}

	// Fetch K-index and A-index (both come from same API)
	kIndex, aIndex, err := swm.fetchKIndex()
	if err != nil {
		log.Printf("Warning: Failed to fetch K-index: %v", err)
	} else {
		data.KIndex = kIndex
		data.AIndex = aIndex
		data.KIndexStatus = getKIndexStatus(kIndex)
	}

	// Fetch solar wind Bz component
	solarWindBz, err := swm.fetchSolarWind()
	if err != nil {
		log.Printf("Warning: Failed to fetch solar wind: %v", err)
	} else {
		data.SolarWindBz = solarWindBz
	}

	// Fetch forecast data
	forecast, err := swm.fetchForecast()
	if err != nil {
		log.Printf("Warning: Failed to fetch forecast: %v", err)
	} else {
		data.Forecast = forecast
	}

	// Calculate propagation quality and band conditions (day and night)
	// Pass forecast to adjust for predicted storms
	data.PropagationQuality = calculatePropagationQuality(data.SolarFlux, data.KIndex, data.Forecast)
	data.BandConditionsDay = calculateBandConditions(data.SolarFlux, data.KIndex, true, data.Forecast)
	data.BandConditionsNight = calculateBandConditions(data.SolarFlux, data.KIndex, false, data.Forecast)

	// Update cached data
	swm.mu.Lock()
	swm.data = data
	swm.mu.Unlock()

	log.Printf("Space weather updated: SFI=%.1f, K=%d (%s), Quality=%s",
		data.SolarFlux, data.KIndex, data.KIndexStatus, data.PropagationQuality)

	// Update Prometheus metrics if available
	if swm.prometheusMetrics != nil {
		swm.prometheusMetrics.UpdateSpaceWeather(data)
	}

	// Log to CSV if enabled
	if swm.config.LogToCSV && swm.config.DataDir != "" {
		if err := swm.logToCSV(data); err != nil {
			log.Printf("Error logging space weather to CSV: %v", err)
		}
	}

	return nil
}

// fetchSolarFlux gets the latest 10.7cm solar flux from NOAA
func (swm *SpaceWeatherMonitor) fetchSolarFlux() (float64, error) {
	url := "https://services.swpc.noaa.gov/json/f107_cm_flux.json"

	req, err := http.NewRequestWithContext(swm.ctx, "GET", url, nil)
	if err != nil {
		return 0, err
	}

	resp, err := swm.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("NOAA API returned status %d", resp.StatusCode)
	}

	var data []noaaSolarFluxResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0, err
	}

	if len(data) == 0 {
		return 0, fmt.Errorf("no solar flux data available")
	}

	// Return the most recent value
	return data[len(data)-1].Flux, nil
}

// fetchKIndex gets the latest planetary K-index and A-index from NOAA
// Uses the official 3-hour K-index (not the 1-minute estimated values)
// Returns: kIndex, aIndex, error
func (swm *SpaceWeatherMonitor) fetchKIndex() (int, int, error) {
	url := "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"

	req, err := http.NewRequestWithContext(swm.ctx, "GET", url, nil)
	if err != nil {
		return 0, 0, err
	}

	resp, err := swm.client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, 0, fmt.Errorf("NOAA API returned status %d", resp.StatusCode)
	}

	var data []noaaKIndexResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0, 0, err
	}

	if len(data) == 0 {
		return 0, 0, fmt.Errorf("no K-index data available")
	}

	// Get the most recent entry (last array in the response)
	lastEntry := data[len(data)-1]
	if len(lastEntry) < 3 {
		return 0, 0, fmt.Errorf("invalid K-index data format")
	}

	// Parse the Kp value (index 1) as a string, then convert to float and round
	kpStr, ok := lastEntry[1].(string)
	if !ok {
		return 0, 0, fmt.Errorf("K-index value is not a string")
	}

	var kpFloat float64
	if _, err := fmt.Sscanf(kpStr, "%f", &kpFloat); err != nil {
		return 0, 0, fmt.Errorf("failed to parse K-index: %v", err)
	}

	// Parse the A-index (index 2) as a string, then convert to int
	aStr, ok := lastEntry[2].(string)
	if !ok {
		return 0, 0, fmt.Errorf("A-index value is not a string")
	}

	var aIndex int
	if _, err := fmt.Sscanf(aStr, "%d", &aIndex); err != nil {
		return 0, 0, fmt.Errorf("failed to parse A-index: %v", err)
	}

	// Round K-index to nearest integer
	return int(kpFloat + 0.5), aIndex, nil
}

// fetchSolarWind gets the latest solar wind magnetic field from NOAA
// Note: The NOAA real-time solar wind API doesn't include speed data
// We return the total magnetic field (Bt) as a proxy for solar wind conditions
func (swm *SpaceWeatherMonitor) fetchSolarWind() (float64, error) {
	url := "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json"

	req, err := http.NewRequestWithContext(swm.ctx, "GET", url, nil)
	if err != nil {
		return 0, err
	}

	resp, err := swm.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("NOAA API returned status %d", resp.StatusCode)
	}

	var data []noaaSolarWindResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0, err
	}

	if len(data) == 0 {
		return 0, fmt.Errorf("no solar wind data available")
	}

	// Return the most recent Bz GSM value (important for geomagnetic activity)
	// Negative Bz values can trigger geomagnetic storms
	return data[len(data)-1].BzGSM, nil
}

// fetchForecast gets the 24-hour space weather forecast from NOAA
func (swm *SpaceWeatherMonitor) fetchForecast() (*ForecastData, error) {
	url := "https://services.swpc.noaa.gov/products/noaa-scales.json"

	req, err := http.NewRequestWithContext(swm.ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := swm.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("NOAA API returned status %d", resp.StatusCode)
	}

	var data noaaScalesResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}

	// Get today's forecast (key "1")
	todayForecast, ok := data["1"]
	if !ok {
		return nil, fmt.Errorf("no forecast data available for today")
	}

	forecast := &ForecastData{}

	// Store raw values for CSV logging
	forecast.GScale = todayForecast.G.Scale
	forecast.GText = todayForecast.G.Text
	forecast.RScale = todayForecast.R.Scale
	forecast.RText = todayForecast.R.Text
	forecast.RMinorProb = todayForecast.R.MinorProb
	forecast.RMajorProb = todayForecast.R.MajorProb
	forecast.SScale = todayForecast.S.Scale
	forecast.SText = todayForecast.S.Text
	forecast.SProb = todayForecast.S.Prob

	// Build geomagnetic storm forecast
	if todayForecast.G.Scale != "" && todayForecast.G.Scale != "0" {
		forecast.GeomagneticStorm = fmt.Sprintf("G%s - %s", todayForecast.G.Scale,
			capitalizeFirst(todayForecast.G.Text))
	} else {
		forecast.GeomagneticStorm = "None expected"
	}

	// Build radio blackout forecast
	if todayForecast.R.MinorProb != "" {
		forecast.RadioBlackout = fmt.Sprintf("%s%% chance of R1+ events", todayForecast.R.MinorProb)
		if todayForecast.R.MajorProb != "" && todayForecast.R.MajorProb != "0" {
			forecast.RadioBlackout += fmt.Sprintf(", %s%% chance of R3+", todayForecast.R.MajorProb)
		}
	} else {
		forecast.RadioBlackout = "None expected"
	}

	// Build solar radiation forecast
	if todayForecast.S.Prob != "" && todayForecast.S.Prob != "0" {
		forecast.SolarRadiation = fmt.Sprintf("%s%% chance of S1+ event", todayForecast.S.Prob)
	} else {
		forecast.SolarRadiation = "None expected"
	}

	// Build summary
	forecast.Summary = buildForecastSummary(forecast)

	return forecast, nil
}

// buildForecastSummary creates a human-readable forecast summary
func buildForecastSummary(f *ForecastData) string {
	if f.GeomagneticStorm == "None expected" &&
		f.RadioBlackout == "None expected" &&
		f.SolarRadiation == "None expected" {
		return "Quiet conditions expected for the next 24 hours."
	}

	summary := "Space weather for the next 24 hours: "

	if f.GeomagneticStorm != "None expected" {
		summary += fmt.Sprintf("Geomagnetic storms reaching %s are likely. ", f.GeomagneticStorm)
	}

	if f.RadioBlackout != "None expected" && f.RadioBlackout != "" {
		summary += fmt.Sprintf("Radio blackouts possible (%s). ", f.RadioBlackout)
	}

	if f.SolarRadiation != "None expected" {
		summary += fmt.Sprintf("Solar radiation events possible (%s). ", f.SolarRadiation)
	}

	return summary
}

// capitalizeFirst capitalizes the first letter of a string
func capitalizeFirst(s string) string {
	if len(s) == 0 {
		return s
	}
	return string(s[0]-32) + s[1:]
}

// GetData returns the current cached space weather data
func (swm *SpaceWeatherMonitor) GetData() *SpaceWeatherData {
	swm.mu.RLock()
	defer swm.mu.RUnlock()

	// Return a copy to avoid race conditions
	dataCopy := *swm.data
	dataCopy.BandConditionsDay = make(map[string]string)
	dataCopy.BandConditionsNight = make(map[string]string)
	for k, v := range swm.data.BandConditionsDay {
		dataCopy.BandConditionsDay[k] = v
	}
	for k, v := range swm.data.BandConditionsNight {
		dataCopy.BandConditionsNight[k] = v
	}

	return &dataCopy
}

// getKIndexStatus converts K-index to status string
func getKIndexStatus(kIndex int) string {
	switch {
	case kIndex <= 2:
		return "Quiet"
	case kIndex <= 4:
		return "Unsettled"
	case kIndex <= 6:
		return "Active"
	default:
		return "Storm"
	}
}

// calculatePropagationQuality determines overall HF propagation quality
func calculatePropagationQuality(solarFlux float64, kIndex int, forecast *ForecastData) string {
	// High solar flux is good, low K-index is good
	score := 0

	// Solar flux scoring (0-3 points)
	switch {
	case solarFlux >= 180:
		score += 3
	case solarFlux >= 120:
		score += 2
	case solarFlux >= 80:
		score += 1
	}

	// K-index scoring (0-3 points, inverted - lower is better)
	switch {
	case kIndex <= 2:
		score += 3
	case kIndex <= 4:
		score += 2
	case kIndex <= 6:
		score += 1
	}

	// Degrade score based on forecast
	if forecast != nil {
		// Check for geomagnetic storm forecast (G-scale)
		if forecast.GeomagneticStorm != "None expected" {
			// G3+ storms significantly degrade conditions
			if len(forecast.GeomagneticStorm) >= 2 && forecast.GeomagneticStorm[1] >= '3' {
				score -= 2 // Major storm forecast
			} else if len(forecast.GeomagneticStorm) >= 2 && forecast.GeomagneticStorm[1] >= '1' {
				score -= 1 // Minor storm forecast
			}
		}
	}

	// Ensure score doesn't go negative
	if score < 0 {
		score = 0
	}

	// Convert score to quality
	switch {
	case score >= 5:
		return "Excellent"
	case score >= 3:
		return "Good"
	case score >= 2:
		return "Fair"
	default:
		return "Poor"
	}
}

// calculateBandConditions determines propagation for each HF band
// isDay parameter: true for daytime conditions, false for nighttime
// forecast parameter: used to degrade conditions when storms are predicted
func calculateBandConditions(solarFlux float64, kIndex int, isDay bool, forecast *ForecastData) map[string]string {
	conditions := make(map[string]string)

	// Check for storm forecast and adjust effective K-index
	effectiveKIndex := kIndex
	stormPenalty := 0

	if forecast != nil && forecast.GeomagneticStorm != "None expected" {
		// Extract G-scale number (G1, G2, G3, etc.)
		if len(forecast.GeomagneticStorm) >= 2 {
			gScale := forecast.GeomagneticStorm[1]
			switch gScale {
			case '1', '2':
				stormPenalty = 1 // Minor/Moderate storm: degrade by 1 level
			case '3', '4':
				stormPenalty = 2 // Strong/Severe storm: degrade by 2 levels
			case '5':
				stormPenalty = 3 // Extreme storm: degrade by 3 levels
			}
		}
		// Increase effective K-index to simulate worse conditions
		effectiveKIndex = kIndex + stormPenalty
		if effectiveKIndex > 9 {
			effectiveKIndex = 9
		}
	}

	// Lower bands (160m, 80m) - MUCH better at night, poor during day
	// These are primarily nighttime bands
	if isDay {
		// During day, D-layer absorption makes these bands very difficult
		// But with very quiet conditions, some local/regional contacts possible
		if kIndex <= 2 {
			conditions["160m"] = "Poor"
			conditions["80m"] = "Fair" // 80m slightly better than 160m during day
		} else {
			conditions["160m"] = "Poor"
			conditions["80m"] = "Poor"
		}
	} else {
		// At night, these bands open up significantly
		if effectiveKIndex <= 3 {
			conditions["160m"] = "Excellent"
			conditions["80m"] = "Excellent"
		} else if effectiveKIndex <= 5 {
			conditions["160m"] = "Good"
			conditions["80m"] = "Good"
		} else {
			conditions["160m"] = "Fair"
			conditions["80m"] = "Fair"
		}
	}

	// Mid-low bands (60m, 40m) - work both day and night, but better at night
	if isDay {
		if effectiveKIndex <= 3 {
			conditions["60m"] = "Good"
			conditions["40m"] = "Good"
		} else if effectiveKIndex <= 5 {
			conditions["60m"] = "Fair"
			conditions["40m"] = "Fair"
		} else {
			conditions["60m"] = "Poor"
			conditions["40m"] = "Poor"
		}
	} else {
		// Better at night
		if effectiveKIndex <= 3 {
			conditions["60m"] = "Excellent"
			conditions["40m"] = "Excellent"
		} else if effectiveKIndex <= 5 {
			conditions["60m"] = "Good"
			conditions["40m"] = "Good"
		} else {
			conditions["60m"] = "Fair"
			conditions["40m"] = "Fair"
		}
	}

	// 30m band - transitional, works day and night but affected by conditions
	if effectiveKIndex <= 3 {
		conditions["30m"] = "Good"
	} else if effectiveKIndex <= 5 {
		conditions["30m"] = "Fair"
	} else {
		conditions["30m"] = "Poor"
	}

	// Higher bands (20m, 17m, 15m) - NEED daylight and ionization
	// These close or become very poor at night
	if isDay {
		// During day, solar flux matters a lot
		if solarFlux >= 120 && effectiveKIndex <= 3 {
			conditions["20m"] = "Excellent"
			conditions["17m"] = "Good"
			conditions["15m"] = "Good"
		} else if solarFlux >= 80 && effectiveKIndex <= 5 {
			conditions["20m"] = "Good"
			conditions["17m"] = "Fair"
			conditions["15m"] = "Fair"
		} else {
			conditions["20m"] = "Fair"
			conditions["17m"] = "Poor"
			conditions["15m"] = "Poor"
		}
	} else {
		// At night, these bands are generally poor or closed
		// 20m might have some gray-line propagation
		if solarFlux >= 150 && effectiveKIndex <= 2 {
			conditions["20m"] = "Fair" // Gray-line propagation possible
		} else {
			conditions["20m"] = "Poor"
		}
		conditions["17m"] = "Poor"
		conditions["15m"] = "Poor"
	}

	// Highest bands (12m, 10m) - STRICTLY daytime bands, need high solar flux
	// These are completely closed at night
	if isDay {
		if solarFlux >= 150 && effectiveKIndex <= 2 {
			conditions["12m"] = "Good"
			conditions["10m"] = "Good"
		} else if solarFlux >= 100 && effectiveKIndex <= 4 {
			conditions["12m"] = "Fair"
			conditions["10m"] = "Fair"
		} else {
			conditions["12m"] = "Poor"
			conditions["10m"] = "Poor"
		}
	} else {
		// At night, 10m and 12m are closed
		conditions["12m"] = "Poor"
		conditions["10m"] = "Poor"
	}

	return conditions
}

// logToCSV writes space weather data to CSV file
func (swm *SpaceWeatherMonitor) logToCSV(data *SpaceWeatherData) error {
	swm.fileMu.Lock()
	defer swm.fileMu.Unlock()

	// Check if we need to rotate to a new file
	dateStr := data.LastUpdate.Format("2006-01-02")
	if dateStr != swm.currentDate {
		if err := swm.rotateCSVFile(dateStr); err != nil {
			return err
		}
	}

	// Get writer
	if swm.csvWriter == nil {
		return fmt.Errorf("CSV writer not initialized")
	}

	// Prepare CSV record
	record := []string{
		data.Timestamp,
		fmt.Sprintf("%.1f", data.SolarFlux),
		fmt.Sprintf("%d", data.KIndex),
		data.KIndexStatus,
		fmt.Sprintf("%d", data.AIndex),
		fmt.Sprintf("%.2f", data.SolarWindBz),
		data.PropagationQuality,
	}

	// Add forecast data if available
	if data.Forecast != nil {
		record = append(record,
			data.Forecast.GScale,
			data.Forecast.GText,
			data.Forecast.RScale,
			data.Forecast.RText,
			data.Forecast.RMinorProb,
			data.Forecast.RMajorProb,
			data.Forecast.SScale,
			data.Forecast.SText,
			data.Forecast.SProb,
			data.Forecast.Summary,
		)
	} else {
		// Add empty values if no forecast
		record = append(record, "", "", "", "", "", "", "", "", "", "")
	}

	// Add band conditions (day)
	for _, band := range []string{"160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"} {
		if cond, ok := data.BandConditionsDay[band]; ok {
			record = append(record, cond)
		} else {
			record = append(record, "")
		}
	}

	// Add band conditions (night)
	for _, band := range []string{"160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"} {
		if cond, ok := data.BandConditionsNight[band]; ok {
			record = append(record, cond)
		} else {
			record = append(record, "")
		}
	}

	// Write record
	if err := swm.csvWriter.Write(record); err != nil {
		return err
	}

	// Flush after each write
	swm.csvWriter.Flush()
	return swm.csvWriter.Error()
}

// rotateCSVFile creates a new CSV file for the specified date
func (swm *SpaceWeatherMonitor) rotateCSVFile(dateStr string) error {
	// Close current file if open
	if swm.currentFile != nil {
		if err := swm.currentFile.Close(); err != nil {
			log.Printf("Warning: error closing previous CSV file: %v", err)
		}
	}

	// Parse date to create year/month directory structure
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return fmt.Errorf("invalid date format: %w", err)
	}

	// Create directory path: base_dir/YYYY/MM/
	dirPath := filepath.Join(
		swm.config.DataDir,
		fmt.Sprintf("%04d", t.Year()),
		fmt.Sprintf("%02d", t.Month()),
	)

	// Create directory structure if it doesn't exist
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return fmt.Errorf("failed to create directory structure: %w", err)
	}

	// Create file: base_dir/YYYY/MM/spaceweather-YYYY-MM-DD.csv
	filename := filepath.Join(dirPath, fmt.Sprintf("spaceweather-%s.csv", dateStr))
	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}

	// Check if file is new (needs header)
	stat, _ := file.Stat()
	needsHeader := stat.Size() == 0

	swm.currentFile = file
	swm.csvWriter = csv.NewWriter(file)
	swm.currentDate = dateStr

	// Write header if new file
	if needsHeader {
		header := []string{
			"timestamp", "solar_flux", "k_index", "k_index_status", "a_index",
			"solar_wind_bz", "propagation_quality",
			"g_scale", "g_text", "r_scale", "r_text", "r_minor_prob", "r_major_prob",
			"s_scale", "s_text", "s_prob", "forecast_summary",
			"band_160m_day", "band_80m_day", "band_60m_day", "band_40m_day", "band_30m_day",
			"band_20m_day", "band_17m_day", "band_15m_day", "band_12m_day", "band_10m_day",
			"band_160m_night", "band_80m_night", "band_60m_night", "band_40m_night", "band_30m_night",
			"band_20m_night", "band_17m_night", "band_15m_night", "band_12m_night", "band_10m_night",
		}
		if err := swm.csvWriter.Write(header); err != nil {
			return fmt.Errorf("failed to write CSV header: %w", err)
		}
		swm.csvWriter.Flush()
		log.Printf("Created new space weather log file: %s", filename)
	}

	return nil
}

// GetHistoricalData reads historical space weather data from CSV and reconstructs it
// Parameters:
// - fromDate: Required start date in YYYY-MM-DD format
// - toDate: Optional end date in YYYY-MM-DD format (if empty, uses fromDate)
// - targetTime: Optional time to find closest record (HH:MM:SS or HH:MM or RFC3339) - only works with single day
// - fromTime: Optional start time for range query (RFC3339 or HH:MM:SS)
// - toTime: Optional end time for range query (RFC3339 or HH:MM:SS)
// Returns up to 10,000 records
func (swm *SpaceWeatherMonitor) GetHistoricalData(fromDate string, toDate string, targetTime string, fromTime string, toTime string) ([]*SpaceWeatherData, error) {
	if !swm.config.LogToCSV || swm.config.DataDir == "" {
		return nil, fmt.Errorf("CSV logging is not enabled")
	}

	// If toDate is empty, use fromDate (single day query)
	if toDate == "" {
		toDate = fromDate
	}

	// Parse dates
	startDate, err := time.Parse("2006-01-02", fromDate)
	if err != nil {
		return nil, fmt.Errorf("invalid from_date format (use YYYY-MM-DD): %w", err)
	}

	endDate, err := time.Parse("2006-01-02", toDate)
	if err != nil {
		return nil, fmt.Errorf("invalid to_date format (use YYYY-MM-DD): %w", err)
	}

	// Ensure startDate <= endDate
	if startDate.After(endDate) {
		return nil, fmt.Errorf("from_date must be before or equal to to_date")
	}

	// Collect all records from date range
	allRecords := make([]*SpaceWeatherData, 0)

	// Iterate through each date in the range
	currentDate := startDate
	for !currentDate.After(endDate) {
		dateStr := currentDate.Format("2006-01-02")

		// Build file path for this date
		filename := filepath.Join(
			swm.config.DataDir,
			fmt.Sprintf("%04d", currentDate.Year()),
			fmt.Sprintf("%02d", currentDate.Month()),
			fmt.Sprintf("spaceweather-%s.csv", dateStr),
		)

		// Try to open file (may not exist for all dates)
		file, err := os.Open(filename)
		if err != nil {
			// Skip missing files silently
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Read CSV
		reader := csv.NewReader(file)
		records, err := reader.ReadAll()
		file.Close()

		if err != nil {
			log.Printf("Warning: failed to read %s: %v", filename, err)
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		if len(records) < 2 {
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Skip header and parse records
		for _, record := range records[1:] {
			if len(record) < 37 {
				continue
			}

			data, err := swm.parseCSVRecord(record)
			if err != nil {
				continue
			}

			allRecords = append(allRecords, data)
		}

		currentDate = currentDate.AddDate(0, 0, 1)
	}

	if len(allRecords) == 0 {
		return nil, fmt.Errorf("no data found for date range")
	}

	// If targetTime is specified (only valid for single day), find the closest record
	if targetTime != "" && fromDate == toDate {
		closest, err := swm.findClosestRecord(allRecords, targetTime)
		if err != nil {
			return nil, err
		}
		return []*SpaceWeatherData{closest}, nil
	}

	// If fromTime and toTime are specified, filter by time range
	if fromTime != "" || toTime != "" {
		filtered, err := swm.filterByTimeRangeMultiDay(allRecords, fromDate, toDate, fromTime, toTime)
		if err != nil {
			return nil, err
		}
		allRecords = filtered
	}

	// Limit to 10,000 records
	if len(allRecords) > 10000 {
		allRecords = allRecords[:10000]
	}

	return allRecords, nil
}

// findClosestRecord finds the record closest to the specified time
func (swm *SpaceWeatherMonitor) findClosestRecord(records []*SpaceWeatherData, targetTimeStr string) (*SpaceWeatherData, error) {
	if len(records) == 0 {
		return nil, fmt.Errorf("no records available")
	}

	// Parse target time - support both full RFC3339 and time-only formats
	var targetTime time.Time
	var err error

	// Try parsing as full RFC3339 first
	targetTime, err = time.Parse(time.RFC3339, targetTimeStr)
	if err != nil {
		// Try parsing as time only (HH:MM:SS or HH:MM)
		// Use the date from the first record
		dateStr := records[0].LastUpdate.Format("2006-01-02")

		// Try HH:MM:SS format
		targetTime, err = time.Parse("2006-01-02T15:04:05Z07:00", dateStr+"T"+targetTimeStr+"Z")
		if err != nil {
			// Try HH:MM format
			targetTime, err = time.Parse("2006-01-02T15:04Z07:00", dateStr+"T"+targetTimeStr+"Z")
			if err != nil {
				return nil, fmt.Errorf("invalid time format (use RFC3339, HH:MM:SS, or HH:MM): %w", err)
			}
		}
	}

	// Find the record with minimum time difference
	var closest *SpaceWeatherData
	minDiff := time.Duration(1<<63 - 1) // Max duration

	for _, record := range records {
		diff := record.LastUpdate.Sub(targetTime)
		if diff < 0 {
			diff = -diff
		}

		if diff < minDiff {
			minDiff = diff
			closest = record
		}
	}

	return closest, nil
}

// filterByTimeRange filters records to those within the specified time range (single day)
func (swm *SpaceWeatherMonitor) filterByTimeRange(records []*SpaceWeatherData, date string, fromTimeStr string, toTimeStr string) ([]*SpaceWeatherData, error) {
	if len(records) == 0 {
		return records, nil
	}

	var fromTime, toTime time.Time
	var err error

	// Parse fromTime if provided
	if fromTimeStr != "" {
		fromTime, err = swm.parseTimeWithDate(fromTimeStr, date)
		if err != nil {
			return nil, fmt.Errorf("invalid from_time format: %w", err)
		}
	} else {
		// Default to start of day
		fromTime, _ = time.Parse("2006-01-02", date)
	}

	// Parse toTime if provided
	if toTimeStr != "" {
		toTime, err = swm.parseTimeWithDate(toTimeStr, date)
		if err != nil {
			return nil, fmt.Errorf("invalid to_time format: %w", err)
		}
	} else {
		// Default to end of day
		toTime, _ = time.Parse("2006-01-02", date)
		toTime = toTime.Add(24 * time.Hour).Add(-time.Second)
	}

	// Filter records within the time range
	filtered := make([]*SpaceWeatherData, 0)
	for _, record := range records {
		if (record.LastUpdate.Equal(fromTime) || record.LastUpdate.After(fromTime)) &&
			(record.LastUpdate.Equal(toTime) || record.LastUpdate.Before(toTime)) {
			filtered = append(filtered, record)
		}
	}

	return filtered, nil
}

// filterByTimeRangeMultiDay filters records across multiple days with optional time constraints
func (swm *SpaceWeatherMonitor) filterByTimeRangeMultiDay(records []*SpaceWeatherData, fromDate string, toDate string, fromTimeStr string, toTimeStr string) ([]*SpaceWeatherData, error) {
	if len(records) == 0 {
		return records, nil
	}

	var fromTime, toTime time.Time
	var err error

	// Parse fromTime if provided, otherwise use start of fromDate
	if fromTimeStr != "" {
		fromTime, err = swm.parseTimeWithDate(fromTimeStr, fromDate)
		if err != nil {
			return nil, fmt.Errorf("invalid from_time format: %w", err)
		}
	} else {
		fromTime, _ = time.Parse("2006-01-02", fromDate)
	}

	// Parse toTime if provided, otherwise use end of toDate
	if toTimeStr != "" {
		toTime, err = swm.parseTimeWithDate(toTimeStr, toDate)
		if err != nil {
			return nil, fmt.Errorf("invalid to_time format: %w", err)
		}
	} else {
		toTime, _ = time.Parse("2006-01-02", toDate)
		toTime = toTime.Add(24 * time.Hour).Add(-time.Second)
	}

	// Filter records within the time range
	filtered := make([]*SpaceWeatherData, 0)
	for _, record := range records {
		if (record.LastUpdate.Equal(fromTime) || record.LastUpdate.After(fromTime)) &&
			(record.LastUpdate.Equal(toTime) || record.LastUpdate.Before(toTime)) {
			filtered = append(filtered, record)
		}
	}

	return filtered, nil
}

// parseTimeWithDate parses a time string with a date context
// Supports RFC3339, HH:MM:SS, and HH:MM formats
func (swm *SpaceWeatherMonitor) parseTimeWithDate(timeStr string, date string) (time.Time, error) {
	// Try parsing as full RFC3339 first
	t, err := time.Parse(time.RFC3339, timeStr)
	if err == nil {
		return t, nil
	}

	// Try parsing as time only (HH:MM:SS or HH:MM)
	// Try HH:MM:SS format
	t, err = time.Parse("2006-01-02T15:04:05Z07:00", date+"T"+timeStr+"Z")
	if err == nil {
		return t, nil
	}

	// Try HH:MM format
	t, err = time.Parse("2006-01-02T15:04Z07:00", date+"T"+timeStr+"Z")
	if err == nil {
		return t, nil
	}

	return time.Time{}, fmt.Errorf("invalid time format (use RFC3339, HH:MM:SS, or HH:MM)")
}

// parseCSVRecord parses a single CSV record into SpaceWeatherData
// Reconstructs forecast text using the same logic as live data
func (swm *SpaceWeatherMonitor) parseCSVRecord(record []string) (*SpaceWeatherData, error) {
	// Parse timestamp
	timestamp, err := time.Parse(time.RFC3339, record[0])
	if err != nil {
		return nil, fmt.Errorf("invalid timestamp: %w", err)
	}

	data := &SpaceWeatherData{
		Timestamp:           record[0],
		LastUpdate:          timestamp,
		BandConditionsDay:   make(map[string]string),
		BandConditionsNight: make(map[string]string),
	}

	// Parse core metrics
	fmt.Sscanf(record[1], "%f", &data.SolarFlux)
	fmt.Sscanf(record[2], "%d", &data.KIndex)
	data.KIndexStatus = record[3]
	fmt.Sscanf(record[4], "%d", &data.AIndex)
	fmt.Sscanf(record[5], "%f", &data.SolarWindBz)
	data.PropagationQuality = record[6]

	// Parse forecast data and reconstruct text using same logic
	forecast := &ForecastData{
		GScale:     record[7],
		GText:      record[8],
		RScale:     record[9],
		RText:      record[10],
		RMinorProb: record[11],
		RMajorProb: record[12],
		SScale:     record[13],
		SText:      record[14],
		SProb:      record[15],
		Summary:    record[16],
	}

	// Reconstruct forecast text using same logic as fetchForecast()
	// Geomagnetic storm
	if forecast.GScale != "" && forecast.GScale != "0" {
		forecast.GeomagneticStorm = fmt.Sprintf("G%s - %s", forecast.GScale,
			capitalizeFirst(forecast.GText))
	} else {
		forecast.GeomagneticStorm = "None expected"
	}

	// Radio blackout
	if forecast.RMinorProb != "" {
		forecast.RadioBlackout = fmt.Sprintf("%s%% chance of R1+ events", forecast.RMinorProb)
		if forecast.RMajorProb != "" && forecast.RMajorProb != "0" {
			forecast.RadioBlackout += fmt.Sprintf(", %s%% chance of R3+", forecast.RMajorProb)
		}
	} else {
		forecast.RadioBlackout = "None expected"
	}

	// Solar radiation
	if forecast.SProb != "" && forecast.SProb != "0" {
		forecast.SolarRadiation = fmt.Sprintf("%s%% chance of S1+ event", forecast.SProb)
	} else {
		forecast.SolarRadiation = "None expected"
	}

	// Reconstruct summary using same logic
	forecast.Summary = buildForecastSummary(forecast)

	data.Forecast = forecast

	// Parse band conditions (day)
	bands := []string{"160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"}
	for i, band := range bands {
		if record[17+i] != "" {
			data.BandConditionsDay[band] = record[17+i]
		}
	}

	// Parse band conditions (night)
	for i, band := range bands {
		if record[27+i] != "" {
			data.BandConditionsNight[band] = record[27+i]
		}
	}

	return data, nil
}

// GetAvailableDates returns a list of dates for which historical data is available
func (swm *SpaceWeatherMonitor) GetAvailableDates() ([]string, error) {
	if !swm.config.LogToCSV || swm.config.DataDir == "" {
		return nil, fmt.Errorf("CSV logging is not enabled")
	}

	dateMap := make(map[string]bool)

	// Walk through year directories
	yearDirs, err := os.ReadDir(swm.config.DataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read data directory: %w", err)
	}

	for _, yearDir := range yearDirs {
		if !yearDir.IsDir() {
			continue
		}
		year := yearDir.Name()

		// Walk through month directories
		monthPath := filepath.Join(swm.config.DataDir, year)
		monthDirs, err := os.ReadDir(monthPath)
		if err != nil {
			continue
		}

		for _, monthDir := range monthDirs {
			if !monthDir.IsDir() {
				continue
			}
			month := monthDir.Name()

			// Look for CSV files in month directory
			csvPath := filepath.Join(monthPath, month)
			files, err := os.ReadDir(csvPath)
			if err != nil {
				continue
			}

			for _, file := range files {
				if !file.IsDir() && filepath.Ext(file.Name()) == ".csv" {
					// Extract date from filename: spaceweather-YYYY-MM-DD.csv
					name := file.Name()
					if len(name) > 13 && name[:13] == "spaceweather-" {
						date := name[13 : len(name)-4] // Remove "spaceweather-" prefix and ".csv" suffix
						dateMap[date] = true
					}
				}
			}
		}
	}

	// Convert map to sorted slice
	dates := make([]string, 0, len(dateMap))
	for date := range dateMap {
		dates = append(dates, date)
	}

	// Sort dates in descending order (newest first)
	sort.Slice(dates, func(i, j int) bool {
		return dates[i] > dates[j]
	})

	return dates, nil
}

// GetHistoricalCSV reads the raw CSV file(s) for a given date range and optionally filters by time range
// Returns the CSV content as a string with header
func (swm *SpaceWeatherMonitor) GetHistoricalCSV(fromDate string, toDate string, fromTime string, toTime string) (string, error) {
	if !swm.config.LogToCSV || swm.config.DataDir == "" {
		return "", fmt.Errorf("CSV logging is not enabled")
	}

	// If toDate is empty, use fromDate (single day query)
	if toDate == "" {
		toDate = fromDate
	}

	// Parse dates
	startDate, err := time.Parse("2006-01-02", fromDate)
	if err != nil {
		return "", fmt.Errorf("invalid from_date format (use YYYY-MM-DD): %w", err)
	}

	endDate, err := time.Parse("2006-01-02", toDate)
	if err != nil {
		return "", fmt.Errorf("invalid to_date format (use YYYY-MM-DD): %w", err)
	}

	// Ensure startDate <= endDate
	if startDate.After(endDate) {
		return "", fmt.Errorf("from_date must be before or equal to to_date")
	}

	// Collect all records from date range
	var allRecords [][]string
	var header []string

	// Iterate through each date in the range
	currentDate := startDate
	for !currentDate.After(endDate) {
		dateStr := currentDate.Format("2006-01-02")

		// Build file path for this date
		filename := filepath.Join(
			swm.config.DataDir,
			fmt.Sprintf("%04d", currentDate.Year()),
			fmt.Sprintf("%02d", currentDate.Month()),
			fmt.Sprintf("spaceweather-%s.csv", dateStr),
		)

		// Try to open file
		file, err := os.Open(filename)
		if err != nil {
			// Skip missing files silently
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Read CSV
		reader := csv.NewReader(file)
		records, err := reader.ReadAll()
		file.Close()

		if err != nil {
			log.Printf("Warning: failed to read %s: %v", filename, err)
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		if len(records) < 1 {
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Save header from first file
		if header == nil {
			header = records[0]
		}

		// Add data records (skip header)
		if len(records) > 1 {
			allRecords = append(allRecords, records[1:]...)
		}

		currentDate = currentDate.AddDate(0, 0, 1)
	}

	if len(allRecords) == 0 {
		return "", fmt.Errorf("no data found for date range")
	}

	// If no time filtering, return all records
	if fromTime == "" && toTime == "" {
		result := [][]string{header}
		result = append(result, allRecords...)
		return swm.recordsToCSV(result), nil
	}

	// Filter by time range
	var fromTimeParsed, toTimeParsed time.Time

	if fromTime != "" {
		fromTimeParsed, err = swm.parseTimeWithDate(fromTime, fromDate)
		if err != nil {
			return "", fmt.Errorf("invalid from_time format: %w", err)
		}
	} else {
		fromTimeParsed, _ = time.Parse("2006-01-02", fromDate)
	}

	if toTime != "" {
		toTimeParsed, err = swm.parseTimeWithDate(toTime, toDate)
		if err != nil {
			return "", fmt.Errorf("invalid to_time format: %w", err)
		}
	} else {
		toTimeParsed, _ = time.Parse("2006-01-02", toDate)
		toTimeParsed = toTimeParsed.Add(24 * time.Hour).Add(-time.Second)
	}

	// Filter records (keep header + filtered data)
	filteredRecords := [][]string{header}
	for _, record := range allRecords {
		if len(record) < 1 {
			continue
		}

		timestamp, err := time.Parse(time.RFC3339, record[0])
		if err != nil {
			continue
		}

		if (timestamp.Equal(fromTimeParsed) || timestamp.After(fromTimeParsed)) &&
			(timestamp.Equal(toTimeParsed) || timestamp.Before(toTimeParsed)) {
			filteredRecords = append(filteredRecords, record)
		}
	}

	return swm.recordsToCSV(filteredRecords), nil
}

// recordsToCSV converts CSV records to a CSV string
func (swm *SpaceWeatherMonitor) recordsToCSV(records [][]string) string {
	var result string
	for _, record := range records {
		for i, field := range record {
			if i > 0 {
				result += ","
			}
			// Quote fields that contain commas or quotes
			if strings.Contains(field, ",") || strings.Contains(field, "\"") {
				result += "\"" + strings.ReplaceAll(field, "\"", "\"\"") + "\""
			} else {
				result += field
			}
		}
		result += "\n"
	}
	return result
}
