package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// UserSpectrumWebSocketHandler handles per-user spectrum WebSocket connections
type UserSpectrumWebSocketHandler struct {
	sessions           *SessionManager
	ipBanManager       *IPBanManager
	rateLimiterManager *RateLimiterManager
	connRateLimiter    *IPConnectionRateLimiter
	prometheusMetrics  *PrometheusMetrics
}

// NewUserSpectrumWebSocketHandler creates a new per-user spectrum WebSocket handler
func NewUserSpectrumWebSocketHandler(sessions *SessionManager, ipBanManager *IPBanManager, rateLimiterManager *RateLimiterManager, connRateLimiter *IPConnectionRateLimiter, prometheusMetrics *PrometheusMetrics) *UserSpectrumWebSocketHandler {
	return &UserSpectrumWebSocketHandler{
		sessions:           sessions,
		ipBanManager:       ipBanManager,
		rateLimiterManager: rateLimiterManager,
		connRateLimiter:    connRateLimiter,
		prometheusMetrics:  prometheusMetrics,
	}
}

// UserSpectrumClientMessage represents a message from the client
type UserSpectrumClientMessage struct {
	Type         string  `json:"type"`
	Frequency    uint64  `json:"frequency,omitempty"`    // Center frequency for pan
	BinBandwidth float64 `json:"binBandwidth,omitempty"` // Bandwidth per bin for zoom
}

// UnmarshalJSON implements custom JSON unmarshaling to handle both float and int for Frequency
func (m *UserSpectrumClientMessage) UnmarshalJSON(data []byte) error {
	// Use a temporary struct with float64 for Frequency to accept both types
	type Alias struct {
		Type         string   `json:"type"`
		Frequency    *float64 `json:"frequency,omitempty"`
		BinBandwidth *float64 `json:"binBandwidth,omitempty"`
	}

	var aux Alias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	m.Type = aux.Type

	// Convert frequency from float64 to uint64, rounding if necessary
	if aux.Frequency != nil {
		if *aux.Frequency < 0 {
			m.Frequency = 0
		} else {
			m.Frequency = uint64(*aux.Frequency + 0.5) // Round to nearest integer
		}
	}

	// BinBandwidth can stay as float64
	if aux.BinBandwidth != nil {
		m.BinBandwidth = *aux.BinBandwidth
	}

	return nil
}

// UserSpectrumServerMessage represents a message to the client
type UserSpectrumServerMessage struct {
	Type         string      `json:"type"`
	Data         []float32   `json:"data,omitempty"`         // Spectrum bin data
	Frequency    uint64      `json:"frequency,omitempty"`    // Current center frequency
	BinCount     int         `json:"binCount,omitempty"`     // Number of bins (constant)
	BinBandwidth float64     `json:"binBandwidth,omitempty"` // Bandwidth per bin
	Timestamp    int64       `json:"timestamp,omitempty"`    // Server capture timestamp in milliseconds (Unix epoch)
	SessionID    string      `json:"sessionId,omitempty"`
	Error        string      `json:"error,omitempty"`
	Status       int         `json:"status,omitempty"` // HTTP-style status code (e.g., 429 for rate limit)
	Info         interface{} `json:"info,omitempty"`
}

