package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// CWSkimmerSpot represents a CW spot from the skimmer
type CWSkimmerSpot struct {
	Frequency float64   `json:"frequency"` // Frequency in Hz
	DXCall    string    `json:"dx_call"`   // Callsign being spotted
	Spotter   string    `json:"spotter"`   // Skimmer callsign
	SNR       int       `json:"snr"`       // Signal strength in dB
	WPM       int       `json:"wpm"`       // CW speed in WPM
	Comment   string    `json:"comment"`   // Additional info (CQ, DE, etc.)
	Time      time.Time `json:"time"`      // Spot timestamp
	Band      string    `json:"band"`      // Amateur radio band

	// CTY enrichment (same as decoder spots)
	Country    string   `json:"country"`
	CQZone     int      `json:"cq_zone"`
	ITUZone    int      `json:"itu_zone"`
	Continent  string   `json:"continent"`
	Latitude   float64  `json:"latitude"`
	Longitude  float64  `json:"longitude"`
	DistanceKm *float64 `json:"distance_km,omitempty"`
	BearingDeg *float64 `json:"bearing_deg,omitempty"`
}

// CWSkimmerClient manages connection to a CW Skimmer server
type CWSkimmerClient struct {
	config            *CWSkimmerConfig
	conn              net.Conn
	reader            *bufio.Reader
	mu                sync.RWMutex
	connected         bool
	stopChan          chan struct{}
	reconnectTimer    *time.Timer
	keepaliveTimer    *time.Timer
	inactivityTimer   *time.Timer
	lastActivityTime  time.Time
	spotHandlers      []func(CWSkimmerSpot)
	messageHandlers   []func(string)
	spotsLogger       *CWSkimmerSpotsLogger
	pskReporter       *PSKReporter
	ctyDatabase       *CTYDatabase
	receiverLat       float64
	receiverLon       float64
	prometheusMetrics *PrometheusMetrics
	metrics           *CWSkimmerMetrics
}

// NewCWSkimmerClient creates a new CW Skimmer client
func NewCWSkimmerClient(config *CWSkimmerConfig, ctyDatabase *CTYDatabase, receiverLat, receiverLon float64) *CWSkimmerClient {
	return &CWSkimmerClient{
		config:          config,
		stopChan:        make(chan struct{}),
		spotHandlers:    make([]func(CWSkimmerSpot), 0),
		messageHandlers: make([]func(string), 0),
		ctyDatabase:     ctyDatabase,
		receiverLat:     receiverLat,
		receiverLon:     receiverLon,
	}
}

// SetSpotsLogger sets the spots logger for CSV logging
func (c *CWSkimmerClient) SetSpotsLogger(logger *CWSkimmerSpotsLogger) {
	c.spotsLogger = logger
}

// SetPSKReporter sets the PSKReporter instance for spot uploads
func (c *CWSkimmerClient) SetPSKReporter(psk *PSKReporter) {
	c.pskReporter = psk
}

// SetPrometheusMetrics sets the Prometheus metrics instance
func (c *CWSkimmerClient) SetPrometheusMetrics(pm *PrometheusMetrics) {
	c.prometheusMetrics = pm
}

// SetMetrics sets the metrics tracker instance
func (c *CWSkimmerClient) SetMetrics(m *CWSkimmerMetrics) {
	c.metrics = m
}

// Start begins the CW Skimmer client connection and reconnection loop
func (c *CWSkimmerClient) Start() error {
	if !c.config.Enabled {
		log.Println("CW Skimmer: Disabled in configuration")
		return nil
	}

	if c.config.Host == "" {
		return fmt.Errorf("CW Skimmer host not configured")
	}

	if c.config.Callsign == "" {
		return fmt.Errorf("CW Skimmer callsign not configured")
	}

	log.Printf("CW Skimmer: Starting client for %s:%d", c.config.Host, c.config.Port)

	// Start connection in background
	go c.connectionLoop()

	return nil
}

