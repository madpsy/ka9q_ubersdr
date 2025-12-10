package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocketManager manages the WebSocket connection with thread-safe operations
type WebSocketManager struct {
	client          *RadioClient
	conn            *websocket.Conn // WebSocket connection for sending tune messages
	mu              sync.RWMutex
	connected       bool
	connectedAt     time.Time
	ctx             context.Context
	cancel          context.CancelFunc
	statusBroadcast chan WSStatusUpdate
	errorBroadcast  chan WSErrorUpdate
	connBroadcast   chan WSConnectionUpdate
	subscribers     map[chan interface{}]bool
	subMu           sync.RWMutex
	audioStreams    map[*websocket.Conn]string // Maps WebSocket connections to their audio room names
	audioStreamsMu  sync.RWMutex
}

// NewWebSocketManager creates a new WebSocket manager
func NewWebSocketManager() *WebSocketManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &WebSocketManager{
		ctx:             ctx,
		cancel:          cancel,
		statusBroadcast: make(chan WSStatusUpdate, 10),
		errorBroadcast:  make(chan WSErrorUpdate, 10),
		connBroadcast:   make(chan WSConnectionUpdate, 10),
		subscribers:     make(map[chan interface{}]bool),
		audioStreams:    make(map[*websocket.Conn]string),
	}
}

// Connect establishes a connection to the SDR server
func (m *WebSocketManager) Connect(client *RadioClient) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.connected {
		return fmt.Errorf("already connected")
	}

	m.client = client
	m.connected = true
	m.connectedAt = time.Now()

	// Set callback to capture WebSocket connection when established
	client.connCallback = func(conn *websocket.Conn) {
		m.mu.Lock()
		m.conn = conn
		m.mu.Unlock()
		log.Printf("WebSocket connection captured for tune messages")
	}

	// Start the client in a goroutine
	go func() {
		client.runOnce()

		// Mark as disconnected when client stops
		m.mu.Lock()
		m.connected = false
		m.conn = nil
		m.mu.Unlock()

		// Broadcast disconnection
		m.BroadcastConnection(false, "Connection closed")
	}()

	// Give the client a moment to establish connection
	time.Sleep(200 * time.Millisecond)

	// Broadcast connection
	m.BroadcastConnection(true, "Connected successfully")

	return nil
}

// Disconnect closes the connection to the SDR server
func (m *WebSocketManager) Disconnect() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.connected {
		return fmt.Errorf("not connected")
	}

	if m.client != nil {
		m.client.running = false
	}

	m.connected = false

	// Broadcast disconnection
	m.BroadcastConnection(false, "Disconnected by user")

	return nil
}

// IsConnected returns whether the client is currently connected
func (m *WebSocketManager) IsConnected() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.connected
}

// GetStatus returns the current status
func (m *WebSocketManager) GetStatus() StatusResponse {
	m.mu.RLock()
	defer m.mu.RUnlock()

	status := StatusResponse{
		Connected:     m.connected,
		UserSessionID: "",
	}

	if m.client != nil {
		status.Frequency = m.client.frequency
		status.Mode = m.client.mode
		status.BandwidthLow = m.client.bandwidthLow
		status.BandwidthHigh = m.client.bandwidthHigh
		status.SampleRate = m.client.sampleRate
		status.Channels = m.client.channels
		status.UserSessionID = m.client.userSessionID
		status.AudioDeviceIdx = m.client.audioDeviceIndex
		status.OutputMode = m.client.outputMode
		status.NR2Enabled = m.client.nr2Enabled
		status.NR2Strength = m.client.nr2Strength
		status.NR2Floor = m.client.nr2Floor
		status.NR2AdaptRate = m.client.nr2AdaptRate
		status.ResampleEnabled = m.client.resampleEnabled
		status.ResampleOutputRate = m.client.resampleOutputRate
		status.OutputChannels = m.client.outputChannels
		status.Host = m.client.host
		status.Port = m.client.port
		status.SSL = m.client.ssl

		if m.connected {
			status.ConnectedAt = m.connectedAt
			status.Uptime = time.Since(m.connectedAt).Round(time.Second).String()
		}

		// Get audio device name
		status.AudioDevice = "Default"
		if m.client.audioDeviceIndex >= 0 {
			status.AudioDevice = fmt.Sprintf("Device %d", m.client.audioDeviceIndex)
		}
	}

	return status
}

