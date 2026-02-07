package main

import (
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
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
	conn              atomic.Value // stores net.Conn
	mu                sync.RWMutex // Only for handlers, lastActivityTime, lastSpotTime
	connected         atomic.Bool  // Atomic for lock-free access
	stopChan          chan struct{}
	restartChan       chan struct{} // Signal to restart worker goroutine
	lastActivityTime  time.Time     // For monitoring only
	lastSpotTime      time.Time     // Time when last actual CW spot was received
	spotHandlers      []func(CWSkimmerSpot)
	messageHandlers   []func(string)
	spotsLogger       *CWSkimmerSpotsLogger
	pskReporter       *PSKReporter
	ctyDatabase       *CTYDatabase
	receiverLat       float64
	receiverLon       float64
	prometheusMetrics *PrometheusMetrics
	metrics           *CWSkimmerMetrics
	debugCounter      int // For debug logging
}

// NewCWSkimmerClient creates a new CW Skimmer client
func NewCWSkimmerClient(config *CWSkimmerConfig, ctyDatabase *CTYDatabase, receiverLat, receiverLon float64) *CWSkimmerClient {
	return &CWSkimmerClient{
		config:          config,
		stopChan:        make(chan struct{}),
		restartChan:     make(chan struct{}, 1), // Buffered to prevent blocking
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

// Start begins the CW Skimmer client with supervisor pattern
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

	// Start supervisor goroutine that manages worker lifecycle
	go c.supervisorLoop()

	return nil
}

// Stop gracefully stops the CW Skimmer client
func (c *CWSkimmerClient) Stop() {
	log.Println("CW Skimmer: Stopping client")
	close(c.stopChan)

	if conn := c.conn.Load(); conn != nil {
		conn.(net.Conn).Close()
	}
}

// IsConnected returns whether the client is currently connected
func (c *CWSkimmerClient) IsConnected() bool {
	return c.connected.Load()
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

// supervisorLoop manages worker goroutine lifecycle with automatic restart
func (c *CWSkimmerClient) supervisorLoop() {
	log.Println("CW Skimmer: Supervisor started")

	// Start initial worker
	go c.connectionWorker()

	for {
		select {
		case <-c.stopChan:
			log.Println("CW Skimmer: Supervisor stopped")
			return
		case <-c.restartChan:
			// Worker exited, restart immediately
			log.Println("CW Skimmer: Worker exited, restarting immediately")
			go c.connectionWorker()
		}
	}
}

// connectionWorker handles a single connection session
func (c *CWSkimmerClient) connectionWorker() {
	// Signal supervisor when this worker exits
	defer func() {
		log.Println("CW Skimmer: Worker goroutine exiting")

		// Ensure we're fully disconnected
		if c.connected.Load() {
			log.Println("CW Skimmer: Worker exit with connection still marked as connected, forcing cleanup")
			c.connected.Store(false)
		}

		// Signal restart with timeout protection
		select {
		case c.restartChan <- struct{}{}:
			log.Println("CW Skimmer: Successfully signaled supervisor for restart")
		case <-time.After(1 * time.Second):
			log.Println("CW Skimmer: WARNING: Failed to signal restart (timeout)")
		}
	}()

	log.Println("CW Skimmer: Worker attempting connection...")
	if err := c.connect(); err != nil {
		log.Printf("CW Skimmer: Connection failed: %v", err)
		time.Sleep(5 * time.Second) // Back off before restart
		return                      // Exit worker, supervisor will restart
	}

	// Connection succeeded, handle it until disconnect
	log.Println("CW Skimmer: Connection successful, entering message handler")
	c.handleConnection()
	log.Println("CW Skimmer: Message handler exited")
	// Worker exits here, supervisor will restart
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

	c.conn.Store(conn)
	c.connected.Store(true)

	c.mu.Lock()
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

// disconnect closes the connection - simple and atomic
func (c *CWSkimmerClient) disconnect() {
	log.Println("CW Skimmer: disconnect() called")

	if !c.connected.Load() {
		log.Println("CW Skimmer: Already disconnected")
		return
	}

	log.Println("CW Skimmer: Disconnecting...")
	c.connected.Store(false)

	// Close the socket
	if conn := c.conn.Load(); conn != nil {
		log.Println("CW Skimmer: Closing socket")
		conn.(net.Conn).Close()
		// Don't store nil - atomic.Value doesn't allow it
	}

	log.Println("CW Skimmer: Disconnected")
}

// login performs the login sequence using raw reads
func (c *CWSkimmerClient) login() error {
	conn := c.conn.Load()
	if conn == nil {
		return fmt.Errorf("not connected")
	}

	netConn := conn.(net.Conn)

	// Read banner
	netConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 4096)
	n, err := netConn.Read(buf)
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

	// Read welcome messages
	netConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err = netConn.Read(buf)
	if err != nil {
		return fmt.Errorf("failed to read welcome: %w", err)
	}
	welcome := string(buf[:n])
	lines := strings.Split(welcome, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			log.Printf("CW Skimmer: << %s", line)
		}
	}

	log.Println("CW Skimmer: Login completed")

	// Update last activity time
	c.mu.Lock()
	c.lastActivityTime = time.Now()
	c.mu.Unlock()

	// Clear the read deadline from login - handleConnection will set its own
	netConn.SetReadDeadline(time.Time{})
	log.Println("CW Skimmer: Cleared read deadline after login")

	return nil
}

// handleConnection reads and processes messages from the skimmer using raw reads
func (c *CWSkimmerClient) handleConnection() {
	defer log.Println("CW Skimmer: handleConnection() exiting")

	log.Println("CW Skimmer: handleConnection() started")

	// Get connection ONCE at start to avoid race conditions
	conn := c.conn.Load()
	if conn == nil {
		log.Println("CW Skimmer: No connection available")
		return
	}
	netConn := conn.(net.Conn)

	// Set read timeout to 15 minutes - if no data for 15 minutes, connection is dead
	readTimeout := 15 * time.Minute
	log.Printf("CW Skimmer: Read timeout set to %v", readTimeout)

	// Buffer for reading data
	buf := make([]byte, 4096)
	var lineBuffer string

	lastDebugLog := time.Now()
	lastReadLog := time.Now()
	spotCount := 0
	readCount := 0

	for {
		// Check if we're still connected (lock-free atomic check)
		if !c.connected.Load() {
			log.Println("CW Skimmer: Connection closed, exiting handler")
			return
		}

		// Set deadline before each read (use cached netConn)
		deadline := time.Now().Add(readTimeout)
		if err := netConn.SetReadDeadline(deadline); err != nil {
			log.Printf("CW Skimmer: Cannot set read deadline: %v", err)
			c.disconnect()
			return
		}

		// Log if we haven't read anything in 30 seconds (diagnostic)
		if time.Since(lastReadLog) > 30*time.Second {
			log.Printf("CW Skimmer: DEBUG - Waiting for data, last read %v ago, %d reads, %d spots",
				time.Since(lastReadLog), readCount, spotCount)
			lastReadLog = time.Now()
		}

		// Read from connection (use cached netConn)
		n, err := netConn.Read(buf)
		readCount++
		lastReadLog = time.Now()

		if err != nil {
			// Check if it's a timeout error
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				c.mu.RLock()
				lastActivity := c.lastActivityTime
				c.mu.RUnlock()
				log.Printf("CW Skimmer: Read timeout after %v idle (triggering reconnect)", time.Since(lastActivity))
			} else {
				c.mu.RLock()
				lastActivity := c.lastActivityTime
				c.mu.RUnlock()
				log.Printf("CW Skimmer: Read error after %v idle: %v (type: %T)", time.Since(lastActivity), err, err)
			}
			c.disconnect()
			return
		}

		if n == 0 {
			c.mu.RLock()
			lastActivity := c.lastActivityTime
			c.mu.RUnlock()
			log.Printf("CW Skimmer: Read 0 bytes (EOF) after %v idle", time.Since(lastActivity))
			c.disconnect()
			return
		}

		// Add to line buffer and process complete lines
		lineBuffer += string(buf[:n])

		// Process all complete lines (ending with \n)
		for {
			idx := strings.IndexByte(lineBuffer, '\n')
			if idx == -1 {
				break // No complete line yet
			}

			// Extract line (remove \r\n or \n)
			line := lineBuffer[:idx]
			lineBuffer = lineBuffer[idx+1:]
			line = strings.TrimRight(line, "\r")
			line = strings.TrimSpace(line)

			if line != "" {
				// Log non-spot messages only (spots are too noisy)
				if !strings.HasPrefix(line, "DX de ") {
					log.Printf("CW Skimmer: << %s", line)
				}

				// Update last activity time and last spot time if this is a spot
				now := time.Now()
				isSpot := strings.HasPrefix(line, "DX de ")

				c.mu.Lock()
				c.lastActivityTime = now
				if isSpot {
					c.lastSpotTime = now
				}
				c.mu.Unlock()

				// Copy handlers BEFORE calling processLine to avoid lock contention
				c.mu.RLock()
				spotHandlers := make([]func(CWSkimmerSpot), len(c.spotHandlers))
				copy(spotHandlers, c.spotHandlers)
				messageHandlers := make([]func(string), len(c.messageHandlers))
				copy(messageHandlers, c.messageHandlers)
				c.mu.RUnlock()

				// Process line with handlers (no locks will be acquired in processLine)
				c.processLine(line, spotHandlers, messageHandlers)

				// Log periodic health check (every 100 spots or 5 minutes)
				if strings.HasPrefix(line, "DX de ") {
					spotCount++
					if spotCount%100 == 0 || time.Since(lastDebugLog) > 5*time.Minute {
						log.Printf("CW Skimmer: Health check - %d spots received, last activity %v ago",
							spotCount, time.Since(now))
						lastDebugLog = now
					}
				}
			}
		}
	}
}

