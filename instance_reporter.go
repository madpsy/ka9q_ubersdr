package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/shirou/gopsutil/v3/cpu"
	"gopkg.in/yaml.v3"
)

// InstanceReporter handles reporting instance information to central server
type InstanceReporter struct {
	config              *Config
	cwskimmerConfig     *CWSkimmerConfig
	sessions            *SessionManager
	dxClusterWsHandler  *DXClusterWebSocketHandler // For getting chat user count
	noiseFloorMonitor   *NoiseFloorMonitor         // For getting SNR measurements
	rotctlHandler       *RotctlAPIHandler          // For getting rotator information
	freqRefMonitor      *FrequencyReferenceMonitor // For getting frequency reference information
	configPath          string
	httpClient          *http.Client
	stopChan            chan struct{}
	lastResponseCode    int          // Last HTTP response code from collector
	lastResponseStatus  string       // Last 'status' field from JSON response
	lastResponseMessage string       // Last 'message' field from JSON response
	lastPublicUUID      string       // Last 'public_uuid' field from JSON response
	lastReportTime      time.Time    // Time of last report attempt
	lastReportError     string       // Last error message if any
	detectedPublicIP    string       // Auto-detected public IP (when use_myip is true)
	mu                  sync.RWMutex // Protects the above fields
}

// InstanceReport represents the data sent to the central server
type InstanceReport struct {
	UUID               string                 `json:"uuid"`
	Callsign           string                 `json:"callsign"`
	Name               string                 `json:"name"`
	Email              string                 `json:"email"` // Admin email address (private, for Let's Encrypt)
	Location           string                 `json:"location"`
	Latitude           float64                `json:"latitude"`
	Longitude          float64                `json:"longitude"`
	Altitude           int                    `json:"altitude"`
	PublicURL          string                 `json:"public_url"`
	Version            string                 `json:"version"`
	Timestamp          int64                  `json:"timestamp"`
	Host               string                 `json:"host,omitempty"`      // Optional: tells clients how to connect to this instance
	Port               int                    `json:"port,omitempty"`      // Optional: port for client connections
	TLS                bool                   `json:"tls,omitempty"`       // Optional: whether TLS is required for connections
	UseMyIP            bool                   `json:"use_myip"`            // Automatically use public IP for public access
	CreateDomain       bool                   `json:"create_domain"`       // Request automatic DNS subdomain creation
	CWSkimmer          bool                   `json:"cw_skimmer"`          // Whether CW Skimmer is enabled
	DigitalDecodes     bool                   `json:"digital_decodes"`     // Whether digital decoding is enabled
	NoiseFloor         bool                   `json:"noise_floor"`         // Whether noise floor monitoring is enabled
	MaxClients         int                    `json:"max_clients"`         // Maximum number of clients allowed
	AvailableClients   int                    `json:"available_clients"`   // Current number of available client slots
	MaxSessionTime     int                    `json:"max_session_time"`    // Maximum session time in seconds (0 = unlimited)
	PublicIQModes      []string               `json:"public_iq_modes"`     // List of IQ modes accessible without authentication
	CPUModel           string                 `json:"cpu_model"`           // CPU model name
	Load               map[string]interface{} `json:"load,omitempty"`      // System load averages, CPU cores, and status
	CORSEnabled        bool                   `json:"cors_enabled"`        // Whether CORS is enabled
	ChatEnabled        bool                   `json:"chat_enabled"`        // Whether chat is enabled
	ChatUsers          int                    `json:"chat_users"`          // Number of active chat users
	SNR_0_30MHz        int                    `json:"snr_0_30_mhz"`        // SNR for 0-30 MHz (dynamic range in dB, -1 if unavailable)
	SNR_1_8_30MHz      int                    `json:"snr_1_8_30_mhz"`      // SNR for 1.8-30 MHz HF bands (dynamic range in dB, -1 if unavailable)
	Rotator            map[string]interface{} `json:"rotator"`             // Rotator information (enabled, connected, azimuth)
	FrequencyReference map[string]interface{} `json:"frequency_reference"` // Frequency reference tracking information
	Test               bool                   `json:"test,omitempty"`      // If true, this is a test report - collector will verify /api/description instead of full callback
	StartupReport      bool                   `json:"startup_report"`      // If true, this is a startup report sent regardless of instance_reporting.enabled
}

// NewInstanceReporter creates a new instance reporter
func NewInstanceReporter(config *Config, cwskimmerConfig *CWSkimmerConfig, sessions *SessionManager, configPath string) *InstanceReporter {
	return &InstanceReporter{
		config:          config,
		cwskimmerConfig: cwskimmerConfig,
		sessions:        sessions,
		configPath:      configPath,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					MinVersion: tls.VersionTLS12,
				},
			},
			// Don't follow redirects - we want to see the actual response
			// This prevents POST being changed to GET on redirects
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		stopChan: make(chan struct{}),
	}
}

// SetDXClusterWebSocketHandler sets the DX cluster websocket handler for chat user count
// This must be called after the handler is initialized (after NewInstanceReporter)
func (ir *InstanceReporter) SetDXClusterWebSocketHandler(handler *DXClusterWebSocketHandler) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	ir.dxClusterWsHandler = handler
}

// SetNoiseFloorMonitor sets the noise floor monitor for SNR measurements
// This must be called after the monitor is initialized (after NewInstanceReporter)
func (ir *InstanceReporter) SetNoiseFloorMonitor(monitor *NoiseFloorMonitor) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	ir.noiseFloorMonitor = monitor
}

// SetRotctlHandler sets the rotctl handler for rotator information
// This must be called after the handler is initialized (after NewInstanceReporter)
func (ir *InstanceReporter) SetRotctlHandler(handler *RotctlAPIHandler) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	ir.rotctlHandler = handler
}

