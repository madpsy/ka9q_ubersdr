package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

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

// AdminHandler handles admin configuration endpoints
type AdminHandler struct {
	config        *Config
	configFile    string
	sessions      *SessionManager
	adminSessions *AdminSessionStore
	ipBanManager  *IPBanManager
}

// NewAdminHandler creates a new admin handler
func NewAdminHandler(config *Config, configFile string, sessions *SessionManager, ipBanManager *IPBanManager) *AdminHandler {
	return &AdminHandler{
		config:        config,
		configFile:    configFile,
		sessions:      sessions,
		adminSessions: NewAdminSessionStore(),
		ipBanManager:  ipBanManager,
	}
}

// HandleLogin handles admin login and creates a session
func (ah *AdminHandler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
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
		http.Error(w, "Invalid password", http.StatusUnauthorized)
		return
	}

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

// AuthMiddleware checks for valid admin session
func (ah *AdminHandler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Get session token from cookie
		cookie, err := r.Cookie("admin_session")
		if err != nil {
			http.Error(w, "Unauthorized - no session", http.StatusUnauthorized)
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
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Configuration updated. Restart server to apply changes.",
	})
}

// handlePatchConfig updates specific configuration values
func (ah *AdminHandler) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
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
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Configuration updated. Restart server to apply changes.",
	})
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
	data, err := os.ReadFile("bookmarks.yaml")
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
	data, err := os.ReadFile("bookmarks.yaml")
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
	if newBookmark.Extension != "" {
		bookmarkMap["extension"] = newBookmark.Extension
	}
	bookmarks = append(bookmarks, bookmarkMap)
	bookmarksConfig["bookmarks"] = bookmarks

	// Write back to file
	yamlData, err := yaml.Marshal(bookmarksConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile("bookmarks.yaml", yamlData, 0644); err != nil {
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

		// Convert to YAML and write to file
		yamlData, err := yaml.Marshal(bookmarksConfig)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
			return
		}

		if err := os.WriteFile("bookmarks.yaml", yamlData, 0644); err != nil {
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
	data, err := os.ReadFile("bookmarks.yaml")
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

	// Update bookmark at index
	bookmarkMap := map[string]interface{}{
		"name":      updatedBookmark.Name,
		"frequency": updatedBookmark.Frequency,
		"mode":      updatedBookmark.Mode,
	}
	if updatedBookmark.Extension != "" {
		bookmarkMap["extension"] = updatedBookmark.Extension
	}
	bookmarks[index] = bookmarkMap
	bookmarksConfig["bookmarks"] = bookmarks

	// Write back to file
	yamlData, err := yaml.Marshal(bookmarksConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bookmarks: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile("bookmarks.yaml", yamlData, 0644); err != nil {
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
	data, err := os.ReadFile("bookmarks.yaml")
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

	if err := os.WriteFile("bookmarks.yaml", yamlData, 0644); err != nil {
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
	bookmarksConfig, err := LoadConfig("bookmarks.yaml")
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

// handleGetBands returns all bands
func (ah *AdminHandler) handleGetBands(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile("bands.yaml")
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

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(bandsConfig)
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

	// Read existing bands
	var bandsConfig map[string]interface{}
	data, err := os.ReadFile("bands.yaml")
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
	bands = append(bands, bandMap)
	bandsConfig["bands"] = bands

	// Write back to file
	yamlData, err := yaml.Marshal(bandsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile("bands.yaml", yamlData, 0644); err != nil {
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

		// Convert to YAML and write to file
		yamlData, err := yaml.Marshal(bandsConfig)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
			return
		}

		if err := os.WriteFile("bands.yaml", yamlData, 0644); err != nil {
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

	// Read existing bands
	data, err := os.ReadFile("bands.yaml")
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
	bands[index] = bandMap
	bandsConfig["bands"] = bands

	// Write back to file
	yamlData, err := yaml.Marshal(bandsConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal bands: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile("bands.yaml", yamlData, 0644); err != nil {
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
	data, err := os.ReadFile("bands.yaml")
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

	if err := os.WriteFile("bands.yaml", yamlData, 0644); err != nil {
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
	bandsConfig, err := LoadConfig("bands.yaml")
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

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"extensions": extensions,
	}); err != nil {
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
	data, err := os.ReadFile("extensions.yaml")
	if err != nil {
		// If file doesn't exist, return empty extensions
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"extensions": []string{}})
		return
	}

	var extensionsConfig map[string]interface{}
	if err := yaml.Unmarshal(data, &extensionsConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse extensions: %v", err), http.StatusInternalServerError)
		return
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

	if err := os.WriteFile("extensions.yaml", yamlData, 0644); err != nil {
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
	extensionsConfig, err := LoadConfig("extensions.yaml")
	if err != nil {
		return fmt.Errorf("failed to reload extensions: %w", err)
	}
	ah.config.Extensions = extensionsConfig.Extensions
	log.Printf("Reloaded %d extensions from extensions.yaml", len(ah.config.Extensions))
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
