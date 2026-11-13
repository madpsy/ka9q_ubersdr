package main

import (
	"strings"
	"testing"
)

// starWord is the expected censored form of a built-in word today: first and
// last character kept (with their case), every character in between a star.
func starWord(w string) string {
	return w[:1] + strings.Repeat("*", len(w)-2) + w[len(w)-1:]
}

// TestBuiltinProfanityPinned pins today's censorProfanity/containsProfanity
// behaviour for every built-in word, so the new filter can be checked against it.
func TestBuiltinProfanityPinned(t *testing.T) {
	for _, w := range getProfanityList() {
		upper := strings.ToUpper(w)
		title := strings.ToUpper(w[:1]) + w[1:]
		cases := map[string]string{
			w:                                  starWord(w),
			upper:                              starWord(upper),
			title:                              starWord(title),
			"you " + w + "!":                   "you " + starWord(w) + "!",
			"(" + upper + ") and " + w + ".":   "(" + starWord(upper) + ") and " + starWord(w) + ".",
			w + "123":                          w + "123", // digits are word characters: no boundary
			"x" + w:                            "x" + w,
			"it's " + title + "'s fault, " + w: "it's " + starWord(title) + "'s fault, " + starWord(w),
		}
		for in, want := range cases {
			if got := censorProfanity(in); got != want {
				t.Errorf("censorProfanity(%q) = %q, want %q", in, got, want)
			}
		}
		// Username rule: matches at the start/end of the name or next to a non-letter.
		for _, name := range []string{w, upper, w + "123", "bob_" + w, w + "bob", "9" + w + "x"} {
			if !containsProfanity(name) {
				t.Errorf("containsProfanity(%q) = false, want true", name)
			}
		}
		if containsProfanity("zz" + w + "zz") {
			t.Errorf("containsProfanity(%q) = true, want false (buried in letters)", "zz"+w+"zz")
		}
	}

	clean := []string{
		"assassin", "class", "classic", "passage", "cockpit", "cocktail", "Scunthorpe",
		"M0ASS", "G4ASS", "2E0ASS", "on 14.074 MHz", "73 de G4ABC", "Dickens", "shiitake",
		"spice", "mongoose", "grass", "bass", "embassy",
	}
	for _, in := range clean {
		if got := censorProfanity(in); got != in {
			t.Errorf("censorProfanity(%q) = %q, want unchanged", in, got)
		}
	}
	// Today's username rule is cruder than the message rule; pin what it does now.
	for _, name := range []string{"Bob", "G4ABC", "classical", "passage"} {
		if containsProfanity(name) {
			t.Errorf("containsProfanity(%q) = true, want false", name)
		}
	}
	for _, name := range []string{"assassin", "class", "M0ASS"} {
		if !containsProfanity(name) {
			t.Errorf("containsProfanity(%q) = false; today's rule blocks it", name)
		}
	}
}

// pinnedCorpus mixes every built-in word with clean text, punctuation and case.
func pinnedCorpus() []string {
	var out []string
	for _, w := range getProfanityList() {
		up := strings.ToUpper(w)
		title := strings.ToUpper(w[:1]) + w[1:]
		out = append(out,
			w,
			"you "+w+"!",
			title+", what a "+up+" on 14.074",
			"\""+w+"\" and '"+w+"' and ("+w+")",
			w+"123 x"+w+" "+w+"_x",
			"G4ABC: "+w+" "+w+" "+w,
			"classic "+w+" in the cockpit",
		)
	}
	out = append(out,
		"good evening all, 73 de M0ASS and G4ASS",
		"the assassin left the class early",
		"Scunthorpe calling on 7.074",
		"",
		"plain message with nothing in it",
	)
	return out
}

func TestChatFilterMatchesBuiltinCensor(t *testing.T) {
	f := NewChatFilter(DefaultChatModerationSettings())
	for _, in := range pinnedCorpus() {
		want := censorProfanity(in)
		res := f.Check(in)
		if res.Output != want {
			t.Errorf("Check(%q).Output = %q, censorProfanity = %q", in, res.Output, want)
		}
		wantStatus := ChatStatusOK
		if want != in {
			wantStatus = ChatStatusCensored
		}
		if res.Status != wantStatus {
			t.Errorf("Check(%q).Status = %q, want %q", in, res.Status, wantStatus)
		}
		if res.Strike != (wantStatus != ChatStatusOK) {
			t.Errorf("Check(%q).Strike = %v", in, res.Strike)
		}
	}
}

