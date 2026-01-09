package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// digitalSpotKey is used for deduplication of digital spots
type digitalSpotKey struct {
	callsign string
	band     string
	mode     string
}

// cwSpotKey is used for deduplication of CW spots
type cwSpotKey struct {
	callsign  string
	band      string
	frequency float64
}

// DXClusterWebSocketHandler manages WebSocket connections for DX cluster spots
type DXClusterWebSocketHandler struct {
	clients           map[*websocket.Conn]*sync.Mutex // Each connection has its own write mutex
	clientsMu         sync.RWMutex
	dxCluster         *DXClusterClient
	sessions          *SessionManager
	ipBanManager      *IPBanManager
	prometheusMetrics *PrometheusMetrics
	upgrader          websocket.Upgrader

	// Digital spot deduplication
	digitalSpotCache   map[digitalSpotKey]time.Time
	digitalSpotCacheMu sync.RWMutex

	// Digital spot buffer for new connections
	digitalSpotBuffer   []map[string]interface{}
	digitalSpotBufferMu sync.RWMutex
	maxDigitalSpots     int

	// CW spot deduplication
	cwSpotCache   map[cwSpotKey]time.Time
	cwSpotCacheMu sync.RWMutex

	// CW spot buffer for new connections
	cwSpotBuffer   []map[string]interface{}
	cwSpotBufferMu sync.RWMutex
	maxCWSpots     int

	// Receiver location for distance/bearing calculation
	receiverLocator string

	// Chat manager for live chat functionality
	chatManager *ChatManager

	// Map websocket connections to session IDs for chat
	connToSessionID   map[*websocket.Conn]string
	connToSessionIDMu sync.RWMutex

	// Throughput tracking per UserSessionID
	dxBytesSent    map[string]uint64        // UserSessionID -> total bytes sent
	dxBytesSamples map[string][]BytesSample // UserSessionID -> sliding window samples
	dxThroughputMu sync.RWMutex
}

// NewDXClusterWebSocketHandler creates a new DX cluster WebSocket handler
func NewDXClusterWebSocketHandler(dxCluster *DXClusterClient, sessions *SessionManager, ipBanManager *IPBanManager, prometheusMetrics *PrometheusMetrics, receiverLocator string, chatConfig ChatConfig) *DXClusterWebSocketHandler {
	handler := &DXClusterWebSocketHandler{
		clients:           make(map[*websocket.Conn]*sync.Mutex),
		dxCluster:         dxCluster,
		sessions:          sessions,
		ipBanManager:      ipBanManager,
		prometheusMetrics: prometheusMetrics,
		digitalSpotCache:  make(map[digitalSpotKey]time.Time),
		digitalSpotBuffer: make([]map[string]interface{}, 0, 100),
		maxDigitalSpots:   100,
		cwSpotCache:       make(map[cwSpotKey]time.Time),
		cwSpotBuffer:      make([]map[string]interface{}, 0, 100),
		maxCWSpots:        100,
		receiverLocator:   receiverLocator,
		connToSessionID:   make(map[*websocket.Conn]string),
		dxBytesSent:       make(map[string]uint64),
		dxBytesSamples:    make(map[string][]BytesSample),
		upgrader: websocket.Upgrader{
			ReadBufferSize:    1024,
			WriteBufferSize:   1024,
			EnableCompression: true, // Enable per-message-deflate compression
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for now
			},
		},
	}

	// Initialize chat manager if enabled (50 message buffer, configured limits)
	if chatConfig.Enabled {
		handler.chatManager = NewChatManager(handler, 50, chatConfig.MaxUsers, chatConfig.RateLimitPerSecond, chatConfig.RateLimitPerMinute, chatConfig.UpdateRateLimitPerSecond)
		log.Printf("Chat: Initialized with max %d users, rate limits: %d msg/sec, %d msg/min, %d updates/sec",
			chatConfig.MaxUsers, chatConfig.RateLimitPerSecond, chatConfig.RateLimitPerMinute, chatConfig.UpdateRateLimitPerSecond)
	}

	// Register spot handler to broadcast to all clients
	dxCluster.OnSpot(func(spot DXSpot) {
		handler.broadcastSpot(spot)
	})

	// Start cleanup goroutine for digital spot cache
	go handler.cleanupDigitalSpotCache()

	// Start cleanup goroutine for CW spot cache
	go handler.cleanupCWSpotCache()

	return handler
}