// Tune changes frequency/mode/bandwidth without reconnecting
func (m *WebSocketManager) Tune(req TuneRequest) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.connected || m.client == nil {
		return fmt.Errorf("not connected")
	}

	// Check if WebSocket connection is available
	if m.conn == nil {
		return fmt.Errorf("WebSocket connection not available")
	}

	// Build tune message
	tuneMsg := map[string]interface{}{
		"type": "tune",
	}

	// Update frequency if provided
	if req.Frequency != nil {
		tuneMsg["frequency"] = *req.Frequency
		m.client.frequency = *req.Frequency
	} else {
		tuneMsg["frequency"] = m.client.frequency
	}

	// Update mode if provided
	if req.Mode != "" {
		tuneMsg["mode"] = req.Mode
		m.client.mode = req.Mode
	} else {
		tuneMsg["mode"] = m.client.mode
	}

	// Update bandwidth if provided (only for non-IQ modes)
	isIQMode := m.client.mode == "iq" || m.client.mode == "iq48" ||
		m.client.mode == "iq96" || m.client.mode == "iq192" || m.client.mode == "iq384"

	if !isIQMode {
		if req.BandwidthLow != nil {
			tuneMsg["bandwidthLow"] = *req.BandwidthLow
			m.client.bandwidthLow = req.BandwidthLow
		} else if m.client.bandwidthLow != nil {
			tuneMsg["bandwidthLow"] = *m.client.bandwidthLow
		}

		if req.BandwidthHigh != nil {
			tuneMsg["bandwidthHigh"] = *req.BandwidthHigh
			m.client.bandwidthHigh = req.BandwidthHigh
		} else if m.client.bandwidthHigh != nil {
			tuneMsg["bandwidthHigh"] = *m.client.bandwidthHigh
		}
	}

	// Send tune message directly via the captured WebSocket connection
	if err := m.conn.WriteJSON(tuneMsg); err != nil {
		return fmt.Errorf("failed to send tune message: %w", err)
	}

	log.Printf("Sent tune message: %+v", tuneMsg)

	// Broadcast status update
	m.BroadcastStatus()

	return nil
}

// SetFrequency changes only the frequency
func (m *WebSocketManager) SetFrequency(frequency int) error {
	return m.Tune(TuneRequest{Frequency: &frequency})
}

// SetMode changes only the mode
func (m *WebSocketManager) SetMode(mode string) error {
	return m.Tune(TuneRequest{Mode: mode})
}

// SetBandwidth changes the bandwidth
func (m *WebSocketManager) SetBandwidth(low, high int) error {
	return m.Tune(TuneRequest{BandwidthLow: &low, BandwidthHigh: &high})
}

// UpdateConfig updates client configuration
func (m *WebSocketManager) UpdateConfig(req ConfigUpdateRequest) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	if req.NR2Enabled != nil {
		m.client.nr2Enabled = *req.NR2Enabled
	}
	if req.NR2Strength != nil {
		m.client.nr2Strength = *req.NR2Strength
		if m.client.nr2Processor != nil {
			m.client.nr2Processor.SetParameters(*req.NR2Strength, m.client.nr2Floor, m.client.nr2AdaptRate)
		}
	}
	if req.NR2Floor != nil {
		m.client.nr2Floor = *req.NR2Floor
		if m.client.nr2Processor != nil {
			m.client.nr2Processor.SetParameters(m.client.nr2Strength, *req.NR2Floor, m.client.nr2AdaptRate)
		}
	}
	if req.NR2AdaptRate != nil {
		m.client.nr2AdaptRate = *req.NR2AdaptRate
		if m.client.nr2Processor != nil {
			m.client.nr2Processor.SetParameters(m.client.nr2Strength, m.client.nr2Floor, *req.NR2AdaptRate)
		}
	}

	return nil
}

// BroadcastStatus sends a status update to all subscribers
func (m *WebSocketManager) BroadcastStatus() {
	if !m.connected || m.client == nil {
		return
	}

	update := WSStatusUpdate{
		Type:       "status",
		Connected:  m.connected,
		Frequency:  m.client.frequency,
		Mode:       m.client.mode,
		SampleRate: m.client.sampleRate,
		Channels:   m.client.channels,
		Timestamp:  time.Now(),
	}

	select {
	case m.statusBroadcast <- update:
	default:
		// Channel full, skip this update
	}

	// Send to all subscribers
	m.broadcastToSubscribers(update)
}

// BroadcastError sends an error update to all subscribers
func (m *WebSocketManager) BroadcastError(err string, message string) {
	update := WSErrorUpdate{
		Type:      "error",
		Error:     err,
		Message:   message,
		Timestamp: time.Now(),
	}

	select {
	case m.errorBroadcast <- update:
	default:
		// Channel full, skip this update
	}

	// Send to all subscribers
	m.broadcastToSubscribers(update)
}

