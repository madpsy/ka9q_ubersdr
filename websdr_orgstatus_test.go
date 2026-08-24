package main

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// startTestWebSDRRouter starts websdrTCPRouter on an ephemeral port with a
// minimal handler and returns the address plus a cleanup func.
func startTestWebSDRRouter(t *testing.T) (string, *WebSDRHandler, func()) {
	t.Helper()

	handler := &WebSDRHandler{
		sessions: &SessionManager{},
		config:   &Config{},
		chseq:    newWebSDRChseq(),
		chat:     &websdrChatStore{},
	}
	handler.config.Admin.Antenna = "Test Antenna"

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cl := newChannelListener(ln.Addr())
	srv := &http.Server{Handler: http.NotFoundHandler()}
	go srv.Serve(cl)
	go websdrTCPRouter(ln, cl, handler)

	return ln.Addr().String(), handler, func() {
		srv.Close()
		cl.Close()
		ln.Close()
	}
}

// orgStatusRequest builds the exact request websdr.org sends.
func orgStatusRequest(config string) []byte {
	return []byte("GET /~~orgstatus?config=" + config + "&token=0 HTTP/1.1\r\n\r\n")
}

// TestWebSDROrgStatusKeepAlive covers the second failure mode reported against
// the directory callback: after the first /~~orgstatus response, a follow-up
// request on the SAME socket must also be answered — with the raw body only,
// no HTTP framing.
func TestWebSDROrgStatusKeepAlive(t *testing.T) {
	addr, _, cleanup := startTestWebSDRRouter(t)
	defer cleanup()

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// ── First request: expect a full HTTP response with the config body ──
	if _, err := conn.Write(orgStatusRequest("0")); err != nil {
		t.Fatalf("write: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("first response: %v", err)
	}
	body := make([]byte, resp.ContentLength)
	if _, err := readFull(br, body); err != nil {
		t.Fatalf("first body: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("first status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Server"); got != websdrServerVersion {
		t.Errorf("Server header = %q, want %q", got, websdrServerVersion)
	}
	text := string(body)
	for _, want := range []string{"Config: ", "Bands: 1", "Band: 0 15005.000000 29990.000000", "Users: 0"} {
		if !strings.Contains(text, want) {
			t.Errorf("first body missing %q; got:\n%s", want, text)
		}
	}

	// The directory echoes this serial back on subsequent polls.
	serial := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "Config: ") {
			serial = strings.TrimSpace(strings.TrimPrefix(line, "Config: "))
		}
	}
	if serial == "" || serial != strconv.Itoa(orgStatusSerial) {
		t.Fatalf("Config serial = %q, want %d", serial, orgStatusSerial)
	}

	// ── Follow-up on the SAME connection: raw "Users: N\n", no framing ──
	for i := 0; i < 3; i++ {
		if _, err := conn.Write(orgStatusRequest(serial)); err != nil {
			t.Fatalf("keep-alive write %d: %v", i, err)
		}
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		buf := make([]byte, 256)
		n, err := br.Read(buf)
		if err != nil {
			t.Fatalf("keep-alive read %d: %v (connection closed after first request?)", i, err)
		}
		got := string(buf[:n])
		if got != "Users: 0\n" {
			t.Fatalf("keep-alive response %d = %q, want %q (raw body, no HTTP headers)", i, got, "Users: 0\n")
		}
	}
}

// TestWebSDROrgStatusIdleCallback covers the first failure mode: websdr.org
// opens the callback connection and then sits IDLE for roughly 60 s before
// sending its first request. A short first-request deadline closed the socket
// before the directory ever spoke, and the receiver never got listed.
//
// This test necessarily takes ~35 s (it must outlast the old 30 s deadline),
// so it is skipped under -short.
func TestWebSDROrgStatusIdleCallback(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping 35s idle-callback test in -short mode")
	}
	if websdrFirstRequestTimeout < 90*time.Second {
		t.Fatalf("websdrFirstRequestTimeout = %v, too short for the websdr.org "+
			"callback which idles ~60s before its first request", websdrFirstRequestTimeout)
	}

	addr, _, cleanup := startTestWebSDRRouter(t)
	defer cleanup()

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Idle past the old 30 s deadline without sending a byte.
	const idle = 35 * time.Second
	time.Sleep(idle)

	if _, err := conn.Write(orgStatusRequest("0")); err != nil {
		t.Fatalf("write after %v idle: %v (connection closed while idle?)", idle, err)
	}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("response after %v idle: %v (connection closed while idle?)", idle, err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status after idle = %d, want 200", resp.StatusCode)
	}
	body := make([]byte, resp.ContentLength)
	if _, err := readFull(br, body); err != nil {
		t.Fatalf("body after idle: %v", err)
	}
	if !bytes.Contains(body, []byte("Config: ")) {
		t.Fatalf("body after idle missing Config:; got:\n%s", body)
	}
}

// TestWebSDROrgRegistrarRequestBytes pins the exact registration request sent
// to websdr.org. The directory server is idiosyncratic; this is the byte
// sequence observed to produce a listing, so a change here is a change in
// externally-visible behaviour.
func TestWebSDROrgRegistrarRequestBytes(t *testing.T) {
	host, port := "sdr.example.com", 12345
	got := "GET /~~websdrorg?host=" + host + "&port=" + strconv.Itoa(port) +
		" HTTP/1.1\r\nHost: " + websdrOrgServer + "\r\n\r\n"
	want := fmt.Sprintf("GET /~~websdrorg?host=%s&port=%d HTTP/1.1\r\nHost: websdr.ewi.utwente.nl\r\n\r\n", host, port)
	if got != want {
		t.Errorf("registration request =\n%q\nwant\n%q", got, want)
	}
	if strings.Contains(got, "User-Agent") || strings.Contains(got, "Accept-Encoding") {
		t.Error("registration request must stay minimal: no User-Agent, no Accept-Encoding")
	}
}

