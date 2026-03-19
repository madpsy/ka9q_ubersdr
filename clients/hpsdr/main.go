package main

import (
	"bytes"
	"crypto/rand"
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
	"gopkg.in/yaml.v3"
)

// debugBridge enables verbose bridge-level debug logging (set via -debug flag)
var debugBridge = false

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
	// HPSDR device types
	DeviceHermes     = 0x01
	DeviceHermesLite = 0x06

	// Maximum number of receivers
	MaxReceivers = 10

	// Protocol 1 packet constants
	// Protocol 1 IQ data: 126 samples per 1032-byte packet
	SamplesPerPacket = 126

	// Firmware version reported in discovery responses
	FirmwareVersion = 64 // 0x40 — matches real HL2

	// Default HPSDR configuration
	DefaultInterface    = ""
	DefaultIPAddress    = "0.0.0.0"
	DefaultNumReceivers = 10 // HL2 Protocol 1 extension supports up to 10 receivers
	DefaultDeviceType   = DeviceHermesLite

	// Frequency validation constants (UberSDR valid range)
	MinFrequencyHz = 10000    // 10 kHz
	MaxFrequencyHz = 30000000 // 30 MHz

	// Buffering constants
	// JitterBufferMs is the target jitter buffer size in milliseconds.
	// The actual sample count is computed dynamically as: sampleRate * JitterBufferMs / 1000
	// This ensures the buffer is always ~100ms regardless of the configured sample rate
	// (e.g. 4800 samples at 48 kHz, 9600 at 96 kHz, 19200 at 192 kHz).
	JitterBufferMs = 100
	// Minimum buffer level before we start sending (pre-fill buffer)
	MinBufferSamples = SamplesPerPacket * 3
	// Low water mark - if buffer drops below this, warn about potential issues
	LowWaterMark = SamplesPerPacket * 2
)

// FrequencyRange defines a frequency range mapped to a specific UberSDR instance
type FrequencyRange struct {
	Name     string `yaml:"name"`
	MinFreq  int64  `yaml:"min_freq"`
	MaxFreq  int64  `yaml:"max_freq"`
	URL      string `yaml:"url"`
	Password string `yaml:"password"`
}

// RoutingConfig holds the frequency routing configuration
type RoutingConfig struct {
	DefaultURL      string              `yaml:"default_url"`
	DefaultPassword string              `yaml:"default_password"`
	FrequencyRanges []FrequencyRange    `yaml:"frequency_ranges"`
	SmartRouting    *SmartRoutingConfig `yaml:"smart_routing,omitempty"` // Optional smart routing
}

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

// UberSDRBridge bridges ubersdr WebSocket to HPSDR Protocol 1 and/or Protocol 2
type UberSDRBridge struct {
	// ubersdr connection
	url            string
	password       string
	routingConfig  *RoutingConfig                // Optional frequency routing config
	wsConns        [MaxReceivers]*websocket.Conn // One connection per receiver
	wsConnMus      [MaxReceivers]sync.Mutex      // Protects WebSocket writes per receiver
	userSessionIDs [MaxReceivers]string          // Unique session ID per receiver

	// HPSDR Protocol 1 server
	hpsdr1Server *Protocol1Server
	protocolMode int // always 1 (Protocol 1 only)

	// State
	running    bool
	mu         sync.RWMutex
	sampleRate int
	channels   int

	// Receiver mapping (HPSDR receiver -> ubersdr frequency/mode)
	receiverFreqs  [MaxReceivers]int64
	receiverModes  [MaxReceivers]string
	receiverURLs   [MaxReceivers]string // Track which URL each receiver is connected to
	lastFailedURL  [MaxReceivers]string // Track last failed connection URL
	lastFailedFreq [MaxReceivers]int64  // Track last failed connection frequency
	lastFailedMode [MaxReceivers]string // Track last failed connection mode

	// Sample buffering (per receiver)
	// Accumulate samples until we have exactly 238 ready for HPSDR packet
	sampleBuffers [MaxReceivers][]complex64
	bufferMus     [MaxReceivers]sync.Mutex

	// Temporary conversion buffers (per receiver) - reused to avoid allocations
	tempBuffers [MaxReceivers][]complex64

	// Buffer state tracking
	bufferPrimed         [MaxReceivers]bool      // Track if buffer has been pre-filled
	lastSamplesPerPacket [MaxReceivers]int       // Detect samplesPerPacket changes (receiver count change)
	bufferUnderruns      [MaxReceivers]uint64    // Count of underrun events
	bufferOverruns       [MaxReceivers]uint64    // Count of overrun events
	lastBufferLog        [MaxReceivers]time.Time // Last time we logged buffer stats

	// PCM-zstd decoders — one per receiver (zstd.Decoder is NOT goroutine-safe)
	pcmDecoders [MaxReceivers]*PCMBinaryDecoder
}

// NewUberSDRBridge creates a new bridge instance
func NewUberSDRBridge(url string, password string, hpsdr1Config Protocol1Config, routingConfig *RoutingConfig) (*UberSDRBridge, error) {
	hpsdr1Server, err := NewProtocol1Server(hpsdr1Config)
	if err != nil {
		return nil, fmt.Errorf("failed to create HPSDR Protocol 1 server: %w", err)
	}

	bridge := &UberSDRBridge{
		url:           url,
		password:      password,
		routingConfig: routingConfig,
		hpsdr1Server:  hpsdr1Server,
		protocolMode:  1,
		running:       true,
		sampleRate:    192000, // Default
		channels:      2,      // IQ mode
	}

	// Initialize receiver frequencies, session IDs, and per-receiver PCM decoders.
	// Each receiver gets its own decoder because zstd.Decoder is NOT goroutine-safe —
	// sharing one decoder across concurrent receiveAudio goroutines corrupts its state.
	for i := 0; i < MaxReceivers; i++ {
		dec, err := NewPCMBinaryDecoder()
		if err != nil {
			return nil, fmt.Errorf("failed to create PCM decoder for receiver %d: %w", i, err)
		}
		bridge.pcmDecoders[i] = dec
		bridge.receiverFreqs[i] = 14200000             // 14.2 MHz default
		bridge.receiverModes[i] = "iq192"              // IQ mode at 192 kHz
		bridge.userSessionIDs[i] = uuid.New().String() // Unique UUID per receiver
		bridge.lastFailedFreq[i] = 0                   // No failed connection yet
		bridge.lastFailedMode[i] = ""                  // No failed connection yet
		// Pre-allocate the jitter buffer at the 192 kHz capacity (~100ms).
		// The buffer will be trimmed dynamically in forwardToHPSDR() if the
		// client selects a lower sample rate.
		bridge.sampleBuffers[i] = make([]complex64, 0, 192000*JitterBufferMs/1000) // Jitter buffer
		bridge.tempBuffers[i] = make([]complex64, 0, 8192)                         // Pre-allocate temp buffer (typical WebSocket message size)
	}

	return bridge, nil
}

