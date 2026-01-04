package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"
)

// HamBand represents a standard amateur radio band with its frequency range
type HamBand struct {
	Name    string
	MinFreq int64
	MaxFreq int64
}

// Standard amateur radio bands (160m through 10m)
var StandardHamBands = []HamBand{
	{Name: "160m", MinFreq: 1800000, MaxFreq: 2000000},
	{Name: "80m", MinFreq: 3500000, MaxFreq: 4000000},
	{Name: "60m", MinFreq: 5330500, MaxFreq: 5406500},
	{Name: "40m", MinFreq: 7000000, MaxFreq: 7300000},
	{Name: "30m", MinFreq: 10100000, MaxFreq: 10150000},
	{Name: "20m", MinFreq: 14000000, MaxFreq: 14350000},
	{Name: "17m", MinFreq: 18068000, MaxFreq: 18168000},
	{Name: "15m", MinFreq: 21000000, MaxFreq: 21450000},
	{Name: "12m", MinFreq: 24890000, MaxFreq: 24990000},
	{Name: "10m", MinFreq: 28000000, MaxFreq: 29700000},
}

// SmartRoutingConfig holds configuration for intelligent instance selection
type SmartRoutingConfig struct {
	Enabled                   bool                 `yaml:"enabled"`
	DefaultURL                string               `yaml:"default_url"`
	DefaultPassword           string               `yaml:"default_password"`
	CollectorAPIURL           string               `yaml:"collector_api_url"` // e.g., "https://instances.ubersdr.org"
	Location                  LocationConfig       `yaml:"location"`
	RequiredBandwidth         string               `yaml:"required_bandwidth"`           // e.g., "iq48", "iq96", "iq192"
	MaxConnectionsPerInstance int                  `yaml:"max_connections_per_instance"` // Maximum receivers per instance (default: 1)
	Filters                   SmartRoutingFilters  `yaml:"filters"`
	Behavior                  SmartRoutingBehavior `yaml:"behavior"`

	// Internal state
	cache            *InstanceCache
	lastQuery        time.Time
	queryMutex       sync.RWMutex
	instanceUsage    map[string]int // URL -> count of active connections
	instanceUsageMux sync.RWMutex
}

// LocationConfig holds user's geographic location
type LocationConfig struct {
	Latitude      float64 `yaml:"latitude"`
	Longitude     float64 `yaml:"longitude"`
	MaxDistanceKm float64 `yaml:"max_distance_km"`
}

// SmartRoutingFilters holds additional filtering options
type SmartRoutingFilters struct {
	CORSEnabled   bool `yaml:"cors_enabled"`
	UnlimitedOnly bool `yaml:"unlimited_only"`
	MinSlots      int  `yaml:"min_slots"`
}

// SmartRoutingBehavior controls routing behavior
type SmartRoutingBehavior struct {
	CheckIntervalSeconds int     `yaml:"check_interval_seconds"` // How often to refresh instance list
	MinSNRDB             float64 `yaml:"min_snr_db"`             // Minimum SNR required to use an instance (default: 0)
	SwitchThresholdDB    float64 `yaml:"switch_threshold_db"`    // Minimum SNR improvement to switch
	PreferCloser         bool    `yaml:"prefer_closer"`          // Prefer closer instances when quality is equal
	PriorityMode         string  `yaml:"priority_mode"`          // "snr" (default), "distance", or "balanced"
}

// InstanceCache caches API responses to reduce load
type InstanceCache struct {
	instances   []CollectorInstance
	lastUpdated time.Time
	mutex       sync.RWMutex
}

