package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"

	"gopkg.in/yaml.v3"
)

// WebServer handles the web interface for configuration management
type WebServer struct {
	config             *AppConfig
	configFile         string
	coordinatorManager *CoordinatorManager
	mu                 sync.RWMutex
	port               int
}

// NewWebServer creates a new web server
func NewWebServer(config *AppConfig, configFile string, port int, coordinatorManager *CoordinatorManager) *WebServer {
	return &WebServer{
		config:             config,
		configFile:         configFile,
		coordinatorManager: coordinatorManager,
		port:               port,
	}
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

// handleStatus returns the current status
func (ws *WebServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"running":   true,
		"instances": len(ws.config.KiwiInstances),
		"bands":     len(ws.config.GetEnabledBands()),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}
