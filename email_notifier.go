package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// EmailChannel implements NotificationChannel for plain SMTP. One generic SMTP
// channel covers every provider — Gmail, Outlook, Fastmail, a self-hosted MTA,
// or a transactional provider (SendGrid, Mailgun, SES) — they differ only in
// host/port/security/credentials. Gmail uses a 16-character App Password (the
// account needs 2-Step Verification) as the password; no OAuth is involved.
//
// No external dependencies — built on the standard net/smtp and crypto/tls.
type EmailChannel struct {
	name string
	cfg  NotificationChannelConfig
}

// NewEmailChannel creates a new EmailChannel.
func NewEmailChannel(name string, cfg NotificationChannelConfig) *EmailChannel {
	return &EmailChannel{name: name, cfg: cfg}
}

func (e *EmailChannel) Name() string { return e.name }
func (e *EmailChannel) Type() string { return "email" }

// Send delivers message as an email. The subject is built from the configured
// prefix plus the first non-empty line of the rendered message, so each alert
// gets a meaningful, dynamic subject without any per-rule configuration.
// It retries once on a transient connection error.
func (e *EmailChannel) Send(message string) (ChannelResponse, error) {
	return e.sendWithRetry(message, 2)
}

func (e *EmailChannel) sendWithRetry(message string, attemptsLeft int) (ChannelResponse, error) {
	if e.cfg.SMTPHost == "" {
		return ChannelResponse{}, fmt.Errorf("email: smtp_host not configured")
	}
	recipients := e.recipients()
	if len(recipients) == 0 {
		return ChannelResponse{}, fmt.Errorf("email: no recipients configured")
	}

	port := e.cfg.SMTPPort
	if port == 0 {
		port = 587
	}
	security := strings.ToLower(strings.TrimSpace(e.cfg.SMTPSecurity))
	if security == "" {
		security = "starttls"
	}

	prefix := e.cfg.SubjectPrefix
	if prefix == "" {
		prefix = "[UberSDR]"
	}
	subject := emailSubject(prefix, message)
	msg := e.buildMessage(subject, recipients, message)

	addr := net.JoinHostPort(e.cfg.SMTPHost, strconv.Itoa(port))
	err := e.deliver(addr, security, recipients, msg)
	if err != nil && isTransientSMTPError(err) && attemptsLeft > 1 {
		log.Printf("[Email:%s] send error (retrying): %v", e.name, err)
		time.Sleep(2 * time.Second)
		return e.sendWithRetry(message, attemptsLeft-1)
	}
	if err != nil {
		return ChannelResponse{Body: err.Error()}, err
	}
	// SMTP success — no HTTP status code; body summarises recipients.
	return ChannelResponse{Body: fmt.Sprintf("delivered to %d recipient(s): %s",
		len(recipients), strings.Join(recipients, ", "))}, nil
}

// deliver opens the SMTP connection (honouring the security mode), authenticates
// if credentials are present, and writes the message.
func (e *EmailChannel) deliver(addr, security string, recipients []string, msg []byte) error {
	host := e.cfg.SMTPHost
	tlsConfig := &tls.Config{ServerName: host}
	dialer := &net.Dialer{Timeout: 15 * time.Second}

	var client *smtp.Client
	var err error
	if security == "tls" {
		conn, derr := tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
		if derr != nil {
			return fmt.Errorf("email: TLS dial %s: %w", addr, derr)
		}
		client, err = smtp.NewClient(conn, host)
	} else {
		conn, derr := dialer.Dial("tcp", addr)
		if derr != nil {
			return fmt.Errorf("email: dial %s: %w", addr, derr)
		}
		client, err = smtp.NewClient(conn, host)
	}
	if err != nil {
		return fmt.Errorf("email: SMTP handshake: %w", err)
	}
	defer client.Close()

	if security == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("email: server %s does not advertise STARTTLS (try security 'tls' or port 465)", host)
		}
		if err := client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("email: STARTTLS: %w", err)
		}
	}

	if e.cfg.SMTPUsername != "" {
		auth := smtp.PlainAuth("", e.cfg.SMTPUsername, e.cfg.SMTPPassword, host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("email: auth failed (for Gmail use an App Password, not your account password): %w", err)
		}
	}

	if err := client.Mail(e.fromAddress()); err != nil {
		return fmt.Errorf("email: MAIL FROM: %w", err)
	}
	for _, rcpt := range recipients {
		if err := client.Rcpt(rcpt); err != nil {
			return fmt.Errorf("email: RCPT TO %s: %w", rcpt, err)
		}
	}

	wc, err := client.Data()
	if err != nil {
		return fmt.Errorf("email: DATA: %w", err)
	}
	if _, err := wc.Write(msg); err != nil {
		_ = wc.Close()
		return fmt.Errorf("email: write body: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("email: finalise body: %w", err)
	}
	return client.Quit()
}

// recipients returns the trimmed, non-empty envelope recipient addresses.
func (e *EmailChannel) recipients() []string {
	out := make([]string, 0, len(e.cfg.EmailTo))
	for _, r := range e.cfg.EmailTo {
		addr := envelopeAddress(strings.TrimSpace(r))
		if addr != "" {
			out = append(out, addr)
		}
	}
	return out
}

// fromAddress returns the bare envelope sender derived from EmailFrom.
func (e *EmailChannel) fromAddress() string {
	return envelopeAddress(e.cfg.EmailFrom)
}

