package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Chat rides the DX cluster socket, which is where the server hosts it. The
// protocol is a subscribe-then-join handshake:
//
//	→ {"type":"subscribe_chat"}          required before any chat_* message
//	→ {"type":"chat_set_username", …}    joins; until then we are a listener
//	→ {"type":"chat_message", …}         say something
//	→ {"type":"chat_set_frequency_mode"} publish where this receiver is tuned
//	→ {"type":"chat_request_users"}      ask for the roster
//	→ {"type":"chat_leave"}              leave, keeping the socket
//
// and back: chat_message, chat_user_joined, chat_user_left, chat_active_users,
// chat_user_update and chat_error.
//
// Not every receiver runs chat, so nothing here is started unless
// /api/description reports chat_enabled.

// Chat limits, matching the server's own validation in chat_websocket.go.
const (
	maxChatMessage  = 250
	maxChatUsername = 15
	maxChatLines    = 300 // transcript kept in memory
)

// chatLineKind distinguishes what a transcript line is, since they are styled
// and read differently.
type chatLineKind int

const (
	chatSaid   chatLineKind = iota // somebody spoke
	chatSystem                     // joins, leaves and local notes
	chatFailed                     // an error from the server
)

// ChatLine is one line of the transcript.
type ChatLine struct {
	At       time.Time
	Username string // empty on system and error lines
	Text     string
	Kind     chatLineKind
	Mention  bool // the message names us
	Own      bool // we sent it
}

// ChatUser is one entry of the roster, with wherever they are listening.
type ChatUser struct {
	Username  string
	Frequency float64
	Mode      string
	Idle      bool
	Country   string
}

// ChatState is a snapshot of everything the display needs. It is copied out of
// the client under its lock, so the UI never touches live state.
type ChatState struct {
	Available bool // this receiver runs chat at all
	Connected bool
	Joined    bool
	Username  string
	Lines     []ChatLine
	Users     []ChatUser

	// Received counts every message ever received, so the caller can tell how
	// many arrived since it last looked. The transcript itself is a ring and
	// its length stops growing.
	Received int
	Mentions int
}

// LastMention returns the most recent message naming us, which is what a
// notification needs to say who it was from.
func (s ChatState) LastMention() (ChatLine, bool) {
	for i := len(s.Lines) - 1; i >= 0; i-- {
		if s.Lines[i].Mention {
			return s.Lines[i], true
		}
	}
	return ChatLine{}, false
}

// ChatClient owns the socket and the chat state.
//
// It shares the spectrum session's UUID, so the server counts one user across
// the spectrum, audio and chat sockets. The /connection precheck must have run
// for that UUID first, which it has: the spectrum client does it before any
// socket is opened.
type ChatClient struct {
	host      string
	tls       bool
	sessionID string

	mu    sync.Mutex
	conn  *websocket.Conn
	state ChatState

	// Radio status last published, so an unchanged VFO is not re-sent, and the
	// pending flag for a change that arrived inside the rate limit window.
	sent        radioStatus
	pending     bool
	lastStatus  time.Time
	haveStatus  bool
	wantRejoin  bool // reconnected while joined; rejoin as soon as we are back
	outMessages chan map[string]interface{}

	// Everything the server replays from its buffer when we subscribe is
	// history, not news, and must not light up the unread indicator. There is
	// no flag on the wire for it, so it is taken as whatever arrives in the
	// first moment of a session — which is when the replay happens.
	replayUntil time.Time

	// subscribed is closed once the server confirms the chat subscription for
	// the current session, releasing the writer.
	subscribed chan struct{}

	// Updates carries a fresh snapshot whenever anything changes.
	Updates chan ChatState
}

// radioStatus is what we publish about ourselves.
type radioStatus struct {
	frequency float64
	mode      string
	bwLow     int
	bwHigh    int
	zoomBW    float64
}

// chatStatusInterval is the floor between status updates. The server rate
// limits these per user and answers a breach with an error line, so a drag
// across the band must not send one per frame.
const chatStatusInterval = time.Second

func NewChatClient(host string, useTLS bool, sessionID string) *ChatClient {
	return &ChatClient{
		host:      host,
		tls:       useTLS,
		sessionID: sessionID,
		// Availability comes from /api/description: plenty of receivers run no
		// chat at all, and nothing is drawn or connected until one says it does.
		state: ChatState{},
		// Deep enough for a burst of typing while the socket is down; a full
		// queue drops rather than blocking the UI.
		outMessages: make(chan map[string]interface{}, 16),
		Updates:     make(chan ChatState, 1),
	}
}

