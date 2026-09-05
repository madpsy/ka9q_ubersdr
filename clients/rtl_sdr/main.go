package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"gopkg.in/yaml.v3"
)

const (
	// rtl_tcp protocol defaults
	DefaultPort       = "1234"
	DefaultSampleRate = 2048000

	// Tuner type constants (from rtl-sdr/include/rtl-sdr.h)
	TunerUnknown = 0
	TunerE4000   = 1
	TunerFC0012  = 2
	TunerFC0013  = 3
	TunerFC2580  = 4
	TunerR820T   = 5
	TunerR828D   = 6

	// R820T gain table has 29 entries
	R820TGainCount = 29

	// The tuning range to assume when the receiver has not said.
	//
	// This is the compatibility contract shared by every UberSDR client — see
	// ReceiverConfig.MinFreq/MaxFreq in receiver_span.go and TuningRange.Limits in
	// clients/tui/client.go. A server too old to publish the range, or one this bridge
	// could not reach, leaves it behaving exactly as it did before the receiver span
	// became configurable: 10 kHz to 30 MHz.
	//
	// Read through minFrequencyHz()/maxFrequencyHz(), not these, everywhere else: the
	// receiver is not always the 0-30 MHz box this bridge assumed, and a 129.6 Msps
	// RX888 reaches 60 MHz.
	//
	// Note this range is *not* what the connecting SDR client is told. The rtl_tcp
	// protocol has no frequency-range field at all — the dongle header carries only a
	// tuner type, and this bridge reports R820T, which makes clients believe 24-1766 MHz
	// is tunable. There is nowhere to put the truth, so it is used to warn and nothing
	// more.
	MinFrequencyHz = 10000    // 10 kHz
	MaxFrequencyHz = 30000000 // 30 MHz

	// DefaultMaxClients is the default maximum number of simultaneous rtl_tcp clients.
	// Set to 0 for unlimited.
	DefaultMaxClients = 4
)

// WebSocketMessage represents incoming WebSocket messages from ubersdr
type WebSocketMessage struct {
	Type       string `json:"type"`
	Data       string `json:"data,omitempty"`
	SampleRate int    `json:"sampleRate,omitempty"`
	Channels   int    `json:"channels,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	Frequency  int    `json:"frequency,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ConnectionCheckRequest for /connection endpoint
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"`
}

// ConnectionCheckResponse from /connection endpoint
type ConnectionCheckResponse struct {
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	ClientIP       string   `json:"client_ip,omitempty"`
	SessionTimeout int      `json:"session_timeout"`
	MaxSessionTime int      `json:"max_session_time"`
	Bypassed       bool     `json:"bypassed"`
	AllowedIQModes []string `json:"allowed_iq_modes,omitempty"`
}

// FrequencyRange defines a frequency range mapped to a specific UberSDR instance
type FrequencyRange struct {
	Name     string `yaml:"name"`
	MinFreq  int64  `yaml:"min_freq"`
	MaxFreq  int64  `yaml:"max_freq"`
	URL      string `yaml:"url"`
	Password string `yaml:"password"`
}

// RoutingConfig holds the frequency routing configuration
type RoutingConfig struct {
	DefaultURL      string           `yaml:"default_url"`
	DefaultPassword string           `yaml:"default_password"`
	FrequencyRanges []FrequencyRange `yaml:"frequency_ranges"`
}

// IQMode is the only UberSDR IQ mode this bridge uses.
//
// rtl_tcp clients request arbitrary rates; we always receive iq384 (384 kHz)
// from UberSDR and resample to whatever was asked for. Frequencies outside
// ±192 kHz of centre carry no signal.
//
// The widest mode is taken deliberately, and it is why this bridge is for
// receiver owners rather than for pointing at somebody else's instance: the
// server only offers the wide IQ modes to a bypassed session, so a public
// receiver will refuse this outright (see the allowed_iq_modes check in
// checkConnection). It also doubles the wire, measured at 1129 kB/s against
// iq192's 563 on protocol version 4, which the receiver's operator pays for.
//
// What it buys is bandwidth the client can actually use. A typical rtl_tcp
// client asks for 225 kHz or more, and from iq192 everything beyond ±96 kHz
// was zero-fill; from iq384 the real span covers the usual requests outright.
const IQMode = "iq384"
const IQModeRate = 384000

// clientSession holds all state for a single connected rtl_tcp client.
// Each accepted TCP connection gets its own independent clientSession so that
// multiple clients can be served simultaneously without sharing any mutable state.
type clientSession struct {
	// back-reference to the bridge (read-only config fields only)
	bridge *RTLTCPBridge

	// per-session identity
	userSessionID string

	// TCP connection to the rtl_tcp client
	tcpConn net.Conn

	// WebSocket connection to UberSDR
	wsConn   *websocket.Conn
	wsConnMu sync.Mutex

	// current tuning state
	mu            sync.RWMutex
	frequency     int64
	currentURL    string // URL of the currently connected UberSDR instance
	sampleRate    int    // actual UberSDR sample rate (always IQModeRate = 384000)
	requestedRate uint32 // rate requested by rtl_tcp client (e.g. 2048000)

	// resampler performs bandlimited windowed-sinc resampling from the UberSDR
	// delivery rate (384 kHz) to the rate the client requested via SET_SAMPLE_RATE.
	// It is created/replaced whenever SET_SAMPLE_RATE is received.
	// Access is serialised by receiveFromUberSDR (single goroutine) so no mutex needed.
	resampler *IQResampler

	// IQ output channel (uint8 pairs sent to TCP client), one buffer per packet
	// received. At iq384's ~1090 packets a second that is about half a second of
	// headroom, which is what absorbs a stalled TCP write without adding
	// latency that a listener would hear.
	iqChan chan []byte

	// clientDone is closed when the command loop exits, signalling forwardIQToClient to stop.
	clientDone chan struct{}

	// forwardDone is closed when the forwardIQToClient goroutine exits.
	// It is nil until streaming starts (first SET_FREQ received).
	forwardDone chan struct{}

	// streamingStarted is true once the UberSDR WebSocket has been connected
	// and IQ forwarding goroutines have been launched.
	streamingStarted bool

	// Protocol version 4 packet decoder.
	//
	// Replaced rather than reset when a socket opens, and read under mu by the
	// receive goroutine, which is the only thing that decodes: the predictor is
	// backward adaptive, so an instance is only meaningful against the encoder
	// at the other end of one particular connection, and a fresh socket means
	// the server has built a fresh encoder.
	pcmDecoder *PCMv4StreamDecoder

	// stopCh is closed when the bridge is stopping (shared with bridge)
	stopCh chan struct{}
}

