package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// ConnectionCheckRequest for /connection endpoint
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"`
}

// ConnectionCheckResponse from /connection endpoint
type ConnectionCheckResponse struct {
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	ClientIP       string   `json:"client_ip,omitempty"`
	SessionTimeout int      `json:"session_timeout"`
	MaxSessionTime int      `json:"max_session_time"`
	Bypassed       bool     `json:"bypassed"`
	AllowedIQModes []string `json:"allowed_iq_modes,omitempty"`
}

const (
	// Default HPSDR configuration
	DefaultInterface    = ""
	DefaultIPAddress    = "0.0.0.0"
	DefaultNumReceivers = 8
	DefaultDeviceType   = DeviceHermesLite

	// Frequency validation constants (UberSDR valid range)
	MinFrequencyHz = 100000   // 100 kHz
	MaxFrequencyHz = 30000000 // 30 MHz

	// Buffering constants
	// Keep a jitter buffer of ~100ms worth of samples to smooth out network variability
	// At 192 kHz: 192000 samples/sec * 0.1 sec = 19200 samples
	// This is ~80 HPSDR packets (238 samples each)
	JitterBufferSamples = 19200
	// Minimum buffer level before we start sending (pre-fill buffer)
	// Small pre-fill like ka9q_hpsdr - just enough to prevent initial underrun
	// 3 packets = ~714 samples = ~3.7ms at 192kHz
	MinBufferSamples = SamplesPerPacket * 3 // ~3 packets = ~3.7ms at 192kHz
	// Low water mark - if buffer drops below this, warn about potential issues
	LowWaterMark = SamplesPerPacket * 2 // ~2 packets = ~2.5ms at 192kHz
)

// WebSocketMessage represents incoming WebSocket messages from ubersdr
type WebSocketMessage struct {
	Type       string `json:"type"`
	Data       string `json:"data,omitempty"`
	SampleRate int    `json:"sampleRate,omitempty"`
	Channels   int    `json:"channels,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	Frequency  int    `json:"frequency,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Error      string `json:"error,omitempty"`
}

// UberSDRBridge bridges ubersdr WebSocket to HPSDR Protocol 2
type UberSDRBridge struct {
	// ubersdr connection
	url            string
	password       string
	wsConns        [MaxReceivers]*websocket.Conn // One connection per receiver
	wsConnMus      [MaxReceivers]sync.Mutex      // Protects WebSocket writes per receiver
	userSessionIDs [MaxReceivers]string          // Unique session ID per receiver

	// HPSDR server
	hpsdrServer *Protocol2Server

	// State
	running    bool
	mu         sync.RWMutex
	sampleRate int
	channels   int

	// Receiver mapping (HPSDR receiver -> ubersdr frequency/mode)
	receiverFreqs  [MaxReceivers]int64
	receiverModes  [MaxReceivers]string
	lastFailedFreq [MaxReceivers]int64  // Track last failed connection frequency
	lastFailedMode [MaxReceivers]string // Track last failed connection mode

	// Sample buffering (per receiver)
	// Accumulate samples until we have exactly 238 ready for HPSDR packet
	sampleBuffers [MaxReceivers][]complex64
	bufferMus     [MaxReceivers]sync.Mutex

	// Temporary conversion buffers (per receiver) - reused to avoid allocations
	tempBuffers [MaxReceivers][]complex64

	// Buffer state tracking
	bufferPrimed    [MaxReceivers]bool      // Track if buffer has been pre-filled
	bufferUnderruns [MaxReceivers]uint64    // Count of underrun events
	bufferOverruns  [MaxReceivers]uint64    // Count of overrun events
	lastBufferLog   [MaxReceivers]time.Time // Last time we logged buffer stats

	// PCM-zstd decoder
	pcmDecoder *PCMBinaryDecoder
}

// NewUberSDRBridge creates a new bridge instance
func NewUberSDRBridge(url string, password string, hpsdrConfig Protocol2Config) (*UberSDRBridge, error) {
	// Create HPSDR server
	hpsdrServer, err := NewProtocol2Server(hpsdrConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create HPSDR server: %w", err)
	}

	pcmDecoder, err := NewPCMBinaryDecoder()
	if err != nil {
		return nil, fmt.Errorf("failed to create PCM decoder: %w", err)
	}

	bridge := &UberSDRBridge{
		url:         url,
		password:    password,
		hpsdrServer: hpsdrServer,
		running:     true,
		sampleRate:  192000, // Default
		channels:    2,      // IQ mode
		pcmDecoder:  pcmDecoder,
	}

	// Initialize receiver frequencies and unique session IDs
	for i := 0; i < MaxReceivers; i++ {
		bridge.receiverFreqs[i] = 14200000                                  // 14.2 MHz default
		bridge.receiverModes[i] = "iq192"                                   // IQ mode at 192 kHz
		bridge.userSessionIDs[i] = uuid.New().String()                      // Unique UUID per receiver
		bridge.lastFailedFreq[i] = 0                                        // No failed connection yet
		bridge.lastFailedMode[i] = ""                                       // No failed connection yet
		bridge.sampleBuffers[i] = make([]complex64, 0, JitterBufferSamples) // Jitter buffer
		bridge.tempBuffers[i] = make([]complex64, 0, 8192)                  // Pre-allocate temp buffer (typical WebSocket message size)
	}

	return bridge, nil
}