// BroadcastConnection sends a connection state update to all subscribers
func (m *WebSocketManager) BroadcastConnection(connected bool, reason string) {
	update := WSConnectionUpdate{
		Type:      "connection",
		Connected: connected,
		Reason:    reason,
		Timestamp: time.Now(),
	}

	select {
	case m.connBroadcast <- update:
	default:
		// Channel full, skip this update
	}

	// Send to all subscribers
	m.broadcastToSubscribers(update)
}

// Subscribe adds a new subscriber for broadcast messages
func (m *WebSocketManager) Subscribe() chan interface{} {
	m.subMu.Lock()
	defer m.subMu.Unlock()

	ch := make(chan interface{}, 10)
	m.subscribers[ch] = true
	return ch
}

// Unsubscribe removes a subscriber
func (m *WebSocketManager) Unsubscribe(ch chan interface{}) {
	m.subMu.Lock()
	defer m.subMu.Unlock()

	if _, ok := m.subscribers[ch]; ok {
		delete(m.subscribers, ch)
		close(ch)
	}
}

// broadcastToSubscribers sends a message to all subscribers
func (m *WebSocketManager) broadcastToSubscribers(msg interface{}) {
	m.subMu.RLock()
	defer m.subMu.RUnlock()

	for ch := range m.subscribers {
		select {
		case ch <- msg:
		default:
			// Subscriber's channel is full, skip
		}
	}
}

// Cleanup cleans up resources
func (m *WebSocketManager) Cleanup() {
	m.cancel()

	m.subMu.Lock()
	for ch := range m.subscribers {
		close(ch)
	}
	m.subscribers = make(map[chan interface{}]bool)
	m.subMu.Unlock()

	close(m.statusBroadcast)
	close(m.errorBroadcast)
	close(m.connBroadcast)
}

// SendTuneMessage sends a tune message to the SDR server via WebSocket
// This is a helper method that will be used by the RadioClient
func SendTuneMessage(conn *websocket.Conn, frequency int, mode string, bandwidthLow, bandwidthHigh *int) error {
	if conn == nil {
		return fmt.Errorf("no active connection")
	}

	tuneMsg := map[string]interface{}{
		"type":      "tune",
		"frequency": frequency,
		"mode":      mode,
	}

	if bandwidthLow != nil {
		tuneMsg["bandwidthLow"] = *bandwidthLow
	}
	if bandwidthHigh != nil {
		tuneMsg["bandwidthHigh"] = *bandwidthHigh
	}

	return conn.WriteJSON(tuneMsg)
}

// EnableAudioStream enables audio streaming to a WebSocket connection
func (m *WebSocketManager) EnableAudioStream(conn *websocket.Conn, room string) {
	m.audioStreamsMu.Lock()
	defer m.audioStreamsMu.Unlock()

	m.audioStreams[conn] = room
	log.Printf("Enabled audio streaming to room '%s' for connection", room)

	// If we have a client, enable audio callback
	m.mu.RLock()
	client := m.client
	m.mu.RUnlock()

	if client != nil {
		client.SetAudioCallback(func(audioData []byte, sampleRate int, channels int) {
			m.broadcastAudioData(audioData, sampleRate, channels, room)
		})
	}
}

// DisableAudioStream disables audio streaming for a WebSocket connection
func (m *WebSocketManager) DisableAudioStream(conn *websocket.Conn) {
	m.audioStreamsMu.Lock()
	defer m.audioStreamsMu.Unlock()

	if room, ok := m.audioStreams[conn]; ok {
		delete(m.audioStreams, conn)
		log.Printf("Disabled audio streaming from room '%s' for connection", room)
	}

	// If no more audio streams, disable audio callback
	if len(m.audioStreams) == 0 {
		m.mu.RLock()
		client := m.client
		m.mu.RUnlock()

		if client != nil {
			client.SetAudioCallback(nil)
		}
	}
}

// broadcastAudioData sends audio data to all WebSocket connections subscribed to the given room
func (m *WebSocketManager) broadcastAudioData(audioData []byte, sampleRate int, channels int, room string) {
	m.audioStreamsMu.RLock()
	defer m.audioStreamsMu.RUnlock()

	// Encode audio data as base64 for JSON transmission
	encodedData := base64.StdEncoding.EncodeToString(audioData)

	audioMsg := map[string]interface{}{
		"type":       "audio",
		"format":     "pcm",
		"data":       encodedData,
		"sampleRate": sampleRate,
		"channels":   channels,
		"room":       room,
	}

	for conn, connRoom := range m.audioStreams {
		if connRoom == room {
			if err := conn.WriteJSON(audioMsg); err != nil {
				log.Printf("Failed to send audio data to WebSocket: %v", err)
			}
		}
	}
}
