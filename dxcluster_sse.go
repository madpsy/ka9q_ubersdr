package main

// dxcluster_sse.go - Server-Sent Events hub for real-time DX cluster spot streaming
//
// Endpoint:
//
//	GET /api/dxcluster/stream  — public, max 2 concurrent connections per IP
//
// Query params:
//
//	band=20m|40m|...                    (optional, filter by amateur band label)
//	callsign=DL1ABC,W1AW,...            (optional, up to 20 comma-delimited DX callsigns,
//	                                     exact match, case-insensitive)
//
// Each SSE event is a JSON object:
//
//	{ "type": "dx_spot", "frequency": 14225000, "dx_call": "DL1ABC",
//	  "spotter": "MM3NDH", "comment": "CQ FT8", "band": "20m",
//	  "country": "Germany", "country_code": "DE", "continent": "EU",
//	  "time_offset": 1.0, "timestamp": "2026-07-04T15:00:00Z" }
//
// A heartbeat event is sent every 30 s:
//
//	event: heartbeat
//	data: {"last_spot": "2026-07-04T15:00:00Z"}   (or null if no spot yet)

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DXClusterSSEEvent is the JSON payload sent to SSE clients for each DX spot.
// The raw line from the cluster is intentionally excluded.
type DXClusterSSEEvent struct {
	Type        string  `json:"type"`
	Frequency   float64 `json:"frequency"` // Hz
	DXCall      string  `json:"dx_call"`   // Callsign being spotted
	Spotter     string  `json:"spotter"`   // Callsign of the spotter
	Comment     string  `json:"comment,omitempty"`
	Band        string  `json:"band"` // Amateur band label, e.g. "20m"
	Country     string  `json:"country,omitempty"`
	CountryCode string  `json:"country_code,omitempty"` // ISO 3166-1 alpha-2
	Continent   string  `json:"continent,omitempty"`
	TimeOffset  float64 `json:"time_offset,omitempty"` // UTC offset in hours at DX station location
	Timestamp   string  `json:"timestamp"`
}

// dxClusterSSEClient represents a single connected SSE client with optional filters.
type dxClusterSSEClient struct {
	ch             chan string
	bandFilter     string          // empty = all bands
	callsignFilter map[string]bool // nil/empty = all callsigns; non-nil = exact match set (uppercased), max 20
}

// DXClusterSSEHub manages all connected SSE clients for the DX cluster spot feed.
type DXClusterSSEHub struct {
	mu           sync.RWMutex
	clients      map[*dxClusterSSEClient]struct{}
	lastSpotTime atomic.Int64 // Unix nanoseconds; 0 = no spot yet
	enabled      atomic.Bool  // true when the DX cluster is enabled in config
}

// NewDXClusterSSEHub creates a new hub.
func NewDXClusterSSEHub() *DXClusterSSEHub {
	return &DXClusterSSEHub{
		clients: make(map[*dxClusterSSEClient]struct{}),
	}
}

// SetEnabled marks the hub as active (DX cluster is enabled in config).
// When not enabled, the SSE handler returns 503 Service Unavailable.
func (h *DXClusterSSEHub) SetEnabled(v bool) {
	h.enabled.Store(v)
}

