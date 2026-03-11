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

// RTLTCPBridge bridges rtl_tcp clients to UberSDR WebSocket
type RTLTCPBridge struct {
	// UberSDR connection settings
	ubersdrURL    string
	password      string
	routingConfig *RoutingConfig

	// TCP server
	listenAddr string
	listener   net.Listener

	// Current state (single client at a time)
	mu            sync.RWMutex
	wsConn        *websocket.Conn
	wsConnMu      sync.Mutex
	tcpConn       net.Conn
	userSessionID string
	frequency     int64
	sampleRate    int    // actual UberSDR sample rate (always IQModeRate = 192000)
	requestedRate uint32 // rate requested by rtl_tcp client (e.g. 2048000)

	// IQ output channel (uint8 pairs sent to TCP client).
	// Sized for ~1 second of buffering at 192 kHz (each frame ≈ 4096 samples = 8192 bytes;
	// 192000/4096 ≈ 47 frames/s → 512 gives ~10 s headroom before we must drop).
	iqChan chan []byte

	// clientDone is closed when the current TCP client's command loop exits,
	// signalling forwardIQToClient to stop.
	clientDone chan struct{}

	// upsample controls whether received 192 kHz IQ frames are nearest-neighbour
	// upsampled to the rate the client requested via SET_SAMPLE_RATE.
	// When false (default), the raw 192 kHz stream is forwarded unchanged and the
	// client must adapt to the actual rate.
	upsample bool

	// PCM decoder
	pcmDecoder *PCMBinaryDecoder

	running bool
	stopCh  chan struct{}
}

// upsampleIQ repeats each IQ sample pair to match the client's requested rate.
// This is a nearest-neighbour upsample: crude but gives the client the data
// rate it expects, preventing buffer starvation and stuttering.
//
// actualRate:    the rate UberSDR delivers (e.g. 192000)
// requestedRate: the rate the rtl_tcp client asked for (e.g. 2048000)
// input:         uint8 IQ pairs at actualRate
// returns:       uint8 IQ pairs at (approximately) requestedRate
func upsampleIQ(input []byte, actualRate, requestedRate uint32) []byte {
	if requestedRate <= actualRate || actualRate == 0 {
		return input
	}

	numInputSamples := len(input) / 2 // each sample = 1 I byte + 1 Q byte
	if numInputSamples == 0 {
		return input
	}

	// Calculate output size: for each input sample, emit ratio output samples
	// Use integer arithmetic to avoid floating point drift
	// ratio = requestedRate / actualRate (e.g. 2048000/192000 ≈ 10.67)
	// We track position with a fixed-point accumulator to distribute samples evenly
	numOutputSamples := int(uint64(numInputSamples) * uint64(requestedRate) / uint64(actualRate))
	if numOutputSamples == 0 {
		return input
	}

	out := make([]byte, numOutputSamples*2)
	outIdx := 0

	// Fixed-point position tracking: for each output sample, find the nearest input sample
	for outSample := 0; outSample < numOutputSamples; outSample++ {
		// Map output sample index back to input sample index
		inSample := int(uint64(outSample) * uint64(actualRate) / uint64(requestedRate))
		if inSample >= numInputSamples {
			inSample = numInputSamples - 1
		}
		out[outIdx] = input[inSample*2]
		out[outIdx+1] = input[inSample*2+1]
		outIdx += 2
	}

	return out
}

// NewRTLTCPBridge creates a new bridge instance.
// upsample: when true, 192 kHz IQ frames are nearest-neighbour upsampled to the
// rate the client requested via SET_SAMPLE_RATE. When false (default), the raw
// 192 kHz stream is forwarded and the client adapts to the actual rate.
func NewRTLTCPBridge(ubersdrURL, password, listenAddr string, initialFreq int64, routingConfig *RoutingConfig, upsample bool) (*RTLTCPBridge, error) {
	pcmDecoder, err := NewPCMBinaryDecoder()
	if err != nil {
		return nil, fmt.Errorf("failed to create PCM decoder: %w", err)
	}

	return &RTLTCPBridge{
		ubersdrURL:    ubersdrURL,
		password:      password,
		listenAddr:    listenAddr,
		routingConfig: routingConfig,
		userSessionID: uuid.New().String(),
		frequency:     initialFreq,
		sampleRate:    IQModeRate,
		requestedRate: 0, // 0 = not yet set by client; no upsampling until client sends SET_SAMPLE_RATE
		upsample:      upsample,
		iqChan:        make(chan []byte, 512),
		clientDone:    make(chan struct{}),
		pcmDecoder:    pcmDecoder,
		running:       true,
		stopCh:        make(chan struct{}),
	}, nil
}

