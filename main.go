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
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Global debug flag
var DebugMode bool

// Global stats flag
var StatsMode bool

// Global start time for process uptime tracking
var StartTime time.Time

// Global config for tunnel server IP checking
var globalConfig *Config

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
		start := time.Now()

		// For WebSocket upgrade requests, log them immediately before upgrade
		// (we can't capture response after upgrade since the connection is hijacked)
		if r.Header.Get("Upgrade") == "websocket" {
			// Get client IP using the same logic as other endpoints
			clientIP := getClientIP(r)

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

			// Log WebSocket upgrade request (status 101 Switching Protocols is assumed)
			logLine := fmt.Sprintf("%s - - [%s] \"%s %s %s\" 101 - \"%s\" \"%s\" 0.000ms\n",
				clientIP,
				start.Format("02/Jan/2006:15:04:05 -0700"),
				r.Method,
				r.RequestURI,
				r.Proto,
				referer,
				userAgent,
			)

			// Write to log file
			if _, err := logFile.WriteString(logLine); err != nil {
				log.Printf("Error writing to access log: %v", err)
			}

			// Pass through to WebSocket handler
			next.ServeHTTP(w, r)
			return
		}

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

		// Get client IP using the same logic as other endpoints
		clientIP := getClientIP(r)

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

// corsMiddleware adds CORS headers to all responses if enabled in config
func corsMiddleware(config *Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if config.Server.EnableCORS {
			// Set CORS headers before any other processing
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "86400") // Cache preflight for 24 hours

			// Handle preflight OPTIONS requests
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent) // 204 is more appropriate than 200 for OPTIONS
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	// Record start time for uptime tracking
	StartTime = time.Now()

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

	// Set global config for tunnel server IP checking
	globalConfig = config

	// Check for default admin password
	if config.Admin.Password == "mypassword" {
		log.Fatalf("SECURITY ERROR: Default admin password detected!\n" +
			"Please change the admin password in config.yaml before starting the server.\n" +
			"The default password 'mypassword' is insecure and must be changed.")
	}

	// Generate Caddyfile based on instance configuration
	// This runs on every startup to ensure Caddy config is always in sync with config.yaml
	if err := GenerateCaddyfile(config); err != nil {
		log.Printf("Warning: Failed to generate Caddyfile: %v", err)
		log.Printf("Caddy may not function correctly. Check configuration and file permissions.")
	}

	// Generate tunnel client configuration if enabled
	// This runs on every startup to ensure tunnel client config is in sync with config.yaml
	if err := GenerateTunnelClientConfig(config); err != nil {
		log.Printf("Warning: Failed to generate tunnel client config: %v", err)
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

	// Load decoder configuration from decoder.yaml if it exists
	decoderPath := "decoder.yaml"
	if *configDir != "." {
		decoderPath = *configDir + "/decoder.yaml"
	}
	decoderConfig, err := LoadConfig(decoderPath)
	if err == nil {
		config.Decoder = decoderConfig.Decoder
		log.Printf("Loaded decoder configuration from decoder.yaml (enabled: %v, bands: %d)",
			config.Decoder.Enabled, len(config.Decoder.GetEnabledBands()))
	} else {
		log.Printf("No decoder.yaml found or error loading: %v", err)
	}

	// Initialize CTY.DAT database for country lookup
	ctyPath := "cty/cty.dat"
	if *configDir != "." {
		ctyPath = *configDir + "/cty/cty.dat"
	}
	if err := InitCTYDatabase(ctyPath); err != nil {
		log.Printf("Warning: Failed to load CTY.DAT database: %v", err)
		log.Printf("Country lookup will be disabled for digital spots")
	} else {
		log.Printf("CTY.DAT database loaded successfully")
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

	// Start version checker to fetch latest version from GitHub
	// Must be called after sessions is initialized so it can check for active users
	StartVersionChecker(config.Admin.VersionCheckEnabled, config.Admin.VersionCheckInterval, sessions)

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

	// Initialize Prometheus metrics if enabled (must be before multi-decoder)
	var prometheusMetrics *PrometheusMetrics
	if config.Prometheus.Enabled {
		prometheusMetrics = NewPrometheusMetrics()
		// Initialize system metrics
		prometheusMetrics.InitializeSystemMetrics()
	}

	// Initialize multi-decoder
	// Set data directory relative to config directory
	if config.Decoder.Enabled && config.Decoder.DataDir == "" {
		config.Decoder.DataDir = *configDir + "/decoder_data"
	} else if config.Decoder.Enabled && !strings.HasPrefix(config.Decoder.DataDir, "/") {
		// If relative path, make it relative to config directory
		config.Decoder.DataDir = *configDir + "/" + config.Decoder.DataDir
	}

	// Set spots log data directory relative to config directory (same pattern as spaceweather/noisefloor)
	if config.Decoder.Enabled && config.Decoder.SpotsLogEnabled && config.Decoder.SpotsLogDataDir == "" {
		config.Decoder.SpotsLogDataDir = *configDir + "/decoder_spots"
	} else if config.Decoder.Enabled && config.Decoder.SpotsLogEnabled && !strings.HasPrefix(config.Decoder.SpotsLogDataDir, "/") {
		// If relative path, make it relative to config directory
		config.Decoder.SpotsLogDataDir = *configDir + "/" + config.Decoder.SpotsLogDataDir
	}

	// Set metrics log data directory relative to config directory (same pattern as spots log)
	if config.Decoder.Enabled && config.Decoder.MetricsLogEnabled && config.Decoder.MetricsLogDataDir == "" {
		config.Decoder.MetricsLogDataDir = *configDir + "/decoder_metrics"
	} else if config.Decoder.Enabled && config.Decoder.MetricsLogEnabled && !strings.HasPrefix(config.Decoder.MetricsLogDataDir, "/") {
		// If relative path, make it relative to config directory
		config.Decoder.MetricsLogDataDir = *configDir + "/" + config.Decoder.MetricsLogDataDir
	}

	// Set metrics summary data directory relative to config directory (same pattern as metrics log)
	if config.Decoder.Enabled && config.Decoder.MetricsLogEnabled && config.Decoder.MetricsSummaryDataDir == "" {
		config.Decoder.MetricsSummaryDataDir = *configDir + "/decoder_summaries"
	} else if config.Decoder.Enabled && config.Decoder.MetricsLogEnabled && !strings.HasPrefix(config.Decoder.MetricsSummaryDataDir, "/") {
		// If relative path, make it relative to config directory
		config.Decoder.MetricsSummaryDataDir = *configDir + "/" + config.Decoder.MetricsSummaryDataDir
	}

	// Set default value for spots locators only filter
	// Default to true (only log/show spots with valid locators)
	// Users must explicitly set to false in config to log/see all spots
	if config.Decoder.Enabled && config.Decoder.SpotsLogEnabled {
		// Since bool defaults to false in Go/YAML, we set it to true if it's false
		if !config.Decoder.SpotsLogLocatorsOnly {
			config.Decoder.SpotsLogLocatorsOnly = true
		}
	}

	multiDecoder, err := NewMultiDecoder(&config.Decoder, radiod, sessions, prometheusMetrics)
	if err != nil {
		log.Printf("Warning: Failed to initialize multi-decoder: %v", err)
		log.Printf("Multi-decoder will be disabled. Server will continue without decoder functionality.")
		multiDecoder = nil
	}
	// Note: multiDecoder.Start() will be called later after dxClusterWsHandler is initialized

	// Continue Prometheus setup if enabled
	if prometheusMetrics != nil {
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

		// Create context for graceful shutdown (used by Pushgateway, MQTT, and digital metrics cleanup)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		// Start digital metrics cleanup goroutine (cleans up old data every 5 minutes)
		prometheusMetrics.StartDigitalMetricsCleanup(ctx)

		// Start CW metrics updater if CW Skimmer is enabled and has metrics
		// This will be connected later when cwSkimmer is initialized
		// (CW Skimmer is initialized after Prometheus setup)

		// Start Pushgateway worker if enabled
		if config.Prometheus.Pushgateway.Enabled {
			prometheusMetrics.StartPushgatewayWorker(ctx, config)
			log.Printf("Prometheus Pushgateway enabled: URL=%s, Job=ka9q_ubersdr, Instance=%s, Interval=60s",
				config.Prometheus.Pushgateway.URL,
				config.Prometheus.Pushgateway.Instance)
		}

		// Note: MQTT publisher will be started after space weather monitor is initialized
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

	// Load CW Skimmer configuration from cwskimmer.yaml if it exists
	cwskimmerPath := "cwskimmer.yaml"
	if *configDir != "." {
		cwskimmerPath = *configDir + "/cwskimmer.yaml"
	}
	cwskimmerConfig, err := LoadCWSkimmerConfig(cwskimmerPath)
	if err != nil {
		log.Printf("No cwskimmer.yaml found or error loading: %v", err)
		// Create a disabled config
		cwskimmerConfig = &CWSkimmerConfig{Enabled: false}
	} else {
		log.Printf("Loaded CW Skimmer configuration from cwskimmer.yaml (enabled: %v)", cwskimmerConfig.Enabled)
	}

	// Set spots log data directory relative to config directory (same pattern as decoder)
	if cwskimmerConfig.Enabled && cwskimmerConfig.SpotsLogEnabled && cwskimmerConfig.SpotsLogDataDir == "" {
		cwskimmerConfig.SpotsLogDataDir = *configDir + "/decoder_spots"
	} else if cwskimmerConfig.Enabled && cwskimmerConfig.SpotsLogEnabled && !strings.HasPrefix(cwskimmerConfig.SpotsLogDataDir, "/") {
		// If relative path, make it relative to config directory
		cwskimmerConfig.SpotsLogDataDir = *configDir + "/" + cwskimmerConfig.SpotsLogDataDir
	}

	// Set metrics log data directory relative to config directory (same pattern as decoder)
	if cwskimmerConfig.Enabled && cwskimmerConfig.MetricsLogEnabled && cwskimmerConfig.MetricsLogDataDir == "" {
		cwskimmerConfig.MetricsLogDataDir = *configDir + "/cwskimmer_metrics"
	} else if cwskimmerConfig.Enabled && cwskimmerConfig.MetricsLogEnabled && !strings.HasPrefix(cwskimmerConfig.MetricsLogDataDir, "/") {
		// If relative path, make it relative to config directory
		cwskimmerConfig.MetricsLogDataDir = *configDir + "/" + cwskimmerConfig.MetricsLogDataDir
	}

	// Set metrics summary data directory relative to config directory (same pattern as decoder)
	if cwskimmerConfig.Enabled && cwskimmerConfig.MetricsLogEnabled && cwskimmerConfig.MetricsSummaryDataDir == "" {
		cwskimmerConfig.MetricsSummaryDataDir = *configDir + "/cwskimmer_summaries"
	} else if cwskimmerConfig.Enabled && cwskimmerConfig.MetricsLogEnabled && !strings.HasPrefix(cwskimmerConfig.MetricsSummaryDataDir, "/") {
		// If relative path, make it relative to config directory
		cwskimmerConfig.MetricsSummaryDataDir = *configDir + "/" + cwskimmerConfig.MetricsSummaryDataDir
	}

	// Initialize CW Skimmer client
	var cwSkimmer *CWSkimmerClient
	if cwskimmerConfig.Enabled {
		// Get receiver location from admin config
		receiverLat := config.Admin.GPS.Lat
		receiverLon := config.Admin.GPS.Lon

		cwSkimmer = NewCWSkimmerClient(cwskimmerConfig, globalCTY, receiverLat, receiverLon)

		// Initialize metrics tracker if enabled
		if cwskimmerConfig.MetricsLogEnabled {
			cwMetrics := NewCWSkimmerMetrics(
				cwskimmerConfig.MetricsLogEnabled,
				cwskimmerConfig.MetricsLogDataDir,
				cwskimmerConfig.MetricsLogIntervalSecs,
				cwskimmerConfig.MetricsSummaryDataDir,
			)
			cwSkimmer.SetMetrics(cwMetrics)
			cwMetrics.StartPeriodicTasks()
			log.Printf("CW Skimmer metrics logging enabled: dir=%s, interval=%ds",
				cwskimmerConfig.MetricsLogDataDir, cwskimmerConfig.MetricsLogIntervalSecs)

			// Start CW metrics updater for Prometheus if enabled
			if prometheusMetrics != nil {
				// Get context for graceful shutdown
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				prometheusMetrics.StartCWMetricsUpdater(ctx, cwMetrics)
			}
		}

		// Set Prometheus metrics if enabled
		if prometheusMetrics != nil {
			cwSkimmer.SetPrometheusMetrics(prometheusMetrics)
		}

		// Initialize spots logger if enabled
		if cwskimmerConfig.SpotsLogEnabled {
			spotsLogger, err := NewCWSkimmerSpotsLogger(cwskimmerConfig.SpotsLogDataDir, true)
			if err != nil {
				log.Printf("Warning: Failed to initialize CW Skimmer spots logger: %v", err)
			} else {
				cwSkimmer.SetSpotsLogger(spotsLogger)
				defer spotsLogger.Close()
				log.Printf("CW Skimmer spots logging enabled to: %s", cwskimmerConfig.SpotsLogDataDir)
			}
		}

		// Initialize PSKReporter if enabled
		if cwskimmerConfig.PSKReporterEnabled {
			programName := fmt.Sprintf("%s %s", "UberSDR", Version)
			pskReporter, err := NewPSKReporter(
				cwskimmerConfig.PSKReporterCallsign,
				cwskimmerConfig.PSKReporterLocator,
				programName,
				cwskimmerConfig.PSKReporterAntenna,
			)
			if err != nil {
				log.Printf("Warning: Failed to initialize PSKReporter for CW Skimmer: %v", err)
			} else {
				if err := pskReporter.Connect(); err != nil {
					log.Printf("Warning: Failed to connect PSKReporter for CW Skimmer: %v", err)
				} else {
					cwSkimmer.SetPSKReporter(pskReporter)
					defer pskReporter.Stop()
					log.Printf("CW Skimmer PSKReporter enabled: callsign=%s, locator=%s",
						cwskimmerConfig.PSKReporterCallsign, cwskimmerConfig.PSKReporterLocator)
				}
			}
		}

		// Register spot handler for logging
		cwSkimmer.OnSpot(func(spot CWSkimmerSpot) {
			// Spot logging removed
		})

		if err := cwSkimmer.Start(); err != nil {
			log.Printf("Warning: Failed to start CW Skimmer client: %v", err)
		} else {
			defer cwSkimmer.Stop()
		}
	}

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

	// Start MQTT publisher if enabled (after space weather monitor is initialized)
	if prometheusMetrics != nil && config.MQTT.Enabled {
		// Get the context from Prometheus initialization
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		if err := prometheusMetrics.StartMQTTPublisher(ctx, config, noiseFloorMonitor, spaceWeatherMonitor); err != nil {
			log.Printf("Warning: Failed to start MQTT publisher: %v", err)
		}
	}

	// Initialize DX cluster WebSocket handler
	// Pass receiver locator from decoder config for distance/bearing calculation
	receiverLocator := ""
	if config.Decoder.Enabled {
		receiverLocator = config.Decoder.ReceiverLocator
	}
	dxClusterWsHandler := NewDXClusterWebSocketHandler(dxCluster, sessions, ipBanManager, prometheusMetrics, receiverLocator)

	// Register CW Skimmer spot handler to broadcast via websocket and MQTT
	if cwSkimmer != nil {
		cwSkimmer.OnSpot(func(spot CWSkimmerSpot) {
			// Broadcast to websocket clients
			dxClusterWsHandler.BroadcastCWSpot(spot)

			// Publish to MQTT if enabled
			if prometheusMetrics != nil && prometheusMetrics.mqttPublisher != nil {
				prometheusMetrics.mqttPublisher.PublishCWSpot(spot)
			}
		})
	}

	// Register DX spot handler for logging
	dxCluster.OnSpot(func(spot DXSpot) {
		// Spot logging removed
	})

	// Start multi-decoder and register callback for digital spots
	if multiDecoder != nil {
		if err := multiDecoder.Start(); err != nil {
			log.Printf("Warning: Failed to start multi-decoder: %v", err)
			log.Printf("Multi-decoder will be disabled. Server will continue without decoder functionality.")
			multiDecoder = nil
		} else {
			// Register callback to broadcast digital spots via websocket and MQTT
			multiDecoder.OnDecode(func(decode DecodeInfo) {
				// Broadcast to websocket clients
				dxClusterWsHandler.BroadcastDigitalSpot(decode)

				// Publish to MQTT if enabled
				if prometheusMetrics != nil && prometheusMetrics.mqttPublisher != nil {
					// Determine band name from frequency using the same logic as DX cluster
					bandName := frequencyToBand(float64(decode.Frequency))
					prometheusMetrics.mqttPublisher.PublishDigitalDecode(decode, bandName)
				}
			})
			defer multiDecoder.Stop()
		}
	}

	// Initialize rate limiter manager
	rateLimiterManager := NewRateLimiterManager(config.Server.CmdRateLimit)
	log.Printf("Command rate limiting: %d commands/sec per channel (0 = unlimited)", config.Server.CmdRateLimit)

	// Initialize connection rate limiter
	connRateLimiter := NewIPConnectionRateLimiter(config.Server.ConnRateLimit)
	log.Printf("Connection rate limiting: %d connections/sec per IP (0 = unlimited)", config.Server.ConnRateLimit)

	// Initialize /connection endpoint rate limiter
	connectionEndpointRateLimiter := NewConnectionRateLimiter(config.Server.SessionsPerMinute)
	log.Printf("/connection endpoint rate limiting: %d requests/min per IP (0 = unlimited)", config.Server.SessionsPerMinute)

	// Initialize aggregate endpoint rate limiter (1 request per 5 seconds per IP)
	aggregateRateLimiter := NewAggregateRateLimiter()
	log.Printf("Aggregate endpoint rate limiting: 1 request per 5 seconds per IP")

	// Initialize FFT endpoint rate limiter (1 request per 2 seconds per band per IP)
	fftRateLimiter := NewFFTRateLimiter()
	log.Printf("FFT endpoint rate limiting: 1 request per 2 seconds per band per IP")

	// Initialize Summary endpoint rate limiter (10 requests per second per IP)
	summaryRateLimiter := NewSummaryRateLimiter()
	log.Printf("Summary endpoint rate limiting: 10 requests per second per IP")

	// Initialize space weather endpoint rate limiter
	spaceWeatherRateLimiter := NewSpaceWeatherRateLimiter()
	log.Printf("Space weather rate limiting: 1 req/sec (current), 1 req/2.5sec (history/dates/csv)")

	// Start periodic cleanup for rate limiters (every 5 minutes)
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			connRateLimiter.Cleanup()
			connectionEndpointRateLimiter.Cleanup()
			aggregateRateLimiter.Cleanup()
			fftRateLimiter.Cleanup()
			spaceWeatherRateLimiter.Cleanup()
			summaryRateLimiter.Cleanup()
		}
	}()

	// Initialize WebSocket handlers
	wsHandler := NewWebSocketHandler(sessions, audioReceiver, config, ipBanManager, rateLimiterManager, connRateLimiter, prometheusMetrics)
	// spectrumWsHandler := NewSpectrumWebSocketHandler(spectrumManager) // Old static spectrum - DISABLED
	userSpectrumWsHandler := NewUserSpectrumWebSocketHandler(sessions, ipBanManager, rateLimiterManager, connRateLimiter, prometheusMetrics)      // New per-user spectrum
	kiwiHandler := NewKiwiWebSocketHandler(sessions, audioReceiver, config, ipBanManager, rateLimiterManager, connRateLimiter, prometheusMetrics) // KiwiSDR compatibility

	// Initialize instance reporter (before admin handler so it can be passed in)
	var instanceReporter *InstanceReporter
	if config.InstanceReporting.Enabled {
		instanceReporter = NewInstanceReporter(config, cwskimmerConfig, sessions, configPath)
	}

	// Initialize admin handler (pass all components for proper shutdown during restart)
	adminHandler := NewAdminHandler(config, configPath, *configDir, sessions, ipBanManager, audioReceiver, userSpectrumManager, noiseFloorMonitor, multiDecoder, dxCluster, spaceWeatherMonitor, cwskimmerConfig, cwSkimmer, instanceReporter)

	// Setup HTTP routes
	http.HandleFunc("/connection", func(w http.ResponseWriter, r *http.Request) {
		handleConnectionCheck(w, r, sessions, ipBanManager, connectionEndpointRateLimiter)
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
		handleDescription(w, r, config, cwskimmerConfig, sessions, instanceReporter)
	})
	http.HandleFunc("/api/instance", func(w http.ResponseWriter, r *http.Request) {
		handleInstanceStatus(w, r, config)
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
	http.HandleFunc("/api/noisefloor/trends", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorTrends(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
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
	http.HandleFunc("/api/noisefloor/fft/wideband", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorWideBandFFT(w, r, noiseFloorMonitor, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/noisefloor/config", func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorConfig(w, r, config, ipBanManager)
	})
	http.HandleFunc("/api/noisefloor/aggregate", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorAggregate(w, r, noiseFloorMonitor, ipBanManager, aggregateRateLimiter, prometheusMetrics)
	}))

	// Decoder spots endpoints (with gzip compression, IP ban checking, and rate limiting)
	http.HandleFunc("/api/decoder/spots", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderSpots(w, r, multiDecoder, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/decoder/spots/dates", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderSpotsDates(w, r, multiDecoder, ipBanManager)
	}))
	http.HandleFunc("/api/decoder/spots/names", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderSpotsNames(w, r, multiDecoder, ipBanManager)
	}))
	http.HandleFunc("/api/decoder/spots/csv", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderSpotsCSV(w, r, multiDecoder, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/decoder/spots/analytics", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderSpotsAnalytics(w, r, multiDecoder, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/decoder/spots/analytics/hourly", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderSpotsAnalyticsHourly(w, r, multiDecoder, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/decoder/metrics", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecodeMetrics(w, r, multiDecoder, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/decoder/metrics/summary", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleDecodeMetricsSummary(w, r, multiDecoder, ipBanManager, summaryRateLimiter)
	}))
	http.HandleFunc("/api/decoder/band-names", func(w http.ResponseWriter, r *http.Request) {
		handleDecoderBandNames(w, r, multiDecoder, ipBanManager)
	})
	http.HandleFunc("/api/decoder/spots/predictions", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleBandPredictions(w, r, multiDecoder, spaceWeatherMonitor, ipBanManager, fftRateLimiter)
	}))

	// CW Skimmer spots endpoints (with gzip compression, IP ban checking, and rate limiting)
	http.HandleFunc("/api/cwskimmer/spots", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWSpotsAPI(w, r, cwSkimmer, ipBanManager, fftRateLimiter, globalCTY)
	}))
	http.HandleFunc("/api/cwskimmer/spots/dates", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWSpotsDatesAPI(w, r, cwSkimmer, ipBanManager)
	}))
	http.HandleFunc("/api/cwskimmer/spots/names", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWSpotsNamesAPI(w, r, cwSkimmer, ipBanManager)
	}))
	http.HandleFunc("/api/cwskimmer/spots/csv", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWSpotsCSVAPI(w, r, cwSkimmer, ipBanManager, fftRateLimiter, globalCTY)
	}))
	http.HandleFunc("/api/cwskimmer/metrics", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWMetrics(w, r, cwSkimmer, ipBanManager, fftRateLimiter)
	}))
	http.HandleFunc("/api/cwskimmer/metrics/summary", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWMetricsSummary(w, r, cwSkimmer, ipBanManager, summaryRateLimiter)
	}))
	http.HandleFunc("/api/cwskimmer/spots/analytics", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWSpotsAnalytics(w, r, cwSkimmer, ipBanManager, fftRateLimiter, globalCTY)
	}))
	http.HandleFunc("/api/cwskimmer/spots/analytics/hourly", gzipHandler(func(w http.ResponseWriter, r *http.Request) {
		handleCWSpotsAnalyticsHourly(w, r, cwSkimmer, ipBanManager, fftRateLimiter, globalCTY)
	}))

	// CTY API endpoints (with IP ban checking)
	RegisterCTYAPIHandlers(ipBanManager)

	// Admin authentication endpoints (no auth required)
	http.HandleFunc("/admin/login", adminHandler.HandleLogin)
	http.HandleFunc("/admin/logout", adminHandler.HandleLogout)
	http.HandleFunc("/admin/wizard-status", adminHandler.HandleWizardStatus)
	http.HandleFunc("/admin/wizard-complete", adminHandler.HandleWizardComplete)

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
	http.HandleFunc("/admin/frontend-status", adminHandler.AuthMiddleware(adminHandler.HandleFrontendStatus))
	http.HandleFunc("/admin/channel-status", adminHandler.AuthMiddleware(adminHandler.HandleChannelStatus))
	http.HandleFunc("/admin/system-load", adminHandler.AuthMiddleware(adminHandler.HandleSystemLoad))
	http.HandleFunc("/admin/kick", adminHandler.AuthMiddleware(adminHandler.HandleKickUser))
	http.HandleFunc("/admin/ban", adminHandler.AuthMiddleware(adminHandler.HandleBanUser))
	http.HandleFunc("/admin/unban", adminHandler.AuthMiddleware(adminHandler.HandleUnbanIP))
	http.HandleFunc("/admin/banned-ips", adminHandler.AuthMiddleware(adminHandler.HandleBannedIPs))
	http.HandleFunc("/admin/decoder-config", adminHandler.AuthMiddleware(adminHandler.HandleDecoderConfig))
	http.HandleFunc("/admin/decoder-bands", adminHandler.AuthMiddleware(adminHandler.HandleDecoderBands))
	http.HandleFunc("/admin/cwskimmer-config", adminHandler.AuthMiddleware(adminHandler.HandleCWSkimmerConfig))
	http.HandleFunc("/admin/radiod-config", adminHandler.AuthMiddleware(adminHandler.HandleRadiodConfig))
	http.HandleFunc("/admin/system-stats", adminHandler.AuthMiddleware(adminHandler.HandleSystemStats))
	http.HandleFunc("/admin/noisefloor-health", adminHandler.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		handleNoiseFloorHealth(w, r, noiseFloorMonitor)
	}))
	http.HandleFunc("/admin/spaceweather-health", adminHandler.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		handleSpaceWeatherHealth(w, r, spaceWeatherMonitor)
	}))
	http.HandleFunc("/admin/decoder-health", adminHandler.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		handleDecoderHealth(w, r, multiDecoder)
	}))
	http.HandleFunc("/admin/cwskimmer-health", adminHandler.AuthMiddleware(adminHandler.HandleCWSkimmerHealth))
	http.HandleFunc("/admin/instance-reporter-health", adminHandler.AuthMiddleware(adminHandler.HandleInstanceReporterHealth))
	http.HandleFunc("/admin/instance-reporter-trigger", adminHandler.AuthMiddleware(adminHandler.HandleInstanceReporterTrigger))
	http.HandleFunc("/admin/tunnel-server-health", adminHandler.AuthMiddleware(adminHandler.HandleTunnelServerHealth))

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

	// Wrap the default ServeMux with CORS middleware (if enabled), then logging middleware
	var handler http.Handler = http.DefaultServeMux
	handler = corsMiddleware(config, handler)
	handler = httpLogger(logFile, handler)

	// Start HTTP server
	server := &http.Server{
		Addr:    config.Server.Listen,
		Handler: handler,
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

	// Start KiwiSDR compatibility server on separate port if enabled
	var kiwiServer *http.Server
	if config.Server.EnableKiwiSDR && config.Server.KiwiSDRListen != "" {
		// Create separate HTTP server for KiwiSDR protocol
		kiwiMux := http.NewServeMux()
		kiwiMux.HandleFunc("/status", kiwiHandler.HandleKiwiStatus) // KiwiSDR status endpoint
		kiwiMux.HandleFunc("/", kiwiHandler.HandleKiwiWebSocket)    // Accept any path for WebSocket

		kiwiServer = &http.Server{
			Addr:    config.Server.KiwiSDRListen,
			Handler: kiwiMux,
		}

		go func() {
			log.Printf("KiwiSDR protocol server listening on %s", config.Server.KiwiSDRListen)
			log.Printf("KiwiSDR clients can connect to this port (e.g., kiwirecorder.py -s host -p %s)", strings.TrimPrefix(config.Server.KiwiSDRListen, ":"))
			if err := kiwiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("KiwiSDR server error: %v", err)
			}
		}()

		// Add to shutdown handler
		defer func() {
			if kiwiServer != nil {
				if err := kiwiServer.Close(); err != nil {
					log.Printf("Error closing KiwiSDR server: %v", err)
				}
			}
		}()
	} else if config.Server.EnableKiwiSDR {
		log.Printf("KiwiSDR protocol compatibility enabled but kiwisdr_listen not configured (will use default :8073)")
	} else {
		log.Printf("KiwiSDR protocol compatibility disabled")
	}

	// Start server
	log.Printf("Server listening on %s", config.Server.Listen)
	log.Println("Open http://localhost:8080 in your browser")

	// Start instance reporter after HTTP server is listening
	if instanceReporter != nil {
		if err := instanceReporter.Start(); err != nil {
			log.Printf("Warning: Failed to start instance reporter: %v", err)
		} else {
			defer instanceReporter.Stop()
		}
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Server stopped")
}

