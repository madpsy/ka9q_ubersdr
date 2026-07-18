package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"text/template"
	"time"
)

// webhookTemplateFuncs provides helper functions available in webhook body templates.
// These are intentionally minimal — the template data struct already contains
// pre-formatted strings, so most formatting is done at the data level.
var webhookTemplateFuncs = template.FuncMap{
	// jsonEscape encodes a string as a JSON string value (without surrounding quotes),
	// escaping backslashes, double-quotes, and control characters. Use this when
	// embedding .Message inside a JSON template to prevent broken JSON:
	//   {"message":"{{jsonEscape .Message}}"}
	"jsonEscape": func(s string) (string, error) {
		b, err := json.Marshal(s)
		if err != nil {
			return "", err
		}
		// json.Marshal produces `"value"` — strip the surrounding quotes.
		return string(b[1 : len(b)-1]), nil
	},
	// upper converts a string to upper case.
	"upper": strings.ToUpper,
	// lower converts a string to lower case.
	"lower": strings.ToLower,
}

// WebhookChannel implements NotificationChannel for generic HTTP webhooks.
// It supports ntfy, Slack, Discord, Zapier, Home Assistant, n8n, and any
// custom HTTP endpoint. Payload format is selectable (text, json, slack,
// discord) or fully customisable via a Go text/template body template.
// An optional HMAC-SHA256 signing secret adds X-Hub-Signature-256 so
// receivers can verify authenticity.
type WebhookChannel struct {
	name     string
	cfg      NotificationChannelConfig
	client   *http.Client
	bodyTmpl *template.Template // non-nil when cfg.WebhookBodyTemplate is set
}

// NewWebhookChannel creates a WebhookChannel with a pre-configured HTTP client.
// The client enforces the configured timeout, verifies TLS certificates (unless
// WebhookInsecureSkipVerify is set), and never follows redirects to prevent
// SSRF via redirect chains. The body template (if any) is compiled once here
// so Send never fails due to a template parse error at runtime.
func NewWebhookChannel(name string, cfg NotificationChannelConfig) *WebhookChannel {
	timeout := cfg.WebhookTimeoutSeconds
	if timeout <= 0 {
		timeout = 10
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.WebhookInsecureSkipVerify, //nolint:gosec // user-opt-in for LAN self-signed certs
		},
	}
	client := &http.Client{
		Timeout:   time.Duration(timeout) * time.Second,
		Transport: transport,
		// Never follow redirects — prevents SSRF via redirect chains and
		// avoids silently sending credentials to a different host.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	var bodyTmpl *template.Template
	if cfg.WebhookBodyTemplate != "" {
		// Template was already validated at config save time; parse errors here
		// are unexpected but we handle them gracefully by logging and falling
		// back to the format-based body.
		t, err := template.New("webhook_body").Funcs(webhookTemplateFuncs).Parse(cfg.WebhookBodyTemplate)
		if err != nil {
			log.Printf("[Webhook:%s] body template parse error (falling back to format): %v", name, err)
		} else {
			bodyTmpl = t
		}
	}

	return &WebhookChannel{name: name, cfg: cfg, client: client, bodyTmpl: bodyTmpl}
}

func (w *WebhookChannel) Name() string { return w.name }
func (w *WebhookChannel) Type() string { return "webhook" }

// Send delivers message to the configured webhook URL. It retries once on
// transient network errors (same pattern as EmailChannel).
func (w *WebhookChannel) Send(message string) (ChannelResponse, error) {
	return w.SendWithEvent(message, "", "")
}

// SendWithEvent is Send with the triggering event type (e.g. "dx_spot") and
// rule name included in the payload — in the "json" format's "event"/"rule"
// fields and as {{.Event}}/{{.Rule}} in body templates. Implements
// eventAwareSender.
func (w *WebhookChannel) SendWithEvent(message, eventType, rule string) (ChannelResponse, error) {
	return w.sendWithRetry(message, eventType, rule, 2)
}

func (w *WebhookChannel) sendWithRetry(message, eventType, rule string, attemptsLeft int) (ChannelResponse, error) {
	resp, err := w.doSend(message, eventType, rule)
	if err != nil && isTransientWebhookError(err) && attemptsLeft > 1 {
		log.Printf("[Webhook:%s] send error (retrying): %v", w.name, err)
		time.Sleep(2 * time.Second)
		return w.sendWithRetry(message, eventType, rule, attemptsLeft-1)
	}
	return resp, err
}

