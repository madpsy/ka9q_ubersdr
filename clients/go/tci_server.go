package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// TCIServer implements the Expert Electronics TCI protocol
// Allows JTDX and other TCI clients to connect to UberSDR
type TCIServer struct {
	port              int
	host              string
	radioClient       *RadioClient
	running           bool
	server            *http.Server
	clients           map[*websocket.Conn]bool
	clientsMu         sync.RWMutex
	connWriteMu       map[*websocket.Conn]*sync.Mutex // Per-connection write mutex
	connectedClientIP string

	// Callback for client connection changes
	clientChangeCallback func(connected bool)

	// Radio state
	deviceName      string
	protocolVersion string
	receiverCount   int
	channelCount    int
	vfoLimits       [2]int
	audioSampleRate int
	iqSampleRate    int
	audioStreaming  map[int]bool
	iqStreaming     map[int]bool
	vfoFrequencies  map[int]map[int]int // receiver -> vfo -> frequency
	modulations     map[int]string      // receiver -> mode
	splitEnabled    map[int]bool
	rxEnabled       map[int]bool
	pttState        map[int]bool
	powerOn         bool
	signalLevel     map[int]int // receiver -> signal level in dBm

	// Mode tracking
	currentIQMode string
	previousMode  string

	// Mode change debouncing
	lastModeChangeTime time.Time
	modeChangeCooldown time.Duration
	modeChangeLock     sync.Mutex

	// GUI callback for frequency/mode changes
	guiCallback func(paramType string, value interface{})

	// Upgrader for WebSocket connections
	upgrader websocket.Upgrader

	mu sync.RWMutex
}

// NewTCIServer creates a new TCI server instance
func NewTCIServer(radioClient *RadioClient, port int, host string, guiCallback func(string, interface{})) *TCIServer {
	// Initialize IQ sample rate from radio client's current mode
	iqSampleRate := 48000
	currentIQMode := ""
	initialMode := "usb"
	initialFreq := 14074000 // Default to FT8 frequency

	// If radioClient is provided, use its settings
	if radioClient != nil {
		if strings.HasPrefix(radioClient.mode, "iq") {
			// Extract sample rate from mode name (e.g., 'iq96' -> 96000)
			rateStr := strings.TrimPrefix(radioClient.mode, "iq")
			if rateKHz, err := strconv.Atoi(rateStr); err == nil {
				iqSampleRate = rateKHz * 1000
				currentIQMode = radioClient.mode
				log.Printf("TCI server: Initialized in %s mode with sample rate %d Hz", currentIQMode, iqSampleRate)
			}
		}
		initialMode = strings.ToLower(radioClient.mode)
		initialFreq = radioClient.frequency
	}

	// Map UberSDR modes to TCI modes
	tciMode := mapUberSDRModeToTCI(initialMode)

	server := &TCIServer{
		port:               port,
		host:               host,
		radioClient:        radioClient,
		running:            false,
		clients:            make(map[*websocket.Conn]bool),
		connWriteMu:        make(map[*websocket.Conn]*sync.Mutex),
		deviceName:         "UberSDR",
		protocolVersion:    "ubersdr,1.0",
		receiverCount:      2,
		channelCount:       2,
		vfoLimits:          [2]int{0, 60000000},
		audioSampleRate:    48000,
		iqSampleRate:       iqSampleRate,
		audioStreaming:     make(map[int]bool),
		iqStreaming:        make(map[int]bool),
		vfoFrequencies:     make(map[int]map[int]int),
		modulations:        make(map[int]string),
		splitEnabled:       make(map[int]bool),
		rxEnabled:          make(map[int]bool),
		pttState:           make(map[int]bool),
		powerOn:            true,
		signalLevel:        make(map[int]int),
		currentIQMode:      currentIQMode,
		modeChangeCooldown: 600 * time.Millisecond,
		guiCallback:        guiCallback,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for TCI protocol
			},
		},
	}

	// Initialize VFO frequencies
	for rx := 0; rx < server.receiverCount; rx++ {
		server.vfoFrequencies[rx] = make(map[int]int)
		server.vfoFrequencies[rx][0] = initialFreq // VFO A
		server.vfoFrequencies[rx][1] = initialFreq // VFO B
		server.modulations[rx] = tciMode
		server.splitEnabled[rx] = false
		server.rxEnabled[rx] = (rx == 0) // Only RX0 enabled by default
		server.pttState[rx] = false
		server.signalLevel[rx] = -127
	}

	return server
}

