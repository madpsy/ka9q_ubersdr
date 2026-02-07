package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"gopkg.in/yaml.v3"
)

// marshalYAMLWithIntegerFrequencies marshals a config map to YAML, ensuring frequency fields are integers
func marshalYAMLWithIntegerFrequencies(config map[string]interface{}) ([]byte, error) {
	// Walk through the config and convert float64 frequency values to uint64
	convertFrequencies(config)
	return yaml.Marshal(config)
}

// convertFrequencies recursively converts frequency fields from float64 to uint64
// Handles any field named "frequency" or ending in "_frequency" or "_freq"
func convertFrequencies(v interface{}) {
	switch val := v.(type) {
	case map[string]interface{}:
		// Convert any field ending in "frequency", "_frequency", or "_freq"
		for key, value := range val {
			if key == "frequency" || strings.HasSuffix(key, "_frequency") || strings.HasSuffix(key, "_freq") {
				switch f := value.(type) {
				case float64:
					val[key] = uint64(f)
				case int:
					val[key] = uint64(f)
				case int64:
					val[key] = uint64(f)
				}
			}
		}
		// Recursively process all map values
		for _, v2 := range val {
			convertFrequencies(v2)
		}
	case []interface{}:
		// Recursively process all slice elements
		for _, v2 := range val {
			convertFrequencies(v2)
		}
	}
}

// AdminSession represents an authenticated admin session
type AdminSession struct {
	Token     string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// AdminSessionStore manages admin sessions
type AdminSessionStore struct {
	sessions map[string]*AdminSession
	mu       sync.RWMutex
}

// NewAdminSessionStore creates a new session store
func NewAdminSessionStore() *AdminSessionStore {
	store := &AdminSessionStore{
		sessions: make(map[string]*AdminSession),
	}
	// Start cleanup goroutine
	go store.cleanupExpiredSessions()
	return store
}

// CreateSession creates a new admin session
func (s *AdminSessionStore) CreateSession() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Generate secure random token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		log.Printf("Failed to generate session token: %v", err)
		return ""
	}
	token := base64.URLEncoding.EncodeToString(tokenBytes)

	// Create session with 24 hour expiry
	session := &AdminSession{
		Token:     token,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}

	s.sessions[token] = session
	return token
}

// ValidateSession checks if a session token is valid
func (s *AdminSessionStore) ValidateSession(token string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	session, exists := s.sessions[token]
	if !exists {
		return false
	}

	// Check if expired
	if time.Now().After(session.ExpiresAt) {
		return false
	}

	return true
}

// DeleteSession removes a session
func (s *AdminSessionStore) DeleteSession(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

// cleanupExpiredSessions periodically removes expired sessions
func (s *AdminSessionStore) cleanupExpiredSessions() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for token, session := range s.sessions {
			if now.After(session.ExpiresAt) {
				delete(s.sessions, token)
			}
		}
		s.mu.Unlock()
	}
}

// LoginAttempt tracks failed login attempts per IP
type LoginAttempt struct {
	Count     int
	FirstTime time.Time
	LastTime  time.Time
}

// LoginAttemptTracker tracks failed login attempts by IP address
type LoginAttemptTracker struct {
	attempts map[string]*LoginAttempt
	mu       sync.RWMutex
}

// NewLoginAttemptTracker creates a new login attempt tracker
func NewLoginAttemptTracker() *LoginAttemptTracker {
	tracker := &LoginAttemptTracker{
		attempts: make(map[string]*LoginAttempt),
	}
	// Start cleanup goroutine to remove old attempts
	go tracker.cleanupOldAttempts()
	return tracker
}

// RecordFailedAttempt records a failed login attempt for an IP
func (t *LoginAttemptTracker) RecordFailedAttempt(ip string) int {
	t.mu.Lock()
	defer t.mu.Unlock()

	now := time.Now()
	if attempt, exists := t.attempts[ip]; exists {
		attempt.Count++
		attempt.LastTime = now
		return attempt.Count
	}

	t.attempts[ip] = &LoginAttempt{
		Count:     1,
		FirstTime: now,
		LastTime:  now,
	}
	return 1
}

// GetAttemptCount returns the number of failed attempts for an IP within the window
func (t *LoginAttemptTracker) GetAttemptCount(ip string, window time.Duration) int {
	t.mu.RLock()
	defer t.mu.RUnlock()

	attempt, exists := t.attempts[ip]
	if !exists {
		return 0
	}

	// Check if attempts are within the time window
	if time.Since(attempt.FirstTime) > window {
		return 0
	}

	return attempt.Count
}

// ResetAttempts clears failed attempts for an IP (called on successful login)
func (t *LoginAttemptTracker) ResetAttempts(ip string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.attempts, ip)
}

// cleanupOldAttempts periodically removes expired attempt records
func (t *LoginAttemptTracker) cleanupOldAttempts() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		t.mu.Lock()
		now := time.Now()
		for ip, attempt := range t.attempts {
			// Remove attempts older than 1 hour
			if now.Sub(attempt.LastTime) > 1*time.Hour {
				delete(t.attempts, ip)
			}
		}
		t.mu.Unlock()
	}
}

// AdminHandler handles admin configuration endpoints
type AdminHandler struct {
	config              *Config
	configFile          string
	configDir           string
	sessions            *SessionManager
	adminSessions       *AdminSessionStore
	ipBanManager        *IPBanManager
	countryBanManager   *CountryBanManager
	audioReceiver       *AudioReceiver
	userSpectrumManager *UserSpectrumManager
	noiseFloorMonitor   *NoiseFloorMonitor
	multiDecoder        *MultiDecoder
	dxCluster           *DXClusterClient
	dxClusterWsHandler  *DXClusterWebSocketHandler
	spaceWeatherMonitor *SpaceWeatherMonitor
	cwSkimmerConfig     *CWSkimmerConfig
	cwSkimmerClient     *CWSkimmerClient
	instanceReporter    *InstanceReporter
	mqttPublisher       *MQTTPublisher
	rotctlHandler       *RotctlAPIHandler
	rotatorScheduler    *RotatorScheduler
	geoIPService        *GeoIPService
	loginAttempts       *LoginAttemptTracker
	frontendHistory     *FrontendHistoryTracker
	loadHistory         *LoadHistoryTracker
}

// restartServer triggers a server restart after a short delay
// It properly shuts down all components before exiting
func (ah *AdminHandler) restartServer() {
	log.Println("Server restart requested via admin API...")
	go func() {
		time.Sleep(1 * time.Second) // Give time for HTTP response to be sent
		log.Println("Shutting down all components before restart...")

		// Stop all components in reverse order of initialization
		// This ensures proper cleanup of all radiod channels and connections

		// 1. Stop multi-decoder (decoder channels)
		if ah.multiDecoder != nil {
			log.Println("Stopping multi-decoder...")
			ah.multiDecoder.Stop()
		}

		// 2. Stop DX cluster client
		if ah.dxCluster != nil {
			log.Println("Stopping DX cluster client...")
			ah.dxCluster.Stop()
		}

		// 3. Stop space weather monitor
		if ah.spaceWeatherMonitor != nil {
			log.Println("Stopping space weather monitor...")
			ah.spaceWeatherMonitor.Stop()
		}

		// 4. Stop noise floor monitor (noise floor channels)
		if ah.noiseFloorMonitor != nil {
			log.Println("Stopping noise floor monitor...")
			ah.noiseFloorMonitor.Stop()
		}

		// 5. Stop user spectrum manager (per-user spectrum channels)
		if ah.userSpectrumManager != nil {
			log.Println("Stopping user spectrum manager...")
			ah.userSpectrumManager.Stop()
		}

		// 6. Stop audio receiver
		if ah.audioReceiver != nil {
			log.Println("Stopping audio receiver...")
			ah.audioReceiver.Stop()
		}

		// 7. Finally, shutdown all web user sessions (websockets and their radiod channels)
		if ah.sessions != nil {
			log.Println("Shutting down all sessions...")
			ah.sessions.Shutdown()
		}

		log.Println("All components stopped. Restarting server now...")
		os.Exit(0) // Exit cleanly - process manager should restart
	}()
}

// NewAdminHandler creates a new admin handler
func NewAdminHandler(config *Config, configFile string, configDir string, sessions *SessionManager, ipBanManager *IPBanManager, countryBanManager *CountryBanManager, audioReceiver *AudioReceiver, userSpectrumManager *UserSpectrumManager, noiseFloorMonitor *NoiseFloorMonitor, multiDecoder *MultiDecoder, dxCluster *DXClusterClient, dxClusterWsHandler *DXClusterWebSocketHandler, spaceWeatherMonitor *SpaceWeatherMonitor, cwSkimmerConfig *CWSkimmerConfig, cwSkimmerClient *CWSkimmerClient, instanceReporter *InstanceReporter, mqttPublisher *MQTTPublisher, rotctlHandler *RotctlAPIHandler, rotatorScheduler *RotatorScheduler, geoIPService *GeoIPService, frontendHistory *FrontendHistoryTracker, loadHistory *LoadHistoryTracker) *AdminHandler {
	return &AdminHandler{
		config:              config,
		configFile:          configFile,
		configDir:           configDir,
		sessions:            sessions,
		adminSessions:       NewAdminSessionStore(),
		ipBanManager:        ipBanManager,
		countryBanManager:   countryBanManager,
		audioReceiver:       audioReceiver,
		userSpectrumManager: userSpectrumManager,
		noiseFloorMonitor:   noiseFloorMonitor,
		multiDecoder:        multiDecoder,
		dxCluster:           dxCluster,
		dxClusterWsHandler:  dxClusterWsHandler,
		spaceWeatherMonitor: spaceWeatherMonitor,
		cwSkimmerConfig:     cwSkimmerConfig,
		cwSkimmerClient:     cwSkimmerClient,
		instanceReporter:    instanceReporter,
		mqttPublisher:       mqttPublisher,
		rotctlHandler:       rotctlHandler,
		rotatorScheduler:    rotatorScheduler,
		geoIPService:        geoIPService,
		loginAttempts:       NewLoginAttemptTracker(),
		frontendHistory:     frontendHistory,
		loadHistory:         loadHistory,
	}
}

// getConfigPath returns the full path to a config file
func (ah *AdminHandler) getConfigPath(filename string) string {
	if ah.configDir == "" || ah.configDir == "." {
		return filename
	}
	return ah.configDir + "/" + filename
}

// HandleLogin handles admin login and creates a session
func (ah *AdminHandler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get client IP for rate limiting using the same logic as other endpoints
	clientIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(clientIP); err == nil {
		clientIP = host
	}

	// Only trust X-Real-IP if request comes from tunnel server or trusted proxy
	isTunnelServer := globalConfig != nil && globalConfig.InstanceReporting.IsTunnelServer(clientIP)
	isTrustedProxy := globalConfig != nil && globalConfig.Server.IsTrustedProxy(clientIP)

	if isTunnelServer || isTrustedProxy {
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			clientIP = strings.TrimSpace(xri)
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
		}
	} else {
		// Check X-Forwarded-For header for true source IP (first IP in the list)
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			clientIP = strings.TrimSpace(xff)
			if commaIdx := strings.Index(clientIP, ","); commaIdx != -1 {
				clientIP = strings.TrimSpace(clientIP[:commaIdx])
			}
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
		}
	}

	// Check if IP is allowed to access admin endpoints
	if !ah.config.Admin.IsIPAllowed(clientIP) {
		log.Printf("Admin login denied for IP %s (not in allowed list)", clientIP)
		http.Error(w, "Forbidden - IP address not allowed", http.StatusForbidden)
		return
	}

	// Check if IP is already temporarily banned
	if ah.ipBanManager.IsBanned(clientIP) {
		http.Error(w, "Too many failed login attempts. Please try again later.", http.StatusTooManyRequests)
		return
	}

	var loginReq struct {
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&loginReq); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Validate password
	if loginReq.Password != ah.config.Admin.Password {
		// Record failed attempt
		attemptCount := ah.loginAttempts.RecordFailedAttempt(clientIP)

		// Check if we should apply temporary ban
		if attemptCount >= ah.config.Admin.MaxLoginAttempts {
			// Apply temporary ban
			banDuration := time.Duration(ah.config.Admin.LoginBanDuration) * time.Second
			reason := fmt.Sprintf("Too many failed login attempts (%d)", attemptCount)
			if err := ah.ipBanManager.BanIPWithDuration(clientIP, reason, "rate_limiter", banDuration); err != nil {
				log.Printf("Failed to ban IP %s: %v", clientIP, err)
			} else {
				log.Printf("Temporarily banned IP %s for %v due to %d failed login attempts", clientIP, banDuration, attemptCount)
			}
			http.Error(w, "Too many failed login attempts. Your IP has been temporarily banned.", http.StatusTooManyRequests)
			return
		}

		// Log the failed attempt
		remainingAttempts := ah.config.Admin.MaxLoginAttempts - attemptCount
		log.Printf("Failed login attempt from %s (%d/%d attempts, %d remaining)",
			clientIP, attemptCount, ah.config.Admin.MaxLoginAttempts, remainingAttempts)

		http.Error(w, "Invalid password", http.StatusUnauthorized)
		return
	}

	// Successful login - reset attempts for this IP
	ah.loginAttempts.ResetAttempts(clientIP)

	// Create session
	token := ah.adminSessions.CreateSession()
	if token == "" {
		http.Error(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	// Set HTTP-only cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   false, // Set to true if using HTTPS
		SameSite: http.SameSiteStrictMode,
		MaxAge:   86400, // 24 hours
	})

	log.Printf("Successful admin login from %s", clientIP)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Login successful",
	}); err != nil {
		log.Printf("Error encoding login response: %v", err)
	}
}

// HandleLogout handles admin logout
func (ah *AdminHandler) HandleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get session token from cookie
	cookie, err := r.Cookie("admin_session")
	if err == nil {
		// Delete session
		ah.adminSessions.DeleteSession(cookie.Value)
	}

	// Clear cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1, // Delete cookie
	})

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Logout successful",
	}); err != nil {
		log.Printf("Error encoding logout response: %v", err)
	}
}

// isBrowserRequest detects if the request is from a web browser
// by checking the Accept header for text/html preference
func isBrowserRequest(r *http.Request) bool {
	acceptHeader := r.Header.Get("Accept")

	// Check if Accept header explicitly requests HTML
	// Browsers typically send: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	// API clients typically send: "application/json", "*/*", or nothing
	return strings.Contains(acceptHeader, "text/html")
}

// AuthMiddleware checks for valid admin session or password header
func (ah *AdminHandler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check IP allowlist first (before any authentication)
		clientIP := r.RemoteAddr
		if host, _, err := net.SplitHostPort(clientIP); err == nil {
			clientIP = host
		}

		// Only trust X-Real-IP if request comes from tunnel server or trusted proxy
		isTunnelServer := globalConfig != nil && globalConfig.InstanceReporting.IsTunnelServer(clientIP)
		isTrustedProxy := globalConfig != nil && globalConfig.Server.IsTrustedProxy(clientIP)

		if isTunnelServer || isTrustedProxy {
			if xri := r.Header.Get("X-Real-IP"); xri != "" {
				clientIP = strings.TrimSpace(xri)
				if host, _, err := net.SplitHostPort(clientIP); err == nil {
					clientIP = host
				}
			}
		} else {
			// Check X-Forwarded-For header for true source IP (first IP in the list)
			if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				clientIP = strings.TrimSpace(xff)
				if commaIdx := strings.Index(clientIP, ","); commaIdx != -1 {
					clientIP = strings.TrimSpace(clientIP[:commaIdx])
				}
				if host, _, err := net.SplitHostPort(clientIP); err == nil {
					clientIP = host
				}
			}
		}

		// Check if IP is allowed to access admin endpoints
		if !ah.config.Admin.IsIPAllowed(clientIP) {
			// Ensure we always show the IP in the log, even if empty
			if clientIP == "" {
				log.Printf("Admin access denied for IP <empty> (not in allowed list) - RemoteAddr was: %s", r.RemoteAddr)
			} else {
				log.Printf("Admin access denied for IP %s (not in allowed list)", clientIP)
			}
			http.Error(w, "Forbidden - IP address not allowed", http.StatusForbidden)
			return
		}

		// Check if this is an SSH proxy request for debug logging
		// Exclude /terminal/sessions which is the management interface that browsers access
		isSSHProxy := strings.HasPrefix(r.URL.Path, "/terminal") && r.URL.Path != "/terminal/sessions"

		// Check for password in X-Admin-Password header first
		if password := r.Header.Get("X-Admin-Password"); password != "" {
			// Check if IP is already temporarily banned (before validating password)
			if ah.ipBanManager.IsBanned(clientIP) {
				http.Error(w, "Too many failed authentication attempts. Please try again later.", http.StatusTooManyRequests)
				return
			}

			if password == ah.config.Admin.Password {
				// Valid password - reset failed attempts for this IP
				ah.loginAttempts.ResetAttempts(clientIP)
				
				// Valid password, proceed
				if isSSHProxy {
					log.Printf("[SSH Proxy Auth] Authenticated via X-Admin-Password header for %s", r.URL.Path)
				}
				next(w, r)
				return
			}
			
			// Invalid password - record failed attempt
			attemptCount := ah.loginAttempts.RecordFailedAttempt(clientIP)
			
			// Check if we should apply temporary ban
			if attemptCount >= ah.config.Admin.MaxLoginAttempts {
				// Apply temporary ban
				banDuration := time.Duration(ah.config.Admin.LoginBanDuration) * time.Second
				reason := fmt.Sprintf("Too many failed X-Admin-Password attempts (%d)", attemptCount)
				if err := ah.ipBanManager.BanIPWithDuration(clientIP, reason, "rate_limiter", banDuration); err != nil {
					log.Printf("Failed to ban IP %s: %v", clientIP, err)
				} else {
					log.Printf("Temporarily banned IP %s for %v due to %d failed X-Admin-Password attempts", clientIP, banDuration, attemptCount)
				}
				http.Error(w, "Too many failed authentication attempts. Your IP has been temporarily banned.", http.StatusTooManyRequests)
				return
			}
			
			// Log the failed attempt
			remainingAttempts := ah.config.Admin.MaxLoginAttempts - attemptCount
			log.Printf("Failed X-Admin-Password attempt from %s (%d/%d attempts, %d remaining)",
				clientIP, attemptCount, ah.config.Admin.MaxLoginAttempts, remainingAttempts)
			
			// Invalid password
			if isSSHProxy {
				log.Printf("[SSH Proxy Auth] Invalid X-Admin-Password header for %s", r.URL.Path)
			}
			http.Error(w, "Unauthorized - invalid password", http.StatusUnauthorized)
			return
		}

		// Fall back to cookie-based authentication
		cookie, err := r.Cookie("admin_session")
		if err != nil {
			// No admin_session cookie - this is expected for SSH proxy requests using X-Admin-Password header

			// Check if this is a browser request (not SSH proxy or API)
			if !isSSHProxy && isBrowserRequest(r) {
				// Redirect browsers to login page with return URL
				returnURL := r.URL.Path
				if r.URL.RawQuery != "" {
					returnURL += "?" + r.URL.RawQuery
				}
				redirectURL := "/admin.html?return=" + url.QueryEscape(returnURL)
				http.Redirect(w, r, redirectURL, http.StatusSeeOther)
				return
			}

			http.Error(w, "Unauthorized - no session or password", http.StatusUnauthorized)
			return
		}

		// SSH proxy authentication via cookie - no logging needed for normal operation

		// Validate session
		if !ah.adminSessions.ValidateSession(cookie.Value) {
			if isSSHProxy {
				// Get more details about why validation failed
				ah.adminSessions.mu.RLock()
				session, exists := ah.adminSessions.sessions[cookie.Value]
				totalSessions := len(ah.adminSessions.sessions)
				ah.adminSessions.mu.RUnlock()

				if !exists {
					log.Printf("[SSH Proxy Auth] Session validation failed for %s: session token not found in store (total sessions: %d)", r.URL.Path, totalSessions)
				} else {
					expired := time.Now().After(session.ExpiresAt)
					log.Printf("[SSH Proxy Auth] Session validation failed for %s: session exists but expired=%v (created: %s, expires: %s, now: %s)",
						r.URL.Path, expired, session.CreatedAt.Format(time.RFC3339), session.ExpiresAt.Format(time.RFC3339), time.Now().Format(time.RFC3339))
				}
			}

			// Check if this is a browser request (not SSH proxy or API)
			if !isSSHProxy && isBrowserRequest(r) {
				// Redirect browsers to login page with return URL
				returnURL := r.URL.Path
				if r.URL.RawQuery != "" {
					returnURL += "?" + r.URL.RawQuery
				}
				redirectURL := "/admin.html?return=" + url.QueryEscape(returnURL)
				http.Redirect(w, r, redirectURL, http.StatusSeeOther)
				return
			}

			http.Error(w, "Unauthorized - invalid or expired session", http.StatusUnauthorized)
			return
		}

		// Session validation successful - no logging needed for normal operation

		next(w, r)
	}
}

