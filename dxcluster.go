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

// DXSpot represents a DX spot from the cluster
type DXSpot struct {
	Frequency float64   `json:"frequency"` // Frequency in Hz
	DXCall    string    `json:"dx_call"`   // Callsign being spotted
	Spotter   string    `json:"spotter"`   // Callsign of spotter
	Comment   string    `json:"comment"`   // Spot comment
	Time      time.Time `json:"time"`      // Time of spot
	Raw       string    `json:"raw"`       // Raw spot line
	Band      string    `json:"band"`      // Amateur radio band (e.g., "20m", "40m")
	Country   string    `json:"country"`   // Country name from CTY lookup
	Continent string    `json:"continent"` // Continent code from CTY lookup
}

// frequencyToBand converts a frequency in Hz to an amateur radio band name
func frequencyToBand(freqHz float64) string {
	// Convert to MHz for easier comparison
	freqMHz := freqHz / 1000000.0

	// Amateur radio bands from 2200m to 6m
	switch {
	case freqMHz >= 0.1357 && freqMHz <= 0.1378:
		return "2200m"
	case freqMHz >= 0.470 && freqMHz < 0.480:
		return "630m"
	case freqMHz >= 1.8 && freqMHz <= 2.0:
		return "160m"
	case freqMHz >= 3.5 && freqMHz <= 4.0:
		return "80m"
	case freqMHz >= 5.25 && freqMHz <= 5.45:
		return "60m"
	case freqMHz >= 7.0 && freqMHz <= 7.3:
		return "40m"
	case freqMHz >= 10.1 && freqMHz <= 10.15:
		return "30m"
	case freqMHz >= 14.0 && freqMHz <= 14.35:
		return "20m"
	case freqMHz >= 18.068 && freqMHz <= 18.168:
		return "17m"
	case freqMHz >= 21.0 && freqMHz <= 21.45:
		return "15m"
	case freqMHz >= 24.89 && freqMHz <= 24.99:
		return "12m"
	case freqMHz >= 28.0 && freqMHz <= 29.7:
		return "10m"
	case freqMHz >= 50.0 && freqMHz <= 54.0:
		return "6m"
	default:
		return "other"
	}
}

// SetPrometheusMetrics sets the Prometheus metrics instance for this DX cluster client
func (c *DXClusterClient) SetPrometheusMetrics(pm *PrometheusMetrics) {
	c.prometheusMetrics = pm
}

// DXClusterClient manages connection to a DX cluster
type DXClusterClient struct {
	config            *DXClusterConfig
	conn              net.Conn
	reader            *bufio.Reader
	mu                sync.RWMutex
	connected         bool
	stopChan          chan struct{}
	reconnectTimer    *time.Timer
	keepaliveTimer    *time.Timer
	inactivityTimer   *time.Timer
	lastActivityTime  time.Time
	spotHandlers      []func(DXSpot)
	messageHandlers   []func(string)
	spotBuffer        []DXSpot // Circular buffer for last N spots
	bufferSize        int      // Maximum buffer size
	prometheusMetrics *PrometheusMetrics
}

// NewDXClusterClient creates a new DX cluster client
func NewDXClusterClient(config *DXClusterConfig) *DXClusterClient {
	return &DXClusterClient{
		config:          config,
		stopChan:        make(chan struct{}),
		spotHandlers:    make([]func(DXSpot), 0),
		messageHandlers: make([]func(string), 0),
		spotBuffer:      make([]DXSpot, 0, 100),
		bufferSize:      100,
	}
}

// Start begins the DX cluster client connection and reconnection loop
func (c *DXClusterClient) Start() error {
	if !c.config.Enabled {
		log.Println("DX Cluster: Disabled in configuration")
		return nil
	}

	if c.config.Host == "" {
		return fmt.Errorf("DX cluster host not configured")
	}

	if c.config.Callsign == "" {
		return fmt.Errorf("DX cluster callsign not configured")
	}

	log.Printf("DX Cluster: Starting client for %s:%d", c.config.Host, c.config.Port)

	// Start connection in background
	go c.connectionLoop()

	return nil
}

