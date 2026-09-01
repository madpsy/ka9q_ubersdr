package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// AudioFormat selects the wire format requested from the server.
type AudioFormat int

const (
	// FormatPCMZstd is the lossless path. The name is the one the server still
	// uses in the query string; from protocol version 4 the wire form is a
	// predictive codec rather than zstd, which is where its bandwidth went.
	FormatPCMZstd AudioFormat = iota
	FormatOpus                // lossy Opus (requires server Opus support)
)

// ConnectionState represents the current connection state.
type ConnectionState int

const (
	StateDisconnected ConnectionState = iota
	StateConnecting
	StateConnected
	StateError
)

func (s ConnectionState) String() string {
	switch s {
	case StateConnecting:
		return "Connecting…"
	case StateConnected:
		return "Connected"
	case StateError:
		return "Error"
	default:
		return "Disconnected"
	}
}

// TuneRequest is sent over the WebSocket to change frequency/mode/bandwidth
// without reconnecting.
type TuneRequest struct {
	Type          string `json:"type"`
	Frequency     int    `json:"frequency"`
	Mode          string `json:"mode,omitempty"`
	BandwidthLow  *int   `json:"bandwidthLow,omitempty"`
	BandwidthHigh *int   `json:"bandwidthHigh,omitempty"`
}

// TuningRange is how much spectrum the connected receiver covers, from
// /api/description's `tuning_range` object.
//
// The receiver is not always the 0-30 MHz box this client assumed for its first
// year: the span follows the front end sample rate, so a 129.6 Msps RX888
// reaches 60 MHz and has 6 m in it. The server publishes these numbers from one
// place (ReceiverConfig.TuningRange in receiver_span.go) and the web UI reads
// the same object — see static/v2/src/radio/constants.js, whose fallback rules
// these deliberately match.
//
// Every field is optional, including the whole object: an older receiver does
// not publish it at all. See Limits for what that means.
//
// SpectrumSpanHz is decoded but unused here — this client shows no spectrum. It
// is kept so the shape matches what the receiver sends and the other clients
// read, rather than reappearing as a surprise the day a waterfall is added.
type TuningRange struct {
	MinFrequency   int `json:"min_frequency"`
	MaxFrequency   int `json:"max_frequency"`
	SpectrumSpanHz int `json:"spectrum_span_hz"`
}

// Limits resolves the tuning range, filling in anything the receiver did not
// say.
//
// The fallback is a contract rather than padding: a receiver that publishes
// nothing — an older server, or one whose description could not be fetched —
// must behave exactly as this client did before the span became configurable,
// which is 10 kHz to 30 MHz. Each edge falls back on its own, because they are
// independent facts and a server that states one must not reset the other.
//
// A max at or below the min is not a receiver, it is a misconfiguration, and
// adopting it would make clampFreq return a frequency outside its own range. It
// is refused outright.
func (t TuningRange) Limits() (min, max int) {
	min, max = t.MinFrequency, t.MaxFrequency
	if min <= 0 {
		min = defaultFreqMinHz
	}
	if max <= 0 {
		max = defaultFreqMaxHz
	}
	if max <= min {
		return defaultFreqMinHz, defaultFreqMaxHz
	}
	return min, max
}

// InstanceDescription holds the fields we care about from GET /api/description.
type InstanceDescription struct {
	DefaultFrequency int    `json:"default_frequency"`
	DefaultMode      string `json:"default_mode"`
	MaxSessionTime   int    `json:"max_session_time"` // seconds; 0 = unlimited
	MaxClients       int    `json:"max_clients"`      // 0 = not reported
	Receiver         struct {
		Name     string `json:"name"`
		Callsign string `json:"callsign"`
		Location string `json:"location"`
	} `json:"receiver"`
	// DSP noise reduction insert info.
	// Enabled is true when the server has DSP configured and available.
	// Filters lists the filter names the server allows clients to use.
	DSP struct {
		Enabled bool     `json:"enabled"`
		Filters []string `json:"filters"`
	} `json:"dsp"`
	// How far this receiver tunes. Read through TuningRange.Limits, never off
	// the fields.
	TuningRange TuningRange `json:"tuning_range"`
}

// DSPFilterInfo describes a single filter parameter returned by get_dsp_filters.
type DSPFilterInfo struct {
	Name        string `json:"name"`
	Type        string `json:"type"`    // "float", "int", "bool"
	Default     string `json:"default"` // string representation of default value
	Min         string `json:"min,omitempty"`
	Max         string `json:"max,omitempty"`
	Description string `json:"description,omitempty"`
	RuntimeSafe bool   `json:"runtime_safe"`
}

// DSPFilter describes a single noise reduction filter returned by get_dsp_filters.
type DSPFilter struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Params      []DSPFilterInfo `json:"params"`
}

// DSPFiltersResponse is the server's response to a get_dsp_filters message.
type DSPFiltersResponse struct {
	Available bool        `json:"available"`
	Reason    string      `json:"reason,omitempty"` // set when available=false
	Filters   []DSPFilter `json:"filters"`
}

// AGCSetRequest is sent over the WebSocket to update AGC parameters.
type AGCSetRequest struct {
	Type         string   `json:"type"` // "set_agc"
	AgcHangTime  *float32 `json:"agcHangTime,omitempty"`
	AgcRecovery  *float32 `json:"agcRecoveryRate,omitempty"`
	AgcThreshold *float32 `json:"agcThreshold,omitempty"`
}

// DSPSetRequest is sent over the WebSocket to enable/disable the DSP insert.
type DSPSetRequest struct {
	Type    string                 `json:"type"` // "set_dsp"
	Enabled bool                   `json:"enabled"`
	Filter  string                 `json:"filter,omitempty"` // filter name when enabling
	Params  map[string]interface{} `json:"params,omitempty"` // initial params when enabling
}

