package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// RotctlConfig contains rotctl client configuration
type RotctlConfig struct {
	Enabled        bool    `yaml:"enabled"`          // Enable/disable rotctl integration
	Host           string  `yaml:"host"`             // Rotctld hostname or IP
	Port           int     `yaml:"port"`             // Rotctld port (default: 4533)
	Password       string  `yaml:"password"`         // Password required for API access
	UpdateInterval int     `yaml:"update_interval"`  // Update interval in milliseconds (default: 2000)
	ParkAzimuth    float64 `yaml:"park_azimuth"`     // Azimuth to move to when park command is executed (default: 0)
}

// RotctlAPIHandler handles HTTP API requests for rotator control
type RotctlAPIHandler struct {
	controller     *RotatorController
	config         *RotctlConfig
	mu             sync.RWMutex
	lastUpdate     time.Time
	connectedSince time.Time
	wasConnected   bool
}

// NewRotctlAPIHandler creates a new rotctl API handler
func NewRotctlAPIHandler(config *RotctlConfig) (*RotctlAPIHandler, error) {
	if !config.Enabled {
		return nil, fmt.Errorf("rotctl is not enabled in configuration")
	}

	if config.Host == "" {
		return nil, fmt.Errorf("rotctl host is required")
	}

	if config.Port == 0 {
		config.Port = 4533 // Default rotctld port
	}

	if config.UpdateInterval == 0 {
		config.UpdateInterval = 2000 // Default 2000ms (2 seconds)
	}

	// Password is optional - if not set, operates in read-only mode
	if config.Password == "" {
		log.Printf("Warning: No rotctl password set - operating in READ-ONLY mode")
	}

	controller := NewRotatorController(config.Host, config.Port)

	handler := &RotctlAPIHandler{
		controller: controller,
		config:     config,
		lastUpdate: time.Now(),
	}

	// Connect to rotctld
	if err := controller.Connect(); err != nil {
		log.Printf("Warning: Failed to connect to rotctld at %s:%d: %v", config.Host, config.Port, err)
		log.Printf("Will continue and attempt reconnection automatically")
	} else {
		log.Printf("Connected to rotctld at %s:%d", config.Host, config.Port)
	}

	// Start background updater
	go handler.backgroundUpdater()

	return handler, nil
}

// backgroundUpdater periodically updates the rotator state
func (h *RotctlAPIHandler) backgroundUpdater() {
	updateInterval := time.Duration(h.config.UpdateInterval) * time.Millisecond
	ticker := time.NewTicker(updateInterval)
	defer ticker.Stop()

	for range ticker.C {
		isConnected := h.controller.client.IsConnected()
		
		h.mu.Lock()
		// Track connection state changes
		if isConnected && !h.wasConnected {
			// Just connected
			h.connectedSince = time.Now()
			h.wasConnected = true
		} else if !isConnected && h.wasConnected {
			// Just disconnected
			h.wasConnected = false
		}
		h.mu.Unlock()
		
		if err := h.controller.UpdateState(); err != nil {
			// Error is stored in state and available via API - don't spam logs
			// Reconnection will be attempted automatically
		} else {
			h.mu.Lock()
			h.lastUpdate = time.Now()
			h.mu.Unlock()
		}
	}
}

// Close closes the rotctl connection
func (h *RotctlAPIHandler) Close() error {
	return h.controller.Disconnect()
}

// authenticatePostRequest checks if a POST request has a valid password in the JSON body
func (h *RotctlAPIHandler) authenticatePostRequest(req interface{ GetPassword() string }) bool {
	return req.GetPassword() == h.config.Password
}

// PositionResponse represents the rotator position response
type PositionResponse struct {
	Azimuth    int       `json:"azimuth"`
	Elevation  int       `json:"elevation"`
	Moving     bool      `json:"moving"`
	Connected  bool      `json:"connected"`
	LastUpdate time.Time `json:"last_update"`
	Error      string    `json:"error,omitempty"`
}

// SetPositionRequest represents a request to set rotator position
type SetPositionRequest struct {
	Password  string   `json:"password"`
	Azimuth   *float64 `json:"azimuth,omitempty"`
	Elevation *float64 `json:"elevation,omitempty"`
}

// GetPassword returns the password from the request
func (r *SetPositionRequest) GetPassword() string {
	return r.Password
}

// CommandRequest represents a generic command request
type CommandRequest struct {
	Password string `json:"password"`
	Command  string `json:"command"` // "stop", "park", "reset"
}

// GetPassword returns the password from the request
func (r *CommandRequest) GetPassword() string {
	return r.Password
}

// CommandResponse represents a command response
type CommandResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

// HandleGetPosition handles GET /api/rotctl/position
// No authentication required for read operations
func (h *RotctlAPIHandler) HandleGetPosition(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	// Get current state
	state := h.controller.GetState()

	h.mu.RLock()
	lastUpdate := h.lastUpdate
	h.mu.RUnlock()

	response := PositionResponse{
		Azimuth:    int(state.Position.Azimuth + 0.5), // Round to nearest integer
		Elevation:  int(state.Position.Elevation + 0.5), // Round to nearest integer
		Moving:     state.Moving,
		Connected:  h.controller.client.IsConnected(),
		LastUpdate: lastUpdate,
	}

	if state.LastError != nil {
		response.Error = state.LastError.Error()
	}

	json.NewEncoder(w).Encode(response)
}

