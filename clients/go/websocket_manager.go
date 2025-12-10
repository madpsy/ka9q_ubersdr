package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocketManager manages the WebSocket connection with thread-safe operations
type WebSocketManager struct {
	client             *RadioClient
	conn               *websocket.Conn // WebSocket connection for sending tune messages
	connMu             sync.Mutex      // Protects WebSocket writes
	mu                 sync.RWMutex
	connected          bool
	connectedAt        time.Time
	bypassed           bool     // Whether the connection is bypassed (from /connection response)
	allowedIQModes     []string // Allowed IQ modes (from /connection response)
	ctx                context.Context
	cancel             context.CancelFunc
	statusBroadcast    chan WSStatusUpdate
	errorBroadcast     chan WSErrorUpdate
	connBroadcast      chan WSConnectionUpdate
	subscribers        map[chan interface{}]bool
	subMu              sync.RWMutex
	audioStreams       map[*websocket.Conn]string // Maps WebSocket connections to their audio room names
	audioStreamsMu     sync.RWMutex
	audioWriteChans    map[*websocket.Conn]chan interface{} // Per-connection write channels for audio
	spectrumClient     *SpectrumClient                      // Spectrum WebSocket client
	spectrumStreams    map[*websocket.Conn]string           // Maps WebSocket connections to their spectrum room names
	spectrumStreamsMu  sync.RWMutex
	spectrumWriteChans map[*websocket.Conn]chan interface{} // Per-connection write channels for spectrum
	flrigClient        *FlrigClient                         // flrig radio control client
	flrigPolling       bool                                 // Whether flrig polling is active
	flrigPollCancel    context.CancelFunc                   // Cancel function for flrig polling
	flrigSyncToRig     bool                                 // Sync SDR frequency changes to rig
	flrigSyncFromRig   bool                                 // Sync rig frequency changes to SDR
	rigctlClient       *RigctlClient                        // rigctl radio control client
	rigctlPolling      bool                                 // Whether rigctl polling is active
	rigctlPollCancel   context.CancelFunc                   // Cancel function for rigctl polling
	rigctlSyncToRig    bool                                 // Sync SDR frequency changes to rig
	rigctlSyncFromRig  bool                                 // Sync rig frequency changes to SDR
	serialServer       *SerialCATServer                     // serial CAT server
}

// NewWebSocketManager creates a new WebSocket manager
func NewWebSocketManager() *WebSocketManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &WebSocketManager{
		ctx:                ctx,
		cancel:             cancel,
		statusBroadcast:    make(chan WSStatusUpdate, 10),
		errorBroadcast:     make(chan WSErrorUpdate, 10),
		connBroadcast:      make(chan WSConnectionUpdate, 10),
		subscribers:        make(map[chan interface{}]bool),
		audioStreams:       make(map[*websocket.Conn]string),
		audioWriteChans:    make(map[*websocket.Conn]chan interface{}),
		spectrumStreams:    make(map[*websocket.Conn]string),
		spectrumWriteChans: make(map[*websocket.Conn]chan interface{}),
	}
}

// Connect establishes a connection to the SDR server
func (m *WebSocketManager) Connect(client *RadioClient) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.connected {
		return fmt.Errorf("already connected")
	}

	// Check connection permission and get allowed IQ modes
	allowed, err := client.CheckConnectionAllowed()
	if err != nil {
		log.Printf("Connection check error: %v", err)
	}
	if !allowed {
		return fmt.Errorf("connection not allowed")
	}

	// Store connection data from client
	m.bypassed = client.bypassed
	m.allowedIQModes = client.allowedIQModes

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
		m.bypassed = false
		m.allowedIQModes = nil
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
		Connected:      m.connected,
		UserSessionID:  "",
		Bypassed:       m.bypassed,
		AllowedIQModes: m.allowedIQModes,
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

// GetStatusWithOutputs returns the current status including output status
func (m *WebSocketManager) GetStatusWithOutputs() StatusResponse {
	status := m.GetStatus()
	status.OutputStatus = m.GetOutputStatus()
	return status
}