// ConnectionCheckRequest represents the request body for connection check
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"` // Optional password for bypass authentication
}

// ConnectionCheckResponse represents the response for connection check
type ConnectionCheckResponse struct {
	ClientIP       string   `json:"client_ip"`
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	SessionTimeout int      `json:"session_timeout"`  // Session inactivity timeout in seconds (0 = no timeout)
	MaxSessionTime int      `json:"max_session_time"` // Maximum session time in seconds (0 = unlimited)
	Bypassed       bool     `json:"bypassed"`         // Whether the IP is in the timeout bypass list
	AllowedIQModes []string `json:"allowed_iq_modes"` // List of IQ modes the user can access
}

// handleConnectionCheck checks if a connection will be allowed before WebSocket upgrade
func handleConnectionCheck(w http.ResponseWriter, r *http.Request, sessions *SessionManager, ipBanManager *IPBanManager, rateLimiter *ConnectionRateLimiter) {
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

	// Parse request body first to get password for bypass check
	var req ConnectionCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(ConnectionCheckResponse{
			Allowed: false,
			Reason:  "Invalid request body",
		})
		return
	}

	// Get client IP
	clientIP := getClientIP(r)

	// Check if this IP is bypassed (or valid password provided) - bypassed IPs skip rate limiting
	isBypassed := sessions.config.Server.IsIPTimeoutBypassed(clientIP, req.Password)

	// Check rate limit (10 requests per minute per IP by default) - skip for bypassed IPs
	if !isBypassed && !rateLimiter.AllowRequest(clientIP) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(ConnectionCheckResponse{
			Allowed: false,
			Reason:  "Rate limit exceeded. Please wait before trying again.",
		})
		log.Printf("/connection endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// isBypassed was already checked above for rate limiting
	sessionTimeout := sessions.config.Server.SessionTimeout
	maxSessionTime := sessions.config.Server.MaxSessionTime

	// If session_timeout is 0, use max_session_time value
	if sessionTimeout == 0 && maxSessionTime > 0 {
		sessionTimeout = maxSessionTime
	}

	if isBypassed {
		// Bypassed IPs get 0 for both timeouts (unlimited)
		sessionTimeout = 0
		maxSessionTime = 0
	}

	// Build list of allowed IQ modes for this user
	// Bypassed users get all modes, non-bypassed users get public modes only
	allowedIQModes := []string{}
	wideIQModes := []string{"iq48", "iq96", "iq192", "iq384"}

	if isBypassed {
		// Bypassed users can access all wide IQ modes
		allowedIQModes = wideIQModes
	} else {
		// Non-bypassed users can only access public IQ modes
		for _, mode := range wideIQModes {
			if sessions.config.Server.PublicIQModes[mode] {
				allowedIQModes = append(allowedIQModes, mode)
			}
		}
	}

	response := ConnectionCheckResponse{
		ClientIP:       clientIP,
		Allowed:        true,
		SessionTimeout: sessionTimeout,
		MaxSessionTime: maxSessionTime,
		Bypassed:       isBypassed,
		AllowedIQModes: allowedIQModes,
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
	// Skip this check if the IP is in the bypass list or valid password provided
	if !sessions.config.Server.IsIPTimeoutBypassed(clientIP, req.Password) {
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
	// Skip this check if the IP is in the bypass list or valid password provided
	if !sessions.config.Server.IsIPTimeoutBypassed(clientIP, req.Password) {
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
		// Also skip sessions without a ClientIP address
		if !session.IsSpectrum && session.ClientIP != "" {
			session.mu.RLock()

			// Check if this IP is bypassed
			isBypassed := sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP)

			// Skip bypassed IPs UNLESS it's the current user's session
			if isBypassed && session.ID != currentSessionID {
				session.mu.RUnlock()
				continue
			}

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
func handleDescription(w http.ResponseWriter, r *http.Request, config *Config, cwskimmerConfig *CWSkimmerConfig, sessions *SessionManager, instanceReporter *InstanceReporter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// Calculate available client slots (max - current non-bypassed users)
	currentNonBypassedUsers := sessions.GetNonBypassedUserCount()
	availableClients := config.Server.MaxSessions - currentNonBypassedUsers
	if availableClients < 0 {
		availableClients = 0
	}

	// Construct public_url from instance connection info
	// Use effective host from instance reporter if available (for use_myip feature)
	var publicURL string
	if instanceReporter != nil {
		publicURL = config.InstanceReporting.ConstructPublicURL(instanceReporter.GetEffectiveHost())
	} else {
		publicURL = config.InstanceReporting.ConstructPublicURL()
	}

	// Build list of public IQ modes (modes that don't require authentication)
	publicIQModes := []string{}
	wideIQModes := []string{"iq48", "iq96", "iq192", "iq384"}
	for _, mode := range wideIQModes {
		if config.Server.PublicIQModes[mode] {
			publicIQModes = append(publicIQModes, mode)
		}
	}

	// Get public_uuid from instance reporter if available
	publicUUID := ""
	if instanceReporter != nil {
		status := instanceReporter.GetReportStatus()
		if uuid, ok := status["public_uuid"].(string); ok {
			publicUUID = uuid
		}
	}

	// Build the response with description plus status information (without sdrs)
	response := map[string]interface{}{
		"description": config.Admin.Description,
		"receiver": map[string]interface{}{
			"name":       config.Admin.Name,
			"callsign":   config.Admin.Callsign,
			"public_url": publicURL,
			"gps": map[string]interface{}{
				"lat": config.Admin.GPS.Lat,
				"lon": config.Admin.GPS.Lon,
			},
			"asl":      config.Admin.ASL,
			"location": config.Admin.Location,
		},
		"max_clients":          config.Server.MaxSessions,
		"available_clients":    availableClients,
		"max_session_time":     config.Server.MaxSessionTime,
		"version":              Version,
		"space_weather":        config.SpaceWeather.Enabled,
		"noise_floor":          config.NoiseFloor.Enabled,
		"digital_decodes":      config.Decoder.Enabled,
		"cw_skimmer":           cwskimmerConfig.Enabled,
		"public_iq_modes":      publicIQModes,
		"spectrum_poll_period": config.Spectrum.PollPeriodMs,
		"public_uuid":          publicUUID,
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding description: %v", err)
	}
}

// InstanceStatusRequest represents the request body for instance status check
type InstanceStatusRequest struct {
	UUID string `json:"uuid"`
}

// InstanceStatusResponse represents the response for instance status check
type InstanceStatusResponse struct {
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
	TLS  bool   `json:"tls,omitempty"`
}

// handleInstanceStatus checks if instance reporting is enabled and returns connection info
func handleInstanceStatus(w http.ResponseWriter, r *http.Request, config *Config) {
	w.Header().Set("Content-Type", "application/json")

	// Only accept POST requests
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Method not allowed, use POST",
		})
		return
	}

	// Parse request body
	var req InstanceStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Invalid request body",
		})
		return
	}

	// Check if instance reporting is enabled and UUID matches
	if !config.InstanceReporting.Enabled ||
		config.InstanceReporting.InstanceUUID == "" ||
		config.InstanceReporting.InstanceUUID != req.UUID {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Instance not found",
		})
		return
	}

	// Return instance connection info
	response := InstanceStatusResponse{
		Host: config.InstanceReporting.Instance.Host,
		Port: config.InstanceReporting.Instance.Port,
		TLS:  config.InstanceReporting.Instance.TLS,
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
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

	// Only trust X-Real-IP if request comes from tunnel server
	// This prevents clients from spoofing their IP via X-Real-IP header
	if globalConfig != nil && globalConfig.InstanceReporting.IsTunnelServer(sourceIP) {
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			clientIP = strings.TrimSpace(xri)
			// Strip port if present
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
			if DebugMode {
				log.Printf("DEBUG: Trusted X-Real-IP from tunnel server: sourceIP=%s, X-Real-IP=%s, clientIP=%s", sourceIP, xri, clientIP)
			}
			return clientIP
		}
	}

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

