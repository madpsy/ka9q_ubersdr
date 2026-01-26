package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

// LogEntry represents a single log entry from Fluent Bit
type LogEntry struct {
	Timestamp     time.Time              `json:"date"`
	Log           string                 `json:"log"`
	Source        string                 `json:"source"`
	ContainerName string                 `json:"container_name"`
	Metadata      map[string]interface{} `json:"-"` // Store any additional fields
}

// LogReceiver manages the TCP server and log storage
type LogReceiver struct {
	mu      sync.RWMutex
	logs    []LogEntry
	maxSize int
	port    int
}

// NewLogReceiver creates a new log receiver with specified port and max entries
func NewLogReceiver(port, maxSize int) *LogReceiver {
	return &LogReceiver{
		logs:    make([]LogEntry, 0, maxSize),
		maxSize: maxSize,
		port:    port,
	}
}

// AddLog adds a log entry to the rolling window
func (lr *LogReceiver) AddLog(entry LogEntry) {
	lr.mu.Lock()
	defer lr.mu.Unlock()

	// Add the new entry
	lr.logs = append(lr.logs, entry)

	// If we exceed max size, remove oldest entries
	if len(lr.logs) > lr.maxSize {
		// Keep only the most recent maxSize entries
		lr.logs = lr.logs[len(lr.logs)-lr.maxSize:]
	}
}

// GetLogs returns a copy of all logs in the rolling window
func (lr *LogReceiver) GetLogs() []LogEntry {
	lr.mu.RLock()
	defer lr.mu.RUnlock()

	// Return a copy to prevent external modification
	logsCopy := make([]LogEntry, len(lr.logs))
	copy(logsCopy, lr.logs)
	return logsCopy
}

// GetRecentLogs returns the most recent n logs
func (lr *LogReceiver) GetRecentLogs(n int) []LogEntry {
	lr.mu.RLock()
	defer lr.mu.RUnlock()

	if n > len(lr.logs) {
		n = len(lr.logs)
	}

	// Get the last n entries
	start := len(lr.logs) - n
	logsCopy := make([]LogEntry, n)
	copy(logsCopy, lr.logs[start:])
	return logsCopy
}

// GetLogCount returns the current number of logs stored
func (lr *LogReceiver) GetLogCount() int {
	lr.mu.RLock()
	defer lr.mu.RUnlock()
	return len(lr.logs)
}

// handleConnection processes a single TCP connection from Fluent Bit
func (lr *LogReceiver) handleConnection(conn net.Conn) {
	defer conn.Close()

	remoteAddr := conn.RemoteAddr().String()
	log.Printf("New connection from %s", remoteAddr)

	reader := bufio.NewReader(conn)

	for {
		// Set read deadline to detect stale connections
		conn.SetReadDeadline(time.Now().Add(5 * time.Minute))

		// Read a line (Fluent Bit TCP output sends JSON lines)
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err != io.EOF {
				log.Printf("Error reading from %s: %v", remoteAddr, err)
			}
			break
		}

		// Parse the JSON log entry
		var rawEntry map[string]interface{}
		if err := json.Unmarshal(line, &rawEntry); err != nil {
			log.Printf("Error parsing JSON from %s: %v", remoteAddr, err)
			continue
		}

		// Extract standard fields
		entry := LogEntry{
			Timestamp: time.Now(), // Default to now
			Metadata:  make(map[string]interface{}),
		}

		// Parse timestamp if present
		if dateVal, ok := rawEntry["date"]; ok {
			switch v := dateVal.(type) {
			case float64:
				entry.Timestamp = time.Unix(int64(v), 0)
			case string:
				if t, err := time.Parse(time.RFC3339, v); err == nil {
					entry.Timestamp = t
				}
			}
		}

		// Extract common fields
		if logVal, ok := rawEntry["log"].(string); ok {
			entry.Log = logVal
		}
		if sourceVal, ok := rawEntry["source"].(string); ok {
			entry.Source = sourceVal
		}
		if containerNameVal, ok := rawEntry["container_name"].(string); ok {
			entry.ContainerName = containerNameVal
		}

		// Store all other fields in metadata
		for key, val := range rawEntry {
			if key != "date" && key != "log" && key != "source" && key != "container_name" {
				entry.Metadata[key] = val
			}
		}

		// Add to rolling window
		lr.AddLog(entry)
	}

	log.Printf("Connection closed from %s", remoteAddr)
}

// Start begins listening for TCP connections
func (lr *LogReceiver) Start() error {
	addr := fmt.Sprintf(":%d", lr.port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}

	log.Printf("Log receiver listening on %s (max %d entries)", addr, lr.maxSize)

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				log.Printf("Error accepting connection: %v", err)
				continue
			}

			// Handle each connection in a separate goroutine
			go lr.handleConnection(conn)
		}
	}()

	return nil
}

// Global log receiver instance
var globalLogReceiver *LogReceiver

// InitLogReceiver initializes the global log receiver
func InitLogReceiver(port, maxSize int) error {
	globalLogReceiver = NewLogReceiver(port, maxSize)
	return globalLogReceiver.Start()
}

// GetLogReceiver returns the global log receiver instance
func GetLogReceiver() *LogReceiver {
	return globalLogReceiver
}