// Tune changes frequency/mode/bandwidth without reconnecting
func (m *WebSocketManager) Tune(req TuneRequest) error {
	// Read state with RLock first
	m.mu.RLock()
	if !m.connected || m.client == nil {
		m.mu.RUnlock()
		return fmt.Errorf("not connected")
	}
	if m.conn == nil {
		m.mu.RUnlock()
		return fmt.Errorf("WebSocket connection not available")
	}

	// Build tune message while holding RLock
	tuneMsg := map[string]interface{}{
		"type": "tune",
	}

	// Update frequency if provided
	if req.Frequency != nil {
		tuneMsg["frequency"] = *req.Frequency
	} else {
		tuneMsg["frequency"] = m.client.frequency
	}

	// Update mode if provided
	if req.Mode != "" {
		tuneMsg["mode"] = req.Mode
	} else {
		tuneMsg["mode"] = m.client.mode
	}

	// Update bandwidth if provided (only for non-IQ modes)
	isIQMode := m.client.mode == "iq" || m.client.mode == "iq48" ||
		m.client.mode == "iq96" || m.client.mode == "iq192" || m.client.mode == "iq384"

	if !isIQMode {
		if req.BandwidthLow != nil {
			tuneMsg["bandwidthLow"] = *req.BandwidthLow
		} else if m.client.bandwidthLow != nil {
			tuneMsg["bandwidthLow"] = *m.client.bandwidthLow
		}

		if req.BandwidthHigh != nil {
			tuneMsg["bandwidthHigh"] = *req.BandwidthHigh
		} else if m.client.bandwidthHigh != nil {
			tuneMsg["bandwidthHigh"] = *m.client.bandwidthHigh
		}
	}

	conn := m.conn
	flrigClient := m.flrigClient
	flrigSyncToRig := m.flrigSyncToRig
	rigctlClient := m.rigctlClient
	rigctlSyncToRig := m.rigctlSyncToRig
	serialServer := m.serialServer
	m.mu.RUnlock()

	// Send tune message with WebSocket write lock
	m.connMu.Lock()
	err := conn.WriteJSON(tuneMsg)
	m.connMu.Unlock()

	if err != nil {
		return fmt.Errorf("failed to send tune message: %w", err)
	}

	log.Printf("Sent tune message: %+v", tuneMsg)

	// Update client state with Lock
	m.mu.Lock()
	if req.Frequency != nil {
		m.client.frequency = *req.Frequency
	}
	if req.Mode != "" {
		m.client.mode = req.Mode
	}
	if req.BandwidthLow != nil {
		m.client.bandwidthLow = req.BandwidthLow
	}
	if req.BandwidthHigh != nil {
		m.client.bandwidthHigh = req.BandwidthHigh
	}
	m.mu.Unlock()

	// Sync to flrig if enabled and connected (without holding lock)
	if flrigClient != nil && flrigClient.IsConnected() && flrigSyncToRig {
		if req.Frequency != nil {
			if err := flrigClient.SetFrequency(*req.Frequency); err != nil {
				log.Printf("Warning: Failed to sync frequency to flrig: %v", err)
			} else {
				log.Printf("Synced frequency %d Hz to flrig", *req.Frequency)
			}
		}
		if req.Mode != "" {
			if err := flrigClient.SetMode(req.Mode); err != nil {
				log.Printf("Warning: Failed to sync mode to flrig: %v", err)
			} else {
				log.Printf("Synced mode %s to flrig", req.Mode)
			}
		}
	}

	// Sync to rigctl if enabled and connected (without holding lock)
	if rigctlClient != nil && rigctlClient.IsConnected() && rigctlSyncToRig {
		if req.Frequency != nil {
			if err := rigctlClient.SetFrequency(*req.Frequency); err != nil {
				log.Printf("Warning: Failed to sync frequency to rigctl: %v", err)
			} else {
				log.Printf("Synced frequency %d Hz to rigctl", *req.Frequency)
			}
		}
		if req.Mode != "" {
			if err := rigctlClient.SetMode(req.Mode); err != nil {
				log.Printf("Warning: Failed to sync mode to rigctl: %v", err)
			} else {
				log.Printf("Synced mode %s to rigctl", req.Mode)
			}
		}
	}

	// Update serial server's cached frequency/mode if running (without holding lock)
	if serialServer != nil && serialServer.IsRunning() {
		if req.Frequency != nil {
			serialServer.UpdateFrequency(*req.Frequency)
		}
		if req.Mode != "" {
			serialServer.UpdateMode(req.Mode)
		}
	}

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

// Output Control Methods

// EnablePortAudioOutput enables PortAudio output with the specified device
func (m *WebSocketManager) EnablePortAudioOutput(deviceIndex int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	// Run PortAudio initialization in a goroutine with timeout to handle potential crashes
	errChan := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				errChan <- fmt.Errorf("PortAudio panic: %v", r)
			}
		}()
		errChan <- m.client.EnablePortAudio(deviceIndex)
	}()

	// Wait for result with timeout
	select {
	case err := <-errChan:
		return err
	case <-time.After(5 * time.Second):
		return fmt.Errorf("PortAudio initialization timeout (possible system audio configuration issue)")
	}
}

