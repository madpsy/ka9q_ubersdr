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
	SSRC          uint32      // Unique SSRC for this session's radiod channel
	Frequency     uint64
	Mode          string
	Bandwidth     int         // Bandwidth in Hz (for USB/LSB modes) - DEPRECATED, use BandwidthLow/High
	BandwidthLow  int         // Low edge of filter in Hz (can be negative)
	BandwidthHigh int         // High edge of filter in Hz
	SampleRate    int
	CreatedAt     time.Time
	LastActive    time.Time
	AudioChan     chan []byte
	Done          chan struct{}
	mu            sync.RWMutex
	
	// Spectrum-specific fields (only used when Mode == "spectrum")
	IsSpectrum   bool
	BinCount     int
	BinBandwidth float64
	SpectrumChan chan []float32 // Channel for spectrum data
}

// SessionManager manages all active sessions
type SessionManager struct {
	sessions      map[string]*Session
	ssrcToSession map[uint32]*Session // Map SSRC to session for audio routing
	mu            sync.RWMutex
	config        *Config
	radiod        *RadiodController
	maxSessions   int
	timeout       time.Duration
}

// NewSessionManager creates a new session manager
func NewSessionManager(config *Config, radiod *RadiodController) *SessionManager {
	sm := &SessionManager{
		sessions:      make(map[string]*Session),
		ssrcToSession: make(map[uint32]*Session),
		config:        config,
		radiod:        radiod,
		maxSessions:   config.Server.MaxSessions,
		timeout:       time.Duration(config.Server.SessionTimeout) * time.Second,
	}
	
	// Start cleanup goroutine
	go sm.cleanupLoop()
	
	return sm
}

// CreateSession creates a new session with a unique channel (default bandwidth)
func (sm *SessionManager) CreateSession(frequency uint64, mode string) (*Session, error) {
	return sm.CreateSessionWithBandwidth(frequency, mode, 3000) // Default 3000 Hz bandwidth
}

// CreateSessionWithBandwidth creates a new session with a unique channel and specified bandwidth
func (sm *SessionManager) CreateSessionWithBandwidth(frequency uint64, mode string, bandwidth int) (*Session, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Check session limit
	if len(sm.sessions) >= sm.maxSessions {
		return nil, fmt.Errorf("maximum sessions reached (%d)", sm.maxSessions)
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
	}

	// Create radiod channel with unique random SSRC and bandwidth
	if err := sm.radiod.CreateChannelWithBandwidth(channelName, frequency, mode, sampleRate, ssrc, bandwidth); err != nil {
		return nil, fmt.Errorf("failed to create radiod channel: %w", err)
	}

	sm.sessions[sessionID] = session
	sm.ssrcToSession[ssrc] = session
	
	if DebugMode {
		log.Printf("DEBUG: Session registered in ssrcToSession map: SSRC 0x%08x -> Session %s", ssrc, sessionID)
		log.Printf("DEBUG: Total sessions: %d, Total SSRC mappings: %d", len(sm.sessions), len(sm.ssrcToSession))
	}
	
	log.Printf("Session created: %s (channel: %s, SSRC: 0x%08x, freq: %d Hz, mode: %s, bandwidth: %d Hz)",
		sessionID, channelName, ssrc, frequency, mode, bandwidth)

	return session, nil
}

// CreateSpectrumSession creates a new spectrum session with default parameters
// Users can only adjust frequency (pan) and bin_bw (zoom), bin_count is fixed
func (sm *SessionManager) CreateSpectrumSession() (*Session, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Check session limit
	if len(sm.sessions) >= sm.maxSessions {
		return nil, fmt.Errorf("maximum sessions reached (%d)", sm.maxSessions)
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
		ID:           sessionID,
		ChannelName:  channelName,
		SSRC:         ssrc,
		Frequency:    frequency,
		Mode:         "spectrum",
		IsSpectrum:   true,
		BinCount:     binCount,
		BinBandwidth: binBandwidth,
		CreatedAt:    time.Now(),
		LastActive:   time.Now(),
		SpectrumChan: make(chan []float32, 10), // Buffer spectrum updates
		Done:         make(chan struct{}),
	}

	// Create radiod spectrum channel
	if err := sm.radiod.CreateSpectrumChannel(channelName, frequency, binCount, binBandwidth, ssrc); err != nil {
		return nil, fmt.Errorf("failed to create radiod spectrum channel: %w", err)
	}

	sm.sessions[sessionID] = session
	sm.ssrcToSession[ssrc] = session
	
	log.Printf("Spectrum session created: %s (SSRC: 0x%08x, freq: %d Hz, bins: %d, bw: %.1f Hz)",
		sessionID, ssrc, frequency, binCount, binBandwidth)

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
	// Don't send mode if empty - this avoids triggering preset reload
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
	// Don't send mode if empty - this avoids triggering preset reload
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
	
	if DebugMode {
		log.Printf("DEBUG: Session removed from ssrcToSession map: SSRC 0x%08x", session.SSRC)
		log.Printf("DEBUG: Remaining sessions: %d, Remaining SSRC mappings: %d", len(sm.sessions), len(sm.ssrcToSession))
	}
	sm.mu.Unlock()

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

// cleanupLoop periodically checks for and removes inactive sessions
func (sm *SessionManager) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		sm.cleanupInactiveSessions()
	}
}

// cleanupInactiveSessions removes sessions that have exceeded the timeout
func (sm *SessionManager) cleanupInactiveSessions() {
	if sm.timeout == 0 {
		return // No timeout configured
	}

	now := time.Now()
	var toRemove []string

	sm.mu.RLock()
	for id, session := range sm.sessions {
		session.mu.RLock()
		inactive := now.Sub(session.LastActive)
		session.mu.RUnlock()

		if inactive > sm.timeout {
			toRemove = append(toRemove, id)
		}
	}
	sm.mu.RUnlock()

	// Remove inactive sessions
	for _, id := range toRemove {
		log.Printf("Cleaning up inactive session: %s", id)
		if err := sm.DestroySession(id); err != nil {
			log.Printf("Error cleaning up session %s: %v", id, err)
		}
	}
}

// GetSessionCount returns the current number of active sessions
func (sm *SessionManager) GetSessionCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.sessions)
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