// CollectorInstance represents an instance from the collector API
type CollectorInstance struct {
	ID               string             `json:"id"`
	Callsign         string             `json:"callsign"`
	Name             string             `json:"name"`
	Location         string             `json:"location"`
	Latitude         float64            `json:"latitude"`
	Longitude        float64            `json:"longitude"`
	Maidenhead       string             `json:"maidenhead"`
	Distance         float64            `json:"distance"`
	PublicURL        string             `json:"public_url"`
	Version          string             `json:"version"`
	CWSkimmer        bool               `json:"cw_skimmer"`
	DigitalDecodes   bool               `json:"digital_decodes"`
	NoiseFloor       bool               `json:"noise_floor"`
	MaxClients       int                `json:"max_clients"`
	AvailableClients int                `json:"available_clients"`
	MaxSessionTime   int                `json:"max_session_time"`
	PublicIQModes    []string           `json:"public_iq_modes"`
	CORSEnabled      bool               `json:"cors_enabled"`
	BandConditions   map[string]float64 `json:"band_conditions"`
	LastSeen         string             `json:"last_seen"`
}

// CollectorInstancesResponse represents the API response from /api/instances
type CollectorInstancesResponse struct {
	Count     int                 `json:"count"`
	Instances []CollectorInstance `json:"instances"`
}

// SpectrumResult represents a single result from /api/spectrum/freq
type SpectrumResult struct {
	PublicUUID    string   `json:"public_uuid"`
	Callsign      string   `json:"callsign"`
	Name          string   `json:"name"`
	Location      string   `json:"location"`
	Latitude      float64  `json:"latitude"`
	Longitude     float64  `json:"longitude"`
	PublicURL     string   `json:"public_url"`
	CORSEnabled   bool     `json:"cors_enabled"`
	TLS           bool     `json:"tls"`
	PublicIQModes []string `json:"public_iq_modes"`
	Maidenhead    string   `json:"maidenhead"`
	DistanceKm    float64  `json:"distance_km"`
	FreqHz        int64    `json:"freq_hz"`
	SignalDB      float64  `json:"signal_db"`
	NoiseFloorDB  float64  `json:"noise_floor_db"`
	SNRDB         float64  `json:"snr_db"`
	UpdatedAt     string   `json:"updated_at"`
}

// SpectrumFreqResponse represents the API response from /api/spectrum/freq
type SpectrumFreqResponse struct {
	TargetFreqHz  int64            `json:"target_freq_hz"`
	TargetFreqMhz float64          `json:"target_freq_mhz"`
	BandwidthHz   int              `json:"bandwidth_hz"`
	MinSNRDB      float64          `json:"min_snr_db"`
	Count         int              `json:"count"`
	Results       []SpectrumResult `json:"results"`
}

// NewSmartRoutingConfig creates a new smart routing configuration with cache
func NewSmartRoutingConfig() *SmartRoutingConfig {
	return &SmartRoutingConfig{
		cache: &InstanceCache{
			instances:   make([]CollectorInstance, 0),
			lastUpdated: time.Time{},
		},
		instanceUsage: make(map[string]int),
	}
}

// AcquireInstance marks an instance as in use (call when connecting)
func (src *SmartRoutingConfig) AcquireInstance(url string) {
	src.instanceUsageMux.Lock()
	defer src.instanceUsageMux.Unlock()
	src.instanceUsage[url]++
	log.Printf("SmartRouting: Instance %s now has %d active connection(s)", url, src.instanceUsage[url])
}

// ReleaseInstance marks an instance as no longer in use (call when disconnecting)
func (src *SmartRoutingConfig) ReleaseInstance(url string) {
	src.instanceUsageMux.Lock()
	defer src.instanceUsageMux.Unlock()
	if count, exists := src.instanceUsage[url]; exists && count > 0 {
		src.instanceUsage[url]--
		log.Printf("SmartRouting: Instance %s now has %d active connection(s)", url, src.instanceUsage[url])
		if src.instanceUsage[url] == 0 {
			delete(src.instanceUsage, url)
		}
	}
}

// GetInstanceUsage returns the current number of connections to an instance
func (src *SmartRoutingConfig) GetInstanceUsage(url string) int {
	src.instanceUsageMux.RLock()
	defer src.instanceUsageMux.RUnlock()
	return src.instanceUsage[url]
}