// DisablePortAudioOutput disables PortAudio output
func (m *WebSocketManager) DisablePortAudioOutput() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	return m.client.DisablePortAudio()
}

// EnableFIFOOutput enables FIFO output at the specified path
func (m *WebSocketManager) EnableFIFOOutput(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	return m.client.EnableFIFO(path)
}

// DisableFIFOOutput disables FIFO output
func (m *WebSocketManager) DisableFIFOOutput() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	return m.client.DisableFIFO()
}

// EnableUDPOutput enables UDP output to the specified host and port
func (m *WebSocketManager) EnableUDPOutput(host string, port int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	return m.client.EnableUDP(host, port)
}

// DisableUDPOutput disables UDP output
func (m *WebSocketManager) DisableUDPOutput() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil {
		return fmt.Errorf("client not initialized")
	}

	return m.client.DisableUDP()
}

// GetOutputStatus returns the current status of all outputs
func (m *WebSocketManager) GetOutputStatus() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.client == nil {
		return map[string]interface{}{
			"portaudio": map[string]interface{}{"enabled": false},
			"fifo":      map[string]interface{}{"enabled": false},
			"udp":       map[string]interface{}{"enabled": false},
		}
	}

	return m.client.GetOutputStatus()
}

// BroadcastStatus sends a status update to all subscribers
func (m *WebSocketManager) BroadcastStatus() {
	m.mu.RLock()
	if !m.connected || m.client == nil {
		m.mu.RUnlock()
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
	m.mu.RUnlock()

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
// The writeChan parameter is optional - if provided, audio data will be sent through it
// instead of directly to the connection (for API server WebSocket connections)
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
		delete(m.audioWriteChans, conn)
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

	// Send to all connections for this room via their write channels
	m.audioStreamsMu.RLock()
	for conn, connRoom := range m.audioStreams {
		if connRoom == room {
			if writeChan, ok := m.audioWriteChans[conn]; ok {
				select {
				case writeChan <- audioMsg:
					// Sent successfully
				default:
					// Channel full, skip this frame
					log.Printf("Audio write channel full for room '%s', dropping frame", room)
				}
			}
		}
	}
	m.audioStreamsMu.RUnlock()
}

// EnableSpectrumStream enables spectrum streaming to a WebSocket connection
func (m *WebSocketManager) EnableSpectrumStream(conn *websocket.Conn, room string) error {
	m.spectrumStreamsMu.Lock()
	defer m.spectrumStreamsMu.Unlock()

	m.spectrumStreams[conn] = room
	log.Printf("Enabled spectrum streaming to room '%s' for connection", room)

	// Create spectrum client if not exists
	m.mu.Lock()
	if m.spectrumClient == nil && m.client != nil {
		// Build server URL from client config
		protocol := "http"
		if m.client.ssl {
			protocol = "https"
		}
		serverURL := fmt.Sprintf("%s://%s:%d", protocol, m.client.host, m.client.port)

		m.spectrumClient = NewSpectrumClient(serverURL, m.client.userSessionID, m.client.password)

		// Set callback to broadcast spectrum data
		m.spectrumClient.SetDataCallback(func(data []byte) {
			m.broadcastSpectrumData(data, room)
		})

		// Connect to spectrum WebSocket
		if err := m.spectrumClient.Connect(); err != nil {
			m.mu.Unlock()
			return fmt.Errorf("failed to connect spectrum client: %w", err)
		}
	}
	m.mu.Unlock()

	return nil
}

// DisableSpectrumStream disables spectrum streaming for a WebSocket connection
func (m *WebSocketManager) DisableSpectrumStream(conn *websocket.Conn) {
	m.spectrumStreamsMu.Lock()
	defer m.spectrumStreamsMu.Unlock()

	if room, ok := m.spectrumStreams[conn]; ok {
		delete(m.spectrumStreams, conn)
		delete(m.spectrumWriteChans, conn)
		log.Printf("Disabled spectrum streaming from room '%s' for connection", room)
	}

	// If no more spectrum streams, disconnect spectrum client
	if len(m.spectrumStreams) == 0 {
		m.mu.Lock()
		if m.spectrumClient != nil {
			m.spectrumClient.Disconnect()
			m.spectrumClient = nil
		}
		m.mu.Unlock()
	}
}

// broadcastSpectrumData sends spectrum data to all WebSocket connections subscribed to the given room
func (m *WebSocketManager) broadcastSpectrumData(data []byte, room string) {
	// Parse the JSON data to send as a map
	var spectrumMsg map[string]interface{}
	if err := json.Unmarshal(data, &spectrumMsg); err != nil {
		log.Printf("Failed to unmarshal spectrum data: %v", err)
		return
	}

	// Send to all connections for this room via their write channels
	m.spectrumStreamsMu.RLock()
	for conn, connRoom := range m.spectrumStreams {
		if connRoom == room {
			if writeChan, ok := m.spectrumWriteChans[conn]; ok {
				select {
				case writeChan <- spectrumMsg:
					// Sent successfully
				default:
					// Channel full, skip this frame
					log.Printf("Spectrum write channel full for room '%s', dropping frame", room)
				}
			}
		}
	}
	m.spectrumStreamsMu.RUnlock()
}

// SendSpectrumCommand sends a command to the spectrum WebSocket (zoom, pan, etc.)
func (m *WebSocketManager) SendSpectrumCommand(cmdType string, params map[string]interface{}) error {
	m.mu.RLock()
	spectrumClient := m.spectrumClient
	m.mu.RUnlock()

	if spectrumClient == nil || !spectrumClient.IsConnected() {
		return fmt.Errorf("spectrum client not connected")
	}

	switch cmdType {
	case "zoom":
		frequency, ok1 := params["frequency"].(float64)
		binBandwidth, ok2 := params["binBandwidth"].(float64)
		if !ok1 || !ok2 {
			return fmt.Errorf("invalid zoom parameters")
		}
		return spectrumClient.SendZoomCommand(int(frequency), binBandwidth)

	case "pan":
		frequency, ok := params["frequency"].(float64)
		if !ok {
			return fmt.Errorf("invalid pan parameters")
		}
		return spectrumClient.SendPanCommand(int(frequency))

	default:
		return fmt.Errorf("unknown command type: %s", cmdType)
	}
}

// Radio Control Methods (flrig)

// ConnectFlrig connects to flrig server
func (m *WebSocketManager) ConnectFlrig(host string, port int, vfo string, syncToRig bool, syncFromRig bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Disconnect existing flrig client if any
	if m.flrigClient != nil {
		m.stopFlrigPolling()
		m.flrigClient.Disconnect()
		m.flrigClient = nil
	}

	// Store sync direction settings
	m.flrigSyncToRig = syncToRig
	m.flrigSyncFromRig = syncFromRig

	// Create new flrig client
	m.flrigClient = NewFlrigClient(host, port, vfo)

	// Set up callbacks
	m.flrigClient.SetCallbacks(
		func(freq int) {
			// Run callback in goroutine to avoid blocking polling
			go func() {
				// Check sync setting with lock
				m.mu.RLock()
				syncFromRig := m.flrigSyncFromRig
				m.mu.RUnlock()

				if !syncFromRig {
					log.Printf("flrig frequency changed to %d Hz (sync disabled)", freq)
					return
				}

				// Check connection without holding lock for too long
				m.mu.RLock()
				connected := m.connected
				client := m.client
				m.mu.RUnlock()

				if !connected || client == nil {
					log.Printf("flrig frequency changed to %d Hz (not connected to SDR)", freq)
					return
				}

				log.Printf("flrig frequency changed to %d Hz (syncing to SDR)", freq)

				// Temporarily disable sync to rig to avoid feedback loop
				m.mu.Lock()
				oldSyncToRig := m.flrigSyncToRig
				m.flrigSyncToRig = false
				m.mu.Unlock()

				if err := m.SetFrequency(freq); err != nil {
					log.Printf("Failed to update SDR frequency from flrig: %v", err)
				}

				// Restore sync setting
				m.mu.Lock()
				m.flrigSyncToRig = oldSyncToRig
				m.mu.Unlock()
			}()
		},
		func(mode string) {
			// Run callback in goroutine to avoid blocking polling
			go func() {
				// Check sync setting with lock
				m.mu.RLock()
				syncFromRig := m.flrigSyncFromRig
				m.mu.RUnlock()

				if !syncFromRig {
					log.Printf("flrig mode changed to %s (sync disabled)", mode)
					return
				}

				// Check connection without holding lock for too long
				m.mu.RLock()
				connected := m.connected
				client := m.client
				m.mu.RUnlock()

				if !connected || client == nil {
					log.Printf("flrig mode changed to %s (not connected to SDR)", mode)
					return
				}

				// Convert mode to lowercase for SDR server
				modeLower := strings.ToLower(mode)
				log.Printf("flrig mode changed to %s (syncing to SDR as %s)", mode, modeLower)

				// Temporarily disable sync to rig to avoid feedback loop
				m.mu.Lock()
				oldSyncToRig := m.flrigSyncToRig
				m.flrigSyncToRig = false
				m.mu.Unlock()

				if err := m.SetMode(modeLower); err != nil {
					log.Printf("Failed to update SDR mode from flrig: %v", err)
				}

				// Restore sync setting
				m.mu.Lock()
				m.flrigSyncToRig = oldSyncToRig
				m.mu.Unlock()
			}()
		},
		func(ptt bool) {
			// PTT changed in flrig
			log.Printf("flrig PTT changed to %v", ptt)
			// PTT handling could be added here if needed
		},
		func(errMsg string) {
			// Error from flrig
			log.Printf("flrig error: %s", errMsg)
		},
	)

	// Connect to flrig
	if err := m.flrigClient.Connect(); err != nil {
		m.flrigClient = nil
		return fmt.Errorf("failed to connect to flrig: %w", err)
	}

	log.Printf("Connected to flrig at %s:%d (VFO %s, sync: SDR->rig=%v, rig->SDR=%v)",
		host, port, vfo, syncToRig, syncFromRig)

	// Start polling goroutine
	m.startFlrigPolling()

	return nil
}

// DisconnectFlrig disconnects from flrig server
func (m *WebSocketManager) DisconnectFlrig() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.flrigClient == nil {
		return fmt.Errorf("flrig not connected")
	}

	m.stopFlrigPolling()
	m.flrigClient.Disconnect()
	m.flrigClient = nil

	log.Printf("Disconnected from flrig")
	return nil
}

