package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// KiwiWebSocketHandler handles KiwiSDR-compatible WebSocket connections
type KiwiWebSocketHandler struct {
	sessions           *SessionManager
	audioReceiver      *AudioReceiver
	config             *Config
	ipBanManager       *IPBanManager
	rateLimiterManager *RateLimiterManager
	connRateLimiter    *IPConnectionRateLimiter
	prometheusMetrics  *PrometheusMetrics
}

// NewKiwiWebSocketHandler creates a new KiwiSDR WebSocket handler
func NewKiwiWebSocketHandler(sessions *SessionManager, audioReceiver *AudioReceiver, config *Config, ipBanManager *IPBanManager, rateLimiterManager *RateLimiterManager, connRateLimiter *IPConnectionRateLimiter, prometheusMetrics *PrometheusMetrics) *KiwiWebSocketHandler {
	return &KiwiWebSocketHandler{
		sessions:           sessions,
		audioReceiver:      audioReceiver,
		config:             config,
		ipBanManager:       ipBanManager,
		rateLimiterManager: rateLimiterManager,
		connRateLimiter:    connRateLimiter,
		prometheusMetrics:  prometheusMetrics,
	}
}

// HandleKiwiStatus handles KiwiSDR /status HTTP endpoint
// Returns server status in KiwiSDR key=value format
func (kwsh *KiwiWebSocketHandler) HandleKiwiStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)

	// Get current user count (non-bypassed users only)
	currentUsers := kwsh.sessions.GetNonBypassedUserCount()
	maxUsers := kwsh.config.Server.MaxSessions

	// Build status response in KiwiSDR format (key=value pairs, one per line)
	var status strings.Builder

	// Basic status
	status.WriteString("status=active\n")
	status.WriteString("offline=no\n")

	// Server name and location
	if kwsh.config.Admin.Name != "" {
		status.WriteString(fmt.Sprintf("name=%s\n", kwsh.config.Admin.Name))
	} else {
		status.WriteString("name=UberSDR\n")
	}

	// Hardware info
	status.WriteString(fmt.Sprintf("sdr_hw=UberSDR %s\n", Version))

	// Admin email
	if kwsh.config.Admin.Email != "" {
		status.WriteString(fmt.Sprintf("op_email=%s\n", kwsh.config.Admin.Email))
	}

	// Frequency range (0-30 MHz in Hz)
	status.WriteString("bands=0-30000000\n")
	status.WriteString("freq_offset=0.000\n")

	// User counts
	status.WriteString(fmt.Sprintf("users=%d\n", currentUsers))
	status.WriteString(fmt.Sprintf("users_max=%d\n", maxUsers))
	status.WriteString("preempt=0\n")

	// GPS coordinates
	if kwsh.config.Admin.GPS.Lat != 0 || kwsh.config.Admin.GPS.Lon != 0 {
		status.WriteString(fmt.Sprintf("gps=(%.6f, %.6f)\n", kwsh.config.Admin.GPS.Lat, kwsh.config.Admin.GPS.Lon))

		// Calculate grid square from lat/lon
		gridSquare := latLonToGridSquare(kwsh.config.Admin.GPS.Lat, kwsh.config.Admin.GPS.Lon)
		status.WriteString(fmt.Sprintf("grid=%s\n", gridSquare))

		status.WriteString("gps_good=1\n")
	} else {
		status.WriteString("gps_good=0\n")
	}

	// GPS fix stats (dummy values)
	status.WriteString("fixes=0\n")
	status.WriteString("fixes_min=0\n")
	status.WriteString("fixes_hour=0\n")

	// TDoA info (if callsign is set)
	if kwsh.config.Admin.Callsign != "" {
		status.WriteString(fmt.Sprintf("tdoa_id=%s\n", kwsh.config.Admin.Callsign))
		status.WriteString("tdoa_ch=1\n")
	}

	// Altitude above sea level
	if kwsh.config.Admin.ASL > 0 {
		status.WriteString(fmt.Sprintf("asl=%d\n", kwsh.config.Admin.ASL))
	}

	// Location string
	if kwsh.config.Admin.Location != "" {
		status.WriteString(fmt.Sprintf("loc=%s\n", kwsh.config.Admin.Location))
	}

	// Software version
	status.WriteString(fmt.Sprintf("sw_version=UberSDR_%s\n", Version))

	// Antenna info (dummy value - could be added to config later)
	status.WriteString("antenna=Multi-band HF antenna\n")

	// SNR (dummy values)
	status.WriteString("snr=20,20\n")
	status.WriteString("ant_connected=1\n")

	// ADC overflow count (dummy)
	status.WriteString("adc_ov=0\n")

	// Clock info (dummy values)
	status.WriteString("clk_ext_freq=0\n")
	status.WriteString("clk_ext_gps=0,0\n")

	// Uptime in seconds
	uptime := int(time.Since(StartTime).Seconds())
	status.WriteString(fmt.Sprintf("uptime=%d\n", uptime))

	// Current date/time
	now := time.Now()
	status.WriteString(fmt.Sprintf("gps_date=0,0\n"))
	status.WriteString(fmt.Sprintf("date=%s\n", now.Format("Mon Jan _2 15:04:05 2006")))

	// IP blacklist (dummy)
	status.WriteString("ip_blacklist=00000000\n")

	// DX file info (dummy)
	status.WriteString("dx_file=0,00000000,0\n")

	w.Write([]byte(status.String()))
}