// HandleWebSocket handles WebSocket connections for DX cluster spots
func (h *DXClusterWebSocketHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Get source IP address and strip port
	sourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = host
	}
	clientIP := sourceIP

	// Only trust X-Real-IP if request comes from tunnel server
	// This prevents clients from spoofing their IP via X-Real-IP header
	if globalConfig != nil && globalConfig.InstanceReporting.IsTunnelServer(sourceIP) {
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			clientIP = strings.TrimSpace(xri)
			// Strip port if present
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
		}
	} else {
		// Check X-Forwarded-For header for true source IP (first IP in the list)
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			clientIP = strings.TrimSpace(xff)
			if commaIdx := strings.Index(clientIP, ","); commaIdx != -1 {
				clientIP = strings.TrimSpace(clientIP[:commaIdx])
			}
			// Strip port if present
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
		}
	}

	// Check if IP is banned
	if h.ipBanManager.IsBanned(clientIP) {
		log.Printf("DX Cluster WebSocket: Rejected connection from banned IP: %s (client IP: %s)", sourceIP, clientIP)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Get user session ID from query string (required)
	userSessionID := r.URL.Query().Get("user_session_id")

	// Validate user session ID - must be a valid UUID
	if !isValidUUID(userSessionID) {
		log.Printf("DX Cluster WebSocket: Rejected connection: invalid or missing user_session_id from %s (client IP: %s)", sourceIP, clientIP)
		http.Error(w, "Invalid or missing user_session_id. Please refresh the page.", http.StatusBadRequest)
		return
	}

	// Check if this UUID has been kicked
	if h.sessions.IsUUIDKicked(userSessionID) {
		log.Printf("DX Cluster WebSocket: Rejected connection: kicked user_session_id %s from %s (client IP: %s)", userSessionID, sourceIP, clientIP)
		http.Error(w, "Your session has been terminated. Please refresh the page.", http.StatusForbidden)
		return
	}

	// Check if User-Agent mapping exists (ensures /connection was called first)
	if h.sessions.GetUserAgent(userSessionID) == "" {
		log.Printf("DX Cluster WebSocket: Rejected connection: no User-Agent mapping for user_session_id %s from %s (client IP: %s)", userSessionID, sourceIP, clientIP)
		http.Error(w, "Invalid session. Please refresh the page and try again.", http.StatusBadRequest)
		return
	}

	// Upgrade HTTP connection to WebSocket
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("DX Cluster WebSocket: Failed to upgrade connection: %v", err)
		return
	}

	// Register client with its own write mutex
	h.clientsMu.Lock()
	h.clients[conn] = &sync.Mutex{}
	clientCount := len(h.clients)
	h.clientsMu.Unlock()

	// Map connection to session ID for chat
	h.connToSessionIDMu.Lock()
	h.connToSessionID[conn] = userSessionID
	h.connToSessionIDMu.Unlock()

	log.Printf("DX Cluster WebSocket: Client connected, user_session_id: %s, source IP: %s, client IP: %s (total: %d)", userSessionID, sourceIP, clientIP, clientCount)

	// Record connection in Prometheus
	if h.prometheusMetrics != nil {
		h.prometheusMetrics.RecordWSConnection("dxcluster")
	}

	// Send connection status
	h.sendConnectionStatus(conn)

	// Send buffered spots after a delay to allow client to initialize and register callbacks
	go func() {
		time.Sleep(1000 * time.Millisecond)

		// Send buffered DX spots to new client
		h.sendBufferedSpots(conn)

		// Send buffered digital spots to new client
		h.sendBufferedDigitalSpots(conn)

		// Send buffered CW spots to new client
		h.sendBufferedCWSpots(conn)

		// Send buffered chat messages to new client
		if h.chatManager != nil {
			h.chatManager.SendBufferedMessages(conn)
		}
	}()

	// Handle client messages (mainly for ping/pong and chat)
	go h.handleClient(conn, userSessionID)
}

