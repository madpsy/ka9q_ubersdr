package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SessionActivityEntry represents a single unique user session in the activity log
type SessionActivityEntry struct {
	UserSessionID string    `json:"user_session_id"`
	ClientIP      string    `json:"client_ip"`
	SourceIP      string    `json:"source_ip"`
	AuthMethod    string    `json:"auth_method"`   // "", "password", "ip_bypass"
	SessionTypes  []string  `json:"session_types"` // ["audio", "spectrum"]
	Bands         []string  `json:"bands"`         // Cumulative list of bands visited (e.g., ["20m", "40m"])
	Modes         []string  `json:"modes"`         // Cumulative list of modes used (e.g., ["usb", "ft8"])
	CreatedAt     time.Time `json:"created_at"`
	FirstSeen     time.Time `json:"first_seen"` // From userSessionFirst map
	UserAgent     string    `json:"user_agent,omitempty"`
	Country       string    `json:"country,omitempty"`      // Country name from GeoIP lookup
	CountryCode   string    `json:"country_code,omitempty"` // ISO country code from GeoIP lookup
}

// SessionActivityLog represents a snapshot of all active sessions at a point in time
type SessionActivityLog struct {
	Timestamp      time.Time              `json:"timestamp"`
	EventType      string                 `json:"event_type"` // "snapshot", "session_created", "session_destroyed"
	ActiveSessions []SessionActivityEntry `json:"active_sessions"`
}

// SessionActivityLogger handles logging of session activity to disk
// logEvent represents a logging event with optional band/mode data
type logEvent struct {
	eventType string
	bands     map[string]bool // Optional: bands to log (for session_destroyed events)
	modes     map[string]bool // Optional: modes to log (for session_destroyed events)
	uuid      string          // Optional: UUID for session_destroyed events
}

type SessionActivityLogger struct {
	enabled     bool
	dataDir     string
	logInterval time.Duration
	sessionMgr  *SessionManager
	mu          sync.Mutex
	currentFile *os.File
	currentDate string
	stopChan    chan struct{}
	logChan     chan logEvent // Channel for async logging
	wg          sync.WaitGroup
}

// NewSessionActivityLogger creates a new session activity logger
func NewSessionActivityLogger(enabled bool, dataDir string, logIntervalSecs int, sessionMgr *SessionManager) *SessionActivityLogger {
	if !enabled {
		return &SessionActivityLogger{enabled: false}
	}

	if dataDir == "" {
		dataDir = "data/session_activity"
	}

	if logIntervalSecs <= 0 {
		logIntervalSecs = 300 // Default 5 minutes
	}

	logger := &SessionActivityLogger{
		enabled:     true,
		dataDir:     dataDir,
		logInterval: time.Duration(logIntervalSecs) * time.Second,
		sessionMgr:  sessionMgr,
		stopChan:    make(chan struct{}),
		logChan:     make(chan logEvent, 100), // Buffered channel for async logging
	}

	// Start async logging goroutine
	logger.wg.Add(1)
	go logger.asyncLogLoop()

	// Start periodic snapshot goroutine
	logger.wg.Add(1)
	go logger.periodicSnapshotLoop()

	log.Printf("Session activity logger started: dir=%s, interval=%v", dataDir, logger.logInterval)

	return logger
}

// asyncLogLoop processes log events asynchronously to avoid deadlocks
func (sal *SessionActivityLogger) asyncLogLoop() {
	defer sal.wg.Done()

	for {
		select {
		case event := <-sal.logChan:
			if err := sal.logActivitySync(event); err != nil {
				log.Printf("Error logging session activity: %v", err)
			}
		case <-sal.stopChan:
			// Drain remaining events before stopping
			for {
				select {
				case event := <-sal.logChan:
					if err := sal.logActivitySync(event); err != nil {
						log.Printf("Error logging session activity during shutdown: %v", err)
					}
				default:
					return
				}
			}
		}
	}
}

// periodicSnapshotLoop periodically logs snapshots of active sessions
func (sal *SessionActivityLogger) periodicSnapshotLoop() {
	defer sal.wg.Done()

	ticker := time.NewTicker(sal.logInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := sal.LogSnapshot(); err != nil {
				log.Printf("Error logging session activity snapshot: %v", err)
			}
		case <-sal.stopChan:
			return
		}
	}
}

// LogSnapshot logs a snapshot of all currently active sessions
func (sal *SessionActivityLogger) LogSnapshot() error {
	if !sal.enabled {
		return nil
	}

	// Send to async channel (non-blocking)
	select {
	case sal.logChan <- logEvent{eventType: "snapshot"}:
	default:
		log.Printf("Warning: session activity log channel full, dropping snapshot event")
	}
	return nil
}

