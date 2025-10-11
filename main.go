package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

// Global debug flag
var DebugMode bool

func main() {
	// Parse command line flags
	configFile := flag.String("config", "config.yaml", "Path to configuration file")
	debug := flag.Bool("debug", false, "Enable debug logging")
	flag.Parse()

	// Set global debug mode
	DebugMode = *debug
	if DebugMode {
		log.Println("Debug mode enabled")
	}

	// Load configuration
	config, err := LoadConfig(*configFile)
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	if err := config.Validate(); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	// Check for default admin password
	if config.Admin.Password == "mypassword" {
		log.Fatalf("SECURITY ERROR: Default admin password detected!\n" +
			"Please change the admin password in config.yaml before starting the server.\n" +
			"The default password 'mypassword' is insecure and must be changed.")
	}

	// Load bookmarks from bookmarks.yaml if it exists
	bookmarksConfig, err := LoadConfig("bookmarks.yaml")
	if err == nil {
		config.Bookmarks = bookmarksConfig.Bookmarks
		log.Printf("Loaded %d bookmarks from bookmarks.yaml", len(config.Bookmarks))
	} else {
		log.Printf("No bookmarks.yaml found or error loading: %v", err)
	}

	log.Printf("Starting ka9q_ubersdr server...")
	log.Printf("Radiod status: %s", config.Radiod.StatusGroup)
	log.Printf("Radiod data: %s", config.Radiod.DataGroup)
	log.Printf("Server listen: %s", config.Server.Listen)
	log.Printf("Max sessions: %d", config.Server.MaxSessions)

	// Initialize radiod controller
	radiod, err := NewRadiodController(
		config.Radiod.StatusGroup,
		config.Radiod.DataGroup,
		config.Radiod.Interface,
	)
	if err != nil {
		log.Fatalf("Failed to initialize radiod controller: %v", err)
	}
	defer radiod.Close()

	// Initialize session manager
	sessions := NewSessionManager(config, radiod)

	// Initialize audio receiver
	audioReceiver, err := NewAudioReceiver(
		radiod.GetDataAddr(),
		radiod.GetInterface(),
		sessions,
	)
	if err != nil {
		log.Fatalf("Failed to initialize audio receiver: %v", err)
	}
	audioReceiver.Start()
	defer audioReceiver.Stop()

	// Initialize per-user spectrum manager
	userSpectrumManager, err := NewUserSpectrumManager(radiod, config, sessions)
	if err != nil {
		log.Fatalf("Failed to initialize user spectrum manager: %v", err)
	}
	if err := userSpectrumManager.Start(); err != nil {
		log.Fatalf("Failed to start user spectrum manager: %v", err)
	}
	defer userSpectrumManager.Stop()

	// Initialize WebSocket handlers
	wsHandler := NewWebSocketHandler(sessions, audioReceiver, config)
	// spectrumWsHandler := NewSpectrumWebSocketHandler(spectrumManager) // Old static spectrum - DISABLED
	userSpectrumWsHandler := NewUserSpectrumWebSocketHandler(sessions) // New per-user spectrum

	// Initialize admin handler
	adminHandler := NewAdminHandler(config, *configFile)

	// Setup HTTP routes
	http.HandleFunc("/ws", wsHandler.HandleWebSocket)
	// http.HandleFunc("/ws/spectrum", spectrumWsHandler.HandleWebSocket) // Old endpoint - DISABLED
	http.HandleFunc("/ws/user-spectrum", userSpectrumWsHandler.HandleSpectrumWebSocket) // New endpoint
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		handleStats(w, r, sessions)
	})
	http.HandleFunc("/test-spectrum", func(w http.ResponseWriter, r *http.Request) {
		handleTestSpectrum(w, r, sessions)
	})
	http.HandleFunc("/api/bookmarks", func(w http.ResponseWriter, r *http.Request) {
		handleBookmarks(w, r, config)
	})
	http.HandleFunc("/api/description", func(w http.ResponseWriter, r *http.Request) {
		handleDescription(w, r, config)
	})

	// Admin endpoints (password protected)
	http.HandleFunc("/admin/config", adminHandler.AuthMiddleware(adminHandler.HandleConfig))
	http.HandleFunc("/admin/config/schema", adminHandler.AuthMiddleware(adminHandler.HandleConfigSchema))
	http.HandleFunc("/admin/bookmarks", adminHandler.AuthMiddleware(adminHandler.HandleBookmarks))

	// Serve static files
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", fs)

	// Start HTTP server
	server := &http.Server{
		Addr: config.Server.Listen,
	}

	// Handle graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
		<-sigChan

		log.Println("Shutting down server...")

		// Clean up all active sessions first
		sessions.Shutdown()

		// Then close the HTTP server
		if err := server.Close(); err != nil {
			log.Printf("Error closing server: %v", err)
		}
	}()

	// Start server
	log.Printf("Server listening on %s", config.Server.Listen)
	log.Println("Open http://localhost:8080 in your browser")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Server stopped")
}

// handleHealth handles health check requests
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// handleStats handles statistics requests
func handleStats(w http.ResponseWriter, r *http.Request, sessions *SessionManager) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// Get optional session_id parameter to prioritize current user
	currentSessionID := r.URL.Query().Get("session_id")

	// Get all active sessions
	sessions.mu.RLock()
	var currentUserSession map[string]interface{}
	otherSessions := make([]map[string]interface{}, 0, len(sessions.sessions))

	for _, session := range sessions.sessions {
		// Skip spectrum sessions, only include audio channels
		if !session.IsSpectrum {
			session.mu.RLock()
			sessionInfo := map[string]interface{}{
				"frequency":      session.Frequency,
				"mode":           session.Mode,
				"bandwidth":      session.Bandwidth,
				"bandwidth_low":  session.BandwidthLow,
				"bandwidth_high": session.BandwidthHigh,
				"created_at":     session.CreatedAt,
				"last_active":    session.LastActive,
			}
			session.mu.RUnlock()

			// If this is the current user's session, save it separately
			if currentSessionID != "" && session.ID == currentSessionID {
				currentUserSession = sessionInfo
			} else {
				otherSessions = append(otherSessions, sessionInfo)
			}
		}
	}
	sessions.mu.RUnlock()

	// Build final list with current user first
	sessionList := make([]map[string]interface{}, 0, len(otherSessions)+1)
	if currentUserSession != nil {
		sessionList = append(sessionList, currentUserSession)
	}
	sessionList = append(sessionList, otherSessions...)

	// Add index numbers
	for i := range sessionList {
		sessionList[i]["index"] = i
	}

	response := map[string]interface{}{
		"active_sessions": len(sessionList),
		"channels":        sessionList,
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding stats: %v", err)
	}
}

// handleTestSpectrum creates a test spectrum session for debugging
func handleTestSpectrum(w http.ResponseWriter, r *http.Request, sessions *SessionManager) {
	w.Header().Set("Content-Type", "application/json")

	log.Println("TEST: Creating spectrum session...")
	session, err := sessions.CreateSpectrumSession()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		log.Printf("TEST: Failed to create spectrum session: %v", err)
		return
	}

	log.Printf("TEST: Spectrum session created successfully: %s", session.ID)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"session": session.GetInfo(),
	})
}

// handleBookmarks serves the bookmarks configuration
func handleBookmarks(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if err := json.NewEncoder(w).Encode(config.Bookmarks); err != nil {
		log.Printf("Error encoding bookmarks: %v", err)
	}
}

// handleDescription serves the description HTML from config
func handleDescription(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	response := map[string]string{
		"description": config.Admin.Description,
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding description: %v", err)
	}
}