// register adds a client to the hub.
func (h *DXClusterSSEHub) register(c *dxClusterSSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

// unregister removes a client from the hub.
func (h *DXClusterSSEHub) unregister(c *dxClusterSSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	close(c.ch)
}

// Broadcast sends a DX spot to all matching clients.
func (h *DXClusterSSEHub) Broadcast(spot DXSpot) {
	// Record the time of this spot for heartbeat.
	h.lastSpotTime.Store(time.Now().UnixNano())

	evt := DXClusterSSEEvent{
		Type:        "dx_spot",
		Frequency:   spot.Frequency,
		DXCall:      spot.DXCall,
		Spotter:     spot.Spotter,
		Comment:     spot.Comment,
		Band:        spot.Band,
		Country:     spot.Country,
		CountryCode: spot.CountryCode,
		Continent:   spot.Continent,
		TimeOffset:  spot.TimeOffset,
		Timestamp:   spot.Time.UTC().Format(time.RFC3339),
	}

	data, err := json.Marshal(evt)
	if err != nil {
		log.Printf("DXClusterSSEHub: failed to marshal event: %v", err)
		return
	}
	line := fmt.Sprintf("data: %s\n\n", data)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.clients {
		// Apply server-side filters.
		if c.bandFilter != "" && c.bandFilter != spot.Band {
			continue
		}
		if len(c.callsignFilter) > 0 && !c.callsignFilter[strings.ToUpper(spot.DXCall)] {
			continue
		}
		// Non-blocking send — drop if client is slow.
		select {
		case c.ch <- line:
		default:
		}
	}
}

// heartbeatJSON builds the heartbeat SSE event line.
func (h *DXClusterSSEHub) heartbeatJSON() string {
	ns := h.lastSpotTime.Load()
	if ns == 0 {
		return "event: heartbeat\ndata: {\"last_spot\":null}\n\n"
	}
	t := time.Unix(0, ns).UTC().Format(time.RFC3339)
	return fmt.Sprintf("event: heartbeat\ndata: {\"last_spot\":%q}\n\n", t)
}

// HandlePublicDXClusterStream is the HTTP handler for GET /api/dxcluster/stream.
// It enforces a per-IP concurrent connection limit via limiter (typically 2 per IP).
// Bypassed IPs (timeout_bypass_ips or bypass_password) are exempt from the limit.
func HandlePublicDXClusterStream(hub *DXClusterSSEHub, limiter *SSEIPLimiter, serverConfig *ServerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Return 503 if the DX cluster is not enabled.
		if !hub.enabled.Load() {
			http.Error(w, "DX cluster is not enabled", http.StatusServiceUnavailable)
			return
		}

		// Resolve the client IP (honour X-Forwarded-For set by a trusted reverse proxy).
		ip := r.RemoteAddr
		if host, _, err := net.SplitHostPort(ip); err == nil {
			ip = host
		}
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			end := len(fwd)
			for i, c := range fwd {
				if c == ',' {
					end = i
					break
				}
			}
			ip = fwd[:end]
		}

		// Bypassed IPs are exempt from the concurrent connection limit.
		if !serverConfig.IsIPTimeoutBypassed(ip) {
			release, ok := limiter.Acquire(ip)
			if !ok {
				http.Error(w, "too many connections from your IP", http.StatusTooManyRequests)
				return
			}
			go func() { <-r.Context().Done(); release() }()
			defer release()
		}

		// Verify the client supports SSE flushing.
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Parse optional filters.
		bandFilter := r.URL.Query().Get("band")
		callsignFilter := parseCallsignFilter(r.URL.Query().Get("callsign"))

		// Set SSE headers.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		// Register client.
		client := &dxClusterSSEClient{
			ch:             make(chan string, 64),
			bandFilter:     bandFilter,
			callsignFilter: callsignFilter,
		}
		hub.register(client)
		defer hub.unregister(client)

		log.Printf("DXClusterSSE: client connected (band=%q callsigns=%v ip=%s)", bandFilter, callsignFilterKeys(callsignFilter), ip)

		// Send initial comment + retry hint to confirm connection.
		fmt.Fprintf(w, ": connected to DX cluster stream\nretry: 3000\n\n")
		flusher.Flush()

		// 30-second heartbeat ticker — keeps NAT alive and provides last-spot timestamp.
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				log.Printf("DXClusterSSE: client disconnected (ip=%s)", ip)
				return
			case msg, ok := <-client.ch:
				if !ok {
					return
				}
				if _, err := fmt.Fprint(w, msg); err != nil {
					return
				}
				flusher.Flush()
			case <-ticker.C:
				if _, err := fmt.Fprint(w, hub.heartbeatJSON()); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}