// DSPParamsRequest is sent over the WebSocket to update DSP parameters mid-stream.
type DSPParamsRequest struct {
	Type   string                 `json:"type"` // "set_dsp_params"
	Params map[string]interface{} `json:"params"`
}

// FetchDescription calls GET /api/description on the current BaseURL and returns
// the parsed response.  Errors are non-fatal — callers should fall back gracefully.
func (c *RadioClient) FetchDescription() (*InstanceDescription, error) {
	httpScheme, host, err := c.parseBaseURL()
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf("%s://%s/api/description", httpScheme, host)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "UberSDR-Audio/1.0")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var desc InstanceDescription
	if err := json.NewDecoder(resp.Body).Decode(&desc); err != nil {
		return nil, err
	}
	return &desc, nil
}

// FetchStats calls GET /stats on the current BaseURL and returns the number of
// active sessions.  Returns -1 on any error so callers can distinguish "no data"
// from zero.
func (c *RadioClient) FetchStats() (int, error) {
	httpScheme, host, err := c.parseBaseURL()
	if err != nil {
		return -1, err
	}
	endpoint := fmt.Sprintf("%s://%s/stats", httpScheme, host)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return -1, err
	}
	req.Header.Set("User-Agent", "UberSDR-Audio/1.0")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return -1, err
	}
	defer resp.Body.Close()
	var body struct {
		ActiveSessions int `json:"active_sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return -1, err
	}
	return body.ActiveSessions, nil
}

// ConnectionCheckRequest is the body for POST /connection.
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"`
}

// ConnectionCheckResponse is the response from POST /connection.
type ConnectionCheckResponse struct {
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	ClientIP       string   `json:"client_ip,omitempty"`
	Bypassed       bool     `json:"bypassed"`
	AllowedIQModes []string `json:"allowed_iq_modes,omitempty"`
	MaxSessionTime int      `json:"max_session_time"`
}

// RadioClient manages a single WebSocket connection to an UberSDR instance.
//
// Set BaseURL to the HTTP base URL of the instance, e.g.:
//
//	http://ubersdr.local:8080
//	https://myreceiver.example.com
//
// The client derives the WebSocket URL automatically (http→ws, https→wss).
type RadioClient struct {
	// Config (set before Connect, read-only during connection)
	BaseURL       string // e.g. "http://ubersdr.local:8080"
	Password      string
	Frequency     int
	Mode          string
	BandwidthLow  int
	BandwidthHigh int
	Format        AudioFormat
	DeviceID      string // WASAPI device ID; "" = system default

	// Sink, if non-nil, receives raw decoded PCM frames before any volume,
	// mute, or channel-routing is applied.  Safe to set before Connect();
	// must not be changed while connected.
	Sink StreamSink

	// Runtime state
	userSessionID      string
	conn               *websocket.Conn
	state              ConnectionState
	generation         uint64 // incremented on each Connect(); runLoop goroutines ignore stale state transitions
	sampleRate         int
	channels           int
	volume             float64 // current volume (0.0–1.0); applied to new AudioOutput on creation
	channelMode        int     // ChannelModeBoth/Left/Right; applied to new AudioOutput on creation
	audioOut           *AudioOutput
	cancelFn           context.CancelFunc
	connMaxSessionTime int      // MaxSessionTime from last /connection response (0 = unlimited)
	connBypassed       bool     // Bypassed flag from last /connection response
	connAllowedIQModes []string // AllowedIQModes from last /connection response

	// Callbacks (called from the receive goroutine; Fyne Set* methods are goroutine-safe)
	OnStateChange   func(ConnectionState, string)             // state, optional message
	OnAudioInfo     func(sampleRate, channels int)            // called when audio params are known
	OnSignalQuality func(basebandPower, noiseDensity float32) // called each full-header packet; -999 = no data
	OnAudioLevel    func(dBFS float32)                        // called each audio frame with RMS level in dBFS
	OnDSPFilters    func(DSPFiltersResponse)                  // called when server responds to get_dsp_filters
	OnDSPStatus     func(enabled bool, filter string)         // called when server confirms set_dsp

	// bytesReceived accumulates compressed wire bytes since last reset.
	// Read and reset atomically with BytesReceivedAndReset().
	bytesReceived atomic.Int64

	// pcmV4Decoder decodes lossless frames, and opusV4Header reads the header
	// off Opus frames.
	//
	// They are separate instances because the server tracks the two streams
	// separately -- it holds one header encoder for each -- so a shared decoder
	// would apply one stream's deltas to the other's baseline. Both are stateful
	// per connection and created in connectAndStream.
	//
	// pcmV4Decoder additionally carries the predictor's adaptation, which means
	// every version 4 lossless frame MUST be decoded, even one that is then
	// dropped for a full delivery queue: a frame that never reaches it leaves
	// this side's filters where the server's no longer are.
	pcmV4Decoder *PCMv4StreamDecoder
	opusV4Header *PCMv4HeaderDecoder

	// opusDec is the Opus decoder instance (nil until first Opus frame).
	// Protected by mu.
	opusDec *opusDecoder

	// opusDecodeCh is a buffered channel of Opus wire frames whose headers have
	// already been parsed.
	// The WebSocket receive goroutine enqueues frames here non-blocking;
	// a dedicated worker goroutine calls opus_decode (a DLL syscall that
	// pins an OS thread) so the receive goroutine is never stalled by it.
	// This keeps the IOCP completion path as short as possible and prevents
	// the Go network poller from being starved on Windows.
	//
	// The header is read before the hand-off rather than in the worker because
	// version 4 headers are change-tracked: a frame dropped here for a full
	// queue must still have been parsed, or the next delta has no baseline.
	opusDecodeCh chan opusWireFrame

	// pcmDeliverCh is a buffered channel of decoded PCM packets.
	// The WebSocket receive goroutine decodes and enqueues here non-blocking;
	// a dedicated worker goroutine calls deliverAudio so that burst processing
	// (e.g. after a stall) does not cause rapid-fire SetValue calls that Fyne
	// coalesces into a single stale redraw, making the audio level bar appear stuck.
	pcmDeliverCh chan pcmDecodedPacket

	// Gate fade-in state.
	// When the audio gate opens (first real audio frame after silence), a 100ms
	// linear ramp is applied to avoid a hard click.  prevFrameWasSilence tracks
	// whether the previous delivered frame was all-zero (gate-closed silence from
	// the server's ticker).  fadeInSamplesLeft counts down the remaining ramp.
	// Both fields are only accessed from the pcmDeliverCh worker goroutine.
	prevFrameWasSilence bool
	fadeInSamplesLeft   int

	mu sync.RWMutex
}