// IQMode is the only UberSDR IQ mode this bridge uses.
// rtl_tcp clients request arbitrary rates; we always deliver iq192 (192 kHz)
// and upsample to whatever rate the client asked for.
const IQMode = "iq192"
const IQModeRate = 192000

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
func (b *RTLTCPBridge) checkConnection(targetURL, targetPassword string, clientAddr net.Addr) (bool, error) {
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
		UserSessionID: b.userSessionID,
		Password:      targetPassword,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return false, err
	}

	log.Printf("Bridge: Checking connection permission at %s", httpURL)

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
		log.Printf("Bridge: Connection check failed: %v — attempting anyway", err)
		return true, nil
	}
	defer func() { _ = resp.Body.Close() }()

	var respData ConnectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&respData); err != nil {
		return false, err
	}

	if !respData.Allowed {
		log.Printf("Bridge: Connection rejected: %s", respData.Reason)
		return false, nil
	}

	// If the server advertises which IQ modes are available, verify iq192 is among them.
	// An empty AllowedIQModes list means "all modes allowed" (older server or no restriction).
	if len(respData.AllowedIQModes) > 0 {
		hasIQ192 := false
		for _, m := range respData.AllowedIQModes {
			if m == IQMode {
				hasIQ192 = true
				break
			}
		}
		if !hasIQ192 {
			log.Printf("Bridge: Connection rejected: server does not offer %s (available: %v)",
				IQMode, respData.AllowedIQModes)
			return false, nil
		}
		log.Printf("Bridge: Server confirmed %s is available", IQMode)
	}

	log.Printf("Bridge: Connection allowed (client IP: %s, bypassed: %v)", respData.ClientIP, respData.Bypassed)
	return true, nil
}

