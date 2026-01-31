package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ChatLogEntry represents a single chat message from logs
type ChatLogEntry struct {
	Timestamp   time.Time `json:"timestamp"`
	SourceIP    string    `json:"source_ip"`
	Username    string    `json:"username"`
	Message     string    `json:"message"`
	Country     string    `json:"country,omitempty"`
	CountryCode string    `json:"country_code,omitempty"`
}

// ChatLogFilter contains filter criteria for chat logs
type ChatLogFilter struct {
	StartDate time.Time
	EndDate   time.Time
	IP        string
	Nickname  string
	Message   string
	Limit     int
}

// HandleChatLogs returns chat logs with optional filtering
// Query parameters:
//   - start: Start date in YYYY-MM-DD format (default: today)
//   - end: End date in YYYY-MM-DD format (default: today)
//   - ip: Filter by source IP (optional, partial match)
//   - nickname: Filter by username (optional, case-insensitive partial match)
//   - message: Filter by message content (optional, case-insensitive partial match)
//   - limit: Maximum number of results (optional, default: 1000, max: 10000)
func (ah *AdminHandler) HandleChatLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Check if chat logging is enabled
	if !ah.config.Chat.LogToCSV {
		http.Error(w, "Chat logging is not enabled", http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"error":   "not_enabled",
			"message": "Chat logging is not enabled in configuration",
		}); err != nil {
			log.Printf("Error encoding response: %v", err)
		}
		return
	}

	// Parse filter parameters
	filter, err := parseChatLogFilter(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("Invalid filter parameters: %v", err), http.StatusBadRequest)
		return
	}

	// Read and filter logs
	logs, err := readChatLogs(ah.config.Chat.DataDir, filter)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read chat logs: %v", err), http.StatusInternalServerError)
		return
	}

	// Return response
	response := map[string]interface{}{
		"start_date": filter.StartDate.Format("2006-01-02"),
		"end_date":   filter.EndDate.Format("2006-01-02"),
		"count":      len(logs),
		"logs":       logs,
	}

	if filter.IP != "" {
		response["ip_filter"] = filter.IP
	}
	if filter.Nickname != "" {
		response["nickname_filter"] = filter.Nickname
	}
	if filter.Message != "" {
		response["message_filter"] = filter.Message
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding chat logs: %v", err)
	}
}

// parseChatLogFilter parses query parameters into a ChatLogFilter
func parseChatLogFilter(r *http.Request) (*ChatLogFilter, error) {
	filter := &ChatLogFilter{
		StartDate: time.Now().UTC().Truncate(24 * time.Hour),
		EndDate:   time.Now().UTC().Truncate(24 * time.Hour),
		Limit:     1000,
	}

	// Parse start date
	if startStr := r.URL.Query().Get("start"); startStr != "" {
		t, err := time.Parse("2006-01-02", startStr)
		if err != nil {
			return nil, fmt.Errorf("invalid start date format (use YYYY-MM-DD): %v", err)
		}
		filter.StartDate = t.UTC()
	}

	// Parse end date
	if endStr := r.URL.Query().Get("end"); endStr != "" {
		t, err := time.Parse("2006-01-02", endStr)
		if err != nil {
			return nil, fmt.Errorf("invalid end date format (use YYYY-MM-DD): %v", err)
		}
		filter.EndDate = t.UTC()
	}

	// Validate date range
	if filter.StartDate.After(filter.EndDate) {
		return nil, fmt.Errorf("start date must be before or equal to end date")
	}

	// Check date range limit (max 31 days to prevent abuse)
	if filter.EndDate.Sub(filter.StartDate) > 31*24*time.Hour {
		return nil, fmt.Errorf("date range cannot exceed 31 days")
	}

	// Parse optional filters
	filter.IP = strings.TrimSpace(r.URL.Query().Get("ip"))
	filter.Nickname = strings.TrimSpace(r.URL.Query().Get("nickname"))
	filter.Message = strings.TrimSpace(r.URL.Query().Get("message"))

	// Parse limit
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		limit, err := strconv.Atoi(limitStr)
		if err != nil || limit < 1 || limit > 10000 {
			return nil, fmt.Errorf("invalid limit (must be 1-10000)")
		}
		filter.Limit = limit
	}

	return filter, nil
}