// Start begins the bridge operation
func (b *UberSDRBridge) Start() error {
	// Start HPSDR server
	if err := b.hpsdrServer.Start(); err != nil {
		return fmt.Errorf("failed to start HPSDR server: %w", err)
	}

	log.Println("Bridge: HPSDR Protocol 2 server started")

	// Start monitoring HPSDR receivers
	go b.monitorReceivers()

	// Connect to ubersdr (will be done when first receiver is enabled)
	log.Println("Bridge: Waiting for HPSDR client to enable receivers...")

	return nil
}

// Stop shuts down the bridge
func (b *UberSDRBridge) Stop() {
	log.Println("DEBUG: Stop: Entering Stop() function")

	b.mu.Lock()
	log.Println("DEBUG: Stop: Acquired lock, setting running=false")
	b.running = false
	b.mu.Unlock()
	log.Println("DEBUG: Stop: Released lock, running flag set to false")

	// Close all active WebSocket connections
	log.Println("DEBUG: Stop: Starting to close WebSocket connections")
	for i := 0; i < MaxReceivers; i++ {
		if b.wsConns[i] != nil {
			log.Printf("DEBUG: Stop: Closing WebSocket connection for receiver %d", i)
			_ = b.wsConns[i].Close()
			b.wsConns[i] = nil
			log.Printf("DEBUG: Stop: Closed WebSocket connection for receiver %d", i)
		}
	}
	log.Println("DEBUG: Stop: All WebSocket connections closed")

	log.Println("DEBUG: Stop: Calling hpsdrServer.Stop()")
	b.hpsdrServer.Stop()
	log.Println("DEBUG: Stop: hpsdrServer.Stop() completed")
	log.Println("Bridge: Stopped")
}