// RTLTCPBridge listens for rtl_tcp clients and manages a pool of clientSessions.
type RTLTCPBridge struct {
	// UberSDR connection settings
	ubersdrURL    string
	password      string
	routingConfig *RoutingConfig

	// TCP server
	listenAddr string
	listener   net.Listener

	// maxClients is the maximum number of simultaneous rtl_tcp clients.
	// 0 means unlimited.
	maxClients int

	// active sessions
	sessionsMu sync.Mutex
	sessions   map[string]*clientSession // keyed by userSessionID

	// initialFreq is used as the starting frequency for each new session
	initialFreq int64

	// minMargin is the reduced-depth IQ request in dB, or 0 for the lossless
	// stream. On by default at MinMarginDefaultDB; only -min-margin 0 turns it
	// off. See parseMinMargin.
	minMargin int

	running bool
	stopCh  chan struct{}
}

// NewRTLTCPBridge creates a new bridge instance.
// maxClients: maximum simultaneous rtl_tcp clients (0 = unlimited).
func NewRTLTCPBridge(ubersdrURL, password, listenAddr string, initialFreq int64, routingConfig *RoutingConfig, maxClients, minMargin int) *RTLTCPBridge {
	return &RTLTCPBridge{
		ubersdrURL:    ubersdrURL,
		password:      password,
		listenAddr:    listenAddr,
		routingConfig: routingConfig,
		maxClients:    maxClients,
		initialFreq:   initialFreq,
		minMargin:     minMargin,
		sessions:      make(map[string]*clientSession),
		running:       true,
		stopCh:        make(chan struct{}),
	}
}

// newClientSession allocates a fresh clientSession for an incoming TCP connection.
func (b *RTLTCPBridge) newClientSession(conn net.Conn) *clientSession {
	return &clientSession{
		bridge:        b,
		userSessionID: uuid.New().String(),
		tcpConn:       conn,
		frequency:     b.initialFreq,
		sampleRate:    IQModeRate,
		requestedRate: 0,
		iqChan:        make(chan []byte, 512),
		clientDone:    make(chan struct{}),
		forwardDone:   nil,
		pcmDecoder:    NewPCMv4StreamDecoder(),
		stopCh:        b.stopCh,
	}
}

// getURLForFrequency returns the appropriate URL and password for a given frequency
func (b *RTLTCPBridge) getURLForFrequency(frequency int64) (string, string) {
	if b.routingConfig == nil {
		return b.ubersdrURL, b.password
	}
	for _, fr := range b.routingConfig.FrequencyRanges {
		if frequency >= fr.MinFreq && frequency <= fr.MaxFreq {
			log.Printf("Bridge: Frequency %d Hz matched range '%s' (%d-%d Hz), using %s",
				frequency, fr.Name, fr.MinFreq, fr.MaxFreq, fr.URL)
			return fr.URL, fr.Password
		}
	}
	return b.routingConfig.DefaultURL, b.routingConfig.DefaultPassword
}

// checkConnection checks if connection is allowed via /connection endpoint
func (s *clientSession) checkConnection(targetURL, targetPassword string, clientAddr net.Addr) (bool, error) {
	parsedURL, err := url.Parse(targetURL)
	if err != nil {
		return false, err
	}

	httpScheme := "http"
	if parsedURL.Scheme == "https" || parsedURL.Scheme == "wss" {
		httpScheme = "https"
	}

	httpURL := fmt.Sprintf("%s://%s/connection", httpScheme, parsedURL.Host)

	reqBody := ConnectionCheckRequest{
		UserSessionID: s.userSessionID,
		Password:      targetPassword,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return false, err
	}

	log.Printf("[%s] Checking connection permission at %s", s.userSessionID[:8], httpURL)

	req, err := http.NewRequest("POST", httpURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "UberSDR_RTLTCP/1.0")

	// Forward the rtl_tcp client's IP
	if clientAddr != nil {
		if tcpAddr, ok := clientAddr.(*net.TCPAddr); ok {
			req.Header.Set("X-Real-IP", tcpAddr.IP.String())
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[%s] Connection check failed: %v — attempting anyway", s.userSessionID[:8], err)
		return true, nil
	}
	defer func() { _ = resp.Body.Close() }()

	var respData ConnectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&respData); err != nil {
		return false, err
	}

	if !respData.Allowed {
		log.Printf("[%s] Connection rejected: %s", s.userSessionID[:8], respData.Reason)
		return false, nil
	}

	// If the server advertises which IQ modes are available, verify ours is among them.
	if len(respData.AllowedIQModes) > 0 {
		hasIQ192 := false
		for _, m := range respData.AllowedIQModes {
			if m == IQMode {
				hasIQ192 = true
				break
			}
		}
		if !hasIQ192 {
			log.Printf("[%s] Connection rejected: server does not offer %s (available: %v)",
				s.userSessionID[:8], IQMode, respData.AllowedIQModes)
			return false, nil
		}
		log.Printf("[%s] Server confirmed %s is available", s.userSessionID[:8], IQMode)
	}

	log.Printf("[%s] Connection allowed (client IP: %s, bypassed: %v)", s.userSessionID[:8], respData.ClientIP, respData.Bypassed)
	return true, nil
}

