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
	manager           *WebSocketManager
	configManager     *ConfigManager
	instanceDiscovery *InstanceDiscovery
	router            *mux.Router
	server            *http.Server
	upgrader          websocket.Upgrader
	mu                sync.RWMutex
}

// NewAPIServer creates a new API server
func NewAPIServer(manager *WebSocketManager, configManager *ConfigManager, port int) *APIServer {
	router := mux.NewRouter()

	// Initialize instance discovery
	instanceDiscovery := NewInstanceDiscovery()
	if err := instanceDiscovery.StartLocalDiscovery(); err != nil {
		log.Printf("Warning: Failed to start local instance discovery: %v", err)
	}

	server := &APIServer{
		manager:           manager,
		configManager:     configManager,
		instanceDiscovery: instanceDiscovery,
		router:            router,
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

	// Output control endpoints
	api.HandleFunc("/outputs/portaudio", s.handlePortAudioOutput).Methods("POST", "OPTIONS")
	api.HandleFunc("/outputs/fifo", s.handleFIFOOutput).Methods("POST", "OPTIONS")
	api.HandleFunc("/outputs/udp", s.handleUDPOutput).Methods("POST", "OPTIONS")
	api.HandleFunc("/outputs/status", s.handleOutputStatus).Methods("GET", "OPTIONS")

	// Radio control endpoints (flrig)
	api.HandleFunc("/radio/flrig/connect", s.handleFlrigConnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/flrig/disconnect", s.handleFlrigDisconnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/flrig/status", s.handleFlrigStatus).Methods("GET", "OPTIONS")
	api.HandleFunc("/radio/flrig/frequency", s.handleFlrigFrequency).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/flrig/mode", s.handleFlrigMode).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/flrig/vfo", s.handleFlrigVFO).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/flrig/sync", s.handleFlrigSync).Methods("POST", "OPTIONS")

	// Radio control endpoints (rigctl)
	api.HandleFunc("/radio/rigctl/connect", s.handleRigctlConnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/rigctl/disconnect", s.handleRigctlDisconnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/rigctl/status", s.handleRigctlStatus).Methods("GET", "OPTIONS")
	api.HandleFunc("/radio/rigctl/frequency", s.handleRigctlFrequency).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/rigctl/mode", s.handleRigctlMode).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/rigctl/vfo", s.handleRigctlVFO).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/rigctl/sync", s.handleRigctlSync).Methods("POST", "OPTIONS")

	// Radio control endpoints (serial)
	api.HandleFunc("/radio/serial/connect", s.handleSerialConnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/serial/disconnect", s.handleSerialDisconnect).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/serial/status", s.handleSerialStatus).Methods("GET", "OPTIONS")
	api.HandleFunc("/radio/serial/frequency", s.handleSerialFrequency).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/serial/mode", s.handleSerialMode).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/serial/vfo", s.handleSerialVFO).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/serial/sync", s.handleSerialSync).Methods("POST", "OPTIONS")
	api.HandleFunc("/radio/serial/ports", s.handleSerialPorts).Methods("GET", "OPTIONS")

	// Saved instances management endpoints
	api.HandleFunc("/instances/saved", s.handleSavedInstances).Methods("GET", "OPTIONS")
	api.HandleFunc("/instances/saved", s.handleSaveInstance).Methods("POST", "OPTIONS")
	api.HandleFunc("/instances/saved/{name}", s.handleDeleteInstance).Methods("DELETE", "OPTIONS")
	api.HandleFunc("/instances/saved/{name}/load", s.handleLoadInstance).Methods("POST", "OPTIONS")

	// Instance discovery endpoints
	api.HandleFunc("/instances/local", s.handleLocalInstances).Methods("GET", "OPTIONS")
	api.HandleFunc("/instances/public", s.handlePublicInstances).Methods("GET", "OPTIONS")

	// Bookmarks endpoint
	api.HandleFunc("/bookmarks", s.handleBookmarks).Methods("GET", "OPTIONS")

	// Bands endpoint
	api.HandleFunc("/bands", s.handleBands).Methods("GET", "OPTIONS")

	// Noise floor endpoint
	api.HandleFunc("/noisefloor/latest", s.handleNoiseFloor).Methods("GET", "OPTIONS")

	// Instance description endpoint
	api.HandleFunc("/description", s.handleInstanceDescription).Methods("GET", "OPTIONS")

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
	if s.instanceDiscovery != nil {
		s.instanceDiscovery.Stop()
	}
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
	// Set resampling defaults if not provided
	resampleEnabled := req.ResampleEnabled
	resampleRate := req.ResampleOutputRate
	if resampleRate == 0 {
		resampleRate = 44100 // Default to 44.1 kHz (most widely supported)
	}

	// For IQ modes, ignore bandwidth parameters
	bandwidthLow := req.BandwidthLow
	bandwidthHigh := req.BandwidthHigh
	isIQMode := req.Mode == "iq" || req.Mode == "iq48" || req.Mode == "iq96" ||
		req.Mode == "iq192" || req.Mode == "iq384"
	if isIQMode {
		bandwidthLow = nil
		bandwidthHigh = nil
		log.Printf("IQ mode detected (%s), ignoring bandwidth parameters", req.Mode)
	}

	client := NewRadioClient(
		"", req.Host, req.Port, req.Frequency, req.Mode,
		bandwidthLow, bandwidthHigh, req.OutputMode, "",
		nil, req.SSL, req.Password, req.AudioDevice, req.NR2Enabled,
		req.NR2Strength, req.NR2Floor, req.NR2AdaptRate, false,
		resampleEnabled, resampleRate,
		req.OutputChannels, // 0 = auto (2 when resampling, otherwise match input)
		req.FIFOPath, req.UDPHost, req.UDPPort, req.UDPEnabled,
	)

	// Connect
	if err := s.manager.Connect(client); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to connect", err.Error())
		return
	}

	// Restore saved output states after connection (in background to not block response)
	go func() {
		log.Printf("Output restoration goroutine started, waiting 2 seconds...")

		// Wait longer for client to be fully ready and audio system initialized
		// The client needs time to establish WebSocket connection and start audio processing
		time.Sleep(2 * time.Second)

		log.Printf("Checking connection status for output restoration...")

		// Double-check we're still connected
		if !s.manager.IsConnected() {
			log.Printf("Connection lost before output restoration could complete")
			return
		}

		log.Printf("Connection still active, loading config...")
		config := s.configManager.Get()
		log.Printf("Config loaded: PortAudioEnabled=%v, FIFOEnabled=%v, UDPEnabled=%v",
			config.PortAudioEnabled, config.FIFOEnabled, config.UDPEnabled)

		// Restore PortAudio state
		if config.PortAudioEnabled {
			log.Printf("Attempting to restore PortAudio output (device %d)...", config.PortAudioDevice)
			if err := s.manager.EnablePortAudioOutput(config.PortAudioDevice); err != nil {
				log.Printf("Warning: Failed to restore PortAudio output: %v", err)
			} else {
				log.Printf("Successfully restored PortAudio output (device %d)", config.PortAudioDevice)
			}
		}

		// Restore FIFO state
		if config.FIFOEnabled && config.FIFOPath != "" {
			log.Printf("Attempting to restore FIFO output (%s)...", config.FIFOPath)
			if err := s.manager.EnableFIFOOutput(config.FIFOPath); err != nil {
				log.Printf("Warning: Failed to restore FIFO output: %v", err)
			} else {
				log.Printf("Successfully restored FIFO output (%s)", config.FIFOPath)
			}
		}

		// Note: UDP state is already restored via the UDPEnabled flag passed to NewRadioClient
	}()

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
	status := s.manager.GetStatusWithOutputs()
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
			Host:                savedConfig.Host,
			Port:                savedConfig.Port,
			SSL:                 savedConfig.SSL,
			Frequency:           savedConfig.Frequency,
			Mode:                savedConfig.Mode,
			BandwidthLow:        savedConfig.BandwidthLow,
			BandwidthHigh:       savedConfig.BandwidthHigh,
			OutputMode:          savedConfig.OutputMode,
			AudioDevice:         savedConfig.AudioDevice,
			NR2Enabled:          savedConfig.NR2Enabled,
			NR2Strength:         savedConfig.NR2Strength,
			NR2Floor:            savedConfig.NR2Floor,
			NR2AdaptRate:        savedConfig.NR2AdaptRate,
			ResampleEnabled:     savedConfig.ResampleEnabled,
			ResampleOutputRate:  savedConfig.ResampleOutputRate,
			OutputChannels:      savedConfig.OutputChannels,
			AudioPreviewEnabled: savedConfig.AudioPreviewEnabled,
			AudioPreviewMuted:   savedConfig.AudioPreviewMuted,
			AutoConnect:         savedConfig.AutoConnect,
			SpectrumEnabled:     savedConfig.SpectrumEnabled,
			SpectrumZoomScroll:  savedConfig.SpectrumZoomScroll,
			SpectrumPanScroll:   savedConfig.SpectrumPanScroll,
			SpectrumClickTune:   savedConfig.SpectrumClickTune,
			SpectrumCenterTune:  savedConfig.SpectrumCenterTune,
			FIFOPath:            savedConfig.FIFOPath,
			UDPHost:             savedConfig.UDPHost,
			UDPPort:             savedConfig.UDPPort,
			UDPEnabled:          savedConfig.UDPEnabled,
			RadioControlType:    savedConfig.RadioControlType,
			FlrigEnabled:        savedConfig.FlrigEnabled,
			FlrigHost:           savedConfig.FlrigHost,
			FlrigPort:           savedConfig.FlrigPort,
			FlrigVFO:            savedConfig.FlrigVFO,
			FlrigSyncToRig:      savedConfig.FlrigSyncToRig,
			FlrigSyncFromRig:    savedConfig.FlrigSyncFromRig,
			RigctlEnabled:       savedConfig.RigctlEnabled,
			RigctlHost:          savedConfig.RigctlHost,
			RigctlPort:          savedConfig.RigctlPort,
			RigctlVFO:           savedConfig.RigctlVFO,
			RigctlSyncToRig:     savedConfig.RigctlSyncToRig,
			RigctlSyncFromRig:   savedConfig.RigctlSyncFromRig,
			SerialEnabled:       savedConfig.SerialEnabled,
			SerialPort:          savedConfig.SerialPort,
			SerialBaudrate:      savedConfig.SerialBaudrate,
			SerialVFO:           savedConfig.SerialVFO,
			SerialSyncToRig:     savedConfig.SerialSyncToRig,
			SerialSyncFromRig:   savedConfig.SerialSyncFromRig,
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

	// Save to config manager (works even when not connected)
	if err := s.configManager.UpdateNR2Config(req); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save config", err.Error())
		return
	}

	// Also update the active client if connected
	if s.manager.IsConnected() {
		if err := s.manager.UpdateConfig(req); err != nil {
			log.Printf("Warning: Failed to update active client config: %v", err)
			// Don't fail the request - config was saved successfully
		}
	}

	respondSuccess(w, "Configuration updated successfully")
}

