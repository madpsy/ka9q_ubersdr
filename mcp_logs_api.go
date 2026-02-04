package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

// handleMCPLogsAPI serves the MCP request logs
// This is an admin-only endpoint that returns logged MCP requests
//
// Query parameters:
//   - limit: maximum number of logs to return (default: 100, max: 1000)
//
// Example: GET /admin/mcp-logs?limit=50
func handleMCPLogsAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if logger is initialized
	if globalMCPRequestLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "MCP request logger not initialized",
			"logs":  []MCPRequestLog{},
			"count": 0,
		})
		return
	}

	// Parse limit parameter
	limitStr := r.URL.Query().Get("limit")
	limit := 100 // default
	if limitStr != "" {
		if parsedLimit, err := strconv.Atoi(limitStr); err == nil {
			if parsedLimit > 0 && parsedLimit <= 1000 {
				limit = parsedLimit
			}
		}
	}

	// Get all requests
	allRequests := globalMCPRequestLogger.GetRequests()

	// Apply limit
	requests := allRequests
	if len(requests) > limit {
		requests = requests[:limit]
	}

	// Build response
	response := map[string]interface{}{
		"logs":        requests,
		"count":       len(requests),
		"total_count": globalMCPRequestLogger.GetRequestCount(),
		"limit":       limit,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding MCP logs response: %v", err)
	}
}