// SetFrequencyReferenceMonitor sets the frequency reference monitor for tracking information
// This must be called after the monitor is initialized (after NewInstanceReporter)
func (ir *InstanceReporter) SetFrequencyReferenceMonitor(monitor *FrequencyReferenceMonitor) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	ir.freqRefMonitor = monitor
}

// getChatUserCount returns the current number of active chat users (thread-safe)
func (ir *InstanceReporter) getChatUserCount() int {
	ir.mu.RLock()
	handler := ir.dxClusterWsHandler
	ir.mu.RUnlock()

	if handler == nil {
		return 0
	}
	return handler.GetChatUserCount()
}

// getSNRMeasurements returns the current wideband SNR measurements (thread-safe)
// Returns -1 for both values if noise floor monitor is not available or no data yet
func (ir *InstanceReporter) getSNRMeasurements() (int, int) {
	ir.mu.RLock()
	monitor := ir.noiseFloorMonitor
	ir.mu.RUnlock()

	if monitor == nil {
		return -1, -1
	}

	snr_0_30, snr_1_8_30 := monitor.GetWidebandSNR()
	return int(snr_0_30), int(snr_1_8_30)
}

// getRotatorInfo returns the current rotator information (thread-safe)
func (ir *InstanceReporter) getRotatorInfo() map[string]interface{} {
	ir.mu.RLock()
	handler := ir.rotctlHandler
	ir.mu.RUnlock()

	rotatorInfo := map[string]interface{}{
		"enabled":   false,
		"connected": false,
		"azimuth":   -1,
	}

	if handler != nil && ir.config.Rotctl.Enabled {
		rotatorInfo["enabled"] = true
		rotatorInfo["connected"] = handler.controller.client.IsConnected()
		state := handler.controller.GetState()
		rotatorInfo["azimuth"] = int(state.Position.Azimuth + 0.5) // Round to nearest integer
	}

	return rotatorInfo
}

// getFrequencyReferenceInfo returns the current frequency reference information (thread-safe)
// Always returns an object with enabled field, plus tracking data if enabled
func (ir *InstanceReporter) getFrequencyReferenceInfo() map[string]interface{} {
	ir.mu.RLock()
	monitor := ir.freqRefMonitor
	ir.mu.RUnlock()

	if monitor == nil {
		return map[string]interface{}{
			"enabled": false,
		}
	}

	// Get status from monitor
	freqRefStatus := monitor.GetStatus()

	// Build filtered frequency reference info with only essential fields
	freqRefInfo := map[string]interface{}{
		"enabled": freqRefStatus["enabled"],
	}

	// Only include additional fields if enabled
	if enabled, ok := freqRefStatus["enabled"].(bool); ok && enabled {
		freqRefInfo["expected_frequency"] = freqRefStatus["expected_frequency"]
		freqRefInfo["detected_frequency"] = freqRefStatus["detected_frequency"]
		freqRefInfo["frequency_offset"] = freqRefStatus["frequency_offset"]
		freqRefInfo["signal_strength"] = freqRefStatus["signal_strength"]
		freqRefInfo["snr"] = freqRefStatus["snr"]
		freqRefInfo["noise_floor"] = freqRefStatus["noise_floor"]
	}

	return freqRefInfo
}

// Start begins the instance reporting service
func (ir *InstanceReporter) Start() error {
	if !ir.config.InstanceReporting.Enabled {
		log.Println("Instance reporting is disabled")
		return nil
	}

	// Generate UUID if not present
	if err := ir.ensureUUID(); err != nil {
		return fmt.Errorf("failed to ensure UUID: %w", err)
	}

	log.Printf("Instance reporting enabled - UUID: %s", ir.config.InstanceReporting.InstanceUUID)
	log.Printf("Reporting to: https://%s:%d",
		ir.config.InstanceReporting.Hostname,
		ir.config.InstanceReporting.Port)

	// Start reporting goroutine
	go ir.reportLoop()

	return nil
}

// Stop stops the instance reporting service
func (ir *InstanceReporter) Stop() {
	close(ir.stopChan)
}

// ensureUUID generates and persists a UUID if one doesn't exist
func (ir *InstanceReporter) ensureUUID() error {
	// If UUID already exists, nothing to do
	if ir.config.InstanceReporting.InstanceUUID != "" {
		return nil
	}

	// Generate new UUID
	newUUID := uuid.New().String()
	ir.config.InstanceReporting.InstanceUUID = newUUID

	// Save to config file
	if err := ir.saveUUIDToConfig(newUUID); err != nil {
		return fmt.Errorf("failed to save UUID to config: %w", err)
	}

	log.Printf("Generated new instance UUID: %s", newUUID)
	return nil
}

// saveUUIDToConfig saves the UUID back to the config file
func (ir *InstanceReporter) saveUUIDToConfig(uuid string) error {
	// Read current config file
	data, err := os.ReadFile(ir.configPath)
	if err != nil {
		return fmt.Errorf("failed to read config file: %w", err)
	}

	// Parse as generic map to preserve structure and comments
	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		return fmt.Errorf("failed to parse config: %w", err)
	}

	// Update instance_reporting section
	if instanceReporting, ok := configMap["instance_reporting"].(map[string]interface{}); ok {
		instanceReporting["instance_uuid"] = uuid
	} else {
		// Create section if it doesn't exist
		configMap["instance_reporting"] = map[string]interface{}{
			"enabled":             true,
			"hostname":            ir.config.InstanceReporting.Hostname,
			"port":                ir.config.InstanceReporting.Port,
			"report_interval_sec": ir.config.InstanceReporting.ReportIntervalSec,
			"instance_uuid":       uuid,
		}
	}

	// Marshal back to YAML
	updatedData, err := yaml.Marshal(configMap)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	// Write back to file
	// Create backup first
	backupPath := ir.configPath + ".bak"
	if err := os.WriteFile(backupPath, data, 0644); err != nil {
		log.Printf("Warning: failed to create config backup: %v", err)
	}

	if err := os.WriteFile(ir.configPath, updatedData, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}