// IsFlrigConnected returns whether flrig is connected
func (m *WebSocketManager) IsFlrigConnected() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.flrigClient != nil && m.flrigClient.IsConnected()
}

// SetFlrigFrequency sets the frequency in flrig
func (m *WebSocketManager) SetFlrigFrequency(freq int) error {
	m.mu.RLock()
	client := m.flrigClient
	m.mu.RUnlock()

	if client == nil {
		return fmt.Errorf("flrig not connected")
	}

	return client.SetFrequency(freq)
}

// SetFlrigMode sets the mode in flrig
func (m *WebSocketManager) SetFlrigMode(mode string) error {
	m.mu.RLock()
	client := m.flrigClient
	m.mu.RUnlock()

	if client == nil {
		return fmt.Errorf("flrig not connected")
	}

	return client.SetMode(mode)
}

// SetFlrigVFO sets the VFO in flrig
func (m *WebSocketManager) SetFlrigVFO(vfo string) error {
	m.mu.RLock()
	client := m.flrigClient
	m.mu.RUnlock()

	if client == nil {
		return fmt.Errorf("flrig not connected")
	}

	return client.SetVFO(vfo)
}

// SetFlrigSync updates the flrig sync direction settings
func (m *WebSocketManager) SetFlrigSync(syncToRig bool, syncFromRig bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.flrigClient == nil {
		return fmt.Errorf("flrig not connected")
	}

	m.flrigSyncToRig = syncToRig
	m.flrigSyncFromRig = syncFromRig

	log.Printf("Updated flrig sync settings: SDR->rig=%v, rig->SDR=%v", syncToRig, syncFromRig)
	return nil
}