// connectToUberSDR establishes a WebSocket connection to UberSDR for this session
func (s *clientSession) connectToUberSDR(clientAddr net.Addr) error {
	s.mu.Lock()
	frequency := s.frequency
	s.mu.Unlock()
	mode := IQMode

	targetURL, targetPassword := s.bridge.getURLForFrequency(frequency)

	allowed, err := s.checkConnection(targetURL, targetPassword, clientAddr)
	if err != nil {
		log.Printf("[%s] Connection check error: %v", s.userSessionID[:8], err)
	}
	if !allowed {
		return fmt.Errorf("connection not allowed by UberSDR server")
	}

	parsedURL, err := url.Parse(targetURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	wsScheme := "ws"
	if parsedURL.Scheme == "https" || parsedURL.Scheme == "wss" {
		wsScheme = "wss"
	}

	wsURL := &url.URL{
		Scheme: wsScheme,
		Host:   parsedURL.Host,
		Path:   "/ws",
	}

	query := url.Values{}
	query.Set("frequency", fmt.Sprintf("%d", frequency))
	query.Set("mode", mode)
	// "pcm-zstd" is still the server's name for the lossless format, and IQ is
	// only ever served losslessly in any case; from protocol version 4 what it
	// carries is a predictive codec rather than a zstd wrapper, which is where
	// the bandwidth went -- 384 kHz IQ falls from 1590 kB/s to 1116. Version 4
	// is the only one this bridge reads, and a server from 0.1.63 on refuses a
	// version it cannot serve rather than quietly sending an older one.
	query.Set("format", "pcm-zstd")
	query.Set("version", fmt.Sprintf("%d", pcmProtocolVersion))
	query.Set("user_session_id", s.userSessionID)
	// Sent unless -min-margin 0 turned it off. An absent min_margin is not the
	// same thing to the server as a zero one: absent is the lossless path,
	// which is what asking for 0 has to produce, and a server too old to know
	// the parameter ignores it.
	if s.bridge.minMargin > 0 {
		query.Set("min_margin", fmt.Sprintf("%d", s.bridge.minMargin))
	}
	if targetPassword != "" {
		query.Set("password", targetPassword)
	}
	wsURL.RawQuery = query.Encode()

	log.Printf("[%s] Connecting to UberSDR at %s", s.userSessionID[:8], wsURL.String())

	headers := http.Header{}
	headers.Set("User-Agent", "UberSDR_RTLTCP/1.0")
	if clientAddr != nil {
		if tcpAddr, ok := clientAddr.(*net.TCPAddr); ok {
			headers.Set("X-Real-IP", tcpAddr.IP.String())
		}
	}

	dialer := websocket.Dialer{
		ReadBufferSize:  32768,
		WriteBufferSize: 4096,
	}
	conn, _, err := dialer.Dial(wsURL.String(), headers)
	if err != nil {
		return fmt.Errorf("WebSocket dial error: %w", err)
	}

	s.mu.Lock()
	s.wsConn = conn
	s.currentURL = targetURL
	// A fresh socket is a fresh stream. A new instance rather than a reset,
	// because the receive goroutine holds no lock while it decodes: it takes
	// the pointer under mu and works on whatever it got, so swapping one in
	// cannot race with a decode already under way on the old one.
	s.pcmDecoder = NewPCMv4StreamDecoder()
	s.mu.Unlock()

	log.Printf("[%s] Connected to UberSDR at %s (%d Hz, %s)", s.userSessionID[:8], targetURL, frequency, mode)
	return nil
}

// tuneUberSDR tunes the current UberSDR connection to a new frequency.
// If the frequency maps to a different UberSDR host (via routing config), the
// existing WebSocket is closed and a new connection is established to the correct host.
func (s *clientSession) tuneUberSDR(frequency int64, mode string) {
	newURL, newPassword := s.bridge.getURLForFrequency(frequency)

	s.mu.RLock()
	currentURL := s.currentURL
	conn := s.wsConn
	s.mu.RUnlock()

	if conn == nil {
		return
	}

	if newURL != currentURL {
		log.Printf("[%s] Frequency %d Hz requires different host: %s → %s", s.userSessionID[:8], frequency, currentURL, newURL)

		allowed, err := s.checkConnection(newURL, newPassword, s.tcpConn.RemoteAddr())
		if err != nil {
			log.Printf("[%s] Connection check error for %s: %v", s.userSessionID[:8], newURL, err)
		}
		if !allowed {
			log.Printf("[%s] Connection to %s not allowed — staying on %s", s.userSessionID[:8], newURL, currentURL)
			// Fall through and tune on the current host anyway
		} else {
			s.mu.Lock()
			if s.wsConn != nil {
				closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Retuning to different host")
				_ = s.wsConn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
				_ = s.wsConn.Close()
				s.wsConn = nil
				s.currentURL = ""
			}
			s.mu.Unlock()

			if err := s.connectToUberSDR(s.tcpConn.RemoteAddr()); err != nil {
				log.Printf("[%s] Failed to connect to new host %s: %v", s.userSessionID[:8], newURL, err)
			}
			return
		}
	}

	s.mu.RLock()
	conn = s.wsConn
	s.mu.RUnlock()
	if conn == nil {
		return
	}

	tuneMsg := map[string]interface{}{
		"type":      "tune",
		"frequency": frequency,
		"mode":      mode,
	}

	s.wsConnMu.Lock()
	err := conn.WriteJSON(tuneMsg)
	s.wsConnMu.Unlock()

	if err != nil {
		log.Printf("[%s] Failed to send tune message: %v", s.userSessionID[:8], err)
	} else {
		log.Printf("[%s] Tuned to %d Hz, %s", s.userSessionID[:8], frequency, mode)
	}
}

// receiveFromUberSDR reads IQ data from UberSDR WebSocket and converts to uint8 pairs
func (s *clientSession) receiveFromUberSDR() {
	log.Printf("[%s] Starting UberSDR receive loop", s.userSessionID[:8])
	defer log.Printf("[%s] UberSDR receive loop exited", s.userSessionID[:8])

	for {
		select {
		case <-s.stopCh:
			return
		case <-s.clientDone:
			return
		default:
		}

		s.mu.RLock()
		conn := s.wsConn
		s.mu.RUnlock()

		if conn == nil {
			return
		}

		if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			return
		}

		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("[%s] UberSDR connection closed normally", s.userSessionID[:8])
			} else {
				log.Printf("[%s] UberSDR read error: %v", s.userSessionID[:8], err)
			}
			s.mu.Lock()
			s.wsConn = nil
			s.mu.Unlock()
			return
		}

		if messageType == websocket.BinaryMessage {
			// A server older than 0.1.63 clamps the requested version to 1-3
			// and answers with version 1 rather than refusing it, so its frames
			// arrive as zstd rather than as an error. Naming that beats a
			// stream of "bad magic" a hundred times a second.
			if isZstdFrame(message) {
				log.Printf("[%s] Server does not support protocol version %d (needs UberSDR 0.1.63 or later)",
					s.userSessionID[:8], pcmProtocolVersion)
				return
			}

			s.mu.RLock()
			dec := s.pcmDecoder
			s.mu.RUnlock()

			pcmData, sampleRate, _, _, _, err := dec.DecodePacketLE(message)
			if err != nil {
				log.Printf("[%s] PCM decode error: %v", s.userSessionID[:8], err)
				continue
			}

			if sampleRate != 0 {
				s.mu.Lock()
				if sampleRate != s.sampleRate {
					log.Printf("[%s] Sample rate updated: %d Hz", s.userSessionID[:8], sampleRate)
					s.sampleRate = sampleRate
				}
				s.mu.Unlock()
			}

			iqBytes := convertPCMToUint8IQ(pcmData)
			if len(iqBytes) == 0 {
				continue
			}

			// Resample using the per-session windowed-sinc resampler if one has
			// been created (i.e. the client has sent SET_SAMPLE_RATE).
			// The resampler is only accessed from this goroutine so no lock needed.
			if s.resampler != nil {
				iqBytes = s.resampler.Resample(iqBytes)
				if len(iqBytes) == 0 {
					continue
				}
			}

			select {
			case s.iqChan <- iqBytes:
			default:
				select {
				case <-s.iqChan:
				default:
				}
				select {
				case s.iqChan <- iqBytes:
				default:
				}
			}
			continue
		}

		// Handle JSON messages
		var msg WebSocketMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "status":
			log.Printf("[%s] UberSDR status — session %s, %d Hz, mode %s",
				s.userSessionID[:8], msg.SessionID, msg.Frequency, msg.Mode)
		case "error":
			log.Printf("[%s] UberSDR error: %s", s.userSessionID[:8], msg.Error)
		case "pong":
			// keepalive response, ignore
		}
	}
}