// GetBandForFrequency returns the ham band name for a given frequency
func GetBandForFrequency(frequency int64) string {
	for _, band := range StandardHamBands {
		if frequency >= band.MinFreq && frequency <= band.MaxFreq {
			return band.Name
		}
	}
	return ""
}

// compareInstances compares two instances based on the configured priority mode
// Returns true if instance i should be ranked higher than instance j
func (src *SmartRoutingConfig) compareInstances(snrI, distI, snrJ, distJ float64) bool {
	priorityMode := src.Behavior.PriorityMode
	if priorityMode == "" {
		priorityMode = "snr" // Default to SNR priority
	}

	switch priorityMode {
	case "distance":
		// Prioritize distance, use SNR as tiebreaker
		distDiff := distI - distJ
		if math.Abs(distDiff) > 50.0 { // More than 50 km difference
			return distI < distJ // Closer is better
		}
		// Distance is similar, compare SNR
		return snrI > snrJ

	case "balanced":
		// Balanced approach: significant SNR difference wins, otherwise prefer closer
		snrDiff := snrI - snrJ
		if math.Abs(snrDiff) > 5.0 { // More than 5 dB difference
			return snrI > snrJ
		}
		// SNR is similar, prefer closer
		return distI < distJ

	case "snr":
		fallthrough
	default:
		// Prioritize SNR, use distance as tiebreaker
		snrDiff := snrI - snrJ
		if math.Abs(snrDiff) > 1.0 { // More than 1 dB difference
			return snrI > snrJ
		}
		// SNR is similar, prefer closer if enabled
		if src.Behavior.PreferCloser {
			return distI < distJ
		}
		return false
	}
}

// GetURLForFrequency returns the best URL and password for a given frequency
// using smart routing based on band conditions and signal quality
// If reserve is true, it also reserves the instance (increments usage counter) to prevent race conditions
// excludeURL can be used to exclude a specific URL from selection (e.g., one that just failed)
func (src *SmartRoutingConfig) GetURLForFrequency(frequency int64, mode string, reserve bool, excludeURL string) (string, string, error) {
	if !src.Enabled {
		return src.DefaultURL, src.DefaultPassword, nil
	}

	// Check if requested mode matches required bandwidth
	if src.RequiredBandwidth != "" && mode != src.RequiredBandwidth {
		log.Printf("SmartRouting: Requested mode '%s' doesn't match required_bandwidth '%s', using default instance",
			mode, src.RequiredBandwidth)
		return src.DefaultURL, src.DefaultPassword, nil
	}

	// Check if we need to refresh the instance list
	src.queryMutex.RLock()
	needsRefresh := time.Since(src.lastQuery) > time.Duration(src.Behavior.CheckIntervalSeconds)*time.Second
	src.queryMutex.RUnlock()

	if needsRefresh {
		if err := src.refreshInstances(); err != nil {
			log.Printf("SmartRouting: Failed to refresh instances: %v, using default", err)
			return src.DefaultURL, src.DefaultPassword, nil
		}
	}

	// Determine which band this frequency is in
	band := GetBandForFrequency(frequency)
	if band == "" {
		log.Printf("SmartRouting: Frequency %d Hz not in standard ham bands, using default", frequency)
		return src.DefaultURL, src.DefaultPassword, nil
	}

	// Find best instance for this band
	instance := src.findAndReserveBestInstance(band, mode, frequency, reserve, excludeURL)
	if instance != nil {
		snr := instance.BandConditions[band]
		if reserve {
			log.Printf("SmartRouting: Selected %s (%s) for %d Hz (%s band, SNR: %.1f dB, distance: %.0f km)",
				instance.Callsign, instance.PublicURL, frequency, band, snr, instance.Distance)
		}
		return instance.PublicURL, "", nil
	}

	log.Printf("SmartRouting: No suitable instance found for %d Hz (%s band), using default", frequency, band)
	return src.DefaultURL, src.DefaultPassword, nil
}

