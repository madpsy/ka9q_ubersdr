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
	return g.sendWithRetry(message, GalacticUnicornOverride{}, 2)
}

// SendWithOverride delivers message as a display command to the Galactic
// Unicorn, applying override on top of the channel's own configuration: any
// non-empty/non-zero field in override replaces the corresponding channel
// config value for this send only. This lets a notification rule display
// differently (e.g. a distinct colour or effect) on the same physical device
// without duplicating channels. Implements the notification manager's
// optional overrideSender interface (see notification_manager.go).
func (g *GalacticUnicornChannel) SendWithOverride(message string, override GalacticUnicornOverride) (ChannelResponse, error) {
	return g.sendWithRetry(message, override, 2)
}

func (g *GalacticUnicornChannel) sendWithRetry(message string, override GalacticUnicornOverride, attemptsLeft int) (ChannelResponse, error) {
	resp, err := g.doSend(message, override)
	if err != nil && gudriver.IsTransientError(err) && attemptsLeft > 1 {
		log.Printf("[GalacticUnicorn:%s] send error (retrying): %v", g.name, err)
		time.Sleep(2 * time.Second)
		return g.sendWithRetry(message, override, attemptsLeft-1)
	}
	return resp, err
}

func (g *GalacticUnicornChannel) doSend(message string, override GalacticUnicornOverride) (ChannelResponse, error) {
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

	// ── Sound: send before display when the channel master switch is on ───────
	//
	// Resolution order: rule override → channel config → no sound.
	// The channel's GalacticUnicornSoundsEnabled flag is the master gate —
	// even if a rule specifies a sound, it is silently skipped when the
	// channel has sounds disabled.
	if cfg.GalacticUnicornSoundsEnabled {
		soundPattern := override.Sound
		if soundPattern == "" {
			soundPattern = cfg.GalacticUnicornSound
		}
		if soundPattern != "" {
			soundVolume := override.SoundVolume
			if soundVolume == 0 {
				soundVolume = cfg.GalacticUnicornSoundVolume
			}
			soundCmd := gudriver.SoundCommand{
				Pattern: soundPattern,
				Volume:  soundVolume,
			}
			if _, err := g.client.Sound(soundCmd); err != nil {
				// Sound failure is non-fatal — log and continue to display.
				log.Printf("[GalacticUnicorn:%s] sound error (non-fatal): %v", g.name, err)
			}
		}
	}

	// ── Resolve display parameters: rule override → channel config → built-in default ──

	color := override.Color
	if color == "" {
		color = cfg.GalacticUnicornColor
	}
	if color == "" {
		color = "white"
	}

	size := override.Size
	if size == 0 {
		size = cfg.GalacticUnicornSize
	}
	if size < 1 || size > 3 {
		size = 1
	}

	effect := override.Effect
	if effect == "" {
		effect = cfg.GalacticUnicornEffect
	}
	if effect == "" {
		effect = gudriver.EffectAuto
	}

	align := override.Align
	if align == "" {
		align = cfg.GalacticUnicornAlign
	}
	if align == "" {
		align = gudriver.AlignLeft
	}

	scrollSpeed := override.ScrollSpeed
	if scrollSpeed == 0 {
		scrollSpeed = cfg.GalacticUnicornScrollSpeed
	}
	if scrollSpeed <= 0 {
		scrollSpeed = 40
	}

	scrollPause := override.ScrollPause
	if scrollPause == 0 {
		scrollPause = cfg.GalacticUnicornScrollPause
	}
	if scrollPause <= 0 {
		scrollPause = 1.0
	}

	priority := override.Priority
	if priority == 0 {
		priority = cfg.GalacticUnicornPriority
	}
	if priority < 0 || priority > 10 {
		priority = 5
	}

	durationSeconds := override.Duration
	if durationSeconds == 0 {
		durationSeconds = cfg.GalacticUnicornDuration
	}
	duration := gudriver.DurationSeconds(durationSeconds)

	transition := override.Transition
	if transition == "" {
		transition = cfg.GalacticUnicornTransition
	}
	if transition == "" {
		transition = gudriver.TransitionCut
	}

	bgColor := override.BgColor
	if bgColor == "" {
		bgColor = cfg.GalacticUnicornBgColor
	}

	brightness := override.Brightness
	if brightness == 0 {
		brightness = cfg.GalacticUnicornBrightness
	}
	var brightnessPtr *float64
	if brightness > 0.0 {
		b := brightness
		brightnessPtr = &b
	}

	// ── Build and send the display command ────────────────────────────────────

	cmd := gudriver.DisplayCommand{
		Priority:   priority,
		Duration:   duration,
		Transition: transition,
		Brightness: brightnessPtr,
		BgColor:    bgColor,
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
