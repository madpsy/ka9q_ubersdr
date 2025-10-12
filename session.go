package main

import (
	"fmt"
	"log"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Session represents a user session with an associated radiod channel
type Session struct {
	ID            string
	ChannelName   string
	SSRC          uint32 // Unique SSRC for this session's radiod channel
	Frequency     uint64
	Mode          string
	Bandwidth     int // Bandwidth in Hz (for USB/LSB modes) - DEPRECATED, use BandwidthLow/High
	BandwidthLow  int // Low edge of filter in Hz (can be negative)
	BandwidthHigh int // High edge of filter in Hz
	SampleRate    int
	CreatedAt     time.Time
	LastActive    time.Time
	AudioChan     chan []byte
	Done          chan struct{}
	mu            sync.RWMutex

	// Connection info
	SourceIP      string // Direct connection IP (RemoteAddr)
	ClientIP      string // True client IP (from X-Forwarded-For if present)
	UserSessionID string // Client-generated UUID to link audio and spectrum sessions
	UserAgent     string // User-Agent string from the client

	// WebSocket connection (for closing when kicked)
	WSConn interface{} // *wsConn, stored as interface{} to avoid import cycle

	// Spectrum-specific fields (only used when Mode == "spectrum")
	IsSpectrum   bool
	BinCount     int
	BinBandwidth float64
	SpectrumChan chan []float32 // Channel for spectrum data
}

// SessionManager manages all active sessions
type SessionManager struct {
	sessions             map[string]*Session
	ssrcToSession        map[uint32]*Session        // Map SSRC to session for audio routing
	kickedUUIDs          map[string]time.Time       // Map of kicked user_session_ids with expiry time
	userSessionFirst     map[string]time.Time       // Map of user_session_id to first seen time
	userSessionUUIDs     map[string]int             // Map of user_session_id to count of sessions (for limiting unique users)
	ipToUUIDs            map[string]map[string]bool // Map of IP address to set of UUIDs (for limiting unique UUIDs per IP)
	userAgents           map[string]string          // Map of user_session_id to User-Agent string
	uuidAudioSessions    map[string]string          // Map of user_session_id to audio session ID (enforces 1 audio per UUID)
	uuidSpectrumSessions map[string]string          // Map of user_session_id to spectrum session ID (enforces 1 spectrum per UUID)
	mu                   sync.RWMutex
	config               *Config
	radiod               *RadiodController
	maxSessions          int
	timeout              time.Duration
	maxSessionTime       time.Duration // Maximum time a session can exist (0 = unlimited)
	kickedUUIDTTL        time.Duration // How long to remember kicked UUIDs (default 1 hour)
}

// NewSessionManager creates a new session manager
func NewSessionManager(config *Config, radiod *RadiodController) *SessionManager {
	sm := &SessionManager{
		sessions:             make(map[string]*Session),
		ssrcToSession:        make(map[uint32]*Session),
		kickedUUIDs:          make(map[string]time.Time),
		userSessionFirst:     make(map[string]time.Time),
		userSessionUUIDs:     make(map[string]int),
		ipToUUIDs:            make(map[string]map[string]bool),
		userAgents:           make(map[string]string),
		uuidAudioSessions:    make(map[string]string),
		uuidSpectrumSessions: make(map[string]string),
		config:               config,
		radiod:               radiod,
		maxSessions:          config.Server.MaxSessions,
		timeout:              time.Duration(config.Server.SessionTimeout) * time.Second,
		maxSessionTime:       time.Duration(config.Server.MaxSessionTime) * time.Second,
		kickedUUIDTTL:        1 * time.Hour, // Remember kicked UUIDs for 1 hour
	}

	// Start cleanup goroutine
	go sm.cleanupLoop()

	// Start max session time enforcement goroutine if configured
	if sm.maxSessionTime > 0 {
		go sm.maxSessionTimeLoop()
	}

	return sm
}

// translateModeForRadiod translates UI mode names to radiod preset names
// This allows the UI to show user-friendly names while sending correct presets to radiod
func translateModeForRadiod(mode string) string {
	// FM in the UI should request "pm" (phase modulation) preset from radiod
	if mode == "fm" {
		return "pm"
	}
	// All other modes pass through unchanged
	return mode
}

// CreateSession creates a new session with a unique channel (default bandwidth)
func (sm *SessionManager) CreateSession(frequency uint64, mode string) (*Session, error) {
	return sm.CreateSessionWithBandwidth(frequency, mode, 3000, "", "", "") // Default 3000 Hz bandwidth
}

// CreateSessionWithIP creates a new session with IP tracking
func (sm *SessionManager) CreateSessionWithIP(frequency uint64, mode string, sourceIP, clientIP string) (*Session, error) {
	return sm.CreateSessionWithBandwidth(frequency, mode, 3000, sourceIP, clientIP, "")
}

// CreateSessionWithUserID creates a new session with IP tracking and user session ID
func (sm *SessionManager) CreateSessionWithUserID(frequency uint64, mode string, sourceIP, clientIP, userSessionID string) (*Session, error) {
	return sm.CreateSessionWithBandwidth(frequency, mode, 3000, sourceIP, clientIP, userSessionID)
}

// CreateSessionWithBandwidth creates a new session with a unique channel and specified bandwidth
func (sm *SessionManager) CreateSessionWithBandwidth(frequency uint64, mode string, bandwidth int, sourceIP, clientIP, userSessionID string) (*Session, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Track first time we see this user_session_id
	if userSessionID != "" {
		if _, exists := sm.userSessionFirst[userSessionID]; !exists {
			sm.userSessionFirst[userSessionID] = time.Now()
		}
	}

	// Check session limit based on unique user_session_ids
	// If userSessionID is empty, treat as a unique user for each session
	if userSessionID == "" {
		// No UUID provided - count as unique user per session (legacy behavior)
		if len(sm.sessions) >= sm.maxSessions {
			return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
		}
	} else {
		// UUID provided - check if this is a new unique user
		if _, exists := sm.userSessionUUIDs[userSessionID]; !exists {
			// New unique user - check if we've reached the limit
			if len(sm.userSessionUUIDs) >= sm.maxSessions {
				return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
			}
		}
		// Existing user can create additional sessions (audio + spectrum)
	}

	// Check if we've reached the maximum unique UUIDs per IP (if configured)
	if sm.config.Server.MaxSessionsIP > 0 && clientIP != "" && userSessionID != "" {
		// Check if this is a new UUID for this IP
		if uuidSet, exists := sm.ipToUUIDs[clientIP]; exists {
			// IP exists, check if UUID is new
			if !uuidSet[userSessionID] {
				// New UUID for this IP, check limit
				if len(uuidSet) >= sm.config.Server.MaxSessionsIP {
					return nil, fmt.Errorf("maximum unique users per IP reached (%d)", sm.config.Server.MaxSessionsIP)
				}
			}
		}
		// If IP doesn't exist yet or UUID already exists for this IP, allow it
	}

	// Check if this UUID already has an audio session (enforce 1 audio per UUID)
	if userSessionID != "" {
		if existingSessionID, exists := sm.uuidAudioSessions[userSessionID]; exists {
			return nil, fmt.Errorf("user already has an active audio session (session: %s)", existingSessionID)
		}
	}

	// Generate unique session ID and channel name
	sessionID := uuid.New().String()
	channelName := fmt.Sprintf("ubersdr-%s", sessionID[:8])

	// Generate random SSRC for this session
	// Each user gets their own radiod channel with unique SSRC
	// This allows multiple users to listen to the same frequency independently
	ssrc := uint32(rand.Int31())
	if ssrc == 0 || ssrc == 0xffffffff {
		ssrc = 1 // Avoid reserved values
	}

	// Ensure SSRC is unique (collision is rare but possible with random generation)
	attempts := 0
	for {
		if _, exists := sm.ssrcToSession[ssrc]; !exists {
			break // Found unique SSRC
		}
		// Collision detected, try another random value
		ssrc = uint32(rand.Int31())
		if ssrc == 0 || ssrc == 0xffffffff {
			ssrc = 1
		}
		attempts++
		if attempts > 100 {
			return nil, fmt.Errorf("failed to generate unique SSRC after %d attempts", attempts)
		}
	}

	// Get sample rate for mode
	sampleRate := sm.config.Audio.GetSampleRateForMode(mode)

	// Create session with default bandwidth edges (50 Hz to bandwidth Hz for SSB)
	session := &Session{
		ID:            sessionID,
		ChannelName:   channelName,
		SSRC:          ssrc,
		Frequency:     frequency,
		Mode:          mode,
		Bandwidth:     bandwidth,
		BandwidthLow:  50,        // Default low edge
		BandwidthHigh: bandwidth, // Default high edge
		SampleRate:    sampleRate,
		CreatedAt:     time.Now(),
		LastActive:    time.Now(),
		AudioChan:     make(chan []byte, 100), // Buffer 100 audio packets
		Done:          make(chan struct{}),
		SourceIP:      sourceIP,
		ClientIP:      clientIP,
		UserSessionID: userSessionID,
	}

	// Translate mode for radiod (e.g., "fm" -> "pm")
	radiodMode := translateModeForRadiod(mode)

	// Create radiod channel with unique random SSRC and bandwidth
	if err := sm.radiod.CreateChannelWithBandwidth(channelName, frequency, radiodMode, sampleRate, ssrc, bandwidth); err != nil {
		return nil, fmt.Errorf("failed to create radiod channel: %w", err)
	}

	sm.sessions[sessionID] = session
	sm.ssrcToSession[ssrc] = session

	// Track user_session_id count
	if userSessionID != "" {
		sm.userSessionUUIDs[userSessionID]++
		// Track audio session for this UUID
		sm.uuidAudioSessions[userSessionID] = sessionID
	}

	// Track IP to UUID mapping
	if clientIP != "" && userSessionID != "" {
		if sm.ipToUUIDs[clientIP] == nil {
			sm.ipToUUIDs[clientIP] = make(map[string]bool)
		}
		sm.ipToUUIDs[clientIP][userSessionID] = true
	}

	if DebugMode {
		log.Printf("DEBUG: Session registered in ssrcToSession map: SSRC 0x%08x -> Session %s", ssrc, sessionID)
		log.Printf("DEBUG: Total sessions: %d, Total SSRC mappings: %d, Unique users: %d",
			len(sm.sessions), len(sm.ssrcToSession), len(sm.userSessionUUIDs))
	}

	log.Printf("Session created: %s (channel: %s, SSRC: 0x%08x, freq: %d Hz, mode: %s, bandwidth: %d Hz, user: %s)",
		sessionID, channelName, ssrc, frequency, mode, bandwidth, userSessionID)

	return session, nil
}

// CreateSpectrumSession creates a new spectrum session with default parameters
// Users can only adjust frequency (pan) and bin_bw (zoom), bin_count is fixed
func (sm *SessionManager) CreateSpectrumSession() (*Session, error) {
	return sm.CreateSpectrumSessionWithIP("", "")
}

// CreateSpectrumSessionWithIP creates a new spectrum session with IP tracking
func (sm *SessionManager) CreateSpectrumSessionWithIP(sourceIP, clientIP string) (*Session, error) {
	return sm.createSpectrumSessionWithUserID(sourceIP, clientIP, "")
}

// CreateSpectrumSessionWithUserID creates a new spectrum session with IP tracking and user session ID
func (sm *SessionManager) CreateSpectrumSessionWithUserID(sourceIP, clientIP, userSessionID string) (*Session, error) {
	return sm.createSpectrumSessionWithUserID(sourceIP, clientIP, userSessionID)
}

// createSpectrumSessionWithUserID is the internal implementation
func (sm *SessionManager) createSpectrumSessionWithUserID(sourceIP, clientIP, userSessionID string) (*Session, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Track first time we see this user_session_id
	if userSessionID != "" {
		if _, exists := sm.userSessionFirst[userSessionID]; !exists {
			sm.userSessionFirst[userSessionID] = time.Now()
		}
	}

	// Check session limit based on unique user_session_ids
	// If userSessionID is empty, treat as a unique user for each session
	if userSessionID == "" {
		// No UUID provided - count as unique user per session (legacy behavior)
		if len(sm.sessions) >= sm.maxSessions {
			return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
		}
	} else {
		// UUID provided - check if this is a new unique user
		if _, exists := sm.userSessionUUIDs[userSessionID]; !exists {
			// New unique user - check if we've reached the limit
			if len(sm.userSessionUUIDs) >= sm.maxSessions {
				return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
			}
		}
		// Existing user can create additional sessions (audio + spectrum)
	}

	// Check if we've reached the maximum unique UUIDs per IP (if configured)
	if sm.config.Server.MaxSessionsIP > 0 && clientIP != "" && userSessionID != "" {
		// Check if this is a new UUID for this IP
		if uuidSet, exists := sm.ipToUUIDs[clientIP]; exists {
			// IP exists, check if UUID is new
			if !uuidSet[userSessionID] {
				// New UUID for this IP, check limit
				if len(uuidSet) >= sm.config.Server.MaxSessionsIP {
					return nil, fmt.Errorf("maximum unique users per IP reached (%d)", sm.config.Server.MaxSessionsIP)
				}
			}
		}
		// If IP doesn't exist yet or UUID already exists for this IP, allow it
	}

	// Check if this UUID already has a spectrum session (enforce 1 spectrum per UUID)
	if userSessionID != "" {
		if existingSessionID, exists := sm.uuidSpectrumSessions[userSessionID]; exists {
			return nil, fmt.Errorf("user already has an active spectrum session (session: %s)", existingSessionID)
		}
	}

	// Generate unique session ID and channel name
	sessionID := uuid.New().String()
	channelName := fmt.Sprintf("spectrum-%s", sessionID[:8])

	// Generate random SSRC for this spectrum session
	ssrc := uint32(rand.Int31())
	if ssrc == 0 || ssrc == 0xffffffff {
		ssrc = 1 // Avoid reserved values
	}

	// Ensure SSRC is unique
	attempts := 0
	for {
		if _, exists := sm.ssrcToSession[ssrc]; !exists {
			break
		}
		ssrc = uint32(rand.Int31())
		if ssrc == 0 || ssrc == 0xffffffff {
			ssrc = 1
		}
		attempts++
		if attempts > 100 {
			return nil, fmt.Errorf("failed to generate unique SSRC after %d attempts", attempts)
		}
	}

	// Use default parameters from config
	frequency := sm.config.Spectrum.Default.CenterFrequency
	binCount := sm.config.Spectrum.Default.BinCount
	binBandwidth := sm.config.Spectrum.Default.BinBandwidth

	// Create spectrum session
	session := &Session{
		ID:            sessionID,
		ChannelName:   channelName,
		SSRC:          ssrc,
		Frequency:     frequency,
		Mode:          "spectrum",
		IsSpectrum:    true,
		BinCount:      binCount,
		BinBandwidth:  binBandwidth,
		CreatedAt:     time.Now(),
		LastActive:    time.Now(),
		SpectrumChan:  make(chan []float32, 10), // Buffer spectrum updates
		Done:          make(chan struct{}),
		SourceIP:      sourceIP,
		ClientIP:      clientIP,
		UserSessionID: userSessionID,
	}

	// Create radiod spectrum channel
	if err := sm.radiod.CreateSpectrumChannel(channelName, frequency, binCount, binBandwidth, ssrc); err != nil {
		return nil, fmt.Errorf("failed to create radiod spectrum channel: %w", err)
	}

	sm.sessions[sessionID] = session
	sm.ssrcToSession[ssrc] = session

	// Track user_session_id count
	if userSessionID != "" {
		sm.userSessionUUIDs[userSessionID]++
		// Track spectrum session for this UUID
		sm.uuidSpectrumSessions[userSessionID] = sessionID
	}

	// Track IP to UUID mapping
	if clientIP != "" && userSessionID != "" {
		if sm.ipToUUIDs[clientIP] == nil {
			sm.ipToUUIDs[clientIP] = make(map[string]bool)
		}
		sm.ipToUUIDs[clientIP][userSessionID] = true
	}

	log.Printf("Spectrum session created: %s (SSRC: 0x%08x, freq: %d Hz, bins: %d, bw: %.1f Hz, user: %s)",
		sessionID, ssrc, frequency, binCount, binBandwidth, userSessionID)

	return session, nil
}

// UpdateSpectrumSession updates spectrum parameters (for zoom/pan)
// Supports dynamic bin_count adjustment for deep zoom levels beyond 256x
func (sm *SessionManager) UpdateSpectrumSession(sessionID string, frequency uint64, binBandwidth float64, binCount int) error {
	session, ok := sm.GetSession(sessionID)
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	if !session.IsSpectrum {
		return fmt.Errorf("session %s is not a spectrum session", sessionID)
	}

	// Track if bin_count changed
	binCountChanged := false

	// Update session state
	session.mu.Lock()
	oldBinCount := session.BinCount

	if frequency > 0 {
		session.Frequency = frequency
	}
	if binBandwidth > 0 {
		session.BinBandwidth = binBandwidth
	}
	if binCount > 0 && binCount != session.BinCount {
		session.BinCount = binCount
		binCountChanged = true
	}
	session.LastActive = time.Now()
	session.mu.Unlock()

	// Send update command to radiod
	// The radiod controller will calculate appropriate filter edges based on the new bandwidth
	if err := sm.radiod.UpdateSpectrumChannel(session.SSRC, frequency, binBandwidth, session.BinCount, binCountChanged); err != nil {
		return fmt.Errorf("failed to update radiod spectrum channel: %w", err)
	}

	totalBandwidth := float64(session.BinCount) * binBandwidth
	if binCountChanged {
		log.Printf("Spectrum session updated: %s (center: %d Hz, bins: %d->%d, bw: %.1f Hz/bin, total: %.1f MHz)",
			sessionID, frequency, oldBinCount, session.BinCount, binBandwidth, totalBandwidth/1e6)
	} else {
		log.Printf("Spectrum session updated: %s (center: %d Hz, bw: %.1f Hz/bin, total: %.1f MHz)",
			sessionID, frequency, binBandwidth, totalBandwidth/1e6)
	}
	return nil
}

// UpdateSession updates an existing session's frequency, mode, and/or bandwidth
// This reuses the existing channel instead of destroying and recreating it
// Parameters with value 0 (for numbers) or "" (for strings) mean "don't change"
func (sm *SessionManager) UpdateSession(sessionID string, frequency uint64, mode string, bandwidth int) error {
	session, ok := sm.GetSession(sessionID)
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	if session.IsSpectrum {
		return fmt.Errorf("cannot update spectrum session with UpdateSession, use UpdateSpectrumSession instead")
	}

	// Update session state only for parameters that changed
	session.mu.Lock()
	oldFreq := session.Frequency
	oldMode := session.Mode
	oldBandwidth := session.Bandwidth

	if frequency > 0 {
		session.Frequency = frequency
	}
	if mode != "" {
		session.Mode = mode
	}
	if bandwidth > 0 {
		session.Bandwidth = bandwidth
	}
	session.LastActive = time.Now()

	// Get the actual values to send (use current if not changing)
	sendFreq := frequency
	if sendFreq == 0 {
		sendFreq = session.Frequency
	}
	sendMode := mode
	if sendMode != "" {
		// Translate mode for radiod (e.g., "fm" -> "pm")
		sendMode = translateModeForRadiod(sendMode)
	}
	sendBandwidth := bandwidth
	if sendBandwidth == 0 {
		sendBandwidth = session.Bandwidth
	}
	session.mu.Unlock()

	// Send update command to radiod with existing SSRC
	// Convert single bandwidth to low/high edges (50 Hz to bandwidth Hz for SSB)
	sendBandwidthFlag := sendBandwidth > 0
	if err := sm.radiod.UpdateChannel(session.SSRC, sendFreq, sendMode, 50, sendBandwidth, sendBandwidthFlag); err != nil {
		// Rollback on error
		session.mu.Lock()
		session.Frequency = oldFreq
		session.Mode = oldMode
		session.Bandwidth = oldBandwidth
		session.mu.Unlock()
		return fmt.Errorf("failed to update radiod channel: %w", err)
	}

	// Log what actually changed
	changes := []string{}
	if frequency > 0 && frequency != oldFreq {
		changes = append(changes, fmt.Sprintf("freq: %d -> %d Hz", oldFreq, frequency))
	}
	if mode != "" && mode != oldMode {
		changes = append(changes, fmt.Sprintf("mode: %s -> %s", oldMode, mode))
	}
	if bandwidth > 0 && bandwidth != oldBandwidth {
		changes = append(changes, fmt.Sprintf("bw: %d -> %d Hz", oldBandwidth, bandwidth))
	}

	if len(changes) > 0 {
		log.Printf("Session updated: %s (SSRC: 0x%08x) - %s", sessionID, session.SSRC, strings.Join(changes, ", "))
	}
	return nil
}

// UpdateSessionWithEdges updates an existing session's frequency, mode, and/or bandwidth edges
// This reuses the existing channel instead of destroying and recreating it
// Parameters with value 0 (for numbers) or "" (for strings) mean "don't change"
// sendBandwidth controls whether to send bandwidth parameters to radiod
func (sm *SessionManager) UpdateSessionWithEdges(sessionID string, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool) error {
	session, ok := sm.GetSession(sessionID)
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	if session.IsSpectrum {
		return fmt.Errorf("cannot update spectrum session with UpdateSessionWithEdges, use UpdateSpectrumSession instead")
	}

	// Update session state only for parameters that changed
	session.mu.Lock()
	oldFreq := session.Frequency
	oldMode := session.Mode
	oldBandwidthLow := session.BandwidthLow
	oldBandwidthHigh := session.BandwidthHigh

	if frequency > 0 {
		session.Frequency = frequency
	}
	if mode != "" {
		session.Mode = mode
	}
	if sendBandwidth {
		session.BandwidthLow = bandwidthLow
		session.BandwidthHigh = bandwidthHigh
	}
	session.LastActive = time.Now()

	// Get the actual values to send (use current if not changing)
	sendFreq := frequency
	if sendFreq == 0 {
		sendFreq = session.Frequency
	}
	sendMode := mode
	if sendMode != "" {
		// Translate mode for radiod (e.g., "fm" -> "pm")
		sendMode = translateModeForRadiod(sendMode)
	}
	session.mu.Unlock()

	// Send update command to radiod with existing SSRC
	// radiod.UpdateChannel will handle the bandwidth edges
	if err := sm.radiod.UpdateChannel(session.SSRC, sendFreq, sendMode, bandwidthLow, bandwidthHigh, sendBandwidth); err != nil {
		// Rollback on error
		session.mu.Lock()
		session.Frequency = oldFreq
		session.Mode = oldMode
		session.BandwidthLow = oldBandwidthLow
		session.BandwidthHigh = oldBandwidthHigh
		session.mu.Unlock()
		return fmt.Errorf("failed to update radiod channel: %w", err)
	}

	// Log what actually changed
	changes := []string{}
	if frequency > 0 && frequency != oldFreq {
		changes = append(changes, fmt.Sprintf("freq: %d -> %d Hz", oldFreq, frequency))
	}
	if mode != "" && mode != oldMode {
		changes = append(changes, fmt.Sprintf("mode: %s -> %s", oldMode, mode))
	}
	if sendBandwidth && (bandwidthLow != oldBandwidthLow || bandwidthHigh != oldBandwidthHigh) {
		changes = append(changes, fmt.Sprintf("bw: %d-%d -> %d-%d Hz", oldBandwidthLow, oldBandwidthHigh, bandwidthLow, bandwidthHigh))
	}

	if len(changes) > 0 {
		log.Printf("Session updated: %s (SSRC: 0x%08x) - %s", sessionID, session.SSRC, strings.Join(changes, ", "))
	}
	return nil
}

// GetSession retrieves a session by ID
func (sm *SessionManager) GetSession(sessionID string) (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	session, ok := sm.sessions[sessionID]
	return session, ok
}

// TouchSession updates the last active time for a session
func (sm *SessionManager) TouchSession(sessionID string) {
	if session, ok := sm.GetSession(sessionID); ok {
		session.mu.Lock()
		session.LastActive = time.Now()
		session.mu.Unlock()
	}
}

// DestroySession removes a session and cleans up its resources
func (sm *SessionManager) DestroySession(sessionID string) error {
	sm.mu.Lock()
	session, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return fmt.Errorf("session not found: %s", sessionID)
	}
	delete(sm.sessions, sessionID)
	delete(sm.ssrcToSession, session.SSRC)

	// Decrement user_session_id count and remove if zero
	if session.UserSessionID != "" {
		if count, exists := sm.userSessionUUIDs[session.UserSessionID]; exists {
			if count <= 1 {
				delete(sm.userSessionUUIDs, session.UserSessionID)
			} else {
				sm.userSessionUUIDs[session.UserSessionID]--
			}
		}

		// Remove from audio/spectrum session tracking
		if session.IsSpectrum {
			if sm.uuidSpectrumSessions[session.UserSessionID] == sessionID {
				delete(sm.uuidSpectrumSessions, session.UserSessionID)
			}
		} else {
			if sm.uuidAudioSessions[session.UserSessionID] == sessionID {
				delete(sm.uuidAudioSessions, session.UserSessionID)
			}
		}
	}

	// Clean up IP to UUID mapping if this was the last session for this UUID from this IP
	if session.ClientIP != "" && session.UserSessionID != "" {
		// Check if there are any other sessions with this UUID from this IP
		hasOtherSessions := false
		for _, s := range sm.sessions {
			if s.ClientIP == session.ClientIP && s.UserSessionID == session.UserSessionID && s.ID != sessionID {
				hasOtherSessions = true
				break
			}
		}

		// If no other sessions with this UUID from this IP, remove the UUID from the IP's set
		if !hasOtherSessions {
			if uuidSet, exists := sm.ipToUUIDs[session.ClientIP]; exists {
				delete(uuidSet, session.UserSessionID)
				// If this was the last UUID for this IP, remove the IP entry
				if len(uuidSet) == 0 {
					delete(sm.ipToUUIDs, session.ClientIP)
				}
			}
		}
	}

	if DebugMode {
		log.Printf("DEBUG: Session removed from ssrcToSession map: SSRC 0x%08x", session.SSRC)
		log.Printf("DEBUG: Remaining sessions: %d, Remaining SSRC mappings: %d, Unique users: %d",
			len(sm.sessions), len(sm.ssrcToSession), len(sm.userSessionUUIDs))
	}
	sm.mu.Unlock()

	// Close WebSocket connection if present (forces immediate disconnect)
	if session.WSConn != nil {
		if wsConn, ok := session.WSConn.(interface{ close() error }); ok {
			log.Printf("DEBUG: Closing WebSocket connection for session %s", sessionID)
			if err := wsConn.close(); err != nil {
				log.Printf("Warning: failed to close WebSocket for session %s: %v", sessionID, err)
			}
		}
	}

	// Signal session is done
	close(session.Done)

	// Disable radiod channel (set frequency to 0)
	if err := sm.radiod.DisableChannel(session.ChannelName, session.SSRC); err != nil {
		log.Printf("Warning: failed to disable channel %s: %v", session.ChannelName, err)
	}

	// Close appropriate channel based on session type
	if session.IsSpectrum {
		// Spectrum sessions use SpectrumChan
		if session.SpectrumChan != nil {
			close(session.SpectrumChan)
		}
	} else {
		// Audio sessions use AudioChan
		if session.AudioChan != nil {
			close(session.AudioChan)
		}
	}

	log.Printf("Session destroyed: %s (channel: %s, SSRC: 0x%08x)", sessionID, session.ChannelName, session.SSRC)
	return nil
}

