package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// decoder_sse.go - Server-Sent Events hub for real-time digital decode streaming
//
// Endpoint: GET /admin/decoder/stream
// Auth:     AdminHandler.AuthMiddleware (session cookie)
// Query params:
//   mode=FT8|FT4|WSPR|JS8|FT2   (optional, filter by mode)
//   band=20m_FT8|...             (optional, filter by band name)
//
// Each SSE event is a JSON object:
//   { "type": "decode", "mode": "FT8", "band": "20m_FT8",
//     "callsign": "...", "locator": "...", "snr": -10,
//     "frequency": 14074000, "message": "...", "timestamp": "..." }

// DecoderSSEEvent is the JSON payload sent to SSE clients
type DecoderSSEEvent struct {
	Type       string   `json:"type"`
	Mode       string   `json:"mode"`
	Band       string   `json:"band"`
	Callsign   string   `json:"callsign"`
	Locator    string   `json:"locator,omitempty"`
	Country    string   `json:"country,omitempty"`
	Continent  string   `json:"continent,omitempty"`
	SNR        int      `json:"snr"`
	Frequency  uint64   `json:"frequency"`
	Message    string   `json:"message,omitempty"`
	Timestamp  string   `json:"timestamp"`
	DistanceKm *float64 `json:"distance_km,omitempty"`
	BearingDeg *float64 `json:"bearing_deg,omitempty"`
}

// decoderSSEClient represents a single connected SSE client with optional filters
type decoderSSEClient struct {
	ch         chan string
	modeFilter string // empty = all modes
	bandFilter string // empty = all bands
}

// DecoderSSEHub manages all connected SSE clients for the digital decoder feed
type DecoderSSEHub struct {
	mu      sync.RWMutex
	clients map[*decoderSSEClient]struct{}
}

// NewDecoderSSEHub creates a new hub
func NewDecoderSSEHub() *DecoderSSEHub {
	return &DecoderSSEHub{
		clients: make(map[*decoderSSEClient]struct{}),
	}
}

// register adds a client to the hub
func (h *DecoderSSEHub) register(c *decoderSSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

// unregister removes a client from the hub
func (h *DecoderSSEHub) unregister(c *decoderSSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	close(c.ch)
}

// Broadcast sends a decode to all matching clients
func (h *DecoderSSEHub) Broadcast(decode DecodeInfo) {
	evt := DecoderSSEEvent{
		Type:       "decode",
		Mode:       decode.Mode,
		Band:       decode.BandName,
		Callsign:   decode.Callsign,
		Locator:    decode.Locator,
		Country:    decode.Country,
		Continent:  decode.Continent,
		SNR:        decode.SNR,
		Frequency:  decode.Frequency,
		Message:    decode.Message,
		Timestamp:  decode.Timestamp.UTC().Format(time.RFC3339),
		DistanceKm: decode.DistanceKm,
		BearingDeg: decode.BearingDeg,
	}

	data, err := json.Marshal(evt)
	if err != nil {
		log.Printf("DecoderSSEHub: failed to marshal event: %v", err)
		return
	}
	line := fmt.Sprintf("data: %s\n\n", data)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.clients {
		// Apply server-side filters
		if c.modeFilter != "" && c.modeFilter != decode.Mode {
			continue
		}
		if c.bandFilter != "" && c.bandFilter != decode.BandName {
			continue
		}
		// Non-blocking send — drop if client is slow
		select {
		case c.ch <- line:
		default:
		}
	}
}

// HandleDecoderStream is the HTTP handler for /admin/decoder/stream
func HandleDecoderStream(hub *DecoderSSEHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Verify the client supports SSE flushing
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Parse optional filters from query string
		modeFilter := r.URL.Query().Get("mode")
		bandFilter := r.URL.Query().Get("band")

		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

		// Register client
		client := &decoderSSEClient{
			ch:         make(chan string, 64),
			modeFilter: modeFilter,
			bandFilter: bandFilter,
		}
		hub.register(client)
		defer hub.unregister(client)

		log.Printf("DecoderSSE: client connected (mode=%q band=%q remote=%s)", modeFilter, bandFilter, r.RemoteAddr)

		// Send an initial comment + retry hint to confirm connection
		fmt.Fprintf(w, ": connected to decoder stream\nretry: 3000\n\n")
		flusher.Flush()

		// Keep-alive ticker (every 15s — shorter than typical proxy timeouts)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				log.Printf("DecoderSSE: client disconnected (%s)", r.RemoteAddr)
				return
			case msg, ok := <-client.ch:
				if !ok {
					return
				}
				fmt.Fprint(w, msg)
				flusher.Flush()
			case <-ticker.C:
				// SSE keep-alive comment
				fmt.Fprintf(w, ": keepalive\n\n")
				flusher.Flush()
			}
		}
	}
}
