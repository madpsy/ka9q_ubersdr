package main

import (
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"testing"
)

func TestEmailSubject(t *testing.T) {
	cases := []struct {
		name   string
		prefix string
		body   string
		want   string
	}{
		{"prefix and first line", "[UberSDR]", "📻 CW: G3XYZ on 20m\nmore detail", "[UberSDR] 📻 CW: G3XYZ on 20m"},
		{"skips leading blank lines", "[UberSDR]", "\n\n  real line\n", "[UberSDR] real line"},
		{"strips html tags", "[UberSDR]", "<b>K=5</b> rising", "[UberSDR] K=5 rising"},
		{"empty body keeps prefix", "[UberSDR]", "   \n  ", "[UberSDR]"},
		{"empty body and prefix falls back", "", "   \n  ", "UberSDR notification"},
		{"empty prefix", "", "hello", "hello"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := emailSubject(c.prefix, c.body); got != c.want {
				t.Errorf("emailSubject(%q, %q) = %q, want %q", c.prefix, c.body, got, c.want)
			}
		})
	}

	// Long subjects are truncated with an ellipsis.
	long := emailSubject("[UberSDR]", strings.Repeat("x", 300))
	if r := []rune(long); len(r) > 151 {
		t.Errorf("subject not truncated: len=%d", len(r))
	}
}

func TestBuildMessageMultipart(t *testing.T) {
	e := NewEmailChannel("mail", NotificationChannelConfig{
		Type: "email", EmailFrom: "UberSDR <bot@example.com>",
	})
	// A Telegram-style HTML template with markup, emoji and a newline.
	body := "📻 <b>CW: G3XYZ</b>\nSNR &gt; 20 dB"
	msg := string(e.buildMessage("[UberSDR] CW: G3XYZ", []string{"you@example.com"}, body))

	mustContain := []string{
		"From: \"UberSDR\" <bot@example.com>",
		"To: you@example.com",
		"MIME-Version: 1.0",
		"Content-Type: multipart/alternative;",
		"Auto-Submitted: auto-generated",
		"Message-ID: <",
		"@example.com>", // Message-ID anchored to sender domain
		"Content-Type: text/plain; charset=utf-8",
		"Content-Type: text/html; charset=utf-8",
		"quoted-printable",
	}
	for _, want := range mustContain {
		if !strings.Contains(msg, want) {
			t.Errorf("message missing %q\n---\n%s", want, msg)
		}
	}

	// The HTML part must carry the markup verbatim (QP-decoded) and preserve the
	// newline via a pre-wrap container; the plain part must have tags stripped.
	plain, htmlPart := decodeAltParts(t, msg)
	if !strings.Contains(htmlPart, "<b>CW: G3XYZ</b>") {
		t.Errorf("html part lost markup: %q", htmlPart)
	}
	if !strings.Contains(htmlPart, "white-space:pre-wrap") {
		t.Errorf("html part missing pre-wrap wrapper: %q", htmlPart)
	}
	if strings.Contains(plain, "<b>") || !strings.Contains(plain, "CW: G3XYZ") {
		t.Errorf("plain part not de-tagged: %q", plain)
	}
	if !strings.Contains(plain, "SNR > 20 dB") { // entity decoded
		t.Errorf("plain part did not decode entities: %q", plain)
	}
}

// decodeAltParts splits a multipart/alternative message and returns the
// QP-decoded text/plain and text/html parts.
func decodeAltParts(t *testing.T, msg string) (plain, htmlPart string) {
	t.Helper()
	m, err := mail.ReadMessage(strings.NewReader(msg))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	_, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("ParseMediaType: %v", err)
	}
	mr := multipart.NewReader(m.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart: %v", err)
		}
		dec, _ := io.ReadAll(quotedprintable.NewReader(p))
		ct := p.Header.Get("Content-Type")
		if strings.HasPrefix(ct, "text/plain") {
			plain = string(dec)
		} else if strings.HasPrefix(ct, "text/html") {
			htmlPart = string(dec)
		}
	}
	return plain, htmlPart
}

