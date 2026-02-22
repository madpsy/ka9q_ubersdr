package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// UUID validation regex (RFC 4122 compliant)
var uuidRegex = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// isValidUUID checks if a string is a valid UUID v4
func isValidUUID(uuid string) bool {
	if uuid == "" {
		return false
	}
	return uuidRegex.MatchString(uuid)
}

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
				// Get Audio stats
				audioBytes, _, audioConns, audioElapsed := globalStatsAudio.getAndResetStats()
				audioKbps := float64(0)
				if audioElapsed > 0 {
					audioKbps = float64(audioBytes) / 1024 / audioElapsed.Seconds()
				}

				// Get Spectrum stats
				spectrumBytes, _, spectrumConns, spectrumElapsed := globalStatsSpectrum.getAndResetStats()
				spectrumKbps := float64(0)
				if spectrumElapsed > 0 {
					spectrumKbps = float64(spectrumBytes) / 1024 / spectrumElapsed.Seconds()
				}

				// Log combined stats if there's any activity (only if StatsMode is enabled)
				if StatsMode {
					totalConns := audioConns + spectrumConns
					totalKbps := audioKbps + spectrumKbps
					if totalConns > 0 || totalKbps > 0 {
						log.Printf("WebSocket stats - Audio: %.1f KB/s (%d conns), Spectrum: %.1f KB/s (%d conns), Total: %.1f KB/s (%d conns)",
							audioKbps, audioConns, spectrumKbps, spectrumConns, totalKbps, totalConns)
					}
				}
			}
		}()
	})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,  // Increased from 1024 for large messages
	WriteBufferSize: 65536, // Increased from 1024 for large messages (64KB for load_dxcfg)
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
	conn              *websocket.Conn
	writeMu           sync.Mutex
	aggregator        *statsAggregator
	spectrumWriteChan chan []byte   // Buffered channel for non-blocking spectrum writes
	writerDone        chan struct{} // Signal when writer goroutine exits
	writerStarted     bool          // Track if writer goroutine is running
}

// startSpectrumWriter starts a dedicated writer goroutine for spectrum binary packets
// This enables non-blocking writes and prevents slow clients from blocking spectrum distribution
func (wc *wsConn) startSpectrumWriter() {
	if wc.writerStarted {
		return // Already started
	}
	wc.writerStarted = true
	wc.spectrumWriteChan = make(chan []byte, 30) // Buffer 30 frames (3 seconds at 10 Hz)
	wc.writerDone = make(chan struct{})

	go func() {
		defer close(wc.writerDone)

		for packet := range wc.spectrumWriteChan {
			// This goroutine owns the WebSocket write for spectrum packets
			wc.writeMu.Lock()
			wc.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			err := wc.conn.WriteMessage(websocket.BinaryMessage, packet)
			wc.writeMu.Unlock()

			if err != nil {
				// Connection error - exit writer goroutine
				// The connection will be closed by the main handler
				return
			}

			// Track bytes for statistics
			if wc.aggregator != nil {
				wc.aggregator.addBytes(int64(len(packet)))
				wc.aggregator.addMessage()
			}
		}
	}()
}

// writeSpectrumBinary sends a spectrum binary packet via the buffered channel
// Returns true if packet was queued, false if dropped (channel full)
func (wc *wsConn) writeSpectrumBinary(packet []byte) bool {
	if wc.spectrumWriteChan == nil {
		return false // Writer not started
	}

	// Non-blocking send
	select {
	case wc.spectrumWriteChan <- packet:
		return true // Packet queued successfully
	default:
		return false // Channel full - packet dropped
	}
}

// closeSpectrumWriter closes the spectrum write channel and waits for writer to exit
func (wc *wsConn) closeSpectrumWriter() {
	if wc.spectrumWriteChan != nil {
		close(wc.spectrumWriteChan)
		<-wc.writerDone // Wait for writer goroutine to exit
	}
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
	sessions           *SessionManager
	audioReceiver      *AudioReceiver
	config             *Config
	ipBanManager       *IPBanManager
	rateLimiterManager *RateLimiterManager
	connRateLimiter    *IPConnectionRateLimiter
	prometheusMetrics  *PrometheusMetrics
}

// NewWebSocketHandler creates a new WebSocket handler
func NewWebSocketHandler(sessions *SessionManager, audioReceiver *AudioReceiver, config *Config, ipBanManager *IPBanManager, rateLimiterManager *RateLimiterManager, connRateLimiter *IPConnectionRateLimiter, prometheusMetrics *PrometheusMetrics) *WebSocketHandler {
	return &WebSocketHandler{
		sessions:           sessions,
		audioReceiver:      audioReceiver,
		config:             config,
		ipBanManager:       ipBanManager,
		rateLimiterManager: rateLimiterManager,
		connRateLimiter:    connRateLimiter,
		prometheusMetrics:  prometheusMetrics,
	}
}

// ClientMessage represents a message from the client
type ClientMessage struct {
	Type          string   `json:"type"`
	Frequency     uint64   `json:"frequency,omitempty"`
	Mode          string   `json:"mode,omitempty"`
	BandwidthLow  *int     `json:"bandwidthLow,omitempty"`  // Pointer to distinguish between 0 and not-sent
	BandwidthHigh *int     `json:"bandwidthHigh,omitempty"` // Pointer to distinguish between 0 and not-sent
	SquelchOpen   *float32 `json:"squelchOpen,omitempty"`   // Squelch open threshold in dB SNR (nil = no change, -999 = always open)
	SquelchClose  *float32 `json:"squelchClose,omitempty"`  // Squelch close threshold in dB SNR (nil = no change)
}

