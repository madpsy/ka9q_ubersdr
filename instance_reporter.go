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
	UUID      string  `json:"uuid"`
	Callsign  string  `json:"callsign"`
	Name      string  `json:"name"`
	Location  string  `json:"location"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Altitude  int     `json:"altitude"`
	PublicURL string  `json:"public_url"`
	Version   string  `json:"version"`
	Timestamp int64   `json:"timestamp"`
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
	report := InstanceReport{
		UUID:      ir.config.InstanceReporting.InstanceUUID,
		Callsign:  ir.config.Admin.Callsign,
		Name:      ir.config.Admin.Name,
		Location:  ir.config.Admin.Location,
		Latitude:  ir.config.Admin.GPS.Lat,
		Longitude: ir.config.Admin.GPS.Lon,
		Altitude:  ir.config.Admin.ASL,
		PublicURL: ir.config.Admin.PublicURL,
		Version:   Version,
		Timestamp: time.Now().Unix(),
	}

	jsonData, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("failed to marshal report: %w", err)
	}

	// Build URL with http or https based on config
	protocol := "https"
	if !ir.config.InstanceReporting.UseHTTPS {
		protocol = "http"
	}
	url := fmt.Sprintf("%s://%s:%d/api/instance/%s",
		protocol,
		ir.config.InstanceReporting.Hostname,
		ir.config.InstanceReporting.Port,
		ir.config.InstanceReporting.InstanceUUID)

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
