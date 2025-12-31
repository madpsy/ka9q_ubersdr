package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
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
func convertFrequencies(v interface{}) {
	switch val := v.(type) {
	case map[string]interface{}:
		// Check if this is a decoder band with a frequency field
		if freq, ok := val["frequency"]; ok {
			switch f := freq.(type) {
			case float64:
				val["frequency"] = uint64(f)
			case int:
				val["frequency"] = uint64(f)
			case int64:
				val["frequency"] = uint64(f)
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
	audioReceiver       *AudioReceiver
	userSpectrumManager *UserSpectrumManager
	noiseFloorMonitor   *NoiseFloorMonitor
	multiDecoder        *MultiDecoder
	dxCluster           *DXClusterClient
	spaceWeatherMonitor *SpaceWeatherMonitor
	cwSkimmerConfig     *CWSkimmerConfig
	cwSkimmerClient     *CWSkimmerClient
	instanceReporter    *InstanceReporter
	loginAttempts       *LoginAttemptTracker
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
func NewAdminHandler(config *Config, configFile string, configDir string, sessions *SessionManager, ipBanManager *IPBanManager, audioReceiver *AudioReceiver, userSpectrumManager *UserSpectrumManager, noiseFloorMonitor *NoiseFloorMonitor, multiDecoder *MultiDecoder, dxCluster *DXClusterClient, spaceWeatherMonitor *SpaceWeatherMonitor, cwSkimmerConfig *CWSkimmerConfig, cwSkimmerClient *CWSkimmerClient, instanceReporter *InstanceReporter) *AdminHandler {
	return &AdminHandler{
		config:              config,
		configFile:          configFile,
		configDir:           configDir,
		sessions:            sessions,
		adminSessions:       NewAdminSessionStore(),
		ipBanManager:        ipBanManager,
		audioReceiver:       audioReceiver,
		userSpectrumManager: userSpectrumManager,
		noiseFloorMonitor:   noiseFloorMonitor,
		multiDecoder:        multiDecoder,
		dxCluster:           dxCluster,
		spaceWeatherMonitor: spaceWeatherMonitor,
		cwSkimmerConfig:     cwSkimmerConfig,
		cwSkimmerClient:     cwSkimmerClient,
		instanceReporter:    instanceReporter,
		loginAttempts:       NewLoginAttemptTracker(),
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

	// Only trust X-Real-IP if request comes from tunnel server
	if globalConfig != nil && globalConfig.InstanceReporting.IsTunnelServer(clientIP) {
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

// AuthMiddleware checks for valid admin session or password header
func (ah *AdminHandler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check for password in X-Admin-Password header first
		if password := r.Header.Get("X-Admin-Password"); password != "" {
			if password == ah.config.Admin.Password {
				// Valid password, proceed
				next(w, r)
				return
			}
			// Invalid password
			http.Error(w, "Unauthorized - invalid password", http.StatusUnauthorized)
			return
		}

		// Fall back to cookie-based authentication
		cookie, err := r.Cookie("admin_session")
		if err != nil {
			http.Error(w, "Unauthorized - no session or password", http.StatusUnauthorized)
			return
		}

		// Validate session
		if !ah.adminSessions.ValidateSession(cookie.Value) {
			http.Error(w, "Unauthorized - invalid or expired session", http.StatusUnauthorized)
			return
		}

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

	// Convert to YAML and write to file
	yamlData, err := yaml.Marshal(newConfig)
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

	// Convert to YAML and write to file
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
	case reflect.Int, reflect.Int64:
		switch v := newValue.(type) {
		case float64:
			return int(v)
		case string:
			if i, err := strconv.Atoi(v); err == nil {
				return i
			}
		}
	case reflect.Float64:
		switch v := newValue.(type) {
		case int:
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

// handleUpdateBookmarks updates a single bookmark by index or replaces all bookmarks
func (ah *AdminHandler) handleUpdateBookmarks(w http.ResponseWriter, r *http.Request) {
	indexStr := r.URL.Query().Get("index")

	// If no index provided, replace all bookmarks (for import functionality)
	if indexStr == "" {
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

	// Update single bookmark by index
	index, err := strconv.Atoi(indexStr)
	if err != nil {
		http.Error(w, "Invalid index", http.StatusBadRequest)
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
	if !ok || index < 0 || index >= len(bookmarks) {
		http.Error(w, "Invalid bookmark index", http.StatusBadRequest)
		return
	}

	// Sort bookmarks the same way as in GET to ensure index consistency
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
	bookmarks[index] = bookmarkMap
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

// handleDeleteBookmark deletes a bookmark by index
func (ah *AdminHandler) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
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
	if !ok || index < 0 || index >= len(bookmarks) {
		http.Error(w, "Invalid bookmark index", http.StatusBadRequest)
		return
	}

	// Remove bookmark at index
	bookmarks = append(bookmarks[:index], bookmarks[index+1:]...)
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

// handleUpdateBands updates a single band by index or replaces all bands
func (ah *AdminHandler) handleUpdateBands(w http.ResponseWriter, r *http.Request) {
	indexStr := r.URL.Query().Get("index")

	// If no index provided, replace all bands (for import functionality)
	if indexStr == "" {
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

	// Update single band by index
	index, err := strconv.Atoi(indexStr)
	if err != nil {
		http.Error(w, "Invalid index", http.StatusBadRequest)
		return
	}

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
	if !ok || index < 0 || index >= len(bands) {
		http.Error(w, "Invalid band index", http.StatusBadRequest)
		return
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
	bands[index] = bandMap
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

// handleDeleteBand deletes a band by index
func (ah *AdminHandler) handleDeleteBand(w http.ResponseWriter, r *http.Request) {
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
	if !ok || index < 0 || index >= len(bands) {
		http.Error(w, "Invalid band index", http.StatusBadRequest)
		return
	}

	// Remove band at index
	bands = append(bands[:index], bands[index+1:]...)
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

	response := map[string]interface{}{
		"sessions": sessions,
		"count":    len(sessions),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding sessions: %v", err)
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

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"banned_ips": bannedIPs,
		"count":      len(bannedIPs),
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

	// Format uptime similar to ps output
	var uptimeStr string
	if days > 0 {
		uptimeStr = fmt.Sprintf("%d-%02d:%02d:%02d", days, hours, minutes, seconds)
	} else if hours > 0 {
		uptimeStr = fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
	} else {
		uptimeStr = fmt.Sprintf("%02d:%02d", minutes, seconds)
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
		duCmd := exec.Command("du", "-sh", ah.config.Decoder.MetricsLogDataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["decoder_metrics"] = string(duOutput)
		} else {
			dataDirs["decoder_metrics"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.config.Decoder.MetricsLogDataDir)
		}
	}

	// Decoder spots directory
	if ah.config.Decoder.Enabled && ah.config.Decoder.SpotsLogEnabled && ah.config.Decoder.SpotsLogDataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.config.Decoder.SpotsLogDataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["decoder_spots"] = string(duOutput)
		} else {
			dataDirs["decoder_spots"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.config.Decoder.SpotsLogDataDir)
		}
	}

	// Decoder metrics summary directory
	if ah.config.Decoder.Enabled && ah.config.Decoder.MetricsLogEnabled && ah.config.Decoder.MetricsSummaryDataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.config.Decoder.MetricsSummaryDataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["decoder_summary"] = string(duOutput)
		} else {
			dataDirs["decoder_summary"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.config.Decoder.MetricsSummaryDataDir)
		}
	}

	// Noise floor directory
	if ah.config.NoiseFloor.Enabled && ah.config.NoiseFloor.DataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.config.NoiseFloor.DataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["noisefloor"] = string(duOutput)
		} else {
			dataDirs["noisefloor"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.config.NoiseFloor.DataDir)
		}
	}

	// Space weather directory
	if ah.config.SpaceWeather.Enabled && ah.config.SpaceWeather.LogToCSV && ah.config.SpaceWeather.DataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.config.SpaceWeather.DataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["spaceweather"] = string(duOutput)
		} else {
			dataDirs["spaceweather"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.config.SpaceWeather.DataDir)
		}
	}

	// CW Skimmer spots directory
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled && ah.cwSkimmerConfig.SpotsLogEnabled && ah.cwSkimmerConfig.SpotsLogDataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.cwSkimmerConfig.SpotsLogDataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["cwskimmer_spots"] = string(duOutput)
		} else {
			dataDirs["cwskimmer_spots"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.cwSkimmerConfig.SpotsLogDataDir)
		}
	}

	// CW Skimmer metrics directory
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled && ah.cwSkimmerConfig.MetricsLogEnabled && ah.cwSkimmerConfig.MetricsLogDataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.cwSkimmerConfig.MetricsLogDataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["cwskimmer_metrics"] = string(duOutput)
		} else {
			dataDirs["cwskimmer_metrics"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.cwSkimmerConfig.MetricsLogDataDir)
		}
	}

	// CW Skimmer summaries directory
	if ah.cwSkimmerConfig != nil && ah.cwSkimmerConfig.Enabled && ah.cwSkimmerConfig.MetricsLogEnabled && ah.cwSkimmerConfig.MetricsSummaryDataDir != "" {
		duCmd := exec.Command("du", "-sh", ah.cwSkimmerConfig.MetricsSummaryDataDir)
		if duOutput, err := duCmd.CombinedOutput(); err == nil {
			dataDirs["cwskimmer_summaries"] = string(duOutput)
		} else {
			dataDirs["cwskimmer_summaries"] = fmt.Sprintf("Error: %v (path: %s)", err, ah.cwSkimmerConfig.MetricsSummaryDataDir)
		}
	}

	// Add data directories to stats if any were found
	if len(dataDirs) > 0 {
		stats["data_directories"] = dataDirs
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