// ServerMessage represents a message to the client
type ServerMessage struct {
	Type        string      `json:"type"`
	Data        string      `json:"data,omitempty"`
	SampleRate  int         `json:"sampleRate,omitempty"`
	Channels    int         `json:"channels,omitempty"`
	Frequency   uint64      `json:"frequency,omitempty"`
	Mode        string      `json:"mode,omitempty"`
	Timestamp   int64       `json:"timestamp,omitempty"`   // RTP timestamp (uint32 sample count) for drift-free tracking
	WallclockMs int64       `json:"wallclockMs,omitempty"` // NTP-synced wall-clock time in milliseconds for multi-server alignment
	SessionID   string      `json:"sessionId,omitempty"`
	Error       string      `json:"error,omitempty"`
	Status      int         `json:"status,omitempty"` // HTTP-style status code (e.g., 429 for rate limit)
	Info        interface{} `json:"info,omitempty"`
	AudioFormat string      `json:"audioFormat,omitempty"` // "pcm" or "opus"
}

// HandleWebSocket handles WebSocket connections
func (wsh *WebSocketHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Use centralized IP detection function (same as /connection endpoint)
	clientIP := getClientIP(r)

	// Also get raw source IP for logging
	sourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = host
	}

	log.Printf("Audio WebSocket: sourceIP=%s, clientIP=%s (via getClientIP)", sourceIP, clientIP)

	// Check if IP is banned
	if wsh.ipBanManager.IsBanned(clientIP) {
		log.Printf("Rejected WebSocket connection from banned IP: %s (client IP: %s)", sourceIP, clientIP)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Get password from query string (optional)
	query := r.URL.Query()
	password := query.Get("password")

	// Get protocol version from query string (optional, default v1)
	version := 1
	if v := query.Get("version"); v != "" {
		var parsedVer int
		if _, err := fmt.Sscanf(v, "%d", &parsedVer); err == nil && parsedVer >= 1 && parsedVer <= 2 {
			version = parsedVer
		}
	}

	// Get format from query string (optional): "pcm-zstd" (default) or "opus"
	format := query.Get("format")
	if format == "" {
		format = "pcm-zstd" // Default to PCM with zstd compression
	}

	// Validate format
	validFormats := map[string]bool{
		"opus":     true, // Binary Opus codec (lossy, bandwidth-efficient)
		"pcm-zstd": true, // Binary PCM with zstd compression (lossless, compressed)
	}
	if !validFormats[format] {
		log.Printf("Rejected WebSocket connection: invalid format '%s' from %s (client IP: %s)", format, sourceIP, clientIP)
		http.Error(w, fmt.Sprintf("Invalid format '%s'. Valid formats: opus, pcm-zstd", format), http.StatusBadRequest)
		return
	}

	// Check connection rate limit (unless IP is bypassed via IP list or password)
	if !wsh.config.Server.IsIPTimeoutBypassed(clientIP, password) && !wsh.connRateLimiter.AllowConnection(clientIP) {
		log.Printf("Connection rate limit exceeded for IP: %s (client IP: %s)", sourceIP, clientIP)
		http.Error(w, "Too Many Requests - Connection rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	// Upgrade HTTP connection to WebSocket
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade connection: %v", err)
		return
	}

	// Wrap connection with write mutex and aggregator
	conn := &wsConn{conn: rawConn, aggregator: globalStatsAudio}
	globalStatsAudio.addConnection()

	// Record WebSocket connection in Prometheus
	if wsh.prometheusMetrics != nil {
		wsh.prometheusMetrics.RecordWSConnection("audio")
	}

	defer func() {
		globalStatsAudio.removeConnection()

		// Record WebSocket disconnection in Prometheus
		if wsh.prometheusMetrics != nil {
			wsh.prometheusMetrics.RecordWSDisconnect("audio")
		}

		conn.close()
	}()

	// Start stats logger if not already running
	startStatsLogger()

	// Get initial parameters from query string (query already extracted above for password)
	frequency := uint64(14074000) // Default to 20m FT8
	if freq := query.Get("frequency"); freq != "" {
		var f uint64
		if _, err := fmt.Sscanf(freq, "%d", &f); err == nil {
			// Validate frequency range: 10 kHz to 30 MHz
			const minFreq uint64 = 10000    // 10 kHz
			const maxFreq uint64 = 30000000 // 30 MHz
			if f < minFreq || f > maxFreq {
				log.Printf("Rejected WebSocket connection: frequency %d Hz out of range (10 kHz - 30 MHz)", f)
				wsh.sendError(conn, fmt.Sprintf("Frequency %d Hz is out of valid range (10 kHz - 30 MHz)", f))
				return
			}
			frequency = f
		}
	}

	mode := "usb" // Default mode
	if m := query.Get("mode"); m != "" {
		// Validate mode against whitelist
		validModes := map[string]bool{
			"usb": true, "lsb": true, "am": true, "sam": true,
			"fm": true, "nfm": true, "cwu": true, "cwl": true, "iq": true,
		}
		// Wide IQ modes only allowed for bypassed IPs
		wideIQModes := map[string]bool{
			"iq48": true, "iq96": true, "iq192": true, "iq384": true,
		}

		if !validModes[m] && !wideIQModes[m] {
			log.Printf("Rejected WebSocket connection: invalid mode '%s' from %s (client IP: %s)", m, sourceIP, clientIP)
			wsh.sendError(conn, fmt.Sprintf("Invalid mode '%s'. Valid modes: usb, lsb, am, sam, fm, nfm, cwu, cwl, iq", m))
			return
		}

		// Check if wide IQ mode requires bypass (via IP list or password)
		// Unless the mode is configured as public
		isPublic := wsh.config.Server.PublicIQModes[m]
		isBypassed := wsh.config.Server.IsIPTimeoutBypassed(clientIP, password)
		isInstanceReporter := wsh.config.InstanceReporting.IsInstanceReporter(clientIP)

		// Allow instance reporter IPs to access IQ48 mode specifically
		if m == "iq48" && isInstanceReporter {
			// Instance reporter can always access IQ48
			log.Printf("Allowed IQ48 mode for instance reporter IP: %s", clientIP)
		} else if wideIQModes[m] && !isPublic && !isBypassed {
			log.Printf("Rejected WebSocket connection: wide IQ mode '%s' requires bypass from %s (client IP: %s)", m, sourceIP, clientIP)
			wsh.sendError(conn, fmt.Sprintf("Mode '%s' is only available for authorized IPs or with valid password", m))
			return
		}

		mode = m
	}

	// Get user session ID from query string (required)
	userSessionID := query.Get("user_session_id")

	// Validate user session ID - must be a valid UUID
	if !isValidUUID(userSessionID) {
		log.Printf("Rejected WebSocket connection: invalid or missing user_session_id from %s (client IP: %s)", sourceIP, clientIP)
		if err := wsh.sendError(conn, "Invalid or missing user_session_id. Please refresh the page."); err != nil {
			log.Printf("Failed to send error message: %v", err)
		}
		return
	}

	// Check if this UUID has been kicked
	if wsh.sessions.IsUUIDKicked(userSessionID) {
		log.Printf("Rejected WebSocket connection: kicked user_session_id %s from %s (client IP: %s)", userSessionID, sourceIP, clientIP)
		if err := wsh.sendError(conn, "Your session has been terminated. Please refresh the page."); err != nil {
			log.Printf("Failed to send error message: %v", err)
		}
		return
	}

	// Check if User-Agent mapping exists (ensures /connection was called first)
	if wsh.sessions.GetUserAgent(userSessionID) == "" {
		if err := wsh.sendError(conn, "Invalid session. Please refresh the page and try again."); err != nil {
			log.Printf("Failed to send error message: %v", err)
		}
		return
	}

	// Check if IP matches the bound IP (ensures UUID is used from same IP as /connection)
	// Only enforce if configured to do so
	if wsh.config.Server.EnforceSessionIPMatch {
		boundIP := wsh.sessions.GetUUIDIP(userSessionID)
		if boundIP != "" && boundIP != clientIP {
			log.Printf("Rejected Audio WebSocket: IP mismatch for user_session_id %s (bound: %s, actual: %s, source: %s)", userSessionID, boundIP, clientIP, sourceIP)
			if err := wsh.sendError(conn, "Session IP mismatch. Please refresh the page and try again."); err != nil {
				log.Printf("Failed to send error message: %v", err)
			}
			return
		}
		log.Printf("Audio WebSocket: UUID %s IP binding validated (bound: %s, actual: %s) ✓", userSessionID, boundIP, clientIP)
	} else {
		log.Printf("Audio WebSocket: UUID %s IP binding check skipped (enforce_session_ip_match=false)", userSessionID)
	}

	// Get bandwidth parameters from query string (optional)
	// Wide IQ modes should not have bandwidth parameters - they use preset values
	wideIQModes := map[string]bool{
		"iq48": true, "iq96": true, "iq192": true, "iq384": true,
	}

	var bandwidthLow, bandwidthHigh *int
	const maxBandwidth = 8000 // Maximum bandwidth limit in Hz (bypassed IPs/passwords exempt)
	isBypassed := wsh.config.Server.IsIPTimeoutBypassed(clientIP, password)

	// Only process bandwidth parameters for non-wide IQ modes
	if !wideIQModes[mode] {
		if bwl := query.Get("bandwidthLow"); bwl != "" {
			var val int
			if _, err := fmt.Sscanf(bwl, "%d", &val); err == nil {
				// Validate bandwidth range: -8000 to +8000 Hz (unless IP is bypassed)
				if !isBypassed && (val < -maxBandwidth || val > maxBandwidth) {
					log.Printf("Rejected WebSocket connection: bandwidthLow %d Hz out of range (±%d Hz) from %s (client IP: %s)", val, maxBandwidth, sourceIP, clientIP)
					wsh.sendError(conn, fmt.Sprintf("Bandwidth low %d Hz is out of valid range (±%d Hz)", val, maxBandwidth))
					return
				}
				bandwidthLow = &val
			}
		}
		if bwh := query.Get("bandwidthHigh"); bwh != "" {
			var val int
			if _, err := fmt.Sscanf(bwh, "%d", &val); err == nil {
				// Validate bandwidth range: -8000 to +8000 Hz (unless IP is bypassed)
				if !isBypassed && (val < -maxBandwidth || val > maxBandwidth) {
					log.Printf("Rejected WebSocket connection: bandwidthHigh %d Hz out of range (±%d Hz) from %s (client IP: %s)", val, maxBandwidth, sourceIP, clientIP)
					wsh.sendError(conn, fmt.Sprintf("Bandwidth high %d Hz is out of valid range (±%d Hz)", val, maxBandwidth))
					return
				}
				bandwidthHigh = &val
			}
		}
	} else {
		// Wide IQ mode - ignore any bandwidth parameters from client
		log.Printf("WIDEIQ_IGNORE_URL_BW: mode=%s", mode)
	}

	// Validate mode - "spectrum" is reserved for the spectrum manager
	if mode == "spectrum" {
		log.Printf("Rejected WebSocket connection: mode 'spectrum' is reserved")
		wsh.sendError(conn, "Mode 'spectrum' is reserved for the spectrum analyzer. Please use a valid audio mode (usb, lsb, am, fm, etc.)")
		return
	}

	// Create initial session with IP tracking, user session ID, and bypass password
	session, err := wsh.sessions.CreateSessionWithBandwidthAndPassword(frequency, mode, 3000, sourceIP, clientIP, userSessionID, password)
	if err != nil {
		log.Printf("Failed to create session: %v", err)

		// Record session creation error in Prometheus
		if wsh.prometheusMetrics != nil {
			wsh.prometheusMetrics.RecordSessionCreationError()
		}

		if sendErr := wsh.sendError(conn, err.Error()); sendErr != nil {
			log.Printf("Failed to send error message: %v", sendErr)
		}
		// Give client time to receive the error message before closing
		time.Sleep(100 * time.Millisecond)
		return
	}

	// Password is already stored in session during creation

	// Store WebSocket connection reference in session for kick functionality
	session.WSConn = conn

	// Apply bandwidth parameters (either from URL or mode-specific defaults)
	// Wide IQ modes (iq48, iq96, iq192, iq384) should use their preset bandwidth values
	// Note: wideIQModes is already defined earlier in this function

	if !wideIQModes[mode] {
		// Not a wide IQ mode - apply bandwidth settings
		var bwl, bwh int
		if bandwidthLow != nil && bandwidthHigh != nil {
			// Both bandwidth parameters provided in URL - use them
			bwl = *bandwidthLow
			bwh = *bandwidthHigh

		} else {
			// No bandwidth parameters in URL - apply mode-specific defaults
			// These match the defaults in app.js setMode() function
			switch mode {
			case "usb":
				bwl = 50
				bwh = 2700
			case "lsb":
				bwl = -2700
				bwh = -50
			case "am", "sam":
				bwl = -5000
				bwh = 5000
			case "cwu", "cwl":
				bwl = -200
				bwh = 200
			case "fm":
				bwl = -8000
				bwh = 8000
			case "nfm":
				bwl = -5000
				bwh = 5000
			case "iq":
				bwl = -5000
				bwh = 5000
			default:
				bwl = 50
				bwh = 3000
			}
			log.Printf("Applying mode-specific bandwidth defaults for %s: %d to %d Hz", mode, bwl, bwh)
		}

		// Update session with bandwidth
		if err := wsh.sessions.UpdateSessionWithEdges(session.ID, 0, "", bwl, bwh, true); err != nil {
			log.Printf("Failed to apply bandwidth: %v", err)
			wsh.sendError(conn, "Failed to apply bandwidth: "+err.Error())
			wsh.sessions.DestroySession(session.ID)
			return
		}
	} else {
		// Wide IQ mode - use preset bandwidth values, don't override
		log.Printf("WIDEIQ_SKIP_BANDWIDTH: mode=%s session=%s", mode, session.ID)
	}

	// Subscribe to audio
	wsh.audioReceiver.GetChannelAudio(session)

	// Note: Binary formats don't need initial status message

	// Create a session holder that can be updated atomically
	sessionHolder := &sessionHolder{session: session}

	// Start audio streaming goroutine
	done := make(chan struct{})
	go wsh.streamAudio(conn, sessionHolder, done, format, version)

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

		// Record message received in Prometheus
		if wsh.prometheusMetrics != nil {
			wsh.prometheusMetrics.RecordWSMessageReceived("audio")
		}

		currentSession := sessionHolder.getSession()

		// Update last active time
		wsh.sessions.TouchSession(currentSession.ID)

		// Check rate limit for this UUID (skip ping messages)
		if msg.Type != "ping" && !wsh.rateLimiterManager.AllowAudio(currentSession.UserSessionID) {
			// Record rate limit error in Prometheus
			if wsh.prometheusMetrics != nil {
				wsh.prometheusMetrics.RecordRateLimitError("audio")
			}

			wsh.sendErrorWithStatus(conn, "Rate limit exceeded. Please slow down.", 429)
			continue // Don't close connection, just reject this command
		}

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
				// Validate frequency range: 10 kHz to 30 MHz
				const minFreq uint64 = 10000    // 10 kHz
				const maxFreq uint64 = 30000000 // 30 MHz
				if msg.Frequency < minFreq || msg.Frequency > maxFreq {
					wsh.sendError(conn, fmt.Sprintf("Frequency %d Hz is out of valid range (10 kHz - 30 MHz)", msg.Frequency))
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
				// Validate mode against whitelist
				validModes := map[string]bool{
					"usb": true, "lsb": true, "am": true, "sam": true,
					"fm": true, "nfm": true, "cwu": true, "cwl": true, "iq": true,
				}
				// Wide IQ modes only allowed for bypassed IPs
				wideIQModes := map[string]bool{
					"iq48": true, "iq96": true, "iq192": true, "iq384": true,
				}

				if !validModes[msg.Mode] && !wideIQModes[msg.Mode] {
					wsh.sendError(conn, fmt.Sprintf("Invalid mode '%s'. Valid modes: usb, lsb, am, sam, fm, nfm, cwu, cwl, iq", msg.Mode))
					continue // Don't close connection, just reject this tune request
				}

				// Check if wide IQ mode requires bypass (via IP list or password)
				// Unless the mode is configured as public
				// Note: password is stored in session during creation
				isPublicMode := wsh.config.Server.PublicIQModes[msg.Mode]
				isBypassed := wsh.config.Server.IsIPTimeoutBypassed(currentSession.ClientIP, currentSession.BypassPassword)
				isInstanceReporter := wsh.config.InstanceReporting.IsInstanceReporter(currentSession.ClientIP)

				// Allow instance reporter IPs to access IQ48 mode specifically
				if msg.Mode == "iq48" && isInstanceReporter {
					// Instance reporter can always access IQ48
					log.Printf("Allowed IQ48 mode change for instance reporter IP: %s", currentSession.ClientIP)
				} else if wideIQModes[msg.Mode] && !isPublicMode && !isBypassed {
					wsh.sendError(conn, fmt.Sprintf("Mode '%s' is only available for authorized IPs or with valid password", msg.Mode))
					continue // Don't close connection, just reject this tune request
				}

				newMode = msg.Mode
			}
			// Accept bandwidth values (can be negative or zero for low edge)
			// Use pointers to distinguish between 0 (valid value) and not-sent (nil)
			// Wide IQ modes should not accept bandwidth changes
			wideIQModesForTune := map[string]bool{
				"iq48": true, "iq96": true, "iq192": true, "iq384": true,
			}

			if msg.BandwidthLow != nil || msg.BandwidthHigh != nil {
				// Reject bandwidth changes for wide IQ modes
				if wideIQModesForTune[newMode] {
					wsh.sendError(conn, fmt.Sprintf("Bandwidth changes are not allowed for mode '%s' - preset bandwidth will be used", newMode))
					continue // Don't close connection, just reject this tune request
				}

				// At least one bandwidth value was sent
				const maxBandwidth = 8000 // Maximum bandwidth limit in Hz (bypassed IPs/passwords exempt)
				isBypassed := wsh.config.Server.IsIPTimeoutBypassed(currentSession.ClientIP, currentSession.BypassPassword)
				if msg.BandwidthLow != nil {
					// Validate bandwidth range: -8000 to +8000 Hz (unless IP is bypassed)
					if !isBypassed && (*msg.BandwidthLow < -maxBandwidth || *msg.BandwidthLow > maxBandwidth) {
						wsh.sendError(conn, fmt.Sprintf("Bandwidth low %d Hz is out of valid range (±%d Hz)", *msg.BandwidthLow, maxBandwidth))
						continue // Don't close connection, just reject this tune request
					}
					newBandwidthLow = *msg.BandwidthLow
				}
				if msg.BandwidthHigh != nil {
					// Validate bandwidth range: -8000 to +8000 Hz (unless IP is bypassed)
					if !isBypassed && (*msg.BandwidthHigh < -maxBandwidth || *msg.BandwidthHigh > maxBandwidth) {
						wsh.sendError(conn, fmt.Sprintf("Bandwidth high %d Hz is out of valid range (±%d Hz)", *msg.BandwidthHigh, maxBandwidth))
						continue // Don't close connection, just reject this tune request
					}
					newBandwidthHigh = *msg.BandwidthHigh
				}
			}

			// Check what actually changed
			freqChanged := newFreq != currentSession.Frequency
			modeChanged := newMode != currentSession.Mode
			bandwidthChanged := newBandwidthLow != currentSession.BandwidthLow || newBandwidthHigh != currentSession.BandwidthHigh

			if freqChanged || modeChanged || bandwidthChanged {
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
					// Wide IQ modes (iq48, iq96, iq192, iq384) should use their preset bandwidth values
					// Define wideIQModes for this scope
					wideIQModesForModeChange := map[string]bool{
						"iq48": true, "iq96": true, "iq192": true, "iq384": true,
					}

					if !wideIQModesForModeChange[newMode] {
						// Not a wide IQ mode - apply bandwidth settings
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
							defaultLow = -5000
							defaultHigh = 5000
						case "iq":
							defaultLow = -5000
							defaultHigh = 5000
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
						// Wide IQ mode - use preset bandwidth values, don't override
						log.Printf("Using preset bandwidth for wide IQ mode after mode change: %s", newMode)
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

		case "set_squelch":
			// Update squelch thresholds
			// Special value: squelchOpen=-999 sets "always open" mode
			if msg.SquelchOpen == nil {
				wsh.sendError(conn, "squelchOpen parameter is required")
				continue
			}

			// Determine squelchClose value
			// If -999 (always open), squelchClose is ignored (will be set to -999 by radiod.go)
			// Otherwise, use provided value or default to squelchOpen - 2.0 for hysteresis
			squelchClose := *msg.SquelchOpen - 2.0
			if msg.SquelchClose != nil {
				squelchClose = *msg.SquelchClose
			}

			// Validate squelch values (unless -999 for always open)
			if *msg.SquelchOpen != -999 {
				// Normal squelch validation
				if *msg.SquelchOpen < -50 || *msg.SquelchOpen > 50 {
					wsh.sendError(conn, fmt.Sprintf("squelchOpen %.1f dB is out of valid range (-50 to +50 dB)", *msg.SquelchOpen))
					continue
				}
				if squelchClose < -50 || squelchClose > 50 {
					wsh.sendError(conn, fmt.Sprintf("squelchClose %.1f dB is out of valid range (-50 to +50 dB)", squelchClose))
					continue
				}
				if squelchClose >= *msg.SquelchOpen {
					wsh.sendError(conn, fmt.Sprintf("squelchClose (%.1f dB) must be less than squelchOpen (%.1f dB) for hysteresis", squelchClose, *msg.SquelchOpen))
					continue
				}
			}

			// Update squelch via session manager
			if err := wsh.sessions.UpdateSquelch(currentSession.ID, *msg.SquelchOpen, squelchClose); err != nil {
				wsh.sendError(conn, "Failed to update squelch: "+err.Error())
				continue
			}

			// Send success response
			if *msg.SquelchOpen == -999 {
				log.Printf("Squelch set to always open for session %s", currentSession.ID)
				wsh.sendMessage(conn, ServerMessage{Type: "squelch_updated", Info: map[string]interface{}{
					"mode": "always_open",
				}})
			} else {
				log.Printf("Squelch updated for session %s: open=%.1f dB, close=%.1f dB", currentSession.ID, *msg.SquelchOpen, squelchClose)
				wsh.sendMessage(conn, ServerMessage{Type: "squelch_updated", Info: map[string]interface{}{
					"squelchOpen":  *msg.SquelchOpen,
					"squelchClose": squelchClose,
				}})
			}

		default:
			log.Printf("Unknown message type: %s", msg.Type)
		}
	}
}

// streamAudio streams audio data to the client
func (wsh *WebSocketHandler) streamAudio(conn *wsConn, sessionHolder *sessionHolder, done <-chan struct{}, format string, version int) {
	session := sessionHolder.getSession()

	// Track original format requested (for re-enabling after IQ mode)
	originalFormat := format

	// Initialize encoders based on format
	var opusEncoder *OpusEncoderWrapper
	var pcmBinaryEncoder *PCMBinaryEncoder

	if format == "opus" {
		// Create Opus encoder with config settings
		bitrate := wsh.config.Audio.Opus.Bitrate
		if bitrate == 0 {
			bitrate = 24000 // Default 24 kbps for good quality
		}
		complexity := wsh.config.Audio.Opus.Complexity
		if complexity == 0 {
			complexity = 5 // Default medium complexity
		}

		var err error
		opusEncoder, err = NewOpusEncoderForClient(session.SampleRate, bitrate, complexity)
		if err != nil {
			log.Printf("Failed to create Opus encoder: %v", err)
			log.Printf("Falling back to pcm-zstd")
			format = "pcm-zstd" // Fall back to pcm-zstd
		}
	}

	if format == "pcm-zstd" {
		// Create PCM binary encoder with zstd compression and appropriate version
		if version >= 2 {
			pcmBinaryEncoder = NewPCMBinaryEncoderWithVersion(true, PCMBinaryVersion2)
			log.Printf("PCM binary encoder initialized with zstd compression (version 2)")
		} else {
			pcmBinaryEncoder = NewPCMBinaryEncoder(true)
			log.Printf("PCM binary encoder initialized with zstd compression (version 1)")
		}
		defer pcmBinaryEncoder.Close()
	}

	// Signal quality update ticker for sending silence packets when squelch is closed
	// This ensures clients continue to receive signal quality data even when no audio is present
	signalUpdateTicker := time.NewTicker(100 * time.Millisecond) // 10 Hz updates
	defer signalUpdateTicker.Stop()
	lastAudioTime := time.Now()

	for {
		session := sessionHolder.getSession()

		select {
		case <-done:
			return

		case <-session.Done:
			// Session was destroyed, wait a bit for new session
			time.Sleep(10 * time.Millisecond)
			continue

		case <-signalUpdateTicker.C:
			// If no audio received recently (squelch closed), send silence with signal quality
			// Only do this for version 2 clients who expect signal quality data
			timeSinceAudio := time.Since(lastAudioTime)

			if DebugMode && timeSinceAudio > 200*time.Millisecond {
				log.Printf("DEBUG: Silence check - version: %d, timeSinceAudio: %v, SSRC: 0x%08x",
					version, timeSinceAudio, session.SSRC)
			}

			if version >= 2 && timeSinceAudio > 200*time.Millisecond {
				// Get current signal quality from radiod
				var basebandPower, noiseDensity float32 = -999.0, -999.0
				if wsh.sessions != nil && wsh.sessions.radiod != nil {
					channelStatus := wsh.sessions.radiod.GetChannelStatus(session.SSRC)
					if channelStatus != nil {
						basebandPower = channelStatus.BasebandPower
						noiseDensity = channelStatus.NoiseDensity

						// Apply spectrum gain adjustments to match visual display
						gainAdjustment := float32(wsh.config.Spectrum.GainDB)

						// Apply frequency-specific gain if configured
						if len(wsh.config.Spectrum.GainDBFrequencyRanges) > 0 {
							session.mu.RLock()
							tunedFreq := session.Frequency
							session.mu.RUnlock()

							for _, freqRange := range wsh.config.Spectrum.GainDBFrequencyRanges {
								if tunedFreq >= freqRange.StartFreq && tunedFreq <= freqRange.EndFreq {
									gainAdjustment += float32(freqRange.GainDB)
									break
								}
							}
						}

						basebandPower += gainAdjustment
						noiseDensity += gainAdjustment

						if DebugMode {
							log.Printf("DEBUG: Sending silence packet - SSRC: 0x%08x, timeSinceAudio: %v, basebandPower: %.1f dBFS, noiseDensity: %.1f dBFS",
								session.SSRC, timeSinceAudio, basebandPower, noiseDensity)
						}
					} else if DebugMode {
						log.Printf("DEBUG: No channel status available for SSRC: 0x%08x", session.SSRC)
					}
				} else if DebugMode {
					log.Printf("DEBUG: Sessions or radiod is nil - sessions: %v, radiod: %v",
						wsh.sessions != nil, wsh.sessions != nil && wsh.sessions.radiod != nil)
				}

				// Determine format to use (handle IQ mode fallback)
				isIQMode := session.Mode == "iq" || session.Mode == "iq48" || session.Mode == "iq96" || session.Mode == "iq192" || session.Mode == "iq384"
				currentFormat := format
				if isIQMode && originalFormat == "opus" {
					currentFormat = "pcm-zstd"
				}
				if currentFormat == "opus" && opusEncoder == nil {
					currentFormat = "pcm-zstd"
				}

				// Send silence packet with signal quality data
				switch currentFormat {
				case "opus":
					if opusEncoder != nil {
						// Create silence samples (100ms worth)
						silenceDuration := session.SampleRate / 10        // 100ms
						silenceSamples := make([]byte, silenceDuration*2) // 16-bit samples = 2 bytes each

						opusData, err := opusEncoder.EncodeBinary(silenceSamples)
						if err != nil {
							continue // Skip this update on error
						}

						// Build version 2 packet with signal quality
						packet := make([]byte, 21+len(opusData))
						binary.LittleEndian.PutUint64(packet[0:8], uint64(time.Now().UnixNano()))
						binary.LittleEndian.PutUint32(packet[8:12], uint32(session.SampleRate))
						packet[12] = byte(session.Channels)
						binary.LittleEndian.PutUint32(packet[13:17], math.Float32bits(basebandPower))
						binary.LittleEndian.PutUint32(packet[17:21], math.Float32bits(noiseDensity))
						copy(packet[21:], opusData)

						conn.writeMu.Lock()
						conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
						err = conn.conn.WriteMessage(websocket.BinaryMessage, packet)
						conn.writeMu.Unlock()

						if err != nil {
							log.Printf("Failed to send silence Opus packet: %v", err)
							return
						}

						// Track bytes sent
						session.AddAudioBytes(uint64(len(packet)))
						if conn.aggregator != nil {
							conn.aggregator.addBytes(int64(len(packet)))
							conn.aggregator.addMessage()
						}
						if wsh.prometheusMetrics != nil {
							wsh.prometheusMetrics.RecordAudioBytes(len(packet))
							wsh.prometheusMetrics.RecordWSMessageSent("audio")
						}
					}

				case "pcm-zstd":
					if pcmBinaryEncoder != nil {
						// Create silence samples (100ms worth)
						silenceDuration := session.SampleRate / 10        // 100ms
						silenceSamples := make([]byte, silenceDuration*2) // 16-bit samples = 2 bytes each (zeros)

						packet, err := pcmBinaryEncoder.EncodePCMPacketWithSignalQuality(
							silenceSamples,
							time.Now().UnixNano(),
							session.SampleRate,
							session.Channels,
							basebandPower,
							noiseDensity,
						)
						if err != nil {
							continue // Skip this update on error
						}

						conn.writeMu.Lock()
						conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
						err = conn.conn.WriteMessage(websocket.BinaryMessage, packet)
						conn.writeMu.Unlock()

						if err != nil {
							log.Printf("Failed to send silence PCM packet: %v", err)
							return
						}

						// Track bytes sent
						session.AddAudioBytes(uint64(len(packet)))
						if conn.aggregator != nil {
							conn.aggregator.addBytes(int64(len(packet)))
							conn.aggregator.addMessage()
						}
						if wsh.prometheusMetrics != nil {
							wsh.prometheusMetrics.RecordAudioBytes(len(packet))
							wsh.prometheusMetrics.RecordWSMessageSent("audio")
						}
					}
				}
			}

		case audioPacket, ok := <-session.AudioChan:
			if !ok {
				// Channel closed, wait for new session
				time.Sleep(10 * time.Millisecond)
				continue
			}

			// Track when we receive real audio (to know when squelch is open)
			lastAudioTime = time.Now()

			// Check if current mode is IQ - IQ modes should never use lossy compression (need lossless data)
			isIQMode := session.Mode == "iq" || session.Mode == "iq48" || session.Mode == "iq96" || session.Mode == "iq192" || session.Mode == "iq384"

			// Determine which format to use for this packet
			// If in IQ mode, fall back to lossless pcm-zstd
			currentFormat := format
			if isIQMode && originalFormat == "opus" {
				// IQ mode requires lossless - fall back to pcm-zstd
				currentFormat = "pcm-zstd"
			}

			// Route to appropriate encoder based on format
			// Handle Opus encoder fallback to pcm-zstd if not available
			if currentFormat == "opus" && opusEncoder == nil {
				log.Printf("Opus encoder not available, falling back to pcm-zstd")
				currentFormat = "pcm-zstd"
			}

			switch currentFormat {
			case "opus":
				// Binary Opus format: send raw Opus frames as binary WebSocket messages
				// Version 1: [timestamp:8][sampleRate:4][channels:1][opusData...]
				// Version 2: [timestamp:8][sampleRate:4][channels:1][basebandPower:4][noiseDensity:4][opusData...]

				// Get channel status for signal quality metrics (version 2 only)
				var basebandPower, noiseDensity float32 = -999.0, -999.0 // Default: no data
				if version >= 2 && wsh.sessions != nil && wsh.sessions.radiod != nil {
					if channelStatus := wsh.sessions.radiod.GetChannelStatus(session.SSRC); channelStatus != nil {
						basebandPower = channelStatus.BasebandPower
						noiseDensity = channelStatus.NoiseDensity

						// Apply spectrum gain adjustments to match visual display
						// This ensures signal quality values match what users see in the spectrum
						gainAdjustment := float32(wsh.config.Spectrum.GainDB)

						// Apply frequency-specific gain if configured
						if len(wsh.config.Spectrum.GainDBFrequencyRanges) > 0 {
							session.mu.RLock()
							tunedFreq := session.Frequency
							session.mu.RUnlock()

							// Find matching frequency range and apply its gain
							for _, freqRange := range wsh.config.Spectrum.GainDBFrequencyRanges {
								if tunedFreq >= freqRange.StartFreq && tunedFreq <= freqRange.EndFreq {
									// Apply frequency-specific gain (added to master gain)
									gainAdjustment += float32(freqRange.GainDB)
									break
								}
							}
						}

						// Apply total gain adjustment to both values
						basebandPower += gainAdjustment
						noiseDensity += gainAdjustment
					}
				}

				opusData, err := opusEncoder.EncodeBinary(audioPacket.PCMData)
				if err != nil {
					log.Printf("Opus encoding error: %v", err)
					continue
				}

				// Build binary packet with version-specific header
				var packet []byte
				if version >= 2 {
					// Version 2: include signal quality metrics
					packet = make([]byte, 21+len(opusData))
					// GPS timestamp in nanoseconds (8 bytes, little-endian uint64)
					binary.LittleEndian.PutUint64(packet[0:8], uint64(audioPacket.GPSTimeNs))
					// Sample rate (4 bytes, little-endian uint32)
					binary.LittleEndian.PutUint32(packet[8:12], uint32(session.SampleRate))
					// Channels (1 byte)
					packet[12] = byte(session.Channels)
					// Baseband power (4 bytes, float32)
					binary.LittleEndian.PutUint32(packet[13:17], math.Float32bits(basebandPower))
					// Noise density (4 bytes, float32)
					binary.LittleEndian.PutUint32(packet[17:21], math.Float32bits(noiseDensity))
					// Opus data
					copy(packet[21:], opusData)
				} else {
					// Version 1: original format
					packet = make([]byte, 13+len(opusData))
					// GPS timestamp in nanoseconds (8 bytes, little-endian uint64)
					binary.LittleEndian.PutUint64(packet[0:8], uint64(audioPacket.GPSTimeNs))
					// Sample rate (4 bytes, little-endian uint32)
					binary.LittleEndian.PutUint32(packet[8:12], uint32(session.SampleRate))
					// Channels (1 byte)
					packet[12] = byte(session.Channels)
					// Opus data
					copy(packet[13:], opusData)
				}

				// Send as binary WebSocket message
				conn.writeMu.Lock()
				conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				err = conn.conn.WriteMessage(websocket.BinaryMessage, packet)
				conn.writeMu.Unlock()

				if err != nil {
					log.Printf("Failed to send binary Opus: %v", err)
					return
				}

				// Track audio bytes sent in session
				session.AddAudioBytes(uint64(len(packet)))

				// Track bytes for statistics
				if conn.aggregator != nil {
					conn.aggregator.addBytes(int64(len(packet)))
					conn.aggregator.addMessage()
				}

				// Record audio bytes sent in Prometheus
				if wsh.prometheusMetrics != nil {
					wsh.prometheusMetrics.RecordAudioBytes(len(packet))
					wsh.prometheusMetrics.RecordWSMessageSent("audio")
				}

			case "pcm-zstd":
				// Binary PCM format with hybrid headers (full/minimal) and zstd compression
				if pcmBinaryEncoder == nil {
					log.Printf("PCM binary encoder not available, cannot continue")
					return
				}

				// Get channel status for signal quality metrics (version 2 only)
				var basebandPower, noiseDensity float32 = -999.0, -999.0 // Default: no data
				if version >= 2 && wsh.sessions != nil && wsh.sessions.radiod != nil {
					if channelStatus := wsh.sessions.radiod.GetChannelStatus(session.SSRC); channelStatus != nil {
						basebandPower = channelStatus.BasebandPower
						noiseDensity = channelStatus.NoiseDensity

						// Apply spectrum gain adjustments to match visual display
						gainAdjustment := float32(wsh.config.Spectrum.GainDB)

						// Apply frequency-specific gain if configured
						if len(wsh.config.Spectrum.GainDBFrequencyRanges) > 0 {
							session.mu.RLock()
							tunedFreq := session.Frequency
							session.mu.RUnlock()

							// Find matching frequency range and apply its gain
							for _, freqRange := range wsh.config.Spectrum.GainDBFrequencyRanges {
								if tunedFreq >= freqRange.StartFreq && tunedFreq <= freqRange.EndFreq {
									gainAdjustment += float32(freqRange.GainDB)
									break
								}
							}
						}

						// Apply total gain adjustment
						basebandPower += gainAdjustment
						noiseDensity += gainAdjustment
					}
				}

				// Encode PCM packet with hybrid header strategy
				// Version 1: First packet or metadata change: full header (29 bytes), subsequent: minimal (13 bytes)
				// Version 2: First packet or metadata change: full header (37 bytes), subsequent: minimal (13 bytes)
				packet, err := pcmBinaryEncoder.EncodePCMPacketWithSignalQuality(
					audioPacket.PCMData,
					audioPacket.GPSTimeNs,
					session.SampleRate,
					session.Channels,
					basebandPower,
					noiseDensity,
				)
				if err != nil {
					log.Printf("PCM binary encoding error: %v", err)
					continue
				}

				// Send as binary WebSocket message
				conn.writeMu.Lock()
				conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				err = conn.conn.WriteMessage(websocket.BinaryMessage, packet)
				conn.writeMu.Unlock()

				if err != nil {
					log.Printf("Failed to send binary PCM: %v", err)
					return
				}

				// Track audio bytes sent in session
				session.AddAudioBytes(uint64(len(packet)))

				// Track bytes for statistics
				if conn.aggregator != nil {
					conn.aggregator.addBytes(int64(len(packet)))
					conn.aggregator.addMessage()
				}

				// Record audio bytes sent in Prometheus
				if wsh.prometheusMetrics != nil {
					wsh.prometheusMetrics.RecordAudioBytes(len(packet))
					wsh.prometheusMetrics.RecordWSMessageSent("audio")
				}

			default:
				log.Printf("Unknown audio format: %s", currentFormat)
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
		Channels:   session.Channels,
		Info:       session.GetInfo(),
	}
	return wsh.sendMessage(conn, msg)
}

// sendError sends an error message to the client
func (wsh *WebSocketHandler) sendError(conn *wsConn, errMsg string) error {
	return wsh.sendErrorWithStatus(conn, errMsg, 0)
}

// sendErrorWithStatus sends an error message with a status code to the client
func (wsh *WebSocketHandler) sendErrorWithStatus(conn *wsConn, errMsg string, status int) error {
	msg := ServerMessage{
		Type:   "error",
		Error:  errMsg,
		Status: status,
	}
	return wsh.sendMessage(conn, msg)
}

// sendMessage sends a message to the client
func (wsh *WebSocketHandler) sendMessage(conn *wsConn, msg ServerMessage) error {
	conn.setWriteDeadline(time.Now().Add(10 * time.Second))
	err := conn.writeJSON(msg)

	// Record message sent in Prometheus (for non-audio messages)
	if err == nil && wsh.prometheusMetrics != nil && msg.Type != "audio" {
		wsh.prometheusMetrics.RecordWSMessageSent(msg.Type)
	}

	return err
}