// GetFlrigStatus returns the current flrig status
func (m *WebSocketManager) GetFlrigStatus() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.flrigClient == nil {
		return map[string]interface{}{
			"connected": false,
		}
	}

	return map[string]interface{}{
		"connected": m.flrigClient.IsConnected(),
		"frequency": m.flrigClient.GetCachedFrequency(),
		"mode":      m.flrigClient.GetCachedMode(),
		"ptt":       m.flrigClient.GetCachedPTT(),
		"vfo":       m.flrigClient.GetVFO(),
	}
}

// startFlrigPolling starts the flrig polling goroutine
func (m *WebSocketManager) startFlrigPolling() {
	if m.flrigPolling {
		return
	}

	ctx, cancel := context.WithCancel(m.ctx)
	m.flrigPollCancel = cancel
	m.flrigPolling = true

	go func() {
		ticker := time.NewTicker(200 * time.Millisecond) // Poll every 200ms for faster response
		defer ticker.Stop()

		log.Printf("flrig polling goroutine started")
		pollCount := 0

		for {
			select {
			case <-ctx.Done():
				log.Printf("flrig polling goroutine stopped (context done)")
				return
			case <-ticker.C:
				pollCount++
				m.mu.RLock()
				client := m.flrigClient
				m.mu.RUnlock()

				if client == nil {
					if pollCount%20 == 0 {
						log.Printf("flrig polling: client is nil (poll #%d)", pollCount)
					}
					continue
				}

				connected := client.IsConnected()
				if !connected {
					if pollCount%20 == 0 {
						log.Printf("flrig polling: client not connected (poll #%d)", pollCount)
					}
					continue
				}

				client.Poll()
			}
		}
	}()

	log.Printf("Started flrig polling")
}

