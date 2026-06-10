package main

// Antenna Switch Control
//
// Connects to the ant-switch-daemon xinetd service (default port 65000).
// Protocol: one TCP connection per command, send command + newline, read
// response (if any), disconnect.
//
// Command set:
//   "s"   → query: "Selected antennas: 1,3\n" or "Selected antennas: g\n"
//   "bi"  → backend info: "<name> version X.Y\n"
//   "N"   → exclusive select antenna N (grounds all first)
//   "tN"  → toggle antenna N on/off (mixing mode)
//   "g"   → ground all antennas
//   "+N"  → add antenna N without grounding others (admin only)
//   "-N"  → remove antenna N (admin only)
//
// None of the control commands produce output — the protocol has no ACK.
// Verification is done by querying state after the command (send-verify-retry).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AntSwitchConfig contains antenna switch client configuration.
type AntSwitchConfig struct {
	Enabled bool `yaml:"enabled"` // Enable/disable antenna switch integration

	// TCP connection to ant-switch-daemon (xinetd service)
	Host      string `yaml:"host"`       // Hostname or IP of the daemon host
	Port      int    `yaml:"port"`       // TCP port (default: 65000)
	TimeoutMs int    `yaml:"timeout_ms"` // TCP operation timeout in milliseconds (default: 2000)

	// NumAntennas: number of antennas supported by the switch (1-10, default: 8)
	NumAntennas int `yaml:"num_antennas"`

	// AllowMixing controls the switching mode:
	//   false = exclusive mode: send "N" (grounds all first, then selects N)
	//   true  = mixing mode:    send "tN" (toggle antenna on/off independently)
	AllowMixing bool `yaml:"allow_mixing"`

	// Password for the public control endpoint POST /api/ant-switch/command.
	// When set, callers must include {"password":"..."} in the JSON body.
	// When empty, the public control endpoint returns 401 Unauthorized.
	// Admin endpoint /admin/ant-switch-command never requires this password.
	Password string `yaml:"password"`

	// Thunderstorm: when true, forces all antennas to ground and denies
	// public switching. Admin can still override via admin endpoint.
	Thunderstorm bool `yaml:"thunderstorm"`

	// DefaultAntenna is selected on startup (0 = no automatic selection)
	DefaultAntenna int `yaml:"default_antenna"`

	// AntennaLabels are optional human-readable names for each antenna.
	AntennaLabels []string `yaml:"antenna_labels"`
}

// AntSwitchState holds the current (cached) state of the antenna switch.
type AntSwitchState struct {
	Selected   []int     // active antenna numbers (empty when grounded)
	Grounded   bool      // true when all antennas are grounded ("g")
	LastUpdate time.Time // time of last successful query
	LastError  string    // last error string (empty if none)
}

// AntSwitchHandler manages the antenna switch TCP connection and HTTP API.
type AntSwitchHandler struct {
	config      *AntSwitchConfig
	mu          sync.RWMutex
	state       AntSwitchState
	rateLimiter *AntSwitchRateLimiter
}