// handlePortAudioOutput handles POST /api/outputs/portaudio
func (s *APIServer) handlePortAudioOutput(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	var req OutputControlRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.Enabled {
		// Enable PortAudio with specified device
		deviceIndex := -1 // Default device
		if req.DeviceIndex != nil {
			deviceIndex = *req.DeviceIndex
		}

		if err := s.manager.EnablePortAudioOutput(deviceIndex); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to enable PortAudio", err.Error())
			return
		}

		// Save state to config
		outputStatus := s.manager.GetOutputStatus()
		fifoEnabled := outputStatus["fifo"].(map[string]interface{})["enabled"].(bool)
		udpEnabled := outputStatus["udp"].(map[string]interface{})["enabled"].(bool)
		if err := s.configManager.UpdateOutputStates(true, deviceIndex, fifoEnabled, udpEnabled); err != nil {
			log.Printf("Warning: Failed to save output state: %v", err)
		}

		respondSuccess(w, "PortAudio output enabled")
	} else {
		// Disable PortAudio
		if err := s.manager.DisablePortAudioOutput(); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to disable PortAudio", err.Error())
			return
		}

		// Save state to config
		outputStatus := s.manager.GetOutputStatus()
		fifoEnabled := outputStatus["fifo"].(map[string]interface{})["enabled"].(bool)
		udpEnabled := outputStatus["udp"].(map[string]interface{})["enabled"].(bool)
		if err := s.configManager.UpdateOutputStates(false, -1, fifoEnabled, udpEnabled); err != nil {
			log.Printf("Warning: Failed to save output state: %v", err)
		}

		respondSuccess(w, "PortAudio output disabled")
	}
}

