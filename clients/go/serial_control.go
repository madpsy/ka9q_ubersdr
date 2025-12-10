package main

import (
	"bufio"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

// SerialCATServer represents a serial CAT server that emulates a Kenwood TS-480
// This allows external software (like WSJT-X) to control the SDR via serial CAT commands
type SerialCATServer struct {
	port      string
	baudrate  int
	vfo       string // "A" or "B"
	conn      serial.Port
	connected bool
	mu        sync.RWMutex

	// VFO state
	vfoAFreq int
	vfoBFreq int

	// Callbacks to update SDR
	frequencyCallback func(int)
	modeCallback      func(string)
	errorCallback     func(string)

	// Server loop control
	stopChan chan struct{}
	running  bool
}

// NewSerialCATServer creates a new serial CAT server
func NewSerialCATServer(port string, baudrate int, vfo string) *SerialCATServer {
	return &SerialCATServer{
		port:     port,
		baudrate: baudrate,
		vfo:      vfo,
		vfoAFreq: 14074000,
		vfoBFreq: 14074000,
		stopChan: make(chan struct{}),
	}
}

// Start establishes connection to serial port and starts the CAT server
func (s *SerialCATServer) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	mode := &serial.Mode{
		BaudRate: s.baudrate,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	}

	port, err := serial.Open(s.port, mode)
	if err != nil {
		return fmt.Errorf("failed to open serial port %s: %w", s.port, err)
	}

	// Set timeouts
	if err := port.SetReadTimeout(100 * time.Millisecond); err != nil {
		port.Close()
		return fmt.Errorf("failed to set read timeout: %w", err)
	}

	s.conn = port
	s.connected = true
	s.running = true

	// Start server loop in goroutine
	go s.serverLoop()

	return nil
}

// Stop closes the connection and stops the server
func (s *SerialCATServer) Stop() {
	s.mu.Lock()
	s.running = false
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
	s.connected = false
	s.mu.Unlock()

	// Signal stop
	close(s.stopChan)
}

// IsRunning returns whether the server is running
func (s *SerialCATServer) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connected
}

// serverLoop is the main server loop that processes incoming CAT commands
func (s *SerialCATServer) serverLoop() {
	buffer := ""
	reader := bufio.NewReader(s.conn)

	for s.running {
		// Set read timeout
		s.conn.SetReadTimeout(100 * time.Millisecond)

		// Read available data
		data, err := reader.ReadString(';')
		if err != nil {
			// Timeout is normal, continue
			continue
		}

		buffer += data

		// Process complete commands (terminated by semicolon)
		if strings.Contains(buffer, ";") {
			cmd := strings.TrimSpace(buffer)
			buffer = ""

			if cmd != "" {
				response := s.processCommand(cmd)
				if response != "" {
					s.sendResponse(response)
				}
			}
		}
	}
}