// convertPCMToUint8IQ converts int16 little-endian stereo PCM to uint8 offset-binary IQ pairs.
//
// Input:  [I_lo I_hi Q_lo Q_hi ...] (int16 LE, interleaved stereo, 4 bytes per sample pair)
// Output: [I_u8 Q_u8 ...] (uint8 offset binary: 127=0, 0=-1.0, 255=+1.0)
//
// The conversion is: uint8 = (int16 >> 8) + 128
func convertPCMToUint8IQ(pcmLE []byte) []byte {
	numSamples := len(pcmLE) / 4 // 2 bytes I + 2 bytes Q per sample
	if numSamples == 0 {
		return nil
	}

	out := make([]byte, numSamples*2)
	for i := 0; i < numSamples; i++ {
		idx := i * 4
		iVal := int16(uint16(pcmLE[idx]) | uint16(pcmLE[idx+1])<<8)
		qVal := int16(uint16(pcmLE[idx+2]) | uint16(pcmLE[idx+3])<<8)

		out[i*2] = uint8((int(iVal) >> 8) + 128)
		out[i*2+1] = uint8((int(qVal) >> 8) + 128)
	}
	return out
}

// sendKeepalive sends periodic ping messages to UberSDR for this session
func (s *clientSession) sendKeepalive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-s.clientDone:
			return
		case <-ticker.C:
			s.mu.RLock()
			conn := s.wsConn
			s.mu.RUnlock()

			if conn == nil {
				return
			}

			msg := map[string]string{"type": "ping"}
			s.wsConnMu.Lock()
			err := conn.WriteJSON(msg)
			s.wsConnMu.Unlock()

			if err != nil {
				log.Printf("[%s] Keepalive error: %v", s.userSessionID[:8], err)
				return
			}
		}
	}
}

// startStreaming connects to UberSDR and launches the IQ receive/forward goroutines.
// Called on the first SET_FREQ command so that no IQ data is generated until the
// client has configured its pipeline and is ready to consume data.
func (s *clientSession) startStreaming() {
	if err := s.connectToUberSDR(s.tcpConn.RemoteAddr()); err != nil {
		log.Printf("[%s] Failed to connect to UberSDR: %v", s.userSessionID[:8], err)
		return
	}

	fd := make(chan struct{})
	s.mu.Lock()
	s.forwardDone = fd
	s.streamingStarted = true
	s.mu.Unlock()

	go s.receiveFromUberSDR()
	go s.sendKeepalive()
	go func() {
		defer close(fd)
		s.forwardIQToClient()
	}()
}

// forwardIQToClient reads from iqChan and writes uint8 IQ pairs to the TCP client.
// It exits when stopCh is closed, clientDone is closed, or a TCP write error occurs.
func (s *clientSession) forwardIQToClient() {
	log.Printf("[%s] Starting IQ forward loop", s.userSessionID[:8])
	defer log.Printf("[%s] IQ forward loop exited", s.userSessionID[:8])

	conn := s.tcpConn

	for {
		select {
		case <-s.stopCh:
			return
		case <-s.clientDone:
			return
		case iqData, ok := <-s.iqChan:
			if !ok {
				return
			}

			for len(iqData) > 0 {
				if err := conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
					return
				}
				n, err := conn.Write(iqData)
				if err != nil {
					log.Printf("[%s] TCP write error: %v", s.userSessionID[:8], err)
					return
				}
				iqData = iqData[n:]
			}
			_ = conn.SetWriteDeadline(time.Time{})
		}
	}
}

// commandLoop reads 5-byte command packets from the rtl_tcp client
func (s *clientSession) commandLoop() {
	log.Printf("[%s] Starting command loop", s.userSessionID[:8])
	defer log.Printf("[%s] Command loop exited", s.userSessionID[:8])

	cmdBuf := make([]byte, 5)
	for {
		if _, err := io.ReadFull(s.tcpConn, cmdBuf); err != nil {
			if err != io.EOF {
				log.Printf("[%s] Command read error: %v", s.userSessionID[:8], err)
			}
			return
		}

		cmd := cmdBuf[0]
		param := binary.BigEndian.Uint32(cmdBuf[1:5])

		s.handleCommand(cmd, param)
	}
}

