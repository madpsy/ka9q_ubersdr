package main

import (
	"bytes"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
)

const Version = "0.1.0"

// Instance represents an UberSDR instance
type Instance struct {
	SecretUUID          string             `json:"-"`  // Secret UUID (not exposed in API)
	PublicUUID          string             `json:"id"` // Public UUID for API access
	Callsign            string             `json:"callsign"`
	Name                string             `json:"name"`
	Location            string             `json:"location"`
	Latitude            float64            `json:"latitude"`
	Longitude           float64            `json:"longitude"`
	Altitude            int                `json:"altitude"`
	Maidenhead          string             `json:"maidenhead"` // 6-character Maidenhead locator
	PublicURL           string             `json:"public_url"`
	Version             string             `json:"version"`
	CPUModel            string             `json:"cpu_model"` // CPU model name
	CPUCores            int                `json:"cpu_cores"` // Number of CPU cores
	Host                string             `json:"host,omitempty"`
	Port                int                `json:"port,omitempty"`
	TLS                 bool               `json:"tls,omitempty"`
	CWSkimmer           bool               `json:"cw_skimmer"`
	DigitalDecodes      bool               `json:"digital_decodes"`
	NoiseFloor          bool               `json:"noise_floor"`
	MaxClients          int                `json:"max_clients"`
	AvailableClients    int                `json:"available_clients"`               // Current number of available client slots
	MaxSessionTime      int                `json:"max_session_time"`                // Maximum session time in seconds (0 = unlimited)
	PublicIQModes       []string           `json:"public_iq_modes"`                 // List of IQ modes accessible without authentication
	HasSubdomain        bool               `json:"-"`                               // Whether this instance has a DNS subdomain (not exposed in API)
	ReporterIP          string             `json:"-"`                               // IP address that last reported this instance (not exposed in API)
	SuccessfulCallbacks int                `json:"successful_callbacks"`            // Number of successful verification callbacks
	BandConditions      map[string]float64 `json:"band_conditions,omitempty"`       // Band name to FT8 SNR mapping (only included with conditions=true)
	ConditionsUpdatedAt string             `json:"conditions_updated_at,omitempty"` // Timestamp of band conditions (only included with conditions=true)
	FirstSeen           time.Time          `json:"first_seen"`
	LastSeen            time.Time          `json:"last_seen"`
	LastReportAge       int64              `json:"last_report_age_seconds"` // Computed field
}

// InstanceUpdate represents the data received from an instance
type InstanceUpdate struct {
	UUID             string   `json:"uuid"`
	Callsign         string   `json:"callsign"`
	Name             string   `json:"name"`
	Email            string   `json:"email"`             // Admin email address (private, for Let's Encrypt)
	Location         string   `json:"location"`
	Latitude         float64  `json:"latitude"`
	Longitude        float64  `json:"longitude"`
	Altitude         int      `json:"altitude"`
	PublicURL        string   `json:"public_url"`
	Version          string   `json:"version"`
	CPUModel         string   `json:"cpu_model"` // CPU model name
	CPUCores         int      `json:"cpu_cores"` // Number of CPU cores
	Timestamp        int64    `json:"timestamp"`
	Host             string   `json:"host"`
	Port             int      `json:"port"`
	TLS              bool     `json:"tls"`
	CWSkimmer        bool     `json:"cw_skimmer"`
	DigitalDecodes   bool     `json:"digital_decodes"`
	NoiseFloor       bool     `json:"noise_floor"`
	MaxClients       int      `json:"max_clients"`
	AvailableClients int      `json:"available_clients"` // Current number of available client slots
	MaxSessionTime   int      `json:"max_session_time"`  // Maximum session time in seconds (0 = unlimited)
	PublicIQModes    []string `json:"public_iq_modes"`   // List of IQ modes accessible without authentication
	CreateDomain     bool     `json:"create_domain"`     // If true, create a DNS subdomain for this instance
	Test             bool     `json:"test"`              // If true, this is a test report - verify /api/description instead of full callback
}

// InstanceVerificationRequest represents the request to verify an instance
type InstanceVerificationRequest struct {
	UUID string `json:"uuid"`
}

// InstanceVerificationResponse represents the response from instance verification
type InstanceVerificationResponse struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	TLS  bool   `json:"tls"`
}

// Config represents the collector configuration
type Config struct {
	Listen       string         `json:"listen"`
	DatabasePath string         `json:"database_path"`
	PowerDNS     PowerDNSConfig `json:"powerdns"`
}

// Collector manages the instance collection service
type Collector struct {
	db                    *sql.DB
	config                *Config
	activeNoiseFloorFetch map[string]bool      // Track active noise floor fetches by public_uuid
	noiseFloorMutex       sync.Mutex           // Protect the activeNoiseFloorFetch map
	rateLimitMap          map[string]time.Time // Track last POST time per IP
	rateLimitMutex        sync.Mutex           // Protect the rateLimitMap
	getRateLimitMap       map[string]time.Time // Track last GET /api/instances time per IP
	getRateLimitMutex     sync.Mutex           // Protect the getRateLimitMap
}

