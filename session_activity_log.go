package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// isValidModeForLogging checks if a mode name is valid (case-insensitive)
// This prevents corrupted or invalid mode names from being logged
func isValidModeForLogging(mode string) bool {
	validModes := map[string]bool{
		"usb":   true,
		"lsb":   true,
		"cwu":   true,
		"cwl":   true,
		"am":    true,
		"fm":    true,
		"sam":   true,
		"nfm":   true,
		"iq":    true,
		"iq48":  true,
		"iq96":  true,
		"iq192": true,
		"iq384": true,
	}
	return validModes[strings.ToLower(mode)]
}

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
	Protocol      string    `json:"protocol,omitempty"`     // "native", "kiwi", "websdr"
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
	// createdUUID names the session a session_created event is about. The legacy
	// snapshot log re-serialised every active session on each event, which is what
	// made the table grow as (events x concurrent sessions); the session tables
	// only need the session that actually changed.
	createdUUID string
	bands       map[string]bool // Optional: bands to log (for session_destroyed events)
	modes       map[string]bool // Optional: modes to log (for session_destroyed events)
	uuid        string          // Optional: UUID for session_destroyed events
}

type SessionActivityLogger struct {
	enabled       bool
	dataDir       string
	logInterval   time.Duration
	retentionDays int // Number of days to retain log files (0 = keep forever)
	sessionMgr    *SessionManager
	mu            sync.Mutex
	stopChan      chan struct{}
	logChan       chan logEvent // Channel for async logging
	wg            sync.WaitGroup

	// SQLite write connection (for INSERTs)
	db *sql.DB

	// history persists sessions as rows updated in place; see session_history.go.
	history *sessionHistoryWriter
}

// SetDB wires the SQLite database into the session activity logger.
func (sal *SessionActivityLogger) SetDB(db *sql.DB) {
	sal.db = db
}

// SetSessionHistory wires the normalised session tables in and closes out any
// sessions left open by a previous process. Call once at startup.
func (sal *SessionActivityLogger) SetSessionHistory(db *sql.DB, geoIP *GeoIPService) {
	if db == nil {
		return
	}
	sal.history = newSessionHistoryWriter(db, geoIP)
	sal.history.sweepOpenSessions()
}

// NewSessionActivityLogger creates a new session activity logger
func NewSessionActivityLogger(enabled bool, dataDir string, logIntervalSecs int, retentionDays int, sessionMgr *SessionManager) *SessionActivityLogger {
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
		enabled:       true,
		dataDir:       dataDir,
		logInterval:   time.Duration(logIntervalSecs) * time.Second,
		retentionDays: retentionDays,
		sessionMgr:    sessionMgr,
		stopChan:      make(chan struct{}),
		logChan:       make(chan logEvent, 100), // Buffered channel for async logging
	}

	// Start async logging goroutine
	logger.wg.Add(1)
	go logger.asyncLogLoop()

	// Start periodic snapshot goroutine
	logger.wg.Add(1)
	go logger.periodicSnapshotLoop()

	log.Printf("Session activity logger started: interval=%v", logger.logInterval)

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
func (sal *SessionActivityLogger) LogSessionCreated(userSessionID string) error {
	if !sal.enabled {
		return nil
	}

	// Send to async channel (non-blocking)
	select {
	case sal.logChan <- logEvent{eventType: "session_created", createdUUID: userSessionID}:
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

// logActivitySync logs the current state of all active sessions to the SQLite database.
func (sal *SessionActivityLogger) logActivitySync(event logEvent) error {
	// Get all active sessions from session manager FIRST (without holding our lock)
	// This prevents deadlock since session manager may call us while holding its lock
	activeSessions := sal.getActiveSessionEntries(event)

	logEntry := SessionActivityLog{
		Timestamp:      time.Now().UTC(),
		EventType:      event.eventType,
		ActiveSessions: activeSessions,
	}

	if sal.history == nil {
		return nil // session tables not configured — nothing to write
	}

	now := logEntry.Timestamp.Unix()

	switch event.eventType {
	case "session_destroyed":
		// The destroy event carries the final bands and modes for the session
		// that ended; nothing else needs touching.
		if event.uuid != "" {
			sal.history.closeSession(event.uuid, event.bands, event.modes, now)
			return nil
		}
		// Older callers did not name the session. Fall back to reconciling
		// against the sessions that are still live.
		sal.reconcileOpenSessions(logEntry.ActiveSessions, now)
		return nil

	case "session_created":
		// Only the session that was just created needs writing. Re-serialising
		// every active session here is what made the legacy table grow as
		// (events x concurrent sessions).
		if event.createdUUID != "" {
			for _, entry := range logEntry.ActiveSessions {
				if entry.UserSessionID == event.createdUUID {
					sal.history.recordActive(entry, now)
					return nil
				}
			}
		}
	}

	// Periodic snapshot: one statement refreshes every open session, then each
	// live session contributes any band or mode it has newly visited. Repeats are
	// no-ops, so this converges without writing history.
	sal.history.touchOpenSessions(now)
	for _, entry := range logEntry.ActiveSessions {
		sal.history.recordActive(entry, now)
	}
	sal.reconcileOpenSessions(logEntry.ActiveSessions, now)

	return nil
}

// reconcileOpenSessions closes any session the database still believes is open
// but which is no longer live. Destroy events normally do this precisely; this
// catches the ones that were dropped when the log channel was full.
func (sal *SessionActivityLogger) reconcileOpenSessions(active []SessionActivityEntry, now int64) {
	if sal.history == nil || sal.db == nil {
		return
	}

	live := make(map[string]bool, len(active))
	for _, entry := range active {
		live[entry.UserSessionID] = true
	}

	rows, err := sal.db.Query(`SELECT user_session_id FROM session WHERE ended_at IS NULL`)
	if err != nil {
		log.Printf("[session history] reconciling open sessions: %v", err)
		return
	}
	var stale []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			break
		}
		if !live[id] {
			stale = append(stale, id)
		}
	}
	rows.Close()

	for _, id := range stale {
		sal.history.closeSession(id, nil, nil, now)
	}
}

