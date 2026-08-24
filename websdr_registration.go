package main

// websdr_registration.go — websdr.org public directory registration
//
// The websdr.org directory listing is a two-phase protocol, and both phases
// must work or the receiver never appears:
//
//   1. Registration (this file, outbound).  We send
//        GET /~~websdrorg?host=<PUBLIC_HOST>&port=<PUBLIC_PORT> HTTP/1.1
//      to websdr.ewi.utwente.nl:80 every 60 s.  The directory answers
//      "200 OK / ok" — which only means the ping was accepted, NOT that the
//      receiver will be listed.
//
//   2. Callback (websdr_websocket.go, inbound).  The directory then opens a
//      TCP connection back to the advertised host:port, idles ~60 s, sends
//      GET /~~orgstatus?config=0&token=0, and reuses that SAME socket for
//      follow-up status requests roughly every 10 s.  websdrHandleOrgStatusRaw
//      implements that; websdrFirstRequestTimeout covers the idle period.
//
// This registrar deliberately speaks raw sockets rather than net/http, and
// sends a minimal two-line request with no User-Agent and no Accept-Encoding.
// That is the exact byte sequence observed to produce a listing (previously
// via an external Python shim, since removed — see git history).  The
// directory server is old and idiosyncratic; do not "modernise" this to an
// http.Client without re-testing an actual listing end to end.

import (
	"errors"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	websdrOrgServer = "websdr.ewi.utwente.nl"
	websdrOrgPort   = 80

	// Timings carried over from the external shim this replaced, which was
	// observed to hold a listing reliably.
	websdrOrgPingInterval = 60 * time.Second
	websdrOrgReconnectDly = 30 * time.Second
	websdrOrgTimeout      = 15 * time.Second
)

// websdrOrgReplyTimeout is how long we listen for a reply after each ping.
// A var, not a const, only so tests can shorten it; production must keep the
// shim's proven 5 s.
var websdrOrgReplyTimeout = 5 * time.Second

// WebSDROrgRegistrar keeps this instance registered with the websdr.org public
// receiver directory.  It holds one long-lived TCP connection to the directory
// server and re-sends the registration ping on it periodically, reconnecting
// on any error.
//
// It is independent of every other subsystem and only needs the global Config.
type WebSDROrgRegistrar struct {
	config *Config

	stopOnce sync.Once
	stop     chan struct{}
}

// NewWebSDROrgRegistrar creates a registrar.  Call Start() to begin.
func NewWebSDROrgRegistrar(config *Config) *WebSDROrgRegistrar {
	return &WebSDROrgRegistrar{
		config: config,
		stop:   make(chan struct{}),
	}
}

// Start launches the registration goroutine (non-blocking).
func (w *WebSDROrgRegistrar) Start() {
	go w.loop()
}

// Stop signals the registration goroutine to exit.  Safe to call more than
// once.
func (w *WebSDROrgRegistrar) Stop() {
	w.stopOnce.Do(func() { close(w.stop) })
}

// sleep waits for d, returning false if the registrar was stopped first.
func (w *WebSDROrgRegistrar) sleep(d time.Duration) bool {
	select {
	case <-w.stop:
		return false
	case <-time.After(d):
		return true
	}
}

// publicHostname returns the hostname to advertise to websdr.org: the
// explicit server.websdr_hostname if set, otherwise the host part of
// admin.public_url.
func (w *WebSDROrgRegistrar) publicHostname() string {
	if h := strings.TrimSpace(w.config.Server.WebSDRHostname); h != "" {
		return h
	}
	u := strings.TrimSpace(w.config.Admin.PublicURL)
	if u == "" {
		return ""
	}
	u = strings.TrimPrefix(u, "https://")
	u = strings.TrimPrefix(u, "http://")
	if idx := strings.Index(u, "/"); idx >= 0 {
		u = u[:idx]
	}
	if host, _, err := net.SplitHostPort(u); err == nil {
		return host
	}
	return u
}

// endpoint returns the public host and port to advertise, or ok=false if the
// configuration is incomplete.
func (w *WebSDROrgRegistrar) endpoint() (host string, port int, ok bool) {
	host = w.publicHostname()
	if host == "" || host == "example.com" {
		// example.com is the built-in admin.public_url default; registering
		// it would advertise an endpoint that cannot be reached.
		return "", 0, false
	}
	port = w.config.Server.WebSDRTCPPort
	if port <= 0 || port > 65535 {
		return "", 0, false
	}
	return host, port, true
}