// handleClient handles messages from a WebSocket client
func (h *DXClusterWebSocketHandler) handleClient(conn *websocket.Conn, userSessionID string) {
	defer func() {
		// Remove user from chat system
		if h.chatManager != nil {
			h.chatManager.RemoveUser(userSessionID)
		}

		// Remove connection to session ID mapping
		h.connToSessionIDMu.Lock()
		delete(h.connToSessionID, conn)
		h.connToSessionIDMu.Unlock()

		// Unregister client
		h.clientsMu.Lock()
		delete(h.clients, conn)
		clientCount := len(h.clients)
		h.clientsMu.Unlock()

		// Check if this UserSessionID has any other DX cluster connections
		// If not, clean up throughput tracking data
		h.connToSessionIDMu.RLock()
		hasOtherConnections := false
		for _, sid := range h.connToSessionID {
			if sid == userSessionID {
				hasOtherConnections = true
				break
			}
		}
		h.connToSessionIDMu.RUnlock()

		if !hasOtherConnections {
			h.CleanupUserSessionID(userSessionID)
		}

		// Record disconnection in Prometheus
		if h.prometheusMetrics != nil {
			h.prometheusMetrics.RecordWSDisconnect("dxcluster")
		}

		conn.Close()
		log.Printf("DX Cluster WebSocket: Client disconnected (remaining: %d)", clientCount)
	}()

	// Set read deadline
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		// Update chat activity if user is in chat (pong counts as activity)
		if h.chatManager != nil {
			h.chatManager.UpdateUserActivity(userSessionID)
		}

		return nil
	})

	// Start ping ticker
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	go func() {
		for range ticker.C {
			// Get the write mutex for this connection
			h.clientsMu.RLock()
			writeMu, exists := h.clients[conn]
			h.clientsMu.RUnlock()

			if !exists {
				return
			}

			// Lock before writing
			writeMu.Lock()
			err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second))
			writeMu.Unlock()

			if err != nil {
				return
			}
		}
	}()

	// Read messages (for keepalive and chat)
	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("DX Cluster WebSocket: Read error: %v", err)
			}
			break
		}

		// Handle text messages
		if messageType == websocket.TextMessage {
			var msg map[string]interface{}
			if err := json.Unmarshal(message, &msg); err == nil {
				msgType, ok := msg["type"].(string)
				if !ok {
					continue
				}

				switch msgType {
				case "ping":
					// Handle ping/pong
					h.sendMessage(conn, map[string]interface{}{
						"type": "pong",
					})

				case "chat_set_username", "chat_message", "chat_set_frequency_mode", "chat_request_users", "chat_leave":
					// Handle chat messages
					if h.chatManager != nil {
						// Update activity for ANY chat-related message (keeps user alive)
						h.chatManager.UpdateUserActivity(userSessionID)

						if err := h.chatManager.HandleChatMessage(userSessionID, conn, msg); err != nil {
							// Send error back to client
							h.sendMessage(conn, map[string]interface{}{
								"type":  "chat_error",
								"error": err.Error(),
							})
						}
					} else {
						// Chat is disabled on server
						h.sendMessage(conn, map[string]interface{}{
							"type":  "chat_error",
							"error": "chat is disabled on this server",
						})
					}
				}
			}
		}
	}
}

// broadcastSpot broadcasts a DX spot to all connected clients
func (h *DXClusterWebSocketHandler) broadcastSpot(spot DXSpot) {
	// Record spot in Prometheus (by band)
	if h.prometheusMetrics != nil {
		h.prometheusMetrics.RecordDXSpot(spot.Band)
	}

	message := map[string]interface{}{
		"type": "dx_spot",
		"data": spot,
	}

	h.broadcast(message)
}

