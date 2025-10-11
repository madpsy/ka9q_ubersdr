package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Global stats aggregator
var (
	globalStatsAudio    = &statsAggregator{label: "Audio"}
	globalStatsSpectrum = &statsAggregator{label: "Spectrum"}
	statsLoggerOnce     sync.Once
)

// statsAggregator aggregates stats from multiple connections
type statsAggregator struct {
	label           string
	bytesWritten    int64
	messagesWritten int64
	connectionCount int64
	mu              sync.Mutex
	lastLogTime     time.Time
}

func (sa *statsAggregator) addConnection() {
	atomic.AddInt64(&sa.connectionCount, 1)
}

func (sa *statsAggregator) removeConnection() {
	atomic.AddInt64(&sa.connectionCount, -1)
}

func (sa *statsAggregator) addBytes(bytes int64) {
	atomic.AddInt64(&sa.bytesWritten, bytes)
}

func (sa *statsAggregator) addMessage() {
	atomic.AddInt64(&sa.messagesWritten, 1)
}

func (sa *statsAggregator) getAndResetStats() (bytes, messages, connections int64, elapsed time.Duration) {
	sa.mu.Lock()
	defer sa.mu.Unlock()

	now := time.Now()
	if sa.lastLogTime.IsZero() {
		sa.lastLogTime = now
		return 0, 0, 0, 0
	}

	elapsed = now.Sub(sa.lastLogTime)
	bytes = atomic.SwapInt64(&sa.bytesWritten, 0)
	messages = atomic.SwapInt64(&sa.messagesWritten, 0)
	connections = atomic.LoadInt64(&sa.connectionCount)
	sa.lastLogTime = now

	return bytes, messages, connections, elapsed
}

// startStatsLogger starts a goroutine that logs aggregated stats every 5 seconds
func startStatsLogger() {
	statsLoggerOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()

			for range ticker.C {
				// Log Audio stats
				bytes, _, conns, elapsed := globalStatsAudio.getAndResetStats()
				if elapsed > 0 && (bytes > 0 || conns > 0) {
					kbps := float64(bytes) / 1024 / elapsed.Seconds()
					log.Printf("Audio stats: %.1f KB/s (%d connections)", kbps, conns)
				}

				// Log Spectrum stats
				bytes, _, conns, elapsed = globalStatsSpectrum.getAndResetStats()
				if elapsed > 0 && (bytes > 0 || conns > 0) {
					kbps := float64(bytes) / 1024 / elapsed.Seconds()
					log.Printf("Spectrum stats: %.1f KB/s (%d connections)", kbps, conns)
				}
			}
		}()
	})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Disable Gorilla's compression - we'll do it manually
	EnableCompression: false,
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins for now (configure CORS properly in production)
		return true
	},
}

// sessionHolder holds a session reference that can be updated atomically
type sessionHolder struct {
	mu      sync.RWMutex
	session *Session
}

func (sh *sessionHolder) getSession() *Session {
	sh.mu.RLock()
	defer sh.mu.RUnlock()
	return sh.session
}

func (sh *sessionHolder) setSession(s *Session) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.session = s
}

// wsConn wraps a WebSocket connection with a write mutex to prevent concurrent writes
type wsConn struct {
	conn       *websocket.Conn
	writeMu    sync.Mutex
	aggregator *statsAggregator
}

func (wc *wsConn) writeJSON(v interface{}) error {
	wc.writeMu.Lock()
	defer wc.writeMu.Unlock()

	// Marshal to JSON
	jsonData, err := json.Marshal(v)
	if err != nil {
		return err
	}

	// Track bytes for aggregated statistics
	if wc.aggregator != nil {
		wc.aggregator.addBytes(int64(len(jsonData)))
		wc.aggregator.addMessage()
	}

	// Write as text message (uncompressed)
	wc.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return wc.conn.WriteMessage(websocket.TextMessage, jsonData)
}

