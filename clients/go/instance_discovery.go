package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// LocalInstance represents a discovered local UberSDR instance
type LocalInstance struct {
	Name        string               `json:"name"`
	Host        string               `json:"host"`
	Port        int                  `json:"port"`
	Version     string               `json:"version"`
	TLS         bool                 `json:"tls"`
	TxtRecords  map[string]string    `json:"txtRecords"`
	Description *InstanceDescription `json:"description,omitempty"`
}

// PublicInstance represents a public UberSDR instance from instances.ubersdr.org
type PublicInstance struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Callsign         string   `json:"callsign"`
	Location         string   `json:"location"`
	Version          string   `json:"version"`
	Host             string   `json:"host"`
	Port             int      `json:"port"`
	TLS              bool     `json:"tls"`
	PublicURL        string   `json:"public_url"`
	AvailableClients int      `json:"available_clients"`
	MaxClients       int      `json:"max_clients"`
	MaxSessionTime   int      `json:"max_session_time"`
	CWSkimmer        bool     `json:"cw_skimmer"`
	DigitalDecodes   bool     `json:"digital_decodes"`
	NoiseFloor       bool     `json:"noise_floor"`
	PublicIQModes    []string `json:"public_iq_modes"`
}

// InstanceDescription represents the /api/description response from an instance
type InstanceDescription struct {
	Version          string       `json:"version"`
	PublicUUID       string       `json:"public_uuid"`
	Receiver         ReceiverInfo `json:"receiver"`
	AvailableClients int          `json:"available_clients"`
	MaxClients       int          `json:"max_clients"`
	MaxSessionTime   int          `json:"max_session_time"`
	CWSkimmer        bool         `json:"cw_skimmer"`
	DigitalDecodes   bool         `json:"digital_decodes"`
	NoiseFloor       bool         `json:"noise_floor"`
	PublicIQModes    []string     `json:"public_iq_modes"`
}

// ReceiverInfo represents receiver information from instance description
type ReceiverInfo struct {
	Name      string `json:"name"`
	Callsign  string `json:"callsign"`
	Location  string `json:"location"`
	PublicURL string `json:"public_url"`
}

// LocalInstancesResponse represents the API response for local instances
type LocalInstancesResponse struct {
	Instances []LocalInstance `json:"instances"`
}

// PublicInstancesResponse represents the API response for public instances
type PublicInstancesResponse struct {
	Instances []PublicInstance `json:"instances"`
}

// InstanceDiscovery manages instance discovery
type InstanceDiscovery struct {
	mu             sync.RWMutex
	localInstances map[string]*LocalInstance
	resolver       *zeroconf.Resolver
	ctx            context.Context
	cancel         context.CancelFunc
}

// NewInstanceDiscovery creates a new instance discovery manager
func NewInstanceDiscovery() *InstanceDiscovery {
	ctx, cancel := context.WithCancel(context.Background())
	return &InstanceDiscovery{
		localInstances: make(map[string]*LocalInstance),
		ctx:            ctx,
		cancel:         cancel,
	}
}

// StartLocalDiscovery starts mDNS discovery for local instances
func (id *InstanceDiscovery) StartLocalDiscovery() error {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return fmt.Errorf("failed to initialize mDNS resolver: %w", err)
	}
	id.resolver = resolver

	entries := make(chan *zeroconf.ServiceEntry)

	go func() {
		for entry := range entries {
			id.handleServiceEntry(entry)
		}
	}()

	// Browse for _ubersdr._tcp services
	go func() {
		if err := resolver.Browse(id.ctx, "_ubersdr._tcp", "local.", entries); err != nil {
			log.Printf("Failed to browse mDNS services: %v", err)
		}
	}()

	return nil
}