// BroadcastDigitalSpot broadcasts a digital mode spot (FT8/FT4/WSPR) to all connected clients
// with deduplication based on callsign/band/mode within a 2-minute window
func (h *DXClusterWebSocketHandler) BroadcastDigitalSpot(decode DecodeInfo) {
	// Determine band from frequency
	band := h.frequencyToBand(float64(decode.Frequency))

	// Create deduplication key
	key := digitalSpotKey{
		callsign: decode.Callsign,
		band:     band,
		mode:     decode.Mode,
	}

	// Check if we've seen this spot recently (within 2 minutes)
	h.digitalSpotCacheMu.RLock()
	lastSeen, exists := h.digitalSpotCache[key]
	h.digitalSpotCacheMu.RUnlock()

	now := time.Now()
	if exists && now.Sub(lastSeen) < 2*time.Minute {
		// Skip this spot - we've seen it recently
		return
	}

	// Update cache with current time
	h.digitalSpotCacheMu.Lock()
	h.digitalSpotCache[key] = now
	h.digitalSpotCacheMu.Unlock()

	// Record spot in Prometheus if enabled
	if h.prometheusMetrics != nil {
		// Use mode as the band identifier for digital spots
		h.prometheusMetrics.RecordDXSpot(decode.Mode)
	}

	// Use pre-calculated distance and bearing from DecodeInfo
	// These were calculated once during parsing to avoid duplication
	var spotLat *float64
	var spotLon *float64

	// Convert spot locator to lat/lon for map display with jitter
	if decode.Locator != "" && IsValidMaidenheadLocator(decode.Locator) {
		lat, lon, err := MaidenheadToLatLonWithJitter(decode.Locator)
		if err == nil {
			spotLat = &lat
			spotLon = &lon
		}
	}

	data := map[string]interface{}{
		"mode":         decode.Mode,
		"band":         band,
		"callsign":     decode.Callsign,
		"locator":      decode.Locator,
		"country":      decode.Country,
		"CQZone":       decode.CQZone,
		"ITUZone":      decode.ITUZone,
		"Continent":    decode.Continent,
		"TimeOffset":   decode.TimeOffset,
		"snr":          decode.SNR,
		"frequency":    decode.Frequency,
		"timestamp":    decode.Timestamp,
		"message":      decode.Message,
		"dt":           decode.DT,
		"drift":        decode.Drift,
		"dbm":          decode.DBm,
		"tx_frequency": decode.TxFrequency,
	}

	// Add distance and bearing if available (pre-calculated during parsing)
	if decode.DistanceKm != nil {
		data["distance_km"] = *decode.DistanceKm
	}
	if decode.BearingDeg != nil {
		data["bearing_deg"] = *decode.BearingDeg
	}

	// Add spot coordinates if available
	if spotLat != nil && spotLon != nil {
		data["latitude"] = *spotLat
		data["longitude"] = *spotLon
	}

	message := map[string]interface{}{
		"type": "digital_spot",
		"data": data,
	}

	// Add to buffer for new connections
	h.addDigitalSpotToBuffer(data)

	h.broadcast(message)
}

// addDigitalSpotToBuffer adds a digital spot to the buffer, maintaining max size
func (h *DXClusterWebSocketHandler) addDigitalSpotToBuffer(spotData map[string]interface{}) {
	h.digitalSpotBufferMu.Lock()
	defer h.digitalSpotBufferMu.Unlock()

	// Add spot to buffer
	h.digitalSpotBuffer = append(h.digitalSpotBuffer, spotData)

	// If buffer exceeds max size, remove oldest spots
	if len(h.digitalSpotBuffer) > h.maxDigitalSpots {
		// Keep only the most recent maxDigitalSpots
		h.digitalSpotBuffer = h.digitalSpotBuffer[len(h.digitalSpotBuffer)-h.maxDigitalSpots:]
	}
}

// sendBufferedDigitalSpots sends all buffered digital spots to a newly connected client
func (h *DXClusterWebSocketHandler) sendBufferedDigitalSpots(conn *websocket.Conn) {
	h.digitalSpotBufferMu.RLock()
	bufferedSpots := make([]map[string]interface{}, len(h.digitalSpotBuffer))
	copy(bufferedSpots, h.digitalSpotBuffer)
	h.digitalSpotBufferMu.RUnlock()

	if len(bufferedSpots) == 0 {
		log.Printf("DX Cluster WebSocket: No buffered digital spots to send to new client")
		return
	}

	log.Printf("DX Cluster WebSocket: Sending %d buffered digital spots to new client", len(bufferedSpots))

	// Send each spot as an individual message
	for _, spotData := range bufferedSpots {
		message := map[string]interface{}{
			"type": "digital_spot",
			"data": spotData,
		}

		if err := h.sendMessage(conn, message); err != nil {
			log.Printf("DX Cluster WebSocket: Failed to send buffered digital spot: %v", err)
			// Continue sending other spots even if one fails
		}
	}
}