// handleFIFOOutput handles POST /api/outputs/fifo
func (s *APIServer) handleFIFOOutput(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	var req OutputControlRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.Enabled {
		// Enable FIFO at specified path
		if req.Path == "" {
			respondError(w, http.StatusBadRequest, "FIFO path is required", "")
			return
		}

		if err := s.manager.EnableFIFOOutput(req.Path); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to enable FIFO", err.Error())
			return
		}

		// Save state to config
		outputStatus := s.manager.GetOutputStatus()
		portAudioEnabled := outputStatus["portaudio"].(map[string]interface{})["enabled"].(bool)
		portAudioDevice := -1
		if deviceIdx, ok := outputStatus["portaudio"].(map[string]interface{})["deviceIndex"].(int); ok {
			portAudioDevice = deviceIdx
		}
		udpEnabled := outputStatus["udp"].(map[string]interface{})["enabled"].(bool)
		if err := s.configManager.UpdateOutputStates(portAudioEnabled, portAudioDevice, true, udpEnabled); err != nil {
			log.Printf("Warning: Failed to save output state: %v", err)
		}

		respondSuccess(w, "FIFO output enabled")
	} else {
		// Disable FIFO
		if err := s.manager.DisableFIFOOutput(); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to disable FIFO", err.Error())
			return
		}

		// Save state to config
		outputStatus := s.manager.GetOutputStatus()
		portAudioEnabled := outputStatus["portaudio"].(map[string]interface{})["enabled"].(bool)
		portAudioDevice := -1
		if deviceIdx, ok := outputStatus["portaudio"].(map[string]interface{})["deviceIndex"].(int); ok {
			portAudioDevice = deviceIdx
		}
		udpEnabled := outputStatus["udp"].(map[string]interface{})["enabled"].(bool)
		if err := s.configManager.UpdateOutputStates(portAudioEnabled, portAudioDevice, false, udpEnabled); err != nil {
			log.Printf("Warning: Failed to save output state: %v", err)
		}

		respondSuccess(w, "FIFO output disabled")
	}
}

