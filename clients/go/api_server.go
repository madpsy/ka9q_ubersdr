package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
)

//go:embed frontend/*
var frontendFS embed.FS

// APIServer represents the HTTP/WebSocket API server
type APIServer struct {
	manager       *WebSocketManager
	configManager *ConfigManager
	router        *mux.Router
	server        *http.Server
	upgrader      websocket.Upgrader
	mu            sync.RWMutex
}

// NewAPIServer creates a new API server
func NewAPIServer(manager *WebSocketManager, configManager *ConfigManager, port int) *APIServer {
	router := mux.NewRouter()

	server := &APIServer{
		manager:       manager,
		configManager: configManager,
		router:        router,
		server: &http.Server{
			Addr:         fmt.Sprintf(":%d", port),
			Handler:      router,
			ReadTimeout:  15 * time.Second,
			WriteTimeout: 15 * time.Second,
			IdleTimeout:  60 * time.Second,
		},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for development
			},
		},
	}

	server.setupRoutes()
	return server
}

// setupRoutes configures all API routes
func (s *APIServer) setupRoutes() {
	// API routes
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/connect", s.handleConnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/disconnect", s.handleDisconnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/status", s.handleStatus).Methods("GET", "OPTIONS")
	api.HandleFunc("/tune", s.handleTune).Methods("POST", "OPTIONS")
	api.HandleFunc("/frequency", s.handleFrequency).Methods("POST", "OPTIONS")
	api.HandleFunc("/mode", s.handleMode).Methods("POST", "OPTIONS")
	api.HandleFunc("/bandwidth", s.handleBandwidth).Methods("POST", "OPTIONS")
	api.HandleFunc("/devices", s.handleDevices).Methods("GET", "OPTIONS")
	api.HandleFunc("/device", s.handleDevice).Methods("POST", "OPTIONS")
	api.HandleFunc("/config", s.handleConfig).Methods("GET", "POST", "OPTIONS")

	// WebSocket endpoint for real-time updates
	s.router.HandleFunc("/ws", s.handleWebSocket)

	// Serve frontend static files
	frontendSubFS, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Printf("Warning: Could not load embedded frontend: %v", err)
	} else {
		s.router.PathPrefix("/").Handler(http.FileServer(http.FS(frontendSubFS)))
	}

	// Add CORS middleware
	s.router.Use(corsMiddleware)
}

// corsMiddleware adds CORS headers to all responses
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// Start starts the API server
func (s *APIServer) Start() error {
	log.Printf("Starting API server on %s", s.server.Addr)
	log.Printf("Web interface available at http://localhost%s", s.server.Addr)
	return s.server.ListenAndServe()
}

// Stop gracefully stops the API server
func (s *APIServer) Stop(ctx context.Context) error {
	log.Println("Stopping API server...")
	return s.server.Shutdown(ctx)
}

// handleConnect handles POST /api/connect
func (s *APIServer) handleConnect(w http.ResponseWriter, r *http.Request) {
	var req ConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	// Validate required fields
	if req.Host == "" {
		respondError(w, http.StatusBadRequest, "Host is required", "")
		return
	}
	if req.Port == 0 {
		respondError(w, http.StatusBadRequest, "Port is required", "")
		return
	}
	if req.Frequency == 0 {
		respondError(w, http.StatusBadRequest, "Frequency is required", "")
		return
	}
	if req.Mode == "" {
		respondError(w, http.StatusBadRequest, "Mode is required", "")
		return
	}

	// Check if already connected
	if s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Already connected", "Disconnect first")
		return
	}

	// Set defaults
	if req.OutputMode == "" {
		req.OutputMode = "portaudio"
	}
	if req.AudioDevice == 0 {
		req.AudioDevice = -1 // Default device
	}
	if req.NR2Strength == 0 {
		req.NR2Strength = 40.0
	}
	if req.NR2Floor == 0 {
		req.NR2Floor = 10.0
	}
	if req.NR2AdaptRate == 0 {
		req.NR2AdaptRate = 1.0
	}

	// Save configuration
	if err := s.configManager.UpdateFromConnectRequest(req); err != nil {
		log.Printf("Warning: Failed to save config: %v", err)
	}

	// Create new client
	client := NewRadioClient(
		"", req.Host, req.Port, req.Frequency, req.Mode,
		req.BandwidthLow, req.BandwidthHigh, req.OutputMode, "",
		nil, req.SSL, req.Password, req.AudioDevice, req.NR2Enabled,
		req.NR2Strength, req.NR2Floor, req.NR2AdaptRate, false,
	)

	// Connect
	if err := s.manager.Connect(client); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to connect", err.Error())
		return
	}

	respondSuccess(w, "Connected successfully")
}