// HandleGetPositionDisabled handles GET /api/rotctl/position when rotctl is disabled
func HandleGetPositionDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error":     "Rotator control is not enabled",
		"enabled":   false,
		"azimuth":   0,
		"elevation": 0,
		"moving":    false,
		"connected": false,
	})
}

// HandleSetPositionDisabled handles POST /api/rotctl/position when rotctl is disabled
func HandleSetPositionDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": false,
		"error":   "Rotator control is not enabled",
		"enabled": false,
	})
}

// HandleCommandDisabled handles POST /api/rotctl/command when rotctl is disabled
func HandleCommandDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": false,
		"error":   "Rotator control is not enabled",
		"enabled": false,
	})
}

// HandleStatusDisabled handles GET /api/rotctl/status when rotctl is disabled
func HandleStatusDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error":     "Rotator control is not enabled",
		"enabled":   false,
		"connected": false,
	})
}

// HandleSetPosition handles POST /api/rotctl/position
func (h *RotctlAPIHandler) HandleSetPosition(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Decode request
	var req SetPositionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	// Check authentication
	if !h.authenticatePostRequest(&req) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Unauthorized - invalid password",
		})
		return
	}

	// Validate request
	if req.Azimuth == nil && req.Elevation == nil {
		http.Error(w, "Either azimuth or elevation must be specified", http.StatusBadRequest)
		return
	}

	var err error
	var message string

	// Set position
	if req.Azimuth != nil && req.Elevation != nil {
		// Set both azimuth and elevation
		err = h.controller.SetPosition(*req.Azimuth, *req.Elevation)
		message = fmt.Sprintf("Setting position to azimuth=%.2f°, elevation=%.2f°", *req.Azimuth, *req.Elevation)
	} else if req.Azimuth != nil {
		// Set azimuth only
		err = h.controller.SetAzimuth(*req.Azimuth)
		message = fmt.Sprintf("Setting azimuth to %.2f°", *req.Azimuth)
	} else {
		// Set elevation only
		err = h.controller.SetElevation(*req.Elevation)
		message = fmt.Sprintf("Setting elevation to %.2f°", *req.Elevation)
	}

	response := CommandResponse{
		Success: err == nil,
		Message: message,
	}

	if err != nil {
		response.Error = err.Error()
	}

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
	}
	json.NewEncoder(w).Encode(response)
}

// HandleCommand handles POST /api/rotctl/command
func (h *RotctlAPIHandler) HandleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Decode request
	var req CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	// Check authentication
	if !h.authenticatePostRequest(&req) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Unauthorized - invalid password",
		})
		return
	}

	var err error
	var message string

	// Execute command
	switch req.Command {
	case "stop":
		err = h.controller.Stop()
		message = "Stopping rotator"
	case "park":
		// Move to configured park azimuth instead of using rotctld park command
		parkAzimuth := h.config.ParkAzimuth
		err = h.controller.SetAzimuth(parkAzimuth)
		message = fmt.Sprintf("Parking rotator at %.0f°", parkAzimuth)
	case "reset":
		err = h.controller.GetClient().Reset()
		message = "Resetting rotator"
	default:
		http.Error(w, fmt.Sprintf("Unknown command: %s (valid: stop, park, reset)", req.Command), http.StatusBadRequest)
		return
	}

	response := CommandResponse{
		Success: err == nil,
		Message: message,
	}

	if err != nil {
		response.Error = err.Error()
	}

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
	}
	json.NewEncoder(w).Encode(response)
}

// HandleStatus handles GET /api/rotctl/status
// No authentication required for read operations
func (h *RotctlAPIHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	state := h.controller.GetState()
	isConnected := h.controller.client.IsConnected()

	h.mu.RLock()
	lastUpdate := h.lastUpdate
	connectedSince := h.connectedSince
	h.mu.RUnlock()

	status := map[string]interface{}{
		"enabled":     true,
		"connected":   isConnected,
		"read_only":   h.config.Password == "",
		"host":        h.config.Host,
		"port":        h.config.Port,
		"position": map[string]interface{}{
			"azimuth":   int(state.Position.Azimuth + 0.5), // Round to nearest integer
			"elevation": int(state.Position.Elevation + 0.5), // Round to nearest integer
		},
		"moving":      state.Moving,
		"last_update": lastUpdate,
	}

	// Add connection duration if connected
	if isConnected && !connectedSince.IsZero() {
		duration := time.Since(connectedSince)
		status["connected_duration_seconds"] = int(duration.Seconds())
		status["connected_since"] = connectedSince
	}

	if state.LastError != nil {
		status["error"] = state.LastError.Error()
	}

	json.NewEncoder(w).Encode(status)
}

// RegisterRotctlRoutes registers rotctl API routes with the HTTP server
func RegisterRotctlRoutes(mux *http.ServeMux, handler *RotctlAPIHandler) {
	mux.HandleFunc("/api/rotctl/position", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			handler.HandleGetPosition(w, r)
		} else if r.Method == "POST" {
			handler.HandleSetPosition(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/rotctl/command", handler.HandleCommand)
	mux.HandleFunc("/api/rotctl/status", handler.HandleStatus)
}

// RegisterRotctlRoutesDisabled registers rotctl API routes that return "not enabled" responses
func RegisterRotctlRoutesDisabled(mux *http.ServeMux) {
	mux.HandleFunc("/api/rotctl/position", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			HandleGetPositionDisabled(w, r)
		} else if r.Method == "POST" {
			HandleSetPositionDisabled(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/rotctl/command", HandleCommandDisabled)
	mux.HandleFunc("/api/rotctl/status", HandleStatusDisabled)
}