// refreshInstances queries the collector API to update the instance list
func (src *SmartRoutingConfig) refreshInstances() error {
	src.queryMutex.Lock()
	defer src.queryMutex.Unlock()

	// Build query URL
	apiURL := fmt.Sprintf("%s/api/instances", src.CollectorAPIURL)
	params := url.Values{}
	params.Set("conditions", "true")
	params.Set("online_only", "true")

	// Add location filters
	if src.Location.Latitude != 0 && src.Location.Longitude != 0 {
		params.Set("lat", fmt.Sprintf("%.6f", src.Location.Latitude))
		params.Set("lon", fmt.Sprintf("%.6f", src.Location.Longitude))
		if src.Location.MaxDistanceKm > 0 {
			params.Set("max_dist", fmt.Sprintf("%.0f", src.Location.MaxDistanceKm))
		}
	}

	// Add bandwidth filter
	if src.RequiredBandwidth != "" {
		params.Set("bw_modes", src.RequiredBandwidth)
	}

	// Add other filters
	if src.Filters.CORSEnabled {
		params.Set("cors", "true")
	}
	if src.Filters.UnlimitedOnly {
		params.Set("unlimited_only", "true")
	}
	if src.Filters.MinSlots > 0 {
		params.Set("min_slots", fmt.Sprintf("%d", src.Filters.MinSlots))
	}

	fullURL := fmt.Sprintf("%s?%s", apiURL, params.Encode())
	log.Printf("SmartRouting: Querying instances: %s", fullURL)

	// Make HTTP request
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(fullURL)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var apiResp CollectorInstancesResponse
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	// Update cache
	src.cache.mutex.Lock()
	src.cache.instances = apiResp.Instances
	src.cache.lastUpdated = time.Now()
	src.cache.mutex.Unlock()

	src.lastQuery = time.Now()
	log.Printf("SmartRouting: Cached %d instances", len(apiResp.Instances))

	return nil
}

// findBestInstanceForFrequency uses the /api/spectrum/freq endpoint to find the best instance
func (src *SmartRoutingConfig) findBestInstanceForFrequency(frequency int64, mode string) (*SpectrumResult, error) {
	// Build query URL
	apiURL := fmt.Sprintf("%s/api/spectrum/freq", src.CollectorAPIURL)
	params := url.Values{}
	params.Set("freq", fmt.Sprintf("%d", frequency))
	params.Set("bw", "5000") // 5 kHz bandwidth for search

	// Add location filters
	if src.Location.Latitude != 0 && src.Location.Longitude != 0 {
		params.Set("lat", fmt.Sprintf("%.6f", src.Location.Latitude))
		params.Set("lon", fmt.Sprintf("%.6f", src.Location.Longitude))
		if src.Location.MaxDistanceKm > 0 {
			params.Set("max_dist", fmt.Sprintf("%.0f", src.Location.MaxDistanceKm))
		}
	}

	// Add bandwidth filter
	if src.RequiredBandwidth != "" {
		params.Set("bw_modes", src.RequiredBandwidth)
	}

	// Set minimum SNR based on switch threshold
	if src.Behavior.SwitchThresholdDB > 0 {
		params.Set("min_snr", fmt.Sprintf("%.1f", src.Behavior.SwitchThresholdDB))
	}

	fullURL := fmt.Sprintf("%s?%s", apiURL, params.Encode())

	// Make HTTP request
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(fullURL)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var apiResp SpectrumFreqResponse
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if len(apiResp.Results) == 0 {
		return nil, nil
	}

	// Sort results based on priority mode
	sort.Slice(apiResp.Results, func(i, j int) bool {
		return src.compareInstances(
			apiResp.Results[i].SNRDB, apiResp.Results[i].DistanceKm,
			apiResp.Results[j].SNRDB, apiResp.Results[j].DistanceKm,
		)
	})

	// Return the best instance
	return &apiResp.Results[0], nil
}

