package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"html"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type websdrChseq struct {
	mu      sync.Mutex
	current int
}

func newWebSDRChseq() *websdrChseq { return &websdrChseq{current: 3} }

func (c *websdrChseq) bump() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.current += 2
	return c.current
}

func (c *websdrChseq) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current
}

const websdrChatSlots = 20

type websdrChatMsg struct {
	text  string
	chseq int
}

type websdrChatStore struct {
	mu   sync.Mutex
	msgs [websdrChatSlots]websdrChatMsg
	head int
	last time.Time
}

func (cs *websdrChatStore) add(name, text string, seq int) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	now := time.Now().UTC()
	var formatted string
	if now.Sub(cs.last) > 6*time.Hour || now.Day() != cs.last.Day() {
		formatted = fmt.Sprintf("%02d%02d %02d%02dz %s: %s\n",
			now.Day(), int(now.Month()), now.Hour(), now.Minute(), name, text)
	} else {
		formatted = fmt.Sprintf("%02d%02dz %s: %s\n",
			now.Hour(), now.Minute(), name, text)
	}
	cs.last = now
	cs.msgs[cs.head] = websdrChatMsg{text: formatted, chseq: seq}
	cs.head = (cs.head + 1) % websdrChatSlots
}

func (cs *websdrChatStore) since(clientChseq int) []string {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	var out []string
	for i := 0; i < websdrChatSlots; i++ {
		m := cs.msgs[i]
		if m.text != "" && m.chseq > clientChseq {
			out = append(out, m.text)
		}
	}
	return out
}

func (cs *websdrChatStore) all() []string {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	var out []string
	for i := 0; i < websdrChatSlots; i++ {
		idx := (cs.head + i) % websdrChatSlots
		if cs.msgs[idx].text != "" {
			out = append(out, cs.msgs[idx].text)
		}
	}
	return out
}

// websdrUserEntry tracks per-user state for uu_chseq incremental updates (FEAT-11).
type websdrUserEntry struct {
	sessionID string
	username  string
	clientIP  string
	tuneKHz   float64
	band      int
	uuChseq   int
}

// WebSDRHandler handles all WebSDR protocol connections on the dedicated port.
type WebSDRHandler struct {
	sessions          *SessionManager
	audioReceiver     *AudioReceiver
	config            *Config
	ipBanManager      *IPBanManager
	noiseFloorMonitor *NoiseFloorMonitor

	chseq        *websdrChseq
	chat         *websdrChatStore
	configSerial int32

	histogram    [24]int32
	histogramMu  sync.Mutex
	histLastHour int

	audioUserCount int32

	// Throughput counters for the stats display (WebSDR-specific).
	// Incremented atomically; swapped to 0 on each /~~othersjj poll.
	statAudioBytes int64
	statWFBytes    int64
	statHTTPBytes  int64
	statLastReset  int64 // Unix nanoseconds of last swap

	users   map[string]*websdrUserEntry
	usersMu sync.RWMutex

	sysopMaxUsers int
	sysopSkipMute int
	wfTextRows    [][]byte
	wfTextMu      sync.Mutex

	trustLocalhost bool
	trustLocalNet  bool
	trustIPs       []string
}

func NewWebSDRHandler(
	sessions *SessionManager,
	audioReceiver *AudioReceiver,
	config *Config,
	ipBanManager *IPBanManager,
	noiseFloorMonitor *NoiseFloorMonitor,
) *WebSDRHandler {
	h := &WebSDRHandler{
		sessions:          sessions,
		audioReceiver:     audioReceiver,
		config:            config,
		ipBanManager:      ipBanManager,
		noiseFloorMonitor: noiseFloorMonitor,
		chseq:             newWebSDRChseq(),
		chat:              &websdrChatStore{},
		configSerial:      int32(time.Now().Unix()),
		users:             make(map[string]*websdrUserEntry),
		trustLocalhost:    true,
		statLastReset:     time.Now().UnixNano(),
	}
	go h.histogramLoop()
	return h
}

func (h *WebSDRHandler) histogramLoop() {
	for {
		now := time.Now()
		hour := now.Hour()
		h.histogramMu.Lock()
		if hour != h.histLastHour {
			h.histLastHour = hour
			atomic.StoreInt32(&h.histogram[hour], atomic.LoadInt32(&h.audioUserCount))
		}
		h.histogramMu.Unlock()
		time.Sleep(time.Minute)
	}
}

func (h *WebSDRHandler) registerUser(entry *websdrUserEntry) {
	h.usersMu.Lock()
	h.users[entry.sessionID] = entry
	h.usersMu.Unlock()
}

func (h *WebSDRHandler) unregisterUser(sessionID string) {
	h.usersMu.Lock()
	delete(h.users, sessionID)
	h.usersMu.Unlock()
}

func (h *WebSDRHandler) getUsers() []*websdrUserEntry {
	h.usersMu.RLock()
	defer h.usersMu.RUnlock()
	out := make([]*websdrUserEntry, 0, len(h.users))
	for _, u := range h.users {
		cp := *u
		out = append(out, &cp)
	}
	return out
}

func (h *WebSDRHandler) isTrustedIP(ip string) bool {
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	if h.trustLocalhost && (ip == "127.0.0.1" || ip == "::1") {
		return true
	}
	if h.trustLocalNet {
		if strings.HasPrefix(ip, "10.") || strings.HasPrefix(ip, "192.168.") {
			return true
		}
		if strings.HasPrefix(ip, "172.") {
			parts := strings.Split(ip, ".")
			if len(parts) >= 2 {
				second, _ := strconv.Atoi(parts[1])
				if second >= 16 && second <= 31 {
					return true
				}
			}
		}
	}
	for _, trusted := range h.trustIPs {
		if ip == trusted {
			return true
		}
	}
	return false
}

