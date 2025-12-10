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

// RigctlClient represents a TCP client for Hamlib rigctld radio control
type RigctlClient struct {
	host      string
	port      int
	vfo       string // "VFOA" or "VFOB"
	conn      net.Conn
	connected bool
	mu        sync.RWMutex

	// Cached values for quick access (updated by polling)
	cachedFrequency int
	cachedMode      string
	cachedPTT       bool
	cacheMu         sync.RWMutex
	firstPoll       bool // Track if this is the first poll after connection

	// Callbacks
	frequencyCallback func(int)
	modeCallback      func(string)
	pttCallback       func(bool)
	errorCallback     func(string)

	// Debug
	pollCount int
}

// NewRigctlClient creates a new rigctl TCP client
func NewRigctlClient(host string, port int, vfo string) *RigctlClient {
	return &RigctlClient{
		host:      host,
		port:      port,
		vfo:       vfo,
		connected: false,
		firstPoll: true, // Mark that we haven't polled yet
	}
}

// Connect establishes connection to rigctld server
func (r *RigctlClient) Connect() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Connect to rigctld server
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", r.host, r.port), 5*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect to rigctld at %s:%d: %w", r.host, r.port, err)
	}

	r.conn = conn
	r.connected = true
	return nil
}

// Disconnect closes the connection
func (r *RigctlClient) Disconnect() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.conn != nil {
		r.conn.Close()
		r.conn = nil
	}
	r.connected = false
}

// IsConnected returns connection status
func (r *RigctlClient) IsConnected() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.connected
}

// sendCommand sends a command to rigctld and returns the response
func (r *RigctlClient) sendCommand(command string) (string, error) {
	r.mu.RLock()
	if !r.connected || r.conn == nil {
		r.mu.RUnlock()
		return "", fmt.Errorf("not connected to rigctld")
	}
	conn := r.conn
	r.mu.RUnlock()

	// Set timeout for this operation
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	defer conn.SetDeadline(time.Time{})

	// Send command with newline
	_, err := fmt.Fprintf(conn, "%s\n", command)
	if err != nil {
		return "", fmt.Errorf("failed to send command: %w", err)
	}

	// Read response
	reader := bufio.NewReader(conn)
	response, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	return strings.TrimSpace(response), nil
}

// GetFrequency returns the current frequency in Hz
func (r *RigctlClient) GetFrequency() (int, error) {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return 0, fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	response, err := r.sendCommand("f")
	if err != nil {
		return 0, err
	}

	freq, err := strconv.Atoi(response)
	if err != nil {
		return 0, fmt.Errorf("failed to parse frequency: %w", err)
	}

	return freq, nil
}

// SetFrequency sets the frequency in Hz
func (r *RigctlClient) SetFrequency(freqHz int) error {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	_, err := r.sendCommand(fmt.Sprintf("F %d", freqHz))
	if err != nil {
		return err
	}

	return nil
}

// GetMode returns the current mode
func (r *RigctlClient) GetMode() (string, error) {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return "", fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	response, err := r.sendCommand("m")
	if err != nil {
		return "", err
	}

	// Response format: "MODE\nBW\n" - we only want the mode
	lines := strings.Split(response, "\n")
	if len(lines) > 0 {
		mode := strings.TrimSpace(lines[0])
		if mode == "" {
			return "Unknown", nil
		}
		return mode, nil
	}

	return "Unknown", nil
}

// SetMode sets the mode (USB, LSB, CW, AM, FM, etc.)
func (r *RigctlClient) SetMode(mode string) error {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	// rigctld expects: M <mode> <passband_width>
	// Using 0 for passband width lets rigctld use default
	_, err := r.sendCommand(fmt.Sprintf("M %s 0", strings.ToUpper(mode)))
	if err != nil {
		return err
	}

	return nil
}

// GetPTT returns the PTT (Push-To-Talk) status
func (r *RigctlClient) GetPTT() (bool, error) {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return false, fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	response, err := r.sendCommand("t")
	if err != nil {
		return false, err
	}

	// Response is "0" for RX, "1" for TX
	return response == "1", nil
}

// SetPTT sets the PTT state
func (r *RigctlClient) SetPTT(state bool) error {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	pttValue := 0
	if state {
		pttValue = 1
	}

	_, err := r.sendCommand(fmt.Sprintf("T %d", pttValue))
	if err != nil {
		return err
	}

	return nil
}