// reportLoop periodically sends instance information to the central server
func (ir *InstanceReporter) reportLoop() {
	// Send initial report immediately
	if err := ir.sendReport(); err != nil {
		log.Printf("Failed to send initial instance report: %v", err)
	}

	ticker := time.NewTicker(time.Duration(ir.config.InstanceReporting.ReportIntervalSec) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := ir.sendReport(); err != nil {
				log.Printf("Failed to send instance report: %v", err)
			}
		case <-ir.stopChan:
			log.Println("Instance reporter stopped")
			return
		}
	}
}

// getCPUInfo retrieves CPU model and core count information (wrapper for helper function)
func (ir *InstanceReporter) getCPUInfo() (string, int) {
	return getCPUInfo()
}

// getSystemLoad retrieves system load averages and calculates status (wrapper for helper function)
func (ir *InstanceReporter) getSystemLoad() map[string]interface{} {
	return getSystemLoad()
}

// getPublicIP fetches the public IP address from the collector's /api/myip endpoint
func (ir *InstanceReporter) getPublicIP() (string, error) {
	// Build URL with http or https based on config
	protocol := "https"
	defaultPort := 443
	if !ir.config.InstanceReporting.UseHTTPS {
		protocol = "http"
		defaultPort = 80
	}

	// Build the /api/myip URL
	var url string
	if ir.config.InstanceReporting.Port == defaultPort {
		url = fmt.Sprintf("%s://%s/api/myip",
			protocol,
			ir.config.InstanceReporting.Hostname)
	} else {
		url = fmt.Sprintf("%s://%s:%d/api/myip",
			protocol,
			ir.config.InstanceReporting.Hostname,
			ir.config.InstanceReporting.Port)
	}

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))

	resp, err := ir.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to fetch public IP from %s: %w", url, err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("[Instance Reporter] Error closing response body: %v", err)
		}
	}()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server returned status %d when fetching public IP", resp.StatusCode)
	}

	// Parse the JSON response
	var responseData map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	ip, ok := responseData["ip"].(string)
	if !ok || ip == "" {
		return "", fmt.Errorf("no IP address in response")
	}

	log.Printf("Fetched public IP from collector: %s", ip)
	return ip, nil
}

