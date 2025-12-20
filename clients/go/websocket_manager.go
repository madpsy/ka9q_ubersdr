package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocketManager manages the WebSocket connection with thread-safe operations
type WebSocketManager struct {
	client              *RadioClient
	conn                *websocket.Conn // WebSocket connection for sending tune messages
	connMu              sync.Mutex      // Protects WebSocket writes
	mu                  sync.RWMutex
	connected           bool
	connectedAt         time.Time
	bypassed            bool                   // Whether the connection is bypassed (from /connection response)
	allowedIQModes      []string               // Allowed IQ modes (from /connection response)
	maxSessionTime      int                    // Maximum session time in seconds (0 = unlimited)
	sessionStartTime    time.Time              // When the session started (for calculating remaining time)
	instanceDescription map[string]interface{} // Description of the connected instance
	ctx                 context.Context
	cancel              context.CancelFunc
	statusBroadcast     chan WSStatusUpdate
	errorBroadcast      chan WSErrorUpdate
	connBroadcast       chan WSConnectionUpdate
	subscribers         map[chan interface{}]bool
	subMu               sync.RWMutex
	audioStreams        map[*websocket.Conn]string // Maps WebSocket connections to their audio room names
	audioStreamsMu      sync.RWMutex
	audioWriteChans     map[*websocket.Conn]chan interface{} // Per-connection write channels for audio
	spectrumClient      *SpectrumClient                      // Spectrum WebSocket client
	spectrumStreams     map[*websocket.Conn]string           // Maps WebSocket connections to their spectrum room names
	spectrumStreamsMu   sync.RWMutex
	spectrumWriteChans  map[*websocket.Conn]chan interface{} // Per-connection write channels for spectrum
	flrigClient         *FlrigClient                         // flrig radio control client
	flrigPolling        bool                                 // Whether flrig polling is active
	flrigPollCancel     context.CancelFunc                   // Cancel function for flrig polling
	flrigSyncToRig      bool                                 // Sync SDR frequency changes to rig
	flrigSyncFromRig    bool                                 // Sync rig frequency changes to SDR
	rigctlClient        *RigctlClient                        // rigctl radio control client
	rigctlPolling       bool                                 // Whether rigctl polling is active
	rigctlPollCancel    context.CancelFunc                   // Cancel function for rigctl polling
	rigctlSyncToRig     bool                                 // Sync SDR frequency changes to rig
	rigctlSyncFromRig   bool                                 // Sync rig frequency changes to SDR
	serialServer        *SerialCATServer                     // serial CAT server
	configManager       *ConfigManager                       // Configuration manager
	midiController      *MIDIController                      // MIDI controller
	midiPolling         bool                                 // Whether MIDI polling is active
	midiPollCancel      context.CancelFunc                   // Cancel function for MIDI polling

	// Noise floor caching
	cachedNoiseFloor     map[string]interface{} // Cached noise floor data
	noiseFloorMu         sync.RWMutex           // Protects noise floor cache
	noiseFloorPolling    bool                   // Whether noise floor polling is active
	noiseFloorPollCancel context.CancelFunc     // Cancel function for noise floor polling

	// Auto-reconnect state
	autoReconnect          bool
	reconnecting           bool
	reconnectAttempts      int
	maxReconnectDelay      time.Duration
	reconnectCancel        context.CancelFunc
	savedClientConfig      *RadioClient        // Saved client config for reconnection
	savedOutputStates      *OutputStates       // Saved output states for restoration
	savedRadioControlState *RadioControlStates // Saved radio control states for restoration
}

// OutputStates stores the state of all outputs for restoration after reconnect
type OutputStates struct {
	PortAudioEnabled bool
	PortAudioDevice  int
	FIFOEnabled      bool
	FIFOPath         string
	UDPEnabled       bool
	UDPHost          string
	UDPPort          int
}

// RadioControlStates stores the state of radio control connections
type RadioControlStates struct {
	FlrigConnected    bool
	FlrigHost         string
	FlrigPort         int
	FlrigVFO          string
	FlrigSyncToRig    bool
	FlrigSyncFromRig  bool
	RigctlConnected   bool
	RigctlHost        string
	RigctlPort        int
	RigctlVFO         string
	RigctlSyncToRig   bool
	RigctlSyncFromRig bool
	SerialRunning     bool
	SerialPort        string
	SerialBaudrate    int
	SerialVFO         string
	TCIRunning        bool
	TCIPort           int
}

// NewWebSocketManager creates a new WebSocket manager
func NewWebSocketManager() *WebSocketManager {
	ctx, cancel := context.WithCancel(context.Background())
	wm := &WebSocketManager{
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
		autoReconnect:      true,             // Enable auto-reconnect by default
		maxReconnectDelay:  60 * time.Second, // Max 60 seconds between reconnect attempts
	}
	return wm
}

// Connect establishes a connection to the SDR server
func (m *WebSocketManager) Connect(client *RadioClient) error {
	log.Printf("DEBUG Connect: Attempting to acquire lock...")
	m.mu.Lock()
	log.Printf("DEBUG Connect: Lock acquired")

	if m.connected {
		log.Printf("DEBUG Connect: Already connected, releasing lock and returning error")
		m.mu.Unlock()
		return fmt.Errorf("already connected")
	}

	// Save client config for potential reconnection
	m.savedClientConfig = client

	// Capture current output states and radio control states before connection
	if m.client != nil {
		m.savedOutputStates = m.captureOutputStates()
		m.savedRadioControlState = m.captureRadioControlStates()
	}

	m.mu.Unlock()

	// Check connection permission and get allowed IQ modes
	allowed, err := client.CheckConnectionAllowed()
	if err != nil {
		log.Printf("Connection check error: %v", err)
	}
	if !allowed {
		return fmt.Errorf("connection not allowed")
	}

	m.mu.Lock()
	// Store connection data from client
	m.bypassed = client.bypassed
	m.allowedIQModes = client.allowedIQModes
	m.maxSessionTime = client.maxSessionTime
	m.sessionStartTime = time.Now()

	// Fetch instance description from the server
	m.fetchInstanceDescription(client)

	m.client = client
	m.connected = true
	m.connectedAt = time.Now()
	m.reconnectAttempts = 0 // Reset reconnect counter on successful connection
	m.mu.Unlock()

	// Set callback to capture WebSocket connection when established
	client.connCallback = func(conn *websocket.Conn) {
		m.mu.Lock()
		m.conn = conn
		m.mu.Unlock()
		log.Printf("WebSocket connection captured for tune messages")
	}

	// Start noise floor polling
	m.startNoiseFloorPolling()

	// Start the client in a goroutine
	go func() {
		client.runOnce()

		// Mark as disconnected when client stops
		m.mu.Lock()
		wasConnected := m.connected
		m.connected = false
		m.conn = nil
		m.bypassed = false
		m.allowedIQModes = nil
		savedMaxSessionTime := m.maxSessionTime
		savedSessionStartTime := m.sessionStartTime
		m.maxSessionTime = 0
		m.sessionStartTime = time.Time{}
		m.instanceDescription = nil

		// Only stop TCI server if it wasn't auto-started
		// If TCIAutoStart is enabled, keep the server running to wait for new TCI clients
		if m.client != nil && m.client.tciServer != nil {
			// Check if TCI auto-start is enabled
			tciAutoStart := false
			if m.configManager != nil {
				config := m.configManager.Get()
				tciAutoStart = config.TCIAutoStart
			}

			if !tciAutoStart {
				// TCI was manually started, stop it when instance disconnects
				log.Printf("Instance disconnected, stopping manually-started TCI server")
				m.client.tciServer.Stop()
				m.client.tciServer = nil
			} else {
				// TCI was auto-started, keep it running for next client
				log.Printf("Instance disconnected, keeping auto-started TCI server running")
			}
		}

		// Check if disconnection was likely due to max session time being reached
		sessionTimeExpired := false
		if savedMaxSessionTime > 0 && !savedSessionStartTime.IsZero() {
			sessionDuration := time.Since(savedSessionStartTime).Seconds()
			// Consider session expired if we're within 10 seconds of the limit
			// This accounts for network delays and timing variations
			if sessionDuration >= float64(savedMaxSessionTime)-10 {
				sessionTimeExpired = true
				log.Printf("Session time limit reached (%.0fs of %ds), will not auto-reconnect",
					sessionDuration, savedMaxSessionTime)
			}
		}

		shouldReconnect := m.autoReconnect && wasConnected && !m.reconnecting && !sessionTimeExpired
		m.mu.Unlock()

		// Broadcast disconnection
		if sessionTimeExpired {
			m.BroadcastConnection(false, "Session time limit reached")
		} else {
			m.BroadcastConnection(false, "Connection closed")
		}

		// Attempt auto-reconnect if enabled and not already reconnecting
		if shouldReconnect {
			log.Printf("Connection lost, attempting auto-reconnect...")
			m.startReconnect()
		}
	}()

	// Give the client a moment to establish connection
	time.Sleep(200 * time.Millisecond)

	// Broadcast connection
	m.BroadcastConnection(true, "Connected successfully")

	return nil
}

