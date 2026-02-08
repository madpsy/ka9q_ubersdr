package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// AudioExtensionManager manages streaming audio extensions for user sessions
type AudioExtensionManager struct {
	// Active extensions per session (one per user)
	activeExtensions   map[string]*ActiveAudioExtension
	activeExtensionsMu sync.RWMutex

	// Reference to websocket handler for sending messages
	wsHandler *DXClusterWebSocketHandler

	// Reference to session manager for audio tap
	sessionManager *SessionManager

	// Extension registry
	registry *AudioExtensionRegistry
}

// ActiveAudioExtension represents a running audio extension instance for a user
type ActiveAudioExtension struct {
	SessionID     string
	ExtensionName string
	Extension     AudioExtension
	AudioChan     chan []int16
	ResultChan    chan []byte
	StopChan      chan struct{}
	Conn          *websocket.Conn
	ConnMu        sync.Mutex
	Running       bool
	StartedAt     time.Time
}

// NewAudioExtensionManager creates a new audio extension manager
func NewAudioExtensionManager(wsHandler *DXClusterWebSocketHandler, sessionManager *SessionManager, registry *AudioExtensionRegistry) *AudioExtensionManager {
	return &AudioExtensionManager{
		activeExtensions: make(map[string]*ActiveAudioExtension),
		wsHandler:        wsHandler,
		sessionManager:   sessionManager,
		registry:         registry,
	}
}

// HandleExtensionMessage processes audio extension control messages from clients
func (aem *AudioExtensionManager) HandleExtensionMessage(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	msgType, ok := msg["type"].(string)
	if !ok {
		return fmt.Errorf("invalid message type")
	}

	switch msgType {
	case "audio_extension_attach":
		return aem.handleAttach(sessionID, conn, msg)

	case "audio_extension_detach":
		return aem.handleDetach(sessionID, conn)

	case "audio_extension_status":
		return aem.handleStatus(sessionID, conn)

	case "audio_extension_list":
		return aem.handleList(sessionID, conn)

	default:
		return fmt.Errorf("unknown audio extension message type: %s", msgType)
	}
}

// handleAttach attaches an audio extension to the user's audio stream
func (aem *AudioExtensionManager) handleAttach(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	// Extract extension name
	extensionName, ok := msg["extension_name"].(string)
	if !ok || extensionName == "" {
		log.Printf("AudioExtension: Attach failed for session %s - extension_name is required", sessionID)
		return aem.sendError(conn, "extension_name is required")
	}

	// Extract optional extension-specific parameters
	extensionParams := make(map[string]interface{})
	if params, ok := msg["params"].(map[string]interface{}); ok {
		extensionParams = params
	}

	log.Printf("AudioExtension: Attach request - User: %s, Extension: %s, Params: %+v", sessionID, extensionName, extensionParams)

	// Tear down existing extension if any (user can only have one at a time)
	aem.activeExtensionsMu.Lock()
	if existing, exists := aem.activeExtensions[sessionID]; exists {
		log.Printf("AudioExtension: Tearing down existing extension '%s' for user %s (replacing with '%s')",
			existing.ExtensionName, sessionID, extensionName)
		aem.activeExtensionsMu.Unlock()
		aem.stopExtension(existing)
		aem.activeExtensionsMu.Lock()
	}
	aem.activeExtensionsMu.Unlock()

	// Find user's audio session by UserSessionID
	session := aem.findAudioSessionByUserID(sessionID)
	if session == nil {
		return aem.sendError(conn, "no active audio session found")
	}

	// Get audio parameters from session
	audioParams := AudioExtensionParams{
		SampleRate:    session.GetSampleRate(),
		Channels:      1,  // Always mono
		BitsPerSample: 16, // Always 16-bit
	}

	// Create extension instance
	extension, err := aem.registry.Create(extensionName, audioParams, extensionParams)
	if err != nil {
		return aem.sendError(conn, fmt.Sprintf("failed to create extension: %v", err))
	}

	// Create channels for audio and results
	audioChan := make(chan []int16, 1024)
	resultChan := make(chan []byte, 100)
	stopChan := make(chan struct{})

	// Create active extension record
	activeExtension := &ActiveAudioExtension{
		SessionID:     sessionID,
		ExtensionName: extensionName,
		Extension:     extension,
		AudioChan:     audioChan,
		ResultChan:    resultChan,
		StopChan:      stopChan,
		Conn:          conn,
		Running:       true,
		StartedAt:     time.Now(),
	}

	// Attach audio tap to session
	session.AttachAudioExtensionTap(audioChan)

	// Start extension
	if err := extension.Start(audioChan, resultChan); err != nil {
		session.DetachAudioExtensionTap()
		return aem.sendError(conn, fmt.Sprintf("failed to start extension: %v", err))
	}

	// Store active extension
	aem.activeExtensionsMu.Lock()
	aem.activeExtensions[sessionID] = activeExtension
	aem.activeExtensionsMu.Unlock()

	// Start result forwarding goroutine
	go aem.forwardResults(activeExtension)

	log.Printf("AudioExtension: ✅ Successfully attached '%s' to user %s", extensionName, sessionID)
	log.Printf("AudioExtension: Extension parameters: %+v", extensionParams)
	log.Printf("AudioExtension: Audio parameters: SampleRate=%d Hz, Channels=%d, BitsPerSample=%d",
		audioParams.SampleRate, audioParams.Channels, audioParams.BitsPerSample)
	log.Printf("AudioExtension: Active extensions count: %d", aem.GetActiveExtensionCount())

	// Send success confirmation
	return aem.sendTextMessage(conn, map[string]interface{}{
		"type":           "audio_extension_attached",
		"extension_name": extensionName,
		"started_at":     activeExtension.StartedAt.Format(time.RFC3339),
	})
}