// findAndReserveBestInstance finds the best instance for a given band and optionally reserves it
// excludeURL can be used to exclude a specific URL from selection (e.g., one that just failed)
func (src *SmartRoutingConfig) findAndReserveBestInstance(band string, mode string, frequency int64, reserve bool, excludeURL string) *CollectorInstance {
	src.cache.mutex.RLock()
	defer src.cache.mutex.RUnlock()

	if len(src.cache.instances) == 0 {
		log.Printf("SmartRouting: No instances in cache for %d Hz (%s band)", frequency, band)
		return nil
	}

	// Set default max connections if not specified
	maxConnections := src.MaxConnectionsPerInstance
	if maxConnections == 0 {
		maxConnections = 1 // Default to 1 connection per instance
	}

	log.Printf("SmartRouting: Finding best instance for %d Hz (%s band) from %d cached instances",
		frequency, band, len(src.cache.instances))

	// Filter instances that have the required bandwidth mode and available capacity
	var candidates []CollectorInstance
	var filteredCount int
	for _, inst := range src.cache.instances {
		// Check if instance supports the required mode
		if src.RequiredBandwidth != "" {
			hasMode := false
			for _, m := range inst.PublicIQModes {
				if m == src.RequiredBandwidth {
					hasMode = true
					break
				}
			}
			if !hasMode {
				filteredCount++
				continue
			}
		}

		// Check if instance has band condition data
		if snr, ok := inst.BandConditions[band]; ok && snr > 0 {
			// Check if this instance should be excluded (e.g., just failed)
			if excludeURL != "" && inst.PublicURL == excludeURL {
				log.Printf("SmartRouting:   Skipped (excluded - previous failure): %s (%s)",
					inst.Callsign, inst.PublicURL)
				continue
			}

			// Check if SNR meets minimum requirement
			if src.Behavior.MinSNRDB > 0 && snr < src.Behavior.MinSNRDB {
				log.Printf("SmartRouting:   Skipped (SNR too low): %s (%s) - SNR: %.1f dB < %.1f dB minimum",
					inst.Callsign, inst.PublicURL, snr, src.Behavior.MinSNRDB)
				continue
			}

			// Check if instance has available capacity (must hold lock to prevent race)
			src.instanceUsageMux.RLock()
			currentUsage := src.instanceUsage[inst.PublicURL]
			src.instanceUsageMux.RUnlock()
			if currentUsage < maxConnections {
				candidates = append(candidates, inst)
				log.Printf("SmartRouting:   Candidate: %s (%s) - SNR: %.1f dB, distance: %.0f km, usage: %d/%d",
					inst.Callsign, inst.PublicURL, snr, inst.Distance, currentUsage, maxConnections)
			} else {
				log.Printf("SmartRouting:   Skipped (at capacity): %s (%s) - usage: %d/%d",
					inst.Callsign, inst.PublicURL, currentUsage, maxConnections)
			}
		}
	}

	if filteredCount > 0 {
		log.Printf("SmartRouting: Filtered out %d instances (bandwidth mismatch)", filteredCount)
	}

	if len(candidates) == 0 {
		log.Printf("SmartRouting: No available instances found for %s band", band)
		return nil
	}

	log.Printf("SmartRouting: Found %d candidate(s) for %s band, sorting by priority_mode: %s",
		len(candidates), band, src.Behavior.PriorityMode)

	// Sort candidates based on priority mode
	sort.Slice(candidates, func(i, j int) bool {
		snrI := candidates[i].BandConditions[band]
		snrJ := candidates[j].BandConditions[band]
		return src.compareInstances(snrI, candidates[i].Distance, snrJ, candidates[j].Distance)
	})

	// Optionally reserve the best instance
	bestInstance := &candidates[0]
	if reserve {
		src.instanceUsageMux.Lock()
		src.instanceUsage[bestInstance.PublicURL]++
		log.Printf("SmartRouting: Reserved instance %s (now has %d active connection(s))",
			bestInstance.PublicURL, src.instanceUsage[bestInstance.PublicURL])
		src.instanceUsageMux.Unlock()
	}

	return bestInstance
}