// LogSessionCreated logs when a session is created
func (sal *SessionActivityLogger) LogSessionCreated() error {
	if !sal.enabled {
		return nil
	}

	// Send to async channel (non-blocking)
	select {
	case sal.logChan <- logEvent{eventType: "session_created"}:
	default:
		log.Printf("Warning: session activity log channel full, dropping session_created event")
	}
	return nil
}

// LogSessionDestroyed logs when a session is destroyed
// Deprecated: Use LogSessionDestroyedWithData instead
func (sal *SessionActivityLogger) LogSessionDestroyed() error {
	if !sal.enabled {
		return nil
	}

	// Send to async channel (non-blocking)
	select {
	case sal.logChan <- logEvent{eventType: "session_destroyed"}:
	default:
		log.Printf("Warning: session activity log channel full, dropping session_destroyed event")
	}
	return nil
}

// LogSessionDestroyedWithData logs when a session is destroyed with band/mode data
// This captures the data at the moment of destruction, before cleanup
func (sal *SessionActivityLogger) LogSessionDestroyedWithData(uuid string, bands, modes map[string]bool) error {
	if !sal.enabled {
		return nil
	}

	// Make copies of the maps to avoid race conditions
	bandsCopy := make(map[string]bool, len(bands))
	for k, v := range bands {
		bandsCopy[k] = v
	}
	
	modesCopy := make(map[string]bool, len(modes))
	for k, v := range modes {
		modesCopy[k] = v
	}

	// Send to async channel (non-blocking)
	select {
	case sal.logChan <- logEvent{
		eventType: "session_destroyed",
		uuid:      uuid,
		bands:     bandsCopy,
		modes:     modesCopy,
	}:
	default:
		log.Printf("Warning: session activity log channel full, dropping session_destroyed event")
	}
	return nil
}

// logActivitySync logs the current state of all active sessions (synchronous, called from async loop)
func (sal *SessionActivityLogger) logActivitySync(event logEvent) error {
	// Get all active sessions from session manager FIRST (without holding our lock)
	// This prevents deadlock since session manager may call us while holding its lock
	activeSessions := sal.getActiveSessionEntries(event)

	// Create log entry
	logEntry := SessionActivityLog{
		Timestamp:      time.Now().UTC(),
		EventType:      event.eventType,
		ActiveSessions: activeSessions,
	}

	// Now acquire our lock for file operations
	sal.mu.Lock()
	defer sal.mu.Unlock()

	// Get or create file for today
	file, err := sal.getOrCreateFile()
	if err != nil {
		return fmt.Errorf("failed to get log file: %w", err)
	}

	// Marshal to JSON
	data, err := json.Marshal(logEntry)
	if err != nil {
		return fmt.Errorf("failed to marshal log entry: %w", err)
	}

	// Write JSON line
	if _, err := file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("failed to write log entry: %w", err)
	}

	return nil
}