// Start starts the TCI server
func (s *TCIServer) Start() error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return fmt.Errorf("TCI server already running")
	}
	s.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleWebSocket)

	s.server = &http.Server{
		Addr:    fmt.Sprintf("%s:%d", s.host, s.port),
		Handler: mux,
	}

	log.Printf("TCI server: Starting on ws://%s:%d", s.host, s.port)

	// Create error channel to capture startup errors
	errChan := make(chan error, 1)

	go func() {
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("TCI server error: %v", err)
			errChan <- err
		}
	}()

	// Wait briefly to see if server starts successfully
	select {
	case err := <-errChan:
		// Server failed to start
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
		return fmt.Errorf("failed to start TCI server: %w", err)
	case <-time.After(100 * time.Millisecond):
		// Server appears to have started successfully
		s.mu.Lock()
		s.running = true
		s.mu.Unlock()
		log.Printf("✓ TCI server started on ws://%s:%d", s.host, s.port)
		return nil
	}
}

// Stop stops the TCI server
func (s *TCIServer) Stop() error {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return nil
	}
	s.running = false
	s.mu.Unlock()

	// Close all client connections
	s.clientsMu.Lock()
	for conn := range s.clients {
		conn.Close()
	}
	s.clients = make(map[*websocket.Conn]bool)
	s.clientsMu.Unlock()

	if s.server != nil {
		return s.server.Close()
	}
	return nil
}

// handleWebSocket handles incoming WebSocket connections
func (s *TCIServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Check if a client is already connected
	s.clientsMu.RLock()
	clientCount := len(s.clients)
	s.clientsMu.RUnlock()

	if clientCount > 0 {
		log.Printf("TCI client connection rejected from %s - client already connected", r.RemoteAddr)
		http.Error(w, "Only one TCI client allowed at a time", http.StatusForbidden)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("TCI WebSocket upgrade error: %v", err)
		return
	}

	s.clientsMu.Lock()
	s.clients[conn] = true
	s.connWriteMu[conn] = &sync.Mutex{} // Create write mutex for this connection
	s.connectedClientIP = strings.Split(r.RemoteAddr, ":")[0]
	clientChangeCallback := s.clientChangeCallback
	s.clientsMu.Unlock()

	log.Printf("TCI client connected from %s", r.RemoteAddr)

	// Notify about client connection
	if clientChangeCallback != nil {
		clientChangeCallback(true)
	}

	// Send initial state
	s.sendInitialState(conn)

	// Handle messages
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("TCI client disconnected normally")
			} else {
				log.Printf("TCI client error: %v", err)
			}
			break
		}

		s.processTextMessage(conn, string(message))
	}

	// Cleanup
	s.clientsMu.Lock()
	delete(s.clients, conn)
	delete(s.connWriteMu, conn) // Remove write mutex
	wasLastClient := len(s.clients) == 0
	if wasLastClient {
		s.connectedClientIP = ""
	}
	callback := s.clientChangeCallback
	s.clientsMu.Unlock()
	conn.Close()
	log.Printf("TCI client disconnected")

	// Notify about client disconnection if this was the last client
	if wasLastClient && callback != nil {
		callback(false)
	}
}

// sendInitialState sends initial radio state to newly connected client
func (s *TCIServer) sendInitialState(conn *websocket.Conn) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Send device info
	s.sendText(conn, fmt.Sprintf("device:%s;", s.deviceName))
	s.sendText(conn, fmt.Sprintf("protocol:%s;", s.protocolVersion))

	// Send receive-only status
	s.sendText(conn, "receive_only:true;")

	// Send receiver count
	s.sendText(conn, fmt.Sprintf("trx_count:%d;", s.receiverCount))

	// Send channel count
	s.sendText(conn, fmt.Sprintf("channel_count:%d;", s.channelCount))

	// Send VFO limits
	s.sendText(conn, fmt.Sprintf("vfo_limits:%d,%d;", s.vfoLimits[0], s.vfoLimits[1]))

	// Send IF limits
	s.sendText(conn, fmt.Sprintf("if_limits:%d,%d;", -48000, 48000))

	// Send modulation list
	s.sendText(conn, "modulations_list:am,sam,dsb,lsb,usb,cw,nfm,wfm,digl,digu,spec,drm;")

	// Send audio sample rate
	s.sendText(conn, fmt.Sprintf("audio_samplerate:%d;", s.audioSampleRate))

	// Send IQ sample rate
	s.sendText(conn, fmt.Sprintf("iq_samplerate:%d;", s.iqSampleRate))

	// Send current state for each receiver
	for rx := 0; rx < s.receiverCount; rx++ {
		// RX enable state
		s.sendText(conn, fmt.Sprintf("rx_enable:%d,%v;", rx, s.rxEnabled[rx]))

		// DDS (receiver center frequency)
		ddsFreq := s.vfoFrequencies[rx][0]
		s.sendText(conn, fmt.Sprintf("dds:%d,%d;", rx, ddsFreq))

		// VFO frequencies
		for vfo := 0; vfo < 2; vfo++ {
			freq := s.vfoFrequencies[rx][vfo]
			s.sendText(conn, fmt.Sprintf("vfo:%d,%d,%d;", rx, vfo, freq))
		}

		// Modulation
		s.sendText(conn, fmt.Sprintf("modulation:%d,%s;", rx, s.modulations[rx]))

		// Split state
		s.sendText(conn, fmt.Sprintf("split_enable:%d,%v;", rx, s.splitEnabled[rx]))

		// PTT state
		s.sendText(conn, fmt.Sprintf("trx:%d,%v;", rx, s.pttState[rx]))
	}

	// Send ready signal
	s.sendText(conn, "ready;")

	// Send power state
	if s.powerOn {
		s.sendText(conn, "start;")
	}
}