func main() {
	// Parse command line flags
	configFile := flag.String("config", "config.json", "Path to configuration file")
	listen := flag.String("listen", ":8443", "Listen address (overrides config)")
	dbPath := flag.String("db", "instances.db", "Database path (overrides config)")
	flag.Parse()

	log.Printf("UberSDR Instance Collector v%s", Version)

	// Load configuration
	config := &Config{
		Listen:       ":8443",
		DatabasePath: "instances.db",
	}

	if _, err := os.Stat(*configFile); err == nil {
		data, err := os.ReadFile(*configFile)
		if err != nil {
			log.Fatalf("Failed to read config file: %v", err)
		}
		if err := json.Unmarshal(data, config); err != nil {
			log.Fatalf("Failed to parse config file: %v", err)
		}
		log.Printf("Loaded configuration from %s", *configFile)
	}

	// Command line flags override config file
	if *listen != ":8443" {
		config.Listen = *listen
	}
	if *dbPath != "instances.db" {
		config.DatabasePath = *dbPath
	}

	// Initialize database
	db, err := initDatabase(config.DatabasePath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	collector := &Collector{
		db:                    db,
		config:                config,
		activeNoiseFloorFetch: make(map[string]bool),
		rateLimitMap:          make(map[string]time.Time),
		getRateLimitMap:       make(map[string]time.Time),
	}

	// Test PowerDNS connectivity if enabled
	if config.PowerDNS.Enabled {
		if err := collector.testPowerDNSConnection(); err != nil {
			log.Printf("WARNING: PowerDNS connectivity test failed: %v", err)
			log.Printf("PowerDNS is enabled but not accessible - DNS operations will fail")
		}
	}

	// Start background cleanup for rate limit maps
	go collector.cleanupRateLimitMap()
	go collector.cleanupGetRateLimitMap()

	// Start background cleanup goroutine
	go collector.cleanupStaleInstances()

	// Setup HTTP routes with logging middleware
	http.HandleFunc("/api/instance/", loggingMiddleware(collector.handleInstanceUpdate))
	http.HandleFunc("/api/instances", loggingMiddleware(collector.handleListInstances))
	http.HandleFunc("/api/instances/", loggingMiddleware(collector.handleGetInstance))
	http.HandleFunc("/api/lookup/", loggingMiddleware(collector.handleLookupPublicUUID))
	http.HandleFunc("/api/noisefloor/", loggingMiddleware(collector.handleGetNoiseFloor))
	http.HandleFunc("/api/myip", loggingMiddleware(handleMyIP))
	http.HandleFunc("/health", loggingMiddleware(handleHealth))

	// Serve static files
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", fs)

	// Start HTTP server
	server := &http.Server{
		Addr:         config.Listen,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Handle graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
		<-sigChan

		log.Println("Shutting down server...")
		if err := server.Close(); err != nil {
			log.Printf("Error closing server: %v", err)
		}
	}()

	// Start server
	log.Printf("Server listening on %s", config.Listen)
	log.Printf("Database: %s", config.DatabasePath)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Server stopped")
}

// initDatabase initializes the SQLite database
func initDatabase(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Create instances table
	schema := `
	CREATE TABLE IF NOT EXISTS instances (
		secret_uuid TEXT PRIMARY KEY,
		public_uuid TEXT UNIQUE NOT NULL,
		callsign TEXT NOT NULL,
		name TEXT NOT NULL,
		location TEXT NOT NULL,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		altitude INTEGER NOT NULL,
		public_url TEXT NOT NULL,
		version TEXT NOT NULL,
		cpu_model TEXT DEFAULT '',
		cpu_cores INTEGER DEFAULT 0,
		host TEXT,
		port INTEGER,
		tls BOOLEAN,
		cw_skimmer BOOLEAN DEFAULT 0,
		digital_decodes BOOLEAN DEFAULT 0,
		noise_floor BOOLEAN DEFAULT 0,
		max_clients INTEGER DEFAULT 0,
		available_clients INTEGER DEFAULT 0,
		max_session_time INTEGER DEFAULT 0,
		public_iq_modes TEXT DEFAULT '[]',
		has_subdomain BOOLEAN DEFAULT 0,
		reporter_ip TEXT,
		email TEXT DEFAULT '',
		successful_callbacks INTEGER DEFAULT 0,
		first_seen DATETIME NOT NULL,
		last_seen DATETIME NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_public_uuid ON instances(public_uuid);
	CREATE INDEX IF NOT EXISTS idx_last_seen ON instances(last_seen);
	CREATE INDEX IF NOT EXISTS idx_reporter_ip ON instances(reporter_ip);
	CREATE INDEX IF NOT EXISTS idx_successful_callbacks ON instances(successful_callbacks);
	
	CREATE TABLE IF NOT EXISTS noise_floor_data (
		public_uuid TEXT PRIMARY KEY,
		data TEXT NOT NULL,
		updated_at DATETIME NOT NULL,
		FOREIGN KEY (public_uuid) REFERENCES instances(public_uuid) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_noise_floor_updated ON noise_floor_data(updated_at);
	`

	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("failed to create schema: %w", err)
	}

	// Migration: Add has_subdomain column if it doesn't exist (for existing databases)
	// Check if column exists
	var columnExists bool
	migErr := db.QueryRow(`
		SELECT COUNT(*) > 0
		FROM pragma_table_info('instances')
		WHERE name='has_subdomain'
	`).Scan(&columnExists)
	
	if migErr != nil {
		log.Printf("Warning: Failed to check for has_subdomain column: %v", migErr)
	} else if !columnExists {
		log.Println("Migrating database: Adding has_subdomain column...")
		_, migErr = db.Exec(`ALTER TABLE instances ADD COLUMN has_subdomain BOOLEAN DEFAULT 0`)
		if migErr != nil {
			return nil, fmt.Errorf("failed to add has_subdomain column: %w", migErr)
		}
		log.Println("Database migration completed: has_subdomain column added")
	}

	// Migration: Add email column if it doesn't exist (for existing databases)
	var emailColumnExists bool
	emailMigErr := db.QueryRow(`
		SELECT COUNT(*) > 0
		FROM pragma_table_info('instances')
		WHERE name='email'
	`).Scan(&emailColumnExists)
	
	if emailMigErr != nil {
		log.Printf("Warning: Failed to check for email column: %v", emailMigErr)
	} else if !emailColumnExists {
		log.Println("Migrating database: Adding email column...")
		_, emailMigErr = db.Exec(`ALTER TABLE instances ADD COLUMN email TEXT DEFAULT ''`)
		if emailMigErr != nil {
			return nil, fmt.Errorf("failed to add email column: %w", emailMigErr)
		}
		log.Println("Database migration completed: email column added")
	}

	log.Println("Database initialized successfully")
	return db, nil
}

// latLonToMaidenhead converts latitude and longitude to a 6-character Maidenhead locator
func latLonToMaidenhead(lat, lon float64) string {
	// Adjust longitude to 0-360 range
	lon += 180.0
	lat += 90.0

	// Field (first pair) - 20 degrees longitude, 10 degrees latitude
	field1 := int(lon / 20.0)
	field2 := int(lat / 10.0)

	// Square (second pair) - 2 degrees longitude, 1 degree latitude
	lon -= float64(field1) * 20.0
	lat -= float64(field2) * 10.0
	square1 := int(lon / 2.0)
	square2 := int(lat / 1.0)

	// Subsquare (third pair) - 5 minutes (1/12 degree) longitude, 2.5 minutes (1/24 degree) latitude
	lon -= float64(square1) * 2.0
	lat -= float64(square2) * 1.0
	subsquare1 := int(lon * 12.0)
	subsquare2 := int(lat * 24.0)

	// Build the 6-character locator
	return fmt.Sprintf("%c%c%d%d%c%c",
		'A'+field1,
		'A'+field2,
		square1,
		square2,
		'a'+subsquare1,
		'a'+subsquare2,
	)
}

// loggingMiddleware logs all HTTP requests
func loggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Create a response writer wrapper to capture status code
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		// Call the next handler
		next(wrapped, r)

		// Get the real client IP, checking X-Forwarded-For header
		clientIP := getClientIP(r)

		// Log the request
		duration := time.Since(start)
		log.Printf("%s %s %d %s %s",
			r.Method,
			r.URL.Path,
			wrapped.statusCode,
			duration,
			clientIP,
		)
	}
}

// getClientIP extracts the real client IP from the request
// Checks X-Forwarded-For header first (for proxied requests), then falls back to RemoteAddr
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header (standard for proxies/load balancers)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// X-Forwarded-For can contain multiple IPs (client, proxy1, proxy2, ...)
		// The first IP is the original client
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}

	// Check X-Real-IP header (alternative used by some proxies)
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}

	// Fall back to RemoteAddr
	return r.RemoteAddr
}

