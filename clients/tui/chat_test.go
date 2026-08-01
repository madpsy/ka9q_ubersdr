package main

import (
	"strings"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
)

// newTestChat builds a client with no socket: handle() is fed directly, which
// is exactly what the read loop does with what the server sends.
func newTestChat() *ChatClient {
	c := NewChatClient("sim.example.org:8080", false, "00000000-0000-4000-8000-000000000000")
	c.SetAvailable(true)
	// Past the replay window, so messages count as news rather than history.
	c.replayUntil = time.Now().Add(-time.Second)
	return c
}

// said builds the message the server broadcasts for a spoken line.
func said(username, text string) map[string]interface{} {
	return map[string]interface{}{
		"type": "chat_message",
		"data": map[string]interface{}{
			"username":  username,
			"message":   text,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		},
	}
}

func TestChatCollectsTheTranscript(t *testing.T) {
	c := newTestChat()
	c.handle(said("alice", "morning all"))
	c.handle(map[string]interface{}{
		"type": "chat_user_joined",
		"data": map[string]interface{}{"username": "bob"},
	})
	c.handle(said("bob", "anyone on 40?"))

	st := c.State()
	if st.Received != 2 {
		t.Errorf("counted %d messages, want 2", st.Received)
	}
	if len(st.Lines) != 3 {
		t.Fatalf("transcript has %d lines, want 3", len(st.Lines))
	}
	if st.Lines[1].Kind != chatSystem || !strings.Contains(st.Lines[1].Text, "bob") {
		t.Errorf("the join was not noted: %+v", st.Lines[1])
	}
}

// Joining is the server's decision: it is in force when the server says so,
// and until then a rejected name must not look accepted.
func TestChatJoinsWhenTheServerConfirms(t *testing.T) {
	c := newTestChat()
	c.Join("m0abc")
	if c.State().Joined {
		t.Fatal("joined before the server said anything")
	}

	c.handle(map[string]interface{}{
		"type": "chat_user_joined",
		"data": map[string]interface{}{"username": "m0abc"},
	})
	st := c.State()
	if !st.Joined || st.Username != "m0abc" {
		t.Fatalf("join not registered: joined=%v username=%q", st.Joined, st.Username)
	}

	// A message naming us is marked; our own is not, however it is addressed.
	c.handle(said("alice", "@m0abc what's your antenna?"))
	c.handle(said("m0abc", "a wire, @alice"))
	lines := c.State().Lines
	last, prev := lines[len(lines)-1], lines[len(lines)-2]
	if !prev.Mention {
		t.Error("a message naming us was not marked as a mention")
	}
	if !last.Own || last.Mention {
		t.Errorf("our own message is own=%v mention=%v", last.Own, last.Mention)
	}
	if c.State().Mentions != 1 {
		t.Errorf("counted %d mentions, want 1", c.State().Mentions)
	}
}

// The server replays its message buffer to every new subscriber. That is
// history: it must appear in the transcript without being counted as unread.
func TestChatReplayIsNotCountedAsNew(t *testing.T) {
	c := newTestChat()
	c.replayUntil = time.Now().Add(time.Second) // as a fresh session sets it

	c.handle(said("alice", "this was said before we arrived"))
	if st := c.State(); st.Received != 0 || len(st.Lines) != 1 {
		t.Errorf("replay counted: received=%d lines=%d", st.Received, len(st.Lines))
	}

	c.replayUntil = time.Now().Add(-time.Millisecond)
	c.handle(said("alice", "this is live"))
	if st := c.State(); st.Received != 1 {
		t.Errorf("live message counted %d, want 1", st.Received)
	}
}

// A server that has forgotten our session says so; rejoining silently is what
// keeps a chat alive across a server-side cleanup.
func TestChatRejoinsWhenTheServerForgetsUs(t *testing.T) {
	c := newTestChat()
	c.Join("m0abc")
	c.handle(map[string]interface{}{
		"type": "chat_user_joined",
		"data": map[string]interface{}{"username": "m0abc"},
	})
	drainChatQueue(c)

	c.handle(map[string]interface{}{"type": "chat_error", "error": "username not set"})

	if st := c.State(); st.Joined {
		t.Error("still marked as joined after the server disowned us")
	}
	sent := drainChatQueue(c)
	if len(sent) != 1 || sent[0]["type"] != "chat_set_username" || sent[0]["username"] != "m0abc" {
		t.Errorf("did not rejoin: %v", sent)
	}
	// The error is handled, not shown: there is nothing for the user to do.
	for _, line := range c.State().Lines {
		if line.Kind == chatFailed {
			t.Errorf("the rejoin was reported as an error: %q", line.Text)
		}
	}
}