// findStaticFile searches public2_dir then public_dir for a file (FEAT-10).
func (h *WebSDRHandler) findStaticFile(name string) string {
	dirs := []string{}
	if h.config.Server.WebSDRStaticDir2 != "" {
		dirs = append(dirs, h.config.Server.WebSDRStaticDir2)
	}
	staticDir := h.config.Server.WebSDRStaticDir
	if staticDir == "" {
		staticDir = "websdr"
	}
	dirs = append(dirs, staticDir)
	for _, d := range dirs {
		p := filepath.Join(d, name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// countingResponseWriter wraps http.ResponseWriter to count bytes written.
// It also implements http.Hijacker (required by the WebSocket upgrader) and
// http.Flusher by delegating to the underlying writer when available.
type countingResponseWriter struct {
	http.ResponseWriter
	counter *int64
}

func (c *countingResponseWriter) Write(b []byte) (int, error) {
	n, err := c.ResponseWriter.Write(b)
	if n > 0 {
		atomic.AddInt64(c.counter, int64(n))
	}
	return n, err
}

// Hijack implements http.Hijacker so that the WebSocket upgrader can take
// over the underlying TCP connection.
func (c *countingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := c.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("countingResponseWriter: underlying ResponseWriter does not implement http.Hijacker")
}

// Flush implements http.Flusher.
func (c *countingResponseWriter) Flush() {
	if fl, ok := c.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

func (h *WebSDRHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// Wrap the response writer to count HTTP bytes for the stats display.
	cw := &countingResponseWriter{ResponseWriter: w, counter: &h.statHTTPBytes}
	w = cw

	if isWebSocketUpgrade(r) {
		switch {
		case path == "/~~stream" || strings.HasPrefix(path, "/~~stream?"):
			h.handleAudioStream(w, r)
		case strings.HasPrefix(path, "/~~waterstream"):
			h.handleWaterfallStream(w, r)
		default:
			http.Error(w, "unknown websocket path", http.StatusNotFound)
		}
		return
	}

	switch {
	case path == "/" || path == "/index.html":
		h.handleIndexHTML(w, r)
	case path == "/~~orgstatus":
		h.handleOrgStatus(w, r)
	case path == "/~~othersj":
		h.handleOthersJ(w, r)
	case path == "/~~othersjj":
		h.handleOthersJJ(w, r)
	case path == "/~~chat":
		h.handleChat(w, r)
	case path == "/~~fetchdx":
		h.handleFetchDX(w, r)
	case path == "/~~histogram":
		h.handleHistogram(w, r)
	case path == "/~~otherstable":
		h.handleOthersTable(w, r)
	case path == "/~~status":
		h.handleStatus(w, r)
	case path == "/~~logbook":
		h.handleLogbook(w, r)
	case path == "/~~waterfalltext":
		h.handleSysopWaterfallText(w, r)
	case path == "/~~configreload":
		h.handleSysopConfigReload(w, r)
	case path == "/~~setconfig":
		h.handleSysopSetConfig(w, r)
	case path == "/~~setdir":
		h.handleSysopSetDir(w, r)
	case path == "/~~chatcensor":
		h.handleSysopChatCensor(w, r)
	case path == "/~~blockmee":
		h.handleSysopBlockMee(w, r)
	// Dynamic bootstrap JS consumed by websdr-base.js on every page load
	case path == "/tmp/bandinfo.js":
		h.handleBandInfoJS(w, r)
	// Dynamically generated frequency-scale PNG tiles (replaces scaleblack.png placeholder)
	case strings.HasPrefix(path, "/~~scale"):
		h.handleScalePNG(w, r)
	default:
		h.serveStaticFile(w, r)
	}
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

var websdrUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type websdrConn struct {
	conn        *websocket.Conn
	writeMu     sync.Mutex
	handler     *WebSDRHandler
	clientIP    string
	session     *Session
	sessionID   string
	userEntry   *websdrUserEntry
	statCounter *int64 // points to handler.statAudioBytes or statWFBytes

	tuneKHz   float64
	loKHz     float64
	hiKHz     float64
	mode      int
	squelch   int
	autonotch int
	mute      int
	agcMode   int
	gainDB    float64
	ppm       float64
	ppml      float64
	username  string
	band      int

	wfBand   int
	wfZoom   int
	wfStart  int
	wfWidth  int
	wfSlow   int
	wfScale  int
	wfFormat int

	opusEncoder       *OpusEncoderWrapper
	wfState           *WebSDRWaterfallState
	pendingInitFrame1 []byte // init frame 1 queued by applyWaterparamCommand, drained by streamWaterfall
	pendingInitFrame2 []byte // init frame 2 queued by applyWaterparamCommand, drained by streamWaterfall

	lastActivity time.Time

	mu sync.RWMutex
}

func newWebSDRConn(conn *websocket.Conn, handler *WebSDRHandler, clientIP string) *websdrConn {
	return &websdrConn{
		conn:         conn,
		handler:      handler,
		clientIP:     clientIP,
		tuneKHz:      14175.0,
		loKHz:        -3.0,
		hiKHz:        -0.3,
		mode:         0,
		agcMode:      1,
		gainDB:       120,
		wfWidth:      1024,
		wfSlow:       4,
		wfFormat:     9,
		wfState:      NewWebSDRWaterfallState(9),
		lastActivity: time.Now(),
	}
}

func (c *websdrConn) sendBinary(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := c.conn.WriteMessage(websocket.BinaryMessage, data)
	if err == nil && c.statCounter != nil {
		atomic.AddInt64(c.statCounter, int64(len(data)))
	}
	return err
}

func (h *WebSDRHandler) handleAudioStream(w http.ResponseWriter, r *http.Request) {
	clientIP := getClientIP(r)
	if h.ipBanManager.IsBanned(clientIP) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := websdrUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSDR: audio upgrade error: %v", err)
		return
	}

	q := r.URL.Query()

	c := newWebSDRConn(conn, h, clientIP)
	c.statCounter = &h.statAudioBytes

	// Parse mute= and band= from initial URL query
	if v := q.Get("mute"); v != "" {
		c.mute, _ = strconv.Atoi(v)
	}
	if v := q.Get("band"); v != "" {
		c.band, _ = strconv.Atoi(v)
	}

	atomic.AddInt32(&h.audioUserCount, 1)
	defer atomic.AddInt32(&h.audioUserCount, -1)

	// Use timestamp (seconds) + IP as the userSessionID so that audio and
	// waterfall WebSocket connections from the same page load share the same
	// UUID (they connect within the same second), while a new tab opened later
	// gets a different timestamp → different UUID → independent sessions.
	// This mirrors the KiwiSDR emulation's "kiwi-<timestamp>-<IP>" scheme.
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	userSessionID := fmt.Sprintf("websdr-%s-%s", timestamp, clientIP)
	c.sessionID = userSessionID
	h.sessions.SetUserAgent(userSessionID, "WebSDR Client")

	// Register user entry
	entry := &websdrUserEntry{
		sessionID: userSessionID,
		clientIP:  clientIP,
		tuneKHz:   c.tuneKHz,
		band:      c.band,
	}
	c.userEntry = entry
	h.registerUser(entry)
	defer h.unregisterUser(userSessionID)

	freqHz := uint64(c.tuneKHz * 1000)
	session, err := h.sessions.CreateSessionWithBandwidthAndPassword(
		freqHz, "usb", 3000, clientIP, clientIP, userSessionID, "")
	if err != nil {
		log.Printf("WebSDR: failed to create audio session: %v", err)
		conn.Close()
		return
	}
	c.session = session
	h.audioReceiver.GetChannelAudio(session)

	// Initialise Opus encoder using the same config as the main WebSocket handler.
	bitrate := h.config.Audio.Opus.Bitrate
	if bitrate == 0 {
		bitrate = 24000
	}
	complexity := h.config.Audio.Opus.Complexity
	if complexity == 0 {
		complexity = 5
	}
	opusEnc, encErr := NewOpusEncoderForClient(session.SampleRate, bitrate, complexity)
	if encErr != nil {
		log.Printf("WebSDR: failed to create Opus encoder: %v", encErr)
		conn.Close()
		_ = h.sessions.DestroySession(session.ID)
		return
	}
	c.opusEncoder = opusEnc

	defer func() {
		h.audioReceiver.ReleaseChannelAudio(session)
		_ = h.sessions.DestroySession(session.ID)
		conn.Close()
	}()

	done := make(chan struct{})
	go c.readAudioCommands(done)
	c.streamOpusAudio(done)
}

func (c *websdrConn) readAudioCommands(done chan struct{}) {
	defer close(done)
	idleTimeout := time.Duration(c.handler.config.Server.WebSDRIdleTimeout) * time.Second
	for {
		// FEAT-12: set read deadline for idle timeout
		if idleTimeout > 0 {
			_ = c.conn.SetReadDeadline(time.Now().Add(idleTimeout))
		}
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		c.mu.Lock()
		c.lastActivity = time.Now()
		c.mu.Unlock()

		text := strings.TrimSpace(string(msg))
		text = strings.TrimPrefix(text, "GET ")
		if strings.HasPrefix(text, "/~~param") {
			c.applyParamCommand(text)
		} else if strings.HasPrefix(text, "/~~waterparam") {
			c.applyWaterparamCommand(text)
		}
	}
}

func (c *websdrConn) applyParamCommand(text string) {
	idx := strings.Index(text, "?")
	if idx < 0 {
		return
	}
	vals, err := url.ParseQuery(text[idx+1:])
	if err != nil {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	changed := false

	if v := vals.Get("f"); v != "" {
		newFreq, _ := strconv.ParseFloat(v, 64)
		// Clamp to valid HF range: 10 kHz – 30 MHz
		if newFreq < 10.0 {
			newFreq = 10.0
		} else if newFreq > 30000.0 {
			newFreq = 30000.0
		}
		if newFreq != c.tuneKHz {
			c.tuneKHz = newFreq
			changed = true
		}
	}
	// Parse mode first so the lo/hi Nyquist clamp below uses the correct limit.
	// Only accept known mode integers: 0=SSB/CW, 1=AM, 2=SAM, 4=FM.
	if v := vals.Get("mode"); v != "" {
		m, _ := strconv.Atoi(v)
		switch m {
		case 0, 1, 2, 4:
			c.mode = m
			// unknown values are silently ignored; c.mode retains its previous value
		}
	}
	if v := vals.Get("lo"); v != "" {
		c.loKHz, _ = strconv.ParseFloat(v, 64)
	}
	if v := vals.Get("hi"); v != "" {
		c.hiKHz, _ = strconv.ParseFloat(v, 64)
	}

	// Clamp lo/hi to the Nyquist limit of the audio path.
	// FM uses 24 kHz sample rate (Nyquist = 12 kHz); all other modes use
	// 12 kHz sample rate (Nyquist = 6 kHz).  lo must be ≤ 0, hi must be ≥ 0.
	{
		maxBWKHz := 6.0  // SSB / CW / AM
		if c.mode == 4 { // FM
			maxBWKHz = 12.0
		}
		if c.loKHz < -maxBWKHz {
			c.loKHz = -maxBWKHz
		}
		if c.loKHz > 0 {
			c.loKHz = 0
		}
		if c.hiKHz > maxBWKHz {
			c.hiKHz = maxBWKHz
		}
		if c.hiKHz < 0 {
			c.hiKHz = 0
		}
	}
	if v := vals.Get("squelch"); v != "" {
		c.squelch, _ = strconv.Atoi(v)
	}
	if v := vals.Get("mute"); v != "" {
		c.mute, _ = strconv.Atoi(v)
	}
	if v := vals.Get("gain"); v != "" {
		g, _ := strconv.ParseFloat(v, 64)
		if g >= 9999 {
			c.agcMode = 1
		} else {
			c.agcMode = 0
			c.gainDB = g
		}
	}
	if v := vals.Get("name"); v != "" {
		decoded, _ := url.QueryUnescape(v)
		var nb strings.Builder
		count := 0
		for _, r := range decoded {
			if r >= 0x20 && count < 31 {
				nb.WriteRune(r)
				count++
			}
		}
		// HTML-escape so that usernames injected into innerHTML by douu() cannot
		// carry XSS payloads (e.g. <script> tags).
		newName := html.EscapeString(nb.String())
		if newName != c.username {
			c.username = newName
			changed = true
		}
	}
	// FEAT-14: ppm, ppml, autonotch, band
	if v := vals.Get("ppm"); v != "" {
		c.ppm, _ = strconv.ParseFloat(v, 64)
	}
	if v := vals.Get("ppml"); v != "" {
		c.ppml, _ = strconv.ParseFloat(v, 64)
	}
	if v := vals.Get("autonotch"); v != "" {
		c.autonotch, _ = strconv.Atoi(v)
	}
	if v := vals.Get("band"); v != "" {
		newBand, _ := strconv.Atoi(v)
		if newBand != c.band {
			c.band = newBand
			changed = true
		}
	}

	// FEAT-11: bump uu_chseq if position/name/band changed
	if changed && c.userEntry != nil {
		seq := c.handler.chseq.bump()
		c.userEntry.uuChseq = seq
		c.userEntry.tuneKHz = c.tuneKHz
		c.userEntry.username = c.username
		c.userEntry.band = c.band
	}

	if c.session != nil {
		freqHz := uint64(c.tuneKHz * 1000)
		modeStr := websdrModeString(c.mode, c.loKHz, c.hiKHz)
		loHz := int(c.loKHz * 1000)
		hiHz := int(c.hiKHz * 1000)
		_ = c.handler.sessions.UpdateSessionWithEdges(c.session.ID, freqHz, modeStr, loHz, hiHz, true)
	}
}

func (c *websdrConn) applyWaterparamCommand(text string) {
	idx := strings.Index(text, "?")
	if idx < 0 {
		return
	}
	vals, err := url.ParseQuery(text[idx+1:])
	if err != nil {
		return
	}

	c.mu.Lock()

	reset := false
	if v := vals.Get("band"); v != "" {
		n, _ := strconv.Atoi(v)
		if n != c.wfBand {
			c.wfBand = n
			reset = true
		}
	}
	if v := vals.Get("zoom"); v != "" {
		n, _ := strconv.Atoi(v)
		if n != c.wfZoom {
			c.wfZoom = n
			reset = true
		}
	}
	if v := vals.Get("start"); v != "" {
		// The JS sends start as a float (e.g. "122676.085") due to floating-point
		// arithmetic in the zoom calculation.  strconv.Atoi would return 0 for
		// any non-integer string, so we parse as float64 and round to int.
		f, err := strconv.ParseFloat(v, 64)
		if err == nil {
			n := int(math.Round(f))
			if n != 0x80000001 && n != c.wfStart {
				c.wfStart = n
				reset = true
			}
		}
	}
	if v := vals.Get("width"); v != "" {
		n, _ := strconv.Atoi(v)
		if n >= 1 && n <= 1024 && n != c.wfWidth {
			c.wfWidth = n
			reset = true
		}
	}
	if v := vals.Get("speed"); v != "" {
		n, _ := strconv.Atoi(v)
		if n > 0 {
			slow := 4 / n
			if slow < 1 {
				slow = 1
			}
			c.wfSlow = slow
		}
	}
	if v := vals.Get("slow"); v != "" {
		n, _ := strconv.Atoi(v)
		if n > 0 {
			c.wfSlow = n
		}
	}
	if v := vals.Get("scale"); v != "" {
		c.wfScale, _ = strconv.Atoi(v)
	}

	if !reset {
		c.mu.Unlock()
		return
	}

	if c.wfState != nil {
		c.wfState.Reset()
	}

	// Compute spectrum session parameters and pending init frames under the
	// lock, then release the lock before calling UpdateSpectrumSession.
	// UpdateSpectrumSession makes network calls to radiod which can block;
	// holding c.mu during those calls would deadlock streamWaterfall (which
	// needs c.mu to drain SpectrumChan, and radiod blocks waiting for that
	// drain before it can respond to the update).
	//
	// The hardcoded HF band is 10 kHz–30 MHz (bandwidth = 29990 kHz).
	// maxZoom is 8 (matching handleBandInfoJS), giving a maxzoom grid of
	// 1024 × 2^8 = 262144 pixels spanning the full band.
	//
	// Radiod requires binBW ≥ ~500 Hz for 1024 bins (empirically: 114 Hz fails).
	// To allow deep zoom without violating this constraint, we halve binCount for
	// each zoom level beyond 5, keeping binBW ≈ 915 Hz constant:
	//   zoom 0–5: binCount=1024, binBW = bandBW/2^z/1024
	//   zoom 6:   binCount=512,  binBW = bandBW/64/512  ≈ 915 Hz
	//   zoom 7:   binCount=256,  binBW = bandBW/128/256 ≈ 915 Hz
	//   zoom 8:   binCount=128,  binBW = bandBW/256/128 ≈ 915 Hz
	// spectrumToPixels() upsamples binCount→wfWidth pixels (nearest-neighbour),
	// so the client always receives wfWidth=1024 pixels per row.
	//
	// The `start` value sent by the client is a pixel offset in the
	// maxzoom grid (NOT in the current-zoom pixel grid).  To convert:
	//   startOffsetHz = start * bandBWHz / (1024 * 2^maxZoom)
	//
	// At zoom level z, the visible bandwidth is bandBW / 2^z.
	// Center = visibleStart + visibleBW/2
	// binBandwidth = visibleBW / binCount
	const bandStartHz = 10000.0  // 10 kHz
	const bandEndHz = 30000000.0 // 30 MHz
	const bandBWHz = bandEndHz - bandStartHz
	const maxZoom = 8
	const maxZoomPixels = 1024 * (1 << maxZoom) // 262144
	const minBinBWHz = 500.0                    // radiod minimum bin bandwidth (Hz)

	zoom := c.wfZoom
	if zoom < 0 {
		zoom = 0
	}
	if zoom > maxZoom {
		zoom = maxZoom
	}
	zoomFactor := float64(int(1) << uint(zoom)) // 2^zoom
	visibleBWHz := bandBWHz / zoomFactor

	wfWidth := c.wfWidth
	if wfWidth < 1 {
		wfWidth = 1024
	}

	// Compute adaptive binCount: halve for each zoom level beyond 5 to keep
	// binBW ≥ minBinBWHz.  spectrumToPixels() upsamples binCount→wfWidth pixels.
	binCount := wfWidth
	for binCount > 1 && visibleBWHz/float64(binCount) < minBinBWHz {
		binCount /= 2
	}
	if binCount < 1 {
		binCount = 1
	}

	// start is in maxzoom-grid pixels from the band left edge
	startOffsetHz := float64(c.wfStart) * bandBWHz / float64(maxZoomPixels)
	visibleStartHz := bandStartHz + startOffsetHz
	centerHz := visibleStartHz + visibleBWHz/2.0
	binBandwidthHz := visibleBWHz / float64(binCount)

	sessionID := ""
	if c.session != nil {
		sessionID = c.session.ID
	}

	// Queue init frames for streamWaterfall to send before the next data row.
	frame1, frame2 := WebSDRWaterfallInitFrames(zoom, c.wfStart, wfWidth)
	c.pendingInitFrame1 = frame1
	c.pendingInitFrame2 = frame2

	c.mu.Unlock()

	// Call UpdateSpectrumSession outside the lock to avoid deadlock with
	// streamWaterfall (which holds c.mu while draining SpectrumChan).
	if sessionID != "" {
		if err := c.handler.sessions.UpdateSpectrumSession(
			sessionID,
			uint64(centerHz),
			binBandwidthHz,
			binCount,
		); err != nil {
			log.Printf("WebSDR waterparam: UpdateSpectrumSession error: %v", err)
		}
	}
}

func websdrModeString(mode int, loKHz, hiKHz float64) string {
	switch mode {
	case 1:
		return "am"
	case 2:
		return "sam"
	case 4:
		return "fm"
	default:
		if loKHz < 0 && hiKHz <= 0 {
			return "lsb"
		}
		return "usb"
	}
}

// streamOpusAudio streams audio to the client using the UberSDR Opus binary format.
// Wire format (Version 2, identical to the main WebSocket handler):
//
//	[timestamp:8 LE uint64][sampleRate:4 LE uint32][channels:1]
//	[basebandPower:4 LE float32][noiseDensity:4 LE float32][opusData...]
func (c *websdrConn) streamOpusAudio(done <-chan struct{}) {
	// Cache Opus config so we can recreate the encoder if sample rate changes
	// (e.g. when the user switches mode and radiod changes the output sample rate).
	bitrate := c.handler.config.Audio.Opus.Bitrate
	if bitrate == 0 {
		bitrate = 24000
	}
	complexity := c.handler.config.Audio.Opus.Complexity
	if complexity == 0 {
		complexity = 5
	}
	encoderSampleRate := c.session.SampleRate

	for {
		select {
		case <-done:
			return
		case <-c.session.Done:
			return
		case pkt, ok := <-c.session.AudioChan:
			if !ok {
				return
			}

			c.mu.RLock()
			isMuted := c.mute != 0
			c.mu.RUnlock()

			// Resolve signal quality from radiod.
			var basebandPower, noiseDensity float32 = -999.0, -999.0
			if rc := c.handler.sessions.radiod; rc != nil {
				if cs := rc.GetChannelStatus(c.session.SSRC); cs != nil {
					basebandPower = cs.BasebandPower
					noiseDensity = cs.NoiseDensity
				}
			}

			sampleRate := pkt.SampleRate
			if sampleRate <= 0 {
				sampleRate = c.handler.config.Audio.DefaultSampleRate
			}

			// Recreate the Opus encoder if the sample rate changed (e.g. mode switch).
			if sampleRate != encoderSampleRate {
				newEnc, err := NewOpusEncoderForClient(sampleRate, bitrate, complexity)
				if err != nil {
					log.Printf("WebSDR: failed to recreate Opus encoder at %d Hz: %v", sampleRate, err)
					continue
				}
				c.opusEncoder = newEnc
				encoderSampleRate = sampleRate
				log.Printf("WebSDR: Opus encoder recreated at %d Hz", sampleRate)
			}

			var pcmData []byte
			if isMuted {
				// Send silence: 20 ms of zero PCM (big-endian int16, matching radiod format).
				silenceSamples := sampleRate / 50
				pcmData = make([]byte, silenceSamples*2)
			} else {
				pcmData = pkt.PCMData
			}

			opusData, err := c.opusEncoder.EncodeBinary(pcmData)
			if err != nil {
				log.Printf("WebSDR: Opus encode error: %v", err)
				continue
			}

			// Build Version 2 packet (21-byte header + Opus payload).
			packet := make([]byte, 21+len(opusData))
			binary.LittleEndian.PutUint64(packet[0:8], uint64(pkt.GPSTimeNs))
			binary.LittleEndian.PutUint32(packet[8:12], uint32(sampleRate))
			packet[12] = 1 // mono
			binary.LittleEndian.PutUint32(packet[13:17], math.Float32bits(basebandPower))
			binary.LittleEndian.PutUint32(packet[17:21], math.Float32bits(noiseDensity))
			copy(packet[21:], opusData)

			if err := c.sendBinary(packet); err != nil {
				return
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Waterfall stream handler (§4)
// ─────────────────────────────────────────────────────────────────────────────

// handleWaterfallStream handles /~~waterstream[N] WebSocket connections.
// MINOR-16: band index extracted from path suffix.
func (h *WebSDRHandler) handleWaterfallStream(w http.ResponseWriter, r *http.Request) {
	clientIP := getClientIP(r)
	if h.ipBanManager.IsBanned(clientIP) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// MINOR-16: extract band index from path suffix (/~~waterstream0, /~~waterstream1, …)
	path := r.URL.Path
	bandIdx := 0
	for _, prefix := range []string{"/~~waterstream", "/~~wf"} {
		if strings.HasPrefix(path, prefix) {
			suffix := strings.TrimPrefix(path, prefix)
			if n, err := strconv.Atoi(suffix); err == nil {
				bandIdx = n
			}
			break
		}
	}

	conn, err := websdrUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSDR: waterfall upgrade error: %v", err)
		return
	}

	c := newWebSDRConn(conn, h, clientIP)
	c.statCounter = &h.statWFBytes
	c.wfBand = bandIdx
	c.wfWidth = 1024
	c.wfFormat = 9

	// Send init frames (§4.2) as two separate WebSocket binary messages.
	// Frame 1 (0xFF 0x01 ...): sets zoom and scroll offset (a.g, a.f).
	// Frame 2 (0xFF 0x02 ...): sets pixel width (a.m).
	{
		frame1, frame2 := WebSDRWaterfallInitFrames(0, 0, c.wfWidth)
		if err := c.sendBinary(frame1); err != nil {
			conn.Close()
			return
		}
		if err := c.sendBinary(frame2); err != nil {
			conn.Close()
			return
		}
	}

	// Use timestamp (seconds) + IP as the userSessionID so that audio and
	// waterfall WebSocket connections from the same page load share the same
	// UUID (they connect within the same second), while a new tab opened later
	// gets a different timestamp → different UUID → independent sessions.
	// This mirrors the KiwiSDR emulation's "kiwi-<timestamp>-<IP>" scheme.
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	userSessionID := fmt.Sprintf("websdr-%s-%s", timestamp, clientIP)
	session, err := h.sessions.CreateSpectrumSessionWithUserID(clientIP, clientIP, userSessionID)
	if err != nil {
		log.Printf("WebSDR: failed to create waterfall session: %v", err)
		conn.Close()
		return
	}
	c.session = session
	c.sessionID = userSessionID

	// BUG-D: tune the spectrum session immediately to the full HF band view
	// (zoom=0, start=0) so the waterfall shows data before the first
	// /~~waterparam command arrives.
	{
		const bandStartHz = 10000.0
		const bandEndHz = 30000000.0
		const bandBWHz = bandEndHz - bandStartHz
		centerHz := bandStartHz + bandBWHz/2.0
		binBandwidthHz := bandBWHz / float64(c.wfWidth)
		_ = h.sessions.UpdateSpectrumSession(session.ID, uint64(centerHz), binBandwidthHz, c.wfWidth)
	}

	defer func() {
		_ = h.sessions.DestroySession(session.ID)
		conn.Close()
	}()

	done := make(chan struct{})
	go c.readWaterfallCommands(done)
	c.streamWaterfall(done)
}

// readWaterfallCommands reads /~~waterparam text commands from the waterfall WebSocket.
func (c *websdrConn) readWaterfallCommands(done chan struct{}) {
	defer close(done)
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		text := strings.TrimSpace(string(msg))
		text = strings.TrimPrefix(text, "GET ")
		if strings.HasPrefix(text, "/~~waterparam") {
			c.applyWaterparamCommand(text)
		}
	}
}

// streamWaterfall streams waterfall rows to the client.
func (c *websdrConn) streamWaterfall(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case <-c.session.Done:
			return
		case pkt, ok := <-c.session.SpectrumChan:
			if !ok {
				return
			}

			c.mu.Lock()
			wfWidth := c.wfWidth
			pf1 := c.pendingInitFrame1
			pf2 := c.pendingInitFrame2
			c.pendingInitFrame1 = nil
			c.pendingInitFrame2 = nil
			c.mu.Unlock()

			// Flush any pending init frames (queued by applyWaterparamCommand
			// on zoom/pan/width change) before sending the next data row.
			// Sent as two separate WebSocket binary messages.
			if len(pf1) > 0 {
				if err := c.sendBinary(pf1); err != nil {
					return
				}
				if err := c.sendBinary(pf2); err != nil {
					return
				}
			}

			if wfWidth < 1 {
				wfWidth = 1024
			}

			// BUG-I: Unwrap FFT data from radiod's DC-centred layout to
			// low-frequency-first order expected by the WebSDR waterfall.
			// Radiod sends: [DC … +Nyquist, -Nyquist … -DC]
			// We need:      [-Nyquist … DC … +Nyquist]  (low → high)
			n := len(pkt)
			unwrapped := make([]float32, n)
			if n > 0 {
				half := n / 2
				copy(unwrapped[0:half], pkt[half:n])
				copy(unwrapped[half:n], pkt[0:half])
			}

			// BUG-H: The browser's `slow` parameter is an animation-frame
			// skip count on the client side — it does NOT mean the server
			// should drop packets.  Send every spectrum packet we receive.
			pixels := spectrumToPixels(unwrapped, wfWidth, c.handler)

			// MINOR-24: apply waterfall text overlay before encoding
			c.handler.wfTextMu.Lock()
			textRows := c.handler.wfTextRows
			c.handler.wfTextMu.Unlock()
			if len(textRows) > 0 {
				applyWaterfallTextOverlay(pixels, textRows, wfWidth)
			}

			// Encode row using WebSDR waterfall format
			encoded := c.wfState.EncodeRow(pixels)
			if err := c.sendBinary(encoded); err != nil {
				return
			}
		}
	}
}

// spectrumToPixels converts FFT power data (dBFS float32) to waterfall pixel values.
//
// The SpectrumChan carries dBFS values (e.g. -120.0 … 0.0).  The WebSDR
// waterfall pixel range is 0–255 where 0 = noise floor and 255 = full scale.
// We map linearly:
//
//	pixel = clamp((dBFS - floorDBFS) * 255 / rangeDB, 0, 255)
//
// floorDBFS defaults to -120 dBFS and rangeDB to 100 dB, giving:
//
//	-120 dBFS → 0   (noise floor)
//	 -20 dBFS → 255 (strong signal)
//
// WebSDRWaterfallCalibration shifts the floor up/down (positive = brighter).
func spectrumToPixels(fftData []float32, width int, h *WebSDRHandler) []byte {
	pixels := make([]byte, width)
	n := len(fftData)
	if n == 0 {
		return pixels
	}

	// Calibration offset in dB (positive = brighter / lower noise floor).
	calibration := float32(0)
	if h != nil && h.config != nil {
		calibration = h.config.Server.WebSDRWaterfallCalibration
	}

	const floorDBFS = float32(-120.0)
	const rangeDB = float32(100.0)

	for i := 0; i < width; i++ {
		// Map pixel column to FFT bin (nearest-neighbour).
		srcIdx := i * n / width
		if srcIdx >= n {
			srcIdx = n - 1
		}
		dbfs := fftData[srcIdx] + calibration

		// Linear dBFS → pixel mapping.
		idx := int((dbfs - floorDBFS) * 255.0 / rangeDB)
		if idx < 0 {
			idx = 0
		}
		if idx > 255 {
			idx = 255
		}
		pixels[i] = byte(idx)
	}

	return pixels
}

// applyWaterfallTextOverlay overlays text rows onto waterfall pixels (MINOR-24).
// textRows is a slice of raw pixel rows (each row is wfWidth bytes).
func applyWaterfallTextOverlay(pixels []byte, textRows [][]byte, wfWidth int) {
	if len(textRows) == 0 || len(pixels) == 0 {
		return
	}
	// Use the first text row as an overlay mask
	row := textRows[0]
	limit := len(row)
	if limit > wfWidth {
		limit = wfWidth
	}
	if limit > len(pixels) {
		limit = len(pixels)
	}
	for i := 0; i < limit; i++ {
		if row[i] != 0 {
			pixels[i] = row[i]
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper utilities
// ─────────────────────────────────────────────────────────────────────────────

func noCacheHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}

func jsEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	return s
}

// sanitizeChatField strips control characters and truncates to maxLen runes.
func sanitizeChatField(s string, maxLen int) string {
	var b strings.Builder
	count := 0
	for _, r := range s {
		if r >= 0x20 && count < maxLen {
			b.WriteRune(r)
			count++
		}
	}
	return b.String()
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~orgstatus (§6.5)
//
// websdr.org connects back to this endpoint to verify the SDR is live and to
// retrieve its configuration.  The response MUST be plain text in the format
// used by the reference WebSDR implementation:
//
//   Config: <serial>\r\n
//   <org_info block (with email XOR-obfuscated)>
//   Mobile: m.html\r\n
//   Bands: 1\r\n
//   Band: 0 15000.000000 29990.000000 HF\r\n
//   Users: <n>\r\n
//
// If the request includes ?config=<serial> matching the current serial, only
// "Users: <n>\r\n" is returned (cache optimisation).
// ─────────────────────────────────────────────────────────────────────────────

// orgStatusSerial is a process-lifetime serial number for the /~~orgstatus
// Config: field.  Initialised once from the Unix timestamp at startup.
var orgStatusSerial = int(time.Now().Unix() & 0x7fffffff)

func (h *WebSDRHandler) handleOrgStatus(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "text/plain")

	callerIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(callerIP); err == nil {
		callerIP = host
	}

	users := int(atomic.LoadInt32(&h.audioUserCount))

	// Cache optimisation: if caller already has our config serial, send only user count.
	if reqCfg := r.URL.Query().Get("config"); reqCfg != "" {
		if reqCfg == strconv.Itoa(orgStatusSerial) {
			log.Printf("WebSDR: /~~orgstatus callback from %s (cache hit, users=%d)", callerIP, users)
			fmt.Fprintf(w, "Users: %d\r\n", users)
			return
		}
	}

	log.Printf("WebSDR: /~~orgstatus callback from %s (full response, users=%d)", callerIP, users)

	fmt.Fprintf(w, "Config: %d\r\n", orgStatusSerial)

	// Emit individual fields from org_info block directly (matching real WebSDR format).
	// Fields are emitted as top-level lines: Qth:, Description:, Email:, Logo: etc.
	// The Email: value is XOR-obfuscated (each byte ^ 0x01) before transmission.
	for _, line := range strings.Split(h.config.Server.WebSDROrgInfo, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		// Pass through any "Key: value" line, obfuscating the Email: value.
		// val is trimmed of leading whitespace; output always uses "Key: value" format.
		if colon := strings.Index(line, ":"); colon > 0 {
			key := line[:colon]
			val := strings.TrimLeft(line[colon+1:], " \t")
			if strings.EqualFold(strings.TrimSpace(key), "email") {
				// XOR each byte of the email address with 0x01
				b := []byte(val)
				for i := range b {
					if b[i] > 31 {
						b[i] ^= 0x01
					}
				}
				val = string(b)
			}
			fmt.Fprintf(w, "%s: %s\r\n", key, val)
		}
	}

	// Logo and mobile page
	fmt.Fprintf(w, "Logo: logo.png\r\n")
	fmt.Fprintf(w, "Mobile: m.html\r\n")

	// Fixed hardware band: 10 kHz – 30 MHz (UberSDR limitation)
	// Format: Band: <idx> <centerfreq_khz> <bandwidth_khz> <antenna>
	antenna := h.config.Admin.Antenna
	if antenna == "" {
		antenna = "HF"
	}
	fmt.Fprintf(w, "Bands: 1\r\n")
	fmt.Fprintf(w, "Band: 0 15000.000000 29990.000000 %s\r\n", antenna)

	fmt.Fprintf(w, "Users: %d\r\n", users)
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~othersj (§6.2) — legacy user list + stats
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleOthersJ(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	clientChseq, _ := strconv.Atoi(r.URL.Query().Get("chseq"))
	_ = clientChseq
	currentChseq := h.chseq.get()
	users := h.getUsers()
	audioUsers := int(atomic.LoadInt32(&h.audioUserCount))
	maxUsers := h.config.Server.WebSDRMaxUsers
	if maxUsers == 0 {
		maxUsers = h.config.Server.MaxSessions
	}
	// Reset the uu_* arrays so stale users are cleared, then emit uu() calls.
	fmt.Fprintf(w, "uu_chseq=%d;\n", currentChseq)
	fmt.Fprintf(w, "uu_names=[];\n")
	fmt.Fprintf(w, "uu_bands=[];\n")
	fmt.Fprintf(w, "uu_freqs=[];\n")
	for i, u := range users {
		displayName := u.username
		if displayName == "" {
			displayName = maskIP(u.clientIP)
		}
		normFreq := websdrNormalizeFreq(u.tuneKHz)
		fmt.Fprintf(w, "uu(%d,%q,%d,%.6f);\n",
			i,
			displayName,
			u.band,
			normFreq,
		)
	}
	// Populate the stats div with WebSDR-specific information.
	// /~~othersj is the legacy endpoint; throughput stats are not reset here
	// (only /~~othersjj resets them, since that's what the JS polls every 1 s).
	audioKBps, wfKBps, httpKBps := h.websdrThroughputStats()
	statsHTML := fmt.Sprintf("Past ~1s: %d users; audio %.1f kb/s, waterfall %.1f kb/s, http %.1f kb/s",
		audioUsers, audioKBps, wfKBps, httpKBps)
	fmt.Fprintf(w, "if(statsobj)statsobj.innerHTML=%q;\n", statsHTML)
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~othersjj (§6.3) — compact user list (polled by ajaxFunction3 every 1 s)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleOthersJJ(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	users := h.getUsers()
	currentChseq := h.chseq.get()
	audioUsers := int(atomic.LoadInt32(&h.audioUserCount))
	maxUsers := h.config.Server.WebSDRMaxUsers
	if maxUsers == 0 {
		maxUsers = h.config.Server.MaxSessions
	}
	// Reset the uu_* arrays so stale users are cleared, then emit uu() calls.
	// douu() reads uu_names[], uu_bands[], uu_freqs[] which are populated by uu().
	// freq must be a normalized 0–1 fraction of the band width so that douu()
	// can compute the correct pixel offset on the 1024px-wide band display.
	fmt.Fprintf(w, "uu_chseq=%d;\n", currentChseq)
	fmt.Fprintf(w, "uu_names=[];\n")
	fmt.Fprintf(w, "uu_bands=[];\n")
	fmt.Fprintf(w, "uu_freqs=[];\n")
	for i, u := range users {
		displayName := u.username
		if displayName == "" {
			displayName = maskIP(u.clientIP)
		}
		normFreq := websdrNormalizeFreq(u.tuneKHz)
		fmt.Fprintf(w, "uu(%d,%q,%d,%.6f);\n",
			i,
			displayName,
			u.band,
			normFreq,
		)
	}
	// Populate the stats div with throughput matching the real WebSDR format:
	// "Past ~1s: CPUload=N%, X users; audio Y kb/s, waterfall Z kb/s, http W kb/s"
	// We omit CPU load (not available); the JS polls this every 1 s so the
	// elapsed window is approximately 1 second.
	audioKBps, wfKBps, httpKBps := h.websdrThroughputStats()
	statsHTML := fmt.Sprintf("Past ~1s: %d users; audio %.1f kb/s, waterfall %.1f kb/s, http %.1f kb/s",
		audioUsers, audioKBps, wfKBps, httpKBps)
	fmt.Fprintf(w, "if(statsobj)statsobj.innerHTML=%q;\n", statsHTML)
}

// websdrThroughputStats atomically swaps the byte counters and returns kb/s
// for audio, waterfall, and HTTP over the elapsed interval since last call.
func (h *WebSDRHandler) websdrThroughputStats() (audioKBps, wfKBps, httpKBps float64) {
	now := time.Now().UnixNano()
	lastReset := atomic.SwapInt64(&h.statLastReset, now)
	elapsedSec := float64(now-lastReset) / 1e9
	if elapsedSec < 0.001 {
		elapsedSec = 0.001
	}
	audioBytes := atomic.SwapInt64(&h.statAudioBytes, 0)
	wfBytes := atomic.SwapInt64(&h.statWFBytes, 0)
	httpBytes := atomic.SwapInt64(&h.statHTTPBytes, 0)
	audioKBps = float64(audioBytes) / 1024.0 / elapsedSec
	wfKBps = float64(wfBytes) / 1024.0 / elapsedSec
	httpKBps = float64(httpBytes) / 1024.0 / elapsedSec
	return
}

// websdrNormalizeFreq converts a tuning frequency in kHz to a normalized 0–1
// fraction of the HF band (10 kHz – 30 MHz).  The WebSDR frontend's douu()
// function multiplies this by 1024 to get a pixel offset on the band display.
func websdrNormalizeFreq(tuneKHz float64) float64 {
	const bandStartKHz = 10.0
	const bandBWKHz = 29990.0 // 30000 - 10
	norm := (tuneKHz - bandStartKHz) / bandBWKHz
	if norm < 0 {
		norm = 0
	}
	if norm > 1 {
		norm = 1
	}
	return norm
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~chat (§6.4)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleChat(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)

	if r.Method == http.MethodPost {
		// POST: add a chat message
		_ = r.ParseForm()
		name := strings.TrimSpace(r.FormValue("name"))
		text := strings.TrimSpace(r.FormValue("text"))
		if name == "" {
			name = "anon"
		}
		// Strip control characters from name and text.
		name = sanitizeChatField(name, 31)
		text = sanitizeChatField(text, 200)
		// HTML-escape both fields: chatnewline() injects them into innerHTML
		// without any client-side escaping, so we must sanitise server-side.
		name = html.EscapeString(name)
		text = html.EscapeString(text)
		if text != "" {
			seq := h.chseq.bump()
			h.chat.add(name, text, seq)
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	// GET: return chat messages since clientChseq
	w.Header().Set("Content-Type", "application/javascript")
	clientChseq, _ := strconv.Atoi(r.URL.Query().Get("chseq"))

	var msgs []string
	if clientChseq == 0 {
		msgs = h.chat.all()
	} else {
		msgs = h.chat.since(clientChseq)
	}

	fmt.Fprintf(w, "chat_chseq=%d;\n", h.chseq.get())
	fmt.Fprintf(w, "chat_msgs=[\n")
	for i, m := range msgs {
		if i > 0 {
			fmt.Fprintf(w, ",\n")
		}
		fmt.Fprintf(w, `"%s"`, jsEscape(m))
	}
	fmt.Fprintf(w, "\n];\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~fetchdx (§6.6)
// ─────────────────────────────────────────────────────────────────────────────

// handleFetchDX serves station info from stationinfo.txt (MINOR-20).
func (h *WebSDRHandler) handleFetchDX(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	// MINOR-20: read stationinfo.txt from static dir instead of config.Bookmarks
	stationFile := h.findStaticFile("stationinfo.txt")
	if stationFile == "" {
		fmt.Fprintf(w, "stationinfo=[];\n")
		return
	}

	data, err := os.ReadFile(stationFile)
	if err != nil {
		fmt.Fprintf(w, "stationinfo=[];\n")
		return
	}

	fmt.Fprintf(w, "stationinfo=[\n")
	emitStationInfoDX(w, string(data))
	fmt.Fprintf(w, "];\n")
}

// emitStationInfoDX parses stationinfo.txt and emits JS array entries.
// Format: freq_kHz|name|description (one per line, # = comment)
func emitStationInfoDX(w http.ResponseWriter, data string) {
	lines := strings.Split(data, "\n")
	first := true
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) < 2 {
			continue
		}
		freqStr := strings.TrimSpace(parts[0])
		name := strings.TrimSpace(parts[1])
		desc := ""
		if len(parts) >= 3 {
			desc = strings.TrimSpace(parts[2])
		}
		if !first {
			fmt.Fprintf(w, ",\n")
		}
		first = false
		fmt.Fprintf(w, `[%s,"%s","%s"]`,
			freqStr,
			jsDoubleEscape(name),
			jsDoubleEscape(desc),
		)
	}
}

func jsDoubleEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~histogram (§6.8)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleHistogram(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	fmt.Fprintf(w, "histogram=[")
	for i := 0; i < 24; i++ {
		if i > 0 {
			fmt.Fprintf(w, ",")
		}
		fmt.Fprintf(w, "%d", atomic.LoadInt32(&h.histogram[i]))
	}
	fmt.Fprintf(w, "];\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~otherstable (§6.9) — full user table HTML (MINOR-17)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleOthersTable(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	users := h.getUsers()

	fmt.Fprintf(w, `<table class="others-table" border="1" cellpadding="3" cellspacing="0">`)
	fmt.Fprintf(w, "<tr><th>#</th><th>Name</th><th>Freq (kHz)</th><th>Band</th><th>IP</th></tr>\n")

	for i, u := range users {
		displayName := u.username
		if displayName == "" {
			displayName = "(anon)"
		}
		colorClass := websdrUserColors(i)
		fmt.Fprintf(w,
			`<tr class="%s"><td>%d</td><td>%s</td><td>%.3f</td><td>%d</td><td>%s</td></tr>`+"\n",
			colorClass,
			i+1,
			html.EscapeString(displayName),
			u.tuneKHz,
			u.band,
			html.EscapeString(maskIP(u.clientIP)),
		)
	}

	// Summary row (MINOR-17)
	fmt.Fprintf(w, `<tr><td colspan="5"><b>Total: %d user(s)</b></td></tr>`, len(users))
	fmt.Fprintf(w, "</table>\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~status (§6.10) — internal diagnostics (MINOR-18)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleStatus(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	users := h.getUsers()
	audioUsers := atomic.LoadInt32(&h.audioUserCount)

	fmt.Fprintf(w, "<html><body>\n")
	fmt.Fprintf(w, "<h2>WebSDR Status</h2>\n")
	fmt.Fprintf(w, "<p>Audio users: %d</p>\n", audioUsers)
	fmt.Fprintf(w, "<p>Tracked users: %d</p>\n", len(users))

	// Per-band detail rows (MINOR-18)
	bandCounts := make(map[int]int)
	for _, u := range users {
		bandCounts[u.band]++
	}
	if len(bandCounts) > 0 {
		fmt.Fprintf(w, "<h3>Per-band user counts</h3>\n")
		fmt.Fprintf(w, "<table border='1'><tr><th>Band</th><th>Users</th></tr>\n")
		for band, count := range bandCounts {
			fmt.Fprintf(w, "<tr><td>%d</td><td>%d</td></tr>\n", band, count)
		}
		fmt.Fprintf(w, "</table>\n")
	}

	// Bandwidth/CPU footer (MINOR-18)
	fmt.Fprintf(w, "<p>CPU: 0%% | Bandwidth: 0 kbps</p>\n")
	fmt.Fprintf(w, "<p>Config serial: %d</p>\n", atomic.LoadInt32(&h.configSerial))
	fmt.Fprintf(w, "</body></html>\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~logbook (§6.7) — stub (FEAT-7)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleLogbook(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")
	// Stub: return empty logbook array
	fmt.Fprintf(w, "logbook=[];\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// /tmp/bandinfo.js — dynamic bootstrap JS for the WebSDR frontend
//
// websdr-base.js reads this file on every page load to discover the available
// bands (nbands, bandinfo[]), the current chseq, and the idle timeout.
// The real WebSDR server generates this from its config at startup; we generate
// it on-the-fly with a single hardcoded HF band (10 kHz–30 MHz).
//
// Fields per band entry (all required by websdr-base.js):
//   centerfreq   — centre of the band in kHz
//   samplerate   — bandwidth in kHz (used as pixels-per-kHz denominator)
//   tuningstep   — minimum tuning step in kHz (1/32 kHz = 31.25 Hz)
//   maxlinbw     — maximum linear bandwidth in kHz (half samplerate, capped at 4)
//   vfo          — initial VFO frequency in kHz (centre + 10 kHz offset)
//   maxzoom      — maximum zoom level (3 gives 8× zoom)
//   name         — band label shown in the UI
//   scaleimgs    — nested array of frequency-scale PNG paths per zoom level;
//                  we point all entries to "scaleblack.png" (a solid-black
//                  1024×14 placeholder already present in the static dir)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleBandInfoJS(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	// Single hardcoded HF band: 10 kHz–30 MHz.
	bands := []Band{{Label: "HF", Start: 10000, End: 30000000}}

	idleMS := 0
	if h.config.Server.WebSDRIdleTimeout > 0 {
		idleMS = h.config.Server.WebSDRIdleTimeout * 1000
	}

	chseq := h.chseq.get()

	fmt.Fprintf(w, "var nbands=%d;\n", len(bands))
	fmt.Fprintf(w, "var ini_freq=-1.000000;\n")
	fmt.Fprintf(w, "var ini_mode='';\n")
	fmt.Fprintf(w, "var chseq=%d;\n", chseq)
	fmt.Fprintf(w, "var bandinfo= [\n")

	for i, b := range bands {
		// Derive kHz values from Hz config
		startKHz := float64(b.Start) / 1000.0
		endKHz := float64(b.End) / 1000.0
		bwKHz := endKHz - startKHz
		if bwKHz <= 0 {
			bwKHz = 192.0
		}
		centerKHz := 15000.0       // fixed centre for 10 kHz–30 MHz HF band
		vfoKHz := centerKHz + 10.0 // default VFO 10 kHz above centre

		// tuningstep: 1/32 kHz (31.25 Hz), matching real WebSDR default
		tuningStep := 1.0 / 32.0

		// maxlinbw: maximum one-sided filter bandwidth in kHz.
		// updbw() in websdr-base.js clamps lo/hi to ±maxlinbw*0.95.
		// We allow 6 kHz (matching the 12 kHz SSB/AM sample rate Nyquist limit).
		maxLinBW := 6.0

		// maxzoom: 8 gives 256× zoom (2^8).
		// The maxzoom grid is 1024×2^8 = 262144 pixels spanning the full HF band.
		// At zoom=8 the visible bandwidth is ~117 kHz; binBW is kept ≥ 500 Hz by
		// halving binCount at deep zoom levels (see applyWaterparamCommand).
		// This constant MUST match the maxZoom constant in applyWaterparamCommand.
		maxZoom := 8

		name := b.Label
		if name == "" {
			name = fmt.Sprintf("band%d", i)
		}

		// scaleimgs: nested array [zoom0:[img0], zoom1:[img0,img1], ...]
		// All entries point to scaleblack.png as a placeholder.
		// The real WebSDR generates rendered frequency-scale PNGs; we use a
		// solid-black image so the UI loads without broken-image icons.
		sep := ""
		if i > 0 {
			sep = ","
		}
		fmt.Fprintf(w, "%s  { centerfreq: %f,\n", sep, centerKHz)
		fmt.Fprintf(w, "    samplerate: %f,\n", bwKHz)
		fmt.Fprintf(w, "    tuningstep: %f,\n", tuningStep)
		fmt.Fprintf(w, "    maxlinbw: %f,\n", maxLinBW)
		fmt.Fprintf(w, "    vfo: %f,\n", vfoKHz)
		fmt.Fprintf(w, "    maxzoom: %d,\n", maxZoom)
		fmt.Fprintf(w, "    name: '%s',\n", strings.ReplaceAll(name, "'", "\\'"))
		fmt.Fprintf(w, "    scaleimgs: [\n")
		for z := 0; z <= maxZoom; z++ {
			numImgs := 1 << uint(z) // zoom 0→1 img, zoom 1→2 imgs, zoom 2→4, …
			fmt.Fprintf(w, "      [")
			for img := 0; img < numImgs; img++ {
				if img > 0 {
					fmt.Fprintf(w, ",")
				}
				fmt.Fprintf(w, `"~~scale?band=%d&zoom=%d&tile=%d"`, i, z, img)
			}
			if z < maxZoom {
				fmt.Fprintf(w, "],\n")
			} else {
				fmt.Fprintf(w, "]]\n")
			}
		}
		fmt.Fprintf(w, "  }\n")
	}

	fmt.Fprintf(w, "];\n")
	fmt.Fprintf(w, "var dxinfoavailable=0;\n")
	if idleMS > 0 {
		fmt.Fprintf(w, "var idletimeout=%d;\n", idleMS)
	} else {
		fmt.Fprintf(w, "var idletimeout=0;\n")
	}
	fmt.Fprintf(w, "var has_mobile=0;\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Sysop endpoints (§7) — FEAT-8
// All require trusted IP (localhost by default).
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleSysopWaterfallText(w http.ResponseWriter, r *http.Request) {
	if !h.isTrustedIP(getClientIP(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	// POST body: raw waterfall text rows (32 rows × wfWidth bytes)
	body, err := io.ReadAll(io.LimitReader(r.Body, 32*1024+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	// Split into rows of wfWidth bytes
	wfWidth := 1024
	var rows [][]byte
	for i := 0; i+wfWidth <= len(body); i += wfWidth {
		row := make([]byte, wfWidth)
		copy(row, body[i:i+wfWidth])
		rows = append(rows, row)
	}
	h.wfTextMu.Lock()
	h.wfTextRows = rows
	h.wfTextMu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (h *WebSDRHandler) handleSysopConfigReload(w http.ResponseWriter, r *http.Request) {
	if !h.isTrustedIP(getClientIP(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	// Bump config serial to signal clients to reload
	atomic.AddInt32(&h.configSerial, 1)
	log.Printf("WebSDR: sysop config reload requested")
	fmt.Fprintf(w, "ok\n")
}

func (h *WebSDRHandler) handleSysopSetConfig(w http.ResponseWriter, r *http.Request) {
	if !h.isTrustedIP(getClientIP(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	_ = r.ParseForm()
	if v := r.FormValue("maxusers"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			h.sysopMaxUsers = n
		}
	}
	if v := r.FormValue("skipmute"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			h.sysopSkipMute = n
		}
	}
	fmt.Fprintf(w, "ok\n")
}

func (h *WebSDRHandler) handleSysopSetDir(w http.ResponseWriter, r *http.Request) {
	if !h.isTrustedIP(getClientIP(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	_ = r.ParseForm()
	if v := r.FormValue("dir"); v != "" {
		// Sanitise: no path traversal
		clean := filepath.Clean(v)
		if !strings.Contains(clean, "..") {
			h.config.Server.WebSDRStaticDir = clean
			log.Printf("WebSDR: sysop set static dir to %q", clean)
		}
	}
	fmt.Fprintf(w, "ok\n")
}

func (h *WebSDRHandler) handleSysopChatCensor(w http.ResponseWriter, r *http.Request) {
	if !h.isTrustedIP(getClientIP(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	// Stub: acknowledge the request
	fmt.Fprintf(w, "ok\n")
}

func (h *WebSDRHandler) handleSysopBlockMee(w http.ResponseWriter, r *http.Request) {
	if !h.isTrustedIP(getClientIP(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	_ = r.ParseForm()
	ip := strings.TrimSpace(r.FormValue("ip"))
	if ip != "" && h.ipBanManager != nil {
		_ = h.ipBanManager.BanIP(ip, "sysop block", "websdr-sysop")
		log.Printf("WebSDR: sysop blocked IP %s", ip)
	}
	fmt.Fprintf(w, "ok\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving with SSI (§8) — FEAT-9, FEAT-10
// ─────────────────────────────────────────────────────────────────────────────

// handleIndexHTML generates index.html dynamically from the server config so
// that the page title and description reflect the operator's callsign, name,
// location, and antenna without requiring a hand-edited static file.
//
// The body text mirrors the user-supplied description from websdr/index.html;
// the SSI includes (websdr-head.html, websdr-controls.html) are expanded
// inline using the same logic as serveHTMLWithSSI.
func (h *WebSDRHandler) handleIndexHTML(w http.ResponseWriter, r *http.Request) {
	cfg := h.config

	// Build page title: "<Callsign> WebSDR — <Name>, <Location>"
	callsign := cfg.Admin.Callsign
	if callsign == "" {
		callsign = "WebSDR"
	}
	name := cfg.Admin.Name
	location := cfg.Admin.Location
	var titleParts []string
	titleParts = append(titleParts, callsign+" WebSDR")
	if name != "" {
		titleParts = append(titleParts, name)
	}
	if location != "" {
		titleParts = append(titleParts, location)
	}
	title := strings.Join(titleParts, " — ")

	// Build description paragraph from the same config fields as the title.
	// Format: "<Callsign> WebSDR — <Name>, <Location>. Antenna: <Antenna>."
	var descParts []string
	if callsign != "WebSDR" {
		base := callsign + " WebSDR"
		if name != "" {
			base += " — " + name
		}
		if location != "" {
			base += ", " + location
		}
		descParts = append(descParts, base)
	} else if location != "" {
		descParts = append(descParts, "WebSDR in "+location)
	}
	if cfg.Admin.Antenna != "" {
		descParts = append(descParts, "Antenna: "+cfg.Admin.Antenna)
	}
	var description string
	if len(descParts) > 0 {
		description = strings.Join(descParts, ". ") + "."
	} else {
		description = "WebSDR receiver."
	}

	// Expand SSI includes for websdr-head.html and websdr-controls.html.
	expandSSI := func(filename string) string {
		p := h.findStaticFile(filename)
		if p == "" {
			return ""
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return ""
		}
		return string(data)
	}

	head := expandSSI("websdr-head.html")
	controls := expandSSI("websdr-controls.html")

	// Get the public URL for the UberSDR frontend link.
	publicURL := cfg.InstanceReporting.ConstructPublicURL()

	// Render the page.  Structure is identical to the original index.html so
	// that all existing JS (bodyonload, etc.) continues to work.
	page := `<!DOCTYPE HTML>
<meta http-equiv="Content-Type" content="text/html;charset=utf-8">
<title>` + html.EscapeString(title) + `</title>
` + head + `
</head>

<body onload=bodyonload()>

This SDR runs <a href="https://ubersdr.org">UberSDR</a>. It uses the <a href="http://www.websdr.org">WebSDR</a> frontend.
` + html.EscapeString(description) + `
<br>You can also visit the <a href="` + html.EscapeString(publicURL) + `">UberSDR frontend</a> for this receiver.
<p>
<hr>

<div style="display: block; position: fixed; top: 0px; left: 0px; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 1000;" id="audiostartbutton">
	 <div class="ctl" style="margin:50px; padding:20px;">
	   Click here to start audio:
	   <input type="button" value="start audio" onclick="audio_start()">
	   <script>
	    function audio_start()
	    {
	     if (!document.ct) document.ct= new (window.AudioContext || window.webkitAudioContext)();
	     var s = document.ct.createBufferSource();
	     s.connect(document.ct.destination);
	     document.ct.resume();
	     try { s.start(0); } catch(e) { s.noteOn(0); }
	     var e = document.getElementById("audiostartbutton");
	     e.style.display = (e.style.display == 'block') ? 'none' : 'block';
	     }
	   </script>
	 </div>
</div>

` + controls + `

</body>
</html>
`

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	noCacheHeaders(w)
	fmt.Fprint(w, page)
}

// For .html files, SSI directives (<!--#include virtual="..." -->) are processed.
func (h *WebSDRHandler) serveStaticFile(w http.ResponseWriter, r *http.Request) {
	// Sanitise path
	urlPath := r.URL.Path
	if urlPath == "/" {
		urlPath = "/index.html"
	}
	// Strip leading slash and clean
	name := filepath.Clean(strings.TrimPrefix(urlPath, "/"))
	if strings.Contains(name, "..") {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// FEAT-10: two-directory search
	filePath := h.findStaticFile(name)
	if filePath == "" {
		http.NotFound(w, r)
		return
	}

	// FEAT-9: SSI processing for HTML files
	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == ".html" || ext == ".htm" {
		h.serveHTMLWithSSI(w, r, filePath)
		return
	}

	http.ServeFile(w, r, filePath)
}

// serveHTMLWithSSI reads an HTML file and processes <!--#include virtual="..." --> and
// <!--#include file="..." --> directives (both forms are used by WebSDR HTML files).
func (h *WebSDRHandler) serveHTMLWithSSI(w http.ResponseWriter, r *http.Request, filePath string) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	content := string(data)

	// Process SSI includes: <!--#include virtual="path" --> or <!--#include file="path" -->
	ssiRe := regexp.MustCompile(`<!--#include\s+(?:virtual|file)="([^"]+)"\s*-->`)
	content = ssiRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := ssiRe.FindStringSubmatch(match)
		if len(sub) < 2 {
			return ""
		}
		includePath := filepath.Clean(strings.TrimPrefix(sub[1], "/"))
		if strings.Contains(includePath, "..") {
			return ""
		}
		incFile := h.findStaticFile(includePath)
		if incFile == "" {
			return ""
		}
		incData, err := os.ReadFile(incFile)
		if err != nil {
			return ""
		}
		return string(incData)
	})

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	noCacheHeaders(w)
	fmt.Fprint(w, content)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// filterWebSDRAudioUsers is a placeholder — actual user tracking is done via
// the WebSDRHandler.users map. This function is kept for potential future use.
func filterWebSDRAudioUsers(_ *SessionManager) []*Session {
	return nil
}

// websdrNormFreq formats a frequency in kHz as a JS number string.
func websdrNormFreq(kHz float64) string {
	if kHz == float64(int64(kHz)) {
		return fmt.Sprintf("%.0f", kHz)
	}
	return fmt.Sprintf("%.3f", kHz)
}

// maskIP masks the last two octets of an IPv4 address (or equivalent for IPv6)
// for privacy, matching the reference WebSDR implementation.
func maskIP(ip string) string {
	// Strip port if present
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	if ip == "" {
		return "-"
	}
	// Strip IPv4-mapped IPv6 prefix
	ip = strings.TrimPrefix(ip, "::ffff:")
	// IPv4: mask last two octets → a.b.x.x
	parts := strings.Split(ip, ".")
	if len(parts) == 4 {
		return parts[0] + "." + parts[1] + ".x.x"
	}
	// IPv6: remove last two colon-separated groups → prefix:x:x
	if strings.Contains(ip, ":") {
		last := strings.LastIndex(ip, ":")
		if last > 0 {
			trimmed := ip[:last]
			prev := strings.LastIndex(trimmed, ":")
			if prev > 0 {
				return trimmed[:prev] + ":x:x"
			}
			return trimmed + ":x"
		}
	}
	return ip
}

// websdrUserColors returns a CSS class name for alternating row colours.
func websdrUserColors(idx int) string {
	colors := []string{"row-even", "row-odd"}
	return colors[idx%len(colors)]
}
