package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// AdminHandler handles admin configuration endpoints
type AdminHandler struct {
	config     *Config
	configFile string
	sessions   *SessionManager
}

// NewAdminHandler creates a new admin handler
func NewAdminHandler(config *Config, configFile string, sessions *SessionManager) *AdminHandler {
	return &AdminHandler{
		config:     config,
		configFile: configFile,
		sessions:   sessions,
	}
}

// AuthMiddleware checks for admin password
func (ah *AdminHandler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Get password from Authorization header (Basic auth) or query parameter
		password := r.Header.Get("X-Admin-Password")
		if password == "" {
			password = r.URL.Query().Get("password")
		}

		if password == "" {
			http.Error(w, "Missing admin password", http.StatusUnauthorized)
			return
		}

		if password != ah.config.Admin.Password {
			http.Error(w, "Invalid admin password", http.StatusForbidden)
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
	bookmarks = append(bookmarks, map[string]interface{}{
		"name":      newBookmark.Name,
		"frequency": newBookmark.Frequency,
		"mode":      newBookmark.Mode,
	})
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
	bookmarks[index] = map[string]interface{}{
		"name":      updatedBookmark.Name,
		"frequency": updatedBookmark.Frequency,
		"mode":      updatedBookmark.Mode,
	}
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

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Bookmark deleted successfully",
	})
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