// AntSwitchRateLimiter is a per-IP rate limiter for ant-switch endpoints.
// Status endpoint: 5 req/s; command endpoints: 1 req/s.
type AntSwitchRateLimiter struct {
	limiters map[string]map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewAntSwitchRateLimiter creates a new rate limiter for ant-switch endpoints.
func NewAntSwitchRateLimiter() *AntSwitchRateLimiter {
	return &AntSwitchRateLimiter{
		limiters: make(map[string]map[string]*RateLimiter),
	}
}

// AllowRequest checks if a request is allowed for the given IP and endpoint.
func (rl *AntSwitchRateLimiter) AllowRequest(ip, endpoint string) bool {
	rl.mu.Lock()
	ipLimiters, exists := rl.limiters[ip]
	if !exists {
		ipLimiters = make(map[string]*RateLimiter)
		rl.limiters[ip] = ipLimiters
	}
	endpointLimiter, exists := ipLimiters[endpoint]
	if !exists {
		var refillRate, maxTokens float64
		if endpoint == "status" {
			refillRate = 5.0
			maxTokens = 5.0
		} else {
			refillRate = 1.0
			maxTokens = 1.0
		}
		endpointLimiter = &RateLimiter{
			tokens:     maxTokens,
			maxTokens:  maxTokens,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		ipLimiters[endpoint] = endpointLimiter
	}
	rl.mu.Unlock()
	return endpointLimiter.Allow()
}

// NewAntSwitchHandler creates and initialises a new AntSwitchHandler.
func NewAntSwitchHandler(config *AntSwitchConfig) (*AntSwitchHandler, error) {
	if !config.Enabled {
		return nil, fmt.Errorf("antenna switch is not enabled in configuration")
	}
	if config.Host == "" {
		return nil, fmt.Errorf("antenna switch host is required")
	}
	if config.Port == 0 {
		config.Port = 65000
	}
	if config.TimeoutMs <= 0 {
		config.TimeoutMs = 2000 // 2 seconds default — generous for a local WiFi device
	}
	if config.NumAntennas < 0 || config.NumAntennas > 10 {
		return nil, fmt.Errorf("antenna switch num_antennas must be 1-10 (got %d)", config.NumAntennas)
	}

	h := &AntSwitchHandler{
		config:      config,
		rateLimiter: NewAntSwitchRateLimiter(),
	}

	// Default to 8 antennas if not configured
	if config.NumAntennas == 0 {
		config.NumAntennas = 8
		log.Printf("AntSwitch: num_antennas not set, defaulting to 8")
	}

	// The standard daemon wrapper supports antennas 1-8.
	// Values 9-10 require a custom daemon wrapper that extends the case statement.
	if config.NumAntennas > 8 {
		log.Printf("AntSwitch: Warning: num_antennas=%d — the standard daemon wrapper only supports 1-8. Ensure your daemon wrapper has been extended to support higher antenna numbers.", config.NumAntennas)
	}

	// Initial state query
	if state, err := h.queryState(); err != nil {
		log.Printf("AntSwitch: Warning: initial state query failed: %v", err)
	} else {
		h.mu.Lock()
		h.state = state
		h.mu.Unlock()
		log.Printf("AntSwitch: Initial state: selected=%v grounded=%v", state.Selected, state.Grounded)
	}

	// Select default antenna on startup if configured
	if config.DefaultAntenna > 0 {
		if config.DefaultAntenna > config.NumAntennas {
			log.Printf("AntSwitch: Warning: default_antenna %d exceeds num_antennas %d, ignoring",
				config.DefaultAntenna, config.NumAntennas)
		} else {
			log.Printf("AntSwitch: Selecting default antenna %d on startup", config.DefaultAntenna)
			if _, _, err := h.selectAntenna(config.DefaultAntenna); err != nil {
				log.Printf("AntSwitch: Warning: failed to select default antenna %d: %v",
					config.DefaultAntenna, err)
			}
		}
	}

	go h.backgroundPoller()

	return h, nil
}

// ─── TCP transport ────────────────────────────────────────────────────────────

// sendCommand opens a TCP connection to the daemon, sends cmd + newline,
// reads any response, and closes the connection.
// The ant-switch-daemon (xinetd) accepts exactly one command per connection.
// Control commands produce no output; "s" and "bi" produce one line.
func (h *AntSwitchHandler) sendCommand(cmd string) (string, error) {
	addr := fmt.Sprintf("%s:%d", h.config.Host, h.config.Port)
	timeout := time.Duration(h.config.TimeoutMs) * time.Millisecond

	// Use half the timeout for connect, full timeout for I/O operations.
	// This ensures a slow connect doesn't eat the entire budget before we even send.
	connectTimeout := timeout / 2
	if connectTimeout < 500*time.Millisecond {
		connectTimeout = 500 * time.Millisecond
	}

	conn, err := net.DialTimeout("tcp", addr, connectTimeout)
	if err != nil {
		return "", fmt.Errorf("connect to ant-switch-daemon at %s: %w", addr, err)
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return "", fmt.Errorf("set deadline: %w", err)
	}

	if _, err := fmt.Fprintf(conn, "%s\n", cmd); err != nil {
		return "", fmt.Errorf("send command %q: %w", cmd, err)
	}

	// Read response — may be empty for control commands (EOF is normal)
	scanner := bufio.NewScanner(conn)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read response for %q: %w", cmd, err)
	}

	return strings.Join(lines, "\n"), nil
}

// ─── State query ─────────────────────────────────────────────────────────────

// queryState sends "s" and parses "Selected antennas: 1,3" or "Selected antennas: g".
// This is the only way to verify command success — the protocol has no ACK.
func (h *AntSwitchHandler) queryState() (AntSwitchState, error) {
	resp, err := h.sendCommand("s")
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}

	const prefix = "Selected antennas: "
	if !strings.HasPrefix(resp, prefix) {
		err := fmt.Errorf("unexpected response to 's': %q", resp)
		return AntSwitchState{LastError: err.Error()}, err
	}

	raw := strings.TrimSpace(strings.TrimPrefix(resp, prefix))
	state := AntSwitchState{LastUpdate: time.Now()}

	if raw == "g" || raw == "" {
		state.Grounded = true
		return state, nil
	}

	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return AntSwitchState{LastError: fmt.Sprintf("parse antenna number %q: %v", p, err)},
				fmt.Errorf("parse antenna number %q: %w", p, err)
		}
		state.Selected = append(state.Selected, n)
	}

	if len(state.Selected) == 0 {
		state.Grounded = true
	}

	return state, nil
}