// handleUDPOutput handles POST /api/outputs/udp
func (s *APIServer) handleUDPOutput(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	var req OutputControlRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.Enabled {
		// Enable UDP with specified host and port
		if req.Host == "" {
			req.Host = "127.0.0.1" // Default host
		}
		if req.Port == 0 {
			req.Port = 8888 // Default port
		}

		if err := s.manager.EnableUDPOutput(req.Host, req.Port); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to enable UDP", err.Error())
			return
		}

		// Save state to config
		outputStatus := s.manager.GetOutputStatus()
		portAudioEnabled := outputStatus["portaudio"].(map[string]interface{})["enabled"].(bool)
		portAudioDevice := -1
		if deviceIdx, ok := outputStatus["portaudio"].(map[string]interface{})["deviceIndex"].(int); ok {
			portAudioDevice = deviceIdx
		}
		fifoEnabled := outputStatus["fifo"].(map[string]interface{})["enabled"].(bool)
		if err := s.configManager.UpdateOutputStates(portAudioEnabled, portAudioDevice, fifoEnabled, true); err != nil {
			log.Printf("Warning: Failed to save output state: %v", err)
		}

		respondSuccess(w, fmt.Sprintf("UDP output enabled (%s:%d)", req.Host, req.Port))
	} else {
		// Disable UDP
		if err := s.manager.DisableUDPOutput(); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to disable UDP", err.Error())
			return
		}

		// Save state to config
		outputStatus := s.manager.GetOutputStatus()
		portAudioEnabled := outputStatus["portaudio"].(map[string]interface{})["enabled"].(bool)
		portAudioDevice := -1
		if deviceIdx, ok := outputStatus["portaudio"].(map[string]interface{})["deviceIndex"].(int); ok {
			portAudioDevice = deviceIdx
		}
		fifoEnabled := outputStatus["fifo"].(map[string]interface{})["enabled"].(bool)
		if err := s.configManager.UpdateOutputStates(portAudioEnabled, portAudioDevice, fifoEnabled, false); err != nil {
			log.Printf("Warning: Failed to save output state: %v", err)
		}

		respondSuccess(w, "UDP output disabled")
	}
}

// handleOutputStatus handles GET /api/outputs/status
func (s *APIServer) handleOutputStatus(w http.ResponseWriter, r *http.Request) {
	status := s.manager.GetOutputStatus()
	respondJSON(w, http.StatusOK, status)
}

// handleLocalInstances handles GET /api/instances/local
func (s *APIServer) handleLocalInstances(w http.ResponseWriter, r *http.Request) {
	instances := s.instanceDiscovery.GetLocalInstances()
	respondJSON(w, http.StatusOK, LocalInstancesResponse{Instances: instances})
}

// handlePublicInstances handles GET /api/instances/public
func (s *APIServer) handlePublicInstances(w http.ResponseWriter, r *http.Request) {
	instances, err := GetPublicInstances()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch public instances", err.Error())
		return
	}

	// Get local instance UUIDs to mark them in the response
	localUUIDs := s.instanceDiscovery.GetLocalInstanceUUIDs()

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"instances":  instances,
		"localUUIDs": localUUIDs,
	})
}

// handleSavedInstances handles GET /api/instances/saved
func (s *APIServer) handleSavedInstances(w http.ResponseWriter, r *http.Request) {
	instances := s.configManager.GetSavedInstances()
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"instances": instances,
	})
}

// handleSaveInstance handles POST /api/instances/saved
func (s *APIServer) handleSaveInstance(w http.ResponseWriter, r *http.Request) {
	var instance SavedInstance
	if err := json.NewDecoder(r.Body).Decode(&instance); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	// Validate required fields
	if instance.Name == "" {
		respondError(w, http.StatusBadRequest, "Instance name is required", "")
		return
	}
	if instance.Host == "" {
		respondError(w, http.StatusBadRequest, "Host is required", "")
		return
	}
	if instance.Port == 0 {
		respondError(w, http.StatusBadRequest, "Port is required", "")
		return
	}

	// Save the instance
	if err := s.configManager.SaveInstance(instance); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save instance", err.Error())
		return
	}

	respondSuccess(w, fmt.Sprintf("Instance '%s' saved successfully", instance.Name))
}

// handleDeleteInstance handles DELETE /api/instances/saved/{name}
func (s *APIServer) handleDeleteInstance(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	if name == "" {
		respondError(w, http.StatusBadRequest, "Instance name is required", "")
		return
	}

	// Delete the instance
	if err := s.configManager.DeleteInstance(name); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete instance", err.Error())
		return
	}

	respondSuccess(w, fmt.Sprintf("Instance '%s' deleted successfully", name))
}