// connectToUberSDR establishes a WebSocket connection to UberSDR
func (b *RTLTCPBridge) connectToUberSDR(clientAddr net.Addr) error {
	b.mu.Lock()
	frequency := b.frequency
	b.mu.Unlock()
	mode := IQMode

	targetURL, targetPassword := b.getURLForFrequency(frequency)

	allowed, err := b.checkConnection(targetURL, targetPassword, clientAddr)
	if err != nil {
		log.Printf("Bridge: Connection check error: %v", err)
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
	query.Set("user_session_id", b.userSessionID)
	if targetPassword != "" {
		query.Set("password", targetPassword)
	}
	wsURL.RawQuery = query.Encode()

	log.Printf("Bridge: Connecting to UberSDR at %s", wsURL.String())

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

	b.mu.Lock()
	b.wsConn = conn
	b.mu.Unlock()

	log.Printf("Bridge: Connected to UberSDR (%d Hz, %s)", frequency, mode)
	return nil
}

// tuneUberSDR sends a tune message to UberSDR
func (b *RTLTCPBridge) tuneUberSDR(frequency int64, mode string) {
	b.mu.RLock()
	conn := b.wsConn
	b.mu.RUnlock()

	if conn == nil {
		return
	}

	tuneMsg := map[string]interface{}{
		"type":      "tune",
		"frequency": frequency,
		"mode":      mode,
	}

	b.wsConnMu.Lock()
	err := conn.WriteJSON(tuneMsg)
	b.wsConnMu.Unlock()

	if err != nil {
		log.Printf("Bridge: Failed to send tune message: %v", err)
	} else {
		log.Printf("Bridge: Tuned to %d Hz, %s", frequency, mode)
	}
}

// receiveFromUberSDR reads IQ data from UberSDR WebSocket and converts to uint8 pairs
func (b *RTLTCPBridge) receiveFromUberSDR() {
	log.Println("Bridge: Starting UberSDR receive loop")
	defer log.Println("Bridge: UberSDR receive loop exited")

	for {
		b.mu.RLock()
		running := b.running
		conn := b.wsConn
		b.mu.RUnlock()

		if !running || conn == nil {
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
				log.Println("Bridge: UberSDR connection closed normally")
			} else {
				log.Printf("Bridge: UberSDR read error: %v", err)
			}
			b.mu.Lock()
			b.wsConn = nil
			b.mu.Unlock()
			return
		}

		if messageType == websocket.BinaryMessage {
			pcmData, sampleRate, _, err := b.pcmDecoder.DecodePCMBinary(message, true)
			if err != nil {
				log.Printf("Bridge: PCM decode error: %v", err)
				continue
			}

			if sampleRate != 0 {
				b.mu.Lock()
				if sampleRate != b.sampleRate {
					log.Printf("Bridge: Sample rate updated: %d Hz", sampleRate)
					b.sampleRate = sampleRate
				}
				b.mu.Unlock()
			}

			// Convert int16 stereo IQ (little-endian) → uint8 offset binary IQ pairs
			iqBytes := convertPCMToUint8IQ(pcmData)
			if len(iqBytes) == 0 {
				continue
			}

			// Upsample to the client's requested rate to prevent buffer starvation/stuttering.
			// rtl_tcp clients calibrate their internal buffers to the requested rate;
			// if we deliver at 192 kHz but they expect 250 kHz, they drain the buffer
			// faster than we fill it, causing stuttering.
			// requestedRate == 0 means client hasn't sent SET_SAMPLE_RATE yet; skip upsample.
			b.mu.RLock()
			actualRate := uint32(b.sampleRate)
			requestedRate := b.requestedRate
			b.mu.RUnlock()

			if b.upsample && requestedRate > 0 && requestedRate != actualRate && actualRate > 0 {
				iqBytes = upsampleIQ(iqBytes, actualRate, requestedRate)
			}

			// Send to IQ channel. If the channel is full (client is slow or stalled),
			// drain the oldest entry first so we always enqueue the freshest data.
			// This prevents a growing backlog of stale samples that would cause
			// a burst of old data followed by silence — the classic crackle pattern.
			select {
			case b.iqChan <- iqBytes:
				// fast path: channel had room
			default:
				// channel full: evict oldest, then enqueue newest
				select {
				case <-b.iqChan:
				default:
				}
				select {
				case b.iqChan <- iqBytes:
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
			log.Printf("Bridge: UberSDR status — session %s, %d Hz, mode %s",
				msg.SessionID, msg.Frequency, msg.Mode)
		case "error":
			log.Printf("Bridge: UberSDR error: %s", msg.Error)
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
// This maps the top 8 bits of the int16 to the uint8 range with 127 as the zero point.
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

		// Shift right 8 bits (int16 → int8 range) then offset by 128 → uint8
		out[i*2] = uint8((int(iVal) >> 8) + 128)
		out[i*2+1] = uint8((int(qVal) >> 8) + 128)
	}
	return out
}

// sendKeepalive sends periodic ping messages to UberSDR
func (b *RTLTCPBridge) sendKeepalive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-b.stopCh:
			return
		case <-ticker.C:
			b.mu.RLock()
			conn := b.wsConn
			b.mu.RUnlock()

			if conn == nil {
				return
			}

			msg := map[string]string{"type": "ping"}
			b.wsConnMu.Lock()
			err := conn.WriteJSON(msg)
			b.wsConnMu.Unlock()

			if err != nil {
				log.Printf("Bridge: Keepalive error: %v", err)
				return
			}
		}
	}
}