func TestChatReportsRealErrors(t *testing.T) {
	c := newTestChat()
	c.handle(map[string]interface{}{"type": "chat_error", "error": "username already taken"})

	lines := c.State().Lines
	if len(lines) != 1 || lines[0].Kind != chatFailed {
		t.Fatalf("error not shown: %+v", lines)
	}
}

func TestChatKeepsTheRoster(t *testing.T) {
	c := newTestChat()
	c.handle(map[string]interface{}{
		"type": "chat_active_users",
		"data": map[string]interface{}{
			"users": []interface{}{
				map[string]interface{}{"username": "alice", "frequency": 7074000.0, "mode": "usb"},
				map[string]interface{}{"username": "bob", "is_idle": true},
			},
			"count": 2,
		},
	})
	if n := len(c.State().Users); n != 2 {
		t.Fatalf("roster has %d users, want 2", n)
	}

	// A single-user update replaces that user and leaves the rest alone.
	c.handle(map[string]interface{}{
		"type": "chat_user_update",
		"data": map[string]interface{}{"username": "bob", "frequency": 14074000.0, "mode": "usb"},
	})
	users := c.State().Users
	if len(users) != 2 {
		t.Fatalf("roster has %d users after an update, want 2", len(users))
	}
	for _, u := range users {
		if u.Username == "bob" && u.Frequency != 14074000 {
			t.Errorf("bob is at %.0f Hz", u.Frequency)
		}
		if u.Username == "alice" && u.Frequency != 7074000 {
			t.Errorf("alice was disturbed by an update about bob")
		}
	}

	// Someone the roster has never heard of is added rather than dropped.
	c.handle(map[string]interface{}{
		"type": "chat_user_update",
		"data": map[string]interface{}{"username": "carol"},
	})
	if n := len(c.State().Users); n != 3 {
		t.Errorf("roster has %d users, want 3", n)
	}
}

// Publishing where the receiver is tuned is the point of a receiver's chat, but
// the server rate limits it, so an unchanged VFO must not be re-sent and a drag
// across the band must not send one update per frame.
func TestChatPublishesTuningWithoutFloodingIt(t *testing.T) {
	c := newTestChat()
	c.Join("m0abc")
	c.handle(map[string]interface{}{
		"type": "chat_user_joined",
		"data": map[string]interface{}{"username": "m0abc"},
	})
	drainChatQueue(c)

	c.SetRadio(7_074_000, "usb", 50, 2700, 200)
	sent := drainChatQueue(c)
	if len(sent) != 1 {
		t.Fatalf("first update sent %d messages, want 1", len(sent))
	}
	if sent[0]["type"] != "chat_set_frequency_mode" || sent[0]["mode"] != "usb" {
		t.Errorf("wrong first update: %v", sent[0])
	}
	if got := sent[0]["frequency"]; got != int64(7_074_000) {
		t.Errorf("frequency is %v (%T), want an integer number of Hz", got, got)
	}

	// Unchanged, and changes inside the window, are both held back.
	c.SetRadio(7_074_000, "usb", 50, 2700, 200)
	c.SetRadio(7_075_000, "usb", 50, 2700, 200)
	if sent := drainChatQueue(c); len(sent) != 0 {
		t.Errorf("sent %d updates inside the rate limit window", len(sent))
	}

	// Once the window passes, the latest value goes out — not the ones skipped.
	c.mu.Lock()
	c.lastStatus = time.Now().Add(-2 * chatStatusInterval)
	c.mu.Unlock()
	c.SetRadio(7_076_000, "usb", 50, 2700, 200)
	sent = drainChatQueue(c)
	if len(sent) != 1 || sent[0]["frequency"] != int64(7_076_000) {
		t.Errorf("held update did not send the latest value: %v", sent)
	}
}

// Nothing is published before joining: the server answers a status update from
// a session with no username with an error.
func TestChatPublishesNothingBeforeJoining(t *testing.T) {
	c := newTestChat()
	c.SetRadio(7_074_000, "usb", 50, 2700, 200)
	if sent := drainChatQueue(c); len(sent) != 0 {
		t.Errorf("published tuning without being in the chat: %v", sent)
	}
}