func (wc *wsConn) writeJSONCompressed(v interface{}) error {
	wc.writeMu.Lock()
	defer wc.writeMu.Unlock()

	// Marshal to JSON first
	jsonData, err := json.Marshal(v)
	if err != nil {
		return err
	}

	// Compress with gzip
	var compressedBuf bytes.Buffer
	gzipWriter := gzip.NewWriter(&compressedBuf)
	if _, err := gzipWriter.Write(jsonData); err != nil {
		return err
	}
	if err := gzipWriter.Close(); err != nil {
		return err
	}
	compressedData := compressedBuf.Bytes()

	// Track compressed bytes for aggregated statistics
	if wc.aggregator != nil {
		wc.aggregator.addBytes(int64(len(compressedData)))
		wc.aggregator.addMessage()
	}

	// Write compressed message as binary
	wc.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return wc.conn.WriteMessage(websocket.BinaryMessage, compressedData)
}

func (wc *wsConn) setWriteDeadline(t time.Time) error {
	wc.writeMu.Lock()
	defer wc.writeMu.Unlock()
	return wc.conn.SetWriteDeadline(t)
}

func (wc *wsConn) readJSON(v interface{}) error {
	return wc.conn.ReadJSON(v)
}

func (wc *wsConn) close() error {
	return wc.conn.Close()
}

// WebSocketHandler handles WebSocket connections
type WebSocketHandler struct {
	sessions      *SessionManager
	audioReceiver *AudioReceiver
	config        *Config
}

// NewWebSocketHandler creates a new WebSocket handler
func NewWebSocketHandler(sessions *SessionManager, audioReceiver *AudioReceiver, config *Config) *WebSocketHandler {
	return &WebSocketHandler{
		sessions:      sessions,
		audioReceiver: audioReceiver,
		config:        config,
	}
}

// ClientMessage represents a message from the client
type ClientMessage struct {
	Type          string `json:"type"`
	Frequency     uint64 `json:"frequency,omitempty"`
	Mode          string `json:"mode,omitempty"`
	BandwidthLow  *int   `json:"bandwidthLow,omitempty"`  // Pointer to distinguish between 0 and not-sent
	BandwidthHigh *int   `json:"bandwidthHigh,omitempty"` // Pointer to distinguish between 0 and not-sent
}

// ServerMessage represents a message to the client
type ServerMessage struct {
	Type        string      `json:"type"`
	Data        string      `json:"data,omitempty"`
	SampleRate  int         `json:"sampleRate,omitempty"`
	Channels    int         `json:"channels,omitempty"`
	Frequency   uint64      `json:"frequency,omitempty"`
	Mode        string      `json:"mode,omitempty"`
	SessionID   string      `json:"sessionId,omitempty"`
	Error       string      `json:"error,omitempty"`
	Info        interface{} `json:"info,omitempty"`
	AudioFormat string      `json:"audioFormat,omitempty"` // "pcm" or "opus"
}