// SetVFO switches to the specified VFO (VFOA or VFOB)
func (r *RigctlClient) SetVFO(vfo string) error {
	r.mu.RLock()
	if !r.connected {
		r.mu.RUnlock()
		return fmt.Errorf("not connected to rigctld")
	}
	r.mu.RUnlock()

	_, err := r.sendCommand(fmt.Sprintf("V %s", strings.ToUpper(vfo)))
	if err != nil {
		return err
	}

	r.mu.Lock()
	r.vfo = vfo
	r.mu.Unlock()

	return nil
}

// GetVFO returns the current VFO
func (r *RigctlClient) GetVFO() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.vfo
}

// Poll updates all cached values and triggers callbacks
func (r *RigctlClient) Poll() {
	// Get frequency
	freq, err := r.GetFrequency()
	if err != nil {
		log.Printf("rigctl: Poll() GetFrequency error: %v", err)
		if r.errorCallback != nil {
			r.errorCallback(err.Error())
		}
		return
	}

	// Get mode
	mode, err := r.GetMode()
	if err != nil {
		log.Printf("rigctl: Poll() GetMode error: %v", err)
		if r.errorCallback != nil {
			r.errorCallback(err.Error())
		}
		return
	}

	// Get PTT
	ptt, err := r.GetPTT()
	if err != nil {
		log.Printf("rigctl: Poll() GetPTT error: %v", err)
		if r.errorCallback != nil {
			r.errorCallback(err.Error())
		}
		return
	}

	// Update cache and trigger callbacks
	r.cacheMu.Lock()
	oldFreq := r.cachedFrequency
	oldMode := r.cachedMode
	oldPTT := r.cachedPTT

	r.cachedFrequency = freq
	r.cachedMode = mode
	r.cachedPTT = ptt
	r.cacheMu.Unlock()

	// Debug: log current values every 10 seconds (20 polls at 500ms)
	r.pollCount++
	if r.pollCount%20 == 0 {
		log.Printf("rigctl: Poll #%d - freq=%d, mode=%s, ptt=%v", r.pollCount, freq, mode, ptt)
	}

	// On first poll, always trigger callbacks to sync initial state
	// On subsequent polls, only trigger if values changed
	isFirstPoll := r.firstPoll
	if isFirstPoll {
		r.firstPoll = false
		log.Printf("rigctl: First poll - initializing with freq=%d, mode=%s, ptt=%v", freq, mode, ptt)
	}

	// Trigger callbacks if values changed OR if this is the first poll
	if freq != oldFreq || isFirstPoll {
		if freq != oldFreq {
			log.Printf("rigctl: frequency changed from %d to %d Hz", oldFreq, freq)
		}
		if r.frequencyCallback != nil {
			r.frequencyCallback(freq)
		} else {
			log.Printf("rigctl: frequency callback is nil!")
		}
	}
	if mode != oldMode || isFirstPoll {
		if mode != oldMode {
			log.Printf("rigctl: mode changed from %s to %s", oldMode, mode)
		}
		if r.modeCallback != nil {
			r.modeCallback(mode)
		} else {
			log.Printf("rigctl: mode callback is nil!")
		}
	}
	if ptt != oldPTT || isFirstPoll {
		if ptt != oldPTT {
			log.Printf("rigctl: PTT changed from %v to %v", oldPTT, ptt)
		}
		if r.pttCallback != nil {
			r.pttCallback(ptt)
		} else {
			log.Printf("rigctl: PTT callback is nil!")
		}
	}
}

// GetCachedFrequency returns the cached frequency
func (r *RigctlClient) GetCachedFrequency() int {
	r.cacheMu.RLock()
	defer r.cacheMu.RUnlock()
	return r.cachedFrequency
}

// GetCachedMode returns the cached mode
func (r *RigctlClient) GetCachedMode() string {
	r.cacheMu.RLock()
	defer r.cacheMu.RUnlock()
	return r.cachedMode
}

// GetCachedPTT returns the cached PTT state
func (r *RigctlClient) GetCachedPTT() bool {
	r.cacheMu.RLock()
	defer r.cacheMu.RUnlock()
	return r.cachedPTT
}

// SetCallbacks sets the callback functions
func (r *RigctlClient) SetCallbacks(
	frequencyCallback func(int),
	modeCallback func(string),
	pttCallback func(bool),
	errorCallback func(string),
) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.frequencyCallback = frequencyCallback
	r.modeCallback = modeCallback
	r.pttCallback = pttCallback
	r.errorCallback = errorCallback
}
