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

	mu     sync.RWMutex
	status listenerStatus
}

// listenerStatus is the runtime state reported to the admin UI.
type listenerStatus struct {
	Running   bool      `json:"running"`
	StartedAt time.Time `json:"started_at,omitempty"`
	LastPoll  time.Time `json:"last_poll,omitempty"`
	LastError string    `json:"last_error,omitempty"`
	Updates   int64     `json:"updates_processed"`
}

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

	log.Printf("[TelegramListener:%s] Started (commands: %v)", l.channelName, l.cfg.BotCommands.Commands)
}

// Stop cancels the polling goroutine and waits for it to exit.
func (l *TelegramBotListener) Stop() {
	if l.cancel != nil {
		l.cancel()
	}
	<-l.done
	log.Printf("[TelegramListener:%s] Stopped", l.channelName)
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
		return
	}

	// Only respond to admins/creators of the chat.
	if !l.isChatAdmin(msg.Chat.ID, msg.From) {
		return
	}

	// Extract command (strip bot username suffix, e.g. /stats@MyBot → /stats).
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

	// /help is always handled regardless of the enabled commands list so admins
	// can always discover what is available and what is disabled.
	if cmd == "help" {
		l.handleHelp(msg.Chat.ID)
		return
	}

	// All other commands require explicit enablement.
	if !l.commandEnabled(cmd) {
		return
	}

	switch cmd {
	case "stats":
		l.handleStats(msg.Chat.ID)
	}
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
// For private chats (type "private") every message is from the chat owner, so
// we always allow it.
func (l *TelegramBotListener) isChatAdmin(chatID int64, from *tgUser) bool {
	if from == nil {
		return false
	}

	// Private chats have no concept of admins — the only participant is the owner.
	// We allow all messages in private chats.
	// (The chat ID check in dispatch already ensures it's the right chat.)

	// For groups/supergroups/channels, verify via getChatMember.
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
		return false
	}

	switch result.Result.Status {
	case "creator", "administrator":
		return true
	default:
		return false
	}
}

// ─── Command handlers ─────────────────────────────────────────────────────────

// handleStats sends a summary of active sessions to the chat.
func (l *TelegramBotListener) handleStats(chatID int64) {
	if l.sessions == nil {
		l.sendMessage(chatID, "📡 Session data unavailable.")
		return
	}

	allSessions := l.sessions.GetAllSessionsInfo()

	// Filter to real audio sessions only (exclude spectrum-only and internal).
	type sessionRow struct {
		freq      uint64
		mode      string
		country   string
		countryCC string
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
		country, _ := s["country"].(string)
		cc, _ := s["country_code"].(string)
		rows = append(rows, sessionRow{freq: freq, mode: mode, country: country, countryCC: cc})
	}

	if len(rows) == 0 {
		l.sendMessage(chatID, "📡 No active listeners right now.")
		return
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "📡 <b>Active Sessions: %d</b>\n\n", len(rows))
	for i, r := range rows {
		flag := countryCodeToFlag(r.countryCC)
		freqMHz := float64(r.freq) / 1000.0
		fmt.Fprintf(&sb, "%d. %.3f MHz | %s | %s %s\n", i+1, freqMHz, r.mode, flag, r.country)
	}

	l.sendMessage(chatID, sb.String())
}

// allKnownCommands is the complete list of built-in commands with descriptions.
// The order here determines the order shown in /help.
var allKnownCommands = []struct {
	name string
	desc string
}{
	{"stats", "Show active listener sessions"},
	{"help", "Show this help message"},
}

// handleHelp sends a list of all known commands, marking each as enabled or
// disabled based on the current config. /help itself is always available.
func (l *TelegramBotListener) handleHelp(chatID int64) {
	var sb strings.Builder
	sb.WriteString("🤖 <b>Bot Commands</b>\n\n")

	for _, kc := range allKnownCommands {
		enabled := kc.name == "help" || l.commandEnabled(kc.name)
		if enabled {
			sb.WriteString("✅ /" + kc.name + " — " + kc.desc + "\n")
		} else {
			sb.WriteString("❌ /" + kc.name + " — " + kc.desc + " <i>(disabled)</i>\n")
		}
	}

	sb.WriteString("\n<i>Only chat admins can use these commands.</i>")
	l.sendMessage(chatID, sb.String())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// sendMessage sends a plain HTML message to the given chat ID.
func (l *TelegramBotListener) sendMessage(chatID int64, text string) {
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
