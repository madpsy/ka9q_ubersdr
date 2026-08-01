package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// Instance is one selectable receiver, from any discovery source.
type Instance struct {
	Name      string
	Location  string
	Callsign  string
	Host      string // host:port
	TLS       bool
	Version   string
	Available int // free client slots; -1 when unknown
	MaxUsers  int
	SNR       int
	Local     bool
}

// Label renders the primary line shown in the picker.
func (i Instance) Label() string {
	name := i.Name
	if name == "" {
		name = i.Host
	}
	if i.Callsign != "" && !strings.Contains(strings.ToUpper(name), strings.ToUpper(i.Callsign)) {
		name = i.Callsign + " · " + name
	}
	return name
}

// Detail renders the dimmer secondary line.
func (i Instance) Detail() string {
	parts := []string{}
	if i.Location != "" {
		parts = append(parts, i.Location)
	}
	parts = append(parts, i.Host)
	if i.Available >= 0 {
		parts = append(parts, fmt.Sprintf("%d/%d free", i.Available, i.MaxUsers))
	}
	if i.SNR > 0 {
		parts = append(parts, fmt.Sprintf("SNR %d dB", i.SNR))
	}
	if i.Version != "" {
		parts = append(parts, "v"+i.Version)
	}
	return strings.Join(parts, " · ")
}

// matches reports whether the instance satisfies a free-text filter.
func (i Instance) matches(filter string) bool {
	if filter == "" {
		return true
	}
	f := strings.ToLower(filter)
	for _, field := range []string{i.Name, i.Location, i.Callsign, i.Host} {
		if strings.Contains(strings.ToLower(field), f) {
			return true
		}
	}
	return false
}

// publicInstancesURLForTest is the directory endpoint. It is a var purely so
// tests can point it at a local server.
var publicInstancesURLForTest = "https://instances.ubersdr.org/api/instances"