// handleDetach detaches the active audio extension from the user's audio stream
func (aem *AudioExtensionManager) handleDetach(sessionID string, conn *websocket.Conn) error {
	aem.activeExtensionsMu.Lock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	if !exists {
		aem.activeExtensionsMu.Unlock()
		return aem.sendError(conn, "no active audio extension")
	}
	delete(aem.activeExtensions, sessionID)
	aem.activeExtensionsMu.Unlock()

	// Stop extension
	aem.stopExtension(activeExtension)

	log.Printf("AudioExtension: Detached '%s' from session %s", activeExtension.ExtensionName, sessionID)

	// Send confirmation
	return aem.sendTextMessage(conn, map[string]interface{}{
		"type": "audio_extension_detached",
	})
}

// handleStatus returns the status of the user's active audio extension
func (aem *AudioExtensionManager) handleStatus(sessionID string, conn *websocket.Conn) error {
	aem.activeExtensionsMu.RLock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	aem.activeExtensionsMu.RUnlock()

	if !exists {
		return aem.sendTextMessage(conn, map[string]interface{}{
			"type":   "audio_extension_status",
			"active": false,
		})
	}

	uptime := time.Since(activeExtension.StartedAt)

	return aem.sendTextMessage(conn, map[string]interface{}{
		"type":           "audio_extension_status",
		"active":         true,
		"extension_name": activeExtension.ExtensionName,
		"started_at":     activeExtension.StartedAt.Format(time.RFC3339),
		"uptime_sec":     int(uptime.Seconds()),
	})
}

// handleList returns the list of available audio extensions
func (aem *AudioExtensionManager) handleList(sessionID string, conn *websocket.Conn) error {
	extensions := aem.registry.List()

	return aem.sendTextMessage(conn, map[string]interface{}{
		"type":       "audio_extension_list",
		"extensions": extensions,
	})
}

// forwardResults forwards binary extension results to the client
func (aem *AudioExtensionManager) forwardResults(activeExtension *ActiveAudioExtension) {
	for {
		select {
		case binaryData, ok := <-activeExtension.ResultChan:
			if !ok {
				// Channel closed
				return
			}

			// Send binary message to client
			activeExtension.ConnMu.Lock()
			if activeExtension.Conn != nil {
				activeExtension.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := activeExtension.Conn.WriteMessage(websocket.BinaryMessage, binaryData); err != nil {
					log.Printf("AudioExtension: Failed to send result to session %s: %v", activeExtension.SessionID, err)
					activeExtension.ConnMu.Unlock()
					return
				}
			}
			activeExtension.ConnMu.Unlock()

		case <-activeExtension.StopChan:
			return
		}
	}
}

// stopExtension stops an audio extension and cleans up resources
func (aem *AudioExtensionManager) stopExtension(activeExtension *ActiveAudioExtension) {
	if !activeExtension.Running {
		return
	}

	activeExtension.Running = false

	// Signal stop
	close(activeExtension.StopChan)

	// Stop extension
	if err := activeExtension.Extension.Stop(); err != nil {
		log.Printf("AudioExtension: Error stopping extension: %v", err)
	}

	// Detach audio tap from session
	session := aem.findAudioSessionByUserID(activeExtension.SessionID)
	if session != nil {
		session.DetachAudioExtensionTap()
	}

	// Close channels
	close(activeExtension.AudioChan)
	close(activeExtension.ResultChan)
}

// RemoveSession removes all audio extensions for a session (called when user disconnects)
func (aem *AudioExtensionManager) RemoveSession(sessionID string) {
	aem.activeExtensionsMu.Lock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	if exists {
		delete(aem.activeExtensions, sessionID)
	}
	aem.activeExtensionsMu.Unlock()

	if exists {
		log.Printf("AudioExtension: Removing extension for disconnected session %s", sessionID)
		aem.stopExtension(activeExtension)
	}
}

// findAudioSessionByUserID finds the audio session for a given UserSessionID
func (aem *AudioExtensionManager) findAudioSessionByUserID(userSessionID string) *Session {
	aem.sessionManager.mu.RLock()
	defer aem.sessionManager.mu.RUnlock()

	for _, session := range aem.sessionManager.sessions {
		if session.UserSessionID == userSessionID && !session.IsSpectrum {
			return session
		}
	}

	return nil
}

// sendTextMessage sends a JSON text message to the client
func (aem *AudioExtensionManager) sendTextMessage(conn *websocket.Conn, message map[string]interface{}) error {
	messageJSON, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %v", err)
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, messageJSON)
}

// sendError sends an error message to the client
func (aem *AudioExtensionManager) sendError(conn *websocket.Conn, errorMsg string) error {
	return aem.sendTextMessage(conn, map[string]interface{}{
		"type":  "audio_extension_error",
		"error": errorMsg,
	})
}

// GetActiveExtensionCount returns the number of active audio extensions
func (aem *AudioExtensionManager) GetActiveExtensionCount() int {
	aem.activeExtensionsMu.RLock()
	defer aem.activeExtensionsMu.RUnlock()
	return len(aem.activeExtensions)
}