func TestChatFilterDodges(t *testing.T) {
	f := NewChatFilter(DefaultChatModerationSettings())
	tests := []struct{ in, want string }{
		{"f.u.c.k off", "f*****k off"},
		{"f u c k off", "f*****k off"},
		{"F-U-C-K", "F*****K"},
		{"s_h_i_t", "s*****t"},
		{"f*u*c*k", "f*****k"},
		{"5h1t happens", "5**t happens"},
		{"sh!t", "s**t"},
		{"$hit", "$**t"},
		{"what a b1tch", "what a b***h"},
		{"a$$", "a*$"},
		{"@ss", "@*s"},
		{"fuuuuuck", "f******k"},
		{"shiiiit!", "s*****t!"},
		{"FUUUCK YOU", "F****K YOU"},
		{"аss", "а*s"},   // Cyrillic a
		{"shіt", "s**t"}, // Ukrainian i
		{"ｆｕｃｋ", "ｆ**ｋ"}, // fullwidth fuck
		{"сосk", "с**k"}, // Cyrillic c o c + latin k
		{"n1gg3r", "n****r"},
		{"ok f.u.c.k and shit", "ok f*****k and s**t"},
	}
	for _, tc := range tests {
		res := f.Check(tc.in)
		if res.Output != tc.want || res.Status != ChatStatusCensored || !res.Strike {
			t.Errorf("Check(%q) = %q (%s), want %q censored", tc.in, res.Output, res.Status, tc.want)
		}
	}

	clean := []string{
		"73 de M0ASS", "G4ASS 5/9", "2E0ASS", "QSY to 14.074", "try 7.4.5.5 later",
		"455 kHz IF", "use a ssh key", "I was so happy", "has seen it", "a s b",
		"assassin", "class", "classic", "passage", "cockpit", "cocktail", "Scunthorpe",
		"shiitake", "glass", "bass", "pass", "compass", "Dickens", "Hancock",
		"https://example.com/shit", "see www.example.org/fuck for details",
		"1.0.0.0", "S9+10", "QRZ?", "e.g. this",
	}
	for _, in := range clean {
		if res := f.Check(in); res.Status != ChatStatusOK || res.Output != in || res.Strike {
			t.Errorf("Check(%q) = %q (%s), want untouched", in, res.Output, res.Status)
		}
	}
}

func TestChatFilterMatchesReported(t *testing.T) {
	f := NewChatFilter(DefaultChatModerationSettings())
	res := f.Check("f.u.c.k and fuck and Shit")
	if strings.Join(res.Matches, ",") != "fuck,shit" {
		t.Errorf("Matches = %v, want [fuck shit]", res.Matches)
	}
	if res.Reason == "" {
		t.Error("Reason empty")
	}
}

func TestChatFilterBlockMode(t *testing.T) {
	s := DefaultChatModerationSettings()
	s.Mode = ChatModeBlock
	f := NewChatFilter(s)
	res := f.Check("you shit")
	if res.Status != ChatStatusBlocked || res.Output != "" || !res.Strike {
		t.Errorf("block mode: %+v", res)
	}
	if res := f.Check("hello 73"); res.Status != ChatStatusOK || res.Output != "hello 73" {
		t.Errorf("block mode clean: %+v", res)
	}
}