// SetAvailable records whether this receiver runs a chat, from the
// chat_enabled flag in /api/description. Run must not be started unless it does.
func (c *ChatClient) SetAvailable(available bool) {
	c.mu.Lock()
	c.state.Available = available
	c.mu.Unlock()
	c.publish()
}

// Run keeps the chat socket up until ctx is cancelled.
func (c *ChatClient) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}

		c.mu.Lock()
		c.state.Connected = false
		// A dropped socket loses our seat: the server removes the user when the
		// connection goes. Remember that we were in so the next session can
		// rejoin, which is also what the web and Python clients do.
		c.wantRejoin = c.state.Joined
		c.state.Joined = false
		c.state.Users = nil
		c.haveStatus = false // republish our tuning once we are back in
		if err != nil {
			c.note(fmt.Sprintf("chat disconnected: %v", err))
		}
		c.mu.Unlock()
		c.publish()

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (c *ChatClient) session(ctx context.Context) error {
	q := url.Values{}
	q.Set("user_session_id", c.sessionID)

	scheme := "ws"
	if c.tls {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/ws/dxcluster?%s", scheme, c.host, q.Encode())

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	dialer.NetDialContext = dialFunc()

	conn, resp, err := dialer.DialContext(ctx, wsURL, http.Header{
		"User-Agent": []string{userAgent},
	})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%w (HTTP %d)", err, resp.StatusCode)
		}
		return err
	}
	defer conn.Close()

	// Nothing chat-related may be sent until the server has confirmed the
	// subscription. It does not confirm synchronously — measured against a live
	// receiver, a chat_request_users sent straight after subscribe_chat comes
	// back as "you must subscribe to chat first" — so this is a real handshake
	// rather than a formality, and everything else waits behind it.
	if err := conn.WriteJSON(map[string]interface{}{"type": "subscribe_chat"}); err != nil {
		return err
	}
	subscribed := make(chan struct{})

	c.mu.Lock()
	c.conn = conn
	c.subscribed = subscribed
	c.state.Connected = true
	// The server replays its message buffer to every new subscriber, so the
	// transcript starts again from that replay rather than showing everything
	// twice after a reconnect.
	c.state.Lines = nil
	c.replayUntil = time.Now().Add(2 * time.Second)
	username, rejoin := c.state.Username, c.wantRejoin
	c.wantRejoin = false
	c.mu.Unlock()

	if rejoin && username != "" {
		c.mu.Lock()
		c.send(map[string]interface{}{"type": "chat_set_username", "username": username})
		c.mu.Unlock()
	}
	// Asking for the roster needs no username, which is what gives the header
	// its user count for someone who never joins.
	c.mu.Lock()
	c.request("chat_request_users")
	c.mu.Unlock()
	c.publish()

	// One writer: gorilla connections do not allow concurrent writes. It holds
	// off until the subscription is confirmed, which is what keeps a message
	// typed the moment the panel opened from being refused.
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		select {
		case <-ctx.Done():
			return
		case <-subscribed:
		}
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.outMessages:
				if err := conn.WriteJSON(msg); err != nil {
					return
				}
			}
		}
	}()

	// Unblock the read below when the context is cancelled.
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-writerDone:
		}
	}()

	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
	}()

	// The server pings every 30 s and drops a connection that has been quiet
	// for 60; gorilla answers pings for us, so the deadline only needs to
	// outlast that.
	for {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		var msg map[string]interface{}
		if err := conn.ReadJSON(&msg); err != nil {
			return err
		}
		c.handle(msg)
	}
}