// handleCommand processes a single rtl_tcp command
func (s *clientSession) handleCommand(cmd uint8, param uint32) {
	switch cmd {
	case 0x01: // SET_FREQ
		freq := int64(param)
		log.Printf("[%s] CMD set_freq %d Hz (%.3f MHz)", s.userSessionID[:8], freq, float64(freq)/1e6)

		if lo, hi := tuningLimits(); freq < lo || freq > hi {
			log.Printf("[%s] WARNING: Frequency %d Hz is outside UberSDR range (%d–%d Hz)",
				s.userSessionID[:8], freq, lo, hi)
		}

		s.mu.Lock()
		s.frequency = freq
		alreadyStreaming := s.streamingStarted
		s.mu.Unlock()

		if !alreadyStreaming {
			s.startStreaming()
		} else {
			go s.tuneUberSDR(freq, IQMode)
		}

	case 0x02: // SET_SAMPLE_RATE
		if param == 0 {
			log.Printf("[%s] CMD set_sample_rate 0 — ignored", s.userSessionID[:8])
			break
		}
		if uint32(IQModeRate) == param {
			log.Printf("[%s] CMD set_sample_rate %d Hz → matches %s exactly, no resampling needed",
				s.userSessionID[:8], param, IQMode)
			// No resampler needed; clear any existing one.
			s.resampler = nil
		} else {
			log.Printf("[%s] CMD set_sample_rate %d Hz → resampling from %s (%d Hz) using windowed-sinc",
				s.userSessionID[:8], param, IQMode, IQModeRate)
			// Create (or replace) the per-session resampler.
			// This is safe: receiveFromUberSDR is the only goroutine that reads
			// s.resampler, and SET_SAMPLE_RATE commands arrive on the command loop
			// goroutine. We use a mutex-free atomic replacement via a local variable
			// written once; the resampler goroutine will pick it up on the next frame.
			s.resampler = NewIQResampler(uint32(IQModeRate), param)
		}
		s.mu.Lock()
		s.requestedRate = param
		s.mu.Unlock()

	case 0x03: // SET_GAIN_MODE
		log.Printf("[%s] CMD set_gain_mode %d (no-op: UberSDR manages gain)", s.userSessionID[:8], param)

	case 0x04: // SET_GAIN
		log.Printf("[%s] CMD set_gain %d (%.1f dB, no-op)", s.userSessionID[:8], param, float64(int32(param))/10.0)

	case 0x05: // SET_FREQ_CORRECTION
		log.Printf("[%s] CMD set_freq_correction %d ppm (no-op)", s.userSessionID[:8], int32(param))

	case 0x06: // SET_IF_TUNER_GAIN
		log.Printf("[%s] CMD set_if_tuner_gain stage=%d gain=%d (no-op)", s.userSessionID[:8], param>>16, int16(param&0xffff))

	case 0x07: // SET_TEST_MODE
		log.Printf("[%s] CMD set_test_mode %d (no-op)", s.userSessionID[:8], param)

	case 0x08: // SET_AGC_MODE
		log.Printf("[%s] CMD set_agc_mode %d (no-op)", s.userSessionID[:8], param)

	case 0x09: // SET_DIRECT_SAMPLING
		log.Printf("[%s] CMD set_direct_sampling %d (no-op)", s.userSessionID[:8], param)

	case 0x0a: // SET_OFFSET_TUNING
		log.Printf("[%s] CMD set_offset_tuning %d (no-op)", s.userSessionID[:8], param)

	case 0x0b: // SET_RTL_XTAL
		log.Printf("[%s] CMD set_rtl_xtal %d (no-op)", s.userSessionID[:8], param)

	case 0x0c: // SET_TUNER_XTAL
		log.Printf("[%s] CMD set_tuner_xtal %d (no-op)", s.userSessionID[:8], param)

	case 0x0d: // SET_GAIN_BY_INDEX
		log.Printf("[%s] CMD set_gain_by_index %d (no-op)", s.userSessionID[:8], param)

	case 0x0e: // SET_BIAS_TEE
		log.Printf("[%s] CMD set_bias_tee %d (no-op)", s.userSessionID[:8], param)

	default:
		log.Printf("[%s] CMD unknown 0x%02x param=%d", s.userSessionID[:8], cmd, param)
	}
}

// handleClient accepts a new TCP connection, creates a clientSession, and runs it.
// If maxClients > 0 and the limit is reached, the connection is rejected immediately.
func (b *RTLTCPBridge) handleClient(conn net.Conn) {
	clientAddr := conn.RemoteAddr()

	// Enforce client limit
	b.sessionsMu.Lock()
	if b.maxClients > 0 && len(b.sessions) >= b.maxClients {
		b.sessionsMu.Unlock()
		log.Printf("Bridge: Rejecting connection from %s — at capacity (%d/%d clients)",
			clientAddr, b.maxClients, b.maxClients)
		_ = conn.Close()
		return
	}

	sess := b.newClientSession(conn)
	b.sessions[sess.userSessionID] = sess
	total := len(b.sessions)
	b.sessionsMu.Unlock()

	log.Printf("Bridge: rtl_tcp client connected from %s [session %s] (%d/%s active)",
		clientAddr, sess.userSessionID[:8], total, maxClientsStr(b.maxClients))

	defer func() {
		_ = conn.Close()

		// Remove session from map
		b.sessionsMu.Lock()
		delete(b.sessions, sess.userSessionID)
		remaining := len(b.sessions)
		b.sessionsMu.Unlock()

		log.Printf("Bridge: rtl_tcp client disconnected from %s [session %s] (%d active)",
			clientAddr, sess.userSessionID[:8], remaining)

	}()

	// Send dongle info header: "RTL0" + tuner_type (BE uint32) + tuner_gain_count (BE uint32)
	var headerBuf [12]byte
	copy(headerBuf[0:4], "RTL0")
	binary.BigEndian.PutUint32(headerBuf[4:8], TunerR820T)
	binary.BigEndian.PutUint32(headerBuf[8:12], R820TGainCount)

	if _, err := conn.Write(headerBuf[:]); err != nil {
		log.Printf("[%s] Failed to send dongle info: %v", sess.userSessionID[:8], err)
		return
	}
	log.Printf("[%s] Sent dongle info to client (R820T, %d gains)", sess.userSessionID[:8], R820TGainCount)

	// Run command loop — blocks until client disconnects
	sess.commandLoop()

	// Signal forwardIQToClient to stop
	select {
	case <-sess.clientDone:
	default:
		close(sess.clientDone)
	}

	// Close UberSDR WebSocket
	sess.mu.Lock()
	if sess.wsConn != nil {
		closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Client disconnected")
		_ = sess.wsConn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
		_ = sess.wsConn.Close()
		sess.wsConn = nil
	}
	sess.mu.Unlock()

	// Wait for forward goroutine to finish (only if streaming was ever started)
	sess.mu.RLock()
	fd := sess.forwardDone
	sess.mu.RUnlock()
	if fd != nil {
		<-fd
	}
}

