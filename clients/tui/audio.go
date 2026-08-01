package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/opus"
)

// Audio packets are a fixed header followed by the encoded payload:
//
//	[0:8]   uint64 LE  capture timestamp, nanoseconds
//	[8:12]  uint32 LE  sample rate of the source channel
//	[12]    uint8      channel count
//	[13:17] float32 LE baseband power, dBFS
//	[17:21] float32 LE noise density
//	[21:]              Opus packet
const audioHeaderLen = 21

// opusOutputRate is what the decoder produces. Opus always reconstructs at
// 48 kHz regardless of the rate the encoder was fed, so the source rate in the
// header describes the radio channel, not the PCM we get back.
const opusOutputRate = 48000

// silenceCeiling is the peak sample amplitude below which a decoded frame
// counts as silence. Roughly -78 dBFS: far above what a gated frame decodes to
// and far below any real audio.
const silenceCeiling = 4

// DSPState is the server's own account of the DSP insert, from a dsp_status
// message. The server is authoritative: it may refuse a filter when the insert
// is at its user limit, so the display follows this rather than what was asked
// for.
type DSPState struct {
	Enabled bool
	Filter  string
}

// Signal is one reading from an audio packet's header.
type Signal struct {
	Power float32 // baseband power, dBFS
	Noise float32 // noise density, dBFS

	// SourceRate is the radio channel's sample rate, which changes with mode.
	// It is reported for display only: Opus reconstructs at 48 kHz whatever it
	// was encoded from.
	SourceRate int
	Channels   int
}

// SNR is the difference the meter shows in SNR mode, matching
// signal-meter.js. It is only meaningful when both halves were reported.
func (s Signal) SNR() float32 { return s.Power - s.Noise }

func (s Signal) Valid() bool      { return isReportedLevel(s.Power) }
func (s Signal) NoiseValid() bool { return isReportedLevel(s.Noise) }

// isReportedLevel rejects the sentinels the server and clients use for "no
// reading": -999 in the Python client, and the infinities that appear before
// the first packet or on a silent channel.
func isReportedLevel(v float32) bool {
	f := float64(v)
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f > -998
}

// AudioClient streams demodulated audio over its own WebSocket, sharing the
// spectrum session's UUID so the server treats both as one user session.
type AudioClient struct {
	host      string
	tls       bool
	password  string
	sessionID string

	mu        sync.RWMutex
	conn      *websocket.Conn
	connected bool

	// Current tuning, echoed back into reconnects so a dropped socket resumes
	// where the user left off.
	freq   float64
	mode   string
	bwLow  int
	bwHigh int

	// Rate limited like the spectrum socket; the server rejects faster.
	cmdMu       sync.Mutex
	lastCommand time.Time

	// Desired DSP insert, re-applied on reconnect so it survives a dropped
	// socket like the tuning does.
	dspFilter string

	// Squelch threshold in dB of SNR; 0 means off. Sent on connect as well as
	// on change, so it survives a reconnect.
	squelch int

	// Set when a reconnect is deliberate, so Run redials immediately instead of
	// backing off as it would after a failure.
	reconnecting bool

	PCM     chan []int16 // decoded mono samples at opusOutputRate
	Level   chan Signal  // baseband power and noise density, for the meter
	DSP     chan DSPState
	Silence chan bool // true when a decoded frame carried only silence
	Status  chan string
}

func NewAudioClient(host string, useTLS bool, password, sessionID string) *AudioClient {
	// Opening defaults come from the mode table; the UI overrides them with
	// SetTuning before the socket is used.
	usb, _ := lookupMode("usb")
	return &AudioClient{
		host:      host,
		tls:       useTLS,
		password:  password,
		sessionID: sessionID,
		mode:      usb.Name,
		bwLow:     usb.Low,
		bwHigh:    usb.High,
		// Generous buffering: the player drains this, and a brief render stall
		// should not cost audio.
		PCM:     make(chan []int16, 64),
		Level:   make(chan Signal, 8),
		DSP:     make(chan DSPState, 4),
		Silence: make(chan bool, 16),
		Status:  make(chan string, 8),
	}
}

// SetTuning records the parameters to open with. Call before Run.
func (a *AudioClient) SetTuning(freq float64, mode string, low, high int) {
	a.mu.Lock()
	a.freq, a.mode, a.bwLow, a.bwHigh = freq, mode, low, high
	a.mu.Unlock()
}

func (a *AudioClient) scheme(secure, plain string) string {
	if a.tls {
		return secure
	}
	return plain
}

