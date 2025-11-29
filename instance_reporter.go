package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

// InstanceReporter handles reporting instance information to central server
type InstanceReporter struct {
	config     *Config
	configPath string
	httpClient *http.Client
	stopChan   chan struct{}
}

// InstanceReport represents the data sent to the central server
type InstanceReport struct {
	UUID           string  `json:"uuid"`
	Callsign       string  `json:"callsign"`
	Name           string  `json:"name"`
	Location       string  `json:"location"`
	Latitude       float64 `json:"latitude"`
	Longitude      float64 `json:"longitude"`
	Altitude       int     `json:"altitude"`
	PublicURL      string  `json:"public_url"`
	Version        string  `json:"version"`
	Timestamp      int64   `json:"timestamp"`
	Host           string  `json:"host,omitempty"`  // Optional: tells clients how to connect to this instance
	Port           int     `json:"port,omitempty"`  // Optional: port for client connections
	TLS            bool    `json:"tls,omitempty"`   // Optional: whether TLS is required for connections
	CWSkimmer      bool    `json:"cw_skimmer"`      // Whether CW Skimmer is enabled
	DigitalDecodes bool    `json:"digital_decodes"` // Whether digital decoding is enabled
	NoiseFloor     bool    `json:"noise_floor"`     // Whether noise floor monitoring is enabled
	MaxClients     int     `json:"max_clients"`     // Maximum number of clients allowed
}

// NewInstanceReporter creates a new instance reporter
func NewInstanceReporter(config *Config, configPath string) *InstanceReporter {
	return &InstanceReporter{
		config:     config,
		configPath: configPath,
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

// sendReport sends the current instance information to the central server
// Retries up to 3 times with 10 second delays between attempts
func (ir *InstanceReporter) sendReport() error {
	// Get capability information from local /api/description endpoint
	// Extract port from server listen address
	listenAddr := ir.config.Server.Listen
	port := "8080" // default
	if len(listenAddr) > 0 {
		// Parse listen address (e.g., ":8080" or "0.0.0.0:8080")
		if idx := len(listenAddr) - 1; listenAddr[idx] >= '0' && listenAddr[idx] <= '9' {
			// Find the colon before the port
			for i := len(listenAddr) - 1; i >= 0; i-- {
				if listenAddr[i] == ':' {
					port = listenAddr[i+1:]
					break
				}
			}
		}
	}

	descURL := fmt.Sprintf("http://localhost:%s/api/description", port)
	descResp, err := http.Get(descURL)

	// Default capability values
	capabilities := struct {
		MaxClients     int  `json:"max_clients"`
		NoiseFloor     bool `json:"noise_floor"`
		DigitalDecodes bool `json:"digital_decodes"`
		CWSkimmer      bool `json:"cw_skimmer"`
	}{
		MaxClients:     ir.config.Server.MaxSessions,
		NoiseFloor:     ir.config.NoiseFloor.Enabled,
		DigitalDecodes: ir.config.Decoder.Enabled,
		CWSkimmer:      false, // Will be updated from API if available
	}

	if err == nil && descResp != nil {
		defer descResp.Body.Close()
		if descResp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(descResp.Body).Decode(&capabilities); err != nil {
				log.Printf("Warning: Failed to decode description response: %v", err)
			}
		}
	} else if err != nil {
		log.Printf("Warning: Failed to get description for instance report: %v", err)
	}

	report := InstanceReport{
		UUID:           ir.config.InstanceReporting.InstanceUUID,
		Callsign:       ir.config.Admin.Callsign,
		Name:           ir.config.Admin.Name,
		Location:       ir.config.Admin.Location,
		Latitude:       ir.config.Admin.GPS.Lat,
		Longitude:      ir.config.Admin.GPS.Lon,
		Altitude:       ir.config.Admin.ASL,
		PublicURL:      ir.config.Admin.PublicURL,
		Version:        Version,
		Timestamp:      time.Now().Unix(),
		Host:           ir.config.InstanceReporting.Instance.Host,
		Port:           ir.config.InstanceReporting.Instance.Port,
		TLS:            ir.config.InstanceReporting.Instance.TLS,
		CWSkimmer:      capabilities.CWSkimmer,
		DigitalDecodes: capabilities.DigitalDecodes,
		NoiseFloor:     capabilities.NoiseFloor,
		MaxClients:     capabilities.MaxClients,
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
		defer resp.Body.Close()

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
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return lastErr
		}

		log.Printf("Successfully reported instance to %s (status: %d, attempt: %d)", url, resp.StatusCode, attempt)
		return nil
	}

	return lastErr
}
