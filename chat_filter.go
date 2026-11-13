package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Chat word and link filter.
//
// The filter is compiled once per settings change (NewChatFilter) and then used
// for every chat message and username. For the built-in word list in "censor"
// mode it produces exactly what censorProfanity produces today (whole words only,
// first and last character kept, everything between starred, case preserved), and
// on top of that catches the usual dodges: leetspeak (5h1t), spaced or dotted
// letters (f.u.c.k, f u c k), stretched letters (fuuuuck) and look-alike letters
// from other alphabets (Cyrillic, fullwidth). Callsigns, frequencies and links are
// never touched by the word filter.

const (
	ChatModeCensor = "censor"
	ChatModeBlock  = "block"

	ChatLinksAllow     = "allow"
	ChatLinksBlock     = "block"
	ChatLinksAllowlist = "allowlist"

	ChatStatusOK       = "ok"
	ChatStatusCensored = "censored"
	ChatStatusBlocked  = "blocked"

	ChatMaxCustomWords  = 500
	ChatMaxWordLength   = 32
	ChatMinWordLetters  = 3
	chatMaxAllowlistLen = 500
)

// ChatAutoModeration controls automatic warnings and chat bans for repeat offenders.
type ChatAutoModeration struct {
	Enabled        bool `yaml:"enabled" json:"enabled"`
	Strikes        int  `yaml:"strikes" json:"strikes"`
	WindowMinutes  int  `yaml:"window_minutes" json:"window_minutes"`
	ChatBanMinutes int  `yaml:"chat_ban_minutes" json:"chat_ban_minutes"`
}

// ChatSDREscalation turns repeated chat bans into a full ban from the SDR.
type ChatSDREscalation struct {
	Enabled    bool `yaml:"enabled" json:"enabled"`
	ChatBans   int  `yaml:"chat_bans" json:"chat_bans"`
	WindowDays int  `yaml:"window_days" json:"window_days"`
}

// ChatModerationSettings is the content of chat_moderation.yaml and of the
// /admin/chat/moderation API.
type ChatModerationSettings struct {
	Mode           string             `yaml:"mode" json:"mode"`
	Words          []string           `yaml:"words" json:"words"`
	Links          string             `yaml:"links" json:"links"`
	LinkAllowlist  []string           `yaml:"link_allowlist" json:"link_allowlist"`
	AutoModeration ChatAutoModeration `yaml:"auto_moderation" json:"auto_moderation"`
	SDREscalation  ChatSDREscalation  `yaml:"sdr_escalation" json:"sdr_escalation"`
}

// DefaultChatModerationSettings returns the settings used when no file exists.
func DefaultChatModerationSettings() ChatModerationSettings {
	return ChatModerationSettings{
		Mode:          ChatModeCensor,
		Words:         []string{},
		Links:         ChatLinksAllow,
		LinkAllowlist: []string{},
		AutoModeration: ChatAutoModeration{
			Enabled:        true,
			Strikes:        3,
			WindowMinutes:  10,
			ChatBanMinutes: 60,
		},
		SDREscalation: ChatSDREscalation{
			Enabled:    false,
			ChatBans:   3,
			WindowDays: 30,
		},
	}
}

func (s ChatModerationSettings) clone() ChatModerationSettings {
	s.Words = append([]string{}, s.Words...)
	s.LinkAllowlist = append([]string{}, s.LinkAllowlist...)
	return s
}

// BuiltinChatWords is the fixed word list every server starts with.
func BuiltinChatWords() []string {
	return getProfanityList()
}

// RejectedWord is a custom word or allowlist entry that was refused, with a plain
// reason the admin page can show next to it.
type RejectedWord struct {
	Word   string `json:"word"`
	Reason string `json:"reason"`
}

// ChatFilterResult is the outcome of checking one message.
type ChatFilterResult struct {
	Status  string   `json:"status"` // ok | censored | blocked
	Output  string   `json:"output"` // text to broadcast; empty when blocked
	Matches []string `json:"matches"`
	Reason  string   `json:"reason"`
	Strike  bool     `json:"strike"`
}