// latLonToGridSquare converts latitude/longitude to Maidenhead grid square
func latLonToGridSquare(lat, lon float64) string {
	// Adjust longitude to 0-360 range
	adjLon := lon + 180.0
	adjLat := lat + 90.0

	// Calculate field (first two characters)
	field1 := byte('A' + int(adjLon/20.0))
	field2 := byte('A' + int(adjLat/10.0))

	// Calculate square (next two digits)
	square1 := byte('0' + int(math.Mod(adjLon/2.0, 10)))
	square2 := byte('0' + int(math.Mod(adjLat, 10)))

	// Calculate subsquare (last two characters, lowercase)
	subsq1 := byte('a' + int(math.Mod(adjLon*12.0, 24)))
	subsq2 := byte('a' + int(math.Mod(adjLat*24.0, 24)))

	return string([]byte{field1, field2, square1, square2, subsq1, subsq2})
}

// HandleKiwiWebSocket handles KiwiSDR-compatible WebSocket connections
// Path format: /<timestamp>/<type> where type is "SND" or "W/F"
// When running on dedicated port, accepts paths like: /1234567890/SND
func (kwsh *KiwiWebSocketHandler) HandleKiwiWebSocket(w http.ResponseWriter, r *http.Request) {
	// Parse path: /<timestamp>/<type> or /kiwi/<timestamp>/<type>
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")

	// Support both formats:
	// - /<timestamp>/SND (when on dedicated port)
	// - /kiwi/<timestamp>/SND (when on main port with /kiwi/ prefix)
	var timestamp, connType string

	if len(parts) >= 2 {
		if parts[0] == "kiwi" && len(parts) >= 3 {
			// /kiwi/<timestamp>/<type> format
			timestamp = parts[1]
			connType = strings.Join(parts[2:], "/")
		} else {
			// /<timestamp>/<type> format (native KiwiSDR)
			timestamp = parts[0]
			connType = strings.Join(parts[1:], "/")
		}
	} else {
		http.Error(w, "Invalid path format. Expected: /<timestamp>/SND or /<timestamp>/W/F", http.StatusBadRequest)
		return
	}

	log.Printf("KiwiSDR client connecting: timestamp=%s, type=%s", timestamp, connType)

	// Get client IP
	sourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = host
	}
	clientIP := getClientIP(r)

	// Check if IP is banned
	if kwsh.ipBanManager.IsBanned(clientIP) {
		log.Printf("Rejected KiwiSDR connection from banned IP: %s", clientIP)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Skip connection rate limit for KiwiSDR protocol
	// KiwiSDR clients need to open 2 connections rapidly (SND + W/F)
	// Rate limiting is still enforced at the command level via rateLimiterManager

	// Upgrade to WebSocket
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade KiwiSDR connection: %v", err)
		return
	}

	conn := &wsConn{conn: rawConn, aggregator: globalStatsAudio}
	globalStatsAudio.addConnection()

	defer func() {
		globalStatsAudio.removeConnection()
		if err := conn.close(); err != nil {
			log.Printf("Error closing KiwiSDR connection: %v", err)
		}
	}()

	// Create Kiwi connection handler
	kc := &kiwiConn{
		conn:               conn,
		connType:           connType,
		sourceIP:           sourceIP,
		clientIP:           clientIP,
		sessions:           kwsh.sessions,
		audioReceiver:      kwsh.audioReceiver,
		config:             kwsh.config,
		rateLimiterManager: kwsh.rateLimiterManager,
		sequence:           0,
		compression:        true,
		wfCompression:      true,
		password:           "",
		adpcmEncoder:       NewIMAAdpcmEncoder(),
		wfAdpcmEncoder:     NewIMAAdpcmEncoder(),
	}

	// Handle the connection
	kc.handle()
}