// HandleSpectrumWebSocket handles spectrum WebSocket connections
func (swsh *UserSpectrumWebSocketHandler) HandleSpectrumWebSocket(w http.ResponseWriter, r *http.Request) {
	// Get source IP address and strip port
	sourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = host
	}
	clientIP := sourceIP

	// Only trust X-Real-IP if request comes from tunnel server
	// This prevents clients from spoofing their IP via X-Real-IP header
	xRealIP := r.Header.Get("X-Real-IP")
	xForwardedFor := r.Header.Get("X-Forwarded-For")
	isTunnelServer := globalConfig != nil && globalConfig.InstanceReporting.IsTunnelServer(sourceIP)

	log.Printf("Spectrum WebSocket IP detection: sourceIP=%s, X-Real-IP=%s, X-Forwarded-For=%s, isTunnelServer=%v",
		sourceIP, xRealIP, xForwardedFor, isTunnelServer)

	if isTunnelServer {
		if xri := xRealIP; xri != "" {
			clientIP = strings.TrimSpace(xri)
			// Strip port if present
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
			log.Printf("Spectrum WebSocket: Trusted X-Real-IP from tunnel server: %s -> %s", sourceIP, clientIP)
		}
	} else {
		// Check X-Forwarded-For header for true source IP (first IP in the list)
		if xff := xForwardedFor; xff != "" {
			// X-Forwarded-For can contain multiple IPs: "client, proxy1, proxy2"
			// We want the first one (the true client)
			if idx := len(xff); idx > 0 {
				// Find first comma or use entire string
				for i, c := range xff {
					if c == ',' {
						clientIP = strings.TrimSpace(xff[:i])
						break
					}
				}
				if clientIP == sourceIP {
					// No comma found, use entire xff
					clientIP = strings.TrimSpace(xff)
				}
			}
			// Strip port from X-Forwarded-For IP if present
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
			log.Printf("Spectrum WebSocket: Used X-Forwarded-For: %s -> %s", sourceIP, clientIP)
		}
	}

	log.Printf("Spectrum WebSocket final IPs: sourceIP=%s, clientIP=%s", sourceIP, clientIP)

	// Check if IP is banned
	if swsh.ipBanManager.IsBanned(clientIP) {
		log.Printf("Rejected Spectrum WebSocket connection from banned IP: %s (client IP: %s)", sourceIP, clientIP)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Get password from query string (optional)
	query := r.URL.Query()
	password := query.Get("password")

	// Check connection rate limit (unless IP is bypassed via IP list or password)
	if !swsh.sessions.config.Server.IsIPTimeoutBypassed(clientIP, password) && !swsh.connRateLimiter.AllowConnection(clientIP) {
		log.Printf("Connection rate limit exceeded for IP: %s (client IP: %s)", sourceIP, clientIP)
		http.Error(w, "Too Many Requests - Connection rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	// Get user session ID from query string (required)
	userSessionID := query.Get("user_session_id")

	// Validate user session ID - must be a valid UUID
	if !isValidUUID(userSessionID) {
		log.Printf("Rejected Spectrum WebSocket connection: invalid or missing user_session_id from %s (client IP: %s)", sourceIP, clientIP)
		// Send error response before upgrading
		http.Error(w, "Invalid or missing user_session_id. Please refresh the page.", http.StatusBadRequest)
		return
	}

	// Check if this UUID has been kicked
	if swsh.sessions.IsUUIDKicked(userSessionID) {
		log.Printf("Rejected Spectrum WebSocket connection: kicked user_session_id %s from %s (client IP: %s)", userSessionID, sourceIP, clientIP)
		http.Error(w, "Your session has been terminated. Please refresh the page.", http.StatusForbidden)
		return
	}

	// Check if User-Agent mapping exists (ensures /connection was called first)
	if swsh.sessions.GetUserAgent(userSessionID) == "" {
		log.Printf("Rejected Spectrum WebSocket connection: no User-Agent mapping for user_session_id %s from %s (client IP: %s)", userSessionID, sourceIP, clientIP)
		http.Error(w, "Invalid session. Please refresh the page and try again.", http.StatusBadRequest)
		return
	}

	// Upgrade HTTP connection to WebSocket
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade spectrum connection: %v", err)
		return
	}

	log.Printf("Spectrum WebSocket connected - Using manual gzip compression, user_session_id: %s, source IP: %s, client IP: %s", userSessionID, sourceIP, clientIP)

	conn := &wsConn{conn: rawConn, aggregator: globalStatsSpectrum}
	globalStatsSpectrum.addConnection()

	// Record WebSocket connection in Prometheus
	if swsh.prometheusMetrics != nil {
		swsh.prometheusMetrics.RecordWSConnection("spectrum")
	}

	defer func() {
		globalStatsSpectrum.removeConnection()

		// Record WebSocket disconnection in Prometheus
		if swsh.prometheusMetrics != nil {
			swsh.prometheusMetrics.RecordWSDisconnect("spectrum")
		}

		conn.close()
	}()

	// Start stats logger if not already running
	startStatsLogger()

	// Create spectrum session with IP tracking, user session ID, and bypass password
	session, err := swsh.sessions.CreateSpectrumSessionWithUserIDAndPassword(sourceIP, clientIP, userSessionID, password)
	if err != nil {
		log.Printf("Failed to create spectrum session: %v", err)

		// Record session creation error in Prometheus
		if swsh.prometheusMetrics != nil {
			swsh.prometheusMetrics.RecordSessionCreationError()
		}

		swsh.sendError(conn, "Failed to create spectrum session: "+err.Error())
		return
	}

	// Store WebSocket connection reference in session for kick functionality
	session.WSConn = conn
	// Password is already stored in session during creation

	if userSessionID != "" {
		log.Printf("Spectrum WebSocket session created: %s, user_session_id: %s, source IP: %s, client IP: %s", session.ID, userSessionID, sourceIP, clientIP)
	} else {
		log.Printf("Spectrum WebSocket session created: %s, source IP: %s, client IP: %s", session.ID, sourceIP, clientIP)
	}

	// Send initial status
	swsh.sendStatus(conn, session)

	// Start spectrum streaming goroutine
	done := make(chan struct{})
	go swsh.streamSpectrum(conn, session, done)

	// Handle incoming messages
	swsh.handleMessages(conn, session, done)

	// Cleanup
	swsh.sessions.DestroySession(session.ID)
}

// handleMessages processes incoming WebSocket messages
func (swsh *UserSpectrumWebSocketHandler) handleMessages(conn *wsConn, session *Session, done chan struct{}) {
	defer close(done)

	for {
		var msg UserSpectrumClientMessage
		err := conn.readJSON(&msg)
		if err != nil {
			// Check if it's a normal close
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Spectrum WebSocket error: %v", err)
			}
			// For any error (including JSON parsing), close the connection
			// This is appropriate because we can't recover from a malformed message stream
			break
		}

		// Record message received in Prometheus
		if swsh.prometheusMetrics != nil {
			swsh.prometheusMetrics.RecordWSMessageReceived("spectrum")
		}

		// Update last active time
		swsh.sessions.TouchSession(session.ID)

		// Check rate limit for this UUID (skip ping messages)
		if msg.Type != "ping" && !swsh.rateLimiterManager.AllowSpectrum(session.UserSessionID) {
			log.Printf("Rate limit exceeded for spectrum command from user %s (type: %s)", session.UserSessionID, msg.Type)

			// Record rate limit error in Prometheus
			if swsh.prometheusMetrics != nil {
				swsh.prometheusMetrics.RecordRateLimitError("spectrum")
			}

			swsh.sendErrorWithStatus(conn, "Rate limit exceeded. Please slow down.", 429)
			continue // Don't close connection, just reject this command
		}

		// Handle message based on type
		switch msg.Type {
		case "reset":
			// Reset to full bandwidth view
			defaultFreq := swsh.sessions.config.Spectrum.Default.CenterFrequency
			defaultBinBW := swsh.sessions.config.Spectrum.Default.BinBandwidth
			defaultBinCount := swsh.sessions.config.Spectrum.Default.BinCount

			// Check if already at defaults
			if session.Frequency == defaultFreq && session.BinBandwidth == defaultBinBW && session.BinCount == defaultBinCount {

				// Still send status to acknowledge the request
				swsh.sendStatus(conn, session)
			} else {

				if err := swsh.sessions.UpdateSpectrumSession(session.ID, defaultFreq, defaultBinBW, defaultBinCount); err != nil {
					swsh.sendError(conn, "Failed to reset spectrum: "+err.Error())
					continue
				}

				// Send updated status
				swsh.sendStatus(conn, session)
			}

		case "zoom", "pan":
			// Update spectrum parameters (zoom changes bin_bw, pan changes frequency)
			newFreq := session.Frequency
			newBinBW := session.BinBandwidth
			newBinCount := session.BinCount

			if msg.Frequency > 0 {
				// Enforce minimum center frequency of 100 kHz
				const minCenterFreq = 100000 // 100 kHz
				if msg.Frequency < minCenterFreq {
					log.Printf("Rejecting spectrum update: center frequency %d Hz < minimum %d Hz (100 kHz)",
						msg.Frequency, minCenterFreq)
					swsh.sendError(conn, "Center frequency must be at least 100 kHz")
					continue
				}
				newFreq = msg.Frequency
			}
			if msg.BinBandwidth > 0 {
				newBinBW = msg.BinBandwidth
			}

			// Smart zoom logic: dynamically adjust bin_count for deep zoom levels
			// Keep current behavior up to 256x zoom (bin_bw down to safe minimum)
			// Beyond that, reduce bin_count to allow deeper zooming
			session.mu.RLock()
			defaultBinCount := swsh.sessions.config.Spectrum.Default.BinCount
			currentBinCount := session.BinCount
			session.mu.RUnlock()

			// Radiod has constraints on valid sample rates (must be compatible with block rate)
			// Safe bin_bw values that work with radiod: 50, 100, 200, 500, 1000, 2000, 5000 Hz
			// Below 50 Hz, we need to reduce bin_count instead
			const minSafeBinBW = 50.0        // Minimum safe bin_bw before reducing bin_count
			const maxBinBWForRestore = 200.0 // Above this, restore bin_count if reduced

			// Round bin_bw to nearest safe value
			safeBinBW := newBinBW
			if newBinBW < 50 {
				safeBinBW = 50
			} else if newBinBW < 75 {
				safeBinBW = 50
			} else if newBinBW < 150 {
				safeBinBW = 100
			} else if newBinBW < 250 {
				safeBinBW = 200
			} else if newBinBW < 400 {
				safeBinBW = 300
			} else if newBinBW < 750 {
				safeBinBW = 500
			} else if newBinBW < 1500 {
				safeBinBW = 1000
			} else if newBinBW < 3500 {
				safeBinBW = 2000
			} else if newBinBW < 7500 {
				safeBinBW = 5000
			} else {
				// For very large bin bandwidths (e.g., default 29296.875 for full 0-30 MHz),
				// don't round - pass through as-is for full bandwidth view
				safeBinBW = newBinBW
			}

			// If user is trying to zoom deeper than min safe bin_bw, reduce bin_count instead
			if newBinBW < minSafeBinBW && currentBinCount > 256 {
				// Reduce bin_count by half, keep bin_bw at safe minimum
				newBinCount = currentBinCount / 2
				if newBinCount < 256 {
					newBinCount = 256 // Minimum bin count
				}
				newBinBW = minSafeBinBW

			} else if newBinBW > maxBinBWForRestore && currentBinCount < defaultBinCount {
				// Zooming out: restore bin_count if it was reduced
				newBinCount = currentBinCount * 2
				if newBinCount > defaultBinCount {
					newBinCount = defaultBinCount
				}
				newBinBW = safeBinBW

			} else {
				// Normal zoom: use safe bin_bw value
				newBinBW = safeBinBW
			}

			// Only update if something changed
			if newFreq != session.Frequency || newBinBW != session.BinBandwidth || newBinCount != session.BinCount {
				if err := swsh.sessions.UpdateSpectrumSession(session.ID, newFreq, newBinBW, newBinCount); err != nil {
					swsh.sendError(conn, "Failed to update spectrum: "+err.Error())
					continue
				}

				// Send updated status
				swsh.sendStatus(conn, session)
			} else {
				// State is already correct, accept request but don't send to radiod

				// Still send status to acknowledge the request
				swsh.sendStatus(conn, session)
			}

		case "ping":
			// Keepalive
			swsh.sendMessage(conn, UserSpectrumServerMessage{Type: "pong"})

		case "get_status":
			swsh.sendStatus(conn, session)

		default:
			log.Printf("Unknown spectrum message type: %s", msg.Type)
		}
	}
}

