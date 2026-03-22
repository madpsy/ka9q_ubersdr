package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// FreeDVReporterClient connects to a FreeDV Reporter server as a view-only client,
// receives the live activity list, and notifies registered callbacks.
//
// Wire protocol (Engine.IO v4 / Socket.IO v4 over WebSocket):
//
//	Engine.IO prefix byte:
//	  '0' = OPEN  (server sends JSON with pingInterval/pingTimeout)
//	  '1' = CLOSE
//	  '2' = PING  → client replies '3' (PONG)
//	  '4' = MESSAGE (contains Socket.IO payload)
//
//	Socket.IO prefix byte (after stripping Engine.IO '4'):
//	  '0' = CONNECT ACK
//	  '2' = EVENT  → JSON array [eventName, payload]
//	  '4' = CONNECT ERROR
//
//	Client emits use prefix "42", e.g.:  42["freq_change",{"freq":14236000}]
//	Namespace open uses "40" + auth JSON.
const (
	freedvReporterProtocolVersion = 2
	freedvReporterDefaultURI      = "ws://qso.freedv.org:80/socket.io/?EIO=4&transport=websocket"
	freedvReporterReconnectDelay  = 30 * time.Second
	freedvReporterPingTimeout     = 35 * time.Second // slightly longer than typical 25s pingInterval
)

// FreeDVReporterCallbacks holds the event callbacks for the reporter client.
// All callbacks are called from the client's internal goroutine; implementations
// must not block for long.
type FreeDVReporterCallbacks struct {
	// OnConnect is called when the connection to the server is established and
	// the connection_successful event has been received (i.e. full state is ready).
	OnConnect func()

	// OnDisconnect is called when the connection is lost.
	OnDisconnect func()

	// OnNewConnection is called when a new user appears on the network.
	OnNewConnection func(user FreeDVReporterUser)

	// OnRemoveConnection is called when a user disconnects.
	OnRemoveConnection func(sid string)

	// OnFrequencyChange is called when a user changes frequency.
	OnFrequencyChange func(sid string, freqHz uint64)

	// OnTxReport is called when a user's transmit state changes.
	OnTxReport func(sid string, mode string, transmitting bool, lastTx string)

	// OnRxReport is called when a user reports receiving another station.
	OnRxReport func(sid string, receivedCallsign string, snr float32, mode string)

	// OnMessageUpdate is called when a user updates their status message.
	OnMessageUpdate func(sid string, message string)
}

// FreeDVReporterClient manages a persistent view-only connection to a FreeDV Reporter server.
type FreeDVReporterClient struct {
	uri       string
	callbacks FreeDVReporterCallbacks

	mu      sync.Mutex
	conn    *websocket.Conn
	stopCh  chan struct{}
	stopped bool
}

// NewFreeDVReporterClient creates a new client. Call Start() to begin connecting.
func NewFreeDVReporterClient(uri string, callbacks FreeDVReporterCallbacks) *FreeDVReporterClient {
	if uri == "" {
		uri = freedvReporterDefaultURI
	}
	return &FreeDVReporterClient{
		uri:       uri,
		callbacks: callbacks,
		stopCh:    make(chan struct{}),
	}
}

// Start begins the connection loop in a background goroutine.
func (c *FreeDVReporterClient) Start() {
	go c.loop()
}

// Stop shuts down the client and closes any active connection.
func (c *FreeDVReporterClient) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return
	}
	c.stopped = true
	close(c.stopCh)
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

// loop is the main reconnection loop.
func (c *FreeDVReporterClient) loop() {
	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		if err := c.runOnce(); err != nil {
			log.Printf("[FreeDVReporter] Disconnected: %v — retrying in %s", err, freedvReporterReconnectDelay)
		}

		if c.callbacks.OnDisconnect != nil {
			c.callbacks.OnDisconnect()
		}

		select {
		case <-c.stopCh:
			return
		case <-time.After(freedvReporterReconnectDelay):
		}
	}
}

