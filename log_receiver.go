package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"regexp"
	"sync"
	"time"
)

// Regular expression to match valid characters (alphanumeric and underscore)
var containerNameRegex = regexp.MustCompile(`[^a-zA-Z0-9_]`)

// sanitizeContainerName strips any characters that are not alphanumeric or underscore
func sanitizeContainerName(name string) string {
	return containerNameRegex.ReplaceAllString(name, "")
}

// LogEntry represents a single log entry from Fluent Bit
type LogEntry struct {
	Timestamp     time.Time              `json:"date"`
	Log           string                 `json:"log"`
	Source        string                 `json:"source"`
	ContainerName string                 `json:"container_name"`
	Metadata      map[string]interface{} `json:"-"` // Store any additional fields
}

// LogReceiver manages the TCP server and log storage
// Maintains separate rolling windows for each container
type LogReceiver struct {
	mu                  sync.RWMutex
	logsByContainer     map[string][]LogEntry // Container name -> logs
	maxSizePerContainer int
	port                int
}

// NewLogReceiver creates a new log receiver with specified port and max entries per container
func NewLogReceiver(port, maxSizePerContainer int) *LogReceiver {
	return &LogReceiver{
		logsByContainer:     make(map[string][]LogEntry),
		maxSizePerContainer: maxSizePerContainer,
		port:                port,
	}
}

// AddLog adds a log entry to the rolling window for its container
func (lr *LogReceiver) AddLog(entry LogEntry) {
	lr.mu.Lock()
	defer lr.mu.Unlock()

	containerName := entry.ContainerName
	if containerName == "" {
		containerName = "unknown"
	}

	// Get or create the log slice for this container
	logs, exists := lr.logsByContainer[containerName]
	if !exists {
		logs = make([]LogEntry, 0, lr.maxSizePerContainer)
	}

	// Add the new entry
	logs = append(logs, entry)

	// If we exceed max size for this container, remove oldest entries
	if len(logs) > lr.maxSizePerContainer {
		logs = logs[len(logs)-lr.maxSizePerContainer:]
	}

	lr.logsByContainer[containerName] = logs
}

// GetLogs returns logs for a specific container (required parameter)
func (lr *LogReceiver) GetLogs(containerName string) []LogEntry {
	lr.mu.RLock()
	defer lr.mu.RUnlock()

	if containerName == "" {
		return []LogEntry{}
	}

	logs, exists := lr.logsByContainer[containerName]
	if !exists {
		return []LogEntry{}
	}

	// Return a copy to prevent external modification
	logsCopy := make([]LogEntry, len(logs))
	copy(logsCopy, logs)
	return logsCopy
}

// GetRecentLogs returns the most recent n logs for a specific container
func (lr *LogReceiver) GetRecentLogs(n int, containerName string) []LogEntry {
	lr.mu.RLock()
	defer lr.mu.RUnlock()

	if containerName == "" {
		return []LogEntry{}
	}

	logs, exists := lr.logsByContainer[containerName]
	if !exists {
		return []LogEntry{}
	}

	if n > len(logs) {
		n = len(logs)
	}

	start := len(logs) - n
	logsCopy := make([]LogEntry, n)
	copy(logsCopy, logs[start:])
	return logsCopy
}

// GetLogCount returns the number of logs stored for a specific container
func (lr *LogReceiver) GetLogCount(containerName string) int {
	lr.mu.RLock()
	defer lr.mu.RUnlock()

	if containerName == "" {
		return 0
	}

	logs, exists := lr.logsByContainer[containerName]
	if !exists {
		return 0
	}

	return len(logs)
}

// GetContainerNames returns a list of unique container names in the logs
func (lr *LogReceiver) GetContainerNames() []string {
	lr.mu.RLock()
	defer lr.mu.RUnlock()

	names := make([]string, 0, len(lr.logsByContainer))
	for name := range lr.logsByContainer {
		names = append(names, name)
	}

	return names
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
			entry.ContainerName = sanitizeContainerName(containerNameVal)
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

	log.Printf("Log receiver listening on %s (max %d entries per container)", addr, lr.maxSizePerContainer)

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