// sendReport sends the current instance information to the central server
// Retries up to 3 times with 10 second delays between attempts
func (ir *InstanceReporter) sendReport() error {
	// Update last report time
	ir.mu.Lock()
	ir.lastReportTime = time.Now()
	ir.mu.Unlock()

	// If use_myip is enabled, fetch the public IP from the collector
	host := ir.config.InstanceReporting.Instance.Host
	if ir.config.InstanceReporting.UseMyIP {
		publicIP, err := ir.getPublicIP()
		if err != nil {
			log.Printf("Failed to fetch public IP (will use configured host): %v", err)
			// Fall back to configured host if fetching fails
		} else {
			host = publicIP
			log.Printf("Using auto-detected public IP: %s", host)
			// Store the detected IP for use in public_url construction
			ir.mu.Lock()
			ir.detectedPublicIP = publicIP
			ir.mu.Unlock()
		}
	}
	// Get capability information directly from config (no HTTP call needed)
	cwSkimmerEnabled := false
	if ir.cwskimmerConfig != nil {
		cwSkimmerEnabled = ir.cwskimmerConfig.Enabled
	}

	// Calculate available client slots (max - current non-bypassed users)
	currentNonBypassedUsers := ir.sessions.GetNonBypassedUserCount()
	availableClients := ir.config.Server.MaxSessions - currentNonBypassedUsers
	if availableClients < 0 {
		availableClients = 0
	}

	log.Printf("Reporting capabilities: CW=%v, Digital=%v, Noise=%v, MaxClients=%d, AvailableClients=%d",
		cwSkimmerEnabled, ir.config.Decoder.Enabled, ir.config.NoiseFloor.Enabled, ir.config.Server.MaxSessions, availableClients)

	// Build list of public IQ modes
	publicIQModes := []string{}
	for mode, isPublic := range ir.config.Server.PublicIQModes {
		if isPublic {
			publicIQModes = append(publicIQModes, mode)
		}
	}

	// Construct public_url from instance connection info using effective host
	publicURL := ir.config.InstanceReporting.ConstructPublicURL(ir.GetEffectiveHost())

	// Get CPU information
	cpuModel, _ := ir.getCPUInfo()

	// Get system load information (includes CPU cores)
	systemLoad := ir.getSystemLoad()

	// Get chat user count (thread-safe)
	chatUserCount := ir.getChatUserCount()

	// Get SNR measurements (thread-safe)
	snr_0_30, snr_1_8_30 := ir.getSNRMeasurements()

	// Get rotator information (thread-safe)
	rotatorInfo := ir.getRotatorInfo()

	// Get frequency reference information (thread-safe)
	freqRefInfo := ir.getFrequencyReferenceInfo()

	report := InstanceReport{
		UUID:               ir.config.InstanceReporting.InstanceUUID,
		Callsign:           ir.config.Admin.Callsign,
		Name:               ir.config.Admin.Name,
		Email:              ir.config.Admin.Email,
		Location:           ir.config.Admin.Location,
		Latitude:           ir.config.Admin.GPS.Lat,
		Longitude:          ir.config.Admin.GPS.Lon,
		Altitude:           ir.config.Admin.ASL,
		PublicURL:          publicURL,
		Version:            Version,
		Timestamp:          time.Now().Unix(),
		Host:               host, // Use the host variable (either configured or auto-detected)
		Port:               ir.config.InstanceReporting.Instance.Port,
		TLS:                ir.config.InstanceReporting.Instance.TLS,
		UseMyIP:            ir.config.InstanceReporting.UseMyIP,
		CreateDomain:       ir.config.InstanceReporting.CreateDomain,
		CWSkimmer:          cwSkimmerEnabled,
		DigitalDecodes:     ir.config.Decoder.Enabled,
		NoiseFloor:         ir.config.NoiseFloor.Enabled,
		MaxClients:         ir.config.Server.MaxSessions,
		AvailableClients:   availableClients,
		MaxSessionTime:     ir.config.Server.MaxSessionTime,
		PublicIQModes:      publicIQModes,
		CPUModel:           cpuModel,
		Load:               systemLoad,
		CORSEnabled:        ir.config.Server.EnableCORS,
		ChatEnabled:        ir.config.Chat.Enabled,
		ChatUsers:          chatUserCount,
		SNR_0_30MHz:        snr_0_30,
		SNR_1_8_30MHz:      snr_1_8_30,
		Rotator:            rotatorInfo,
		FrequencyReference: freqRefInfo,
	}

	jsonData, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("failed to marshal report: %w", err)
	}

	// Build URL with http or https based on config
	protocol := "https"
	defaultPort := 443
	if !ir.config.InstanceReporting.UseHTTPS {
		protocol = "http"
		defaultPort = 80
	}

	// Don't include port in URL if it's the default port for the protocol
	// This ensures the Host header doesn't include the port, which can cause routing issues
	var url string
	if ir.config.InstanceReporting.Port == defaultPort {
		url = fmt.Sprintf("%s://%s/api/instance/%s",
			protocol,
			ir.config.InstanceReporting.Hostname,
			ir.config.InstanceReporting.InstanceUUID)
	} else {
		url = fmt.Sprintf("%s://%s:%d/api/instance/%s",
			protocol,
			ir.config.InstanceReporting.Hostname,
			ir.config.InstanceReporting.Port,
			ir.config.InstanceReporting.InstanceUUID)
	}

	// Retry up to 3 times with 10 second delays
	maxRetries := 3
	retryDelay := 10 * time.Second

	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
		if err != nil {
			return fmt.Errorf("failed to create request: %w", err)
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))

		resp, err := ir.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("failed to send request to %s (attempt %d/%d): %w", url, attempt, maxRetries, err)
			log.Printf("%v", lastErr)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return lastErr
		}
		defer func() {
			if err := resp.Body.Close(); err != nil {
				log.Printf("[Instance Reporter] Error closing response body: %v", err)
			}
		}()

		// Check for redirect responses
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			lastErr = fmt.Errorf("server returned redirect %d to %s for %s (attempt %d/%d)", resp.StatusCode, location, url, attempt, maxRetries)
			log.Printf("%v", lastErr)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return lastErr
		}

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			lastErr = fmt.Errorf("server returned status %d for %s (attempt %d/%d)", resp.StatusCode, url, attempt, maxRetries)
			log.Printf("%v", lastErr)

			// Store error response
			ir.mu.Lock()
			ir.lastResponseCode = resp.StatusCode
			ir.lastResponseStatus = ""
			ir.lastReportError = lastErr.Error()
			ir.mu.Unlock()

			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}

			return lastErr
		}

		// Parse the response to get the status, message, and public_uuid fields
		var responseData map[string]interface{}
		responseStatus := ""
		responseMessage := ""
		publicUUID := ""
		if err := json.NewDecoder(resp.Body).Decode(&responseData); err == nil {
			if status, ok := responseData["status"].(string); ok {
				responseStatus = status
			}
			if message, ok := responseData["message"].(string); ok {
				responseMessage = message
			}
			if pubUUID, ok := responseData["public_uuid"].(string); ok {
				publicUUID = pubUUID
			}
		}

		// Store successful response
		ir.mu.Lock()
		ir.lastResponseCode = resp.StatusCode
		ir.lastResponseStatus = responseStatus
		ir.lastResponseMessage = responseMessage
		ir.lastPublicUUID = publicUUID
		ir.lastReportError = ""
		ir.mu.Unlock()

		log.Printf("Successfully reported instance to %s (status: %d, attempt: %d)", url, resp.StatusCode, attempt)
		return nil
	}

	// Store final error if all retries failed
	if lastErr != nil {
		ir.mu.Lock()
		ir.lastReportError = lastErr.Error()
		ir.mu.Unlock()
	}

	return lastErr
}

// GetReportStatus returns the current instance reporting status
func (ir *InstanceReporter) GetReportStatus() map[string]interface{} {
	ir.mu.RLock()
	defer ir.mu.RUnlock()

	status := map[string]interface{}{
		"enabled":               ir.config.InstanceReporting.Enabled,
		"hostname":              ir.config.InstanceReporting.Hostname,
		"last_response_code":    ir.lastResponseCode,
		"last_response_status":  ir.lastResponseStatus,
		"last_response_message": ir.lastResponseMessage,
		"public_uuid":           ir.lastPublicUUID,
		"last_report_error":     ir.lastReportError,
	}

	if !ir.lastReportTime.IsZero() {
		status["last_report_time"] = ir.lastReportTime.Format(time.RFC3339)
		status["seconds_since_last_report"] = int(time.Since(ir.lastReportTime).Seconds())
	}

	return status
}

