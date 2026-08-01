package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/gdamore/tcell/v2"
)

// ChatPanel is the modal chat window, drawn over the running display.
//
// It is a transcript, a roster of who else is listening and where, and one
// input line that is either the username to join with or the next message.
type ChatPanel struct {
	input  string
	err    string // local validation failure, shown above the input
	scroll int    // rows scrolled back from the newest; 0 follows the transcript

	// @ mention completion, as in the Python client: a partial @name offers the
	// people in the room, tab takes one. mentionIdx is the highlighted
	// suggestion and mentionHidden is set by escape, until the prefix changes.
	mentionIdx    int
	mentionHidden bool
}

func NewChatPanel() *ChatPanel { return &ChatPanel{} }

// chatCommand is what a keypress asked the event loop to do. The panel owns no
// socket: it decides, the caller acts.
type chatCommand struct {
	join  string
	say   string
	leave bool
}

// HandleKey processes a key press, returning the command it produced and
// whether the panel should close.
func (p *ChatPanel) HandleKey(ev *tcell.EventKey, u *UI) (chatCommand, bool) {
	// While a partial @name is offering suggestions, the keys that navigate them
	// belong to the list rather than to the transcript.
	suggestions := p.suggestions(u)

	switch ev.Key() {
	case tcell.KeyEscape, tcell.KeyCtrlC:
		// Escape dismisses the suggestions before it closes the panel, so
		// completing a name never traps the user into shutting the chat.
		if len(suggestions) > 0 {
			p.mentionHidden = true
			return chatCommand{}, false
		}
		// Closing leaves the chat running: messages keep arriving and the
		// header keeps count, which is the point of an unread indicator.
		return chatCommand{}, true

	case tcell.KeyTab:
		if len(suggestions) > 0 {
			p.completeMention(suggestions)
		}

	case tcell.KeyCtrlU:
		p.input = ""
		p.resetMention()

	case tcell.KeyBackspace, tcell.KeyBackspace2:
		if n := len(p.input); n > 0 {
			runes := []rune(p.input)
			p.input = string(runes[:len(runes)-1])
		}
		p.resetMention()

	case tcell.KeyPgUp:
		p.scroll += 5
	case tcell.KeyPgDn:
		p.scroll -= 5
		if p.scroll < 0 {
			p.scroll = 0
		}
	case tcell.KeyUp:
		if len(suggestions) > 0 {
			p.mentionIdx = maxInt(0, p.mentionIdx-1)
			break
		}
		p.scroll++
	case tcell.KeyDown:
		if len(suggestions) > 0 {
			p.mentionIdx = minInt(len(suggestions)-1, p.mentionIdx+1)
			break
		}
		if p.scroll > 0 {
			p.scroll--
		}
	case tcell.KeyEnd:
		p.scroll = 0

	case tcell.KeyEnter:
		return p.commit(u)

	case tcell.KeyRune:
		p.input += string(ev.Rune())
		p.err = ""
		p.resetMention()
	}
	return chatCommand{}, false
}

// mentionPrefix returns the partial @name being typed, if the input ends in
// one. The input has no cursor to move, so the end of the line is where the
// completion applies.
func (p *ChatPanel) mentionPrefix() (string, bool) {
	at := strings.LastIndex(p.input, "@")
	if at < 0 {
		return "", false
	}
	partial := p.input[at+1:]
	for _, r := range partial {
		// A name is letters, digits and - _ /, so anything else — a space above
		// all — means the @ that started this is already finished with.
		alnum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !alnum && r != '-' && r != '_' && r != '/' {
			return "", false
		}
	}
	return partial, true
}

// suggestions lists the people in the room whose names extend the @ being
// typed. Our own name is left out: nobody needs to mention themselves.
func (p *ChatPanel) suggestions(u *UI) []string {
	if p.mentionHidden || !u.chat.Joined {
		return nil
	}
	partial, ok := p.mentionPrefix()
	if !ok {
		return nil
	}
	partial = strings.ToLower(partial)

	var out []string
	for _, user := range u.chat.Users {
		if strings.EqualFold(user.Username, u.chat.Username) {
			continue
		}
		if strings.HasPrefix(strings.ToLower(user.Username), partial) {
			out = append(out, user.Username)
		}
	}
	sort.Strings(out)
	if p.mentionIdx >= len(out) {
		p.mentionIdx = 0
	}
	return out
}