func readFull(br *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := br.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// ── Registrar reply handling ────────────────────────────────────────────────

// fakeDirectory runs a one-connection stand-in for websdr.ewi.utwente.nl.
// reply is written in response to each request it reads; if closeAfter is
// true it closes the connection immediately after replying.
func fakeDirectory(t *testing.T, reply string, closeAfter bool) (net.Conn, func()) {
	t.Helper()
	// Keep these tests quick; the production value is 5s.
	prev := websdrOrgReplyTimeout
	websdrOrgReplyTimeout = 150 * time.Millisecond
	t.Cleanup(func() { websdrOrgReplyTimeout = prev })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv, err := ln.Accept()
		if err != nil {
			return
		}
		defer srv.Close()
		buf := make([]byte, 4096)
		for {
			// Generous: the client spends websdrOrgReplyTimeout draining
			// after each reply before it sends the next ping.
			srv.SetReadDeadline(time.Now().Add(30 * time.Second))
			if _, err := srv.Read(buf); err != nil {
				return
			}
			if reply != "" {
				srv.Write([]byte(reply))
			}
			if closeAfter {
				return
			}
		}
	}()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn, func() { conn.Close(); ln.Close(); <-done }
}

func TestRegistrarPingDrainsLongReply(t *testing.T) {
	// A realistic reply with headers, comfortably over a 256-byte read.
	reply := "HTTP/1.1 200 OK\r\nDate: Mon, 24 Aug 2026 12:00:00 GMT\r\n" +
		"Server: Apache/2.4.62 (Debian) OpenSSL/3.0.15 mod_perl/2.0.13 Perl/v5.36.0\r\n" +
		"X-Padding: " + strings.Repeat("p", 300) + "\r\n" +
		"Content-Type: text/plain\r\nContent-Length: 3\r\n\r\nok\n"
	if len(reply) <= 256 {
		t.Fatalf("test reply is only %d bytes; must exceed 256 to be meaningful", len(reply))
	}

	conn, cleanup := fakeDirectory(t, reply, false)
	defer cleanup()

	reg := NewWebSDROrgRegistrar(&Config{})
	req := []byte("GET /~~websdrorg?host=h&port=1 HTTP/1.1\r\nHost: x\r\n\r\n")

	if !reg.sendPing(conn, req, 1) {
		t.Fatal("first ping reported the connection dead")
	}

	// The real assertion: nothing may be left buffered. Leftover bytes would
	// be read as the NEXT ping's reply (desynchronising every subsequent log
	// line) and would accumulate until the receive window stalled.
	conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	leftover := make([]byte, 4096)
	n, err := conn.Read(leftover)
	if n > 0 {
		t.Fatalf("%d bytes left unread after sendPing (reply was %d bytes): %q…",
			n, len(reply), string(leftover[:min(n, 60)]))
	}
	if !websdrOrgIsTimeout(err) {
		t.Fatalf("connection unusable after sendPing: %v", err)
	}

	// And the connection is still good for further pings.
	for i := 2; i <= 3; i++ {
		if !reg.sendPing(conn, req, i) {
			t.Fatalf("ping #%d reported the connection dead", i)
		}
	}
}

func TestRegistrarPingReconnectsWhenServerCloses(t *testing.T) {
	// Server replies and then closes: the reply is usable, but the connection
	// must not be reused.
	conn, cleanup := fakeDirectory(t, "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok\n", true)
	defer cleanup()

	reg := NewWebSDROrgRegistrar(&Config{})
	req := []byte("GET /~~websdrorg?host=h&port=1 HTTP/1.1\r\nHost: x\r\n\r\n")

	if reg.sendPing(conn, req, 1) {
		t.Error("sendPing kept a connection the server had closed")
	}
}

func TestRegistrarPingSilentServerIsNotAFailure(t *testing.T) {
	// The directory often stays silent on a reused connection. That must not
	// be treated as an error, or we would reconnect every single minute.
	conn, cleanup := fakeDirectory(t, "", false)
	defer cleanup()

	reg := NewWebSDROrgRegistrar(&Config{})
	req := []byte("GET /~~websdrorg?host=h&port=1 HTTP/1.1\r\nHost: x\r\n\r\n")

	if !reg.sendPing(conn, req, 1) {
		t.Error("a silent (but open) directory connection was treated as dead")
	}
}

func TestRegistrarEndpointRejectsPlaceholders(t *testing.T) {
	cases := []struct {
		name     string
		hostname string
		pubURL   string
		port     int
		wantOK   bool
		wantHost string
	}{
		{"explicit hostname", "sdr.example.net", "", 8901, true, "sdr.example.net"},
		{"derived from public_url", "", "https://sdr.example.net/path", 8901, true, "sdr.example.net"},
		{"public_url with port", "", "https://sdr.example.net:8443", 8901, true, "sdr.example.net"},
		{"default placeholder rejected", "", "https://example.com", 8901, false, ""},
		{"no hostname at all", "", "", 8901, false, ""},
		{"bad port", "sdr.example.net", "", 0, false, ""},
		{"port out of range", "sdr.example.net", "", 70000, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &Config{}
			cfg.Server.WebSDRHostname = tc.hostname
			cfg.Admin.PublicURL = tc.pubURL
			cfg.Server.WebSDRTCPPort = tc.port
			host, _, ok := NewWebSDROrgRegistrar(cfg).endpoint()
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if ok && host != tc.wantHost {
				t.Errorf("host = %q, want %q", host, tc.wantHost)
			}
		})
	}
}