// pcmDecodedPacket holds a fully decoded PCM frame ready for delivery.
type pcmDecodedPacket struct {
	pcmLE         []byte
	sampleRate    int
	channels      int
	basebandPower float32
	noiseDensity  float32
}

// NewRadioClient creates a new client with sensible defaults.
func NewRadioClient() *RadioClient {
	return &RadioClient{
		BaseURL:       "http://ubersdr.local:8080",
		userSessionID: uuid.New().String(),
		state:         StateDisconnected,
		BandwidthLow:  -2400,
		BandwidthHigh: 2400,
		Format:        FormatOpus, // default to Compressed (Opus)
		volume:        1.0,
	}
}

// State returns the current connection state (thread-safe).
func (c *RadioClient) State() ConnectionState {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

// setState updates the connection state and fires OnStateChange, but only if
// gen matches the current generation.  This prevents stale runLoop goroutines
// (from a previous Connect() call that was superseded) from overwriting the
// UI state of a newer, active connection.
func (c *RadioClient) setState(gen uint64, s ConnectionState, msg string) {
	c.mu.Lock()
	if c.generation != gen {
		c.mu.Unlock()
		return // stale goroutine — ignore
	}
	c.state = s
	c.mu.Unlock()
	if c.OnStateChange != nil {
		c.OnStateChange(s, msg)
	}
}

// SampleRate returns the last-known audio sample rate (thread-safe).
func (c *RadioClient) SampleRate() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sampleRate
}

// Channels returns the last-known channel count (thread-safe).
func (c *RadioClient) Channels() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.channels
}

// ConnMaxSessionTime returns the MaxSessionTime from the last /connection
// response (0 = unlimited). This is the per-user value that already has the
// bypass override applied, unlike /api/description which always returns the
// globally configured value.
func (c *RadioClient) ConnMaxSessionTime() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connMaxSessionTime
}

// ConnBypassed returns the Bypassed flag from the last /connection response.
func (c *RadioClient) ConnBypassed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connBypassed
}

// AllowedIQModes returns the list of wide IQ modes permitted by the server
// from the last /connection response. Plain "iq" is always permitted.
func (c *RadioClient) AllowedIQModes() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connAllowedIQModes
}

// isIQMode reports whether mode is any IQ variant (iq, iq48, iq96, iq192, iq384).
func isIQMode(mode string) bool {
	return mode == "iq" || mode == "iq48" || mode == "iq96" || mode == "iq192" || mode == "iq384"
}

// isWideIQMode reports whether mode is a wide (preset-bandwidth) IQ variant.
// Wide IQ modes do not accept bandwidth parameters from the client.
func isWideIQMode(mode string) bool {
	return mode == "iq48" || mode == "iq96" || mode == "iq192" || mode == "iq384"
}

// SetVolume adjusts playback volume (0.0–1.0). The value is remembered so
// that any AudioOutput created later (on the first audio frame) starts at
// the correct level rather than always defaulting to 1.0.
func (c *RadioClient) SetVolume(v float64) {
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	c.mu.Lock()
	c.volume = v
	out := c.audioOut
	c.mu.Unlock()
	if out != nil {
		out.SetVolume(v)
	}
}

// BytesReceivedAndReset returns the number of compressed wire bytes received
// since the last call (or since Connect), then resets the counter to zero.
// Safe to call from any goroutine.
func (c *RadioClient) BytesReceivedAndReset() int64 {
	return c.bytesReceived.Swap(0)
}

// SetDevice switches the audio output to a new WASAPI device while connected.
// The current AudioOutput is closed immediately; the next audio frame will
// open a new one on the specified device.  deviceID="" = system default.
func (c *RadioClient) SetDevice(deviceID string) {
	c.mu.Lock()
	c.DeviceID = deviceID
	out := c.audioOut
	c.audioOut = nil
	c.sampleRate = 0
	c.channels = 0
	c.mu.Unlock()
	if out != nil {
		out.Close()
	}
}

// SetChannelMode sets which output channels receive audio (ChannelModeBoth/Left/Right).
// The value is stored so new AudioOutput instances created on the next audio frame
// also start with the correct mode, and applied immediately to any active AudioOutput.
func (c *RadioClient) SetChannelMode(mode int) {
	c.mu.Lock()
	c.channelMode = mode
	out := c.audioOut
	c.mu.Unlock()
	if out != nil {
		out.SetChannelMode(mode)
	}
}

// parseBaseURL parses BaseURL and returns scheme, host (host:port).
// Defaults to http if no scheme is present.
func (c *RadioClient) parseBaseURL() (scheme, host string, err error) {
	raw := strings.TrimRight(c.BaseURL, "/")
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", fmt.Errorf("invalid base URL %q: %w", c.BaseURL, err)
	}
	scheme = strings.ToLower(u.Scheme)
	host = u.Host
	if host == "" {
		return "", "", fmt.Errorf("invalid base URL %q: missing host", c.BaseURL)
	}
	return scheme, host, nil
}