// processTextMessage processes incoming text messages (commands)
func (s *TCIServer) processTextMessage(conn *websocket.Conn, message string) {
	// Split multiple commands
	commands := strings.Split(strings.TrimSpace(message), ";")

	for _, cmd := range commands {
		cmd = strings.TrimSpace(cmd)
		if cmd == "" {
			continue
		}

		// Parse command and arguments
		var cmdName string
		var args []string

		if idx := strings.Index(cmd, ":"); idx != -1 {
			cmdName = cmd[:idx]
			argsStr := cmd[idx+1:]
			args = strings.Split(argsStr, ",")
		} else {
			cmdName = cmd
			args = []string{}
		}

		s.processCommand(conn, strings.ToLower(cmdName), args)
	}
}

// processCommand processes a single TCI command
func (s *TCIServer) processCommand(conn *websocket.Conn, cmd string, args []string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch cmd {
	case "dds":
		// Set DDS (receiver center frequency)
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			freq, _ := strconv.Atoi(args[1])
			s.setVFOFrequency(rx, 0, freq, false)
			s.broadcastText(fmt.Sprintf("dds:%d,%d;", rx, freq))
		} else if len(args) >= 1 {
			// Query DDS
			rx, _ := strconv.Atoi(args[0])
			freq := s.vfoFrequencies[rx][0]
			s.sendText(conn, fmt.Sprintf("dds:%d,%d;", rx, freq))
		}

	case "vfo":
		// Set VFO frequency
		if len(args) >= 3 {
			rx, _ := strconv.Atoi(args[0])
			vfo, _ := strconv.Atoi(args[1])
			freq, _ := strconv.Atoi(args[2])
			s.setVFOFrequency(rx, vfo, freq, false)
		}

	case "modulation":
		// Set modulation
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			mode := strings.ToLower(args[1])
			log.Printf("TCI server: Received modulation command - RX%d mode = %s", rx, mode)
			s.setModulation(rx, mode, false)
		}

	case "trx":
		// Set PTT
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			state := strings.ToLower(args[1]) == "true"
			s.setPTT(rx, state)
		}

	case "split_enable":
		// Set split
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			state := strings.ToLower(args[1]) == "true"
			s.setSplit(rx, state)
		}

	case "rx_enable":
		// Enable/disable receiver
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			state := strings.ToLower(args[1]) == "true"
			s.setRXEnable(rx, state)
		}

	case "audio_start":
		// Start audio streaming
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.startAudioStreaming(rx)
		}

	case "audio_stop":
		// Stop audio streaming
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.stopAudioStreaming(rx)
		}

	case "iq_samplerate":
		// Set IQ sample rate
		if len(args) >= 1 {
			rate, _ := strconv.Atoi(args[0])
			log.Printf("TCI server: Received iq_samplerate command from client: %d Hz", rate)
			s.setIQSampleRate(rate)
		}

	case "iq_start":
		// Start IQ streaming
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.startIQStreaming(rx)
		}

	case "iq_stop":
		// Stop IQ streaming
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.stopIQStreaming(rx)
		}

	case "start":
		// Power on
		s.powerOn = true
		s.broadcastText("start;")

	case "stop":
		// Power off
		s.powerOn = false
		s.broadcastText("stop;")

	case "device":
		// Query device name
		s.sendText(conn, fmt.Sprintf("device:%s;", s.deviceName))

	case "protocol":
		// Query protocol version
		s.sendText(conn, fmt.Sprintf("protocol:%s;", s.protocolVersion))

	case "rx_smeter":
		// S-meter query
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			channel, _ := strconv.Atoi(args[1])
			level := s.signalLevel[rx]
			s.sendText(conn, fmt.Sprintf("rx_smeter:%d,%d,%d;", rx, channel, level))
		}

	case "if_limits", "if":
		// Query IF limits
		s.sendText(conn, "if_limits:-48000,48000;")

	case "drive":
		// TX power control - receive-only
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.sendText(conn, fmt.Sprintf("drive:%d,0;", rx))
		} else {
			s.sendText(conn, "drive:0,0;")
		}

	case "tune_drive":
		// Tune power control - receive-only
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.sendText(conn, fmt.Sprintf("tune_drive:%d,0;", rx))
		} else {
			s.sendText(conn, "tune_drive:0,0;")
		}

	case "tune":
		// Tune mode - receive-only
		if len(args) >= 2 {
			rx, _ := strconv.Atoi(args[0])
			s.sendText(conn, fmt.Sprintf("tune:%d,false;", rx))
		}

	case "tx_enable":
		// TX enable query - receive-only
		if len(args) >= 1 {
			rx, _ := strconv.Atoi(args[0])
			s.sendText(conn, fmt.Sprintf("tx_enable:%d,false;", rx))
		}

	default:
		// Unknown command - log but don't error
		log.Printf("Unknown TCI command: %s", cmd)
	}
}

