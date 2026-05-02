package main

// websdr_registration.go — websdr.org directory registration (§12.2)
//
// Implements the legacy websdr.org registration protocol (plain HTTP, ~60 s interval).
// Disabled by default; opt-in via config flag:
//   websdr_register_websdrorg: true   — register with websdr.org
//
// Protocol (mirrors the working Python bridge and original WebSDR binary):
//   1. Open a persistent TCP connection to websdr.ewi.utwente.nl:80.
//   2. Every ~60 s, send:
//        GET /~~websdrorg?host=<HOST>&port=<PORT> HTTP/1.1\r\n
//        Host: websdr.ewi.utwente.nl\r\n
//        \r\n
//   3. Read the response immediately (5 s timeout).
//   4. Keep the socket open for the next ping; reconnect only on error.
//
// websdr.org then sends GET /~~orgstatus requests on the SAME persistent TCP
// connection (the outbound registration socket), not on a new inbound connection.
// After reading the registration "ok" response, we hand the socket off to a
// goroutine that reads and responds to orgstatus requests on it.

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const (
	// websdrOrgRegistrationEnabled gates the built-in registration loop at
	// compile time.  The config-level flag websdr_register_websdrorg is
	// still checked at runtime; both must be true for the loop to start.
	// The /~~orgstatus handler uses connection hijacking to implement the
	// raw WebSDR keep-alive protocol, so no external proxy is needed.
	websdrOrgRegistrationEnabled = true

	websdrOrgRegInterval = 60 * time.Second
	websdrOrgHost        = "websdr.ewi.utwente.nl"
	websdrOrgReconnDelay = 30 * time.Second
	websdrOrgTimeout     = 15 * time.Second
)

// ─────────────────────────────────────────────────────────────────────────────
// WebSDRRegistrar — manages websdr.org registration
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRRegistrar runs the websdr.org background registration goroutine.
type WebSDRRegistrar struct {
	config  *Config
	handler *WebSDRHandler
	stop    chan struct{}
}

// NewWebSDRRegistrar creates a registrar. Call Start() to begin registration.
func NewWebSDRRegistrar(config *Config) *WebSDRRegistrar {
	return &WebSDRRegistrar{
		config: config,
		stop:   make(chan struct{}),
	}
}

// SetHandler sets the WebSDR handler used to respond to /~~orgstatus requests
// that websdr.org sends on the registration socket.  Must be called before Start().
func (reg *WebSDRRegistrar) SetHandler(h *WebSDRHandler) {
	reg.handler = h
}

// Start launches the registration goroutine (non-blocking).
// Both the compile-time constant websdrOrgRegistrationEnabled and the
// runtime config flag websdr_register_websdrorg must be true.
func (reg *WebSDRRegistrar) Start() {
	if !websdrOrgRegistrationEnabled {
		log.Printf("WebSDR: websdr.org registration disabled at compile time (websdrOrgRegistrationEnabled=false)")
		return
	}
	if reg.config.Server.WebSDRRegisterWebSDROrg {
		go reg.websdrOrgLoop()
	}
}