// writeLine writes a line to the connection
func (c *CWSkimmerClient) writeLine(line string) error {
	conn := c.conn.Load()
	if conn == nil {
		return fmt.Errorf("not connected")
	}

	netConn := conn.(net.Conn)
	netConn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := fmt.Fprintf(netConn, "%s\r\n", line)
	return err
}

// processLine processes a line from the skimmer
// Handlers are passed as parameters to avoid any lock acquisition in this function
// ALL operations are async to prevent blocking the main read loop
func (c *CWSkimmerClient) processLine(line string, spotHandlers []func(CWSkimmerSpot), messageHandlers []func(string)) {
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

		// Note: lastSpotTime is now updated by the caller before calling processLine
		// This avoids any lock acquisition in this function

		// Enrich with CTY data (no locks held)
		c.enrichSpot(&spot)

		// Record in metrics ASYNCHRONOUSLY (prevents blocking main read loop)
		if c.metrics != nil {
			go c.metrics.RecordSpot(spot.Band, spot.DXCall, spot.WPM)
		}

		// Log to CSV ASYNCHRONOUSLY (already queues to channel, but wrap in goroutine for safety)
		if c.config.SpotsLogEnabled && c.spotsLogger != nil {
			go func(s CWSkimmerSpot) {
				if err := c.spotsLogger.LogSpot(&s); err != nil {
					log.Printf("CW Skimmer: Failed to log spot: %v", err)
				}
			}(spot)
		}

		// Submit to PSKReporter ASYNCHRONOUSLY (prevents blocking on network I/O)
		if c.config.PSKReporterEnabled && c.pskReporter != nil {
			go func(s CWSkimmerSpot) {
				if err := c.submitToPSKReporter(&s); err != nil {
					log.Printf("CW Skimmer: Failed to submit to PSKReporter: %v", err)
				}
			}(spot)
		}

		// Call spot handlers (handlers already copied by caller, no locks needed)
		for _, handler := range spotHandlers {
			go handler(spot)
		}
	} else {
		// Call message handlers for non-spot lines (handlers already copied by caller)
		for _, handler := range messageHandlers {
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
		// CTY.DAT uses NEGATIVE for East (backwards!), so negate to get standard coords (+ for East)
		spot.Latitude = info.Latitude
		spot.Longitude = -info.Longitude
		
		// DEBUG: Log first 5 coordinate conversions to verify negation is working
		c.debugCounter++
		if c.debugCounter <= 5 {
			log.Printf("DEBUG %s: CTY lon=%f, negated lon=%f, country=%s", spot.DXCall, info.Longitude, spot.Longitude, info.Country)
		}

		// Calculate distance and bearing if receiver location is set
		// Both receiver and spot coords are now in standard format (+ for East, - for West)
		if c.receiverLat != 0 || c.receiverLon != 0 {
			if info.Latitude != 0 || info.Longitude != 0 {
				distance, bearing := CalculateDistanceAndBearing(c.receiverLat, c.receiverLon, spot.Latitude, spot.Longitude)
				spot.DistanceKm = &distance
				spot.BearingDeg = &bearing
			}
		}
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