// ─── Background poller ────────────────────────────────────────────────────────

// backgroundPoller polls the daemon every 5 seconds to keep the state cache fresh.
func (h *AntSwitchHandler) backgroundPoller() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		state, err := h.queryState()
		if err != nil {
			h.mu.Lock()
			h.state.LastError = err.Error()
			h.mu.Unlock()
			continue
		}
		h.mu.Lock()
		h.state = state
		h.mu.Unlock()
	}
}

// ─── Send-verify-retry ────────────────────────────────────────────────────────

const (
	antSwitchMaxRetries  = 3
	antSwitchRetryDelay  = 500 * time.Millisecond
	antSwitchSettleDelay = 200 * time.Millisecond
)

// executeCommand sends a control command and verifies the result by querying
// state after the command. Retries up to antSwitchMaxRetries times.
// The protocol has no ACK — this is the only way to know if the command worked.
// Returns (finalState, verified, attempts, error).
func (h *AntSwitchHandler) executeCommand(cmd string, verify func(AntSwitchState) bool) (AntSwitchState, bool, int, error) {
	var lastState AntSwitchState
	var lastErr error

	for attempt := 1; attempt <= antSwitchMaxRetries; attempt++ {
		_, err := h.sendCommand(cmd)
		if err != nil {
			lastErr = fmt.Errorf("attempt %d: failed to reach ant-switch-daemon: %w", attempt, err)
			log.Printf("AntSwitch: %v", lastErr)
			time.Sleep(antSwitchRetryDelay)
			continue
		}

		// Brief settle time for hardware to respond
		time.Sleep(antSwitchSettleDelay)

		state, err := h.queryState()
		if err != nil {
			lastErr = fmt.Errorf("attempt %d: command sent but state query failed: %w", attempt, err)
			log.Printf("AntSwitch: %v", lastErr)
			time.Sleep(antSwitchRetryDelay)
			continue
		}

		lastState = state

		if verify(state) {
			h.mu.Lock()
			h.state = state
			h.mu.Unlock()
			log.Printf("AntSwitch: command %q verified on attempt %d, selected=%v grounded=%v",
				cmd, attempt, state.Selected, state.Grounded)
			return state, true, attempt, nil
		}

		log.Printf("AntSwitch: attempt %d: command %q not verified (selected=%v grounded=%v), retrying...",
			attempt, cmd, state.Selected, state.Grounded)
		time.Sleep(antSwitchRetryDelay)
	}

	// All retries exhausted — update cache with last known state anyway
	if !lastState.LastUpdate.IsZero() {
		h.mu.Lock()
		h.state = lastState
		h.mu.Unlock()
	}

	log.Printf("AntSwitch: command %q failed verification after %d attempts", cmd, antSwitchMaxRetries)
	return lastState, false, antSwitchMaxRetries, lastErr
}

// selectAntenna sends the appropriate command based on AllowMixing:
//   - AllowMixing=false → "N"  (exclusive: grounds all first, then selects N)
//   - AllowMixing=true  → "tN" (toggle: on/off independently)
func (h *AntSwitchHandler) selectAntenna(n int) (AntSwitchState, bool, error) {
	var cmd string
	if h.config.AllowMixing {
		cmd = fmt.Sprintf("t%d", n)
	} else {
		cmd = fmt.Sprintf("%d", n)
	}
	state, verified, _, err := h.executeCommand(cmd, func(s AntSwitchState) bool {
		for _, sel := range s.Selected {
			if sel == n {
				return true
			}
		}
		return false
	})
	return state, verified, err
}

// groundAll sends "g" and verifies all antennas are grounded.
func (h *AntSwitchHandler) groundAll() (AntSwitchState, bool, error) {
	state, verified, _, err := h.executeCommand("g", func(s AntSwitchState) bool {
		return s.Grounded
	})
	return state, verified, err
}

// addAntenna sends "+N" (add without grounding others) — admin only.
func (h *AntSwitchHandler) addAntenna(n int) (AntSwitchState, bool, error) {
	state, verified, _, err := h.executeCommand(fmt.Sprintf("+%d", n), func(s AntSwitchState) bool {
		for _, sel := range s.Selected {
			if sel == n {
				return true
			}
		}
		return false
	})
	return state, verified, err
}

