package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Global debug flag
var DebugMode bool

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	written    int64
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.written += int64(n)
	return n, err
}

// httpLogger creates a logging middleware that logs requests in Apache combined log format
func httpLogger(logFile *os.File, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip logging for WebSocket connections
		if r.Header.Get("Upgrade") == "websocket" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()

		// Wrap the response writer to capture status code and bytes written
		wrapped := &responseWriter{
			ResponseWriter: w,
			statusCode:     200, // default status code
			written:        0,
		}

		// Call the next handler
		next.ServeHTTP(wrapped, r)

		// Calculate duration
		duration := time.Since(start)

		// Get client IP (handle X-Forwarded-For and X-Real-IP headers)
		clientIP := r.RemoteAddr
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			clientIP = forwarded
		} else if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
			clientIP = realIP
		}

		// Get user agent
		userAgent := r.Header.Get("User-Agent")
		if userAgent == "" {
			userAgent = "-"
		}

		// Get referer
		referer := r.Referer()
		if referer == "" {
			referer = "-"
		}

		// Apache Combined Log Format:
		// %h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-agent}i"
		// Example: 127.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08 [en] (Win98; I ;Nav)"
		logLine := fmt.Sprintf("%s - - [%s] \"%s %s %s\" %d %d \"%s\" \"%s\" %.3fms\n",
			clientIP,
			start.Format("02/Jan/2006:15:04:05 -0700"),
			r.Method,
			r.RequestURI,
			r.Proto,
			wrapped.statusCode,
			wrapped.written,
			referer,
			userAgent,
			float64(duration.Microseconds())/1000.0,
		)

		// Write to log file
		if _, err := logFile.WriteString(logLine); err != nil {
			log.Printf("Error writing to access log: %v", err)
		}
	})
}

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

	// Initialize IP ban manager
	ipBanManager := NewIPBanManager("banned_ips.yaml")

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
	wsHandler := NewWebSocketHandler(sessions, audioReceiver, config, ipBanManager)
	// spectrumWsHandler := NewSpectrumWebSocketHandler(spectrumManager) // Old static spectrum - DISABLED
	userSpectrumWsHandler := NewUserSpectrumWebSocketHandler(sessions, ipBanManager) // New per-user spectrum

	// Initialize admin handler
	adminHandler := NewAdminHandler(config, *configFile, sessions, ipBanManager)

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

	// Admin authentication endpoints (no auth required)
	http.HandleFunc("/admin/login", adminHandler.HandleLogin)
	http.HandleFunc("/admin/logout", adminHandler.HandleLogout)

	// Admin endpoints (session protected)
	http.HandleFunc("/admin/config", adminHandler.AuthMiddleware(adminHandler.HandleConfig))
	http.HandleFunc("/admin/config/schema", adminHandler.AuthMiddleware(adminHandler.HandleConfigSchema))
	http.HandleFunc("/admin/bookmarks", adminHandler.AuthMiddleware(adminHandler.HandleBookmarks))
	http.HandleFunc("/admin/sessions", adminHandler.AuthMiddleware(adminHandler.HandleSessions))
	http.HandleFunc("/admin/kick", adminHandler.AuthMiddleware(adminHandler.HandleKickUser))
	http.HandleFunc("/admin/ban", adminHandler.AuthMiddleware(adminHandler.HandleBanUser))
	http.HandleFunc("/admin/unban", adminHandler.AuthMiddleware(adminHandler.HandleUnbanIP))
	http.HandleFunc("/admin/banned-ips", adminHandler.AuthMiddleware(adminHandler.HandleBannedIPs))

	// Open log file for HTTP request logging
	logFile, err := os.OpenFile(config.Server.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Fatalf("Failed to open log file %s: %v", config.Server.LogFile, err)
	}
	defer logFile.Close()
	log.Printf("HTTP request logging to: %s", config.Server.LogFile)

	// Serve static files
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", fs)

	// Wrap the default ServeMux with logging middleware
	loggedHandler := httpLogger(logFile, http.DefaultServeMux)

	// Start HTTP server
	server := &http.Server{
		Addr:    config.Server.Listen,
		Handler: loggedHandler,
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