// cleanupLoop periodically checks for and removes inactive sessions and expired kicked UUIDs
func (sm *SessionManager) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		sm.cleanupInactiveSessions()
		sm.cleanupExpiredKickedUUIDs()
	}
}

// maxSessionTimeLoop checks every second for sessions that have exceeded max_session_time
func (sm *SessionManager) maxSessionTimeLoop() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		sm.enforceMaxSessionTime()
	}
}

// enforceMaxSessionTime kicks users whose sessions have exceeded max_session_time
func (sm *SessionManager) enforceMaxSessionTime() {
	if sm.maxSessionTime == 0 {
		return // No limit configured
	}

	now := time.Now()
	var toKick []string // UUIDs to kick

	sm.mu.RLock()
	// Check each UUID's first seen time
	for userSessionID, firstSeen := range sm.userSessionFirst {
		// Skip if already kicked
		if _, kicked := sm.kickedUUIDs[userSessionID]; kicked {
			continue
		}

		sessionAge := now.Sub(firstSeen)
		if sessionAge > sm.maxSessionTime {
			toKick = append(toKick, userSessionID)
		}
	}
	sm.mu.RUnlock()

	// Kick users that exceeded the time limit
	for _, userSessionID := range toKick {
		// Get the first seen time again (safely) for logging
		sm.mu.RLock()
		firstSeen := sm.userSessionFirst[userSessionID]
		sm.mu.RUnlock()

		log.Printf("Session time limit exceeded for user %s (age: %v, limit: %v) - kicking",
			userSessionID, now.Sub(firstSeen), sm.maxSessionTime)

		if _, err := sm.KickUserBySessionID(userSessionID); err != nil {
			log.Printf("Error kicking user %s for time limit: %v", userSessionID, err)
		}

		// Remove from userSessionFirst to prevent repeated kicks
		sm.mu.Lock()
		delete(sm.userSessionFirst, userSessionID)
		sm.mu.Unlock()
	}
}

