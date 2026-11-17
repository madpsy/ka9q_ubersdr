package main

// Other public UberSDR receivers, for the dots on v2's start-overlay map.
//
// The list comes from the collector's GET /api/instances?minimal=true. The
// receiver fetches it itself, every 15 minutes — but only when it reports to
// the directory itself (instance_reporting.enabled), so a private receiver never
// contacts it for this — and the browser only ever asks
// this receiver for it. That has two effects. A visitor's address goes to
// nobody but the receiver they chose to open. And a receiver with no route to
// the internet, or a collector that is slow or down, costs the page nothing: the
// handler answers from memory, and before the first successful fetch it answers
// with an empty list.
//
// A failed fetch keeps the last good copy, and the next attempt comes sooner,
// backing off from a minute to the normal interval. A copy older than
// nearbyMaxAge is dropped instead of served, because receivers come and go and a
// day-old map shows dots that are no longer there.
//
// The response is capped at nearbyMaxBytes after decompression. The live list is
// about 27 KB for 77 receivers, so the cap leaves room for roughly ten times as
// many before anything is refused. A response over the cap is treated as a
// failure, not truncated.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	nearbyRefreshInterval = 15 * time.Minute
	nearbyRetryMin        = 1 * time.Minute
	// Shortly after boot rather than at once: the same 30 s the instance
	// reporter waits before its first call to this collector, so a server in a
	// crash loop does not fetch the directory on every restart.
	nearbyStartDelay = 30 * time.Second
	// The whole request — connect, TLS, headers and body. The list is ~27 KB and
	// answers in ~100 ms; a collector that has not managed it in 10 s is not
	// going to, and with the next try at most 15 minutes away there is nothing
	// to gain from waiting longer.
	nearbyFetchTimeout = 10 * time.Second
	nearbyMaxBytes        = 250 * 1024
	nearbyMaxAge          = 6 * time.Hour
	nearbyMaxEntries      = 2000
)

// NearbyReceiver is one entry as served to the browser: only what the map shows
// or links to.
type NearbyReceiver struct {
	ID               string  `json:"id"`
	Callsign         string  `json:"callsign,omitempty"`
	Name             string  `json:"name,omitempty"`
	Location         string  `json:"location,omitempty"`
	Lat              float64 `json:"lat"`
	Lon              float64 `json:"lon"`
	CountryCode      string  `json:"country_code,omitempty"`
	PublicURL        string  `json:"public_url"`
	MaxClients       int     `json:"max_clients"`
	AvailableClients int     `json:"available_clients"`
	// Great-circle distance from this receiver, when it has a position.
	DistanceKm *float64 `json:"distance_km,omitempty"`
}

// collectorMinimalInstance mirrors the collector's MinimalInstance.
type collectorMinimalInstance struct {
	ID               string  `json:"id"`
	Callsign         string  `json:"callsign"`
	Name             string  `json:"name"`
	Location         string  `json:"location"`
	Latitude         float64 `json:"latitude"`
	Longitude        float64 `json:"longitude"`
	CountryCode      string  `json:"country_code"`
	PublicURL        string  `json:"public_url"`
	MaxClients       int     `json:"max_clients"`
	AvailableClients int     `json:"available_clients"`
}

// NearbyReceivers keeps the last good copy of the directory.
type NearbyReceivers struct {
	url    string
	client *http.Client
	// selfID returns this receiver's public UUID, or "" when it is not known
	// (reporting off, or not registered yet). Asked on every request, because it
	// can arrive after the first fetch has landed.
	selfID func() string
	// origin returns this receiver's configured position; ok is false when it
	// has none. Read at each fetch, so a position set in the admin page takes
	// effect on the next refresh.
	origin func() (lat, lon float64, ok bool)

	mu        sync.RWMutex
	list      []NearbyReceiver
	fetchedAt time.Time
	lastErr   string
}

// NewNearbyReceivers builds the fetcher for the collector at host:port. It does
// not start fetching; call Run.
func NewNearbyReceivers(host string, port int, selfID func() string, origin func() (float64, float64, bool)) *NearbyReceivers {
	hostPort := host
	if port != 0 && port != 443 {
		hostPort = net.JoinHostPort(host, fmt.Sprint(port))
	}
	return &NearbyReceivers{
		url:    "https://" + hostPort + "/api/instances?minimal=true&online_only=true",
		client: newNearbyHTTPClient(),
		selfID: selfID,
		origin: origin,
	}
}

// Every stage gets its own deadline on top of the overall one, so a collector
// that accepts the connection and then says nothing cannot hold a fetch for the
// full timeout at each stage.
func newNearbyHTTPClient() *http.Client {
	return &http.Client{
		Timeout: nearbyFetchTimeout,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 5 * time.Second,
			MaxIdleConns:          1,
			IdleConnTimeout:       30 * time.Second,
		},
	}
}

// nearbyUserAgent names this fetch, so the collector's logs can tell it apart.
var nearbyUserAgent = "UberSDR/" + Version + " (nearby receivers; https://github.com/cwsl/ka9q_ubersdr)"

