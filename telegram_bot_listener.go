package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
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
	channelName      string
	cfg              NotificationChannelConfig
	sessions         *SessionManager
	rotctl           *RotctlAPIHandler    // nil if rotator not enabled
	antSwitch        *AntSwitchHandler    // nil if antenna switch not enabled
	noiseFloor       *NoiseFloorMonitor   // nil if noise floor monitoring not enabled
	pskRank          *PSKRankFetcher      // nil if PSK reporter not enabled
	wsprRank         *WSPRRankFetcher     // nil if WSPR rank not enabled
	rbnStore         *RBNDataStore        // nil if CW skimmer / RBN not enabled
	spaceWeather     *SpaceWeatherMonitor // nil if space weather monitoring not enabled
	chatManager      *ChatManager         // nil if chat not enabled
	gpsdoMonitor     *GPSDOMonitor        // nil if GPSDO not enabled
	adminHandler     *AdminHandler        // nil until wired; used by /monitor
	config           *Config              // nil until wired; used by /info
	instanceReporter *InstanceReporter    // nil until wired; used by /info (public URL)
	ipBanManager     *IPBanManager        // nil until wired; used by /banned
	// receiverCallsign is the callsign used for PSK/WSPR/RBN lookups.
	// Set from config.Decoder.ReceiverCallsign at wiring time.
	receiverCallsign string
	// cwSkimmerCallsign is the callsign used for RBN skimmer lookups.
	// Set from cwskimmerConfig.Callsign at wiring time.
	cwSkimmerCallsign string

	cancel context.CancelFunc
	done   chan struct{}

	client  *http.Client
	apiBase string

	mu      sync.RWMutex
	status  listenerStatus
	history []commandHistoryEntry // ring buffer, capped at maxCommandHistory

	// rotatorMoveMu guards rotatorMovePending so only one async move
	// confirmation goroutine runs at a time per listener.
	rotatorMoveMu      sync.Mutex
	rotatorMovePending bool
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
	// TelegramAPIResponse is the raw JSON body returned by Telegram's sendMessage API.
	TelegramAPIResponse string `json:"telegram_api_response,omitempty"`
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
		// Add optional commands that are enabled, in sorted order for determinism.
		for _, name := range sortedBotCommandNames() {
			if enabled[name] {
				cmds = append(cmds, tgBotCommand{
					Command:     name,
					Description: botCommands[name].desc,
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

	// Extract command and optional arguments.
	// e.g. "/rotator 180" → cmd="rotator", args="180"
	//      "/sessions@MyBot" → cmd="sessions", args=""
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
	// Everything after the command token is the argument string.
	args := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(text, parts[0]), " "))

	log.Printf("[TelegramListener:%s] received command /%s (args=%q) from chat %s", l.channelName, cmd, args, chatIDStr)

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
		resp, apiResp, apiOK := l.handleHelp(msg.Chat.ID, args)
		if apiOK {
			baseEntry.Result = "ok"
		} else {
			baseEntry.Result = "error"
		}
		baseEntry.Response = truncateResponse(resp)
		baseEntry.TelegramAPIResponse = apiResp
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

	// Dispatch to the registered handler (defined in telegram_bot_commands.go).
	// Pass args and whether write access is permitted for this command.
	if bc, ok := botCommands[cmd]; ok {
		resp, apiResp, apiOK := bc.handler(l, msg.Chat.ID, args)
		if apiOK {
			baseEntry.Result = "ok"
		} else {
			baseEntry.Result = "error"
		}
		baseEntry.Response = truncateResponse(resp)
		baseEntry.TelegramAPIResponse = apiResp
	} else {
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

// commandWriteEnabled reports whether write access (i.e. arguments that change
// hardware state) is permitted for cmd. A command must be both enabled and in
// the RWCommands list for write access to be granted.
func (l *TelegramBotListener) commandWriteEnabled(cmd string) bool {
	for _, c := range l.cfg.BotCommands.RWCommands {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// tgMaxMessageRunes is Telegram's sendMessage character limit (UTF-16 code units;
// we use runes as a conservative proxy — emoji count as 1 rune but 2 UTF-16 units,
// so we use a slightly lower limit to stay safely under the 4096 ceiling).
const tgMaxMessageRunes = 3800

// sendMessage sends a plain HTML message to the given chat ID.
// If the text exceeds tgMaxMessageRunes it is split on newline boundaries and
// sent as multiple consecutive messages so nothing is silently dropped.
// Returns the raw Telegram API JSON response from the last chunk sent.
// sendMessage sends text to chatID, splitting into chunks if needed.
// Returns (rawAPIResponse, allChunksOK). allChunksOK is false if any chunk
// received an ok:false response from Telegram.
func (l *TelegramBotListener) sendMessage(chatID int64, text string) (string, bool) {
	chunks := splitMessage(text, tgMaxMessageRunes)
	var lastAPIResp string
	allOK := true
	for _, chunk := range chunks {
		raw := l.sendMessageChunk(chatID, chunk)
		lastAPIResp = raw
		// Parse the response to detect Telegram-level errors (ok:false).
		var tgResp struct {
			OK bool `json:"ok"`
		}
		if err := json.Unmarshal([]byte(raw), &tgResp); err != nil || !tgResp.OK {
			allOK = false
		}
	}
	return lastAPIResp, allOK
}

// sendMessageChunk sends a single chunk (assumed to be within the size limit).
// It returns the raw JSON response body from Telegram's API for logging/debugging.
func (l *TelegramBotListener) sendMessageChunk(chatID int64, text string) string {
	payload := map[string]interface{}{
		"chat_id":                  chatID,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[TelegramListener:%s] sendMessage marshal error: %v", l.channelName, err)
		return ""
	}
	resp, err := l.client.Post(l.apiBase+"/sendMessage", "application/json", bytes.NewReader(body)) //nolint:noctx
	if err != nil {
		log.Printf("[TelegramListener:%s] sendMessage error: %v", l.channelName, err)
		return ""
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		log.Printf("[TelegramListener:%s] sendMessage HTTP %d: %s", l.channelName, resp.StatusCode, string(rawBody))
	}
	return string(rawBody)
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

// sendPhoto fetches imageURL (must be a QRZ CDN URL) and sends it to chatID
// via Telegram's sendPhoto endpoint with an HTML caption.
// Falls back to sending caption as a plain text message if the fetch or upload fails.
// Returns (rawAPIResponse, allChunksOK).
func (l *TelegramBotListener) sendPhoto(chatID int64, imageURL, caption string) (string, bool) {
	// Fetch the image bytes directly from the QRZ CDN.
	imgResp, err := l.client.Get(imageURL) //nolint:noctx
	if err != nil {
		log.Printf("[TelegramListener:%s] sendPhoto: fetch %s error: %v", l.channelName, imageURL, err)
		return l.sendMessage(chatID, caption)
	}
	defer imgResp.Body.Close()
	if imgResp.StatusCode != http.StatusOK {
		log.Printf("[TelegramListener:%s] sendPhoto: fetch %s returned %d", l.channelName, imageURL, imgResp.StatusCode)
		return l.sendMessage(chatID, caption)
	}
	imgBytes, err := io.ReadAll(io.LimitReader(imgResp.Body, 10*1024*1024)) // 10 MiB cap
	if err != nil || len(imgBytes) == 0 {
		log.Printf("[TelegramListener:%s] sendPhoto: read error: %v", l.channelName, err)
		return l.sendMessage(chatID, caption)
	}

	// Build multipart/form-data body.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	// chat_id field.
	_ = mw.WriteField("chat_id", fmt.Sprintf("%d", chatID))
	// parse_mode field.
	_ = mw.WriteField("parse_mode", "HTML")
	// caption field (Telegram caption limit is 1024 chars).
	cap := caption
	if len([]rune(cap)) > 1024 {
		runes := []rune(cap)
		cap = string(runes[:1024])
	}
	_ = mw.WriteField("caption", cap)

	// Determine filename extension from Content-Type.
	ct := imgResp.Header.Get("Content-Type")
	ext := ".jpg"
	switch {
	case strings.Contains(ct, "png"):
		ext = ".png"
	case strings.Contains(ct, "gif"):
		ext = ".gif"
	case strings.Contains(ct, "webp"):
		ext = ".webp"
	}
	fw, err := mw.CreateFormFile("photo", "photo"+ext)
	if err != nil {
		log.Printf("[TelegramListener:%s] sendPhoto: create form file error: %v", l.channelName, err)
		return l.sendMessage(chatID, caption)
	}
	if _, err := fw.Write(imgBytes); err != nil {
		log.Printf("[TelegramListener:%s] sendPhoto: write image error: %v", l.channelName, err)
		return l.sendMessage(chatID, caption)
	}
	mw.Close()

	resp, err := l.client.Post(l.apiBase+"/sendPhoto", mw.FormDataContentType(), &buf) //nolint:noctx
	if err != nil {
		log.Printf("[TelegramListener:%s] sendPhoto: upload error: %v", l.channelName, err)
		return l.sendMessage(chatID, caption)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)

	var tgResp struct {
		OK bool `json:"ok"`
	}
	_ = json.Unmarshal(rawBody, &tgResp)
	if !tgResp.OK {
		log.Printf("[TelegramListener:%s] sendPhoto: Telegram error: %s", l.channelName, string(rawBody))
		// Fall back to text message.
		return l.sendMessage(chatID, caption)
	}
	return string(rawBody), true
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
	mu                sync.RWMutex
	listeners         map[string]*TelegramBotListener
	sessions          *SessionManager
	rotctl            *RotctlAPIHandler    // nil if rotator not enabled
	antSwitch         *AntSwitchHandler    // nil if antenna switch not enabled
	noiseFloor        *NoiseFloorMonitor   // nil if noise floor monitoring not enabled
	pskRank           *PSKRankFetcher      // nil if PSK reporter not enabled
	wsprRank          *WSPRRankFetcher     // nil if WSPR rank not enabled
	rbnStore          *RBNDataStore        // nil if CW skimmer / RBN not enabled
	spaceWeather      *SpaceWeatherMonitor // nil if space weather monitoring not enabled
	chatManager       *ChatManager         // nil if chat not enabled
	gpsdoMonitor      *GPSDOMonitor        // nil if GPSDO not enabled
	adminHandler      *AdminHandler        // nil until wired; used by /monitor
	config            *Config              // nil until wired; used by /info
	instanceReporter  *InstanceReporter    // nil until wired; used by /info (public URL)
	ipBanManager      *IPBanManager        // nil until wired; used by /banned
	receiverCallsign  string               // from config.Decoder.ReceiverCallsign
	cwSkimmerCallsign string               // from cwskimmerConfig.Callsign
}

// NewTelegramListenerRegistry creates an empty registry.
func NewTelegramListenerRegistry(sessions *SessionManager) *TelegramListenerRegistry {
	return &TelegramListenerRegistry{
		listeners: make(map[string]*TelegramBotListener),
		sessions:  sessions,
	}
}

// SetRotctlHandler wires the rotator handler into all current and future listeners.
func (r *TelegramListenerRegistry) SetRotctlHandler(h *RotctlAPIHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rotctl = h
	for _, l := range r.listeners {
		l.rotctl = h
	}
}

// SetAntSwitchHandler wires the antenna switch handler into all current and future listeners.
func (r *TelegramListenerRegistry) SetAntSwitchHandler(h *AntSwitchHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.antSwitch = h
	for _, l := range r.listeners {
		l.antSwitch = h
	}
}

// SetNoiseFloorMonitor wires the noise floor monitor into all current and future listeners.
func (r *TelegramListenerRegistry) SetNoiseFloorMonitor(h *NoiseFloorMonitor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.noiseFloor = h
	for _, l := range r.listeners {
		l.noiseFloor = h
	}
}

// SetPSKRankFetcher wires the PSK rank fetcher into all current and future listeners.
func (r *TelegramListenerRegistry) SetPSKRankFetcher(h *PSKRankFetcher) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pskRank = h
	for _, l := range r.listeners {
		l.pskRank = h
	}
}

// SetWSPRRankFetcher wires the WSPR rank fetcher into all current and future listeners.
func (r *TelegramListenerRegistry) SetWSPRRankFetcher(h *WSPRRankFetcher) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.wsprRank = h
	for _, l := range r.listeners {
		l.wsprRank = h
	}
}

// SetRBNStore wires the RBN data store into all current and future listeners.
func (r *TelegramListenerRegistry) SetRBNStore(h *RBNDataStore) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rbnStore = h
	for _, l := range r.listeners {
		l.rbnStore = h
	}
}

// SetSpaceWeatherMonitor wires the space weather monitor into all current and future listeners.
func (r *TelegramListenerRegistry) SetSpaceWeatherMonitor(h *SpaceWeatherMonitor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.spaceWeather = h
	for _, l := range r.listeners {
		l.spaceWeather = h
	}
}

// SetAdminHandler wires the admin handler into all current and future listeners.
// The admin handler provides access to all subsystem health checks for /monitor.
func (r *TelegramListenerRegistry) SetAdminHandler(h *AdminHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.adminHandler = h
	for _, l := range r.listeners {
		l.adminHandler = h
	}
}

// SetConfig wires the server config into all current and future listeners.
func (r *TelegramListenerRegistry) SetConfig(c *Config) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.config = c
	for _, l := range r.listeners {
		l.config = c
	}
}

// SetInstanceReporter wires the instance reporter into all current and future listeners.
func (r *TelegramListenerRegistry) SetInstanceReporter(ir *InstanceReporter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.instanceReporter = ir
	for _, l := range r.listeners {
		l.instanceReporter = ir
	}
}

// SetIPBanManager wires the IP ban manager into all current and future listeners.
func (r *TelegramListenerRegistry) SetIPBanManager(h *IPBanManager) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ipBanManager = h
	for _, l := range r.listeners {
		l.ipBanManager = h
	}
}

// SetGPSDOMonitor wires the GPSDO monitor into all current and future listeners.
func (r *TelegramListenerRegistry) SetGPSDOMonitor(h *GPSDOMonitor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gpsdoMonitor = h
	for _, l := range r.listeners {
		l.gpsdoMonitor = h
	}
}

// SetChatManager wires the chat manager into all current and future listeners.
func (r *TelegramListenerRegistry) SetChatManager(h *ChatManager) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.chatManager = h
	for _, l := range r.listeners {
		l.chatManager = h
	}
}