// Disconnect closes the connection to the SDR server
func (m *WebSocketManager) Disconnect() error {
	log.Printf("DEBUG Disconnect: Called, attempting to acquire lock...")
	m.mu.Lock()
	log.Printf("DEBUG Disconnect: Lock acquired")

	if !m.connected {
		log.Printf("DEBUG Disconnect: Not connected, releasing lock and returning error")
		m.mu.Unlock()
		return fmt.Errorf("not connected")
	}

	// Cancel any ongoing reconnect attempts
	if m.reconnectCancel != nil {
		m.reconnectCancel()
		m.reconnectCancel = nil
	}
	m.reconnecting = false
	m.autoReconnect = false // Disable auto-reconnect on manual disconnect

	// Get client reference before unlocking
	client := m.client
	log.Printf("DEBUG: client is nil: %v", client == nil)

	if client != nil {
		log.Printf("DEBUG: Setting client.running = false")
		client.running = false
	}

	// Close the audio WebSocket connection to force immediate disconnect
	if m.conn != nil {
		log.Printf("DEBUG: Closing m.conn (audio) WebSocket connection")
		m.conn.Close()
		m.conn = nil
	} else {
		log.Printf("DEBUG: m.conn is nil, cannot close")
	}

	// Close the spectrum WebSocket connection if it exists
	if m.spectrumClient != nil {
		log.Printf("DEBUG: Disconnecting spectrum client")
		m.spectrumClient.Disconnect()
		m.spectrumClient = nil
	} else {
		log.Printf("DEBUG: spectrumClient is nil, no spectrum connection to close")
	}

	// Stop noise floor polling
	log.Printf("DEBUG Disconnect: Stopping noise floor polling")
	m.stopNoiseFloorPolling()

	m.connected = false
	log.Printf("DEBUG Disconnect: Set m.connected = false, about to unlock mutex")

	// Get client reference before unlocking
	clientToCleanup := client

	m.mu.Unlock()
	log.Printf("DEBUG Disconnect: Mutex unlocked")

	// Call client's Cleanup() method to clean up resources (PortAudio, FIFO, etc.)
	// Note: The WebSocket connections are already closed above
	// This MUST be done outside the lock to avoid deadlock, as PortAudio operations can block
	if clientToCleanup != nil {
		log.Printf("DEBUG Disconnect: Calling client.Cleanup() to clean up PortAudio/FIFO/UDP resources")
		clientToCleanup.Cleanup()
		log.Printf("DEBUG Disconnect: client.Cleanup() completed")
	} else {
		log.Printf("DEBUG Disconnect: client is nil, skipping Cleanup()")
	}

	// Broadcast disconnection
	log.Printf("DEBUG Disconnect: Broadcasting disconnection")
	m.BroadcastConnection(false, "Disconnected by user")

	log.Printf("DEBUG Disconnect: Completed successfully")
	return nil
}

// captureOutputStates captures the current state of all outputs
func (m *WebSocketManager) captureOutputStates() *OutputStates {
	if m.client == nil {
		return nil
	}

	status := m.client.GetOutputStatus()
	states := &OutputStates{}

	if pa, ok := status["portaudio"].(map[string]interface{}); ok {
		if enabled, ok := pa["enabled"].(bool); ok {
			states.PortAudioEnabled = enabled
		}
		if deviceIdx, ok := pa["deviceIndex"].(int); ok {
			states.PortAudioDevice = deviceIdx
		}
	}

	if fifo, ok := status["fifo"].(map[string]interface{}); ok {
		if enabled, ok := fifo["enabled"].(bool); ok {
			states.FIFOEnabled = enabled
		}
		if path, ok := fifo["path"].(string); ok {
			states.FIFOPath = path
		}
	}

	if udp, ok := status["udp"].(map[string]interface{}); ok {
		if enabled, ok := udp["enabled"].(bool); ok {
			states.UDPEnabled = enabled
		}
		if host, ok := udp["host"].(string); ok {
			states.UDPHost = host
		}
		if port, ok := udp["port"].(int); ok {
			states.UDPPort = port
		}
	}

	return states
}

// captureRadioControlStates captures the current state of all radio control connections
func (m *WebSocketManager) captureRadioControlStates() *RadioControlStates {
	states := &RadioControlStates{}

	// Capture flrig state
	if m.flrigClient != nil && m.flrigClient.IsConnected() {
		states.FlrigConnected = true
		states.FlrigHost = m.flrigClient.host
		states.FlrigPort = m.flrigClient.port
		states.FlrigVFO = m.flrigClient.vfo
		states.FlrigSyncToRig = m.flrigSyncToRig
		states.FlrigSyncFromRig = m.flrigSyncFromRig
	}

	// Capture rigctl state
	if m.rigctlClient != nil && m.rigctlClient.IsConnected() {
		states.RigctlConnected = true
		states.RigctlHost = m.rigctlClient.host
		states.RigctlPort = m.rigctlClient.port
		states.RigctlVFO = m.rigctlClient.vfo
		states.RigctlSyncToRig = m.rigctlSyncToRig
		states.RigctlSyncFromRig = m.rigctlSyncFromRig
	}

	// Capture serial CAT state
	if m.serialServer != nil && m.serialServer.IsRunning() {
		states.SerialRunning = true
		states.SerialPort = m.serialServer.GetPort()
		states.SerialBaudrate = m.serialServer.GetBaudrate()
		states.SerialVFO = m.serialServer.GetVFO()
	}

	// Capture TCI server state
	if m.client != nil && m.client.tciServer != nil && m.client.tciServer.IsRunning() {
		states.TCIRunning = true
		// Get TCI port from server status
		status := m.client.tciServer.GetStatus()
		if port, ok := status["port"].(int); ok {
			states.TCIPort = port
		}
	}

	return states
}

// startReconnect initiates the auto-reconnect process
func (m *WebSocketManager) startReconnect() {
	m.mu.Lock()

	if m.reconnecting {
		m.mu.Unlock()
		return // Already reconnecting
	}

	if m.savedClientConfig == nil {
		m.mu.Unlock()
		log.Printf("Cannot reconnect: no saved client configuration")
		return
	}

	m.reconnecting = true
	m.reconnectAttempts++

	// Create cancellable context for reconnect attempts
	ctx, cancel := context.WithCancel(m.ctx)
	m.reconnectCancel = cancel

	savedConfig := m.savedClientConfig
	m.mu.Unlock()

	go m.reconnectLoop(ctx, savedConfig)
}

// reconnectLoop handles the reconnection attempts with exponential backoff
func (m *WebSocketManager) reconnectLoop(ctx context.Context, savedConfig *RadioClient) {
	for {
		m.mu.RLock()
		attempts := m.reconnectAttempts
		maxDelay := m.maxReconnectDelay
		m.mu.RUnlock()

		// Calculate exponential backoff: 2^attempts seconds, capped at maxDelay
		backoff := time.Duration(1<<uint(attempts-1)) * time.Second
		if backoff > maxDelay {
			backoff = maxDelay
		}

		log.Printf("Reconnect attempt %d in %v...", attempts, backoff)

		// Wait with ability to cancel
		select {
		case <-ctx.Done():
			log.Printf("Reconnect cancelled")
			m.mu.Lock()
			m.reconnecting = false
			m.mu.Unlock()
			return
		case <-time.After(backoff):
			// Continue to reconnect attempt
		}

		// Create new client with same configuration
		newClient := NewRadioClient(
			savedConfig.url,
			savedConfig.host,
			savedConfig.port,
			savedConfig.frequency,
			savedConfig.mode,
			savedConfig.bandwidthLow,
			savedConfig.bandwidthHigh,
			savedConfig.outputMode,
			savedConfig.wavFile,
			savedConfig.duration,
			savedConfig.ssl,
			savedConfig.password,
			savedConfig.audioDeviceIndex,
			savedConfig.nr2Enabled,
			savedConfig.nr2Strength,
			savedConfig.nr2Floor,
			savedConfig.nr2AdaptRate,
			false, // Don't use RadioClient's auto-reconnect, we handle it here
			savedConfig.resampleEnabled,
			savedConfig.resampleOutputRate,
			savedConfig.outputChannels,
			savedConfig.fifoPath,
			savedConfig.udpHost,
			savedConfig.udpPort,
			savedConfig.udpEnabled,
		)

		// Temporarily disable auto-reconnect to avoid recursive reconnection
		m.mu.Lock()
		oldAutoReconnect := m.autoReconnect
		m.autoReconnect = false
		m.mu.Unlock()

		// Attempt connection
		err := m.Connect(newClient)

		// Restore auto-reconnect setting
		m.mu.Lock()
		m.autoReconnect = oldAutoReconnect
		m.reconnecting = false
		m.mu.Unlock()

		if err == nil {
			log.Printf("Reconnection successful after %d attempts", attempts)

			// Restore output states after successful reconnection
			go m.restoreOutputStates()

			return
		}

		log.Printf("Reconnection attempt %d failed: %v", attempts, err)

		m.mu.Lock()
		m.reconnectAttempts++
		m.reconnecting = true // Set back to true for next attempt
		m.mu.Unlock()
	}
}

// restoreOutputStates restores the output states after reconnection
func (m *WebSocketManager) restoreOutputStates() {
	// Wait for connection to stabilize
	time.Sleep(2 * time.Second)

	m.mu.RLock()
	if !m.connected {
		m.mu.RUnlock()
		log.Printf("Connection lost before output restoration")
		return
	}

	savedStates := m.savedOutputStates
	m.mu.RUnlock()

	if savedStates == nil {
		log.Printf("No saved output states to restore")
		return
	}

	log.Printf("Restoring output states after reconnection...")

	// Restore PortAudio
	if savedStates.PortAudioEnabled {
		log.Printf("Restoring PortAudio output (device %d)...", savedStates.PortAudioDevice)
		if err := m.EnablePortAudioOutput(savedStates.PortAudioDevice); err != nil {
			log.Printf("Warning: Failed to restore PortAudio: %v", err)
		} else {
			log.Printf("PortAudio output restored")
		}
	}

	// Restore FIFO
	if savedStates.FIFOEnabled && savedStates.FIFOPath != "" {
		log.Printf("Restoring FIFO output (%s)...", savedStates.FIFOPath)
		if err := m.EnableFIFOOutput(savedStates.FIFOPath); err != nil {
			log.Printf("Warning: Failed to restore FIFO: %v", err)
		} else {
			log.Printf("FIFO output restored")
		}
	}

	// Restore UDP
	if savedStates.UDPEnabled {
		log.Printf("Restoring UDP output (%s:%d)...", savedStates.UDPHost, savedStates.UDPPort)
		if err := m.EnableUDPOutput(savedStates.UDPHost, savedStates.UDPPort); err != nil {
			log.Printf("Warning: Failed to restore UDP: %v", err)
		} else {
			log.Printf("UDP output restored")
		}
	}

	log.Printf("Output state restoration complete")

	// Also restore radio control connections
	m.restoreRadioControlStates()
}

