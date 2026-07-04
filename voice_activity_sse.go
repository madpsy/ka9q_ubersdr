package main

// voice_activity_sse.go - Server-Sent Events hub for real-time voice activity streaming
//
// Endpoint:
//
//	GET /api/voice-activity/stream  — public, max 2 concurrent connections per IP
//
// Query params:
//
//	band=20m|40m|...   (optional, filter to a single band)
//
// Each SSE event is a JSON object representing one active voice signal:
//
//	{ "type": "voice_activity", "band": "20m", "timestamp": "...",
//	  "estimated_dial_freq": 14225000, "mode": "USB",
//	  "snr": 12.4, "confidence": 0.87,
//	  "dx_callsign": "DL1ABC", "dx_country": "Germany", ... }
//
// Broadcast strategy:
//
//	The background scanner runs every 5 s and calls MaybeBroadcast for each band.
//	An activity is broadcast immediately when first detected, then re-broadcast
//	every 60 s while it remains active.  Clients should upsert events into a local
//	map keyed by (band, estimated_dial_freq) and expire entries not updated within
//	their chosen window (e.g. 10 minutes).
//
// A heartbeat event is sent every 30 s:
//
//	event: heartbeat
//	data: {"last_activity": "2026-07-04T15:00:00Z"}   (or null if no activity yet)

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// VoiceActivitySSEEvent is the JSON payload sent to SSE clients for each active signal.
type VoiceActivitySSEEvent struct {
	Type              string  `json:"type"`
	Band              string  `json:"band"`
	Timestamp         string  `json:"timestamp"`
	EstimatedDialFreq uint64  `json:"estimated_dial_freq"`
	Mode              string  `json:"mode"`
	SNR               float32 `json:"snr"`
	Confidence        float32 `json:"confidence"`
	AvgSignalDB       float32 `json:"avg_signal_db"`
	PeakSignalDB      float32 `json:"peak_signal_db"`
	Bandwidth         uint64  `json:"bandwidth"`
	DXCallsign        string  `json:"dx_callsign,omitempty"`
	DXCountry         string  `json:"dx_country,omitempty"`
	DXCountryCode     string  `json:"dx_country_code,omitempty"`
	DXContinent       string  `json:"dx_continent,omitempty"`
}

// voiceActivitySSEClient represents a single connected SSE client.
type voiceActivitySSEClient struct {
	ch         chan string
	bandFilter string // empty = all bands
}

// VoiceActivitySSEHub manages all connected SSE clients for the voice activity feed.
// It tracks when each (band, dialFreq) was last broadcast and suppresses re-sends
// until 60 s have elapsed, ensuring a new client sees any active station within
// at most 60 s of connecting.
type VoiceActivitySSEHub struct {
	mu      sync.RWMutex
	clients map[*voiceActivitySSEClient]struct{}
	enabled atomic.Bool // true when the noise floor monitor is active

	// lastSent tracks the last broadcast time per band per dial frequency.
	// Rebuilt from current activities after each broadcast; gone stations
	// naturally fall out of the map.
	lastSentMu sync.Mutex
	lastSent   map[string]map[uint64]time.Time // band → dialFreq → last sent

	lastActivityTime atomic.Int64 // Unix nanoseconds of most recent broadcast; 0 = none
}

// NewVoiceActivitySSEHub creates a new hub.
func NewVoiceActivitySSEHub() *VoiceActivitySSEHub {
	return &VoiceActivitySSEHub{
		clients:  make(map[*voiceActivitySSEClient]struct{}),
		lastSent: make(map[string]map[uint64]time.Time),
	}
}

// SetEnabled marks the hub as active (noise floor monitor is running).
// When not enabled, the SSE handler returns 503 Service Unavailable.
func (h *VoiceActivitySSEHub) SetEnabled(v bool) {
	h.enabled.Store(v)
}