// pcmProtocolVersion is the audio protocol this client speaks, and the only one
// it speaks.
//
// Version 4 replaces the zstd wrapper on the lossless path with a predictive
// codec (pcm_predictive.go), and the fixed 37-byte header with one carrying only
// what changed (pcm_v4_header.go). Opus frames keep their payload but lose most
// of their header. Measured against the same receiver: USB 26.6 -> 12.2 kB/s,
// IQ 12k 50.7 -> 34.3, and a squelched session 2.90 -> 0.49.
//
// A server from 0.1.63 on refuses a version it cannot serve, so asking for this
// one either works or fails loudly. Older servers instead clamp the request to
// 1-3 and silently answer with version 1; handleBinary recognises what comes
// back and says so, which is the only accommodation made for them.
const pcmProtocolVersion = 4

// buildWSURL constructs the WebSocket URL from BaseURL.
func (c *RadioClient) buildWSURL() (string, error) {
	httpScheme, host, err := c.parseBaseURL()
	if err != nil {
		return "", err
	}

	wsScheme := "ws"
	if httpScheme == "https" {
		wsScheme = "wss"
	}

	format := "pcm-zstd"
	if c.Format == FormatOpus && !isIQMode(c.Mode) {
		format = "opus"
	}

	u := url.URL{
		Scheme: wsScheme,
		Host:   host,
		Path:   "/ws",
	}
	q := u.Query()
	q.Set("frequency", fmt.Sprintf("%d", c.Frequency))
	q.Set("mode", c.Mode)
	q.Set("format", format)
	q.Set("version", fmt.Sprintf("%d", pcmProtocolVersion))
	q.Set("user_session_id", c.userSessionID)
	if !isWideIQMode(c.Mode) {
		q.Set("bandwidthLow", fmt.Sprintf("%d", c.BandwidthLow))
		q.Set("bandwidthHigh", fmt.Sprintf("%d", c.BandwidthHigh))
	}
	if c.Password != "" {
		q.Set("password", c.Password)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// checkConnectionAllowed calls POST /connection and returns the full server
// response so callers can read per-user fields like MaxSessionTime and Bypassed.
// On network/parse failure a permissive response is returned so the WebSocket
// attempt can surface the real error.
func (c *RadioClient) checkConnectionAllowed() (ConnectionCheckResponse, error) {
	httpScheme, host, err := c.parseBaseURL()
	if err != nil {
		return ConnectionCheckResponse{}, err
	}

	endpoint := fmt.Sprintf("%s://%s/connection", httpScheme, host)

	body, _ := json.Marshal(ConnectionCheckRequest{
		UserSessionID: c.userSessionID,
		Password:      c.Password,
	})

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return ConnectionCheckResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "UberSDR-Audio/1.0")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		// Server unreachable — let the WebSocket attempt surface the real error
		return ConnectionCheckResponse{Allowed: true}, nil
	}
	defer resp.Body.Close()

	var cr ConnectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return ConnectionCheckResponse{Allowed: true}, nil // parse failure: try anyway
	}
	if !cr.Allowed {
		return cr, fmt.Errorf("server rejected connection: %s", cr.Reason)
	}
	return cr, nil
}

// Connect starts the connection in a background goroutine.
// It is safe to call Connect again after Disconnect.
// If the client is already connecting or connected, this is a no-op; use
// ConnectForce to override that guard (e.g. after an explicit Disconnect).
func (c *RadioClient) Connect() {
	ctx, cancel := context.WithCancel(context.Background())

	c.mu.Lock()
	if c.state == StateConnecting || c.state == StateConnected {
		c.mu.Unlock()
		cancel() // discard the unused context
		return
	}
	// Generate a fresh session ID for each new connection.
	c.userSessionID = uuid.New().String()
	// Increment the generation so any stale runLoop goroutine from a previous
	// connection will have its setState calls silently ignored.
	c.generation++
	gen := c.generation
	// Cancel any previous context and store the new one atomically so
	// Disconnect() always cancels the correct (most recent) runLoop.
	if c.cancelFn != nil {
		c.cancelFn()
	}
	c.cancelFn = cancel
	c.mu.Unlock()

	go c.runLoop(ctx, gen)
}

// ReconnectWS closes the current WebSocket and opens a new one with the
// current client parameters, skipping the /connection check.  Use this when
// only the stream parameters (mode, bandwidth, format) have changed and the
// server has already authorised the session — e.g. when switching IQ modes.
//
// The userSessionID is intentionally preserved so the server recognises this
// as the same user replacing their stream rather than a new session joining.
// This prevents a brief "two sessions" window while the old WebSocket closes.
func (c *RadioClient) ReconnectWS() {
	ctx, cancel := context.WithCancel(context.Background())

	c.mu.Lock()
	if c.cancelFn != nil {
		c.cancelFn()
	}
	// Do NOT rotate userSessionID — keep the same one so the server treats
	// this as a stream replacement for the existing session, not a new session.
	c.generation++
	gen := c.generation
	c.cancelFn = cancel
	c.state = StateDisconnected
	c.mu.Unlock()

	go c.runLoopWS(ctx, gen)
}

// ConnectForce starts a new connection unconditionally, cancelling any
// in-progress connection first.  Use this when you have already called
// Disconnect() and polled for the state to settle, but want to guarantee
// that a stale StateConnecting (e.g. due to a slow runLoop goroutine) does
// not silently swallow the Connect call.
func (c *RadioClient) ConnectForce() {
	ctx, cancel := context.WithCancel(context.Background())

	c.mu.Lock()
	// Cancel any previous context so the old runLoop goroutine stops.
	if c.cancelFn != nil {
		c.cancelFn()
	}
	// Generate a fresh session ID for each new connection.
	c.userSessionID = uuid.New().String()
	// Increment the generation so any stale runLoop goroutine from a previous
	// connection will have its setState calls silently ignored.
	c.generation++
	gen := c.generation
	c.cancelFn = cancel
	// Force state to Disconnected so the UI reflects a clean start.
	c.state = StateDisconnected
	c.mu.Unlock()

	go c.runLoop(ctx, gen)
}