// HandleConfig handles GET, PUT, PATCH requests for config
func (ah *AdminHandler) HandleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetConfig(w, r)
	case http.MethodPut:
		ah.handlePutConfig(w, r)
	case http.MethodPatch:
		ah.handlePatchConfig(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetConfig returns the current configuration
func (ah *AdminHandler) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	// Read the config file directly to get the raw YAML structure
	data, err := os.ReadFile(ah.configFile)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Parse YAML into a generic map for dynamic structure
	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusInternalServerError)
		return
	}

	// Remove admin password from response for security
	if admin, ok := configMap["admin"].(map[string]interface{}); ok {
		admin["password"] = "********"
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(configMap); err != nil {
		log.Printf("Error encoding config: %v", err)
	}
}

// handlePutConfig replaces the entire configuration
func (ah *AdminHandler) handlePutConfig(w http.ResponseWriter, r *http.Request) {
	// Check for restart flag
	restart := r.URL.Query().Get("restart") == "true"

	var newConfig map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&newConfig); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Preserve admin password if not provided or masked
	if admin, ok := newConfig["admin"].(map[string]interface{}); ok {
		if pwd, ok := admin["password"].(string); !ok || pwd == "" || pwd == "********" {
			admin["password"] = ah.config.Admin.Password
		}
	}

	// Convert to YAML and write to file, ensuring frequencies are integers
	yamlData, err := marshalYAMLWithIntegerFrequencies(newConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.configFile, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Trigger multicast-relay restart by creating restart trigger file
	// This ensures the multicast-relay picks up any changes to radiod multicast groups
	restartTriggerPath := "/var/run/restart-trigger/restart-multicast-relay"
	restartTriggerDir := filepath.Dir(restartTriggerPath)
	
	// Check if restart trigger directory exists (Docker environment)
	if _, err := os.Stat(restartTriggerDir); err == nil {
		// Create the restart trigger file
		if err := os.WriteFile(restartTriggerPath, []byte{}, 0644); err != nil {
			log.Printf("Warning: Failed to create multicast-relay restart trigger at %s: %v", restartTriggerPath, err)
		} else {
			log.Printf("Created multicast-relay restart trigger at %s", restartTriggerPath)
		}
	}

	w.WriteHeader(http.StatusOK)

	if restart {
		// Trigger restart after response is sent
		ah.restartServer()
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "success",
			"message": "Configuration updated. Server is restarting...",
			"restart": true,
		}); err != nil {
			log.Printf("Error encoding config update response: %v", err)
		}
	} else {
		if err := json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "Configuration updated. Restart server to apply changes.",
		}); err != nil {
			log.Printf("Error encoding config update response: %v", err)
		}
	}
}

// handlePatchConfig updates specific configuration values
func (ah *AdminHandler) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	// Check for restart flag
	restart := r.URL.Query().Get("restart") == "true"

	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Read current config
	data, err := os.ReadFile(ah.configFile)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read config file: %v", err), http.StatusInternalServerError)
		return
	}

	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusInternalServerError)
		return
	}

	// Apply updates using dot notation (e.g., "server.listen" -> configMap["server"]["listen"])
	for key, value := range updates {
		if err := ah.setNestedValue(configMap, key, value); err != nil {
			http.Error(w, fmt.Sprintf("Failed to update %s: %v", key, err), http.StatusBadRequest)
			return
		}
	}

	// Convert to YAML and write to file, ensuring frequencies are integers
	yamlData, err := marshalYAMLWithIntegerFrequencies(configMap)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.configFile, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)

	if restart {
		// Trigger restart after response is sent
		ah.restartServer()
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "success",
			"message": "Configuration updated. Server is restarting...",
			"restart": true,
		}); err != nil {
			log.Printf("Error encoding config patch response: %v", err)
		}
	} else {
		if err := json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "Configuration updated. Restart server to apply changes.",
		}); err != nil {
			log.Printf("Error encoding config patch response: %v", err)
		}
	}
}

// setNestedValue sets a value in a nested map using dot notation
func (ah *AdminHandler) setNestedValue(m map[string]interface{}, path string, value interface{}) error {
	keys := strings.Split(path, ".")
	current := m

	// Navigate to the parent of the target key
	for i := 0; i < len(keys)-1; i++ {
		key := keys[i]
		if next, ok := current[key].(map[string]interface{}); ok {
			current = next
		} else {
			// Create intermediate maps if they don't exist
			newMap := make(map[string]interface{})
			current[key] = newMap
			current = newMap
		}
	}

	// Set the final value, converting types as needed
	finalKey := keys[len(keys)-1]
	current[finalKey] = ah.convertValue(current[finalKey], value)
	return nil
}

// convertValue attempts to convert the new value to match the type of the old value
func (ah *AdminHandler) convertValue(oldValue, newValue interface{}) interface{} {
	if oldValue == nil {
		return newValue
	}

	oldType := reflect.TypeOf(oldValue)
	newType := reflect.TypeOf(newValue)

	// If types already match, return as-is
	if oldType == newType {
		return newValue
	}

	// Handle common conversions
	switch oldType.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		switch v := newValue.(type) {
		case float64:
			return int(v)
		case string:
			if i, err := strconv.ParseInt(v, 10, 64); err == nil {
				// Convert to the specific int type
				switch oldType.Kind() {
				case reflect.Int:
					return int(i)
				case reflect.Int8:
					return int8(i)
				case reflect.Int16:
					return int16(i)
				case reflect.Int32:
					return int32(i)
				case reflect.Int64:
					return int64(i)
				}
			}
		}
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		switch v := newValue.(type) {
		case float64:
			// Convert to the specific uint type
			switch oldType.Kind() {
			case reflect.Uint:
				return uint(v)
			case reflect.Uint8:
				return uint8(v)
			case reflect.Uint16:
				return uint16(v)
			case reflect.Uint32:
				return uint32(v)
			case reflect.Uint64:
				return uint64(v)
			}
		case string:
			if u, err := strconv.ParseUint(v, 10, 64); err == nil {
				// Convert to the specific uint type
				switch oldType.Kind() {
				case reflect.Uint:
					return uint(u)
				case reflect.Uint8:
					return uint8(u)
				case reflect.Uint16:
					return uint16(u)
				case reflect.Uint32:
					return uint32(u)
				case reflect.Uint64:
					return uint64(u)
				}
			}
		}
	case reflect.Float32:
		switch v := newValue.(type) {
		case float64:
			return float32(v)
		case int:
			return float32(v)
		case string:
			if f, err := strconv.ParseFloat(v, 32); err == nil {
				return float32(f)
			}
		}
	case reflect.Float64:
		switch v := newValue.(type) {
		case int:
			return float64(v)
		case float32:
			return float64(v)
		case string:
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				return f
			}
		}
	case reflect.Bool:
		switch v := newValue.(type) {
		case string:
			if b, err := strconv.ParseBool(v); err == nil {
				return b
			}
		}
	case reflect.String:
		return fmt.Sprintf("%v", newValue)
	}

	return newValue
}

// HandleConfigSchema returns the configuration schema for the frontend
func (ah *AdminHandler) HandleConfigSchema(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Read the config file to get structure with comments
	data, err := os.ReadFile(ah.configFile)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read config file: %v", err), http.StatusInternalServerError)
		return
	}

	schema := map[string]interface{}{
		"raw_yaml": string(data),
		"sections": []string{"admin", "radiod", "server", "audio", "spectrum", "logging"},
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(schema)
}

// HandleBookmarks handles GET, POST, PUT, DELETE requests for bookmarks
func (ah *AdminHandler) HandleBookmarks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetBookmarks(w, r)
	case http.MethodPost:
		ah.handleAddBookmark(w, r)
	case http.MethodPut:
		ah.handleUpdateBookmarks(w, r)
	case http.MethodDelete:
		ah.handleDeleteBookmark(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetBookmarks returns all bookmarks
func (ah *AdminHandler) handleGetBookmarks(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(ah.getConfigPath("bookmarks.yaml"))
	if err != nil {
		// If file doesn't exist, return empty bookmarks
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"bookmarks": []interface{}{}})
		return
	}

	var bookmarksConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &bookmarksConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	// Sort bookmarks alphabetically by name, then by frequency
	if bookmarks, ok := bookmarksConfig["bookmarks"].([]interface{}); ok {
		sort.Slice(bookmarks, func(i, j int) bool {
			bookmarkI, okI := bookmarks[i].(map[string]interface{})
			bookmarkJ, okJ := bookmarks[j].(map[string]interface{})
			if !okI || !okJ {
				return false
			}
			nameI, okI := bookmarkI["name"].(string)
			nameJ, okJ := bookmarkJ["name"].(string)
			if !okI || !okJ {
				return false
			}

			// Compare names (case-insensitive)
			lowerNameI := strings.ToLower(nameI)
			lowerNameJ := strings.ToLower(nameJ)
			if lowerNameI != lowerNameJ {
				return lowerNameI < lowerNameJ
			}

			// If names are equal, compare frequencies
			freqI, okI := bookmarkI["frequency"].(uint64)
			freqJ, okJ := bookmarkJ["frequency"].(uint64)
			if okI && okJ {
				return freqI < freqJ
			}
			// Handle int type as well (YAML might parse as int)
			if !okI {
				if freqIntI, ok := bookmarkI["frequency"].(int); ok {
					freqI = uint64(freqIntI)
					okI = true
				}
			}
			if !okJ {
				if freqIntJ, ok := bookmarkJ["frequency"].(int); ok {
					freqJ = uint64(freqIntJ)
					okJ = true
				}
			}
			if okI && okJ {
				return freqI < freqJ
			}
			return false
		})
		bookmarksConfig["bookmarks"] = bookmarks
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(bookmarksConfig)
}