// completeMention replaces the partial name with the highlighted suggestion,
// leaving a trailing space so the message can carry straight on.
func (p *ChatPanel) completeMention(suggestions []string) {
	partial, ok := p.mentionPrefix()
	if !ok || p.mentionIdx >= len(suggestions) {
		return
	}
	at := len(p.input) - len(partial) - 1 // the @ itself
	p.input = p.input[:at] + "@" + suggestions[p.mentionIdx] + " "
	p.resetMention()
}

func (p *ChatPanel) resetMention() {
	p.mentionIdx, p.mentionHidden = 0, false
}

// commit acts on the input line: a username when we are not in yet, otherwise a
// message — or one of the few slash commands, since every printable key is
// message text and there is nowhere else to put them.
func (p *ChatPanel) commit(u *UI) (chatCommand, bool) {
	text := strings.TrimSpace(p.input)
	if text == "" {
		return chatCommand{}, false
	}

	if !u.chat.Joined {
		if err := validChatUsername(text); err != nil {
			p.err = err.Error()
			return chatCommand{}, false
		}
		// A name already in the room will be refused by the server, but saying
		// so here saves the round trip and the confusing error.
		for _, other := range u.chat.Users {
			if strings.EqualFold(other.Username, text) {
				p.err = text + " is already in the chat"
				return chatCommand{}, false
			}
		}
		p.input, p.err = "", ""
		return chatCommand{join: text}, false
	}

	switch strings.ToLower(text) {
	case "/leave", "/part":
		p.input, p.err = "", ""
		return chatCommand{leave: true}, false
	case "/close", "/quit":
		p.input, p.err = "", ""
		return chatCommand{}, true
	}

	if len(text) > maxChatMessage {
		p.err = fmt.Sprintf("a message is at most %d characters", maxChatMessage)
		return chatCommand{}, false
	}

	p.input, p.err, p.scroll = "", "", 0
	return chatCommand{say: text}, false
}

// chatRosterWidth is the roster column; it is dropped on a narrow terminal,
// where the transcript is worth more.
const chatRosterWidth = 22

func (p *ChatPanel) Draw(s tcell.Screen, u *UI) {
	w, h := s.Size()
	if w < 40 || h < 12 {
		return
	}

	width := minInt(96, w-4)
	height := h - 4
	x0, y0 := (w-width)/2, (h-height)/2

	bg := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(220, 220, 235)).
		Background(tcell.NewRGBColor(28, 28, 38))
	title := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(255, 205, 90)).
		Background(tcell.NewRGBColor(28, 28, 38)).Bold(true)
	dim := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(140, 140, 155)).
		Background(tcell.NewRGBColor(28, 28, 38))
	fail := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(235, 110, 100)).
		Background(tcell.NewRGBColor(28, 28, 38))
	sel := tcell.StyleDefault.
		Foreground(tcell.ColorBlack).
		Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)

	for y := y0; y < y0+height; y++ {
		drawText(s, x0, y, bg, strings.Repeat(" ", width))
	}

	// Header: who is here, and whether we are actually in.
	drawText(s, x0, y0, title, padTo(" Chat", width))
	state := fmt.Sprintf("%d in chat ", len(u.chat.Users))
	if !u.chat.Connected {
		state = "connecting… "
	}
	drawText(s, x0+width-runeLen(state)-1, y0, title, state)

	// The roster earns its column only when the transcript can spare it.
	roster := 0
	if width >= 70 {
		roster = chatRosterWidth
		p.drawRoster(s, u, x0+width-roster, y0+2, height-4, roster-1, bg, dim, title)
		for y := y0 + 2; y < y0+height-2; y++ {
			s.SetContent(x0+width-roster-1, y, '│', nil, dim)
		}
	}

	bodyW := width - roster - 3
	p.drawTranscript(s, u, x0+1, y0+2, height-5, bodyW, bg, dim, fail, title)

	// Input row. The line above it carries either the @ completions being
	// offered or the last local complaint — never both, since typing clears the
	// complaint and completions only exist while typing.
	inputY := y0 + height - 2
	suggestions := p.suggestions(u)
	switch {
	case len(suggestions) > 0:
		p.drawSuggestions(s, suggestions, x0+1, inputY-1, width-2, dim, sel)
	case p.err != "":
		drawText(s, x0+1, inputY-1, fail, truncate(p.err, width-2))
	}

	prompt := "username: "
	if u.chat.Joined {
		prompt = u.chat.Username + " ▸ "
	}
	field := prompt + p.input + "▏"
	// Keep the caret on screen on a long message rather than letting the line
	// run off the panel.
	if over := runeLen(field) - (width - 2); over > 0 {
		field = "…" + string([]rune(field)[over+1:])
	}
	drawText(s, x0+1, inputY, title, padTo(field, width-2))

	hint := " enter join · esc close "
	switch {
	case len(suggestions) > 0:
		hint = " tab complete · ↑↓ choose · esc dismiss "
	case u.chat.Joined:
		hint = " enter send · @ mentions · PgUp/PgDn scroll · /leave leave · esc close "
	}
	drawText(s, x0, y0+height-1, tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(200, 200, 210)).
		Background(tcell.NewRGBColor(45, 45, 55)), padTo(hint, width))
}