// monitorReceivers monitors HPSDR receiver state changes
func (b *UberSDRBridge) monitorReceivers() {
	log.Println("DEBUG: monitorReceivers: Entering monitoring loop")
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	// Track which receivers are connected
	connectedReceivers := make(map[int]bool)
	// Track if Protocol2 was running (to detect when it stops)
	wasProtocol2Running := false

	for {
		// Check if we should stop before blocking on ticker
		b.mu.RLock()
		running := b.running
		b.mu.RUnlock()

		if !running {
			log.Println("DEBUG: monitorReceivers: running=false, exiting loop")
			return
		}

		<-ticker.C

		// Check if Protocol2 server is running
		protocol2Running := b.hpsdrServer.IsRunning()

		// Detect transition from running to stopped
		if wasProtocol2Running && !protocol2Running {
			log.Println("DEBUG: monitorReceivers: Protocol2 server stopped, cleaning up all receivers")
			// Protocol2 server stopped, clean up all receivers
			for i := 0; i < b.hpsdrServer.config.NumReceivers; i++ {
				if connectedReceivers[i] {
					log.Printf("DEBUG: monitorReceivers: Cleaning up receiver %d due to server shutdown", i)
					b.cleanupReceiver(i)
					connectedReceivers[i] = false
				}
			}
		}

		// Update tracking flag
		wasProtocol2Running = protocol2Running

		// If Protocol2 is not running, skip receiver checks
		if !protocol2Running {
			continue
		}

		// Check all receivers
		for i := 0; i < b.hpsdrServer.config.NumReceivers; i++ {
			enabled, frequency, sampleRate, err := b.hpsdrServer.GetReceiverState(i)
			if err != nil {
				continue
			}

			if enabled && frequency > 0 && sampleRate > 0 {
				// Validate frequency is within UberSDR range
				if !isValidFrequency(frequency) {
					log.Printf("Bridge: Receiver %d invalid frequency %d Hz (%.3f kHz) - must be between %d Hz (%.1f kHz) and %d Hz (%.1f MHz), skipping",
						i, frequency, float64(frequency)/1000.0,
						MinFrequencyHz, float64(MinFrequencyHz)/1000.0,
						MaxFrequencyHz, float64(MaxFrequencyHz)/1000000.0)
					continue
				}

				// Determine mode based on sample rate
				mode := b.sampleRateToMode(sampleRate)

				// Receiver is active
				if !connectedReceivers[i] {
					log.Printf("DEBUG: monitorReceivers: Receiver %d state change - newly enabled", i)
					log.Printf("Bridge: Receiver %d enabled: %d Hz, %d kHz", i, frequency, sampleRate)
					connectedReceivers[i] = true

					// Check if frequency or mode changed from last failed attempt
					// If so, clear the failed state to allow reconnection
					b.mu.Lock()
					if b.lastFailedFreq[i] != 0 && (b.lastFailedFreq[i] != frequency || b.lastFailedMode[i] != mode) {
						log.Printf("Bridge: Receiver %d frequency/mode changed from last failed attempt, clearing failed state", i)
						b.lastFailedFreq[i] = 0
						b.lastFailedMode[i] = ""
					}
					b.mu.Unlock()

					// Update our tracking
					b.receiverFreqs[i] = frequency
					b.receiverModes[i] = mode

					// Connect to ubersdr for this receiver
					if b.wsConns[i] == nil {
						log.Printf("DEBUG: monitorReceivers: Receiver %d starting connection goroutine", i)
						go b.connectToUberSDR(i)
					} else {
						// Send tune message to change frequency
						log.Printf("DEBUG: monitorReceivers: Receiver %d already connected, tuning", i)
						go b.tuneReceiver(i, frequency, mode)
					}
				} else {
					// Check if frequency or sample rate changed
					frequencyChanged := frequency != b.receiverFreqs[i]
					modeChanged := mode != b.receiverModes[i]

					if frequencyChanged || modeChanged {
						if frequencyChanged {
							log.Printf("Bridge: Receiver %d frequency changed: %d Hz", i, frequency)
							b.receiverFreqs[i] = frequency
						}
						if modeChanged {
							log.Printf("Bridge: Receiver %d sample rate changed: %d kHz (mode %s -> %s)",
								i, sampleRate, b.receiverModes[i], mode)
							b.receiverModes[i] = mode
						}

						// Send tune message with updated frequency and/or mode
						go b.tuneReceiver(i, frequency, mode)
					}
				}
			} else if connectedReceivers[i] {
				// Receiver was disabled - clean up connection state
				log.Printf("DEBUG: monitorReceivers: Receiver %d state change - disabled, cleaning up", i)
				log.Printf("Bridge: Receiver %d disabled, cleaning up connection", i)
				connectedReceivers[i] = false
				b.cleanupReceiver(i)
			}
		}
	}
}

// cleanupReceiver closes WebSocket connection and clears state for a receiver
func (b *UberSDRBridge) cleanupReceiver(receiverNum int) {
	// Close WebSocket connection
	b.mu.Lock()
	log.Printf("DEBUG: cleanupReceiver: Receiver %d acquired lock for cleanup", receiverNum)
	if b.wsConns[receiverNum] != nil {
		log.Printf("DEBUG: cleanupReceiver: Receiver %d closing WebSocket connection", receiverNum)
		_ = b.wsConns[receiverNum].Close()
		b.wsConns[receiverNum] = nil
		log.Printf("DEBUG: cleanupReceiver: Receiver %d WebSocket connection closed", receiverNum)
	}

	// Clear lastFailedFreq/Mode when receiver is disabled
	// This allows reconnection when the receiver is re-enabled
	log.Printf("DEBUG: cleanupReceiver: Receiver %d clearing failed state tracking", receiverNum)
	b.lastFailedFreq[receiverNum] = 0
	b.lastFailedMode[receiverNum] = ""
	b.mu.Unlock()
	log.Printf("DEBUG: cleanupReceiver: Receiver %d released main lock", receiverNum)

	// Clear sample buffer (do this AFTER releasing b.mu to avoid deadlock)
	// The receiveAudio goroutine may be holding bufferMus while waiting on something
	log.Printf("DEBUG: cleanupReceiver: Receiver %d attempting to acquire buffer lock", receiverNum)
	b.bufferMus[receiverNum].Lock()
	log.Printf("DEBUG: cleanupReceiver: Receiver %d clearing sample buffer", receiverNum)
	b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][:0] // Clear buffer but keep capacity
	b.bufferPrimed[receiverNum] = false                             // Reset buffer primed flag
	b.bufferMus[receiverNum].Unlock()
	log.Printf("DEBUG: cleanupReceiver: Receiver %d cleanup complete", receiverNum)
}