// handleDisconnect handles POST /api/disconnect
func (s *APIServer) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "")
		return
	}

	if err := s.manager.Disconnect(); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to disconnect", err.Error())
		return
	}

	respondSuccess(w, "Disconnected successfully")
}

// handleStatus handles GET /api/status
func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := s.manager.GetStatus()
	respondJSON(w, http.StatusOK, status)
}

// handleTune handles POST /api/tune
func (s *APIServer) handleTune(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "")
		return
	}

	var req TuneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.Tune(req); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to tune", err.Error())
		return
	}

	// Save configuration
	if err := s.configManager.UpdateFromTuneRequest(req); err != nil {
		log.Printf("Warning: Failed to save config: %v", err)
	}

	respondSuccess(w, "Tuned successfully")
}

// handleFrequency handles POST /api/frequency
func (s *APIServer) handleFrequency(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "")
		return
	}

	var req FrequencyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetFrequency(req.Frequency); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set frequency", err.Error())
		return
	}

	respondSuccess(w, "Frequency set successfully")
}

// handleMode handles POST /api/mode
func (s *APIServer) handleMode(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "")
		return
	}

	var req ModeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetMode(req.Mode); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set mode", err.Error())
		return
	}

	respondSuccess(w, "Mode set successfully")
}

// handleBandwidth handles POST /api/bandwidth
func (s *APIServer) handleBandwidth(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "")
		return
	}

	var req BandwidthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetBandwidth(req.BandwidthLow, req.BandwidthHigh); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set bandwidth", err.Error())
		return
	}

	respondSuccess(w, "Bandwidth set successfully")
}

// handleDevices handles GET /api/devices
func (s *APIServer) handleDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := getAudioDevices()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get devices", err.Error())
		return
	}

	respondJSON(w, http.StatusOK, AudioDevicesResponse{Devices: devices})
}

// handleDevice handles POST /api/device
func (s *APIServer) handleDevice(w http.ResponseWriter, r *http.Request) {
	var req AudioDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	// Note: Changing audio device requires reconnection in current implementation
	respondError(w, http.StatusNotImplemented, "Audio device change requires reconnection", "")
}

// handleConfig handles GET/POST /api/config
func (s *APIServer) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		// Get saved config from ConfigManager (not from current status)
		savedConfig := s.configManager.Get()
		config := ConfigResponse{
			Host:          savedConfig.Host,
			Port:          savedConfig.Port,
			SSL:           savedConfig.SSL,
			Frequency:     savedConfig.Frequency,
			Mode:          savedConfig.Mode,
			BandwidthLow:  savedConfig.BandwidthLow,
			BandwidthHigh: savedConfig.BandwidthHigh,
			OutputMode:    savedConfig.OutputMode,
			AudioDevice:   savedConfig.AudioDevice,
			NR2Enabled:    savedConfig.NR2Enabled,
			NR2Strength:   savedConfig.NR2Strength,
			NR2Floor:      savedConfig.NR2Floor,
			NR2AdaptRate:  savedConfig.NR2AdaptRate,
		}
		respondJSON(w, http.StatusOK, config)
		return
	}

	// POST - update config
	var req ConfigUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.UpdateConfig(req); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update config", err.Error())
		return
	}

	respondSuccess(w, "Configuration updated successfully")
}

// handleWebSocket handles WebSocket connections for real-time updates
func (s *APIServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Subscribe to updates
	updates := s.manager.Subscribe()
	defer s.manager.Unsubscribe(updates)

	// Send initial status
	status := s.manager.GetStatus()
	if err := conn.WriteJSON(status); err != nil {
		log.Printf("WebSocket write error: %v", err)
		return
	}

	// Handle updates
	for update := range updates {
		if err := conn.WriteJSON(update); err != nil {
			log.Printf("WebSocket write error: %v", err)
			return
		}
	}
}

// Helper functions

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, error string, message string) {
	respondJSON(w, status, ErrorResponse{
		Error:   error,
		Message: message,
	})
}

func respondSuccess(w http.ResponseWriter, message string) {
	respondJSON(w, http.StatusOK, SuccessResponse{
		Success: true,
		Message: message,
	})
}