// FetchPublicInstances retrieves the public receiver directory.
func FetchPublicInstances(ctx context.Context) ([]Instance, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, publicInstancesURLForTest, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)

	client := &http.Client{
		Timeout:   15 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("directory returned HTTP %d", resp.StatusCode)
	}

	var payload struct {
		Instances []struct {
			Name        string `json:"name"`
			Callsign    string `json:"callsign"`
			Location    string `json:"location"`
			CountryName string `json:"country_name"`
			Host        string `json:"host"`
			Port        int    `json:"port"`
			TLS         bool   `json:"tls"`
			Version     string `json:"version"`
			MaxClients  int    `json:"max_clients"`
			Available   int    `json:"available_clients"`
			SNR         int    `json:"snr_0_30_mhz"`
		} `json:"instances"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("bad directory response: %w", err)
	}

	out := make([]Instance, 0, len(payload.Instances))
	for _, in := range payload.Instances {
		if in.Host == "" {
			continue
		}
		location := in.Location
		if location == "" {
			location = in.CountryName
		}
		out = append(out, Instance{
			Name:      in.Name,
			Callsign:  in.Callsign,
			Location:  location,
			Host:      joinHostPort(in.Host, in.Port, in.TLS),
			TLS:       in.TLS,
			Version:   in.Version,
			Available: in.Available,
			MaxUsers:  in.MaxClients,
			SNR:       in.SNR,
		})
	}

	// Receivers with free slots first, then the quietest, so the most usable
	// options are at the top of the list.
	sort.SliceStable(out, func(a, b int) bool {
		af, bf := out[a].Available > 0, out[b].Available > 0
		if af != bf {
			return af
		}
		return out[a].SNR > out[b].SNR
	})
	return out, nil
}

// joinHostPort omits the port when it is the default for the scheme, keeping
// displayed addresses tidy.
func joinHostPort(host string, port int, useTLS bool) string {
	if port == 0 || (useTLS && port == 443) || (!useTLS && port == 80) {
		return host
	}
	return net.JoinHostPort(host, fmt.Sprint(port))
}

// LocalDiscovery browses the LAN for receivers advertising _ubersdr._tcp.
type LocalDiscovery struct {
	mu    sync.Mutex
	found map[string]Instance

	Updates chan struct{} // signalled (non-blocking) whenever the set changes
}

func NewLocalDiscovery() *LocalDiscovery {
	return &LocalDiscovery{
		found:   make(map[string]Instance),
		Updates: make(chan struct{}, 1),
	}
}

// Run starts browsing and returns as soon as the query is issued — zeroconf
// keeps answering in the background until ctx is cancelled, so results arrive
// after this returns. Discovery is best-effort: on a network without mDNS it
// simply finds nothing rather than failing.
func (d *LocalDiscovery) Run(ctx context.Context) error {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return fmt.Errorf("mDNS unavailable: %w", err)
	}

	entries := make(chan *zeroconf.ServiceEntry, 16)
	go func() {
		for entry := range entries {
			d.add(entry)
		}
	}()

	return resolver.Browse(ctx, "_ubersdr._tcp", "local.", entries)
}

func (d *LocalDiscovery) add(entry *zeroconf.ServiceEntry) {
	if entry == nil || entry.Port == 0 {
		return
	}

	// Prefer IPv4; fall back to a bracketed IPv6 literal.
	var host string
	switch {
	case len(entry.AddrIPv4) > 0:
		host = entry.AddrIPv4[0].String()
	case len(entry.AddrIPv6) > 0:
		host = "[" + entry.AddrIPv6[0].String() + "]"
	default:
		return
	}

	txt := parseTXT(entry.Text)

	inst := Instance{
		Name:      unescapeDNSName(entry.Instance),
		Location:  txt["location"],
		Callsign:  txt["callsign"],
		Host:      net.JoinHostPort(host, fmt.Sprint(entry.Port)),
		Version:   txt["version"],
		Available: -1, // unknown until we ask the receiver itself
		Local:     true,
	}
	if inst.Host == "" {
		return
	}

	d.mu.Lock()
	_, existing := d.found[entry.Instance]
	d.found[entry.Instance] = inst
	d.mu.Unlock()

	d.notify()

	// Ask the receiver itself for its real name, location and free slots. The
	// mDNS instance name is usually just a hostname, so without this the Local
	// tab is far less informative than the public list.
	if !existing {
		go d.enrich(entry.Instance, inst)
	}
}

// unescapeDNSName decodes DNS presentation-format escaping, which mDNS uses for
// service instance names: "\DDD" is a byte given in decimal and "\X" is a
// literal X. Without this a receiver advertised as "ubersdr on ubersdr" shows
// up as "ubersdr\ on\ ubersdr".
func unescapeDNSName(name string) string {
	if !strings.Contains(name, `\`) {
		return name
	}

	var b strings.Builder
	b.Grow(len(name))
	for i := 0; i < len(name); i++ {
		if name[i] != '\\' {
			b.WriteByte(name[i])
			continue
		}
		// "\DDD": three decimal digits encode one byte. Bytes are written raw
		// so multi-byte UTF-8 escaped this way reassembles correctly.
		if i+3 < len(name) && isDigit(name[i+1]) && isDigit(name[i+2]) && isDigit(name[i+3]) {
			v := int(name[i+1]-'0')*100 + int(name[i+2]-'0')*10 + int(name[i+3]-'0')
			if v <= 255 {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		// "\X": the next byte is literal. A trailing backslash is dropped.
		if i+1 < len(name) {
			b.WriteByte(name[i+1])
			i++
		}
	}
	return b.String()
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// enrich fills in details from the receiver's own /api/description. Failure is
// not fatal: the entry simply keeps its mDNS-derived name.
func (d *LocalDiscovery) enrich(key string, inst Instance) {
	url := fmt.Sprintf("http://%s/api/description", inst.Host)
	client := &http.Client{Timeout: 5 * time.Second}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}

	var desc struct {
		Receiver struct {
			Name     string `json:"name"`
			Location string `json:"location"`
			Callsign string `json:"callsign"`
		} `json:"receiver"`
		MaxClients int    `json:"max_clients"`
		Available  int    `json:"available_clients"`
		Version    string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&desc); err != nil {
		return
	}

	d.mu.Lock()
	current, ok := d.found[key]
	if !ok {
		d.mu.Unlock()
		return
	}
	if desc.Receiver.Name != "" {
		current.Name = desc.Receiver.Name
	}
	if desc.Receiver.Location != "" {
		current.Location = desc.Receiver.Location
	}
	if desc.Receiver.Callsign != "" {
		current.Callsign = desc.Receiver.Callsign
	}
	if desc.Version != "" {
		current.Version = desc.Version
	}
	current.MaxUsers = desc.MaxClients
	current.Available = desc.Available
	d.found[key] = current
	d.mu.Unlock()

	d.notify()
}

// notify signals a change without blocking if a signal is already pending.
func (d *LocalDiscovery) notify() {
	select {
	case d.Updates <- struct{}{}:
	default:
	}
}

// parseTXT splits mDNS TXT records of the form "key=value".
func parseTXT(records []string) map[string]string {
	out := make(map[string]string, len(records))
	for _, rec := range records {
		if key, value, ok := strings.Cut(rec, "="); ok {
			out[key] = value
		}
	}
	return out
}

// Instances returns the receivers found so far, sorted by name.
func (d *LocalDiscovery) Instances() []Instance {
	d.mu.Lock()
	defer d.mu.Unlock()

	out := make([]Instance, 0, len(d.found))
	for _, inst := range d.found {
		out = append(out, inst)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out
}