// cleanupExpiredKickedUUIDs removes expired entries from the kicked UUIDs list
func (sm *SessionManager) cleanupExpiredKickedUUIDs() {
	now := time.Now()
	var toRemove []string

	sm.mu.RLock()
	for uuid, expiry := range sm.kickedUUIDs {
		if now.After(expiry) {
			toRemove = append(toRemove, uuid)
		}
	}
	sm.mu.RUnlock()

	if len(toRemove) > 0 {
		sm.mu.Lock()
		for _, uuid := range toRemove {
			delete(sm.kickedUUIDs, uuid)
		}
		sm.mu.Unlock()
		log.Printf("Cleaned up %d expired kicked UUID(s)", len(toRemove))
	}
}

// cleanupInactiveSessions removes sessions that have exceeded the timeout
// Uses kick logic to prevent reconnection
func (sm *SessionManager) cleanupInactiveSessions() {
	if sm.timeout == 0 {
		return // No timeout configured
	}

	now := time.Now()
	var toKick []string // UUIDs to kick

	sm.mu.RLock()
	// Track which UUIDs have inactive sessions
	inactiveUUIDs := make(map[string]bool)
	for _, session := range sm.sessions {
		session.mu.RLock()
		inactive := now.Sub(session.LastActive)
		userSessionID := session.UserSessionID
		session.mu.RUnlock()

		if inactive > sm.timeout && userSessionID != "" {
			inactiveUUIDs[userSessionID] = true
		}
	}
	sm.mu.RUnlock()

	// Collect UUIDs to kick (only kick each UUID once)
	for uuid := range inactiveUUIDs {
		toKick = append(toKick, uuid)
	}

	// Kick users that exceeded the inactivity timeout
	for _, userSessionID := range toKick {
		log.Printf("Session timeout reached for user %s (inactive for %v) - kicking",
			userSessionID, sm.timeout)

		if _, err := sm.KickUserBySessionID(userSessionID); err != nil {
			log.Printf("Error kicking user %s for inactivity: %v", userSessionID, err)
		}
	}
}