// kiwiConn represents a single KiwiSDR client connection
type kiwiConn struct {
	conn               *wsConn
	connType           string // "SND" or "W/F"
	sourceIP           string
	clientIP           string
	sessions           *SessionManager
	audioReceiver      *AudioReceiver
	config             *Config
	rateLimiterManager *RateLimiterManager
	session            *Session
	userSessionID      string
	sequence           uint32
	compression        bool
	wfCompression      bool // Waterfall compression (separate from audio)
	password           string
	adpcmEncoder       *IMAAdpcmEncoder // ADPCM encoder for audio compression
	wfAdpcmEncoder     *IMAAdpcmEncoder // ADPCM encoder for waterfall compression
	audioInitSent      bool             // Track if audio_init message has been sent
	mu                 sync.RWMutex
}

// handle processes the KiwiSDR connection
func (kc *kiwiConn) handle() {
	// Generate user session ID
	kc.userSessionID = generateUUID()

	// Register User-Agent for this session (required by UberSDR)
	kc.sessions.SetUserAgent(kc.userSessionID, "KiwiSDR Client")

	// Send initial MSG responses
	kc.sendMsg("version_maj", "1")
	kc.sendMsg("version_min", "550")
	kc.sendMsg("bandwidth", "30000000")

	if kc.connType == "SND" {
		// Audio connection
		kc.sendMsg("sample_rate", "12000")
		// Note: audio_init message is sent in response to "SET AR OK" command
	} else {
		// Waterfall connection
		kc.sendMsg("wf_setup", "")
	}

	// Start message handler and streamer
	done := make(chan struct{})
	go kc.handleMessages(done)

	if kc.connType == "SND" {
		kc.streamAudio(done)
	} else {
		kc.streamWaterfall(done)
	}

	// Cleanup
	if kc.session != nil {
		kc.audioReceiver.ReleaseChannelAudio(kc.session)
		if err := kc.sessions.DestroySession(kc.session.ID); err != nil {
			log.Printf("Error destroying KiwiSDR session: %v", err)
		}
	}
}

// sendMsg sends a MSG message to the Kiwi client
func (kc *kiwiConn) sendMsg(name, value string) {
	var msg string
	if value != "" {
		msg = fmt.Sprintf("%s=%s", name, value)
	} else {
		msg = name
	}

	// KiwiSDR protocol: MSG tag (3 bytes) + skip byte + message
	packet := append([]byte("MSG\x00"), []byte(msg)...)

	kc.conn.writeMu.Lock()
	if err := kc.conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		log.Printf("Error setting write deadline: %v", err)
	}
	err := kc.conn.conn.WriteMessage(websocket.BinaryMessage, packet)
	kc.conn.writeMu.Unlock()

	if err != nil {
		log.Printf("Error sending MSG to Kiwi client: %v", err)
	}
}

// handleMessages processes incoming SET commands from Kiwi client
func (kc *kiwiConn) handleMessages(done chan struct{}) {
	defer close(done)

	for {
		_, message, err := kc.conn.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("KiwiSDR WebSocket error: %v", err)
			}
			break
		}

		// Parse message (should be text "SET ..." commands)
		msgStr := string(message)
		if strings.HasPrefix(msgStr, "SET ") {
			kc.handleSetCommand(msgStr[4:])
		}
	}
}