// sampleRateToMode converts sample rate (kHz) to ubersdr mode
// Clamps to maximum of iq192 (192 kHz)
func (b *UberSDRBridge) sampleRateToMode(rateKHz int) string {
	// Clamp to maximum of 192 kHz
	if rateKHz > 192 {
		log.Printf("Bridge: Sample rate %d kHz exceeds maximum, clamping to 192 kHz", rateKHz)
		rateKHz = 192
	}

	switch rateKHz {
	case 48:
		return "iq48"
	case 96:
		return "iq96"
	case 192:
		return "iq192"
	default:
		// For any other rate, default to 192 kHz
		return "iq192"
	}
}

// isValidFrequency checks if a frequency is within the valid range for UberSDR
func isValidFrequency(frequency int64) bool {
	return frequency >= MinFrequencyHz && frequency <= MaxFrequencyHz
}

// checkConnection checks if connection is allowed via /connection endpoint
func (b *UberSDRBridge) checkConnection(receiverNum int) (bool, error) {
	// Parse the base URL
	parsedURL, err := url.Parse(b.url)
	if err != nil {
		return false, err
	}

	// Build HTTP URL for connection check
	httpScheme := "http"
	if parsedURL.Scheme == "https" || parsedURL.Scheme == "wss" {
		httpScheme = "https"
	}

	httpURL := fmt.Sprintf("%s://%s/connection", httpScheme, parsedURL.Host)

	// Prepare request body with per-receiver session ID
	reqBody := ConnectionCheckRequest{
		UserSessionID: b.userSessionIDs[receiverNum],
		Password:      b.password,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return false, err
	}

	log.Printf("Bridge: Receiver %d checking connection permission at %s", receiverNum, httpURL)

	req, err := http.NewRequest("POST", httpURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "UberSDR_HPSDR/1.0")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Bridge: Receiver %d connection check failed: %v", receiverNum, err)
		log.Printf("Bridge: Receiver %d attempting connection anyway...", receiverNum)
		return true, nil // Continue on error (like the web UI does)
	}
	defer func() { _ = resp.Body.Close() }()

	var respData ConnectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&respData); err != nil {
		return false, err
	}

	if !respData.Allowed {
		log.Printf("Bridge: Receiver %d connection rejected: %s", receiverNum, respData.Reason)
		return false, nil
	}

	clientIP := respData.ClientIP
	if clientIP == "" {
		clientIP = "unknown"
	}
	log.Printf("Bridge: Receiver %d connection allowed (client IP: %s, bypassed: %v, max session time: %ds)",
		receiverNum, clientIP, respData.Bypassed, respData.MaxSessionTime)
	return true, nil
}