// restoreRadioControlStates restores radio control connections and syncs frequency/mode
func (m *WebSocketManager) restoreRadioControlStates() {
	m.mu.RLock()
	savedStates := m.savedRadioControlState
	currentFreq := 0
	currentMode := ""
	if m.client != nil {
		currentFreq = m.client.frequency
		currentMode = m.client.mode
	}
	m.mu.RUnlock()

	if savedStates == nil {
		log.Printf("No saved radio control states to restore")
		return
	}

	log.Printf("Restoring radio control connections after reconnection...")

	// Restore flrig connection
	if savedStates.FlrigConnected {
		log.Printf("Restoring flrig connection (%s:%d)...", savedStates.FlrigHost, savedStates.FlrigPort)

		m.mu.RLock()
		alreadyConnected := m.flrigClient != nil && m.flrigClient.IsConnected()
		m.mu.RUnlock()

		if !alreadyConnected {
			// Reconnect to flrig
			if err := m.ConnectFlrig(savedStates.FlrigHost, savedStates.FlrigPort, savedStates.FlrigVFO,
				savedStates.FlrigSyncToRig, savedStates.FlrigSyncFromRig); err != nil {
				log.Printf("Warning: Failed to restore flrig connection: %v", err)
			} else {
				log.Printf("flrig connection restored")
			}
		} else {
			log.Printf("flrig already connected, syncing frequency/mode...")
		}

		// Sync current frequency and mode to flrig if sync is enabled
		if savedStates.FlrigSyncToRig && currentFreq > 0 {
			m.mu.RLock()
			client := m.flrigClient
			m.mu.RUnlock()

			if client != nil && client.IsConnected() {
				if err := client.SetFrequency(currentFreq); err != nil {
					log.Printf("Warning: Failed to sync frequency to flrig: %v", err)
				} else {
					log.Printf("Synced frequency %d Hz to flrig", currentFreq)
				}
				if currentMode != "" {
					if err := client.SetMode(currentMode); err != nil {
						log.Printf("Warning: Failed to sync mode to flrig: %v", err)
					} else {
						log.Printf("Synced mode %s to flrig", currentMode)
					}
				}
			}
		}
	}

	// Restore rigctl connection
	if savedStates.RigctlConnected {
		log.Printf("Restoring rigctl connection (%s:%d)...", savedStates.RigctlHost, savedStates.RigctlPort)

		m.mu.RLock()
		alreadyConnected := m.rigctlClient != nil && m.rigctlClient.IsConnected()
		m.mu.RUnlock()

		if !alreadyConnected {
			// Reconnect to rigctl
			if err := m.ConnectRigctl(savedStates.RigctlHost, savedStates.RigctlPort, savedStates.RigctlVFO,
				savedStates.RigctlSyncToRig, savedStates.RigctlSyncFromRig); err != nil {
				log.Printf("Warning: Failed to restore rigctl connection: %v", err)
			} else {
				log.Printf("rigctl connection restored")
			}
		} else {
			log.Printf("rigctl already connected, syncing frequency/mode...")
		}

		// Sync current frequency and mode to rigctl if sync is enabled
		if savedStates.RigctlSyncToRig && currentFreq > 0 {
			m.mu.RLock()
			client := m.rigctlClient
			m.mu.RUnlock()

			if client != nil && client.IsConnected() {
				if err := client.SetFrequency(currentFreq); err != nil {
					log.Printf("Warning: Failed to sync frequency to rigctl: %v", err)
				} else {
					log.Printf("Synced frequency %d Hz to rigctl", currentFreq)
				}
				if currentMode != "" {
					if err := client.SetMode(currentMode); err != nil {
						log.Printf("Warning: Failed to sync mode to rigctl: %v", err)
					} else {
						log.Printf("Synced mode %s to rigctl", currentMode)
					}
				}
			}
		}
	}

	// Restore serial CAT server
	if savedStates.SerialRunning {
		log.Printf("Restoring serial CAT server (%s at %d baud)...", savedStates.SerialPort, savedStates.SerialBaudrate)

		m.mu.RLock()
		alreadyRunning := m.serialServer != nil && m.serialServer.IsRunning()
		m.mu.RUnlock()

		if !alreadyRunning {
			// Restart serial CAT server
			if err := m.StartSerialServer(savedStates.SerialPort, savedStates.SerialBaudrate, savedStates.SerialVFO); err != nil {
				log.Printf("Warning: Failed to restore serial CAT server: %v", err)
			} else {
				log.Printf("Serial CAT server restored")
			}
		} else {
			log.Printf("Serial CAT server already running")
		}

		// Update serial server and TCI server with current frequency/mode
		if currentFreq > 0 {
			m.mu.RLock()
			server := m.serialServer
			var tciServer *TCIServer
			if m.client != nil {
				tciServer = m.client.tciServer
			}
			m.mu.RUnlock()

			if server != nil && server.IsRunning() {
				server.UpdateFrequency(currentFreq)
				if currentMode != "" {
					server.UpdateMode(currentMode)
				}
				log.Printf("Updated serial CAT server with current frequency/mode")
			}

			// Also update TCI server if running
			// Use skipCallback=true to prevent callback loops during restoration
			if tciServer != nil && tciServer.IsRunning() {
				tciServer.UpdateFrequency(currentFreq, 0, 0, true)
				if currentMode != "" {
					tciServer.UpdateMode(currentMode, 0, true)
				}
				log.Printf("Updated TCI server with current frequency/mode")
			}
		}
	}

	// Restore TCI server
	if savedStates.TCIRunning && savedStates.TCIPort > 0 {
		log.Printf("Restoring TCI server (port %d)...", savedStates.TCIPort)

		m.mu.RLock()
		alreadyRunning := m.client != nil && m.client.tciServer != nil && m.client.tciServer.IsRunning()
		m.mu.RUnlock()

		if !alreadyRunning {
			// Restart TCI server
			if err := m.StartTCIServer(savedStates.TCIPort); err != nil {
				log.Printf("Warning: Failed to restore TCI server: %v", err)
			} else {
				log.Printf("TCI server restored on port %d", savedStates.TCIPort)
			}
		} else {
			log.Printf("TCI server already running")
		}
	}

	log.Printf("Radio control state restoration complete")
}

// IsConnected returns whether the client is currently connected
// This method uses TryRLock to avoid deadlocks when called from callbacks
func (m *WebSocketManager) IsConnected() bool {
	log.Printf("DEBUG IsConnected: Attempting to acquire RLock...")
	// Try to acquire lock without blocking to avoid deadlocks
	// If we can't get the lock immediately, assume we're in a callback
	// and return the last known state
	if m.mu.TryRLock() {
		connected := m.connected
		log.Printf("DEBUG IsConnected: RLock acquired, connected=%v", connected)
		m.mu.RUnlock()
		return connected
	}

	// Could not acquire lock - likely called from within a locked context
	// This is safe because connected is only set to true/false atomically
	log.Printf("DEBUG IsConnected: Could not acquire RLock (likely in callback), returning last known state")
	// We can't safely read m.connected without the lock, so we need a different approach
	// Use a channel-based check instead
	result := make(chan bool, 1)
	go func() {
		m.mu.RLock()
		result <- m.connected
		m.mu.RUnlock()
	}()

	select {
	case connected := <-result:
		log.Printf("DEBUG IsConnected: Got result from goroutine: %v", connected)
		return connected
	case <-time.After(100 * time.Millisecond):
		// Timeout - assume disconnected to be safe
		log.Printf("DEBUG IsConnected: Timeout waiting for lock, assuming disconnected")
		return false
	}
}

// fetchInstanceDescription fetches the description from the connected server
func (m *WebSocketManager) fetchInstanceDescription(client *RadioClient) {
	// Build HTTP URL for description endpoint
	protocol := "http"
	if client.ssl {
		protocol = "https"
	}

	var host string
	var port int

	if client.url != "" {
		// Extract host and port from WebSocket URL
		parsedURL, err := url.Parse(client.url)
		if err != nil {
			log.Printf("Failed to parse URL for description fetch: %v", err)
			return
		}
		host = parsedURL.Hostname()
		port = 80
		if parsedURL.Port() != "" {
			fmt.Sscanf(parsedURL.Port(), "%d", &port)
		} else if parsedURL.Scheme == "wss" {
			port = 443
		}
	} else {
		host = client.host
		port = client.port
	}

	httpURL := fmt.Sprintf("%s://%s:%d/api/description", protocol, host, port)

	req, err := http.NewRequest("GET", httpURL, nil)
	if err != nil {
		log.Printf("Failed to create description request: %v", err)
		return
	}
	req.Header.Set("User-Agent", "UberSDR Client 1.0 (go)")

	httpClient := &http.Client{Timeout: 5 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("Failed to fetch instance description: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Failed to fetch instance description: HTTP %d", resp.StatusCode)
		return
	}

	var description map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&description); err != nil {
		log.Printf("Failed to decode instance description: %v", err)
		return
	}

	m.instanceDescription = description
	log.Printf("Fetched instance description successfully")
}

// GetInstanceDescription returns the stored instance description
func (m *WebSocketManager) GetInstanceDescription() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.instanceDescription
}

