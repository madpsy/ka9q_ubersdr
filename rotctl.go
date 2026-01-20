package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RotctlClient represents a client connection to a Hamlib rotctld daemon
// for controlling antenna rotators over TCP/IP using the rotctl protocol.
type RotctlClient struct {
	host              string
	port              int
	conn              net.Conn
	reader            *bufio.Reader
	connected         bool
	mu                sync.Mutex
	timeout           time.Duration
	autoReconnect     bool
	initialRetryDelay time.Duration
	maxRetryDelay     time.Duration
}

// Position represents the azimuth and elevation of an antenna rotator
type Position struct {
	Azimuth   float64 // Azimuth in degrees (0-360)
	Elevation float64 // Elevation in degrees (-90 to +90, typically 0-90)
}

// RotatorInfo contains information about the rotator capabilities
type RotatorInfo struct {
	Model        string
	MinAzimuth   float64
	MaxAzimuth   float64
	MinElevation float64
	MaxElevation float64
	HasElevation bool
}

// NewRotctlClient creates a new rotctl client instance
func NewRotctlClient(host string, port int) *RotctlClient {
	return &RotctlClient{
		host:              host,
		port:              port,
		connected:         false,
		timeout:           5 * time.Second,
		autoReconnect:     true,
		initialRetryDelay: 1 * time.Second,
		maxRetryDelay:     60 * time.Second,
	}
}

// SetTimeout sets the network timeout for operations
func (r *RotctlClient) SetTimeout(timeout time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.timeout = timeout
}

// SetAutoReconnect enables or disables automatic reconnection on connection failure
func (r *RotctlClient) SetAutoReconnect(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.autoReconnect = enabled
}

// SetInitialRetryDelay sets the initial delay for the first reconnection attempt
func (r *RotctlClient) SetInitialRetryDelay(delay time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.initialRetryDelay = delay
}

// SetMaxRetryDelay sets the maximum delay between reconnection attempts
func (r *RotctlClient) SetMaxRetryDelay(delay time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.maxRetryDelay = delay
}

// Connect establishes a connection to the rotctld daemon
func (r *RotctlClient) Connect() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.connected {
		return fmt.Errorf("already connected")
	}

	return r.connectLocked()
}

// connectLocked performs the actual connection (must be called with lock held)
func (r *RotctlClient) connectLocked() error {
	addr := fmt.Sprintf("%s:%d", r.host, r.port)
	conn, err := net.DialTimeout("tcp", addr, r.timeout)
	if err != nil {
		return fmt.Errorf("failed to connect to rotctld at %s: %w", addr, err)
	}

	r.conn = conn
	r.reader = bufio.NewReader(conn)
	r.connected = true

	return nil
}

// reconnect attempts to reconnect to the rotctld daemon with exponential backoff
// Retries indefinitely with exponential backoff up to maxRetryDelay
func (r *RotctlClient) reconnect() error {
	r.mu.Lock()

	if r.connected {
		r.mu.Unlock()
		return nil // Already connected
	}

	// Close any existing connection
	if r.conn != nil {
		r.conn.Close()
		r.conn = nil
		r.reader = nil
	}

	r.mu.Unlock()

	// Exponential backoff with unlimited retries
	delay := r.initialRetryDelay
	attempt := 1

	for {
		r.mu.Lock()
		if err := r.connectLocked(); err == nil {
			r.mu.Unlock()
			return nil // Successfully reconnected
		}
		r.mu.Unlock()

		// Log the attempt (could be replaced with proper logging)
		if attempt == 1 || attempt%10 == 0 {
			// Log every 10th attempt to avoid spam
			fmt.Printf("Reconnection attempt %d failed, retrying in %v...\n", attempt, delay)
		}

		// Sleep with current delay
		time.Sleep(delay)

		// Exponential backoff: double the delay, but cap at maxRetryDelay
		delay *= 2
		if delay > r.maxRetryDelay {
			delay = r.maxRetryDelay
		}

		attempt++
	}
}