// HandleWebSocket handles WebSocket connections
func (wsh *WebSocketHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP connection to WebSocket
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade connection: %v", err)
		return
	}

	// Wrap connection with write mutex and aggregator
	conn := &wsConn{conn: rawConn, aggregator: globalStatsAudio}
	globalStatsAudio.addConnection()
	defer func() {
		globalStatsAudio.removeConnection()
		conn.close()
	}()

	// Start stats logger if not already running
	startStatsLogger()

	// Get initial parameters from query string
	query := r.URL.Query()
	frequency := uint64(14074000) // Default to 20m FT8
	if freq := query.Get("frequency"); freq != "" {
		var f uint64
		if _, err := fmt.Sscanf(freq, "%d", &f); err == nil {
			// Validate frequency range: 100 kHz to 30 MHz
			const minFreq uint64 = 100000   // 100 kHz
			const maxFreq uint64 = 30000000 // 30 MHz
			if f < minFreq || f > maxFreq {
				log.Printf("Rejected WebSocket connection: frequency %d Hz out of range (100 kHz - 30 MHz)", f)
				wsh.sendError(conn, fmt.Sprintf("Frequency %d Hz is out of valid range (100 kHz - 30 MHz)", f))
				return
			}
			frequency = f
		}
	}

	mode := "usb" // Default mode
	if m := query.Get("mode"); m != "" {
		mode = m
	}

	// Get bandwidth parameters from query string (optional)
	var bandwidthLow, bandwidthHigh *int
	if bwl := query.Get("bandwidthLow"); bwl != "" {
		var val int
		if _, err := fmt.Sscanf(bwl, "%d", &val); err == nil {
			bandwidthLow = &val
		}
	}
	if bwh := query.Get("bandwidthHigh"); bwh != "" {
		var val int
		if _, err := fmt.Sscanf(bwh, "%d", &val); err == nil {
			bandwidthHigh = &val
		}
	}

	// Validate mode - "spectrum" is reserved for the spectrum manager
	if mode == "spectrum" {
		log.Printf("Rejected WebSocket connection: mode 'spectrum' is reserved")
		wsh.sendError(conn, "Mode 'spectrum' is reserved for the spectrum analyzer. Please use a valid audio mode (usb, lsb, am, fm, etc.)")
		return
	}

	// Create initial session
	session, err := wsh.sessions.CreateSession(frequency, mode)
	if err != nil {
		log.Printf("Failed to create session: %v", err)
		wsh.sendError(conn, "Failed to create session: "+err.Error())
		return
	}

	// If bandwidth parameters were provided in URL, update the session immediately
	if bandwidthLow != nil || bandwidthHigh != nil {
		// Use provided values or fall back to session defaults
		bwl := session.BandwidthLow
		bwh := session.BandwidthHigh
		if bandwidthLow != nil {
			bwl = *bandwidthLow
		}
		if bandwidthHigh != nil {
			bwh = *bandwidthHigh
		}
		
		log.Printf("Applying URL bandwidth parameters: %d to %d Hz", bwl, bwh)
		
		// Update session with custom bandwidth
		if err := wsh.sessions.UpdateSessionWithEdges(session.ID, 0, "", bwl, bwh, true); err != nil {
			log.Printf("Failed to apply URL bandwidth: %v", err)
			wsh.sendError(conn, "Failed to apply bandwidth: "+err.Error())
			wsh.sessions.DestroySession(session.ID)
			return
		}
	}

	log.Printf("WebSocket connected: session %s", session.ID)

	// Subscribe to audio
	wsh.audioReceiver.GetChannelAudio(session)

	// Send initial status
	wsh.sendStatus(conn, session)

	// Create a session holder that can be updated atomically
	sessionHolder := &sessionHolder{session: session}

	// Start audio streaming goroutine
	done := make(chan struct{})
	go wsh.streamAudio(conn, sessionHolder, done)

	// Handle incoming messages (this will manage session lifecycle)
	wsh.handleMessages(conn, sessionHolder, done)

	// Cleanup
	currentSession := sessionHolder.getSession()
	wsh.audioReceiver.ReleaseChannelAudio(currentSession)
	wsh.sessions.DestroySession(currentSession.ID)
}