// GetStatus returns the current status
func (m *WebSocketManager) GetStatus() StatusResponse {
	m.mu.RLock()
	defer m.mu.RUnlock()

	status := StatusResponse{
		Connected:        m.connected,
		UserSessionID:    "",
		Bypassed:         m.bypassed,
		AllowedIQModes:   m.allowedIQModes,
		MaxSessionTime:   m.maxSessionTime,
		SessionStartTime: m.sessionStartTime,
	}

	// Get lock states from config
	if m.configManager != nil {
		config := m.configManager.Get()
		status.FrequencyLocked = config.FrequencyLocked
		status.ModeLocked = config.ModeLocked
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

		// Add current band information for UI band button highlighting
		status.CurrentBand = m.client.previousBand // previousBand tracks the current band

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

// GetChannelStates returns the current left and right channel enabled states
func (m *WebSocketManager) GetChannelStates() (leftEnabled bool, rightEnabled bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.client != nil {
		m.client.mu.RLock()
		leftEnabled = m.client.leftChannelEnabled
		rightEnabled = m.client.rightChannelEnabled
		m.client.mu.RUnlock()
	} else {
		// Default to both enabled if no client
		leftEnabled = true
		rightEnabled = true
	}
	return
}

// GetStatusWithOutputs returns the current status including output status
func (m *WebSocketManager) GetStatusWithOutputs() StatusResponse {
	status := m.GetStatus()
	status.OutputStatus = m.GetOutputStatus()
	return status
}

// Tune changes frequency/mode/bandwidth without reconnecting
func (m *WebSocketManager) Tune(req TuneRequest) error {
	// Track if mode was auto-switched (needs to be accessible in both RLock and Lock sections)
	var autoSwitchedMode bool
	var effectiveMode string

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

	// Determine the effective frequency (new or current)
	var effectiveFrequency int
	if req.Frequency != nil {
		effectiveFrequency = *req.Frequency
		tuneMsg["frequency"] = *req.Frequency
	} else {
		effectiveFrequency = m.client.frequency
		tuneMsg["frequency"] = m.client.frequency
	}

	// Determine the effective mode (new or current)
	if req.Mode != "" {
		tuneMsg["mode"] = req.Mode
		effectiveMode = req.Mode
	} else {
		tuneMsg["mode"] = m.client.mode
		effectiveMode = m.client.mode
	}

	// Automatic LSB/USB mode switching based on band changes
	// Only switch mode when:
	// 1. Moving between defined amateur radio bands (not outside bands like WEFAX, broadcast, etc.)
	// 2. The band itself changes (not just frequency within same band)
	// 3. The current mode is USB or LSB (don't override other modes)
	// 4. The current mode matches what auto-switching would choose for the CURRENT frequency
	//    (i.e., user hasn't manually overridden it or selected a bookmark with specific mode)
	// 5. Mode is not locked
	//
	// This approach: if user is already on USB at 7074 kHz (should be LSB), we assume they
	// want USB (bookmark/manual), so we don't auto-switch when they move to another band.

	// Check if mode is locked before attempting auto-switching
	modeLocked := false
	if m.configManager != nil {
		config := m.configManager.Get()
		modeLocked = config.ModeLocked
	}

	if req.Frequency != nil && !modeLocked {
		// Get band names (empty string if outside defined amateur bands)
		previousBand := GetBandForFrequency(m.client.frequency)
		currentBand := GetBandForFrequency(effectiveFrequency)

		// Only auto-switch when moving between defined amateur bands
		// This prevents auto-switching when listening to WEFAX, broadcast, etc.
		if previousBand != "" && currentBand != "" && previousBand != currentBand {
			currentModeLower := strings.ToLower(m.client.mode)
			requestedModeLower := strings.ToLower(effectiveMode)

			// Only process if both current and requested modes are USB or LSB
			if (currentModeLower == "usb" || currentModeLower == "lsb") &&
				(requestedModeLower == "usb" || requestedModeLower == "lsb") {

				// Determine what auto-switching would choose for CURRENT frequency
				var currentAutoMode string
				if m.client.frequency < 10000000 {
					currentAutoMode = "lsb"
				} else {
					currentAutoMode = "usb"
				}

				// Determine what auto-switching would choose for NEW frequency
				var newAutoMode string
				if effectiveFrequency < 10000000 {
					newAutoMode = "lsb"
				} else {
					newAutoMode = "usb"
				}

				// Only auto-switch if:
				// 1. Current mode matches what auto-switching chose for current freq (not overridden)
				// 2. New frequency requires different mode
				// 3. User didn't explicitly change mode in this request
				userChangedMode := req.Mode != "" && requestedModeLower != currentModeLower
				currentModeIsAuto := currentModeLower == currentAutoMode
				modeNeedsChange := newAutoMode != currentModeLower

				if currentModeIsAuto && modeNeedsChange && !userChangedMode {
					log.Printf("Band change detected: %s -> %s (freq %d Hz), auto-switching mode: %s -> %s",
						previousBand, currentBand, effectiveFrequency, currentModeLower, newAutoMode)
					tuneMsg["mode"] = newAutoMode
					effectiveMode = newAutoMode
					autoSwitchedMode = true
				} else if !currentModeIsAuto {
					log.Printf("Band change detected: %s -> %s (freq %d Hz), keeping user-overridden mode: %s (auto would choose %s)",
						previousBand, currentBand, effectiveFrequency, currentModeLower, newAutoMode)
				}
			}
		}
	}

	// Update bandwidth if provided (only for non-IQ modes)
	// Check the effective mode (the one being set, not the current one)
	isIQMode := effectiveMode == "iq" || effectiveMode == "iq48" ||
		effectiveMode == "iq96" || effectiveMode == "iq192" || effectiveMode == "iq384"

	if !isIQMode {
		// When mode is locked, also lock bandwidth to prevent filter width changes
		// This ensures that locking the mode keeps the entire demodulation settings stable
		explicitBandwidthChange := req.BandwidthLow != nil || req.BandwidthHigh != nil

		if modeLocked && !explicitBandwidthChange {
			// Mode is locked and no explicit bandwidth change requested
			// Keep current bandwidth settings (don't allow automatic changes)
			if m.client.bandwidthLow != nil {
				tuneMsg["bandwidthLow"] = *m.client.bandwidthLow
			}
			if m.client.bandwidthHigh != nil {
				tuneMsg["bandwidthHigh"] = *m.client.bandwidthHigh
			}
		} else {
			// Either mode not locked, or explicit bandwidth change requested
			// Allow bandwidth updates
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
	}

	conn := m.conn
	flrigClient := m.flrigClient
	flrigSyncToRig := m.flrigSyncToRig
	rigctlClient := m.rigctlClient
	rigctlSyncToRig := m.rigctlSyncToRig
	serialServer := m.serialServer
	// Get TCI server reference before unlocking
	var tciServer *TCIServer
	if m.client != nil {
		tciServer = m.client.tciServer
	}
	m.mu.RUnlock()

	// Send tune message with WebSocket write lock (OUTSIDE the main lock)
	m.connMu.Lock()
	err := conn.WriteJSON(tuneMsg)
	m.connMu.Unlock()

	if err != nil {
		return fmt.Errorf("failed to send tune message: %w", err)
	}

	log.Printf("Sent tune message: %+v", tuneMsg)

	// Update client state with Lock
	m.mu.Lock()
	// Track if we need to reset NR2 learning
	needsNR2Reset := false

	if req.Frequency != nil {
		m.client.frequency = *req.Frequency
		needsNR2Reset = true

		// Update previousBand for band change detection
		newBand := GetBandForFrequency(*req.Frequency)
		if newBand != m.client.previousBand {
			log.Printf("Band updated: %s -> %s", m.client.previousBand, newBand)
			m.client.previousBand = newBand
		}
	}
	if autoSwitchedMode {
		// Update mode if it was auto-switched due to band change
		m.client.mode = effectiveMode
		needsNR2Reset = true
	} else if req.Mode != "" {
		m.client.mode = req.Mode
		needsNR2Reset = true
	}
	if req.BandwidthLow != nil {
		m.client.bandwidthLow = req.BandwidthLow
		needsNR2Reset = true
	}
	if req.BandwidthHigh != nil {
		m.client.bandwidthHigh = req.BandwidthHigh
		needsNR2Reset = true
	}

	// Reset NR2 noise learning when frequency/mode/bandwidth changes
	if needsNR2Reset && m.client.nr2Processor != nil && m.client.nr2Enabled {
		m.client.nr2Processor.ResetLearning()
		log.Printf("NR2: Reset noise learning due to frequency/mode/bandwidth change")
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

	// Update TCI server's cached frequency/mode if running (without holding lock)
	// Use skipCallback=true to prevent callback loops since we're already in the GUI update path
	if tciServer != nil && tciServer.IsRunning() {
		if req.Frequency != nil {
			tciServer.UpdateFrequency(*req.Frequency, 0, 0, true)
		}
		if req.Mode != "" {
			tciServer.UpdateMode(req.Mode, 0, true)
		}
	}

	// Broadcast status update
	m.BroadcastStatus()

	return nil
}

// SetFrequency changes only the frequency
func (m *WebSocketManager) SetFrequency(frequency int) error {
	// Check frequency lock
	if m.configManager != nil {
		config := m.configManager.Get()
		if config.FrequencyLocked {
			return fmt.Errorf("frequency is locked")
		}
	}
	return m.Tune(TuneRequest{Frequency: &frequency})
}

// SetMode changes only the mode
func (m *WebSocketManager) SetMode(mode string) error {
	// Check mode lock
	if m.configManager != nil {
		config := m.configManager.Get()
		if config.ModeLocked {
			return fmt.Errorf("mode is locked")
		}
	}
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

		if *req.NR2Enabled {
			// Create NR2 processor if it doesn't exist
			if m.client.nr2Processor == nil {
				m.client.nr2Processor = NewNR2Processor(m.client.sampleRate, 2048, 4)
				m.client.nr2Processor.SetParameters(m.client.nr2Strength, m.client.nr2Floor, m.client.nr2AdaptRate)
				log.Printf("NR2 processor created (strength=%.1f%%, floor=%.1f%%, adapt=%.1f%%)",
					m.client.nr2Strength, m.client.nr2Floor, m.client.nr2AdaptRate)
			}
			// Enable and reset learning whenever NR2 is enabled
			m.client.nr2Processor.Enabled = true
			m.client.nr2Processor.ResetLearning()
			log.Printf("NR2 noise reduction enabled, learning noise profile...")
		} else if m.client.nr2Processor != nil {
			// Disable processor when disabling NR2
			m.client.nr2Processor.Enabled = false
			log.Printf("NR2 noise reduction disabled")
		}
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

	// Update resampling settings
	if req.ResampleEnabled != nil {
		m.client.resampleEnabled = *req.ResampleEnabled
		log.Printf("Resampling enabled updated to: %v", *req.ResampleEnabled)
	}
	if req.ResampleOutputRate != nil {
		m.client.resampleOutputRate = *req.ResampleOutputRate
		log.Printf("Resampling output rate updated to: %d", *req.ResampleOutputRate)
	}
	if req.OutputChannels != nil {
		m.client.outputChannels = *req.OutputChannels
		log.Printf("Output channels updated to: %d", *req.OutputChannels)
	}

	// Update volume and channel settings
	if req.Volume != nil {
		m.client.mu.Lock()
		m.client.volume = *req.Volume
		m.client.mu.Unlock()
	}
	if req.LeftChannelEnabled != nil {
		m.client.mu.Lock()
		m.client.leftChannelEnabled = *req.LeftChannelEnabled
		m.client.mu.Unlock()
		log.Printf("Left channel enabled: %v", *req.LeftChannelEnabled)
	}
	if req.RightChannelEnabled != nil {
		m.client.mu.Lock()
		m.client.rightChannelEnabled = *req.RightChannelEnabled
		m.client.mu.Unlock()
		log.Printf("Right channel enabled: %v", *req.RightChannelEnabled)
	}

	// Broadcast config update to WebSocket subscribers for real-time UI updates
	m.broadcastToSubscribers(map[string]interface{}{
		"type":   "config_update",
		"config": req,
	})

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
		if err == nil {
			// Update the client's audioDeviceIndex to ensure status updates reflect the correct device
			m.client.audioDeviceIndex = deviceIndex
			log.Printf("Audio device index updated to %d in client state", deviceIndex)

			// If resampling was automatically enabled during PortAudio setup, save it to config
			if m.client.resampleEnabled && m.configManager != nil {
				m.configManager.Update(func(c *ClientConfig) {
					if !c.ResampleEnabled {
						c.ResampleEnabled = true
						c.ResampleOutputRate = m.client.resampleOutputRate
						log.Printf("Automatic resampling enabled and saved to config: %d Hz -> %d Hz",
							m.client.sampleRate, m.client.resampleOutputRate)
					}
				})
			}
		}
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

	// Get lock states from config
	var frequencyLocked, modeLocked bool
	if m.configManager != nil {
		config := m.configManager.Get()
		frequencyLocked = config.FrequencyLocked
		modeLocked = config.ModeLocked
	}

	update := WSStatusUpdate{
		Type:            "status",
		Connected:       m.connected,
		Frequency:       m.client.frequency,
		Mode:            m.client.mode,
		SampleRate:      m.client.sampleRate,
		Channels:        m.client.channels,
		CurrentBand:     m.client.previousBand, // Include current band for UI highlighting
		FrequencyLocked: frequencyLocked,
		ModeLocked:      modeLocked,
		Timestamp:       time.Now(),
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
	log.Printf("DisableAudioStream called for connection")
	m.audioStreamsMu.Lock()
	if room, ok := m.audioStreams[conn]; ok {
		delete(m.audioStreams, conn)
		delete(m.audioWriteChans, conn)
		log.Printf("Disabled audio streaming from room '%s' for connection", room)
	} else {
		log.Printf("DisableAudioStream: Connection not found in audioStreams map")
	}

	// If no more audio streams, disable audio callback
	if len(m.audioStreams) == 0 {
		log.Printf("DisableAudioStream: No more audio streams, disabling audio callback")
		m.mu.RLock()
		client := m.client
		m.mu.RUnlock()

		if client != nil {
			client.SetAudioCallback(nil)
			log.Printf("DisableAudioStream: Audio callback disabled")
		} else {
			log.Printf("DisableAudioStream: Client is nil, cannot disable callback")
		}
	} else {
		log.Printf("DisableAudioStream: Still have %d audio streams active", len(m.audioStreams))
	}
	m.audioStreamsMu.Unlock()

	// Check if we should auto-disconnect (no more clients)
	// Run in separate goroutine to avoid deadlocks
	log.Printf("DisableAudioStream: Calling checkAutoDisconnect in goroutine")
	go m.checkAutoDisconnect()
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
	m.audioStreamsMu.Lock()
	defer m.audioStreamsMu.Unlock()

	// Track connections with closed channels for cleanup
	var closedConns []*websocket.Conn

	for conn, connRoom := range m.audioStreams {
		if connRoom == room {
			if writeChan, ok := m.audioWriteChans[conn]; ok {
				// Use defer/recover to catch any panics from closed channels
				channelClosed := false
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("Detected closed channel in broadcastAudioData, will clean up connection")
							channelClosed = true
						}
					}()

					select {
					case writeChan <- audioMsg:
						// Sent successfully
					default:
						// Channel full, skip this frame
						log.Printf("Audio write channel full for room '%s', dropping frame", room)
					}
				}()

				// If channel was closed, mark connection for cleanup
				if channelClosed {
					closedConns = append(closedConns, conn)
				}
			}
		}
	}

	// Clean up connections with closed channels
	for _, conn := range closedConns {
		log.Printf("Cleaning up closed audio stream connection")
		delete(m.audioStreams, conn)
		delete(m.audioWriteChans, conn)
	}
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
	m.spectrumStreamsMu.Unlock()

	// Check if we should auto-disconnect (no more clients)
	// Run in separate goroutine to avoid deadlocks
	go m.checkAutoDisconnect()
}

// broadcastSpectrumData sends spectrum data to all WebSocket connections subscribed to the given room
func (m *WebSocketManager) broadcastSpectrumData(data []byte, room string) {
	// Parse the JSON data to send as a map
	var spectrumMsg map[string]interface{}
	if err := json.Unmarshal(data, &spectrumMsg); err != nil {
		log.Printf("Failed to unmarshal spectrum data: %v", err)
		return
	}

	// Extract signal level from spectrum data for TCI server
	m.updateTCISignalLevel(spectrumMsg)

	// Send to all connections for this room via their write channels
	m.spectrumStreamsMu.Lock()
	defer m.spectrumStreamsMu.Unlock()

	// Track connections with closed channels for cleanup
	var closedConns []*websocket.Conn

	for conn, connRoom := range m.spectrumStreams {
		if connRoom == room {
			if writeChan, ok := m.spectrumWriteChans[conn]; ok {
				// Use defer/recover to catch any panics from closed channels
				channelClosed := false
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("Detected closed channel in broadcastSpectrumData, will clean up connection")
							channelClosed = true
						}
					}()

					select {
					case writeChan <- spectrumMsg:
						// Sent successfully
					default:
						// Channel full, skip this frame
						log.Printf("Spectrum write channel full for room '%s', dropping frame", room)
					}
				}()

				// If channel was closed, mark connection for cleanup
				if channelClosed {
					closedConns = append(closedConns, conn)
				}
			}
		}
	}

	// Clean up connections with closed channels
	for _, conn := range closedConns {
		log.Printf("Cleaning up closed spectrum stream connection")
		delete(m.spectrumStreams, conn)
		delete(m.spectrumWriteChans, conn)
	}
}