// getActiveSessionEntries extracts unique user sessions from the session manager
// For session_destroyed events with data, uses the provided bands/modes instead of reading from maps
func (sal *SessionActivityLogger) getActiveSessionEntries(event logEvent) []SessionActivityEntry {
	sal.sessionMgr.mu.RLock()
	defer sal.sessionMgr.mu.RUnlock()

	// Map to aggregate sessions by user_session_id
	userSessions := make(map[string]*SessionActivityEntry)

	for _, session := range sal.sessionMgr.sessions {
		session.mu.RLock()

		// Skip internal sessions (no client IP = internal system sessions)
		if session.ClientIP == "" {
			session.mu.RUnlock()
			continue
		}

		// Skip sessions without user_session_id
		if session.UserSessionID == "" {
			session.mu.RUnlock()
			continue
		}

		userSessionID := session.UserSessionID
		clientIP := session.ClientIP
		sourceIP := session.SourceIP

		// Determine authentication method
		authMethod := ""
		if session.BypassPassword != "" {
			// Session has a password stored, check if it's valid
			if sal.sessionMgr.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) {
				authMethod = "password"
			}
		} else if sal.sessionMgr.config.Server.IsIPTimeoutBypassed(session.ClientIP) {
			// No password, but IP is in bypass list
			authMethod = "ip_bypass"
		}

		// Determine session type
		sessionType := "audio"
		if session.IsSpectrum {
			sessionType = "spectrum"
		}

		createdAt := session.CreatedAt
		country := session.Country
		countryCode := session.CountryCode
		
		session.mu.RUnlock()

		// Get or create entry for this user
		entry, exists := userSessions[userSessionID]
		if !exists {
			// Get first seen time from userSessionFirst map
			firstSeen := time.Now()
			if fs, ok := sal.sessionMgr.userSessionFirst[userSessionID]; ok {
				firstSeen = fs
			}

			// Get user agent
			userAgent := ""
			if ua, ok := sal.sessionMgr.userAgents[userSessionID]; ok {
				userAgent = ua
			}

			entry = &SessionActivityEntry{
				UserSessionID: userSessionID,
				ClientIP:      clientIP,
				SourceIP:      sourceIP,
				AuthMethod:    authMethod,
				SessionTypes:  []string{},
				Bands:         []string{},
				Modes:         []string{},
				CreatedAt:     createdAt,
				FirstSeen:     firstSeen,
				UserAgent:     userAgent,
				Country:       country,
				CountryCode:   countryCode,
			}
			userSessions[userSessionID] = entry
		}

		// Add session type if not already present
		hasType := false
		for _, t := range entry.SessionTypes {
			if t == sessionType {
				hasType = true
				break
			}
		}
		if !hasType {
			entry.SessionTypes = append(entry.SessionTypes, sessionType)
		}

		// Use earliest created time
		if createdAt.Before(entry.CreatedAt) {
			entry.CreatedAt = createdAt
		}
	}
	
	// Now populate bands and modes
	// For session_destroyed events with data, use the provided data
	// For other events, read from UUID-level maps
	if event.eventType == "session_destroyed" && event.uuid != "" && (event.bands != nil || event.modes != nil) {
		// Use provided data for the destroyed session
		log.Printf("ActivityLogger: Using provided data for destroyed UUID %s", event.uuid[:8])
		if entry, exists := userSessions[event.uuid]; exists {
			if event.bands != nil {
				for band := range event.bands {
					entry.Bands = append(entry.Bands, band)
				}
				log.Printf("ActivityLogger: UUID %s has %d bands from provided data: %v",
					event.uuid[:8], len(event.bands), entry.Bands)
			}
			if event.modes != nil {
				for mode := range event.modes {
					entry.Modes = append(entry.Modes, mode)
				}
				log.Printf("ActivityLogger: UUID %s has %d modes from provided data: %v",
					event.uuid[:8], len(event.modes), entry.Modes)
			}
		}
	} else {
		// Read from UUID-level maps for all sessions (snapshot or session_created events)
		log.Printf("ActivityLogger: Reading UUID-level maps for %d users", len(userSessions))
		for userSessionID, entry := range userSessions {
			// Get bands from UUID-level map
			bandMap, bandExists := sal.sessionMgr.userSessionBands[userSessionID]
			if bandExists {
				for band := range bandMap {
					entry.Bands = append(entry.Bands, band)
				}
				log.Printf("ActivityLogger: UUID %s has %d bands from userSessionBands",
					userSessionID[:8], len(bandMap))
			}
			
			// Get modes from UUID-level map
			modeMap, modeExists := sal.sessionMgr.userSessionModes[userSessionID]
			if modeExists {
				for mode := range modeMap {
					entry.Modes = append(entry.Modes, mode)
				}
				log.Printf("ActivityLogger: UUID %s has %d modes from userSessionModes",
					userSessionID[:8], len(modeMap))
			}
		}
	}

	// Convert map to slice and sort bands/modes for consistent output
	entries := make([]SessionActivityEntry, 0, len(userSessions))
	for _, entry := range userSessions {
		// Sort bands and modes alphabetically
		sortStrings(entry.Bands)
		sortStrings(entry.Modes)
		entries = append(entries, *entry)
	}

	return entries
}

// sortStrings sorts a string slice in place
func sortStrings(s []string) {
	// Simple bubble sort for small slices
	n := len(s)
	for i := 0; i < n-1; i++ {
		for j := 0; j < n-i-1; j++ {
			if s[j] > s[j+1] {
				s[j], s[j+1] = s[j+1], s[j]
			}
		}
	}
}

// getOrCreateFile gets or creates the log file for today
func (sal *SessionActivityLogger) getOrCreateFile() (*os.File, error) {
	now := time.Now().UTC()
	dateStr := now.Format("2006-01-02")

	// Check if we need to rotate to a new file
	if sal.currentFile != nil && sal.currentDate == dateStr {
		return sal.currentFile, nil
	}

	// Close old file if open
	if sal.currentFile != nil {
		sal.currentFile.Close()
		sal.currentFile = nil
	}

	// Create directory structure: data_dir/YYYY/MM/DD/
	year := now.Format("2006")
	month := now.Format("01")
	day := now.Format("02")
	dirPath := filepath.Join(sal.dataDir, year, month, day)

	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory %s: %w", dirPath, err)
	}

	// Create file: data_dir/YYYY/MM/DD/sessions.jsonl
	filename := filepath.Join(dirPath, "sessions.jsonl")

	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to open file %s: %w", filename, err)
	}

	sal.currentFile = file
	sal.currentDate = dateStr

	return file, nil
}