// GetSessionCount returns the current number of active sessions
func (sm *SessionManager) GetSessionCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.sessions)
}

// GetUniqueUserCount returns the current number of unique users (by user_session_id)
func (sm *SessionManager) GetUniqueUserCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.userSessionUUIDs)
}

// CanAcceptNewUUID checks if a new UUID can be accepted without exceeding max_sessions
// Returns true if the UUID already exists OR if there's room for a new UUID
func (sm *SessionManager) CanAcceptNewUUID(userSessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	// If this UUID already has sessions, it's always allowed
	if _, exists := sm.userSessionUUIDs[userSessionID]; exists {
		return true
	}

	// Check if we have room for a new UUID
	return len(sm.userSessionUUIDs) < sm.config.Server.MaxSessions
}

// CanAcceptNewIP checks if a new UUID from an IP can be accepted without exceeding max_sessions_ip
// Returns true if max_sessions_ip is 0 (unlimited), if the UUID already exists for this IP,
// or if the IP has fewer unique UUIDs than the limit. Note: This limits unique UUIDs per IP, not total sessions.
func (sm *SessionManager) CanAcceptNewIP(clientIP, userSessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	// If max_sessions_ip is 0 or not configured, allow unlimited
	if sm.config.Server.MaxSessionsIP <= 0 {
		return true
	}

	// If IP or UUID is empty, can't enforce limit properly
	if clientIP == "" || userSessionID == "" {
		return true
	}

	// Check if this UUID already exists for this IP
	if uuidSet, exists := sm.ipToUUIDs[clientIP]; exists {
		// If UUID already exists for this IP, always allow (same user, multiple sessions)
		if uuidSet[userSessionID] {
			return true
		}
		// New UUID for this IP, check if we've reached the limit
		return len(uuidSet) < sm.config.Server.MaxSessionsIP
	}
	// IP doesn't exist yet, so it's allowed
	return true
}