// handleSetCommand processes a SET command from the Kiwi client
func (kc *kiwiConn) handleSetCommand(command string) {
	// Parse space-separated key=value pairs
	params := make(map[string]string)
	parts := strings.Fields(command)
	for _, part := range parts {
		if idx := strings.Index(part, "="); idx > 0 {
			key := part[:idx]
			value := part[idx+1:]
			params[key] = value
		}
	}

	// Only log commands with parameters or non-keepalive/GET_USERS commands
	if len(params) > 0 || (!strings.Contains(command, "keepalive") && !strings.Contains(command, "GET_USERS")) {
		log.Printf("KiwiSDR SET command: %s (params: %v)", command, params)
	}

	// Handle auth command
	if _, hasAuth := params["auth"]; hasAuth {
		if password, ok := params["p"]; ok && password != "" && password != "#" {
			kc.mu.Lock()
			kc.password = password
			kc.mu.Unlock()
			log.Printf("KiwiSDR password received (length: %d)", len(password))
		}
		return
	}

	// Handle mod command (frequency/mode/bandwidth)
	if mode, hasMod := params["mod"]; hasMod {
		var freq uint64
		var lowCut, highCut int

		if freqStr, ok := params["freq"]; ok {
			freqKHz, _ := strconv.ParseFloat(freqStr, 64)
			freq = uint64(freqKHz * 1000)
		}

		if lcStr, ok := params["low_cut"]; ok {
			lowCut, _ = strconv.Atoi(lcStr)
		}
		if hcStr, ok := params["high_cut"]; ok {
			highCut, _ = strconv.Atoi(hcStr)
		}

		// Create or update session
		if kc.session == nil {
			// Create initial session
			session, err := kc.sessions.CreateSessionWithBandwidthAndPassword(
				freq, mode, 3000, kc.sourceIP, kc.clientIP, kc.userSessionID, kc.password)
			if err != nil {
				log.Printf("Failed to create KiwiSDR session: %v", err)
				return
			}
			kc.session = session
			kc.audioReceiver.GetChannelAudio(session)
			log.Printf("KiwiSDR session created: %s", session.ID)
		} else {
			// Update existing session
			if freq > 0 || mode != "" || (lowCut != 0 && highCut != 0) {
				sendBW := lowCut != 0 && highCut != 0
				err := kc.sessions.UpdateSessionWithEdges(kc.session.ID, freq, mode, lowCut, highCut, sendBW)
				if err != nil {
					log.Printf("Failed to update KiwiSDR session: %v", err)
				}
			}
		}
		return
	}

	// Handle zoom command (waterfall)
	if zoomStr, hasZoom := params["zoom"]; hasZoom {
		zoom, _ := strconv.Atoi(zoomStr)
		var cfKHz float64
		if cfStr, ok := params["cf"]; ok {
			cfKHz, _ = strconv.ParseFloat(cfStr, 64)
		}

		// Calculate bin_bandwidth from zoom level
		// Full span = 30 MHz, zoom divides by 2^zoom, 1024 bins
		fullSpanKHz := 30000.0
		spanKHz := fullSpanKHz / math.Pow(2, float64(zoom))
		binBandwidth := (spanKHz * 1000) / 1024 // Hz

		if kc.session != nil && kc.session.IsSpectrum {
			freq := uint64(cfKHz * 1000)
			err := kc.sessions.UpdateSpectrumSession(kc.session.ID, freq, binBandwidth, 0)
			if err != nil {
				log.Printf("Failed to update KiwiSDR spectrum session: %v", err)
			}
		}
		return
	}

	// Handle compression (audio)
	if compStr, hasComp := params["compression"]; hasComp {
		kc.mu.Lock()
		kc.compression = compStr == "1"
		kc.mu.Unlock()
		return
	}

	// Handle waterfall compression
	if wfCompStr, hasWfComp := params["wf_comp"]; hasWfComp {
		kc.mu.Lock()
		kc.wfCompression = wfCompStr == "1"
		kc.mu.Unlock()
		return
	}

	// Handle AR (Audio Rate) command - client sends "SET in=12000 out=48000"
	if inRate, hasIn := params["in"]; hasIn {
		if _, hasOut := params["out"]; hasOut {
			// Respond with audio_init message containing audio_rate and audio_rate_true
			// Use the 'in' rate from the client
			// Format: MSG audio_init audio_rate=12000 audio_rate_true=12000.000
			kc.sendMsg("audio_init", fmt.Sprintf("audio_rate=%s audio_rate_true=%s.000", inRate, inRate))
			kc.mu.Lock()
			kc.audioInitSent = true
			kc.mu.Unlock()
			log.Printf("KiwiSDR: Sent audio_init message in response to AR command (in=%s)", inRate)
			return
		}
	}

	// Handle keepalive
	if strings.Contains(command, "keepalive") {
		// Just touch the session
		if kc.session != nil {
			kc.sessions.TouchSession(kc.session.ID)
		}
		return
	}

	// Handle GET_USERS command
	if strings.Contains(command, "GET_USERS") {
		kc.sendUserList()
		return
	}

	// Ignore other commands (agc, ident_user, etc.)
}

