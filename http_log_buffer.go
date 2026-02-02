package main

import (
	"sync"
	"time"
)

// HTTPLogEntry represents a single HTTP request log entry
type HTTPLogEntry struct {
	Timestamp  time.Time `json:"timestamp"`
	ClientIP   string    `json:"client_ip"`
	Method     string    `json:"method"`
	URI        string    `json:"uri"`
	Protocol   string    `json:"protocol"`
	StatusCode int       `json:"status_code"`
	BytesWritten int64   `json:"bytes_written"`
	DurationMs float64   `json:"duration_ms"`
	UserAgent  string    `json:"user_agent"`
	Referer    string    `json:"referer"`
}

// HTTPLogBuffer manages in-memory HTTP request logs with a rolling window
type HTTPLogBuffer struct {
	mu      sync.RWMutex
	logs    []HTTPLogEntry
	maxSize int
}

// NewHTTPLogBuffer creates a new HTTP log buffer with specified max size
func NewHTTPLogBuffer(maxSize int) *HTTPLogBuffer {
	return &HTTPLogBuffer{
		logs:    make([]HTTPLogEntry, 0, maxSize),
		maxSize: maxSize,
	}
}

// AddLog adds a log entry to the rolling window
func (hlb *HTTPLogBuffer) AddLog(entry HTTPLogEntry) {
	hlb.mu.Lock()
	defer hlb.mu.Unlock()

	// Add the new entry
	hlb.logs = append(hlb.logs, entry)

	// If we exceed max size, remove oldest entries
	if len(hlb.logs) > hlb.maxSize {
		hlb.logs = hlb.logs[len(hlb.logs)-hlb.maxSize:]
	}
}

// GetLogs returns all logs (up to maxSize)
func (hlb *HTTPLogBuffer) GetLogs() []HTTPLogEntry {
	hlb.mu.RLock()
	defer hlb.mu.RUnlock()

	// Return a copy to prevent external modification
	logsCopy := make([]HTTPLogEntry, len(hlb.logs))
	copy(logsCopy, hlb.logs)
	return logsCopy
}

// GetRecentLogs returns the most recent n logs
func (hlb *HTTPLogBuffer) GetRecentLogs(n int) []HTTPLogEntry {
	hlb.mu.RLock()
	defer hlb.mu.RUnlock()

	if n > len(hlb.logs) {
		n = len(hlb.logs)
	}

	start := len(hlb.logs) - n
	logsCopy := make([]HTTPLogEntry, n)
	copy(logsCopy, hlb.logs[start:])
	return logsCopy
}

// GetLogCount returns the number of logs stored
func (hlb *HTTPLogBuffer) GetLogCount() int {
	hlb.mu.RLock()
	defer hlb.mu.RUnlock()
	return len(hlb.logs)
}

// GetMaxSize returns the maximum buffer size
func (hlb *HTTPLogBuffer) GetMaxSize() int {
	return hlb.maxSize
}

// Global HTTP log buffer instance
var globalHTTPLogBuffer *HTTPLogBuffer

// InitHTTPLogBuffer initializes the global HTTP log buffer
func InitHTTPLogBuffer(maxSize int) {
	globalHTTPLogBuffer = NewHTTPLogBuffer(maxSize)
}

// GetHTTPLogBuffer returns the global HTTP log buffer instance
func GetHTTPLogBuffer() *HTTPLogBuffer {
	return globalHTTPLogBuffer
}
