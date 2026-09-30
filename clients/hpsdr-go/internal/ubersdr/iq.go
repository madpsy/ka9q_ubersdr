package ubersdr

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/pcmv4"
)

// ErrLegacyServer is returned when the server answers in the pre-version-4
// format. A server older than 0.1.63 clamps the requested version to 1-3 and
// answers with zstd-wrapped version 1 rather than refusing, so naming it beats
// a stream of bad magic hundreds of times a second.
var ErrLegacyServer = errors.New("server does not support protocol version 4 (needs UberSDR 0.1.63 or later)")

// ErrRateLimited is the server refusing a connection because this address has
// opened too many lately. It lifts on its own, and a bypassed session is never
// limited. The /connection precheck reports the same thing as a result with
// RateLimited set, since it answers in the body as well.
var ErrRateLimited = errors.New("rate limited by the server")

// IQURL is the socket URL for one IQ session.
//
// "pcm-zstd" is still the server's name for the lossless format; from version
// 4 what it carries is the predictive codec. min_margin is sent only when
// reduced depth is on: an empty or zero parameter is not the same thing to the
// server as an absent one, and absent is the lossless path.
func (s *Server) IQURL(sessionID string, freqHz int64, khz, minMargin int) string {
	scheme := "ws"
	if s.Secure() {
		scheme = "wss"
	}
	q := url.Values{}
	q.Set("frequency", strconv.FormatInt(freqHz, 10))
	q.Set("mode", ModeForKHz(khz))
	q.Set("user_session_id", sessionID)
	if s.Password != "" {
		q.Set("password", s.Password)
	}
	q.Set("format", "pcm-zstd")
	q.Set("version", strconv.Itoa(pcmv4.ProtocolVersion))
	if minMargin > 0 {
		q.Set("min_margin", strconv.Itoa(minMargin))
	}
	return scheme + "://" + s.Host() + "/ws?" + q.Encode()
}

// IQConn is one receiver's socket and the decoder that belongs to it.
//
// The decoder IS the stream: its predictor carries the adaptation of every
// sample decoded on this socket, so every binary frame must reach it and it is
// discarded with the socket.
type IQConn struct {
	ws  *websocket.Conn
	dec *pcmv4.PCMv4StreamDecoder
	wmu sync.Mutex

	// deadlineAt is when the read deadline was last pushed on; see ReadIdle.
	deadlineAt time.Time
	deadlineOn bool
}

// DialIQ opens an IQ socket. The session must already have passed Check.
func (s *Server) DialIQ(ctx context.Context, sessionID string, freqHz int64, khz, minMargin int) (*IQConn, error) {
	d := websocket.Dialer{
		Proxy:            http.ProxyFromEnvironment,
		HandshakeTimeout: 10 * time.Second,
		TLSClientConfig:  &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // as the C bridge
		ReadBufferSize:   64 << 10,
	}
	h := http.Header{}
	h.Set("User-Agent", UserAgent)
	ws, resp, err := d.DialContext(ctx, s.IQURL(sessionID, freqHz, khz, minMargin), h)
	if err != nil {
		if resp != nil {
			if resp.StatusCode == http.StatusTooManyRequests {
				return nil, fmt.Errorf("websocket: %w", ErrRateLimited)
			}
			return nil, fmt.Errorf("websocket: %w (HTTP %d)", err, resp.StatusCode)
		}
		return nil, fmt.Errorf("websocket: %w", err)
	}
	ws.SetReadLimit(8 << 20)
	return &IQConn{ws: ws, dec: pcmv4.NewPCMv4StreamDecoder()}, nil
}

// MsgKind says what a Message carries.
type MsgKind int

const (
	// MsgIQ: decoded samples, interleaved I/Q int16.
	MsgIQ MsgKind = iota
	// MsgStatus: the server's status after connect and every tune.
	MsgStatus
	// MsgError: the server's own error message, usually just before it closes.
	MsgError
	// MsgText: any other text frame, passed through in full -- a type this
	// bridge does not know about is exactly what should not be hidden.
	MsgText
	// MsgBad: a binary frame that did not decode. The stream continues; the
	// server's periodic resynchronisation recovers it.
	MsgBad
)

// Message is one frame off the socket.
type Message struct {
	Kind MsgKind

	// WireBytes is the size of a binary frame as it arrived, which is what the
	// link actually carried: reduced depth is only visible here.
	WireBytes int

	// MsgIQ
	SampleRate int
	Samples    []int16

	// MsgStatus
	Mode string

	// MsgError, MsgText, MsgBad
	Text string
}

// Read returns the next frame. An error means the socket is finished.
func (c *IQConn) Read() (Message, error) { return c.ReadIdle(0) }

// ReadIdle is Read with a limit on how long the server may stay silent. IQ
// arrives many times a second, so a socket that has said nothing for seconds is
// half-open -- the far end gone without a close -- and would otherwise block
// forever. Zero waits indefinitely.
//
// The deadline is pushed on only once a quarter of idle has passed, not on
// every read: at 384 kHz the server sends about a thousand frames a second, and
// each push is a runtime timer update. A silent server is noticed after between
// three quarters of idle and idle. Not safe for concurrent reads, which a
// WebSocket does not allow anyway.
func (c *IQConn) ReadIdle(idle time.Duration) (Message, error) {
	switch {
	case idle > 0:
		now := time.Now()
		if !c.deadlineOn || now.Sub(c.deadlineAt) >= idle/4 {
			_ = c.ws.SetReadDeadline(now.Add(idle))
			c.deadlineAt, c.deadlineOn = now, true
		}
	case c.deadlineOn:
		_ = c.ws.SetReadDeadline(time.Time{})
		c.deadlineOn = false
	}
	typ, data, err := c.ws.ReadMessage()
	if err != nil {
		return Message{}, err
	}
	if typ != websocket.BinaryMessage {
		return parseText(data), nil
	}
	m := Message{WireBytes: len(data)}
	if pcmv4.IsZstdFrame(data) {
		return m, ErrLegacyServer
	}
	h, samples, err := c.dec.DecodePacket(data)
	if err != nil {
		m.Kind, m.Text = MsgBad, err.Error()
		return m, nil
	}
	if h.Channels != 2 {
		m.Kind, m.Text = MsgBad, fmt.Sprintf("expected 2 channels of I/Q, got %d", h.Channels)
		return m, nil
	}
	m.Kind, m.SampleRate, m.Samples = MsgIQ, h.SampleRate, samples
	return m, nil
}

func parseText(data []byte) Message {
	var v struct {
		Type       string `json:"type"`
		Mode       string `json:"mode"`
		SampleRate int    `json:"sampleRate"`
		Error      string `json:"error"`
	}
	if json.Unmarshal(data, &v) != nil {
		return Message{Kind: MsgText, Text: string(data)}
	}
	switch v.Type {
	case "status":
		return Message{Kind: MsgStatus, Mode: v.Mode, SampleRate: v.SampleRate}
	case "error":
		return Message{Kind: MsgError, Text: v.Error}
	}
	return Message{Kind: MsgText, Text: string(data)}
}

// Tune retunes the session. The mode travels with it, and must be the one the
// socket was opened with (see ModeForKHz).
func (c *IQConn) Tune(freqHz int64, khz int) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.ws.WriteJSON(map[string]any{"type": "tune", "frequency": freqHz, "mode": ModeForKHz(khz)})
}

// Close closes the socket. Safe to call more than once and from any goroutine;
// a blocked Read returns.
func (c *IQConn) Close() error { return c.ws.Close() }