func TestEnvelopeAddress(t *testing.T) {
	cases := map[string]string{
		"UberSDR <me@example.com>": "me@example.com",
		"me@example.com":           "me@example.com",
		"  me@example.com  ":       "me@example.com",
		"not an address":           "not an address",
		"":                         "",
	}
	for in, want := range cases {
		if got := envelopeAddress(in); got != want {
			t.Errorf("envelopeAddress(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidateEmailChannel(t *testing.T) {
	mk := func(ch NotificationChannelConfig) *NotificationsConfig {
		return &NotificationsConfig{
			Enabled:  true,
			Channels: map[string]NotificationChannelConfig{"mail": ch},
			Rules:    []NotificationRule{{Name: "r", Event: EventTypeServerStartup, Channels: []string{"mail"}}},
		}
	}

	// A complete, valid email channel produces no channel issues.
	valid := mk(NotificationChannelConfig{
		Type: "email", SMTPHost: "smtp.example.com", SMTPSecurity: "starttls",
		EmailFrom: "a@b.com", EmailTo: []string{"c@d.com"},
		SMTPUsername: "u", SMTPPassword: "p",
	})
	if issues := valid.Validate(); len(issues) != 0 {
		t.Fatalf("expected no issues, got %v", issues)
	}

	// Missing required fields and a bad security value are all reported.
	bad := mk(NotificationChannelConfig{Type: "email", SMTPSecurity: "ssl"})
	issues := bad.Validate()
	wantSubstr := []string{"smtp_host is required", "email_from is required", "at least one email_to", "smtp_security must be"}
	for _, want := range wantSubstr {
		if !containsAny(joinIssues(issues), []string{want}) {
			t.Errorf("expected issue containing %q, got %v", want, issues)
		}
	}

	// Username without password (or vice-versa) is flagged.
	mismatch := mk(NotificationChannelConfig{
		Type: "email", SMTPHost: "h", EmailFrom: "a@b.com", EmailTo: []string{"c@d.com"},
		SMTPUsername: "u",
	})
	if !containsAny(joinIssues(mismatch.Validate()), []string{"must be set together"}) {
		t.Errorf("expected username/password pairing issue, got %v", mismatch.Validate())
	}
}

func TestPerChannelTemplateRendering(t *testing.T) {
	cfg := &NotificationsConfig{
		Enabled: true,
		Channels: map[string]NotificationChannelConfig{
			"tg": {Type: "telegram", BotToken: "t", ChatID: "1"},
			"em": {Type: "email", SMTPHost: "h", EmailFrom: "a@b.com", EmailTo: []string{"c@d.com"}},
		},
		Rules: []NotificationRule{{
			Name:      "startup",
			Event:     EventTypeServerStartup,
			Channels:  []string{"tg", "em"},
			Template:  "<b>UberSDR {{.Version}}</b> up",                                   // default (Telegram HTML)
			Templates: map[string]string{"em": "UberSDR {{.Version}} is up (plain text)"}, // email override
		}},
	}
	m, err := NewNotificationManager(cfg)
	if err != nil {
		t.Fatalf("NewNotificationManager: %v", err)
	}

	evt := ServerStartupEvent{Version: "1.2.3"}
	tmpls := m.tmpls

	// Email uses its override.
	if got, err := m.renderForChannel("startup", "em", evt, tmpls); err != nil || got != "UberSDR 1.2.3 is up (plain text)" {
		t.Errorf("email render = %q (err %v), want override text", got, err)
	}
	// Telegram (no override) falls back to the rule default template.
	if got, err := m.renderForChannel("startup", "tg", evt, tmpls); err != nil || got != "<b>UberSDR 1.2.3</b> up" {
		t.Errorf("telegram render = %q (err %v), want default template", got, err)
	}

	// A channel with neither an override nor a rule default gets the built-in.
	cfg2 := &NotificationsConfig{
		Enabled:  true,
		Channels: map[string]NotificationChannelConfig{"tg": {Type: "telegram", BotToken: "t", ChatID: "1"}},
		Rules:    []NotificationRule{{Name: "r2", Event: EventTypeServerStartup, Channels: []string{"tg"}}},
	}
	m2, err := NewNotificationManager(cfg2)
	if err != nil {
		t.Fatalf("NewNotificationManager: %v", err)
	}
	got, err := m2.renderForChannel("r2", "tg", evt, m2.tmpls)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(got, "UberSDR") || !strings.Contains(got, "started") {
		t.Errorf("built-in default render = %q", got)
	}
}

func TestValidateTemplateOverrideChannel(t *testing.T) {
	cfg := &NotificationsConfig{
		Enabled:  true,
		Channels: map[string]NotificationChannelConfig{"tg": {Type: "telegram", BotToken: "t", ChatID: "1"}},
		Rules: []NotificationRule{{
			Name: "r", Event: EventTypeServerStartup, Channels: []string{"tg"},
			Templates: map[string]string{"email_main": "x"}, // not in Channels
		}},
	}
	if !containsAny(joinIssues(cfg.Validate()), []string{"not in the rule's channels"}) {
		t.Errorf("expected dead-override issue, got %v", cfg.Validate())
	}
}

func TestApplyChannelDefaultsEmail(t *testing.T) {
	ch := NotificationChannelConfig{Type: "email"}
	applyChannelDefaults(&ch)
	if ch.SMTPPort != 587 {
		t.Errorf("SMTPPort = %d, want 587", ch.SMTPPort)
	}
	if ch.SMTPSecurity != "starttls" {
		t.Errorf("SMTPSecurity = %q, want starttls", ch.SMTPSecurity)
	}
	if ch.SubjectPrefix != "[UberSDR]" {
		t.Errorf("SubjectPrefix = %q, want [UberSDR]", ch.SubjectPrefix)
	}
}

// helpers ----------------------------------------------------------------------

func joinIssues(issues []string) string {
	return strings.Join(issues, "\n")
}