// Disconnect closes the connection to the rotctld daemon
func (r *RotctlClient) Disconnect() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.disconnectLocked()
}

// disconnectLocked performs the actual disconnection (must be called with lock held)
func (r *RotctlClient) disconnectLocked() error {
	if !r.connected {
		return nil
	}

	var err error
	if r.conn != nil {
		err = r.conn.Close()
		r.conn = nil
		r.reader = nil
	}

	r.connected = false
	return err
}

// IsConnected returns the current connection status
func (r *RotctlClient) IsConnected() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connected
}

// sendCommand sends a command to rotctld and returns the response
func (r *RotctlClient) sendCommand(cmd string) (string, error) {
	return r.sendCommandWithRetry(cmd, true)
}

// sendCommandWithRetry sends a command with optional automatic retry on connection failure
func (r *RotctlClient) sendCommandWithRetry(cmd string, allowRetry bool) (string, error) {
	r.mu.Lock()

	if !r.connected || r.conn == nil {
		r.mu.Unlock()

		// Try to reconnect if auto-reconnect is enabled
		if allowRetry && r.autoReconnect {
			if err := r.reconnect(); err != nil {
				return "", fmt.Errorf("not connected and reconnection failed: %w", err)
			}
			// Retry the command once after reconnection
			return r.sendCommandWithRetry(cmd, false)
		}

		return "", fmt.Errorf("not connected to rotctld")
	}

	// Set write deadline
	if err := r.conn.SetWriteDeadline(time.Now().Add(r.timeout)); err != nil {
		r.mu.Unlock()
		return "", fmt.Errorf("failed to set write deadline: %w", err)
	}

	// Send command with newline
	_, err := r.conn.Write([]byte(cmd + "\n"))
	if err != nil {
		r.disconnectLocked()
		r.mu.Unlock()

		// Try to reconnect if auto-reconnect is enabled
		if allowRetry && r.autoReconnect {
			if reconnErr := r.reconnect(); reconnErr == nil {
				// Retry the command once after reconnection
				return r.sendCommandWithRetry(cmd, false)
			}
		}

		return "", fmt.Errorf("failed to send command: %w", err)
	}

	// Set read deadline
	if err := r.conn.SetReadDeadline(time.Now().Add(r.timeout)); err != nil {
		r.mu.Unlock()
		return "", fmt.Errorf("failed to set read deadline: %w", err)
	}

	// Read response
	var response strings.Builder
	for {
		line, err := r.reader.ReadString('\n')
		if err != nil {
			r.disconnectLocked()
			r.mu.Unlock()

			// Try to reconnect if auto-reconnect is enabled
			if allowRetry && r.autoReconnect {
				if reconnErr := r.reconnect(); reconnErr == nil {
					// Retry the command once after reconnection
					return r.sendCommandWithRetry(cmd, false)
				}
			}

			return "", fmt.Errorf("failed to read response: %w", err)
		}

		response.WriteString(line)

		// Check if this is the end of the response
		// RPRT responses indicate end of command
		if strings.HasPrefix(line, "RPRT") {
			break
		}

		// For query commands, we expect data followed by RPRT or just data
		// If we got data and the next line would be RPRT, we're done
		if !strings.HasPrefix(cmd, "\\") && len(strings.TrimSpace(line)) > 0 {
			// Peek to see if next line is RPRT
			peek, _ := r.reader.Peek(4)
			if len(peek) >= 4 && string(peek[:4]) == "RPRT" {
				// Read the RPRT line
				rprtLine, _ := r.reader.ReadString('\n')
				response.WriteString(rprtLine)
				break
			}
			// For position queries, we expect two lines (azimuth and elevation)
			if cmd == "p" {
				line2, err := r.reader.ReadString('\n')
				if err != nil {
					r.disconnectLocked()
					r.mu.Unlock()

					// Try to reconnect if auto-reconnect is enabled
					if allowRetry && r.autoReconnect {
						if reconnErr := r.reconnect(); reconnErr == nil {
							// Retry the command once after reconnection
							return r.sendCommandWithRetry(cmd, false)
						}
					}

					return "", fmt.Errorf("failed to read second line: %w", err)
				}
				response.WriteString(line2)
				break
			}
		}
	}

	r.mu.Unlock()
	return response.String(), nil
}