// stopFlrigPolling stops the flrig polling goroutine
func (m *WebSocketManager) stopFlrigPolling() {
	if !m.flrigPolling {
		return
	}

	if m.flrigPollCancel != nil {
		m.flrigPollCancel()
		m.flrigPollCancel = nil
	}

	m.flrigPolling = false
	log.Printf("Stopped flrig polling")
}

// Radio Control Methods (rigctl)

// ConnectRigctl connects to rigctld server
func (m *WebSocketManager) ConnectRigctl(host string, port int, vfo string, syncToRig bool, syncFromRig bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Disconnect existing rigctl client if any
	if m.rigctlClient != nil {
		m.stopRigctlPolling()
		m.rigctlClient.Disconnect()
		m.rigctlClient = nil
	}

	// Store sync direction settings
	m.rigctlSyncToRig = syncToRig
	m.rigctlSyncFromRig = syncFromRig

	// Create new rigctl client
	m.rigctlClient = NewRigctlClient(host, port, vfo)

	// Set up callbacks
	m.rigctlClient.SetCallbacks(
		func(freq int) {
			// Run callback in goroutine to avoid blocking polling
			go func() {
				// Check sync setting with lock
				m.mu.RLock()
				syncFromRig := m.rigctlSyncFromRig
				m.mu.RUnlock()

				if !syncFromRig {
					log.Printf("rigctl frequency changed to %d Hz (sync disabled)", freq)
					return
				}

				// Check connection without holding lock for too long
				m.mu.RLock()
				connected := m.connected
				client := m.client
				m.mu.RUnlock()

				if !connected || client == nil {
					log.Printf("rigctl frequency changed to %d Hz (not connected to SDR)", freq)
					return
				}

				log.Printf("rigctl frequency changed to %d Hz (syncing to SDR)", freq)

				// Temporarily disable sync to rig to avoid feedback loop
				m.mu.Lock()
				oldSyncToRig := m.rigctlSyncToRig
				m.rigctlSyncToRig = false
				m.mu.Unlock()

				if err := m.SetFrequency(freq); err != nil {
					log.Printf("Failed to update SDR frequency from rigctl: %v", err)
				}

				// Restore sync setting
				m.mu.Lock()
				m.rigctlSyncToRig = oldSyncToRig
				m.mu.Unlock()
			}()
		},
		func(mode string) {
			// Run callback in goroutine to avoid blocking polling
			go func() {
				// Check sync setting with lock
				m.mu.RLock()
				syncFromRig := m.rigctlSyncFromRig
				m.mu.RUnlock()

				if !syncFromRig {
					log.Printf("rigctl mode changed to %s (sync disabled)", mode)
					return
				}

				// Check connection without holding lock for too long
				m.mu.RLock()
				connected := m.connected
				client := m.client
				m.mu.RUnlock()

				if !connected || client == nil {
					log.Printf("rigctl mode changed to %s (not connected to SDR)", mode)
					return
				}

				// Convert mode to lowercase for SDR server
				modeLower := strings.ToLower(mode)
				log.Printf("rigctl mode changed to %s (syncing to SDR as %s)", mode, modeLower)

				// Temporarily disable sync to rig to avoid feedback loop
				m.mu.Lock()
				oldSyncToRig := m.rigctlSyncToRig
				m.rigctlSyncToRig = false
				m.mu.Unlock()

				if err := m.SetMode(modeLower); err != nil {
					log.Printf("Failed to update SDR mode from rigctl: %v", err)
				}

				// Restore sync setting
				m.mu.Lock()
				m.rigctlSyncToRig = oldSyncToRig
				m.mu.Unlock()
			}()
		},
		func(ptt bool) {
			// PTT changed in rigctl
			log.Printf("rigctl PTT changed to %v", ptt)
			// PTT handling could be added here if needed
		},
		func(errMsg string) {
			// Error from rigctl
			log.Printf("rigctl error: %s", errMsg)
		},
	)

	// Connect to rigctl
	if err := m.rigctlClient.Connect(); err != nil {
		m.rigctlClient = nil
		return fmt.Errorf("failed to connect to rigctl: %w", err)
	}

	log.Printf("Connected to rigctld at %s:%d (VFO %s, sync: SDR->rig=%v, rig->SDR=%v)",
		host, port, vfo, syncToRig, syncFromRig)

	// Start polling goroutine
	m.startRigctlPolling()

	return nil
}

// DisconnectRigctl disconnects from rigctld server
func (m *WebSocketManager) DisconnectRigctl() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.rigctlClient == nil {
		return fmt.Errorf("rigctl not connected")
	}

	m.stopRigctlPolling()
	m.rigctlClient.Disconnect()
	m.rigctlClient = nil

	log.Printf("Disconnected from rigctld")
	return nil
}

