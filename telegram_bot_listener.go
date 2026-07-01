package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─── Types ────────────────────────────────────────────────────────────────────

// tgUpdate is the minimal subset of a Telegram Update object we need.
type tgUpdate struct {
	UpdateID int64      `json:"update_id"`
	Message  *tgMessage `json:"message,omitempty"`
}

// tgMessage is the minimal subset of a Telegram Message object we need.
type tgMessage struct {
	MessageID int64   `json:"message_id"`
	From      *tgUser `json:"from,omitempty"`
	Chat      tgChat  `json:"chat"`
	Text      string  `json:"text,omitempty"`
}

// tgUser is the minimal Telegram User object.
type tgUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	Username  string `json:"username,omitempty"`
}

// tgChat is the minimal Telegram Chat object.
type tgChat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

// tgChatMember is the minimal Telegram ChatMember object.
type tgChatMember struct {
	Status string  `json:"status"` // "creator", "administrator", "member", …
	User   *tgUser `json:"user,omitempty"`
}

// ─── Listener ─────────────────────────────────────────────────────────────────

// TelegramBotListener runs a long-polling loop for a single Telegram channel
// and dispatches /commands sent by chat admins to built-in handlers.
//
// Lifecycle:
//
//	listener := NewTelegramBotListener(name, cfg, sessions)
//	listener.Start()   // launches goroutine
//	// … later …
//	listener.Stop()    // cancels context, goroutine exits cleanly
type TelegramBotListener struct {
	channelName string
	cfg         NotificationChannelConfig
	sessions    *SessionManager

	cancel context.CancelFunc
	done   chan struct{}

	client  *http.Client
	apiBase string

	mu      sync.RWMutex
	status  listenerStatus
	history []commandHistoryEntry // ring buffer, capped at maxCommandHistory
}

// listenerStatus is the runtime state reported to the admin UI.
type listenerStatus struct {
	Running   bool      `json:"running"`
	StartedAt time.Time `json:"started_at,omitempty"`
	LastPoll  time.Time `json:"last_poll,omitempty"`
	LastError string    `json:"last_error,omitempty"`
	Updates   int64     `json:"updates_processed"`
}

// commandHistoryEntry records a single command received by the bot.
type commandHistoryEntry struct {
	At       time.Time `json:"at"`
	Command  string    `json:"command"`
	ChatID   int64     `json:"chat_id"`
	ChatType string    `json:"chat_type"`
	UserID   int64     `json:"user_id"`
	Username string    `json:"username,omitempty"`
	// Result is "ok", "not_enabled", "not_admin", or an error string.
	Result string `json:"result"`
	// Response is the first 200 chars of the message the bot sent back (if any).
	Response string `json:"response,omitempty"`
}

const maxCommandHistory = 20

// NewTelegramBotListener creates a listener but does not start it.
func NewTelegramBotListener(name string, cfg NotificationChannelConfig, sessions *SessionManager) *TelegramBotListener {
	return &TelegramBotListener{
		channelName: name,
		cfg:         cfg,
		sessions:    sessions,
		done:        make(chan struct{}),
		client:      &http.Client{Timeout: 40 * time.Second}, // must exceed long-poll timeout
		apiBase:     fmt.Sprintf("https://api.telegram.org/bot%s", cfg.BotToken),
	}
}

// Start launches the long-polling goroutine. Safe to call only once.
func (l *TelegramBotListener) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	l.cancel = cancel

	l.mu.Lock()
	l.status.Running = true
	l.status.StartedAt = time.Now()
	l.mu.Unlock()

	go func() {
		defer close(l.done)
		defer func() {
			l.mu.Lock()
			l.status.Running = false
			l.mu.Unlock()
		}()
		l.pollLoop(ctx)
	}()

	// Auto-register enabled commands with Telegram so they appear in the /
	// autocomplete menu without the user having to configure them manually.
	go l.syncBotCommands(l.cfg.BotCommands.Commands)

	log.Printf("[TelegramListener:%s] Started (commands: %v)", l.channelName, l.cfg.BotCommands.Commands)
}

