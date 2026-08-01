package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SpectrumConfig mirrors the "config" message the server sends after every
// zoom/pan and on connect (see sendStatus() in user_spectrum_websocket.go).
type SpectrumConfig struct {
	CenterFreq          float64 `json:"centerFreq"`
	BinCount            int     `json:"binCount"`
	BinBandwidth        float64 `json:"binBandwidth"`
	TotalBandwidth      float64 `json:"totalBandwidth"`
	DefaultBinCount     int     `json:"defaultBinCount"`
	DefaultBinBandwidth float64 `json:"defaultBinBandwidth"`
}

// Frame is one decoded spectrum update, with bins already unwrapped from FFT
// order into ascending frequency order.
//
// Center and Span describe the frequency range this particular frame covers.
// They are resolved here, on the receive path, because that is the only place
// where a frame's ordering relative to the config messages is still known: the
// UI consumes frames and configs from separate channels, so pairing a frame
// with "the latest config" there mis-stamps every frame that is in flight
// while the view is being panned or zoomed.
type Frame struct {
	Bins      []float32
	Timestamp int64
	Center    float64
	Span      float64
}

// Client speaks the /ws/user-spectrum protocol. It handles both the binary
// "SPEC" framing (full + delta, float32 + uint8) and gzip-compressed JSON.
type Client struct {
	host      string // host:port
	tls       bool
	password  string
	sessionID string

	mu        sync.RWMutex
	conn      *websocket.Conn
	connected bool
	cfg       SpectrumConfig

	// How long this session may run and when it was allowed, from the
	// /connection precheck. A zero limit means the receiver sets none.
	sessionLimit time.Duration
	sessionStart time.Time

	// Delta-decode state. The server sends one full frame then deltas against
	// it, so this must be reset on every reconnect or deltas land on stale bins.
	prevF32 []float32
	prevU8  []uint8

	// Commands are rate limited to 10/s to match the server's expectations.
	cmdMu       sync.Mutex
	lastCommand time.Time

	Frames  chan Frame
	Configs chan SpectrumConfig
	Status  chan string
	// Markers carries the band plan and bookmarks, refreshed periodically off
	// the HTTP API rather than the spectrum socket.
	Markers chan Markers
	// Info carries the receiver's description once, so what it says about
	// itself is applied on the UI's own goroutine rather than from the
	// background fetch.
	Info chan Description
}

// userAgent identifies this client to every receiver it talks to, on every
// request it makes — HTTP and WebSocket alike.
//
// It is not decoration. The server records the User-Agent a session presented
// to /connection and refuses to open a socket for a UUID it has never seen one
// from, so this string is part of the handshake as much as the UUID is.
const userAgent = "UberSDR_TUI/1.0"

const minCommandDelay = 100 * time.Millisecond

func NewClient(host string, useTLS bool, password string) (*Client, error) {
	id, err := uuidV4()
	if err != nil {
		return nil, err
	}
	return &Client{
		host:      host,
		tls:       useTLS,
		password:  password,
		sessionID: id,
		// Buffered so a slow render pass never blocks the reader goroutine;
		// the UI only ever draws the most recent frame anyway.
		Frames:  make(chan Frame, 4),
		Configs: make(chan SpectrumConfig, 4),
		Status:  make(chan string, 8),
		Markers: make(chan Markers, 1),
		Info:    make(chan Description, 1),
	}, nil
}

func (c *Client) scheme(secure string, plain string) string {
	if c.tls {
		return secure
	}
	return plain
}

func (c *Client) httpClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			// Public instances behind self-signed certs are common in this
			// project's deployments; the spectrum feed carries no secrets.
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			DialContext:     dialFunc(),
		},
	}
}