// validatePublicHost checks if a host is a publicly accessible address
// Rejects local, private, loopback, link-local, and other reserved addresses
func validatePublicHost(host string) error {
	if host == "" {
		return fmt.Errorf("host cannot be empty")
	}

	// Resolve the host to IP addresses
	ips, err := net.LookupIP(host)
	if err != nil {
		// If it doesn't resolve, try parsing it as an IP directly
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("invalid host: cannot resolve or parse as IP")
		}
		ips = []net.IP{ip}
	}

	// Check each resolved IP
	for _, ip := range ips {
		if !isPublicIP(ip) {
			return fmt.Errorf("host resolves to non-public IP address: %s", ip.String())
		}
	}

	return nil
}

// isPublicIP checks if an IP address is publicly routable
// Returns false for private, loopback, link-local, multicast, and other reserved addresses
func isPublicIP(ip net.IP) bool {
	// Check for IPv4 private/reserved ranges
	if ip.To4() != nil {
		// Loopback (127.0.0.0/8)
		if ip.IsLoopback() {
			return false
		}
		// Private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
		if ip.IsPrivate() {
			return false
		}
		// Link-local (169.254.0.0/16)
		if ip.IsLinkLocalUnicast() {
			return false
		}
		// Multicast (224.0.0.0/4)
		if ip.IsMulticast() {
			return false
		}
		// Broadcast and other reserved
		if ip.Equal(net.IPv4bcast) || ip.Equal(net.IPv4zero) {
			return false
		}
		// Check for additional reserved ranges
		// 0.0.0.0/8 (current network)
		if ip[0] == 0 {
			return false
		}
		// 100.64.0.0/10 (shared address space / carrier-grade NAT)
		if ip[0] == 100 && (ip[1]&0xC0) == 64 {
			return false
		}
		// 192.0.0.0/24 (IETF protocol assignments)
		if ip[0] == 192 && ip[1] == 0 && ip[2] == 0 {
			return false
		}
		// 192.0.2.0/24 (TEST-NET-1)
		if ip[0] == 192 && ip[1] == 0 && ip[2] == 2 {
			return false
		}
		// 198.18.0.0/15 (benchmarking)
		if ip[0] == 198 && (ip[1] == 18 || ip[1] == 19) {
			return false
		}
		// 198.51.100.0/24 (TEST-NET-2)
		if ip[0] == 198 && ip[1] == 51 && ip[2] == 100 {
			return false
		}
		// 203.0.113.0/24 (TEST-NET-3)
		if ip[0] == 203 && ip[1] == 0 && ip[2] == 113 {
			return false
		}
		// 240.0.0.0/4 (reserved for future use)
		if ip[0] >= 240 {
			return false
		}
	} else {
		// IPv6 checks
		// Loopback (::1)
		if ip.IsLoopback() {
			return false
		}
		// Link-local (fe80::/10)
		if ip.IsLinkLocalUnicast() {
			return false
		}
		// Multicast (ff00::/8)
		if ip.IsMulticast() {
			return false
		}
		// Unique local addresses (fc00::/7)
		if len(ip) == 16 && (ip[0]&0xFE) == 0xFC {
			return false
		}
		// IPv4-mapped IPv6 addresses (::ffff:0:0/96)
		if ip.To4() != nil {
			return isPublicIP(ip.To4())
		}
		// Unspecified address (::)
		if ip.IsUnspecified() {
			return false
		}
		// Documentation prefix (2001:db8::/32)
		if len(ip) == 16 && ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x0d && ip[3] == 0xb8 {
			return false
		}
	}

	return true
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// validateInstanceUpdate validates the fields of an instance update
func validateInstanceUpdate(update *InstanceUpdate) error {
	// Validate required string fields are not empty
	if strings.TrimSpace(update.Callsign) == "" {
		return fmt.Errorf("callsign is required")
	}
	if strings.TrimSpace(update.Name) == "" {
		return fmt.Errorf("name is required")
	}
	if strings.TrimSpace(update.Location) == "" {
		return fmt.Errorf("location is required")
	}
	if strings.TrimSpace(update.Version) == "" {
		return fmt.Errorf("version is required")
	}

	// Validate string length limits
	if len(update.Callsign) > 10 {
		return fmt.Errorf("callsign too long (max 10 characters)")
	}
	if len(update.Name) > 100 {
		return fmt.Errorf("name too long (max 100 characters)")
	}
	if len(update.Location) > 100 {
		return fmt.Errorf("location too long (max 100 characters)")
	}
	if len(update.Version) > 10 {
		return fmt.Errorf("version too long (max 10 characters)")
	}

	// Validate coordinate ranges
	if update.Latitude < -90 || update.Latitude > 90 {
		return fmt.Errorf("latitude must be between -90 and 90 (got %.6f)", update.Latitude)
	}
	if update.Longitude < -180 || update.Longitude > 180 {
		return fmt.Errorf("longitude must be between -180 and 180 (got %.6f)", update.Longitude)
	}

	// Validate altitude range (reasonable values)
	if update.Altitude < -500 || update.Altitude > 10000 {
		return fmt.Errorf("altitude must be between -500 and 10000 meters (got %d)", update.Altitude)
	}

	// Validate public URL if provided
	if update.PublicURL != "" {
		parsedURL, err := url.Parse(update.PublicURL)
		if err != nil {
			return fmt.Errorf("invalid public_url format: %v", err)
		}
		if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
			return fmt.Errorf("public_url must use http or https scheme")
		}
		if parsedURL.Host == "" {
			return fmt.Errorf("public_url must have a valid host")
		}
		if len(update.PublicURL) > 100 {
			return fmt.Errorf("public_url too long (max 100 characters)")
		}
	}

	return nil
}