// Stop gracefully stops the CW Skimmer client
func (c *CWSkimmerClient) Stop() {
	log.Println("CW Skimmer: Stopping client")
	close(c.stopChan)

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.reconnectTimer != nil {
		c.reconnectTimer.Stop()
	}
	if c.keepaliveTimer != nil {
		c.keepaliveTimer.Stop()
	}
	if c.inactivityTimer != nil {
		c.inactivityTimer.Stop()
	}
	if c.conn != nil {
		c.conn.Close()
	}
}

// IsConnected returns whether the client is currently connected
func (c *CWSkimmerClient) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// OnSpot registers a handler for CW spots
func (c *CWSkimmerClient) OnSpot(handler func(CWSkimmerSpot)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spotHandlers = append(c.spotHandlers, handler)
}

// OnMessage registers a handler for skimmer messages
func (c *CWSkimmerClient) OnMessage(handler func(string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messageHandlers = append(c.messageHandlers, handler)
}

// connectionLoop manages the connection lifecycle with automatic reconnection
func (c *CWSkimmerClient) connectionLoop() {
	for {
		select {
		case <-c.stopChan:
			log.Println("CW Skimmer: Connection loop stopped")
			return
		default:
			log.Println("CW Skimmer: Attempting connection...")
			if err := c.connect(); err != nil {
				log.Printf("CW Skimmer: Connection failed: %v", err)
				c.waitBeforeReconnect()
			} else {
				// Connection succeeded, handle it
				log.Println("CW Skimmer: Connection successful, entering message handler")
				c.handleConnection()
				log.Println("CW Skimmer: Message handler exited, will reconnect")
				c.waitBeforeReconnect()
			}
		}
	}
}

// connect establishes a connection to the CW Skimmer server
func (c *CWSkimmerClient) connect() error {
	addr := fmt.Sprintf("%s:%d", c.config.Host, c.config.Port)
	log.Printf("CW Skimmer: Connecting to %s (timeout: 10s)", addr)

	// Use 10 second timeout for connection
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.connected = true
	c.lastActivityTime = time.Now()
	c.mu.Unlock()

	log.Printf("CW Skimmer: TCP connection established to %s", addr)

	// Perform login with timeout
	loginDone := make(chan error, 1)
	go func() {
		loginDone <- c.login()
	}()

	select {
	case err := <-loginDone:
		if err != nil {
			c.disconnect()
			return fmt.Errorf("login failed: %w", err)
		}
		log.Println("CW Skimmer: Login successful")
		return nil
	case <-time.After(10 * time.Second):
		c.disconnect()
		return fmt.Errorf("login timeout after 10 seconds")
	}
}

// disconnect closes the connection
func (c *CWSkimmerClient) disconnect() {
	c.mu.Lock()
	c.connected = false
	if c.keepaliveTimer != nil {
		c.keepaliveTimer.Stop()
		c.keepaliveTimer = nil
	}
	if c.inactivityTimer != nil {
		c.inactivityTimer.Stop()
		c.inactivityTimer = nil
	}
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.reader = nil
	c.mu.Unlock()

	log.Println("CW Skimmer: Disconnected")
}

// login performs the login sequence
func (c *CWSkimmerClient) login() error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn == nil {
		return fmt.Errorf("not connected")
	}

	// Read initial data (banner or login prompt) - use short timeout
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return fmt.Errorf("failed to read banner: %w", err)
	}

	banner := string(buf[:n])
	log.Printf("CW Skimmer: << %s", strings.TrimSpace(banner))

	// Send callsign
	if err := c.writeLine(c.config.Callsign); err != nil {
		return err
	}
	log.Printf("CW Skimmer: >> %s", c.config.Callsign)

	// Read welcome response
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	n, err = conn.Read(buf)
	if err != nil {
		return fmt.Errorf("failed to read welcome: %w", err)
	}

	welcome := string(buf[:n])
	// Log first few lines
	lines := strings.Split(welcome, "\n")
	for i, line := range lines {
		if i < 10 && strings.TrimSpace(line) != "" {
			log.Printf("CW Skimmer: << %s", strings.TrimSpace(line))
		}
	}

	// Read the prompt line (e.g., "MM3NDH de SKIMMER 2025-11-21 08:05Z CwSkimmer >")
	// This line doesn't end with newline, so we need to read it with a timeout
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	promptBuf := make([]byte, 1024)
	n, err = conn.Read(promptBuf)
	if err == nil && n > 0 {
		prompt := strings.TrimSpace(string(promptBuf[:n]))
		if prompt != "" {
			log.Printf("CW Skimmer: << %s", prompt)
		}
	}
	// Ignore timeout errors - prompt might not be sent

	log.Println("CW Skimmer: Login completed")

	// Clear read deadline for normal operation
	conn.SetReadDeadline(time.Time{})

	// Update last activity time
	c.mu.Lock()
	c.lastActivityTime = time.Now()
	c.mu.Unlock()

	// Start keepalive timer
	c.startKeepalive()

	// Start inactivity monitor
	c.startInactivityMonitor()

	return nil
}

