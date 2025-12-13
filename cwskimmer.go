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
	config               *CWSkimmerConfig
	conn                 net.Conn
	scanner              *bufio.Scanner
	mu                   sync.RWMutex
	connected            bool
	stopChan             chan struct{}
	restartChan          chan struct{} // Signal to restart worker goroutine
	keepaliveStop        chan struct{} // Signal to stop keepalive goroutine
	lastActivityTime     time.Time     // For monitoring only
	lastSpotTime         time.Time     // Time when last actual CW spot was received
	lastPingTime         time.Time     // Time when last ping was sent
	lastPingResponseTime time.Time     // Time when last ping response was received
	spotHandlers         []func(CWSkimmerSpot)
	messageHandlers      []func(string)
	spotsLogger          *CWSkimmerSpotsLogger
	pskReporter          *PSKReporter
	ctyDatabase          *CTYDatabase
	receiverLat          float64
	receiverLon          float64
	prometheusMetrics    *PrometheusMetrics
	metrics              *CWSkimmerMetrics
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

	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.mu.Unlock()
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
		c.mu.Lock()
		if c.connected {
			log.Println("CW Skimmer: Worker exit with connection still marked as connected, forcing cleanup")
			c.connected = false
		}
		c.mu.Unlock()

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

	c.mu.Lock()
	c.conn = conn
	c.scanner = bufio.NewScanner(conn)
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

// disconnect closes the connection - simple and atomic
func (c *CWSkimmerClient) disconnect() {
	c.mu.Lock()

	if !c.connected {
		c.mu.Unlock()
		return
	}

	log.Println("CW Skimmer: Disconnecting...")
	c.connected = false

	// Stop keepalive goroutine if running
	if c.keepaliveStop != nil {
		close(c.keepaliveStop)
		c.keepaliveStop = nil
	}

	// Close the socket - this will immediately unblock any pending reads
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}

	c.scanner = nil
	c.mu.Unlock()

	log.Println("CW Skimmer: Disconnected")
}

// login performs the login sequence
func (c *CWSkimmerClient) login() error {
	c.mu.RLock()
	conn := c.conn
	scanner := c.scanner
	c.mu.RUnlock()

	if conn == nil || scanner == nil {
		return fmt.Errorf("not connected")
	}

	// Read banner lines until we get the prompt or timeout
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	// Read and log banner
	if scanner.Scan() {
		banner := scanner.Text()
		log.Printf("CW Skimmer: << %s", banner)
	}

	// Send callsign
	if err := c.writeLine(c.config.Callsign); err != nil {
		return err
	}
	log.Printf("CW Skimmer: >> %s", c.config.Callsign)

	// Read welcome messages
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 10 && scanner.Scan(); i++ {
		line := scanner.Text()
		if line != "" {
			log.Printf("CW Skimmer: << %s", line)
		}
		// Stop if we see the prompt indicator
		if strings.Contains(line, "CwSkimmer >") || strings.Contains(line, "de SKIMMER") {
			break
		}
	}

	log.Println("CW Skimmer: Login completed")

	// Reset ping timestamps and create keepalive stop channel for new connection
	c.mu.Lock()
	c.lastActivityTime = time.Now()
	c.lastPingTime = time.Time{}
	c.lastPingResponseTime = time.Time{}
	c.keepaliveStop = make(chan struct{})
	keepaliveStop := c.keepaliveStop
	c.mu.Unlock()

	log.Println("CW Skimmer: Reset ping timestamps for new connection")

	// Start keepalive goroutine
	go c.keepaliveLoop(keepaliveStop)

	return nil
}

// handleConnection reads and processes messages from the skimmer
func (c *CWSkimmerClient) handleConnection() {
	defer log.Println("CW Skimmer: handleConnection() exiting")

	c.mu.RLock()
	keepaliveDelay := c.config.KeepAliveDelay
	scanner := c.scanner
	conn := c.conn
	c.mu.RUnlock()

	if scanner == nil || conn == nil {
		log.Println("CW Skimmer: No scanner or connection available")
		return
	}

	// Set read timeout for each scan
	readTimeout := time.Duration(keepaliveDelay*2) * time.Second

	for {
		// Check if we're still connected
		if !c.IsConnected() {
			log.Println("CW Skimmer: Connection closed")
			return
		}

		// Set deadline before each read
		conn.SetReadDeadline(time.Now().Add(readTimeout))

		// Scan for next line
		if !scanner.Scan() {
			// Check for error
			if err := scanner.Err(); err != nil {
				log.Printf("CW Skimmer: Scanner error: %v", err)
			} else {
				log.Println("CW Skimmer: Scanner reached EOF")
			}
			c.disconnect()
			return
		}

		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			log.Printf("CW Skimmer: << %s", line)
		}

		// Update last activity time
		c.mu.Lock()
		c.lastActivityTime = time.Now()
		c.mu.Unlock()

		c.processLine(line)
	}
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
	// Check for ping response (server responds with "Unknown command: "PING"")
	if strings.Contains(line, "Unknown command") && strings.Contains(line, "PING") {
		// Ping response received - connection is alive
		c.mu.Lock()
		lastPing := c.lastPingTime
		c.lastPingResponseTime = time.Now()
		c.mu.Unlock()

		if !lastPing.IsZero() {
			elapsed := time.Since(lastPing)
			log.Printf("CW Skimmer: Ping response received in %v", elapsed)
		}
		return
	}

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

		// Update last spot time for health monitoring
		c.mu.Lock()
		c.lastSpotTime = time.Now()
		c.mu.Unlock()

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

// keepaliveLoop sends periodic pings to keep the connection alive
func (c *CWSkimmerClient) keepaliveLoop(stopChan chan struct{}) {
	keepaliveDelay := time.Duration(c.config.KeepAliveDelay) * time.Second
	ticker := time.NewTicker(keepaliveDelay)
	defer ticker.Stop()

	for {
		select {
		case <-stopChan:
			log.Println("CW Skimmer: Keepalive loop stopped")
			return
		case <-ticker.C:
			if !c.IsConnected() {
				return
			}

			// Check if previous ping got a response
			c.mu.Lock()
			lastPing := c.lastPingTime
			lastResponse := c.lastPingResponseTime
			c.mu.Unlock()

			// If we sent a ping but never got response, force reconnect
			if !lastPing.IsZero() && (lastResponse.IsZero() || lastResponse.Before(lastPing)) {
				log.Printf("CW Skimmer: Ping timeout - no response since %v", lastPing)
				c.disconnect()
				return
			}

			log.Println("CW Skimmer: Sending ping")

			// Record ping time
			c.mu.Lock()
			c.lastPingTime = time.Now()
			c.mu.Unlock()

			// Send ping command
			if err := c.writeLine("ping"); err != nil {
				log.Printf("CW Skimmer: Keepalive write failed: %v", err)
				c.disconnect()
				return
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