// checkResponse checks if the response indicates success
func checkResponse(response string) error {
	lines := strings.Split(strings.TrimSpace(response), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "RPRT") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				code, err := strconv.Atoi(parts[1])
				if err != nil {
					return fmt.Errorf("invalid RPRT response: %s", line)
				}
				if code != 0 {
					return fmt.Errorf("rotctld error: RPRT %d (%s)", code, getErrorMessage(code))
				}
			}
		}
	}
	return nil
}

// getErrorMessage returns a human-readable error message for RPRT codes
func getErrorMessage(code int) string {
	messages := map[int]string{
		-1:  "invalid parameter",
		-2:  "invalid configuration",
		-3:  "out of memory",
		-4:  "not implemented",
		-5:  "communication timed out",
		-6:  "IO error",
		-7:  "internal error",
		-8:  "protocol error",
		-9:  "command rejected",
		-10: "argument error",
		-11: "invalid VFO",
		-12: "argument out of range",
	}
	if msg, ok := messages[code]; ok {
		return msg
	}
	return "unknown error"
}

// GetPosition retrieves the current position of the rotator
func (r *RotctlClient) GetPosition() (*Position, error) {
	response, err := r.sendCommand("p")
	if err != nil {
		return nil, err
	}

	lines := strings.Split(strings.TrimSpace(response), "\n")
	if len(lines) < 2 {
		return nil, fmt.Errorf("invalid position response: expected 2 lines, got %d", len(lines))
	}

	azimuth, err := strconv.ParseFloat(strings.TrimSpace(lines[0]), 64)
	if err != nil {
		return nil, fmt.Errorf("failed to parse azimuth: %w", err)
	}

	elevation, err := strconv.ParseFloat(strings.TrimSpace(lines[1]), 64)
	if err != nil {
		return nil, fmt.Errorf("failed to parse elevation: %w", err)
	}

	return &Position{
		Azimuth:   azimuth,
		Elevation: elevation,
	}, nil
}

// SetPosition sets the rotator to the specified position
func (r *RotctlClient) SetPosition(azimuth, elevation float64) error {
	log.Printf("Rotator: Setting position to azimuth=%.1f°, elevation=%.1f°", azimuth, elevation)

	cmd := fmt.Sprintf("P %.6f %.6f", azimuth, elevation)
	response, err := r.sendCommand(cmd)
	if err != nil {
		log.Printf("Rotator: Failed to set position: %v", err)
		return err
	}

	if err := checkResponse(response); err != nil {
		log.Printf("Rotator: Error response when setting position: %v", err)
		return err
	}

	log.Printf("Rotator: Successfully set position to azimuth=%.1f°, elevation=%.1f°", azimuth, elevation)
	return nil
}

// SetAzimuth sets only the azimuth, keeping elevation unchanged
func (r *RotctlClient) SetAzimuth(azimuth float64) error {
	log.Printf("Rotator: Setting azimuth to %.1f°", azimuth)

	// Get current position first
	pos, err := r.GetPosition()
	if err != nil {
		log.Printf("Rotator: Failed to get current position: %v", err)
		return fmt.Errorf("failed to get current position: %w", err)
	}

	return r.SetPosition(azimuth, pos.Elevation)
}

// SetElevation sets only the elevation, keeping azimuth unchanged
func (r *RotctlClient) SetElevation(elevation float64) error {
	log.Printf("Rotator: Setting elevation to %.1f°", elevation)

	// Get current position first
	pos, err := r.GetPosition()
	if err != nil {
		log.Printf("Rotator: Failed to get current position: %v", err)
		return fmt.Errorf("failed to get current position: %w", err)
	}

	return r.SetPosition(pos.Azimuth, elevation)
}

