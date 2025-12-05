package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// PowerDNSConfig holds PowerDNS API configuration
type PowerDNSConfig struct {
	Enabled  bool   `json:"enabled"`
	APIKey   string `json:"api_key"`
	APIURL   string `json:"api_url"`
	ServerID string `json:"server_id"` // Usually "localhost"
	ZoneName string `json:"zone_name"` // e.g., "instance.ubersdr.org"
}

// PowerDNSRRSet represents a PowerDNS RRSet (Resource Record Set)
type PowerDNSRRSet struct {
	Name       string              `json:"name"`
	Type       string              `json:"type"`
	TTL        int                 `json:"ttl"`
	ChangeType string              `json:"changetype"`
	Records    []PowerDNSRecord    `json:"records,omitempty"`
	Comments   []PowerDNSComment   `json:"comments,omitempty"`
}

// PowerDNSRecord represents a single DNS record
type PowerDNSRecord struct {
	Content  string `json:"content"`
	Disabled bool   `json:"disabled"`
}

// PowerDNSComment represents a comment on a DNS record
type PowerDNSComment struct {
	Content    string `json:"content"`
	Account    string `json:"account"`
	ModifiedAt int64  `json:"modified_at"`
}

// PowerDNSPatchRequest represents the request body for PATCH operations
type PowerDNSPatchRequest struct {
	RRSets []PowerDNSRRSet `json:"rrsets"`
}

// validateIPv4 validates that a string is a valid IPv4 address
func validateIPv4(ip string) error {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return fmt.Errorf("invalid IP address format")
	}
	
	// Check if it's IPv4
	if parsedIP.To4() == nil {
		return fmt.Errorf("not an IPv4 address")
	}
	
	return nil
}

// validateDNSSubdomain validates that a string is a valid DNS subdomain label
// DNS labels must:
// - Be 1-63 characters long
// - Contain only alphanumeric characters and hyphens
// - Not start or end with a hyphen
// - Not contain consecutive hyphens
func validateDNSSubdomain(subdomain string) error {
	if subdomain == "" {
		return fmt.Errorf("subdomain cannot be empty")
	}
	
	if len(subdomain) > 63 {
		return fmt.Errorf("subdomain too long (max 63 characters)")
	}
	
	// DNS label regex: alphanumeric, hyphens allowed but not at start/end
	// Also converts to lowercase for case-insensitive matching
	validLabel := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	
	lowerSubdomain := strings.ToLower(subdomain)
	if !validLabel.MatchString(lowerSubdomain) {
		return fmt.Errorf("invalid subdomain format (must contain only alphanumeric characters and hyphens, cannot start or end with hyphen)")
	}
	
	// Check for consecutive hyphens
	if strings.Contains(lowerSubdomain, "--") {
		return fmt.Errorf("subdomain cannot contain consecutive hyphens")
	}
	
	return nil
}

// createOrUpdateDNSRecord creates or updates an A record in PowerDNS
func (c *Collector) createOrUpdateDNSRecord(callsign, ipAddress string) error {
	if !c.config.PowerDNS.Enabled {
		return nil // PowerDNS not enabled, skip silently
	}
	
	// Validate IP address
	if err := validateIPv4(ipAddress); err != nil {
		return fmt.Errorf("IP validation failed: %w", err)
	}
	
	// Validate callsign as DNS subdomain
	if err := validateDNSSubdomain(callsign); err != nil {
		return fmt.Errorf("callsign validation failed: %w", err)
	}
	
	// Construct the FQDN (Fully Qualified Domain Name)
	// e.g., "w1abc.instance.ubersdr.org."
	fqdn := fmt.Sprintf("%s.%s.", strings.ToLower(callsign), c.config.PowerDNS.ZoneName)
	
	// Ensure zone name ends with a dot for PowerDNS API
	zoneName := c.config.PowerDNS.ZoneName
	if !strings.HasSuffix(zoneName, ".") {
		zoneName += "."
	}
	
	// Create the RRSet for the A record
	rrset := PowerDNSRRSet{
		Name:       fqdn,
		Type:       "A",
		TTL:        60, // 60 seconds TTL
		ChangeType: "REPLACE",
		Records: []PowerDNSRecord{
			{
				Content:  ipAddress,
				Disabled: false,
			},
		},
		Comments: []PowerDNSComment{
			{
				Content:    fmt.Sprintf("Auto-created by UberSDR Collector for %s", callsign),
				Account:    "ubersdr-collector",
				ModifiedAt: time.Now().Unix(),
			},
		},
	}
	
	// Create the PATCH request
	patchReq := PowerDNSPatchRequest{
		RRSets: []PowerDNSRRSet{rrset},
	}
	
	jsonData, err := json.Marshal(patchReq)
	if err != nil {
		return fmt.Errorf("failed to marshal PowerDNS request: %w", err)
	}
	
	// Construct the API URL
	// Format: {api_url}/api/v1/servers/{server_id}/zones/{zone_name}
	apiURL := fmt.Sprintf("%s/api/v1/servers/%s/zones/%s",
		strings.TrimSuffix(c.config.PowerDNS.APIURL, "/"),
		c.config.PowerDNS.ServerID,
		zoneName,
	)
	
	// Create HTTP request
	req, err := http.NewRequest("PATCH", apiURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create PowerDNS request: %w", err)
	}
	
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.config.PowerDNS.APIKey)
	
	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	
	// Execute request
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("PowerDNS API request failed: %w", err)
	}
	defer resp.Body.Close()
	
	// Check response status
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		// Read error response body
		var errorBody bytes.Buffer
		errorBody.ReadFrom(resp.Body)
		return fmt.Errorf("PowerDNS API returned status %d: %s", resp.StatusCode, errorBody.String())
	}
	
	log.Printf("Successfully created/updated DNS record: %s -> %s", fqdn, ipAddress)
	return nil
}