// What -min-margin may be set to. These are the server's own limits, from
// lossyMinMarginDB and lossyMaxMarginDB in pcm_lossy.go, repeated here so a
// value outside them is refused with a reason at startup rather than silently
// clamped to a different one halfway through a session.
//
// The floor is where the quantisation noise starts to lift the noise floor a
// client can see: 15 dB down adds 0.14 dB to it, under what a receiver's own
// readings resolve, where 6 dB down adds a full 1 dB. Above 60 dB the request
// buys nothing measurable, and a client wanting less than that should leave the
// flag alone and take the lossless stream rather than have one marked lossy and
// shifted by zero.
const (
	MinMarginMinDB = 15.0
	MinMarginMaxDB = 60.0
)

// What -min-margin is when nobody says otherwise, and it is on: 26 dB, the same
// MARGIN_DEFAULT_DB the web client uses, the measured transparent setting where
// every FT8 decode survives with its reported strength intact. It costs about
// 0.01 dB of noise floor for roughly half the bytes on the WebSocket, and this
// bridge carries nothing but IQ -- the one mode reduced depth applies to. The
// margin is also far under what the client ever sees: rtl_tcp is handed 8-bit
// samples, so the depth the server drops is depth this bridge was going to
// throw away anyway. -min-margin 0 asks for the lossless stream instead.
const MinMarginDefaultDB = 26

// parseMinMargin validates the -min-margin flag and returns the whole dB the
// server will be asked for.
//
// Strict on purpose. The server clamps whatever it is sent into its own range
// and rounds it to a whole dB, so a value outside the range would produce a
// working but different stream and nothing downstream would ever say so. Zero
// is the one value accepted outside the range: it is how a command line turns
// the default off and asks for the lossless stream.
func parseMinMargin(v float64) (int, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("%v is not a number of dB", v)
	}
	if v == 0 {
		return 0, nil
	}
	if v < MinMarginMinDB || v > MinMarginMaxDB {
		return 0, fmt.Errorf("%g dB is outside %g-%g; the server would not honour it as asked. "+
			"Pass 0 for a lossless stream", v, MinMarginMinDB, MinMarginMaxDB)
	}
	dB := int(math.Round(v))
	if float64(dB) != v {
		log.Printf("-min-margin: %g dB rounded to %d, which is what the server would have done with it", v, dB)
	}
	return dB, nil
}

// maxClientsStr returns a human-readable representation of the client limit.
func maxClientsStr(n int) string {
	if n == 0 {
		return "unlimited"
	}
	return fmt.Sprintf("%d", n)
}

// Start begins listening for rtl_tcp clients
func (b *RTLTCPBridge) Start() error {
	ln, err := net.Listen("tcp", b.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", b.listenAddr, err)
	}
	b.listener = ln
	log.Printf("Bridge: Listening for rtl_tcp clients on %s (max clients: %s)",
		b.listenAddr, maxClientsStr(b.maxClients))
	log.Printf("Bridge: Configure your SDR software with: rtl_tcp=%s", b.listenAddr)

	go b.acceptLoop()
	return nil
}

// acceptLoop accepts incoming TCP connections
func (b *RTLTCPBridge) acceptLoop() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			select {
			case <-b.stopCh:
				return
			default:
				log.Printf("Bridge: Accept error: %v", err)
				time.Sleep(100 * time.Millisecond)
				continue
			}
		}
		// Each client runs in its own goroutine; no connection displaces another
		go b.handleClient(conn)
	}
}

// Stop shuts down the bridge and all active sessions
func (b *RTLTCPBridge) Stop() {
	log.Println("Bridge: Stopping...")

	b.sessionsMu.Lock()
	b.running = false
	b.sessionsMu.Unlock()

	close(b.stopCh)

	if b.listener != nil {
		_ = b.listener.Close()
	}

	// Close all active TCP connections so their command loops unblock
	b.sessionsMu.Lock()
	for _, sess := range b.sessions {
		_ = sess.tcpConn.Close()
	}
	b.sessionsMu.Unlock()

	log.Println("Bridge: Stopped")
}

// bridgeURL is the instance to ask about the receiver, whether or not a routing table
// was loaded. Mirrors getURLForFrequency's nil check, which every other consumer of
// routingConfig already does.
func bridgeURL(rc *RoutingConfig, flagURL string) string {
	if rc != nil && rc.DefaultURL != "" {
		return rc.DefaultURL
	}
	return flagURL
}

// The receiver's tuning range, as read from /api/description at startup.
//
// Guarded because the fetch runs on the main goroutine before any client is accepted,
// while the warning that reads it runs per-connection — go test -race objects otherwise.
var (
	rangeMu       sync.RWMutex
	liveMinFreqHz int64 = MinFrequencyHz
	liveMaxFreqHz int64 = MaxFrequencyHz
)

func tuningLimits() (int64, int64) {
	rangeMu.RLock()
	defer rangeMu.RUnlock()
	return liveMinFreqHz, liveMaxFreqHz
}