// SetUserAgent stores the User-Agent string for a user_session_id
func (sm *SessionManager) SetUserAgent(userSessionID, userAgent string) {
	if userSessionID == "" {
		return
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.userAgents[userSessionID] = userAgent
}

// GetUserAgent retrieves the User-Agent string for a user_session_id
func (sm *SessionManager) GetUserAgent(userSessionID string) string {
	if userSessionID == "" {
		return ""
	}

	sm.mu.RLock()
	defer sm.mu.RUnlock()

	return sm.userAgents[userSessionID]
}

// GetSessionInfo returns information about a session
func (s *Session) GetInfo() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return map[string]interface{}{
		"id":          s.ID,
		"channel":     s.ChannelName,
		"ssrc":        s.SSRC,
		"frequency":   s.Frequency,
		"mode":        s.Mode,
		"bandwidth":   s.Bandwidth,
		"sample_rate": s.SampleRate,
		"created_at":  s.CreatedAt,
		"last_active": s.LastActive,
	}
}

// GetSessionBySSRC retrieves a session by its SSRC
func (sm *SessionManager) GetSessionBySSRC(ssrc uint32) (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	session, ok := sm.ssrcToSession[ssrc]
	return session, ok
}

// GetAllSessionsInfo returns information about all active sessions
func (sm *SessionManager) GetAllSessionsInfo() []map[string]interface{} {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	sessions := make([]map[string]interface{}, 0, len(sm.sessions))
	for _, session := range sm.sessions {
		session.mu.RLock()
		info := map[string]interface{}{
			"id":              session.ID,
			"channel":         session.ChannelName,
			"ssrc":            fmt.Sprintf("0x%08x", session.SSRC),
			"frequency":       session.Frequency,
			"mode":            session.Mode,
			"is_spectrum":     session.IsSpectrum,
			"source_ip":       session.SourceIP,
			"client_ip":       session.ClientIP,
			"user_session_id": session.UserSessionID,
			"created_at":      session.CreatedAt.Format(time.RFC3339),
			"last_active":     session.LastActive.Format(time.RFC3339),
		}

		// Add type-specific info
		if session.IsSpectrum {
			info["bin_count"] = session.BinCount
			info["bin_bandwidth"] = session.BinBandwidth
		} else {
			info["sample_rate"] = session.SampleRate
			info["bandwidth_low"] = session.BandwidthLow
			info["bandwidth_high"] = session.BandwidthHigh
		}
		// Add user_session_first_seen if available
		if session.UserSessionID != "" {
			if firstSeen, exists := sm.userSessionFirst[session.UserSessionID]; exists {
				info["user_session_first_seen"] = firstSeen.Format(time.RFC3339)
			}
			// Add user_agent if available
			if userAgent, exists := sm.userAgents[session.UserSessionID]; exists {
				info["user_agent"] = userAgent
			}
		}

		session.mu.RUnlock()

		sessions = append(sessions, info)
	}

	return sessions
}

