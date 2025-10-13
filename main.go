package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
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

	// Initialize rate limiter manager
	rateLimiterManager := NewRateLimiterManager(config.Server.CmdRateLimit)
	log.Printf("Command rate limiting: %d commands/sec per channel (0 = unlimited)", config.Server.CmdRateLimit)

	// Initialize WebSocket handlers
	wsHandler := NewWebSocketHandler(sessions, audioReceiver, config, ipBanManager, rateLimiterManager)
	// spectrumWsHandler := NewSpectrumWebSocketHandler(spectrumManager) // Old static spectrum - DISABLED
	userSpectrumWsHandler := NewUserSpectrumWebSocketHandler(sessions, ipBanManager, rateLimiterManager) // New per-user spectrum

	// Initialize admin handler
	adminHandler := NewAdminHandler(config, *configFile, sessions, ipBanManager)

	// Setup HTTP routes
	http.HandleFunc("/connection", func(w http.ResponseWriter, r *http.Request) {
		handleConnectionCheck(w, r, sessions, ipBanManager)
	})
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
	http.HandleFunc("/status.json", func(w http.ResponseWriter, r *http.Request) {
		handleStatus(w, r, config)
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

// ConnectionCheckRequest represents the request body for connection check
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
}

// ConnectionCheckResponse represents the response for connection check
type ConnectionCheckResponse struct {
	ClientIP       string `json:"client_ip"`
	Allowed        bool   `json:"allowed"`
	Reason         string `json:"reason,omitempty"`
	SessionTimeout int    `json:"session_timeout"`  // Session inactivity timeout in seconds (0 = no timeout)
	MaxSessionTime int    `json:"max_session_time"` // Maximum session time in seconds (0 = unlimited)
}

// handleConnectionCheck checks if a connection will be allowed before WebSocket upgrade
func handleConnectionCheck(w http.ResponseWriter, r *http.Request, sessions *SessionManager, ipBanManager *IPBanManager) {
	w.Header().Set("Content-Type", "application/json")

	// Only accept POST requests
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(ConnectionCheckResponse{
			Allowed: false,
			Reason:  "Method not allowed, use POST",
		})
		return
	}

	// Parse request body
	var req ConnectionCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(ConnectionCheckResponse{
			Allowed: false,
			Reason:  "Invalid request body",
		})
		return
	}

	// Get source IP address and strip port number
	sourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = host
	}

	clientIP := sourceIP

	// Check X-Forwarded-For header for true source IP (first IP in the list)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// X-Forwarded-For can contain multiple IPs: "client, proxy1, proxy2"
		// We want the first one (the true client)
		clientIP = strings.TrimSpace(xff)
		if commaIdx := strings.Index(clientIP, ","); commaIdx != -1 {
			clientIP = strings.TrimSpace(clientIP[:commaIdx])
		}
		// Strip port if present in X-Forwarded-For
		if host, _, err := net.SplitHostPort(clientIP); err == nil {
			clientIP = host
		}
	}

	// Check if this IP is in the timeout bypass list
	sessionTimeout := sessions.config.Server.SessionTimeout
	maxSessionTime := sessions.config.Server.MaxSessionTime
	if sessions.config.Server.IsIPTimeoutBypassed(clientIP) {
		// Bypassed IPs get 0 for both timeouts (unlimited)
		sessionTimeout = 0
		maxSessionTime = 0
	}

	response := ConnectionCheckResponse{
		ClientIP:       clientIP,
		Allowed:        true,
		SessionTimeout: sessionTimeout,
		MaxSessionTime: maxSessionTime,
	}

	// Check if IP is banned
	if ipBanManager.IsBanned(clientIP) {
		response.Allowed = false
		response.Reason = "Your IP address has been banned"
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(response)
		return
	}

	// Validate user session ID - must be a valid UUID
	if !isValidUUID(req.UserSessionID) {
		response.Allowed = false
		response.Reason = "Invalid or missing user_session_id"
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(response)
		return
	}

	// Check if this UUID has been kicked
	if sessions.IsUUIDKicked(req.UserSessionID) {
		response.Allowed = false
		response.Reason = "Your session has been terminated. Please refresh the page."
		w.WriteHeader(http.StatusGone) // 410 Gone - resource permanently unavailable
		json.NewEncoder(w).Encode(response)
		return
	}

	// Check if max sessions limit would be exceeded
	// Skip this check if the IP is in the bypass list
	if !sessions.config.Server.IsIPTimeoutBypassed(clientIP) {
		if !sessions.CanAcceptNewUUID(req.UserSessionID) {
			uniqueCount := sessions.GetUniqueUserCount()
			maxSessions := sessions.config.Server.MaxSessions
			response.Allowed = false
			response.Reason = fmt.Sprintf("Maximum unique users reached (%d of %d)", uniqueCount, maxSessions)
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(response)
			return
		}
	}

	// Check if max unique users per IP limit would be exceeded
	// Skip this check if the IP is in the bypass list
	if !sessions.config.Server.IsIPTimeoutBypassed(clientIP) {
		if !sessions.CanAcceptNewIP(clientIP, req.UserSessionID) {
			maxSessionsIP := sessions.config.Server.MaxSessionsIP
			response.Allowed = false
			response.Reason = fmt.Sprintf("Maximum unique users per IP reached (%d)", maxSessionsIP)
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(response)
			return
		}
	}

	// Connection is allowed - store User-Agent for this session
	userAgent := r.Header.Get("User-Agent")
	if userAgent != "" {
		sessions.SetUserAgent(req.UserSessionID, userAgent)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// handleHealth handles health check requests
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
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

// handleStatus serves the status.json endpoint with receiver and SDR information
func handleStatus(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// Build the status response
	response := map[string]interface{}{
		"receiver": map[string]interface{}{
			"name":  config.Admin.Name,
			"admin": config.Admin.Email,
			"gps": map[string]interface{}{
				"lat": config.Admin.GPS.Lat,
				"lon": config.Admin.GPS.Lon,
			},
			"asl":      config.Admin.ASL,
			"location": config.Admin.Location,
		},
		"max_clients": config.Server.MaxSessions,
		"version":     config.Admin.Version,
		"sdrs": []map[string]interface{}{
			{
				"name": "UberSDR",
				"type": "SDR",
				"profiles": []map[string]interface{}{
					{
						"name":        "0-30 MHz",
						"center_freq": 15000000, // 15 MHz in Hz
						"sample_rate": 64000000, // 64 MHz in Hz
					},
				},
			},
		},
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding status: %v", err)
	}
}