// chatExceptions are ordinary words that contain or look like a blocked word.
// They are never caught, in messages or in usernames.
var chatExceptions = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`
		scunthorpe penistone cockpit cockpits cocktail cocktails cockerel cockney cockle cockroach
		peacock hancock hitchcock woodcock shuttlecock babcock
		assassin assassins assassinate assassination assist assistant assists assume assumed
		assign assigned assignment associate association assess assessment asset assets assembly
		assault assert assertion assort assorted assure assured assay assent assets assignee
		class classes classic classical classify glass glasses grass brass bass bassist mass lass
		pass passes passage passenger passed passing compass crass carcass morass harass embarrass
		embassy cassette sassy amass surpass bypass trespass jackassery
		dickens dickinson dickson benedick
		spice spicy spick spicer
		mongoose mongolia mongolian
		shitake shiitake
		pissarro
		fagin
		retardant retardants
		cumulus
	`) {
		chatExceptions[w] = true
	}
}

// chatCallsignRe recognises a whole lower-case token shaped like an amateur
// callsign (M0ASS, G4ASS, 2E0ASS, KA9Q).
var chatCallsignRe = regexp.MustCompile(`^(?:[a-z]{1,2}|[0-9][a-z]|[a-z][0-9])[0-9][a-z]{1,4}$`)

// Leetspeak substitutions recognised inside words.
var chatLeet = map[rune]string{
	'a': "4@",
	'e': "3",
	'i': "1!",
	'o': "0",
	's': "5$",
	't': "7",
}

var chatLeetReverse = map[rune]rune{
	'4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't',
}

// Look-alike letters from other alphabets, folded to the Latin letter they imitate.
var chatLookalikes = map[rune]rune{
	// Cyrillic (lower case; upper case is lowered first)
	'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
	'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'ј': 'j',
	'ѕ': 's', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w',
	// Greek
	'α': 'a', 'ο': 'o', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't', 'υ': 'u', 'ρ': 'p',
}

// chatFoldRune maps one rune to the form the matcher works on: fullwidth to ASCII,
// lower case, look-alike letters to Latin. Always exactly one rune out.
func chatFoldRune(r rune) rune {
	if r >= 0xFF01 && r <= 0xFF5E {
		r -= 0xFEE0
	}
	r = unicode.ToLower(r)
	if m, ok := chatLookalikes[r]; ok {
		return m
	}
	return r
}

func chatIsASCIILetter(r rune) bool { return r >= 'a' && r <= 'z' }

func chatIsWordByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_'
}

// chatSeparator is what may sit between spaced-out single letters: "f.u.c.k".
const chatSeparator = `[ .\-_*]+`

// chatLetterAtom is the pattern for one letter of a word: the letter or its
// leetspeak forms, once or stretched to three or more ("fuuuck").
func chatLetterAtom(r rune, stretch bool) string {
	class := regexp.QuoteMeta(string(r))
	if leet, ok := chatLeet[r]; ok {
		class = "[" + regexp.QuoteMeta(string(r)+leet) + "]"
	}
	if stretch && unicode.IsLetter(r) {
		return class + "(?:" + class + class + "+)?"
	}
	return class
}

func chatWordPattern(word string) (contiguous, spaced string) {
	var c, s strings.Builder
	allLetters := true
	n := 0
	for _, r := range word {
		n++
		switch {
		case r == ' ':
			c.WriteString(`[\s.\-_*]+`)
			allLetters = false
		case unicode.IsLetter(r):
			c.WriteString(chatLetterAtom(r, true))
			if s.Len() > 0 {
				s.WriteString(chatSeparator)
			}
			s.WriteString(chatLetterAtom(r, false))
		default:
			c.WriteString(regexp.QuoteMeta(string(r)))
			allLetters = false
		}
	}
	if allLetters && n >= 3 {
		spaced = s.String()
	}
	return c.String(), spaced
}

// ChatFilter is a compiled word and link filter. It is immutable and safe for
// concurrent use; build a new one when the settings change.
type ChatFilter struct {
	mode      string
	links     string
	allowlist []string
	words     []chatWord // builtin + custom
}

