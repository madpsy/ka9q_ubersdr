package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Global debug flag
var DebugMode bool

// Global stats flag
var StatsMode bool

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

// gzipResponseWriter wraps http.ResponseWriter to provide gzip compression
type gzipResponseWriter struct {
	io.Writer
	http.ResponseWriter
}

func (w gzipResponseWriter) Write(b []byte) (int, error) {
	return w.Writer.Write(b)
}

// gzipHandler wraps an http.HandlerFunc with gzip compression
func gzipHandler(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check if client accepts gzip
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			fn(w, r)
			return
		}

		// Set gzip headers
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")

		// Create gzip writer
		gz := gzip.NewWriter(w)
		defer gz.Close()

		// Wrap response writer
		gzipW := gzipResponseWriter{Writer: gz, ResponseWriter: w}
		fn(gzipW, r)
	}
}

func main() {
	// Parse command line flags
	configDir := flag.String("config-dir", ".", "Directory containing configuration files")
	configFile := flag.String("config", "config.yaml", "Path to configuration file")
	debug := flag.Bool("debug", false, "Enable debug logging")
	stats := flag.Bool("stats", false, "Enable WebSocket statistics logging")
	flag.Parse()

	// Set global debug mode - check environment variable first, then CLI flag
	DebugMode = *debug
	if debugEnv := os.Getenv("DEBUG"); debugEnv != "" {
		// Environment variable takes precedence
		DebugMode = debugEnv == "true" || debugEnv == "1" || debugEnv == "yes"
	}
	if DebugMode {
		log.Println("Debug mode enabled")
	}

	// Set global stats mode - check environment variable first, then CLI flag
	StatsMode = *stats
	if statsEnv := os.Getenv("STATS"); statsEnv != "" {
		// Environment variable takes precedence
		StatsMode = statsEnv == "true" || statsEnv == "1" || statsEnv == "yes"
	}
	if StatsMode {
		log.Println("WebSocket statistics logging enabled")
	}

	// Load configuration
	configPath := *configFile
	if *configDir != "." {
		configPath = *configDir + "/" + *configFile
	}
	config, err := LoadConfig(configPath)
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
	bookmarksPath := "bookmarks.yaml"
	if *configDir != "." {
		bookmarksPath = *configDir + "/bookmarks.yaml"
	}
	bookmarksConfig, err := LoadConfig(bookmarksPath)
	if err == nil {
		config.Bookmarks = bookmarksConfig.Bookmarks
		log.Printf("Loaded %d bookmarks from bookmarks.yaml", len(config.Bookmarks))
	} else {
		log.Printf("No bookmarks.yaml found or error loading: %v", err)
	}

	// Load bands from bands.yaml if it exists
	bandsPath := "bands.yaml"
	if *configDir != "." {
		bandsPath = *configDir + "/bands.yaml"
	}
	bandsConfig, err := LoadConfig(bandsPath)
	if err == nil {
		config.Bands = bandsConfig.Bands
		log.Printf("Loaded %d amateur radio bands from bands.yaml", len(config.Bands))
	} else {
		log.Printf("No bands.yaml found or error loading: %v", err)
	}

	// Load extensions from extensions.yaml if it exists
	extensionsPath := "extensions.yaml"
	if *configDir != "." {
		extensionsPath = *configDir + "/extensions.yaml"
	}
	extensionsConfig, err := LoadConfig(extensionsPath)
	if err == nil {
		config.Extensions = extensionsConfig.Extensions
		config.DefaultExtension = extensionsConfig.DefaultExtension
		log.Printf("Loaded %d enabled extensions from extensions.yaml (default: %s)", len(config.Extensions), config.DefaultExtension)
	} else {
		log.Printf("No extensions.yaml found or error loading: %v", err)
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
	bannedIPsPath := "banned_ips.yaml"
	if *configDir != "." {
		bannedIPsPath = *configDir + "/banned_ips.yaml"
	}
	ipBanManager := NewIPBanManager(bannedIPsPath)

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

	// Initialize noise floor monitor
	// Set data directory relative to config directory
	if config.NoiseFloor.Enabled && config.NoiseFloor.DataDir == "" {
		config.NoiseFloor.DataDir = *configDir + "/noisefloor"
	} else if config.NoiseFloor.Enabled && !strings.HasPrefix(config.NoiseFloor.DataDir, "/") {
		// If relative path, make it relative to config directory
		config.NoiseFloor.DataDir = *configDir + "/" + config.NoiseFloor.DataDir
	}

	noiseFloorMonitor, err := NewNoiseFloorMonitor(config, radiod, sessions)
	if err != nil {
		log.Fatalf("Failed to initialize noise floor monitor: %v", err)
	}
	if noiseFloorMonitor != nil {
		if err := noiseFloorMonitor.Start(); err != nil {
			log.Fatalf("Failed to start noise floor monitor: %v", err)
		}
		defer noiseFloorMonitor.Stop()
	}

	// Initialize Prometheus metrics if enabled
	var prometheusMetrics *PrometheusMetrics
	if config.Prometheus.Enabled {
		prometheusMetrics = NewPrometheusMetrics()
		// Initialize system metrics
		prometheusMetrics.InitializeSystemMetrics()

		// Connect Prometheus metrics to session manager
		sessions.SetPrometheusMetrics(prometheusMetrics)

		// Connect Prometheus metrics to noise floor monitor
		if noiseFloorMonitor != nil {
			noiseFloorMonitor.prometheusMetrics = prometheusMetrics
		}

		// Start periodic session metrics update (every 10 seconds)
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				prometheusMetrics.UpdateSessionMetrics(sessions)
			}
		}()

		// Register Prometheus metrics endpoint with IP access control
		// Path is hardcoded to /metrics
		http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
			handlePrometheusMetrics(w, r, config)
		})
		log.Printf("Prometheus metrics enabled at /metrics (allowed hosts: %v)", config.Prometheus.AllowedHosts)

		// Start Pushgateway worker if enabled
		if config.Prometheus.Pushgateway.Enabled {
			// Create context for graceful shutdown
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			prometheusMetrics.StartPushgatewayWorker(ctx, config)
			log.Printf("Prometheus Pushgateway enabled: URL=%s, Job=ka9q_ubersdr, Instance=%s, Interval=60s",
				config.Prometheus.Pushgateway.URL,
				config.Prometheus.Pushgateway.Instance)
		}
	}

	// Initialize DX cluster client
	dxCluster := NewDXClusterClient(&config.DXCluster)

	// Set Prometheus metrics if enabled
	if prometheusMetrics != nil {
		dxCluster.SetPrometheusMetrics(prometheusMetrics)
	}

	if err := dxCluster.Start(); err != nil {
		log.Printf("Warning: Failed to start DX cluster client: %v", err)
	}
	defer dxCluster.Stop()

	// Initialize space weather monitor
	// Set data directory relative to config directory
	if config.SpaceWeather.LogToCSV && config.SpaceWeather.DataDir == "" {
		config.SpaceWeather.DataDir = *configDir + "/spaceweather"
	} else if config.SpaceWeather.LogToCSV && !strings.HasPrefix(config.SpaceWeather.DataDir, "/") {
		// If relative path, make it relative to config directory
		config.SpaceWeather.DataDir = *configDir + "/" + config.SpaceWeather.DataDir
	}

	spaceWeatherMonitor, err := NewSpaceWeatherMonitor(&config.SpaceWeather, prometheusMetrics)
	if err != nil {
		log.Fatalf("Failed to initialize space weather monitor: %v", err)
	}
	if err := spaceWeatherMonitor.Start(); err != nil {
		log.Printf("Warning: Failed to start space weather monitor: %v", err)
	}
	defer spaceWeatherMonitor.Stop()

	// Initialize DX cluster WebSocket handler
	dxClusterWsHandler := NewDXClusterWebSocketHandler(dxCluster, sessions, ipBanManager, prometheusMetrics)

	// Register DX spot handler for logging
	dxCluster.OnSpot(func(spot DXSpot) {
		log.Printf("DX Spot: %.1f kHz %s by %s - %s",
			spot.Frequency/1000, spot.DXCall, spot.Spotter, spot.Comment)
	})

	// Initialize rate limiter manager
	rateLimiterManager := NewRateLimiterManager(config.Server.CmdRateLimit)
	log.Printf("Command rate limiting: %d commands/sec per channel (0 = unlimited)", config.Server.CmdRateLimit)

	// Initialize connection rate limiter
	connRateLimiter := NewIPConnectionRateLimiter(config.Server.ConnRateLimit)
	log.Printf("Connection rate limiting: %d connections/sec per IP (0 = unlimited)", config.Server.ConnRateLimit)

	// Initialize aggregate endpoint rate limiter (1 request per 5 seconds per IP)
	aggregateRateLimiter := NewAggregateRateLimiter()
	log.Printf("Aggregate endpoint rate limiting: 1 request per 5 seconds per IP")

	// Initialize FFT endpoint rate limiter (1 request per 2 seconds per band per IP)
	fftRateLimiter := NewFFTRateLimiter()
	log.Printf("FFT endpoint rate limiting: 1 request per 2 seconds per band per IP")

	// Initialize space weather endpoint rate limiter
	spaceWeatherRateLimiter := NewSpaceWeatherRateLimiter()
	log.Printf("Space weather rate limiting: 1 req/sec (current), 1 req/2.5sec (history/dates/csv)")

	// Start periodic cleanup for rate limiters (every 5 minutes)
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			connRateLimiter.Cleanup()
			aggregateRateLimiter.Cleanup()
			fftRateLimiter.Cleanup()
			spaceWeatherRateLimiter.Cleanup()
		}
	}()

	// Initialize WebSocket handlers
	wsHandler := NewWebSocketHandler(sessions, audioReceiver, config, ipBanManager, rateLimiterManager, connRateLimiter, prometheusMetrics)
	// spectrumWsHandler := NewSpectrumWebSocketHandler(spectrumManager) // Old static spectrum - DISABLED
	userSpectrumWsHandler := NewUserSpectrumWebSocketHandler(sessions, ipBanManager, rateLimiterManager, connRateLimiter, prometheusMetrics) // New per-user spectrum

	// Initialize admin handler
	adminHandler := NewAdminHandler(config, configPath, *configDir, sessions, ipBanManager)

	// Setup HTTP routes
	http.HandleFunc("/connection", func(w http.ResponseWriter, r *http.Request) {
		handleConnectionCheck(w, r, sessions, ipBanManager)
	})
	http.HandleFunc("/ws", wsHandler.HandleWebSocket)
	// http.HandleFunc("/ws/spectrum", spectrumWsHandler.HandleWebSocket) // Old endpoint - DISABLED
	http.HandleFunc("/ws/user-spectrum", userSpectrumWsHandler.HandleSpectrumWebSocket) // New endpoint
	http.HandleFunc("/ws/dxcluster", dxClusterWsHandler.HandleWebSocket)                // DX cluster spots
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
	http.HandleFunc("/api/bands", func(w http.ResponseWriter, r *http.Request) {
		handleBands(w, r, config)
	})
	http.HandleFunc("/api/extensions", func(w http.ResponseWriter, r *http.Request) {
		handleExtensions(w, r, config)
	})
	http.HandleFunc("/api/description", func(w http.ResponseWriter, r *http.Request) {
		handleDescription(w, r, config)
	})
	http.HandleFunc("/status.json", func(w http.ResponseWriter, r *http.Request) {
		handleStatus(w, r, config)
	})
	http.HandleFunc("/api/spaceweather", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleSpaceWeather(w, r, spaceWeatherMonitor, ipBanManager, spaceWeatherRateLimiter)
	}))
	http.HandleFunc("/api/spaceweather/history", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleSpaceWeatherHistory(w, r, spaceWeatherMonitor, ipBanManager, spaceWeatherRateLimiter)
	}))
	http.HandleFunc("/api/spaceweather/dates", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleSpaceWeatherDates(w, r, spaceWeatherMonitor, ipBanManager, spaceWeatherRateLimiter)
	}))
	http.HandleFunc("/api/spaceweather/csv", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleSpaceWeatherCSV(w, r, spaceWeatherMonitor, ipBanManager, spaceWeatherRateLimiter)
	}))

	// Noise floor endpoints (with gzip compression, IP ban checking, and rate limiting)
	http.HandleFunc("/api/noisefloor/latest", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorLatest(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/noisefloor/recent", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorRecent(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/noisefloor/trend", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorTrend(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/noisefloor/history", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorHistory(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/noisefloor/dates", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorDates(w, r, noiseFloorMonitor, ipBanManager)
	}))
	http.HandleFunc("/api/noisefloor/fft", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorFFT(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/noisefloor/config", func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorConfig(w, r, config, ipBanManager)
	})
	http.HandleFunc("/api/noisefloor/aggregate", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorAggregate(w, r, noiseFloorMonitor, ipBanManager, aggregateRateLimiter, prometheusMetrics)
	}))

	// Admin authentication endpoints (no auth required)
	http.HandleFunc("/admin/login", adminHandler.HandleLogin)
	http.HandleFunc("/admin/logout", adminHandler.HandleLogout)

	// Admin endpoints (session protected)
	http.HandleFunc("/admin/config", adminHandler.AuthMiddleware(adminHandler.HandleConfig))
	http.HandleFunc("/admin/config/schema", adminHandler.AuthMiddleware(adminHandler.HandleConfigSchema))
	http.HandleFunc("/admin/bands", adminHandler.AuthMiddleware(adminHandler.HandleBands))
	http.HandleFunc("/admin/bands-import-sdrsharp", adminHandler.AuthMiddleware(adminHandler.HandleSDRSharpImport))
	http.HandleFunc("/admin/bookmarks", adminHandler.AuthMiddleware(adminHandler.HandleBookmarks))
	http.HandleFunc("/admin/extensions", adminHandler.AuthMiddleware(adminHandler.HandleExtensions))
	http.HandleFunc("/admin/extensions-manage", adminHandler.AuthMiddleware(adminHandler.HandleExtensionsAdmin))
	http.HandleFunc("/admin/extensions-available", adminHandler.AuthMiddleware(adminHandler.HandleAvailableExtensions))
	http.HandleFunc("/admin/sessions", adminHandler.AuthMiddleware(adminHandler.HandleSessions))
	http.HandleFunc("/admin/kick", adminHandler.AuthMiddleware(adminHandler.HandleKickUser))
	http.HandleFunc("/admin/ban", adminHandler.AuthMiddleware(adminHandler.HandleBanUser))
	http.HandleFunc("/admin/unban", adminHandler.AuthMiddleware(adminHandler.HandleUnbanIP))
	http.HandleFunc("/admin/banned-ips", adminHandler.AuthMiddleware(adminHandler.HandleBannedIPs))

	// Open log file for HTTP request logging
	// If LogFile is a relative path and we have a config directory, prepend it
	logFilePath := config.Server.LogFile
	if *configDir != "." && !strings.HasPrefix(logFilePath, "/") {
		logFilePath = *configDir + "/" + logFilePath
	}
	logFile, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Fatalf("Failed to open log file %s: %v", logFilePath, err)
	}
	defer logFile.Close()
	log.Printf("HTTP request logging to: %s", logFilePath)

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

	// Create a map of enabled extensions for quick lookup
	enabledExtensions := make(map[string]bool)
	for _, ext := range config.Extensions {
		enabledExtensions[ext] = true
	}

	// Filter bookmarks to only include enabled extensions
	filteredBookmarks := make([]Bookmark, len(config.Bookmarks))
	for i, bookmark := range config.Bookmarks {
		filteredBookmarks[i] = bookmark
		// If bookmark has an extension reference but it's not enabled, clear it
		if bookmark.Extension != "" && !enabledExtensions[bookmark.Extension] {
			filteredBookmarks[i].Extension = ""
		}
	}

	// Sort bookmarks alphabetically by name, then by frequency
	sort.Slice(filteredBookmarks, func(i, j int) bool {
		nameI := strings.ToLower(filteredBookmarks[i].Name)
		nameJ := strings.ToLower(filteredBookmarks[j].Name)
		if nameI == nameJ {
			return filteredBookmarks[i].Frequency < filteredBookmarks[j].Frequency
		}
		return nameI < nameJ
	})

	if err := json.NewEncoder(w).Encode(filteredBookmarks); err != nil {
		log.Printf("Error encoding bookmarks: %v", err)
	}
}