// streamSpectrum streams spectrum data to the client
func (swsh *UserSpectrumWebSocketHandler) streamSpectrum(conn *wsConn, session *Session, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return

		case <-session.Done:
			return

		case spectrumData, ok := <-session.SpectrumChan:
			if !ok {
				return
			}

			if DebugMode {
				// Calculate min/max/avg for debugging
				min, max, sum := float32(999), float32(-999), float32(0)
				for _, v := range spectrumData {
					if v < min {
						min = v
					}
					if v > max {
						max = v
					}
					sum += v
				}
				// Removed debug logging
			}

			// Send spectrum message with server timestamp for accurate synchronization
			msg := UserSpectrumServerMessage{
				Type:         "spectrum",
				Data:         spectrumData,
				Frequency:    session.Frequency,
				BinCount:     session.BinCount,
				BinBandwidth: session.BinBandwidth,
				Timestamp:    time.Now().UnixMilli(), // Capture time in milliseconds
			}

			if err := swsh.sendMessage(conn, msg); err != nil {
				log.Printf("Failed to send spectrum data: %v", err)
				return
			}

			// Record spectrum packet sent in Prometheus
			if swsh.prometheusMetrics != nil {
				swsh.prometheusMetrics.RecordSpectrumPacket()
				swsh.prometheusMetrics.RecordWSMessageSent("spectrum")
			}
		}
	}
}