// Disconnect closes the active connection.
// It cancels the context AND closes the WebSocket so ReadMessage unblocks immediately.
func (c *RadioClient) Disconnect() {
	c.mu.Lock()
	cancel := c.cancelFn
	conn := c.conn
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	// Closing the connection unblocks any pending ReadMessage call.
	if conn != nil {
		conn.Close()
	}
}

// SendSetDSP sends a set_dsp message to enable or disable the noise reduction insert.
// filter is the filter name (e.g. "nr4"); params are optional initial parameters.
// When enabled=false, filter and params are ignored.
func (c *RadioClient) SendSetDSP(enabled bool, filter string, params map[string]interface{}) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	req := DSPSetRequest{
		Type:    "set_dsp",
		Enabled: enabled,
		Filter:  filter,
		Params:  params,
	}
	return conn.WriteJSON(req)
}

// SendSetDSPParams sends a set_dsp_params message to update filter parameters mid-stream.
func (c *RadioClient) SendSetDSPParams(params map[string]interface{}) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	req := DSPParamsRequest{
		Type:   "set_dsp_params",
		Params: params,
	}
	return conn.WriteJSON(req)
}

// SendSetAGC sends a set_agc message to update AGC hang time, recovery rate, and/or threshold.
// Pass nil for any parameter you do not want to change.
func (c *RadioClient) SendSetAGC(hangTime, recoveryRate, threshold *float32) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	req := AGCSetRequest{
		Type:         "set_agc",
		AgcHangTime:  hangTime,
		AgcRecovery:  recoveryRate,
		AgcThreshold: threshold,
	}
	return conn.WriteJSON(req)
}

// SendSetAudioGate sends a set_audio_gate message to set the SNR squelch threshold.
// Pass nil to leave the current value unchanged.  Pass a pointer to -999 to disable.
func (c *RadioClient) SendSetAudioGate(minSNR *float32) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	msg := map[string]interface{}{"type": "set_audio_gate"}
	if minSNR != nil {
		msg["min_snr"] = *minSNR
	}
	return conn.WriteJSON(msg)
}

// SendGetDSPFilters requests the list of available DSP filters from the server.
// The response is delivered asynchronously via the OnDSPFilters callback.
func (c *RadioClient) SendGetDSPFilters() error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	return conn.WriteJSON(map[string]string{"type": "get_dsp_filters"})
}

// Tune sends a tune message over the existing WebSocket connection to change
// frequency, mode, and/or bandwidth without reconnecting.
func (c *RadioClient) Tune(frequency int, mode string, bwLow, bwHigh int) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}

	lo, hi := bwLow, bwHigh
	msg := TuneRequest{
		Type:          "tune",
		Frequency:     frequency,
		Mode:          mode,
		BandwidthLow:  &lo,
		BandwidthHigh: &hi,
	}
	return conn.WriteJSON(msg)
}

// runLoopWS is like runLoop but skips the /connection check.
// Used by ReconnectWS when only the stream parameters have changed and the
// server has already authorised the session.
func (c *RadioClient) runLoopWS(ctx context.Context, gen uint64) {
	c.setState(gen, StateConnecting, "")
	c.connectAndStream(ctx, gen)
}

// runLoop is the main connection goroutine.
// gen is the generation counter captured at Connect() time; setState calls with
// a mismatched generation are silently dropped so stale goroutines cannot
// overwrite the UI state of a newer active connection.
func (c *RadioClient) runLoop(ctx context.Context, gen uint64) {
	c.setState(gen, StateConnecting, "")

	// Check /connection first
	cr, err := c.checkConnectionAllowed()
	if err != nil {
		c.setState(gen, StateError, err.Error())
		return
	}
	if !cr.Allowed {
		c.setState(gen, StateError, "connection not allowed by server")
		return
	}
	// Store per-user fields from the /connection response so callers can read them.
	c.mu.Lock()
	c.connMaxSessionTime = cr.MaxSessionTime
	c.connBypassed = cr.Bypassed
	c.connAllowedIQModes = cr.AllowedIQModes
	c.mu.Unlock()

	c.connectAndStream(ctx, gen)
}