// frequencyToBand converts a frequency in Hz to a band name
func (h *DXClusterWebSocketHandler) frequencyToBand(freqHz float64) string {
	freq := freqHz / 1000000.0 // Convert to MHz

	switch {
	case freq >= 0.1357 && freq < 0.1378:
		return "2200m"
	case freq >= 0.470 && freq < 0.480:
		return "630m"
	case freq >= 1.8 && freq < 2.0:
		return "160m"
	case freq >= 3.5 && freq < 4.0:
		return "80m"
	case freq >= 5.25 && freq < 5.45:
		return "60m"
	case freq >= 7.0 && freq < 7.3:
		return "40m"
	case freq >= 10.1 && freq < 10.15:
		return "30m"
	case freq >= 14.0 && freq < 14.35:
		return "20m"
	case freq >= 18.068 && freq < 18.168:
		return "17m"
	case freq >= 21.0 && freq < 21.45:
		return "15m"
	case freq >= 24.89 && freq < 24.99:
		return "12m"
	case freq >= 28.0 && freq < 29.7:
		return "10m"
	default:
		return "unknown"
	}
}

// BroadcastCWSpot broadcasts a CW spot to all connected clients
// with deduplication based on callsign/band/frequency within a 2-minute window
func (h *DXClusterWebSocketHandler) BroadcastCWSpot(spot CWSkimmerSpot) {
	// Create deduplication key
	key := cwSpotKey{
		callsign:  spot.DXCall,
		band:      spot.Band,
		frequency: spot.Frequency,
	}

	// Check if we've seen this spot recently (within 2 minutes)
	h.cwSpotCacheMu.RLock()
	lastSeen, exists := h.cwSpotCache[key]
	h.cwSpotCacheMu.RUnlock()

	now := time.Now()
	if exists && now.Sub(lastSeen) < 2*time.Minute {
		// Skip this spot - we've seen it recently
		return
	}

	// Update cache with current time
	h.cwSpotCacheMu.Lock()
	h.cwSpotCache[key] = now
	h.cwSpotCacheMu.Unlock()

	// Record spot in Prometheus if enabled
	if h.prometheusMetrics != nil {
		h.prometheusMetrics.RecordDXSpot("CW-" + spot.Band)
	}

	data := map[string]interface{}{
		"frequency": spot.Frequency,
		"dx_call":   spot.DXCall,
		"snr":       spot.SNR,
		"wpm":       spot.WPM,
		"comment":   spot.Comment,
		"time":      spot.Time,
		"band":      spot.Band,
		"country":   spot.Country,
		"cq_zone":   spot.CQZone,
		"itu_zone":  spot.ITUZone,
		"continent": spot.Continent,
		"latitude":  spot.Latitude,
		"longitude": spot.Longitude,
	}

	// Add distance and bearing if available
	if spot.DistanceKm != nil {
		data["distance_km"] = *spot.DistanceKm
	}
	if spot.BearingDeg != nil {
		data["bearing_deg"] = *spot.BearingDeg
	}

	message := map[string]interface{}{
		"type": "cw_spot",
		"data": data,
	}

	// Add to buffer for new connections
	h.addCWSpotToBuffer(data)

	h.broadcast(message)
}

// addCWSpotToBuffer adds a CW spot to the buffer, maintaining max size
func (h *DXClusterWebSocketHandler) addCWSpotToBuffer(spotData map[string]interface{}) {
	h.cwSpotBufferMu.Lock()
	defer h.cwSpotBufferMu.Unlock()

	// Add spot to buffer
	h.cwSpotBuffer = append(h.cwSpotBuffer, spotData)

	// If buffer exceeds max size, remove oldest spots
	if len(h.cwSpotBuffer) > h.maxCWSpots {
		// Keep only the most recent maxCWSpots
		h.cwSpotBuffer = h.cwSpotBuffer[len(h.cwSpotBuffer)-h.maxCWSpots:]
	}
}