// GetEffectiveHost returns the host to use for public access
// If use_myip is enabled and a public IP has been detected, returns that
// Otherwise returns the configured host
func (ir *InstanceReporter) GetEffectiveHost() string {
	ir.mu.RLock()
	defer ir.mu.RUnlock()

	if ir.config.InstanceReporting.UseMyIP && ir.detectedPublicIP != "" {
		return ir.detectedPublicIP
	}
	return ir.config.InstanceReporting.Instance.Host
}

// TriggerReport manually triggers an immediate instance report
// This is called by the admin API endpoint to force a report
func (ir *InstanceReporter) TriggerReport() error {
	if !ir.config.InstanceReporting.Enabled {
		return fmt.Errorf("instance reporting is not enabled")
	}

	// Send the report immediately
	return ir.sendReport()
}

// TriggerReportWithParams manually triggers an immediate instance report with optional parameter overrides
// This is called by the admin API endpoint to test configuration before saving
// If testParams is nil, behaves exactly like TriggerReport()
func (ir *InstanceReporter) TriggerReportWithParams(testParams map[string]interface{}) error {
	// If no test parameters, use normal report
	if testParams == nil {
		return ir.TriggerReport()
	}

	// Send report with parameter overrides
	return ir.sendReportWithParams(testParams)
}