// Start begins the bridge operation
func (b *UberSDRBridge) Start() error {
	// Always Protocol 1 — create own socket on port 1024
	if err := b.hpsdr1Server.StartWithSocket(true); err != nil {
		return fmt.Errorf("failed to start HPSDR Protocol 1 server: %w", err)
	}
	log.Println("Bridge: HPSDR Protocol 1 server started")

	// Start monitoring HPSDR receivers
	go b.monitorReceivers()

	// Connect to ubersdr (will be done when first receiver is enabled)
	log.Println("Bridge: Waiting for HPSDR client to enable receivers...")

	return nil
}

// Stop shuts down the bridge
func (b *UberSDRBridge) Stop() {
	if debugBridge {
		log.Println("Bridge: Stop: entering Stop()")
	}

	// Step 1: Set running flag to false to signal all goroutines to stop
	b.mu.Lock()
	wasRunning := b.running
	b.running = false
	b.mu.Unlock()

	if !wasRunning {
		if debugBridge {
			log.Println("Bridge: Stop: bridge was already stopped")
		}
		return
	}

	log.Println("Bridge: stopping HPSDR servers")

	// Step 2: Stop HPSDR Protocol 1 server
	if b.hpsdr1Server != nil {
		b.hpsdr1Server.Stop()
	}

	// Step 3: Give receiveAudio goroutines time to notice the running flag change
	// (Fix 1+2 ensure LoadIQData() unblocks quickly so this sleep is sufficient)
	time.Sleep(200 * time.Millisecond)

	// Step 4: Close all active WebSocket connections gracefully
	var wg sync.WaitGroup
	for i := 0; i < MaxReceivers; i++ {
		b.mu.RLock()
		conn := b.wsConns[i]
		b.mu.RUnlock()

		if conn != nil {
			wg.Add(1)
			go func(receiverNum int, wsConn *websocket.Conn) {
				defer wg.Done()
				if debugBridge {
					log.Printf("Bridge: Stop: closing WebSocket connection for receiver %d", receiverNum)
				}

				// Send close frame
				closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Bridge stopping")
				_ = wsConn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))

				// Close connection
				_ = wsConn.Close()

				// Clear reference
				b.mu.Lock()
				b.wsConns[receiverNum] = nil
				b.mu.Unlock()
			}(i, conn)
		}
	}

	// Wait for all connections to close with timeout
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		if debugBridge {
			log.Println("Bridge: Stop: all WebSocket connections closed")
		}
	case <-time.After(2 * time.Second):
		log.Println("Bridge: Stop: timeout waiting for WebSocket connections to close")
	}

	log.Println("Bridge: stopped")
}

