package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// DiscoveredInstance is a unified view of either a public or local instance.
type DiscoveredInstance struct {
	Name             string // display name
	Host             string
	Port             int
	TLS              bool
	Location         string
	Callsign         string
	AvailableClients int
	MaxClients       int
	Source           string // "public" or "local"
}

// DisplayLabel returns a human-readable label for the instance picker.
// Format: "CALLSIGN - Name [slots] — Location (host:port) 🔒"
func (d DiscoveredInstance) DisplayLabel() string {
	tls := ""
	if d.TLS {
		tls = " 🔒"
	}
	avail := ""
	if d.MaxClients > 0 {
		avail = fmt.Sprintf(" [%d/%d]", d.AvailableClients, d.MaxClients)
	}
	loc := ""
	if d.Location != "" {
		loc = " — " + d.Location
	}
	title := d.Name
	if d.Callsign != "" && d.Callsign != d.Name {
		title = d.Callsign + " - " + d.Name
	} else if d.Callsign != "" {
		title = d.Callsign
	}
	return fmt.Sprintf("%s%s%s%s (%s:%d)", title, tls, avail, loc, d.Host, d.Port)
}

// publicInstancesURL is the UberSDR public registry endpoint.
const publicInstancesURL = "https://instances.ubersdr.org/api/instances"

// publicAPIInstance matches the JSON from instances.ubersdr.org
type publicAPIInstance struct {
	Name             string `json:"name"`
	Callsign         string `json:"callsign"`
	Location         string `json:"location"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	TLS              bool   `json:"tls"`
	AvailableClients int    `json:"available_clients"`
	MaxClients       int    `json:"max_clients"`
}

// FetchPublicInstances fetches the list of public UberSDR instances from the internet registry.
func FetchPublicInstances() ([]DiscoveredInstance, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(publicInstancesURL)
	if err != nil {
		return nil, fmt.Errorf("fetch public instances: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch public instances: HTTP %d", resp.StatusCode)
	}

	var body struct {
		Instances []publicAPIInstance `json:"instances"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode public instances: %w", err)
	}

	out := make([]DiscoveredInstance, 0, len(body.Instances))
	for _, p := range body.Instances {
		name := p.Name
		if name == "" {
			name = p.Callsign
		}
		if name == "" {
			name = fmt.Sprintf("%s:%d", p.Host, p.Port)
		}
		out = append(out, DiscoveredInstance{
			Name:             name,
			Host:             p.Host,
			Port:             p.Port,
			TLS:              p.TLS,
			Location:         p.Location,
			Callsign:         p.Callsign,
			AvailableClients: p.AvailableClients,
			MaxClients:       p.MaxClients,
			Source:           "public",
		})
	}
	return out, nil
}

// MDNSDiscovery discovers local UberSDR instances via mDNS (_ubersdr._tcp).
type MDNSDiscovery struct {
	mu        sync.RWMutex
	instances map[string]DiscoveredInstance
	cancel    context.CancelFunc
}

// NewMDNSDiscovery creates and starts an mDNS browser.
// Call Stop() when done.
func NewMDNSDiscovery() (*MDNSDiscovery, error) {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return nil, fmt.Errorf("mDNS resolver: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	d := &MDNSDiscovery{
		instances: make(map[string]DiscoveredInstance),
		cancel:    cancel,
	}

	entries := make(chan *zeroconf.ServiceEntry)
	go func() {
		for entry := range entries {
			d.handleEntry(entry)
		}
	}()

	go func() {
		_ = resolver.Browse(ctx, "_ubersdr._tcp", "local.", entries)
	}()

	return d, nil
}

func (d *MDNSDiscovery) handleEntry(entry *zeroconf.ServiceEntry) {
	if len(entry.AddrIPv4) == 0 && len(entry.AddrIPv6) == 0 {
		return
	}
	var host string
	if len(entry.AddrIPv4) > 0 {
		host = entry.AddrIPv4[0].String()
	} else {
		host = "[" + entry.AddrIPv6[0].String() + "]"
	}

	// Parse TXT records
	txt := make(map[string]string)
	for _, rec := range entry.Text {
		for i := 0; i < len(rec); i++ {
			if rec[i] == '=' {
				txt[rec[:i]] = rec[i+1:]
				break
			}
		}
	}

	name := unescapeMDNS(entry.Instance)
	if name == "" {
		name = fmt.Sprintf("%s:%d", host, entry.Port)
	}

	inst := DiscoveredInstance{
		Name:     name,
		Host:     host,
		Port:     entry.Port,
		TLS:      false,
		Location: txt["location"],
		Callsign: txt["callsign"],
		Source:   "local",
	}

	d.mu.Lock()
	d.instances[entry.Instance] = inst
	d.mu.Unlock()
}

// Instances returns a snapshot of all discovered local instances.
func (d *MDNSDiscovery) Instances() []DiscoveredInstance {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]DiscoveredInstance, 0, len(d.instances))
	for _, v := range d.instances {
		out = append(out, v)
	}
	return out
}

// Stop cancels the mDNS browse.
func (d *MDNSDiscovery) Stop() {
	if d.cancel != nil {
		d.cancel()
	}
}

func unescapeMDNS(name string) string {
	result := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		if name[i] == '\\' && i+1 < len(name) {
			i++
			result = append(result, name[i])
		} else {
			result = append(result, name[i])
		}
	}
	return string(result)
}