// runOnce establishes one WebSocket connection and processes messages until it drops.
func (c *FreeDVReporterClient) runOnce() error {
	// Parse and validate the URI
	u, err := url.Parse(c.uri)
	if err != nil {
		return fmt.Errorf("invalid URI %q: %w", c.uri, err)
	}

	log.Printf("[FreeDVReporter] Connecting to %s", u.String())

	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
	}
	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
		conn.Close()
	}()

	// pingDeadline is reset each time we receive a PING from the server.
	// If we don't hear a ping within this window we treat the connection as dead.
	pingDeadline := time.Now().Add(freedvReporterPingTimeout)

	for {
		// Check stop signal
		select {
		case <-c.stopCh:
			return nil
		default:
		}

		// Apply a read deadline slightly beyond the expected ping interval
		conn.SetReadDeadline(pingDeadline)

		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read error: %w", err)
		}

		if len(msg) == 0 {
			continue
		}

		switch msg[0] {
		case '0':
			// Engine.IO OPEN — parse pingInterval/pingTimeout and send namespace open
			pingDeadline = c.handleEngineOpen(conn, msg[1:])

		case '1':
			// Engine.IO CLOSE
			return fmt.Errorf("server sent close")

		case '2':
			// Engine.IO PING — reply with PONG and reset deadline
			pingDeadline = time.Now().Add(freedvReporterPingTimeout)
			if err := conn.WriteMessage(websocket.TextMessage, []byte("3")); err != nil {
				return fmt.Errorf("pong write error: %w", err)
			}

		case '4':
			// Engine.IO MESSAGE — contains Socket.IO payload
			if len(msg) < 2 {
				continue
			}
			if err := c.handleSocketIO(conn, msg[1:]); err != nil {
				return err
			}

		default:
			// Ignore unknown Engine.IO packet types (e.g. upgrade probes)
		}
	}
}

// handleEngineOpen processes the Engine.IO OPEN packet, extracts ping timings,
// sends the Socket.IO namespace-open packet, and returns the new ping deadline.
func (c *FreeDVReporterClient) handleEngineOpen(conn *websocket.Conn, payload []byte) time.Time {
	var info struct {
		PingInterval int `json:"pingInterval"` // milliseconds
		PingTimeout  int `json:"pingTimeout"`  // milliseconds
	}
	if err := json.Unmarshal(payload, &info); err != nil {
		log.Printf("[FreeDVReporter] Could not parse OPEN payload: %v", err)
	}

	// Calculate deadline: pingInterval + pingTimeout (same logic as C++ client)
	totalMs := info.PingInterval + info.PingTimeout
	if totalMs <= 0 {
		totalMs = int(freedvReporterPingTimeout.Milliseconds())
	}
	deadline := time.Now().Add(time.Duration(totalMs) * time.Millisecond)

	// Send Socket.IO namespace open with view-only auth
	auth := map[string]interface{}{
		"role":             "view",
		"protocol_version": freedvReporterProtocolVersion,
	}
	authJSON, _ := json.Marshal(auth)
	namespaceOpen := "40" + string(authJSON)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(namespaceOpen)); err != nil {
		log.Printf("[FreeDVReporter] Failed to send namespace open: %v", err)
	}

	log.Printf("[FreeDVReporter] Engine.IO open (pingInterval=%dms, pingTimeout=%dms)", info.PingInterval, info.PingTimeout)
	return deadline
}

// handleSocketIO processes a Socket.IO payload (after stripping the Engine.IO '4' prefix).
func (c *FreeDVReporterClient) handleSocketIO(conn *websocket.Conn, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}

	switch payload[0] {
	case '0':
		// Socket.IO CONNECT ACK — namespace joined
		log.Printf("[FreeDVReporter] Socket.IO namespace connected")

	case '2':
		// Socket.IO EVENT — JSON array [eventName, eventData]
		if len(payload) < 2 {
			return nil
		}
		c.handleSocketIOEvent(payload[1:])

	case '4':
		// Socket.IO CONNECT ERROR
		return fmt.Errorf("socket.io connect error: %s", string(payload[1:]))
	}
	return nil
}

// handleSocketIOEvent parses a Socket.IO event array and dispatches to the appropriate handler.
func (c *FreeDVReporterClient) handleSocketIOEvent(data []byte) {
	// Events arrive as a JSON array: [eventName, payload]
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || len(raw) < 1 {
		return
	}

	var eventName string
	if err := json.Unmarshal(raw[0], &eventName); err != nil {
		return
	}

	var payload json.RawMessage
	if len(raw) >= 2 {
		payload = raw[1]
	}

	switch eventName {
	case "connection_successful":
		log.Printf("[FreeDVReporter] Connection successful — activity list ready")
		if c.callbacks.OnConnect != nil {
			c.callbacks.OnConnect()
		}

	case "new_connection":
		c.handleNewConnection(payload)

	case "remove_connection":
		c.handleRemoveConnection(payload)

	case "freq_change":
		c.handleFreqChange(payload)

	case "tx_report":
		c.handleTxReport(payload)

	case "rx_report":
		c.handleRxReport(payload)

	case "message_update":
		c.handleMessageUpdate(payload)

	case "bulk_update":
		// bulk_update is an array of [eventName, payload] pairs — replay each one
		c.handleBulkUpdate(payload)

	case "qsy_request":
		// Not relevant for a view-only client

	default:
		// Unknown event — ignore
	}
}