// KiwiUserInfo represents a user in KiwiSDR format for JSON marshaling
type KiwiUserInfo struct {
	Index           int     `json:"i"`
	Name            string  `json:"n"`
	Location        string  `json:"g"`
	Frequency       int     `json:"f"`
	Mode            string  `json:"m"`
	Zoom            int     `json:"z"`
	Waterfall       int     `json:"wf"`
	FreqChange      int     `json:"fc"`
	Time            string  `json:"t"`
	InactivityTimer int     `json:"rt"`
	RecordNum       int     `json:"rn"`
	AckTime         string  `json:"rs"`
	Extension       string  `json:"e"`
	Antenna         string  `json:"a"`
	Compression     float64 `json:"c"`
	FreqOffset      float64 `json:"fo"`
	ColorAnt        int     `json:"ca"`
	NoiseCancel     int     `json:"nc"`
	NoiseSubtract   int     `json:"ns"`
}

// sendUserList sends the list of active users in KiwiSDR format
func (kc *kiwiConn) sendUserList() {
	// Get all active sessions from the session manager
	allSessions := kc.sessions.GetAllSessionsInfo()

	// Build user list in KiwiSDR format
	// Group sessions by user_session_id to combine audio and spectrum sessions
	userMap := make(map[string]*KiwiUserInfo)
	userIndex := 0

	for _, sessionInfo := range allSessions {
		// Skip internal sessions (no client IP)
		clientIP, _ := sessionInfo["client_ip"].(string)
		if clientIP == "" {
			continue
		}

		userSessionID, _ := sessionInfo["user_session_id"].(string)
		if userSessionID == "" {
			// No UUID, create a unique entry for this session
			userSessionID = fmt.Sprintf("anonymous-%s", sessionInfo["id"])
		}

		// Check if we already have this user
		if _, exists := userMap[userSessionID]; !exists {
			// New user, create entry
			user := &KiwiUserInfo{
				Index:           userIndex,
				Name:            "Unknown",
				Location:        "Unknown",
				Frequency:       0,
				Mode:            "",
				Zoom:            0,
				Waterfall:       0,
				FreqChange:      0,
				Time:            "",
				InactivityTimer: 0,
				RecordNum:       0,
				AckTime:         "",
				Extension:       "Unknown",
				Antenna:         "Unknown",
				Compression:     0.0,
				FreqOffset:      0.0,
				ColorAnt:        0,
				NoiseCancel:     0,
				NoiseSubtract:   0,
			}
			userIndex++

			// Get user agent if available
			if userAgent, ok := sessionInfo["user_agent"].(string); ok && userAgent != "" {
				user.Name = userAgent
			}

			// Get creation time
			if createdAt, ok := sessionInfo["created_at"].(string); ok && createdAt != "" {
				if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
					// Calculate time connected in seconds
					timeConnected := int(time.Since(t).Seconds())
					user.Time = fmt.Sprintf("%ds", timeConnected)
				}
			}

			// Extension - use mode or "Unknown"
			if mode, ok := sessionInfo["mode"].(string); ok && mode != "" {
				user.Extension = mode
			}

			userMap[userSessionID] = user
		}

		// Update frequency and mode from this session
		// Prefer audio sessions over spectrum sessions for frequency display
		user := userMap[userSessionID]
		isSpectrum, _ := sessionInfo["is_spectrum"].(bool)
		if !isSpectrum {
			// Audio session - use its frequency
			if freq, ok := sessionInfo["frequency"].(uint64); ok {
				// UberSDR stores frequencies in Hz, convert to kHz for KiwiSDR protocol
				user.Frequency = int(freq / 1000)
			}
			if mode, ok := sessionInfo["mode"].(string); ok {
				user.Mode = mode
			}
		} else if user.Frequency == 0 {
			// Spectrum session and no frequency set yet
			if freq, ok := sessionInfo["frequency"].(uint64); ok {
				// UberSDR stores frequencies in Hz, convert to kHz for KiwiSDR protocol
				user.Frequency = int(freq / 1000)
			}
			user.Mode = "spectrum"
		}
	}

	// Convert map to array
	users := make([]KiwiUserInfo, 0, len(userMap))
	for _, user := range userMap {
		users = append(users, *user)
	}

	// Marshal to JSON
	jsonData, err := json.Marshal(users)
	if err != nil {
		log.Printf("Error marshaling user list: %v", err)
		return
	}

	// Send as MSG user_cb=<json>
	kc.sendMsg("user_cb", string(jsonData))
}