// handleNoiseFloorTrends serves 24 hours of noise floor data for all bands averaged in 10-minute chunks
// This is more efficient than calling /api/noisefloor/trend for each band individually
func handleNoiseFloorTrends(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
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

	// Check rate limit (1 request per 2 seconds per IP, using "trends" as key)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "trends") {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Trends endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	measurements, err := nfm.GetTrendDataAllBands()
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
		log.Printf("Error encoding trends noise floor data: %v", err)
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

// handleNoiseFloorWideBandFFT serves the latest wide-band FFT data (0-30 MHz)
func handleNoiseFloorWideBandFFT(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
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

	// Check rate limit (1 request per 2 seconds per IP for wide-band)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "wideband") {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded for wide-band spectrum. Please wait 2 seconds between requests.",
		})
		log.Printf("Wide-band FFT rate limit exceeded for IP: %s", clientIP)
		return
	}

	fft := nfm.GetWideBandFFT()
	if fft == nil {
		// Return 204 No Content - data not available yet but will be soon
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No wide-band FFT data available yet. Data will be available after the first spectrum samples are collected.",
		})
		if DebugMode {
			log.Printf("DEBUG: Wide-band FFT request returned no data (buffer may be empty or averaging window too short)")
		}
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(fft); err != nil {
		log.Printf("Error encoding wide-band FFT data: %v", err)
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

// handleNoiseFloorHealth serves the health status of the noise floor monitor
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func handleNoiseFloorHealth(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor) {
	w.Header().Set("Content-Type", "application/json")

	// Get detailed diagnostics if requested
	detailed := r.URL.Query().Get("detailed") == "true"

	if detailed {
		diagnostics := nfm.GetStartupDiagnostics()
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(diagnostics); err != nil {
			log.Printf("Error encoding noise floor diagnostics: %v", err)
		}
		return
	}

	// Return health status
	status := nfm.GetHealthStatus()

	// Set appropriate HTTP status code
	if status.Healthy {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding noise floor health status: %v", err)
	}
}

// handleSpaceWeatherHealth serves the health status of the space weather monitor
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func handleSpaceWeatherHealth(w http.ResponseWriter, r *http.Request, swm *SpaceWeatherMonitor) {
	w.Header().Set("Content-Type", "application/json")

	// Get detailed diagnostics if requested
	detailed := r.URL.Query().Get("detailed") == "true"

	if detailed {
		diagnostics := swm.GetStartupDiagnostics()
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(diagnostics); err != nil {
			log.Printf("Error encoding space weather diagnostics: %v", err)
		}
		return
	}

	// Return health status
	status := swm.GetHealthStatus()

	// Set appropriate HTTP status code
	if status.Healthy {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding space weather health status: %v", err)
	}
}

// handleDecoderHealth serves the health status of the decoder system
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func handleDecoderHealth(w http.ResponseWriter, r *http.Request, md *MultiDecoder) {
	w.Header().Set("Content-Type", "application/json")

	// Get detailed diagnostics if requested
	detailed := r.URL.Query().Get("detailed") == "true"

	if detailed {
		diagnostics := md.GetStartupDiagnostics()
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(diagnostics); err != nil {
			log.Printf("Error encoding decoder diagnostics: %v", err)
		}
		return
	}

	// Return health status
	status := md.GetHealthStatus()

	// Set appropriate HTTP status code
	if status.Healthy {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding decoder health status: %v", err)
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

// handleDecoderSpots serves historical decoder spots data
func handleDecoderSpots(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// Get query parameters
	mode := r.URL.Query().Get("mode")                   // FT8, FT4, WSPR, or empty for all
	band := r.URL.Query().Get("band")                   // Calculated band (e.g., "20m", "40m") or empty for all
	name := r.URL.Query().Get("name")                   // Decoder config name or empty for all
	callsign := r.URL.Query().Get("callsign")           // Exact callsign match or empty for all
	locator := r.URL.Query().Get("locator")             // Exact locator match or empty for all
	continent := r.URL.Query().Get("continent")         // Continent code (AF, AS, EU, NA, OC, SA, AN) or empty for all
	direction := r.URL.Query().Get("direction")         // Cardinal direction (N, NE, E, SE, S, SW, W, NW) or empty for all
	fromDate := r.URL.Query().Get("date")               // For backward compatibility
	toDate := r.URL.Query().Get("to_date")              // Optional end date
	startTime := r.URL.Query().Get("start_time")        // Start time (HH:MM) - optional
	endTime := r.URL.Query().Get("end_time")            // End time (HH:MM) - optional
	minDistanceStr := r.URL.Query().Get("min_distance") // Minimum distance in km
	minSNRStr := r.URL.Query().Get("min_snr")           // Minimum SNR in dB

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

	// Hardcode deduplication and locators only to true
	deduplicate := true
	locatorsOnly := md.config.SpotsLogLocatorsOnly

	// Parse minimum distance (default 0 = no filter)
	var minDistanceKm float64
	if minDistanceStr != "" {
		if dist, err := strconv.ParseFloat(minDistanceStr, 64); err == nil && dist >= 0 {
			minDistanceKm = dist
		}
	}

	// Parse minimum SNR (default -999 = no filter)
	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("spots-%s-%s-%s-%s-%s-%s-%s-%s-%d", mode, band, name, callsign, locator, continent, direction, fromDate, minSNR)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Decoder spots endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get historical spots
	spots, err := md.spotsLogger.GetHistoricalSpots(mode, band, name, callsign, locator, continent, direction, fromDate, toDate, startTime, endTime, deduplicate, locatorsOnly, minDistanceKm, minSNR)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get spots: %v", err),
		})
		return
	}

	if len(spots) == 0 {
		w.WriteHeader(http.StatusNoContent)
		json.NewEncoder(w).Encode(map[string]string{
			"message": "No spots available for the specified parameters",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"spots": spots,
		"count": len(spots),
	}); err != nil {
		log.Printf("Error encoding decoder spots: %v", err)
	}
}

// handleDecoderSpotsDates serves the list of available dates for decoder spots
func handleDecoderSpotsDates(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// Get available dates
	dates, err := md.spotsLogger.GetAvailableDates()
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

// handleDecoderSpotsNames serves the list of available decoder config names
func handleDecoderSpotsNames(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// Get available names
	names, err := md.spotsLogger.GetAvailableNames()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get available names: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"names": names,
	}); err != nil {
		log.Printf("Error encoding available names: %v", err)
	}
}