// setVFOFrequency sets VFO frequency
func (s *TCIServer) setVFOFrequency(rx, vfo, freq int, skipCallback bool) {
	if _, ok := s.vfoFrequencies[rx]; !ok {
		return
	}

	s.vfoFrequencies[rx][vfo] = freq

	log.Printf("TCI server: Received frequency change - RX%d VFO%d = %.6f MHz", rx, vfo, float64(freq)/1e6)

	// Update GUI if this is the active receiver and RX VFO
	if rx == 0 && vfo == 0 && s.guiCallback != nil && !skipCallback {
		s.guiCallback("frequency", freq)
	}

	// Broadcast to all clients
	if vfo == 0 {
		s.broadcastText(fmt.Sprintf("dds:%d,%d;", rx, freq))
	}
	s.broadcastText(fmt.Sprintf("vfo:%d,%d,%d;", rx, vfo, freq))
}

// setModulation sets modulation mode
func (s *TCIServer) setModulation(rx int, mode string, skipCallback bool) {
	if _, ok := s.modulations[rx]; !ok {
		return
	}

	// Only update if mode actually changed
	if s.modulations[rx] == mode {
		log.Printf("TCI server: Modulation already set to %s, no change needed", mode)
		return
	}

	s.modulations[rx] = mode

	// Modulation command only updates TCI state, not radio mode
	// Radio mode only changes when audio streaming is explicitly requested
	audioModes := []string{"usb", "lsb", "cw", "digu", "digl", "am", "sam", "fm", "nfm", "wfm"}
	isAudioMode := false
	for _, m := range audioModes {
		if mode == m {
			isAudioMode = true
			break
		}
	}

	if isAudioMode && s.radioClient != nil {
		currentMode := strings.ToLower(s.radioClient.mode)
		if strings.HasPrefix(currentMode, "iq") {
			// In IQ mode: just save the modulation for when audio is requested
			radioMode := mapTCIModeToUberSDR(mode)
			s.previousMode = radioMode
			log.Printf("TCI server: Modulation set to %s (saved as %s, will apply when audio requested)", mode, radioMode)
		}
	}

	// Update GUI if this is the active receiver
	if rx == 0 && s.guiCallback != nil && !skipCallback {
		// Skip GUI callback if we're currently in IQ mode
		if s.currentIQMode != "" {
			log.Printf("TCI server: Skipping GUI callback for modulation change while in IQ mode")
		} else {
			uberSDRMode := mapTCIModeToUberSDR(mode)
			s.guiCallback("mode", uberSDRMode)
		}
	}

	// Broadcast to all clients
	s.broadcastText(fmt.Sprintf("modulation:%d,%s;", rx, mode))
}

// setPTT sets PTT state
func (s *TCIServer) setPTT(rx int, state bool) {
	if _, ok := s.pttState[rx]; !ok {
		return
	}
	s.pttState[rx] = state
	s.broadcastText(fmt.Sprintf("trx:%d,%v;", rx, state))
}

// setSplit sets split operation state
func (s *TCIServer) setSplit(rx int, state bool) {
	if _, ok := s.splitEnabled[rx]; !ok {
		return
	}
	s.splitEnabled[rx] = state
	s.broadcastText(fmt.Sprintf("split_enable:%d,%v;", rx, state))
}

// setRXEnable enables/disables receiver
func (s *TCIServer) setRXEnable(rx int, state bool) {
	if _, ok := s.rxEnabled[rx]; !ok {
		return
	}
	s.rxEnabled[rx] = state
	s.broadcastText(fmt.Sprintf("rx_enable:%d,%v;", rx, state))
}