// handleAddBookmark adds a new bookmark
func (ah *AdminHandler) handleAddBookmark(w http.ResponseWriter, r *http.Request) {
	var newBookmark Bookmark
	if err := json.NewDecoder(r.Body).Decode(&newBookmark); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate bookmark
	if newBookmark.Name == "" || newBookmark.Frequency == 0 || newBookmark.Mode == "" {
		http.Error(w, "Name, frequency, and mode are required", http.StatusBadRequest)
		return
	}

	// Read existing bookmarks
	var bookmarksConfig map[string]interface{}
	data, err := os.ReadFile(ah.getConfigPath("bookmarks.yaml"))
	if err == nil {
		yaml.Unmarshal(data, &bookmarksConfig)
	} else {
		bookmarksConfig = make(map[string]interface{})
	}

	// Get bookmarks array
	var bookmarks []interface{}
	if existing, ok := bookmarksConfig["bookmarks"].([]interface{}); ok {
		bookmarks = existing
	}

	// Add new bookmark
	bookmarkMap := map[string]interface{}{
		"name":      newBookmark.Name,
		"frequency": newBookmark.Frequency,
		"mode":      newBookmark.Mode,
	}
	// Only add optional fields if they are not empty
	if newBookmark.Group != "" {
		bookmarkMap["group"] = newBookmark.Group
	}
	if newBookmark.Extension != "" {
		bookmarkMap["extension"] = newBookmark.Extension
	}
	if newBookmark.Comment != "" {
		bookmarkMap["comment"] = newBookmark.Comment
	}
	bookmarks = append(bookmarks, bookmarkMap)
	bookmarksConfig["bookmarks"] = bookmarks

	// Write back to file
	yamlData, err := yaml.Marshal(bookmarksConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("bookmarks.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bookmarks file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bookmarks into memory
	if err := ah.reloadBookmarks(); err != nil {
		log.Printf("Warning: Failed to reload bookmarks after add: %v", err)
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Bookmark added successfully",
	})
}

// handleUpdateBookmarks updates a single bookmark by name+frequency or replaces all bookmarks
func (ah *AdminHandler) handleUpdateBookmarks(w http.ResponseWriter, r *http.Request) {
	nameParam := r.URL.Query().Get("name")
	freqParam := r.URL.Query().Get("frequency")

	// If no name/frequency provided, replace all bookmarks (for import functionality)
	if nameParam == "" || freqParam == "" {
		var bookmarksConfig map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&bookmarksConfig); err != nil {
			http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
			return
		}

		// Backup existing file with timestamp before replacing
		bookmarksPath := ah.getConfigPath("bookmarks.yaml")
		if _, err := os.Stat(bookmarksPath); err == nil {
			// File exists, create backup with timestamp
			timestamp := time.Now().Format("20060102-150405")
			backupPath := fmt.Sprintf("%s.%s", bookmarksPath, timestamp)
			if err := os.Rename(bookmarksPath, backupPath); err != nil {
				log.Printf("Warning: Failed to backup bookmarks.yaml: %v", err)
			} else {
				log.Printf("Backed up bookmarks.yaml to %s", backupPath)
			}
		}

		// Convert to YAML and write to file
		yamlData, err := yaml.Marshal(bookmarksConfig)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
			return
		}

		if err := os.WriteFile(bookmarksPath, yamlData, 0644); err != nil {
			http.Error(w, fmt.Sprintf("Failed to write bookmarks file: %v", err), http.StatusInternalServerError)
			return
		}

		// Reload bookmarks into memory
		if err := ah.reloadBookmarks(); err != nil {
			log.Printf("Warning: Failed to reload bookmarks after update: %v", err)
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "Bookmarks updated successfully",
		})
		return
	}

	// Update single bookmark by name+frequency
	originalFreq, err := strconv.ParseUint(freqParam, 10, 64)
	if err != nil {
		http.Error(w, "Invalid frequency parameter", http.StatusBadRequest)
		return
	}

	var updatedBookmark Bookmark
	if err := json.NewDecoder(r.Body).Decode(&updatedBookmark); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate bookmark
	if updatedBookmark.Name == "" || updatedBookmark.Frequency == 0 || updatedBookmark.Mode == "" {
		http.Error(w, "Name, frequency, and mode are required", http.StatusBadRequest)
		return
	}

	// Read existing bookmarks
	data, err := os.ReadFile(ah.getConfigPath("bookmarks.yaml"))
	if err != nil {
		http.Error(w, "Failed to read bookmarks file", http.StatusInternalServerError)
		return
	}

	var bookmarksConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &bookmarksConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	// Get bookmarks array
	bookmarks, ok := bookmarksConfig["bookmarks"].([]interface{})
	if !ok {
		http.Error(w, "Invalid bookmarks configuration", http.StatusInternalServerError)
		return
	}

	// Find bookmark by name+frequency
	bookmarkIndex := -1
	for i, bookmarkInterface := range bookmarks {
		if bookmarkMap, ok := bookmarkInterface.(map[string]interface{}); ok {
			name, nameOk := bookmarkMap["name"].(string)
			var freq uint64
			if freqVal, ok := bookmarkMap["frequency"].(uint64); ok {
				freq = freqVal
			} else if freqVal, ok := bookmarkMap["frequency"].(int); ok {
				freq = uint64(freqVal)
			}

			if nameOk && name == nameParam && freq == originalFreq {
				bookmarkIndex = i
				break
			}
		}
	}

	if bookmarkIndex == -1 {
		http.Error(w, fmt.Sprintf("Bookmark '%s' at %d Hz not found", nameParam, originalFreq), http.StatusNotFound)
		return
	}

	// Update bookmark at index
	bookmarkMap := map[string]interface{}{
		"name":      updatedBookmark.Name,
		"frequency": updatedBookmark.Frequency,
		"mode":      updatedBookmark.Mode,
	}
	// Only add optional fields if they are not empty
	if updatedBookmark.Group != "" {
		bookmarkMap["group"] = updatedBookmark.Group
	}
	if updatedBookmark.Extension != "" {
		bookmarkMap["extension"] = updatedBookmark.Extension
	}
	if updatedBookmark.Comment != "" {
		bookmarkMap["comment"] = updatedBookmark.Comment
	}
	bookmarks[bookmarkIndex] = bookmarkMap
	bookmarksConfig["bookmarks"] = bookmarks

	// Write back to file
	yamlData, err := yaml.Marshal(bookmarksConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("bookmarks.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bookmarks file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bookmarks into memory
	if err := ah.reloadBookmarks(); err != nil {
		log.Printf("Warning: Failed to reload bookmarks after update: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Bookmark updated successfully",
	})
}

// handleDeleteBookmark deletes a bookmark by name+frequency
func (ah *AdminHandler) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
	nameParam := r.URL.Query().Get("name")
	freqParam := r.URL.Query().Get("frequency")

	if nameParam == "" || freqParam == "" {
		http.Error(w, "Name and frequency parameters required", http.StatusBadRequest)
		return
	}

	freq, err := strconv.ParseUint(freqParam, 10, 64)
	if err != nil {
		http.Error(w, "Invalid frequency parameter", http.StatusBadRequest)
		return
	}

	// Read existing bookmarks
	data, err := os.ReadFile(ah.getConfigPath("bookmarks.yaml"))
	if err != nil {
		http.Error(w, "Failed to read bookmarks file", http.StatusInternalServerError)
		return
	}

	var bookmarksConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &bookmarksConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	// Get bookmarks array
	bookmarks, ok := bookmarksConfig["bookmarks"].([]interface{})
	if !ok {
		http.Error(w, "Invalid bookmarks configuration", http.StatusInternalServerError)
		return
	}

	// Find bookmark by name+frequency
	bookmarkIndex := -1
	for i, bookmarkInterface := range bookmarks {
		if bookmarkMap, ok := bookmarkInterface.(map[string]interface{}); ok {
			name, nameOk := bookmarkMap["name"].(string)
			var bookmarkFreq uint64
			if freqVal, ok := bookmarkMap["frequency"].(uint64); ok {
				bookmarkFreq = freqVal
			} else if freqVal, ok := bookmarkMap["frequency"].(int); ok {
				bookmarkFreq = uint64(freqVal)
			}

			if nameOk && name == nameParam && bookmarkFreq == freq {
				bookmarkIndex = i
				break
			}
		}
	}

	if bookmarkIndex == -1 {
		http.Error(w, fmt.Sprintf("Bookmark '%s' at %d Hz not found", nameParam, freq), http.StatusNotFound)
		return
	}

	// Remove bookmark at index
	bookmarks = append(bookmarks[:bookmarkIndex], bookmarks[bookmarkIndex+1:]...)
	bookmarksConfig["bookmarks"] = bookmarks

	// Write back to file
	yamlData, err := yaml.Marshal(bookmarksConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("bookmarks.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bookmarks file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bookmarks into memory
	if err := ah.reloadBookmarks(); err != nil {
		log.Printf("Warning: Failed to reload bookmarks after delete: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Bookmark deleted successfully",
	})
}

// reloadBookmarks reloads bookmarks from bookmarks.yaml into memory
func (ah *AdminHandler) reloadBookmarks() error {
	bookmarksConfig, err := LoadConfig(ah.getConfigPath("bookmarks.yaml"))
	if err != nil {
		return fmt.Errorf("failed to reload bookmarks: %w", err)
	}
	ah.config.Bookmarks = bookmarksConfig.Bookmarks
	log.Printf("Reloaded %d bookmarks from bookmarks.yaml", len(ah.config.Bookmarks))
	return nil
}

// HandleBands handles GET, POST, PUT, DELETE requests for bands
func (ah *AdminHandler) HandleBands(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetBands(w, r)
	case http.MethodPost:
		ah.handleAddBand(w, r)
	case http.MethodPut:
		ah.handleUpdateBands(w, r)
	case http.MethodDelete:
		ah.handleDeleteBand(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetBands returns all bands sorted by group name, then by start frequency
func (ah *AdminHandler) handleGetBands(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(ah.getConfigPath("bands.yaml"))
	if err != nil {
		// If file doesn't exist, return empty bands
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"bands": []interface{}{}})
		return
	}

	var bandsConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &bandsConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse bands: %v", err), http.StatusInternalServerError)
		return
	}

	// Sort bands by group name (case-insensitive), then by start frequency
	if bands, ok := bandsConfig["bands"].([]interface{}); ok {
		sort.Slice(bands, func(i, j int) bool {
			bandI, okI := bands[i].(map[string]interface{})
			bandJ, okJ := bands[j].(map[string]interface{})
			if !okI || !okJ {
				return false
			}

			// Get group names (empty string if not present)
			groupI, _ := bandI["group"].(string)
			groupJ, _ := bandJ["group"].(string)

			// Compare groups (case-insensitive)
			lowerGroupI := strings.ToLower(groupI)
			lowerGroupJ := strings.ToLower(groupJ)
			if lowerGroupI != lowerGroupJ {
				return lowerGroupI < lowerGroupJ
			}

			// If groups are equal, compare start frequencies
			startI, okI := bandI["start"].(uint64)
			startJ, okJ := bandJ["start"].(uint64)
			if okI && okJ {
				return startI < startJ
			}
			// Handle int type as well (YAML might parse as int)
			if !okI {
				if startIntI, ok := bandI["start"].(int); ok {
					startI = uint64(startIntI)
					okI = true
				}
			}
			if !okJ {
				if startIntJ, ok := bandJ["start"].(int); ok {
					startJ = uint64(startIntJ)
					okJ = true
				}
			}
			if okI && okJ {
				return startI < startJ
			}
			return false
		})
		bandsConfig["bands"] = bands
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(bandsConfig)
}

// validateAndClampBandFrequencies validates and clamps band frequencies to the valid range (100 kHz - 30 MHz)
// Returns error if band is completely outside the valid range, otherwise clamps and returns nil
func validateAndClampBandFrequencies(band *Band) error {
	const minFreq uint64 = 100000   // 100 kHz in Hz
	const maxFreq uint64 = 30000000 // 30 MHz in Hz

	// Reject bands that end below 100 kHz or start above 30 MHz
	if band.End < minFreq {
		return fmt.Errorf("band ends below minimum frequency (100 kHz)")
	}
	if band.Start > maxFreq {
		return fmt.Errorf("band starts above maximum frequency (30 MHz)")
	}

	// Clamp start frequency to 100 kHz minimum
	if band.Start < minFreq {
		log.Printf("Clamping band '%s' start frequency from %d Hz to %d Hz (100 kHz)", band.Label, band.Start, minFreq)
		band.Start = minFreq
	}

	// Clamp end frequency to 30 MHz maximum
	if band.End > maxFreq {
		log.Printf("Clamping band '%s' end frequency from %d Hz to %d Hz (30 MHz)", band.Label, band.End, maxFreq)
		band.End = maxFreq
	}

	return nil
}

// handleAddBand adds a new band
func (ah *AdminHandler) handleAddBand(w http.ResponseWriter, r *http.Request) {
	var newBand Band
	if err := json.NewDecoder(r.Body).Decode(&newBand); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate band
	if newBand.Label == "" || newBand.Start == 0 || newBand.End == 0 {
		http.Error(w, "Label, start, and end are required", http.StatusBadRequest)
		return
	}

	if newBand.Start >= newBand.End {
		http.Error(w, "Start frequency must be less than end frequency", http.StatusBadRequest)
		return
	}

	// Validate and clamp frequencies to valid range (100 kHz - 30 MHz)
	if err := validateAndClampBandFrequencies(&newBand); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Read existing bands
	var bandsConfig map[string]interface{}
	data, err := os.ReadFile(ah.getConfigPath("bands.yaml"))
	if err == nil {
		yaml.Unmarshal(data, &bandsConfig)
	} else {
		bandsConfig = make(map[string]interface{})
	}

	// Get bands array
	var bands []interface{}
	if existing, ok := bandsConfig["bands"].([]interface{}); ok {
		bands = existing
	}

	// Check for duplicate label
	for _, bandInterface := range bands {
		if bandMap, ok := bandInterface.(map[string]interface{}); ok {
			if label, ok := bandMap["label"].(string); ok && label == newBand.Label {
				http.Error(w, fmt.Sprintf("A band with label '%s' already exists", newBand.Label), http.StatusConflict)
				return
			}
		}
	}

	// Add new band
	bandMap := map[string]interface{}{
		"label": newBand.Label,
		"start": newBand.Start,
		"end":   newBand.End,
	}
	if newBand.Group != "" {
		bandMap["group"] = newBand.Group
	}
	if newBand.Mode != "" {
		bandMap["mode"] = newBand.Mode
	}
	bands = append(bands, bandMap)
	bandsConfig["bands"] = bands

	// Write back to file
	yamlData, err := yaml.Marshal(bandsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("bands.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bands file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bands into memory
	if err := ah.reloadBands(); err != nil {
		log.Printf("Warning: Failed to reload bands after add: %v", err)
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Band added successfully",
	})
}

// handleUpdateBands updates a single band by label or replaces all bands
func (ah *AdminHandler) handleUpdateBands(w http.ResponseWriter, r *http.Request) {
	labelParam := r.URL.Query().Get("label")

	// If no label provided, replace all bands (for import functionality)
	if labelParam == "" {
		var bandsConfig map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&bandsConfig); err != nil {
			http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
			return
		}

		// Validate and clamp all imported bands
		if bandsArray, ok := bandsConfig["bands"].([]interface{}); ok {
			validBands := []interface{}{}
			skippedCount := 0

			for _, bandInterface := range bandsArray {
				bandMap, ok := bandInterface.(map[string]interface{})
				if !ok {
					continue
				}

				// Convert to Band struct for validation
				band := Band{
					Label: fmt.Sprintf("%v", bandMap["label"]),
				}

				// Parse start frequency
				switch v := bandMap["start"].(type) {
				case float64:
					band.Start = uint64(v)
				case int:
					band.Start = uint64(v)
				case int64:
					band.Start = uint64(v)
				case uint64:
					band.Start = v
				}

				// Parse end frequency
				switch v := bandMap["end"].(type) {
				case float64:
					band.End = uint64(v)
				case int:
					band.End = uint64(v)
				case int64:
					band.End = uint64(v)
				case uint64:
					band.End = v
				}

				// Parse optional fields
				if group, ok := bandMap["group"].(string); ok {
					band.Group = group
				}
				if mode, ok := bandMap["mode"].(string); ok {
					band.Mode = mode
				}

				// Validate basic requirements
				if band.Label == "" || band.Start == 0 || band.End == 0 {
					skippedCount++
					continue
				}

				if band.Start >= band.End {
					skippedCount++
					continue
				}

				// Validate and clamp frequencies
				if err := validateAndClampBandFrequencies(&band); err != nil {
					log.Printf("Skipping band '%s': %v", band.Label, err)
					skippedCount++
					continue
				}

				// Update the map with clamped values
				bandMap["start"] = band.Start
				bandMap["end"] = band.End
				validBands = append(validBands, bandMap)
			}

			bandsConfig["bands"] = validBands

			if skippedCount > 0 {
				log.Printf("Skipped %d invalid band(s) during import", skippedCount)
			}
		}

		// Backup existing file with timestamp before replacing
		bandsPath := ah.getConfigPath("bands.yaml")
		if _, err := os.Stat(bandsPath); err == nil {
			// File exists, create backup with timestamp
			timestamp := time.Now().Format("20060102-150405")
			backupPath := fmt.Sprintf("%s.%s", bandsPath, timestamp)
			if err := os.Rename(bandsPath, backupPath); err != nil {
				log.Printf("Warning: Failed to backup bands.yaml: %v", err)
			} else {
				log.Printf("Backed up bands.yaml to %s", backupPath)
			}
		}

		// Convert to YAML and write to file
		yamlData, err := yaml.Marshal(bandsConfig)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
			return
		}

		if err := os.WriteFile(bandsPath, yamlData, 0644); err != nil {
			http.Error(w, fmt.Sprintf("Failed to write bands file: %v", err), http.StatusInternalServerError)
			return
		}

		// Reload bands into memory
		if err := ah.reloadBands(); err != nil {
			log.Printf("Warning: Failed to reload bands after update: %v", err)
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "Bands updated successfully",
		})
		return
	}

	// Update single band by label
	var updatedBand Band
	if err := json.NewDecoder(r.Body).Decode(&updatedBand); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate band
	if updatedBand.Label == "" || updatedBand.Start == 0 || updatedBand.End == 0 {
		http.Error(w, "Label, start, and end are required", http.StatusBadRequest)
		return
	}

	if updatedBand.Start >= updatedBand.End {
		http.Error(w, "Start frequency must be less than end frequency", http.StatusBadRequest)
		return
	}

	// Validate and clamp frequencies to valid range (100 kHz - 30 MHz)
	if err := validateAndClampBandFrequencies(&updatedBand); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Read existing bands
	data, err := os.ReadFile(ah.getConfigPath("bands.yaml"))
	if err != nil {
		http.Error(w, "Failed to read bands file", http.StatusInternalServerError)
		return
	}

	var bandsConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &bandsConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse bands: %v", err), http.StatusInternalServerError)
		return
	}

	// Get bands array
	bands, ok := bandsConfig["bands"].([]interface{})
	if !ok {
		http.Error(w, "Invalid bands configuration", http.StatusInternalServerError)
		return
	}

	// Find band by label
	bandIndex := -1
	for i, bandInterface := range bands {
		if bandMap, ok := bandInterface.(map[string]interface{}); ok {
			if label, ok := bandMap["label"].(string); ok && label == labelParam {
				bandIndex = i
				break
			}
		}
	}

	if bandIndex == -1 {
		http.Error(w, fmt.Sprintf("Band with label '%s' not found", labelParam), http.StatusNotFound)
		return
	}

	// Check for duplicate labels (if label is being changed)
	if updatedBand.Label != labelParam {
		for i, bandInterface := range bands {
			if i == bandIndex {
				continue // Skip the band we're editing
			}
			if bandMap, ok := bandInterface.(map[string]interface{}); ok {
				if label, ok := bandMap["label"].(string); ok && label == updatedBand.Label {
					http.Error(w, fmt.Sprintf("A band with label '%s' already exists", updatedBand.Label), http.StatusConflict)
					return
				}
			}
		}
	}

	// Update band at index
	bandMap := map[string]interface{}{
		"label": updatedBand.Label,
		"start": updatedBand.Start,
		"end":   updatedBand.End,
	}
	if updatedBand.Group != "" {
		bandMap["group"] = updatedBand.Group
	}
	if updatedBand.Mode != "" {
		bandMap["mode"] = updatedBand.Mode
	}
	bands[bandIndex] = bandMap
	bandsConfig["bands"] = bands

	// Write back to file
	yamlData, err := yaml.Marshal(bandsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("bands.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bands file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bands into memory
	if err := ah.reloadBands(); err != nil {
		log.Printf("Warning: Failed to reload bands after update: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Band updated successfully",
	})
}

// handleDeleteBand deletes a band by label
func (ah *AdminHandler) handleDeleteBand(w http.ResponseWriter, r *http.Request) {
	labelParam := r.URL.Query().Get("label")
	if labelParam == "" {
		http.Error(w, "Label parameter required", http.StatusBadRequest)
		return
	}

	// Read existing bands
	data, err := os.ReadFile(ah.getConfigPath("bands.yaml"))
	if err != nil {
		http.Error(w, "Failed to read bands file", http.StatusInternalServerError)
		return
	}

	var bandsConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &bandsConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse bands: %v", err), http.StatusInternalServerError)
		return
	}

	// Get bands array
	bands, ok := bandsConfig["bands"].([]interface{})
	if !ok {
		http.Error(w, "Invalid bands configuration", http.StatusInternalServerError)
		return
	}

	// Find band by label
	bandIndex := -1
	for i, bandInterface := range bands {
		if bandMap, ok := bandInterface.(map[string]interface{}); ok {
			if label, ok := bandMap["label"].(string); ok && label == labelParam {
				bandIndex = i
				break
			}
		}
	}

	if bandIndex == -1 {
		http.Error(w, fmt.Sprintf("Band with label '%s' not found", labelParam), http.StatusNotFound)
		return
	}

	// Remove band at index
	bands = append(bands[:bandIndex], bands[bandIndex+1:]...)
	bandsConfig["bands"] = bands

	// Write back to file
	yamlData, err := yaml.Marshal(bandsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("bands.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bands file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bands into memory
	if err := ah.reloadBands(); err != nil {
		log.Printf("Warning: Failed to reload bands after delete: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Band deleted successfully",
	})
}

// reloadBands reloads bands from bands.yaml into memory
func (ah *AdminHandler) reloadBands() error {
	bandsConfig, err := LoadConfig(ah.getConfigPath("bands.yaml"))
	if err != nil {
		return fmt.Errorf("failed to reload bands: %w", err)
	}
	ah.config.Bands = bandsConfig.Bands
	log.Printf("Reloaded %d bands from bands.yaml", len(ah.config.Bands))
	return nil
}

// HandleSessions returns information about all active sessions
func (ah *AdminHandler) HandleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	sessions := ah.sessions.GetAllSessionsInfo()

	// Enhance with chat usernames and LastSeen if DX cluster websocket handler (with chat) is available
	if ah.dxClusterWsHandler != nil && ah.dxClusterWsHandler.chatManager != nil {
		for i := range sessions {
			if userSessionID, ok := sessions[i]["user_session_id"].(string); ok && userSessionID != "" {
				if username, exists := ah.dxClusterWsHandler.chatManager.GetUsername(userSessionID); exists {
					sessions[i]["chat_username"] = username

					// Add LastSeen time if available
					if lastSeen, exists := ah.dxClusterWsHandler.chatManager.GetUserLastSeen(userSessionID); exists {
						// Calculate time ago
						secondsAgo := int(time.Since(lastSeen).Seconds())
						sessions[i]["chat_last_seen_seconds"] = secondsAgo
					}
				}
			}
		}
	}

	// Enhance with GeoIP coordinates if GeoIP service is available
	if ah.geoIPService != nil && ah.geoIPService.IsEnabled() {
		for i := range sessions {
			if clientIP, ok := sessions[i]["client_ip"].(string); ok && clientIP != "" {
				// Perform GeoIP lookup
				if result, err := ah.geoIPService.Lookup(clientIP); err == nil {
					// Add latitude and longitude if available
					if result.Latitude != nil {
						sessions[i]["latitude"] = *result.Latitude
					}
					if result.Longitude != nil {
						sessions[i]["longitude"] = *result.Longitude
					}
					// Add accuracy radius if available
					if result.AccuracyRadius != nil {
						sessions[i]["accuracy_radius_km"] = *result.AccuracyRadius
					}
				}
			}
		}
	}

	response := map[string]interface{}{
		"sessions": sessions,
		"count":    len(sessions),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding sessions: %v", err)
	}
}

// HandleFrontendStatus returns the SDR frontend status from the wideband spectrum channel
func (ah *AdminHandler) HandleFrontendStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Find the wideband spectrum session (pattern: "noisefloor-wideband-XXXXXXXX")
	ah.sessions.mu.RLock()
	var widebandSSRC uint32
	found := false
	for id, session := range ah.sessions.sessions {
		if len(id) >= 19 && id[:19] == "noisefloor-wideband" {
			widebandSSRC = session.SSRC
			found = true
			break
		}
	}
	ah.sessions.mu.RUnlock()

	if !found {
		http.Error(w, "Wideband spectrum channel not found", http.StatusNotFound)
		return
	}

	// Get frontend status for the wideband channel
	frontendStatus := ah.sessions.radiod.GetFrontendStatus(widebandSSRC)
	if frontendStatus == nil {
		http.Error(w, "Frontend status not available", http.StatusServiceUnavailable)
		return
	}

	// Helper function to sanitize float values for JSON (replace Inf/NaN with nil)
	sanitizeFloat := func(f float32) interface{} {
		if math.IsInf(float64(f), 0) || math.IsNaN(float64(f)) {
			return nil
		}
		return f
	}

	// Calculate time since last overrange if we have sample rate
	var timeSinceOverrange string
	if frontendStatus.InputSamprate > 0 && frontendStatus.SamplesSinceOver > 0 {
		seconds := float64(frontendStatus.SamplesSinceOver) / float64(frontendStatus.InputSamprate)
		duration := time.Duration(seconds * float64(time.Second))

		// Format as "Xd Yh Zm" or "Xh Ym Zs" or "Xm Ys" or "Xs"
		totalSeconds := int64(duration.Seconds())
		days := totalSeconds / 86400
		hours := (totalSeconds % 86400) / 3600
		minutes := (totalSeconds % 3600) / 60
		secs := totalSeconds % 60

		if days > 0 {
			timeSinceOverrange = fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
		} else if hours > 0 {
			timeSinceOverrange = fmt.Sprintf("%dh %dm %ds", hours, minutes, secs)
		} else if minutes > 0 {
			timeSinceOverrange = fmt.Sprintf("%dm %ds", minutes, secs)
		} else {
			timeSinceOverrange = fmt.Sprintf("%ds", secs)
		}
	} else {
		timeSinceOverrange = "N/A"
	}

	// Calculate overrange ratio as "seconds worth of overranges"
	// This represents how many seconds it would take to accumulate this many overranges
	// if every sample overranged continuously. It's a cumulative metric, not a rate.
	var overrangeSeconds float64
	if frontendStatus.InputSamprate > 0 {
		overrangeSeconds = float64(frontendStatus.ADOverranges) / float64(frontendStatus.InputSamprate)
	}

	// A/D overranges are informational only - they don't affect health status.
	// The cumulative count (ad_overranges) increases over the lifetime of radiod
	// and doesn't indicate current overload conditions without additional context.
	// Use samples_since_over and time_since_overrange for recent overrange detection.
	healthy := true
	status := "ok"
	issues := []string{}

	// Calculate FFT parameters if we have the necessary data
	var fftSize int
	var fftType string
	var blockTimeMs, blockRateHz, overlapPercent, binWidthHz float64

	if frontendStatus.FilterBlocksize > 0 && frontendStatus.FilterFirLength > 0 {
		fftSize = frontendStatus.FilterBlocksize + frontendStatus.FilterFirLength - 1
		if frontendStatus.FeIsReal {
			fftType = "real-to-complex"
		} else {
			fftType = "complex-to-complex"
		}

		if frontendStatus.InputSamprate > 0 {
			blockTimeMs = 1000.0 * float64(frontendStatus.FilterBlocksize) / float64(frontendStatus.InputSamprate)
			blockRateHz = 1000.0 / blockTimeMs
			overlapPercent = 100.0 / (1.0 + float64(frontendStatus.FilterBlocksize)/float64(frontendStatus.FilterFirLength-1))
			binWidthHz = float64(frontendStatus.InputSamprate) / float64(fftSize)
		}
	}

	// Calculate input power in dBm (same logic as control.c line 1413-1414)
	// Input dBm = IF Power (dBFS) - (RF Gain - RF Atten + RF Level Cal)
	// Note: IF Power is already in dBFS (dB), not linear, so we don't need power2dB conversion
	var inputPowerDBm interface{}
	if frontendStatus.IFPower > -200 && !math.IsNaN(float64(frontendStatus.IFPower)) && !math.IsInf(float64(frontendStatus.IFPower), 0) {
		// IF power is already in dBFS, just subtract the net RF gain
		netRFGain := float64(frontendStatus.RFGain - frontendStatus.RFAtten + frontendStatus.RFLevelCal)
		dbmValue := float64(frontendStatus.IFPower) - netRFGain
		// Sanitize the result
		if !math.IsNaN(dbmValue) && !math.IsInf(dbmValue, 0) {
			inputPowerDBm = dbmValue
		}
	}

	response := map[string]interface{}{
		"lna_gain":             frontendStatus.LNAGain,
		"mixer_gain":           frontendStatus.MixerGain,
		"if_gain":              frontendStatus.IFGain,
		"rf_gain":              sanitizeFloat(frontendStatus.RFGain),
		"rf_atten":             sanitizeFloat(frontendStatus.RFAtten),
		"rf_agc":               frontendStatus.RFAGC,
		"if_power":             sanitizeFloat(frontendStatus.IFPower),
		"rf_level_cal":         sanitizeFloat(frontendStatus.RFLevelCal),
		"input_power_dbm":      inputPowerDBm,
		"ad_overranges":        frontendStatus.ADOverranges,
		"overrange_seconds":    overrangeSeconds,
		"samples_since_over":   frontendStatus.SamplesSinceOver,
		"time_since_overrange": timeSinceOverrange,
		"input_samprate":       frontendStatus.InputSamprate,
		"filter_blocksize":     frontendStatus.FilterBlocksize,
		"filter_fir_length":    frontendStatus.FilterFirLength,
		"fe_is_real":           frontendStatus.FeIsReal,
		"fft_size":             fftSize,
		"fft_type":             fftType,
		"block_time_ms":        blockTimeMs,
		"block_rate_hz":        blockRateHz,
		"overlap_percent":      overlapPercent,
		"bin_width_hz":         binWidthHz,
		"last_update":          frontendStatus.LastUpdate.Format(time.RFC3339),
		"healthy":              healthy,
		"status":               status,
		"issues":               issues,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding frontend status: %v", err)
	}
}