// connectAndStream dials the WebSocket and runs the receive loop.
// Called by both runLoop (after /connection check) and runLoopWS (skipping it).
func (c *RadioClient) connectAndStream(ctx context.Context, gen uint64) {
	wsURL, err := c.buildWSURL()
	if err != nil {
		c.setState(gen, StateError, err.Error())
		return
	}

	headers := http.Header{}
	headers.Set("User-Agent", "UberSDR-Audio/1.0")

	// Use an explicit dialer with larger read/write buffers.
	// The default gorilla dialer uses 4 KB buffers; at ~7 kB/s Opus that fills
	// in under a second, making any Windows scheduling hiccup immediately stall
	// the TCP window and block ReadMessage.
	dialer := &websocket.Dialer{
		Proxy:            http.ProxyFromEnvironment,
		HandshakeTimeout: 10 * time.Second,
		ReadBufferSize:   256 * 1024,
		WriteBufferSize:  32 * 1024,
	}
	// A server from 0.1.63 on answers 400 for a protocol version it cannot
	// serve, so its refusal arrives here as a failed handshake with the reason
	// in the body rather than as a stream that quietly is not version 4.
	conn, _, err := dialer.DialContext(ctx, wsURL, headers)
	if err != nil {
		c.setState(gen, StateError, fmt.Sprintf("WebSocket dial: %v", err))
		return
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	c.setState(gen, StateConnected, "")

	// Both decoders are stateful across the whole connection and must not
	// outlive it: the predictor's taps carry every sample decoded so far, the
	// headers carry what the server has stopped repeating, and a fresh socket
	// starts a fresh stream at the other end.
	c.mu.Lock()
	c.pcmV4Decoder = NewPCMv4StreamDecoder()
	c.opusV4Header = NewPCMv4HeaderDecoder()
	c.mu.Unlock()

	// Create the Opus decode channel and start the worker goroutine.
	// The worker owns all opus_decode DLL calls so the receive goroutine
	// (and therefore the IOCP poller) is never blocked by them.
	opusDecodeCh := make(chan opusWireFrame, 8)
	c.mu.Lock()
	c.opusDecodeCh = opusDecodeCh
	c.mu.Unlock()

	go func() {
		for frame := range opusDecodeCh {
			c.decodeAndDeliverOpus(frame)
		}
	}()

	// Create the PCM deliver channel and start its worker goroutine.
	// Mirroring the Opus pattern: the receive goroutine decodes PCM frames and
	// enqueues them here non-blocking; the worker calls deliverAudio at a
	// measured pace so Fyne redraws are not coalesced into a single stale value.
	pcmDeliverCh := make(chan pcmDecodedPacket, 16)
	c.mu.Lock()
	c.pcmDeliverCh = pcmDeliverCh
	c.mu.Unlock()

	go func() {
		for pkt := range pcmDeliverCh {
			c.deliverAudio(pkt.pcmLE, pkt.sampleRate, pkt.channels, pkt.basebandPower, pkt.noiseDensity)
		}
	}()

	// Keepalive ticker
	keepalive := time.NewTicker(30 * time.Second)
	defer keepalive.Stop()

	// Keepalive goroutine
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-keepalive.C:
				c.mu.RLock()
				wc := c.conn
				c.mu.RUnlock()
				if wc != nil {
					_ = wc.WriteJSON(map[string]string{"type": "ping"})
				}
			}
		}
	}()

	// Receive loop — ReadMessage blocks until a frame arrives or the connection
	// is closed.  We rely on Disconnect() closing the connection to unblock it.
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			// Distinguish intentional disconnect from unexpected error.
			select {
			case <-ctx.Done():
				c.cleanup()
				c.setState(gen, StateDisconnected, "")
			default:
				c.cleanup()
				c.setState(gen, StateError, fmt.Sprintf("read: %v", err))
			}
			return
		}

		if msgType == websocket.BinaryMessage {
			c.bytesReceived.Add(int64(len(data)))
			if err := c.handleBinary(data); err != nil {
				c.setState(gen, StateError, err.Error())
				return
			}
		} else if msgType == websocket.TextMessage {
			c.handleJSON(data)
		}
	}
}

// handleJSON processes a text (JSON) WebSocket frame from the server.
// Handled types: pong, status, error, dsp_filters, dsp_status.
// Unknown types are logged (when --debug) and silently ignored.
func (c *RadioClient) handleJSON(data []byte) {
	var msg struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	dbg("HANDLE_JSON: type=%q raw=%s", msg.Type, data)
	switch msg.Type {
	case "pong":
		// Keepalive response — nothing to do.
	case "status":
		// Server sends this after tune commands to confirm the applied state.
		// Currently informational only; the client trusts its own sent values.
	case "error":
		// Server-side error message — logged via dbg above; no action needed.
	case "dsp_filters":
		// The server wraps the payload in an "info" field:
		// {"type":"dsp_filters","info":{"available":true,"filters":[...]}}
		var envelope struct {
			Info DSPFiltersResponse `json:"info"`
		}
		if err := json.Unmarshal(data, &envelope); err != nil {
			return
		}
		if cb := c.OnDSPFilters; cb != nil {
			cb(envelope.Info)
		}
	case "dsp_status":
		var s struct {
			Type    string `json:"type"`
			Enabled bool   `json:"enabled"`
			Filter  string `json:"filter,omitempty"`
			Info    struct {
				Enabled bool   `json:"enabled"`
				Filter  string `json:"filter,omitempty"`
			} `json:"info"`
		}
		if err := json.Unmarshal(data, &s); err != nil {
			return
		}
		// Server sends dsp_status with an "info" sub-object.
		enabled := s.Info.Enabled
		filter := s.Info.Filter
		if cb := c.OnDSPStatus; cb != nil {
			cb(enabled, filter)
		}
	default:
		dbg("HANDLE_JSON: unhandled type=%q", msg.Type)
	}
}

// handleBinary processes a binary WebSocket frame, returning an error only for
// a stream this client cannot read at all -- which ends the connection.
//
// Two shapes arrive, and the frame itself has to say which it is rather than the
// negotiated format: the server picks the format PER PACKET, so a session
// negotiated as Opus receives lossless PCM the moment it tunes to IQ, and one
// that asked for Opus from a server built without libopus receives it always.
//
// The lossless magic is four bytes, which is not decoration. An Opus frame
// begins with a timestamp, so its leading bytes are uniformly distributed and
// the width of the magic is a false-positive rate -- each false positive being
// one frame of audio played as metadata, which is an audible click. Two bytes
// would mistake one frame in 65536, about one a minute at IQ packet rates.
func (c *RadioClient) handleBinary(data []byte) error {
	if PCMv4IsHeader(data) {
		c.handlePCMv4Binary(data)
		return nil
	}
	// Version 4 has no zstd anywhere, so a zstd frame is not a stream this
	// client misread -- it is a server older than 0.1.63, which clamps the
	// requested version to 1-3 and answers with version 1 rather than refusing.
	// Saying so beats playing nothing and explaining nothing.
	if isZstdFrame(data) {
		return fmt.Errorf("server does not support audio protocol version %d (needs UberSDR 0.1.63 or later)", pcmProtocolVersion)
	}
	return c.handleOpusBinary(data)
}