func (w *WebhookChannel) doSend(message, eventType, rule string) (ChannelResponse, error) {
	body, contentType := w.buildBody(message, eventType, rule)

	method := strings.ToUpper(w.cfg.WebhookMethod)
	if method == "" {
		method = "POST"
	}

	req, err := http.NewRequest(method, w.cfg.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return ChannelResponse{}, fmt.Errorf("webhook: build request: %w", err)
	}

	req.Header.Set("Content-Type", contentType)
	req.Header.Set("User-Agent", "UberSDR/"+Version)
	req.Header.Set("X-UberSDR-Channel", w.name)

	// Apply custom headers (validated at config load time — safe to set directly).
	// These are applied after the defaults so the user can override Content-Type
	// (e.g. to set a specific charset or vendor media type).
	for k, v := range w.cfg.WebhookHeaders {
		req.Header.Set(k, v)
	}

	// HMAC-SHA256 signature over the raw body — GitHub-style.
	// Computed after custom headers so the signature covers the final body.
	// Receivers can verify: sha256(secret, body) == header value.
	if w.cfg.WebhookSecret != "" {
		mac := hmac.New(sha256.New, []byte(w.cfg.WebhookSecret))
		mac.Write(body)
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}

	httpResp, err := w.client.Do(req)
	if err != nil {
		return ChannelResponse{}, fmt.Errorf("webhook: request to %s: %w", w.cfg.WebhookURL, err)
	}
	defer httpResp.Body.Close()

	// Read up to 512 bytes of the response body for error messages and logging.
	snippet, _ := io.ReadAll(io.LimitReader(httpResp.Body, 512))
	chResp := ChannelResponse{StatusCode: httpResp.StatusCode, Body: strings.TrimSpace(string(snippet))}

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return chResp, fmt.Errorf("webhook: server returned %d: %s",
			httpResp.StatusCode, chResp.Body)
	}
	return chResp, nil
}

// buildBody returns the request body bytes and Content-Type for the configured
// format. When WebhookBodyTemplate is set it takes precedence over WebhookFormat.
//
// Supported formats (used when no body template is set):
//
//	"text"    — text/plain, body = rendered message (ntfy, custom)
//	"json"    — application/json, structured envelope {channel, message, timestamp}
//	"slack"   — application/json, {"text":"…"} (Slack incoming webhooks)
//	"discord" — application/json, {"content":"…"} (Discord webhooks)
//
// Body template (overrides format):
//
//	A Go text/template string rendered against WebhookTemplateData.
//	Content-Type defaults to application/json; override via WebhookHeaders.
//	Example: {"message":"{{.Message}}","title":"UberSDR","priority":5}
func (w *WebhookChannel) buildBody(message, eventType, rule string) ([]byte, string) {
	// Body template takes precedence over format.
	if w.bodyTmpl != nil {
		data := WebhookTemplateData{
			Message:   message,
			Channel:   w.name,
			Event:     eventType,
			Rule:      rule,
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		}
		var buf bytes.Buffer
		if err := w.bodyTmpl.Execute(&buf, data); err != nil {
			// Template execution failure — fall through to format-based body
			// and log the error so the admin can diagnose it.
			log.Printf("[Webhook:%s] body template execute error (falling back to format): %v", w.name, err)
		} else {
			// Default Content-Type for template mode is application/json.
			// The user can override this via WebhookHeaders["Content-Type"].
			return buf.Bytes(), "application/json"
		}
	}

	// Format-based body.
	switch w.cfg.WebhookFormat {
	case "json":
		payload := map[string]string{
			"channel":   w.name,
			"message":   message,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		}
		if eventType != "" {
			payload["event"] = eventType
		}
		if rule != "" {
			payload["rule"] = rule
		}
		b, _ := json.Marshal(payload)
		return b, "application/json"
	case "slack":
		b, _ := json.Marshal(map[string]string{"text": message})
		return b, "application/json"
	case "discord":
		b, _ := json.Marshal(map[string]string{"content": message})
		return b, "application/json"
	default: // "text"
		return []byte(message), "text/plain; charset=utf-8"
	}
}

// isTransientWebhookError reports whether err looks like a temporary network
// condition worth one retry.
func isTransientWebhookError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "dial") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "eof")
}
