package main

import (
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

// The moderation ladder: automatic warnings on filter strikes, temporary chat
// bans (by moderators, admins or automatically) and the optional automatic
// Ban from SDR. Everything is keyed by IP address, like the SDR bans.

// chatBanPresets are the only chat-ban lengths moderators and admins may pick.
var chatBanPresets = []time.Duration{
	15 * time.Minute,
	time.Hour,
	24 * time.Hour,
	7 * 24 * time.Hour,
	30 * 24 * time.Hour,
}

// chatBanPresetOK reports whether seconds is one of the chat-ban presets.
func chatBanPresetOK(seconds int64) bool {
	for _, d := range chatBanPresets {
		if int64(d/time.Second) == seconds {
			return true
		}
	}
	return false
}

// chatBanEntry is an active chat ban held in memory.
type chatBanEntry struct {
	IP       string
	Username string
	By       string
	Reason   string
	Created  time.Time
	Until    time.Time
}

// ChatCodedError is a chat error that carries a machine-readable code (and,
// for chat bans, when it ends) for the chat_error frame.
type ChatCodedError struct {
	Message string
	Code    string
	Until   time.Time
}

func (e *ChatCodedError) Error() string { return e.Message }

// ErrMessageBlocked is returned when a message was not sent because of the filter.
var ErrMessageBlocked = &ChatCodedError{
	Message: "Message not sent: it contains a word or link that isn't allowed here.",
	Code:    "blocked",
}

// chatErrorPayload builds the chat_error frame for an error returned by the
// chat manager, adding code and until when the error carries them.
func chatErrorPayload(err error) map[string]interface{} {
	m := map[string]interface{}{
		"type":  "chat_error",
		"error": err.Error(),
	}
	var ce *ChatCodedError
	if errors.As(err, &ce) {
		if ce.Code != "" {
			m["code"] = ce.Code
		}
		if !ce.Until.IsZero() {
			m["until"] = ce.Until.UTC().Format(time.RFC3339)
		}
	}
	return m
}

// formatChatDuration gives a plain length such as "15 minutes", "1 hour" or "7 days".
func formatChatDuration(d time.Duration) string {
	plural := func(n int64, unit string) string {
		if n == 1 {
			return "1 " + unit
		}
		return fmt.Sprintf("%d %ss", n, unit)
	}
	switch {
	case d >= 24*time.Hour && d%(24*time.Hour) == 0:
		return plural(int64(d/(24*time.Hour)), "day")
	case d >= time.Hour && d%time.Hour == 0:
		return plural(int64(d/time.Hour), "hour")
	default:
		m := int64(d / time.Minute)
		if m < 1 {
			m = 1
		}
		return plural(m, "minute")
	}
}

// chatBannedText is the chat_banned notice. It never names a clock time:
// clients show the end time in the user's own time zone from "until".
const chatBannedText = "You've been banned from chat. You can still listen to the receiver."

func chatBannedError(until time.Time) error {
	return &ChatCodedError{
		Message: "You're banned from chat at the moment. You can still listen to the receiver.",
		Code:    "chat_banned",
		Until:   until.UTC(),
	}
}

// SetModerationStore wires in the moderation settings (filter, ladder settings).
func (cm *ChatManager) SetModerationStore(s *ChatModerationStore) {
	cm.modMu.Lock()
	cm.modStore = s
	cm.modMu.Unlock()
}

// ModerationStore returns the settings store (nil when none was wired in).
func (cm *ChatManager) ModerationStore() *ChatModerationStore {
	cm.modMu.Lock()
	defer cm.modMu.Unlock()
	return cm.modStore
}

// SetSDRBanFunc wires the Ban from SDR used by the automatic escalation.
func (cm *ChatManager) SetSDRBanFunc(fn func(ip, reason, by string) error) {
	cm.modMu.Lock()
	cm.sdrBanFn = fn
	cm.modMu.Unlock()
}

// chatSDRBanCall is a Ban from SDR started by chat moderation, which records
// it in the history itself.
type chatSDRBanCall struct {
	deleted int // messages the Ban from SDR removed
}

// sdrBanFromChat runs fn (the Ban from SDR) for a chat moderation path. While
// it runs, the Ban from SDR leaves recording to the caller (see
// ClaimSDRBanFromChat). It returns how many messages the ban removed.
func (cm *ChatManager) sdrBanFromChat(fn func(ip, reason, by string) error, ip, why, by string) (int, error) {
	call := &chatSDRBanCall{}
	cm.modMu.Lock()
	if cm.sdrBanCalls == nil {
		cm.sdrBanCalls = make(map[string]*chatSDRBanCall)
	}
	cm.sdrBanCalls[ip] = call
	cm.modMu.Unlock()

	err := fn(ip, why, by)

	cm.modMu.Lock()
	if cm.sdrBanCalls[ip] == call {
		delete(cm.sdrBanCalls, ip)
	}
	deleted := call.deleted
	cm.modMu.Unlock()
	return deleted, err
}

// ClaimSDRBanFromChat is called by the Ban from SDR once it has banned ip and
// removed its messages. It reports true when chat moderation started the ban
// and will record it, so the caller must not record it again.
func (cm *ChatManager) ClaimSDRBanFromChat(ip string, deleted int) bool {
	if cm == nil {
		return false
	}
	cm.modMu.Lock()
	defer cm.modMu.Unlock()
	call, ok := cm.sdrBanCalls[ip]
	if ok {
		call.deleted += deleted
	}
	return ok
}

// chatFilter returns the filter in force (built-in defaults when no store).
func (cm *ChatManager) chatFilter() *ChatFilter {
	if s := cm.ModerationStore(); s != nil {
		return s.Filter()
	}
	return defaultChatFilter()
}

// modSettings returns the moderation settings in force.
func (cm *ChatManager) modSettings() ChatModerationSettings {
	if s := cm.ModerationStore(); s != nil {
		return s.Settings()
	}
	return DefaultChatModerationSettings()
}

var (
	defaultChatFilterOnce sync.Once
	defaultChatFilterVal  *ChatFilter
)

func defaultChatFilter() *ChatFilter {
	defaultChatFilterOnce.Do(func() {
		defaultChatFilterVal = NewChatFilter(DefaultChatModerationSettings())
	})
	return defaultChatFilterVal
}

// chatSessionsForIP lists the chat sessions (non-relay) currently bound to ip.
func (cm *ChatManager) chatSessionsForIP(ip string) []string {
	if ip == "" {
		return nil
	}
	cm.activeUsersMu.RLock()
	ids := make([]string, 0, len(cm.activeUsers))
	for id := range cm.activeUsers {
		ids = append(ids, id)
	}
	cm.activeUsersMu.RUnlock()
	var out []string
	for _, id := range ids {
		if cm.sessionIP(id) == ip {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// sessionsForIP lists every user session bound to ip, in chat or not.
func (cm *ChatManager) sessionsForIP(ip string) []string {
	if ip == "" || cm.sessionManager == nil {
		return nil
	}
	seen := map[string]bool{}
	cm.sessionManager.mu.RLock()
	for id, bound := range cm.sessionManager.uuidToIP {
		if bound == ip {
			seen[id] = true
		}
	}
	cm.sessionManager.mu.RUnlock()
	for _, id := range cm.chatSessionsForIP(ip) {
		seen[id] = true
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// sendNotice sends a chat_notice to one session's connection.
func (cm *ChatManager) sendNotice(sessionID string, data map[string]interface{}) {
	conn := cm.wsHandler.GetConnForSession(sessionID)
	if conn == nil {
		return
	}
	if err := cm.wsHandler.sendMessage(conn, map[string]interface{}{"type": "chat_notice", "data": data}); err != nil {
		log.Printf("Chat: failed to send notice to session %s: %v", sessionID, err)
	}
}

// activeChatBan returns the chat ban in force for ip, dropping it if expired.
func (cm *ChatManager) activeChatBan(ip string) (chatBanEntry, bool) {
	if ip == "" {
		return chatBanEntry{}, false
	}
	now := cm.now()
	cm.modMu.Lock()
	defer cm.modMu.Unlock()
	b, ok := cm.chatBans[ip]
	if !ok {
		return chatBanEntry{}, false
	}
	if !now.Before(b.Until) {
		delete(cm.chatBans, ip)
		return chatBanEntry{}, false
	}
	return *b, true
}

// chatBanFor returns the error to refuse a session with when its IP is
// chat-banned. Moderators are never kept out, and bypassed users are not kept
// out by an automatic chat ban (see chat_exempt.go).
func (cm *ChatManager) chatBanFor(sessionID string, moderator bool) error {
	b, ok := cm.activeChatBan(cm.sessionIP(sessionID))
	if !ok || moderator {
		return nil
	}
	if b.By == "auto" && cm.sessionBypassed(sessionID) {
		return nil
	}
	return chatBannedError(b.Until)
}

// ChatBans returns the chat bans in force, soonest to expire first.
func (cm *ChatManager) ChatBans() []chatBanEntry {
	cm.expireChatBans()
	cm.modMu.Lock()
	out := make([]chatBanEntry, 0, len(cm.chatBans))
	for _, b := range cm.chatBans {
		out = append(out, *b)
	}
	cm.modMu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].Until.Equal(out[j].Until) {
			return out[i].IP < out[j].IP
		}
		return out[i].Until.Before(out[j].Until)
	})
	return out
}

// expireChatBans drops expired chat bans; it reports whether any were dropped.
func (cm *ChatManager) expireChatBans() bool {
	now := cm.now()
	changed := false
	cm.modMu.Lock()
	for ip, b := range cm.chatBans {
		if !now.Before(b.Until) {
			delete(cm.chatBans, ip)
			changed = true
		}
	}
	cm.modMu.Unlock()
	return changed
}

// pruneStrikes forgets addresses whose newest filter strike is older than the
// automatic-moderation window, so the strike map can't grow without bound.
func (cm *ChatManager) pruneStrikes() {
	window := time.Duration(cm.modSettings().AutoModeration.WindowMinutes) * time.Minute
	if window <= 0 {
		window = time.Hour
	}
	now := cm.now()
	cm.modMu.Lock()
	for ip, times := range cm.strikes {
		if len(times) == 0 || now.Sub(times[len(times)-1]) >= window {
			delete(cm.strikes, ip)
		}
	}
	cm.modMu.Unlock()
}

// chatBanCleanup periodically drops expired chat bans and old filter strikes.
func (cm *ChatManager) chatBanCleanup() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		cm.pruneStrikes()
		if cm.expireChatBans() {
			cm.broadcastModState()
		}
	}
}

// loadActiveChatBans restores the chat bans still in force from the database.
func (cm *ChatManager) loadActiveChatBans() {
	bans := cm.modActions.ActiveBans()
	if len(bans) == 0 {
		return
	}
	cm.modMu.Lock()
	for _, b := range bans {
		cm.chatBans[b.IP] = &chatBanEntry{IP: b.IP, Username: b.Username, By: b.By, Reason: b.Reason, Created: b.Created, Until: b.Until}
	}
	n := len(cm.chatBans)
	cm.modMu.Unlock()
	log.Printf("Chat: restored %d active chat ban(s)", n)
}

// usernameForIP finds a name for ip: a chat user on it now, else the last
// name seen joining from it.
func (cm *ChatManager) usernameForIP(ip string) string {
	for _, id := range cm.chatSessionsForIP(ip) {
		if name, ok := cm.GetUsername(id); ok {
			return name
		}
	}
	cm.usernameIPsMu.RLock()
	defer cm.usernameIPsMu.RUnlock()
	var names []string
	for name, cached := range cm.usernameIPs {
		if cached == ip {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) > 0 {
		return strings.ToUpper(names[0])
	}
	return ""
}

// ChatBanResult describes what a chat ban did.
type ChatBanResult struct {
	Until     time.Time
	Removed   []string // usernames removed from chat
	Deleted   int      // messages deleted
	SDRBanned bool     // the automatic Ban from SDR was applied
}

// ChatBan removes everyone on ip from chat for dur and keeps them out until
// it ends. by is "auto", "admin", "telegram" or a moderator's name.
// deleteMsgs also deletes their messages.
func (cm *ChatManager) ChatBan(ip string, dur time.Duration, by, reason, username string, deleteMsgs bool) (ChatBanResult, error) {
	var res ChatBanResult
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return res, errors.New("no IP address to ban")
	}
	if dur <= 0 {
		return res, errors.New("the chat ban needs a length")
	}
	if username == "" {
		username = cm.usernameForIP(ip)
	}
	now := cm.now()
	res.Until = now.Add(dur).UTC()

	cm.modMu.Lock()
	cm.chatBans[ip] = &chatBanEntry{IP: ip, Username: username, By: by, Reason: reason, Created: now.UTC(), Until: res.Until}
	delete(cm.strikes, ip)
	cm.modMu.Unlock()

	action := chatActionChatBan
	if by == "auto" {
		action = chatActionAutoChatBan
	}
	if _, err := cm.modActions.Record(action, ip, username, by, reason, res.Until); err != nil {
		log.Printf("Chat: failed to record chat ban: %v", err)
	}

	notice := map[string]interface{}{
		"kind":  "chat_banned",
		"text":  chatBannedText,
		"until": res.Until.Format(time.RFC3339),
	}
	for _, id := range cm.chatSessionsForIP(ip) {
		// Moderators stay; bypassed users only leave for a ban made by hand.
		if cm.sessionIsModerator(id) || (by == "auto" && cm.sessionBypassed(id)) {
			continue
		}
		name, _ := cm.GetUsername(id)
		cm.sendNotice(id, notice)
		cm.RemoveUser(id)
		if name != "" {
			res.Removed = append(res.Removed, name)
		}
	}
	if deleteMsgs {
		res.Deleted = len(cm.DeleteMessagesByIP(ip, by))
	}
	log.Printf("Chat: %s (%s) chat-banned until %s by %s", username, ip, res.Until.Format(time.RFC3339), by)

	// Optional escalation: enough chat bans in the window -> Ban from SDR.
	esc := cm.modSettings().SDREscalation
	if esc.Enabled && esc.ChatBans > 0 && esc.WindowDays > 0 && cm.ipBypassed(ip) {
		log.Printf("Chat: %s is a bypassed address; no automatic Ban from SDR", ip)
	} else if esc.Enabled && esc.ChatBans > 0 && esc.WindowDays > 0 {
		since := now.AddDate(0, 0, -esc.WindowDays)
		if n := cm.modActions.ChatBansSince(ip, since); n >= esc.ChatBans {
			cm.modMu.Lock()
			fn := cm.sdrBanFn
			cm.modMu.Unlock()
			if fn != nil {
				why := fmt.Sprintf("Automatic: %d chat bans in %d days", n, esc.WindowDays)
				if removed, err := cm.sdrBanFromChat(fn, ip, why, "auto"); err != nil {
					log.Printf("Chat: automatic Ban from SDR for %s failed: %v", ip, err)
				} else {
					res.SDRBanned = true
					if _, err := cm.modActions.RecordCount(chatActionAutoSDRBan, ip, username, "auto", why, time.Time{}, removed); err != nil {
						log.Printf("Chat: failed to record Ban from SDR: %v", err)
					}
					log.Printf("Chat: %s (%s) automatically banned from the SDR", username, ip)
				}
			}
		}
	}

	cm.broadcastModState()
	return res, nil
}

// LiftChatBan ends the chat ban on ip early. It reports whether one was in force.
func (cm *ChatManager) LiftChatBan(ip, by string) bool {
	ip = strings.TrimSpace(ip)
	b, ok := cm.activeChatBan(ip)
	if !ok {
		return false
	}
	cm.modMu.Lock()
	delete(cm.chatBans, ip)
	cm.modMu.Unlock()

	if err := cm.modActions.MarkLifted(ip); err != nil {
		log.Printf("Chat: failed to mark chat ban lifted: %v", err)
	}
	if _, err := cm.modActions.Record(chatActionLift, ip, b.Username, by, "", time.Time{}); err != nil {
		log.Printf("Chat: failed to record lift: %v", err)
	}
	notice := map[string]interface{}{
		"kind": "chat_ban_lifted",
		"text": "Your chat ban has been lifted. You can join the chat again.",
	}
	for _, id := range cm.sessionsForIP(ip) {
		cm.sendNotice(id, notice)
	}
	log.Printf("Chat: chat ban on %s (%s) lifted by %s", b.Username, ip, by)
	cm.broadcastModState()
	return true
}

// Warn sends a moderator warning and records it. When username is given,
// only that user is warned, and only if they are in chat right now (someone
// who has left just gets the warning on their record; nobody else on their
// address is warned). With no username (an admin warning an address) every
// chat user on ip is warned. text is the moderator's message; a plain
// default is used when empty. Returns how many chat sessions were warned.
func (cm *ChatManager) Warn(ip, username, text, by string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		text = "please keep chat friendly"
	}
	var sessions []string
	if username != "" {
		if id, ok := cm.chatSessionForName(username); ok {
			sessions = []string{id}
		}
	} else {
		sessions = cm.chatSessionsForIP(ip)
	}
	notice := map[string]interface{}{
		"kind": "warning",
		"text": "A moderator has warned you: " + text,
	}
	for _, id := range sessions {
		cm.sendNotice(id, notice)
	}
	if username == "" {
		username = cm.usernameForIP(ip)
	}
	if _, err := cm.modActions.Record(chatActionWarn, ip, username, by, text, time.Time{}); err != nil {
		log.Printf("Chat: failed to record warning: %v", err)
	}
	cm.broadcastModState()
	return len(sessions)
}

