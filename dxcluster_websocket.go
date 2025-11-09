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

	// Receiver location for distance/bearing calculation
	receiverLocator string
}

// NewDXClusterWebSocketHandler creates a new DX cluster WebSocket handler
func NewDXClusterWebSocketHandler(dxCluster *DXClusterClient, sessions *SessionManager, ipBanManager *IPBanManager, prometheusMetrics *PrometheusMetrics, receiverLocator string) *DXClusterWebSocketHandler {
	handler := &DXClusterWebSocketHandler{
		clients:           make(map[*websocket.Conn]*sync.Mutex),
		dxCluster:         dxCluster,
		sessions:          sessions,
		ipBanManager:      ipBanManager,
		prometheusMetrics: prometheusMetrics,
		digitalSpotCache:  make(map[digitalSpotKey]time.Time),
		digitalSpotBuffer: make([]map[string]interface{}, 0, 500),
		maxDigitalSpots:   500,
		receiverLocator:   receiverLocator,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for now
			},
		},
	}

	// Register spot handler to broadcast to all clients
	dxCluster.OnSpot(func(spot DXSpot) {
		handler.broadcastSpot(spot)
	})

	// Start cleanup goroutine for digital spot cache
	go handler.cleanupDigitalSpotCache()

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

	log.Printf("DX Cluster WebSocket: Client connected, user_session_id: %s, source IP: %s, client IP: %s (total: %d)", userSessionID, sourceIP, clientIP, clientCount)

	// Record connection in Prometheus
	if h.prometheusMetrics != nil {
		h.prometheusMetrics.RecordWSConnection("dxcluster")
	}

	// Send connection status
	h.sendConnectionStatus(conn)

	// Send buffered DX spots to new client
	h.sendBufferedSpots(conn)

	// Send buffered digital spots to new client
	h.sendBufferedDigitalSpots(conn)

	// Handle client messages (mainly for ping/pong)
	go h.handleClient(conn)
}

// handleClient handles messages from a WebSocket client
func (h *DXClusterWebSocketHandler) handleClient(conn *websocket.Conn) {
	defer func() {
		// Unregister client
		h.clientsMu.Lock()
		delete(h.clients, conn)
		clientCount := len(h.clients)
		h.clientsMu.Unlock()

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

	// Read messages (mainly for keepalive)
	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("DX Cluster WebSocket: Read error: %v", err)
			}
			break
		}

		// Handle ping messages
		if messageType == websocket.TextMessage {
			var msg map[string]interface{}
			if err := json.Unmarshal(message, &msg); err == nil {
				if msgType, ok := msg["type"].(string); ok && msgType == "ping" {
					h.sendMessage(conn, map[string]interface{}{
						"type": "pong",
					})
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

	// Calculate distance and bearing if we have both locators
	var distanceKm *float64
	var bearingDeg *float64
	var spotLat *float64
	var spotLon *float64

	if h.receiverLocator != "" && decode.Locator != "" {
		if IsValidMaidenheadLocator(h.receiverLocator) && IsValidMaidenheadLocator(decode.Locator) {
			dist, bearing, err := CalculateDistanceAndBearingFromLocators(h.receiverLocator, decode.Locator)
			if err == nil {
				distanceKm = &dist
				bearingDeg = &bearing
			}
		}
	}

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
		"snr":          decode.SNR,
		"frequency":    decode.Frequency,
		"timestamp":    decode.Timestamp,
		"message":      decode.Message,
		"dt":           decode.DT,
		"drift":        decode.Drift,
		"dbm":          decode.DBm,
		"tx_frequency": decode.TxFrequency,
	}

	// Add distance and bearing if calculated
	if distanceKm != nil {
		data["distance_km"] = *distanceKm
	}
	if bearingDeg != nil {
		data["bearing_deg"] = *bearingDeg
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
	case freq >= 0.472 && freq < 0.479:
		return "630m"
	case freq >= 1.8 && freq < 2.0:
		return "160m"
	case freq >= 3.5 && freq < 4.0:
		return "80m"
	case freq >= 5.3 && freq < 5.5:
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

	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()

	for conn, writeMu := range h.clients {
		// Lock this connection's write mutex
		writeMu.Lock()

		// Set write deadline to avoid blocking forever
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

		err := conn.WriteMessage(websocket.TextMessage, messageJSON)
		writeMu.Unlock()

		if err != nil {
			// Just log the error - the read handler will detect and clean up dead connections
			log.Printf("DX Cluster WebSocket: Failed to send message to client: %v", err)
		}
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

	// Get the write mutex for this connection
	h.clientsMu.RLock()
	writeMu, exists := h.clients[conn]
	h.clientsMu.RUnlock()

	if !exists {
		return fmt.Errorf("connection not found")
	}

	// Lock before writing
	writeMu.Lock()
	defer writeMu.Unlock()

	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, messageJSON)
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

	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()

	for conn, writeMu := range h.clients {
		// Lock this connection's write mutex
		writeMu.Lock()

		// Set write deadline to avoid blocking forever
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

		err := conn.WriteMessage(websocket.TextMessage, messageJSON)
		writeMu.Unlock()

		if err != nil {
			// Just log the error - the read handler will detect and clean up dead connections
			log.Printf("DX Cluster WebSocket: Failed to send status to client: %v", err)
		}
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
			"type": "spot",
			"data": spot,
		}

		if err := h.sendMessage(conn, message); err != nil {
			log.Printf("DX Cluster WebSocket: Failed to send buffered spot: %v", err)
			// Continue sending other spots even if one fails
		}
	}
}