// buildMessage assembles a multipart/alternative RFC 5322 message. Rule
// templates are written for Telegram, so a message may contain HTML markup
// (<b>, <a>, <code>, …), emoji, and \n line breaks. We send both:
//   - a text/html part that renders that markup (newlines preserved), and
//   - a text/plain part with tags stripped and entities decoded as a fallback.
//
// Both parts are quoted-printable encoded so UTF-8/emoji survive servers that
// don't advertise 8BITMIME.
func (e *EmailChannel) buildMessage(subject string, recipients []string, body string) []byte {
	fromHeader := strings.TrimSpace(e.cfg.EmailFrom)
	if fromHeader == "" {
		fromHeader = strings.Join(recipients, ", ")
	}
	if a, err := mail.ParseAddress(fromHeader); err == nil {
		fromHeader = a.String() // RFC 2047-encodes the display name if needed
	}

	plainText := html.UnescapeString(stripTags(body))
	htmlText := bodyToHTML(body)

	// Build the multipart body (everything after the top-level headers).
	var partBuf bytes.Buffer
	mw := multipart.NewWriter(&partBuf)

	plainHdr := textproto.MIMEHeader{}
	plainHdr.Set("Content-Type", "text/plain; charset=utf-8")
	plainHdr.Set("Content-Transfer-Encoding", "quoted-printable")
	if pw, err := mw.CreatePart(plainHdr); err == nil {
		writeQuotedPrintable(pw, plainText)
	}

	htmlHdr := textproto.MIMEHeader{}
	htmlHdr.Set("Content-Type", "text/html; charset=utf-8")
	htmlHdr.Set("Content-Transfer-Encoding", "quoted-printable")
	if hw, err := mw.CreatePart(htmlHdr); err == nil {
		writeQuotedPrintable(hw, htmlText)
	}
	_ = mw.Close()

	var b bytes.Buffer
	b.WriteString("From: " + fromHeader + "\r\n")
	b.WriteString("To: " + strings.Join(recipients, ", ") + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("Message-ID: " + e.messageID() + "\r\n")
	// RFC 3834: mark automated mail so it doesn't trigger vacation auto-replies.
	b.WriteString("Auto-Submitted: auto-generated\r\n")
	b.WriteString("X-Mailer: UberSDR\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + mw.Boundary() + "\"\r\n")
	b.WriteString("\r\n")
	b.Write(partBuf.Bytes())
	return b.Bytes()
}

// writeQuotedPrintable QP-encodes s into w (line wrapping handled by the writer).
func writeQuotedPrintable(w io.Writer, s string) {
	qw := quotedprintable.NewWriter(w)
	_, _ = qw.Write([]byte(s))
	_ = qw.Close()
}

// htmlTagRe matches a plausible HTML/Telegram markup tag.
var htmlTagRe = regexp.MustCompile(`<[a-zA-Z/][^>]*>`)

// bodyToHTML renders the message as an HTML fragment. If it already contains
// markup (a Telegram HTML template) it is used as-is; otherwise it is escaped so
// a plain-text template displays literally. Either way it is wrapped in a
// white-space:pre-wrap container so \n line breaks render like they do in
// Telegram.
func bodyToHTML(body string) string {
	inner := body
	if !htmlTagRe.MatchString(body) {
		inner = html.EscapeString(body)
	}
	return "<!DOCTYPE html><html><body>" +
		`<div style="white-space:pre-wrap;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">` +
		inner +
		"</div></body></html>"
}

// messageID returns a unique RFC 5322 Message-ID anchored to the sender domain.
func (e *EmailChannel) messageID() string {
	buf := make([]byte, 16)
	domain := e.idDomain()
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("<%d.ubersdr@%s>", time.Now().UnixNano(), domain)
	}
	return fmt.Sprintf("<%x.%d@%s>", buf, time.Now().UnixNano(), domain)
}

// idDomain derives a domain for the Message-ID from the From address, falling
// back to the SMTP host.
func (e *EmailChannel) idDomain() string {
	addr := e.fromAddress()
	if at := strings.LastIndexByte(addr, '@'); at >= 0 && at < len(addr)-1 {
		return addr[at+1:]
	}
	if e.cfg.SMTPHost != "" {
		return e.cfg.SMTPHost
	}
	return "ubersdr.local"
}

// envelopeAddress extracts the bare address from a "Name <addr>" form, or
// returns the input unchanged if it cannot be parsed.
func envelopeAddress(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if a, err := mail.ParseAddress(s); err == nil {
		return a.Address
	}
	return s
}

// emailSubject builds "<prefix> <first line>", stripping any markup tags that a
// Telegram-style template may have left in the first line, and truncating to a
// sane length.
func emailSubject(prefix, body string) string {
	first := ""
	for _, line := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(html.UnescapeString(stripTags(line))); t != "" {
			first = t
			break
		}
	}
	subject := strings.TrimSpace(strings.TrimSpace(prefix) + " " + first)
	if subject == "" {
		subject = "UberSDR notification"
	}
	if r := []rune(subject); len(r) > 150 {
		subject = strings.TrimSpace(string(r[:150])) + "…"
	}
	return subject
}

// stripTags removes simple <...> markup so HTML templates don't leak tags into
// the subject line. It is intentionally minimal (no entity decoding).
func stripTags(s string) string {
	for {
		open := strings.IndexByte(s, '<')
		if open < 0 {
			return s
		}
		closeIdx := strings.IndexByte(s[open:], '>')
		if closeIdx < 0 {
			return s
		}
		s = s[:open] + s[open+closeIdx+1:]
	}
}

// isTransientSMTPError reports whether err looks like a temporary network/server
// condition worth one retry (dial timeouts, connection resets, 4xx greetings).
func isTransientSMTPError(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if ne, ok := err.(net.Error); ok {
		netErr = ne
	}
	if netErr != nil && netErr.Timeout() {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "dial") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "handshake") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "eof")
}