// removeAntenna sends "-N" (remove without grounding others) — admin only.
func (h *AntSwitchHandler) removeAntenna(n int) (AntSwitchState, bool, error) {
	state, verified, _, err := h.executeCommand(fmt.Sprintf("-%d", n), func(s AntSwitchState) bool {
		for _, sel := range s.Selected {
			if sel == n {
				return false
			}
		}
		return true
	})
	return state, verified, err
}

// getState returns the current cached state (thread-safe).
func (h *AntSwitchHandler) getState() AntSwitchState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.state
}

// GetInfo returns a compact summary suitable for /api/description and instance reporting.
// Only called when enabled. Returns: enabled, selected port numbers, active port labels.
func (h *AntSwitchHandler) GetInfo() map[string]interface{} {
	state := h.getState()

	info := map[string]interface{}{
		"enabled":  true,
		"grounded": state.Grounded,
	}

	selected := state.Selected
	if selected == nil {
		selected = []int{}
	}
	info["selected"] = selected

	// Build active port labels for the currently selected antennas
	activeLabels := make([]string, 0, len(selected))
	for _, n := range selected {
		activeLabels = append(activeLabels, h.antennaLabel(n))
	}
	info["active_labels"] = activeLabels

	return info
}

// antennaLabel returns the label for antenna n (1-based), or "Antenna N" if not configured.
func (h *AntSwitchHandler) antennaLabel(n int) string {
	if n >= 1 && n <= len(h.config.AntennaLabels) {
		if label := h.config.AntennaLabels[n-1]; label != "" {
			return label
		}
	}
	return fmt.Sprintf("Antenna %d", n)
}

// buildLabels returns the full label slice (always NumAntennas entries).
func (h *AntSwitchHandler) buildLabels() []string {
	labels := make([]string, h.config.NumAntennas)
	for i := 0; i < h.config.NumAntennas; i++ {
		labels[i] = h.antennaLabel(i + 1)
	}
	return labels
}

// ─── HTTP response helpers ────────────────────────────────────────────────────

