package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

// Chat moderators: admins signed in on this server's own pages.
//
// Security model
//   - The admin_session cookie is read only at the socket handshake, and kept
//     only when the Origin header names one of this server's hosts (the same
//     hosts the admin CSRF check accepts), the session is valid, and the
//     client's address is allowed to use the admin pages. Apps that connect
//     from another origin are ordinary users.
//   - The token is held server-side for that one connection. It is never sent
//     to any client and never logged (logs carry a short SHA-256 prefix).
//   - Every moderator action re-validates the sending connection's token, so a
//     logout, expiry or revoke takes effect at once. A periodic check also
//     turns moderator tools off for sessions that have ended.
//   - Addresses and moderation data only go to connections that hold a valid
//     admin session and were granted moderator status when they joined chat.

const (
	chatModRateLimit     = 20 // chat_mod messages per connection ...
	chatModRateWindow    = time.Minute
	chatModReasonMaxLen  = 200 // runes
	chatModRecheckPeriod = 60 * time.Second
	chatModEchoMaxLen    = 32 // runes of action/username echoed back in a refusal
)

// chatModAuth checks admin sessions for the chat socket. *AdminHandler implements it.
type chatModAuth interface {
	ValidateAdminSession(token string) bool
	AdminIPAllowed(ip string) bool
}

// ErrModDenied is returned when a connection without a valid admin session
// asks for a moderator action.
var ErrModDenied = &ChatCodedError{
	Message: "Your admin sign-in has ended. Sign in on the admin page, then reload this page.",
	Code:    "mod_denied",
}

// chatModConn is the admin session a connection arrived with.
type chatModConn struct {
	conn      *websocket.Conn
	token     string
	ip        string // client address at the handshake
	sessionID string
	granted   bool // moderator status given when it joined chat
}

// chatModerators holds the admin sessions of moderator connections, keyed by
// connection (never by user session id or name), and a per-connection rate
// limit on chat_mod messages.
type chatModerators struct {
	mu    sync.Mutex
	auth  chatModAuth
	conns map[*websocket.Conn]*chatModConn
	rate  map[*websocket.Conn][]time.Time
}

func newChatModerators() *chatModerators {
	return &chatModerators{
		conns: make(map[*websocket.Conn]*chatModConn),
		rate:  make(map[*websocket.Conn][]time.Time),
	}
}

// chatTokenRef is a short, non-reversible reference to a token for logs.
func chatTokenRef(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:4])
}

func (m *chatModerators) setAuth(a chatModAuth) {
	m.mu.Lock()
	m.auth = a
	m.mu.Unlock()
}

func (m *chatModerators) getAuth() chatModAuth {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.auth
}

// attach keeps conn's admin session.
func (m *chatModerators) attach(conn *websocket.Conn, token, ip, sessionID string) {
	if conn == nil || token == "" {
		return
	}
	m.mu.Lock()
	m.conns[conn] = &chatModConn{conn: conn, token: token, ip: ip, sessionID: sessionID}
	m.mu.Unlock()
}

// detach forgets everything about conn (it disconnected).
func (m *chatModerators) detach(conn *websocket.Conn) {
	m.mu.Lock()
	delete(m.conns, conn)
	delete(m.rate, conn)
	m.mu.Unlock()
}

// take removes conn's admin session and returns it.
func (m *chatModerators) take(conn *websocket.Conn) (chatModConn, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.conns[conn]
	if !ok {
		return chatModConn{}, false
	}
	delete(m.conns, conn)
	return *e, true
}

// entry returns a copy of conn's admin session.
func (m *chatModerators) entry(conn *websocket.Conn) (chatModConn, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.conns[conn]
	if !ok {
		return chatModConn{}, false
	}
	return *e, true
}

// validEntry reports whether e's admin session is still good right now.
func (m *chatModerators) validEntry(e chatModConn) bool {
	a := m.getAuth()
	return a != nil && e.token != "" && a.ValidateAdminSession(e.token) && a.AdminIPAllowed(e.ip)
}

// valid returns conn's admin session and whether it is still good right now.
// held is false when conn never had one.
func (m *chatModerators) valid(conn *websocket.Conn) (e chatModConn, held, ok bool) {
	e, held = m.entry(conn)
	if !held {
		return e, false, false
	}
	return e, true, m.validEntry(e)
}

