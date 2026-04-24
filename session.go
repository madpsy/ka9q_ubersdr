package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// radiodController is the interface that SessionManager uses to talk to radiod.
// *RadiodController satisfies this interface; tests can inject a stub.
type radiodController interface {
	CreateChannelWithBandwidth(name string, frequency uint64, mode string, sampleRate int, ssrc uint32, bandwidth int) error
	CreateSpectrumChannel(name string, frequency uint64, binCount int, binBandwidth float64, ssrc uint32) error
	TerminateChannel(name string, ssrc uint32) error
	UpdateSpectrumChannel(ssrc uint32, frequency uint64, binBandwidth float64, binCount int, sendBinCount bool) error
	UpdateChannel(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool) error
	UpdateSquelch(ssrc uint32, squelchOpen, squelchClose float32) error
	GetFrontendStatus(ssrc uint32) *FrontendStatus
	DisableChannelSilent(name string, ssrc uint32) error
	GetAllChannelStatus() map[uint32]*ChannelStatus
	GetChannelStatus(ssrc uint32) *ChannelStatus
}

// BytesSample represents a sample of bytes sent at a specific time
type BytesSample struct {
	Timestamp time.Time
	Bytes     uint64
}

// SharedDefaultChannel holds the single on-demand radiod spectrum channel that is shared
// among all users whose spectrum parameters match the configured defaults.
// Lifecycle: created on first subscriber, torn down when the last subscriber leaves.
// All fields except mu are protected by SessionManager.mu (held as write lock during
// create/destroy transitions). mu is only used in distributeSpectrum() which runs
// outside sm.mu to take a snapshot of subscribers for fan-out.
type SharedDefaultChannel struct {
	active      bool                // true while the radiod channel exists
	ssrc        uint32              // SSRC assigned to the shared radiod channel
	channelName string              // radiod channel name (e.g. "spectrum-shared-XXXXXXXX")
	subscribers map[string]*Session // sessionID → *Session
	mu          sync.RWMutex        // guards subscribers snapshot in distributeSpectrum only
}

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
	Channels      int // Number of audio channels (1=mono, 2=stereo for IQ)
	CreatedAt     time.Time
	LastActive    time.Time
	AudioChan     chan AudioPacket
	Done          chan struct{}
	mu            sync.RWMutex

	// Connection info
	SourceIP       string // Direct connection IP (RemoteAddr)
	ClientIP       string // True client IP (from X-Forwarded-For if present)
	UserSessionID  string // Client-generated UUID to link audio and spectrum sessions
	UserAgent      string // User-Agent string from the client
	BypassPassword string // Password used for bypass authentication (if any)
	AuthMethod     string // Authentication method: "password", "ip_bypass", or "" for normal
	Country        string // Country name from GeoIP lookup (internal use only)
	CountryCode    string // ISO country code from GeoIP lookup (internal use only)

	// WebSocket connection (for closing when kicked)
	WSConn interface{} // *wsConn, stored as interface{} to avoid import cycle

	// Spectrum-specific fields (only used when Mode == "spectrum")
	IsSpectrum         bool
	IsBackground       bool // True for internal/background spectrum sessions (noisefloor, frequency-reference) that should be polled at a slower rate
	IsSharedSubscriber bool // True when this session is subscribed to the shared default spectrum channel
	BinCount           int
	BinBandwidth       float64
	SpectrumChan       chan []float32 // Channel for spectrum data

	// Network statistics (protected by mu)
	AudioBytesSent     uint64 // Total audio bytes sent
	WaterfallBytesSent uint64 // Total waterfall/spectrum bytes sent

	// Sliding window for instantaneous throughput (1 second window)
	audioSamples     []BytesSample // Samples for audio bytes
	waterfallSamples []BytesSample // Samples for waterfall bytes

	// Cumulative tracking for session activity logging
	VisitedBands map[string]bool // Set of band names visited during this session
	VisitedModes map[string]bool // Set of modes used during this session
	bandsMu      sync.RWMutex    // Protect VisitedBands map
	modesMu      sync.RWMutex    // Protect VisitedModes map

	// Audio extension tap (for streaming audio to background processors)
	audioExtensionChan chan AudioSample
	audioExtensionMu   sync.RWMutex
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
	userAgentLastSeen    map[string]time.Time       // Map of user_session_id to last time it had an active session
	uuidToIP             map[string]string          // Map of user_session_id to bound IP address (for security)
	uuidAudioSessions    map[string]string          // Map of user_session_id to audio session ID (enforces 1 audio per UUID)
	uuidSpectrumSessions map[string]string          // Map of user_session_id to spectrum session ID (enforces 1 spectrum per UUID)
	userSessionBands     map[string]map[string]bool // Map of user_session_id to visited bands (cumulative across all sessions)
	userSessionModes     map[string]map[string]bool // Map of user_session_id to visited modes (cumulative across all sessions)
	rdnsCache            map[string]string          // Map of clientIP to resolved PTR hostname ("" = no record)
	rdnsResolved         map[string]bool            // Map of clientIP to whether lookup has completed
	rdnsMu               sync.RWMutex               // Separate mutex for rdns maps to avoid hot-path contention
	// Shared default spectrum channel — one radiod channel shared by all users at default params.
	// Both fields are protected by sm.mu (write lock required for create/destroy transitions).
	sharedDefaultChan  *SharedDefaultChannel            // The single shared channel (nil until first subscriber)
	ssrcToShared       map[uint32]*SharedDefaultChannel // SSRC → shared channel (for fast lookup in distributeSpectrum)
	mu                 sync.RWMutex
	config             *Config
	radiod             radiodController
	maxSessions        int
	timeout            time.Duration
	maxSessionTime     time.Duration          // Maximum time a session can exist (0 = unlimited)
	kickedUUIDTTL      time.Duration          // How long to remember kicked UUIDs (default 1 hour)
	prometheusMetrics  *PrometheusMetrics     // Prometheus metrics for tracking
	activityLogger     *SessionActivityLogger // Session activity logger for disk logging
	geoIPService       *GeoIPService          // GeoIP service for country lookups (optional)
	dxClusterWsHandler interface{}            // DXClusterWebSocketHandler for throughput tracking (interface to avoid import cycle)
}

// NewSessionManager creates a new session manager
func NewSessionManager(config *Config, radiod radiodController, geoIPService *GeoIPService) *SessionManager {
	sm := &SessionManager{
		sessions:             make(map[string]*Session),
		ssrcToSession:        make(map[uint32]*Session),
		kickedUUIDs:          make(map[string]time.Time),
		userSessionFirst:     make(map[string]time.Time),
		userSessionUUIDs:     make(map[string]int),
		ipToUUIDs:            make(map[string]map[string]bool),
		userAgents:           make(map[string]string),
		userAgentLastSeen:    make(map[string]time.Time),
		uuidToIP:             make(map[string]string),
		uuidAudioSessions:    make(map[string]string),
		uuidSpectrumSessions: make(map[string]string),
		userSessionBands:     make(map[string]map[string]bool),
		userSessionModes:     make(map[string]map[string]bool),
		rdnsCache:            make(map[string]string),
		rdnsResolved:         make(map[string]bool),
		ssrcToShared:         make(map[uint32]*SharedDefaultChannel),
		config:               config,
		radiod:               radiod,
		maxSessions:          config.Server.MaxSessions,
		timeout:              time.Duration(config.Server.SessionTimeout) * time.Second,
		maxSessionTime:       time.Duration(config.Server.MaxSessionTime) * time.Second,
		kickedUUIDTTL:        1 * time.Hour, // Remember kicked UUIDs for 1 hour
		prometheusMetrics:    nil,           // Will be set later if Prometheus is enabled
		geoIPService:         geoIPService,  // GeoIP service for country lookups
	}

	// Start cleanup goroutine
	go sm.cleanupLoop()

	// Start max session time enforcement goroutine if configured
	if sm.maxSessionTime > 0 {
		go sm.maxSessionTimeLoop()
	}

	// Start orphaned channel cleanup goroutine
	go sm.cleanupOrphanedChannels()

	return sm
}

// SetPrometheusMetrics sets the Prometheus metrics instance for this session manager
func (sm *SessionManager) SetPrometheusMetrics(pm *PrometheusMetrics) {
	sm.prometheusMetrics = pm
}

// SetActivityLogger sets the session activity logger for this session manager
func (sm *SessionManager) SetActivityLogger(logger *SessionActivityLogger) {
	sm.activityLogger = logger
}

// SetDXClusterWebSocketHandler sets the DX cluster websocket handler for throughput tracking
func (sm *SessionManager) SetDXClusterWebSocketHandler(handler interface{}) {
	sm.dxClusterWsHandler = handler
}

// translateModeForRadiod translates UI mode names to radiod preset names
// This allows the UI to show user-friendly names while sending correct presets to radiod
func translateModeForRadiod(mode string) string {
	// FM modes use their own presets (not PM)
	// NFM (narrow FM) and FM (wide FM) are separate presets in radiod
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
	return sm.CreateSessionWithBandwidthAndPassword(frequency, mode, 3000, sourceIP, clientIP, userSessionID, "")
}

// CreateSessionWithBandwidth creates a new session with a unique channel and specified bandwidth
func (sm *SessionManager) CreateSessionWithBandwidth(frequency uint64, mode string, bandwidth int, sourceIP, clientIP, userSessionID string) (*Session, error) {
	return sm.CreateSessionWithBandwidthAndPassword(frequency, mode, bandwidth, sourceIP, clientIP, userSessionID, "")
}