// SetReceiverCallsign sets the receiver callsign used for PSK/WSPR lookups.
func (r *TelegramListenerRegistry) SetReceiverCallsign(cs string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.receiverCallsign = cs
	for _, l := range r.listeners {
		l.receiverCallsign = cs
	}
}

// SetCWSkimmerCallsign sets the CW skimmer callsign used for RBN lookups.
func (r *TelegramListenerRegistry) SetCWSkimmerCallsign(cs string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cwSkimmerCallsign = cs
	for _, l := range r.listeners {
		l.cwSkimmerCallsign = cs
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
		// Stop existing listener if config changed (token, chat, commands, or rw_commands).
		if existing, ok := r.listeners[name]; ok {
			oldCfg := existing.cfg
			if oldCfg.BotToken == ch.BotToken &&
				oldCfg.ChatID == ch.ChatID &&
				botCommandConfigEqual(oldCfg.BotCommands, ch.BotCommands) {
				continue // unchanged — keep running
			}
			existing.Stop()
			delete(r.listeners, name)
		}
		l := NewTelegramBotListener(name, ch, r.sessions)
		l.rotctl = r.rotctl
		l.antSwitch = r.antSwitch
		l.noiseFloor = r.noiseFloor
		l.pskRank = r.pskRank
		l.wsprRank = r.wsprRank
		l.rbnStore = r.rbnStore
		l.spaceWeather = r.spaceWeather
		l.chatManager = r.chatManager
		l.gpsdoMonitor = r.gpsdoMonitor
		l.adminHandler = r.adminHandler
		l.receiverCallsign = r.receiverCallsign
		l.cwSkimmerCallsign = r.cwSkimmerCallsign
		l.config = r.config
		l.instanceReporter = r.instanceReporter
		l.ipBanManager = r.ipBanManager
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

// botCommandConfigEqual reports whether two TelegramBotCommandsConfig values
// are equivalent (same enabled state, same commands, same rw_commands).
func botCommandConfigEqual(a, b TelegramBotCommandsConfig) bool {
	return a.Enabled == b.Enabled &&
		commandListsEqual(a.Commands, b.Commands) &&
		commandListsEqual(a.RWCommands, b.RWCommands)
}