// sendReportWithParams sends a report with optional parameter overrides for testing
// This allows testing configuration without modifying the actual config
func (ir *InstanceReporter) sendReportWithParams(testParams map[string]interface{}) error {
	// Update last report time
	ir.mu.Lock()
	ir.lastReportTime = time.Now()
	ir.mu.Unlock()

	// Extract test parameters with fallbacks to current config
	useMyIP := ir.config.InstanceReporting.UseMyIP
	if val, ok := testParams["use_myip"].(bool); ok {
		useMyIP = val
	}

	instanceHost := ir.config.InstanceReporting.Instance.Host
	if val, ok := testParams["instance_host"].(string); ok && val != "" {
		instanceHost = val
	}

	instancePort := ir.config.InstanceReporting.Instance.Port
	if val, ok := testParams["instance_port"].(float64); ok {
		instancePort = int(val)
	} else if val, ok := testParams["instance_port"].(int); ok {
		instancePort = val
	}

	instanceTLS := ir.config.InstanceReporting.Instance.TLS
	if val, ok := testParams["instance_tls"].(bool); ok {
		instanceTLS = val
	}

	instanceUUID := ir.config.InstanceReporting.InstanceUUID
	if val, ok := testParams["instance_uuid"].(string); ok && val != "" {
		instanceUUID = val
	}

	createDomain := ir.config.InstanceReporting.CreateDomain
	if val, ok := testParams["create_domain"].(bool); ok {
		createDomain = val
	}

	// Extract admin overrides if provided
	adminCallsign := ir.config.Admin.Callsign
	if val, ok := testParams["admin_callsign"].(string); ok && val != "" {
		adminCallsign = val
	}

	adminEmail := ir.config.Admin.Email
	if val, ok := testParams["admin_email"].(string); ok && val != "" {
		adminEmail = val
	}

	// This is a test report
	isTest := true

	// If use_myip is enabled, fetch the public IP from the collector
	host := instanceHost
	if useMyIP {
		publicIP, err := ir.getPublicIP()
		if err != nil {
			log.Printf("Failed to fetch public IP (will use configured host): %v", err)
			// Fall back to configured host if fetching fails
		} else {
			host = publicIP
			log.Printf("Using auto-detected public IP: %s", host)
		}
	}

	// Get capability information directly from config (no HTTP call needed)
	cwSkimmerEnabled := false
	if ir.cwskimmerConfig != nil {
		cwSkimmerEnabled = ir.cwskimmerConfig.Enabled
	}

	// Calculate available client slots (max - current non-bypassed users)
	currentNonBypassedUsers := ir.sessions.GetNonBypassedUserCount()
	availableClients := ir.config.Server.MaxSessions - currentNonBypassedUsers
	if availableClients < 0 {
		availableClients = 0
	}

	log.Printf("Testing with parameters: UseMyIP=%v, Host=%s, Port=%d, TLS=%v, UUID=%s",
		useMyIP, host, instancePort, instanceTLS, instanceUUID)

	// Build list of public IQ modes
	publicIQModes := []string{}
	for mode, isPublic := range ir.config.Server.PublicIQModes {
		if isPublic {
			publicIQModes = append(publicIQModes, mode)
		}
	}

	// Construct public_url from test parameters
	protocol := "http"
	if instanceTLS {
		protocol = "https"
	}
	publicURL := fmt.Sprintf("%s://%s:%d", protocol, host, instancePort)

	// Get CPU information
	cpuModel, _ := ir.getCPUInfo()

	// Get system load information (includes CPU cores)
	systemLoad := ir.getSystemLoad()

	// Get chat user count (thread-safe)
	chatUserCount := ir.getChatUserCount()

	// Get SNR measurements (thread-safe)
	snr_0_30, snr_1_8_30 := ir.getSNRMeasurements()

	// Get rotator information (thread-safe)
	rotatorInfo := ir.getRotatorInfo()

	// Get frequency reference information (thread-safe)
	freqRefInfo := ir.getFrequencyReferenceInfo()

	report := InstanceReport{
		UUID:               instanceUUID,
		Callsign:           adminCallsign,
		Name:               ir.config.Admin.Name,
		Email:              adminEmail,
		Location:           ir.config.Admin.Location,
		Latitude:           ir.config.Admin.GPS.Lat,
		Longitude:          ir.config.Admin.GPS.Lon,
		Altitude:           ir.config.Admin.ASL,
		PublicURL:          publicURL,
		Version:            Version,
		Timestamp:          time.Now().Unix(),
		Host:               host,
		Port:               instancePort,
		TLS:                instanceTLS,
		UseMyIP:            useMyIP,
		CreateDomain:       createDomain,
		CWSkimmer:          cwSkimmerEnabled,
		DigitalDecodes:     ir.config.Decoder.Enabled,
		NoiseFloor:         ir.config.NoiseFloor.Enabled,
		MaxClients:         ir.config.Server.MaxSessions,
		AvailableClients:   availableClients,
		MaxSessionTime:     ir.config.Server.MaxSessionTime,
		PublicIQModes:      publicIQModes,
		CPUModel:           cpuModel,
		Load:               systemLoad,
		CORSEnabled:        ir.config.Server.EnableCORS,
		ChatEnabled:        ir.config.Chat.Enabled,
		ChatUsers:          chatUserCount,
		SNR_0_30MHz:        snr_0_30,
		SNR_1_8_30MHz:      snr_1_8_30,
		Rotator:            rotatorInfo,
		FrequencyReference: freqRefInfo,
		Test:               isTest,
	}

	jsonData, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("failed to marshal report: %w", err)
	}

	// Build URL with http or https based on config
	protocol = "https"
	defaultPort := 443
	if !ir.config.InstanceReporting.UseHTTPS {
		protocol = "http"
		defaultPort = 80
	}

	// Build the URL using the test UUID
	var url string
	if ir.config.InstanceReporting.Port == defaultPort {
		url = fmt.Sprintf("%s://%s/api/instance/%s",
			protocol,
			ir.config.InstanceReporting.Hostname,
			instanceUUID)
	} else {
		url = fmt.Sprintf("%s://%s:%d/api/instance/%s",
			protocol,
			ir.config.InstanceReporting.Hostname,
			ir.config.InstanceReporting.Port,
			instanceUUID)
	}

	// Single attempt for testing (no retries)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))

	// Create a custom HTTP client with longer timeout for test requests
	// The collector may take up to 30+ seconds to verify the instance (3 retries × 10s each)
	// so we need a 60-second timeout to allow it to complete and return the error message
	testClient := &http.Client{
		Timeout: 60 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
			},
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := testClient.Do(req)
	if err != nil {
		lastErr := fmt.Errorf("failed to send test request to %s: %w", url, err)
		ir.mu.Lock()
		ir.lastReportError = lastErr.Error()
		ir.mu.Unlock()
		return lastErr
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("[Instance Reporter] Error closing response body: %v", err)
		}
	}()

	// Check for redirect responses
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		location := resp.Header.Get("Location")
		lastErr := fmt.Errorf("server returned redirect %d to %s for %s", resp.StatusCode, location, url)
		ir.mu.Lock()
		ir.lastResponseCode = resp.StatusCode
		ir.lastReportError = lastErr.Error()
		ir.mu.Unlock()
		return lastErr
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		// Try to parse error response from collector
		var responseData map[string]interface{}
		collectorMessage := ""
		if err := json.NewDecoder(resp.Body).Decode(&responseData); err == nil {
			if message, ok := responseData["message"].(string); ok {
				collectorMessage = message
			}
		}

		// Build error message with collector's response if available
		var lastErr error
		if collectorMessage != "" {
			lastErr = fmt.Errorf("server returned status %d: %s", resp.StatusCode, collectorMessage)
		} else {
			lastErr = fmt.Errorf("server returned status %d for %s", resp.StatusCode, url)
		}

		ir.mu.Lock()
		ir.lastResponseCode = resp.StatusCode
		ir.lastResponseStatus = ""
		ir.lastReportError = lastErr.Error()
		ir.mu.Unlock()
		return lastErr
	}

	// Parse the response to get the status, message, and public_uuid fields
	var responseData map[string]interface{}
	responseStatus := ""
	responseMessage := ""
	publicUUID := ""
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err == nil {
		if status, ok := responseData["status"].(string); ok {
			responseStatus = status
		}
		if message, ok := responseData["message"].(string); ok {
			responseMessage = message
		}
		if pubUUID, ok := responseData["public_uuid"].(string); ok {
			publicUUID = pubUUID
		}
	}

	// Store successful response
	ir.mu.Lock()
	ir.lastResponseCode = resp.StatusCode
	ir.lastResponseStatus = responseStatus
	ir.lastResponseMessage = responseMessage
	ir.lastPublicUUID = publicUUID
	ir.lastReportError = ""
	ir.mu.Unlock()

	log.Printf("Successfully tested instance report to %s (status: %d)", url, resp.StatusCode)
	return nil
}

// ensureUUIDForStartup generates and persists a UUID if one doesn't exist (for startup report)
// This is a standalone function that doesn't require an InstanceReporter instance
func ensureUUIDForStartup(config *Config, configPath string) error {
	// If UUID already exists, nothing to do
	if config.InstanceReporting.InstanceUUID != "" {
		return nil
	}

	// Generate new UUID
	newUUID := uuid.New().String()

	// Read current config file
	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("failed to read config file: %w", err)
	}

	// Parse as generic map to preserve structure and comments
	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		return fmt.Errorf("failed to parse config: %w", err)
	}

	// Update instance_reporting section
	if instanceReporting, ok := configMap["instance_reporting"].(map[string]interface{}); ok {
		// Double-check that instance_uuid doesn't already exist in the file
		if existingUUID, exists := instanceReporting["instance_uuid"]; exists && existingUUID != nil && existingUUID != "" {
			// UUID exists in file, use it and update in-memory config
			if uuidStr, ok := existingUUID.(string); ok && uuidStr != "" {
				config.InstanceReporting.InstanceUUID = uuidStr
				log.Printf("Using existing instance UUID from config file: %s", uuidStr)
				return nil
			}
		}
		// Set the new UUID
		instanceReporting["instance_uuid"] = newUUID
	} else {
		// Create section if it doesn't exist
		configMap["instance_reporting"] = map[string]interface{}{
			"enabled":             config.InstanceReporting.Enabled,
			"hostname":            config.InstanceReporting.Hostname,
			"port":                config.InstanceReporting.Port,
			"report_interval_sec": config.InstanceReporting.ReportIntervalSec,
			"instance_uuid":       newUUID,
		}
	}

	// Marshal back to YAML
	updatedData, err := yaml.Marshal(configMap)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	// Write back to file
	// Create backup first
	backupPath := configPath + ".bak"
	if err := os.WriteFile(backupPath, data, 0644); err != nil {
		log.Printf("Warning: failed to create config backup: %v", err)
	}

	if err := os.WriteFile(configPath, updatedData, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	// Update in-memory config
	config.InstanceReporting.InstanceUUID = newUUID
	log.Printf("Generated new instance UUID: %s", newUUID)
	return nil
}