// handlePCMv4Binary decodes a version 4 lossless frame and enqueues it for
// delivery by the PCM worker goroutine.
//
// The decode is unconditional even though the delivery below is not. The
// predictor is backward adaptive, so its taps are derived from samples already
// decoded: a frame that never reaches the codec leaves this side's filters
// where the server's no longer are, and every frame after it decodes as noise.
// Dropping the RESULT when the worker is behind costs 20 ms of audio; dropping
// the decode would cost the rest of the connection.
func (c *RadioClient) handlePCMv4Binary(data []byte) {
	c.mu.RLock()
	dec := c.pcmV4Decoder
	ch := c.pcmDeliverCh
	c.mu.RUnlock()

	if dec == nil || ch == nil {
		return
	}

	pcmLE, sampleRate, channels, basebandPower, noise, err := dec.DecodePacketLE(data)
	if err != nil {
		dbg("PCMv4: %v", err)
		return
	}

	select {
	case ch <- pcmDecodedPacket{pcmLE, sampleRate, channels, basebandPower, noise}:
	default:
	}
}

// handleOpusBinary parses an Opus wire frame and enqueues it for decoding by
// the worker goroutine.  This returns immediately so the WebSocket receive
// goroutine (and the underlying IOCP poller) is never blocked by the
// opus_decode DLL call.
//
// The header is read here rather than in the worker because from version 4 it
// is change-tracked: a frame dropped below for a full queue must still have had
// its header parsed, or the next frame's delta has no baseline to apply to.
// parseOpusFrame copies the Opus payload out, since the WebSocket library
// reuses the buffer under data as soon as this returns.
func (c *RadioClient) handleOpusBinary(data []byte) error {
	c.mu.RLock()
	ch := c.opusDecodeCh
	v4 := c.opusV4Header
	c.mu.RUnlock()
	if ch == nil || v4 == nil {
		return nil
	}

	frame, err := parseOpusFrame(data, v4)
	if err != nil {
		// An Opus frame carries no magic, so it is identified by elimination
		// and there is nothing else this could have been. The socket is ordered
		// and reliable, so a header that will not parse is not a corrupted
		// frame; it is a header of a shape this client does not read, which is
		// what a server older than 0.1.63 sends after clamping the requested
		// version to 1-3.
		return fmt.Errorf("unreadable Opus frame: %w (server may predate audio protocol version %d)", err, pcmProtocolVersion)
	}

	// Non-blocking enqueue: if the worker is momentarily behind, drop rather
	// than stalling the receive goroutine.
	select {
	case ch <- frame:
	default:
	}
	return nil
}

// decodeAndDeliverOpus is called by the Opus worker goroutine.
// It performs the actual DLL call and delivers PCM to the audio output.
func (c *RadioClient) decodeAndDeliverOpus(frame opusWireFrame) {
	c.mu.Lock()
	opusDec := c.opusDec
	c.mu.Unlock()

	pcmLE, err := decodeOpusFrame(frame, &opusDec)
	if err != nil {
		return
	}
	sampleRate, channels := frame.sampleRate, frame.channels
	basebandPower, noiseDensity := frame.basebandPower, frame.noise

	// Store back the (possibly newly created) decoder.
	c.mu.Lock()
	c.opusDec = opusDec
	c.mu.Unlock()

	c.deliverAudio(pcmLE, sampleRate, channels, basebandPower, noiseDensity)
}

// rmsDBFS computes the RMS level of little-endian int16 PCM data in dBFS.
// Returns -144 (silence floor) if the slice is empty or all zeros.
func rmsDBFS(pcmLE []byte) float32 {
	n := len(pcmLE) / 2
	if n == 0 {
		return -144
	}
	var sum float64
	for i := 0; i < n; i++ {
		s := int16(binary.LittleEndian.Uint16(pcmLE[i*2:]))
		v := float64(s) / 32768.0
		sum += v * v
	}
	rms := math.Sqrt(sum / float64(n))
	if rms < 1e-10 {
		return -144
	}
	return float32(20 * math.Log10(rms))
}

// applyGateFadeIn applies a partial linear gain ramp to pcmLE (little-endian int16).
// It is called when the audio gate has just opened, to avoid a hard click.
// The ramp spans 100 ms total; fadeInLeft tracks how many samples remain.
// Each call advances the ramp by len(pcmLE)/2 samples and decrements *fadeInLeft.
func applyGateFadeIn(pcmLE []byte, fadeInLeft *int, totalFadeSamples int) {
	n := len(pcmLE) / 2
	for i := 0; i < n; i++ {
		if *fadeInLeft <= 0 {
			break
		}
		// pos is how far into the ramp we are: 0 at the very start, totalFadeSamples at the end.
		// fadeInLeft counts down from totalFadeSamples to 0, so:
		//   pos = totalFadeSamples - fadeInLeft  (before decrement for this sample)
		pos := totalFadeSamples - *fadeInLeft
		if pos < 0 {
			pos = 0
		}
		gain := float32(pos) / float32(totalFadeSamples) // 0.0 → 1.0
		s := int16(binary.LittleEndian.Uint16(pcmLE[i*2:]))
		binary.LittleEndian.PutUint16(pcmLE[i*2:], uint16(int16(float32(s)*gain)))
		*fadeInLeft--
	}
}