// Shutdown cleanly destroys all active sessions
func (sm *SessionManager) Shutdown() {
	sm.mu.Lock()
	sessionIDs := make([]string, 0, len(sm.sessions))
	for id := range sm.sessions {
		sessionIDs = append(sessionIDs, id)
	}
	sm.mu.Unlock()

	log.Printf("Shutting down session manager: destroying %d active sessions", len(sessionIDs))

	for _, id := range sessionIDs {
		if err := sm.DestroySession(id); err != nil {
			log.Printf("Error destroying session %s during shutdown: %v", id, err)
		}
	}

	log.Println("All sessions destroyed")
}

// IsUUIDKicked checks if a user_session_id has been kicked
func (sm *SessionManager) IsUUIDKicked(userSessionID string) bool {
	if userSessionID == "" {
		return false
	}

	sm.mu.RLock()
	defer sm.mu.RUnlock()

	expiry, exists := sm.kickedUUIDs[userSessionID]

	if !exists {
		return false
	}

	// Check if the kick has expired
	if time.Now().After(expiry) {
		// Expired, will be cleaned up by cleanup loop
		log.Printf("DEBUG: UUID %s kick has expired", userSessionID)
		return false
	}

	log.Printf("DEBUG: UUID %s is kicked (expires: %v)", userSessionID, expiry)
	return true
}