// readChatLogs reads and filters chat logs from disk
func readChatLogs(dataDir string, filter *ChatLogFilter) ([]ChatLogEntry, error) {
	var allLogs []ChatLogEntry

	// Iterate through each day in the date range
	currentDate := filter.StartDate
	for !currentDate.After(filter.EndDate) {
		// Build file path: dataDir/YYYY/MM/DD/chat.csv
		filePath := filepath.Join(
			dataDir,
			fmt.Sprintf("%04d", currentDate.Year()),
			fmt.Sprintf("%02d", currentDate.Month()),
			fmt.Sprintf("%02d", currentDate.Day()),
			"chat.csv",
		)

		// Read logs from this file
		dayLogs, err := readChatLogFile(filePath, filter)
		if err != nil {
			if os.IsNotExist(err) {
				// File doesn't exist for this day - skip
				currentDate = currentDate.Add(24 * time.Hour)
				continue
			}
			return nil, fmt.Errorf("failed to read %s: %w", filePath, err)
		}

		allLogs = append(allLogs, dayLogs...)

		// Check if we've hit the limit
		if len(allLogs) >= filter.Limit {
			allLogs = allLogs[:filter.Limit]
			break
		}

		currentDate = currentDate.Add(24 * time.Hour)
	}

	// Sort by timestamp (most recent first)
	sort.Slice(allLogs, func(i, j int) bool {
		return allLogs[i].Timestamp.After(allLogs[j].Timestamp)
	})

	return allLogs, nil
}

// readChatLogFile reads and filters a single chat log CSV file
func readChatLogFile(filePath string, filter *ChatLogFilter) ([]ChatLogEntry, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	reader := csv.NewReader(file)

	// Read header
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("failed to read header: %w", err)
	}

	// Validate header - support both old (4 columns) and new (6 columns) formats
	if len(header) == 6 {
		expectedHeader := []string{"timestamp", "source_ip", "username", "message", "country", "country_code"}
		for i, h := range header {
			if h != expectedHeader[i] {
				return nil, fmt.Errorf("invalid header format")
			}
		}
	} else if len(header) == 4 {
		expectedHeader := []string{"timestamp", "source_ip", "username", "message"}
		for i, h := range header {
			if h != expectedHeader[i] {
				return nil, fmt.Errorf("invalid header format")
			}
		}
	} else {
		return nil, fmt.Errorf("invalid header format: expected 4 or 6 columns, got %d", len(header))
	}

	var logs []ChatLogEntry

	// Read all records
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("Warning: error reading CSV record: %v", err)
			continue
		}

		// Support both old (4 columns) and new (6 columns) formats
		if len(record) != 4 && len(record) != 6 {
			log.Printf("Warning: invalid record length: %d (expected 4 or 6)", len(record))
			continue
		}

		// Parse timestamp
		timestamp, err := time.Parse(time.RFC3339, record[0])
		if err != nil {
			log.Printf("Warning: invalid timestamp: %v", err)
			continue
		}

		entry := ChatLogEntry{
			Timestamp: timestamp,
			SourceIP:  record[1],
			Username:  record[2],
			Message:   record[3],
		}

		// Add country fields if present (new format)
		if len(record) == 6 {
			entry.Country = record[4]
			entry.CountryCode = record[5]
		}

		// Apply filters
		if !matchesChatFilter(entry, filter) {
			continue
		}

		logs = append(logs, entry)

		// Check limit
		if len(logs) >= filter.Limit {
			break
		}
	}

	return logs, nil
}

// matchesChatFilter checks if a log entry matches the filter criteria
func matchesChatFilter(entry ChatLogEntry, filter *ChatLogFilter) bool {
	// IP filter (partial match)
	if filter.IP != "" && !strings.Contains(entry.SourceIP, filter.IP) {
		return false
	}

	// Nickname filter (case-insensitive partial match)
	if filter.Nickname != "" {
		if !strings.Contains(strings.ToLower(entry.Username), strings.ToLower(filter.Nickname)) {
			return false
		}
	}

	// Message filter (case-insensitive partial match)
	if filter.Message != "" {
		if !strings.Contains(strings.ToLower(entry.Message), strings.ToLower(filter.Message)) {
			return false
		}
	}

	return true
}