var tciSignalLevelDebugOnce sync.Once

// updateTCISignalLevel extracts peak signal level from spectrum data and updates TCI server
// This mimics the Python client's get_bandwidth_signal() method
func (m *WebSocketManager) updateTCISignalLevel(spectrumMsg map[string]interface{}) {
	// Check if TCI server is running
	m.mu.RLock()
	client := m.client
	m.mu.RUnlock()

	if client == nil || client.tciServer == nil || !client.tciServer.IsRunning() {
		return
	}

	// Extract spectrum data array - the message should contain the spectrum power values
	// The spectrum data is an array of dB values (dBFS)
	var powerData interface{}
	var ok bool

	// Try "data" first (most likely field name for spectrum array)
	powerData, ok = spectrumMsg["data"]
	if !ok {
		return // Silently skip if no spectrum data
	}

	// Convert to float64 slice
	var powers []float64
	switch v := powerData.(type) {
	case []interface{}:
		powers = make([]float64, len(v))
		for i, val := range v {
			if fval, ok := val.(float64); ok {
				powers[i] = fval
			}
		}
	case []float64:
		powers = v
	default:
		return // Silently skip if wrong type
	}

	if len(powers) == 0 {
		return // Silently skip if empty
	}

	// Unwrap FFT bin ordering (matches Python client spectrum_display.py lines 306-311)
	// FFT output is [DC, positive freqs, negative freqs]
	// We need to rearrange to [negative freqs, positive freqs] for proper frequency mapping
	N := len(powers)
	halfBins := N / 2
	unwrapped := make([]float64, N)
	// Copy second half (negative freqs) to start
	copy(unwrapped, powers[halfBins:])
	// Copy first half (positive freqs) to end
	copy(unwrapped[N-halfBins:], powers[:halfBins])
	// Use unwrapped data for signal level calculation
	powers = unwrapped

	// Get spectrum configuration (enriched by SpectrumClient from config messages)
	centerFreq, hasCenterFreq := spectrumMsg["centerFreq"].(float64)
	totalBandwidth, hasTotalBandwidth := spectrumMsg["totalBandwidth"].(float64)

	if !hasCenterFreq || !hasTotalBandwidth || centerFreq == 0 || totalBandwidth == 0 {
		// No frequency info - just use peak across entire spectrum as fallback
		peakDB := powers[0]
		for _, p := range powers[1:] {
			if p > peakDB {
				peakDB = p
			}
		}
		client.tciServer.UpdateSignalLevel(peakDB, 0)
		return
	}

	// Get current tuned frequency and bandwidth from client
	m.mu.RLock()
	tunedFreq := client.frequency
	bandwidthLow := 0
	bandwidthHigh := 3000 // Default to 3 kHz bandwidth
	if client.bandwidthLow != nil {
		bandwidthLow = *client.bandwidthLow
	}
	if client.bandwidthHigh != nil {
		bandwidthHigh = *client.bandwidthHigh
	}
	m.mu.RUnlock()

	// Calculate absolute frequencies for bandwidth edges
	// This matches Python's spectrum_display.py get_bandwidth_signal() method
	filterLowFreq := float64(tunedFreq + bandwidthLow)
	filterHighFreq := float64(tunedFreq + bandwidthHigh)

	// Calculate spectrum view range
	startFreq := centerFreq - (totalBandwidth / 2)

	// Map frequencies to bin indices
	// Matches Python: int((freq - start_freq) / total_bandwidth * len(spectrum_data))
	lowBin := int((filterLowFreq - startFreq) / totalBandwidth * float64(len(powers)))
	highBin := int((filterHighFreq - startFreq) / totalBandwidth * float64(len(powers)))

	// Clamp to valid range
	if lowBin < 0 {
		lowBin = 0
	}
	if highBin >= len(powers) {
		highBin = len(powers) - 1
	}
	if lowBin >= highBin {
		// Invalid range - use entire spectrum as fallback
		peakDB := powers[0]
		for _, p := range powers[1:] {
			if p > peakDB {
				peakDB = p
			}
		}
		client.tciServer.UpdateSignalLevel(peakDB, 0)
		return
	}

	// Find peak power value within the tuned bandwidth
	// Matches Python: peak_db = np.max(valid_data)
	peakDB := powers[lowBin]
	for i := lowBin; i <= highBin; i++ {
		if powers[i] > peakDB {
			peakDB = powers[i]
		}
	}

	// Update TCI server with peak signal level
	// The peak dBFS value is used directly as the signal level
	client.tciServer.UpdateSignalLevel(peakDB, 0)
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
				syncToRig := m.flrigSyncToRig
				m.mu.RUnlock()

				log.Printf("DEBUG: flrig frequency callback fired: freq=%d Hz, syncFromRig=%v, syncToRig=%v", freq, syncFromRig, syncToRig)

				if !syncFromRig {
					log.Printf("flrig frequency changed to %d Hz (sync FROM rig DISABLED - not syncing to SDR)", freq)
					return
				}

				// Check connection without holding lock for too long
				m.mu.RLock()
				connected := m.connected
				client := m.client
				m.mu.RUnlock()

				if !connected || client == nil {
					log.Printf("flrig frequency changed to %d Hz (not connected to SDR - cannot sync)", freq)
					return
				}

				log.Printf("flrig frequency changed to %d Hz (sync FROM rig enabled - syncing to SDR)", freq)

				// Update SDR frequency
				// Note: We don't need to disable syncToRig here because SetFrequency
				// will sync to flrig, but flrig already has this frequency, so it's a no-op
				if err := m.SetFrequency(freq); err != nil {
					log.Printf("Failed to update SDR frequency from flrig: %v", err)
				}
			}()
		},
		func(mode string) {
			// Run callback in goroutine to avoid blocking polling
			go func() {
				// Check sync setting with lock
				m.mu.RLock()
				syncFromRig := m.flrigSyncFromRig
				syncToRig := m.flrigSyncToRig
				m.mu.RUnlock()

				log.Printf("DEBUG: flrig mode callback fired: mode=%s, syncFromRig=%v, syncToRig=%v", mode, syncFromRig, syncToRig)

				if !syncFromRig {
					log.Printf("flrig mode changed to %s (sync FROM rig DISABLED - not syncing to SDR)", mode)
					return
				}

				// Check connection without holding lock for too long
				m.mu.RLock()
				connected := m.connected
				client := m.client
				m.mu.RUnlock()

				if !connected || client == nil {
					log.Printf("flrig mode changed to %s (not connected to SDR - cannot sync)", mode)
					return
				}

				// Convert mode to lowercase for SDR server
				modeLower := strings.ToLower(mode)
				log.Printf("flrig mode changed to %s (sync FROM rig enabled - syncing to SDR as %s)", mode, modeLower)

				// Update SDR mode
				// Note: We don't need to disable syncToRig here because SetMode
				// will sync to flrig, but flrig already has this mode, so it's a no-op
				if err := m.SetMode(modeLower); err != nil {
					log.Printf("Failed to update SDR mode from flrig: %v", err)
				}
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

	log.Printf("DEBUG: Connected to flrig at %s:%d (VFO %s, sync: SDR->rig=%v, rig->SDR=%v)",
		host, port, vfo, syncToRig, syncFromRig)
	log.Printf("DEBUG: Sync flags stored in manager: m.flrigSyncToRig=%v, m.flrigSyncFromRig=%v",
		m.flrigSyncToRig, m.flrigSyncFromRig)

	// Perform initial sync from SDR to rig if enabled and SDR is connected
	if syncToRig && m.connected && m.client != nil {
		currentFreq := m.client.frequency
		currentMode := m.client.mode

		log.Printf("Performing initial sync to flrig: freq=%d Hz, mode=%s", currentFreq, currentMode)

		if currentFreq > 0 {
			if err := m.flrigClient.SetFrequency(currentFreq); err != nil {
				log.Printf("Warning: Failed to sync initial frequency to flrig: %v", err)
			} else {
				log.Printf("Synced initial frequency %d Hz to flrig", currentFreq)
			}
		}

		if currentMode != "" {
			if err := m.flrigClient.SetMode(currentMode); err != nil {
				log.Printf("Warning: Failed to sync initial mode to flrig: %v", err)
			} else {
				log.Printf("Synced initial mode %s to flrig", currentMode)
			}
		}
	}

	// Start polling goroutine
	log.Printf("DEBUG: Starting flrig polling goroutine...")
	m.startFlrigPolling()

	// Force an immediate poll to sync initial state if sync is enabled
	// This ensures callbacks fire right away with the correct sync settings
	if syncFromRig && m.flrigClient != nil {
		log.Printf("DEBUG: syncFromRig is enabled, scheduling immediate poll...")
		go func() {
			// Small delay to ensure polling goroutine is running
			time.Sleep(100 * time.Millisecond)
			m.mu.RLock()
			client := m.flrigClient
			m.mu.RUnlock()
			if client != nil && client.IsConnected() {
				log.Printf("DEBUG: Triggering initial flrig poll to sync state...")
				client.Poll()
			} else {
				log.Printf("DEBUG: Cannot trigger initial poll - client not connected")
			}
		}()
	} else {
		log.Printf("DEBUG: NOT scheduling immediate poll (syncFromRig=%v, client=%v)", syncFromRig, m.flrigClient != nil)
	}

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

	if m.flrigClient == nil {
		m.mu.Unlock()
		return fmt.Errorf("flrig not connected")
	}

	oldSyncToRig := m.flrigSyncToRig
	oldSyncFromRig := m.flrigSyncFromRig

	m.flrigSyncToRig = syncToRig
	m.flrigSyncFromRig = syncFromRig

	// Reset firstPoll flag to force callbacks to fire on next poll
	// This ensures sync starts working immediately when enabled
	client := m.flrigClient
	m.mu.Unlock()

	log.Printf("DEBUG: SetFlrigSync called - changing from (SDR->rig=%v, rig->SDR=%v) to (SDR->rig=%v, rig->SDR=%v)",
		oldSyncToRig, oldSyncFromRig, syncToRig, syncFromRig)

	if client != nil {
		client.cacheMu.Lock()
		oldFirstPoll := client.firstPoll
		client.firstPoll = true
		client.cacheMu.Unlock()
		log.Printf("DEBUG: Reset firstPoll flag (was %v, now true) - callbacks will fire on next poll", oldFirstPoll)
		log.Printf("Updated flrig sync settings: SDR->rig=%v, rig->SDR=%v (will sync on next poll)", syncToRig, syncFromRig)
	} else {
		log.Printf("DEBUG: Cannot reset firstPoll - client is nil")
	}

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

	// Perform initial sync from SDR to rig if enabled and SDR is connected
	if syncToRig && m.connected && m.client != nil {
		currentFreq := m.client.frequency
		currentMode := m.client.mode

		log.Printf("Performing initial sync to rigctl: freq=%d Hz, mode=%s", currentFreq, currentMode)

		if currentFreq > 0 {
			if err := m.rigctlClient.SetFrequency(currentFreq); err != nil {
				log.Printf("Warning: Failed to sync initial frequency to rigctl: %v", err)
			} else {
				log.Printf("Synced initial frequency %d Hz to rigctl", currentFreq)
			}
		}

		if currentMode != "" {
			if err := m.rigctlClient.SetMode(currentMode); err != nil {
				log.Printf("Warning: Failed to sync initial mode to rigctl: %v", err)
			} else {
				log.Printf("Synced initial mode %s to rigctl", currentMode)
			}
		}
	}

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

// GetNoiseFloor returns the cached noise floor data
func (m *WebSocketManager) GetNoiseFloor() (map[string]interface{}, error) {
	m.noiseFloorMu.RLock()
	defer m.noiseFloorMu.RUnlock()

	if m.cachedNoiseFloor == nil {
		return nil, fmt.Errorf("no noise floor data available yet")
	}

	return m.cachedNoiseFloor, nil
}

// fetchNoiseFloorData fetches noise floor data from the connected SDR server
func (m *WebSocketManager) fetchNoiseFloorData() error {
	m.mu.RLock()
	if !m.connected || m.client == nil {
		m.mu.RUnlock()
		return fmt.Errorf("not connected to SDR server")
	}

	// Build the API URL
	protocol := "http"
	if m.client.ssl {
		protocol = "https"
	}
	apiURL := fmt.Sprintf("%s://%s:%d/api/noisefloor/latest", protocol, m.client.host, m.client.port)
	m.mu.RUnlock()

	// Make HTTP request to fetch noise floor data
	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get(apiURL)
	if err != nil {
		return fmt.Errorf("failed to fetch noise floor: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to fetch noise floor: status %d, body: %s", resp.StatusCode, string(body))
	}

	// Parse JSON response
	var noiseFloor map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&noiseFloor); err != nil {
		return fmt.Errorf("failed to parse noise floor: %w", err)
	}

	// Update cache
	m.noiseFloorMu.Lock()
	m.cachedNoiseFloor = noiseFloor
	m.noiseFloorMu.Unlock()

	log.Printf("Fetched and cached noise floor data from SDR server")
	return nil
}

// startNoiseFloorPolling starts the noise floor polling goroutine
func (m *WebSocketManager) startNoiseFloorPolling() {
	m.mu.Lock()
	if m.noiseFloorPolling {
		m.mu.Unlock()
		return
	}

	ctx, cancel := context.WithCancel(m.ctx)
	m.noiseFloorPollCancel = cancel
	m.noiseFloorPolling = true
	m.mu.Unlock()

	go func() {
		// Fetch immediately on start
		if err := m.fetchNoiseFloorData(); err != nil {
			log.Printf("Initial noise floor fetch failed: %v", err)
		}

		ticker := time.NewTicker(60 * time.Second) // Poll every 60 seconds
		defer ticker.Stop()

		log.Printf("Noise floor polling goroutine started (60 second interval)")

		for {
			select {
			case <-ctx.Done():
				log.Printf("Noise floor polling goroutine stopped (context done)")
				return
			case <-ticker.C:
				if err := m.fetchNoiseFloorData(); err != nil {
					log.Printf("Noise floor fetch failed: %v", err)
				}
			}
		}
	}()

	log.Printf("Started noise floor polling")
}

// stopNoiseFloorPolling stops the noise floor polling goroutine
// NOTE: This method assumes the caller already holds m.mu lock (called from Disconnect)
func (m *WebSocketManager) stopNoiseFloorPolling() {
	log.Printf("DEBUG stopNoiseFloorPolling: Called (assumes lock already held)")
	if !m.noiseFloorPolling {
		log.Printf("DEBUG stopNoiseFloorPolling: Not polling, returning")
		return
	}

	log.Printf("DEBUG stopNoiseFloorPolling: Cancelling poll context...")
	if m.noiseFloorPollCancel != nil {
		m.noiseFloorPollCancel()
		m.noiseFloorPollCancel = nil
	}
	log.Printf("DEBUG stopNoiseFloorPolling: Poll context cancelled")

	m.noiseFloorPolling = false

	// Clear cached data
	log.Printf("DEBUG stopNoiseFloorPolling: Clearing cached data...")
	m.noiseFloorMu.Lock()
	m.cachedNoiseFloor = nil
	m.noiseFloorMu.Unlock()
	log.Printf("DEBUG stopNoiseFloorPolling: Cached data cleared")

	log.Printf("Stopped noise floor polling and cleared cache")
}

// SetConfigManager sets the configuration manager for the WebSocketManager
func (m *WebSocketManager) SetConfigManager(configManager *ConfigManager) {
	m.mu.Lock()
	m.configManager = configManager
	m.mu.Unlock()

	// Initialize MIDI controller with config manager
	// This will load saved config and auto-connect if enabled
	m.mu.Lock()
	if m.midiController == nil {
		m.midiController = NewMIDIController(m, configManager)
		log.Printf("MIDI controller initialized")
	}
	m.mu.Unlock()
}

// MIDI Control Methods

// ConnectMIDI connects to a MIDI device
func (m *WebSocketManager) ConnectMIDI(deviceName string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Disconnect existing MIDI controller if any
	if m.midiController != nil {
		m.stopMIDIPolling()
		m.midiController.Disconnect()
		m.midiController = nil
	}

	// Create new MIDI controller
	m.midiController = NewMIDIController(m, m.configManager)

	// Connect to MIDI device
	if err := m.midiController.Connect(deviceName); err != nil {
		m.midiController = nil
		return fmt.Errorf("failed to connect to MIDI device: %w", err)
	}

	log.Printf("Connected to MIDI device: %s", deviceName)

	// Start polling goroutine
	m.startMIDIPolling()

	return nil
}

// DisconnectMIDI disconnects from the MIDI device
func (m *WebSocketManager) DisconnectMIDI() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.midiController == nil {
		return fmt.Errorf("MIDI not connected")
	}

	m.stopMIDIPolling()
	m.midiController.Disconnect()
	m.midiController = nil

	log.Printf("Disconnected from MIDI device")
	return nil
}

