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
	LastActivityTime  time.Time   // For tracking idle time (user-initiated actions only)
	LastMessageTime   time.Time   // For rate limiting chat messages
	MessageTimestamps []time.Time // For rate limiting chat messages
	LastUpdateTime    time.Time   // For rate limiting user updates (frequency/mode)
	Frequency         uint64      // User's current frequency in Hz (optional)
	Mode              string      // User's current mode (optional)
	BWHigh            int         // High bandwidth cutoff in Hz (-10000 to 10000, optional)
	BWLow             int         // Low bandwidth cutoff in Hz (-10000 to 10000, optional)
	ZoomBW            float64     // Spectrum zoom bandwidth in Hz (optional)
	CAT               bool        // CAT control enabled (optional)
	TX                bool        // Transmitting status (optional)
	IsIdle            bool        // Whether user is currently marked as idle
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
	maxUsers                 int // Maximum concurrent users (0 = unlimited)
	rateLimitPerSecond       int // Maximum messages per second per user
	rateLimitPerMinute       int // Maximum messages per minute per user
	updateRateLimitPerSecond int // Maximum user updates per second per user
}

// NewChatManager creates a new chat manager
func NewChatManager(wsHandler *DXClusterWebSocketHandler, maxMessages int, maxUsers int, rateLimitPerSecond int, rateLimitPerMinute int, updateRateLimitPerSecond int) *ChatManager {
	cm := &ChatManager{
		sessionUsernames:         make(map[string]string),
		messageBuffer:            make([]ChatMessage, 0, maxMessages),
		maxMessages:              maxMessages,
		wsHandler:                wsHandler,
		activeUsers:              make(map[string]*ChatUser),
		maxUsers:                 maxUsers,
		rateLimitPerSecond:       rateLimitPerSecond,
		rateLimitPerMinute:       rateLimitPerMinute,
		updateRateLimitPerSecond: updateRateLimitPerSecond,
	}

	// Start cleanup goroutine for inactive users
	go cm.cleanupInactiveUsers()

	// Start idle tracking goroutine
	go cm.trackIdleStatus()

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
	now := time.Now()
	cm.activeUsersMu.Lock()
	cm.activeUsers[sessionID] = &ChatUser{
		SessionID:         sessionID,
		Username:          username,
		LastSeen:          now,
		LastActivityTime:  now,         // User just joined - this is an activity
		LastMessageTime:   time.Time{}, // Zero time
		MessageTimestamps: make([]time.Time, 0, 25),
		LastUpdateTime:    time.Time{}, // Zero time
		IsIdle:            false,
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

// UpdateUserStatus updates user status fields (frequency, mode, bandwidth, CAT, TX)
// All parameters are optional - only provided fields will be updated
func (cm *ChatManager) UpdateUserStatus(sessionID string, updates map[string]interface{}) error {
	cm.activeUsersMu.Lock()
	user, exists := cm.activeUsers[sessionID]
	if !exists {
		cm.activeUsersMu.Unlock()
		return ErrUsernameNotSet
	}

	now := time.Now()

	// Track if any value actually changed (check BEFORE rate limiting)
	valueChanged := false

	// Update frequency if provided AND different
	if frequency, ok := updates["frequency"].(float64); ok {
		// Validate frequency (0 Hz to 30 MHz)
		if frequency > 30000000 {
			cm.activeUsersMu.Unlock()
			return ErrInvalidFrequency
		}
		newFreq := uint64(frequency)
		if newFreq != user.Frequency {
			user.Frequency = newFreq
			valueChanged = true
		}
	}

	// Update mode if provided AND different
	if mode, ok := updates["mode"].(string); ok {
		// Validate mode
		validModes := map[string]bool{
			"usb": true, "lsb": true, "am": true, "fm": true,
			"cwu": true, "cwl": true, "sam": true, "nfm": true,
		}
		if !validModes[mode] {
			cm.activeUsersMu.Unlock()
			return ErrInvalidMode
		}
		if mode != user.Mode {
			user.Mode = mode
			valueChanged = true
		}
	}

	// Update bandwidth high if provided AND different
	if bwHigh, ok := updates["bw_high"].(float64); ok {
		// Validate bandwidth cutoffs (-10000 to 10000 Hz)
		if bwHigh < -10000 || bwHigh > 10000 {
			cm.activeUsersMu.Unlock()
			return ErrInvalidBandwidth
		}
		newBWHigh := int(bwHigh)
		if newBWHigh != user.BWHigh {
			user.BWHigh = newBWHigh
			valueChanged = true
		}
	}

	// Update bandwidth low if provided AND different
	if bwLow, ok := updates["bw_low"].(float64); ok {
		// Validate bandwidth cutoffs (-10000 to 10000 Hz)
		if bwLow < -10000 || bwLow > 10000 {
			cm.activeUsersMu.Unlock()
			return ErrInvalidBandwidth
		}
		newBWLow := int(bwLow)
		if newBWLow != user.BWLow {
			user.BWLow = newBWLow
			valueChanged = true
		}
	}

	// Update zoom_bw if provided AND different
	if zoomBW, ok := updates["zoom_bw"].(float64); ok {
		// Validate zoom_bw (must be positive, reasonable range)
		if zoomBW < 0 || zoomBW > 100000000 {
			cm.activeUsersMu.Unlock()
			return ErrInvalidBandwidth
		}
		if zoomBW != user.ZoomBW {
			user.ZoomBW = zoomBW
			valueChanged = true
		}
	}

	// Update CAT if provided AND different
	if cat, ok := updates["cat"].(bool); ok {
		if cat != user.CAT {
			user.CAT = cat
			valueChanged = true
		}
	}

	// Update TX if provided AND different
	if tx, ok := updates["tx"].(bool); ok {
		if tx != user.TX {
			user.TX = tx
			valueChanged = true
		}
	}

	// If nothing changed, return early without rate limiting or broadcasting
	// This prevents duplicate updates from counting against rate limits
	if !valueChanged {
		cm.activeUsersMu.Unlock()
		log.Printf("Chat: User '%s' update ignored (no changes): frequency=%d Hz, mode=%s, bw_high=%d, bw_low=%d, zoom_bw=%.1f, cat=%t, tx=%t",
			user.Username, user.Frequency, user.Mode, user.BWHigh, user.BWLow, user.ZoomBW, user.CAT, user.TX)
		return nil
	}

	// Only apply rate limiting if values actually changed
	if cm.updateRateLimitPerSecond > 0 {
		minInterval := time.Second / time.Duration(cm.updateRateLimitPerSecond)
		if !user.LastUpdateTime.IsZero() && now.Sub(user.LastUpdateTime) < minInterval {
			cm.activeUsersMu.Unlock()
			return ErrUpdateRateLimitExceeded
		}
	}

	// Update rate limit tracking (only for real changes)
	user.LastUpdateTime = now

	// Update user's last seen time (status updates count as activity)
	user.LastSeen = now

	// Update activity time and clear idle status (status updates are user-initiated)
	user.LastActivityTime = now
	wasIdle := user.IsIdle
	user.IsIdle = false

	cm.activeUsersMu.Unlock()

	// If user was idle and is now active, broadcast the change
	if wasIdle {
		log.Printf("Chat: User '%s' is no longer idle", user.Username)
		cm.broadcastUserUpdate(user)
	}

	log.Printf("Chat: User '%s' updated status (changed): frequency=%d Hz, mode=%s, bw_high=%d, bw_low=%d, zoom_bw=%.1f, cat=%t, tx=%t",
		user.Username, user.Frequency, user.Mode, user.BWHigh, user.BWLow, user.ZoomBW, user.CAT, user.TX)

	// Broadcast only this user's updated info (more efficient than full user list)
	cm.broadcastUserUpdate(user)

	return nil
}

// broadcastUserUpdate broadcasts a single user's updated information
func (cm *ChatManager) broadcastUserUpdate(user *ChatUser) {
	userData := map[string]interface{}{
		"username": user.Username,
	}

	// Always include idle status (boolean)
	userData["is_idle"] = user.IsIdle

	// Calculate and include idle time (informational)
	idleMinutes := int(time.Now().Sub(user.LastActivityTime).Minutes())
	if idleMinutes > 0 {
		userData["idle_minutes"] = idleMinutes
	}

	// Always include frequency if set (even if 0)
	if user.Frequency > 0 {
		userData["frequency"] = user.Frequency
	}
	// Always include mode if set
	if user.Mode != "" {
		userData["mode"] = user.Mode
	}
	// Always include bandwidth values (even if 0, for sync functionality)
	// Only exclude if both frequency and mode are not set (user hasn't sent any radio data yet)
	if user.Frequency > 0 || user.Mode != "" {
		userData["bw_high"] = user.BWHigh
		userData["bw_low"] = user.BWLow
	}
	// Include zoom_bw if set
	if user.ZoomBW > 0 {
		userData["zoom_bw"] = user.ZoomBW
	}
	// Include CAT and TX status
	userData["cat"] = user.CAT
	userData["tx"] = user.TX

	message := map[string]interface{}{
		"type": "chat_user_update",
		"data": userData,
	}

	cm.wsHandler.broadcast(message)
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

	// Rate limit: messages per second (configurable)
	if cm.rateLimitPerSecond > 0 {
		minInterval := time.Second / time.Duration(cm.rateLimitPerSecond)
		if !user.LastMessageTime.IsZero() && now.Sub(user.LastMessageTime) < minInterval {
			cm.activeUsersMu.Unlock()
			return ErrRateLimitExceeded
		}
	}

	// Rate limit: messages per minute (configurable)
	if cm.rateLimitPerMinute > 0 {
		// Remove timestamps older than 1 minute
		cutoff := now.Add(-1 * time.Minute)
		validTimestamps := make([]time.Time, 0, cm.rateLimitPerMinute)
		for _, ts := range user.MessageTimestamps {
			if ts.After(cutoff) {
				validTimestamps = append(validTimestamps, ts)
			}
		}
		user.MessageTimestamps = validTimestamps

		// Check if user has sent max messages in the last minute
		if len(user.MessageTimestamps) >= cm.rateLimitPerMinute {
			cm.activeUsersMu.Unlock()
			return ErrRateLimitExceeded
		}
	}

	// Update rate limit tracking
	user.LastMessageTime = now
	user.MessageTimestamps = append(user.MessageTimestamps, now)

	// Update activity time and clear idle status (messages are user-initiated)
	user.LastActivityTime = now
	wasIdle := user.IsIdle
	user.IsIdle = false

	cm.activeUsersMu.Unlock()

	// If user was idle and is now active, broadcast the change
	if wasIdle {
		log.Printf("Chat: User '%s' is no longer idle (sent message)", username)
		cm.broadcastUserUpdate(user)
	}

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
	cm.UpdateUserActivity(sessionID)

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

// GetActiveUserCount returns the number of currently active users (thread-safe)
func (cm *ChatManager) GetActiveUserCount() int {
	cm.activeUsersMu.RLock()
	defer cm.activeUsersMu.RUnlock()
	return len(cm.activeUsers)
}

// SendActiveUsers sends the list of active users to a specific client
func (cm *ChatManager) SendActiveUsers(conn *websocket.Conn) {
	users := cm.GetActiveUsers()

	userList := make([]map[string]interface{}, 0, len(users))
	for _, user := range users {
		userData := map[string]interface{}{
			"username": user.Username,
		}
		// Always include idle status (boolean)
		userData["is_idle"] = user.IsIdle
		// Calculate and include idle time (informational)
		idleMinutes := int(time.Now().Sub(user.LastActivityTime).Minutes())
		if idleMinutes > 0 {
			userData["idle_minutes"] = idleMinutes
		}
		// Include frequency if set
		if user.Frequency > 0 {
			userData["frequency"] = user.Frequency
		}
		// Include mode if set
		if user.Mode != "" {
			userData["mode"] = user.Mode
		}
		// Always include bandwidth values (even if 0, for sync functionality)
		// Only exclude if both frequency and mode are not set (user hasn't sent any radio data yet)
		if user.Frequency > 0 || user.Mode != "" {
			userData["bw_high"] = user.BWHigh
			userData["bw_low"] = user.BWLow
		}
		// Include zoom_bw if set
		if user.ZoomBW > 0 {
			userData["zoom_bw"] = user.ZoomBW
		}
		// Include CAT and TX status
		userData["cat"] = user.CAT
		userData["tx"] = user.TX
		userList = append(userList, userData)
	}

	message := map[string]interface{}{
		"type": "chat_active_users",
		"data": map[string]interface{}{
			"users": userList,
			"count": len(users),
		},
	}

	// Send only to the requesting client
	cm.wsHandler.sendMessage(conn, message)
}

// BroadcastActiveUsers sends the list of active users to all clients
// Kept for compatibility with user join/leave events
func (cm *ChatManager) BroadcastActiveUsers() {
	users := cm.GetActiveUsers()

	userList := make([]map[string]interface{}, 0, len(users))
	for _, user := range users {
		userData := map[string]interface{}{
			"username": user.Username,
		}
		// Always include idle status (boolean)
		userData["is_idle"] = user.IsIdle
		// Calculate and include idle time (informational)
		idleMinutes := int(time.Now().Sub(user.LastActivityTime).Minutes())
		if idleMinutes > 0 {
			userData["idle_minutes"] = idleMinutes
		}
		// Include frequency if set
		if user.Frequency > 0 {
			userData["frequency"] = user.Frequency
		}
		// Include mode if set
		if user.Mode != "" {
			userData["mode"] = user.Mode
		}
		// Always include bandwidth values (even if 0, for sync functionality)
		// Only exclude if both frequency and mode are not set (user hasn't sent any radio data yet)
		if user.Frequency > 0 || user.Mode != "" {
			userData["bw_high"] = user.BWHigh
			userData["bw_low"] = user.BWLow
		}
		// Include zoom_bw if set
		if user.ZoomBW > 0 {
			userData["zoom_bw"] = user.ZoomBW
		}
		// Include CAT and TX status
		userData["cat"] = user.CAT
		userData["tx"] = user.TX
		userList = append(userList, userData)
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

// UpdateUserActivity updates the last seen time for a user (public for websocket handler)
func (cm *ChatManager) UpdateUserActivity(sessionID string) {
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

// trackIdleStatus periodically checks users for idle status and broadcasts updates
func (cm *ChatManager) trackIdleStatus() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		cm.activeUsersMu.Lock()
		now := time.Now()

		// Collect all idle users for bulk update
		idleUpdates := make([]map[string]interface{}, 0)
		// Track users who just became idle for individual broadcasts
		newlyIdleUsers := make([]*ChatUser, 0)

		for _, user := range cm.activeUsers {
			idleMinutes := int(now.Sub(user.LastActivityTime).Minutes())

			// Check if user just became idle (crossed 5 minute threshold)
			if idleMinutes >= 5 && !user.IsIdle {
				user.IsIdle = true
				log.Printf("Chat: User '%s' is now idle (%d minutes)", user.Username, idleMinutes)
				// Track for individual broadcast
				newlyIdleUsers = append(newlyIdleUsers, user)
			}

			// Add all idle users to the bulk update
			if idleMinutes >= 5 {
				idleUpdates = append(idleUpdates, map[string]interface{}{
					"username":     user.Username,
					"is_idle":      true, // Always true for users in this list
					"idle_minutes": idleMinutes,
				})
			}
		}
		cm.activeUsersMu.Unlock()

		// Send individual broadcasts for newly idle users
		for _, user := range newlyIdleUsers {
			cm.broadcastUserUpdate(user)
		}

		// Send bulk update if there are any idle users
		if len(idleUpdates) > 0 {
			cm.broadcastIdleUpdates(idleUpdates)
		}
	}
}

// broadcastIdleUpdates sends a bulk update of all idle users' idle times
func (cm *ChatManager) broadcastIdleUpdates(idleUpdates []map[string]interface{}) {
	message := map[string]interface{}{
		"type": "chat_idle_updates",
		"data": map[string]interface{}{
			"users": idleUpdates,
		},
	}

	cm.wsHandler.broadcast(message)
}

// HandleChatMessage processes incoming chat messages from websocket clients
func (cm *ChatManager) HandleChatMessage(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
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

	case "chat_set_frequency_mode":
		// User is setting/updating their frequency, mode, bandwidth, CAT, and TX status
		// All fields are optional - only provided fields will be updated
		return cm.UpdateUserStatus(sessionID, msg)

	case "chat_request_users":
		// User is requesting the list of active users
		// Send only to the requesting user, not broadcast
		cm.SendActiveUsers(conn)
		return nil

	case "chat_leave":
		// User is explicitly leaving chat (but keeping WebSocket open for DX spots)
		cm.RemoveUser(sessionID)
		return nil

	default:
		return ErrUnknownMessageType
	}
}

// isAlphanumeric checks if a string contains only alphanumeric characters and allowed special chars
// Allows: letters, numbers, hyphens, underscores, forward slashes
// But not at the start or end
func isAlphanumeric(s string) bool {
	if len(s) == 0 {
		return false
	}

	for i, r := range s {
		isAlpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := (r >= '0' && r <= '9')
		isSpecial := (r == '-' || r == '_' || r == '/')

		// First and last character must be alphanumeric
		if i == 0 || i == len(s)-1 {
			if !(isAlpha || isDigit) {
				return false
			}
		} else {
			// Middle characters can be alphanumeric or special
			if !(isAlpha || isDigit || isSpecial) {
				return false
			}
		}
	}
	return true
}

// sanitizeUsername removes invalid characters and limits length
// Keeps: alphanumeric, hyphens, underscores, forward slashes (but not at start/end)
func sanitizeUsername(username string) string {
	// Keep only valid characters
	cleaned := ""
	for _, r := range username {
		isAlpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := (r >= '0' && r <= '9')
		isSpecial := (r == '-' || r == '_' || r == '/')

		if isAlpha || isDigit || isSpecial {
			cleaned += string(r)
		}
	}

	// Trim to max length
	cleaned = trimString(cleaned, 15)

	// Remove special characters from start and end
	for len(cleaned) > 0 && (cleaned[0] == '-' || cleaned[0] == '_' || cleaned[0] == '/') {
		cleaned = cleaned[1:]
	}
	for len(cleaned) > 0 && (cleaned[len(cleaned)-1] == '-' || cleaned[len(cleaned)-1] == '_' || cleaned[len(cleaned)-1] == '/') {
		cleaned = cleaned[:len(cleaned)-1]
	}

	return cleaned
}

// sanitizeMessage removes control characters and ensures safe encoding
func sanitizeMessage(message string) string {
	cleaned := ""
	for _, r := range message {
		// Allow printable ASCII characters, common punctuation, and Unicode characters (including emojis)
		// Exclude control characters (except space and newline)
		if r == '\n' || r == ' ' || (r >= 33 && r <= 126) || r > 127 {
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
	ErrInvalidUsername         = &ChatError{"invalid username - must be 1-15 characters (letters, numbers, - _ /) and cannot start or end with - _ /"}
	ErrInvalidMessage          = &ChatError{"invalid message"}
	ErrUsernameNotSet          = &ChatError{"username not set"}
	ErrInvalidMessageType      = &ChatError{"invalid message type"}
	ErrUnknownMessageType      = &ChatError{"unknown message type"}
	ErrRateLimitExceeded       = &ChatError{"rate limit exceeded - please wait before sending another message"}
	ErrUpdateRateLimitExceeded = &ChatError{"update rate limit exceeded - please wait before updating frequency/mode"}
	ErrMaxUsersReached         = &ChatError{"maximum number of chat users reached - please try again later"}
	ErrUsernameAlreadyTaken    = &ChatError{"username already taken - please choose a different username"}
	ErrInvalidFrequency        = &ChatError{"invalid frequency - must be between 0 and 30000000 Hz"}
	ErrInvalidMode             = &ChatError{"invalid mode - must be one of: usb, lsb, am, fm, cwu, cwl, sam, nfm"}
	ErrInvalidBandwidth        = &ChatError{"invalid bandwidth - bw_high and bw_low must be between -10000 and 10000 Hz"}
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