// handleDecoderSpotsCSV serves raw CSV download for decoder spots
func handleDecoderSpotsCSV(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// Get query parameters (same as JSON endpoint)
	mode := r.URL.Query().Get("mode")
	band := r.URL.Query().Get("band")
	name := r.URL.Query().Get("name")
	callsign := r.URL.Query().Get("callsign")
	locator := r.URL.Query().Get("locator")
	continent := r.URL.Query().Get("continent")
	direction := r.URL.Query().Get("direction")
	fromDate := r.URL.Query().Get("date")
	toDate := r.URL.Query().Get("to_date")
	startTime := r.URL.Query().Get("start_time")
	endTime := r.URL.Query().Get("end_time")
	minDistanceStr := r.URL.Query().Get("min_distance")
	minSNRStr := r.URL.Query().Get("min_snr")

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

	// Hardcode deduplication and locators only to true
	deduplicate := true
	locatorsOnly := md.config.SpotsLogLocatorsOnly

	// Parse minimum distance (default 0 = no filter)
	var minDistanceKm float64
	if minDistanceStr != "" {
		if dist, err := strconv.ParseFloat(minDistanceStr, 64); err == nil && dist >= 0 {
			minDistanceKm = dist
		}
	}

	// Parse minimum SNR (default -999 = no filter)
	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("spots-csv-%s-%s-%s-%s-%s-%s-%s-%s-%d", mode, band, name, callsign, locator, continent, direction, fromDate, minSNR)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Decoder spots CSV endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get CSV data
	csvData, err := md.spotsLogger.GetHistoricalCSV(mode, band, name, callsign, locator, continent, direction, fromDate, toDate, startTime, endTime, deduplicate, locatorsOnly, minDistanceKm, minSNR)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get CSV data: %v", err),
		})
		return
	}

	// Build filename
	filename := fmt.Sprintf("decoder-spots-%s.csv", fromDate)
	if toDate != "" && toDate != fromDate {
		filename = fmt.Sprintf("decoder-spots-%s-to-%s.csv", fromDate, toDate)
	}
	if mode != "" {
		filename = fmt.Sprintf("decoder-spots-%s-%s.csv", mode, fromDate)
	}
	if band != "" {
		filename = fmt.Sprintf("decoder-spots-%s-%s.csv", band, fromDate)
	}

	// Set headers for CSV download
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
	w.WriteHeader(http.StatusOK)

	// Write CSV data
	if _, err := w.Write([]byte(csvData)); err != nil {
		log.Printf("Error writing CSV data: %v", err)
	}
}