// SendStartupReport sends a startup report regardless of whether instance reporting is enabled
// This runs in a non-blocking goroutine with retries and only sends if collector endpoint is configured
func SendStartupReport(config *Config, cwskimmerConfig *CWSkimmerConfig, sessions *SessionManager, configPath string, noiseFloorMonitor *NoiseFloorMonitor, freqRefMonitor *FrequencyReferenceMonitor) {
	// Run in a goroutine to not block startup
	go func() {
		// Check if we have the minimum required configuration (collector hostname and port)
		if config.InstanceReporting.Hostname == "" {
			log.Println("Startup report skipped: instance_reporting.hostname not configured")
			return
		}

		if config.InstanceReporting.Port == 0 {
			log.Println("Startup report skipped: instance_reporting.port not configured")
			return
		}

		// Ensure UUID exists (generate and save if needed)
		if err := ensureUUIDForStartup(config, configPath); err != nil {
			log.Printf("Startup report skipped: failed to ensure UUID: %v", err)
			return
		}

		// Wait 30 seconds before sending startup report to allow noise floor monitor to collect data
		log.Println("Waiting 30 seconds before sending startup report (to collect SNR data)...")
		time.Sleep(30 * time.Second)

		log.Println("Sending startup report...")

		// Build the report with all available fields
		cwSkimmerEnabled := false
		if cwskimmerConfig != nil {
			cwSkimmerEnabled = cwskimmerConfig.Enabled
		}

		// Calculate available client slots
		currentNonBypassedUsers := sessions.GetNonBypassedUserCount()
		availableClients := config.Server.MaxSessions - currentNonBypassedUsers
		if availableClients < 0 {
			availableClients = 0
		}

		// Build list of public IQ modes
		publicIQModes := []string{}
		for mode, isPublic := range config.Server.PublicIQModes {
			if isPublic {
				publicIQModes = append(publicIQModes, mode)
			}
		}

		// Construct public_url from instance connection info
		publicURL := config.InstanceReporting.ConstructPublicURL()

		// Get CPU information
		cpuModel, _ := getCPUInfo()

		// Get system load information
		systemLoad := getSystemLoad()

		// Get SNR measurements if noise floor monitor is available
		snr_0_30, snr_1_8_30 := -1, -1
		if noiseFloorMonitor != nil {
			snr_0_30_f, snr_1_8_30_f := noiseFloorMonitor.GetWidebandSNR()
			snr_0_30 = int(snr_0_30_f)
			snr_1_8_30 = int(snr_1_8_30_f)
		}

		// Get rotator information (not available at startup, so use default values)
		rotatorInfo := map[string]interface{}{
			"enabled":   config.Rotctl.Enabled,
			"connected": false,
			"azimuth":   -1,
		}

		// Get frequency reference information
		freqRefInfo := map[string]interface{}{
			"enabled": false,
		}
		if freqRefMonitor != nil {
			freqRefStatus := freqRefMonitor.GetStatus()
			freqRefInfo = map[string]interface{}{
				"enabled": freqRefStatus["enabled"],
			}
			// Only include additional fields if enabled
			if enabled, ok := freqRefStatus["enabled"].(bool); ok && enabled {
				freqRefInfo["expected_frequency"] = freqRefStatus["expected_frequency"]
				freqRefInfo["detected_frequency"] = freqRefStatus["detected_frequency"]
				freqRefInfo["frequency_offset"] = freqRefStatus["frequency_offset"]
				freqRefInfo["signal_strength"] = freqRefStatus["signal_strength"]
				freqRefInfo["snr"] = freqRefStatus["snr"]
				freqRefInfo["noise_floor"] = freqRefStatus["noise_floor"]
			}
		}

		// Build the report
		report := InstanceReport{
			UUID:               config.InstanceReporting.InstanceUUID,
			Callsign:           config.Admin.Callsign,
			Name:               config.Admin.Name,
			Email:              config.Admin.Email,
			Location:           config.Admin.Location,
			Latitude:           config.Admin.GPS.Lat,
			Longitude:          config.Admin.GPS.Lon,
			Altitude:           config.Admin.ASL,
			PublicURL:          publicURL,
			Version:            Version,
			Timestamp:          time.Now().Unix(),
			Host:               config.InstanceReporting.Instance.Host,
			Port:               config.InstanceReporting.Instance.Port,
			TLS:                config.InstanceReporting.Instance.TLS,
			UseMyIP:            config.InstanceReporting.UseMyIP,
			CreateDomain:       config.InstanceReporting.CreateDomain,
			CWSkimmer:          cwSkimmerEnabled,
			DigitalDecodes:     config.Decoder.Enabled,
			NoiseFloor:         config.NoiseFloor.Enabled,
			MaxClients:         config.Server.MaxSessions,
			AvailableClients:   availableClients,
			MaxSessionTime:     config.Server.MaxSessionTime,
			PublicIQModes:      publicIQModes,
			CPUModel:           cpuModel,
			Load:               systemLoad,
			CORSEnabled:        config.Server.EnableCORS,
			ChatEnabled:        config.Chat.Enabled,
			ChatUsers:          0, // Chat users not available at startup
			SNR_0_30MHz:        snr_0_30,
			SNR_1_8_30MHz:      snr_1_8_30,
			Rotator:            rotatorInfo,
			FrequencyReference: freqRefInfo,
			StartupReport:      true,
		}

		jsonData, err := json.Marshal(report)
		if err != nil {
			log.Printf("Startup report failed: failed to marshal report: %v", err)
			return
		}

		// Build URL
		protocol := "https"
		defaultPort := 443
		if !config.InstanceReporting.UseHTTPS {
			protocol = "http"
			defaultPort = 80
		}

		var url string
		if config.InstanceReporting.Port == defaultPort {
			url = fmt.Sprintf("%s://%s/api/instance/%s",
				protocol,
				config.InstanceReporting.Hostname,
				config.InstanceReporting.InstanceUUID)
		} else {
			url = fmt.Sprintf("%s://%s:%d/api/instance/%s",
				protocol,
				config.InstanceReporting.Hostname,
				config.InstanceReporting.Port,
				config.InstanceReporting.InstanceUUID)
		}

		// Create HTTP client with 10-second timeout
		httpClient := &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					MinVersion: tls.VersionTLS12,
				},
			},
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}

		// Retry up to 3 times with 10 second delays
		maxRetries := 3
		retryDelay := 10 * time.Second

		for attempt := 1; attempt <= maxRetries; attempt++ {
			req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
			if err != nil {
				log.Printf("Startup report failed: failed to create request: %v", err)
				return
			}

			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))

			resp, err := httpClient.Do(req)
			if err != nil {
				log.Printf("Startup report attempt %d/%d failed: %v", attempt, maxRetries, err)
				if attempt < maxRetries {
					time.Sleep(retryDelay)
					continue
				}
				return
			}

			// Read and close response body
			func() {
				defer func() {
					if err := resp.Body.Close(); err != nil {
						log.Printf("Startup report: error closing response body: %v", err)
					}
				}()

				// Check for redirect responses
				if resp.StatusCode >= 300 && resp.StatusCode < 400 {
					location := resp.Header.Get("Location")
					log.Printf("Startup report attempt %d/%d: server returned redirect %d to %s", attempt, maxRetries, resp.StatusCode, location)
					if attempt < maxRetries {
						time.Sleep(retryDelay)
						return
					}
					return
				}

				if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
					log.Printf("Startup report attempt %d/%d: server returned status %d", attempt, maxRetries, resp.StatusCode)
					if attempt < maxRetries {
						time.Sleep(retryDelay)
						return
					}
					return
				}

				// Success
				log.Printf("Startup report sent successfully (status: %d, attempt: %d)", resp.StatusCode, attempt)
			}()

			// If we got here, the request completed (success or final failure)
			return
		}
	}()
}