// Stop gracefully stops the DX cluster client
func (c *DXClusterClient) Stop() {
	log.Println("DX Cluster: Stopping client")
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
func (c *DXClusterClient) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// OnSpot registers a handler for DX spots
func (c *DXClusterClient) OnSpot(handler func(DXSpot)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spotHandlers = append(c.spotHandlers, handler)
}

// OnMessage registers a handler for cluster messages
func (c *DXClusterClient) OnMessage(handler func(string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messageHandlers = append(c.messageHandlers, handler)
}

// connectionLoop manages the connection lifecycle with automatic reconnection
func (c *DXClusterClient) connectionLoop() {
	for {
		select {
		case <-c.stopChan:
			return
		default:
			if err := c.connect(); err != nil {
				log.Printf("DX Cluster: Connection failed: %v", err)
				c.scheduleReconnect()
			} else {
				// Connection succeeded, handle it
				c.handleConnection()
			}
		}
	}
}

// connect establishes a connection to the DX cluster
func (c *DXClusterClient) connect() error {
	addr := fmt.Sprintf("%s:%d", c.config.Host, c.config.Port)
	log.Printf("DX Cluster: Connecting to %s", addr)

	conn, err := net.DialTimeout("tcp", addr, 30*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.connected = true
	c.lastActivityTime = time.Now()
	c.mu.Unlock()

	// Record connection in Prometheus
	if c.prometheusMetrics != nil {
		c.prometheusMetrics.RecordDXClusterConnection()
	}

	log.Printf("DX Cluster: Connected to %s", addr)

	// Perform login
	if err := c.login(); err != nil {
		c.disconnect()
		return fmt.Errorf("login failed: %w", err)
	}

	return nil
}

// disconnect closes the connection and returns true if it actually disconnected
func (c *DXClusterClient) disconnect() bool {
	c.mu.Lock()
	wasConnected := c.connected
	if !wasConnected {
		// Already disconnected, nothing to do
		c.mu.Unlock()
		return false
	}

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

	// Record disconnection in Prometheus
	if c.prometheusMetrics != nil {
		c.prometheusMetrics.RecordDXClusterDisconnect()
	}

	log.Println("DX Cluster: Disconnected")
	return true
}

// login performs the login sequence
func (c *DXClusterClient) login() error {
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
	log.Printf("DX Cluster: << %s", strings.TrimSpace(banner))

	// Check if we got login prompt
	if !strings.Contains(strings.ToLower(banner), "login:") {
		return fmt.Errorf("login prompt not found in banner")
	}

	// Send callsign
	if err := c.writeLine(c.config.Callsign); err != nil {
		return err
	}
	log.Printf("DX Cluster: >> %s", c.config.Callsign)

	// IMPORTANT: We just did a direct conn.Read() which bypassed the buffered reader
	// We need to recreate the buffered reader so it starts fresh from the current socket position
	c.mu.Lock()
	c.reader = bufio.NewReader(c.conn)
	c.mu.Unlock()

	// Read welcome response line by line using the buffered reader
	// This ensures we consume everything including the final prompt
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	loginSuccessful := false

	// Keep reading until we get the prompt line (starts with callsign + " de ")
	for {
		line, err := c.readLine()
		if err != nil {
			return fmt.Errorf("failed to read welcome: %w", err)
		}

		log.Printf("DX Cluster: << %s", line)

		// Check for successful login indicators
		lineLower := strings.ToLower(line)
		if strings.Contains(lineLower, "hello") || strings.Contains(lineLower, "running dxspider") {
			loginSuccessful = true
		}

		// Check if this is the prompt line (contains our callsign followed by " de ")
		// and ends with ">"
		if strings.Contains(line, c.config.Callsign+" de ") && strings.HasSuffix(line, ">") {
			// This is the final prompt, we're done
			break
		}
	}

	if loginSuccessful {
		log.Println("DX Cluster: Login successful")
	} else {
		log.Println("DX Cluster: Login completed")
	}

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

// handleConnection reads and processes messages from the cluster
func (c *DXClusterClient) handleConnection() {
	for {
		select {
		case <-c.stopChan:
			c.disconnect()
			return
		default:
			line, err := c.readLine()
			if err != nil {
				log.Printf("DX Cluster: Read error: %v", err)
				// Only schedule reconnect if we actually disconnected
				// (if already disconnected by another goroutine, don't duplicate)
				if c.disconnect() {
					c.scheduleReconnect()
				}
				return
			}

			// Update last activity time on successful read
			c.mu.Lock()
			c.lastActivityTime = time.Now()
			c.mu.Unlock()

			// Reset inactivity timer
			c.resetInactivityTimer()

			// Process the line
			c.processLine(line)
		}
	}
}

// readLine reads a line from the connection with timeout
// Handles both \n and \r\n line endings, and also handles prompts without newlines
func (c *DXClusterClient) readLine() (string, error) {
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

// readLineOrPrompt reads a line or a prompt (text without newline)
func (c *DXClusterClient) readLineOrPrompt(timeout time.Duration) (string, error) {
	c.mu.RLock()
	reader := c.reader
	conn := c.conn
	c.mu.RUnlock()

	if reader == nil || conn == nil {
		return "", fmt.Errorf("not connected")
	}

	// Set read deadline
	if conn != nil {
		conn.SetReadDeadline(time.Now().Add(timeout))
	}

	// Try to read until newline
	line, err := reader.ReadString('\n')
	if err != nil {
		// If timeout and we have buffered data, return it (might be a prompt)
		if reader.Buffered() > 0 {
			// Read what's available
			buf := make([]byte, reader.Buffered())
			n, _ := reader.Read(buf)
			if n > 0 {
				return strings.TrimSpace(string(buf[:n])), nil
			}
		}
		return "", err
	}

	return strings.TrimSpace(line), nil
}

// writeLine writes a line to the connection
func (c *DXClusterClient) writeLine(line string) error {
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

// processLine processes a line from the cluster
func (c *DXClusterClient) processLine(line string) {
	// Skip empty lines
	if line == "" {
		return
	}

	// Try to parse as DX spot
	if spot, ok := c.parseDXSpot(line); ok {
		// Filter spots: only process spots between 0 and 30 MHz
		if spot.Frequency <= 0 || spot.Frequency > 30000000 {
			log.Printf("DX Cluster: Spot filtered out (frequency %.1f kHz outside 0-30 MHz range)",
				spot.Frequency/1000)
			return
		}

		// Add to buffer
		c.addSpotToBuffer(spot)

		// Call spot handlers
		c.mu.RLock()
		handlers := c.spotHandlers
		c.mu.RUnlock()

		for _, handler := range handlers {
			go handler(spot)
		}
	} else {
		// Check if this looks like it should have been a spot but failed to parse
		if strings.HasPrefix(line, "DX de ") {
			log.Printf("DX Cluster: Failed to parse spot line: %s", line)
		}

		// Call message handlers for non-spot lines
		c.mu.RLock()
		handlers := c.messageHandlers
		c.mu.RUnlock()

		for _, handler := range handlers {
			go handler(line)
		}
	}
}

// parseDXSpot attempts to parse a DX spot from a line
// Format: DX de CALLSIGN:     14074.0  DX_CALL       CQ FT8                    1234Z
func (c *DXClusterClient) parseDXSpot(line string) (DXSpot, bool) {
	// Check if line starts with "DX de"
	if !strings.HasPrefix(line, "DX de ") {
		return DXSpot{}, false
	}

	spot := DXSpot{
		Raw:  line,
		Time: time.Now().UTC(),
	}

	// Remove "DX de " prefix
	line = strings.TrimPrefix(line, "DX de ")

	// Split by colon to get spotter
	parts := strings.SplitN(line, ":", 2)
	if len(parts) != 2 {
		return DXSpot{}, false
	}

	spot.Spotter = strings.TrimSpace(parts[0])
	line = strings.TrimSpace(parts[1])

	// Parse frequency and rest
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return DXSpot{}, false
	}

	// Parse frequency (in kHz, convert to Hz)
	var freqKHz float64
	if _, err := fmt.Sscanf(fields[0], "%f", &freqKHz); err != nil {
		return DXSpot{}, false
	}
	spot.Frequency = freqKHz * 1000 // Convert kHz to Hz

	// Calculate band from frequency
	spot.Band = frequencyToBand(spot.Frequency)

	// DX callsign
	spot.DXCall = fields[1]

	// Rest is comment
	if len(fields) > 2 {
		spot.Comment = strings.Join(fields[2:], " ")
	}

	// Perform CTY lookup for country and continent
	if ctyInfo := GetCallsignInfo(spot.DXCall); ctyInfo != nil {
		spot.Country = ctyInfo.Country
		spot.Continent = ctyInfo.Continent
	}

	return spot, true
}

// startKeepalive starts the keepalive timer
func (c *DXClusterClient) startKeepalive() {
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
func (c *DXClusterClient) sendKeepalive() {
	if !c.IsConnected() {
		return
	}

	// Send empty line as keepalive
	if err := c.writeLine(""); err != nil {
		log.Printf("DX Cluster: Keepalive failed: %v", err)
		c.disconnect()
		c.scheduleReconnect()
		return
	}

	// Schedule next keepalive
	c.startKeepalive()
}

// startInactivityMonitor starts the inactivity monitoring timer
func (c *DXClusterClient) startInactivityMonitor() {
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
func (c *DXClusterClient) resetInactivityTimer() {
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
func (c *DXClusterClient) checkInactivity() {
	c.mu.RLock()
	lastActivity := c.lastActivityTime
	connected := c.connected
	c.mu.RUnlock()

	if !connected {
		return
	}

	// Check if we've been inactive for more than 5 minutes
	inactiveDuration := time.Since(lastActivity)
	if inactiveDuration >= 5*time.Minute {
		log.Printf("DX Cluster: No activity for %v, reconnecting", inactiveDuration)
		// Only schedule reconnect if we actually disconnected
		if c.disconnect() {
			c.scheduleReconnect()
		}
	}
}

// scheduleReconnect schedules a reconnection attempt
func (c *DXClusterClient) scheduleReconnect() {
	delay := time.Duration(c.config.ReconnectDelay) * time.Second
	log.Printf("DX Cluster: Reconnecting in %v", delay)

	// Sleep in the connection loop to actually wait
	select {
	case <-c.stopChan:
		return
	case <-time.After(delay):
		// Continue to reconnect
	}
}

// SendCommand sends a command to the cluster
func (c *DXClusterClient) SendCommand(cmd string) error {
	if !c.IsConnected() {
		return fmt.Errorf("not connected")
	}

	log.Printf("DX Cluster: >> %s", cmd)
	return c.writeLine(cmd)
}

// addSpotToBuffer adds a spot to the circular buffer
func (c *DXClusterClient) addSpotToBuffer(spot DXSpot) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Add spot to buffer
	c.spotBuffer = append(c.spotBuffer, spot)

	// If buffer exceeds max size, keep only the most recent spots
	if len(c.spotBuffer) > c.bufferSize {
		c.spotBuffer = c.spotBuffer[len(c.spotBuffer)-c.bufferSize:]
	}
}

// GetBufferedSpots returns a copy of all buffered spots
func (c *DXClusterClient) GetBufferedSpots() []DXSpot {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Return a copy to avoid race conditions
	spots := make([]DXSpot, len(c.spotBuffer))
	copy(spots, c.spotBuffer)
	return spots
}