// getActiveSessionEntries extracts unique user sessions from the session manager
// For session_destroyed events with data, creates entry from provided data since sessions are already destroyed
func (sal *SessionActivityLogger) getActiveSessionEntries(event logEvent) []SessionActivityEntry {
	// For session_destroyed events, the sessions are already removed from sm.sessions
	// So we need to create the entry from the event data directly
	if event.eventType == "session_destroyed" && event.uuid != "" {
		// Create a single entry for the destroyed session
		entries := make([]SessionActivityEntry, 0, 1)

		// We don't have session data anymore, so create a minimal entry
		// The bands and modes will be populated below
		entry := SessionActivityEntry{
			UserSessionID: event.uuid,
			Bands:         []string{},
			Modes:         []string{},
			Protocol:      protocolFromUserSessionID(event.uuid),
		}

		// Populate bands from event data
		if event.bands != nil {
			for band := range event.bands {
				entry.Bands = append(entry.Bands, band)
			}
		}

		// Populate modes from event data (only valid modes)
		if event.modes != nil {
			for mode := range event.modes {
				// Filter out spectrum mode and invalid modes
				if mode != "spectrum" && isValidModeForLogging(mode) {
					entry.Modes = append(entry.Modes, mode)
				}
			}
		}

		// Sort for consistent output
		sortStrings(entry.Bands)
		sortStrings(entry.Modes)

		entries = append(entries, entry)
		return entries
	}

	// For other event types (snapshot, session_created), read from active sessions
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
				Protocol:      protocolFromUserSessionID(userSessionID),
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

	// Populate bands and modes from UUID-level maps for snapshot/session_created events
	// (session_destroyed events already have their data populated above)
	for userSessionID, entry := range userSessions {
		// Get bands from UUID-level map
		bandMap, bandExists := sal.sessionMgr.userSessionBands[userSessionID]
		if bandExists {
			for band := range bandMap {
				entry.Bands = append(entry.Bands, band)
			}
		}

		// Get modes from UUID-level map (only valid modes)
		modeMap, modeExists := sal.sessionMgr.userSessionModes[userSessionID]
		if modeExists {
			for mode := range modeMap {
				// Filter out spectrum mode and invalid modes
				if mode != "spectrum" && isValidModeForLogging(mode) {
					entry.Modes = append(entry.Modes, mode)
				}
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

// Stop stops the session activity logger
func (sal *SessionActivityLogger) Stop() {
	if !sal.enabled {
		return
	}

	log.Println("Stopping session activity logger...")
	close(sal.stopChan)
	sal.wg.Wait()
	log.Println("Session activity logger stopped")
}

// ReadActivityLogsFromDB reads session activity logs from the SQLite database for a given time range.
// It reconstructs []SessionActivityLog by grouping rows by (snapshot_ts, event_type).
//
// This materialises the whole range. On a busy receiver a multi-week window is
// millions of rows and gigabytes of live objects, so callers that only fold the
// logs into an accumulator should use StreamActivityLogsFromDB instead.
func ReadActivityLogsFromDB(db *sql.DB, startTime, endTime time.Time) ([]SessionActivityLog, error) {
	var logs []SessionActivityLog
	err := StreamActivityLogsFromDB(context.Background(), db, startTime, endTime, func(entry SessionActivityLog) error {
		logs = append(logs, entry)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return logs, nil
}

// StreamActivityLogsFromDB reads the same rows as ReadActivityLogsFromDB but hands
// each reconstructed SessionActivityLog to fn as soon as it is complete, so peak
// memory is one snapshot rather than the whole window. Rows arrive ordered by
// snapshot_ts, so every group for a timestamp is finished once the timestamp
// advances; fn therefore sees entries in the order ReadActivityLogsFromDB returns
// them.
func StreamActivityLogsFromDB(ctx context.Context, db *sql.DB, startTime, endTime time.Time, fn func(SessionActivityLog) error) error {
	if db == nil {
		return fmt.Errorf("session activity database not configured")
	}

	rows, err := db.QueryContext(
		ctx,
		`SELECT snapshot_ts, event_type,
		        user_session_id, client_ip, source_ip, auth_method,
		        session_types, bands, modes,
		        created_at, first_seen, user_agent, country, country_code,
		        COALESCE(protocol, '')
		 FROM sessions
		 WHERE snapshot_ts >= ? AND snapshot_ts <= ?
		 ORDER BY snapshot_ts ASC`,
		startTime.Unix(), endTime.Unix(),
	)
	if err != nil {
		return fmt.Errorf("sessions query error: %w", err)
	}
	defer rows.Close()

	// Groups for the timestamp currently being read, keyed by event_type and kept
	// in first-appearance order so the emitted order matches the batch reader's.
	var (
		currentTS   int64
		haveCurrent bool
		order       = make([]string, 0, 2)
	)
	groups := make(map[string]*SessionActivityLog)

	flush := func() error {
		for _, eventType := range order {
			if err := fn(*groups[eventType]); err != nil {
				return err
			}
		}
		order = order[:0]
		clear(groups)
		return nil
	}

	for rows.Next() {
		var snapshotTS, createdAt, firstSeen int64
		var eventType, userSessionID, clientIP, sourceIP, authMethod string
		var sessionTypesJSON, bandsJSON, modesJSON string
		var userAgent, country, countryCode, protocol string

		if err := rows.Scan(
			&snapshotTS, &eventType,
			&userSessionID, &clientIP, &sourceIP, &authMethod,
			&sessionTypesJSON, &bandsJSON, &modesJSON,
			&createdAt, &firstSeen, &userAgent, &country, &countryCode,
			&protocol,
		); err != nil {
			return fmt.Errorf("sessions scan error: %w", err)
		}

		if !haveCurrent || snapshotTS != currentTS {
			if haveCurrent {
				if err := flush(); err != nil {
					return err
				}
			}
			currentTS, haveCurrent = snapshotTS, true
		}

		if _, exists := groups[eventType]; !exists {
			groups[eventType] = &SessionActivityLog{
				Timestamp:      time.Unix(snapshotTS, 0).UTC(),
				EventType:      eventType,
				ActiveSessions: []SessionActivityEntry{},
			}
			order = append(order, eventType)
		}

		var sessionTypes, bands, modes []string
		_ = json.Unmarshal([]byte(sessionTypesJSON), &sessionTypes)
		_ = json.Unmarshal([]byte(bandsJSON), &bands)
		_ = json.Unmarshal([]byte(modesJSON), &modes)
		if sessionTypes == nil {
			sessionTypes = []string{}
		}
		if bands == nil {
			bands = []string{}
		}
		if modes == nil {
			modes = []string{}
		}

		entry := SessionActivityEntry{
			UserSessionID: userSessionID,
			ClientIP:      clientIP,
			SourceIP:      sourceIP,
			AuthMethod:    authMethod,
			SessionTypes:  sessionTypes,
			Bands:         bands,
			Modes:         modes,
			UserAgent:     userAgent,
			Country:       country,
			CountryCode:   countryCode,
			Protocol:      protocol,
		}
		// Rows written before the protocol column existed have no value stored;
		// fall back to the session-ID prefix so readers always see a protocol.
		if entry.Protocol == "" {
			entry.Protocol = protocolFromUserSessionID(userSessionID)
		}
		if createdAt != 0 {
			entry.CreatedAt = time.Unix(createdAt, 0).UTC()
		}
		if firstSeen != 0 {
			entry.FirstSeen = time.Unix(firstSeen, 0).UTC()
		}

		groups[eventType].ActiveSessions = append(groups[eventType].ActiveSessions, entry)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if haveCurrent {
		return flush()
	}
	return nil
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