// handle applies one server message.
func (c *ChatClient) handle(msg map[string]interface{}) {
	kind, _ := msg["type"].(string)
	if kind == "subscription_status" {
		// The go-ahead for everything else. Only the chat stream is ever
		// subscribed to, but the socket carries the spot streams too.
		if stream, _ := msg["stream"].(string); stream == "chat" {
			if enabled, _ := msg["enabled"].(bool); enabled {
				c.markSubscribed()
			}
		}
		return
	}
	if !strings.HasPrefix(kind, "chat_") {
		return // connection status, spot streams we never subscribed to
	}
	data, _ := msg["data"].(map[string]interface{})

	c.mu.Lock()
	switch kind {
	case "chat_message":
		username := chatString(data, "username")
		text := chatString(data, "message")
		own := strings.EqualFold(username, c.state.Username)
		mention := !own && c.mentionsUs(text)
		c.append(ChatLine{
			At:       chatTime(data),
			Username: username,
			Text:     text,
			Kind:     chatSaid,
			Own:      own,
			Mention:  mention,
		})
		// Replayed history is not news: counting it would open every session
		// with a screenful of unread messages nobody missed.
		if !time.Now().Before(c.replayUntil) {
			c.state.Received++
			if mention {
				c.state.Mentions++
			}
		}

	case "chat_user_joined":
		username := chatString(data, "username")
		if strings.EqualFold(username, c.state.Username) {
			// The server confirming our own join is what makes it official.
			c.state.Joined = true
			c.note("you joined as " + username)
			// Publish where this receiver is listening as soon as we are in.
			c.pending = true
		} else {
			c.note(username + " joined")
		}
		c.request("chat_request_users")

	case "chat_user_left":
		username := chatString(data, "username")
		if strings.EqualFold(username, c.state.Username) {
			c.state.Joined = false
			c.note("you left the chat")
		} else {
			c.note(username + " left")
		}
		c.request("chat_request_users")

	case "chat_active_users":
		if users, ok := data["users"].([]interface{}); ok {
			c.state.Users = parseChatUsers(users)
		}

	case "chat_user_update":
		c.updateUser(parseChatUser(data))

	case "chat_error":
		text, _ := msg["error"].(string)
		if text == "" {
			text = "chat error"
		}
		// The server forgets a session it has cleaned up, which it reports as
		// this. Rejoining silently is what the other clients do, and it is the
		// difference between a chat that survives a hiccup and one that dies.
		if text == "username not set" && c.state.Username != "" {
			c.state.Joined = false
			c.wantRejoin = false
			c.send(map[string]interface{}{
				"type":     "chat_set_username",
				"username": c.state.Username,
			})
			break
		}
		c.append(ChatLine{At: time.Now(), Text: text, Kind: chatFailed})
	}
	c.mu.Unlock()

	c.publish()
}