// IsMIDIConnected returns whether MIDI is connected
func (m *WebSocketManager) IsMIDIConnected() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.midiController != nil && m.midiController.connected
}

// GetMIDIDevices returns a list of available MIDI devices
func (m *WebSocketManager) GetMIDIDevices() ([]MIDIDevice, error) {
	// Create temporary controller to list devices
	controller := &MIDIController{}
	return controller.ListDevices()
}

// GetMIDIStatus returns the current MIDI status
func (m *WebSocketManager) GetMIDIStatus() MIDIStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.midiController == nil {
		return MIDIStatus{
			Connected: false,
		}
	}

	return m.midiController.GetStatus()
}

// GetMIDIMappings returns the current MIDI mappings
func (m *WebSocketManager) GetMIDIMappings() map[MIDIKey]MIDIMapping {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.midiController == nil {
		return make(map[MIDIKey]MIDIMapping)
	}

	return m.midiController.GetMappings()
}

// AddMIDIMapping adds a new MIDI mapping
func (m *WebSocketManager) AddMIDIMapping(key MIDIKey, mapping MIDIMapping) {
	m.mu.RLock()
	controller := m.midiController
	m.mu.RUnlock()

	if controller == nil {
		log.Printf("Cannot add MIDI mapping: MIDI not connected")
		return
	}

	controller.AddMapping(key, mapping)
}

