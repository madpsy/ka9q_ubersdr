package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
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

// HandleChatLogs returns chat logs with optional filtering from the SQLite database.
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

	if ah.dbManager == nil || ah.dbManager.ReadDB() == nil {
		http.Error(w, "Chat logs are not available (database not configured)", http.StatusServiceUnavailable)
		return
	}

	// Parse filter parameters
	filter, err := parseChatLogFilter(r)
	if err != nil {
		http.Error(w, fmt.Sprintf("Invalid filter parameters: %v", err), http.StatusBadRequest)
		return
	}

	// Read and filter logs from DB
	logs, err := readChatLogsFromDB(ah.dbManager.ReadDB(), filter)
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

// readChatLogsFromDB reads and filters chat logs from the SQLite database.
// Results are returned in reverse-chronological order (most recent first).
func readChatLogsFromDB(db *sql.DB, filter *ChatLogFilter) ([]ChatLogEntry, error) {
	startTS := filter.StartDate.Unix()
	// endDate is inclusive — include the full day
	endTS := filter.EndDate.Add(24 * time.Hour).Unix()

	query := `SELECT ts, source_ip, username, message, country, country_code
	          FROM chat_messages
	          WHERE ts >= ? AND ts < ?`
	args := []interface{}{startTS, endTS}

	if filter.IP != "" {
		query += " AND source_ip LIKE ?"
		args = append(args, "%"+filter.IP+"%")
	}
	if filter.Nickname != "" {
		query += " AND LOWER(username) LIKE ?"
		args = append(args, "%"+strings.ToLower(filter.Nickname)+"%")
	}
	if filter.Message != "" {
		query += " AND LOWER(message) LIKE ?"
		args = append(args, "%"+strings.ToLower(filter.Message)+"%")
	}

	query += " ORDER BY ts DESC LIMIT ?"
	args = append(args, filter.Limit)

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("chat_messages query error: %w", err)
	}
	defer rows.Close()

	var logs []ChatLogEntry
	for rows.Next() {
		var ts int64
		var entry ChatLogEntry
		if err := rows.Scan(&ts, &entry.SourceIP, &entry.Username, &entry.Message,
			&entry.Country, &entry.CountryCode); err != nil {
			log.Printf("Warning: chat_messages scan error: %v", err)
			continue
		}
		entry.Timestamp = time.Unix(ts, 0).UTC()
		logs = append(logs, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return logs, nil
}
