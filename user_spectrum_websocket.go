package main

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
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

// spectrumState tracks previous spectrum data for delta encoding
type spectrumState struct {
	previousData   []float32
	previousData8  []uint8 // For binary8 mode
	useBinary8Mode bool    // Whether to use 8-bit encoding
	mu             sync.RWMutex
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

	// Check for binary8 mode (8-bit encoding)
	mode := query.Get("mode")
	useBinary8 := mode == "binary8"

	if useBinary8 {
		log.Printf("Using binary8 spectrum mode (8-bit) with delta encoding")
	} else {
		log.Printf("Using binary spectrum mode (32-bit float) with delta encoding")
	}

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

	// Initialize spectrum state for delta encoding (always used in binary mode)
	state := &spectrumState{
		previousData:   make([]float32, session.BinCount),
		previousData8:  make([]uint8, session.BinCount),
		useBinary8Mode: useBinary8,
	}

	// Start spectrum streaming goroutine
	done := make(chan struct{})
	go swsh.streamSpectrum(conn, session, done, state)

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
func (swsh *UserSpectrumWebSocketHandler) streamSpectrum(conn *wsConn, session *Session, done <-chan struct{}, state *spectrumState) {
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

			// Binary mode with delta encoding - choose format based on state
			var err error
			if state.useBinary8Mode {
				err = swsh.sendBinary8Spectrum(conn, session, spectrumData, state)
			} else {
				err = swsh.sendBinarySpectrum(conn, session, spectrumData, state)
			}

			if err != nil {
				log.Printf("Failed to send binary spectrum data: %v", err)
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

// sendBinarySpectrum sends spectrum data in binary format (float32) with delta encoding
// Binary format:
// - Header (22 bytes):
//   - Magic: 0x53 0x50 0x45 0x43 (4 bytes) "SPEC"
//   - Version: 0x01 (1 byte)
//   - Flags: 0x01=full (float32), 0x02=delta (float32), 0x03=full (uint8), 0x04=delta (uint8) (1 byte)
//   - Timestamp: uint64 milliseconds (8 bytes)
//   - Frequency: uint64 Hz (8 bytes)
//
// - For full frame: all bins as float32 (binCount * 4 bytes)
// - For delta frame:
//   - ChangeCount: uint16 (2 bytes)
//   - Changes: array of [index: uint16, value: float32] (6 bytes each)
func (swsh *UserSpectrumWebSocketHandler) sendBinarySpectrum(conn *wsConn, session *Session, spectrumData []float32, state *spectrumState) error {
	const (
		fullFrameInterval = 50 // Send full frame every N frames to prevent drift
	)

	// Get delta threshold from config (validated to be between 1.0 and 10.0 dB)
	deltaThreshold := swsh.sessions.config.Spectrum.DeltaThresholdDB

	state.mu.Lock()
	defer state.mu.Unlock()

	// Determine if we should send full or delta frame
	sendFullFrame := false
	if len(state.previousData) != len(spectrumData) {
		// Bin count changed, send full frame
		sendFullFrame = true
		state.previousData = make([]float32, len(spectrumData))
	} else if len(state.previousData) == 0 {
		// First frame, send full
		sendFullFrame = true
		state.previousData = make([]float32, len(spectrumData))
	}

	// Calculate changes for delta encoding
	type change struct {
		index uint16
		value float32
	}
	var changes []change

	if !sendFullFrame {
		for i := 0; i < len(spectrumData); i++ {
			diff := math.Abs(float64(spectrumData[i] - state.previousData[i]))
			if diff > deltaThreshold {
				changes = append(changes, change{
					index: uint16(i),
					value: spectrumData[i],
				})
			}
		}

		// If too many changes (>80% of bins), send full frame instead
		// More aggressive threshold for HF radio where small variations are normal
		if len(changes) > (len(spectrumData)*4)/5 {
			sendFullFrame = true
		}
	}

	timestamp := time.Now().UnixMilli()

	var packet []byte
	if sendFullFrame {
		// Full frame format
		headerSize := 22
		packet = make([]byte, headerSize+len(spectrumData)*4)

		// Magic
		packet[0] = 0x53 // 'S'
		packet[1] = 0x50 // 'P'
		packet[2] = 0x45 // 'E'
		packet[3] = 0x43 // 'C'

		// Version
		packet[4] = 0x01

		// Flags: 0x01 = full frame
		packet[5] = 0x01

		// Timestamp (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[6:14], uint64(timestamp))

		// Frequency (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[14:22], session.Frequency)

		// Spectrum data (float32 array)
		for i, val := range spectrumData {
			bits := math.Float32bits(val)
			binary.LittleEndian.PutUint32(packet[headerSize+i*4:headerSize+i*4+4], bits)
		}

		// Update previous data
		copy(state.previousData, spectrumData)
	} else {
		// Delta frame format
		headerSize := 22
		changesSize := 2 + len(changes)*6 // changeCount (2 bytes) + changes
		packet = make([]byte, headerSize+changesSize)

		// Magic
		packet[0] = 0x53 // 'S'
		packet[1] = 0x50 // 'P'
		packet[2] = 0x45 // 'E'
		packet[3] = 0x43 // 'C'

		// Version
		packet[4] = 0x01

		// Flags: 0x02 = delta frame
		packet[5] = 0x02

		// Timestamp (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[6:14], uint64(timestamp))

		// Frequency (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[14:22], session.Frequency)

		// Change count (2 bytes, little-endian)
		binary.LittleEndian.PutUint16(packet[headerSize:headerSize+2], uint16(len(changes)))

		// Changes array
		offset := headerSize + 2
		for _, ch := range changes {
			// Index (2 bytes, little-endian)
			binary.LittleEndian.PutUint16(packet[offset:offset+2], ch.index)
			// Value (4 bytes, float32, little-endian)
			bits := math.Float32bits(ch.value)
			binary.LittleEndian.PutUint32(packet[offset+2:offset+6], bits)
			offset += 6
		}

		// Update previous data with changes
		for _, ch := range changes {
			state.previousData[ch.index] = ch.value
		}
	}

	// Send as binary WebSocket message
	conn.writeMu.Lock()
	conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := conn.conn.WriteMessage(websocket.BinaryMessage, packet)
	conn.writeMu.Unlock()

	if err != nil {
		return err
	}

	// Track bytes for statistics
	if conn.aggregator != nil {
		conn.aggregator.addBytes(int64(len(packet)))
		conn.aggregator.addMessage()
	}

	return nil
}

// sendBinary8Spectrum sends spectrum data in binary8 format (8-bit) with delta encoding
// Binary8 format:
// - Header (22 bytes): Same as binary format
//   - Magic: 0x53 0x50 0x45 0x43 (4 bytes) "SPEC"
//   - Version: 0x01 (1 byte)
//   - Flags: 0x03=full (uint8), 0x04=delta (uint8) (1 byte)
//   - Timestamp: uint64 milliseconds (8 bytes)
//   - Frequency: uint64 Hz (8 bytes)
//
// - For full frame: all bins as uint8 (binCount * 1 byte)
//   - uint8 value represents dBFS: 0 = -256 dB, 255 = -1 dB (or 0 dB clamped)
//
// - For delta frame:
//   - ChangeCount: uint16 (2 bytes)
//   - Changes: array of [index: uint16, value: uint8] (3 bytes each)
func (swsh *UserSpectrumWebSocketHandler) sendBinary8Spectrum(conn *wsConn, session *Session, spectrumData []float32, state *spectrumState) error {
	const (
		fullFrameInterval = 50 // Send full frame every N frames to prevent drift
	)

	// Get delta threshold from config (validated to be between 1.0 and 10.0 dB)
	deltaThreshold := swsh.sessions.config.Spectrum.DeltaThresholdDB

	state.mu.Lock()
	defer state.mu.Unlock()

	// Convert float32 dBFS to uint8 (0 = -256 dB, 255 = -1 dB)
	spectrumData8 := make([]uint8, len(spectrumData))
	for i, val := range spectrumData {
		// Clamp to range [-256, 0] and convert to [0, 255]
		dbValue := val
		if dbValue < -256 {
			dbValue = -256
		} else if dbValue > 0 {
			dbValue = 0
		}
		// Convert: -256 dB -> 0, 0 dB -> 255
		spectrumData8[i] = uint8(dbValue + 256)
	}

	// Determine if we should send full or delta frame
	sendFullFrame := false
	if len(state.previousData8) != len(spectrumData8) {
		// Bin count changed, send full frame
		sendFullFrame = true
		state.previousData8 = make([]uint8, len(spectrumData8))
	} else if len(state.previousData8) == 0 {
		// First frame, send full
		sendFullFrame = true
		state.previousData8 = make([]uint8, len(spectrumData8))
	}

	// Calculate changes for delta encoding
	type change struct {
		index uint16
		value uint8
	}
	var changes []change

	if !sendFullFrame {
		for i := 0; i < len(spectrumData8); i++ {
			// Calculate difference in dB (convert back to compare)
			oldDB := float64(state.previousData8[i]) - 256
			newDB := float64(spectrumData8[i]) - 256
			diff := math.Abs(newDB - oldDB)

			if diff > deltaThreshold {
				changes = append(changes, change{
					index: uint16(i),
					value: spectrumData8[i],
				})
			}
		}

		// If too many changes (>80% of bins), send full frame instead
		if len(changes) > (len(spectrumData8)*4)/5 {
			sendFullFrame = true
		}
	}

	timestamp := time.Now().UnixMilli()

	var packet []byte
	if sendFullFrame {
		// Full frame format (uint8)
		headerSize := 22
		packet = make([]byte, headerSize+len(spectrumData8))

		// Magic
		packet[0] = 0x53 // 'S'
		packet[1] = 0x50 // 'P'
		packet[2] = 0x45 // 'E'
		packet[3] = 0x43 // 'C'

		// Version
		packet[4] = 0x01

		// Flags: 0x03 = full frame (uint8)
		packet[5] = 0x03

		// Timestamp (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[6:14], uint64(timestamp))

		// Frequency (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[14:22], session.Frequency)

		// Spectrum data (uint8 array)
		copy(packet[headerSize:], spectrumData8)

		// Update previous data
		copy(state.previousData8, spectrumData8)
	} else {
		// Delta frame format (uint8)
		headerSize := 22
		changesSize := 2 + len(changes)*3 // changeCount (2 bytes) + changes (3 bytes each)
		packet = make([]byte, headerSize+changesSize)

		// Magic
		packet[0] = 0x53 // 'S'
		packet[1] = 0x50 // 'P'
		packet[2] = 0x45 // 'E'
		packet[3] = 0x43 // 'C'

		// Version
		packet[4] = 0x01

		// Flags: 0x04 = delta frame (uint8)
		packet[5] = 0x04

		// Timestamp (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[6:14], uint64(timestamp))

		// Frequency (8 bytes, little-endian)
		binary.LittleEndian.PutUint64(packet[14:22], session.Frequency)

		// Change count (2 bytes, little-endian)
		binary.LittleEndian.PutUint16(packet[headerSize:headerSize+2], uint16(len(changes)))

		// Changes array
		offset := headerSize + 2
		for _, ch := range changes {
			// Index (2 bytes, little-endian)
			binary.LittleEndian.PutUint16(packet[offset:offset+2], ch.index)
			// Value (1 byte, uint8)
			packet[offset+2] = ch.value
			offset += 3
		}

		// Update previous data with changes
		for _, ch := range changes {
			state.previousData8[ch.index] = ch.value
		}
	}

	// Send as binary WebSocket message
	conn.writeMu.Lock()
	conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := conn.conn.WriteMessage(websocket.BinaryMessage, packet)
	conn.writeMu.Unlock()

	if err != nil {
		return err
	}

	// Track bytes for statistics
	if conn.aggregator != nil {
		conn.aggregator.addBytes(int64(len(packet)))
		conn.aggregator.addMessage()
	}

	return nil
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