// startAudioStreaming starts audio streaming for receiver
func (s *TCIServer) startAudioStreaming(rx int) {
	s.audioStreaming[rx] = true
	log.Printf("TCI server: Audio streaming STARTED for RX%d", rx)

	// Trigger auto-connect if not connected (via GUI callback)
	// This ensures SDR connection when TCI client requests audio
	if s.guiCallback != nil {
		// Use a dummy frequency command to trigger the auto-connect logic
		// The callback will check if connected and auto-connect if needed
		freq := s.vfoFrequencies[rx][0]
		log.Printf("TCI server: Triggering auto-connect check via frequency callback (%d Hz)", freq)
		s.guiCallback("frequency", freq)
	}

	// If currently in IQ mode, switch back to previous audio mode
	if s.currentIQMode != "" {
		// Restore previous mode, or default to USB if none saved
		restoreMode := s.previousMode
		if restoreMode == "" {
			restoreMode = "usb"
		}
		log.Printf("TCI server: Switching from IQ mode to %s for audio streaming", restoreMode)

		// Use debounced mode change
		s.debouncedModeChange(restoreMode, false)
	}

	// Broadcast to all clients
	s.broadcastText(fmt.Sprintf("audio_start:%d;", rx))
}

// stopAudioStreaming stops audio streaming for receiver
func (s *TCIServer) stopAudioStreaming(rx int) {
	s.audioStreaming[rx] = false
	s.broadcastText(fmt.Sprintf("audio_stop:%d;", rx))
}

// setIQSampleRate sets IQ sample rate
func (s *TCIServer) setIQSampleRate(rate int) {
	// Validate sample rate
	validRates := []int{48000, 96000, 192000, 384000}
	valid := false
	for _, r := range validRates {
		if rate == r {
			valid = true
			break
		}
	}
	if !valid {
		log.Printf("TCI server: Invalid IQ sample rate %d, using 48000", rate)
		rate = 48000
	}

	// Check if this rate is allowed by the radio client instance
	rateToMode := map[int]string{
		48000:  "iq48",
		96000:  "iq96",
		192000: "iq192",
		384000: "iq384",
	}

	modeName := rateToMode[rate]
	if modeName != "" && s.radioClient != nil && len(s.radioClient.allowedIQModes) > 0 {
		allowed := false
		for _, mode := range s.radioClient.allowedIQModes {
			if mode == modeName {
				allowed = true
				break
			}
		}
		if !allowed {
			log.Printf("TCI server: IQ sample rate %d Hz (%s) not allowed by this instance", rate, modeName)
			log.Printf("TCI server: Allowed IQ modes: %v", s.radioClient.allowedIQModes)

			// Find the highest allowed rate
			allowedRates := []int{}
			for _, mode := range s.radioClient.allowedIQModes {
				if strings.HasPrefix(mode, "iq") {
					rateStr := strings.TrimPrefix(mode, "iq")
					if rateKHz, err := strconv.Atoi(rateStr); err == nil {
						allowedRates = append(allowedRates, rateKHz*1000)
					}
				}
			}

			if len(allowedRates) > 0 {
				rate = allowedRates[0]
				for _, r := range allowedRates {
					if r > rate {
						rate = r
					}
				}
				log.Printf("TCI server: Using highest allowed rate: %d Hz", rate)
			} else {
				log.Printf("TCI server: No IQ modes allowed by this instance")
				return
			}
		}
	}

	// Only update if rate actually changed
	if s.iqSampleRate != rate {
		s.iqSampleRate = rate
		log.Printf("TCI server: IQ sample rate set to %d Hz", rate)

		// If TCI client is requesting a different rate than current IQ mode,
		// switch to the appropriate IQ mode
		targetMode := rateToMode[rate]
		if targetMode != "" && s.currentIQMode != targetMode {
			log.Printf("TCI server: TCI client requested %d Hz, switching from %s to %s", rate, s.currentIQMode, targetMode)
			s.currentIQMode = targetMode
			if s.guiCallback != nil {
				s.guiCallback("mode", strings.ToUpper(targetMode))
			}
		}

		// Broadcast to all clients
		s.broadcastText(fmt.Sprintf("iq_samplerate:%d;", rate))
	} else {
		log.Printf("TCI server: IQ sample rate already %d Hz, no change needed", rate)
	}
}