// applyTuningRange adopts what a receiver published, and reports whether it moved.
//
// Each edge falls back on its own — they are independent facts, and a receiver that
// states one must not reset the other. Anything at or below zero is "not said" rather
// than a limit, so a zero, a missing field or a null all leave the default in place. A
// max at or below the min is a misconfigured receiver, not a range, and is refused
// outright rather than adopted inverted.
func applyTuningRange(tr *TuningRange) bool {
	min, max := int64(MinFrequencyHz), int64(MaxFrequencyHz)
	if tr != nil {
		if tr.MinFrequency > 0 {
			min = tr.MinFrequency
		}
		if tr.MaxFrequency > 0 {
			max = tr.MaxFrequency
		}
	}
	if max <= min {
		return false
	}
	rangeMu.Lock()
	defer rangeMu.Unlock()
	changed := min != liveMinFreqHz || max != liveMaxFreqHz
	liveMinFreqHz, liveMaxFreqHz = min, max
	return changed
}

// TuningRange is how much spectrum a receiver covers, from /api/description's
// `tuning_range` object. Every field is optional, including the whole object.
type TuningRange struct {
	MinFrequency int64 `json:"min_frequency"`
	MaxFrequency int64 `json:"max_frequency"`
}

type descriptionResponse struct {
	TuningRange *TuningRange `json:"tuning_range"`
}

// fetchTuningRange asks the receiver how far it tunes.
//
// Failure is not an error: every path out leaves the 10 kHz - 30 MHz default in force,
// which is what this bridge always assumed. A bridge that starts and warns wrongly beats
// one that refuses to start.
func fetchTuningRange(serverURL string) {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return
	}
	scheme := "http"
	if parsed.Scheme == "https" || parsed.Scheme == "wss" {
		scheme = "https"
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("%s://%s/api/description", scheme, parsed.Host))
	if err != nil {
		log.Printf("Could not read the receiver's tuning range (%v); assuming %d Hz - %d Hz",
			err, MinFrequencyHz, MaxFrequencyHz)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("Receiver returned %s for /api/description; assuming %d Hz - %d Hz",
			resp.Status, MinFrequencyHz, MaxFrequencyHz)
		return
	}

	var desc descriptionResponse
	if err := json.NewDecoder(resp.Body).Decode(&desc); err != nil {
		log.Printf("Could not parse /api/description (%v); assuming %d Hz - %d Hz",
			err, MinFrequencyHz, MaxFrequencyHz)
		return
	}
	applyTuningRange(desc.TuningRange)
}