// drawMention draws message text, picking out every mention of the reader's own
// name. That token is the whole reason the message matters, and highlighting it
// rather than the entire line is what the web and Python clients do.
//
// The search is ASCII-case-insensitive, which is exact here: the server allows
// only letters, digits and - _ / in a username, and lowering ASCII in place
// keeps byte offsets lined up with the original text however the message around
// it is encoded.
func drawMention(s tcell.Screen, x, y int, text, name string, base, hit tcell.Style) {
	if name == "" {
		drawText(s, x, y, base, text)
		return
	}
	token := "@" + asciiLower(name)
	for {
		i := strings.Index(asciiLower(text), token)
		if i < 0 {
			break
		}
		drawText(s, x, y, base, text[:i])
		x += runeLen(text[:i])
		drawText(s, x, y, hit, text[i:i+len(token)])
		x += runeLen(text[i : i+len(token)])
		text = text[i+len(token):]
	}
	drawText(s, x, y, base, text)
}

// asciiLower lowercases the ASCII letters in a string and nothing else, so the
// result is byte-for-byte the same length as the input.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// drawSuggestions lists the @ completions on offer, the highlighted one first
// so tab always takes what is nearest the eye.
func (p *ChatPanel) drawSuggestions(s tcell.Screen, names []string, x, y, width int, dim, sel tcell.Style) {
	for i, name := range names {
		text := "@" + name + " "
		if runeLen(text) > width {
			break
		}
		style := dim
		if i == p.mentionIdx {
			style = sel
		}
		drawText(s, x, y, style, text)
		x += runeLen(text)
		width -= runeLen(text)
	}
}

