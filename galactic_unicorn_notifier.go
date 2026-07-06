package main

// galactic_unicorn_notifier.go — NotificationChannel implementation for the
// Pimoroni Galactic Unicorn LED matrix display (Raspberry Pi Pico W).
//
// This file is intentionally thin: it maps NotificationChannelConfig fields
// onto the gudriver.Client API and handles the notification-system concerns
// (naming, retry, ChannelResponse).  All protocol types and HTTP transport
// live in the gudriver sub-package so they can be reused by other parts of
// the server without duplicating the protocol.
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
	"fmt"
	"log"
	"time"

	"github.com/cwsl/ka9q_ubersdr/gudriver"
)

// GalacticUnicornChannel implements NotificationChannel for the Galactic Unicorn.
type GalacticUnicornChannel struct {
	name   string
	cfg    NotificationChannelConfig
	client *gudriver.Client
}

// NewGalacticUnicornChannel creates a GalacticUnicornChannel backed by a
// gudriver.Client.  TLS verification is skipped when
// GalacticUnicornInsecureSkipVerify is set (useful for self-signed certs on
// LAN devices).
func NewGalacticUnicornChannel(name string, cfg NotificationChannelConfig) *GalacticUnicornChannel {
	timeout := cfg.GalacticUnicornTimeoutSeconds
	if timeout <= 0 {
		timeout = 5
	}

	opts := []gudriver.Option{
		gudriver.WithTimeout(time.Duration(timeout) * time.Second),
		gudriver.WithUserAgent("UberSDR/" + Version),
	}
	if cfg.GalacticUnicornInsecureSkipVerify {
		opts = append(opts, gudriver.WithInsecureSkipVerify())
	}

	return &GalacticUnicornChannel{
		name:   name,
		cfg:    cfg,
		client: gudriver.NewClient(cfg.GalacticUnicornURL, opts...),
	}
}

func (g *GalacticUnicornChannel) Name() string { return g.name }
func (g *GalacticUnicornChannel) Type() string { return "galactic_unicorn" }

// Send delivers message as a display command to the Galactic Unicorn.
// The message string (rendered by the notification template) becomes the
// text of the first line.  All display parameters come from the channel config.
func (g *GalacticUnicornChannel) Send(message string) (ChannelResponse, error) {
	return g.sendWithRetry(message, 2)
}

func (g *GalacticUnicornChannel) sendWithRetry(message string, attemptsLeft int) (ChannelResponse, error) {
	resp, err := g.doSend(message)
	if err != nil && gudriver.IsTransientError(err) && attemptsLeft > 1 {
		log.Printf("[GalacticUnicorn:%s] send error (retrying): %v", g.name, err)
		time.Sleep(2 * time.Second)
		return g.sendWithRetry(message, attemptsLeft-1)
	}
	return resp, err
}

func (g *GalacticUnicornChannel) doSend(message string) (ChannelResponse, error) {
	cfg := g.cfg

	// Resolve model — informational only; firmware auto-detects display dimensions.
	model := cfg.GalacticUnicornModel
	if model == "" {
		model = "galactic"
	}
	log.Printf("[GalacticUnicorn:%s] sending to %s model (url: %s)", g.name, model, cfg.GalacticUnicornURL)

	if cfg.GalacticUnicornURL == "" {
		return ChannelResponse{}, fmt.Errorf("galactic_unicorn: galactic_unicorn_url is not configured")
	}

	// ── Resolve display parameters with defaults ──────────────────────────────

	color := cfg.GalacticUnicornColor
	if color == "" {
		color = "white"
	}

	size := cfg.GalacticUnicornSize
	if size < 1 || size > 3 {
		size = 1
	}

	effect := cfg.GalacticUnicornEffect
	if effect == "" {
		effect = gudriver.EffectAuto
	}

	align := cfg.GalacticUnicornAlign
	if align == "" {
		align = gudriver.AlignLeft
	}

	scrollSpeed := cfg.GalacticUnicornScrollSpeed
	if scrollSpeed <= 0 {
		scrollSpeed = 40
	}

	scrollPause := cfg.GalacticUnicornScrollPause
	if scrollPause <= 0 {
		scrollPause = 1.0
	}

	priority := cfg.GalacticUnicornPriority
	if priority < 0 || priority > 10 {
		priority = 5
	}

	duration := gudriver.DurationSeconds(cfg.GalacticUnicornDuration)

	transition := cfg.GalacticUnicornTransition
	if transition == "" {
		transition = gudriver.TransitionCut
	}

	var brightnessPtr *float64
	if cfg.GalacticUnicornBrightness > 0.0 {
		b := cfg.GalacticUnicornBrightness
		brightnessPtr = &b
	}

	// ── Build and send the display command ────────────────────────────────────

	cmd := gudriver.DisplayCommand{
		Priority:   priority,
		Duration:   duration,
		Transition: transition,
		Brightness: brightnessPtr,
		BgColor:    cfg.GalacticUnicornBgColor,
		Lines: []gudriver.DisplayLine{
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

	guResp, err := g.client.Display(cmd)
	chResp := ChannelResponse{
		StatusCode: guResp.StatusCode,
		Body:       guResp.Body,
	}
	return chResp, err
}