// Stop stops any ongoing rotator movement
func (r *RotctlClient) Stop() error {
	response, err := r.sendCommand("S")
	if err != nil {
		return err
	}

	return checkResponse(response)
}

// Park moves the rotator to its park position
func (r *RotctlClient) Park() error {
	response, err := r.sendCommand("K")
	if err != nil {
		return err
	}

	return checkResponse(response)
}

// Reset resets the rotator
func (r *RotctlClient) Reset() error {
	response, err := r.sendCommand("R")
	if err != nil {
		return err
	}

	return checkResponse(response)
}

// Move initiates movement to the specified position (non-blocking)
func (r *RotctlClient) Move(azimuth, elevation float64) error {
	cmd := fmt.Sprintf("M %.6f %.6f", azimuth, elevation)
	response, err := r.sendCommand(cmd)
	if err != nil {
		return err
	}

	return checkResponse(response)
}

// GetInfo retrieves information about the rotator
func (r *RotctlClient) GetInfo() (*RotatorInfo, error) {
	response, err := r.sendCommand("_")
	if err != nil {
		return nil, err
	}

	// Parse the info response
	info := &RotatorInfo{
		Model:        "Unknown",
		MinAzimuth:   0,
		MaxAzimuth:   360,
		MinElevation: 0,
		MaxElevation: 90,
		HasElevation: true,
	}

	// The response format varies, but typically includes model info
	lines := strings.Split(strings.TrimSpace(response), "\n")
	if len(lines) > 0 {
		info.Model = strings.TrimSpace(lines[0])
	}

	return info, nil
}

// DumpState retrieves the complete state and capabilities of the rotator
func (r *RotctlClient) DumpState() (string, error) {
	response, err := r.sendCommand("\\dump_state")
	if err != nil {
		return "", err
	}

	return response, nil
}

// RotatorState holds the current state of the rotator for application use
type RotatorState struct {
	Position  *Position
	Moving    bool
	LastError error
	UpdatedAt time.Time
}

// RotatorController manages rotator state and provides thread-safe access
type RotatorController struct {
	client    *RotctlClient
	state     *RotatorState
	mu        sync.RWMutex
	targetPos *Position
}

// NewRotatorController creates a new rotator controller
func NewRotatorController(host string, port int) *RotatorController {
	return &RotatorController{
		client: NewRotctlClient(host, port),
		state: &RotatorState{
			Position:  &Position{Azimuth: 0, Elevation: 0},
			Moving:    false,
			UpdatedAt: time.Now(),
		},
	}
}

// Connect connects to the rotctld daemon
func (rc *RotatorController) Connect() error {
	return rc.client.Connect()
}

// Disconnect disconnects from the rotctld daemon
func (rc *RotatorController) Disconnect() error {
	return rc.client.Disconnect()
}

// UpdateState polls the rotator and updates the cached state
func (rc *RotatorController) UpdateState() error {
	pos, err := rc.client.GetPosition()

	rc.mu.Lock()
	defer rc.mu.Unlock()

	if err != nil {
		rc.state.LastError = err
		return err
	}

	rc.state.Position = pos
	rc.state.LastError = nil
	rc.state.UpdatedAt = time.Now()

	// Check if we're still moving based on target position
	if rc.targetPos != nil {
		// Check if we've reached the target (within 2 degree tolerance)
		azDiff := rc.targetPos.Azimuth - pos.Azimuth
		elDiff := rc.targetPos.Elevation - pos.Elevation
		if azDiff < 0 {
			azDiff = -azDiff
		}
		if elDiff < 0 {
			elDiff = -elDiff
		}

		// Handle azimuth wrap-around (e.g., 359° to 1° is only 2° difference)
		if azDiff > 180 {
			azDiff = 360 - azDiff
		}

		// Still moving if we're more than 2 degrees away from target
		if azDiff > 2.0 || elDiff > 2.0 {
			rc.state.Moving = true
		} else {
			// Reached target
			rc.state.Moving = false
			rc.targetPos = nil
		}
	} else {
		rc.state.Moving = false
	}

	return nil
}