// sendBufferedCWSpots sends all buffered CW spots to a newly connected client
func (h *DXClusterWebSocketHandler) sendBufferedCWSpots(conn *websocket.Conn) {
	h.cwSpotBufferMu.RLock()
	bufferedSpots := make([]map[string]interface{}, len(h.cwSpotBuffer))
	copy(bufferedSpots, h.cwSpotBuffer)
	h.cwSpotBufferMu.RUnlock()

	if len(bufferedSpots) == 0 {
		log.Printf("DX Cluster WebSocket: No buffered CW spots to send to new client (buffer is empty)")
		return
	}

	log.Printf("DX Cluster WebSocket: Sending %d buffered CW spots to new client", len(bufferedSpots))

	// Send each spot as an individual message
	for i, spotData := range bufferedSpots {
		message := map[string]interface{}{
			"type": "cw_spot",
			"data": spotData,
		}

		if err := h.sendMessage(conn, message); err != nil {
			log.Printf("DX Cluster WebSocket: Failed to send buffered CW spot %d/%d: %v", i+1, len(bufferedSpots), err)
			// Continue sending other spots even if one fails
		} else {
			// Log first spot to verify data structure
			if i == 0 {
				log.Printf("DX Cluster WebSocket: Successfully sent first CW spot: callsign=%v, freq=%v, band=%v",
					spotData["dx_call"], spotData["frequency"], spotData["band"])
			}
		}
	}
}

// cleanupCWSpotCache periodically removes old entries from the cache
func (h *DXClusterWebSocketHandler) cleanupCWSpotCache() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		h.cwSpotCacheMu.Lock()
		now := time.Now()
		for key, lastSeen := range h.cwSpotCache {
			// Remove entries older than 3 minutes (1 minute buffer beyond the 2-minute window)
			if now.Sub(lastSeen) > 3*time.Minute {
				delete(h.cwSpotCache, key)
			}
		}
		h.cwSpotCacheMu.Unlock()
	}
}

// cleanupDigitalSpotCache periodically removes old entries from the cache
func (h *DXClusterWebSocketHandler) cleanupDigitalSpotCache() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		h.digitalSpotCacheMu.Lock()
		now := time.Now()
		for key, lastSeen := range h.digitalSpotCache {
			// Remove entries older than 3 minutes (1 minute buffer beyond the 2-minute window)
			if now.Sub(lastSeen) > 3*time.Minute {
				delete(h.digitalSpotCache, key)
			}
		}
		h.digitalSpotCacheMu.Unlock()
	}
}

// broadcast is a helper method to send messages to all clients
func (h *DXClusterWebSocketHandler) broadcast(message map[string]interface{}) {
	messageJSON, err := json.Marshal(message)
	if err != nil {
		log.Printf("DX Cluster WebSocket: Failed to marshal message: %v", err)
		return
	}

	messageSize := uint64(len(messageJSON))

	// Copy client list FIRST, then release lock before writing
	// This prevents holding clientsMu.RLock() during slow WebSocket writes
	h.clientsMu.RLock()
	clientList := make([]*websocket.Conn, 0, len(h.clients))
	writeMutexes := make([]*sync.Mutex, 0, len(h.clients))
	for conn, writeMu := range h.clients {
		clientList = append(clientList, conn)
		writeMutexes = append(writeMutexes, writeMu)
	}
	h.clientsMu.RUnlock()

	// Get UserSessionIDs for all connections
	h.connToSessionIDMu.RLock()
	connToUserSessionID := make(map[*websocket.Conn]string)
	for _, conn := range clientList {
		if userSessionID, exists := h.connToSessionID[conn]; exists {
			connToUserSessionID[conn] = userSessionID
		}
	}
	h.connToSessionIDMu.RUnlock()

	// Track failed connections for immediate cleanup
	var failedConns []*websocket.Conn

	// Now write to clients without holding clientsMu (prevents deadlock)
	for i, conn := range clientList {
		writeMu := writeMutexes[i]

		// Lock this connection's write mutex
		writeMu.Lock()

		// Set write deadline to avoid blocking forever (reduced from 10s to 5s)
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))

		err := conn.WriteMessage(websocket.TextMessage, messageJSON)
		writeMu.Unlock()

		if err != nil {
			// Log the error and mark connection for cleanup
			log.Printf("DX Cluster WebSocket: Failed to send message to client: %v", err)
			failedConns = append(failedConns, conn)
		} else {
			// Track bytes sent for this UserSessionID
			if userSessionID, exists := connToUserSessionID[conn]; exists {
				h.AddDXBytes(userSessionID, messageSize)
			}
		}
	}

	// Clean up failed connections immediately
	if len(failedConns) > 0 {
		h.clientsMu.Lock()
		for _, conn := range failedConns {
			if _, exists := h.clients[conn]; exists {
				delete(h.clients, conn)
				conn.Close()
				if h.prometheusMetrics != nil {
					h.prometheusMetrics.RecordWSDisconnect("dxcluster")
				}
			}
		}
		remainingClients := len(h.clients)
		h.clientsMu.Unlock()
		log.Printf("DX Cluster WebSocket: Cleaned up %d failed connection(s) (remaining: %d)", len(failedConns), remainingClients)
	}
}