// monitorReceivers monitors HPSDR receiver state changes
func (b *UberSDRBridge) monitorReceivers() {
	if debugBridge {
		log.Println("Bridge: monitorReceivers: entering monitoring loop")
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	// Track which receivers are connected
	connectedReceivers := make(map[int]bool)
	wasRunning := false

	for {
		// Check if we should stop before blocking on ticker
		b.mu.RLock()
		running := b.running
		b.mu.RUnlock()

		if !running {
			if debugBridge {
				log.Println("Bridge: monitorReceivers: running=false, exiting loop")
			}
			return
		}

		// Check if HPSDR server is running
		hpsdrRunning := b.hpsdr1Server != nil && b.hpsdr1Server.IsRunning()

		// Use longer sleep interval when no client connected to reduce CPU usage
		if !hpsdrRunning {
			time.Sleep(500 * time.Millisecond)
		} else {
			<-ticker.C
		}

		// Detect transition from running to stopped
		justCleaned := false
		if wasRunning && !hpsdrRunning {
			log.Println("Bridge: HPSDR server stopped, cleaning up all receivers")
			numReceivers := b.getNumReceivers()
			for i := 0; i < numReceivers; i++ {
				if debugBridge {
					log.Printf("Bridge: monitorReceivers: cleaning up receiver %d due to server shutdown", i)
				}
				b.cleanupReceiver(i)
				connectedReceivers[i] = false
			}
			justCleaned = true
		}

		// Update tracking flag
		wasRunning = hpsdrRunning

		// If HPSDR is not running, or we just cleaned up, skip receiver checks this tick
		// (give WebSocket connections time to fully close before reconnecting)
		if !hpsdrRunning || justCleaned {
			continue
		}

		// Get client IP for logging
		var clientIP *net.UDPAddr
		if b.hpsdr1Server != nil && b.hpsdr1Server.IsRunning() {
			clientIP = b.hpsdr1Server.GetClientAddr()
		}
		clientIPStr := "unknown"
		if clientIP != nil {
			clientIPStr = clientIP.String()
		}

		// Check all receivers
		numReceivers := b.getNumReceivers()
		for i := 0; i < numReceivers; i++ {
			enabled, frequency, sampleRate, err := b.getReceiverState(i)
			if err != nil {
				continue
			}

			if enabled && frequency > 0 && sampleRate > 0 {
				// Validate frequency is within UberSDR range
				if !isValidFrequency(frequency) {
					// Only log once per receiver (not every 100ms tick)
					if !connectedReceivers[i] {
						log.Printf("Bridge: [%s] Receiver %d frequency %d Hz (%.3f MHz) out of range [%d-%d Hz], skipping",
							clientIPStr, i, frequency, float64(frequency)/1e6,
							MinFrequencyHz, MaxFrequencyHz)
						connectedReceivers[i] = true // suppress repeat logs
					}
					continue
				}

				// Determine mode based on sample rate
				mode := b.sampleRateToMode(sampleRate)

				// Receiver is active
				if !connectedReceivers[i] {
					log.Printf("Bridge: [%s] Receiver %d enabled: %d Hz, %d kHz", clientIPStr, i, frequency, sampleRate)
					connectedReceivers[i] = true

					// Check if frequency or mode changed from last failed attempt
					// If so, clear the failed state to allow reconnection
					b.mu.Lock()
					if b.lastFailedFreq[i] != 0 && (b.lastFailedFreq[i] != frequency || b.lastFailedMode[i] != mode) {
						log.Printf("Bridge: [%s] Receiver %d frequency/mode changed from last failed attempt, clearing failed state", clientIPStr, i)
						b.lastFailedURL[i] = ""
						b.lastFailedFreq[i] = 0
						b.lastFailedMode[i] = ""
					}
					b.mu.Unlock()

					// Update our tracking
					b.receiverFreqs[i] = frequency
					b.receiverModes[i] = mode

					// Connect to ubersdr for this receiver
					if b.wsConns[i] == nil {
						if debugBridge {
							log.Printf("Bridge: monitorReceivers: receiver %d starting connection goroutine", i)
						}
						go b.connectToUberSDR(i)
					} else {
						// Send tune message to change frequency
						if debugBridge {
							log.Printf("Bridge: monitorReceivers: receiver %d already connected, tuning", i)
						}
						go b.tuneReceiver(i, frequency, mode)
					}
				} else {
					// Check if the WebSocket connection dropped unexpectedly (receiveAudio exited
					// with an error and set wsConns[i] = nil). Reconnect without resetting
					// connectedReceivers[i] so we don't re-log the "receiver enabled" message.
					if b.wsConns[i] == nil {
						log.Printf("Bridge: [%s] Receiver %d connection lost, reconnecting", clientIPStr, i)
						go b.connectToUberSDR(i)
						continue
					}

					// Check if frequency or sample rate changed
					frequencyChanged := frequency != b.receiverFreqs[i]
					modeChanged := mode != b.receiverModes[i]

					if frequencyChanged || modeChanged {
						// Mode change requires full reconnection — UberSDR mode (sample rate)
						// is set at connection time via URL query param (?mode=iq96).
						// A tune message over an existing connection cannot change the stream's
						// sample rate; the server would need to rebuild its DSP pipeline.
						if modeChanged {
							log.Printf("Bridge: [%s] Receiver %d mode changed %s -> %s (%d kHz), reconnecting",
								clientIPStr, i, b.receiverModes[i], mode, sampleRate)
							b.receiverFreqs[i] = frequency
							b.receiverModes[i] = mode
							b.cleanupReceiver(i)
							connectedReceivers[i] = false
							// Reconnection will happen on next monitor loop iteration
							continue
						}

						// Mode unchanged — check if frequency change requires switching instance
						if frequencyChanged && b.routingConfig != nil {
							oldURL, _ := b.getURLForFrequency(b.receiverFreqs[i], false, "") // Don't reserve, just query
							newURL, _ := b.getURLForFrequency(frequency, false, "")          // Don't reserve, just query

							if oldURL != newURL {
								// Frequency moved to different instance - reconnect
								log.Printf("Bridge: [%s] Receiver %d frequency changed to different instance (%d Hz -> %d Hz)",
									clientIPStr, i, b.receiverFreqs[i], frequency)
								log.Printf("Bridge: [%s] Receiver %d switching from %s to %s",
									clientIPStr, i, oldURL, newURL)

								// Update tracking
								b.receiverFreqs[i] = frequency
								b.receiverModes[i] = mode

								// Close old connection and reconnect to new instance
								b.cleanupReceiver(i)
								connectedReceivers[i] = false

								// Reconnection will happen on next monitor loop iteration
								continue
							}
						}

						// Same instance, same mode — just tune frequency
						if frequencyChanged {
							log.Printf("Bridge: [%s] Receiver %d frequency changed: %d Hz", clientIPStr, i, frequency)
							b.receiverFreqs[i] = frequency
						}

						// Send tune message with updated frequency (mode is unchanged)
						go b.tuneReceiver(i, frequency, mode)
					}
				}
			} else if connectedReceivers[i] {
				// Receiver was disabled - clean up connection state
				log.Printf("Bridge: [%s] Receiver %d disabled, cleaning up connection", clientIPStr, i)
				connectedReceivers[i] = false
				b.cleanupReceiver(i)
			}
		}
	}
}

// cleanupReceiver closes WebSocket connection and clears state for a receiver
func (b *UberSDRBridge) cleanupReceiver(receiverNum int) {
	if debugBridge {
		log.Printf("Bridge: cleanupReceiver: receiver %d starting cleanup", receiverNum)
	}

	// Get the URL that this receiver was connected to
	b.mu.Lock()
	instanceURL := b.receiverURLs[receiverNum]
	conn := b.wsConns[receiverNum]
	b.mu.Unlock()

	// Release instance usage for smart routing
	if instanceURL != "" && b.routingConfig != nil && b.routingConfig.SmartRouting != nil && b.routingConfig.SmartRouting.Enabled {
		b.routingConfig.SmartRouting.ReleaseInstance(instanceURL)
		if debugBridge {
			log.Printf("Bridge: cleanupReceiver: receiver %d released smart routing instance", receiverNum)
		}
	}

	// Close WebSocket connection gracefully with proper close frame
	if conn != nil {
		if debugBridge {
			log.Printf("Bridge: cleanupReceiver: receiver %d sending WebSocket close frame", receiverNum)
		}
		closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Client stopping")
		_ = conn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))

		// Give the server a moment to acknowledge the close
		time.Sleep(100 * time.Millisecond)

		_ = conn.Close()
		if debugBridge {
			log.Printf("Bridge: cleanupReceiver: receiver %d WebSocket connection closed", receiverNum)
		}
	}

	// Clear connection state
	b.mu.Lock()
	b.wsConns[receiverNum] = nil
	b.lastFailedURL[receiverNum] = ""
	b.lastFailedFreq[receiverNum] = 0
	b.lastFailedMode[receiverNum] = ""
	b.receiverURLs[receiverNum] = ""
	b.mu.Unlock()

	// Clear buffer state with timeout to prevent deadlock.
	// forwardToHPSDR() may be holding bufferMus while blocked in LoadIQData().
	// Fix 1+2 ensure LoadIQData() unblocks quickly when running→false, so this
	// timeout should rarely trigger in practice.
	bufferCleared := make(chan bool, 1)
	go func() {
		b.bufferMus[receiverNum].Lock()
		b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][:0]
		b.bufferPrimed[receiverNum] = false
		b.bufferMus[receiverNum].Unlock()
		bufferCleared <- true
	}()

	select {
	case <-bufferCleared:
		if debugBridge {
			log.Printf("Bridge: cleanupReceiver: receiver %d buffer cleared", receiverNum)
		}
	case <-time.After(500 * time.Millisecond):
		log.Printf("Bridge: cleanupReceiver: receiver %d buffer clear timed out (forwardToHPSDR may be blocked in LoadIQData)", receiverNum)
	}

	if debugBridge {
		log.Printf("Bridge: cleanupReceiver: receiver %d cleanup complete", receiverNum)
	}
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