// handleBands serves the amateur radio bands configuration
func handleBands(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if err := json.NewEncoder(w).Encode(config.Bands); err != nil {
		log.Printf("Error encoding bands: %v", err)
	}
}

// handleExtensions serves the enabled extensions list
func handleExtensions(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// Read manifest for each enabled extension
	extensions := []map[string]string{}
	for _, extName := range config.Extensions {
		manifestPath := fmt.Sprintf("static/extensions/%s/manifest.json", extName)
		manifestData, err := os.ReadFile(manifestPath)
		if err != nil {
			log.Printf("Warning: Failed to read manifest for extension '%s': %v", extName, err)
			// Include extension with slug only if manifest is missing
			extensions = append(extensions, map[string]string{
				"slug":        extName,
				"displayName": extName,
			})
			continue
		}

		var manifest struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
		}
		if err := json.Unmarshal(manifestData, &manifest); err != nil {
			log.Printf("Warning: Failed to parse manifest for extension '%s': %v", extName, err)
			extensions = append(extensions, map[string]string{
				"slug":        extName,
				"displayName": extName,
			})
			continue
		}

		extensions = append(extensions, map[string]string{
			"slug":        manifest.Name,
			"displayName": manifest.DisplayName,
		})
	}

	// Prepare response with available extensions and default extension
	response := map[string]interface{}{
		"available": extensions,
		"default":   config.DefaultExtension,
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding extensions: %v", err)
	}
}