// streamAudio streams audio in KiwiSDR SND format
func (kc *kiwiConn) streamAudio(done <-chan struct{}) {
	log.Printf("Starting KiwiSDR audio stream")

	// Create initial session if not created by SET mod command
	if kc.session == nil {
		session, err := kc.sessions.CreateSessionWithBandwidthAndPassword(
			14074000, "usb", 3000, kc.sourceIP, kc.clientIP, kc.userSessionID, kc.password)
		if err != nil {
			log.Printf("Failed to create KiwiSDR audio session: %v", err)
			return
		}
		kc.session = session
		kc.audioReceiver.GetChannelAudio(session)
	}

	packetCount := 0

	for {
		select {
		case <-done:
			return

		case <-kc.session.Done:
			return

		case audioPacket, ok := <-kc.session.AudioChan:
			if !ok {
				return
			}

			// Don't send audio packets until audio_init has been sent
			kc.mu.RLock()
			initSent := kc.audioInitSent
			kc.mu.RUnlock()

			if !initSent {
				// Skip this packet, wait for audio_init to be sent
				continue
			}

			packetCount++
			if packetCount%1000 == 0 {
				log.Printf("KiwiSDR: Streamed %d audio packets", packetCount)
			}

			// PCMData is already []byte (big-endian int16)
			// This is what KiwiSDR expects for uncompressed audio
			pcmData := audioPacket.PCMData

			// Debug: Log first packet details
			if packetCount == 1 {
				log.Printf("KiwiSDR: First audio packet - size=%d bytes, first 10 bytes: %v", len(pcmData), pcmData[:min(10, len(pcmData))])
			}

			var encodedData []byte
			var flags byte

			kc.mu.RLock()
			useCompression := kc.compression
			kc.mu.RUnlock()

			if useCompression {
				// Encode with IMA ADPCM
				encodedData = kc.adpcmEncoder.Encode(pcmData)
				flags = 0x10 // Compressed flag
			} else {
				encodedData = pcmData
				flags = 0x00
			}

			// Build SND packet: [flags:1][seq:4][smeter:2][data]
			packet := make([]byte, 7+len(encodedData))
			packet[0] = flags
			binary.LittleEndian.PutUint32(packet[1:5], kc.sequence)
			// S-meter: dummy value -50 dBm → ((-50 + 127) * 10) = 770
			binary.BigEndian.PutUint16(packet[5:7], 770)
			copy(packet[7:], encodedData)

			// Debug: Log first packet structure
			if packetCount == 1 {
				log.Printf("KiwiSDR: First SND packet - total=%d bytes, flags=0x%02x, seq=%d, smeter=%d, audio=%d bytes",
					len(packet)+3, flags, kc.sequence, 770, len(encodedData))
			}

			// Send with "SND" tag
			fullPacket := append([]byte("SND"), packet...)

			kc.conn.writeMu.Lock()
			if err := kc.conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
				log.Printf("Error setting write deadline: %v", err)
			}
			writeErr := kc.conn.conn.WriteMessage(websocket.BinaryMessage, fullPacket)
			kc.conn.writeMu.Unlock()

			if writeErr != nil {
				log.Printf("Error sending SND packet: %v", writeErr)
				return
			}

			kc.sequence++
		}
	}
}