// handleClient handles a single rtl_tcp client connection
func (b *RTLTCPBridge) handleClient(conn net.Conn) {
	defer func() { _ = conn.Close() }()

	clientAddr := conn.RemoteAddr()
	log.Printf("Bridge: rtl_tcp client connected from %s", clientAddr)

	// Store TCP connection reference; close any existing client (one at a time).
	// Also drain any stale IQ data from a previous session and reset per-client state.
	b.mu.Lock()
	if b.tcpConn != nil {
		log.Printf("Bridge: Closing previous client connection")
		_ = b.tcpConn.Close()
	}
	b.tcpConn = conn
	b.requestedRate = 0 // reset so we don't upsample before client sends SET_SAMPLE_RATE
	b.clientDone = make(chan struct{})
	b.mu.Unlock()

	// Drain any stale IQ frames left from the previous client session
	for {
		select {
		case <-b.iqChan:
		default:
			goto drained
		}
	}
drained:

	// Connect to UberSDR
	if err := b.connectToUberSDR(clientAddr); err != nil {
		log.Printf("Bridge: Failed to connect to UberSDR: %v", err)
		return
	}
	defer func() {
		b.mu.Lock()
		if b.wsConn != nil {
			closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Client disconnected")
			_ = b.wsConn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
			_ = b.wsConn.Close()
			b.wsConn = nil
		}
		b.mu.Unlock()
	}()

	// Send dongle info header: "RTL0" + tuner_type (BE uint32) + tuner_gain_count (BE uint32)
	var headerBuf [12]byte
	copy(headerBuf[0:4], "RTL0")
	binary.BigEndian.PutUint32(headerBuf[4:8], TunerR820T)
	binary.BigEndian.PutUint32(headerBuf[8:12], R820TGainCount)

	if _, err := conn.Write(headerBuf[:]); err != nil {
		log.Printf("Bridge: Failed to send dongle info: %v", err)
		return
	}
	log.Printf("Bridge: Sent dongle info to client (R820T, %d gains)", R820TGainCount)

	// Start UberSDR receive goroutine and keepalive
	go b.receiveFromUberSDR()
	go b.sendKeepalive()

	// Start IQ forwarding goroutine (UberSDR → TCP client)
	forwardDone := make(chan struct{})
	go func() {
		defer close(forwardDone)
		b.forwardIQToClient(conn)
	}()

	// Command receive loop (TCP client → bridge) — blocks until client disconnects
	b.commandLoop(conn)

	// Signal forwardIQToClient to stop (it may be blocked on a TCP write)
	b.mu.RLock()
	cd := b.clientDone
	b.mu.RUnlock()
	select {
	case <-cd:
		// already closed
	default:
		close(cd)
	}

	// Wait for forward goroutine to finish
	<-forwardDone

	log.Printf("Bridge: rtl_tcp client disconnected from %s", clientAddr)
}

// forwardIQToClient reads from iqChan and writes uint8 IQ pairs to the TCP client.
// It exits when stopCh is closed, clientDone is closed, or a TCP write error occurs.
func (b *RTLTCPBridge) forwardIQToClient(conn net.Conn) {
	log.Println("Bridge: Starting IQ forward loop")
	defer log.Println("Bridge: IQ forward loop exited")

	// Snapshot clientDone once; it's replaced on each new client connection.
	b.mu.RLock()
	clientDone := b.clientDone
	b.mu.RUnlock()

	for {
		select {
		case <-b.stopCh:
			return
		case <-clientDone:
			return
		case iqData, ok := <-b.iqChan:
			if !ok {
				return
			}

			// Write all IQ data to TCP client with a per-write deadline.
			// If the client can't accept data within 2 s it's considered stalled;
			// we return so the command loop can detect the disconnect.
			for len(iqData) > 0 {
				if err := conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
					return
				}
				n, err := conn.Write(iqData)
				if err != nil {
					log.Printf("Bridge: TCP write error: %v", err)
					return
				}
				iqData = iqData[n:]
			}
			// Clear deadline after successful write
			_ = conn.SetWriteDeadline(time.Time{})
		}
	}
}