// HandleFrontendHistory returns the 60-minute frontend history data
func (ah *AdminHandler) HandleFrontendHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if frontend history tracker exists
	if ah.frontendHistory == nil {
		http.Error(w, "Frontend history tracker not initialized", http.StatusServiceUnavailable)
		return
	}

	// Get history data
	history := ah.frontendHistory.GetHistory()

	response := map[string]interface{}{
		"history": history,
		"count":   len(history),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding frontend history: %v", err)
	}
}

// HandleFrontendHourlyHistory returns the 24-hour frontend history data
func (ah *AdminHandler) HandleFrontendHourlyHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if frontend history tracker exists
	if ah.frontendHistory == nil {
		http.Error(w, "Frontend history tracker not initialized", http.StatusServiceUnavailable)
		return
	}

	// Get hourly history data
	hourlyHistory := ah.frontendHistory.GetHourlyHistory()

	response := map[string]interface{}{
		"history": hourlyHistory,
		"count":   len(hourlyHistory),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding frontend hourly history: %v", err)
	}
}

// HandleChannelStatus returns the audio channel status for a given SSRC
// This endpoint is used to get per-channel status information for active audio sessions
func (ah *AdminHandler) HandleChannelStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Get SSRC parameter from query string
	ssrcParam := r.URL.Query().Get("ssrc")
	if ssrcParam == "" {
		http.Error(w, "SSRC parameter required", http.StatusBadRequest)
		return
	}

	// Parse SSRC (hex format: 0x12345678)
	var ssrc uint32
	if strings.HasPrefix(ssrcParam, "0x") || strings.HasPrefix(ssrcParam, "0X") {
		// Hex format
		val, err := strconv.ParseUint(ssrcParam[2:], 16, 32)
		if err != nil {
			http.Error(w, fmt.Sprintf("Invalid SSRC format: %v", err), http.StatusBadRequest)
			return
		}
		ssrc = uint32(val)
	} else {
		// Decimal format
		val, err := strconv.ParseUint(ssrcParam, 10, 32)
		if err != nil {
			http.Error(w, fmt.Sprintf("Invalid SSRC format: %v", err), http.StatusBadRequest)
			return
		}
		ssrc = uint32(val)
	}

	// Get channel status for this SSRC
	channelStatus := ah.sessions.radiod.GetChannelStatus(ssrc)
	if channelStatus == nil {
		http.Error(w, "Channel status not available for this SSRC", http.StatusNotFound)
		return
	}

	// Helper function to sanitize float values for JSON (replace Inf/NaN with nil)
	sanitizeFloat32 := func(f float32) interface{} {
		if math.IsInf(float64(f), 0) || math.IsNaN(float64(f)) {
			return nil
		}
		return f
	}

	sanitizeFloat64 := func(f float64) interface{} {
		if math.IsInf(f, 0) || math.IsNaN(f) {
			return nil
		}
		return f
	}

	// Determine demod type string
	demodTypeStr := "Unknown"
	switch channelStatus.DemodType {
	case 0:
		demodTypeStr = "Linear"
	case 1:
		demodTypeStr = "FM"
	case 2:
		demodTypeStr = "WFM/Stereo"
	case 3:
		demodTypeStr = "Spectrum"
	}

	// Build response with audio channel status information
	response := map[string]interface{}{
		"ssrc":        fmt.Sprintf("0x%08x", ssrc),
		"last_update": channelStatus.LastUpdate.Format(time.RFC3339),

		// Identity & Basic Info
		"preset":     channelStatus.Preset,
		"demod_type": demodTypeStr,

		// Tuning Information
		"radio_frequency":   sanitizeFloat64(channelStatus.RadioFrequency),
		"freq_offset":       sanitizeFloat32(channelStatus.FreqOffset),
		"doppler_frequency": sanitizeFloat64(channelStatus.DopplerFrequency),

		// Signal Quality Metrics
		"baseband_power": sanitizeFloat32(channelStatus.BasebandPower),
		"noise_density":  sanitizeFloat32(channelStatus.NoiseDensity),
		"pll_snr":        sanitizeFloat32(channelStatus.PllSnr),
		"fm_snr":         sanitizeFloat32(channelStatus.FmSnr),
		"squelch_open":   sanitizeFloat32(channelStatus.SquelchOpen),

		// Output Status
		"output_samprate":     channelStatus.OutputSamprate,
		"output_level":        sanitizeFloat32(channelStatus.OutputLevel),
		"output_samples":      channelStatus.OutputSamples,
		"output_data_packets": channelStatus.OutputDataPackets,

		// Filter Settings
		"filter_low":   sanitizeFloat32(channelStatus.LowEdge),
		"filter_high":  sanitizeFloat32(channelStatus.HighEdge),
		"filter_drops": channelStatus.FilterDrops,

		// AGC/Gain Control
		"agc_enable": channelStatus.AgcEnable,
		"gain":       sanitizeFloat32(channelStatus.Gain),
		"headroom":   sanitizeFloat32(channelStatus.Headroom),

		// Demodulator Status
		"pll_lock":    channelStatus.PllLock,
		"envelope":    channelStatus.Envelope,
		"snr_squelch": channelStatus.SnrSquelch,

		// FM-Specific (when demod_type = FM)
		"peak_deviation": sanitizeFloat32(channelStatus.PeakDeviation),
		"pl_tone":        sanitizeFloat32(channelStatus.PlTone),
		"thresh_extend":  channelStatus.ThreshExtend,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding channel status: %v", err)
	}
}

// HandleSystemLoad returns system load averages from /proc/loadavg and CPU core count
func (ah *AdminHandler) HandleSystemLoad(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Read /proc/loadavg
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read /proc/loadavg: %v", err), http.StatusInternalServerError)
		return
	}

	// Parse the load averages
	// Format: "0.52 0.58 0.59 1/1234 12345"
	// We want the first three numbers (1, 5, 15 minute averages)
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		http.Error(w, "Invalid /proc/loadavg format", http.StatusInternalServerError)
		return
	}

	// Get CPU core count using gopsutil
	cpuCores := 0
	info, err := cpu.Info()
	if err == nil && len(info) > 0 {
		// Sum cores across all CPUs (for multi-socket systems)
		for _, cpuInfo := range info {
			cpuCores += int(cpuInfo.Cores)
		}
	}

	// Parse load values as floats for status calculation
	load1, _ := strconv.ParseFloat(fields[0], 64)
	load5, _ := strconv.ParseFloat(fields[1], 64)
	load15, _ := strconv.ParseFloat(fields[2], 64)

	// Calculate average load across all three periods
	avgLoad := (load1 + load5 + load15) / 3.0

	// Determine status based on average load vs CPU cores
	status := "ok"
	if cpuCores > 0 {
		if avgLoad >= float64(cpuCores)*2.0 {
			status = "critical"
		} else if avgLoad >= float64(cpuCores) {
			status = "warning"
		}
	}

	response := map[string]interface{}{
		"load_1min":  fields[0],
		"load_5min":  fields[1],
		"load_15min": fields[2],
		"cpu_cores":  cpuCores,
		"status":     status,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding system load: %v", err)
	}
}

// HandleKickUser kicks a user by invalidating their user_session_id
func (ah *AdminHandler) HandleKickUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		UserSessionID string `json:"user_session_id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.UserSessionID == "" {
		http.Error(w, "user_session_id is required", http.StatusBadRequest)
		return
	}

	// Kick all sessions with this user_session_id
	count, err := ah.sessions.KickUserBySessionID(req.UserSessionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "success",
		"message":          fmt.Sprintf("Kicked user (destroyed %d session(s))", count),
		"sessions_removed": count,
	}); err != nil {
		log.Printf("Error encoding kick response: %v", err)
	}
}

// HandleBanUser bans a user by IP address and kicks all their sessions
func (ah *AdminHandler) HandleBanUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		IP     string `json:"ip"`
		Reason string `json:"reason"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.IP == "" {
		http.Error(w, "IP address is required", http.StatusBadRequest)
		return
	}

	if req.Reason == "" {
		req.Reason = "Banned by admin"
	}

	// Ban the IP
	if err := ah.ipBanManager.BanIP(req.IP, req.Reason, "admin"); err != nil {
		http.Error(w, fmt.Sprintf("Failed to ban IP: %v", err), http.StatusInternalServerError)
		return
	}

	// Kick all sessions from this IP
	count, err := ah.sessions.KickUserByIP(req.IP)
	if err != nil {
		log.Printf("Error kicking sessions for banned IP %s: %v", req.IP, err)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "success",
		"message":          fmt.Sprintf("Banned IP %s and kicked %d session(s)", req.IP, count),
		"sessions_removed": count,
	}); err != nil {
		log.Printf("Error encoding ban response: %v", err)
	}
}