// getURLForFrequency returns the appropriate URL and password for a given frequency
// based on the routing configuration, or the default if no range matches
// If reserve is true, reserves the instance for smart routing (call when connecting)
// If reserve is false, just queries without reserving (call when checking if URL changed)
// excludeURL can be used to exclude a specific URL from selection (e.g., one that just failed)
func (b *UberSDRBridge) getURLForFrequency(frequency int64, reserve bool, excludeURL string) (string, string) {
	// If no routing config, use default
	if b.routingConfig == nil {
		return b.url, b.password
	}

	// Try smart routing first if enabled
	if b.routingConfig.SmartRouting != nil && b.routingConfig.SmartRouting.Enabled {
		// Determine mode based on current receiver settings
		mode := "iq192" // Default mode
		for i := 0; i < MaxReceivers; i++ {
			if b.receiverFreqs[i] == frequency {
				mode = b.receiverModes[i]
				break
			}
		}

		url, password, err := b.routingConfig.SmartRouting.GetURLForFrequency(frequency, mode, reserve, excludeURL)
		if err == nil && url != "" {
			return url, password
		}
		log.Printf("Bridge: Smart routing failed for %d Hz, falling back to static routing", frequency)
	}

	// Check each frequency range (static routing)
	for _, fr := range b.routingConfig.FrequencyRanges {
		if frequency >= fr.MinFreq && frequency <= fr.MaxFreq {
			log.Printf("Bridge: Frequency %d Hz matched range '%s' (%d-%d Hz), using %s",
				frequency, fr.Name, fr.MinFreq, fr.MaxFreq, fr.URL)
			return fr.URL, fr.Password
		}
	}

	// No match, use default
	log.Printf("Bridge: Frequency %d Hz using default URL %s", frequency, b.routingConfig.DefaultURL)
	return b.routingConfig.DefaultURL, b.routingConfig.DefaultPassword
}