// deleteDNSRecord deletes an A record from PowerDNS
func (c *Collector) deleteDNSRecord(callsign string) error {
	if !c.config.PowerDNS.Enabled {
		return nil // PowerDNS not enabled, skip silently
	}
	
	// Validate callsign as DNS subdomain
	if err := validateDNSSubdomain(callsign); err != nil {
		return fmt.Errorf("callsign validation failed: %w", err)
	}
	
	// Construct the FQDN
	fqdn := fmt.Sprintf("%s.%s.", strings.ToLower(callsign), c.config.PowerDNS.ZoneName)
	
	// Ensure zone name ends with a dot
	zoneName := c.config.PowerDNS.ZoneName
	if !strings.HasSuffix(zoneName, ".") {
		zoneName += "."
	}
	
	// Create the RRSet for deletion
	rrset := PowerDNSRRSet{
		Name:       fqdn,
		Type:       "A",
		ChangeType: "DELETE",
	}
	
	// Create the PATCH request
	patchReq := PowerDNSPatchRequest{
		RRSets: []PowerDNSRRSet{rrset},
	}
	
	jsonData, err := json.Marshal(patchReq)
	if err != nil {
		return fmt.Errorf("failed to marshal PowerDNS request: %w", err)
	}
	
	// Construct the API URL
	apiURL := fmt.Sprintf("%s/api/v1/servers/%s/zones/%s",
		strings.TrimSuffix(c.config.PowerDNS.APIURL, "/"),
		c.config.PowerDNS.ServerID,
		zoneName,
	)
	
	// Create HTTP request
	req, err := http.NewRequest("PATCH", apiURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create PowerDNS request: %w", err)
	}
	
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.config.PowerDNS.APIKey)
	
	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	
	// Execute request
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("PowerDNS API request failed: %w", err)
	}
	defer resp.Body.Close()
	
	// Check response status
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		// Read error response body
		var errorBody bytes.Buffer
		errorBody.ReadFrom(resp.Body)
		return fmt.Errorf("PowerDNS API returned status %d: %s", resp.StatusCode, errorBody.String())
	}
	
	log.Printf("Successfully deleted DNS record: %s", fqdn)
	return nil
}

// PowerDNSZone represents a PowerDNS zone response
type PowerDNSZone struct {
	ID     string          `json:"id"`
	Name   string          `json:"name"`
	Type   string          `json:"type"`
	RRSets []PowerDNSRRSet `json:"rrsets,omitempty"`
}

// testPowerDNSConnection tests connectivity to PowerDNS by listing zone records
func (c *Collector) testPowerDNSConnection() error {
	if !c.config.PowerDNS.Enabled {
		return nil // PowerDNS not enabled, skip test
	}
	
	log.Printf("Testing PowerDNS connectivity...")
	
	// Ensure zone name ends with a dot
	zoneName := c.config.PowerDNS.ZoneName
	if !strings.HasSuffix(zoneName, ".") {
		zoneName += "."
	}
	
	// Construct the API URL to get zone information
	// Format: {api_url}/api/v1/servers/{server_id}/zones/{zone_name}
	apiURL := fmt.Sprintf("%s/api/v1/servers/%s/zones/%s",
		strings.TrimSuffix(c.config.PowerDNS.APIURL, "/"),
		c.config.PowerDNS.ServerID,
		zoneName,
	)
	
	// Create HTTP request
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create PowerDNS test request: %w", err)
	}
	
	req.Header.Set("X-API-Key", c.config.PowerDNS.APIKey)
	
	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	
	// Execute request
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("PowerDNS API connection failed: %w", err)
	}
	defer resp.Body.Close()
	
	// Check response status
	if resp.StatusCode != http.StatusOK {
		// Read error response body
		var errorBody bytes.Buffer
		errorBody.ReadFrom(resp.Body)
		return fmt.Errorf("PowerDNS API returned status %d: %s", resp.StatusCode, errorBody.String())
	}
	
	// Parse the zone response
	var zone PowerDNSZone
	if err := json.NewDecoder(resp.Body).Decode(&zone); err != nil {
		return fmt.Errorf("failed to parse PowerDNS zone response: %w", err)
	}
	
	// Count A records in the zone
	aRecordCount := 0
	for _, rrset := range zone.RRSets {
		if rrset.Type == "A" {
			aRecordCount += len(rrset.Records)
		}
	}
	
	log.Printf("PowerDNS connectivity test successful!")
	log.Printf("  Zone: %s", zone.Name)
	log.Printf("  Type: %s", zone.Type)
	log.Printf("  A Records: %d", aRecordCount)
	log.Printf("  Total RRSets: %d", len(zone.RRSets))
	
	return nil
}