// HandleUnbanIP unbans an IP address
func (ah *AdminHandler) HandleUnbanIP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		IP string `json:"ip"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.IP == "" {
		http.Error(w, "IP address is required", http.StatusBadRequest)
		return
	}

	// Unban the IP
	if err := ah.ipBanManager.UnbanIP(req.IP); err != nil {
		http.Error(w, fmt.Sprintf("Failed to unban IP: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": fmt.Sprintf("Unbanned IP %s", req.IP),
	}); err != nil {
		log.Printf("Error encoding unban response: %v", err)
	}
}

// HandleBannedIPs returns the list of banned IPs
func (ah *AdminHandler) HandleBannedIPs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bannedIPs := ah.ipBanManager.GetBannedIPs()

	// Enrich banned IPs with country information
	type BannedIPWithCountry struct {
		BannedIP
		Country     string `json:"country,omitempty"`
		CountryCode string `json:"country_code,omitempty"`
	}

	enrichedIPs := make([]BannedIPWithCountry, 0, len(bannedIPs))
	for _, ban := range bannedIPs {
		enriched := BannedIPWithCountry{
			BannedIP: ban,
		}

		// Look up country information if GeoIP service is available
		if ah.geoIPService != nil {
			country, countryCode := ah.geoIPService.LookupSafe(ban.IP)
			enriched.Country = country
			enriched.CountryCode = countryCode
		}

		enrichedIPs = append(enrichedIPs, enriched)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"banned_ips": enrichedIPs,
		"count":      len(enrichedIPs),
	}); err != nil {
		log.Printf("Error encoding banned IPs: %v", err)
	}
}

// HandleExtensions returns the list of available decoder extensions (public endpoint)
func (ah *AdminHandler) HandleExtensions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Read manifest for each enabled extension from config
	extensions := []map[string]string{}
	for _, extName := range ah.config.Extensions {
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
		"default":   ah.config.DefaultExtension,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding extensions: %v", err)
	}
}

// HandleExtensionsAdmin handles GET and PUT requests for extensions management
func (ah *AdminHandler) HandleExtensionsAdmin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetExtensionsAdmin(w, r)
	case http.MethodPut:
		ah.handleUpdateExtensions(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetExtensionsAdmin returns all extensions configuration
func (ah *AdminHandler) handleGetExtensionsAdmin(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(ah.getConfigPath("extensions.yaml"))
	if err != nil {
		// If file doesn't exist, return empty extensions
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"extensions":        []string{},
			"default_extension": "",
		})
		return
	}

	var extensionsConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &extensionsConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse extensions: %v", err), http.StatusInternalServerError)
		return
	}

	// Ensure default_extension key exists in response
	if _, ok := extensionsConfig["default_extension"]; !ok {
		extensionsConfig["default_extension"] = ""
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(extensionsConfig)
}

// handleUpdateExtensions updates the entire extensions list
func (ah *AdminHandler) handleUpdateExtensions(w http.ResponseWriter, r *http.Request) {
	var extensionsConfig map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&extensionsConfig); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Convert to YAML and write to file
	yamlData, err := yaml.Marshal(extensionsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal extensions: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("extensions.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write extensions file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload extensions into memory
	if err := ah.reloadExtensions(); err != nil {
		log.Printf("Warning: Failed to reload extensions after update: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Extensions updated successfully",
	})
}

// reloadExtensions reloads extensions from extensions.yaml into memory
func (ah *AdminHandler) reloadExtensions() error {
	extensionsConfig, err := LoadConfig(ah.getConfigPath("extensions.yaml"))
	if err != nil {
		return fmt.Errorf("failed to reload extensions: %w", err)
	}
	ah.config.Extensions = extensionsConfig.Extensions
	ah.config.DefaultExtension = extensionsConfig.DefaultExtension
	log.Printf("Reloaded %d extensions from extensions.yaml (default: %s)", len(ah.config.Extensions), ah.config.DefaultExtension)
	return nil
}

// HandleAvailableExtensions returns all available extensions in static/extensions/
func (ah *AdminHandler) HandleAvailableExtensions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Read the static/extensions directory
	entries, err := os.ReadDir("static/extensions")
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read extensions directory: %v", err), http.StatusInternalServerError)
		return
	}

	availableExtensions := []map[string]interface{}{}
	enabledMap := make(map[string]bool)

	// Create a map of enabled extensions for quick lookup
	for _, ext := range ah.config.Extensions {
		enabledMap[ext] = true
	}

	// Scan each directory for extensions
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		extName := entry.Name()

		// Skip hidden directories and special files
		if strings.HasPrefix(extName, ".") || extName == "extensions.json" {
			continue
		}

		// Try to read the manifest
		manifestPath := fmt.Sprintf("static/extensions/%s/manifest.json", extName)
		manifestData, err := os.ReadFile(manifestPath)

		extInfo := map[string]interface{}{
			"slug":    extName,
			"enabled": enabledMap[extName],
		}

		if err != nil {
			// Extension exists but has no manifest
			extInfo["displayName"] = extName
			extInfo["description"] = "No manifest found"
			extInfo["hasManifest"] = false
		} else {
			// Parse manifest
			var manifest struct {
				Name        string `json:"name"`
				DisplayName string `json:"displayName"`
				Description string `json:"description"`
				Version     string `json:"version"`
				Author      string `json:"author"`
			}

			if err := json.Unmarshal(manifestData, &manifest); err != nil {
				extInfo["displayName"] = extName
				extInfo["description"] = "Invalid manifest"
				extInfo["hasManifest"] = false
			} else {
				extInfo["displayName"] = manifest.DisplayName
				extInfo["description"] = manifest.Description
				extInfo["version"] = manifest.Version
				extInfo["author"] = manifest.Author
				extInfo["hasManifest"] = true
			}
		}

		availableExtensions = append(availableExtensions, extInfo)
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"extensions": availableExtensions,
		"count":      len(availableExtensions),
	}); err != nil {
		log.Printf("Error encoding available extensions: %v", err)
	}
}

// SDRSharpRangeEntry represents a single band entry in SDR# XML format
type SDRSharpRangeEntry struct {
	MinFrequency int    `xml:"minFrequency,attr"`
	MaxFrequency int    `xml:"maxFrequency,attr"`
	Mode         string `xml:"mode,attr"`
	Label        string `xml:",chardata"`
}

// SDRSharpBands represents the root element of SDR# bands XML
type SDRSharpBands struct {
	XMLName xml.Name             `xml:"ArrayOfRangeEntry"`
	Entries []SDRSharpRangeEntry `xml:"RangeEntry"`
}

// HandleSDRSharpImport handles POST requests to import SDR# XML bands
func (ah *AdminHandler) HandleSDRSharpImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Read the XML data from request body
	xmlData, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read request body: %v", err), http.StatusBadRequest)
		return
	}

	// Parse XML
	var sdrBands SDRSharpBands
	if err := xml.Unmarshal(xmlData, &sdrBands); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse XML: %v", err), http.StatusBadRequest)
		return
	}

	if len(sdrBands.Entries) == 0 {
		http.Error(w, "No bands found in XML file", http.StatusBadRequest)
		return
	}

	// Convert SDR# bands to our format
	var bands []interface{}
	skippedCount := 0
	const minFreq = 100000    // 100 kHz in Hz
	const maxFreq = 30000000  // 30 MHz in Hz
	const cwCutoff = 10000000 // 10 MHz cutoff for CW mode conversion

	for _, entry := range sdrBands.Entries {
		// Skip bands that end below 100 kHz or start above 30 MHz
		if entry.MaxFrequency < minFreq || entry.MinFrequency > maxFreq {
			skippedCount++
			continue
		}

		// Skip if missing required fields
		if entry.Label == "" || entry.MinFrequency == 0 || entry.MaxFrequency == 0 {
			continue
		}

		// Clamp start frequency to 100 kHz if it's below the limit
		startFreq := entry.MinFrequency
		if startFreq < minFreq {
			startFreq = minFreq
		}

		// Clamp end frequency to 30 MHz if it exceeds the limit
		endFreq := entry.MaxFrequency
		if endFreq > maxFreq {
			endFreq = maxFreq
		}

		// Create band map
		bandMap := map[string]interface{}{
			"label": strings.TrimSpace(entry.Label),
			"start": startFreq,
			"end":   endFreq,
		}

		// Convert mode if present
		if entry.Mode != "" {
			modeLower := strings.ToLower(entry.Mode)
			if modeLower == "cw" {
				// Use 10 MHz cutoff for CW mode conversion
				if entry.MinFrequency < cwCutoff {
					bandMap["mode"] = "cwl"
				} else {
					bandMap["mode"] = "cwu"
				}
			} else {
				// Pass through other modes (usb, lsb, am, fm, etc.)
				bandMap["mode"] = modeLower
			}
		}

		bands = append(bands, bandMap)
	}

	if len(bands) == 0 {
		http.Error(w, "No valid bands found in XML file (all bands may be > 30 MHz)", http.StatusBadRequest)
		return
	}

	// Backup existing file with timestamp before replacing
	bandsPath := ah.getConfigPath("bands.yaml")
	if _, err := os.Stat(bandsPath); err == nil {
		// File exists, create backup with timestamp
		timestamp := time.Now().Format("20060102-150405")
		backupPath := fmt.Sprintf("%s.%s", bandsPath, timestamp)
		if err := os.Rename(bandsPath, backupPath); err != nil {
			log.Printf("Warning: Failed to backup bands.yaml: %v", err)
		} else {
			log.Printf("Backed up bands.yaml to %s", backupPath)
		}
	}

	// Create bands config
	bandsConfig := map[string]interface{}{
		"bands": bands,
	}

	// Convert to YAML and write to file
	yamlData, err := yaml.Marshal(bandsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(bandsPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write bands file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload bands into memory
	if err := ah.reloadBands(); err != nil {
		log.Printf("Warning: Failed to reload bands after SDR# import: %v", err)
	}

	// Build response message
	message := fmt.Sprintf("Successfully imported %d band(s) from SDR# XML", len(bands))
	if skippedCount > 0 {
		message += fmt.Sprintf(" (skipped %d band(s) outside 100 kHz - 30 MHz range)", skippedCount)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":        "success",
		"message":       message,
		"imported":      len(bands),
		"skipped":       skippedCount,
		"total_entries": len(sdrBands.Entries),
	})
}

// HandleDecoderConfig handles GET, POST, PUT, DELETE requests for decoder configuration
func (ah *AdminHandler) HandleDecoderConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetDecoderConfig(w, r)
	case http.MethodPut:
		ah.handleUpdateDecoderConfig(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetDecoderConfig returns the decoder configuration
func (ah *AdminHandler) handleGetDecoderConfig(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(ah.getConfigPath("decoder.yaml"))
	if err != nil {
		// If file doesn't exist, return default empty config
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"decoder": map[string]interface{}{
				"enabled":             false,
				"data_dir":            "decoder_data",
				"jt9_path":            "/usr/local/bin/jt9",
				"wsprd_path":          "/usr/local/bin/wsprd",
				"keep_wav":            false,
				"keep_logs":           false,
				"include_dead_time":   false,
				"receiver_callsign":   "N0CALL",
				"receiver_locator":    "IO86ha",
				"receiver_antenna":    "",
				"pskreporter_enabled": false,
				"wsprnet_enabled":     false,
				"bands":               []interface{}{},
			},
		})
		return
	}

	var decoderConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &decoderConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(decoderConfig)
}

// handleUpdateDecoderConfig updates the decoder configuration
func (ah *AdminHandler) handleUpdateDecoderConfig(w http.ResponseWriter, r *http.Request) {
	// Check for restart flag
	restart := r.URL.Query().Get("restart") == "true"

	var decoderConfig map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&decoderConfig); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Backup existing file with timestamp before replacing
	decoderPath := ah.getConfigPath("decoder.yaml")
	if _, err := os.Stat(decoderPath); err == nil {
		timestamp := time.Now().Format("20060102-150405")
		backupPath := fmt.Sprintf("%s.%s", decoderPath, timestamp)
		if err := os.Rename(decoderPath, backupPath); err != nil {
			log.Printf("Warning: Failed to backup decoder.yaml: %v", err)
		} else {
			log.Printf("Backed up decoder.yaml to %s", backupPath)
		}
	}

	// Convert to YAML and write to file
	yamlData, err := yaml.Marshal(decoderConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(decoderPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write decoder config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)

	if restart {
		// Trigger restart after response is sent
		ah.restartServer()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "success",
			"message": "Decoder configuration updated. Server is restarting...",
			"restart": true,
		})
	} else {
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "Decoder configuration updated. Restart server to apply changes.",
		})
	}
}

// HandleDecoderBands handles GET, POST, PUT, DELETE requests for decoder bands
func (ah *AdminHandler) HandleDecoderBands(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetDecoderBands(w, r)
	case http.MethodPost:
		ah.handleAddDecoderBand(w, r)
	case http.MethodPut:
		ah.handleUpdateDecoderBand(w, r)
	case http.MethodDelete:
		ah.handleDeleteDecoderBand(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetDecoderBands returns all decoder bands
func (ah *AdminHandler) handleGetDecoderBands(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(ah.getConfigPath("decoder.yaml"))
	if err != nil {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"bands": []interface{}{}})
		return
	}

	var decoderConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &decoderConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	decoder, ok := decoderConfig["decoder"].(map[string]interface{})
	if !ok {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"bands": []interface{}{}})
		return
	}

	bands, ok := decoder["bands"].([]interface{})
	if !ok {
		bands = []interface{}{}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{"bands": bands})
}

// validateDecoderBandName validates that a decoder band name contains only alphanumeric, dash, and underscore
func validateDecoderBandName(name string) error {
	if name == "" {
		return fmt.Errorf("name is required")
	}

	// Check if name contains only alphanumeric, dash, and underscore
	for _, char := range name {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_') {
			return fmt.Errorf("name must contain only alphanumeric characters, dashes (-), and underscores (_)")
		}
	}

	return nil
}

// checkDecoderBandDuplicates checks for duplicate names and frequencies in decoder bands
func checkDecoderBandDuplicates(bands []interface{}, newName string, newFreq interface{}, skipIndex int) error {
	// Convert newFreq to uint64 for comparison
	var newFreqUint64 uint64
	switch v := newFreq.(type) {
	case float64:
		newFreqUint64 = uint64(v)
	case int:
		newFreqUint64 = uint64(v)
	case int64:
		newFreqUint64 = uint64(v)
	case uint64:
		newFreqUint64 = v
	default:
		return fmt.Errorf("invalid frequency type")
	}

	for i, bandInterface := range bands {
		// Skip the current band if we're editing
		if i == skipIndex {
			continue
		}

		band, ok := bandInterface.(map[string]interface{})
		if !ok {
			continue
		}

		// Check for duplicate name
		if bandName, ok := band["name"].(string); ok && bandName == newName {
			return fmt.Errorf("a decoder band with the name \"%s\" already exists", newName)
		}

		// Check for duplicate frequency
		if bandFreq, ok := band["frequency"]; ok {
			var bandFreqUint64 uint64
			switch v := bandFreq.(type) {
			case float64:
				bandFreqUint64 = uint64(v)
			case int:
				bandFreqUint64 = uint64(v)
			case int64:
				bandFreqUint64 = uint64(v)
			case uint64:
				bandFreqUint64 = v
			}

			if bandFreqUint64 == newFreqUint64 {
				existingName := "unknown"
				if name, ok := band["name"].(string); ok {
					existingName = name
				}
				return fmt.Errorf("frequency %d Hz is already used by decoder band \"%s\"", newFreqUint64, existingName)
			}
		}
	}

	return nil
}

// handleAddDecoderBand adds a new decoder band
func (ah *AdminHandler) handleAddDecoderBand(w http.ResponseWriter, r *http.Request) {
	var newBand map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&newBand); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate required fields
	if newBand["name"] == "" || newBand["mode"] == "" || newBand["frequency"] == nil {
		http.Error(w, "Name, mode, and frequency are required", http.StatusBadRequest)
		return
	}

	// Validate name format
	name, ok := newBand["name"].(string)
	if !ok {
		http.Error(w, "Name must be a string", http.StatusBadRequest)
		return
	}

	if err := validateDecoderBandName(name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Read existing config
	data, err := os.ReadFile(ah.getConfigPath("decoder.yaml"))
	var decoderConfig map[string]interface{}
	if err == nil {
		yaml.Unmarshal(data, &decoderConfig)
	} else {
		decoderConfig = make(map[string]interface{})
	}

	decoder, ok := decoderConfig["decoder"].(map[string]interface{})
	if !ok {
		decoder = make(map[string]interface{})
		decoderConfig["decoder"] = decoder
	}

	bands, ok := decoder["bands"].([]interface{})
	if !ok {
		bands = []interface{}{}
	}

	// Check for duplicates (skipIndex = -1 means we're adding, not editing)
	if err := checkDecoderBandDuplicates(bands, name, newBand["frequency"], -1); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Add new band
	bands = append(bands, newBand)
	decoder["bands"] = bands

	// Write back to file with proper number formatting
	yamlData, err := marshalYAMLWithIntegerFrequencies(decoderConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("decoder.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write decoder config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Decoder band added successfully. Restart server to apply changes.",
	})
}

// handleUpdateDecoderBand updates a decoder band by index
func (ah *AdminHandler) handleUpdateDecoderBand(w http.ResponseWriter, r *http.Request) {
	indexStr := r.URL.Query().Get("index")
	if indexStr == "" {
		http.Error(w, "Index parameter required", http.StatusBadRequest)
		return
	}

	index, err := strconv.Atoi(indexStr)
	if err != nil {
		http.Error(w, "Invalid index", http.StatusBadRequest)
		return
	}

	var updatedBand map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updatedBand); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate required fields
	if updatedBand["name"] == "" || updatedBand["mode"] == "" || updatedBand["frequency"] == nil {
		http.Error(w, "Name, mode, and frequency are required", http.StatusBadRequest)
		return
	}

	// Validate name format
	name, ok := updatedBand["name"].(string)
	if !ok {
		http.Error(w, "Name must be a string", http.StatusBadRequest)
		return
	}

	if err := validateDecoderBandName(name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Read existing config
	data, err := os.ReadFile(ah.getConfigPath("decoder.yaml"))
	if err != nil {
		http.Error(w, "Failed to read decoder config file", http.StatusInternalServerError)
		return
	}

	var decoderConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &decoderConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	decoder, ok := decoderConfig["decoder"].(map[string]interface{})
	if !ok {
		http.Error(w, "Invalid decoder config structure", http.StatusInternalServerError)
		return
	}

	bands, ok := decoder["bands"].([]interface{})
	if !ok || index < 0 || index >= len(bands) {
		http.Error(w, "Invalid band index", http.StatusBadRequest)
		return
	}

	// Get the name from updatedBand for duplicate checking
	bandName, ok := updatedBand["name"].(string)
	if !ok {
		http.Error(w, "Name must be a string", http.StatusBadRequest)
		return
	}

	// Check for duplicates (pass the index we're editing to skip it in the check)
	if err := checkDecoderBandDuplicates(bands, bandName, updatedBand["frequency"], index); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Update band at index
	bands[index] = updatedBand
	decoder["bands"] = bands

	// Write back to file with proper number formatting
	yamlData, err := marshalYAMLWithIntegerFrequencies(decoderConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("decoder.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write decoder config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Decoder band updated successfully. Restart server to apply changes.",
	})
}

// handleDeleteDecoderBand deletes a decoder band by index
func (ah *AdminHandler) handleDeleteDecoderBand(w http.ResponseWriter, r *http.Request) {
	indexStr := r.URL.Query().Get("index")
	if indexStr == "" {
		http.Error(w, "Index parameter required", http.StatusBadRequest)
		return
	}

	index, err := strconv.Atoi(indexStr)
	if err != nil {
		http.Error(w, "Invalid index", http.StatusBadRequest)
		return
	}

	// Read existing config
	data, err := os.ReadFile(ah.getConfigPath("decoder.yaml"))
	if err != nil {
		http.Error(w, "Failed to read decoder config file", http.StatusInternalServerError)
		return
	}

	var decoderConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &decoderConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	decoder, ok := decoderConfig["decoder"].(map[string]interface{})
	if !ok {
		http.Error(w, "Invalid decoder config structure", http.StatusInternalServerError)
		return
	}

	bands, ok := decoder["bands"].([]interface{})
	if !ok || index < 0 || index >= len(bands) {
		http.Error(w, "Invalid band index", http.StatusBadRequest)
		return
	}

	// Remove band at index
	bands = append(bands[:index], bands[index+1:]...)
	decoder["bands"] = bands

	// Write back to file with proper number formatting
	yamlData, err := marshalYAMLWithIntegerFrequencies(decoderConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal decoder config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.getConfigPath("decoder.yaml"), yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write decoder config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Decoder band deleted successfully. Restart server to apply changes.",
	})
}

// HandleCWSkimmerConfig handles GET and PUT requests for CW Skimmer configuration
func (ah *AdminHandler) HandleCWSkimmerConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetCWSkimmerConfig(w, r)
	case http.MethodPut:
		ah.handleUpdateCWSkimmerConfig(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetCWSkimmerConfig returns the CW Skimmer configuration
func (ah *AdminHandler) handleGetCWSkimmerConfig(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(ah.getConfigPath("cwskimmer.yaml"))
	if err != nil {
		// If file doesn't exist, return default empty config
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"enabled":                   false,
			"host":                      "localhost",
			"port":                      7300,
			"callsign":                  "N0CALL",
			"reconnect_delay":           30,
			"keepalive_delay":           300,
			"spots_log_enabled":         true,
			"spots_log_data_dir":        "data/spots",
			"metrics_log_enabled":       false,
			"metrics_log_data_dir":      "data/cw_metrics",
			"metrics_log_interval_secs": 300,
			"metrics_summary_data_dir":  "data/cw_metrics_summary",
			"pskreporter_enabled":       false,
			"pskreporter_callsign":      "N0CALL",
			"pskreporter_locator":       "",
			"pskreporter_antenna":       "",
		})
		return
	}

	// Unmarshal into the proper struct to handle the YAML structure correctly
	var cwskimmerConfig CWSkimmerConfig
	if err := yaml.Unmarshal(data, &cwskimmerConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse CW Skimmer config: %v", err), http.StatusInternalServerError)
		return
	}

	// Convert struct to map for JSON response to maintain field names
	configMap := map[string]interface{}{
		"enabled":                   cwskimmerConfig.Enabled,
		"host":                      cwskimmerConfig.Host,
		"port":                      cwskimmerConfig.Port,
		"callsign":                  cwskimmerConfig.Callsign,
		"reconnect_delay":           cwskimmerConfig.ReconnectDelay,
		"keepalive_delay":           cwskimmerConfig.KeepAliveDelay,
		"spots_log_enabled":         cwskimmerConfig.SpotsLogEnabled,
		"spots_log_data_dir":        cwskimmerConfig.SpotsLogDataDir,
		"metrics_log_enabled":       cwskimmerConfig.MetricsLogEnabled,
		"metrics_log_data_dir":      cwskimmerConfig.MetricsLogDataDir,
		"metrics_log_interval_secs": cwskimmerConfig.MetricsLogIntervalSecs,
		"metrics_summary_data_dir":  cwskimmerConfig.MetricsSummaryDataDir,
		"pskreporter_enabled":       cwskimmerConfig.PSKReporterEnabled,
		"pskreporter_callsign":      cwskimmerConfig.PSKReporterCallsign,
		"pskreporter_locator":       cwskimmerConfig.PSKReporterLocator,
		"pskreporter_antenna":       cwskimmerConfig.PSKReporterAntenna,
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(configMap)
}

// handleUpdateCWSkimmerConfig updates the CW Skimmer configuration
func (ah *AdminHandler) handleUpdateCWSkimmerConfig(w http.ResponseWriter, r *http.Request) {
	// Check for restart flag
	restart := r.URL.Query().Get("restart") == "true"

	var cwskimmerConfig map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&cwskimmerConfig); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Backup existing file with timestamp before replacing
	cwskimmerPath := ah.getConfigPath("cwskimmer.yaml")
	if _, err := os.Stat(cwskimmerPath); err == nil {
		timestamp := time.Now().Format("20060102-150405")
		backupPath := fmt.Sprintf("%s.%s", cwskimmerPath, timestamp)
		if err := os.Rename(cwskimmerPath, backupPath); err != nil {
			log.Printf("Warning: Failed to backup cwskimmer.yaml: %v", err)
		} else {
			log.Printf("Backed up cwskimmer.yaml to %s", backupPath)
		}
	}

	// Convert to YAML and write to file
	yamlData, err := yaml.Marshal(cwskimmerConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal CW Skimmer config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(cwskimmerPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write CW Skimmer config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)

	if restart {
		// Trigger restart after response is sent
		ah.restartServer()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "success",
			"message": "CW Skimmer configuration updated. Server is restarting...",
			"restart": true,
		})
	} else {
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "CW Skimmer configuration updated. Restart server to apply changes.",
		})
	}
}

// HandleRadiodConfig handles GET and PUT requests for radiod configuration
func (ah *AdminHandler) HandleRadiodConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetRadiodConfig(w, r)
	case http.MethodPut:
		ah.handleUpdateRadiodConfig(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetRadiodConfig returns the radiod configuration file content
func (ah *AdminHandler) handleGetRadiodConfig(w http.ResponseWriter, r *http.Request) {
	// Read the radiod config file from /etc/ka9q-radio/radiod@ubersdr.conf
	radiodConfigPath := "/etc/ka9q-radio/radiod@ubersdr.conf"
	data, err := os.ReadFile(radiodConfigPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read radiod config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Return the raw config file content
	response := map[string]interface{}{
		"config": string(data),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding radiod config: %v", err)
	}
}

// handleUpdateRadiodConfig updates the radiod configuration file
func (ah *AdminHandler) handleUpdateRadiodConfig(w http.ResponseWriter, r *http.Request) {
	// Check for restart flag
	restart := r.URL.Query().Get("restart") == "true"

	// Read the raw config content from request body
	configContent, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read request body: %v", err), http.StatusBadRequest)
		return
	}

	// Backup existing file with timestamp before replacing
	radiodConfigPath := "/etc/ka9q-radio/radiod@ubersdr.conf"
	if _, err := os.Stat(radiodConfigPath); err == nil {
		timestamp := time.Now().Format("20060102-150405")
		backupPath := fmt.Sprintf("%s.%s", radiodConfigPath, timestamp)
		if err := os.Rename(radiodConfigPath, backupPath); err != nil {
			log.Printf("Warning: Failed to backup radiod config: %v", err)
		} else {
			log.Printf("Backed up radiod config to %s", backupPath)
		}
	}

	// Write the new config to file
	if err := os.WriteFile(radiodConfigPath, configContent, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write radiod config file: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Radiod configuration updated by admin")

	w.WriteHeader(http.StatusOK)

	if restart {
		// Trigger ubersdr restart (which will also trigger radiod restart via entrypoint.sh)
		// This ensures both radiod and ubersdr restart with the new config
		ah.restartServer()
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "success",
			"message": "Radiod configuration updated. Server is restarting...",
			"restart": true,
		}); err != nil {
			log.Printf("Error encoding response: %v", err)
		}
	} else {
		if err := json.NewEncoder(w).Encode(map[string]string{
			"status":  "success",
			"message": "Radiod configuration updated. Restart server to apply changes.",
		}); err != nil {
			log.Printf("Error encoding response: %v", err)
		}
	}
}

// HandleSystemStats returns system statistics by executing system commands
func (ah *AdminHandler) HandleSystemStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Execute system commands and capture output
	stats := make(map[string]interface{})

	// Get UberSDR process information using Go runtime
	uptime := time.Since(StartTime)
	days := int(uptime.Hours() / 24)
	hours := int(uptime.Hours()) % 24
	minutes := int(uptime.Minutes()) % 60
	seconds := int(uptime.Seconds()) % 60

	// Format uptime in a human-readable format
	var uptimeStr string
	if days > 0 {
		uptimeStr = fmt.Sprintf("%dd %02dh %02dm %02ds", days, hours, minutes, seconds)
	} else if hours > 0 {
		uptimeStr = fmt.Sprintf("%02dh %02dm %02ds", hours, minutes, seconds)
	} else {
		uptimeStr = fmt.Sprintf("%02dm %02ds", minutes, seconds)
	}
	stats["ubersdr_uptime"] = uptimeStr

	// Get memory statistics using Go runtime
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	// Format memory info
	allocMB := float64(m.Alloc) / 1024 / 1024
	sysMB := float64(m.Sys) / 1024 / 1024
	stats["ubersdr_memory"] = fmt.Sprintf("Alloc: %.1f MB, Sys: %.1f MB", allocMB, sysMB)

	// Additional Go runtime stats
	stats["ubersdr_goroutines"] = runtime.NumGoroutine()

	// Execute uptime
	uptimeCmd := exec.Command("uptime")
	if uptimeOutput, err := uptimeCmd.CombinedOutput(); err == nil {
		stats["uptime"] = string(uptimeOutput)
	} else {
		stats["uptime"] = fmt.Sprintf("Error: %v", err)
	}

	// Execute df -h
	dfCmd := exec.Command("df", "-h")
	if dfOutput, err := dfCmd.CombinedOutput(); err == nil {
		stats["disk"] = string(dfOutput)
	} else {
		stats["disk"] = fmt.Sprintf("Error: %v", err)
	}

	// Execute free -m
	freeCmd := exec.Command("free", "-m")
	if freeOutput, err := freeCmd.CombinedOutput(); err == nil {
		stats["memory"] = string(freeOutput)
	} else {
		stats["memory"] = fmt.Sprintf("Error: %v", err)
	}

	// Get data directory sizes using du -sh
	dataDirs := make(map[string]string)

	// Decoder metrics directory
	if ah.config.Decoder.Enabled && ah.config.Decoder.MetricsLogEnabled && ah.config.Decoder.MetricsLogDataDir != "" {
		if _, err := os.Stat(ah.config.Decoder.MetricsLogDataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.config.Decoder.MetricsLogDataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["decoder_metrics"] = string(duOutput)
			}
		}
	}

	// Decoder spots directory
	if ah.config.Decoder.Enabled && ah.config.Decoder.SpotsLogEnabled && ah.config.Decoder.SpotsLogDataDir != "" {
		if _, err := os.Stat(ah.config.Decoder.SpotsLogDataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.config.Decoder.SpotsLogDataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["decoder_spots"] = string(duOutput)
			}
		}
	}

	// Decoder metrics summary directory
	if ah.config.Decoder.Enabled && ah.config.Decoder.MetricsLogEnabled && ah.config.Decoder.MetricsSummaryDataDir != "" {
		if _, err := os.Stat(ah.config.Decoder.MetricsSummaryDataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.config.Decoder.MetricsSummaryDataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["decoder_summary"] = string(duOutput)
			}
		}
	}

	// Noise floor directory
	if ah.config.NoiseFloor.Enabled && ah.config.NoiseFloor.DataDir != "" {
		if _, err := os.Stat(ah.config.NoiseFloor.DataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.config.NoiseFloor.DataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["noisefloor"] = string(duOutput)
			}
		}
	}

	// Space weather directory
	if ah.config.SpaceWeather.Enabled && ah.config.SpaceWeather.LogToCSV && ah.config.SpaceWeather.DataDir != "" {
		if _, err := os.Stat(ah.config.SpaceWeather.DataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.config.SpaceWeather.DataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["spaceweather"] = string(duOutput)
			}
		}
	}

	// CW Skimmer spots directory
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled && ah.cwSkimmerConfig.SpotsLogEnabled && ah.cwSkimmerConfig.SpotsLogDataDir != "" {
		if _, err := os.Stat(ah.cwSkimmerConfig.SpotsLogDataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.cwSkimmerConfig.SpotsLogDataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["cwskimmer_spots"] = string(duOutput)
			}
		}
	}

	// CW Skimmer metrics directory
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled && ah.cwSkimmerConfig.MetricsLogEnabled && ah.cwSkimmerConfig.MetricsLogDataDir != "" {
		if _, err := os.Stat(ah.cwSkimmerConfig.MetricsLogDataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.cwSkimmerConfig.MetricsLogDataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["cwskimmer_metrics"] = string(duOutput)
			}
		}
	}

	// CW Skimmer summaries directory
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled && ah.cwSkimmerConfig.MetricsLogEnabled && ah.cwSkimmerConfig.MetricsSummaryDataDir != "" {
		if _, err := os.Stat(ah.cwSkimmerConfig.MetricsSummaryDataDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.cwSkimmerConfig.MetricsSummaryDataDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["cwskimmer_summaries"] = string(duOutput)
			}
		}
	}

	// Session activity directory
	if ah.config.Server.SessionActivityLogEnabled && ah.config.Server.SessionActivityLogDir != "" {
		if _, err := os.Stat(ah.config.Server.SessionActivityLogDir); err == nil {
			duCmd := exec.Command("du", "-sh", ah.config.Server.SessionActivityLogDir)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["session_activity"] = string(duOutput)
			}
		}
	}

	// Web log file (in the same directory as session_activity)
	if ah.config.Server.LogFile != "" && ah.config.Server.SessionActivityLogDir != "" {
		// Get the parent directory of session_activity
		logDir := ah.config.Server.SessionActivityLogDir
		// Remove trailing slash if present
		logDir = strings.TrimSuffix(logDir, "/")
		// Get parent directory
		lastSlash := strings.LastIndex(logDir, "/")
		if lastSlash > 0 {
			logDir = logDir[:lastSlash]
		} else {
			// If no slash found, use current directory
			logDir = "."
		}
		// Construct full path to web.log
		webLogPath := logDir + "/" + ah.config.Server.LogFile
		// Check if file exists before running du
		if _, err := os.Stat(webLogPath); err == nil {
			duCmd := exec.Command("du", "-sh", webLogPath)
			if duOutput, err := duCmd.CombinedOutput(); err == nil {
				dataDirs["web_log"] = string(duOutput)
			}
		}
	}

	// Add data directories to stats if any were found
	if len(dataDirs) > 0 {
		stats["data_directories"] = dataDirs
	}

	// Get IP address information via GoTTY if SSH proxy is enabled
	gottyClient := NewGoTTYClient(&ah.config.SSHProxy)
	if gottyClient != nil {
		if resp, err := gottyClient.ExecCommand("ip address show", 2); err == nil && resp.ExitCode == 0 {
			stats["ip_addresses"] = resp.Stdout
		}
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		log.Printf("Error encoding system stats: %v", err)
	}
}

// HandleCWSkimmerHealth serves the health status of the CW Skimmer client
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func (ah *AdminHandler) HandleCWSkimmerHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Build health status response
	status := map[string]interface{}{
		"enabled": ah.cwSkimmerConfig.Enabled,
		"healthy": false,
		"issues":  []string{},
	}

	// If not enabled, return early
	if !ah.cwSkimmerConfig.Enabled {
		status["issues"] = []string{"CW Skimmer is not enabled"}
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding CW Skimmer health status: %v", err)
		}
		return
	}

	// Check if client exists
	if ah.cwSkimmerClient == nil {
		status["issues"] = []string{"CW Skimmer client not initialized"}
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding CW Skimmer health status: %v", err)
		}
		return
	}

	// Get connection status
	connected := ah.cwSkimmerClient.IsConnected()
	status["connected"] = connected

	// Get last spot time (actual CW spots, not just ping/pong)
	ah.cwSkimmerClient.mu.RLock()
	lastSpot := ah.cwSkimmerClient.lastSpotTime
	lastActivity := ah.cwSkimmerClient.lastActivityTime
	ah.cwSkimmerClient.mu.RUnlock()

	// Report last spot time (actual CW activity)
	if !lastSpot.IsZero() {
		status["last_spot"] = lastSpot.Format(time.RFC3339)
		timeSinceSpot := time.Since(lastSpot)
		status["seconds_since_spot"] = int(timeSinceSpot.Seconds())

		// Format time since last spot in human-readable format
		status["time_since_spot"] = formatDuration(timeSinceSpot)

		// Consider recent if spot within last 5 minutes
		recentSpots := timeSinceSpot <= 5*time.Minute
		status["recent_spots"] = recentSpots

		if !recentSpots {
			status["issues"] = append(status["issues"].([]string),
				fmt.Sprintf("No CW spots for %d seconds", int(timeSinceSpot.Seconds())))
		}
	} else {
		status["last_spot"] = nil
		status["seconds_since_spot"] = nil
		status["time_since_spot"] = "N/A"
		status["recent_spots"] = false
		if connected {
			status["issues"] = append(status["issues"].([]string), "Connected but no spots received yet")
		}
	}

	// Also report last activity time (includes ping/pong for connection health)
	if !lastActivity.IsZero() {
		status["last_activity"] = lastActivity.Format(time.RFC3339)
		status["seconds_since_activity"] = int(time.Since(lastActivity).Seconds())
	} else {
		status["last_activity"] = nil
		status["seconds_since_activity"] = nil
	}

	// Check connection status
	if !connected {
		status["issues"] = append(status["issues"].([]string), "Not connected to CW Skimmer server")
	}

	// Determine overall health
	issues := status["issues"].([]string)
	if len(issues) == 0 {
		status["healthy"] = true
		w.WriteHeader(http.StatusOK)
	} else {
		status["healthy"] = false
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding CW Skimmer health status: %v", err)
	}
}

// HandleInstanceReporterHealth serves the health status of the instance reporter
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func (ah *AdminHandler) HandleInstanceReporterHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Build health status response
	status := map[string]interface{}{
		"enabled": ah.config.InstanceReporting.Enabled,
	}

	// If not enabled, return early
	if !ah.config.InstanceReporting.Enabled {
		status["message"] = "Instance reporting is not enabled"
		status["healthy"] = true // Not enabled is not unhealthy
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding instance reporter status: %v", err)
		}
		return
	}

	// Check if instance reporter exists
	if ah.instanceReporter == nil {
		status["message"] = "Instance reporter not initialized"
		status["healthy"] = false
		status["issues"] = []string{"Instance reporter not initialized"}
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding instance reporter status: %v", err)
		}
		return
	}

	// Get report status from instance reporter
	reportStatus := ah.instanceReporter.GetReportStatus()

	// Merge the report status into our response
	for k, v := range reportStatus {
		status[k] = v
	}

	// Determine health based on response code and status
	healthy := true
	issues := []string{}

	// Check if we have a last response code
	if lastCode, ok := status["last_response_code"].(int); ok {
		if lastCode != 200 {
			healthy = false
			issues = append(issues, fmt.Sprintf("Last HTTP response code was %d (expected 200)", lastCode))
		}
	} else {
		// No response code yet - not necessarily unhealthy if we haven't reported yet
		if lastError, ok := status["last_report_error"].(string); ok && lastError != "" {
			healthy = false
			issues = append(issues, fmt.Sprintf("Last report error: %s", lastError))
		}
	}

	// Check if status is "ok"
	if lastStatus, ok := status["last_response_status"].(string); ok {
		if lastStatus != "ok" {
			healthy = false
			issues = append(issues, fmt.Sprintf("Last response status was '%s' (expected 'ok')", lastStatus))
		}
	}

	// Check for errors
	if lastError, ok := status["last_report_error"].(string); ok && lastError != "" {
		healthy = false
		if len(issues) == 0 {
			issues = append(issues, fmt.Sprintf("Last report error: %s", lastError))
		}
	}

	status["healthy"] = healthy
	if len(issues) > 0 {
		status["issues"] = issues
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding instance reporter status: %v", err)
	}
}

// HandleTunnelServerHealth fetches and returns tunnel server health status
// This is a proxy endpoint that calls the tunnel server's /api/tunnel/status endpoint
func (ah *AdminHandler) HandleTunnelServerHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if tunnel server is enabled
	if !ah.config.InstanceReporting.TunnelServerEnabled {
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"enabled": false,
			"message": "Tunnel server integration is not enabled",
		}); err != nil {
			log.Printf("Error encoding tunnel health response: %v", err)
		}
		return
	}

	// Check if tunnel server host is configured
	if ah.config.InstanceReporting.TunnelServerHost == "" {
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "Tunnel server host not configured",
		}); err != nil {
			log.Printf("Error encoding tunnel health response: %v", err)
		}
		return
	}

	// Check if instance UUID is configured
	if ah.config.InstanceReporting.InstanceUUID == "" {
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "Instance UUID not configured",
		}); err != nil {
			log.Printf("Error encoding tunnel health response: %v", err)
		}
		return
	}

	// Build request to tunnel server
	tunnelURL := fmt.Sprintf("https://%s/api/tunnel/status", ah.config.InstanceReporting.TunnelServerHost)
	requestBody := map[string]string{
		"secret_uuid": ah.config.InstanceReporting.InstanceUUID,
	}

	requestData, err := json.Marshal(requestBody)
	if err != nil {
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": fmt.Sprintf("Failed to marshal request: %v", err),
		}); err != nil {
			log.Printf("Error encoding tunnel health response: %v", err)
		}
		return
	}

	// Make request to tunnel server with timeout
	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	resp, err := client.Post(tunnelURL, "application/json", strings.NewReader(string(requestData)))
	if err != nil {
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": fmt.Sprintf("Failed to connect to tunnel server: %v", err),
		}); err != nil {
			log.Printf("Error encoding tunnel health response: %v", err)
		}
		return
	}
	defer resp.Body.Close()

	// Read response
	var tunnelStatus map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&tunnelStatus); err != nil {
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": fmt.Sprintf("Failed to parse tunnel server response: %v", err),
		}); err != nil {
			log.Printf("Error encoding tunnel health response: %v", err)
		}
		return
	}

	// Return the tunnel status
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(tunnelStatus); err != nil {
		log.Printf("Error encoding tunnel health response: %v", err)
	}
}

// HandleInstanceReporterTrigger triggers an immediate instance report
// This is an admin-only endpoint that manually triggers the instance reporter to send a POST
// Returns the response from the collector server
// Accepts optional JSON body with test parameters to override config values temporarily
func (ah *AdminHandler) HandleInstanceReporterTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if request body contains test parameters
	var testParams map[string]interface{}
	if r.Body != nil && r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&testParams); err != nil {
			// If body exists but can't be decoded, it's an error
			http.Error(w, fmt.Sprintf("Invalid JSON in request body: %v", err), http.StatusBadRequest)
			return
		}
	}

	// Determine which instance reporter to use
	var reporter *InstanceReporter
	var tempReporter *InstanceReporter

	if testParams != nil {
		// Test mode: create a temporary instance reporter with test parameters
		// This allows testing before instance reporting is enabled
		tempReporter = NewInstanceReporter(ah.config, ah.cwSkimmerConfig, ah.sessions, ah.configFile)
		reporter = tempReporter
	} else {
		// Normal mode: use the existing instance reporter
		if ah.instanceReporter == nil {
			http.Error(w, "Instance reporter not initialized", http.StatusServiceUnavailable)
			if err := json.NewEncoder(w).Encode(map[string]string{
				"status":  "error",
				"message": "Instance reporter not initialized",
			}); err != nil {
				log.Printf("Error encoding response: %v", err)
			}
			return
		}

		// Check if enabled when not in test mode
		if !ah.config.InstanceReporting.Enabled {
			http.Error(w, "Instance reporting is not enabled", http.StatusBadRequest)
			if err := json.NewEncoder(w).Encode(map[string]string{
				"status":  "error",
				"message": "Instance reporting is not enabled",
			}); err != nil {
				log.Printf("Error encoding response: %v", err)
			}
			return
		}

		reporter = ah.instanceReporter
	}

	// Trigger an immediate report (with optional test parameters)
	if err := reporter.TriggerReportWithParams(testParams); err != nil {
		// Get the report status to include collector response details
		reportStatus := reporter.GetReportStatus()

		response := map[string]interface{}{
			"status":  "error",
			"message": fmt.Sprintf("Failed to trigger report: %v", err),
		}

		// Include collector response details if available
		if lastCode, ok := reportStatus["last_response_code"].(int); ok && lastCode > 0 {
			response["collector_response_code"] = lastCode
		}
		if lastStatus, ok := reportStatus["last_response_status"].(string); ok && lastStatus != "" {
			response["collector_response_status"] = lastStatus
		}
		if lastMessage, ok := reportStatus["last_response_message"].(string); ok && lastMessage != "" {
			response["collector_response_message"] = lastMessage
		}

		w.WriteHeader(http.StatusInternalServerError)
		if err := json.NewEncoder(w).Encode(response); err != nil {
			log.Printf("Error encoding response: %v", err)
		}
		return
	}

	// Get the report status to include collector response details
	reportStatus := reporter.GetReportStatus()

	response := map[string]interface{}{
		"status":  "success",
		"message": "Instance report triggered successfully",
	}

	// Include collector response details
	if lastCode, ok := reportStatus["last_response_code"].(int); ok {
		response["collector_response_code"] = lastCode
	}
	if lastStatus, ok := reportStatus["last_response_status"].(string); ok {
		response["collector_response_status"] = lastStatus
	}
	if lastMessage, ok := reportStatus["last_response_message"].(string); ok {
		response["collector_response_message"] = lastMessage
	}
	if publicUUID, ok := reportStatus["public_uuid"].(string); ok && publicUUID != "" {
		response["public_uuid"] = publicUUID
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

// HandleWizardStatus checks if the setup wizard should be shown
func (ah *AdminHandler) HandleWizardStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Read current config to check wizard flag
	data, err := os.ReadFile(ah.configFile)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read config file: %v", err), http.StatusInternalServerError)
		return
	}

	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusInternalServerError)
		return
	}

	// Check if wizard flag exists and is true
	needsWizard := true // Default to true if not set
	if admin, ok := configMap["admin"].(map[string]interface{}); ok {
		if wizard, ok := admin["wizard"].(bool); ok {
			needsWizard = wizard
		}
	}

	response := map[string]interface{}{
		"needs_wizard": needsWizard,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding wizard status: %v", err)
	}
}

// HandleWizardComplete marks the setup wizard as complete and triggers server restart
func (ah *AdminHandler) HandleWizardComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Read current config
	data, err := os.ReadFile(ah.configFile)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read config file: %v", err), http.StatusInternalServerError)
		return
	}

	var configMap map[string]interface{}
	if err := yaml.Unmarshal(data, &configMap); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusInternalServerError)
		return
	}

	// Set wizard flag to false
	if admin, ok := configMap["admin"].(map[string]interface{}); ok {
		admin["wizard"] = false
	} else {
		// Create admin section if it doesn't exist
		configMap["admin"] = map[string]interface{}{
			"wizard": false,
		}
	}

	// Write back to file
	yamlData, err := yaml.Marshal(configMap)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.configFile, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)

	// Trigger server restart after response is sent
	ah.restartServer()

	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "Setup wizard completed successfully. Server is restarting...",
		"restart": true,
	}); err != nil {
		log.Printf("Error encoding wizard complete response: %v", err)
	}
}

// HandleSessionActivityLogs returns session activity logs for a given time range
// Query parameters:
//   - start: Start time in RFC3339 format (default: 24 hours ago)
//   - end: End time in RFC3339 format (default: now)
//   - auth_methods: Comma-separated list of auth methods to include (regular,password,bypassed) (default: all)
func (ah *AdminHandler) HandleSessionActivityLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if session activity logging is enabled
	if !ah.config.Server.SessionActivityLogEnabled {
		http.Error(w, "Session activity logging is not enabled", http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "not_enabled",
			"message": "Session activity logging is not enabled in configuration",
		})
		return
	}

	// Parse time range parameters
	endTime := time.Now().UTC()
	startTime := endTime.Add(-24 * time.Hour) // Default: last 24 hours

	if startStr := r.URL.Query().Get("start"); startStr != "" {
		if t, err := time.Parse(time.RFC3339, startStr); err == nil {
			startTime = t.UTC()
		} else {
			http.Error(w, fmt.Sprintf("Invalid start time format: %v", err), http.StatusBadRequest)
			return
		}
	}

	if endStr := r.URL.Query().Get("end"); endStr != "" {
		if t, err := time.Parse(time.RFC3339, endStr); err == nil {
			endTime = t.UTC()
		} else {
			http.Error(w, fmt.Sprintf("Invalid end time format: %v", err), http.StatusBadRequest)
			return
		}
	}

	// Validate time range
	if startTime.After(endTime) {
		http.Error(w, "Start time must be before end time", http.StatusBadRequest)
		return
	}

	// Parse auth methods filter
	var authMethods []string
	if authMethodsStr := r.URL.Query().Get("auth_methods"); authMethodsStr != "" {
		authMethods = strings.Split(authMethodsStr, ",")
		// Validate auth methods
		validMethods := map[string]bool{"regular": true, "password": true, "bypassed": true}
		for _, method := range authMethods {
			method = strings.TrimSpace(method)
			if !validMethods[method] {
				http.Error(w, fmt.Sprintf("Invalid auth method: %s (valid: regular,password,bypassed)", method), http.StatusBadRequest)
				return
			}
		}
	}

	// Read logs from disk
	logs, err := ReadActivityLogs(ah.config.Server.SessionActivityLogDir, startTime, endTime)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read activity logs: %v", err), http.StatusInternalServerError)
		return
	}

	// Filter by auth methods if specified
	if len(authMethods) > 0 {
		logs = FilterSessionsByAuthMethod(logs, authMethods)
	}

	// Return logs
	response := map[string]interface{}{
		"start_time": startTime.Format(time.RFC3339),
		"end_time":   endTime.Format(time.RFC3339),
		"count":      len(logs),
		"logs":       logs,
	}

	if len(authMethods) > 0 {
		response["auth_methods_filter"] = authMethods
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding session activity logs: %v", err)
	}
}

// HandleSessionActivityMetrics returns aggregated metrics from session activity logs
// Query parameters:
//   - start: Start time in RFC3339 format (default: 24 hours ago)
//   - end: End time in RFC3339 format (default: now)
//   - auth_methods: Comma-separated list of auth methods to include (regular,password,bypassed) (default: all)
func (ah *AdminHandler) HandleSessionActivityMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if session activity logging is enabled
	if !ah.config.Server.SessionActivityLogEnabled {
		http.Error(w, "Session activity logging is not enabled", http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "not_enabled",
			"message": "Session activity logging is not enabled in configuration",
		})
		return
	}

	// Parse time range parameters (same as HandleSessionActivityLogs)
	endTime := time.Now().UTC()
	startTime := endTime.Add(-24 * time.Hour)

	if startStr := r.URL.Query().Get("start"); startStr != "" {
		if t, err := time.Parse(time.RFC3339, startStr); err == nil {
			startTime = t.UTC()
		} else {
			http.Error(w, fmt.Sprintf("Invalid start time format: %v", err), http.StatusBadRequest)
			return
		}
	}

	if endStr := r.URL.Query().Get("end"); endStr != "" {
		if t, err := time.Parse(time.RFC3339, endStr); err == nil {
			endTime = t.UTC()
		} else {
			http.Error(w, fmt.Sprintf("Invalid end time format: %v", err), http.StatusBadRequest)
			return
		}
	}

	if startTime.After(endTime) {
		http.Error(w, "Start time must be before end time", http.StatusBadRequest)
		return
	}

	// Parse auth methods filter
	var authMethods []string
	if authMethodsStr := r.URL.Query().Get("auth_methods"); authMethodsStr != "" {
		authMethods = strings.Split(authMethodsStr, ",")
	}

	// Read logs from disk
	logs, err := ReadActivityLogs(ah.config.Server.SessionActivityLogDir, startTime, endTime)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read activity logs: %v", err), http.StatusInternalServerError)
		return
	}

	// Filter by auth methods if specified
	if len(authMethods) > 0 {
		logs = FilterSessionsByAuthMethod(logs, authMethods)
	}

	// Calculate metrics
	metrics := calculateSessionMetrics(logs)

	// Add metadata
	response := map[string]interface{}{
		"start_time": startTime.Format(time.RFC3339),
		"end_time":   endTime.Format(time.RFC3339),
		"metrics":    metrics,
	}

	if len(authMethods) > 0 {
		response["auth_methods_filter"] = authMethods
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding session activity metrics: %v", err)
	}
}

// SessionEvent represents a single session start or end event
type SessionEvent struct {
	Timestamp     time.Time `json:"timestamp"`
	EventType     string    `json:"event_type"` // "session_start" or "session_end"
	UserSessionID string    `json:"user_session_id"`
	ClientIP      string    `json:"client_ip"`
	SourceIP      string    `json:"source_ip"`
	AuthMethod    string    `json:"auth_method"`
	SessionTypes  []string  `json:"session_types"`
	Bands         []string  `json:"bands,omitempty"`            // Cumulative list of bands visited during session
	Modes         []string  `json:"modes,omitempty"`            // Cumulative list of modes used during session
	UserAgent     string    `json:"user_agent,omitempty"`
	Country       string    `json:"country,omitempty"`          // Country name from GeoIP lookup
	CountryCode   string    `json:"country_code,omitempty"`     // ISO country code from GeoIP lookup
	Duration      *float64  `json:"duration_seconds,omitempty"` // Only for session_end events
}

// HandleSessionActivityEvents returns individual session start/end events derived from activity logs
// Query parameters:
//   - start: Start time in RFC3339 format (default: 24 hours ago)
//   - end: End time in RFC3339 format (default: now)
//   - auth_methods: Comma-separated list of auth methods to include (regular,password,bypassed) (default: all)
//   - event_types: Comma-separated list of event types to include (session_start,session_end) (default: all)
func (ah *AdminHandler) HandleSessionActivityEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if session activity logging is enabled
	if !ah.config.Server.SessionActivityLogEnabled {
		http.Error(w, "Session activity logging is not enabled", http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "not_enabled",
			"message": "Session activity logging is not enabled in configuration",
		})
		return
	}

	// Parse time range parameters
	endTime := time.Now().UTC()
	startTime := endTime.Add(-24 * time.Hour) // Default: last 24 hours

	if startStr := r.URL.Query().Get("start"); startStr != "" {
		if t, err := time.Parse(time.RFC3339, startStr); err == nil {
			startTime = t.UTC()
		} else {
			http.Error(w, fmt.Sprintf("Invalid start time format: %v", err), http.StatusBadRequest)
			return
		}
	}

	if endStr := r.URL.Query().Get("end"); endStr != "" {
		if t, err := time.Parse(time.RFC3339, endStr); err == nil {
			endTime = t.UTC()
		} else {
			http.Error(w, fmt.Sprintf("Invalid end time format: %v", err), http.StatusBadRequest)
			return
		}
	}

	// Validate time range
	if startTime.After(endTime) {
		http.Error(w, "Start time must be before end time", http.StatusBadRequest)
		return
	}

	// Parse auth methods filter
	var authMethods []string
	if authMethodsStr := r.URL.Query().Get("auth_methods"); authMethodsStr != "" {
		authMethods = strings.Split(authMethodsStr, ",")
		// Validate auth methods
		validMethods := map[string]bool{"regular": true, "password": true, "bypassed": true}
		for _, method := range authMethods {
			method = strings.TrimSpace(method)
			if !validMethods[method] {
				http.Error(w, fmt.Sprintf("Invalid auth method: %s (valid: regular,password,bypassed)", method), http.StatusBadRequest)
				return
			}
		}
	}

	// Parse event types filter
	var eventTypes []string
	if eventTypesStr := r.URL.Query().Get("event_types"); eventTypesStr != "" {
		eventTypes = strings.Split(eventTypesStr, ",")
		// Validate event types
		validTypes := map[string]bool{"session_start": true, "session_end": true}
		for _, eventType := range eventTypes {
			eventType = strings.TrimSpace(eventType)
			if !validTypes[eventType] {
				http.Error(w, fmt.Sprintf("Invalid event type: %s (valid: session_start,session_end)", eventType), http.StatusBadRequest)
				return
			}
		}
	}

	// Read logs from disk
	logs, err := ReadActivityLogs(ah.config.Server.SessionActivityLogDir, startTime, endTime)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read activity logs: %v", err), http.StatusInternalServerError)
		return
	}

	// Convert snapshots to events
	events := convertLogsToEvents(logs)

	// Filter by auth methods if specified
	if len(authMethods) > 0 {
		events = filterEventsByAuthMethod(events, authMethods)
	}

	// Filter by event types if specified
	if len(eventTypes) > 0 {
		events = filterEventsByType(events, eventTypes)
	}

	// Return events
	response := map[string]interface{}{
		"start_time": startTime.Format(time.RFC3339),
		"end_time":   endTime.Format(time.RFC3339),
		"count":      len(events),
		"events":     events,
	}

	if len(authMethods) > 0 {
		response["auth_methods_filter"] = authMethods
	}
	if len(eventTypes) > 0 {
		response["event_types_filter"] = eventTypes
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding session activity events: %v", err)
	}
}

// convertLogsToEvents converts activity log snapshots into individual session start/end events
func convertLogsToEvents(logs []SessionActivityLog) []SessionEvent {
	if len(logs) == 0 {
		return []SessionEvent{}
	}

	// Track sessions across snapshots
	// Map: user_session_id -> last seen info
	type sessionInfo struct {
		entry           SessionActivityEntry
		lastSeen        time.Time
		firstSeen       time.Time
		allTypes        map[string]bool   // Track all session types seen
		allBands        map[string]bool   // Track all bands visited
		allModes        map[string]bool   // Track all modes used
		startEventIndex int               // Index of start event in events slice (for updating types)
	}
	activeSessions := make(map[string]*sessionInfo)
	events := []SessionEvent{}

	for _, log := range logs {
		// Handle session_destroyed events specially - they contain the final state
		if log.EventType == "session_destroyed" {
			// Process each session in the destroyed event as an end event
			for _, session := range log.ActiveSessions {
				if existing, exists := activeSessions[session.UserSessionID]; exists {
					// Session was active, create end event with accumulated data
					endTime := log.Timestamp
					duration := endTime.Sub(existing.firstSeen).Seconds()
					
					// Merge final bands from destroyed event
					for _, band := range session.Bands {
						if band != "" {
							existing.allBands[band] = true
						}
					}
					
					// Merge final modes from destroyed event
					for _, mode := range session.Modes {
						if mode != "" {
							existing.allModes[mode] = true
						}
					}
					
					// Convert maps to slices
					allBandsSlice := make([]string, 0, len(existing.allBands))
					for band := range existing.allBands {
						allBandsSlice = append(allBandsSlice, band)
					}
					sort.Strings(allBandsSlice)
					
					allModesSlice := make([]string, 0, len(existing.allModes))
					for mode := range existing.allModes {
						allModesSlice = append(allModesSlice, mode)
					}
					sort.Strings(allModesSlice)
					
					allTypesSlice := make([]string, 0, len(existing.allTypes))
					for t := range existing.allTypes {
						allTypesSlice = append(allTypesSlice, t)
					}
					sort.Strings(allTypesSlice)
					
					events = append(events, SessionEvent{
						Timestamp:     endTime,
						EventType:     "session_end",
						UserSessionID: session.UserSessionID,
						ClientIP:      existing.entry.ClientIP,
						SourceIP:      existing.entry.SourceIP,
						AuthMethod:    existing.entry.AuthMethod,
						SessionTypes:  allTypesSlice,
						Bands:         allBandsSlice,
						Modes:         allModesSlice,
						UserAgent:     existing.entry.UserAgent,
						Country:       existing.entry.Country,
						CountryCode:   existing.entry.CountryCode,
						Duration:      &duration,
					})
					
					// Remove from active sessions
					delete(activeSessions, session.UserSessionID)
				}
			}
			continue
		}
		
		currentSessionIDs := make(map[string]bool)

		// Process all sessions in this snapshot
		for _, session := range log.ActiveSessions {
			currentSessionIDs[session.UserSessionID] = true

			if existing, exists := activeSessions[session.UserSessionID]; exists {
				// Session already active, update last seen and merge session types, bands, and modes
				existing.lastSeen = log.Timestamp
				
				// Merge session types from this snapshot
				typesChanged := false
				for _, t := range session.SessionTypes {
					if !existing.allTypes[t] {
						existing.allTypes[t] = true
						typesChanged = true
					}
				}
				
				// Merge bands from this snapshot
				for _, band := range session.Bands {
					if band != "" && !existing.allBands[band] {
						existing.allBands[band] = true
					}
				}
				
				// Merge modes from this snapshot
				for _, mode := range session.Modes {
					if mode != "" && !existing.allModes[mode] {
						existing.allModes[mode] = true
					}
				}
				
				// If types changed, update the start event with cumulative types
				if typesChanged && existing.startEventIndex >= 0 && existing.startEventIndex < len(events) {
					allTypesSlice := make([]string, 0, len(existing.allTypes))
					for t := range existing.allTypes {
						allTypesSlice = append(allTypesSlice, t)
					}
					sort.Strings(allTypesSlice)
					events[existing.startEventIndex].SessionTypes = allTypesSlice
				}
				
				// Always keep the most recent session entry (has most up-to-date bands/modes)
				existing.entry = session
			} else {
				// New session detected - create start event
				allTypes := make(map[string]bool)
				for _, t := range session.SessionTypes {
					allTypes[t] = true
				}
				
				// Initialize bands and modes tracking
				allBands := make(map[string]bool)
				for _, band := range session.Bands {
					if band != "" {
						allBands[band] = true
					}
				}
				
				allModes := make(map[string]bool)
				for _, mode := range session.Modes {
					if mode != "" {
						allModes[mode] = true
					}
				}

				// Determine actual session start time using all available timestamps
				// Priority: 1) FirstSeen (from userSessionFirst map - when user first connected)
				//           2) CreatedAt (when this specific channel was created)
				//           3) log.Timestamp (current snapshot time - fallback)
				startTime := log.Timestamp
				if !session.CreatedAt.IsZero() {
					startTime = session.CreatedAt
				}
				if !session.FirstSeen.IsZero() && session.FirstSeen.Before(startTime) {
					startTime = session.FirstSeen
				}

				// Convert allTypes to slice for start event
				startTypesSlice := make([]string, 0, len(allTypes))
				for t := range allTypes {
					startTypesSlice = append(startTypesSlice, t)
				}
				sort.Strings(startTypesSlice)

				// Create start event and track its index
				startEventIndex := len(events)
				events = append(events, SessionEvent{
					Timestamp:     startTime, // Use actual session start time
					EventType:     "session_start",
					UserSessionID: session.UserSessionID,
					ClientIP:      session.ClientIP,
					SourceIP:      session.SourceIP,
					AuthMethod:    session.AuthMethod,
					SessionTypes:  startTypesSlice, // Use all types from snapshot
					Bands:         session.Bands,    // Cumulative bands visited
					Modes:         session.Modes,    // Cumulative modes used
					UserAgent:     session.UserAgent,
					Country:       session.Country,
					CountryCode:   session.CountryCode,
				})

				activeSessions[session.UserSessionID] = &sessionInfo{
					entry:           session,
					firstSeen:       startTime,
					lastSeen:        log.Timestamp,
					allTypes:        allTypes,
					allBands:        allBands,
					allModes:        allModes,
					startEventIndex: startEventIndex,
				}
			}
		}

		// Check for sessions that disappeared (ended)
		for sessionID, info := range activeSessions {
			if !currentSessionIDs[sessionID] {
				// Session ended - calculate duration from creation to destruction
				// Use log.Timestamp (session_destroyed event time) as the actual end time
				// This is when the session was actually destroyed, not when we last saw it
				endTime := log.Timestamp
				duration := endTime.Sub(info.firstSeen).Seconds()

				// Convert allTypes map to slice
				allTypesSlice := make([]string, 0, len(info.allTypes))
				for t := range info.allTypes {
					allTypesSlice = append(allTypesSlice, t)
				}
				sort.Strings(allTypesSlice) // Sort for consistent ordering
				
				// Convert allBands map to slice
				allBandsSlice := make([]string, 0, len(info.allBands))
				for band := range info.allBands {
					allBandsSlice = append(allBandsSlice, band)
				}
				sort.Strings(allBandsSlice) // Sort for consistent ordering
				
				// Convert allModes map to slice
				allModesSlice := make([]string, 0, len(info.allModes))
				for mode := range info.allModes {
					allModesSlice = append(allModesSlice, mode)
				}
				sort.Strings(allModesSlice) // Sort for consistent ordering

				events = append(events, SessionEvent{
					Timestamp:     endTime, // Use destruction event timestamp
					EventType:     "session_end",
					UserSessionID: info.entry.UserSessionID,
					ClientIP:      info.entry.ClientIP,
					SourceIP:      info.entry.SourceIP,
					AuthMethod:    info.entry.AuthMethod,
					SessionTypes:  allTypesSlice,      // Use accumulated types
					Bands:         allBandsSlice,      // Use accumulated bands
					Modes:         allModesSlice,      // Use accumulated modes
					UserAgent:     info.entry.UserAgent,
					Country:       info.entry.Country,
					CountryCode:   info.entry.CountryCode,
					Duration:      &duration,
				})

				// Remove from active sessions
				delete(activeSessions, sessionID)
			}
		}
	}

	// Sort events by timestamp (most recent first)
	sort.Slice(events, func(i, j int) bool {
		return events[i].Timestamp.After(events[j].Timestamp)
	})

	return events
}

// filterEventsByAuthMethod filters events by authentication method
func filterEventsByAuthMethod(events []SessionEvent, authMethods []string) []SessionEvent {
	if len(authMethods) == 0 {
		return events
	}

	// Create a map for quick lookup
	methodMap := make(map[string]bool)
	for _, method := range authMethods {
		methodMap[strings.TrimSpace(method)] = true
	}

	filtered := make([]SessionEvent, 0, len(events))
	for _, event := range events {
		// Map auth_method to filter names
		filterName := "regular"
		if event.AuthMethod == "password" {
			filterName = "password"
		} else if event.AuthMethod == "ip_bypass" {
			filterName = "bypassed"
		}

		if methodMap[filterName] {
			filtered = append(filtered, event)
		}
	}

	return filtered
}

// filterEventsByType filters events by event type
func filterEventsByType(events []SessionEvent, eventTypes []string) []SessionEvent {
	if len(eventTypes) == 0 {
		return events
	}

	// Create a map for quick lookup
	typeMap := make(map[string]bool)
	for _, eventType := range eventTypes {
		typeMap[strings.TrimSpace(eventType)] = true
	}

	filtered := make([]SessionEvent, 0, len(events))
	for _, event := range events {
		if typeMap[event.EventType] {
			filtered = append(filtered, event)
		}
	}

	return filtered
}

// calculateSessionMetrics calculates aggregated metrics from session activity logs
func calculateSessionMetrics(logs []SessionActivityLog) map[string]interface{} {
	if len(logs) == 0 {
		return map[string]interface{}{
			"total_snapshots":     0,
			"unique_users":        0,
			"peak_concurrent":     0,
			"total_sessions":      0,
			"auth_method_counts":  map[string]int{},
			"session_type_counts": map[string]int{},
			"timeline":            []map[string]interface{}{},
		}
	}

	// Track unique users across all logs
	uniqueUsers := make(map[string]bool)
	peakConcurrent := 0
	totalSessions := 0
	authMethodCounts := make(map[string]int)
	sessionTypeCounts := make(map[string]int)

	// Timeline data for charting
	timeline := make([]map[string]interface{}, 0, len(logs))

	for _, log := range logs {
		// Count active sessions in this snapshot
		activeCount := len(log.ActiveSessions)
		if activeCount > peakConcurrent {
			peakConcurrent = activeCount
		}

		// Track unique users and session types
		authBreakdown := make(map[string]int)
		typeBreakdown := make(map[string]int)

		for _, session := range log.ActiveSessions {
			uniqueUsers[session.UserSessionID] = true
			totalSessions++

			// Count auth methods
			authMethod := "regular"
			if session.AuthMethod == "password" {
				authMethod = "password"
			} else if session.AuthMethod == "ip_bypass" {
				authMethod = "bypassed"
			}
			authMethodCounts[authMethod]++
			authBreakdown[authMethod]++

			// Count session types
			for _, sessionType := range session.SessionTypes {
				sessionTypeCounts[sessionType]++
				typeBreakdown[sessionType]++
			}
		}

		// Add timeline entry
		timeline = append(timeline, map[string]interface{}{
			"timestamp":       log.Timestamp.Format(time.RFC3339),
			"event_type":      log.EventType,
			"active_sessions": activeCount,
			"auth_breakdown":  authBreakdown,
			"type_breakdown":  typeBreakdown,
		})
	}

	return map[string]interface{}{
		"total_snapshots":     len(logs),
		"unique_users":        len(uniqueUsers),
		"peak_concurrent":     peakConcurrent,
		"total_sessions":      totalSessions,
		"auth_method_counts":  authMethodCounts,
		"session_type_counts": sessionTypeCounts,
		"timeline":            timeline,
	}
}

// HandleForceUpdate forces an update by writing the version trigger file
// This endpoint accepts a POST request with an optional JSON body containing a version string
// If no version is provided, it uses the latest version from GitHub (if available) or current version
func (ah *AdminHandler) HandleForceUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Parse optional request body
	var req struct {
		Version string `json:"version"`
	}

	if r.Body != nil && r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
			return
		}
	}

	// Determine which version to write
	versionToWrite := req.Version
	if versionToWrite == "" {
		// Try to use the latest version from GitHub if available
		latestVersion := GetLatestVersion()
		if latestVersion != "" {
			versionToWrite = latestVersion
		} else {
			// Fall back to current version
			versionToWrite = Version
		}
	}

	// Write the version file to trigger update
	if err := WriteVersionFile(versionToWrite); err != nil {
		log.Printf("Admin forced update failed: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "error",
			"message": fmt.Sprintf("Failed to write version file: %v", err),
		}); err != nil {
			log.Printf("Error encoding response: %v", err)
		}
		return
	}

	log.Printf("Admin forced update: version file written with version %s", versionToWrite)

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": fmt.Sprintf("Update triggered successfully. Version file written with version %s. The cron job will detect this and trigger the update within 1 minute.", versionToWrite),
		"version": versionToWrite,
	}); err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

// HandleMQTTHealth serves the health status of the MQTT publisher
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func (ah *AdminHandler) HandleMQTTHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Build health status response
	status := map[string]interface{}{
		"enabled": ah.config.MQTT.Enabled,
		"healthy": false,
		"issues":  []string{},
	}

	// If not enabled, return early
	if !ah.config.MQTT.Enabled {
		status["issues"] = []string{"MQTT is not enabled"}
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding MQTT health status: %v", err)
		}
		return
	}

	// Check if MQTT publisher exists
	if ah.mqttPublisher == nil {
		status["issues"] = []string{"MQTT publisher not initialized"}
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding MQTT health status: %v", err)
		}
		return
	}

	// Get health status from MQTT publisher
	healthData := ah.mqttPublisher.GetHealthStatus()

	// Merge health data into status
	for k, v := range healthData {
		status[k] = v
	}

	// Determine overall health
	connected := status["connected"].(bool)
	if connected {
		status["healthy"] = true
		w.WriteHeader(http.StatusOK)
	} else {
		status["healthy"] = false
		status["issues"] = []string{"Not connected to MQTT broker"}
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding MQTT health status: %v", err)
	}
}

// HandleRotctlHealth serves the health status of the rotator control client
// This is an admin-only endpoint, so IP ban checking is not needed (handled by auth middleware)
func (ah *AdminHandler) HandleRotctlHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Build health status response
	status := map[string]interface{}{
		"enabled": ah.config.Rotctl.Enabled,
		"healthy": false,
		"issues":  []string{},
	}

	// If not enabled, return early
	if !ah.config.Rotctl.Enabled {
		status["issues"] = []string{"Rotator control is not enabled"}
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding rotctl health status: %v", err)
		}
		return
	}

	// Check if rotctl handler exists
	if ah.rotctlHandler == nil {
		status["issues"] = []string{"Rotator control handler not initialized"}
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding rotctl health status: %v", err)
		}
		return
	}

	// Get connection status
	connected := ah.rotctlHandler.controller.client.IsConnected()
	status["connected"] = connected

	// Get current state
	state := ah.rotctlHandler.controller.GetState()
	status["azimuth"] = int(state.Position.Azimuth + 0.5)     // Round to nearest integer
	status["elevation"] = int(state.Position.Elevation + 0.5) // Round to nearest integer

	// Get connection info
	status["host"] = ah.config.Rotctl.Host
	status["port"] = ah.config.Rotctl.Port
	status["update_interval"] = ah.config.Rotctl.UpdateInterval

	// Get connection duration if connected
	ah.rotctlHandler.mu.RLock()
	connectedSince := ah.rotctlHandler.connectedSince
	ah.rotctlHandler.mu.RUnlock()

	if connected && !connectedSince.IsZero() {
		duration := time.Since(connectedSince)
		status["connected_duration_seconds"] = int(duration.Seconds())
		status["connected_since"] = connectedSince.Format(time.RFC3339)

		// Format duration in human-readable format
		status["connected_duration"] = formatDuration(duration)
	}

	// Check for errors
	if state.LastError != nil {
		status["last_error"] = state.LastError.Error()
	}

	// Add scheduler information if available
	if ah.rotatorScheduler != nil {
		schedulerStatus := ah.rotatorScheduler.GetStatus()
		status["scheduler"] = schedulerStatus
	}

	// Check connection status
	if !connected {
		status["issues"] = append(status["issues"].([]string), "Not connected to rotctld")
	}

	// Determine overall health
	issues := status["issues"].([]string)
	if len(issues) == 0 {
		status["healthy"] = true
		w.WriteHeader(http.StatusOK)
	} else {
		status["healthy"] = false
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		log.Printf("Error encoding rotctl health status: %v", err)
	}
}

// HandleRotatorSchedulerConfig handles GET and PUT requests for rotator scheduler configuration
func (ah *AdminHandler) HandleRotatorSchedulerConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		ah.handleGetRotatorSchedulerConfig(w, r)
	case http.MethodPut:
		ah.handleUpdateRotatorSchedulerConfig(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleGetRotatorSchedulerConfig returns the rotator scheduler configuration
func (ah *AdminHandler) handleGetRotatorSchedulerConfig(w http.ResponseWriter, r *http.Request) {
	// Check if rotator scheduler exists
	if ah.rotatorScheduler == nil {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"enabled":   false,
			"positions": []interface{}{},
		})
		return
	}

	// Get status which includes config
	status := ah.rotatorScheduler.GetStatus()

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(status)
}

// handleUpdateRotatorSchedulerConfig updates the rotator scheduler configuration
func (ah *AdminHandler) handleUpdateRotatorSchedulerConfig(w http.ResponseWriter, r *http.Request) {
	// Check if rotator scheduler exists
	if ah.rotatorScheduler == nil {
		http.Error(w, "Rotator scheduler not initialized", http.StatusServiceUnavailable)
		return
	}

	var config map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Filter out status fields - only keep configuration fields
	filteredConfig := map[string]interface{}{}
	if enabled, ok := config["enabled"]; ok {
		filteredConfig["enabled"] = enabled
	}
	if positions, ok := config["positions"]; ok {
		filteredConfig["positions"] = positions
	}
	// Sun tracking configuration
	if followSun, ok := config["follow_sun"]; ok {
		filteredConfig["follow_sun"] = followSun
	}
	if followSunStep, ok := config["follow_sun_step"]; ok {
		filteredConfig["follow_sun_step"] = followSunStep
	}
	if followSunPath, ok := config["follow_sun_path"]; ok {
		filteredConfig["follow_sun_path"] = followSunPath
	}
	if daytimeOnly, ok := config["daytime_only"]; ok {
		filteredConfig["daytime_only"] = daytimeOnly
	}
	if daytimeOverlap, ok := config["daytime_overlap"]; ok {
		filteredConfig["daytime_overlap"] = daytimeOverlap
	}
	if followGreyline, ok := config["follow_greyline"]; ok {
		filteredConfig["follow_greyline"] = followGreyline
	}
	if sunriseStart, ok := config["sunrise_start"]; ok {
		filteredConfig["sunrise_start"] = sunriseStart
	}
	if sunriseEnd, ok := config["sunrise_end"]; ok {
		filteredConfig["sunrise_end"] = sunriseEnd
	}
	if sunsetStart, ok := config["sunset_start"]; ok {
		filteredConfig["sunset_start"] = sunsetStart
	}
	if sunsetEnd, ok := config["sunset_end"]; ok {
		filteredConfig["sunset_end"] = sunsetEnd
	}

	// Backup existing file with timestamp before replacing
	schedulerPath := ah.rotatorScheduler.configPath
	if _, err := os.Stat(schedulerPath); err == nil {
		timestamp := time.Now().Format("20060102-150405")
		backupPath := fmt.Sprintf("%s.%s", schedulerPath, timestamp)
		if err := os.Rename(schedulerPath, backupPath); err != nil {
			log.Printf("Warning: Failed to backup rotator_schedule.yaml: %v", err)
		} else {
			log.Printf("Backed up rotator_schedule.yaml to %s", backupPath)
		}
	}

	// Convert to YAML and write to file (using filtered config)
	yamlData, err := yaml.Marshal(filteredConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal scheduler config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(schedulerPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write scheduler config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload scheduler to apply changes immediately
	if err := ah.rotatorScheduler.Reload(); err != nil {
		log.Printf("Warning: Failed to reload scheduler after config update: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Rotator scheduler configuration updated successfully",
	})
}

// HandleRotatorSchedulerPosition handles POST, PUT, DELETE requests for individual positions
func (ah *AdminHandler) HandleRotatorSchedulerPosition(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Check if rotator scheduler exists
	if ah.rotatorScheduler == nil {
		http.Error(w, "Rotator scheduler not initialized", http.StatusServiceUnavailable)
		return
	}

	switch r.Method {
	case http.MethodPost:
		ah.handleAddRotatorPosition(w, r)
	case http.MethodPut:
		ah.handleUpdateRotatorPosition(w, r)
	case http.MethodDelete:
		ah.handleDeleteRotatorPosition(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleAddRotatorPosition adds a new scheduled position
func (ah *AdminHandler) handleAddRotatorPosition(w http.ResponseWriter, r *http.Request) {
	var newPos map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&newPos); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate required fields
	if newPos["time"] == "" || newPos["bearing"] == nil {
		http.Error(w, "Time and bearing are required", http.StatusBadRequest)
		return
	}

	// Read current config
	ah.rotatorScheduler.mu.RLock()
	schedulerPath := ah.rotatorScheduler.configPath
	ah.rotatorScheduler.mu.RUnlock()

	data, err := os.ReadFile(schedulerPath)
	var config map[string]interface{}
	if err == nil {
		yaml.Unmarshal(data, &config)
	} else {
		config = make(map[string]interface{})
	}

	// Get positions array
	var positions []interface{}
	if existing, ok := config["positions"].([]interface{}); ok {
		positions = existing
	}

	// Add new position
	positions = append(positions, newPos)
	config["positions"] = positions

	// Write back to file
	yamlData, err := yaml.Marshal(config)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(schedulerPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload scheduler
	if err := ah.rotatorScheduler.Reload(); err != nil {
		log.Printf("Warning: Failed to reload scheduler after add: %v", err)
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Position added successfully",
	})
}

// handleUpdateRotatorPosition updates a position by time and optional offset
func (ah *AdminHandler) handleUpdateRotatorPosition(w http.ResponseWriter, r *http.Request) {
	timeParam := r.URL.Query().Get("time")
	if timeParam == "" {
		http.Error(w, "Time parameter required", http.StatusBadRequest)
		return
	}

	// Get optional offset parameter for matching solar events with different offsets
	offsetParam := r.URL.Query().Get("offset")
	var targetOffset int
	hasOffset := false
	if offsetParam != "" {
		var err error
		targetOffset, err = strconv.Atoi(offsetParam)
		if err != nil {
			http.Error(w, "Invalid offset parameter", http.StatusBadRequest)
			return
		}
		hasOffset = true
	}

	var updatedPos map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updatedPos); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	// Validate required fields
	if updatedPos["time"] == "" || updatedPos["bearing"] == nil {
		http.Error(w, "Time and bearing are required", http.StatusBadRequest)
		return
	}

	// Read current config
	ah.rotatorScheduler.mu.RLock()
	schedulerPath := ah.rotatorScheduler.configPath
	ah.rotatorScheduler.mu.RUnlock()

	data, err := os.ReadFile(schedulerPath)
	if err != nil {
		http.Error(w, "Failed to read config file", http.StatusInternalServerError)
		return
	}

	var config map[string]interface{}
	if err := yaml.Unmarshal(data, &config); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusInternalServerError)
		return
	}

	// Get positions array
	positions, ok := config["positions"].([]interface{})
	if !ok {
		http.Error(w, "Invalid config structure", http.StatusInternalServerError)
		return
	}

	// Find position by time AND offset (if offset is provided)
	positionIndex := -1
	for i, posInterface := range positions {
		if posMap, ok := posInterface.(map[string]interface{}); ok {
			if time, ok := posMap["time"].(string); ok && time == timeParam {
				// If offset parameter was provided, also match on offset
				if hasOffset {
					posOffset := 0
					if offset, ok := posMap["offset"]; ok {
						switch v := offset.(type) {
						case int:
							posOffset = v
						case float64:
							posOffset = int(v)
						}
					}
					if posOffset == targetOffset {
						positionIndex = i
						break
					}
				} else {
					// No offset parameter - match first position with this time
					positionIndex = i
					break
				}
			}
		}
	}

	if positionIndex == -1 {
		http.Error(w, fmt.Sprintf("Position at time '%s' not found", timeParam), http.StatusNotFound)
		return
	}

	// Update position at index
	positions[positionIndex] = updatedPos
	config["positions"] = positions

	// Write back to file
	yamlData, err := yaml.Marshal(config)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(schedulerPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload scheduler
	if err := ah.rotatorScheduler.Reload(); err != nil {
		log.Printf("Warning: Failed to reload scheduler after update: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Position updated successfully",
	})
}

// handleDeleteRotatorPosition deletes a position by time and optional offset
func (ah *AdminHandler) handleDeleteRotatorPosition(w http.ResponseWriter, r *http.Request) {
	timeParam := r.URL.Query().Get("time")
	if timeParam == "" {
		http.Error(w, "Time parameter required", http.StatusBadRequest)
		return
	}

	// Get optional offset parameter for matching solar events with different offsets
	offsetParam := r.URL.Query().Get("offset")
	var targetOffset int
	hasOffset := false
	if offsetParam != "" {
		var err error
		targetOffset, err = strconv.Atoi(offsetParam)
		if err != nil {
			http.Error(w, "Invalid offset parameter", http.StatusBadRequest)
			return
		}
		hasOffset = true
	}

	// Read current config
	ah.rotatorScheduler.mu.RLock()
	schedulerPath := ah.rotatorScheduler.configPath
	ah.rotatorScheduler.mu.RUnlock()

	data, err := os.ReadFile(schedulerPath)
	if err != nil {
		http.Error(w, "Failed to read config file", http.StatusInternalServerError)
		return
	}

	var config map[string]interface{}
	if err := yaml.Unmarshal(data, &config); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusInternalServerError)
		return
	}

	// Get positions array
	positions, ok := config["positions"].([]interface{})
	if !ok {
		http.Error(w, "Invalid config structure", http.StatusInternalServerError)
		return
	}

	// Find position by time AND offset (if offset is provided)
	positionIndex := -1
	for i, posInterface := range positions {
		if posMap, ok := posInterface.(map[string]interface{}); ok {
			if time, ok := posMap["time"].(string); ok && time == timeParam {
				// If offset parameter was provided, also match on offset
				if hasOffset {
					posOffset := 0
					if offset, ok := posMap["offset"]; ok {
						switch v := offset.(type) {
						case int:
							posOffset = v
						case float64:
							posOffset = int(v)
						}
					}
					if posOffset == targetOffset {
						positionIndex = i
						break
					}
				} else {
					// No offset parameter - match first position with this time
					positionIndex = i
					break
				}
			}
		}
	}

	if positionIndex == -1 {
		http.Error(w, fmt.Sprintf("Position at time '%s' not found", timeParam), http.StatusNotFound)
		return
	}

	// Remove position at index
	positions = append(positions[:positionIndex], positions[positionIndex+1:]...)
	config["positions"] = positions

	// Write back to file
	yamlData, err := yaml.Marshal(config)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(schedulerPath, yamlData, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Reload scheduler
	if err := ah.rotatorScheduler.Reload(); err != nil {
		log.Printf("Warning: Failed to reload scheduler after delete: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Position deleted successfully",
	})
}

// HandleRotatorSchedulerReload handles POST requests to reload the scheduler
func (ah *AdminHandler) HandleRotatorSchedulerReload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if rotator scheduler exists
	if ah.rotatorScheduler == nil {
		http.Error(w, "Rotator scheduler not initialized", http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "error",
			"message": "Rotator scheduler not initialized",
		})
		return
	}

	// Reload the scheduler
	if err := ah.rotatorScheduler.Reload(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to reload scheduler: %v", err), http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "error",
			"message": fmt.Sprintf("Failed to reload scheduler: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Rotator scheduler reloaded successfully",
	})
}

// HandleRotatorSchedulerLogs handles GET requests to retrieve scheduler trigger logs
func (ah *AdminHandler) HandleRotatorSchedulerLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if rotator scheduler exists
	if ah.rotatorScheduler == nil {
		http.Error(w, "Rotator scheduler not initialized", http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   "not_initialized",
			"message": "Rotator scheduler not initialized",
			"logs":    []interface{}{},
			"count":   0,
		})
		return
	}

	// Get trigger logs
	logs := ah.rotatorScheduler.GetTriggerLogs()

	response := map[string]interface{}{
		"logs":  logs,
		"count": len(logs),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding rotator scheduler logs: %v", err)
	}
}

// HandleLoadHistory returns the 60-minute load history data
func (ah *AdminHandler) HandleLoadHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if load history tracker exists
	if ah.loadHistory == nil {
		http.Error(w, "Load history tracker not initialized", http.StatusServiceUnavailable)
		return
	}

	// Get history data
	history := ah.loadHistory.GetHistory()

	response := map[string]interface{}{
		"history": history,
		"count":   len(history),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding load history: %v", err)
	}
}

// HandleLoadHourlyHistory returns the 24-hour load history data
func (ah *AdminHandler) HandleLoadHourlyHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if load history tracker exists
	if ah.loadHistory == nil {
		http.Error(w, "Load history tracker not initialized", http.StatusServiceUnavailable)
		return
	}

	// Get hourly history data
	hourlyHistory := ah.loadHistory.GetHourlyHistory()

	response := map[string]interface{}{
		"history": hourlyHistory,
		"count":   len(hourlyHistory),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding load hourly history: %v", err)
	}
}

// HandleGeoIPLookup handles POST /admin/geoip/lookup - lookup IP address geolocation
func (ah *AdminHandler) HandleGeoIPLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if GeoIP service is available
	if ah.geoIPService == nil || !ah.geoIPService.IsEnabled() {
		http.Error(w, "GeoIP service not available", http.StatusServiceUnavailable)
		return
	}

	var req struct {
		IP string `json:"ip"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.IP == "" {
		http.Error(w, "IP address is required", http.StatusBadRequest)
		return
	}

	// Perform lookup
	result, err := ah.geoIPService.Lookup(req.IP)
	if err != nil {
		http.Error(w, fmt.Sprintf("Lookup failed: %v", err), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Error encoding GeoIP lookup response: %v", err)
	}
}