// antSwitchCommandResult is the JSON response for control commands.
// Includes full context so callers don't need a separate status query.
type antSwitchCommandResult struct {
	Success       bool     `json:"success"`
	Verified      bool     `json:"verified"`
	Attempts      int      `json:"attempts,omitempty"`
	Selected      []int    `json:"selected"`
	Grounded      bool     `json:"grounded"`
	AntennaLabels []string `json:"antenna_labels"`
	NumAntennas   int      `json:"num_antennas"`
	AllowMixing   bool     `json:"allow_mixing"`
	Thunderstorm  bool     `json:"thunderstorm"`
	Message       string   `json:"message,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// writeAntSwitchResult writes a command result as JSON with the appropriate HTTP status:
//
//	200 = verified success
//	202 = command sent but hardware unverified after retries
//	503 = TCP connection failure
func writeAntSwitchResult(w http.ResponseWriter, result antSwitchCommandResult, tcpErr bool) {
	w.Header().Set("Content-Type", "application/json")
	if tcpErr {
		w.WriteHeader(http.StatusServiceUnavailable)
	} else if !result.Verified {
		w.WriteHeader(http.StatusAccepted)
	}
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("AntSwitch: error encoding command result: %v", err)
	}
}

// buildCommandResult builds a result struct from a completed command execution.
// Includes labels and config context so callers have everything they need.
func (h *AntSwitchHandler) buildCommandResult(state AntSwitchState, verified bool, attempts int, err error, message string) antSwitchCommandResult {
	result := antSwitchCommandResult{
		Success:       verified,
		Verified:      verified,
		Attempts:      attempts,
		Selected:      state.Selected,
		Grounded:      state.Grounded,
		AntennaLabels: h.buildLabels(),
		NumAntennas:   h.config.NumAntennas,
		AllowMixing:   h.config.AllowMixing,
		Thunderstorm:  h.config.Thunderstorm,
		Message:       message,
	}
	if result.Selected == nil {
		result.Selected = []int{}
	}
	if err != nil {
		result.Error = err.Error()
	}
	if !verified && err == nil {
		result.Error = fmt.Sprintf("command sent but hardware did not respond as expected after %d attempts", antSwitchMaxRetries)
	}
	return result
}

// ─── Public HTTP endpoints ────────────────────────────────────────────────────

// HandleGetStatus handles GET /api/ant-switch/status
// Always public — no authentication required.
func (h *AntSwitchHandler) HandleGetStatus(w http.ResponseWriter, r *http.Request) {
	clientIP := getClientIP(r)
	if !h.rateLimiter.AllowRequest(clientIP, "status") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Rate limit exceeded"})
		return
	}

	state := h.getState()

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{
		"enabled":        true,
		"selected":       state.Selected,
		"grounded":       state.Grounded,
		"allow_mixing":   h.config.AllowMixing,
		"num_antennas":   h.config.NumAntennas,
		"antenna_labels": h.buildLabels(),
		"thunderstorm":   h.config.Thunderstorm,
		"last_update":    state.LastUpdate,
	}
	if state.Selected == nil {
		resp["selected"] = []int{}
	}
	if state.LastError != "" {
		resp["last_error"] = state.LastError
	}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("AntSwitch: error encoding status: %v", err)
	}
}

// HandleGetStatusDisabled handles GET /api/ant-switch/status when disabled.
func HandleGetStatusDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":  false,
		"error":    "Antenna switch is not enabled",
		"selected": []int{},
		"grounded": false,
	})
}

// antSwitchPublicCommandRequest is the JSON body for POST /api/ant-switch/command.
// Password is in the JSON body, mirroring the rotctl SetPositionRequest pattern.
type antSwitchPublicCommandRequest struct {
	Password string `json:"password"`
	// Command: "select" or "ground"
	Command string `json:"command"`
	// Antenna number (1-NumAntennas) — required for "select"
	Antenna int `json:"antenna,omitempty"`
}

// HandlePublicCommand handles POST /api/ant-switch/command
// Requires a password in the JSON body ({"password":"..."}).
// If no password is configured, the endpoint returns 401 Unauthorized.
// Thunderstorm mode overrides all — returns 403 when active.
func (h *AntSwitchHandler) HandlePublicCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clientIP := getClientIP(r)
	if !h.rateLimiter.AllowRequest(clientIP, "command") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Rate limit exceeded",
		})
		return
	}

	// Thunderstorm mode: deny all public switching
	if h.config.Thunderstorm {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Thunderstorm mode active — antenna switching is disabled",
		})
		return
	}

	var req antSwitchPublicCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	// Password is always required for the public endpoint.
	// If no password is configured, deny all public access.
	if h.config.Password == "" || req.Password != h.config.Password {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Unauthorized — password required",
		})
		return
	}

	switch req.Command {
	case "select":
		if req.Antenna < 1 || req.Antenna > h.config.NumAntennas {
			http.Error(w, fmt.Sprintf("antenna must be 1-%d", h.config.NumAntennas), http.StatusBadRequest)
			return
		}
		state, verified, err := h.selectAntenna(req.Antenna)
		tcpErr := err != nil && !verified && state.LastUpdate.IsZero()
		result := h.buildCommandResult(state, verified, antSwitchMaxRetries, err,
			fmt.Sprintf("Selected antenna %d (%s)", req.Antenna, h.antennaLabel(req.Antenna)))
		writeAntSwitchResult(w, result, tcpErr)

	case "ground":
		state, verified, err := h.groundAll()
		tcpErr := err != nil && !verified && state.LastUpdate.IsZero()
		result := h.buildCommandResult(state, verified, antSwitchMaxRetries, err, "Grounded all antennas")
		writeAntSwitchResult(w, result, tcpErr)

	default:
		http.Error(w, fmt.Sprintf("Unknown command %q (valid: select, ground)", req.Command), http.StatusBadRequest)
	}
}

// HandlePublicCommandDisabled handles POST /api/ant-switch/command when disabled.
func HandlePublicCommandDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": false,
		"error":   "Antenna switch is not enabled",
	})
}

// ─── Admin HTTP endpoints ─────────────────────────────────────────────────────

// ─── Route registration ───────────────────────────────────────────────────────

// RegisterAntSwitchRoutes registers antenna switch API routes with the HTTP server.
func RegisterAntSwitchRoutes(mux *http.ServeMux, handler *AntSwitchHandler) {
	mux.HandleFunc("/api/ant-switch/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handler.HandleGetStatus(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/ant-switch/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			handler.HandlePublicCommand(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// RegisterAntSwitchRoutesDisabled registers ant-switch API routes that return "not enabled" responses.
func RegisterAntSwitchRoutesDisabled(mux *http.ServeMux) {
	mux.HandleFunc("/api/ant-switch/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			HandleGetStatusDisabled(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/ant-switch/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			HandlePublicCommandDisabled(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