// Stop signals the registration goroutine to exit.
func (reg *WebSDRRegistrar) Stop() {
	close(reg.stop)
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.2 — Persistent registration loop
// ─────────────────────────────────────────────────────────────────────────────

func (reg *WebSDRRegistrar) websdrOrgLoop() {
	// Wait a few seconds before the first registration attempt so that the
	// WebSDR HTTP server is fully warmed up and ready to respond to the
	// /~~orgstatus requests that websdr.org sends on the registration socket.
	select {
	case <-reg.stop:
		return
	case <-time.After(2 * time.Second):
	}

	addr := net.JoinHostPort(websdrOrgHost, "80")

	listenPort := reg.publicPort()
	hostname := reg.publicHostname()

	// Build the registration request with Host header (required for HTTP/1.1).
	var reqLine string
	if hostname != "" {
		reqLine = fmt.Sprintf("GET /~~websdrorg?host=%s&port=%d HTTP/1.1\r\nHost: %s\r\n\r\n",
			hostname, listenPort, websdrOrgHost)
	} else {
		reqLine = fmt.Sprintf("GET /~~websdrorg?port=%d HTTP/1.1\r\nHost: %s\r\n\r\n",
			listenPort, websdrOrgHost)
	}

	for {
		select {
		case <-reg.stop:
			return
		default:
		}

		// Connect to websdr.org.
		dialer := &net.Dialer{Timeout: websdrOrgTimeout}
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			log.Printf("WebSDR: websdr.org registration connect error: %v", err)
			select {
			case <-reg.stop:
				return
			case <-time.After(websdrOrgReconnDelay):
			}
			continue
		}
		log.Printf("WebSDR: connected to %s", addr)

		// Send registration ping.
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err = fmt.Fprint(conn, reqLine)
		if err != nil {
			log.Printf("WebSDR: websdr.org registration write error: %v — reconnecting", err)
			conn.Close()
			select {
			case <-reg.stop:
				return
			case <-time.After(websdrOrgReconnDelay):
			}
			continue
		}

		// Read the registration response (5 s timeout) — mirrors Python bridge.
		// websdr.org responds with "HTTP/1.1 200 OK ... ok".
		// Any bytes beyond the response are leftover orgstatus request data.
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		respBuf := make([]byte, 4096)
		n, err := conn.Read(respBuf)
		_ = conn.SetReadDeadline(time.Time{}) // clear deadline — mirrors Python sock.settimeout(TIMEOUT)

		if err != nil && n == 0 {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				log.Printf("WebSDR: registration ping sent (no immediate response — normal)")
			} else {
				log.Printf("WebSDR: registration read error: %v — reconnecting", err)
				conn.Close()
				select {
				case <-reg.stop:
					return
				case <-time.After(websdrOrgReconnDelay):
				}
				continue
			}
		} else if n > 0 {
			respSnippet := sanitiseLogString(respBuf[:n], 120)
			log.Printf("WebSDR: registered with websdr.org (host=%s, port=%d) response: %q",
				hostname, listenPort, respSnippet)
		}

		// websdr.org sends /~~orgstatus requests on this same persistent TCP
		// connection (the outbound registration socket).  Hand the socket off
		// to a goroutine that reads and responds to those requests.
		// The goroutine runs until the connection is closed (by websdr.org or
		// by us reconnecting after 60 s).
		//
		// Any bytes already read beyond the registration response are passed
		// as leftover data to the orgstatus handler.
		var leftover []byte
		if n > 0 {
			// Find the end of the HTTP response headers+body in what we read.
			// The registration response is "HTTP/1.1 200 OK\r\n...\r\n\r\nok".
			// Anything after "ok" is the start of an orgstatus request.
			raw := respBuf[:n]
			// Find \r\n\r\n (end of headers) then skip Content-Length bytes.
			if hdrEnd := bytes.Index(raw, []byte("\r\n\r\n")); hdrEnd >= 0 {
				afterHeaders := raw[hdrEnd+4:]
				// Parse Content-Length to skip the body.
				contentLen := 0
				hdrSection := string(raw[:hdrEnd])
				for _, line := range strings.Split(hdrSection, "\r\n") {
					lower := strings.ToLower(line)
					if strings.HasPrefix(lower, "content-length:") {
						fmt.Sscanf(strings.TrimSpace(line[len("content-length:"):]), "%d", &contentLen)
					}
				}
				if contentLen > 0 && len(afterHeaders) > contentLen {
					leftover = afterHeaders[contentLen:]
				} else if contentLen == 0 {
					leftover = afterHeaders
				}
			}
		}

		// doneCh is closed when the orgstatus goroutine exits (connection closed).
		doneCh := make(chan struct{})
		connCopy := conn
		leftoverCopy := leftover
		go func() {
			defer close(doneCh)
			if reg.handler != nil {
				websdrHandleOrgStatusOnRegSocket(connCopy, leftoverCopy, reg.handler)
			} else {
				connCopy.Close()
			}
		}()

		// Wait for the orgstatus goroutine to finish OR for 60 s (whichever
		// comes first), then send the next registration ping on a new connection.
		// The Python bridge sends a new ping every 60 s regardless.
		select {
		case <-reg.stop:
			conn.Close()
			<-doneCh
			return
		case <-time.After(websdrOrgRegInterval):
			// Time for the next ping — close this connection and reconnect.
			conn.Close()
			<-doneCh
		case <-doneCh:
			// websdr.org closed the connection early — reconnect immediately.
			log.Printf("WebSDR: registration socket closed by remote — reconnecting")
		}
	}
}