// handleLoadInstance handles POST /api/instances/saved/{name}/load
func (s *APIServer) handleLoadInstance(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	if name == "" {
		respondError(w, http.StatusBadRequest, "Instance name is required", "")
		return
	}

	// Load the instance
	if err := s.configManager.LoadInstance(name); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load instance", err.Error())
		return
	}

	// Return the updated config including password
	config := s.configManager.Get()
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("Instance '%s' loaded successfully", name),
		"config": map[string]interface{}{
			"host":     config.Host,
			"port":     config.Port,
			"ssl":      config.SSL,
			"password": config.Password,
		},
	})
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

	// Create write channel for this connection to serialize all writes
	writeChan := make(chan interface{}, 100)
	writeErrors := make(chan error, 1)

	// Start write worker goroutine
	go func() {
		for msg := range writeChan {
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(msg); err != nil {
				select {
				case writeErrors <- err:
				default:
				}
				return
			}
		}
	}()
	defer close(writeChan)

	// Send initial status via write channel
	status := s.manager.GetStatus()
	select {
	case writeChan <- status:
	case <-time.After(5 * time.Second):
		log.Printf("Timeout sending initial status")
		return
	}

	// Channel for incoming messages
	done := make(chan struct{})
	defer close(done)

	// Handle incoming messages from client
	go func() {
		for {
			var msg map[string]interface{}
			if err := conn.ReadJSON(&msg); err != nil {
				log.Printf("WebSocket read error: %v", err)
				close(done)
				return
			}

			// Handle audio stream requests
			if msgType, ok := msg["type"].(string); ok && msgType == "audio_stream" {
				if enabled, ok := msg["enabled"].(bool); ok {
					s.handleAudioStreamRequest(conn, enabled, msg, writeChan)
				}
			}

			// Handle spectrum stream requests
			if msgType, ok := msg["type"].(string); ok && msgType == "spectrum_stream" {
				if enabled, ok := msg["enabled"].(bool); ok {
					s.handleSpectrumStreamRequest(conn, enabled, msg, writeChan)
				}
			}

			// Handle spectrum commands (zoom, pan)
			if msgType, ok := msg["type"].(string); ok && (msgType == "zoom" || msgType == "pan") {
				s.handleSpectrumCommand(conn, msgType, msg, writeChan)
			}
		}
	}()

	// Handle updates from manager
	for {
		select {
		case update, ok := <-updates:
			if !ok {
				return
			}
			select {
			case writeChan <- update:
			default:
				log.Printf("Write channel full, dropping update")
			}
		case err := <-writeErrors:
			log.Printf("WebSocket write error: %v", err)
			return
		case <-done:
			return
		}
	}
}

// handleAudioStreamRequest handles audio streaming enable/disable requests
func (s *APIServer) handleAudioStreamRequest(conn *websocket.Conn, enabled bool, msg map[string]interface{}, writeChan chan interface{}) {
	room, _ := msg["room"].(string)
	if room == "" {
		room = "audio_preview"
	}

	log.Printf("Audio stream request: enabled=%v, room=%s", enabled, room)

	if enabled {
		// Register the write channel for this connection
		s.manager.audioStreamsMu.Lock()
		s.manager.audioWriteChans[conn] = writeChan
		s.manager.audioStreamsMu.Unlock()

		// Enable audio streaming to this WebSocket connection
		s.manager.EnableAudioStream(conn, room)
	} else {
		// Disable audio streaming
		s.manager.DisableAudioStream(conn)
	}
}

// handleSpectrumStreamRequest handles spectrum streaming enable/disable requests
func (s *APIServer) handleSpectrumStreamRequest(conn *websocket.Conn, enabled bool, msg map[string]interface{}, writeChan chan interface{}) {
	room, _ := msg["room"].(string)
	if room == "" {
		room = "spectrum_preview"
	}

	log.Printf("Spectrum stream request: enabled=%v, room=%s", enabled, room)

	if enabled {
		// Register the write channel for this connection
		s.manager.spectrumStreamsMu.Lock()
		s.manager.spectrumWriteChans[conn] = writeChan
		s.manager.spectrumStreamsMu.Unlock()

		// Enable spectrum streaming to this WebSocket connection
		if err := s.manager.EnableSpectrumStream(conn, room); err != nil {
			log.Printf("Failed to enable spectrum stream: %v", err)
			// Send error message back to client via write channel
			errorMsg := map[string]interface{}{
				"type":    "error",
				"error":   "spectrum_stream_failed",
				"message": err.Error(),
			}
			select {
			case writeChan <- errorMsg:
			default:
				log.Printf("Failed to send error message: write channel full")
			}
		}
	} else {
		// Disable spectrum streaming
		s.manager.DisableSpectrumStream(conn)
	}
}

