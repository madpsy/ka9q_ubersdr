package main

import (
	"encoding/binary"
	"fmt"
	"html"
	"io"
	"log"
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

func (h *WebSDRHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

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
	// Frequency scale images — serve scaleblack.png as placeholder for any
	// tmp/<id>-b<N>z<Z>i<I>.png that the real WebSDR server would generate
	case strings.HasPrefix(path, "/tmp/") && strings.HasSuffix(path, ".png"):
		http.Redirect(w, r, "/scaleblack.png", http.StatusFound)
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
	conn      *websocket.Conn
	writeMu   sync.Mutex
	handler   *WebSDRHandler
	clientIP  string
	session   *Session
	sessionID string
	userEntry *websdrUserEntry

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

	adpcm         *WebSDRAdpcmEncoder
	wfState       *WebSDRWaterfallState
	audioSeq      uint16
	headerCounter int

	lastAudioRate int

	amSyncFrameCounter int
	amSyncLastStatus   int
	amSyncLastFreqMHz  uint64

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
		adpcm:        NewWebSDRAdpcmEncoder(),
		wfState:      NewWebSDRWaterfallState(9),
		audioSeq:     0,
		lastActivity: time.Now(),
	}
}

func (c *websdrConn) sendBinary(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.BinaryMessage, data)
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
	format, _ := strconv.Atoi(q.Get("format"))
	if format == 0 {
		format = 23
	}
	if format != 23 && format != 36 {
		log.Printf("WebSDR: rejected unknown format %d", format)
		conn.Close()
		return
	}

	c := newWebSDRConn(conn, h, clientIP)

	// MINOR-15: parse mute= and band= from initial URL query
	if v := q.Get("mute"); v != "" {
		c.mute, _ = strconv.Atoi(v)
	}
	if v := q.Get("band"); v != "" {
		c.band, _ = strconv.Atoi(v)
	}

	atomic.AddInt32(&h.audioUserCount, 1)
	defer atomic.AddInt32(&h.audioUserCount, -1)

	// BUG-C: Use clientIP as the shared userSessionID base so that the audio
	// and waterfall WebSocket connections from the same browser appear as a
	// single user in the session list (mirrors KiwiSDR's timestamp+IP scheme).
	userSessionID := fmt.Sprintf("websdr-%s", clientIP)
	c.sessionID = userSessionID
	h.sessions.SetUserAgent(userSessionID, "WebSDR Client")

	// FEAT-11: register user entry
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

	defer func() {
		h.audioReceiver.ReleaseChannelAudio(session)
		_ = h.sessions.DestroySession(session.ID)
		conn.Close()
	}()

	done := make(chan struct{})
	go c.readAudioCommands(done)

	if format == 36 {
		<-done
		return
	}

	// BUG-4: send block-size and conv-type tags; rate tag 0x81 emitted in
	// streamAudio when first packet arrives with known sample rate.
	initTags := []byte{0x82, 0x00, 0x80, 0x83, 0x00}
	if err := c.sendBinary(initTags); err != nil {
		return
	}

	c.streamAudio(done)
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
		if newFreq != c.tuneKHz {
			c.tuneKHz = newFreq
			changed = true
		}
	}
	if v := vals.Get("lo"); v != "" {
		c.loKHz, _ = strconv.ParseFloat(v, 64)
	}
	if v := vals.Get("hi"); v != "" {
		c.hiKHz, _ = strconv.ParseFloat(v, 64)
	}
	if v := vals.Get("mode"); v != "" {
		c.mode, _ = strconv.Atoi(v)
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
		newName := nb.String()
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
	defer c.mu.Unlock()

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
		n, _ := strconv.Atoi(v)
		if n != 0x80000001 && n != c.wfStart {
			c.wfStart = n
			reset = true
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

	if reset {
		c.audioSeq = 0
		if c.wfState != nil {
			c.wfState.Reset()
		}

		// BUG-D: tune the spectrum session to the visible frequency range.
		// The hardcoded HF band is 10 kHz–30 MHz (bandwidth = 29990 kHz).
		// At zoom level z, the visible bandwidth is bandBW / 2^z.
		// The visible window starts at: bandStart + start * bandBW / (2^z * 1024)
		// Center = visibleStart + visibleBW/2
		// binBandwidth = visibleBW / binCount  (binCount = wfWidth, default 1024)
		if c.session != nil {
			const bandStartHz = 10000.0  // 10 kHz
			const bandEndHz = 30000000.0 // 30 MHz
			const bandBWHz = bandEndHz - bandStartHz

			zoom := c.wfZoom
			if zoom < 0 {
				zoom = 0
			}
			zoomFactor := float64(int(1) << uint(zoom)) // 2^zoom
			visibleBWHz := bandBWHz / zoomFactor

			wfWidth := c.wfWidth
			if wfWidth < 1 {
				wfWidth = 1024
			}

			// start is in units of (visibleBW / wfWidth) pixels from band left edge
			startOffsetHz := float64(c.wfStart) * visibleBWHz / float64(wfWidth)
			visibleStartHz := bandStartHz + startOffsetHz
			centerHz := visibleStartHz + visibleBWHz/2.0

			binBandwidthHz := visibleBWHz / float64(wfWidth)

			_ = c.handler.sessions.UpdateSpectrumSession(
				c.session.ID,
				uint64(centerHz),
				binBandwidthHz,
				wfWidth,
			)
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

func (c *websdrConn) streamAudio(done <-chan struct{}) {
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
			agcMode := c.agcMode
			gainDB := c.gainDB
			squelchOn := c.squelch != 0
			curMode := c.mode
			c.mu.RUnlock()

			// BUG-4: re-emit tag 0x81 if sample rate changed
			pktRate := pkt.SampleRate
			if pktRate <= 0 {
				pktRate = c.handler.config.Audio.DefaultSampleRate
			}

			// BUG-A: radiod packets may contain many samples (e.g. 960 at 48 kHz).
			// The ADPCM encoder processes exactly websdrBlockSamples (128) per call.
			// We must loop over the PCM data in 128-sample chunks so that all audio
			// is encoded and sent — not just the first 128 samples.
			allSamples := pcmBytesToFloat32(pkt.PCMData)
			for offset := 0; offset < len(allSamples); offset += websdrBlockSamples {
				end := offset + websdrBlockSamples
				if end > len(allSamples) {
					end = len(allSamples)
				}
				chunk := allSamples[offset:end]

				var frame []byte

				// Emit rate tag on first chunk of a packet where rate changed
				if offset == 0 && pktRate > 0 && pktRate != c.lastAudioRate {
					c.lastAudioRate = pktRate
					frame = append(frame, 0x81, byte(pktRate>>8), byte(pktRate&0xFF))
				}

				// S-meter tag every 8 frames
				c.headerCounter--
				if c.headerCounter <= 0 {
					c.headerCounter = 8
					smeter := c.computeSmeter()
					frame = append(frame, byte(0xF0|((smeter>>8)&0x0F)), byte(smeter&0xFF))
				}

				// FEAT-6: tag 0x85 AM-Sync status when mode=2
				if curMode == 2 {
					c.amSyncFrameCounter++
					amTag := c.buildAMSyncTag()
					if amTag != nil {
						frame = append(frame, amTag...)
					}
				}

				if isMuted {
					frame = append(frame, 0x84)
					if err := c.sendBinary(frame); err != nil {
						return
					}
					continue
				}

				var scale float32
				if agcMode == 1 {
					scale = c.adpcm.UpdateAGC(chunk)
				} else {
					scale = ManualScale(gainDB)
				}

				// FEAT-5: squelch threshold (ratio-based, §3.6)
				const squelchThreshold = 0.1
				audioPayload, sqResult := c.adpcm.Encode(chunk, scale, squelchOn, squelchThreshold)
				if sqResult == SquelchClosed {
					frame = append(frame, 0x84)
					if err := c.sendBinary(frame); err != nil {
						return
					}
					continue
				}
				frame = append(frame, audioPayload...)

				if err := c.sendBinary(frame); err != nil {
					return
				}
			}
		}
	}
}

// buildAMSyncTag builds tag 0x85 if it should be emitted this frame (FEAT-6).
func (c *websdrConn) buildAMSyncTag() []byte {
	if c.amSyncFrameCounter < 64 {
		return nil
	}
	c.amSyncFrameCounter = 0

	status := 0
	c.mu.RLock()
	tuneKHz := c.tuneKHz
	c.mu.RUnlock()
	freqMHz := uint64(tuneKHz * 1e6)

	if status == c.amSyncLastStatus && freqMHz == c.amSyncLastFreqMHz {
		return nil
	}
	c.amSyncLastStatus = status
	c.amSyncLastFreqMHz = freqMHz

	tag := make([]byte, 7)
	tag[0] = 0x85
	tag[1] = byte((status << 4) | int((freqMHz>>40)&0x0F))
	tag[2] = byte((freqMHz >> 32) & 0xFF)
	tag[3] = byte((freqMHz >> 24) & 0xFF)
	tag[4] = byte((freqMHz >> 16) & 0xFF)
	tag[5] = byte((freqMHz >> 8) & 0xFF)
	tag[6] = byte(freqMHz & 0xFF)
	return tag
}

func (c *websdrConn) computeSmeter() uint16 {
	if c.session == nil {
		return 0
	}
	if radiodCtrl := c.handler.sessions.radiod; radiodCtrl != nil {
		if cs := radiodCtrl.GetChannelStatus(c.session.SSRC); cs != nil {
			// BasebandPower is in dBFS (e.g. -80.0).
			// The browser displays: dB = smeter/10 - 127
			// So smeter = (dbfs + 127) * 10 maps dBFS directly to the display.
			// -127 dBFS → 0   → displayed -127 dB (noise floor / no signal)
			//  -80 dBFS → 470 → displayed  -80 dB
			//    0 dBFS → 1270 → displayed   0 dB
			dbfs := float64(cs.BasebandPower)
			smeterEnc := int((dbfs + 127.0) * 10.0)
			if smeterEnc < 0 {
				smeterEnc = 0
			}
			if smeterEnc > 0x0FFF {
				smeterEnc = 0x0FFF
			}
			return uint16(smeterEnc)
		}
	}
	return 0
}

func pcmBytesToFloat32(data []byte) []float32 {
	n := len(data) / 2
	out := make([]float32, n)
	for i := 0; i < n; i++ {
		s := int16(binary.BigEndian.Uint16(data[i*2:]))
		out[i] = float32(s) / 32768.0
	}
	return out
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
	c.wfBand = bandIdx
	c.wfWidth = 1024
	c.wfFormat = 9

	// Send init frames (§4.2)
	frame1, frame2 := WebSDRWaterfallInitFrames(0, 0, c.wfWidth)
	if err := c.sendBinary(frame1); err != nil {
		conn.Close()
		return
	}
	if err := c.sendBinary(frame2); err != nil {
		conn.Close()
		return
	}

	// BUG-C: Use the same userSessionID as the audio session so that audio and
	// waterfall connections from the same browser appear as one user in the
	// session list (mirrors KiwiSDR's timestamp+IP shared-UUID scheme).
	userSessionID := fmt.Sprintf("websdr-%s", clientIP)
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
	slowCounter := 0
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

			c.mu.RLock()
			slow := c.wfSlow
			wfWidth := c.wfWidth
			c.mu.RUnlock()

			if slow < 1 {
				slow = 1
			}
			slowCounter++
			if slowCounter < slow {
				continue
			}
			slowCounter = 0

			if wfWidth < 1 {
				wfWidth = 1024
			}

			// Convert spectrum to pixels (BUG-2 fix inside spectrumToPixels)
			// SpectrumChan is chan []float32, so pkt IS the []float32 slice
			pixels := spectrumToPixels(pkt, wfWidth, c.handler)

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

// websdrXOREmail XOR-obfuscates an email address for org_info output (MINOR-21).
// Each byte is XORed with 0x5A and the result is hex-encoded.
func websdrXOREmail(email string) string {
	if email == "" {
		return ""
	}
	var sb strings.Builder
	for i := 0; i < len(email); i++ {
		sb.WriteString(fmt.Sprintf("%02x", email[i]^0x5A))
	}
	return sb.String()
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~orgstatus (§6.5)
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleOrgStatus(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	// Use Admin config for server identity; WebSDR-specific fields from Server config
	serverName := jsEscape(h.config.Admin.Name)
	if serverName == "" {
		serverName = jsEscape(h.config.Admin.Description)
	}
	location := jsEscape(h.config.Admin.Location)
	antenna := jsEscape(h.config.Admin.Antenna)
	sdrHW := jsEscape(h.config.Server.WebSDROrgInfo)
	adminEmail := websdrXOREmail(h.config.Admin.Email) // MINOR-21

	// Band info: one entry per configured band
	// Band struct has: Label, Start, End, Group, Mode
	var bandInfoSB strings.Builder
	bandInfoSB.WriteString("bands_info=[")
	for i, b := range h.config.Bands {
		if i > 0 {
			bandInfoSB.WriteString(",")
		}
		midFreq := (b.Start + b.End) / 2
		bandInfoSB.WriteString(fmt.Sprintf(
			`{"name":"%s","lo":%d,"hi":%d,"tune":%d}`,
			jsEscape(b.Label),
			int(b.Start),
			int(b.End),
			int(midFreq),
		))
	}
	bandInfoSB.WriteString("];\n")

	maxUsers := h.config.Server.WebSDRMaxUsers
	if maxUsers == 0 {
		maxUsers = h.config.Server.MaxSessions
	}

	fmt.Fprintf(w, "org_info={")
	fmt.Fprintf(w, `"name":"%s",`, serverName)
	fmt.Fprintf(w, `"loc":"%s",`, location)
	fmt.Fprintf(w, `"ant":"%s",`, antenna)
	fmt.Fprintf(w, `"sdr":"%s",`, sdrHW)
	fmt.Fprintf(w, `"email":"%s",`, adminEmail)
	fmt.Fprintf(w, `"users":%d,`, atomic.LoadInt32(&h.audioUserCount))
	fmt.Fprintf(w, `"maxusers":%d`, maxUsers)
	fmt.Fprintf(w, "};\n")
	fmt.Fprintf(w, "%s", bandInfoSB.String())
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~othersj (§6.2) — legacy user list + stats
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleOthersJ(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	clientChseq, _ := strconv.Atoi(r.URL.Query().Get("chseq"))
	currentChseq := h.chseq.get()

	users := h.getUsers()
	userCount := len(users)

	// MINOR-19: correct stats format with real user count
	fmt.Fprintf(w, "users_chseq=%d;\n", currentChseq)
	fmt.Fprintf(w, "users_tot=%d;\n", userCount)
	fmt.Fprintf(w, "users_cpu=0;\n")
	fmt.Fprintf(w, "users_bw=0;\n")

	// FEAT-11: emit only users whose uu_chseq > clientChseq (incremental)
	fmt.Fprintf(w, "users_uu=[\n")
	first := true
	for _, u := range users {
		if u.uuChseq <= clientChseq {
			continue
		}
		if !first {
			fmt.Fprintf(w, ",\n")
		}
		first = false
		// MINOR-22: use u.username (from /~~param?name=)
		displayName := u.username
		if displayName == "" {
			displayName = maskIP(u.clientIP)
		}
		freqKHz := websdrNormFreq(u.tuneKHz)
		fmt.Fprintf(w, `[%d,"%s",%s,%d]`,
			u.uuChseq,
			jsEscape(displayName),
			freqKHz,
			u.band,
		)
	}
	fmt.Fprintf(w, "\n];\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// /~~othersjj (§6.3) — compact user list
// ─────────────────────────────────────────────────────────────────────────────

func (h *WebSDRHandler) handleOthersJJ(w http.ResponseWriter, r *http.Request) {
	noCacheHeaders(w)
	w.Header().Set("Content-Type", "application/javascript")

	users := h.getUsers()
	currentChseq := h.chseq.get()

	fmt.Fprintf(w, "uu_chseq=%d;\n", currentChseq)
	fmt.Fprintf(w, "uu_n=%d;\n", len(users))
	fmt.Fprintf(w, "uu=[\n")
	for i, u := range users {
		if i > 0 {
			fmt.Fprintf(w, ",\n")
		}
		// MINOR-22: use u.username
		displayName := u.username
		if displayName == "" {
			displayName = maskIP(u.clientIP)
		}
		freqKHz := websdrNormFreq(u.tuneKHz)
		fmt.Fprintf(w, `[%d,"%s",%s,%d]`,
			u.uuChseq,
			jsEscape(displayName),
			freqKHz,
			u.band,
		)
	}
	fmt.Fprintf(w, "\n];\n")
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
		if len(name) > 31 {
			name = name[:31]
		}
		if len(text) > 200 {
			text = text[:200]
		}
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
		centerKHz := startKHz + bwKHz/2.0
		vfoKHz := centerKHz + 10.0 // default VFO 10 kHz above centre

		// tuningstep: 1/32 kHz (31.25 Hz), matching real WebSDR default
		tuningStep := 1.0 / 32.0

		// maxlinbw: half the sample rate, capped at 4 kHz (real WebSDR convention)
		maxLinBW := bwKHz / 2.0
		if maxLinBW > 4.0 {
			maxLinBW = 4.0
		}

		// maxzoom: 3 gives 8× zoom (2^3), sufficient for most bands
		maxZoom := 3

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
			numImgs := 1 << uint(z) // zoom 0→1 img, zoom 1→2 imgs, zoom 2→4, zoom 3→8
			fmt.Fprintf(w, "      [")
			for img := 0; img < numImgs; img++ {
				if img > 0 {
					fmt.Fprintf(w, ",")
				}
				fmt.Fprintf(w, `"scaleblack.png"`)
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

// serveStaticFile serves a file from the two-directory search path.
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

// maskIP masks the last octet of an IPv4 address for privacy.
func maskIP(ip string) string {
	// Strip port if present
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	parts := strings.Split(ip, ".")
	if len(parts) == 4 {
		return parts[0] + "." + parts[1] + "." + parts[2] + ".xxx"
	}
	// IPv6: mask last 16 chars
	if len(ip) > 8 {
		return ip[:len(ip)-4] + "xxxx"
	}
	return ip
}

// websdrUserColors returns a CSS class name for alternating row colours.
func websdrUserColors(idx int) string {
	colors := []string{"row-even", "row-odd"}
	return colors[idx%len(colors)]
}