func (m *chatModerators) setGranted(conn *websocket.Conn, granted bool) {
	m.mu.Lock()
	if e, ok := m.conns[conn]; ok {
		e.granted = granted
	}
	m.mu.Unlock()
}

// all returns copies of every held admin session.
func (m *chatModerators) all() []chatModConn {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]chatModConn, 0, len(m.conns))
	for _, e := range m.conns {
		out = append(out, *e)
	}
	return out
}

// allow applies the per-connection chat_mod rate limit.
func (m *chatModerators) allow(conn *websocket.Conn, now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	kept := m.rate[conn][:0]
	for _, t := range m.rate[conn] {
		if now.Sub(t) < chatModRateWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) >= chatModRateLimit {
		m.rate[conn] = kept
		return false
	}
	m.rate[conn] = append(kept, now)
	return true
}

// SetModeratorAuth lets signed-in admins moderate chat.
func (h *DXClusterWebSocketHandler) SetModeratorAuth(a chatModAuth) {
	if h.chatManager != nil {
		h.chatManager.mods.setAuth(a)
	}
}

// moderatorToken returns the admin session a new chat socket may keep, or ""
// for an ordinary user. All of these must hold: the Origin header names this
// server, the session is valid, and clientIP may use the admin pages.
func (h *DXClusterWebSocketHandler) moderatorToken(r *http.Request, clientIP string) string {
	if h.chatManager == nil {
		return ""
	}
	auth := h.chatManager.mods.getAuth()
	if auth == nil {
		return ""
	}
	cookie, err := r.Cookie("admin_session")
	if err != nil || cookie.Value == "" {
		return ""
	}
	ref := chatTokenRef(cookie.Value)
	switch {
	case !adminOriginMatches(r):
		log.Printf("Chat: admin session %s from %s not used for moderation: the page is not from this server", ref, clientIP)
		return ""
	case !auth.ValidateAdminSession(cookie.Value):
		return "" // signed out or expired: an ordinary user
	case !auth.AdminIPAllowed(clientIP):
		log.Printf("Chat: admin session %s from %s not used for moderation: address not allowed for admin", ref, clientIP)
		return ""
	}
	log.Printf("Chat: admin session %s from %s may moderate chat", ref, clientIP)
	return cookie.Value
}

// joinChat handles chat_set_username: a connection holding a valid admin
// session joins as a moderator.
func (cm *ChatManager) joinChat(sessionID string, conn *websocket.Conn, username string) error {
	e, held, mod := cm.mods.valid(conn)
	if held && !mod {
		cm.mods.take(conn) // ended, or no longer allowed: never comes back
		log.Printf("Chat: admin session %s no longer valid; joining as an ordinary user", chatTokenRef(e.token))
	}
	if err := cm.setUsername(sessionID, username, mod); err != nil {
		return err
	}
	cm.mods.setGranted(conn, mod)
	if conn == nil {
		return nil
	}
	cm.wsHandler.sendMessage(conn, map[string]interface{}{
		"type": "chat_moderator",
		"data": map[string]interface{}{"enabled": mod},
	})
	if mod {
		log.Printf("Chat: %s joined as a moderator (admin session %s)", username, chatTokenRef(e.token))
		cm.wsHandler.sendMessage(conn, cm.ModStateFor())
	}
	return nil
}

// demoteModerator turns moderator tools off for conn and forgets its session.
func (cm *ChatManager) demoteModerator(conn *websocket.Conn) {
	e, ok := cm.mods.take(conn)
	if !ok {
		return
	}
	cm.activeUsersMu.Lock()
	u := cm.activeUsers[e.sessionID]
	if u != nil {
		u.Moderator = false
	}
	cm.activeUsersMu.Unlock()
	if u != nil {
		// Everyone's user list drops the moderator badge.
		cm.broadcastUserUpdate(u)
	}
	cm.wsHandler.sendMessage(conn, map[string]interface{}{
		"type": "chat_moderator",
		"data": map[string]interface{}{"enabled": false},
	})
	log.Printf("Chat: moderator tools turned off for session %s (admin session %s has ended)", e.sessionID, chatTokenRef(e.token))
}