func TestChatFilterCustomWords(t *testing.T) {
	s := DefaultChatModerationSettings()
	s.Words = []string{"Muppet", "pirate radio"}
	f := NewChatFilter(s)
	tests := []struct{ in, want string }{
		{"you muppet", "you m****t"},
		{"MUPP3T", "M****T"},
		{"m.u.p.p.e.t", "m*********t"},
		{"run a pirate radio", "run a p**********o"},
		{"muppets", "muppets"}, // whole words only
	}
	for _, tc := range tests {
		if got := f.Check(tc.in).Output; got != tc.want {
			t.Errorf("Check(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if !f.UsernameBlocked("Muppet99") || !f.UsernameBlocked("bigmuppet") {
		t.Error("custom word not applied to usernames")
	}
}

func TestChatFilterUsernames(t *testing.T) {
	f := NewChatFilter(DefaultChatModerationSettings())
	// Every name today's rule blocks for a built-in word is still blocked,
	// apart from the exceptions and callsigns.
	for _, w := range getProfanityList() {
		for _, name := range []string{w, strings.ToUpper(w), w + "123", "bob_" + w, w + "bob"} {
			if !f.UsernameBlocked(name) {
				t.Errorf("UsernameBlocked(%q) = false", name)
			}
		}
	}
	for _, name := range []string{"f4gg0t", "sh1t", "аsshole", "f.u.c.k"} {
		if !f.UsernameBlocked(name) {
			t.Errorf("UsernameBlocked(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"Bob", "G4ABC", "M0ASS", "G4ASS", "2E0ASS", "assassin", "class",
		"classic", "Scunthorpe", "cockpit", "glass", "Dickens", "zzfuckzz"} {
		if f.UsernameBlocked(name) {
			t.Errorf("UsernameBlocked(%q) = true, want false", name)
		}
	}
}

func TestChatFilterLinks(t *testing.T) {
	mk := func(links string, allow ...string) *ChatFilter {
		s := DefaultChatModerationSettings()
		s.Links = links
		s.LinkAllowlist = allow
		return NewChatFilter(s)
	}
	links := []string{
		"see https://example.com/page",
		"http://example.com",
		"www.example.com",
		"go to example.com now",
		"sub.example.co.uk/path?x=1",
		"HTTPS://EXAMPLE.COM",
	}
	noLinks := []string{"14.074 MHz", "e.g. this", "f.u.c.k", "version 1.2.3", "Mr.Smith", "file.txt", "ok.so what"}

	allow := mk(ChatLinksAllow)
	for _, in := range links {
		if res := allow.Check(in); res.Status != ChatStatusOK {
			t.Errorf("allow: Check(%q) = %+v", in, res)
		}
	}
	block := mk(ChatLinksBlock)
	for _, in := range links {
		res := block.Check(in)
		if res.Status != ChatStatusBlocked || !res.Strike || res.Output != "" || !strings.Contains(res.Reason, "link") {
			t.Errorf("block: Check(%q) = %+v", in, res)
		}
	}
	for _, in := range noLinks {
		if res := block.Check(in); res.Status == ChatStatusBlocked {
			t.Errorf("block: Check(%q) = %+v, want not blocked (not a link)", in, res)
		}
	}
	al := mk(ChatLinksAllowlist, "qrz.com", "example.co.uk")
	for in, ok := range map[string]bool{
		"https://www.qrz.com/db/G4ABC": true,
		"qrz.com":                      true,
		"see lookup.qrz.com":           true,
		"sub.example.co.uk/path":       true,
		"https://notqrz.com":           false,
		"qrz.com.evil.net":             false,
		"https://evil.net/qrz.com":     false,
		"www.example.com":              false,
		"qrz.com and bad.net":          false,
	} {
		res := al.Check(in)
		if (res.Status == ChatStatusOK) != ok {
			t.Errorf("allowlist: Check(%q) = %+v, want ok=%v", in, res, ok)
		}
	}
	// Words in an allowed link are left alone; censoring still applies around it.
	if got := allow.Check("shit https://example.com/shit").Output; got != "s**t https://example.com/shit" {
		t.Errorf("link span censored: %q", got)
	}
}

func TestNormaliseChatModerationWords(t *testing.T) {
	in := DefaultChatModerationSettings()
	in.Words = []string{"Muppet", "muppet", " MUPPET ", "fuck", "Shit", "ab", "12345", "a1", "x-ray-y",
		strings.Repeat("abc", 11), "good word", "bad<word"}
	out, notes, rejected, err := normaliseChatModerationSettings(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(out.Words, "|") != "muppet|x-ray-y|good word" {
		t.Errorf("Words = %q", out.Words)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "2 words are already in the built-in list") {
		t.Errorf("notes = %q", notes)
	}
	reasons := map[string]string{}
	for _, r := range rejected {
		reasons[r.Word] = r.Reason
	}
	for _, w := range []string{"ab", "12345", "a1", strings.Repeat("abc", 11), "bad<word"} {
		if reasons[w] == "" {
			t.Errorf("%q not rejected (rejected=%v)", w, rejected)
		}
	}

	many := DefaultChatModerationSettings()
	for i := 0; i < 510; i++ {
		many.Words = append(many.Words, "word"+strings.Repeat("x", i%20)+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	out, _, rejected, _ = normaliseChatModerationSettings(many)
	if len(out.Words) != ChatMaxCustomWords || len(rejected) != 10 {
		t.Errorf("limit: kept %d, rejected %d", len(out.Words), len(rejected))
	}
}

func TestNormaliseChatModerationEnums(t *testing.T) {
	for _, mut := range []func(*ChatModerationSettings){
		func(s *ChatModerationSettings) { s.Mode = "delete" },
		func(s *ChatModerationSettings) { s.Links = "sometimes" },
	} {
		s := DefaultChatModerationSettings()
		mut(&s)
		if _, _, _, err := normaliseChatModerationSettings(s); err == nil {
			t.Errorf("no error for %+v", s)
		}
	}
	s := DefaultChatModerationSettings()
	s.Mode, s.Links = " BLOCK ", "AllowList"
	s.LinkAllowlist = []string{"https://www.QRZ.com/db", "qrz.com", "not a site"}
	out, _, rejected, err := normaliseChatModerationSettings(s)
	if err != nil {
		t.Fatal(err)
	}
	if out.Mode != ChatModeBlock || out.Links != ChatLinksAllowlist {
		t.Errorf("enums not normalised: %+v", out)
	}
	if strings.Join(out.LinkAllowlist, ",") != "qrz.com" || len(rejected) != 1 {
		t.Errorf("allowlist = %v rejected = %v", out.LinkAllowlist, rejected)
	}
}

func BenchmarkChatFilterCheck(b *testing.B) {
	f := NewChatFilter(DefaultChatModerationSettings())
	msg := "Good evening all, hearing G4ABC 5/9 on 14.074, what a shit band tonight f.u.c.k"
	for i := 0; i < b.N; i++ {
		f.Check(msg)
	}
}