// deliverAudio pushes PCM to the audio output, creating or recreating the
// AudioOutput if the stream parameters changed.
//
// Signal quality (OnSignalQuality) and audio level (OnAudioLevel) are no
// longer fired here.  Instead they are fired from the AudioOutput's
// onChunkStart callback at the moment the audio is actually played, so the
// bars stay in sync with what the user hears.
func (c *RadioClient) deliverAudio(pcmLE []byte, sampleRate, channels int, basebandPower, noiseDensity float32) {
	// Tap: deliver raw decoded PCM to the StreamSink (if configured) before
	// any volume, mute, or channel-routing is applied.  The sink receives
	// exactly what came off the wire after Opus/PCM decoding — unmodified.
	if c.Sink != nil {
		c.Sink.WritePCM(pcmLE, sampleRate, channels)
	}

	// Gate fade-in: detect transition from silence (gate closed) to real audio
	// (gate open) and apply a 100ms linear ramp to avoid a hard click.
	// Silence packets from the server's ticker have all-zero PCM → rmsDBFS = -144.
	const fadeInSecs = 0.100
	const silenceFloor = float32(-140) // -144 = all-zero; use -140 as threshold
	frameDBFS := rmsDBFS(pcmLE)
	isSilence := frameDBFS <= silenceFloor
	if !isSilence && c.prevFrameWasSilence {
		// Gate just opened — start a 100ms fade-in ramp.
		c.fadeInSamplesLeft = int(float64(sampleRate) * fadeInSecs)
	}
	c.prevFrameWasSilence = isSilence
	if c.fadeInSamplesLeft > 0 && !isSilence {
		totalFadeSamples := int(float64(sampleRate) * fadeInSecs)
		applyGateFadeIn(pcmLE, &c.fadeInSamplesLeft, totalFadeSamples)
	}

	// Build the metadata that travels with this chunk through the ring buffer.
	meta := ChunkMeta{
		BasebandPower: basebandPower,
		NoiseDensity:  noiseDensity,
		DBFS:          rmsDBFS(pcmLE),
	}

	// Check under lock whether we need a new AudioOutput.
	// We do NOT call NewAudioOutput while holding the lock — on non-Windows
	// platforms NewAudioOutput blocks on <-ready, which would stall the
	// receive goroutine with the mutex held.
	c.mu.Lock()
	out := c.audioOut
	needNew := out == nil || c.sampleRate != sampleRate || c.channels != channels
	// Also recreate if the WASAPI render loop has exited unexpectedly (e.g. a
	// device reset or AUDCLNT_E_DEVICE_INVALIDATED).  DoneC() is closed by
	// renderLoop when it returns, so a non-blocking receive succeeds iff the
	// loop is dead.
	if !needNew && out != nil {
		select {
		case <-out.DoneC():
			needNew = true // render loop died; recreate the output
		default:
		}
	}
	var oldOut *AudioOutput
	var deviceID string
	var initialVolume float64 = 1.0
	if needNew {
		oldOut = out
		deviceID = c.DeviceID
		initialVolume = c.volume
		// Clear stale state so a concurrent call doesn't reuse the old output.
		c.audioOut = nil
		c.sampleRate = 0
		c.channels = 0
	}
	c.mu.Unlock()

	if needNew {
		// Close the old output outside the lock so its shutdown doesn't
		// block other goroutines from acquiring c.mu.
		if oldOut != nil {
			oldOut.Close()
		}

		newOut, err := NewAudioOutput(sampleRate, channels, 40*time.Millisecond, deviceID)
		if err != nil {
			return
		}
		// Apply the current volume and channel mode immediately so there's no
		// silent gap and the routing is correct from the very first frame.
		if initialVolume != 1.0 {
			newOut.SetVolume(initialVolume)
		}
		c.mu.RLock()
		initialChannelMode := c.channelMode
		c.mu.RUnlock()
		if initialChannelMode != ChannelModeBoth {
			newOut.SetChannelMode(initialChannelMode)
		}

		// Register the playback-synchronised callback.  This fires (after a
		// delay matching the buffer depth) at approximately the moment each
		// chunk is heard.  The server sends signal data every 100 ms, so we
		// throttle the UI updates to the same rate to avoid flooding Fyne's
		// render pipeline.
		//
		// We also guard against stale delayed goroutines firing after disconnect:
		// if the client is no longer connected when the callback fires, we skip
		// the update so that SetNoData() called by OnStateChange is not overwritten.
		onSQ := c.OnSignalQuality
		onAL := c.OnAudioLevel
		var lastBarUpdate time.Time
		newOut.SetOnChunkPlayed(func(m ChunkMeta) {
			if c.State() != StateConnected {
				return
			}
			now := time.Now()
			if now.Sub(lastBarUpdate) < 100*time.Millisecond {
				return
			}
			lastBarUpdate = now
			if onSQ != nil && (m.BasebandPower > -998 || m.NoiseDensity > -998) {
				onSQ(m.BasebandPower, m.NoiseDensity)
			}
			if onAL != nil {
				onAL(m.DBFS)
			}
		})

		c.mu.Lock()
		c.audioOut = newOut
		c.sampleRate = sampleRate
		c.channels = channels
		out = newOut
		c.mu.Unlock()

		if c.OnAudioInfo != nil {
			c.OnAudioInfo(sampleRate, channels)
		}
	}

	out.Push(pcmLE, meta)
}

// cleanup closes the WebSocket and audio output.
func (c *RadioClient) cleanup() {
	c.mu.Lock()
	conn := c.conn
	out := c.audioOut
	opusDec := c.opusDec
	decodeCh := c.opusDecodeCh
	pcmCh := c.pcmDeliverCh
	c.conn = nil
	c.audioOut = nil
	// Dropped rather than reset: a decoder's predictor and header state is only
	// meaningful against the encoder on the other end of this socket.
	c.pcmV4Decoder = nil
	c.opusV4Header = nil
	c.opusDec = nil
	c.opusDecodeCh = nil
	c.pcmDeliverCh = nil
	// Reset audio params so the output is always recreated on the next connection
	c.sampleRate = 0
	c.channels = 0
	c.mu.Unlock()

	if conn != nil {
		conn.Close()
	}
	// Close the Opus decode channel to stop the worker goroutine.
	if decodeCh != nil {
		close(decodeCh)
	}
	// Close the PCM deliver channel to stop its worker goroutine.
	if pcmCh != nil {
		close(pcmCh)
	}
	if out != nil {
		out.Close()
	}
	if opusDec != nil {
		opusDec.Close()
	}
}