// Run connects and streams until ctx is cancelled, reconnecting on drop.
func (a *AudioClient) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := a.session(ctx)
		if ctx.Err() != nil {
			return
		}
		// A reconnect we asked for is not a failure: redial at once and keep
		// the backoff for genuine drops.
		a.mu.Lock()
		deliberate := a.reconnecting
		a.reconnecting = false
		a.mu.Unlock()

		if deliberate {
			backoff = time.Second
			select {
			case <-ctx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
			continue
		}

		if err != nil {
			a.report(fmt.Sprintf("audio disconnected: %v", err))
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

func (a *AudioClient) session(ctx context.Context) error {
	a.mu.RLock()
	freq, mode, low, high := a.freq, a.mode, a.bwLow, a.bwHigh
	a.mu.RUnlock()

	q := url.Values{}
	q.Set("user_session_id", a.sessionID)
	q.Set("format", "opus")
	q.Set("version", "2")
	if a.password != "" {
		q.Set("password", a.password)
	}
	if freq > 0 {
		q.Set("frequency", fmt.Sprintf("%d", int64(freq)))
	}
	if mode != "" {
		q.Set("mode", mode)
	}
	q.Set("bandwidthLow", fmt.Sprintf("%d", low))
	q.Set("bandwidthHigh", fmt.Sprintf("%d", high))
	a.mu.RLock()
	sq := a.squelch
	a.mu.RUnlock()
	q.Set("min_snr", fmt.Sprintf("%g", squelchToWire(sq)))

	wsURL := fmt.Sprintf("%s://%s/ws?%s", a.scheme("wss", "ws"), a.host, q.Encode())

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}

	conn, resp, err := dialer.DialContext(ctx, wsURL, http.Header{
		"User-Agent": []string{"UberSDR TUI Client (go)"},
	})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%w (HTTP %d)", err, resp.StatusCode)
		}
		return err
	}

	a.mu.Lock()
	a.conn = conn
	a.connected = true
	a.mu.Unlock()
	a.report("audio connected")

	// Restore the DSP insert: the server starts each session with none.
	if filter := a.dspFilter; filter != "" {
		a.sendDSP(conn, filter)
	}

	defer func() {
		a.mu.Lock()
		a.connected = false
		a.conn = nil
		a.mu.Unlock()
		conn.Close()
	}()

	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	// The decoder carries inter-frame state, so it must live for the whole
	// session and be discarded when the socket drops.
	decoder := opus.NewDecoder()
	dec := &decoder
	pcm := make([]int16, opusOutputRate) // one second, far above any frame

	for {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		switch msgType {
		case websocket.BinaryMessage:
			a.handleAudio(data, dec, pcm)
		case websocket.TextMessage:
			a.handleText(data)
		}
	}
}

func (a *AudioClient) handleAudio(data []byte, dec *opus.Decoder, pcm []int16) {
	if len(data) <= audioHeaderLen {
		return
	}

	// The header describes the radio channel, not the PCM we get back. The
	// channel's sample rate changes with mode — 12 kHz for the sideband and CW
	// modes, 24 kHz for AM and FM — but Opus always reconstructs at 48 kHz, so
	// playback needs no adjustment. Verified against a live receiver across
	// every mode: a 20 ms frame decodes to 960 samples either way.
	//
	// The channel count does matter: a stereo stream decodes to interleaved
	// pairs, and treating that as mono would halve the duration and play back
	// at double speed.
	srcRate := binary.LittleEndian.Uint32(data[8:12])
	channels := int(data[12])
	if channels < 1 {
		channels = 1
	}

	// Both halves of the signal report: the meter shows either the absolute
	// level or the difference between them.
	power := math.Float32frombits(binary.LittleEndian.Uint32(data[13:17]))
	noise := math.Float32frombits(binary.LittleEndian.Uint32(data[17:21]))
	if isReportedLevel(power) {
		select {
		case a.Level <- Signal{Power: power, Noise: noise, SourceRate: int(srcRate), Channels: channels}:
		default:
		}
	}

	n, err := dec.DecodeToInt16(data[audioHeaderLen:], pcm)
	if err != nil {
		// A single bad frame is not fatal — Opus is resilient and the next
		// frame usually recovers, so drop this one rather than tearing the
		// stream down.
		a.report("audio decode: " + err.Error())
		return
	}
	if n <= 0 {
		return
	}

	// n counts samples per channel; the decoder writes n*channels values.
	// Fold any extra channels down to the mono the mixer expects rather than
	// reading the first n values, which would take half of an interleaved pair
	// and play at double speed.
	out := make([]int16, n)
	if channels <= 1 {
		copy(out, pcm[:n])
	} else {
		for i := 0; i < n; i++ {
			sum := 0
			for c := 0; c < channels; c++ {
				sum += int(pcm[i*channels+c])
			}
			out[i] = int16(sum / channels)
		}
	}

	// A closed gate arrives as a frame of silence rather than as missing
	// packets, so silence here is the server telling us it squelched. Reading
	// it from the audio avoids reimplementing the server's hang timer and
	// hysteresis, which would drift out of step with it.
	//
	// The test is a threshold rather than exact zero: the server zeroes the PCM
	// *before* Opus encoding, and the codec is lossy, so a gated frame decodes
	// to near-silence instead. Measured against a live receiver, gated frames
	// peak at 1 while open audio peaks in the thousands, so the margin either
	// side of this threshold is enormous.
	silent := true
	for _, v := range out {
		if v > silenceCeiling || v < -silenceCeiling {
			silent = false
			break
		}
	}
	select {
	case a.Silence <- silent:
	default:
	}

	select {
	case a.PCM <- out:
	default:
		// The player is behind. Dropping the oldest keeps latency bounded
		// instead of letting a backlog build.
		select {
		case <-a.PCM:
		default:
		}
		select {
		case a.PCM <- out:
		default:
		}
	}
}

