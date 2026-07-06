// Package gudriver implements the Galactic Unicorn Display Protocol client.
//
// It provides a thin, self-contained HTTP driver for the Pimoroni Unicorn LED
// matrix family (Galactic 53×11, Stellar 16×16, Cosmic 32×32) running the
// UberSDR MicroPython firmware.
//
// The driver has no dependency on the main ka9q_ubersdr package; it can be
// imported by any Go code in this module that needs to send content to a
// Unicorn display — notification channels, frequency display updaters, CW spot
// displayers, etc.
//
// Protocol reference: clients/galactic_unicorn/DISPLAY_PROTOCOL.md
//
// # Quick start
//
//	c := gudriver.NewClient("http://192.168.1.42",
//	    gudriver.WithTimeout(5*time.Second))
//
//	resp, err := c.Display(gudriver.DisplayCommand{
//	    Priority:   5,
//	    Duration:   gudriver.DurationSeconds(10),
//	    Transition: gudriver.TransitionWipeLeft,
//	    Lines: []gudriver.DisplayLine{{
//	        Text:        "W1AW 14025 CW 599",
//	        Color:       "lime",
//	        Size:        1,
//	        Effect:      gudriver.EffectAuto,
//	        Y:           "middle",
//	        ScrollSpeed: 35,
//	        ScrollPause: 0.5,
//	        ScrollLoop:  true,
//	    }},
//	})
package gudriver

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ─── Protocol constants ───────────────────────────────────────────────────────

// Effect values for DisplayLine.Effect.
const (
	EffectAuto   = "auto"
	EffectStatic = "static"
	EffectScroll = "scroll"
	EffectBlink  = "blink"
	EffectPulse  = "pulse"
)

// Align values for DisplayLine.Align.
const (
	AlignLeft   = "left"
	AlignCenter = "center"
	AlignRight  = "right"
)

// Transition values for DisplayCommand.Transition.
const (
	TransitionCut       = "cut"
	TransitionFade      = "fade"
	TransitionWipeLeft  = "wipe_left"
	TransitionWipeRight = "wipe_right"
)

// ScrollStart values for DisplayLine.ScrollStart.
const (
	ScrollStartRight  = "right"
	ScrollStartLeft   = "left"
	ScrollStartCenter = "center"
)

// ─── Duration helper ──────────────────────────────────────────────────────────

// Duration is the JSON-level duration field: either a positive float64 (seconds)
// or the string "forever". Use DurationSeconds or DurationForever to construct.
type Duration struct {
	v interface{} // float64 or string "forever"
}

// DurationForever returns a Duration that keeps the message on screen
// indefinitely until replaced or cancelled.
func DurationForever() Duration { return Duration{v: "forever"} }

// DurationSeconds returns a Duration that expires after d seconds.
// Values ≤ 0 are treated as forever.
func DurationSeconds(d float64) Duration {
	if d <= 0 {
		return DurationForever()
	}
	return Duration{v: d}
}

// MarshalJSON implements json.Marshaler.
func (d Duration) MarshalJSON() ([]byte, error) {
	if d.v == nil {
		return json.Marshal("forever")
	}
	return json.Marshal(d.v)
}

// ─── Protocol types ───────────────────────────────────────────────────────────

// DisplayLine is one entry in the Lines array of a DisplayCommand.
// All fields except Text are optional; zero values use firmware defaults.
type DisplayLine struct {
	Text string `json:"text"`

	// Appearance
	Color string `json:"color,omitempty"` // named, hex, "rainbow", "gradient:c1:c2"
	Size  int    `json:"size,omitempty"`  // 1 (5 px), 2 (7 px), 3 (11 px)

	// Layout
	Effect string `json:"effect,omitempty"` // EffectAuto / Static / Scroll / Blink / Pulse
	Align  string `json:"align,omitempty"`  // AlignLeft / Center / Right
	Y      string `json:"y,omitempty"`      // "auto", "top", "middle", "bottom", or integer string

	// Scroll
	ScrollSpeed int     `json:"scroll_speed,omitempty"` // px/s, 1–200
	ScrollPause float64 `json:"scroll_pause,omitempty"` // seconds before first scroll
	ScrollLoop  bool    `json:"scroll_loop"`            // always serialised (default true)
	ScrollStart string  `json:"scroll_start,omitempty"` // ScrollStartRight / Left / Center

	// Blink
	BlinkRate float64 `json:"blink_rate,omitempty"` // Hz, 0.1–20

	// Pulse
	PulseSpeed float64 `json:"pulse_speed,omitempty"` // cycles/s, 0.1–10
	PulseMin   float64 `json:"pulse_min,omitempty"`   // 0.0–1.0
}

// DisplayCommand is the top-level body for POST /display with type="display".
// Zero values for optional fields use firmware defaults.
type DisplayCommand struct {
	// ID is optional. If set, a later message with the same ID replaces this
	// one in-place in the queue (useful for persistent displays like frequency).
	ID string `json:"id,omitempty"`

	Priority   int      `json:"priority,omitempty"`   // 0–10, default 5
	Duration   Duration `json:"duration"`             // DurationSeconds or DurationForever
	Transition string   `json:"transition,omitempty"` // TransitionCut / Fade / WipeLeft / WipeRight

	// Brightness overrides the global display brightness for this message only.
	// nil = don't override.
	Brightness *float64 `json:"brightness,omitempty"`

	BgColor string        `json:"bg_color,omitempty"`
	Lines   []DisplayLine `json:"lines"`
}