// getCPUInfo is a helper function to get CPU information (extracted for reuse)
func getCPUInfo() (string, int) {
	info, err := cpu.Info()
	if err != nil {
		log.Printf("Failed to get CPU info: %v", err)
		return "Unknown", 0
	}

	if len(info) > 0 {
		// Get model name from first CPU
		model := info[0].ModelName

		// Get total number of cores (sum across all CPUs)
		totalCores := 0
		for _, cpuInfo := range info {
			totalCores += int(cpuInfo.Cores)
		}

		return model, totalCores
	}

	return "Unknown", 0
}

// getSystemLoad is a helper function to get system load (extracted for reuse)
func getSystemLoad() map[string]interface{} {
	loadData := map[string]interface{}{
		"load_1min":  "",
		"load_5min":  "",
		"load_15min": "",
		"cpu_cores":  0,
		"status":     "unknown",
	}

	// Read /proc/loadavg
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		log.Printf("Failed to read /proc/loadavg: %v", err)
		return loadData
	}

	// Parse the load averages
	// Format: "0.52 0.58 0.59 1/1234 12345"
	fields := strings.Split(strings.TrimSpace(string(data)), " ")
	if len(fields) < 3 {
		log.Printf("Invalid /proc/loadavg format")
		return loadData
	}

	loadData["load_1min"] = fields[0]
	loadData["load_5min"] = fields[1]
	loadData["load_15min"] = fields[2]

	// Get CPU core count
	cpuCores := 0
	info, err := cpu.Info()
	if err == nil && len(info) > 0 {
		for _, cpuInfo := range info {
			cpuCores += int(cpuInfo.Cores)
		}
	}
	loadData["cpu_cores"] = cpuCores

	// Parse load values for status calculation
	load1, err1 := strconv.ParseFloat(fields[0], 64)
	load5, err2 := strconv.ParseFloat(fields[1], 64)
	load15, err3 := strconv.ParseFloat(fields[2], 64)

	if err1 == nil && err2 == nil && err3 == nil {
		// Calculate average load across all three periods
		avgLoad := (load1 + load5 + load15) / 3.0

		// Determine status based on average load vs CPU cores
		status := "ok"
		if cpuCores > 0 {
			if avgLoad >= float64(cpuCores)*2.0 {
				status = "critical"
			} else if avgLoad >= float64(cpuCores) {
				status = "warning"
			}
		}
		loadData["status"] = status
	}

	return loadData
}
