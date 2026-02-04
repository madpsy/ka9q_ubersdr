package main

import (
	"sync"
	"time"
)

// MCPRequestLog stores MCP requests for debugging
type MCPRequestLog struct {
	Timestamp time.Time              `json:"timestamp"`
	Method    string                 `json:"method"`
	Params    map[string]interface{} `json:"params,omitempty"`
	ID        interface{}            `json:"id,omitempty"`
}

// MCPRequestLogger manages a rolling buffer of MCP requests
type MCPRequestLogger struct {
	requests []MCPRequestLog
	mu       sync.RWMutex
	maxSize  int
}

// Global MCP request logger
var globalMCPRequestLogger *MCPRequestLogger

// InitMCPRequestLogger initializes the global MCP request logger
func InitMCPRequestLogger(maxSize int) {
	globalMCPRequestLogger = &MCPRequestLogger{
		requests: make([]MCPRequestLog, 0, maxSize),
		maxSize:  maxSize,
	}
}

// LogRequest adds a request to the log
func (l *MCPRequestLogger) LogRequest(method string, params map[string]interface{}, id interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()

	entry := MCPRequestLog{
		Timestamp: time.Now().UTC(),
		Method:    method,
		Params:    params,
		ID:        id,
	}

	// Add to buffer
	l.requests = append(l.requests, entry)

	// Keep only last maxSize entries
	if len(l.requests) > l.maxSize {
		l.requests = l.requests[len(l.requests)-l.maxSize:]
	}
}

// GetRequests returns all logged requests (newest first)
func (l *MCPRequestLogger) GetRequests() []MCPRequestLog {
	l.mu.RLock()
	defer l.mu.RUnlock()

	// Return a copy in reverse order (newest first)
	result := make([]MCPRequestLog, len(l.requests))
	for i, req := range l.requests {
		result[len(l.requests)-1-i] = req
	}
	return result
}

// GetRequestCount returns the number of logged requests
func (l *MCPRequestLogger) GetRequestCount() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.requests)
}

// Clear removes all logged requests
func (l *MCPRequestLogger) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = make([]MCPRequestLog, 0, l.maxSize)
}
