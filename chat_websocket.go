package main

import (
	"encoding/json"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

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
	Country           string      // User's country name (optional)
	CountryCode       string      // User's ISO country code (optional)
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

	// Reference to session manager for IP lookups
	sessionManager *SessionManager

	// Active users list
	activeUsers   map[string]*ChatUser
	activeUsersMu sync.RWMutex

	// Configuration
	maxUsers                 int // Maximum concurrent users (0 = unlimited)
	rateLimitPerSecond       int // Maximum messages per second per user
	rateLimitPerMinute       int // Maximum messages per minute per user
	updateRateLimitPerSecond int // Maximum user updates per second per user

	// Chat logger for persistent storage
	chatLogger *ChatLogger

	// MQTT publisher for real-time chat events
	mqttPublisher *MQTTPublisher

	// Owner callsign restriction
	adminCallsign                string       // Admin callsign (uppercase for comparison)
	ownerCallsignFromAdminIPOnly bool         // Restrict owner callsign to admin IPs only
	adminConfig                  *AdminConfig // For IP checking
}

// NewChatManager creates a new chat manager
func NewChatManager(wsHandler *DXClusterWebSocketHandler, sessionManager *SessionManager, maxMessages int, maxUsers int, rateLimitPerSecond int, rateLimitPerMinute int, updateRateLimitPerSecond int, chatLogger *ChatLogger, mqttPublisher *MQTTPublisher, adminConfig *AdminConfig, chatConfig ChatConfig) *ChatManager {
	cm := &ChatManager{
		sessionUsernames:             make(map[string]string),
		messageBuffer:                make([]ChatMessage, 0, maxMessages),
		maxMessages:                  maxMessages,
		wsHandler:                    wsHandler,
		sessionManager:               sessionManager,
		activeUsers:                  make(map[string]*ChatUser),
		maxUsers:                     maxUsers,
		rateLimitPerSecond:           rateLimitPerSecond,
		rateLimitPerMinute:           rateLimitPerMinute,
		updateRateLimitPerSecond:     updateRateLimitPerSecond,
		chatLogger:                   chatLogger,
		mqttPublisher:                mqttPublisher,
		adminCallsign:                strings.ToUpper(adminConfig.Callsign),
		ownerCallsignFromAdminIPOnly: chatConfig.OwnerCallsignFromAdminIPOnly,
		adminConfig:                  adminConfig,
	}

	// Start cleanup goroutine for inactive users
	go cm.cleanupInactiveUsers()

	// Start idle tracking goroutine
	go cm.trackIdleStatus()

	return cm
}

// GetSessionIP retrieves the IP address for a session UUID from SessionManager
func (cm *ChatManager) GetSessionIP(sessionID string) string {
	if cm.sessionManager == nil {
		return ""
	}

	// Look up IP from any active session with this UserSessionID
	cm.sessionManager.mu.RLock()
	defer cm.sessionManager.mu.RUnlock()

	for _, session := range cm.sessionManager.sessions {
		if session.UserSessionID == sessionID && session.ClientIP != "" {
			return session.ClientIP
		}
	}

	return ""
}