// startIQStreaming starts IQ streaming for receiver
func (s *TCIServer) startIQStreaming(rx int) {
	s.iqStreaming[rx] = true

	// If we're already in an IQ mode, keep that mode
	if s.currentIQMode != "" {
		modeToRate := map[string]int{
			"iq48":  48000,
			"iq96":  96000,
			"iq192": 192000,
			"iq384": 384000,
		}
		currentRate := modeToRate[s.currentIQMode]
		if currentRate == 0 {
			currentRate = s.iqSampleRate
		}
		log.Printf("TCI server: IQ streaming STARTED for RX%d at %d Hz (already in %s mode)", rx, currentRate, s.currentIQMode)
	} else {
		// Not in IQ mode yet - determine target mode based on sample rate
		log.Printf("TCI server: IQ streaming STARTED for RX%d at %d Hz", rx, s.iqSampleRate)

		rateToMode := map[int]string{
			48000:  "iq48",
			96000:  "iq96",
			192000: "iq192",
			384000: "iq384",
		}
		iqMode := rateToMode[s.iqSampleRate]
		if iqMode == "" {
			iqMode = "iq48"
		}

		// Need to switch to IQ mode - use debounced mode change
		s.debouncedModeChange(iqMode, true)
	}

	// Broadcast IQ start to all clients
	s.broadcastText(fmt.Sprintf("iq_start:%d;", rx))

	// Send current center frequency
	freq := s.vfoFrequencies[rx][0]
	log.Printf("TCI server: Sending center frequency to client: RX%d = %.6f MHz", rx, float64(freq)/1e6)
	s.broadcastText(fmt.Sprintf("dds:%d,%d;", rx, freq))
	s.broadcastText(fmt.Sprintf("vfo:%d,0,%d;", rx, freq))
}

// stopIQStreaming stops IQ streaming for receiver
func (s *TCIServer) stopIQStreaming(rx int) {
	s.iqStreaming[rx] = false
	log.Printf("TCI server: IQ streaming STOPPED for RX%d", rx)
	s.broadcastText(fmt.Sprintf("iq_stop:%d;", rx))
}

// debouncedModeChange performs a debounced mode change
func (s *TCIServer) debouncedModeChange(targetMode string, isIQMode bool) {
	s.modeChangeLock.Lock()
	defer s.modeChangeLock.Unlock()

	currentTime := time.Now()
	timeSinceLastChange := currentTime.Sub(s.lastModeChangeTime)

	if timeSinceLastChange < s.modeChangeCooldown {
		// Too soon - wait for cooldown
		waitTime := s.modeChangeCooldown - timeSinceLastChange
		log.Printf("TCI server: Mode change debounced, waiting %.3fs before switching to %s", waitTime.Seconds(), targetMode)
		time.Sleep(waitTime)
	}

	// Perform the mode change
	if isIQMode {
		// Switching to IQ mode
		var currentMode string
		if s.radioClient != nil {
			currentMode = strings.ToLower(s.radioClient.mode)
		}

		// If switching from audio mode, save it
		if currentMode != "" && !strings.HasPrefix(currentMode, "iq") && s.currentIQMode == "" {
			s.previousMode = currentMode
			log.Printf("TCI server: Saved previous mode: %s", s.previousMode)
		}

		if s.currentIQMode != "" {
			log.Printf("TCI server: Switching from %s to %s mode", s.currentIQMode, targetMode)
		} else {
			log.Printf("TCI server: Switching to %s mode", targetMode)
		}

		s.currentIQMode = targetMode

		// Use GUI callback to change mode
		if s.guiCallback != nil {
			s.guiCallback("mode", strings.ToUpper(targetMode))
		}
	} else {
		// Switching to audio mode
		// Clear saved mode and IQ mode tracking
		s.previousMode = ""
		s.currentIQMode = ""

		// Use GUI callback to change mode
		if s.guiCallback != nil {
			s.guiCallback("mode", strings.ToUpper(targetMode))
		}
	}

	// Update last mode change time
	s.lastModeChangeTime = time.Now()
}

// sendText sends text message to specific client
func (s *TCIServer) sendText(conn *websocket.Conn, message string) {
	// Get write mutex for this connection
	s.clientsMu.RLock()
	writeMu, ok := s.connWriteMu[conn]
	s.clientsMu.RUnlock()

	if !ok {
		return // Connection no longer exists
	}

	// Lock for writing
	writeMu.Lock()
	defer writeMu.Unlock()

	if err := conn.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
		log.Printf("Error sending TCI text message: %v", err)
	}
}

// broadcastText broadcasts text message to all connected clients
func (s *TCIServer) broadcastText(message string) {
	s.clientsMu.RLock()
	clients := make([]*websocket.Conn, 0, len(s.clients))
	for conn := range s.clients {
		clients = append(clients, conn)
	}
	s.clientsMu.RUnlock()

	for _, conn := range clients {
		// Get write mutex for this connection
		s.clientsMu.RLock()
		writeMu, ok := s.connWriteMu[conn]
		s.clientsMu.RUnlock()

		if !ok {
			continue // Connection no longer exists
		}

		// Lock for writing
		writeMu.Lock()
		if err := conn.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
			log.Printf("Error broadcasting TCI message: %v", err)
		}
		writeMu.Unlock()
	}
}