func main() {
	ubersdrURL := flag.String("url", "http://127.0.0.1:8080", "UberSDR server URL (http://, https://, ws://, or wss://)")
	password := flag.String("password", "", "UberSDR server password (optional)")
	listenAddr := flag.String("listen", "0.0.0.0:1234", "Address and port to listen on for rtl_tcp clients")
	configFile := flag.String("config", "", "Frequency routing configuration file (optional, YAML format)")
	initialFreq := flag.Int64("freq", 14200000, "Initial frequency in Hz (default: 14.2 MHz)")
	maxClients := flag.Int("max-clients", DefaultMaxClients, "Maximum simultaneous rtl_tcp clients (0 = unlimited)")
	minMargin := flag.Float64("min-margin", MinMarginDefaultDB, "Reduced-depth IQ: dB of margin under the noise floor (15-60; 0 = lossless)")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "UberSDR to rtl_tcp Bridge\n\n")
		fmt.Fprintf(os.Stderr, "Emulates an rtl_tcp server, allowing software that speaks the rtl_tcp\n")
		fmt.Fprintf(os.Stderr, "protocol (SDR#, GQRX, CubicSDR, GNU Radio, etc.) to use UberSDR as a backend.\n\n")
		fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "UberSDR Connection Options:\n")
		fmt.Fprintf(os.Stderr, "  -url string\n")
		fmt.Fprintf(os.Stderr, "        UberSDR server URL (default \"http://127.0.0.1:8080\")\n")
		fmt.Fprintf(os.Stderr, "        Accepts http://, https://, ws://, or wss://\n")
		fmt.Fprintf(os.Stderr, "  -password string\n")
		fmt.Fprintf(os.Stderr, "        UberSDR server password (optional)\n")
		fmt.Fprintf(os.Stderr, "  -config string\n")
		fmt.Fprintf(os.Stderr, "        Frequency routing configuration file (optional, YAML format)\n\n")
		fmt.Fprintf(os.Stderr, "rtl_tcp Server Options:\n")
		fmt.Fprintf(os.Stderr, "  -listen string\n")
		fmt.Fprintf(os.Stderr, "        Address and port to listen on (default \"0.0.0.0:1234\")\n")
		fmt.Fprintf(os.Stderr, "  -freq int\n")
		fmt.Fprintf(os.Stderr, "        Initial frequency in Hz (default 14200000 = 14.2 MHz)\n")
		fmt.Fprintf(os.Stderr, "  -max-clients int\n")
		fmt.Fprintf(os.Stderr, "        Maximum simultaneous rtl_tcp clients (default %d; 0 = unlimited)\n", DefaultMaxClients)
		fmt.Fprintf(os.Stderr, "        Each client gets an independent UberSDR WebSocket session.\n")
		fmt.Fprintf(os.Stderr, "  -min-margin float\n")
		fmt.Fprintf(os.Stderr, "        Reduced-depth IQ: keep the quantisation floor at least this many dB\n")
		fmt.Fprintf(os.Stderr, "        below the band's own noise floor (%g-%g, default %d; 0 is lossless).\n",
			MinMarginMinDB, MinMarginMaxDB, MinMarginDefaultDB)
		fmt.Fprintf(os.Stderr, "        A margin rather than a bit depth, so one number means the same thing\n")
		fmt.Fprintf(os.Stderr, "        on every band. Saves 15-60%% of the bandwidth depending on the band;\n")
		fmt.Fprintf(os.Stderr, "        needs UberSDR 0.1.64 or later, and older servers ignore it.\n\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  # Connect to UberSDR on local network (default)\n")
		fmt.Fprintf(os.Stderr, "  %s\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Connect to remote UberSDR with password, custom port\n")
		fmt.Fprintf(os.Stderr, "  %s --url https://sdr.example.com --password mypass --listen 0.0.0.0:1234\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Use frequency routing config\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8073 --config routing.yaml\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Allow up to 8 simultaneous clients\n")
		fmt.Fprintf(os.Stderr, "  %s --max-clients 8\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Unlimited clients\n")
		fmt.Fprintf(os.Stderr, "  %s --max-clients 0\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Take the lossless upstream stream instead of the default %d dB margin\n", MinMarginDefaultDB)
		fmt.Fprintf(os.Stderr, "  %s --min-margin 0\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Sample Rate:\n")
		fmt.Fprintf(os.Stderr, "  Always uses iq384 (384 kHz) from UberSDR, so the real signal spans ±192 kHz\n")
		fmt.Fprintf(os.Stderr, "  of the tuned frequency. If the client requests a different rate via\n")
		fmt.Fprintf(os.Stderr, "  SET_SAMPLE_RATE, the bridge resamples with a Kaiser-windowed sinc\n")
		fmt.Fprintf(os.Stderr, "  (~80 dB stopband). Below 384 kHz it decimates, anti-aliased; above it,\n")
		fmt.Fprintf(os.Stderr, "  the extra span carries no signal.\n")
		fmt.Fprintf(os.Stderr, "  Requires a bypassed session: public receivers do not offer iq384.\n\n")
		fmt.Fprintf(os.Stderr, "Frequency Range:\n")
		fmt.Fprintf(os.Stderr, "  Read from the receiver at startup. Assumed %d Hz (%.0f kHz) to\n",
			MinFrequencyHz, float64(MinFrequencyHz)/1000.0)
		fmt.Fprintf(os.Stderr, "  %d Hz (%.0f MHz) when the receiver does not publish one.\n",
			MaxFrequencyHz, float64(MaxFrequencyHz)/1e6)
	}

	flag.Parse()

	marginDB, err := parseMinMargin(*minMargin)
	if err != nil {
		log.Fatalf("-min-margin: %v", err)
	}

	// Validate URL
	parsedURL, err := url.Parse(*ubersdrURL)
	if err != nil {
		log.Fatalf("Invalid URL: %v", err)
	}
	if parsedURL.Scheme != "ws" && parsedURL.Scheme != "wss" &&
		parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		log.Fatalf("Invalid URL scheme: %s (must be http://, https://, ws://, or wss://)", parsedURL.Scheme)
	}

	// Load routing configuration if specified
	var routingConfig *RoutingConfig
	if *configFile != "" {
		data, err := os.ReadFile(*configFile)
		if err != nil {
			log.Fatalf("Failed to read config file %s: %v", *configFile, err)
		}
		routingConfig = &RoutingConfig{}
		if err := yaml.Unmarshal(data, routingConfig); err != nil {
			log.Fatalf("Failed to parse config file %s: %v", *configFile, err)
		}
		// Command-line flags override config file defaults
		if *ubersdrURL != "http://127.0.0.1:8080" {
			routingConfig.DefaultURL = *ubersdrURL
		}
		if *password != "" {
			routingConfig.DefaultPassword = *password
		}
		log.Printf("Loaded routing config with %d frequency ranges", len(routingConfig.FrequencyRanges))
		log.Printf("  Default URL: %s", routingConfig.DefaultURL)
		for i, fr := range routingConfig.FrequencyRanges {
			log.Printf("  Range %d: %s (%.3f-%.3f MHz) -> %s",
				i+1, fr.Name, float64(fr.MinFreq)/1e6, float64(fr.MaxFreq)/1e6, fr.URL)
		}
	}

	// Create bridge
	bridge := NewRTLTCPBridge(*ubersdrURL, *password, *listenAddr, *initialFreq, routingConfig, *maxClients, marginDB)

	// Setup signal handler
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start bridge
	// Ask the receiver how far it tunes, before any client can connect and be warned
	// against the wrong range. Blocking on purpose: it is one 5-second-capped request at
	// startup, and every path through it leaves a usable range behind.
	//
	// From the flag, not routingConfig: routingConfig is nil unless -config was given,
	// which is the common case. It also mirrors what the range is used for — a single
	// global warning threshold. With a routing table the bridge can fan out across
	// several instances with different spans (see getURLForFrequency), and one global
	// range cannot describe all of them; the default instance is the closest honest
	// answer, and being wrong only produces a spurious log line, never a refused tune.
	fetchTuningRange(bridgeURL(routingConfig, *ubersdrURL))

	if err := bridge.Start(); err != nil {
		log.Fatalf("Failed to start bridge: %v", err)
	}

	log.Printf("UberSDR rtl_tcp bridge running")
	log.Printf("  UberSDR server: %s", *ubersdrURL)
	log.Printf("  Listening on:   %s (rtl_tcp protocol)", *listenAddr)
	log.Printf("  Initial freq:   %d Hz (%.3f MHz)", *initialFreq, float64(*initialFreq)/1e6)
	log.Printf("  IQ mode:        %s (%d Hz, windowed-sinc resampling)", IQMode, IQModeRate)
	rangeLo, rangeHi := tuningLimits()
	log.Printf("  Tuning range:   %d Hz - %d Hz (%.3f kHz - %.3f MHz)",
		rangeLo, rangeHi, float64(rangeLo)/1e3, float64(rangeHi)/1e6)
	log.Printf("  Max clients:    %s", maxClientsStr(*maxClients))
	if marginDB == MinMarginDefaultDB {
		log.Printf("  Reduced depth:  %d dB of margin under the noise floor "+
			"(the default; -min-margin 0 for the lossless stream)", marginDB)
	} else if marginDB > 0 {
		log.Printf("  Reduced depth:  %d dB of margin under the noise floor", marginDB)
	} else {
		log.Printf("  Reduced depth:  off (lossless)")
	}
	log.Printf("Press Ctrl+C to stop")

	// Wait for signal
	<-sigChan
	log.Println("\nShutting down...")

	bridge.Stop()
	log.Println("Bridge stopped")
}