// markSubscribed releases the writer once the server has confirmed the chat
// subscription. Confirmations are not repeated, but a closed channel must not
// be closed twice.
func (c *ChatClient) markSubscribed() {
	c.mu.Lock()
	ch := c.subscribed
	c.subscribed = nil
	c.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// mentionsUs reports whether a message names us. Callers must hold the lock.
func (c *ChatClient) mentionsUs(text string) bool {
	if c.state.Username == "" {
		return false
	}
	return strings.Contains(strings.ToLower(text), "@"+strings.ToLower(c.state.Username))
}

// append adds a transcript line, discarding the oldest beyond the cap. Callers
// must hold the lock.
func (c *ChatClient) append(line ChatLine) {
	c.state.Lines = append(c.state.Lines, line)
	if n := len(c.state.Lines); n > maxChatLines {
		c.state.Lines = append([]ChatLine(nil), c.state.Lines[n-maxChatLines:]...)
	}
}

// note records a local system line. Callers must hold the lock.
func (c *ChatClient) note(text string) {
	c.append(ChatLine{At: time.Now(), Text: text, Kind: chatSystem})
}

// updateUser merges a single-user update into the roster. Callers must hold
// the lock.
func (c *ChatClient) updateUser(u ChatUser) {
	if u.Username == "" {
		return
	}
	for i, existing := range c.state.Users {
		if strings.EqualFold(existing.Username, u.Username) {
			c.state.Users[i] = u
			return
		}
	}
	c.state.Users = append(c.state.Users, u)
}

// send queues a message for the writer. Callers must hold the lock.
func (c *ChatClient) send(msg map[string]interface{}) {
	select {
	case c.outMessages <- msg:
	default: // queue full: the socket is down or wedged, so drop it
	}
}

// request queues a bare message that carries no fields. Callers must hold the
// lock.
func (c *ChatClient) request(kind string) {
	c.send(map[string]interface{}{"type": kind})
}

// publish hands the UI a fresh snapshot, coalescing with any it has not read
// yet: only the newest state is worth drawing.
func (c *ChatClient) publish() {
	c.mu.Lock()
	snap := c.state
	snap.Lines = append([]ChatLine(nil), c.state.Lines...)
	snap.Users = append([]ChatUser(nil), c.state.Users...)
	c.mu.Unlock()

	select {
	case <-c.Updates: // drop the stale snapshot; we are the only producer
	default:
	}
	select {
	case c.Updates <- snap:
	default:
	}
}

// Join asks to join under a username. The server has the final say — it may
// reject the name as taken or unacceptable — so state changes only when it
// confirms.
func (c *ChatClient) Join(username string) {
	c.mu.Lock()
	c.state.Username = username
	c.send(map[string]interface{}{"type": "chat_set_username", "username": username})
	c.mu.Unlock()
	c.publish()
}

// Say sends a message.
func (c *ChatClient) Say(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if len(text) > maxChatMessage {
		text = text[:maxChatMessage]
	}
	c.mu.Lock()
	c.send(map[string]interface{}{"type": "chat_message", "message": text})
	c.mu.Unlock()
}

// Leave leaves the chat but keeps the socket, so the user count stays visible
// and rejoining costs nothing.
func (c *ChatClient) Leave() {
	c.mu.Lock()
	c.request("chat_leave")
	c.state.Joined = false
	c.state.Username = ""
	c.haveStatus = false
	c.note("you left the chat")
	c.mu.Unlock()
	c.publish()
}

// SetRadio publishes where this receiver is tuned, which is the point of being
// in a receiver's chat: everyone can see what everyone else is listening to.
//
// It is called on every redraw, so it does the filtering: nothing is sent
// unless a value actually changed, and no more than one update per interval.
// A change inside that window is held and sent by the next call after it.
func (c *ChatClient) SetRadio(freq float64, mode string, bwLow, bwHigh int, zoomBW float64) {
	now := time.Now()
	status := radioStatus{frequency: freq, mode: mode, bwLow: bwLow, bwHigh: bwHigh, zoomBW: zoomBW}

	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.state.Joined || freq <= 0 || mode == "" {
		return
	}
	if c.haveStatus && status == c.sent && !c.pending {
		return
	}
	if status != c.sent {
		c.pending = true
	}
	if !c.pending {
		return
	}
	if c.haveStatus && now.Sub(c.lastStatus) < chatStatusInterval {
		return // hold it; the next call past the window sends the latest value
	}

	c.sent, c.haveStatus, c.pending, c.lastStatus = status, true, false, now
	msg := map[string]interface{}{
		"type":      "chat_set_frequency_mode",
		"frequency": int64(freq),
		"mode":      mode,
		"bw_low":    bwLow,
		"bw_high":   bwHigh,
	}
	// The server rejects a zero zoom bandwidth rather than ignoring it.
	if zoomBW > 0 {
		msg["zoom_bw"] = zoomBW
	}
	c.send(msg)
}

// State returns the current snapshot, for callers that want it without waiting
// for the next update.
func (c *ChatClient) State() ChatState {
	c.mu.Lock()
	defer c.mu.Unlock()
	snap := c.state
	snap.Lines = append([]ChatLine(nil), c.state.Lines...)
	snap.Users = append([]ChatUser(nil), c.state.Users...)
	return snap
}

// validChatUsername mirrors the server's rule: 1 to 15 characters, letters and
// digits plus - _ /, and neither end may be one of those three. Checking here
// turns a rejected join into an instant message rather than a round trip.
func validChatUsername(name string) error {
	if n := len([]rune(name)); n < 1 || n > maxChatUsername {
		return fmt.Errorf("a username is 1–%d characters", maxChatUsername)
	}
	for i, r := range name {
		alnum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		special := r == '-' || r == '_' || r == '/'
		if !alnum && !special {
			return fmt.Errorf("%q is not allowed: letters, digits, - _ / only", string(r))
		}
		if !alnum && (i == 0 || i == len(name)-1) {
			return fmt.Errorf("a username cannot start or end with %q", string(r))
		}
	}
	return nil
}

// chatString reads a string field, tolerating its absence: every field but the
// username is optional in at least one of the messages that carry it.
func chatString(data map[string]interface{}, key string) string {
	s, _ := data[key].(string)
	return s
}

// chatTime reads the RFC 3339 timestamp the server stamps messages with,
// falling back to now for anything it cannot parse.
func chatTime(data map[string]interface{}) time.Time {
	if s, ok := data["timestamp"].(string); ok {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.Local()
		}
	}
	return time.Now()
}

func parseChatUsers(raw []interface{}) []ChatUser {
	users := make([]ChatUser, 0, len(raw))
	for _, entry := range raw {
		if data, ok := entry.(map[string]interface{}); ok {
			if u := parseChatUser(data); u.Username != "" {
				users = append(users, u)
			}
		}
	}
	return users
}

func parseChatUser(data map[string]interface{}) ChatUser {
	u := ChatUser{
		Username: chatString(data, "username"),
		Mode:     chatString(data, "mode"),
		Country:  chatString(data, "country_code"),
	}
	// Frequency is omitted entirely until a user publishes one, and IQ-mode
	// users have a frequency but no mode.
	if f, ok := data["frequency"].(float64); ok {
		u.Frequency = f
	}
	if idle, ok := data["is_idle"].(bool); ok {
		u.Idle = idle
	}
	return u
}
