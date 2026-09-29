package ubersdr

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// DirectoryURL is the public instance list.
const DirectoryURL = "https://instances.ubersdr.org/api/instances?online_only=true"

// Instance is a receiver the operator might choose.
type Instance struct {
	Name     string
	Callsign string
	Location string
	Host     string
	Port     int
	TLS      bool
	Version  string

	// PublicIQModes is the wide IQ modes anyone may use, in rate order. A
	// password may unlock more; this is only what is open without one.
	PublicIQModes []string

	// Available and MaxClients are free and total listener slots; -1 unknown.
	Available  int
	MaxClients int

	// Local is true for a receiver found on the LAN rather than the directory.
	Local bool
}

// URL is the base URL to connect to.
func (i Instance) URL() string {
	scheme := "http"
	if i.TLS {
		scheme = "https"
	}
	host := i.Host
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	if i.Port == 0 || (i.TLS && i.Port == 443) || (!i.TLS && i.Port == 80) {
		return scheme + "://" + host
	}
	return fmt.Sprintf("%s://%s:%d", scheme, host, i.Port)
}

// Label is the one-line name for a list: the callsign first, since that is
// what an operator searches by.
func (i Instance) Label() string {
	name := i.Name
	if name == "" {
		name = i.Host
	}
	if i.Callsign != "" && !strings.Contains(strings.ToUpper(name), strings.ToUpper(i.Callsign)) {
		return i.Callsign + " · " + name
	}
	return name
}

// Matches is a case-insensitive filter over the fields an operator would type.
func (i Instance) Matches(filter string) bool {
	f := strings.ToLower(strings.TrimSpace(filter))
	if f == "" {
		return true
	}
	for _, field := range []string{i.Name, i.Callsign, i.Location, i.Host} {
		if strings.Contains(strings.ToLower(field), f) {
			return true
		}
	}
	return false
}