// handleSpectrumCommand handles spectrum control commands (zoom, pan)
func (s *APIServer) handleSpectrumCommand(conn *websocket.Conn, cmdType string, msg map[string]interface{}, writeChan chan interface{}) {
	log.Printf("Spectrum command: type=%s, params=%v", cmdType, msg)

	// Extract parameters and send to spectrum client
	if err := s.manager.SendSpectrumCommand(cmdType, msg); err != nil {
		log.Printf("Failed to send spectrum command: %v", err)
		// Send error message back to client via write channel
		errorMsg := map[string]interface{}{
			"type":    "error",
			"error":   "spectrum_command_failed",
			"message": err.Error(),
		}
		select {
		case writeChan <- errorMsg:
		default:
			log.Printf("Failed to send error message: write channel full")
		}
	}
}

// Radio Control Handlers (flrig)

// handleFlrigConnect handles POST /api/radio/flrig/connect
func (s *APIServer) handleFlrigConnect(w http.ResponseWriter, r *http.Request) {
	var req FlrigConnectRequest
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
		req.Port = 12345 // Default flrig port
	}
	if req.VFO == "" {
		req.VFO = "A" // Default to VFO A
	}

	// Connect to flrig
	if err := s.manager.ConnectFlrig(req.Host, req.Port, req.VFO, req.SyncToRig, req.SyncFromRig); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to connect to flrig", err.Error())
		return
	}

	// Save flrig config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.RadioControlType = "flrig"
		c.FlrigEnabled = true
		c.FlrigHost = req.Host
		c.FlrigPort = req.Port
		c.FlrigVFO = req.VFO
		c.FlrigSyncToRig = req.SyncToRig
		c.FlrigSyncFromRig = req.SyncFromRig
	}); err != nil {
		log.Printf("Warning: Failed to save flrig config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("Connected to flrig at %s:%d (sync: SDR->rig=%v, rig->SDR=%v)",
		req.Host, req.Port, req.SyncToRig, req.SyncFromRig))
}

// handleFlrigDisconnect handles POST /api/radio/flrig/disconnect
func (s *APIServer) handleFlrigDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsFlrigConnected() {
		respondError(w, http.StatusConflict, "flrig not connected", "")
		return
	}

	if err := s.manager.DisconnectFlrig(); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to disconnect from flrig", err.Error())
		return
	}

	// Update config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.FlrigEnabled = false
	}); err != nil {
		log.Printf("Warning: Failed to save flrig config: %v", err)
	}

	respondSuccess(w, "Disconnected from flrig")
}

// handleFlrigStatus handles GET /api/radio/flrig/status
func (s *APIServer) handleFlrigStatus(w http.ResponseWriter, r *http.Request) {
	status := s.manager.GetFlrigStatus()
	respondJSON(w, http.StatusOK, status)
}

// handleFlrigFrequency handles POST /api/radio/flrig/frequency
func (s *APIServer) handleFlrigFrequency(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsFlrigConnected() {
		respondError(w, http.StatusConflict, "flrig not connected", "")
		return
	}

	var req FrequencyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetFlrigFrequency(req.Frequency); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set flrig frequency", err.Error())
		return
	}

	respondSuccess(w, "flrig frequency set successfully")
}

// handleFlrigMode handles POST /api/radio/flrig/mode
func (s *APIServer) handleFlrigMode(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsFlrigConnected() {
		respondError(w, http.StatusConflict, "flrig not connected", "")
		return
	}

	var req ModeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetFlrigMode(req.Mode); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set flrig mode", err.Error())
		return
	}

	respondSuccess(w, "flrig mode set successfully")
}

