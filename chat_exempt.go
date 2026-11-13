package main

// Who automatic chat moderation leaves alone.
//
// Moderators (signed-in admins) and bypassed users (timeout_bypass_ips or the
// bypass password) are exempt from the automatic side of moderation: the word
// and link filter, the username filter, filter strikes, automatic chat bans
// and the automatic escalation to Ban from SDR.
//
// Moderators are also never kept out by a chat ban on their address. Bypassed
// users can still be warned or chat-banned by a moderator or an admin by hand.

// bypassConfig returns the server config used for bypass checks, or nil.
func (cm *ChatManager) bypassConfig() *ServerConfig {
	if cm.sessionManager == nil || cm.sessionManager.config == nil {
		return nil
	}
	return &cm.sessionManager.config.Server
}

// sessionBypassed reports whether the user behind a chat session is a
// bypassed user: their address is on the bypass list, or one of their
// sessions connected with the bypass password.
func (cm *ChatManager) sessionBypassed(sessionID string) bool {
	cfg := cm.bypassConfig()
	if cfg == nil || sessionID == "" {
		return false
	}
	if ip := cm.sessionIP(sessionID); ip != "" && cfg.IsIPTimeoutBypassed(ip) {
		return true
	}
	cm.sessionManager.mu.RLock()
	defer cm.sessionManager.mu.RUnlock()
	for _, s := range cm.sessionManager.sessions {
		if s.UserSessionID == sessionID && cfg.IsIPTimeoutBypassed(s.ClientIP, s.BypassPassword) {
			return true
		}
	}
	return false
}

// ipBypassed reports whether ip is on the bypass list or currently has a
// session connected with the bypass password.
func (cm *ChatManager) ipBypassed(ip string) bool {
	cfg := cm.bypassConfig()
	if cfg == nil || ip == "" {
		return false
	}
	if cfg.IsIPTimeoutBypassed(ip) {
		return true
	}
	cm.sessionManager.mu.RLock()
	defer cm.sessionManager.mu.RUnlock()
	for _, s := range cm.sessionManager.sessions {
		if s.ClientIP == ip && cfg.IsIPTimeoutBypassed(s.ClientIP, s.BypassPassword) {
			return true
		}
	}
	return false
}

// sessionIsModerator reports whether the chat user on sessionID is a moderator.
func (cm *ChatManager) sessionIsModerator(sessionID string) bool {
	cm.activeUsersMu.RLock()
	defer cm.activeUsersMu.RUnlock()
	u := cm.activeUsers[sessionID]
	return u != nil && u.Moderator
}

// autoModExempt reports whether automatic moderation leaves sessionID alone.
func (cm *ChatManager) autoModExempt(sessionID string, moderator bool) bool {
	return moderator || cm.sessionBypassed(sessionID)
}