// FetchDirectory reads the public instance list. Only receivers that publish
// at least one rate the bridge can carry are kept, sorted by callsign (or name)
// case-insensitively, as the C bridge's --discover listed them.
func FetchDirectory(ctx context.Context, directoryURL string) ([]Instance, error) {
	if directoryURL == "" {
		directoryURL = DirectoryURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, directoryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	client := &http.Client{
		Timeout:   15 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("directory returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	return parseDirectory(raw)
}

func parseDirectory(raw []byte) ([]Instance, error) {
	var payload struct {
		Instances []struct {
			Name          string   `json:"name"`
			Callsign      string   `json:"callsign"`
			Location      string   `json:"location"`
			Host          string   `json:"host"`
			Port          int      `json:"port"`
			TLS           bool     `json:"tls"`
			Version       string   `json:"version"`
			MaxClients    int      `json:"max_clients"`
			Available     *int     `json:"available_clients"`
			PublicIQModes []string `json:"public_iq_modes"`
		} `json:"instances"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("bad directory response: %w", err)
	}
	out := []Instance{}
	for _, in := range payload.Instances {
		modes := filterWideModes(in.PublicIQModes)
		if in.Host == "" || in.Port == 0 || len(modes) == 0 {
			continue
		}
		inst := Instance{
			Name: in.Name, Callsign: in.Callsign, Location: in.Location,
			Host: in.Host, Port: in.Port, TLS: in.TLS, Version: in.Version,
			PublicIQModes: modes, Available: -1, MaxClients: in.MaxClients,
		}
		if in.Available != nil {
			inst.Available = *in.Available
		}
		out = append(out, inst)
	}
	sortInstances(out)
	return out, nil
}

func sortInstances(list []Instance) {
	key := func(i Instance) string {
		if i.Callsign != "" {
			return strings.ToLower(i.Callsign)
		}
		return strings.ToLower(i.Name)
	}
	sort.SliceStable(list, func(a, b int) bool { return key(list[a]) < key(list[b]) })
}

// FindCallsign returns the instance with a callsign, case-insensitively.
func FindCallsign(list []Instance, callsign string) (Instance, bool) {
	for _, i := range list {
		if strings.EqualFold(i.Callsign, strings.TrimSpace(callsign)) {
			return i, true
		}
	}
	return Instance{}, false
}

// LocalDiscovery browses the LAN for receivers advertising _ubersdr._tcp.
// Best effort: a network without mDNS simply finds nothing.
type LocalDiscovery struct {
	mu    sync.Mutex
	found map[string]Instance

	// Updates is signalled, without blocking, whenever the set changes.
	Updates chan struct{}
}

func NewLocalDiscovery() *LocalDiscovery {
	return &LocalDiscovery{found: map[string]Instance{}, Updates: make(chan struct{}, 1)}
}

// Run browses until ctx is cancelled.
func (d *LocalDiscovery) Run(ctx context.Context) error {
	resolver, err := zeroconf.NewResolver(zeroconf.SelectIPTraffic(zeroconf.IPv4))
	if err != nil {
		return fmt.Errorf("mDNS unavailable: %w", err)
	}
	entries := make(chan *zeroconf.ServiceEntry, 16)
	go func() {
		for e := range entries {
			d.add(e)
		}
	}()
	return resolver.Browse(ctx, "_ubersdr._tcp", "local.", entries)
}

func (d *LocalDiscovery) add(e *zeroconf.ServiceEntry) {
	if e == nil || e.Port == 0 {
		return
	}
	var host string
	for _, ip := range e.AddrIPv4 {
		if v4 := ip.To4(); v4 != nil {
			host = v4.String()
			break
		}
	}
	if host == "" {
		return
	}
	txt := map[string]string{}
	for _, rec := range e.Text {
		if k, v, ok := strings.Cut(rec, "="); ok {
			txt[k] = v
		}
	}
	inst := Instance{
		Name: unescapeDNSName(e.Instance), Callsign: txt["callsign"], Location: txt["location"],
		Host: host, Port: e.Port, Version: txt["version"], Available: -1, MaxClients: -1, Local: true,
	}
	d.mu.Lock()
	_, existing := d.found[e.Instance]
	d.found[e.Instance] = inst
	d.mu.Unlock()
	d.notify()
	if !existing {
		go d.enrich(e.Instance, inst)
	}
}

// enrich asks the receiver itself for its name, since an mDNS instance name is
// usually just a hostname.
func (d *LocalDiscovery) enrich(key string, inst Instance) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	desc, err := (&Server{Base: inst.URL()}).Describe(ctx)
	if err != nil {
		return
	}
	d.mu.Lock()
	cur, ok := d.found[key]
	if ok {
		if desc.Name != "" {
			cur.Name = desc.Name
		}
		if desc.Callsign != "" {
			cur.Callsign = desc.Callsign
		}
		if desc.Location != "" {
			cur.Location = desc.Location
		}
		if desc.Version != "" {
			cur.Version = desc.Version
		}
		d.found[key] = cur
	}
	d.mu.Unlock()
	d.notify()
}

func (d *LocalDiscovery) notify() {
	select {
	case d.Updates <- struct{}{}:
	default:
	}
}

// Instances returns the receivers found so far, sorted as the directory is.
func (d *LocalDiscovery) Instances() []Instance {
	d.mu.Lock()
	out := make([]Instance, 0, len(d.found))
	for _, i := range d.found {
		out = append(out, i)
	}
	d.mu.Unlock()
	sortInstances(out)
	return out
}

// unescapeDNSName decodes DNS presentation-format escaping ("\032" and "\ ").
func unescapeDNSName(name string) string {
	if !strings.Contains(name, `\`) {
		return name
	}
	var b strings.Builder
	for i := 0; i < len(name); i++ {
		if name[i] != '\\' {
			b.WriteByte(name[i])
			continue
		}
		if i+3 < len(name) {
			if v, err := strconv.Atoi(name[i+1 : i+4]); err == nil && v <= 255 && isDigits(name[i+1:i+4]) {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		if i+1 < len(name) {
			b.WriteByte(name[i+1])
			i++
		}
	}
	return b.String()
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