// Stop cancels the polling goroutine and waits for it to exit.
// It also clears the bot command menu so stale commands are not shown after
// the listener is disabled.
func (l *TelegramBotListener) Stop() {
	if l.cancel != nil {
		l.cancel()
	}
	<-l.done
	// Clear the Telegram command menu now that the listener is stopped.
	go l.syncBotCommands(nil)
	log.Printf("[TelegramListener:%s] Stopped", l.channelName)
}

// recordCommand appends an entry to the in-memory command history ring buffer.
// The buffer is capped at maxCommandHistory; oldest entries are dropped first.
func (l *TelegramBotListener) recordCommand(entry commandHistoryEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.history = append(l.history, entry)
	if len(l.history) > maxCommandHistory {
		l.history = l.history[len(l.history)-maxCommandHistory:]
	}
}

// GetHistory returns a copy of the command history, newest-first.
func (l *TelegramBotListener) GetHistory() []commandHistoryEntry {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if len(l.history) == 0 {
		return nil
	}
	out := make([]commandHistoryEntry, len(l.history))
	// Reverse so newest is first.
	for i, e := range l.history {
		out[len(l.history)-1-i] = e
	}
	return out
}

// syncBotCommands registers (or clears) the bot's command menu via
// setMyCommands so that Telegram shows the / autocomplete list automatically.
//
// Pass a non-nil slice of command names to register; pass nil (or empty) to
// clear all commands.
//
// /help is always included when registering because it is always handled.
func (l *TelegramBotListener) syncBotCommands(enabledCmds []string) {
	type tgBotCommand struct {
		Command     string `json:"command"`
		Description string `json:"description"`
	}

	// Build a set of enabled optional command names for fast lookup.
	enabled := make(map[string]bool, len(enabledCmds))
	for _, c := range enabledCmds {
		enabled[strings.ToLower(c)] = true
	}

	var cmds []tgBotCommand
	// nil enabledCmds signals "stop the listener — clear the menu".
	// A non-nil slice (even empty) means the listener is active, so /help is
	// always registered.
	if enabledCmds != nil {
		// Add optional commands that are enabled.
		for _, kc := range allKnownCommands {
			if enabled[kc.name] {
				cmds = append(cmds, tgBotCommand{
					Command:     kc.name,
					Description: kc.desc,
				})
			}
		}
		// /help is always registered when the listener is active.
		cmds = append(cmds, tgBotCommand{
			Command:     "help",
			Description: "Show available commands",
		})
	}
	// nil enabledCmds → clear the menu (cmds stays empty).

	payload := map[string]interface{}{
		"commands": cmds,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[TelegramListener:%s] syncBotCommands marshal error: %v", l.channelName, err)
		return
	}
	resp, err := l.client.Post(l.apiBase+"/setMyCommands", "application/json", bytes.NewReader(body)) //nolint:noctx
	if err != nil {
		log.Printf("[TelegramListener:%s] setMyCommands error: %v", l.channelName, err)
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	var result struct {
		OK          bool   `json:"ok"`
		Description string `json:"description,omitempty"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil || !result.OK {
		log.Printf("[TelegramListener:%s] setMyCommands failed: %s", l.channelName, string(respBody))
		return
	}
	if len(cmds) == 0 {
		log.Printf("[TelegramListener:%s] setMyCommands: cleared command menu", l.channelName)
	} else {
		names := make([]string, len(cmds))
		for i, c := range cmds {
			names[i] = "/" + c.Command
		}
		log.Printf("[TelegramListener:%s] setMyCommands: registered %v", l.channelName, names)
	}
}

// Status returns a snapshot of the listener's runtime state.
func (l *TelegramBotListener) Status() listenerStatus {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.status
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

func (l *TelegramBotListener) pollLoop(ctx context.Context) {
	var offset int64
	backoff := time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		updates, err := l.getUpdates(ctx, offset, 30)
		if err != nil {
			if ctx.Err() != nil {
				return // context cancelled — clean exit
			}
			l.mu.Lock()
			l.status.LastError = err.Error()
			l.mu.Unlock()
			log.Printf("[TelegramListener:%s] getUpdates error: %v (retry in %v)", l.channelName, err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = minDuration(backoff*2, 60*time.Second)
			continue
		}

		backoff = time.Second // reset on success

		l.mu.Lock()
		l.status.LastPoll = time.Now()
		l.status.LastError = ""
		l.mu.Unlock()

		for _, upd := range updates {
			if upd.UpdateID >= offset {
				offset = upd.UpdateID + 1
			}
			l.dispatch(upd)
			l.mu.Lock()
			l.status.Updates++
			l.mu.Unlock()
		}
	}
}

// getUpdates calls the Telegram getUpdates API with long-polling.
func (l *TelegramBotListener) getUpdates(ctx context.Context, offset int64, timeoutSecs int) ([]tgUpdate, error) {
	url := fmt.Sprintf("%s/getUpdates?offset=%d&limit=100&timeout=%d&allowed_updates=[\"message\"]",
		l.apiBase, offset, timeoutSecs)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := l.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result struct {
		OK     bool       `json:"ok"`
		Result []tgUpdate `json:"result"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("getUpdates: unmarshal error: %w", err)
	}
	if !result.OK {
		return nil, fmt.Errorf("getUpdates: Telegram returned ok=false: %s", string(body))
	}
	return result.Result, nil
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

// dispatch routes a single update to the appropriate command handler.
// It silently ignores non-command messages and messages from other chats.
func (l *TelegramBotListener) dispatch(upd tgUpdate) {
	msg := upd.Message
	if msg == nil || msg.Text == "" {
		return
	}

	// Only respond to the configured chat.
	chatIDStr := strconv.FormatInt(msg.Chat.ID, 10)
	if chatIDStr != l.cfg.ChatID {
		log.Printf("[TelegramListener:%s] ignoring message from chat %s (want %s)",
			l.channelName, chatIDStr, l.cfg.ChatID)
		return
	}

	// Only respond to admins/creators of the chat.
	if !l.isChatAdmin(msg.Chat.ID, msg.Chat.Type, msg.From) {
		fromID := int64(0)
		if msg.From != nil {
			fromID = msg.From.ID
		}
		log.Printf("[TelegramListener:%s] user %d is not an admin in chat %s (%s) — ignoring",
			l.channelName, fromID, chatIDStr, msg.Chat.Type)
		return
	}

	// Extract command (strip bot username suffix, e.g. /sessions@MyBot → /sessions).
	text := strings.TrimSpace(msg.Text)
	if !strings.HasPrefix(text, "/") {
		return
	}
	parts := strings.Fields(text)
	rawCmd := parts[0]
	// Strip @botname suffix if present.
	if idx := strings.Index(rawCmd, "@"); idx >= 0 {
		rawCmd = rawCmd[:idx]
	}
	cmd := strings.ToLower(strings.TrimPrefix(rawCmd, "/"))

	log.Printf("[TelegramListener:%s] received command /%s from chat %s", l.channelName, cmd, chatIDStr)

	// Build a base history entry for this command.
	var userID int64
	var username string
	if msg.From != nil {
		userID = msg.From.ID
		username = msg.From.Username
	}
	baseEntry := commandHistoryEntry{
		At:       time.Now(),
		Command:  "/" + cmd,
		ChatID:   msg.Chat.ID,
		ChatType: msg.Chat.Type,
		UserID:   userID,
		Username: username,
	}

	// /help is always handled regardless of the enabled commands list so admins
	// can always discover what is available and what is disabled.
	if cmd == "help" {
		resp := l.handleHelp(msg.Chat.ID)
		baseEntry.Result = "ok"
		baseEntry.Response = truncateResponse(resp)
		l.recordCommand(baseEntry)
		return
	}

	// All other commands require explicit enablement.
	if !l.commandEnabled(cmd) {
		log.Printf("[TelegramListener:%s] command /%s is not enabled — ignoring", l.channelName, cmd)
		baseEntry.Result = "not_enabled"
		l.recordCommand(baseEntry)
		return
	}

	switch cmd {
	case "sessions":
		resp := l.handleSessions(msg.Chat.ID)
		baseEntry.Result = "ok"
		baseEntry.Response = truncateResponse(resp)
	default:
		baseEntry.Result = "unknown_command"
	}
	l.recordCommand(baseEntry)
}

// truncateResponse strips HTML tags and truncates the response to 200 runes
// for compact storage in the command history.
func truncateResponse(s string) string {
	// Strip simple HTML tags (bold, italic, code) used in bot responses.
	var out strings.Builder
	inTag := false
	for _, r := range s {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag:
			out.WriteRune(r)
		}
	}
	clean := strings.TrimSpace(out.String())
	runes := []rune(clean)
	if len(runes) > 200 {
		return string(runes[:200]) + "…"
	}
	return clean
}

// commandEnabled reports whether cmd is in the configured commands list.
func (l *TelegramBotListener) commandEnabled(cmd string) bool {
	for _, c := range l.cfg.BotCommands.Commands {
		if strings.ToLower(c) == cmd {
			return true
		}
	}
	return false
}

// isChatAdmin returns true if the user is a creator or administrator of the chat.
//
// For private chats (type "private") the only participant is the bot owner, so
// we always allow it — getChatMember is not available for private chats and
// would return an error.
//
// For groups/supergroups/channels we verify via getChatMember.
func (l *TelegramBotListener) isChatAdmin(chatID int64, chatType string, from *tgUser) bool {
	if from == nil {
		return false
	}

	// Private chats: always allow (only the owner can DM the bot).
	if chatType == "private" {
		log.Printf("[TelegramListener:%s] private chat — allowing user %d", l.channelName, from.ID)
		return true
	}

	// Groups/supergroups/channels: verify admin status.
	url := fmt.Sprintf("%s/getChatMember?chat_id=%d&user_id=%d", l.apiBase, chatID, from.ID)
	resp, err := l.client.Get(url) //nolint:noctx
	if err != nil {
		log.Printf("[TelegramListener:%s] getChatMember error: %v", l.channelName, err)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var result struct {
		OK     bool         `json:"ok"`
		Result tgChatMember `json:"result"`
	}
	if err := json.Unmarshal(body, &result); err != nil || !result.OK {
		log.Printf("[TelegramListener:%s] getChatMember parse error or ok=false: %s", l.channelName, string(body))
		return false
	}

	log.Printf("[TelegramListener:%s] user %d status in chat %d: %s",
		l.channelName, from.ID, chatID, result.Result.Status)

	switch result.Result.Status {
	case "creator", "administrator":
		return true
	default:
		return false
	}
}

// ─── Command handlers ─────────────────────────────────────────────────────────

// handleStats sends a summary of active sessions to the chat and returns the
// plain-text summary that was sent (for history recording).
func (l *TelegramBotListener) handleSessions(chatID int64) string {
	if l.sessions == nil {
		msg := "📡 Session data unavailable."
		l.sendMessage(chatID, msg)
		return msg
	}

	allSessions := l.sessions.GetAllSessionsInfo()

	// Filter to real audio sessions only (exclude spectrum-only and internal).
	type sessionRow struct {
		freq       uint64
		mode       string
		clientIP   string
		country    string
		countryCC  string
		isBypassed bool
		createdAt  time.Time
	}
	var rows []sessionRow
	for _, s := range allSessions {
		isSpectrum, _ := s["is_spectrum"].(bool)
		isInternal, _ := s["is_internal"].(bool)
		if isSpectrum || isInternal {
			continue
		}
		freq, _ := s["frequency"].(uint64)
		mode, _ := s["mode"].(string)
		clientIP, _ := s["client_ip"].(string)
		country, _ := s["country"].(string)
		cc, _ := s["country_code"].(string)
		bypassed, _ := s["is_bypassed"].(bool)
		var createdAt time.Time
		if ts, ok := s["created_at"].(string); ok {
			createdAt, _ = time.Parse(time.RFC3339, ts)
		}
		rows = append(rows, sessionRow{freq: freq, mode: mode, clientIP: clientIP, country: country, countryCC: cc, isBypassed: bypassed, createdAt: createdAt})
	}

	if len(rows) == 0 {
		msg := "📡 No active listeners right now."
		l.sendMessage(chatID, msg)
		return msg
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>Active Sessions: %d</b>\n\n", len(rows))
	for i, r := range rows {
		freqMHz := float64(r.freq) / 1_000_000.0
		// Build suffix: IP, optional flag+country, optional bypassed tag, duration.
		var suffix strings.Builder
		if r.clientIP != "" {
			suffix.WriteString(" | ")
			suffix.WriteString(r.clientIP)
		}
		if r.country != "" {
			flag := countryCodeToFlag(r.countryCC)
			suffix.WriteString(" ")
			if flag != "" {
				suffix.WriteString(flag)
				suffix.WriteString(" ")
			}
			suffix.WriteString(r.country)
		}
		if r.isBypassed {
			suffix.WriteString(" [bypassed]")
		}
		if !r.createdAt.IsZero() {
			suffix.WriteString(" | ")
			suffix.WriteString(fmtSessionDuration(time.Since(r.createdAt)))
		}
		fmt.Fprintf(&sb, "%d. %.3f MHz | %s%s\n", i+1, freqMHz, r.mode, suffix.String())
	}

	msg := sb.String()
	l.sendMessage(chatID, msg)
	return msg
}

// allKnownCommands is the list of optional built-in commands (excludes /help
// which is always enabled). The order here determines the order shown in /help.
var allKnownCommands = []struct {
	name string
	desc string
}{
	{"sessions", "Show active listener sessions"},
}

// handleHelp sends a list of all known commands, marking each as enabled or
// disabled based on the current config.
//
// /help is always shown as enabled at the end — it cannot be disabled.
// Returns the plain-text message sent (for history recording).
func (l *TelegramBotListener) handleHelp(chatID int64) string {
	var sb strings.Builder
	sb.WriteString("🤖 <b>Bot Commands</b>\n\n")

	for _, kc := range allKnownCommands {
		if l.commandEnabled(kc.name) {
			sb.WriteString("✅ /" + kc.name + " — " + kc.desc + "\n")
		} else {
			sb.WriteString("❌ /" + kc.name + " — " + kc.desc + " <i>(disabled)</i>\n")
		}
	}
	// /help is always available — show it last, always enabled.
	sb.WriteString("✅ /help — Show this help message\n")

	sb.WriteString("\n<i>Only chat admins can use these commands.</i>")
	msg := sb.String()
	l.sendMessage(chatID, msg)
	return msg
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// tgMaxMessageRunes is Telegram's sendMessage character limit (UTF-16 code units;
// we use runes as a conservative proxy — emoji count as 1 rune but 2 UTF-16 units,
// so we use a slightly lower limit to stay safely under the 4096 ceiling).
const tgMaxMessageRunes = 3800

// sendMessage sends a plain HTML message to the given chat ID.
// If the text exceeds tgMaxMessageRunes it is split on newline boundaries and
// sent as multiple consecutive messages so nothing is silently dropped.
func (l *TelegramBotListener) sendMessage(chatID int64, text string) {
	chunks := splitMessage(text, tgMaxMessageRunes)
	for _, chunk := range chunks {
		l.sendMessageChunk(chatID, chunk)
	}
}

// sendMessageChunk sends a single chunk (assumed to be within the size limit).
func (l *TelegramBotListener) sendMessageChunk(chatID int64, text string) {
	payload := map[string]interface{}{
		"chat_id":                  chatID,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[TelegramListener:%s] sendMessage marshal error: %v", l.channelName, err)
		return
	}
	resp, err := l.client.Post(l.apiBase+"/sendMessage", "application/json", bytes.NewReader(body)) //nolint:noctx
	if err != nil {
		log.Printf("[TelegramListener:%s] sendMessage error: %v", l.channelName, err)
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) //nolint:errcheck
}

// splitMessage splits text into chunks of at most maxRunes runes, breaking on
// newline boundaries where possible to avoid cutting mid-line.
func splitMessage(text string, maxRunes int) []string {
	runes := []rune(text)
	if len(runes) <= maxRunes {
		return []string{text}
	}
	var chunks []string
	for len(runes) > 0 {
		if len(runes) <= maxRunes {
			chunks = append(chunks, string(runes))
			break
		}
		// Find the last newline within the limit.
		cut := maxRunes
		for i := maxRunes - 1; i > 0; i-- {
			if runes[i] == '\n' {
				cut = i + 1 // include the newline in this chunk
				break
			}
		}
		chunks = append(chunks, string(runes[:cut]))
		runes = runes[cut:]
	}
	return chunks
}

// countryCodeToFlag converts an ISO 3166-1 alpha-2 country code to a flag emoji.
// Returns an empty string for unknown/empty codes.
func countryCodeToFlag(cc string) string {
	if len(cc) != 2 {
		return ""
	}
	cc = strings.ToUpper(cc)
	r1 := rune(cc[0]) - 'A' + 0x1F1E6
	r2 := rune(cc[1]) - 'A' + 0x1F1E6
	return string([]rune{r1, r2})
}

// fmtSessionDuration formats a session duration as a human-friendly string.
// Examples: "<1m", "45m", "1h15m", "3h".
func fmtSessionDuration(d time.Duration) string {
	if d < time.Minute {
		return "<1m"
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h == 0 {
		return fmt.Sprintf("%dm", m)
	}
	if m == 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dh%dm", h, m)
}

// minDuration returns the smaller of two durations.
func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// ─── Manager registry ─────────────────────────────────────────────────────────

// TelegramListenerRegistry manages the set of active TelegramBotListeners,
// keyed by channel name. It is embedded in NotificationManager.
type TelegramListenerRegistry struct {
	mu        sync.RWMutex
	listeners map[string]*TelegramBotListener
	sessions  *SessionManager
}

// NewTelegramListenerRegistry creates an empty registry.
func NewTelegramListenerRegistry(sessions *SessionManager) *TelegramListenerRegistry {
	return &TelegramListenerRegistry{
		listeners: make(map[string]*TelegramBotListener),
		sessions:  sessions,
	}
}

// Sync reconciles the running listeners with the new config.
// Listeners for channels that no longer exist or have the feature disabled are
// stopped; new ones are started for channels that have it enabled.
func (r *TelegramListenerRegistry) Sync(cfg *NotificationsConfig) {
	if cfg == nil {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Stop listeners for channels that are gone or disabled.
	for name, l := range r.listeners {
		ch, ok := cfg.Channels[name]
		if !ok || ch.Type != "telegram" || !ch.BotCommands.Enabled || ch.BotToken == "" {
			l.Stop()
			delete(r.listeners, name)
		}
	}

	if !cfg.Enabled {
		return
	}

	// Start listeners for new/updated channels.
	for name, ch := range cfg.Channels {
		if ch.Type != "telegram" || !ch.BotCommands.Enabled || ch.BotToken == "" {
			continue
		}
		// Stop existing listener if config changed (token or commands list).
		if existing, ok := r.listeners[name]; ok {
			oldCfg := existing.cfg
			if oldCfg.BotToken == ch.BotToken &&
				oldCfg.ChatID == ch.ChatID &&
				commandListsEqual(oldCfg.BotCommands.Commands, ch.BotCommands.Commands) {
				continue // unchanged — keep running
			}
			existing.Stop()
			delete(r.listeners, name)
		}
		l := NewTelegramBotListener(name, ch, r.sessions)
		l.Start()
		r.listeners[name] = l
	}
}

// StopAll stops all running listeners. Called on server shutdown.
func (r *TelegramListenerRegistry) StopAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, l := range r.listeners {
		l.Stop()
		delete(r.listeners, name)
	}
}

// GetStatus returns a map of channel name → listenerStatus for all listeners.
func (r *TelegramListenerRegistry) GetStatus() map[string]listenerStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]listenerStatus, len(r.listeners))
	for name, l := range r.listeners {
		out[name] = l.Status()
	}
	return out
}

// GetCommandHistory returns a map of channel name → command history (newest-first)
// for all active listeners.
func (r *TelegramListenerRegistry) GetCommandHistory() map[string][]commandHistoryEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string][]commandHistoryEntry, len(r.listeners))
	for name, l := range r.listeners {
		out[name] = l.GetHistory()
	}
	return out
}

// commandListsEqual reports whether two command slices contain the same elements
// (order-insensitive).
func commandListsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[string]bool, len(a))
	for _, v := range a {
		set[strings.ToLower(v)] = true
	}
	for _, v := range b {
		if !set[strings.ToLower(v)] {
			return false
		}
	}
	return true
}