// connectToUberSDR establishes WebSocket connection to ubersdr for a specific receiver
func (b *UberSDRBridge) connectToUberSDR(receiverNum int) {
	log.Printf("DEBUG: connectToUberSDR: Receiver %d entering connection function", receiverNum)

	b.mu.Lock()
	log.Printf("DEBUG: connectToUberSDR: Receiver %d acquired lock", receiverNum)

	if b.wsConns[receiverNum] != nil {
		log.Printf("DEBUG: connectToUberSDR: Receiver %d already connected, exiting", receiverNum)
		b.mu.Unlock()
		return // Already connected
	}

	frequency := b.receiverFreqs[receiverNum]
	mode := b.receiverModes[receiverNum]
	lastFailedFreq := b.lastFailedFreq[receiverNum]
	lastFailedMode := b.lastFailedMode[receiverNum]

	log.Printf("DEBUG: connectToUberSDR: Receiver %d current freq=%d mode=%s, lastFailed freq=%d mode=%s",
		receiverNum, frequency, mode, lastFailedFreq, lastFailedMode)

	// Prevent reconnection loops - only block if we're trying to reconnect to the SAME
	// frequency/mode that just failed. If the receiver was disabled and re-enabled
	// (even to the same frequency), allow reconnection.
	if lastFailedFreq == frequency && lastFailedMode == mode {
		b.mu.Unlock()
		log.Printf("DEBUG: connectToUberSDR: Receiver %d BLOCKED - same freq/mode as last failure", receiverNum)
		log.Printf("Bridge: Receiver %d skipping reconnection to %d Hz/%s (previous attempt failed)",
			receiverNum, frequency, mode)
		return
	}
	log.Printf("DEBUG: connectToUberSDR: Receiver %d reconnection allowed (freq/mode different or no prior failure)", receiverNum)
	b.mu.Unlock()

	// Check if connection is allowed with per-receiver session ID
	allowed, err := b.checkConnection(receiverNum)
	if err != nil {
		log.Printf("Bridge: Receiver %d connection check error: %v", receiverNum, err)
	}
	if !allowed {
		// Mark this frequency/mode as failed
		b.mu.Lock()
		b.lastFailedFreq[receiverNum] = frequency
		b.lastFailedMode[receiverNum] = mode
		b.mu.Unlock()
		return
	}

	// Parse the base URL and convert to WebSocket URL
	parsedURL, err := url.Parse(b.url)
	if err != nil {
		log.Printf("Bridge: Invalid URL: %v", err)
		return
	}

	// Convert http/https to ws/wss
	wsScheme := "ws"
	if parsedURL.Scheme == "https" || parsedURL.Scheme == "wss" {
		wsScheme = "wss"
	}

	// Build WebSocket URL
	wsURL := &url.URL{
		Scheme: wsScheme,
		Host:   parsedURL.Host,
		Path:   "/ws",
	}

	// Build query parameters with per-receiver session ID
	query := url.Values{}
	query.Set("frequency", fmt.Sprintf("%d", frequency))
	query.Set("mode", mode)
	query.Set("user_session_id", b.userSessionIDs[receiverNum])
	// Don't set format - let server use default (pcm-zstd binary)

	if b.password != "" {
		query.Set("password", b.password)
	}

	wsURL.RawQuery = query.Encode()

	log.Printf("Bridge: Connecting receiver %d to ubersdr at %s", receiverNum, wsURL.String())

	// Connect to WebSocket
	headers := http.Header{}
	headers.Set("User-Agent", "UberSDR_HPSDR/1.0")

	conn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), headers)
	if err != nil {
		log.Printf("Bridge: Receiver %d connection error: %v", receiverNum, err)
		// Mark this frequency/mode as failed to prevent immediate retry
		b.mu.Lock()
		b.lastFailedFreq[receiverNum] = frequency
		b.lastFailedMode[receiverNum] = mode
		b.mu.Unlock()
		return
	}

	b.mu.Lock()
	b.wsConns[receiverNum] = conn
	// Clear failed connection tracking on successful connection
	b.lastFailedFreq[receiverNum] = 0
	b.lastFailedMode[receiverNum] = ""
	b.mu.Unlock()

	log.Printf("Bridge: Receiver %d connected to ubersdr (%d Hz, %s)", receiverNum, frequency, mode)

	// Start receiving audio for this receiver
	go b.receiveAudio(receiverNum)

	// Start keepalive goroutine (only once for all connections)
	// Check if this is the first connection
	b.mu.RLock()
	hasOtherConnections := false
	for i := 0; i < MaxReceivers; i++ {
		if i != receiverNum && b.wsConns[i] != nil {
			hasOtherConnections = true
			break
		}
	}
	b.mu.RUnlock()

	if !hasOtherConnections {
		go b.sendKeepalive()
	}
}

// tuneReceiver sends a tune message to change frequency/mode for a specific receiver
func (b *UberSDRBridge) tuneReceiver(receiverNum int, frequency int64, mode string) {
	// Validate frequency before tuning
	if !isValidFrequency(frequency) {
		log.Printf("Bridge: Receiver %d cannot tune to invalid frequency %d Hz (%.3f kHz) - must be between %d Hz (%.1f kHz) and %d Hz (%.1f MHz), skipping tune",
			receiverNum, frequency, float64(frequency)/1000.0,
			MinFrequencyHz, float64(MinFrequencyHz)/1000.0,
			MaxFrequencyHz, float64(MaxFrequencyHz)/1000000.0)
		return
	}

	b.mu.RLock()
	conn := b.wsConns[receiverNum]
	b.mu.RUnlock()

	if conn == nil {
		return
	}

	tuneMsg := map[string]interface{}{
		"type":      "tune",
		"frequency": frequency,
		"mode":      mode,
	}

	b.wsConnMus[receiverNum].Lock()
	err := conn.WriteJSON(tuneMsg)
	b.wsConnMus[receiverNum].Unlock()

	if err != nil {
		log.Printf("Bridge: Receiver %d failed to send tune message: %v", receiverNum, err)
	} else {
		log.Printf("Bridge: Tuned receiver %d to %d Hz, %s", receiverNum, frequency, mode)
	}
}