// commandLoop reads 5-byte command packets from the rtl_tcp client
func (b *RTLTCPBridge) commandLoop(conn net.Conn) {
	log.Println("Bridge: Starting command loop")
	defer log.Println("Bridge: Command loop exited")

	cmdBuf := make([]byte, 5)
	for {
		// Read exactly 5 bytes (1 cmd + 4 param, big-endian)
		if _, err := io.ReadFull(conn, cmdBuf); err != nil {
			if err != io.EOF {
				log.Printf("Bridge: Command read error: %v", err)
			}
			return
		}

		cmd := cmdBuf[0]
		param := binary.BigEndian.Uint32(cmdBuf[1:5])

		b.handleCommand(cmd, param)
	}
}

// handleCommand processes a single rtl_tcp command
func (b *RTLTCPBridge) handleCommand(cmd uint8, param uint32) {
	switch cmd {
	case 0x01: // SET_FREQ
		freq := int64(param)
		log.Printf("Bridge: CMD set_freq %d Hz (%.3f MHz)", freq, float64(freq)/1e6)

		if freq < MinFrequencyHz || freq > MaxFrequencyHz {
			log.Printf("Bridge: WARNING: Frequency %d Hz is outside UberSDR range (%d–%d Hz)",
				freq, MinFrequencyHz, MaxFrequencyHz)
		}

		b.mu.Lock()
		b.frequency = freq
		b.mu.Unlock()

		go b.tuneUberSDR(freq, IQMode)

	case 0x02: // SET_SAMPLE_RATE
		// We always use iq192 (192 kHz). Store the client's requested rate so
		// upsampleIQ() can expand the 192 kHz stream to match what the client expects.
		log.Printf("Bridge: CMD set_sample_rate %d Hz → always using %s (%d Hz), will upsample",
			param, IQMode, IQModeRate)
		b.mu.Lock()
		b.requestedRate = param
		b.mu.Unlock()

	case 0x03: // SET_GAIN_MODE
		log.Printf("Bridge: CMD set_gain_mode %d (no-op: UberSDR manages gain)", param)

	case 0x04: // SET_GAIN
		log.Printf("Bridge: CMD set_gain %d (%.1f dB, no-op)", param, float64(int32(param))/10.0)

	case 0x05: // SET_FREQ_CORRECTION
		log.Printf("Bridge: CMD set_freq_correction %d ppm (no-op)", int32(param))

	case 0x06: // SET_IF_TUNER_GAIN
		log.Printf("Bridge: CMD set_if_tuner_gain stage=%d gain=%d (no-op)", param>>16, int16(param&0xffff))

	case 0x07: // SET_TEST_MODE
		log.Printf("Bridge: CMD set_test_mode %d (no-op)", param)

	case 0x08: // SET_AGC_MODE
		log.Printf("Bridge: CMD set_agc_mode %d (no-op)", param)

	case 0x09: // SET_DIRECT_SAMPLING
		log.Printf("Bridge: CMD set_direct_sampling %d (no-op)", param)

	case 0x0a: // SET_OFFSET_TUNING
		log.Printf("Bridge: CMD set_offset_tuning %d (no-op)", param)

	case 0x0b: // SET_RTL_XTAL
		log.Printf("Bridge: CMD set_rtl_xtal %d (no-op)", param)

	case 0x0c: // SET_TUNER_XTAL
		log.Printf("Bridge: CMD set_tuner_xtal %d (no-op)", param)

	case 0x0d: // SET_GAIN_BY_INDEX
		log.Printf("Bridge: CMD set_gain_by_index %d (no-op)", param)

	case 0x0e: // SET_BIAS_TEE
		log.Printf("Bridge: CMD set_bias_tee %d (no-op)", param)

	default:
		log.Printf("Bridge: CMD unknown 0x%02x param=%d", cmd, param)
	}
}

// Start begins listening for rtl_tcp clients
func (b *RTLTCPBridge) Start() error {
	ln, err := net.Listen("tcp", b.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", b.listenAddr, err)
	}
	b.listener = ln
	log.Printf("Bridge: Listening for rtl_tcp clients on %s", b.listenAddr)
	log.Printf("Bridge: Configure your SDR software with: rtl_tcp=%s", b.listenAddr)

	go b.acceptLoop()
	return nil
}