// sendConnectionStatus sends the current connection status to a client
func (h *DXClusterWebSocketHandler) sendConnectionStatus(conn *websocket.Conn) {
	message := map[string]interface{}{
		"type":      "status",
		"connected": h.dxCluster.IsConnected(),
	}

	h.sendMessage(conn, message)
}

// sendMessage sends a message to a specific client
func (h *DXClusterWebSocketHandler) sendMessage(conn *websocket.Conn, message map[string]interface{}) error {
	messageJSON, err := json.Marshal(message)
	if err != nil {
		return err
	}

	messageSize := uint64(len(messageJSON))

	// Get the write mutex for this connection
	h.clientsMu.RLock()
	writeMu, exists := h.clients[conn]
	h.clientsMu.RUnlock()

	if !exists {
		return fmt.Errorf("connection not found")
	}

	// Get UserSessionID for this connection
	h.connToSessionIDMu.RLock()
	userSessionID := h.connToSessionID[conn]
	h.connToSessionIDMu.RUnlock()

	// Lock before writing
	writeMu.Lock()
	defer writeMu.Unlock()

	// Reduced timeout from 10s to 5s for faster failure detection
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err = conn.WriteMessage(websocket.TextMessage, messageJSON)

	// Track bytes sent if successful
	if err == nil && userSessionID != "" {
		h.AddDXBytes(userSessionID, messageSize)
	}

	return err
}

// BroadcastStatus broadcasts connection status to all clients
func (h *DXClusterWebSocketHandler) BroadcastStatus() {
	message := map[string]interface{}{
		"type":      "status",
		"connected": h.dxCluster.IsConnected(),
	}

	messageJSON, err := json.Marshal(message)
	if err != nil {
		log.Printf("DX Cluster WebSocket: Failed to marshal status: %v", err)
		return
	}

	// Copy client list FIRST, then release lock before writing
	h.clientsMu.RLock()
	clientList := make([]*websocket.Conn, 0, len(h.clients))
	writeMutexes := make([]*sync.Mutex, 0, len(h.clients))
	for conn, writeMu := range h.clients {
		clientList = append(clientList, conn)
		writeMutexes = append(writeMutexes, writeMu)
	}
	h.clientsMu.RUnlock()

	// Track failed connections for immediate cleanup
	var failedConns []*websocket.Conn

	// Now write to clients without holding clientsMu (prevents deadlock)
	for i, conn := range clientList {
		writeMu := writeMutexes[i]

		// Lock this connection's write mutex
		writeMu.Lock()

		// Set write deadline to avoid blocking forever (reduced from 10s to 5s)
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))

		err := conn.WriteMessage(websocket.TextMessage, messageJSON)
		writeMu.Unlock()

		if err != nil {
			// Log the error and mark connection for cleanup
			log.Printf("DX Cluster WebSocket: Failed to send status to client: %v", err)
			failedConns = append(failedConns, conn)
		}
	}

	// Clean up failed connections immediately
	if len(failedConns) > 0 {
		h.clientsMu.Lock()
		for _, conn := range failedConns {
			if _, exists := h.clients[conn]; exists {
				delete(h.clients, conn)
				conn.Close()
				if h.prometheusMetrics != nil {
					h.prometheusMetrics.RecordWSDisconnect("dxcluster")
				}
			}
		}
		remainingClients := len(h.clients)
		h.clientsMu.Unlock()
		log.Printf("DX Cluster WebSocket: Cleaned up %d failed connection(s) during status broadcast (remaining: %d)", len(failedConns), remainingClients)
	}
}