func (w *WebSDROrgRegistrar) loop() {
	host, port, ok := w.endpoint()
	if !ok {
		log.Printf("websdr.org: registration skipped — set server.websdr_hostname " +
			"to your public hostname (and server.websdr_tcp_port to the port " +
			"reachable from the internet)")
		return
	}

	// The request is built once: host and port come from config and do not
	// change while the process runs.  No User-Agent, no Accept-Encoding —
	// see the file header.
	req := []byte("GET /~~websdrorg?host=" + host + "&port=" + strconv.Itoa(port) +
		" HTTP/1.1\r\nHost: " + websdrOrgServer + "\r\n\r\n")

	log.Printf("websdr.org: registering %s:%d every %s", host, port, websdrOrgPingInterval)

	var conn net.Conn
	defer func() {
		if conn != nil {
			conn.Close()
		}
	}()

	attempt := 0
	for {
		select {
		case <-w.stop:
			return
		default:
		}

		if conn == nil {
			c, err := net.DialTimeout("tcp",
				net.JoinHostPort(websdrOrgServer, strconv.Itoa(websdrOrgPort)),
				websdrOrgTimeout)
			if err != nil {
				log.Printf("websdr.org: connection failed: %v — retrying in %s",
					err, websdrOrgReconnectDly)
				if !w.sleep(websdrOrgReconnectDly) {
					return
				}
				continue
			}
			conn = c
			log.Printf("websdr.org: connected to %s:%d", websdrOrgServer, websdrOrgPort)
		}

		if !w.sendPing(conn, req, attempt+1) {
			conn.Close()
			conn = nil
			if !w.sleep(websdrOrgReconnectDly) {
				return
			}
			continue
		}
		attempt++

		if !w.sleep(websdrOrgPingInterval) {
			return
		}
	}
}

// sendPing writes one registration request and consumes whatever reply
// arrives promptly.  It returns false if the connection is dead and must be
// replaced.
//
// The directory does not always answer on a reused connection, so a read
// timeout is normal and is NOT a failure.  Whatever does arrive is fully
// drained: leaving unread bytes in the socket would desynchronise the next
// ping's reply and, over a long uptime, stall the connection once the receive
// window filled.
func (w *WebSDROrgRegistrar) sendPing(conn net.Conn, req []byte, attempt int) bool {
	conn.SetWriteDeadline(time.Now().Add(websdrOrgTimeout))
	if _, err := conn.Write(req); err != nil {
		log.Printf("websdr.org: ping #%d write error: %v — reconnecting", attempt, err)
		return false
	}

	conn.SetReadDeadline(time.Now().Add(websdrOrgReplyTimeout))
	reply, err := drainReply(conn)

	if len(reply) == 0 {
		if websdrOrgIsTimeout(err) {
			log.Printf("websdr.org: ping #%d sent (no immediate response — normal)", attempt)
			return true
		}
		// EOF or a hard error with nothing to show for it.
		log.Printf("websdr.org: ping #%d error: %v — reconnecting", attempt, err)
		return false
	}

	status := strings.SplitN(strings.TrimSpace(string(reply)), "\r\n", 2)[0]
	if strings.Contains(status, "200") {
		log.Printf("websdr.org: ping #%d registration OK — %s", attempt, status)
	} else {
		// Not fatal on its own, but the directory rejecting the ping is the
		// single most useful thing to see when a listing fails to appear.
		log.Printf("websdr.org: ping #%d UNEXPECTED reply — %s", attempt, status)
	}

	// The server sent a reply and then closed: use it, but reconnect.
	if err != nil && !websdrOrgIsTimeout(err) {
		log.Printf("websdr.org: connection closed by server after ping #%d — reconnecting", attempt)
		return false
	}
	return true
}

// drainReply reads until the read deadline expires or the peer closes,
// returning everything received.  The returned error is the one that ended the
// read: a timeout means "peer is still connected, just done talking".
func drainReply(conn net.Conn) ([]byte, error) {
	var reply []byte
	buf := make([]byte, 1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			// Cap what we retain; the status line is all we log, and a
			// pathological responder must not grow this without bound.
			if len(reply) < 4096 {
				reply = append(reply, buf[:n]...)
			}
		}
		if err != nil {
			return reply, err
		}
	}
}

// websdrOrgIsTimeout reports whether err is a network timeout (as opposed to
// EOF or a hard failure).
func websdrOrgIsTimeout(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return false
}