// sendStatus sends current session status to client
// Sends as "config" message to match what spectrum-display.js expects
func (swsh *UserSpectrumWebSocketHandler) sendStatus(conn *wsConn, session *Session) error {
	session.mu.RLock()
	totalBandwidth := float64(session.BinCount) * session.BinBandwidth

	// Create message matching the format spectrum-display.js expects
	// It looks for: centerFreq, binCount, binBandwidth, totalBandwidth
	msg := map[string]interface{}{
		"type":           "config",
		"centerFreq":     session.Frequency, // JavaScript expects centerFreq (camelCase)
		"binCount":       session.BinCount,
		"binBandwidth":   session.BinBandwidth,
		"totalBandwidth": totalBandwidth,
		"sessionId":      session.ID,
	}
	session.mu.RUnlock()

	conn.setWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.writeJSONCompressed(msg)
}

// sendError sends an error message to the client
func (swsh *UserSpectrumWebSocketHandler) sendError(conn *wsConn, errMsg string) error {
	return swsh.sendErrorWithStatus(conn, errMsg, 0)
}

// sendErrorWithStatus sends an error message with a status code to the client
func (swsh *UserSpectrumWebSocketHandler) sendErrorWithStatus(conn *wsConn, errMsg string, status int) error {
	msg := UserSpectrumServerMessage{
		Type:   "error",
		Error:  errMsg,
		Status: status,
	}
	return swsh.sendMessage(conn, msg)
}

// sendMessage sends a message to the client
func (swsh *UserSpectrumWebSocketHandler) sendMessage(conn *wsConn, msg UserSpectrumServerMessage) error {
	conn.setWriteDeadline(time.Now().Add(10 * time.Second))
	err := conn.writeJSONCompressed(msg)

	// Record message sent in Prometheus (for non-spectrum messages)
	if err == nil && swsh.prometheusMetrics != nil && msg.Type != "spectrum" {
		swsh.prometheusMetrics.RecordWSMessageSent(msg.Type)
	}

	return err
}

// Helper function to convert spectrum data to JSON-friendly format
func spectrumToJSON(data []float32) string {
	bytes, _ := json.Marshal(data)
	return string(bytes)
}