func TestValidChatUsername(t *testing.T) {
	for _, ok := range []string{"m0abc", "K1RA", "g4-abc", "a", "kb5avy/p", "one_two"} {
		if err := validChatUsername(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "-leading", "trailing_", "has space", "way-too-long-a-name", "no!"} {
		if err := validChatUsername(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// drainChatQueue takes everything waiting for the writer, which is what the
// client would have put on the wire.
func drainChatQueue(c *ChatClient) []map[string]interface{} {
	var out []map[string]interface{}
	for {
		select {
		case msg := <-c.outMessages:
			out = append(out, msg)
		default:
			return out
		}
	}
}

// --- panel ---------------------------------------------------------------

func chatTestUI() *UI {
	u := NewUI("sim.example.org:8080")
	u.cfg = SpectrumConfig{
		CenterFreq: 7_100_000, BinCount: 1024, BinBandwidth: 200, TotalBandwidth: 204_800,
	}
	u.vfo = 7_100_000
	u.chat = ChatState{Available: true, Connected: true}
	return u
}

func typeChat(p *ChatPanel, u *UI, text string) {
	for _, r := range text {
		p.HandleKey(tcell.NewEventKey(tcell.KeyRune, r, tcell.ModNone), u)
	}
}

func enterChat(p *ChatPanel, u *UI) (chatCommand, bool) {
	return p.HandleKey(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone), u)
}

func TestChatPanelJoinsThenTalks(t *testing.T) {
	u := chatTestUI()
	p := NewChatPanel()

	typeChat(p, u, "m0abc")
	cmd, done := enterChat(p, u)
	if cmd.join != "m0abc" || done {
		t.Fatalf("enter produced %+v done=%v", cmd, done)
	}

	// Once in, the same line sends messages instead.
	u.chat.Joined, u.chat.Username = true, "m0abc"
	typeChat(p, u, "hello all")
	cmd, _ = enterChat(p, u)
	if cmd.say != "hello all" {
		t.Errorf("message was %q", cmd.say)
	}
	if p.input != "" {
		t.Errorf("input still holds %q", p.input)
	}
}

// A bad username is refused locally, so the user is told at once rather than
// after a round trip.
func TestChatPanelRejectsABadUsernameLocally(t *testing.T) {
	u := chatTestUI()
	p := NewChatPanel()

	typeChat(p, u, "not a callsign")
	if cmd, _ := enterChat(p, u); cmd.join != "" {
		t.Errorf("sent %q to the server", cmd.join)
	}
	if p.err == "" {
		t.Error("nothing explained the refusal")
	}

	// And one already in the room, which the server would refuse anyway.
	p.input, p.err = "", ""
	u.chat.Users = []ChatUser{{Username: "M0ABC"}}
	typeChat(p, u, "m0abc")
	if cmd, _ := enterChat(p, u); cmd.join != "" {
		t.Errorf("sent a name already in the room: %q", cmd.join)
	}
	if !strings.Contains(p.err, "already") {
		t.Errorf("unhelpful complaint: %q", p.err)
	}
}

// Every printable key is message text, so leaving needs a command.
func TestChatPanelSlashCommands(t *testing.T) {
	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"

	p := NewChatPanel()
	typeChat(p, u, "/leave")
	cmd, done := enterChat(p, u)
	if !cmd.leave || done {
		t.Errorf("/leave produced %+v done=%v", cmd, done)
	}

	p = NewChatPanel()
	typeChat(p, u, "/close")
	if cmd, done := enterChat(p, u); !done || cmd.leave {
		t.Errorf("/close produced %+v done=%v", cmd, done)
	}

	// Escape closes without leaving: the chat keeps running behind it.
	p = NewChatPanel()
	cmd, done = p.HandleKey(tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone), u)
	if !done || cmd.leave {
		t.Errorf("escape produced %+v done=%v", cmd, done)
	}
}

func TestChatPanelDraws(t *testing.T) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 32)

	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Users = []ChatUser{
		{Username: "m0abc", Frequency: 7_100_000, Mode: "lsb"},
		{Username: "alice", Frequency: 14_074_000, Mode: "usb"},
	}
	u.chat.Lines = []ChatLine{
		{At: time.Now(), Username: "alice", Text: "anyone hearing the beacon on 14.100?", Kind: chatSaid},
		{At: time.Now(), Text: "bob joined", Kind: chatSystem},
		{At: time.Now(), Username: "alice", Text: "@m0abc it is strong here", Kind: chatSaid, Mention: true},
	}

	p := NewChatPanel()
	u.Draw(screen)
	p.Draw(screen, u)
	screen.Show()

	out := dump(screen)
	t.Logf("\n%s", out)
	for _, want := range []string{
		"Chat", "2 in chat", "alice:", "beacon on 14.100", "bob joined",
		"In chat", "14.074", "m0abc ▸", "enter send",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the panel is missing %q", want)
		}
	}
}

