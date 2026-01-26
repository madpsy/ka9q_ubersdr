package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// LogsAPIResponse represents the JSON response for the logs API
type LogsAPIResponse struct {
	Success        bool       `json:"success"`
	Count          int        `json:"count"`
	Total          int        `json:"total"`
	Logs           []LogEntry `json:"logs"`
	ContainerNames []string   `json:"container_names"`
}

// handleLogsAPI handles GET requests to retrieve logs
// Query parameters:
//   - limit: number of recent logs to return (default: 100, max: 1000)
//   - container: filter by container name (optional)
func handleLogsAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	receiver := GetLogReceiver()
	if receiver == nil {
		http.Error(w, "Log receiver not initialized", http.StatusInternalServerError)
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

	// Parse container filter parameter (required)
	containerFilter := r.URL.Query().Get("container")

	// Get available container names
	containerNames := receiver.GetContainerNames()

	// Container name is required
	if containerFilter == "" {
		// Return empty logs with available container names
		response := LogsAPIResponse{
			Success:        true,
			Count:          0,
			Total:          0,
			Logs:           []LogEntry{},
			ContainerNames: containerNames,
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(response); err != nil {
			http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		}
		return
	}

	// Get logs for the specified container
	var logs []LogEntry
	if limit >= receiver.GetLogCount(containerFilter) {
		logs = receiver.GetLogs(containerFilter)
	} else {
		logs = receiver.GetRecentLogs(limit, containerFilter)
	}

	// Build response
	response := LogsAPIResponse{
		Success:        true,
		Count:          len(logs),
		Total:          receiver.GetLogCount(containerFilter),
		Logs:           logs,
		ContainerNames: containerNames,
	}

	// Send JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}
}
