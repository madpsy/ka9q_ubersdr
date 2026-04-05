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
	FormatPCMZstd AudioFormat = iota // lossless PCM, zstd-compressed on the wire
	FormatOpus                       // lossy Opus (requires server Opus support)
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

	// Runtime state
	userSessionID      string
	conn               *websocket.Conn
	state              ConnectionState
	generation         uint64 // incremented on each Connect(); runLoop goroutines ignore stale state transitions
	sampleRate         int
	channels           int
	volume             float64 // current volume (0.0–1.0); applied to new AudioOutput on creation
	pcmDecoder         *PCMBinaryDecoder
	audioOut           *AudioOutput
	cancelFn           context.CancelFunc
	connMaxSessionTime int  // MaxSessionTime from last /connection response (0 = unlimited)
	connBypassed       bool // Bypassed flag from last /connection response

	// Callbacks (called from the receive goroutine; Fyne Set* methods are goroutine-safe)
	OnStateChange   func(ConnectionState, string)             // state, optional message
	OnAudioInfo     func(sampleRate, channels int)            // called when audio params are known
	OnSignalQuality func(basebandPower, noiseDensity float32) // called each full-header packet; -999 = no data
	OnAudioLevel    func(dBFS float32)                        // called each audio frame with RMS level in dBFS

	// bytesReceived accumulates compressed wire bytes since last reset.
	// Read and reset atomically with BytesReceivedAndReset().
	bytesReceived atomic.Int64

	// opusDec is the Opus decoder instance (nil until first Opus frame).
	// Protected by mu.
	opusDec *opusDecoder

	// opusDecodeCh is a buffered channel of raw Opus wire frames.
	// The WebSocket receive goroutine enqueues frames here non-blocking;
	// a dedicated worker goroutine calls opus_decode (a DLL syscall that
	// pins an OS thread) so the receive goroutine is never stalled by it.
	// This keeps the IOCP completion path as short as possible and prevents
	// the Go network poller from being starved on Windows.
	opusDecodeCh chan []byte

	// pcmDeliverCh is a buffered channel of decoded PCM packets.
	// The WebSocket receive goroutine decodes and enqueues here non-blocking;
	// a dedicated worker goroutine calls deliverAudio so that burst processing
	// (e.g. after a stall) does not cause rapid-fire SetValue calls that Fyne
	// coalesces into a single stale redraw, making the audio level bar appear stuck.
	pcmDeliverCh chan pcmDecodedPacket

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
// The value is applied immediately to any active AudioOutput.
func (c *RadioClient) SetChannelMode(mode int) {
	c.mu.RLock()
	out := c.audioOut
	c.mu.RUnlock()
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
	if c.Format == FormatOpus {
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
	q.Set("version", "2") // Request v2 headers with signal quality (basebandPower, noiseDensity)
	q.Set("user_session_id", c.userSessionID)
	q.Set("bandwidthLow", fmt.Sprintf("%d", c.BandwidthLow))
	q.Set("bandwidthHigh", fmt.Sprintf("%d", c.BandwidthHigh))
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
	c.mu.Unlock()

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
	conn, _, err := dialer.DialContext(ctx, wsURL, headers)
	if err != nil {
		c.setState(gen, StateError, fmt.Sprintf("WebSocket dial: %v", err))
		return
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	c.setState(gen, StateConnected, "")

	// Initialise PCM decoder
	pcmDec, err := NewPCMBinaryDecoder()
	if err != nil {
		c.setState(gen, StateError, fmt.Sprintf("PCM decoder init: %v", err))
		conn.Close()
		return
	}
	c.mu.Lock()
	c.pcmDecoder = pcmDec
	c.mu.Unlock()

	// Create the Opus decode channel and start the worker goroutine.
	// The worker owns all opus_decode DLL calls so the receive goroutine
	// (and therefore the IOCP poller) is never blocked by them.
	opusDecodeCh := make(chan []byte, 8)
	c.mu.Lock()
	c.opusDecodeCh = opusDecodeCh
	c.mu.Unlock()

	go func() {
		for raw := range opusDecodeCh {
			c.decodeAndDeliverOpus(raw)
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
			c.handleBinary(data)
		}
		// JSON messages (status, error, pong) are ignored for now
	}
}

// handleBinary processes a binary WebSocket frame (PCM-zstd or Opus).
func (c *RadioClient) handleBinary(data []byte) {
	c.mu.RLock()
	format := c.Format
	c.mu.RUnlock()

	if format == FormatOpus {
		c.handleOpusBinary(data)
	} else {
		c.handlePCMBinary(data)
	}
}

// handlePCMBinary decodes a PCM-zstd binary frame and enqueues it for delivery
// by the PCM worker goroutine.  This returns immediately so the WebSocket receive
// goroutine (and the IOCP poller) is never stalled by deliverAudio or NewAudioOutput.
func (c *RadioClient) handlePCMBinary(data []byte) {
	c.mu.RLock()
	dec := c.pcmDecoder
	ch := c.pcmDeliverCh
	c.mu.RUnlock()

	if dec == nil || ch == nil {
		return
	}

	pcmLE, sampleRate, channels, basebandPower, noiseDensity, err := dec.DecodePCMBinary(data)
	if err != nil {
		return
	}

	// Non-blocking enqueue: drop if the worker is momentarily behind rather
	// than stalling the receive goroutine.
	select {
	case ch <- pcmDecodedPacket{pcmLE, sampleRate, channels, basebandPower, noiseDensity}:
	default:
	}
}

// handleOpusBinary enqueues a raw Opus wire frame for decoding by the worker
// goroutine.  This returns immediately so the WebSocket receive goroutine (and
// the underlying IOCP poller) is never blocked by the opus_decode DLL call.
func (c *RadioClient) handleOpusBinary(data []byte) {
	c.mu.RLock()
	ch := c.opusDecodeCh
	c.mu.RUnlock()
	if ch == nil {
		return
	}
	// Copy data — the WebSocket library reuses the underlying buffer.
	cp := make([]byte, len(data))
	copy(cp, data)
	// Non-blocking enqueue: if the worker is momentarily behind, drop rather
	// than stalling the receive goroutine.
	select {
	case ch <- cp:
	default:
	}
}

// decodeAndDeliverOpus is called by the Opus worker goroutine.
// It performs the actual DLL call and delivers PCM to the audio output.
func (c *RadioClient) decodeAndDeliverOpus(data []byte) {
	c.mu.Lock()
	opusDec := c.opusDec
	c.mu.Unlock()

	pcmLE, sampleRate, channels, basebandPower, noiseDensity, err := decodeOpusFrame(data, &opusDec)
	if err != nil {
		return
	}

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

// deliverAudio pushes PCM to the audio output, creating or recreating the
// AudioOutput if the stream parameters changed.
//
// Signal quality (OnSignalQuality) and audio level (OnAudioLevel) are no
// longer fired here.  Instead they are fired from the AudioOutput's
// onChunkStart callback at the moment the audio is actually played, so the
// bars stay in sync with what the user hears.
func (c *RadioClient) deliverAudio(pcmLE []byte, sampleRate, channels int, basebandPower, noiseDensity float32) {
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
		// Apply the current volume immediately so there's no silent gap.
		if initialVolume != 1.0 {
			newOut.SetVolume(initialVolume)
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
	dec := c.pcmDecoder
	opusDec := c.opusDec
	decodeCh := c.opusDecodeCh
	pcmCh := c.pcmDeliverCh
	c.conn = nil
	c.audioOut = nil
	c.pcmDecoder = nil
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
	if dec != nil {
		dec.Close()
	}
	if opusDec != nil {
		opusDec.Close()
	}
}