// websdrHandleOrgStatusOnRegSocket handles /~~orgstatus requests that websdr.org
// sends on the outbound registration socket (the same TCP connection used for
// the /~~websdrorg ping).  This mirrors the Python proxy's handle_orgstatus()
// but is called on the registration socket rather than an inbound connection.
//
// The protocol is identical to websdrHandleOrgStatusRaw: the first request
// gets a full HTTP response; subsequent requests on the same connection get
// just the raw body text (no HTTP headers).
func websdrHandleOrgStatusOnRegSocket(conn net.Conn, leftover []byte, handler *WebSDRHandler) {
	// Note: websdrHandleOrgStatusRaw (called below) owns the conn lifetime
	// and calls conn.Close() via its own defer.  Do NOT close here.

	remoteAddr := conn.RemoteAddr().String()
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}

	log.Printf("WebSDR: reg-socket orgstatus handler started for %s (leftover=%d bytes)", remoteAddr, len(leftover))
	if len(leftover) > 0 {
		log.Printf("WebSDR: reg-socket leftover data from %s: %q", remoteAddr, sanitiseLogString(leftover, 200))
	}

	// Read the first /~~orgstatus request.  leftover may already contain
	// part or all of it (bytes read alongside the registration response).
	// websdr.org may send the request with \r\n\r\n (HTTP/1.1 with headers)
	// or with just \r\n (request line only, no headers).  Accept either.
	data := leftover
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		// Accept \r\n\r\n (standard HTTP) or a bare \r\n at end of line
		// (websdr.org sometimes sends just the request line with no headers).
		if bytes.Contains(data, []byte("\r\n\r\n")) {
			break
		}
		// Also accept a single \r\n if the data starts with "GET " —
		// websdr.org may send just the request line with no blank line.
		if bytes.HasPrefix(data, []byte("GET ")) && bytes.Contains(data, []byte("\r\n")) {
			// Normalise to \r\n\r\n so the downstream handler parses correctly.
			data = bytes.Replace(data, []byte("\r\n"), []byte("\r\n\r\n"), 1)
			break
		}
		tmp := make([]byte, 4096)
		n, err := conn.Read(tmp)
		if n > 0 {
			data = append(data, tmp[:n]...)
			log.Printf("WebSDR: reg-socket read %d bytes from %s: %q", n, remoteAddr, sanitiseLogString(tmp[:n], 200))
		}
		if err != nil {
			if len(data) > 0 {
				log.Printf("WebSDR: reg-socket orgstatus read error from %s after %d bytes: %v — data: %q",
					remoteAddr, len(data), err, sanitiseLogString(data, 200))
			} else {
				log.Printf("WebSDR: reg-socket orgstatus: no data from %s before close: %v", remoteAddr, err)
			}
			return
		}
	}
	conn.SetReadDeadline(time.Time{})

	log.Printf("WebSDR: reg-socket orgstatus request from %s: %q", remoteAddr, sanitiseLogString(data, 200))

	// Pass to the shared raw orgstatus handler which handles the full
	// keep-alive loop (first HTTP response + subsequent raw responses).
	websdrHandleOrgStatusRaw(conn, data, handler)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// publicHostname returns the configured public hostname for websdr.org registration.
func (reg *WebSDRRegistrar) publicHostname() string {
	if reg.config.Server.WebSDRHostname != "" {
		return reg.config.Server.WebSDRHostname
	}
	// Fall back to admin.public_url host
	if reg.config.Admin.PublicURL != "" {
		u := reg.config.Admin.PublicURL
		// Strip scheme
		u = strings.TrimPrefix(u, "https://")
		u = strings.TrimPrefix(u, "http://")
		// Strip path
		if idx := strings.Index(u, "/"); idx >= 0 {
			u = u[:idx]
		}
		// Strip port
		if host, _, err := net.SplitHostPort(u); err == nil {
			return host
		}
		return u
	}
	return ""
}

// publicPort returns the TCP port for websdr.org registration.
func (reg *WebSDRRegistrar) publicPort() int {
	if reg.config.Server.WebSDRTCPPort > 0 {
		return reg.config.Server.WebSDRTCPPort
	}
	return 8901
}

// processID returns the current process ID as an int.
func processID() int {
	return os.Getpid()
}

// sanitiseLogString converts raw bytes to a printable string safe for logging.
// Non-printable characters (< 0x20, except tab) and DEL (0x7f) are replaced
// with '?'. The result is trimmed of leading/trailing whitespace and capped at
// maxLen runes.
func sanitiseLogString(b []byte, maxLen int) string {
	var sb strings.Builder
	for _, c := range b {
		if c == 0 {
			break // stop at first NUL (end of unread buffer)
		}
		if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') || c == 0x7f {
			sb.WriteByte('?')
		} else {
			sb.WriteByte(c)
		}
	}
	s := strings.TrimSpace(sb.String())
	// Collapse embedded newlines to spaces for single-line log output
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	runes := []rune(s)
	if len(runes) > maxLen {
		runes = runes[:maxLen]
	}
	return string(runes)
}

// ─────────────────────────────────────────────────────────────────────────────
// websdr.org IP detection
// ─────────────────────────────────────────────────────────────────────────────

var (
	websdrOrgIPs     []string
	websdrOrgIPsOnce sync.Once
)

// resolveWebSDROrgIPs resolves websdr.ewi.utwente.nl to its IP addresses.
func resolveWebSDROrgIPs() {
	ips, err := net.LookupHost(websdrOrgHost)
	if err != nil {
		log.Printf("WebSDR: failed to resolve %s: %v", websdrOrgHost, err)
		return
	}
	websdrOrgIPs = ips
	log.Printf("WebSDR: resolved %s → %v", websdrOrgHost, ips)
}

// isWebSDROrgIP returns true if the given IP address belongs to websdr.org.
func isWebSDROrgIP(ip string) bool {
	websdrOrgIPsOnce.Do(resolveWebSDROrgIPs)
	for _, orgIP := range websdrOrgIPs {
		if ip == orgIP {
			return true
		}
	}
	return false
}