// handleDescription serves the description HTML from config plus all status information
func handleDescription(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// Build the response with description plus status information (without sdrs)
	response := map[string]interface{}{
		"description": config.Admin.Description,
		"receiver": map[string]interface{}{
			"name":       config.Admin.Name,
			"admin":      config.Admin.Email,
			"callsign":   config.Admin.Callsign,
			"public_url": config.Admin.PublicURL,
			"gps": map[string]interface{}{
				"lat": config.Admin.GPS.Lat,
				"lon": config.Admin.GPS.Lon,
			},
			"asl":      config.Admin.ASL,
			"location": config.Admin.Location,
		},
		"max_clients":   config.Server.MaxSessions,
		"version":       Version,
		"space_weather": config.SpaceWeather.Enabled,
		"noise_floor":   config.NoiseFloor.Enabled,
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
		"version":     Version,
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

// getClientIP extracts the client IP from the request, handling proxies
func getClientIP(r *http.Request) string {
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

	return clientIP
}

// checkIPBan checks if the client IP is banned and returns appropriate error if so
func checkIPBan(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) bool {
	clientIP := getClientIP(r)
	if ipBanManager.IsBanned(clientIP) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Access denied",
		})
		log.Printf("Blocked request from banned IP: %s to %s", clientIP, r.URL.Path)
		return true
	}
	return false
}

