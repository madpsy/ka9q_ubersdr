package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// decoder_sse.go - Server-Sent Events hub for real-time digital decode streaming
//
// Endpoints:
//
//	GET /admin/decoder/stream  — admin only (session cookie auth)
//	GET /api/decoder/stream    — public, max 2 concurrent connections per IP
//
// Query params:
//
//	mode=FT8|FT4|WSPR|JS8|FT2          (optional, filter by mode)
//	band=20m_FT8|...                    (optional, filter by band name)
//	callsign=G4ABC,W1AW,...             (optional, up to 20 comma-delimited callsigns,
//	                                     exact match, case-insensitive)
//
// Each SSE event is a JSON object:
//
//	{ "type": "decode", "mode": "FT8", "band": "20m_FT8",
//	  "callsign": "...", "locator": "...", "snr": -10,
//	  "frequency": 14074000, "message": "...", "timestamp": "..." }
//
// A heartbeat event is sent every second:
//
//	event: heartbeat
//	data: {"last_spot": "2026-04-13T07:00:00Z"}   (or null if no spot yet)

// DecoderSSEEvent is the JSON payload sent to SSE clients
type DecoderSSEEvent struct {
	Type        string   `json:"type"`
	Mode        string   `json:"mode"`
	Band        string   `json:"band"`
	Callsign    string   `json:"callsign"`
	Locator     string   `json:"locator,omitempty"`
	Country     string   `json:"country,omitempty"`
	CountryCode string   `json:"country_code,omitempty"` // ISO 3166-1 alpha-2
	Continent   string   `json:"continent,omitempty"`
	SNR         int      `json:"snr"`
	Frequency   uint64   `json:"frequency"`
	Message     string   `json:"message,omitempty"`
	Timestamp   string   `json:"timestamp"`
	DistanceKm  *float64 `json:"distance_km,omitempty"`
	BearingDeg  *float64 `json:"bearing_deg,omitempty"`
}

// decoderSSEClient represents a single connected SSE client with optional filters
type decoderSSEClient struct {
	ch             chan string
	modeFilter     string          // empty = all modes
	bandFilter     string          // empty = all bands
	callsignFilter map[string]bool // nil/empty = all callsigns; non-nil = exact match set (uppercased), max 20
}

// DecoderSSEHub manages all connected SSE clients for the digital decoder feed
type DecoderSSEHub struct {
	mu           sync.RWMutex
	clients      map[*decoderSSEClient]struct{}
	lastSpotTime atomic.Int64 // Unix nanoseconds; 0 = no spot yet
	enabled      atomic.Bool  // true when the decoder subsystem is active
}

// NewDecoderSSEHub creates a new hub
func NewDecoderSSEHub() *DecoderSSEHub {
	return &DecoderSSEHub{
		clients: make(map[*decoderSSEClient]struct{}),
	}
}

// SetEnabled marks the hub as active (decoder subsystem is running).
// When not enabled, SSE handlers return 503 Service Unavailable.
func (h *DecoderSSEHub) SetEnabled(v bool) {
	h.enabled.Store(v)
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
	// Record the time of this spot
	h.lastSpotTime.Store(time.Now().UnixNano())

	evt := DecoderSSEEvent{
		Type:        "decode",
		Mode:        decode.Mode,
		Band:        decode.BandName,
		Callsign:    decode.Callsign,
		Locator:     decode.Locator,
		Country:     decode.Country,
		CountryCode: decode.CountryCode,
		Continent:   decode.Continent,
		SNR:         decode.SNR,
		Frequency:   decode.Frequency,
		Message:     decode.Message,
		Timestamp:   decode.Timestamp.UTC().Format(time.RFC3339),
		DistanceKm:  decode.DistanceKm,
		BearingDeg:  decode.BearingDeg,
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
		if len(c.callsignFilter) > 0 && !c.callsignFilter[strings.ToUpper(decode.Callsign)] {
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
func (h *DecoderSSEHub) heartbeatJSON() string {
	ns := h.lastSpotTime.Load()
	if ns == 0 {
		return "event: heartbeat\ndata: {\"last_spot\":null}\n\n"
	}
	t := time.Unix(0, ns).UTC().Format(time.RFC3339)
	return fmt.Sprintf("event: heartbeat\ndata: {\"last_spot\":%q}\n\n", t)
}

// HandleDecoderStream is the HTTP handler for /admin/decoder/stream
func HandleDecoderStream(hub *DecoderSSEHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Return 503 if the decoder subsystem is not active
		if !hub.enabled.Load() {
			http.Error(w, "decoder is not enabled", http.StatusServiceUnavailable)
			return
		}

		// Verify the client supports SSE flushing
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Parse optional filters from query string
		modeFilter := r.URL.Query().Get("mode")
		bandFilter := r.URL.Query().Get("band")
		callsignFilter := parseCallsignFilter(r.URL.Query().Get("callsign"))

		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

		// Register client
		client := &decoderSSEClient{
			ch:             make(chan string, 64),
			modeFilter:     modeFilter,
			bandFilter:     bandFilter,
			callsignFilter: callsignFilter,
		}
		hub.register(client)
		defer hub.unregister(client)

		log.Printf("DecoderSSE: client connected (mode=%q band=%q callsigns=%v remote=%s)", modeFilter, bandFilter, callsignFilterKeys(callsignFilter), r.RemoteAddr)

		// Send an initial comment + retry hint to confirm connection
		fmt.Fprintf(w, ": connected to decoder stream\nretry: 3000\n\n")
		flusher.Flush()

		// 1-second heartbeat ticker — keeps NAT alive and provides last-spot timestamp
		ticker := time.NewTicker(1 * time.Second)
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
				fmt.Fprint(w, hub.heartbeatJSON())
				flusher.Flush()
			}
		}
	}
}

