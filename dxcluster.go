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
}

// DXClusterClient manages connection to a DX cluster
type DXClusterClient struct {
	config          *DXClusterConfig
	conn            net.Conn
	reader          *bufio.Reader
	mu              sync.RWMutex
	connected       bool
	stopChan        chan struct{}
	reconnectTimer  *time.Timer
	keepaliveTimer  *time.Timer
	spotHandlers    []func(DXSpot)
	messageHandlers []func(string)
}

// NewDXClusterClient creates a new DX cluster client
func NewDXClusterClient(config *DXClusterConfig) *DXClusterClient {
	return &DXClusterClient{
		config:          config,
		stopChan:        make(chan struct{}),
		spotHandlers:    make([]func(DXSpot), 0),
		messageHandlers: make([]func(string), 0),
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
	c.mu.Unlock()

	log.Printf("DX Cluster: Connected to %s", addr)

	// Perform login
	if err := c.login(); err != nil {
		c.disconnect()
		return fmt.Errorf("login failed: %w", err)
	}

	return nil
}

// disconnect closes the connection
func (c *DXClusterClient) disconnect() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.connected = false
	if c.keepaliveTimer != nil {
		c.keepaliveTimer.Stop()
		c.keepaliveTimer = nil
	}
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.reader = nil

	log.Println("DX Cluster: Disconnected")
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
			log.Printf("DX Cluster: << %s", strings.TrimSpace(line))
		}
	}

	// Check for success
	welcomeLower := strings.ToLower(welcome)
	if strings.Contains(welcomeLower, "hello") ||
		strings.Contains(welcomeLower, "running dxspider") {
		log.Println("DX Cluster: Login successful")
	} else {
		log.Println("DX Cluster: Login completed")
	}

	// Clear read deadline for normal operation
	conn.SetReadDeadline(time.Time{})

	// Start keepalive timer
	c.startKeepalive()

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
				c.disconnect()
				c.scheduleReconnect()
				return
			}

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

	// DX callsign
	spot.DXCall = fields[1]

	// Rest is comment
	if len(fields) > 2 {
		spot.Comment = strings.Join(fields[2:], " ")
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