func (a *AudioClient) handleText(data []byte) {
	var msg struct {
		Type  string `json:"type"`
		Error string `json:"error"`
		Info  struct {
			Enabled bool   `json:"enabled"`
			Filter  string `json:"filter"`
		} `json:"info"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "error":
		if msg.Error != "" {
			a.report("audio: " + msg.Error)
		}
	case "dsp_status":
		select {
		case a.DSP <- DSPState{Enabled: msg.Info.Enabled, Filter: msg.Info.Filter}:
		default:
		}
	}
}

// squelchDisabled is the value the server reads as "gate off". Zero is a
// perfectly valid SNR threshold, so a separate sentinel is needed; the web UI
// uses the same one.
const squelchDisabled = -999.0

// squelchToWire converts the user-facing threshold, where 0 means off, into the
// value the server expects.
func squelchToWire(threshold int) float64 {
	if threshold <= 0 {
		return squelchDisabled
	}
	return float64(threshold)
}

// SetSquelch sets the SNR gate. A threshold of 0 disables it.
func (a *AudioClient) SetSquelch(threshold int) {
	a.mu.Lock()
	a.squelch = threshold
	conn := a.conn
	ok := a.connected
	a.mu.Unlock()

	if !ok || conn == nil {
		return // applied on the next connect via the query string
	}
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]interface{}{
		"type":    "set_audio_gate",
		"min_snr": squelchToWire(threshold),
	}); err != nil {
		a.report(fmt.Sprintf("squelch command failed: %v", err))
	}
}

// SetDSP enables a server-side DSP insert, or disables it when filter is empty.
func (a *AudioClient) SetDSP(filter string) {
	a.mu.Lock()
	a.dspFilter = filter
	conn := a.conn
	ok := a.connected
	a.mu.Unlock()

	if !ok || conn == nil {
		return // applied on the next connect
	}
	a.sendDSP(conn, filter)
}

func (a *AudioClient) sendDSP(conn *websocket.Conn, filter string) {
	cmd := map[string]interface{}{"type": "set_dsp", "enabled": filter != ""}
	if filter != "" {
		cmd["filter"] = filter
	}
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(cmd); err != nil {
		a.report(fmt.Sprintf("DSP command failed: %v", err))
	}
}

// Tune retunes the existing channel in place. The server reuses the same radiod
// channel for this, which is far cheaper than reconnecting.
//
// Changing to a mode with a different channel sample rate is the exception. The
// server builds its Opus encoder once, from the rate in force when the socket
// opened, and never rebuilds it — so after such a change it encodes 24 kHz
// audio as though it were 12 kHz, emitting 40 ms frames for 20 ms of sound.
// That decodes to twice as many samples and plays at half speed. Reconnecting
// gets an encoder built for the new rate.
func (a *AudioClient) Tune(freq float64, mode string, low, high int) {
	a.mu.Lock()
	rateChanged := a.connected && modeSampleRate(mode) != modeSampleRate(a.mode)
	a.freq, a.mode, a.bwLow, a.bwHigh = freq, mode, low, high
	conn := a.conn
	ok := a.connected
	if rateChanged {
		a.reconnecting = true
	}
	a.mu.Unlock()

	if !ok || conn == nil {
		return // the new values are stored; the next connect will use them
	}

	if rateChanged {
		// Closing here makes Run redial with the values just stored.
		a.report(fmt.Sprintf("%s needs %d kHz audio — reconnecting",
			strings.ToUpper(mode), modeSampleRate(mode)/1000))
		conn.Close()
		return
	}

	// Same 10/s budget the spectrum socket uses. Commands are absolute, so a
	// dropped one is superseded by whatever the user does next.
	a.cmdMu.Lock()
	if !a.lastCommand.IsZero() && time.Since(a.lastCommand) < minCommandDelay {
		a.cmdMu.Unlock()
		return
	}
	a.lastCommand = time.Now()
	a.cmdMu.Unlock()

	cmd := map[string]interface{}{
		"type":          "tune",
		"frequency":     int64(freq + 0.5),
		"mode":          mode,
		"bandwidthLow":  low,
		"bandwidthHigh": high,
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(cmd); err != nil {
		a.report(fmt.Sprintf("tune failed: %v", err))
	}
}

func (a *AudioClient) Connected() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.connected
}

func (a *AudioClient) report(msg string) {
	select {
	case a.Status <- msg:
	default:
	}
}