// chatWord is one compiled word. key is its squashed form (see chatSquash): a
// message whose squashed form does not contain key cannot match re, so most
// words are ruled out with a substring test and re only runs for the few left.
type chatWord struct {
	word string // folded
	key  string
	re   *regexp.Regexp
}

// NewChatFilter compiles a filter for the given settings. The settings are
// expected to be normalised already (the store does that); unknown modes fall
// back to censor/allow.
func NewChatFilter(s ChatModerationSettings) *ChatFilter {
	f := &ChatFilter{mode: s.Mode, links: s.Links}
	if f.mode != ChatModeBlock {
		f.mode = ChatModeCensor
	}
	if f.links != ChatLinksBlock && f.links != ChatLinksAllowlist {
		f.links = ChatLinksAllow
	}
	for _, d := range s.LinkAllowlist {
		if d = chatNormaliseDomain(d); d != "" {
			f.allowlist = append(f.allowlist, d)
		}
	}

	seen := map[string]bool{}
	add := func(w string) {
		w = chatFoldWord(w)
		if utf8.RuneCountInString(w) < 3 || seen[w] {
			return
		}
		seen[w] = true
		// The text is padded with spaces, so every word is matched with a
		// non-word character on each side (group 1 is the word itself).
		c, sp := chatWordPattern(w)
		alt := c
		if sp != "" {
			alt = sp + "|" + c
		}
		f.words = append(f.words, chatWord{
			word: w,
			key:  chatSquash(w),
			re:   regexp.MustCompile(`[^a-z0-9_]((?:` + alt + `))[^a-z0-9_]`),
		})
	}
	for _, w := range getProfanityList() {
		add(w)
	}
	for _, w := range s.Words {
		add(w)
	}
	return f
}

// chatSquash folds a text the way the word patterns tolerate: look-alikes and
// leetspeak to letters, separators dropped, repeated letters collapsed to one.
func chatSquash(text string) string {
	var b strings.Builder
	var last rune = -1
	for _, r := range text {
		r = chatFoldRune(r)
		if m, ok := chatLeetReverse[r]; ok {
			r = m
		}
		if unicode.IsSpace(r) || strings.ContainsRune(".-_*", r) || r == last {
			continue
		}
		last = r
		b.WriteRune(r)
	}
	return b.String()
}