// The panel must survive any terminal, including ones too small to hold it.
func TestChatPanelSurvivesAnySize(t *testing.T) {
	for _, size := range [][2]int{{1, 1}, {20, 6}, {40, 12}, {41, 13}, {69, 20}, {80, 24}, {300, 90}} {
		screen := tcell.NewSimulationScreen("UTF-8")
		if err := screen.Init(); err != nil {
			t.Fatal(err)
		}
		screen.SetSize(size[0], size[1])

		u := chatTestUI()
		u.chat.Lines = []ChatLine{{At: time.Now(), Username: "alice",
			Text: strings.Repeat("a very long message that has to wrap ", 8), Kind: chatSaid}}
		u.chat.Users = []ChatUser{{Username: "alice", Frequency: 7_074_000}}

		p := NewChatPanel()
		p.scroll = 5
		u.Draw(screen)
		p.Draw(screen, u) // must not panic
	}
}

func TestWrapText(t *testing.T) {
	got := wrapText("alice: the quick brown fox", 12)
	for _, row := range got {
		if runeLen(row) > 12 {
			t.Errorf("row %q is wider than the column", row)
		}
	}
	if strings.Join(got, " ") != "alice: the quick brown fox" {
		t.Errorf("wrapping lost or added text: %q", got)
	}

	// A word longer than the column is cut rather than allowed to run off.
	long := wrapText(strings.Repeat("x", 30), 10)
	if len(long) != 3 {
		t.Errorf("a 30-character word wrapped to %d rows of 10", len(long))
	}
}

// --- indicator -----------------------------------------------------------

func TestChatHeaderIndicator(t *testing.T) {
	u := chatTestUI()
	u.chat.Users = []ChatUser{{Username: "alice"}, {Username: "bob"}}

	// Listening without having joined: the count, and nothing else. Nobody can
	// address someone who has not joined, so there is nothing to be unread.
	u.chatUnread, u.chatMention = 3, true
	if users, unread := u.chatLabels(); strings.TrimSpace(users) != "chat 2" || unread != "" {
		t.Errorf("a listener shows %q %q", users, unread)
	}

	u.chat.Joined, u.chat.Username = true, "m0abc"
	if users, unread := u.chatLabels(); strings.TrimSpace(users) != "chat 2" ||
		strings.TrimSpace(unread) != "+3@" {
		t.Errorf("an unread mention shows %q %q", users, unread)
	}
	u.chatMention = false
	if _, unread := u.chatLabels(); strings.TrimSpace(unread) != "+3" {
		t.Errorf("plain unread shows %q", unread)
	}
	u.chatUnread = 0
	if _, unread := u.chatLabels(); unread != "" {
		t.Errorf("a read chat shows %q", unread)
	}

	// Before the socket is up there is no count to give.
	u.chat.Connected = false
	if users, _ := u.chatLabels(); !strings.Contains(users, "…") {
		t.Errorf("connecting shows %q", users)
	}

	// A receiver without chat says nothing at all, in the header or the hints.
	u.chat = ChatState{}
	if got := u.chatHint(); got != "" {
		t.Errorf("hint on a receiver with no chat: %q", got)
	}
}

