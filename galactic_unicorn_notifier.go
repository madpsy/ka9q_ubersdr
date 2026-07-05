package main

// galactic_unicorn_notifier.go — NotificationChannel implementation for the
// Pimoroni Galactic Unicorn LED matrix display (Raspberry Pi Pico W).
//
// The channel POSTs a JSON display command to the Pico W's HTTP server
// (POST http://<device_url>/display) following the Galactic Unicorn Display
// Protocol defined in clients/galactic_unicorn/DISPLAY_PROTOCOL.md.
//
// The rendered notification message is placed in the first line's text field.
// All display parameters (colour, size, effect, scroll speed, duration,
// priority, transition, background colour) are configurable per-channel in
// notifications.yaml.
//
// Example notifications.yaml channel entry:
//
//	channels:
//	  shack_display:
//	    type: galactic_unicorn
//	    galactic_unicorn_url: http://192.168.1.42
//	    galactic_unicorn_color: amber
//	    galactic_unicorn_size: 1
//	    galactic_unicorn_effect: auto
//	    galactic_unicorn_scroll_speed: 35
//	    galactic_unicorn_duration: 10.0
//	    galactic_unicorn_priority: 5
//	    galactic_unicorn_transition: wipe_left
//	    galactic_unicorn_bg_color: ""
//	    galactic_unicorn_brightness: 0.0   # 0.0 = don't override

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// GalacticUnicornChannel implements NotificationChannel for the Galactic Unicorn.
type GalacticUnicornChannel struct {
	name   string
	cfg    NotificationChannelConfig
	client *http.Client
}

// NewGalacticUnicornChannel creates a GalacticUnicornChannel with a pre-configured
// HTTP client. TLS verification is skipped when GalacticUnicornInsecureSkipVerify
// is set (useful for self-signed certs on LAN devices).
func NewGalacticUnicornChannel(name string, cfg NotificationChannelConfig) *GalacticUnicornChannel {
	timeout := cfg.GalacticUnicornTimeoutSeconds
	if timeout <= 0 {
		timeout = 5
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.GalacticUnicornInsecureSkipVerify, //nolint:gosec // user-opt-in for LAN self-signed certs
		},
	}
	client := &http.Client{
		Timeout:   time.Duration(timeout) * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return &GalacticUnicornChannel{name: name, cfg: cfg, client: client}
}

func (g *GalacticUnicornChannel) Name() string { return g.name }
func (g *GalacticUnicornChannel) Type() string { return "galactic_unicorn" }

// Send delivers message as a display command to the Galactic Unicorn.
// The message string (rendered by the notification template) becomes the
// text of the first line. All display parameters come from the channel config.
func (g *GalacticUnicornChannel) Send(message string) (ChannelResponse, error) {
	return g.sendWithRetry(message, 2)
}

func (g *GalacticUnicornChannel) sendWithRetry(message string, attemptsLeft int) (ChannelResponse, error) {
	resp, err := g.doSend(message)
	if err != nil && isTransientGUError(err) && attemptsLeft > 1 {
		log.Printf("[GalacticUnicorn:%s] send error (retrying): %v", g.name, err)
		time.Sleep(2 * time.Second)
		return g.sendWithRetry(message, attemptsLeft-1)
	}
	return resp, err
}

// guDisplayLine is the JSON line object sent to the Pico W.
type guDisplayLine struct {
	Text        string  `json:"text"`
	Color       string  `json:"color"`
	Size        int     `json:"size"`
	Effect      string  `json:"effect"`
	Align       string  `json:"align"`
	Y           string  `json:"y"`
	ScrollSpeed int     `json:"scroll_speed,omitempty"`
	ScrollPause float64 `json:"scroll_pause,omitempty"`
	ScrollLoop  bool    `json:"scroll_loop"`
}

// guDisplayCommand is the top-level JSON body sent to POST /display.
type guDisplayCommand struct {
	Type       string          `json:"type"`
	ID         string          `json:"id,omitempty"`
	Priority   int             `json:"priority"`
	Duration   interface{}     `json:"duration"` // float64 or "forever"
	Transition string          `json:"transition"`
	Brightness *float64        `json:"brightness,omitempty"`
	BgColor    string          `json:"bg_color,omitempty"`
	Lines      []guDisplayLine `json:"lines"`
}