// handleFlrigVFO handles POST /api/radio/flrig/vfo
func (s *APIServer) handleFlrigVFO(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsFlrigConnected() {
		respondError(w, http.StatusConflict, "flrig not connected", "")
		return
	}

	var req FlrigVFORequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.VFO != "A" && req.VFO != "B" {
		respondError(w, http.StatusBadRequest, "VFO must be 'A' or 'B'", "")
		return
	}

	if err := s.manager.SetFlrigVFO(req.VFO); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set flrig VFO", err.Error())
		return
	}

	// Update config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.FlrigVFO = req.VFO
	}); err != nil {
		log.Printf("Warning: Failed to save flrig VFO config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("flrig VFO set to %s", req.VFO))
}

// handleFlrigSync handles POST /api/radio/flrig/sync
func (s *APIServer) handleFlrigSync(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsFlrigConnected() {
		respondError(w, http.StatusConflict, "flrig not connected", "")
		return
	}

	var req FlrigSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetFlrigSync(req.SyncToRig, req.SyncFromRig); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update flrig sync settings", err.Error())
		return
	}

	// Update config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.FlrigSyncToRig = req.SyncToRig
		c.FlrigSyncFromRig = req.SyncFromRig
	}); err != nil {
		log.Printf("Warning: Failed to save flrig sync config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("flrig sync updated (SDR->rig=%v, rig->SDR=%v)", req.SyncToRig, req.SyncFromRig))
}

// Radio Control Handlers (rigctl)

// handleRigctlConnect handles POST /api/radio/rigctl/connect
func (s *APIServer) handleRigctlConnect(w http.ResponseWriter, r *http.Request) {
	var req RigctlConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.Host == "" {
		respondError(w, http.StatusBadRequest, "Host is required", "")
		return
	}

	if req.Port == 0 {
		req.Port = 4532 // Default rigctld port
	}

	if req.VFO == "" {
		req.VFO = "VFOA" // Default VFO
	}

	// Connect to rigctl
	if err := s.manager.ConnectRigctl(req.Host, req.Port, req.VFO, req.SyncToRig, req.SyncFromRig); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to connect to rigctld", err.Error())
		return
	}

	// Save rigctl config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.RadioControlType = "rigctl"
		c.RigctlEnabled = true
		c.RigctlHost = req.Host
		c.RigctlPort = req.Port
		c.RigctlVFO = req.VFO
		c.RigctlSyncToRig = req.SyncToRig
		c.RigctlSyncFromRig = req.SyncFromRig
	}); err != nil {
		log.Printf("Warning: Failed to save rigctl config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("Connected to rigctld at %s:%d (sync: SDR->rig=%v, rig->SDR=%v)",
		req.Host, req.Port, req.SyncToRig, req.SyncFromRig))
}

// handleRigctlDisconnect handles POST /api/radio/rigctl/disconnect
func (s *APIServer) handleRigctlDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsRigctlConnected() {
		respondError(w, http.StatusConflict, "rigctl not connected", "")
		return
	}

	if err := s.manager.DisconnectRigctl(); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to disconnect from rigctld", err.Error())
		return
	}

	// Update config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.RigctlEnabled = false
	}); err != nil {
		log.Printf("Warning: Failed to save rigctl config: %v", err)
	}

	respondSuccess(w, "Disconnected from rigctld")
}

// handleRigctlStatus handles GET /api/radio/rigctl/status
func (s *APIServer) handleRigctlStatus(w http.ResponseWriter, r *http.Request) {
	status := s.manager.GetRigctlStatus()
	respondJSON(w, http.StatusOK, status)
}

// handleRigctlFrequency handles POST /api/radio/rigctl/frequency
func (s *APIServer) handleRigctlFrequency(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsRigctlConnected() {
		respondError(w, http.StatusConflict, "rigctl not connected", "")
		return
	}

	var req FrequencyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetRigctlFrequency(req.Frequency); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set rigctl frequency", err.Error())
		return
	}

	respondSuccess(w, "rigctl frequency set successfully")
}

// handleRigctlMode handles POST /api/radio/rigctl/mode
func (s *APIServer) handleRigctlMode(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsRigctlConnected() {
		respondError(w, http.StatusConflict, "rigctl not connected", "")
		return
	}

	var req ModeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetRigctlMode(req.Mode); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set rigctl mode", err.Error())
		return
	}

	respondSuccess(w, "rigctl mode set successfully")
}

// handleRigctlVFO handles POST /api/radio/rigctl/vfo
func (s *APIServer) handleRigctlVFO(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsRigctlConnected() {
		respondError(w, http.StatusConflict, "rigctl not connected", "")
		return
	}

	var req RigctlVFORequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.VFO == "" {
		respondError(w, http.StatusBadRequest, "VFO is required", "")
		return
	}

	if err := s.manager.SetRigctlVFO(req.VFO); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set rigctl VFO", err.Error())
		return
	}

	// Save VFO to config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.RigctlVFO = req.VFO
	}); err != nil {
		log.Printf("Warning: Failed to save rigctl VFO config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("rigctl VFO set to %s", req.VFO))
}

// handleRigctlSync handles POST /api/radio/rigctl/sync
func (s *APIServer) handleRigctlSync(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsRigctlConnected() {
		respondError(w, http.StatusConflict, "rigctl not connected", "")
		return
	}

	var req RigctlSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if err := s.manager.SetRigctlSync(req.SyncToRig, req.SyncFromRig); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update rigctl sync settings", err.Error())
		return
	}

	// Save sync settings to config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.RigctlSyncToRig = req.SyncToRig
		c.RigctlSyncFromRig = req.SyncFromRig
	}); err != nil {
		log.Printf("Warning: Failed to save rigctl sync config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("rigctl sync updated (SDR->rig=%v, rig->SDR=%v)", req.SyncToRig, req.SyncFromRig))
}

// Radio Control Handlers (serial CAT server)

// handleSerialConnect handles POST /api/radio/serial/connect
// Starts a serial CAT server that emulates a Kenwood TS-480
func (s *APIServer) handleSerialConnect(w http.ResponseWriter, r *http.Request) {
	var req SerialConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}

	if req.Port == "" {
		respondError(w, http.StatusBadRequest, "Port is required", "")
		return
	}

	if req.Baudrate == 0 {
		req.Baudrate = 57600 // Default baudrate for TS-480
	}

	if req.VFO == "" {
		req.VFO = "A" // Default to VFO A
	}

	// Start serial CAT server
	if err := s.manager.StartSerialServer(req.Port, req.Baudrate, req.VFO); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to start serial CAT server", err.Error())
		return
	}

	// Save serial config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.RadioControlType = "serial"
		c.SerialEnabled = true
		c.SerialPort = req.Port
		c.SerialBaudrate = req.Baudrate
		c.SerialVFO = req.VFO
	}); err != nil {
		log.Printf("Warning: Failed to save serial config: %v", err)
	}

	respondSuccess(w, fmt.Sprintf("Started serial CAT server on %s at %d baud (VFO %s)",
		req.Port, req.Baudrate, req.VFO))
}