// DeleteMIDIMapping removes a MIDI mapping
func (m *WebSocketManager) DeleteMIDIMapping(key MIDIKey) {
	m.mu.RLock()
	controller := m.midiController
	m.mu.RUnlock()

	if controller == nil {
		log.Printf("Cannot delete MIDI mapping: MIDI not connected")
		return
	}

	controller.mu.Lock()
	delete(controller.mappings, key)
	controller.mu.Unlock()
}

// StartMIDILearnMode starts MIDI learn mode
func (m *WebSocketManager) StartMIDILearnMode(function string, isEncoder bool, callback func(MIDILearnResponse)) error {
	m.mu.RLock()
	controller := m.midiController
	m.mu.RUnlock()

	if controller == nil {
		return fmt.Errorf("MIDI not connected")
	}

	controller.StartLearnMode(function, isEncoder, callback)
	return nil
}

// StopMIDILearnMode stops MIDI learn mode
func (m *WebSocketManager) StopMIDILearnMode() error {
	m.mu.RLock()
	controller := m.midiController
	m.mu.RUnlock()

	if controller == nil {
		return fmt.Errorf("MIDI not connected")
	}

	controller.StopLearnMode()
	return nil
}

// SaveMIDIConfig saves the MIDI configuration to file
func (m *WebSocketManager) SaveMIDIConfig() error {
	m.mu.RLock()
	controller := m.midiController
	m.mu.RUnlock()

	if controller == nil {
		return fmt.Errorf("MIDI not connected")
	}

	return controller.SaveConfig()
}

// LoadMIDIConfig loads the MIDI configuration from file
func (m *WebSocketManager) LoadMIDIConfig() error {
	m.mu.RLock()
	controller := m.midiController
	m.mu.RUnlock()

	if controller == nil {
		return fmt.Errorf("MIDI not connected")
	}

	return controller.LoadConfig()
}

// startMIDIPolling starts the MIDI polling goroutine
func (m *WebSocketManager) startMIDIPolling() {
	if m.midiPolling {
		return
	}

	ctx, cancel := context.WithCancel(m.ctx)
	m.midiPollCancel = cancel
	m.midiPolling = true

	go func() {
		log.Printf("MIDI polling goroutine started")

		for {
			select {
			case <-ctx.Done():
				log.Printf("MIDI polling goroutine stopped (context done)")
				return
			default:
				// MIDI messages are handled via callbacks in the controller
				// This goroutine just keeps the context alive
				time.Sleep(100 * time.Millisecond)
			}
		}
	}()

	log.Printf("Started MIDI polling")
}

// stopMIDIPolling stops the MIDI polling goroutine
func (m *WebSocketManager) stopMIDIPolling() {
	if !m.midiPolling {
		return
	}

	if m.midiPollCancel != nil {
		m.midiPollCancel()
		m.midiPollCancel = nil
	}

	m.midiPolling = false
	log.Printf("Stopped MIDI polling")
}