// handleMessages processes incoming WebSocket messages
func (wsh *WebSocketHandler) handleMessages(conn *wsConn, sessionHolder *sessionHolder, done chan struct{}) {
	defer close(done)

	for {
		var msg ClientMessage
		err := conn.readJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		currentSession := sessionHolder.getSession()

		// Update last active time
		wsh.sessions.TouchSession(currentSession.ID)

		// Handle message based on type
		switch msg.Type {
		case "tune":
			// Update the existing channel instead of recreating it
			// This reuses the same SSRC and radiod channel
			// IMPORTANT: Only send parameters that actually changed to avoid triggering preset reload
			newFreq := currentSession.Frequency
			newMode := currentSession.Mode
			newBandwidthLow := currentSession.BandwidthLow
			newBandwidthHigh := currentSession.BandwidthHigh

			if msg.Frequency > 0 {
				// Validate frequency range: 100 kHz to 30 MHz
				const minFreq uint64 = 100000   // 100 kHz
				const maxFreq uint64 = 30000000 // 30 MHz
				if msg.Frequency < minFreq || msg.Frequency > maxFreq {
					wsh.sendError(conn, fmt.Sprintf("Frequency %d Hz is out of valid range (100 kHz - 30 MHz)", msg.Frequency))
					continue // Non-fatal, keep connection open
				}
				newFreq = msg.Frequency
			}
			if msg.Mode != "" {
				// Validate mode - "spectrum" is reserved for the spectrum manager
				if msg.Mode == "spectrum" {
					wsh.sendError(conn, "Mode 'spectrum' is reserved for the spectrum analyzer. Please use a valid audio mode (usb, lsb, am, fm, etc.)")
					continue // Don't close connection, just reject this tune request
				}
				newMode = msg.Mode
			}
			// Accept bandwidth values (can be negative or zero for low edge)
			// Use pointers to distinguish between 0 (valid value) and not-sent (nil)
			if msg.BandwidthLow != nil || msg.BandwidthHigh != nil {
				// At least one bandwidth value was sent
				if msg.BandwidthLow != nil {
					newBandwidthLow = *msg.BandwidthLow
				}
				if msg.BandwidthHigh != nil {
					newBandwidthHigh = *msg.BandwidthHigh
				}
			}

			// Check what actually changed
			freqChanged := newFreq != currentSession.Frequency
			modeChanged := newMode != currentSession.Mode
			bandwidthChanged := newBandwidthLow != currentSession.BandwidthLow || newBandwidthHigh != currentSession.BandwidthHigh

			if freqChanged || modeChanged || bandwidthChanged {
				log.Printf("Updating session: %d Hz %s (BW:%d-%d) -> %d Hz %s (BW:%d-%d)",
					currentSession.Frequency, currentSession.Mode, currentSession.BandwidthLow, currentSession.BandwidthHigh,
					newFreq, newMode, newBandwidthLow, newBandwidthHigh)

				// Validate bandwidth if it changed
				if bandwidthChanged {
					if newBandwidthLow == newBandwidthHigh {
						wsh.sendError(conn, fmt.Sprintf("Invalid bandwidth: low and high edges cannot be the same (%d Hz)", newBandwidthLow))
						continue // Non-fatal, keep connection open
					}
				}

				// Special handling when mode changes:
				// Mode change triggers preset reload in radiod which resets bandwidth
				// So we need to send mode first, then send bandwidth separately with mode-specific defaults
				if modeChanged {
					// Step 1: Send mode change (and frequency if it also changed)
					updateFreq := uint64(0)
					if freqChanged {
						updateFreq = newFreq
					}

					if err := wsh.sessions.UpdateSessionWithEdges(currentSession.ID, updateFreq, newMode, 0, 0, false); err != nil {
						wsh.sendError(conn, "Failed to update mode: "+err.Error())
						continue
					}

					// CRITICAL: Wait for radiod to process mode change and load preset
					// Without this delay, the bandwidth command arrives before preset is loaded
					// 500ms gives radiod enough time to fully process the preset
					time.Sleep(500 * time.Millisecond)

					// Step 2: Send bandwidth values that match frontend defaults for this mode
					// These match the defaults in app.js setMode() function
					var defaultLow, defaultHigh int
					switch newMode {
					case "usb":
						defaultLow = 50
						defaultHigh = 2700
					case "lsb":
						defaultLow = -2700
						defaultHigh = -50
					case "am", "sam":
						defaultLow = -5000
						defaultHigh = 5000
					case "cwu", "cwl":
						defaultLow = -200
						defaultHigh = 200
					case "fm":
						defaultLow = -8000
						defaultHigh = 8000
					case "nfm":
						defaultLow = -6250
						defaultHigh = 6250
					default:
						defaultLow = 50
						defaultHigh = 3000
					}

					// Use custom bandwidth if provided, otherwise use mode defaults
					sendBandwidthLow := defaultLow
					sendBandwidthHigh := defaultHigh
					if bandwidthChanged {
						sendBandwidthLow = newBandwidthLow
						sendBandwidthHigh = newBandwidthHigh
					}

					if err := wsh.sessions.UpdateSessionWithEdges(currentSession.ID, 0, "", sendBandwidthLow, sendBandwidthHigh, true); err != nil {
						wsh.sendError(conn, "Failed to update bandwidth after mode change: "+err.Error())
						continue
					}
				} else {
					// No mode change - send frequency and/or bandwidth changes together
					updateFreq := uint64(0)
					updateBandwidthLow := 0
					updateBandwidthHigh := 0
					sendBandwidth := false

					if freqChanged {
						updateFreq = newFreq
					}
					if bandwidthChanged {
						updateBandwidthLow = newBandwidthLow
						updateBandwidthHigh = newBandwidthHigh
						sendBandwidth = true
					}

					if err := wsh.sessions.UpdateSessionWithEdges(currentSession.ID, updateFreq, "", updateBandwidthLow, updateBandwidthHigh, sendBandwidth); err != nil {
						wsh.sendError(conn, "Failed to update channel: "+err.Error())
						continue
					}
				}

				// Send updated status
				wsh.sendStatus(conn, currentSession)
			}

		case "ping":
			// Keepalive - just touch the session
			wsh.sendMessage(conn, ServerMessage{Type: "pong"})

		case "get_status":
			wsh.sendStatus(conn, currentSession)

		default:
			log.Printf("Unknown message type: %s", msg.Type)
		}
	}
}

