package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// SpaceWeatherMonitor fetches and caches space weather data from NOAA SWPC
type SpaceWeatherMonitor struct {
	config *SpaceWeatherConfig
	mu     sync.RWMutex
	data   *SpaceWeatherData
	client *http.Client
	ctx    context.Context
	cancel context.CancelFunc
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
func NewSpaceWeatherMonitor(config *SpaceWeatherConfig) *SpaceWeatherMonitor {
	ctx, cancel := context.WithCancel(context.Background())

	return &SpaceWeatherMonitor{
		config: config,
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