// checkAutoDisconnect checks if ConnectOnDemand is enabled and disconnects if no clients remain
func (m *WebSocketManager) checkAutoDisconnect() {
	// Check if ConnectOnDemand is enabled
	if m.configManager == nil {
		return
	}

	config := m.configManager.Get()
	if !config.ConnectOnDemand {
		return // Auto-disconnect only when ConnectOnDemand is enabled
	}

	// If StayConnected is enabled, don't auto-disconnect
	if config.StayConnected {
		log.Printf("ConnectOnDemand: StayConnected is enabled, skipping auto-disconnect check")
		return
	}

	// Count active clients
	m.audioStreamsMu.RLock()
	audioClients := len(m.audioStreams)
	m.audioStreamsMu.RUnlock()

	m.spectrumStreamsMu.RLock()
	spectrumClients := len(m.spectrumStreams)
	m.spectrumStreamsMu.RUnlock()

	// Count TCI clients
	m.mu.RLock()
	var tciClients int
	if m.client != nil && m.client.tciServer != nil {
		tciClients = m.client.tciServer.GetClientCount()
	}
	m.mu.RUnlock()

	totalClients := audioClients + spectrumClients + tciClients

	log.Printf("ConnectOnDemand: Checking client count - audio: %d, spectrum: %d, TCI: %d, total: %d",
		audioClients, spectrumClients, tciClients, totalClients)

	// If no clients remain, disconnect from SDR
	if totalClients == 0 {
		m.mu.RLock()
		connected := m.connected
		m.mu.RUnlock()

		if connected {
			log.Printf("ConnectOnDemand: No clients remaining, scheduling auto-disconnect from SDR instance")
			// Use a timer to delay the disconnect slightly, allowing any pending operations to complete
			// and avoiding potential deadlocks from immediate disconnect during cleanup
			time.AfterFunc(500*time.Millisecond, func() {
				// Double-check we're still connected and still have no clients
				m.audioStreamsMu.RLock()
				audioClients := len(m.audioStreams)
				m.audioStreamsMu.RUnlock()

				m.spectrumStreamsMu.RLock()
				spectrumClients := len(m.spectrumStreams)
				m.spectrumStreamsMu.RUnlock()

				// Re-check TCI clients
				m.mu.RLock()
				var tciClients int
				if m.client != nil && m.client.tciServer != nil {
					tciClients = m.client.tciServer.GetClientCount()
				}
				m.mu.RUnlock()

				if audioClients == 0 && spectrumClients == 0 && tciClients == 0 {
					m.mu.RLock()
					stillConnected := m.connected
					m.mu.RUnlock()

					if stillConnected {
						log.Printf("ConnectOnDemand: Executing auto-disconnect (no clients after delay)")
						if err := m.Disconnect(); err != nil {
							log.Printf("ConnectOnDemand: Auto-disconnect failed: %v", err)
						} else {
							log.Printf("ConnectOnDemand: Successfully auto-disconnected from SDR instance")
						}
					}
				} else {
					log.Printf("ConnectOnDemand: Auto-disconnect cancelled - clients reconnected (audio: %d, spectrum: %d, TCI: %d)",
						audioClients, spectrumClients, tciClients)
				}
			})
		}
	}
}

// TCI Server Methods

// StartTCIServer starts the TCI server on the specified port
func (m *WebSocketManager) StartTCIServer(port int) error {
	m.mu.Lock()

	// Stop existing TCI server if any
	if m.client != nil && m.client.tciServer != nil {
		m.client.tciServer.Stop()
		m.client.tciServer = nil
	}

	// Store TCI server reference for later updates
	var tciServerRef *TCIServer

	// Create and start new TCI server
	// GUI callback for frequency/mode changes from TCI client
	// Run in goroutine to avoid blocking TCI server and prevent deadlocks
	guiCallback := func(paramType string, value interface{}) {
		go func() {
			// Check if we're connected to SDR, if not, try to connect
			m.mu.RLock()
			connected := m.connected
			m.mu.RUnlock()

			if !connected {
				log.Printf("TCI GUI callback: Not connected to SDR, attempting auto-connect...")
				// Try to connect using saved config
				if m.configManager != nil {
					config := m.configManager.Get()
					if config.Host != "" && config.Port > 0 {
						log.Printf("TCI GUI callback: Connecting to %s:%d...", config.Host, config.Port)

						// Create client from saved config
						client := NewRadioClient(
							"", config.Host, config.Port, config.Frequency, config.Mode,
							config.BandwidthLow, config.BandwidthHigh, config.OutputMode, "",
							nil, config.SSL, config.Password, config.AudioDevice, config.NR2Enabled,
							config.NR2Strength, config.NR2Floor, config.NR2AdaptRate, false,
							config.ResampleEnabled, config.ResampleOutputRate,
							config.OutputChannels,
							config.FIFOPath, config.UDPHost, config.UDPPort, config.UDPEnabled,
						)

						// Attempt to connect
						if err := m.Connect(client); err != nil {
							log.Printf("TCI GUI callback: Auto-connect failed: %v", err)
							return
						}
						log.Printf("TCI GUI callback: Auto-connect successful")

						// Update TCI server's radioClient reference
						m.mu.Lock()
						if tciServerRef != nil && m.client != nil {
							tciServerRef.mu.Lock()
							tciServerRef.radioClient = m.client
							// Update TCI server with current frequency and mode
							tciServerRef.vfoFrequencies[0][0] = m.client.frequency
							tciServerRef.modulations[0] = mapUberSDRModeToTCI(strings.ToLower(m.client.mode))
							tciServerRef.mu.Unlock()
							log.Printf("TCI server: Updated radioClient reference after auto-connect")

							// Assign TCI server to client
							m.client.tciServer = tciServerRef
						}
						m.mu.Unlock()

						// Enable spectrum streaming for signal level updates
						go m.enableTCISpectrumStream()

						// Wait a moment for connection to stabilize
						time.Sleep(500 * time.Millisecond)
					} else {
						log.Printf("TCI GUI callback: No saved SDR configuration available")
						return
					}
				} else {
					log.Printf("TCI GUI callback: No config manager available")
					return
				}
			}

			// Now process the callback
			switch paramType {
			case "frequency":
				if freq, ok := value.(int); ok {
					log.Printf("TCI GUI callback: Setting frequency to %d Hz", freq)
					if err := m.SetFrequency(freq); err != nil {
						log.Printf("TCI GUI callback: Failed to set frequency: %v", err)
					}
				}
			case "mode":
				if mode, ok := value.(string); ok {
					log.Printf("TCI GUI callback: Setting mode to %s", mode)
					if err := m.SetMode(strings.ToLower(mode)); err != nil {
						log.Printf("TCI GUI callback: Failed to set mode: %v", err)
					}
				}
			}
		}()
	}

	tciServer := NewTCIServer(m.client, port, "0.0.0.0", guiCallback)
	tciServerRef = tciServer // Store reference for callback

	// Set up TCI client change callback for auto-disconnect
	tciServer.clientChangeCallback = func(connected bool) {
		if !connected {
			// TCI client disconnected, check if we should auto-disconnect from SDR
			log.Printf("TCI client disconnected, checking auto-disconnect...")
			go m.checkAutoDisconnect()
		}
	}

	m.mu.Unlock() // Unlock before starting server to avoid holding lock during network operations

	if err := tciServer.Start(); err != nil {
		return fmt.Errorf("failed to start TCI server: %w", err)
	}

	m.mu.Lock()
	if m.client != nil {
		m.client.tciServer = tciServer
	}
	m.mu.Unlock()

	log.Printf("Started TCI server on port %d", port)

	// Enable spectrum streaming for signal level updates if connected
	// This is needed for the S-meter to work in TCI clients
	m.mu.RLock()
	connected := m.connected
	m.mu.RUnlock()

	if connected {
		go m.enableTCISpectrumStream()
	}

	return nil
}

// enableTCISpectrumStream enables spectrum streaming for TCI signal level updates
func (m *WebSocketManager) enableTCISpectrumStream() {
	// Wait a moment for TCI server to fully start
	time.Sleep(500 * time.Millisecond)

	log.Printf("TCI: Attempting to enable spectrum streaming for signal levels")

	m.mu.Lock()
	if m.spectrumClient == nil && m.client != nil {
		// Build server URL from client config
		protocol := "http"
		if m.client.ssl {
			protocol = "https"
		}
		serverURL := fmt.Sprintf("%s://%s:%d", protocol, m.client.host, m.client.port)

		log.Printf("TCI: Creating spectrum client for %s", serverURL)
		m.spectrumClient = NewSpectrumClient(serverURL, m.client.userSessionID, m.client.password)

		// Set callback to broadcast spectrum data (which will update TCI signal levels)
		m.spectrumClient.SetDataCallback(func(data []byte) {
			m.broadcastSpectrumData(data, "tci_internal")
		})

		// Connect to spectrum WebSocket
		if err := m.spectrumClient.Connect(); err != nil {
			log.Printf("TCI: Failed to enable spectrum streaming for signal levels: %v", err)
			m.spectrumClient = nil
			m.mu.Unlock()
			return
		}
		log.Printf("TCI: Successfully enabled spectrum streaming for signal level updates")
	} else {
		if m.spectrumClient != nil {
			log.Printf("TCI: Spectrum client already exists, skipping creation")
		}
		if m.client == nil {
			log.Printf("TCI: No radio client available")
		}
	}
	m.mu.Unlock()
}

// StopTCIServer stops the TCI server
func (m *WebSocketManager) StopTCIServer() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.client == nil || m.client.tciServer == nil {
		return fmt.Errorf("TCI server not running")
	}

	m.client.tciServer.Stop()
	m.client.tciServer = nil

	log.Printf("Stopped TCI server")
	return nil
}

// IsTCIServerRunning returns whether the TCI server is running
func (m *WebSocketManager) IsTCIServerRunning() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.client != nil && m.client.tciServer != nil && m.client.tciServer.IsRunning()
}

// GetTCIServerStatus returns the current TCI server status
func (m *WebSocketManager) GetTCIServerStatus() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.client == nil || m.client.tciServer == nil {
		return map[string]interface{}{
			"running": false,
		}
	}

	return m.client.tciServer.GetStatus()
}