// handleConnection reads and processes messages from the skimmer
func (c *CWSkimmerClient) handleConnection() {
	// Create a channel for read results
	readChan := make(chan struct {
		line string
		err  error
	})

	// Start a goroutine to read lines
	go func() {
		for {
			line, err := c.readLine()
			select {
			case readChan <- struct {
				line string
				err  error
			}{line, err}:
				if err != nil {
					return
				}
			case <-c.stopChan:
				return
			}
		}
	}()

	for {
		select {
		case <-c.stopChan:
			c.disconnect()
			return
		case result := <-readChan:
			if result.err != nil {
				log.Printf("CW Skimmer: Read error: %v", result.err)
				c.disconnect()
				return
			}

			// Update last activity time on successful read
			c.mu.Lock()
			c.lastActivityTime = time.Now()
			c.mu.Unlock()

			// Reset inactivity timer
			c.resetInactivityTimer()

			// Process the line
			c.processLine(result.line)
		}
	}
}

// readLine reads a line from the connection
func (c *CWSkimmerClient) readLine() (string, error) {
	c.mu.RLock()
	reader := c.reader
	conn := c.conn
	c.mu.RUnlock()

	if reader == nil || conn == nil {
		return "", fmt.Errorf("not connected")
	}

	// Read until \n (which handles both \n and \r\n)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}

	// Trim both \r and \n and any spaces
	return strings.TrimSpace(line), nil
}

// writeLine writes a line to the connection
func (c *CWSkimmerClient) writeLine(line string) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn == nil {
		return fmt.Errorf("not connected")
	}

	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := fmt.Fprintf(conn, "%s\r\n", line)
	return err
}

// processLine processes a line from the skimmer
func (c *CWSkimmerClient) processLine(line string) {
	// Skip empty lines
	if line == "" {
		return
	}

	// Try to parse as CW spot
	if spot, ok := c.parseCWSpot(line); ok {
		// Filter spots: only process spots between 0 and 30 MHz
		if spot.Frequency <= 0 || spot.Frequency > 30000000 {
			// Silently discard spots outside the 0-30 MHz range
			return
		}

		// Enrich with CTY data
		c.enrichSpot(&spot)

		// Record in metrics if enabled
		if c.metrics != nil {
			c.metrics.RecordSpot(spot.Band, spot.DXCall, spot.WPM)
		}

		// Log to CSV if enabled
		if c.config.SpotsLogEnabled && c.spotsLogger != nil {
			if err := c.spotsLogger.LogSpot(&spot); err != nil {
				log.Printf("CW Skimmer: Failed to log spot: %v", err)
			}
		}

		// Submit to PSKReporter if enabled
		if c.config.PSKReporterEnabled && c.pskReporter != nil {
			if err := c.submitToPSKReporter(&spot); err != nil {
				log.Printf("CW Skimmer: Failed to submit to PSKReporter: %v", err)
			}
		}

		// Call spot handlers
		c.mu.RLock()
		handlers := c.spotHandlers
		c.mu.RUnlock()

		for _, handler := range handlers {
			go handler(spot)
		}
	} else {
		// Call message handlers for non-spot lines
		c.mu.RLock()
		handlers := c.messageHandlers
		c.mu.RUnlock()

		for _, handler := range handlers {
			go handler(line)
		}
	}
}