// handleSerialDisconnect handles POST /api/radio/serial/disconnect
func (s *APIServer) handleSerialDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsSerialServerRunning() {
		respondError(w, http.StatusConflict, "serial CAT server not running", "")
		return
	}

	if err := s.manager.StopSerialServer(); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to stop serial CAT server", err.Error())
		return
	}

	// Update config
	if err := s.configManager.Update(func(c *ClientConfig) {
		c.SerialEnabled = false
	}); err != nil {
		log.Printf("Warning: Failed to save serial config: %v", err)
	}

	respondSuccess(w, "Stopped serial CAT server")
}

// handleSerialStatus handles GET /api/radio/serial/status
func (s *APIServer) handleSerialStatus(w http.ResponseWriter, r *http.Request) {
	status := s.manager.GetSerialServerStatus()
	respondJSON(w, http.StatusOK, status)
}

// handleSerialFrequency - Not applicable for serial CAT server (server doesn't control external rig)
func (s *APIServer) handleSerialFrequency(w http.ResponseWriter, r *http.Request) {
	respondError(w, http.StatusNotImplemented, "Not applicable", "Serial CAT server emulates a rig, it doesn't control one")
}

// handleSerialMode - Not applicable for serial CAT server (server doesn't control external rig)
func (s *APIServer) handleSerialMode(w http.ResponseWriter, r *http.Request) {
	respondError(w, http.StatusNotImplemented, "Not applicable", "Serial CAT server emulates a rig, it doesn't control one")
}

// handleSerialVFO - Not applicable for serial CAT server (VFO is set at server start)
func (s *APIServer) handleSerialVFO(w http.ResponseWriter, r *http.Request) {
	respondError(w, http.StatusNotImplemented, "Not applicable", "VFO is set when starting the serial CAT server")
}

// handleSerialSync - Not applicable for serial CAT server (sync is always one-way: external software → SDR)
func (s *APIServer) handleSerialSync(w http.ResponseWriter, r *http.Request) {
	respondError(w, http.StatusNotImplemented, "Not applicable", "Serial CAT server always syncs from external software to SDR")
}

// handleSerialPorts handles GET /api/radio/serial/ports
func (s *APIServer) handleSerialPorts(w http.ResponseWriter, r *http.Request) {
	ports, err := ListSerialPorts()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list serial ports", err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"ports": ports,
	})
}

// handleBookmarks handles GET /api/bookmarks
// Fetches bookmarks from the connected SDR server
func (s *APIServer) handleBookmarks(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	// Get bookmarks from the SDR server via the manager
	bookmarks, err := s.manager.GetBookmarks()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch bookmarks", err.Error())
		return
	}

	respondJSON(w, http.StatusOK, bookmarks)
}

// handleBands handles GET /api/bands
// Fetches bands from the connected SDR server
func (s *APIServer) handleBands(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	// Get bands from the SDR server via the manager
	bands, err := s.manager.GetBands()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch bands", err.Error())
		return
	}

	respondJSON(w, http.StatusOK, bands)
}

// handleNoiseFloor handles GET /api/noisefloor/latest
// Fetches noise floor data from the connected SDR server
func (s *APIServer) handleNoiseFloor(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	// Get noise floor data from the SDR server via the manager
	noiseFloor, err := s.manager.GetNoiseFloor()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch noise floor", err.Error())
		return
	}

	respondJSON(w, http.StatusOK, noiseFloor)
}

// handleInstanceDescription handles GET /api/description
// Returns the instance description from the connected SDR server
func (s *APIServer) handleInstanceDescription(w http.ResponseWriter, r *http.Request) {
	if !s.manager.IsConnected() {
		respondError(w, http.StatusConflict, "Not connected", "Connect to SDR server first")
		return
	}

	// Get instance description from the manager
	description := s.manager.GetInstanceDescription()
	if description == nil {
		respondJSON(w, http.StatusOK, map[string]interface{}{})
		return
	}

	respondJSON(w, http.StatusOK, description)
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