// handleNoiseFloorLatest serves the latest noise floor measurements
func handleNoiseFloorLatest(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Check rate limit (1 request per 2 seconds per IP, using "all" as band key)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "latest") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Latest endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	measurements := nfm.GetLatestMeasurements()
	if len(measurements) == 0 {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No measurements available yet",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(measurements); err != nil {
		log.Printf("Error encoding noise floor measurements: %v", err)
	}
}

// handleNoiseFloorHistory serves historical noise floor data
func handleNoiseFloorHistory(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Get query parameters
	date := r.URL.Query().Get("date")
	band := r.URL.Query().Get("band")

	if date == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date parameter is required (format: YYYY-MM-DD)",
		})
		return
	}

	// Check rate limit (1 request per 2 seconds per band per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("history-%s-%s", date, band)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("History endpoint rate limit exceeded for IP: %s, date: %s, band: %s", clientIP, date, band)
		return
	}

	measurements, err := nfm.GetHistoricalData(date, band)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get historical data: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(measurements); err != nil {
		log.Printf("Error encoding historical noise floor data: %v", err)
	}
}

// handleNoiseFloorRecent serves the last hour of noise floor data (all data points)
func handleNoiseFloorRecent(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Get optional band parameter
	band := r.URL.Query().Get("band")

	// Check rate limit (1 request per 2 seconds per band per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("recent-%s", band)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Recent endpoint rate limit exceeded for IP: %s, band: %s", clientIP, band)
		return
	}

	measurements, err := nfm.GetRecentData(band)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get recent data: %v", err),
		})
		return
	}

	if len(measurements) == 0 {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No recent data available",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(measurements); err != nil {
		log.Printf("Error encoding recent noise floor data: %v", err)
	}
}