// IsRigctlConnected returns whether rigctl is connected
func (m *WebSocketManager) IsRigctlConnected() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.rigctlClient != nil && m.rigctlClient.IsConnected()
}

// SetRigctlFrequency sets the frequency in rigctl
func (m *WebSocketManager) SetRigctlFrequency(freq int) error {
	m.mu.RLock()
	client := m.rigctlClient
	m.mu.RUnlock()

	if client == nil {
		return fmt.Errorf("rigctl not connected")
	}

	return client.SetFrequency(freq)
}

// SetRigctlMode sets the mode in rigctl
func (m *WebSocketManager) SetRigctlMode(mode string) error {
	m.mu.RLock()
	client := m.rigctlClient
	m.mu.RUnlock()

	if client == nil {
		return fmt.Errorf("rigctl not connected")
	}

	return client.SetMode(mode)
}

// SetRigctlVFO sets the VFO in rigctl
func (m *WebSocketManager) SetRigctlVFO(vfo string) error {
	m.mu.RLock()
	client := m.rigctlClient
	m.mu.RUnlock()

	if client == nil {
		return fmt.Errorf("rigctl not connected")
	}

	return client.SetVFO(vfo)
}

// SetRigctlSync updates the rigctl sync direction settings
func (m *WebSocketManager) SetRigctlSync(syncToRig bool, syncFromRig bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.rigctlClient == nil {
		return fmt.Errorf("rigctl not connected")
	}

	m.rigctlSyncToRig = syncToRig
	m.rigctlSyncFromRig = syncFromRig

	log.Printf("Updated rigctl sync settings: SDR->rig=%v, rig->SDR=%v", syncToRig, syncFromRig)
	return nil
}

// GetRigctlStatus returns the current rigctl status
func (m *WebSocketManager) GetRigctlStatus() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.rigctlClient == nil {
		return map[string]interface{}{
			"connected": false,
		}
	}

	return map[string]interface{}{
		"connected": m.rigctlClient.IsConnected(),
		"frequency": m.rigctlClient.GetCachedFrequency(),
		"mode":      m.rigctlClient.GetCachedMode(),
		"ptt":       m.rigctlClient.GetCachedPTT(),
		"vfo":       m.rigctlClient.GetVFO(),
	}
}

// startRigctlPolling starts the rigctl polling goroutine
func (m *WebSocketManager) startRigctlPolling() {
	if m.rigctlPolling {
		return
	}

	ctx, cancel := context.WithCancel(m.ctx)
	m.rigctlPollCancel = cancel
	m.rigctlPolling = true

	go func() {
		ticker := time.NewTicker(200 * time.Millisecond) // Poll every 200ms for faster response
		defer ticker.Stop()

		log.Printf("rigctl polling goroutine started")
		pollCount := 0

		for {
			select {
			case <-ctx.Done():
				log.Printf("rigctl polling goroutine stopped (context done)")
				return
			case <-ticker.C:
				pollCount++
				m.mu.RLock()
				client := m.rigctlClient
				m.mu.RUnlock()

				if client == nil {
					if pollCount%20 == 0 {
						log.Printf("rigctl polling: client is nil (poll #%d)", pollCount)
					}
					continue
				}

				connected := client.IsConnected()
				if !connected {
					if pollCount%20 == 0 {
						log.Printf("rigctl polling: client not connected (poll #%d)", pollCount)
					}
					continue
				}

				client.Poll()
			}
		}
	}()

	log.Printf("Started rigctl polling")
}

// stopRigctlPolling stops the rigctl polling goroutine
func (m *WebSocketManager) stopRigctlPolling() {
	if !m.rigctlPolling {
		return
	}

	if m.rigctlPollCancel != nil {
		m.rigctlPollCancel()
		m.rigctlPollCancel = nil
	}

	m.rigctlPolling = false
	log.Printf("Stopped rigctl polling")
}

// Radio Control Methods (serial CAT server)

