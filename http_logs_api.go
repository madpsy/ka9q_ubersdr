package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// HTTPLogsAPIResponse represents the JSON response for the HTTP logs API
type HTTPLogsAPIResponse struct {
	Success bool           `json:"success"`
	Count   int            `json:"count"`
	Total   int            `json:"total"`
	MaxSize int            `json:"max_size"`
	Logs    []HTTPLogEntry `json:"logs"`
}

// handleHTTPLogsAPI handles GET requests to retrieve HTTP request logs
// Query parameters:
//   - limit: number of recent logs to return (default: 100, max: 1000)
//   - filter_ip: filter by client IP (optional, partial match)
//   - filter_path: filter by URI path (optional, partial match)
//   - filter_method: filter by HTTP method (optional, exact match)
//   - min_status: filter by minimum status code (optional)
//   - max_status: filter by maximum status code (optional)
func handleHTTPLogsAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	buffer := GetHTTPLogBuffer()
	if buffer == nil {
		http.Error(w, "HTTP log buffer not initialized", http.StatusInternalServerError)
		return
	}

	// Parse limit parameter
	limitStr := r.URL.Query().Get("limit")
	limit := 100 // default
	if limitStr != "" {
		if parsedLimit, err := strconv.Atoi(limitStr); err == nil {
			limit = parsedLimit
			if limit > 1000 {
				limit = 1000
			}
			if limit < 1 {
				limit = 1
			}
		}
	}

	// Parse filter parameters
	filterIP := r.URL.Query().Get("filter_ip")
	filterPath := r.URL.Query().Get("filter_path")
	filterMethod := strings.ToUpper(r.URL.Query().Get("filter_method"))
	minStatusStr := r.URL.Query().Get("min_status")
	maxStatusStr := r.URL.Query().Get("max_status")

	// Parse status code filters
	minStatus := 0
	maxStatus := 999
	if minStatusStr != "" {
		if parsed, err := strconv.Atoi(minStatusStr); err == nil {
			minStatus = parsed
		}
	}
	if maxStatusStr != "" {
		if parsed, err := strconv.Atoi(maxStatusStr); err == nil {
			maxStatus = parsed
		}
	}

	// Get all logs
	allLogs := buffer.GetLogs()

	// Apply filters
	var filteredLogs []HTTPLogEntry
	for _, log := range allLogs {
		// Filter by IP (partial match)
		if filterIP != "" && !strings.Contains(log.ClientIP, filterIP) {
			continue
		}

		// Filter by path (partial match)
		if filterPath != "" && !strings.Contains(log.URI, filterPath) {
			continue
		}

		// Filter by method (exact match)
		if filterMethod != "" && log.Method != filterMethod {
			continue
		}

		// Filter by status code range
		if log.StatusCode < minStatus || log.StatusCode > maxStatus {
			continue
		}

		filteredLogs = append(filteredLogs, log)
	}

	// Get the most recent logs up to limit
	var resultLogs []HTTPLogEntry
	if limit >= len(filteredLogs) {
		resultLogs = filteredLogs
	} else {
		// Get the last 'limit' entries
		start := len(filteredLogs) - limit
		resultLogs = filteredLogs[start:]
	}

	// Build response
	response := HTTPLogsAPIResponse{
		Success: true,
		Count:   len(resultLogs),
		Total:   len(filteredLogs),
		MaxSize: buffer.GetMaxSize(),
		Logs:    resultLogs,
	}

	// Send JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}
}