// register adds a client to the hub.
func (h *VoiceActivitySSEHub) register(c *voiceActivitySSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

// unregister removes a client from the hub.
func (h *VoiceActivitySSEHub) unregister(c *voiceActivitySSEClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
	close(c.ch)
}

// MaybeBroadcast is called by the background scanner after each band scan.
// It broadcasts each activity that is either new or has not been sent in the
// last 60 s.  Activities that are no longer present simply stop being sent;
// clients expire them via their own time window.
func (h *VoiceActivitySSEHub) MaybeBroadcast(band string, activities []VoiceActivity, nfm *NoiseFloorMonitor) {
	if len(activities) == 0 {
		return
	}

	now := time.Now()
	const rebroadcastInterval = 60 * time.Second

	h.lastSentMu.Lock()

	bandMap := h.lastSent[band]
	if bandMap == nil {
		bandMap = make(map[uint64]time.Time)
		h.lastSent[band] = bandMap
	}

	// Collect activities that are due for broadcast.
	var due []VoiceActivity
	for _, act := range activities {
		if t, seen := bandMap[act.EstimatedDialFreq]; !seen || now.Sub(t) >= rebroadcastInterval {
			due = append(due, act)
		}
	}

	if len(due) == 0 {
		h.lastSentMu.Unlock()
		return
	}

	// Update timestamps for all due activities before releasing the lock.
	for _, act := range due {
		bandMap[act.EstimatedDialFreq] = now
	}

	h.lastSentMu.Unlock()

	// Record the time of this broadcast for heartbeat.
	h.lastActivityTime.Store(now.UnixNano())

	// Fan out one SSE event per due activity.
	ts := now.UTC().Format(time.RFC3339)
	for _, act := range due {
		evt := VoiceActivitySSEEvent{
			Type:              "voice_activity",
			Band:              band,
			Timestamp:         ts,
			EstimatedDialFreq: act.EstimatedDialFreq,
			Mode:              act.Mode,
			SNR:               act.SNR,
			Confidence:        act.Confidence,
			AvgSignalDB:       act.AvgSignalDB,
			PeakSignalDB:      act.PeakSignalDB,
			Bandwidth:         act.Bandwidth,
			DXCallsign:        act.DXCallsign,
			DXCountry:         act.DXCountry,
			DXCountryCode:     act.DXCountryCode,
			DXContinent:       act.DXContinent,
		}

		data, err := json.Marshal(evt)
		if err != nil {
			log.Printf("VoiceActivitySSEHub: failed to marshal event: %v", err)
			continue
		}
		line := fmt.Sprintf("data: %s\n\n", data)

		h.mu.RLock()
		for c := range h.clients {
			if c.bandFilter != "" && c.bandFilter != band {
				continue
			}
			// Non-blocking send — drop if client is slow.
			select {
			case c.ch <- line:
			default:
			}
		}
		h.mu.RUnlock()
	}
}

// heartbeatJSON builds the heartbeat SSE event line.
func (h *VoiceActivitySSEHub) heartbeatJSON() string {
	ns := h.lastActivityTime.Load()
	if ns == 0 {
		return "event: heartbeat\ndata: {\"last_activity\":null}\n\n"
	}
	t := time.Unix(0, ns).UTC().Format(time.RFC3339)
	return fmt.Sprintf("event: heartbeat\ndata: {\"last_activity\":%q}\n\n", t)
}

// HandlePublicVoiceActivityStream is the HTTP handler for GET /api/voice-activity/stream.
// It enforces a per-IP concurrent connection limit via limiter (typically 2 per IP).
// Bypassed IPs (timeout_bypass_ips or bypass_password) are exempt from the limit.
func HandlePublicVoiceActivityStream(hub *VoiceActivitySSEHub, limiter *SSEIPLimiter, serverConfig *ServerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Return 503 if the noise floor monitor is not active.
		if !hub.enabled.Load() {
			http.Error(w, "voice activity monitoring is not enabled", http.StatusServiceUnavailable)
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

		// Parse optional band filter.
		bandFilter := r.URL.Query().Get("band")

		// Set SSE headers.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		// Register client.
		client := &voiceActivitySSEClient{
			ch:         make(chan string, 64),
			bandFilter: bandFilter,
		}
		hub.register(client)
		defer hub.unregister(client)

		log.Printf("VoiceActivitySSE: client connected (band=%q ip=%s)", bandFilter, ip)

		// Send initial comment + retry hint to confirm connection.
		fmt.Fprintf(w, ": connected to voice activity stream\nretry: 3000\n\n")
		flusher.Flush()

		// 30-second heartbeat ticker — keeps NAT alive and provides last-activity timestamp.
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				log.Printf("VoiceActivitySSE: client disconnected (ip=%s)", ip)
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