func chatFoldWord(w string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(w) {
		b.WriteRune(chatFoldRune(r))
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// chatFolded is a message folded rune by rune, with a way back to the original.
type chatFolded struct {
	s        string // " " + folded + " "
	byteRune []int  // byte offset in s -> rune index in the original (-1 for the padding)
	nRunes   int
}

func chatFold(text string) chatFolded {
	var b strings.Builder
	b.Grow(len(text) + 2)
	byteRune := make([]int, 0, len(text)+3)
	b.WriteByte(' ')
	byteRune = append(byteRune, -1)
	n := 0
	for _, r := range text {
		fr := chatFoldRune(r)
		size := utf8.RuneLen(fr)
		if size < 0 {
			fr, size = utf8.RuneError, 3
		}
		b.WriteRune(fr)
		for k := 0; k < size; k++ {
			byteRune = append(byteRune, n)
		}
		n++
	}
	b.WriteByte(' ')
	byteRune = append(byteRune, n, n) // trailing pad and end
	return chatFolded{s: b.String(), byteRune: byteRune, nRunes: n}
}

// chatSpan is a half-open range of rune indices in the original text.
type chatSpan struct{ start, end int }

type chatWordHit struct {
	span chatSpan
	word string
}

// findWords returns every blocked word in text, outside the link spans.
func (f *ChatFilter) findWords(text string, skip []chatSpan) []chatWordHit {
	squashed := chatSquash(text)
	var fd *chatFolded
	var hits []chatWordHit
	for _, w := range f.words {
		if !strings.Contains(squashed, w.key) {
			continue
		}
		if fd == nil {
			v := chatFold(text)
			fd = &v
		}
		s := fd.s
		pos := 0
		for pos < len(s) {
			loc := w.re.FindStringSubmatchIndex(s[pos:])
			if loc == nil {
				break
			}
			gs, ge := pos+loc[2], pos+loc[3]
			span := chatSpan{fd.byteRune[gs], fd.byteRune[ge]}
			if f.acceptHit(s[gs:ge], span, skip) {
				hits = append(hits, chatWordHit{span: span, word: w.word})
				pos = ge
			} else {
				_, size := utf8.DecodeRuneInString(s[gs:])
				pos = gs + size
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].span.start < hits[j].span.start })
	return hits
}

// acceptHit rules out matches that are only digits/symbols (frequencies, "455"),
// built-in exception words, and anything inside a link.
func (f *ChatFilter) acceptHit(match string, span chatSpan, skip []chatSpan) bool {
	hasLetter := false
	var plain strings.Builder
	for _, r := range match {
		if unicode.IsLetter(r) {
			hasLetter = true
			plain.WriteRune(r)
		} else if m, ok := chatLeetReverse[r]; ok {
			plain.WriteRune(m)
		}
	}
	if !hasLetter || chatExceptions[plain.String()] {
		return false
	}
	for _, sk := range skip {
		if span.start < sk.end && sk.start < span.end {
			return false
		}
	}
	return true
}

// Link detection: http(s) URLs, www. addresses and bare domains with a common
// top-level domain. Short TLDs that are also everyday words (it, in, no, to, so,
// me, ...) are left out so "ok.so" or "hi.it" are not taken for links.
var chatLinkRe = regexp.MustCompile(`(?i)\bhttps?://[^\s<>"']+|\bwww\.[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:/[^\s<>"']*)?`)

// chatLinkTLDs are the top-level domains that make "name.tld" count as a link.
var chatLinkTLDs = map[string]bool{}

func init() {
	for _, t := range strings.Fields(`
		community online website digital stream travel store cloud click space world today radio email
		info blog news tech shop live link page site club life wiki guru media zone
		com net org edu gov mil int biz xyz app dev top pro fun
		io co uk de fr nl eu ru tv ly gg ca au jp cn es pl se ch dk fi nz za br mx ar cz sk hu ro gr
		pt ie ua ai cc ws fm su tk ml ga cf gq ir kr tw hk sg il tr`) {
		chatLinkTLDs[t] = true
	}
}

type chatLink struct {
	span chatSpan
	host string
}

func chatFindLinks(text string) []chatLink {
	locs := chatLinkRe.FindAllStringIndex(text, -1)
	if locs == nil {
		return nil
	}
	var out []chatLink
	for _, loc := range locs {
		m := text[loc[0]:loc[1]]
		host := chatNormaliseDomain(m)
		if lm := strings.ToLower(m); !strings.Contains(lm, "://") && !strings.HasPrefix(lm, "www.") {
			if host == "" || !chatLinkTLDs[host[strings.LastIndex(host, ".")+1:]] {
				continue // "14.074", "f.u.c.k", "file.txt": not a link
			}
		}
		out = append(out, chatLink{
			span: chatSpan{utf8.RuneCountInString(text[:loc[0]]), utf8.RuneCountInString(text[:loc[1]])},
			host: host,
		})
	}
	return out
}

// chatNormaliseDomain turns a URL or domain into a bare lower-case host name:
// "https://www.QRZ.com/db" -> "qrz.com". Returns "" if nothing usable is left.
func chatNormaliseDomain(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndex(s, "@"); i >= 0 {
		s = s[i+1:]
	}
	if i := strings.Index(s, ":"); i >= 0 {
		s = s[:i]
	}
	s = strings.Trim(s, ".")
	s = strings.TrimPrefix(s, "www.")
	if !chatDomainRe.MatchString(s) {
		return ""
	}
	return s
}

var chatDomainRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$`)

func (f *ChatFilter) linkAllowed(host string) bool {
	switch f.links {
	case ChatLinksAllow:
		return true
	case ChatLinksAllowlist:
		for _, d := range f.allowlist {
			if host == d || strings.HasSuffix(host, "."+d) {
				return true
			}
		}
	}
	return false
}

// Check runs a chat message through the word and link filter.
func (f *ChatFilter) Check(text string) ChatFilterResult {
	links := chatFindLinks(text)
	var skip []chatSpan
	var badHosts []string
	for _, l := range links {
		skip = append(skip, l.span)
		if !f.linkAllowed(l.host) {
			badHosts = append(badHosts, l.host)
		}
	}
	if len(badHosts) > 0 {
		reason := "contains a link"
		if f.links == ChatLinksAllowlist {
			reason = "contains a link to a site that is not allowed"
		}
		return ChatFilterResult{Status: ChatStatusBlocked, Matches: chatDedupe(badHosts), Reason: reason, Strike: true}
	}

	hits := f.findWords(text, skip)
	if len(hits) == 0 {
		return ChatFilterResult{Status: ChatStatusOK, Output: text}
	}
	var words []string
	for _, h := range hits {
		words = append(words, h.word)
	}
	res := ChatFilterResult{Matches: chatDedupe(words), Reason: "contains a blocked word", Strike: true}
	if f.mode == ChatModeBlock {
		res.Status = ChatStatusBlocked
		return res
	}
	runes := []rune(text)
	for _, h := range hits {
		for k := h.span.start + 1; k < h.span.end-1 && k < len(runes); k++ {
			runes[k] = '*'
		}
	}
	res.Status = ChatStatusCensored
	res.Output = string(runes)
	return res
}

func chatDedupe(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// UsernameBlocked applies today's username rule (a blocked word at the start or
// end of the name, or next to a digit or symbol) to the built-in and custom words,
// and also catches the dodges Check catches. Exception words (assassin, class)
// and callsign-shaped names (M0ASS) are allowed.
func (f *ChatFilter) UsernameBlocked(name string) bool {
	lower := chatFoldWord(name)
	for _, cw := range f.words {
		w := cw.word
		for idx := 0; idx < len(lower); {
			p := strings.Index(lower[idx:], w)
			if p < 0 {
				break
			}
			at := idx + p
			end := at + len(w)
			beforeOK := at == 0 || !chatIsASCIILetter(rune(lower[at-1]))
			afterOK := end >= len(lower) || !chatIsASCIILetter(rune(lower[end]))
			if (beforeOK || afterOK) && !chatUsernameExempt(lower, at, end) {
				return true
			}
			idx = at + 1
		}
	}
	return len(f.findWords(name, nil)) > 0
}

// chatUsernameExempt reports whether the match [at,end) in a folded name sits in
// an exception word or a callsign.
func chatUsernameExempt(lower string, at, end int) bool {
	ls, le := at, end
	for ls > 0 && chatIsASCIILetter(rune(lower[ls-1])) {
		ls--
	}
	for le < len(lower) && chatIsASCIILetter(rune(lower[le])) {
		le++
	}
	if chatExceptions[lower[ls:le]] {
		return true
	}
	ts, te := at, end
	for ts > 0 && chatIsAlnumByte(lower[ts-1]) {
		ts--
	}
	for te < len(lower) && chatIsAlnumByte(lower[te]) {
		te++
	}
	return chatCallsignRe.MatchString(lower[ts:te])
}

func chatIsAlnumByte(b byte) bool { return (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') }

// normaliseChatModerationSettings validates and tidies settings from the admin
// page or the file. Bad enum values are an error; bad words and allowlist
// entries are dropped and reported in rejected; notes are informational.
func normaliseChatModerationSettings(in ChatModerationSettings) (ChatModerationSettings, []string, []RejectedWord, error) {
	def := DefaultChatModerationSettings()
	out := in.clone()
	var notes []string
	rejected := []RejectedWord{}

	out.Mode = strings.ToLower(strings.TrimSpace(out.Mode))
	if out.Mode == "" {
		out.Mode = def.Mode
	}
	if out.Mode != ChatModeCensor && out.Mode != ChatModeBlock {
		return out, nil, nil, fmt.Errorf(`"What happens to bad words" must be "censor" or "block", not %q`, in.Mode)
	}
	out.Links = strings.ToLower(strings.TrimSpace(out.Links))
	if out.Links == "" {
		out.Links = def.Links
	}
	if out.Links != ChatLinksAllow && out.Links != ChatLinksBlock && out.Links != ChatLinksAllowlist {
		return out, nil, nil, fmt.Errorf(`"Links" must be "allow", "block" or "allowlist", not %q`, in.Links)
	}

	builtin := map[string]bool{}
	for _, w := range getProfanityList() {
		builtin[w] = true
	}
	seen := map[string]bool{}
	dupBuiltin := 0
	words := []string{}
	for _, raw := range in.Words {
		w := chatFoldWord(raw)
		if w == "" || seen[w] {
			continue
		}
		seen[w] = true
		if reason := chatWordProblem(w); reason != "" {
			rejected = append(rejected, RejectedWord{Word: strings.TrimSpace(raw), Reason: reason})
			continue
		}
		if builtin[w] {
			dupBuiltin++
			continue
		}
		if len(words) >= ChatMaxCustomWords {
			rejected = append(rejected, RejectedWord{Word: strings.TrimSpace(raw),
				Reason: fmt.Sprintf("Too many words (the limit is %d)", ChatMaxCustomWords)})
			continue
		}
		words = append(words, w)
	}
	out.Words = words
	if dupBuiltin == 1 {
		notes = append(notes, "1 word is already in the built-in list")
	} else if dupBuiltin > 1 {
		notes = append(notes, fmt.Sprintf("%d words are already in the built-in list", dupBuiltin))
	}

	domains := []string{}
	seenDomain := map[string]bool{}
	for _, raw := range in.LinkAllowlist {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		d := chatNormaliseDomain(raw)
		if d == "" {
			rejected = append(rejected, RejectedWord{Word: strings.TrimSpace(raw), Reason: "Not a website address (example: qrz.com)"})
			continue
		}
		if seenDomain[d] {
			continue
		}
		if len(domains) >= chatMaxAllowlistLen {
			rejected = append(rejected, RejectedWord{Word: strings.TrimSpace(raw),
				Reason: fmt.Sprintf("Too many websites (the limit is %d)", chatMaxAllowlistLen)})
			continue
		}
		seenDomain[d] = true
		domains = append(domains, d)
	}
	out.LinkAllowlist = domains

	clamp := func(v *int, def, lo, hi int) {
		if *v <= 0 {
			*v = def
		}
		if *v < lo {
			*v = lo
		}
		if *v > hi {
			*v = hi
		}
	}
	clamp(&out.AutoModeration.Strikes, def.AutoModeration.Strikes, 1, 100)
	clamp(&out.AutoModeration.WindowMinutes, def.AutoModeration.WindowMinutes, 1, 1440)
	clamp(&out.AutoModeration.ChatBanMinutes, def.AutoModeration.ChatBanMinutes, 1, 60*24*365)
	clamp(&out.SDREscalation.ChatBans, def.SDREscalation.ChatBans, 1, 100)
	clamp(&out.SDREscalation.WindowDays, def.SDREscalation.WindowDays, 1, 365)
	return out, notes, rejected, nil
}

// chatWordProblem returns a plain reason why a (folded) custom word is refused,
// or "" if it is fine.
func chatWordProblem(w string) string {
	letters, n := 0, 0
	for _, r := range w {
		n++
		switch {
		case unicode.IsLetter(r):
			letters++
		case unicode.IsDigit(r), r == ' ', r == '-', r == '\'':
		default:
			return "Use letters and numbers only"
		}
	}
	if n > ChatMaxWordLength {
		return fmt.Sprintf("Too long (at most %d characters)", ChatMaxWordLength)
	}
	if letters == 0 {
		return "Numbers on their own can't be blocked"
	}
	if letters < ChatMinWordLetters {
		return fmt.Sprintf("Too short (at least %d letters)", ChatMinWordLetters)
	}
	return ""
}