// checkConnection checks if connection is allowed via /connection endpoint
func (b *UberSDRBridge) checkConnection(receiverNum int, targetURL string, targetPassword string) (bool, error) {
	// Parse the target URL
	parsedURL, err := url.Parse(targetURL)
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
		Password:      targetPassword,
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

	// Add X-Real-IP header with the HPSDR client's IP address
	var clientAddr *net.UDPAddr
	if b.hpsdr1Server != nil && b.hpsdr1Server.IsRunning() {
		clientAddr = b.hpsdr1Server.GetClientAddr()
	}
	if clientAddr != nil {
		clientIP := clientAddr.IP.String()
		req.Header.Set("X-Real-IP", clientIP)
		log.Printf("Bridge: Receiver %d setting X-Real-IP header to %s", receiverNum, clientIP)
	}

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
	if debugBridge {
		log.Printf("Bridge: connectToUberSDR: receiver %d entering connection function", receiverNum)
	}

	b.mu.Lock()

	if b.wsConns[receiverNum] != nil {
		if debugBridge {
			log.Printf("Bridge: connectToUberSDR: receiver %d already connected, exiting", receiverNum)
		}
		b.mu.Unlock()
		return // Already connected
	}

	frequency := b.receiverFreqs[receiverNum]
	mode := b.receiverModes[receiverNum]
	lastFailedURL := b.lastFailedURL[receiverNum]
	lastFailedFreq := b.lastFailedFreq[receiverNum]
	lastFailedMode := b.lastFailedMode[receiverNum]
	b.mu.Unlock()

	// Get URL and password for this frequency (may differ from default)
	// Reserve the instance atomically to prevent race conditions
	// Exclude the last failed URL so smart routing selects the next best instance
	excludeURL := ""
	if lastFailedFreq == frequency && lastFailedMode == mode {
		excludeURL = lastFailedURL // Exclude the instance that just failed for this freq/mode
	}
	targetURL, targetPassword := b.getURLForFrequency(frequency, true, excludeURL) // Reserve instance

	if debugBridge {
		log.Printf("Bridge: connectToUberSDR: receiver %d freq=%d mode=%s URL=%s, lastFailed URL=%s freq=%d mode=%s",
			receiverNum, frequency, mode, targetURL, lastFailedURL, lastFailedFreq, lastFailedMode)
	}

	// Prevent reconnection loops - block if we're trying to reconnect to the SAME
	// URL/frequency/mode that just failed. This allows smart routing to select a different
	// instance for the same frequency if the previous one failed.
	if lastFailedURL == targetURL && lastFailedFreq == frequency && lastFailedMode == mode {
		// Release the instance we just reserved since we're not going to use it
		if b.routingConfig != nil && b.routingConfig.SmartRouting != nil && b.routingConfig.SmartRouting.Enabled {
			b.routingConfig.SmartRouting.ReleaseInstance(targetURL)
		}
		log.Printf("Bridge: Receiver %d skipping reconnection to %s (%d Hz/%s) - previous attempt to this instance failed",
			receiverNum, targetURL, frequency, mode)
		return
	}
	if debugBridge {
		log.Printf("Bridge: connectToUberSDR: receiver %d reconnection allowed", receiverNum)
	}

	// Check if connection is allowed with per-receiver session ID
	allowed, err := b.checkConnection(receiverNum, targetURL, targetPassword)
	if err != nil {
		log.Printf("Bridge: Receiver %d connection check error: %v", receiverNum, err)
	}
	if !allowed {
		// Mark this URL/frequency/mode as failed
		b.mu.Lock()
		b.lastFailedURL[receiverNum] = targetURL
		b.lastFailedFreq[receiverNum] = frequency
		b.lastFailedMode[receiverNum] = mode
		b.mu.Unlock()
		return
	}

	// Parse the target URL and convert to WebSocket URL
	parsedURL, err := url.Parse(targetURL)
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
	query.Set("version", "2") // Request version 2: server sends silence packets every 100ms,
	// ensuring data flows even when the radio is quiet (no squelch timeout).
	// Don't set format - let server use default (pcm-zstd binary)

	if targetPassword != "" {
		query.Set("password", targetPassword)
	}

	wsURL.RawQuery = query.Encode()

	log.Printf("Bridge: Connecting receiver %d to ubersdr at %s", receiverNum, wsURL.String())

	// Connect to WebSocket
	headers := http.Header{}
	headers.Set("User-Agent", "UberSDR_HPSDR/1.0")

	// Add X-Real-IP header with the HPSDR client's IP address
	var clientAddr *net.UDPAddr
	if b.hpsdr1Server != nil && b.hpsdr1Server.IsRunning() {
		clientAddr = b.hpsdr1Server.GetClientAddr()
	}
	if clientAddr != nil {
		clientIP := clientAddr.IP.String()
		headers.Set("X-Real-IP", clientIP)
		log.Printf("Bridge: Receiver %d setting X-Real-IP header to %s", receiverNum, clientIP)
	}

	// Create a dialer with larger read buffer to handle large WebSocket frames.
	// IQ frames at high sample rates (e.g. iq192) can exceed 27KB compressed,
	// so use 128KB to give ample headroom across all modes.
	dialer := websocket.Dialer{
		ReadBufferSize:  131072, // 128KB — handles large IQ frames at all sample rates
		WriteBufferSize: 4096,   // Keep default write buffer
	}
	conn, _, err := dialer.Dial(wsURL.String(), headers)
	if err != nil {
		log.Printf("Bridge: Receiver %d connection error: %v", receiverNum, err)
		// Release the reserved instance since connection failed
		if b.routingConfig != nil && b.routingConfig.SmartRouting != nil && b.routingConfig.SmartRouting.Enabled {
			b.routingConfig.SmartRouting.ReleaseInstance(targetURL)
		}
		// Mark this URL/frequency/mode as failed to prevent immediate retry to same instance
		b.mu.Lock()
		b.lastFailedURL[receiverNum] = targetURL
		b.lastFailedFreq[receiverNum] = frequency
		b.lastFailedMode[receiverNum] = mode
		b.mu.Unlock()
		return
	}

	b.mu.Lock()
	b.wsConns[receiverNum] = conn
	b.receiverURLs[receiverNum] = targetURL // Track which URL this receiver is connected to
	// Clear failed connection tracking on successful connection
	b.lastFailedURL[receiverNum] = ""
	b.lastFailedFreq[receiverNum] = 0
	b.lastFailedMode[receiverNum] = ""
	b.mu.Unlock()

	// Note: Instance was already reserved in getURLForFrequency() to prevent race conditions

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
	if debugBridge {
		log.Printf("Bridge: receiveAudio: receiver %d starting", receiverNum)
	}
	defer func() {
		if debugBridge {
			log.Printf("Bridge: receiveAudio: receiver %d exiting", receiverNum)
		}
	}()

	for {
		// Check if bridge is still running
		b.mu.RLock()
		running := b.running
		conn := b.wsConns[receiverNum]
		b.mu.RUnlock()

		if !running {
			if debugBridge {
				log.Printf("Bridge: receiveAudio: receiver %d exiting — bridge not running", receiverNum)
			}
			break
		}

		if conn == nil {
			if debugBridge {
				log.Printf("Bridge: receiveAudio: receiver %d exiting — connection is nil", receiverNum)
			}
			break
		}

		// Set read deadline to allow periodic checking of running state
		if err := conn.SetReadDeadline(time.Now().Add(1 * time.Second)); err != nil {
			log.Printf("Bridge: receiveAudio: receiver %d failed to set read deadline: %v", receiverNum, err)
			break
		}

		messageType, message, err := conn.ReadMessage()
		if err != nil {
			// Check for timeout - this is normal, just continue
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}

			// Check for normal close conditions
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("Bridge: Receiver %d connection closed normally", receiverNum)
			} else {
				log.Printf("Bridge: Receiver %d read error: %v", receiverNum, err)
			}

			// Clear connection reference
			b.mu.Lock()
			if b.wsConns[receiverNum] == conn {
				b.wsConns[receiverNum] = nil
			}
			b.mu.Unlock()
			break
		}

		// Handle binary messages (PCM-zstd format)
		if messageType == websocket.BinaryMessage {
			if b.pcmDecoders[receiverNum] != nil {
				pcmData, sampleRate, channels, err := b.pcmDecoders[receiverNum].DecodePCMBinary(message, true)
				if err != nil {
					log.Printf("Bridge: Receiver %d PCM decode error: %v", receiverNum, err)
					continue
				}

				// Update sample rate and channels if changed.
				// Guard with b.mu to prevent data races — multiple receiveAudio()
				// goroutines (one per receiver) may write these fields concurrently.
				b.mu.Lock()
				if sampleRate != b.sampleRate {
					b.sampleRate = sampleRate
					log.Printf("Bridge: Receiver %d sample rate updated: %d Hz", receiverNum, b.sampleRate)
				}
				if channels != b.channels {
					b.channels = channels
					log.Printf("Bridge: Receiver %d channels updated: %d", receiverNum, b.channels)
				}
				b.mu.Unlock()

				// Convert PCM to IQ samples and send to HPSDR
				// Check if still running before forwarding
				b.mu.RLock()
				stillRunning := b.running
				b.mu.RUnlock()

				if stillRunning {
					if err := b.forwardToHPSDR(receiverNum, pcmData); err != nil {
						log.Printf("Bridge: Receiver %d forward error: %v", receiverNum, err)
					}
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

	// Clean up buffer on exit.
	// Note: forwardToHPSDR() no longer holds bufferMus across LoadIQData() (Fix 3),
	// so this lock acquisition should complete promptly.
	b.bufferMus[receiverNum].Lock()
	b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][:0]
	b.bufferPrimed[receiverNum] = false
	b.bufferMus[receiverNum].Unlock()
	if debugBridge {
		log.Printf("Bridge: receiveAudio: receiver %d buffer cleared on exit", receiverNum)
	}
}

// getNumReceivers returns the number of receivers
func (b *UberSDRBridge) getNumReceivers() int {
	if b.hpsdr1Server != nil {
		return b.hpsdr1Server.config.NumReceivers
	}
	return MaxReceivers // fallback
}

// getReceiverState returns receiver state (check both servers, prefer active one)
func (b *UberSDRBridge) getReceiverState(receiverNum int) (enabled bool, frequency int64, sampleRate int, err error) {
	// Check Protocol 1 server first if it's running
	if b.hpsdr1Server != nil && b.hpsdr1Server.IsRunning() {
		enabled, frequency, sampleRate, err = b.hpsdr1Server.GetReceiverState(receiverNum)
		if err == nil && enabled {
			return
		}
	}
	return false, 0, 0, fmt.Errorf("no HPSDR server available")
}

// forwardToHPSDR converts PCM data to IQ samples and forwards to HPSDR server
// This implements proper sample buffering with jitter buffer:
// - Accumulate samples in a buffer (up to ~100ms worth)
// - Pre-fill buffer before starting to send (avoid initial underruns)
// - Only call LoadIQData() when we have exactly the right number of samples ready
// - Protocol 1: 512 samples per packet
// - Protocol 2: 238 samples per packet
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

	// Fix 3: Lock bufferMus only for buffer manipulation, NOT for the LoadIQData() call.
	// LoadIQData() blocks waiting for the previous packet to be sent (doneSendCond).
	// Holding bufferMus across that blocking call causes a deadlock when:
	//   - cleanupReceiver() tries to acquire bufferMus to clear the buffer
	//   - LoadIQData() is blocked because receiverThread is sleeping (running=false)
	// Solution: drain packets into a local slice under the lock, then release the lock
	// before calling LoadIQData().

	// --- Phase 1: buffer management (under lock) ---
	b.bufferMus[receiverNum].Lock()

	// Add converted samples to buffer
	b.sampleBuffers[receiverNum] = append(b.sampleBuffers[receiverNum], tempSamples...)
	bufferLevel := len(b.sampleBuffers[receiverNum])

	// Compute samplesPerPacket first — all threshold checks depend on it.
	// Protocol 1: samples per packet depends on the number of active receivers.
	// Formula (from linhpsdr): samplesPerFrame = (512-8) / ((numReceivers*6)+2)
	// Two frames per packet, so samplesPerPacket = samplesPerFrame * 2.
	// This must match what senderThread() computes so we feed exactly the right
	// number of samples per LoadIQData() call.
	if b.hpsdr1Server == nil {
		b.bufferMus[receiverNum].Unlock()
		return nil
	}
	numEnabledReceivers := 0
	for i := 0; i < b.hpsdr1Server.config.NumReceivers; i++ {
		b.hpsdr1Server.receivers[i].mu.Lock()
		if b.hpsdr1Server.receivers[i].enabled {
			numEnabledReceivers++
		}
		b.hpsdr1Server.receivers[i].mu.Unlock()
	}
	if numEnabledReceivers < 1 {
		numEnabledReceivers = 1
	}
	samplesPerFrame := (512 - 8) / ((numEnabledReceivers * 6) + 2)
	samplesPerPacket := samplesPerFrame * 2
	if samplesPerPacket == 0 {
		b.bufferMus[receiverNum].Unlock()
		return nil
	}

	// When the number of enabled receivers changes, samplesPerPacket changes too.
	// Any samples already in the buffer were accumulated for the OLD packet size —
	// sending them with the new size would produce malformed packets.
	// Reset the buffer and re-prime so we start clean with the new packet geometry.
	if b.lastSamplesPerPacket[receiverNum] != 0 && b.lastSamplesPerPacket[receiverNum] != samplesPerPacket {
		log.Printf("Bridge: Receiver %d samplesPerPacket changed %d→%d (receiver count change), resetting buffer",
			receiverNum, b.lastSamplesPerPacket[receiverNum], samplesPerPacket)
		b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][:0]
		b.bufferPrimed[receiverNum] = false
	}
	b.lastSamplesPerPacket[receiverNum] = samplesPerPacket

	// Pre-fill threshold: 20 packets worth of samples (~10ms at any sample rate).
	// This gives enough headroom to absorb network jitter without being so large
	// that it introduces noticeable latency.
	minBufferSamples := samplesPerPacket * 20

	// Compute the jitter buffer cap dynamically from the current sample rate so
	// it is always ~JitterBufferMs ms regardless of whether the client requested
	// 48 kHz, 96 kHz, or 192 kHz.  Fall back to 192 kHz if rate is not yet known.
	srHz := b.sampleRate
	if srHz <= 0 {
		srHz = 192000
	}
	jitterBufferSamples := srHz * JitterBufferMs / 1000

	// Check if buffer is getting too large (prevent unbounded growth)
	if bufferLevel > jitterBufferSamples {
		excess := bufferLevel - jitterBufferSamples
		b.bufferOverruns[receiverNum]++
		if b.bufferOverruns[receiverNum] == 1 || b.bufferOverruns[receiverNum]%100 == 0 {
			srKHz := float64(b.sampleRate) / 1000.0
			if srKHz <= 0 {
				srKHz = 192.0
			}
			log.Printf("Bridge: Receiver %d buffer OVERRUN #%d, dropping %d samples (buffer was %d samples, %.1f ms @ %.0f kHz)",
				receiverNum, b.bufferOverruns[receiverNum], excess, bufferLevel,
				float64(bufferLevel)/srKHz, srKHz)
		}
		b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][excess:]
		bufferLevel = len(b.sampleBuffers[receiverNum])
		// Also shrink the slice capacity back to jitterBufferSamples to release memory
		// when the sample rate drops (e.g. 192→48 kHz).  copy+reslice avoids a new alloc
		// most of the time because the underlying array is already large enough.
	}

	// Pre-fill buffer before starting to send (jitter buffer priming)
	if !b.bufferPrimed[receiverNum] {
		if bufferLevel >= minBufferSamples {
			b.bufferPrimed[receiverNum] = true
			if debugBridge {
				srKHz := float64(srHz) / 1000.0
				log.Printf("Bridge: Receiver %d buffer primed: level=%d samples (%.1f ms @ %.0f kHz), samplesPerPacket=%d, numEnabledRx=%d",
					receiverNum, bufferLevel, float64(bufferLevel)/srKHz, srKHz,
					samplesPerPacket, numEnabledReceivers)
			}
		} else {
			b.bufferMus[receiverNum].Unlock()
			return nil
		}
	}

	// Detect underruns: buffer dropped below one packet's worth of samples.
	// Reset primed state so we re-fill before sending again.
	if b.bufferPrimed[receiverNum] && bufferLevel < samplesPerPacket {
		b.bufferUnderruns[receiverNum]++
		b.bufferPrimed[receiverNum] = false
		b.bufferMus[receiverNum].Unlock()
		return nil
	}

	if !b.bufferPrimed[receiverNum] && bufferLevel < minBufferSamples {
		b.bufferMus[receiverNum].Unlock()
		return nil
	}

	// Periodic buffer statistics (every 30 seconds)
	now := time.Now()
	if now.Sub(b.lastBufferLog[receiverNum]) > 30*time.Second {
		b.lastBufferLog[receiverNum] = now
		if b.bufferUnderruns[receiverNum] > 0 || b.bufferOverruns[receiverNum] > 0 {
			srKHz := float64(b.sampleRate) / 1000.0
			if srKHz <= 0 {
				srKHz = 192.0
			}
			log.Printf("Bridge: Receiver %d buffer stats - level: %d samples (%.1f ms @ %.0f kHz), underruns: %d, overruns: %d",
				receiverNum, bufferLevel, float64(bufferLevel)/srKHz, srKHz,
				b.bufferUnderruns[receiverNum], b.bufferOverruns[receiverNum])
		}
	}

	// Drain ready packets into a local slice under the lock
	var packets [][]complex64
	for len(b.sampleBuffers[receiverNum]) >= samplesPerPacket {
		packet := make([]complex64, samplesPerPacket)
		copy(packet, b.sampleBuffers[receiverNum][:samplesPerPacket])
		b.sampleBuffers[receiverNum] = b.sampleBuffers[receiverNum][samplesPerPacket:]
		packets = append(packets, packet)
	}

	// --- Phase 2: release lock BEFORE calling LoadIQData() ---
	// LoadIQData() may block on doneSendCond; holding bufferMus across that
	// call would deadlock cleanupReceiver() which also needs bufferMus.
	b.bufferMus[receiverNum].Unlock()

	// --- Phase 3: send packets WITHOUT holding bufferMus ---
	// If LoadIQData() returns an error (e.g. server not running transiently),
	// log it and continue — the buffer will re-prime on the next call.
	// Do NOT return the error to the caller, as that would cause receiveAudio
	// to log noise on every frequency change / receiver reconfiguration.
	for _, packet := range packets {
		if err := b.hpsdr1Server.LoadIQData(receiverNum, packet, samplesPerPacket); err != nil {
			if debugBridge {
				log.Printf("Bridge: forwardToHPSDR: receiver %d LoadIQData error: %v", receiverNum, err)
			}
			// Reset primed state so buffer re-fills before next send attempt
			b.bufferMus[receiverNum].Lock()
			b.bufferPrimed[receiverNum] = false
			b.bufferMus[receiverNum].Unlock()
			return nil
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

// getInterfaceIP returns the first IPv4 address of the specified network interface
func getInterfaceIP(interfaceName string) (string, error) {
	iface, err := net.InterfaceByName(interfaceName)
	if err != nil {
		return "", fmt.Errorf("interface %s not found: %w", interfaceName, err)
	}

	addrs, err := iface.Addrs()
	if err != nil {
		return "", fmt.Errorf("failed to get addresses for interface %s: %w", interfaceName, err)
	}

	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String(), nil
			}
		}
	}

	return "", fmt.Errorf("no IPv4 address found for interface %s", interfaceName)
}

