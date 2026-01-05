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
	"net/url"
	"sort"
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
	radiod             *RadiodController
	kiwiRXSlots        map[string]int // Map userSessionID to RX channel number
	nextRXSlot         int            // Next available RX slot
	mu                 sync.RWMutex   // Protects kiwiRXSlots and nextRXSlot
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
		radiod:             sessions.radiod, // Get radiod from sessions
		kiwiRXSlots:        make(map[string]int),
		nextRXSlot:         0,
	}
}

// getOrAssignRXSlot gets or assigns an RX slot number for a Kiwi user
func (kwsh *KiwiWebSocketHandler) getOrAssignRXSlot(userSessionID string) int {
	kwsh.mu.Lock()
	defer kwsh.mu.Unlock()

	// Check if user already has a slot
	if slot, exists := kwsh.kiwiRXSlots[userSessionID]; exists {
		return slot
	}

	// Assign new slot
	slot := kwsh.nextRXSlot
	kwsh.kiwiRXSlots[userSessionID] = slot
	kwsh.nextRXSlot++

	// Wrap around if we exceed max sessions
	if kwsh.nextRXSlot >= kwsh.config.Server.MaxSessions {
		kwsh.nextRXSlot = 0
	}

	return slot
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
	// Parse path: /<timestamp>/<type> or /kiwi/<timestamp>/<type> or /ws/kiwi/<timestamp>/<type>
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")

	// Support multiple formats:
	// - /<timestamp>/SND (native KiwiSDR format on dedicated port)
	// - /kiwi/<timestamp>/SND (with /kiwi/ prefix)
	// - /ws/kiwi/<timestamp>/SND (with /ws/kiwi/ prefix)
	var timestamp, connType string

	if len(parts) >= 2 {
		if parts[0] == "ws" && parts[1] == "kiwi" && len(parts) >= 4 {
			// /ws/kiwi/<timestamp>/<type> format
			timestamp = parts[2]
			connType = strings.Join(parts[3:], "/")
		} else if parts[0] == "kiwi" && len(parts) >= 3 {
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
	// Use ONLY client IP as the userSessionID (not timestamp)
	// This ensures:
	// 1. SND and W/F connections from same client are linked
	// 2. Multiple tabs/refreshes from same IP appear as same user
	// 3. User persists across reconnections
	userSessionID := fmt.Sprintf("kiwi-%s", clientIP)

	kc := &kiwiConn{
		conn:               conn,
		connType:           connType,
		sourceIP:           sourceIP,
		clientIP:           clientIP,
		sessions:           kwsh.sessions,
		audioReceiver:      kwsh.audioReceiver,
		config:             kwsh.config,
		rateLimiterManager: kwsh.rateLimiterManager,
		radiod:             kwsh.radiod,
		handler:            kwsh,          // Reference to handler for RX slot management
		userSessionID:      userSessionID, // Set before handle() is called
		sequence:           0,
		compression:        true,
		wfCompression:      false, // Disable waterfall compression by default (real KiwiSDR doesn't use it)
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
	radiod             *RadiodController
	handler            *KiwiWebSocketHandler // Reference to handler for RX slot management
	session            *Session
	userSessionID      string
	identUser          string // User identity from SET ident_user command
	sequence           uint32
	compression        bool
	wfCompression      bool // Waterfall compression (separate from audio)
	password           string
	adpcmEncoder       *IMAAdpcmEncoder // ADPCM encoder for audio compression
	wfAdpcmEncoder     *IMAAdpcmEncoder // ADPCM encoder for waterfall compression
	audioInitSent      bool             // Track if audio_init message has been sent
	authReceived       bool             // Track if SET auth command has been received
	zoom               int              // Current zoom level (0-14)
	xBin               uint32           // Current x_bin (start position in bins)
	mu                 sync.RWMutex
}

// kiwiEncodeString encodes a string for use in Kiwi MSG protocol JSON values
// Uses %20 for spaces (not +) to match real KiwiSDR behavior
func kiwiEncodeString(s string) string {
	// url.QueryEscape uses + for spaces, but Kiwi expects %20
	encoded := url.QueryEscape(s)
	return strings.ReplaceAll(encoded, "+", "%20")
}

// handle processes the KiwiSDR connection
func (kc *kiwiConn) handle() {
	// userSessionID is already set in HandleKiwiWebSocket using timestamp+IP
	// This ensures SND and W/F connections from the same client share the same UUID

	// Register User-Agent for this session (required by UberSDR)
	kc.sessions.SetUserAgent(kc.userSessionID, "KiwiSDR Client")

	// Don't send initialization messages yet - wait for SET auth command
	// The client must send "SET auth t=kiwi p=#" (or with a password) first

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

	// KiwiSDR protocol: MSG tag (3 bytes) + space + message
	packet := append([]byte("MSG "), []byte(msg)...)

	// Log large messages for debugging
	if len(packet) > 500 {
		log.Printf("Sending large MSG: %s (total %d bytes, msg %d bytes)", name, len(packet), len(msg))
	}

	kc.conn.writeMu.Lock()
	// Increase write deadline for large messages
	deadline := 10 * time.Second
	if len(packet) > 10000 {
		deadline = 30 * time.Second
	}
	if err := kc.conn.conn.SetWriteDeadline(time.Now().Add(deadline)); err != nil {
		log.Printf("Error setting write deadline: %v", err)
	}

	// CRITICAL: Disable compression for large messages to prevent fragmentation
	// The Kiwi client expects MSG messages to arrive as single complete frames
	err := kc.conn.conn.WriteMessage(websocket.BinaryMessage, packet)
	kc.conn.writeMu.Unlock()

	if err != nil {
		log.Printf("Error sending MSG to Kiwi client: %v", err)
	} else if len(packet) > 500 {
		log.Printf("Successfully sent large MSG: %s", name)
	}
}

// handleMessages processes incoming SET commands from Kiwi client
func (kc *kiwiConn) handleMessages(done chan struct{}) {
	defer close(done)

	for {
		msgType, message, err := kc.conn.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("KiwiSDR WebSocket error: %v", err)
			}
			break
		}

		// Log all incoming messages
		log.Printf("KiwiSDR %s received message (type=%d, len=%d): %q", kc.connType, msgType, len(message), string(message))

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
	// Also handle standalone keys (like "auth" in "SET auth t=kiwi p=#")
	params := make(map[string]string)
	parts := strings.Fields(command)
	for _, part := range parts {
		if idx := strings.Index(part, "="); idx > 0 {
			key := part[:idx]
			value := part[idx+1:]
			params[key] = value
		} else {
			// Standalone key without value (e.g., "auth")
			params[part] = ""
		}
	}

	// Log auth commands for debugging
	if _, hasAuth := params["auth"]; hasAuth {
		log.Printf("KiwiSDR: Received SET auth command: %s (params: %v)", command, params)
	}

	// Handle MARKER command (DX label requests)
	if _, hasMarker := params["MARKER"]; hasMarker {
		kc.handleMarkerCommand(params)
		return
	}

	// Handle auth command
	if _, hasAuth := params["auth"]; hasAuth {
		// Extract password (# means no password, empty string also means no password)
		if password, ok := params["p"]; ok {
			// Only store non-empty passwords that aren't the placeholder "#"
			if password != "" && password != "#" {
				kc.mu.Lock()
				kc.password = password
				kc.mu.Unlock()
			}
		}

		// Mark auth as received
		kc.mu.Lock()
		alreadyAuthed := kc.authReceived
		kc.authReceived = true
		kc.mu.Unlock()

		// Send initialization messages after first auth (only once)
		if !alreadyAuthed {
			kc.sendInitMessages()
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
			// Create initial session (only for SND connections)
			if kc.connType == "SND" {
				session, err := kc.sessions.CreateSessionWithBandwidthAndPassword(
					freq, mode, 3000, kc.sourceIP, kc.clientIP, kc.userSessionID, kc.password)
				if err != nil {
					log.Printf("Failed to create KiwiSDR session: %v", err)
					return
				}
				kc.session = session
				kc.audioReceiver.GetChannelAudio(session)
			}
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
	// Client sends: "SET zoom=X start=Y" or "SET zoom=X cf=Y"
	// This command can come on either SND or W/F connection
	if zoomStr, hasZoom := params["zoom"]; hasZoom {
		// Ignore zoom parameter in MARKER commands - these are just display parameters
		// and should not trigger spectrum frequency updates
		if _, isMarker := params["MARKER"]; isMarker {
			log.Printf("DEBUG ZOOM: Ignoring zoom in MARKER command")
			return
		}

		zoom, _ := strconv.Atoi(zoomStr)

		log.Printf("DEBUG ZOOM: Received zoom command on %s connection: zoom=%d, params=%v, userSessionID=%s",
			kc.connType, zoom, params, kc.userSessionID)

		// Store zoom level
		kc.mu.Lock()
		kc.zoom = zoom
		kc.mu.Unlock()

		// Calculate bin_bandwidth from zoom level
		// Full span = 30 MHz, zoom divides by 2^zoom, 1024 bins displayed
		fullSpanKHz := 30000.0
		spanKHz := fullSpanKHz / math.Pow(2, float64(zoom))
		requestedBinBandwidth := (spanKHz * 1000) / 1024 // Hz per bin at this zoom level

		// Important: x_bin is always relative to MAX zoom level (zoom 14)
		// max_bins = 1024 << 14 = 16777216 bins across 30 MHz
		// bin_to_freq: freq = (bin / max_bins) * bandwidth
		// freq_to_bin: bin = (freq / bandwidth) * max_bins
		const maxZoom = 14
		maxBins := 1024 << maxZoom // 16777216

		// Parse x_bin and calculate center frequency FIRST (before bin count determination)
		var freq uint64
		var xBin uint32

		// Handle cf parameter (center frequency in kHz) - takes precedence
		if cfStr, ok := params["cf"]; ok {
			cfKHz, _ := strconv.ParseFloat(cfStr, 64)
			freq = uint64(cfKHz * 1000)
			// Calculate xBin from center frequency (at max zoom resolution)
			// freq_to_bin: bin = (freq / bandwidth) * max_bins
			centerBin := (cfKHz / fullSpanKHz) * float64(maxBins)
			// Calculate bins at current zoom: bins_at_zoom(zoom) = wf_fft_size << (zoom_levels_max - zoom)
			binsAtCurrentZoom := 1024 << uint(maxZoom-zoom)
			// xBin is the start position, so it's center minus half the window
			xBin = uint32(centerBin - float64(binsAtCurrentZoom)/2)
			log.Printf("DEBUG ZOOM: Using cf parameter: cfKHz=%.3f, centerBin=%.0f, binsAtZoom=%d, xBin=%d",
				cfKHz, centerBin, binsAtCurrentZoom, xBin)
		} else if startStr, ok := params["start"]; ok {
			// Handle start parameter (x_bin position at max zoom resolution)
			xBin64, _ := strconv.ParseUint(startStr, 10, 32)
			xBin = uint32(xBin64)

			// CRITICAL: Match KiwiSDR client's calculation exactly
			// Client code: bins_at_zoom(zoom) = wf_fft_size << (zoom_levels_max - zoom)
			// Client code: out.center = bin_to_freq(x_bin + bins/2)
			// Client code: bin_to_freq(bin) = (bin / max_bins) * bandwidth

			// Calculate bins at current zoom (this is the window size in max-resolution bin space)
			binsAtZoom := 1024 << uint(maxZoom-zoom) // wf_fft_size << (zoom_levels_max - zoom)

			// Center bin is at x_bin + bins/2 (in max-resolution space)
			centerBin := float64(xBin) + float64(binsAtZoom)/2.0

			// Convert bin to frequency: freq = (bin / max_bins) * bandwidth
			totalBandwidthHz := fullSpanKHz * 1000.0
			freq = uint64((centerBin / float64(maxBins)) * totalBandwidthHz)

			log.Printf("DEBUG ZOOM: Using start parameter: xBin=%d, binsAtZoom=%d, centerBin=%.0f, freq=%d Hz (%.3f kHz)",
				xBin, binsAtZoom, centerBin, freq, float64(freq)/1000.0)
		} else {
			// No cf or start provided, use current center (15 MHz)
			freq = 15000000
			xBin = 0
			log.Printf("DEBUG ZOOM: No cf or start parameter, using default: freq=15 MHz, xBin=0")
		}

		// NOW determine bin count and bandwidth based on radiod constraints
		// The center frequency is already calculated correctly above
		// Radiod has minimum bin bandwidth constraints that depend on bin count
		// From UberSDR testing: 256 bins at 50 Hz/bin works (not 25 Hz!)
		// The constraint is related to FFT size and filter design
		binCount := 1024
		binBandwidth := requestedBinBandwidth
		const minBinBW1024 = 60.0 // Minimum Hz/bin for 1024 bins
		const minBinBW512 = 50.0  // Minimum Hz/bin for 512 bins
		const minBinBW256 = 50.0  // Minimum Hz/bin for 256 bins (from UberSDR actual usage)

		if requestedBinBandwidth < minBinBW1024 {
			// Try 512 bins
			binCount = 512
			binBandwidth = (spanKHz * 1000) / float64(binCount)

			if binBandwidth < minBinBW512 {
				// Try 256 bins
				binCount = 256
				binBandwidth = (spanKHz * 1000) / float64(binCount)

				if binBandwidth < minBinBW256 {
					// Clamp to minimum
					binBandwidth = minBinBW256
					log.Printf("DEBUG ZOOM: Zoom %d: requested %.2f Hz/bin, clamped to %d bins at %.2f Hz/bin (span %.3f kHz, requested %.3f kHz)",
						zoom, requestedBinBandwidth, binCount, binBandwidth, float64(binCount)*binBandwidth/1000, spanKHz)
				} else {
					log.Printf("DEBUG ZOOM: Zoom %d: requested %.2f Hz/bin, using %d bins at %.2f Hz/bin (span %.3f kHz)",
						zoom, requestedBinBandwidth, binCount, binBandwidth, spanKHz)
				}
			} else {
				log.Printf("DEBUG ZOOM: Zoom %d: requested %.2f Hz/bin, using %d bins at %.2f Hz/bin (span %.3f kHz)",
					zoom, requestedBinBandwidth, binCount, binBandwidth, spanKHz)
			}
		}

		// Store xBin
		kc.mu.Lock()
		kc.xBin = xBin
		kc.mu.Unlock()

		// Debug logging
		log.Printf("DEBUG ZOOM: Calculated values: zoom=%d, xBin=%d, freq=%d Hz (%.3f kHz), binBW=%.2f Hz, spanKHz=%.3f",
			zoom, xBin, freq, float64(freq)/1000.0, binBandwidth, spanKHz)

		// Find and update the spectrum session for this userSessionID
		// The zoom command can come on either SND or W/F connection
		if kc.userSessionID != "" {
			log.Printf("DEBUG ZOOM: Calling UpdateSpectrumSessionByUserIDWithBinCount with userSessionID=%s, freq=%d, binBW=%.2f, binCount=%d",
				kc.userSessionID, freq, binBandwidth, binCount)
			updated := kc.sessions.UpdateSpectrumSessionByUserIDWithBinCount(kc.userSessionID, freq, binBandwidth, binCount)
			if !updated {
				log.Printf("ERROR ZOOM: Failed to update spectrum session for zoom command (userSessionID=%s, freq=%d, binBW=%.2f, binCount=%d)",
					kc.userSessionID, freq, binBandwidth, binCount)
			} else {
				log.Printf("DEBUG ZOOM: Successfully updated spectrum session")
			}
		} else {
			log.Printf("ERROR ZOOM: userSessionID is empty, cannot update spectrum session")
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

	// Handle ident_user command
	if identUser, hasIdent := params["ident_user"]; hasIdent {
		kc.mu.Lock()
		kc.identUser = identUser
		kc.mu.Unlock()
		// Also update the User-Agent for this session to use the ident_user
		if kc.userSessionID != "" {
			kc.sessions.SetUserAgent(kc.userSessionID, identUser)
		}
		return
	}

	// Ignore other commands (agc, etc.)
}

// sendInitMessages sends the initialization message sequence for KiwiSDR
func (kc *kiwiConn) sendInitMessages() {
	// Common messages for both SND and W/F connections
	maxSessions := kc.config.Server.MaxSessions
	kc.sendMsg("rx_chans", fmt.Sprintf("%d", maxSessions))
	kc.sendMsg("chan_no_pwd", "0")
	kc.sendMsg("chan_no_pwd_true", "0")
	kc.sendMsg("max_camp", fmt.Sprintf("%d", maxSessions))
	kc.sendMsg("badp", "0")

	// Version and hardware info
	versionMsg := fmt.Sprintf("version_maj=1 version_min=826 debian_ver=11 model=2 platform=0 hw=1 ext_clk=0 freq_offset=0.000 abyy=B25 dx_db_name=dx")
	kc.sendMsg("", versionMsg)

	// Send configuration to both SND and W/F connections
	// The client needs this on both connections
	// Encode receiver name and location for JSON (use %20 for spaces, not +)
	encodedName := kiwiEncodeString(kc.config.Admin.Name)
	encodedLocation := kiwiEncodeString(kc.config.Admin.Location)

	cfgJSON := `{"passbands":{"am":{"lo":-4900,"hi":4900},"amn":{"lo":-2500,"hi":2500},"amw":{"lo":-6000,"hi":6000},"sam":{"lo":-4900,"hi":4900},"sal":{"lo":-4900,"hi":0},"sau":{"lo":0,"hi":4900},"sas":{"lo":-4900,"hi":4900},"qam":{"lo":-4900,"hi":4900},"drm":{"lo":-5000,"hi":5000},"lsb":{"lo":-2400,"hi":-300},"lsn":{"lo":-2100,"hi":-300},"usb":{"lo":300,"hi":2400},"usn":{"lo":300,"hi":2100},"cw":{"lo":-400,"hi":400},"cwn":{"lo":-250,"hi":250},"nbfm":{"lo":-6000,"hi":6000},"nnfm":{"lo":-5000,"hi":5000},"iq":{"lo":-10000,"hi":10000}},"index_html_params":{"PAGE_TITLE":"KiwiSDR","RX_PHOTO_HEIGHT":350,"RX_PHOTO_TITLE_HEIGHT":70,"RX_PHOTO_TITLE":"","RX_PHOTO_DESC":"","RX_TITLE":"` + encodedName + `","RX_LOC":"` + encodedLocation + `","RX_QRA":"","RX_ASL":` + fmt.Sprintf("%d", kc.config.Admin.ASL) + `,"RX_GMAP":""},"owner_info":"","init":{"freq":7020,"mode":"cw","zoom":0,"max_dB":-10,"min_dB":-110},"waterfall_cal":-3,"waterfall_min_dB":-110,"waterfall_max_dB":-10,"snr_meas_interval_hrs":0}`
	cfgJSONEncoded := url.QueryEscape(cfgJSON)
	kc.sendMsg("load_cfg", cfgJSONEncoded)

	// Send DX configuration with UberSDR bookmarks
	dxcfgJSON := kc.buildDXConfig()
	dxcfgJSONEncoded := url.QueryEscape(dxcfgJSON)
	kc.sendMsg("load_dxcfg", dxcfgJSONEncoded)

	// Send DX community configuration (minimal structure to avoid null errors)
	dxcommJSON := `{"dx_type":[{"key":0,"name":"type-0","color":"white"},{"key":1,"name":"type-1","color":"white"},{"key":2,"name":"type-2","color":"white"},{"key":3,"name":"type-3","color":"white"},{"key":4,"name":"type-4","color":"white"},{"key":5,"name":"type-5","color":"white"},{"key":6,"name":"type-6","color":"white"},{"key":7,"name":"type-7","color":"white"},{"key":8,"name":"type-8","color":"white"},{"key":9,"name":"type-9","color":"white"},{"key":10,"name":"type-10","color":"white"},{"key":11,"name":"type-11","color":"white"},{"key":12,"name":"type-12","color":"white"},{"key":13,"name":"type-13","color":"white"},{"key":14,"name":"type-14","color":"white"},{"key":15,"name":"type-15","color":"white"}],"band_svc":[],"bands":[]}`
	dxcommJSONEncoded := url.QueryEscape(dxcommJSON)
	kc.sendMsg("load_dxcomm_cfg", dxcommJSONEncoded)

	// Center frequency and bandwidth
	kc.sendMsg("center_freq", "15000000")
	kc.sendMsg("bandwidth", "30000000")
	kc.sendMsg("adc_clk_nom", "66666600")

	if kc.connType == "SND" {
		// Audio connection - send audio-specific messages
		sampleRate := kc.config.Audio.DefaultSampleRate
		kc.sendMsg("sample_rate", fmt.Sprintf("%d", sampleRate))
		kc.sendMsg("client_public_ip", kc.clientIP)

		// Check if client is local (same as server or in bypass list)
		isLocal := "0"
		if kc.config.Server.IsIPTimeoutBypassed(kc.clientIP, kc.password) {
			isLocal = "1"
		}
		kc.sendMsg("is_local", isLocal+",0,0")

		// Configuration loaded
		kc.sendMsg("cfg_loaded", "")

		// Audio initialization
		kc.sendMsg("audio_init", fmt.Sprintf("0 audio_rate=%d", sampleRate))

		// Mark audio_init as sent so we can start streaming
		kc.mu.Lock()
		kc.audioInitSent = true
		kc.mu.Unlock()
	} else {
		// Waterfall connection - send waterfall-specific messages
		// Send wf_fft_size FIRST before wf_setup (client needs this to create canvas)
		kc.sendMsg("wf_fft_size", "1024")
		kc.sendMsg("wf_fps", "23")
		kc.sendMsg("wf_fps_max", "23")
		kc.sendMsg("zoom_max", "14")
		kc.sendMsg("wf_chans", fmt.Sprintf("%d", maxSessions))
		kc.sendMsg("wf_chans_real", fmt.Sprintf("%d", maxSessions))
		kc.sendMsg("wf_cal", "-3")

		// Extension list (empty - no extensions available)
		// URL encoded JSON array: []
		extListJSON := "%5B%5D"
		kc.sendMsg("kiwi_up", "1")
		kc.sendMsg("rx_chan", "1")
		kc.sendMsg("extint_list_json", extListJSON)

		// Send wf_setup to trigger wf_init() on client
		kc.sendMsg("wf_setup", "")

		// Initial zoom and start position
		kc.sendMsg("zoom", "0")
		kc.sendMsg("start", "0")

		// Initialize zoom and xBin to defaults
		kc.mu.Lock()
		kc.zoom = 0
		kc.xBin = 0
		kc.mu.Unlock()

		// Create spectrum session immediately for W/F connection
		if kc.session == nil {
			session, err := kc.sessions.CreateSpectrumSessionWithUserIDAndPassword(
				kc.sourceIP, kc.clientIP, kc.userSessionID, kc.password)
			if err != nil {
				log.Printf("Failed to create KiwiSDR spectrum session: %v", err)
				return
			}
			kc.session = session
			log.Printf("Created spectrum session for W/F connection: %s", kc.session.ID)

			// Configure initial spectrum parameters (zoom 0 = full 30 MHz span)
			// Full span = 30 MHz, zoom 0 = 30000 kHz / 1024 bins = 29.296875 kHz/bin
			initialBinBandwidth := 30000000.0 / 1024.0 // Hz per bin at zoom 0
			initialFreq := uint64(15000000)            // Center frequency: 15 MHz
			updated := kc.sessions.UpdateSpectrumSessionByUserID(kc.userSessionID, initialFreq, initialBinBandwidth)
			if !updated {
				log.Printf("Warning: Failed to configure initial spectrum session")
			} else {
				log.Printf("Configured spectrum session: freq=%d Hz, binBW=%.2f Hz", initialFreq, initialBinBandwidth)
			}
		}
	}
}

// generatePastelColor generates a pastel color based on a hash of the input string
func generatePastelColor(s string) string {
	// Simple hash function
	hash := uint32(0)
	for _, c := range s {
		hash = hash*31 + uint32(c)
	}

	// Generate pastel colors (high saturation, high lightness)
	// Use hash to generate hue (0-360), keep saturation and lightness high for pastel
	hue := hash % 360

	// Convert HSL to RGB for pastel colors
	// Pastel: high lightness (75-85%), moderate saturation (60-80%)
	saturation := 0.65 + float64((hash>>8)%20)/100.0 // 65-85%
	lightness := 0.75 + float64((hash>>16)%10)/100.0 // 75-85%

	r, g, b := hslToRGB(float64(hue), saturation, lightness)

	return fmt.Sprintf("#%02x%02x%02x", r, g, b)
}

// hslToRGB converts HSL color values to RGB
func hslToRGB(h, s, l float64) (uint8, uint8, uint8) {
	h = h / 360.0 // Normalize hue to 0-1

	var r, g, b float64

	if s == 0 {
		r, g, b = l, l, l // Achromatic
	} else {
		hue2rgb := func(p, q, t float64) float64 {
			if t < 0 {
				t += 1
			}
			if t > 1 {
				t -= 1
			}
			if t < 1.0/6.0 {
				return p + (q-p)*6*t
			}
			if t < 1.0/2.0 {
				return q
			}
			if t < 2.0/3.0 {
				return p + (q-p)*(2.0/3.0-t)*6
			}
			return p
		}

		var q float64
		if l < 0.5 {
			q = l * (1 + s)
		} else {
			q = l + s - l*s
		}
		p := 2*l - q

		r = hue2rgb(p, q, h+1.0/3.0)
		g = hue2rgb(p, q, h)
		b = hue2rgb(p, q, h-1.0/3.0)
	}

	return uint8(r * 255), uint8(g * 255), uint8(b * 255)
}

// buildDXConfig builds the DX configuration JSON with UberSDR bands
// Note: DX labels (bookmarks) are NOT sent here - they require a separate server-side database
// and are loaded via SET MARKER commands. This function only handles band bars and their services.
func (kc *kiwiConn) buildDXConfig() string {
	log.Printf("DEBUG: buildDXConfig called with %d bands, %d bookmarks", len(kc.config.Bands), len(kc.config.Bookmarks))

	// Create dx_type array (16 entries for bookmark types)
	// Map bookmark groups to types and generate colors
	groupToType := make(map[string]int)
	typeColors := make([]string, 16)
	typeNames := make([]string, 16)
	nextType := 0

	// First pass: collect unique bookmark groups and assign types
	for _, bookmark := range kc.config.Bookmarks {
		group := bookmark.Group
		if group == "" {
			group = "General"
		}

		if _, exists := groupToType[group]; !exists && nextType < 16 {
			groupToType[group] = nextType
			typeNames[nextType] = group
			typeColors[nextType] = generatePastelColor(group)
			log.Printf("DEBUG: Bookmark type: group=%s, type=%d, color=%s", group, nextType, typeColors[nextType])
			nextType++
		}
	}

	// Fill remaining types with defaults
	for i := nextType; i < 16; i++ {
		typeNames[i] = fmt.Sprintf("type-%d", i)
		typeColors[i] = "white"
	}

	// Build dx_type array
	dxTypes := make([]map[string]interface{}, 16)
	for i := 0; i < 16; i++ {
		dxTypes[i] = map[string]interface{}{
			"key":   i,
			"name":  typeNames[i],
			"color": typeColors[i],
		}
	}

	// Build band_svc array (band service types)
	// Map UberSDR band groups to service keys
	groupToSvc := make(map[string]string)
	bandSvc := make([]map[string]interface{}, 0)
	svcIndex := 0

	for _, band := range kc.config.Bands {
		group := band.Group
		if group == "" {
			group = "Amateur"
		}

		// Check if we already have this service
		if _, exists := groupToSvc[group]; !exists {
			// Create new service key (use letters A-Z, then numbers)
			var svcKey string
			if svcIndex < 26 {
				svcKey = string(rune('A' + svcIndex))
			} else {
				svcKey = fmt.Sprintf("%d", svcIndex-26)
			}
			groupToSvc[group] = svcKey

			color := generatePastelColor(group)
			log.Printf("DEBUG: Band service: group=%s, key=%s, color=%s", group, svcKey, color)

			bandSvc = append(bandSvc, map[string]interface{}{
				"key":   svcKey,
				"name":  group,
				"color": color,
			})
			svcIndex++
		}
	}

	log.Printf("DEBUG: Created %d band services", len(bandSvc))

	// Convert UberSDR bands to Kiwi bands format
	// Kiwi bands are ONLY for the band bar display (frequency ranges)
	// DX labels (bookmarks) are handled separately via SET MARKER protocol
	kiwiBands := make([]map[string]interface{}, 0, len(kc.config.Bands))
	for _, band := range kc.config.Bands {
		// Kiwi expects frequencies in kHz
		minKHz := float64(band.Start) / 1000.0
		maxKHz := float64(band.End) / 1000.0

		// Get service key for this band's group
		group := band.Group
		if group == "" {
			group = "Amateur"
		}
		svcKey := groupToSvc[group]

		kiwiBand := map[string]interface{}{
			"min":  minKHz,
			"max":  maxKHz,
			"name": band.Label,
			"svc":  svcKey,
			"itu":  0,  // 0 = any region (show in all ITU regions)
			"sel":  "", // Selector string (empty for now)
			"chan": 0,  // Channel (0 = default)
		}

		kiwiBands = append(kiwiBands, kiwiBand)
	}

	// Build complete dxcfg structure
	// Note: This does NOT include DX labels (bookmarks) - those require implementing
	// the SET MARKER protocol on the server side with a proper database backend
	dxcfg := map[string]interface{}{
		"dx_type":  dxTypes,
		"band_svc": bandSvc,
		"bands":    kiwiBands,
	}

	// Marshal to JSON
	dxcfgJSON, err := json.Marshal(dxcfg)
	if err != nil {
		log.Printf("Error marshaling dxcfg: %v", err)
		return `{"dx_type":[{"key":0,"name":"type-0","color":"white"},{"key":1,"name":"type-1","color":"white"},{"key":2,"name":"type-2","color":"white"},{"key":3,"name":"type-3","color":"white"},{"key":4,"name":"type-4","color":"white"},{"key":5,"name":"type-5","color":"white"},{"key":6,"name":"type-6","color":"white"},{"key":7,"name":"type-7","color":"white"},{"key":8,"name":"type-8","color":"white"},{"key":9,"name":"type-9","color":"white"},{"key":10,"name":"type-10","color":"white"},{"key":11,"name":"type-11","color":"white"},{"key":12,"name":"type-12","color":"white"},{"key":13,"name":"type-13","color":"white"},{"key":14,"name":"type-14","color":"white"},{"key":15,"name":"type-15","color":"white"}],"band_svc":[],"bands":[]}`
	}

	return string(dxcfgJSON)
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
	// Only show Kiwi protocol users (not native UberSDR users, decoders, etc.)
	// Group sessions by user_session_id to combine audio and spectrum sessions
	userMap := make(map[string]*KiwiUserInfo)

	for _, sessionInfo := range allSessions {
		// Skip internal sessions (no client IP)
		clientIP, _ := sessionInfo["client_ip"].(string)
		if clientIP == "" {
			continue
		}

		userSessionID, _ := sessionInfo["user_session_id"].(string)
		if userSessionID == "" {
			continue // Skip sessions without UUID
		}

		// Only include Kiwi protocol users
		if !strings.HasPrefix(userSessionID, "kiwi-") {
			continue // Skip non-Kiwi users (native UberSDR clients, decoders, etc.)
		}

		// Check if we already have this user
		if _, exists := userMap[userSessionID]; !exists {
			// Get or assign RX slot for this Kiwi user
			rxSlot := kc.handler.getOrAssignRXSlot(userSessionID)

			// New Kiwi user, create entry
			user := &KiwiUserInfo{
				Index:           rxSlot, // Use assigned RX slot number
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

			// Get user agent if available
			if userAgent, ok := sessionInfo["user_agent"].(string); ok && userAgent != "" {
				// Encode using %20 for spaces (not +)
				user.Name = kiwiEncodeString(userAgent)
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
				// UberSDR stores frequencies in Hz, KiwiSDR protocol also expects Hz
				user.Frequency = int(freq)
			}
			if mode, ok := sessionInfo["mode"].(string); ok {
				user.Mode = mode
			}
		} else if user.Frequency == 0 {
			// Spectrum session and no frequency set yet
			if freq, ok := sessionInfo["frequency"].(uint64); ok {
				// UberSDR stores frequencies in Hz, KiwiSDR protocol also expects Hz
				user.Frequency = int(freq)
			}
			user.Mode = "spectrum"
		}
	}

	// Convert map to array and sort by index for consistent ordering
	users := make([]KiwiUserInfo, 0, len(userMap))
	for _, user := range userMap {
		users = append(users, *user)
	}

	// Sort by index to ensure consistent ordering
	// This prevents the user list from jumping around on each update
	sort.Slice(users, func(i, j int) bool {
		return users[i].Index < users[j].Index
	})

	// Marshal to JSON (compact, no indentation)
	jsonData, err := json.Marshal(users)
	if err != nil {
		log.Printf("Error marshaling user list: %v", err)
		return
	}

	// Send as MSG user_cb=<json>
	// The JSON must be sent as a single message without line breaks
	jsonStr := string(jsonData)
	// Remove any newlines that might have been added
	jsonStr = strings.ReplaceAll(jsonStr, "\n", "")
	jsonStr = strings.ReplaceAll(jsonStr, "\r", "")

	// user_cb is NOT URL-decoded by the Kiwi client, so send raw JSON
	// Spaces in string values have been replaced with underscores above
	log.Printf("Sending user_cb JSON (%d bytes)", len(jsonStr))
	kc.sendMsg("user_cb", jsonStr)
}

// handleMarkerCommand processes MARKER commands and sends DX labels (bookmarks)
func (kc *kiwiConn) handleMarkerCommand(params map[string]string) {
	// Parse parameters
	minStr, hasMin := params["min"]
	maxStr, hasMax := params["max"]

	if !hasMin || !hasMax {
		log.Printf("KiwiSDR: MARKER command missing min/max parameters")
		return
	}

	// Parse frequency range (in kHz)
	minKHz, err := strconv.ParseFloat(minStr, 64)
	if err != nil {
		log.Printf("KiwiSDR: Invalid min frequency: %v", err)
		return
	}
	maxKHz, err := strconv.ParseFloat(maxStr, 64)
	if err != nil {
		log.Printf("KiwiSDR: Invalid max frequency: %v", err)
		return
	}

	// Convert to Hz for comparison with UberSDR bookmarks
	minHz := uint64(minKHz * 1000)
	maxHz := uint64(maxKHz * 1000)

	log.Printf("KiwiSDR: MARKER request for %.3f - %.3f kHz", minKHz, maxKHz)

	// Build bookmark type mapping (group -> type index)
	groupToType := make(map[string]int)
	nextType := 0
	for _, bookmark := range kc.config.Bookmarks {
		group := bookmark.Group
		if group == "" {
			group = "General"
		}
		if _, exists := groupToType[group]; !exists && nextType < 16 {
			groupToType[group] = nextType
			nextType++
		}
	}

	// Mode name to index mapping (from Kiwi's mode list)
	modeToIndex := map[string]int{
		"am": 0, "amn": 1, "usb": 2, "lsb": 3, "cw": 4, "cwn": 5,
		"nbfm": 6, "iq": 7, "drm": 8, "usn": 9, "lsn": 10,
		"sam": 11, "sau": 12, "sal": 13, "sas": 14, "qam": 15,
		"cwu": 4, // Map cwu to cw
	}

	// Filter bookmarks within the requested frequency range
	var matchingBookmarks []map[string]interface{}
	for _, bookmark := range kc.config.Bookmarks {
		if bookmark.Frequency >= minHz && bookmark.Frequency <= maxHz {
			freqKHz := float64(bookmark.Frequency) / 1000.0

			// Determine type from group
			group := bookmark.Group
			if group == "" {
				group = "General"
			}
			bookmarkType := groupToType[group]

			// Encode mode in flags (bits 0-7)
			modeIndex := 0 // Default to AM
			if bookmark.Mode != "" {
				if idx, ok := modeToIndex[strings.ToLower(bookmark.Mode)]; ok {
					modeIndex = idx
				}
			}

			// Build flags: type in bits 16-31, mode in bits 0-7
			flags := (bookmarkType << 16) | modeIndex

			// Build bookmark entry in Kiwi format
			// Encode string values using %20 for spaces (not +)
			encodedName := kiwiEncodeString(bookmark.Name)
			encodedComment := kiwiEncodeString(bookmark.Comment)

			entry := map[string]interface{}{
				"f":  freqKHz,                // Frequency in kHz
				"i":  encodedName,            // Ident (encoded with %20)
				"fl": flags,                  // Flags: type (16-31) + mode (0-7)
				"g":  len(matchingBookmarks), // GID (index)
				"lo": 0,                      // Passband low (0 = use mode default)
				"hi": 0,                      // Passband high (0 = use mode default)
				"o":  0,                      // Offset (0 = no offset)
				"s":  0,                      // Signal bandwidth (0 = unknown)
				"b":  0,                      // Begin time (0 = 00:00, always active)
				"e":  2400,                   // End time (2400 = 24:00, always active)
			}

			// Add optional fields
			if encodedComment != "" {
				entry["n"] = encodedComment // Notes (encoded with %20)
			}

			matchingBookmarks = append(matchingBookmarks, entry)
		}
	}

	log.Printf("KiwiSDR: Found %d bookmarks in range", len(matchingBookmarks))

	// Build response array with header
	response := make([]interface{}, len(matchingBookmarks)+1)

	// Count bookmarks by type for the header
	typeCounts := make([]int, 16)
	for _, bm := range matchingBookmarks {
		if fl, ok := bm["fl"].(int); ok {
			typeIdx := (fl >> 16) & 0xFFFF
			if typeIdx < 16 {
				typeCounts[typeIdx]++
			}
		}
	}

	// Header entry (index 0)
	response[0] = map[string]interface{}{
		"pe": 0,          // Parse errors
		"fe": 0,          // Format errors
		"tc": typeCounts, // Type counts
		"s":  0,          // Server time (seconds)
		"m":  0,          // Server time (milliseconds)
	}

	// Add bookmark entries
	for i, bookmark := range matchingBookmarks {
		response[i+1] = bookmark
	}

	// Marshal to JSON
	jsonData, err := json.Marshal(response)
	if err != nil {
		log.Printf("KiwiSDR: Error marshaling marker response: %v", err)
		return
	}

	// Log first bookmark for debugging
	if len(matchingBookmarks) > 0 {
		log.Printf("KiwiSDR: Sample bookmark: %+v", matchingBookmarks[0])
	}
	// mkr is NOT URL-decoded by the Kiwi client, so send raw JSON
	// Spaces in string values have been replaced with underscores above
	jsonStr := string(jsonData)

	log.Printf("KiwiSDR: Sending mkr (%d bytes, %d bookmarks)", len(jsonStr), len(matchingBookmarks))
	kc.sendMsg("mkr", jsonStr)
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

			// PCMData is already []byte (big-endian int16)
			// This is what KiwiSDR expects for uncompressed audio
			pcmData := audioPacket.PCMData

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

			// S-meter: Get actual baseband power from radiod channel status
			// KiwiSDR S-meter encoding: smeter_value = (dBm + 127) * 10
			// We have dBFS from radiod, convert to approximate dBm using configured offset
			smeterValue := uint16(770) // Default fallback value (-50 dBm)
			if kc.session != nil && kc.radiod != nil {
				// Get channel status from radiod
				if channelStatus := kc.radiod.GetChannelStatus(kc.session.SSRC); channelStatus != nil {
					// Convert dBFS to approximate dBm using configured calibration offset
					// The offset is configured in config.yaml as kiwisdr_smeter_offset
					dbm := channelStatus.BasebandPower + kc.config.Server.KiwiSDRSmeterOffset
					// Clamp to reasonable range (-127 to 0 dBm)
					if dbm < -127 {
						dbm = -127
					}
					if dbm > 0 {
						dbm = 0
					}
					// Encode: (dBm + 127) * 10
					smeterValue = uint16((dbm + 127) * 10)
				}
			}
			binary.BigEndian.PutUint16(packet[5:7], smeterValue)
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

	packetCount := 0
	wfSequence := uint32(0)

	for {
		// Wait for session to be created by zoom command
		if kc.session == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

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

			// Debug: Log first packet to verify we're receiving data
			if packetCount == 1 {
				log.Printf("First waterfall packet: len=%d, first 10 values: %v", len(spectrumData), spectrumData[:10])
			}

			// Unwrap FFT data for KiwiSDR
			// Radiod sends wrapped FFT: [DC...+Nyquist, -Nyquist...-DC]
			// KiwiSDR expects unwrapped: [-Nyquist...DC...+Nyquist]
			N := len(spectrumData)
			halfBins := N / 2
			unwrapped := make([]float32, N)

			// Copy second half (negative frequencies) to start
			copy(unwrapped[0:halfBins], spectrumData[halfBins:N])
			// Copy first half (positive frequencies) to end
			copy(unwrapped[halfBins:N], spectrumData[0:halfBins])

			// Debug: Log unwrapped data
			if packetCount == 1 {
				log.Printf("Unwrapped: first 10 values: %v", unwrapped[:10])
			}

			// Get current zoom, xBin, and compression flag for packet building
			kc.mu.RLock()
			currentZoom := kc.zoom
			currentXBin := kc.xBin
			useCompression := kc.wfCompression
			kc.mu.RUnlock()

			// KiwiSDR protocol always expects exactly 1024 bins
			// If radiod sent fewer bins (due to narrow bandwidth optimization), interpolate up
			//
			// IMPORTANT: We cannot crop the data because the client calculates frequencies based on
			// x_bin and zoom level, assuming the 1024 bins represent the full span at that zoom.
			// Cropping would break frequency alignment.
			//
			// Instead, we accept that at deep zoom levels (12+), radiod's minimum bin bandwidth
			// constraint means we send a wider span than requested. The client will display this
			// wider span, but frequencies will be correctly aligned.
			const targetBins = 1024
			if N < targetBins {
				interpolated := make([]float32, targetBins)
				for i := 0; i < targetBins; i++ {
					// Map output bin i to input position in unwrapped
					srcPos := float64(i) * float64(N-1) / float64(targetBins-1)
					srcIdx := int(srcPos)
					frac := float32(srcPos - float64(srcIdx))

					// Linear interpolation
					if srcIdx+1 < N {
						interpolated[i] = unwrapped[srcIdx]*(1-frac) + unwrapped[srcIdx+1]*frac
					} else {
						interpolated[i] = unwrapped[srcIdx]
					}
				}

				if packetCount == 1 {
					log.Printf("INTERPOLATE: Radiod sent %d bins, interpolated to %d for KiwiSDR", N, targetBins)
				}

				unwrapped = interpolated
				N = targetBins
			}

			// Convert unwrapped spectrum data (float32 dBFS) to KiwiSDR waterfall format
			// KiwiSDR wire protocol (from openwebrx.js dB_wire_to_dBm):
			//   Wire format: byte_value = 255 + dBm (where dBm is 0 to -200)
			//   Decoding: dBm = -(255 - byte_value) + wf.cal
			//
			// So: byte 255 = 0 dBm (strongest signal)
			//     byte 55 = -200 dBm (weakest signal)
			//
			// We have dBFS values from radiod. Apply calibration to convert to dBm,
			// then encode using KiwiSDR wire format.
			// Real KiwiSDR shows mean byte values of 162-163 (dBm = -(255-162) = -93 dBm)
			// The previous issue was ADPCM compression being enabled for waterfall data
			// Now with compression disabled, use moderate calibration offset
			wfCalibration := float32(-13.0) // Calibration offset in dB to convert dBFS to dBm

			wfData := make([]byte, N)
			for i, dbfsValue := range unwrapped {
				// Apply calibration offset to convert dBFS to dBm
				dBm := dbfsValue + wfCalibration

				// Clamp to -200..0 dBm range (KiwiSDR protocol range)
				if dBm < -200 {
					dBm = -200
				}
				if dBm > 0 {
					dBm = 0
				}

				// Encode using KiwiSDR wire format: byte = 255 + dBm
				// Since dBm is negative, this gives us the correct range
				byteVal := int(255 + dBm)
				if byteVal < 0 {
					byteVal = 0
				}
				if byteVal > 255 {
					byteVal = 255
				}
				wfData[i] = byte(byteVal)
			}

			// Debug: Log encoded data
			if packetCount == 1 {
				log.Printf("Encoded wfData: first 10 values: %v", wfData[:10])
			}

			// Prepare encoded data (compression flag already read above)
			var encodedData []byte
			var flags uint32

			if useCompression {
				// Reset encoder for each waterfall line (as per KiwiSDR protocol)
				kc.wfAdpcmEncoder = NewIMAAdpcmEncoder()
				// ADPCM expects int16 PCM data (big-endian)
				// Convert unsigned bytes (0-255) to signed int16 centered at 0
				pcmData := make([]byte, len(wfData)*2)
				for i, b := range wfData {
					// Convert unsigned byte to signed int16: (b - 128) * 256
					// This gives proper 16-bit range for ADPCM
					val := int16(int(b)-128) * 256
					binary.BigEndian.PutUint16(pcmData[i*2:], uint16(val))
				}
				encodedData = kc.wfAdpcmEncoder.Encode(pcmData)
				flags = 1 // Compression flag (bit 0)
			} else {
				encodedData = wfData
				flags = 0
			}

			// Build W/F packet: [x_bin:4][flags_zoom:4][seq:4][data]
			// flags_zoom = (flags << 16) | (zoom & 0xffff)
			packet := make([]byte, 12+len(encodedData))
			binary.LittleEndian.PutUint32(packet[0:4], currentXBin)                            // x_bin (current bin position)
			binary.LittleEndian.PutUint32(packet[4:8], (flags<<16)|uint32(currentZoom&0xffff)) // flags_zoom
			binary.LittleEndian.PutUint32(packet[8:12], wfSequence)                            // sequence
			copy(packet[12:], encodedData)

			// Debug: Log packet structure for first few packets
			if packetCount <= 3 {
				log.Printf("W/F packet #%d: xBin=%d, zoom=%d, flags=%d, seq=%d, dataLen=%d, compressed=%v",
					packetCount, currentXBin, currentZoom, flags, wfSequence, len(encodedData), useCompression)
				log.Printf("First 10 bytes of encoded data: %v", encodedData[:10])
				// Calculate what frequency range this represents
				if kc.session != nil {
					log.Printf("Session freq=%d Hz, binBW=%.2f Hz", kc.session.Frequency, kc.session.BinBandwidth)
				}
			}

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