func (g *GalacticUnicornChannel) doSend(message string) (ChannelResponse, error) {
	cfg := g.cfg

	// Resolve model — informational; firmware auto-detects display dimensions.
	// Logged to help diagnose mismatched configs.
	model := cfg.GalacticUnicornModel
	if model == "" {
		model = "galactic"
	}
	log.Printf("[GalacticUnicorn:%s] sending to %s model (url: %s)", g.name, model, cfg.GalacticUnicornURL)

	// Resolve display URL — strip trailing slash, append /display
	baseURL := strings.TrimRight(cfg.GalacticUnicornURL, "/")
	if baseURL == "" {
		return ChannelResponse{}, fmt.Errorf("galactic_unicorn: galactic_unicorn_url is not configured")
	}
	endpoint := baseURL + "/display"

	// Resolve colour
	color := cfg.GalacticUnicornColor
	if color == "" {
		color = "white"
	}

	// Resolve size
	size := cfg.GalacticUnicornSize
	if size < 1 || size > 3 {
		size = 1
	}

	// Resolve effect
	effect := cfg.GalacticUnicornEffect
	if effect == "" {
		effect = "auto"
	}

	// Resolve align
	align := cfg.GalacticUnicornAlign
	if align == "" {
		align = "left"
	}

	// Resolve scroll speed
	scrollSpeed := cfg.GalacticUnicornScrollSpeed
	if scrollSpeed <= 0 {
		scrollSpeed = 40
	}

	// Resolve scroll pause
	scrollPause := cfg.GalacticUnicornScrollPause
	if scrollPause <= 0 {
		scrollPause = 1.0
	}

	// Resolve priority
	priority := cfg.GalacticUnicornPriority
	if priority < 0 || priority > 10 {
		priority = 5
	}

	// Resolve duration
	var duration interface{}
	if cfg.GalacticUnicornDuration <= 0 {
		duration = "forever"
	} else {
		duration = cfg.GalacticUnicornDuration
	}

	// Resolve transition
	transition := cfg.GalacticUnicornTransition
	if transition == "" {
		transition = "cut"
	}

	// Resolve brightness override (0.0 means "don't override")
	var brightnessPtr *float64
	if cfg.GalacticUnicornBrightness > 0.0 {
		b := cfg.GalacticUnicornBrightness
		brightnessPtr = &b
	}

	// Build the display command
	cmd := guDisplayCommand{
		Type:       "display",
		Priority:   priority,
		Duration:   duration,
		Transition: transition,
		Brightness: brightnessPtr,
		BgColor:    cfg.GalacticUnicornBgColor,
		Lines: []guDisplayLine{
			{
				Text:        message,
				Color:       color,
				Size:        size,
				Effect:      effect,
				Align:       align,
				Y:           "middle",
				ScrollSpeed: scrollSpeed,
				ScrollPause: scrollPause,
				ScrollLoop:  true,
			},
		},
	}

	body, err := json.Marshal(cmd)
	if err != nil {
		return ChannelResponse{}, fmt.Errorf("galactic_unicorn: marshal error: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return ChannelResponse{}, fmt.Errorf("galactic_unicorn: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "UberSDR/"+Version)
	req.Header.Set("X-UberSDR-Channel", g.name)

	httpResp, err := g.client.Do(req)
	if err != nil {
		return ChannelResponse{}, fmt.Errorf("galactic_unicorn: request to %s: %w", endpoint, err)
	}
	defer httpResp.Body.Close()

	snippet, _ := io.ReadAll(io.LimitReader(httpResp.Body, 512))
	chResp := ChannelResponse{StatusCode: httpResp.StatusCode, Body: strings.TrimSpace(string(snippet))}

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return chResp, fmt.Errorf("galactic_unicorn: device returned %d: %s",
			httpResp.StatusCode, chResp.Body)
	}
	return chResp, nil
}

// isTransientGUError reports whether err looks like a temporary network
// condition worth one retry (device may be briefly busy or rebooting).
func isTransientGUError(err error) bool {
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