// GetState returns a copy of the current cached state
func (rc *RotatorController) GetState() RotatorState {
	rc.mu.RLock()
	defer rc.mu.RUnlock()

	return RotatorState{
		Position:  &Position{Azimuth: rc.state.Position.Azimuth, Elevation: rc.state.Position.Elevation},
		Moving:    rc.state.Moving,
		LastError: rc.state.LastError,
		UpdatedAt: rc.state.UpdatedAt,
	}
}

// SetPosition sets the rotator position and updates state
func (rc *RotatorController) SetPosition(azimuth, elevation float64) error {
	log.Printf("RotatorController: Requesting position change to azimuth=%.1f°, elevation=%.1f°", azimuth, elevation)

	rc.mu.Lock()
	rc.state.Moving = true
	rc.targetPos = &Position{Azimuth: azimuth, Elevation: elevation}
	rc.mu.Unlock()

	err := rc.client.SetPosition(azimuth, elevation)

	rc.mu.Lock()
	if err != nil {
		rc.state.LastError = err
		rc.state.Moving = false
		rc.targetPos = nil
		log.Printf("RotatorController: Position change failed: %v", err)
	} else {
		log.Printf("RotatorController: Position change command sent successfully")
	}
	// Don't set Moving to false here - let UpdateState determine it based on position
	rc.mu.Unlock()

	return err
}

// SetAzimuth sets only the azimuth
func (rc *RotatorController) SetAzimuth(azimuth float64) error {
	log.Printf("RotatorController: Requesting azimuth change to %.1f°", azimuth)

	// Get current elevation for target position
	rc.mu.RLock()
	currentEl := rc.state.Position.Elevation
	rc.mu.RUnlock()

	rc.mu.Lock()
	rc.state.Moving = true
	rc.targetPos = &Position{Azimuth: azimuth, Elevation: currentEl}
	rc.mu.Unlock()

	err := rc.client.SetAzimuth(azimuth)

	rc.mu.Lock()
	if err != nil {
		rc.state.LastError = err
		rc.state.Moving = false
		rc.targetPos = nil
		log.Printf("RotatorController: Azimuth change failed: %v", err)
	} else {
		log.Printf("RotatorController: Azimuth change command sent successfully")
	}
	// Don't set Moving to false here - let UpdateState determine it based on position
	rc.mu.Unlock()

	return err
}

// SetElevation sets only the elevation
func (rc *RotatorController) SetElevation(elevation float64) error {
	log.Printf("RotatorController: Requesting elevation change to %.1f°", elevation)

	// Get current azimuth for target position
	rc.mu.RLock()
	currentAz := rc.state.Position.Azimuth
	rc.mu.RUnlock()

	rc.mu.Lock()
	rc.state.Moving = true
	rc.targetPos = &Position{Azimuth: currentAz, Elevation: elevation}
	rc.mu.Unlock()

	err := rc.client.SetElevation(elevation)

	rc.mu.Lock()
	if err != nil {
		rc.state.LastError = err
		rc.state.Moving = false
		rc.targetPos = nil
		log.Printf("RotatorController: Elevation change failed: %v", err)
	} else {
		log.Printf("RotatorController: Elevation change command sent successfully")
	}
	// Don't set Moving to false here - let UpdateState determine it based on position
	rc.mu.Unlock()

	return err
}

// Stop stops the rotator
func (rc *RotatorController) Stop() error {
	err := rc.client.Stop()

	rc.mu.Lock()
	rc.state.Moving = false
	if err != nil {
		rc.state.LastError = err
	}
	rc.mu.Unlock()

	return err
}

// Park parks the rotator
func (rc *RotatorController) Park() error {
	return rc.client.Park()
}

// GetClient returns the underlying rotctl client for direct access
func (rc *RotatorController) GetClient() *RotctlClient {
	return rc.client
}