// handleServiceEntry processes a discovered mDNS service
func (id *InstanceDiscovery) handleServiceEntry(entry *zeroconf.ServiceEntry) {
	if len(entry.AddrIPv4) == 0 && len(entry.AddrIPv6) == 0 {
		return
	}

	// Prefer IPv4
	var host string
	if len(entry.AddrIPv4) > 0 {
		host = entry.AddrIPv4[0].String()
	} else {
		host = "[" + entry.AddrIPv6[0].String() + "]"
	}

	// Parse TXT records
	txtRecords := make(map[string]string)
	for _, txt := range entry.Text {
		// TXT records are in "key=value" format
		if len(txt) > 0 {
			for i := 0; i < len(txt); i++ {
				if txt[i] == '=' {
					key := txt[:i]
					value := txt[i+1:]
					txtRecords[key] = value
					break
				}
			}
		}
	}

	version := txtRecords["version"]
	if version == "" {
		version = "Unknown"
	}

	instance := &LocalInstance{
		Name:       unescapeMDNSName(entry.Instance),
		Host:       host,
		Port:       entry.Port,
		Version:    version,
		TLS:        false, // Local instances typically don't use TLS
		TxtRecords: txtRecords,
	}

	id.mu.Lock()
	id.localInstances[entry.Instance] = instance
	id.mu.Unlock()

	// Fetch description in background
	go id.fetchInstanceDescription(instance)
}

// fetchInstanceDescription fetches the /api/description for an instance
func (id *InstanceDiscovery) fetchInstanceDescription(instance *LocalInstance) {
	protocol := "http"
	if instance.TLS {
		protocol = "https"
	}

	url := fmt.Sprintf("%s://%s:%d/api/description", protocol, instance.Host, instance.Port)

	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get(url)
	if err != nil {
		log.Printf("Failed to fetch description for %s: %v", instance.Name, err)
		// Remove instance if we can't fetch its description
		id.mu.Lock()
		delete(id.localInstances, instance.Name)
		id.mu.Unlock()
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Failed to fetch description for %s: status %d", instance.Name, resp.StatusCode)
		id.mu.Lock()
		delete(id.localInstances, instance.Name)
		id.mu.Unlock()
		return
	}

	var description InstanceDescription
	if err := json.NewDecoder(resp.Body).Decode(&description); err != nil {
		log.Printf("Failed to decode description for %s: %v", instance.Name, err)
		id.mu.Lock()
		delete(id.localInstances, instance.Name)
		id.mu.Unlock()
		return
	}

	id.mu.Lock()
	instance.Description = &description
	id.mu.Unlock()
}

// GetLocalInstances returns the list of discovered local instances
func (id *InstanceDiscovery) GetLocalInstances() []LocalInstance {
	id.mu.RLock()
	defer id.mu.RUnlock()

	instances := make([]LocalInstance, 0, len(id.localInstances))
	for _, instance := range id.localInstances {
		// Only include instances with valid descriptions
		if instance.Description != nil {
			instances = append(instances, *instance)
		}
	}

	return instances
}

// GetPublicInstances fetches public instances from instances.ubersdr.org
func GetPublicInstances() ([]PublicInstance, error) {
	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	resp, err := client.Get("https://instances.ubersdr.org/api/instances")
	if err != nil {
		return nil, fmt.Errorf("failed to fetch public instances: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to fetch public instances: status %d", resp.StatusCode)
	}

	var response struct {
		Instances []PublicInstance `json:"instances"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode public instances: %w", err)
	}

	return response.Instances, nil
}

// Stop stops the instance discovery
func (id *InstanceDiscovery) Stop() {
	if id.cancel != nil {
		id.cancel()
	}
}

// GetLocalInstanceUUIDs returns a set of UUIDs from local instances
func (id *InstanceDiscovery) GetLocalInstanceUUIDs() []string {
	id.mu.RLock()
	defer id.mu.RUnlock()

	uuids := make([]string, 0)
	for _, instance := range id.localInstances {
		if instance.Description != nil && instance.Description.PublicUUID != "" {
			uuids = append(uuids, instance.Description.PublicUUID)
		}
	}

	return uuids
}

// unescapeMDNSName removes escape characters from mDNS service names
func unescapeMDNSName(name string) string {
	// Replace escaped spaces and other characters
	result := ""
	i := 0
	for i < len(name) {
		if i < len(name)-1 && name[i] == '\\' {
			// Skip the backslash and take the next character
			i++
			if i < len(name) {
				result += string(name[i])
			}
		} else {
			result += string(name[i])
		}
		i++
	}
	return result
}

// Helper function to get local IP addresses
func getLocalIPs() ([]string, error) {
	var ips []string

	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}

	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				ips = append(ips, ipnet.IP.String())
			}
		}
	}

	return ips, nil
}
