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
// websdr.org then connects back to <HOST>:<PORT> with GET /~~orgstatus,
// which is handled by the WebSDR HTTP server's handleOrgStatus().

import (
	"fmt"
	"log"
	"net"
	"os"
	"strings"
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
	config *Config
	stop   chan struct{}
}

// NewWebSDRRegistrar creates a registrar. Call Start() to begin registration.
func NewWebSDRRegistrar(config *Config) *WebSDRRegistrar {
	return &WebSDRRegistrar{
		config: config,
		stop:   make(chan struct{}),
	}
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
	// /~~orgstatus callback that websdr.org makes immediately after
	// receiving the registration.
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

	var conn net.Conn
	attempt := 0
	buf := make([]byte, 1024)

	for {
		select {
		case <-reg.stop:
			if conn != nil {
				conn.Close()
			}
			return
		default:
		}

		// Connect / reconnect if needed.
		if conn == nil {
			dialer := &net.Dialer{Timeout: websdrOrgTimeout}
			var err error
			conn, err = dialer.Dial("tcp", addr)
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
		}

		// Send registration ping.
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err := fmt.Fprint(conn, reqLine)
		if err != nil {
			log.Printf("WebSDR: websdr.org registration write error: %v — reconnecting", err)
			conn.Close()
			conn = nil
			select {
			case <-reg.stop:
				return
			case <-time.After(websdrOrgReconnDelay):
			}
			continue
		}
		attempt++

		// Read response immediately (5 s timeout) — mirrors Python bridge.
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, err := conn.Read(buf)
		if err != nil {
			if n > 0 {
				respSnippet := sanitiseLogString(buf[:n], 120)
				log.Printf("WebSDR: #%d ping sent (partial response: %q, err: %v)", attempt, respSnippet, err)
			} else {
				// Timeout with no response is normal — websdr.org may not
				// reply immediately.  Log it but don't reconnect.
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					log.Printf("WebSDR: #%d ping sent (no immediate response — normal)", attempt)
				} else {
					// Real error (connection reset, etc.) — reconnect.
					log.Printf("WebSDR: #%d read error: %v — reconnecting", attempt, err)
					conn.Close()
					conn = nil
					select {
					case <-reg.stop:
						return
					case <-time.After(websdrOrgReconnDelay):
					}
					continue
				}
			}
		} else if n > 0 {
			respSnippet := sanitiseLogString(buf[:n], 120)
			log.Printf("WebSDR: #%d registered with websdr.org (host=%s, port=%d) response: %q",
				attempt, hostname, listenPort, respSnippet)
		}

		// Wait 60 s before next ping (keep connection open).
		select {
		case <-reg.stop:
			if conn != nil {
				conn.Close()
			}
			return
		case <-time.After(websdrOrgRegInterval):
		}
	}
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