// acceptLoop accepts incoming TCP connections (one at a time)
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
		// Handle client in goroutine; new connection displaces old one
		go b.handleClient(conn)
	}
}

// Stop shuts down the bridge
func (b *RTLTCPBridge) Stop() {
	log.Println("Bridge: Stopping...")

	b.mu.Lock()
	b.running = false
	b.mu.Unlock()

	close(b.stopCh)

	if b.listener != nil {
		_ = b.listener.Close()
	}

	b.mu.Lock()
	if b.wsConn != nil {
		closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Bridge stopping")
		_ = b.wsConn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
		_ = b.wsConn.Close()
		b.wsConn = nil
	}
	if b.tcpConn != nil {
		_ = b.tcpConn.Close()
		b.tcpConn = nil
	}
	b.mu.Unlock()

	if b.pcmDecoder != nil {
		b.pcmDecoder.Close()
	}

	log.Println("Bridge: Stopped")
}

func main() {
	ubersdrURL := flag.String("url", "http://127.0.0.1:8080", "UberSDR server URL (http://, https://, ws://, or wss://)")
	password := flag.String("password", "", "UberSDR server password (optional)")
	listenAddr := flag.String("listen", "0.0.0.0:1234", "Address and port to listen on for rtl_tcp clients")
	configFile := flag.String("config", "", "Frequency routing configuration file (optional, YAML format)")
	initialFreq := flag.Int64("freq", 14200000, "Initial frequency in Hz (default: 14.2 MHz)")
	upsampleFlag := flag.Bool("upsample", true, "Upsample 192 kHz IQ to client's requested rate (nearest-neighbour; required for clients like SDR Console that don't adapt to actual rate)")

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
		fmt.Fprintf(os.Stderr, "        Initial frequency in Hz (default 14200000 = 14.2 MHz)\n\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  # Connect to UberSDR on local network (default)\n")
		fmt.Fprintf(os.Stderr, "  %s\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Connect to remote UberSDR with password, custom port\n")
		fmt.Fprintf(os.Stderr, "  %s --url https://sdr.example.com --password mypass --listen 0.0.0.0:1234\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Use frequency routing config\n")
		fmt.Fprintf(os.Stderr, "  %s --url http://localhost:8073 --config routing.yaml\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  -upsample (default: true)\n")
		fmt.Fprintf(os.Stderr, "        Upsample 192 kHz IQ to the rate the client requests via SET_SAMPLE_RATE.\n")
		fmt.Fprintf(os.Stderr, "        Required for clients like SDR Console that don't adapt to the actual\n")
		fmt.Fprintf(os.Stderr, "        delivered rate. Nearest-neighbour upsampling; signals within ±96 kHz\n")
		fmt.Fprintf(os.Stderr, "        of centre are valid. Use -upsample=false for clients that auto-adapt\n")
		fmt.Fprintf(os.Stderr, "        (e.g. GQRX) to avoid spectral images outside ±96 kHz.\n\n")
		fmt.Fprintf(os.Stderr, "Sample Rate:\n")
		fmt.Fprintf(os.Stderr, "  Always uses iq192 (192 kHz). The client's SET_SAMPLE_RATE command is\n")
		fmt.Fprintf(os.Stderr, "  recorded but does not change the UberSDR mode.\n\n")
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
	bridge, err := NewRTLTCPBridge(*ubersdrURL, *password, *listenAddr, *initialFreq, routingConfig, *upsampleFlag)
	if err != nil {
		log.Fatalf("Failed to create bridge: %v", err)
	}

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
	log.Printf("  IQ mode:        %s (%d Hz)", IQMode, IQModeRate)
	log.Printf("  Upsample:       %v", *upsampleFlag)
	log.Printf("Press Ctrl+C to stop")

	// Wait for signal
	<-sigChan
	log.Println("\nShutting down...")

	bridge.Stop()
	log.Println("Bridge stopped")
}