// streamWaterfall streams spectrum data in KiwiSDR W/F format
func (kc *kiwiConn) streamWaterfall(done <-chan struct{}) {
	log.Printf("Starting KiwiSDR waterfall stream")

	// Create spectrum session if not created
	if kc.session == nil {
		session, err := kc.sessions.CreateSpectrumSessionWithUserIDAndPassword(
			kc.sourceIP, kc.clientIP, kc.userSessionID, kc.password)
		if err != nil {
			log.Printf("Failed to create KiwiSDR spectrum session: %v", err)
			return
		}
		kc.session = session
	}

	packetCount := 0
	wfSequence := uint32(0)

	for {
		select {
		case <-done:
			return

		case <-kc.session.Done:
			return

		case spectrumData, ok := <-kc.session.SpectrumChan:
			if !ok {
				return
			}

			packetCount++
			if packetCount%100 == 0 {
				log.Printf("KiwiSDR: Streamed %d waterfall packets", packetCount)
			}

			// Convert spectrum data (float32 dBm) to KiwiSDR waterfall format
			// KiwiSDR expects 8-bit values: 0-255 representing -200 to 0 dBm
			// Formula: byte_value = (dBm + 200) * 255 / 200
			wfData := make([]byte, len(spectrumData))
			for i, dbValue := range spectrumData {
				// Clamp to -200..0 dBm range
				clampedDb := dbValue
				if clampedDb < -200 {
					clampedDb = -200
				}
				if clampedDb > 0 {
					clampedDb = 0
				}
				// Convert to 0..255 range: (dBm + 200) * 1.275
				byteVal := int((clampedDb + 200) * 1.275)
				if byteVal < 0 {
					byteVal = 0
				}
				if byteVal > 255 {
					byteVal = 255
				}
				wfData[i] = byte(byteVal)
			}

			// Check if compression is enabled
			kc.mu.RLock()
			useCompression := kc.wfCompression
			kc.mu.RUnlock()

			var encodedData []byte
			if useCompression {
				// Reset encoder for each waterfall line (as per KiwiSDR protocol)
				kc.wfAdpcmEncoder = NewIMAAdpcmEncoder()
				// Convert bytes to int16 for ADPCM encoding
				pcmData := make([]byte, len(wfData)*2)
				for i, b := range wfData {
					// Convert unsigned byte to signed int16 (centered at 0)
					val := int16(b) - 128
					binary.BigEndian.PutUint16(pcmData[i*2:], uint16(val))
				}
				encodedData = kc.wfAdpcmEncoder.Encode(pcmData)
			} else {
				encodedData = wfData
			}

			// Build W/F packet: [x_bin:4][flags_zoom:4][seq:4][data]
			packet := make([]byte, 12+len(encodedData))
			binary.LittleEndian.PutUint32(packet[0:4], 0)           // x_bin (unused)
			binary.LittleEndian.PutUint32(packet[4:8], 0)           // flags_zoom (unused)
			binary.LittleEndian.PutUint32(packet[8:12], wfSequence) // sequence
			copy(packet[12:], encodedData)

			// Send with "W/F" tag + skip byte
			fullPacket := append([]byte("W/F\x00"), packet...)

			kc.conn.writeMu.Lock()
			if err := kc.conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
				log.Printf("Error setting write deadline: %v", err)
			}
			writeErr := kc.conn.conn.WriteMessage(websocket.BinaryMessage, fullPacket)
			kc.conn.writeMu.Unlock()

			if writeErr != nil {
				log.Printf("Error sending W/F packet: %v", writeErr)
				return
			}

			wfSequence++
		}
	}
}

// generateUUID generates a simple UUID v4
func generateUUID() string {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	if err != nil {
		// Fallback to time-based
		now := time.Now().UnixNano()
		binary.LittleEndian.PutUint64(b[0:8], uint64(now))
		binary.LittleEndian.PutUint64(b[8:16], uint64(now>>32))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // Variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