// processCommand processes a CAT command and returns response
func (s *SerialCATServer) processCommand(cmd string) string {
	cmd = strings.ToUpper(strings.TrimSuffix(cmd, ";"))

	// ID - Request rig ID
	if cmd == "ID" {
		return "ID019;" // TS-480 ID
	}

	// AI - Auto Information (disable)
	if cmd == "AI" || strings.HasPrefix(cmd, "AI") {
		return "AI0;"
	}

	// FA - VFO A frequency
	if cmd == "FA" {
		return fmt.Sprintf("FA%011d;", s.vfoAFreq)
	}
	if strings.HasPrefix(cmd, "FA") {
		freqStr := strings.TrimPrefix(cmd, "FA")
		if freq, err := strconv.Atoi(freqStr); err == nil {
			s.vfoAFreq = freq
			// Trigger callback to update SDR
			if s.frequencyCallback != nil {
				go s.frequencyCallback(freq)
			}
			return fmt.Sprintf("FA%011d;", freq)
		}
	}

	// FB - VFO B frequency
	if cmd == "FB" {
		return fmt.Sprintf("FB%011d;", s.vfoBFreq)
	}
	if strings.HasPrefix(cmd, "FB") {
		freqStr := strings.TrimPrefix(cmd, "FB")
		if freq, err := strconv.Atoi(freqStr); err == nil {
			s.vfoBFreq = freq
			// Don't change SDR frequency for VFO B
			return fmt.Sprintf("FB%011d;", freq)
		}
	}

	// MD - Mode
	if cmd == "MD" {
		// Return current mode (simplified - always return USB for now)
		return "MD2;"
	}
	if strings.HasPrefix(cmd, "MD") {
		modeCode := strings.TrimPrefix(cmd, "MD")
		// Map Kenwood codes to mode names
		modeMap := map[string]string{
			"1": "lsb",
			"2": "usb",
			"3": "cwu",
			"4": "fm",
			"5": "am",
			"6": "usb", // FSK
			"7": "cwl",
			"8": "usb", // FSK-R
			"9": "usb", // PSK
		}
		if mode, ok := modeMap[modeCode]; ok && s.modeCallback != nil {
			go s.modeCallback(mode)
		}
		return fmt.Sprintf("MD%s;", modeCode)
	}

	// IF - Information (frequency, mode, etc.)
	if cmd == "IF" {
		// IF format: IF00014074000     +000000000200000000;
		return fmt.Sprintf("IF%011d     +000000000200000000;", s.vfoAFreq)
	}

	// TX/RX - Transmit/Receive (acknowledge but don't actually transmit)
	if cmd == "TX" || cmd == "TX0" || cmd == "TX1" {
		return "TX0;"
	}
	if cmd == "RX" {
		return "RX;"
	}

	// FT/FR - VFO select
	if cmd == "FT" || cmd == "FR" {
		vfoNum := "0"
		if s.vfo == "B" {
			vfoNum = "1"
		}
		return fmt.Sprintf("FT%s;", vfoNum)
	}
	if strings.HasPrefix(cmd, "FT") || strings.HasPrefix(cmd, "FR") {
		vfoNum := cmd[2:3]
		if vfoNum == "0" {
			s.vfo = "A"
		} else {
			s.vfo = "B"
		}
		return fmt.Sprintf("FT%s;", vfoNum)
	}

	// PS - Power status (always on)
	if cmd == "PS" || strings.HasPrefix(cmd, "PS") {
		return "PS1;"
	}

	// FW - Firmware version
	if cmd == "FW" {
		return "FW1100;" // TS-480 firmware 1.10
	}

	// KS - Keyer speed (acknowledge but don't change)
	if cmd == "KS" {
		return "KS020;" // 20 WPM
	}
	if strings.HasPrefix(cmd, "KS") {
		speed := cmd[2:5]
		return fmt.Sprintf("KS%s;", speed)
	}

	// Unknown command - no response
	log.Printf("Unknown CAT command: %s", cmd)
	return ""
}

// sendResponse sends a response to the serial port
func (s *SerialCATServer) sendResponse(response string) {
	s.mu.RLock()
	conn := s.conn
	s.mu.RUnlock()

	if conn != nil {
		conn.Write([]byte(response))
	}
}

// UpdateFrequency updates the cached frequency (called when SDR frequency changes)
func (s *SerialCATServer) UpdateFrequency(freq int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.vfo == "A" {
		s.vfoAFreq = freq
	} else {
		s.vfoBFreq = freq
	}
}

// UpdateMode updates the cached mode (called when SDR mode changes)
func (s *SerialCATServer) UpdateMode(mode string) {
	// Mode is stored in the processCommand logic, no need to cache separately
	// This is a no-op for now as mode is returned based on current state
}

// GetPort returns the serial port
func (s *SerialCATServer) GetPort() string {
	return s.port
}

// GetBaudrate returns the baud rate
func (s *SerialCATServer) GetBaudrate() int {
	return s.baudrate
}

// GetVFO returns the current VFO
func (s *SerialCATServer) GetVFO() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.vfo
}

// GetCachedFrequency returns the cached frequency for the current VFO
func (s *SerialCATServer) GetCachedFrequency() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.vfo == "A" {
		return s.vfoAFreq
	}
	return s.vfoBFreq
}

// GetCachedMode returns the cached mode (always USB for now)
func (s *SerialCATServer) GetCachedMode() string {
	return "USB"
}

// SetCallbacks sets the callback functions for SDR control
func (s *SerialCATServer) SetCallbacks(
	frequencyCallback func(int),
	modeCallback func(string),
) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.frequencyCallback = frequencyCallback
	s.modeCallback = modeCallback
}

// ListSerialPorts returns a list of available serial ports
func ListSerialPorts() ([]string, error) {
	ports, err := serial.GetPortsList()
	if err != nil {
		return nil, fmt.Errorf("failed to list serial ports: %w", err)
	}
	return ports, nil
}
