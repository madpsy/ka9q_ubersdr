package hpsdr

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/pcmv4/v4enc"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// ---- a fake UberSDR server ------------------------------------------------
//
// It holds the bridge to what the real one enforces -- a /connection precheck
// with the same User-Agent before the socket, a known session ID, the wide mode
// gate -- and it encodes with the server's own version 4 encoder, so what the
// bridge decodes is what a real server would have sent.

type fakeConn struct {
	query  url.Values
	ua     string
	tunes  chan map[string]any
	closed chan struct{}
	kill   chan struct{}
}

type fakeServer struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	sessions map[string]string // session -> User-Agent at /connection
	checks   []map[string]string

	// What /connection answers. Allowed modes nil means the field is absent.
	allow       bool
	status      int
	reason      string
	bypassed    bool
	allowedIQ   []string
	description string

	// serveKHz, when set, is the rate served whatever was asked, and
	// switchKHzAfter switches to switchKHz after that many packets.
	serveKHz       int
	switchKHz      int
	switchAfter    int
	legacy         bool
	packetSamples  int
	packetInterval time.Duration

	conns chan *fakeConn
}

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{
		t: t, sessions: map[string]string{}, allow: true, status: 200,
		allowedIQ:      []string{"iq48", "iq96", "iq192", "iq384"},
		packetSamples:  256,
		packetInterval: 2 * time.Millisecond,
		conns:          make(chan *fakeConn, 32),
		description:    `{"receiver":{"name":"Test","callsign":"T3ST"},"tuning_range":{"min_frequency":10000,"max_frequency":30000000}}`,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/connection", f.connection)
	mux.HandleFunc("/api/description", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(f.description))
	})
	mux.HandleFunc("/ws", f.ws)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) set(fn func(*fakeServer)) {
	f.mu.Lock()
	fn(f)
	f.mu.Unlock()
}