// MarshalJSON adds the required "type":"display" field.
func (c DisplayCommand) MarshalJSON() ([]byte, error) {
	type Alias DisplayCommand
	return json.Marshal(struct {
		Type string `json:"type"`
		Alias
	}{Type: "display", Alias: Alias(c)})
}

// ControlCommand is the top-level body for POST /display with type="control".
type ControlCommand struct {
	// Cmd is one of: "clear", "brightness", "cancel", "cancel_all", "status".
	Cmd string `json:"cmd"`

	// ID is required for Cmd="cancel".
	ID string `json:"id,omitempty"`

	// Value is required for Cmd="brightness" (0.0–1.0).
	Value *float64 `json:"value,omitempty"`
}

// MarshalJSON adds the required "type":"control" field.
func (c ControlCommand) MarshalJSON() ([]byte, error) {
	type Alias ControlCommand
	return json.Marshal(struct {
		Type string `json:"type"`
		Alias
	}{Type: "control", Alias: Alias(c)})
}

// ─── Response ─────────────────────────────────────────────────────────────────

// Response is the parsed body returned by the Pico W on success.
type Response struct {
	OK         bool   `json:"ok"`
	ID         string `json:"id"`
	Queued     bool   `json:"queued"`
	QueueDepth int    `json:"queue_depth"`

	// Raw HTTP status and body snippet for error reporting.
	StatusCode int
	Body       string
}

// ─── Client ───────────────────────────────────────────────────────────────────

// Client sends display and control commands to a single Galactic Unicorn device.
type Client struct {
	baseURL    string // e.g. "http://192.168.1.42"  (no trailing slash)
	httpClient *http.Client
	userAgent  string
}

// Option is a functional option for NewClient.
type Option func(*Client)

// WithTimeout sets the HTTP request timeout. Default: 5 s.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		c.httpClient.Timeout = d
	}
}

// WithInsecureSkipVerify disables TLS certificate verification.
// Only use this for self-signed certificates on private LANs.
func WithInsecureSkipVerify() Option {
	return func(c *Client) {
		c.httpClient.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, //nolint:gosec // user-opt-in for LAN self-signed certs
			},
		}
	}
}

// WithUserAgent overrides the User-Agent header sent with every request.
func WithUserAgent(ua string) Option {
	return func(c *Client) { c.userAgent = ua }
}

// NewClient creates a Client targeting the Unicorn device at baseURL.
// baseURL should be the scheme+host only, e.g. "http://192.168.1.42".
// Trailing slashes are stripped automatically.
func NewClient(baseURL string, opts ...Option) *Client {
	c := &Client{
		baseURL:   strings.TrimRight(baseURL, "/"),
		userAgent: "gudriver/1.0",
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{}, //nolint:gosec
			},
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Display sends a display command to POST /display and returns the parsed
// response. The caller is responsible for setting all desired fields on cmd;
// zero values use firmware defaults.
//
// SanitizeText is applied automatically to every DisplayLine.Text before the
// request is sent, replacing Unicode characters that the bitmap6 font cannot
// render with ASCII equivalents and stripping anything that has no equivalent.
func (c *Client) Display(cmd DisplayCommand) (Response, error) {
	for i := range cmd.Lines {
		cmd.Lines[i].Text = SanitizeText(cmd.Lines[i].Text)
	}
	return c.post(cmd)
}

// Control sends a control command (clear, brightness, cancel, etc.) to
// POST /display.
func (c *Client) Control(cmd ControlCommand) (Response, error) {
	return c.post(cmd)
}

// SetBrightness is a convenience wrapper around Control for the common case of
// adjusting global brightness (0.0–1.0).
func (c *Client) SetBrightness(brightness float64) (Response, error) {
	b := brightness
	return c.Control(ControlCommand{Cmd: "brightness", Value: &b})
}

// Clear immediately blanks the display and empties the queue.
func (c *Client) Clear() (Response, error) {
	return c.Control(ControlCommand{Cmd: "clear"})
}

// CancelMessage cancels the queued or active message with the given ID.
func (c *Client) CancelMessage(id string) (Response, error) {
	return c.Control(ControlCommand{Cmd: "cancel", ID: id})
}

// ─── Internal ─────────────────────────────────────────────────────────────────

func (c *Client) post(payload interface{}) (Response, error) {
	if c.baseURL == "" {
		return Response{}, fmt.Errorf("gudriver: baseURL is empty")
	}
	endpoint := c.baseURL + "/display"

	body, err := json.Marshal(payload)
	if err != nil {
		return Response{}, fmt.Errorf("gudriver: marshal: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Response{}, fmt.Errorf("gudriver: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.userAgent)

	httpResp, err := c.httpClient.Do(req)
	if err != nil {
		return Response{}, fmt.Errorf("gudriver: POST %s: %w", endpoint, err)
	}
	defer func() { _ = httpResp.Body.Close() }()

	snippet, _ := io.ReadAll(io.LimitReader(httpResp.Body, 512))
	resp := Response{
		StatusCode: httpResp.StatusCode,
		Body:       strings.TrimSpace(string(snippet)),
	}

	// Best-effort parse of the JSON response body.
	_ = json.Unmarshal(snippet, &resp)

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return resp, fmt.Errorf("gudriver: device returned %d: %s",
			httpResp.StatusCode, resp.Body)
	}
	return resp, nil
}

// IsTransientError reports whether err looks like a temporary network condition
// worth retrying (device briefly busy or rebooting).
func IsTransientError(err error) bool {
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