// recheckModerators demotes every connection whose admin session has ended.
func (cm *ChatManager) recheckModerators() {
	for _, e := range cm.mods.all() {
		if !cm.mods.validEntry(e) {
			cm.demoteModerator(e.conn)
		}
	}
}

func (cm *ChatManager) moderatorRecheckLoop() {
	ticker := time.NewTicker(chatModRecheckPeriod)
	defer ticker.Stop()
	for range ticker.C {
		cm.recheckModerators()
	}
}

// broadcastModState sends chat_mod_state to every moderator in chat, checking
// each one's admin session as it goes.
func (cm *ChatManager) broadcastModState() {
	var state map[string]interface{}
	for _, e := range cm.mods.all() {
		if !e.granted {
			continue
		}
		if !cm.mods.validEntry(e) {
			cm.demoteModerator(e.conn)
			continue
		}
		if _, inChat := cm.GetUsername(e.sessionID); !inChat {
			continue
		}
		if state == nil {
			state = cm.ModStateFor()
		}
		cm.wsHandler.sendMessage(e.conn, state)
	}
}

// chatSessionForName finds the chat session using username (any case).
func (cm *ChatManager) chatSessionForName(username string) (string, bool) {
	cm.activeUsersMu.RLock()
	defer cm.activeUsersMu.RUnlock()
	for id, u := range cm.activeUsers {
		if strings.EqualFold(u.Username, username) {
			return id, true
		}
	}
	return "", false
}

// isModeratorName reports whether name belongs to a moderator: a chat user
// flagged as one, or the chat name of a connection holding an admin session.
func (cm *ChatManager) isModeratorName(name string) bool {
	cm.activeUsersMu.RLock()
	for _, u := range cm.activeUsers {
		if u.Moderator && strings.EqualFold(u.Username, name) {
			cm.activeUsersMu.RUnlock()
			return true
		}
	}
	cm.activeUsersMu.RUnlock()
	for _, e := range cm.mods.all() {
		if n, ok := cm.GetUsername(e.sessionID); ok && strings.EqualFold(n, name) {
			return true
		}
	}
	return false
}

// isModeratorIP reports whether ip is the address of a moderator: a
// connection holding an admin session, or a chat user flagged as one.
func (cm *ChatManager) isModeratorIP(ip string) bool {
	if ip == "" {
		return false
	}
	for _, e := range cm.mods.all() {
		if e.ip == ip {
			return true
		}
	}
	for _, id := range cm.chatSessionsForIP(ip) {
		cm.activeUsersMu.RLock()
		u := cm.activeUsers[id]
		mod := u != nil && u.Moderator
		cm.activeUsersMu.RUnlock()
		if mod {
			return true
		}
	}
	return false
}

// liftTargetIP finds the address to lift for a chat name: the chat ban in
// force under that name first, then the address last known for it.
func (cm *ChatManager) liftTargetIP(name string) string {
	for _, b := range cm.ChatBans() {
		if strings.EqualFold(b.Username, name) {
			return b.IP
		}
	}
	ip, _ := cm.GetIPForUsername(name)
	return ip
}

// validModTarget reports whether name is a chat name: a web name (the
// username rules) or a relayed name ("~" plus up to 14 name characters).
func validModTarget(name string) bool {
	if name == "" || len(name) > 15 {
		return false
	}
	if rest, ok := strings.CutPrefix(name, "~"); ok {
		if rest == "" {
			return false
		}
		for _, r := range rest {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '/') {
				return false
			}
		}
		return true
	}
	return isAlphanumeric(name)
}

