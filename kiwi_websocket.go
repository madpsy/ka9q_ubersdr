package main

import (
	"crypto/rand"
	"encoding/binary"
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

// HandleKiwiWebSocket handles KiwiSDR-compatible WebSocket connections
// Path format: /kiwi/<timestamp>/<type> where type is "SND" or "W/F"
func (kwsh *KiwiWebSocketHandler) HandleKiwiWebSocket(w http.ResponseWriter, r *http.Request) {
	// Parse path: /kiwi/<timestamp>/<type>
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "kiwi" {
		http.Error(w, "Invalid path format. Expected: /kiwi/<timestamp>/SND or /kiwi/<timestamp>/W/F", http.StatusBadRequest)
		return
	}

	timestamp := parts[1]
	connType := strings.Join(parts[2:], "/") // "SND" or "W/F"

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

	// Check connection rate limit
	if !kwsh.connRateLimiter.AllowConnection(clientIP) {
		log.Printf("KiwiSDR connection rate limit exceeded for IP: %s", clientIP)
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
		return
	}

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
		password:           "",
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
	password           string
	mu                 sync.RWMutex
}

// handle processes the KiwiSDR connection
func (kc *kiwiConn) handle() {
	// Generate user session ID
	kc.userSessionID = generateUUID()

	// Send initial MSG responses
	kc.sendMsg("version_maj", "1")
	kc.sendMsg("version_min", "550")
	kc.sendMsg("bandwidth", "30000000")

	if kc.connType == "SND" {
		// Audio connection
		kc.sendMsg("sample_rate", "12000")
		kc.sendMsg("audio_rate", "12000")
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

	log.Printf("KiwiSDR SET command: %v", params)

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

	// Handle compression
	if compStr, hasComp := params["compression"]; hasComp {
		kc.mu.Lock()
		kc.compression = compStr == "1"
		kc.mu.Unlock()
		return
	}

	// Handle keepalive
	if strings.Contains(command, "keepalive") {
		// Just touch the session
		if kc.session != nil {
			kc.sessions.TouchSession(kc.session.ID)
		}
		return
	}

	// Ignore other commands (agc, ident_user, etc.)
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

			packetCount++
			if packetCount%1000 == 0 {
				log.Printf("KiwiSDR: Streamed %d audio packets", packetCount)
			}

			// PCMData is already []byte (big-endian int16)
			// This is what KiwiSDR expects for uncompressed audio
			pcmData := audioPacket.PCMData

			var encodedData []byte
			var flags byte

			kc.mu.RLock()
			useCompression := kc.compression
			kc.mu.RUnlock()

			if useCompression {
				// TODO: Implement IMA ADPCM encoding
				// For now, send uncompressed
				encodedData = pcmData
				flags = 0x00
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
			wfData := make([]byte, len(spectrumData))
			for i, dbValue := range spectrumData {
				// Clamp to -200..0 dBm range and convert to 0..255
				byteVal := int(dbValue + 255)
				if byteVal < 0 {
					byteVal = 0
				}
				if byteVal > 255 {
					byteVal = 255
				}
				wfData[i] = byte(byteVal)
			}

			// Build W/F packet: [x_bin:4][flags_zoom:4][seq:4][data]
			packet := make([]byte, 12+len(wfData))
			binary.LittleEndian.PutUint32(packet[0:4], 0)           // x_bin (unused)
			binary.LittleEndian.PutUint32(packet[4:8], 0)           // flags_zoom (unused)
			binary.LittleEndian.PutUint32(packet[8:12], wfSequence) // sequence
			copy(packet[12:], wfData)

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