// handleDecoderSpotsAnalytics serves aggregated analytics about decoder spots
func handleDecoderSpotsAnalytics(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// Get query parameters
	country := r.URL.Query().Get("country")
	continent := r.URL.Query().Get("continent")
	mode := r.URL.Query().Get("mode")
	band := r.URL.Query().Get("band")
	minSNRStr := r.URL.Query().Get("min_snr")
	hoursStr := r.URL.Query().Get("hours")

	// Parse minimum SNR (default -999 = no filter)
	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Parse hours (default 24, max 48)
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 48 { // Max 48 hours
			hours = h
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("analytics-%s-%s-%s-%s-%d-%d", country, continent, mode, band, minSNR, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Decoder spots analytics endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get analytics
	analytics, err := md.spotsLogger.GetSpotsAnalytics(country, continent, mode, band, minSNR, hours)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get analytics: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(analytics); err != nil {
		log.Printf("Error encoding decoder spots analytics: %v", err)
	}
}

// handleDecoderSpotsAnalyticsHourly serves aggregated analytics about decoder spots broken down by hour
func handleDecoderSpotsAnalyticsHourly(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// Get query parameters
	country := r.URL.Query().Get("country")
	continent := r.URL.Query().Get("continent")
	mode := r.URL.Query().Get("mode")
	band := r.URL.Query().Get("band")
	minSNRStr := r.URL.Query().Get("min_snr")
	hoursStr := r.URL.Query().Get("hours")

	// Parse minimum SNR (default -999 = no filter)
	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Parse hours (default 24, max 48)
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 48 { // Max 48 hours
			hours = h
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("analytics-hourly-%s-%s-%s-%s-%d-%d", country, continent, mode, band, minSNR, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Decoder spots analytics hourly endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get hourly analytics
	analytics, err := md.spotsLogger.GetSpotsAnalyticsHourly(country, continent, mode, band, minSNR, hours)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get hourly analytics: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(analytics); err != nil {
		log.Printf("Error encoding decoder spots hourly analytics: %v", err)
	}
}

// handleBandPredictions serves band opening predictions with space weather context
func handleBandPredictions(w http.ResponseWriter, r *http.Request, md *MultiDecoder, swm *SpaceWeatherMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	if swm == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Space weather monitoring is not enabled",
		})
		return
	}

	// Parse query parameters
	country := r.URL.Query().Get("country")
	continent := r.URL.Query().Get("continent")
	mode := r.URL.Query().Get("mode")
	hoursStr := r.URL.Query().Get("hours")

	// Parse hours (default 24, max 168 = 7 days)
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 168 {
			hours = h
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("predictions-%s-%s-%s-%d", country, continent, mode, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("Band predictions endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get predictions
	predictions, err := GetBandPredictions(
		md.spotsLogger,
		swm,
		country,
		continent,
		mode,
		hours,
	)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get predictions: %v", err),
		})
		log.Printf("Error getting band predictions: %v", err)
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(predictions); err != nil {
		log.Printf("Error encoding band predictions: %v", err)
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

// handleCWSpotsAnalytics serves aggregated analytics about CW Skimmer spots
func handleCWSpotsAnalytics(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter, ctyDatabase *CTYDatabase) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil || !cwSkimmer.spotsLogger.enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW Skimmer spots logging is not enabled",
		})
		return
	}

	// Get query parameters
	country := r.URL.Query().Get("country")
	continent := r.URL.Query().Get("continent")
	band := r.URL.Query().Get("band")
	minSNRStr := r.URL.Query().Get("min_snr")
	hoursStr := r.URL.Query().Get("hours")

	// Parse minimum SNR (default -999 = no filter)
	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Parse hours (default 24, max 48)
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 48 { // Max 48 hours
			hours = h
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-analytics-%s-%s-%s-%d-%d", country, continent, band, minSNR, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("CW spots analytics endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get analytics
	analytics, err := cwSkimmer.spotsLogger.GetCWSpotsAnalytics(country, continent, band, minSNR, hours, ctyDatabase)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get analytics: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(analytics); err != nil {
		log.Printf("Error encoding CW spots analytics: %v", err)
	}
}

// handleCWSpotsAnalyticsHourly serves aggregated analytics about CW Skimmer spots broken down by hour
func handleCWSpotsAnalyticsHourly(w http.ResponseWriter, r *http.Request, cwSkimmer *CWSkimmerClient, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter, ctyDatabase *CTYDatabase) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if cwSkimmer == nil || cwSkimmer.spotsLogger == nil || !cwSkimmer.spotsLogger.enabled {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "CW Skimmer spots logging is not enabled",
		})
		return
	}

	// Get query parameters
	country := r.URL.Query().Get("country")
	continent := r.URL.Query().Get("continent")
	band := r.URL.Query().Get("band")
	minSNRStr := r.URL.Query().Get("min_snr")
	hoursStr := r.URL.Query().Get("hours")

	// Parse minimum SNR (default -999 = no filter)
	minSNR := -999
	if minSNRStr != "" {
		if snr, err := strconv.Atoi(minSNRStr); err == nil {
			minSNR = snr
		}
	}

	// Parse hours (default 24, max 48)
	hours := 24
	if hoursStr != "" {
		if h, err := strconv.Atoi(hoursStr); err == nil && h > 0 && h <= 48 { // Max 48 hours
			hours = h
		}
	}

	// Check rate limit (1 request per 2 seconds per IP)
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("cw-analytics-hourly-%s-%s-%s-%d-%d", country, continent, band, minSNR, hours)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait 2 seconds between requests.",
		})
		log.Printf("CW spots analytics hourly endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// Get hourly analytics
	analytics, err := cwSkimmer.spotsLogger.GetCWSpotsAnalyticsHourly(country, continent, band, minSNR, hours, ctyDatabase)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to get hourly analytics: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(analytics); err != nil {
		log.Printf("Error encoding CW spots hourly analytics: %v", err)
	}
}
