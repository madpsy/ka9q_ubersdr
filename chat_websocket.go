package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ChatMessage represents a chat message with metadata
type ChatMessage struct {
	Username  string    `json:"username"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
	SessionID string    `json:"session_id"` // UUID of the sender
}

// ChatUser represents a user in the chat system
type ChatUser struct {
	SessionID         string
	Username          string
	LastSeen          time.Time
	LastMessageTime   time.Time   // For 1 message per second rate limit
	MessageTimestamps []time.Time // For 25 messages per minute rate limit
}

// ChatManager manages chat functionality for the DX cluster websocket
type ChatManager struct {
	// Map session UUID to username
	sessionUsernames   map[string]string
	sessionUsernamesMu sync.RWMutex

	// Chat message buffer for new connections
	messageBuffer   []ChatMessage
	messageBufferMu sync.RWMutex
	maxMessages     int

	// Reference to websocket handler for broadcasting
	wsHandler *DXClusterWebSocketHandler

	// Active users list
	activeUsers   map[string]*ChatUser
	activeUsersMu sync.RWMutex

	// Configuration
	maxUsers int // Maximum concurrent users (0 = unlimited)
}

// NewChatManager creates a new chat manager
func NewChatManager(wsHandler *DXClusterWebSocketHandler, maxMessages int, maxUsers int) *ChatManager {
	cm := &ChatManager{
		sessionUsernames: make(map[string]string),
		messageBuffer:    make([]ChatMessage, 0, maxMessages),
		maxMessages:      maxMessages,
		wsHandler:        wsHandler,
		activeUsers:      make(map[string]*ChatUser),
		maxUsers:         maxUsers,
	}

	// Start cleanup goroutine for inactive users
	go cm.cleanupInactiveUsers()

	return cm
}

// SetUsername associates a username with a session UUID
func (cm *ChatManager) SetUsername(sessionID string, username string) error {
	// Validate username (alphanumeric only, max 15 characters)
	if len(username) == 0 || len(username) > 15 {
		return ErrInvalidUsername
	}

	// Validate alphanumeric only
	if !isAlphanumeric(username) {
		return ErrInvalidUsername
	}

	// Sanitize username (alphanumeric only, max 15 chars)
	username = sanitizeUsername(username)

	// Check if username is already taken by another user
	cm.sessionUsernamesMu.RLock()
	for otherSessionID, existingUsername := range cm.sessionUsernames {
		if existingUsername == username && otherSessionID != sessionID {
			cm.sessionUsernamesMu.RUnlock()
			log.Printf("Chat: Username '%s' already taken, rejecting for session %s", username, sessionID)
			return ErrUsernameAlreadyTaken
		}
	}
	cm.sessionUsernamesMu.RUnlock()

	// Check if user limit is reached (if maxUsers > 0)
	if cm.maxUsers > 0 {
		cm.activeUsersMu.RLock()
		currentUsers := len(cm.activeUsers)
		_, alreadyExists := cm.activeUsers[sessionID]
		cm.activeUsersMu.RUnlock()

		// If user doesn't already exist and we're at the limit, reject
		if !alreadyExists && currentUsers >= cm.maxUsers {
			log.Printf("Chat: User limit reached (%d/%d), rejecting username '%s' for session %s", currentUsers, cm.maxUsers, username, sessionID)
			return ErrMaxUsersReached
		}
	}

	cm.sessionUsernamesMu.Lock()
	cm.sessionUsernames[sessionID] = username
	cm.sessionUsernamesMu.Unlock()

	// Update active users
	cm.activeUsersMu.Lock()
	cm.activeUsers[sessionID] = &ChatUser{
		SessionID:         sessionID,
		Username:          username,
		LastSeen:          time.Now(),
		LastMessageTime:   time.Time{}, // Zero time
		MessageTimestamps: make([]time.Time, 0, 25),
	}
	cm.activeUsersMu.Unlock()

	log.Printf("Chat: Username '%s' set for session %s", username, sessionID)

	// Broadcast user join notification to all users
	cm.broadcastUserJoined(username)

	// Send success confirmation to the user who just joined
	cm.broadcastUsernameSetSuccess(sessionID, username)

	return nil
}

// broadcastUsernameSetSuccess sends a success confirmation to the user who set their username
func (cm *ChatManager) broadcastUsernameSetSuccess(sessionID string, username string) {
	// This is sent only to the specific user, not broadcast to everyone
	// We'll need to add a method to send to a specific session
	// For now, we rely on the broadcastUserJoined message which goes to everyone including the sender
}

// GetUsername retrieves the username for a session UUID
func (cm *ChatManager) GetUsername(sessionID string) (string, bool) {
	cm.sessionUsernamesMu.RLock()
	username, exists := cm.sessionUsernames[sessionID]
	cm.sessionUsernamesMu.RUnlock()
	return username, exists
}

// RemoveUser removes a user from the chat system
func (cm *ChatManager) RemoveUser(sessionID string) {
	cm.sessionUsernamesMu.Lock()
	username, existed := cm.sessionUsernames[sessionID]
	delete(cm.sessionUsernames, sessionID)
	cm.sessionUsernamesMu.Unlock()

	cm.activeUsersMu.Lock()
	delete(cm.activeUsers, sessionID)
	cm.activeUsersMu.Unlock()

	if existed {
		log.Printf("Chat: User '%s' (session %s) removed", username, sessionID)
		// Broadcast user left notification
		cm.broadcastUserLeft(username)
	}
}

// SendMessage processes and broadcasts a chat message from a user
func (cm *ChatManager) SendMessage(sessionID string, messageText string) error {
	// Get username for this session
	username, exists := cm.GetUsername(sessionID)
	if !exists {
		return ErrUsernameNotSet
	}

	// Check rate limits
	cm.activeUsersMu.Lock()
	user, userExists := cm.activeUsers[sessionID]
	if !userExists {
		cm.activeUsersMu.Unlock()
		return ErrUsernameNotSet
	}

	now := time.Now()

	// Rate limit: 1 message per second
	if !user.LastMessageTime.IsZero() && now.Sub(user.LastMessageTime) < time.Second {
		cm.activeUsersMu.Unlock()
		return ErrRateLimitExceeded
	}

	// Rate limit: 25 messages per minute
	// Remove timestamps older than 1 minute
	cutoff := now.Add(-1 * time.Minute)
	validTimestamps := make([]time.Time, 0, 25)
	for _, ts := range user.MessageTimestamps {
		if ts.After(cutoff) {
			validTimestamps = append(validTimestamps, ts)
		}
	}
	user.MessageTimestamps = validTimestamps

	// Check if user has sent 25 messages in the last minute
	if len(user.MessageTimestamps) >= 25 {
		cm.activeUsersMu.Unlock()
		return ErrRateLimitExceeded
	}

	// Update rate limit tracking
	user.LastMessageTime = now
	user.MessageTimestamps = append(user.MessageTimestamps, now)
	cm.activeUsersMu.Unlock()

	// Validate message (max 250 characters)
	if len(messageText) == 0 || len(messageText) > 250 {
		return ErrInvalidMessage
	}

	// Sanitize message (removes control chars, encodes quotes)
	messageText = sanitizeMessage(messageText)

	// Create chat message
	chatMsg := ChatMessage{
		Username:  username,
		Message:   messageText,
		Timestamp: now.UTC(),
		SessionID: sessionID,
	}

	// Add to buffer
	cm.addMessageToBuffer(chatMsg)

	// Update user's last seen time
	cm.updateUserActivity(sessionID)

	// Broadcast to all connected clients
	cm.broadcastChatMessage(chatMsg)

	log.Printf("Chat: Message from '%s': %s", username, messageText)

	return nil
}

// addMessageToBuffer adds a message to the buffer, maintaining max size
func (cm *ChatManager) addMessageToBuffer(msg ChatMessage) {
	cm.messageBufferMu.Lock()
	defer cm.messageBufferMu.Unlock()

	// Add message to buffer
	cm.messageBuffer = append(cm.messageBuffer, msg)

	// If buffer exceeds max size, remove oldest messages
	if len(cm.messageBuffer) > cm.maxMessages {
		cm.messageBuffer = cm.messageBuffer[len(cm.messageBuffer)-cm.maxMessages:]
	}
}

// GetBufferedMessages returns a copy of buffered messages
func (cm *ChatManager) GetBufferedMessages() []ChatMessage {
	cm.messageBufferMu.RLock()
	defer cm.messageBufferMu.RUnlock()

	messages := make([]ChatMessage, len(cm.messageBuffer))
	copy(messages, cm.messageBuffer)
	return messages
}

// SendBufferedMessages sends buffered messages to a newly connected client
func (cm *ChatManager) SendBufferedMessages(conn *websocket.Conn) {
	messages := cm.GetBufferedMessages()

	if len(messages) == 0 {
		log.Printf("Chat: No buffered messages to send to new client")
		return
	}

	log.Printf("Chat: Sending %d buffered messages to new client", len(messages))

	for _, msg := range messages {
		data := map[string]interface{}{
			"username":  msg.Username,
			"message":   msg.Message,
			"timestamp": msg.Timestamp.Format(time.RFC3339),
		}

		message := map[string]interface{}{
			"type": "chat_message",
			"data": data,
		}

		if err := cm.wsHandler.sendMessage(conn, message); err != nil {
			log.Printf("Chat: Failed to send buffered message: %v", err)
		}
	}
}

// broadcastChatMessage broadcasts a chat message to all connected clients
func (cm *ChatManager) broadcastChatMessage(msg ChatMessage) {
	data := map[string]interface{}{
		"username":  msg.Username,
		"message":   msg.Message,
		"timestamp": msg.Timestamp.Format(time.RFC3339),
	}

	message := map[string]interface{}{
		"type": "chat_message",
		"data": data,
	}

	cm.wsHandler.broadcast(message)
}

// broadcastUserJoined broadcasts a user joined notification
func (cm *ChatManager) broadcastUserJoined(username string) {
	data := map[string]interface{}{
		"username":  username,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}

	message := map[string]interface{}{
		"type": "chat_user_joined",
		"data": data,
	}

	cm.wsHandler.broadcast(message)
}

// broadcastUserLeft broadcasts a user left notification
func (cm *ChatManager) broadcastUserLeft(username string) {
	data := map[string]interface{}{
		"username":  username,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}

	message := map[string]interface{}{
		"type": "chat_user_left",
		"data": data,
	}

	cm.wsHandler.broadcast(message)
}

// GetActiveUsers returns a list of currently active users
func (cm *ChatManager) GetActiveUsers() []ChatUser {
	cm.activeUsersMu.RLock()
	defer cm.activeUsersMu.RUnlock()

	users := make([]ChatUser, 0, len(cm.activeUsers))
	for _, user := range cm.activeUsers {
		users = append(users, *user)
	}
	return users
}

// BroadcastActiveUsers sends the list of active users to all clients
func (cm *ChatManager) BroadcastActiveUsers() {
	users := cm.GetActiveUsers()

	userList := make([]map[string]interface{}, 0, len(users))
	for _, user := range users {
		userList = append(userList, map[string]interface{}{
			"username": user.Username,
		})
	}

	message := map[string]interface{}{
		"type": "chat_active_users",
		"data": map[string]interface{}{
			"users": userList,
			"count": len(users),
		},
	}

	cm.wsHandler.broadcast(message)
}

// updateUserActivity updates the last seen time for a user
func (cm *ChatManager) updateUserActivity(sessionID string) {
	cm.activeUsersMu.Lock()
	defer cm.activeUsersMu.Unlock()

	if user, exists := cm.activeUsers[sessionID]; exists {
		user.LastSeen = time.Now()
	}
}

// cleanupInactiveUsers periodically removes inactive users
func (cm *ChatManager) cleanupInactiveUsers() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		cm.activeUsersMu.Lock()
		now := time.Now()
		for sessionID, user := range cm.activeUsers {
			// Remove users inactive for more than 30 minutes
			if now.Sub(user.LastSeen) > 30*time.Minute {
				username := user.Username
				delete(cm.activeUsers, sessionID)

				cm.sessionUsernamesMu.Lock()
				delete(cm.sessionUsernames, sessionID)
				cm.sessionUsernamesMu.Unlock()

				log.Printf("Chat: Removed inactive user '%s' (session %s)", username, sessionID)

				// Broadcast user left notification
				go cm.broadcastUserLeft(username)
			}
		}
		cm.activeUsersMu.Unlock()
	}
}

// HandleChatMessage processes incoming chat messages from websocket clients
func (cm *ChatManager) HandleChatMessage(sessionID string, msg map[string]interface{}) error {
	msgType, ok := msg["type"].(string)
	if !ok {
		return ErrInvalidMessageType
	}

	switch msgType {
	case "chat_set_username":
		// User is setting their username
		username, ok := msg["username"].(string)
		if !ok {
			return ErrInvalidUsername
		}
		return cm.SetUsername(sessionID, username)

	case "chat_message":
		// User is sending a chat message
		messageText, ok := msg["message"].(string)
		if !ok {
			return ErrInvalidMessage
		}
		return cm.SendMessage(sessionID, messageText)

	case "chat_request_users":
		// User is requesting the list of active users
		cm.BroadcastActiveUsers()
		return nil

	case "chat_leave":
		// User is explicitly leaving chat (but keeping WebSocket open for DX spots)
		cm.RemoveUser(sessionID)
		return nil

	default:
		return ErrUnknownMessageType
	}
}

// isAlphanumeric checks if a string contains only alphanumeric characters
func isAlphanumeric(s string) bool {
	for _, r := range s {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// sanitizeUsername removes non-alphanumeric characters and limits length
func sanitizeUsername(username string) string {
	// Keep only alphanumeric characters
	cleaned := ""
	for _, r := range username {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			cleaned += string(r)
		}
	}
	return trimString(cleaned, 15)
}

// sanitizeMessage removes control characters and ensures safe encoding
func sanitizeMessage(message string) string {
	cleaned := ""
	for _, r := range message {
		// Allow printable ASCII characters and common punctuation
		// Exclude control characters (except space and newline)
		if r == '\n' || r == ' ' || (r >= 33 && r <= 126) {
			// Keep the character as-is - JSON encoding will handle quotes properly
			cleaned += string(r)
		}
	}
	return trimString(cleaned, 250)
}

// trimString trims a string to a maximum length (by rune count for proper UTF-8 handling)
func trimString(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) > maxLen {
		return string(runes[:maxLen])
	}
	return s
}

// Error types
var (
	ErrInvalidUsername      = &ChatError{"invalid username"}
	ErrInvalidMessage       = &ChatError{"invalid message"}
	ErrUsernameNotSet       = &ChatError{"username not set"}
	ErrInvalidMessageType   = &ChatError{"invalid message type"}
	ErrUnknownMessageType   = &ChatError{"unknown message type"}
	ErrRateLimitExceeded    = &ChatError{"rate limit exceeded - please wait before sending another message"}
	ErrMaxUsersReached      = &ChatError{"maximum number of chat users reached - please try again later"}
	ErrUsernameAlreadyTaken = &ChatError{"username already taken - please choose a different username"}
)

// ChatError represents a chat-related error
type ChatError struct {
	Message string
}

func (e *ChatError) Error() string {
	return e.Message
}

// MarshalJSON implements json.Marshaler for ChatError
func (e *ChatError) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{
		"error": e.Message,
	})
}