// parseCWSpot attempts to parse a CW spot from a line
// Format: DX de <SPOTTER>: <FREQ> <CALL> <SNR> dB <WPM> WPM <COMMENT> <TIME>Z
// Example: DX de MM3NDH-#:   3537.3  SM4SEF         12 dB  19 WPM  CQ            0724Z
func (c *CWSkimmerClient) parseCWSpot(line string) (CWSkimmerSpot, bool) {
	// Check if line starts with "DX de"
	if !strings.HasPrefix(line, "DX de ") {
		return CWSkimmerSpot{}, false
	}

	spot := CWSkimmerSpot{
		Time: time.Now().UTC(),
	}

	// Remove "DX de " prefix
	line = strings.TrimPrefix(line, "DX de ")

	// Split by colon to get spotter
	parts := strings.SplitN(line, ":", 2)
	if len(parts) != 2 {
		return CWSkimmerSpot{}, false
	}

	// Extract spotter callsign and remove prompt suffix (e.g., "-#")
	spotter := strings.TrimSpace(parts[0])
	// Remove prompt suffix if present (e.g., "MM3NDH-#" -> "MM3NDH")
	if idx := strings.LastIndex(spotter, "-"); idx > 0 {
		// Check if what follows the dash is a single character (prompt indicator)
		suffix := spotter[idx+1:]
		if len(suffix) == 1 {
			spotter = spotter[:idx]
		}
	}
	spot.Spotter = spotter
	line = strings.TrimSpace(parts[1])

	// Parse frequency and rest
	fields := strings.Fields(line)
	if len(fields) < 6 { // Need at least: freq, call, snr, "dB", wpm, "WPM"
		return CWSkimmerSpot{}, false
	}

	// Parse frequency (in kHz, convert to Hz)
	var freqKHz float64
	if _, err := fmt.Sscanf(fields[0], "%f", &freqKHz); err != nil {
		return CWSkimmerSpot{}, false
	}
	spot.Frequency = freqKHz * 1000 // Convert kHz to Hz

	// Calculate band from frequency
	spot.Band = frequencyToBand(spot.Frequency)

	// DX callsign
	spot.DXCall = fields[1]

	// Parse SNR (should be followed by "dB")
	if len(fields) < 4 || fields[3] != "dB" {
		return CWSkimmerSpot{}, false
	}
	if _, err := fmt.Sscanf(fields[2], "%d", &spot.SNR); err != nil {
		return CWSkimmerSpot{}, false
	}

	// Parse WPM (should be followed by "WPM")
	if len(fields) < 6 || fields[5] != "WPM" {
		return CWSkimmerSpot{}, false
	}
	if _, err := fmt.Sscanf(fields[4], "%d", &spot.WPM); err != nil {
		return CWSkimmerSpot{}, false
	}

	// Rest is comment (if any) - just CQ, DE, or empty (don't include WPM or time)
	if len(fields) > 6 {
		// Get remaining fields after WPM
		remainingFields := fields[6:]
		// Remove trailing time if present (ends with Z)
		if len(remainingFields) > 0 && strings.HasSuffix(remainingFields[len(remainingFields)-1], "Z") {
			remainingFields = remainingFields[:len(remainingFields)-1]
		}
		// Join remaining fields (should be CQ, DE, or empty)
		spot.Comment = strings.TrimSpace(strings.Join(remainingFields, " "))
	}
	// If no comment, leave it empty (not "0 WPM")

	return spot, true
}