// drawTranscript renders the message history, newest at the bottom.
func (p *ChatPanel) drawTranscript(s tcell.Screen, u *UI, x, y, rows, width int, bg, dim, fail, title tcell.Style) {
	if rows < 1 || width < 12 {
		return
	}
	if len(u.chat.Lines) == 0 {
		msg := "Nothing has been said yet."
		if !u.chat.Joined {
			msg = "Type a username and press enter to join."
		}
		drawText(s, x+1, y, dim, truncate(msg, width))
		return
	}

	// Wrap everything, then take the window the scroll position asks for. The
	// transcript is capped at a few hundred lines, so wrapping all of it costs
	// nothing measurable and keeps the arithmetic obvious.
	type row struct {
		stamp   string // only on a line's first row
		head    string // "username: ", styled apart from the text
		text    string
		style   tcell.Style
		name    tcell.Style
		mention bool // pick our own name out of this row
	}
	var all []row

	own := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(255, 205, 90)).
		Background(tcell.NewRGBColor(28, 28, 38)).Bold(true)
	other := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(120, 210, 235)).
		Background(tcell.NewRGBColor(28, 28, 38)).Bold(true)
	// The mention style marks the @name itself rather than the whole message,
	// as the web and Python clients do: it is the word that concerns you.
	mention := tcell.StyleDefault.
		Foreground(tcell.ColorBlack).
		Background(tcell.NewRGBColor(255, 193, 7)).Bold(true)

	const stampW = 8 // "[12:34] "
	for _, line := range u.chat.Lines {
		textStyle, nameStyle := bg, other
		head := ""
		switch line.Kind {
		case chatSaid:
			head = line.Username + ": "
			if line.Own {
				nameStyle = own
			}
		case chatFailed:
			textStyle = fail
		default:
			textStyle = dim
		}

		body := head + line.Text
		wrapped := wrapText(body, width-stampW)
		for i, part := range wrapped {
			r := row{text: part, style: textStyle, name: nameStyle, mention: line.Mention}
			if i == 0 {
				r.stamp = line.At.Format("[15:04] ")
				r.head = head
			}
			all = append(all, r)
		}
	}

	// Clamp the scroll so it can never run past the history.
	if max := len(all) - rows; p.scroll > max {
		p.scroll = maxInt(0, max)
	}
	end := len(all) - p.scroll
	start := maxInt(0, end-rows)

	for i, r := range all[start:end] {
		cy := y + i
		cx := x
		if r.stamp != "" {
			drawText(s, cx, cy, dim, r.stamp)
		}
		cx += stampW

		// The username shares the first wrapped row with the start of the
		// message, so it is drawn separately to keep its own colour.
		text := r.text
		if n := runeLen(r.head); n > 0 && r.stamp != "" {
			head := string([]rune(text)[:minInt(n, runeLen(text))])
			drawText(s, cx, cy, r.name, head)
			cx += runeLen(head)
			text = string([]rune(text)[runeLen(head):])
		}
		if r.mention {
			drawMention(s, cx, cy, text, u.chat.Username, r.style, mention)
		} else {
			drawText(s, cx, cy, r.style, text)
		}
	}

	if p.scroll > 0 {
		note := fmt.Sprintf(" %d more below ", p.scroll)
		drawText(s, x+width-runeLen(note), y+rows-1, title, note)
	}
}

// drawRoster lists who is in the chat and where they are listening, which is
// the part of a receiver's chat that is actually about radio.
func (p *ChatPanel) drawRoster(s tcell.Screen, u *UI, x, y, rows, width int, bg, dim, title tcell.Style) {
	drawText(s, x, y, title, truncate("In chat", width))
	if len(u.chat.Users) == 0 {
		drawText(s, x, y+2, dim, truncate("nobody yet", width))
		return
	}

	for i, user := range u.chat.Users {
		cy := y + 2 + i
		if i >= rows-2 {
			drawText(s, x, cy, dim, truncate(fmt.Sprintf("+%d more", len(u.chat.Users)-i), width))
			return
		}

		style := bg
		if user.Idle {
			style = dim // idle is the server's own flag; it comes for free
		}
		if strings.EqualFold(user.Username, u.chat.Username) {
			style = title
		}

		// Where they are listening, right-aligned against the name. Three
		// decimals is enough to place a station and leaves the column wide
		// enough for a full-length username.
		where := ""
		if user.Frequency > 0 {
			where = fmt.Sprintf(" %.3f", user.Frequency/1e6)
		}
		drawText(s, x, cy, style, truncate(user.Username, width-runeLen(where)))
		if where != "" {
			drawText(s, x+width-runeLen(where), cy, dim, where)
		}
	}
}

// wrapText breaks a string onto lines of at most width columns, preferring word
// boundaries but splitting anything longer than a whole line.
func wrapText(text string, width int) []string {
	if width < 4 {
		width = 4
	}
	var out []string
	for _, word := range strings.Fields(text) {
		switch {
		case len(out) == 0:
			out = append(out, word)
		case runeLen(out[len(out)-1])+1+runeLen(word) <= width:
			out[len(out)-1] += " " + word
			continue
		default:
			out = append(out, word)
		}
		// A single word longer than the line is cut rather than allowed to run
		// off the panel.
		for runeLen(out[len(out)-1]) > width {
			runes := []rune(out[len(out)-1])
			out[len(out)-1] = string(runes[:width])
			out = append(out, string(runes[width:]))
		}
	}
	if len(out) == 0 {
		return []string{""}
	}
	return out
}