// SendAudioData sends audio data to connected clients
func (s *TCIServer) SendAudioData(rx int, audioData []byte, sampleRate int) {
	s.mu.RLock()
	if !s.audioStreaming[rx] {
		s.mu.RUnlock()
		return
	}
	s.mu.RUnlock()

	s.clientsMu.RLock()
	if len(s.clients) == 0 {
		s.clientsMu.RUnlock()
		return
	}
	s.clientsMu.RUnlock()

	// Create TCI audio frame header (64 bytes)
	// Format: receiver, sampleRate, format, codec, crc, length, type, reserved[9]
	numFloats := len(audioData) / 4

	header := make([]byte, 64)
	binary.LittleEndian.PutUint32(header[0:4], uint32(rx))          // receiver
	binary.LittleEndian.PutUint32(header[4:8], uint32(sampleRate))  // sampleRate
	binary.LittleEndian.PutUint32(header[8:12], 3)                  // format: float32
	binary.LittleEndian.PutUint32(header[12:16], 0)                 // codec
	binary.LittleEndian.PutUint32(header[16:20], 0)                 // crc
	binary.LittleEndian.PutUint32(header[20:24], uint32(numFloats)) // length: total floats
	binary.LittleEndian.PutUint32(header[24:28], 1)                 // type: RxAudioStream
	// reserved[9] already zero

	// Combine header and audio data
	frame := append(header, audioData...)

	// Broadcast to all clients
	s.clientsMu.RLock()
	clients := make([]*websocket.Conn, 0, len(s.clients))
	for conn := range s.clients {
		clients = append(clients, conn)
	}
	s.clientsMu.RUnlock()

	for _, conn := range clients {
		// Get write mutex for this connection
		s.clientsMu.RLock()
		writeMu, ok := s.connWriteMu[conn]
		s.clientsMu.RUnlock()

		if !ok {
			continue // Connection no longer exists
		}

		// Lock for writing
		writeMu.Lock()
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			log.Printf("Error sending TCI audio frame: %v", err)
		}
		writeMu.Unlock()
	}
}

// SendIQData sends IQ data to connected clients
func (s *TCIServer) SendIQData(rx int, iqData []byte, sampleRate int) {
	s.mu.RLock()
	if !s.iqStreaming[rx] {
		s.mu.RUnlock()
		return
	}
	s.mu.RUnlock()

	s.clientsMu.RLock()
	if len(s.clients) == 0 {
		s.clientsMu.RUnlock()
		return
	}
	s.clientsMu.RUnlock()

	// Create TCI IQ frame header (64 bytes)
	// Format: receiver, sampleRate, format, codec, crc, length, type, channels, reserved[8]
	numFloats := len(iqData) / 4

	header := make([]byte, 64)
	binary.LittleEndian.PutUint32(header[0:4], uint32(rx))          // receiver
	binary.LittleEndian.PutUint32(header[4:8], uint32(sampleRate))  // sampleRate
	binary.LittleEndian.PutUint32(header[8:12], 3)                  // format: float32
	binary.LittleEndian.PutUint32(header[12:16], 0)                 // codec
	binary.LittleEndian.PutUint32(header[16:20], 0)                 // crc
	binary.LittleEndian.PutUint32(header[20:24], uint32(numFloats)) // length: total floats
	binary.LittleEndian.PutUint32(header[24:28], 0)                 // type: IQ_STREAM
	binary.LittleEndian.PutUint32(header[28:32], 2)                 // channels: 2 (I and Q)
	// reserved[8] already zero

	// Combine header and IQ data
	frame := append(header, iqData...)

	// Broadcast to all clients
	s.clientsMu.RLock()
	clients := make([]*websocket.Conn, 0, len(s.clients))
	for conn := range s.clients {
		clients = append(clients, conn)
	}
	s.clientsMu.RUnlock()

	for _, conn := range clients {
		// Get write mutex for this connection
		s.clientsMu.RLock()
		writeMu, ok := s.connWriteMu[conn]
		s.clientsMu.RUnlock()

		if !ok {
			continue // Connection no longer exists
		}

		// Lock for writing
		writeMu.Lock()
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			log.Printf("Error sending TCI IQ frame: %v", err)
		}
		writeMu.Unlock()
	}
}

// UpdateFrequency updates frequency from radio client
func (s *TCIServer) UpdateFrequency(freqHz int, rx int, vfo int, skipCallback bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setVFOFrequency(rx, vfo, freqHz, skipCallback)
}