// handleInstanceUpdate handles POST requests from instances
func (c *Collector) handleInstanceUpdate(w http.ResponseWriter, r *http.Request) {
	// Helper function to send JSON error responses
	sendError := func(statusCode int, message string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "error",
			"message": message,
		})
	}

	if r.Method != http.MethodPost {
		sendError(http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	// Extract secret UUID from URL path
	// URL format: /api/instance/{uuid}
	secretUUID := r.URL.Path[len("/api/instance/"):]
	if secretUUID == "" {
		sendError(http.StatusBadRequest, "Missing instance UUID")
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(secretUUID); err != nil {
		sendError(http.StatusBadRequest, "Invalid UUID format")
		return
	}

	// Parse request body
	var update InstanceUpdate
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		sendError(http.StatusBadRequest, "Invalid request body")
		return
	}

	// Verify UUID in body matches URL
	if update.UUID != secretUUID {
		sendError(http.StatusBadRequest, "UUID mismatch")
		return
	}

	// Validate field values
	if err := validateInstanceUpdate(&update); err != nil {
		sendError(http.StatusBadRequest, fmt.Sprintf("Validation error: %v", err))
		return
	}

	// Validate that the host is not a local/reserved address
	if err := validatePublicHost(update.Host); err != nil {
		log.Printf("Host validation failed for %s: %v", secretUUID, err)
		sendError(http.StatusBadRequest, fmt.Sprintf("Host validation error: %v", err))
		return
	}

	// Get the client IP for tracking
	clientIP := getClientIP(r)

	// Check rate limit - only allow one POST per IP per 10 seconds
	if !c.checkRateLimit(clientIP) {
		log.Printf("Rate limit exceeded for IP: %s (instance: %s)", clientIP, secretUUID)
		sendError(http.StatusTooManyRequests, "Rate limit exceeded - only one instance update per 10 seconds allowed")
		return
	}

	// Verify instance is publicly accessible
	// If create_domain=true, use the source IP for verification (DNS not set up yet)
	// Otherwise use the host field from the JSON
	verifyHost := update.Host
	verifyPort := update.Port
	verifyTLS := update.TLS
	if update.CreateDomain {
		// Validate that the host field matches the expected format: <callsign>.<zone_name>
		if c.config.PowerDNS.Enabled {
			expectedHost := fmt.Sprintf("%s.%s", strings.ToLower(update.Callsign), c.config.PowerDNS.ZoneName)
			if strings.ToLower(update.Host) != expectedHost {
				log.Printf("Host validation failed for %s: expected %s, got %s", secretUUID, expectedHost, update.Host)
				sendError(http.StatusBadRequest, fmt.Sprintf("When create_domain is true, host must be %s", expectedHost))
				return
			}
		}
		
		// Extract IP from clientIP (remove port if present)
		verifyHost = clientIP
		if host, _, err := net.SplitHostPort(clientIP); err == nil {
			verifyHost = host
		}
		// When create_domain is true, always verify on port 80 (HTTP)
		// DNS doesn't exist yet, so no certificate can be obtained for port 443
		verifyPort = 80
		// Ignore TLS errors when create_domain is true (no certificate yet)
		verifyTLS = false
	}
	
	// If test=true, check /api/description endpoint instead of full callback
	if !c.verifyInstanceAccessibility(secretUUID, verifyHost, verifyPort, verifyTLS, update.Test, update.CreateDomain) {
		log.Printf("Instance verification failed: %s (host: %s, port: %d, tls: %v, test: %v, create_domain: %v) from IP: %s",
			secretUUID, verifyHost, update.Port, verifyTLS, update.Test, update.CreateDomain, clientIP)
		sendError(http.StatusBadRequest, "Instance verification failed - not publicly accessible")
		return
	}

	// If this is a test report, return success without storing in database or modifying DNS
	if update.Test {
		log.Printf("Test report successful for %s (host: %s, port: %d, tls: %v, create_domain: %v) from IP: %s",
			secretUUID, update.Host, update.Port, update.TLS, update.CreateDomain, clientIP)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "ok",
			"message": "Test successful - instance is publicly accessible",
		})
		return
	}

	// Check if callsign is already in use by another instance
	var existingCallsignUUID string
	err := c.db.QueryRow("SELECT secret_uuid FROM instances WHERE callsign = ? AND secret_uuid != ?",
		update.Callsign, secretUUID).Scan(&existingCallsignUUID)

	if err == nil {
		// Found an existing instance with the same callsign but different UUID
		log.Printf("Callsign %s already in use by instance %s, rejecting registration for %s", update.Callsign, existingCallsignUUID, secretUUID)
		sendError(http.StatusConflict, fmt.Sprintf("Callsign %s is already registered to another instance", update.Callsign))
		return
	} else if err != sql.ErrNoRows {
		log.Printf("Error checking for existing callsign: %v", err)
		sendError(http.StatusInternalServerError, "Internal server error")
		return
	}

	// Check if another instance already exists with the same host/port combination
	// If so, remove it (it will be replaced by this new UUID)
	var existingSecretUUID string
	err = c.db.QueryRow("SELECT secret_uuid FROM instances WHERE host = ? AND port = ? AND secret_uuid != ?",
		update.Host, update.Port, secretUUID).Scan(&existingSecretUUID)

	if err == nil {
		// Found an existing instance with same host/port but different UUID - remove it
		_, delErr := c.db.Exec("DELETE FROM instances WHERE secret_uuid = ?", existingSecretUUID)
		if delErr != nil {
			log.Printf("Failed to delete existing instance %s with same host/port: %v", existingSecretUUID, delErr)
		} else {
			log.Printf("Removed existing instance %s (same host=%s port=%d) to be replaced by %s",
				existingSecretUUID, update.Host, update.Port, secretUUID)
		}
	} else if err != sql.ErrNoRows {
		log.Printf("Error checking for existing host/port: %v", err)
	}

	// Check if instance exists
	var publicUUID string
	err = c.db.QueryRow("SELECT public_uuid FROM instances WHERE secret_uuid = ?", secretUUID).Scan(&publicUUID)

	now := time.Now()

	if err == sql.ErrNoRows {
		// New instance - generate public UUID
		publicUUID = uuid.New().String()

		// Marshal public_iq_modes to JSON
		publicIQModesJSON, err := json.Marshal(update.PublicIQModes)
		if err != nil {
			log.Printf("Failed to marshal public_iq_modes: %v", err)
			sendError(http.StatusInternalServerError, "Internal server error")
			return
		}

		_, err = c.db.Exec(`
			INSERT INTO instances (
				secret_uuid, public_uuid, callsign, name, location,
				latitude, longitude, altitude, public_url, version, cpu_model, cpu_cores,
				host, port, tls,
				cw_skimmer, digital_decodes, noise_floor, max_clients, available_clients, max_session_time,
				public_iq_modes, has_subdomain, reporter_ip, email,
				first_seen, last_seen
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			secretUUID, publicUUID, update.Callsign, update.Name, update.Location,
			update.Latitude, update.Longitude, update.Altitude, update.PublicURL, update.Version, update.CPUModel, update.CPUCores,
			update.Host, update.Port, update.TLS,
			update.CWSkimmer, update.DigitalDecodes, update.NoiseFloor, update.MaxClients, update.AvailableClients, update.MaxSessionTime,
			string(publicIQModesJSON), update.CreateDomain, clientIP, update.Email,
			now, now,
		)

		if err != nil {
			log.Printf("Failed to insert instance: %v", err)
			sendError(http.StatusInternalServerError, "Internal server error")
			return
		}

		log.Printf("New instance registered: %s (public: %s, callsign: %s) from IP: %s", secretUUID, publicUUID, update.Callsign, clientIP)
	} else if err != nil {
		log.Printf("Database error: %v", err)
		sendError(http.StatusInternalServerError, "Internal server error")
		return
	} else {
		// Existing instance - update
		// Marshal public_iq_modes to JSON
		publicIQModesJSON, err := json.Marshal(update.PublicIQModes)
		if err != nil {
			log.Printf("Failed to marshal public_iq_modes: %v", err)
			sendError(http.StatusInternalServerError, "Internal server error")
			return
		}

		_, err = c.db.Exec(`
			UPDATE instances SET
				callsign = ?, name = ?, location = ?,
				latitude = ?, longitude = ?, altitude = ?,
				public_url = ?, version = ?, cpu_model = ?, cpu_cores = ?,
				host = ?, port = ?, tls = ?,
				cw_skimmer = ?, digital_decodes = ?, noise_floor = ?, max_clients = ?, available_clients = ?, max_session_time = ?,
				public_iq_modes = ?, has_subdomain = ?, reporter_ip = ?, email = ?,
				last_seen = ?
			WHERE secret_uuid = ?`,
			update.Callsign, update.Name, update.Location,
			update.Latitude, update.Longitude, update.Altitude,
			update.PublicURL, update.Version, update.CPUModel, update.CPUCores,
			update.Host, update.Port, update.TLS,
			update.CWSkimmer, update.DigitalDecodes, update.NoiseFloor, update.MaxClients, update.AvailableClients, update.MaxSessionTime,
			string(publicIQModesJSON), update.CreateDomain, clientIP, update.Email,
			now,
			secretUUID,
		)

		if err != nil {
			log.Printf("Failed to update instance: %v", err)
			sendError(http.StatusInternalServerError, "Internal server error")
			return
		}

		log.Printf("Instance updated: %s (public: %s, callsign: %s) from IP: %s", secretUUID, publicUUID, update.Callsign, clientIP)
	}

	// Handle PowerDNS domain creation/update/deletion
	// Check if instance previously had a subdomain
	var hadSubdomain bool
	err = c.db.QueryRow("SELECT has_subdomain FROM instances WHERE secret_uuid = ?", secretUUID).Scan(&hadSubdomain)
	if err != nil && err != sql.ErrNoRows {
		log.Printf("Failed to check subdomain status for %s: %v", secretUUID, err)
	}
	
	if update.CreateDomain {
		// Create or update DNS record
		// Use the source IP address of the request for the DNS record
		// This is the same IP we store in reporter_ip field in the database
		// The instance will have host set to <callsign>.instance.ubersdr.org
		sourceIP := clientIP
		if host, _, err := net.SplitHostPort(clientIP); err == nil {
			sourceIP = host
		}
		
		if err := c.createOrUpdateDNSRecord(update.Callsign, sourceIP); err != nil {
			log.Printf("Failed to create/update DNS record for %s to IP %s: %v", update.Callsign, sourceIP, err)
			// Don't fail the entire request if DNS update fails, just log it
		} else {
			log.Printf("DNS record created/updated: %s.%s -> %s", strings.ToLower(update.Callsign), c.config.PowerDNS.ZoneName, sourceIP)
		}
	} else if hadSubdomain {
		// Instance previously had a subdomain but create_domain is now false/missing
		// Delete the DNS record
		if err := c.deleteDNSRecord(update.Callsign); err != nil {
			log.Printf("Failed to delete DNS record for %s: %v", update.Callsign, err)
			// Don't fail the entire request if DNS deletion fails, just log it
		} else {
			log.Printf("DNS record deleted: %s.%s (create_domain disabled)", strings.ToLower(update.Callsign), c.config.PowerDNS.ZoneName)
		}
	}

	// If noise floor is enabled, fetch and store the latest data
	// Only start a new fetch if one isn't already in progress
	if update.NoiseFloor {
		c.noiseFloorMutex.Lock()
		if !c.activeNoiseFloorFetch[publicUUID] {
			c.activeNoiseFloorFetch[publicUUID] = true
			c.noiseFloorMutex.Unlock()
			go c.fetchAndStoreNoiseFloor(publicUUID, update.Host, update.Port, update.TLS)
		} else {
			c.noiseFloorMutex.Unlock()
			log.Printf("Noise floor fetch already in progress for %s, skipping", publicUUID)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":      "ok",
		"public_uuid": publicUUID,
	})
}

// handleListInstances handles GET requests for listing all instances
func (c *Collector) handleListInstances(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get client IP and check rate limit (1 request per second)
	clientIP := getClientIP(r)
	if !c.checkGetRateLimit(clientIP) {
		log.Printf("GET rate limit exceeded for IP: %s", clientIP)
		http.Error(w, "Rate limit exceeded - only one request per second allowed", http.StatusTooManyRequests)
		return
	}

	// Check if conditions parameter is set
	includeConditions := r.URL.Query().Get("conditions") == "true"

	// Query only instances seen in the last 30 minutes with at least 2 successful callbacks
	query := `
		SELECT public_uuid, callsign, name, location, latitude, longitude,
		       altitude, public_url, version, cpu_model, cpu_cores, host, port, tls,
		       cw_skimmer, digital_decodes, noise_floor, max_clients, available_clients, max_session_time,
		       public_iq_modes, reporter_ip, successful_callbacks,
		       first_seen, last_seen
		FROM instances
		WHERE datetime(last_seen) >= datetime('now', '-30 minutes')
		  AND host IS NOT NULL
		  AND host != ''
		  AND port > 0
		  AND successful_callbacks >= 2
		ORDER BY last_seen DESC
	`

	rows, err := c.db.Query(query)
	if err != nil {
		log.Printf("Failed to query instances: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	instances := []Instance{}
	now := time.Now()

	for rows.Next() {
		var inst Instance
		var publicIQModesJSON string
		err := rows.Scan(
			&inst.PublicUUID, &inst.Callsign, &inst.Name, &inst.Location,
			&inst.Latitude, &inst.Longitude, &inst.Altitude, &inst.PublicURL,
			&inst.Version, &inst.CPUModel, &inst.CPUCores, &inst.Host, &inst.Port, &inst.TLS,
			&inst.CWSkimmer, &inst.DigitalDecodes, &inst.NoiseFloor, &inst.MaxClients, &inst.AvailableClients, &inst.MaxSessionTime,
			&publicIQModesJSON, &inst.ReporterIP, &inst.SuccessfulCallbacks,
			&inst.FirstSeen, &inst.LastSeen,
		)
		if err != nil {
			log.Printf("Failed to scan instance: %v", err)
			continue
		}

		// Unmarshal public_iq_modes from JSON
		if err := json.Unmarshal([]byte(publicIQModesJSON), &inst.PublicIQModes); err != nil {
			log.Printf("Failed to unmarshal public_iq_modes for %s: %v", inst.PublicUUID, err)
			inst.PublicIQModes = []string{} // Default to empty array on error
		}

		// Calculate age of last report
		inst.LastReportAge = int64(now.Sub(inst.LastSeen).Seconds())

		// Calculate Maidenhead locator
		inst.Maidenhead = latLonToMaidenhead(inst.Latitude, inst.Longitude)

		// If conditions parameter is set and instance has noise floor enabled, fetch band conditions
		if includeConditions && inst.NoiseFloor {
			conditions, updatedAt := c.getBandConditions(inst.PublicUUID)
			if conditions != nil {
				inst.BandConditions = conditions
				inst.ConditionsUpdatedAt = updatedAt
			}
		}

		instances = append(instances, inst)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"count":     len(instances),
		"instances": instances,
	})
}

// handleGetInstance handles GET requests for a specific instance by public UUID
func (c *Collector) handleGetInstance(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract public UUID from URL path
	// URL format: /api/instances/{public_uuid}
	publicUUID := r.URL.Path[len("/api/instances/"):]
	if publicUUID == "" {
		http.Error(w, "Missing instance UUID", http.StatusBadRequest)
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(publicUUID); err != nil {
		http.Error(w, "Invalid UUID format", http.StatusBadRequest)
		return
	}

	// Check if conditions parameter is set
	includeConditions := r.URL.Query().Get("conditions") == "true"

	var inst Instance
	var publicIQModesJSON string
	err := c.db.QueryRow(`
		SELECT public_uuid, callsign, name, location, latitude, longitude,
		       altitude, public_url, version, cpu_model, cpu_cores, host, port, tls,
		       cw_skimmer, digital_decodes, noise_floor, max_clients, available_clients, max_session_time,
		       public_iq_modes, reporter_ip,
		       first_seen, last_seen
		FROM instances
		WHERE public_uuid = ?
	`, publicUUID).Scan(
		&inst.PublicUUID, &inst.Callsign, &inst.Name, &inst.Location,
		&inst.Latitude, &inst.Longitude, &inst.Altitude, &inst.PublicURL,
		&inst.Version, &inst.CPUModel, &inst.CPUCores, &inst.Host, &inst.Port, &inst.TLS,
		&inst.CWSkimmer, &inst.DigitalDecodes, &inst.NoiseFloor, &inst.MaxClients, &inst.AvailableClients, &inst.MaxSessionTime,
		&publicIQModesJSON, &inst.ReporterIP,
		&inst.FirstSeen, &inst.LastSeen,
	)

	if err == sql.ErrNoRows {
		http.Error(w, "Instance not found", http.StatusNotFound)
		return
	} else if err != nil {
		log.Printf("Failed to query instance: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Unmarshal public_iq_modes from JSON
	if err := json.Unmarshal([]byte(publicIQModesJSON), &inst.PublicIQModes); err != nil {
		log.Printf("Failed to unmarshal public_iq_modes for %s: %v", inst.PublicUUID, err)
		inst.PublicIQModes = []string{} // Default to empty array on error
	}

	// Calculate age of last report
	now := time.Now()
	inst.LastReportAge = int64(now.Sub(inst.LastSeen).Seconds())

	// Calculate Maidenhead locator
	inst.Maidenhead = latLonToMaidenhead(inst.Latitude, inst.Longitude)

	// If conditions parameter is set and instance has noise floor enabled, fetch band conditions
	if includeConditions && inst.NoiseFloor {
		conditions, updatedAt := c.getBandConditions(inst.PublicUUID)
		if conditions != nil {
			inst.BandConditions = conditions
			inst.ConditionsUpdatedAt = updatedAt
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(inst)
}

// handleLookupPublicUUID handles GET requests to lookup public UUID from secret UUID
func (c *Collector) handleLookupPublicUUID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract secret UUID from URL path
	// URL format: /api/lookup/{secret_uuid}
	secretUUID := r.URL.Path[len("/api/lookup/"):]
	if secretUUID == "" {
		http.Error(w, "Missing secret UUID", http.StatusBadRequest)
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(secretUUID); err != nil {
		http.Error(w, "Invalid UUID format", http.StatusBadRequest)
		return
	}

	var publicUUID string
	err := c.db.QueryRow("SELECT public_uuid FROM instances WHERE secret_uuid = ?", secretUUID).Scan(&publicUUID)

	if err == sql.ErrNoRows {
		http.Error(w, "Instance not found", http.StatusNotFound)
		return
	} else if err != nil {
		log.Printf("Failed to lookup instance: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"secret_uuid": secretUUID,
		"public_uuid": publicUUID,
	})
}

// handleHealth handles health check requests
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"version": Version,
	})
}

// handleMyIP returns the requestor's public IPv4 address
func handleMyIP(w http.ResponseWriter, r *http.Request) {
	// Add CORS headers to allow cross-origin requests
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	// Handle preflight OPTIONS request
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get the client IP
	clientIP := getClientIP(r)

	// Parse the IP to extract just the IPv4 address (remove port if present)
	ip := clientIP
	if host, _, err := net.SplitHostPort(clientIP); err == nil {
		ip = host
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"ip": ip,
	})
}

// verifyInstanceAccessibility makes a callback to the instance to verify it's publicly accessible
// If isTest is true, performs a simple GET to /api/description instead of full callback
// If ignoreTLS is true, skips TLS certificate verification (for instances without certs yet)
// Retries up to 3 times with 10 second delays between attempts
func (c *Collector) verifyInstanceAccessibility(secretUUID, host string, port int, useTLS bool, isTest bool, ignoreTLS bool) bool {
	// Skip verification if host or port is invalid
	if host == "" || port == 0 {
		log.Printf("Skipping verification for instance %s: invalid host/port", secretUUID)
		return false
	}

	// Build the URL
	protocol := "http"
	defaultPort := 80
	if useTLS {
		protocol = "https"
		defaultPort = 443
	}

	var url string
	var method string
	var jsonData []byte

	if isTest {
		// Test mode: simple GET to /api/description
		method = "GET"
		if port == defaultPort {
			url = fmt.Sprintf("%s://%s/api/description", protocol, host)
		} else {
			url = fmt.Sprintf("%s://%s:%d/api/description", protocol, host, port)
		}
	} else {
		// Normal mode: POST callback to /api/instance
		method = "POST"
		if port == defaultPort {
			url = fmt.Sprintf("%s://%s/api/instance", protocol, host)
		} else {
			url = fmt.Sprintf("%s://%s:%d/api/instance", protocol, host, port)
		}

		// Create the verification request body
		reqBody := InstanceVerificationRequest{
			UUID: secretUUID,
		}

		var err error
		jsonData, err = json.Marshal(reqBody)
		if err != nil {
			log.Printf("Failed to marshal verification request: %v", err)
			return false
		}
	}

	// Create HTTP client with timeout and TLS config
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: ignoreTLS, // Skip verification if ignoreTLS is true (for new domains without certs)
				MinVersion:         tls.VersionTLS12,
			},
		},
	}

	// Retry up to 3 times with 10 second delays
	maxRetries := 3
	retryDelay := 10 * time.Second

	for attempt := 1; attempt <= maxRetries; attempt++ {
		// Create request
		var req *http.Request
		var err error
		if isTest {
			req, err = http.NewRequest(method, url, nil)
		} else {
			req, err = http.NewRequest(method, url, bytes.NewBuffer(jsonData))
		}

		if err != nil {
			log.Printf("Failed to create verification request (attempt %d/%d): %v", attempt, maxRetries, err)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return false
		}

		if !isTest {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("User-Agent", fmt.Sprintf("UberSDR-Collector/%s", Version))

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("Failed to verify instance %s at %s (attempt %d/%d): %v", secretUUID, url, attempt, maxRetries, err)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return false
		}
		defer resp.Body.Close()

		// Check response status
		if resp.StatusCode != http.StatusOK {
			log.Printf("Instance verification returned status %d for %s (attempt %d/%d)", resp.StatusCode, secretUUID, attempt, maxRetries)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return false
		}

		if isTest {
			// Test mode: verify /api/description response has required fields
			var descResp map[string]interface{}
			if err := json.NewDecoder(resp.Body).Decode(&descResp); err != nil {
				log.Printf("Failed to decode /api/description response (attempt %d/%d): %v", attempt, maxRetries, err)
				if attempt < maxRetries {
					time.Sleep(retryDelay)
					continue
				}
				return false
			}

			// Check for required fields in receiver section
			receiver, ok := descResp["receiver"].(map[string]interface{})
			if !ok {
				log.Printf("Test verification failed: no receiver section in /api/description (attempt %d/%d)", attempt, maxRetries)
				if attempt < maxRetries {
					time.Sleep(retryDelay)
					continue
				}
				return false
			}

			// Verify required fields exist
			requiredFields := []string{"callsign", "name"}
			for _, field := range requiredFields {
				if _, ok := receiver[field]; !ok {
					log.Printf("Test verification failed: missing required field '%s' in receiver section (attempt %d/%d)", field, attempt, maxRetries)
					if attempt < maxRetries {
						time.Sleep(retryDelay)
						continue
					}
					return false
				}
			}

			// Check for version field at top level
			if _, ok := descResp["version"]; !ok {
				log.Printf("Test verification failed: missing version field (attempt %d/%d)", attempt, maxRetries)
				if attempt < maxRetries {
					time.Sleep(retryDelay)
					continue
				}
				return false
			}

			log.Printf("Test verification successful for %s at %s (attempt %d)", secretUUID, url, attempt)
			return true
		} else {
			// Normal mode: verify callback response
			var verifyResp InstanceVerificationResponse
			if err := json.NewDecoder(resp.Body).Decode(&verifyResp); err != nil {
				log.Printf("Failed to decode verification response (attempt %d/%d): %v", attempt, maxRetries, err)
				if attempt < maxRetries {
					time.Sleep(retryDelay)
					continue
				}
				return false
			}

			// When ignoreTLS is true (create_domain mode), skip response validation
			// The instance will return its final configuration (subdomain, port 443, TLS true)
			// but we verified using temporary parameters (IP, port 80, TLS false)
			if !ignoreTLS {
				// Verify the response matches what we expect
				if verifyResp.Host != host || verifyResp.Port != port || verifyResp.TLS != useTLS {
					log.Printf("Instance verification mismatch for %s (attempt %d/%d): expected host=%s port=%d tls=%v, got host=%s port=%d tls=%v",
						secretUUID, attempt, maxRetries, host, port, useTLS, verifyResp.Host, verifyResp.Port, verifyResp.TLS)
					if attempt < maxRetries {
						time.Sleep(retryDelay)
						continue
					}
					return false
				}
			}

			log.Printf("Instance %s verified successfully at %s (attempt %d)", secretUUID, url, attempt)

			// Increment successful_callbacks counter in database
			_, err = c.db.Exec("UPDATE instances SET successful_callbacks = successful_callbacks + 1 WHERE secret_uuid = ?", secretUUID)
			if err != nil {
				log.Printf("Failed to increment successful_callbacks for %s: %v", secretUUID, err)
			}

			return true
		}
	}

	return false
}

// fetchAndStoreNoiseFloor fetches noise floor data from an instance and stores it
// Retries up to 3 times with 30 second delays between attempts
func (c *Collector) fetchAndStoreNoiseFloor(publicUUID, host string, port int, useTLS bool) {
	// Ensure we clear the active fetch flag when done
	defer func() {
		c.noiseFloorMutex.Lock()
		delete(c.activeNoiseFloorFetch, publicUUID)
		c.noiseFloorMutex.Unlock()
	}()

	// Skip if host or port is invalid
	if host == "" || port == 0 {
		return
	}

	// Build the noise floor URL
	protocol := "http"
	defaultPort := 80
	if useTLS {
		protocol = "https"
		defaultPort = 443
	}

	// Omit port if it's the default for the protocol
	var noiseFloorURL string
	if port == defaultPort {
		noiseFloorURL = fmt.Sprintf("%s://%s/api/noisefloor/latest", protocol, host)
	} else {
		noiseFloorURL = fmt.Sprintf("%s://%s:%d/api/noisefloor/latest", protocol, host, port)
	}

	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: false,
				MinVersion:         tls.VersionTLS12,
			},
		},
	}

	// Retry up to 3 times with 30 second delays
	maxRetries := 3
	retryDelay := 30 * time.Second

	for attempt := 1; attempt <= maxRetries; attempt++ {
		// Make the GET request
		req, err := http.NewRequest("GET", noiseFloorURL, nil)
		if err != nil {
			log.Printf("Failed to create noise floor request for %s (attempt %d/%d): %v", publicUUID, attempt, maxRetries, err)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return
		}

		req.Header.Set("User-Agent", fmt.Sprintf("UberSDR-Collector/%s", Version))

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("Failed to fetch noise floor data for %s from %s (attempt %d/%d): %v", publicUUID, noiseFloorURL, attempt, maxRetries, err)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return
		}
		defer resp.Body.Close()

		// Check response status
		if resp.StatusCode != http.StatusOK {
			log.Printf("Noise floor request returned status %d for %s (attempt %d/%d)", resp.StatusCode, publicUUID, attempt, maxRetries)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return
		}

		// Read the response body as raw JSON
		var jsonData json.RawMessage
		if err := json.NewDecoder(resp.Body).Decode(&jsonData); err != nil {
			log.Printf("Failed to decode noise floor data for %s (attempt %d/%d): %v", publicUUID, attempt, maxRetries, err)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return
		}

		// Check data size before storing
		jsonDataStr := string(jsonData)
		dataSize := len(jsonDataStr)

		// Reject data larger than 10KB
		const maxSize = 10 * 1024 // 10KB
		if dataSize > maxSize {
			log.Printf("Noise floor data too large for %s: %d bytes (max: %d bytes), skipping storage", publicUUID, dataSize, maxSize)
			return
		}

		// Store in database
		now := time.Now()
		_, err = c.db.Exec(`
			INSERT INTO noise_floor_data (public_uuid, data, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(public_uuid) DO UPDATE SET
				data = excluded.data,
				updated_at = excluded.updated_at
		`, publicUUID, jsonDataStr, now)

		if err != nil {
			log.Printf("Failed to store noise floor data for %s (attempt %d/%d): %v", publicUUID, attempt, maxRetries, err)
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			return
		}

		log.Printf("Stored noise floor data for %s (attempt %d, size: %d bytes)", publicUUID, attempt, dataSize)
		return
	}
}

// checkRateLimit checks if an IP is allowed to make a POST request
// Returns true if allowed, false if rate limit exceeded
// This marks the IP as "in use" immediately to prevent concurrent requests
func (c *Collector) checkRateLimit(ip string) bool {
	c.rateLimitMutex.Lock()
	defer c.rateLimitMutex.Unlock()

	now := time.Now()
	lastPost, exists := c.rateLimitMap[ip]

	// If no previous POST or more than 10 seconds have passed, allow it
	if !exists || now.Sub(lastPost) >= 10*time.Second {
		// Mark this IP as having an active request NOW (before verification callback)
		// This prevents concurrent requests from the same IP during the slow verification process
		c.rateLimitMap[ip] = now
		return true
	}

	// Rate limit exceeded - there's either an in-flight request or one completed less than 10s ago
	return false
}

// checkGetRateLimit checks if an IP is allowed to make a GET /api/instances request
// Returns true if allowed, false if rate limit exceeded (1 request per second)
func (c *Collector) checkGetRateLimit(ip string) bool {
	c.getRateLimitMutex.Lock()
	defer c.getRateLimitMutex.Unlock()

	now := time.Now()
	lastGet, exists := c.getRateLimitMap[ip]

	// If no previous GET or more than 1 second has passed, allow it
	if !exists || now.Sub(lastGet) >= 1*time.Second {
		c.getRateLimitMap[ip] = now
		return true
	}

	// Rate limit exceeded
	return false
}

// cleanupRateLimitMap periodically removes old entries from the POST rate limit map
func (c *Collector) cleanupRateLimitMap() {
	ticker := time.NewTicker(5 * time.Minute) // Run cleanup every 5 minutes
	defer ticker.Stop()

	for range ticker.C {
		c.rateLimitMutex.Lock()
		now := time.Now()
		for ip, lastPost := range c.rateLimitMap {
			// Remove entries older than 2 minutes (well past the 60 second limit)
			if now.Sub(lastPost) > 2*time.Minute {
				delete(c.rateLimitMap, ip)
			}
		}
		c.rateLimitMutex.Unlock()
	}
}

// cleanupGetRateLimitMap periodically removes old entries from the GET rate limit map
func (c *Collector) cleanupGetRateLimitMap() {
	ticker := time.NewTicker(1 * time.Minute) // Run cleanup every minute
	defer ticker.Stop()

	for range ticker.C {
		c.getRateLimitMutex.Lock()
		now := time.Now()
		for ip, lastGet := range c.getRateLimitMap {
			// Remove entries older than 5 seconds (well past the 1 second limit)
			if now.Sub(lastGet) > 5*time.Second {
				delete(c.getRateLimitMap, ip)
			}
		}
		c.getRateLimitMutex.Unlock()
	}
}

// cleanupStaleInstances periodically removes instances that haven't been seen in 24 hours
// Also removes DNS records for instances with subdomains
func (c *Collector) cleanupStaleInstances() {
	ticker := time.NewTicker(1 * time.Hour) // Run cleanup every hour
	defer ticker.Stop()

	for range ticker.C {
		// First, get instances that will be deleted and have subdomains
		rows, err := c.db.Query(`
			SELECT callsign, has_subdomain
			FROM instances
			WHERE datetime(last_seen) < datetime('now', '-24 hours')
		`)
		
		if err != nil {
			log.Printf("Failed to query stale instances: %v", err)
			continue
		}
		
		// Collect instances to clean up
		type staleInstance struct {
			callsign     string
			hasSubdomain bool
		}
		var staleInstances []staleInstance
		
		for rows.Next() {
			var inst staleInstance
			if err := rows.Scan(&inst.callsign, &inst.hasSubdomain); err != nil {
				log.Printf("Failed to scan stale instance: %v", err)
				continue
			}
			staleInstances = append(staleInstances, inst)
		}
		rows.Close()
		
		// Delete DNS records for instances with subdomains
		for _, inst := range staleInstances {
			if inst.hasSubdomain {
				if err := c.deleteDNSRecord(inst.callsign); err != nil {
					log.Printf("Failed to delete DNS record for stale instance %s: %v", inst.callsign, err)
					// Continue anyway - we'll still delete from database
				} else {
					log.Printf("Deleted DNS record for stale instance: %s", inst.callsign)
				}
			}
		}
		
		// Delete instances not seen in the last 24 hours
		result, err := c.db.Exec(`
			DELETE FROM instances
			WHERE datetime(last_seen) < datetime('now', '-24 hours')
		`)

		if err != nil {
			log.Printf("Failed to cleanup stale instances: %v", err)
			continue
		}

		rowsAffected, err := result.RowsAffected()
		if err != nil {
			log.Printf("Failed to get rows affected during cleanup: %v", err)
			continue
		}

		if rowsAffected > 0 {
			log.Printf("Cleaned up %d stale instance(s) not seen in 24 hours", rowsAffected)
		}
	}
}

// handleGetNoiseFloor handles GET requests for noise floor data by public UUID
func (c *Collector) handleGetNoiseFloor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract public UUID from URL path
	// URL format: /api/noisefloor/{public_uuid}
	publicUUID := r.URL.Path[len("/api/noisefloor/"):]
	if publicUUID == "" {
		http.Error(w, "Missing instance UUID", http.StatusBadRequest)
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(publicUUID); err != nil {
		http.Error(w, "Invalid UUID format", http.StatusBadRequest)
		return
	}

	var data string
	var updatedAt time.Time
	err := c.db.QueryRow(`
		SELECT data, updated_at
		FROM noise_floor_data
		WHERE public_uuid = ?
	`, publicUUID).Scan(&data, &updatedAt)

	if err == sql.ErrNoRows {
		http.Error(w, "Noise floor data not found", http.StatusNotFound)
		return
	} else if err != nil {
		log.Printf("Failed to query noise floor data: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Return the raw JSON data with metadata
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// Wrap the data with metadata
	response := map[string]interface{}{
		"public_uuid": publicUUID,
		"updated_at":  updatedAt.Format(time.RFC3339),
		"data":        json.RawMessage(data),
	}

	json.NewEncoder(w).Encode(response)
}

// getBandConditions fetches simplified band condition data (just FT8 SNR values) for an instance
// Returns a map of band name to FT8 SNR value, and the updated_at timestamp
func (c *Collector) getBandConditions(publicUUID string) (map[string]float64, string) {
	var data string
	var updatedAt time.Time
	err := c.db.QueryRow(`
		SELECT data, updated_at
		FROM noise_floor_data
		WHERE public_uuid = ?
	`, publicUUID).Scan(&data, &updatedAt)

	if err != nil {
		// No data available or error
		return nil, ""
	}

	// Parse the full noise floor JSON
	var fullData map[string]interface{}
	if err := json.Unmarshal([]byte(data), &fullData); err != nil {
		log.Printf("Failed to unmarshal noise floor data for %s: %v", publicUUID, err)
		return nil, ""
	}

	// Extract just the ft8_snr values for each band
	conditions := make(map[string]float64)
	for band, bandDataInterface := range fullData {
		if bandData, ok := bandDataInterface.(map[string]interface{}); ok {
			if ft8SNR, ok := bandData["ft8_snr"].(float64); ok {
				conditions[band] = ft8SNR
			}
		}
	}

	return conditions, updatedAt.Format(time.RFC3339)
}