// Messages arriving while the panel is shut are what the indicator counts;
// opening it clears them.
func TestChatUnreadCounting(t *testing.T) {
	e := &eventLoop{ui: chatTestUI(), chat: newTestChat()}
	deliver := e.noteChatUpdate

	joined := ChatState{Available: true, Connected: true, Joined: true, Username: "m0abc"}

	st := joined
	st.Received = 2
	deliver(st)
	if e.ui.chatUnread != 2 || e.ui.chatMention {
		t.Errorf("unread=%d mention=%v after two messages", e.ui.chatUnread, e.ui.chatMention)
	}
	st = joined
	st.Received, st.Mentions = 3, 1
	st.Lines = []ChatLine{{Username: "alice", Text: "@m0abc you about?", Kind: chatSaid, Mention: true}}
	deliver(st)
	if e.ui.chatUnread != 3 || !e.ui.chatMention {
		t.Errorf("unread=%d mention=%v after a mention", e.ui.chatUnread, e.ui.chatMention)
	}
	// A mention is worth interrupting for: the status line names who it was.
	if !strings.Contains(e.ui.status, "alice") || !strings.Contains(e.ui.status, "mentioned you") {
		t.Errorf("no notification of the mention: %q", e.ui.status)
	}

	e.openChat()
	if e.chatPanel == nil {
		t.Fatal("C did not open the panel")
	}
	if e.ui.chatUnread != 0 || e.ui.chatMention {
		t.Errorf("opening left unread=%d mention=%v", e.ui.chatUnread, e.ui.chatMention)
	}

	// While it is open, nothing accumulates.
	st = joined
	st.Received, st.Mentions = 5, 2
	deliver(st)
	if e.ui.chatUnread != 0 {
		t.Errorf("counted %d unread with the panel open", e.ui.chatUnread)
	}

	// Leaving the chat clears what was unread with it: there is no longer
	// anyone it could have been addressed to.
	e.chatPanel = nil
	st = joined
	st.Received = 8
	deliver(st)
	if e.ui.chatUnread == 0 {
		t.Fatal("nothing accumulated after the panel closed again")
	}
	left := st
	left.Joined, left.Username = false, ""
	deliver(left)
	if e.ui.chatUnread != 0 || e.ui.chatMention {
		t.Errorf("leaving left unread=%d mention=%v", e.ui.chatUnread, e.ui.chatMention)
	}
}

// A receiver without chat must not open a panel that can do nothing.
func TestChatKeyOnAReceiverWithoutChat(t *testing.T) {
	e := &eventLoop{ui: NewUI("sim.example.org:8080")}
	e.handleKey(tcell.NewEventKey(tcell.KeyRune, 'C', tcell.ModNone))

	if e.chatPanel != nil {
		t.Error("opened the chat on a receiver that does not run one")
	}
	if !strings.Contains(e.ui.status, "chat") {
		t.Errorf("said nothing useful: %q", e.ui.status)
	}
}

// c still centres the view; C is the chat.
func TestChatKeyIsSeparateFromCentring(t *testing.T) {
	e := &eventLoop{ui: chatTestUI()}
	e.handleKey(tcell.NewEventKey(tcell.KeyRune, 'c', tcell.ModNone))
	if e.chatPanel != nil {
		t.Error("c opened the chat")
	}
	if !strings.Contains(e.ui.status, "centred") {
		t.Errorf("c no longer centres: %q", e.ui.status)
	}

	e.handleKey(tcell.NewEventKey(tcell.KeyRune, 'C', tcell.ModNone))
	if e.chatPanel == nil {
		t.Error("C did not open the chat")
	}
}

// The header is right-aligned and several of its fields carry multi-byte
// glyphs, so the chat indicator — drawn last — is the first thing to fall off
// the edge if the layout counts bytes where it means columns.
func TestHeaderKeepsTheChatIndicatorOnScreen(t *testing.T) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 30)

	u := chatTestUI()
	u.connected = true
	u.audioOn = true // the audio field holds an em dash until the first packet
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Users = []ChatUser{{Username: "a"}, {Username: "b"}, {Username: "c"}}
	u.chatUnread, u.chatMention = 2, true
	u.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	u.Draw(screen)

	// Beside the connection state, where a narrow terminal cannot shed it.
	header := rowText(screen, 0)
	if !strings.Contains(header, "live chat 3 +2@") {
		t.Errorf("the indicator is not next to the state: %q", header)
	}
}

// --- @ mentions ----------------------------------------------------------

// Typing @ offers the people in the room, as the Python client's suggestion
// list does, and tab takes the highlighted one.
func TestChatPanelMentionCompletion(t *testing.T) {
	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Users = []ChatUser{
		{Username: "m0abc"}, {Username: "alice"}, {Username: "albert"}, {Username: "bob"},
	}
	p := NewChatPanel()

	typeChat(p, u, "hello @al")
	got := p.suggestions(u)
	if len(got) != 2 || got[0] != "albert" || got[1] != "alice" {
		t.Fatalf("suggestions for @al were %v, want albert and alice in order", got)
	}

	// Down moves through the list rather than scrolling the transcript.
	p.HandleKey(tcell.NewEventKey(tcell.KeyDown, 0, tcell.ModNone), u)
	if p.mentionIdx != 1 || p.scroll != 0 {
		t.Errorf("down gave idx=%d scroll=%d", p.mentionIdx, p.scroll)
	}

	p.HandleKey(tcell.NewEventKey(tcell.KeyTab, 0, tcell.ModNone), u)
	if p.input != "hello @alice " {
		t.Errorf("completion produced %q", p.input)
	}
	if p.suggestions(u) != nil {
		t.Error("still suggesting after completing")
	}

	// The completed message goes out as typed.
	typeChat(p, u, "are you there")
	if cmd, _ := enterChat(p, u); cmd.say != "hello @alice are you there" {
		t.Errorf("sent %q", cmd.say)
	}
}

