package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
)

const Version = "0.1.0"

// Instance represents an UberSDR instance
type Instance struct {
	SecretUUID    string    `json:"-"`  // Secret UUID (not exposed in API)
	PublicUUID    string    `json:"id"` // Public UUID for API access
	Callsign      string    `json:"callsign"`
	Name          string    `json:"name"`
	Location      string    `json:"location"`
	Latitude      float64   `json:"latitude"`
	Longitude     float64   `json:"longitude"`
	Altitude      int       `json:"altitude"`
	PublicURL     string    `json:"public_url"`
	Version       string    `json:"version"`
	Host          string    `json:"host,omitempty"`
	Port          int       `json:"port,omitempty"`
	TLS           bool      `json:"tls,omitempty"`
	FirstSeen     time.Time `json:"first_seen"`
	LastSeen      time.Time `json:"last_seen"`
	LastReportAge int64     `json:"last_report_age_seconds"` // Computed field
}

// InstanceUpdate represents the data received from an instance
type InstanceUpdate struct {
	UUID      string  `json:"uuid"`
	Callsign  string  `json:"callsign"`
	Name      string  `json:"name"`
	Location  string  `json:"location"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Altitude  int     `json:"altitude"`
	PublicURL string  `json:"public_url"`
	Version   string  `json:"version"`
	Timestamp int64   `json:"timestamp"`
	Host      string  `json:"host"`
	Port      int     `json:"port"`
	TLS       bool    `json:"tls"`
}

// Config represents the collector configuration
type Config struct {
	Listen       string `json:"listen"`
	DatabasePath string `json:"database_path"`
}

// Collector manages the instance collection service
type Collector struct {
	db     *sql.DB
	config *Config
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
		db:     db,
		config: config,
	}

	// Setup HTTP routes with logging middleware
	http.HandleFunc("/api/instance/", loggingMiddleware(collector.handleInstanceUpdate))
	http.HandleFunc("/api/instances", loggingMiddleware(collector.handleListInstances))
	http.HandleFunc("/api/instances/", loggingMiddleware(collector.handleGetInstance))
	http.HandleFunc("/api/lookup/", loggingMiddleware(collector.handleLookupPublicUUID))
	http.HandleFunc("/health", loggingMiddleware(handleHealth))

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
		host TEXT,
		port INTEGER,
		tls BOOLEAN,
		first_seen DATETIME NOT NULL,
		last_seen DATETIME NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_public_uuid ON instances(public_uuid);
	CREATE INDEX IF NOT EXISTS idx_last_seen ON instances(last_seen);
	`

	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("failed to create schema: %w", err)
	}

	log.Println("Database initialized successfully")
	return db, nil
}

// loggingMiddleware logs all HTTP requests
func loggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Create a response writer wrapper to capture status code
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		// Call the next handler
		next(wrapped, r)

		// Log the request
		duration := time.Since(start)
		log.Printf("%s %s %d %s %s",
			r.Method,
			r.URL.Path,
			wrapped.statusCode,
			duration,
			r.RemoteAddr,
		)
	}
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
	if len(update.Callsign) > 20 {
		return fmt.Errorf("callsign too long (max 20 characters)")
	}
	if len(update.Name) > 100 {
		return fmt.Errorf("name too long (max 100 characters)")
	}
	if len(update.Location) > 200 {
		return fmt.Errorf("location too long (max 200 characters)")
	}
	if len(update.Version) > 50 {
		return fmt.Errorf("version too long (max 50 characters)")
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
		if len(update.PublicURL) > 500 {
			return fmt.Errorf("public_url too long (max 500 characters)")
		}
	}

	return nil
}