// getInterfaceMAC returns the MAC address of the specified network interface
func getInterfaceMAC(interfaceName string) (net.HardwareAddr, error) {
	iface, err := net.InterfaceByName(interfaceName)
	if err != nil {
		return nil, fmt.Errorf("interface %s not found: %w", interfaceName, err)
	}

	if len(iface.HardwareAddr) == 0 {
		return nil, fmt.Errorf("interface %s has no MAC address", interfaceName)
	}

	return iface.HardwareAddr, nil
}

func main() {
	// Command-line flags
	urlFlag := flag.String("url", "http://localhost:8080", "UberSDR server URL (http://, https://, ws://, or wss://)")
	password := flag.String("password", "", "UberSDR server password (optional)")
	configFile := flag.String("config", "", "Frequency routing configuration file (optional, YAML format)")

	// HPSDR configuration
	hpsdrInterface := flag.String("interface", DefaultInterface, "Network interface to bind to (optional)")
	hpsdrIP := flag.String("ip", DefaultIPAddress, "IP address for HPSDR server")
	numReceivers := flag.Int("receivers", DefaultNumReceivers, "Number of receivers (1-4)")
	deviceType := flag.Int("device", int(DefaultDeviceType), "Device type (1=Hermes, 6=HermesLite)")
	debugDiscovery := flag.Bool("debug-discovery", false, "Enable debug logging for port 1024 discovery packets")
	debugFlag := flag.Bool("debug", false, "Enable verbose debug logging (bridge state, sync, receiver transitions)")

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
		fmt.Fprintf(os.Stderr, "        UberSDR server password (optional)\n")
		fmt.Fprintf(os.Stderr, "  -config string\n")
		fmt.Fprintf(os.Stderr, "        Frequency routing configuration file (optional, YAML format)\n")
		fmt.Fprintf(os.Stderr, "        See routing.yaml.example for format\n\n")
		fmt.Fprintf(os.Stderr, "HPSDR Emulation Options:\n")
		fmt.Fprintf(os.Stderr, "  -interface string\n")
		fmt.Fprintf(os.Stderr, "        Network interface to bind to (optional)\n")
		fmt.Fprintf(os.Stderr, "  -ip string\n")
		fmt.Fprintf(os.Stderr, "        IP address for HPSDR server (default \"0.0.0.0\")\n")
		fmt.Fprintf(os.Stderr, "  -receivers int\n")
		fmt.Fprintf(os.Stderr, "        Number of receivers 1-10 (default 10)\n")
		fmt.Fprintf(os.Stderr, "  -device int\n")
		fmt.Fprintf(os.Stderr, "        Device type: 1=Hermes, 6=HermesLite (default 6)\n")
		fmt.Fprintf(os.Stderr, "  -protocol int\n")
		fmt.Fprintf(os.Stderr, "        HPSDR protocol version: 0=auto-detect, 1=Protocol 1 only, 2=Protocol 2 only (default 0)\n")
		fmt.Fprintf(os.Stderr, "        0 (auto): Responds to both Protocol 1 and Protocol 2 clients\n")
		fmt.Fprintf(os.Stderr, "        1 (Protocol 1): Metis/Hermes format only (SDR Console)\n")
		fmt.Fprintf(os.Stderr, "        2 (Protocol 2): Hermes-Lite2 format only (Thetis, PowerSDR)\n")
		fmt.Fprintf(os.Stderr, "  -enable-microphone\n")
		fmt.Fprintf(os.Stderr, "        Enable microphone thread (for TX monitoring, not needed for RX-only)\n\n")
		fmt.Fprintf(os.Stderr, "Debug Options:\n")
		fmt.Fprintf(os.Stderr, "  -debug\n")
		fmt.Fprintf(os.Stderr, "        Enable verbose debug logging (bridge state, sync, receiver transitions)\n")
		fmt.Fprintf(os.Stderr, "        Logs: receiver enable/disable, LoadIQData waits, forwardToHPSDR packets,\n")
		fmt.Fprintf(os.Stderr, "              doneSendCond broadcasts, buffer drain, connection lifecycle\n\n")
		fmt.Fprintf(os.Stderr, "  -debug-discovery\n")
		fmt.Fprintf(os.Stderr, "        Enable detailed logging of port 1024 discovery packets\n")
		fmt.Fprintf(os.Stderr, "        Shows hex dumps of all packets received and sent\n\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  # Connect to local UberSDR server\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8080\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Connect to remote UberSDR server with TLS and password\n")
		fmt.Fprintf(os.Stderr, "  %s --url https://sdr.example.com --password mypass\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Emulate Hermes with 4 receivers\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8080 --device 1 --receivers 4\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Debug discovery packets (useful for troubleshooting SDR Console)\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8080 --debug-discovery\n\n", os.Args[0])
	}

	flag.Parse()

	// Enable verbose debug logging if requested (-debug flag)
	// Logs state transitions only: receiver enable/disable, running flag changes,
	// doneSendCond broadcasts, LoadIQData abort events, connection lifecycle.
	// Does NOT log per-packet hot-path events (those would be hundreds/sec).
	if *debugFlag {
		debugBridge = true
		log.Println("Debug logging enabled (-debug): state transitions, sync events, connection lifecycle")
	}

	// Enable discovery debug logging if requested
	if *debugDiscovery {
		SetDebugDiscovery(true)
		log.Println("Discovery debug logging enabled")
	}

	// Load routing configuration if specified
	var routingConfig *RoutingConfig
	if *configFile != "" {
		data, err := os.ReadFile(*configFile)
		if err != nil {
			log.Fatalf("Failed to read config file %s: %v", *configFile, err)
		}

		routingConfig = &RoutingConfig{}
		if err := yaml.Unmarshal(data, routingConfig); err != nil {
			log.Fatalf("Failed to parse config file %s: %v", *configFile, err)
		}

		// Command-line flags override config file defaults
		if *urlFlag != "http://localhost:8080" {
			log.Printf("Command-line -url flag overriding config default_url")
			routingConfig.DefaultURL = *urlFlag
		}
		if *password != "" {
			log.Printf("Command-line -password flag overriding config default_password")
			routingConfig.DefaultPassword = *password
		}

		// Initialize smart routing if enabled
		if routingConfig.SmartRouting != nil && routingConfig.SmartRouting.Enabled {
			// Initialize cache
			if routingConfig.SmartRouting.cache == nil {
				routingConfig.SmartRouting.cache = &InstanceCache{
					instances:   make([]CollectorInstance, 0),
					lastUpdated: time.Time{},
				}
			}

			// Initialize instance usage tracking
			if routingConfig.SmartRouting.instanceUsage == nil {
				routingConfig.SmartRouting.instanceUsage = make(map[string]int)
			}

			// Set defaults if not specified
			if routingConfig.SmartRouting.CollectorAPIURL == "" {
				routingConfig.SmartRouting.CollectorAPIURL = "https://instances.ubersdr.org"
			}
			if routingConfig.SmartRouting.Behavior.CheckIntervalSeconds == 0 {
				routingConfig.SmartRouting.Behavior.CheckIntervalSeconds = 300 // 5 minutes default
			}
			if routingConfig.SmartRouting.MaxConnectionsPerInstance == 0 {
				routingConfig.SmartRouting.MaxConnectionsPerInstance = 1 // Default to 1 connection per instance
			}

			log.Printf("Smart routing enabled:")
			log.Printf("  Collector API: %s", routingConfig.SmartRouting.CollectorAPIURL)
			log.Printf("  Location: %.4f, %.4f (max distance: %.0f km)",
				routingConfig.SmartRouting.Location.Latitude,
				routingConfig.SmartRouting.Location.Longitude,
				routingConfig.SmartRouting.Location.MaxDistanceKm)
			log.Printf("  Required bandwidth: %s", routingConfig.SmartRouting.RequiredBandwidth)
			log.Printf("  Max connections per instance: %d", routingConfig.SmartRouting.MaxConnectionsPerInstance)
			log.Printf("  Check interval: %d seconds", routingConfig.SmartRouting.Behavior.CheckIntervalSeconds)
			log.Printf("  Priority mode: %s", routingConfig.SmartRouting.Behavior.PriorityMode)
		}

		log.Printf("Loaded routing config with %d frequency ranges", len(routingConfig.FrequencyRanges))
		log.Printf("  Default URL: %s", routingConfig.DefaultURL)
		for i, fr := range routingConfig.FrequencyRanges {
			log.Printf("  Range %d: %s (%.3f-%.3f MHz) -> %s",
				i+1, fr.Name, float64(fr.MinFreq)/1e6, float64(fr.MaxFreq)/1e6, fr.URL)
		}
	}

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

	// Auto-discover IP address from interface if interface is specified but IP is not
	if *hpsdrInterface != "" && (*hpsdrIP == "" || *hpsdrIP == "0.0.0.0" || *hpsdrIP == DefaultIPAddress) {
		discoveredIP, err := getInterfaceIP(*hpsdrInterface)
		if err != nil {
			log.Fatalf("Failed to discover IP for interface %s: %v", *hpsdrInterface, err)
		}
		log.Printf("Auto-discovered IP %s for interface %s", discoveredIP, *hpsdrInterface)
		*hpsdrIP = discoveredIP
	}

	// Log the interface and IP configuration
	if *hpsdrInterface != "" {
		log.Printf("Binding to interface: %s, IP: %s", *hpsdrInterface, *hpsdrIP)
	} else if *hpsdrIP != "" && *hpsdrIP != "0.0.0.0" {
		log.Printf("Binding to IP: %s (no specific interface)", *hpsdrIP)
	} else {
		log.Printf("Binding to all interfaces (0.0.0.0)")
	}

	// Get MAC address from interface if specified, otherwise generate one
	var macAddr net.HardwareAddr
	if *hpsdrInterface != "" {
		var err error
		macAddr, err = getInterfaceMAC(*hpsdrInterface)
		if err != nil {
			log.Printf("Warning: Failed to get MAC address for interface %s: %v", *hpsdrInterface, err)
			log.Printf("Using generated MAC address instead")
			macAddr = net.HardwareAddr{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}
		} else {
			log.Printf("Using MAC address %s from interface %s", macAddr.String(), *hpsdrInterface)
		}
	} else {
		// HL2 MAC address structure per PROTOCOL.md and real hardware observation:
		//   Bytes 0-3: 00:1c:c0:a2  — fixed prefix (Microchip Technology OUI + fixed byte)
		//   Bytes 4-5: <Y>:<Z>       — user-configurable unit ID (auto-generated randomly)
		//
		// Real HL2 example: 00:1c:c0:a2:3f:15  (Y=63=0x3f, Z=21=0x15)
		// Discovery response bytes 17-18 (spec 0x11/0x12) must match MAC bytes 4-5 (Y:Z).
		//
		// We auto-generate Y and Z randomly so each bridge instance gets a unique ID
		// that won't conflict with real HL2s or other bridge instances on the network.
		unitID := make([]byte, 2)
		if _, err := rand.Read(unitID); err != nil {
			// Fallback if crypto/rand fails
			unitID = []byte{0x0a, 0x01}
			log.Printf("Warning: crypto/rand failed, using fallback unit ID: %v", err)
		}
		macAddr = net.HardwareAddr{0x00, 0x1c, 0xc0, 0xa2, unitID[0], unitID[1]}
		log.Printf("Using generated MAC address: %s (unit ID: %02x:%02x)", macAddr.String(), unitID[0], unitID[1])
	}

	hpsdr1Config := Protocol1Config{
		Interface:    *hpsdrInterface,
		IPAddress:    *hpsdrIP,
		MACAddress:   macAddr,
		NumReceivers: *numReceivers,
		DeviceType:   byte(*deviceType),
	}

	log.Printf("Using HPSDR Protocol 1 (Metis/Hermes) — compatible with SparkSDR, SDR Console")

	bridge, err := NewUberSDRBridge(*urlFlag, *password, hpsdr1Config, routingConfig)
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

	log.Printf("Bridge running - UberSDR at %s, HPSDR Protocol 1 on %s", *urlFlag, *hpsdrIP)
	log.Printf("Press Ctrl+C to stop")

	// Wait for signal
	<-sigChan
	log.Println("\nShutting down...")

	bridge.Stop()
	log.Println("Bridge stopped")
}