// enrichSpot enriches a spot with CTY data and distance/bearing
func (c *CWSkimmerClient) enrichSpot(spot *CWSkimmerSpot) {
	if c.ctyDatabase == nil {
		return
	}

	// Lookup callsign in CTY database
	info := c.ctyDatabase.LookupCallsignFull(spot.DXCall)
	if info != nil {
		spot.Country = info.Country
		spot.CQZone = info.CQZone
		spot.ITUZone = info.ITUZone
		spot.Continent = info.Continent

		// Set latitude and longitude from CTY database
		// Note: CTY.DAT uses + for West longitude (opposite of standard geographic convention)
		// We need to negate longitude to convert to standard coordinates (+ for East)
		spot.Latitude = info.Latitude
		spot.Longitude = -info.Longitude // Negate to convert CTY convention to standard

		// Calculate distance and bearing if receiver location is set
		// Note: CalculateDistanceAndBearing expects standard coordinates (East positive),
		// so we must negate the CTY longitude (which uses West positive convention)
		if c.receiverLat != 0 || c.receiverLon != 0 {
			if info.Latitude != 0 || info.Longitude != 0 {
				distance, bearing := CalculateDistanceAndBearing(c.receiverLat, c.receiverLon, info.Latitude, -info.Longitude)
				spot.DistanceKm = &distance
				spot.BearingDeg = &bearing
			}
		}
	}
}

// startKeepalive starts the keepalive timer
func (c *CWSkimmerClient) startKeepalive() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.keepaliveTimer != nil {
		c.keepaliveTimer.Stop()
	}

	c.keepaliveTimer = time.AfterFunc(time.Duration(c.config.KeepAliveDelay)*time.Second, func() {
		c.sendKeepalive()
	})
}

// sendKeepalive sends a keepalive message
func (c *CWSkimmerClient) sendKeepalive() {
	if !c.IsConnected() {
		return
	}

	// Send empty line as keepalive
	if err := c.writeLine(""); err != nil {
		log.Printf("CW Skimmer: Keepalive failed: %v", err)
		c.disconnect()
		return
	}

	// Schedule next keepalive
	c.startKeepalive()
}

// startInactivityMonitor starts the inactivity monitoring timer
func (c *CWSkimmerClient) startInactivityMonitor() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.inactivityTimer != nil {
		c.inactivityTimer.Stop()
	}

	// Set 5 minute inactivity timeout
	c.inactivityTimer = time.AfterFunc(5*time.Minute, func() {
		c.checkInactivity()
	})
}

// resetInactivityTimer resets the inactivity timer
func (c *CWSkimmerClient) resetInactivityTimer() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.inactivityTimer != nil {
		c.inactivityTimer.Stop()
	}

	// Reset 5 minute inactivity timeout
	c.inactivityTimer = time.AfterFunc(5*time.Minute, func() {
		c.checkInactivity()
	})
}

// checkInactivity checks if the connection has been inactive and triggers reconnection
func (c *CWSkimmerClient) checkInactivity() {
	c.mu.Lock()
	lastActivity := c.lastActivityTime
	connected := c.connected
	c.mu.Unlock()

	if !connected {
		return
	}

	// Check if we've been inactive for more than 5 minutes
	inactiveDuration := time.Since(lastActivity)
	if inactiveDuration >= 5*time.Minute {
		log.Printf("CW Skimmer: No activity for %v, reconnecting", inactiveDuration)
		// Use disconnect() to properly clean up timers and close connection
		// This will cause the read in handleConnection to fail and exit
		c.disconnect()
	}
}

// submitToPSKReporter submits a CW spot to PSKReporter
func (c *CWSkimmerClient) submitToPSKReporter(spot *CWSkimmerSpot) error {
	if c.pskReporter == nil {
		return fmt.Errorf("PSKReporter not initialized")
	}

	// Convert CWSkimmerSpot to DecodeInfo for PSKReporter
	decode := &DecodeInfo{
		Callsign:  spot.DXCall,
		Locator:   "", // CW spots don't have locators
		SNR:       spot.SNR,
		Frequency: uint64(spot.Frequency),
		Timestamp: spot.Time,
		Mode:      "CW", // CW mode
	}

	return c.pskReporter.Submit(decode)
}

// waitBeforeReconnect waits before attempting reconnection
func (c *CWSkimmerClient) waitBeforeReconnect() {
	delay := time.Duration(c.config.ReconnectDelay) * time.Second
	log.Printf("CW Skimmer: Scheduling reconnection in %v", delay)

	select {
	case <-c.stopChan:
		log.Println("CW Skimmer: Reconnection cancelled (stop requested)")
	case <-time.After(delay):
		log.Printf("CW Skimmer: Reconnection delay elapsed, will retry connection")
	}
}