// streamAudio streams audio data to the client
func (wsh *WebSocketHandler) streamAudio(conn *wsConn, sessionHolder *sessionHolder, done <-chan struct{}) {
	// Initialize Opus encoder (will be stub if not compiled with opus tag)
	session := sessionHolder.getSession()
	opusEncoder := NewOpusEncoder(wsh.config, session.SampleRate)

	for {
		session := sessionHolder.getSession()

		select {
		case <-done:
			return

		case <-session.Done:
			// Session was destroyed, wait a bit for new session
			time.Sleep(10 * time.Millisecond)
			continue

		case pcmData, ok := <-session.AudioChan:
			if !ok {
				// Channel closed, wait for new session
				time.Sleep(10 * time.Millisecond)
				continue
			}

			// Encode audio (will return PCM if Opus not available/enabled)
			encoded, audioFormat, _ := opusEncoder.Encode(pcmData)

			// Send audio message with format indicator
			msg := ServerMessage{
				Type:        "audio",
				Data:        encoded,
				SampleRate:  session.SampleRate,
				Channels:    1, // Mono
				AudioFormat: audioFormat,
			}

			if err := wsh.sendMessage(conn, msg); err != nil {
				log.Printf("Failed to send audio: %v", err)
				return
			}
		}
	}
}

// sendStatus sends current session status to client
func (wsh *WebSocketHandler) sendStatus(conn *wsConn, session *Session) error {
	msg := ServerMessage{
		Type:       "status",
		SessionID:  session.ID,
		Frequency:  session.Frequency,
		Mode:       session.Mode,
		SampleRate: session.SampleRate,
		Info:       session.GetInfo(),
	}
	return wsh.sendMessage(conn, msg)
}

// sendError sends an error message to the client
func (wsh *WebSocketHandler) sendError(conn *wsConn, errMsg string) error {
	msg := ServerMessage{
		Type:  "error",
		Error: errMsg,
	}
	return wsh.sendMessage(conn, msg)
}

// sendMessage sends a message to the client
func (wsh *WebSocketHandler) sendMessage(conn *wsConn, msg ServerMessage) error {
	conn.setWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.writeJSON(msg)
}