// UpdateMode updates mode from radio client
func (s *TCIServer) UpdateMode(mode string, rx int, skipCallback bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if this is an IQ mode change
	modeLower := strings.ToLower(mode)
	if strings.HasPrefix(modeLower, "iq") {
		// Extract sample rate from mode name
		rateStr := strings.TrimPrefix(modeLower, "iq")
		if rateKHz, err := strconv.Atoi(rateStr); err == nil {
			newRate := rateKHz * 1000

			// Update IQ sample rate and notify TCI clients
			if s.iqSampleRate != newRate {
				log.Printf("TCI server: IQ mode changed to %s, updating sample rate to %d Hz", mode, newRate)
				s.iqSampleRate = newRate
				s.broadcastText(fmt.Sprintf("iq_samplerate:%d;", newRate))
			}

			// Update current IQ mode tracking
			s.currentIQMode = modeLower
			return
		}
	}

	// Map UberSDR modes to TCI modes
	tciMode := mapUberSDRModeToTCI(modeLower)
	s.setModulation(rx, tciMode, skipCallback)
}

// UpdateSignalLevel updates signal level from spectrum data
func (s *TCIServer) UpdateSignalLevel(levelDBm float64, rx int) {
	s.mu.Lock()
	s.signalLevel[rx] = int(levelDBm)
	s.mu.Unlock()

	// Broadcast to all clients
	s.clientsMu.RLock()
	clients := make([]*websocket.Conn, 0, len(s.clients))
	for conn := range s.clients {
		clients = append(clients, conn)
	}
	s.clientsMu.RUnlock()

	msg := fmt.Sprintf("rx_smeter:%d,0,%d;", rx, int(levelDBm))
	for _, conn := range clients {
		// Get write mutex for this connection
		s.clientsMu.RLock()
		writeMu, ok := s.connWriteMu[conn]
		s.clientsMu.RUnlock()

		if !ok {
			continue // Connection no longer exists
		}

		// Lock for writing
		writeMu.Lock()
		conn.WriteMessage(websocket.TextMessage, []byte(msg))
		writeMu.Unlock()
	}
}

// GetConnectedClientIP returns the IP address of the connected client
func (s *TCIServer) GetConnectedClientIP() string {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	return s.connectedClientIP
}

// Helper functions for mode mapping

// mapUberSDRModeToTCI maps UberSDR mode names to TCI mode names
func mapUberSDRModeToTCI(mode string) string {
	modeMap := map[string]string{
		"usb": "usb",
		"lsb": "lsb",
		"cw":  "cw",
		"cwu": "cw",
		"cwl": "cw",
		"am":  "am",
		"sam": "sam",
		"fm":  "nfm",
		"nfm": "nfm",
		"wfm": "wfm",
	}
	if tciMode, ok := modeMap[mode]; ok {
		return tciMode
	}
	return "usb"
}

// mapTCIModeToUberSDR maps TCI mode names to UberSDR mode names
func mapTCIModeToUberSDR(mode string) string {
	modeMap := map[string]string{
		"usb":  "usb",
		"lsb":  "lsb",
		"cw":   "cwu",
		"digu": "usb",
		"digl": "lsb",
		"am":   "am",
		"sam":  "sam",
		"fm":   "fm",
		"nfm":  "nfm",
		"wfm":  "fm",
	}
	if uberSDRMode, ok := modeMap[mode]; ok {
		return uberSDRMode
	}
	return "usb"
}

// ConvertPCMToFloat32 converts PCM int16 audio to float32 for TCI
func ConvertPCMToFloat32(pcmData []byte, channels int) []byte {
	numSamples := len(pcmData) / 2
	floatData := make([]float32, numSamples)

	for i := 0; i < numSamples; i++ {
		sample := int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
		floatData[i] = float32(sample) / 32768.0
	}

	// Convert float32 array to bytes (little-endian)
	result := make([]byte, len(floatData)*4)
	for i, f := range floatData {
		bits := math.Float32bits(f)
		binary.LittleEndian.PutUint32(result[i*4:], bits)
	}

	return result
}

// IsRunning returns whether the TCI server is running
func (s *TCIServer) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.running
}

// GetStatus returns the current TCI server status
func (s *TCIServer) GetStatus() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	s.clientsMu.RLock()
	clientCount := len(s.clients)
	clientIP := s.connectedClientIP
	s.clientsMu.RUnlock()

	return map[string]interface{}{
		"running":           s.running,
		"port":              s.port,
		"host":              s.host,
		"clientConnected":   clientCount > 0,
		"connectedClientIP": clientIP,
		"audioStreaming":    s.audioStreaming[0],
		"iqStreaming":       s.iqStreaming[0],
		"currentMode":       s.modulations[0],
		"frequency":         s.vfoFrequencies[0][0],
	}
}

// GetClientCount returns the number of connected TCI clients
func (s *TCIServer) GetClientCount() int {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	return len(s.clients)
}