// recordStrike handles a filter strike from a chat user. It sends an automatic
// warning, or applies the automatic chat ban at the limit. It returns true
// when the user was chat-banned.
func (cm *ChatManager) recordStrike(sessionID, username, ip string) bool {
	if ip == "" || strings.HasPrefix(username, "~") {
		return false
	}
	if cm.autoModExempt(sessionID, cm.sessionIsModerator(sessionID)) {
		return false
	}
	auto := cm.modSettings().AutoModeration
	if !auto.Enabled || auto.Strikes <= 0 {
		return false
	}
	window := time.Duration(auto.WindowMinutes) * time.Minute
	banLen := time.Duration(auto.ChatBanMinutes) * time.Minute
	now := cm.now()

	cm.modMu.Lock()
	kept := cm.strikes[ip][:0]
	for _, t := range cm.strikes[ip] {
		if window <= 0 || now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	cm.strikes[ip] = kept
	count := len(kept)
	cm.modMu.Unlock()

	if count >= auto.Strikes && banLen > 0 {
		reason := fmt.Sprintf("Automatic: %d bad messages within %d minutes", count, auto.WindowMinutes)
		if _, err := cm.ChatBan(ip, banLen, "auto", reason, username, false); err != nil {
			log.Printf("Chat: automatic chat ban failed: %v", err)
			return false
		}
		return true
	}

	text := fmt.Sprintf("Please keep chat clean — warning %d of %d. At %d you'll be banned from chat for %s.",
		count, auto.Strikes, auto.Strikes, formatChatDuration(banLen))
	cm.sendNotice(sessionID, map[string]interface{}{
		"kind":    "auto_warning",
		"text":    text,
		"strikes": count,
		"limit":   auto.Strikes,
	})
	if _, err := cm.modActions.Record(chatActionAutoWarn, ip, username, "auto", "Bad language or link", time.Time{}); err != nil {
		log.Printf("Chat: failed to record automatic warning: %v", err)
	}
	cm.broadcastModState()
	return false
}

// ModStateFor builds the chat_mod_state payload: chat bans in force and each
// username's warning count over the last 30 days.
func (cm *ChatManager) ModStateFor() map[string]interface{} {
	bans := cm.ChatBans()
	list := make([]map[string]interface{}, 0, len(bans))
	for _, b := range bans {
		list = append(list, map[string]interface{}{
			"username": b.Username,
			"ip":       b.IP,
			"until":    b.Until.UTC().Format(time.RFC3339),
			"by":       b.By,
			"reason":   b.Reason,
		})
	}
	warnings := cm.modActions.WarningsByUsername(cm.now().AddDate(0, 0, -chatRecordDays))
	return map[string]interface{}{
		"type": "chat_mod_state",
		"data": map[string]interface{}{
			"bans":     list,
			"warnings": warnings,
		},
	}
}