// HandleSessionsWithCountries handles GET /admin/sessions/countries - get active sessions with country information
func (ah *AdminHandler) HandleSessionsWithCountries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if GeoIP service is available
	if ah.geoIPService == nil || !ah.geoIPService.IsEnabled() {
		http.Error(w, "GeoIP service not available", http.StatusServiceUnavailable)
		return
	}

	// Get all sessions info
	sessionsInfo := ah.sessions.GetAllSessionsInfo()

	type SessionWithCountry struct {
		UserSessionID string `json:"user_session_id"`
		ClientIP      string `json:"client_ip"`
		Country       string `json:"country"`
		CountryCode   string `json:"country_code"`
		Mode          string `json:"mode"`
		Frequency     uint64 `json:"frequency"`
		IsSpectrum    bool   `json:"is_spectrum"`
	}

	var enrichedSessions []SessionWithCountry

	for _, sessionInfo := range sessionsInfo {
		// Extract client IP from session info
		clientIP, _ := sessionInfo["client_ip"].(string)

		// Skip internal sessions (no client IP)
		if clientIP == "" {
			continue
		}

		country, countryCode := ah.geoIPService.LookupSafe(clientIP)

		// Extract other fields with type assertions
		userSessionID, _ := sessionInfo["user_session_id"].(string)
		mode, _ := sessionInfo["mode"].(string)
		frequency, _ := sessionInfo["frequency"].(uint64)
		isSpectrum, _ := sessionInfo["is_spectrum"].(bool)

		enrichedSessions = append(enrichedSessions, SessionWithCountry{
			UserSessionID: userSessionID,
			ClientIP:      clientIP,
			Country:       country,
			CountryCode:   countryCode,
			Mode:          mode,
			Frequency:     frequency,
			IsSpectrum:    isSpectrum,
		})
	}

	response := map[string]interface{}{
		"sessions": enrichedSessions,
		"count":    len(enrichedSessions),
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding sessions with countries response: %v", err)
	}
}