// receiveAudio receives audio from ubersdr and forwards to HPSDR for a specific receiver
func (b *UberSDRBridge) receiveAudio(receiverNum int) {
	log.Printf("DEBUG: receiveAudio: Receiver %d starting audio receive loop", receiverNum)
	for {
		// Check if bridge is still running
		b.mu.RLock()
		running := b.running
		conn := b.wsConns[receiverNum]
		b.mu.RUnlock()

		if !running {
			log.Printf("DEBUG: receiveAudio: Receiver %d exiting - bridge not running", receiverNum)
			break
		}

		if conn == nil {
			log.Printf("DEBUG: receiveAudio: Receiver %d exiting - connection is nil", receiverNum)
			break
		}

		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("Bridge: Receiver %d connection closed by server", receiverNum)
			} else {
				log.Printf("Bridge: Receiver %d read error: %v", receiverNum, err)
			}
			b.mu.Lock()
			b.wsConns[receiverNum] = nil
			b.mu.Unlock()
			break
		}

		// Handle binary messages (PCM-zstd format)
		if messageType == websocket.BinaryMessage {
			if b.pcmDecoder != nil {
				pcmData, sampleRate, channels, err := b.pcmDecoder.DecodePCMBinary(message, true)
				if err != nil {
					log.Printf("Bridge: Receiver %d PCM decode error: %v", receiverNum, err)
					continue
				}

				// Update sample rate and channels if changed
				if sampleRate != b.sampleRate {
					b.sampleRate = sampleRate
					log.Printf("Bridge: Receiver %d sample rate updated: %d Hz", receiverNum, b.sampleRate)
				}
				if channels != b.channels {
					b.channels = channels
					log.Printf("Bridge: Receiver %d channels updated: %d", receiverNum, b.channels)
				}

				// Convert PCM to IQ samples and send to HPSDR
				if err := b.forwardToHPSDR(receiverNum, pcmData); err != nil {
					log.Printf("Bridge: Receiver %d forward error: %v", receiverNum, err)
				}
			}
			continue
		}

		// Handle JSON messages (status, error, etc.)
		var msg WebSocketMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Bridge: Receiver %d JSON parse error: %v (message: %s)", receiverNum, err, string(message))
			continue
		}

		switch msg.Type {
		case "status":
			log.Printf("Bridge: Receiver %d status - Session %s, %d Hz, mode %s",
				receiverNum, msg.SessionID, msg.Frequency, msg.Mode)

		case "error":
			log.Printf("Bridge: Receiver %d server error: %s", receiverNum, msg.Error)
			// Don't stop the entire bridge, just this receiver
			b.mu.Lock()
			if b.wsConns[receiverNum] != nil {
				_ = b.wsConns[receiverNum].Close()
				b.wsConns[receiverNum] = nil
			}
			b.mu.Unlock()
			return

		case "pong":
			// Keepalive response, ignore
		}
	}
}

// decodeAudio decodes base64 audio data to PCM bytes
func (b *UberSDRBridge) decodeAudio(base64Data string) ([]byte, error) {
	// Decode base64
	audioBytes, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64: %w", err)
	}

	// Convert big-endian to little-endian signed 16-bit PCM
	numSamples := len(audioBytes) / 2
	pcmData := make([]byte, len(audioBytes))

	for i := 0; i < numSamples; i++ {
		// Read big-endian int16
		highByte := audioBytes[i*2]
		lowByte := audioBytes[i*2+1]
		sample := int16((uint16(highByte) << 8) | uint16(lowByte))

		// Write as little-endian int16
		binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(sample))
	}

	return pcmData, nil
}