// handleBulkUpdate processes the bulk_update event which contains an array of
// [eventName, payload] pairs sent by the server to initialise state for new clients.
func (c *FreeDVReporterClient) handleBulkUpdate(data []byte) {
	var events [][]json.RawMessage
	if err := json.Unmarshal(data, &events); err != nil {
		log.Printf("[FreeDVReporter] Failed to parse bulk_update: %v", err)
		return
	}

	for _, pair := range events {
		if len(pair) < 2 {
			continue
		}
		var name string
		if err := json.Unmarshal(pair[0], &name); err != nil {
			continue
		}
		c.handleSocketIOEvent(buildEventArray(name, pair[1]))
	}
}

// buildEventArray re-serialises a name+payload into the [name, payload] JSON array
// format expected by handleSocketIOEvent.
func buildEventArray(name string, payload json.RawMessage) []byte {
	nameJSON, _ := json.Marshal(name)
	var sb strings.Builder
	sb.WriteByte('[')
	sb.Write(nameJSON)
	sb.WriteByte(',')
	sb.Write(payload)
	sb.WriteByte(']')
	return []byte(sb.String())
}

// --- individual event handlers ---

func (c *FreeDVReporterClient) handleNewConnection(data []byte) {
	var msg struct {
		SID         string `json:"sid"`
		LastUpdate  string `json:"last_update"`
		Callsign    string `json:"callsign"`
		GridSquare  string `json:"grid_square"`
		Version     string `json:"version"`
		RxOnly      bool   `json:"rx_only"`
		ConnectTime string `json:"connect_time"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.SID == "" {
		return
	}

	user := FreeDVReporterUser{
		SID:         msg.SID,
		Callsign:    msg.Callsign,
		GridSquare:  msg.GridSquare,
		Version:     msg.Version,
		RxOnly:      msg.RxOnly,
		ConnectTime: msg.ConnectTime,
		LastUpdate:  msg.LastUpdate,
	}

	if c.callbacks.OnNewConnection != nil {
		c.callbacks.OnNewConnection(user)
	}
}

func (c *FreeDVReporterClient) handleRemoveConnection(data []byte) {
	var msg struct {
		SID string `json:"sid"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.SID == "" {
		return
	}
	if c.callbacks.OnRemoveConnection != nil {
		c.callbacks.OnRemoveConnection(msg.SID)
	}
}

func (c *FreeDVReporterClient) handleFreqChange(data []byte) {
	var msg struct {
		SID    string `json:"sid"`
		FreqHz uint64 `json:"freq"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.SID == "" {
		return
	}
	if c.callbacks.OnFrequencyChange != nil {
		c.callbacks.OnFrequencyChange(msg.SID, msg.FreqHz)
	}
}

func (c *FreeDVReporterClient) handleTxReport(data []byte) {
	var msg struct {
		SID          string  `json:"sid"`
		Mode         string  `json:"mode"`
		Transmitting bool    `json:"transmitting"`
		LastTx       *string `json:"last_tx"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.SID == "" {
		return
	}
	lastTx := ""
	if msg.LastTx != nil {
		lastTx = *msg.LastTx
	}
	if c.callbacks.OnTxReport != nil {
		c.callbacks.OnTxReport(msg.SID, msg.Mode, msg.Transmitting, lastTx)
	}
}

func (c *FreeDVReporterClient) handleRxReport(data []byte) {
	var msg struct {
		SID                string  `json:"sid"`
		ReceiverCallsign   string  `json:"receiver_callsign"`
		ReceiverGridSquare string  `json:"receiver_grid_square"`
		Callsign           string  `json:"callsign"`
		SNR                float32 `json:"snr"`
		Mode               string  `json:"mode"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.SID == "" {
		return
	}
	if c.callbacks.OnRxReport != nil {
		c.callbacks.OnRxReport(msg.SID, msg.Callsign, msg.SNR, msg.Mode)
	}
}

func (c *FreeDVReporterClient) handleMessageUpdate(data []byte) {
	var msg struct {
		SID     string `json:"sid"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.SID == "" {
		return
	}
	if c.callbacks.OnMessageUpdate != nil {
		c.callbacks.OnMessageUpdate(msg.SID, msg.Message)
	}
}
