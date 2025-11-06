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

// DXClusterWebSocketHandler manages WebSocket connections for DX cluster spots
type DXClusterWebSocketHandler struct {
	clients           map[*websocket.Conn]*sync.Mutex // Each connection has its own write mutex
	clientsMu         sync.RWMutex
	dxCluster         *DXClusterClient
	sessions          *SessionManager
	ipBanManager      *IPBanManager
	prometheusMetrics *PrometheusMetrics
	upgrader          websocket.Upgrader
}

// NewDXClusterWebSocketHandler creates a new DX cluster WebSocket handler
func NewDXClusterWebSocketHandler(dxCluster *DXClusterClient, sessions *SessionManager, ipBanManager *IPBanManager, prometheusMetrics *PrometheusMetrics) *DXClusterWebSocketHandler {
	handler := &DXClusterWebSocketHandler{
		clients:           make(map[*websocket.Conn]*sync.Mutex),
		dxCluster:         dxCluster,
		sessions:          sessions,
		ipBanManager:      ipBanManager,
		prometheusMetrics: prometheusMetrics,
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

	// Send buffered spots to new client
	h.sendBufferedSpots(conn)

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
		"type": "spot",
		"data": spot,
	}

	messageJSON, err := json.Marshal(message)
	if err != nil {
		log.Printf("DX Cluster WebSocket: Failed to marshal spot: %v", err)
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
			log.Printf("DX Cluster WebSocket: Failed to send spot to client: %v", err)
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
