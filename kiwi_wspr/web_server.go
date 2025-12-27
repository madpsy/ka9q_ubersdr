package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// WebServer handles the web interface for configuration management
type WebServer struct {
	config             *AppConfig
	configFile         string
	coordinatorManager *CoordinatorManager
	mu                 sync.RWMutex
	port               int
	kiwiStatusCache    map[string]*KiwiStatus
	kiwiStatusMu       sync.RWMutex
}

// KiwiStatus represents the status information from a KiwiSDR instance
type KiwiStatus struct {
	Status     string `json:"status"`
	Offline    string `json:"offline"`
	Name       string `json:"name"`
	Users      string `json:"users"`
	UsersMax   string `json:"users_max"`
	Location   string `json:"loc"`
	SwVersion  string `json:"sw_version"`
	Antenna    string `json:"antenna"`
	LastUpdate time.Time `json:"last_update"`
	Error      string `json:"error,omitempty"`
}

// NewWebServer creates a new web server
func NewWebServer(config *AppConfig, configFile string, port int, coordinatorManager *CoordinatorManager) *WebServer {
	ws := &WebServer{
		config:             config,
		configFile:         configFile,
		coordinatorManager: coordinatorManager,
		port:               port,
		kiwiStatusCache:    make(map[string]*KiwiStatus),
	}
	
	// Start background status polling
	go ws.pollKiwiStatus()
	
	return ws
}

// Start starts the web server
func (ws *WebServer) Start() error {
	// Serve static files
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/static/", http.StripPrefix("/static/", fs))

	// API endpoints
	http.HandleFunc("/", ws.handleIndex)
	http.HandleFunc("/api/config", ws.handleConfig)
	http.HandleFunc("/api/config/save", ws.handleSaveConfig)
	http.HandleFunc("/api/instances", ws.handleInstances)
	http.HandleFunc("/api/bands", ws.handleBands)
	http.HandleFunc("/api/status", ws.handleStatus)
	http.HandleFunc("/api/kiwi/status", ws.handleKiwiStatus)
	http.HandleFunc("/api/mqtt/test", ws.handleMQTTTest)

	addr := fmt.Sprintf(":%d", ws.port)
	log.Printf("Web interface starting on http://localhost%s", addr)
	return http.ListenAndServe(addr, nil)
}

// handleIndex serves the main HTML page
func (ws *WebServer) handleIndex(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "./static/index.html")
}

// handleConfig returns the current configuration
func (ws *WebServer) handleConfig(w http.ResponseWriter, r *http.Request) {
	ws.mu.RLock()
	defer ws.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ws.config)
}

// handleSaveConfig saves the configuration
func (ws *WebServer) handleSaveConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var newConfig AppConfig
	if err := json.NewDecoder(r.Body).Decode(&newConfig); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate configuration
	if err := newConfig.Validate(); err != nil {
		http.Error(w, fmt.Sprintf("Invalid configuration: %v", err), http.StatusBadRequest)
		return
	}

	// Save to file
	ws.mu.Lock()
	defer ws.mu.Unlock()

	data, err := yaml.Marshal(&newConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ws.configFile, data, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config: %v", err), http.StatusInternalServerError)
		return
	}

	ws.config = &newConfig

	// Apply configuration changes immediately by reloading coordinators
	if ws.coordinatorManager != nil {
		log.Println("WebServer: Applying configuration changes to running coordinators...")
		if err := ws.coordinatorManager.Reload(&newConfig); err != nil {
			log.Printf("WebServer: Warning - failed to reload coordinators: %v", err)
			// Don't fail the request, config was saved successfully
		} else {
			log.Println("WebServer: Configuration changes applied successfully")
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": "Configuration saved and applied"})
}

// handleInstances manages KiwiSDR instances
func (ws *WebServer) handleInstances(w http.ResponseWriter, r *http.Request) {
	ws.mu.RLock()
	defer ws.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ws.config.KiwiInstances)
}

// handleBands manages WSPR bands
func (ws *WebServer) handleBands(w http.ResponseWriter, r *http.Request) {
	ws.mu.RLock()
	defer ws.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ws.config.WSPRBands)
}