// handleInstanceUpdate handles POST requests from instances
func (c *Collector) handleInstanceUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract secret UUID from URL path
	// URL format: /api/instance/{uuid}
	secretUUID := r.URL.Path[len("/api/instance/"):]
	if secretUUID == "" {
		http.Error(w, "Missing instance UUID", http.StatusBadRequest)
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(secretUUID); err != nil {
		http.Error(w, "Invalid UUID format", http.StatusBadRequest)
		return
	}

	// Parse request body
	var update InstanceUpdate
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Verify UUID in body matches URL
	if update.UUID != secretUUID {
		http.Error(w, "UUID mismatch", http.StatusBadRequest)
		return
	}

	// Validate field values
	if err := validateInstanceUpdate(&update); err != nil {
		http.Error(w, fmt.Sprintf("Validation error: %v", err), http.StatusBadRequest)
		return
	}

	// Check if instance exists
	var publicUUID string
	err := c.db.QueryRow("SELECT public_uuid FROM instances WHERE secret_uuid = ?", secretUUID).Scan(&publicUUID)

	now := time.Now()

	if err == sql.ErrNoRows {
		// New instance - generate public UUID
		publicUUID = uuid.New().String()

		_, err = c.db.Exec(`
			INSERT INTO instances (
				secret_uuid, public_uuid, callsign, name, location,
				latitude, longitude, altitude, public_url, version,
				host, port, tls,
				first_seen, last_seen
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			secretUUID, publicUUID, update.Callsign, update.Name, update.Location,
			update.Latitude, update.Longitude, update.Altitude, update.PublicURL, update.Version,
			update.Host, update.Port, update.TLS,
			now, now,
		)

		if err != nil {
			log.Printf("Failed to insert instance: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		log.Printf("New instance registered: %s (public: %s, callsign: %s)", secretUUID, publicUUID, update.Callsign)
	} else if err != nil {
		log.Printf("Database error: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	} else {
		// Existing instance - update
		_, err = c.db.Exec(`
			UPDATE instances SET
				callsign = ?, name = ?, location = ?,
				latitude = ?, longitude = ?, altitude = ?,
				public_url = ?, version = ?,
				host = ?, port = ?, tls = ?,
				last_seen = ?
			WHERE secret_uuid = ?`,
			update.Callsign, update.Name, update.Location,
			update.Latitude, update.Longitude, update.Altitude,
			update.PublicURL, update.Version,
			update.Host, update.Port, update.TLS,
			now,
			secretUUID,
		)

		if err != nil {
			log.Printf("Failed to update instance: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		log.Printf("Instance updated: %s (public: %s, callsign: %s)", secretUUID, publicUUID, update.Callsign)
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

	rows, err := c.db.Query(`
		SELECT public_uuid, callsign, name, location, latitude, longitude,
		       altitude, public_url, version, host, port, tls, first_seen, last_seen
		FROM instances
		WHERE datetime(last_seen) >= datetime('now', '-30 minutes')
		ORDER BY last_seen DESC
	`)
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
		err := rows.Scan(
			&inst.PublicUUID, &inst.Callsign, &inst.Name, &inst.Location,
			&inst.Latitude, &inst.Longitude, &inst.Altitude, &inst.PublicURL,
			&inst.Version, &inst.Host, &inst.Port, &inst.TLS, &inst.FirstSeen, &inst.LastSeen,
		)
		if err != nil {
			log.Printf("Failed to scan instance: %v", err)
			continue
		}

		// Calculate age of last report
		inst.LastReportAge = int64(now.Sub(inst.LastSeen).Seconds())
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

	var inst Instance
	err := c.db.QueryRow(`
		SELECT public_uuid, callsign, name, location, latitude, longitude,
		       altitude, public_url, version, host, port, tls, first_seen, last_seen
		FROM instances
		WHERE public_uuid = ?
	`, publicUUID).Scan(
		&inst.PublicUUID, &inst.Callsign, &inst.Name, &inst.Location,
		&inst.Latitude, &inst.Longitude, &inst.Altitude, &inst.PublicURL,
		&inst.Version, &inst.Host, &inst.Port, &inst.TLS, &inst.FirstSeen, &inst.LastSeen,
	)

	if err == sql.ErrNoRows {
		http.Error(w, "Instance not found", http.StatusNotFound)
		return
	} else if err != nil {
		log.Printf("Failed to query instance: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Calculate age of last report
	inst.LastReportAge = int64(time.Now().Sub(inst.LastSeen).Seconds())

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