// StartSerialServer starts the serial CAT server
func (m *WebSocketManager) StartSerialServer(port string, baudrate int, vfo string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Stop existing serial server if any
	if m.serialServer != nil {
		m.serialServer.Stop()
		m.serialServer = nil
	}

	// Create new serial CAT server
	m.serialServer = NewSerialCATServer(port, baudrate, vfo)

	// Set initial frequency from client if available
	if m.client != nil {
		m.serialServer.UpdateFrequency(m.client.frequency)
		m.serialServer.UpdateMode(m.client.mode)
	}

	// Set up callbacks for when external software changes frequency/mode
	m.serialServer.SetCallbacks(
		func(freq int) {
			// Frequency changed by external software via CAT
			go func() {
				log.Printf("Serial CAT: External software set frequency to %d Hz", freq)

				// Check connection
				m.mu.RLock()
				connected := m.connected
				m.mu.RUnlock()

				if !connected {
					log.Printf("Serial CAT: Not connected to SDR, ignoring frequency change")
					return
				}

				// Update SDR frequency
				if err := m.SetFrequency(freq); err != nil {
					log.Printf("Serial CAT: Failed to update SDR frequency: %v", err)
				}
			}()
		},
		func(mode string) {
			// Mode changed by external software via CAT
			go func() {
				log.Printf("Serial CAT: External software set mode to %s", mode)

				// Check connection
				m.mu.RLock()
				connected := m.connected
				m.mu.RUnlock()

				if !connected {
					log.Printf("Serial CAT: Not connected to SDR, ignoring mode change")
					return
				}

				// Convert mode to lowercase for SDR
				modeLower := strings.ToLower(mode)

				// Update SDR mode
				if err := m.SetMode(modeLower); err != nil {
					log.Printf("Serial CAT: Failed to update SDR mode: %v", err)
				}
			}()
		},
	)

	// Start the server
	if err := m.serialServer.Start(); err != nil {
		m.serialServer = nil
		return fmt.Errorf("failed to start serial CAT server: %w", err)
	}

	log.Printf("Started serial CAT server on %s at %d baud (VFO %s)", port, baudrate, vfo)
	return nil
}

// StopSerialServer stops the serial CAT server
func (m *WebSocketManager) StopSerialServer() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.serialServer == nil {
		return fmt.Errorf("serial CAT server not running")
	}

	m.serialServer.Stop()
	m.serialServer = nil

	log.Printf("Stopped serial CAT server")
	return nil
}

// IsSerialServerRunning returns whether the serial CAT server is running
func (m *WebSocketManager) IsSerialServerRunning() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.serialServer != nil && m.serialServer.IsRunning()
}

// GetSerialServerStatus returns the current serial CAT server status
func (m *WebSocketManager) GetSerialServerStatus() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.serialServer == nil {
		return map[string]interface{}{
			"running": false,
		}
	}

	return map[string]interface{}{
		"running":   m.serialServer.IsRunning(),
		"port":      m.serialServer.GetPort(),
		"baudrate":  m.serialServer.GetBaudrate(),
		"vfo":       m.serialServer.GetVFO(),
		"frequency": m.serialServer.GetCachedFrequency(),
		"mode":      m.serialServer.GetCachedMode(),
	}
}

// GetBookmarks fetches bookmarks from the connected SDR server
func (m *WebSocketManager) GetBookmarks() ([]map[string]interface{}, error) {
	m.mu.RLock()
	if !m.connected || m.client == nil {
		m.mu.RUnlock()
		return nil, fmt.Errorf("not connected to SDR server")
	}

	// Build the API URL
	protocol := "http"
	if m.client.ssl {
		protocol = "https"
	}
	apiURL := fmt.Sprintf("%s://%s:%d/api/bookmarks", protocol, m.client.host, m.client.port)
	m.mu.RUnlock()

	// Make HTTP request to fetch bookmarks
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch bookmarks: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to fetch bookmarks: status %d, body: %s", resp.StatusCode, string(body))
	}

	// Parse JSON response
	var bookmarks []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&bookmarks); err != nil {
		return nil, fmt.Errorf("failed to parse bookmarks: %w", err)
	}

	log.Printf("Fetched %d bookmarks from SDR server", len(bookmarks))
	return bookmarks, nil
}

// GetBands fetches bands from the connected SDR server
func (m *WebSocketManager) GetBands() ([]map[string]interface{}, error) {
	m.mu.RLock()
	if !m.connected || m.client == nil {
		m.mu.RUnlock()
		return nil, fmt.Errorf("not connected to SDR server")
	}

	// Build the API URL
	protocol := "http"
	if m.client.ssl {
		protocol = "https"
	}
	apiURL := fmt.Sprintf("%s://%s:%d/api/bands", protocol, m.client.host, m.client.port)
	m.mu.RUnlock()

	// Make HTTP request to fetch bands
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch bands: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to fetch bands: status %d, body: %s", resp.StatusCode, string(body))
	}

	// Parse JSON response
	var bands []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&bands); err != nil {
		return nil, fmt.Errorf("failed to parse bands: %w", err)
	}

	log.Printf("Fetched %d bands from SDR server", len(bands))
	return bands, nil
}
