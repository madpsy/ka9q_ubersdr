package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// cwskimmer_sse.go - Server-Sent Events hub for real-time CW Skimmer spot streaming
//
// Endpoint: GET /admin/cwskimmer/stream
// Auth:     AdminHandler.AuthMiddleware (session cookie)
// Query params:
//   band=40m|80m|...   (optional, filter by amateur band label, e.g. "40m")
//
// Each SSE event is a JSON object:
//   { "type": "cw_spot", "band": "40m", "frequency": 7035300,
//     "callsign": "SM4SEF", "spotter": "MM3NDH", "snr": 12, "wpm": 19,
//     "comment": "CQ", "country": "...", "continent": "EU",
//     "distance_km": 1234.5, "bearing_deg": 45.0, "timestamp": "..." }
//
// A heartbeat event is sent every second:
//   event: heartbeat
//   data: {"last_spot": "2026-04-13T07:00:00Z"}   (or null if no spot yet)

// CWSkimmerSSEEvent is the JSON payload sent to SSE clients
type CWSkimmerSSEEvent struct {
	Type       string   `json:"type"`
	Band       string   `json:"band"`
	Frequency  float64  `json:"frequency"`
	Callsign   string   `json:"callsign"`
	Spotter    string   `json:"spotter"`
	SNR        int      `json:"snr"`
	WPM        int      `json:"wpm"`
	Comment    string   `json:"comment,omitempty"`
	Country    string   `json:"country,omitempty"`
	Continent  string   `json:"continent,omitempty"`
	CQZone     int      `json:"cq_zone,omitempty"`
	DistanceKm *float64 `json:"distance_km,omitempty"`
	BearingDeg *float64 `json:"bearing_deg,omitempty"`
	Timestamp  string   `json:"timestamp"`
}

// cwSkimmerSSEClient represents a single connected SSE client with optional band filter
type cwSkimmerSSEClient struct {
	ch         chan string
	bandFilter string // empty = all bands
}

// CWSkimmerSSEHub manages all connected SSE clients for the CW skimmer feed
type CWSkimmerSSEHub struct {
	mu           sync.RWMutex
	clients      map[*cwSkimmerSSEClient]struct{}
	lastSpotTime atomic.Int64 // Unix nanoseconds; 0 = no spot yet
}

// NewCWSkimmerSSEHub creates a new hub
func NewCWSkimmerSSEHub() *CWSkimmerSSEHub {
	return &CWSkimmerSSEHub{
		clients: make(map[*cwSkimmerSSEClient]struct{}),
	}
}

// register adds a client to the hub
func (h *CWSkimmerSSEHub) register(c *cwSkimmerSSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

// unregister removes a client from the hub
func (h *CWSkimmerSSEHub) unregister(c *cwSkimmerSSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	close(c.ch)
}

// Broadcast sends a CW spot to all matching clients
func (h *CWSkimmerSSEHub) Broadcast(spot CWSkimmerSpot) {
	// Record the time of this spot
	h.lastSpotTime.Store(time.Now().UnixNano())

	evt := CWSkimmerSSEEvent{
		Type:       "cw_spot",
		Band:       spot.Band,
		Frequency:  spot.Frequency,
		Callsign:   spot.DXCall,
		Spotter:    spot.Spotter,
		SNR:        spot.SNR,
		WPM:        spot.WPM,
		Comment:    spot.Comment,
		Country:    spot.Country,
		Continent:  spot.Continent,
		CQZone:     spot.CQZone,
		DistanceKm: spot.DistanceKm,
		BearingDeg: spot.BearingDeg,
		Timestamp:  spot.Time.UTC().Format(time.RFC3339),
	}

	data, err := json.Marshal(evt)
	if err != nil {
		log.Printf("CWSkimmerSSEHub: failed to marshal event: %v", err)
		return
	}
	line := fmt.Sprintf("data: %s\n\n", data)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.clients {
		// Apply server-side band filter
		if c.bandFilter != "" && c.bandFilter != spot.Band {
			continue
		}
		// Non-blocking send — drop if client is slow
		select {
		case c.ch <- line:
		default:
		}
	}
}

// heartbeatJSON builds the heartbeat SSE data line
func (h *CWSkimmerSSEHub) heartbeatJSON() string {
	ns := h.lastSpotTime.Load()
	if ns == 0 {
		return "event: heartbeat\ndata: {\"last_spot\":null}\n\n"
	}
	t := time.Unix(0, ns).UTC().Format(time.RFC3339)
	return fmt.Sprintf("event: heartbeat\ndata: {\"last_spot\":%q}\n\n", t)
}

// HandleCWSkimmerStream is the HTTP handler for /admin/cwskimmer/stream
func HandleCWSkimmerStream(hub *CWSkimmerSSEHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Verify the client supports SSE flushing
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Parse optional band filter from query string
		bandFilter := r.URL.Query().Get("band")

		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

		// Register client
		client := &cwSkimmerSSEClient{
			ch:         make(chan string, 64),
			bandFilter: bandFilter,
		}
		hub.register(client)
		defer hub.unregister(client)

		log.Printf("CWSkimmerSSE: client connected (band=%q remote=%s)", bandFilter, r.RemoteAddr)

		// Send an initial comment + retry hint to confirm connection
		fmt.Fprintf(w, ": connected to CW skimmer stream\nretry: 3000\n\n")
		flusher.Flush()

		// 1-second heartbeat ticker — keeps NAT alive and provides last-spot timestamp
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				log.Printf("CWSkimmerSSE: client disconnected (%s)", r.RemoteAddr)
				return
			case msg, ok := <-client.ch:
				if !ok {
					return
				}
				fmt.Fprint(w, msg)
				flusher.Flush()
			case <-ticker.C:
				fmt.Fprint(w, hub.heartbeatJSON())
				flusher.Flush()
			}
		}
	}
}