// handleNoiseFloorTrend serves 24 hours of noise floor data averaged in 10-minute chunks
func handleNoiseFloorTrend(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Get query parameters
	date := r.URL.Query().Get("date")
	band := r.URL.Query().Get("band")

	if date == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date parameter is required (format: YYYY-MM-DD)",
		})
		return
	}

	// Check rate limit (1 request per 2 seconds per band per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("trend-%s-%s", date, band)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Trend endpoint rate limit exceeded for IP: %s, date: %s, band: %s", clientIP, date, band)
		return
	}

	measurements, err := nfm.GetTrendData(date, band)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get trend data: %v", err),
		})
		return
	}

	if len(measurements) == 0 {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No trend data available",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(measurements); err != nil {
		log.Printf("Error encoding trend noise floor data: %v", err)
	}
}

// handleNoiseFloorDates serves the list of available dates
func handleNoiseFloorDates(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Check for ?today=true parameter
	includeToday := r.URL.Query().Get("today") == "true"

	dates, err := nfm.GetAvailableDates(includeToday)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get available dates: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"dates": dates,
	}); err != nil {
		log.Printf("Error encoding available dates: %v", err)
	}
}

// handleNoiseFloorFFT serves the latest FFT data for a specific band
func handleNoiseFloorFFT(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if nfm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Get band parameter
	band := r.URL.Query().Get("band")
	if band == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "band parameter is required (e.g., 20m, 40m)",
		})
		return
	}

	// Check rate limit (1 request per 2 seconds per band per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, band) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Rate limit exceeded for band %s. Please wait 2 seconds between FFT requests for this band.", band),
		})
		log.Printf("FFT rate limit exceeded for IP: %s, band: %s", clientIP, band)
		return
	}

	fft := nfm.GetLatestFFT(band)
	if fft == nil {
		// Return 204 No Content instead of 404 - data not available yet but will be soon
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": fmt.Sprintf("No FFT data available yet for band %s. Data will be available after the first spectrum samples are collected.", band),
		})
		if DebugMode {
			log.Printf("DEBUG: FFT request for band %s returned no data (buffer may be empty or averaging window too short)", band)
		}
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(fft); err != nil {
		log.Printf("Error encoding FFT data: %v", err)
	}
}