// HandlePublicDecoderStream is the HTTP handler for /api/decoder/stream.
// It is identical to HandleDecoderStream but enforces a per-IP concurrent
// connection limit via limiter (typically 2 connections per IP).
// Bypassed IPs (timeout_bypass_ips or bypass_password) are exempt from the limit.
func HandlePublicDecoderStream(hub *DecoderSSEHub, limiter *SSEIPLimiter, serverConfig *ServerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Return 503 if the decoder subsystem is not active
		if !hub.enabled.Load() {
			http.Error(w, "decoder is not enabled", http.StatusServiceUnavailable)
			return
		}

		// Resolve the client IP (honour X-Forwarded-For set by a trusted reverse proxy)
		ip := r.RemoteAddr
		if host, _, err := net.SplitHostPort(ip); err == nil {
			ip = host
		}
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			// Take only the first (leftmost) address — the original client
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
			// Enforce concurrent connection limit.
			// release() is idempotent (sync.Once) so it is safe to call from both
			// the context-watcher goroutine below and the defer statement.
			release, ok := limiter.Acquire(ip)
			if !ok {
				http.Error(w, "too many connections from your IP", http.StatusTooManyRequests)
				return
			}
			// Release the slot as soon as the client disconnects, even if the
			// handler goroutine is still unwinding (e.g. behind a reverse proxy
			// that delays context cancellation propagation).
			go func() { <-r.Context().Done(); release() }()
			defer release()
		}

		// Verify the client supports SSE flushing
		flusher, ok2 := w.(http.Flusher)
		if !ok2 {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Parse optional filters from query string
		modeFilter := r.URL.Query().Get("mode")
		bandFilter := r.URL.Query().Get("band")
		callsignFilter := parseCallsignFilter(r.URL.Query().Get("callsign"))

		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		// Register client
		client := &decoderSSEClient{
			ch:             make(chan string, 64),
			modeFilter:     modeFilter,
			bandFilter:     bandFilter,
			callsignFilter: callsignFilter,
		}
		hub.register(client)
		defer hub.unregister(client)

		log.Printf("DecoderSSE (public): client connected (mode=%q band=%q callsigns=%v ip=%s)", modeFilter, bandFilter, callsignFilterKeys(callsignFilter), ip)

		fmt.Fprintf(w, ": connected to decoder stream\nretry: 3000\n\n")
		flusher.Flush()

		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				log.Printf("DecoderSSE (public): client disconnected (ip=%s)", ip)
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

// parseCallsignFilter parses a comma-delimited callsign list (max 20) into a lookup map.
// All callsigns are uppercased. Returns nil if the input is empty or contains no valid entries.
func parseCallsignFilter(raw string) map[string]bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	const maxCallsigns = 20
	parts := strings.Split(raw, ",")
	m := make(map[string]bool, min(len(parts), maxCallsigns))
	for _, p := range parts {
		cs := strings.ToUpper(strings.TrimSpace(p))
		if cs != "" {
			m[cs] = true
		}
		if len(m) >= maxCallsigns {
			break
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// callsignFilterKeys returns the keys of a callsign filter map as a sorted slice,
// for use in log messages.
func callsignFilterKeys(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