// HandleGeoIPHealth handles GET /admin/geoip-health - check GeoIP service health
func (ah *AdminHandler) HandleGeoIPHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	health := map[string]interface{}{
		"enabled": false,
		"status":  "disabled",
	}

	if ah.geoIPService != nil && ah.geoIPService.IsEnabled() {
		// Test with a known IP (Google DNS)
		_, err := ah.geoIPService.Lookup("8.8.8.8")
		if err != nil {
			health["enabled"] = true
			health["status"] = "error"
			health["error"] = err.Error()
		} else {
			health["enabled"] = true
			health["status"] = "healthy"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(health); err != nil {
		log.Printf("Error encoding GeoIP health response: %v", err)
	}
}

// HandleBanCountry bans a country by its alpha-2 code
func (ah *AdminHandler) HandleBanCountry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		CountryCode string `json:"country_code"`
		CountryName string `json:"country_name"`
		Reason      string `json:"reason"`
		Temporary   bool   `json:"temporary"`
		Duration    int    `json:"duration"` // Duration in seconds for temporary bans
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.CountryCode == "" {
		http.Error(w, "Country code is required", http.StatusBadRequest)
		return
	}

	// Validate country code format (should be 2 uppercase letters)
	if len(req.CountryCode) != 2 {
		http.Error(w, "Country code must be 2 characters (ISO 3166-1 alpha-2)", http.StatusBadRequest)
		return
	}

	// Convert to uppercase
	req.CountryCode = strings.ToUpper(req.CountryCode)

	if req.Reason == "" {
		req.Reason = "Banned by admin"
	}

	// Ban the country
	var err error
	if req.Temporary && req.Duration > 0 {
		duration := time.Duration(req.Duration) * time.Second
		err = ah.countryBanManager.BanCountryWithDuration(req.CountryCode, req.CountryName, req.Reason, "admin", duration)
	} else {
		err = ah.countryBanManager.BanCountry(req.CountryCode, req.CountryName, req.Reason, "admin")
	}

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to ban country: %v", err), http.StatusInternalServerError)
		return
	}

	// Kick all sessions from this country
	count, err := ah.sessions.KickUsersByCountry(req.CountryCode, ah.geoIPService)
	if err != nil {
		log.Printf("Error kicking sessions for banned country %s: %v", req.CountryCode, err)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "success",
		"message":          fmt.Sprintf("Banned country %s and kicked %d session(s)", req.CountryCode, count),
		"sessions_removed": count,
	}); err != nil {
		log.Printf("Error encoding ban country response: %v", err)
	}
}

// HandleUnbanCountry unbans a country by its alpha-2 code
func (ah *AdminHandler) HandleUnbanCountry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		CountryCode string `json:"country_code"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.CountryCode == "" {
		http.Error(w, "Country code is required", http.StatusBadRequest)
		return
	}

	// Convert to uppercase
	req.CountryCode = strings.ToUpper(req.CountryCode)

	if err := ah.countryBanManager.UnbanCountry(req.CountryCode); err != nil {
		http.Error(w, fmt.Sprintf("Failed to unban country: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": fmt.Sprintf("Unbanned country %s", req.CountryCode),
	}); err != nil {
		log.Printf("Error encoding unban country response: %v", err)
	}
}

// HandleBannedCountries returns the list of banned countries
func (ah *AdminHandler) HandleBannedCountries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bannedCountries := ah.countryBanManager.GetBannedCountries()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"banned_countries": bannedCountries,
		"count":            len(bannedCountries),
	}); err != nil {
		log.Printf("Error encoding banned countries: %v", err)
	}
}
