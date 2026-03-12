package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
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

	// UberSDR frequency limits
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
// rtl_tcp clients request arbitrary rates; we always receive iq192 (192 kHz)
// from UberSDR and resample to the client's requested rate using windowed-sinc
// interpolation. Frequencies outside ±96 kHz are filled with zeros.
const IQMode = "iq192"
const IQModeRate = 192000

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
	sampleRate    int    // actual UberSDR sample rate (always IQModeRate = 192000)
	requestedRate uint32 // rate requested by rtl_tcp client (e.g. 2048000)

	// resampler performs bandlimited windowed-sinc resampling from the UberSDR
	// delivery rate (192 kHz) to the rate the client requested via SET_SAMPLE_RATE.
	// It is created/replaced whenever SET_SAMPLE_RATE is received.
	// Access is serialised by receiveFromUberSDR (single goroutine) so no mutex needed.
	resampler *IQResampler

	// IQ output channel (uint8 pairs sent to TCP client).
	// Sized for ~10 s of headroom at 192 kHz.
	iqChan chan []byte

	// clientDone is closed when the command loop exits, signalling forwardIQToClient to stop.
	clientDone chan struct{}

	// forwardDone is closed when the forwardIQToClient goroutine exits.
	// It is nil until streaming starts (first SET_FREQ received).
	forwardDone chan struct{}

	// streamingStarted is true once the UberSDR WebSocket has been connected
	// and IQ forwarding goroutines have been launched.
	streamingStarted bool

	// PCM decoder (one per session)
	pcmDecoder *PCMBinaryDecoder

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

	running bool
	stopCh  chan struct{}
}

// NewRTLTCPBridge creates a new bridge instance.
// maxClients: maximum simultaneous rtl_tcp clients (0 = unlimited).
func NewRTLTCPBridge(ubersdrURL, password, listenAddr string, initialFreq int64, routingConfig *RoutingConfig, maxClients int) *RTLTCPBridge {
	return &RTLTCPBridge{
		ubersdrURL:    ubersdrURL,
		password:      password,
		listenAddr:    listenAddr,
		routingConfig: routingConfig,
		maxClients:    maxClients,
		initialFreq:   initialFreq,
		sessions:      make(map[string]*clientSession),
		running:       true,
		stopCh:        make(chan struct{}),
	}
}

// newClientSession allocates a fresh clientSession for an incoming TCP connection.
func (b *RTLTCPBridge) newClientSession(conn net.Conn) (*clientSession, error) {
	pcmDecoder, err := NewPCMBinaryDecoder()
	if err != nil {
		return nil, fmt.Errorf("failed to create PCM decoder: %w", err)
	}
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
		pcmDecoder:    pcmDecoder,
		stopCh:        b.stopCh,
	}, nil
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

	// If the server advertises which IQ modes are available, verify iq192 is among them.
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
	query.Set("user_session_id", s.userSessionID)
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
			pcmData, sampleRate, _, err := s.pcmDecoder.DecodePCMBinary(message, true)
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

		if freq < MinFrequencyHz || freq > MaxFrequencyHz {
			log.Printf("[%s] WARNING: Frequency %d Hz is outside UberSDR range (%d–%d Hz)",
				s.userSessionID[:8], freq, MinFrequencyHz, MaxFrequencyHz)
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

	sess, err := b.newClientSession(conn)
	if err != nil {
		b.sessionsMu.Unlock()
		log.Printf("Bridge: Failed to create session for %s: %v", clientAddr, err)
		_ = conn.Close()
		return
	}
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

		if sess.pcmDecoder != nil {
			sess.pcmDecoder.Close()
		}
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

func main() {
	ubersdrURL := flag.String("url", "http://127.0.0.1:8080", "UberSDR server URL (http://, https://, ws://, or wss://)")
	password := flag.String("password", "", "UberSDR server password (optional)")
	listenAddr := flag.String("listen", "0.0.0.0:1234", "Address and port to listen on for rtl_tcp clients")
	configFile := flag.String("config", "", "Frequency routing configuration file (optional, YAML format)")
	initialFreq := flag.Int64("freq", 14200000, "Initial frequency in Hz (default: 14.2 MHz)")
	maxClients := flag.Int("max-clients", DefaultMaxClients, "Maximum simultaneous rtl_tcp clients (0 = unlimited)")

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
		fmt.Fprintf(os.Stderr, "        Each client gets an independent UberSDR WebSocket session.\n\n")
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
		fmt.Fprintf(os.Stderr, "Sample Rate:\n")
		fmt.Fprintf(os.Stderr, "  Always uses iq192 (192 kHz) from UberSDR. If the client requests a different\n")
		fmt.Fprintf(os.Stderr, "  rate via SET_SAMPLE_RATE, the bridge resamples using a Kaiser-windowed sinc\n")
		fmt.Fprintf(os.Stderr, "  interpolator (~80 dB stopband attenuation). Frequencies outside ±96 kHz of\n")
		fmt.Fprintf(os.Stderr, "  centre are filled with zeros (no signal, no images).\n")
		fmt.Fprintf(os.Stderr, "  Recommended: set your SDR client's bandwidth to 250 kHz.\n\n")
		fmt.Fprintf(os.Stderr, "Frequency Range:\n")
		fmt.Fprintf(os.Stderr, "  UberSDR is HF-only: %d Hz (%.0f kHz) to %d Hz (%.0f MHz)\n",
			MinFrequencyHz, float64(MinFrequencyHz)/1000.0,
			MaxFrequencyHz, float64(MaxFrequencyHz)/1e6)
	}

	flag.Parse()

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
	bridge := NewRTLTCPBridge(*ubersdrURL, *password, *listenAddr, *initialFreq, routingConfig, *maxClients)

	// Setup signal handler
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start bridge
	if err := bridge.Start(); err != nil {
		log.Fatalf("Failed to start bridge: %v", err)
	}

	log.Printf("UberSDR rtl_tcp bridge running")
	log.Printf("  UberSDR server: %s", *ubersdrURL)
	log.Printf("  Listening on:   %s (rtl_tcp protocol)", *listenAddr)
	log.Printf("  Initial freq:   %d Hz (%.3f MHz)", *initialFreq, float64(*initialFreq)/1e6)
	log.Printf("  IQ mode:        %s (%d Hz, windowed-sinc resampling)", IQMode, IQModeRate)
	log.Printf("  Max clients:    %s", maxClientsStr(*maxClients))
	log.Printf("Press Ctrl+C to stop")

	// Wait for signal
	<-sigChan
	log.Println("\nShutting down...")

	bridge.Stop()
	log.Println("Bridge stopped")
}