// CreateSessionWithBandwidthAndPassword creates a new session with a unique channel, specified bandwidth, and bypass password
func (sm *SessionManager) CreateSessionWithBandwidthAndPassword(frequency uint64, mode string, bandwidth int, sourceIP, clientIP, userSessionID, password string) (*Session, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Track first time we see this user_session_id
	if userSessionID != "" {
		if _, exists := sm.userSessionFirst[userSessionID]; !exists {
			sm.userSessionFirst[userSessionID] = time.Now()
		}
	}

	// Check session limit based on unique user_session_ids
	// Skip this check if the IP is in the bypass list OR if this is an internal session (no IP)
	// Internal sessions (noise floor, decoders) have empty ClientIP and should not count towards user limits
	if clientIP != "" && !sm.config.Server.IsIPTimeoutBypassed(clientIP, password) {
		// If userSessionID is empty, treat as a unique user for each session
		if userSessionID == "" {
			// No UUID provided - count as unique user per session (legacy behavior)
			if len(sm.sessions) >= sm.maxSessions {
				return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
			}
		} else {
			// UUID provided - check if this is a new unique user.
			// Use canAcceptNewUUIDLocked which counts only non-bypassed users,
			// so internal/bypassed sessions don't consume slots for real users.
			if !sm.canAcceptNewUUIDLocked(userSessionID) {
				return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
			}
			// Existing user can create additional sessions (audio + spectrum)
		}
	}

	// Check if we've reached the maximum unique UUIDs per IP (if configured)
	// Skip this check if the IP is in the bypass list
	if sm.config.Server.MaxSessionsIP > 0 && clientIP != "" && userSessionID != "" {
		if !sm.config.Server.IsIPTimeoutBypassed(clientIP, password) {
			// Check if this is a new UUID for this IP
			if uuidSet, exists := sm.ipToUUIDs[clientIP]; exists {
				// IP exists, check if UUID is new
				if !uuidSet[userSessionID] {
					// New UUID for this IP, check limit
					if len(uuidSet) >= sm.config.Server.MaxSessionsIP {
						// Log debug info about which UUIDs are registered for this IP
						uuidList := make([]string, 0, len(uuidSet))
						for uuid := range uuidSet {
							uuidList = append(uuidList, uuid)
						}
						log.Printf("DEBUG AUDIO: IP %s has %d UUIDs: %v (trying to add: %s, password provided: %v, bypass check: %v)",
							clientIP, len(uuidSet), uuidList, userSessionID, password != "", sm.config.Server.IsIPTimeoutBypassed(clientIP, password))
						return nil, fmt.Errorf("maximum unique users per IP reached (%d)", sm.config.Server.MaxSessionsIP)
					}
				}
			}
			// If IP doesn't exist yet or UUID already exists for this IP, allow it
		}
	}

	// Check if this UUID already has an audio session
	// If so, replace it (allows reconnection after disconnection)
	if userSessionID != "" {
		if existingSessionID, exists := sm.uuidAudioSessions[userSessionID]; exists {
			log.Printf("Replacing existing audio session %s for UUID %s (reconnection detected)", existingSessionID, userSessionID)
			// Unlock before calling DestroySession to avoid deadlock
			sm.mu.Unlock()
			if err := sm.DestroySession(existingSessionID); err != nil {
				log.Printf("Warning: failed to destroy old audio session %s: %v", existingSessionID, err)
			}
			// Re-lock after destroying the old session
			sm.mu.Lock()
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

	// Determine number of channels based on mode
	// IQ modes use stereo (I and Q channels), all others use mono
	channels := 1
	if mode == "iq" || mode == "iq48" || mode == "iq96" || mode == "iq192" || mode == "iq384" {
		channels = 2
	}

	// Create session with default bandwidth edges (50 Hz to bandwidth Hz for SSB)
	session := &Session{
		ID:             sessionID,
		ChannelName:    channelName,
		SSRC:           ssrc,
		Frequency:      frequency,
		Mode:           mode,
		Bandwidth:      bandwidth,
		BandwidthLow:   50,        // Default low edge
		BandwidthHigh:  bandwidth, // Default high edge
		SampleRate:     sampleRate,
		Channels:       channels,
		CreatedAt:      time.Now(),
		LastActive:     time.Now(),
		AudioChan:      make(chan AudioPacket, 100), // Buffer 100 audio packets
		Done:           make(chan struct{}),
		SourceIP:       sourceIP,
		ClientIP:       clientIP,
		UserSessionID:  userSessionID,
		BypassPassword: password, // Store the password in the session
		VisitedBands:   make(map[string]bool),
		VisitedModes:   make(map[string]bool),
	}

	// Track initial band and mode in per-session maps
	band := frequencyToBand(float64(frequency))
	if band != "" {
		session.VisitedBands[band] = true
	}
	// Don't track spectrum mode or invalid modes
	if mode != "" && mode != "spectrum" {
		session.VisitedModes[mode] = true
	}

	// Also track in UUID-level maps (must be done while holding sm.mu lock, which we already have)
	if userSessionID != "" {
		if sm.userSessionBands[userSessionID] == nil {
			sm.userSessionBands[userSessionID] = make(map[string]bool)
		}
		if sm.userSessionModes[userSessionID] == nil {
			sm.userSessionModes[userSessionID] = make(map[string]bool)
		}
		if band != "" {
			sm.userSessionBands[userSessionID][band] = true
		}
		// Don't track spectrum mode or invalid modes
		if mode != "" && mode != "spectrum" {
			sm.userSessionModes[userSessionID][mode] = true
		}
	}

	// Perform GeoIP lookup if service is available and we have a client IP
	if sm.geoIPService != nil && clientIP != "" {
		session.Country, session.CountryCode = sm.geoIPService.LookupSafe(clientIP)
	}

	// Translate mode for radiod (e.g., "fm" -> "pm")
	radiodMode := translateModeForRadiod(mode)

	// Create radiod channel with unique random SSRC and bandwidth
	// For wide IQ modes (iq48, iq96, iq192, iq384), don't send bandwidth - use preset values
	// Check if this is a wide IQ mode
	wideIQModes := map[string]bool{
		"iq48": true, "iq96": true, "iq192": true, "iq384": true,
	}

	if wideIQModes[mode] {
		// Wide IQ mode - create channel without bandwidth parameter (use preset)
		// We pass 0 for bandwidth which signals radiod to use preset values
		if err := sm.radiod.CreateChannelWithBandwidth(channelName, frequency, radiodMode, sampleRate, ssrc, 0); err != nil {
			return nil, fmt.Errorf("failed to create radiod channel: %w", err)
		}
		log.Printf("WIDEIQ_CREATE_CHANNEL: mode=%s channel=%s ssrc=0x%08x", mode, channelName, ssrc)
	} else {
		// Normal mode - create channel with specified bandwidth
		if err := sm.radiod.CreateChannelWithBandwidth(channelName, frequency, radiodMode, sampleRate, ssrc, bandwidth); err != nil {
			return nil, fmt.Errorf("failed to create radiod channel: %w", err)
		}
	}

	sm.sessions[sessionID] = session
	sm.ssrcToSession[ssrc] = session

	// Track if this is a new UUID (for activity logging)
	isNewUUID := false
	hadAudioBefore := false
	if userSessionID != "" {
		if _, exists := sm.userSessionUUIDs[userSessionID]; !exists {
			isNewUUID = true
		} else {
			// Existing UUID - check if they already had an audio session
			if _, exists := sm.uuidAudioSessions[userSessionID]; exists {
				hadAudioBefore = true
			}
		}
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

	// Log session activity if this is a NEW UUID OR if adding audio to existing spectrum-only session
	if sm.activityLogger != nil && (isNewUUID || !hadAudioBefore) {
		if err := sm.activityLogger.LogSessionCreated(); err != nil {
			log.Printf("Warning: failed to log session creation: %v", err)
		}
	}

	return session, nil
}

// CreateSpectrumSession creates a new spectrum session with default parameters
// Users can only adjust frequency (pan) and bin_bw (zoom), bin_count is fixed
func (sm *SessionManager) CreateSpectrumSession() (*Session, error) {
	return sm.CreateSpectrumSessionWithIP("", "")
}

// CreateSpectrumSessionWithIP creates a new spectrum session with IP tracking
func (sm *SessionManager) CreateSpectrumSessionWithIP(sourceIP, clientIP string) (*Session, error) {
	return sm.createSpectrumSessionWithUserIDAndPassword(sourceIP, clientIP, "", "")
}

// CreateSpectrumSessionWithUserID creates a new spectrum session with IP tracking and user session ID
func (sm *SessionManager) CreateSpectrumSessionWithUserID(sourceIP, clientIP, userSessionID string) (*Session, error) {
	return sm.createSpectrumSessionWithUserIDAndPassword(sourceIP, clientIP, userSessionID, "")
}

// CreateSpectrumSessionWithUserIDAndPassword creates a new spectrum session with IP tracking, user session ID, and bypass password
func (sm *SessionManager) CreateSpectrumSessionWithUserIDAndPassword(sourceIP, clientIP, userSessionID, password string) (*Session, error) {
	return sm.createSpectrumSessionWithUserIDAndPassword(sourceIP, clientIP, userSessionID, password)
}

// createSpectrumSessionWithUserIDAndPassword is the internal implementation
func (sm *SessionManager) createSpectrumSessionWithUserIDAndPassword(sourceIP, clientIP, userSessionID, password string) (*Session, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Track first time we see this user_session_id
	if userSessionID != "" {
		if _, exists := sm.userSessionFirst[userSessionID]; !exists {
			sm.userSessionFirst[userSessionID] = time.Now()
		}
	}

	// Check session limit based on unique user_session_ids
	// Skip this check if the IP is in the bypass list OR if this is an internal session (no IP)
	// Internal sessions (noise floor, decoders) have empty ClientIP and should not count towards user limits
	log.Printf("DEBUG SPECTRUM: Checking limits for IP %s, UUID %s, password provided: %v, bypass result: %v",
		clientIP, userSessionID, password != "", sm.config.Server.IsIPTimeoutBypassed(clientIP, password))
	if clientIP != "" && !sm.config.Server.IsIPTimeoutBypassed(clientIP, password) {
		// If userSessionID is empty, treat as a unique user for each session
		if userSessionID == "" {
			// No UUID provided - count as unique user per session (legacy behavior)
			if len(sm.sessions) >= sm.maxSessions {
				return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
			}
		} else {
			// UUID provided - check if this is a new unique user.
			// Use canAcceptNewUUIDLocked which counts only non-bypassed users,
			// so internal/bypassed sessions don't consume slots for real users.
			if !sm.canAcceptNewUUIDLocked(userSessionID) {
				return nil, fmt.Errorf("maximum unique users reached (%d)", sm.maxSessions)
			}
			// Existing user can create additional sessions (audio + spectrum)
		}
	}

	// Check if this UUID already has a spectrum session
	// If so, we'll replace it (allows reconnection after disconnection)
	// We need to check this BEFORE the IP limit check because replacing an existing
	// session shouldn't count as a new UUID for IP limit purposes
	isReplacingExistingSession := false
	if userSessionID != "" {
		if _, exists := sm.uuidSpectrumSessions[userSessionID]; exists {
			isReplacingExistingSession = true
		}
	}

	// Check if we've reached the maximum unique UUIDs per IP (if configured)
	// Skip this check if the IP is in the bypass list OR if we're replacing an existing session
	if sm.config.Server.MaxSessionsIP > 0 && clientIP != "" && userSessionID != "" && !isReplacingExistingSession {
		if !sm.config.Server.IsIPTimeoutBypassed(clientIP, password) {
			// Check if this is a new UUID for this IP
			if uuidSet, exists := sm.ipToUUIDs[clientIP]; exists {
				// IP exists, check if UUID is new
				if !uuidSet[userSessionID] {
					// New UUID for this IP, check limit
					if len(uuidSet) >= sm.config.Server.MaxSessionsIP {
						// Log debug info about which UUIDs are registered for this IP
						uuidList := make([]string, 0, len(uuidSet))
						for uuid := range uuidSet {
							uuidList = append(uuidList, uuid)
						}
						log.Printf("DEBUG SPECTRUM: IP %s has %d UUIDs: %v (trying to add: %s, password provided: %v, bypass check: %v)",
							clientIP, len(uuidSet), uuidList, userSessionID, password != "", sm.config.Server.IsIPTimeoutBypassed(clientIP, password))
						return nil, fmt.Errorf("maximum unique users per IP reached (%d)", sm.config.Server.MaxSessionsIP)
					}
				}
			}
			// If IP doesn't exist yet or UUID already exists for this IP, allow it
		}
	}

	// Now actually replace the existing spectrum session if needed
	if userSessionID != "" && isReplacingExistingSession {
		if existingSessionID, exists := sm.uuidSpectrumSessions[userSessionID]; exists {
			log.Printf("Replacing existing spectrum session %s for UUID %s (reconnection detected)", existingSessionID, userSessionID)
			// Unlock before calling DestroySession to avoid deadlock
			sm.mu.Unlock()
			if err := sm.DestroySession(existingSessionID); err != nil {
				log.Printf("Warning: failed to destroy old spectrum session %s: %v", existingSessionID, err)
			}
			// Re-lock after destroying the old session
			sm.mu.Lock()
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

	// Validate frequency - must not be 0
	// If config has invalid frequency, use 15 MHz as fallback (covers 0-30 MHz HF range)
	const minFrequency = 10000 // 10 kHz minimum
	if frequency < minFrequency {
		log.Printf("WARNING: Invalid spectrum center frequency %d Hz in config (must be >= %d Hz), using fallback 15 MHz",
			frequency, minFrequency)
		frequency = 15000000 // 15 MHz fallback
	}

	// Create spectrum session
	session := &Session{
		ID:             sessionID,
		ChannelName:    channelName,
		SSRC:           ssrc,
		Frequency:      frequency,
		Mode:           "spectrum",
		IsSpectrum:     true,
		BinCount:       binCount,
		BinBandwidth:   binBandwidth,
		CreatedAt:      time.Now(),
		LastActive:     time.Now(),
		SpectrumChan:   make(chan []float32, 30), // Buffer spectrum updates (increased from 10 to 30 for better performance with many users)
		Done:           make(chan struct{}),
		SourceIP:       sourceIP,
		ClientIP:       clientIP,
		UserSessionID:  userSessionID,
		BypassPassword: password, // Store the password in the session
		VisitedBands:   make(map[string]bool),
		VisitedModes:   make(map[string]bool),
	}

	// Note: Spectrum sessions don't track bands/modes because they only show
	// the waterfall center frequency, not actual tuned frequencies

	// Perform GeoIP lookup if service is available and we have a client IP
	if sm.geoIPService != nil && clientIP != "" {
		session.Country, session.CountryCode = sm.geoIPService.LookupSafe(clientIP)
	}

	// Decide whether to use the shared default channel or create a private one.
	// We use the shared channel when the session parameters exactly match the
	// configured defaults (i.e. the user has not zoomed or panned yet).
	if sm.isAtDefaultSpectrumParams(frequency, binBandwidth, binCount) {
		// ── Shared channel path ──────────────────────────────────────────────
		if err := sm.subscribeToSharedChannel(session); err != nil {
			return nil, err
		}
		sm.sessions[sessionID] = session
		// NOTE: shared subscribers are NOT added to ssrcToSession — distributeSpectrum
		// uses ssrcToShared for fan-out instead.
		sdc := sm.sharedDefaultChan
		log.Printf("Spectrum session created (shared channel): %s (SSRC: 0x%08x, freq: %d Hz, bins: %d, bw: %.1f Hz, user: %s, subscribers: %d)",
			sessionID, sdc.ssrc, frequency, binCount, binBandwidth, userSessionID, len(sdc.subscribers))
	} else {
		// ── Private channel path ─────────────────────────────────────────────
		if err := sm.radiod.CreateSpectrumChannel(channelName, frequency, binCount, binBandwidth, ssrc); err != nil {
			return nil, fmt.Errorf("failed to create radiod spectrum channel: %w", err)
		}
		sm.sessions[sessionID] = session
		sm.ssrcToSession[ssrc] = session
		log.Printf("Spectrum session created (private channel): %s (SSRC: 0x%08x, freq: %d Hz, bins: %d, bw: %.1f Hz, user: %s)",
			sessionID, ssrc, frequency, binCount, binBandwidth, userSessionID)
	}

	// Track if this is a new UUID (for activity logging)
	isNewUUID := false
	hadSpectrumBefore := false
	if userSessionID != "" {
		if _, exists := sm.userSessionUUIDs[userSessionID]; !exists {
			isNewUUID = true
		} else {
			// Existing UUID - check if they already had a spectrum session
			if _, exists := sm.uuidSpectrumSessions[userSessionID]; exists {
				hadSpectrumBefore = true
			}
		}
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

	// Log session activity if this is a NEW UUID OR if adding spectrum to existing audio-only session
	if sm.activityLogger != nil && (isNewUUID || !hadSpectrumBefore) {
		if err := sm.activityLogger.LogSessionCreated(); err != nil {
			log.Printf("Warning: failed to log spectrum session creation: %v", err)
		}
	}

	return session, nil
}

// isAtDefaultSpectrumParams returns true when the given spectrum parameters exactly match
// the configured defaults (i.e. the user is at the fully-zoomed-out default view).
// Called with sm.mu held (read or write).
func (sm *SessionManager) isAtDefaultSpectrumParams(frequency uint64, binBandwidth float64, binCount int) bool {
	def := sm.config.Spectrum.Default
	return frequency == def.CenterFrequency &&
		binBandwidth == def.BinBandwidth &&
		binCount == def.BinCount
}

// subscribeToSharedChannel adds a session to the shared default spectrum channel,
// creating the radiod channel on-demand if it does not yet exist.
// Must be called with sm.mu held as a write lock.
// On success the session's SSRC, ChannelName and IsSharedSubscriber fields are updated.
func (sm *SessionManager) subscribeToSharedChannel(session *Session) error {
	sdc := sm.sharedDefaultChan
	if sdc == nil || !sdc.active {
		// First subscriber — spin up the shared radiod channel.
		sharedSSRC := uint32(rand.Int31())
		if sharedSSRC == 0 || sharedSSRC == 0xffffffff {
			sharedSSRC = 1
		}
		for {
			_, inSession := sm.ssrcToSession[sharedSSRC]
			_, inShared := sm.ssrcToShared[sharedSSRC]
			if !inSession && !inShared {
				break
			}
			sharedSSRC = uint32(rand.Int31())
			if sharedSSRC == 0 || sharedSSRC == 0xffffffff {
				sharedSSRC = 1
			}
		}
		def := sm.config.Spectrum.Default
		sharedName := fmt.Sprintf("spectrum-shared-%08x", sharedSSRC)
		if err := sm.radiod.CreateSpectrumChannel(sharedName, def.CenterFrequency, def.BinCount, def.BinBandwidth, sharedSSRC); err != nil {
			return fmt.Errorf("failed to create shared radiod spectrum channel: %w", err)
		}
		sdc = &SharedDefaultChannel{
			active:      true,
			ssrc:        sharedSSRC,
			channelName: sharedName,
			subscribers: make(map[string]*Session),
		}
		sm.sharedDefaultChan = sdc
		sm.ssrcToShared[sharedSSRC] = sdc
		log.Printf("Shared default spectrum channel created: %s (SSRC: 0x%08x)", sharedName, sharedSSRC)
	}
	session.SSRC = sdc.ssrc
	session.ChannelName = sdc.channelName
	session.IsSharedSubscriber = true
	sdc.mu.Lock()
	sdc.subscribers[session.ID] = session
	sdc.mu.Unlock()
	return nil
}

// UpdateSpectrumSession updates spectrum parameters (for zoom/pan).
// Supports dynamic bin_count adjustment for deep zoom levels beyond 256x.
//
// If the session is currently a shared-channel subscriber and the new parameters
// differ from the defaults, the session is transparently migrated to a private
// radiod channel so that only this user sees the zoomed view.
func (sm *SessionManager) UpdateSpectrumSession(sessionID string, frequency uint64, binBandwidth float64, binCount int) error {
	session, ok := sm.GetSession(sessionID)
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	if !session.IsSpectrum {
		return fmt.Errorf("session %s is not a spectrum session", sessionID)
	}

	// Validate frequency if provided - must not be 0
	const minFrequency = 10000 // 10 kHz minimum
	if frequency > 0 && frequency < minFrequency {
		return fmt.Errorf("invalid spectrum frequency %d Hz (must be >= %d Hz)", frequency, minFrequency)
	}

	// Compute the effective new parameters (fall back to current values for zeros).
	session.mu.RLock()
	newFreq := session.Frequency
	newBinBW := session.BinBandwidth
	newBinCount := session.BinCount
	session.mu.RUnlock()
	if frequency > 0 {
		newFreq = frequency
	}
	if binBandwidth > 0 {
		newBinBW = binBandwidth
	}
	if binCount > 0 {
		newBinCount = binCount
	}

	// ── Shared → private migration ───────────────────────────────────────────
	// If the session is currently on the shared channel and the new params are
	// NOT the defaults, we must give it a private radiod channel.
	if session.IsSharedSubscriber && !sm.isAtDefaultSpectrumParams(newFreq, newBinBW, newBinCount) {
		sm.mu.Lock()

		// Generate a fresh private SSRC.
		privateSSRC := uint32(rand.Int31())
		if privateSSRC == 0 || privateSSRC == 0xffffffff {
			privateSSRC = 1
		}
		for {
			_, inSession := sm.ssrcToSession[privateSSRC]
			_, inShared := sm.ssrcToShared[privateSSRC]
			if !inSession && !inShared {
				break
			}
			privateSSRC = uint32(rand.Int31())
			if privateSSRC == 0 || privateSSRC == 0xffffffff {
				privateSSRC = 1
			}
		}

		// Unsubscribe from the shared channel.
		oldSSRC := session.SSRC
		oldChannelName := session.ChannelName
		if sdc := sm.sharedDefaultChan; sdc != nil {
			sdc.mu.Lock()
			delete(sdc.subscribers, sessionID)
			remaining := len(sdc.subscribers)
			sdc.mu.Unlock()
			if sdc.active && remaining == 0 {
				sdc.active = false
				delete(sm.ssrcToShared, sdc.ssrc)
				sm.sharedDefaultChan = nil
				log.Printf("Shared default spectrum channel will be terminated (last subscriber zoomed away): %s (SSRC: 0x%08x)",
					sdc.channelName, sdc.ssrc)
				// Terminate outside the lock (below).
			}
		}

		// Create the private radiod channel.
		privateName := fmt.Sprintf("spectrum-%s", sessionID[:8])
		if err := sm.radiod.CreateSpectrumChannel(privateName, newFreq, newBinCount, newBinBW, privateSSRC); err != nil {
			sm.mu.Unlock()
			return fmt.Errorf("failed to create private spectrum channel during zoom: %w", err)
		}

		// Update session fields.
		session.mu.Lock()
		session.SSRC = privateSSRC
		session.ChannelName = privateName
		session.IsSharedSubscriber = false
		session.Frequency = newFreq
		session.BinBandwidth = newBinBW
		session.BinCount = newBinCount
		session.LastActive = time.Now()
		session.mu.Unlock()

		sm.ssrcToSession[privateSSRC] = session
		sm.mu.Unlock()

		// If we were the last shared subscriber, terminate the old shared channel now.
		if _, stillActive := sm.ssrcToShared[oldSSRC]; !stillActive {
			if err := sm.radiod.TerminateChannel(oldChannelName, oldSSRC); err != nil {
				log.Printf("Warning: failed to terminate shared spectrum channel %s after zoom: %v", oldChannelName, err)
			}
		}

		log.Printf("Spectrum session migrated to private channel: %s (SSRC: 0x%08x, freq: %d Hz, bins: %d, bw: %.1f Hz)",
			sessionID, privateSSRC, newFreq, newBinCount, newBinBW)
		return nil
	}

	// ── Normal update (already private, or still at defaults) ────────────────
	// Track if bin_count changed
	binCountChanged := false

	// Update session state
	session.mu.Lock()

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

	// Note: Spectrum sessions don't track bands because they only show
	// the waterfall center frequency, not actual tuned frequencies

	// Send update command to radiod
	// The radiod controller will calculate appropriate filter edges based on the new bandwidth
	if err := sm.radiod.UpdateSpectrumChannel(session.SSRC, frequency, binBandwidth, session.BinCount, binCountChanged); err != nil {
		return fmt.Errorf("failed to update radiod spectrum channel: %w", err)
	}

	return nil
}

// ReturnToSharedChannel migrates a session that currently has a private spectrum
// channel back to the shared default channel (called when the user resets zoom).
// Must NOT be called with sm.mu held.
func (sm *SessionManager) ReturnToSharedChannel(sessionID string) error {
	session, ok := sm.GetSession(sessionID)
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	if !session.IsSpectrum {
		return fmt.Errorf("session %s is not a spectrum session", sessionID)
	}
	if session.IsSharedSubscriber {
		// Already on the shared channel — nothing to do.
		return nil
	}

	sm.mu.Lock()

	// Remember the private channel details so we can terminate it after releasing the lock.
	oldSSRC := session.SSRC
	oldChannelName := session.ChannelName

	// Remove from ssrcToSession (private channel).
	delete(sm.ssrcToSession, oldSSRC)

	// Subscribe to the shared channel (creates it on-demand if needed).
	if err := sm.subscribeToSharedChannel(session); err != nil {
		// Rollback: put the private SSRC back.
		sm.ssrcToSession[oldSSRC] = session
		sm.mu.Unlock()
		return fmt.Errorf("failed to subscribe to shared channel: %w", err)
	}

	// Reset session parameters to defaults.
	def := sm.config.Spectrum.Default
	session.mu.Lock()
	session.Frequency = def.CenterFrequency
	session.BinBandwidth = def.BinBandwidth
	session.BinCount = def.BinCount
	session.LastActive = time.Now()
	session.mu.Unlock()

	sdc := sm.sharedDefaultChan
	sm.mu.Unlock()

	// Terminate the old private radiod channel outside the lock.
	if err := sm.radiod.TerminateChannel(oldChannelName, oldSSRC); err != nil {
		log.Printf("Warning: failed to terminate private spectrum channel %s on reset: %v", oldChannelName, err)
	}

	log.Printf("Spectrum session returned to shared channel: %s (SSRC: 0x%08x, subscribers: %d)",
		sessionID, sdc.ssrc, len(sdc.subscribers))
	return nil
}

// UpdateSpectrumSessionByUserID finds and updates the spectrum session for a given userSessionID
// This is used by KiwiSDR protocol to sync waterfall with audio frequency
// Returns true if a spectrum session was found and updated, false otherwise
func (sm *SessionManager) UpdateSpectrumSessionByUserID(userSessionID string, frequency uint64, binBandwidth float64) bool {
	return sm.UpdateSpectrumSessionByUserIDWithBinCount(userSessionID, frequency, binBandwidth, 0)
}

// UpdateSpectrumSessionByUserIDWithBinCount finds and updates the spectrum session for a given userSessionID
// with optional bin count adjustment (0 = don't change)
// This is used by KiwiSDR protocol to sync waterfall with audio frequency
// Returns true if a spectrum session was found and updated, false otherwise
func (sm *SessionManager) UpdateSpectrumSessionByUserIDWithBinCount(userSessionID string, frequency uint64, binBandwidth float64, binCount int) bool {
	if userSessionID == "" {
		log.Printf("DEBUG SESSION: UpdateSpectrumSessionByUserID called with empty userSessionID")
		return false
	}

	log.Printf("DEBUG SESSION: UpdateSpectrumSessionByUserID called: userSessionID=%s, freq=%d, binBW=%.2f, binCount=%d",
		userSessionID, frequency, binBandwidth, binCount)

	sm.mu.RLock()
	// Find the spectrum session for this userSessionID
	var spectrumSessionID string
	for _, session := range sm.sessions {
		if session.IsSpectrum {
			log.Printf("DEBUG SESSION: Found spectrum session: ID=%s, UserSessionID=%s, Freq=%d",
				session.ID, session.UserSessionID, session.Frequency)
		}
		if session.UserSessionID == userSessionID && session.IsSpectrum {
			spectrumSessionID = session.ID
			break
		}
	}
	sm.mu.RUnlock()

	log.Printf("DEBUG SESSION: Search complete: found_match=%v", spectrumSessionID != "")

	if spectrumSessionID == "" {
		log.Printf("DEBUG SESSION: No spectrum session found for userSessionID=%s", userSessionID)
		return false
	}

	log.Printf("DEBUG SESSION: Found spectrum session %s, updating to freq=%d, binBW=%.2f, binCount=%d",
		spectrumSessionID, frequency, binBandwidth, binCount)

	// Update the spectrum session
	err := sm.UpdateSpectrumSession(spectrumSessionID, frequency, binBandwidth, binCount)
	if err != nil {
		log.Printf("DEBUG SESSION: UpdateSpectrumSession failed: %v", err)
		return false
	}

	log.Printf("DEBUG SESSION: Successfully updated spectrum session %s", spectrumSessionID)
	return true
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

	// Validate frequency if provided - must not be below minimum
	const minFrequency = 10000 // 10 kHz minimum
	if frequency > 0 && frequency < minFrequency {
		return fmt.Errorf("invalid audio frequency %d Hz (must be >= %d Hz)", frequency, minFrequency)
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

	// Get current values after update for tracking
	currentFreq := session.Frequency
	currentMode := session.Mode
	session.mu.Unlock()

	// Track band change if frequency actually changed (compare old vs current, not parameter)
	if currentFreq != oldFreq {
		band := frequencyToBand(float64(currentFreq))
		if band != "" {
			// Track in per-session map
			session.bandsMu.Lock()
			if !session.VisitedBands[band] {
				session.VisitedBands[band] = true
			}
			session.bandsMu.Unlock()

			// Also track in UUID-level map (persists across audio/spectrum sessions)
			if session.UserSessionID != "" {
				sm.mu.Lock()
				if sm.userSessionBands[session.UserSessionID] == nil {
					sm.userSessionBands[session.UserSessionID] = make(map[string]bool)
				}
				if !sm.userSessionBands[session.UserSessionID][band] {
					sm.userSessionBands[session.UserSessionID][band] = true
				}
				sm.mu.Unlock()
			}
		}
	}

	// Track mode change if mode actually changed (compare old vs current, not parameter)
	// Don't track spectrum mode or invalid modes
	if currentMode != oldMode && currentMode != "spectrum" {
		// Track in per-session map
		session.modesMu.Lock()
		if !session.VisitedModes[currentMode] {
			session.VisitedModes[currentMode] = true
		}
		session.modesMu.Unlock()

		// Also track in UUID-level map (persists across audio/spectrum sessions)
		if session.UserSessionID != "" {
			sm.mu.Lock()
			if sm.userSessionModes[session.UserSessionID] == nil {
				sm.userSessionModes[session.UserSessionID] = make(map[string]bool)
			}
			if !sm.userSessionModes[session.UserSessionID][currentMode] {
				sm.userSessionModes[session.UserSessionID][currentMode] = true
			}
			sm.mu.Unlock()
		}
	}

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

	// Validate frequency if provided - must not be below minimum
	const minFrequency = 10000 // 10 kHz minimum
	if frequency > 0 && frequency < minFrequency {
		return fmt.Errorf("invalid audio frequency %d Hz (must be >= %d Hz)", frequency, minFrequency)
	}

	// Update session state only for parameters that changed
	session.mu.Lock()
	oldFreq := session.Frequency
	oldMode := session.Mode
	oldBandwidthLow := session.BandwidthLow
	oldBandwidthHigh := session.BandwidthHigh
	oldSampleRate := session.SampleRate

	if frequency > 0 {
		session.Frequency = frequency
	}
	if mode != "" {
		session.Mode = mode
		// Update sample rate when mode changes
		session.SampleRate = sm.config.Audio.GetSampleRateForMode(mode)
		// Update channels when mode changes (IQ modes=stereo, others=mono)
		if mode == "iq" || mode == "iq48" || mode == "iq96" || mode == "iq192" || mode == "iq384" {
			session.Channels = 2
		} else {
			session.Channels = 1
		}
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

	// Get current values after update for tracking
	currentFreq := session.Frequency
	currentMode := session.Mode
	session.mu.Unlock()

	// Track band change if frequency actually changed (compare old vs current, not parameter)
	if currentFreq != oldFreq {
		band := frequencyToBand(float64(currentFreq))
		if band != "" {
			// Track in per-session map
			session.bandsMu.Lock()
			if !session.VisitedBands[band] {
				session.VisitedBands[band] = true
			}
			session.bandsMu.Unlock()

			// Also track in UUID-level map (persists across audio/spectrum sessions)
			if session.UserSessionID != "" {
				sm.mu.Lock()
				if sm.userSessionBands[session.UserSessionID] == nil {
					sm.userSessionBands[session.UserSessionID] = make(map[string]bool)
				}
				if !sm.userSessionBands[session.UserSessionID][band] {
					sm.userSessionBands[session.UserSessionID][band] = true
				}
				sm.mu.Unlock()
			}
		}
	}

	// Track mode change if mode actually changed (compare old vs current, not parameter)
	// Don't track spectrum mode or invalid modes
	if currentMode != oldMode && currentMode != "spectrum" {
		// Track in per-session map
		session.modesMu.Lock()
		if !session.VisitedModes[currentMode] {
			session.VisitedModes[currentMode] = true
		}
		session.modesMu.Unlock()

		// Also track in UUID-level map (persists across audio/spectrum sessions)
		if session.UserSessionID != "" {
			sm.mu.Lock()
			if sm.userSessionModes[session.UserSessionID] == nil {
				sm.userSessionModes[session.UserSessionID] = make(map[string]bool)
			}
			if !sm.userSessionModes[session.UserSessionID][currentMode] {
				sm.userSessionModes[session.UserSessionID][currentMode] = true
			}
			sm.mu.Unlock()
		}
	}

	// Send update command to radiod with existing SSRC
	// radiod.UpdateChannel will handle the bandwidth edges
	if err := sm.radiod.UpdateChannel(session.SSRC, sendFreq, sendMode, bandwidthLow, bandwidthHigh, sendBandwidth); err != nil {
		// Rollback on error
		session.mu.Lock()
		session.Frequency = oldFreq
		session.Mode = oldMode
		session.BandwidthLow = oldBandwidthLow
		session.BandwidthHigh = oldBandwidthHigh
		session.SampleRate = oldSampleRate
		session.mu.Unlock()
		return fmt.Errorf("failed to update radiod channel: %w", err)
	}

	return nil
}

// UpdateSquelch updates only the squelch thresholds for an existing session
// squelchOpen and squelchClose are in dB SNR
func (sm *SessionManager) UpdateSquelch(sessionID string, squelchOpen, squelchClose float32) error {
	session, ok := sm.GetSession(sessionID)
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	if session.IsSpectrum {
		return fmt.Errorf("cannot update squelch on spectrum session")
	}

	// Update last active time
	session.mu.Lock()
	session.LastActive = time.Now()
	session.mu.Unlock()

	// Send squelch update command to radiod
	if err := sm.radiod.UpdateSquelch(session.SSRC, squelchOpen, squelchClose); err != nil {
		return fmt.Errorf("failed to update radiod squelch: %w", err)
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

	// Track if this UUID is being completely removed (for activity logging)
	// Check this BEFORE removing the session from the map
	uuidCompletelyGone := false
	if session.UserSessionID != "" {
		if count, exists := sm.userSessionUUIDs[session.UserSessionID]; exists {
			if count <= 1 {
				// This is the last session for this UUID
				uuidCompletelyGone = true
			}
		}
	}

	// Log session activity BEFORE removing from map and BEFORE cleanup
	// Only log if the UUID is completely gone (all sessions for this UUID destroyed)
	if sm.activityLogger != nil && uuidCompletelyGone {
		// Get copies of the UUID-level bands/modes maps BEFORE cleanup
		// We must do this while holding the lock to ensure data consistency
		var bandsCopy, modesCopy map[string]bool
		if bandsMap, exists := sm.userSessionBands[session.UserSessionID]; exists {
			bandsCopy = make(map[string]bool, len(bandsMap))
			for k, v := range bandsMap {
				bandsCopy[k] = v
			}
		} else {
			bandsCopy = make(map[string]bool)
		}

		if modesMap, exists := sm.userSessionModes[session.UserSessionID]; exists {
			modesCopy = make(map[string]bool, len(modesMap))
			for k, v := range modesMap {
				modesCopy[k] = v
			}
		} else {
			modesCopy = make(map[string]bool)
		}

		// Unlock before calling activity logger to avoid deadlock (it needs to read sessions)
		sm.mu.Unlock()
		if err := sm.activityLogger.LogSessionDestroyedWithData(session.UserSessionID, bandsCopy, modesCopy); err != nil {
			log.Printf("Warning: failed to log session destruction: %v", err)
		}
		// Re-lock to continue with cleanup
		sm.mu.Lock()
		// Re-check that session still exists (in case something changed while unlocked)
		session, ok = sm.sessions[sessionID]
		if !ok {
			sm.mu.Unlock()
			return fmt.Errorf("session was removed while logging activity")
		}
	}

	// Now remove the session from the map
	delete(sm.sessions, sessionID)
	// Shared subscribers are not in ssrcToSession; only remove private sessions.
	if !session.IsSharedSubscriber {
		delete(sm.ssrcToSession, session.SSRC)
	}
	// If this was a shared subscriber, remove it from the shared channel's subscriber map.
	// If it was the last subscriber, tear down the shared radiod channel.
	if session.IsSharedSubscriber {
		if sdc := sm.sharedDefaultChan; sdc != nil {
			sdc.mu.Lock()
			delete(sdc.subscribers, sessionID)
			remaining := len(sdc.subscribers)
			sdc.mu.Unlock()
			if sdc.active && remaining == 0 {
				// Last subscriber gone — mark inactive and schedule termination.
				// We capture the channel details before releasing sm.mu so the
				// TerminateChannel call (below, outside sm.mu) uses the right values.
				sdc.active = false
				delete(sm.ssrcToShared, sdc.ssrc)
				sm.sharedDefaultChan = nil
				log.Printf("Shared default spectrum channel will be terminated (last subscriber left): %s (SSRC: 0x%08x)",
					sdc.channelName, sdc.ssrc)
			}
		}
	}

	// Update UUID tracking
	if session.UserSessionID != "" {
		if count, exists := sm.userSessionUUIDs[session.UserSessionID]; exists {
			if count <= 1 {
				delete(sm.userSessionUUIDs, session.UserSessionID)
				// Clean up UUID-level bands/modes maps when UUID is completely gone
				delete(sm.userSessionBands, session.UserSessionID)
				delete(sm.userSessionModes, session.UserSessionID)
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

	sm.mu.Unlock()

	// Close WebSocket connection if present (forces immediate disconnect)
	if session.WSConn != nil {
		if wsConn, ok := session.WSConn.(interface{ close() error }); ok {
			if err := wsConn.close(); err != nil {
				log.Printf("Warning: failed to close WebSocket for session %s: %v", sessionID, err)
			}
		}
	}

	// Signal session is done
	if session.Done != nil {
		close(session.Done)
	}

	// Terminate radiod channel (set demod_type to -1 to properly clean up)
	// This immediately stops the demod thread and prevents orphaned channels at freq=0.
	// For shared subscribers we only terminate when the last subscriber has left
	// (detected above in the shared-channel cleanup block — sharedDefaultChan is nil
	// and active is false when we reach here in that case).
	if !session.IsSharedSubscriber {
		// Private channel — always terminate.
		if err := sm.radiod.TerminateChannel(session.ChannelName, session.SSRC); err != nil {
			log.Printf("Warning: failed to terminate private spectrum channel %s: %v", session.ChannelName, err)
		}
	} else {
		// Shared subscriber — only terminate if we just cleared the last subscriber
		// (sharedDefaultChan was set to nil above in that case).
		// We detect this by checking whether the SSRC is still in ssrcToShared.
		sm.mu.RLock()
		_, stillActive := sm.ssrcToShared[session.SSRC]
		sm.mu.RUnlock()
		if !stillActive {
			// We were the last subscriber; terminate the shared radiod channel.
			if err := sm.radiod.TerminateChannel(session.ChannelName, session.SSRC); err != nil {
				log.Printf("Warning: failed to terminate shared spectrum channel %s: %v", session.ChannelName, err)
			}
		}
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

	userID := session.UserSessionID
	if len(userID) > 8 {
		userID = userID[:8]
	}
	channelKind := "private"
	if session.IsSharedSubscriber {
		channelKind = "shared"
	}
	log.Printf("Session destroyed: %s (channel: %s [%s], SSRC: 0x%08x, user: %s)",
		sessionID, session.ChannelName, channelKind, session.SSRC, userID)

	return nil
}

// cleanupLoop periodically checks for and removes inactive sessions, expired kicked UUIDs, and orphaned User-Agent entries
func (sm *SessionManager) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		sm.cleanupInactiveSessions()
		sm.cleanupExpiredKickedUUIDs()
		sm.cleanupOrphanedUserAgents()
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

		// Check if any session with this UUID has a bypassed IP or password
		bypassed := false
		for _, session := range sm.sessions {
			if session.UserSessionID == userSessionID {
				if sm.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) {
					bypassed = true
					break
				}
			}
		}
		if bypassed {
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

// cleanupOrphanedUserAgents removes User-Agent entries for UUIDs that haven't had an active session for 5 minutes.
// It also removes rDNS cache entries for IPs that no longer have any active sessions.
func (sm *SessionManager) cleanupOrphanedUserAgents() {
	const orphanTimeout = 5 * time.Minute
	now := time.Now()

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Build set of UUIDs and active client IPs with active sessions
	activeUUIDs := make(map[string]bool)
	activeIPs := make(map[string]bool)
	for _, session := range sm.sessions {
		if session.UserSessionID != "" {
			activeUUIDs[session.UserSessionID] = true
			// Update last seen time for active sessions
			sm.userAgentLastSeen[session.UserSessionID] = now
		}
		if session.ClientIP != "" {
			activeIPs[session.ClientIP] = true
		}
	}

	// Find orphaned User-Agent entries (no active session and last seen > 5 minutes ago)
	var toRemove []string
	for uuid := range sm.userAgents {
		if !activeUUIDs[uuid] {
			// No active session for this UUID
			lastSeen, exists := sm.userAgentLastSeen[uuid]
			if !exists || now.Sub(lastSeen) > orphanTimeout {
				toRemove = append(toRemove, uuid)
			}
		}
	}

	// Remove orphaned User-Agent entries
	if len(toRemove) > 0 {
		for _, uuid := range toRemove {
			delete(sm.userAgents, uuid)
			delete(sm.userAgentLastSeen, uuid)
			delete(sm.uuidToIP, uuid)
		}
	}

	// Remove rDNS cache entries for IPs with no active sessions.
	// Use a separate write lock so we don't hold both sm.mu and rdnsMu simultaneously.
	sm.mu.Unlock()
	sm.rdnsMu.Lock()
	for ip := range sm.rdnsCache {
		if !activeIPs[ip] {
			delete(sm.rdnsCache, ip)
			delete(sm.rdnsResolved, ip)
		}
	}
	sm.rdnsMu.Unlock()
	sm.mu.Lock() // re-acquire so the deferred Unlock() is balanced
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
	// Track which UUIDs have inactive sessions and their types
	inactiveUUIDs := make(map[string]bool)
	bypassedUUIDs := make(map[string]bool)
	uuidSessionTypes := make(map[string]map[string]bool) // UUID -> set of session types (audio/spectrum)

	for _, session := range sm.sessions {
		session.mu.RLock()
		inactive := now.Sub(session.LastActive)
		userSessionID := session.UserSessionID
		clientIP := session.ClientIP
		bypassPassword := session.BypassPassword
		isSpectrum := session.IsSpectrum
		mode := session.Mode
		session.mu.RUnlock()

		if userSessionID != "" {
			// Check if this session's IP or password is bypassed
			if sm.config.Server.IsIPTimeoutBypassed(clientIP, bypassPassword) {
				bypassedUUIDs[userSessionID] = true
			}

			// Skip IQ mode sessions - they are only subject to max_session_time, not inactivity timeout
			isIQMode := mode == "iq" || mode == "iq48" || mode == "iq96" || mode == "iq192" || mode == "iq384"
			if isIQMode {
				continue
			}

			if inactive > sm.timeout {
				inactiveUUIDs[userSessionID] = true
				// Track session types for this UUID
				if uuidSessionTypes[userSessionID] == nil {
					uuidSessionTypes[userSessionID] = make(map[string]bool)
				}
				if isSpectrum {
					uuidSessionTypes[userSessionID]["spectrum"] = true
				} else {
					uuidSessionTypes[userSessionID]["audio"] = true
				}
			}
		}
	}
	sm.mu.RUnlock()

	// Collect UUIDs to kick (only kick each UUID once, excluding bypassed ones)
	for uuid := range inactiveUUIDs {
		if !bypassedUUIDs[uuid] {
			toKick = append(toKick, uuid)
		}
	}

	// Kick users that exceeded the inactivity timeout and record metrics
	for _, userSessionID := range toKick {
		log.Printf("Session timeout reached for user %s (inactive for %v) - kicking",
			userSessionID, sm.timeout)

		// Determine session type for metrics
		sessionTypes := uuidSessionTypes[userSessionID]
		var metricType string
		if sessionTypes["audio"] && sessionTypes["spectrum"] {
			metricType = "mixed"
		} else if sessionTypes["spectrum"] {
			metricType = "spectrum"
		} else {
			metricType = "audio"
		}

		// Record idle timeout kick in Prometheus
		if sm.prometheusMetrics != nil {
			sm.prometheusMetrics.RecordIdleTimeoutKick(metricType)
		}

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

// GetNonBypassedUserCount returns the current number of unique non-bypassed users
// This counts users whose IPs are not in the timeout bypass list AND who did not
// authenticate with a bypass password.
func (sm *SessionManager) GetNonBypassedUserCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	// Track which UUIDs have at least one non-bypassed session
	nonBypassedUUIDs := make(map[string]bool)

	for _, session := range sm.sessions {
		if session.UserSessionID != "" {
			// Check if this session's IP or bypass password grants bypass status
			if !sm.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) {
				nonBypassedUUIDs[session.UserSessionID] = true
			}
		}
	}

	return len(nonBypassedUUIDs)
}

// canAcceptNewUUIDLocked checks if a new UUID can be accepted without exceeding max_sessions.
// Only non-bypassed users count toward the limit — bypassed users (by IP or password)
// are admitted freely and must not consume slots that block regular users.
// Returns true if the UUID already exists OR if there's room for a new non-bypassed UUID.
// MUST be called with sm.mu held (read or write lock).
func (sm *SessionManager) canAcceptNewUUIDLocked(userSessionID string) bool {
	// If this UUID already has sessions, it's always allowed
	if _, exists := sm.userSessionUUIDs[userSessionID]; exists {
		return true
	}

	// Count only non-bypassed unique users toward the limit.
	// Bypassed users (IP list or password) are exempt and must not block regular users.
	nonBypassedCount := 0
	seen := make(map[string]bool)
	for _, session := range sm.sessions {
		if session.UserSessionID == "" || seen[session.UserSessionID] {
			continue
		}
		if !sm.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) {
			nonBypassedCount++
			seen[session.UserSessionID] = true
		}
	}

	return nonBypassedCount < sm.config.Server.MaxSessions
}

// CanAcceptNewUUID checks if a new UUID can be accepted without exceeding max_sessions.
// Only non-bypassed users count toward the limit — bypassed users (by IP or password)
// are admitted freely and must not consume slots that block regular users.
// Returns true if the UUID already exists OR if there's room for a new non-bypassed UUID.
func (sm *SessionManager) CanAcceptNewUUID(userSessionID string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.canAcceptNewUUIDLocked(userSessionID)
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

// SetUserAgent stores the User-Agent string for a user_session_id and updates last seen time
func (sm *SessionManager) SetUserAgent(userSessionID, userAgent string) {
	if userSessionID == "" {
		return
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.userAgents[userSessionID] = userAgent
	sm.userAgentLastSeen[userSessionID] = time.Now()
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

// SetUUIDIP binds a UUID to an IP address (overwrites existing binding)
func (sm *SessionManager) SetUUIDIP(userSessionID, clientIP string) {
	if userSessionID == "" || clientIP == "" {
		return
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.uuidToIP[userSessionID] = clientIP
}

// GetUUIDIP retrieves the bound IP for a UUID
func (sm *SessionManager) GetUUIDIP(userSessionID string) string {
	if userSessionID == "" {
		return ""
	}

	sm.mu.RLock()
	defer sm.mu.RUnlock()

	return sm.uuidToIP[userSessionID]
}

// PrefetchReverseDNS starts an async reverse DNS lookup for the given clientIP if one
// has not already been started. It is safe to call multiple times for the same IP —
// only the first call triggers a goroutine. The lookup is capped at 3 seconds to
// prevent a build-up of slow goroutines when many clients connect simultaneously.
func (sm *SessionManager) PrefetchReverseDNS(clientIP string) {
	if clientIP == "" {
		return
	}

	// Check under read lock first (fast path — already resolved or in progress)
	sm.rdnsMu.RLock()
	_, alreadyResolved := sm.rdnsResolved[clientIP]
	sm.rdnsMu.RUnlock()

	if alreadyResolved {
		return // Lookup already done or in progress for this IP
	}

	// Mark as in-progress under write lock before spawning goroutine,
	// so concurrent calls for the same IP don't each spawn their own goroutine.
	sm.rdnsMu.Lock()
	if _, alreadyResolved = sm.rdnsResolved[clientIP]; alreadyResolved {
		sm.rdnsMu.Unlock()
		return
	}
	// Mark resolved=false now to block further goroutines; will be set true when done.
	sm.rdnsResolved[clientIP] = false
	sm.rdnsMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		r := &net.Resolver{}
		addrs, err := r.LookupAddr(ctx, clientIP)

		hostname := ""
		if err == nil && len(addrs) > 0 {
			// PTR records conventionally end with a trailing dot — strip it
			hostname = strings.TrimSuffix(addrs[0], ".")
		}

		sm.rdnsMu.Lock()
		sm.rdnsCache[clientIP] = hostname
		sm.rdnsResolved[clientIP] = true
		sm.rdnsMu.Unlock()

		if hostname != "" {
			log.Printf("rDNS: %s -> %s", clientIP, hostname)
		}
	}()
}

// GetReverseDNS returns the reverse DNS hostname for a clientIP.
// resolved=false means the lookup is still in progress (or was never started).
// resolved=true, hostname="" means the lookup completed but no PTR record was found.
// resolved=true, hostname!="" means a PTR record was found.
func (sm *SessionManager) GetReverseDNS(clientIP string) (hostname string, resolved bool) {
	if clientIP == "" {
		return "", false
	}

	sm.rdnsMu.RLock()
	defer sm.rdnsMu.RUnlock()

	resolved, exists := sm.rdnsResolved[clientIP]
	if !exists {
		return "", false
	}
	return sm.rdnsCache[clientIP], resolved
}

// AddAudioBytes atomically adds to the audio byte counter and updates sliding window
func (s *Session) AddAudioBytes(bytes uint64) {
	s.mu.Lock()
	s.AudioBytesSent += bytes

	// Add sample to sliding window
	now := time.Now()
	s.audioSamples = append(s.audioSamples, BytesSample{
		Timestamp: now,
		Bytes:     s.AudioBytesSent,
	})

	// Remove samples older than 1 second
	cutoff := now.Add(-1 * time.Second)
	for len(s.audioSamples) > 0 && s.audioSamples[0].Timestamp.Before(cutoff) {
		s.audioSamples = s.audioSamples[1:]
	}

	s.mu.Unlock()
}

// AddWaterfallBytes atomically adds to the waterfall byte counter and updates sliding window
func (s *Session) AddWaterfallBytes(bytes uint64) {
	s.mu.Lock()
	s.WaterfallBytesSent += bytes

	// Add sample to sliding window
	now := time.Now()
	s.waterfallSamples = append(s.waterfallSamples, BytesSample{
		Timestamp: now,
		Bytes:     s.WaterfallBytesSent,
	})

	// Remove samples older than 1 second
	cutoff := now.Add(-1 * time.Second)
	for len(s.waterfallSamples) > 0 && s.waterfallSamples[0].Timestamp.Before(cutoff) {
		s.waterfallSamples = s.waterfallSamples[1:]
	}

	s.mu.Unlock()
}

// GetAudioBytesPerSecond returns the current audio transfer rate in bytes/second
// including 33% overhead for protocol headers (WebSocket + TCP/IP)
func (s *Session) GetAudioBytesPerSecond() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	elapsed := time.Since(s.CreatedAt).Seconds()
	if elapsed == 0 {
		return 0
	}
	return float64(s.AudioBytesSent) / elapsed * 1.33
}

// GetAudioBytesPerHour returns the average audio transfer rate in bytes/hour
// including 33% overhead for protocol headers (WebSocket + TCP/IP)
func (s *Session) GetAudioBytesPerHour() float64 {
	return s.GetAudioBytesPerSecond() * 3600
}

// GetWaterfallBytesPerSecond returns the current waterfall transfer rate in bytes/second
// including 33% overhead for protocol headers (WebSocket + TCP/IP)
func (s *Session) GetWaterfallBytesPerSecond() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	elapsed := time.Since(s.CreatedAt).Seconds()
	if elapsed == 0 {
		return 0
	}
	return float64(s.WaterfallBytesSent) / elapsed * 1.33
}

// GetTotalBytesPerSecond returns the total transfer rate (audio + waterfall) in bytes/second
// including 33% overhead for protocol headers (WebSocket + TCP/IP)
func (s *Session) GetTotalBytesPerSecond() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	elapsed := time.Since(s.CreatedAt).Seconds()
	if elapsed == 0 {
		return 0
	}
	return float64(s.AudioBytesSent+s.WaterfallBytesSent) / elapsed * 1.33
}

// GetInstantaneousAudioKbps returns the instantaneous audio transfer rate in kbps
// using a 1-second sliding window, including 33% overhead for protocol headers
// (WebSocket framing, TCP/IP headers, etc.)
func (s *Session) GetInstantaneousAudioKbps() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.audioSamples) < 2 {
		return 0
	}

	// Get oldest and newest samples in the window
	oldest := s.audioSamples[0]
	newest := s.audioSamples[len(s.audioSamples)-1]

	// Calculate time difference
	duration := newest.Timestamp.Sub(oldest.Timestamp).Seconds()
	if duration == 0 {
		return 0
	}

	// Calculate bytes transferred in this window
	bytesDiff := newest.Bytes - oldest.Bytes

	// Convert to kbps (bytes/sec * 8 bits/byte / 1000)
	// Add 33% for protocol overhead (WebSocket + TCP/IP headers)
	payloadKbps := float64(bytesDiff) / duration * 8 / 1000
	return payloadKbps * 1.33
}

// GetInstantaneousWaterfallKbps returns the instantaneous waterfall transfer rate in kbps
// using a 1-second sliding window, including 33% overhead for protocol headers
// (WebSocket framing, TCP/IP headers, etc.)
func (s *Session) GetInstantaneousWaterfallKbps() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.waterfallSamples) < 2 {
		return 0
	}

	// Get oldest and newest samples in the window
	oldest := s.waterfallSamples[0]
	newest := s.waterfallSamples[len(s.waterfallSamples)-1]

	// Calculate time difference
	duration := newest.Timestamp.Sub(oldest.Timestamp).Seconds()
	if duration == 0 {
		return 0
	}

	// Calculate bytes transferred in this window
	bytesDiff := newest.Bytes - oldest.Bytes

	// Convert to kbps (bytes/sec * 8 bits/byte / 1000)
	// Add 33% for protocol overhead (WebSocket + TCP/IP headers)
	payloadKbps := float64(bytesDiff) / duration * 8 / 1000
	return payloadKbps * 1.33
}

// GetInstantaneousTotalKbps returns the total instantaneous transfer rate in kbps
// using a 1-second sliding window
func (s *Session) GetInstantaneousTotalKbps() float64 {
	return s.GetInstantaneousAudioKbps() + s.GetInstantaneousWaterfallKbps()
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
		"channels":    s.Channels,
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

	// Find the wideband session ID first (pattern: "noisefloor-wideband-XXXXXXXX")
	widebandSessionID := ""
	for id := range sm.sessions {
		if len(id) >= 19 && id[:19] == "noisefloor-wideband" {
			widebandSessionID = id
			break
		}
	}

	sessions := make([]map[string]interface{}, 0, len(sm.sessions))
	for _, session := range sm.sessions {
		session.mu.RLock()

		// Check if this is an internal session (no client IP = internal system session)
		isInternal := session.ClientIP == ""

		// Determine authentication method
		authMethod := ""
		isBypassed := false
		if session.BypassPassword != "" {
			// Session has a password stored, check if it's valid
			if sm.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) {
				authMethod = "password"
				isBypassed = true
			}
		} else if sm.config.Server.IsIPTimeoutBypassed(session.ClientIP) {
			// No password, but IP is in bypass list
			authMethod = "ip_bypass"
			isBypassed = true
		}

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
			"is_bypassed":     isBypassed,
			"is_internal":     isInternal,
			"auth_method":     authMethod,
			"country":         session.Country,
			"country_code":    session.CountryCode,
		}

		// If the source IP is a known trusted container, include its name so the
		// admin UI can display "via caddy" instead of "via 172.20.0.10".
		if session.SourceIP != "" && session.SourceIP != session.ClientIP {
			if name := sm.config.Server.GetContainerName(session.SourceIP); name != "" {
				info["source_name"] = name
			}
		}

		// Add type-specific info
		if session.IsSpectrum {
			info["bin_count"] = session.BinCount
			info["bin_bandwidth"] = session.BinBandwidth
		} else {
			info["sample_rate"] = session.SampleRate
			info["channels"] = session.Channels
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

		// Add reverse DNS only when lookup has completed AND a PTR record was found.
		// Omit the field entirely while pending or when no PTR record exists.
		if session.ClientIP != "" {
			if hostname, resolved := sm.GetReverseDNS(session.ClientIP); resolved && hostname != "" {
				info["reverse_dns"] = hostname
			}
		}

		// Add throughput metrics (both average and instantaneous)
		// Calculate while we already have the session lock to avoid deadlock
		// Average throughput (since session start) - rounded to whole numbers
		// Includes 33% overhead for protocol headers (WebSocket + TCP/IP)
		elapsed := time.Since(session.CreatedAt).Seconds()
		var audioKbpsAvg, waterfallKbpsAvg, totalKbpsAvg int
		if elapsed > 0 {
			audioKbpsAvg = int(float64(session.AudioBytesSent) / elapsed * 8 / 1000 * 1.33)
			waterfallKbpsAvg = int(float64(session.WaterfallBytesSent) / elapsed * 8 / 1000 * 1.33)
			totalKbpsAvg = int(float64(session.AudioBytesSent+session.WaterfallBytesSent) / elapsed * 8 / 1000 * 1.33)
		}

		info["audio_kbps_avg"] = audioKbpsAvg
		info["waterfall_kbps_avg"] = waterfallKbpsAvg
		info["total_kbps_avg"] = totalKbpsAvg

		// Instantaneous throughput (1-second sliding window) - rounded to whole numbers
		// Includes 33% overhead for protocol headers (WebSocket + TCP/IP)
		var audioKbps, waterfallKbps int

		// Calculate audio instantaneous throughput
		if len(session.audioSamples) >= 2 {
			oldest := session.audioSamples[0]
			newest := session.audioSamples[len(session.audioSamples)-1]
			duration := newest.Timestamp.Sub(oldest.Timestamp).Seconds()
			if duration > 0 {
				bytesDiff := newest.Bytes - oldest.Bytes
				audioKbps = int(float64(bytesDiff) / duration * 8 / 1000 * 1.33)
			}
		}

		// Calculate waterfall instantaneous throughput
		if len(session.waterfallSamples) >= 2 {
			oldest := session.waterfallSamples[0]
			newest := session.waterfallSamples[len(session.waterfallSamples)-1]
			duration := newest.Timestamp.Sub(oldest.Timestamp).Seconds()
			if duration > 0 {
				bytesDiff := newest.Bytes - oldest.Bytes
				waterfallKbps = int(float64(bytesDiff) / duration * 8 / 1000 * 1.33)
			}
		}

		info["audio_kbps"] = audioKbps
		info["waterfall_kbps"] = waterfallKbps
		info["total_kbps"] = audioKbps + waterfallKbps

		// Add DX cluster connection status and throughput if handler is available and user has a session ID
		if session.UserSessionID != "" && sm.dxClusterWsHandler != nil {
			// Type assert to get the handler (using interface to avoid import cycle)
			if handler, ok := sm.dxClusterWsHandler.(interface {
				HasDXConnection(string) bool
				GetInstantaneousDXKbps(string) float64
			}); ok {
				// Check if user has an active DX cluster connection
				if handler.HasDXConnection(session.UserSessionID) {
					// User is connected - show throughput as whole number (0 if idle, >0 if active)
					dxKbps := handler.GetInstantaneousDXKbps(session.UserSessionID)
					info["dxcluster_kbps"] = int(dxKbps)
				}
			}
		}

		// Only include frontend_status for the wideband spectrum channel
		// All other sessions will get frontend status from a separate API endpoint
		// This avoids duplicating the same frontend data across all sessions
		if session.ID == widebandSessionID {
			if frontendStatus := sm.radiod.GetFrontendStatus(session.SSRC); frontendStatus != nil {
				// Helper function to sanitize float values for JSON (replace Inf/NaN with nil)
				sanitizeFloat := func(f float32) interface{} {
					if math.IsInf(float64(f), 0) || math.IsNaN(float64(f)) {
						return nil
					}
					return f
				}

				info["frontend_status"] = map[string]interface{}{
					"lna_gain":           frontendStatus.LNAGain,
					"mixer_gain":         frontendStatus.MixerGain,
					"if_gain":            frontendStatus.IFGain,
					"rf_gain":            sanitizeFloat(frontendStatus.RFGain),
					"rf_atten":           sanitizeFloat(frontendStatus.RFAtten),
					"rf_agc":             frontendStatus.RFAGC,
					"if_power":           sanitizeFloat(frontendStatus.IFPower),
					"ad_overranges":      frontendStatus.ADOverranges,
					"samples_since_over": frontendStatus.SamplesSinceOver,
					"last_update":        frontendStatus.LastUpdate.Format(time.RFC3339),
				}
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

	// Stop activity logger if enabled
	if sm.activityLogger != nil {
		sm.activityLogger.Stop()
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

// KickUsersByCountry destroys all sessions from the given country code
func (sm *SessionManager) KickUsersByCountry(countryCode string, geoIPService *GeoIPService) (int, error) {
	if countryCode == "" {
		return 0, fmt.Errorf("country code cannot be empty")
	}

	if geoIPService == nil || !geoIPService.IsEnabled() {
		return 0, fmt.Errorf("GeoIP service not available")
	}

	// Convert to uppercase for consistency
	countryCode = strings.ToUpper(countryCode)

	sm.mu.RLock()
	var sessionsToKick []string
	for _, session := range sm.sessions {
		session.mu.RLock()
		clientIP := session.ClientIP
		session.mu.RUnlock()

		// Skip sessions without a client IP
		if clientIP == "" {
			continue
		}

		// Look up the country for this IP
		_, sessionCountryCode := geoIPService.LookupSafe(clientIP)
		if sessionCountryCode == countryCode {
			sessionsToKick = append(sessionsToKick, session.ID)
		}
	}
	sm.mu.RUnlock()

	// Destroy all matching sessions
	for _, sessionID := range sessionsToKick {
		if err := sm.DestroySession(sessionID); err != nil {
			log.Printf("Error kicking session %s: %v", sessionID, err)
		}
	}

	log.Printf("Kicked users from country %s (%d session(s) destroyed)", countryCode, len(sessionsToKick))
	return len(sessionsToKick), nil
}

// GetSampleRate returns the session's sample rate
func (s *Session) GetSampleRate() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.SampleRate
}

// AttachAudioExtensionTap attaches an audio extension tap to this session
// The tap receives a copy of all PCM audio with timestamps sent to the user
func (s *Session) AttachAudioExtensionTap(audioChan chan AudioSample) {
	s.audioExtensionMu.Lock()
	s.audioExtensionChan = audioChan
	s.audioExtensionMu.Unlock()
}

// DetachAudioExtensionTap removes the audio extension tap from this session
func (s *Session) DetachAudioExtensionTap() {
	s.audioExtensionMu.Lock()
	s.audioExtensionChan = nil
	s.audioExtensionMu.Unlock()
}

// HasAudioExtension returns true if an audio extension tap is currently attached.
// Use this to avoid expensive allocations (e.g. int16 conversion) when no extension is running.
func (s *Session) HasAudioExtension() bool {
	s.audioExtensionMu.RLock()
	has := s.audioExtensionChan != nil
	s.audioExtensionMu.RUnlock()
	return has
}

// SendAudioToExtension sends PCM audio with timestamps to the attached extension (if any)
// This should be called from the audio receiver when sending audio to the user
func (s *Session) SendAudioToExtension(audioSample AudioSample) {
	s.audioExtensionMu.RLock()
	extensionChan := s.audioExtensionChan
	s.audioExtensionMu.RUnlock()

	if extensionChan != nil {
		select {
		case extensionChan <- audioSample:
		default:
			// Drop if extension can't keep up (non-blocking)
		}
	}
}

// cleanupOrphanedChannels periodically disables radiod channels that don't have corresponding sessions
// This prevents orphaned channels from accumulating when sessions are closed but radiod hasn't cleaned them up yet
func (sm *SessionManager) cleanupOrphanedChannels() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		// Use shared logic to find unknown channels (pass nil for multiDecoder since we don't have access to it)
		// The session map already includes decoder sessions, so this is safe
		orphanedSSRCs := getUnknownChannelSSRCs(sm, nil)

		if len(orphanedSSRCs) == 0 {
			continue
		}

		// Disable each orphaned channel (silently - we log in bulk below)
		for _, ssrc := range orphanedSSRCs {
			if err := sm.radiod.DisableChannelSilent("orphaned", ssrc); err != nil {
				log.Printf("Failed to disable orphaned channel 0x%08x: %v", ssrc, err)
			}
		}

		// Log all orphaned channels that were closed (single line)
		ssrcStrings := make([]string, len(orphanedSSRCs))
		for i, ssrc := range orphanedSSRCs {
			ssrcStrings[i] = fmt.Sprintf("0x%08x", ssrc)
		}
		log.Printf("Cleaned up %d orphaned radiod channel(s): %s", len(orphanedSSRCs), strings.Join(ssrcStrings, ", "))
	}
}