// GetSessionCountry retrieves the country and country code for a session UUID from SessionManager
func (cm *ChatManager) GetSessionCountry(sessionID string) (country, countryCode string) {
	if cm.sessionManager == nil {
		return "", ""
	}

	// Look up country from any active session with this UserSessionID
	cm.sessionManager.mu.RLock()
	defer cm.sessionManager.mu.RUnlock()

	for _, session := range cm.sessionManager.sessions {
		if session.UserSessionID == sessionID {
			session.mu.RLock()
			country = session.Country
			countryCode = session.CountryCode
			session.mu.RUnlock()
			if country != "" || countryCode != "" {
				return country, countryCode
			}
		}
	}

	return "", ""
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

	// Check for profanity in username
	if containsProfanity(username) {
		log.Printf("Chat: Username '%s' rejected for session %s - contains profanity", username, sessionID)
		return ErrProfaneUsername
	}

	// Check if username matches owner callsign and restriction is enabled
	if cm.ownerCallsignFromAdminIPOnly && cm.adminCallsign != "" {
		if strings.EqualFold(username, cm.adminCallsign) {
			// Get user's IP address
			userIP := cm.GetSessionIP(sessionID)

			// Check if IP is in admin allowed list
			if !cm.adminConfig.IsIPAllowed(userIP) {
				log.Printf("Chat: Username '%s' (owner callsign) rejected for session %s from IP %s - not in admin allowed IPs", username, sessionID, userIP)
				return ErrOwnerCallsignRestricted
			}
			log.Printf("Chat: Username '%s' (owner callsign) allowed for session %s from admin IP %s", username, sessionID, userIP)
		}
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

	// Get country information for this user
	country, countryCode := cm.GetSessionCountry(sessionID)

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
		Country:           country,
		CountryCode:       countryCode,
	}
	cm.activeUsersMu.Unlock()

	log.Printf("Chat: Username '%s' set for session %s", username, sessionID)

	// Broadcast user join notification to all users
	cm.broadcastUserJoined(username, country, countryCode)

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

// GetUserLastSeen retrieves the LastSeen time for a session UUID
func (cm *ChatManager) GetUserLastSeen(sessionID string) (time.Time, bool) {
	cm.activeUsersMu.RLock()
	defer cm.activeUsersMu.RUnlock()

	if user, exists := cm.activeUsers[sessionID]; exists {
		return user.LastSeen, true
	}
	return time.Time{}, false
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
		// Validate mode length (max 6 chars: "iq" + 4 digits, or standard 3-char modes)
		if len(mode) == 0 || len(mode) > 6 {
			cm.activeUsersMu.Unlock()
			return ErrInvalidMode
		}

		// Validate characters (alphanumeric only)
		for _, r := range mode {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
				cm.activeUsersMu.Unlock()
				return ErrInvalidMode
			}
		}

		// Validate mode - accept standard modes and IQ modes
		validModes := map[string]bool{
			"usb": true, "lsb": true, "am": true, "fm": true,
			"cwu": true, "cwl": true, "sam": true, "nfm": true,
		}

		// Check if it's a valid IQ mode: "iq" followed by 0-4 digits
		// Valid: iq, iq48, iq96, iq192, iq384, iq1234
		// Invalid: iq12345, iqabc, abc123
		isIQMode := false
		if len(mode) >= 2 && len(mode) <= 6 { // "iq" (2) + up to 4 digits (4) = max 6
			if mode[0:2] == "iq" {
				// Check that everything after "iq" is digits
				allDigits := true
				for i := 2; i < len(mode); i++ {
					if mode[i] < '0' || mode[i] > '9' {
						allDigits = false
						break
					}
				}
				if allDigits {
					isIQMode = true
				}
			}
		}

		if !validModes[mode] && !isIQMode {
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
		cm.broadcastUserUpdate(user)
	}

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

	// Check if mode is an IQ mode (starts with "iq")
	isIQMode := false
	if len(user.Mode) >= 2 && user.Mode[0:2] == "iq" {
		isIQMode = true
	}

	// Always include frequency if set (even for IQ mode users)
	if user.Frequency > 0 {
		userData["frequency"] = user.Frequency
	}
	// Include mode only if it's not an IQ mode
	if user.Mode != "" && !isIQMode {
		userData["mode"] = user.Mode
	}
	// Include bandwidth values only if not in IQ mode
	// Only exclude if both frequency and mode are not set (user hasn't sent any radio data yet)
	if (user.Frequency > 0 || user.Mode != "") && !isIQMode {
		userData["bw_high"] = user.BWHigh
		userData["bw_low"] = user.BWLow
	}
	// Include zoom_bw only if not in IQ mode
	if user.ZoomBW > 0 && !isIQMode {
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

// RemoveUserMessages removes all messages from a specific user from the message buffer
// This is typically called when a user is kicked or banned
// Returns the number of messages removed
func (cm *ChatManager) RemoveUserMessages(sessionID string) int {
	cm.messageBufferMu.Lock()
	defer cm.messageBufferMu.Unlock()

	// Filter out messages from this user
	filtered := make([]ChatMessage, 0, len(cm.messageBuffer))
	removedCount := 0

	for _, msg := range cm.messageBuffer {
		if msg.SessionID != sessionID {
			filtered = append(filtered, msg)
		} else {
			removedCount++
		}
	}

	cm.messageBuffer = filtered

	if removedCount > 0 {
		log.Printf("Chat: Removed %d message(s) from session %s from message buffer", removedCount, sessionID)
	}

	return removedCount
}

// RemoveUserMessagesByIP removes all messages from users with a specific IP address
// This is typically called when an IP is banned
// Returns the number of messages removed
func (cm *ChatManager) RemoveUserMessagesByIP(ip string) int {
	// First, find all session IDs associated with this IP
	sessionIDs := make([]string, 0)

	cm.sessionUsernamesMu.RLock()
	for sessionID := range cm.sessionUsernames {
		sessionIP := cm.GetSessionIP(sessionID)
		if sessionIP == ip {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	cm.sessionUsernamesMu.RUnlock()

	// Now remove messages from all these sessions
	totalRemoved := 0
	for _, sessionID := range sessionIDs {
		removed := cm.RemoveUserMessages(sessionID)
		totalRemoved += removed
	}

	if totalRemoved > 0 {
		log.Printf("Chat: Removed %d message(s) from IP %s from message buffer", totalRemoved, ip)
	}

	return totalRemoved
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

	// Prevent all-caps messages (convert to sentence case if mostly uppercase)
	messageText = preventAllCaps(messageText)

	// Censor profanity (replace middle characters with asterisks)
	messageText = censorProfanity(messageText)

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

	// Get source IP and country for logging and MQTT - capture it NOW before spawning goroutines
	// to avoid race condition where IP might be removed from map during cleanup
	sourceIP := cm.GetSessionIP(sessionID)
	if sourceIP == "" {
		sourceIP = "unknown"
	}

	// Get country information from session
	country, countryCode := cm.GetSessionCountry(sessionID)

	// Capture values in local variables before spawning goroutines
	// This prevents race conditions if the session is cleaned up
	logTimestamp := now
	logIP := sourceIP
	logUsername := username
	logMessage := messageText
	logCountry := country
	logCountryCode := countryCode

	// Log to persistent storage (non-blocking)
	if cm.chatLogger != nil {
		// Use goroutine to avoid blocking message delivery on disk I/O
		go func() {
			if err := cm.chatLogger.LogMessage(logTimestamp, logIP, logUsername, logMessage, logCountry, logCountryCode); err != nil {
				log.Printf("Chat: Failed to log message: %v", err)
			}
		}()
	}

	// Publish to MQTT (non-blocking)
	if cm.mqttPublisher != nil {
		go func() {
			cm.mqttPublisher.PublishChatMessage(logTimestamp, logIP, logUsername, logMessage)
		}()
	}

	// Broadcast to all connected clients
	cm.broadcastChatMessage(chatMsg)

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
func (cm *ChatManager) broadcastUserJoined(username string, country string, countryCode string) {
	data := map[string]interface{}{
		"username":  username,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}

	// Include country information if available
	if countryCode != "" {
		data["country_code"] = countryCode
	}
	if country != "" {
		data["country"] = country
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

		// Include country information if available
		if user.CountryCode != "" {
			userData["country_code"] = user.CountryCode
		}
		if user.Country != "" {
			userData["country"] = user.Country
		}

		// Check if mode is an IQ mode (starts with "iq")
		isIQMode := false
		if len(user.Mode) >= 2 && user.Mode[0:2] == "iq" {
			isIQMode = true
		}

		// Always include frequency if set (even for IQ mode users)
		if user.Frequency > 0 {
			userData["frequency"] = user.Frequency
		}
		// Include mode only if it's not an IQ mode
		if user.Mode != "" && !isIQMode {
			userData["mode"] = user.Mode
		}
		// Include bandwidth values only if not in IQ mode
		// Only exclude if both frequency and mode are not set (user hasn't sent any radio data yet)
		if (user.Frequency > 0 || user.Mode != "") && !isIQMode {
			userData["bw_high"] = user.BWHigh
			userData["bw_low"] = user.BWLow
		}
		// Include zoom_bw only if not in IQ mode
		if user.ZoomBW > 0 && !isIQMode {
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

		// Include country information if available
		if user.CountryCode != "" {
			userData["country_code"] = user.CountryCode
		}
		if user.Country != "" {
			userData["country"] = user.Country
		}

		// Check if mode is an IQ mode (starts with "iq")
		isIQMode := false
		if len(user.Mode) >= 2 && user.Mode[0:2] == "iq" {
			isIQMode = true
		}

		// Always include frequency if set (even for IQ mode users)
		if user.Frequency > 0 {
			userData["frequency"] = user.Frequency
		}
		// Include mode only if it's not an IQ mode
		if user.Mode != "" && !isIQMode {
			userData["mode"] = user.Mode
		}
		// Include bandwidth values only if not in IQ mode
		// Only exclude if both frequency and mode are not set (user hasn't sent any radio data yet)
		if (user.Frequency > 0 || user.Mode != "") && !isIQMode {
			userData["bw_high"] = user.BWHigh
			userData["bw_low"] = user.BWLow
		}
		// Include zoom_bw only if not in IQ mode
		if user.ZoomBW > 0 && !isIQMode {
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

// preventAllCaps converts all-caps messages to sentence case
// This prevents "shouting" in chat while allowing normal use of acronyms and callsigns
func preventAllCaps(message string) string {
	// Count uppercase vs lowercase letters
	upperCount := 0
	lowerCount := 0
	letterCount := 0

	for _, r := range message {
		if unicode.IsLetter(r) {
			letterCount++
			if unicode.IsUpper(r) {
				upperCount++
			} else if unicode.IsLower(r) {
				lowerCount++
			}
		}
	}

	// Don't process if too few letters (likely acronyms or callsigns)
	if letterCount < 8 {
		return message
	}

	// Check if message looks like a callsign (has digits mixed with letters)
	trimmed := strings.TrimSpace(message)
	words := strings.Fields(trimmed)
	if len(words) == 1 && len(words[0]) <= 10 {
		// Single word - check if it looks like a callsign
		hasDigit := false
		for _, r := range words[0] {
			if unicode.IsDigit(r) {
				hasDigit = true
				break
			}
		}
		// If it has a digit and is short, it's likely a callsign
		if hasDigit {
			return message
		}
	}

	// If message is mostly uppercase (>70% of letters), convert to sentence case
	if letterCount > 0 && float64(upperCount)/float64(letterCount) > 0.7 {
		// Convert to lowercase first
		message = strings.ToLower(message)
		// Capitalize first letter
		runes := []rune(message)
		for i, r := range runes {
			if unicode.IsLetter(r) {
				runes[i] = unicode.ToUpper(r)
				break
			}
		}
		return string(runes)
	}

	return message
}

// censorProfanity replaces middle characters of profane words with asterisks
// This helps maintain a family-friendly chat environment
func censorProfanity(message string) string {
	// Use shared profanity list
	profanityList := getProfanityList()

	result := message

	for _, word := range profanityList {
		// Skip very short words (less than 3 chars) - can't censor meaningfully
		if len(word) < 3 {
			continue
		}

		// Create censored version: first char + asterisks + last char
		censored := string(word[0]) + strings.Repeat("*", len(word)-2) + string(word[len(word)-1])

		// Use regex with word boundaries for accurate matching
		// \b ensures we match whole words only (e.g., "ass" won't match in "assassin")
		pattern := `(?i)\b` + regexp.QuoteMeta(word) + `\b`
		re := regexp.MustCompile(pattern)

		// Replace all occurrences, preserving the case of first/last characters
		result = re.ReplaceAllStringFunc(result, func(match string) string {
			// Preserve case of first and last characters from original match
			if len(match) >= 3 {
				first := string(match[0])
				last := string(match[len(match)-1])
				return first + strings.Repeat("*", len(match)-2) + last
			}
			return censored
		})
	}

	return result
}

// getProfanityList returns the list of banned words
// This is shared between message censoring and username validation
func getProfanityList() []string {
	return []string{
		// F-word variants
		"fuck", "fucks", "fucked", "fucker", "fuckers", "fucking",
		// S-word variants
		"shit", "shits", "shitting", "shitty",
		// P-word variants
		"piss", "pissed", "pissing",
		// Sexual/anatomical slurs
		"ass", "asses", "asshole", "assholes",
		"bitch", "bitches", "bastard", "bastards",
		"dick", "dicks", "cock", "cocks", "pussy", "pussies", "cunt", "cunts",
		// Homophobic slurs
		"fag", "fags", "faggot", "faggots",
		"dyke", "dykes", "queer", "queers", "tranny", "trannies",
		// Racial slurs (most offensive)
		"nigger", "niggers", "nigga", "niggas",
		"chink", "chinks", "gook", "gooks",
		"spic", "spics", "wetback", "wetbacks",
		"kike", "kikes",
		// Sexist slurs
		"whore", "whores", "slut", "sluts",
		// Ableist slurs
		"retard", "retards", "retarded",
		"mongo", "mongol", "mongoloid",
		"spastic", "spastics", "spaz",
	}
}

// containsProfanity checks if a string contains any profane words
// Returns true if profanity is found, false otherwise
// For usernames, we check if profanity appears at word boundaries OR adjacent to numbers/special chars
func containsProfanity(text string) bool {
	profanityList := getProfanityList()

	// Convert to lowercase for case-insensitive matching
	lowerText := strings.ToLower(text)

	for _, word := range profanityList {
		// Check if the word exists in the text
		if !strings.Contains(lowerText, word) {
			continue
		}

		// Find all occurrences of the word
		index := 0
		for {
			pos := strings.Index(lowerText[index:], word)
			if pos == -1 {
				break
			}

			actualPos := index + pos

			// Check character before the word (if exists)
			beforeOK := actualPos == 0 || !isLetter(rune(lowerText[actualPos-1]))

			// Check character after the word (if exists)
			afterPos := actualPos + len(word)
			afterOK := afterPos >= len(lowerText) || !isLetter(rune(lowerText[afterPos]))

			// If profanity is at start/end OR surrounded by non-letters (numbers, special chars)
			// then it's a match. This blocks "fuck123", "bob_fuck", "fuckbob" but allows "assassin"
			if beforeOK || afterOK {
				return true
			}

			index = actualPos + 1
		}
	}

	return false
}

// isLetter checks if a character is a letter (a-z, A-Z)
func isLetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
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
	ErrProfaneUsername         = &ChatError{"username contains inappropriate language - please choose a different username"}
	ErrOwnerCallsignRestricted = &ChatError{"this username is reserved for the station owner - only accessible from authorized IPs"}
	ErrInvalidMessage          = &ChatError{"invalid message"}
	ErrUsernameNotSet          = &ChatError{"username not set"}
	ErrInvalidMessageType      = &ChatError{"invalid message type"}
	ErrUnknownMessageType      = &ChatError{"unknown message type"}
	ErrRateLimitExceeded       = &ChatError{"rate limit exceeded - please wait before sending another message"}
	ErrUpdateRateLimitExceeded = &ChatError{"update rate limit exceeded - please wait before updating frequency/mode"}
	ErrMaxUsersReached         = &ChatError{"maximum number of chat users reached - please try again later"}
	ErrUsernameAlreadyTaken    = &ChatError{"username already taken - please choose a different username"}
	ErrInvalidFrequency        = &ChatError{"invalid frequency - must be between 0 and 30000000 Hz"}
	ErrInvalidMode             = &ChatError{"invalid mode - must be one of: usb, lsb, am, fm, cwu, cwl, sam, nfm, or any IQ mode (iq, iq48, iq96, iq192, iq384)"}
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