// Stop stops the session activity logger
func (sal *SessionActivityLogger) Stop() {
	if !sal.enabled {
		return
	}

	log.Println("Stopping session activity logger...")

	// Signal stop
	close(sal.stopChan)

	// Wait for goroutine to finish
	sal.wg.Wait()

	// Close current file
	sal.mu.Lock()
	if sal.currentFile != nil {
		sal.currentFile.Close()
		sal.currentFile = nil
	}
	sal.mu.Unlock()

	log.Println("Session activity logger stopped")
}

// ReadActivityLogs reads session activity logs for a given time range
// Returns all log entries within the specified time range
func ReadActivityLogs(dataDir string, startTime, endTime time.Time) ([]SessionActivityLog, error) {
	var logs []SessionActivityLog

	// Iterate through each day in the range
	currentDate := startTime.UTC()
	endDate := endTime.UTC()

	for !currentDate.After(endDate) {
		// Build directory path for this day
		year := currentDate.Format("2006")
		month := currentDate.Format("01")
		day := currentDate.Format("02")
		dirPath := filepath.Join(dataDir, year, month, day)

		// Check if directory exists
		if _, err := os.Stat(dirPath); os.IsNotExist(err) {
			// No data for this day, skip
			currentDate = currentDate.AddDate(0, 0, 1)
			continue
		}

		// Read the sessions.jsonl file
		filename := filepath.Join(dirPath, "sessions.jsonl")
		file, err := os.Open(filename)
		if err != nil {
			if os.IsNotExist(err) {
				// File doesn't exist for this day, skip
				currentDate = currentDate.AddDate(0, 0, 1)
				continue
			}
			return nil, fmt.Errorf("failed to open file %s: %w", filename, err)
		}

		// Read line by line using bufio.Scanner to properly handle corrupted data
		scanner := bufio.NewScanner(file)
		lineNum := 0
		corruptedLines := 0
		for scanner.Scan() {
			lineNum++
			line := scanner.Bytes()

			// Skip empty lines
			if len(line) == 0 {
				continue
			}

			// Skip lines with null bytes (corrupted data)
			if bytes.Contains(line, []byte{0}) {
				corruptedLines++
				continue
			}

			var entry SessionActivityLog
			if err := json.Unmarshal(line, &entry); err != nil {
				corruptedLines++
				continue
			}

			// Filter by time range
			if (entry.Timestamp.Equal(startTime) || entry.Timestamp.After(startTime)) &&
				(entry.Timestamp.Equal(endTime) || entry.Timestamp.Before(endTime)) {
				logs = append(logs, entry)
			}
		}

		// Log summary only if there were corrupted lines (not per-line to avoid log spam)
		if corruptedLines > 0 {
			log.Printf("Warning: skipped %d corrupted lines in %s", corruptedLines, filename)
		}

		if err := scanner.Err(); err != nil {
			file.Close()
			return nil, fmt.Errorf("error reading file %s: %w", filename, err)
		}

		file.Close()

		// Move to next day
		currentDate = currentDate.AddDate(0, 0, 1)
	}

	return logs, nil
}

// FilterSessionsByAuthMethod filters session entries by authentication method
func FilterSessionsByAuthMethod(logs []SessionActivityLog, authMethods []string) []SessionActivityLog {
	if len(authMethods) == 0 {
		return logs // No filter, return all
	}

	// Create a map for quick lookup
	methodMap := make(map[string]bool)
	for _, method := range authMethods {
		methodMap[method] = true
	}

	// Filter logs
	filtered := make([]SessionActivityLog, 0, len(logs))
	for _, log := range logs {
		// Filter active sessions within this log entry
		filteredSessions := make([]SessionActivityEntry, 0, len(log.ActiveSessions))
		for _, session := range log.ActiveSessions {
			// Map auth_method to filter names
			filterName := "regular"
			if session.AuthMethod == "password" {
				filterName = "password"
			} else if session.AuthMethod == "ip_bypass" {
				filterName = "bypassed"
			}

			if methodMap[filterName] {
				filteredSessions = append(filteredSessions, session)
			}
		}

		// Only include log entry if it has sessions after filtering
		if len(filteredSessions) > 0 {
			logCopy := log
			logCopy.ActiveSessions = filteredSessions
			filtered = append(filtered, logCopy)
		}
	}

	return filtered
}