func (f *fakeServer) connection(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	f.checks = append(f.checks, body)
	resp := map[string]any{"allowed": f.allow, "bypassed": f.bypassed}
	if f.reason != "" {
		resp["reason"] = f.reason
	}
	if f.allowedIQ != nil {
		resp["allowed_iq_modes"] = f.allowedIQ
	}
	if f.allow {
		f.sessions[body["user_session_id"]] = r.UserAgent()
	}
	status := f.status
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func (f *fakeServer) ws(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer c.Close()
	q := r.URL.Query()
	fc := &fakeConn{query: q, ua: r.UserAgent(), tunes: make(chan map[string]any, 16),
		closed: make(chan struct{}), kill: make(chan struct{})}
	defer close(fc.closed)

	f.mu.Lock()
	ua, known := f.sessions[q.Get("user_session_id")]
	allowed := f.allowedIQ
	serve, switchKHz, switchAfter, legacy := f.serveKHz, f.switchKHz, f.switchAfter, f.legacy
	per, every := f.packetSamples, f.packetInterval
	f.mu.Unlock()
	f.conns <- fc

	// What the real server refuses, refused the way it refuses it.
	if !known || ua != r.UserAgent() {
		_ = c.WriteJSON(map[string]string{"type": "error", "error": "Invalid session. Please refresh the page and try again."})
		return
	}
	mode := q.Get("mode")
	if allowed != nil && !contains(allowed, mode) {
		_ = c.WriteJSON(map[string]string{"type": "error", "error": "Mode '" + mode + "' is only available for authorized IPs or with valid password"})
		return
	}
	khz := ubersdr.KHzForMode(mode)
	if serve != 0 {
		khz = serve
	}
	_ = c.WriteJSON(map[string]any{"type": "status", "mode": fmt.Sprintf("iq%d", khz), "sampleRate": khz * 1000})

	go func() {
		for {
			var m map[string]any
			if err := c.ReadJSON(&m); err != nil {
				return
			}
			fc.tunes <- m
		}
	}()

	var shift uint
	if q.Get("min_margin") != "" {
		shift = 2 // test samples are multiples of 4, so this is exact
	}
	enc := v4enc.New()
	k := 0
	tick := time.NewTicker(every)
	defer tick.Stop()
	for n := 0; ; n++ {
		select {
		case <-fc.kill:
			return
		case <-tick.C:
		}
		if switchAfter > 0 && n == switchAfter {
			khz = switchKHz
		}
		if legacy {
			if c.WriteMessage(websocket.BinaryMessage, []byte{0x28, 0xB5, 0x2F, 0xFD, 0, 0, 0, 0}) != nil {
				return
			}
			continue
		}
		samples := make([]int16, 2*per)
		for i := 0; i < per; i++ {
			samples[2*i], samples[2*i+1] = patternI(k), patternQ(k)
			k++
		}
		pkt, err := enc.Encode(samples, khz*1000, 2, shift)
		if err != nil {
			f.t.Errorf("encode: %v", err)
			return
		}
		if c.WriteMessage(websocket.BinaryMessage, pkt) != nil {
			return
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// The sample pattern: multiples of 4 so the reduced-depth path at shift 2 is
// exact, and different in I and Q so a swap shows.
func patternI(k int) int16 { return int16(((k*37)%16000 - 8000) * 4) }
func patternQ(k int) int16 { return int16(((k*91)%12000 - 6000) * 4) }

// expected is what the bridge must put on the wire for sample k at a rate: the
// C bridge's float32 arithmetic, truncated, with the imaginary part first.
func expected(k, khz int) (first, second int32) {
	scale := ScaleForKHz(khz)
	re := float32(patternI(k)) / 32768 * scale
	im := float32(patternQ(k)) / 32768 * scale
	return int32(im), int32(re)
}

func (f *fakeServer) nextConn(t *testing.T, timeout time.Duration) *fakeConn {
	t.Helper()
	select {
	case c := <-f.conns:
		return c
	case <-time.After(timeout):
		t.Fatal("no WebSocket connection arrived")
		return nil
	}
}

func (f *fakeServer) noConn(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case c := <-f.conns:
		t.Fatalf("unexpected WebSocket connection: %v", c.query)
	case <-time.After(d):
	}
}

// ---- a fake HPSDR client ---------------------------------------------------

type rxPkt struct {
	port int
	data []byte
}

type hpClient struct {
	t    *testing.T
	conn *net.UDPConn
	base int

	mu     sync.Mutex
	byPort map[int]chan []byte
}

func newClient(t *testing.T, base int) *hpClient {
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadBuffer(8 << 20)
	h := &hpClient{t: t, conn: c, base: base, byPort: map[int]chan []byte{}}
	t.Cleanup(func() { c.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, from, err := c.ReadFromUDP(buf)
			if err != nil {
				return
			}
			select {
			case h.ch(from.Port) <- append([]byte(nil), buf[:n]...):
			default: // a full queue drops, as a slow client would
			}
		}
	}()
	return h
}

func (h *hpClient) ch(port int) chan []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	c, ok := h.byPort[port]
	if !ok {
		c = make(chan []byte, 8192)
		h.byPort[port] = c
	}
	return c
}

func (h *hpClient) send(off int, b []byte) {
	h.t.Helper()
	if _, err := h.conn.WriteToUDP(b, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: h.base + off}); err != nil {
		h.t.Fatal(err)
	}
}

// recv waits for a packet from a bridge port.
func (h *hpClient) recv(off int, timeout time.Duration) []byte {
	h.t.Helper()
	select {
	case b := <-h.ch(h.base + off):
		return b
	case <-time.After(timeout):
		h.t.Fatalf("nothing from bridge port +%d within %s", off, timeout)
		return nil
	}
}

// drain empties a port's queue.
func (h *hpClient) drain(off int) {
	c := h.ch(h.base + off)
	for {
		select {
		case <-c:
		default:
			return
		}
	}
}

// quiet asserts nothing arrives from a port for d.
func (h *hpClient) quiet(off int, d time.Duration) {
	h.t.Helper()
	h.drain(off)
	select {
	case <-h.ch(h.base + off):
		// One may have been in flight when we drained; a second is a stream.
		select {
		case <-h.ch(h.base + off):
			h.t.Fatalf("bridge port +%d still sending", off)
		case <-time.After(d):
		}
	case <-time.After(d):
	}
}

func general(seq uint32, freqMode byte) []byte {
	b := make([]byte, 60)
	binary.BigEndian.PutUint32(b, seq)
	b[37] = freqMode
	return b
}

func ddcSpec(seq uint32, rates map[int]int) []byte {
	b := make([]byte, 1444)
	binary.BigEndian.PutUint32(b, seq)
	for i, r := range rates {
		b[7+i/8] |= 1 << (i % 8)
		binary.BigEndian.PutUint16(b[18+6*i:], uint16(r))
	}
	return b
}

func highPrio(seq uint32, run bool, freqs ...uint32) []byte {
	return hpPacketSeq(seq, run, freqs...)
}

func hpPacketSeq(seq uint32, run bool, words ...uint32) []byte {
	b := hpPacket(run, words...)
	binary.BigEndian.PutUint32(b, seq)
	return b
}

// ---- bridge under test ------------------------------------------------------

type logBuf struct {
	mu    sync.Mutex
	lines []string
}

func (l *logBuf) add(s string) {
	l.mu.Lock()
	l.lines = append(l.lines, s)
	l.mu.Unlock()
}

func (l *logBuf) has(sub string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, s := range l.lines {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func (l *logBuf) waitFor(t *testing.T, sub string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if l.has(sub) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("log never said %q", sub)
}

// startBridge runs a bridge against f on a free block of loopback ports.
func startBridge(t *testing.T, f *fakeServer, password string, mod func(*Config)) (*Bridge, *logBuf) {
	t.Helper()
	srv, err := ubersdr.NewServer(f.srv.URL, password)
	if err != nil {
		t.Fatal(err)
	}
	logs := &logBuf{}
	var b *Bridge
	for attempt := 0; attempt < 50; attempt++ {
		cfg := Config{
			Server: srv, NumRx: 2, Device: DeviceHermesLite, MinMargin: 26,
			MAC:      [6]byte{0x02, 1, 2, 3, 4, 5},
			BindIP:   net.IPv4(127, 0, 0, 1),
			BasePort: 20000 + rand.Intn(40000),
			Logf:     logs.add,
			Watchdog: 400 * time.Millisecond, ReconnectDelay: 30 * time.Millisecond,
			RetryDelay: 30 * time.Millisecond, RefusedDelay: 60 * time.Millisecond,
			IdleTimeout: 2 * time.Second,
		}
		if mod != nil {
			mod(&cfg)
		}
		b, err = New(cfg)
		if err == nil {
			break
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	b.Start()
	t.Cleanup(func() {
		b.Close()
		if t.Failed() {
			logs.mu.Lock()
			for _, l := range logs.lines {
				t.Log(l)
			}
			logs.mu.Unlock()
		}
	})
	return b, logs
}

func waitStatus(t *testing.T, b *Bridge, what string, cond func(Status) bool) Status {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s := b.Status(); cond(s) {
			return s
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("status never became %s: %+v", what, b.Status())
	return Status{}
}

func mustServer(t *testing.T, u string) *ubersdr.Server {
	t.Helper()
	s, err := ubersdr.NewServer(u, "")
	if err != nil {
		t.Fatal(err)
	}
	return s
}