// handleNoiseFloorConfig serves the noise floor band configurations
func handleNoiseFloorConfig(w http.ResponseWriter, r *http.Request, config *Config, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if !config.NoiseFloor.Enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Noise floor monitoring is not enabled",
		})
		return
	}

	// Build response with band configurations
	bands := make([]map[string]interface{}, len(config.NoiseFloor.Bands))
	for i, band := range config.NoiseFloor.Bands {
		bands[i] = map[string]interface{}{
			"name":             band.Name,
			"start":            band.Start,
			"end":              band.End,
			"center_frequency": band.CenterFrequency,
			"bin_count":        band.BinCount,
			"bin_bandwidth":    band.BinBandwidth,
			"total_bandwidth":  float64(band.BinCount) * band.BinBandwidth,
		}
	}

	response := map[string]interface{}{
		"bands": bands,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding noise floor config: %v", err)
	}
}

// handleSpaceWeather serves the current space weather data
func handleSpaceWeather(w http.ResponseWriter, r *http.Request, swm *SpaceWeatherMonitor, ipBanManager *IPBanManager, rateLimiter *SpaceWeatherRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Check rate limit (1 request per second per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "current") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 1 second between requests.",
		})
		log.Printf("Space weather current endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if swm == nil || !swm.config.Enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather monitoring is not enabled",
		})
		return
	}

	data := swm.GetData()

	// Check if we have valid data
	if data.LastUpdate.IsZero() {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "Space weather data not yet available. Please try again in a moment.",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error encoding space weather data: %v", err)
	}
}

// handleSpaceWeatherHistory serves historical space weather data from CSV
func handleSpaceWeatherHistory(w http.ResponseWriter, r *http.Request, swm *SpaceWeatherMonitor, ipBanManager *IPBanManager, rateLimiter *SpaceWeatherRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Check rate limit (1 request per 2.5 seconds per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "history") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2.5 seconds between requests.",
		})
		log.Printf("Space weather history endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if swm == nil || !swm.config.Enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather monitoring is not enabled",
		})
		return
	}

	if !swm.config.LogToCSV {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather CSV logging is not enabled",
		})
		return
	}

	// Get date parameters
	fromDate := r.URL.Query().Get("date")  // For backward compatibility
	toDate := r.URL.Query().Get("to_date") // Optional end date for range

	// Also support from_date parameter
	if fd := r.URL.Query().Get("from_date"); fd != "" {
		fromDate = fd
	}

	if fromDate == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date or from_date parameter is required (format: YYYY-MM-DD)",
		})
		return
	}

	// Get optional time parameters
	targetTime := r.URL.Query().Get("time") // Single closest record (only for single day)
	fromTime := r.URL.Query().Get("from")   // Time range start
	toTime := r.URL.Query().Get("to")       // Time range end

	// Validate that time and from/to are not used together
	if targetTime != "" && (fromTime != "" || toTime != "") {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Cannot use 'time' parameter with 'from'/'to' range parameters",
		})
		return
	}

	// Get historical data
	data, err := swm.GetHistoricalData(fromDate, toDate, targetTime, fromTime, toTime)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get historical data: %v", err),
		})
		return
	}

	if len(data) == 0 {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No data available for the specified date",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error encoding historical space weather data: %v", err)
	}
}