// sendBufferedSpots sends all buffered spots to a newly connected client
func (h *DXClusterWebSocketHandler) sendBufferedSpots(conn *websocket.Conn) {
	// Get buffered spots from DX cluster client
	bufferedSpots := h.dxCluster.GetBufferedSpots()

	if len(bufferedSpots) == 0 {
		return
	}

	log.Printf("DX Cluster WebSocket: Sending %d buffered spots to new client", len(bufferedSpots))

	// Send each spot as an individual message
	for _, spot := range bufferedSpots {
		message := map[string]interface{}{
			"type": "dx_spot",
			"data": spot,
		}

		if err := h.sendMessage(conn, message); err != nil {
			log.Printf("DX Cluster WebSocket: Failed to send buffered spot: %v", err)
			// Continue sending other spots even if one fails
		}
	}
}

// GetChatUserCount returns the number of active chat users (thread-safe)
// Returns 0 if chat is not enabled
func (h *DXClusterWebSocketHandler) GetChatUserCount() int {
	if h.chatManager == nil {
		return 0
	}
	return h.chatManager.GetActiveUserCount()
}

// AddDXBytes tracks bytes sent to a DX cluster connection for a given UserSessionID
func (h *DXClusterWebSocketHandler) AddDXBytes(userSessionID string, bytes uint64) {
	if userSessionID == "" {
		return
	}

	h.dxThroughputMu.Lock()
	defer h.dxThroughputMu.Unlock()

	// Add to total bytes sent
	h.dxBytesSent[userSessionID] += bytes

	// Add sample to sliding window
	now := time.Now()
	samples := h.dxBytesSamples[userSessionID]
	samples = append(samples, BytesSample{
		Timestamp: now,
		Bytes:     h.dxBytesSent[userSessionID],
	})

	// Remove samples older than 1 second
	cutoff := now.Add(-1 * time.Second)
	for len(samples) > 0 && samples[0].Timestamp.Before(cutoff) {
		samples = samples[1:]
	}

	h.dxBytesSamples[userSessionID] = samples
}

// GetInstantaneousDXKbps returns the instantaneous DX cluster transfer rate in kbps
// for a given UserSessionID using a 1-second sliding window, including 33% overhead
func (h *DXClusterWebSocketHandler) GetInstantaneousDXKbps(userSessionID string) float64 {
	if userSessionID == "" {
		return 0
	}

	h.dxThroughputMu.RLock()
	defer h.dxThroughputMu.RUnlock()

	samples := h.dxBytesSamples[userSessionID]
	if len(samples) < 2 {
		return 0
	}

	// Get oldest and newest samples in the window
	oldest := samples[0]
	newest := samples[len(samples)-1]

	// Calculate time difference
	duration := newest.Timestamp.Sub(oldest.Timestamp).Seconds()
	if duration == 0 {
		return 0
	}

	// Calculate bytes transferred in this window
	bytesDiff := newest.Bytes - oldest.Bytes

	// Convert to kbps (bytes/sec * 8 bits/byte / 1000)
	// Add 33% for protocol overhead (WebSocket + TCP/IP headers)
	payloadKbps := float64(bytesDiff) / duration * 8 / 1000
	return payloadKbps * 1.33
}

// CleanupUserSessionID removes throughput tracking data for a UserSessionID
// Called when all sessions for a user are closed
func (h *DXClusterWebSocketHandler) CleanupUserSessionID(userSessionID string) {
	if userSessionID == "" {
		return
	}

	h.dxThroughputMu.Lock()
	defer h.dxThroughputMu.Unlock()

	delete(h.dxBytesSent, userSessionID)
	delete(h.dxBytesSamples, userSessionID)
}

// HasDXConnection checks if a UserSessionID has an active DX cluster connection
func (h *DXClusterWebSocketHandler) HasDXConnection(userSessionID string) bool {
	if userSessionID == "" {
		return false
	}

	h.connToSessionIDMu.RLock()
	defer h.connToSessionIDMu.RUnlock()

	for _, sid := range h.connToSessionID {
		if sid == userSessionID {
			return true
		}
	}
	return false
}