// cleanModReason trims a moderator's reason, drops control characters and
// caps it at chatModReasonMaxLen runes.
func cleanModReason(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == ' ' || r == ' ' {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	return trimString(s, chatModReasonMaxLen)
}

func pluralMessages(n int) string {
	if n == 1 {
		return "1 message"
	}
	return fmt.Sprintf("%d messages", n)
}

var chatModActionNames = map[string]bool{
	"info": true, "warn": true, "delete_user": true, "chat_ban": true, "lift": true, "sdr_ban": true,
}

// handleModAction handles one chat_mod message. Authority comes only from the
// sending connection's admin session, checked again here.
func (cm *ChatManager) handleModAction(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	action, _ := msg["action"].(string)
	rawName, _ := msg["username"].(string)
	name := strings.TrimSpace(rawName)

	reply := func(ok bool, text string, info map[string]interface{}) {
		if conn == nil {
			return
		}
		data := map[string]interface{}{
			"action":   trimString(action, chatModEchoMaxLen),
			"ok":       ok,
			"message":  text,
			"username": trimString(rawName, chatModEchoMaxLen),
		}
		if info != nil {
			data["info"] = info
		}
		cm.wsHandler.sendMessage(conn, map[string]interface{}{"type": "chat_mod_result", "data": data})
	}

	if !cm.mods.allow(conn, cm.now()) {
		reply(false, "Too many actions at once. Please wait a moment and try again.", nil)
		return nil
	}

	// Who is asking: a connection with a valid admin session that joined chat
	// as a moderator.
	e, held, valid := cm.mods.valid(conn)
	modName, inChat := cm.GetUsername(sessionID)
	if !held || !valid || !e.granted || !inChat || e.sessionID != sessionID {
		reply(false, ErrModDenied.Message, nil)
		if held && !valid {
			cm.demoteModerator(conn)
		}
		log.Printf("Chat: moderator action %q refused for session %s: not signed in as a moderator", trimString(action, chatModEchoMaxLen), sessionID)
		return ErrModDenied
	}
	by := "admin " + modName

	if !chatModActionNames[action] {
		reply(false, "That action isn't available.", nil)
		return nil
	}
	if !validModTarget(name) {
		reply(false, "That isn't a valid chat name.", nil)
		return nil
	}
	if strings.EqualFold(name, modName) {
		reply(false, "You can't use moderator tools on yourself.", nil)
		return nil
	}

	targetSession, targetInChat := cm.chatSessionForName(name)
	if targetInChat {
		cm.activeUsersMu.RLock()
		if u := cm.activeUsers[targetSession]; u != nil {
			name = u.Username // as they spelled it
		}
		cm.activeUsersMu.RUnlock()
	}
	if cm.isModeratorName(name) {
		if action == "info" {
			reply(true, name+" is a moderator", modInfoModerator(name, targetInChat))
			return nil
		}
		reply(false, name+" is also a moderator.", nil)
		return nil
	}
	relay := strings.HasPrefix(name, "~")
	if relay && action != "info" && action != "delete_user" {
		reply(false, name+" is relayed from another service. You can only see their details or delete their messages.", nil)
		return nil
	}

	ip := ""
	if !relay {
		if action == "lift" {
			ip = cm.liftTargetIP(name)
		} else {
			ip, _ = cm.GetIPForUsername(name)
		}
		if ip == "" {
			reply(false, "Couldn't find anyone called "+name+" in chat or in recent history.", nil)
			return nil
		}
		if net.ParseIP(ip) == nil {
			reply(false, "No address is known for "+name+".", nil)
			return nil
		}
		// Actions that reach the address (or a user on it) must never land
		// on a moderator. delete_user only uses the address when the target
		// has left chat.
		byAddress := action == "warn" || action == "chat_ban" || action == "sdr_ban" ||
			(action == "delete_user" && !targetInChat)
		if byAddress {
			if ip == e.ip {
				reply(false, name+" is on the same internet connection as you, so this would affect you too.", nil)
				return nil
			}
			if cm.isModeratorIP(ip) {
				reply(false, name+" is on the same internet connection as a moderator, so you can't do this.", nil)
				return nil
			}
		}
	}

	reason := ""
	if r, ok := msg["reason"].(string); ok {
		reason = cleanModReason(r)
	}

	log.Printf("Chat: moderator %s: %s %s (%s)", modName, action, name, ip)

	switch action {
	case "info":
		reply(true, "Details for "+name, cm.modInfo(name, ip, targetSession, targetInChat, relay))

	case "warn":
		// Only the named user is warned, and only while they are in chat.
		if n := cm.Warn(ip, name, reason, by); n > 0 {
			reply(true, name+" has been warned", nil)
		} else {
			reply(true, name+" isn't in chat right now. The warning was saved to their record, but they haven't seen it.", nil)
		}

	case "delete_user":
		// In chat (or relayed): that user's messages only. Left: everything
		// from their address.
		var ids []int64
		if relay || targetInChat {
			ids = cm.DeleteMessagesByUsername(name, by)
		} else {
			ids = cm.DeleteMessagesByIP(ip, by)
		}
		if len(ids) == 0 {
			reply(true, name+" has no messages to remove", nil)
			return nil
		}
		if _, err := cm.modActions.RecordCount(chatActionDelete, ip, name, by, reason, time.Time{}, len(ids)); err != nil {
			log.Printf("Chat: failed to record delete: %v", err)
		}
		cm.broadcastModState()
		reply(true, "Removed "+pluralMessages(len(ids))+" from "+name, nil)

	case "chat_ban":
		secs, ok := msg["duration_sec"].(float64)
		if !ok || secs != math.Trunc(secs) || !chatBanPresetOK(int64(secs)) {
			reply(false, "Please choose one of the listed chat ban lengths.", nil)
			return nil
		}
		del, _ := msg["delete"].(bool)
		dur := time.Duration(secs) * time.Second
		res, err := cm.ChatBan(ip, dur, by, reason, name, del)
		if err != nil {
			reply(false, "The chat ban didn't work: "+err.Error(), nil)
			return nil
		}
		text := name + " is banned from chat for " + formatChatDuration(dur)
		if del {
			text += ", and their messages were removed"
		}
		if res.SDRBanned {
			text += ". After repeated chat bans they are now also banned from the SDR"
		}
		reply(true, text, nil)

	case "lift":
		if !cm.LiftChatBan(ip, by) {
			reply(false, name+" isn't banned from chat", nil)
			return nil
		}
		reply(true, name+" can join the chat again", nil)

	case "sdr_ban":
		cm.modMu.Lock()
		fn := cm.sdrBanFn
		cm.modMu.Unlock()
		if fn == nil {
			reply(false, "Ban from SDR isn't available on this receiver.", nil)
			return nil
		}
		why := reason
		if why == "" {
			why = "Banned from SDR by a chat moderator"
		}
		// Ban first: if it fails, nothing is deleted.
		deleted, err := cm.sdrBanFromChat(fn, ip, why, by)
		if err != nil {
			log.Printf("Chat: Ban from SDR of %s by %s failed: %v", ip, modName, err)
			reply(false, "The Ban from SDR didn't work. Please try again or use the admin page.", nil)
			return nil
		}
		deleted += len(cm.DeleteMessagesByIP(ip, by))
		for _, id := range cm.chatSessionsForIP(ip) {
			cm.RemoveUser(id)
		}
		if _, err := cm.modActions.RecordCount(chatActionSDRBan, ip, name, by, why, time.Time{}, deleted); err != nil {
			log.Printf("Chat: failed to record Ban from SDR: %v", err)
		}
		cm.broadcastModState()
		reply(true, name+" is banned from the SDR", nil)
	}
	return nil
}

// modInfoModerator is the info payload for a moderator: no address or record,
// so the client shows that they are a moderator.
func modInfoModerator(name string, inChat bool) map[string]interface{} {
	return map[string]interface{}{
		"username":        name,
		"in_chat":         inChat,
		"ip":              "",
		"shared_ip_users": 0,
		"relay":           false,
		"moderator":       true,
		"record":          ChatModRecord{},
		"message_count":   0,
	}
}

// modInfo builds the info payload of a chat_mod_result.
func (cm *ChatManager) modInfo(name, ip, targetSession string, inChat, relay bool) map[string]interface{} {
	shared := 0
	if ip != "" {
		for _, id := range cm.chatSessionsForIP(ip) {
			if id != targetSession {
				shared++
			}
		}
	}
	count := 0
	for _, m := range cm.GetBufferedMessages() {
		if (ip != "" && m.SourceIP == ip) || (relay && strings.EqualFold(m.Username, name)) {
			count++
		}
	}
	record := ChatModRecord{}
	if ip != "" {
		record = cm.modActions.Record30d(ip)
	}
	info := map[string]interface{}{
		"username":        name,
		"in_chat":         inChat,
		"ip":              ip,
		"shared_ip_users": shared,
		"relay":           relay,
		"moderator":       false,
		"record":          record,
		"message_count":   count,
	}
	if b, ok := cm.activeChatBan(ip); ok {
		info["chat_banned_until"] = b.Until.UTC().Format(time.RFC3339)
		info["chat_ban_by"] = b.By
	}
	return info
}