// handleSpaceWeatherDates serves the list of available dates for historical data
func handleSpaceWeatherDates(w http.ResponseWriter, r *http.Request, swm *SpaceWeatherMonitor, ipBanManager *IPBanManager, rateLimiter *SpaceWeatherRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Check rate limit (1 request per 2.5 seconds per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "dates") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2.5 seconds between requests.",
		})
		log.Printf("Space weather dates endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if swm == nil || !swm.config.Enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather monitoring is not enabled",
		})
		return
	}

	if !swm.config.LogToCSV {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather CSV logging is not enabled",
		})
		return
	}

	// Get available dates
	dates, err := swm.GetAvailableDates()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get available dates: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"dates": dates,
	}); err != nil {
		log.Printf("Error encoding available dates: %v", err)
	}
}

// handleSpaceWeatherCSV serves raw CSV download for historical data
func handleSpaceWeatherCSV(w http.ResponseWriter, r *http.Request, swm *SpaceWeatherMonitor, ipBanManager *IPBanManager, rateLimiter *SpaceWeatherRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	// Check rate limit (1 request per 2.5 seconds per IP)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "csv") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2.5 seconds between requests.",
		})
		log.Printf("Space weather CSV endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	if swm == nil || !swm.config.Enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather monitoring is not enabled",
		})
		return
	}

	if !swm.config.LogToCSV {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather CSV logging is not enabled",
		})
		return
	}

	// Get date parameters
	fromDate := r.URL.Query().Get("date")  // For backward compatibility
	toDate := r.URL.Query().Get("to_date") // Optional end date for range

	// Also support from_date parameter
	if fd := r.URL.Query().Get("from_date"); fd != "" {
		fromDate = fd
	}

	if fromDate == "" {
		w.WriteHeader(http.StatusBadRequest)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "date or from_date parameter is required (format: YYYY-MM-DD)",
		})
		return
	}

	// Get optional time range parameters
	fromTime := r.URL.Query().Get("from")
	toTime := r.URL.Query().Get("to")

	// Get CSV data
	csvData, err := swm.GetHistoricalCSV(fromDate, toDate, fromTime, toTime)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get CSV data: %v", err),
		})
		return
	}

	// Set headers for CSV download
	filename := fmt.Sprintf("spaceweather-%s.csv", fromDate)
	if toDate != "" && toDate != fromDate {
		filename = fmt.Sprintf("spaceweather-%s-to-%s.csv", fromDate, toDate)
	} else if fromTime != "" || toTime != "" {
		filename = fmt.Sprintf("spaceweather-%s-filtered.csv", fromDate)
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
	w.WriteHeader(http.StatusOK)

	// Write CSV data
	if _, err := w.Write([]byte(csvData)); err != nil {
		log.Printf("Error writing CSV data: %v", err)
	}
}

// handlePrometheusMetrics serves Prometheus metrics with IP-based access control
func handlePrometheusMetrics(w http.ResponseWriter, r *http.Request, config *Config) {
	// Get client IP using the same logic as other endpoints
	clientIP := getClientIP(r)

	// Check if IP is allowed
	if !config.Prometheus.IsIPAllowed(clientIP) {
		w.WriteHeader(http.StatusForbidden)
		if _, err := w.Write([]byte("403 Forbidden: Access denied\n")); err != nil {
			log.Printf("Error writing forbidden response: %v", err)
		}
		log.Printf("Prometheus metrics access denied for IP: %s", clientIP)
		return
	}

	// IP is allowed, serve metrics
	promhttp.Handler().ServeHTTP(w, r)
}