// forwardToHPSDR converts PCM data to IQ samples and forwards to HPSDR server
// This implements proper sample buffering with jitter buffer:
// - Accumulate samples in a buffer (up to ~100ms worth)
// - Pre-fill buffer before starting to send (avoid initial underruns)
// - Only call LoadIQData() when we have exactly 238 samples ready
// - This ensures proper packet timing (e.g., 192 kHz / 238 samples = ~806 packets/sec)
func (b *UberSDRBridge) forwardToHPSDR(receiverNum int, pcmData []byte) error {
	// Convert PCM int16 stereo to complex64 IQ samples
	// PCM data format: interleaved stereo int16 (little-endian)
	// Left channel = I (in-phase), Right channel = Q (quadrature)
	numSamples := len(pcmData) / 4 // 2 bytes per sample, 2 channels (I and Q)

	// Convert all incoming PCM samples to complex64 OUTSIDE the lock
	// This reduces lock hold time significantly
	// Reuse pre-allocated buffer to avoid allocations in hot path
	if cap(b.tempBuffers[receiverNum]) < numSamples {
		// Grow buffer if needed (rare)
		b.tempBuffers[receiverNum] = make([]complex64, numSamples)
	}
	tempSamples := b.tempBuffers[receiverNum][:numSamples]

	for i := 0; i < numSamples; i++ {
		idx := i * 4

		// Read I (left channel) and Q (right channel) as int16 little-endian
		// Optimized: direct byte access instead of binary.LittleEndian.Uint16()
		iVal := int16(uint16(pcmData[idx]) | uint16(pcmData[idx+1])<<8)
		qVal := int16(uint16(pcmData[idx+2]) | uint16(pcmData[idx+3])<<8)

		// Normalize int16 to float32 range [-1.0, 1.0]
		// Optimized: Use multiplication by reciprocal instead of division
		// 1/32768.0 = 0.000030517578125 (exact in float32)
		const reciprocal = float32(1.0 / 32768.0)
		iNorm := float32(iVal) * reciprocal
		qNorm := float32(qVal) * reciprocal

		// Create complex sample: I + jQ
		// Go's complex(real, imag) = real + imag*i
		// So complex(I, Q) = I + jQ which is correct for IQ data
		tempSamples[i] = complex(iNorm, qNorm)
	}

	// Now lock only for buffer operations and packet sending
	b.bufferMus[receiverNum].Lock()
	defer b.bufferMus[receiverNum].Unlock()

	// Add converted samples to buffer
	b.sampleBuffers[receiverNum] = append(b.sampleBuffers[receiverNum], tempSamples...)

	bufferLevel := len(b.sampleBuffers[receiverNum])

	// Check if buffer is getting too large (prevent unbounded growth)
	if bufferLevel > JitterBufferSamples {
		// Drop oldest samples to maintain buffer size
		excess := bufferLevel - JitterBufferSamples
		b.bufferOverruns[receiverNum]++
		log.Printf("Bridge: Receiver %d buffer OVERRUN #%d, dropping %d samples (buffer was %d samples, %.1f ms)",
			receiverNum, b.bufferOverruns[receiverNum], excess, bufferLevel,
			float64(bufferLevel)/192.0) // Assume 192 kHz
		b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][excess:]
		bufferLevel = len(b.sampleBuffers[receiverNum])
	}

	// Pre-fill buffer before starting to send (jitter buffer priming)
	// This prevents initial underruns when connection starts
	if !b.bufferPrimed[receiverNum] {
		if bufferLevel >= MinBufferSamples {
			b.bufferPrimed[receiverNum] = true
		} else {
			// Still filling buffer, don't send yet
			return nil
		}
	}

	// Detect underruns (buffer depleted while primed)
	// Don't send if we don't have enough samples - just accumulate
	if b.bufferPrimed[receiverNum] && bufferLevel < SamplesPerPacket {
		b.bufferUnderruns[receiverNum]++
		// Re-prime buffer to recover from underrun - need to refill to minimum level
		b.bufferPrimed[receiverNum] = false
		// Don't send anything, just accumulate
		return nil
	}

	// If not primed and don't have minimum samples yet, just accumulate
	if !b.bufferPrimed[receiverNum] && bufferLevel < MinBufferSamples {
		// Still filling, don't send yet
		return nil
	}

	// Periodic buffer statistics (every 30 seconds) - only log if there are issues
	now := time.Now()
	if now.Sub(b.lastBufferLog[receiverNum]) > 30*time.Second {
		b.lastBufferLog[receiverNum] = now
		if b.bufferUnderruns[receiverNum] > 0 || b.bufferOverruns[receiverNum] > 0 {
			log.Printf("Bridge: Receiver %d buffer stats - level: %d samples (%.1f ms), underruns: %d, overruns: %d",
				receiverNum, bufferLevel, float64(bufferLevel)/192.0,
				b.bufferUnderruns[receiverNum], b.bufferOverruns[receiverNum])
		}
	}

	// Send packets while we have enough samples
	// Send all available packets to keep buffer from overflowing
	for len(b.sampleBuffers[receiverNum]) >= SamplesPerPacket {
		// Extract exactly 238 samples for one packet
		packet := make([]complex64, SamplesPerPacket)
		copy(packet, b.sampleBuffers[receiverNum][:SamplesPerPacket])

		// Remove sent samples from buffer
		b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][SamplesPerPacket:]

		// Send to HPSDR server
		// The HPSDR protocol2.go LoadIQData() will handle the scaling and
		// packing into the HPSDR format (Q first, then I, as 24-bit integers)
		if err := b.hpsdrServer.LoadIQData(receiverNum, packet); err != nil {
			return err
		}
	}

	return nil
}

// sendKeepalive sends periodic keepalive messages to all active connections
func (b *UberSDRBridge) sendKeepalive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for b.running {
		<-ticker.C

		b.mu.RLock()
		// Check if any connections are active
		hasActiveConnections := false
		for i := 0; i < MaxReceivers; i++ {
			if b.wsConns[i] != nil {
				hasActiveConnections = true
				break
			}
		}
		b.mu.RUnlock()

		if !hasActiveConnections {
			break
		}

		// Send keepalive to all active connections
		msg := map[string]string{"type": "ping"}
		for i := 0; i < MaxReceivers; i++ {
			b.mu.RLock()
			conn := b.wsConns[i]
			b.mu.RUnlock()

			if conn != nil {
				b.wsConnMus[i].Lock()
				err := conn.WriteJSON(msg)
				b.wsConnMus[i].Unlock()

				if err != nil {
					log.Printf("Bridge: Receiver %d keepalive error: %v", i, err)
				}
			}
		}
	}
}