// CheckConnection performs the /connection precheck the server requires before
// a session may open a spectrum socket. It returns the rejection reason when
// the server declines.
func (c *Client) CheckConnection() error {
	body, _ := json.Marshal(map[string]string{
		"user_session_id": c.sessionID,
		"password":        c.password,
	})

	endpoint := fmt.Sprintf("%s://%s/connection", c.scheme("https", "http"), c.host)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach %s: %w", c.host, err)
	}
	defer resp.Body.Close()

	var result struct {
		Allowed bool   `json:"allowed"`
		Reason  string `json:"reason"`
		// How long this receiver lets a session last, in seconds. Zero means it
		// does not limit them — which is also what a bypassed connection gets.
		MaxSessionTime int `json:"max_session_time"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("bad /connection response (HTTP %d): %w", resp.StatusCode, err)
	}
	if !result.Allowed {
		reason := result.Reason
		if reason == "" {
			reason = "connection refused by server"
		}
		return fmt.Errorf("%s", reason)
	}

	// The clock starts here: this is the moment the receiver allowed the
	// session, and what it counts from.
	c.mu.Lock()
	c.sessionLimit = time.Duration(result.MaxSessionTime) * time.Second
	c.sessionStart = time.Now()
	c.mu.Unlock()
	return nil
}

// SessionDeadline reports when this session runs out, and whether the receiver
// limits it at all. It is only meaningful once CheckConnection has run.
func (c *Client) SessionDeadline() (time.Time, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.sessionLimit <= 0 || c.sessionStart.IsZero() {
		return time.Time{}, false
	}
	return c.sessionStart.Add(c.sessionLimit), true
}

// SessionLimit is how long the receiver allows a session to run, zero when it
// sets no limit.
func (c *Client) SessionLimit() time.Duration {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessionLimit
}

// DSPInfo describes the server-side DSP inserts a receiver offers, from the
// "dsp" block of /api/description. This is the fast path: it is available
// before any WebSocket is open, which is how the other clients know whether to
// offer the control at all.
type DSPInfo struct {
	Enabled  bool     `json:"enabled"`
	Filters  []string `json:"filters"`
	MaxUsers int      `json:"max_users"`
}

// getJSON reads a JSON endpoint from the receiver into out. Every read-only
// part of the HTTP API this client uses is a plain GET returning JSON, so they
// all share this.
func (c *Client) getJSON(path string, out interface{}) error {
	endpoint := fmt.Sprintf("%s://%s%s", c.scheme("https", "http"), c.host, path)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// Description is what a receiver says about itself, from /api/description.
// Only the parts this client acts on are decoded: which optional features are
// worth offering the user.
type Description struct {
	DSP DSPInfo `json:"dsp"`
	// ChatEnabled is the only way to know whether a receiver runs a chat —
	// plenty do not, and its socket must not be opened for those.
	ChatEnabled bool `json:"chat_enabled"`
	ChatUsers   int  `json:"chat_users"`

	// Where the operator wants a new listener to start. Both are advisory and
	// both are already sanitised server-side, but see Defaults.
	DefaultFrequency float64 `json:"default_frequency"`
	DefaultMode      string  `json:"default_mode"`
}

// defaultStartFrequency is the fallback when a receiver names none: 14.175 MHz,
// the 20 m calling frequency, which is what the server and the Python client
// both fall back to.
const defaultStartFrequency = 14_175_000

// Defaults returns where this receiver wants a listener to start, sanitised.
//
// The server applies these same rules before sending, so this is belt and
// braces against an older or third-party receiver reporting something outside
// the band or a mode this client cannot demodulate — the Python client
// re-checks them for the same reason.
func (d Description) Defaults() (freq float64, mode string) {
	freq = d.DefaultFrequency
	if freq < minFreq || freq > maxFreq {
		freq = defaultStartFrequency
	}
	mode = strings.ToLower(strings.TrimSpace(d.DefaultMode))
	if _, ok := lookupMode(mode); !ok {
		mode = "usb"
	}
	return freq, mode
}

// FetchDescription asks a receiver what it offers. Failure is not fatal to
// anything: each feature simply reports itself as absent.
func (c *Client) FetchDescription() (Description, error) {
	var desc Description
	if err := c.getJSON("/api/description", &desc); err != nil {
		return Description{}, err
	}
	return desc, nil
}

// Run connects and pumps frames until ctx is cancelled, reconnecting on drop.
func (c *Client) Run(ctx context.Context, initialFreq float64, initialBinBW float64) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := c.session(ctx, initialFreq, initialBinBW)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			c.report(fmt.Sprintf("disconnected: %v — retrying in %s", err, backoff))
		} else {
			c.report(fmt.Sprintf("disconnected — retrying in %s", backoff))
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}

		// Resume where the user left off rather than snapping back to the
		// frequency they started the program at.
		cfg := c.Config()
		if cfg.CenterFreq > 0 {
			initialFreq, initialBinBW = cfg.CenterFreq, cfg.BinBandwidth
		}
	}
}

func (c *Client) session(ctx context.Context, initialFreq, initialBinBW float64) error {
	q := url.Values{}
	q.Set("user_session_id", c.sessionID)
	q.Set("mode", "binary8")
	if c.password != "" {
		q.Set("password", c.password)
	}
	// Passing the view up front avoids a post-connect zoom round-trip, so the
	// first frame already arrives at the right frequency and span.
	if initialFreq > 0 {
		q.Set("frequency", fmt.Sprintf("%d", int64(initialFreq)))
	}
	if initialBinBW > 0 {
		q.Set("bin_bandwidth", fmt.Sprintf("%g", initialBinBW))
	}

	wsURL := fmt.Sprintf("%s://%s/ws/user-spectrum?%s", c.scheme("wss", "ws"), c.host, q.Encode())

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	dialer.NetDialContext = dialFunc()

	conn, resp, err := dialer.DialContext(ctx, wsURL, http.Header{
		"User-Agent": []string{userAgent},
	})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%w (HTTP %d)", err, resp.StatusCode)
		}
		return err
	}

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	// Stale delta state from the previous session would corrupt the new one.
	c.prevF32, c.prevU8 = nil, nil
	c.mu.Unlock()

	c.report("connected to " + c.host)

	defer func() {
		c.mu.Lock()
		c.connected = false
		c.conn = nil
		c.mu.Unlock()
		conn.Close()
	}()

	// Unblock the blocking ReadMessage below when the context is cancelled.
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	for {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if err := c.handleMessage(msgType, data); err != nil {
			c.report(err.Error())
		}
	}
}

func (c *Client) handleMessage(msgType int, data []byte) error {
	if msgType == websocket.BinaryMessage {
		if len(data) >= 4 && string(data[:4]) == "SPEC" {
			return c.handleBinarySpectrum(data)
		}
		// Non-SPEC binary is gzip-compressed JSON (writeJSONCompressed).
		zr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("gzip: %w", err)
		}
		defer zr.Close()
		plain, err := io.ReadAll(zr)
		if err != nil {
			return fmt.Errorf("gzip read: %w", err)
		}
		return c.handleJSON(plain)
	}
	return c.handleJSON(data)
}

func (c *Client) handleJSON(data []byte) error {
	var probe struct {
		Type  string `json:"type"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return fmt.Errorf("bad JSON message: %w", err)
	}

	switch probe.Type {
	case "config":
		var cfg SpectrumConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			return fmt.Errorf("bad config: %w", err)
		}
		// The server computes this, but older builds may omit it.
		if cfg.TotalBandwidth == 0 {
			cfg.TotalBandwidth = float64(cfg.BinCount) * cfg.BinBandwidth
		}
		c.mu.Lock()
		c.cfg = cfg
		c.mu.Unlock()
		select {
		case c.Configs <- cfg:
		default:
		}

	case "spectrum":
		var msg struct {
			Data      []float32 `json:"data"`
			Timestamp int64     `json:"timestamp"`
			Frequency float64   `json:"frequency"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			return fmt.Errorf("bad spectrum: %w", err)
		}
		c.mu.Lock()
		center := msg.Frequency
		if center == 0 {
			center = c.cfg.CenterFreq // older servers omit it
		}
		span := c.spanForLocked(len(msg.Data))
		c.mu.Unlock()
		c.emit(unwrapFFT(msg.Data), msg.Timestamp, center, span)

	case "error":
		if probe.Error != "" {
			return fmt.Errorf("server: %s", probe.Error)
		}
	}
	return nil
}

// handleBinarySpectrum decodes the "SPEC" framing.
//
// Header (22 bytes): magic "SPEC" | version u8 | flags u8 | timestamp u64 LE |
// frequency u64 LE. Flags select the payload: 0x01 full float32, 0x02 delta
// float32, 0x03 full uint8, 0x04 delta uint8. Delta payloads are a u16 change
// count followed by (index u16, value) pairs. uint8 bins encode dBFS as
// value-256, giving a -256..-1 dB range.
func (c *Client) handleBinarySpectrum(msg []byte) error {
	if len(msg) < 22 {
		return fmt.Errorf("binary frame too short: %d bytes", len(msg))
	}
	if version := msg[4]; version != 0x01 {
		return fmt.Errorf("unsupported binary version %d", version)
	}

	flags := msg[5]
	timestamp := int64(binary.LittleEndian.Uint64(msg[6:14]))
	// The server stamps every frame with the centre frequency it was captured
	// at (session.Frequency), which is authoritative for this frame even when a
	// pan is in flight and the config message has not caught up.
	frameCenter := float64(binary.LittleEndian.Uint64(msg[14:22]))
	payload := msg[22:]

	c.mu.Lock()
	defer c.mu.Unlock()

	var bins []float32

	switch flags {
	case 0x01: // full, float32
		n := len(payload) / 4
		bins = make([]float32, n)
		for i := 0; i < n; i++ {
			bins[i] = math.Float32frombits(binary.LittleEndian.Uint32(payload[i*4:]))
		}
		c.prevF32 = append(c.prevF32[:0], bins...)

	case 0x02: // delta, float32
		if c.prevF32 == nil {
			return fmt.Errorf("delta frame before full frame")
		}
		if len(payload) < 2 {
			return fmt.Errorf("truncated delta frame")
		}
		count := int(binary.LittleEndian.Uint16(payload[0:2]))
		off := 2
		for i := 0; i < count; i++ {
			if off+6 > len(payload) {
				return fmt.Errorf("truncated delta frame")
			}
			idx := int(binary.LittleEndian.Uint16(payload[off:]))
			val := math.Float32frombits(binary.LittleEndian.Uint32(payload[off+2:]))
			if idx < len(c.prevF32) {
				c.prevF32[idx] = val
			}
			off += 6
		}
		bins = append([]float32(nil), c.prevF32...)

	case 0x03: // full, uint8
		c.prevU8 = append(c.prevU8[:0], payload...)
		bins = u8ToDB(c.prevU8)

	case 0x04: // delta, uint8
		if c.prevU8 == nil {
			return fmt.Errorf("delta frame before full frame")
		}
		if len(payload) < 2 {
			return fmt.Errorf("truncated delta frame")
		}
		count := int(binary.LittleEndian.Uint16(payload[0:2]))
		off := 2
		for i := 0; i < count; i++ {
			if off+3 > len(payload) {
				return fmt.Errorf("truncated delta frame")
			}
			idx := int(binary.LittleEndian.Uint16(payload[off:]))
			if idx < len(c.prevU8) {
				c.prevU8[idx] = payload[off+2]
			}
			off += 3
		}
		bins = u8ToDB(c.prevU8)

	default:
		return fmt.Errorf("unknown binary flags 0x%02x", flags)
	}

	c.emitLocked(unwrapFFT(bins), timestamp, frameCenter, c.spanForLocked(len(bins)))
	return nil
}

// spanForLocked derives this frame's width from the bin bandwidth in force when
// it was parsed. Messages are handled in arrival order, so c.cfg here is the
// config that actually applies to the frame — unlike the UI's view of it.
// Callers must hold c.mu.
func (c *Client) spanForLocked(binCount int) float64 {
	if c.cfg.BinBandwidth > 0 && binCount > 0 {
		return c.cfg.BinBandwidth * float64(binCount)
	}
	return c.cfg.TotalBandwidth
}

func u8ToDB(src []uint8) []float32 {
	out := make([]float32, len(src))
	for i, v := range src {
		out[i] = float32(v) - 256.0
	}
	return out
}

// unwrapFFT rotates raw FFT bin order (positive frequencies first, then
// negative) into ascending frequency order for display.
func unwrapFFT(bins []float32) []float32 {
	n := len(bins)
	if n == 0 {
		return bins
	}
	half := n / 2
	out := make([]float32, 0, n)
	out = append(out, bins[half:]...)
	out = append(out, bins[:half]...)
	return out
}

func (c *Client) emit(bins []float32, ts int64, center, span float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.emitLocked(bins, ts, center, span)
}

// emitLocked drops the frame rather than blocking when the UI is behind —
// spectrum data is only useful live, so the newest frame always wins.
func (c *Client) emitLocked(bins []float32, ts int64, center, span float64) {
	select {
	case c.Frames <- Frame{Bins: bins, Timestamp: ts, Center: center, Span: span}:
	default:
	}
}

func (c *Client) report(msg string) {
	select {
	case c.Status <- msg:
	default:
	}
}

func (c *Client) Config() SpectrumConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cfg
}

func (c *Client) Connected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// send writes a command, silently dropping it if the last one was too recent.
// Dropping is correct here: commands are absolute (not incremental), so the
// next one the user generates supersedes anything discarded.
func (c *Client) send(cmd map[string]interface{}) {
	c.cmdMu.Lock()
	if !c.lastCommand.IsZero() && time.Since(c.lastCommand) < minCommandDelay {
		c.cmdMu.Unlock()
		return
	}
	c.lastCommand = time.Now()
	c.cmdMu.Unlock()

	c.mu.RLock()
	conn := c.conn
	ok := c.connected
	c.mu.RUnlock()
	if !ok || conn == nil {
		return
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(cmd); err != nil {
		c.report(fmt.Sprintf("send failed: %v", err))
	}
}

// Pan recenters the view. The server clamps to 10 kHz–30 MHz.
func (c *Client) Pan(freq float64) {
	c.send(map[string]interface{}{
		"type":      "pan",
		"frequency": int64(freq + 0.5),
	})
}

// Zoom sets the span by deriving bin bandwidth from the server's bin count.
// The server snaps binBandwidth to its own safe ladder and echoes the result
// back as a config message, so the client never has to guess.
func (c *Client) Zoom(freq float64, span float64) {
	cfg := c.Config()
	if cfg.BinCount <= 0 {
		return
	}
	c.send(map[string]interface{}{
		"type":         "zoom",
		"frequency":    int64(freq + 0.5),
		"binBandwidth": span / float64(cfg.BinCount),
	})
}

// Reset returns the view to the server's default span. This also releases any
// private radiod channel the session acquired by zooming, so it is cheaper for
// the server than zooming back out manually.
func (c *Client) Reset() {
	c.send(map[string]interface{}{"type": "reset"})
}

func uuidV4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