// handleStatus returns the current status including MQTT and band connection states
func (ws *WebServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	var status map[string]interface{}
	
	if ws.coordinatorManager != nil {
		status = ws.coordinatorManager.GetDetailedStatus()
	} else {
		// Fallback if coordinator manager not available
		status = map[string]interface{}{
			"running":   true,
			"instances": len(ws.config.KiwiInstances),
			"bands":     len(ws.config.GetEnabledBands()),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// handleMQTTTest tests the MQTT connection with provided parameters
func (ws *WebServer) handleMQTTTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse MQTT config from request body
	var mqttConfig MQTTConfig
	if err := json.NewDecoder(r.Body).Decode(&mqttConfig); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Test MQTT connection
	result := map[string]interface{}{
		"success": false,
		"message": "",
	}

	// Force enabled for testing
	mqttConfig.Enabled = true

	// Try to create a test MQTT connection with explicit timeout checking
	log.Printf("Testing MQTT connection to %s:%d", mqttConfig.Host, mqttConfig.Port)
	
	// Create MQTT client with test config
	testPublisher, connectedChan := NewMQTTPublisherWithStatus(&mqttConfig)
	if testPublisher == nil {
		result["message"] = "❌ Failed to create MQTT client"
		log.Printf("MQTT test failed: could not create client")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
		return
	}
	defer testPublisher.Disconnect()
	
	// Wait for connection result with timeout
	select {
	case connected := <-connectedChan:
		if connected {
			result["success"] = true
			result["message"] = fmt.Sprintf("✓ Successfully connected to MQTT broker at %s:%d", mqttConfig.Host, mqttConfig.Port)
			log.Printf("MQTT test successful: %s:%d", mqttConfig.Host, mqttConfig.Port)
		} else {
			result["success"] = false
			result["message"] = fmt.Sprintf("❌ Failed to connect to MQTT broker at %s:%d", mqttConfig.Host, mqttConfig.Port)
			log.Printf("MQTT test failed: connection failed to %s:%d", mqttConfig.Host, mqttConfig.Port)
		}
	case <-time.After(6 * time.Second):
		result["success"] = false
		result["message"] = fmt.Sprintf("❌ Connection timeout - could not connect to MQTT broker at %s:%d", mqttConfig.Host, mqttConfig.Port)
		log.Printf("MQTT test failed: connection timeout to %s:%d", mqttConfig.Host, mqttConfig.Port)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// pollKiwiStatus polls all KiwiSDR instances for their status every 10 seconds
func (ws *WebServer) pollKiwiStatus() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	// Poll immediately on startup
	ws.updateAllKiwiStatus()
	
	for range ticker.C {
		ws.updateAllKiwiStatus()
	}
}

// updateAllKiwiStatus updates the status for all configured KiwiSDR instances
func (ws *WebServer) updateAllKiwiStatus() {
	ws.mu.RLock()
	instances := ws.config.KiwiInstances
	ws.mu.RUnlock()
	
	for _, inst := range instances {
		if !inst.Enabled {
			continue
		}
		
		go func(instance KiwiInstance) {
			status := ws.fetchKiwiStatus(instance.Host, instance.Port)
			
			ws.kiwiStatusMu.Lock()
			ws.kiwiStatusCache[instance.Name] = status
			ws.kiwiStatusMu.Unlock()
		}(inst)
	}
}

// fetchKiwiStatus fetches status from a KiwiSDR instance
func (ws *WebServer) fetchKiwiStatus(host string, port int) *KiwiStatus {
	url := fmt.Sprintf("http://%s:%d/status", host, port)
	
	client := &http.Client{
		Timeout: 5 * time.Second,
	}
	
	resp, err := client.Get(url)
	if err != nil {
		return &KiwiStatus{
			Error:      fmt.Sprintf("Connection failed: %v", err),
			LastUpdate: time.Now(),
		}
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return &KiwiStatus{
			Error:      fmt.Sprintf("HTTP %d", resp.StatusCode),
			LastUpdate: time.Now(),
		}
	}
	
	// Parse the key=value format
	status := &KiwiStatus{
		LastUpdate: time.Now(),
	}
	
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		status.Error = fmt.Sprintf("Read failed: %v", err)
		return status
	}
	
	scanner := bufio.NewScanner(strings.NewReader(string(body)))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		
		switch key {
		case "status":
			status.Status = value
		case "offline":
			status.Offline = value
		case "name":
			status.Name = value
		case "users":
			status.Users = value
		case "users_max":
			status.UsersMax = value
		case "loc":
			status.Location = value
		case "sw_version":
			status.SwVersion = value
		case "antenna":
			status.Antenna = value
		}
	}
	
	return status
}

// handleKiwiStatus returns the cached status for all KiwiSDR instances
func (ws *WebServer) handleKiwiStatus(w http.ResponseWriter, r *http.Request) {
	ws.kiwiStatusMu.RLock()
	defer ws.kiwiStatusMu.RUnlock()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ws.kiwiStatusCache)
}