// Run fetches nearbyStartDelay after it is called and then every
// nearbyRefreshInterval until ctx is done. A
// failure retries sooner, doubling from nearbyRetryMin up to the normal
// interval, so a receiver that was briefly offline at boot fills its map within
// a minute or two rather than fifteen.
func (n *NearbyReceivers) Run(ctx context.Context) {
	start := time.NewTimer(nearbyStartDelay)
	select {
	case <-ctx.Done():
		start.Stop()
		return
	case <-start.C:
	}

	retry := nearbyRetryMin
	for {
		wait := nearbyRefreshInterval
		if err := n.refresh(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			n.mu.Lock()
			changed := n.lastErr != err.Error()
			n.lastErr = err.Error()
			n.mu.Unlock()
			// Once per distinct error: an offline receiver would otherwise log the
			// same line every few minutes forever.
			if changed {
				log.Printf("Nearby receivers: fetch failed (keeping previous list): %v", err)
			}
			wait = retry
			retry *= 2
			if retry > nearbyRefreshInterval {
				retry = nearbyRefreshInterval
			}
		} else {
			retry = nearbyRetryMin
		}

		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

func (n *NearbyReceivers) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", nearbyUserAgent)
	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("collector returned HTTP %d", resp.StatusCode)
	}
	list, err := parseNearbyReceivers(resp.Body)
	if err != nil {
		return err
	}
	if n.origin != nil {
		if lat, lon, ok := n.origin(); ok {
			sortNearbyByDistance(list, lat, lon)
		}
	}

	n.mu.Lock()
	n.list = list
	n.fetchedAt = time.Now()
	recovered := n.lastErr != ""
	n.lastErr = ""
	n.mu.Unlock()
	if recovered {
		log.Printf("Nearby receivers: fetch recovered (%d receivers)", len(list))
	}
	return nil
}

// sortNearbyByDistance fills in DistanceKm from (lat, lon) and orders the list
// nearest first. Stable, so receivers at the same spot keep the collector's
// order.
func sortNearbyByDistance(list []NearbyReceiver, lat, lon float64) {
	for i := range list {
		d, _ := CalculateDistanceAndBearing(lat, lon, list[i].Lat, list[i].Lon)
		d = math.Round(d*10) / 10
		list[i].DistanceKm = &d
	}
	sort.SliceStable(list, func(i, j int) bool {
		return *list[i].DistanceKm < *list[j].DistanceKm
	})
}

var errNearbyTooLarge = errors.New("collector response exceeds size limit")

// parseNearbyReceivers reads at most nearbyMaxBytes of body and returns the
// usable entries. The limit is applied to the decoded stream, so it bounds what
// is held in memory whatever the transfer encoding.
func parseNearbyReceivers(body io.Reader) ([]NearbyReceiver, error) {
	data, err := io.ReadAll(io.LimitReader(body, nearbyMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > nearbyMaxBytes {
		return nil, errNearbyTooLarge
	}
	var doc struct {
		Instances []collectorMinimalInstance `json:"instances"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("bad collector JSON: %w", err)
	}
	if doc.Instances == nil {
		return nil, errors.New("collector JSON has no instances array")
	}

	out := make([]NearbyReceiver, 0, len(doc.Instances))
	seen := make(map[string]bool, len(doc.Instances))
	for _, in := range doc.Instances {
		if len(out) >= nearbyMaxEntries {
			break
		}
		r, ok := sanitizeNearbyReceiver(in)
		if !ok || seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		out = append(out, r)
	}
	return out, nil
}

// sanitizeNearbyReceiver drops entries the map cannot place or link to, and
// trims the text that ends up in a tooltip. Escaping is the browser's job; this
// only keeps the strings to a sensible size.
func sanitizeNearbyReceiver(in collectorMinimalInstance) (NearbyReceiver, bool) {
	lat, lon := in.Latitude, in.Longitude
	if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) ||
		lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat == 0 && lon == 0) {
		return NearbyReceiver{}, false
	}
	id := strings.TrimSpace(in.ID)
	if id == "" || len(id) > 64 {
		return NearbyReceiver{}, false
	}
	pub, ok := cleanNearbyURL(in.PublicURL)
	if !ok {
		return NearbyReceiver{}, false
	}
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > 10000 {
			return 10000
		}
		return v
	}
	return NearbyReceiver{
		ID:               id,
		Callsign:         nearbyText(in.Callsign, 24),
		Name:             nearbyText(in.Name, 100),
		Location:         nearbyText(in.Location, 100),
		Lat:              lat,
		Lon:              lon,
		CountryCode:      nearbyText(strings.ToLower(in.CountryCode), 2),
		PublicURL:        pub,
		MaxClients:       clamp(in.MaxClients),
		AvailableClients: clamp(in.AvailableClients),
	}, true
}

// cleanNearbyURL accepts only absolute http(s) URLs with a host and no
// credentials, since the browser turns this into a link.
func cleanNearbyURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 512 {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil {
		return "", false
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", false
	}
	return u.String(), true
}

// nearbyText trims s, drops invalid UTF-8 and caps it at max characters.
func nearbyText(s string, max int) string {
	return truncRunes(strings.TrimSpace(strings.ToValidUTF8(s, "")), max)
}

// Snapshot returns the current list without this receiver, and when it was
// fetched. Empty (never nil) when nothing has been fetched yet or the last good
// copy has gone stale.
func (n *NearbyReceivers) Snapshot() ([]NearbyReceiver, time.Time) {
	n.mu.RLock()
	list, at := n.list, n.fetchedAt
	n.mu.RUnlock()
	if at.IsZero() || time.Since(at) > nearbyMaxAge {
		return []NearbyReceiver{}, time.Time{}
	}
	self := ""
	if n.selfID != nil {
		self = n.selfID()
	}
	out := make([]NearbyReceiver, 0, len(list))
	for _, r := range list {
		if self != "" && r.ID == self {
			continue
		}
		out = append(out, r)
	}
	return out, at
}

// ServeHTTP answers GET /api/nearby-receivers from memory. It never touches the
// network.
func (n *NearbyReceivers) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	list, at := n.Snapshot()
	resp := map[string]interface{}{
		"receivers": list,
	}
	if !at.IsZero() {
		resp["fetched_at"] = at.UTC().Format(time.RFC3339)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_ = json.NewEncoder(w).Encode(resp)
}
