package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// TunnelClientConfig represents the tunnel client configuration file format
type TunnelClientConfig struct {
	Enabled     bool   `json:"enabled"`
	SecretUUID  string `json:"secret_uuid"`
	Callsign    string `json:"callsign"`
	Email       string `json:"email"`
	TunnelURL   string `json:"tunnel_url"`
	BackendHost string `json:"backend_host"`
	BackendPort int    `json:"backend_port"`
}

// GenerateTunnelClientConfig generates the tunnel client configuration file
// based on the UberSDR configuration. It validates all required fields before
// writing the configuration.
func GenerateTunnelClientConfig(config *Config) error {
	// Determine the config file path
	// In Docker, this will be /app/tunnel-client-config/tunnel_client.json
	// For local development, create it in the current directory
	configPath := "/app/tunnel-client-config/tunnel_client.json"

	// Check if we're in Docker (shared volume exists)
	if _, err := os.Stat("/app/tunnel-client-config"); os.IsNotExist(err) {
		// Not in Docker, use local path for development
		configPath = "./tunnel_client.json"
		log.Printf("Tunnel client config volume not found, using local path: %s", configPath)
	}

	// Check if tunnel server integration is disabled
	if !config.InstanceReporting.TunnelServerEnabled {
		log.Printf("Tunnel server integration is disabled, writing disabled config")

		// Write a config file with enabled: false to stop the tunnel client
		tunnelConfig := TunnelClientConfig{
			Enabled:     false,
			SecretUUID:  "",
			Callsign:    "",
			Email:       "",
			TunnelURL:   "",
			BackendHost: "",
			BackendPort: 0,
		}

		// Ensure directory exists
		dir := filepath.Dir(configPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}

		// Write configuration file with pretty formatting
		data, err := json.MarshalIndent(tunnelConfig, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal tunnel client config: %w", err)
		}

		if err := os.WriteFile(configPath, data, 0644); err != nil {
			return fmt.Errorf("failed to write tunnel client config to %s: %w", configPath, err)
		}

		log.Printf("✅ Written disabled tunnel client configuration at %s", configPath)

		// Trigger tunnel client restart to pick up the disabled config
		restartTriggerPath := "/var/run/restart-trigger/restart-tunnel-client"
		restartTriggerDir := filepath.Dir(restartTriggerPath)

		// Check if restart trigger directory exists (Docker environment)
		if _, err := os.Stat(restartTriggerDir); err == nil {
			if err := os.WriteFile(restartTriggerPath, []byte{}, 0666); err != nil {
				log.Printf("⚠️  Failed to create tunnel client restart trigger at %s: %v", restartTriggerPath, err)
			} else {
				log.Printf("✅ Created tunnel client restart trigger to disable tunnel", restartTriggerPath)
			}
		}

		return nil
	}

	// Validate required fields
	if err := validateTunnelClientConfig(config); err != nil {
		log.Printf("⚠️  Tunnel client config validation failed: %v", err)
		log.Printf("   Tunnel client will not be configured")
		return nil // Don't return error, just skip configuration
	}

	// Build tunnel client configuration
	tunnelConfig := TunnelClientConfig{
		Enabled:     true, // Enable the tunnel client
		SecretUUID:  config.InstanceReporting.InstanceUUID,
		Callsign:    config.Admin.Callsign,
		Email:       config.Admin.Email,
		TunnelURL:   config.InstanceReporting.TunnelServerURI,
		BackendHost: "ubersdr", // Docker service name
		BackendPort: 8080,
	}

	// Ensure directory exists
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", dir, err)
	}

	// Write configuration file with pretty formatting
	data, err := json.MarshalIndent(tunnelConfig, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal tunnel client config: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write tunnel client config to %s: %w", configPath, err)
	}

	log.Printf("✅ Generated tunnel client configuration at %s", configPath)
	log.Printf("   Callsign: %s", tunnelConfig.Callsign)
	log.Printf("   UUID: %s", tunnelConfig.SecretUUID)
	log.Printf("   Tunnel URL: %s", tunnelConfig.TunnelURL)

	// Trigger tunnel client restart by creating restart trigger file
	restartTriggerPath := "/var/run/restart-trigger/restart-tunnel-client"
	restartTriggerDir := filepath.Dir(restartTriggerPath)

	// Check if restart trigger directory exists (Docker environment)
	if _, err := os.Stat(restartTriggerDir); err == nil {
		// Create the restart trigger file with world-writable permissions (0666)
		// This allows the tunnel-client container (running as non-root) to delete it
		if err := os.WriteFile(restartTriggerPath, []byte{}, 0666); err != nil {
			log.Printf("⚠️  Failed to create tunnel client restart trigger at %s: %v", restartTriggerPath, err)
		} else {
			log.Printf("✅ Created tunnel client restart trigger at %s", restartTriggerPath)
		}
	} else {
		log.Printf("Restart trigger directory not found (not in Docker), skipping tunnel client restart trigger")
	}

	return nil
}

// validateTunnelClientConfig validates that all required fields are present
// and valid for tunnel client configuration
func validateTunnelClientConfig(config *Config) error {
	// Check instance UUID
	if config.InstanceReporting.InstanceUUID == "" {
		return fmt.Errorf("instance_uuid is empty - instance reporting must be enabled first")
	}

	// Check callsign
	callsign := strings.TrimSpace(config.Admin.Callsign)
	if callsign == "" {
		return fmt.Errorf("callsign is empty")
	}
	if strings.EqualFold(callsign, "N0CALL") {
		return fmt.Errorf("callsign is still the default 'N0CALL' - please set a valid callsign")
	}

	// Check email
	email := strings.TrimSpace(config.Admin.Email)
	if email == "" {
		return fmt.Errorf("email is empty")
	}
	if strings.HasSuffix(strings.ToLower(email), "@example.com") {
		return fmt.Errorf("email is a placeholder @example.com address - please set a valid email")
	}

	// Check tunnel URL
	if config.InstanceReporting.TunnelServerURI == "" {
		return fmt.Errorf("tunnel_server_uri is empty")
	}

	return nil
}