// KickUserBySessionID destroys all sessions with the given user_session_id
// and adds the UUID to the kicked list to prevent reconnection
func (sm *SessionManager) KickUserBySessionID(userSessionID string) (int, error) {
	if userSessionID == "" {
		return 0, fmt.Errorf("user_session_id cannot be empty")
	}

	log.Printf("DEBUG: Kicking user_session_id: %s", userSessionID)

	sm.mu.Lock()
	// Add UUID to kicked list with expiry time
	sm.kickedUUIDs[userSessionID] = time.Now().Add(sm.kickedUUIDTTL)
	log.Printf("DEBUG: Added %s to kickedUUIDs map (size now: %d)", userSessionID, len(sm.kickedUUIDs))
	sm.mu.Unlock()

	sm.mu.RLock()
	var sessionsToKick []string
	for _, session := range sm.sessions {
		session.mu.RLock()
		if session.UserSessionID == userSessionID {
			sessionsToKick = append(sessionsToKick, session.ID)
			log.Printf("DEBUG: Found session to kick: %s (type: %s)", session.ID, func() string {
				if session.IsSpectrum {
					return "spectrum"
				}
				return "audio"
			}())
		}
		session.mu.RUnlock()
	}
	sm.mu.RUnlock()

	// Destroy all matching sessions (this closes the WebSocket connections)
	for _, sessionID := range sessionsToKick {
		if err := sm.DestroySession(sessionID); err != nil {
			log.Printf("Error kicking session %s: %v", sessionID, err)
		}
	}

	log.Printf("Kicked user with session ID %s (%d session(s) destroyed, UUID blacklisted for %v)",
		userSessionID, len(sessionsToKick), sm.kickedUUIDTTL)
	return len(sessionsToKick), nil
}

// KickUserByIP destroys all sessions from the given IP address
func (sm *SessionManager) KickUserByIP(ip string) (int, error) {
	if ip == "" {
		return 0, fmt.Errorf("IP address cannot be empty")
	}

	sm.mu.RLock()
	var sessionsToKick []string
	for _, session := range sm.sessions {
		session.mu.RLock()
		// Check both client IP and source IP
		if session.ClientIP == ip || session.SourceIP == ip {
			sessionsToKick = append(sessionsToKick, session.ID)
		}
		session.mu.RUnlock()
	}
	sm.mu.RUnlock()

	// Destroy all matching sessions
	for _, sessionID := range sessionsToKick {
		if err := sm.DestroySession(sessionID); err != nil {
			log.Printf("Error kicking session %s: %v", sessionID, err)
		}
	}

	log.Printf("Kicked user from IP %s (%d session(s) destroyed)", ip, len(sessionsToKick))
	return len(sessionsToKick), nil
}