func TestChatPanelMentionSuggestionRules(t *testing.T) {
	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Users = []ChatUser{{Username: "m0abc"}, {Username: "alice"}}

	// A bare @ offers everyone but yourself.
	p := NewChatPanel()
	typeChat(p, u, "@")
	if got := p.suggestions(u); len(got) != 1 || got[0] != "alice" {
		t.Errorf("a bare @ offered %v, want just the other person", got)
	}

	// A finished mention is not still being typed.
	typeChat(p, u, "alice hello")
	if got := p.suggestions(u); got != nil {
		t.Errorf("still suggesting after the name was finished: %v", got)
	}

	// Nothing matching offers nothing.
	p = NewChatPanel()
	typeChat(p, u, "@zz")
	if got := p.suggestions(u); got != nil {
		t.Errorf("offered %v for a prefix nobody has", got)
	}

	// And nothing is offered before joining, when the line is a username.
	p = NewChatPanel()
	u.chat.Joined = false
	typeChat(p, u, "@al")
	if got := p.suggestions(u); got != nil {
		t.Errorf("offered %v while still choosing a username", got)
	}
}

// Escape gets rid of the suggestions before it closes the panel.
func TestChatPanelEscapeDismissesSuggestionsFirst(t *testing.T) {
	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Users = []ChatUser{{Username: "alice"}}

	p := NewChatPanel()
	typeChat(p, u, "@al")
	if _, done := p.HandleKey(tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone), u); done {
		t.Fatal("the first escape closed the panel")
	}
	if got := p.suggestions(u); got != nil {
		t.Errorf("suggestions survived escape: %v", got)
	}
	if _, done := p.HandleKey(tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone), u); !done {
		t.Error("the second escape did not close the panel")
	}

	// Typing again brings them back.
	typeChat(p, u, "i")
	if got := p.suggestions(u); len(got) != 1 {
		t.Errorf("typing did not restore the suggestions: %v", got)
	}
}

// The @name itself is highlighted, not the whole message: it is the word that
// concerns the reader.
func TestChatPanelHighlightsTheMentionToken(t *testing.T) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 32)

	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Lines = []ChatLine{{
		At: time.Now(), Username: "alice", Kind: chatSaid, Mention: true,
		Text: "hey @M0ABC nice signal",
	}}

	p := NewChatPanel()
	u.Draw(screen)
	p.Draw(screen, u)
	screen.Show()

	row, x0 := -1, -1
	cells, w, h := screen.GetContents()
	for y := 0; y < h && row < 0; y++ {
		line := rowText(screen, y)
		if i := strings.Index(line, "@M0ABC"); i >= 0 {
			row, x0 = y, i
		}
	}
	if row < 0 {
		t.Fatalf("the mention was not drawn:\n%s", dump(screen))
	}

	// The token carries the highlight; the words around it do not.
	_, tokenBG, _ := cells[row*w+x0].Style.Decompose()
	_, beforeBG, _ := cells[row*w+x0-1].Style.Decompose()
	_, afterBG, _ := cells[row*w+x0+len("@M0ABC")].Style.Decompose()
	if tokenBG == beforeBG {
		t.Errorf("the mention is not highlighted (bg %v either side)", tokenBG)
	}
	if beforeBG != afterBG {
		t.Errorf("the highlight leaked past the token: before=%v after=%v", beforeBG, afterBG)
	}
}

func TestChatPanelDrawsSuggestions(t *testing.T) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 32)

	u := chatTestUI()
	u.chat.Joined, u.chat.Username = true, "m0abc"
	u.chat.Users = []ChatUser{{Username: "alice"}, {Username: "albert"}}

	p := NewChatPanel()
	typeChat(p, u, "@al")
	u.Draw(screen)
	p.Draw(screen, u)
	screen.Show()

	out := dump(screen)
	t.Logf("\n%s", out)
	for _, want := range []string{"@albert", "@alice", "tab complete"} {
		if !strings.Contains(out, want) {
			t.Errorf("the suggestion row is missing %q", want)
		}
	}
}