func main() {
	// Command-line flags
	urlFlag := flag.String("url", "http://localhost:8080", "UberSDR server URL (http://, https://, ws://, or wss://)")
	password := flag.String("password", "", "UberSDR server password (optional)")

	// HPSDR configuration
	hpsdrInterface := flag.String("interface", DefaultInterface, "Network interface to bind to (optional)")
	hpsdrIP := flag.String("ip", DefaultIPAddress, "IP address for HPSDR server")
	numReceivers := flag.Int("receivers", DefaultNumReceivers, "Number of receivers (1-8)")
	deviceType := flag.Int("device", int(DefaultDeviceType), "Device type (1=Hermes, 6=HermesLite)")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "UberSDR to HPSDR Protocol 2 Bridge\n\n")
		fmt.Fprintf(os.Stderr, "This bridge connects to a UberSDR server and emulates an HPSDR device,\n")
		fmt.Fprintf(os.Stderr, "allowing HPSDR-compatible software to use UberSDR as a backend.\n\n")
		fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "UberSDR Connection Options:\n")
		fmt.Fprintf(os.Stderr, "  -url string\n")
		fmt.Fprintf(os.Stderr, "        UberSDR server URL (default \"http://localhost:8080\")\n")
		fmt.Fprintf(os.Stderr, "        Accepts http://, https://, ws://, or wss://\n")
		fmt.Fprintf(os.Stderr, "        http/https will be converted to ws/wss automatically\n")
		fmt.Fprintf(os.Stderr, "  -password string\n")
		fmt.Fprintf(os.Stderr, "        UberSDR server password (optional)\n\n")
		fmt.Fprintf(os.Stderr, "HPSDR Emulation Options:\n")
		fmt.Fprintf(os.Stderr, "  -interface string\n")
		fmt.Fprintf(os.Stderr, "        Network interface to bind to (optional)\n")
		fmt.Fprintf(os.Stderr, "  -ip string\n")
		fmt.Fprintf(os.Stderr, "        IP address for HPSDR server (default \"0.0.0.0\")\n")
		fmt.Fprintf(os.Stderr, "  -receivers int\n")
		fmt.Fprintf(os.Stderr, "        Number of receivers 1-8 (default 8)\n")
		fmt.Fprintf(os.Stderr, "  -device int\n")
		fmt.Fprintf(os.Stderr, "        Device type: 1=Hermes, 6=HermesLite (default 6)\n\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  # Connect to local UberSDR server\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8080\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Connect to remote UberSDR server with TLS and password\n")
		fmt.Fprintf(os.Stderr, "  %s --url https://sdr.example.com --password mypass\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Emulate Hermes with 4 receivers\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8080 --device 1 --receivers 4\n\n", os.Args[0])
	}

	flag.Parse()

	// Validate parameters
	if *numReceivers < 1 || *numReceivers > MaxReceivers {
		log.Fatalf("Invalid number of receivers: %d (must be 1-%d)", *numReceivers, MaxReceivers)
	}

	// Validate URL
	parsedURL, err := url.Parse(*urlFlag)
	if err != nil {
		log.Fatalf("Invalid URL: %v", err)
	}
	if parsedURL.Scheme != "ws" && parsedURL.Scheme != "wss" && parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		log.Fatalf("Invalid URL scheme: %s (must be http://, https://, ws://, or wss://)", parsedURL.Scheme)
	}

	// Generate MAC address (use a locally administered address)
	macAddr := net.HardwareAddr{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}

	// Create HPSDR configuration
	hpsdrConfig := Protocol2Config{
		Interface:      *hpsdrInterface,
		IPAddress:      *hpsdrIP,
		MACAddress:     macAddr,
		NumReceivers:   *numReceivers,
		DeviceType:     byte(*deviceType),
		WidebandEnable: false, // Wideband not supported yet
	}

	// Create bridge
	bridge, err := NewUberSDRBridge(*urlFlag, *password, hpsdrConfig)
	if err != nil {
		log.Fatalf("Failed to create bridge: %v", err)
	}

	// Setup signal handler
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start bridge
	if err := bridge.Start(); err != nil {
		log.Fatalf("Failed to start bridge: %v", err)
	}

	log.Printf("Bridge running - UberSDR at %s, HPSDR on %s", *urlFlag, *hpsdrIP)
	log.Printf("Press Ctrl+C to stop")

	// Wait for signal
	<-sigChan
	log.Println("\nShutting down...")

	bridge.Stop()
	log.Println("Bridge stopped")
}
